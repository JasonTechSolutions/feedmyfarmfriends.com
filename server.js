const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const db = require('./lib/db');
const auth = require('./lib/auth');
const feeding = require('./lib/feeding');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Railway sits behind a proxy

app.use(helmet({
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      frameSrc: ['https://*.cloudflarestream.com'],
      formAction: ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com']
    }
  }
}));
app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// Endpoints that authenticate themselves (Stripe signature, device token)
// come before sessions and the same-origin check.
app.use(require('./routes/stripe'));
app.use(require('./routes/device'));

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

let sessionMiddleware = (req, res, next) => next();
app.use((req, res, next) => sessionMiddleware(req, res, next));
app.use(auth.sameOrigin);
app.use(auth.loadUser);
app.use((req, res, next) => {
  res.locals.flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  res.locals.path = req.path;
  res.locals.title = null;
  next();
});

const MEMBER_PATHS = ['/login', '/register', '/logout', '/account', '/cams', '/admin', '/api/stations', '/api/feedings'];
app.use((req, res, next) => {
  if (!db.enabled() && MEMBER_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) {
    return res.status(503).render('error', { title: 'Back soon', message: 'Member features are offline for a moment. Please try again shortly.' });
  }
  next();
});

app.get('/', (req, res) => res.render('index', { title: null }));
app.use(require('./routes/auth'));
app.use(require('./routes/account'));
app.use(require('./routes/cams'));
app.use(require('./routes/admin'));

app.get('/health', async (req, res) => {
  let database = 'disabled';
  try { database = await db.ping(); } catch { database = 'error'; }
  res.json({ status: 'ok', database });
});

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page wandered off.' }));

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ ok: false, message: 'Something went wrong.' });
  res.status(500).render('error', { title: 'Something went wrong', message: 'Something went wrong on our end. Please try again.' });
});

async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) return;
  if (await db.one('SELECT id FROM users WHERE is_admin LIMIT 1')) return; // only seeds the very first admin
  const existing = await db.one('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) await db.q('UPDATE users SET is_admin = TRUE WHERE id = ?', [existing.id]);
  else await db.q(`INSERT INTO users (email, password_hash, display_name, is_admin) VALUES (?, ?, 'Farm admin', TRUE)`,
    [email, await auth.hashPassword(pw)]);
  console.log(`[admin] ${email} is now an admin. Remove ADMIN_PASSWORD from Railway variables.`);
}

async function start() {
  const timers = [];
  let store = null;
  try {
    if (await db.init()) {
      if (!process.env.SESSION_SECRET) console.warn('[session] SESSION_SECRET is not set — set it in Railway variables.');
      store = new MySQLStore({ clearExpired: true, checkExpirationInterval: 15 * 60 * 1000, createDatabaseTable: true }, db.getPool());
      sessionMiddleware = session({
        name: 'fmff.sid',
        secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
        store, resave: false, saveUninitialized: false, rolling: true,
        cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 }
      });
      await bootstrapAdmin();
      // Refund any treat the dispenser never confirmed.
      timers.push(setInterval(() => feeding.sweepStale().catch(e => console.error('[sweep]', e.message)), 15 * 1000));
    }
  } catch (e) {
    console.error('[db] init failed — member features disabled:', e.message);
  }
  const server = app.listen(PORT, () => console.log(`Feed My Farm Friends listening on ${server.address().port}`));
  server.on('close', () => {
    timers.forEach(clearInterval);
    store?.clearExpirationInterval();
  });
  return server;
}

if (require.main === module) start();
module.exports = { app, start };
