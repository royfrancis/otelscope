<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { formatDateTime } from '../lib/aggregate.js'
import { fetchJson } from '../lib/data.js'
import { INITIAL_PAGES, PAGE_SIZE, goToPage, pageRows, searchRows, totalPages, visiblePages } from '../lib/logs.js'
import { useScope } from '../lib/scope.js'

// Which folder of the log root this tab shows, and what to call it. Its Logs are an index of the kinds of log event and span
// it holds (/data/<source>/logs.json) and one file per kind (/data/<source>/logs/<id>.json), loaded when the kind is chosen.
// Nothing here knows a tool: the kinds, the columns and the columns shown first all come from the data.
const props = defineProps({ source: { type: String, default: 'claude' }, label: { type: String, default: 'Claude Code' } })
const scope = useScope()
const indexUrl = computed(() => `/data/${props.source}/logs.json`)
const eventUrl = (id) => `/data/${props.source}/logs/${id}.json`

const LONG_TEXT = 140
const SAMPLE = 100 // rows looked at to tell what a column holds

// ---- state ----------------------------------------------------------------------------------
// What this tab showed when it was last left, if it was (see remember/recall in lib/scope.js). The search and the page are set
// here, not once the rows are read: a change of `query` later would send the pager back to page 1 (the watcher below).
const saved = scope.recall(props.source, 'logs')
const status = ref('loading') // loading | ready | error
const errorMessage = ref('')
const choiceError = ref('') // why the kind just picked could not be shown (the table keeps showing the one before)
const index = shallowRef(null) // { events: [{ id, kind, name, count }], default }
const eventId = ref('') // the kind being shown
const data = shallowRef(null) // that kind's file: { kind, name, fields, defaultColumns, searchFields, rows }
const query = ref(saved?.query ?? '')
const columns = ref([])
const columnFilter = ref('')
const pager = ref(saved ? { ...saved.pager } : { page: 1, loaded: INITIAL_PAGES })
const expanded = ref(new Set()) // "rowIndex|column" keys of expanded long cells
const columnsEl = ref(null)

// ---- derived data ---------------------------------------------------------------------------
const events = computed(() => index.value?.events ?? [])
const kinds = computed(() =>
  [
    { key: 'log', title: 'Log events', events: events.value.filter((e) => e.kind === 'log') },
    { key: 'span', title: 'Spans', events: events.value.filter((e) => e.kind === 'span') },
  ].filter((g) => g.events.length),
)
const eventChoice = computed({
  get: () => eventId.value,
  set: (id) => {
    if (id !== eventId.value) chooseEvent(id)
  },
})

// Rows are newest first.
const allRows = computed(() =>
  data.value ? [...data.value.rows].sort((a, b) => b.time - a.time).map((r, i) => ({ ...r, _i: i })) : [],
)
const noun = computed(() => (data.value?.kind === 'span' ? 'span' : 'event'))
const defaultColumns = computed(() => data.value?.defaultColumns ?? ['time'])
const matches = computed(() => searchRows(allRows.value, query.value, data.value?.searchFields ?? []))
const pageCount = computed(() => totalPages(matches.value.length))
const pages = computed(() => visiblePages(pageCount.value, pager.value.loaded))
const shown = computed(() => pageRows(matches.value, pager.value.page))
const firstShown = computed(() => (matches.value.length ? (pager.value.page - 1) * PAGE_SIZE + 1 : 0))
const lastShown = computed(() => firstShown.value + shown.value.length - (matches.value.length ? 1 : 0))
const moreToLoad = computed(() => pages.value.length < pageCount.value)
const searchHint = computed(() => {
  const fields = (data.value?.searchFields ?? []).slice(0, 3)
  return fields.length ? `Search ${fields.join(', ')}` : 'Search'
})

// Keep the data's column order so the table does not reshuffle as boxes are ticked.
const orderedColumns = computed(() => (data.value?.fields ?? []).filter((f) => columns.value.includes(f)))
const columnChoices = computed(() => {
  const q = columnFilter.value.trim().toLowerCase()
  return (data.value?.fields ?? []).filter((f) => !q || f.toLowerCase().includes(q) || columnLabel(f).toLowerCase().includes(q))
})

// A new search starts again from page 1 with the first 5 page buttons.
watch(query, () => {
  pager.value = { page: 1, loaded: INITIAL_PAGES }
})

const columnLabel = (field) => (field === 'time' ? 'Date / time' : field) // not `label`: that is the tool's name, a prop
const go = (target) => {
  pager.value = goToPage(pager.value, pageCount.value, target)
}
const resetColumns = () => {
  columns.value = [...defaultColumns.value]
}

function toggleColumn(field) {
  columns.value = columns.value.includes(field) ? columns.value.filter((c) => c !== field) : [...columns.value, field]
}

const isLong = (v) => typeof v === 'string' && (v.length > LONG_TEXT || v.includes('\n'))
const cellKey = (row, field) => `${row._i}|${field}`
const isOpen = (row, field) => expanded.value.has(cellKey(row, field))
function toggleCell(row, field) {
  const next = new Set(expanded.value)
  const key = cellKey(row, field)
  if (!next.delete(key)) next.add(key)
  expanded.value = next
}
const display = (v) => (v == null ? '' : String(v))

// What a column holds, from a sample of its rows: numbers line up on the right, ids are monospaced, long text gets room.
const traits = computed(() => {
  const out = {}
  for (const row of (data.value?.rows ?? []).slice(0, SAMPLE)) {
    for (const [f, v] of Object.entries(row)) {
      const t = (out[f] ??= { number: true, long: false })
      if (typeof v !== 'number') t.number = false
      if (typeof v === 'string' && v.length > 80) t.long = true
    }
  }
  return out
})
const cellClass = (field) => ({
  nowrap: field === 'time',
  num: field !== 'time' && traits.value[field]?.number === true,
  mono: /(^|[._-])id$/i.test(field),
  wide: traits.value[field]?.long === true,
})

// ---- lifecycle ------------------------------------------------------------------------------
function closeColumnsOutside(e) {
  if (columnsEl.value?.open && !columnsEl.value.contains(e.target)) columnsEl.value.open = false
}
function closeColumnsOnEscape(e) {
  if (e.key === 'Escape' && columnsEl.value?.open) {
    columnsEl.value.open = false
    columnsEl.value.querySelector('summary')?.focus()
  }
}

/** Reads the index and the rows of `id` (the index's own default when it has none). Throws, and changes nothing, if it cannot. */
async function fetchLogs(id) {
  const next = await fetchJson(indexUrl.value)
  if (!Array.isArray(next.events)) throw new Error('the data file is out of date; run npm run data and reload')
  const wanted = next.events.some((e) => e.id === id) ? id : next.default
  const file = wanted ? await fetchJson(eventUrl(wanted)) : null
  return { next, wanted: wanted ?? '', file }
}

/** Show another kind of event: a fresh search and the columns that kind starts with. A failed read keeps what was on screen. */
async function chooseEvent(id) {
  try {
    data.value = await fetchJson(eventUrl(id))
  } catch (err) {
    choiceError.value = `Could not load ${eventUrl(id)} (${String(err.message ?? err)}). Press Refresh in the bar above.`
    return
  }
  choiceError.value = ''
  eventId.value = id
  query.value = ''
  expanded.value = new Set()
  pager.value = { page: 1, loaded: INITIAL_PAGES }
  resetColumns()
}

let unregister = () => {}
onMounted(async () => {
  document.addEventListener('click', closeColumnsOutside)
  document.addEventListener('keydown', closeColumnsOnEscape)
  unregister = scope.register(reload) // whether or not the first load works, so Refresh can recover it
  try {
    const { next, wanted, file } = await fetchLogs(saved?.eventId ?? '')
    index.value = next
    eventId.value = wanted
    data.value = file
    if (saved && wanted === saved.eventId) {
      // the kind it was left on is still there: the columns that are still in it, and the page (never past the last)
      const kept = saved.columns.filter((c) => file.fields.includes(c))
      if (kept.length || !saved.columns.length) columns.value = kept
      else resetColumns()
      pager.value = { ...pager.value, page: Math.min(pager.value.page, Math.max(1, pageCount.value)) }
    } else {
      query.value = '' // a kind that is gone, or a first visit: a fresh search and this kind's own default columns
      pager.value = { page: 1, loaded: INITIAL_PAGES }
      resetColumns()
    }
    status.value = 'ready'
  } catch (err) {
    errorMessage.value = String(err.message ?? err)
    status.value = 'error'
  }
})

/**
 * Refresh (the navbar button, see lib/scope.js): swap in newly read rows and keep the view: the kind, the search, the chosen
 * columns and the page stay. Newer rows push the older ones down, so expanded cells (remembered by position) are closed. A kind
 * that is no longer in the logs falls back to the default. If the read fails this throws before anything changes.
 */
async function reload() {
  const { next, wanted, file } = await fetchLogs(eventId.value)
  const sameKind = wanted === eventId.value
  index.value = next
  eventId.value = wanted
  data.value = file
  status.value = 'ready' // also recovers a page whose first load failed
  choiceError.value = ''
  expanded.value = new Set()
  if (sameKind) {
    pager.value = { ...pager.value, page: Math.min(pager.value.page, Math.max(1, pageCount.value)) } // stay put; never reveal more pages
  } else {
    query.value = ''
    pager.value = { page: 1, loaded: INITIAL_PAGES }
    resetColumns()
  }
}
onBeforeUnmount(() => {
  // Only rows that were shown are worth coming back to; a view that never loaded must not replace what was saved before it.
  if (status.value === 'ready' && data.value) {
    scope.remember(props.source, 'logs', { eventId: eventId.value, query: query.value, columns: [...columns.value], pager: { ...pager.value } })
  }
  unregister()
  document.removeEventListener('click', closeColumnsOutside)
  document.removeEventListener('keydown', closeColumnsOnEscape)
})

const generatedAt = computed(() => (index.value ? formatDateTime(Date.parse(index.value.generatedAt) / 1000) : ''))
</script>

<template>
  <div class="viz-root" data-view="logs">
    <p class="viz-sub">
      The log events and spans {{ label }} exported<template v-if="index"> · read from <code>{{ index.source }}</code> (updated {{ generatedAt }})</template>.
    </p>

    <div class="viz-controls">
      <label v-if="events.length" class="viz-field viz-event">
        Event
        <select v-model="eventChoice">
          <template v-if="kinds.length > 1">
            <optgroup v-for="g in kinds" :key="g.key" :label="g.title">
              <option v-for="e in g.events" :key="e.id" :value="e.id">{{ e.name }} ({{ e.count }})</option>
            </optgroup>
          </template>
          <template v-else>
            <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }} ({{ e.count }})</option>
          </template>
        </select>
      </label>

      <div class="viz-field viz-search">
        <label for="log-search">Search</label>
        <input id="log-search" v-model="query" type="search" autocomplete="off" :placeholder="searchHint" :disabled="status !== 'ready' || !data" />
      </div>

      <details ref="columnsEl" class="viz-columns">
        <summary aria-label="Choose columns">Columns ({{ columns.length }})</summary>
        <div class="viz-menu">
          <input v-model="columnFilter" type="search" autocomplete="off" aria-label="Filter columns" placeholder="Filter fields" />
          <div class="viz-menu-list">
            <label v-for="f in columnChoices" :key="f">
              <input type="checkbox" :checked="columns.includes(f)" @change="toggleColumn(f)" />
              {{ columnLabel(f) }}
            </label>
            <span v-if="columnChoices.length === 0" class="viz-none">No field matches.</span>
          </div>
          <div class="viz-menu-foot">
            <span>{{ columns.length }} of {{ data?.fields.length ?? 0 }} shown</span>
            <button type="button" class="viz-btn" @click="resetColumns">Reset</button>
          </div>
        </div>
      </details>
    </div>

    <p v-if="choiceError" class="viz-hint is-error" role="alert">{{ choiceError }}</p>

    <div v-if="status === 'ready' && data" class="viz-table-wrap" style="max-height: none">
      <table class="viz-table">
        <caption class="viz-hint" style="text-align: left; caption-side: top; padding: 8px 12px 0">
          {{ noun === 'span' ? 'Spans' : 'Events' }}, newest first
        </caption>
        <thead>
          <tr>
            <th v-for="f in orderedColumns" :key="f" scope="col">{{ columnLabel(f) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in shown" :key="row._i">
            <td v-for="f in orderedColumns" :key="f" :class="cellClass(f)">
              <button v-if="isLong(row[f])" type="button" class="cell-toggle" :aria-expanded="isOpen(row, f)" @click="toggleCell(row, f)">
                <span class="cell-text" :class="{ 'is-clamped': !isOpen(row, f) }">{{ row[f] }}</span>
                <span class="cell-more">{{ isOpen(row, f) ? 'Show less' : 'Show more' }}</span>
              </button>
              <template v-else-if="f === 'time'">{{ formatDateTime(row.time) }}</template>
              <template v-else>{{ display(row[f]) }}</template>
            </td>
          </tr>
          <tr v-if="shown.length === 0">
            <td class="empty" :colspan="Math.max(1, orderedColumns.length)">
              {{ query ? `No ${noun}s match “${query}”.` : `No ${noun}s in the logs yet.` }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="viz-card" style="min-height: 160px">
      <div v-if="status === 'loading'" class="viz-message">Loading…</div>
      <div v-else-if="status === 'ready'" class="viz-message">No log events or spans in the logs yet.</div>
      <div v-else class="viz-message is-error">
        <span>Could not load <code>{{ indexUrl }}</code> ({{ errorMessage }}). Start the site with <code>npm run dev</code> so the data is generated first, or press Refresh in the bar above.</span>
      </div>
    </div>

    <template v-if="status === 'ready' && data">
      <nav class="viz-pager" aria-label="Pagination">
        <button type="button" class="viz-btn" :disabled="pager.page <= 1" @click="go(pager.page - 1)">Previous</button>
        <button
          v-for="p in pages"
          :key="p"
          type="button"
          class="viz-btn"
          :aria-current="p === pager.page ? 'page' : undefined"
          :aria-label="`Page ${p}`"
          @click="go(p)"
        >
          {{ p }}
        </button>
        <button type="button" class="viz-btn" :disabled="pager.page >= pageCount" @click="go(pager.page + 1)">Next</button>
      </nav>
      <p class="viz-status" aria-live="polite">
        <template v-if="matches.length">Showing {{ firstShown }}–{{ lastShown }} of {{ matches.length }} {{ noun }}{{ matches.length === 1 ? '' : 's' }}</template>
        <template v-else>0 {{ noun }}s</template>
        <template v-if="moreToLoad"> · click page {{ pages[pages.length - 1] }} to load more pages</template>
      </p>
    </template>
  </div>
</template>
