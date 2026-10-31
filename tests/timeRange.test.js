process.env.TZ = 'Europe/Stockholm' // before the import below, as in aggregate.test.js

import test from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_PRESET_KEY, PRESETS, describeWindow, presetByKey, presetWindow } = await import('../docs/.vitepress/lib/timeRange.js')

const at = (...args) => new Date(...args).getTime()
const win = (key, now, extent = { minMs: 0, dataMaxMs: 1 }) => presetWindow(presetByKey(key), now, extent)
const HOUR = 3600_000

test('the presets are 24hr, 1week, 1month, 6months and All, in that order', () => {
  assert.deepEqual(PRESETS.map((p) => p.label), ['24hr', '1week', '1month', '6months', 'All'])
  assert.equal(new Set(PRESETS.map((p) => p.key)).size, PRESETS.length)
  assert.ok(PRESETS.every((p) => p.title)) // each says in words what it is
})

test('the chart opens on the last 24 hours, which is one of the presets', () => {
  assert.equal(DEFAULT_PRESET_KEY, '24h')
  assert.equal(presetByKey(DEFAULT_PRESET_KEY).label, '24hr')
})

test('24hr is 24 hours up to now', () => {
  const now = at(2026, 9, 28, 14, 30)
  assert.deepEqual(win('24h', now), { startMs: now - 24 * HOUR, endMs: now })
})

test('24hr is 24 hours, but 1week is seven days of the clock, so it keeps the time of day over a clock change', () => {
  const now = at(2026, 9, 28, 9, 15) // three days after the clocks went back on 25 Oct
  assert.equal(win('24h', now).startMs, now - 24 * HOUR)
  assert.equal(win('1w', now).startMs, at(2026, 9, 21, 9, 15)) // 21 Oct 09:15, though that is 7 days + 1 hour earlier
  assert.equal(now - win('1w', now).startMs, 7 * 24 * HOUR + HOUR)
  const spring = at(2026, 2, 31, 9, 15) // after the 29 Mar clocks-forward
  assert.equal(win('1w', spring).startMs, at(2026, 2, 24, 9, 15))
})

test('1month and 6months go back by calendar month, keeping the day and the time', () => {
  assert.equal(win('1mo', at(2026, 9, 28, 14, 30)).startMs, at(2026, 8, 28, 14, 30))
  assert.equal(win('6mo', at(2026, 9, 28, 14, 30)).startMs, at(2026, 3, 28, 14, 30))
  assert.equal(win('1mo', at(2026, 2, 31, 8, 0)).startMs, at(2026, 1, 28, 8, 0)) // 31 Mar -> 28 Feb, not 3 Mar
  assert.equal(win('1mo', at(2028, 2, 31, 8, 0)).startMs, at(2028, 1, 29, 8, 0))
  assert.equal(win('6mo', at(2026, 0, 15, 12)).startMs, at(2025, 6, 15, 12)) // across a year
})

test('every window ends at now, except All, which is the data', () => {
  const now = at(2026, 9, 28, 14)
  for (const p of PRESETS.filter((x) => !x.all)) assert.equal(presetWindow(p, now, { minMs: 1, dataMaxMs: 2 }).endMs, now, p.key)
  assert.deepEqual(win('all', now, { minMs: 100, dataMaxMs: 900 }), { startMs: 100, endMs: 900 })
})

test('a window is described in words, with the dates only once when it is inside one day', () => {
  assert.equal(describeWindow(at(2026, 9, 30, 14, 5), at(2026, 9, 30, 14, 20)), '30 Oct 2026, 14:05 – 14:20')
  assert.equal(describeWindow(at(2026, 9, 28, 9, 0), at(2026, 9, 30, 14, 20)), '28 Oct 2026, 09:00 – 30 Oct 2026, 14:20')
  assert.equal(describeWindow(at(2026, 9, 24, 0, 0), at(2026, 9, 26) - 1), '24 Oct 2026, 00:00 – 25 Oct 2026, 23:59')
})
