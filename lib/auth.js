const bcrypt = require('bcryptjs');
const db = require('./db');

const hashPassword = pw => bcrypt.hash(pw, 12);
const verifyPassword = (user, pw) => bcrypt.compare(pw, user.password_hash || '');

function passwordProblem(pw) {
  if (!pw || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

const ACTIVE_SUB = new Set(['active', 'trialing']);
const isSubscribed = u => !!u && (ACTIVE_SUB.has(u.sub_status) || !!u.is_admin);

async function loadUser(req, res, next) {
  res.locals.me = null;
  if (req.session?.userId && db.enabled()) {
    const u = await db.one('SELECT * FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
    if (u) {
      u.isAdmin = !!u.is_admin;
      u.isSubscribed = isSubscribed(u);
      u.name = u.display_name || u.email.split('@')[0];
      req.user = u;
      res.locals.me = u;
    } else {
      req.session.userId = null;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
const requireMember = (req, res, next) =>
  !req.user ? requireLogin(req, res, next)
    : req.user.isSubscribed ? next() : res.redirect('/account?join=1');
const requireAdmin = (req, res, next) =>
  !req.user ? requireLogin(req, res, next)
    : req.user.isAdmin ? next() : res.status(403).render('error', { title: 'Not allowed', message: 'That page is for farm staff.' });

// Same-origin check for state-changing requests (CSRF defense alongside
// SameSite=Lax cookies). Device and Stripe endpoints authenticate on their
// own and are mounted before this runs.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return res.status(403).send('Cross-site request blocked.');
  const host = req.get('host');
  const source = req.get('origin') || req.get('referer');
  if (source && source !== 'null') {
    try { if (new URL(source).host === host) return next(); } catch { /* fall through */ }
    return res.status(403).send('Cross-site request blocked.');
  }
  if (fetchSite === 'same-origin') return next();
  return res.status(403).send('Cross-site request blocked.');
}

module.exports = {
  hashPassword, verifyPassword, passwordProblem, isSubscribed,
  loadUser, requireLogin, requireMember, requireAdmin, sameOrigin
};
