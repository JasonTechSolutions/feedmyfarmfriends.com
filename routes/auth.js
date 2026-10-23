const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const auth = require('../lib/auth');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const safeNext = n => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) ? n : null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signIn(req, res, user, next) {
  req.session.regenerate(async err => {
    if (err) return res.status(500).send('Session error');
    req.session.userId = user.id;
    await db.q('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    res.redirect(next || '/cams');
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/cams');
  res.render('login', { title: 'Sign in', error: null, email: '', next: safeNext(req.query.next) || '' });
});

router.post('/login', limiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const user = email && await db.one('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await auth.verifyPassword(user, password))) {
    return res.status(401).render('login', { title: 'Sign in', error: 'That email and password don’t match an account.', email, next: next || '' });
  }
  signIn(req, res, user, next);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('register', { title: 'Create your account', error: null, form: {} });
});

router.post('/register', limiter, async (req, res) => {
  const form = {
    name: String(req.body.name || '').trim().slice(0, 80),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200)
  };
  const password = String(req.body.password || '');
  const fail = error => res.status(400).render('register', { title: 'Create your account', error, form });
  if (!form.name) return fail('Tell us what to call you.');
  if (!EMAIL_RE.test(form.email)) return fail('Enter an email address like name@example.com.');
  if (req.body.age_ok !== 'yes') return fail('Members must be 13 or older. Ask a parent to create the account.');
  const problem = auth.passwordProblem(password);
  if (problem) return fail(problem);
  if (await db.one('SELECT id FROM users WHERE email = ?', [form.email])) {
    return fail('There’s already an account with that email. Try signing in.');
  }
  const r = await db.q('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
    [form.email, await auth.hashPassword(password), form.name]);
  signIn(req, res, { id: r.insertId }, '/account?join=1');
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.redirect('/');
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
