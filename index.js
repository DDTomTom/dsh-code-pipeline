import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runPipeline } from './core.js'
import { assessHealth, createTracker } from './tracker.js'
import { applyRoutePatch, loadRouteOverrides, mergeRoutes, roleLabel, saveRouteOverrides, STAGE_ROLES } from './settings.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const MAX_SESSION_MODES = 500

/** Per-session start mode (auto|manual), persisted so a restart keeps the user's choice. */
export function createModeStore(file) {
  const modes = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    for (const [id, mode] of Object.entries(raw?.sessions || {})) if (mode === 'auto' || mode === 'manual') modes.set(id, mode)
  } catch { /* first use or unreadable: start empty */ }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(modes) }, null, 2))
      renameSync(tmp, file)
    } catch { /* persistence is best effort; the in-memory choice still applies */ }
  }
  return {
    get: id => modes.get(String(id)),
    set(id, mode) {
      modes.delete(String(id))
      modes.set(String(id), mode)
      while (modes.size > MAX_SESSION_MODES) modes.delete(modes.keys().next().value)
      save()
    },
  }
}

/** Resolve a configured route to a concrete catalog model id. */
export async function resolveRoute(llm, role, route, signal) {
  if (!route?.provider || !route?.model) throw new Error(`${role}: model route is not configured`)
  let model = route.model
  if (['latest-opus', 'latest-fable', 'latest-astra'].includes(model)) {
    const family = model.slice('latest-'.length)
    const candidates = (await llm.listModels(route.provider)).filter(item => item.id?.split(/[-_]/).includes(family))
    model = candidates.map(item => item.id).sort().at(-1)
    if (!model) throw new Error(`${role}: no ${family} model in the configured catalog`)
  }
  await llm.resolveModelInfo(route.provider, model, signal)
  return model
}

export const inject = ['tools', 'subagents', 'llm', 'systemPrompt', 'sessionQuery']
const readonlyNames = new Set(['read', 'glob', 'grep', 'ops_read_files', 'structured_output'])
const executorNames = new Set([
  'read', 'glob', 'grep', 'ops_read_files', 'ops_discover_tools', 'read_image',
  'write', 'edit', 'ops_bash', 'pwsh', 'working_directory',
  'job_list', 'job_output', 'job_kill', 'load_workspace_dependencies',
  'skill', 'cordis_inspect_list', 'cordis_inspect_query',
  'web_search', 'web_fetch', 'read_page',
])
const phaseChildren = new Map()
const phasePresentations = new Map()
const text = (value) => [{ type: 'text', text: JSON.stringify(value) }]
export function phaseGuard(role, exec) {
  if (exec.name === 'code_pipeline') return 'A pipeline phase cannot start another pipeline.'
  if (role === 'execution') return executorNames.has(exec.name) ? undefined : 'The execution phase may use coding tools only.' // DSH permission/sandbox still applies.
  if (readonlyNames.has(exec.name)) return undefined
  return `The ${role} phase is read-only; this tool is not available.`
}
export function reviewObserved(events) {
  const reads = new Set((events || []).filter(e => e.type === 'tool/call' && ['read', 'ops_read_files'].includes(e.data?.name)).map(e => e.data.callId))
  return (events || []).some(e => e.type === 'tool/result' && !e.data?.message?.isError && !e.data?.error && reads.has(e.data?.message?.source?.callId))
}

export function apply(ctx, config = {}) {
  const baseRoutes = config.routes || {}
  const routesFile = config.routesFile || join(DSH_HOME, 'code-pipeline', 'routes.json')
  let overrides = loadRouteOverrides(routesFile)
  let routes = mergeRoutes(baseRoutes, overrides)
  const backend = config.backend || 'spawn'
  const startMode = config.startMode === 'manual' ? 'manual' : 'auto'
  const modeStore = createModeStore(config.stateFile || join(DSH_HOME, 'code-pipeline', 'session-modes.json'))
  const modeFor = id => modeStore.get(id) || startMode
  const pluginAbort = new AbortController()
  ctx.effect(() => () => pluginAbort.abort(), 'code-pipeline.cancel-on-unload')

  // ---- live progress + health for the floating panel ------------------------------
  const tracker = createTracker()
  let routeChecks = []
  let routeCheckedAt = 0
  let routeCheckRunning
  const checkRoutes = () => {
    if (routeCheckRunning) return routeCheckRunning
    routeCheckRunning = (async () => {
      routeChecks = await Promise.all(Object.entries(routes).map(async ([role, route]) => {
        try { return { role, ok: true, route: `${route.provider}/${await resolveRoute(ctx.llm, role, route, pluginAbort.signal)}` } }
        catch (error) { return { role, ok: false, route: `${route?.provider}/${route?.model}`, error: String(error?.message || error).slice(0, 160) } }
      }))
      routeCheckedAt = Date.now()
    })().catch(() => {}).finally(() => { routeCheckRunning = undefined })
    return routeCheckRunning
  }
  const healthView = () => assessHealth({
    toolRegistered: typeof ctx.tools.get === 'function' ? ctx.tools.get('code_pipeline') !== undefined : true,
    routeChecks, checkedAt: routeCheckedAt,
    lastRun: tracker.snapshot().runs[0],
  })
  const stateView = () => ({ ...tracker.snapshot(), health: healthView() })
  if (typeof ctx.inject === 'function') {
    // First probe shortly after load, then every 10 minutes; probes resolve catalogs only (no model calls).
    ctx.inject(['timer'], timerCtx => {
      const timer = typeof timerCtx.get === 'function' ? timerCtx.get('timer') : timerCtx.timer
      if (typeof timer?.interval !== 'function') return
      timerCtx.effect(() => timer.timeout(() => { checkRoutes() }, 3000), 'code-pipeline.route-probe-first')
      timerCtx.effect(() => timer.interval(() => { checkRoutes() }, 600000), 'code-pipeline.route-probe')
    })
  }
  // ---- editable stage→model mapping (panel gear) -----------------------------------
  let catalog = { at: 0, providers: [], models: {} }
  const effortsCache = new Map()
  const loadCatalog = async (force = false) => {
    if (!force && catalog.providers.length && Date.now() - catalog.at < 60000) return catalog
    const providers = (await ctx.llm.listProviders()).map(p => ({ id: p.id, name: p.name || p.id }))
    const models = {}
    await Promise.all(providers.map(async p => {
      try { models[p.id] = (await ctx.llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name || m.id })) }
      catch { models[p.id] = [] }
    }))
    catalog = { at: Date.now(), providers, models }
    return catalog
  }
  const effortsOf = async (provider, model) => {
    const key = `${provider}/${model}`
    if (!effortsCache.has(key)) {
      let efforts = []
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model, pluginAbort.signal)
        efforts = (info?.reasoning?.efforts || []).map(e => ({ id: String(e.id), name: e.name || String(e.id), ...(e.description ? { description: e.description } : {}) }))
        efforts.default = info?.reasoning?.defaultEffort ? String(info.reasoning.defaultEffort) : undefined
      } catch { /* an unresolvable route offers no efforts */ }
      effortsCache.set(key, efforts)
    }
    return effortsCache.get(key)
  }
  const settingsView = async () => {
    const cat = await loadCatalog()
    const roles = []
    for (const role of STAGE_ROLES) {
      const route = routes[role]
      if (!route) continue
      let model = route.model
      if (['latest-opus', 'latest-fable', 'latest-astra'].includes(model)) {
        const family = model.slice('latest-'.length)
        const ids = (cat.models[route.provider] || []).map(m => m.id)
          .filter(id => id.split(/[-_]/).includes(family)).sort()
        model = ids.at(-1) || route.model
      }
      const efforts = await effortsOf(route.provider, model)
      roles.push({
        role, label: roleLabel(role), provider: route.provider, model,
        effort: route.effort || '', efforts: [...efforts],
        defaultEffort: efforts.default || '',
      })
    }
    return { roles, providers: cat.providers, models: cat.models }
  }
  const readJsonBody = async req => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw.length > 20000) throw new Error('body too large')
    return raw ? JSON.parse(raw) : {}
  }
  const saveSettings = async body => {
    const cat = await loadCatalog(true)
    const providers = cat.providers.map(p => p.id)
    const patch = Array.isArray(body?.routes) ? body.routes : []
    const checked = applyRoutePatch({
      patch, routes, providers,
      modelsOf: provider => (cat.models[provider] || []).map(m => m.id),
      // Effort strings are validated below with the async capability lookup.
    })
    if (!checked.ok) return { ok: false, reason: checked.reason }
    const applied = {}
    for (const item of patch) {
      const role = String(item.role)
      const effort = item.effort ? String(item.effort) : ''
      if (effort) {
        const supported = await effortsOf(String(item.provider), String(item.model))
        if (!supported.some(e => e.id === effort)) return { ok: false, reason: `${item.model} 不支持推理等级 ${effort}` }
      }
      applied[role] = { provider: String(item.provider), model: String(item.model), ...(effort ? { effort } : {}) }
    }
    overrides = { ...overrides, ...applied }
    saveRouteOverrides(routesFile, overrides)
    routes = mergeRoutes(baseRoutes, overrides)
    routeCheckedAt = 0
    return { ok: true, settings: await settingsView() }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], webCtx => {
      const webServer = typeof webCtx.get === 'function' ? webCtx.get('webServer') : webCtx.webServer
      if (typeof webServer?.register !== 'function') return
      webCtx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/dsh-code-pipeline',
        handler: async (req, res) => {
          const pathname = String(req.url || '').split('?')[0]
          const json = (code, body) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(body))
          }
          if (pathname === '/dsh-code-pipeline/state' && req.method === 'GET') return json(200, stateView())
          if (pathname === '/dsh-code-pipeline/health' && req.method === 'POST') { await checkRoutes(); return json(200, stateView()) }
          if (pathname === '/dsh-code-pipeline/settings' && req.method === 'GET') {
            try { return json(200, await settingsView()) }
            catch (error) { return json(500, { error: String(error?.message || error).slice(0, 200) }) }
          }
          if (pathname === '/dsh-code-pipeline/settings' && req.method === 'POST') {
            try {
              const result = await saveSettings(await readJsonBody(req))
              return json(result.ok ? 200 : 400, result)
            } catch (error) { return json(400, { ok: false, reason: String(error?.message || error).slice(0, 200) }) }
          }
          return json(404, { error: 'not found' })
        },
      }), 'code-pipeline.state-route')
    })
  }
  ctx.on('agent/created', ({ agent }) => {
    const id = String(agent.id)
    const role = phaseChildren.get(id)
    if (!role) return
    // The child owns its guard: plugin unload cannot remove it while the child still runs.
    agent.ctx.effect(() => agent.ctx.tools.guard(exec => phaseGuard(role, exec)))
    const visible = ctx.tools.schemas().map(tool => tool.name).filter(name => role === 'execution' ? executorNames.has(name) : readonlyNames.has(name) && name !== 'structured_output')
    if (visible.length) agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: visible }))
    if (role === 'execution') return
    // PTC's run_code transport is too broad for a read-only phase; present native tools instead.
    const dispose = agent.ctx.tools.presentAs('native')
    let active = true
    const release = () => { if (active) { active = false; dispose() } }
    phasePresentations.set(id, release)
    agent.ctx.effect(() => release)
  })
  ctx.effect(() => () => {
    for (const release of phasePresentations.values()) release()
    phasePresentations.clear()
  }, 'code-pipeline.presentation-cleanup')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'code-pipeline.routing', order: 460,
    text: assembly => {
      const agent = assembly.agent
      if (phaseChildren.has(String(agent?.id || '')) || agent?.session?.header?.origin === 'subagent') return ''
      const trigger = modeFor(agent?.id) === 'manual'
        ? 'Pending-start mode: only call code_pipeline after the user explicitly says to start implementing (for example 开始/执行/动手); until then discuss and refine the plan without edits.'
        : 'For a user request to IMPLEMENT or FIX code, use code_pipeline once as the default execution path.'
      return `${trigger} For discussion, explanation, research or code review without requested edits, do not call it. Never use it recursively; if it reports needs_input, ask only that question; if not_verified or reviewed_unverified, do not report full verification. The stage tool does not override existing approval or sandbox policies.`
    },
  }), 'code-pipeline.routing')

  // `/pipeline` is a human command: switching mode or probing routes costs no model tokens.
  const usage = '用法：/pipeline auto | manual | status | routes'
  const pipelineCommand = {
    name: 'pipeline',
    description: '复合代码流水线：切换本会话 自动/待启动 模式，或检查各阶段模型线路',
    input: { hint: 'auto | manual | status | routes' },
    handler: async invocation => {
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
      const id = invocation?.agent?.id
      if (arg === 'auto' || arg === 'manual') {
        if (id === undefined) return { kind: 'error', text: '无法识别当前会话，模式未切换。' }
        modeStore.set(id, arg)
        return { kind: 'success', text: arg === 'auto' ? '本会话：自动模式（收到实现/修复指令即启动流水线）。' : '本会话：待启动模式（讨论阶段不改文件，你明确说开始后才启动）。' }
      }
      if (arg === '' || arg === 'status') {
        const mode = id === undefined ? startMode : modeFor(id)
        return { kind: 'success', text: `本会话：${mode === 'auto' ? '自动' : '待启动'}模式（默认 ${startMode}）。${usage}` }
      }
      if (arg === 'routes') {
        await checkRoutes()
        const lines = routeChecks.map(r => r.ok ? `✓ ${r.role}: ${r.route}` : `✗ ${r.role}: ${r.route} — ${r.error}`)
        return { kind: 'success', text: lines.join('\n') || '未配置任何线路。' }
      }
      return { kind: 'error', text: usage }
    },
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], commandCtx => {
      const commands = commandCtx.get('commands')
      if (typeof commands?.register === 'function') commandCtx.effect(() => commands.register(pipelineCommand), 'code-pipeline.command')
    })
  }

  ctx.effect(() => ctx.tools.register({
    name: 'code_pipeline',
    description: 'Implement one user-requested coding change using staged model roles, bounded repair, and independent evidence review. It may modify project files; it does not override the current permission policy. Do not invoke for discussion-only requests.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Original user coding request, preserving acceptance criteria and constraints.' },
        mode: { type: 'string', enum: ['auto', 'simple', 'complex'], description: 'auto lets Sol classify; simple skips expensive direction/planning; complex forces Opus planning. Default auto.' },
        checkCommand: { type: 'string', enum: ['node --test', 'npm test', 'pnpm test', 'pytest', 'cargo test', 'go test ./...'], description: 'Optional independent test command; set only when the user explicitly wrote this exact command in the original task. It runs under the same permission policy.' },
        checkWorkdir: { type: 'string', description: 'Optional test directory, only if its path occurs in the original task; otherwise the current session directory is used.' },
        escalation: { type: 'string', enum: ['none', 'fable', 'astra'], description: 'Exceptional read-only diagnosis after normal repair fails, then one final DeepSeek repair and independent review. Default none; set fable/astra only when the user explicitly asks.' },
      },
      required: ['task'],
    },
    timeoutMs: 1200000,
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) return { status: 'unavailable', reason: 'no owning agent' }
      if (phaseChildren.has(String(parent.id))) return { status: 'unavailable', reason: 'pipeline recursion blocked' }
      if (typeof args?.task !== 'string' || !args.task.trim()) return { status: 'invalid_input', reason: 'task is required' }
      if (args.checkCommand && !args.task.includes(args.checkCommand)) return { status: 'invalid_input', reason: 'checkCommand must occur literally in the user task' }
      if (args.checkWorkdir && !args.task.replaceAll('\\', '/').toLowerCase().includes(args.checkWorkdir.replaceAll('\\', '/').toLowerCase())) return { status: 'invalid_input', reason: 'checkWorkdir must occur literally in the user task' }
      if (!ctx.subagents.getProvider(backend)) return { status: 'unavailable', reason: `subagent backend ${backend} is absent` }
      const signal = AbortSignal.any([exec.signal, pluginAbort.signal])
      const run = tracker.startRun({ sessionId: parent.id, task: args.task, mode: args.mode, escalation: args.escalation })
      const call = async (role, prompt, outputSchema) => {
        const route = routes[role]
        const ph = run.phase(role, route ? `${route.provider}/${route.model}` : '未配置')
        try {
          const model = await resolveRoute(ctx.llm, role, route, signal)
          ph.route(`${route.provider}/${model}`)
          const r = await callResolved(role, route, model, prompt, outputSchema)
          if (r.stopReason !== 'completed') ph.end('failed', r.stopReason)
          else if (r.structured?.passed === false) ph.end('rejected', '未通过')
          else ph.end('done')
          return r
        } catch (error) {
          ph.end('failed', error?.message)
          throw error
        }
      }
      const callResolved = async (role, route, model, prompt, outputSchema) => {
        const childId = randomUUID()
        phaseChildren.set(childId, role)
        let activation
        try {
          activation = await ctx.subagents.startActivation({
            provider: backend, label: `code:${role}`, childId, signal: signal,
            delivery: 'caller',
            request: {
              parent, prompt: [{ type: 'text', text: prompt }],
              agentOptions: { provider: route.provider, model, ...(route.effort ? { reasoningEffort: route.effort } : {}) },
              ...(outputSchema ? { outputSchema } : {}),
            },
          })
          const result = await activation.result
          if (result.stopReason !== 'completed') {
            let failure
            try {
              const log = await ctx.sessionQuery.readSession(childId)
              failure = log.events?.filter(e => e.type === 'turn/end').at(-1)?.data?.reason?.error
            } catch { /* no diagnostic available */ }
            const detail = String(failure?.message || '').slice(0, 400)
            if (failure?.code === 'MISSING_CREDENTIAL') {
              const error = new Error(`${role}: ${route.provider}/${model} requires a configured API credential`)
              error.code = 'MISSING_CREDENTIAL'
              error.route = `${route.provider}/${model}`
              error.sessionId = childId
              throw error
            }
            // The route resolves but the account cannot serve it (no credits, quota, billing, revoked key).
            if (/no credits|credit|billing|quota|insufficient|payment|suspend|unauthorized|invalid api key/i.test(detail)) {
              const error = new Error(`${role}: ${route.provider}/${model} rejected the request — ${detail}`)
              error.code = 'PROVIDER_UNUSABLE'
              error.route = `${route.provider}/${model}`
              error.sessionId = childId
              error.detail = detail
              throw error
            }
          }
          return {
            sessionId: String(activation.childId || childId),
            route: `${route.provider}/${model}`,
            stopReason: result.stopReason,
            structured: result.structured,
            output: (result.output || []).filter(v => v.type === 'text').map(v => v.text).join('\n').slice(0, 6000),
          }
        } finally {
          try { await activation?.dispose() } finally {
            phasePresentations.get(childId)?.()
            phasePresentations.delete(childId)
            phaseChildren.delete(childId)
          }
        }
      }
      let result
      try {
        const shell = (command, description) => ctx.tools.execute({
          callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token,
          name: 'ops_bash', agent: parent, signal: signal,
          arguments: { command, description, ...(args.checkWorkdir ? { workdir: args.checkWorkdir } : {}) },
        })
        // Workspace facts the read-only reviewer cannot obtain itself (new files, commits, diff scope).
        const collect = async () => {
          const ph = run.phase('facts', 'git · 本地')
          try {
            const r = await shell('git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "NOT_A_GIT_REPOSITORY"; exit 0; }; echo "## git status --porcelain -uall"; git status --porcelain=v1 -uall; echo "## git diff --stat HEAD"; git diff --stat HEAD; echo "## HEAD"; git log -1 --format="%h %s"', 'Collect workspace facts for independent review')
            const out = String(r?.value?.stdout || '').trim()
            ph.end('done', out === 'NOT_A_GIT_REPOSITORY' ? '非 Git 仓库' : '')
            return out === 'NOT_A_GIT_REPOSITORY' ? '工作目录不是 Git 仓库：总控无法提供变更清单。' : out
          } catch (error) {
            ph.end('failed', error?.message)
            throw error
          }
        }
        result = await runPipeline({ task: args.task, mode: args.mode || 'auto', maxRepairs: config.maxRepairs ?? 1, escalation: args.escalation || 'none' }, call, async ({ review }) => {
          const command = args.checkCommand || 'git diff --check'
          const ph = run.phase('check', `${command} · 本地`)
          let inspected = false
          try { inspected = reviewObserved((await ctx.sessionQuery.readSession(review.sessionId)).events) } catch { /* fail closed */ }
          if (!inspected) { ph.end('failed', '复核者没有成功读取文件'); return { passed: false, findings: ['No successful read in the independent reviewer session.'] } }
          try {
            const check = await shell(command, 'Independently check code task result')
            const value = check.value
            if (!check.isError && value?.status === 'completed' && value?.exitCode === 0) {
              ph.end('done', '退出码 0')
              return { passed: true, checks: ['Independent reviewer read a file', `${command} exited 0 in ${args.checkWorkdir || 'session directory'}`] }
            }
            // Only an explicit user test command that ran and failed feeds back into bounded repair.
            if (args.checkCommand && Number.isInteger(value?.exitCode) && value.exitCode !== 0) {
              ph.end('rejected', `退出码 ${value.exitCode}`)
              const tail = String(value.stdout || '').slice(-1500) + String(value.stderr || '').slice(-500)
              return { passed: false, failureKind: 'test_failed', findings: [`${args.checkCommand} exited ${value.exitCode}`, tail] }
            }
            ph.end('failed', Number.isInteger(value?.exitCode) ? `退出码 ${value.exitCode}` : '未得到退出码')
          } catch (error) { ph.end('failed', error?.message) }
          return { passed: false, findings: ['Independent check did not return a successful exit code.'] }
        }, collect)
      } catch (error) {
        if (error?.code === 'MISSING_CREDENTIAL') {
          result = {
            status: 'needs_configuration', route: error.route, sessionId: error.sessionId,
            reason: 'Configure this provider credential in DSH Models settings; no code completion was verified.',
          }
        } else {
          try { ctx.logger?.warn?.(`code-pipeline halted: ${error instanceof Error ? error.message : 'unknown error'}`) } catch { /* logger not injected */ }
          result = error?.code === 'PROVIDER_UNUSABLE'
            ? {
                status: 'provider_unusable', route: error.route, sessionId: error.sessionId,
                reason: '这一路线路的账号当前无法提供请求（余额、配额或密钥问题）；没有任何代码结果被验证。',
                detail: String(error.detail || error.message || '').slice(0, 240),
              }
            : { status: 'halted', reason: 'A phase failed or its model route is unavailable; no completion was verified.', detail: String(error?.message || 'unknown').slice(0, 240) }
        }
      } finally {
        run.finish(result)
      }
      return result
    },
  }), 'code-pipeline.tool')
}
