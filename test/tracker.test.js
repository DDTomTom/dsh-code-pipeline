import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessHealth, createTracker } from '../tracker.js'
import { apply } from '../index.js'

test('tracker records phases, routes, verdicts and final status', () => {
  let t = 1000
  const tracker = createTracker(() => t)
  const run = tracker.startRun({ sessionId: 's1', task: '修复   parser\n bug', mode: 'complex' })
  const a = run.phase('direction', 'openai/gpt-6-sol'); t += 500; a.end()
  const b = run.phase('planning', 'anthropic/latest-opus'); b.route('anthropic/claude-opus-5-5')
  let snap = tracker.snapshot()
  assert.equal(snap.runs[0].task, '修复 parser bug')
  assert.deepEqual(snap.runs[0].phases.map(p => [p.label, p.status]), [['定向', 'done'], ['规划', 'running']])
  assert.equal(snap.runs[0].phases[1].route, 'anthropic/claude-opus-5-5')
  run.phase('execution', 'deepseek-account/deepseek-flash').end()
  run.phase('verification', 'openai/gpt-6-sol').end('rejected', '未通过')
  run.phase('execution', 'deepseek-account/deepseek-flash')
  snap = tracker.snapshot()
  assert.equal(snap.runs[0].attempt, 2)
  run.finish({ status: 'not_verified', findings: ['test failed'] })
  snap = tracker.snapshot()
  assert.equal(snap.runs[0].status, 'not_verified')
  assert.equal(snap.runs[0].summary, 'test failed')
  assert.equal(snap.runs[0].phases.find(p => p.label === '规划').status, 'failed', 'dangling phases close as failed')
})

test('tracker keeps a bounded run history, newest first', () => {
  const tracker = createTracker()
  for (let i = 0; i < 9; i++) tracker.startRun({ task: `t${i}` }).finish({ status: 'reviewed_with_check' })
  const { runs } = tracker.snapshot()
  assert.equal(runs.length, 6)
  assert.equal(runs[0].task, 't8')
})

test('health: core route failure is an error, emergency failure only a warning', () => {
  assert.equal(assessHealth({ toolRegistered: true, routeChecks: [], checkedAt: 0 }).level, 'unknown')
  const ok = assessHealth({ toolRegistered: true, checkedAt: 1, routeChecks: [{ role: 'execution', ok: true }] })
  assert.equal(ok.level, 'ok')
  const warn = assessHealth({ toolRegistered: true, checkedAt: 1, routeChecks: [{ role: 'execution', ok: true }, { role: 'emergencyAstra', ok: false, error: 'no model' }] })
  assert.equal(warn.level, 'warn')
  assert.match(warn.warnings[0], /Astra 诊断/)
  const bad = assessHealth({ toolRegistered: false, checkedAt: 1, routeChecks: [{ role: 'execution', ok: false, error: 'unknown model' }] })
  assert.equal(bad.level, 'error')
  assert.equal(bad.issues.length, 2)
})

test('health reports a run whose account refused the route, and a clean success', () => {
  const refused = assessHealth({
    toolRegistered: true, checkedAt: 1, routeChecks: [{ role: 'direction', ok: true }],
    lastRun: { status: 'provider_unusable', route: 'openai/gpt-6-sol', summary: 'You have no credits remaining.', endedAt: 1700000000000 },
  })
  assert.equal(refused.level, 'error', 'a resolvable catalog entry must not read as healthy after the account refused it')
  assert.match(refused.issues[0], /openai\/gpt-6-sol[\s\S]*no credits/)
  const okRun = assessHealth({
    toolRegistered: true, checkedAt: 1, routeChecks: [{ role: 'direction', ok: true }],
    lastRun: { status: 'reviewed_with_check', endedAt: 1700000000000 },
  })
  assert.equal(okRun.level, 'ok')
  assert.match(okRun.lastRun, /最近一次运行成功/)
  const haltedRun = assessHealth({ toolRegistered: true, checkedAt: 1, routeChecks: [], lastRun: { status: 'halted', summary: 'x', endedAt: 1 } })
  assert.equal(haltedRun.level, 'warn')
})

test('state route serves live progress and health JSON', async () => {
  let route
  const ctx = {
    effect: fn => fn(), on: () => {},
    tools: { register: () => () => {}, get: () => ({}) },
    systemPrompt: { section: () => () => {} },
    inject: (deps, fn) => fn({ get: name => name === 'webServer' ? { register: r => { route = r; return () => {} } } : { register: () => () => {} }, effect: fn => fn() }),
  }
  const dir = mkdtempSync(join(tmpdir(), 'cp-route-'))
  apply(ctx, { routesFile: join(dir, 'routes.json'), stateFile: join(dir, 'modes.json') })
  assert.equal(route.path, '/dsh-code-pipeline')
  let status, body
  const res = { writeHead: code => { status = code }, end: text => { body = JSON.parse(text) } }
  try {
    await route.handler({ url: '/dsh-code-pipeline/state?x=1', method: 'GET' }, res)
    assert.equal(status, 200)
    assert.deepEqual(body.runs, [])
    assert.equal(body.health.level, 'unknown')
    await route.handler({ url: '/dsh-code-pipeline/nope', method: 'GET' }, res)
    assert.equal(status, 404)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
