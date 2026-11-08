// ハッシュの経路（#/ と #/adapters/:id/:tab）と、2 ペイン / 1 ペインの決め方。純関数（test/ui/route.test.mjs）。
// PC と iPad の横（900px 以上）は左に一覧・右に詳細。900px 未満は 1 ペイン（#/ は一覧、#/adapters/… は詳細と「← 一覧」）。

export const TABS = ['status', 'values', 'settings', 'diag', 'logs']
export const DEFAULT_TAB = 'status'
/** 2 ペインにする幅（app.css の @media と同じ値）。 */
export const WIDE_QUERY = '(min-width: 900px)'

/** @returns {{name:'list'} | {name:'detail', id:string, tab:string}} */
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '')
  const parts = h.split('/').filter(Boolean)
  if (parts[0] === 'adapters' && parts[1]) {
    let id
    try {
      id = decodeURIComponent(parts[1])
    } catch (e) {
      return { name: 'list' }
    }
    // 知らないタブ（前の版の overview を含む）は状態
    const tab = TABS.includes(parts[2]) ? parts[2] : DEFAULT_TAB
    return { name: 'detail', id, tab }
  }
  return { name: 'list' }
}

export function listHref() {
  return '#/'
}

export function detailHref(id, tab) {
  return `#/adapters/${encodeURIComponent(id)}/${TABS.includes(tab) ? tab : DEFAULT_TAB}`
}

/** エディタでノードを開く URL（{root}#node/<id>）。edit なら編集の画面まで開く（{root}#node/<id>/edit。追加のトースト）。 */
export function editorNodeHref(root, id, edit) {
  return id ? `${root}#node/${encodeURIComponent(id)}${edit ? '/edit' : ''}` : root
}

/**
 * どのペインを出すか。
 * @param {{name: string}} route
 * @param {boolean} wide  幅が 900px 以上か
 * @returns {{list: boolean, detail: boolean, back: boolean}}  back は「← 一覧」を出すか
 */
export function paneLayout(route, wide) {
  if (wide) return { list: true, detail: true, back: false }
  if (route && route.name === 'detail') return { list: false, detail: true, back: true }
  return { list: true, detail: false, back: false }
}

/**
 * PC で何も選んでいなければ、一覧の先頭（サーバーの並び = health の重い順 → 名前）を選ぶ。
 * location.replace する先のハッシュを返す。要らなければ null。
 */
export function autoSelectHref(route, items, wide) {
  if (!wide || !route || route.name !== 'list') return null
  if (!Array.isArray(items) || !items.length || !items[0] || !items[0].id) return null
  return detailHref(items[0].id, DEFAULT_TAB)
}
