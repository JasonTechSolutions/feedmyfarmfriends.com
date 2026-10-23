// Stripe: one membership subscription plus prepaid treat bundles. Bundles
// keep the price at $1 a treat without paying a card fee on every $1.
const Stripe = require('stripe');
const db = require('./db');

let client = null;
const stripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
};
const enabled = () => !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_MEMBERSHIP;

const BUNDLES = [
  { id: 'b5', treats: 5, cents: 500 },
  { id: 'b10', treats: 11, cents: 1000 },
  { id: 'b20', treats: 24, cents: 2000 }
];

async function customerFor(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const c = await stripe().customers.create({ email: user.email, metadata: { user_id: String(user.id) } });
  await db.q('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [c.id, user.id]);
  return c.id;
}

async function membershipCheckout(user, baseUrl) {
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: await customerFor(user),
    client_reference_id: String(user.id),
    line_items: [{ price: process.env.STRIPE_PRICE_MEMBERSHIP, quantity: 1 }],
    success_url: `${baseUrl}/account?welcome=1`,
    cancel_url: `${baseUrl}/account`
  });
  return session.url;
}

async function bundleCheckout(user, bundleId, baseUrl) {
  const b = BUNDLES.find(x => x.id === bundleId);
  if (!b) return null;
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer: await customerFor(user),
    client_reference_id: String(user.id),
    line_items: [{
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: b.cents, product_data: { name: `${b.treats} animal treats` } }
    }],
    metadata: { user_id: String(user.id), treats: String(b.treats) },
    success_url: `${baseUrl}/account?treats=${b.treats}`,
    cancel_url: `${baseUrl}/account`
  });
  return session.url;
}

async function portalUrl(user, baseUrl) {
  const s = await stripe().billingPortal.sessions.create({ customer: await customerFor(user), return_url: `${baseUrl}/account` });
  return s.url;
}

// Adds credits once per ref; a repeated webhook is a no-op.
async function addCredits(userId, treats, reason, ref) {
  return db.tx(async conn => {
    const [r] = await conn.execute(
      'INSERT IGNORE INTO credit_ledger (user_id, delta, reason, ref) VALUES (?, ?, ?, ?)', [userId, treats, reason, ref]);
    if (!r.affectedRows) return false;
    await conn.execute('UPDATE users SET treat_credits = treat_credits + ? WHERE id = ?', [treats, userId]);
    return true;
  });
}

// Always re-reads the subscription from Stripe, so events arriving out of
// order still leave the latest state.
async function syncSubscription(subId) {
  const sub = await stripe().subscriptions.retrieve(subId);
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  await db.q('UPDATE users SET sub_id = ?, sub_status = ?, sub_period_end = ? WHERE stripe_customer_id = ?',
    [sub.id, sub.status, end ? new Date(end * 1000) : null, sub.customer]);
}

async function handleEvent(event) {
  const o = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const userId = Number(o.client_reference_id || o.metadata?.user_id);
      if (o.mode === 'payment' && o.payment_status === 'paid' && userId) {
        const treats = Number(o.metadata?.treats);
        if (treats > 0) await addCredits(userId, treats, 'purchase', `stripe:${o.id}`);
      }
      if (o.mode === 'subscription' && o.subscription) {
        if (userId && o.customer) {
          await db.q('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL', [o.customer, userId]);
        }
        await syncSubscription(o.subscription);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(o.id);
      break;
  }
  await db.q('INSERT IGNORE INTO stripe_events (id, type) VALUES (?, ?)', [event.id, event.type]);
}

function constructEvent(rawBody, signature) {
  return stripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  enabled, BUNDLES, membershipCheckout, bundleCheckout, portalUrl, addCredits, handleEvent, constructEvent
};
