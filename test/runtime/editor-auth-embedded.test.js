'use strict'

// Node-RED の認証と Web UI の変更を、本物の Node-RED で確かめる。
// editor-auth.test.js は偽の RED なので、Node-RED の更新で needsPermission や設定の読み方が変わっても見えない。
//
//  - adminAuth: トークンなしは全部 401・全権限と wsuha-broute.write は通る・read は 403・読むのは匿名で 200
//  - 閉じる形: adminAuth と httpAdminRoot: false・エディタを adminAuth 以外の方法で閉じたサーバー（根が別の httpAdminAuth・
//    httpAdminMiddleware と httpAdminRoot: false）
//  - 開く形: red.js の起動の httpNodeAuth・wsuhaBroute.allowAnonymousWrites: true
//  - 埋め込みの形: httpNodeAuth と httpAuth は掛からないので開かない（Basic の真似をしない本物の埋め込み）
//  - 変わらない形: 既定のサーバー・根が同じ httpAdminAuth と httpAdminMiddleware
//  - adminAuth と httpNodeAuth の両方: Basic とトークンの組で通る
//  - 根が同じサーバーの本文の上限・追加の監査に入る利用者
//
// 本物の Node-RED が入っていない環境（ふつうの開発機）では飛ばす。流し方:
//   WSUHA_TEST_NODE_RED=<node-red の入ったディレクトリ> node --test test/runtime/editor-auth-embedded.test.js
//   Node-RED の公式の Docker イメージの中（/usr/src/node-red）では、指定しなくても流れる

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { HOME, skip, until, boot } = require('./embedded-kit')
const { VERIFIED_VERSIONS, DEVICE_DEFAULTS } = require('../../lib/runtime/flow-writer')
const { LOGIN_REQUIRED_MESSAGE, FORBIDDEN_MESSAGE, NO_LOGIN_MESSAGE } = require('../../lib/runtime/editor-auth')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const OTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'
const PW = 'ABCDEF123456'
const LOGIN_PASSWORD = 'test-only-login'
const A = '/wsuha-broute/api/v1'
const SIM_OPTIONS = { pairId: ID.slice(-8), latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, echonetDelayMs: 5 }

const HASH = HOME ? require(require.resolve('bcryptjs', { paths: [HOME] })).hashSync(LOGIN_PASSWORD, 8) : ''
const ADMIN_AUTH = {
  type: 'credentials',
  users: [
    { username: 'admin', password: HASH, permissions: '*' },
    { username: 'webonly', password: HASH, permissions: ['read', 'wsuha-broute.write'] },
    { username: 'viewer', password: HASH, permissions: 'read' },
  ],
}
const BASIC_SETTING = { user: 'edit', pass: HASH }
/** red.js の起動の形（settingsFile を渡すと、embedded-red-server.js が httpAdminAuth と httpNodeAuth の Basic も掛ける）。 */
const RED_JS = { settingsFile: '/test/settings.js' }
const BASIC = { authorization: 'Basic ' + Buffer.from('edit:' + LOGIN_PASSWORD).toString('base64') }
const SSO_MIDDLEWARE = "function (req, res, next) { if (req.headers['x-test-sso'] === 'ok') return next(); res.status(401).end('sso') }"

const FLOWS = [
  { id: 't1', type: 'tab', label: 'A', disabled: false },
  Object.assign({}, DEVICE_DEFAULTS, { id: 'd1', type: 'wsuha-device', role: '電力', mode: 'simulator', deviceKey: 'sim1', simulatorOptions: JSON.stringify(SIM_OPTIONS) }),
]
// 認証情報は環境変数で渡す（管理 API が閉じたサーバーでは、flows_cred.json を試験から作れないため）
const ENV = { WSUHA_BROUTE_ID_SIM1: ID, WSUHA_BROUTE_PASSWORD_SIM1: PW }

/** 立てて、設定ノードが載るまで待つ。headers はどの要求にも付ける（httpNodeAuth の Basic など）。 */
async function start(settings, headers) {
  const s = await boot(FLOWS, { env: ENV, settings })
  // 待ちが切れても子プロセスを止めてから投げる（呼ぶ側の finally は start が返ってから。残すとファイルが終わらない）
  try {
    await until(async () => (await s.j('GET', `${A}/adapters/d1`, undefined, headers)).status === 200, '設定ノード')
  } catch (e) {
    await s.close().catch(() => {})
    throw e
  }
  return s
}

async function loginAs(s, adminRoot, username) {
  const r = await s.j('POST', adminRoot + 'auth/token', { client_id: 'node-red-admin', grant_type: 'password', scope: '', username, password: LOGIN_PASSWORD })
  assert.equal(r.status, 200, r.text)
  return r.body.access_token
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'なし')
const stateOf = (s) => ['flows.json', 'wsuha-broute/settings.json', 'wsuha-broute/credentials/d1.json'].map((n) => sha(s.file(n)))
const token = (t) => ({ 'x-wsuha-editor-token': t })

/** 変更の要求を全部、1 通りずつ（版は今のものを読む。守りより先に版を見ないことも確かめられる）。 */
async function writes(s, headers) {
  const settings = await s.j('GET', `${A}/adapters/d1/settings`, undefined, headers)
  const config = await s.j('GET', `${A}/adapters/d1/config`, undefined, headers)
  assert.equal(settings.status, 200, '読むのは開いている')
  assert.equal(config.status, 200, '読むのは開いている')
  const settingsRev = { 'if-match': `"${settings.body.rev}"` }
  const configRev = { 'if-match': `"${config.body.rev}"` }
  return [
    ['PUT', `${A}/adapters/d1/settings`, { pollIntervalSec: 60 }, settingsRev],
    ['DELETE', `${A}/adapters/d1/settings`, {}, settingsRev],
    ['PUT', `${A}/adapters/d1/config`, { name: '別の名前' }, configRev],
    ['DELETE', `${A}/adapters/d1/config`, {}, configRev],
    ['PUT', `${A}/adapters/d1/credentials`, { routeBId: OTHER_ID, routeBPassword: PW }, {}],
    ['DELETE', `${A}/adapters/d1/credentials`, {}, {}],
    ['POST', `${A}/adapters/d1/actions/stop`, { reason: '試験' }, {}],
    ['POST', `${A}/adapters/d1/diag`, { name: 'ropt' }, {}],
    ['POST', `${A}/adapters`, { role: '動力', mode: 'simulator' }, {}],
  ]
}

async function assertAllWritesRefused(s, headers, status, code, message) {
  const before = stateOf(s)
  for (const [m, url, body, h] of await writes(s, headers)) {
    const r = await s.j(m, url, body, Object.assign({}, h, headers))
    assert.equal(r.status, status, `${m} ${url}: ${r.text}`)
    assert.equal(r.body.error.code, code, `${m} ${url}`)
    assert.equal(r.body.error.message, message, `${m} ${url}`)
  }
  const read = await s.j('GET', `${A}/adapters/d1/read?epcs=E7&maxAgeSec=0`, undefined, Object.assign({ 'x-wsuha-radio': '1' }, headers))
  assert.equal(read.status, status, `電波を使う read: ${read.text}`)
  assert.deepEqual(stateOf(s), before, 'flows.json・settings.json・認証情報は変わらない')
  assert.equal((await s.j('GET', `${A}/adapters/d1`, undefined, headers)).body.overridden.stopped, null, '止まっていない')
}

/** 匿名で開く読み出し。画面の配信と SSE も見る。 */
async function assertReadsOpen(s, headers) {
  for (const p of ['/meta', '/session', '/serialports', '/adapters', '/adapters/d1', '/adapters/d1/values', '/adapters/d1/trend', '/adapters/d1/logs', '/adapters/d1/settings', '/adapters/d1/config', '/adapters/d1/read?epcs=E7']) {
    const r = await s.j('GET', A + p, undefined, headers)
    assert.equal(r.status, 200, `${p}: ${r.text}`)
  }
  assert.equal((await s.j('GET', '/wsuha-broute/ui/', undefined, headers)).status, 200, '画面の配信')
  const ac = new AbortController()
  const r = await fetch(s.base + A + '/stream', { signal: ac.signal, headers })
  assert.equal(r.status, 200, 'SSE')
  assert.match(r.headers.get('content-type'), /text\/event-stream/)
  ac.abort()
}

async function closeAfter(settings, headers, fn) {
  const s = await start(settings, headers)
  try {
    assert.match(s.version, VERIFIED_VERSIONS, 'この試験は確かめた版で流す')
    await fn(s)
  } finally {
    await s.close()
  }
}

test('adminAuth: トークンなしは全部 401・全権限と wsuha-broute.write は通る・read は 403・読むのは匿名で 200', { skip }, async () => {
  // 戻すと落ちるもの: http-api.js の write・configWrite・addWrite から requireLogin を外す・editor-auth.js で X-Wsuha-Editor-Token を Bearer に写さない
  await closeAfter({ adminAuth: ADMIN_AUTH }, undefined, async (s) => {
    await assertAllWritesRefused(s, {}, 401, 'LOGIN_REQUIRED', LOGIN_REQUIRED_MESSAGE)
    await assertReadsOpen(s, {})
    assert.deepEqual((await s.j('GET', A + '/session')).body, { required: true, loggedIn: false, canWrite: false })
    assert.deepEqual((await s.j('GET', A + '/meta')).body.auth, { required: true, available: true, editorPath: '/admin/', nodeRoot: '/' })

    const viewer = await loginAs(s, '/admin/', 'viewer')
    await assertAllWritesRefused(s, token(viewer), 403, 'FORBIDDEN', FORBIDDEN_MESSAGE)
    assert.deepEqual((await s.j('GET', A + '/session', undefined, token(viewer))).body, { required: true, loggedIn: true, canWrite: false })

    const expired = token('no-such-token')
    assert.equal((await s.j('POST', `${A}/adapters/d1/actions/stop`, { reason: '試験' }, expired)).status, 401)
    assert.deepEqual((await s.j('GET', A + '/session', undefined, expired)).body, { required: true, loggedIn: false, canWrite: false })

    for (const name of ['admin', 'webonly']) {
      const t = token(await loginAs(s, '/admin/', name))
      assert.deepEqual((await s.j('GET', A + '/session', undefined, t)).body, { required: true, loggedIn: true, canWrite: true }, name)
      const rev = (await s.j('GET', `${A}/adapters/d1/settings`)).body.rev
      const put = await s.j('PUT', `${A}/adapters/d1/settings`, { pollIntervalSec: name === 'admin' ? 60 : 90 }, Object.assign({ 'if-match': `"${rev}"` }, t))
      assert.equal(put.status, 200, `${name}: ${put.text}`)
    }
  })
})

test('adminAuth と httpAdminRoot: false: 認証の仕組みが無いので、トークンがあっても全部閉じる', { skip }, async () => {
  // 戻すと落ちるもの: editor-auth.js の unusable と「通ったのに req.user が無い」の判定を両方外す
  await closeAfter({ adminAuth: ADMIN_AUTH, httpAdminRoot: false }, undefined, async (s) => {
    await assertAllWritesRefused(s, token('no-such-token'), 401, 'LOGIN_REQUIRED', NO_LOGIN_MESSAGE)
    assert.deepEqual((await s.j('GET', A + '/meta')).body.auth, { required: true, available: false, editorPath: null, nodeRoot: '/' })
    assert.deepEqual((await s.j('GET', A + '/session')).body, { required: true, loggedIn: false, canWrite: false })
  })
})

for (const [what, settings, door] of [
  ['根が別の httpAdminAuth', Object.assign({ httpAdminRoot: '/admin', httpAdminAuth: BASIC_SETTING }, RED_JS), 401],
  ['根が別の httpAdminMiddleware', `{ httpAdminRoot: '/admin', httpAdminMiddleware: ${SSO_MIDDLEWARE} }`, 401],
  ['httpAdminRoot: false', { httpAdminRoot: false }, 404],
]) {
  test(`エディタを別の方法で閉じたサーバー（${what}）: 匿名の変更を全部 401 で断る。読むのは開けておく`, { skip }, async () => {
    // エディタは 401・404 なのに、Web UI だけが匿名で flows.json と認証情報を書けた。
    // 戻すと落ちるもの: editor-auth.js の closedElsewhere を常に false にする
    await closeAfter(settings, undefined, async (s) => {
      assert.equal((await s.j('GET', '/admin/flows')).status, door, '前提: エディタの API は閉じている')
      await assertAllWritesRefused(s, {}, 401, 'LOGIN_REQUIRED', NO_LOGIN_MESSAGE)
      await assertReadsOpen(s, {})
      assert.deepEqual((await s.j('GET', A + '/session')).body, { required: true, loggedIn: false, canWrite: false })
      assert.deepEqual((await s.j('GET', A + '/meta')).body.auth, { required: true, available: false, editorPath: null, nodeRoot: '/' })
    })
  })
}

for (const [what, settings] of [
  ['httpNodeAuth', { httpAdminRoot: false, httpNodeAuth: BASIC_SETTING }],
  ['httpAuth', { httpAdminRoot: false, httpAuth: BASIC_SETTING }],
]) {
  test(`埋め込みのサーバーの ${what} は掛からないので、閉じたままにする。開き方の案内は allowAnonymousWrites だけ`, { skip }, async () => {
    // 掛けるのは red.js だけなのに、書いてあるだけで匿名の変更を開いていた。
    // 戻すと落ちるもの: editor-auth.js の editorGuardedElsewhere で startedByRedJs を見ない
    await closeAfter(Object.assign({ logging: { console: { level: 'warn' } } }, settings), undefined, async (s) => {
      await assertAllWritesRefused(s, {}, 401, 'LOGIN_REQUIRED', NO_LOGIN_MESSAGE)
      await assertReadsOpen(s, {})
      assert.deepEqual((await s.j('GET', A + '/meta')).body.auth, { required: true, available: false, editorPath: null, nodeRoot: '/' })
      assert.match(s.stdout(), /Node-RED の設定に wsuhaBroute: \{ allowAnonymousWrites: true \} を書き/)
      assert.doesNotMatch(s.stdout(), /httpNodeAuth か/)
    })
  })
}

test('red.js で起動した閉じたサーバーは httpNodeAuth で開く（Basic の無い要求は Node-RED が断る）', { skip }, async () => {
  // 戻すと落ちるもの: editor-auth.js の editorGuardedElsewhere で httpNodeAuth を見ない
  await closeAfter(Object.assign({ httpAdminRoot: false, httpNodeAuth: BASIC_SETTING }, RED_JS), BASIC, async (s) => {
    assert.equal((await s.j('GET', A + '/meta')).status, 401, 'Basic が無ければ読むのも閉じる')
    assert.equal((await s.j('PUT', `${A}/adapters/d1/credentials`, { routeBId: OTHER_ID, routeBPassword: PW })).status, 401)
    assert.deepEqual((await s.j('GET', A + '/session', undefined, BASIC)).body, { required: false, loggedIn: false, canWrite: true })
    const rev = (await s.j('GET', `${A}/adapters/d1/config`, undefined, BASIC)).body.rev
    const put = await s.j('PUT', `${A}/adapters/d1/config`, { name: '別の名前' }, Object.assign({ 'if-match': `"${rev}"` }, BASIC))
    assert.equal(put.status, 200, put.text)
  })
})

test('閉じたサーバーは wsuhaBroute.allowAnonymousWrites: true で開く', { skip }, async () => {
  // 戻すと落ちるもの: editor-auth.js の closedElsewhere で allowAnonymousWrites を見ない
  await closeAfter({ httpAdminRoot: false, wsuhaBroute: { allowAnonymousWrites: true } }, undefined, async (s) => {
    assert.deepEqual((await s.j('GET', A + '/session')).body, { required: false, loggedIn: false, canWrite: true })
    const rev = (await s.j('GET', `${A}/adapters/d1/config`)).body.rev
    const put = await s.j('PUT', `${A}/adapters/d1/config`, { name: '別の名前' }, { 'if-match': `"${rev}"` })
    assert.equal(put.status, 200, put.text)
    assert.equal((await s.j('POST', `${A}/adapters`, { role: '動力', mode: 'simulator' })).status, 201)
  })
})

test('既定のサーバー（何も設定しない）は今までどおり、匿名で変更できる', { skip }, async () => {
  // 戻すと落ちるもの: editor-auth.js で required を常に true にする（閉じる判定を広げすぎる）
  await closeAfter({ httpAdminRoot: '/' }, undefined, async (s) => {
    assert.deepEqual((await s.j('GET', A + '/session')).body, { required: false, loggedIn: false, canWrite: true })
    assert.deepEqual((await s.j('GET', A + '/meta')).body.auth, { required: false, available: true, editorPath: '/', nodeRoot: '/' })
    const rev = (await s.j('GET', `${A}/adapters/d1/config`)).body.rev
    assert.equal((await s.j('PUT', `${A}/adapters/d1/config`, { name: '別の名前' }, { 'if-match': `"${rev}"` })).status, 200)
  })
})

for (const [what, settings, headers] of [
  ['httpAdminAuth', Object.assign({ httpAdminRoot: '/', httpAdminAuth: BASIC_SETTING }, RED_JS), BASIC],
  ['httpAdminMiddleware', `{ httpAdminRoot: '/', httpAdminMiddleware: ${SSO_MIDDLEWARE} }`, { 'x-test-sso': 'ok' }],
]) {
  test(`根が同じ ${what} は httpNode にも掛かるので、閉じない`, { skip }, async () => {
    // 戻すと落ちるもの: editor-auth.js の editorGuardedElsewhere で根を比べない（今まで動いていたサーバーが変更できなくなる）
    await closeAfter(settings, headers, async (s) => {
      assert.equal((await s.j('GET', A + '/meta')).status, 401, 'エディタの守りが Web UI にも掛かっている')
      assert.deepEqual((await s.j('GET', A + '/session', undefined, headers)).body, { required: false, loggedIn: false, canWrite: true })
      const rev = (await s.j('GET', `${A}/adapters/d1/config`, undefined, headers)).body.rev
      const put = await s.j('PUT', `${A}/adapters/d1/config`, { name: '別の名前' }, Object.assign({ 'if-match': `"${rev}"` }, headers))
      assert.equal(put.status, 200, put.text)
    })
  })
}

test('adminAuth と httpNodeAuth の両方: Basic とトークンの組で通る。トークンが無ければ 401', { skip }, async () => {
  // Bearer を Authorization に載せると Basic が読めず、パッケージに届く前に 401 になる。
  // 戻すと落ちるもの: 画面からのトークンを Authorization で受ける・editor-auth.js の finally で Authorization を元へ戻さない
  await closeAfter(Object.assign({ adminAuth: ADMIN_AUTH, httpNodeAuth: BASIC_SETTING }, RED_JS), BASIC, async (s) => {
    const t = await loginAs(s, '/admin/', 'admin')
    const rev = (await s.j('GET', `${A}/adapters/d1/config`, undefined, BASIC)).body.rev
    const url = `${A}/adapters/d1/config`
    const noToken = await s.j('PUT', url, { name: '別の名前' }, Object.assign({ 'if-match': `"${rev}"` }, BASIC))
    assert.equal(noToken.status, 401, noToken.text)
    assert.equal(noToken.body.error.code, 'LOGIN_REQUIRED')
    const ok = await s.j('PUT', url, { name: '別の名前' }, Object.assign({ 'if-match': `"${rev}"` }, BASIC, token(t)))
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual((await s.j('GET', A + '/session', undefined, Object.assign({}, BASIC, token(t)))).body, { required: true, loggedIn: true, canWrite: true })
  })
})

test('根が同じサーバーでも本文は 64 KB まで（エディタの body-parser が先に読んでいる）', { skip }, async () => {
  // 戻すと落ちるもの: http-api.js の parseJsonBody の先読みの枝で大きさを見ない（200 で通る）
  await closeAfter({ adminAuth: ADMIN_AUTH, httpAdminRoot: '/' }, undefined, async (s) => {
    const t = token(await loginAs(s, '/', 'admin'))
    const r = await s.j('POST', `${A}/adapters/d1/actions/clear-radio-block`, { pad: 'x'.repeat(100 * 1024) }, t)
    assert.equal(r.status, 422, r.text)
    assert.equal(r.body.error.code, 'VALIDATION')
    assert.match(r.body.error.message, /本文が大きすぎます（64 KB まで）/)
    assert.equal((await s.j('POST', `${A}/adapters/d1/actions/clear-radio-block`, {}, t)).status, 200, '上限の内なら通る')
  })
})

test('監査: アダプタの追加と続く flows.set に、追加した人が残る', { skip }, async () => {
  // flows.set の監査が見るのは setFlows の req で、user だけを渡しても残らない。
  // 戻すと落ちるもの: flow-writer.js の setFlows から req を外す・http-api.js で要求の控えを渡さない
  const settings = { adminAuth: ADMIN_AUTH, logging: { console: { level: 'error', audit: true } } }
  await closeAfter(settings, undefined, async (s) => {
    const t = token(await loginAs(s, '/admin/', 'admin'))
    const r = await s.j('POST', `${A}/adapters`, { role: '動力', mode: 'simulator', routeBId: OTHER_ID, routeBPassword: PW }, t)
    assert.equal(r.status, 201, r.text)
    const events = await until(() => {
      const list = s
        .stdout()
        .split('\n')
        .map((l) => /\[audit\] (\{.*\})/.exec(l))
        .filter(Boolean)
        .map((m) => JSON.parse(m[1]))
      const add = list.find((e) => e.event === 'wsuha-broute.adapter.add')
      const set = list.filter((e) => e.event === 'flows.set').pop()
      return add && set ? { add, set } : null
    }, '監査の行')
    assert.equal(events.add.user.username, 'admin')
    assert.equal(events.add.path, `${A}/adapters`)
    assert.equal(events.add.adapterId, r.body.nodes.deviceId)
    assert.equal(events.set.user.username, 'admin')
    assert.equal(events.set.path, `${A}/adapters`)
    assert.ok(!s.stdout().includes(OTHER_ID) && !s.stdout().includes(PW), '監査に認証情報を入れない')
  })
})
