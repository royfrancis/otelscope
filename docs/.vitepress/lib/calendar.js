// Pure date logic for the calendar that picks a "from" and a "to" day. Everything is local wall-clock time, and a day is
// always identified by the millisecond its local midnight starts: a day is 23 or 25 hours long when the clocks change, so
// it is never found by adding 24 hours. No Vue or DOM here, so node --test can run it (in any time zone).

const pad = (n) => String(n).padStart(2, '0')

/** "2026-10-25": the key of the local day containing `ms`. */
export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const startOfDay = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The last millisecond of the local day containing `ms`. */
export const endOfDay = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1
}

/** The local midnight `n` calendar days after the one containing `ms` (n may be negative). */
export const addDays = (ms, n) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime()
}

/** The same day of the month `n` months on, or the last day of that month when it has no such day (31 Mar + 1 -> 30 Apr). */
export const addMonthsToDay = (ms, n) => {
  const d = new Date(ms)
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate()
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)).getTime()
}

/** A month as { year, month } (month 0-11). */
export const monthOf = (ms) => {
  const d = new Date(ms)
  return { year: d.getFullYear(), month: d.getMonth() }
}
export const addMonths = ({ year, month }, n) => {
  const d = new Date(year, month + n, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}
export const sameMonth = (a, b) => a.year === b.year && a.month === b.month
export const monthStart = ({ year, month }) => new Date(year, month, 1).getTime()

/**
 * The weeks of a month as rows of 7 cells, from the week containing the 1st to the one containing the last day.
 * `weekStart` is the first day of the week (0 Sunday ... 6 Saturday; 1 Monday is the default).
 * A cell is { ms, day, key, inMonth }.
 */
export function monthGrid({ year, month }, weekStart = 1) {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() - weekStart + 7) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const weeks = Math.ceil((lead + days) / 7)
  const rows = []
  for (let w = 0; w < weeks; w++) {
    rows.push(
      Array.from({ length: 7 }, (_, c) => {
        const d = new Date(year, month, 1 - lead + w * 7 + c)
        return { ms: d.getTime(), day: d.getDate(), key: dayKey(d.getTime()), inMonth: d.getMonth() === month }
      }),
    )
  }
  return rows
}

/** Short weekday names, in the order the grid shows them. */
export function weekdayLabels(weekStart = 1, locale = 'en-GB') {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + ((weekStart + i) % 7)))) // 1 Jan 2023 was a Sunday
}

export const monthLabel = ({ year, month }, locale = 'en-GB') =>
  new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(year, month, 1))

/**
 * What a click on `dayMs` does to the selection { fromMs, toMs } (both local midnights, toMs null while only the first
 * day is chosen). The first click starts a range; the second ends it, whichever side of the first it falls; a click
 * after a complete range starts a new one.
 */
export function pickDay(selection, dayMs) {
  const day = startOfDay(dayMs)
  const { fromMs, toMs } = selection ?? {}
  if (fromMs == null || toMs != null) return { fromMs: day, toMs: null }
  return day < fromMs ? { fromMs: day, toMs: fromMs } : { fromMs, toMs: day }
}

/** A day outside [minMs, maxMs] (compared by day) cannot be picked. Either bound may be left out. */
export function isDayDisabled(dayMs, minMs, maxMs) {
  const day = startOfDay(dayMs)
  return (minMs != null && day < startOfDay(minMs)) || (maxMs != null && day > startOfDay(maxMs))
}

/** How the day is drawn: the ends of the range, and the days between. `hoverMs` previews the end while only the first is chosen. */
export function dayState(dayMs, { fromMs, toMs }, hoverMs = null) {
  const day = startOfDay(dayMs)
  const end = toMs ?? (fromMs != null && hoverMs != null ? Math.max(startOfDay(hoverMs), fromMs) : null)
  const start = toMs == null && fromMs != null && hoverMs != null && startOfDay(hoverMs) < fromMs ? startOfDay(hoverMs) : fromMs
  return {
    isFrom: fromMs != null && day === fromMs,
    isTo: toMs != null && day === toMs,
    inRange: start != null && end != null && day > start && day < end,
  }
}

/** The day an arrow key moves the focus to, or null for a key that does not move it. */
export function moveDay(dayMs, key, weekStart = 1) {
  const d = new Date(dayMs)
  switch (key) {
    case 'ArrowLeft': return addDays(dayMs, -1)
    case 'ArrowRight': return addDays(dayMs, 1)
    case 'ArrowUp': return addDays(dayMs, -7)
    case 'ArrowDown': return addDays(dayMs, 7)
    case 'Home': return addDays(dayMs, -((d.getDay() - weekStart + 7) % 7))
    case 'End': return addDays(dayMs, 6 - ((d.getDay() - weekStart + 7) % 7))
    case 'PageUp': return addMonthsToDay(dayMs, -1)
    case 'PageDown': return addMonthsToDay(dayMs, 1)
    default: return null
  }
}

export const clampDay = (dayMs, minMs, maxMs) => {
  let day = startOfDay(dayMs)
  if (minMs != null) day = Math.max(day, startOfDay(minMs))
  if (maxMs != null) day = Math.min(day, startOfDay(maxMs))
  return day
}

/** The window a picked range stands for: from the start of the first day to the end of the last one. */
export const windowOfDays = ({ fromMs, toMs }) => ({ startMs: startOfDay(fromMs), endMs: endOfDay(toMs ?? fromMs) })
