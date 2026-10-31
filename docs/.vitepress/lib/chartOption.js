// Builds the ECharts option for the usage chart. Pure: colors, data and callbacks come in as
// arguments, so the same function renders in the browser and in the SSR test.
import { barWidthPx, formatMetricAxis } from './aggregate.js'

export const GRID = { left: 64, right: 20, topWithLegend: 48, top: 20, bottom: 72 }

// single quotes: valid inside an SVG attribute too (server-side rendering writes this verbatim). The site's own font
// (--font-sans, passed in as theme.font) comes first when there is one.
const FALLBACK_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

/** Index of the highest series with a value in each bucket (the one that gets the rounded cap). */
function topSeriesPerBucket(values, bucketCount) {
  return Array.from({ length: bucketCount }, (_, j) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i][j] > 0) return i
    return -1
  })
}

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** Round up to a tidy axis maximum (0.4, 500, 60000, ...). Undefined when there is nothing to scale to. */
export function niceCeil(v) {
  if (!(v > 0)) return undefined
  const base = 10 ** Math.floor(Math.log10(v))
  const mantissa = v / base
  return (NICE_STEPS.find((s) => s >= mantissa - 1e-9) ?? 10) * base
}

/**
 * Y-axis maximum for the visible window: the tallest stacked bucket that overlaps it. ECharts scales
 * the axis to all the data, so without this a zoomed-in view would be a few flat slivers.
 */
export function visibleMax(view, range) {
  let max = 0
  view.starts.forEach((start, j) => {
    if ((start + view.stepS) * 1000 < range.startMs || start * 1000 > range.endMs) return
    max = Math.max(max, view.values.reduce((sum, series) => sum + series[j], 0))
  })
  return niceCeil(max * 1.04)
}

/** Bar thickness for the current bucket size and zoom window. */
export function barWidthFor(stepS, plotWidth, range) {
  return barWidthPx(stepS, plotWidth / Math.max(1, (range.endMs - range.startMs) / 1000))
}

/**
 * The bar series only. Zooming replaces just these (see the component), so the dataZoom state the
 * user is dragging is never overwritten.
 * @param view   { starts: seconds[], values: number[][] (series x bucket), stepS }
 * @param slots  [{ name, color }] aligned with view.values
 */
export function buildSeries({ theme, view, slots, barWidth }) {
  const tops = topSeriesPerBucket(view.values, view.starts.length)
  return slots.map((slot, i) => ({
    type: 'bar',
    name: slot.name,
    stack: 'total',
    barWidth,
    // A surface-colored stroke is the 2px gap between touching segments and neighboring bars.
    itemStyle: { color: slot.color, borderColor: theme.surface, borderWidth: 1 },
    emphasis: { focus: 'series' },
    blur: { itemStyle: { opacity: 0.35 } },
    data: view.starts.map((start, j) => {
      const x = (start + view.stepS / 2) * 1000
      const value = view.values[i][j]
      if (!(value > 0)) return { value: [x, 0], itemStyle: { opacity: 0 } } // no stub for empty segments
      return tops[j] === i ? { value: [x, value], itemStyle: { borderRadius: [4, 4, 0, 0] } } : { value: [x, value] }
    }),
  }))
}

/**
 * The full chart option.
 * @param theme   { surface, ink1, ink2, ink3, grid, axis, border, zoomFill, font? }
 * @param metric  { format } how the values are written (see formatMetricAxis)
 * @param axis    { minMs, maxMs } full extent, pinned so re-bucketing never moves the axis
 * @param range   { startMs, endMs } visible window
 */
export function buildOption({ theme, metric, view, slots, axis, range, plotWidth, tooltipFormatter }) {
  const showLegend = slots.length > 1
  const barWidth = barWidthFor(view.stepS, plotWidth, range)
  const series = buildSeries({ theme, view, slots, barWidth })

  return {
    animation: false,
    textStyle: { fontFamily: theme.font || FALLBACK_FONT },
    grid: {
      left: GRID.left,
      right: GRID.right,
      top: showLegend ? GRID.topWithLegend : GRID.top,
      bottom: GRID.bottom,
    },
    legend: {
      show: showLegend,
      type: 'scroll',
      top: 6,
      left: GRID.left,
      icon: 'circle',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 20,
      selectedMode: false,
      textStyle: { color: theme.ink2, fontSize: 12, fontWeight: 500 },
      pageIconColor: theme.ink2,
      pageTextStyle: { color: theme.ink3 },
    },
    xAxis: {
      type: 'time',
      min: axis.minMs,
      max: axis.maxMs,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      // day ticks carry the month ("15 Oct"); the other levels keep ECharts' defaults
      axisLabel: { color: theme.ink3, fontSize: 11, hideOverlap: true, margin: 12, formatter: { day: '{d} {MMM}' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: visibleMax(view, range),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: theme.ink3, fontSize: 11, margin: 12, formatter: (v) => formatMetricAxis(metric.format, v) },
      splitLine: { lineStyle: { color: theme.grid, width: 1, type: 'dashed' } }, // a quiet guide, not a rule
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none', startValue: range.startMs, endValue: range.endMs },
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        startValue: range.startMs,
        endValue: range.endMs,
        height: 24,
        bottom: 8,
        showDataShadow: false,
        brushSelect: false,
        borderColor: theme.border,
        backgroundColor: 'transparent',
        fillerColor: theme.zoomFill,
        textStyle: { color: theme.ink3 },
        handleStyle: { color: theme.surface, borderColor: theme.ink3 },
        moveHandleStyle: { color: theme.ink3, opacity: 0.4 },
      },
    ],
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: 1,
      padding: 0,
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);',
      textStyle: { color: theme.ink1 },
      formatter: tooltipFormatter,
    },
    series,
  }
}
