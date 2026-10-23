// The farm runs on Minnesota time: daily caps reset at local midnight and
// feeding hours are local wall-clock times.
const FARM_TZ = process.env.FARM_TZ || 'America/Chicago';

function farmParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FARM_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

// Offset of the farm's zone from UTC at `date`, in milliseconds.
function offsetMs(date) {
  const p = farmParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant of the most recent farm-local midnight.
function farmDayStart(now = new Date()) {
  const p = farmParts(now);
  const guess = Date.UTC(p.y, p.m - 1, p.d) - offsetMs(now);
  // Re-check the offset at the guessed instant (handles DST change days).
  return new Date(Date.UTC(p.y, p.m - 1, p.d) - offsetMs(new Date(guess)));
}

// UTC instant of the next farm-local midnight.
function nextFarmDayStart(now = new Date()) {
  const start = farmDayStart(now);
  return farmDayStart(new Date(start.getTime() + 26 * 3600 * 1000));
}

// Minutes since local midnight, e.g. 8:30am -> 510.
function farmMinutes(now = new Date()) {
  const p = farmParts(now);
  return p.h * 60 + p.min;
}

// 'HH:MM:SS' -> minutes since midnight.
const timeToMinutes = t => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

function formatClock(t) {
  const mins = timeToMinutes(t);
  const h = Math.floor(mins / 60), m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

module.exports = { FARM_TZ, farmDayStart, nextFarmDayStart, farmMinutes, timeToMinutes, formatClock };
