// API の呼び出し。
// - URL は画面の場所からの相対で作る（httpNodeRoot が / 以外でも動く）。
// - Authorization は付けない。httpNodeAuth（Basic 認証）と同じヘッダなので、ここに載せるとパッケージの経路に届く前に断られる。
//   Basic 認証のサーバーでは、ブラウザが同じオリジンの資格情報を付ける。
// - エディタのログインのトークンは、変更の要求・電波を使う read・GET session にだけ X-Wsuha-Editor-Token で載せる
//   （値は editor-token.js が要求のたびに読む。読むだけの要求に載せないのは、要らない所へ秘密を流さないため）。
// - 失敗はすべて ApiError にそろえる: {status, code, message, details, retryAfter}。
//   message はサーバーの日本語をそのまま使い、無いときだけ strings.js の文言で埋める。
import { S } from './strings.js'
import { readEditorToken } from './editor-token.js'

/** エディタのトークンを載せるヘッダ。 */
export const EDITOR_TOKEN_HEADER = 'X-Wsuha-Editor-Token'
/** 電波を使う read の印。img タグなどの単純な要求からは付けられないので、ほかのサイトから電波を使わせない守りになる。 */
export const RADIO_HEADER = 'X-Wsuha-Radio'

export class ApiError extends Error {
  constructor({ status = 0, code = 'UNKNOWN', message = '', details = null, retryAfter = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.retryAfter = retryAfter
  }
}

/** ui/ の場所から、API の基点（…/wsuha-broute/api/v1/）を作る。 */
export function apiBaseFrom(href) {
  return new URL('../api/v1/', href).href
}

/**
 * ui/ の場所から、エディタの入口を作る（…/wsuha-broute/ui/ の 2 つ上 = httpNodeRoot）。
 * httpAdminRoot が httpNodeRoot と同じサーバー（どちらも / のとき）で合う。
 */
export function editorRootFrom(href) {
  return new URL('../../', href).href
}

/**
 * 「エディタを開く / エディタで開く」の入口（Meta.editorRoot = httpAdminRoot。false なら null）。
 * - 文字列: 画面と同じオリジンのそのパス（httpAdminRoot と httpNodeRoot が違うサーバーでも外れない）。
 *   Node-RED の formatRoot と同じく前後の / を補い、// で始まっても別のホストにしない。
 * - null（false も）: エディタが無効 → null（リンクを出さない）。
 * - それ以外（古いサーバーで editorRoot が無い・meta をまだ読めていない）: 画面の 2 つ上（editorRootFrom）。
 * @returns {string|null}
 */
export function editorRootOf(meta, href) {
  const v = meta ? meta.editorRoot : undefined
  if (v === null || v === false) return null
  if (typeof v !== 'string') return editorRootFrom(href)
  return sameOriginPath(proxyPrefix(meta, href) + v, href)
}

/**
 * 逆プロキシがパスの先頭に付けている接頭辞（/nodered など。無ければ空）。
 * サーバーの settings の値は接頭辞を知らないので、画面の場所（…/wsuha-broute/ui/）と meta.auth.nodeRoot の差から求める。
 * @returns {string}
 */
export function proxyPrefix(meta, href) {
  const root = meta && meta.auth ? meta.auth.nodeRoot : null
  if (typeof root !== 'string' || !root) return ''
  const tail = root.replace(/\/*$/, '/') + 'wsuha-broute/ui/'
  const path = new URL(href).pathname
  const at = path.lastIndexOf(tail)
  return at > 0 ? path.slice(0, at) : ''
}

/**
 * エディタのパス（meta.auth.editorPath に接頭辞を付けたもの）。エディタはトークンの鍵を自分の location.pathname から作るので、
 * 接頭辞の裏では接頭辞の入ったパスでないと、ログインしても鍵が読めない。エディタが無ければ null。
 * @returns {string|null}
 */
export function editorPathOf(meta, href) {
  const p = meta && meta.auth ? meta.auth.editorPath : null
  return typeof p === 'string' ? proxyPrefix(meta, href) + p : null
}

/** サーバーが返したパスを、画面と同じオリジンの URL にする。 */
function sameOriginPath(v, href) {
  // URL の読み方は途中のタブ・改行を捨て、先頭の \ を / と読む（'/\t/x' や '\\x' が //x = 別のホストになる）ので、先に除く
  let p = v.replace(/[\t\n\r]/g, '').trim()
  if (p.charAt(0) !== '/' && p.charAt(0) !== '\\') p = '/' + p
  if (p.charAt(p.length - 1) !== '/') p += '/'
  p = p.replace(/^[/\\]+/, '/')
  return new URL(p, href).href
}

/**
 * ［Node-RED にログイン］の行き先（meta.auth.editorPath）。ログインできないサーバーは null（案内の文だけを出す）。
 * @returns {string|null}
 */
export function loginHrefOf(meta, href) {
  const a = meta && meta.auth
  if (!a || a.available !== true || typeof a.editorPath !== 'string') return null
  return sameOriginPath(editorPathOf(meta, href), href)
}

/** 状態コードから、サーバーが message を返さなかったときの文言を選ぶ。 */
export function fallbackMessage(status, retryAfter) {
  if (status === 0) return S.errors.network
  if (status === 401) return S.errors.unauthorized
  if (status === 403) return S.errors.forbidden
  if (status === 404) return S.errors.notFound
  if (status === 409) return S.errors.conflict
  if (status === 412) return S.errors.precondition
  if (status === 415) return S.errors.unsupportedMedia
  if (status === 422) return S.errors.validation
  if (status === 429) return S.errors.rateLimited(retryAfter)
  if (status === 502) return S.errors.deviceError
  if (status === 503) return S.errors.unavailable
  if (status === 504) return S.errors.timeout
  return S.errors.server(status)
}

function parseRetryAfter(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n)
  const at = Date.parse(v)
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000))
  return null
}

/** 失敗の応答を ApiError にする。本文が自前の形でなくても（Basic 認証の 401 の本文など）落ちない。 */
export async function errorFromResponse(res) {
  const retryAfter = parseRetryAfter(res.headers && res.headers.get ? res.headers.get('Retry-After') : null)
  let body = null
  try {
    const text = await res.text()
    body = text ? JSON.parse(text) : null
  } catch (e) {
    body = null
  }
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null
  const code = err && typeof err.code === 'string' ? err.code : 'HTTP_' + res.status
  const message = err && typeof err.message === 'string' && err.message ? err.message : fallbackMessage(res.status, retryAfter)
  const details = err && err.details && typeof err.details === 'object' ? err.details : null
  return new ApiError({ status: res.status, code, message, details, retryAfter })
}

export function networkError(cause) {
  const e = new ApiError({ status: 0, code: 'NETWORK', message: S.errors.network })
  e.cause = cause
  return e
}

/** 書き込みのメソッド（Content-Type: application/json が要る）。 */
export const WRITE_METHODS = ['PUT', 'DELETE', 'POST', 'PATCH']

/** このサーバーが画面からの操作を止めている（403 READ_ONLY。settings.js の wsuhaBroute.readOnly）か。 */
export function isReadOnlyError(err) {
  return !!err && err.status === 403 && err.code === 'READ_ONLY'
}

/** 構成と認証情報の書き込みを止めている（403 CONFIG_LOCKED。settings.js の wsuhaBroute.uiConfig: false）か。 */
export function isConfigLockedError(err) {
  return !!err && err.status === 403 && err.code === 'CONFIG_LOCKED'
}

/** Node-RED のログインが要る（401 LOGIN_REQUIRED。トークンが無い・切れた）か。Basic 認証の 401 は違う。 */
export function isLoginRequiredError(err) {
  return !!err && err.status === 401 && err.code === 'LOGIN_REQUIRED'
}

/** ログインしているが、変更の権限が足りない（403 FORBIDDEN）か。 */
export function isForbiddenError(err) {
  return !!err && err.status === 403 && err.code === 'FORBIDDEN'
}

/** その API がこのサーバーに無い（古いサーバー: 404 NOT_FOUND「その API はありません」）か。台が無い 404（ADAPTER_NOT_FOUND）は違う。 */
export function isMissingApiError(err) {
  return !!err && (err.status === 404 || err.status === 405 || err.status === 501) && err.code !== 'ADAPTER_NOT_FOUND'
}

/**
 * @param {{base: string, fetchImpl?: typeof fetch, storage?: {get: (k: string) => string|null}}} opts
 *   storage はエディタのトークンを読む先（safeStorage）。無ければトークンを載せない。
 */
export function createApi({ base, fetchImpl, storage }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a))
  // 認証のあるサーバーのエディタのパス（loaders.js が editorPathOf で入れる）。null の間はトークンを読まない
  let editorPath = null

  async function request(method, path, { body, ifMatch, signal, query, radio, editorToken } = {}) {
    const url = new URL(path, base)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
      }
    }
    const headers = { Accept: 'application/json' }
    if (ifMatch) headers['If-Match'] = ifMatch
    // 書き込みは本文が無くても必ず JSON と名乗る（無いとサーバーは 415。
    // フォームや text/plain の POST を別のサイトから送らせない守り）
    if (WRITE_METHODS.includes(method)) headers['Content-Type'] = 'application/json'
    if (radio) headers[RADIO_HEADER] = '1'
    if (radio || editorToken || WRITE_METHODS.includes(method)) {
      const token = readEditorToken(storage, editorPath)
      if (token) headers[EDITOR_TOKEN_HEADER] = token
    }
    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let res
    try {
      res = await doFetch(url.href, { method, headers, body: payload, signal, cache: 'no-store', credentials: 'same-origin' })
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      throw networkError(e)
    }
    if (!res.ok) throw await errorFromResponse(res)
    if (res.status === 204) return null
    try {
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch (e) {
      throw new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: S.errors.badResponse })
    }
  }

  const enc = encodeURIComponent
  return {
    request,
    /** @param {string|null} p editorPathOf の値（認証の無いサーバーは null） */
    setEditorPath: (p) => {
      editorPath = typeof p === 'string' ? p : null
    },
    meta: (o) => request('GET', 'meta', o),
    session: (o) => request('GET', 'session', Object.assign({ editorToken: true }, o)),
    adapters: (o) => request('GET', 'adapters', o),
    adapter: (id, o) => request('GET', `adapters/${enc(id)}`, o),
    values: (id, o) => request('GET', `adapters/${enc(id)}/values`, o),
    // 持っている値。maxAgeSec を付けたときだけ電波で取り直すので、そのときだけ印とトークンを載せる。古いサーバーは 404
    read: (id, o) => {
      const age = o && o.query ? o.query.maxAgeSec : undefined
      return request('GET', `adapters/${enc(id)}/read`, Object.assign({}, o, { radio: age !== undefined && age !== null && age !== '' }))
    },
    trend: (id, range, o) => request('GET', `adapters/${enc(id)}/trend`, Object.assign({ query: { range } }, o)),
    logs: (id, { after, limit = 200, level } = {}, o) =>
      request('GET', `adapters/${enc(id)}/logs`, Object.assign({ query: { after, limit, level } }, o)),
    settings: (id, o) => request('GET', `adapters/${enc(id)}/settings`, o),
    putSettings: (id, rev, patch) => request('PUT', `adapters/${enc(id)}/settings`, { body: patch, ifMatch: rev }),
    resetSettings: (id, rev) => request('DELETE', `adapters/${enc(id)}/settings`, { ifMatch: rev }),
    // 構成・ポートの候補・認証情報（応答に値は入らない。送った本文はここでも残さない）
    serialports: (o) => request('GET', 'serialports', o),
    config: (id, o) => request('GET', `adapters/${enc(id)}/config`, o),
    putConfig: (id, rev, patch) => request('PUT', `adapters/${enc(id)}/config`, { body: patch, ifMatch: rev }),
    resetConfig: (id, rev) => request('DELETE', `adapters/${enc(id)}/config`, { ifMatch: rev }),
    putCredentials: (id, body) => request('PUT', `adapters/${enc(id)}/credentials`, { body }),
    clearCredentials: (id) => request('DELETE', `adapters/${enc(id)}/credentials`),
    action: (id, action, body) => request('POST', `adapters/${enc(id)}/actions/${enc(action)}`, { body: body || {} }),
    diag: (id, name, args) => request('POST', `adapters/${enc(id)}/diag`, { body: args ? { name, args } : { name } }),
    // アダプタの追加。認証情報は本文にだけ載る（応答・トースト・state に入れない）
    addAdapter: (body) => request('POST', 'adapters', { body }),
    streamUrl: ({ adapter, logs } = {}) => {
      const u = new URL('stream', base)
      if (adapter) u.searchParams.set('adapter', adapter)
      if (logs) u.searchParams.set('logs', '1')
      return u.href
    },
  }
}
