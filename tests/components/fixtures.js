import { vi } from 'vitest'
import { h } from 'vue'
import { mount } from '@vue/test-utils'
import NavActions from '../../docs/.vitepress/components/NavActions.vue'
import { fetchJson } from '../../docs/.vitepress/lib/data.js'
import { requestRefresh } from '../../docs/.vitepress/lib/refresh.js'
import { SCOPE_KEY, createScope } from '../../docs/.vitepress/lib/scope.js'

// Small datasets in the shape scripts/prepare-data.mjs writes.
export const localSeconds = (...args) => Math.round(new Date(...args).getTime() / 1000)
export const day = (d, h = 12, m = 0) => localSeconds(2026, 9, d, h, m)

const SESSIONS = [
  'aaaaaaaa-1111-4111-8111-111111111111',
  'bbbbbbbb-2222-4222-8222-222222222222',
  'cccccccc-3333-4333-8333-333333333333',
]

// The measures' keys, as the data step writes them.
export const TOKEN_USAGE = 'claude_code.token.usage'
export const COST_USAGE = 'claude_code.cost.usage'
export const CODE_LINES = 'claude_code.lines_of_code.count'
export const FIELDS = ['service.name', 'service.version', 'app.entrypoint', 'session.id', 'model', 'vcs.repository.name', 'terminal.type', 'type']

export function makeUsage(overrides = {}) {
  // row: [time, value, service.name, service.version, app.entrypoint, session.id, model, vcs.repository.name, terminal.type, type]
  // Repo follows the session: session 0 -> alpha, 1 -> beta, 2 -> (none) (a session outside any git repo).
  // Terminal: the 22 Oct session ran in iTerm, the others in VS Code.
  // The 10:00 bucket on day 20 holds two models in one segment (claude-code), to exercise the hover split.
  // type: 0 input, 1 output, 2 cacheRead, 3 cacheCreation, 4 added, 5 removed, 6 (none)
  const tokens = [
    [day(20, 10), 1000, 0, 0, 0, 0, 0, 0, 0, 0], [day(20, 10), 200, 0, 0, 0, 0, 1, 0, 0, 1], [day(20, 10), 50000, 0, 0, 0, 0, 0, 0, 0, 2],
    [day(21, 11), 3000, 1, 0, 1, 1, 1, 1, 0, 0], [day(21, 11), 400, 1, 0, 1, 1, 1, 1, 0, 1],
    [day(22, 9), 700, 0, 0, 0, 2, 0, 2, 1, 0], [day(22, 9), 90, 0, 0, 0, 2, 1, 2, 1, 3],
  ]
  const cost = [
    [day(20, 10), 0.5, 0, 0, 0, 0, 0, 0, 0, 6], [day(21, 11), 1.5, 1, 0, 1, 1, 1, 1, 0, 6], [day(22, 9), 0.25, 0, 0, 0, 2, 0, 2, 1, 6],
  ]
  const code = [
    [day(20, 10), 10, 0, 0, 0, 0, 0, 0, 0, 4], [day(20, 10), 3, 0, 0, 0, 0, 0, 0, 0, 5], [day(21, 11), 7, 1, 0, 1, 1, 1, 1, 0, 4],
  ]
  return {
    generatedAt: new Date(2026, 9, 28, 13, 0, 0).toISOString(),
    source: '~/otelscope/claude',
    fields: FIELDS,
    dict: {
      'service.name': ['claude-code', 'claude-code-desktop'],
      'service.version': ['2.1.0'],
      'app.entrypoint': ['cli', 'claude-desktop'],
      'session.id': SESSIONS,
      model: ['claude-sonnet-5-5', 'claude-opus-5-5'],
      'vcs.repository.name': ['alpha', 'beta', '(none)'],
      'terminal.type': ['vscode', 'iTerm.app'],
      type: ['input', 'output', 'cacheRead', 'cacheCreation', 'added', 'removed', '(none)'],
    },
    extent: [day(20, 10), day(22, 9)],
    sessionField: 'session.id',
    modelField: 'model',
    sessions: [
      { idx: 0, id: SESSIONS[0], start: day(20, 10), end: day(20, 10), repo: 'alpha', cost: 0.5, first: 'Fix the pixi environment' },
      { idx: 1, id: SESSIONS[1], start: day(21, 11), end: day(21, 11), repo: 'beta', cost: 1.5, first: 'Write a README for the logger' },
      { idx: 2, id: SESSIONS[2], start: day(22, 9), end: day(22, 9), repo: '', cost: 0.25, first: '' },
    ],
    measures: [
      { key: TOKEN_USAGE, label: 'Token usage', unit: 'tokens', format: 'number', rows: tokens },
      { key: COST_USAGE, label: 'Cost usage (USD)', unit: 'USD', format: 'usd', rows: cost },
      { key: CODE_LINES, label: 'Lines of code count', unit: '', format: 'number', rows: code },
    ],
    ...overrides,
  }
}

export const rowsOf = (usage, key) => usage.measures.find((m) => m.key === key).rows
export const sumBy = (rows, filter = () => true) => rows.filter(filter).reduce((a, r) => a + r[1], 0)

/** One kind of log event, as the Logs table loads it: rows of the 'user_prompt' event, newest last (the table sorts). */
export function makeEventFile(count = 130, { name = 'user_prompt', kind = 'log' } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    time: day(1) + i * 600,
    'session.id': `sess-${i % 5}`,
    prompt: i === 3 || i === 77 ? `please find the needle number ${i}` : `Prompt number ${i}`,
    'app.version': '2.1.0',
    'user.email': 'someone@example.com',
  }))
  rows[count - 1].prompt = `Long prompt line one\n${'x'.repeat(300)}` // newest row, long and multi-line
  rows[count - 2].prompt = '<img src=x onerror="window.__pwned = true"> and <b>bold</b>' // short: plain cell
  rows[count - 3].prompt = `<img src=x onerror="window.__pwned2 = true"> ${'y'.repeat(300)}` // long: expandable cell
  return {
    kind,
    name,
    fields: ['time', 'session.id', 'prompt', 'app.version', 'user.email'],
    defaultColumns: ['time', 'session.id', 'prompt'],
    searchFields: ['session.id', 'prompt'],
    rows,
  }
}

/** The index of a folder's Logs: three kinds, the first of which the table opens on. */
export function makeLogsIndex(promptCount = 130) {
  return {
    generatedAt: new Date(2026, 9, 28, 13, 0, 0).toISOString(),
    source: '~/otelscope/claude',
    default: 'e1',
    events: [
      { id: 'e1', kind: 'log', name: 'user_prompt', count: promptCount, first: day(1), last: day(2) },
      { id: 'e2', kind: 'log', name: 'api_request', count: 2, first: day(21, 10), last: day(22, 11) },
      { id: 'e3', kind: 'span', name: 'chat gpt-a', count: 1, first: day(21, 10), last: day(21, 10) },
    ],
  }
}

export function makeApiRequests() {
  const fields = ['time', 'session.id', 'model', 'input_tokens', 'output_tokens', 'duration_ms']
  return {
    kind: 'log',
    name: 'api_request',
    fields,
    defaultColumns: fields,
    searchFields: ['session.id', 'model'],
    rows: [
      { time: day(21, 10), 'session.id': 'sess-one', model: 'gpt-a', input_tokens: 1000, output_tokens: 50, duration_ms: 900 },
      { time: day(22, 11), 'session.id': '(none)', model: 'gpt-b', input_tokens: 2000, output_tokens: 20, duration_ms: 400 },
    ],
  }
}

export function makeSpans() {
  const fields = ['time', 'duration_ms', 'gen_ai.request.model']
  return {
    kind: 'span',
    name: 'chat gpt-a',
    fields,
    defaultColumns: fields,
    searchFields: ['gen_ai.request.model'],
    rows: [{ time: day(21, 10), duration_ms: 1200, 'gen_ai.request.model': 'gpt-a' }],
  }
}

/** A folder's Logs as the URL -> JSON files of a dev server, for a source id. */
export function logsFiles(source = 'claude', promptCount = 130) {
  return {
    [`/data/${source}/logs.json`]: makeLogsIndex(promptCount),
    [`/data/${source}/logs/e1.json`]: makeEventFile(promptCount),
    [`/data/${source}/logs/e2.json`]: makeApiRequests(),
    [`/data/${source}/logs/e3.json`]: makeSpans(),
  }
}

/**
 * What a very different tool sends: tokens by model and kind, a count of calls, and no session, cost or folder at all.
 * Its fields are not the ones Claude Code has, which is the point.
 */
export function makeOtherUsage(overrides = {}) {
  // row: [time, value, service.name, gen_ai.request.model, gen_ai.token.type]
  const tokens = [
    [day(21, 10), 1000, 0, 0, 0], [day(21, 10), 50, 0, 0, 1],
    [day(22, 11), 2000, 0, 1, 0], [day(22, 11), 20, 0, 1, 1],
  ]
  const calls = [[day(21, 10), 1, 0, 0, 0], [day(22, 11), 1, 0, 1, 0]]
  return {
    generatedAt: new Date(2026, 9, 28, 13, 0, 0).toISOString(),
    source: '~/otelscope/vscode',
    fields: ['service.name', 'gen_ai.request.model', 'gen_ai.token.type'],
    dict: { 'service.name': ['copilot-chat'], 'gen_ai.request.model': ['gpt-a', 'gpt-b'], 'gen_ai.token.type': ['input', 'output'] },
    extent: [day(21, 10), day(22, 11)],
    sessionField: null,
    modelField: 'gen_ai.request.model',
    sessions: [],
    measures: [
      { key: 'gen_ai.client.token.usage', label: 'Gen AI client token usage', unit: '', format: 'number', rows: tokens },
      { key: 'gen_ai.client.token.usage#count', label: 'Gen AI client token usage (count)', unit: '', format: 'number', rows: calls },
    ],
    ...overrides,
  }
}

/**
 * A stand-in for the dev server: serves data files and answers POST /api/refresh.
 * `server.data` is the file at `dataUrl`; `server.files` holds every file by URL (pass more in `more`).
 * Change them, `dataStatus` and `refresh` between steps; set `hold` to a promise to keep the refresh pending.
 */
export function makeServer(dataUrl, data, more = {}) {
  const server = { files: { [dataUrl]: data, ...more }, dataStatus: 200, refresh: { status: 200, body: { generatedAt: '2026-10-28T14:00:00.000Z' } }, hold: null, calls: [] }
  Object.defineProperty(server, 'data', { get: () => server.files[dataUrl], set: (v) => { server.files[dataUrl] = v } })
  const reply = (status, body) => ({
    ok: status < 300, status, statusText: `S${status}`,
    json: async () => { if (body === undefined) throw new Error('no body'); return body },
  })
  server.fetch = vi.fn(async (url, init = {}) => {
    server.calls.push({ url, method: init.method ?? 'GET', headers: init.headers })
    if (url === '/api/refresh') {
      if (server.hold) await server.hold
      return reply(server.refresh.status, server.refresh.body)
    }
    if (url === dataUrl && server.dataStatus >= 300) return reply(server.dataStatus, undefined)
    if (!(url in server.files)) return reply(404, undefined)
    return reply(200, server.files[url])
  })
  server.requests = () => server.calls.map((c) => `${c.method} ${c.url}`)
  return server
}

export const SOURCES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'vscode', label: 'VS Code Copilot' },
  { id: 'opencode', label: 'OpenCode' },
]

/**
 * The state the navbar and the page share, as theme/index.ts builds it. By default the tab list is a fixed one; pass
 * `fromFiles: true` to read /data/sources.json through the (stubbed) fetch, like the real site.
 */
export function makeScope({ sources = SOURCES, fromFiles = false } = {}) {
  return createScope({
    fetchSources: fromFiles ? async () => (await fetchJson('/data/sources.json')).sources : async () => sources,
    refresh: () => requestRefresh('/api/refresh'),
  })
}

export const provideScope = (scope) => ({ global: { provide: { [SCOPE_KEY]: scope } } })

/** A view mounted together with the navbar (where Refresh now lives), sharing one scope. */
export function mountWithNav(component, props = {}, scope = makeScope()) {
  const Harness = { render: () => h('div', [h(NavActions), h(component, props)]) }
  const wrapper = mount(Harness, { attachTo: document.body, ...provideScope(scope) })
  return { wrapper, scope }
}
