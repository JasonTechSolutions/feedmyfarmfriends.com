const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const auth = require('../lib/auth');
const feeding = require('../lib/feeding');
const cams = require('../lib/cams');
const time = require('../lib/time');

const router = express.Router();
const feedLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => String(req.user?.id || req.ip)
});

const KIND_LABEL = { horses: 'Horses', chickens: 'Chickens', ducks: 'Ducks' };

router.get('/cams', auth.requireMember, async (req, res) => {
  const stations = await db.q(
    `SELECT s.*, (SELECT COUNT(*) FROM feedings f WHERE f.station_id = s.id AND f.status <> 'failed' AND f.created_at >= ?) AS given
     FROM stations s ORDER BY s.sort, s.id`, [time.farmDayStart()]);
  res.render('cams', { title: 'Live cams', stations, KIND_LABEL });
});

async function station(req, res, next) {
  const s = await db.one('SELECT * FROM stations WHERE slug = ?', [req.params.slug]);
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'We couldn’t find that camera.' });
  req.station = s;
  next();
}

router.get('/cams/:slug', auth.requireMember, station, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.render('station', {
    title: req.station.name, station: req.station, KIND_LABEL,
    player: cams.playerUrl(req.station),
    initial: await feeding.status(req.station, req.user),
    hours: `${time.formatClock(req.station.opens_at)} to ${time.formatClock(req.station.closes_at)}`
  });
});

router.get('/api/stations/:slug/status', auth.requireMember, station, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await feeding.status(req.station, req.user));
});

router.post('/api/stations/:slug/feed', auth.requireMember, feedLimiter, async (req, res) => {
  const result = await feeding.requestFeed(req.user.id, req.params.slug);
  res.status(result.ok ? 200 : (result.code === 'not_found' ? 404 : 409)).json(result);
});

router.get('/api/feedings/:id', auth.requireMember, async (req, res) => {
  const f = await db.one('SELECT id, status, error FROM feedings WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  if (!f) return res.status(404).json({ ok: false });
  res.json({ ok: true, ...f });
});

module.exports = router;
