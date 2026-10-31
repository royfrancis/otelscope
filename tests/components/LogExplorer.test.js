import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LogExplorer from '../../docs/.vitepress/components/LogExplorer.vue'
import { formatDateTime } from '../../docs/.vitepress/lib/aggregate.js'
import { logsFiles, makeEventFile, makeLogsIndex, makeScope, makeServer, mountWithNav, provideScope } from './fixtures.js'

vi.mock('vitepress', async () => {
  const { ref } = await import('vue')
  return { withBase: (p) => p, useData: () => ({ isDark: ref(false) }) }
})

const INDEX = '/data/claude/logs.json'
const E1 = '/data/claude/logs/e1.json'
const data = makeEventFile(130) // 130 rows / 20 per page = 7 pages
let wrapper

/** A server holding the folder's Logs: the index, and one file per kind of event. */
const serverWith = (files = logsFiles('claude')) => makeServer(INDEX, files[INDEX], Object.fromEntries(Object.entries(files).filter(([url]) => url !== INDEX)))

async function open(files = logsFiles('claude')) {
  vi.stubGlobal('fetch', serverWith(files).fetch)
  wrapper = mount(LogExplorer, { attachTo: document.body, ...provideScope(makeScope()) })
  for (let i = 0; i < 4; i++) await flushPromises()
}

const headers = () => wrapper.findAll('thead th').map((th) => th.text())
const bodyRows = () => wrapper.findAll('tbody tr')
const pageButtons = () => wrapper.findAll('button[aria-label^="Page"]')
const pageLabels = () => pageButtons().map((b) => b.text())
const currentPage = () => wrapper.find('.viz-pager button[aria-current="page"]')?.text()
const eventSelect = () => wrapper.find('.viz-event select')
const eventLabels = () => eventSelect().findAll('option').map((o) => o.text())

beforeEach(() => {
  delete window.__pwned
})
afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
})

describe('LogExplorer', () => {
  it('opens on the kind the data names, showing its own columns, newest first, 20 per page', async () => {
    await open()
    expect(headers()).toEqual(['Date / time', 'session.id', 'prompt'])
    expect(bodyRows()).toHaveLength(20)
    const newest = data.rows.at(-1)
    expect(bodyRows()[0].findAll('td')[0].text()).toBe(formatDateTime(newest.time))
    expect(bodyRows()[0].findAll('td')[1].text()).toBe(newest['session.id'])
    expect(wrapper.find('caption').text()).toContain('Events, newest first')
  })

  it('shows only 5 page buttons at first', async () => {
    await open()
    expect(pageLabels()).toEqual(['1', '2', '3', '4', '5'])
    expect(currentPage()).toBe('1')
    expect(wrapper.text()).toContain('Showing 1–20 of 130 events')
    expect(wrapper.text()).toContain('click page 5 to load more pages')
  })

  it('clicking the last visible page loads the next pages', async () => {
    await open()
    await pageButtons()[3].trigger('click') // page 4: nothing new
    expect(pageLabels()).toHaveLength(5)
    await pageButtons()[4].trigger('click') // page 5: the last one shown
    expect(currentPage()).toBe('5')
    expect(pageLabels()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(wrapper.text()).toContain('Showing 81–100 of 130 events')
    expect(wrapper.text()).not.toContain('to load more pages')
  })

  it('Next and Previous move between pages', async () => {
    await open()
    const next = () => wrapper.findAll('nav button').at(-1)
    const prev = () => wrapper.findAll('nav button')[0]
    expect(prev().attributes('disabled')).toBeDefined()
    for (let i = 0; i < 5; i++) await next().trigger('click') // runs past page 5, loading more
    expect(currentPage()).toBe('6')
    expect(pageLabels()).toHaveLength(7)
    await prev().trigger('click')
    expect(currentPage()).toBe('5')
  })

  it('searches the fields the data names, and resets to page 1 with 5 page buttons', async () => {
    await open()
    expect(wrapper.find('#log-search').attributes('placeholder')).toBe('Search session.id, prompt')
    await pageButtons()[4].trigger('click') // expand to 7 pages, sit on page 5
    await wrapper.find('#log-search').setValue('needle')
    expect(bodyRows()).toHaveLength(2)
    expect(wrapper.text()).toContain('Showing 1–2 of 2 events')
    expect(pageLabels()).toEqual(['1'])

    await wrapper.find('#log-search').setValue('sess-4')
    expect(wrapper.text()).toContain('of 26 events') // 130 / 5 sessions
    expect(currentPage()).toBe('1')
    expect(pageLabels()).toEqual(['1', '2'])

    await wrapper.find('#log-search').setValue('no such thing')
    expect(wrapper.text()).toContain('No events match “no such thing”.')
    expect(wrapper.text()).toContain('0 events')
  })

  it('lets you choose which columns to display', async () => {
    await open()
    expect(wrapper.find('summary').text()).toContain('Columns (3)')
    const box = (name) => wrapper.findAll('.viz-menu-list label').find((l) => l.text() === name).find('input')

    await box('app.version').setValue(true)
    expect(headers()).toEqual(['Date / time', 'session.id', 'prompt', 'app.version'])
    expect(bodyRows()[0].findAll('td')[3].text()).toBe('2.1.0')

    await box('session.id').setValue(false)
    expect(headers()).toEqual(['Date / time', 'prompt', 'app.version'])

    await wrapper.find('.viz-menu-foot button').trigger('click') // Reset
    expect(headers()).toEqual(['Date / time', 'session.id', 'prompt'])

    await wrapper.find('input[aria-label="Filter columns"]').setValue('email')
    expect(wrapper.findAll('.viz-menu-list label').map((l) => l.text())).toEqual(['user.email'])
  })

  it('collapses long text and expands it on click', async () => {
    await open()
    const cell = () => bodyRows()[0].findAll('td')[2]
    expect(cell().find('.cell-text').classes()).toContain('is-clamped')
    expect(cell().text()).toContain('Show more')
    await cell().find('button').trigger('click')
    expect(cell().find('.cell-text').classes()).not.toContain('is-clamped')
    expect(cell().find('button').attributes('aria-expanded')).toBe('true')
    expect(cell().text()).toContain('Show less')
  })

  it('renders text as text, never as HTML, in both short and expandable cells', async () => {
    await open()
    const short = bodyRows()[1].findAll('td')[2] // short text containing markup
    const long = bodyRows()[2].findAll('td')[2] // long text containing markup (expandable cell)
    expect(short.find('button').exists()).toBe(false)
    expect(long.find('button').exists()).toBe(true)
    expect(short.text()).toContain('<img src=x onerror=')
    expect(long.text()).toContain('<img src=x onerror=')
    expect(wrapper.find('tbody img').exists()).toBe(false)
    expect(wrapper.find('tbody b').exists()).toBe(false)
    await long.find('button').trigger('click') // expanding must not turn it into HTML either
    expect(wrapper.find('tbody img').exists()).toBe(false)
    expect(window.__pwned).toBeUndefined()
    expect(window.__pwned2).toBeUndefined()
  })

  it('lines numbers up, gives long text room, and sets ids in monospace, from what the rows hold', async () => {
    await open({ ...logsFiles('claude'), '/data/claude/logs/e1.json': (() => {
      const f = makeEventFile(5)
      f.fields = ['time', 'session.id', 'prompt', 'tokens']
      f.defaultColumns = f.fields
      f.rows.forEach((r, i) => { r.tokens = 100 + i; r.prompt = 'p'.repeat(100) })
      return f
    })() })
    const cell = (row, i) => bodyRows()[row].findAll('td')[i]
    expect(cell(0, 0).classes()).toContain('nowrap') // the time
    expect(cell(0, 1).classes()).toContain('mono') // an id
    expect(cell(0, 2).classes()).toContain('wide') // text longer than a line
    expect(cell(0, 3).classes()).toContain('num') // a number
    expect(cell(0, 2).classes()).not.toContain('num')
  })

  it('explains how to fix a failed load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })))
    wrapper = mount(LogExplorer, { attachTo: document.body, ...provideScope(makeScope()) })
    await flushPromises()
    expect(wrapper.text()).toContain('Could not load /data/claude/logs.json')
    expect(wrapper.text()).toContain('npm run dev')
  })

  it('says the data file is out of date, rather than crashing, when it predates event kinds', async () => {
    await open({ ...logsFiles('claude'), [INDEX]: { generatedAt: new Date().toISOString(), source: '~/x', rows: [] } })
    expect(wrapper.text()).toContain('out of date')
    expect(wrapper.text()).toContain('npm run data')
  })

  it('handles a kind with no rows, and a folder with no events at all', async () => {
    await open({ ...logsFiles('claude'), [E1]: { ...data, rows: [] } })
    expect(wrapper.text()).toContain('No events in the logs yet.')
    expect(pageLabels()).toEqual(['1'])
    wrapper.unmount()

    await open({ [INDEX]: { generatedAt: new Date().toISOString(), source: '~/x', events: [], default: null } })
    expect(wrapper.text()).toContain('No log events or spans in the logs yet.')
    expect(wrapper.find('.viz-event').exists()).toBe(false)
  })
})

describe('the Event dropdown', () => {
  it('lists the kinds the logs hold, log events and then spans, each with how many rows it has', async () => {
    await open()
    expect(wrapper.findAll('.viz-event optgroup').map((g) => g.attributes('label'))).toEqual(['Log events', 'Spans'])
    expect(eventLabels()).toEqual(['user_prompt (130)', 'api_request (2)', 'chat gpt-a (1)'])
    expect(eventSelect().element.value).toBe('e1') // the one the data says to open on
  })

  it('is one flat list when there is only one sort of thing', async () => {
    const files = logsFiles('claude')
    files[INDEX] = { ...files[INDEX], events: files[INDEX].events.filter((e) => e.kind === 'log') }
    await open(files)
    expect(wrapper.findAll('.viz-event optgroup')).toHaveLength(0)
    expect(eventLabels()).toEqual(['user_prompt (130)', 'api_request (2)'])
  })

  it('shows another kind with its own columns, a fresh search and the first page', async () => {
    await open()
    await wrapper.find('#log-search').setValue('needle')
    await pageButtons()[0].trigger('click')
    await eventSelect().setValue('e2')
    await flushPromises()
    expect(headers()).toEqual(['Date / time', 'session.id', 'model', 'input_tokens', 'output_tokens', 'duration_ms'])
    expect(wrapper.find('#log-search').element.value).toBe('') // a search for one kind means nothing for another
    expect(bodyRows()).toHaveLength(2)
    expect(wrapper.text()).toContain('of 2 events')
    expect(wrapper.find('#log-search').attributes('placeholder')).toBe('Search session.id, model')
    expect(wrapper.find('summary').text()).toContain('Columns (6)')
    await wrapper.find('#log-search').setValue('gpt-b')
    expect(bodyRows()).toHaveLength(1)
    expect(wrapper.find('tbody').text()).toContain('2000')
  })

  it('calls the rows of a span spans', async () => {
    await open()
    await eventSelect().setValue('e3')
    await flushPromises()
    expect(wrapper.find('caption').text()).toContain('Spans, newest first')
    expect(wrapper.text()).toContain('of 1 span')
    expect(headers()).toEqual(['Date / time', 'duration_ms', 'gen_ai.request.model'])
  })

  it('reads a kind\'s file only when it is chosen', async () => {
    const server = serverWith()
    vi.stubGlobal('fetch', server.fetch)
    wrapper = mount(LogExplorer, { attachTo: document.body, ...provideScope(makeScope()) })
    for (let i = 0; i < 4; i++) await flushPromises()
    expect(server.requests()).toEqual([`GET ${INDEX}`, `GET ${E1}`])
    await eventSelect().setValue('e2')
    await flushPromises()
    expect(server.requests().at(-1)).toBe('GET /data/claude/logs/e2.json')
  })

  it('keeps the table, and says why, when the chosen kind cannot be read', async () => {
    const files = logsFiles('claude')
    delete files['/data/claude/logs/e2.json']
    await open(files)
    await eventSelect().setValue('e2')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('Could not load /data/claude/logs/e2.json (404 S404)')
    expect(headers()).toEqual(['Date / time', 'session.id', 'prompt']) // still the table that was there
    expect(eventSelect().element.value).toBe('e1')
    await eventSelect().setValue('e3') // and another choice works, and clears the message
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(headers()).toContain('duration_ms')
  })
})

describe('refresh data', () => {
  const settle = async () => {
    for (let i = 0; i < 6; i++) await flushPromises()
    await wrapper.vm.$nextTick()
  }
  async function openFrom(server) {
    vi.stubGlobal('fetch', server.fetch)
    wrapper = mountWithNav(LogExplorer, {}, makeScope()).wrapper // Refresh is in the navbar, which shares the scope
    await settle()
  }
  const button = () => wrapper.find('.otel-nav-btn.is-refresh')
  const note = () => wrapper.find('.otel-toast')
  const status = () => wrapper.find('.viz-status').text()
  const click = async () => {
    await button().trigger('click')
    await settle()
  }
  const requests = [`GET ${INDEX}`, `GET ${E1}`, 'POST /api/refresh', `GET ${INDEX}`, `GET ${E1}`]
  const server = (count = 130) => serverWith(logsFiles('claude', count))
  /** The same logs a while later: more rows of the first kind. */
  const later = (s, count) => {
    const next = logsFiles('claude', count)
    s.files[INDEX] = next[INDEX]
    s.files[E1] = next[E1]
  }

  it('says the data was "updated", and Refresh is in the navbar, not on the page', async () => {
    await openFrom(server())
    expect(button().text()).toBe('Refresh')
    expect(wrapper.find('.viz-root').text()).not.toContain('Refresh data')
    expect(wrapper.find('.viz-sub').text()).toContain('updated')
  })

  it('asks the server to re-read the logs, then shows the new rows, newest first', async () => {
    const s = server(130)
    await openFrom(s)
    expect(status()).toContain('of 130 events')

    later(s, 135)
    await click()
    expect(s.requests().filter((r) => r !== `GET /data/sources.json`)).toEqual(requests)
    expect(s.calls.find((c) => c.method === 'POST').headers['X-Requested-With']).toBe('otelscope')
    expect(status()).toContain('of 135 events')
    expect(bodyRows()[0].findAll('td')[0].text()).toBe(formatDateTime(s.files[E1].rows.at(-1).time))
    expect(note().text()).toBe('Data refreshed.')
  })

  it('keeps the kind, the search, the chosen columns and the page, and does not reveal more pages', async () => {
    const s = server(400) // 20 pages
    await openFrom(s)
    await wrapper.find('#log-search').setValue('Prompt number')
    await wrapper.findAll('.viz-menu-list label').find((l) => l.text() === 'app.version').find('input').setValue(true)
    await pageButtons()[2].trigger('click') // page 3
    expect(currentPage()).toBe('3')
    expect(pageLabels()).toEqual(['1', '2', '3', '4', '5'])
    expect(status()).toContain('of 395 events') // 400 rows, minus the 2 "needle" rows and the 3 the fixture rewrites

    later(s, 420)
    await click()
    expect(wrapper.find('#log-search').element.value).toBe('Prompt number')
    expect(headers()).toEqual(['Date / time', 'session.id', 'prompt', 'app.version'])
    expect(currentPage()).toBe('3')
    expect(pageLabels()).toEqual(['1', '2', '3', '4', '5']) // staying put on page 3 loaded nothing more
    expect(status()).toContain('of 415 events') // the new rows are in, and the search still filters them
  })

  it('stays on the kind that was chosen, and re-reads that one', async () => {
    const s = server()
    await openFrom(s)
    await eventSelect().setValue('e2')
    await settle()
    s.calls.length = 0
    await click()
    expect(eventSelect().element.value).toBe('e2')
    expect(s.requests()).toContain('GET /data/claude/logs/e2.json')
    expect(s.requests()).not.toContain(`GET ${E1}`)
    expect(headers()).toContain('model')
  })

  it('falls back to the default kind, with a fresh search, when the one shown is no longer in the logs', async () => {
    const s = server()
    await openFrom(s)
    await eventSelect().setValue('e2')
    await settle()
    await wrapper.find('#log-search').setValue('gpt')
    s.files[INDEX] = { ...s.files[INDEX], events: s.files[INDEX].events.filter((e) => e.id !== 'e2') }
    await click()
    expect(eventSelect().element.value).toBe('e1')
    expect(headers()).toEqual(['Date / time', 'session.id', 'prompt'])
    expect(wrapper.find('#log-search').element.value).toBe('')
  })

  it('moves back to the last page when the data shrinks under it', async () => {
    const s = server(130)
    await openFrom(s)
    await pageButtons()[3].trigger('click') // page 4
    later(s, 25) // 2 pages now
    await click()
    expect(currentPage()).toBe('2')
    expect(bodyRows()).toHaveLength(5)
  })

  it('closes expanded cells, since newer rows move them', async () => {
    const s = server()
    await openFrom(s)
    const cell = () => bodyRows()[0].findAll('td')[2]
    await cell().find('button').trigger('click')
    expect(cell().find('.cell-text').classes()).not.toContain('is-clamped')
    await click()
    expect(cell().find('.cell-text').classes()).toContain('is-clamped')
  })

  it('keeps the old table, and says why, when the server cannot re-read the logs', async () => {
    const s = server()
    await openFrom(s)
    s.refresh = { status: 500, body: { error: 'Log directory not found: /data/logs' } }
    later(s, 135)
    await click()
    expect(note().text()).toBe('Refresh failed: Log directory not found: /data/logs')
    expect(note().attributes('role')).toBe('alert')
    expect(status()).toContain('of 130 events')
    expect(button().attributes('disabled')).toBeUndefined()

    s.refresh = { status: 200, body: {} } // the server is fine now, but the file is not
    s.dataStatus = 500
    await click()
    expect(note().text()).toBe('Refresh failed: 500 S500')
    expect(status()).toContain('of 130 events')
  })

  it('just reloads the files when the server cannot regenerate them (a static build)', async () => {
    const s = server()
    await openFrom(s)
    s.refresh = { status: 405, body: undefined }
    later(s, 135)
    await click()
    expect(status()).toContain('of 135 events')
    expect(note().text()).toContain('cannot re-read the logs')
  })

  it('cannot be pressed twice while it is working', async () => {
    const s = server()
    await openFrom(s)
    let release
    s.hold = new Promise((resolve) => { release = resolve })
    await button().trigger('click')
    await settle()
    expect(button().attributes('disabled')).toBeDefined()
    expect(button().attributes('aria-busy')).toBe('true')
    release()
    await settle()
    expect(s.requests().filter((r) => r.startsWith('POST'))).toHaveLength(1)
    expect(button().attributes('aria-busy')).toBe('false')
  })

  it('can recover a page whose first load failed', async () => {
    const s = server()
    s.dataStatus = 404
    await openFrom(s)
    expect(wrapper.text()).toContain('Could not load')
    s.dataStatus = 200
    await click()
    expect(wrapper.text()).not.toContain('Could not load')
    expect(status()).toContain('of 130 events')
  })
})
