// 画面の状態（reducer は純関数。test/ui/store.test.mjs）。
// サーバーの値は受け取った形のまま持ち、表示の整形は format.js でする。
// 書き込みを止めるのは、読み出しのみ（meta.readOnly と 403 READ_ONLY）と Node-RED の認証（auth）。
// エディタのトークンの値はここに入れない（editor-token.js が要求のたびに読む）。
import { normEpc, epcName } from './format.js'

export const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 }
export const LOG_CAP = 2000
export const DIAG_CAP = 30
export const TOAST_CAP = 4
/** サーバーが推移を間引く点の数（service.js の TREND_MAX_POINTS）。SSE で足す点も、範囲 ÷ この数の幅の枠にまとめる。 */
export const TREND_POINTS = 720

export const initialState = {
  meta: null,
  // total はサーバーの合計（GET adapters・SSE の adapters の total）。無い古いサーバーは null
  list: { items: null, total: null, status: 'idle', error: null, at: null },
  details: {},
  values: {},
  trends: {},
  logs: {},
  settings: {},
  // 構成（GET adapters/:id/config）。status は 'ok'・'error'・'unsupported'（古いサーバー: 404 NOT_FOUND）
  configs: {},
  // GET serialports（全台で共通）。loading は読み直しの間（前の候補を出したまま）
  serialports: { items: null, at: null, status: 'idle', error: null, message: null },
  diag: {},
  live: 'connecting',
  stale: false,
  readOnly: null,
  // 403 CONFIG_LOCKED（settings.js の wsuhaBroute.uiConfig: false）のサーバーの message。構成と認証情報の書き込みだけを止める
  configLocked: null,
  // Node-RED の認証（adminAuth）。required が false のサーバーでは残りを見ない。
  // canWrite の初期値が false なのは、GET session を読めるまで閉じる側に倒すため
  auth: { required: false, available: false, loggedIn: false, canWrite: false },
  toasts: [],
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

function setIn(state, key, id, value) {
  return Object.assign({}, state, { [key]: Object.assign({}, state[key], { [id]: value }) })
}

/**
 * [ts, v] の列に 1 点足す（ts が最後より新しいときだけ）。windowMs より古い点は捨てる。
 * bucketMs があれば、最後の点と同じ枠（floor(ts / bucketMs)）の点は足さずに最後の点を置き換える
 * （サーバーと同じ点の数に収める。24 時間を開いたままでも点が増え続けない）。
 * merge（前の値, 新しい値）を渡すと、置き換える値をそれで決める（LQI は枠の中の小さい方を残す）。
 */
export function appendPoint(points, ts, v, windowMs, bucketMs, merge) {
  if (!isNum(ts) || !(isNum(v) || v === null)) return points || []
  const list = points || []
  const last = list.length ? list[list.length - 1][0] : -Infinity
  if (ts <= last) return list
  const from = ts - windowMs
  const kept = list.filter((p) => p[0] >= from)
  if (isNum(bucketMs) && bucketMs > 0 && kept.length && Math.floor(kept[kept.length - 1][0] / bucketMs) === Math.floor(ts / bucketMs)) {
    kept[kept.length - 1] = [ts, merge ? merge(kept[kept.length - 1][1], v) : v]
    return kept
  }
  kept.push([ts, v])
  return kept
}

/** 枠の中の LQI は小さい方を残す。落ち込みが後の値に隠れると、途切れの原因が読めなくなる（サーバーの間引きと同じ）。 */
const lowerLqi = (prev, v) => (isNum(prev) ? Math.min(prev, v) : v)

/** アダプタの power / current の新しい値を、読み込み済みの推移へ足す。 */
function absorbAdapter(state, a) {
  if (!a || !a.id) return state
  let s = state
  const power = a.power || {}
  const tr = s.trends[a.id]
  if (tr && tr.status === 'ok' && tr.series) {
    const win = RANGES[tr.range] || RANGES['1h']
    const bucket = win / TREND_POINTS
    const series = Object.assign({}, tr.series)
    let changed = false
    if (isNum(power.at) && isNum(power.value)) {
      const next = appendPoint(series.power, power.at, power.value, win, bucket)
      if (next !== series.power) {
        series.power = next
        changed = true
      }
    }
    const cur = a.current || {}
    if (isNum(cur.at)) {
      if (isNum(cur.r)) {
        const next = appendPoint(series.currentR, cur.at, cur.r, win, bucket)
        if (next !== series.currentR) {
          series.currentR = next
          changed = true
        }
      }
      if (isNum(cur.t)) {
        const next = appendPoint(series.currentT, cur.at, cur.t, win, bucket)
        if (next !== series.currentT) {
          series.currentT = next
          changed = true
        }
      }
    }
    // 受信の強さ
    const m = a.meter || {}
    if (isNum(m.lqiAt) && isNum(m.lqi)) {
      const next = appendPoint(series.lqi, m.lqiAt, m.lqi, win, bucket, lowerLqi)
      if (next !== series.lqi) {
        series.lqi = next
        changed = true
      }
    }
    if (changed) {
      const to = Math.max(tr.to || 0, power.at || 0, cur.at || 0, m.lqiAt || 0)
      s = setIn(s, 'trends', a.id, Object.assign({}, tr, { series, to, from: to - win }))
    }
  }
  return s
}

/** 一覧の 1 台を、詳細（同じ id）で置き換える。一覧に無ければ何もしない。 */
function mergeIntoList(list, adapter) {
  if (!list.items) return list
  let found = false
  const items = list.items.map((it) => {
    if (it.id !== adapter.id) return it
    found = true
    return Object.assign({}, it, adapter)
  })
  return found ? Object.assign({}, list, { items }) : list
}

/**
 * 計測値の行を EPC で混ぜる（rows が prevItems を上書きする）。
 * fresh はサーバーが EPC ごとの周期で決めた値をそのまま使う。届かなかった行の fresh は変えない
 * （5 分ごと・30 分ごと・1 回だけの EPC は、速い周期の受信に入っていなくても新しい）。
 * 時間がたって古くなったことは、app.js が計測値タブで REST を周期で取り直して映す。
 */
export function mergeValues(prevItems, rows) {
  const byEpc = new Map()
  for (const r of prevItems || []) {
    if (r && r.epc !== undefined) byEpc.set(r.epc, r)
  }
  for (const r of rows || []) {
    if (!r || r.epc === undefined) continue
    byEpc.set(r.epc, r)
  }
  return [...byEpc.values()].sort((a, b) => String(a.epc).localeCompare(String(b.epc)))
}

/**
 * 計測値の表に、read（GET adapters/:id/read。maxAgeSec なしは無線を使わない）の値を重ねる。
 * 表（GET values）は今の sequencer の値（snapshot().known）だけで、read は registry が持つ「いま分かっている値」
 * （デプロイや構成の変更で作り直す前に取れていた値を含む）と、まだ一度も取れていない定期取得の値（missing）を返す。
 * ノードの read と同じものを表に出すため:
 * - 表に無い・表では値の無い（at が null）EPC は、read の値の行にする（控え中・持っているか・短い名前・確定の時刻は表の行のまま）。
 *   作り直しの直後は表の値が空になるので、ここで落とすと値が戻るまで名前と時刻の列が変わって見える
 * - read の missing で表に無い EPC は、値の無い行（「まだ取れていません」）を足す
 * read が無い（古いサーバー・失敗）なら表のまま。並びは EPC の順（mergeValues と同じ）。
 */
export function mergeRead(items, read) {
  const rows = items || []
  if (!read || typeof read !== 'object' || !read.values || typeof read.values !== 'object') return rows
  const byEpc = new Map()
  for (const r of rows) if (r && r.epc !== undefined) byEpc.set(String(r.epc).toUpperCase(), r)
  const key = (e) => {
    const n = normEpc(e)
    return n ? '0X' + n : null
  }
  for (const name of Object.keys(read.values)) {
    const b = read.values[name]
    const k = b && key(b.epc)
    if (!k) continue
    const prev = byEpc.get(k)
    if (prev && isNum(prev.at)) continue
    byEpc.set(k, {
      epc: '0x' + normEpc(b.epc),
      key: prev && prev.key ? prev.key : /^[0-9A-F]{2}$/i.test(name) ? null : name,
      name: typeof b.name === 'string' && b.name ? b.name : prev && prev.name ? prev.name : epcName(b.epc),
      label: prev && prev.label ? prev.label : typeof b.label === 'string' && b.label ? b.label : null,
      value: b.value === undefined ? null : b.value,
      unit: typeof b.unit === 'string' ? b.unit : null,
      display: b.display === undefined || b.display === null ? '' : b.display,
      at: isNum(b.at) ? b.at : null,
      meterAt: isNum(b.meterAt) ? b.meterAt : prev && isNum(prev.meterAt) ? prev.meterAt : null,
      fresh: b.fresh === true,
      held: prev ? prev.held || null : null,
      supported: prev && prev.supported !== undefined ? prev.supported : null,
    })
  }
  for (const m of Array.isArray(read.missing) ? read.missing : []) {
    const k = key(m)
    if (!k || byEpc.has(k)) continue
    byEpc.set(k, { epc: '0x' + normEpc(m), key: null, name: epcName(m), value: null, unit: null, display: '', at: null, fresh: false, held: null, supported: null })
  }
  return [...byEpc.values()].sort((a, b) => String(a.epc).localeCompare(String(b.epc)))
}

/**
 * REST の計測値（サーバーの時刻 at の時点の表）で置き換える。
 * ただし、その時刻より後に SSE で届いた行（応答より先に着いた measurement）は残す。
 */
export function replaceValues(prevItems, rows, at) {
  if (!isNum(at)) return mergeValues([], rows)
  const newer = (prevItems || []).filter((r) => r && isNum(r.at) && r.at > at)
  return mergeValues(rows, newer)
}

function addLogs(prev, rows, nextSeq) {
  const base = prev && prev.items ? prev.items : []
  const lastSeq = base.length ? base[base.length - 1].seq : -Infinity
  const fresh = (rows || []).filter((r) => r && isNum(r.seq) && r.seq > lastSeq)
  if (!fresh.length && nextSeq === undefined) return prev
  let items = fresh.length ? base.concat(fresh) : base
  if (items.length > LOG_CAP) items = items.slice(items.length - LOG_CAP)
  const seq = isNum(nextSeq) ? nextSeq : items.length ? items[items.length - 1].seq : prev && prev.nextSeq
  return Object.assign({}, prev || { status: 'ok', error: null }, { items, nextSeq: seq, status: 'ok' })
}

/** seq の昇順に並べ、同じ seq は 1 行にする。 */
function uniqBySeq(rows) {
  const out = []
  let last = -Infinity
  for (const r of rows.slice().sort((a, b) => a.seq - b.seq)) {
    if (r.seq === last) continue
    out.push(r)
    last = r.seq
  }
  return out
}

/** 取り直しが 1 つ終わった（成功・失敗）。全部終わったら、控えていた SSE の行を捨てる。 */
function endLogLoad(entry) {
  const loading = Math.max(0, (entry.loading || 0) - 1)
  return Object.assign({}, entry, { loading, pending: loading ? entry.pending || [] : null })
}

/** GET session の答えを auth へ写す。値は真偽だけを取り出す（応答に何が載っていても state に入れない）。 */
function withSession(auth, session) {
  if (!session || typeof session !== 'object') return auth
  return Object.assign({}, auth, { required: session.required === true, loggedIn: session.loggedIn === true, canWrite: session.canWrite === true })
}

/** meta.auth と、一緒に読んだ session（読めなければ今の値のまま）。auth の無い古いサーバーは認証なしと同じ。 */
function authFrom(prev, meta, session) {
  const a = meta && meta.auth && typeof meta.auth === 'object' ? meta.auth : null
  return withSession(Object.assign({}, prev, { required: !!a && a.required === true, available: !!a && a.available === true }), session)
}

/** 推移の応答が、いま選んでいる範囲と別の範囲のものか。 */
function isOtherRange(state, action) {
  const cur = state.trends[action.id]
  return !!cur && cur.range !== action.range
}

export function reducer(state, action) {
  switch (action.type) {
    case 'meta':
      // サーバーが「読み出しのみではない」と言えば、前に受けた 403 READ_ONLY の止めも外す（settings.js を変えて再起動した）
      // 構成の止め（CONFIG_LOCKED）も同じ。configLocked を返さない古いサーバーの meta では外さない
      return Object.assign({}, state, {
        meta: action.meta,
        readOnly: action.meta && action.meta.readOnly === false ? null : state.readOnly,
        configLocked: action.meta && action.meta.configLocked === false ? null : state.configLocked,
        auth: authFrom(state.auth, action.meta, action.session),
      })

    case 'auth/session':
      return Object.assign({}, state, { auth: withSession(state.auth, action.session) })

    // 変更の要求がサーバーに断られた（トークンが切れた・権限が足りない）。次に session を読むまで止める
    case 'auth/denied':
      return Object.assign({}, state, { auth: Object.assign({}, state.auth, { required: true, loggedIn: action.loggedIn === true, canWrite: false }) })

    case 'list/loading':
      return Object.assign({}, state, { list: Object.assign({}, state.list, { status: state.list.items ? 'ok' : 'loading', error: null }) })

    case 'list/loaded': {
      // total が無い応答（古いサーバー・SSE の adapters に total を載せないサーバー）は null（画面が数え直す）
      const total = action.total && typeof action.total === 'object' ? action.total : null
      let s = Object.assign({}, state, {
        list: { items: action.items || [], total, status: 'ok', error: null, at: action.at || null },
        stale: false,
      })
      for (const a of action.items || []) s = absorbAdapter(s, a)
      return s
    }

    case 'list/failed':
      return Object.assign({}, state, {
        list: Object.assign({}, state.list, { status: state.list.items ? 'ok' : 'error', error: action.error }),
        stale: !!state.list.items,
      })

    // 「見つかりません」（notFound）は、確かめ直しの間とほかの失敗では外さない。外すと app.js が
    // ?adapter= の SSE へ戻って 404 を受け直し、右ペインに消えた台の古い詳細がちらつく。外すのは取れたとき（detail/loaded）だけ。
    case 'detail/loading': {
      const prev = state.details[action.id]
      const status = prev && prev.status === 'notFound' ? 'notFound' : prev && prev.data ? 'ok' : 'loading'
      return setIn(state, 'details', action.id, Object.assign({ data: null }, prev, { status, error: status === 'notFound' ? prev.error : null }))
    }

    case 'detail/loaded': {
      const a = action.adapter
      if (!a || !a.id) return state
      let s = setIn(state, 'details', a.id, { data: a, status: 'ok', error: null })
      s = Object.assign({}, s, { list: mergeIntoList(s.list, a) })
      return absorbAdapter(s, a)
    }

    case 'detail/failed': {
      const prev = state.details[action.id] || { data: null }
      const notFound = (action.error && action.error.status === 404) || prev.status === 'notFound'
      return setIn(state, 'details', action.id, Object.assign({}, prev, {
        status: notFound ? 'notFound' : prev.data ? 'ok' : 'error',
        error: action.error,
      }))
    }

    case 'values/loaded': {
      const prev = state.values[action.id]
      const items = replaceValues(prev && prev.items, action.items, action.at)
      return setIn(state, 'values', action.id, { items, at: action.at || null, status: 'ok', error: null })
    }

    case 'values/failed': {
      const prev = state.values[action.id]
      return setIn(state, 'values', action.id, Object.assign({ items: null, at: null }, prev, { status: prev && prev.items ? 'ok' : 'error', error: action.error }))
    }

    case 'measurement': {
      const id = action.adapterId
      if (!id) return state
      const prev = state.values[id] || { items: [], at: null, status: 'ok', error: null }
      return setIn(state, 'values', id, Object.assign({}, prev, { items: mergeValues(prev.items, action.items), at: action.at || prev.at, status: 'ok' }))
    }

    case 'trend/loading': {
      const prev = state.trends[action.id]
      const same = prev && prev.range === action.range && prev.series
      return setIn(state, 'trends', action.id, same ? Object.assign({}, prev, { error: null }) : { range: action.range, series: null, from: null, to: null, status: 'loading', error: null })
    }

    // 範囲を続けて切り替えると、重い 24 時間の応答が 1 時間の応答より後に着く。いま選んでいる範囲の答えだけを取り込む
    // （trend/loading が先に range を替えるので、捨てるのは遅れた応答だけ）
    case 'trend/loaded': {
      if (isOtherRange(state, action)) return state
      const series = action.series || {}
      return setIn(state, 'trends', action.id, {
        range: action.range,
        series: { power: series.power || [], currentR: series.currentR || [], currentT: series.currentT || [], lqi: series.lqi || [] },
        from: action.from || null,
        to: action.to || null,
        status: 'ok',
        error: null,
      })
    }

    case 'trend/failed': {
      if (isOtherRange(state, action)) return state
      const prev = state.trends[action.id]
      return setIn(state, 'trends', action.id, Object.assign({ range: action.range, series: null }, prev, { status: prev && prev.series ? 'ok' : 'error', error: action.error }))
    }

    // ログの取り直し（logs/loading → logs/loaded）の間に SSE で届いた行は pending に控え、
    // 応答（その時点のリング）より新しいものを応答の後ろに足す。応答で置き換えても消えない。
    // 取り直しが重なったときは loading で数え、全部終わるまで控えを残す。
    case 'logs/loading': {
      const prev = state.logs[action.id]
      return setIn(state, 'logs', action.id, Object.assign({ items: null, nextSeq: null }, prev, {
        status: prev && prev.items ? 'ok' : 'loading',
        error: null,
        loading: ((prev && prev.loading) || 0) + 1,
        pending: (prev && prev.loading && prev.pending) || [],
      }))
    }

    case 'logs/loaded': {
      const prev = state.logs[action.id] || {}
      const got = (action.items || []).filter((r) => r && isNum(r.seq))
      const ns = isNum(action.nextSeq) ? action.nextSeq : got.length ? got[got.length - 1].seq : null
      const after = ns === null ? -Infinity : ns
      const extra = (prev.pending || []).filter((r) => r && isNum(r.seq) && r.seq > after)
      const items = got.concat(uniqBySeq(extra)).slice(-LOG_CAP)
      const last = items.length ? items[items.length - 1].seq : null
      const nextSeq = ns === null ? last : last === null ? ns : Math.max(ns, last)
      return setIn(state, 'logs', action.id, endLogLoad(Object.assign({}, prev, { items, nextSeq, status: 'ok', error: null })))
    }

    case 'logs/more': {
      const prev = state.logs[action.id]
      // nextSeq が問い合わせた after より小さい＝サーバーの連番が戻った（Node-RED の再起動）。
      // 持っている行より seq が小さいので足せない。応答の行で置き換える。
      if (prev && isNum(action.after) && isNum(action.nextSeq) && action.nextSeq < action.after) {
        const items = (action.items || []).filter((r) => r && isNum(r.seq)).slice(-LOG_CAP)
        return setIn(state, 'logs', action.id, Object.assign({}, prev, { items, nextSeq: action.nextSeq, status: 'ok', error: null }))
      }
      const next = addLogs(prev, action.items, action.nextSeq)
      return next === prev ? state : setIn(state, 'logs', action.id, next)
    }

    case 'log': {
      const id = action.id
      const prev = state.logs[id]
      let next = addLogs(prev || { items: [], nextSeq: null, status: 'ok', error: null }, [action.row])
      if (prev && prev.loading && action.row && isNum(action.row.seq)) {
        next = Object.assign({}, next, { pending: (prev.pending || []).concat([action.row]).slice(-LOG_CAP) })
      }
      return next === prev ? state : setIn(state, 'logs', id, next)
    }

    case 'logs/failed': {
      const prev = state.logs[action.id]
      const next = Object.assign({ items: null, nextSeq: null }, prev, { status: prev && prev.items ? 'ok' : 'error', error: action.error })
      return setIn(state, 'logs', action.id, endLogLoad(next))
    }

    case 'settings/loaded':
      return setIn(state, 'settings', action.id, { data: action.settings, status: 'ok', error: null })

    case 'settings/failed': {
      const prev = state.settings[action.id]
      return setIn(state, 'settings', action.id, Object.assign({ data: null }, prev, { status: prev && prev.data ? 'ok' : 'error', error: action.error }))
    }

    case 'config/loaded':
      return setIn(state, 'configs', action.id, { data: action.config, status: 'ok', error: null })

    case 'config/unsupported':
      return setIn(state, 'configs', action.id, { data: null, status: 'unsupported', error: null })

    case 'config/failed': {
      const prev = state.configs[action.id]
      return setIn(state, 'configs', action.id, Object.assign({ data: null }, prev, { status: prev && prev.data ? 'ok' : 'error', error: action.error }))
    }

    case 'serialports/loading':
      return Object.assign({}, state, {
        serialports: Object.assign({}, state.serialports, { status: state.serialports.items ? state.serialports.status : 'loading', loading: true, error: null }),
      })

    case 'serialports/loaded':
      return Object.assign({}, state, { serialports: { items: action.items || [], at: isNum(action.at) ? action.at : null, status: 'ok', error: null, message: action.message || null } })

    case 'serialports/unsupported':
      return Object.assign({}, state, { serialports: { items: null, at: null, status: 'unsupported', error: null, message: null } })

    case 'serialports/failed':
      return Object.assign({}, state, {
        serialports: Object.assign({}, state.serialports, { status: state.serialports.items ? 'ok' : 'error', loading: false, error: action.error }),
      })

    case 'configLocked':
      return Object.assign({}, state, { configLocked: action.reason || null })

    case 'diag/add': {
      const list = [action.entry].concat(state.diag[action.id] || []).slice(0, DIAG_CAP)
      return setIn(state, 'diag', action.id, list)
    }

    case 'live':
      return state.live === action.state ? state : Object.assign({}, state, { live: action.state })

    case 'stale':
      return state.stale === !!action.value ? state : Object.assign({}, state, { stale: !!action.value })

    case 'readOnly':
      return Object.assign({}, state, { readOnly: action.reason || null })

    case 'toast/add': {
      const toasts = state.toasts.concat([action.toast]).slice(-TOAST_CAP)
      return Object.assign({}, state, { toasts })
    }

    case 'toast/remove':
      return Object.assign({}, state, { toasts: state.toasts.filter((t) => t.id !== action.id) })

    default:
      return state
  }
}

// ---- 選び出し ----------------------------------------------------------------

/** 共通の帯の要約（計測中 / 注意 / 異常 / 停止中 / 無効）。 */
export function summarize(items) {
  const out = { ok: 0, attention: 0, bad: 0, stopped: 0, disabled: 0, total: 0 }
  for (const a of items || []) {
    out.total++
    const level = a && a.health && a.health.level
    if (level === 'ok') out.ok++
    else if (level === 'busy' || level === 'stale') out.attention++
    else if (level === 'bad') out.bad++
    else if (level === 'stopped' || level === 'idle') out.stopped++
    else if (level === 'disabled') out.disabled++
    else out.attention++ // 知らない段階は「注意」に数える（黙らせない）
  }
  return out
}

/**
 * 一覧の上の合計。サーバーが total（{power, count, enabled, staleCount}）を返していればそれを使い、
 * 無い古いサーバーでは画面で数える（totalPower）。規則を 2 か所に持たない。
 * @returns {{sum: number|null, count: number, total: number, staleCount: number}}
 */
export function listTotal(list) {
  const t = list && list.total
  if (t && typeof t === 'object' && isNum(t.count) && isNum(t.enabled)) {
    return { sum: isNum(t.power) ? t.power : null, count: t.count, total: t.enabled, staleCount: isNum(t.staleCount) ? t.staleCount : 0 }
  }
  return totalPower(list && list.items)
}

/**
 * 全台の瞬時電力の合計。サーバーの total が無いときだけ使う。
 * - 無効の台は数えない（total にも入れない）。
 * - 値が古い（stale）台は足さない。何台除いたかを staleCount で返す（画面は「n 台は値が古いため除外」）。
 * - 値の無い台（停止中・まだ届いていない）は足さない。
 */
export function totalPower(items) {
  let sum = 0
  let count = 0
  let total = 0
  let staleCount = 0
  for (const a of items || []) {
    if (!a || a.enabled === false) continue
    total++
    const v = a.power && a.power.value
    if (!isNum(v)) continue
    if (a.stale === true) {
      staleCount++
      continue
    }
    sum += v
    count++
  }
  return { sum: count ? sum : null, count, total, staleCount }
}

/**
 * Node-RED の認証で止めているときの理由（止めていなければ null）。
 * 権限が足りない人にログインを勧めても解けないので、文を分ける。ログインの入口が無いサーバーも同じ。
 * meta を読む前は入口の有無が分からないので、ログインを勧める文にしておく。
 */
export function authBlockReason(state, S) {
  const a = state.auth
  if (!a || !a.required || a.canWrite) return null
  if (a.loggedIn) return S.auth.forbidden
  return state.meta && !a.available ? S.auth.noLogin : S.auth.loginRequired
}

/**
 * 書き込みの操作ができないときの理由（できるなら null）。
 * 読み出しのみ（settings.js の wsuhaBroute.readOnly と、サーバーが返した 403 READ_ONLY）を先に見る。
 * ログインしても解けないので、ログインを勧めない。
 * meta をまだ読めていない間は止めない（サーバーが断る）。
 */
export function writeBlockReason(state, S) {
  if (state.readOnly) return state.readOnly
  if (state.meta && state.meta.readOnly === true) return S.actions.readOnlyReason
  return authBlockReason(state, S)
}

/**
 * 構成と認証情報の書き込みができないときの理由（できるなら null）。
 * 読み出しのみ（writeBlockReason）が先。次に 403 CONFIG_LOCKED のサーバーの message、meta.configLocked（契約への提案）。
 */
export function configBlockReason(state, S) {
  const ro = writeBlockReason(state, S)
  if (ro) return ro
  if (state.configLocked) return state.configLocked
  if (state.meta && state.meta.configLocked === true) return S.config.lockedReason
  return null
}

/**
 * 設定タブの構成（GET config）に関係する、AdapterDetail の値の印。SSE の config が届かない間（5 秒ごとの取得・
 * config のイベントを出さないサーバー）も、名前・契約・有効・接続先・ポート・デバイスキー・想定 MAC・認証情報の出どころが
 * 変わったら、app.js が config を取り直す。詳細が無ければ null。
 */
export function configSignature(a) {
  if (!a) return null
  const dev = a.device || {}
  const cred = a.credentials || {}
  return JSON.stringify([
    a.name === undefined ? null : a.name,
    a.role === undefined ? null : a.role,
    a.enabled !== false,
    a.mode || null,
    a.port || null,
    a.deviceKey === undefined ? null : a.deviceKey,
    dev.expectedMac || null,
    !!cred.configured,
    cred.source || null,
    cred.pairId || null,
  ])
}

const hasId = (items, id) => Array.isArray(items) && items.some((a) => a && a.id === id)

/**
 * 一覧が変わったとき（前の一覧 → 新しい一覧）、選んでいる台の詳細を GET adapters/:id で確かめ直すか。
 * - 詳細が「見つかりません」（notFound）: その id が一覧に（新しく）戻ったら確かめる。取れたら ?adapter= の SSE へ戻る。
 *   一覧にあり続ける間は確かめない（一覧にあるのに stream だけが 404 を返すとき、GET と SSE を繰り返さない。
 *   取りこぼしは app.js の間隔ごとの確かめ直しで拾う）。
 * - それ以外: 前の一覧にあった id が新しい一覧から消えたら確かめる。削除のデプロイでは SSE は繋がったまま
 *   'adapters'（その台が抜けた一覧）だけが届き、'adapter' も 404 も来ないため。取っている途中（loading）でも確かめる
 *   （消える前に出した GET の 200 で「ある」にしない）。
 * - 一覧が変わっていない（同じ配列・最初の一覧）なら確かめない（詳細の状態が変わっただけで GET を繰り返さない）。
 */
export function needsDetailRecheck(prevItems, items, id, status) {
  if (!id || !Array.isArray(items) || !Array.isArray(prevItems) || prevItems === items) return false
  const has = hasId(items, id)
  const had = hasId(prevItems, id)
  return status === 'notFound' ? has && !had : had && !has
}

/**
 * 設定タブ（GET settings）に関係する、AdapterDetail の値の印。
 * 一時的な上書き（フローの interval・epcs、画面の「自動運転に戻す」）は SSE の settings を出さないので、
 * 効いている取得間隔・定期取得の EPC・上書きの有無が変わったら、app.js が settings を取り直す。
 * 有効 / 無効も入れる（サーバーはそれでも SSE の settings を出す。Settings の warnings が変わる）。
 * 詳細が無ければ null。
 */
export function settingsSignature(a) {
  if (!a) return null
  const ov = a.overridden || {}
  return JSON.stringify([
    !!ov.any,
    !!ov.stopped,
    isNum(a.pollIntervalSec) ? a.pollIntervalSec : null,
    Array.isArray(a.pollEpcs) ? a.pollEpcs.map((e) => normEpc(e) || String(e)) : null,
    a.enabled !== false,
  ])
}

/** 計測値の行を EPC で引く（'0xE0'・'E0' のどちらの形でも）。無ければ null。 */
export function findValue(items, epc) {
  const want = normEpc(epc)
  if (!want || !Array.isArray(items)) return null
  for (const r of items) if (r && normEpc(r.epc) === want) return r
  return null
}
