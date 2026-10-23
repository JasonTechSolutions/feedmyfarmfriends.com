// Live video comes from Blue Iris on the farm, relayed once per camera to
// Cloudflare Stream, so viewer count never touches the farm's upload.
// Members get a short-lived signed URL; a copied link stops working.
const crypto = require('crypto');

const TOKEN_MINUTES = 15;
let signingKey = null;

function key() {
  if (signingKey !== null) return signingKey;
  const jwk = process.env.CF_STREAM_SIGNING_JWK;
  signingKey = false;
  if (jwk && process.env.CF_STREAM_SIGNING_KEY_ID) {
    try {
      signingKey = crypto.createPrivateKey({ key: JSON.parse(Buffer.from(jwk, 'base64').toString('utf8')), format: 'jwk' });
    } catch (e) {
      console.error('[cams] CF_STREAM_SIGNING_JWK is not a valid base64 JWK:', e.message);
    }
  }
  return signingKey;
}

const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signedToken(uid, now = Date.now()) {
  const header = { alg: 'RS256', kid: process.env.CF_STREAM_SIGNING_KEY_ID };
  const payload = { sub: uid, kid: process.env.CF_STREAM_SIGNING_KEY_ID, exp: Math.floor(now / 1000) + TOKEN_MINUTES * 60 };
  const body = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(body), key()).toString('base64url');
  return `${body}.${sig}`;
}

// Returns the iframe URL for a station, or null when no camera is set up.
function playerUrl(station) {
  const code = process.env.CF_STREAM_CUSTOMER_CODE;
  if (!code || !station.stream_uid) return null;
  const id = key() ? signedToken(station.stream_uid) : station.stream_uid;
  return `https://customer-${code}.cloudflarestream.com/${id}/iframe?autoplay=true&muted=true&preload=auto`;
}

module.exports = { playerUrl, signedToken };
