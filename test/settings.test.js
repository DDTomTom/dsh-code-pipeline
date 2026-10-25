import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRoutePatch, loadRouteOverrides, mergeRoutes, roleLabel, saveRouteOverrides, STAGE_ROLES } from '../settings.js'

const base = {
  direction: { provider: 'openai', model: 'gpt-6-sol' },
  planning: { provider: 'anthropic', model: 'latest-opus' },
  execution: { provider: 'deepseek-account', model: 'deepseek-flash' },
}

test('saved overrides win over the bundle config and persist across a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-settings-'))
  try {
    const file = join(dir, 'routes.json')
    assert.deepEqual(mergeRoutes(base, {}), base)
    assert.equal(saveRouteOverrides(file, { planning: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' } }), true)
    const loaded = loadRouteOverrides(file)
    const merged = mergeRoutes(base, loaded)
    assert.deepEqual(merged.planning, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' })
    assert.deepEqual(merged.direction, base.direction, 'untouched roles keep the bundle config')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unreadable or foreign override file degrades to no overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-settings-'))
  try {
    assert.deepEqual(loadRouteOverrides(join(dir, 'missing.json')), {})
    saveRouteOverrides(join(dir, 'x.json'), { notARole: { provider: 'openai', model: 'x' } })
    assert.deepEqual(loadRouteOverrides(join(dir, 'x.json')), {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a patch installs only combinations the catalog actually advertises', () => {
  const providers = ['openai', 'anthropic']
  const modelsOf = p => (p === 'openai' ? ['gpt-6-sol'] : ['claude-opus-5-5'])
  const ok = applyRoutePatch({
    patch: [{ role: 'direction', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' }],
    routes: base, providers, modelsOf, effortsOf: () => ['high'],
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.routes.direction, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' })
  assert.deepEqual(ok.routes.execution, base.execution)
  // Without a sync effort validator the patch still applies; the host checks efforts asynchronously.
  assert.equal(applyRoutePatch({ patch: [{ role: 'design', provider: 'openai', model: 'gpt-6-sol', effort: 'max' }], routes: base, providers, modelsOf }).ok, true)

  const effortsOf = () => []
  assert.match(applyRoutePatch({ patch: [{ role: 'nope', provider: 'openai', model: 'gpt-6-sol' }], routes: base, providers, modelsOf, effortsOf }).reason, /未知环节/)
  assert.match(applyRoutePatch({ patch: [{ role: 'design', provider: 'ghost', model: 'x' }], routes: base, providers, modelsOf, effortsOf }).reason, /未注册/)
  assert.match(applyRoutePatch({ patch: [{ role: 'design', provider: 'openai', model: 'gpt-6' }], routes: base, providers, modelsOf, effortsOf }).reason, /目录中没有/)
  assert.match(applyRoutePatch({ patch: [{ role: 'design', provider: 'openai', model: 'gpt-6-sol', effort: 'max' }], routes: base, providers, modelsOf, effortsOf: () => ['low'] }).reason, /不支持推理等级/)
  assert.equal(applyRoutePatch({ patch: [], routes: base, providers, modelsOf, effortsOf }).ok, false)
})

test('every stage the panel lists is a role the pipeline knows', () => {
  assert.deepEqual(STAGE_ROLES, ['direction', 'planning', 'design', 'execution', 'verification', 'deepReview', 'emergencyFable', 'emergencyAstra', 'summarize'])
  for (const role of STAGE_ROLES) assert.equal(typeof roleLabel(role), 'string')
  assert.equal(roleLabel('summarize'), '总结')
})
