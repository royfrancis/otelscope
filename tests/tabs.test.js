import test from 'node:test'
import assert from 'node:assert/strict'
import { VIEW_LABELS, hashFor, parseHash, viewsOf } from '../docs/.vitepress/lib/tabs.js'

const sources = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'vscode', label: 'VS Code Copilot' },
  { id: 'opencode', label: 'OpenCode' }, // a tool this site has never heard of is no different
  { id: 'broken', label: 'Broken', error: 'could not read' },
]

test('every readable folder offers the same two views, whatever tool wrote it; an unreadable one offers nothing', () => {
  for (const s of sources.slice(0, 3)) assert.deepEqual(viewsOf(s), ['usage', 'logs'], s.id)
  assert.deepEqual(viewsOf(sources[3]), [])
  assert.deepEqual(Object.keys(VIEW_LABELS), ['usage', 'logs'])
})

test('the address names a tab and a view', () => {
  assert.equal(hashFor('vscode', 'logs'), '#vscode/logs')
  assert.deepEqual(parseHash('#vscode/logs', sources), { tool: 'vscode', view: 'logs' })
  assert.deepEqual(parseHash('#opencode/usage', sources), { tool: 'opencode', view: 'usage' })
})

test('anything the address gets wrong falls back to something that exists', () => {
  assert.deepEqual(parseHash('', sources), { tool: 'claude', view: 'usage' }) // first tab, its first view
  assert.deepEqual(parseHash(undefined, sources), { tool: 'claude', view: 'usage' })
  assert.deepEqual(parseHash('#nope/logs', sources), { tool: 'claude', view: 'usage' }) // unknown tab
  assert.deepEqual(parseHash('#vscode/nonsense', sources), { tool: 'vscode', view: 'usage' }) // unknown view
  assert.deepEqual(parseHash('#opencode/summary', sources), { tool: 'opencode', view: 'usage' }) // the old Summary view is gone
  assert.deepEqual(parseHash('#broken/usage', sources), { tool: 'broken', view: '' }) // an unreadable folder has no view
  assert.deepEqual(parseHash('#claude/logs', []), { tool: '', view: '' }) // no folders at all
})
