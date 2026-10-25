import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

test('missing execution API credential is reported without claiming success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-cred-'))
  const listeners = {}, owner = { id: 'owner' }
  let tool
  const ctx = {
    effect: fn => fn(), on: (name, fn) => { listeners[name] = fn },
    logger: { warn() {} },
    tools: { register: def => { tool = def; return () => {} }, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    llm: { async resolveModelInfo() { return {} } },
    sessionQuery: { async readSession() { return { events: [{ type: 'turn/end', data: { reason: { error: { code: 'MISSING_CREDENTIAL' } } } }] } } },
    subagents: {
      getProvider: () => ({}),
      async startActivation(spec) {
        listeners['agent/created']({ agent: { id: spec.childId, ctx: { effect: fn => fn(), tools: { guard: () => () => {} } } } })
        return { childId: spec.childId, result: Promise.resolve({ stopReason: 'error', output: [] }), async dispose() {} }
      },
    },
  }
  try {
    apply(ctx, {
      routesFile: join(dir, 'routes.json'), stateFile: join(dir, 'modes.json'), modeFile: join(dir, 'default-mode.json'),
      routes: { execution: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    })
    const result = await tool.execute({ task: 'Fix parser', mode: 'simple' }, { agent: owner, signal: new AbortController().signal })
    assert.equal(result.status, 'needs_configuration')
    assert.equal(result.route, 'deepseek-official/deepseek-flash')
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
