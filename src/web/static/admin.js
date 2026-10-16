'use strict'

const app = document.getElementById('app')
const ui = globalThis.examUI
const escapeHtml = ui.escape
const state = {
  admin: null,
  tab: 'overview',
  status: null,
  checks: [],
  contestants: [],
  submissions: [],
  audit: [],
  error: '',
  notice: '',
  exporting: false,
  dialog: null,
  timeEditor: null,
  timeDrafts: {},
  timeDraftKey: null,
  timeSaving: false,
  timeError: '',
  filter: { student_id: '', label: '', language: '' },
  peopleFilter: { query: '', status: '' },
  phase: null,
  rules: '',
  rulesDraft: null,
  rulesLoaded: false,
  connection: 'connecting'
}
const stateLabels = {
  unset: '时间未设定',
  not_started: '等待开考',
  running: '考试进行中',
  paused: '考试已暂停',
  finished: '考试已结束'
}
const languageLabels = { cpp: 'C++', java: 'Java', python3: 'Python 3' }
const tabs = [
  ['overview', '考场总览', 'monitor'],
  ['contestants', '考生管理', 'users'],
  ['submissions', '提交记录', 'file'],
  ['rules', '考生守则', 'rules'],
  ['system', '系统设置', 'settings']
]
const formValue = (form, field) => form.elements.namedItem(field)?.value ?? ''
const formChecked = (form, field) => Boolean(form.elements.namedItem(field)?.checked)
const htmlCache = {}
let eventSource = null,
  refreshTimer = null

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  })
  if (response.status === 204) return undefined
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && state.admin) {
    state.admin = null
    stopEvents()
    closeDialog()
    state.error = data.error || '登录已过期，请重新登录'
    state.notice = ''
    render()
  }
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`)
  return data
}
function scheduleText(exam) {
  return exam?.exam_start_at && exam?.exam_end_at
    ? `${exam.exam_start_at} — ${exam.exam_end_at}`
    : '考试时间待安排'
}
function beijingToday(offset = 0) {
  return new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10)
}
function normalizeTime(value) {
  let time = value.trim().replace('：', ':')
  if (/^\d{3,4}$/.test(time)) time = time.slice(0, -2) + ':' + time.slice(-2)
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null
  return match[1].padStart(2, '0') + ':' + match[2]
}
function timePoint(date, time) {
  const normalized = normalizeTime(time)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !normalized) return null
  const value = `${date}T${normalized}:00Z`,
    stamp = Date.parse(value)
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 16) !== value.slice(0, 16))
    return null
  return { value: `${date} ${normalized}:00`, stamp }
}
function timeRange(draft) {
  const start = timePoint(draft.start_date, draft.start_time)
  const end = timePoint(draft.end_date, draft.end_time)
  if (!start || !end) throw new Error('请填写完整日期和时间，时间格式为 09:00，也可输入 0900。')
  if (end.stamp <= start.stamp)
    throw new Error('结束时间必须晚于开始时间；跨天考试请选择次日结束。')
  return { start, end }
}
function timeSummary(draft) {
  try {
    const { start, end } = timeRange(draft),
      minutes = (end.stamp - start.stamp) / 60000
    const duration = `${Math.floor(minutes / 60) ? Math.floor(minutes / 60) + ' 小时' : ''}${minutes % 60 ? ' ' + (minutes % 60) + ' 分钟' : ''}`
    return `${start.value.slice(0, 16)} 至 ${end.value.slice(0, 16)} · 共 ${duration}`
  } catch (error) {
    return error.message
  }
}
function openTimeEditor(mode = 'schedule') {
  if (state.timeSaving) return
  const exam = state.status?.exam || {}
  if (mode === 'schedule' && !canSchedule(exam)) return
  if (mode === 'restart' && examDisplayState(exam) !== 'finished') return
  const key = `${exam.generation || ''}:${exam.contest_id || ''}`
  if (state.timeDraftKey !== key) {
    state.timeDrafts = {}
    state.timeDraftKey = key
  }
  state.timeDrafts[mode] ||= {
    start_date:
      mode === 'schedule' && exam.exam_start_at ? exam.exam_start_at.slice(0, 10) : beijingToday(),
    start_time: mode === 'schedule' ? (exam.exam_start_at || '').slice(11, 16) : '',
    end_date:
      mode === 'schedule' && exam.exam_end_at ? exam.exam_end_at.slice(0, 10) : beijingToday(),
    end_time: mode === 'schedule' ? (exam.exam_end_at || '').slice(11, 16) : '',
    clear_submissions: false
  }
  state.timeEditor = mode
  state.timeError = ''
  state.tab = 'overview'
  render()
  document.getElementById('time-start-time')?.focus()
}
function renderTimeEditor() {
  if (!state.timeEditor) return ''
  const restart = state.timeEditor === 'restart',
    draft = state.timeDrafts[state.timeEditor]
  const fields = ['start', 'end']
    .map(
      (side) =>
        `<fieldset class="time-point"><legend>${side === 'start' ? '开始' : '结束'}时间</legend><div class="time-point-fields"><label><span>日期</span><input type="date" name="${side}_date" value="${escapeHtml(draft[side + '_date'])}" required></label><label><span>时间（24 小时制）</span><input type="text" id="time-${side}-time" name="${side}_time" value="${escapeHtml(draft[side + '_time'])}" placeholder="例如 09:00" inputmode="numeric" autocomplete="off" maxlength="5" required></label></div></fieldset>`
    )
    .join('')
  return `<section class="card time-editor" aria-labelledby="time-editor-title"><header><div><h2 id="time-editor-title">${restart ? '重新安排考试' : '安排考试时间'}</h2><p class="small muted">北京时间（UTC+8）。到达开始时间自动开考，到达结束时间自动收卷。</p></div></header><form id="exam-time-form" class="body" novalidate><fieldset class="time-editor-controls" ${state.timeSaving ? 'disabled' : ''}><div class="time-shortcuts"><span class="small muted">考试日期</span><button type="button" data-time-day="0">今天</button><button type="button" data-time-day="1">明天</button><span class="small muted">或在下方选择日期</span></div><div class="time-range">${fields}</div><div class="time-shortcuts"><span class="small muted">按开始时间设置时长</span>${[2, 3, 4, 5].map((hours) => `<button type="button" data-time-hours="${hours}">${hours} 小时</button>`).join('')}</div><p id="time-summary" class="time-summary" aria-live="polite">${escapeHtml(timeSummary(draft))}</p>${restart ? `<label class="check"><input type="checkbox" name="clear_submissions" ${draft.clear_submissions ? 'checked' : ''}><span>清空先前提交（不可恢复，默认保留）</span></label>` : ''}<p id="time-error" class="msg err" role="alert" ${state.timeError ? '' : 'hidden'}>${escapeHtml(state.timeError)}</p><div class="time-editor-actions"><span class="small muted">切换页面、刷新状态不丢失填写内容，保存后生效。</span><button type="button" id="time-collapse">收起</button><button type="submit" class="${restart && draft.clear_submissions ? 'danger' : 'primary'}">${state.timeSaving ? '保存中…' : restart ? (draft.clear_submissions ? '清空提交并重新安排' : '保留提交并重新安排') : '保存考试时间'}</button></div></fieldset></form></section>`
}
function bindTimeEditor() {
  const form = document.getElementById('exam-time-form')
  if (!form) return
  const draft = state.timeDrafts[state.timeEditor]
  const feedback = (message = '') => {
    state.timeError = message
    const error = document.getElementById('time-error')
    error.textContent = message
    error.hidden = !message
    setText('time-summary', timeSummary(draft))
  }
  form.addEventListener('input', (event) => {
    const field = event.target
    if (!(field.name in draft)) return
    draft[field.name] = field.type === 'checkbox' ? field.checked : field.value
    if (field.name === 'clear_submissions') {
      const button = form.querySelector('[type=submit]')
      button.textContent = field.checked ? '清空提交并重新安排' : '保留提交并重新安排'
      button.className = field.checked ? 'danger' : 'primary'
    }
    feedback()
  })
  form.querySelectorAll('[name$="_time"]').forEach((input) =>
    input.addEventListener('blur', () => {
      const value = normalizeTime(input.value)
      if (value) {
        input.value = value
        draft[input.name] = value
        feedback()
      }
    })
  )
  const sync = () => {
    for (const name of ['start_date', 'start_time', 'end_date', 'end_time'])
      form.elements.namedItem(name).value = draft[name]
    feedback()
  }
  form.querySelectorAll('[data-time-day]').forEach((button) =>
    button.addEventListener('click', () => {
      const gap =
        Math.max(0, (Date.parse(draft.end_date) - Date.parse(draft.start_date)) / 86400000) || 0
      draft.start_date = beijingToday(Number(button.dataset.timeDay))
      draft.end_date = beijingToday(Number(button.dataset.timeDay) + gap)
      sync()
    })
  )
  form.querySelectorAll('[data-time-hours]').forEach((button) =>
    button.addEventListener('click', () => {
      const start = timePoint(draft.start_date, draft.start_time)
      if (!start) {
        feedback('请先填写开始日期和时间，再选择考试时长。')
        return
      }
      const end = new Date(start.stamp + Number(button.dataset.timeHours) * 3600000).toISOString()
      draft.start_time = start.value.slice(11, 16)
      draft.end_date = end.slice(0, 10)
      draft.end_time = end.slice(11, 16)
      sync()
    })
  )
  document.getElementById('time-collapse').addEventListener('click', () => {
    state.timeEditor = null
    render()
    document.getElementById('schedule-btn')?.focus()
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (state.timeSaving) return
    let range
    try {
      range = timeRange(draft)
    } catch (error) {
      feedback(error.message)
      return
    }
    const mode = state.timeEditor,
      controls = form.querySelector('fieldset'),
      button = form.querySelector('[type=submit]'),
      label = button.textContent
    const payload = { exam_start_at: range.start.value, exam_end_at: range.end.value }
    if (mode === 'restart') payload.clear_submissions = draft.clear_submissions
    state.timeSaving = true
    controls.disabled = true
    button.textContent = '保存中…'
    feedback()
    try {
      const updated = await api('/admin/exam/' + mode, {
        method: 'PUT',
        body: JSON.stringify(payload)
      })
      state.status.exam = updated
      delete state.timeDrafts[mode]
      state.timeEditor = null
      render()
      refreshActive()
      flash('notice', mode === 'restart' ? '比赛已重新安排' : '考试时间已保存')
    } catch (error) {
      if (state.admin) {
        state.timeError = error.message
        const currentError = document.getElementById('time-error')
        if (currentError) {
          currentError.textContent = error.message
          currentError.hidden = false
        } else flash('error', error.message)
      }
    } finally {
      state.timeSaving = false
      controls.disabled = false
      button.textContent = label
      const currentForm = document.getElementById('exam-time-form')
      if (currentForm && currentForm !== form) {
        currentForm.querySelector('.time-editor-controls').disabled = false
        currentForm.querySelector('[type=submit]').textContent = label
      }
    }
  })
}
function setHTML(id, html) {
  if (htmlCache[id] === html) return
  const el = document.getElementById(id)
  if (el) {
    el.innerHTML = html
    htmlCache[id] = html
  }
}
function setText(id, text) {
  const el = document.getElementById(id)
  if (el && el.textContent !== String(text)) el.textContent = text
}
function renderBanner() {
  const html = state.error
    ? `<div class="msg err" role="alert">${escapeHtml(state.error)}</div>`
    : state.notice
      ? `<div class="msg ok" role="status">${escapeHtml(state.notice)}</div>`
      : ''
  for (const id of ['banner', 'dialog-feedback']) {
    const el = document.getElementById(id)
    if (el) el.innerHTML = html
  }
}
function flash(kind, text) {
  if (kind === 'error') {
    state.error = text
    state.notice = ''
  } else {
    state.notice = text
    state.error = ''
  }
  renderBanner()
  setTimeout(() => {
    state.error = ''
    state.notice = ''
    renderBanner()
  }, 4000)
}
function setConnection(value) {
  state.connection = value
  setHTML('connection', ui.connection(value))
}
function guarded(fn) {
  let busy = false,
    pending = false
  const refresh = async () => {
    if (!state.admin) {
      pending = false
      return
    }
    pending = true
    if (busy || state.dialog) return
    busy = true
    try {
      do {
        pending = false
        await fn()
      } while (pending && state.admin && !state.dialog)
    } catch {
      pending = Boolean(state.admin)
      if (state.admin) setConnection('stale')
    } finally {
      busy = false
    }
  }
  refresh.flush = () => (pending ? refresh() : Promise.resolve())
  return refresh
}
function queryString() {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(state.filter)) if (value) params.set(key, value)
  return params.size ? '?' + params : ''
}
async function refresh() {
  const [status, checks, contestants, submissions, audit] = await Promise.all([
    api('/admin/status'),
    api('/admin/checks'),
    api('/admin/contestants'),
    api('/admin/submissions' + queryString()),
    api('/admin/audit')
  ])
  state.status = status
  state.checks = checks || []
  state.contestants = contestants || []
  state.submissions = submissions || []
  state.audit = audit || []
}
async function boot() {
  try {
    state.admin = await api('/admin/me')
    await refresh()
    render()
    startEvents()
  } catch {
    state.admin = null
    render()
  }
}
async function login(event) {
  event.preventDefault()
  const form = event.target,
    button = form.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    state.admin = await api('/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: formValue(form, 'username'),
        password: formValue(form, 'password')
      })
    })
    await refresh()
    state.error = ''
    state.notice = ''
    render()
    startEvents()
  } catch (error) {
    state.admin = null
    flash('error', error.message)
    button.disabled = false
  }
}
async function logout() {
  await api('/admin/logout', { method: 'POST' }).catch(() => {})
  stopEvents()
  state.admin = null
  closeDialog()
  render()
}
function startEvents() {
  if (eventSource || !state.admin) return
  if (!window.EventSource) {
    setConnection('unavailable')
    return
  }
  setConnection('connecting')
  const source = new EventSource('/api/admin/events')
  source.onopen = () => {
    setConnection('connected')
    if (state.admin) refreshActive()
  }
  source.onmessage = scheduleRefresh
  source.onerror = () => setConnection('reconnecting')
  eventSource = source
}
function stopEvents() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}
function scheduleRefresh() {
  if (!refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refreshActive()
    }, 400)
}
function refreshActive() {
  refreshStatus()
  if (state.tab === 'overview') pollChecks()
  else if (state.tab === 'contestants') pollContestants()
  else if (state.tab === 'submissions') pollSubmissions()
  else if (state.tab === 'system') pollAudit()
}
const examChip = (name) =>
  `<span class="tag ${name === 'running' ? 'green' : name === 'paused' || name === 'not_started' ? 'amber' : 'gray'}">${stateLabels[name] || '—'}</span>`
function submissionRow(item, recent = false) {
  return `<tr>${recent ? '' : `<td class="mono">#${item.id}</td>`}<td><span>${escapeHtml(item.name)}</span><br><span class="small muted mono">${escapeHtml(item.student_id)}</span></td><td class="mono">${escapeHtml(item.label)}</td><td>${escapeHtml(languageLabels[item.language] || item.language)}</td><td class="small">${escapeHtml(ui.time(item.submitted_at))}</td><td><button class="text-button" data-source="${item.id}">查看源码</button></td></tr>`
}
function checksRows() {
  return state.checks.length
    ? state.checks
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.name)}</td><td><span class="tag ${c.ok ? 'green' : 'red'}">${c.ok ? '通过' : '未通过'}</span></td><td class="muted small">${escapeHtml(c.message)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="empty-cell">暂无检查结果</td></tr>'
}
function checksSummary() {
  const failed = state.checks.filter((c) => !c.ok).length
  return state.checks.length
    ? `<span class="tag ${failed ? 'red' : 'green'}">${failed ? `${failed} 项待处理` : `${state.checks.length} 项通过`}</span>`
    : '<span class="tag gray">等待检查</span>'
}
function byProblemRows() {
  const counts = state.status?.submissions_by_problem || {},
    keys = Object.keys(counts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (!keys.length) return '<p class="muted small">暂无提交</p>'
  return keys
    .map((label) => {
      const n = Math.max(0, Number(counts[label]) || 0),
        pct = Math.min(100, (n / Math.max(1, state.status.contestant_count)) * 100)
      return `<div class="problem-bar" role="img" aria-label="${escapeHtml(label)} 题 ${n} 人提交"><span class="mono">${escapeHtml(label)}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><strong>${n}</strong></div>`
    })
    .join('')
}
function recentRows() {
  return state.status?.recent?.length
    ? state.status.recent
        .slice(0, 6)
        .map((item) => submissionRow(item, true))
        .join('')
    : '<tr><td colspan="5" class="empty-cell">暂无提交，开考后将在此显示最新收录。</td></tr>'
}
function filteredContestants() {
  const q = state.peopleFilter.query.toLowerCase(),
    status = state.peopleFilter.status
  return state.contestants.filter(
    (c) =>
      `${c.student_id} ${c.name}`.toLowerCase().includes(q) &&
      (!status ||
        (status === 'disabled' && c.disabled) ||
        (status === 'finished' && c.finished) ||
        (status === 'normal' && !c.disabled && !c.finished))
  )
}
function contestantRows() {
  const rows = filteredContestants()
  return rows.length
    ? rows
        .map(
          (c) =>
            `<tr><td class="mono">${escapeHtml(c.student_id)}</td><td>${escapeHtml(c.name)}</td><td><span class="tag ${c.disabled ? 'red' : 'green'}">${c.disabled ? '已禁用' : '可用'}</span></td><td><span class="tag ${c.finished ? 'amber' : 'gray'}">${c.finished ? '已交卷' : '未交卷'}</span></td><td class="mono small">${escapeHtml(c.ip || '—')}</td><td><button class="text-button" data-edit="${c.id}">管理考生</button></td></tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty-cell">没有匹配的考生</td></tr>'
}
function submissionRows() {
  return state.submissions.length
    ? state.submissions.map((item) => submissionRow(item)).join('')
    : '<tr><td colspan="6" class="empty-cell">没有匹配的提交记录</td></tr>'
}
const auditLabels = {
  'exam.schedule': '设定考试时间',
  'exam.rules.update': '更新考生守则',
  'exam.import': '导入比赛包',
  'exam.export': '导出提交包',
  'exam.restart': '重新开考',
  'exam.pause': '暂停考试',
  'exam.resume': '恢复考试',
  'exam.abort': '中止考试',
  'exam.start': '开始考试',
  'exam.finish': '结束考试',
  'admin.password': '修改管理员密码',
  'contestant.add': '新增考生',
  'contestant.update': '更新考生信息',
  'contestant.early_submit': '考生提前交卷',
  'audit.clear': '清空操作记录'
}
function auditRows() {
  return state.audit.length
    ? state.audit
        .map((a) => {
          let detail = a.detail_json
          try {
            detail = JSON.stringify(JSON.parse(detail), null, 2)
          } catch {}
          return `<tr><td class="small mono">${escapeHtml(ui.time(a.created_at))}</td><td>${escapeHtml(a.actor)}</td><td>${escapeHtml(auditLabels[a.action] || a.action)}</td><td class="small">${escapeHtml(a.object_type)} #${escapeHtml(a.object_id)}</td><td><details class="audit-details"><summary>查看详情</summary><pre>${escapeHtml(detail)}</pre></details></td></tr>`
        })
        .join('')
    : '<tr><td colspan="5" class="empty-cell">暂无操作记录</td></tr>'
}
function applyOverview() {
  const status = state.status || {},
    exam = status.exam
  setHTML('exam-state', examChip(examDisplayState(exam)))
  setText('exam-name', exam?.name || '尚未导入比赛')
  setText('exam-schedule', scheduleText(exam))
  setText('countdown', ui.clockValue(exam))
  setText('countdown-label', ui.clockLabel(exam))
  setHTML('exam-actions', examActions())
  const schedule = document.getElementById('schedule-btn')
  if (schedule) schedule.hidden = !canSchedule(exam)
  setText('stat-online', status.online ?? 0)
  setText('stat-contestants', status.contestant_count ?? 0)
  setText('stat-problems', status.problem_count ?? 0)
  setText('stat-submissions', status.submission_count ?? 0)
  setHTML('checks-status', checksSummary())
  setHTML('checks-body', checksRows())
  setHTML('by-problem-body', byProblemRows())
  setHTML('recent-body', recentRows())
}
function applyContestants() {
  setHTML('contestants-body', contestantRows())
  setText(
    'contestants-count',
    `当前匹配 ${filteredContestants().length} 人 / 名单共 ${state.contestants.length} 人`
  )
}
function applySubmissions() {
  setHTML('submissions-body', submissionRows())
  setText('submissions-count', `当前显示 ${state.submissions.length} 条收录记录`)
}
function applyAudit() {
  setHTML('audit-body', auditRows())
}
const refreshStatus = guarded(async () => {
  state.status = await api('/admin/status')
  applyOverview()
})
const pollChecks = guarded(async () => {
  if (state.tab === 'overview') {
    state.checks = (await api('/admin/checks')) || []
    setHTML('checks-body', checksRows())
    setHTML('checks-status', checksSummary())
  }
})
const pollContestants = guarded(async () => {
  if (state.tab === 'contestants') {
    state.contestants = (await api('/admin/contestants')) || []
    applyContestants()
  }
})
const pollSubmissions = guarded(async () => {
  if (state.tab === 'submissions') {
    state.submissions = (await api('/admin/submissions' + queryString())) || []
    applySubmissions()
  }
})
const pollAudit = guarded(async () => {
  if (state.tab === 'system') {
    state.audit = (await api('/admin/audit')) || []
    applyAudit()
  }
})
function examActions() {
  const phase = examDisplayState(state.status?.exam)
  return phase === 'running'
    ? `<button data-exam="pause">${ui.icon('pause')}暂停考试</button>`
    : phase === 'paused'
      ? '<button class="primary" data-exam="resume">恢复考试</button>'
      : phase === 'finished'
        ? '<button data-exam="restart">重新开考</button>'
        : ''
}
function canSchedule(exam) {
  return ['unset', 'not_started'].includes(examDisplayState(exam))
}
function renderLogin() {
  state.timeEditor = null
  state.timeDrafts = {}
  app.innerHTML = ui.login('admin', state.error)
  document.getElementById('login-form').addEventListener('submit', login)
}
function renderOverview() {
  const s = state.status || {},
    needsChecks = examDisplayState(s.exam) !== 'running' || state.checks.some((c) => !c.ok)
  return `<section class="control-strip"><div><span id="exam-state">${examChip(examDisplayState(s.exam))}</span><h2 id="exam-name" style="margin-top:10px">${escapeHtml(s.exam?.name || '尚未导入比赛')}</h2><p class="schedule" id="exam-schedule">${escapeHtml(scheduleText(s.exam))}</p></div><div class="timer"><span id="countdown-label">${ui.clockLabel(s.exam)}</span><strong id="countdown">${ui.clockValue(s.exam)}</strong></div><div class="row"><button id="schedule-btn" ${canSchedule(s.exam) ? '' : 'hidden'}>设定考试时间</button><span id="exam-actions">${examActions()}</span></div></section>${renderTimeEditor()}<section class="overview-stats" aria-label="考场数据"><div class="stat"><div class="t">近 5 分钟活跃考生</div><div class="n"><span id="stat-online">${s.online ?? 0}</span><small> / <span id="stat-contestants">${s.contestant_count ?? 0}</span> 人</small></div></div><div class="stat"><div class="t">源码提交总数</div><div class="n"><span id="stat-submissions">${s.submission_count ?? 0}</span><small> 次</small></div></div><div class="stat"><div class="t">比赛题目</div><div class="n"><span id="stat-problems">${s.problem_count ?? 0}</span><small> 题</small></div></div></section><div class="workspace-grid"><section class="card"><header><h3>最近收录</h3><button class="text-button" data-tab="submissions">全部记录${ui.icon('arrow')}</button></header><div class="table-scroll"><table class="recent-table"><thead><tr><th>考生</th><th>题目</th><th>语言</th><th>时间</th><th></th></tr></thead><tbody id="recent-body">${recentRows()}</tbody></table></div></section><section class="card"><header><h3>各题提交人数</h3><span class="muted small">非通过人数</span></header><div class="body"><div id="by-problem-body">${byProblemRows()}</div><p class="muted small">同一考生同一题只计一人。</p></div></section></div><details class="checks" ${needsChecks ? 'open' : ''}><summary>启动检查 <span id="checks-status">${checksSummary()}</span></summary><div class="table-scroll"><table><thead><tr><th>检查项目</th><th>状态</th><th>说明</th></tr></thead><tbody id="checks-body">${checksRows()}</tbody></table></div></details><div class="overview-bottom"><button class="text-button danger-text" data-exam="abort" ${['running', 'paused'].includes(examDisplayState(s.exam)) ? '' : 'hidden'} id="abort-exam">中止考试…</button></div>`
}
function renderContestants() {
  return `<section class="card"><header><div><h2>考生名单</h2><p class="muted small">账户可用状态与交卷状态分别显示。</p></div><button class="primary" id="add-contestant">新增临时考生</button></header><div class="toolbar"><label><span>查找考生</span><input id="people-search" placeholder="学号或姓名" value="${escapeHtml(state.peopleFilter.query)}"></label><label class="compact-field"><span>状态筛选</span><select id="people-status"><option value="">全部状态</option><option value="normal">可用且未交卷</option><option value="finished">已交卷</option><option value="disabled">已禁用</option></select></label></div><div class="filter-summary" id="contestants-count"></div><div class="table-scroll"><table><thead><tr><th>学号</th><th>姓名</th><th>账户状态</th><th>交卷状态</th><th>最近 IP</th><th>操作</th></tr></thead><tbody id="contestants-body">${contestantRows()}</tbody></table></div></section>`
}
function renderSubmissions() {
  return `<section class="card"><header><div><h2>提交收录记录</h2><p class="muted small">收录表示服务器保存了源码，不包含判题结果。</p></div></header><form class="toolbar" id="submission-filter"><label><span>学号</span><input id="f-student" placeholder="输入完整学号" value="${escapeHtml(state.filter.student_id)}"></label><label class="compact-field"><span>题号</span><input id="f-label" placeholder="例如 A" value="${escapeHtml(state.filter.label)}"></label><label class="compact-field"><span>语言</span><select id="f-language"><option value="">全部语言</option><option value="cpp">C++</option><option value="java">Java</option><option value="python3">Python 3</option></select></label><button type="submit" id="f-apply">筛选记录</button><button type="button" class="ghost" id="f-reset">重置</button></form><div class="filter-summary" id="submissions-count"></div><div class="table-scroll"><table><thead><tr><th>编号</th><th>考生</th><th>题目</th><th>语言</th><th>收录时间</th><th>操作</th></tr></thead><tbody id="submissions-body">${submissionRows()}</tbody></table></div></section>`
}
function rulesPreview(value) {
  const rows = String(value)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  return rows.length
    ? rows.map((row) => `<li>${escapeHtml(row)}</li>`).join('')
    : '<li class="muted">暂无考生守则</li>'
}
function renderRules() {
  const value = state.rulesDraft ?? state.rules
  return `<section class="surface"><div class="surface-body"><div class="section-head"><div><h2>考生守则</h2><p class="muted small">每行一条规则；保存后，考生端可读取最新内容。</p></div></div><div class="rules-editor"><label><span>编辑内容</span><textarea id="rules-text" rows="12" spellcheck="false" placeholder="每行填写一条规则">${escapeHtml(value)}</textarea></label><section class="rules-preview"><h3>考生端预览</h3><ol class="rules" id="rules-preview">${rulesPreview(value)}</ol></section></div><div class="row"><button class="primary" id="rules-save">保存考生守则</button><span class="muted small" id="rules-feedback" role="status">${value === state.rules ? '修改无需重启服务' : '当前修改尚未保存'}</span></div></div></section>`
}
async function loadRules() {
  if (state.rulesLoaded || state.tab !== 'rules') return
  try {
    const data = await api('/admin/rules')
    state.rules = data.rules || ''
    state.rulesLoaded = true
    const input = document.getElementById('rules-text')
    if (input && state.rulesDraft === null) {
      input.value = state.rules
      setHTML('rules-preview', rulesPreview(state.rules))
    }
  } catch (error) {
    flash('error', error.message)
  }
}
function renderSystem() {
  return `<section class="settings-section"><h2>比赛包导入</h2><p>导入将替换当前考试的题目、考生与提交记录，请先导出需要保留的提交包。</p><div class="file-picker"><input type="file" id="import-file" accept=".zip"><label for="import-file" class="file-btn">${ui.icon('file')}选择比赛包 (.zip)</label><span class="file-name" id="import-name">未选择文件</span></div><button id="import-btn">导入比赛包</button></section><section class="settings-section"><h2>管理员密码</h2><p>修改当前管理员的登录密码。</p><form id="pw-form" class="password-grid"><label><span>原密码</span><input name="old_password" type="password" autocomplete="current-password" required></label><label><span>新密码</span><input name="new_password" type="password" autocomplete="new-password" required></label><button class="primary" type="submit">修改密码</button></form></section><section class="card"><header><div><h2>操作记录</h2><p class="small muted">查看考试操作与例外处理的记录。</p></div><button class="text-button danger-text" id="audit-clear">清空记录…</button></header><div class="table-scroll"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody id="audit-body">${auditRows()}</tbody></table></div></section>`
}
function render() {
  if (!state.admin) {
    renderLogin()
    return
  }
  const active = tabs.find((tab) => tab[0] === state.tab)
  const pages = {
    overview: renderOverview,
    contestants: renderContestants,
    submissions: renderSubmissions,
    rules: renderRules,
    system: renderSystem
  }
  app.innerHTML = `<div class="page"><header class="topbar">${ui.brand('现场管理')}<span class="header-context">程序设计竞赛 · 现场管理</span><div class="header-actions"><button class="primary" id="export" ${state.exporting ? 'disabled aria-busy="true"' : ''}>${ui.icon('download')}${state.exporting ? '正在生成提交包…' : '导出提交包'}</button><span id="connection">${ui.connection(state.connection)}</span><button class="text-button quiet" id="refresh">${ui.icon('refresh')}刷新状态</button><button class="text-button quiet" id="logout">退出登录</button></div></header><div class="admin-shell"><nav class="sidebar" aria-label="管理导航"><span class="eyebrow">现场管理</span>${tabs.map(([key, title, icon]) => `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}" ${state.tab === key ? 'aria-current="page"' : ''}>${ui.icon(icon)}${title}</button>`).join('')}<div class="admin-identity">管理员<br><strong>${escapeHtml(state.admin.username || 'admin')}</strong></div></nav><main class="admin-main"><div id="banner" class="toast" aria-live="polite"></div><div class="page-header"><div><span class="eyebrow">JUSTCPC · 现场管理</span><h1>${active[1]}</h1></div><span class="small muted">${state.tab === 'overview' ? '收录源码，赛后统一评测' : escapeHtml(state.status?.exam?.name || '尚未导入比赛')}</span></div>${pages[state.tab]()}</main></div>${ui.footer()}</div>`
  for (const key of Object.keys(htmlCache)) delete htmlCache[key]
  renderBanner()
  bindCommon()
  if (state.tab === 'overview') {
    bindOverview()
    applyOverview()
  }
  if (state.tab === 'contestants') {
    bindContestants()
    applyContestants()
  }
  if (state.tab === 'submissions') {
    bindSubmissions()
    applySubmissions()
  }
  if (state.tab === 'rules') {
    bindRules()
    loadRules()
  }
  if (state.tab === 'system') bindSystem()
}
function bindCommon() {
  document.getElementById('export').addEventListener('click', downloadSubmissionPackage)
  document.getElementById('logout').addEventListener('click', logout)
  document.getElementById('refresh').addEventListener('click', async () => {
    try {
      await refresh()
      render()
      setConnection(eventSource?.readyState === 1 ? 'connected' : state.connection)
      flash('notice', '状态已刷新')
    } catch (error) {
      flash('error', error.message)
    }
  })
  app.querySelectorAll('[data-tab]').forEach((button) =>
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab
      render()
      refreshActive()
    })
  )
}
function bindOverview() {
  bindTimeEditor()
  document.getElementById('schedule-btn')?.addEventListener('click', () => openTimeEditor())
}
function bindContestants() {
  document.getElementById('people-status').value = state.peopleFilter.status
  document.getElementById('people-search').addEventListener('input', (event) => {
    state.peopleFilter.query = event.target.value.trim()
    applyContestants()
  })
  document.getElementById('people-status').addEventListener('change', (event) => {
    state.peopleFilter.status = event.target.value
    applyContestants()
  })
}
async function applyFilter(event) {
  event?.preventDefault()
  state.filter = {
    student_id: document.getElementById('f-student').value.trim(),
    label: document.getElementById('f-label').value.trim(),
    language: document.getElementById('f-language').value
  }
  try {
    state.submissions = await api('/admin/submissions' + queryString())
    applySubmissions()
  } catch (error) {
    flash('error', error.message)
  }
}
function bindSubmissions() {
  document.getElementById('f-language').value = state.filter.language
  document.getElementById('submission-filter').addEventListener('submit', applyFilter)
  document.getElementById('f-reset').addEventListener('click', () => {
    for (const id of ['f-student', 'f-label', 'f-language']) document.getElementById(id).value = ''
    applyFilter()
  })
}
function bindRules() {
  const input = document.getElementById('rules-text')
  input.addEventListener('input', () => {
    state.rulesDraft = input.value
    setHTML('rules-preview', rulesPreview(input.value))
    setText('rules-feedback', '当前修改尚未保存')
  })
  document.getElementById('rules-save').addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    const value = input.value
    try {
      const data = await api('/admin/rules', {
        method: 'PUT',
        body: JSON.stringify({ rules: value })
      })
      state.rules = data.rules || ''
      state.rulesLoaded = true
      if (state.rulesDraft === value) state.rulesDraft = null
      setText(
        'rules-feedback',
        (state.rulesDraft ?? state.rules) === state.rules
          ? '考生守则已保存'
          : '已保存先前内容，当前新修改尚未保存'
      )
    } catch (error) {
      flash('error', error.message)
    } finally {
      button.disabled = false
    }
  })
}
function bindSystem() {
  const file = document.getElementById('import-file')
  file.addEventListener('change', () => setText('import-name', file.files[0]?.name || '未选择文件'))
  document.getElementById('import-btn').addEventListener('click', () => {
    if (!file.files[0]) flash('error', '请选择比赛包 ZIP')
    else showDialog({ importConfirm: true, file: file.files[0] })
  })
  document
    .getElementById('audit-clear')
    .addEventListener('click', () => showDialog({ clearAudit: true }))
  document.getElementById('pw-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target,
      button = form.querySelector('button')
    button.disabled = true
    try {
      await api('/admin/password', {
        method: 'POST',
        body: JSON.stringify({
          old_password: formValue(form, 'old_password'),
          new_password: formValue(form, 'new_password')
        })
      })
      form.reset()
      flash('notice', '管理员密码已修改')
    } catch (error) {
      flash('error', error.message)
    } finally {
      button.disabled = false
    }
  })
}
async function downloadSubmissionPackage() {
  if (state.exporting) return
  state.exporting = true
  const button = document.getElementById('export')
  if (button) {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.innerHTML = `${ui.icon('download')}正在生成提交包…`
  }
  try {
    const response = await fetch('/api/admin/export', {
      method: 'POST',
      credentials: 'same-origin'
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || `导出失败：${response.status}`)
    }
    const blob = await response.blob(),
      match = /filename="?([^";]+)"?/.exec(response.headers.get('Content-Disposition') || '')
    const url = URL.createObjectURL(blob),
      anchor = document.createElement('a')
    anchor.href = url
    anchor.download = match ? match[1] : 'submission-package.zip'
    anchor.click()
    URL.revokeObjectURL(url)
    flash('notice', '提交包已开始下载')
  } catch (error) {
    flash('error', error.message)
  } finally {
    state.exporting = false
    const current = document.getElementById('export')
    if (current) {
      current.disabled = false
      current.removeAttribute('aria-busy')
      current.innerHTML = `${ui.icon('download')}导出提交包`
    }
  }
}
async function performExamAction(action, reason = '') {
  await api('/admin/exam/' + action, { method: 'POST', body: JSON.stringify({ reason }) })
  closeDialog()
  await refresh()
  render()
  flash('notice', '考试状态已更新')
}
async function examAction(action) {
  if (action === 'restart') {
    openTimeEditor('restart')
    return
  }
  if (action === 'pause' || action === 'abort') {
    showDialog({ examAction: action })
    return
  }
  if (action === 'resume') {
    try {
      await performExamAction(action)
    } catch (error) {
      flash('error', error.message)
    }
  }
}
async function viewSource(id) {
  try {
    const item = await api('/admin/submissions/' + id + '/source')
    showDialog({
      title: `提交 #${item.id} · ${item.label} 题`,
      meta: `${item.student_id} · ${languageLabels[item.language] || item.language} · ${item.submitted_at}`,
      code: item.source
    })
  } catch (error) {
    flash('error', error.message)
  }
}
function openEdit(id) {
  const item = state.contestants.find((c) => String(c.id) === String(id))
  if (item) showDialog({ editContestant: item })
}
document.addEventListener('click', (event) => {
  const source = event.target.closest('[data-source]')
  if (source) {
    viewSource(source.dataset.source)
    return
  }
  const edit = event.target.closest('[data-edit]')
  if (edit) {
    openEdit(edit.dataset.edit)
    return
  }
  const action = event.target.closest('[data-exam]')
  if (action && !action.disabled) {
    examAction(action.dataset.exam)
    return
  }
  if (event.target.closest('#add-contestant')) showDialog({ addContestant: true })
})
function showDialog(dialog) {
  state.dialog = dialog
  state.error = ''
  state.notice = ''
  renderBanner()
  renderDialog()
}
const dialogActions = (label, danger = false) =>
  `<div class="dialog-actions"><button type="button" id="dialog-secondary">取消</button><button type="submit" class="${danger ? 'danger' : 'primary'}">${label}</button></div>`
function renderDialog() {
  const dialog = state.dialog
  if (!dialog) return
  let content,
    wide = false
  const exam = state.status?.exam || {}
  if (dialog.addContestant)
    content = `${ui.dialogHeader('新增临时考生')}<p class="dialog-description">请核对身份信息，并记录现场补录原因。</p><form id="add-form"><label><span>学号</span><input name="student_id" required></label><label><span>姓名</span><input name="name" required></label><label><span>初始密码</span><input name="password" type="password" autocomplete="new-password" required></label><label><span>补录原因（可选）</span><input name="reason"></label>${dialogActions('新增考生')}</form>`
  else if (dialog.editContestant) {
    const c = dialog.editContestant
    content = `${ui.dialogHeader('管理考生 · ' + c.student_id)}<form id="edit-form"><label><span>姓名</span><input name="name" value="${escapeHtml(c.name)}"></label><label><span>重置密码（留空不改）</span><input name="password" type="password" autocomplete="new-password"></label><h3 class="section-title">账户与交卷状态</h3><label class="check"><input type="checkbox" name="disabled" ${c.disabled ? 'checked' : ''}><span>禁用账户</span></label><label class="check"><input type="checkbox" name="finished" ${c.finished ? 'checked' : ''}><span>标记为已交卷</span></label><label><span>例外操作原因（可选）</span><input name="reason"></label>${dialogActions('保存考生信息')}</form>`
  } else if (dialog.importConfirm)
    content = `${ui.dialogHeader('确认导入比赛包？')}<p class="dialog-description">文件：${escapeHtml(dialog.file.name)}</p><div class="state-note"><h3>当前考试数据将被替换</h3><p>题目、考生及提交记录都会被替换，请先导出需要保留的提交包。</p></div><form id="import-form">${dialogActions('确认替换并导入', true)}</form>`
  else if (dialog.clearAudit)
    content = `${ui.dialogHeader('清空操作记录？')}<p class="dialog-description">现有审计日志将全部删除，此操作不可恢复。</p><form id="clear-audit-form">${dialogActions('确认清空记录', true)}</form>`
  else if (dialog.examAction) {
    const abort = dialog.examAction === 'abort'
    content = `${ui.dialogHeader(abort ? '中止当前考试？' : '暂停当前考试？')}<p class="dialog-description">${escapeHtml(exam.name || '当前比赛')}</p><div class="state-note"><p>${abort ? '所有考生将停止提交，本场考试会结束。请先确认现场安排。' : '暂停后所有考生暂时无法提交，考试结束时间仍按原安排执行。'}</p></div><form id="exam-action-form"><label><span>操作原因（可选）</span><input name="reason"></label>${dialogActions(abort ? '确认中止考试' : '确认暂停考试', abort)}</form>`
  } else {
    wide = true
    content = `${ui.dialogHeader(dialog.title || '源码')}<div class="dialog-meta"><span>${escapeHtml(dialog.meta || '')}</span><button id="copy-source">${ui.icon('copy')}复制源码</button></div><pre class="code">${escapeHtml(dialog.code || '')}</pre>`
  }
  ui.openDialog(content, closeDialog, wide)
  for (const id of ['dialog-cancel', 'dialog-secondary'])
    document.getElementById(id)?.addEventListener('click', closeDialog)
  document
    .getElementById('copy-source')
    ?.addEventListener('click', (event) => ui.copy(dialog.code || '', event.currentTarget))
  const bind = (id, action) =>
    document.getElementById(id)?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.target,
        button = form.querySelector('button[type="submit"]')
      ui.dialogAction(button, async () => {
        try {
          await action(form)
        } catch (error) {
          flash('error', error.message)
        }
      })
    })
  bind('exam-action-form', (form) =>
    performExamAction(dialog.examAction, formValue(form, 'reason'))
  )
  bind('add-form', async (form) => {
    await api('/admin/contestants', {
      method: 'POST',
      body: JSON.stringify({
        student_id: formValue(form, 'student_id'),
        name: formValue(form, 'name'),
        password: formValue(form, 'password'),
        reason: formValue(form, 'reason')
      })
    })
    closeDialog()
    state.contestants = await api('/admin/contestants')
    applyContestants()
    flash('notice', '已新增考生')
  })
  bind('edit-form', async (form) => {
    await api('/admin/contestants/' + dialog.editContestant.id, {
      method: 'PUT',
      body: JSON.stringify({
        name: formValue(form, 'name'),
        password: formValue(form, 'password'),
        disabled: formChecked(form, 'disabled'),
        finished: formChecked(form, 'finished'),
        reason: formValue(form, 'reason')
      })
    })
    closeDialog()
    state.contestants = await api('/admin/contestants')
    applyContestants()
    flash('notice', '考生信息已保存')
  })
  bind('import-form', async () => {
    const form = new FormData()
    form.append('file', dialog.file)
    const item = await api('/admin/import', { method: 'POST', body: form })
    state.timeEditor = null
    state.timeDrafts = {}
    state.rulesLoaded = false
    state.rulesDraft = null
    state.rules = ''
    closeDialog()
    await refresh()
    render()
    flash('notice', `已导入：${item.name}`)
  })
  bind('clear-audit-form', async () => {
    await api('/admin/audit', { method: 'DELETE' })
    closeDialog()
    state.audit = (await api('/admin/audit')) || []
    applyAudit()
    flash('notice', '操作记录已清空')
  })
}
function closeDialog() {
  state.dialog = null
  ui.removeDialogs()
  for (const refresh of [refreshStatus, pollChecks, pollContestants, pollSubmissions, pollAudit])
    refresh.flush()
}
function tickExam() {
  if (!state.admin) return
  const exam = state.status?.exam,
    phase = examClock(exam).phase
  setText('countdown', ui.clockValue(exam))
  setText('countdown-label', ui.clockLabel(exam))
  setHTML('exam-state', examChip(examDisplayState(exam)))
  setHTML('exam-actions', examActions())
  const schedule = document.getElementById('schedule-btn')
  if (schedule) schedule.hidden = !canSchedule(exam)
  const abort = document.getElementById('abort-exam')
  if (abort) abort.hidden = !['running', 'paused'].includes(examDisplayState(exam))
  if (state.phase && state.phase !== phase) {
    if (phase === 'running') {
      flash('notice', '考试已开始。')
      refreshActive()
    } else if (phase === 'ended') {
      flash('notice', '考试已结束。')
      refreshActive()
    }
  }
  state.phase = phase
}
setInterval(tickExam, 1000)
boot()
