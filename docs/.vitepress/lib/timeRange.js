// Pure logic for the "Time range" control of the usage chart: the presets, and what window each one stands for.
// Local wall-clock time throughout, so "1week" is the same time of day seven days ago even across a clock change.
import { addDays, addMonthsToDay } from './calendar.js'

const MINUTE = 60_000

/**
 * The preset buttons, in the order they are shown. A window ends at "now" and reaches back by `minutes`, `days` or
 * `months`; "all" is the whole extent of the data. `title` is what the button says when hovered or read aloud.
 */
export const PRESETS = [
  { key: '24h', label: '24hr', title: 'Last 24 hours', minutes: 24 * 60 },
  { key: '1w', label: '1week', title: 'Last week', days: 7 },
  { key: '1mo', label: '1month', title: 'Last month', months: 1 },
  { key: '6mo', label: '6months', title: 'Last 6 months', months: 6 },
  { key: 'all', label: 'All', title: 'All the data', all: true },
]

/** The preset the usage chart opens on. */
export const DEFAULT_PRESET_KEY = '24h'

/** Goes back `n` calendar days / months from `ms`, keeping the time of day. */
function wallClockBack(ms, { days = 0, months = 0 }) {
  const d = new Date(ms)
  const day = new Date(months ? addMonthsToDay(ms, -months) : addDays(ms, -days))
  // the clock reading is rebuilt on the target day rather than found by subtracting milliseconds, so it survives a 23 or 25 hour day
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime()
}

/**
 * The window a preset stands for, as { startMs, endMs }: it ends at `nowMs` and starts the preset's span earlier, or is
 * the data's own extent ({ minMs, dataMaxMs }) for "all". Not clamped: the caller fits it to the chart's axis.
 */
export function presetWindow(preset, nowMs, extent) {
  if (preset.all) return { startMs: extent.minMs, endMs: extent.dataMaxMs }
  if (preset.minutes) return { startMs: nowMs - preset.minutes * MINUTE, endMs: nowMs }
  return { startMs: wallClockBack(nowMs, preset), endMs: nowMs }
}

export const presetByKey = (key) => PRESETS.find((p) => p.key === key)

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const dayPart = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const clockPart = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/** "30 Oct 2026, 14:05 – 14:20" when the window is inside one day, else "28 Oct 2026, 09:00 – 30 Oct 2026, 14:20". */
export function describeWindow(startMs, endMs) {
  const [a, b] = [new Date(startMs), new Date(endMs)]
  const at = (d) => `${dayPart.format(d)}, ${clockPart.format(d)}`
  return sameDay(a, b) ? `${at(a)} – ${clockPart.format(b)}` : `${at(a)} – ${at(b)}`
}
