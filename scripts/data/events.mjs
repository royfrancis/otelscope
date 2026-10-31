// Turns the log records and spans of ANY tool into rows for the Logs table. They are grouped by name (the event name of
// a log record, the name of a span) and each group is its own file, so the table loads one kind at a time: a busy tool
// has tens of thousands of rows in all, which no page should load at once. Which kinds there are is read from the logs.
import { createHash } from 'node:crypto'
import { attrsToObject, readRecords, toSeconds } from './read.mjs'

const CELL_MAX = 10_000 // a longer text is cut here (the prompts people write are well under this)
const clip = (v) => (typeof v === 'string' && v.length > CELL_MAX ? `${v.slice(0, CELL_MAX - 1)}…` : v)
const DISTINCT_CAP = 200 // counting distinct values of a column stops here: "many" is all that is asked
const MAX_DEFAULT_COLUMNS = 8

/** A group of rows is a file; its name is made from what the group is, so it is the same on every refresh. */
export const eventId = (kind, name) => createHash('sha1').update(`${kind}\0${name}`).digest('hex').slice(0, 10)

function addRow(groups, kind, name, row) {
  const key = `${kind}\0${name}`
  const group = groups.get(key) ?? groups.set(key, { kind, name, rows: [] }).get(key)
  group.rows.push(row)
}

// Attributes that describe the sender (the OTLP "resource": service, version, OS, user) are the same on every record, so they
// say little at a glance. They are remembered, to be left out of the columns shown first (the column menu still has them).
function putAttrs(row, resource, attrs, resourceKeys) {
  for (const k of Object.keys(resource)) resourceKeys.add(k)
  for (const source of [resource, attrs]) {
    for (const [k, v] of Object.entries(source)) {
      if (k === 'event.name' || v == null || v === '') continue
      row[k] = clip(v)
    }
  }
}

async function readLogRecords(dir, groups, resourceKeys) {
  for await (const rec of readRecords(dir, 'logs')) {
    for (const rl of rec.data?.resourceLogs ?? []) {
      const resource = attrsToObject(rl.resource?.attributes)
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = attrsToObject(lr.attributes)
          const body = lr.body?.stringValue
          const name = String(attrs['event.name'] ?? body ?? '(log record)')
          const row = { time: toSeconds(lr.timeUnixNano && lr.timeUnixNano !== '0' ? lr.timeUnixNano : lr.observedTimeUnixNano) }
          putAttrs(row, resource, attrs, resourceKeys)
          if (attrs['event.name'] != null && body && body !== name) row.body = clip(body) // the name was in the attributes, so the body says something else
          if (lr.severityText) row.severity = lr.severityText
          addRow(groups, 'log', name, row)
        }
      }
    }
  }
}

async function readSpans(dir, groups, resourceKeys) {
  const seen = new Set()
  for await (const rec of readRecords(dir, 'traces')) {
    for (const rs of rec.data?.resourceSpans ?? []) {
      const resource = attrsToObject(rs.resource?.attributes)
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          if (span.traceId && span.spanId) { // an export that was retried must not give a span twice
            const id = `${span.traceId}/${span.spanId}`
            if (seen.has(id)) continue
            seen.add(id)
          }
          const attrs = attrsToObject(span.attributes)
          const ms = (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6
          const row = { time: toSeconds(span.startTimeUnixNano) }
          if (Number.isFinite(ms)) row.duration_ms = Math.round(ms)
          putAttrs(row, resource, attrs, resourceKeys)
          if (span.traceId) row.trace_id = span.traceId
          if (span.spanId) row.span_id = span.spanId
          if (span.parentSpanId) row.parent_span_id = span.parentSpanId
          addRow(groups, 'span', String(span.name || '(span)'), row)
        }
      }
    }
  }
}

/** Every attribute name that any row of the groups has. */
export function attributeKeys(groups) {
  const keys = new Set()
  for (const { rows } of groups.values()) for (const row of rows) for (const k of Object.keys(row)) keys.add(k)
  return [...keys]
}

/** Every group of rows in the folder's logs and traces: { groups: Map of "kind\0name" -> { kind, name, rows }, resourceKeys }. */
export async function readEvents(dir) {
  const groups = new Map()
  const resourceKeys = new Set()
  await Promise.all([readLogRecords(dir, groups, resourceKeys), readSpans(dir, groups, resourceKeys)])
  return { groups, resourceKeys }
}

/** What each column of a group holds: how many rows have it, how many different values, how long its text is, whether it is a number. */
function profile(rows) {
  const stats = new Map()
  for (const row of rows) {
    for (const [field, v] of Object.entries(row)) {
      const s = stats.get(field) ?? stats.set(field, { count: 0, values: new Set(), chars: 0, text: 0, numbers: 0, bools: 0 }).get(field)
      s.count++
      if (s.values.size < DISTINCT_CAP) s.values.add(v)
      if (typeof v === 'string') {
        s.text++
        s.chars += v.length
      } else if (typeof v === 'number') s.numbers++
      else if (typeof v === 'boolean') s.bools++
    }
  }
  return stats
}

const idLike = (field) => /(^|[._-])(id|uuid|hash|sequence|seq)$/i.test(field) || /(^|[._-])(timestamp)$/i.test(field)

/**
 * Which columns to show first, worked out from what the rows hold, not from what the tool is called: the time, the session,
 * the longest text (a prompt, a response), the columns that tell kinds apart (a tool name, a model, success), and the numbers.
 * A column that is the same on every row, or is an identifier, says nothing at a glance, so it is left for the column menu.
 */
export function chooseColumns(rows, stats, sessionField, resourceKeys = new Set()) {
  const total = rows.length
  const own = ([f]) => f === sessionField || !resourceKeys.has(f)
  const usable = [...stats].filter(([f, s]) => f !== 'time' && s.count >= total * 0.5 && s.values.size > 1).filter(own)
  const isIdentifier = (f, s) => idLike(f) && s.values.size > Math.min(DISTINCT_CAP, total) * 0.5
  const candidates = usable.filter(([f, s]) => f === sessionField || !isIdentifier(f, s))
  const sameText = (a, b) => rows.slice(0, 50).every((r) => r[a] === r[b]) // a column that only repeats another adds nothing
  const text = []
  for (const c of candidates.filter(([f, s]) => s.text === s.count && s.chars / s.text > 30 && f !== sessionField).sort((a, b) => b[1].chars / b[1].text - a[1].chars / a[1].text)) {
    if (text.length < 2 && !text.some(([f]) => sameText(f, c[0]))) text.push(c)
  }
  // A column that never changes within a session (the app version, the terminal) describes the session, not the event.
  const sessionConstant = (f) => {
    if (!sessionField) return false
    const firstSeen = new Map()
    for (const r of rows) {
      if (r[sessionField] == null || r[f] === undefined) continue
      if (!firstSeen.has(r[sessionField])) firstSeen.set(r[sessionField], r[f])
      else if (firstSeen.get(r[sessionField]) !== r[f]) return false
    }
    return true
  }
  const kinds = candidates
    .filter(([f]) => !sessionConstant(f))
    .filter(([f, s]) => s.text + s.bools === s.count && (s.text ? s.chars / s.text : 0) <= 30 && s.values.size < DISTINCT_CAP && s.values.size <= Math.max(3, total * 0.5) && f !== sessionField)
    .sort((a, b) => b[1].count - a[1].count || a[1].values.size - b[1].values.size)
    .slice(0, 3)
  const numbers = candidates.filter(([, s]) => s.numbers === s.count).slice(0, 2)
  const columns = ['time']
  if (candidates.some(([f]) => f === sessionField)) columns.push(sessionField)
  for (const [f] of [...text, ...kinds, ...numbers]) if (!columns.includes(f)) columns.push(f)
  if (columns.length === 1) for (const [f] of [...stats].filter(([f]) => f !== 'time').sort((a, b) => b[1].count - a[1].count).slice(0, 4)) columns.push(f) // a kind with one row: show something
  return columns.slice(0, MAX_DEFAULT_COLUMNS)
}

/** One group as the file the table loads: its rows (newest first), its columns, and which ones to show and search. */
export function buildEventFile(group, sessionField, resourceKeys) {
  const rows = [...group.rows].sort((a, b) => b.time - a.time)
  const stats = profile(rows)
  const fields = ['time', ...[...stats.keys()].filter((f) => f !== 'time').sort((a, b) => stats.get(b).count - stats.get(a).count || (a < b ? -1 : 1))]
  const defaultColumns = chooseColumns(rows, stats, sessionField, resourceKeys)
  const shownFirst = defaultColumns.filter((f) => f !== 'time')
  const searchFields = shownFirst.length ? shownFirst : fields.filter((f) => f !== 'time').slice(0, 3) // what is on screen is what a search can find
  return { kind: group.kind, name: group.name, fields, defaultColumns, searchFields, rows }
}

/** What the table opens on: a log event about prompts if the tool has one, else its most frequent log event, else its most frequent span. */
function pickDefault(events) {
  const logs = events.filter((e) => e.kind === 'log')
  return (logs.find((e) => /prompt/i.test(e.name)) ?? logs[0] ?? events[0])?.id ?? null
}

/** The index of a folder's Logs (logs.json) and one file per kind of event, as { index, files: [{ id, data }] }. */
export function buildLogs(groups, sessionField, resourceKeys) {
  const ordered = [...groups.values()].sort((a, b) => (a.kind === b.kind ? b.rows.length - a.rows.length || (a.name < b.name ? -1 : 1) : a.kind === 'log' ? -1 : 1))
  const files = ordered.map((group) => ({ id: eventId(group.kind, group.name), data: buildEventFile(group, sessionField, resourceKeys) }))
  const events = ordered.map((group, i) => {
    let first = Infinity // a loop, not Math.min(...times): a spread of a hundred thousand rows overflows the call stack
    let last = -Infinity
    for (const { time } of group.rows) {
      if (time < first) first = time
      if (time > last) last = time
    }
    return { id: files[i].id, kind: group.kind, name: group.name, count: group.rows.length, first, last }
  })
  return { index: { events, default: pickDefault(events) }, files }
}
