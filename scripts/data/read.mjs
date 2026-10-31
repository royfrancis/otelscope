// Reading the logger's files: the records of one signal of one folder, and OTLP values as plain JavaScript.
import { createReadStream, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'

async function* readJsonl(file, mustInclude) {
  if (!existsSync(file)) return
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line || (mustInclude && !line.includes(mustInclude))) continue
    try {
      yield JSON.parse(line)
    } catch {
      // The logger appends live, so the last line can be half-written. Skip it.
    }
  }
}

// The logger writes protobuf (.pblog). Its own `cat` command prints those records as JSON lines ({"received_at", "data"}),
// so it is run here rather than decoding protobuf a second time in JavaScript. It needs python3 with the protobuf
// libraries (the Docker image has both). Where to find them can be set with OTEL_LOGGER_PYTHON and OTEL_LOGGER_SCRIPT;
// the script defaults to otel-logger.py in the folder the site is started from.
async function* readPblog(file, mustInclude) {
  const python = process.env.OTEL_LOGGER_PYTHON ?? 'python3'
  const script = process.env.OTEL_LOGGER_SCRIPT ?? path.resolve('otel-logger.py')
  const child = spawn(python, [script, 'cat', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk })
  const closed = new Promise((resolve) => {
    child.on('error', (err) => resolve({ error: err }))
    child.on('close', (code) => resolve({ code }))
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line || (mustInclude && !line.includes(mustInclude))) continue
    try {
      yield JSON.parse(line)
    } catch {
      // skip a line that is not a record
    }
  }
  const { code, error } = await closed
  if (error || code !== 0) {
    const why = error ? `${python} could not be started (${error.code ?? error.message})` : (stderr.trim().split('\n').pop() || `exit status ${code}`)
    throw new Error(`Could not read ${path.basename(file)} with ${path.basename(script)} cat: ${why}. Reading .pblog files needs python3 with the protobuf libraries (pip install -r requirements.txt).`)
  }
}

/** The records of one signal (metrics, logs, traces): from <signal>.pblog if there is one, else from the old <signal>.jsonl. */
export async function* readRecords(dir, signal, mustInclude) {
  const pblog = path.join(dir, `${signal}.pblog`)
  if (existsSync(pblog)) yield* readPblog(pblog, mustInclude)
  else yield* readJsonl(path.join(dir, `${signal}.jsonl`), mustInclude)
}

export function otlpValue(v) {
  if (v == null) return null
  if ('stringValue' in v) return v.stringValue
  if ('intValue' in v) return Number(v.intValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('boolValue' in v) return v.boolValue
  if ('arrayValue' in v) return JSON.stringify((v.arrayValue.values ?? []).map(otlpValue))
  if ('kvlistValue' in v) return JSON.stringify(attrsToObject(v.kvlistValue.values))
  return null
}

export function attrsToObject(list = []) {
  return Object.fromEntries(list.map((a) => [a.key, otlpValue(a.value)]))
}

export const toSeconds = (nano) => Math.round(Number(nano) / 1e9)
