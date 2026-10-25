import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryStore, historyDigest, MAX_HISTORY } from '../history.js'

const run = (id, over = {}) => ({
  id, task: 'fix parser', mode: 'auto', escalation: 'none', status: 'reviewed_with_check',
  startedAt: 1000, endedAt: 2000, attempt: 1, summary: 'ok',
  phases: [{ role: 'direction', label: '定向', route: 'openai/gpt-6-sol', status: 'done', startedAt: 1000, endedAt: 1500, note: '', detail: 'goal text' }],
  ...over,
})

test('history keeps the newest runs, dedupes by id and survives a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-hist-'))
  try {
    const file = join(dir, 'history.json')
    const store = createHistoryStore(file)
    assert.deepEqual(store.list(), [])
    store.add(run('a'))
    store.add(run('b', { task: 'second' }))
    assert.deepEqual(store.list().map(r => r.id), ['b', 'a'])
    store.add(run('a', { task: 'first again' }))
    assert.deepEqual(store.list().map(r => r.id), ['a', 'b'], 're-adding moves the run to the front')
    assert.equal(store.get('b').task, 'second')
    const reloaded = createHistoryStore(file)
    assert.deepEqual(reloaded.list().map(r => r.id), ['a', 'b'])
    assert.equal(reloaded.get('a').phases[0].detail, 'goal text')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('history is bounded and rejects malformed entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-hist-'))
  try {
    const store = createHistoryStore(join(dir, 'h.json'), 3)
    for (const id of ['1', '2', '3', '4', '5']) store.add(run(id))
    assert.deepEqual(store.list().map(r => r.id), ['5', '4', '3'])
    assert.equal(store.add({ id: 7 }), false)
    assert.equal(store.size, 3)
    assert.equal(MAX_HISTORY, 50)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('clear empties the store and the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-hist-'))
  try {
    const file = join(dir, 'h.json')
    const store = createHistoryStore(file)
    store.add(run('x'))
    assert.equal(store.size, 1)
    store.clear()
    assert.equal(store.size, 0)
    assert.equal(createHistoryStore(file).size, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the panel digest drops long details but flags them', () => {
  const digest = historyDigest([run('a')])
  assert.equal(digest[0].phases[0].detail, undefined)
  assert.equal(digest[0].phases[0].hasDetail, true)
  assert.equal(digest[0].task, 'fix parser')
  const noDetail = historyDigest([run('b', { phases: [{ role: 'x', label: 'x', status: 'done', startedAt: 1, endedAt: 2, note: '', detail: '' }] })])
  assert.equal(noDetail[0].phases[0].hasDetail, false)
})
