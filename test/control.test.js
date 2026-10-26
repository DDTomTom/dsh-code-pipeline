import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** The panel's own routes: limits, the enable switches, and the stop/continue controls. */
function harness(dir, config = {}) {
  let handler
  const tool = {}
  const ctx = {
    effect: fn => fn(), on: () => {}, logger: { warn() {} },
    sessionQuery: { async readSession() { return { events: [] } } },
    tools: { guard: () => () => {}, schemas: () => [], register: def => { Object.assign(tool, def); return () => {} }, execute: async () => ({ isError: false, value: { status: 'completed', exitCode: 0 } }) },
    systemPrompt: { section: () => () => {} },
    llm: {
      async listProviders() { return [{ id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' }] },
      async listModels(provider) { return provider === 'openai' ? [{ id: 'gpt-6-sol' }] : [{ id: 'claude-opus-5-5' }] },
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } } },
    },
    subagents: { getProvider: () => ({}) },
    inject: (services, run) => {
      if (services.includes('webServer')) run({ effect: fn => fn(), get: () => ({ register: spec => { handler = spec.handler; return () => {} } }) })
    },
  }
  apply(ctx, {
    routesFile: join(dir, 'routes.json'), stateFile: join(dir, 'modes.json'), modeFile: join(dir, 'default-mode.json'),
    ...config,
  })
  const call = async (method, path, body) => {
    const req = { method, url: path, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    let status = 200, payload
    const res = { writeHead: code => { status = code }, end: text => { payload = JSON.parse(text) } }
    await handler(req, res)
    return { status, body: payload }
  }
  return { tool, call }
}

test('the state route publishes the interactive time limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-control-'))
  try {
    const h = harness(dir)
    const { body } = await h.call('GET', '/dsh-code-pipeline/state')
    assert.deepEqual(body.limits, { firstMinutes: 20, nextMinutes: 120, askWindowMs: 180000 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stage switched off in the panel is persisted and disappears from the resolved routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-control-'))
  try {
    const h = harness(dir, { routes: {
      execution: { provider: 'openai', model: 'gpt-6-sol' },
      verification: { provider: 'anthropic', model: 'claude-opus-5-5' },
    } })
    const listed = await h.call('GET', '/dsh-code-pipeline/settings')
    assert.equal(listed.body.roles.find(r => r.role === 'verification').enabled, true)
    const saved = await h.call('POST', '/dsh-code-pipeline/settings', { routes: [{ role: 'verification', enabled: false }] })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.settings.roles.find(r => r.role === 'verification').enabled, false)
    const file = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'))
    assert.deepEqual(file.disabled, ['verification'])
    const state = await h.call('GET', '/dsh-code-pipeline/state')
    assert.equal(state.body.health.routes.some(r => r.role === 'verification'), false, 'a switched-off stage is not probed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stop and continue refuse when nothing is running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-control-'))
  try {
    const h = harness(dir)
    for (const path of ['/dsh-code-pipeline/stop', '/dsh-code-pipeline/continue']) {
      const { status, body } = await h.call('POST', path, {})
      assert.equal(status, 404)
      assert.equal(body.ok, false)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the tool advertises the merged diagnostics escalation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-control-'))
  try {
    const h = harness(dir)
    assert.deepEqual(h.tool.parameters.properties.escalation.enum, ['none', 'diagnose', 'fable', 'astra'])
    // The hard tool timeout must outlive several interactive windows, not cut the run at 20 minutes.
    assert.ok(h.tool.timeoutMs >= 20 * 60000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an old routes file with the two emergency stages folds into one diagnostics stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-control-'))
  try {
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({ routes: {
      emergencyAstra: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' },
    } }))
    const h = harness(dir, { routes: { diagnostics: { provider: 'openai', model: 'gpt-6-sol' } } })
    const { body } = await h.call('GET', '/dsh-code-pipeline/settings')
    const diagnostics = body.roles.filter(r => r.role === 'diagnostics')
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].provider, 'anthropic', 'the legacy saved route still wins over the bundle default')
    assert.equal(body.roles.some(r => r.role === 'emergencyAstra'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
