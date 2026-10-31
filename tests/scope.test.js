import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScope } from '../docs/.vitepress/lib/scope.js'

const SOURCES = [
  { id: 'claude', label: 'Claude Code', kind: 'claude' },
  { id: 'vscode', label: 'VS Code Copilot', kind: 'copilot-chat' },
  { id: 'codex', label: 'Codex', kind: 'generic' },
]

/** A fake address bar that remembers what was written and lets a test fire "the address changed". */
function makeAddress(hash = '') {
  const address = { hash, listeners: new Set(), writes: [] }
  address.read = () => address.hash
  address.write = (h) => { address.hash = h; address.writes.push(h) }
  address.listen = (fn) => { address.listeners.add(fn); return () => address.listeners.delete(fn) }
  address.change = (h) => { address.hash = h; for (const fn of address.listeners) fn() }
  return address
}

function makeScope(options = {}) {
  const timers = []
  const state = { sources: SOURCES, refreshCalls: 0, refreshResult: { regenerated: true }, ...options.state }
  const scope = createScope({
    fetchSources: async () => {
      if (state.sourcesError) throw new Error(state.sourcesError)
      return state.sources
    },
    refresh: async () => {
      state.refreshCalls++
      if (state.hold) await state.hold
      if (state.refreshError) throw new Error(state.refreshError)
      return state.refreshResult
    },
    address: options.address ?? makeAddress(),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].canceled = true },
  })
  return { scope, state, timers }
}

test('start reads the tab list and opens the tool and view the address names', async () => {
  const address = makeAddress('#vscode/logs')
  const { scope } = makeScope({ address })
  assert.equal(scope.status.value, 'loading')
  await scope.start()
  assert.equal(scope.status.value, 'ready')
  assert.deepEqual([scope.tool.value, scope.view.value], ['vscode', 'logs'])
  assert.deepEqual(scope.views.value, ['usage', 'logs'])
})

test('an address for a tool that does not exist opens the first tool and its first view', async () => {
  const { scope } = makeScope({ address: makeAddress('#nope/logs') })
  await scope.start()
  assert.deepEqual([scope.tool.value, scope.view.value], ['claude', 'usage'])
})

test('choose shows the view and puts it in the address; the address changing is followed too', async () => {
  const address = makeAddress()
  const { scope } = makeScope({ address })
  await scope.start()
  scope.choose('claude', 'logs')
  assert.deepEqual([scope.tool.value, scope.view.value], ['claude', 'logs'])
  assert.deepEqual(address.writes, ['#claude/logs'])

  scope.choose('vscode') // a tool with no view named starts on its first
  assert.deepEqual([scope.tool.value, scope.view.value], ['vscode', 'usage'])

  address.change('#claude/usage') // the back button
  assert.deepEqual([scope.tool.value, scope.view.value], ['claude', 'usage'])
})

test('stopping stops listening to the address', async () => {
  const address = makeAddress()
  const { scope } = makeScope({ address })
  const stop = await scope.start()
  assert.equal(address.listeners.size, 1)
  stop()
  assert.equal(address.listeners.size, 0)
})

test('a tab list that cannot be read is an error with its message, not a crash', async () => {
  const { scope } = makeScope({ state: { sourcesError: '404 Not Found' } })
  await scope.start()
  assert.equal(scope.status.value, 'error')
  assert.equal(scope.errorMessage.value, '404 Not Found')
  assert.deepEqual(scope.views.value, [])
})

test('refresh asks the server, then reads the tab list and every registered view', async () => {
  const { scope, state } = makeScope()
  await scope.start()
  const order = []
  scope.register(async () => order.push('usage view'))
  scope.register(async () => order.push('another view'))
  state.sources = [...SOURCES, { id: 'opencode', label: 'OpenCode', kind: 'generic' }]
  await scope.refresh()
  assert.equal(state.refreshCalls, 1)
  assert.deepEqual(order.sort(), ['another view', 'usage view'])
  assert.equal(scope.sources.value.length, 4) // the new folder has its tab
  assert.equal(scope.note.value, 'Data refreshed.')
  assert.equal(scope.failed.value, false)
  assert.equal(scope.refreshing.value, false)
})

test('a view that unregistered is not asked again', async () => {
  const { scope } = makeScope()
  await scope.start()
  let calls = 0
  const unregister = scope.register(async () => { calls++ })
  await scope.refresh()
  unregister()
  await scope.refresh()
  assert.equal(calls, 1)
})

test('the choice stays through a refresh, and moves on only when its tab is gone', async () => {
  const { scope, state } = makeScope({ address: makeAddress('#vscode/logs') })
  await scope.start()
  await scope.refresh()
  assert.deepEqual([scope.tool.value, scope.view.value], ['vscode', 'logs'])

  state.sources = SOURCES.filter((s) => s.id !== 'vscode')
  await scope.refresh()
  assert.equal(scope.tool.value, 'claude')
})

test('one view failing is said, and the others are still refreshed', async () => {
  const { scope } = makeScope()
  await scope.start()
  let other = 0
  scope.register(async () => { throw new Error('there is no usage data in the logs yet') })
  scope.register(async () => { other++ })
  await scope.refresh()
  assert.equal(other, 1)
  assert.equal(scope.failed.value, true)
  assert.equal(scope.note.value, 'Refresh failed: there is no usage data in the logs yet')
})

test('the server failing is said, and nothing is re-read', async () => {
  const { scope, state } = makeScope()
  await scope.start()
  let reloads = 0
  scope.register(async () => { reloads++ })
  state.refreshError = 'Log directory not found: /data/logs'
  await scope.refresh()
  assert.equal(reloads, 0)
  assert.equal(scope.note.value, 'Refresh failed: Log directory not found: /data/logs')
  assert.equal(scope.failed.value, true)
  assert.equal(scope.refreshing.value, false) // it can be tried again
})

test('a server that cannot re-read the logs (a static build) is a plain reload, said so', async () => {
  const { scope, state } = makeScope()
  await scope.start()
  state.refreshResult = { regenerated: false }
  await scope.refresh()
  assert.match(scope.note.value, /cannot re-read the logs/)
  assert.equal(scope.failed.value, false)
})

test('it recovers a page whose tab list failed to load', async () => {
  const { scope, state } = makeScope({ state: { sourcesError: 'boom' } })
  await scope.start()
  assert.equal(scope.status.value, 'error')
  state.sourcesError = null
  await scope.refresh()
  assert.equal(scope.status.value, 'ready')
  assert.equal(scope.sources.value.length, 3)
  assert.equal(scope.tool.value, 'claude')
})

test('a folder that could not be read gets its views once it can, so the page is not left blank', async () => {
  const unreadable = SOURCES.map((s) => (s.id === 'claude' ? { ...s, error: 'needs the protobuf libraries' } : s))
  const { scope, state } = makeScope({ state: { sources: unreadable }, address: makeAddress('#claude/logs') })
  await scope.start()
  assert.deepEqual([scope.tool.value, scope.view.value, scope.views.value], ['claude', '', []]) // an error to show, no view
  state.sources = SOURCES // the libraries were installed; Refresh reads the folder
  await scope.refresh()
  assert.deepEqual([scope.tool.value, scope.view.value], ['claude', 'logs']) // the view the address names
})

test('overlapping refreshes make one request', async () => {
  const { scope, state } = makeScope()
  await scope.start()
  let release
  state.hold = new Promise((resolve) => { release = resolve })
  const first = scope.refresh()
  assert.equal(scope.refreshing.value, true)
  await scope.refresh() // ignored while the first is working
  release()
  await first
  assert.equal(state.refreshCalls, 1)
})

test('a success note goes away by itself; a failure stays until dismissed or the next refresh', async () => {
  const { scope, state, timers } = makeScope()
  await scope.start()
  await scope.refresh()
  assert.equal(scope.note.value, 'Data refreshed.')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 6000)
  timers[0].fn()
  assert.equal(scope.note.value, '')

  state.refreshError = 'boom'
  await scope.refresh()
  assert.equal(scope.note.value, 'Refresh failed: boom')
  assert.equal(timers.length, 1) // no timer for a failure
  scope.dismiss()
  assert.equal(scope.note.value, '')

  await scope.refresh() // a new refresh clears the old note first
  assert.equal(scope.failed.value, true)
  state.refreshError = null
  await scope.refresh()
  assert.equal(scope.failed.value, false)
  assert.equal(scope.note.value, 'Data refreshed.')
})
