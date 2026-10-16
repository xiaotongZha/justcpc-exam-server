'use strict'

const app = document.getElementById('app')
const ui = globalThis.examUI
const escapeHtml = ui.escape
const languageLabels = { cpp: 'C++', java: 'Java', python3: 'Python 3' }
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
  completed: null
}
const htmlCache = {}
let eventSource = null

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  })
  if (response.status === 204) return undefined
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && state.me) {
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
  const source = new EventSource('/api/events')
  source.onopen = () => {
    setConnection('connected')
    if (state.me) pollExam()
  }
  source.onmessage = () => pollExam()
  source.onerror = () => setConnection('reconnecting')
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
    ? lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')
    : '<li class="muted">管理员尚未设置考生守则，请遵循现场监考安排。</li>'
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
  return `<section class="surface"><div class="surface-body"><div class="section-head"><div><span class="eyebrow">考试须知</span><h2>考生守则</h2></div><span class="muted small">${escapeHtml(examTimeText())}</span></div><ol class="rules">${rulesListHtml()}</ol><div class="rules-actions"><button class="primary" id="rules-start">${canSubmit() ? '已阅读，进入考试' : '已阅读，进入考场'}${ui.icon('arrow')}</button><span class="muted small">${canSubmit() ? '提交前请核对题号与编程语言。' : '考试尚未开放时，将进入候考页面。'}</span></div></div></section>`
}
function waitingView() {
  const unset = examDisplayState(state.exam) === 'unset'
  return `<section class="waiting"><div class="waiting-hero"><span class="eyebrow">${unset ? '等待考试安排' : '候考'}</span><h2>${unset ? '考试正在准备中' : '你已进入考场'}</h2><p>${unset ? '管理员尚未设定考试时间，请按现场安排等待。' : '开考状态会自动更新，无需反复刷新页面。'}</p></div><div class="waiting-grid"><section><h3>${ui.icon('rules')} 考前准备</h3><ol><li>核对上方学号与姓名。</li><li>准备本机的代码编辑与运行环境。</li><li>阅读考生守则，遵循现场监考安排。</li></ol><button id="waiting-rules">查看考生守则${ui.icon('arrow')}</button></section><section class="waiting-download">${ui.icon('file')}<h3>比赛题面</h3><p>题面以加密压缩包发放，解压密码由监考员开考时公布。</p><button id="waiting-download">${ui.icon('download')}下载题面包</button></section></div></section>`
}
function listView() {
  return `${stateNote()}<section class="card"><header><div><h2>题目总览</h2><span class="small muted">每题以最后一次提交为准，收录不代表判题通过。</span></div><span class="tag blue" id="collected-summary">${collectedCount()} / ${state.problems.length} 题已收录</span></header><div class="table-scroll"><table><thead><tr><th>题目</th><th>分值</th><th>收录状态</th><th>最后提交</th><th>操作</th></tr></thead><tbody id="problems-body">${problemRows()}</tbody></table></div></section><div class="student-bottom"><span>本平台收录源码，赛后统一评测。</span><button class="text-button quiet" id="early" ${canSubmit() ? '' : 'disabled'}>提前交卷</button></div>`
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
  return `<section class="completion"><div class="completion-hero"><span class="eyebrow">考试已结束</span><h1>提交已停止</h1><p class="muted">已收录的源码将交由赛后评测系统统一处理。</p><div class="completion-summary"><span>已收录 <strong>${collectedCount()}</strong> 题</span><span>累计 <strong>${state.submissions.length}</strong> 次提交</span></div></div><section class="card"><header><h3>本场提交记录</h3><span class="muted small">此处不显示成绩与判题结果</span></header><div class="table-scroll"><table><thead><tr><th>编号</th><th>题目</th><th>语言</th><th>收录时间</th><th>状态</th></tr></thead><tbody>${submissionRows()}</tbody></table></div></section></section>`
}
function shell(content) {
  return `<div class="page"><header class="topbar">${ui.brand()}<span class="header-context">机房考试</span><div class="header-actions"><span id="connection">${ui.connection(state.connection)}</span><button class="text-button quiet" id="student-refresh">${ui.icon('refresh')}刷新状态</button><button class="text-button quiet" id="logout">退出登录</button></div></header><main class="wrap"><div id="banner" class="toast" aria-live="polite"></div><section class="exam-header"><div><div class="exam-context"><span id="exam-state">${examChip(examDisplayState(state.exam))}</span><span class="muted" id="exam-time">${escapeHtml(examTimeText())}</span></div><h1>${escapeHtml(state.exam?.name || 'JustCPC 程序设计竞赛')}</h1><p class="identity">${escapeHtml(state.me?.name)} · ${escapeHtml(state.me?.student_id)}</p></div><div class="timer"><span id="countdown-label">${ui.clockLabel(state.exam)}</span><strong id="countdown">${ui.clockValue(state.exam)}</strong><small>以考场服务器时间为准</small></div></section><nav class="student-nav" aria-label="考试功能"><button id="nav-list" class="${state.view === 'list' ? 'active' : ''}" ${state.view === 'list' ? 'aria-current="page"' : ''}>题目总览<span class="counter" id="nav-count">${collectedCount()} 题已收录</span></button><button id="nav-submit" class="${state.view === 'submit' ? 'active' : ''}" ${!state.problems.length ? 'disabled' : ''}>提交代码</button><button id="history">提交记录</button><button id="rules-btn" class="${state.view === 'rules' ? 'active' : ''}">考生守则</button><span class="spacer"></span><button id="download">${ui.icon('download')}题面包</button></nav><div id="student-content">${content}</div></main>${ui.footer()}</div>`
}
function renderCompleted() {
  app.innerHTML = `<div class="page"><header class="topbar">${ui.brand()}<span class="header-context">考试交卷回执</span></header><main class="wrap completion"><div class="completion-hero"><div class="success-mark">${ui.icon('check')}</div><h1>交卷成功</h1><p class="muted">已收录的源码将交由赛后评测系统统一处理。</p><div class="completion-summary"><span>已收录 <strong>${state.completed.count}</strong> 题</span><span>交卷时间 <strong class="small">${escapeHtml(state.completed.time)}</strong></span></div><p class="muted small" style="margin:24px 0">本次答题已结束，请按监考员安排离场。</p><button id="completed-exit">返回登录页面</button></div></main>${ui.footer()}</div>`
  document.getElementById('completed-exit').addEventListener('click', () => {
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
  document.getElementById('waiting-rules')?.addEventListener('click', () => {
    state.view = 'rules'
    render()
  })
  document.getElementById('rules-start')?.addEventListener('click', goList)
  document.getElementById('back-list')?.addEventListener('click', goList)
  document.getElementById('nav-list').addEventListener('click', goList)
  document.getElementById('nav-submit').addEventListener('click', () => goSubmit())
  for (const id of ['download', 'waiting-download'])
    document.getElementById(id)?.addEventListener('click', downloadStatement)
  document.getElementById('history').addEventListener('click', () => showDialog({ history: true }))
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
  if (early) early.disabled = !canSubmit()
}
function applyProblems() {
  setHTML('problems-body', problemRows())
  setText('nav-count', `${collectedCount()} 题已收录`)
  setText('collected-summary', `${collectedCount()} / ${state.problems.length} 题已收录`)
}
const pollExam = guarded(async () => {
  const exam = await api('/exam'),
    changed = exam.state !== state.exam?.state
  state.exam = exam
  state.open = exam.state === 'running'
  if (changed) {
    const problems = await api('/problems')
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
  window.open('/api/statement', '_blank', 'noopener')
}
async function submitCode() {
  if (state.submitting || !canSubmit()) return
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
    state.receipts[label] = { ...item, label, language, source }
    state.drafts[label] = source
    if (!state.submissions.some((s) => s.id === item.id))
      state.submissions.unshift({ ...item, label })
    setSubmitFeedback('', '')
    applyReceipt()
    try {
      const [problems, submissions] = await Promise.all([api('/problems'), api('/submissions')])
      rememberProblems(problems)
      state.submissions = submissions || []
      applyProblems()
    } catch {
      if (state.me) flash('notice', '代码已收录，列表更新暂时失败，请刷新状态。')
    }
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
  if (dialog.confirmEarly)
    content = `${ui.dialogHeader('确认提前交卷？')}<p class="dialog-description">交卷后将无法继续提交代码。请确认需要提交的题目均已收录。</p><div class="state-note">当前已收录 ${collectedCount()} 题，共 ${state.submissions.length} 次提交。</div><label><span>原因（可选）</span><input id="early-reason" placeholder="如需说明可填写"></label><div class="dialog-actions"><button id="dialog-continue">继续考试</button><button class="danger" id="dialog-ok">确认交卷</button></div>`
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
  document
    .getElementById('copy-source')
    ?.addEventListener('click', (event) => ui.copy(dialog.code || '', event.currentTarget))
  if (dialog.confirmEarly)
    document.getElementById('dialog-ok').addEventListener('click', (event) =>
      ui.dialogAction(event.currentTarget, async () => {
        try {
          const count = collectedCount()
          const item = await api('/early-submit', {
            method: 'POST',
            body: JSON.stringify({
              confirm: true,
              reason: document.getElementById('early-reason').value
            })
          })
          stopEvents()
          state.me = null
          state.open = false
          state.completed = { count, time: item.finished_at || '已确认' }
          closeDialog()
          render()
        } catch (error) {
          flash('error', error.message)
        }
      })
    )
}
function closeDialog() {
  state.dialog = null
  ui.removeDialogs()
  pollExam.flush()
}
setInterval(syncCountdown, 1000)
boot()
