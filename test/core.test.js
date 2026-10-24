import test from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../core.js'

const direction = { goal: 'Fix parser', acceptance: ['test passes'], complexity: 'complex', risk: 'high', needsInput: false, question: '' }
function stub(results) {
  const roles = []
  return { roles, call: async role => {
    roles.push(role)
    const value = results[role]
    if (!value) throw new Error(`missing ${role}`)
    return { sessionId: `session-${roles.length}`, stopReason: 'completed', output: `${role} report`, ...value }
  } }
}
test('complex coding task plans, implements and checks independently', async () => {
  const s = stub({ direction: { structured: direction }, planning: {}, design: {}, execution: {}, deepReview: { structured: { passed: true, evidence: ['test passed; diff inspected'], findings: [] } } })
  const result = await runPipeline({ task: 'Fix parser' }, s.call, async () => ({ passed: true, checks: ['git diff --check exit 0'] }))
  assert.equal(result.status, 'reviewed_with_check')
  assert.deepEqual(s.roles, ['direction', 'planning', 'design', 'execution', 'deepReview'])
  assert.equal(result.trace.length, 5)
})
test('simple task skips expensive stages', async () => {
  const s = stub({ execution: {}, verification: { structured: { passed: true, evidence: ['file read'], findings: [] } } })
  const result = await runPipeline({ task: 'Rename identifier', mode: 'simple' }, s.call)
  assert.equal(result.status, 'reviewed_unverified')
  assert.deepEqual(s.roles, ['execution', 'verification'])
})
test('missing blocking details never start implementation', async () => {
  const s = stub({ direction: { structured: { ...direction, needsInput: true, question: 'Which package?' } } })
  assert.equal((await runPipeline({ task: 'Fix it' }, s.call)).status, 'needs_input')
  assert.deepEqual(s.roles, ['direction'])
})
test('a passing model vote without evidence is not verified', async () => {
  const s = stub({ execution: {}, verification: { structured: { passed: true, evidence: [], findings: ['no test result'] } } })
  const result = await runPipeline({ task: 'Fix parser', mode: 'simple', maxRepairs: 0 }, s.call)
  assert.equal(result.status, 'not_verified')
})
test('one failed review permits only one local repair', async () => {
  let reviewCount = 0
  const roles = []
  const result = await runPipeline({ task: 'Fix parser', mode: 'simple' }, async role => {
    roles.push(role)
    return { sessionId: `session-${roles.length}`, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: ++reviewCount > 1, evidence: ['actual test'], findings: ['compile error'] } : undefined }
  })
  assert.equal(result.status, 'reviewed_unverified')
  assert.equal(result.attempts, 2)
  assert.deepEqual(roles, ['execution', 'verification', 'execution', 'verification'])
})
test('non-completed child halts instead of claiming success', async () => {
  await assert.rejects(runPipeline({ task: 'Fix parser', mode: 'simple' }, async () => ({ stopReason: 'error' })), /did not complete/)
})
test('exceptional fable diagnosis runs only after normal bounded repair fails', async () => {
  const roles = []
  let reviews = 0
  const result = await runPipeline({ task: 'Fix parser', mode: 'simple', escalation: 'fable' }, async role => {
    roles.push(role)
    return { sessionId: role + roles.length, stopReason: 'completed', output: role === 'emergencyFable' ? 'Diagnose parser edge case' : 'report', structured: role === 'verification' ? { passed: ++reviews === 3, evidence: ['read file'], findings: ['edge case'] } : undefined }
  }, async () => ({ passed: true, checks: ['unit tests exited 0'] }))
  assert.equal(result.status, 'reviewed_with_check')
  assert.deepEqual(roles, ['execution', 'verification', 'execution', 'verification', 'emergencyFable', 'execution', 'verification'])
})
test('missing emergency model leaves normal failure unchanged', async () => {
  const result = await runPipeline({ task: 'Fix parser', mode: 'simple', maxRepairs: 0, escalation: 'astra' }, async role => {
    if (role === 'emergencyAstra') throw new Error('no astra model in catalog')
    return { sessionId: role, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: false, evidence: ['read file'], findings: ['test failed'] } : undefined }
  })
  assert.equal(result.status, 'not_verified')
  assert.match(result.next, /no astra model/)
})
test('failed explicit test command triggers one bounded repair', async () => {
  const roles = []
  let audits = 0
  const result = await runPipeline({ task: 'Fix parser; run node --test', mode: 'simple' }, async role => {
    roles.push(role)
    return { sessionId: role, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: true, evidence: ['read file'], findings: [] } : undefined }
  }, async () => ++audits === 1 ? { passed: false, failureKind: 'test_failed', findings: ['node --test exited 1'] } : { passed: true, checks: ['node --test exited 0'] })
  assert.equal(result.status, 'reviewed_with_check')
  assert.equal(result.attempts, 2)
  assert.deepEqual(roles, ['execution', 'verification', 'execution', 'verification'])
})
test('persistently failing tests end not_verified without unbounded loops', async () => {
  const result = await runPipeline({ task: 'Fix parser', mode: 'simple' }, async role => (
    { sessionId: role, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: true, evidence: ['read file'], findings: [] } : undefined }
  ), async () => ({ passed: false, failureKind: 'test_failed', findings: ['exit 1'] }))
  assert.equal(result.status, 'not_verified')
  assert.equal(result.attempts, 2)
})
test('orchestrator workspace facts reach the reviewer; collector failure is not fatal', async () => {
  const prompts = {}
  const call = async (role, prompt) => {
    prompts[role] = prompt
    return { sessionId: role, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: true, evidence: ['read file'], findings: [] } : undefined }
  }
  await runPipeline({ task: 'Fix even.js', mode: 'simple' }, call, undefined, async () => '## git status --porcelain -uall\n M even.js')
  assert.match(prompts.verification, /总控在执行后独立采集的仓库事实[\s\S]*M even\.js/)
  const r = await runPipeline({ task: 'Fix even.js', mode: 'simple' }, call, undefined, async () => { throw new Error('git missing') })
  assert.equal(r.status, 'reviewed_unverified')
  assert.doesNotMatch(prompts.verification, /总控在执行后/)
})
test('successful normal path never invokes an emergency route', async () => {
  const roles = []
  await runPipeline({ task: 'Fix parser', mode: 'simple', escalation: 'astra' }, async role => {
    roles.push(role)
    return { sessionId: role, stopReason: 'completed', output: 'report', structured: role === 'verification' ? { passed: true, evidence: ['read file'], findings: [] } : undefined }
  })
  assert.deepEqual(roles, ['execution', 'verification'])
})
