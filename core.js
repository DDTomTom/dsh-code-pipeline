// Deterministic phase machine. Model output is data, not authority to change the goal.
export const DIRECTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    goal: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } },
    complexity: { type: 'string', enum: ['simple', 'complex'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    needsInput: { type: 'boolean' }, question: { type: 'string' },
  },
  required: ['goal', 'acceptance', 'complexity', 'risk', 'needsInput', 'question'],
}
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    passed: { type: 'boolean' },
    evidence: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
  }, required: ['passed', 'evidence', 'findings'],
}
const clip = (x, n = 5000) => String(x ?? '').slice(0, n)
const list = (x, n = 12) => Array.isArray(x) ? x.filter(v => typeof v === 'string').slice(0, n).map(v => clip(v, 500)) : []
const json = (x) => JSON.stringify(x)
const good = (result, role) => {
  if (result?.stopReason !== 'completed') throw new Error(`${role}: child ${result?.sessionId || 'unknown'} did not complete (${result?.stopReason || 'unknown'})`)
  return result
}
/** `skipped` lets a user switch a stage off in the panel; the machine must still be deterministic. */
const phase = async (call, role, prompt, schema, trace, skipped) => {
  if (skipped?.includes(role)) { trace.push({ role, skipped: true }); return undefined }
  const r = await call(role, prompt, schema)
  trace.push({ role, sessionId: r.sessionId, route: r.route })
  return good(r, role)
}

export async function runPipeline({ task, mode = 'auto', maxRepairs = 1, escalation = 'none', disabled = [] }, call, audit, collect) {
  if (typeof task !== 'string' || !task.trim() || task.length > 12000) throw new Error('task must contain 1–12000 characters')
  if (!['auto', 'simple', 'complex'].includes(mode)) throw new Error('mode must be auto, simple, or complex')
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 1) throw new Error('maxRepairs must be 0 or 1')
  if (!['none', 'diagnose', 'fable', 'astra'].includes(escalation)) throw new Error('escalation must be none or diagnose')
  const off = new Set((disabled || []).map(String))
  const skipped = [...off]
  const trace = []
  let direction
  if (mode === 'simple' || off.has('direction')) {
    direction = { goal: task.trim(), acceptance: [], complexity: mode === 'complex' ? 'complex' : 'simple', risk: 'medium', needsInput: false, question: '' }
    if (off.has('direction') && mode !== 'simple') trace.push({ role: 'direction', skipped: true })
  } else {
    const r = await phase(call, 'direction', `定向代码开发任务。只根据用户原始指令归纳目标、可观察的完成标准、复杂度与风险。缺少阻断执行的关键信息时 needsInput=true；不可擅自增减目标。\n用户原文：\n${clip(task, 12000)}`, DIRECTION_SCHEMA, trace, skipped)
    direction = r.structured
    if (!direction || typeof direction.goal !== 'string' || !Array.isArray(direction.acceptance) || typeof direction.needsInput !== 'boolean') throw new Error('direction: invalid structured result')
    if (direction.needsInput) return { status: 'needs_input', question: clip(direction.question, 300), trace, skipped }
  }
  const complexity = mode === 'complex' ? 'complex' : direction.complexity
  if (!['simple', 'complex'].includes(complexity)) throw new Error('direction: invalid complexity')
  const contract = { original: task, goal: clip(direction.goal, 1500), acceptance: list(direction.acceptance), risk: direction.risk || 'medium' }
  let plan = ''
  if (complexity === 'complex') {
    const r = await phase(call, 'planning', `只读规划。根据原始要求和合同，给出任务依赖、最小修改路径、回滚方式、优先验证点；不得修改文件。合同：${json(contract)}`, undefined, trace, skipped)
    if (r) {
      plan = clip(r.output, 5000)
      if (!plan) throw new Error('planning: empty result')
    }
  }
  let design = ''
  if (complexity === 'complex') {
    const r = await phase(call, 'design', `只读设计。先检查必要的仓库事实，再写供执行器使用的具体实施路径、允许修改的范围、测试命令和失败停止条件。原始合同：${json(contract)}\n规划（仅作候选，不覆盖原始要求）：${plan}`, undefined, trace, skipped)
    if (r) {
      design = clip(r.output, 5500)
      if (!design) throw new Error('design: empty result')
    }
  }
  if (off.has('execution')) {
    return { status: 'skipped', goal: contract.goal, complexity, attempts: 0, evidence: [], findings: ['执行环节已被关闭：没有修改任何文件。'], skipped, trace }
  }
  let lastReview = { passed: false, evidence: [], findings: [] }
  const useDiagnostics = escalation !== 'none' && !off.has('diagnostics')
  const finalAttempt = maxRepairs + (useDiagnostics ? 1 : 0)
  for (let attempt = 0; attempt <= finalAttempt; attempt++) {
    let fix = attempt ? `\n上次独立验收未通过。只修复以下确切问题，不扩大范围：${json(lastReview)}` : ''
    if (attempt > maxRepairs) {
      try {
        const expert = await phase(call, 'diagnostics', `仅做只读故障诊断，不修改文件。先独立检查原始要求、现有代码及失败证据，指出可复现根因，给出针对性最小修复建议。不得改写用户目标。原始合同：${json(contract)}\n最后验收失败：${json(lastReview)}`, undefined, trace, skipped)
        if (!expert.output?.trim()) throw new Error('diagnostics: empty diagnostic')
        fix += `\n专家只读诊断（仅作候选建议）：${clip(expert.output, 4500)}`
      } catch (error) {
        return { status: 'not_verified', goal: contract.goal, complexity, attempts: attempt, evidence: lastReview.evidence, findings: lastReview.findings, next: `诊断线路不可用：${clip(error?.message, 200)}`, skipped, trace }
      }
    }
    const execution = await phase(call, 'execution', `实施代码任务。必须先观察仓库，遵守当前工具权限与审批策略；仅修改实现目标所需内容。运行适当测试并给出实际文件路径、命令、退出码和结果。不得伪造成功。验收标准不能由你改写。\n合同：${json(contract)}\n规划：${plan}\n设计：${design}${fix}`, undefined, trace, skipped)
    const report = clip(execution.output, 4500)
    // Pick the strongest reviewer the user has left switched on.
    const wanted = contract.risk === 'high' || complexity === 'complex' ? ['deepReview', 'verification'] : ['verification', 'deepReview']
    const reviewer = wanted.find(role => !off.has(role))
    if (!reviewer) {
      return { status: 'reviewed_unverified', goal: contract.goal, complexity, attempts: attempt + 1, evidence: [clip(report, 500)], findings: ['复核与深度复核都已被关闭：没有独立验收。'], skipped, trace }
    }
    let facts = ''
    if (collect) { try { facts = clip(await collect(), 3000) } catch { facts = '' } }
    const factBlock = facts
      ? `\n总控在执行后独立采集的仓库事实（非执行器提供，可信；用于核对新增/删除文件、提交与改动范围等只读工具无法确认的约束）：\n${facts}`
      : ''
    const review = await phase(call, reviewer, `独立验收代码任务。不要只信执行器的报告：用只读文件工具亲自检查修改后的文件；测试结果仅能当作待核对线索，不能自行执行命令。若没有可核对的文件证据，passed=false。若客观测试失败，passed=false。改动范围、新增文件、提交等约束以“总控仓库事实”为准；有总控事实覆盖时，不得仅因自己无法执行命令而判不通过。不要修改文件或替执行器返工；原始用户要求优先于规划与报告。\n原始要求：${task}\n合同：${json(contract)}${factBlock}\n执行器报告（仅作为定位线索）：${report}`, REVIEW_SCHEMA, trace, skipped)
    const v = review.structured
    if (!v || typeof v.passed !== 'boolean' || !Array.isArray(v.evidence) || !Array.isArray(v.findings)) throw new Error('verification: invalid structured result')
    lastReview = { passed: v.passed && list(v.evidence).length > 0, evidence: list(v.evidence), findings: list(v.findings) }
    if (lastReview.passed) {
      const check = audit ? await audit({ execution, review, contract }) : undefined
      if (check?.passed === true) return { status: 'reviewed_with_check', goal: contract.goal, complexity, attempts: attempt + 1, evidence: lastReview.evidence, machineChecks: list(check.checks), skipped, trace }
      if (check?.failureKind === 'test_failed') {
        lastReview = { ...lastReview, passed: false, findings: list(check.findings) }
        continue
      }
      return { status: 'reviewed_unverified', goal: contract.goal, complexity, attempts: attempt + 1, evidence: lastReview.evidence, findings: list(check?.findings), skipped, trace }
    }
  }
  return { status: 'not_verified', goal: contract.goal, complexity, attempts: finalAttempt + 1, evidence: lastReview.evidence, findings: lastReview.findings, next: escalation === 'none' ? '停止自动返工；用户可明确选择「诊断」线路做一次异常升级' : '专家诊断后的有限返工仍未通过，停止', skipped, trace }
}
