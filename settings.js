// Editable stage→model mapping for the pipeline, shared by the host routes and the panel UI.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ROLE_LABELS } from './tracker.js'

/** Stages shown top-to-bottom in the panel's settings view, in execution order. */
export const STAGE_ROLES = ['direction', 'planning', 'design', 'execution', 'verification', 'deepReview', 'emergencyFable', 'emergencyAstra']

export const roleLabel = role => ROLE_LABELS[role] || role

const clean = cfg => (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string')
  ? { provider: cfg.provider, model: cfg.model, ...(typeof cfg.effort === 'string' && cfg.effort ? { effort: cfg.effort } : {}) }
  : undefined

export function loadRouteOverrides(file) {
  try {
    const out = {}
    for (const [role, cfg] of Object.entries(JSON.parse(readFileSync(file, 'utf8'))?.routes || {})) {
      const entry = clean(cfg)
      if (entry && STAGE_ROLES.includes(role)) out[role] = entry
    }
    return out
  } catch { return {} }
}

export function saveRouteOverrides(file, overrides) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ routes: overrides }, null, 2)}\n`)
    renameSync(tmp, file)
    return true
  } catch { return false }
}

/** Saved overrides win field by field over the bundle config; a role absent from both is omitted. */
export function mergeRoutes(base, overrides) {
  const roles = new Set([...Object.keys(base || {}), ...Object.keys(overrides || {})])
  const out = {}
  for (const role of roles) {
    const b = base?.[role], o = overrides?.[role]
    const provider = o?.provider ?? b?.provider
    const model = o?.model ?? b?.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    const effort = o?.effort ?? b?.effort
    out[role] = { provider, model, ...(typeof effort === 'string' && effort ? { effort } : {}) }
  }
  return out
}

/**
 * Apply one panel save. `modelsOf(provider)` returns the catalog ids a provider advertises and
 * `effortsOf(provider, model)` its supported reasoning efforts, so a stale panel cannot install
 * a combination the adapters would reject later during a real run.
 */
export function applyRoutePatch({ patch, routes, providers, modelsOf, effortsOf }) {
  if (!Array.isArray(patch) || patch.length === 0) return { ok: false, reason: '没有要保存的环节' }
  const known = new Set(providers)
  const next = { ...routes }
  for (const item of patch) {
    const role = String(item?.role ?? '')
    if (!STAGE_ROLES.includes(role)) return { ok: false, reason: `未知环节：${role}` }
    const provider = String(item.provider ?? ''), model = String(item.model ?? '')
    if (!known.has(provider)) return { ok: false, reason: `未注册的提供方：${provider}` }
    if (!modelsOf(provider).includes(model)) return { ok: false, reason: `${provider} 的模型目录中没有 ${model}` }
    const efforts = typeof effortsOf === 'function' ? effortsOf(provider, model) : undefined
    const effort = item.effort ? String(item.effort) : ''
    // Effort support needs an async capability lookup, so callers that only validate the route
    // omit `effortsOf` here and check efforts themselves before applying.
    if (effort && Array.isArray(efforts) && !efforts.includes(effort)) return { ok: false, reason: `${model} 不支持推理等级 ${effort}` }
    next[role] = { provider, model, ...(effort ? { effort } : {}) }
  }
  return { ok: true, routes: next }
}
