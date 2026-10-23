// End-to-end against a real MySQL/MariaDB. Skipped unless TEST_MYSQL_URL is
// set, e.g. TEST_MYSQL_URL=mysql://user:pw@127.0.0.1:3306/fmff_test npm test
// The database is wiped first, so never point it at production.
const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_MYSQL_URL;
const opts = { skip: !url && 'TEST_MYSQL_URL not set', concurrency: false };

test('member flow', opts, async t => {
  process.env.MYSQL_URL = url;
  process.env.PORT = '0';
  process.env.ADMIN_EMAIL = 'admin@farm.test';
  process.env.ADMIN_PASSWORD = 'admin-password-1';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_MEMBERSHIP = 'price_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
  const mysql = require('mysql2/promise');
  const wipe = await mysql.createConnection(url);
  await wipe.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const tbl of ['feedings', 'credit_ledger', 'stripe_events', 'stations', 'farm_settings', 'users', 'sessions']) {
    await wipe.query(`DROP TABLE IF EXISTS ${tbl}`);
  }
  await wipe.end();

  const db = require('../lib/db');
  const feeding = require('../lib/feeding');
  const pay = require('../lib/stripe');
  const { start } = require('../server');
  const server = await start();
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.close(); });

  // Tiny cookie-keeping client that sends a same-origin header like a browser.
  const client = () => {
    let cookie = '';
    return async (path, { method = 'GET', form, json } = {}) => {
      const headers = { origin: base, cookie };
      let body;
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return r;
    };
  };

  const amy = client();
  let r = await amy('/register', { method: 'POST', form: { name: 'Amy', email: 'amy@example.com', password: 'treats-for-all', age_ok: 'yes' } });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/account?join=1');

  r = await amy('/cams');
  assert.strictEqual(r.headers.get('location'), '/account?join=1', 'non-members are sent to join');

  // Stand in for the Stripe webhook: membership active, 5 treats bought.
  const amyId = (await db.one('SELECT id FROM users WHERE email = ?', ['amy@example.com'])).id;
  await db.q(`UPDATE users SET sub_status = 'active' WHERE id = ?`, [amyId]);
  assert.strictEqual(await pay.addCredits(amyId, 5, 'purchase', 'stripe:cs_test_1'), true);
  assert.strictEqual(await pay.addCredits(amyId, 5, 'purchase', 'stripe:cs_test_1'), false, 'webhook retry adds nothing');

  // A signed bundle-purchase webhook adds treats; a forged one is rejected.
  const Stripe = require('stripe');
  const payload = JSON.stringify({ id: 'evt_test_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_test_2', mode: 'payment', payment_status: 'paid', client_reference_id: String(amyId), metadata: { treats: '11' } } } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_dummy' });
  const hook = s => fetch(base + '/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': s }, body: payload });
  assert.strictEqual((await hook('t=1,v1=bad')).status, 400);
  assert.strictEqual((await hook(sig)).status, 200);
  assert.strictEqual((await hook(sig)).status, 200);
  assert.strictEqual((await db.one('SELECT treat_credits FROM users WHERE id = ?', [amyId])).treat_credits, 16);
  await db.q('UPDATE users SET treat_credits = 5 WHERE id = ?', [amyId]);

  r = await amy('/cams');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Paddock 8/);

  // No dispenser connected yet: feeding is blocked as offline.
  r = await amy('/api/stations/paddock-1/feed', { method: 'POST', json: {} });
  assert.strictEqual((await r.json()).code, 'offline');

  // Admin connects a dispenser, sets a cap of 2, no cooldown, all-day hours.
  const admin = client();
  await admin('/login', { method: 'POST', form: { email: 'admin@farm.test', password: 'admin-password-1' } });
  const st = await db.one(`SELECT id FROM stations WHERE slug = 'paddock-1'`);
  r = await admin(`/admin/stations/${st.id}`, { method: 'POST', form: {
    name: 'Paddock 1', blurb: 'Test', daily_cap: '2', cooldown_seconds: '0', opens_at: '00:00', closes_at: '23:59', stream_uid: '' } });
  assert.strictEqual(r.status, 302);
  await admin(`/admin/stations/${st.id}/device-token`, { method: 'POST', form: {} });
  const page = await (await admin('/admin/stations')).text();
  const token = /<code class="token">([a-f0-9]{64})<\/code>/.exec(page)[1];
  const device = (path, opt = {}) => fetch(base + path, {
    method: opt.method || 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: opt.json && JSON.stringify(opt.json) });
  assert.strictEqual((await device('/api/device/heartbeat', { method: 'POST', json: {} })).status, 200);

  // Three people tap at once on a cap of 2: exactly two treats are accepted.
  const results = await Promise.all([1, 2, 3].map(() => amy('/api/stations/paddock-1/feed', { method: 'POST', json: {} }).then(x => x.json())));
  const accepted = results.filter(x => x.ok);
  assert.strictEqual(accepted.length, 2);
  assert.strictEqual(results.find(x => !x.ok).code, 'cap');
  assert.strictEqual((await db.one('SELECT treat_credits FROM users WHERE id = ?', [amyId])).treat_credits, 3);

  // Dispenser drops the first, jams on the second: the second is refunded.
  let next = await (await device('/api/device/next')).json();
  await device(`/api/device/feedings/${next.feeding}`, { method: 'POST', json: { ok: true } });
  next = await (await device('/api/device/next')).json();
  await device(`/api/device/feedings/${next.feeding}`, { method: 'POST', json: { ok: false, error: 'jam' } });
  assert.strictEqual((await (await device('/api/device/next')).json()).feeding, null);
  assert.strictEqual((await db.one('SELECT treat_credits FROM users WHERE id = ?', [amyId])).treat_credits, 4);

  // The refunded treat doesn't count against the cap, so one more fits.
  r = await amy('/api/stations/paddock-1/status');
  const s = await r.json();
  assert.deepStrictEqual([s.given, s.cap, s.ok], [1, 2, true]);
  r = await amy('/api/stations/paddock-1/feed', { method: 'POST', json: {} });
  assert.strictEqual((await r.json()).ok, true);
  r = await amy('/api/stations/paddock-1/status');
  const full = await r.json();
  assert.strictEqual(full.code, 'cap');
  assert.match(full.message, /Come back tomorrow/);

  // A treat the dispenser never confirms is refunded by the sweep.
  await db.q(`UPDATE feedings SET created_at = NOW(3) - INTERVAL 5 MINUTE WHERE status = 'pending'`);
  assert.strictEqual(await feeding.sweepStale(), 1);
  assert.strictEqual(await feeding.sweepStale(), 0, 'never refunds twice');
  assert.strictEqual((await db.one('SELECT treat_credits FROM users WHERE id = ?', [amyId])).treat_credits, 4);

  // Kill switch.
  await admin('/admin/pause-all', { method: 'POST', form: { pause: '1', note: 'Vet visit today' } });
  r = await amy('/api/stations/paddock-1/feed', { method: 'POST', json: {} });
  const paused = await r.json();
  assert.deepStrictEqual([paused.code, paused.message], ['paused', 'Vet visit today']);

  // Cross-site posts are refused.
  r = await fetch(base + '/api/stations/paddock-1/feed', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.strictEqual(r.status, 403);

  // Station page renders with the treat meter.
  await admin('/admin/pause-all', { method: 'POST', form: { pause: '0' } });
  const html = await (await amy('/cams/chicken-coop')).text();
  assert.match(html, /Feed for \$1/);
  assert.match(html, /This camera is being set up/);
  assert.strictEqual((await amy('/account')).status, 200);
  assert.strictEqual((await amy('/admin/stations')).status, 403);
});
