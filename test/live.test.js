import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLiveBuffer, describeArgs, liveSnapshot, reduceLive, resetLive } from '../live.js'

test('reasoning deltas become a thinking snapshot', () => {
  const buf = createLiveBuffer()
  assert.equal(liveSnapshot(buf), undefined)
  assert.equal(reduceLive(buf, { type: 'reasoning-delta', index: 0, text: '先读 ' }), true)
  reduceLive(buf, { type: 'reasoning-delta', index: 0, text: '文件' })
  const snap = liveSnapshot(buf)
  assert.equal(snap.kind, 'thinking')
  assert.equal(snap.text, '先读 文件')
  assert.equal(snap.tool, '')
})

test('text deltas switch the snapshot to the reply', () => {
  const buf = createLiveBuffer()
  reduceLive(buf, { type: 'reasoning-delta', index: 0, text: '想好了' })
  reduceLive(buf, { type: 'text-delta', index: 1, text: '结论是' })
  const snap = liveSnapshot(buf)
  assert.equal(snap.kind, 'reply')
  assert.equal(snap.text, '结论是')
})

test('tool call deltas expose the tool name and its argument', () => {
  const buf = createLiveBuffer()
  reduceLive(buf, { type: 'tool-call-delta', index: 2, id: 'c1', name: 'ops_bash', argumentsDelta: '{"command":"npm ' })
  reduceLive(buf, { type: 'tool-call-delta', index: 2, id: 'c1', argumentsDelta: 'test","description":"x"}' })
  const snap = liveSnapshot(buf)
  assert.equal(snap.kind, 'tool')
  assert.equal(snap.tool, 'ops_bash')
  assert.equal(snap.text, 'npm test')
})

test('block-end keeps the final tool arguments', () => {
  const buf = createLiveBuffer()
  reduceLive(buf, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a/b.js"}' } })
  const snap = liveSnapshot(buf)
  assert.equal(snap.tool, 'read')
  assert.equal(snap.text, 'a/b.js')
})

test('unrelated chunks do not change the snapshot', () => {
  const buf = createLiveBuffer()
  assert.equal(reduceLive(buf, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }), false)
  assert.equal(reduceLive(buf, { type: 'block-start', index: 0, blockType: 'text' }), false)
  assert.equal(reduceLive(buf, null), false)
  assert.equal(liveSnapshot(buf), undefined)
})

test('long streams keep only the tail', () => {
  const buf = createLiveBuffer()
  for (let i = 0; i < 200; i++) reduceLive(buf, { type: 'reasoning-delta', index: 0, text: `片段${i} ` })
  const snap = liveSnapshot(buf)
  assert.ok(snap.text.length <= 320)
  assert.ok(snap.text.endsWith('片段199'))
})

test('resetLive clears a buffer between attempts', () => {
  const buf = createLiveBuffer()
  reduceLive(buf, { type: 'text-delta', index: 0, text: '旧内容' })
  resetLive(buf)
  assert.equal(liveSnapshot(buf), undefined)
  assert.equal(buf.kind, 'thinking')
})

test('describeArgs prefers a meaningful field over raw JSON', () => {
  assert.equal(describeArgs('{"path":"src/a.js","offset":10}'), 'src/a.js')
  assert.equal(describeArgs('{"pattern":"foo("}'), 'foo(')
  assert.equal(describeArgs('{"unknown":"value"}'), 'value')
  assert.equal(describeArgs('{"command":"git status"}'), 'git status')
  assert.equal(describeArgs(''), '')
})
