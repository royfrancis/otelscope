// The picker works in local time and the data spans the 25 Oct 2026 clock change, so these run in a DST time zone.
// It is set BEFORE the library loads (see aggregate.test.js for why this has to be a dynamic import).
process.env.TZ = 'Europe/Stockholm'

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  addDays, addMonths, addMonthsToDay, clampDay, dayKey, dayState, endOfDay, isDayDisabled, monthGrid, monthLabel, monthOf,
  moveDay, pickDay, sameMonth, startOfDay, weekdayLabels, windowOfDays,
} = await import('../docs/.vitepress/lib/calendar.js')

const at = (...args) => new Date(...args).getTime()
const keys = (week) => week.map((c) => c.key)

test('a day is found by its local midnight, also on the days the clocks change', () => {
  const longDay = at(2026, 9, 25) // 25 Oct 2026, clocks go back: 25 hours
  assert.equal(endOfDay(at(2026, 9, 25, 3)) - startOfDay(at(2026, 9, 25, 3)) + 1, 25 * 3600_000)
  assert.equal(startOfDay(at(2026, 9, 25, 23, 59)), longDay)
  assert.equal(addDays(longDay, 1), at(2026, 9, 26)) // not longDay + 24 h, which is still the 25th
  assert.equal(addDays(at(2026, 9, 26), -1), longDay)
  const shortDay = at(2026, 2, 29) // 29 Mar 2026, clocks go forward: 23 hours
  assert.equal(endOfDay(shortDay) - shortDay + 1, 23 * 3600_000)
  assert.equal(dayKey(endOfDay(shortDay)), '2026-03-29')
  assert.equal(dayKey(endOfDay(shortDay) + 1), '2026-03-30')
})

test('months are added by calendar, and a day the month does not have becomes its last', () => {
  assert.equal(dayKey(addMonthsToDay(at(2026, 2, 31), -1)), '2026-02-28')
  assert.equal(dayKey(addMonthsToDay(at(2028, 2, 31), -1)), '2028-02-29') // a leap year
  assert.equal(dayKey(addMonthsToDay(at(2026, 7, 31), 1)), '2026-09-30')
  assert.equal(dayKey(addMonthsToDay(at(2026, 0, 15), -6)), '2025-07-15') // across a year
  assert.deepEqual(addMonths({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 })
  assert.deepEqual(addMonths({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 })
  assert.deepEqual(addMonths({ year: 2026, month: 5 }, 14), { year: 2027, month: 7 })
  assert.equal(sameMonth(monthOf(at(2026, 9, 31, 23)), { year: 2026, month: 9 }), true)
})

test('the grid starts on Monday: whole weeks, from the week of the 1st to the week of the last day', () => {
  const oct = monthGrid({ year: 2026, month: 9 }) // 1 Oct 2026 is a Thursday
  assert.equal(oct.length, 5)
  assert.ok(oct.every((w) => w.length === 7))
  assert.deepEqual(keys(oct[0]), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  assert.deepEqual(oct[0].map((c) => c.inMonth), [false, false, false, true, true, true, true])
  assert.equal(oct.at(-1).at(-1).key, '2026-11-01') // 31 Oct is a Saturday, so the last week ends on a Sunday in November
  // 25 Oct (the 25-hour day) has its own cell and the days around it are not shifted
  assert.deepEqual(oct[3].map((c) => c.day), [19, 20, 21, 22, 23, 24, 25])
  const flat = oct.flat()
  assert.equal(new Set(flat.map((c) => c.key)).size, flat.length) // every day exactly once, so no day appears twice at a clock change
})

test('the grid can start on Sunday, and has 6 rows for a month that needs them, and 4 for a short February', () => {
  const sun = monthGrid({ year: 2026, month: 9 }, 0)
  assert.equal(sun[0][0].key, '2026-09-27')
  assert.deepEqual(weekdayLabels(1), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  assert.deepEqual(weekdayLabels(0).slice(0, 2), ['Sun', 'Mon'])
  assert.equal(monthGrid({ year: 2027, month: 4 }).length, 6) // May 2027: starts on a Saturday, 31 days
  assert.equal(monthGrid({ year: 2027, month: 1 }).length, 4) // Feb 2027: starts on a Monday, 28 days
  assert.equal(monthLabel({ year: 2026, month: 9 }), 'October 2026')
})

test('clicking picks a first day, then a last one, whichever side of the first it is on', () => {
  const [a, b, c] = [at(2026, 9, 20), at(2026, 9, 22), at(2026, 9, 24)]
  const one = pickDay({ fromMs: null, toMs: null }, at(2026, 9, 22, 15)) // any time of the day is the day
  assert.deepEqual(one, { fromMs: b, toMs: null })
  assert.deepEqual(pickDay(one, c), { fromMs: b, toMs: c })
  assert.deepEqual(pickDay(one, a), { fromMs: a, toMs: b }) // earlier: the two swap
  assert.deepEqual(pickDay(one, b), { fromMs: b, toMs: b }) // the same day twice is a one-day range
  assert.deepEqual(pickDay({ fromMs: a, toMs: c }, b), { fromMs: b, toMs: null }) // a complete range: start again
  assert.deepEqual(pickDay(undefined, a), { fromMs: a, toMs: null })
})

test('days outside the data cannot be picked, by day, so the whole of a boundary day can', () => {
  const [min, max] = [at(2026, 9, 20, 14), at(2026, 9, 26, 9)]
  assert.equal(isDayDisabled(at(2026, 9, 19, 23, 59), min, max), true)
  assert.equal(isDayDisabled(at(2026, 9, 20, 0, 0), min, max), false) // before the first datapoint, but the same day
  assert.equal(isDayDisabled(at(2026, 9, 26, 23, 59), min, max), false)
  assert.equal(isDayDisabled(at(2026, 9, 27), min, max), true)
  assert.equal(isDayDisabled(at(1999, 0, 1), null, null), false) // no bounds
  assert.equal(clampDay(at(2026, 9, 1, 8), min, max), startOfDay(min))
  assert.equal(clampDay(at(2026, 11, 1), min, max), startOfDay(max))
  assert.equal(clampDay(at(2026, 9, 22, 8), min, max), at(2026, 9, 22))
})

test('how a day is drawn: the two ends, the days between, and a preview while the last is not chosen', () => {
  const d = (n) => at(2026, 9, n)
  const done = { fromMs: d(20), toMs: d(24) }
  assert.deepEqual(dayState(d(20), done), { isFrom: true, isTo: false, inRange: false })
  assert.deepEqual(dayState(d(22), done), { isFrom: false, isTo: false, inRange: true })
  assert.deepEqual(dayState(d(24), done), { isFrom: false, isTo: true, inRange: false })
  assert.equal(dayState(d(25), done).inRange, false)
  const half = { fromMs: d(20), toMs: null }
  assert.equal(dayState(d(22), half, d(24)).inRange, true) // hovering later previews the range
  assert.equal(dayState(d(22), half, d(21)).inRange, false)
  assert.equal(dayState(d(19), half, d(18)).inRange, true) // hovering earlier previews the 18th to the 20th
  assert.equal(dayState(d(18), half, d(18)).inRange, false) // the hovered end itself is not "between"
  assert.equal(dayState(d(21), half, d(18)).inRange, false)
  assert.equal(dayState(d(22), half).inRange, false) // no hover, no preview
  assert.deepEqual(dayState(d(22), { fromMs: null, toMs: null }), { isFrom: false, isTo: false, inRange: false })
})

test('arrow keys move the focus by day, week and month, and other keys are left alone', () => {
  const d = at(2026, 9, 25) // a Sunday
  assert.equal(dayKey(moveDay(d, 'ArrowRight')), '2026-10-26')
  assert.equal(dayKey(moveDay(d, 'ArrowLeft')), '2026-10-24')
  assert.equal(dayKey(moveDay(d, 'ArrowDown')), '2026-11-01')
  assert.equal(dayKey(moveDay(d, 'ArrowUp')), '2026-10-18')
  assert.equal(dayKey(moveDay(d, 'Home')), '2026-10-19') // Monday of that week
  assert.equal(dayKey(moveDay(d, 'End')), '2026-10-25') // already the Sunday
  assert.equal(dayKey(moveDay(at(2026, 9, 21), 'End')), '2026-10-25')
  assert.equal(dayKey(moveDay(d, 'PageUp')), '2026-09-25')
  assert.equal(dayKey(moveDay(at(2026, 0, 31), 'PageDown')), '2026-02-28')
  assert.equal(moveDay(d, 'a'), null)
  assert.equal(moveDay(d, 'Enter'), null)
})

test('a picked range stands for the start of its first day to the end of its last, so the last day is whole', () => {
  const w = windowOfDays({ fromMs: at(2026, 9, 24), toMs: at(2026, 9, 25) })
  assert.equal(w.startMs, at(2026, 9, 24))
  assert.equal(w.endMs, at(2026, 9, 26) - 1)
  assert.equal(w.endMs - w.startMs + 1, (24 + 25) * 3600_000) // across the 25-hour day
  const one = windowOfDays({ fromMs: at(2026, 9, 24), toMs: null })
  assert.equal(one.endMs, at(2026, 9, 25) - 1)
})
