<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { useScope } from '../lib/scope.js'
import LogExplorer from './LogExplorer.vue'
import UsageChart from './UsageChart.vue'

// One tab for every folder of the log root. The view inside it (Usage, Logs) is chosen in the navbar (NavActions.vue) and stays
// as it is when another tool's tab is picked,
// and the tab list is /data/sources.json, so a new folder shows up after Refresh without a code change.
const scope = useScope()
const { status, errorMessage, sources, tool, view, current } = scope

let stop = () => {}
onMounted(async () => {
  stop = await scope.start()
})
onBeforeUnmount(() => stop())
</script>

<template>
  <div class="otelscope">
    <div v-if="status === 'loading'" class="viz-root"><p class="viz-sub">Loading…</p></div>

    <div v-else-if="status === 'error' || sources.length === 0" class="viz-root">
      <h1>otelscope</h1>
      <p class="viz-sub">
        <template v-if="status === 'error'">Could not load <code>/data/sources.json</code> ({{ errorMessage }}). Start the site with <code>npm run dev</code> so the data is generated first, or press Refresh in the bar above.</template>
        <template v-else>There is no folder for any tool in the log folder yet. Once a tool has sent something, press Refresh in the bar above.</template>
      </p>
    </div>

    <template v-else>
      <div class="viz-root viz-tabbar">
        <div class="viz-tabs" role="tablist" aria-label="Tools">
          <button v-for="s in sources" :key="s.id" type="button" role="tab" class="viz-tab" :aria-selected="s.id === tool" @click="scope.choose(s.id, view)">
            {{ s.label }}
          </button>
        </div>
      </div>

      <div v-if="current?.error" class="viz-root">
        <h1>{{ current.label }}</h1>
        <p class="viz-sub">This folder could not be read: {{ current.error }}</p>
      </div>
      <UsageChart v-else-if="view === 'usage'" :key="`${tool}/usage`" :source="tool" :label="current.label" />
      <LogExplorer v-else-if="view === 'logs'" :key="`${tool}/logs`" :source="tool" :label="current.label" />
    </template>
  </div>
</template>
