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

async function refresh(cfg) {
  try {
    const p = await locate(cfg.weatherCity);
    const unit = cfg.weatherUnit === 'f' ? 'fahrenheit' : 'celsius';
    const r = await getJson('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: p.lat, longitude: p.lon, timezone: 'auto', temperature_unit: unit, forecast_days: '5',
      current: 'temperature_2m,weather_code,is_day', daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    }));
    latest = {
      city: p.city,
      unit: cfg.weatherUnit === 'f' ? 'F' : 'C',
      temp: Math.round(r.current.temperature_2m),
      code: r.current.weather_code,
      day: !!r.current.is_day,
      hi: Math.round(r.daily.temperature_2m_max[0]),
      lo: Math.round(r.daily.temperature_2m_min[0]),
      // The next days for the forecast row: { d: 'YYYY-MM-DD', code, hi, lo }
      days: (r.daily.time || []).map((d, i) => ({ d, code: r.daily.weather_code[i], hi: Math.round(r.daily.temperature_2m_max[i]), lo: Math.round(r.daily.temperature_2m_min[i]) })),
      at: Date.now(),
    };
    onUpdate(latest);
  } catch (e) {
    log.warn('weather: ' + e.message);
  }
}

module.exports = {
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
