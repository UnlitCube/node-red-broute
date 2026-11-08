// ui/sse-client.js: SSE のパーサと、接続・再接続・ポーリングへの切り替え。
// ログインは無い。Authorization を付けず、401（httpNodeAuth の Basic 認証）もいつもの失敗として扱う。
//
// 戻すと落ちるもの:
//   - Authorization を付ける形に戻す →「Authorization を付けない」が落ちる
//   - 401 で止まる形に戻す →「401 も繋ぎ直し、3 回で polling」が落ちる
//   - 404 ADAPTER_NOT_FOUND の見分けを外す → reconnecting → polling（「リアルタイム更新が切れています」）になる
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser, createLiveStream } from '../../ui/sse-client.js'

function collect() {
  const events = []
  const comments = []
  const p = createSseParser((e) => events.push(e), (c) => comments.push(c))
  return { p, events, comments }
}

test('パーサ: event・data・id。空行で 1 つのイベント', () => {
  const { p, events } = collect()
  p.push('id: 7\nevent: adapters\ndata: {"items":[]}\n\n')
  assert.deepEqual(events, [{ type: 'adapters', data: '{"items":[]}', lastEventId: '7' }])
  assert.equal(p.lastEventId, '7')
})

test('パーサ: data の複数行は改行でつなぐ。event が無ければ message', () => {
  const { p, events } = collect()
  p.push('data: a\ndata:b\ndata\n\n')
  assert.deepEqual(events, [{ type: 'message', data: 'a\nb\n', lastEventId: '' }])
})

test('パーサ: CRLF がチャンクの境目で割れても 1 行として読む。CR だけの改行も読む', () => {
  const { p, events } = collect()
  p.push('event: log\r')
  p.push('\ndata: {"seq":1}\r')
  p.push('\n\r')
  p.push('\n')
  assert.deepEqual(events, [{ type: 'log', data: '{"seq":1}', lastEventId: '' }])
  const c = collect()
  c.p.push('event: x\rdata: 1\r\r')
  assert.deepEqual(c.events, [{ type: 'x', data: '1', lastEventId: '' }])
})

test('パーサ: 1 文字ずつ届いても同じ結果', () => {
  const src = 'id: 1\r\nevent: hello\r\ndata: {"seq":1}\r\n\r\n: ping\r\n\r\nid: 2\nevent: reset\ndata: {}\n\n'
  const whole = collect()
  whole.p.push(src)
  const bytes = collect()
  for (const ch of src) bytes.p.push(ch)
  assert.deepEqual(bytes.events, whole.events)
  assert.equal(whole.events.length, 2)
  assert.deepEqual(whole.comments, ['ping'])
})

test('パーサ: コメントは捨て、data の無いイベントは出さない（id は覚える）。BOM を外す', () => {
  const { p, events, comments } = collect()
  p.push('﻿: ping\n\nid: 9\nevent: nothing\n\n')
  assert.deepEqual(events, [])
  assert.deepEqual(comments, ['ping'])
  assert.equal(p.lastEventId, '9')
  p.push('data: x\n\n')
  assert.deepEqual(events, [{ type: 'message', data: 'x', lastEventId: '9' }])
})

test('パーサ: NUL を含む id は無視する。retry は数字だけ。終わりの途中のイベントは捨てる', () => {
  const { p, events } = collect()
  p.push('id: 3\n\nid: a\u0000b\nretry: 1500\nretry: x\ndata: y\n\n')
  assert.equal(events[0].lastEventId, '3')
  assert.equal(p.retry, 1500)
  p.push('data: half')
  p.end()
  p.push('\n\n')
  assert.equal(events.length, 1)
})

// ---- 接続の制御 ----------------------------------------------------------------

function fakeTimers() {
  let seq = 0
  const q = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      q.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      q.delete(id)
    },
    pending() {
      return [...q.values()].map((t) => t.ms).sort((a, b) => a - b)
    },
    /** ms が一致するタイマーを 1 つ発火させる */
    fire(ms) {
      for (const [id, t] of q) {
        if (t.ms === ms) {
          q.delete(id)
          t.fn()
          return true
        }
      }
      return false
    },
  }
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

/** 本文を渡すと開いたままのストリームを返す。signal で中断すると AbortError で止まる。 */
function streamResponse(chunks, { status = 200, close = true, signal } = {}) {
  const enc = new TextEncoder()
  let ctl
  const body = new ReadableStream({
    start(c) {
      ctl = c
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      if (close) c.close()
    },
  })
  if (signal) {
    signal.addEventListener('abort', () => {
      try {
        ctl.error(new DOMException('aborted', 'AbortError'))
      } catch (e) {
        /* 閉じたあと */
      }
    })
  }
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

function setup(script) {
  const calls = []
  const states = []
  const events = []
  const notFound = []
  const timers = fakeTimers()
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const step = script.shift()
    if (!step) return new Promise(() => {})
    return step(init)
  }
  const ls = createLiveStream({
    url: 'http://h/wsuha-broute/api/v1/stream',
    fetchImpl,
    timers,
    onEvent: (type, data, id) => events.push({ type, data, id }),
    onState: (s) => states.push(s),
    // 知らせを受けた時点の状態の移り変わりも控える（止める前に知らせるか）
    onNotFound: (e) => notFound.push(Object.assign({ statesAtCall: states.slice() }, e)),
  })
  return { ls, calls, states, events, timers, notFound }
}

test('繋がる → イベントを JSON で渡す → 切れたら Last-Event-ID を付けて繋ぎ直す', async () => {
  const t = setup([
    () => streamResponse(['id: 41\nevent: hello\ndata: {"seq":41}\n\n', 'id: 42\nevent: adapters\ndata: {"items":[1]}\n\n']),
    (init) => streamResponse(['id: 43\nevent: adapter\ndata: {"id":"a"}\n\n'], { close: false, signal: init.signal }),
  ])
  t.ls.start()
  await flush()
  assert.deepEqual(t.events.map((e) => e.type), ['hello', 'adapters'])
  assert.deepEqual(t.events[1].data, { items: [1] })
  assert.equal(Object.keys(t.calls[0].headers).some((k) => k.toLowerCase() === 'authorization'), false, 'Authorization を付けない')
  assert.equal(t.calls[0].headers.Accept, 'text/event-stream')
  assert.equal(t.calls[0].headers['Last-Event-ID'], undefined)
  assert.deepEqual(t.states, ['connecting', 'live', 'reconnecting'])
  assert.ok(t.timers.fire(1000), '切れたら 1 秒後に繋ぎ直す')
  await flush()
  assert.equal(t.calls[1].headers['Last-Event-ID'], '42')
  assert.deepEqual(t.states.slice(-1), ['live'])
  assert.equal(t.ls.lastEventId, '43')
  t.ls.stop()
  assert.equal(t.ls.state, 'stopped')
})

test('イベントが届かないまま 3 回続けて失敗したら polling。30 秒ごとに試し、繋がれば live に戻る', async () => {
  const fail = () => Promise.reject(new TypeError('network'))
  const t = setup([fail, () => streamResponse([], { status: 502 }), fail, fail, () => streamResponse(['event: hello\ndata: {}\n\n'], { close: false })])
  t.ls.start()
  await flush()
  assert.equal(t.ls.failures, 1)
  assert.equal(t.ls.state, 'reconnecting')
  assert.ok(t.timers.fire(1000))
  await flush()
  assert.equal(t.ls.failures, 2)
  assert.ok(t.timers.fire(3000))
  await flush()
  assert.equal(t.ls.failures, 3)
  assert.equal(t.ls.state, 'polling')
  assert.ok(t.timers.fire(30000), 'ポーリングの間も 30 秒ごとに SSE を試す')
  await flush()
  assert.equal(t.ls.state, 'polling', '失敗が続く間は polling のまま')
  assert.ok(t.timers.fire(30000))
  await flush()
  assert.equal(t.ls.state, 'live')
  assert.equal(t.ls.failures, 0)
  assert.deepEqual(t.states, ['connecting', 'reconnecting', 'polling', 'live'])
  t.ls.stop()
})

// 401 は httpNodeAuth（Basic 認証）のサーバーで Node-RED が返すだけ。ログインへは戻さず、いつもの失敗として繋ぎ直す。
test('401 も繋ぎ直し、3 回続けば polling（ログインへ戻す分岐は無い）', async () => {
  const u = () => streamResponse([], { status: 401 })
  const t = setup([u, u, u])
  t.ls.start()
  await flush()
  assert.equal(t.ls.state, 'reconnecting')
  assert.deepEqual(t.timers.pending(), [1000])
  assert.ok(t.timers.fire(1000))
  await flush()
  assert.ok(t.timers.fire(3000))
  await flush()
  assert.equal(t.ls.state, 'polling')
  assert.equal(t.calls.length, 3)
  t.ls.stop()
})

// stream?adapter=<id> が 404（ADAPTER_NOT_FOUND）なら繋ぎ直さずに止め、詳細の「見つかりません」に任せる。
// 戻すと落ちるもの: sse-client.js の 404 の見分けを外す → reconnecting → 3 回で polling（「リアルタイム更新が切れています」の帯）になる。
test('404 ADAPTER_NOT_FOUND は onNotFound を呼んで止まる（繋ぎ直さない・polling にしない）', async () => {
  const body = { error: { code: 'ADAPTER_NOT_FOUND', message: 'アダプタが見つかりません' } }
  const t = setup([() => new Response(JSON.stringify(body), { status: 404, headers: { 'Content-Type': 'application/json' } })])
  t.ls.start()
  await flush()
  assert.equal(t.ls.state, 'stopped')
  assert.deepEqual(t.timers.pending(), [], '繋ぎ直しの予定が無い')
  assert.equal(t.notFound.length, 1)
  assert.equal(t.notFound[0].code, 'ADAPTER_NOT_FOUND')
  assert.equal(t.notFound[0].message, 'アダプタが見つかりません')
  assert.equal(t.states.includes('reconnecting') || t.states.includes('polling'), false, t.states.join(','))
  assert.equal(t.calls.length, 1)
})

// 受け手（app.js）は 404 で ?adapter= を付けない SSE に作り直す。'stopped' を知らせる前に onNotFound を呼び、
// 受け手が「作り直すので帯に出さない」と決められるようにする（出すと「停止」の帯が一瞬出てちらつく）。
// 戻すと落ちるもの: sse-client.js で stop()（'stopped'）を onNotFound より先に呼ぶ。
test('404 ADAPTER_NOT_FOUND は、止める（stopped）前に onNotFound を呼ぶ', async () => {
  const body = { error: { code: 'ADAPTER_NOT_FOUND', message: 'アダプタが見つかりません' } }
  const t = setup([() => new Response(JSON.stringify(body), { status: 404, headers: { 'Content-Type': 'application/json' } })])
  t.ls.start()
  await flush()
  assert.equal(t.notFound.length, 1)
  assert.deepEqual(t.notFound[0].statesAtCall, ['connecting'], '知らせた時点ではまだ止めていない')
  assert.deepEqual(t.states, ['connecting', 'stopped'], '知らせたあとに止める')
  assert.equal(t.ls.state, 'stopped')
})

// 止まったあと（404 で止めた・止めた後の帯の「再試行」）でも、retryNow で繋ぎ直す。
// 戻すと落ちるもの: retryNow の先頭の `if (stopped) return` を戻す → 2 回目の fetch が無い。
test('止まったあとでも retryNow で繋ぎ直す（帯の「再試行」）', async () => {
  const body = { error: { code: 'ADAPTER_NOT_FOUND', message: 'アダプタが見つかりません' } }
  const t = setup([
    () => new Response(JSON.stringify(body), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    (init) => streamResponse(['event: hello\ndata: {}\n\n'], { close: false, signal: init.signal }),
  ])
  t.ls.start()
  await flush()
  assert.equal(t.ls.state, 'stopped')
  t.ls.retryNow()
  await flush()
  assert.equal(t.calls.length, 2, '繋ぎ直した')
  assert.equal(t.ls.state, 'live')
  assert.deepEqual(t.states, ['connecting', 'stopped', 'connecting', 'live'])
  t.ls.stop()
})

// 読み終わった直後に止めた（台を移った・「見つかりません」で作り直した）とき、中断済みのストリームの reader.cancel() が
// AbortError で reject し、受け手が無いので「Uncaught (in promise)」になっていた（本物の http-api と App を繋いだ確かめで出た）。
// 戻すと落ちるもの: sse-client.js の reader.cancel() の reject を受けない形に戻す → unhandledRejection が 1 つ出る。
test('読み終わった直後に止めても、中断済みの reader.cancel() の失敗を外へ漏らさない', async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  const enc = new TextEncoder()
  let ctl
  const t = setup([
    (init) => {
      const body = new ReadableStream({
        start(c) {
          ctl = c
          c.enqueue(enc.encode('event: hello\ndata: {}\n\n'))
        },
      })
      init.signal.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')))
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
  ])
  try {
    t.ls.start()
    await flush()
    assert.equal(t.ls.state, 'live')
    // 待っている read() に値が届いた直後（続きが走る前）に止める
    ctl.enqueue(enc.encode('event: adapters\ndata: {"items":[]}\n\n'))
    t.ls.stop()
    await flush(20)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(unhandled.map((e) => e && e.name), [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('ほかの 404（API が無い古い版など）は、いつもの失敗として繋ぎ直す', async () => {
  const t = setup([() => new Response('<html>Cannot GET</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })])
  t.ls.start()
  await flush()
  assert.equal(t.notFound.length, 0)
  assert.equal(t.ls.state, 'reconnecting')
  assert.deepEqual(t.timers.pending(), [1000])
  t.ls.stop()
})

test('30 分の寿命で自分から閉じ、すぐに Last-Event-ID つきで繋ぎ直す（失敗に数えない）', async () => {
  const t = setup([
    (init) => streamResponse(['id: 5\nevent: hello\ndata: {}\n\n'], { close: false, signal: init.signal }),
    (init) => streamResponse([': ping\n\n'], { close: false, signal: init.signal }),
  ])
  t.ls.start()
  await flush()
  assert.equal(t.ls.state, 'live')
  assert.ok(t.timers.pending().includes(30 * 60 * 1000))
  assert.ok(t.timers.fire(30 * 60 * 1000))
  await flush()
  assert.equal(t.calls.length, 2)
  assert.equal(t.calls[1].headers['Last-Event-ID'], '5')
  assert.equal(t.ls.failures, 0)
  t.ls.stop()
})

test('45 秒なにも届かなければ切れたとみなして繋ぎ直す', async () => {
  const t = setup([
    (init) => streamResponse(['event: hello\ndata: {}\n\n'], { close: false, signal: init.signal }),
    (init) => streamResponse([], { close: false, signal: init.signal }),
  ])
  t.ls.start()
  await flush()
  assert.ok(t.timers.fire(45000))
  await flush()
  assert.equal(t.ls.state, 'reconnecting')
  assert.ok(t.timers.fire(1000))
  await flush()
  assert.equal(t.calls.length, 2)
  t.ls.stop()
})

test('読めない JSON のイベントは捨てて、次のイベントは渡す', async () => {
  const t = setup([() => streamResponse(['event: adapters\ndata: {oops\n\n', 'event: adapters\ndata: {"items":[]}\n\n'], { close: false })])
  t.ls.start()
  await flush()
  assert.deepEqual(t.events.map((e) => e.data), [{ items: [] }])
  t.ls.stop()
})
