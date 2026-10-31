import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import { defaultLogDir } from '../../scripts/prepare-data.mjs'
import { refreshDataPlugin } from './plugins/refreshData.js'

export default defineConfig({
  title: 'otelscope',
  description: 'Explore the OpenTelemetry logs of your AI coding tools, one tab per tool',
  appearance: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    // The data holds prompts and account details: keep it out of search engines if it is ever hosted.
    ['meta', { name: 'robots', content: 'noindex, nofollow' }],
  ],
  themeConfig: {
    // "otel" in bold (the navbar's title is HTML); the weights are set in theme/viz.css.
    siteTitle: '<b>otel</b>scope',
    logo: { src: '/logo.svg', alt: '' }, // left of the title; the name next to it already says what it is
    outline: false,
  },
  vite: {
    // Prompts are sensitive: serve on localhost only. (`vitepress preview` has no host option and binds every
    // interface, so there is no preview script.) This setting wins over a --host flag, so the Docker image changes it
    // with SITE_HOST=0.0.0.0, which is safe only because the README publishes the port on 127.0.0.1.
    server: { host: process.env.SITE_HOST || '127.0.0.1' }, // `||`, so an empty value also stays on localhost
    // The "Refresh data" button: the dev server re-reads the logs (same folder as `npm run data`) and rewrites the data files.
    plugins: [refreshDataPlugin({ dir: defaultLogDir(), out: fileURLToPath(new URL('../public/data', import.meta.url)) })],
    // Pre-bundle the lazily imported chart modules so the first visit to Usage does not trigger a reload.
    optimizeDeps: { include: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'] },
    build: { chunkSizeWarningLimit: 1500 }, // echarts is large
  },
})
