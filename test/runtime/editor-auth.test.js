'use strict'

// Node-RED の認証（adminAuth）と Web UI の変更（lib/runtime/editor-auth.js と http-api.js の守り）。
// 偽の RED の needsPermission は、本物の 2 通りの 401 の書き方を写してある（fake-red.js）。
// 本物の Node-RED での確かめは editor-auth-embedded.test.js。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { install } = require('../../lib/runtime/http-api')
const {
  createEditorAuth,
  authMeta,
  nodeRootOf,
  editorGuardedElsewhere,
  editorTokenOf,
  LOGIN_REQUIRED_MESSAGE,
  FORBIDDEN_MESSAGE,
  NO_LOGIN_MESSAGE,
} = require('../../lib/runtime/editor-auth')
const { createRegistry } = require('../../lib/runtime/registry')
const { createFakeRed, tmpDir, ID, PW } = require('./fake-red')
const { makeAdapter, connect } = require('./adapter-kit')

const B = '/wsuha-broute/api/v1'
const TOKENS = {
  'tok-admin': { username: 'admin', permissions: '*' },
  'tok-write': { username: 'writer', permissions: ['read', 'wsuha-broute.write'] },
  'tok-all-write': { username: 'allwriter', permissions: 'write' },
  'tok-read': { username: 'viewer', permissions: 'read' },
}
const as = (token, headers) => Object.assign({ 'x-wsuha-editor-token': token }, headers)

/** 認証で守る変更のルートを全部、1 通りずつ。 */
function writesFor(id) {
  return [
    ['PUT', `${B}/adapters/${id}/settings`, { pollIntervalSec: 60 }, { 'if-match': '0' }],
    ['DELETE', `${B}/adapters/${id}/settings`, undefined, { 'if-match': '0' }],
    ['PUT', `${B}/adapters/${id}/config`, { name: '別の名前' }, { 'if-match': '0' }],
    ['DELETE', `${B}/adapters/${id}/config`, undefined, { 'if-match': '0' }],
    ['PUT', `${B}/adapters/${id}/credentials`, { routeBId: ID, routeBPassword: PW }],
    ['DELETE', `${B}/adapters/${id}/credentials`],
    ['POST', `${B}/adapters/${id}/actions/clear-radio-block`],
    ['POST', `${B}/adapters/${id}/actions/stop`, { reason: '試験' }],
    ['POST', `${B}/adapters/${id}/diag`, { name: 'ropt' }],
    ['POST', `${B}/adapters`, { mode: 'simulator' }],
  ]
}

/** 電波を使う GET read。 */
const radioRead = (id) => `${B}/adapters/${id}/read?epcs=E7&maxAgeSec=0`
const RADIO = { 'x-wsuha-radio': '1' }

async function setup(settings, tokens, installOpts) {
  const fake = createFakeRed({ settings, tokens: tokens === undefined ? TOKENS : tokens })
  const registry = createRegistry()
  const rt = install(fake.RED, Object.assign({ registry, uiDir: tmpDir('wsuha-ui-'), diagIntervalMs: 0 }, installOpts))
  const a = makeAdapter(registry, 'auth', {})
  await connect(a.seq)
  const dispose = async () => {
    if (rt.hub) rt.hub.dispose()
    await a.seq.destroy()
  }
  return { fake, rt, a, dispose }
}

function assertDenied(r, status, code, what, message) {
  assert.equal(r.statusCode, status, `${what}: ${r.text}`)
  assert.equal(r.body.error.code, code, what)
  assert.equal(r.body.error.message, message || (status === 401 ? LOGIN_REQUIRED_MESSAGE : FORBIDDEN_MESSAGE), what)
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', what)
  assert.equal(r.headers['cache-control'], 'no-store', what)
  assert.equal(r.headers['www-authenticate'], undefined, what + ': needsPermission の応答を外へ漏らさない')
}

test('adminAuth があるとき、トークンなしの変更は全部 401 LOGIN_REQUIRED で、何も変わらない', async () => {
  // 戻すと落ちるもの: http-api.js の write・configWrite・addWrite から requireLogin を外す（どれか 1 つでも）
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials' } })
  try {
    a.seq._setRadioBlocked(true)
    const before = a.seq.transport.sent.length
    for (const [m, url, body, headers] of writesFor('auth')) {
      assertDenied(await fake.request(m, url, { body, headers }), 401, 'LOGIN_REQUIRED', `${m} ${url}`)
    }
    assertDenied(await fake.request('GET', radioRead('auth'), { headers: RADIO }), 401, 'LOGIN_REQUIRED', 'GET read')
    assert.equal(a.seq.state.radioBlocked, true, '送信制限の解除は効いていない')
    assert.equal(a.seq.state.overrides.stopped, null, '停止は効いていない')
    assert.equal(a.seq.options.pollIntervalSec, 30, '運用設定は効いていない')
    assert.equal(a.seq.transport.sent.length, before, '電波も診断も使っていない')
  } finally {
    await dispose()
  }
})

test('全権限のトークン・wsuha-broute.write・write は通る。read の権限は 403 FORBIDDEN', async () => {
  // 戻すと落ちるもの: editor-auth.js の X-Wsuha-Editor-Token を Bearer に写す処理を外す・req.user で 401 と 403 を分けない
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials' } })
  try {
    for (const tok of ['tok-admin', 'tok-write', 'tok-all-write']) {
      a.seq._setRadioBlocked(true)
      const r = await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`, { headers: as(tok) })
      assert.equal(r.statusCode, 200, `${tok}: ${r.text}`)
      assert.equal(a.seq.state.radioBlocked, false, tok)
    }
    // 守りを通ったあとは、それぞれの処理の返事になる（401・403 でない）
    for (const [m, url, body, headers] of writesFor('auth')) {
      const r = await fake.request(m, url, { body, headers: as('tok-admin', headers) })
      assert.ok(r.statusCode !== 401 && !(r.body && r.body.error && r.body.error.code === 'FORBIDDEN'), `${m} ${url}: ${r.statusCode} ${r.text}`)
    }
    await a.seq.start()
    await connect(a.seq)
    const read = await fake.request('GET', radioRead('auth'), { headers: as('tok-admin', RADIO) })
    assert.equal(read.statusCode, 200, read.text)
    assert.deepEqual(read.body.refreshed, ['E7'])

    a.seq._setRadioBlocked(true)
    for (const [m, url, body, headers] of writesFor('auth')) {
      assertDenied(await fake.request(m, url, { body, headers: as('tok-read', headers) }), 403, 'FORBIDDEN', `${m} ${url}`)
    }
    assertDenied(await fake.request('GET', radioRead('auth'), { headers: as('tok-read', RADIO) }), 403, 'FORBIDDEN', 'GET read')
    assert.equal(a.seq.state.radioBlocked, true, 'read の権限では変わらない')
  } finally {
    await dispose()
  }
})

test('切れたトークン・壊れたトークンは 401 LOGIN_REQUIRED（passport の 400 もログインの案内にする）', async () => {
  // 戻すと落ちるもの: editor-auth.js が代役の res.statusCode で 401 だけを失敗に数える
  const { fake, dispose } = await setup({ adminAuth: { type: 'credentials' } })
  try {
    for (const tok of ['tok-expired', 'tok with spaces']) {
      assertDenied(await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`, { headers: as(tok) }), 401, 'LOGIN_REQUIRED', tok)
    }
    assert.deepEqual((await fake.request('GET', `${B}/session`, { headers: as('tok-expired') })).body, { required: true, loggedIn: false, canWrite: false })
  } finally {
    await dispose()
  }
})

test('読むだけの API・SSE・画面は、adminAuth があっても匿名で読める', async () => {
  const { fake, dispose } = await setup({ adminAuth: { type: 'credentials' } })
  try {
    for (const p of ['/meta', '/session', '/serialports', '/adapters', '/adapters/auth', '/adapters/auth/values', '/adapters/auth/trend', '/adapters/auth/logs', '/adapters/auth/settings', '/adapters/auth/config', '/adapters/auth/read?epcs=E7']) {
      const r = await fake.request('GET', B + p)
      assert.equal(r.statusCode, 200, `${p}: ${r.text}`)
    }
    const s = fake.openStream(B + '/stream')
    await s.done
    assert.equal(s.res.statusCode, 200)
    assert.equal(s.res.headers['content-type'], 'text/event-stream; charset=utf-8')
    s.req.emit('close')
    const ui = await fake.request('GET', '/wsuha-broute/')
    assert.equal(ui.statusCode, 302, '画面の配信にも認証を掛けない')
  } finally {
    await dispose()
  }
})

test('守りの順: BAD_HOST → 415 → BAD_ORIGIN → 認証 → READ_ONLY → CONFIG_LOCKED → 本文', async () => {
  // 戻すと落ちるもの: http-api.js の write の並びを入れ替える（認証を requireSameOrigin の前・requireWritable のあとへ動かす）
  const settings = { adminAuth: { type: 'credentials' }, wsuhaBroute: { readOnly: true, uiConfig: false } }
  const { fake, dispose } = await setup(settings)
  try {
    const url = `${B}/adapters/auth/config`
    const run = async (headers, rawBody) => {
      const r = await fake.request('PUT', url, { headers: Object.assign({ 'if-match': '0' }, headers), rawBody })
      return r.body.error.code
    }
    assert.equal(await run({ host: 'evil.example', 'content-type': 'text/plain', origin: 'http://evil.example' }), 'BAD_HOST')
    assert.equal(await run({ 'content-type': 'text/plain', origin: 'http://evil.example' }), 'UNSUPPORTED_MEDIA_TYPE')
    assert.equal(await run({ origin: 'http://evil.example' }), 'BAD_ORIGIN')
    assert.equal(await run({ origin: 'http://evil.example', 'x-wsuha-editor-token': 'tok-admin' }), 'BAD_ORIGIN', 'トークンがあっても別のサイトからは断る')
    assert.equal(await run({}), 'LOGIN_REQUIRED', 'READ_ONLY より先に認証')
    assert.equal(await run({ 'x-wsuha-editor-token': 'tok-read' }), 'FORBIDDEN', 'READ_ONLY より先に権限')
    assert.equal(await run({ 'x-wsuha-editor-token': 'tok-admin' }), 'READ_ONLY')
    settings.wsuhaBroute.readOnly = false
    fake.settings.wsuhaBroute.readOnly = false
    assert.equal(await run({ 'x-wsuha-editor-token': 'tok-admin' }), 'CONFIG_LOCKED')
    fake.settings.wsuhaBroute.uiConfig = true
    assert.equal(await run({ 'x-wsuha-editor-token': 'tok-admin' }, '{"name": '), 'VALIDATION', '本文は最後に読む')
  } finally {
    await dispose()
  }
})

test('電波を使う GET read も、守りの順は別のサイト → 認証 → READ_ONLY', async () => {
  // 戻すと落ちるもの: handlers.read の READ_ONLY を認証より先に戻す・認証を外す
  const { fake, dispose } = await setup({ adminAuth: { type: 'credentials' }, wsuhaBroute: { readOnly: true } })
  try {
    const url = radioRead('auth')
    const code = async (headers) => (await fake.request('GET', url, { headers })).body.error.code
    assert.equal(await code({}), 'BAD_ORIGIN', 'X-Wsuha-Radio が無い')
    assert.equal(await code({ 'x-wsuha-editor-token': 'tok-admin' }), 'BAD_ORIGIN', 'トークンだけではヘッダの代わりにならない')
    assert.equal(await code(Object.assign({ origin: 'http://evil.example' }, RADIO)), 'BAD_ORIGIN')
    assert.equal(await code(RADIO), 'LOGIN_REQUIRED')
    assert.equal(await code(as('tok-read', RADIO)), 'FORBIDDEN')
    assert.equal(await code(as('tok-admin', RADIO)), 'READ_ONLY')
  } finally {
    await dispose()
  }
})

test('httpAdminRoot: false（認証の仕組みが無い）では、needsPermission が素通りでも全部の変更を閉じる', async () => {
  // 戻すと落ちるもの: editor-auth.js の unusable() と「通ったのに req.user が無い」の判定を両方外す
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials' }, httpAdminRoot: false })
  try {
    a.seq._setRadioBlocked(true)
    for (const [m, url, body, headers] of writesFor('auth')) {
      assertDenied(await fake.request(m, url, { body, headers: as('tok-admin', headers) }), 401, 'LOGIN_REQUIRED', `${m} ${url}`, NO_LOGIN_MESSAGE)
    }
    assertDenied(await fake.request('GET', radioRead('auth'), { headers: as('tok-admin', RADIO) }), 401, 'LOGIN_REQUIRED', 'GET read', NO_LOGIN_MESSAGE)
    assert.equal(a.seq.state.radioBlocked, true)
    assert.deepEqual((await fake.request('GET', B + '/session', { headers: as('tok-admin') })).body, { required: true, loggedIn: false, canWrite: false })
    assert.deepEqual((await fake.request('GET', B + '/meta')).body.auth, { required: true, available: false, editorPath: null, nodeRoot: '/' })
    const warns = fake.logs.filter(([l, t]) => l === 'warn' && /認証の仕組みを使えません/.test(t))
    assert.equal(warns.length, 1, '何度断っても 1 行だけ')
    assert.match(warns[0][1], /httpAdminRoot/)
    assert.match(warns[0][1], /再起動/, '次にすることを書く')
  } finally {
    await dispose()
  }
})

test('設定から分からなくても、通ったのに利用者がいなければ閉じる（素通りの needsPermission・RED.auth が無い）', async () => {
  // 戻すと落ちるもの: editor-auth.js の check で、out.passed のときに user を見ない
  const { fake, dispose } = await setup({ adminAuth: { type: 'credentials' } })
  try {
    fake.RED.auth.needsPermission = () => (req, res, next) => next()
    const url = `${B}/adapters/auth/actions/clear-radio-block`
    assertDenied(await fake.request('POST', url, { headers: as('tok-admin') }), 401, 'LOGIN_REQUIRED', '素通り')
    assert.ok(fake.logs.some(([l, t]) => l === 'warn' && /認証の仕組みを使えません/.test(t)))
    fake.RED.auth = undefined
    assertDenied(await fake.request('POST', url, { headers: as('tok-admin') }), 401, 'LOGIN_REQUIRED', 'RED.auth が無い', NO_LOGIN_MESSAGE)
  } finally {
    await dispose()
  }
})

test('手前の処理が置いた req.user を信じない', async () => {
  // 戻すと落ちるもの: editor-auth.js の check から delete req.user を外す
  const seen = {}
  const RED = { settings: { adminAuth: {} }, auth: { needsPermission: () => (req, res, next) => ((seen.user = req.user), next()) } }
  const auth = createEditorAuth({ RED })
  const r = await auth.check({ headers: {}, user: { username: '偽物', permissions: '*' } })
  assert.equal(seen.user, undefined)
  assert.deepEqual(r, { required: true, loggedIn: false, canWrite: false, denied: 'login' })
})

test('needsPermission の失敗（next(err)・例外）は閉じる側に倒し、トークンをログに出さない', async () => {
  // 戻すと落ちるもの: editor-auth.js の runGuard で next(err) を通ったとみなす・例外を受けない
  const guards = [
    (req, res, next) => next(new Error('トークンの保管に失敗: tok-admin')),
    (req, res, next) => {
      req.user = { username: 'admin', permissions: '*' }
      next(new Error('tok-admin'))
    },
    () => {
      throw new Error('tok-admin')
    },
  ]
  for (const guard of guards) {
    const logs = []
    const auth = createEditorAuth({ RED: { settings: { adminAuth: {} }, auth: { needsPermission: () => guard } }, log: (l, t) => logs.push(t) })
    const req = { headers: as('tok-admin') }
    assert.deepEqual(await auth.check(req), { required: true, loggedIn: false, canWrite: false, denied: 'login' })
    assert.equal(req.headers.authorization, undefined, '例外のあとも Authorization を戻す')
    assert.ok(logs.length >= 1 && !logs.join('').includes('tok-admin'), logs.join(' | '))
  }
})

test('トークンは確かめる間だけ Authorization に写し、終わったら元へ戻す（httpNodeAuth の Basic を壊さない）', async () => {
  // 戻すと落ちるもの: editor-auth.js の finally で元へ戻さない・Bearer の形で写さない
  const seen = []
  const RED = {
    settings: { adminAuth: {} },
    auth: {
      needsPermission: (p) => (req, res, next) => {
        seen.push([p, req.headers.authorization])
        req.user = { username: 'a' }
        next()
      },
    },
  }
  const auth = createEditorAuth({ RED })
  const basic = 'Basic bm9kZXVzZXI6dGVzdA=='
  const req = { headers: as('tok-admin', { authorization: basic }) }
  assert.equal((await auth.check(req)).canWrite, true)
  assert.deepEqual(seen.pop(), ['wsuha-broute.write', 'Bearer tok-admin'])
  assert.equal(req.headers.authorization, basic)

  const bare = { headers: as('tok-admin') }
  await auth.check(bare)
  assert.ok(!('authorization' in bare.headers), '無かったヘッダは消す')

  // トークンが無ければ触らない（Basic のまま確かめる）
  const none = { headers: { authorization: basic } }
  await auth.check(none)
  assert.deepEqual(seen.pop(), ['wsuha-broute.write', basic])
})

test('401 の 2 通りの書き方（passport の res.end と Node-RED の res.status(401).end()）をどちらも受け止める', async () => {
  // 戻すと落ちるもの: editor-auth.js の standInRes から status か end を外す
  const guards = {
    passport: (req, res) => {
      res.statusCode = 401
      res.setHeader('WWW-Authenticate', ['Bearer realm="Users"'])
      res.end('Unauthorized')
    },
    permission: (req, res) => {
      req.user = { username: 'viewer', permissions: 'read' }
      res.status(401).end()
    },
  }
  const check = (g) => createEditorAuth({ RED: { settings: { adminAuth: {} }, auth: { needsPermission: () => g } } }).check({ headers: {} })
  assert.deepEqual(await check(guards.passport), { required: true, loggedIn: false, canWrite: false, denied: 'login' })
  assert.deepEqual(await check(guards.permission), { required: true, loggedIn: true, canWrite: false, denied: 'forbidden' })
})

test('adminAuth.default で匿名に権限を与えたサーバーは、Node-RED の設定どおりに匿名でも通る', async () => {
  // 戻すと落ちるもの: editor-auth.js が「トークンが無ければ断る」を先に見る
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials', default: { permissions: '*' } } })
  try {
    a.seq._setRadioBlocked(true)
    const r = await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`)
    assert.equal(r.statusCode, 200, r.text)
    assert.equal(a.seq.state.radioBlocked, false)
    assert.deepEqual((await fake.request('GET', B + '/session')).body, { required: true, loggedIn: false, canWrite: true })
    assert.deepEqual((await fake.request('GET', B + '/session', { headers: as('tok-admin') })).body, { required: true, loggedIn: true, canWrite: true })
  } finally {
    await dispose()
  }
})

test('匿名に read だけを与えたサーバーでは、匿名の変更は 401（ログインの案内）で、ログインすれば通る', async () => {
  // 匿名はログインしていないので「権限がありません」では次にすることが分からない。
  // 戻すと落ちるもの: editor-auth.js の person を !!user にする（匿名が 403 FORBIDDEN になる）
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials', default: { permissions: 'read' } } })
  try {
    a.seq._setRadioBlocked(true)
    const url = `${B}/adapters/auth/actions/clear-radio-block`
    assertDenied(await fake.request('POST', url), 401, 'LOGIN_REQUIRED', '匿名')
    assert.deepEqual((await fake.request('GET', B + '/session')).body, { required: true, loggedIn: false, canWrite: false })
    assert.equal((await fake.request('POST', url, { headers: as('tok-admin') })).statusCode, 200)
    assert.deepEqual((await fake.request('GET', B + '/session', { headers: as('tok-read') })).body, { required: true, loggedIn: true, canWrite: false })
  } finally {
    await dispose()
  }
})

test('adminAuth が無ければ今までどおり（トークンなしで変更でき、needsPermission を呼ばない）', async () => {
  // 戻すと落ちるもの: requireLogin の editorAuth.required() を外す・check の adminAuth の分岐を外す
  const { fake, a, dispose } = await setup({})
  try {
    fake.RED.auth.needsPermission = () => {
      throw new Error('adminAuth が無いのに呼んだ')
    }
    a.seq._setRadioBlocked(true)
    const r = await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`)
    assert.equal(r.statusCode, 200, r.text)
    assert.equal((await fake.request('GET', radioRead('auth'), { headers: RADIO })).statusCode, 200)
    assert.deepEqual((await fake.request('GET', B + '/session')).body, { required: false, loggedIn: false, canWrite: true })
    assert.deepEqual((await fake.request('GET', B + '/meta')).body.auth, { required: false, available: true, editorPath: '/', nodeRoot: '/' })
  } finally {
    await dispose()
  }
})

const BASIC = { user: 'edit', pass: '$2a$08$xxxxxxxxxxxxxxxxxxxxxx' }
const passThrough = (req, res, next) => next()
/** red.js で起動したサーバーの印（red.js は設定を読んだ直後に settingsFile を置く）。埋め込みのサーバーには無い。 */
const RED_JS = { settingsFile: '/data/settings.js' }

/** エディタを adminAuth 以外の方法で閉じていて、httpNode に守りが掛からないサーバー。 */
const GUARDED = [
  ['httpAdminRoot: false', { httpAdminRoot: false }, '/'],
  ['根が別の httpAdminAuth', { httpAdminRoot: '/admin', httpNodeRoot: '/', httpAdminAuth: BASIC }, '/'],
  ['根が別の httpAdminMiddleware', { httpAdminRoot: '/admin/', httpNodeRoot: '/', httpAdminMiddleware: passThrough }, '/'],
  ['名前の先頭が同じだけの別の根', { httpAdminRoot: '/admin', httpNodeRoot: '/administrator', httpAdminAuth: BASIC }, '/administrator/'],
]

test('エディタを adminAuth 以外の方法で閉じたサーバーでは、変更を全部 401 で断る。読むのは開けておく', async () => {
  // エディタは 401・404 なのに、Web UI だけが匿名で flows.json と認証情報を書けた。
  // 戻すと落ちるもの: editor-auth.js の check か required で closedElsewhere を見ない（authMeta で見ないと meta の形で落ちる）
  for (const [what, settings, nodeRoot] of GUARDED) {
    const { fake, a, dispose } = await setup(settings)
    try {
      fake.RED.auth.needsPermission = () => {
        throw new Error('確かめる相手がいないのに呼んだ')
      }
      a.seq._setRadioBlocked(true)
      const before = a.seq.transport.sent.length
      for (const [m, url, body, headers] of writesFor('auth')) {
        assertDenied(await fake.request(m, url, { body, headers: as('tok-admin', headers) }), 401, 'LOGIN_REQUIRED', `${what}: ${m} ${url}`, NO_LOGIN_MESSAGE)
      }
      assertDenied(await fake.request('GET', radioRead('auth'), { headers: RADIO }), 401, 'LOGIN_REQUIRED', `${what}: GET read`, NO_LOGIN_MESSAGE)
      assert.equal(a.seq.state.radioBlocked, true, what)
      assert.equal(a.seq.state.overrides.stopped, null, what)
      assert.equal(a.seq.options.pollIntervalSec, 30, what)
      assert.equal(a.seq.transport.sent.length, before, what)

      for (const p of ['/meta', '/session', '/adapters', '/adapters/auth', '/adapters/auth/config']) {
        assert.equal((await fake.request('GET', B + p)).statusCode, 200, `${what}: ${p}`)
      }
      assert.deepEqual((await fake.request('GET', B + '/session')).body, { required: true, loggedIn: false, canWrite: false }, what)
      // ログインの手段が無いので、エディタのパスを渡さない（渡すと使えないログインのリンクが出る）
      assert.deepEqual((await fake.request('GET', B + '/meta')).body.auth, { required: true, available: false, editorPath: null, nodeRoot }, what)

      const warns = fake.logs.filter(([l, t]) => l === 'warn' && /adminAuth 以外の方法で閉じている/.test(t))
      assert.equal(warns.length, 1, `${what}: 何度断っても 1 行だけ`)
      assert.match(warns[0][1], /allowAnonymousWrites: true/, '開き方を書く')
      assert.doesNotMatch(warns[0][1], /httpNodeAuth か/, '埋め込みでは書いても開かないので案内しない')
      assert.ok(!fake.logs.some(([, t]) => /settings\.js に adminAuth があります|認証の仕組みを使えません/.test(t)), 'adminAuth が無いサーバーに、あると言わない')
    } finally {
      await dispose()
    }
  }
})

test('閉じたサーバーは、起動のときに warn を 1 行出す（断る前に分かるように）', async () => {
  // 戻すと落ちるもの: editor-auth.js の warnIfClosed で closedElsewhere を見ない
  const { fake, dispose } = await setup({ httpAdminRoot: false })
  try {
    assert.equal(fake.logs.filter(([l, t]) => l === 'warn' && /adminAuth 以外の方法で閉じている/.test(t)).length, 1)
  } finally {
    await dispose()
  }
})

test('閉じたときの warn の開き方は、そのサーバーで効くものだけを案内する', async () => {
  // 埋め込みのサーバーで案内どおりに httpNodeAuth を書いても、Basic は掛からない。
  // 戻すと落ちるもの: editor-auth.js の warnGuarded で文を分けない
  const warnOf = async (settings) => {
    const { fake, dispose } = await setup(settings)
    await dispose()
    return fake.logs.filter(([l, t]) => l === 'warn' && /adminAuth 以外の方法で閉じている/.test(t))[0][1]
  }
  const redJs = await warnOf(Object.assign({ httpAdminRoot: false }, RED_JS))
  assert.match(redJs, /settings\.js に httpNodeAuth か wsuhaBroute: \{ allowAnonymousWrites: true \} を書いてください/)
  const embedded = await warnOf({ httpAdminRoot: false })
  assert.match(embedded, /Node-RED の設定に wsuhaBroute: \{ allowAnonymousWrites: true \} を書き/)
  assert.match(embedded, /守りはホストのアプリで掛けてください/)
  assert.match(embedded, /埋め込みの Node-RED には httpNodeAuth が掛かりません/)
  assert.ok(!embedded.includes('settings.js'), '埋め込みのサーバーに settings.js は無い')
})

test('埋め込みのサーバーの httpNodeAuth・httpAuth は掛からないので守りに数えず、閉じたままにする', async () => {
  // 掛けるのは red.js だけなのに、書いてあるだけで匿名の変更を開いていた。
  // 戻すと落ちるもの: editor-auth.js の editorGuardedElsewhere で startedByRedJs を見ない
  for (const settings of [
    { httpAdminRoot: false, httpNodeAuth: BASIC },
    { httpAdminRoot: false, httpAuth: BASIC },
    { httpRoot: false, httpNodeAuth: BASIC },
    { httpAdminRoot: '/admin', httpNodeRoot: '/', httpAdminAuth: BASIC, httpNodeAuth: BASIC },
    { httpAdminRoot: '/admin/', httpNodeRoot: '/', httpAdminMiddleware: passThrough, httpAuth: BASIC },
  ]) {
    const what = Object.keys(settings).join(' + ')
    assert.equal(editorGuardedElsewhere(settings), true, what)
    assert.equal(editorGuardedElsewhere(Object.assign({}, settings, RED_JS)), false, `red.js で起動したなら掛かる: ${what}`)
    assert.equal(editorGuardedElsewhere(Object.assign({}, settings, { settingsFile: true })), true, `文字列のときだけ: ${what}`)
    const { fake, a, dispose } = await setup(settings)
    try {
      a.seq._setRadioBlocked(true)
      assertDenied(await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`), 401, 'LOGIN_REQUIRED', what, NO_LOGIN_MESSAGE)
      assert.equal(a.seq.state.radioBlocked, true, what)
      assert.deepEqual((await fake.request('GET', B + '/session')).body, { required: true, loggedIn: false, canWrite: false }, what)
    } finally {
      await dispose()
    }
  }
})

test('閉じたサーバーでも、red.js の httpNodeAuth か wsuhaBroute.allowAnonymousWrites: true なら開く', async () => {
  // 戻すと落ちるもの: editor-auth.js の editorGuardedElsewhere で httpNodeAuth・httpAuth を見ない・closedElsewhere で allowAnonymousWrites を見ない
  for (const settings of [
    Object.assign({ httpAdminRoot: false, httpNodeAuth: BASIC }, RED_JS),
    Object.assign({ httpAdminRoot: false, httpAuth: BASIC }, RED_JS),
    Object.assign({ httpAdminRoot: '/admin', httpAdminAuth: BASIC, httpNodeAuth: BASIC }, RED_JS),
    { httpAdminRoot: false, wsuhaBroute: { allowAnonymousWrites: true } },
    { httpAdminRoot: '/admin', httpAdminAuth: BASIC, wsuhaBroute: { allowAnonymousWrites: true } },
    { httpAdminRoot: '/admin', httpAdminMiddleware: passThrough, wsuhaBroute: { allowAnonymousWrites: true } },
  ]) {
    const what = Object.keys(settings).join(' + ')
    const { fake, a, dispose } = await setup(settings)
    try {
      a.seq._setRadioBlocked(true)
      const r = await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`)
      assert.equal(r.statusCode, 200, `${what}: ${r.text}`)
      assert.equal(a.seq.state.radioBlocked, false, what)
      assert.deepEqual((await fake.request('GET', B + '/session')).body, { required: false, loggedIn: false, canWrite: true }, what)
      assert.equal((await fake.request('GET', B + '/meta')).body.auth.required, false, what)
      assert.ok(!fake.logs.some(([, t]) => /adminAuth 以外の方法で閉じている/.test(t)), what)
    } finally {
      await dispose()
    }
  }
})

test('allowAnonymousWrites は true のときだけ効き、adminAuth のサーバーの認証は外さない', async () => {
  // 戻すと落ちるもの: editor-auth.js の closedElsewhere を === true でなく真偽で見る・check の先頭で allowAnonymousWrites を見て通す
  for (const v of ['true', 1, {}]) {
    const { fake, dispose } = await setup({ httpAdminRoot: false, wsuhaBroute: { allowAnonymousWrites: v } })
    try {
      assertDenied(await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`), 401, 'LOGIN_REQUIRED', String(v), NO_LOGIN_MESSAGE)
    } finally {
      await dispose()
    }
  }
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials' }, wsuhaBroute: { allowAnonymousWrites: true } })
  try {
    a.seq._setRadioBlocked(true)
    assertDenied(await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`), 401, 'LOGIN_REQUIRED', 'adminAuth')
    assert.equal(a.seq.state.radioBlocked, true)
  } finally {
    await dispose()
  }
})

test('editorGuardedElsewhere: エディタの守りが httpNode にも掛かるサーバーは閉じない', () => {
  // 既定の根が同じ '/' は httpAdmin の守りが httpNode にも掛かる。閉じると、今まで動いていたサーバーが急に変更できなくなる。
  // 戻すと落ちるもの: editor-auth.js の editorGuardedElsewhere で根を比べない
  for (const [what, s] of [
    ['何も無い', {}],
    ['adminAuth', { adminAuth: {}, httpAdminRoot: false }],
    ['根が同じ httpAdminAuth', { httpAdminAuth: BASIC }],
    ['根が同じ httpAdminMiddleware', { httpAdminMiddleware: passThrough }],
    ['httpRoot で根が同じ', { httpRoot: '/red', httpAdminAuth: BASIC }],
    ['httpNode が httpAdmin の下', { httpAdminRoot: '/admin', httpNodeRoot: '/admin/api', httpAdminAuth: BASIC }],
    ['書き方の違いだけ（/ の有無）', { httpAdminRoot: '/admin/', httpNodeRoot: '/admin', httpAdminMiddleware: passThrough }],
    ['エディタの守りが無い根の分け方', { httpAdminRoot: '/admin', httpNodeRoot: '/' }],
  ]) {
    assert.equal(editorGuardedElsewhere(s), false, what)
  }
  assert.equal(editorGuardedElsewhere({ httpRoot: false }), true, 'httpRoot: false も httpAdminRoot: false と同じ')
  assert.equal(editorGuardedElsewhere(undefined), false)
})

test('nodeRootOf: httpNodeRoot を / で終わる形にする。httpNode を切っていれば null', () => {
  // 画面は location.pathname と比べて、逆プロキシが足した接頭辞を求める。形が揃っていないと接頭辞を読み違える。
  // 戻すと落ちるもの: editor-auth.js の nodeRootOf で formatRoot を通さない・httpRoot を見ない
  for (const [s, want] of [
    [{}, '/'],
    [{ httpNodeRoot: '/' }, '/'],
    [{ httpNodeRoot: '/n' }, '/n/'],
    [{ httpNodeRoot: 'n/' }, '/n/'],
    [{ httpRoot: '/red' }, '/red/'],
    [{ httpRoot: '/red', httpNodeRoot: '/n/' }, '/n/'],
    [{ httpNodeRoot: false }, null],
    [{ httpRoot: false }, null],
  ]) {
    assert.equal(nodeRootOf(s), want, JSON.stringify(s))
  }
})

test('GET meta の auth: required・available・editorPath・nodeRoot', async () => {
  assert.deepEqual(authMeta({ adminAuth: {} }, '/admin/'), { required: true, available: true, editorPath: '/admin/', nodeRoot: '/' })
  assert.deepEqual(authMeta({ adminAuth: {} }, null), { required: true, available: false, editorPath: null, nodeRoot: '/' })
  assert.deepEqual(authMeta({}, '/'), { required: false, available: true, editorPath: '/', nodeRoot: '/' })
  for (const [settings, want] of [
    [{ adminAuth: {} }, { required: true, available: true, editorPath: '/', nodeRoot: '/' }],
    [{ adminAuth: {}, httpAdminRoot: '/admin' }, { required: true, available: true, editorPath: '/admin/', nodeRoot: '/' }],
    [{ adminAuth: {}, disableEditor: true }, { required: true, available: false, editorPath: null, nodeRoot: '/' }],
    [{ adminAuth: {}, httpNodeRoot: '/n' }, { required: true, available: true, editorPath: '/', nodeRoot: '/n/' }],
    [{ httpAdminRoot: false }, { required: true, available: false, editorPath: null, nodeRoot: '/' }],
    [{ httpAdminRoot: false, wsuhaBroute: { allowAnonymousWrites: true } }, { required: false, available: false, editorPath: null, nodeRoot: '/' }],
    [{ httpAdminRoot: '/admin', httpAdminAuth: BASIC, wsuhaBroute: { allowAnonymousWrites: true } }, { required: false, available: true, editorPath: '/admin/', nodeRoot: '/' }],
  ]) {
    const fake = createFakeRed({ settings })
    const rt = install(fake.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-') })
    try {
      assert.deepEqual((await fake.request('GET', B + '/meta')).body.auth, want, JSON.stringify(settings))
    } finally {
      rt.hub.dispose()
    }
  }
})

test('disableEditor でも認証の仕組みは動く（トークンが有効なら通る）', async () => {
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials' }, disableEditor: true })
  try {
    a.seq._setRadioBlocked(true)
    const r = await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`, { headers: as('tok-admin') })
    assert.equal(r.statusCode, 200, r.text)
  } finally {
    await dispose()
  }
})

test('通らなかった変更を残す: 監査は毎回、warn は間引いて件数を添える。トークン・本文・クエリは入れない', async () => {
  // 戻すと落ちるもの: http-api.js の authorize から recordDenied を外す・warn を間引かない
  let t = 1000000
  const { fake, dispose } = await setup({ adminAuth: { type: 'credentials' } }, TOKENS, { now: () => t })
  try {
    const url = `${B}/adapters/auth/credentials?access_token=tok-in-query`
    for (let i = 0; i < 4; i++) {
      await fake.request('PUT', url, { body: { routeBId: ID, routeBPassword: PW }, headers: as('tok-expired') })
    }
    await fake.request('PUT', url, { body: { routeBId: ID, routeBPassword: PW }, headers: as('tok-read') })
    const audits = fake.logs.filter(([l, x]) => l === 'audit' && /wsuha-broute\.auth\.denied/.test(x)).map(([, x]) => JSON.parse(x))
    assert.equal(audits.length, 5, '監査は毎回')
    assert.deepEqual(audits.map((x) => x.code), ['LOGIN_REQUIRED', 'LOGIN_REQUIRED', 'LOGIN_REQUIRED', 'LOGIN_REQUIRED', 'FORBIDDEN'])
    const warns = () => fake.logs.filter(([l, x]) => l === 'warn' && /認証を通らなかった変更/.test(x)).map(([, x]) => x)
    assert.equal(warns().length, 1, '続いたら warn は 1 行')
    assert.match(warns()[0], /LOGIN_REQUIRED・PUT \/wsuha-broute\/api\/v1\/adapters\/auth\/credentials・接続元/)
    t += 61000
    await fake.request('DELETE', `${B}/adapters/auth/credentials`)
    assert.equal(warns().length, 2)
    assert.match(warns()[1], /ほかに 4 件/)
    const all = JSON.stringify(fake.logs)
    for (const x of ['tok-expired', 'tok-read', 'tok-in-query', ID, PW]) assert.ok(!all.includes(x), `ログに ${x.slice(0, 6)}… が出ている`)
  } finally {
    await dispose()
  }
})

test('断る途中で思わぬ失敗をしても、通さずに 401 を返す（応答が返らないまま止まらない）', async () => {
  // 戻すと落ちるもの: http-api.js の requireLogin で ApiError のときだけ返す（status の無いエラーを sendError に渡して何も返らない）
  let boom = false
  const { fake, a, dispose } = await setup({ adminAuth: { type: 'credentials' } }, TOKENS, {
    now: () => {
      if (boom) throw new Error('わざと')
      return Date.now()
    },
  })
  try {
    a.seq._setRadioBlocked(true)
    boom = true
    const r = await fake.request('POST', `${B}/adapters/auth/actions/clear-radio-block`, { timeoutMs: 2000 })
    boom = false
    assertDenied(r, 401, 'LOGIN_REQUIRED', '断る途中の失敗')
    assert.equal(a.seq.state.radioBlocked, true)
  } finally {
    boom = false
    await dispose()
  }
})

test('editorTokenOf: ヘッダが無い・配列・空白', () => {
  assert.equal(editorTokenOf({ headers: {} }), '')
  assert.equal(editorTokenOf({}), '')
  assert.equal(editorTokenOf({ headers: { 'x-wsuha-editor-token': ['a', 'b'] } }), 'a')
  assert.equal(editorTokenOf({ headers: { 'x-wsuha-editor-token': ' a ' } }), 'a')
})
