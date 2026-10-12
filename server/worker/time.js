'use strict';

// Send window: Mon–Fri 08:00–17:00 Europe/Vilnius. All DB timestamps are UTC
// in SQLite's 'YYYY-MM-DD HH:MM:SS' format, matching datetime('now').

const TZ = 'Europe/Vilnius';
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR   = 17;

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
});

function localParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(p.hour, 10),
    minute: parseInt(p.minute, 10),
    weekend: p.weekday === 'Sat' || p.weekday === 'Sun',
    weekdayIndex: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday),
  };
}

function inSendWindow(date = new Date()) {
  const p = localParts(date);
  return !p.weekend && p.hour >= WINDOW_START_HOUR && p.hour < WINDOW_END_HOUR;
}

// Earliest moment >= date that falls inside the send window, plus 0–30 min of
// jitter when it had to be shifted (so follow-ups don't all land at 08:00).
function nextSendWindow(date) {
  if (inSendWindow(date)) return date;
  // Walk forward in 5-minute steps; at most ~3.7 days (Fri 17:00 → Mon 08:00)
  let t = new Date(Math.ceil(date.getTime() / 300000) * 300000);
  for (let i = 0; i < 2000 && !inSendWindow(t); i++) t = new Date(t.getTime() + 300000);
  return new Date(t.getTime() + Math.floor(Math.random() * 30 * 60000));
}

// Vilnius calendar date, used for the once-per-day jobs
function localDate(date = new Date()) {
  return localParts(date).date;
}

// UTC instant of 00:00 Vilnius time today (or N days earlier)
function localDayStart(date = new Date(), daysBack = 0) {
  const p = localParts(date);
  const ms = date.getTime() - (p.hour * 60 + p.minute) * 60000 - date.getUTCSeconds() * 1000 - date.getUTCMilliseconds();
  return new Date(ms - daysBack * 86400000);
}

// UTC instant of Monday 00:00 Vilnius time this week
function localWeekStart(date = new Date()) {
  return localDayStart(date, localParts(date).weekdayIndex);
}

// Warmup runs every day (weekends too), 08:00–20:00 Vilnius
const WARMUP_START_HOUR = 8;
const WARMUP_END_HOUR = 20;

function inWarmupWindow(date = new Date()) {
  const p = localParts(date);
  return p.hour >= WARMUP_START_HOUR && p.hour < WARMUP_END_HOUR;
}

// Today's 20:00 Vilnius (end of the warmup window)
function warmupWindowEnd(date = new Date()) {
  return new Date(localDayStart(date).getTime() + WARMUP_END_HOUR * 3600000);
}

// Next 08:00 Vilnius after date
function nextWarmupWindowStart(date = new Date()) {
  const todayStart = new Date(localDayStart(date).getTime() + WARMUP_START_HOUR * 3600000);
  return date < todayStart ? todayStart : new Date(todayStart.getTime() + 86400000);
}

function toSql(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function fromSql(s) {
  return new Date(s.replace(' ', 'T') + 'Z');
}

module.exports = {
  inSendWindow, nextSendWindow, localDate, localDayStart, localWeekStart, toSql, fromSql,
  inWarmupWindow, warmupWindowEnd, nextWarmupWindowStart,
};
