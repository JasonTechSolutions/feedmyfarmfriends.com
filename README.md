# Feed My Farm Friends

Members subscribe to watch live cameras around the farm and spend $1 treats
to feed the horses, chickens and ducks. Each station (a paddock, the coop, the
duck shack) has a daily treat cap; once it's reached the page says
"They've had plenty of treats today. Come back tomorrow!"

Same stack as the Merry Mac Farm site: Node 20+, Express 5, EJS and MySQL,
deployed on Railway.

## How it fits together

```
Visitor ──► Website (this app) ──► MySQL: members, treat credits, daily counts
   ▲            │  ▲
   │            │  └── Stripe: membership + treat bundles (webhook)
   │            ▼
   │     Dispenser API ◄── each station's controller polls over HTTPS
   │
   └──── Cloudflare Stream ◄── relay on the Blue Iris PC (one stream per cam)
```

* **Feeding rules** live in `lib/feeding.js`. Every tap is checked on the
  server, inside a transaction that locks the station row: daily cap, farm-wide
  and station pause, feeding hours (farm time), dispenser online, cooldown,
  per-member daily limit, membership, credits.
* **Treat credits** are bought in bundles ($5 = 5, $10 = 11, $20 = 24) so a $1
  treat doesn't lose a third of itself to card fees. Every balance change is a
  row in `credit_ledger` with a unique ref, so Stripe retries and refunds can't
  double-apply.
* **A treat is only spent once the dispenser confirms it.** If it reports a
  fault, or doesn't confirm within `FEED_TIMEOUT_SECONDS`, the credit goes back
  and the treat doesn't count toward the cap.
* **Admin** at `/admin/stations`: caps, cooldowns, hours, camera IDs, per-station
  pause, the farm-wide kill switch, and dispenser tokens.

## Run it locally

```bash
npm install
cp .env.example .env   # fill in MYSQL_URL, SESSION_SECRET, ADMIN_EMAIL/PASSWORD
SIMULATE_DISPENSERS=true node --env-file=.env server.js
```

Sign in with the admin account and every page works; with
`SIMULATE_DISPENSERS=true` treats "drop" instantly without hardware.

Tests: `npm test` runs the rule tests. Point `TEST_MYSQL_URL` at an empty
throwaway database to also run the end-to-end flow (it drops the tables):

```bash
TEST_MYSQL_URL=mysql://user:pw@127.0.0.1:3306/fmff_test npm test
```

## Deploy on Railway

1. New project from this repo, add a MySQL service, set `MYSQL_URL=${{MySQL.MYSQL_URL}}`.
2. Set `SESSION_SECRET`, `SITE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Sign in once,
   then remove `ADMIN_PASSWORD`.
3. Stripe: create a "Membership" product with a monthly price and put its price
   ID in `STRIPE_PRICE_MEMBERSHIP`. Add a webhook to `https://<site>/stripe/webhook`
   for `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created`, `.updated` and `.deleted`; copy its signing
   secret to `STRIPE_WEBHOOK_SECRET`. Turn on the Customer Portal in Stripe
   settings so members can manage or cancel.

## Cameras: Blue Iris to Cloudflare Stream

Members never connect to Blue Iris directly. That keeps the farm PC off the
public internet and means 500 viewers cost the farm the same upload as one.

1. In Cloudflare Stream, create one **live input** per camera. Note its RTMPS
   URL and stream key, and paste its ID into that station on `/admin/stations`.
   Turn on "require signed URLs" for the live input and set the
   `CF_STREAM_SIGNING_*` variables so only signed-in members can watch.
2. On the Blue Iris PC, enable Blue Iris's web server so each camera is
   available over RTSP at `rtsp://USER:PASS@127.0.0.1:81/<CameraShortName>`.
3. Run one relay per camera that pulls from Blue Iris and pushes to Cloudflare:

   ```bash
   ffmpeg -rtsp_transport tcp -i "rtsp://USER:PASS@127.0.0.1:81/paddock1" \
     -c:v copy -an -f flv "rtmps://live.cloudflare.com:443/live/<STREAM_KEY>"
   ```

   Run it as a Windows service (for example with NSSM) so it restarts on its
   own. If a camera's stream won't copy cleanly, swap `-c:v copy` for
   `-c:v libx264 -preset veryfast -b:v 2500k -g 60`.
4. Budget roughly 1.5 to 3 Mbps of farm upload per camera.

Confirm the Blue Iris port and stream paths against your own install; they
depend on its web server settings.

## Dispensers

Each station's controller (ESP32 or Raspberry Pi) uses the token created on
`/admin/stations` and talks out over HTTPS, so no ports are opened at the farm:

| Call | When | Body / reply |
| --- | --- | --- |
| `POST /api/device/heartbeat` | every ~30 s | `{ "fault": "hopper low" }` or `{}` |
| `GET /api/device/next` | every ~2 s | `{ "feeding": 123 }` or `{ "feeding": null }` |
| `POST /api/device/feedings/123` | after dropping | `{ "ok": true }` or `{ "ok": false, "error": "jam" }` |

Send `Authorization: Bearer <token>` on every call. The firmware must also keep
its own daily cap and cooldown, so a website bug can never overfeed.
