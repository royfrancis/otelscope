// Turns the metrics of ANY tool into what the Usage chart draws, with nothing known about the tool beforehand:
//   - every metric that can be added up becomes a "measure" (an entry of the Y-axis dropdown);
//   - every attribute found on the datapoints (and their resource) becomes a field to color by.
// So a tool that is logged for the first time just shows up, with whatever it sends.
import { attrsToObject, readRecords, toSeconds } from './read.mjs'

export const NONE = '(none)'
export const MAX_DISTINCT = 500 // a field with more values than this (an id, a timestamp) is no use to color by, so it is left out
const SLACK_S = 300 // a counter that began this long before the first datapoint we hold is still counted from its first sample

// What the chart puts first when the data has them, so the usual fields keep their place. Anything else follows A-Z.
const PREFERRED = ['service.name', 'service.version', 'app.entrypoint']
const SESSION_KEYS = ['session.id', 'session_id', 'sessionId', 'gen_ai.conversation.id', 'conversation.id', 'thread.id']
const MODEL_KEYS = ['model', 'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.model', 'llm.model']
const REPO_KEY = 'vcs.repository.name'

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n : NaN
}
const TEMPORALITY = { AGGREGATION_TEMPORALITY_DELTA: 1, AGGREGATION_TEMPORALITY_CUMULATIVE: 2 }
const temporalityOf = (shape) => {
  const t = shape.aggregationTemporality
  return typeof t === 'string' ? (TEMPORALITY[t] ?? 0) : Number(t ?? 0)
}

/**
 * Every datapoint that can be added up, as { key, name, part, unit, t, value, attrs }.
 *  - a sum, delta or cumulative: its value; a histogram: its `sum` and its `count` (as the measure `<name>#count`);
 *  - a cumulative value is the running total since the counter began, so adding the samples up would count the same
 *    tokens again at every export. It is turned into the increase since the previous sample of the same series
 *    (same resource, attributes and start time); a value that drops is a restart. The first sample counts in full when the
 *    counter began while we were listening (its start time is not before the first datapoint we hold), and is only the
 *    baseline when it began earlier, since what happened before then was never logged;
 *  - gauges and summaries are not added up (a gauge is a level, not an amount), nor a cumulative sum that is not marked
 *    monotonic (one that can go down is a level too, and protobuf records "not monotonic" by leaving the field out).
 */
export async function readPoints(dir) {
  const points = []
  const series = new Map()
  let firstSeen = Infinity

  for await (const rec of readRecords(dir, 'metrics')) {
    for (const rm of rec.data?.resourceMetrics ?? []) {
      const resource = attrsToObject(rm.resource?.attributes)
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const shape = metric.sum ?? metric.histogram ?? metric.exponentialHistogram
          if (!shape || !metric.name) continue
          const isHistogram = !metric.sum
          const cumulative = temporalityOf(shape) === 2
          // protobuf leaves a false `isMonotonic` out of the record, so only an explicit true is a counter that cannot go down
          if (!isHistogram && cumulative && shape.isMonotonic !== true) continue
          for (const dp of shape.dataPoints ?? []) {
            const t = toSeconds(dp.timeUnixNano)
            const attrs = { ...resource, ...attrsToObject(dp.attributes) }
            const parts = isHistogram ? [['sum', num(dp.sum)], ['count', num(dp.count)]] : [['sum', num(dp.asDouble ?? dp.asInt)]]
            for (const [part, value] of parts) {
              if (!Number.isFinite(value)) continue
              firstSeen = Math.min(firstSeen, t)
              const key = part === 'count' ? `${metric.name}#count` : metric.name
              const point = { key, name: metric.name, part, unit: part === 'count' ? '' : (metric.unit ?? ''), t, value, attrs }
              if (!cumulative) {
                points.push(point)
                continue
              }
              const startNs = String(dp.startTimeUnixNano ?? '')
              const id = JSON.stringify([key, startNs, Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1))])
              const s = series.get(id) ?? { point, startS: startNs && startNs !== '0' ? toSeconds(startNs) : null, samples: [] }
              s.samples.push({ t, value })
              series.set(id, s)
            }
          }
        }
      }
    }
  }

  for (const s of series.values()) {
    s.samples.sort((a, b) => a.t - b.t)
    const beganWhileListening = s.startS == null || s.startS >= firstSeen - SLACK_S
    let before = null
    for (const { t, value } of s.samples) {
      const increase = before == null ? (beganWhileListening ? value : 0) : value >= before ? value - before : value
      before = value
      if (increase > 0) points.push({ ...s.point, t, value: increase })
    }
  }
  return points
}

const ACRONYMS = { ai: 'AI', api: 'API', llm: 'LLM', mcp: 'MCP', id: 'ID', vcs: 'VCS', usd: 'USD', ttl: 'TTL', url: 'URL' }
const UNIT_NAMES = { s: 'seconds', ms: 'milliseconds', By: 'bytes', min: 'minutes', h: 'hours', d: 'days' }

/** "token.usage" -> "Token usage": words from the dots and underscores, sentence case, a few acronyms in capitals. */
function humanize(name) {
  const words = name.split(/[._\s-]+/).filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w)
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The part of the name every metric of the folder starts with ("claude_code."), which only repeats the tool's name. */
function commonPrefix(names) {
  if (names.length < 2) return ''
  const split = names.map((n) => n.split('.'))
  let i = 0
  while (i < split[0].length - 1 && split.every((p) => p[i] === split[0][i])) i++
  return split[0].slice(0, i).map((s) => `${s}.`).join('')
}

/** What to show next to the name: the unit, unless the name already says it ("Token usage" needs no "(tokens)"). */
function unitNote(label, unit) {
  const bare = String(unit ?? '').replace(/[{}]/g, '')
  if (!bare || bare === '1') return ''
  const spoken = UNIT_NAMES[bare] ?? bare
  const stem = spoken.toLowerCase().replace(/s$/, '')
  return label.toLowerCase().includes(stem) ? '' : ` (${spoken})`
}

/** How a measure's values are written: dollars, a duration, or a plain number. */
export function formatOf(unit) {
  const u = String(unit ?? '').toLowerCase()
  if (u === 'usd' || u === '$') return 'usd'
  if (u === 's') return 'seconds'
  if (u === 'ms') return 'ms'
  return 'number'
}

/** Which attribute is the session: a well-known name if the data has one, else anything with "session" in its name. */
export const pickSessionKey = (keys) => SESSION_KEYS.find((k) => keys.includes(k)) ?? keys.filter((k) => /session/i.test(k)).sort()[0] ?? null

const mostCommon = (values) => {
  const counts = new Map()
  for (const v of values) if (v && v !== NONE) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

const asText = (v) => (v == null || v === '' ? NONE : String(v))

/** The usage.json of one folder, from its datapoints. */
export function buildUsage(points) {
  // which attributes there are, and how many different values each has
  const seen = new Map()
  for (const p of points) {
    for (const [k, v] of Object.entries(p.attrs)) {
      const values = seen.get(k) ?? seen.set(k, new Set()).get(k)
      if (values.size <= MAX_DISTINCT) values.add(asText(v))
    }
  }
  const realKeys = [...seen].filter(([, values]) => [...values].some((v) => v !== NONE)).map(([k]) => k)
  const sessionKey = pickSessionKey(realKeys)
  const modelKey = MODEL_KEYS.find((k) => realKeys.includes(k)) ?? null

  const usable = realKeys.filter((k) => k === sessionKey || seen.get(k).size <= MAX_DISTINCT)
  const rank = (k) => {
    const first = [...PREFERRED, sessionKey, modelKey, REPO_KEY].filter(Boolean)
    const i = first.indexOf(k)
    return i < 0 ? first.length : i
  }
  const fields = usable.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))

  const dict = Object.fromEntries(fields.map((f) => [f, []]))
  const index = Object.fromEntries(fields.map((f) => [f, new Map()]))
  const idOf = (field, value) => {
    const v = asText(value)
    const map = index[field]
    if (!map.has(v)) {
      map.set(v, dict[field].length)
      dict[field].push(v)
    }
    return map.get(v)
  }

  const byKey = new Map()
  let tMin = Infinity
  let tMax = -Infinity
  const sessionPoints = new Map() // dict index -> { start, end, repos, usd }
  for (const p of points) {
    const dims = fields.map((f) => idOf(f, p.attrs[f]))
    const m = byKey.get(p.key) ?? byKey.set(p.key, { key: p.key, name: p.name, part: p.part, unit: p.unit, rows: [] }).get(p.key)
    m.rows.push([p.t, p.value, ...dims])
    tMin = Math.min(tMin, p.t)
    tMax = Math.max(tMax, p.t)
    if (sessionKey) {
      const sid = dims[fields.indexOf(sessionKey)]
      const s = sessionPoints.get(sid) ?? { start: p.t, end: p.t, repos: [], usd: 0 }
      s.start = Math.min(s.start, p.t)
      s.end = Math.max(s.end, p.t)
      if (fields.includes(REPO_KEY)) s.repos.push(dict[REPO_KEY][dims[fields.indexOf(REPO_KEY)]])
      if (formatOf(p.unit) === 'usd') s.usd += p.value
      sessionPoints.set(sid, s)
    }
  }

  const prefix = commonPrefix([...new Set(points.map((p) => p.name))])
  const measures = [...byKey.values()]
    .sort((a, b) => b.rows.length - a.rows.length || (a.key < b.key ? -1 : 1))
    .map((m) => {
      const base = humanize(m.name.startsWith(prefix) ? m.name.slice(prefix.length) : m.name)
      const label = m.part === 'count' ? `${base} (count)` : `${base}${unitNote(base, m.unit)}`
      return { key: m.key, label, unit: m.unit, format: formatOf(m.unit), rows: m.rows }
    })

  const hasUsd = measures.some((m) => m.format === 'usd')
  const sessions = sessionKey
    ? dict[sessionKey].map((id, idx) => {
        const s = sessionPoints.get(idx) ?? { start: 0, end: 0, repos: [], usd: 0 }
        return {
          idx,
          id,
          start: s.start,
          end: s.end,
          repo: mostCommon(s.repos),
          ...(hasUsd ? { cost: Math.round(s.usd * 1e6) / 1e6 } : {}),
          first: '',
        }
      })
    : []

  return {
    fields,
    dict,
    extent: points.length ? [tMin, tMax] : null,
    sessionField: sessionKey,
    modelField: modelKey && fields.includes(modelKey) ? modelKey : null,
    sessions,
    measures,
  }
}
