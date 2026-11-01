<script setup>
import { computed } from 'vue'
import { VIEW_LABELS } from '../lib/tabs.js'
import { useScope } from '../lib/scope.js'
import { VERSION } from '../lib/version.js'
import Icon from './Icon.vue'

// The navbar: the version, then Usage, Logs and Refresh (each an icon and a word), in that order from the left.
// Usage and Logs choose the view of the tool that is showing; Refresh re-reads every tool's logs (see lib/scope.js).
const scope = useScope()

const ready = computed(() => scope.status.value === 'ready')
// Before the tab list has loaded (or when it could not) the two usual views are shown, disabled, so the bar does not jump.
const shown = computed(() => (ready.value && scope.views.value.length ? scope.views.value : ['usage', 'logs']))
const available = (v) => ready.value && scope.views.value.includes(v)
const choose = (v) => scope.choose(scope.tool.value, v)
</script>

<template>
  <div class="otel-nav">
    <span class="otel-nav-version" title="otelscope version">v{{ VERSION }}</span>
    <nav class="otel-nav-group" aria-label="Views">
      <button
        v-for="v in shown"
        :key="v"
        type="button"
        class="otel-nav-btn"
        :class="`is-${v}`"
        :disabled="!available(v)"
        :aria-current="available(v) && scope.view.value === v ? 'page' : undefined"
        @click="choose(v)"
      >
        <Icon :name="v" />
        <span class="otel-nav-label">{{ VIEW_LABELS[v] }}</span>
      </button>
    </nav>
    <button
      type="button"
      class="otel-nav-btn is-refresh"
      title="Re-read the logs of every tool"
      :disabled="scope.refreshing.value"
      :aria-busy="scope.refreshing.value"
      @click="scope.refresh()"
    >
      <Icon name="refresh" :class="{ 'is-spinning': scope.refreshing.value }" />
      <span class="otel-nav-label">Refresh</span>
    </button>

    <div v-if="scope.note.value" class="otel-toast" :class="{ 'is-error': scope.failed.value }" :role="scope.failed.value ? 'alert' : 'status'">
      <span>{{ scope.note.value }}</span>
      <button type="button" class="otel-toast-close" aria-label="Dismiss" @click="scope.dismiss()"><Icon name="close" :size="14" /></button>
    </div>
  </div>
</template>
