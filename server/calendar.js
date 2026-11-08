'use strict';
// Upcoming events for the clock screen, from a calendar's private iCal (.ics) address:
// Google Calendar ("Secret address in iCal format") or Outlook ("Publish a calendar" → ICS).
// The address is a secret: it stays on this PC and only the next few events go to the phones.
// Handles all-day and timed events, time zones (IANA names; others fall back to this PC's zone),
// and the common repeat rules (daily/weekly/monthly/yearly, INTERVAL, COUNT, UNTIL, BYDAY, EXDATE).
const log = require('./log');

const DAYS_AHEAD = 7;
const MAX_EVENTS = 8;
let timer = null;
let latest = null;
let onUpdate = () => {};

/* ---------------------------------------------------------------- ICS parsing */
function unfold(text) { return String(text).replace(/\r?\n[ \t]/g, ''); }

function unescape(v) {
  return String(v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/** "DTSTART;TZID=Europe/London:20261108T090000" -> { name, params, value } */
function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(';');
  const params = {};
  for (const p of parts.slice(1)) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); }
  return { name: parts[0].toUpperCase(), params, value };
}

// Offset (ms) of an IANA zone from UTC at a given instant.
function zoneOffset(tz, at) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - at;
}

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Wall-clock time in a zone -> epoch ms. tz null = this PC's local time. */
function wall(y, mo, d, h, mi, s, tz) {
  if (!tz) return new Date(y, mo, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let t = guess - zoneOffset(tz, guess);
  t = guess - zoneOffset(tz, t); // second pass settles DST edges
  return t;
}

/** Parses a DATE or DATE-TIME property -> { t, allDay, tz, parts } */
function parseDate(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  if (!m[4] || prop.params.VALUE === 'DATE') return { t: new Date(y, mo, d).getTime(), allDay: true, tz: null, parts: [y, mo, d, 0, 0, 0] };
  const [h, mi, s] = [+m[4], +m[5], +m[6]];
  if (m[7]) return { t: Date.UTC(y, mo, d, h, mi, s), allDay: false, tz: 'UTC', parts: [y, mo, d, h, mi, s] };
  const tz = prop.params.TZID && validZone(prop.params.TZID) ? prop.params.TZID : null;
  return { t: wall(y, mo, d, h, mi, s, tz), allDay: false, tz, parts: [y, mo, d, h, mi, s] };
}

function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = { props: {}, exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'EXDATE') { for (const v of p.value.split(',')) { const d = parseDate({ value: v, params: p.params }); if (d) cur.exdates.push(d.t); } continue; }
    if (!cur.props[p.name]) cur.props[p.name] = p;
  }
  return events;
}

/* ---------------------------------------------------------------- repeats */
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRule(v) {
  const r = {};
  for (const kv of String(v || '').split(';')) { const [k, val] = kv.split('='); if (k && val) r[k.toUpperCase()] = val; }
  return r;
}

/** Start times of an event between from and to (ms), following its RRULE. */
function occurrences(ev, start, from, to) {
  const rule = ev.props.RRULE ? parseRule(ev.props.RRULE.value) : null;
  if (!rule) return start.t <= to ? [start.t] : [];
  const freq = rule.FREQ, interval = Math.max(1, +rule.INTERVAL || 1);
  const count = +rule.COUNT || Infinity;
  const until = rule.UNTIL ? (parseDate({ value: rule.UNTIL, params: {} }) || {}).t : Infinity;
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map((x) => WEEKDAYS[x.slice(-2)]).filter((x) => x >= 0) : null;
  const [y, mo, d, h, mi, s] = start.parts;
  const tz = start.allDay ? null : start.tz === 'UTC' ? 'UTC' : start.tz;
  const at = (Y, M, D) => (start.allDay ? new Date(Y, M, D).getTime() : wall(Y, M, D, h, mi, s, tz === 'UTC' ? 'UTC' : tz));
  const out = [];
  let n = 0;
  const push = (t) => {
    if (t < start.t || t > until || n >= count) return false;
    n++;
    if (t >= from - 86400000 * 2 && t <= to && !ev.exdates.includes(t)) out.push(t);
    return true;
  };
  for (let k = 0; k < 2000 && n < count; k++) {
    let cands = [];
    if (freq === 'DAILY') cands = [at(y, mo, d + k * interval)];
    else if (freq === 'WEEKLY') {
      const base = new Date(y, mo, d + k * 7 * interval);
      const days = byday && byday.length ? byday : [new Date(y, mo, d).getDay()];
      cands = days.map((wd) => { const x = new Date(base); x.setDate(base.getDate() - base.getDay() + wd); return at(x.getFullYear(), x.getMonth(), x.getDate()); }).sort((a, b) => a - b);
    } else if (freq === 'MONTHLY') cands = [at(y, mo + k * interval, d)];
    else if (freq === 'YEARLY') cands = [at(y + k * interval, mo, d)];
    else break;
    for (const t of cands) push(t);
    if (cands.length && cands[0] > to) break;
  }
  return out;
}

/** The next events (from now through the coming days), soonest first. */
function upcoming(text, now) {
  const from = now, to = now + DAYS_AHEAD * 86400000;
  const list = [];
  for (const ev of parseIcs(text)) {
    if ((ev.props.STATUS && /CANCELLED/i.test(ev.props.STATUS.value))) continue;
    const start = parseDate(ev.props.DTSTART);
    if (!start) continue;
    const end = parseDate(ev.props.DTEND);
    const dur = end ? Math.max(0, end.t - start.t) : start.allDay ? 86400000 : 0;
    for (const t of occurrences(ev, start, from, to)) {
      if (t + dur <= from) continue; // already over
      list.push({
        title: unescape(ev.props.SUMMARY && ev.props.SUMMARY.value) || 'Busy',
        where: unescape(ev.props.LOCATION && ev.props.LOCATION.value).slice(0, 80),
        start: t, end: t + dur, allDay: start.allDay,
      });
    }
  }
  list.sort((a, b) => a.start - b.start || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0));
  return list.slice(0, MAX_EVENTS).map((e) => Object.assign(e, { title: e.title.slice(0, 100) }));
}

/* ---------------------------------------------------------------- fetching */
async function fetchIcs(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: ctl.signal, headers: { 'User-Agent': 'PhoneDesk' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('that address is not an iCal calendar');
    return text;
  } finally { clearTimeout(t); }
}

let lastText = '';
let lastError = '';
async function refresh(cfg) {
  if (!cfg.calendarUrl) { latest = null; lastText = ''; onUpdate(null); return; }
  try {
    lastText = await fetchIcs(cfg.calendarUrl);
    lastError = '';
  } catch (e) {
    lastError = e.message;
    log.warn('calendar: ' + e.message);
    if (!lastText) { latest = { events: [], error: e.message, at: Date.now() }; onUpdate(latest); return; }
  }
  recompute();
}
// Re-evaluated every minute from the cached file, so events drop off as they end.
function recompute() {
  if (!lastText) return;
  try {
    latest = { events: upcoming(lastText, Date.now()), error: lastError, at: Date.now() };
    onUpdate(latest);
  } catch (e) { log.warn('calendar: could not read the file: ' + e.message); }
}

module.exports = {
  latest: () => latest,
  upcoming, // for tests
  start(getConfig, cb) {
    onUpdate = cb;
    clearInterval(timer);
    refresh(getConfig());
    let n = 0;
    timer = setInterval(() => { if (++n % 15 === 0) refresh(getConfig()); else recompute(); }, 60 * 1000);
    timer.unref();
  },
  reload(cfg) { lastText = ''; refresh(cfg); },
  /** For the dashboard's "Check" button. */
  async check(url) {
    if (!/^(https?|webcal):\/\//i.test(url || '')) return { ok: false, error: 'Paste the full https:// or webcal:// address.' };
    try { const text = await fetchIcs(url); return { ok: true, count: upcoming(text, Date.now()).length }; } catch (e) { return { ok: false, error: e.message }; }
  },
};
