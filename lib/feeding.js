// The one place that decides whether a treat drops. Every rule is checked
// on the server inside a transaction that locks the station row, so two
// people tapping at once can never push a station past its cap.
const db = require('./db');
const time = require('./time');

const DEVICE_STALE_SECONDS = Number(process.env.DEVICE_STALE_SECONDS || 90);
const FEED_TIMEOUT_SECONDS = Number(process.env.FEED_TIMEOUT_SECONDS || 60);
// A command older than this is left for the sweep to refund rather than
// handed to the dispenser, so a late drop can never go uncounted.
const CLAIM_WINDOW_SECONDS = Math.max(FEED_TIMEOUT_SECONDS - 15, 10);
const simulate = () => process.env.SIMULATE_DISPENSERS === 'true';

const CAP_MESSAGE = 'They’ve had plenty of treats today. Come back tomorrow!';

// Pure rule check, shared by the feed request and the status poll.
// Returns { ok: true } or { ok: false, code, message, retryAfter? }.
function evaluate({ station, settings, user, stationToday, memberToday, lastFeedAt, now = new Date() }) {
  const no = (code, message, extra) => ({ ok: false, code, message, ...extra });
  const opens = time.timeToMinutes(station.opens_at), closes = time.timeToMinutes(station.closes_at);
  const nowMin = time.farmMinutes(now);

  if (stationToday >= station.daily_cap) return no('cap', CAP_MESSAGE);
  if (settings.all_paused) return no('paused', settings.pause_note || 'Feeding is paused across the farm right now. Check back soon.');
  if (station.is_paused) return no('paused', station.pause_note || 'Feeding is paused here right now. Check back soon.');
  if (nowMin < opens) return no('closed', `Feeding opens at ${time.formatClock(station.opens_at)} farm time.`);
  if (nowMin >= closes) return no('closed', `Feeding is done for today. It opens again at ${time.formatClock(station.opens_at)} tomorrow.`);
  if (!simulate()) {
    const seen = station.device_last_seen ? new Date(station.device_last_seen).getTime() : 0;
    if (now.getTime() - seen > DEVICE_STALE_SECONDS * 1000) return no('offline', 'The treat dispenser here is offline right now.');
    if (station.device_fault) return no('offline', 'The treat dispenser needs a refill or a check. We’re on it.');
  }
  if (lastFeedAt && station.cooldown_seconds > 0) {
    const wait = Math.ceil((new Date(lastFeedAt).getTime() + station.cooldown_seconds * 1000 - now.getTime()) / 1000);
    if (wait > 0) return no('cooldown', 'Someone just gave them a treat. Give them a moment to enjoy it.', { retryAfter: wait });
  }
  if (user) {
    if (memberToday >= settings.member_daily_limit) {
      return no('member_limit', `You’ve given ${settings.member_daily_limit} treats today, the most per member. Thank you! Come back tomorrow.`);
    }
    if (!user.isSubscribed) return no('no_sub', 'Join to feed the animals.');
    if (user.treat_credits < 1) return no('no_credits', 'You’re out of treats. Grab a bundle to keep feeding.');
  }
  return { ok: true };
}

async function countsFor(conn, stationId, userId, now) {
  const dayStart = time.farmDayStart(now);
  const [[s]] = await conn.execute(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM feedings
     WHERE station_id = ? AND status <> 'failed' AND created_at >= ?`, [stationId, dayStart]);
  let memberToday = 0;
  if (userId) {
    const [[m]] = await conn.execute(
      `SELECT COUNT(*) AS n FROM feedings WHERE user_id = ? AND status <> 'failed' AND created_at >= ?`, [userId, dayStart]);
    memberToday = Number(m.n);
  }
  // Cooldown looks across midnight too, so take the true last feeding.
  const [[last]] = await conn.execute(
    `SELECT MAX(created_at) AS last FROM feedings WHERE station_id = ? AND status <> 'failed'`, [stationId]);
  return { stationToday: Number(s.n), memberToday, lastFeedAt: last.last };
}

const getSettings = async conn => (await conn.execute('SELECT * FROM farm_settings WHERE id = 1'))[0][0];

// What the station page shows: progress bar + whether the button is live.
async function status(station, user, now = new Date()) {
  const conn = db.getPool();
  const settings = await getSettings(conn);
  const counts = await countsFor(conn, station.id, user?.id, now);
  const verdict = evaluate({ station, settings, user, ...counts, now });
  return {
    station: station.slug,
    given: counts.stationToday,
    cap: station.daily_cap,
    credits: user ? user.treat_credits : null,
    memberToday: counts.memberToday,
    memberLimit: settings.member_daily_limit,
    resetsAt: time.nextFarmDayStart(now).toISOString(),
    ...verdict
  };
}

async function requestFeed(userId, slug, at) {
  const result = await db.tx(async conn => {
    const [[station]] = await conn.execute('SELECT * FROM stations WHERE slug = ? FOR UPDATE', [slug]);
    if (!station) return { ok: false, code: 'not_found', message: 'That station doesn’t exist.' };
    // Read the clock only once the lock is held, so a request that waited
    // behind another never looks older than the treat it waited on.
    const now = at || new Date();
    const [[user]] = await conn.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    user.isSubscribed = require('./auth').isSubscribed(user);
    const settings = await getSettings(conn);
    const counts = await countsFor(conn, station.id, userId, now);
    const verdict = evaluate({ station, settings, user, ...counts, now });
    if (!verdict.ok) return verdict;

    const [ins] = await conn.execute(
      `INSERT INTO feedings (station_id, user_id, status, created_at) VALUES (?, ?, 'pending', ?)`,
      [station.id, userId, now]);
    await conn.execute('UPDATE users SET treat_credits = treat_credits - 1 WHERE id = ?', [userId]);
    await conn.execute(`INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES (?, -1, 'feed', ?)`,
      [userId, `feed:${ins.insertId}`]);
    return { ok: true, feedingId: ins.insertId, credits: user.treat_credits - 1 };
  });
  if (result.ok && simulate()) {
    setTimeout(() => simulateDrop(result.feedingId).catch(e => console.error('[sim]', e.message)), 1500);
  }
  return result;
}

async function simulateDrop(id) {
  await db.q(`UPDATE feedings SET status = 'done', sent_at = NOW(3), finished_at = NOW(3) WHERE id = ? AND status = 'pending'`, [id]);
}

// Marks a treat failed and gives the member their credit back, once.
async function failFeeding(id, error) {
  return db.tx(async conn => {
    const [r] = await conn.execute(
      `UPDATE feedings SET status = 'failed', finished_at = NOW(3), error = ? WHERE id = ? AND status IN ('pending', 'sent')`,
      [String(error || 'failed').slice(0, 200), id]);
    if (!r.affectedRows) return false;
    const [[f]] = await conn.execute('SELECT user_id FROM feedings WHERE id = ?', [id]);
    await conn.execute(`INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES (?, 1, 'refund', ?)`, [f.user_id, `refund:${id}`]);
    await conn.execute('UPDATE users SET treat_credits = treat_credits + 1 WHERE id = ?', [f.user_id]);
    return true;
  });
}

// Treats the dispenser never confirmed are refunded.
async function sweepStale() {
  const rows = await db.q(
    `SELECT id FROM feedings WHERE status IN ('pending', 'sent') AND created_at < (NOW(3) - INTERVAL ? SECOND)`,
    [FEED_TIMEOUT_SECONDS]);
  for (const r of rows) await failFeeding(r.id, 'dispenser did not confirm');
  return rows.length;
}

// ---- Dispenser side ---------------------------------------------------
async function claimNext(stationId) {
  return db.tx(async conn => {
    const [[f]] = await conn.execute(
      `SELECT id FROM feedings WHERE station_id = ? AND status = 'pending'
         AND created_at > (NOW(3) - INTERVAL ? SECOND) ORDER BY id LIMIT 1 FOR UPDATE`,
      [stationId, CLAIM_WINDOW_SECONDS]);
    if (!f) return null;
    await conn.execute(`UPDATE feedings SET status = 'sent', sent_at = NOW(3) WHERE id = ?`, [f.id]);
    return f.id;
  });
}

async function complete(stationId, id, ok, error) {
  if (!ok) {
    const f = await db.one('SELECT id FROM feedings WHERE id = ? AND station_id = ?', [id, stationId]);
    return f ? failFeeding(id, error || 'dispenser reported a fault') : false;
  }
  const r = await db.q(
    `UPDATE feedings SET status = 'done', finished_at = NOW(3) WHERE id = ? AND station_id = ? AND status = 'sent'`,
    [id, stationId]);
  return r.affectedRows > 0;
}

module.exports = {
  CAP_MESSAGE, evaluate, status, requestFeed, failFeeding, sweepStale, claimNext, complete
};
