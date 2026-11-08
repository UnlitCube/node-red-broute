// 画面の入口: 経路 → データの取得（REST + SSE、切れたら 5 秒ごとの取得）→ 描画。
// 上の帯・左ペイン（一覧）・右ペイン（詳細）。900px 未満は 1 ペイン。
// 画面のログインは持たない。Node-RED に認証があるサーバーでは、値は誰でも見え、操作と保存はエディタにログインした人だけ。
// 文言は strings.js、整形は format.js、状態は store.js、通信は api.js / sse-client.js、ペインの決め方は route.js。
import { html, render, useReducer, useEffect, useRef, useState, useMemo, useCallback, useMedia } from './html.js'
import { reducer, initialState, writeBlockReason, authBlockReason, configBlockReason, RANGES, needsDetailRecheck, settingsSignature, configSignature } from './store.js'
import { createApi, apiBaseFrom, editorRootOf, loginHrefOf } from './api.js'
import { isEditorTokenEvent } from './editor-token.js'
import { createLiveStream } from './sse-client.js'
import { createLoaders } from './loaders.js'
import { createOperations } from './operations.js'
import { parseRoute, paneLayout, autoSelectHref, detailHref, listHref, editorNodeHref, WIDE_QUERY, DEFAULT_TAB } from './route.js'
import { S } from './strings.js'
import { TopBar, Notices } from './components/topbar.js'
import { ListPane } from './components/list-pane.js'
import { DetailPane } from './components/detail-pane.js'
import { AddDialog } from './components/add-pane.js'
import { Toasts } from './components/toasts.js'
import { addButtonState, addedName } from './add-view.js'
import { displayText } from './adapter-view.js'

export const THEME_KEY = 'wsuha-broute:theme'
const THEMES = ['system', 'light', 'dark']
const POLL_MS = 5000
const META_REFRESH_MS = 5 * 60 * 1000
/** 計測値タブを開いている間、REST で計測値を取り直す間隔（サーバーの fresh で、届かなくなった値を古く見せる）。 */
export const VALUES_REFRESH_MS = 30 * 1000
/** 構成をまだ読んでいない台の設定タブ（読み込み中の表示。古いサーバーと分かるまで「読むだけ」にしない）。 */
const CONFIG_LOADING = { status: 'loading', data: null, error: null }
/** 選んだ台が「見つかりません」の間、GET adapters/:id で確かめ直す間隔（一覧に戻ったときはすぐ確かめる）。 */
export const RECHECK_MS = 30 * 1000
/**
 * タブが見えなくなってから SSE を閉じるまでの長さ。1 タブ 1 本の SSE は、同じホストへの接続の枠（HTTP/1.1 で 6 本）を
 * 使い続ける。見えていないタブが枠を埋めると、ほかのタブの REST と同じオリジンのエディタ（デプロイを含む）まで待たされる。
 */
export const HIDDEN_PAUSE_MS = 60 * 1000

/** localStorage を例外で止まらない形に包む（プライベートウィンドウ・ブロックされた保存でも動く）。テーマと開閉の保存、エディタのトークンの読み出しに使う。 */
export function safeStorage(get) {
  const store = () => {
    try {
      return get()
    } catch (e) {
      return null
    }
  }
  return {
    get(k) {
      try {
        const s = store()
        return s ? s.getItem(k) : null
      } catch (e) {
        return null
      }
    },
    set(k, v) {
      try {
        const s = store()
        if (s) s.setItem(k, v)
      } catch (e) {
        /* 保存できなくても画面は動く */
      }
    },
    remove(k) {
      try {
        const s = store()
        if (s) s.removeItem(k)
      } catch (e) {
        /* 同上 */
      }
    },
  }
}

export function readTheme(storage) {
  const v = storage.get(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function nextTheme(t) {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]
}

/**
 * 画面のテーマを当てる。スマホのアドレスバーの色（theme-color）も上の帯の色に合わせる。
 * index.html の 2 本は OS の設定で切り替わるので、OS と逆のテーマを選ぶと帯とずれる。
 * 明示のテーマでは 2 本とも同じ色にし、system に戻すときは元の値へ戻す。
 */
function applyTheme(t) {
  const el = document.documentElement
  const explicit = t === 'light' || t === 'dark'
  if (explicit) el.setAttribute('data-theme', t)
  else el.removeAttribute('data-theme')
  const color = explicit && typeof getComputedStyle === 'function' ? getComputedStyle(el).getPropertyValue('--header-bg').trim() : ''
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    if (!m.hasAttribute('data-system')) m.setAttribute('data-system', m.getAttribute('content') || '')
    m.setAttribute('content', color || m.getAttribute('data-system'))
  }
}

let toastSeq = 0

/**
 * 本文へ移動。この画面はハッシュが経路なので、リンクのまま #main へ移ると「一覧」と読まれ、先頭の台へ飛んで下書きも消える。
 * 既定の遷移を止めて、フォーカスだけを移す。
 */
function skipToMain(e) {
  e.preventDefault()
  const el = document.getElementById('main')
  if (el) el.focus()
}

/**
 * @param {{env: {href: string, storage: object, fetchImpl: typeof fetch,
 *   pollMs?: number, valuesRefreshMs?: number, recheckMs?: number, hiddenPauseMs?: number, liveOptions?: object}}} props
 *   pollMs・valuesRefreshMs・recheckMs・hiddenPauseMs・liveOptions は試験で間隔を縮めるためだけのもの（main は渡さない）。
 */
export function App({ env }) {
  const { href, storage, fetchImpl } = env
  const pollMs = env.pollMs || POLL_MS
  const valuesRefreshMs = env.valuesRefreshMs || VALUES_REFRESH_MS
  const recheckMs = env.recheckMs || RECHECK_MS
  const hiddenPauseMs = env.hiddenPauseMs || HIDDEN_PAUSE_MS
  const liveOptions = env.liveOptions
  const apiBase = apiBaseFrom(href)
  const [state, dispatch] = useReducer(reducer, initialState)
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  const [theme, setTheme] = useState(() => readTheme(storage))
  const wide = useMedia(WIDE_QUERY)
  const routeRef = useRef(route)
  routeRef.current = route
  const stateRef = useRef(state)
  stateRef.current = state
  const liveRef = useRef(null)
  // 1 ペインで最後に開いた台（一覧へ戻っても右ペインを隠して残し、保存していない設定の下書きを同じ台へ戻るまで持つ）
  const keptIdRef = useRef(null)
  if (route.name === 'detail') keptIdRef.current = route.id

  const toast = useCallback((tone, title, body, action) => {
    dispatch({ type: 'toast/add', toast: { id: ++toastSeq, tone, title, body: body || null, action: action || null } })
  }, [])

  const api = useMemo(() => createApi({ base: apiBase, fetchImpl, storage }), [apiBase, fetchImpl, storage])

  // ---- 取得（中身は loaders.js） ------------------------------------------------------
  const load = useMemo(() => createLoaders({ api, dispatch, getState: () => stateRef.current, href }), [api, href])

  /** 推移を、いま選んでいる範囲で取り直す。 */
  const loadTrend = useCallback(
    (id) => {
      const tr = stateRef.current.trends[id]
      load.trend(id, (tr && tr.range) || '1h')
    },
    [load],
  )

  const loadDetail = useCallback(
    (id) => {
      load.detail(id)
      load.values(id)
      load.settings(id)
      load.config(id)
      load.logs(id)
      loadTrend(id)
    },
    [load, loadTrend],
  )

  /** いまの画面のデータを全部取り直す（SSE の reset・ポーリングから戻ったとき）。 */
  const refreshRoute = useCallback(() => {
    const r = routeRef.current
    load.list()
    if (r.name === 'detail') loadDetail(r.id)
  }, [load, loadDetail])

  // ---- 経路 --------------------------------------------------------------------
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  /** 画面の中で移る（「はじめに」の［設定タブへ］・追加のあと）。ハッシュを変え、hashchange を待たずに経路も変える。 */
  const navigate = useCallback((target) => {
    window.location.hash = target
    setRoute(parseRoute(target))
  }, [])

  // PC で何も選んでいなければ、一覧の先頭を選ぶ（履歴を増やさない）
  const items = state.list.items
  useEffect(() => {
    const target = autoSelectHref(route, items, wide)
    if (!target) return
    window.location.replace(target)
    setRoute(parseRoute(target))
  }, [route, items, wide])

  // 1 ペイン（狭い幅）では、一覧 ⇄ 詳細の行き来でページの上から見せる（2 ペインはペインごとに縦に流れる）
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route.name, route.id])

  useEffect(() => {
    const d = route.name === 'detail' && state.details[route.id] && state.details[route.id].data
    document.title = d ? S.docTitle(displayText(d) || d.id) : S.appName
  }, [route.name, route.id, state.details])

  // 起動時と、選んだ台が変わったときの取得
  useEffect(() => {
    load.meta()
    load.list()
  }, [load])

  useEffect(() => {
    if (route.name === 'detail') loadDetail(route.id)
  }, [route.name, route.id, loadDetail])

  // 計測値タブの鮮度。fresh はサーバーが EPC ごとの周期で決める（ValueRow.fresh）。SSE の measurement は
  // 届いた行しか運ばないので、届かなくなった値を古く見せるには REST を取り直すしかない（ポーリング中も同じ）。
  // 推移も一緒に取り直す。範囲の終わり（to）は新しい点でしか進まないので、計測が止まるとグラフが止まった時刻のままになり、
  // 「いま値が来ていない」の途切れを出せない（同じ範囲の取り直しは今の線を出したままなので、ちらつかない）。
  // 別のタブから移ってきたときは、前に取った表の鮮度が古いので、すぐ取り直す。
  const prevTabRef = useRef(null)
  useEffect(() => {
    const prev = prevTabRef.current
    prevTabRef.current = route.name === 'detail' ? { id: route.id, tab: route.tab } : null
    if (route.name !== 'detail' || route.tab !== 'values') return undefined
    const id = route.id
    const refresh = () => {
      load.values(id)
      loadTrend(id)
    }
    if (prev && prev.id === id && prev.tab !== 'values') refresh()
    const t = setInterval(refresh, valuesRefreshMs)
    return () => clearInterval(t)
  }, [route.name, route.id, route.tab, load, loadTrend, valuesRefreshMs])

  // 版のずれ（ディスクの package.json）と読み出しのみ（settings.js）を見張る
  useEffect(() => {
    const t = setInterval(load.meta, META_REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // 別のタブのエディタでログイン・ログアウトしたら、止めを解く・掛け直す。storage はほかのタブの変更で届き、
  // focus はこのタブへ戻ったときの取りこぼしを拾う
  useEffect(() => {
    const on = (e) => {
      if (!e || e.type !== 'storage' || isEditorTokenEvent(e)) load.session()
    }
    window.addEventListener('storage', on)
    window.addEventListener('focus', on)
    return () => {
      window.removeEventListener('storage', on)
      window.removeEventListener('focus', on)
    }
  }, [load])

  // ---- 選んでいる台が消えた・戻った -----------------------------------------
  const selId = route.name === 'detail' ? route.id : null
  const selDetail = selId ? state.details[selId] : null
  const selStatus = selDetail ? selDetail.status : null
  // 「見つかりません」の間は ?adapter= を付けない SSE で一覧の更新を続ける（404 で止めると一覧まで止まるため）
  const missing = selStatus === 'notFound'

  // 一覧から消えたら GET adapters/:id で確かめる（削除のデプロイでは SSE は繋がったまま adapters だけが届く）。
  // 「見つかりません」の台が一覧に戻ったら、取り直して ?adapter= の SSE へ戻る。
  const prevItemsRef = useRef(null)
  useEffect(() => {
    const prevItems = prevItemsRef.current
    prevItemsRef.current = items
    if (needsDetailRecheck(prevItems, items, selId, selStatus)) load.detail(selId)
  }, [items, selId, selStatus, load])

  // 一覧の変化を取りこぼしたとき（一覧にあり続けるのに詳細だけが 404 だった・再起動の直後など）のために、
  // 「見つかりません」の間は間隔ごとにも確かめる（ポーリング中は 5 秒ごとの取得が同じことをする）
  useEffect(() => {
    if (!missing || !selId) return undefined
    const t = setInterval(() => load.detail(selId), recheckMs)
    return () => clearInterval(t)
  }, [missing, selId, load, recheckMs])

  // 「見つかりません」から戻ったら、詳細のほか（計測値・設定・ログ・推移）も取り直す（見つからない間は 404 だった）
  const missingRef = useRef(null)
  useEffect(() => {
    const prev = missingRef.current
    missingRef.current = selId ? { id: selId, missing } : null
    if (!prev || prev.id !== selId || !prev.missing || missing) return
    load.values(selId)
    load.settings(selId)
    load.config(selId)
    load.logs(selId)
    loadTrend(selId)
  }, [selId, missing, load, loadTrend])

  // 一時的な上書き（フローの interval・epcs、画面の「自動運転に戻す」）は運用設定の保存を通らない。
  // SSE が使えない間（5 秒ごとの取得）はサーバーの settings のイベントも届かないので、詳細の取得間隔・定期取得の EPC・
  // 上書きの有無が変わったら、設定タブの出どころと値を取り直す（ライブの間はイベントと重なるが、GET が 1 回増えるだけ）。
  const sig = missing ? null : settingsSignature(selDetail && selDetail.data)
  const sigRef = useRef(null)
  useEffect(() => {
    const prev = sigRef.current
    sigRef.current = selId && sig !== null ? { id: selId, sig } : null
    if (!prev || prev.id !== selId || sig === null || prev.sig === sig) return
    load.settings(selId)
  }, [selId, sig, load])

  // 構成（GET config）も同じ。名前・契約・有効・接続先・ポート・デバイスキー・想定 MAC・認証情報の出どころが
  // 変わったら取り直す（SSE の config が届かない間・config のイベントを出さないサーバーでも、設定タブの構成を古くしない）
  const csig = missing ? null : configSignature(selDetail && selDetail.data)
  const csigRef = useRef(null)
  useEffect(() => {
    const prev = csigRef.current
    csigRef.current = selId && csig !== null ? { id: selId, sig: csig } : null
    if (!prev || prev.id !== selId || csig === null || prev.sig === csig) return
    load.config(selId)
  }, [selId, csig, load])

  // ---- 見えていないタブ -------------------------------------------------
  // 見えなくなって HIDDEN_PAUSE_MS たったら SSE を閉じ、見えたら繋ぎ直す。閉じている間のことは取り直しで埋める。
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    let timer = null
    const on = () => {
      if (document.hidden) {
        if (!timer) timer = setTimeout(() => setPaused(true), hiddenPauseMs)
        return
      }
      if (timer) clearTimeout(timer)
      timer = null
      setPaused(false)
    }
    document.addEventListener('visibilitychange', on)
    on()
    return () => {
      document.removeEventListener('visibilitychange', on)
      if (timer) clearTimeout(timer)
    }
  }, [hiddenPauseMs])
  const pausedRef = useRef(false)
  useEffect(() => {
    const was = pausedRef.current
    pausedRef.current = paused
    if (was && !paused) refreshRoute()
  }, [paused, refreshRoute])

  // ---- リアルタイム（SSE） -------------------------------------------------------
  const streamId = selId && !missing ? selId : null
  useEffect(() => {
    if (paused) return undefined
    let prev = null
    // この SSE を ?adapter= を付けない SSE に作り直すと決めた（404）。そのあとの 'stopped' は帯に出さない
    let replacing = false
    const ls = createLiveStream({
      url: api.streamUrl(streamId ? { adapter: streamId, logs: true } : {}),
      fetchImpl,
      options: liveOptions,
      // ?adapter=<id> の台が無い（404 ADAPTER_NOT_FOUND）: この SSE は繋ぎ直さずに止まる。帯は出さず、右ペインの「見つかりません」に任せる。
      // notFound になると streamId が null になり、?adapter= を付けない SSE に作り直して一覧の更新を続ける。
      // sse-client は止める前にこれを呼ぶので、作り直すまでの 1 フレームに「停止」の帯と chip を出さずに済む
      onNotFound: (err) => {
        if (!streamId) return
        replacing = true
        dispatch({ type: 'detail/failed', id: streamId, error: { status: 404, code: err.code, message: err.message } })
      },
      onState: (s) => {
        if (replacing && s === 'stopped') return
        dispatch({ type: 'live', state: s })
        if (s === 'live' && prev === 'polling') refreshRoute()
        prev = s
      },
      onEvent: (type, data) => {
        if (!data && type !== 'reset') return
        switch (type) {
          case 'adapters':
            dispatch({ type: 'list/loaded', items: data.items || [], total: data.total, at: Date.now() })
            break
          case 'adapter':
            dispatch({ type: 'detail/loaded', adapter: data })
            break
          case 'measurement':
            dispatch({ type: 'measurement', adapterId: data.adapterId, at: data.at, items: data.items })
            break
          case 'log':
            if (streamId) dispatch({ type: 'log', id: streamId, row: data })
            break
          case 'settings':
            if (data.adapterId && data.settings) dispatch({ type: 'settings/loaded', id: data.adapterId, settings: data.settings })
            break
          // 構成が変わった（{adapterId, config}）。config の無い形なら取り直す
          case 'config':
            if (data.adapterId && data.config && data.config.fields) dispatch({ type: 'config/loaded', id: data.adapterId, config: data.config })
            else if (data.adapterId) load.config(data.adapterId)
            break
          case 'reset':
            refreshRoute()
            break
          default:
            break
        }
      },
    })
    liveRef.current = ls
    ls.start()
    return () => {
      ls.stop()
      if (liveRef.current === ls) liveRef.current = null
    }
  }, [streamId, api, fetchImpl, refreshRoute, liveOptions, paused])

  // SSE が使えない間は 5 秒ごとに取る
  useEffect(() => {
    if (state.live !== 'polling') return undefined
    const tick = async () => {
      if (pausedRef.current) return
      const r = routeRef.current
      const ok = await load.list()
      dispatch({ type: 'stale', value: !ok })
      if (r.name === 'detail') {
        load.detail(r.id)
        load.moreLogs(r.id)
      }
    }
    const t = setInterval(tick, pollMs)
    return () => clearInterval(t)
  }, [state.live, load, pollMs])

  // ---- トーストを消す ------------------------------------------------------------
  const toastTimers = useRef(new Map())
  useEffect(() => {
    const timers = toastTimers.current
    for (const t of state.toasts) {
      if (timers.has(t.id)) continue
      timers.set(t.id, setTimeout(() => {
        timers.delete(t.id)
        dispatch({ type: 'toast/remove', id: t.id })
      }, t.tone === 'danger' ? 12000 : 5000))
    }
  }, [state.toasts])
  useEffect(() => () => toastTimers.current.forEach((t) => clearTimeout(t)), [])

  // ---- テーマ --------------------------------------------------------------------
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const onTheme = useCallback(() => {
    setTheme((t) => {
      const n = nextTheme(t)
      if (n === 'system') storage.remove(THEME_KEY)
      else storage.set(THEME_KEY, n)
      return n
    })
  }, [storage])

  // ---- 書き込みの操作（中身は operations.js） ---------------------------------------------
  const ops = useMemo(() => createOperations({ api, dispatch, toast }), [api, toast])
  // 構成・認証情報を書いたあと、応答が Config でなかった（{ok:true} だけ）なら GET config で取り直す
  const afterConfigWrite = useCallback(
    async (id, pending) => {
      const r = await pending
      if (r && r.ok && !r.loaded) load.config(id)
      return r
    },
    [load],
  )

  // アダプタの追加（モーダル）。201 も 202（フローには足したが、まだ動いていない）も新しい台の状態タブへ移る。
  // 202 の間はその台が「見つかりません」と出て、動き出すと自動で表示し直す。
  // ［エディタで開く］は B ルートノードを指す。設定ノードの id をエディタに渡すと、全部の欄が空の編集画面が開く。
  // 失敗はモーダルの中の帯と項目の下に出すので、ここではトーストを出さない
  const [addOpen, setAddOpen] = useState(false)
  const closeAdd = useCallback(() => setAddOpen(false), [])
  const onAdd = useCallback(
    async (body, form) => {
      const r = await ops.addAdapter(body)
      if (!r.ok) {
        // settings.js の止めは meta の取り直しまで見えない（起動時と 5 分ごと）。［追加］のボタンの止めも今の値にする
        if (r.error && r.error.code === 'CONFIG_LOCKED') load.meta()
        return r
      }
      load.meta()
      load.list()
      const root = editorRootOf(stateRef.current.meta, href)
      const nodeId = r.nodes && r.nodes.brouteId
      const link = root && nodeId ? { label: S.add.openInEditor, href: editorNodeHref(root, nodeId, true) } : null
      if (r.started) toast('ok', S.add.added(addedName(r.adapter, form)), null, link)
      else toast('warn', r.message || S.add.pending, null, link)
      for (const w of r.warnings) toast('warn', w)
      setAddOpen(false)
      const newId = (r.adapter && r.adapter.id) || (r.nodes && r.nodes.deviceId)
      navigate(newId ? detailHref(newId, 'status') : listHref())
      return r
    },
    [ops, load, toast, navigate, href],
  )

  // ---- 描画 ----------------------------------------------------------------------
  const writeReason = writeBlockReason(state, S)
  // 読み出しのみのサーバーではログインしても解けないので、案内を出さない
  const authReason = writeReason !== null && writeReason === authBlockReason(state, S) ? writeReason : null
  const loginHref = authReason && !state.auth.loggedIn ? loginHrefOf(state.meta, href) : null
  // 構成と認証情報は、読み出しのみに加えて CONFIG_LOCKED（settings.js の wsuhaBroute.uiConfig: false）でも止める
  const configWriteReason = configBlockReason(state, S)
  // エディタの入口は meta.editorRoot（httpAdminRoot）から。null ならエディタが無効でリンクを出さない。
  // 古いサーバー（editorRoot が無い）と meta を読む前は、画面の 2 つ上
  const editorRoot = editorRootOf(state.meta, href)
  const layout = paneLayout(route, wide)
  const id = route.name === 'detail' ? route.id : null
  const tab = route.name === 'detail' ? route.tab : DEFAULT_TAB
  // 別の台を開くと key が変わって作り直すので、下書きは持ち越さない
  const paneId = id || (layout.detail ? null : keptIdRef.current)
  const addState = addButtonState(state)
  // ポートの候補の「ほかの台が使っています」に出す名前（文の中の名前）
  const nameOfAdapter = (otherId, name) => {
    const other = (items || []).find((x) => x.id === otherId)
    return other ? displayText(other) : name || otherId
  }
  return html`<div class=${'shell ' + (wide ? 'shell-wide' : 'shell-narrow')}>
    <a class="skip-link" href="#main" onClick=${skipToMain}>${S.skipToMain}</a>
    <${TopBar} meta=${state.meta} items=${state.list.items} live=${state.live} theme=${theme} onTheme=${onTheme} />
    <${Notices} live=${state.live} stale=${state.stale} onRetryLive=${() => liveRef.current && liveRef.current.retryNow()} authReason=${authReason} loginHref=${loginHref} />
    <main class="panes" id="main" tabindex="-1">
      ${layout.list
        ? html`<${ListPane} list=${state.list} selectedId=${id} tab=${tab} editorRoot=${editorRoot} bandReason=${authReason} onRetry=${load.list} add=${addState} onOpenAdd=${() => setAddOpen(true)} />`
        : null}
      ${layout.detail || paneId
        ? html`<${DetailPane}
            key=${paneId || '-'}
            id=${paneId}
            tab=${tab}
            hidden=${!layout.detail}
            back=${layout.back}
            hasItems=${!!(items && items.length)}
            items=${items}
            navigate=${navigate}
            onToast=${toast}
            storage=${storage}
            detail=${paneId ? state.details[paneId] : null}
            trend=${paneId ? state.trends[paneId] : null}
            values=${paneId ? state.values[paneId] : null}
            settings=${paneId ? state.settings[paneId] : null}
            logs=${paneId ? state.logs[paneId] : null}
            diagResults=${paneId ? state.diag[paneId] : null}
            writeReason=${writeReason}
            bandReason=${authReason}
            editorRoot=${editorRoot}
            meta=${state.meta}
            onRetry=${() => load.detail(paneId)}
            onAction=${ops.action}
            onRange=${(r) => RANGES[r] && load.trend(paneId, r)}
            onReloadValues=${() => load.values(paneId)}
            onReloadSettings=${() => load.settings(paneId)}
            onSaveSettings=${(patch, rev) => ops.saveSettings(paneId, patch, rev)}
            onResetSettings=${(rev) => ops.resetSettings(paneId, rev)}
            config=${paneId ? state.configs[paneId] || CONFIG_LOADING : null}
            serialports=${state.serialports}
            configWriteReason=${configWriteReason}
            onReloadConfig=${() => load.config(paneId)}
            onLoadSerialports=${load.serialports}
            onSaveConfig=${(patch, rev) => afterConfigWrite(paneId, ops.saveConfig(paneId, patch, rev))}
            onResetConfig=${(rev) => afterConfigWrite(paneId, ops.resetConfig(paneId, rev))}
            onSaveCredentials=${(body) => afterConfigWrite(paneId, ops.saveCredentials(paneId, body))}
            onClearCredentials=${() => afterConfigWrite(paneId, ops.clearCredentials(paneId))}
            onReloadLogs=${() => load.logs(paneId)}
            onDiag=${ops.diag}
          />`
        : null}
    </main>
    <${AddDialog}
      open=${addOpen}
      onClose=${closeAdd}
      meta=${state.meta}
      add=${addState}
      serialports=${state.serialports}
      editorRoot=${editorRoot}
      loginHref=${loginHref}
      onLoadSerialports=${load.serialports}
      onAdd=${onAdd}
      nameOf=${nameOfAdapter}
    />
    <${Toasts} toasts=${state.toasts} onDismiss=${(tid) => dispatch({ type: 'toast/remove', id: tid })} />
  </div>`
}

export function main() {
  const root = document.getElementById('app')
  const env = {
    href: window.location.href,
    storage: safeStorage(() => window.localStorage),
    fetchImpl: (...a) => window.fetch(...a),
  }
  root.textContent = ''
  render(html`<${App} env=${env} />`, root)
}

if (typeof document !== 'undefined' && document.getElementById('app')) main()
