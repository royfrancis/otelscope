// Renders the real option builder with ECharts' server-side SVG renderer (no browser needed).
// The timezone is set before the library loads (see the note in aggregate.test.js).
process.env.TZ = 'Europe/Stockholm'

import test from 'node:test'
import assert from 'node:assert/strict'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
const { buildOption, GRID, niceCeil, visibleMax } = await import('../docs/.vitepress/lib/chartOption.js')

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, SVGRenderer])

const theme = {
  surface: '#fcfcfb', ink1: '#0b0b0b', ink2: '#52514e', ink3: '#898781',
  grid: '#e1e0d9', axis: '#c3c2b7', border: 'rgba(11,11,11,0.10)', zoomFill: 'rgba(42,120,214,0.15)',
}
const DAY = 86400
const t0 = new Date(2026, 9, 20).getTime() / 1000
const axis = { minMs: t0 * 1000, maxMs: (t0 + 5 * DAY) * 1000 }
const WIDTH = 900
const plotWidth = WIDTH - GRID.left - GRID.right

function render(option) {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: WIDTH, height: 420 })
  chart.setOption(option)
  const svg = chart.renderToSVGString()
  chart.dispose()
  return svg
}

const baseArgs = (slots, values) => ({
  theme,
  metric: { kind: 'tokens' },
  view: { starts: [t0, t0 + DAY, t0 + 2 * DAY], values, stepS: DAY },
  slots,
  axis,
  range: { startMs: axis.minMs, endMs: axis.maxMs },
  plotWidth,
})

test('builds one stacked bar series per slot, with a zero-height-safe, rounded-top layout', () => {
  const option = buildOption(baseArgs(
    [{ name: 'alpha', color: '#2a78d6' }, { name: 'beta', color: '#eb6834' }],
    [[10, 0, 5], [0, 20, 5]],
  ))
  assert.equal(option.series.length, 2)
  assert.ok(option.series.every((s) => s.type === 'bar' && s.stack === 'total'))
  assert.equal(option.legend.show, true)

  const [alpha, beta] = option.series
  // bucket 0: only alpha has data -> it is the top and gets the rounded cap; beta is an invisible zero
  assert.deepEqual(alpha.data[0].itemStyle.borderRadius, [4, 4, 0, 0])
  assert.equal(beta.data[0].itemStyle.opacity, 0)
  // bucket 1: only beta; bucket 2: both -> beta (last in stack order) is the top
  assert.equal(alpha.data[1].itemStyle.opacity, 0)
  assert.deepEqual(beta.data[1].itemStyle.borderRadius, [4, 4, 0, 0])
  assert.equal(alpha.data[2].itemStyle?.borderRadius, undefined)
  assert.deepEqual(beta.data[2].itemStyle.borderRadius, [4, 4, 0, 0])

  // bars sit at the bucket midpoint, and share one capped width
  assert.equal(alpha.data[0].value[0], (t0 + DAY / 2) * 1000)
  assert.equal(alpha.barWidth, 24)
  assert.equal(beta.barWidth, 24)
})

test('the 2px gap is a surface-colored stroke, not a data-colored border', () => {
  const option = buildOption(baseArgs([{ name: 'alpha', color: '#2a78d6' }], [[1, 2, 3]]))
  assert.equal(option.series[0].itemStyle.borderColor, theme.surface)
  assert.equal(option.series[0].itemStyle.color, '#2a78d6')
})

test('a single series has no legend', () => {
  const option = buildOption(baseArgs([{ name: 'alpha', color: '#2a78d6' }], [[1, 2, 3]]))
  assert.equal(option.legend.show, false)
  assert.equal(option.grid.top, GRID.top)
})

test('zoom range is carried by the data zoom, and the axis stays pinned to the full extent', () => {
  const range = { startMs: axis.minMs + 3600_000, endMs: axis.minMs + 7200_000 }
  const option = buildOption({ ...baseArgs([{ name: 'a', color: '#2a78d6' }], [[1, 2, 3]]), range })
  assert.deepEqual(option.dataZoom.map((z) => [z.startValue, z.endValue]), [[range.startMs, range.endMs], [range.startMs, range.endMs]])
  assert.equal(option.dataZoom[0].filterMode, 'none')
  assert.equal(option.xAxis.min, axis.minMs)
  assert.equal(option.xAxis.max, axis.maxMs)
})

test('bars get thinner as the visible window grows relative to the bucket', () => {
  const wide = buildOption({ ...baseArgs([{ name: 'a', color: '#2a78d6' }], [[1, 2, 3]]) })
  const zoomedOut = buildOption({
    ...baseArgs([{ name: 'a', color: '#2a78d6' }], [[1, 2, 3]]),
    view: { starts: [t0, t0 + DAY, t0 + 2 * DAY], values: [[1, 2, 3]], stepS: 3600 },
  })
  assert.ok(zoomedOut.series[0].barWidth < wide.series[0].barWidth)
})

// UsageChart.vue re-buckets from getOption().dataZoom[0].startValue/endValue after every zoom. Wheel and
// slider zooms are percent-based, so this pins down, against the real library, that ECharts recomputes
// the value bounds. (The component tests stub getOption, so they cannot check this.)
test('real ECharts reports the zoomed window in values after a percent-based zoom', () => {
  const span = axis.maxMs - axis.minMs
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: WIDTH, height: 420 })
  try {
    chart.setOption(buildOption(baseArgs([{ name: 'a', color: '#2a78d6' }], [[1, 2, 3]])))
    let events = 0
    chart.on('dataZoom', () => { events++ })
    const window = () => chart.getOption().dataZoom.map((z) => [z.startValue, z.endValue])

    assert.deepEqual(window(), [[axis.minMs, axis.maxMs], [axis.minMs, axis.maxMs]]) // starts at the full extent

    chart.dispatchAction({ type: 'dataZoom', start: 40, end: 60 }) // what a wheel zoom sends
    const wheel = [axis.minMs + 0.4 * span, axis.minMs + 0.6 * span]
    assert.equal(events, 1)
    assert.deepEqual(window(), [wheel, wheel]) // fresh values, and the slider and inside zoom agree

    const [a, b] = [axis.minMs + 1 * DAY * 1000, axis.minMs + 2 * DAY * 1000]
    chart.dispatchAction({ type: 'dataZoom', startValue: a, endValue: b }) // what the presets send
    assert.equal(events, 2)
    assert.deepEqual(window(), [[a, b], [a, b]])
  } finally {
    chart.dispose()
  }
})

test('niceCeil rounds up to a tidy axis maximum', () => {
  assert.equal(niceCeil(0.37), 0.4)
  assert.equal(niceCeil(1), 1)
  assert.equal(niceCeil(1.01), 1.2)
  assert.equal(niceCeil(430), 500)
  assert.equal(niceCeil(3536), 4000)
  assert.equal(niceCeil(53248), 60000)
  assert.equal(niceCeil(0), undefined)
  assert.equal(niceCeil(-5), undefined)
})

test('the y-axis follows the visible window: the tallest stacked bucket that overlaps it', () => {
  // buckets: day 0 total 10, day 1 total 20 (10 + 10), day 2 total 100
  const view = { starts: [t0, t0 + DAY, t0 + 2 * DAY], values: [[10, 10, 100], [0, 10, 0]], stepS: DAY }
  const window = (fromDay, toDay) => ({ startMs: (t0 + fromDay * DAY) * 1000 + 3600_000, endMs: (t0 + toDay * DAY) * 1000 - 3600_000 })
  assert.equal(visibleMax(view, window(0, 3)), 120) // 100 * 1.04 = 104 -> 120
  assert.equal(visibleMax(view, window(0, 1)), 12) // only day 0: 10 * 1.04 -> 12
  assert.equal(visibleMax(view, window(1, 2)), 25) // day 1 stacks two series: 20 * 1.04 = 20.8 -> 25
  assert.equal(visibleMax(view, { startMs: (t0 + 10 * DAY) * 1000, endMs: (t0 + 11 * DAY) * 1000 }), undefined) // nothing in view
  const option = buildOption({ ...baseArgs([{ name: 'a', color: '#2a78d6' }, { name: 'b', color: '#eb6834' }], view.values), range: window(0, 1) })
  assert.equal(option.yAxis.max, 12)
})

test('renders to SVG with one path per visible bar segment and the series colors', () => {
  const option = buildOption(baseArgs(
    [{ name: 'alpha', color: '#2a78d6' }, { name: 'beta', color: '#eb6834' }],
    [[10, 0, 5], [0, 20, 5]],
  ))
  const svg = render(option)
  assert.match(svg, /^<svg/)
  assert.ok(svg.includes('#2a78d6') && svg.includes('#eb6834'), 'series colors are used')
  assert.ok(svg.includes('alpha') && svg.includes('beta'), 'legend names are drawn')
  assert.ok(svg.includes('#fcfcfb'), 'segments are separated by a surface-colored stroke')
})
