// Plain functions behind the "Refresh data" button (no Vue, so node --test can run them).

// What a server says when it has nothing to regenerate with (a static build, `python -m http.server`, ...).
const NO_REGENERATION = new Set([404, 405, 501])

/**
 * Ask the dev server to re-read the logs. Resolves { regenerated: true, generatedAt } when it did, and
 * { regenerated: false } when this server cannot: the caller then just re-fetches the data files. Anything else
 * (the log folder is gone, the server is down) rejects with a message fit to show.
 */
export async function requestRefresh(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'X-Requested-With': 'otelscope' }, cache: 'no-store' })
  if (res.ok) {
    const body = await res.json().catch(() => ({}))
    return { regenerated: true, generatedAt: body.generatedAt }
  }
  if (NO_REGENERATION.has(res.status)) return { regenerated: false }
  const body = await res.json().catch(() => ({}))
  throw new Error(typeof body.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`.trim())
}

/**
 * Where the zoom window goes when the data grows. Viewing everything keeps viewing everything; a window that was
 * pinned to the newest data slides forward with it, keeping its width; any other window stays where it was.
 */
export function followRange(range, oldAxis, axis, tolerance = 1000) {
  const clamp = (ms) => Math.min(axis.maxMs, Math.max(axis.minMs, ms))
  const atEnd = range.endMs >= oldAxis.maxMs - tolerance
  if (atEnd && range.startMs <= oldAxis.minMs + tolerance) return { startMs: axis.minMs, endMs: axis.maxMs }
  if (atEnd) return { startMs: clamp(axis.maxMs - (range.endMs - range.startMs)), endMs: axis.maxMs }
  return { startMs: clamp(range.startMs), endMs: clamp(range.endMs) }
}
