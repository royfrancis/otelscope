<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useData } from 'vitepress'
import {
  GROUP_COL, MAX_NAMED, aggregate, bucketLabel, bucketStart, describeSlots, filterRows, formatDateTime, formatMetricValue,
  formatStep, makeGrouper, pickStep, presentDict, rankEntities, sessionLabel, sumRows,
} from '../lib/aggregate.js'
import { GRID, barWidthFor, buildOption, buildSeries, visibleMax } from '../lib/chartOption.js'
import { fetchJson } from '../lib/data.js'
import { followRange } from '../lib/refresh.js'
import { endOfDay, startOfDay } from '../lib/calendar.js'
import { useScope } from '../lib/scope.js'
import { DEFAULT_PRESET_KEY, PRESETS, describeWindow, presetByKey, presetWindow } from '../lib/timeRange.js'
import DateRangePicker from './DateRangePicker.vue'
import Icon from './Icon.vue'

// Which folder of the log root this tab shows (its data is /data/<source>/usage.json), and what to call it.
// `initialRange` is the key of the Time range preset the chart opens on; the site never sets it, so it always opens on the default.
const props = defineProps({
  source: { type: String, default: 'claude' },
  label: { type: String, default: 'Claude Code' },
  initialRange: { type: String, default: DEFAULT_PRESET_KEY, validator: (key) => Boolean(presetByKey(key)) },
})
const dataUrl = computed(() => `/data/${props.source}/usage.json`)

const { isDark } = useData()
const scope = useScope()

// ---- state ----------------------------------------------------------------------------------
const status = ref('loading') // loading | ready | empty | error
const errorMessage = ref('')
const data = shallowRef(null)
const measureKey = ref('') // what the user picked in "Y-axis": a measure's key ('' until they pick, then the first measure is shown)
const pickedField = ref(null) // what the user picked in "Color by": a field's name, '' for "None", or null until they pick
const selectedSession = ref(null) // dictionary index, or null for all sessions
const range = ref(null) // visible window { startMs, endMs }
const viewState = shallowRef(null) // { starts, values, stepS, slots: [{ name, color }] }
const tableOpen = ref(false)
// What the Time range control last chose: { kind: 'preset', key } (relative ones follow "now" when the data is refreshed),
// { kind: 'custom' } (days picked in the calendar), or null once the user has zoomed or panned by hand.
const activeRange = ref(null)
const calendarOpen = ref(false)
const calendarBounds = shallowRef(null) // { min, max, from, to } the picker opens with
const calendarButton = ref(null)

const rootEl = ref(null)
const chartEl = ref(null)
let chart = null
let theme = null
let axis = null
let axisFloor = 0 // the axis is stretched to here when a window reaches past the newest data (a relative preset on stale data)
let appliedWindow = null // the window the control set, so a window that differs from it later is known to be the user's own zoom
let resizeObserver = null
let frame = 0

// ---- derived data ---------------------------------------------------------------------------
// Everything the dropdowns offer is read from the data file: the measures (the metrics found in the logs) and the fields
// (the attributes found on their datapoints), so a tool that is new to this site needs no code here.
const NO_FIELD = -1 // "Color by: None" is one series: the total
const NO_MEASURE = { key: '', label: '', unit: '', format: 'number', rows: [] }
const measures = computed(() => data.value?.measures ?? [])
const measure = computed(() => measures.value.find((m) => m.key === measureKey.value) ?? measures.value[0] ?? NO_MEASURE)
const measureChoice = computed({ get: () => measure.value.key, set: (key) => (measureKey.value = key) })
const fieldNames = computed(() => data.value?.fields ?? [])
const sessionCol = computed(() => (data.value?.sessionField ? GROUP_COL + fieldNames.value.indexOf(data.value.sessionField) : -1))
const modelIdx = computed(() => (data.value?.modelField ? fieldNames.value.indexOf(data.value.modelField) : -1))

// A field that has one value on every datapoint of this measure would color everything the same: it is not offered.
const distinct = computed(() => fieldNames.value.map((_, i) => presentDict(measure.value.rows, GROUP_COL + i).size))
const colorOptions = computed(() => [
  ...fieldNames.value.map((label, value) => ({ value, label })).filter((o) => distinct.value[o.value] >= 2),
  { value: NO_FIELD, label: 'None (one series)' },
])
// What is actually drawn: the picked field, or - when the pick does not exist for this measure, or nothing was picked -
// the first field that tells apart a handful of things (a model, a type), else the first there is. Derived, so there is
// never a render with a half-valid choice.
const field = computed(() => {
  const options = colorOptions.value
  const picked = pickedField.value === '' ? NO_FIELD : fieldNames.value.indexOf(pickedField.value)
  if (pickedField.value != null && options.some((o) => o.value === picked)) return picked
  return (options.find((o) => o.value !== NO_FIELD && distinct.value[o.value] <= MAX_NAMED) ?? options[0]).value
})
const colorChoice = computed({ get: () => field.value, set: (v) => (pickedField.value = v === NO_FIELD ? '' : fieldNames.value[v]) })
const colorLabel = computed(() => colorOptions.value.find((o) => o.value === field.value)?.label ?? '')
const noField = computed(() => field.value === NO_FIELD)
const labels = computed(() => {
  if (!data.value) return []
  return fieldNames.value.map((f) => (f === data.value.sessionField ? data.value.sessions.map(sessionLabel) : data.value.dict[f]))
})

// Colors follow the entity: they are ranked once, by the first measure's totals over all data, whichever measure,
// field or session is shown, so a model keeps its color when the Y-axis changes.
const grouperFor = computed(() => {
  const cache = new Map()
  const basis = measures.value[0]?.rows ?? []
  return (i) => {
    if (!cache.has(i)) cache.set(i, makeGrouper(rankEntities(basis, GROUP_COL + i, data.value.dict[fieldNames.value[i]])))
    return cache.get(i)
  }
})
const col = computed(() => (noField.value ? -1 : GROUP_COL + field.value))
const rows = computed(() => filterRows(measure.value.rows, { sessionIdx: selectedSession.value, sessionCol: sessionCol.value }))
const slots = computed(() => {
  if (!data.value) return []
  if (noField.value) return rows.value.length ? [{ slot: 0, name: measure.value.label, other: false }] : []
  return describeSlots(grouperFor.value(field.value), labels.value[field.value], presentDict(rows.value, col.value))
})
// What is in the visible window (everything, until the chart has one): the headline numbers follow it.
const inView = computed(() => {
  const w = range.value
  return w ? rows.value.filter((r) => r[0] * 1000 >= w.startMs && r[0] * 1000 <= w.endMs) : rows.value
})
const total = computed(() => sumRows(inView.value))
// A session search that has one session to offer would filter nothing (Copilot's metrics all carry the one id of the VS Code run), so it is left out.
const hasSessions = computed(() => (data.value?.sessions.length ?? 0) > 1)
const sessionCount = computed(() => (sessionCol.value < 0 ? 0 : presentDict(inView.value, sessionCol.value).size))
const windowNote = computed(() => (inView.value.length < rows.value.length ? ' in the selected time range' : ''))
const noneInView = computed(() => status.value === 'ready' && rows.value.length > 0 && inView.value.length === 0)
// A window that ends at midnight (whole days) is told as ending the minute before, so 20-22 Oct does not read "until 23 Oct 00:00".
const rangeText = computed(() => {
  const w = range.value
  if (!w) return ''
  return describeWindow(w.startMs, w.endMs === startOfDay(w.endMs) ? w.endMs - 1 : w.endMs)
})
const activeKey = computed(() => (activeRange.value?.kind === 'preset' ? activeRange.value.key : null))
const isEmpty = computed(() => status.value === 'ready' && rows.value.length === 0)

// ---- session search combobox ----------------------------------------------------------------
const sessionQuery = ref('')
const listOpen = ref(false)
const activeOption = ref(0)

const sessionById = computed(() => data.value?.sessions ?? [])
const matches = computed(() => {
  const terms = sessionQuery.value.toLowerCase().split(/\s+/).filter(Boolean)
  const sorted = [...sessionById.value].sort((a, b) => b.end - a.end)
  const hits = terms.length
    ? sorted.filter((s) => {
        const haystack = `${s.id} ${s.repo} ${s.first} ${formatDateTime(s.start).slice(0, 16)}`.toLowerCase()
        return terms.every((t) => haystack.includes(t))
      })
    : sorted
  return hits.slice(0, 50)
})
const selectedSessionLabel = computed(() => {
  const s = sessionById.value[selectedSession.value]
  return s ? sessionLabel(s) : ''
})

// Opened from the input event, not a watcher: clearing the query after a pick must not reopen the list.
function onSessionInput() {
  activeOption.value = 0
  listOpen.value = true
}

// Picking a session zooms to it: a 30-minute session is invisible inside a 13-day view. Clearing it
// returns to the full range. (Registered after the render watcher below, so the bars are rebuilt first.)
function zoomToSession(idx) {
  if (!chart || !data.value) return
  if (idx == null) return setRange(axis.minMs, axis.maxMs)
  const s = data.value.sessions[idx]
  const pad = Math.max(300, (s.end - s.start) * 0.1) // seconds: 10% either side, at least 5 minutes
  setRange((s.start - pad) * 1000, (s.end + pad) * 1000)
}

function chooseSession(s) {
  selectedSession.value = s.idx
  sessionQuery.value = ''
  listOpen.value = false
}
function clearSession() {
  selectedSession.value = null
  sessionQuery.value = ''
}
function onSessionKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    listOpen.value = true
    activeOption.value = Math.min(matches.value.length - 1, activeOption.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeOption.value = Math.max(0, activeOption.value - 1)
  } else if (e.key === 'Enter' && listOpen.value && matches.value[activeOption.value]) {
    e.preventDefault()
    chooseSession(matches.value[activeOption.value])
  } else if (e.key === 'Escape') {
    listOpen.value = false
  }
}
// What a session is described by depends on what the tool's logs hold: a cost only if there is a cost measure, a folder or a
// first prompt only if the logs name them.
const hasCost = computed(() => sessionById.value.some((s) => s.cost != null))
const hasRepo = computed(() => sessionById.value.some((s) => s.repo))
const hasFirst = computed(() => sessionById.value.some((s) => s.first))
const sessionHint = computed(() => `Search by ${['id', hasRepo.value && 'repo', hasFirst.value && 'first prompt'].filter(Boolean).join(', ')}`)
const sessionMeta = (s) =>
  [s.id.slice(0, 8), hasRepo.value ? s.repo || 'no repo' : '', formatDateTime(s.start).slice(0, 16), hasCost.value ? `$${(s.cost ?? 0).toFixed(2)}` : '']
    .filter(Boolean)
    .join(' · ')

// ---- chart ----------------------------------------------------------------------------------
function readTheme() {
  const cs = getComputedStyle(rootEl.value)
  const v = (name) => cs.getPropertyValue(name).trim()
  return {
    surface: v('--surface-1'), ink1: v('--ink-1'), ink2: v('--ink-2'), ink3: v('--ink-3'),
    grid: v('--grid'), axis: v('--axis'), border: v('--border'), zoomFill: v('--zoom-fill'),
    other: v('--series-other'),
    font: v('--font-sans'),
    series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
  }
}

/** The whole-day extent of the data ({ minMs, dataMaxMs }), and the axis that holds it: longer only if a window reached past it. */
function computeAxis() {
  const [first, last] = data.value.extent
  const lastDay = new Date(bucketStart(last, 86400) * 1000)
  lastDay.setDate(lastDay.getDate() + 1) // end of the last local day
  const dataMaxMs = lastDay.getTime()
  return { minMs: bucketStart(first, 86400) * 1000, dataMaxMs, maxMs: Math.max(dataMaxMs, axisFloor) }
}

const plotWidth = () => Math.max(100, chartEl.value.clientWidth - GRID.left - GRID.right)

function computeView(stepS) {
  const g = noField.value ? { slotOfDict: [] } : grouperFor.value(field.value)
  // Split each segment by model for the tooltip, unless there is no model field or the bars are already colored by model.
  const detail = modelIdx.value < 0 || field.value === modelIdx.value ? null : { col: GROUP_COL + modelIdx.value, labels: labels.value[modelIdx.value] }
  const agg = aggregate(rows.value, { stepS, col: col.value, slotOfDict: g.slotOfDict, slots: slots.value, detail })
  viewState.value = {
    ...agg,
    slots: slots.value.map((s) => ({ name: s.name, color: s.other ? theme.other : theme.series[s.slot] })),
  }
}

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text // labels are untrusted data: never innerHTML
  return node
}

/** The models behind the hovered segment: one line for a single model, a small list when there are several. */
function modelBlock(models) {
  const box = el('div', 'viz-tip-models')
  if (models.length === 1) {
    box.append(el('span', 'viz-tip-caption', 'Model'), el('span', 'viz-tip-model', models[0][0]))
    return box
  }
  box.append(el('div', 'viz-tip-caption', 'Models'))
  for (const [name, value] of models) {
    const row = el('div', 'viz-tip-model-row')
    row.append(el('span', 'viz-tip-val', formatMetricValue(measure.value.format, value)), el('span', 'viz-tip-model', name))
    box.append(row)
  }
  return box
}

function tooltipFormatter(params) {
  if (!(params.value?.[1] > 0)) return '' // an empty (invisible) segment has nothing to show
  const view = viewState.value
  const j = params.dataIndex
  const root = el('div', 'viz-tip')
  root.append(el('div', 'viz-tip-head', bucketLabel(view.starts[j], view.stepS)))
  let sum = 0
  for (let i = view.slots.length - 1; i >= 0; i--) { // top of the stack first, as drawn
    const value = view.values[i][j]
    if (!(value > 0)) continue
    sum += value
    const row = el('div', i === params.seriesIndex ? 'viz-tip-row is-hovered' : 'viz-tip-row')
    const key = el('span', 'viz-tip-key')
    key.style.background = view.slots[i].color
    row.append(key, el('span', 'viz-tip-val', formatMetricValue(measure.value.format, value)), el('span', 'viz-tip-name', view.slots[i].name))
    root.append(row)
    const models = i === params.seriesIndex ? view.detail?.[i]?.[j] : null // hovered segment only; none when colored by model
    if (models?.length) root.append(modelBlock(models))
  }
  if (view.slots.length > 1) {
    const totalRow = el('div', 'viz-tip-total')
    totalRow.append(el('span', null, 'Total'), el('strong', null, formatMetricValue(measure.value.format, sum)))
    root.append(totalRow)
  }
  return root
}

/** Rebuild everything: measure, color field, filters or theme changed. Keeps the zoom window. */
function fullRender() {
  if (!chart || !data.value) return
  const stepS = pickStep((range.value.endMs - range.value.startMs) / 1000)
  computeView(stepS)
  chart.setOption(
    buildOption({
      theme, metric: measure.value, view: viewState.value, slots: viewState.value.slots,
      axis, range: range.value, plotWidth: plotWidth(), tooltipFormatter,
    }),
    { notMerge: true },
  )
}

/** Zoom or resize: swap only the bars (new bucket size and/or width). The zoom state is untouched. */
function updateBars() {
  if (!chart || !data.value) return
  const stepS = pickStep((range.value.endMs - range.value.startMs) / 1000)
  if (stepS !== viewState.value.stepS) computeView(stepS)
  const barWidth = barWidthFor(viewState.value.stepS, plotWidth(), range.value)
  const patch = { series: buildSeries({ theme, view: viewState.value, slots: viewState.value.slots, barWidth }) }
  const max = visibleMax(viewState.value, range.value)
  if (max != null) patch.yAxis = { max } // follow the visible window; nothing visible keeps the last scale
  chart.setOption(patch, { replaceMerge: ['series'] })
}

// ECharts reports wheel/slider zooms in percent and recomputes startValue/endValue (checked against
// the real library in tests/chart.test.js). getOption() clones every series, so read it once per frame
// rather than on every wheel tick.
function readRange() {
  const dz = chart?.getOption().dataZoom?.[0]
  if (!dz) return false
  const span = axis.maxMs - axis.minMs
  range.value = {
    startMs: dz.startValue ?? axis.minMs + (dz.start / 100) * span,
    endMs: dz.endValue ?? axis.minMs + (dz.end / 100) * span,
  }
  if (appliedWindow && (Math.abs(range.value.startMs - appliedWindow.startMs) > 1000 || Math.abs(range.value.endMs - appliedWindow.endMs) > 1000)) {
    activeRange.value = null // zoomed or panned by hand: no preset describes this window any more
    appliedWindow = null
  }
  return true
}

function onZoom() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (readRange()) updateBars()
  })
}

function setRange(startMs, endMs) {
  chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(axis.minMs, startMs), endValue: Math.min(axis.maxMs, endMs) })
}

/** A window fitted to the axis; it first stretches the axis if the window reaches past the newest data. Returns the fitted window. */
function fit({ startMs, endMs }) {
  if (endMs > axis.maxMs) axisFloor = Math.max(axisFloor, endOfDay(endMs) + 1)
  axis = computeAxis()
  return { startMs: Math.max(axis.minMs, startMs), endMs: Math.min(axis.maxMs, endMs) }
}

/** The window a Time range choice stands for right now. */
function windowOf(active) {
  const preset = active.kind === 'preset' ? presetByKey(active.key) : null
  return preset ? presetWindow(preset, Date.now(), { minMs: axis.minMs, dataMaxMs: axis.dataMaxMs }) : { startMs: active.startMs, endMs: active.endMs }
}

function applyRange(active) {
  if (!chart || !data.value) return
  const widest = axis.maxMs
  const w = fit(windowOf(active))
  if (axis.maxMs !== widest) fullRender() // the axis grew: draw it before moving the window onto the new part
  activeRange.value = active
  appliedWindow = w
  range.value = w
  setRange(w.startMs, w.endMs)
}
const applyPreset = (preset) => applyRange({ kind: 'preset', key: preset.key })

function openCalendar() {
  if (calendarOpen.value) return closeCalendar()
  const w = range.value
  calendarBounds.value = {
    min: axis.minMs,
    max: Math.max(axis.dataMaxMs - 1, Date.now()), // the newest data's day, or today if that is later
    from: w ? w.startMs : null,
    to: w ? w.endMs - 1 : null,
  }
  calendarOpen.value = true
}
function closeCalendar() {
  calendarOpen.value = false
  nextTick(() => calendarButton.value?.focus())
}
function applyCalendar({ startMs, endMs }) {
  calendarOpen.value = false
  applyRange({ kind: 'custom', startMs, endMs })
  nextTick(() => calendarButton.value?.focus())
}

// ---- table view (the accessible alternative to the chart) -----------------------------------
const tableRows = computed(() => {
  const view = viewState.value
  if (!tableOpen.value || !view || !range.value) return []
  const out = []
  view.starts.forEach((start, j) => {
    const startMs = start * 1000
    if (startMs + view.stepS * 1000 < range.value.startMs || startMs > range.value.endMs) return
    const values = view.values.map((series) => series[j])
    out.push({ key: start, label: bucketLabel(start, view.stepS), values, total: values.reduce((a, b) => a + b, 0) })
  })
  return out.slice(-500)
})
// The bottom row adds up the rows shown, so it always equals what the columns above add up to.
const tableTotals = computed(() => {
  const values = viewState.value ? viewState.value.slots.map((_, i) => tableRows.value.reduce((a, r) => a + r.values[i], 0)) : []
  return { values, total: values.reduce((a, b) => a + b, 0) }
})
const fmt = (v) => (v > 0 ? formatMetricValue(measure.value.format, v) : '')
const fmtTotal = (v) => formatMetricValue(measure.value.format, v) // a total of zero is shown as 0, not left blank

// ---- lifecycle ------------------------------------------------------------------------------
/** Reads usage.json and checks it. Throws, and changes nothing, if it cannot. */
async function fetchUsage() {
  const json = await fetchJson(dataUrl.value)
  // A usage.json written by an older version of the data step has no measures: say so, not a crash.
  if (!Array.isArray(json.measures) || !json.fields || !json.dict) throw new Error('the data file is out of date; run npm run data and reload')
  return json
}

async function loadData() {
  try {
    data.value = await fetchUsage()
  } catch (err) {
    errorMessage.value = String(err.message ?? err)
    status.value = 'error'
    return false
  }
  if (!data.value.extent) {
    status.value = 'empty'
    return false
  }
  return true
}

async function initChart() {
  const [core, charts, components, renderers] = await Promise.all([
    import('echarts/core'), import('echarts/charts'), import('echarts/components'), import('echarts/renderers'),
  ])
  core.use([charts.BarChart, components.GridComponent, components.TooltipComponent, components.LegendComponent, components.DataZoomComponent, renderers.SVGRenderer])
  chart = core.init(chartEl.value, null, { renderer: 'svg' })
  chart.on('dataZoom', onZoom)
}

async function startChart() {
  await nextTick() // the card is shown now, so the chart element has a size
  await initChart()
  theme = readTheme()
  axis = computeAxis()
  const active = { kind: 'preset', key: props.initialRange } // the last 24 hours, until the user chooses or zooms
  const w = fit(windowOf(active)) // the same path a click on the preset takes: it stretches the axis to now if the data is older
  range.value = w
  activeRange.value = active
  appliedWindow = { ...w }
  fullRender()
  // The first draw may measure legend and axis text in a fallback font: draw once more when the web fonts are in (the zoom window is kept).
  document.fonts?.ready?.then(() => chart && fullRender())
  resizeObserver = new ResizeObserver(() => {
    if (!chart) return
    chart.resize()
    updateBars()
  })
  resizeObserver.observe(chartEl.value)
}

let unregister = () => {}
onMounted(async () => {
  // registered whether or not the first load worked, so Refresh can recover a page that failed to load
  unregister = scope.register(reload)
  if (!(await loadData())) return
  status.value = 'ready'
  await startChart()
})

/**
 * Refresh (the navbar button, see lib/scope.js): swap in newly read data and keep the view. The zoom window follows the data (see followRange),
 * the chosen session is found again by id, and the color field, Y-axis and table stay as they are. If the read fails
 * this throws before anything changes, so the old chart stays up.
 */
async function reload() {
  const json = await fetchUsage()
  if (!json.extent) throw new Error('there is no usage data in the logs yet')
  if (!chart) { // the first load failed or found nothing: there is no chart to update, so start one
    data.value = json
    status.value = 'ready'
    await startChart()
    return
  }
  const sessionId = data.value.sessions[selectedSession.value]?.id
  const oldAxis = axis
  data.value = json
  axis = computeAxis()
  const active = activeRange.value
  if (active?.kind === 'preset') {
    // a relative window is worked out again, so "24hr" is the day up to now and "All" takes in the new data
    range.value = fit(windowOf(active))
    appliedWindow = range.value
  } else if (active?.kind === 'custom') {
    range.value = fit({ startMs: range.value.startMs, endMs: range.value.endMs }) // picked days stay where they were
    appliedWindow = range.value
  } else {
    const days = (a) => ({ minMs: a.minMs, maxMs: a.dataMaxMs })
    range.value = followRange(range.value, days(oldAxis), days(axis)) // before the render watcher runs, so it draws the new window
  }
  selectedSession.value = sessionId == null ? null : (json.sessions.find((s) => s.id === sessionId)?.idx ?? null)
}

onBeforeUnmount(() => {
  unregister()
  cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  chart?.dispose()
  chart = null
})

watch([rows, field, measure], fullRender)
watch(selectedSession, zoomToSession)
watch(isDark, async () => {
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve)) // wait for VitePress to swap the class
  theme = readTheme()
  fullRender()
})

const generatedAt = computed(() => (data.value ? formatDateTime(Date.parse(data.value.generatedAt) / 1000) : ''))
// the unit the logs name, when it is worth saying after a number ("tokens"); a duration or an amount of money says itself
const unit = computed(() => (measure.value.format === 'number' ? String(measure.value.unit ?? '').replace(/[{}]/g, '').replace(/^1$/, '') : ''))
</script>

<template>
  <div ref="rootEl" class="viz-root" data-view="usage">
    <p class="viz-sub">
      {{ label }} usage from the OTEL data<template v-if="data"> · read from <code>{{ data.source }}</code> (updated {{ generatedAt }})</template>.
    </p>

    <div class="viz-controls">
      <div class="viz-field">
        <span class="viz-label" id="range-label">Time range</span>
        <div class="viz-segment viz-presets" role="group" aria-labelledby="range-label">
          <button
            v-for="p in PRESETS"
            :key="p.key"
            type="button"
            class="viz-btn"
            :title="p.title"
            :aria-pressed="activeKey === p.key"
            :disabled="status !== 'ready'"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
          <span class="viz-cal-anchor">
            <button
              ref="calendarButton"
              type="button"
              class="viz-btn viz-cal-trigger"
              title="Pick a date range"
              aria-label="Pick a date range"
              aria-haspopup="dialog"
              :aria-expanded="calendarOpen"
              :aria-pressed="activeRange?.kind === 'custom'"
              :disabled="status !== 'ready'"
              @click="openCalendar"
            >
              <Icon name="calendar" />
            </button>
            <DateRangePicker
              v-if="calendarOpen"
              :min="calendarBounds.min"
              :max="calendarBounds.max"
              :from="calendarBounds.from"
              :to="calendarBounds.to"
              @apply="applyCalendar"
              @close="closeCalendar"
            />
          </span>
        </div>
      </div>

      <label class="viz-field">
        Y-axis
        <select v-model="measureChoice">
          <option v-for="m in measures" :key="m.key" :value="m.key">{{ m.label }}</option>
        </select>
      </label>

      <label class="viz-field">
        Color by
        <select v-model.number="colorChoice">
          <option v-for="o in colorOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>

      <div v-if="hasSessions" class="viz-field viz-session">
        <label for="session-search">Session</label>
        <div class="viz-session-row">
          <input
            id="session-search"
            v-model="sessionQuery"
            type="search"
            role="combobox"
            autocomplete="off"
            aria-autocomplete="list"
            aria-controls="session-listbox"
            :aria-expanded="listOpen"
            :aria-activedescendant="listOpen && matches[activeOption] ? `session-opt-${activeOption}` : undefined"
            :placeholder="sessionHint"
            :disabled="status !== 'ready'"
            @input="onSessionInput"
            @focus="listOpen = true"
            @blur="listOpen = false"
            @keydown="onSessionKey"
          />
          <span v-if="selectedSession != null" class="viz-chip" :title="data.sessions[selectedSession].id">
            <span>{{ selectedSessionLabel }}</span>
            <button type="button" aria-label="Show all sessions" @click="clearSession">×</button>
          </span>
        </div>
        <ul v-show="listOpen" id="session-listbox" class="viz-listbox" role="listbox" aria-label="Sessions">
          <li
            v-for="(s, i) in matches"
            :id="`session-opt-${i}`"
            :key="s.id"
            class="viz-option"
            role="option"
            :aria-selected="i === activeOption"
            @mousedown.prevent="chooseSession(s)"
            @mousemove="activeOption = i"
          >
            <span class="first">{{ s.first || '(no prompt logged)' }}</span>
            <span class="meta">{{ sessionMeta(s) }}</span>
          </li>
          <li v-if="matches.length === 0" class="viz-none">No session matches “{{ sessionQuery }}”.</li>
        </ul>
      </div>
    </div>

    <!-- one line above the plot: what is in the window on the left, the window itself on the right -->
    <div v-if="status === 'ready' && (!isEmpty || rangeText)" class="viz-summary-row">
      <p v-if="!isEmpty" class="viz-summary" aria-live="polite">
        {{ formatMetricValue(measure.format, total) }}
        {{ unit }}<template v-if="hasSessions"> across {{ sessionCount }} session{{ sessionCount === 1 ? '' : 's' }}</template>{{ windowNote }}
        <template v-if="viewState"> · bars are {{ formatStep(viewState.stepS) }} wide</template>
      </p>
      <p v-if="rangeText" class="viz-range-now">Showing {{ rangeText }}</p>
    </div>

    <div v-show="status === 'ready'" class="viz-card">
      <div
        ref="chartEl"
        class="viz-chart"
        role="img"
        :aria-label="`Stacked bar chart of ${measure.label} over time, colored by ${colorLabel}. A table view follows the chart.`"
      ></div>
      <div v-if="isEmpty" class="viz-message">Nothing to show for this selection. Check the filters above.</div>
      <div v-else-if="noneInView" class="viz-message">Nothing was logged in this time range. Pick a wider one.</div>
    </div>

    <div v-if="status !== 'ready'" class="viz-card" style="min-height: 200px">
      <div v-if="status === 'loading'" class="viz-message">Loading…</div>
      <div v-else-if="status === 'empty'" class="viz-message">No metrics found in the logs yet.</div>
      <div v-else class="viz-message is-error">
        <span>Could not load <code>{{ dataUrl }}</code> ({{ errorMessage }}). Start the site with <code>npm run dev</code> so the data is generated first, or press Refresh in the bar above.</span>
      </div>
    </div>

    <p v-if="status === 'ready'" class="viz-hint">
      Scroll to zoom, drag to pan, or use the slider under the chart. Bars regroup into finer or coarser time buckets as you zoom.
    </p>

    <details v-if="status === 'ready'" class="viz-details" @toggle="tableOpen = $event.target.open">
      <summary>Table view</summary>
      <div v-if="tableOpen" class="viz-table-wrap">
        <table class="viz-table">
          <caption class="viz-hint" style="text-align: left; caption-side: top; padding: 8px 12px 0">
            {{ measure.label }} per {{ viewState ? formatStep(viewState.stepS) : '' }}, for the visible time range
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th v-for="s in viewState.slots" :key="s.name" scope="col" class="num">{{ s.name }}</th>
              <th v-if="viewState.slots.length > 1" scope="col" class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in tableRows" :key="r.key">
              <th scope="row" class="nowrap" style="font-weight: 400">{{ r.label }}</th>
              <td v-for="(v, i) in r.values" :key="i" class="num">{{ fmt(v) }}</td>
              <td v-if="viewState.slots.length > 1" class="num">{{ fmt(r.total) }}</td>
            </tr>
          </tbody>
          <tfoot v-if="tableRows.length">
            <tr>
              <th scope="row">Total</th>
              <td v-for="(v, i) in tableTotals.values" :key="i" class="num">{{ fmtTotal(v) }}</td>
              <td v-if="viewState.slots.length > 1" class="num">{{ fmtTotal(tableTotals.total) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  </div>
</template>
