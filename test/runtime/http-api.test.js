'use strict'

// HTTP API v1（lib/runtime/http-api.js）。
// 偽の RED（httpNode・httpAdmin に get/put/post/delete を記録する偽のルーター）と偽の req/res で、
// 全ルートの正常系と 403（BAD_ORIGIN・READ_ONLY・FORBIDDEN_COMMAND）/404/409/412/415/422/429/500/502/503/504 を確かめる。
// adminAuth があるサーバーの守り（401・403 FORBIDDEN・GET session）は editor-auth.test.js。

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { install, mapError, withTimeout, parseIfMatch, isSameOrigin, isAllowedHost, parseJsonBody, hasRadioHeader } = require('../../lib/runtime/http-api')
const { createRegistry } = require('../../lib/runtime/registry')
const { createSettingsStore } = require('../../lib/runtime/settings-store')
const { createFakeRed, FakeRes, parseSse, waitFor, tmpDir, ID, PW } = require('./fake-red')
const { makeAdapter, connect } = require('./adapter-kit')
const { holdEchonet } = require('../hold-echonet')

const B = '/wsuha-broute/api/v1'
const IDHINT = ID.slice(0, 4) + '…' + ID.slice(-4)
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version
/** 全部のルート。 */
const API_ROUTES = [
  ['GET', B + '/meta'],
  ['GET', B + '/session'],
  ['GET', B + '/adapters'],
  ['GET', B + '/adapters/:id'],
  ['GET', B + '/adapters/:id/values'],
  ['GET', B + '/adapters/:id/trend'],
  ['GET', B + '/adapters/:id/logs'],
  ['GET', B + '/adapters/:id/settings'],
  ['PUT', B + '/adapters/:id/settings'],
  ['DELETE', B + '/adapters/:id/settings'],
  ['POST', B + '/adapters/:id/actions/:action'],
  ['POST', B + '/adapters/:id/diag'],
  ['GET', B + '/stream'],
]

/** 見えたもの（応答・SSE のフレーム）を全部ためて、最後に秘密を探す。 */
const seen = []
function keep(res) {
  seen.push(res.text)
  return res
}

let ctx
before(async () => {
  const fake = createFakeRed()
  const registry = createRegistry()
  const rt = install(fake.RED, {
    registry,
    uiDir: tmpDir('wsuha-ui-'),
    diagIntervalMs: 0,
    timeouts: { terminate: 3000, get: 5000, diag: 3000 },
    sse: { throttleMs: 20, pingMs: 60000, maxAgeMs: 600000 },
  })
  const a = makeAdapter(registry, 'dev-a', { name: '電力メーター' })
  await connect(a.seq)
  ctx = { fake, registry, rt, a }
  ctx.req = async (method, url, p) => keep(await fake.request(method, url, p))
})

after(async () => {
  if (ctx) {
    ctx.rt.hub.dispose()
    await ctx.a.seq.destroy()
  }
})

test('決めたルートが全部 httpNode にあり、httpAdmin には載らない。needsPermission を直に掛けない（失敗を JSON で返すため）', () => {
  for (const [m, p] of API_ROUTES) {
    const r = ctx.fake.routes.find((x) => x.method === m && x.path === p)
    assert.ok(r, `${m} ${p} が登録されている`)
    assert.equal(r.app, 'node', `${m} ${p} は httpNode に載る`)
  }
  const mine = ctx.fake.routes.filter((x) => x.path instanceof RegExp || String(x.path).startsWith('/wsuha-broute/'))
  assert.ok(mine.length >= API_ROUTES.length + 2, '画面（静的ファイル）のルートもある')
  for (const r of mine) {
    assert.equal(r.app, 'node', `${r.method} ${r.path} は httpNode`)
    for (const h of r.handlers) assert.equal(h.permission, undefined, `${r.method} ${r.path} に needsPermission が掛かっている`)
  }
})

test('GET meta: readOnly と auth を返し、user・canWrite は返さない', async () => {
  const res = await ctx.req('GET', B + '/meta')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const m = res.body
  assert.equal(m.apiVersion, 1)
  assert.equal(m.libVersion, PKG_VERSION)
  assert.equal(m.diskVersion, PKG_VERSION, 'ディスクの package.json を読む')
  assert.equal(m.nodeRed, '3.1.3')
  assert.equal(typeof m.startedAt, 'number')
  assert.equal(m.readOnly, false)
  assert.equal(m.editorRoot, '/', 'httpAdminRoot が無ければ /（Node-RED の既定）')
  for (const k of ['user', 'canWrite']) assert.ok(!(k in m), `meta に ${k} がある`)
  assert.deepEqual(m.auth, { required: false, available: true, editorPath: '/', nodeRoot: '/' })
  // configLocked（settings.js の wsuhaBroute.uiConfig === false）
  assert.equal(m.configLocked, false)
  assert.deepEqual(Object.keys(m).sort(), ['addAdapter', 'apiVersion', 'auth', 'configLocked', 'diskVersion', 'editorRoot', 'libVersion', 'nodeRed', 'readOnly', 'startedAt'])
})

test('Meta.editorRoot: settings.js の httpAdminRoot（前後に / を付ける）。false・disableEditor・httpRoot: false なら null', async () => {
  // 12.2。画面の「エディタを開く」は、httpAdminRoot と httpNodeRoot が違うサーバーでも外れないよう、これから作る。
  // 戻すと落ちるもの: service.js の metaOf に editorRoot を入れない・false を null にしない・前後の / をそろえない
  for (const [settings, want] of [
    [{}, '/'],
    [{ httpAdminRoot: '/' }, '/'],
    [{ httpAdminRoot: '/admin/' }, '/admin/'],
    [{ httpAdminRoot: '/admin' }, '/admin/'],
    [{ httpAdminRoot: 'admin' }, '/admin/'],
    [{ httpAdminRoot: '/red', httpNodeRoot: '/' }, '/red/'],
    [{ httpRoot: '/x' }, '/x/'], // red.js と同じく httpAdminRoot が無ければ httpRoot
    [{ httpAdminRoot: false }, null],
    [{ disableEditor: true }, null],
    [{ httpRoot: false }, null],
  ]) {
    const fake = createFakeRed({ settings })
    const rt = install(fake.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-') })
    try {
      const r = await fake.request('GET', B + '/meta')
      assert.equal(r.statusCode, 200, JSON.stringify(settings))
      assert.equal(r.body.editorRoot, want, JSON.stringify(settings))
    } finally {
      rt.hub.dispose()
    }
  }
})

test('GET adapters・adapters/:id・404', async () => {
  // 設定ノードが居ない handle は出さない
  ctx.registry.upsert('orphan')
  const list = await ctx.req('GET', B + '/adapters')
  assert.equal(list.statusCode, 200)
  assert.deepEqual(list.body.items.map((x) => x.id), ['dev-a'])
  assert.equal(list.body.items[0].health.level, 'ok')
  // 12.2: 合計（フローの adapters と同じ関数）。画面の左ペインの合計と同じ規則
  assert.deepEqual(Object.keys(list.body.total).sort(), ['count', 'enabled', 'power', 'staleCount'])
  assert.equal(list.body.total.enabled, 1)
  const one = await ctx.req('GET', B + '/adapters/dev-a')
  assert.equal(one.body.id, 'dev-a')
  assert.equal(one.body.name, '電力メーター')
  assert.equal(one.body.credentials.pairId, ID.slice(-8))
  for (const p of ['/adapters/nope', '/adapters/orphan', '/adapters/nope/values', '/adapters/nope/settings']) {
    const r = await ctx.req('GET', B + p)
    assert.equal(r.statusCode, 404, p)
    assert.equal(r.body.error.code, 'ADAPTER_NOT_FOUND', p)
    assert.match(r.body.error.message, /アダプタが見つかりません/)
  }
  const unknown = await ctx.req('GET', B + '/nothing/here')
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.body.error.code, 'NOT_FOUND')
})

test('GET values・trend・logs', async () => {
  await ctx.a.seq.get([0xe7, 0xe8], 'test')
  const v = await ctx.req('GET', B + '/adapters/dev-a/values')
  assert.equal(v.statusCode, 200)
  assert.ok(v.body.items.find((r) => r.epc === '0xE7'))
  assert.equal(typeof v.body.at, 'number')

  const t = await ctx.req('GET', B + '/adapters/dev-a/trend')
  assert.equal(t.statusCode, 200)
  assert.ok(t.body.series.power.length >= 1, '既定は 1h')
  assert.equal(t.body.to - t.body.from, 3600 * 1000)
  assert.ok(t.body.series.currentR.length >= 1)
  // to と from は同じ応答から取る（2 回呼ぶと、その間に時計が 1 ms 進むことがある）
  const day = (await ctx.req('GET', B + '/adapters/dev-a/trend?range=24h')).body
  assert.equal(day.to - day.from, 24 * 3600 * 1000)
  // Object の持ち物の名前（constructor・toString）も 422（前は RANGES[range] が関数で真になり、from・to が NaN の 200 を返した）
  // 戻すと落ちるもの: service.js の範囲の確かめを hasOwnProperty から RANGES[range] に戻す
  for (const range of ['2h', 'constructor', 'toString', '__proto__']) {
    const bad = await ctx.req('GET', B + '/adapters/dev-a/trend?range=' + range)
    assert.equal(bad.statusCode, 422, range)
    assert.equal(bad.body.error.code, 'VALIDATION', range)
    assert.ok(bad.body.error.details.range, range)
  }

  const logs = await ctx.req('GET', B + '/adapters/dev-a/logs?after=0&limit=5')
  assert.equal(logs.body.items.length, 5)
  assert.deepEqual(logs.body.items.map((r) => r.seq), [1, 2, 3, 4, 5], '古い順')
  assert.equal(logs.body.nextSeq, 5)
  const warn = await ctx.req('GET', B + '/adapters/dev-a/logs?level=warn')
  assert.ok(warn.body.items.every((r) => r.level === 'warn' || r.level === 'error'))
  for (const q of ['after=-1', 'after=x', 'limit=0', 'limit=1001', 'level=debugx']) {
    const r = await ctx.req('GET', B + '/adapters/dev-a/logs?' + q)
    assert.equal(r.statusCode, 422, q)
  }
})

test('settings: GET・PUT（If-Match）・DELETE と、反映（再接続なし）。変えた人は web-ui', async () => {
  const { a, fake } = ctx
  const g = await ctx.req('GET', B + '/adapters/dev-a/settings')
  assert.equal(g.statusCode, 200)
  assert.equal(g.body.rev, '0')
  assert.equal(g.headers.etag, '"0"')
  assert.equal(g.body.fields.pollIntervalSec.source, 'config')
  const reconnects = a.seq.state.counters.reconnects

  // 412: If-Match が無い・違う
  let r = await ctx.req('PUT', B + '/adapters/dev-a/settings', { body: { pollIntervalSec: 60 } })
  assert.equal(r.statusCode, 412)
  assert.equal(r.body.error.code, 'REVISION_MISMATCH')
  r = await ctx.req('PUT', B + '/adapters/dev-a/settings', { body: { pollIntervalSec: 60 }, headers: { 'if-match': '"old"' } })
  assert.equal(r.statusCode, 412)
  // 422
  r = await ctx.req('PUT', B + '/adapters/dev-a/settings', { body: { pollIntervalSec: 5, pollEpcs: ['E2'] }, headers: { 'if-match': '0' } })
  assert.equal(r.statusCode, 422)
  assert.equal(r.body.error.code, 'VALIDATION')
  assert.ok(r.body.error.details.pollIntervalSec && r.body.error.details.pollEpcs)
  assert.equal(a.seq.options.pollIntervalSec, 30, '断ったものは効かせない')
  for (const body of [{ slowIntervalSec: 59 }, { slowIntervalSec: 3601 }, { halfHourIntervalSec: 299 }, { halfHourIntervalSec: 7201 }, { other: 1 }, {}]) {
    const x = await ctx.req('PUT', B + '/adapters/dev-a/settings', { body, headers: { 'if-match': '0' } })
    assert.equal(x.statusCode, 422, JSON.stringify(body))
  }

  // 200
  r = await ctx.req('PUT', B + '/adapters/dev-a/settings', {
    body: { pollIntervalSec: 60, pollEpcs: ['E7', 'E8'], halfHourIntervalSec: 900 },
    headers: { 'if-match': '"0"' },
  })
  assert.equal(r.statusCode, 200, r.text)
  assert.notEqual(r.body.rev, '0')
  assert.equal(r.headers.etag, `"${r.body.rev}"`)
  assert.equal(r.body.fields.pollIntervalSec.source, 'runtime')
  assert.equal(r.body.fields.pollIntervalSec.value, 60)
  assert.equal(r.body.fields.pollIntervalSec.by, 'web-ui', '変えた人は経路')
  assert.deepEqual(r.body.fields.pollEpcs.value, ['0xE7', '0xE8'])
  assert.equal(r.body.fields.halfHourIntervalSec.value, 900)
  assert.equal(a.seq.options.pollIntervalSec, 60, 'sequencer に効いた')
  assert.deepEqual(a.seq.options.pollEpcs, [0xe7, 0xe8])
  assert.equal(a.seq.options.halfHourIntervalSec, 900)
  assert.equal(a.seq.state.counters.reconnects, reconnects, '再接続しない')
  assert.equal(a.seq.isConnected, true)
  const file = path.join(fake.settings.userDir, 'wsuha-broute', 'settings.json')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(disk.adapters['dev-a'].fields.pollIntervalSec.value, 60)
  assert.equal(disk.adapters['dev-a'].fields.pollIntervalSec.configAtSet, 30)
  assert.equal(disk.adapters['dev-a'].updatedBy, 'web-ui')
  const rev1 = r.body.rev

  // null でその項目だけ外す → 設定ノードの値 (30) に戻る
  r = await ctx.req('PUT', B + '/adapters/dev-a/settings', { body: { pollIntervalSec: null }, headers: { 'if-match': rev1 } })
  assert.equal(r.statusCode, 200)
  assert.equal(r.body.fields.pollIntervalSec.source, 'config')
  assert.equal(a.seq.options.pollIntervalSec, 30)
  assert.deepEqual(a.seq.options.pollEpcs, [0xe7, 0xe8], 'ほかの項目はそのまま')

  // DELETE: 全部外す
  r = await ctx.req('DELETE', B + '/adapters/dev-a/settings', { headers: { 'if-match': rev1 } })
  assert.equal(r.statusCode, 412, '古い rev では消せない')
  const cur = (await ctx.req('GET', B + '/adapters/dev-a/settings')).body.rev
  r = await ctx.req('DELETE', B + '/adapters/dev-a/settings', { headers: { 'if-match': cur } })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(a.seq.options.pollEpcs, [0xe7], '設定ノードの値に戻る')
  assert.equal(a.seq.options.halfHourIntervalSec, 1800, '設定ノードに無い項目は既定値に戻る')
  for (const k of Object.keys(r.body.fields)) assert.notEqual(r.body.fields[k].source, 'runtime', k)
  assert.equal(a.seq.state.counters.reconnects, reconnects, '再接続しない')
  const texts = ctx.a.h.logsAfter({ limit: 1000 }).items.map((x) => x.text)
  assert.ok(texts.some((x) => /画面から運用設定を変えました/.test(x)), '経路をログに残す: ' + texts.slice(-5).join(' | '))
  assert.ok(texts.some((x) => /画面から運用設定を全部外しました/.test(x)))
})

test('本文: JSON として読めない・大きすぎるものは 422。先に読まれた本文（httpNodeMiddleware）も使える', async () => {
  const rev = (await ctx.req('GET', B + '/adapters/dev-a/settings')).body.rev
  let r = await ctx.req('PUT', B + '/adapters/dev-a/settings', { rawBody: '{"pollIntervalSec": 6', headers: { 'if-match': rev } })
  assert.equal(r.statusCode, 422, r.text)
  assert.equal(r.body.error.code, 'VALIDATION')
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/stop', { rawBody: JSON.stringify({ reason: 'x'.repeat(70 * 1024) }) })
  assert.equal(r.statusCode, 422, r.text)
  assert.match(r.body.error.message, /大きすぎます/)
  assert.equal(ctx.a.seq.state.overrides.stopped, null, '断ったものは効かせない')
  // 本文の無い操作（Content-Type だけ付ける）は {} とみなす
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/clear-radio-block')
  assert.equal(r.statusCode, 200, r.text)
  // 先に読まれた本文（req.body と req._body）
  r = await ctx.req('PUT', B + '/adapters/dev-a/settings', { parsedBody: { slowIntervalSec: 600 }, headers: { 'if-match': rev } })
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.body.fields.slowIntervalSec.value, 600)
  const rev2 = r.body.rev
  r = await ctx.req('DELETE', B + '/adapters/dev-a/settings', { headers: { 'if-match': rev2 } })
  assert.equal(r.statusCode, 200)
})

test('本文の上限: エディタが先に読み終えた本文にも同じ上限を掛ける（根が同じ既定のサーバー）', async () => {
  // 根が同じサーバーではエディタの body-parser が先に読むので、大きさを見ないと公開した「64 KB まで」が既定のサーバーで嘘になる。
  // 戻すと落ちるもの: http-api.js の parseJsonBody の先読みの枝で大きさを見ない
  const big = { reason: 'x'.repeat(70 * 1024) }
  const tooLarge = (e) => e.status === 422 && e.code === 'VALIDATION' && /本文が大きすぎます（64 KB まで）/.test(e.message)
  await assert.rejects(parseJsonBody({ _body: true, body: big, headers: { 'content-length': String(JSON.stringify(big).length) } }), tooLarge, 'Content-Length があるとき')
  await assert.rejects(parseJsonBody({ _body: true, body: big, headers: {} }), tooLarge, 'chunked で Content-Length が無いとき')
  await assert.rejects(parseJsonBody({ body: big, headers: {} }), tooLarge, '印（_body）が無くても読んであるとき')
  const small = { reason: 'x' }
  assert.equal(await parseJsonBody({ _body: true, body: small, headers: { 'content-length': '13' } }), small, '上限の内ならそのまま使う')
  assert.deepEqual(await parseJsonBody({ _body: true, body: {}, headers: {} }), {})
})

test('本文の上限: 超えたら本文の終わりを待たずに断る（終わらない本文で溜め込まない）', async () => {
  // 戻すと落ちるもの: http-api.js の readBody で上限を見ない（読み終わってからの大きさの検査だけになる）
  const { Readable } = require('node:stream')
  const req = new Readable({ read() {} })
  req.headers = {}
  req.push(Buffer.alloc(70 * 1024, 0x20)) // 64 KB を超える。終わり（push(null)）は来ない
  const t0 = performance.now() // かかった長さは単調な時計で（壁時計は飛ぶことがある）
  await assert.rejects(
    () => withTimeout(parseJsonBody(req), 2000, '本文の読み取り'),
    (e) => e.code === 'VALIDATION' && /大きすぎます/.test(e.message)
  )
  assert.ok(performance.now() - t0 < 1500, '終わりを待たずに断る')
  req.destroy()
})

test('actions: stop・reconnect（409）・start・auto・get・poll・clear-radio-block', async () => {
  const { a } = ctx
  let r = await ctx.req('POST', B + '/adapters/dev-a/actions/stop', { body: {} })
  assert.equal(r.statusCode, 422, '理由は必須')
  assert.ok(r.body.error.details.reason)
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/stop', { body: { reason: 'x'.repeat(201) } })
  assert.equal(r.statusCode, 422)

  r = await ctx.req('POST', B + '/adapters/dev-a/actions/stop', { body: { reason: '点検のため' } })
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.body.ok, true)
  assert.match(r.body.message, /止めました/)
  assert.equal(r.body.adapter.overridden.stopped.reason, '点検のため')
  assert.equal(r.body.adapter.health.level, 'stopped')
  assert.ok(a.h.logsAfter({ limit: 1000 }).items.some((x) => /画面から「停止」を実行しました（理由: 点検のため）/.test(x.text)))

  r = await ctx.req('POST', B + '/adapters/dev-a/actions/reconnect', { body: {} })
  assert.equal(r.statusCode, 409)
  assert.equal(r.body.error.code, 'STOPPED_BY_OVERRIDE')
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/poll')
  assert.equal(r.statusCode, 409)
  assert.equal(r.body.error.code, 'STOPPED_BY_OVERRIDE')

  r = await ctx.req('POST', B + '/adapters/dev-a/actions/start')
  assert.equal(r.statusCode, 200)
  assert.equal(r.body.adapter.overridden.stopped, null, '外部の停止の上書きも外す')
  assert.equal(r.body.adapter.running, true)
  await waitFor(() => a.seq.isConnected, 8000, '繋がり直す')
  await waitFor(() => a.seq._requestDepth === 0 && !a.seq._current, 8000, '接続時の取得')

  r = await ctx.req('POST', B + '/adapters/dev-a/actions/reconnect', { body: { ladder: 4 } })
  assert.equal(r.statusCode, 422)
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/get', { body: { epcs: ['E7', 'E8'] } })
  assert.equal(r.statusCode, 200, r.text)
  assert.deepEqual(r.body.result.map((x) => x.epc), ['0xE7', '0xE8'])
  assert.equal(r.body.result[0].fresh, true)
  for (const body of [{}, { epcs: [] }, { epcs: ['E2'] }, { epcs: ['E7', 'E8', 'E0', 'E3', '80', '88', 'D3'] }, { epcs: ['xyz'] }]) {
    const x = await ctx.req('POST', B + '/adapters/dev-a/actions/get', { body })
    assert.equal(x.statusCode, 422, JSON.stringify(body))
  }
  // 接続直後の「今すぐの取得」（_schedulePoll(0)）が get の後ろに並んでいることがある。
  // 取得の途中に押すと 409 BUSY（次の試験）なので、終わるのを待ってから押す
  await waitFor(() => a.seq._requestDepth === 0 && !a.seq._pending, 8000, '接続直後の取得が終わる')
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/poll')
  assert.equal(r.statusCode, 200, r.text)
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/auto')
  assert.equal(r.statusCode, 200)
  assert.equal(r.body.adapter.overridden.any, false)

  // 送信制限中
  a.seq._setRadioBlocked(true)
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/poll')
  assert.equal(r.statusCode, 409)
  assert.equal(r.body.error.code, 'RADIO_BLOCKED')
  r = await ctx.req('POST', B + '/adapters/dev-a/actions/clear-radio-block')
  assert.equal(r.statusCode, 200)
  assert.match(r.body.message, /解除しました/)
  assert.equal(a.seq.state.radioBlocked, false)

  r = await ctx.req('POST', B + '/adapters/dev-a/actions/nope')
  assert.equal(r.statusCode, 404)
  assert.equal(r.body.error.code, 'NOT_FOUND')

  assert.equal(a.seq.isConnected, true, '後の試験のために繋がったまま')
})

/** 別の RED に 1 台だけ繋いだ状態を作る（共有の台の待ち行列を乱さないため）。 */
async function lonelyAdapter(id, installOpts, redOpts) {
  const fake = createFakeRed(redOpts || {})
  const registry = createRegistry()
  const rt = install(fake.RED, Object.assign({ registry, uiDir: tmpDir('wsuha-ui-') }, installOpts))
  const a = makeAdapter(registry, id, { seq: { sendTimeout: 5000 } })
  await connect(a.seq)
  // 接続直後の「今すぐの取得」（_schedulePoll(0)）が済んで、次の周期（30 秒後）を待つところまで
  await new Promise((r) => setTimeout(r, 100))
  await waitFor(() => a.seq._requestDepth === 0 && !a.seq._pending, 5000, '接続直後の取得')
  const dispose = async () => {
    if (rt.hub) rt.hub.dispose()
    await a.seq.destroy()
  }
  return { fake, rt, a, dispose }
}

test('actions/poll: 取得の途中は 409 BUSY。連打しても取りこぼしに数えず、再接続しない', async () => {
  // 1.5 秒かかる応答の間に何度も押すと、押した数だけ _poll() が積まれ、待ち行列（4）から溢れた分が
  // 「応答なし」に数えられて、3 回で PANA の初回認証からやり直していた
  const { fake, a, dispose } = await lonelyAdapter('spam')
  // 押している間は取得の途中のままにする。応答の遅れ（以前は 800ms）の間に 10 回押し切る形だと、CPU が足りないときに
  // 押し終わる前に応答が届き、途中の回が 200 になる（壁時計の飛びでシミュレーターの応答が早まったときも同じだった）
  const hold = holdEchonet(a.transport)
  try {
    const before = { reconnects: a.seq.state.counters.reconnects, joins: a.seq.state.counters.joins }
    const statuses = []
    let maxMisses = 0
    let maxDepth = 0
    for (let i = 0; i < 10; i++) {
      const r = await fake.request('POST', B + '/adapters/spam/actions/poll')
      statuses.push(r.statusCode + (r.body && r.body.error ? ' ' + r.body.error.code : ''))
      maxMisses = Math.max(maxMisses, a.seq.state.pollMisses)
      maxDepth = Math.max(maxDepth, a.seq._requestDepth)
      await new Promise((res) => setTimeout(res, 20)) // 人が連打する程度の間隔
    }
    assert.ok(hold.count >= 1, '押している間に取得を送った')
    hold.releaseAll() // 押し終わってから応答を届ける
    await waitFor(() => a.seq._requestDepth === 0 && !a.seq._pending, 5000, '取得が終わる')
    const logs = a.h.logsAfter({ after: 0, limit: 1000 }).items.map((x) => x.text)
    assert.equal(maxMisses, 0, '取りこぼしに数えない')
    assert.equal(a.seq.state.counters.reconnects, before.reconnects, '再接続しない')
    assert.equal(a.seq.state.counters.joins, before.joins, 'PANA をやり直さない')
    assert.equal(a.seq.isConnected, true)
    assert.ok(!logs.some((t) => /滞留|連続でありません|再接続します/.test(t)), logs.filter((t) => /滞留|再接続/.test(t)).join(' | '))
    assert.equal(maxDepth, 1, '待ち行列に積むのは 1 本だけ')
    assert.deepEqual(statuses, ['200'].concat(Array(9).fill('409 BUSY')), statuses.join(','))
    const busy = await fake.request('POST', B + '/adapters/spam/actions/poll')
    // 周期の取得（30 秒後）より前なので、終わっていれば受け付ける
    assert.equal(busy.statusCode, 200, busy.text)
    assert.match(busy.body.message, /今すぐ取得します/)
  } finally {
    hold.stop()
    await dispose()
  }
})

test('actions/get と diag の epc: API からの電波の取得は 1 台 1 本（待ち行列を埋めない）', async () => {
  const { fake, a, dispose } = await lonelyAdapter('multi', { timeouts: { get: 300 } })
  try {
    a.transport.config.echonetDelayMs = 150
    const before = a.seq.state.counters.reconnects
    // 複数のタブから同時に押した
    const reqs = []
    for (let i = 0; i < 6; i++) {
      reqs.push(fake.request('POST', B + '/adapters/multi/actions/get', { body: { epcs: ['E7'] } }))
    }
    reqs.push(fake.request('POST', B + '/adapters/multi/diag', { body: { name: 'epc', args: { epcs: ['E8'] } } }))
    const rs = await Promise.all(reqs)
    const got = rs.map((r) => r.statusCode + (r.body && r.body.error ? ' ' + r.body.error.code : ''))
    assert.deepEqual(got, ['200'].concat(Array(6).fill('409 BUSY')), got.join(','))
    assert.match(rs[1].body.error.message, /前の取得がまだ終わっていません/)
    // 断った診断は 3 秒の枠を使わない（すぐ次を受け付ける）
    const diag = await fake.request('POST', B + '/adapters/multi/diag', { body: { name: 'epc', args: { epcs: ['E8'] } } })
    assert.equal(diag.statusCode, 200, diag.text)
    assert.equal(diag.body.result.values[0].epc, '0xE8')

    // 待ちの上限（504）で先に返しても、元の要求が待ち行列に残っている間は次を受け付けない
    a.transport.config.echonetDelayMs = 800
    const slow = await fake.request('POST', B + '/adapters/multi/actions/get', { body: { epcs: ['E7'] } })
    assert.equal(slow.statusCode, 504, slow.text)
    const meanwhile = await fake.request('POST', B + '/adapters/multi/actions/get', { body: { epcs: ['E7'] } })
    assert.equal(meanwhile.statusCode, 409)
    assert.equal(meanwhile.body.error.code, 'BUSY')
    await waitFor(() => a.seq._requestDepth === 0 && !a.seq._pending, 5000, '元の要求が終わる')
    a.transport.config.echonetDelayMs = 5
    const later = await fake.request('POST', B + '/adapters/multi/actions/get', { body: { epcs: ['E7'] } })
    assert.equal(later.statusCode, 200, later.text)
    assert.equal(a.seq.state.pollMisses, 0)
    assert.equal(a.seq.state.counters.reconnects, before, '再接続しない')
  } finally {
    await dispose()
  }
})

test('止めている台へのメーターの取得は 409 STOPPED_BY_OVERRIDE で再開の仕方を案内する（待っても再開しない）', async () => {
  // 止めている間はつながらないのに、503 で「つながるのを待ってから」と案内していた。
  // 戻すと落ちるもの: service.js の requireMeter で overrides.stopped を見ない・requirePort より後に見る
  const t = makeAdapter(ctx.registry, 'held', {})
  await connect(t.seq)
  const refused = (r, what) => {
    assert.equal(r.statusCode, 409, `${what}: ${r.text}`)
    assert.equal(r.body.error.code, 'STOPPED_BY_OVERRIDE', what)
    assert.match(r.body.error.message, /先に「開始」か「自動運転に戻す」を押してください/, what)
  }
  try {
    assert.equal((await ctx.req('POST', B + '/adapters/held/actions/stop', { body: { reason: '点検のため' } })).statusCode, 200)
    refused(await ctx.req('POST', B + '/adapters/held/actions/poll'), 'poll')
    refused(await ctx.req('POST', B + '/adapters/held/actions/get', { body: { epcs: ['E7'] } }), 'get')
    refused(await ctx.req('POST', B + '/adapters/held/diag', { body: { name: 'epc', args: { epcs: ['E7'] } } }), 'diag の epc')
    refused(await ctx.req('GET', B + '/adapters/held/read?epcs=E7&maxAgeSec=0', { headers: { 'x-wsuha-radio': '1' } }), 'read の取り直し')
    t.seq.state.portOpen = false
    refused(await ctx.req('POST', B + '/adapters/held/actions/poll'), 'ポートが閉じていても、先に要るのは再開')
    t.seq.state.portOpen = true
  } finally {
    t.h.release(t.h._owner)
    await t.seq.destroy()
  }
})

test('actions: terminate の待ちの上限は、認証の途中（38 秒ほど）に 504 にならない長さ', async (tc) => {
  // 戻すと落ちるもの: http-api.js の TO.terminate を 20000 に戻す
  const fake = createFakeRed()
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), diagIntervalMs: 0 })
  const t = makeAdapter(registry, 'term-limit', {})
  await connect(t.seq)
  t.seq.terminate = async () => {}
  try {
    const timer = tc.mock.method(globalThis, 'setTimeout')
    const r = await fake.request('POST', B + '/adapters/term-limit/actions/terminate')
    assert.equal(r.statusCode, 200, r.text)
    assert.ok(timer.mock.calls.some((c) => c.arguments[1] === 70000), timer.mock.calls.map((c) => c.arguments[1]).join(','))
  } finally {
    rt.hub.dispose()
    t.h.release(t.h._owner)
    await t.seq.destroy()
  }
})

test('actions: terminate は PANA セッションを終了して止める', async () => {
  // 共有の台を使うと、繋がり直すまで（SKREJOIN の失敗 → 段階 1）後の試験が待たされるので別の台で
  const t = makeAdapter(ctx.registry, 'term', {})
  await connect(t.seq)
  try {
    const r = await ctx.req('POST', B + '/adapters/term/actions/terminate')
    assert.equal(r.statusCode, 200, r.text)
    assert.ok(t.seq.transport.sent.some((c) => /^SKTERM/.test(c)))
    assert.equal(r.body.adapter.health.level, 'stopped')
    assert.equal(r.body.adapter.connected, false)
  } finally {
    t.h.release(t.h._owner)
    await t.seq.destroy()
  }
})

test('diag: 許可リスト・入力の検査・電波を使う取得・失敗の写し方', async () => {
  let r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'info' } })
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.name, 'info')
  assert.equal(typeof r.body.at, 'number')
  const lines = r.body.result.lines
  assert.ok(lines.some((l) => /^EINFO/.test(l)) && lines.some((l) => /^EVER/.test(l)) && lines.some((l) => /^EAPPVER/.test(l)), lines.join(' | '))

  r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'table', args: { which: '1' } } })
  assert.ok(r.body.result.lines.includes('EADDR'))
  r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'ropt' } })
  assert.equal(r.statusCode, 200)
  r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'sreg', args: { reg: 's02' } } })
  assert.equal(r.statusCode, 200)
  assert.ok(r.body.result.lines.some((l) => /^ESREG/.test(l)))
  r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'propmap' } })
  assert.equal(r.statusCode, 200, r.text)
  assert.ok(r.body.result.values.some((v) => v.epc === '0x9F'))
  r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'epc', args: { epcs: ['E7'] } } })
  assert.equal(r.body.result.values[0].epc, '0xE7')

  const cases = [
    [{ name: 'raw', args: { command: 'SKRESET' } }, 403, 'FORBIDDEN_COMMAND'],
    [{ name: 'command' }, 403, 'FORBIDDEN_COMMAND'],
    [{}, 403, 'FORBIDDEN_COMMAND'],
    [{ name: 'sreg', args: { reg: 'S99' } }, 403, 'FORBIDDEN_COMMAND'],
    [{ name: 'sreg', args: { reg: 'S02 21' } }, 422, 'VALIDATION'],
    [{ name: 'sreg', args: { reg: 'S02', value: '21' } }, 422, 'VALIDATION'],
    [{ name: 'table', args: { which: '3' } }, 422, 'VALIDATION'],
    [{ name: 'epc', args: { epcs: ['EC'] } }, 422, 'VALIDATION'],
    [{ name: 'epc', args: { epcs: [] } }, 422, 'VALIDATION'],
  ]
  const sentBefore = ctx.a.seq.transport.sent.length
  for (const [body, status, code] of cases) {
    const x = await ctx.req('POST', B + '/adapters/dev-a/diag', { body })
    assert.equal(x.statusCode, status, JSON.stringify(body))
    assert.equal(x.body.error.code, code, JSON.stringify(body))
  }
  assert.equal(ctx.a.seq.transport.sent.length, sentBefore, '断ったものは何も送らない')

  // アダプタが FAIL を返した（シミュレータの fail.sreg で、SFD の読み出しを FAIL ER06 にする）
  const failCfg = ctx.a.seq.transport.config.fail
  failCfg.sreg = ['SFD']
  try {
    r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'sreg', args: { reg: 'SFD' } } })
  } finally {
    failCfg.sreg = []
  }
  assert.equal(r.statusCode, 502)
  assert.equal(r.body.error.code, 'DEVICE_ERROR')
  // 普段は答える（概要の「送信積算」の出どころ）
  r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'sreg', args: { reg: 'SFD' } } })
  assert.equal(r.statusCode, 200, r.text)
  assert.ok(r.body.result.lines.some((l) => /^ESREG [0-9A-F]{8}$/.test(l)), r.body.result.lines.join(' | '))
  assert.ok(ctx.a.h.logsAfter({ limit: 1000 }).items.some((x) => /画面から診断「sreg」を実行しました/.test(x.text)))
})

test('diag: 504（上限を過ぎた）', async () => {
  const seq = ctx.a.seq
  const orig = seq.diagRead
  seq.diagRead = () => new Promise(() => {}) // 返らない
  try {
    const r = await ctx.req('POST', B + '/adapters/dev-a/diag', { body: { name: 'ropt' } })
    assert.equal(r.statusCode, 504)
    assert.equal(r.body.error.code, 'TIMEOUT')
  } finally {
    seq.diagRead = orig
  }
})

test('diag: 1 台あたり 3 秒に 1 回まで（429 と Retry-After）', async () => {
  const fake = createFakeRed()
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-') })
  const a = makeAdapter(registry, 'rate', {})
  await connect(a.seq)
  try {
    const first = await fake.request('POST', B + '/adapters/rate/diag', { body: { name: 'ropt' } })
    assert.equal(first.statusCode, 200)
    const second = await fake.request('POST', B + '/adapters/rate/diag', { body: { name: 'ropt' } })
    assert.equal(second.statusCode, 429)
    assert.equal(second.body.error.code, 'RATE_LIMITED')
    assert.ok(Number(second.headers['retry-after']) >= 1 && Number(second.headers['retry-after']) <= 3)
  } finally {
    rt.hub.dispose()
    await a.seq.destroy()
  }
})

test('GET read: 取りに行くときは X-Wsuha-Radio: 1 が要る。無ければ電波を使わずに 403 BAD_ORIGIN', async () => {
  // 別のサイトのページの img は Origin も Sec-Fetch-* も付けずに届く（ふつうの http の LAN）。単純な要求で付けられないヘッダで止める。
  // 戻すと落ちるもの: http-api.js の handlers.read から hasRadioHeader の検査を外す
  const { fake, a, dispose } = await lonelyAdapter('radio', { diagIntervalMs: 0 })
  try {
    const url = B + '/adapters/radio/read?epcs=E7&maxAgeSec=0'
    const tx = () => a.seq.transport.sent.length
    const before = tx()
    for (const headers of [{}, { 'x-wsuha-radio': '0' }, { 'x-wsuha-radio': 'yes' }, { 'x-wsuha-radio': '' }]) {
      const r = await fake.request('GET', url, { headers })
      assert.equal(r.statusCode, 403, JSON.stringify(headers))
      assert.equal(r.body.error.code, 'BAD_ORIGIN', JSON.stringify(headers))
      assert.match(r.body.error.message, /X-Wsuha-Radio: 1/, 'スクリプトから呼ぶ人に、付けるヘッダを教える')
    }
    // ヘッダがあっても別のサイトからは断る（fetch で付けると Origin が載る）
    for (const headers of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const r = await fake.request('GET', url, { headers: Object.assign({ 'x-wsuha-radio': '1' }, headers) })
      assert.equal(r.statusCode, 403, JSON.stringify(headers))
      assert.equal(r.body.error.code, 'BAD_ORIGIN', JSON.stringify(headers))
    }
    assert.equal(tx(), before, '断ったものは電波を使わない')

    const ok = await fake.request('GET', url, { headers: { 'x-wsuha-radio': '1' } })
    assert.equal(ok.statusCode, 200, ok.text)
    assert.deepEqual(ok.body.refreshed, ['E7'])
    assert.ok(tx() > before, '電波を使った')

    // 電波を使わない読み出しは、ヘッダが無くても答える
    const sent = tx()
    assert.equal((await fake.request('GET', B + '/adapters/radio/read?epcs=E7')).statusCode, 200)
    const fresh = await fake.request('GET', B + '/adapters/radio/read?epcs=E7&maxAgeSec=3600')
    assert.equal(fresh.statusCode, 200, fresh.text)
    assert.deepEqual(fresh.body.refreshed, [])
    assert.equal(tx(), sent)

    // メーターが持っていない EPC（0x9F に無い）は取りに行かず、missing で返す。ヘッダが無くても電波を使わないので答える
    const none = await fake.request('GET', B + '/adapters/radio/read?epcs=B9,C0&maxAgeSec=0')
    assert.equal(none.statusCode, 200, none.text)
    assert.deepEqual(none.body.refreshed, [])
    assert.equal(none.body.missing.length, 2, JSON.stringify(none.body.missing))
    assert.equal(tx(), sent, '持っていない EPC で電波を使わない')
  } finally {
    await dispose()
  }
})

test('GET read: 取りに行くのは 1 台 3 秒に 1 回まで（429 と Retry-After）。診断と同じ枠で、断ったものは枠を使わない', async () => {
  // 戻すと落ちるもの: http-api.js の handlers.read から requireRadioWindow を外す・枠を診断と分ける・BUSY の前に枠を使う
  let t = 5000000
  const { fake, a, dispose } = await lonelyAdapter('rate-read', { now: () => t })
  try {
    const url = B + '/adapters/rate-read/read?epcs=E7&maxAgeSec=0'
    const headers = { 'x-wsuha-radio': '1' }
    const first = await fake.request('GET', url, { headers })
    assert.equal(first.statusCode, 200, first.text)
    const sent = a.seq.transport.sent.length
    t += 1000
    const second = await fake.request('GET', url, { headers })
    assert.equal(second.statusCode, 429, second.text)
    assert.equal(second.body.error.code, 'RATE_LIMITED')
    assert.match(second.body.error.message, /メーターへの取り直しは 1 台あたり 3 秒に 1 回までです。2 秒待ってください/)
    assert.equal(second.headers['retry-after'], '2')
    assert.equal(a.seq.transport.sent.length, sent, '断ったものは電波を使わない')
    // 診断と同じ枠
    const diag = await fake.request('POST', B + '/adapters/rate-read/diag', { body: { name: 'ropt' } })
    assert.equal(diag.statusCode, 429, diag.text)
    assert.match(diag.body.error.message, /診断は 1 台あたり 3 秒に 1 回までです/)
    t += 2000
    // API の取得が終わっていなければ 409 BUSY で、枠を使わない
    a.transport.config.echonetDelayMs = 150
    const slow = fake.request('POST', B + '/adapters/rate-read/actions/get', { body: { epcs: ['E8'] } })
    await waitFor(() => a.seq.isEchonetBusy(), 2000, '取得が始まる')
    const busy = await fake.request('GET', url, { headers })
    assert.equal(busy.statusCode, 409, busy.text)
    assert.equal(busy.body.error.code, 'BUSY')
    assert.equal((await slow).statusCode, 200)
    a.transport.config.echonetDelayMs = 5
    const third = await fake.request('GET', url, { headers })
    assert.equal(third.statusCode, 200, third.text)
  } finally {
    await dispose()
  }
})

test('GET read: EPC を頼んで取り直すのは 1 回 6 個まで（超えたら 422）。定期取得の値を全部取り直すときは数を問わない', async () => {
  // 1 回の GET で Get が 10 本飛び、周期の取得と待ち行列を取り合っていた。
  // 定期取得の値が 7 個以上でも、頼まずに取り直すときは 422 にしない（画面の値の取り直しが効かなくなる）。
  // 戻すと落ちるもの: http-api.js の上限の検査を外す・rq.epcs を見ずに stale の数だけで断る
  const { fake, a, dispose } = await lonelyAdapter('many', { diagIntervalMs: 0 })
  try {
    const headers = { 'x-wsuha-radio': '1' }
    const sent = a.seq.transport.sent.length
    const seven = await fake.request('GET', B + '/adapters/many/read?epcs=E7,E8,E0,E3,80,88,D3&maxAgeSec=0', { headers })
    assert.equal(seven.statusCode, 422, seven.text)
    assert.equal(seven.body.error.code, 'VALIDATION')
    assert.match(seven.body.error.details.epcs, /1 回に 6 個まで/)
    assert.equal(a.seq.transport.sent.length, sent, '断ったものは電波を使わない')
    const six = await fake.request('GET', B + '/adapters/many/read?epcs=E7,E8,E0,E3,80,88&maxAgeSec=0', { headers })
    assert.equal(six.statusCode, 200, six.text)
    assert.equal(six.body.refreshed.length, 6)

    // 頼んだ数でなく、取り直す数で数える（7 個を頼んでも、古いものが 6 個以下なら通る）
    const mostly = await fake.request('GET', B + '/adapters/many/read?epcs=E7,E8,E0,E3,80,88,97&maxAgeSec=3600', { headers })
    assert.equal(mostly.statusCode, 200, mostly.text)
    assert.deepEqual(mostly.body.refreshed, ['97'])

    a.seq.options.pollEpcs = [0xe7, 0xe8, 0xe0, 0xe3, 0x80, 0x88]
    a.seq.options.slowEpcs = [0xd3, 0xd7]
    const all = await fake.request('GET', B + '/adapters/many/read?maxAgeSec=0', { headers })
    assert.equal(all.statusCode, 200, all.text)
    assert.ok(all.body.refreshed.length >= 7, all.body.refreshed.join(','))
  } finally {
    await dispose()
  }
})

test('hasRadioHeader（純関数）', () => {
  assert.equal(hasRadioHeader({ headers: { 'x-wsuha-radio': '1' } }), true)
  assert.equal(hasRadioHeader({ headers: { 'x-wsuha-radio': ' 1 ' } }), true)
  assert.equal(hasRadioHeader({ headers: { 'x-wsuha-radio': '0' } }), false)
  assert.equal(hasRadioHeader({ headers: {} }), false)
  assert.equal(hasRadioHeader({}), false)
})

test('lib/runtime と nodes は sequencer の非公開の項目を直に触らない', () => {
  // 中の積み方を変えても公開の面の意味を保てば外は壊れない。直に触ると、変えたときに緑のまま壊れる。
  // 戻すと落ちるもの: http-api.js の seq.isEchonetBusy() を seq._pending に戻す
  const pkg = path.join(__dirname, '..', '..')
  for (const dir of ['lib/runtime', 'nodes']) {
    for (const name of fs.readdirSync(path.join(pkg, dir))) {
      if (!name.endsWith('.js')) continue
      const hits = fs.readFileSync(path.join(pkg, dir, name), 'utf8').match(/\bseq\._[a-zA-Z]/g)
      assert.equal(hits, null, `${dir}/${name}`)
    }
  }
})

test('409 DISABLED・503 PORT_DOWN', async () => {
  const off = makeAdapter(ctx.registry, 'off', { meta: { enabled: false }, attach: false })
  let r = await ctx.req('POST', B + '/adapters/off/actions/start')
  assert.equal(r.statusCode, 409)
  assert.equal(r.body.error.code, 'DISABLED')
  r = await ctx.req('GET', B + '/adapters/off')
  assert.equal(r.body.health.level, 'disabled')
  await off.seq.destroy()

  // ポートが開いていない
  const down = makeAdapter(ctx.registry, 'down', {})
  r = await ctx.req('POST', B + '/adapters/down/diag', { body: { name: 'info' } })
  assert.equal(r.statusCode, 503)
  assert.equal(r.body.error.code, 'PORT_DOWN')
  r = await ctx.req('POST', B + '/adapters/down/actions/terminate')
  assert.equal(r.statusCode, 503)
  assert.equal(r.body.error.code, 'PORT_DOWN')
  r = await ctx.req('POST', B + '/adapters/down/actions/get', { body: { epcs: ['E7'] } })
  assert.equal(r.statusCode, 503)
  down.h.release(down.h._owner)
  await down.seq.destroy()
})

test('ハンドラの例外は 500 の JSON にして返し、プロセスを落とさない', async () => {
  const h = ctx.a.h
  const orig = h.inspect
  h.inspect = () => {
    throw new Error('わざと')
  }
  try {
    const r = await ctx.req('GET', B + '/adapters/dev-a')
    assert.equal(r.statusCode, 500)
    assert.equal(r.body.error.code, 'INTERNAL')
    assert.match(r.body.error.message, /内部エラー/)
    assert.ok(!/わざと/.test(r.text), '内部の文言は返さない（ログにだけ出す）')
    assert.ok(ctx.fake.logs.some(([l, t]) => l === 'error' && /わざと/.test(t)))
  } finally {
    h.inspect = orig
  }
})

test('SSE: ヘッダ・hello・初めの一覧・log・measurement・adapter・settings', async () => {
  const { a } = ctx
  const s = ctx.fake.openStream(B + '/stream?adapter=dev-a&logs=1')
  await s.done
  assert.equal(s.res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(s.res.headers['cache-control'], 'no-cache, no-transform')
  assert.equal(s.res.headers['x-accel-buffering'], 'no')
  assert.equal(s.res.flushed, true, 'flushHeaders を呼ぶ')
  let frames = parseSse(s.res.text)
  assert.equal(frames[0].event, 'hello')
  assert.equal(typeof frames[0].data.serverTime, 'number')
  assert.equal(typeof frames[0].data.seq, 'number')
  assert.equal(frames[1].event, 'adapters')
  assert.equal(frames[2].event, 'adapter')
  assert.equal(frames[2].data.id, 'dev-a')

  a.h.log('info', 'SSE の試験の行')
  await a.seq.get([0xe7], 'test')
  await waitFor(() => /event: adapter\n/.test(s.res.text.split('SSE の試験の行')[1] || ''), 3000, '変化のあとの adapter')
  frames = parseSse(s.res.text)
  const log = frames.find((f) => f.event === 'log' && f.data.text === 'SSE の試験の行')
  assert.ok(log && typeof log.id === 'number' && typeof log.data.seq === 'number')
  const m = frames.find((f) => f.event === 'measurement')
  assert.ok(m, 'measurement が届く')
  assert.equal(m.data.adapterId, 'dev-a')
  assert.equal(m.data.items[0].epc, '0xE7')
  const ids = frames.filter((f) => f.id !== undefined).map((f) => f.id)
  assert.deepEqual(ids, ids.slice().sort((x, y) => x - y), 'id は通し番号')

  // settings
  const rev = (await ctx.req('GET', B + '/adapters/dev-a/settings')).body.rev
  await ctx.req('PUT', B + '/adapters/dev-a/settings', { body: { slowIntervalSec: 600 }, headers: { 'if-match': rev } })
  // （PUT の前にも、Settings の中身が初めて分かったときの settings が届くことがある。PUT のものを探す）
  const fromPut = (f) => f.event === 'settings' && f.data.settings.fields.slowIntervalSec.source === 'runtime'
  await waitFor(() => parseSse(s.res.text).some(fromPut), 2000, 'settings')
  const st = parseSse(s.res.text).find(fromPut)
  assert.equal(st.data.adapterId, 'dev-a')
  assert.equal(st.data.settings.fields.slowIntervalSec.value, 600)
  assert.equal(st.data.settings.fields.slowIntervalSec.by, 'web-ui')
  const rev2 = (await ctx.req('GET', B + '/adapters/dev-a/settings')).body.rev
  await ctx.req('DELETE', B + '/adapters/dev-a/settings', { headers: { 'if-match': rev2 } })

  seen.push(s.res.text)
  s.req.emit('close')
  assert.equal(s.res.ended, true)
})

test('SSE: ほかの台の measurement と、頼んでいない log は送らない', async () => {
  const other = makeAdapter(ctx.registry, 'other', {})
  const s = ctx.fake.openStream(B + '/stream?adapter=other')
  await s.done
  ctx.a.h.log('info', '別の台の行')
  other.h.log('info', 'logs=1 ではないので届かない')
  ctx.a.seq.emit('measurement', { ts: Date.now(), values: [{ epc: 0xe7, value: 1, name: 'x', display: '1 W' }] })
  await new Promise((r) => setTimeout(r, 50))
  const frames = parseSse(s.res.text)
  assert.ok(!frames.some((f) => f.event === 'log'), 'log は logs=1 のときだけ')
  assert.ok(!frames.some((f) => f.event === 'measurement'), 'measurement は ?adapter= の 1 台だけ')
  assert.ok(frames.some((f) => f.event === 'adapters'), '一覧は全員に送る')
  s.req.emit('close')
  other.h.release(other.h._owner)
  await other.seq.destroy()
})

test('SSE: Last-Event-ID より新しいものを再送し、リングに無ければ reset', async () => {
  const hub = ctx.rt.hub
  const s1 = ctx.fake.openStream(B + '/stream?adapter=dev-a&logs=1')
  await s1.done
  ctx.a.h.log('info', '再送 1')
  ctx.a.h.log('info', '再送 2')
  const got = parseSse(s1.res.text).filter((f) => f.event === 'log')
  const firstId = got.find((f) => f.data.text === '再送 1').id
  s1.req.emit('close')

  const s2 = ctx.fake.openStream(B + '/stream?adapter=dev-a&logs=1', { headers: { 'last-event-id': String(firstId) } })
  await s2.done
  const again = parseSse(s2.res.text)
  assert.equal(again[0].event, 'hello')
  assert.ok(again.some((f) => f.event === 'log' && f.data.text === '再送 2'), '取りこぼしを再送する')
  assert.ok(!again.some((f) => f.event === 'log' && f.data.text === '再送 1'), '受け取り済みは送らない')
  assert.ok(!again.some((f) => f.event === 'adapters' && f.id === undefined), '繋ぎ直しでは初めの一覧を送らない')
  s2.req.emit('close')

  for (const last of [String(hub.seq + 100), '1']) {
    const s3 = ctx.fake.openStream(B + '/stream?adapter=dev-a', { headers: { 'last-event-id': last } })
    await s3.done
    const f3 = parseSse(s3.res.text)
    assert.equal(f3[1].event, 'reset', `Last-Event-ID=${last} は再送できない`)
    s3.req.emit('close')
  }
  // ?adapter= の台が無ければ 404
  const r = await ctx.req('GET', B + '/stream?adapter=nope')
  assert.equal(r.statusCode, 404)
  assert.equal(r.body.error.code, 'ADAPTER_NOT_FOUND')
})

test('SSE: ping・最長の時間・Node-RED の停止で閉じる・接続を漏らさない', async () => {
  const fake = createFakeRed({ settings: {} })
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), sse: { pingMs: 20, maxAgeMs: 150, throttleMs: 10 } })
  try {
    const s = fake.openStream(B + '/stream')
    await s.done
    await waitFor(() => /: ping\n\n/.test(s.res.text), 1000, 'ping')
    await waitFor(() => s.res.ended, 2000, '最長の時間で閉じる')
    assert.equal(rt.hub.connections, 0)

    const s2 = fake.openStream(B + '/stream')
    const s3 = fake.openStream(B + '/stream')
    await Promise.all([s2.done, s3.done])
    assert.equal(rt.hub.connections, 2)
    fake.events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop', deploy: true } })
    assert.equal(rt.hub.connections, 2, 'デプロイの停止では閉じない')
    fake.events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop' } })
    assert.equal(rt.hub.connections, 0, 'Node-RED が止まるときは全部閉じる')
    assert.ok(s2.res.ended && s3.res.ended)

    const s4 = fake.openStream(B + '/stream')
    await s4.done
    s4.req.emit('close')
    assert.equal(rt.hub.connections, 0, '相手が閉じたら片付ける')
  } finally {
    rt.hub.dispose()
  }
})

test('SSE: 送り残しが多すぎる接続は切る', async () => {
  const fake = createFakeRed({ settings: {} })
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), sse: { maxBufferBytes: 10 } })
  try {
    const s = fake.openStream(B + '/stream')
    await s.done
    assert.equal(s.res.ended, false)
    s.res.writableLength = 11 // 相手が読まない
    rt.hub.publish('adapters', null, { items: [] })
    assert.equal(s.res.ended, true)
    assert.equal(rt.hub.connections, 0)
  } finally {
    rt.hub.dispose()
  }
})

test('SSE: 再送の途中で溢れて閉じた接続に、タイマーを張らない（消す人がいないまま conn と res を握り続けない）', async () => {
  // 戻すと落ちるもの: sse.js の handle からタイマーの前の if (conn.closed) return conn を外す
  const fake = createFakeRed({ settings: {} })
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), sse: { maxBufferBytes: 10, maxAgeMs: 600000, pingMs: 60000 } })
  const started = []
  const realInterval = global.setInterval
  const realTimeout = global.setTimeout
  try {
    rt.hub.publish('adapters', null, { items: [] })
    rt.hub.publish('adapters', null, { items: [] })
    const res = new FakeRes()
    res.write = function (chunk) {
      FakeRes.prototype.write.call(this, chunk)
      this.writableLength = 100 // 相手が読まない
      return true
    }
    global.setInterval = (fn, ms, ...rest) => {
      if (ms === 60000) started.push('ping')
      return realInterval(fn, ms, ...rest)
    }
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms === 600000) started.push('maxAge')
      return realTimeout(fn, ms, ...rest)
    }
    const conn = rt.hub.handle({}, res, { adapterId: null, logs: false, lastEventId: '0' })
    assert.equal(conn.closed, true, '前提: 再送で溢れて閉じた')
    assert.deepEqual(started, [], '閉じたあとにタイマーを張らない')
    assert.equal(rt.hub.connections, 0)
    assert.deepEqual(rt.hub.clients(), {})
  } finally {
    global.setInterval = realInterval
    global.setTimeout = realTimeout
    rt.hub.dispose()
  }
})

// --- SSE の本数の上限 ---------------------------------------------------------

/** SSE だけを見る組み（ほかの試験の接続を数えないように、別の RED に載せる）。 */
function sseRig(settings, sse) {
  const fake = createFakeRed({ settings })
  const rt = install(fake.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-'), sse: Object.assign({ pingMs: 60000, maxAgeMs: 600000 }, sse) })
  const open = (ip) => fake.openStream(B + '/stream', ip ? { ip } : undefined)
  return { fake, rt, open }
}

/** 本数の上限で断られたことを見る。SSE を始めないので、本文は JSON で、event-stream のヘッダは付かない。 */
async function assertTooMany(s, want) {
  await s.done
  assert.equal(s.res.statusCode, 503, s.res.text)
  assert.equal(s.res.headers['retry-after'], '30')
  assert.equal(s.res.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(s.res.text)
  assert.equal(body.error.code, 'TOO_MANY_STREAMS')
  assert.match(body.error.message, want)
}

test('SSE の本数: 接続元ごとの上限を超えたら 503 TOO_MANY_STREAMS と Retry-After: 30。閉じると次が通る', async () => {
  // 戻すと落ちるもの: sse.js の handle で mine >= o.maxPerClient を見ない・閉じたときに perClient を減らさない・Retry-After を付けない
  const { rt, open } = sseRig({ wsuhaBroute: { sse: { maxPerClient: 2 } } })
  try {
    const a = open('10.0.0.1')
    const b = open('10.0.0.1')
    await a.done
    await b.done
    assert.equal(a.res.statusCode, 200)
    assert.equal(b.res.statusCode, 200)
    await assertTooMany(open('10.0.0.1'), /2 本まで/)
    const other = open('10.0.0.2')
    await other.done
    assert.equal(other.res.statusCode, 200, '別の接続元は数えない')
    a.req.emit('close')
    const next = open('10.0.0.1')
    await next.done
    assert.equal(next.res.statusCode, 200, '1 本閉じたら通る')
  } finally {
    rt.hub.dispose()
  }
})

test('SSE の本数: 全体の上限を超えたら、接続元が別でも 503 TOO_MANY_STREAMS', async () => {
  // 戻すと落ちるもの: sse.js の handle で conns.size >= o.maxConnections を見ない
  const { rt, open } = sseRig({ wsuhaBroute: { sse: { maxConnections: 2 } } })
  try {
    for (const ip of ['10.0.0.1', '10.0.0.2']) {
      const s = open(ip)
      await s.done
      assert.equal(s.res.statusCode, 200)
    }
    await assertTooMany(open('10.0.0.3'), /全体で 2 本まで/)
  } finally {
    rt.hub.dispose()
  }
})

test('SSE の本数: settings.js の値は 1〜1000 の整数だけが効き、0・1001・文字列は既定の 8 本のまま', async () => {
  // 戻すと落ちるもの: http-api.js の sseLimitsFrom で範囲と整数を見ない（0 で全部断る・文字列で比べられずに上限が無くなる）
  for (const v of [0, 1001, '2', 2.5, -1]) {
    const { rt, open } = sseRig({ wsuhaBroute: { sse: { maxPerClient: v } } })
    try {
      for (let i = 0; i < 8; i++) {
        const s = open('10.0.0.1')
        await s.done
        assert.equal(s.res.statusCode, 200, `${v}: ${i + 1} 本目`)
      }
      await assertTooMany(open('10.0.0.1'), /8 本まで/)
    } finally {
      rt.hub.dispose()
    }
  }
})

test('flows:started で、フローから消えた設定ノードの handle を片付ける', async () => {
  const h = ctx.registry.upsert('gone')
  const owner = {}
  h.claim(owner, { meta: { name: 'gone' } })
  h.release(owner, true)
  ctx.fake.events.emit('flows:started', {})
  assert.equal(ctx.registry.get('gone'), null)
  assert.ok(ctx.registry.get('dev-a'), '居るものは残す')
})

/** 消した台の記録の片付けを見るための組み（store.forget の呼び出しを控える）。 */
function orphanRig(eachNode) {
  const fake = createFakeRed()
  const dir = tmpDir('wsuha-store-')
  const base = createSettingsStore({ file: path.join(dir, 'settings.json') })
  const forgotten = []
  const store = Object.assign({}, base, {
    forget(id) {
      forgotten.push(id)
      delete base.load().adapters[id]
    },
  })
  const rt = install(fake.RED, { registry: createRegistry(), store, eachNode, uiDir: tmpDir('wsuha-ui-') })
  const warns = () => fake.logs.filter(([l, t]) => l === 'warn' && /フローに無い設定ノード/.test(t)).map(([, t]) => t)
  return { fake, rt, base, forgotten, warns }
}

test('消した台: 足した印だけの記録は「値が残っている」と言わず、フローが見えていれば片付ける', async () => {
  // 足した台をエディタで消すのが正規の手順。値の無い記録を数えると、再起動のたびに誤った warn が出続ける。
  // 戻すと落ちるもの: http-api.js の warnOrphans で hasSavedValues の絞り込みを外す・store.forget を呼ばない
  const { fake, rt, base, forgotten, warns } = orphanRig((cb) => cb({ id: 'live', type: 'wsuha-device' }))
  try {
    base.markCreated('empty', { by: 'web-ui', brouteId: 'b1', tabId: 't1' })
    base.markCreated('live', { by: 'web-ui', brouteId: 'b2', tabId: 't1' })
    fake.events.emit('flows:started', {})
    assert.deepEqual(warns(), [], '値の無い記録は知らせない')
    assert.deepEqual(forgotten, ['empty'], 'フローに無い、値の無い記録だけを片付ける')
    assert.deepEqual(base.ids(), ['live'])
  } finally {
    rt.hub.dispose()
  }
})

test('消した台: 値のある記録は残して知らせ、同じ顔ぶれでは繰り返さない', async () => {
  // 戻すと落ちるもの: http-api.js の warnOrphans で値のある記録まで片付ける
  const { fake, rt, base, forgotten, warns } = orphanRig((cb) => cb({ id: 'live', type: 'wsuha-device' }))
  try {
    base.markCreated('kept', { by: 'web-ui', brouteId: 'b1', tabId: 't1' })
    base.update('kept', { changes: { pollIntervalSec: 60 }, by: 'web-ui', configValues: {}, ifMatch: base.rev('kept') })
    base.updateConfig('kept2', { changes: { name: '残す台' }, by: 'web-ui', configValues: {}, ifMatch: base.configRev('kept2') })
    fake.events.emit('flows:started', {})
    fake.events.emit('flows:started', {})
    assert.deepEqual(forgotten, [])
    assert.equal(warns().length, 1, warns().join(' | '))
    assert.match(warns()[0], /2 台分/)
    assert.match(warns()[0], /運用設定と接続の設定 2 件/)
    // settings.json は読んだ内容をメモリに持って全部を書き直すので、動いている間に手で消しても次の保存で戻る
    assert.match(warns()[0], /Node-RED を止めてから/, '消す手順は止めてから')
    assert.match(warns()[0], /settings\.json は、動いている間に消しても次の保存で戻ります/)
  } finally {
    rt.hub.dispose()
  }
})

test('消した台: サブフローの中の台（動くときの id が eachNode に無い）を、フローに無いと言わず、片付けない', async () => {
  // eachNode にはテンプレートの id しか出ないので、動いている台の値を「要らなければ消して」と勧めていた。
  // 戻すと落ちるもの: http-api.js の flowDevices で、complete のときに今いる台を足さない
  const fake = createFakeRed()
  const registry = createRegistry()
  const base = createSettingsStore({ file: path.join(tmpDir('wsuha-store-'), 'settings.json') })
  const forgotten = []
  const store = Object.assign({}, base, {
    forget(id) {
      forgotten.push(id)
    },
  })
  const eachNode = (cb) => cb({ id: 'dInSubflow', type: 'wsuha-device' })
  const rt = install(fake.RED, { registry, store, eachNode, uiDir: tmpDir('wsuha-ui-') })
  try {
    registry.upsert('inst1-dInSubflow').claim({ id: 'inst1-dInSubflow' }, { meta: { name: 'x' } })
    registry.upsert('inst2-dInSubflow').claim({ id: 'inst2-dInSubflow' }, { meta: { name: 'y' } })
    base.update('inst1-dInSubflow', { changes: { pollIntervalSec: 60 }, by: 'web-ui', configValues: {}, ifMatch: base.rev('inst1-dInSubflow') })
    base.markCreated('inst2-dInSubflow', { by: 'web-ui', brouteId: 'b1', tabId: 't1' })
    // 消した台は今までどおり数える
    base.update('gone', { changes: { pollIntervalSec: 60 }, by: 'web-ui', configValues: {}, ifMatch: base.rev('gone') })
    fake.events.emit('flows:started', {})
    assert.deepEqual(forgotten, [], '動いている台の記録を片付けない')
    const warns = fake.logs.filter(([l, t]) => l === 'warn' && /フローに無い設定ノード/.test(t)).map(([, t]) => t)
    assert.equal(warns.length, 1, warns.join(' | '))
    assert.match(warns[0], /1 台分/)
    assert.match(warns[0], /id: gone）/)
  } finally {
    rt.hub.dispose()
  }
})

test('消した台: フローが見えていないときは、記録を片付けない', async () => {
  // eachNode が動かないと、registry に居る台しか分からない（フローにある台の記録を消してしまう）。
  // 戻すと落ちるもの: http-api.js の warnOrphans で complete を見ない
  for (const eachNode of [() => {}, () => { throw new Error('わざと') }]) {
    const { fake, rt, base, forgotten } = orphanRig(eachNode)
    try {
      base.markCreated('maybe', { by: 'web-ui', brouteId: 'b1', tabId: 't1' })
      fake.events.emit('flows:started', {})
      assert.deepEqual(forgotten, [])
      assert.deepEqual(base.ids(), ['maybe'])
    } finally {
      rt.hub.dispose()
    }
  }
})

// ---------------------------------------------------------------------------
//  書き込みの守り: 415 → BAD_ORIGIN → READ_ONLY（adminAuth があるときの認証は editor-auth.test.js）
// ---------------------------------------------------------------------------

/** 書き込みのルートを 1 通りずつ（どれも効いたかを後で見られるもの）。 */
function writesFor(id, rev) {
  return [
    ['POST', B + `/adapters/${id}/actions/clear-radio-block`, undefined],
    ['POST', B + `/adapters/${id}/actions/stop`, { reason: '別のサイトから' }],
    ['POST', B + `/adapters/${id}/diag`, { name: 'ropt' }],
    ['PUT', B + `/adapters/${id}/settings`, { pollIntervalSec: 60 }, { 'if-match': rev }],
    ['DELETE', B + `/adapters/${id}/settings`, undefined, { 'if-match': rev }],
  ]
}

/** 書き込みがどれも効いていないこと。 */
async function assertNothingWritten(fake, a, id, rev, what) {
  assert.equal(a.seq.state.radioBlocked, true, what + ': 送信制限の解除は効いていない')
  assert.equal(a.seq.state.overrides.stopped, null, what + ': 停止は効いていない')
  assert.equal(a.seq.options.pollIntervalSec, 30, what + ': 運用設定は効いていない')
  assert.equal((await fake.request('GET', B + `/adapters/${id}/settings`)).body.rev, rev, what + ': 保存していない')
  assert.ok(!a.seq.transport.sent.some((c) => /^ROPT/.test(c)), what + ': 診断を送っていない')
}

test('415: 書き込みは Content-Type: application/json が要る（フォーム・text/plain の別サイトからの送信を断る）', async () => {
  // フォームや text/plain の POST はプリフライト無しで別のサイトから送れる。
  // 戻すと落ちるもの: http-api.js の書き込みのルートから requireJson を外す
  const fake = createFakeRed()
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), diagIntervalMs: 0 })
  const a = makeAdapter(registry, 'csrf', {})
  try {
    a.seq._setRadioBlocked(true)
    const rev = (await fake.request('GET', B + '/adapters/csrf/settings')).body.rev
    const bad = [null, 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', '']
    for (const [m, url, body, headers] of writesFor('csrf', rev)) {
      for (const ct of bad) {
        const r = await fake.request(m, url, { body, headers: Object.assign({ 'content-type': ct }, headers) })
        assert.equal(r.statusCode, 415, `${m} ${url} Content-Type=${ct}`)
        assert.equal(r.body.error.code, 'UNSUPPORTED_MEDIA_TYPE', `${m} ${url} Content-Type=${ct}`)
        assert.match(r.body.error.message, /application\/json/)
        assert.equal(r.headers['cache-control'], 'no-store')
      }
    }
    await assertNothingWritten(fake, a, 'csrf', rev, '415')

    // application/json（charset 付き・大文字）なら通る
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
      a.seq._setRadioBlocked(true)
      const r = await fake.request('POST', B + '/adapters/csrf/actions/clear-radio-block', { headers: { 'content-type': ct } })
      assert.equal(r.statusCode, 200, `${ct}: ${r.text}`)
      assert.equal(a.seq.state.radioBlocked, false)
    }
    // 読み出し（GET）と SSE には掛けない
    const g = await fake.request('GET', B + '/adapters/csrf', { headers: { 'content-type': 'text/plain' } })
    assert.equal(g.statusCode, 200)
    const s = fake.openStream(B + '/stream?adapter=csrf')
    await s.done
    assert.equal(s.res.headers['content-type'], 'text/event-stream; charset=utf-8')
    s.req.emit('close')
  } finally {
    rt.hub.dispose()
    await a.seq.destroy()
  }
})

test('403 BAD_ORIGIN: Origin があって Host と同じオリジンでなければ断る。Origin が無ければ通す', async () => {
  // 戻すと落ちるもの: http-api.js の書き込みのルートから requireSameOrigin を外す
  // （example.test はリバースプロキシの公開名の例。Host の許可リスト（BAD_HOST）に足しておく）
  const fake = createFakeRed({ settings: { wsuhaBroute: { allowedHosts: ['example.test'] } } })
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), diagIntervalMs: 0 })
  const a = makeAdapter(registry, 'origin', {})
  try {
    a.seq._setRadioBlocked(true)
    const rev = (await fake.request('GET', B + '/adapters/origin/settings')).body.rev
    const foreign = [
      'http://evil.example',
      'http://evil.example:1880',
      'http://127.0.0.1:1881', // ポートが違う
      'https://127.0.0.1:1880', // スキームが違う
      'http://127.0.0.2:1880',
      'null', // サンドボックスの iframe・file://
      'not a url',
    ]
    for (const [m, url, body, headers] of writesFor('origin', rev)) {
      for (const origin of foreign) {
        const r = await fake.request(m, url, { body, headers: Object.assign({ origin }, headers) })
        assert.equal(r.statusCode, 403, `${m} ${url} Origin=${origin}`)
        assert.equal(r.body.error.code, 'BAD_ORIGIN', `${m} ${url} Origin=${origin}`)
        assert.match(r.body.error.message, /別のサイト/)
      }
    }
    // Host が無いのに Origin がある
    const noHost = await fake.request('POST', B + '/adapters/origin/actions/clear-radio-block', { headers: { origin: 'http://127.0.0.1:1880', host: null } })
    assert.equal(noHost.statusCode, 403)
    await assertNothingWritten(fake, a, 'origin', rev, 'BAD_ORIGIN')
    // 読み出しには掛けない（誰でも読める）
    const g = await fake.request('GET', B + '/adapters/origin', { headers: { origin: 'http://evil.example' } })
    assert.equal(g.statusCode, 200)

    // 同じオリジン（既定のポートの省略・大文字のホストも同じに扱う）と、Origin の無い要求は通す
    const same = [
      [{ origin: 'http://127.0.0.1:1880' }],
      [{ origin: 'http://LOCALHOST:1880', host: 'localhost:1880' }],
      [{ origin: 'http://example.test', host: 'example.test:80' }],
      [{ origin: 'https://example.test', host: 'example.test', 'x-forwarded-proto': 'https' }], // TLS を終端するリバースプロキシ
      [{ origin: 'https://example.test:8443', host: 'example.test:8443' }, 'https'],
      [{}], // curl・Node-RED の http request ノード
      [{ origin: '' }],
    ]
    for (const [headers, protocol] of same) {
      a.seq._setRadioBlocked(true)
      const r = await fake.request('POST', B + '/adapters/origin/actions/clear-radio-block', { headers, protocol })
      assert.equal(r.statusCode, 200, `${JSON.stringify(headers)}: ${r.text}`)
      assert.equal(a.seq.state.radioBlocked, false)
    }
    // 断ったことは Node-RED のログに残す（同じ組み合わせは 1 回だけ）
    const warns = fake.logs.filter(([l, t]) => l === 'warn' && /別のオリジン/.test(t))
    assert.ok(warns.length >= 1 && warns.length <= foreign.length + 1, warns.length + ' 行')
    assert.ok(warns.some(([, t]) => t.includes('http://evil.example') && t.includes('127.0.0.1:1880')))
    // TLS を終端するプロキシで X-Forwarded-Proto を渡さないと、全部の書き込みがここで止まる。直し方も書く
    assert.ok(warns.every(([, t]) => t.includes('proxy_set_header Host') && t.includes('proxy_set_header X-Forwarded-Proto')), warns[0][1])
  } finally {
    rt.hub.dispose()
    await a.seq.destroy()
  }
})

test('isSameOrigin（純関数）', () => {
  const req = (headers, protocol) => ({ headers: Object.assign({ host: '127.0.0.1:1880' }, headers), protocol: protocol || 'http' })
  assert.equal(isSameOrigin(req({})), true, 'Origin が無い')
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1:1880' })), true)
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1:1880/' })), true, '末尾の / は無視（URL のオリジン）')
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1' })), false, 'ポートの省略は 80')
  assert.equal(isSameOrigin(req({ origin: 'http://[::1]:1880', host: '[::1]:1880' })), true)
  assert.equal(isSameOrigin(req({ origin: 'http://evil.example' })), false)
  assert.equal(isSameOrigin(req({ origin: 'https://127.0.0.1:1880' })), false)
  assert.equal(isSameOrigin(req({ origin: 'https://127.0.0.1:1880' }, 'https')), true)
  assert.equal(isSameOrigin(req({ origin: 'null' })), false)
  assert.equal(isSameOrigin({ headers: { origin: 'http://a' } }), false, 'Host が無い')
})

test('403 BAD_HOST: 知らないホスト名（DNS リバインディング）は、Origin が同じ名前でも書き込み・読み出し・SSE・画面を断る', async () => {
  // 攻撃者の名前（evil.example）を LAN のアドレスに向け直すと、Origin も Host も evil.example になり、
  // 415 と BAD_ORIGIN を通ってしまう。Host を許可リストで照らす。
  // 戻すと落ちるもの: http-api.js の route() から Host の検査（hostGuard）を外す
  const fake = createFakeRed()
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), diagIntervalMs: 0 })
  const a = makeAdapter(registry, 'rebind', {})
  try {
    a.seq._setRadioBlocked(true)
    const rev = (await fake.request('GET', B + '/adapters/rebind/settings')).body.rev
    for (const host of ['evil.example:1880', 'evil.example', 'EVIL.example:1880', '7f000001.c0a80a14.rbndr.us:1880', 'raspberrypi.evil.example:1880']) {
      const name = host.split(':')[0]
      for (const [m, url, body, headers] of writesFor('rebind', rev)) {
        const r = await fake.request(m, url, { body, headers: Object.assign({ host, origin: 'http://' + host }, headers) })
        assert.equal(r.statusCode, 403, `${m} ${url} Host=${host}`)
        assert.equal(r.body.error.code, 'BAD_HOST', `${m} ${url} Host=${host}`)
        assert.match(r.body.error.message, /allowedHosts/)
        assert.ok(r.body.error.message.includes(name.toLowerCase()), r.body.error.message)
      }
      // 読み出し・SSE・画面も（計測値・MAC・ログを外へ読み出させない）
      for (const url of [B + '/meta', B + '/adapters', B + '/adapters/rebind', B + '/adapters/rebind/logs', B + '/nope']) {
        const r = await fake.request('GET', url, { headers: { host, origin: 'http://' + host } })
        assert.equal(r.statusCode, 403, `GET ${url} Host=${host}`)
        assert.equal(r.body.error.code, 'BAD_HOST')
      }
      const s = fake.openStream(B + '/stream?adapter=rebind', { headers: { host } })
      await s.done
      assert.equal(s.res.statusCode, 403, 'SSE')
      assert.ok(!/event: /.test(s.res.text), 'SSE のフレームを送らない')
      for (const url of ['/wsuha-broute/ui/', '/wsuha-broute/ui/index.html', '/wsuha-broute/']) {
        const r = await fake.request('GET', url, { headers: { host } })
        assert.equal(r.statusCode, 403, `GET ${url} Host=${host}`)
        assert.match(r.text, /allowedHosts/)
      }
    }
    await assertNothingWritten(fake, a, 'rebind', rev, 'BAD_HOST')

    // 既定で通すもの: IP の直書き・localhost・1 語の名前・公開の DNS に登録できない名前（.local など）・このホストの名前
    const os = require('node:os')
    const okHosts = [
      '127.0.0.1:1880',
      '192.168.1.50:1880',
      '[::1]:1880',
      '[fe80::1]:1880',
      'localhost:1880',
      'LOCALHOST',
      'raspberrypi:1880',
      'nodered',
      'raspberrypi.local:1880',
      'raspberrypi.local.:1880',
      'nodered.lan',
      'pi.home.arpa',
      'pi.internal',
      'app.localhost',
      os.hostname() + ':1880',
    ]
    for (const host of okHosts) {
      a.seq._setRadioBlocked(true)
      const r = await fake.request('POST', B + '/adapters/rebind/actions/clear-radio-block', { headers: { host, origin: 'http://' + host } })
      assert.equal(r.statusCode, 200, `Host=${host}: ${r.text}`)
      assert.equal(a.seq.state.radioBlocked, false)
      assert.equal((await fake.request('GET', B + '/adapters', { headers: { host } })).statusCode, 200, `GET Host=${host}`)
    }
    // Host が無い（ブラウザは必ず付ける。無いのは curl の HTTP/1.0 など）読み出しは通す
    assert.equal((await fake.request('GET', B + '/meta', { headers: { host: null } })).statusCode, 200)
    // 断ったことは Node-RED のログに残す（同じ名前は 1 回だけ）。直し方（allowedHosts）を書く
    const warns = fake.logs.filter(([l, t]) => l === 'warn' && /allowedHosts/.test(t))
    assert.ok(warns.length >= 1 && warns.length <= 5, warns.length + ' 行')
    assert.ok(warns.some(([, t]) => t.includes('evil.example')))
  } finally {
    rt.hub.dispose()
    await a.seq.destroy()
  }

  // settings.js の wsuhaBroute.allowedHosts で足せる（ポートは見ない。'.' で始めると下の名前も）
  const f2 = createFakeRed({ settings: { wsuhaBroute: { allowedHosts: ['NodeRed.Example.com', '.home.example.org', 'proxy.example.net:443'] } } })
  const r2 = install(f2.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-') })
  try {
    for (const [host, want] of [
      ['nodered.example.com', 200],
      ['nodered.example.com:8443', 200],
      ['pi.home.example.org', 200],
      ['home.example.org', 200],
      ['proxy.example.net', 200],
      ['other.example.com', 403],
      ['evilhome.example.org', 403],
      ['nodered.example.com.evil.example', 403],
    ]) {
      const r = await f2.request('GET', B + '/meta', { headers: { host } })
      assert.equal(r.statusCode, want, host)
    }
  } finally {
    r2.hub.dispose()
  }
})

test('CORS: エディタが先に付けた Access-Control-Allow-Origin: * を、画面・API・SSE・失敗の応答から外す', async () => {
  // httpAdminRoot と httpNodeRoot が同じ '/' だと、エディタ（adminApp）の cors({origin:'*'}) が
  // httpNode の応答にも先に付ける。残すと、どのサイトのページの fetch からでも計測値・MAC・ログを読める。
  // 戻すと落ちるもの: http-api.js の route() から stripCors を外す
  const pre = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Credentials': 'true',
  }
  const dir = tmpDir('wsuha-ui-')
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>')
  const fake = createFakeRed()
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: dir, diagIntervalMs: 0 })
  const a = makeAdapter(registry, 'cors', {})
  try {
    const evil = { origin: 'https://evil.example' }
    const cases = [
      ['GET', B + '/meta', {}],
      ['GET', B + '/adapters', evil],
      ['GET', B + '/adapters/cors', evil],
      ['GET', B + '/adapters/cors/logs?limit=3', evil],
      ['GET', B + '/adapters/cors/settings', evil],
      ['GET', B + '/adapters/nope', evil], // 404 の JSON
      ['GET', B + '/nope', evil],
      ['POST', B + '/adapters/cors/actions/clear-radio-block', evil], // 403 BAD_ORIGIN
      ['POST', B + '/adapters/cors/actions/clear-radio-block', {}], // 200
      ['GET', '/wsuha-broute/ui/', evil],
      ['GET', '/wsuha-broute/ui/index.html', evil],
      ['GET', '/wsuha-broute/ui/nope.js', evil], // 404
      ['GET', '/wsuha-broute/', evil], // 302
      ['GET', B + '/meta', { host: 'evil.example:1880' }], // 403 BAD_HOST
    ]
    const statuses = []
    for (const [m, url, headers] of cases) {
      const r = await fake.request(m, url, { headers, resHeaders: pre })
      statuses.push(r.statusCode)
      for (const k of Object.keys(pre)) assert.equal(r.headers[k.toLowerCase()], undefined, `${m} ${url}（${r.statusCode}）に ${k} が残っている`)
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 404, 404, 403, 200, 200, 200, 404, 302, 403], '前提: 成功と失敗の両方を見た')
    const s = fake.openStream(B + '/stream?adapter=cors&logs=1', { headers: evil, resHeaders: pre })
    await s.done
    assert.equal(s.res.headers['content-type'], 'text/event-stream; charset=utf-8')
    for (const k of Object.keys(pre)) assert.equal(s.res.headers[k.toLowerCase()], undefined, `SSE に ${k} が残っている`)
    s.req.emit('close')
  } finally {
    rt.hub.dispose()
    await a.seq.destroy()
  }
})

test('isAllowedHost（純関数）', () => {
  const ok = (h, o) => isAllowedHost(h, Object.assign({ hostname: 'raspberrypi' }, o))
  assert.equal(ok(undefined), true, 'Host が無い')
  assert.equal(ok('127.0.0.1:1880'), true)
  assert.equal(ok('[::1]:1880'), true)
  assert.equal(ok('localhost'), true)
  assert.equal(ok('raspberrypi'), true)
  assert.equal(ok('raspberrypi.local'), true)
  assert.equal(ok('evil.example'), false)
  assert.equal(ok('1.2.3.4.nip.io'), false, '数字の名前でも DNS の名前')
  assert.equal(ok('999.1.1.1'), false)
  assert.equal(ok('evil.example@127.0.0.1'), false, '読めない Host')
  assert.equal(ok('127.0.0.1:1880/x'), false)
  assert.equal(ok(''), true, '空は Host が無いのと同じ')
  assert.equal(ok('my.raspberrypi.example', { hostname: 'my.raspberrypi.example' }), true, 'このホストの名前（FQDN）')
  assert.equal(ok('a.example', { allowedHosts: ['A.EXAMPLE'] }), true)
  assert.equal(ok('b.example', { allowedHosts: 'b.example' }), true, '文字列 1 つでも')
})

test('403 READ_ONLY: settings.js の wsuhaBroute.readOnly が true なら書き込みを全部断る（読み出しと meta は通す）', async () => {
  // 戻すと落ちるもの: http-api.js の書き込みのルートから requireWritable を外す
  const fake = createFakeRed({ settings: { wsuhaBroute: { readOnly: true } } })
  const registry = createRegistry()
  const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-'), diagIntervalMs: 0 })
  const a = makeAdapter(registry, 'ro', {})
  try {
    a.seq._setRadioBlocked(true)
    const rev = (await fake.request('GET', B + '/adapters/ro/settings')).body.rev
    for (const [m, url, body, headers] of writesFor('ro', rev)) {
      const r = await fake.request(m, url, { body, headers })
      assert.equal(r.statusCode, 403, `${m} ${url}`)
      assert.equal(r.body.error.code, 'READ_ONLY', `${m} ${url}`)
      assert.equal(r.body.error.message, 'このサーバーでは画面からの操作を止めています（settings.js の wsuhaBroute.readOnly）')
    }
    await assertNothingWritten(fake, a, 'ro', rev, 'READ_ONLY')
    const meta = await fake.request('GET', B + '/meta')
    assert.equal(meta.body.readOnly, true)
    assert.equal((await fake.request('GET', B + '/adapters/ro')).statusCode, 200)
    assert.equal((await fake.request('GET', B + '/adapters/ro/settings')).statusCode, 200)
  } finally {
    rt.hub.dispose()
    await a.seq.destroy()
  }
  // true 以外（'yes'・1）は読み出しのみにしない（設定の書き間違いで黙って止めない）。無ければ false
  for (const [settings, want] of [
    [{ wsuhaBroute: { readOnly: 'yes' } }, false],
    [{ wsuhaBroute: { readOnly: 1 } }, false],
    [{ wsuhaBroute: {} }, false],
    [{}, false],
  ]) {
    const f = createFakeRed({ settings })
    const r = install(f.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-') })
    try {
      assert.equal((await f.request('GET', B + '/meta')).body.readOnly, want, JSON.stringify(settings))
    } finally {
      r.hub.dispose()
    }
  }
})

test('httpNodeRoot が false か wsuhaBroute.ui が false なら、画面と API を載せずに warn を 1 行出す（運用設定の照合などは動く）', async () => {
  for (const settings of [{ httpNodeRoot: false }, { wsuhaBroute: { ui: false } }, { httpNodeRoot: false, wsuhaBroute: { ui: false } }]) {
    const fake = createFakeRed({ settings })
    const registry = createRegistry()
    const rt = install(fake.RED, { registry, uiDir: tmpDir('wsuha-ui-') })
    const what = JSON.stringify(settings)
    assert.equal(fake.routes.filter((r) => r.app === 'node').length, 0, what + ': httpNode に何も載せない')
    assert.equal(fake.routes.filter((r) => r.app === 'admin').length, 0, what + ': httpAdmin にも載せない')
    const warns = fake.logs.filter(([l, t]) => l === 'warn' && /Web UI/.test(t))
    assert.equal(warns.length, 1, what + ': ' + warns.map(([, t]) => t).join(' | '))
    assert.match(warns[0][1], settings.httpNodeRoot === false ? /httpNodeRoot/ : /wsuhaBroute\.ui/)
    assert.equal(rt.hub, null, 'SSE の受け口も作らない')
    // 運用設定の読み書き（フローの入力が使う）は動く
    const a = makeAdapter(registry, 'noui', {})
    try {
      const s = rt.service.saveSettings(a.h, { pollIntervalSec: 45 }, { by: 'flow:試験' })
      assert.equal(s.fields.pollIntervalSec.value, 45)
      assert.equal(a.seq.options.pollIntervalSec, 45)
    } finally {
      await a.seq.destroy()
    }
  }
  // 既定（httpNodeRoot が '/' や未設定・ui が true か未設定）は載せる
  for (const settings of [{}, { httpNodeRoot: '/' }, { httpNodeRoot: '/api/' }, { wsuhaBroute: { ui: true } }]) {
    const fake = createFakeRed({ settings })
    const rt = install(fake.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-') })
    try {
      assert.ok(fake.routes.filter((r) => r.app === 'node').length >= API_ROUTES.length, JSON.stringify(settings))
      assert.ok(!fake.logs.some(([l, t]) => l === 'warn' && /載せません/.test(t)), JSON.stringify(settings))
    } finally {
      rt.hub.dispose()
    }
  }
})

test('httpNode の無い RED（単体で使った場合）でも落ちず、warn を 1 行出す', () => {
  const fake = createFakeRed({ noHttpNode: true })
  const rt = install(fake.RED, { registry: createRegistry(), uiDir: tmpDir('wsuha-ui-') })
  try {
    assert.equal(fake.routes.length, 0)
    const warns = fake.logs.filter(([l, t]) => l === 'warn' && /httpNode/.test(t))
    assert.equal(warns.length, 1, warns.map(([, t]) => t).join(' | '))
  } finally {
    if (rt.hub) rt.hub.dispose()
  }
})

test('全部の応答と SSE のフレームとログに、認証 ID・パスワード・idHint が出ない', () => {
  // ここまでの試験で見えたもの全部と、ログのリング
  seen.push(JSON.stringify(ctx.a.h.logsAfter({ after: 0, limit: 1000 })))
  seen.push(ctx.rt.hub.ring.map((e) => e.text).join(''))
  const all = seen.join('\n')
  assert.ok(all.length > 10000, '前提: 見たものが十分にある')
  for (const x of [ID, PW, ID.toLowerCase(), PW.toLowerCase(), IDHINT]) {
    assert.ok(!all.includes(x), `秘密（${x.slice(0, 4)}…）が出ている`)
  }
  assert.ok(!/idHint/.test(all))
})

test('補助: If-Match の読み方・失敗の写し方・待ちの上限', async () => {
  assert.equal(parseIfMatch({ headers: { 'if-match': 'W/"abc"' } }), 'abc')
  assert.equal(parseIfMatch({ headers: { 'if-match': ' "abc" ' } }), 'abc')
  assert.equal(parseIfMatch({ headers: {} }), null)
  const cases = [
    [Object.assign(new Error('x'), { aborted: true }), 409, 'BUSY'],
    [Object.assign(new Error('x'), { blocked: true }), 409, 'RADIO_BLOCKED'],
    [Object.assign(new Error('タイムアウト (5秒)'), { timeout: true }), 504, 'TIMEOUT'],
    [new Error('ECHONET 応答のタイムアウト'), 504, 'TIMEOUT'],
    [new Error('ECHONET 要求が滞留しています。間隔を空けてください'), 409, 'BUSY'],
    [new Error('接続先アドレスが未確定です'), 503, 'NOT_CONNECTED'],
    [Object.assign(new Error('ER10 …'), { code: 'ER10' }), 502, 'DEVICE_ERROR'],
    [Object.assign(new Error('x'), { code: 'FORBIDDEN_COMMAND', forbidden: true }), 403, 'FORBIDDEN_COMMAND'],
  ]
  for (const [err, status, code] of cases) {
    const e = mapError(err)
    assert.equal(e.status, status, err.message)
    assert.equal(e.code, code, err.message)
  }
  assert.equal(mapError(new Error('知らない失敗')), null, '知らないものは 500 に回す')
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20, '試験'), (e) => e.timeout === true)
  assert.equal(await withTimeout(Promise.resolve(5), 1000, '試験'), 5)
  // 上限で先に返したあとの失敗を、未処理の拒否にしない
  let unhandled = false
  const onUnhandled = () => (unhandled = true)
  process.on('unhandledRejection', onUnhandled)
  await assert.rejects(() => withTimeout(new Promise((_, rej) => setTimeout(() => rej(new Error('遅れて失敗')), 30)), 5, '試験'))
  await new Promise((r) => setTimeout(r, 60))
  process.removeListener('unhandledRejection', onUnhandled)
  assert.equal(unhandled, false)
})

test('運用設定を外したときは、設定ノードの値（カンマ区切りの複数 EPC も）に戻す', () => {
  const { Sequencer } = require('../../lib/sequencer')
  const { EventEmitter } = require('node:events')
  const handle = { configValues: { pollIntervalSec: '45', pollEpcs: 'E7, E8', slowIntervalSec: null, halfHourIntervalSec: 900 } }
  assert.deepEqual(ctx.rt.fallbackValue(handle, 'pollEpcs'), ['0xE7', '0xE8'])
  assert.equal(ctx.rt.fallbackValue(handle, 'pollIntervalSec'), 45)
  assert.equal(ctx.rt.fallbackValue(handle, 'slowIntervalSec'), 300, '設定ノードで空の項目は既定値')
  assert.equal(ctx.rt.fallbackValue(handle, 'halfHourIntervalSec'), 900, '設定ノードの 30 分の間隔')
  assert.deepEqual(ctx.rt.fallbackValue({ configValues: { pollEpcs: '' } }, 'pollEpcs'), ['0xE7', '0xE8'])
  const seq = new Sequencer(new EventEmitter(), { pollEpcs: [0xe0] })
  seq.setBaseline({ pollEpcs: ctx.rt.fallbackValue(handle, 'pollEpcs') })
  assert.deepEqual(seq.options.pollEpcs, [0xe7, 0xe8])
})
