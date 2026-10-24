import test from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../core.js'
import { reviewObserved } from '../index.js'

test('long original request retains final acceptance detail in executor and reviewer', async () => {
  const task = 'x'.repeat(11900) + ' MUST_KEEP_TAIL'
  const prompts = []
  await runPipeline({ task, mode: 'simple' }, async (role, prompt) => {
    prompts.push({ role, prompt })
    return { sessionId: role, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: true, evidence: ['read file'], findings: [] } : undefined }
  })
  assert.equal(prompts.length, 2)
  for (const item of prompts) assert.match(item.prompt, /MUST_KEEP_TAIL/)
})
test('a claimed read with no successful matching result is not observed', () => {
  assert.equal(reviewObserved([{ type: 'tool/call', data: { name: 'read', callId: 'r' } }]), false)
  assert.equal(reviewObserved([
    { type: 'tool/call', data: { name: 'read', callId: 'r' } },
    { type: 'tool/result', data: { message: { isError: true, source: { callId: 'r' } } } },
  ]), false)
})
