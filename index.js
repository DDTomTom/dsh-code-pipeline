import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runPipeline } from './core.js'
import { assessHealth, createTracker } from './tracker.js'
import { createHistoryStore, historyDigest } from './history.js'
import { applyRoutePatch, loadRouteOverrides, mergeAllRoutes, mergeRoutes, roleLabel, saveRouteOverrides, STAGE_ROLES } from './settings.js'
import { createLiveBuffer, liveSnapshot, reduceLive, resetLive } from './live.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const MAX_SESSION_MODES = 500
export const MODES = ['off', 'auto', 'always']
/** manual is not on the panel slider; it stays reachable through /pipeline for pending-start sessions. */
const ALL_MODES = [...MODES, 'manual']

/** Per-session pipeline mode, persisted so a restart keeps the user's choice. */
export function createModeStore(file) {
  const modes = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    for (const [id, mode] of Object.entries(raw?.sessions || {})) if (ALL_MODES.includes(mode)) modes.set(id, mode)
  } catch { /* first use or unreadable: start empty */ }
  const write = () => {
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
      if (!ALL_MODES.includes(mode)) return
      modes.delete(String(id))
      modes.set(String(id), mode)
      while (modes.size > MAX_SESSION_MODES) modes.delete(modes.keys().next().value)
      write()
    },
  }
}

/** Profile-wide default mode used by every session that has no /pipeline override. */
export function createDefaultMode(file, fallback = 'auto') {
  let current = ALL_MODES.includes(fallback) ? fallback : 'auto'
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (ALL_MODES.includes(raw?.mode)) current = raw.mode
  } catch { /* first use: keep the configured default */ }
  return {
    get: () => current,
    set(mode) {
      if (!MODES.includes(mode) || mode === current) return current === mode ? true : false
      current = mode
      try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify({ mode: current }, null, 2)}\n`)
        renameSync(tmp, file)
      } catch { /* the in-memory choice still applies */ }
      return true
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
  let routeState = loadRouteOverrides(routesFile)
  let routes = mergeRoutes(baseRoutes, routeState.routes, routeState.disabled)
  const backend = config.backend || 'spawn'
  // A run keeps working while it waits for the user's answer, so the tool itself only carries a
  // hard stop far beyond the interactive limits; the real pacing lives in the run's own gate.
  const firstMinutes = Number.isFinite(Number(config.timeoutMinutes)) && Number(config.timeoutMinutes) > 0 ? Number(config.timeoutMinutes) : 20
  const nextMinutes = Number.isFinite(Number(config.nextTimeoutMinutes)) && Number(config.nextTimeoutMinutes) > 0 ? Number(config.nextTimeoutMinutes) : 120
  const askWindowMs = Number.isFinite(Number(config.askWindowMinutes)) && Number(config.askWindowMinutes) > 0 ? Number(config.askWindowMinutes) * 60000 : 180000
  const toolTimeoutMs = Math.round((firstMinutes + nextMinutes * 4 + 20) * 60000)
  // config.startMode has always meant "what a fresh session does"; a manual default becomes 'auto + pending start'.
  const startMode = config.startMode === 'manual' ? 'manual' : 'auto'
  const modeStore = createModeStore(config.stateFile || join(DSH_HOME, 'code-pipeline', 'session-modes.json'))
  const defaultMode = createDefaultMode(
    config.modeFile || join(DSH_HOME, 'code-pipeline', 'default-mode.json'),
    startMode === 'manual' ? 'auto' : startMode,
  )
  const pendingStart = startMode === 'manual'
  const modeFor = id => modeStore.get(id) || defaultMode.get()
  const pluginAbort = new AbortController()
  ctx.effect(() => () => pluginAbort.abort(), 'code-pipeline.cancel-on-unload')

  // ---- live progress + health for the floating panel ------------------------------
  const tracker = createTracker()
  /** runId → { stop(), resume(), isStopped() }: the panel's 终止 / 继续 buttons drive a run. */
  const runControls = new Map()
  // childId -> { ph, buf, lastPush }: the running phase's assistant stream, throttled for the panel.
  const liveChildren = new Map()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const entry = liveChildren.get(String(agent?.id ?? ''))
    if (!entry) return
    if (frame?.type === 'start') { resetLive(entry.buf); return }
    if (frame?.type !== 'chunk') return
    if (!reduceLive(entry.buf, frame.chunk)) return
    const at = Date.now()
    // Thinking text arrives token by token; the panel polls once a second, so 250ms is plenty.
    if (entry.buf.kind !== 'tool' && at - entry.lastPush < 250) return
    entry.lastPush = at
    entry.ph.live(liveSnapshot(entry.buf))
  })
  const history = createHistoryStore(config.historyFile || join(DSH_HOME, 'code-pipeline', 'history.json'))
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
  const stateView = () => ({
    ...tracker.snapshot(),
    health: healthView(),
    mode: { default: defaultMode.get() },
    history: historyDigest(history.list()),
    limits: { firstMinutes, nextMinutes, askWindowMs },
  })
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
  // A lookup that fails once (credentials not loaded yet, adapter still mounting after a plugin
  // reload) must not freeze the row for the rest of the session: only successful, non-empty answers
  // are cached for long, empty ones expire in a few seconds so the next open retries.
  const EFFORT_OK_TTL = 10 * 60 * 1000
  const EFFORT_EMPTY_TTL = 4000
  const effortsOf = async (provider, model) => {
    const key = `${provider}/${model}`
    const hit = effortsCache.get(key)
    const ttl = hit && hit.efforts.length ? EFFORT_OK_TTL : EFFORT_EMPTY_TTL
    if (hit && Date.now() - hit.at < ttl) return hit.efforts
    let efforts = []
    let error = ''
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, pluginAbort.signal)
      efforts = (info?.reasoning?.efforts || []).map(e => ({ id: String(e.id), name: e.name || String(e.id), ...(e.description ? { description: e.description } : {}) }))
      efforts.default = info?.reasoning?.defaultEffort ? String(info.reasoning.defaultEffort) : undefined
      if (!efforts.length) error = 'adapter reports no reasoning efforts for this model'
    } catch (e) {
      error = String((e && e.message) || e)
    }
    effortsCache.set(key, { at: Date.now(), efforts, error })
    return efforts
  }
  const effortsErrorOf = (provider, model) => effortsCache.get(`${provider}/${model}`)?.error || ''
  const settingsView = async () => {
    const cat = await loadCatalog()
    const configured = mergeAllRoutes(baseRoutes, routeState.routes)
    const off = new Set(routeState.disabled)
    const roles = []
    for (const role of STAGE_ROLES) {
      const route = configured[role]
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
        enabled: !off.has(role),
        effort: route.effort || '', efforts: [...efforts],
        defaultEffort: efforts.default || '',
        effortsError: effortsErrorOf(route.provider, model),
      })
    }
    return { roles, providers: cat.providers, models: cat.models, limits: { firstMinutes, nextMinutes, askWindowMs } }
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
      patch, routes: routeState.routes, disabled: routeState.disabled, providers,
      modelsOf: provider => (cat.models[provider] || []).map(m => m.id),
      // Effort strings are validated below with the async capability lookup.
    })
    if (!checked.ok) return { ok: false, reason: checked.reason }
    for (const item of patch) {
      if (item?.enabled === false) continue
      const effort = item.effort ? String(item.effort) : ''
      if (!effort) continue
      const supported = await effortsOf(String(item.provider), String(item.model))
      // An adapter that reports no efforts tells us nothing to validate against; rejecting the save
      // there would lock the whole panel just because one provider's capabilities did not resolve.
      if (supported.length && !supported.some(e => e.id === effort)) return { ok: false, reason: `${item.model} 不支持推理等级 ${effort}` }
    }
    routeState = { routes: checked.routes, disabled: checked.disabled }
    saveRouteOverrides(routesFile, routeState)
    routes = mergeRoutes(baseRoutes, routeState.routes, routeState.disabled)
    routeCheckedAt = 0
    return { ok: true, settings: await settingsView() }
  }
  // ---- plain-language summary of one run (panel button) ----------------------------
  const summarizeRun = async run => {
    const route = routes.summarize || routes.direction
    if (!route?.provider || !route?.model) throw new Error('summarize route is not configured')
    const model = await resolveRoute(ctx.llm, 'summarize', route, pluginAbort.signal)
    const steps = run.phases.map(p => `- ${roleLabel(p.role)}：${p.status}${p.note ? `（${p.note}）` : ''}`).join('\n')
    const details = run.phases.filter(p => p.detail)
      .map(p => `【${roleLabel(p.role)}】\n${p.detail}`).join('\n\n').slice(0, 4000)
    const prompt = [
      '把这次代码任务翻译成大白话，读者完全不懂编程。要求：',
      '1. 两三句话，最多 120 个汉字；',
      '2. 先说结果（做好了 / 没做好），没做好就说卡在哪、需要人做什么；',
      '3. 不要出现模型名、文件名、命令、英文单词、括号注释；',
      '4. 不要客套话，不要分点，直接说人话。',
      '',
      `任务：${run.task}`,
      `结论：${run.status}`,
      run.summary ? `备注：${run.summary}` : '',
      `步骤：\n${steps}`,
      details ? `供你理解的细节：\n${details}` : '',
    ].filter(Boolean).join('\n')
    const chunks = ctx.llm.stream({
      provider: route.provider, model,
      ...(route.effort ? { reasoningEffort: route.effort } : {}),
      system: '你负责把技术结果讲给不懂电脑的人听，只说人话。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: pluginAbort.signal,
    })
    let out = ''
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') out += chunk.text
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message || 'summary failed')
    }
    const text = out.trim()
    if (!text) throw new Error('the summarize model returned no text')
    return text
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
          if (pathname === '/dsh-code-pipeline/mode' && req.method === 'POST') {
            try {
              const body = await readJsonBody(req)
              if (!MODES.includes(body?.mode)) return json(400, { ok: false, reason: `mode must be one of ${MODES.join('/')}` })
              defaultMode.set(body.mode)
              return json(200, { ok: true, ...stateView() })
            } catch (error) { return json(400, { ok: false, reason: String(error?.message || error).slice(0, 200) }) }
          }
          if (pathname === '/dsh-code-pipeline/summarize' && req.method === 'POST') {
            try {
              const body = await readJsonBody(req)
              const run = body?.runId ? history.get(String(body.runId)) : tracker.snapshot().runs[0]
              if (!run) return json(404, { ok: false, reason: 'no run to summarize' })
              const text = await summarizeRun(run)
              return json(200, { ok: true, runId: run.id, text })
            } catch (error) {
              return json(400, { ok: false, reason: String(error?.message || error).slice(0, 240) })
            }
          }
          if (pathname === '/dsh-code-pipeline/history' && req.method === 'GET') {
            const id = new URL(String(req.url || '/'), 'http://local').searchParams.get('id')
            if (id) {
              const run = history.get(id)
              return run ? json(200, run) : json(404, { error: 'no such run' })
            }
            return json(200, { runs: historyDigest(history.list()) })
          }
          if (pathname === '/dsh-code-pipeline/history/clear' && req.method === 'POST') {
            const before = history.size
            history.clear()
            return json(200, { ok: true, cleared: before })
          }
          if ((pathname === '/dsh-code-pipeline/stop' || pathname === '/dsh-code-pipeline/continue') && req.method === 'POST') {
            let body = {}
            try { body = await readJsonBody(req) } catch { body = {} }
            const run = body?.runId
              ? tracker.snapshot().runs.find(r => r.id === String(body.runId))
              : tracker.snapshot().runs.find(r => r.status === 'running' || r.status === 'waiting')
            if (!run) return json(404, { ok: false, reason: 'no active run' })
            const control = runControls.get(run.id)
            if (!control) return json(409, { ok: false, reason: 'run is not controllable anymore' })
            if (pathname.endsWith('/stop')) control.stop()
            else control.resume('continue')
            return json(200, { ok: true, runId: run.id, ...stateView() })
          }
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
      const mode = modeFor(agent?.id)
      if (mode === 'off') return ''
      if (mode === 'always') {
        return 'This session runs every user turn through code_pipeline: call it exactly once per user turn, including questions, tiny edits and follow-ups, instead of answering directly. Never use it recursively; if it reports needs_input, ask only that question; if not_verified or reviewed_unverified, do not report full verification. The stage tool does not override existing approval or sandbox policies.'
      }
      const trigger = mode === 'manual' || pendingStart && !modeStore.get(agent?.id)
        ? 'Pending-start mode: only call code_pipeline after the user explicitly says to start implementing (for example 开始/执行/动手); until then discuss and refine the plan without edits.'
        : 'For a user request to IMPLEMENT or FIX code, use code_pipeline once as the default execution path.'
      return `${trigger} For discussion, explanation, research or code review without requested edits, do not call it. Never use it recursively; if it reports needs_input, ask only that question; if not_verified or reviewed_unverified, do not report full verification. The stage tool does not override existing approval or sandbox policies.`
    },
  }), 'code-pipeline.routing')

  // `/pipeline` is a human command: switching mode or probing routes costs no model tokens.
  const usage = '用法：/pipeline off | auto | always | manual | status | routes'
  const modeLabel = mode => ({ off: '关闭', auto: '自动判断', always: '每次都用', manual: '待启动' })[mode] || mode
  const pipelineCommand = {
    name: 'pipeline',
    description: '复合代码流水线：切换本会话的 关闭/自动/总是/待启动 模式，或检查各阶段模型线路',
    input: { hint: 'off | auto | always | manual | status | routes' },
    handler: async invocation => {
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
      const id = invocation?.agent?.id
      if (['off', 'auto', 'always', 'manual'].includes(arg)) {
        if (id === undefined) return { kind: 'error', text: '无法识别当前会话，模式未切换。' }
        modeStore.set(id, arg)
        const note = {
          off: '本会话：关闭（不再提示调用流水线）。',
          auto: '本会话：自动判断（收到实现/修复指令才启动）。',
          always: '本会话：每次都用（每一轮都走流水线，包括提问）。',
          manual: '本会话：待启动（讨论阶段不改文件，你明确说开始后才启动）。',
        }[arg]
        return { kind: 'success', text: note }
      }
      if (arg === '' || arg === 'status') {
        const mode = id === undefined ? defaultMode.get() : modeFor(id)
        return { kind: 'success', text: `本会话：${modeLabel(mode)}（全局默认 ${modeLabel(defaultMode.get())}）。${usage}` }
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
        escalation: { type: 'string', enum: ['none', 'diagnose', 'fable', 'astra'], description: 'Exceptional read-only diagnosis (the panel\'s 诊断 stage, any model you pick there) after normal repair fails, then one final repair and independent review. Default none; fable/astra are accepted as legacy aliases for diagnose.' },
      },
      required: ['task'],
    },
    ...(toolTimeoutMs ? { timeoutMs: toolTimeoutMs } : {}),
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
      // ---- time limits: ask, extend, or stop -------------------------------------
      // 20 minutes, then a prompt; answer or 3 minutes of silence continues for 120 minutes; a
      // second prompt, same silence rule; after that the run is no longer asked again.
      const stopController = new AbortController()
      const runSignal = AbortSignal.any([signal, stopController.signal])
      const control = {
        stopped: false,
        resume: null,
        stop() {
          control.stopped = true
          const wake = control.resume
          control.resume = null
          try { stopController.abort() } catch { /* already aborted */ }
          if (wake) wake('stop')
        },
        answer() {
          const wake = control.resume
          control.resume = null
          if (wake) wake('continue')
        },
      }
      runControls.set(run.id, control)
      let deadline = Date.now() + firstMinutes * 60000
      let asked = 0
      const askToContinue = async (reason) => {
        if (control.stopped) return
        if (asked >= 2 || Date.now() < deadline) return
        asked++
        const segment = asked === 1 ? firstMinutes : nextMinutes
        const nextSegment = asked === 1 ? nextMinutes : 0
        const until = Date.now() + askWindowMs
        run.waiting({ minutes: segment, nextMinutes: nextSegment, deadlineAt: until, note: reason })
        const answer = await new Promise(resolve => {
          let settled = false
          const done = value => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            control.resume = null
            resolve(value)
          }
          const timer = setTimeout(() => done('continue'), Math.max(0, until - Date.now()))
          control.resume = done
        })
        run.resume(answer)
        if (answer === 'stop' || control.stopped) return
        deadline = nextSegment > 0 ? Date.now() + nextSegment * 60000 : Number.POSITIVE_INFINITY
      }
      const gate = async (reason) => {
        if (control.stopped) throw Object.assign(new Error('用户已终止本次运行'), { code: 'STOPPED' })
        await askToContinue(reason)
        if (control.stopped) throw Object.assign(new Error('用户已终止本次运行'), { code: 'STOPPED' })
      }
      // What a phase concluded, so the panel can show it when the user clicks that step.
      const summarize = r => {
        const parts = []
        const s = r?.structured
        if (s && typeof s === 'object') {
          if (typeof s.goal === 'string' && s.goal) parts.push(`目标\n${s.goal}`)
          if (Array.isArray(s.acceptance) && s.acceptance.length) parts.push(`完成标准\n${s.acceptance.join('\n')}`)
          if (Array.isArray(s.evidence) && s.evidence.length) parts.push(`证据\n${s.evidence.join('\n')}`)
          if (Array.isArray(s.findings) && s.findings.length) parts.push(`发现\n${s.findings.join('\n')}`)
          if (typeof s.question === 'string' && s.question) parts.push(`需要确认\n${s.question}`)
        }
        if (r?.output) parts.push(r.output)
        return parts.join('\n\n')
      }
      const call = async (role, prompt, outputSchema) => {
        await gate(roleLabel(role))
        const route = routes[role]
        const ph = run.phase(role, route ? `${route.provider}/${route.model}` : '未配置')
        try {
          const model = await resolveRoute(ctx.llm, role, route, runSignal)
          ph.route(`${route.provider}/${model}`)
          const r = await callResolved(role, route, model, prompt, outputSchema, ph)
          if (r.stopReason !== 'completed') ph.end('failed', r.stopReason, summarize(r))
          else if (r.structured?.passed === false) ph.end('rejected', '未通过', summarize(r))
          else ph.end('done', '', summarize(r))
          return r
        } catch (error) {
          ph.end('failed', error?.message)
          throw error
        }
      }
      const callResolved = async (role, route, model, prompt, outputSchema, ph) => {
        const childId = randomUUID()
        phaseChildren.set(childId, role)
        // The panel shows this child's thinking/tool stream until the phase ends.
        liveChildren.set(childId, { ph, buf: createLiveBuffer(), lastPush: 0 })
        let activation
        try {
          activation = await ctx.subagents.startActivation({
            provider: backend, label: `code:${role}`, childId, signal: runSignal,
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
            liveChildren.delete(childId)
            phasePresentations.get(childId)?.()
            phasePresentations.delete(childId)
            phaseChildren.delete(childId)
          }
        }
      }
      let result
      try {
        // ops_bash reports stdout/stderr as structured values; only their text is meaningful here.
        const textOf = value => {
          if (typeof value === 'string') return value
          if (value && typeof value === 'object') return String(value.text ?? value.content ?? '')
          return value == null ? '' : String(value)
        }
        const shell = (command, description) => ctx.tools.execute({
          callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token,
          name: 'ops_bash', agent: parent, signal: runSignal,
          arguments: { command, description, ...(args.checkWorkdir ? { workdir: args.checkWorkdir } : {}) },
        })
        // Workspace facts the read-only reviewer cannot obtain itself (new files, commits, diff scope).
        const collect = async () => {
          await gate('采集仓库事实')
          const ph = run.phase('facts', 'git · 本地')
          try {
            const r = await shell('git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "NOT_A_GIT_REPOSITORY"; exit 0; }; echo "## git status --porcelain -uall"; git status --porcelain=v1 -uall; echo "## git diff --stat HEAD"; git diff --stat HEAD; echo "## HEAD"; git log -1 --format="%h %s"', 'Collect workspace facts for independent review')
            const out = textOf(r?.value?.stdout).trim()
            ph.end('done', out === 'NOT_A_GIT_REPOSITORY' ? '非 Git 仓库' : '', out === 'NOT_A_GIT_REPOSITORY' ? '' : out)
            return out === 'NOT_A_GIT_REPOSITORY' ? '工作目录不是 Git 仓库：总控无法提供变更清单。' : out
          } catch (error) {
            ph.end('failed', error?.message)
            throw error
          }
        }
        result = await runPipeline({ task: args.task, mode: args.mode || 'auto', maxRepairs: config.maxRepairs ?? 1, escalation: args.escalation || 'none', disabled: routeState.disabled }, call, async ({ review }) => {
          await gate('独立检查')
          const command = args.checkCommand || 'git diff --check'
          const ph = run.phase('check', `${command} · 本地`)
          let inspected = false
          try { inspected = reviewObserved((await ctx.sessionQuery.readSession(review.sessionId)).events) } catch { /* fail closed */ }
          if (!inspected) { ph.end('failed', '复核者没有成功读取文件'); return { passed: false, findings: ['No successful read in the independent reviewer session.'] } }
          try {
            const check = await shell(command, 'Independently check code task result')
            const value = check.value
            const io = `${textOf(value?.stdout)}${textOf(value?.stderr)}`.trim().slice(-1200)
            if (!check.isError && value?.status === 'completed' && value?.exitCode === 0) {
              ph.end('done', '退出码 0', `$ ${command}\n${io}`)
              return { passed: true, checks: ['Independent reviewer read a file', `${command} exited 0 in ${args.checkWorkdir || 'session directory'}`] }
            }
            // Only an explicit user test command that ran and failed feeds back into bounded repair.
            if (args.checkCommand && Number.isInteger(value?.exitCode) && value.exitCode !== 0) {
              ph.end('rejected', `退出码 ${value.exitCode}`, `$ ${command}\n${io}`)
              const tail = String(value.stdout || '').slice(-1500) + String(value.stderr || '').slice(-500)
              return { passed: false, failureKind: 'test_failed', findings: [`${args.checkCommand} exited ${value.exitCode}`, tail] }
            }
            ph.end('failed', Number.isInteger(value?.exitCode) ? `退出码 ${value.exitCode}` : '未得到退出码', `$ ${command}\n${io}`)
          } catch (error) { ph.end('failed', error?.message) }
          return { passed: false, findings: ['Independent check did not return a successful exit code.'] }
        }, collect)
      } catch (error) {
        if (error?.code === 'STOPPED' || control.stopped) {
          result = { status: 'stopped', reason: '你终止了这次运行；已完成的步骤保留在面板里，未验证任何结果。' }
        } else if (error?.code === 'MISSING_CREDENTIAL') {
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
        runControls.delete(run.id)
        run.finish(result)
        // Archive the finished run so the panel can still show it after the next run or a restart.
        try { history.add(tracker.snapshot().runs[0]) } catch { /* history is best effort */ }
      }
      return result
    },
  }), 'code-pipeline.tool')
}
