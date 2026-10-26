// Editable stage→model mapping for the pipeline, shared by the host routes and the panel UI.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ROLE_LABELS } from './tracker.js'

/** Stages shown top-to-bottom in the panel's settings view; summarize runs on demand, not per pipeline. */
export const STAGE_ROLES = ['direction', 'planning', 'design', 'execution', 'verification', 'deepReview', 'diagnostics', 'summarize']

/** Roles the panel may still meet in an old saved file; they fold into the single diagnostics stage. */
export const LEGACY_ROLE_MAP = { emergencyFable: 'diagnostics', emergencyAstra: 'diagnostics' }

export const roleLabel = role => ROLE_LABELS[role] || role

const clean = cfg => (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string')
  ? { provider: cfg.provider, model: cfg.model, ...(typeof cfg.effort === 'string' && cfg.effort ? { effort: cfg.effort } : {}) }
  : undefined

const normalizeRole = role => (STAGE_ROLES.includes(role) ? role : LEGACY_ROLE_MAP[role])

/**
 * Saved panel state: `{ routes, disabled }` plus the legacy `{ routes }` shape written before a
 * stage could be switched off. Disabled stages keep their model but do not run.
 */
export function loadRouteOverrides(file) {
  const out = { routes: {}, disabled: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    for (const [rawRole, cfg] of Object.entries(raw?.routes || {})) {
      const role = normalizeRole(rawRole)
      const entry = clean(cfg)
      if (entry && role) out.routes[role] = entry
    }
    for (const rawRole of Array.isArray(raw?.disabled) ? raw.disabled : []) {
      const role = normalizeRole(String(rawRole))
      if (role && !out.disabled.includes(role)) out.disabled.push(role)
    }
  } catch { /* first use or unreadable: no overrides */ }
  return out
}

export function saveRouteOverrides(file, state) {
  try {
    const routes = {}
    for (const [role, cfg] of Object.entries(state?.routes || {})) {
      const entry = clean(cfg)
      if (entry && STAGE_ROLES.includes(role)) routes[role] = entry
    }
    const disabled = (Array.isArray(state?.disabled) ? state.disabled : []).filter(role => STAGE_ROLES.includes(role))
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ routes, disabled }, null, 2)}\n`)
    renameSync(tmp, file)
    return true
  } catch { return false }
}

/**
 * Resolved routes for every stage that should run: `overrides` is a plain role→route map from the
 * panel, `disabled` the roles the user switched off. A stage absent here does not run.
 */
export function mergeRoutes(base, overrides, disabled = []) {
  const off = new Set((disabled || []).map(String))
  const routes = {}
  for (const rawRole of Object.keys(base || {})) routes[rawRole] = base[rawRole]
  for (const [rawRole, cfg] of Object.entries(overrides || {})) routes[rawRole] = cfg
  const out = {}
  for (const [rawRole, cfg] of Object.entries(routes)) {
    const role = normalizeRole(rawRole) || rawRole
    const provider = cfg?.provider
    const model = cfg?.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    if (off.has(role)) continue
    const effort = cfg.effort
    out[role] = { provider, model, ...(typeof effort === 'string' && effort ? { effort } : {}) }
  }
  return out
}

/** Every stage's configured model, including switched-off ones, so the panel can still show it. */
export function mergeAllRoutes(base, overrides) {
  const routes = {}
  for (const rawRole of Object.keys(base || {})) routes[rawRole] = base[rawRole]
  for (const [rawRole, cfg] of Object.entries(overrides || {})) routes[rawRole] = cfg
  const out = {}
  for (const [rawRole, cfg] of Object.entries(routes)) {
    const role = normalizeRole(rawRole) || rawRole
    const provider = cfg?.provider
    const model = cfg?.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    const effort = cfg.effort
    out[role] = { provider, model, ...(typeof effort === 'string' && effort ? { effort } : {}) }
  }
  return out
}

/**
 * Apply one panel save. `modelsOf(provider)` returns the catalog ids a provider advertises and
 * `effortsOf(provider, model)` its supported reasoning efforts, so a stale panel cannot install
 * a combination the adapters would reject later during a real run.
 */
export function applyRoutePatch({ patch, routes, providers, disabled = [], modelsOf, effortsOf }) {
  if (!Array.isArray(patch) || patch.length === 0) return { ok: false, reason: '没有要保存的环节' }
  const known = new Set(providers)
  const next = { ...routes }
  const nextDisabled = new Set(disabled)
  for (const item of patch) {
    const role = normalizeRole(String(item?.role ?? ''))
    if (!role) return { ok: false, reason: `未知环节：${item?.role}` }
    if (item?.enabled === false) { nextDisabled.add(role); continue }
    nextDisabled.delete(role)
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
  return { ok: true, routes: next, disabled: [...nextDisabled] }
}
