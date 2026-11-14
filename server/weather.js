'use strict';
// Weather for the clock screen, from Open-Meteo (free, no key). Location: a city you type in, or
// (when blank) an approximate one from this PC's internet address via ipwho.is.
const log = require('./log');

let timer = null;
let latest = null;
let onUpdate = () => {};
let place = null; // { lat, lon, city, key }

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'PhoneDesk' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function locate(city) {
  const key = (city || '').trim().toLowerCase() || 'auto';
  if (place && place.key === key) return place;
  if (key === 'auto') {
    const r = await getJson('https://ipwho.is/?fields=success,city,latitude,longitude');
    if (!r.success) throw new Error('could not find your approximate location');
    place = { lat: r.latitude, lon: r.longitude, city: r.city, key };
  } else {
    const r = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city.trim()));
    const g = r.results && r.results[0];
    if (!g) throw new Error(`no place called "${city}"`);
    place = { lat: g.latitude, lon: g.longitude, city: g.name, key };
  }
  return place;
}

// Open-Meteo's answer -> what the phone shows. Times stay local wall-clock strings ('2026-11-14T15:00') because the
// phone shows them as they are; `now` (an Open-Meteo local time, from current.time) picks the next hours.
function parse(r, city, unit, at) {
  const d = r.daily || {}, h = r.hourly || {}, c = r.current || {};
  const now = String(c.time || '').slice(0, 13); // '2026-11-14T15'
  let start = (h.time || []).findIndex((t) => String(t).slice(0, 13) >= now);
  if (start < 0) start = 0;
  const hours = (h.time || []).slice(start, start + 12).map((t, i) => ({
    t: String(t).slice(11, 16), temp: Math.round(h.temperature_2m[start + i]), code: h.weather_code[start + i],
    rain: h.precipitation_probability ? h.precipitation_probability[start + i] : null, day: h.is_day ? !!h.is_day[start + i] : true,
  }));
  const hm = (x) => (x ? String(x).slice(11, 16) : '');
  return {
    city, unit,
    temp: Math.round(c.temperature_2m),
    feels: c.apparent_temperature != null ? Math.round(c.apparent_temperature) : null,
    humidity: c.relative_humidity_2m != null ? Math.round(c.relative_humidity_2m) : null,
    wind: c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : null, // km/h
    code: c.weather_code,
    day: !!c.is_day,
    hi: Math.round(d.temperature_2m_max[0]),
    lo: Math.round(d.temperature_2m_min[0]),
    rain: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null, // today's chance of rain, %
    sunrise: hm(d.sunrise && d.sunrise[0]), sunset: hm(d.sunset && d.sunset[0]),
    hours, // the next 12 hours: { t: 'HH:MM', temp, code, rain, day }
    // The next days for the forecast row: { d: 'YYYY-MM-DD', code, hi, lo, rain }
    days: (d.time || []).map((x, i) => ({ d: x, code: d.weather_code[i], hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), rain: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null })),
    at,
  };
}

async function refresh(cfg) {
  try {
    const p = await locate(cfg.weatherCity);
    const unit = cfg.weatherUnit === 'f' ? 'fahrenheit' : 'celsius';
    const r = await getJson('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: p.lat, longitude: p.lon, timezone: 'auto', temperature_unit: unit, forecast_days: '5',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset',
    }));
    latest = parse(r, p.city, cfg.weatherUnit === 'f' ? 'F' : 'C', Date.now());
    onUpdate(latest);
  } catch (e) {
    log.warn('weather: ' + e.message);
  }
}

module.exports = {
  parse,
  latest: () => latest,
  start(getConfig, cb) {
    onUpdate = cb;
    const run = () => { const c = getConfig(); if (c.weather) refresh(c); };
    clearInterval(timer);
    run();
    timer = setInterval(run, 15 * 60 * 1000);
    timer.unref();
  },
  /** Settings changed: forget the old place and fetch again. */
  reload(cfg) {
    place = null;
    if (!cfg.weather) { latest = null; onUpdate(null); return; }
    refresh(cfg);
  },
};
