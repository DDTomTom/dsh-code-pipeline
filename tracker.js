// Live progress of code_pipeline runs, served to the floating panel.
// Plain in-memory state: it describes what is running in this Host process right now
// (the durable record of every phase stays in the DSH child-session logs).

export const ROLE_LABELS = {
  direction: '定向',
  planning: '规划',
  design: '设计',
  execution: '执行',
  verification: '复核',
  deepReview: '深度复核',
  emergencyFable: 'Fable 诊断',
  emergencyAstra: 'Astra 诊断',
  diagnostics: '诊断',
  facts: '采集仓库事实',
  check: '独立检查',
  summarize: '总结',
}

const MAX_RUNS = 6
const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function createTracker(now = () => Date.now()) {
  const runs = []
  let revision = 0
  const touch = () => { revision++ }

  function startRun({ sessionId, task, mode, escalation }) {
    const run = {
      id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: String(sessionId ?? ''),
      task: clip(task, 160),
      mode: mode || 'auto',
      escalation: escalation || 'none',
      status: 'running',
      startedAt: now(),
      endedAt: undefined,
      attempt: 1,
      phases: [],
      summary: '',
      /** Set while the run waits for the user's answer about the time limit. */
      waiting: null,
      timeout: { minutes: 0, extended: 0 },
    }
    runs.unshift(run)
    while (runs.length > MAX_RUNS) runs.pop()
    touch()

    const api = {
      id: run.id,
      phase(role, route) {
        if (role === 'execution') run.attempt = run.phases.filter(p => p.role === 'execution').length + 1
        const entry = { role, label: ROLE_LABELS[role] || role, route: route || '', status: 'running', startedAt: now(), endedAt: undefined, note: '', detail: '', live: null }
        run.phases.push(entry)
        touch()
        return {
          route(value) { entry.route = value; touch() },
          /** What the phase is doing right now (thinking text or tool call); cleared on end. */
          live(snapshot) {
            if (entry.status !== 'running') return
            entry.live = snapshot
              ? { kind: snapshot.kind || 'thinking', tool: clip(snapshot.tool, 40), text: clip(snapshot.text, 320), at: now() }
              : null
            touch()
          },
          end(status = 'done', note = '', detail = '') {
            if (entry.status !== 'running') return
            entry.status = status
            entry.note = clip(note, 200)
            entry.detail = clip(detail, 2400)
            entry.live = null
            entry.endedAt = now()
            touch()
          },
        }
      },
      finish(result) {
        for (const p of run.phases) if (p.status === 'running') { p.status = 'failed'; p.live = null; p.endedAt = now() }
        run.status = typeof result?.status === 'string' ? result.status : 'halted'
        run.summary = clip(result?.question || result?.detail || result?.findings?.[0] || result?.reason || result?.next || '', 240)
        run.waiting = null
        run.endedAt = now()
        touch()
      },
      /** Ask the user whether to keep going: the run pauses and the panel shows a prompt. */
      waiting(info) {
        run.status = 'waiting'
        run.waiting = {
          minutes: Number(info?.minutes) || 0,
          nextMinutes: Number(info?.nextMinutes) || 0,
          deadlineAt: Number(info?.deadlineAt) || 0,
          askedAt: now(),
          note: clip(info?.note, 160),
        }
        touch()
      },
      /** Leave the waiting state and continue (user answer or the default choice). */
      resume(answer = 'continue') {
        run.waiting = null
        if (run.status === 'waiting') run.status = 'running'
        run.timeout = { ...(run.timeout || {}), extended: (run.timeout?.extended || 0) + 1, answer }
        touch()
      },
      timeout(info) {
        run.timeout = { ...(run.timeout || {}), ...info }
        touch()
      },
    }
    return api
  }

  return {
    startRun,
    snapshot: () => ({ revision, now: now(), runs: JSON.parse(JSON.stringify(runs)) }),
    get revision() { return revision },
  }
}

/** Overall health from independently checked facts; `issues` explains anything not green. */
export function assessHealth({ toolRegistered, routeChecks, checkedAt, lastRun }) {
  const issues = []
  if (!toolRegistered) issues.push('code_pipeline 工具未注册')
  const core = (routeChecks || []).filter(r => !r.role.startsWith('emergency') && r.role !== 'diagnostics')
  const emergency = (routeChecks || []).filter(r => r.role.startsWith('emergency') || r.role === 'diagnostics')
  for (const r of core) if (!r.ok) issues.push(`${ROLE_LABELS[r.role] || r.role} 线路不可用：${r.error}`)
  const warnings = emergency.filter(r => !r.ok).map(r => `${ROLE_LABELS[r.role] || r.role} 线路不可用：${r.error}`)
  // A resolved route only proves the model exists in the catalog; the account may still refuse to serve it.
  if (lastRun?.status === 'provider_unusable') issues.push(`上次运行被拒：${lastRun.route || '线路'} — ${lastRun.summary || '账号无法提供请求'}`)
  else if (lastRun?.status === 'needs_configuration') issues.push(`上次运行缺少凭据：${lastRun.route || '线路'}`)
  else if (lastRun?.status === 'halted') warnings.push(`上次运行中断：${lastRun.summary || '原因未知'}`)
  const level = issues.length ? 'error' : warnings.length ? 'warn' : checkedAt ? 'ok' : 'unknown'
  const checkedLabel = lastRun && lastRun.status !== 'running'
    ? (lastRun.status === 'reviewed_with_check' ? `最近一次运行成功（${new Date(lastRun.endedAt).toLocaleTimeString()}）`
      : `最近一次运行结论：${lastRun.status}（${new Date(lastRun.endedAt).toLocaleTimeString()}）`)
    : undefined
  return { level, issues, warnings, checkedAt, routes: routeChecks || [], lastRun: checkedLabel }
}
