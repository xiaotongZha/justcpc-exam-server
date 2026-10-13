'use strict'

const app = document.getElementById('app')
const state = {
  me: null,
  exam: null,
  open: false,
  problems: [],
  submissions: [],
  view: 'list', // rules | list | submit
  draft: { label: '', language: 'cpp' },
  drafts: {}, // 每题独立草稿：label -> source
  error: '',
  notice: '',
  dialog: null,
  phase: null,
}
const languageLabels = { cpp: 'C++', java: 'Java', python3: 'Python 3' }
const stateLabels = {
  unset: '时间未设定', not_started: '未开始', running: '进行中', paused: '已暂停', finished: '已结束',
}

// 考生守则由管理端维护，随 /api/exam 一起下发（每行一条）。
const rulesListHtml = () => {
  const lines = String(state.exam?.rules || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return '<li class="muted">管理员尚未设置考生守则。</li>'
  return lines.map((text) => `<li>${escapeHtml(text)}</li>`).join('')
}

function examTimeText() {
  const exam = state.exam || {}
  if (!exam.exam_start_at || !exam.exam_end_at) return ''
  return `${exam.exam_start_at} ~ ${exam.exam_end_at}`
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  })
  if (response.status === 204) return undefined
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`)
  return data
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 服务器时钟由 clock.js 的全局 fetch 拦截器用响应头 Date 校准；倒计时与状态标签均在本地每秒走动。
function syncCountdown() {
  const exam = state.exam
  const phase = examClock(exam).phase
  setText('countdown', countdownText(exam))
  setHTML('exam-state', examChip(examDisplayState(exam)))
  if (state.phase && state.phase !== phase) {
    if (phase === 'running') { flash('notice', '考试已开始，现在可以提交代码。'); pollExam() }
    else if (phase === 'ended') { flash('notice', '考试已结束，提交已停止。'); pollExam() }
  }
  state.phase = phase
}

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
  setTimeout(() => { state.error = ''; state.notice = ''; renderBanner() }, 3500)
}

function guarded(fn) {
  let busy = false
  return async () => {
    if (busy || !state.me || state.dialog) return
    busy = true
    try { await fn() } catch { /* 瞬时错误忽略，下次再试 */ } finally { busy = false }
  }
}

async function boot() {
  try {
    state.me = await api('/me')
    await refreshAll()
    state.view = 'list'
  } catch {
    state.me = null
  }
  render()
  if (state.me) startEvents()
}

async function refreshAll() {
  const [exam, problems, submissions] = await Promise.all([api('/exam'), api('/problems'), api('/submissions')])
  state.exam = exam
  state.open = problems.open
  state.problems = problems.problems || []
  state.submissions = submissions || []
}

async function login(event) {
  event.preventDefault()
  const form = event.target
  try {
    state.me = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ student_id: form.elements.namedItem('student_id').value, password: form.elements.namedItem('password').value }),
    })
    await refreshAll()
    state.draft = { label: state.problems[0]?.label || '', language: 'cpp' }
    state.drafts = {}
    state.view = 'rules'
    render()
    startEvents()
  } catch (error) {
    flash('error', error.message)
  }
}

async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {})
  stopEvents()
  closeDialog()
  state.me = null
  render()
}

// ---------- 长连接（SSE）：只订阅考试状态事件，开考/结束即时刷新 ----------
let eventSource = null

function startEvents() {
  if (eventSource || !state.me || !window.EventSource) return
  const source = new EventSource('/api/events')
  source.onopen = () => { if (state.me) pollExam() }
  source.onmessage = () => pollExam()
  source.onerror = () => { /* EventSource 会自动重连（retry: 3000） */ }
  eventSource = source
}

function stopEvents() {
  if (eventSource) { eventSource.close(); eventSource = null }
}

// ---------- 定点更新 ----------

const examChip = (name) => {
  const tone = name === 'running' ? 'green' : name === 'finished' || name === 'unset' ? 'gray' : 'amber'
  return `<span class="tag ${tone}">${stateLabels[name] || name || '—'}</span>`
}

function problemRows() {
  if (!state.problems.length) return '<tr><td colspan="6" class="muted">考试尚未开始或题目暂不可见。</td></tr>'
  return state.problems.map((item) => {
    const submitted = item.status === 'submitted'
    const last = submitted ? `${languageLabels[item.last_language] || item.last_language} · ${escapeHtml(item.last_submitted_at)}` : '—'
    return `<tr>
      <td class="mono">${escapeHtml(item.label)}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.score)}</td>
      <td>${submitted ? '<span class="tag green">已提交</span>' : '<span class="tag gray">未提交</span>'}</td>
      <td class="small muted">${last}</td>
      <td>
        <button class="ghost" data-action="answer" data-label="${escapeHtml(item.label)}" ${state.open ? '' : 'disabled'}>作答</button>
        <button class="ghost" data-action="last" data-label="${escapeHtml(item.label)}">查看源码</button>
      </td>
    </tr>`
  }).join('')
}

function submissionRows() {
  if (!state.submissions.length) return '<tr><td colspan="4" class="muted">暂无提交</td></tr>'
  return state.submissions.map((s) => `<tr><td class="mono">${s.id}</td><td class="mono">${escapeHtml(s.label)}</td><td>${languageLabels[s.language] || s.language}</td><td>${escapeHtml(s.submitted_at)}</td></tr>`).join('')
}

function applyExam() {
  const exam = state.exam || {}
  setText('countdown', countdownText(exam))
  setHTML('exam-state', examChip(examDisplayState(exam)))
  const time = examTimeText()
  if (time) setText('exam-time', time)
  const disabled = !state.open
  for (const id of ['do-submit', 'source', 'label-select', 'language-select']) {
    const element = document.getElementById(id)
    if (element) element.disabled = disabled
  }
  const early = document.getElementById('early')
  if (early) early.disabled = disabled
}

function applyProblems() {
  setHTML('problems-body', problemRows())
  const select = document.getElementById('label-select')
  if (select) {
    const wanted = state.problems.map((p) => p.label).join(',')
    if (select.dataset.labels !== wanted) {
      const current = select.value
      select.innerHTML = state.problems.map((p) => `<option value="${escapeHtml(p.label)}">${escapeHtml(p.label)} · ${escapeHtml(p.title)}</option>`).join('')
      select.dataset.labels = wanted
      select.value = state.problems.some((p) => p.label === current) ? current : state.draft.label
    }
  }
}

const pollExam = guarded(async () => {
  const exam = await api('/exam')
  const changed = exam.state !== state.exam?.state
  state.exam = exam
  state.open = exam.state === 'running'
  applyExam()
  if (changed) {
    const problems = await api('/problems')
    state.open = problems.open
    state.problems = problems.problems || []
    applyProblems()
  }
})

// ---------- 三个页面 ----------

function rulesView() {
  return `
    <div class="card">
      <header>考生守则</header>
      <div class="body">
        <ol class="rules">${rulesListHtml()}</ol>
        <div class="row" style="margin-top:16px">
          <button class="primary" id="rules-start">我已阅读，开始答题</button>
          <span class="small muted">${state.open ? '' : '考试尚未开始，进入后可等待管理员开考。'}</span>
        </div>
      </div>
    </div>`
}

function examTimeBar() {
  const text = examTimeText()
  if (!text) return ''
  return `<div class="row" style="margin-bottom:12px"><span class="muted small">考试时间：<span class="mono" id="exam-time">${escapeHtml(text)}</span></span></div>`
}

function listView() {
  return `
    ${examTimeBar()}
    <div class="card">
      <header>题目列表
        <span class="spacer"></span>
        <button id="download" title="加密压缩包，开考时由监考员公布解压密码">下载题面</button>
        <button id="history">提交记录</button>
      </header>
      <table>
        <thead><tr><th>题号</th><th>标题</th><th>分值</th><th>状态</th><th>最后提交</th><th>操作</th></tr></thead>
        <tbody id="problems-body">${problemRows()}</tbody>
      </table>
    </div>
    <div class="card"><div class="body row">
      <span class="muted small">请以最后一次提交为准；提交后可在列表查看状态与源码。</span>
      <span class="spacer" style="flex:1"></span>
      <button class="danger" id="early" ${state.open ? '' : 'disabled'}>提前交卷</button>
    </div></div>`
}

function submitView() {
  const options = state.problems.map((p) => `<option value="${escapeHtml(p.label)}">${escapeHtml(p.label)} · ${escapeHtml(p.title)}</option>`).join('')
  const open = state.open
  return `
    ${examTimeBar()}
    <div class="row" style="margin-bottom:16px">
      <button class="ghost" id="back-list">← 返回题目列表</button>
      <h2 style="margin:0">提交代码</h2>
      <span class="spacer" style="flex:1"></span>
      <button id="download" title="加密压缩包，开考时由监考员公布解压密码">下载题面</button>
    </div>
    <div class="card"><div class="body">
      <div class="row" style="align-items:flex-end">
        <label style="margin:0;min-width:260px"><span>题目</span>
          <select name="label" id="label-select" data-labels="${state.problems.map((p) => p.label).join(',')}" ${open ? '' : 'disabled'}>${options}</select>
        </label>
        <label style="margin:0;min-width:160px"><span>语言</span>
          <select name="language" id="language-select" ${open ? '' : 'disabled'}>
            <option value="cpp">C++</option><option value="java">Java</option><option value="python3">Python 3</option>
          </select>
        </label>
      </div>
      <label style="margin-top:12px"><span>源代码</span>
        <textarea id="source" rows="18" spellcheck="false" ${open ? '' : 'disabled'} placeholder="在此粘贴源代码"></textarea>
      </label>
      <div class="row" style="margin-top:12px">
        <button type="button" class="primary" id="do-submit" ${open ? '' : 'disabled'}>提交</button>
        <span id="submit-feedback" class="small"></span>
      </div>
      <p class="small muted" style="margin:8px 0 0">提交仅表示已保存，不代表通过与否。</p>
    </div></div>`
}

// ---------- 导航与渲染 ----------

function shell(content) {
  const exam = state.exam || {}
  return `
    <div class="topbar">
      <span class="brand" title="江苏科技大学程序设计竞赛平台"><img class="logo-badge" src="/assets/logos/contest.png" alt="" />JustCPC</span>
      <span class="who">${escapeHtml(exam.name || '')}</span>
      <span class="spacer"></span>
      <span id="exam-state">${examChip(examDisplayState(exam))}</span>
      <span class="who mono" id="countdown">${escapeHtml(countdownText(exam))}</span>
      <span class="who">${escapeHtml(state.me?.name || '')}（${escapeHtml(state.me?.student_id || '')}）</span>
      <button class="ghost" id="rules-btn" style="color:#cfd9e3">考生守则</button>
      <button class="ghost" id="logout" style="color:#cfd9e3">退出</button>
    </div>
    <div class="wrap">
      <div id="banner" class="toast"></div>
      ${content}
      <footer class="site-foot">
        <span class="org"><span class="role">主办</span><img src="/assets/logos/school.png" alt="校徽" /><span>江苏科技大学</span></span>
        <span class="dot">·</span>
        <span class="org"><span class="role">承办</span><img src="/assets/logos/association.png" alt="计算机协会会徽" /><span>计算机协会</span></span>
      </footer>
    </div>`
}

function goList() { state.view = 'list'; render() }
function goSubmit(label) {
  if (label) state.draft.label = label
  if (!state.draft.label) state.draft.label = state.problems[0]?.label || ''
  state.view = 'submit'
  render()
}

function render() {
  if (!state.me) { renderLogin(); return }
  const content = state.view === 'rules' ? rulesView() : state.view === 'submit' ? submitView() : listView()
  app.innerHTML = shell(content)
  for (const key of Object.keys(htmlCache)) delete htmlCache[key]
  renderBanner()
  document.getElementById('logout').addEventListener('click', logout)
  document.getElementById('rules-btn')?.addEventListener('click', () => { state.view = 'rules'; render() })
  document.getElementById('rules-start')?.addEventListener('click', () => { state.view = 'list'; render() })
  document.getElementById('back-list')?.addEventListener('click', goList)
  document.getElementById('download')?.addEventListener('click', downloadStatement)
  document.getElementById('history')?.addEventListener('click', () => showDialog({ history: true }))
  document.getElementById('early')?.addEventListener('click', () => showDialog({ confirmEarly: true }))
  const source = document.getElementById('source')
  const loadDraft = () => { if (source) source.value = state.drafts[state.draft.label] || '' }
  const labelSelect = document.getElementById('label-select')
  if (labelSelect) {
    labelSelect.value = state.draft.label || state.problems[0]?.label || ''
    state.draft.label = labelSelect.value
    labelSelect.addEventListener('change', () => {
      state.draft.label = labelSelect.value
      loadDraft()
    })
  }
  const languageSelect = document.getElementById('language-select')
  if (languageSelect) {
    languageSelect.value = state.draft.language || 'cpp'
    state.draft.language = languageSelect.value
    languageSelect.addEventListener('change', () => { state.draft.language = languageSelect.value })
  }
  if (source) {
    loadDraft()
    source.addEventListener('input', () => { state.drafts[state.draft.label] = source.value })
  }
  document.getElementById('do-submit')?.addEventListener('click', submitCode)
  applyExam()
}

function renderLogin() {
  app.innerHTML = `
    <main class="login">
      <header class="school-head">
        <img src="/assets/logos/school.png" alt="校徽" />
        <div>
          <div class="name">江苏科技大学</div>
          <div class="sub">程序设计竞赛平台</div>
        </div>
      </header>
      <form class="box" id="login-form">
        <img class="emblem" src="/assets/logos/contest.png" alt="比赛标志" />
        <h1>JustCPC</h1>
        <p class="hint">请使用学号与密码登录</p>
        <div id="banner">${state.error ? `<div class="msg err">${escapeHtml(state.error)}</div>` : ''}</div>
        <label><span>学号</span><input name="student_id" autocomplete="username" required /></label>
        <label><span>密码</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button class="primary" style="width:100%">登录</button>
      </form>
      <footer class="foot">
        <span>承办单位</span>
        <img src="/assets/logos/association.png" alt="计算机协会会徽" />
        <b>计算机协会</b>
      </footer>
    </main>`
  document.getElementById('login-form').addEventListener('submit', login)
}

function downloadStatement() {
  window.open('/api/statement', '_blank')
}

// ---------- 提交 ----------

async function submitCode() {
  const label = state.draft.label
  const language = state.draft.language
  const source = document.getElementById('source')?.value ?? ''
  if (!label) { setSubmitFeedback('请选择题目', 'err'); return }
  if (!source.trim()) { setSubmitFeedback('源码不能为空', 'err'); return }
  const button = document.getElementById('do-submit')
  button.disabled = true
  try {
    await api('/problems/' + encodeURIComponent(label) + '/submissions', {
      method: 'POST',
      body: JSON.stringify({ language, source }),
    })
    delete state.drafts[label]
    const [problems, submissions] = await Promise.all([api('/problems'), api('/submissions')])
    state.open = problems.open
    state.problems = problems.problems || []
    state.submissions = submissions || []
    showDialog({ submitSuccess: true })
  } catch (error) {
    setSubmitFeedback(error.message, 'err')
    button.disabled = !state.open
  }
}

function setSubmitFeedback(text, kind) {
  const element = document.getElementById('submit-feedback')
  if (!element) return
  element.textContent = text
  element.style.color = kind === 'err' ? 'var(--red)' : 'var(--green)'
}

async function showLast(label) {
  try {
    const data = await api('/problems/' + encodeURIComponent(label) + '/last')
    if (!data.submitted) { flash('notice', '该题尚未提交'); return }
    showDialog({ title: `${label} 最后一次提交（${languageLabels[data.language] || data.language}，${data.submitted_at}）`, code: data.source })
  } catch (error) {
    flash('error', error.message)
  }
}

document.addEventListener('click', (event) => {
  const answer = event.target.closest('[data-action="answer"]')
  if (answer) { goSubmit(answer.dataset.label); return }
  const last = event.target.closest('[data-action="last"]')
  if (last) showLast(last.dataset.label)
})

// ---------- 弹窗 ----------

function showDialog(dialog) { state.dialog = dialog; renderDialog() }

function renderDialog() {
  const dialog = state.dialog
  if (!dialog) return
  document.querySelectorAll('.dialog-mask').forEach((node) => node.remove())
  const mask = document.createElement('div')
  mask.className = 'dialog-mask'
  if (dialog.submitSuccess) {
    mask.innerHTML = `<div class="dialog" style="text-align:center">
      <div class="success-mark">✓</div>
      <h3 style="margin:8px 0 18px;color:var(--green)">提交成功</h3>
      <button class="primary" id="dialog-ok">返回题目列表</button>
    </div>`
  } else if (dialog.confirmEarly) {
    mask.innerHTML = `<div class="dialog">
      <h3>确认提前交卷？</h3>
      <p class="muted">交卷后你将无法再提交代码，此操作不可撤销。</p>
      <label><span>原因（可选）</span><input id="early-reason" placeholder="如需补录说明可填写" /></label>
      <div class="row" style="justify-content:flex-end">
        <button id="dialog-cancel">取消</button>
        <button class="danger" id="dialog-ok">确认交卷</button>
      </div>
    </div>`
  } else if (dialog.history) {
    mask.innerHTML = `<div class="dialog" style="width:min(640px,100%)">
      <h3>我的提交记录</h3>
      <table><thead><tr><th>ID</th><th>题号</th><th>语言</th><th>时间</th></tr></thead><tbody>${submissionRows()}</tbody></table>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="dialog-cancel">关闭</button></div>
    </div>`
  } else {
    mask.innerHTML = `<div class="dialog">
      <h3>${escapeHtml(dialog.title || '')}</h3>
      <pre class="code">${escapeHtml(dialog.code || '')}</pre>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="dialog-cancel">关闭</button></div>
    </div>`
  }
  document.body.appendChild(mask)

  if (dialog.submitSuccess) {
    const done = () => { closeDialog(); goList() }
    document.getElementById('dialog-ok').addEventListener('click', done)
    mask.addEventListener('click', (event) => { if (event.target === mask) done() })
    return
  }
  mask.addEventListener('click', (event) => { if (event.target === mask) closeDialog() })
  document.getElementById('dialog-cancel')?.addEventListener('click', closeDialog)
  if (dialog.confirmEarly) {
    document.getElementById('dialog-ok').addEventListener('click', async () => {
      try {
        await api('/early-submit', { method: 'POST', body: JSON.stringify({ confirm: true, reason: document.getElementById('early-reason').value }) })
        closeDialog()
        state.me = null
        render()
        flash('notice', '已交卷')
      } catch (error) {
        flash('error', error.message)
      }
    })
  }
}

function closeDialog() {
  state.dialog = null
  document.querySelectorAll('.dialog-mask').forEach((node) => node.remove())
}

// 倒计时在本地每秒走动（时钟已由响应头 Date 校准）；考试状态由 SSE 事件即时推送。
setInterval(syncCountdown, 1000)

boot()
