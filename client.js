// dsh-code-pipeline · floating progress panel (shell.overlay).
// Shows which pipeline step is running and which model serves it, plus plugin health.
// Data comes from the Host route /dsh-code-pipeline/state; this module keeps no other state
// besides the panel position / collapse preference and the chosen UI language in localStorage.
window.__ModuleLoader__.load({
  id: '@local/dsh-code-pipeline',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useCallback } = React

    const PREF_KEY = 'dsh-code-pipeline:panel'
    const LANG_KEY = 'dsh-code-pipeline:lang'
    const BLUE = '#1d4ed8'
    const GREEN = '#15803d'

    /** Add a language by adding one entry here (the dropdown lists whatever this array holds). */
    const LANGS = [{ id: 'zh', name: '中文' }, { id: 'en', name: 'English' }]

    const I18N = {
      zh: {
        panelTitle: '代码流水线', panelRunning: '代码流水线 · 运行中', settingsTitle: '各环节模型设置',
        pillHint: '代码流水线 · 点击展开，拖动可移动',
        dragHint: '拖动移动，双击回到默认位置',
        titleOpen: '点标题打开各环节模型设置', titleBack: '点标题返回运行进度',
        collapse: '收起', close: '关闭（下次运行时自动出现）',
        idle: '空闲：尚无运行记录。下达实现/修复代码的指令后，这里会实时显示步骤与模型。',
        preparing: '正在准备…', noTask: '（无任务描述）',
        mode: '模式', attempt: n => `第 ${n} 次执行`, escalation: v => `升级 ${v}`, elapsed: '用时',
        health: '功能状态：', recheck: '重新检测', checking: '检测中…', details: '点击查看检测详情',
        allOk: '工具已注册，各阶段模型线路均可解析。',
        routeBad: (role, route, why) => `✗ ${role}：${route}${why ? ' — ' + why : ''}`,
        toolMissing: 'code_pipeline 工具未注册（插件未装载或已停用）。',
        lastRun: (status, time) => `最近一次运行：${status}（${time}）`,
        lastCheck: '上次检测：',
        offline: '无法连接 /dsh-code-pipeline/state：插件可能未加载，或 DSH 正在重启。',
        loadingModels: '正在读取模型目录…', hintSave: '改动后点保存才会应用', back: '返回', save: '保存',
        saving: '保存中…', saved: n => `已保存并应用（${n} 个环节）`, noChange: '没有改动',
        saveFailed: '保存失败：', loadFailed: '读取设置失败：',
        modelTitle: '该环节使用的模型', effortTitle: '推理等级：', currentEffort: '当前推理等级',
        noEffort: '该模型没有可调推理等级', fixedEffort: '固定',
        langTitle: '语言 / Language',
        modeTitle: '流水线模式', modeHint: '这是全局默认；本会话可用 /pipeline 单独设置',
        modeLabels: { off: '关闭', auto: '自动判断', always: '每次都用' },
        modeSaved: '已应用', modeFailed: '切换失败：',
        history: '历史', historyTitle: '历史记录', historyEmpty: '还没有历史记录。每次运行结束后会自动存一份。',
        historyHint: '最多保留 50 条；清空只删记录，不影响运行。',
        clearHistory: '清空记录', confirmClear: '再点一次清空', cleared: (n) => `已清空 ${n} 条`, clearFailed: '清空失败：',
        clickDetail: '点击查看这一步的结论', loadingDetail: '加载中…', noDetail: '这一步没有可显示的文本输出。',
        steps: n => `${n} 步`,
        pillRunning: '流水线运行中', pillIdle: text => `流水线 · ${text}`,
        roles: {
          direction: '定向', planning: '规划', design: '设计', execution: '执行', verification: '复核',
          deepReview: '深度复核', emergencyFable: 'Fable 诊断', emergencyAstra: 'Astra 诊断',
          facts: '采集仓库事实', check: '独立检查',
        },
        status: {
          running: '运行中', reviewed_with_check: '已通过 · 含机器检查', reviewed_unverified: '已复核 · 未经机器验证',
          not_verified: '未通过', needs_input: '需要你回答问题', needs_configuration: '需要配置模型凭据',
          provider_unusable: '模型线路被账号拒绝', halted: '已中断', invalid_input: '参数无效', unavailable: '不可用',
        },
        healthLevel: { ok: '运行正常', warn: '基本正常 · 升级线路异常', error: '异常', unknown: '检测中', offline: '宿主无响应' },
      },
      en: {
        panelTitle: 'Code pipeline', panelRunning: 'Code pipeline · running', settingsTitle: 'Stage models',
        pillHint: 'Code pipeline — click to expand, drag to move',
        dragHint: 'Drag to move, double-click to reset',
        titleOpen: 'Click the title to open stage settings', titleBack: 'Click the title to return to progress',
        collapse: 'Collapse', close: 'Close (reappears on the next run)',
        idle: 'Idle: no runs yet. Ask for a code change and the steps and models appear here live.',
        preparing: 'Preparing…', noTask: '(no task text)',
        mode: 'mode', attempt: n => `attempt ${n}`, escalation: v => `escalated ${v}`, elapsed: 'elapsed',
        health: 'Status: ', recheck: 'Check now', checking: 'Checking…', details: 'Click for details',
        allOk: 'Tool registered; every stage route resolves.',
        routeBad: (role, route, why) => `✗ ${role}: ${route}${why ? ' — ' + why : ''}`,
        toolMissing: 'The code_pipeline tool is not registered (plugin missing or disabled).',
        lastRun: (status, time) => `Last run: ${status} (${time})`,
        lastCheck: 'Last check: ',
        offline: 'Cannot reach /dsh-code-pipeline/state: the plugin may not be loaded, or DSH is restarting.',
        loadingModels: 'Reading the model catalog…', hintSave: 'Changes apply only after Save', back: 'Back', save: 'Save',
        saving: 'Saving…', saved: n => `Saved and applied (${n} stage${n > 1 ? 's' : ''})`, noChange: 'Nothing changed',
        saveFailed: 'Save failed: ', loadFailed: 'Could not read settings: ',
        modelTitle: 'Model used by this stage', effortTitle: 'Reasoning effort: ', currentEffort: 'Current reasoning effort',
        noEffort: 'This model has no adjustable reasoning effort', fixedEffort: 'fixed',
        langTitle: 'Language / 语言',
        modeTitle: 'Pipeline mode', modeHint: 'Global default; /pipeline overrides it per session',
        modeLabels: { off: 'Off', auto: 'Auto', always: 'Every turn' },
        modeSaved: 'Applied', modeFailed: 'Switch failed: ',
        history: 'History', historyTitle: 'Run history', historyEmpty: 'No runs yet — each finished run is saved automatically.',
        historyHint: 'Keeps the last 50 runs; clearing removes records only.',
        clearHistory: 'Clear history', confirmClear: 'Click again to clear', cleared: n => `Cleared ${n} record${n === 1 ? '' : 's'}`, clearFailed: 'Clear failed: ',
        clickDetail: 'Click to see what this step concluded', loadingDetail: 'Loading…', noDetail: 'This step produced no text output.',
        steps: n => `${n} step${n === 1 ? '' : 's'}`,
        pillRunning: 'pipeline running', pillIdle: text => `pipeline · ${text}`,
        roles: {
          direction: 'Direction', planning: 'Planning', design: 'Design', execution: 'Execution', verification: 'Review',
          deepReview: 'Deep review', emergencyFable: 'Fable diagnosis', emergencyAstra: 'Astra diagnosis',
          facts: 'Workspace facts', check: 'Independent check',
        },
        status: {
          running: 'running', reviewed_with_check: 'passed · machine-checked', reviewed_unverified: 'reviewed · not machine-verified',
          not_verified: 'not verified', needs_input: 'needs your answer', needs_configuration: 'needs a model credential',
          provider_unusable: 'rejected by the account', halted: 'halted', invalid_input: 'invalid input', unavailable: 'unavailable',
        },
        healthLevel: { ok: 'healthy', warn: 'mostly fine · escalation route unavailable', error: 'problem', unknown: 'checking', offline: 'host unreachable' },
      },
    }

    const LANG_IDS = LANGS.map(l => l.id)
    function readLang() {
      try {
        const saved = localStorage.getItem(LANG_KEY)
        if (saved && LANG_IDS.includes(saved)) return saved
      } catch {}
      const nav = typeof navigator !== 'undefined' ? String(navigator.language || '').toLowerCase() : ''
      // This plugin is written for a Chinese-first user base: English only when the browser asks for it.
      return nav.startsWith('en') ? 'en' : 'zh'
    }

    const STATUS_COLORS = {
      running: BLUE, reviewed_with_check: GREEN, reviewed_unverified: '#b45309', needs_input: '#b45309',
      not_verified: '#b91c1c', needs_configuration: '#b91c1c', provider_unusable: '#b91c1c',
      halted: '#b91c1c', invalid_input: '#b91c1c', unavailable: '#b91c1c',
    }
    const HEALTH_COLORS = { ok: '#16a34a', warn: '#d97706', error: '#dc2626', unknown: '#9ca3af', offline: '#dc2626' }

    const CSS = `
.dcp-panel{position:fixed;z-index:60;width:420px;background:#ffffff;color:#1f2328;
  border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.16);
  font-size:12.5px;line-height:1.45;pointer-events:auto;user-select:none;overflow:hidden}
.dcp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;border-bottom:1px solid #f0f1f3}
.dcp-head:active{cursor:grabbing}
.dcp-title{font-weight:600;font-size:13px;flex:1;color:#111827;cursor:pointer;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dcp-title:hover{color:${BLUE}}
.dcp-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dcp-actions{display:inline-flex;align-items:center;gap:8px;flex:none}
.dcp-icon{border:none;background:transparent;color:#6b7280;cursor:pointer;font-size:14px;line-height:1;
  width:26px;height:26px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center}
.dcp-icon:hover{background:#f3f4f6;color:#111827}
.dcp-icon-gear{font-size:15px}
.dcp-lang{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  border-radius:6px;color:#6b7280;cursor:pointer;border:none;background:transparent}
.dcp-lang:hover{background:#f3f4f6;color:#111827}
.dcp-langmenu{position:absolute;top:calc(100% + 4px);right:0;z-index:70;min-width:104px;padding:4px;
  background:#ffffff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 22px rgba(15,23,42,.18)}
.dcp-langitem{display:block;width:100%;text-align:left;border:none;background:transparent;border-radius:5px;
  padding:5px 8px;font-size:12px;color:#111827;cursor:pointer;white-space:nowrap}
.dcp-langitem:hover{background:#eef2ff}
.dcp-langitem.on{color:${BLUE};font-weight:600}
.dcp-mode{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid #f0f1f3}
.dcp-mode-label{color:#374151;font-size:11.5px;flex:none}
.dcp-mode-slider{flex:1;min-width:0;accent-color:${BLUE};height:16px;margin:0}
.dcp-mode-value{color:${BLUE};font-size:11.5px;font-weight:600;flex:none;min-width:60px;text-align:right}
.dcp-row-btn{cursor:pointer;border-radius:6px}
.dcp-row-btn:hover{background:#f8fafc}
.dcp-row.open{background:#f8fafc}
.dcp-caret{color:#9ca3af;font-size:10px;margin-left:2px}
.dcp-detail{grid-column:1 / 4;margin:2px 0 4px;padding:6px 8px;border-radius:6px;background:#f3f4f6;
  color:#374151;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow:auto;user-select:text}
.dcp-hist{display:flex;align-items:center;gap:6px;padding:5px 0;border-top:1px dashed #f0f1f3;cursor:pointer}
.dcp-hist:first-child{border-top:none}
.dcp-hist:hover{background:#f8fafc}
.dcp-hist-main{flex:1;min-width:0}
.dcp-hist-task{color:#1f2328;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcp-hist-meta{color:#6b7280;font-size:11px;display:flex;gap:6px;flex-wrap:wrap}
.dcp-hist-status{font-size:11px;font-weight:600;flex:none}
.dcp-body{padding:8px 10px 6px;max-height:340px;overflow:auto}
.dcp-task{color:#4b5563;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
  -webkit-line-clamp:2;-webkit-box-orient:vertical;user-select:text}
.dcp-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.dcp-tag{font-size:11px;padding:1px 6px;border-radius:999px;background:#f3f4f6;color:#4b5563}
.dcp-row{display:grid;grid-template-columns:16px 1fr auto;gap:2px 6px;align-items:start;padding:4px 0;
  border-top:1px dashed #f0f1f3}
.dcp-row:first-of-type{border-top:none}
.dcp-step{color:${BLUE};font-weight:600}
.dcp-model{color:${GREEN};grid-column:2 / 4;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:11.5px;word-break:break-all}
.dcp-note{grid-column:2 / 4;color:#6b7280;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;user-select:text}
.dcp-time{color:#6b7280;font-size:11px;font-variant-numeric:tabular-nums}
.dcp-st{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;margin-top:2px}
.dcp-spin{width:10px;height:10px;border-radius:50%;border:2px solid #bfdbfe;border-top-color:${BLUE};
  animation:dcp-rot .8s linear infinite}
@keyframes dcp-rot{to{transform:rotate(360deg)}}
.dcp-result{margin-top:6px;padding:6px 8px;border-radius:8px;background:#f9fafb;user-select:text}
.dcp-empty{color:#6b7280;padding:4px 0 6px}
.dcp-foot{display:flex;align-items:center;gap:6px;padding:7px 10px;border-top:1px solid #f0f1f3;cursor:pointer}
.dcp-foot:hover{background:#fafafa}
.dcp-foot-text{flex:1;min-width:0;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcp-issues{padding:0 10px 8px;color:#374151;font-size:11.5px;user-select:text}
.dcp-stage{display:grid;grid-template-columns:52px minmax(0,1fr) 84px 54px;gap:4px 6px;align-items:center;
  padding:5px 0;border-top:1px dashed #f0f1f3}
.dcp-stage:first-child{border-top:none}
.dcp-stage-label{color:${BLUE};font-weight:600;font-size:12px;white-space:nowrap}
.dcp-select{width:100%;box-sizing:border-box;height:26px;border:1px solid #d1d5db;border-radius:6px;
  background:#fff;color:#111827;font-size:11.5px;padding:0 4px}
.dcp-select:focus{outline:none;border-color:${BLUE}}
.dcp-effort-name{color:${GREEN};font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcp-slider{width:100%;min-width:0;accent-color:${GREEN};height:16px}
.dcp-effort-off{color:#9ca3af;font-size:11px;white-space:nowrap}
.dcp-save{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid #f0f1f3}
.dcp-save-msg{flex:1;min-width:0;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcp-primary{border:1px solid ${BLUE};background:${BLUE};color:#fff;border-radius:6px;font-size:12px;
  padding:4px 12px;cursor:pointer}
.dcp-primary:disabled{opacity:.55;cursor:default}
.dcp-btn{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:6px;font-size:11.5px;padding:2px 8px;cursor:pointer}
.dcp-btn:hover{background:#f3f4f6}
.dcp-pill{position:fixed;z-index:60;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;
  background:#ffffff;border:1px solid #e5e7eb;border-radius:999px;box-shadow:0 4px 14px rgba(15,23,42,.14);
  font-size:12px;color:#1f2328;cursor:pointer;pointer-events:auto;user-select:none}
.dcp-pill b{color:${BLUE};font-weight:600}
.dcp-pill i{color:${GREEN};font-style:normal;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
`

    function readPrefs() {
      try {
        const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
        return { x: Number.isFinite(p.x) ? p.x : null, y: Number.isFinite(p.y) ? p.y : null, collapsed: p.collapsed === true }
      } catch { return { x: null, y: null, collapsed: false } }
    }
    function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch {} }

    const fmt = ms => {
      const s = Math.max(0, Math.round(ms / 1000))
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    }

    /** Globe with a few meridians: the usual "language / no network" mark. */
    function GlobeIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': true, focusable: false,
        style: { display: 'block', pointerEvents: 'none' } },
        h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('ellipse', { cx: 12, cy: 12, rx: 4, ry: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('line', { x1: 3, y1: 12, x2: 21, y2: 12, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M4.6 7.5h14.8M4.6 16.5h14.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }))
    }

    function StatusIcon({ status }) {
      if (status === 'running') return h('span', { className: 'dcp-st' }, h('span', { className: 'dcp-spin' }))
      const map = { done: ['✓', '#16a34a'], rejected: ['!', '#d97706'], failed: ['✗', '#dc2626'] }
      const [ch, color] = map[status] || ['·', '#9ca3af']
      return h('span', { className: 'dcp-st', style: { color, fontWeight: 700 } }, ch)
    }

    function PhaseRow({ phase, now, t, open, onToggle, detail, loading }) {
      const end = phase.endedAt || now
      const canOpen = Boolean(phase.detail || phase.hasDetail)
      const row = h('div', {
        className: `dcp-row${canOpen ? ' dcp-row-btn' : ''}${open ? ' open' : ''}`,
        onClick: canOpen ? onToggle : undefined,
        title: canOpen ? t.clickDetail : undefined,
        role: canOpen ? 'button' : undefined,
        'aria-expanded': canOpen ? (open ? 'true' : 'false') : undefined,
      },
        h(StatusIcon, { status: phase.status }),
        h('span', { className: 'dcp-step' }, t.roles[phase.role] || phase.label, canOpen ? h('span', { className: 'dcp-caret' }, open ? '▾' : '▸') : null),
        h('span', { className: 'dcp-time' }, fmt(end - phase.startedAt)),
        phase.route ? h('span', { className: 'dcp-model' }, phase.route) : null,
        phase.note ? h('span', { className: 'dcp-note' }, phase.note) : null,
        open ? h('div', { className: 'dcp-detail' }, loading ? t.loadingDetail : (detail || t.noDetail)) : null)
      return row
    }

    function RunView({ run, now, t, openPhase, onTogglePhase, detailFor }) {
      const color = STATUS_COLORS[run.status] || '#374151'
      const label = t.status[run.status] || run.status
      const tags = [
        `${t.mode} ${run.mode}`,
        run.attempt > 1 ? t.attempt(run.attempt) : null,
        run.escalation !== 'none' ? t.escalation(run.escalation) : null,
        `${t.elapsed} ${fmt((run.endedAt || now) - run.startedAt)}`,
      ].filter(Boolean)
      return h('div', null,
        h('div', { className: 'dcp-task', title: run.task }, run.task || t.noTask),
        h('div', { className: 'dcp-meta' }, tags.map(tag => h('span', { key: tag, className: 'dcp-tag' }, tag))),
        run.phases.length
          ? run.phases.map((p, i) => {
              const key = `${run.id}:${i}`
              const open = openPhase === key
              const resolved = detailFor ? detailFor(run.id, p, i) : undefined
              return h(PhaseRow, {
                key, phase: p, now, t, open,
                onToggle: () => onTogglePhase && onTogglePhase(key, run.id, p),
                detail: resolved && resolved.detail,
                loading: open && resolved && resolved.loading,
              })
            })
          : h('div', { className: 'dcp-empty' }, t.preparing),
        run.status !== 'running'
          ? h('div', { className: 'dcp-result' },
              h('div', { style: { color, fontWeight: 600 } }, label),
              run.summary ? h('div', { style: { color: '#4b5563', marginTop: 2 } }, run.summary) : null)
          : null)
    }

    function StageRow({ stage, catalog, onChange, t }) {
      const efforts = stage.efforts || []
      const effortIndex = Math.max(0, efforts.findIndex(e => e.id === stage.effort))
      const pick = value => {
        const [provider, model] = value.split('\u0000')
        onChange({ ...stage, provider, model, effort: '' })
      }
      return h('div', { className: 'dcp-stage' },
        h('span', { className: 'dcp-stage-label' }, t.roles[stage.role] || stage.label),
        h('select', {
          className: 'dcp-select', value: `${stage.provider}\u0000${stage.model}`,
          onChange: e => pick(e.target.value), title: t.modelTitle,
        },
          (catalog ? catalog.providers : []).map(p => h('optgroup', { key: p.id, label: p.name },
            ((catalog.models && catalog.models[p.id]) || []).map(m => h('option', {
              // The id alone keeps the closed select readable; the human name stays in the tooltip.
              key: `${p.id}/${m.id}`, value: `${p.id}\u0000${m.id}`, title: m.name || m.id,
            }, m.id))))),
        efforts.length > 1
          ? h('input', {
              className: 'dcp-slider', type: 'range', min: 0, max: efforts.length - 1, step: 1,
              value: effortIndex, title: t.effortTitle + efforts[effortIndex].name,
              onChange: e => onChange({ ...stage, effort: efforts[Number(e.target.value)].id }),
            })
          : h('span', { className: 'dcp-effort-off', title: efforts.length === 1 ? t.fixedEffort : t.noEffort },
              efforts.length === 1 ? t.fixedEffort : '—'),
        h('span', { className: 'dcp-effort-name', title: t.currentEffort },
          efforts.length ? efforts[effortIndex].name : ''))
    }

    function SettingsView({ onClose, t }) {
      const [catalog, setCatalog] = useState(null)
      const [stages, setStages] = useState(null)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [saving, setSaving] = useState(false)
      const [loading, setLoading] = useState(true)
      const [initial, setInitial] = useState(null)

      useEffect(() => {
        let stopped = false
        ;(async () => {
          try {
            const res = await fetch('/dsh-code-pipeline/settings', { cache: 'no-store' })
            const body = await res.json()
            if (stopped) return
            if (!res.ok) throw new Error(body.error || String(res.status))
            setCatalog({ providers: body.providers, models: body.models })
            setStages(body.roles)
            setInitial(body.roles)
          } catch (e) { if (!stopped) setError(t.loadFailed + String(e && e.message || e)) }
          finally { if (!stopped) setLoading(false) }
        })()
        return () => { stopped = true }
        // t only changes the message language; reloading the catalog on a language switch is harmless.
      }, [t])

      const stageKey = s => `${s.role}\u0000${s.provider}\u0000${s.model}\u0000${s.effort || ''}`
      // Only send what changed, so untouched stages keep following the bundle's configured default.
      const changed = () => (stages || []).filter(s => {
        const before = (initial || []).find(i => i.role === s.role)
        return !before || stageKey(before) !== stageKey(s)
      })

      const save = async () => {
        if (saving || !stages) return
        const patch = changed()
        if (!patch.length) { setMessage(t.noChange); return }
        setSaving(true); setError(''); setMessage('')
        try {
          const res = await fetch('/dsh-code-pipeline/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ routes: patch.map(s => ({ role: s.role, provider: s.provider, model: s.model, effort: s.effort || '' })) }),
          })
          const body = await res.json()
          if (!res.ok || body.ok !== true) throw new Error(body.reason || String(res.status))
          setCatalog({ providers: body.settings.providers, models: body.settings.models })
          setStages(body.settings.roles)
          setInitial(body.settings.roles)
          setMessage(t.saved(patch.length))
        } catch (e) { setError(t.saveFailed + String(e && e.message || e)) }
        finally { setSaving(false) }
      }

      return h(React.Fragment, null,
        h('div', { className: 'dcp-body' },
          loading ? h('div', { className: 'dcp-empty' }, t.loadingModels)
            : stages
              ? stages.map(stage => h(StageRow, {
                  key: stage.role, stage, catalog, t,
                  onChange: next => setStages(list => list.map(s => s.role === next.role ? next : s)),
                }))
              : null,
          error ? h('div', { style: { color: '#b91c1c', marginTop: 6 } }, error) : null),
        h('div', { className: 'dcp-save' },
          h('span', { className: 'dcp-save-msg', style: { color: message ? GREEN : '#6b7280' } },
            message || t.hintSave),
          h('button', { type: 'button', className: 'dcp-btn', onClick: onClose }, t.back),
          h('button', { type: 'button', className: 'dcp-primary', onClick: save, disabled: saving || !stages },
            saving ? t.saving : t.save)))
    }

    function Panel() {
      const [lang, setLang] = useState(readLang)
      const t = I18N[lang] || I18N.zh
      const [state, setState] = useState(null)
      const [offline, setOffline] = useState(false)
      const [prefs, setPrefs] = useState(readPrefs)
      const [hiddenUntilRun, setHiddenUntilRun] = useState(null)
      const [showIssues, setShowIssues] = useState(false)
      const [probing, setProbing] = useState(false)
      const [clock, setClock] = useState(Date.now())
      const [view, setView] = useState('progress')
      const [langOpen, setLangOpen] = useState(false)
      const [modeNote, setModeNote] = useState('')
      const [modeBusy, setModeBusy] = useState(false)
      const [openPhase, setOpenPhase] = useState(null)
      const [openRun, setOpenRun] = useState(null)
      const [detailCache, setDetailCache] = useState({})   // runId -> full run (phases carry details)
      const [clearArm, setClearArm] = useState(false)
      const [historyNote, setHistoryNote] = useState('')
      const langRef = useRef(null)
      const drag = useRef(null)
      const panelRef = useRef(null)

      const MODE_ORDER = ['off', 'auto', 'always']
      const mode = state && state.mode && MODE_ORDER.includes(state.mode.default) ? state.mode.default : 'auto'

      const runs = state ? state.runs : []
      const active = runs.filter(r => r.status === 'running')
      const shown = active.length ? active : runs.slice(0, 1)
      const running = active.length > 0
      const skew = state ? Date.now() - state.now : 0 // align Host timestamps with this clock
      const now = clock - skew

      const stateRef = useRef(null)
      stateRef.current = state

      // Poll: 1 s while a run is active, 5 s when idle. Never fully pause when the window is
      // occluded or hidden — Chromium reports that state for background windows, and a paused
      // poll would show stale progress the moment the user looks back at the panel.
      useEffect(() => {
        let stopped = false
        let timer
        const delay = () => (document.visibilityState === 'visible'
          && stateRef.current && stateRef.current.runs.some(r => r.status === 'running') ? 1000 : 5000)
        const tick = async () => {
          try {
            const res = await fetch('/dsh-code-pipeline/state', { cache: 'no-store' })
            if (!res.ok) throw new Error(String(res.status))
            const next = await res.json()
            if (!stopped) { setState(next); setOffline(false) }
          } catch { if (!stopped) setOffline(true) }
          if (!stopped) timer = setTimeout(tick, delay())
        }
        const onVisibility = () => { clearTimeout(timer); tick() }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', onVisibility)
        tick()
        return () => {
          stopped = true
          clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('focus', onVisibility)
        }
      }, [])

      useEffect(() => {
        if (!running) return undefined
        const clockTimer = setInterval(() => setClock(Date.now()), 1000)
        return () => clearInterval(clockTimer)
      }, [running])
      useEffect(() => { setClock(Date.now()) }, [state])

      // Keep the panel inside the window: the host window can be resized between sessions,
      // so a remembered position must be clamped to the current viewport instead of trusted.
      const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
      useEffect(() => {
        const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
        window.addEventListener('resize', onResize)
        onResize()
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // A newly started run re-opens a panel the user closed.
      const newestId = runs[0] ? runs[0].id : null
      useEffect(() => {
        if (hiddenUntilRun && newestId && newestId !== hiddenUntilRun) setHiddenUntilRun(null)
      }, [newestId, hiddenUntilRun])

      const update = useCallback(patch => setPrefs(p => { const n = { ...p, ...patch }; savePrefs(n); return n }), [])
      const changeLang = next => {
        if (!LANG_IDS.includes(next)) return
        setLang(next)
        setLangOpen(false)
        try { localStorage.setItem(LANG_KEY, next) } catch {}
      }

      // Close the language menu on any outside click or Escape, like the host's own menus.
      useEffect(() => {
        if (!langOpen) return undefined
        const onDown = e => { if (!langRef.current || !langRef.current.contains(e.target)) setLangOpen(false) }
        const onKey = e => { if (e.key === 'Escape') setLangOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [langOpen])

      // --- step details: live runs already carry them; archived runs are fetched once on demand ---
      const loadRun = async id => {
        if (detailCache[id]) return detailCache[id]
        try {
          const res = await fetch(`/dsh-code-pipeline/history?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
          if (!res.ok) return undefined
          const run = await res.json()
          setDetailCache(cache => ({ ...cache, [id]: run }))
          return run
        } catch { return undefined }
      }
      const togglePhase = (key, runId, phase) => {
        if (openPhase === key) { setOpenPhase(null); return }
        setOpenPhase(key)
        if (!phase.detail && phase.hasDetail) loadRun(runId)
      }
      const detailFor = (runId, phase) => {
        if (phase.detail) return { detail: phase.detail }
        const run = detailCache[runId]
        if (!run) return phase.hasDetail ? { loading: true } : undefined
        const idx = run.phases.findIndex(p => p.role === phase.role && p.startedAt === phase.startedAt)
        const found = idx >= 0 ? run.phases[idx] : run.phases.find(p => p.role === phase.role)
        return found ? { detail: found.detail } : undefined
      }
      const clearHistory = async () => {
        if (!clearArm) { setClearArm(true); setHistoryNote(''); return }
        setClearArm(false)
        try {
          const res = await fetch('/dsh-code-pipeline/history/clear', { method: 'POST' })
          const body = await res.json()
          if (!res.ok || body.ok !== true) throw new Error(String(res.status))
          setHistoryNote(t.cleared(body.cleared || 0))
          setDetailCache({})
          const next = await (await fetch('/dsh-code-pipeline/state', { cache: 'no-store' })).json()
          setState(next)
        } catch (e) { setHistoryNote(t.clearFailed + String(e && e.message || e)) }
      }

      const changeMode = async next => {
        if (modeBusy || !MODE_ORDER.includes(next) || next === mode) return
        setModeBusy(true); setModeNote('')
        try {
          const res = await fetch('/dsh-code-pipeline/mode', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: next }),
          })
          const body = await res.json()
          if (!res.ok || body.ok !== true) throw new Error(body.reason || String(res.status))
          setState(body)
          setModeNote(t.modeSaved)
        } catch (e) { setModeNote(t.modeFailed + String(e && e.message || e)) }
        finally { setModeBusy(false) }
      }

      const onPointerDown = e => {
        if (e.button !== 0 || e.target.closest('button') || e.target.closest('select')) return
        const rect = (panelRef.current || e.currentTarget).getBoundingClientRect()
        drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onPointerMove = e => {
        const d = drag.current
        if (!d) return
        const x = Math.min(Math.max(0, e.clientX - d.dx), window.innerWidth - d.w)
        const y = Math.min(Math.max(0, e.clientY - d.dy), window.innerHeight - d.h)
        if (Math.abs(x - (prefs.x ?? x)) + Math.abs(y - (prefs.y ?? y)) > 2) d.moved = true
        setPrefs(p => ({ ...p, x, y }))
      }
      const onPointerUp = e => {
        const d = drag.current
        drag.current = null
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
        if (d) setPrefs(p => { savePrefs(p); return p })
        return d ? d.moved : false
      }

      const probe = async () => {
        setProbing(true)
        try {
          const res = await fetch('/dsh-code-pipeline/health', { method: 'POST', cache: 'no-store' })
          if (res.ok) { setState(await res.json()); setOffline(false) } else setOffline(true)
        } catch { setOffline(true) } finally { setProbing(false) }
      }

      const healthKey = offline ? 'offline' : (state ? state.health.level : 'unknown')
      const dotColor = HEALTH_COLORS[healthKey] || HEALTH_COLORS.unknown
      const healthText = t.healthLevel[healthKey] || t.healthLevel.unknown
      const routes = state && state.health ? state.health.routes || [] : []
      // Detail lines are composed here rather than taken from the Host so they follow the UI language.
      const issueLines = routes.filter(r => !r.ok).map(r => t.routeBad(
        t.roles[r.role] || r.role, r.route, r.error || ''))
      if (state && state.health && !state.health.routes.length && state.health.level === 'error') issueLines.push(t.toolMissing)
      const lastRun = runs[0] && runs[0].status !== 'running'
        ? t.lastRun(t.status[runs[0].status] || runs[0].status, new Date(runs[0].endedAt).toLocaleTimeString())
        : null

      // Clamp into the current viewport so a position saved in a larger window stays reachable.
      const size = prefs.collapsed ? { w: 240, h: 36 } : { w: 356, h: 340 }
      const clamp = (value, max) => Math.max(8, Math.min(value, Math.max(8, max)))
      const pos = prefs.x == null || prefs.y == null
        ? { right: 20, bottom: 110 }
        : {
            left: clamp(prefs.x, viewport.w - size.w - 8),
            top: clamp(prefs.y, viewport.h - size.h - 8),
          }

      if (hiddenUntilRun && newestId === hiddenUntilRun) return null
      if (hiddenUntilRun === '__none__' && !newestId) return null

      const style = h('style', null, CSS)

      if (prefs.collapsed) {
        const cur = active[0] && active[0].phases.filter(p => p.status === 'running').slice(-1)[0]
        return h(React.Fragment, null, style,
          h('div', {
            ref: panelRef,
            className: 'dcp-pill', style: pos, title: t.pillHint,
            onPointerDown, onPointerMove,
            onPointerUp: e => { if (!onPointerUp(e)) update({ collapsed: false }) },
          },
            h('span', { className: 'dcp-dot', style: { background: dotColor } }),
            cur ? h(React.Fragment, null,
              h('b', null, t.roles[cur.role] || cur.label),
              h('i', null, cur.route.split('/').pop()))
              : h('span', null, running ? t.pillRunning : t.pillIdle(healthText))))
      }

      const settingsOpen = view === 'settings'
      const historyOpen = view === 'history'
      const historyRuns = (state && state.history) || []
      const backToProgress = () => setView('progress')
      return h(React.Fragment, null, style,
        h('div', { ref: panelRef, className: 'dcp-panel', style: pos, role: 'status', 'aria-live': 'polite' },
          h('div', {
            className: 'dcp-head', onPointerDown, onPointerMove, onPointerUp,
            onDoubleClick: () => update({ x: null, y: null }),
            title: t.dragHint,
          },
            h('span', { className: 'dcp-dot', style: { background: running ? BLUE : dotColor } }),
            h('span', {
              className: 'dcp-title',
              title: settingsOpen || historyOpen ? t.titleBack : t.titleOpen,
              onClick: () => { if (!drag.current?.moved) setView(settingsOpen || historyOpen ? 'progress' : 'settings') },
            }, settingsOpen ? t.settingsTitle : historyOpen ? t.historyTitle : (running ? t.panelRunning : t.panelTitle)),
            h('div', {
              className: 'dcp-actions',
              // The header drags the panel; keep its pointer handling away from these controls.
              onPointerDown: e => e.stopPropagation(),
              onPointerUp: e => e.stopPropagation(),
            },
              h('div', { className: 'dcp-langwrap', ref: langRef, style: { position: 'relative', display: 'inline-flex' } },
                h('button', {
                  type: 'button', className: 'dcp-lang', title: t.langTitle,
                  'aria-haspopup': 'menu', 'aria-expanded': langOpen ? 'true' : 'false',
                  onClick: () => setLangOpen(v => !v),
                }, h(GlobeIcon)),
                langOpen
                  ? h('div', { className: 'dcp-langmenu', role: 'menu' },
                      LANGS.map(l => h('button', {
                        key: l.id, type: 'button', role: 'menuitemradio',
                        'aria-checked': l.id === lang ? 'true' : 'false',
                        className: `dcp-langitem${l.id === lang ? ' on' : ''}`,
                        onClick: () => changeLang(l.id),
                      }, l.name)))
                  : null),
              h('button', {
                type: 'button', className: 'dcp-icon dcp-icon-gear',
                title: settingsOpen ? t.titleBack : t.settingsTitle,
                onClick: () => setView(settingsOpen ? 'progress' : 'settings'),
              }, settingsOpen ? '\u21a9' : '\u2699'),
              h('button', {
                type: 'button', className: 'dcp-icon',
                title: historyOpen ? t.titleBack : t.historyTitle,
                'aria-label': t.historyTitle,
                onClick: () => setView(historyOpen ? 'progress' : 'history'),
              }, '\u2630'),
              h('button', { type: 'button', className: 'dcp-icon', title: t.collapse, onClick: () => update({ collapsed: true }) }, '–'),
              h('button', { type: 'button', className: 'dcp-icon', title: t.close, onClick: () => setHiddenUntilRun(newestId || '__none__') }, '×'))),
          settingsOpen
            ? h(SettingsView, { onClose: backToProgress, t })
            : historyOpen
              ? h(React.Fragment, null,
                  h('div', { className: 'dcp-body' },
                    historyRuns.length
                      ? historyRuns.map(run => {
                          const expanded = openRun === run.id
                          const color = STATUS_COLORS[run.status] || '#374151'
                          return h('div', { key: run.id },
                            h('div', {
                              className: 'dcp-hist',
                              onClick: () => {
                                setOpenRun(expanded ? null : run.id)
                                setOpenPhase(null)
                                if (!expanded) loadRun(run.id)
                              },
                            },
                              h('span', { className: 'dcp-hist-status', style: { color } }, t.status[run.status] || run.status),
                              h('div', { className: 'dcp-hist-main' },
                                h('div', { className: 'dcp-hist-task', title: run.task }, run.task || t.noTask),
                                h('div', { className: 'dcp-hist-meta' },
                                  h('span', null, new Date(run.startedAt).toLocaleString()),
                                  h('span', null, t.steps(run.phases.length)),
                                  run.summary ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, run.summary) : null))),
                            expanded
                              ? h('div', { style: { padding: '2px 0 6px' } },
                                  h(RunView, {
                                    run: detailCache[run.id] || run, now, t,
                                    openPhase: openPhase && openPhase.startsWith(`${run.id}:`) ? openPhase : null,
                                    onTogglePhase: togglePhase,
                                    detailFor,
                                  }))
                              : null)
                        })
                      : h('div', { className: 'dcp-empty' }, t.historyEmpty),
                    historyNote ? h('div', { style: { color: '#6b7280', fontSize: '11px', marginTop: 6 } }, historyNote) : null),
                  h('div', { className: 'dcp-save' },
                    h('span', { className: 'dcp-save-msg' }, t.historyHint),
                    h('button', { type: 'button', className: 'dcp-btn', onClick: backToProgress }, t.back),
                    h('button', {
                      type: 'button', className: 'dcp-primary',
                      style: clearArm ? { background: '#b91c1c', borderColor: '#b91c1c' } : undefined,
                      onClick: clearHistory, disabled: !historyRuns.length,
                    }, clearArm ? t.confirmClear : t.clearHistory)))
              : h(React.Fragment, null,
                h('div', { className: 'dcp-body' },
                  shown.length
                    ? shown.map(r => h(RunView, {
                        key: r.id, run: r, now, t,
                        openPhase: openPhase && openPhase.startsWith(`${r.id}:`) ? openPhase : null,
                        onTogglePhase: togglePhase, detailFor,
                      }))
                    : h('div', { className: 'dcp-empty' }, t.idle)),
                h('div', { className: 'dcp-mode', title: t.modeHint },
                  h('span', { className: 'dcp-mode-label' }, t.modeTitle),
                  h('input', {
                    className: 'dcp-mode-slider', type: 'range', min: 0, max: 2, step: 1,
                    value: MODE_ORDER.indexOf(mode), disabled: modeBusy,
                    'aria-label': t.modeTitle,
                    onChange: e => changeMode(MODE_ORDER[Number(e.target.value)]),
                  }),
                  h('span', { className: 'dcp-mode-value' }, t.modeLabels[mode] || mode),
                  modeNote
                    ? h('span', { style: { color: '#6b7280', fontSize: '11px', flex: 'none' } }, modeNote)
                    : null),
                h('div', { className: 'dcp-foot', onClick: () => setShowIssues(v => !v), title: t.details },
                  h('span', { className: 'dcp-dot', style: { background: dotColor } }),
                  h('span', { className: 'dcp-foot-text' }, t.health + healthText),
                  h('button', {
                    type: 'button', className: 'dcp-btn', title: t.historyTitle,
                    onClick: e => { e.stopPropagation(); setView('history') },
                  }, `${t.history}${historyRuns.length ? ` (${historyRuns.length})` : ''}`),
                  h('button', { type: 'button', className: 'dcp-btn', onClick: e => { e.stopPropagation(); probe() }, disabled: probing }, probing ? t.checking : t.recheck)),
                showIssues
                  ? h('ul', { className: 'dcp-issues' },
                      offline ? h('li', null, t.offline)
                        : h(React.Fragment, null,
                            issueLines.length ? issueLines.map((line, i) => h('li', { key: i, style: { color: '#b91c1c' } }, line))
                              : h('li', null, t.allOk),
                            state && state.health.routes.length
                              ? state.health.routes.map(r => h('li', { key: r.role, style: { color: r.ok ? GREEN : '#b91c1c' } },
                                  `${r.ok ? '✓' : '✗'} ${t.roles[r.role] || r.role}${r.ok ? `：${r.route}` : ''}`))
                              : null,
                            lastRun ? h('li', { style: { color: '#6b7280' } }, lastRun) : null,
                            state && state.health.checkedAt ? h('li', { style: { color: '#9ca3af' } },
                              t.lastCheck + new Date(state.health.checkedAt).toLocaleTimeString()) : null))
                  : null)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-code-pipeline-panel', order: 50, label: 'Code pipeline',
        }, Panel))
      },
    }
  },
})
