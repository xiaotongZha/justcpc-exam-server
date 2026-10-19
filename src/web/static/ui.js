'use strict'

// Shared, embedded presentation helpers. No fonts, icons or scripts are fetched
// from the internet; the examination service remains usable on an isolated LAN.
globalThis.examUI = (() => {
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )
  const paths = {
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h6"/>',
    users:
      '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6m1 5a5 5 0 0 1 3 5"/>',
    monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
    rules:
      '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h4"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2-1 3-1 3h-4l-2-2-3-1-3-1v-4l2-2 1-3Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    send: '<path d="m3 3 18 9-18 9 3-9-3-9Zm3 9h15"/>',
    shield: '<path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Z"/><path d="m8 11 3 3 5-6"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 5V3H3v13h2"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6"/>'
  }
  const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`
  const brand = (role = '机房考试') =>
    `<div class="brand" aria-label="JustCPC ${role}"><img class="brand-logo" src="/assets/logos/contest.png" alt="程序设计竞赛标志" width="52" height="36"><span>Just<span class="brand-accent">CPC</span></span><small>江苏科技大学</small></div>`
  const footer = () =>
    `<footer class="site-foot" aria-label="主办与承办单位"><span class="org"><img src="/assets/logos/school.png" alt="江苏科技大学校徽" width="32" height="32"><span><small>主办单位</small>江苏科技大学</span></span><span class="org"><img src="/assets/logos/association.png" alt="计算机协会会徽" width="32" height="32"><span><small>承办单位</small>计算机协会</span></span></footer>`
  const connection = (mode) => {
    const text =
      {
        connected: '实时同步正常',
        connecting: '正在连接考场服务器',
        reconnecting: '连接中断，正在重连',
        stale: '状态更新失败，请刷新重试',
        unavailable: '当前浏览器无法实时同步，请手动刷新'
      }[mode] || '正在连接考场服务器'
    return `<span class="connection ${mode === 'connected' ? '' : 'is-pending'}" role="status"><span class="connection-dot"></span>${text}</span>`
  }
  const clockValue = (exam) => examClock(exam).text.replace(/^距(?:开始|结束)\s*/, '')
  const clockLabel = (exam) => {
    const phase = examClock(exam).phase
    return phase === 'before'
      ? '距离开考'
      : phase === 'ended'
        ? '考试已结束'
        : phase === 'unset'
          ? '等待时间安排'
          : exam?.state === 'paused'
            ? '距计划结束（已暂停）'
            : '考试剩余时间'
  }
  const time = (value) => String(value || '—').replace(/^\d{4}-/, '')
  const login = (role, error) => {
    const admin = role === 'admin'
    return `<div class="page login-page"><header class="topbar">${brand(admin ? '现场管理' : '机房考试')}<span class="header-context">程序设计竞赛 · ${admin ? '现场管理' : '机房考试'}</span></header><main class="login-layout"><section class="login-intro"><img class="login-mark" src="/assets/logos/contest.png" alt="程序设计竞赛标志" width="180" height="125"><span class="eyebrow">JUSTCPC · ${admin ? 'ADMIN' : 'EXAM'}</span><h1>${admin ? '现场管理工作台' : '江苏科技大学程序设计竞赛'}</h1>${admin ? '<p>考试安排 · 考生管理 · 提交导出</p>' : ''}<div class="login-note">${icon('shield')}<span>${admin ? '仅供现场管理员与监考人员使用。' : '请使用监考员提供的考试账号登录。'}</span></div></section><form class="login-form" id="login-form">${admin ? '<span class="eyebrow">管理入口</span>' : ''}<h2>${admin ? '管理员登录' : '登录考试'}</h2>${admin ? '<p class="muted">登录后查看考试状态并管理现场事务。</p>' : ''}<div id="banner" aria-live="polite">${error ? `<div class="msg err" role="alert">${escape(error)}</div>` : ''}</div><label><span>${admin ? '用户名' : '账号'}</span><input name="${admin ? 'username' : 'student_id'}" ${admin ? 'value="admin"' : ''} autocomplete="username" required></label><label><span>${admin ? '管理员密码' : '考试密码'}</span><input name="password" type="password" autocomplete="current-password" required></label><button class="primary full-width" type="submit">${admin ? '登录管理工作台' : '登录并进入考场'}${icon('arrow')}</button><p class="login-help">${admin ? '请使用本机配置的管理员账号。' : '账号或密码有误，请联系现场监考员。'}</p></form></main>${footer()}</div>`
  }
  let opener = null
  function removeDialogs(restoreFocus = true) {
    document.querySelectorAll('dialog[data-exam-dialog]').forEach((node) => {
      if (node.open && node.close) node.close()
      node.remove()
    })
    if (restoreFocus && opener?.isConnected) opener.focus()
    if (restoreFocus) opener = null
  }
  function openDialog(content, onClose, wide = false) {
    removeDialogs(false)
    opener = document.activeElement
    const dialog = document.createElement('dialog')
    dialog.className = `dialog${wide ? ' dialog-wide' : ''}`
    dialog.dataset.examDialog = 'true'
    dialog.setAttribute('aria-labelledby', 'dialog-title')
    dialog.innerHTML = content.replace(
      '</header>',
      '</header><div id="dialog-feedback" aria-live="polite"></div>'
    )
    document.body.appendChild(dialog)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (!dialog.dataset.busy) onClose()
    })
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog && !dialog.dataset.busy) onClose()
    })
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '')
    dialog.querySelector('[autofocus]')?.focus()
    return dialog
  }
  function dialogHeader(title) {
    return `<header class="dialog-header"><h2 id="dialog-title">${escape(title)}</h2><button class="icon-button" id="dialog-cancel" type="button" aria-label="关闭对话框" autofocus>${icon('close')}</button></header>`
  }
  async function dialogAction(button, action) {
    const dialog = button.closest('dialog')
    if (dialog.dataset.busy) return
    dialog.dataset.busy = 'true'
    const controls = [...dialog.querySelectorAll('button, input, select, textarea')].map((el) => [
      el,
      el.disabled
    ])
    const label = button.textContent
    controls.forEach(([el]) => {
      el.disabled = true
    })
    button.textContent = '处理中…'
    try {
      await action()
    } finally {
      delete dialog.dataset.busy
      controls.forEach(([el, disabled]) => {
        el.disabled = disabled
      })
      button.textContent = label
    }
  }
  async function copy(text, button) {
    try {
      if (globalThis.isSecureContext && navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(text)
      else {
        const field = document.createElement('textarea')
        field.value = text
        field.className = 'copy-field'
        field.setAttribute('aria-label', '复制源码')
        ;(button.closest('dialog') || document.body).appendChild(field)
        field.select()
        const copied = document.execCommand('copy')
        field.remove()
        if (!copied) throw new Error('copy unavailable')
      }
      button.textContent = '已复制'
    } catch {
      button.textContent = '请选中源码后复制'
    }
  }
  return {
    escape,
    icon,
    brand,
    footer,
    connection,
    clockValue,
    clockLabel,
    time,
    login,
    openDialog,
    removeDialogs,
    dialogHeader,
    dialogAction,
    copy
  }
})()
