// Station page: keeps the treat meter and Feed button in sync with the
// server, and follows a treat until the dispenser confirms it dropped.
(() => {
  const root = document.getElementById('feed');
  if (!root) return;
  const slug = root.dataset.slug;
  const btn = document.getElementById('feed-btn');
  const msg = document.getElementById('feed-msg');
  const meter = document.getElementById('feed-meter');
  const count = document.getElementById('feed-count');
  const credits = document.getElementById('feed-credits');
  const navCredits = document.querySelector('.nav .pill');
  let busy = false;
  let thanksUntil = 0; // keep the thank-you on screen for a moment
  let cooldownTimer = null;

  const setCredits = n => {
    if (n == null) return;
    credits.textContent = n;
    if (navCredits) navCredits.textContent = `${n} treats`;
  };

  function render(s) {
    meter.max = s.cap;
    meter.value = s.given;
    count.textContent = `${s.given} of ${s.cap} treats given today`;
    setCredits(s.credits);
    if (busy) return;
    btn.disabled = !s.ok;
    clearInterval(cooldownTimer);
    if (Date.now() < thanksUntil) { setTimeout(refresh, thanksUntil - Date.now()); return; }
    if (s.ok) { msg.textContent = ''; return; }
    if (s.code === 'no_credits') {
      msg.innerHTML = '';
      msg.append('You\u2019re out of treats. ');
      const a = document.createElement('a');
      a.href = '/account'; a.textContent = 'Grab a bundle';
      msg.append(a, ' to keep feeding.');
      return;
    }
    msg.textContent = s.message;
    if (s.code === 'cooldown' && s.retryAfter) {
      let left = s.retryAfter;
      const tick = () => {
        if (left <= 0) { clearInterval(cooldownTimer); refresh(); return; }
        msg.textContent = `${s.message} Next treat in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
        left -= 1;
      };
      tick();
      cooldownTimer = setInterval(tick, 1000);
    }
  }

  async function refresh() {
    try {
      const r = await fetch(`/api/stations/${encodeURIComponent(slug)}/status`, { headers: { accept: 'application/json' } });
      if (r.ok) render(await r.json());
    } catch { /* try again on the next tick */ }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function follow(id) {
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      try {
        const r = await fetch(`/api/feedings/${id}`);
        const f = await r.json();
        if (f.status === 'done') return 'done';
        if (f.status === 'failed') return 'failed';
      } catch { /* keep waiting */ }
    }
    return 'unknown';
  }

  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    msg.textContent = 'Sending your treat\u2026';
    try {
      const r = await fetch(`/api/stations/${encodeURIComponent(slug)}/feed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      const res = await r.json().catch(() => ({ ok: false, message: 'Something went wrong. Please try again.' }));
      if (!res.ok) { msg.textContent = res.message || 'That didn\u2019t work. Please try again.'; return; }
      setCredits(res.credits);
      msg.textContent = 'Treat on the way! Watch the trough\u2026';
      const outcome = await follow(res.feedingId);
      msg.textContent = outcome === 'done' ? 'Treat delivered. Thank you for feeding them!'
        : outcome === 'failed' ? 'The dispenser didn\u2019t drop it, so your treat is back in your account.'
        : 'Still waiting on the dispenser. If it doesn\u2019t drop, your treat comes back automatically.';
      thanksUntil = Date.now() + 8000;
    } finally {
      busy = false;
      refresh();
    }
  });

  render(JSON.parse(root.dataset.status));
  setInterval(refresh, 5000);
})();
