// The state the navbar and the page share: which tool and view are showing, the tab list, and "Refresh".
// One instance per app (see theme/index.ts), handed to components with provide/inject, so a test can build its own.
import { computed, inject, ref, shallowRef } from 'vue'
import { hashFor, parseHash, viewsOf } from './tabs.js'

export const SCOPE_KEY = Symbol('otelscope')
export const useScope = () => {
  const scope = inject(SCOPE_KEY, null)
  if (!scope) throw new Error('otelscope: no scope was provided to this app')
  return scope
}

/** The address bar as the store sees it, so the store itself never touches `window` (it also runs while the site is built). */
export function browserAddress() {
  return {
    read: () => window.location.hash,
    write: (hash) => {
      window.location.hash = hash
    },
    listen: (fn) => {
      window.addEventListener('hashchange', fn)
      return () => window.removeEventListener('hashchange', fn)
    },
  }
}

const NOTE_SECONDS = 6 // how long "Data refreshed." stays up; a failure stays until the next refresh or until it is dismissed

/**
 * @param fetchSources  () => Promise<source[]>: reads the tab list (/data/sources.json)
 * @param refresh       () => Promise<{ regenerated: boolean }>: asks the server to re-read the logs
 */
export function createScope({ fetchSources, refresh, address = browserAddress(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const status = ref('loading') // loading | ready | error
  const errorMessage = ref('')
  const sources = shallowRef([])
  const tool = ref('')
  const view = ref('')
  const refreshing = ref(false)
  const note = ref('')
  const failed = ref(false)

  const current = computed(() => sources.value.find((s) => s.id === tool.value))
  const views = computed(() => (current.value ? viewsOf(current.value) : []))

  function syncFromAddress() {
    const next = parseHash(address.read(), sources.value)
    tool.value = next.tool
    view.value = next.view
  }

  /** Show a tool, and a view of it (its first when none is named). The address keeps the choice across a reload. */
  function choose(nextTool, nextView) {
    const target = parseHash(hashFor(nextTool, nextView ?? ''), sources.value)
    tool.value = target.tool
    view.value = target.view
    address.write(hashFor(target.tool, target.view))
  }

  /** Reads the tab list again: a new folder gets its tab, and the choice stays unless its tab is gone or has no such view (a folder that failed to read has none, and gets them once it can be read). */
  async function loadSources() {
    sources.value = await fetchSources()
    if (!sources.value.some((s) => s.id === tool.value) || !views.value.includes(view.value)) syncFromAddress()
    status.value = 'ready'
  }

  /** Called once by the page when it mounts. Returns the function that stops listening to the address. */
  async function start() {
    const stop = address.listen(syncFromAddress)
    try {
      sources.value = await fetchSources()
      syncFromAddress()
      status.value = 'ready'
    } catch (err) {
      errorMessage.value = String(err?.message ?? err)
      status.value = 'error'
    }
    return stop
  }

  // The views on screen register how to re-read their own data, so one Refresh updates whatever is showing while
  // each keeps its zoom, search, columns and page. Views not on screen read fresh data when they are opened.
  const reloaders = new Set()
  function register(reload) {
    reloaders.add(reload)
    return () => reloaders.delete(reload)
  }

  let noteTimer = null
  function say(text, isFailure) {
    clearTimer(noteTimer)
    note.value = text
    failed.value = isFailure
    if (text && !isFailure) noteTimer = setTimer(() => (note.value = ''), NOTE_SECONDS * 1000)
  }
  const dismiss = () => say('', false)

  /** Re-read every tool's logs on the server, then what is on screen. Never throws: a failure is said in `note`. */
  async function refreshAll() {
    if (refreshing.value) return
    refreshing.value = true
    say('', false)
    try {
      const { regenerated } = await refresh()
      const results = await Promise.allSettled([loadSources(), ...[...reloaders].map((reload) => reload())])
      const bad = results.find((r) => r.status === 'rejected')
      if (bad) throw bad.reason
      say(regenerated ? 'Data refreshed.' : 'Data reloaded. This server cannot re-read the logs, so run npm run data first for newer activity.', false)
    } catch (err) {
      say(`Refresh failed: ${err?.message ?? err}`, true)
    } finally {
      refreshing.value = false
    }
  }

  return { status, errorMessage, sources, tool, view, current, views, refreshing, note, failed, choose, start, register, loadSources, refresh: refreshAll, dismiss }
}
