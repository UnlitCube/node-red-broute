// REST での取得（app.js から分けた。DOM に触らないので test/ui/loaders.test.mjs で試せる）。
// どれも結果を reducer（store.js）へ dispatch するだけで、画面の描画はしない。
import { LOG_CAP, mergeRead } from './store.js'
import { isMissingApiError, editorPathOf } from './api.js'

/** GET logs の limit の上限（サーバーの検証も 1〜1000）。 */
export const LOG_PAGE = 1000
/** 最初のログの取得で、何回まで続けて取るか（暴走の歯止め。リングは 1,000 行なので普通は 2 回で終わる）。 */
export const LOG_MAX_PAGES = 10

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * いまサーバーにあるログを、いちばん新しい行まで取る（古い順。最後の keep 行だけ残す）。
 *
 * 契約の logs は「after より新しいものを古い順に limit 行」なので、after なしの 1 回だけでは
 * リングの古い方しか来ない（新しい行との間が抜ける）。nextSeq をたどって、来た行が limit より
 * 少なくなる（＝末尾に着いた）まで取る。
 * 途中で Node-RED が再起動して連番が戻ったら（nextSeq < after）、それまでの行を捨てて取り直した分を使う。
 *
 * @returns {Promise<{items: object[], nextSeq: number|null}>}
 */
export async function fetchRecentLogs(api, id, { pageSize = LOG_PAGE, keep = LOG_CAP, maxPages = LOG_MAX_PAGES } = {}) {
  let items = []
  let after
  let nextSeq = null
  for (let page = 0; page < maxPages; page++) {
    const r = await api.logs(id, { after, limit: pageSize })
    const got = r && Array.isArray(r.items) ? r.items.filter((row) => row && isNum(row.seq)) : []
    const ns = r && isNum(r.nextSeq) ? r.nextSeq : got.length ? got[got.length - 1].seq : null
    if (isNum(after) && ns !== null && ns < after) items = []
    items = items.concat(got)
    if (items.length > keep) items = items.slice(items.length - keep)
    if (ns !== null) nextSeq = ns
    if (got.length < pageSize || ns === null || ns === after) break
    after = ns
  }
  return { items, nextSeq }
}

/**
 * 画面のデータを取る関数の束。
 * @param {{api: ReturnType<import('./api.js').createApi>, dispatch: (a: object) => void, getState: () => object, href: string}} deps
 *   href は画面の場所（逆プロキシの接頭辞を求める）。
 */
export function createLoaders({ api, dispatch, getState, href }) {
  // focus が続いたときなどに、遅れて着いた古い答えでログインの状態を戻さない
  let sessionSeq = 0
  /** @returns {Promise<object|null>} 読めなかった・新しい問い合わせに追い越されたら null（今の状態のままにする） */
  async function readSession() {
    const mine = ++sessionSeq
    try {
      const s = await api.session()
      return mine === sessionSeq ? s : null
    } catch (e) {
      return null
    }
  }
  return {
    // 認証のあるサーバーでは session を読んでから meta と一緒に入れる。別々に入れると、ログインしている人にも
    // 「ログインしてください」が一瞬出る
    meta: async () => {
      try {
        const meta = await api.meta()
        const required = !!(meta && meta.auth && meta.auth.required === true)
        if (typeof api.setEditorPath === 'function') api.setEditorPath(required ? editorPathOf(meta, href) : null)
        dispatch({ type: 'meta', meta, session: required ? await readSession() : null })
      } catch (e) {
        /* 帯の版の表示が古くなるだけ */
      }
    },
    // 別のタブでログイン・ログアウトしたとき。認証の無いサーバーには問い合わせない
    session: async () => {
      if (!getState().auth.required) return
      const session = await readSession()
      if (session) dispatch({ type: 'auth/session', session })
    },
    list: async () => {
      dispatch({ type: 'list/loading' })
      try {
        const r = await api.adapters()
        dispatch({ type: 'list/loaded', items: (r && r.items) || [], total: r && r.total, at: Date.now() })
        return true
      } catch (e) {
        dispatch({ type: 'list/failed', error: e })
        return false
      }
    },
    detail: async (id) => {
      dispatch({ type: 'detail/loading', id })
      try {
        dispatch({ type: 'detail/loaded', adapter: await api.adapter(id) })
        return true
      } catch (e) {
        dispatch({ type: 'detail/failed', id, error: e })
        return false
      }
    },
    // 計測値の表（GET values）に、ノードの read と同じ持っている値（GET read。無線を使わない）を重ねる。
    // read が無い古いサーバー・read だけの失敗は、表のまま出す
    values: async (id) => {
      try {
        const [r, rd] = await Promise.all([api.values(id), typeof api.read === 'function' ? api.read(id).catch(() => null) : null])
        dispatch({ type: 'values/loaded', id, items: mergeRead((r && r.items) || [], rd), at: r && r.at })
      } catch (e) {
        dispatch({ type: 'values/failed', id, error: e })
      }
    },
    settings: async (id) => {
      try {
        dispatch({ type: 'settings/loaded', id, settings: await api.settings(id) })
      } catch (e) {
        dispatch({ type: 'settings/failed', id, error: e })
      }
    },
    // 構成。古いサーバー（404 NOT_FOUND）は unsupported（設定タブは今までの「構成（読むだけ）」を出す）
    config: async (id) => {
      try {
        dispatch({ type: 'config/loaded', id, config: await api.config(id) })
      } catch (e) {
        if (isMissingApiError(e)) dispatch({ type: 'config/unsupported', id })
        else dispatch({ type: 'config/failed', id, error: e })
      }
    },
    serialports: async () => {
      dispatch({ type: 'serialports/loading' })
      try {
        const r = await api.serialports()
        dispatch({ type: 'serialports/loaded', items: (r && Array.isArray(r.items) && r.items) || (Array.isArray(r) ? r : []), at: r && r.at, message: r && r.serialportMessage })
      } catch (e) {
        if (isMissingApiError(e)) dispatch({ type: 'serialports/unsupported' })
        else dispatch({ type: 'serialports/failed', error: e })
      }
    },
    // 取っている間に SSE で届いた行は、reducer が logs/loading〜logs/loaded の間だけ控えて、応答の後ろに足す。
    logs: async (id) => {
      dispatch({ type: 'logs/loading', id })
      try {
        const r = await fetchRecentLogs(api, id)
        dispatch({ type: 'logs/loaded', id, items: r.items, nextSeq: r.nextSeq })
      } catch (e) {
        dispatch({ type: 'logs/failed', id, error: e })
      }
    },
    moreLogs: async (id) => {
      const cur = getState().logs[id]
      const after = cur && isNum(cur.nextSeq) ? cur.nextSeq : undefined
      try {
        const r = await api.logs(id, { after, limit: 200 })
        dispatch({ type: 'logs/more', id, after, items: (r && r.items) || [], nextSeq: r && r.nextSeq })
      } catch (e) {
        /* 次の周期でまた取る */
      }
    },
    trend: async (id, range) => {
      dispatch({ type: 'trend/loading', id, range })
      try {
        const r = await api.trend(id, range)
        dispatch({ type: 'trend/loaded', id, range, series: r && r.series, from: r && r.from, to: r && r.to })
      } catch (e) {
        dispatch({ type: 'trend/failed', id, range, error: e })
      }
    },
  }
}
