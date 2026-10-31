// Reads the OTEL logs written by otel-logger.py and writes the compact JSON the site loads, one set per folder of the
// log root (one tab each on the site), for ANY tool: nothing here knows a tool's metric or event names.
//   <out>/sources.json              the folders found, in tab order
//   <out>/<folder>/usage.json       every metric that can be added up (the Y-axis choices) and every attribute (the color choices)
//   <out>/<folder>/logs.json        the kinds of log event and span the folder holds, and which one to open on
//   <out>/<folder>/logs/<id>.json   the rows of one kind (loaded when it is chosen)
// Runs on every `npm run dev` / `npm run build`, and on Refresh in the site.
//
// Usage: node scripts/prepare-data.mjs [--dir <log root>] [--out <output dir>]
// The log root is $OTEL_LOGGER_DIR (the logger's own setting), else ~/otelscope. Each folder may hold the logger's
// .pblog files or the old .jsonl files (.pblog wins when both are there).
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { attributeKeys, buildLogs, readEvents } from './data/events.mjs'
import { buildUsage, pickSessionKey, readPoints } from './data/metrics.mjs'

const SNIPPET_CHARS = 90

const snippet = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET_CHARS ? flat.slice(0, SNIPPET_CHARS - 1) + '…' : flat
}

const displayPath = (dir) => (dir.startsWith(homedir()) ? '~' + dir.slice(homedir().length) : dir)

/** The first prompt of each session, where the tool's log events carry one (a `prompt` attribute): the session search matches it. */
function addFirstPrompts(usage, groups) {
  if (!usage.sessionField) return
  const earliest = new Map() // session id -> { time, prompt }
  for (const { kind, rows } of groups.values()) {
    if (kind !== 'log') continue
    for (const row of rows) {
      const id = row[usage.sessionField]
      if (typeof row.prompt !== 'string' || id == null) continue
      const had = earliest.get(id)
      if (!had || row.time < had.time) earliest.set(id, { time: row.time, prompt: row.prompt })
    }
  }
  for (const session of usage.sessions) session.first = snippet(earliest.get(session.id)?.prompt)
}

/**
 * One folder, whatever tool wrote it: { usage, logs: { index, files } }. The three signals are read at the same time.
 * A folder with no metrics still gets its Logs, and a folder with no logs or spans still gets its Usage.
 */
export async function buildSource(dir) {
  const [points, { groups, resourceKeys }] = await Promise.all([readPoints(dir), readEvents(dir)])
  const generatedAt = new Date().toISOString()
  const source = displayPath(dir)
  const usage = buildUsage(points)
  addFirstPrompts(usage, groups)
  // the session is found from the metrics; a tool whose metrics carry none may still name it in its log events
  const sessionField = usage.sessionField ?? pickSessionKey(attributeKeys(groups))
  const logs = buildLogs(groups, sessionField, resourceKeys)
  return {
    usage: { generatedAt, source, ...usage },
    logs: { index: { generatedAt, source, ...logs.index }, files: logs.files },
  }
}

// The names tabs are given. A folder not listed here still gets a tab, called after its folder.
const LABELS = {
  claude: 'Claude Code',
  vscode: 'VS Code Copilot',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  opencode: 'OpenCode',
  other: 'Other',
}
const TAB_ORDER = Object.keys(LABELS)

/** The folders of the log root that get a tab: the usual ones first, in order, then any other, by name. */
export function listSources(root) {
  const found = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[A-Za-z0-9_-]+$/.test(e.name)) // the name becomes part of a URL
    .map((e) => e.name)
  const known = TAB_ORDER.filter((id) => found.includes(id))
  const others = found.filter((name) => !TAB_ORDER.includes(name)).sort()
  return [...known, ...others].map((id) => ({ id, label: LABELS[id] ?? id[0].toUpperCase() + id.slice(1) }))
}

/** Everything the site shows: one entry per folder. A folder that cannot be read is reported on its own tab. */
export async function buildDatasets(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Log directory not found: ${root}\nSet OTEL_LOGGER_DIR or pass --dir <path> (default: ~/otelscope).`)
  }
  const sources = []
  for (const source of listSources(root)) {
    try {
      sources.push({ ...source, ...(await buildSource(path.join(root, source.id))) })
    } catch (err) {
      sources.push({ ...source, error: String(err.message ?? err).split('\n')[0] })
    }
  }
  return { generatedAt: new Date().toISOString(), source: displayPath(root), sources }
}

/** The log root when none is given: $OTEL_LOGGER_DIR (the logger's own setting), then ~/otelscope. */
export const defaultLogDir = (env = process.env) => path.resolve(env.OTEL_LOGGER_DIR || path.join(homedir(), 'otelscope'))

/**
 * Writes sources.json and each folder's files. Every file is written beside its final name and renamed into place, so
 * a page that fetches one while the data is being regenerated never reads half a file; sources.json goes last, so a
 * folder is never listed before its files exist. Returns a "name size" note per file.
 */
export function writeDatasets(out, { generatedAt, source, sources }) {
  const notes = []
  const write = (rel, data) => {
    const file = path.join(out, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    const partial = `${file}.tmp`
    writeFileSync(partial, JSON.stringify(data))
    renameSync(partial, file)
    notes.push(`${rel} ${(statSync(file).size / 1024).toFixed(0)} KB`)
  }
  for (const s of sources) {
    if (!s.usage) continue
    for (const f of s.logs.files) write(`${s.id}/logs/${f.id}.json`, f.data) // the rows first, then the index that names them
    write(`${s.id}/usage.json`, s.usage)
    write(`${s.id}/logs.json`, s.logs.index)
  }
  write('sources.json', { generatedAt, source, sources: sources.map(({ id, label, error }) => ({ id, label, ...(error ? { error } : {}) })) })
  return notes
}

/** One line per folder, for the console and the refresh reply. */
export function describeDatasets({ sources }) {
  const range = (extent) => (extent ? extent.map((t) => new Date(t * 1000).toISOString().slice(0, 16) + 'Z').join(' → ') : 'no metrics')
  return sources.map((s) => {
    if (s.error) return `${s.id}: could not be read (${s.error})`
    const points = s.usage.measures.reduce((a, m) => a + m.rows.length, 0)
    const rows = s.logs.index.events.reduce((a, e) => a + e.count, 0)
    return `${s.id}: ${s.usage.measures.length} measures (${points} datapoints, ${s.usage.sessions.length} sessions), ${s.logs.index.events.length} kinds of log event or span (${rows} rows) (${range(s.usage.extent)})`
  })
}

const argValue = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = argValue('--dir') ? path.resolve(argValue('--dir')) : defaultLogDir()
  const out = path.resolve(argValue('--out') ?? path.join(root, 'docs', 'public', 'data'))

  const datasets = await buildDatasets(dir)
  const notes = writeDatasets(out, datasets)
  console.log(`[data] ${dir}`)
  for (const line of describeDatasets(datasets)) console.log(`[data] ${line}`)
  const kb = notes.reduce((a, n) => a + Number(n.split(' ').at(-2)), 0)
  console.log(`[data] wrote ${notes.length} files (${(kb / 1024).toFixed(1)} MB) -> ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[data] ${err.message}`)
    process.exit(1)
  })
}
