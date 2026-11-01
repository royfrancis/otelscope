import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VERSION } from '../docs/.vitepress/lib/version.js'

test('the version in the navbar is the newest one in the changelog', () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const newest = changelog.match(/^## (\d+\.\d+\.\d+)\s*$/m)?.[1]
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal(newest, VERSION, `docs/.vitepress/lib/version.js says ${VERSION} but the top of CHANGELOG.md is ${newest}: update both together`)
})
