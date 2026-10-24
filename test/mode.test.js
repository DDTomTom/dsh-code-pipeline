import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createModeStore, resolveRoute } from '../index.js'

function harness(config) {
  let section, command
  const dir = mkdtempSync(join(tmpdir(), 'cp-mode-state-'))
  const ctx = {
    effect: fn => fn(), on: () => {},
    tools: { register: () => () => {} },
    systemPrompt: { section: spec => { section = spec; return () => {} } },
    inject: (_deps, fn) => fn({ get: () => ({ register: def => { command = def; return () => {} } }), effect: fn => fn() }),
    llm: {
      async listModels(provider) { return provider === 'anthropic' ? [{ id: 'claude-fable-5' }, { id: 'claude-fable-5-1' }, { id: 'claude-opus-5-5' }] : [] },
      async resolveModelInfo(provider, model) { if (model === 'missing-model') throw new Error('unknown model') },
    },
  }
  apply(ctx, { routesFile: join(dir, 'routes.json'), ...config })
  return { dir, section: a => section.text(a), command: (agent, rawInput) => command.handler({ agent, rawInput }) }
}

test('manual start mode requires an explicit user start; child sessions get no rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mode-'))
  try {
    const h = harness({ startMode: 'manual', stateFile: join(dir, 'modes.json') })
    assert.match(h.section({ agent: { id: 'root', session: { header: { origin: 'user' } } } }), /explicitly says to start/)
    assert.equal(h.section({ agent: { id: 'child', session: { header: { origin: 'subagent' } } } }), '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/pipeline switches one session only and survives a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mode-'))
  const stateFile = join(dir, 'modes.json')
  try {
    const h = harness({ startMode: 'auto', stateFile })
    const a = { id: 'session-a' }, b = { id: 'session-b' }
    assert.equal((await h.command(a, 'manual')).kind, 'success')
    assert.match(h.section({ agent: a }), /Pending-start mode/)
    assert.match(h.section({ agent: b }), /default execution path/)
    assert.match((await h.command(a, 'status')).text, /待启动/)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sessions['session-a'], 'manual')
    const reloaded = harness({ startMode: 'auto', stateFile })
    assert.match(reloaded.section({ agent: a }), /Pending-start mode/)
    await reloaded.command(a, 'auto')
    assert.match(reloaded.section({ agent: a }), /default execution path/)
    assert.equal((await h.command(a, 'bogus')).kind, 'error')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/pipeline routes reports resolvable and broken routes without model calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mode-'))
  try {
    const h = harness({ stateFile: join(dir, 'm.json'), routes: {
      emergencyFable: { provider: 'anthropic', model: 'latest-fable' },
      emergencyAstra: { provider: 'openai', model: 'latest-astra' },
      execution: { provider: 'deepseek-account', model: 'missing-model' },
    } })
    const { text } = await h.command({ id: 's' }, 'routes')
    assert.match(text, /✓ emergencyFable: anthropic\/claude-fable-5-1/)
    assert.match(text, /✗ emergencyAstra: .*no astra model/)
    assert.match(text, /✗ execution: .*unknown model/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mode store keeps a bounded number of sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mode-'))
  try {
    const store = createModeStore(join(dir, 'm.json'))
    for (let i = 0; i < 520; i++) store.set(`s${i}`, 'manual')
    assert.equal(store.get('s0'), undefined)
    assert.equal(store.get('s519'), 'manual')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveRoute rejects an unconfigured route', async () => {
  await assert.rejects(resolveRoute({}, 'design', undefined), /not configured/)
})
