import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildDatasets, buildSource, defaultLogDir, describeDatasets, listSources, writeDatasets } from '../scripts/prepare-data.mjs'
import { MAX_DISTINCT, readPoints } from '../scripts/data/metrics.mjs'
import { withFakeLogger, writeFolder } from './fakeLogger.js'

// ---- builders for the records the logger stores (shown here as the JSON lines `cat` prints) --------
const str = (v) => ({ stringValue: v })
const attrs = (o) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: v } : typeof v === 'boolean' ? { boolValue: v } : str(v) }))
const nano = (s) => String(Math.round(s * 1_000_000_000))
const resource = (o = { 'service.name': 'claude-code', 'service.version': '2.1.0' }) => ({ attributes: attrs(o) })

/** A sum. Each point: { t, value, start?, ...attributes }. Delta by default (temporality 1); 2 is cumulative. */
const sum = (name, points, { unit = '', temporality = 1, monotonic = true } = {}) => ({
  name,
  unit,
  sum: {
    aggregationTemporality: temporality,
    isMonotonic: monotonic,
    dataPoints: points.map(({ t, value, start, ...a }) => ({ attributes: attrs(a), startTimeUnixNano: nano(start ?? t - 45), timeUnixNano: nano(t), asDouble: value })),
  },
})
const histogram = (name, points, { unit = '', temporality = 1 } = {}) => ({
  name,
  unit,
  histogram: {
    aggregationTemporality: temporality,
    dataPoints: points.map(({ t, count, total, start, ...a }) => ({ attributes: attrs(a), startTimeUnixNano: nano(start ?? t - 45), timeUnixNano: nano(t), count: String(count), sum: total })),
  },
})
const gauge = (name, points) => ({ name, gauge: { dataPoints: points.map(({ t, value, ...a }) => ({ attributes: attrs(a), timeUnixNano: nano(t), asDouble: value })) } })

const metricsLine = (metrics, res = resource()) =>
  JSON.stringify({ received_at: 'x', data: { resourceMetrics: [{ resource: res, scopeMetrics: [{ metrics }] }] } }) + '\n'
const logLine = (records, res = resource()) =>
  JSON.stringify({ received_at: 'x', data: { resourceLogs: [{ resource: res, scopeLogs: [{ logRecords: records }] }] } }) + '\n'
const event = (t, name, a = {}) => ({ timeUnixNano: nano(t), attributes: attrs({ 'event.name': name, ...a }) })
const span = (name, a = {}, { t = 1000, seconds = 0.5, traceId, spanId } = {}) => ({
  name, traceId, spanId, startTimeUnixNano: nano(t), endTimeUnixNano: nano(t + seconds), attributes: attrs(a),
})
const spansLine = (spans, res = resource()) =>
  JSON.stringify({ received_at: 'x', data: { resourceSpans: [{ resource: res, scopeSpans: [{ spans }] }] } }) + '\n'

/** A folder holding the given log files (name.pblog -> the JSON lines `cat` prints for it), read through the fake `cat`; removed afterward. */
const inFolder = (files, run) => withFakeLogger(async (dir) => {
  writeFolder(dir, files)
  return run(dir)
})
const total = (measure) => measure.rows.reduce((a, r) => a + r[1], 0)
const measureOf = (usage, key) => usage.measures.find((m) => m.key === key)
const byField = (usage, key, field) => {
  const col = 2 + usage.fields.indexOf(field)
  const out = {}
  for (const r of measureOf(usage, key).rows) out[usage.dict[field][r[col]]] = (out[usage.dict[field][r[col]]] ?? 0) + r[1]
  return out
}

// ---- a tool that sends delta counters: every metric is a measure, every attribute a field ---------
const common = { 'app.entrypoint': 'cli', 'vcs.repository.name': 'demo', 'terminal.type': 'vscode' }
const deltaFolder = {
  'metrics.pblog': [
    metricsLine([
      sum('claude_code.token.usage', [
        { t: 1000, value: 100, type: 'input', 'session.id': 's1', model: 'claude-opus-5-5', ...common },
        { t: 1000, value: 40, type: 'output', 'session.id': 's1', model: 'claude-opus-5-5', ...common },
        { t: 2000, value: 7, type: 'input', 'session.id': 's2', 'app.entrypoint': 'cli', 'terminal.type': 'iTerm.app' }, // no model, not in a git repo
      ], { unit: 'tokens' }),
      sum('claude_code.cost.usage', [{ t: 1000, value: 0.25, 'session.id': 's1', model: 'claude-opus-5-5', ...common }], { unit: 'USD' }),
      sum('claude_code.lines_of_code.count', [{ t: 1500, value: 12, type: 'added', 'session.id': 's1', ...common }]),
      sum('claude_code.session.count', [{ t: 1000, value: 1, 'session.id': 's1', ...common }]),
    ]),
    '{"received_at":"x","data":{"resourceMet', // a line that is not a whole record: the reader skips it
  ].join(''),
  'logs.pblog': [
    logLine([event(1100, 'user_prompt', { 'session.id': 's1', prompt: '  First   prompt\n with   whitespace  ', prompt_length: 30 }), event(1100, 'api_request', { 'session.id': 's1', model: 'm' })]),
    logLine([event(900, 'user_prompt', { 'session.id': 's1', prompt: 'Earlier prompt' })]),
    'not json at all\n',
  ].join(''),
}

test('every metric a tool sends becomes a measure, with a label, a unit and a format read from the metric itself', async () => {
  await inFolder(deltaFolder, async (dir) => {
    const { usage } = await buildSource(dir)
    assert.deepEqual(usage.measures.map((m) => [m.key, m.label, m.format]), [
      ['claude_code.token.usage', 'Token usage', 'number'], // the name already says "tokens": no "(tokens)" after it
      ['claude_code.cost.usage', 'Cost usage (USD)', 'usd'],
      ['claude_code.lines_of_code.count', 'Lines of code count', 'number'], // the prefix every metric shares is dropped, and the rest is words
      ['claude_code.session.count', 'Session count', 'number'],
    ])
    assert.equal(total(measureOf(usage, 'claude_code.token.usage')), 147)
    assert.equal(total(measureOf(usage, 'claude_code.cost.usage')), 0.25)
    assert.deepEqual(usage.extent, [1000, 2000])
  })
})

test('every attribute found on a datapoint, or on its resource, becomes a field to color by', async () => {
  await inFolder(deltaFolder, async (dir) => {
    const { usage } = await buildSource(dir)
    // the usual ones first, in their usual order, then the others A-Z; a type is a field like any other
    assert.deepEqual(usage.fields, ['service.name', 'service.version', 'app.entrypoint', 'session.id', 'model', 'vcs.repository.name', 'terminal.type', 'type'])
    assert.deepEqual(usage.dict['service.name'], ['claude-code']) // resource attributes are merged into each datapoint
    assert.deepEqual(usage.dict['session.id'], ['s1', 's2'])
    assert.deepEqual(usage.dict.model, ['claude-opus-5-5', '(none)']) // a datapoint without a model is kept, as (none)
    assert.deepEqual(usage.dict['vcs.repository.name'], ['demo', '(none)'])
    assert.deepEqual(usage.dict.type, ['input', 'output', '(none)', 'added']) // in the order the datapoints come
    assert.deepEqual(byField(usage, 'claude_code.token.usage', 'type'), { input: 107, output: 40 })
    assert.deepEqual(usage.measures[0].rows[0], [1000, 100, 0, 0, 0, 0, 0, 0, 0, 0]) // the time, the value, then one dictionary index per field
    assert.equal(usage.sessionField, 'session.id')
    assert.equal(usage.modelField, 'model')
  })
})

test('sessions are found from the session field, with what the search box needs where the logs have it', async () => {
  await inFolder(deltaFolder, async (dir) => {
    const { usage } = await buildSource(dir)
    const s1 = usage.sessions.find((s) => s.id === 's1')
    assert.equal(s1.repo, 'demo')
    assert.equal(s1.cost, 0.25) // there is a measure in dollars, so each session has a cost
    assert.equal(s1.first, 'Earlier prompt') // the earliest event with a prompt, whitespace collapsed
    assert.deepEqual([s1.start, s1.end], [1000, 1500])
    const s2 = usage.sessions.find((s) => s.id === 's2')
    assert.deepEqual([s2.repo, s2.first, s2.cost], ['', '', 0])
  })
})

test('a tool with no session attribute has no sessions, and a tool with no dollar measure no session costs', async () => {
  await inFolder({ 'metrics.pblog': metricsLine([sum('widgets.made', [{ t: 100, value: 3, color: 'red' }, { t: 200, value: 2, color: 'blue' }])], resource({})) }, async (dir) => {
    const { usage } = await buildSource(dir)
    assert.equal(usage.sessionField, null)
    assert.deepEqual(usage.sessions, [])
    assert.equal(usage.modelField, null)
    assert.deepEqual(usage.fields, ['color'])
  })
  await inFolder({ 'metrics.pblog': metricsLine([sum('a.b', [{ t: 1, value: 1, 'session.id': 'x' }])]) }, async (dir) => {
    const { usage } = await buildSource(dir)
    assert.equal('cost' in usage.sessions[0], false)
  })
})

test('the session and the model are found under the names other tools use', async () => {
  const folder = (extra) => ({ 'metrics.pblog': metricsLine([sum('x.count', [{ t: 1, value: 1, ...extra }])], resource({})) })
  await inFolder(folder({ 'gen_ai.conversation.id': 'c1', 'gen_ai.request.model': 'gpt-a' }), async (dir) => {
    const { usage } = await buildSource(dir)
    assert.equal(usage.sessionField, 'gen_ai.conversation.id')
    assert.equal(usage.modelField, 'gen_ai.request.model')
  })
  await inFolder(folder({ my_session_token: 'abc' }), async (dir) => {
    assert.equal((await buildSource(dir)).usage.sessionField, 'my_session_token') // anything with "session" in its name, as a last resort
  })
})

test('a field with more than a few hundred different values is left out, but the session field is kept however many', async () => {
  const points = Array.from({ length: MAX_DISTINCT + 20 }, (_, i) => ({ t: 1000 + i, value: 1, 'session.id': `s${i}`, request: `r${i}`, kind: i % 2 ? 'a' : 'b' }))
  await inFolder({ 'metrics.pblog': metricsLine([sum('x.count', points)], resource({})) }, async (dir) => {
    const { usage } = await buildSource(dir)
    assert.deepEqual(usage.fields.slice().sort(), ['kind', 'session.id']) // no use coloring by something unique to every point
    assert.equal(usage.sessions.length, MAX_DISTINCT + 20)
  })
})

// ---- cumulative counters --------------------------------------------------------------------------
const cumulative = (points, options) => metricsLine([sum('x.tokens', points, { temporality: 2, ...options })], resource({}))
const points = async (lines) => inFolder({ 'metrics.pblog': lines }, readPoints)
const increases = (pts) => pts.map((p) => [p.t, p.value])

test('a cumulative counter is turned into the increase since its last sample, not added up', async () => {
  // a running total that goes 10, 10, 25, 25, 40: the real amount is 40, not 110
  const pts = await points(cumulative([10, 10, 25, 25, 40].map((value, i) => ({ t: 1000 + i * 60, value, start: 990, model: 'm' }))))
  assert.deepEqual(increases(pts), [[1000, 10], [1120, 15], [1240, 15]]) // the samples that did not change say nothing
  assert.equal(pts.reduce((a, p) => a + p.value, 0), 40)
})

test('a counter that drops has been restarted, and counts from zero again', async () => {
  const pts = await points(cumulative([{ t: 1000, value: 50, start: 990 }, { t: 1060, value: 80, start: 990 }, { t: 1120, value: 7, start: 990 }, { t: 1180, value: 9, start: 990 }]))
  assert.deepEqual(increases(pts), [[1000, 50], [1060, 30], [1120, 7], [1180, 2]]) // 80 -> 7 is a restart: 7 new, not -73
})

test('two processes that send the same attributes are two counters, told apart by when they began', async () => {
  // samples alternate between two processes (started at 900 and 950), both with a total that only grows
  const lines = cumulative([
    { t: 1000, value: 100, start: 900 }, { t: 1001, value: 5, start: 950 },
    { t: 1060, value: 130, start: 900 }, { t: 1061, value: 9, start: 950 },
  ])
  const pts = await points(lines)
  assert.equal(pts.reduce((a, p) => a + p.value, 0), 130 + 9) // not a "restart" at every other sample
})

test('a counter that was already running when the logging began only has its later growth counted', async () => {
  // it began at 100, long before the first datapoint we hold (at 10000): the 5000 it had is history nobody logged
  const lines = cumulative([{ t: 10000, value: 5000, start: 100, who: 'old' }, { t: 10060, value: 5040, start: 100, who: 'old' }, { t: 10000, value: 8, start: 9990, who: 'new' }])
  const pts = await points(lines)
  const sumOf = (who) => pts.filter((p) => p.attrs.who === who).reduce((a, p) => a + p.value, 0)
  assert.equal(sumOf('old'), 40) // only what grew while we were listening
  assert.equal(sumOf('new'), 8) // began just before its first sample: all of it is ours
})

test('a counter that began a few minutes before the first sample still counts its first sample', async () => {
  const pts = await points(cumulative([{ t: 1000, value: 12, start: 800 }])) // 200 s earlier: within the slack
  assert.deepEqual(increases(pts), [[1000, 12]])
})

test('what cannot be added up is left out: gauges, summaries, and a cumulative sum that can go down', async () => {
  const lines = metricsLine([
    gauge('process.memory', [{ t: 1, value: 500 }]),
    { name: 'x.summary', summary: { dataPoints: [{ timeUnixNano: nano(1), count: '2', sum: 5 }] } },
    sum('x.queue.depth', [{ t: 1, value: 4, start: 0 }], { temporality: 2, monotonic: false }),
    sum('x.fine', [{ t: 1, value: 4 }]),
  ], resource({}))
  const pts = await points(lines)
  assert.deepEqual(pts.map((p) => p.key), ['x.fine'])
})

test('a sum with no isMonotonic is not monotonic: protobuf leaves a false out of the record', async () => {
  const unflagged = (name, options) => {
    const metric = sum(name, [{ t: 1, value: 4, start: 0 }], options)
    delete metric.sum.isMonotonic
    return metric
  }
  const pts = await points(metricsLine([
    unflagged('x.queue.depth', { temporality: 2 }), // cumulative and able to go down: a level, not an amount
    unflagged('x.delta', { temporality: 1 }), // delta: every sample is a change, so it still counts
    sum('x.fine', [{ t: 1, value: 4, start: 0 }], { temporality: 2 }), // flagged monotonic
  ], resource({})))
  assert.deepEqual(pts.map((p) => p.key).sort(), ['x.delta', 'x.fine'])
})

test('a delta sum that can go down is still added up, since each sample is a change', async () => {
  const pts = await points(metricsLine([sum('x.delta', [{ t: 1, value: -3 }, { t: 2, value: 5 }], { monotonic: false })], resource({})))
  assert.equal(pts.reduce((a, p) => a + p.value, 0), 2)
})

test('a histogram gives its sum and its count, delta or cumulative', async () => {
  const delta = await points(metricsLine([histogram('x.duration', [{ t: 100, count: 2, total: 3.5 }, { t: 200, count: 1, total: 1 }], { unit: 's' })], resource({})))
  assert.deepEqual(delta.map((p) => [p.key, p.value]), [['x.duration', 3.5], ['x.duration#count', 2], ['x.duration', 1], ['x.duration#count', 1]])
  assert.equal(delta[0].unit, 's')
  assert.equal(delta[1].unit, '') // a count has no unit

  const running = await points(metricsLine([histogram('x.duration', [{ t: 100, count: 2, total: 3.5, start: 90 }, { t: 160, count: 2, total: 3.5, start: 90 }, { t: 220, count: 5, total: 9, start: 90 }], { temporality: 2 })], resource({})))
  const sumOf = (key) => running.filter((p) => p.key === key).reduce((a, p) => a + p.value, 0)
  assert.equal(sumOf('x.duration'), 9) // not 3.5 + 3.5 + 9
  assert.equal(sumOf('x.duration#count'), 5)
})

test('a histogram becomes two measures, the second one called a count, and a duration is shown as one', async () => {
  await inFolder({ 'metrics.pblog': metricsLine([histogram('app.request.duration', [{ t: 100, count: 2, total: 3.5 }], { unit: 's' }), sum('app.tokens', [{ t: 100, value: 1 }])], resource({})) }, async (dir) => {
    const { usage } = await buildSource(dir)
    assert.deepEqual(usage.measures.map((m) => [m.label, m.format]).sort(), [
      ['Request duration (count)', 'number'], ['Request duration (seconds)', 'seconds'], ['Tokens', 'number'], // "app." is on every name, so it is dropped
    ].sort())
  })
})

test('measures are listed by how much data they have, and acronyms are capitals', async () => {
  const lines = metricsLine([
    sum('gen_ai.client.token.usage', [{ t: 1, value: 1 }, { t: 2, value: 1 }, { t: 3, value: 1 }]),
    sum('copilot_chat.session.count', [{ t: 1, value: 1 }]),
  ], resource({}))
  await inFolder({ 'metrics.pblog': lines }, async (dir) => {
    const { usage } = await buildSource(dir)
    assert.deepEqual(usage.measures.map((m) => m.label), ['Gen AI client token usage', 'Copilot chat session count']) // no prefix is shared, so none is dropped
  })
})

// ---- the Logs: log events and spans, one kind per file ---------------------------------------------
test('log events and spans are grouped by name, each group its own file, newest first', async () => {
  const files = {
    'logs.pblog': logLine([event(100, 'tool.call', { name: 'a' }), event(300, 'tool.call', { name: 'b' }), event(200, 'user.prompt', { prompt: 'hi' })]),
    'traces.pblog': spansLine([span('chat gpt', { 'gen_ai.usage.input_tokens': 5 }, { t: 400, seconds: 2, traceId: 'aa', spanId: '01' })]),
  }
  await inFolder(files, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.deepEqual(logs.index.events.map((e) => [e.kind, e.name, e.count]), [['log', 'tool.call', 2], ['log', 'user.prompt', 1], ['span', 'chat gpt', 1]]) // logs first, the larger first
    assert.deepEqual(logs.index.events.map((e) => [e.first, e.last]), [[100, 300], [200, 200], [400, 400]])
    assert.equal(logs.files.length, 3)
    const file = (name) => logs.files.find((f) => f.data.name === name).data
    assert.deepEqual(file('tool.call').rows.map((r) => r.time), [300, 100]) // newest first
    assert.equal(file('chat gpt').rows[0].duration_ms, 2000)
    assert.equal(file('chat gpt').rows[0].trace_id, 'aa')
    assert.equal(file('tool.call').rows[0]['event.name'], undefined) // the name is the file's, not a column
    assert.equal(file('chat gpt').rows[0]['service.name'], 'claude-code') // the sender's attributes are on every row
  })
})

test('the id of a kind is the same on every run, and different for a log event and a span of the same name', async () => {
  const files = { 'logs.pblog': logLine([event(1, 'same')]), 'traces.pblog': spansLine([span('same')]) }
  const ids = async () => inFolder(files, async (dir) => (await buildSource(dir)).logs.index.events.map((e) => e.id))
  const first = await ids()
  assert.deepEqual(await ids(), first)
  assert.notEqual(first[0], first[1])
  assert.match(first[0], /^[0-9a-f]{10}$/)
})

test('a log record with no event name is named by its body, and keeps a different body as a column', async () => {
  const records = [
    { timeUnixNano: nano(10), body: str('plain message'), severityText: 'INFO', attributes: attrs({ k: 'v' }) },
    { timeUnixNano: nano(20), body: str('some body'), attributes: attrs({ 'event.name': 'named' }) },
    { timeUnixNano: nano(30) },
  ]
  await inFolder({ 'logs.pblog': logLine(records) }, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.deepEqual(logs.index.events.map((e) => e.name).sort(), ['(log record)', 'named', 'plain message'])
    const rows = Object.fromEntries(logs.files.map((f) => [f.data.name, f.data.rows[0]]))
    assert.equal(rows['plain message'].severity, 'INFO')
    assert.equal(rows.named.body, 'some body')
    assert.equal(rows['plain message'].body, undefined) // the body is the name already
  })
})

test('a log record is named by its eventName field first, and a body of any kind is kept', async () => {
  const records = [
    { timeUnixNano: nano(10), eventName: 'by.field', body: str('the message'), attributes: attrs({ 'event.name': 'by.attribute' }) },
    { timeUnixNano: nano(20), body: { kvlistValue: { values: [{ key: 'k', value: str('v') }, { key: 'n', value: { intValue: 3 } }] } } },
    { timeUnixNano: nano(30), body: { intValue: 7 } },
    { timeUnixNano: nano(40), eventName: 'by.field', body: { arrayValue: { values: [str('a')] } } },
  ]
  await inFolder({ 'logs.pblog': logLine(records) }, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.deepEqual(logs.index.events.map((e) => e.name).sort(), ['(log record)', 'by.field']) // not 'by.attribute', and not the message
    const rowsOf = (name) => logs.files.find((f) => f.data.name === name).data.rows
    assert.deepEqual(rowsOf('by.field').map((r) => r.body), ['["a"]', 'the message']) // newest first
    assert.deepEqual(rowsOf('(log record)').map((r) => r.body), [7, '{"k":"v","n":3}']) // a structured body is not lost
  })
})

test('a span exported twice is one span; very long text is cut', async () => {
  const long = 'x'.repeat(20_000)
  const files = {
    'traces.pblog': spansLine([span('a', { text: long }, { traceId: 't', spanId: '1' })]) + spansLine([span('a', { text: long }, { traceId: 't', spanId: '1' })]) + spansLine([span('a', {}, { traceId: 't', spanId: '2' })]),
  }
  await inFolder(files, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.equal(logs.index.events[0].count, 2)
    const cell = logs.files[0].data.rows.find((r) => r.text).text
    assert.equal(cell.length, 10_000)
    assert.ok(cell.endsWith('…'))
  })
})

const promptEvents = (n) => Array.from({ length: n }, (_, i) => event(1000 + i, 'u', {
  'session.id': `s${i % 4}`, prompt: `a long prompt that says something different each time, number ${i}`, 'app.version': '2.1', tool_name: ['Bash', 'Read', 'Edit'][i % 3], success: i % 3 === 0,
  tokens: 100 + i, 'prompt.id': `p-${i}`, 'event.timestamp': `2026-10-30T10:00:${String(i).padStart(2, '0')}Z`,
}))

test('the columns shown first are worked out from what the rows hold: the session, the long text, what tells rows apart, the numbers', async () => {
  await inFolder({ 'logs.pblog': logLine(promptEvents(20)) }, async (dir) => {
    const file = (await buildSource(dir)).logs.files[0].data
    // time, then the session; then the longest text; then what varies within a session (success, the tool: fewer values first); then a number
    assert.deepEqual(file.defaultColumns, ['time', 'session.id', 'prompt', 'success', 'tool_name', 'tokens'])
    assert.ok(!file.defaultColumns.includes('prompt.id')) // an identifier is for the column menu
    assert.ok(!file.defaultColumns.includes('event.timestamp'))
    assert.ok(!file.defaultColumns.includes('app.version')) // the same on every row
    assert.ok(!file.defaultColumns.includes('service.name')) // the sender's own attributes
    assert.ok(file.fields.includes('app.version') && file.fields.includes('prompt.id')) // but all of them are there to choose
    assert.equal(file.fields[0], 'time')
  })
})

test('what describes the sender (its version, its host) is not shown first, even when it differs between senders', async () => {
  // two installs of the tool send events: the version and host differ from row to row, but they are the sender's, not the event's
  const senders = [{ 'service.version': '1.0', 'host.name': 'laptop' }, { 'service.version': '2.0', 'host.name': 'desktop' }]
  const lines = Array.from({ length: 12 }, (_, i) => logLine([event(1000 + i, 'e', { 'session.id': `s${i % 3}`, tool: ['a', 'b'][Math.floor(i / 3) % 2], note: 'x'.repeat(40 + i) })], resource(senders[i % 2]))).join('')
  await inFolder({ 'logs.pblog': lines }, async (dir) => {
    const file = (await buildSource(dir)).logs.files[0].data
    assert.ok(file.fields.includes('service.version') && file.fields.includes('host.name')) // they are in the column menu
    assert.ok(!file.defaultColumns.includes('service.version'))
    assert.ok(!file.defaultColumns.includes('host.name'))
    assert.ok(file.defaultColumns.includes('tool'))
  })
})

test('a column that never changes within a session describes the session, so it is not shown first', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => event(1000 + i, 'e', { 'session.id': `s${i % 3}`, terminal: ['iTerm', 'vscode', 'tmux'][i % 3], tool: ['a', 'b'][i % 2] }))
  await inFolder({ 'logs.pblog': logLine(rows) }, async (dir) => {
    const file = (await buildSource(dir)).logs.files[0].data
    assert.deepEqual(file.defaultColumns, ['time', 'session.id', 'tool']) // "terminal" is fixed by the session; "tool" is not
  })
})

test('what is searched is what is shown first, and a kind with one row still shows something', async () => {
  await inFolder({ 'logs.pblog': logLine(promptEvents(20)) + logLine([event(5, 'lonely', { a: 1, b: 'x' })]) }, async (dir) => {
    const { logs } = await buildSource(dir)
    const u = logs.files.find((f) => f.data.name === 'u').data
    assert.deepEqual(u.searchFields, u.defaultColumns.filter((f) => f !== 'time'))
    const lonely = logs.files.find((f) => f.data.name === 'lonely').data
    assert.deepEqual(lonely.defaultColumns.slice(0, 1), ['time'])
    assert.ok(lonely.defaultColumns.length > 1) // the fields that are there
    assert.ok(lonely.searchFields.length > 0)
  })
})

test('the table opens on a prompt event if there is one, else on the most frequent log event, else on a span', async () => {
  const withPrompt = { 'logs.pblog': logLine([event(1, 'tool.call'), event(2, 'tool.call'), event(3, 'x.user_prompt')]) }
  await inFolder(withPrompt, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.equal(logs.index.events.find((e) => e.id === logs.index.default).name, 'x.user_prompt')
  })
  await inFolder({ 'logs.pblog': logLine([event(1, 'a'), event(2, 'b'), event(3, 'b')]) }, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.equal(logs.index.events.find((e) => e.id === logs.index.default).name, 'b')
  })
  await inFolder({ 'traces.pblog': spansLine([span('only')]) }, async (dir) => {
    const { logs } = await buildSource(dir)
    assert.equal(logs.index.events.find((e) => e.id === logs.index.default).name, 'only')
  })
})

test('a folder with nothing in it, or only one signal, still gives both views something true', async () => {
  await inFolder({}, async (dir) => {
    const { usage, logs } = await buildSource(dir)
    assert.equal(usage.extent, null)
    assert.deepEqual(usage.measures, [])
    assert.deepEqual(logs.index.events, [])
    assert.equal(logs.index.default, null)
  })
  await inFolder({ 'traces.pblog': spansLine([span('only')]) }, async (dir) => {
    const { usage, logs } = await buildSource(dir)
    assert.deepEqual(usage.measures, []) // no metrics, so nothing to chart
    assert.equal(logs.index.events.length, 1)
  })
})

// ---- a tool this code has never heard of -----------------------------------------------------------
test('a tool that is new to the site needs no code: its metrics, attributes and events just show up', async () => {
  const files = {
    'metrics.pblog': metricsLine([
      sum('acme.widget.produced', [{ t: 100, value: 3, 'acme.line': 'north', 'acme.shift': 'day' }, { t: 160, value: 4, 'acme.line': 'south', 'acme.shift': 'night' }], { unit: 'widgets', temporality: 2 }),
      histogram('acme.widget.latency', [{ t: 100, count: 3, total: 1.5, 'acme.line': 'north' }], { unit: 'ms' }),
    ], resource({ 'service.name': 'acme-cli' })),
    'logs.pblog': logLine([event(100, 'acme.shipped', { 'acme.line': 'north', note: 'a fairly long free text note about the shipment' }), event(200, 'acme.recalled', { 'acme.line': 'south' })], resource({ 'service.name': 'acme-cli' })),
    'traces.pblog': spansLine([span('acme.assemble', { 'acme.line': 'north' })], resource({ 'service.name': 'acme-cli' })),
  }
  await inFolder(files, async (dir) => {
    const { usage, logs } = await buildSource(dir)
    assert.deepEqual(usage.measures.map((m) => m.label).sort(), ['Latency (count)', 'Latency (milliseconds)', 'Produced (widgets)'].sort()) // "acme.widget." is on every name, so it is dropped
    assert.deepEqual(usage.measures.find((m) => m.key === 'acme.widget.latency').format, 'ms')
    assert.deepEqual(usage.fields, ['service.name', 'acme.line', 'acme.shift'])
    assert.deepEqual(byField(usage, 'acme.widget.produced', 'acme.line'), { north: 3, south: 4 }) // the cumulative total counted once
    assert.deepEqual(logs.index.events.map((e) => `${e.kind}:${e.name}`), ['log:acme.recalled', 'log:acme.shipped', 'span:acme.assemble'])
  })
})

// ---- reading .pblog files through the logger's `cat` command (see tests/fakeLogger.js) -------------
const tokenRecord = (t, v) => metricsLine([sum('claude_code.token.usage', [{ t, value: v, type: 'input', 'session.id': 's1' }])])
const write = (file, text) => writeFileSync(file, text)

test('.pblog files are read through the logger, for metrics, log events and spans alike', async () => {
  await withFakeLogger(async (dir) => {
    for (const [signal, text] of [
      ['metrics', tokenRecord(1_760_000_000, 10) + tokenRecord(1_760_000_060, 5)],
      ['logs', logLine([event(1_760_000_001, 'user_prompt', { 'session.id': 's1', prompt: 'hello there' })])],
      ['traces', spansLine([span('chat', {}, { t: 1_760_000_002 })])],
    ]) {
      write(path.join(dir, `${signal}.pblog`), 'binary')
      write(path.join(dir, `${signal}.pblog.txt`), text)
    }
    const { usage, logs } = await buildSource(dir)
    assert.equal(usage.measures[0].rows.length, 2)
    assert.deepEqual(logs.index.events.map((e) => e.name).sort(), ['chat', 'user_prompt'])
    assert.equal(logs.files.find((f) => f.data.name === 'user_prompt').data.rows[0].prompt, 'hello there')
  })
})

test('a failing logger `cat` is an error that says what to do, not an empty dataset', async () => {
  await withFakeLogger(async (dir) => {
    write(path.join(dir, 'metrics.pblog'), 'binary')
    write(path.join(dir, 'metrics.pblog.txt'), '')
    process.env.FAKE_EXIT = '1'
    await assert.rejects(buildSource(dir), /metrics\.pblog.*boom: the protobuf libraries are missing.*pip install -r requirements\.txt/s)
  })
})

test('a missing python is reported as such', async () => {
  await withFakeLogger(async (dir) => {
    write(path.join(dir, 'metrics.pblog'), 'binary')
    process.env.OTEL_LOGGER_PYTHON = path.join(dir, 'no-such-python')
    await assert.rejects(buildSource(dir), /could not be started \(ENOENT\)/)
  })
})

// ---- one tab per folder of the log root ------------------------------------------------------------
test('listSources gives known folders their tab order and labels, then the rest by name, then other, and skips what is not a folder', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'otel-root-'))
  try {
    for (const name of ['zeta', 'other', 'codex', 'vscode', 'claude', 'positron', 'alpha', '.hidden', 'has space']) mkdirSync(path.join(root, name))
    writeFileSync(path.join(root, 'stray-file'), 'x')
    assert.deepEqual(listSources(root), [
      { id: 'claude', label: 'Claude Code' }, { id: 'vscode', label: 'VS Code Copilot' }, { id: 'codex', label: 'Codex' },
      { id: 'alpha', label: 'Alpha' }, { id: 'positron', label: 'Positron' }, { id: 'zeta', label: 'Zeta' }, // a tool nobody listed needs no edit here
      { id: 'other', label: 'Other' }, // always the last tab
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildDatasets and writeDatasets make one set of files per folder and a tab list', () => withFakeLogger(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'otel-root-'))
  const out = mkdtempSync(path.join(tmpdir(), 'otel-out-'))
  try {
    mkdirSync(path.join(root, 'claude'))
    writeFolder(path.join(root, 'claude'), deltaFolder)
    mkdirSync(path.join(root, 'opencode'))
    writeFolder(path.join(root, 'opencode'), { 'logs.pblog': logLine([event(5, 'oc.event', { a: 'b' })]) })

    const all = await buildDatasets(root)
    assert.deepEqual(all.sources.map((s) => s.id), ['claude', 'opencode'])
    const notes = writeDatasets(out, all)
    const names = notes.map((n) => n.split(' ')[0])
    assert.equal(names.at(-1), 'sources.json') // listed last, so a folder is never listed before its files exist
    for (const id of ['claude', 'opencode']) {
      const own = names.filter((n) => n.startsWith(`${id}/`))
      assert.ok(own.indexOf(`${id}/logs.json`) > own.findIndex((n) => n.startsWith(`${id}/logs/`))) // the rows are written before the index that names them
      assert.ok(own.includes(`${id}/usage.json`))
    }
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'sources.json'), 'utf8')).sources, [{ id: 'claude', label: 'Claude Code' }, { id: 'opencode', label: 'OpenCode' }])
    assert.equal(readdirSync(path.join(out, 'claude', 'logs')).some((f) => f.endsWith('.tmp')), false)
    assert.equal(readdirSync(path.join(out, 'claude')).some((f) => f.endsWith('.tmp')), false)
    const index = JSON.parse(readFileSync(path.join(out, 'claude', 'logs.json'), 'utf8'))
    for (const e of index.events) assert.ok(readdirSync(path.join(out, 'claude', 'logs')).includes(`${e.id}.json`)) // every kind in the index has its file
    assert.equal(JSON.parse(readFileSync(path.join(out, 'claude', 'usage.json'), 'utf8')).measures.length, 4)
    const lines = describeDatasets(all)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^claude: 4 measures \(6 datapoints, 2 sessions\), 2 kinds of log event or span \(3 rows\)/)
    assert.match(lines[1], /^opencode: 0 measures \(0 datapoints, 0 sessions\), 1 kinds of log event or span \(1 rows\) \(no metrics\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
}))

test('writing a folder removes the files an earlier version left in its output, and nothing else', () => withFakeLogger(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'otel-root-'))
  const out = mkdtempSync(path.join(tmpdir(), 'otel-out-'))
  try {
    mkdirSync(path.join(root, 'claude'))
    writeFolder(path.join(root, 'claude'), { 'logs.pblog': logLine([event(5, 'e', { a: 'b' })]) })
    mkdirSync(path.join(out, 'claude'))
    mkdirSync(path.join(out, 'gone'))
    for (const file of ['claude/prompts.json', 'claude/summary.json', 'claude/keep.json', 'gone/prompts.json']) writeFileSync(path.join(out, file), '{}')
    writeDatasets(out, await buildDatasets(root))
    const left = readdirSync(path.join(out, 'claude'))
    assert.deepEqual([left.includes('prompts.json'), left.includes('summary.json')], [false, false])
    assert.ok(left.includes('keep.json') && left.includes('usage.json')) // only the two known names go
    assert.deepEqual(readdirSync(path.join(out, 'gone')), ['prompts.json']) // a folder that is not a tab now is left alone
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
}))

test('a folder that cannot be read is reported on its own tab, and the others still work', async () => {
  await withFakeLogger(async (root) => {
    mkdirSync(path.join(root, 'claude'))
    write(path.join(root, 'claude', 'metrics.pblog'), 'binary')
    write(path.join(root, 'claude', 'metrics.pblog.txt'), '')
    process.env.FAKE_EXIT = '1'
    mkdirSync(path.join(root, 'codex'))
    const all = await buildDatasets(root)
    const claude = all.sources.find((s) => s.id === 'claude')
    assert.match(claude.error, /Could not read metrics\.pblog.*boom/s)
    assert.equal(claude.usage, undefined)
    assert.deepEqual(all.sources.find((s) => s.id === 'codex').usage.measures, []) // an empty folder is fine
    const out = mkdtempSync(path.join(tmpdir(), 'otel-out-'))
    try {
      writeDatasets(out, all)
      const listed = JSON.parse(readFileSync(path.join(out, 'sources.json'), 'utf8')).sources
      assert.match(listed.find((s) => s.id === 'claude').error, /boom/)
      assert.equal(listed.find((s) => s.id === 'codex').error, undefined)
      assert.match(describeDatasets(all)[0], /^claude: could not be read/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})

test('buildDatasets explains a missing log directory', async () => {
  await assert.rejects(buildDatasets(path.join(tmpdir(), 'definitely-not-here-otel')), /Log directory not found/)
})

test('the log root comes from OTEL_LOGGER_DIR, else ~/otelscope', () => {
  assert.equal(defaultLogDir({ OTEL_LOGGER_DIR: '/data/logs' }), '/data/logs')
  assert.match(defaultLogDir({}), /[\\/]otelscope$/)
  assert.match(defaultLogDir({ OTEL_LOGGER_DIR: '' }), /[\\/]otelscope$/)
})
