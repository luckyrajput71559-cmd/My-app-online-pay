const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Cashfree } = require('cashfree-pg');
const crypto = require('crypto');

// ---------- CONFIGURATION (use environment variables) ----------
const PORT = process.env.PORT || 3000;
const FIREBASE_SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'SANDBOX'; // 'PRODUCTION'
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET;

if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
  console.error('Missing Cashfree credentials');
  process.exit(1);
}

// ---------- FIREBASE INIT ----------
admin.initializeApp({
  credential: admin.credential.cert(FIREBASE_SERVICE_ACCOUNT),
});
const db = admin.firestore();

// ---------- CASHFREE INIT ----------
Cashfree.XClientId = CASHFREE_APP_ID;
Cashfree.XClientSecret = CASHFREE_SECRET_KEY;
Cashfree.XEnvironment = Cashfree.Environment[CASHFREE_ENV];

// ---------- EXPRESS ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- AUTH MIDDLEWARE ----------
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- HELPER: generate referral code ----------
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ---------- HELPER: verify Cashfree webhook signature ----------
function verifyCashfreeWebhook(payload, signature) {
  const expectedSignature = crypto
    .createHmac('sha256', CASHFREE_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('base64');
  return signature === expectedSignature;
}

// ================== API ENDPOINTS ==================

// POST /auth/signup
app.post('/auth/signup', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const { username, email, referralCode } = req.body;
    if (!username || !email) {
      return res.status(400).json({ error: 'username and email required' });
    }

    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (userDoc.exists) {
        throw new Error('User already exists');
      }
      const newReferralCode = referralCode || generateReferralCode();
      t.set(userRef, {
        uid,
        username,
        email,
        wallet: 0,
        totalXP: 0,
        joinedMatches: [],
        referralCode: newReferralCode,
        referredBy: referralCode || null,
        matchesPlayed: 0,
        totalKills: 0,
        dailyStreak: 0,
        isVIP: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /match/join
app.post('/match/join', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const { matchId, gameUids } = req.body;
    if (!matchId || !Array.isArray(gameUids) || gameUids.length === 0 || gameUids.length > 4) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const userRef = db.collection('users').doc(uid);
    const teamRef = matchRef.collection('teams').doc(uid);

    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error('Match not found');
      const match = matchDoc.data();
      if (match.status !== 'upcoming') throw new Error('Match not open for joining');
      if (match.joinedCount + gameUids.length > match.maxPlayers) {
        throw new Error('Not enough slots');
      }

      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data();
      const entryFee = match.entryFee || 0;
      if (user.wallet < entryFee) throw new Error('Insufficient wallet balance');

      const teamDoc = await t.get(teamRef);
      if (teamDoc.exists) throw new Error('Already joined this match');

      const teamsSnapshot = await t.get(matchRef.collection('teams'));
      const usedUids = new Set();
      teamsSnapshot.forEach(doc => {
        (doc.data().gameUids || []).forEach(u => usedUids.add(u));
      });
      for (const gid of gameUids) {
        if (usedUids.has(gid)) throw new Error(`GameUID ${gid} already taken`);
      }

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId),
      });

      t.set(teamRef, {
        ownerUid: uid,
        ownerUsername: user.username,
        gameUids,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(gameUids.length),
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: uid,
        type: 'ENTRY_FEE',
        amount: -entryFee,
        matchId,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /rewards/daily
app.post('/rewards/daily', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data();
      const lastClaim = user.lastDailyClaim ? user.lastDailyClaim.toDate() : null;
      const now = new Date();
      if (lastClaim) {
        const hoursSince = (now - lastClaim) / (1000 * 60 * 60);
        if (hoursSince < 24) throw new Error('Already claimed within 24 hours');
      }

      const dailyAmount = 50;
      const newStreak = (user.dailyStreak || 0) + 1;

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(dailyAmount),
        dailyStreak: newStreak,
        lastDailyClaim: admin.firestore.FieldValue.serverTimestamp(),
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: uid,
        type: 'DAILY_REWARD',
        amount: dailyAmount,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /wallet/withdraw
app.post('/wallet/withdraw', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount, upiId } = req.body;
    if (!amount || amount <= 0 || !upiId) {
      return res.status(400).json({ error: 'Invalid amount or UPI ID' });
    }

    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data();
      if (user.wallet < amount) throw new Error('Insufficient balance');

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-amount),
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: uid,
        type: 'WITHDRAW',
        amount: -amount,
        upiId,
        status: 'PENDING',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true, message: 'Withdrawal request submitted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /wallet/createOrder (Cashfree)
app.post('/wallet/createOrder', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const orderId = `order_${Date.now()}_${uid}`;
    
    const response = await Cashfree.PGCreateOrder({
      order_id: orderId,
      order_amount: amount,
      order_currency: "INR",
      customer_details: {
        customer_id: uid,
        customer_email: req.user.email,
        customer_phone: "9999999999", // should be collected from user profile
      },
      order_meta: {
        return_url: `https://your-app.com/payment-status?order_id=${orderId}`,
      },
    });

    const paymentSessionId = response.data.payment_session_id;

    // Store transaction as PENDING
    await db.collection('transactions').add({
      userId: uid,
      type: 'DEPOSIT',
      amount: amount,
      orderId: orderId,
      status: 'PENDING',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ payment_session_id: paymentSessionId });
  } catch (err) {
    console.error('Cashfree order creation failed:', err);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

// POST /webhook/cashfree
app.post('/webhook/cashfree', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    if (!signature || !verifyCashfreeWebhook(req.body, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body;
    const orderId = payload.order_id;
    const orderStatus = payload.order_status;
    const orderAmount = payload.order_amount;

    if (orderStatus !== 'PAID') {
      return res.status(200).send('OK');
    }

    // Find transaction by orderId
    const transactionsRef = db.collection('transactions');
    const snapshot = await transactionsRef
      .where('orderId', '==', orderId)
      .where('status', '==', 'PENDING')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(200).send('OK'); // already processed or invalid
    }

    const txDoc = snapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const amount = txData.amount;

    await db.runTransaction(async (t) => {
      // Update transaction status
      t.update(txDoc.ref, { status: 'SUCCESS' });

      // Credit wallet
      const userRef = db.collection('users').doc(userId);
      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(amount),
      });
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

// POST /admin/match/distribute (admin only – simplified check)
app.post('/admin/match/distribute', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.user;
    // In production, verify admin claim or check admin collection
    const adminDoc = await db.collection('admins').doc(uid).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { matchId, gameUid, rank, kills } = req.body;
    if (!matchId || !gameUid || rank === undefined || kills === undefined) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    
    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error('Match not found');
      const match = matchDoc.data();
      if (match.prizeDistributed) throw new Error('Prizes already distributed');

      // Find team containing gameUid
      const teamsSnapshot = await t.get(matchRef.collection('teams'));
      let ownerUid = null;
      teamsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.gameUids && data.gameUids.includes(gameUid)) {
          ownerUid = data.ownerUid;
        }
      });
      if (!ownerUid) throw new Error('GameUID not found in any team');

      // Calculate prize
      const perKillRate = match.perKillRate || 0;
      const rankPrizes = match.rankPrizes || {};
      const rankPrize = rankPrizes[rank] || 0;
      const prizeAmount = (kills * perKillRate) + rankPrize;
      const xpGained = kills * 10 + (rank === 1 ? 100 : rank === 2 ? 50 : 20);

      // Update user
      const userRef = db.collection('users').doc(ownerUid);
      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(prizeAmount),
        totalXP: admin.firestore.FieldValue.increment(xpGained),
        totalKills: admin.firestore.FieldValue.increment(kills),
        matchesPlayed: admin.firestore.FieldValue.increment(1),
      });

      // Mark prize distributed (idempotent)
      t.update(matchRef, { prizeDistributed: true });

      // Log transaction
      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: ownerUid,
        type: 'PRIZE',
        amount: prizeAmount,
        matchId,
        gameUid,
        rank,
        kills,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
