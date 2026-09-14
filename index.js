
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const crypto = require("crypto");

initializeApp();

setGlobalOptions({
  region: "asia-south1",
  maxInstances: 10
});

const RAZORPAY_CONFIG = defineSecret("RAZORPAY_CONFIG");
const ACCESS_TOKEN_SECRET = defineSecret("MERLIN_ACCESS_TOKEN_SECRET");

const AMOUNT = 10000; // ₹100 in paise
const CURRENCY = "INR";

const ALLOWED_ORIGINS = new Set([
  "https://begrow.in",
  "https://www.begrow.in"
]);

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.status(status).json(body);
}

function config() {
  const value = JSON.parse(RAZORPAY_CONFIG.value());
  if (!value.keyId || !value.keySecret) {
    throw new Error("Razorpay configuration is incomplete.");
  }
  return value;
}

function razorpayAuth(keyId, keySecret) {
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

async function razorpay(path, options = {}) {
  const cfg = config();
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...options,
    headers: {
      "Authorization": razorpayAuth(cfg.keyId, cfg.keySecret),
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.description || "Razorpay API request failed.";
    throw new Error(message);
  }
  return data;
}

function signAccess(orderId, expiresAt) {
  const payload = `${orderId}.${expiresAt}`;
  const sig = crypto
    .createHmac("sha256", ACCESS_TOKEN_SECRET.value())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function verifyAccessToken(orderId, token) {
  if (!orderId || !token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [tokenOrderId, expiresAtText, sig] = parts;
  if (tokenOrderId !== orderId) return false;

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) return false;

  const expected = crypto
    .createHmac("sha256", ACCESS_TOKEN_SECRET.value())
    .update(`${tokenOrderId}.${expiresAt}`)
    .digest("base64url");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function markWebhookEvent(eventId) {
  if (!eventId) return false;
  const ref = getDatabase().ref(`razorpayWebhookEvents/${eventId}`);
  const snap = await ref.get();
  if (snap.exists()) return false;
  await ref.set({ receivedAt: Date.now() });
  return true;
}

async function markPaid(orderId, paymentId) {
  const db = getDatabase();
  const ref = db.ref(`paymentOrders/${orderId}`);
  const snap = await ref.get();
  if (!snap.exists()) return null;

  const order = snap.val();
  if (order.amount !== AMOUNT || order.currency !== CURRENCY) return null;

  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const accessToken = signAccess(orderId, expiresAt);

  await ref.update({
    status: "paid",
    paymentId: paymentId || order.paymentId || null,
    verifiedAt: Date.now(),
    accessExpiresAt: expiresAt
  });

  return { orderId, accessToken };
}

exports.createPaymentOrder = onRequest(
  { secrets: [RAZORPAY_CONFIG] },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return json(res, 405, {error:"Method not allowed"});

    try {
      const order = await razorpay("/orders", {
        method: "POST",
        body: JSON.stringify({
          amount: AMOUNT,
          currency: CURRENCY,
          receipt: `merlin_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
          notes: { product: "Placement Interview Fee", agency: "Merlin Agency" },
          payment_capture: 1
        })
      });

      await getDatabase().ref(`paymentOrders/${order.id}`).set({
        orderId: order.id,
        amount: AMOUNT,
        currency: CURRENCY,
        status: "created",
        createdAt: Date.now()
      });

      const cfg = config();
      return json(res, 200, {
        orderId: order.id,
        amount: AMOUNT,
        currency: CURRENCY,
        keyId: cfg.keyId
      });
    } catch (error) {
      console.error("createPaymentOrder", error);
      return json(res, 500, {error:"Unable to create secure payment."});
    }
  }
);

exports.verifyPayment = onRequest(
  { secrets: [RAZORPAY_CONFIG, ACCESS_TOKEN_SECRET] },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return json(res, 405, {error:"Method not allowed"});

    try {
      const { orderId, paymentId, signature } = req.body || {};
      if (!orderId || !paymentId || !signature) {
        return json(res, 400, {error:"Missing payment verification fields."});
      }

      const snap = await getDatabase().ref(`paymentOrders/${orderId}`).get();
      if (!snap.exists()) return json(res, 400, {error:"Unknown payment order."});
      const order = snap.val();

      const expected = crypto
        .createHmac("sha256", config().keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(String(signature), "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return json(res, 400, {error:"Payment signature verification failed."});
      }

      const payment = await razorpay(`/payments/${encodeURIComponent(paymentId)}`);
      if (
        payment.order_id !== orderId ||
        payment.amount !== AMOUNT ||
        payment.currency !== CURRENCY ||
        payment.status !== "captured"
      ) {
        return json(res, 402, {error:"Payment is not captured or does not match this order."});
      }

      const access = await markPaid(orderId, paymentId);
      if (!access) return json(res, 400, {error:"Payment order validation failed."});

      return json(res, 200, {
        paid: true,
        orderId: access.orderId,
        accessToken: access.accessToken
      });
    } catch (error) {
      console.error("verifyPayment", error);
      return json(res, 500, {error:"Payment could not be verified."});
    }
  }
);

exports.checkPayment = onRequest(
  { secrets: [RAZORPAY_CONFIG, ACCESS_TOKEN_SECRET] },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return json(res, 405, {error:"Method not allowed"});

    try {
      const { orderId } = req.body || {};
      if (!orderId) return json(res, 400, {error:"Missing orderId."});

      const ref = getDatabase().ref(`paymentOrders/${orderId}`);
      const snap = await ref.get();
      if (!snap.exists()) return json(res, 404, {error:"Payment order not found."});

      const order = snap.val();
      if (order.status === "paid") {
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        const accessToken = signAccess(orderId, expiresAt);
        await ref.update({accessExpiresAt: expiresAt});
        return json(res, 200, {paid:true, orderId, accessToken});
      }

      const remote = await razorpay(`/orders/${encodeURIComponent(orderId)}`);
      if (remote.status === "paid") {
        const payments = await razorpay(`/orders/${encodeURIComponent(orderId)}/payments`);
        const captured = (payments.items || []).find(
          p => p.status === "captured" &&
               p.amount === AMOUNT &&
               p.currency === CURRENCY
        );
        if (captured) {
          const access = await markPaid(orderId, captured.id);
          return json(res, 200, {paid:true, orderId, accessToken:access.accessToken});
        }
      }

      return json(res, 200, {paid:false, orderId});
    } catch (error) {
      console.error("checkPayment", error);
      return json(res, 500, {error:"Unable to check payment status."});
    }
  }
);

exports.verifyAccess = onRequest(
  { secrets: [ACCESS_TOKEN_SECRET] },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return json(res, 405, {error:"Method not allowed"});

    try {
      const { orderId, accessToken } = req.body || {};
      const valid = verifyAccessToken(orderId, accessToken);
      if (!valid) return json(res, 403, {valid:false});

      const snap = await getDatabase().ref(`paymentOrders/${orderId}`).get();
      const paid = snap.exists() && snap.val().status === "paid";
      return json(res, 200, {valid: paid});
    } catch (error) {
      console.error("verifyAccess", error);
      return json(res, 403, {valid:false});
    }
  }
);

// Optional but recommended: configure this URL as a Razorpay webhook.
// Webhook secret should be stored inside RAZORPAY_CONFIG.webhookSecret.
exports.razorpayWebhook = onRequest(
  { secrets: [RAZORPAY_CONFIG] },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    try {
      const signature = req.headers["x-razorpay-signature"];
      const rawBody = req.rawBody;
      const cfg = config();

      if (!cfg.webhookSecret || !signature || !rawBody) {
        return res.status(400).send("Webhook configuration missing");
      }

      const expected = crypto
        .createHmac("sha256", cfg.webhookSecret)
        .update(rawBody)
        .digest("hex");

      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(String(signature), "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).send("Invalid webhook signature");
      }

      const event = JSON.parse(rawBody.toString("utf8"));

      if (event.event === "payment.captured") {
        const payment = event.payload?.payment?.entity;
        if (
          payment?.order_id &&
          payment.amount === AMOUNT &&
          payment.currency === CURRENCY
        ) {
          await markPaid(payment.order_id, payment.id);
        }
      }

      return res.status(200).send("ok");
    } catch (error) {
      console.error("razorpayWebhook", error);
      return res.status(500).send("Webhook error");
    }
  }
);


exports.verifyAccess = onRequest(
  { secrets: [ACCESS_TOKEN_SECRET] },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return json(res, 405, {error:"Method not allowed"});

    try {
      const { orderId, accessToken } = req.body || {};
      if (!orderId || !accessToken || !verifyAccessToken(orderId, accessToken)) {
        return json(res, 200, {valid:false});
      }

      const snap = await getDatabase().ref(`paymentOrders/${orderId}`).get();
      if (!snap.exists()) return json(res, 200, {valid:false});
      const order = snap.val();
      return json(res, 200, {
        valid: order.status === "paid" && order.amount === AMOUNT && order.currency === CURRENCY
      });
    } catch (error) {
      console.error("verifyAccess", error);
      return json(res, 200, {valid:false});
    }
  }
);

exports.razorpayWebhook = onRequest(
  { secrets: [RAZORPAY_CONFIG, ACCESS_TOKEN_SECRET] },
  async (req, res) => {
    cors(req, res);
    if (req.method !== "POST") return json(res, 405, {error:"Method not allowed"});

    try {
      const cfg = config();
      if (!cfg.webhookSecret) return json(res, 500, {error:"Webhook secret is not configured."});

      const signature = req.get("X-Razorpay-Signature");
      const eventId = req.get("x-razorpay-event-id");
      const rawBody = req.rawBody;

      if (!verifyWebhookSignature(rawBody, signature, cfg.webhookSecret)) {
        return json(res, 401, {error:"Invalid webhook signature."});
      }

      const body = JSON.parse(rawBody.toString("utf8"));
      const createdAt = Number(body.created_at || 0) * 1000;
      if (!createdAt || Math.abs(Date.now() - createdAt) > 5 * 60 * 1000) {
        return json(res, 400, {error:"Stale webhook event."});
      }

      const isNew = await markWebhookEvent(eventId);
      if (!isNew) return json(res, 200, {ok:true, duplicate:true});

      if (body.event === "payment.captured") {
        const payment = body?.payload?.payment?.entity;
        if (payment?.id && payment?.order_id && payment.amount === AMOUNT &&
            payment.currency === CURRENCY && payment.status === "captured") {
          await markPaid(payment.order_id, payment.id);
        }
      } else if (body.event === "order.paid") {
        const orderId = body?.payload?.order?.entity?.id;
        if (orderId) {
          const payments = await razorpay(`/orders/${encodeURIComponent(orderId)}/payments`);
          const captured = (payments.items || []).find(
            p => p.status === "captured" && p.amount === AMOUNT && p.currency === CURRENCY
          );
          if (captured) await markPaid(orderId, captured.id);
        }
      }

      return json(res, 200, {ok:true});
    } catch (error) {
      console.error("razorpayWebhook", error);
      return json(res, 500, {error:"Webhook processing failed."});
    }
  }
);


exports.paymentHealth = onRequest(
  { secrets: [RAZORPAY_CONFIG] },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET") return json(res, 405, {error:"Method not allowed"});
    try {
      const cfg = config();
      return json(res, 200, {ok:true, configured:Boolean(cfg.keyId && cfg.keySecret)});
    } catch (_) {
      return json(res, 503, {ok:false, configured:false});
    }
  }
);
