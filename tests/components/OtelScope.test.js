import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import OtelScope from '../../docs/.vitepress/components/OtelScope.vue'
import { VERSION } from '../../docs/.vitepress/lib/version.js'
import { logsFiles, makeOtherUsage, makeScope, makeUsage, mountWithNav } from './fixtures.js'

// A recording stand-in for the ECharts instance, as in UsageChart.test.js: these tests are about the page, not the drawing.
const { chart } = vi.hoisted(() => ({
  chart: { setOption: vi.fn(), on: vi.fn(), dispatchAction: vi.fn(), getOption: vi.fn(() => ({ dataZoom: [{}] })), resize: vi.fn(), dispose: vi.fn() },
}))
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => chart) }))
vi.mock('echarts/charts', () => ({ BarChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, DataZoomComponent: {} }))
vi.mock('echarts/renderers', () => ({ SVGRenderer: {} }))
vi.mock('vitepress', async () => {
  const { ref } = await import('vue')
  return { withBase: (p) => p, useData: () => ({ isDark: ref(false) }) }
})

const SOURCES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'vscode', label: 'VS Code Copilot' },
  { id: 'opencode', label: 'OpenCode' }, // a tool the site has no knowledge of
]

/** The dev server's data folder as one object: URL -> JSON. POST /api/refresh runs `onRefresh`, which may change the files. */
function makeSite(files) {
  const site = { files, calls: [], onRefresh: null }
  const reply = (status, body) => ({ ok: status < 300, status, statusText: `S${status}`, json: async () => body })
  site.fetch = vi.fn(async (url, init = {}) => {
    site.calls.push(`${init.method ?? 'GET'} ${url}`)
    if (url === '/api/refresh') {
      site.onRefresh?.()
      return reply(200, { generatedAt: 'now' })
    }
    return url in site.files ? reply(200, site.files[url]) : reply(404, undefined)
  })
  return site
}
const standardFiles = () => ({
  '/data/sources.json': { sources: SOURCES },
  '/data/claude/usage.json': makeUsage(),
  ...logsFiles('claude', 30),
  '/data/vscode/usage.json': makeOtherUsage(),
  ...logsFiles('vscode', 4),
  '/data/opencode/usage.json': makeOtherUsage({ source: '~/otelscope/opencode' }),
  ...logsFiles('opencode', 6),
})

let wrapper
const settle = async () => {
  for (let i = 0; i < 6; i++) await flushPromises()
  await wrapper.vm.$nextTick()
}
async function open(site) {
  vi.stubGlobal('fetch', site.fetch)
  wrapper = mountWithNav(OtelScope, {}, makeScope({ fromFiles: true })).wrapper // the navbar and the page share one scope
  await settle()
}
const tabs = () => wrapper.findAll('button[role="tab"]')
const tabNames = () => tabs().map((t) => t.text())
const selectedTab = () => tabs().find((t) => t.attributes('aria-selected') === 'true')?.text()
// which view is on screen: each view's root says so
const shownView = () => wrapper.find('[data-view]').attributes('data-view')
const navButtons = () => wrapper.findAll('.otel-nav-btn')
const views = () => wrapper.findAll('.otel-nav-group button').filter((b) => b.attributes('disabled') === undefined).map((b) => b.text())
const refreshButton = () => wrapper.find('.otel-nav-btn.is-refresh')
const clickTab = async (name) => { await tabs().find((t) => t.text() === name).trigger('click'); await settle() }
const clickView = async (name) => { await wrapper.findAll('.otel-nav-group button').find((b) => b.text() === name).trigger('click'); await settle() }
const select = (label) => wrapper.findAll('label.viz-field').find((l) => l.text().startsWith(label)).find('select')

beforeEach(() => {
  window.location.hash = ''
  chart.setOption.mockClear()
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
})
afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('OtelScope tabs', () => {
  it('draws one tab for each folder, in the order the data gives, and opens the first with its Usage view', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    expect(tabNames()).toEqual(['Claude Code', 'VS Code Copilot', 'OpenCode'])
    expect(selectedTab()).toBe('Claude Code')
    expect(views()).toEqual(['Usage', 'Logs'])
    expect(wrapper.find('.viz-sub').text()).toContain('Claude Code usage')
    expect(site.calls).toContain('GET /data/claude/usage.json')
    expect(site.calls).not.toContain('GET /data/vscode/usage.json') // other tabs are only read when opened
  })

  it('shows another folder\'s data when its tab is clicked, and puts the choice in the address', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    await clickTab('VS Code Copilot')
    expect(selectedTab()).toBe('VS Code Copilot')
    expect(site.calls).toContain('GET /data/vscode/usage.json')
    expect(wrapper.find('.viz-sub').text()).toContain('VS Code Copilot usage')
    expect(window.location.hash).toBe('#vscode/usage')
  })

  it('shows that folder\'s own log events in the Logs view, and its own dropdown of kinds', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    await clickView('Logs')
    expect(window.location.hash).toBe('#claude/logs')
    expect(wrapper.find('caption').text()).toContain('Events, newest first')
    expect(wrapper.find('.viz-event select').findAll('option').map((o) => o.text())).toEqual(['user_prompt (30)', 'api_request (2)', 'chat gpt-a (1)'])

    await clickTab('VS Code Copilot')
    expect(window.location.hash).toBe('#vscode/logs') // the view stays when another tool is picked
    expect(site.calls).toContain('GET /data/vscode/logs.json')
    expect(wrapper.find('.viz-event select').findAll('option').map((o) => o.text())).toEqual(['user_prompt (4)', 'api_request (2)', 'chat gpt-a (1)'])
    expect(wrapper.find('.viz-sub').text()).toContain('VS Code Copilot exported')
  })

  it('opens on the tab and view named in the address, and falls back to the first tab for a wrong one', async () => {
    window.location.hash = '#vscode/logs'
    await open(makeSite(standardFiles()))
    expect(selectedTab()).toBe('VS Code Copilot')
    expect(shownView()).toBe('logs')
    expect(wrapper.find('h1').exists()).toBe(false) // the navbar says which view it is, so a view has no heading of its own
    wrapper.unmount()

    window.location.hash = '#nope/logs'
    await open(makeSite(standardFiles()))
    expect(selectedTab()).toBe('Claude Code')
    expect(shownView()).toBe('usage')
  })

  it('offers what each folder\'s own data has, and nothing built for another tool', async () => {
    await open(makeSite(standardFiles()))
    expect(select('Y-axis').findAll('option').map((o) => o.text())).toEqual(['Token usage', 'Cost usage (USD)', 'Lines of code count'])
    expect(wrapper.find('#session-search').exists()).toBe(true)

    await clickTab('VS Code Copilot')
    expect(select('Y-axis').findAll('option').map((o) => o.text())).toEqual(['Gen AI client token usage', 'Gen AI client token usage (count)'])
    const colors = select('Color by').findAll('option').map((o) => o.text())
    expect(colors).toEqual(['gen_ai.request.model', 'gen_ai.token.type', 'None (one series)']) // service.name has one value: not offered
    expect(wrapper.find('#session-search').exists()).toBe(false) // this tool's data has no session
    expect(wrapper.find('.viz-controls').text().toLowerCase()).not.toContain('claude') // nothing about another tool leaks into this tab's controls
  })

  it('draws the Usage and Logs of a tool the site has never heard of, just like any other', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    await clickTab('OpenCode')
    expect(views()).toEqual(['Usage', 'Logs'])
    expect(site.calls).toContain('GET /data/opencode/usage.json')
    expect(select('Y-axis').findAll('option').map((o) => o.text())).toEqual(['Gen AI client token usage', 'Gen AI client token usage (count)'])
    expect(chart.setOption).toHaveBeenCalled()
    await clickView('Logs')
    expect(site.calls).toContain('GET /data/opencode/logs.json')
    expect(wrapper.find('.viz-event select').findAll('option').map((o) => o.text())[0]).toBe('user_prompt (6)')
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0)
  })

  it('says why a folder could not be read, on its own tab, while the others work', async () => {
    const files = standardFiles()
    files['/data/sources.json'] = { sources: [...SOURCES, { id: 'broken', label: 'Broken', error: 'Could not read metrics.pblog: boom' }] }
    await open(makeSite(files))
    await clickTab('Broken')
    expect(wrapper.text()).toContain('This folder could not be read: Could not read metrics.pblog: boom')
    expect(views()).toEqual([]) // nothing to switch between
    await clickTab('Claude Code')
    expect(wrapper.find('.viz-sub').text()).toContain('Claude Code usage')
  })
})

describe('OtelScope refresh', () => {
  it('gives a new folder its tab and keeps you where you were', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    await clickTab('VS Code Copilot')
    await clickView('Logs')
    expect(tabNames()).toEqual(['Claude Code', 'VS Code Copilot', 'OpenCode'])

    site.onRefresh = () => {
      site.files['/data/sources.json'] = { sources: [...SOURCES, { id: 'newtool', label: 'Newtool' }] }
    }
    await refreshButton().trigger('click')
    await settle()
    expect(tabNames()).toEqual(['Claude Code', 'VS Code Copilot', 'OpenCode', 'Newtool'])
    expect(selectedTab()).toBe('VS Code Copilot')
    expect(shownView()).toBe('logs') // still on its Logs view
    expect(wrapper.find('.otel-toast').text()).toBe('Data refreshed.')
  })

  it('can recover when the tab list could not be loaded at first', async () => {
    const files = standardFiles()
    const sourcesFile = files['/data/sources.json']
    delete files['/data/sources.json']
    const site = makeSite(files)
    await open(site)
    expect(wrapper.text()).toContain('Could not load /data/sources.json')
    expect(tabs()).toHaveLength(0)

    site.files['/data/sources.json'] = sourcesFile
    await refreshButton().trigger('click')
    await settle()
    expect(tabNames()).toEqual(['Claude Code', 'VS Code Copilot', 'OpenCode'])
    expect(wrapper.find('.viz-sub').text()).toContain('Claude Code usage')
  })

  it('explains an empty log folder and offers Refresh', async () => {
    await open(makeSite({ '/data/sources.json': { sources: [] } }))
    expect(wrapper.text()).toContain('There is no folder for any tool in the log folder yet')
    expect(refreshButton().exists()).toBe(true)
  })
})

describe('the navbar', () => {
  it('has Usage, Logs and Refresh, in that order from the left, each an icon and a word', async () => {
    await open(makeSite(standardFiles()))
    expect(navButtons().map((b) => b.text())).toEqual(['Usage', 'Logs', 'Refresh'])
    for (const b of navButtons()) expect(b.find('svg').exists()).toBe(true)
    expect(navButtons().every((b) => b.find('svg').attributes('aria-hidden') === 'true')).toBe(true) // the word names the button
  })

  it('shows the version to the left of Usage and Logs, and it is not a button', async () => {
    await open(makeSite(standardFiles()))
    const [first, second] = wrapper.find('.otel-nav').element.children
    expect(first.classList.contains('otel-nav-version')).toBe(true)
    expect(first.textContent).toBe(`v${VERSION}`)
    expect(second.classList.contains('otel-nav-group')).toBe(true)
    expect(navButtons().map((b) => b.text())).toEqual(['Usage', 'Logs', 'Refresh']) // still just the three
  })

  it('marks the view that is showing, and moves the mark when another is chosen', async () => {
    await open(makeSite(standardFiles()))
    const current = () => navButtons().filter((b) => b.attributes('aria-current') === 'page').map((b) => b.text())
    expect(current()).toEqual(['Usage'])
    await clickView('Logs')
    expect(current()).toEqual(['Logs'])
    expect(window.location.hash).toBe('#claude/logs')
  })

  it('offers the same two views for every tool, and keeps the one chosen when another tool is picked', async () => {
    await open(makeSite(standardFiles()))
    await clickView('Logs')
    for (const tool of ['VS Code Copilot', 'OpenCode', 'Claude Code']) {
      await clickTab(tool)
      expect(views()).toEqual(['Usage', 'Logs'])
      expect(shownView()).toBe('logs')
    }
  })

  it('keeps Usage and Logs in place, disabled, while there is nothing to show them for', async () => {
    const files = standardFiles()
    delete files['/data/sources.json']
    await open(makeSite(files))
    expect(navButtons().map((b) => b.text())).toEqual(['Usage', 'Logs', 'Refresh'])
    expect(navButtons().slice(0, 2).every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    expect(refreshButton().attributes('disabled')).toBeUndefined() // Refresh is how it recovers
  })

  it('refreshes every tool\'s data at once: one request, and the view on screen reads its data again', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    await clickView('Logs')
    site.calls.length = 0
    await refreshButton().trigger('click')
    await settle()
    expect(site.calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/refresh']) // the server re-reads all folders in one go
    expect(site.calls).toContain('GET /data/sources.json')
    expect(site.calls).toContain('GET /data/claude/logs.json') // the visible view
    expect(site.calls).toContain('GET /data/claude/logs/e1.json')
    expect(site.calls).not.toContain('GET /data/claude/usage.json') // the one that is not showing is read when opened
  })

  it('does not remount the view, so the search and the page survive a refresh', async () => {
    await open(makeSite(standardFiles()))
    await clickView('Logs')
    await wrapper.find('#log-search').setValue('number 1')
    await refreshButton().trigger('click')
    await settle()
    expect(wrapper.find('#log-search').element.value).toBe('number 1')
  })
})

describe('OtelScope remembers what was chosen', () => {
  const COST = 'claude_code.cost.usage'
  const COUNT = 'gen_ai.client.token.usage#count'
  const pickSession = async (query) => {
    await wrapper.find('#session-search').setValue(query)
    await wrapper.find('.viz-option').trigger('mousedown')
  }

  it('keeps the Usage controls through a visit to Logs, and the Logs controls through a visit to Usage', async () => {
    await open(makeSite(standardFiles()))
    await select('Y-axis').setValue(COST)
    await pickSession('beta')
    await clickView('Logs')
    await wrapper.find('#log-search').setValue('number 1')
    await clickView('Usage')
    expect(select('Y-axis').element.value).toBe(COST)
    expect(wrapper.find('.viz-chip').text()).toContain('beta')
    await clickView('Logs')
    expect(wrapper.find('#log-search').element.value).toBe('number 1')
  })

  it('keeps each tool\'s controls apart: coming back to a tab finds it as it was left', async () => {
    await open(makeSite(standardFiles()))
    await select('Y-axis').setValue(COST)
    await clickTab('VS Code Copilot')
    expect(select('Y-axis').element.value).toBe('gen_ai.client.token.usage') // its own first measure, not Claude's pick
    await select('Y-axis').setValue(COUNT)
    await clickTab('Claude Code')
    expect(select('Y-axis').element.value).toBe(COST)
    await clickTab('VS Code Copilot')
    expect(select('Y-axis').element.value).toBe(COUNT)
  })

  it('keeps the Logs search of a tab through a visit to another tab', async () => {
    await open(makeSite(standardFiles()))
    await clickView('Logs')
    await wrapper.find('#log-search').setValue('number 2')
    await clickTab('OpenCode')
    expect(wrapper.find('#log-search').element.value).toBe('')
    await clickTab('Claude Code')
    expect(wrapper.find('#log-search').element.value).toBe('number 2')
  })

  it('starts clean on a new load of the page, which is a new scope', async () => {
    const site = makeSite(standardFiles())
    await open(site)
    await select('Y-axis').setValue(COST)
    wrapper.unmount()
    await open(site)
    expect(select('Y-axis').element.value).toBe('claude_code.token.usage')
  })
})
