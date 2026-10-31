<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  addMonths, clampDay, dayState, isDayDisabled, monthGrid, monthLabel, monthOf, monthStart, moveDay, pickDay, startOfDay,
  weekdayLabels, windowOfDays,
} from '../lib/calendar.js'
import Icon from './Icon.vue'

// A calendar for choosing a "from" and a "to" day: click the first day, then the last (in either order), then Apply.
// `min` and `max` (ms) bound the days that can be picked; `from` and `to` (ms) are the range to start from.
// Emits `apply` with { startMs, endMs } (the start of the first day to the end of the last) and `close`.
const props = defineProps({
  min: { type: Number, default: null },
  max: { type: Number, default: null },
  from: { type: Number, default: null },
  to: { type: Number, default: null },
  weekStart: { type: Number, default: 1 },
})
const emit = defineEmits(['apply', 'close'])

const root = ref(null)
// A range needs its first day; with only an end given there is none to start from (the end still decides the month shown).
const selection = ref(
  props.from == null ? { fromMs: null, toMs: null } : { fromMs: startOfDay(props.from), toMs: startOfDay(props.to ?? props.from) },
)
const hover = ref(null)
const startDay = clampDay(props.to ?? props.from ?? props.max ?? Date.now(), props.min, props.max)
const month = ref(monthOf(startDay))
const focusDay = ref(startDay) // the one day in the tab order; the arrow keys move it

const grid = computed(() => monthGrid(month.value, props.weekStart))
const weekdays = computed(() => weekdayLabels(props.weekStart))
const title = computed(() => monthLabel(month.value))
const today = startOfDay(Date.now())

const canPrev = computed(() => props.min == null || monthStart(month.value) > startOfDay(props.min))
const canNext = computed(() => props.max == null || monthStart(addMonths(month.value, 1)) <= startOfDay(props.max))
const shift = (n) => {
  month.value = addMonths(month.value, n)
}

const fullDay = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' })
const shortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const disabled = (cell) => isDayDisabled(cell.ms, props.min, props.max)
const stateOf = (cell) => dayState(cell.ms, selection.value, hover.value)
const classes = (cell) => {
  const s = stateOf(cell)
  return { 'is-out': !cell.inMonth, 'is-from': s.isFrom, 'is-to': s.isTo, 'in-range': s.inRange, 'is-today': cell.ms === today }
}

const summary = computed(() => {
  const { fromMs, toMs } = selection.value
  if (fromMs == null) return 'Pick the first day'
  if (toMs == null) return `From ${shortDay.format(fromMs)}: pick the last day`
  return fromMs === toMs ? shortDay.format(fromMs) : `${shortDay.format(fromMs)} – ${shortDay.format(toMs)}`
})

function choose(cell) {
  if (disabled(cell)) return
  selection.value = pickDay(selection.value, cell.ms)
  focusDay.value = cell.ms
}
const apply = () => emit('apply', windowOfDays(selection.value))

async function onKey(event, cell) {
  const next = moveDay(cell.ms, event.key, props.weekStart)
  if (next == null) return
  event.preventDefault()
  focusDay.value = clampDay(next, props.min, props.max)
  month.value = monthOf(focusDay.value)
  await nextTick()
  root.value?.querySelector('.viz-cal-day[tabindex="0"]')?.focus()
}

// Closing: Escape, or a click anywhere outside the picker and the button that opened it (its parent).
const onOutside = (e) => {
  const anchor = root.value?.parentElement
  if (anchor && !anchor.contains(e.target)) emit('close')
}
onMounted(async () => {
  document.addEventListener('pointerdown', onOutside)
  await nextTick()
  root.value?.querySelector('.viz-cal-day[tabindex="0"]')?.focus()
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside))
</script>

<template>
  <div ref="root" class="viz-cal" role="dialog" aria-label="Choose a date range" @keydown.esc.stop="emit('close')">
    <div class="viz-cal-head">
      <button type="button" class="viz-btn viz-cal-nav" aria-label="Previous month" :disabled="!canPrev" @click="shift(-1)"><Icon name="chevronLeft" /></button>
      <div class="viz-cal-title" aria-live="polite">{{ title }}</div>
      <button type="button" class="viz-btn viz-cal-nav" aria-label="Next month" :disabled="!canNext" @click="shift(1)"><Icon name="chevronRight" /></button>
    </div>

    <table class="viz-cal-grid" role="grid" :aria-label="title">
      <thead>
        <tr><th v-for="w in weekdays" :key="w" scope="col">{{ w }}</th></tr>
      </thead>
      <tbody @mouseleave="hover = null">
        <tr v-for="(week, i) in grid" :key="i">
          <td v-for="cell in week" :key="cell.key" role="gridcell">
            <button
              type="button"
              class="viz-cal-day"
              :class="classes(cell)"
              :tabindex="cell.ms === focusDay ? 0 : -1"
              :disabled="disabled(cell)"
              :data-day="cell.key"
              :aria-label="fullDay.format(cell.ms)"
              :aria-pressed="stateOf(cell).isFrom || stateOf(cell).isTo"
              @click="choose(cell)"
              @mouseenter="hover = cell.ms"
              @keydown="onKey($event, cell)"
            >{{ cell.day }}</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="viz-cal-foot">
      <span class="viz-cal-summary" aria-live="polite">{{ summary }}</span>
      <button type="button" class="viz-btn" @click="emit('close')">Cancel</button>
      <button type="button" class="viz-btn viz-cal-apply" :disabled="selection.fromMs == null" @click="apply">Apply</button>
    </div>
  </div>
</template>
