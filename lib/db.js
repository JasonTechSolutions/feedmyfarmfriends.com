// MySQL connection + schema. Everything that touches money or feeding lives
// here, so the site refuses to start its member features without MYSQL_URL.
const mysql = require('mysql2/promise');

let pool = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name  VARCHAR(80),
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_customer_id VARCHAR(100) NULL UNIQUE,
    sub_id         VARCHAR(100) NULL,
    sub_status     VARCHAR(30) NOT NULL DEFAULT 'none',
    sub_period_end DATETIME NULL,
    treat_credits  INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL
  )`,
  // A station = one camera + one dispenser (a paddock, the coop, the shack).
  `CREATE TABLE IF NOT EXISTS stations (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    slug      VARCHAR(40) NOT NULL UNIQUE,
    name      VARCHAR(100) NOT NULL,
    kind      VARCHAR(20) NOT NULL,
    blurb     VARCHAR(500),
    sort      INT NOT NULL DEFAULT 0,
    daily_cap INT NOT NULL DEFAULT 20,
    cooldown_seconds INT NOT NULL DEFAULT 180,
    opens_at  TIME NOT NULL DEFAULT '08:00:00',
    closes_at TIME NOT NULL DEFAULT '18:00:00',
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    pause_note VARCHAR(200),
    stream_uid VARCHAR(100),
    device_token_hash CHAR(64) NULL,
    device_last_seen  DATETIME NULL,
    device_fault      VARCHAR(200) NULL
  )`,
  `CREATE TABLE IF NOT EXISTS farm_settings (
    id INT PRIMARY KEY,
    all_paused BOOLEAN NOT NULL DEFAULT FALSE,
    pause_note VARCHAR(200),
    member_daily_limit INT NOT NULL DEFAULT 5
  )`,
  `INSERT IGNORE INTO farm_settings (id) VALUES (1)`,
  // One row per treat. pending -> sent (device picked it up) -> done | failed.
  `CREATE TABLE IF NOT EXISTS feedings (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    station_id INT NOT NULL,
    user_id    INT NOT NULL,
    status     VARCHAR(10) NOT NULL DEFAULT 'pending',
    created_at DATETIME(3) NOT NULL,
    sent_at    DATETIME(3) NULL,
    finished_at DATETIME(3) NULL,
    error      VARCHAR(200) NULL,
    INDEX (station_id, created_at),
    INDEX (user_id, created_at),
    INDEX (status),
    FOREIGN KEY (station_id) REFERENCES stations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  // Every change to a member's treat balance, with a unique ref so Stripe
  // retries and refund sweeps can never apply twice.
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    delta   INT NOT NULL,
    reason  VARCHAR(20) NOT NULL,
    ref     VARCHAR(150) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS stripe_events (
    id VARCHAR(255) PRIMARY KEY,
    type VARCHAR(100),
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`
];

// Starting stations. Caps are placeholders until the vet signs off; they are
// edited from /admin/stations afterwards and never overwritten here.
const SEED_STATIONS = [
  ...Array.from({ length: 8 }, (_, i) => ({
    slug: `paddock-${i + 1}`, name: `Paddock ${i + 1}`, kind: 'horses',
    blurb: 'Drop a horse treat into the paddock trough.',
    daily_cap: 20, cooldown_seconds: 180, opens_at: '08:00:00', closes_at: '18:00:00'
  })),
  { slug: 'chicken-coop', name: 'Chicken Coop', kind: 'chickens', blurb: 'Scatter some scratch grains for the flock.',
    daily_cap: 30, cooldown_seconds: 120, opens_at: '07:00:00', closes_at: '17:00:00' },
  { slug: 'duck-shack', name: 'Duck Shack', kind: 'ducks', blurb: 'A scoop of duck-safe pellets for the crew.',
    daily_cap: 15, cooldown_seconds: 180, opens_at: '07:00:00', closes_at: '17:00:00' }
];

async function init() {
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (!url) {
    console.log('[db] MYSQL_URL not set — member features disabled.');
    return false;
  }
  pool = mysql.createPool({
    uri: url, connectionLimit: 8, waitForConnections: true,
    timezone: 'Z', dateStrings: false, supportBigNumbers: true
  });
  try {
    for (const sql of SCHEMA) await pool.query(sql);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stations');
    if (!n) {
      for (const [i, s] of SEED_STATIONS.entries()) {
        await pool.execute(
          `INSERT INTO stations (slug, name, kind, blurb, sort, daily_cap, cooldown_seconds, opens_at, closes_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.slug, s.name, s.kind, s.blurb, i, s.daily_cap, s.cooldown_seconds, s.opens_at, s.closes_at]);
      }
    }
  } catch (e) {
    await pool.end().catch(() => {});
    pool = null;
    throw e;
  }
  console.log('[db] Connected; schema ready.');
  return true;
}

const enabled = () => !!pool;
const getPool = () => pool;

async function q(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
async function one(sql, params) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

// Runs fn(conn) inside a transaction; rolls back on any throw.
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

async function ping() {
  if (!pool) return 'disabled';
  await pool.query('SELECT 1');
  return 'ok';
}
async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { init, enabled, getPool, q, one, tx, ping, close, SEED_STATIONS };
