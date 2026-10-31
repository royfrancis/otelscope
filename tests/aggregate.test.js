// The data spans the 25 Oct 2026 DST change, so bucketing is tested in a DST timezone. It is set BEFORE the library is
// loaded (hence the dynamic import below): static imports run first, and aggregate.js builds its date formatters, in
// the timezone of that moment, when it loads. Setting it afterward only passes on a machine already in that timezone.
process.env.TZ = 'Europe/Stockholm'

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  GROUP_COL, STEPS, TYPE_ORDER, pickStep, bucketStart, rankByTotal, rankEntities, makeGrouper, describeSlots, filterRows,
  aggregate, barWidthPx, formatCompact, formatDuration, formatMetricAxis, formatMetricValue, bucketLabel, sessionLabel, formatStep,
} = await import('../docs/.vitepress/lib/aggregate.js')

const local = (...args) => new Date(...args).getTime() / 1000

test('pickStep chooses the smallest bucket that keeps the view at or under 90 bars', () => {
  assert.equal(pickStep(3600), 60) // 1 hour -> 1 minute
  assert.equal(pickStep(86400), 1800) // 1 day -> 30 minutes
  assert.equal(pickStep(13 * 86400), 21600) // the full 13 days -> 6 hours
  assert.equal(pickStep(10 * 365 * 86400), STEPS.at(-1)) // never goes coarser than a day
})

test('bucketStart aligns day buckets to local midnight, including on the DST day', () => {
  const midnight = local(2026, 9, 25) // 25 Oct 2026: clocks go back, a 25-hour day
  assert.equal(bucketStart(local(2026, 9, 25, 0, 30), 86400), midnight)
  assert.equal(bucketStart(local(2026, 9, 25, 23, 30), 86400), midnight)
  assert.equal(bucketStart(local(2026, 9, 26, 0, 5), 86400), local(2026, 9, 26))
})

test('bucketStart aligns hour and minute buckets to the local clock', () => {
  assert.equal(bucketStart(local(2026, 9, 25, 5, 59), 21600), local(2026, 9, 25, 0)) // 6h
  assert.equal(bucketStart(local(2026, 9, 25, 6, 0), 21600), local(2026, 9, 25, 6))
  assert.equal(bucketStart(local(2026, 9, 20, 14, 47, 30), 3600), local(2026, 9, 20, 14)) // 1h
  assert.equal(bucketStart(local(2026, 9, 20, 14, 47, 30), 900), local(2026, 9, 20, 14, 45)) // 15m
  assert.equal(bucketStart(local(2026, 9, 20, 14, 47, 30), 60), local(2026, 9, 20, 14, 47)) // 1m
})

test('a row is the time, the value, then one dictionary index per field', () => {
  assert.equal(GROUP_COL, 2)
})

test('rankByTotal orders by total, largest first, ties by dictionary order', () => {
  const rows = [[0, 5, 2], [0, 9, 0], [0, 5, 1], [0, 1, 0]]
  assert.deepEqual(rankByTotal(rows, 2, 4), [0, 1, 2, 3]) // 0:10, 1:5, 2:5 (tie -> lower idx first), 3:0
})

test('rankEntities ranks by size, but puts the names of token and line types first, in their fixed order', () => {
  // dictionary: cacheRead is by far the biggest, but "input" is the first color in every dataset that has it
  const values = ['cacheRead', 'output', 'input', 'zzz']
  const rows = [[0, 900, 0], [0, 40, 1], [0, 10, 2], [0, 500, 3]]
  assert.deepEqual(rankEntities(rows, 2, values), [2, 1, 0, 3]) // input, output, cacheRead, then the rest by size
  assert.deepEqual(TYPE_ORDER.slice(0, 2), ['input', 'output'])
  // a field with none of those names is ranked by size alone
  assert.deepEqual(rankEntities([[0, 1, 0], [0, 7, 1]], 2, ['sonnet', 'opus']), [1, 0])
  assert.deepEqual(rankEntities([], 2, []), [])
})

test('makeGrouper keeps seven named slots and folds the rest into one Other slot', () => {
  const ranking = [4, 2, 0, 9, 1, 3, 5, 6, 7, 8] // 10 entities
  const g = makeGrouper(ranking)
  assert.equal(g.hasOther, true)
  assert.equal(g.named, 7)
  assert.deepEqual([4, 2, 0, 9, 1, 3, 5].map((d) => g.slotOfDict[d]), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual([6, 7, 8].map((d) => g.slotOfDict[d]), [7, 7, 7])
})

test('makeGrouper names all entities when there are at most eight', () => {
  const g = makeGrouper([0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(g.hasOther, false)
  assert.equal(g.slotOfDict[7], 7)
})

test('slot colors follow the entity, not the filter: the same ranking gives the same slot', () => {
  const g = makeGrouper([3, 1, 0, 2])
  const labels = ['a', 'b', 'c', 'd']
  const all = describeSlots(g, labels, new Set([0, 1, 2, 3]))
  const onlyB = describeSlots(g, labels, new Set([1]))
  assert.equal(all.find((s) => s.name === 'b').slot, onlyB[0].slot)
})

test('describeSlots labels the folded group, or names a lone folded entity', () => {
  const g = makeGrouper(Array.from({ length: 12 }, (_, i) => i)) // dict idx 7..11 are folded
  const labels = Array.from({ length: 12 }, (_, i) => `e${i}`)
  const many = describeSlots(g, labels, new Set([0, 8, 9, 10]))
  assert.deepEqual(many.map((s) => s.name), ['e0', 'Other (3)'])
  assert.equal(many.at(-1).other, true)
  const lone = describeSlots(g, labels, new Set([9]))
  assert.deepEqual(lone, [{ slot: 7, name: 'e9', other: true }])
})

test('filterRows filters by session, and returns every row when none is chosen', () => {
  const rows = [[0, 1, 0, 0, 0], [0, 1, 1, 0, 1], [0, 1, 1, 0, 0]] // the session is in column 4 here
  assert.equal(filterRows(rows).length, 3)
  assert.equal(filterRows(rows, { sessionIdx: 0, sessionCol: 4 }).length, 2)
  assert.equal(filterRows(rows, { sessionIdx: 1, sessionCol: 4 }).length, 1)
  assert.equal(filterRows(rows, { sessionIdx: 1 }).length, 3) // a tool with no session field has nothing to filter by
})

test('aggregate buckets sparsely and zero-fills so every series shares one bucket list', () => {
  const t0 = local(2026, 9, 20, 10, 0)
  const rows = [
    [t0 + 10, 5, 0], // slot 0, bucket 10:00
    [t0 + 50, 3, 0], // slot 0, same minute
    [t0 + 70, 2, 1], // slot 1, bucket 10:01
    [t0 + 3600 * 5, 7, 0], // slot 0, five hours later: the gap in between gets no buckets
  ]
  const out = aggregate(rows, {
    stepS: 60,
    col: 2,
    slotOfDict: [0, 1],
    slots: [{ slot: 0 }, { slot: 1 }],
  })
  assert.deepEqual(out.starts, [t0, t0 + 60, t0 + 3600 * 5])
  assert.deepEqual(out.values, [[8, 0, 7], [0, 2, 0]])
})

test('aggregate can split every segment by model, and each split adds up to its bar', () => {
  const t0 = local(2026, 9, 20, 10, 0)
  // row: [t, value, group, model]; models: 0 sonnet, 1 opus, 2 (none)
  const rows = [
    [t0 + 5, 100, 0, 0],
    [t0 + 6, 300, 0, 1],
    [t0 + 7, 50, 0, 2], // no model recorded: counts toward the bar, is not named in the split
    [t0 + 8, 25, 0, 0],
    [t0 + 9, 9, 1, 1], // other group, same bucket
    [t0 + 3600, 4, 0, 0], // later bucket
  ]
  const base = { stepS: 3600, col: 2, slotOfDict: [0, 1], slots: [{ slot: 0 }, { slot: 1 }] }
  const out = aggregate(rows, { ...base, detail: { col: 3, labels: ['sonnet', 'opus', '(none)'] } })

  assert.deepEqual(out.values, [[475, 4], [9, 0]])
  assert.deepEqual(out.detail[0][0], [['opus', 300], ['sonnet', 125]]) // largest first; (none) left out
  assert.deepEqual(out.detail[1][0], [['opus', 9]])
  assert.deepEqual(out.detail[0][1], [['sonnet', 4]])
  assert.deepEqual(out.detail[1][1], []) // an empty segment has no models

  // with every model named, each segment's split adds up to the bar value
  const named = aggregate(rows.filter((r) => r[3] !== 2), { ...base, detail: { col: 3, labels: ['sonnet', 'opus', '(none)'] } })
  named.values.forEach((series, i) =>
    series.forEach((v, j) => assert.equal(named.detail[i][j].reduce((a, [, x]) => a + x, 0), v)),
  )

  // not asked for: no split is computed
  assert.equal(aggregate(rows, base).detail, null)
})

test('with no color field everything is one series, whatever the rows hold', () => {
  const t0 = local(2026, 9, 20, 10, 0)
  const out = aggregate([[t0, 4, 7], [t0 + 1, 6, 9], [t0 + 7200, 1]], { stepS: 3600, col: -1, slotOfDict: [], slots: [{ slot: 0 }] })
  assert.deepEqual(out.values, [[10, 1]])
})

test('barWidthPx is 80% of the slot, clamped to 2..24 px', () => {
  assert.equal(barWidthPx(3600, 0.01), 24) // 36px slot -> 28px, capped at 24
  assert.equal(barWidthPx(60, 0.1), 4) // 6px slot -> 4
  assert.equal(barWidthPx(60, 0.001), 2) // sub-pixel slot -> never below 2
  assert.equal(barWidthPx(60, NaN), 2)
})

test('formatters', () => {
  assert.equal(formatCompact(999), '999')
  assert.equal(formatCompact(1500), '1.5K')
  assert.equal(formatCompact(2_000_000), '2M')
  assert.equal(formatCompact(555_000_000), '555M')
  assert.equal(formatMetricAxis('usd', 0.5), '$0.50')
  assert.equal(formatMetricAxis('usd', 2), '$2')
  assert.equal(formatMetricAxis('usd', 1500), '$1.5K')
  assert.equal(formatMetricAxis('number', 3000), '3K')
  assert.equal(formatMetricValue('usd', 12.345), '$12.35')
  assert.equal(formatMetricValue('number', 1234567.4), '1,234,567')
  assert.equal(sessionLabel({ id: 'e38d1240-a962', repo: 'ggtargets' }), 'e38d1240 · ggtargets')
  assert.equal(sessionLabel({ id: 'e38d1240-a962', repo: '' }), 'e38d1240')
})

test('formatStep names every bucket size', () => {
  assert.deepEqual(STEPS.map(formatStep), ['1 min', '5 min', '15 min', '30 min', '1 hour', '3 hours', '6 hours', '12 hours', '1 day'])
})

test('bucketLabel shows a date for day buckets and a time range otherwise', () => {
  assert.match(bucketLabel(local(2026, 9, 26), 86400), /26 Oct 2026/)
  assert.match(bucketLabel(local(2026, 9, 26, 14), 3600), /26 Oct, 14:00 – 15:00/)
})

test('durations are told in the unit that reads well, on an axis and in full', () => {
  assert.equal(formatMetricAxis('seconds', 45), '45s')
  assert.equal(formatMetricAxis('seconds', 90), '1.5m')
  assert.equal(formatMetricAxis('seconds', 5400), '1.5h')
  assert.equal(formatMetricAxis('ms', 2500), '2.5s') // milliseconds are converted first
  assert.equal(formatDuration(12.34), '12.3s')
  assert.equal(formatDuration(185), '3m 05s')
  assert.equal(formatDuration(3725), '1h 02m')
  assert.equal(formatMetricValue('seconds', 61), '1m 01s')
  assert.equal(formatMetricValue('ms', 90_000), '1m 30s')
})
