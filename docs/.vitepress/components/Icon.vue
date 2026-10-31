<script setup>
import { computed } from 'vue'
import { ICONS } from '../lib/icons.js'

// A decorative icon: the button it sits in carries the text, so it is hidden from screen readers.
const props = defineProps({ name: { type: String, required: true }, size: { type: Number, default: 16 } })
const paths = computed(() => ICONS[props.name] ?? [])
</script>

<template>
  <svg class="otel-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="d in paths" :key="d" :d="d" />
  </svg>
</template>
