'use strict'

const app = document.getElementById('app')
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
  dialog: null,
  filter: { student_id: '', label: '', language: '' },
  phase: null,
  rules: '',
}
const stateLabels = {
  unset: '时间未设定', not_started: '未开始', running: '进行中', paused: '已暂停', finished: '已结束',
}
const languageLabels = { cpp: 'C++', java: 'Java', python3: 'Python 3' }

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }
  const response = await fetch('/api' + path, {
    credentials: 'same-origin', ...options, headers: { ...headers, ...(options.headers || {}) },
  })
  if (response.status === 204) return undefined
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`)
  return data
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 用 elements.namedItem 读取表单字段：form.name 等会与 HTMLFormElement 内建属性冲突。
const formValue = (form, field) => form.elements.namedItem(field)?.value ?? ''
const formChecked = (form, field) => Boolean(form.elements.namedItem(field)?.checked)

function scheduleText(exam) {
  if (!exam?.exam_start_at || !exam?.exam_end_at) return '未设定'
  return `${exam.exam_start_at} ~ ${exam.exam_end_at}`
}

// datetime-local 值（YYYY-MM-DDTHH:mm）与 "YYYY-MM-DD HH:mm:ss" 互转（精确到分钟）
function toLocalInput(value) {
  if (!value) return ''
  return value.slice(0, 16).replace(' ', 'T')
}
function fromLocalInput(value) {
  if (!value) return ''
  const normalized = value.replace('T', ' ')
  return normalized.length === 16 ? normalized + ':00' : normalized
}

// 并发保护：同一轮询未完成前不重复发起。
function guarded(fn) {
  let busy = false
  return async () => {
    if (busy || !state.admin || state.dialog) return
    busy = true
    try { await fn() } catch { /* 瞬时错误忽略，下次再试 */ } finally { busy = false }
  }
}

// ---------- 局部更新工具（定点轮询，不重建整页） ----------

const htmlCache = {}

function setHTML(id, html) {
  if (htmlCache[id] === html) return
  const element = document.getElementById(id)
  if (!element) return
  element.innerHTML = html
  htmlCache[id] = html
}

function setText(id, value) {
  const element = document.getElementById(id)
  if (element && element.textContent !== String(value)) element.textContent = value
}

function renderBanner() {
  const element = document.getElementById('banner')
  if (!element) return
  if (state.error) element.innerHTML = `<div class="msg err">${escapeHtml(state.error)}</div>`
  else if (state.notice) element.innerHTML = `<div class="msg ok">${escapeHtml(state.notice)}</div>`
  else element.innerHTML = ''
}

function flash(kind, message) {
  if (kind === 'error') { state.error = message; state.notice = '' }
  else { state.notice = message; state.error = '' }
  renderBanner()
  setTimeout(() => { state.error = ''; state.notice = ''; renderBanner() }, 4000)
}

// ---------- 数据 ----------

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

async function refresh() {
  const [status, checks, contestants, submissions, audit] = await Promise.all([
    api('/admin/status'),
    api('/admin/checks'),
    api('/admin/contestants'),
    api('/admin/submissions' + queryString()),
    api('/admin/audit'),
  ])
  state.status = status
  state.checks = checks || []
  state.contestants = contestants || []
  state.submissions = submissions || []
  state.audit = audit || []
}

function queryString() {
  const params = new URLSearchParams()
  if (state.filter.student_id) params.set('student_id', state.filter.student_id)
  if (state.filter.label) params.set('label', state.filter.label)
  if (state.filter.language) params.set('language', state.filter.language)
  const value = params.toString()
  return value ? '?' + value : ''
}

async function login(event) {
  event.preventDefault()
  const form = event.target
  try {
    state.admin = await api('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: formValue(form, 'username'), password: formValue(form, 'password') }),
    })
    await refresh()
    render()
    startEvents()
  } catch (error) {
    flash('error', error.message)
  }
}

async function logout() {
  await api('/admin/logout', { method: 'POST' }).catch(() => {})
  stopEvents()
  state.admin = null
  state.dialog = null
  document.querySelectorAll('.dialog-mask').forEach((node) => node.remove())
  render()
}

// ---------- 长连接（SSE）：数据变更由服务端推送，前端重新拉取当前视图 ----------
let eventSource = null
let refreshTimer = null

function startEvents() {
  if (eventSource || !state.admin || !window.EventSource) return
  const source = new EventSource('/api/admin/events')
  source.onopen = () => { if (state.admin) refreshActive() }
  source.onmessage = scheduleRefresh
  source.onerror = () => { /* EventSource 会自动重连（retry: 3000） */ }
  eventSource = source
}

function stopEvents() {
  if (eventSource) { eventSource.close(); eventSource = null }
}

// 合并短时间内的多条事件，避免提交高峰期请求风暴。
function scheduleRefresh() {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshActive() }, 400)
}

// 刷新顶部状态与当前页签数据。
function refreshActive() {
  refreshStatus()
  if (state.tab === 'overview') pollChecks()
  else if (state.tab === 'contestants') pollContestants()
  else if (state.tab === 'submissions') pollSubmissions()
  else if (state.tab === 'system') pollAudit()
}

// ---------- 行渲染 ----------

const examChip = (stateName) => {
  const tone = stateName === 'running' ? 'green' : stateName === 'finished' || stateName === 'unset' ? 'gray' : 'amber'
  return `<span class="tag ${tone}">${stateLabels[stateName] || stateName || '—'}</span>`
}

function submissionRow(item) {
  return `<tr>
    <td class="mono">${item.id}</td><td class="mono">${escapeHtml(item.student_id)}</td><td>${escapeHtml(item.name)}</td>
    <td class="mono">${escapeHtml(item.label)}</td><td>${languageLabels[item.language] || item.language}</td><td>${escapeHtml(item.submitted_at)}</td>
    <td><button class="ghost" data-source="${item.id}">查看源码</button></td>
  </tr>`
}

function checksRows() {
  if (!state.checks.length) return '<tr><td colspan="3" class="muted">—</td></tr>'
  return state.checks.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${c.ok ? '<span class="tag green">通过</span>' : '<span class="tag red">未通过</span>'}</td><td class="muted">${escapeHtml(c.message)}</td></tr>`).join('')
}

function byProblemRows() {
  const byProblem = state.status?.submissions_by_problem || {}
  const keys = Object.keys(byProblem)
  if (!keys.length) return '<tr><td colspan="2" class="muted">暂无提交</td></tr>'
  return keys.map((label) => `<tr><td class="mono">${escapeHtml(label)}</td><td>${byProblem[label]}</td></tr>`).join('')
}

function recentRows() {
  const recent = state.status?.recent || []
  if (!recent.length) return '<tr><td colspan="6" class="muted">暂无提交</td></tr>'
  return recent.map(submissionRow).join('')
}

function contestantRows() {
  if (!state.contestants.length) return '<tr><td colspan="5" class="muted">暂无考生</td></tr>'
  return state.contestants.map((c) => `<tr>
    <td class="mono">${escapeHtml(c.student_id)}</td><td>${escapeHtml(c.name)}</td>
    <td>${c.disabled ? '<span class="tag red">已禁用</span>' : c.finished ? '<span class="tag amber">已交卷</span>' : '<span class="tag green">正常</span>'}</td>
    <td class="mono small">${escapeHtml(c.ip || '—')}</td>
    <td><button class="ghost" data-edit="${c.id}">管理</button></td>
  </tr>`).join('')
}

function submissionRows() {
  if (!state.submissions.length) return '<tr><td colspan="7" class="muted">暂无提交</td></tr>'
  return state.submissions.map(submissionRow).join('')
}

function auditRows() {
  if (!state.audit.length) return '<tr><td colspan="5" class="muted">暂无日志</td></tr>'
  return state.audit.map((a) => `<tr><td class="small mono">${escapeHtml(a.created_at)}</td><td>${escapeHtml(a.actor)}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.object_type)}#${escapeHtml(a.object_id)}</td><td class="small muted">${escapeHtml(a.detail_json)}</td></tr>`).join('')
}

// ---------- 定点更新 ----------

function applyOverview() {
  const status = state.status || {}
  setHTML('exam-state', examChip(examDisplayState(status.exam)))
  setText('exam-name', status.exam?.name || '未导入比赛')
  setText('exam-schedule', scheduleText(status.exam))
  setText('countdown', countdownText(status.exam))
  setHTML('exam-actions', examActions())
  const scheduleBtn = document.getElementById('schedule-btn')
  if (scheduleBtn) scheduleBtn.style.display = canSchedule(status.exam) ? '' : 'none'
  setText('stat-online', status.online ?? 0)
  setText('stat-contestants', status.contestant_count ?? 0)
  setText('stat-problems', status.problem_count ?? 0)
  setText('stat-submissions', status.submission_count ?? 0)
  setHTML('checks-body', checksRows())
  setHTML('by-problem-body', byProblemRows())
  setHTML('recent-body', recentRows())
}

function applyContestants() { setHTML('contestants-body', contestantRows()) }
function applySubmissions() { setHTML('submissions-body', submissionRows()) }
function applyAudit() { setHTML('audit-body', auditRows()) }

function applyActive() {
  if (state.tab === 'overview') applyOverview()
  else if (state.tab === 'contestants') applyContestants()
  else if (state.tab === 'submissions') applySubmissions()
  else if (state.tab === 'system') applyAudit()
}

// 数据由服务端事件驱动刷新；这些函数只拉取并更新对应局部，并按当前页签自我约束。
const refreshStatus = guarded(async () => {
  state.status = await api('/admin/status')
  applyOverview()
})
const pollChecks = guarded(async () => {
  if (state.tab !== 'overview') return
  state.checks = (await api('/admin/checks')) || []
  setHTML('checks-body', checksRows())
})
const pollContestants = guarded(async () => {
  if (state.tab !== 'contestants') return
  state.contestants = (await api('/admin/contestants')) || []
  applyContestants()
})
const pollSubmissions = guarded(async () => {
  if (state.tab !== 'submissions') return
  state.submissions = (await api('/admin/submissions' + queryString())) || []
  applySubmissions()
})
const pollAudit = guarded(async () => {
  if (state.tab !== 'system') return
  state.audit = (await api('/admin/audit')) || []
  applyAudit()
})

// ---------- 渲染（结构） ----------

function examActions() {
  const examState = examDisplayState(state.status?.exam)
  const buttons = []
  if (examState === 'running') { buttons.push(['pause', '暂停', '']); buttons.push(['abort', '强行中止考试', 'danger']) }
  if (examState === 'paused') { buttons.push(['resume', '恢复', 'primary']); buttons.push(['abort', '强行中止考试', 'danger']) }
  if (examState === 'finished') buttons.push(['restart', '重新比赛', 'primary'])
  return buttons.map(([action, label, cls]) => `<button class="${cls}" data-exam="${action}">${label}</button>`).join('')
}

// 仅未开始（含尚未设定时间）的比赛需要且允许设定考试时间。
function canSchedule(exam) {
  const phase = examDisplayState(exam)
  return phase === 'unset' || phase === 'not_started'
}

function renderLogin() {
  app.innerHTML = `
    <main class="login">
      <form class="box" id="login-form">
        <h1>JustCPC 管理后台</h1>
        <p class="hint">管理员登录</p>
        <div id="banner">${state.error ? `<div class="msg err">${escapeHtml(state.error)}</div>` : ''}</div>
        <label><span>用户名</span><input name="username" value="admin" autocomplete="username" required /></label>
        <label><span>密码</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button class="primary" style="width:100%">登录</button>
      </form>
    </main>`
  document.getElementById('login-form').addEventListener('submit', login)
}

function renderOverview() {
  const status = state.status || {}
  return `
    <div class="card"><div class="body">
      <div class="row">
        <h2 style="margin:0" id="exam-name">${escapeHtml(status.exam?.name || '未导入比赛')}</h2>
        <span id="exam-state">${examChip(examDisplayState(status.exam))}</span>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="muted">考试时间</span>
        <span class="mono" id="exam-schedule">${escapeHtml(scheduleText(status.exam))}</span>
        <button id="schedule-btn">设定考试时间</button>
        <span class="small muted">到达开始时间自动开考，到达截止时间自动结束。</span>
      </div>
      <div class="row" style="margin-top:14px" id="exam-actions">${examActions()}</div>
      <div class="row" style="margin-top:12px">
        <button id="export">导出提交包</button>
      </div>
    </div></div>

    <div class="grid">
      <div class="stat"><div class="n" id="stat-online">${status.online ?? 0}</div><div class="t">在线考生（5 分钟）</div></div>
      <div class="stat"><div class="n" id="stat-contestants">${status.contestant_count ?? 0}</div><div class="t">考生总数</div></div>
      <div class="stat"><div class="n" id="stat-problems">${status.problem_count ?? 0}</div><div class="t">题目数</div></div>
      <div class="stat"><div class="n" id="stat-submissions">${status.submission_count ?? 0}</div><div class="t">提交总数</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <header>启动检查</header>
      <table><thead><tr><th>项目</th><th>状态</th><th>说明</th></tr></thead><tbody id="checks-body">${checksRows()}</tbody></table>
    </div>

    <div class="card">
      <header>各题提交人数</header>
      <table><thead><tr><th>题号</th><th>提交人数</th></tr></thead><tbody id="by-problem-body">${byProblemRows()}</tbody></table>
    </div>

    <div class="card">
      <header>最近提交</header>
      <table><thead><tr><th>ID</th><th>学号</th><th>姓名</th><th>题号</th><th>语言</th><th>时间</th><th></th></tr></thead><tbody id="recent-body">${recentRows()}</tbody></table>
    </div>`
}

function renderContestants() {
  return `
    <div class="card"><header>考生名单<span class="spacer"></span><button class="primary" id="add-contestant">新增考生</button></header>
    <table><thead><tr><th>学号</th><th>姓名</th><th>状态</th><th>最近 IP</th><th>操作</th></tr></thead><tbody id="contestants-body">${contestantRows()}</tbody></table></div>`
}

function renderSubmissions() {
  return `
    <div class="card"><header>提交记录
      <span class="spacer"></span>
      <input id="f-student" placeholder="学号" value="${escapeHtml(state.filter.student_id)}" style="width:130px" />
      <input id="f-label" placeholder="题号" value="${escapeHtml(state.filter.label)}" style="width:90px" />
      <button id="f-apply">筛选</button>
    </header>
    <table><thead><tr><th>ID</th><th>学号</th><th>姓名</th><th>题号</th><th>语言</th><th>时间</th><th></th></tr></thead><tbody id="submissions-body">${submissionRows()}</tbody></table></div>`
}

function renderRules() {
  return `
    <div class="card"><header>考生守则</header><div class="body">
      <p class="small muted" style="margin-top:0">每行一条规则。保存后，考生在登录页与考试过程中都能看到最新内容。</p>
      <textarea id="rules-text" rows="14" spellcheck="false" placeholder="每行一条考生守则">${escapeHtml(state.rules)}</textarea>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="rules-save">保存考生守则</button>
        <span class="small muted">修改立即生效，无需重启服务。</span>
      </div>
    </div></div>`
}

async function loadRules() {
  try {
    const data = await api('/admin/rules')
    state.rules = data.rules || ''
    const element = document.getElementById('rules-text')
    if (element) element.value = state.rules
  } catch (error) {
    flash('error', error.message)
  }
}

function bindRules() {
  loadRules()
  document.getElementById('rules-save')?.addEventListener('click', async () => {
    const value = document.getElementById('rules-text')?.value ?? ''
    try {
      const data = await api('/admin/rules', { method: 'PUT', body: JSON.stringify({ rules: value }) })
      state.rules = data.rules || ''
      flash('notice', '考生守则已保存')
    } catch (error) {
      flash('error', error.message)
    }
  })
}

function renderSystem() {
  return `
    <div class="card"><header>比赛包导入</header><div class="body">
      <div class="file-picker">
        <input type="file" id="import-file" accept=".zip" hidden />
        <label for="import-file" class="file-btn">选择比赛包 (.zip)</label>
        <span class="file-name muted small" id="import-name">未选择文件</span>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="import-btn">导入比赛包</button>
        <span class="small muted">导入将替换当前考试数据，请务必在正式考试前完成。</span>
      </div>
    </div></div>

    <div class="card"><header>管理员密码</header><div class="body">
      <form id="pw-form" class="row" style="align-items:flex-end">
        <label style="margin:0"><span>原密码</span><input name="old_password" type="password" /></label>
        <label style="margin:0"><span>新密码</span><input name="new_password" type="password" /></label>
        <button class="primary">修改密码</button>
      </form>
    </div></div>

    <div class="card"><header>审计日志<span class="spacer"></span><button id="audit-clear">清空日志</button></header>
      <table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody id="audit-body">${auditRows()}</tbody></table></div>`
}

function render() {
  if (!state.admin) { renderLogin(); return }
  const tabs = [['overview', '总览'], ['contestants', '考生'], ['submissions', '提交'], ['rules', '考生守则'], ['system', '系统']]
  app.innerHTML = `
    <div class="topbar">
      <span class="brand">JustCPC 管理后台</span>
      <span class="who">${escapeHtml(state.status?.exam?.name || '')}</span>
      <span class="spacer"></span>
      <span class="who mono" id="countdown">${escapeHtml(countdownText(state.status?.exam))}</span>
      <button class="ghost" id="refresh" style="color:#cfd9e3">刷新</button>
      <button class="ghost" id="logout" style="color:#cfd9e3">退出</button>
    </div>
    <div class="wrap">
      <div id="banner" class="toast"></div>
      <div class="row" style="margin-bottom:16px">
        ${tabs.map(([key, label]) => `<button class="${state.tab === key ? 'primary' : ''}" data-tab="${key}">${label}</button>`).join('')}
      </div>
      ${state.tab === 'overview' ? renderOverview() : ''}
      ${state.tab === 'contestants' ? renderContestants() : ''}
      ${state.tab === 'submissions' ? renderSubmissions() : ''}
      ${state.tab === 'rules' ? renderRules() : ''}
      ${state.tab === 'system' ? renderSystem() : ''}
    </div>`

  for (const key of Object.keys(htmlCache)) delete htmlCache[key]
  renderBanner()
  bindCommon()
  if (state.tab === 'overview') bindOverview()
  if (state.tab === 'submissions') bindSubmissions()
  if (state.tab === 'rules') bindRules()
  if (state.tab === 'system') bindSystem()
  if (state.tab === 'overview') applyOverview()
}

function bindCommon() {
  document.getElementById('logout').addEventListener('click', logout)
  document.getElementById('refresh').addEventListener('click', async () => {
    try { await refresh(); render(); flash('notice', '已刷新') } catch (error) { flash('error', error.message) }
  })
  app.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab
      render()
      refreshActive() // 切换页签时拉取该页签最新数据
    })
  })
}

function bindOverview() {
  document.getElementById('schedule-btn')?.addEventListener('click', () => showDialog({ schedule: true }))
  document.getElementById('export')?.addEventListener('click', downloadSubmissionPackage)
}

// 提交包统一走浏览器下载，系统内不额外存储。
async function downloadSubmissionPackage() {
  try {
    const response = await fetch('/api/admin/export', { method: 'POST', credentials: 'same-origin' })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || `导出失败：${response.status}`)
    }
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const match = /filename="?([^"]+)"?/.exec(disposition)
    const filename = match ? match[1] : 'submission-package.zip'
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    flash('notice', '提交包已开始下载')
  } catch (error) {
    flash('error', error.message)
  }
}

async function examAction(action) {
  if (action === 'restart') { showDialog({ restart: true }); return }
  const reason = (action === 'pause' || action === 'abort') ? prompt('请输入操作原因（可选）') ?? '' : ''
  try {
    await api('/admin/exam/' + action, { method: 'POST', body: JSON.stringify({ reason }) })
    await refresh()
    render()
    flash('notice', '状态已更新')
  } catch (error) {
    flash('error', error.message)
  }
}

async function viewSource(id) {
  try {
    const item = await api('/admin/submissions/' + id + '/source')
    showDialog({ title: `提交 #${item.id} · ${item.student_id} · ${item.label}`, code: item.source })
  } catch (error) {
    flash('error', error.message)
  }
}

function openEdit(id) {
  const item = state.contestants.find((c) => String(c.id) === String(id))
  if (item) showDialog({ editContestant: item })
}

async function applyFilter() {
  state.filter.student_id = document.getElementById('f-student').value.trim()
  state.filter.label = document.getElementById('f-label').value.trim()
  try {
    state.submissions = await api('/admin/submissions' + queryString())
    applySubmissions()
  } catch (error) {
    flash('error', error.message)
  }
}

function bindSubmissions() {
  document.getElementById('f-apply')?.addEventListener('click', applyFilter)
}

function bindSystem() {
  const importFile = document.getElementById('import-file')
  importFile?.addEventListener('change', () => {
    setText('import-name', importFile.files[0]?.name || '未选择文件')
  })
  document.getElementById('import-btn')?.addEventListener('click', () => {
    const file = importFile?.files[0]
    if (!file) { flash('error', '请选择比赛包 ZIP'); return }
    showDialog({ importConfirm: true })
  })
  document.getElementById('audit-clear')?.addEventListener('click', async () => {
    if (!confirm('确定清空全部审计日志？此操作不可撤销。')) return
    try {
      await api('/admin/audit', { method: 'DELETE' })
      state.audit = (await api('/admin/audit')) || []
      applyAudit()
      flash('notice', '审计日志已清空')
    } catch (error) {
      flash('error', error.message)
    }
  })
  document.getElementById('pw-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    try {
      await api('/admin/password', { method: 'POST', body: JSON.stringify({ old_password: formValue(form, 'old_password'), new_password: formValue(form, 'new_password') }) })
      form.reset()
      flash('notice', '密码已修改')
    } catch (error) {
      flash('error', error.message)
    }
  })
}

// 行内按钮用事件委托：局部更新替换 tbody 后无需重新绑定。
document.addEventListener('click', (event) => {
  const source = event.target.closest('[data-source]')
  if (source) { viewSource(source.dataset.source); return }
  const edit = event.target.closest('[data-edit]')
  if (edit) { openEdit(edit.dataset.edit); return }
  const examBtn = event.target.closest('[data-exam]')
  if (examBtn) { examAction(examBtn.dataset.exam); return }
  if (event.target.closest('#add-contestant')) { showDialog({ addContestant: true }) }
})

// ---------- 弹窗 ----------

function showDialog(dialog) {
  state.dialog = dialog
  renderDialog()
}

function renderDialog() {
  const dialog = state.dialog
  if (!dialog) return
  document.querySelectorAll('.dialog-mask').forEach((node) => node.remove())
  const mask = document.createElement('div')
  mask.className = 'dialog-mask'
  if (dialog.schedule) {
    const exam = state.status?.exam || {}
    mask.innerHTML = `<div class="dialog">
      <h3>设定考试时间</h3>
      <p class="muted small">导入比赛信息后由考试平台设定。到达开始时间自动开考，到达截止时间自动结束。</p>
      <form id="schedule-form">
        <label><span>开始时间</span><input type="datetime-local" name="exam_start_at" required value="${toLocalInput(exam.exam_start_at)}" /></label>
        <label><span>结束时间</span><input type="datetime-local" name="exam_end_at" required value="${toLocalInput(exam.exam_end_at)}" /></label>
        <div class="row" style="justify-content:flex-end"><button type="button" id="dialog-cancel">取消</button><button class="primary">保存</button></div>
      </form></div>`
  } else if (dialog.restart) {
    mask.innerHTML = `<div class="dialog">
      <h3>重新比赛</h3>
      <p class="muted small">重置为未开始并设定新的比赛时间；可选择是否清空先前的提交。</p>
      <form id="restart-form">
        <label><span><input type="radio" name="clear" value="no" checked /> 保留先前提交</span></label>
        <label><span><input type="radio" name="clear" value="yes" /> 清空先前提交</span></label>
        <label><span>开始时间</span><input type="datetime-local" name="exam_start_at" required /></label>
        <label><span>结束时间</span><input type="datetime-local" name="exam_end_at" required /></label>
        <div class="row" style="justify-content:flex-end"><button type="button" id="dialog-cancel">取消</button><button class="primary">重新开始</button></div>
      </form></div>`
  } else if (dialog.addContestant) {
    mask.innerHTML = `<div class="dialog">
      <h3>新增临时考生</h3>
      <form id="add-form">
        <label><span>学号</span><input name="student_id" required /></label>
        <label><span>姓名</span><input name="name" required /></label>
        <label><span>初始密码</span><input name="password" required /></label>
        <label><span>原因</span><input name="reason" placeholder="补录原因" /></label>
        <div class="row" style="justify-content:flex-end"><button type="button" id="dialog-cancel">取消</button><button class="primary">添加</button></div>
      </form></div>`
  } else if (dialog.editContestant) {
    const c = dialog.editContestant
    mask.innerHTML = `<div class="dialog">
      <h3>管理考生 · ${escapeHtml(c.student_id)}</h3>
      <form id="edit-form">
        <label><span>姓名</span><input name="name" value="${escapeHtml(c.name)}" /></label>
        <label><span>重置密码（留空不改）</span><input name="password" type="password" /></label>
        <label><span><input type="checkbox" name="disabled" ${c.disabled ? 'checked' : ''}/> 禁用账户</span></label>
        <label><span><input type="checkbox" name="finished" ${c.finished ? 'checked' : ''}/> 标记已交卷（解除/设置）</span></label>
        <label><span>原因</span><input name="reason" placeholder="例外操作原因" /></label>
        <div class="row" style="justify-content:flex-end"><button type="button" id="dialog-cancel">取消</button><button class="primary">保存</button></div>
      </form></div>`
  } else if (dialog.importConfirm) {
    const finished = state.status?.exam?.state === 'finished'
    mask.innerHTML = `<div class="dialog">
      <h3>确认导入比赛包？</h3>
      <p class="muted">导入新的比赛包会<strong>清空当前比赛的全部数据</strong>（题目、考生、提交记录都会被替换），且不可恢复。${finished ? '当前比赛已结束，请务必先导出提交包。' : ''}</p>
      <div class="row" style="justify-content:flex-end">
        <button id="dialog-cancel">取消</button>
        <button class="danger" id="dialog-import-ok">确认导入</button>
      </div>
    </div>`
  } else {
    mask.innerHTML = `<div class="dialog">
      <h3>${escapeHtml(dialog.title || '')}</h3>
      <pre class="code">${escapeHtml(dialog.code || '')}</pre>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="dialog-cancel">关闭</button></div>
    </div>`
  }
  document.body.appendChild(mask)
  mask.addEventListener('click', (event) => { if (event.target === mask) closeDialog() })
  document.getElementById('dialog-cancel')?.addEventListener('click', closeDialog)
  if (dialog.importConfirm) {
    document.getElementById('dialog-import-ok')?.addEventListener('click', async () => {
      const file = document.getElementById('import-file')?.files[0]
      if (!file) { closeDialog(); flash('error', '请选择比赛包 ZIP'); return }
      const form = new FormData()
      form.append('file', file)
      try {
        const item = await api('/admin/import', { method: 'POST', body: form })
        closeDialog()
        await refresh()
        render()
        flash('notice', `已导入：${item.name}`)
      } catch (error) {
        flash('error', error.message)
      }
    })
  }
  document.getElementById('add-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    try {
      await api('/admin/contestants', { method: 'POST', body: JSON.stringify({
        student_id: formValue(form, 'student_id'), name: formValue(form, 'name'),
        password: formValue(form, 'password'), reason: formValue(form, 'reason'),
      }) })
      closeDialog()
      state.contestants = await api('/admin/contestants')
      applyContestants()
      flash('notice', '已新增考生')
    } catch (error) { flash('error', error.message) }
  })
  document.getElementById('schedule-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    try {
      await api('/admin/exam/schedule', { method: 'PUT', body: JSON.stringify({
        exam_start_at: fromLocalInput(formValue(form, 'exam_start_at')),
        exam_end_at: fromLocalInput(formValue(form, 'exam_end_at')),
      }) })
      closeDialog()
      await refresh()
      render()
      flash('notice', '考试时间已保存')
    } catch (error) { flash('error', error.message) }
  })
  document.getElementById('restart-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    try {
      await api('/admin/exam/restart', { method: 'PUT', body: JSON.stringify({
        clear_submissions: formValue(form, 'clear') === 'yes',
        exam_start_at: fromLocalInput(formValue(form, 'exam_start_at')),
        exam_end_at: fromLocalInput(formValue(form, 'exam_end_at')),
      }) })
      closeDialog()
      await refresh()
      render()
      flash('notice', '比赛已重新开始')
    } catch (error) { flash('error', error.message) }
  })
  document.getElementById('edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    try {
      await api('/admin/contestants/' + dialog.editContestant.id, { method: 'PUT', body: JSON.stringify({
        name: formValue(form, 'name'), password: formValue(form, 'password'),
        disabled: formChecked(form, 'disabled'), finished: formChecked(form, 'finished'), reason: formValue(form, 'reason'),
      }) })
      closeDialog()
      state.contestants = await api('/admin/contestants')
      applyContestants()
      flash('notice', '已保存')
    } catch (error) { flash('error', error.message) }
  })
}

function closeDialog() {
  state.dialog = null
  document.querySelectorAll('.dialog-mask').forEach((node) => node.remove())
}

// 倒计时与状态标签在本地每秒走动（时钟已由响应头 Date 校准），到点立即刷新，无需等待轮询。
function tickExam() {
  const exam = state.status?.exam
  const phase = examClock(exam).phase
  setText('countdown', countdownText(exam))
  setHTML('exam-state', examChip(examDisplayState(exam)))
  setHTML('exam-actions', examActions())
  const scheduleBtn = document.getElementById('schedule-btn')
  if (scheduleBtn) scheduleBtn.style.display = canSchedule(exam) ? '' : 'none'
  if (state.phase && state.phase !== phase) {
    if (phase === 'running') { flash('notice', '考试已开始。'); refreshActive() }
    else if (phase === 'ended') { flash('notice', '考试已结束。'); refreshActive() }
  }
  state.phase = phase
}
setInterval(tickExam, 1000)

boot()
