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
  facts: '采集仓库事实',
  check: '独立检查',
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
    }
    runs.unshift(run)
    while (runs.length > MAX_RUNS) runs.pop()
    touch()

    const api = {
      id: run.id,
      phase(role, route) {
        if (role === 'execution') run.attempt = run.phases.filter(p => p.role === 'execution').length + 1
        const entry = { role, label: ROLE_LABELS[role] || role, route: route || '', status: 'running', startedAt: now(), endedAt: undefined, note: '' }
        run.phases.push(entry)
        touch()
        return {
          route(value) { entry.route = value; touch() },
          end(status = 'done', note = '') {
            if (entry.status !== 'running') return
            entry.status = status
            entry.note = clip(note, 200)
            entry.endedAt = now()
            touch()
          },
        }
      },
      finish(result) {
        for (const p of run.phases) if (p.status === 'running') { p.status = 'failed'; p.endedAt = now() }
        run.status = typeof result?.status === 'string' ? result.status : 'halted'
        run.summary = clip(result?.question || result?.detail || result?.findings?.[0] || result?.reason || result?.next || '', 240)
        run.endedAt = now()
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
  const core = (routeChecks || []).filter(r => !r.role.startsWith('emergency'))
  const emergency = (routeChecks || []).filter(r => r.role.startsWith('emergency'))
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
