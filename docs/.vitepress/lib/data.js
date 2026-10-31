import { withBase } from 'vitepress'

/** Reads one of the generated data files. Rejects with a message fit to show when it cannot, and never reads from the cache. */
export async function fetchJson(path) {
  const res = await fetch(withBase(path), { cache: 'no-store' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}
