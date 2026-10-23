const crypto = require('crypto');
const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const time = require('../lib/time');

const router = express.Router();
router.use('/admin', auth.requireAdmin);

const int = (v, lo, hi) => Math.min(Math.max(parseInt(v, 10) || 0, lo), hi);
const clock = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? `${v}:00` : null;
const flash = (req, msg) => { req.session.flash = msg; };

router.get('/admin', (req, res) => res.redirect('/admin/stations'));

router.get('/admin/stations', async (req, res) => {
  const dayStart = time.farmDayStart();
  const stations = await db.q(
    `SELECT s.*,
       (SELECT COUNT(*) FROM feedings f WHERE f.station_id = s.id AND f.status <> 'failed' AND f.created_at >= ?) AS given,
       (SELECT COUNT(*) FROM feedings f WHERE f.station_id = s.id AND f.status = 'failed' AND f.created_at >= ?) AS failed
     FROM stations s ORDER BY s.sort, s.id`, [dayStart, dayStart]);
  const settings = await db.one('SELECT * FROM farm_settings WHERE id = 1');
  const newToken = req.session.newDeviceToken || null;
  delete req.session.newDeviceToken;
  res.render('admin-stations', { title: 'Stations', stations, settings, newToken, now: Date.now() });
});

// The kill switch: one tap pauses every station.
router.post('/admin/pause-all', async (req, res) => {
  const pause = req.body.pause === '1';
  await db.q('UPDATE farm_settings SET all_paused = ?, pause_note = ? WHERE id = 1',
    [pause, pause ? String(req.body.note || '').slice(0, 200) || null : null]);
  flash(req, pause ? 'All feeding is paused.' : 'Feeding is back on across the farm.');
  res.redirect('/admin/stations');
});

router.post('/admin/settings', async (req, res) => {
  await db.q('UPDATE farm_settings SET member_daily_limit = ? WHERE id = 1', [int(req.body.member_daily_limit, 1, 100)]);
  flash(req, 'Saved.');
  res.redirect('/admin/stations');
});

router.post('/admin/stations/:id', async (req, res) => {
  const b = req.body;
  const opens = clock(b.opens_at), closes = clock(b.closes_at);
  if (!opens || !closes || opens >= closes) {
    flash(req, 'Feeding hours need an opening time before the closing time.');
    return res.redirect('/admin/stations');
  }
  await db.q(
    `UPDATE stations SET name = ?, blurb = ?, daily_cap = ?, cooldown_seconds = ?, opens_at = ?, closes_at = ?,
       stream_uid = ?, is_paused = ?, pause_note = ? WHERE id = ?`,
    [String(b.name || '').trim().slice(0, 100) || 'Station', String(b.blurb || '').slice(0, 500),
     int(b.daily_cap, 0, 500), int(b.cooldown_seconds, 0, 3600), opens, closes,
     String(b.stream_uid || '').trim().slice(0, 100) || null,
     b.is_paused === '1', String(b.pause_note || '').slice(0, 200) || null, Number(req.params.id)]);
  flash(req, 'Station saved.');
  res.redirect('/admin/stations');
});

// Issues a new dispenser token. Shown once; only its hash is stored.
router.post('/admin/stations/:id/device-token', async (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const s = await db.one('SELECT slug FROM stations WHERE id = ?', [Number(req.params.id)]);
  if (!s) return res.redirect('/admin/stations');
  await db.q('UPDATE stations SET device_token_hash = ?, device_last_seen = NULL WHERE id = ?', [hash, Number(req.params.id)]);
  req.session.newDeviceToken = { slug: s.slug, token };
  res.redirect('/admin/stations');
});

module.exports = router;
