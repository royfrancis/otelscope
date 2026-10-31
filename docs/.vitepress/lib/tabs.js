// Pure logic for the tab bar: which views a folder offers, and how the address (#claude/logs) maps to a choice.

export const VIEW_LABELS = { usage: 'Usage', logs: 'Logs' }

/** What a folder's tab can show: the same two views for every tool (what is in them comes from the data), or nothing if it could not be read. */
export const viewsOf = (source) => (source.error ? [] : ['usage', 'logs'])

export const hashFor = (tool, view) => `#${tool}/${view}`

/** The tab and view an address asks for; anything unknown falls back to the first tab and its first view. */
export function parseHash(hash, sources) {
  const [wantedTool, wantedView] = String(hash ?? '').replace(/^#/, '').split('/')
  const found = sources.find((s) => s.id === wantedTool)
  const tool = found ?? sources[0]
  if (!tool) return { tool: '', view: '' }
  const views = viewsOf(tool)
  // an address naming a tab that does not exist is wrong as a whole, so its view is not kept either
  return { tool: tool.id, view: found && views.includes(wantedView) ? wantedView : (views[0] ?? '') }
}
