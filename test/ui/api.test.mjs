// ui/api.js: URL の作り方・ヘッダ・失敗の形（{error:{code,message}}）。
// Authorization は付けない（httpNodeAuth の Basic と同じヘッダなので、載せると経路に届く前に断られる）。
// エディタのトークンは、変更の要求・電波を使う read・GET session にだけ X-Wsuha-Editor-Token で載せる。
//
// 戻すと落ちるもの:
//   - Content-Type を「本文があるときだけ」に戻す → DELETE と本文の無い POST が 415 になる形
//   - 401 の文言を「ログインが必要です」に戻す
//   - 読み出しのみ（403 READ_ONLY）の見分けを、前の FORBIDDEN / ANONYMOUS_WRITE_DISABLED に戻す
//   - トークンを全部の要求に載せる・Authorization に載せる・電波を使う read に印を付けない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApi, apiBaseFrom, editorRootFrom, ApiError, isReadOnlyError, isLoginRequiredError, isForbiddenError, loginHrefOf, fallbackMessage } from '../../ui/api.js'
import { S } from '../../ui/strings.js'

test('URL は画面の場所からの相対（httpNodeRoot が / 以外でも）', () => {
  assert.equal(apiBaseFrom('http://192.0.2.10:1880/wsuha-broute/ui/#/adapters/x/logs'), 'http://192.0.2.10:1880/wsuha-broute/api/v1/')
  assert.equal(apiBaseFrom('https://h/node/wsuha-broute/ui/index.html'), 'https://h/node/wsuha-broute/api/v1/')
  assert.equal(editorRootFrom('http://192.0.2.10:1880/wsuha-broute/ui/'), 'http://192.0.2.10:1880/')
  assert.equal(editorRootFrom('https://h/node/wsuha-broute/ui/index.html'), 'https://h/node/')
})

// 「エディタを開く / エディタで開く」は Meta.editorRoot（httpAdminRoot。false なら null）から作る。
// httpNodeRoot と httpAdminRoot が違うサーバー（DEV_HTTP_NODE_ROOT=/n/ など）でも、エディタの場所を外さない。
// 古いサーバー（editorRoot が無い）と meta をまだ読めていない間は、今までどおり画面の 2 つ上（httpNodeRoot）。
// 逆プロキシが /nodered/ を外すサーバーでは、settings の値は接頭辞を知らない。リンクが接頭辞の外（プロキシの 404）へ出ていた。
// 戻すと落ちるもの: loginHrefOf・editorRootOf が接頭辞を足さない。接頭辞の無いサーバーの値を変える
test('接頭辞の裏: ［Node-RED にログイン］と［エディタを開く］に接頭辞を足す。無いサーバーは今までと同じ値', async () => {
  const { editorRootOf, proxyPrefix } = await import('../../ui/api.js')
  const auth = (over) => ({ required: true, available: true, editorPath: '/', nodeRoot: '/', ...over })
  const behind = 'https://example.test/nodered/wsuha-broute/ui/#/adapters/a1/status'
  const direct = 'http://192.0.2.10:1880/wsuha-broute/ui/'
  assert.equal(proxyPrefix({ auth: auth() }, behind), '/nodered')
  assert.equal(proxyPrefix({ auth: auth() }, direct), '')
  assert.equal(proxyPrefix({ auth: auth({ nodeRoot: '/n/' }) }, 'https://example.test/a/b/n/wsuha-broute/ui/'), '/a/b')
  assert.equal(proxyPrefix({ auth: auth({ nodeRoot: '/n' }) }, 'https://example.test/a/n/wsuha-broute/ui/'), '/a', '/ で終わらない値も読む')
  assert.equal(proxyPrefix({ auth: auth({ nodeRoot: undefined }) }, behind), '', '返さないサーバー')
  assert.equal(proxyPrefix({}, behind), '')
  assert.equal(proxyPrefix(null, behind), '')

  assert.equal(loginHrefOf({ auth: auth() }, behind), 'https://example.test/nodered/')
  assert.equal(loginHrefOf({ auth: auth({ editorPath: '/admin/' }) }, behind), 'https://example.test/nodered/admin/')
  assert.equal(loginHrefOf({ auth: auth() }, direct), 'http://192.0.2.10:1880/')
  assert.equal(loginHrefOf({ auth: auth({ available: false, editorPath: null }) }, behind), null)

  assert.equal(editorRootOf({ editorRoot: '/', auth: auth() }, behind), 'https://example.test/nodered/')
  assert.equal(editorRootOf({ editorRoot: '/admin/', auth: auth() }, behind), 'https://example.test/nodered/admin/')
  assert.equal(editorRootOf({ editorRoot: '/', auth: auth() }, direct), 'http://192.0.2.10:1880/')
  assert.equal(editorRootOf({ editorRoot: null, auth: auth() }, behind), null)
})

// 戻すと落ちるもの: editorRootOf を作らずいつも editorRootFrom（2 つ上）にする → /n/ の画面で '/' にならない・null で消えない。
test('エディタの入口は meta.editorRoot から作る（null ならリンクを出さない・無ければ画面の 2 つ上）', async () => {
  const mod = await import('../../ui/api.js')
  assert.equal(typeof mod.editorRootOf, 'function', 'api.js に editorRootOf が無い')
  const { editorRootOf } = mod
  const page = 'http://192.0.2.10:1880/n/wsuha-broute/ui/#/adapters/x/settings'
  // httpNodeRoot が /n/、httpAdminRoot が / のサーバー: 2 つ上（/n/）ではなく / を開く
  assert.equal(editorRootOf({ editorRoot: '/' }, page), 'http://192.0.2.10:1880/')
  assert.equal(editorRootOf({ editorRoot: '/admin/' }, page), 'http://192.0.2.10:1880/admin/')
  // Node-RED の formatRoot と同じく、前後の / を補う（埋め込みの Node-RED は整えないことがある）
  assert.equal(editorRootOf({ editorRoot: 'admin' }, page), 'http://192.0.2.10:1880/admin/')
  assert.equal(editorRootOf({ editorRoot: '' }, page), 'http://192.0.2.10:1880/')
  // // で始まっても別のホストへ行かない（同じオリジンのパスとして読む）
  assert.equal(editorRootOf({ editorRoot: '//evil.example/x/' }, page), 'http://192.0.2.10:1880/evil.example/x/')
  assert.equal(editorRootOf({ editorRoot: '\\\\evil.example/' }, page), 'http://192.0.2.10:1880/evil.example/')
  assert.equal(editorRootOf({ editorRoot: '/\t/evil.example/' }, page), 'http://192.0.2.10:1880/evil.example/')
  // エディタが無効（httpAdminRoot === false）
  assert.equal(editorRootOf({ editorRoot: null }, page), null)
  assert.equal(editorRootOf({ editorRoot: false }, page), null)
  // 古いサーバー・meta をまだ読めていない: 画面の 2 つ上
  assert.equal(editorRootOf({ apiVersion: 1, readOnly: false }, page), 'http://192.0.2.10:1880/n/')
  assert.equal(editorRootOf(null, page), 'http://192.0.2.10:1880/n/')
  // 文字列でも null でもない値（壊れた応答）も古いサーバーと同じ扱い
  assert.equal(editorRootOf({ editorRoot: 1 }, page), 'http://192.0.2.10:1880/n/')
})

function recorder(respond) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  f.calls = calls
  return f
}

const json = (status, body, headers = {}) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

test('If-Match・JSON の本文・クエリを付け、id はエンコードする。Authorization は付けない', async () => {
  const f = recorder(() => json(200, { ok: true }))
  const api = createApi({ base: 'http://h/wsuha-broute/api/v1/', fetchImpl: f })
  await api.putSettings('a/b', 'rev-1', { pollIntervalSec: 30 })
  await api.trend('n1', '6h')
  await api.logs('n1', { after: 12, limit: 200, level: undefined })
  await api.action('n1', 'stop', { reason: '点検' })
  const [put, trend, logs, action] = f.calls
  assert.equal(put.url, 'http://h/wsuha-broute/api/v1/adapters/a%2Fb/settings')
  assert.equal(put.init.method, 'PUT')
  assert.equal(put.init.headers['If-Match'], 'rev-1')
  assert.equal(put.init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(put.init.body), { pollIntervalSec: 30 })
  assert.equal(trend.url, 'http://h/wsuha-broute/api/v1/adapters/n1/trend?range=6h')
  assert.equal(logs.url, 'http://h/wsuha-broute/api/v1/adapters/n1/logs?after=12&limit=200')
  assert.equal(action.url, 'http://h/wsuha-broute/api/v1/adapters/n1/actions/stop')
  assert.equal(api.streamUrl({ adapter: 'n 1', logs: true }), 'http://h/wsuha-broute/api/v1/stream?adapter=n+1&logs=1')
  assert.equal(api.streamUrl(), 'http://h/wsuha-broute/api/v1/stream')
  for (const c of f.calls) {
    assert.equal(Object.keys(c.init.headers).some((k) => k.toLowerCase() === 'authorization'), false, c.url)
    // httpNodeAuth（Basic 認証）のサーバーでは、ブラウザが同じオリジンの資格情報を付ける
    assert.equal(c.init.credentials, 'same-origin')
  }
})

// 書き込みは本文の有無にかかわらず Content-Type: application/json（無ければサーバーは 415）。
test('書き込み（PUT / DELETE / POST）は本文が無くても Content-Type: application/json を付ける。GET には付けない', async () => {
  const f = recorder(() => json(200, {}))
  const api = createApi({ base: 'http://h/wsuha-broute/api/v1/', fetchImpl: f })
  await api.resetSettings('n1', 'rev-1')
  await api.request('POST', 'adapters/n1/actions/poll')
  await api.request('PUT', 'adapters/n1/settings', { ifMatch: 'rev-1' })
  await api.action('n1', 'poll')
  await api.diag('n1', 'info')
  await api.meta()
  const [del, post, put, action, diag, get] = f.calls
  for (const c of [del, post, put, action, diag]) {
    assert.equal(c.init.headers['Content-Type'], 'application/json', c.init.method + ' ' + c.url)
  }
  assert.equal(del.init.method, 'DELETE')
  assert.equal(del.init.headers['If-Match'], 'rev-1')
  assert.equal(get.init.method, 'GET')
  assert.equal(get.init.headers['Content-Type'], undefined)
})

test('失敗は ApiError: サーバーの日本語の message と code・details をそのまま使う', async () => {
  const f = recorder(() => json(422, { error: { code: 'VALIDATION', message: '取得間隔は 15 秒以上です', details: { pollIntervalSec: '15 以上' } } }))
  const api = createApi({ base: 'http://h/', fetchImpl: f })
  await assert.rejects(api.putSettings('a', 'r', { pollIntervalSec: 1 }), (e) => {
    assert.ok(e instanceof ApiError)
    assert.equal(e.status, 422)
    assert.equal(e.code, 'VALIDATION')
    assert.equal(e.message, '取得間隔は 15 秒以上です')
    assert.deepEqual(e.details, { pollIntervalSec: '15 以上' })
    return true
  })
})

test('403 BAD_ORIGIN・READ_ONLY・415 も、サーバーの message をそのまま持つ', async () => {
  const cases = [
    [403, 'BAD_ORIGIN', '別のサイトからの操作は受け付けません'],
    [403, 'READ_ONLY', 'このサーバーでは画面からの操作を止めています（settings.js の wsuhaBroute.readOnly）'],
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type: application/json で送ってください'],
  ]
  for (const [status, code, message] of cases) {
    const api = createApi({ base: 'http://h/', fetchImpl: async () => json(status, { error: { code, message } }) })
    await assert.rejects(api.action('a', 'poll'), (e) => e.status === status && e.code === code && e.message === message)
  }
})

// エディタのトークンは、要らない所へ流さない。別のサイトの要求はこのヘッダを付けられないので、ここが別サイトからの守りにもなる。
const TOKEN = 'ZmFrZS10b2tlbi1mb3ItdGVzdHM'
const tokenStorage = (key = 'auth-tokens') => ({ get: (k) => (k === key ? JSON.stringify({ access_token: TOKEN }) : null) })
const tokenOf = (c) => c.init.headers['X-Wsuha-Editor-Token']

test('エディタのトークンは、変更の要求・電波を使う read・GET session にだけ載せる。Authorization は使わない', async () => {
  const f = recorder(() => json(200, {}))
  const api = createApi({ base: 'http://h/wsuha-broute/api/v1/', fetchImpl: f, storage: tokenStorage() })
  api.setEditorPath('/')
  await api.session()
  await api.putSettings('n1', 'r', {})
  await api.resetSettings('n1', 'r')
  await api.putConfig('n1', 'r', {})
  await api.resetConfig('n1', 'r')
  await api.putCredentials('n1', {})
  await api.clearCredentials('n1')
  await api.action('n1', 'poll')
  await api.diag('n1', 'info')
  await api.addAdapter({})
  await api.read('n1', { query: { maxAgeSec: 30 } })
  const sent = f.calls.length
  assert.deepEqual(f.calls.filter((c) => tokenOf(c) !== TOKEN).map((c) => c.url), [], 'トークンが載っていない要求')

  await api.meta()
  await api.adapters()
  await api.adapter('n1')
  await api.values('n1')
  await api.read('n1')
  await api.trend('n1', '1h')
  await api.logs('n1')
  await api.settings('n1')
  await api.config('n1')
  await api.serialports()
  assert.deepEqual(f.calls.slice(sent).filter((c) => tokenOf(c) !== undefined).map((c) => c.url), [], '読むだけの要求に載せた')
  for (const c of f.calls) assert.equal(Object.keys(c.init.headers).some((k) => k.toLowerCase() === 'authorization'), false, c.url)
  assert.equal(api.streamUrl({ adapter: 'n1' }).includes(TOKEN), false, 'SSE の URL に載せない')
})

test('トークンは要求のたびに読む。認証の無いサーバー（パスが null）とトークンの無い人には載せない', async () => {
  const f = recorder(() => json(200, {}))
  let value = null
  const storage = { get: (k) => (k === 'auth-tokens-admin' ? value : null) }
  const api = createApi({ base: 'http://h/', fetchImpl: f, storage })
  value = JSON.stringify({ access_token: TOKEN })
  await api.action('n1', 'poll')
  assert.equal(tokenOf(f.calls[0]), undefined, 'エディタのパスが分かるまでは読まない')
  api.setEditorPath('/admin/')
  await api.action('n1', 'poll')
  assert.equal(tokenOf(f.calls[1]), TOKEN)
  value = null
  await api.action('n1', 'poll')
  assert.equal(tokenOf(f.calls[2]), undefined, '別のタブでログアウトしたら次の要求から載らない')
  const noStorage = createApi({ base: 'http://h/', fetchImpl: f })
  noStorage.setEditorPath('/')
  await noStorage.action('n1', 'poll')
  assert.equal(tokenOf(f.calls[3]), undefined)
})

test('電波を使う read（maxAgeSec あり）には X-Wsuha-Radio: 1 を付ける。持っている値を読むだけなら付けない', async () => {
  const f = recorder(() => json(200, {}))
  const api = createApi({ base: 'http://h/', fetchImpl: f })
  await api.read('n1', { query: { maxAgeSec: 0, epcs: 'E7' } })
  await api.read('n1')
  await api.read('n1', { query: { epcs: 'E7' } })
  assert.equal(f.calls[0].url, 'http://h/adapters/n1/read?maxAgeSec=0&epcs=E7')
  assert.equal(f.calls[0].init.headers['X-Wsuha-Radio'], '1', 'maxAgeSec=0 も電波を使う')
  assert.equal(f.calls[1].init.headers['X-Wsuha-Radio'], undefined)
  assert.equal(f.calls[2].init.headers['X-Wsuha-Radio'], undefined)
})

test('［Node-RED にログイン］の行き先: meta.auth.editorPath。ログインできないサーバーは null。別のホストへ行かない', () => {
  const page = 'http://192.0.2.10:1880/n/wsuha-broute/ui/#/adapters/x/status'
  const at = (a) => loginHrefOf({ auth: a }, page)
  assert.equal(at({ available: true, editorPath: '/' }), 'http://192.0.2.10:1880/')
  assert.equal(at({ available: true, editorPath: '/admin/' }), 'http://192.0.2.10:1880/admin/')
  assert.equal(at({ available: false, editorPath: '/' }), null)
  assert.equal(at({ available: true, editorPath: null }), null)
  assert.equal(loginHrefOf({}, page), null, '古いサーバー')
  assert.equal(loginHrefOf(null, page), null)
  assert.equal(at({ available: true, editorPath: '//evil.example/x/' }), 'http://192.0.2.10:1880/evil.example/x/')
})

test('認証の断りの見分け: 401 LOGIN_REQUIRED と 403 FORBIDDEN だけ（Basic 認証の 401・FORBIDDEN_COMMAND は違う）', () => {
  assert.equal(isLoginRequiredError(new ApiError({ status: 401, code: 'LOGIN_REQUIRED' })), true)
  assert.equal(isLoginRequiredError(new ApiError({ status: 401, code: 'HTTP_401' })), false)
  assert.equal(isLoginRequiredError(null), false)
  assert.equal(isForbiddenError(new ApiError({ status: 403, code: 'FORBIDDEN' })), true)
  assert.equal(isForbiddenError(new ApiError({ status: 403, code: 'FORBIDDEN_COMMAND' })), false)
  assert.equal(isForbiddenError(new ApiError({ status: 403, code: 'READ_ONLY' })), false)
})

// Basic 認証の 401 は Node-RED が返す。本文が自前の形ではなく、Node-RED のログインの案内とは別に読み直しを勧める。
test('401 は Basic 認証（httpNodeAuth）の案内の文言。本文が自前の形でなくても落ちない', async () => {
  const api = createApi({ base: 'http://h/', fetchImpl: async () => json(401, 'Unauthorized') })
  await assert.rejects(api.adapters(), (e) => e.status === 401 && e.code === 'HTTP_401' && e.message === S.errors.unauthorized)
  assert.match(S.errors.unauthorized, /Basic 認証/)
  assert.doesNotMatch(S.errors.unauthorized, /ログイン/)
})

test('429 は Retry-After を秒で持つ。message が無ければ文言で埋める', async () => {
  const api = createApi({ base: 'http://h/', fetchImpl: async () => json(429, {}, { 'Retry-After': '3' }) })
  await assert.rejects(api.diag('a', 'info'), (e) => e.status === 429 && e.retryAfter === 3 && e.message === S.errors.rateLimited(3))
})

test('届かないときは status 0 / NETWORK。読めない成功の本文は BAD_RESPONSE', async () => {
  const down = createApi({ base: 'http://h/', fetchImpl: async () => Promise.reject(new TypeError('Failed to fetch')) })
  await assert.rejects(down.meta(), (e) => e.status === 0 && e.code === 'NETWORK' && e.message === S.errors.network)
  const broken = createApi({ base: 'http://h/', fetchImpl: async () => json(200, '{not json') })
  await assert.rejects(broken.meta(), (e) => e.code === 'BAD_RESPONSE')
})

test('読み出しのみ（403 READ_ONLY）の見分けと、状態コードごとの文言', () => {
  assert.equal(isReadOnlyError(new ApiError({ status: 403, code: 'READ_ONLY' })), true)
  assert.equal(isReadOnlyError(new ApiError({ status: 403, code: 'BAD_ORIGIN' })), false)
  assert.equal(isReadOnlyError(new ApiError({ status: 403, code: 'FORBIDDEN_COMMAND' })), false)
  assert.equal(isReadOnlyError(new ApiError({ status: 403, code: 'FORBIDDEN' })), false)
  assert.equal(isReadOnlyError(null), false)
  assert.equal(fallbackMessage(412), S.errors.precondition)
  assert.equal(fallbackMessage(503), S.errors.unavailable)
  assert.equal(fallbackMessage(504), S.errors.timeout)
  assert.equal(fallbackMessage(415), S.errors.unsupportedMedia)
  assert.equal(fallbackMessage(502), S.errors.deviceError)
  assert.equal(fallbackMessage(500), S.errors.server(500))
})
