const test = require('node:test');
const assert = require('node:assert');
const { evaluate, CAP_MESSAGE } = require('../lib/feeding');

// 2026-10-23 15:00 UTC = 10:00am in Minnesota
const now = new Date('2026-10-23T15:00:00Z');
const base = () => ({
  station: { daily_cap: 20, cooldown_seconds: 180, opens_at: '08:00:00', closes_at: '18:00:00',
    is_paused: 0, device_last_seen: new Date(now.getTime() - 5000), device_fault: null },
  settings: { all_paused: 0, member_daily_limit: 5 },
  user: { isSubscribed: true, treat_credits: 3 },
  stationToday: 4, memberToday: 0, lastFeedAt: new Date(now.getTime() - 10 * 60 * 1000), now
});

test('allows a normal feed', () => assert.deepStrictEqual(evaluate(base()), { ok: true }));

test('daily cap shows come back tomorrow, even when paused or closed', () => {
  const a = base(); a.stationToday = 20; a.settings.all_paused = 1; a.now = new Date('2026-10-24T02:00:00Z');
  const r = evaluate(a);
  assert.strictEqual(r.code, 'cap');
  assert.strictEqual(r.message, CAP_MESSAGE);
});

test('farm-wide and station pause', () => {
  const a = base(); a.settings.all_paused = 1; a.settings.pause_note = 'Vet day';
  assert.deepStrictEqual([evaluate(a).code, evaluate(a).message], ['paused', 'Vet day']);
  const b = base(); b.station.is_paused = 1;
  assert.strictEqual(evaluate(b).code, 'paused');
});

test('feeding hours use farm time', () => {
  const a = base(); a.now = new Date('2026-10-23T12:30:00Z'); // 7:30am CDT
  a.station.device_last_seen = a.now;
  assert.match(evaluate(a).message, /opens at 8am/);
  const b = base(); b.now = new Date('2026-10-23T23:00:00Z'); // 6pm CDT
  b.station.device_last_seen = b.now;
  assert.strictEqual(evaluate(b).code, 'closed');
});

test('offline or faulted dispenser blocks feeding', () => {
  const a = base(); a.station.device_last_seen = new Date(now.getTime() - 5 * 60 * 1000);
  assert.strictEqual(evaluate(a).code, 'offline');
  const b = base(); b.station.device_fault = 'hopper low';
  assert.strictEqual(evaluate(b).code, 'offline');
});

test('cooldown reports seconds left', () => {
  const a = base(); a.lastFeedAt = new Date(now.getTime() - 60 * 1000);
  const r = evaluate(a);
  assert.strictEqual(r.code, 'cooldown');
  assert.strictEqual(r.retryAfter, 120);
});

test('member daily limit, subscription and credits', () => {
  const a = base(); a.memberToday = 5;
  assert.strictEqual(evaluate(a).code, 'member_limit');
  const b = base(); b.user.isSubscribed = false;
  assert.strictEqual(evaluate(b).code, 'no_sub');
  const c = base(); c.user.treat_credits = 0;
  assert.strictEqual(evaluate(c).code, 'no_credits');
});
