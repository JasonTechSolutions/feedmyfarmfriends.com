const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const pay = require('../lib/stripe');

const router = express.Router();
const baseUrl = req => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

router.get('/account', auth.requireLogin, async (req, res) => {
  const history = await db.q(
    `SELECT l.delta, l.reason, l.created_at, s.name AS station
     FROM credit_ledger l
     LEFT JOIN feedings f ON l.reason IN ('feed', 'refund') AND f.id = CAST(SUBSTRING_INDEX(l.ref, ':', -1) AS UNSIGNED)
     LEFT JOIN stations s ON s.id = f.station_id
     WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 20`, [req.user.id]);
  res.render('account', {
    title: 'Your account', history, bundles: pay.BUNDLES, payEnabled: pay.enabled(),
    welcome: req.query.welcome === '1', join: req.query.join === '1', bought: Number(req.query.treats) || 0
  });
});

const needPay = (req, res, next) => pay.enabled() ? next()
  : res.status(503).render('error', { title: 'Payments not set up', message: 'Payments aren’t switched on yet. Check back soon.' });

router.post('/account/join', auth.requireLogin, needPay, async (req, res) => {
  if (req.user.isSubscribed) return res.redirect('/account');
  res.redirect(303, await pay.membershipCheckout(req.user, baseUrl(req)));
});

router.post('/account/treats', auth.requireMember, needPay, async (req, res) => {
  const url = await pay.bundleCheckout(req.user, String(req.body.bundle || ''), baseUrl(req));
  if (!url) return res.redirect('/account');
  res.redirect(303, url);
});

router.post('/account/billing', auth.requireLogin, needPay, async (req, res) => {
  res.redirect(303, await pay.portalUrl(req.user, baseUrl(req)));
});

module.exports = router;
