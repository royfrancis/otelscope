import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_SIZE, INITIAL_PAGES, PAGES_PER_LOAD, searchRows, totalPages, visiblePages, goToPage, pageRows,
} from '../docs/.vitepress/lib/logs.js'

const rows = [
  { time: 3, 'session.id': 'aaaa-1111', prompt: 'Fix the Pixi environment' },
  { time: 2, 'session.id': 'bbbb-2222', prompt: 'write a README' },
  { time: 1, 'session.id': 'aaaa-1111', prompt: 'something else entirely' },
]

test('searchRows matches prompt text or session id, case-insensitively', () => {
  assert.equal(searchRows(rows, '').length, 3)
  assert.equal(searchRows(rows, '   ').length, 3)
  assert.deepEqual(searchRows(rows, 'pixi').map((r) => r.time), [3])
  assert.deepEqual(searchRows(rows, 'BBBB').map((r) => r.time), [2])
  assert.deepEqual(searchRows(rows, 'aaaa').map((r) => r.time), [3, 1])
})

test('searchRows requires every term to match', () => {
  assert.deepEqual(searchRows(rows, 'aaaa else').map((r) => r.time), [1])
  assert.equal(searchRows(rows, 'pixi readme').length, 0)
})

test('totalPages is at least 1', () => {
  assert.equal(totalPages(0), 1)
  assert.equal(totalPages(PAGE_SIZE), 1)
  assert.equal(totalPages(PAGE_SIZE + 1), 2)
  assert.equal(totalPages(179), 9)
})

test('only 5 page buttons are visible at first', () => {
  assert.deepEqual(visiblePages(9, INITIAL_PAGES), [1, 2, 3, 4, 5])
  assert.deepEqual(visiblePages(3, INITIAL_PAGES), [1, 2, 3])
})

test('clicking a page before the last visible one loads nothing', () => {
  assert.deepEqual(goToPage({ loaded: 5 }, 9, 3), { page: 3, loaded: 5 })
})

test('clicking the last visible page loads the next batch of pages', () => {
  const s = goToPage({ loaded: 5 }, 9, 5)
  assert.deepEqual(s, { page: 5, loaded: 5 + PAGES_PER_LOAD })
  assert.equal(visiblePages(9, s.loaded).length, 9) // pages 6..9 are now shown
})

test('Next from the last visible page also loads more and moves on', () => {
  assert.deepEqual(goToPage({ loaded: 5 }, 9, 6), { page: 6, loaded: 10 })
})

test('nothing more to load when every page is already visible, and pages are clamped', () => {
  assert.deepEqual(goToPage({ loaded: 5 }, 4, 4), { page: 4, loaded: 5 })
  assert.deepEqual(goToPage({ loaded: 5 }, 4, 99), { page: 4, loaded: 5 })
  assert.deepEqual(goToPage({ loaded: 5 }, 4, 0), { page: 1, loaded: 5 })
})

test('pageRows slices one page', () => {
  const many = Array.from({ length: 45 }, (_, i) => i)
  assert.equal(pageRows(many, 1).length, PAGE_SIZE)
  assert.deepEqual(pageRows(many, 3), [40, 41, 42, 43, 44])
})
