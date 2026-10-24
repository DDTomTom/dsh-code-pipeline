import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, reviewObserved } from '../index.js'

test('native structured_output remains available to reviewer and executor cannot recurse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-plugin-'))
  const events = {}
  let tool, guard, section, presentationCount = 0
  const parent = { id: 'parent' }
  const ctx = {
    effect: fn => fn(), on: (name, fn) => { events[name] = fn },
    logger: { warn() {} },
    sessionQuery: { async readSession() { return { events: [
      { type: 'tool/call', data: { callId: 'reader-1', name: 'read' } },
      { type: 'tool/result', data: { message: { isError: false, source: { callId: 'reader-1' } } } },
    ] } } },
    tools: {
      guard: fn => { guard = fn; return () => {} },
      schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'ops_read_files' }],
      register: def => { tool = def; return () => {} },
      execute: async request => {
        assert.equal(request.arguments.workdir, 'C:/repo')
        if (request.arguments.command.startsWith('git rev-parse')) return { isError: false, value: { status: 'completed', exitCode: 0, stdout: '## git status --porcelain -uall\n M parser.js\n' } }
        assert.equal(request.arguments.command, 'node --test')
        return { isError: false, value: { status: 'completed', exitCode: 0 } }
      },
    },
    systemPrompt: { section: spec => { section = spec; return () => {} } },
    llm: { async resolveModelInfo() { return {} } },
    subagents: {
      getProvider: () => ({}),
      async startActivation(spec) {
        const child = { id: spec.childId, ctx: { effect: fn => fn(), tools: {
          guard: fn => { guard = fn; return () => {} },
          restrict: filter => {
            assert.equal(filter.allow.includes('read'), true)
            assert.equal(filter.allow.includes('write'), spec.label === 'code:execution')
            return () => {}
          },
          presentAs: mode => { assert.equal(mode, 'native'); presentationCount++; return () => {} },
        } } }
        events['agent/created']({ agent: child })
        assert.equal(guard({ agent: child, name: 'code_pipeline' })?.includes('cannot start another'), true)
        if (spec.label === 'code:execution') assert.match(guard({ agent: child, name: 'bili_send_message' }), /coding tools only/)
        if (spec.label === 'code:verification') {
          assert.match(spec.request.prompt[0].text, /总控在执行后独立采集的仓库事实[\s\S]*M parser\.js/)
          assert.equal(guard({ agent: child, name: 'structured_output' }), undefined)
          assert.match(guard({ agent: child, name: 'write' }), /read-only/)
          assert.match(guard({ agent: child, name: 'ops_bash', arguments: { command: 'npm test' } }), /read-only/)
        }
        return { childId: spec.childId, result: Promise.resolve(spec.label === 'code:verification'
          ? { stopReason: 'completed', structured: { passed: true, evidence: ['inspected diff'], findings: [] }, output: [] }
          : { stopReason: 'completed', output: [{ type: 'text', text: 'implemented' }] }), async dispose() {} }
      },
    },
  }
  apply(ctx, {
    routesFile: join(dir, 'routes.json'), stateFile: join(dir, 'modes.json'),
    routes: { execution: { provider: 'deepseek-official', model: 'deepseek-flash' }, verification: { provider: 'openai', model: 'gpt-6-sol' } },
  })
  try {
    const invalid = await tool.execute({ task: 'Fix parser', mode: 'simple', checkCommand: 'npm test' }, { agent: parent, signal: new AbortController().signal })
    assert.equal(invalid.status, 'invalid_input')
    const result = await tool.execute({ task: 'In C:/repo fix parser and run node --test', mode: 'simple', checkCommand: 'node --test', checkWorkdir: 'C:/repo' }, { agent: parent, signal: new AbortController().signal })
    assert.equal(result.status, 'reviewed_with_check')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  assert.match(section.text({ agent: parent }), /default execution path/)
  assert.equal(section.text({ agent: { id: 'other', session: { header: { origin: 'subagent' } } } }), '')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(presentationCount, 1)
  assert.equal(reviewObserved([]), false)
})
