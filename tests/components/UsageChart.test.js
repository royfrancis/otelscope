import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import UsageChart from '../../docs/.vitepress/components/UsageChart.vue'
import { CODE_LINES, COST_USAGE, TOKEN_USAGE, makeScope, makeServer, makeUsage, mountWithNav, provideScope, rowsOf, sumBy, day } from './fixtures.js'
import { formatDateTime } from '../../docs/.vitepress/lib/aggregate.js'

// A recording stand-in for the ECharts instance: the tests check what the component asks it to draw.
const { chart, handlers } = vi.hoisted(() => {
  const handlers = {}
  const chart = {
    setOption: vi.fn(),
    on: vi.fn((name, cb) => { handlers[name] = cb }),
    dispatchAction: vi.fn(),
    getOption: vi.fn(() => ({ dataZoom: [{}] })),
    resize: vi.fn(),
    dispose: vi.fn(),
  }
  return { chart, handlers }
})
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => chart) }))
vi.mock('echarts/charts', () => ({ BarChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, DataZoomComponent: {} }))
vi.mock('echarts/renderers', () => ({ SVGRenderer: {} }))
vi.mock('vitepress', async () => {
  const { ref } = await import('vue')
  return { withBase: (p) => p, useData: () => ({ isDark: ref(false) }) }
})

const TOKENS = {
  '--surface-1': '#fcfcfb', '--ink-1': '#0b0b0b', '--ink-2': '#52514e', '--ink-3': '#898781',
  '--grid': '#e1e0d9', '--axis': '#c3c2b7', '--border': 'rgba(0,0,0,.1)', '--zoom-fill': 'rgba(0,0,0,.1)',
  '--series-other': '#898781',
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`--series-${i + 1}`, `#00000${i + 1}`])),
}

const usage = makeUsage()
let wrapper

// The chart opens on the last 24 hours, but most of these tests are about the data as a whole, so they open it on All
// (the `initialRange` prop; the site never sets it). Pass `{}` to get the default.
const WHOLE_DATA = { initialRange: 'all' }

async function open(payload = usage, props = WHOLE_DATA) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })))
  wrapper = mount(UsageChart, { attachTo: document.body, props, ...provideScope(makeScope()) })
  for (let i = 0; i < 4; i++) await flushPromises()
  await wrapper.vm.$nextTick()
}

const lastFull = () => chart.setOption.mock.calls.findLast(([opt, o]) => o?.notMerge)[0]
const lastCall = () => chart.setOption.mock.calls.at(-1)
const seriesTotal = (option) => option.series.flatMap((s) => s.data.map((d) => d.value[1])).reduce((a, b) => a + b, 0)
const seriesNames = (option) => option.series.map((s) => s.name)
const select = (label) => wrapper.findAll('label.viz-field').find((l) => l.text().startsWith(label)).find('select')

beforeEach(() => {
  chart.setOption.mockClear()
  chart.dispatchAction.mockClear()
  for (const k of Object.keys(handlers)) delete handlers[k]
  chart.getOption.mockReturnValue({ dataZoom: [{}] })
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // happy-dom does not load viz.css, so answer the color-token lookups and defer everything else
  // (VTU's isVisible() reads computed styles).
  const realComputedStyle = window.getComputedStyle.bind(window)
  vi.stubGlobal('getComputedStyle', (el, ...rest) => {
    const cs = realComputedStyle(el, ...rest)
    return new Proxy(cs, {
      get(target, prop) {
        if (prop === 'getPropertyValue') return (name) => TOKENS[name] || target.getPropertyValue(name)
        const v = target[prop]
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  })
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
})
afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
})

describe('UsageChart', () => {
  const tokenRows = () => rowsOf(usage, TOKEN_USAGE)
  const optionLabels = (label) => select(label).findAll('option').map((o) => o.text())

  it('draws the first measure colored by the first field that tells a few things apart, over the whole time range', async () => {
    await open()
    const option = lastFull()
    expect(seriesTotal(option)).toBe(sumBy(tokenRows())) // every type of token
    // colors are ranked by the first measure's totals (claude-code has far more tokens), then take palette slots in fixed order
    expect(seriesNames(option)).toEqual(['claude-code', 'claude-code-desktop'])
    expect(option.legend.show).toBe(true)
    expect(option.series.map((s) => s.itemStyle.color)).toEqual(['#000001', '#000002'])
    // the axis is pinned to whole local days around the data, and the window starts at the full extent
    const dayMs = 86400_000
    expect(option.xAxis.min).toBe(new Date(2026, 9, 20).getTime())
    expect(option.xAxis.max).toBe(new Date(2026, 9, 23).getTime())
    expect(option.dataZoom[0].startValue).toBe(option.xAxis.min)
    expect(option.dataZoom[0].endValue).toBe(option.xAxis.max)
    expect(option.xAxis.max - option.xAxis.min).toBe(3 * dayMs)
    expect(wrapper.text()).toContain('across 3 sessions')
    expect(wrapper.text()).toContain('tokens across') // the unit the data names
  })

  describe('the dropdowns come from the data', () => {
    it('lists the measures the data has, labeled as the data says, and nothing else', async () => {
      await open()
      expect(optionLabels('Y-axis')).toEqual(['Token usage', 'Cost usage (USD)', 'Lines of code count'])
      expect(select('Y-axis').findAll('option').map((o) => o.element.value)).toEqual([TOKEN_USAGE, COST_USAGE, CODE_LINES])
      expect(wrapper.text()).not.toContain('data for Claude Code.') // nothing is "missing": a measure that is not in the data is not listed
    })

    it('draws any measure: a tool the site has never heard of, with its own names, units and fields', async () => {
      const acme = {
        generatedAt: new Date(2026, 9, 28, 13).toISOString(), source: '~/otelscope/acme',
        fields: ['service.name', 'acme.line', 'acme.shift'],
        dict: { 'service.name': ['acme-cli'], 'acme.line': ['north', 'south'], 'acme.shift': ['day', 'night', 'day-and-night'] },
        extent: [day(20, 10), day(21, 10)], sessionField: null, modelField: null, sessions: [],
        measures: [
          { key: 'acme.widget.produced', label: 'Produced (widgets)', unit: 'widgets', format: 'number', rows: [[day(20, 10), 3, 0, 0, 0], [day(21, 10), 4, 0, 1, 1]] },
          { key: 'acme.widget.busy', label: 'Busy time (seconds)', unit: 's', format: 'seconds', rows: [[day(20, 10), 90, 0, 0, 0]] },
        ],
      }
      await open(acme)
      expect(optionLabels('Y-axis')).toEqual(['Produced (widgets)', 'Busy time (seconds)'])
      expect(optionLabels('Color by')).toEqual(['acme.line', 'acme.shift', 'None (one series)']) // service.name has one value: not offered
      expect(seriesNames(lastFull())).toEqual(['south', 'north']) // the first field that tells a few things apart, largest first
      expect(wrapper.find('#session-search').exists()).toBe(false) // no session in the data, so no session search
      await select('Y-axis').setValue('acme.widget.busy')
      expect(optionLabels('Color by')).toEqual(['None (one series)']) // a single datapoint tells nothing apart
      expect(wrapper.find('.viz-summary').text()).toContain('1m 30s')
    })

    it('offers only the fields that tell this measure\'s datapoints apart, and None', async () => {
      await open()
      // service.version has one value everywhere, so it would color everything the same: it is not offered
      expect(optionLabels('Color by')).toEqual([
        'service.name', 'app.entrypoint', 'session.id', 'model', 'vcs.repository.name', 'terminal.type', 'type', 'None (one series)',
      ])
      await select('Y-axis').setValue(COST_USAGE) // cost has no type: every value is (none)
      expect(optionLabels('Color by')).not.toContain('type')
      expect(optionLabels('Color by')).toContain('model')
    })

    it('falls back to a sensible field while the one picked does not exist for the measure shown', async () => {
      await open()
      await select('Color by').setValue('7') // type
      expect(seriesNames(lastFull())).toEqual(['input', 'output', 'cacheRead', 'cacheCreation'])
      await select('Y-axis').setValue(COST_USAGE) // no types on cost
      expect(select('Color by').element.value).toBe('0') // the first field that tells a few things apart
      expect(wrapper.find('.viz-chart').attributes('aria-label')).toContain('colored by service.name')
      await select('Y-axis').setValue(TOKEN_USAGE) // the pick is not lost: it applies again where it exists
      expect(select('Color by').element.value).toBe('7')
    })

    it('keeps the field picked when the next measure has it too', async () => {
      await open()
      await select('Color by').setValue('4') // model
      await select('Y-axis').setValue(COST_USAGE)
      expect(select('Color by').element.value).toBe('4')
      expect(seriesNames(lastFull())).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']) // colored as for tokens: the same model, the same color
    })

    it('can draw one series: the total, named after the measure', async () => {
      await open()
      await select('Color by').setValue('-1')
      expect(seriesNames(lastFull())).toEqual(['Token usage'])
      expect(lastFull().legend.show).toBe(false)
      expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows()))
      await select('Y-axis').setValue(COST_USAGE)
      expect(seriesNames(lastFull())).toEqual(['Cost usage (USD)']) // still "None", now for cost
      expect(wrapper.find('.viz-chart').attributes('aria-label')).toContain('colored by None')
    })

    it('draws a single series when no field tells the datapoints apart', async () => {
      const flat = makeUsage()
      flat.fields = ['service.name']
      flat.dict = { 'service.name': ['solo'] }
      flat.sessionField = null
      flat.modelField = null
      flat.sessions = []
      flat.measures = [{ key: 'solo.count', label: 'Solo count', unit: '', format: 'number', rows: [[day(20, 10), 5, 0], [day(21, 10), 7, 0]] }]
      await open(flat)
      expect(optionLabels('Color by')).toEqual(['None (one series)'])
      expect(seriesNames(lastFull())).toEqual(['Solo count'])
      expect(seriesTotal(lastFull())).toBe(12)
    })

    it('writes values the way the measure says: dollars, a duration, or a plain number', async () => {
      await open()
      await select('Y-axis').setValue(COST_USAGE)
      expect(lastFull().yAxis.axisLabel.formatter(2)).toBe('$2')
      expect(wrapper.find('.viz-summary').text()).toContain('$2.25')
      const timed = makeUsage()
      timed.measures = [{ key: 'busy', label: 'Busy time (seconds)', unit: 's', format: 'seconds', rows: [[day(20, 10), 90, 0, 0, 0, 0, 0, 0, 0, 6], [day(21, 10), 30, 1, 0, 1, 1, 1, 1, 0, 6]] }]
      await open(timed)
      expect(lastFull().yAxis.axisLabel.formatter(90)).toBe('1.5m')
      expect(wrapper.find('.viz-summary').text()).toContain('2m 00s')
    })
  })

  it('has no token-type or lines checkboxes: every type always counts', async () => {
    await open()
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0)
    expect(wrapper.find('fieldset').exists()).toBe(false)
    expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows())) // input, output, cacheRead and cacheCreation
    await select('Y-axis').setValue(CODE_LINES)
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0)
    expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(usage, CODE_LINES))) // added and removed
  })

  it('switches the y-axis to cost and to code count', async () => {
    await open()
    await select('Y-axis').setValue(COST_USAGE)
    let option = lastFull()
    expect(seriesTotal(option)).toBeCloseTo(sumBy(rowsOf(usage, COST_USAGE)))
    expect(option.yAxis.axisLabel.formatter(2)).toBe('$2')

    await select('Y-axis').setValue(CODE_LINES)
    option = lastFull()
    expect(seriesTotal(option)).toBe(sumBy(rowsOf(usage, CODE_LINES)))
  })

  it('colors by app.entrypoint and session.id', async () => {
    await open()
    await select('Color by').setValue('2') // option values are strings in the DOM
    expect(seriesNames(lastFull()).sort()).toEqual(['claude-desktop', 'cli'])

    await select('Color by').setValue('3')
    expect(seriesNames(lastFull()).sort()).toEqual(['aaaaaaaa · alpha', 'bbbbbbbb · beta', 'cccccccc'])
  })

  it('offers model in the Color by dropdown and colors the bars by it', async () => {
    await open()
    await select('Color by').setValue('4')
    // ranked by the first measure's totals: sonnet has far more tokens than opus
    expect(seriesNames(lastFull())).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows()))
    expect(wrapper.find('.viz-chart').attributes('aria-label')).toContain('colored by model')
  })

  it('colors by repository (folder) name, with a (none) series for sessions outside a git repo', async () => {
    await open()
    await select('Color by').setValue('5')
    // ranked by total tokens: alpha (51,200), beta (3,400), then the session with no repo (790)
    expect(seriesNames(lastFull())).toEqual(['alpha', 'beta', '(none)'])
    expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows()))
    expect(wrapper.find('.viz-chart').attributes('aria-label')).toContain('colored by vcs.repository.name')
    // and the tooltip still splits the hovered segment by model
    const option = lastFull()
    const si = option.series.findIndex((s) => s.name === 'beta')
    const j = option.series[si].data.findIndex((d) => d.value[1] > 0)
    const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
    expect(el.querySelector('.viz-tip-models .viz-tip-model').textContent).toBe('claude-opus-5-5')
  })

  it('colors by terminal type', async () => {
    await open()
    await select('Color by').setValue('6')
    expect(seriesNames(lastFull())).toEqual(['vscode', 'iTerm.app'])
    expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows()))
    expect(wrapper.find('.viz-chart').attributes('aria-label')).toContain('colored by terminal.type')
  })

  describe('color by type', () => {
    const TYPE = '7' // the type is a field like any other: the last of the usage fixture's
    const colors = (option) => Object.fromEntries(option.series.map((s) => [s.name, s.itemStyle.color]))

    it('colors token usage by token type, in a fixed order whatever order the data lists them', async () => {
      // the data lists the types as output, input, cacheCreation, cacheRead, ... (old index -> new index below)
      const shuffled = makeUsage()
      shuffled.dict.type = ['output', 'input', 'cacheCreation', 'cacheRead', 'removed', 'added', '(none)']
      const remap = [1, 0, 3, 2, 5, 4, 6]
      for (const m of shuffled.measures) m.rows = m.rows.map((r) => [...r.slice(0, 9), remap[r[9]]])
      await open(shuffled)
      expect(optionLabels('Color by')).toContain('type')
      await select('Color by').setValue(TYPE)
      const option = lastFull()
      expect(seriesNames(option)).toEqual(['input', 'output', 'cacheRead', 'cacheCreation'])
      expect(colors(option)).toEqual({ input: '#000001', output: '#000002', cacheRead: '#000003', cacheCreation: '#000004' })
      expect(seriesTotal(option)).toBe(sumBy(tokenRows()))
      // each series holds exactly its own type's tokens
      const total = (name) => option.series.find((s) => s.name === name).data.reduce((a, d) => a + d.value[1], 0)
      expect([total('input'), total('output'), total('cacheRead'), total('cacheCreation')]).toEqual([4700, 600, 50000, 90])
      expect(wrapper.find('.viz-chart').attributes('aria-label')).toContain('colored by type')
    })

    it('keeps each type\'s color when a session has only some of the types', async () => {
      await open()
      await select('Color by').setValue(TYPE)
      await wrapper.find('#session-search').setValue('cccccccc') // this session has input and cacheCreation only
      await wrapper.find('.viz-option').trigger('mousedown')
      const option = lastFull()
      expect(seriesNames(option)).toEqual(['input', 'cacheCreation'])
      expect(colors(option)).toEqual({ input: '#000001', cacheCreation: '#000004' }) // cacheCreation is not recolored to slot 2
    })

    it('is lines added / removed on code count, and is not offered on cost', async () => {
      await open()
      await select('Color by').setValue(TYPE)
      await select('Y-axis').setValue(CODE_LINES)
      expect(select('Color by').element.value).toBe(TYPE) // still the type, now added and removed
      expect(seriesNames(lastFull())).toEqual(['added', 'removed'])
      expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(usage, CODE_LINES)))

      await select('Y-axis').setValue(COST_USAGE)
      expect(optionLabels('Color by')).not.toContain('type')
      expect(select('Color by').element.value).toBe('0') // falls back to the first field
      expect(seriesNames(lastFull())).toEqual(['claude-code', 'claude-code-desktop'])
    })

    it('still shows the models behind the hovered segment', async () => {
      await open()
      await select('Color by').setValue(TYPE)
      const option = lastFull()
      const si = option.series.findIndex((s) => s.name === 'cacheRead')
      const j = option.series[si].data.findIndex((d) => d.value[1] === 50000)
      const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
      expect(el.querySelector('.viz-tip-models').textContent).toBe('Modelclaude-sonnet-5-5')
    })
  })

  describe('sessions and models are optional', () => {
    it('has no session search, and no "across N sessions", for a tool whose data has no session', async () => {
      const none = makeUsage({ sessionField: null, sessions: [] })
      await open(none)
      expect(wrapper.find('#session-search').exists()).toBe(false)
      expect(wrapper.find('.viz-summary').text()).not.toContain('across')
      expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows()))
    })

    it('has no session search when the data has only one session, since it would filter nothing', async () => {
      const one = makeUsage()
      one.sessions = one.sessions.slice(0, 1)
      one.dict['session.id'] = one.dict['session.id'].slice(0, 1)
      one.measures = one.measures.map((m) => ({ ...m, rows: m.rows.map((r) => [...r.slice(0, 5), 0, ...r.slice(6)]) })) // every datapoint in that one session
      await open(one)
      expect(wrapper.find('#session-search').exists()).toBe(false)
      expect(wrapper.find('.viz-summary').text()).not.toContain('across')
      expect(optionLabels('Color by')).not.toContain('session.id') // and it is no use to color by either
    })

    it('has no model split in the tooltip for a tool whose data has no model', async () => {
      await open(makeUsage({ modelField: null }))
      const option = lastFull()
      const si = option.series.findIndex((s) => s.name === 'claude-code')
      const j = option.series[si].data.findIndex((d) => d.value[1] === 51200)
      const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
      expect(el.querySelector('.viz-tip-models')).toBeNull()
    })

    it('describes sessions by what the data has: no folder, no first prompt, no cost', async () => {
      const bare = makeUsage()
      bare.sessions = bare.sessions.map(({ idx, id, start, end }) => ({ idx, id, start, end }))
      await open(bare)
      expect(wrapper.find('#session-search').attributes('placeholder')).toBe('Search by id')
      await wrapper.find('#session-search').trigger('focus')
      const meta = wrapper.find('.viz-option .meta').text()
      expect(meta).not.toContain('no repo')
      expect(meta).not.toContain('$')
    })

    it('says what can be searched when the data has a folder and a first prompt', async () => {
      await open()
      expect(wrapper.find('#session-search').attributes('placeholder')).toBe('Search by id, repo, first prompt')
    })
  })

  it('shows the models behind the hovered segment in the tooltip', async () => {
    await open()
    const option = lastFull()
    const hover = (seriesName, j) => {
      const si = option.series.findIndex((s) => s.name === seriesName)
      return option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
    }
    // bars are colored by service.name; 20 Oct 10:00 has one claude-code segment made of two models
    const series = option.series.find((s) => s.name === 'claude-code')
    const j = series.data.findIndex((d) => d.value[1] === 51200)
    expect(j).toBeGreaterThanOrEqual(0)
    const el = hover('claude-code', j)
    const block = el.querySelector('.viz-tip-models')
    expect(block.querySelector('.viz-tip-caption').textContent).toBe('Models')
    expect([...block.querySelectorAll('.viz-tip-model-row')].map((r) => r.textContent)).toEqual([
      '51,000claude-sonnet-5-5', // 1,000 input + 50,000 cache read, largest first
      '200claude-opus-5-5',
    ])
    // only the hovered segment is split, and the split sits directly under its row
    expect(el.querySelectorAll('.viz-tip-models')).toHaveLength(1)
    expect(block.previousElementSibling.classList.contains('is-hovered')).toBe(true)

    // a segment with a single model gets a one-line caption instead of a list
    const desktop = option.series.find((s) => s.name === 'claude-code-desktop')
    const k = desktop.data.findIndex((d) => d.value[1] > 0)
    const single = hover('claude-code-desktop', k).querySelector('.viz-tip-models')
    expect(single.textContent).toBe('Modelclaude-opus-5-5')
    expect(single.querySelector('.viz-tip-model-row')).toBeNull()
  })

  it('splits only the hovered segment when a bar is stacked from several', async () => {
    const stacked = makeUsage()
    stacked.measures[0].rows.push([day(21, 11), 500, 0, 0, 0, 0, 1, 0, 0, 0]) // claude-code joins desktop in the 21 Oct 11:00 bar
    await open(stacked)
    const option = lastFull()
    const j = option.series.find((s) => s.name === 'claude-code-desktop').data.findIndex((d) => d.value[1] === 3400)
    const hover = (name) => {
      const si = option.series.findIndex((s) => s.name === name)
      return option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
    }
    const el = hover('claude-code')
    expect(el.querySelectorAll('.viz-tip-row')).toHaveLength(2) // both segments are listed...
    expect(el.querySelectorAll('.viz-tip-models')).toHaveLength(1) // ...but only the hovered one is split
    expect(el.querySelector('.is-hovered + .viz-tip-models')).not.toBeNull()
    expect(hover('claude-code-desktop').querySelector('.is-hovered + .viz-tip-models')).not.toBeNull()
  })

  it('follows the session filter: the model split only counts the chosen session', async () => {
    const shared = makeUsage()
    shared.measures[0].rows.push([day(20, 10), 777, 0, 0, 0, 1, 1, 1, 0, 0]) // session bbbbbbbb, opus, same 10:00 bar
    await open(shared)
    const split = (value) => {
      const option = lastFull()
      const si = option.series.findIndex((s) => s.name === 'claude-code')
      const j = option.series[si].data.findIndex((d) => d.value[1] === value)
      const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
      return [...el.querySelectorAll('.viz-tip-model-row')].map((r) => r.textContent)
    }
    expect(split(51977)).toEqual(['51,000claude-sonnet-5-5', '977claude-opus-5-5']) // both sessions: 200 + 777 opus

    await wrapper.find('#session-search').setValue('aaaaaaaa')
    await wrapper.find('.viz-option').trigger('mousedown')
    expect(split(51200)).toEqual(['51,000claude-sonnet-5-5', '200claude-opus-5-5']) // session aaaaaaaa only
  })

  it('does not repeat the model in the tooltip when the bars are already colored by model', async () => {
    await open()
    await select('Color by').setValue('4')
    const option = lastFull()
    const si = option.series.findIndex((s) => s.name === 'claude-sonnet-5-5')
    const j = option.series[si].data.findIndex((d) => d.value[1] > 0)
    const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
    expect(el.querySelector('.viz-tip-models')).toBeNull()
    expect(el.querySelector('.viz-tip-name').textContent).toMatch(/claude-/)
  })

  it('leaves out datapoints that have no model instead of printing (none)', async () => {
    const partial = makeUsage()
    partial.dict.model = ['claude-sonnet-5-5', '(none)']
    partial.measures[0].rows = partial.measures[0].rows.map((r) => (r[6] === 1 ? [...r.slice(0, 6), 1, ...r.slice(7)] : r))
    await open(partial)
    const option = lastFull()
    const si = option.series.findIndex((s) => s.name === 'claude-code')
    const j = option.series[si].data.findIndex((d) => d.value[1] === 51200)
    const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
    expect(el.textContent).not.toContain('(none)')
    expect(el.querySelector('.viz-tip-models').textContent).toBe('Modelclaude-sonnet-5-5') // the one recorded model
  })

  it('keeps an entity\'s color when the measure or filters change', async () => {
    await open()
    await select('Color by').setValue('3')
    const colorOf = (option, name) => option.series.find((s) => s.name === name).itemStyle.color
    const before = colorOf(lastFull(), 'bbbbbbbb · beta')
    await select('Y-axis').setValue(CODE_LINES) // beta has code lines too, alpha as well, gamma none
    expect(colorOf(lastFull(), 'bbbbbbbb · beta')).toBe(before)
    await select('Y-axis').setValue(COST_USAGE)
    expect(colorOf(lastFull(), 'bbbbbbbb · beta')).toBe(before)
  })

  it('searches sessions by id, repo or first prompt and shows only the chosen session', async () => {
    await open()
    const input = wrapper.find('#session-search')
    await input.trigger('focus')
    expect(wrapper.findAll('.viz-option')).toHaveLength(3)

    await input.setValue('readme') // matches beta's first prompt
    expect(wrapper.findAll('.viz-option')).toHaveLength(1)
    expect(wrapper.find('.viz-option').text()).toContain('Write a README for the logger')

    await input.setValue('alpha') // repo name
    expect(wrapper.findAll('.viz-option')).toHaveLength(1)
    await input.setValue('cccccccc') // id prefix
    expect(wrapper.find('.viz-option').text()).toContain('(no prompt logged)')
    await input.setValue('zzz')
    expect(wrapper.text()).toContain('No session matches “zzz”.')

    await input.setValue('beta')
    await wrapper.find('.viz-option').trigger('mousedown') // pick it
    expect(wrapper.find('.viz-chip').text()).toContain('bbbbbbbb · beta')
    expect(wrapper.find('#session-listbox').isVisible()).toBe(false) // the list closes and stays closed
    expect((input.element).value).toBe('')

    const option = lastFull()
    expect(seriesTotal(option)).toBe(sumBy(tokenRows(), (r) => r[5] === 1))
    expect(wrapper.text()).toContain('across 1 session')

    await wrapper.find('.viz-chip button').trigger('click') // clear
    expect(wrapper.find('.viz-chip').exists()).toBe(false)
    expect(seriesTotal(lastFull())).toBe(sumBy(tokenRows()))
  })

  it('zooms to a session when it is picked, and back to the full range when it is cleared', async () => {
    await open()
    const input = wrapper.find('#session-search')
    await input.setValue('beta')
    chart.dispatchAction.mockClear()
    await wrapper.find('.viz-option').trigger('mousedown')
    const [beta] = usage.sessions.filter((s) => s.repo === 'beta')
    const zoomed = chart.dispatchAction.mock.calls.at(-1)[0]
    expect(zoomed.type).toBe('dataZoom')
    // a one-instant session gets the 5 minute minimum padding either side
    expect([zoomed.startValue, zoomed.endValue]).toEqual([(beta.start - 300) * 1000, (beta.end + 300) * 1000])

    await wrapper.find('.viz-chip button').trigger('click')
    const reset = chart.dispatchAction.mock.calls.at(-1)[0]
    expect([reset.startValue, reset.endValue]).toEqual([new Date(2026, 9, 20).getTime(), new Date(2026, 9, 23).getTime()])
  })

  it('selects a session with the keyboard', async () => {
    await open()
    const input = wrapper.find('#session-search')
    await input.trigger('focus')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('.viz-chip').exists()).toBe(true)
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('#session-listbox').isVisible()).toBe(false)
  })

  it('a session that has no data for the measure gives an empty state, not an error', async () => {
    await open()
    await select('Y-axis').setValue(CODE_LINES)
    await wrapper.find('#session-search').setValue('cccccccc')
    await wrapper.find('.viz-option').trigger('mousedown')
    expect(wrapper.text()).toContain('Nothing to show for this selection')
  })

  it('re-buckets on zoom: finer bars when zoomed in, without touching the zoom state', async () => {
    await open()
    const full = lastFull()
    expect(wrapper.text()).toContain('bars are 1 hour wide') // 3 days across the whole range -> 72 one-hour bars

    // the user zooms into one hour; ECharts reports the new window through getOption()
    const startMs = new Date(2026, 9, 20, 10, 0).getTime()
    chart.getOption.mockReturnValue({ dataZoom: [{ startValue: startMs, endValue: startMs + 3600_000 }] })
    chart.setOption.mockClear()
    handlers.dataZoom()
    await wrapper.vm.$nextTick()

    const [patch, opts] = lastCall()
    expect(opts).toEqual({ replaceMerge: ['series'] })
    // no dataZoom/xAxis in the patch: nothing to fight the drag. The y-axis follows the window:
    // the 10:00 bucket holds 51,200 tokens -> 53,248 with headroom -> a tidy 60,000.
    expect(Object.keys(patch).sort()).toEqual(['series', 'yAxis'])
    expect(patch.yAxis.max).toBe(60000)
    expect(wrapper.text()).toContain('bars are 1 min wide')
    expect(patch.series[0].barWidth).toBeLessThan(full.series[0].barWidth + 1) // 1-minute bars are thin
    // same data, finer buckets: totals are preserved
    expect(seriesTotal({ series: patch.series })).toBe(seriesTotal(full))
    // bars now sit at 1-minute-bucket midpoints
    const xs = patch.series.flatMap((s) => s.data.map((d) => d.value[0]))
    expect(xs.every((x) => (x - 30_000) % 60_000 === 0)).toBe(true)

    // panning to a quieter hour rescales the y-axis to what is on screen (3,400 -> 3,536 -> 4,000)
    const quiet = new Date(2026, 9, 21, 11, 0).getTime()
    chart.getOption.mockReturnValue({ dataZoom: [{ startValue: quiet, endValue: quiet + 3600_000 }] })
    chart.setOption.mockClear()
    handlers.dataZoom()
    expect(lastCall()[0].yAxis.max).toBe(4000)
  })

  it('falls back to the percent range when ECharts reports no values', async () => {
    await open()
    chart.getOption.mockReturnValue({ dataZoom: [{ start: 0, end: 100 }] })
    chart.setOption.mockClear()
    handlers.dataZoom()
    expect(lastCall()[1]).toEqual({ replaceMerge: ['series'] })
    expect(wrapper.text()).toContain('bars are 1 hour wide')
  })

  it('builds the tooltip from text nodes, so labels cannot inject HTML', async () => {
    const hostile = makeUsage()
    hostile.dict['service.name'] = ['<img src=x onerror="window.__pwned=1">', 'plain']
    await open(hostile)
    const option = lastFull()
    const si = option.series.findIndex((s) => s.name.includes('<img')) // the hostile label, as a series
    const hostileSeries = option.series[si]
    const j = hostileSeries.data.findIndex((d) => d.value[1] > 0)
    const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: hostileSeries.data[j].value })
    expect(el).toBeInstanceOf(HTMLElement)
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('<img src=x onerror=')
    expect(el.querySelector('.viz-tip-head').textContent).toMatch(/Oct/)
    expect(el.querySelector('.viz-tip-val').textContent).toMatch(/\d/)
    expect(window.__pwned).toBeUndefined()
    // an empty (invisible) segment shows no tooltip
    expect(option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: [0, 0] })).toBe('')
  })

  it('builds the model split from text nodes too, so a model name cannot inject HTML', async () => {
    const hostile = makeUsage()
    hostile.dict.model = ['<img src=x onerror="window.__pwned3=1">', 'claude-opus-5-5']
    await open(hostile)
    const option = lastFull()
    const si = option.series.findIndex((s) => s.name === 'claude-code')
    const j = option.series[si].data.findIndex((d) => d.value[1] === 51200)
    const el = option.tooltip.formatter({ dataIndex: j, seriesIndex: si, value: option.series[si].data[j].value })
    const block = el.querySelector('.viz-tip-models')
    expect(block.textContent).toContain('<img src=x onerror=')
    expect(block.querySelector('img')).toBeNull()
    expect(window.__pwned3).toBeUndefined()
  })

  it('says the data file is out of date, rather than crashing, when it predates measures', async () => {
    const old = makeUsage()
    delete old.measures
    await open(old)
    expect(wrapper.text()).toContain('Could not load /data/claude/usage.json')
    expect(wrapper.text()).toContain('out of date')
    expect(wrapper.text()).toContain('npm run data')
    expect(chart.setOption).not.toHaveBeenCalled()
  })

  it('offers a table view of the visible buckets', async () => {
    await open()
    expect(wrapper.find('.viz-table').exists()).toBe(false)
    const details = wrapper.find('details.viz-details')
    details.element.open = true
    await details.trigger('toggle')
    const rows = wrapper.findAll('.viz-table tbody tr')
    expect(rows.length).toBeGreaterThan(0)
    expect(wrapper.findAll('.viz-table thead th').map((th) => th.text())).toEqual(['Time', 'claude-code', 'claude-code-desktop', 'Total'])
    // the Total column adds up to the chart total
    const totals = wrapper.findAll('.viz-table tbody tr td:last-child').map((td) => Number(td.text().replace(/,/g, '')))
    expect(totals.reduce((a, b) => a + b, 0)).toBe(sumBy(tokenRows()))
  })

  describe('table view total', () => {
    const openTable = async () => {
      const details = wrapper.find('details.viz-details')
      details.element.open = true
      await details.trigger('toggle')
    }
    const head = () => wrapper.findAll('.viz-table thead th').map((th) => th.text())
    const foot = () => wrapper.findAll('.viz-table tfoot tr').map((tr) => tr.findAll('th, td').map((c) => c.text()))
    const zoomTo = async (startMs, endMs) => {
      chart.getOption.mockReturnValue({ dataZoom: [{ startValue: startMs, endValue: endMs }] })
      handlers.dataZoom()
      await wrapper.vm.$nextTick()
    }

    it('adds a Total row at the bottom that sums every column, including the Total column', async () => {
      await open()
      await openTable()
      expect(head()).toEqual(['Time', 'claude-code', 'claude-code-desktop', 'Total'])
      expect(foot()).toEqual([['Total', '51,990', '3,400', '55,390']])
      // it is the last row of the table, after the body, and equals what the visible cells add up to
      expect(wrapper.find('.viz-table').element.lastElementChild.tagName).toBe('TFOOT')
      const cell = (td) => Number(td.text().replace(/,/g, '') || 0)
      const rows = wrapper.findAll('.viz-table tbody tr').map((tr) => tr.findAll('td').map(cell))
      const sums = rows[0].map((_, i) => rows.reduce((a, r) => a + r[i], 0))
      expect(foot()[0].slice(1).map((t) => Number(t.replace(/,/g, '')))).toEqual(sums)
      expect(sums.at(-1)).toBe(sumBy(tokenRows())) // and the grand total is the chart's total
    })

    it('formats the totals like the cells, so cost is in dollars', async () => {
      await open()
      await select('Y-axis').setValue(COST_USAGE)
      await openTable()
      expect(foot()).toEqual([['Total', '$0.75', '$1.50', '$2.25']])
    })

    it('has just the label and one total when there is a single series', async () => {
      await open()
      await select('Color by').setValue('-1') // None: one series, named after the measure
      await openTable()
      expect(head()).toEqual(['Time', 'Token usage'])
      expect(foot()).toEqual([['Total', '55,390']])
    })

    it('follows the zoom: only the visible buckets are added up, and a column with nothing shows 0', async () => {
      await open()
      await openTable()
      const hour = new Date(2026, 9, 21, 11, 0).getTime() // only the desktop session has data in this hour
      await zoomTo(hour, hour + 3600_000)
      expect(foot()).toEqual([['Total', '0', '3,400', '3,400']])
    })

    it('has no total row when nothing is visible', async () => {
      await open()
      await openTable()
      const quiet = new Date(2026, 9, 20, 20, 0).getTime() // no data this evening
      await zoomTo(quiet, quiet + 3600_000)
      expect(wrapper.findAll('.viz-table tbody tr')).toHaveLength(0)
      expect(wrapper.find('.viz-table tfoot').exists()).toBe(false)
    })
  })

  it('explains how to fix a failed load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })))
    wrapper = mount(UsageChart, { attachTo: document.body, ...provideScope(makeScope()) })
    await flushPromises()
    expect(wrapper.text()).toContain('Could not load /data/claude/usage.json')
    expect(wrapper.text()).toContain('npm run dev')
  })

  it('handles logs with no metrics yet', async () => {
    await open(makeUsage({ extent: null }))
    expect(wrapper.text()).toContain('No metrics found in the logs yet.')
  })

  it('folds sessions beyond the top seven into one Other series', async () => {
    const many = makeUsage()
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}-${'0'.repeat(30)}`)
    many.dict['session.id'] = ids
    many.sessions = ids.map((id, idx) => ({ idx, id, start: day(20), end: day(20), repo: '', cost: 1, first: '' }))
    // ten sessions, each with a token row and a cost row; session i costs i+1
    many.measures[0].rows = ids.map((_, i) => [day(20, 10), 100, 0, 0, 0, i, 0, 0, 0, 0])
    many.measures[1].rows = ids.map((_, i) => [day(20, 10), i + 1, 0, 0, 0, i, 0, 0, 0, 6])
    await open(many)
    await select('Color by').setValue('3')
    const names = seriesNames(lastFull())
    expect(names).toHaveLength(8)
    expect(names.at(-1)).toBe('Other (3)')
    expect(lastFull().series.at(-1).itemStyle.color).toBe('#898781') // the neutral "Other" gray, not a hue
    expect(seriesTotal(lastFull())).toBe(1000)
  })
})

describe('time range', () => {
  const NOW = new Date(2026, 9, 22, 12, 0, 0) // 22 Oct 2026, noon: inside the fixture's data (20-22 Oct)
  const presetButtons = () => wrapper.findAll('.viz-presets button') // the calendar button follows the presets
  const preset = (label) => presetButtons().find((b) => b.text() === label)
  const pressed = () => wrapper.findAll('.viz-presets button[aria-pressed="true"]').map((b) => b.attributes('title') ?? b.text())
  const lastZoom = () => chart.dispatchAction.mock.calls.at(-1)[0]
  const calendarButton = () => wrapper.find('.viz-cal-trigger')
  const dayButton = (key) => wrapper.find(`.viz-cal-day[data-day="${key}"]`)
  const summary = () => wrapper.find('.viz-summary').text()
  const rangeLine = () => wrapper.find('.viz-range-now').text()
  const tokensSince = (ms) => sumBy(rowsOf(usage, TOKEN_USAGE), (r) => r[0] * 1000 >= ms)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }) // only the clock: promises and the test's own waits keep working
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('has 24hr, 1week, 1month, 6months and All, then a calendar button', async () => {
    await open()
    expect(presetButtons().map((b) => b.text())).toEqual(['24hr', '1week', '1month', '6months', 'All', ''])
    expect(presetButtons().at(-1).classes()).toContain('viz-cal-trigger') // the calendar button is last
    expect(presetButtons().at(-1).find('svg').exists()).toBe(true)
    expect(calendarButton().attributes('aria-label')).toBe('Pick a date range')
    expect(presetButtons().every((b) => b.attributes('title'))).toBe(true) // each says what it is, in words
  })

  it('opens on the last 24 hours, which is marked as the one in use', async () => {
    await open(usage, {}) // no initialRange: what the site does
    expect(pressed()).toEqual(['Last 24 hours'])
    expect(rangeLine()).toBe('Showing 21 Oct 2026, 12:00 – 22 Oct 2026, 12:00')
    expect(lastFull().dataZoom[0]).toMatchObject({ startValue: NOW.getTime() - 24 * 3600_000, endValue: NOW.getTime() })
    expect(summary()).toContain('bars are 30 min wide') // 24 hours across: 48 bars of 30 minutes, not the day-wide bars of the whole data
  })

  it('the numbers above the plot are for those 24 hours', async () => {
    await open(usage, {})
    const expected = tokensSince(NOW.getTime() - 24 * 3600_000)
    expect(expected).toBeGreaterThan(0)
    expect(summary()).toContain(expected.toLocaleString('en-US'))
    expect(summary()).toContain('in the selected time range')
    await preset('All').trigger('click')
    expect(pressed()).toEqual(['All the data'])
    expect(summary()).toContain(sumBy(rowsOf(usage, TOKEN_USAGE)).toLocaleString('en-US'))
  })

  it('can open on another preset, or on All (the initialRange prop)', async () => {
    await open(usage, { initialRange: '1w' })
    expect(pressed()).toEqual(['Last week'])
    wrapper.unmount()
    await open()
    expect(pressed()).toEqual(['All the data'])
    expect(rangeLine()).toBe('Showing 20 Oct 2026, 00:00 – 22 Oct 2026, 23:59')
  })

  it('opens on the last 24 hours even when the data is older: the axis reaches to now and the empty window says so', async () => {
    vi.setSystemTime(new Date(2026, 9, 30, 15, 0)) // a week after the newest data
    await open(usage, {})
    const now = new Date(2026, 9, 30, 15).getTime()
    expect(lastFull().xAxis.max).toBe(new Date(2026, 9, 31).getTime()) // to the end of today, at the first draw
    expect(lastFull().dataZoom[0]).toMatchObject({ startValue: now - 24 * 3600_000, endValue: now })
    expect(wrapper.find('.viz-message').text()).toContain('Nothing was logged in this time range')
    await preset('All').trigger('click')
    expect(wrapper.find('.viz-message').exists()).toBe(false)
    expect(pressed()).toEqual(['All the data'])
  })

  it('stays the last 24 hours through a refresh: a relative window moves on to the new now', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    vi.stubGlobal('fetch', server.fetch)
    wrapper = mountWithNav(UsageChart, {}, makeScope()).wrapper
    for (let i = 0; i < 6; i++) await flushPromises()
    expect(pressed()).toEqual(['Last 24 hours'])
    vi.setSystemTime(new Date(2026, 9, 22, 14, 0)) // two hours later
    server.data = makeUsage() // a fetch always gives a new object, which is what makes the chart draw again
    await wrapper.find('.is-refresh').trigger('click')
    for (let i = 0; i < 6; i++) await flushPromises()
    expect(lastFull().dataZoom[0]).toMatchObject({ startValue: new Date(2026, 9, 21, 14).getTime(), endValue: new Date(2026, 9, 22, 14).getTime() })
    expect(pressed()).toEqual(['Last 24 hours'])
  })

  describe('web fonts', () => {
    const fullDraws = () => chart.setOption.mock.calls.filter(([, o]) => o?.notMerge).length
    const setFonts = (value) => Object.defineProperty(document, 'fonts', { configurable: true, value })
    afterEach(() => { delete document.fonts })

    it('draws once more, in the same window, when the fonts have loaded: the text was measured in a fallback font', async () => {
      let loaded
      setFonts({ ready: new Promise((resolve) => { loaded = resolve }) })
      await open(usage, {})
      const drawn = fullDraws()
      const { startValue, endValue } = lastFull().dataZoom[0]
      loaded()
      for (let i = 0; i < 4; i++) await flushPromises()
      expect(fullDraws()).toBe(drawn + 1)
      expect(lastFull().dataZoom[0]).toMatchObject({ startValue, endValue })
    })

    it('does not need the font API: without it the chart is drawn once and nothing breaks', async () => {
      setFonts(undefined)
      await open(usage, {})
      expect(fullDraws()).toBe(1)
      expect(pressed()).toEqual(['Last 24 hours'])
    })
  })

  it('has no 15m preset and no Usage heading; the totals and the window share one line above the plot, the totals on the left', async () => {
    await open()
    expect(presetButtons().map((b) => b.text())).not.toContain('15m')
    expect(wrapper.find('h1').exists()).toBe(false)
    const row = wrapper.find('.viz-summary-row')
    expect(row.exists()).toBe(true)
    expect(row.findAll('p').map((p) => p.classes()[0])).toEqual(['viz-summary', 'viz-range-now']) // the totals first, then the window
    expect(row.element.nextElementSibling.classList.contains('viz-card')).toBe(true) // directly above the plot
  })

  it('a relative preset is that long up to now: 24hr from noon on the 22nd starts at noon on the 21st', async () => {
    await open()
    await preset('24hr').trigger('click')
    expect(lastZoom()).toMatchObject({ type: 'dataZoom', startValue: new Date(2026, 9, 21, 12).getTime(), endValue: NOW.getTime() })
    expect(pressed()).toEqual(['Last 24 hours'])
    expect(rangeLine()).toBe('Showing 21 Oct 2026, 12:00 – 22 Oct 2026, 12:00')
  })

  it('each preset reaches back by its own span, and never past the first day of data', async () => {
    await open()
    const start = async (label) => { await preset(label).trigger('click'); return lastZoom().startValue }
    expect(await start('24hr')).toBe(NOW.getTime() - 24 * 3600_000)
    const first = new Date(2026, 9, 20).getTime()
    expect(await start('1week')).toBe(first) // 15 Oct is before the data, so the window starts where the data does
    expect(await start('1month')).toBe(first)
    expect(await start('6months')).toBe(first)
    expect(lastZoom().endValue).toBe(NOW.getTime())
  })

  it('shows what is in the window: the headline numbers and the bars follow it', async () => {
    await open()
    expect(summary()).toContain('across 3 sessions')
    expect(summary()).not.toContain('selected time range')
    await preset('24hr').trigger('click') // only the 22 Oct 09:00 datapoints are in the last 24 hours
    const expected = tokensSince(new Date(2026, 9, 21, 12).getTime())
    expect(expected).toBeGreaterThan(0)
    expect(summary()).toContain(expected.toLocaleString('en-US'))
    expect(summary()).toContain('across 1 session in the selected time range')
    await preset('All').trigger('click')
    expect(summary()).toContain(sumBy(rowsOf(usage, TOKEN_USAGE)).toLocaleString('en-US'))
    expect(summary()).not.toContain('selected time range')
  })

  it('All is the whole data again', async () => {
    await open()
    await preset('24hr').trigger('click')
    await preset('All').trigger('click')
    expect(lastZoom()).toMatchObject({ startValue: new Date(2026, 9, 20).getTime(), endValue: new Date(2026, 9, 23).getTime() })
    expect(pressed()).toEqual(['All the data'])
  })

  it('stretches the axis to now when the data is older, so a short window is not squashed to nothing', async () => {
    vi.setSystemTime(new Date(2026, 9, 30, 15, 0)) // a week after the newest data
    await open()
    expect(lastFull().xAxis.max).toBe(new Date(2026, 9, 23).getTime()) // as before until a window asks for more
    await preset('24hr').trigger('click')
    const now = new Date(2026, 9, 30, 15).getTime()
    expect(lastFull().xAxis.max).toBe(new Date(2026, 9, 31).getTime()) // to the end of today
    expect(lastZoom()).toMatchObject({ startValue: now - 24 * 3600_000, endValue: now })
    expect(wrapper.find('.viz-message').text()).toContain('Nothing was logged in this time range')
    expect(summary()).toContain('0') // and the numbers say so
    await preset('All').trigger('click')
    expect(wrapper.find('.viz-message').exists()).toBe(false)
  })

  it('a window drawn by hand is not a preset any more', async () => {
    await open()
    await preset('24hr').trigger('click')
    // ECharts echoes the window the control set: still the preset
    chart.getOption.mockReturnValue({ dataZoom: [{ startValue: lastZoom().startValue, endValue: lastZoom().endValue }] })
    handlers.dataZoom()
    expect(pressed()).toEqual(['Last 24 hours'])
    // the user drags the slider: nothing is marked
    chart.getOption.mockReturnValue({ dataZoom: [{ startValue: day(20, 12) * 1000, endValue: day(21, 12) * 1000 }] })
    handlers.dataZoom()
    await wrapper.vm.$nextTick()
    expect(pressed()).toEqual([])
    expect(summary()).toContain('selected time range')
  })

  it('opens a calendar from the calendar button, and closes it again with Escape', async () => {
    await open()
    expect(wrapper.find('.viz-cal').exists()).toBe(false)
    await calendarButton().trigger('click')
    expect(wrapper.find('.viz-cal').exists()).toBe(true)
    expect(calendarButton().attributes('aria-expanded')).toBe('true')
    await wrapper.find('.viz-cal').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.viz-cal').exists()).toBe(false)
    expect(calendarButton().attributes('aria-expanded')).toBe('false')
  })

  it('zooms to the days picked in the calendar, from the start of the first to the end of the last', async () => {
    await open()
    await calendarButton().trigger('click')
    expect(wrapper.find('.viz-cal-title').text()).toBe('October 2026')
    await dayButton('2026-10-20').trigger('click')
    await dayButton('2026-10-21').trigger('click')
    await wrapper.find('.viz-cal-apply').trigger('click')
    expect(lastZoom()).toMatchObject({ startValue: new Date(2026, 9, 20).getTime(), endValue: new Date(2026, 9, 22).getTime() - 1 })
    expect(wrapper.find('.viz-cal').exists()).toBe(false)
    expect(pressed()).toEqual(['Pick a date range']) // the calendar button is the one marked
    expect(rangeLine()).toBe('Showing 20 Oct 2026, 00:00 – 21 Oct 2026, 23:59')
    expect(summary()).toContain('selected time range')
  })

  it('only offers days from the first day of data to the newest', async () => {
    await open()
    await calendarButton().trigger('click')
    expect(dayButton('2026-10-19').attributes('disabled')).toBeDefined()
    expect(dayButton('2026-10-20').attributes('disabled')).toBeUndefined()
    // the data ends on the 22nd, but today (22 Oct, noon) is the newest day that can be picked
    expect(dayButton('2026-10-21').attributes('disabled')).toBeUndefined()
    expect(dayButton('2026-10-22').attributes('disabled')).toBeUndefined()
    expect(dayButton('2026-10-23').attributes('disabled')).toBeDefined()
  })

  it('a picked range stays through a refresh, while a relative preset moves on to the new now', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    vi.stubGlobal('fetch', server.fetch)
    const mounted = mountWithNav(UsageChart, WHOLE_DATA, makeScope())
    wrapper = mounted.wrapper
    for (let i = 0; i < 6; i++) await flushPromises()
    const refresh = async () => {
      server.data = makeUsage() // a fetch always gives a new object, which is what makes the chart draw again
      await wrapper.find('.is-refresh').trigger('click')
      for (let i = 0; i < 6; i++) await flushPromises()
    }

    await preset('24hr').trigger('click')
    vi.setSystemTime(new Date(2026, 9, 22, 14, 0)) // two hours later
    await refresh()
    expect(lastFull().dataZoom[0]).toMatchObject({ startValue: new Date(2026, 9, 21, 14).getTime(), endValue: new Date(2026, 9, 22, 14).getTime() })
    expect(pressed()).toEqual(['Last 24 hours'])

    await calendarButton().trigger('click')
    await dayButton('2026-10-20').trigger('click')
    await dayButton('2026-10-20').trigger('click') // the same day twice: a one-day range
    await wrapper.find('.viz-cal-apply').trigger('click')
    vi.setSystemTime(new Date(2026, 9, 22, 18, 0))
    await refresh()
    expect(lastFull().dataZoom[0]).toMatchObject({ startValue: new Date(2026, 9, 20).getTime(), endValue: new Date(2026, 9, 21).getTime() - 1 })
  })
})

describe('refresh data', () => {
  const settle = async () => {
    for (let i = 0; i < 6; i++) await flushPromises()
    await wrapper.vm.$nextTick()
  }
  async function openFrom(server) {
    vi.stubGlobal('fetch', server.fetch)
    wrapper = mountWithNav(UsageChart, WHOLE_DATA, makeScope()).wrapper // Refresh is in the navbar, which shares the scope
    await settle()
  }
  const button = () => wrapper.find('.otel-nav-btn.is-refresh')
  const note = () => wrapper.find('.otel-toast')
  const click = async () => {
    await button().trigger('click')
    await settle()
  }
  const pickSession = async (query) => {
    await wrapper.find('#session-search').setValue(query)
    await wrapper.find('.viz-option').trigger('mousedown')
  }
  const requests = ['GET /data/claude/usage.json', 'POST /api/refresh', 'GET /data/claude/usage.json']

  // The same logs a while later: one more day of tokens and cost, all for the first session.
  const later = () => {
    const next = makeUsage({ generatedAt: new Date(2026, 9, 28, 14, 0, 0).toISOString() })
    next.extent = [day(20, 10), day(24, 9)]
    next.measures[0].rows.push([day(24, 9), 5000, 0, 0, 0, 0, 0, 0, 0, 0])
    next.measures[1].rows.push([day(24, 9), 9, 0, 0, 0, 0, 0, 0, 0, 6])
    return next
  }
  // The same data, but the logs now number the first two sessions the other way round.
  const withSessionsSwapped = (payload) => {
    const [a, b, c] = payload.dict['session.id']
    payload.dict['session.id'] = [b, a, c]
    payload.sessions = [payload.sessions[1], payload.sessions[0], payload.sessions[2]].map((s, idx) => ({ ...s, idx }))
    for (const m of payload.measures) m.rows = m.rows.map((r) => Object.assign([...r], { 5: [1, 0, 2][r[5]] }))
    return payload
  }

  it('says the data was "updated", and Refresh is in the navbar, not on the page', async () => {
    await openFrom(makeServer('/data/claude/usage.json', usage))
    expect(button().text()).toBe('Refresh')
    expect(wrapper.find('.viz-root').text()).not.toContain('Refresh data')
    expect(wrapper.find('.viz-sub').text()).toContain('updated')
    expect(wrapper.find('.viz-sub').text()).not.toContain('at launch')
  })

  it('asks the server to re-read the logs, then loads the new data into the chart', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(usage, TOKEN_USAGE)))

    server.data = later()
    await click()
    expect(server.requests()).toEqual(requests)
    expect(server.calls[1].headers['X-Requested-With']).toBe('otelscope')
    expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(later(), TOKEN_USAGE)))
    expect(note().text()).toBe('Data refreshed.')
    expect(wrapper.find('.viz-sub').text()).toContain(formatDateTime(Date.parse(later().generatedAt) / 1000))
  })

  it('keeps the Y-axis, the color field and the chosen session', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    await select('Y-axis').setValue(COST_USAGE)
    await select('Color by').setValue('4') // model
    await pickSession('bbbbbbbb')
    expect(seriesTotal(lastFull())).toBe(1.5)

    server.data = later() // its new rows belong to another session
    await click()
    expect(select('Y-axis').element.value).toBe(COST_USAGE)
    expect(select('Color by').element.value).toBe('4')
    expect(seriesNames(lastFull())).toEqual(['claude-opus-5-5'])
    expect(seriesTotal(lastFull())).toBe(1.5) // still only that session
  })

  it('finds the chosen session again by id when the logs number sessions differently', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    await select('Y-axis').setValue(COST_USAGE)
    await pickSession('bbbbbbbb')
    expect(seriesTotal(lastFull())).toBe(1.5)

    server.data = withSessionsSwapped(later())
    await click()
    expect(seriesTotal(lastFull())).toBe(1.5) // not session aaaaaaaa's 0.5 + 9, which now has the old number
  })

  it('moves a window that was showing the newest data forward with it', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    expect(lastFull().dataZoom[0].startValue).toBe(new Date(2026, 9, 20).getTime())
    expect(lastFull().dataZoom[0].endValue).toBe(new Date(2026, 9, 23).getTime())

    server.data = later()
    await click()
    expect(lastFull().dataZoom[0].startValue).toBe(new Date(2026, 9, 20).getTime())
    expect(lastFull().dataZoom[0].endValue).toBe(new Date(2026, 9, 25).getTime()) // end of the new last day
  })

  it('leaves a window somewhere in the middle where it is', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    chart.getOption.mockReturnValue({ dataZoom: [{ startValue: day(20, 12) * 1000, endValue: day(21, 12) * 1000 }] })
    handlers.dataZoom()

    server.data = later()
    await click()
    expect(lastFull().dataZoom[0].startValue).toBe(day(20, 12) * 1000)
    expect(lastFull().dataZoom[0].endValue).toBe(day(21, 12) * 1000)
  })

  it('keeps the old chart, and says why, when the server cannot re-read the logs', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    const drawn = chart.setOption.mock.calls.length
    server.refresh = { status: 500, body: { error: 'Log directory not found: /data/logs' } }
    server.data = later()
    await click()
    expect(note().text()).toBe('Refresh failed: Log directory not found: /data/logs')
    expect(note().attributes('role')).toBe('alert')
    expect(chart.setOption.mock.calls.length).toBe(drawn) // nothing was redrawn
    expect(server.requests()).toEqual(requests.slice(0, 2)) // and the data file was not re-read
    expect(button().attributes('disabled')).toBeUndefined() // it can be tried again
    expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(usage, TOKEN_USAGE)))
  })

  it('keeps the old chart when the new data file cannot be read, or holds no data', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    const drawn = chart.setOption.mock.calls.length
    server.dataStatus = 500
    await click()
    expect(note().text()).toBe('Refresh failed: 500 S500')

    server.dataStatus = 200
    server.data = makeUsage({ extent: null })
    await click()
    expect(note().text()).toContain('there is no usage data in the logs yet')
    expect(chart.setOption.mock.calls.length).toBe(drawn)
    expect(wrapper.text()).not.toContain('No metrics found')
  })

  it('just reloads the files when the server cannot regenerate them (a static build)', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    server.refresh = { status: 404, body: undefined }
    server.data = later()
    await click()
    expect(server.requests()).toEqual(requests)
    expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(later(), TOKEN_USAGE)))
    expect(note().text()).toContain('cannot re-read the logs')
    expect(note().attributes('role')).toBe('status')
  })

  it('cannot be pressed twice while it is working', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    await openFrom(server)
    let release
    server.hold = new Promise((resolve) => { release = resolve })
    await button().trigger('click')
    await settle()
    expect(button().attributes('disabled')).toBeDefined()
    expect(button().attributes('aria-busy')).toBe('true')
    await button().trigger('click')
    release()
    await settle()
    expect(server.requests().filter((r) => r.startsWith('POST'))).toHaveLength(1)
    expect(button().attributes('aria-busy')).toBe('false')
  })

  it('can recover a page whose first load failed', async () => {
    const server = makeServer('/data/claude/usage.json', usage)
    server.dataStatus = 404
    await openFrom(server)
    expect(wrapper.text()).toContain('Could not load')
    expect(chart.setOption).not.toHaveBeenCalled()

    server.dataStatus = 200
    await click()
    expect(wrapper.text()).not.toContain('Could not load')
    expect(seriesTotal(lastFull())).toBe(sumBy(rowsOf(usage, TOKEN_USAGE)))
    expect(note().text()).toBe('Data refreshed.')
  })
})
