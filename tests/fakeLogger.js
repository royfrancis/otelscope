// A stand-in for the logger's `cat` command, for the tests of the data step. The data step reads a folder's <signal>.pblog by
// running `python3 otel-logger.py cat FILE` (scripts/data/read.mjs); here that runs a script that prints FILE's sidecar ".txt"
// and exits with $FAKE_EXIT. So these tests need neither python nor the protobuf libraries.
// (The real thing is exercised end to end in tests/test_logger.py.)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const FAKE = `import { readFileSync } from 'node:fs'
const file = process.argv[3]
process.stdout.write(readFileSync(file + '.txt', 'utf8'))
if (process.env.FAKE_EXIT) { console.error('boom: the protobuf libraries are missing'); process.exit(Number(process.env.FAKE_EXIT)) }
`

/** Runs `run(dir)` in a new folder, with the data step pointed at the fake `cat`. The folder is removed afterward. */
export async function withFakeLogger(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'otel-pblog-'))
  const saved = { py: process.env.OTEL_LOGGER_PYTHON, script: process.env.OTEL_LOGGER_SCRIPT, exit: process.env.FAKE_EXIT }
  try {
    writeFileSync(path.join(dir, 'fake.mjs'), FAKE)
    process.env.OTEL_LOGGER_PYTHON = process.execPath
    process.env.OTEL_LOGGER_SCRIPT = path.join(dir, 'fake.mjs')
    delete process.env.FAKE_EXIT
    return await run(dir)
  } finally {
    for (const [key, name] of [['py', 'OTEL_LOGGER_PYTHON'], ['script', 'OTEL_LOGGER_SCRIPT'], ['exit', 'FAKE_EXIT']]) {
      if (saved[key] === undefined) delete process.env[name]
      else process.env[name] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Puts log files in a folder (name -> the JSON lines `cat` prints for it): each is a placeholder .pblog and its sidecar .txt. */
export function writeFolder(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), 'binary')
    writeFileSync(path.join(dir, `${name}.txt`), text)
  }
}
