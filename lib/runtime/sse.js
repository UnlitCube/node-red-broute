'use strict'

// ============================================================================
//  SSE（GET {httpNodeRoot}wsuha-broute/api/v1/stream）
// ============================================================================
//
//  読むのにログインは要らないので、画面は EventSource で受けてよい（Last-Event-ID を自動で送り、繋ぎ直す）。
//  fetch のストリームと自前のパーサで受けても同じものが届く。誰でも読める（秘密は入れない）。
//
//    hello        {serverTime, seq}                       … 繋いだ直後（id なし）
//    adapters     {items: AdapterSummary[]}               … 増減・状態の変化。1 秒に 2 回まで（後の値を優先）
//    adapter      AdapterDetail                           … ?adapter=<id> の 1 台。1 秒に 2 回まで
//    measurement  {adapterId, at, items: ValueRow[]}      … ?adapter=<id> の 1 台だけ
//    log          LogRow                                   … ?adapter=<id>&logs=1 のとき
//    settings     {adapterId, settings}
//    config       {adapterId, config}                     … 構成が変わったとき（認証情報の値は入らない）
//    reset        {}                                       … 取りこぼしをリングから再送できない
//
//  - id は全体の通し番号（起動時刻のミリ秒から数え始める。再起動をまたいでも前の id より大きくなるので、
//    再起動前の Last-Event-ID はリングに無いとみなされて reset になる）。
//  - Last-Event-ID が来たら、それより新しいものをリング（500 件）から再送する。足りなければ reset。
//  - 20 秒ごとに `: ping`。1 本は最長 30 分で閉じる。送り残しが 1MB を超えた接続は切る。
//  - closeAll() で全部閉じる（Node-RED が止まるとき）。
//  - settings は運用設定の保存（registry の 'settings'）だけでなく、Settings の中身が変わったときにも出す。
//    一時的な上書き（フローの interval / epcs・画面の「自動運転に戻す」）や、運用設定の無い項目をエディタで変えたときも
//    出どころと値が変わるため。1 台ごとに前に出した Settings と比べ、同じなら出さない（changed のたびに繰り返さない）。
//    出力 2 の settings（運用設定の変化だけ）とは別で、ここ（SSE）だけに出す。
//
//  受け手（registry のイベント）から呼ばれる処理は、例外を外へ出さない。
//  SSE の失敗で計測の流れや Node-RED のプロセスを止めないため。
//
//  接続の守り:
//  - 本数の上限: 全体 maxConnections（既定 32）と接続元（req.ip か socket の remoteAddress）ごと maxPerClient（既定 8）。
//    超えたら 503 TOO_MANY_STREAMS と Retry-After（画面の sse-client は失敗として数え、5 秒ごとの取得に移る）。
//    リバースプロキシの裏では接続元が 1 つに見えるので、全員で maxPerClient 本になる（settings.js の wsuhaBroute.sse で変えられる）。
//  - 送り残しが上限を超えた接続は destroy() で切る（end() だけでは、読まない相手のソケットと未送信のデータが残る）。
//    寿命（30 分）は end() で閉じ、closeGraceMs（既定 5 秒）で
//    送り終わらなければ destroy() する。
//  - adapters のデータに total（GET adapters と同じ全台の合計。service.totalOf）を載せる（画面で規則を二重に持たない）。

const { ApiError } = require('./errors')

const DEFAULTS = {
  ringSize: 500,
  pingMs: 20 * 1000,
  maxAgeMs: 30 * 60 * 1000,
  throttleMs: 500, // 1 秒に 2 回まで
  maxBufferBytes: 1024 * 1024,
  maxConnections: 32,
  maxPerClient: 8,
  retryAfterSec: 30,
  closeGraceMs: 5000,
  // 値の古さ（stale・power.fresh）と健康の段は、事象が無くても時間が経つだけで変わる。接続がある間、この間隔で見直す
  freshCheckMs: 15 * 1000,
}

const ALL = { hello: 1, adapters: 1, settings: 1, config: 1, reset: 1 }

/**
 * @param {object} p
 * @param {object} p.registry
 * @param {object} p.views {summaries(), detail(id), measurement(id, result), settings(id)}
 * @param {object} [p.options] DEFAULTS を上書き（試験で詰める）
 * @param {function} [p.onError] (err) 失敗を知らせる先
 */
function createSseHub(p) {
  const o = Object.assign({}, DEFAULTS, p.options || {})
  const registry = p.registry
  const views = p.views
  const onError = typeof p.onError === 'function' ? p.onError : function () {}
  const now = typeof p.now === 'function' ? p.now : Date.now

  let seq = now()
  const ring = []
  const conns = new Set()
  const throttles = new Map()

  function safe(fn) {
    return function () {
      try {
        return fn.apply(null, arguments)
      } catch (err) {
        try {
          onError(err)
        } catch (e) {
          /* 知らせる先でも失敗したら諦める */
        }
      }
    }
  }

  function frame(id, event, data) {
    const json = JSON.stringify(data === undefined ? {} : data)
    return (id !== null ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${json}\n\n`
  }

  function wants(conn, entry) {
    if (ALL[entry.event]) return true
    if (entry.event === 'log') return !!conn.logs && conn.adapterId === entry.adapterId
    return conn.adapterId !== null && conn.adapterId === entry.adapterId
  }

  function write(conn, text) {
    if (conn.closed) return
    try {
      conn.res.write(text)
      const buffered = typeof conn.res.writableLength === 'number' ? conn.res.writableLength : 0
      // 読まない相手: end() では送り残しとソケットが残るので、すぐ切る
      if (buffered > o.maxBufferBytes) close(conn, '送り残しが多すぎるため', { hard: true })
    } catch (err) {
      close(conn, '書けないため', { hard: true })
    }
  }

  /** 一覧（adapters）のデータ。views.adapters（{items, total}）があればそれ、無ければ items だけ。 */
  function adaptersData() {
    if (typeof views.adapters === 'function') return views.adapters()
    return { items: views.summaries() }
  }

  /** 通し番号を振ってリングに積み、望む接続へ送る。 */
  function publish(event, adapterId, data) {
    const id = ++seq
    const entry = { id, event, adapterId: adapterId || null, text: frame(id, event, data) }
    ring.push(entry)
    if (ring.length > o.ringSize) ring.splice(0, ring.length - o.ringSize)
    for (const c of conns) if (wants(c, entry)) write(c, entry.text)
    return id
  }

  /** 後の値を優先して間引く。key ごとに throttleMs に 1 回まで。中身は送る時点で作る。 */
  function schedule(key, fn) {
    let t = throttles.get(key)
    if (!t) {
      t = { last: 0, timer: null }
      throttles.set(key, t)
    }
    if (t.timer) return
    const wait = Math.max(0, t.last + o.throttleMs - now())
    t.timer = setTimeout(
      safe(() => {
        t.timer = null
        t.last = now()
        fn()
      }),
      wait
    )
    if (t.timer.unref) t.timer.unref()
  }

  function pushAdapters() {
    schedule('adapters', () => publish('adapters', null, adaptersData()))
  }

  function pushAdapter(id) {
    schedule('adapter:' + id, () => {
      const d = views.detail(id)
      if (d) publish('adapter', id, d)
    })
  }

  /** 1 台ごとに、最後に出した Settings（JSON）。同じものを繰り返さないため。 */
  const lastSettings = new Map()

  function publishSettings(id, s) {
    lastSettings.set(id, JSON.stringify(s))
    publish('settings', id, { adapterId: id, settings: s })
  }

  /** Settings が前に出したものと違えば出す（一時的な上書き・エディタの変更など、保存を通らない変化）。間引く。 */
  function checkSettings(id) {
    schedule('settings:' + id, () => {
      // 設定ノードを作り直している途中（release から claim まで）は出さない。覚えた値は残す
      // （同じ値のまま作り直したときに、同じ settings を出し直さないため。消すのは registry の removed）
      const s = views.settings(id)
      if (!s) return
      if (JSON.stringify(s) === lastSettings.get(id)) return
      publishSettings(id, s)
    })
  }

  /** 1 台ごとに、最後に出した Config（JSON）。 */
  const lastConfig = new Map()

  function publishConfig(id, c) {
    lastConfig.set(id, JSON.stringify(c))
    publish('config', id, { adapterId: id, config: c })
  }

  /** Config が前に出したものと違えば出す（エディタで構成を変えたデプロイ・有効の入れ直しなど、保存を通らない変化）。 */
  function checkConfig(id) {
    if (typeof views.config !== 'function') return
    schedule('config:' + id, () => {
      const c = views.config(id)
      if (!c) return
      if (JSON.stringify(c) === lastConfig.get(id)) return
      publishConfig(id, c)
    })
  }

  // 今いる台の Settings と Config を覚えておく（作った直後の最初の変化で、変わっていないものを出さないため）
  try {
    for (const h of typeof registry.list === 'function' ? registry.list() : []) {
      const s = views.settings(h.id)
      if (s) lastSettings.set(h.id, JSON.stringify(s))
      const c = typeof views.config === 'function' ? views.config(h.id) : null
      if (c) lastConfig.set(h.id, JSON.stringify(c))
    }
  } catch (err) {
    onError(err)
  }

  // --- registry の購読 --------------------------------------------------------
  const listeners = {
    added: safe((id) => pushAdapters()),
    removed: safe((id) => {
      lastSettings.delete(id)
      lastConfig.delete(id)
      pushAdapters()
    }),
    changed: safe((id) => {
      pushAdapters()
      pushAdapter(id)
      checkSettings(id)
      checkConfig(id)
    }),
    measurement: safe((id, result) => {
      const rows = views.measurement(id, result)
      if (rows) publish('measurement', id, { adapterId: id, at: (result && result.ts) || now(), items: rows })
    }),
    logRow: safe((id, row) => publish('log', id, row)),
    // 運用設定の保存・全部外す・照合で外した（すぐ出す）
    settings: safe((id) => {
      const s = views.settings(id)
      if (s) publishSettings(id, s)
    }),
    // 構成・認証情報の保存・全部外す・照合で外した・開き直しの始めと終わり（すぐ出す）
    config: safe((id) => {
      const c = typeof views.config === 'function' ? views.config(id) : null
      if (c) publishConfig(id, c)
    }),
  }
  for (const [name, fn] of Object.entries(listeners)) registry.on(name, fn)

  // --- 時間で変わる古さ ---------------------------------------------------------
  // メーターが値を断り続ける台は、取得の応答に値が無いので事象（changed）が来ない。値の古さは時間で変わるので、
  // 接続がある間だけ決まった間隔で一覧の形を作り直し、古さ・健康の段・合計の台数が前に見たものと違えば送る。
  // 健康の題（「最終 n 分前」）は分ごとに変わるので比べない（比べると古い間ずっと毎分送ることになる）
  const lastFresh = new Map()
  let lastTotal = null
  function freshPrint(a) {
    return [a.stale === true, a.health ? a.health.level : null, a.power ? a.power.fresh : null].join('|')
  }
  function checkFreshness() {
    if (!conns.size) return
    const data = adaptersData()
    const items = (data && data.items) || []
    let changed = false
    const seen = new Set()
    for (const a of items) {
      if (!a || a.id === undefined) continue
      seen.add(a.id)
      const fp = freshPrint(a)
      if (lastFresh.has(a.id) && lastFresh.get(a.id) !== fp) {
        changed = true
        pushAdapter(a.id)
      }
      lastFresh.set(a.id, fp)
    }
    for (const id of Array.from(lastFresh.keys())) if (!seen.has(id)) lastFresh.delete(id)
    const total = data && data.total ? JSON.stringify([data.total.power === null, data.total.count, data.total.staleCount]) : null
    if (lastTotal !== null && total !== lastTotal) changed = true
    lastTotal = total
    if (changed) pushAdapters()
  }
  const freshTimer = o.freshCheckMs > 0 ? setInterval(safe(checkFreshness), o.freshCheckMs) : null
  if (freshTimer && freshTimer.unref) freshTimer.unref()

  // --- 接続 -------------------------------------------------------------------

  /** 接続元ごとの本数。 */
  const perClient = new Map()

  function clientOf(req) {
    const r = req || {}
    const s = r.socket || r.connection || {}
    const ip = typeof r.ip === 'string' && r.ip ? r.ip : typeof s.remoteAddress === 'string' ? s.remoteAddress : ''
    return ip || '(不明)'
  }

  /** 相手のソケットごと切る（destroy が無い res は end）。 */
  function hardClose(res) {
    try {
      if (res && typeof res.destroy === 'function') res.destroy()
      else if (res) res.end()
    } catch (err) {
      /* 既に閉じている */
    }
  }

  /**
   * @param {object} [opts] {hard: true} なら destroy() で切る（溢れた・書けない）。
   *   そうでなければ end() で閉じ、closeGraceMs で送り終わらなければ destroy()（寿命・停止）
   */
  function close(conn, why, opts) {
    if (conn.closed) return
    conn.closed = true
    conns.delete(conn)
    const n = (perClient.get(conn.client) || 1) - 1
    if (n > 0) perClient.set(conn.client, n)
    else perClient.delete(conn.client)
    clearInterval(conn.ping)
    clearTimeout(conn.maxAge)
    const res = conn.res
    if (opts && opts.hard) return hardClose(res)
    try {
      res.end()
    } catch (err) {
      /* 既に閉じている */
    }
    // 読まない相手は end() しても送り終わらない（'finish' が来ない）。少し待って切る
    if (res && typeof res.destroy === 'function' && !res.writableFinished && o.closeGraceMs >= 0) {
      const t = setTimeout(() => {
        if (!res.writableFinished && !res.destroyed) hardClose(res)
      }, o.closeGraceMs)
      if (t.unref) t.unref()
      if (typeof res.once === 'function') res.once('finish', () => clearTimeout(t))
    }
  }

  /**
   * @param {object} req
   * @param {object} res
   * @param {object} q {adapterId: string|null, logs: boolean, lastEventId: string|undefined}
   * @throws {ApiError} 503 TOO_MANY_STREAMS（本数の上限。何も書かずに投げる。呼んだ側が JSON で返す）
   */
  function handle(req, res, q) {
    const client = clientOf(req)
    const mine = perClient.get(client) || 0
    if (conns.size >= o.maxConnections || mine >= o.maxPerClient) {
      const msg =
        conns.size >= o.maxConnections
          ? `リアルタイム更新の接続が多すぎます（全体で ${o.maxConnections} 本まで）。しばらくしてからつなぎ直してください`
          : `この端末からのリアルタイム更新の接続が多すぎます（${o.maxPerClient} 本まで）。開いている画面のタブを減らしてください`
      throw new ApiError(503, 'TOO_MANY_STREAMS', msg, null, { 'Retry-After': String(o.retryAfterSec) })
    }
    const conn = {
      req,
      res,
      client,
      adapterId: q.adapterId || null,
      logs: !!q.logs,
      closed: false,
      ping: null,
      maxAge: null,
    }
    perClient.set(client, mine + 1)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Connection', 'keep-alive')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    conns.add(conn)
    const cleanup = () => close(conn, '相手が閉じた')
    if (req && typeof req.on === 'function') req.on('close', cleanup)
    if (res && typeof res.on === 'function') res.on('close', cleanup)

    write(conn, frame(null, 'hello', { serverTime: now(), seq }))

    const last = q.lastEventId === undefined || q.lastEventId === null || q.lastEventId === '' ? NaN : Number(q.lastEventId)
    if (Number.isFinite(last)) {
      const oldest = ring.length ? ring[0].id : seq + 1
      if (last > seq || last < oldest - 1) {
        write(conn, frame(null, 'reset', {}))
      } else {
        for (const e of ring) if (e.id > last && wants(conn, e)) write(conn, e.text)
      }
    } else {
      // 初めての接続: 一覧（と見ている 1 台）の今の値を先に送る。GET と繋ぐまでの間の変化を落とさないため
      try {
        write(conn, frame(null, 'adapters', adaptersData()))
        if (conn.adapterId) {
          const d = views.detail(conn.adapterId)
          if (d) write(conn, frame(null, 'adapter', d))
        }
      } catch (err) {
        onError(err)
      }
    }

    // 再送で溢れると write() がここまでに閉じる。閉じたあとに張ると、消す人のいないタイマーが conn と res を握り続ける
    if (conn.closed) return conn

    conn.ping = setInterval(() => write(conn, ': ping\n\n'), o.pingMs)
    if (conn.ping.unref) conn.ping.unref()
    conn.maxAge = setTimeout(() => close(conn, '最長の時間を過ぎた'), o.maxAgeMs)
    if (conn.maxAge.unref) conn.maxAge.unref()
    return conn
  }

  function closeAll() {
    for (const c of Array.from(conns)) close(c, '停止')
  }

  function dispose() {
    if (freshTimer) clearInterval(freshTimer)
    closeAll()
    for (const [name, fn] of Object.entries(listeners)) registry.removeListener(name, fn)
    for (const t of throttles.values()) if (t.timer) clearTimeout(t.timer)
    throttles.clear()
  }

  return {
    handle,
    closeAll,
    dispose,
    publish,
    get connections() {
      return conns.size
    },
    /** 接続元ごとの本数（試験と診断用）。 */
    clients() {
      const out = {}
      for (const [k, v] of perClient) out[k] = v
      return out
    },
    get seq() {
      return seq
    },
    get ring() {
      return ring.slice()
    },
  }
}

module.exports = { createSseHub, DEFAULTS }
