'use strict'

const app = document.getElementById('app')
const ui = globalThis.examUI
const escapeHtml = ui.escape
const languageLabels = { cpp: 'C++', java: 'Java', python3: 'Python 3' }
const statementDownloadRetryMessage = '请勿触发重复下载，请5秒后再试'
const stateLabels = {
  unset: '时间未设定',
  not_started: '等待开考',
  running: '考试进行中',
  paused: '考试已暂停',
  finished: '考试已结束'
}
const state = {
  me: null,
  exam: null,
  open: false,
  problems: [],
  knownProblems: {},
  submissions: [],
  view: 'list',
  draft: { label: '', language: 'cpp' },
  drafts: {},
  receipts: {},
  error: '',
  notice: '',
  dialog: null,
  phase: null,
  connection: 'connecting',
  submitting: false,
  finishing: false,
  completed: null,
  statementDownloadUntil: 0
}
const htmlCache = {}
let eventSource = null

async function api(path, options = {}) {
  const session = state.me
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  })
  if (response.status === 204) return undefined
  const data = await response.json().catch(() => ({}))
  if (
    response.status === 401 &&
    state.me &&
    state.me === session &&
    (!state.finishing || path === '/early-submit')
  ) {
    state.me = null
    state.open = false
    state.completed = null
    state.error = data.error || '登录已过期，请重新登录'
    state.notice = ''
    stopEvents()
    closeDialog()
    render()
  }
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`)
  return data
}
function setHTML(id, html) {
  if (htmlCache[id] === html) return
  const element = document.getElementById(id)
  if (!element) return
  element.innerHTML = html
  htmlCache[id] = html
}
function setText(id, text) {
  const element = document.getElementById(id)
  if (element && element.textContent !== String(text)) element.textContent = text
}
function renderBanner() {
  const html = state.error
    ? `<div class="msg err" role="alert">${escapeHtml(state.error)}</div>`
    : state.notice
      ? `<div class="msg ok" role="status">${escapeHtml(state.notice)}</div>`
      : ''
  for (const id of ['banner', 'dialog-feedback']) {
    const element = document.getElementById(id)
    if (element) element.innerHTML = html
  }
}
function flash(kind, message) {
  if (kind === 'error') {
    state.error = message
    state.notice = ''
  } else {
    state.notice = message
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
    if (!state.me) {
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
      } while (pending && state.me && !state.dialog)
    } catch {
      pending = Boolean(state.me)
      if (state.me) setConnection('stale')
    } finally {
      busy = false
    }
  }
  refresh.flush = () => (pending ? refresh() : Promise.resolve())
  return refresh
}
function rememberProblems(data) {
  state.open = data.open
  state.problems = data.problems || []
  state.problems.forEach((problem) => {
    state.knownProblems[problem.label] = problem
  })
}
async function refreshAll() {
  const [exam, problems, submissions] = await Promise.all([
    api('/exam'),
    api('/problems'),
    api('/submissions')
  ])
  state.exam = exam
  rememberProblems(problems)
  state.submissions = submissions || []
}
async function boot() {
  try {
    state.me = await api('/me')
    await refreshAll()
  } catch {
    state.me = null
  }
  render()
  if (state.me) startEvents()
}
async function login(event) {
  event.preventDefault()
  const form = event.target,
    button = form.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    state.me = await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        student_id: form.elements.namedItem('student_id').value,
        password: form.elements.namedItem('password').value
      })
    })
    await refreshAll()
    state.draft = { label: state.problems[0]?.label || '', language: 'cpp' }
    state.drafts = {}
    state.receipts = {}
    state.completed = null
    state.view = 'rules'
    state.error = ''
    state.notice = ''
    render()
    startEvents()
  } catch (error) {
    state.me = null
    flash('error', error.message)
    button.disabled = false
  }
}
async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {})
  stopEvents()
  state.me = null
  state.completed = null
  state.open = false
  state.drafts = {}
  state.receipts = {}
  state.submissions = []
  state.knownProblems = {}
  state.problems = []
  closeDialog()
  render()
}
function startEvents() {
  if (eventSource || !state.me) return
  if (!window.EventSource) {
    setConnection('unavailable')
    return
  }
  setConnection('connecting')
  const session = state.me
  const source = new EventSource('/api/events')
  const current = () => eventSource === source && state.me === session && !state.finishing
  source.onopen = () => {
    if (!current()) return
    setConnection('connected')
    if (state.me) pollExam()
  }
  source.addEventListener('session-ended', () => {
    if (!current()) return
    stopEvents()
    state.me = null
    state.open = false
    state.error = '登录已失效，可能已交卷、账号被禁用或考试已更换，请联系监考员。'
    closeDialog()
    render()
  })
  source.onmessage = () => current() && pollExam()
  source.onerror = () => {
    if (current()) setConnection('reconnecting')
  }
  eventSource = source
}
function stopEvents() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}
const examChip = (name) =>
  `<span class="tag ${name === 'running' ? 'green' : name === 'paused' || name === 'not_started' ? 'amber' : 'gray'}">${stateLabels[name] || '—'}</span>`
function canSubmit() {
  return Boolean(
    state.me && !state.me.finished && state.open && examDisplayState(state.exam) === 'running'
  )
}
function examTimeText() {
  return state.exam?.exam_start_at && state.exam?.exam_end_at
    ? `${state.exam.exam_start_at} — ${state.exam.exam_end_at}`
    : '考试时间待管理员安排'
}
const rulesListHtml = () => {
  const lines = String(state.exam?.rules || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length
    ? lines
        .map(
          (line) =>
            `<li${line.includes('！！！') ? ' class="rule-warning"' : ''}>${escapeHtml(line)}</li>`
        )
        .join('')
    : '<li class="muted">管理员尚未设置考生须知，请遵循现场监考安排。</li>'
}
function collectedCount() {
  return new Set(state.submissions.map((item) => item.label)).size
}
function problemRows() {
  if (!state.problems.length)
    return '<tr><td colspan="5" class="empty-cell">题目正在同步，请稍后刷新。</td></tr>'
  return state.problems
    .map((item) => {
      const submitted = item.status === 'submitted'
      return `<tr><td><div class="problem-name"><span class="problem-letter">${escapeHtml(item.label)}</span><span>${escapeHtml(item.title)}</span></div></td><td>${escapeHtml(item.score)}</td><td><span class="tag ${submitted ? 'green' : 'gray'}">${submitted ? '已收录' : '未提交'}</span></td><td class="small muted">${submitted ? `${escapeHtml(ui.time(item.last_submitted_at))}<br>${escapeHtml(languageLabels[item.last_language] || item.last_language)}` : '—'}</td><td class="actions"><button class="text-button" data-action="answer" data-label="${escapeHtml(item.label)}" ${canSubmit() ? '' : 'disabled'}>提交代码</button><button class="text-button" data-action="last" data-label="${escapeHtml(item.label)}" ${submitted ? '' : 'disabled'}>查看源码</button></td></tr>`
    })
    .join('')
}
function submissionRows() {
  return state.submissions.length
    ? state.submissions
        .map(
          (s) =>
            `<tr><td class="mono">#${s.id}</td><td>${escapeHtml(s.label)}</td><td>${escapeHtml(languageLabels[s.language] || s.language)}</td><td>${escapeHtml(s.submitted_at)}</td><td><span class="tag green">已收录</span></td></tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty-cell">暂无提交记录</td></tr>'
}
function stateNote() {
  const phase = examDisplayState(state.exam)
  const text =
    phase === 'paused'
      ? ['考试已暂停', '暂时无法提交代码。已输入的内容仍保留，请等待监考员恢复考试。']
      : phase === 'finished'
        ? ['考试已结束', '提交已经停止。你仍可查看、复制当前代码；未提交内容不会自动收录。']
        : !state.open && phase === 'running'
          ? ['正在同步考试状态', '提交暂不可用，请刷新状态或联系监考员。']
          : null
  return text ? `<div class="state-note"><h3>${text[0]}</h3><p>${text[1]}</p></div>` : ''
}
function rulesView() {
  return `<section class="surface"><div class="surface-body"><div class="section-head"><div><span class="eyebrow">考试须知</span><h2>考生须知</h2></div><span class="muted small">${escapeHtml(examTimeText())}</span></div><ol class="rules">${rulesListHtml()}</ol><div class="rules-actions"><button class="primary" id="rules-start">${canSubmit() ? '已阅读，进入考试' : '已阅读，进入考场'}${ui.icon('arrow')}</button><span class="muted small">${canSubmit() ? '提交前请核对题号与编程语言。' : '考试尚未开放时，将进入候考页面。'}</span></div></div></section>`
}
function waitingView() {
  const unset = examDisplayState(state.exam) === 'unset'
  return `<section class="waiting-state" aria-labelledby="waiting-title"><span class="waiting-state-icon">${ui.icon('clock')}</span><div><h2 id="waiting-title">${unset ? '等待考试安排' : '请等待开考'}</h2><p>${unset ? '监考员设定时间后将自动更新，请按现场安排等待。' : '开考后将自动显示题目，保留此页面即可。'}</p><p class="waiting-file-note">试题文件已加密，解压密码由监考员开考时公布。</p></div></section>`
}
function listView() {
  return `${stateNote()}<section class="card"><header><div><h2>题目总览</h2><span class="small muted">每题仅保留最后一次提交，切换语言后再次提交也会替换原代码；保存不代表判题通过。</span></div><span class="tag blue" id="collected-summary">${collectedCount()} / ${state.problems.length} 题已收录</span></header><div class="table-scroll"><table><thead><tr><th>题目</th><th>分值</th><th>收录状态</th><th>最后提交</th><th>操作</th></tr></thead><tbody id="problems-body">${problemRows()}</tbody></table></div></section>`
}
function submitView() {
  const item = state.knownProblems[state.draft.label]
  const options = state.problems
    .map(
      (p) =>
        `<option value="${escapeHtml(p.label)}">${escapeHtml(p.label)} · ${escapeHtml(p.title)}</option>`
    )
    .join('')
  return `${stateNote()}<section class="surface"><div class="surface-body"><div class="section-head"><div><span class="eyebrow">当前提交题目</span><h2 id="submit-title">${escapeHtml(state.draft.label)} · ${escapeHtml(item?.title || '提交代码')}</h2></div><button class="text-button" id="back-list">${ui.icon('back')}返回题目总览</button></div><div class="submit-controls"><label class="problem-select"><span>题目</span><select id="label-select" data-labels="${state.problems.map((p) => p.label).join(',')}">${options}</select></label><label><span>编程语言</span><select id="language-select"><option value="cpp">C++</option><option value="java">Java</option><option value="python3">Python 3</option></select></label></div><label class="source-label" for="source">源代码<span class="small muted">请确认题目与编程语言正确</span></label><textarea class="source-editor" id="source" wrap="off" spellcheck="false" placeholder="在此粘贴源代码" aria-describedby="draft-state submit-feedback"></textarea><div class="submit-footer"><div><span id="draft-state" class="muted small">当前编辑内容尚未提交</span><span id="submit-feedback" class="small" role="status"></span></div><button class="primary" id="do-submit">${ui.icon('send')}提交 ${escapeHtml(state.draft.label)} 题代码</button></div><div id="submit-receipt" class="receipt" hidden aria-live="polite"></div><div class="student-bottom"><span>当前页面的编辑内容在提交成功前不会收录。</span><span class="mono" id="source-lines">1 行</span></div></div></section>`
}
function endView() {
  return `<section class="card student-receipt"><header><div><h2>提交回执</h2><p class="small muted">本场已停止提交，以下为服务器保存的最后一次代码。</p></div><div class="receipt-totals"><strong>${collectedCount()}<small>题已收录</small></strong></div></header><div class="table-scroll"><table><thead><tr><th>编号</th><th>题目</th><th>语言</th><th>收录时间</th><th>状态</th></tr></thead><tbody>${submissionRows()}</tbody></table></div></section>`
}
function shell(content) {
  const phase = examDisplayState(state.exam),
    ended = phase === 'finished',
    showFinish = ['running', 'paused'].includes(phase)
  return `<div class="page"><header class="topbar">${ui.brand()}<span class="header-context">机房考试</span><div class="header-actions"><span id="connection">${ui.connection(state.connection)}</span><button class="text-button quiet" id="student-refresh">${ui.icon('refresh')}刷新状态</button><button class="text-button quiet" id="logout">退出登录</button></div></header><main class="wrap student-workspace"><div id="banner" class="toast" aria-live="polite"></div><section class="student-masthead"><div class="student-exam-title"><div><span id="exam-state">${examChip(phase)}</span><h1>${escapeHtml(state.exam?.name || 'JustCPC 程序设计竞赛')}</h1><p id="exam-time">${escapeHtml(examTimeText())}</p></div>${!ended ? `<div class="timer"><span id="countdown-label">${ui.clockLabel(state.exam)}</span><strong id="countdown">${ui.clockValue(state.exam)}</strong></div>` : ''}</div><div class="student-session"><div class="student-person" aria-label="考生身份"><strong>${escapeHtml(state.me?.name)}</strong><span>学号 <b class="mono">${escapeHtml(state.me?.student_id)}</b></span></div><div class="student-session-actions"><button class="primary statement-download" id="download">${ui.icon('download')}试题下载</button>${showFinish ? `<button class="finish-exam" id="early" ${canSubmit() && !state.submitting ? '' : 'disabled'}>提前交卷${ui.icon('arrow')}</button>` : ''}</div></div></section><nav class="student-nav" aria-label="考试功能"><button id="nav-list" class="${state.view === 'list' ? 'active' : ''}" ${state.view === 'list' ? 'aria-current="page"' : ''}>${ended ? '提交回执' : '题目总览'}${!ended ? `<span class="counter" id="nav-count">${collectedCount()} 题已收录</span>` : ''}</button>${!ended ? `<button id="nav-submit" class="${state.view === 'submit' ? 'active' : ''}" ${!state.problems.length ? 'disabled' : ''}>提交代码</button><button id="history">提交记录</button>` : ''}<button id="rules-btn" class="${state.view === 'rules' ? 'active' : ''}">考生须知</button></nav><div id="student-content">${content}</div></main>${ui.footer()}</div>`
}
function renderCompleted() {
  app.innerHTML = `<div class="page"><header class="topbar">${ui.brand()}<span class="header-context">考试交卷回执</span></header><main class="wrap completion"><div class="completion-hero"><div class="success-mark">${ui.icon('check')}</div><h1>交卷成功</h1><div class="completion-summary"><span>已收录 <strong>${state.completed.count}</strong> 题</span><span>交卷时间 <strong class="small">${escapeHtml(state.completed.time)}</strong></span></div><p class="muted small" style="margin:24px 0">本次答题已结束，请按监考员安排离场。</p><button id="completed-exit">返回登录页面</button></div></main>${ui.footer()}</div>`
  document.getElementById('completed-exit').addEventListener('click', () => {
    state.error = ''
    state.notice = ''
    state.completed = null
    state.drafts = {}
    state.receipts = {}
    state.submissions = []
    state.problems = []
    state.knownProblems = {}
    render()
  })
}
function renderLogin() {
  app.innerHTML = ui.login('student', state.error)
  document.getElementById('login-form').addEventListener('submit', login)
}
function goList() {
  state.view = 'list'
  render()
}
function goSubmit(label) {
  if (label) state.draft.label = label
  if (!state.draft.label) state.draft.label = state.problems[0]?.label || ''
  if (!state.draft.label) return
  state.view = 'submit'
  render()
}
function render() {
  if (state.completed) {
    renderCompleted()
    return
  }
  if (!state.me) {
    renderLogin()
    return
  }
  const phase = examDisplayState(state.exam)
  const content =
    state.view === 'rules'
      ? rulesView()
      : state.view === 'submit'
        ? submitView()
        : phase === 'finished'
          ? endView()
          : phase === 'unset' || phase === 'not_started'
            ? waitingView()
            : listView()
  app.innerHTML = shell(content)
  for (const key of Object.keys(htmlCache)) delete htmlCache[key]
  renderBanner()
  document.getElementById('logout').addEventListener('click', logout)
  document.getElementById('rules-btn').addEventListener('click', () => {
    state.view = 'rules'
    render()
  })
  document.getElementById('rules-start')?.addEventListener('click', goList)
  document.getElementById('back-list')?.addEventListener('click', goList)
  document.getElementById('nav-list').addEventListener('click', goList)
  document.getElementById('nav-submit')?.addEventListener('click', () => goSubmit())
  document.getElementById('download').addEventListener('click', downloadStatement)
  document.getElementById('history')?.addEventListener('click', () => showDialog({ history: true }))
  document
    .getElementById('early')
    ?.addEventListener('click', () => showDialog({ confirmEarly: true }))
  document.getElementById('student-refresh').addEventListener('click', async () => {
    if (state.submitting) return
    try {
      await refreshAll()
      if (state.me) {
        render()
        setConnection(eventSource?.readyState === 1 ? 'connected' : state.connection)
      }
    } catch (error) {
      flash('error', error.message)
    }
  })
  const source = document.getElementById('source'),
    labelSelect = document.getElementById('label-select'),
    languageSelect = document.getElementById('language-select')
  if (labelSelect) {
    labelSelect.value = state.draft.label
    labelSelect.addEventListener('change', () => {
      state.draft.label = labelSelect.value
      render()
    })
  }
  if (languageSelect) {
    languageSelect.value = state.draft.language
    languageSelect.addEventListener('change', () => {
      state.draft.language = languageSelect.value
      applyReceipt()
    })
  }
  if (source) {
    source.value = state.drafts[state.draft.label] || ''
    source.addEventListener('input', () => {
      state.drafts[state.draft.label] = source.value
      setSubmitFeedback('', '')
      applyReceipt()
    })
  }
  document.getElementById('do-submit')?.addEventListener('click', submitCode)
  applyExam()
  applyReceipt()
}
function applyReceipt() {
  const source = document.getElementById('source'),
    receipt = state.receipts[state.draft.label],
    element = document.getElementById('submit-receipt')
  if (!source || !element) return
  const saved =
    receipt && receipt.source === source.value && receipt.language === state.draft.language
  element.hidden = !saved
  if (saved)
    element.innerHTML = `${ui.icon('check')}<div><strong>服务器已收录 ${escapeHtml(receipt.label)} 题代码</strong><span class="small">${escapeHtml(languageLabels[receipt.language])} · 提交 #${receipt.id} · ${escapeHtml(receipt.submitted_at)}</span></div><small>收录不代表判题通过</small>`
  setText('draft-state', saved ? '当前代码已收录' : '当前编辑内容尚未提交')
  setText('source-lines', `${source.value.split('\n').length} 行`)
}
function applyExam() {
  setText('countdown', ui.clockValue(state.exam))
  setText('countdown-label', ui.clockLabel(state.exam))
  setHTML('exam-state', examChip(examDisplayState(state.exam)))
  setText('exam-time', examTimeText())
  for (const id of ['do-submit', 'label-select', 'language-select']) {
    const el = document.getElementById(id)
    if (el) el.disabled = !canSubmit() || state.submitting
  }
  const source = document.getElementById('source')
  if (source) source.readOnly = !canSubmit() || state.submitting
  const early = document.getElementById('early')
  if (early) early.disabled = !canSubmit() || state.submitting
}
function applyProblems() {
  setHTML('problems-body', problemRows())
  setText('nav-count', `${collectedCount()} 题已收录`)
  setText('collected-summary', `${collectedCount()} / ${state.problems.length} 题已收录`)
}
const pollExam = guarded(async () => {
  if (!state.me || state.finishing) return
  const session = state.me
  const exam = await api('/exam'),
    changed = exam.state !== state.exam?.state
  if (state.me !== session || state.finishing) return
  state.exam = exam
  state.open = exam.state === 'running'
  if (changed) {
    const problems = await api('/problems')
    if (state.me !== session || state.finishing) return
    rememberProblems(problems)
    render()
  } else {
    applyExam()
    applyProblems()
  }
})
function syncCountdown() {
  if (!state.me) return
  const phase = examClock(state.exam).phase
  applyExam()
  if (state.phase && state.phase !== phase) {
    if (phase === 'running') {
      flash('notice', '考试已开始，正在同步题目。')
      pollExam()
    } else if (phase === 'ended') {
      flash('notice', '考试已结束，提交已停止。')
      pollExam()
    }
  }
  state.phase = phase
}
function downloadStatement() {
  const now = Date.now()
  if (now < state.statementDownloadUntil) {
    flash('error', statementDownloadRetryMessage)
    return
  }
  state.statementDownloadUntil = now + 5000
  if (state.error === statementDownloadRetryMessage) {
    state.error = ''
    renderBanner()
  }
  const link = document.createElement('a')
  link.href = '/api/statement'
  link.download = ''
  document.body.appendChild(link)
  link.click()
  link.remove()
}
async function submitCode() {
  if (state.submitting || !canSubmit()) return
  const owner = state.me
  const label = state.draft.label,
    language = state.draft.language,
    source = document.getElementById('source')?.value || ''
  if (!label || !source.trim()) {
    setSubmitFeedback(!label ? '请选择题目' : '源码不能为空', 'err')
    return
  }
  state.submitting = true
  applyExam()
  setSubmitFeedback('正在提交，请稍候…', '')
  try {
    const item = await api('/problems/' + encodeURIComponent(label) + '/submissions', {
      method: 'POST',
      body: JSON.stringify({ language, source })
    })
    if (state.me !== owner) return
    state.receipts[label] = { ...item, label, language, source }
    state.drafts[label] = source
    state.submissions = [{ ...item, label }, ...state.submissions.filter((s) => s.label !== label)]
    const problem = state.problems.find((p) => p.label === label)
    if (problem)
      Object.assign(problem, {
        status: 'submitted',
        last_language: language,
        last_submitted_at: item.submitted_at
      })
    setSubmitFeedback('', '')
    applyReceipt()
    showDialog({ saved: { label } })
    void (async () => {
      try {
        const [problems, submissions] = await Promise.all([api('/problems'), api('/submissions')])
        if (state.me !== owner) return
        rememberProblems(problems)
        state.submissions = submissions || []
        applyProblems()
      } catch {
        if (state.me) flash('notice', '代码已保存，列表更新暂时失败，请刷新状态。')
      }
    })()
  } catch (error) {
    setSubmitFeedback(error.message, 'err')
  } finally {
    state.submitting = false
    applyExam()
  }
}
function setSubmitFeedback(text, kind) {
  const el = document.getElementById('submit-feedback')
  if (el) {
    el.textContent = text
    el.style.color = kind === 'err' ? 'var(--red)' : 'var(--muted)'
  }
}
async function showLast(label) {
  try {
    const item = await api('/problems/' + encodeURIComponent(label) + '/last')
    if (!item.submitted) {
      flash('notice', '该题尚未提交')
      return
    }
    showDialog({
      title: `${label} 题最后一次提交`,
      meta: `${languageLabels[item.language] || item.language} · #${item.submission_id} · ${item.submitted_at}`,
      code: item.source
    })
  } catch (error) {
    flash('error', error.message)
  }
}
document.addEventListener('click', (event) => {
  const answer = event.target.closest('[data-action="answer"]')
  if (answer && !answer.disabled) {
    goSubmit(answer.dataset.label)
    return
  }
  const last = event.target.closest('[data-action="last"]')
  if (last && !last.disabled) showLast(last.dataset.label)
})
function showDialog(dialog) {
  state.dialog = dialog
  renderDialog()
}
function renderDialog() {
  const dialog = state.dialog
  if (!dialog) return
  let content,
    wide = false
  if (dialog.saved)
    content = `${ui.dialogHeader('当前代码已保存')}<p class="dialog-description">${escapeHtml(dialog.saved.label)} 题代码已保存，每题以最后一次提交为准。</p><div class="dialog-actions"><button class="primary" id="saved-ok" autofocus>返回题目总览</button></div>`
  else if (dialog.confirmEarly)
    content = `${ui.dialogHeader('确认提前交卷？')}<p class="dialog-description">交卷后将无法再次登录考试或继续提交代码。请确认需要提交的题目均已收录。</p><div class="state-note">当前已收录 ${collectedCount()} 题，共 ${state.submissions.length} 份有效代码。</div><div class="dialog-actions"><button id="dialog-continue">继续考试</button><button class="danger" id="dialog-ok">确认交卷</button></div>`
  else if (dialog.history) {
    wide = true
    content = `${ui.dialogHeader('我的提交记录')}<p class="dialog-description">记录表示服务器已收录源码，不代表判题通过；每题以最后一次提交为准。</p><div class="table-scroll"><table><thead><tr><th>编号</th><th>题目</th><th>语言</th><th>收录时间</th><th>状态</th></tr></thead><tbody>${submissionRows()}</tbody></table></div>`
  } else {
    wide = true
    content = `${ui.dialogHeader(dialog.title || '提交源码')}<div class="dialog-meta"><span>${escapeHtml(dialog.meta || '')}</span><button id="copy-source">${ui.icon('copy')}复制源码</button></div><pre class="code">${escapeHtml(dialog.code || '')}</pre>`
  }
  ui.openDialog(content, closeDialog, wide)
  document.getElementById('dialog-cancel')?.addEventListener('click', closeDialog)
  document.getElementById('dialog-continue')?.addEventListener('click', closeDialog)
  document.getElementById('saved-ok')?.addEventListener('click', closeDialog)
  document
    .getElementById('copy-source')
    ?.addEventListener('click', (event) => ui.copy(dialog.code || '', event.currentTarget))
  if (dialog.confirmEarly)
    document.getElementById('dialog-ok').addEventListener('click', (event) =>
      ui.dialogAction(event.currentTarget, async () => {
        if (state.finishing) return
        state.finishing = true
        stopEvents()
        try {
          const count = collectedCount()
          const item = await api('/early-submit', {
            method: 'POST',
            body: JSON.stringify({
              confirm: true
            })
          })
          stopEvents()
          state.me = null
          state.open = false
          state.completed = { count, time: item.finished_at || '已确认' }
          state.error = ''
          state.notice = ''
          closeDialog()
          render()
        } catch (error) {
          flash('error', error.message)
        } finally {
          state.finishing = false
          if (state.me) startEvents()
        }
      })
    )
}
function closeDialog() {
  const saved = state.dialog?.saved
  state.dialog = null
  if (saved) {
    delete state.drafts[saved.label]
    delete state.receipts[saved.label]
    if (state.draft.label === saved.label) {
      const editor = document.getElementById('source')
      if (editor) editor.value = ''
    }
    state.view = 'list'
    render()
  }
  ui.removeDialogs()
  pollExam.flush()
}
setInterval(syncCountdown, 1000)
boot()
