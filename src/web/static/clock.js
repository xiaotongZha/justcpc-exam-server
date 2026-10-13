'use strict'

// 全局时钟校准：拦截所有 fetch 响应，用 HTTP 响应头 Date 校准本地时钟。
// 校准后倒计时在本地每秒走动，无需周期性向服务端同步时间。
// 本文件在 student.js / admin.js 之前加载，仅暴露全局函数，避免与其局部变量重名。
;(function () {
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null
  let offsetMs = 0 // 服务器时间 - 本地时间
  let synced = false
  let lastNow = 0 // 保证时间单调递增，避免 HTTP Date 秒级截断造成回拨

  function calibrate(response) {
    try {
      const header = response.headers.get('Date')
      if (!header) return
      const server = Date.parse(header)
      if (!Number.isFinite(server)) return
      // HTTP Date 精确到秒，取该秒中点；再用 1/4 步长平滑，避免来回抖动。
      const estimate = server + 500 - Date.now()
      offsetMs = synced ? offsetMs + (estimate - offsetMs) / 4 : estimate
      synced = true
    } catch {
      // 响应头不可读时忽略，继续使用本地时钟。
    }
  }

  if (nativeFetch) {
    window.fetch = async function (...args) {
      const response = await nativeFetch(...args)
      calibrate(response)
      return response
    }
  }

  globalThis.serverNow = () => {
    const value = Date.now() + offsetMs
    if (value > lastNow) lastNow = value
    return lastNow
  }
  globalThis.serverClockSynced = () => synced
})()

// 解析 "YYYY-MM-DD HH:mm:ss"（兼容 T 分隔）为毫秒时间戳；无法解析时返回 null。
function parseExamTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text || ''))
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`
}

// examClock 依据考试状态与起止时间返回四态之一，text 为倒计时文本（无剩余时间时用 —）：
//   unset   时间未设定   before  未开始（距开始）   running  进行中（距结束）   ended  已结束
function examClock(exam) {
  const state = exam && exam.state
  if (state === 'finished') return { phase: 'ended', text: '—' }
  const start = parseExamTime(exam && exam.exam_start_at)
  const end = parseExamTime(exam && exam.exam_end_at)
  if (start === null || end === null) return { phase: 'unset', text: '—' }
  const now = globalThis.serverNow()
  if (now >= end) return { phase: 'ended', text: '—' }
  if (now >= start) return { phase: 'running', text: '距结束 ' + formatDuration(end - now) }
  return { phase: 'before', text: '距开始 ' + formatDuration(start - now) }
}

function countdownText(exam) { return examClock(exam).text }

// examDisplayState 把时间相位映射为展示状态，使状态标签与倒计时在同一秒更新，
// 不必等待下一次服务端轮询。unset 表示尚未设定考试时间。
function examDisplayState(exam) {
  const phase = examClock(exam).phase
  if (phase === 'ended') return 'finished'
  if (exam && exam.state === 'paused') return 'paused'
  if (phase === 'running') return 'running'
  if (phase === 'before') return 'not_started'
  return 'unset'
}
