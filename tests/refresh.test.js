import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeDatasets } from '../scripts/prepare-data.mjs'
import { createRefreshHandler, refreshDataPlugin } from '../docs/.vitepress/plugins/refreshData.js'
import { followRange, requestRefresh } from '../docs/.vitepress/lib/refresh.js'

// ---- the client request ---------------------------------------------------------------------------
const reply = (status, body, statusText = '') => async () => ({
  ok: status >= 200 && status < 300, status, statusText, json: async () => { if (body === undefined) throw new Error('no body'); return body },
})

test('requestRefresh posts with the custom header and returns when the server re-read the logs', async () => {
  let seen
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { generatedAt: '2026-10-29T10:00:00Z' })() }
  assert.deepEqual(await requestRefresh('/api/refresh', fetchImpl), { regenerated: true, generatedAt: '2026-10-29T10:00:00Z' })
  assert.equal(seen.url, '/api/refresh')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['X-Requested-With'], 'otelscope')
  assert.equal(seen.init.cache, 'no-store')
})

test('requestRefresh treats "this server cannot do that" as a plain reload, not an error', async () => {
  for (const status of [404, 405, 501]) {
    assert.deepEqual(await requestRefresh('/x', reply(status, undefined)), { regenerated: false }, String(status))
  }
})

test('requestRefresh rejects with the server\'s message, or the status line when there is none', async () => {
  await assert.rejects(requestRefresh('/x', reply(500, { error: 'Log directory not found: /data/logs' })), /Log directory not found: \/data\/logs/)
  await assert.rejects(requestRefresh('/x', reply(500, undefined, 'Internal Server Error')), /500 Internal Server Error/)
  await assert.rejects(requestRefresh('/x', reply(403, { error: 7 })), /403/)
  await assert.rejects(requestRefresh('/x', async () => { throw new TypeError('Failed to fetch') }), /Failed to fetch/)
})

// ---- the zoom window follows the data -------------------------------------------------------------
const DAY = 86_400_000
const oldAxis = { minMs: 0, maxMs: 10 * DAY }
const newAxis = { minMs: 0, maxMs: 12 * DAY }

test('followRange: viewing everything keeps viewing everything', () => {
  assert.deepEqual(followRange({ startMs: 0, endMs: 10 * DAY }, oldAxis, newAxis), { startMs: 0, endMs: 12 * DAY })
})

test('followRange: a window pinned to the newest data slides forward and keeps its width', () => {
  assert.deepEqual(followRange({ startMs: 9 * DAY, endMs: 10 * DAY }, oldAxis, newAxis), { startMs: 11 * DAY, endMs: 12 * DAY })
  // wider than the whole axis after clamping: it cannot start before the axis does
  assert.deepEqual(followRange({ startMs: 5 * DAY, endMs: 10 * DAY }, oldAxis, { minMs: 8 * DAY, maxMs: 12 * DAY }), { startMs: 8 * DAY, endMs: 12 * DAY })
})

test('followRange: a window somewhere in the middle stays where it is', () => {
  const middle = { startMs: 2 * DAY, endMs: 4 * DAY }
  assert.deepEqual(followRange(middle, oldAxis, newAxis), middle)
})

test('followRange: a small float shortfall at the end still counts as the end', () => {
  assert.deepEqual(followRange({ startMs: 9 * DAY, endMs: 10 * DAY - 400 }, oldAxis, newAxis), { startMs: 11 * DAY + 400, endMs: 12 * DAY })
})

// ---- the endpoint ---------------------------------------------------------------------------------
const request = (method = 'POST', headers = { 'x-requested-with': 'otelscope' }) => ({ method, headers })
function response() {
  const res = { headers: {}, statusCode: 0, body: undefined, setHeader(k, v) { res.headers[k] = v }, end(b) { res.body = b } }
  return res
}
const datasets = (generatedAt = '2026-10-29T10:00:00.000Z') => ({ generatedAt, source: '~/otelscope', sources: [] })

test('the endpoint regenerates the data and says when', async () => {
  const calls = []
  const handler = createRefreshHandler({ dir: '/logs', out: '/site/data', build: async (dir) => { calls.push(['build', dir]); return datasets() }, write: (out, d) => calls.push(['write', out, d.generatedAt]) })
  const res = response()
  await handler(request(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'application/json')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(JSON.parse(res.body).generatedAt, '2026-10-29T10:00:00.000Z')
  assert.deepEqual(calls, [['build', '/logs'], ['write', '/site/data', '2026-10-29T10:00:00.000Z']])
})

test('the endpoint refuses anything but a POST that carries the custom header, and does no work for it', async () => {
  let built = 0
  const handler = createRefreshHandler({ dir: '/logs', out: '/o', build: async () => { built++; return datasets() }, write: () => {} })
  const get = response()
  await handler(request('GET'), get)
  assert.equal(get.statusCode, 405)
  assert.equal(get.headers.Allow, 'POST')
  for (const headers of [{}, { 'x-requested-with': 'XMLHttpRequest' }]) {
    const res = response()
    await handler(request('POST', headers), res)
    assert.equal(res.statusCode, 403)
  }
  assert.equal(built, 0)
})

test('the endpoint reports a missing log folder, and hides every other failure behind a fixed message', async () => {
  const fail = (message) => createRefreshHandler({ dir: '/logs', out: '/o', build: async () => { throw new Error(message) }, write: () => {} })
  const missing = response()
  await fail('Log directory not found: /data/logs\nSet OTEL_LOGGER_DIR or pass --dir').call(null, request(), missing)
  assert.equal(missing.statusCode, 500)
  assert.deepEqual(JSON.parse(missing.body), { error: 'Log directory not found: /data/logs' })
  const other = response()
  await fail('EACCES: cannot read /secret/prompt text').call(null, request(), other)
  assert.deepEqual(JSON.parse(other.body), { error: 'could not regenerate the data' })
})

test('overlapping refreshes share one regeneration, and the next one starts fresh', async () => {
  let builds = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const handler = createRefreshHandler({ dir: '/l', out: '/o', build: async () => { builds++; await gate; return datasets() }, write: () => {} })
  const [a, b] = [response(), response()]
  const both = Promise.all([handler(request(), a), handler(request(), b)])
  release()
  await both
  assert.equal(builds, 1)
  assert.equal(a.statusCode, 200)
  assert.equal(b.statusCode, 200)
  await handler(request(), response())
  assert.equal(builds, 2)
})

test('a failed regeneration does not wedge later ones, even when build throws at once', async () => {
  let attempt = 0
  const handler = createRefreshHandler({ dir: '/l', out: '/o', build: () => { if (++attempt === 1) throw new Error('boom'); return datasets() }, write: () => {} })
  const first = response()
  await handler(request(), first)
  assert.equal(first.statusCode, 500)
  const second = response()
  await handler(request(), second)
  assert.equal(second.statusCode, 200)
})

test('the plugin mounts the endpoint on the dev server', () => {
  const mounted = []
  const plugin = refreshDataPlugin({ dir: '/l', out: '/o' })
  plugin.configureServer({ middlewares: { use: (...args) => mounted.push(args) } })
  assert.equal(plugin.name, 'otelscope:refresh-data')
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0][0], '/api/refresh')
  assert.equal(typeof mounted[0][1], 'function')
})

// ---- with the real data step ----------------------------------------------------------------------
const str = (v) => ({ stringValue: v })
const attrs = (o) => Object.entries(o).map(([key, value]) => ({ key, value: str(value) }))
const nano = (s) => String(s * 1_000_000_000)
const resource = { attributes: attrs({ 'service.name': 'claude-code', 'service.version': '2.1.0' }) }
const tokenLine = (t, value) => JSON.stringify({ received_at: 'x', data: { resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [{
  name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [{ attributes: attrs({ type: 'input', 'session.id': 's1' }), startTimeUnixNano: nano(t - 5), timeUnixNano: nano(t), asDouble: value }] } }] }] }] } }) + '\n'
const promptLine = (t, prompt) => JSON.stringify({ received_at: 'x', data: { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [
  { timeUnixNano: nano(t), body: str('claude_code.user_prompt'), attributes: attrs({ 'session.id': 's1', prompt }) }] }] }] } }) + '\n'

test('new activity in the logs shows up after a refresh, and the logs themselves are not touched', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'refresh-'))
  try {
    const logs = path.join(root, 'logs', 'claude'), out = path.join(root, 'out') // the handler reads the log ROOT: one folder per tool
    const { mkdirSync } = await import('node:fs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(path.join(logs, 'metrics.jsonl'), tokenLine(1_760_000_000, 10))
    writeFileSync(path.join(logs, 'logs.jsonl'), promptLine(1_760_000_001, 'first'))
    const before = ['metrics.jsonl', 'logs.jsonl'].map((f) => readFileSync(path.join(logs, f)))

    const handler = createRefreshHandler({ dir: path.join(root, 'logs'), out })
    const read = (...parts) => JSON.parse(readFileSync(path.join(out, 'claude', ...parts), 'utf8'))
    const rows = () => {
      const index = read('logs.json')
      return { tokens: read('usage.json').measures[0].rows.length, prompts: read('logs', `${index.default}.json`).rows.length }
    }
    const res = response()
    await handler(request(), res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(rows(), { tokens: 1, prompts: 1 })

    appendFileSync(path.join(logs, 'metrics.jsonl'), tokenLine(1_760_000_100, 20))
    appendFileSync(path.join(logs, 'logs.jsonl'), promptLine(1_760_000_101, 'second'))
    await handler(request(), response())
    assert.deepEqual(rows(), { tokens: 2, prompts: 2 })

    // the handler only ever read the logs: what was there is still there, byte for byte
    ;['metrics.jsonl', 'logs.jsonl'].forEach((f, i) => assert.ok(readFileSync(path.join(logs, f)).subarray(0, before[i].length).equals(before[i])))
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('a missing log folder is reported and nothing is written', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'refresh-'))
  try {
    const res = response()
    await createRefreshHandler({ dir: path.join(root, 'nope'), out: path.join(root, 'out') })(request(), res)
    assert.equal(res.statusCode, 500)
    assert.match(JSON.parse(res.body).error, /^Log directory not found/)
    assert.equal(existsSync(path.join(root, 'out')), false)
  } finally {
    rmSync(root, { recursive: true })
  }
})

// ---- the data step --------------------------------------------------------------------------------
test('writeDatasets replaces the files in place and leaves no partial file behind', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'write-'))
  try {
    const out = path.join(root, 'data')
    const all = (n) => ({ generatedAt: 't', source: '~/x', sources: [{ id: 'claude', label: 'Claude Code', usage: { a: n }, logs: { index: { b: n }, files: [{ id: 'e1', data: { rows: n } }] } }] })
    const notes = writeDatasets(out, all(1))
    assert.deepEqual(readdirSync(out).sort(), ['claude', 'sources.json'])
    assert.deepEqual(readdirSync(path.join(out, 'claude')).sort(), ['logs', 'logs.json', 'usage.json'])
    assert.deepEqual(readdirSync(path.join(out, 'claude', 'logs')), ['e1.json'])
    assert.match(notes[0], /^claude\/logs\/e1\.json \d+ KB$/) // the rows, then the index that names them
    writeDatasets(out, all(3))
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'claude', 'usage.json'), 'utf8')), { a: 3 })
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'claude', 'logs', 'e1.json'), 'utf8')), { rows: 3 })
    assert.deepEqual(readdirSync(path.join(out, 'claude')).sort(), ['logs', 'logs.json', 'usage.json']) // no .tmp left
    assert.deepEqual(readdirSync(path.join(out, 'claude', 'logs')), ['e1.json'])
  } finally {
    rmSync(root, { recursive: true })
  }
})
