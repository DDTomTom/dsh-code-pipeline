// Finished pipeline runs, kept across panel reloads and DSH restarts so a result stays readable
// after the next run (or a restart) pushes it out of the live list.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_HISTORY = 50

const cleanRun = run => {
  if (!run || typeof run.id !== 'string' || !Array.isArray(run.phases)) return undefined
  return {
    id: run.id,
    task: typeof run.task === 'string' ? run.task : '',
    mode: typeof run.mode === 'string' ? run.mode : 'auto',
    escalation: typeof run.escalation === 'string' ? run.escalation : 'none',
    status: typeof run.status === 'string' ? run.status : 'halted',
    startedAt: Number(run.startedAt) || 0,
    endedAt: Number(run.endedAt) || 0,
    attempt: Number(run.attempt) || 1,
    summary: typeof run.summary === 'string' ? run.summary : '',
    phases: run.phases.map(p => ({
      role: String(p?.role ?? ''),
      label: String(p?.label ?? ''),
      route: typeof p?.route === 'string' ? p.route : '',
      status: String(p?.status ?? ''),
      startedAt: Number(p?.startedAt) || 0,
      endedAt: Number(p?.endedAt) || 0,
      note: typeof p?.note === 'string' ? p.note : '',
      detail: typeof p?.detail === 'string' ? p.detail : '',
    })),
  }
}

/** Newest first, capped, deduplicated by run id; every mutation is written atomically. */
export function createHistoryStore(file, limit = MAX_HISTORY) {
  let items = []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.runs)) {
      items = raw.runs.map(cleanRun).filter(Boolean).slice(0, limit)
    }
  } catch { /* first use, or the file is unreadable: start empty */ }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ runs: items }))
      renameSync(tmp, file)
    } catch { /* persistence is best effort; the in-memory list still serves this session */ }
  }
  return {
    list: () => items,
    get: id => items.find(run => run.id === String(id)),
    add(run) {
      const entry = cleanRun(run)
      if (!entry) return false
      items = [entry, ...items.filter(item => item.id !== entry.id)].slice(0, limit)
      save()
      return true
    },
    clear() { items = []; save() },
    get size() { return items.length },
  }
}

/** Compact rows for the panel: everything except the long per-phase details. */
export const historyDigest = runs => (runs || []).map(run => ({
  id: run.id, task: run.task, mode: run.mode, escalation: run.escalation, status: run.status,
  startedAt: run.startedAt, endedAt: run.endedAt, attempt: run.attempt, summary: run.summary,
  phases: run.phases.map(p => ({
    role: p.role, label: p.label, route: p.route, status: p.status,
    startedAt: p.startedAt, endedAt: p.endedAt, note: p.note,
    hasDetail: Boolean(p.detail),
  })),
}))
