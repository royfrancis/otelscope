import { buildDatasets, describeDatasets, writeDatasets } from '../../../scripts/prepare-data.mjs'

// The "Refresh data" button posts here. The dev server re-reads the logs and rewrites usage.json and prompts.json,
// so new activity shows up without restarting anything. A static build has no such endpoint; the button copes.
export const REFRESH_PATH = '/api/refresh'
export const REFRESH_HEADER = 'x-requested-with'
export const REFRESH_HEADER_VALUE = 'otelscope'

/**
 * Connect-style handler. POST only, and only with the custom header: a page on another site cannot send that header
 * without a CORS preflight, which this server never answers, so it cannot trigger a refresh. One regeneration runs at a
 * time; requests that arrive meanwhile share its result.
 */
export function createRefreshHandler({ dir, out, build = buildDatasets, write = writeDatasets }) {
  let running = null
  const run = () => {
    if (!running) {
      running = Promise.resolve()
        .then(() => build(dir))
        .then((datasets) => {
          write(out, datasets)
          return { generatedAt: datasets.generatedAt, summary: describeDatasets(datasets).join(' | ') }
        })
        .finally(() => {
          running = null
        })
    }
    return running
  }

  const send = (res, status, body, headers = {}) => {
    res.statusCode = status
    res.setHeader('Cache-Control', 'no-store')
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
    if (body === undefined) return res.end()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  return async function refresh(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' })
    if (req.headers[REFRESH_HEADER] !== REFRESH_HEADER_VALUE) return send(res, 403, { error: 'missing request header' })
    try {
      send(res, 200, await run())
    } catch (err) {
      // Say what went wrong in words that cannot leak log content: the folder problem, or a generic line.
      const message = String(err?.message ?? '')
      send(res, 500, { error: message.startsWith('Log directory not found') ? message.split('\n')[0] : 'could not regenerate the data' })
    }
  }
}

export function refreshDataPlugin(options) {
  return {
    name: 'otelscope:refresh-data',
    configureServer(server) {
      server.middlewares.use(REFRESH_PATH, createRefreshHandler(options))
    },
  }
}
