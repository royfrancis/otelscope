// Pure logic for the log explorer: search and the windowed pager.

export const PAGE_SIZE = 20
export const INITIAL_PAGES = 5 // page buttons shown up front
export const PAGES_PER_LOAD = 5 // extra page buttons revealed each time the last one is clicked

/**
 * Every whitespace-separated term must appear (case-insensitive) in one of the searched fields, which the data file names
 * for each kind of row. With none named, every field of the row is searched.
 */
export function searchRows(rows, query, fields = []) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return rows
  return rows.filter((r) => {
    const names = fields.length ? fields : Object.keys(r).filter((k) => k !== '_i')
    const haystack = names.map((f) => r[f] ?? '').join('\n').toLowerCase()
    return terms.every((t) => haystack.includes(t))
  })
}

export const totalPages = (n, pageSize = PAGE_SIZE) => Math.max(1, Math.ceil(n / pageSize))

/** Page numbers currently shown as buttons. */
export function visiblePages(total, loaded) {
  return Array.from({ length: Math.min(total, loaded) }, (_, i) => i + 1)
}

/**
 * Go to `target`. Reaching the last visible page while more exist reveals the next batch of pages,
 * which is also what "Next" does from the last visible page.
 */
export function goToPage({ loaded }, total, target) {
  const page = Math.min(total, Math.max(1, target))
  const visible = Math.min(total, loaded)
  const more = page >= visible && visible < total
  return { page, loaded: more ? loaded + PAGES_PER_LOAD : loaded }
}

export const pageRows = (rows, page, pageSize = PAGE_SIZE) => rows.slice((page - 1) * pageSize, page * pageSize)
