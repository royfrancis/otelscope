import { h } from 'vue'
import { withBase } from 'vitepress'
import type { Theme } from 'vitepress'
// Without VitePress's own fonts (Inter, and a Google Fonts @import): the site brings Manrope and JetBrains Mono, from npm.
import DefaultTheme from 'vitepress/theme-without-fonts'
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'
import NavActions from '../components/NavActions.vue'
import { fetchJson } from '../lib/data.js'
import { requestRefresh } from '../lib/refresh.js'
import { SCOPE_KEY, createScope } from '../lib/scope.js'
import './viz.css'

export default {
  extends: DefaultTheme,
  // Usage, Logs and Refresh live in VitePress's own navbar, next to the title and the dark-mode switch.
  Layout: () => h(DefaultTheme.Layout, null, { 'nav-bar-content-before': () => h(NavActions) }),
  enhanceApp({ app }) {
    app.provide(
      SCOPE_KEY,
      createScope({
        fetchSources: async () => (await fetchJson('/data/sources.json')).sources,
        refresh: () => requestRefresh(withBase('/api/refresh')),
      }),
    )
  },
} satisfies Theme
