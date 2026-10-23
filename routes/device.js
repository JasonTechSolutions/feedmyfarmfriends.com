// API for the dispenser controllers on the farm. Each controller polls out
// over HTTPS with its own bearer token, so no ports open on the farm network.
//
//   POST /api/device/heartbeat   { fault?: "hopper low" }      every ~30s
//   GET  /api/device/next        -> { feeding: id | null }     every ~2s
//   POST /api/device/feedings/:id  { ok: true } | { ok: false, error }
//
// The controller must also enforce its own daily cap and cooldown in
// firmware, so a bug up here can never overfeed.
const crypto = require('crypto');
const express = require('express');
const db = require('../lib/db');
const feeding = require('../lib/feeding');

const router = express.Router();
router.use('/api/device', express.json({ limit: '2kb' }));

router.use('/api/device', async (req, res, next) => {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '');
  if (!m || !db.enabled()) return res.status(401).json({ ok: false });
  const hash = crypto.createHash('sha256').update(m[1]).digest('hex');
  const s = await db.one('SELECT * FROM stations WHERE device_token_hash = ?', [hash]);
  if (!s) return res.status(401).json({ ok: false });
  await db.q('UPDATE stations SET device_last_seen = NOW() WHERE id = ?', [s.id]);
  req.station = s;
  next();
});

router.post('/api/device/heartbeat', async (req, res) => {
  const fault = req.body?.fault ? String(req.body.fault).slice(0, 200) : null;
  await db.q('UPDATE stations SET device_fault = ? WHERE id = ?', [fault, req.station.id]);
  res.json({ ok: true, station: req.station.slug, cap: req.station.daily_cap, cooldown: req.station.cooldown_seconds });
});

router.get('/api/device/next', async (req, res) => {
  const id = await feeding.claimNext(req.station.id);
  res.json({ ok: true, feeding: id });
});

router.post('/api/device/feedings/:id', async (req, res) => {
  const ok = req.body?.ok === true;
  const done = await feeding.complete(req.station.id, Number(req.params.id), ok, req.body?.error);
  res.json({ ok: done });
});

module.exports = router;
