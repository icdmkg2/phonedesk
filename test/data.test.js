'use strict';
// Weather details (hourly, sunrise, rain) and the calendar's busy days for the Month widget.
//   node test/data.test.js
const assert = require('assert');
const weather = require('../server/weather');
const calendar = require('../server/calendar');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

const hours = Array.from({ length: 48 }, (_, i) => `2026-11-${14 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`);
const sample = {
  current: { time: '2026-11-14T15:15', temperature_2m: 19.4, apparent_temperature: 18.2, relative_humidity_2m: 61, wind_speed_10m: 12.3, weather_code: 2, is_day: 1 },
  hourly: { time: hours, temperature_2m: hours.map((_, i) => 10 + i), weather_code: hours.map(() => 1), precipitation_probability: hours.map((_, i) => i), is_day: hours.map((_, i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)) },
  daily: { time: ['2026-11-14', '2026-11-15'], temperature_2m_max: [24.4, 26], temperature_2m_min: [15.6, 17], weather_code: [2, 0], precipitation_probability_max: [20, 5], sunrise: ['2026-11-14T06:21', '2026-11-15T06:22'], sunset: ['2026-11-14T16:44', '2026-11-15T16:43'] },
};

test('weather: the next 12 hours start at the current hour', () => {
  const w = weather.parse(sample, 'Tel Aviv', 'C', 1);
  assert.strictEqual(w.hours.length, 12);
  assert.strictEqual(w.hours[0].t, '15:00');
  assert.strictEqual(w.hours[0].temp, 25);
  assert.strictEqual(w.hours[0].rain, 15);
  assert.strictEqual(w.hours[3].day, false, '18:00 is after dark');
});

test('weather: feels like, rain, wind, sunrise and sunset', () => {
  const w = weather.parse(sample, 'Tel Aviv', 'C', 1);
  assert.strictEqual(w.feels, 18);
  assert.strictEqual(w.humidity, 61);
  assert.strictEqual(w.wind, 12);
  assert.strictEqual(w.rain, 20);
  assert.strictEqual(w.sunrise, '06:21');
  assert.strictEqual(w.sunset, '16:44');
  assert.strictEqual(w.hi, 24); assert.strictEqual(w.lo, 16);
  assert.deepStrictEqual(w.days[1], { d: '2026-11-15', code: 0, hi: 26, lo: 17, rain: 5 });
});

test('weather: an answer without the extras still reads', () => {
  const w = weather.parse({ current: { temperature_2m: 3, weather_code: 0, is_day: 0 }, daily: { time: ['2026-01-01'], temperature_2m_max: [5], temperature_2m_min: [1], weather_code: [0] } }, 'Oslo', 'C', 1);
  assert.strictEqual(w.temp, 3);
  assert.deepStrictEqual(w.hours, []);
  assert.strictEqual(w.feels, null);
  assert.strictEqual(w.sunrise, '');
});

const ics = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'SUMMARY:Gym', 'DTSTART:20261116T180000', 'DTEND:20261116T190000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261123', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Dinner', 'DTSTART:20261116T200000', 'DTEND:20261116T220000', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20261117T100000', 'END:VEVENT',
  'END:VCALENDAR',
].join('\n');

test('calendar: busy days count events, repeats and every day of a trip', () => {
  const b = calendar.busyDays(ics, new Date(2026, 10, 14).getTime());
  assert.strictEqual(b['2026-11-16'], 2, 'gym and dinner');
  assert.strictEqual(b['2026-11-23'], 1);
  assert.strictEqual(b['2026-11-30'], 1);
  assert.strictEqual(b['2026-11-20'], 1); assert.strictEqual(b['2026-11-21'], 1); assert.strictEqual(b['2026-11-22'], 1);
  assert.strictEqual(b['2026-11-23'] || 0, 1, 'the trip ends before the 23rd (only the gym)');
  assert.strictEqual(b['2026-11-17'], undefined, 'a cancelled event is not counted');
});

test('calendar: busy days start at the first of the month', () => {
  const b = calendar.busyDays('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:A\nDTSTART:20261102T100000\nDTEND:20261102T110000\nEND:VEVENT\nEND:VCALENDAR', new Date(2026, 10, 28).getTime());
  assert.strictEqual(b['2026-11-02'], 1);
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
