const express = require('express');
const pay = require('../lib/stripe');

const router = express.Router();

// Mounted before the JSON body parser: Stripe signs the raw bytes.
router.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!pay.enabled() || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = pay.constructEvent(req.body, req.get('stripe-signature'));
  } catch (e) {
    return res.status(400).send(`Webhook signature check failed: ${e.message}`);
  }
  try {
    await pay.handleEvent(event);
  } catch (e) {
    console.error('[stripe] handling', event.type, 'failed:', e.message);
    return res.status(500).end(); // Stripe retries
  }
  res.json({ received: true });
});

module.exports = router;
