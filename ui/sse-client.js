// SSE を fetch のストリームで受ける。
// EventSource にしないのは、失敗の状態コードを渡さないため。これだと
// 「?adapter=<id> が 404 なら繋ぎ直さない」と、ほかの失敗（繋ぎ直す）を見分けられない。
//
// createSseParser: WHATWG の event-stream の読み方の小さな実装（純粋。test/ui/sse.test.mjs）。
// createLiveStream: 接続・再接続・ポーリングへの切り替え。
//   - 読むだけなので、Authorization もエディタのトークンも付けない。401（httpNodeAuth の Basic 認証）もいつもの失敗として繋ぎ直す。
//   - 繋ぎ直すときは Last-Event-ID を付ける（サーバーはリングから再送し、無理なら reset を送る）。
//   - 1 本は 30 分で自分から閉じて繋ぎ直す（サーバーも 30 分で閉じる）。
//   - イベントが 1 つも届かないまま 3 回続けて失敗したら 'polling' へ（画面は 5 秒ごとの取得に切り替える）。
//     ポーリングの間も 30 秒ごとに SSE を試し、繋がったら 'live' に戻る。
//   - 45 秒なにも届かなければ（サーバーは 20 秒ごとに ping を送る）、切れたとみなして繋ぎ直す。
//   - 404 ADAPTER_NOT_FOUND（?adapter=<id> の台が無い）は onNotFound を呼んでから止まる。繋ぎ直しても同じなので、
//     「リアルタイム更新が切れています」にはせず、詳細の「見つかりません」に任せる。ほかの 404 はいつもの失敗。
//     止まったあとは app.js が ?adapter= を付けない SSE に作り直して一覧の更新を続け、台が一覧に戻ったら
//     ?adapter=<id> で繋ぎ直す。
//   - retryNow は止まったあと（'stopped'）でも繋ぎ直す（帯の「再試行」）。

/**
 * @param {(ev: {type: string, data: string, lastEventId: string}) => void} onEvent
 * @param {(text: string) => void} [onComment]
 */
export function createSseParser(onEvent, onComment) {
  let buf = ''
  let first = true
  let pendingCR = false
  let dataLines = []
  let eventType = ''
  let lastEventId = ''
  let retry = null

  function dispatch() {
    if (dataLines.length === 0) {
      eventType = ''
      return
    }
    const ev = { type: eventType || 'message', data: dataLines.join('\n'), lastEventId }
    dataLines = []
    eventType = ''
    onEvent(ev)
  }

  function line(l) {
    if (l === '') return dispatch()
    if (l.charCodeAt(0) === 58 /* : */) {
      if (onComment) onComment(l.slice(1).replace(/^ /, ''))
      return
    }
    const i = l.indexOf(':')
    const field = i < 0 ? l : l.slice(0, i)
    let value = i < 0 ? '' : l.slice(i + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1)
    if (field === 'event') eventType = value
    else if (field === 'data') dataLines.push(value)
    else if (field === 'id') {
      if (value.indexOf('\u0000') < 0) lastEventId = value
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) retry = Number(value)
    }
    // ほかのフィールドは無視する（仕様どおり）
  }

  return {
    push(chunk) {
      let text = chunk
      if (first) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        if (text.length) first = false
      }
      if (pendingCR) {
        pendingCR = false
        if (text.charCodeAt(0) === 10) text = text.slice(1)
      }
      buf += text
      let start = 0
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i)
        if (c !== 10 && c !== 13) continue
        const l = buf.slice(start, i)
        if (c === 13) {
          if (i + 1 < buf.length) {
            if (buf.charCodeAt(i + 1) === 10) i++
          } else {
            pendingCR = true
          }
        }
        start = i + 1
        line(l)
      }
      buf = buf.slice(start)
    },
    /** ストリームの終わり。途中までのイベントは捨てる（仕様どおり）。 */
    end() {
      buf = ''
      dataLines = []
      eventType = ''
      pendingCR = false
    },
    get lastEventId() {
      return lastEventId
    },
    get retry() {
      return retry
    },
  }
}

/** 404 の本文が ADAPTER_NOT_FOUND か（そうなら {status, code, message}、違えば null）。 */
async function adapterNotFound(res) {
  let body = null
  try {
    const text = await res.text()
    body = text ? JSON.parse(text) : null
  } catch (e) {
    return null
  }
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null
  if (!err || err.code !== 'ADAPTER_NOT_FOUND') return null
  return { status: 404, code: err.code, message: typeof err.message === 'string' ? err.message : null }
}

export const LIVE_DEFAULTS = {
  maxAgeMs: 30 * 60 * 1000,
  idleTimeoutMs: 45 * 1000,
  failLimit: 3,
  retryDelaysMs: [1000, 3000],
  pollRetryMs: 30 * 1000,
  dropDelayMs: 1000,
}

/**
 * @param {{
 *   url: string,
 *   onEvent: (type: string, data: any, id: string) => void,
 *   onState?: (state: 'connecting'|'live'|'reconnecting'|'polling'|'stopped') => void,
 *   onNotFound?: (err: {status: number, code: string, message: string|null}) => void,
 *   fetchImpl?: typeof fetch,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   lastEventId?: string,
 *   options?: Partial<typeof LIVE_DEFAULTS>,
 * }} opts
 */
export function createLiveStream(opts) {
  const o = Object.assign({}, LIVE_DEFAULTS, opts.options || {})
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a))
  const timers = opts.timers || { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) }
  let lastEventId = opts.lastEventId || ''
  let state = null
  let stopped = false
  let failures = 0
  let controller = null
  let retryTimer = null
  let ageTimer = null
  let idleTimer = null
  let generation = 0

  function setState(s) {
    if (state === s) return
    state = s
    if (opts.onState) opts.onState(s)
  }

  function clear(t) {
    if (t) timers.clearTimeout(t)
    return null
  }

  function schedule(ms) {
    retryTimer = clear(retryTimer)
    retryTimer = timers.setTimeout(() => {
      retryTimer = null
      connect()
    }, ms)
  }

  function armIdle(gen) {
    idleTimer = clear(idleTimer)
    idleTimer = timers.setTimeout(() => {
      if (gen === generation && controller) controller.abort()
    }, o.idleTimeoutMs)
  }

  async function connect() {
    if (stopped) return
    const gen = ++generation
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    controller = ctl
    // 初回は 'connecting'。ポーリング中に裏で試すときは 'polling' のまま。ほかは 'reconnecting'。
    if (state === null || state === 'stopped' || state === 'connecting') setState('connecting')
    else if (state !== 'polling') setState('reconnecting')
    let gotEvent = false
    let notFound = null
    let reachedAge = false
    try {
      const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }
      if (lastEventId) headers['Last-Event-ID'] = lastEventId
      const res = await doFetch(opts.url, { headers, signal: ctl ? ctl.signal : undefined, cache: 'no-store', credentials: 'same-origin' })
      if (gen !== generation || stopped) return
      if (res.status === 404) {
        notFound = await adapterNotFound(res)
        throw new Error('404')
      }
      if (!res.ok || !res.body || typeof res.body.getReader !== 'function') throw new Error('HTTP ' + res.status)
      ageTimer = clear(ageTimer)
      ageTimer = timers.setTimeout(() => {
        if (gen === generation && ctl) {
          reachedAge = true
          ctl.abort()
        }
      }, o.maxAgeMs)
      armIdle(gen)
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      const parser = createSseParser((ev) => {
        if (ev.lastEventId) lastEventId = ev.lastEventId
        let data = null
        try {
          data = ev.data ? JSON.parse(ev.data) : null
        } catch (e) {
          return // 読めないイベントは捨てる（画面は次のイベントか取り直しで追いつく）
        }
        if (!gotEvent) {
          gotEvent = true
          failures = 0
          setState('live')
        }
        opts.onEvent(ev.type, data, ev.lastEventId)
      })
      for (;;) {
        const { value, done } = await reader.read()
        if (gen !== generation || stopped) {
          // 中断済み（abort）のストリームでは cancel() の Promise が AbortError で reject する。受けないと
          // 「Uncaught (in promise)」になるので、ここで受けて捨てる
          try {
            const p = reader.cancel()
            if (p && typeof p.catch === 'function') p.catch(() => {})
          } catch (e) {
            /* 片付けの失敗は無視 */
          }
          return
        }
        if (done) break
        armIdle(gen)
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.end()
    } catch (e) {
      // 下でまとめて扱う（中断・ネットワーク・HTTP の失敗）
    } finally {
      if (gen === generation) {
        ageTimer = clear(ageTimer)
        idleTimer = clear(idleTimer)
      }
    }
    if (gen !== generation || stopped) return
    if (notFound) {
      // 止める（'stopped'）前に知らせる。受け手（app.js）は ?adapter= を付けない SSE に作り直すので、
      // この 'stopped' を「停止」の帯に出さないと先に決められる（出すと帯が一瞬出てちらつく）
      try {
        if (opts.onNotFound) opts.onNotFound(notFound)
      } finally {
        stop()
      }
      return
    }
    if (reachedAge) {
      // 30 分の寿命。失敗ではないので、すぐに Last-Event-ID つきで繋ぎ直す
      setState('reconnecting')
      return connect()
    }
    if (gotEvent) {
      // 繋がっていたものが切れた。少し置いて繋ぎ直す（失敗には数えない）
      setState('reconnecting')
      return schedule(o.dropDelayMs)
    }
    failures++
    if (failures >= o.failLimit) {
      setState('polling')
      return schedule(o.pollRetryMs)
    }
    setState('reconnecting')
    schedule(o.retryDelaysMs[Math.min(failures - 1, o.retryDelaysMs.length - 1)])
  }

  function stop() {
    stopped = true
    generation++
    retryTimer = clear(retryTimer)
    ageTimer = clear(ageTimer)
    idleTimer = clear(idleTimer)
    if (controller) {
      try {
        controller.abort()
      } catch (e) {
        /* 片付けの失敗は無視 */
      }
    }
    controller = null
    setState('stopped')
  }

  return {
    start() {
      stopped = false
      connect()
    },
    stop,
    /** 今すぐ繋ぎ直す（ポーリング中・止まったあとに、帯の「再試行」を押したとき）。 */
    retryNow() {
      stopped = false
      retryTimer = clear(retryTimer)
      generation++
      if (controller) {
        try {
          controller.abort()
        } catch (e) {
          /* 無視 */
        }
      }
      connect()
    },
    get state() {
      return state
    },
    get lastEventId() {
      return lastEventId
    },
    get failures() {
      return failures
    },
  }
}
