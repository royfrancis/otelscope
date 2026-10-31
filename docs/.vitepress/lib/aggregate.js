// Pure logic for the usage chart: bucketing, grouping, filtering and formatting.
// No Vue or DOM here, so it can be unit-tested with `node --test`.

// What prepare-data.mjs stores for a datapoint that lacks the attribute.
export const UNKNOWN = '(none)'

// A datapoint row is [timeSeconds, value, ...one dictionary index per field]. Which fields there are (and which is the
// session, which the model) is in the data file, so nothing here knows a tool's attribute names.
export const GROUP_COL = 2

// The values that name a kind of token or of lines get the same colors in every dataset, in this order, ahead of
// everything else, so "input" is always the first color. This is only ever a preference: a field without them is ranked by size.
export const TYPE_ORDER = ['input', 'output', 'cacheRead', 'cacheCreation', 'added', 'removed']

// At most this many named series, then "Other". Matches the 8 slots of the categorical palette.
export const MAX_NAMED = 7

// Bucket sizes in seconds: 1m 5m 15m 30m 1h 3h 6h 12h 1d.
export const STEPS = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400]
export const MAX_BARS = 90

/** Smallest bucket size that keeps the visible span at or under `maxBars` bars. */
export function pickStep(spanS, maxBars = MAX_BARS, steps = STEPS) {
  for (const s of steps) if (spanS / s <= maxBars) return s
  return steps[steps.length - 1]
}

/**
 * Start (epoch seconds) of the bucket containing `tS`, aligned to local wall-clock time so that
 * day and hour buckets line up with the viewer's clock, including across a DST change.
 */
export function bucketStart(tS, stepS) {
  const d = new Date(tS * 1000)
  const [y, mo, day] = [d.getFullYear(), d.getMonth(), d.getDate()]
  if (stepS >= 86400) return new Date(y, mo, day).getTime() / 1000
  if (stepS >= 3600) {
    const hours = stepS / 3600
    return new Date(y, mo, day, Math.floor(d.getHours() / hours) * hours).getTime() / 1000
  }
  const minutes = stepS / 60
  return new Date(y, mo, day, d.getHours(), Math.floor(d.getMinutes() / minutes) * minutes).getTime() / 1000
}

/**
 * The order colors are given in for one field: by total value, largest first, except that the values named in TYPE_ORDER
 * come first, in that order. `values` is the field's dictionary.
 */
export function rankEntities(rows, col, values) {
  const bySize = rankByTotal(rows, col, values.length)
  const typeRank = (idx) => TYPE_ORDER.indexOf(values[idx])
  const typed = bySize.filter((idx) => typeRank(idx) >= 0).sort((a, b) => typeRank(a) - typeRank(b))
  return typed.length ? [...typed, ...bySize.filter((idx) => typeRank(idx) < 0)] : bySize
}

/** Dictionary indices ordered by total value, largest first (ties keep dictionary order). */
export function rankByTotal(rows, col, dictLen) {
  const totals = new Array(dictLen).fill(0)
  for (const r of rows) totals[r[col]] += r[1]
  return totals
    .map((total, idx) => ({ total, idx }))
    .sort((a, b) => b.total - a.total || a.idx - b.idx)
    .map((x) => x.idx)
}

/**
 * Maps dictionary indices to color slots from a fixed ranking, so an entity keeps its color
 * whatever metric, filter or zoom is active. Entities beyond `maxNamed` share one "Other" slot.
 */
export function makeGrouper(ranking, maxNamed = MAX_NAMED) {
  const hasOther = ranking.length > maxNamed + 1
  const named = hasOther ? maxNamed : ranking.length
  const slotOfDict = []
  ranking.forEach((dictIdx, rank) => {
    slotOfDict[dictIdx] = rank < named ? rank : named
  })
  return { slotOfDict, named, hasOther }
}

/** The series to draw for the entities present in the filtered rows, in stack order. */
export function describeSlots(grouper, labels, present) {
  const bySlot = new Map()
  const folded = []
  for (const dictIdx of present) {
    const slot = grouper.slotOfDict[dictIdx]
    if (grouper.hasOther && slot === grouper.named) folded.push(dictIdx)
    else bySlot.set(slot, dictIdx)
  }
  const slots = [...bySlot.keys()]
    .sort((a, b) => a - b)
    .map((slot) => ({ slot, name: labels[bySlot.get(slot)], other: false }))
  if (folded.length === 1) slots.push({ slot: grouper.named, name: labels[folded[0]], other: true })
  else if (folded.length > 1) slots.push({ slot: grouper.named, name: `Other (${folded.length})`, other: true })
  return slots
}

/** The rows of one session (`sessionCol` is the column that holds the session), or all of them when none is chosen. */
export function filterRows(rows, { sessionIdx = null, sessionCol = -1 } = {}) {
  return sessionIdx == null || sessionCol < 0 ? rows : rows.filter((r) => r[sessionCol] === sessionIdx)
}

export function presentDict(rows, col) {
  const out = new Set()
  for (const r of rows) out.add(r[col])
  return out
}

export const sumRows = (rows) => rows.reduce((a, r) => a + r[1], 0)

const bump = (map, key, by) => map.set(key, (map.get(key) ?? 0) + by)
const child = (map, key) => map.get(key) ?? map.set(key, new Map()).get(key)

/** `[[label, value], ...]`, largest first, leaving out entries whose attribute was not recorded. */
function breakdown(byIdx, labels) {
  if (!byIdx) return []
  return [...byIdx]
    .map(([idx, value]) => [labels[idx], value])
    .filter(([label]) => label !== UNKNOWN)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/**
 * Sparse aggregation: only buckets that contain data, each series zero-filled so every series has
 * the same bucket list in the same order. `values[i][j]` is slot `slots[i].slot` in bucket `starts[j]`.
 *
 * With `detail: { col, labels }` it also splits every bar segment by another field (the model):
 * `detail[i][j]` is `[[label, value], ...]` for that segment. Without it, `detail` is null.
 */
export function aggregate(rows, { stepS, col, slotOfDict, slots, detail = null }) {
  const acc = new Map()
  const parts = detail ? new Map() : null // bucket start -> slot -> detail dictionary index -> value
  for (const r of rows) {
    const start = bucketStart(r[0], stepS)
    const slot = col < 0 ? 0 : slotOfDict[r[col]] // no color field: one series
    bump(child(acc, start), slot, r[1])
    if (parts) bump(child(child(parts, start), slot), r[detail.col], r[1])
  }
  const starts = [...acc.keys()].sort((a, b) => a - b)
  const values = slots.map(({ slot }) => starts.map((s) => acc.get(s).get(slot) ?? 0))
  const split = parts
    ? slots.map(({ slot }) => starts.map((s) => breakdown(parts.get(s)?.get(slot), detail.labels)))
    : null
  return { starts, values, stepS, detail: split }
}

/** Bar thickness in px: 80% of the bucket's slot, never thinner than 2px or thicker than 24px. */
export function barWidthPx(stepS, pxPerSecond, min = 2, max = 24) {
  const w = Math.floor(stepS * pxPerSecond * 0.8)
  return Math.min(max, Math.max(min, Number.isFinite(w) ? w : min))
}

const STEP_LABELS = { 60: '1 min', 300: '5 min', 900: '15 min', 1800: '30 min', 3600: '1 hour', 10800: '3 hours', 21600: '6 hours', 43200: '12 hours', 86400: '1 day' }
export const formatStep = (stepS) => STEP_LABELS[stepS] ?? `${stepS} s`

export function sessionLabel(s) {
  return s.repo ? `${s.id.slice(0, 8)} · ${s.repo}` : s.id.slice(0, 8)
}

// --- formatting ---------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')

export function formatCompact(v) {
  const abs = Math.abs(v)
  for (const [limit, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (abs >= limit) return `${Number((v / limit).toFixed(1))}${suffix}`
  }
  return String(Number(v.toFixed(2)))
}

// A measure says how its values are written: 'usd' (dollars), 'seconds' or 'ms' (a duration), or 'number'.
function durationAxis(seconds) {
  if (seconds >= 3600) return `${Number((seconds / 3600).toFixed(1))}h`
  if (seconds >= 60) return `${Number((seconds / 60).toFixed(1))}m`
  return `${Number(seconds.toFixed(1))}s`
}

/** "1h 02m" or "3m 05s" or "12.3s": a duration in full, for a tooltip or a total. */
export function formatDuration(seconds) {
  const whole = Math.round(seconds)
  if (whole >= 3600) return `${Math.floor(whole / 3600)}h ${pad(Math.floor((whole % 3600) / 60))}m`
  if (whole >= 60) return `${Math.floor(whole / 60)}m ${pad(whole % 60)}s`
  return `${Number(seconds.toFixed(1))}s`
}

export function formatMetricAxis(format, v) {
  if (format === 'usd') return v >= 1000 ? `$${formatCompact(v)}` : `$${Number.isInteger(v) ? v : v.toFixed(2)}`
  if (format === 'seconds') return durationAxis(v)
  if (format === 'ms') return durationAxis(v / 1000)
  return formatCompact(v)
}

export function formatMetricValue(format, v) {
  if (format === 'usd') return `$${v.toFixed(v >= 100 ? 0 : 2)}`
  if (format === 'seconds') return formatDuration(v)
  if (format === 'ms') return formatDuration(v / 1000)
  return Math.round(v).toLocaleString('en-US')
}

/** Local "YYYY-MM-DD HH:mm:ss". */
export function formatDateTime(tS) {
  const d = new Date(tS * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const hourFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/** "Mon 26 Oct 2026" for day buckets, "Mon 26 Oct, 14:00 – 15:00" otherwise. */
export function bucketLabel(startS, stepS) {
  const start = new Date(startS * 1000)
  if (stepS >= 86400) return dayFmt.format(start)
  return `${hourFmt.format(start)} – ${clockFmt.format(new Date((startS + stepS) * 1000))}`
}
