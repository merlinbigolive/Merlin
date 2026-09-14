# Merlin Agency — Complete Verified ₹100 Razorpay Payment

## Final flow
Apply Now page → Placement Interview Terms → Razorpay Standard Checkout (₹100) → server-side signature verification + captured-status check → Host Details → Submit → Live Chat + WhatsApp.

The browser never unlocks access merely because the UPI app opened, the checkout was closed, the page was refreshed, or a client-side value was changed.

## 1. Firebase setup

This project is configured for Firebase project:
`merlin-live-chat`

From this folder:

```bash
firebase login
firebase use merlin-live-chat
cd functions
npm install
cd ..
```

## 2. Secrets — never put these in HTML/GitHub

Create `RAZORPAY_CONFIG` with your **Live** credentials:

```json
{
  "keyId": "rzp_live_xxxxxxxxxx",
  "keySecret": "YOUR_RAZORPAY_KEY_SECRET",
  "webhookSecret": "YOUR_RAZORPAY_WEBHOOK_SECRET"
}
```

Then:

```bash
firebase functions:secrets:set RAZORPAY_CONFIG
firebase functions:secrets:set MERLIN_ACCESS_TOKEN_SECRET
```

`MERLIN_ACCESS_TOKEN_SECRET` should be a long random secret.

## 3. Deploy backend

```bash
firebase deploy --only functions,database
```

The frontend already calls:

`https://asia-south1-merlin-live-chat.cloudfunctions.net`

## 4. Razorpay webhook

In Razorpay Dashboard → Account & Settings → Webhooks, add:

`https://asia-south1-merlin-live-chat.cloudfunctions.net/razorpayWebhook`

Subscribe to:
- `payment.captured`
- `order.paid`

Use the same webhook secret stored inside `RAZORPAY_CONFIG`.

## 5. Capture

Enable automatic capture in Razorpay Dashboard. The backend also requires the payment to be `captured` before issuing access.

## 6. Frontend

Upload `apply.html` as the website's `apply.html`.

## 7. Security behavior

- Amount is fixed server-side at ₹100 (10000 paise).
- Razorpay order is created server-side.
- Razorpay signature is verified server-side with HMAC-SHA256.
- Payment is checked against the same order, amount and currency.
- Payment must be `captured`.
- Access is issued through a short-lived server-signed token.
- `/verifyAccess` validates the token and paid order before Live Chat access.
- WhatsApp is blocked until verified payment + application submission.
- Webhook signatures are verified using the raw request body.
