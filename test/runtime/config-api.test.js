'use strict'

// 構成の HTTP API: GET serialports・GET / PUT / DELETE adapters/:id/config・PUT / DELETE adapters/:id/credentials・
// SSE の config。守り（12.1 の全部・uiConfig === false で 403 CONFIG_LOCKED・readOnly で 403 READ_ONLY）。
// ここは設定ノードを作らない（偽の RED と makeAdapter の handle）。ポートの開き直しは test/nodes/config-io.test.js。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { install } = require('../../lib/runtime/http-api')
const { createRegistry } = require('../../lib/runtime/registry')
const { createFakeRed, parseSse, waitFor, tmpDir, ID, PW } = require('./fake-red')
const { makeAdapter, connect } = require('./adapter-kit')

/** もう 1 台の認証 ID（架空）。同じ ID だと PAIR_IN_USE になる。 */
const OTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'

const B = '/wsuha-broute/api/v1'
const CONFIG_ROUTES = [
  ['GET', B + '/serialports'],
  ['GET', B + '/adapters/:id/config'],
  ['PUT', B + '/adapters/:id/config'],
  ['DELETE', B + '/adapters/:id/config'],
  ['PUT', B + '/adapters/:id/credentials'],
  ['DELETE', B + '/adapters/:id/credentials'],
]
const BYID = '/dev/serial/by-id/usb-FTDI_FT230X_Basic_UART_TEST1-if00-port0'
const REAL = { [BYID]: '/dev/ttyUSB1' }

const seen = []
let ctx

function makeCtx(settings) {
  const userDir = tmpDir('wsuha-cfgapi-')
  const fake = createFakeRed({ userDir, settings: settings || {} })
  const registry = createRegistry()
  const rt = install(fake.RED, {
    registry,
    uiDir: tmpDir('wsuha-ui-'),
    diagIntervalMs: 0,
    sse: { throttleMs: 20, pingMs: 60000, maxAgeMs: 600000 },
    realpath: (p) => REAL[p] || p,
    listPorts: async () => [
      { path: BYID, label: 'usb-FTDI_FT230X_Basic_UART_TEST1-if00-port0 (ttyUSB1)', manufacturer: 'FTDI', byId: true, realPath: '/dev/ttyUSB1', byIdPath: BYID },
      { path: '/dev/ttyUSB0', label: '/dev/ttyUSB0 — FTDI', manufacturer: 'FTDI', byId: false, realPath: '/dev/ttyUSB0', byIdPath: null },
      { path: '/dev/ttyUSB1', label: '/dev/ttyUSB1 — FTDI', manufacturer: 'FTDI', byId: false, realPath: '/dev/ttyUSB1', byIdPath: BYID },
    ],
  })
  return { userDir, fake, registry, rt }
}

async function req(c, method, url, p) {
  const res = await c.fake.request(method, url, p)
  seen.push(res.text)
  return res
}

before(async () => {
  ctx = makeCtx()
  // a: シミュレータで接続する台。b: シリアル（/dev/ttyUSB0 を使う。開かない）
  ctx.a = makeAdapter(ctx.registry, 'cfg-a', { name: '電力メーター' })
  ctx.b = makeAdapter(ctx.registry, 'cfg-b', {
    routeBId: OTHER_ID,
    name: '動力メーター',
    attach: false,
    meta: { mode: 'serial', port: '/dev/ttyUSB0', portLabel: 'USB0' },
  })
  ctx.a.h.editorConfig = { name: '電力メーター', role: '電力', enabled: null, mode: 'simulator', serialport: null, serialbaud: 115200, deviceKey: 'usb0', expectedMac: null, autoStart: null, scanDurations: null }
  ctx.b.h.editorConfig = { name: '動力メーター', role: '動力', enabled: null, mode: 'serial', serialport: '/dev/ttyUSB0', serialbaud: 115200, deviceKey: 'usb1', expectedMac: null, autoStart: null, scanDurations: null }
  await connect(ctx.a.seq)
})

after(async () => {
  if (ctx) {
    ctx.rt.hub.dispose()
    await ctx.a.seq.destroy()
  }
})

test('構成のルートが全部 httpNode にあり、needsPermission を掛けない', () => {
  // 戻すと落ちるもの: http-api.js の route('…/config' …) などを外す
  for (const [m, p] of CONFIG_ROUTES) {
    const r = ctx.fake.routes.find((x) => x.method === m && x.path === p)
    assert.ok(r, `${m} ${p} が登録されている`)
    assert.equal(r.app, 'node')
    for (const h of r.handlers) assert.equal(h.permission, undefined)
  }
})

test('GET config: Config（Settings と同じ形で fields が構成の項目）。credentials に値を入れない。ETag は configRev', async () => {
  const res = await req(ctx, 'GET', B + '/adapters/cfg-a/config')
  assert.equal(res.statusCode, 200, res.text)
  const c = res.body
  assert.deepEqual(Object.keys(c).sort(), ['applying', 'credentials', 'fields', 'locked', 'lockedReason', 'rev', 'warnings'])
  // 並びは基本設定 → 詳細設定の順
  assert.deepEqual(Object.keys(c.fields), ['role', 'name', 'mode', 'serialport', 'enabled', 'autoStart', 'serialbaud', 'deviceKey', 'expectedMac', 'scanDurations'])
  assert.equal(c.rev, '0')
  assert.equal(res.headers.etag, '"0"')
  const f = c.fields.name
  for (const k of ['value', 'source', 'runtimeValue', 'configValue', 'default', 'connection', 'by', 'at', 'label']) assert.ok(k in f, k)
  assert.equal(f.value, '電力メーター')
  assert.equal(f.source, 'config')
  assert.equal(c.fields.enabled.source, 'default', '1.x のフロー（enabled が無い）は既定')
  assert.equal(c.fields.enabled.value, true)
  assert.equal(c.fields.mode.connection, true)
  assert.equal(c.fields.name.connection, false)
  assert.deepEqual(c.fields.serialbaud.values, [2400, 4800, 9600, 19200, 38400, 57600, 115200])
  assert.deepEqual(c.fields.mode.options.map((o) => o.value), ['serial', 'simulator'])
  assert.deepEqual(c.fields.scanDurations.value, [4, 5, 6, 7, 8])
  assert.deepEqual(Object.keys(c.credentials).sort(), ['configured', 'envOverrides', 'pairId', 'source', 'stored'])
  assert.equal(c.credentials.configured, true)
  assert.equal(c.credentials.pairId, ID.slice(-8))
  assert.equal(c.credentials.stored, null)
  assert.equal(c.applying, false)
  assert.equal(c.locked, false)
  assert.equal((await req(ctx, 'GET', B + '/adapters/nope/config')).statusCode, 404)
})

test('PUT config: If-Match が必須（無い・違う・運用設定の rev は 412）。422 は項目ごとの理由。保存して表示（meta）に効かせる。変えた人は web-ui', async () => {
  // 戻すと落ちるもの: http-api.js の configIfMatchOf・service.js の saveConfig の検証
  const no = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { name: '一階' } })
  assert.equal(no.statusCode, 412)
  assert.equal(no.body.error.code, 'REVISION_MISMATCH')
  const srev = (await req(ctx, 'GET', B + '/adapters/cfg-a/settings')).body.rev
  const bad = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { name: '一階' }, headers: { 'if-match': 'zzz' } })
  assert.equal(bad.statusCode, 412)
  const v = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', {
    body: { serialbaud: 230400, expectedMac: 'XYZ', deviceKey: 'a b', scanDurations: [1], pollIntervalSec: 60 },
    headers: { 'if-match': '0' },
  })
  assert.equal(v.statusCode, 422, v.text)
  assert.equal(v.body.error.code, 'VALIDATION')
  assert.deepEqual(Object.keys(v.body.error.details).sort(), ['deviceKey', 'expectedMac', 'pollIntervalSec', 'scanDurations', 'serialbaud'])

  const ok = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { name: '一階', role: '電灯', scanDurations: '5,6' }, headers: { 'if-match': '"0"' } })
  assert.equal(ok.statusCode, 200, ok.text)
  const c = ok.body
  assert.notEqual(c.rev, '0')
  assert.equal(ok.headers.etag, `"${c.rev}"`)
  assert.equal(c.fields.name.value, '一階')
  assert.equal(c.fields.name.source, 'runtime')
  assert.equal(c.fields.name.runtimeValue, '一階')
  assert.equal(c.fields.name.configValue, '電力メーター')
  assert.equal(c.fields.name.by, 'web-ui')
  assert.equal(typeof c.fields.name.at, 'number')
  assert.deepEqual(c.fields.scanDurations.value, [5, 6])
  // 運用設定の版は変わらない
  assert.equal((await req(ctx, 'GET', B + '/adapters/cfg-a/settings')).body.rev, srev)
  // 一覧と詳細の名前に効く（設定ノードの居ない handle は meta だけを入れ直す）
  const d = (await req(ctx, 'GET', B + '/adapters/cfg-a')).body
  assert.equal(d.name, '一階')
  assert.equal(d.role, '電灯')
  // ログに残る（値は秘密でない項目だけ）
  const logs = (await req(ctx, 'GET', B + '/adapters/cfg-a/logs?limit=1000')).body.items
  assert.ok(logs.some((l) => /画面から接続の設定を変えました: 契約 電灯 \/ 名前 一階 \/ スキャンの段階 5, 6/.test(l.text)), JSON.stringify(logs.slice(-3)))
  // 監査には項目の名前だけ
  const audits = ctx.fake.logs.filter(([l, t]) => l === 'audit' && t.includes('config.put'))
  assert.ok(audits.length >= 1)
  assert.ok(!audits.some(([, t]) => t.includes('一階')), '監査に値を入れない')

  // null でその項目を外す（設定ノードの値に戻す）
  const back = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { name: null }, headers: { 'if-match': c.rev } })
  assert.equal(back.statusCode, 200, back.text)
  assert.equal(back.body.fields.name.source, 'config')
  assert.equal(back.body.fields.name.value, '電力メーター')
  assert.equal(back.body.fields.role.source, 'runtime')
  // DELETE（If-Match）で全部外す
  const delNo = await req(ctx, 'DELETE', B + '/adapters/cfg-a/config')
  assert.equal(delNo.statusCode, 412)
  const del = await req(ctx, 'DELETE', B + '/adapters/cfg-a/config', { headers: { 'if-match': back.body.rev } })
  assert.equal(del.statusCode, 200, del.text)
  for (const f of Object.values(del.body.fields)) assert.notEqual(f.source, 'runtime')
  assert.equal((await req(ctx, 'GET', B + '/adapters/cfg-a')).body.role, '電力')
  // settings.json の形
  const disk = JSON.parse(fs.readFileSync(path.join(ctx.userDir, 'wsuha-broute', 'settings.json'), 'utf8'))
  assert.deepEqual(disk.adapters['cfg-a'].config, {})
  assert.equal(disk.adapters['cfg-a'].configRev, del.body.rev)
})

test('409 PORT_IN_USE: ほかの台が開いているポート（by-id で同じ実体も）は選べない。message にどの台か。シミュレータ同士は重ならない', async () => {
  // 戻すと落ちるもの: service.js の checkPortFree を外す・portKey で実体を比べない
  const rev = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
  const r = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { mode: 'serial', serialport: '/dev/ttyUSB0' }, headers: { 'if-match': rev } })
  assert.equal(r.statusCode, 409, r.text)
  assert.equal(r.body.error.code, 'PORT_IN_USE')
  assert.match(r.body.error.message, /動力メーター/)
  assert.equal(r.body.error.details.adapterId, 'cfg-b')
  assert.equal((await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev, rev, '保存しない')
  // b を by-id（実体は ttyUSB1）にしてから、a が ttyUSB1 を選ぶ
  const brev = (await req(ctx, 'GET', B + '/adapters/cfg-b/config')).body.rev
  const rb = await req(ctx, 'PUT', B + '/adapters/cfg-b/config', { body: { serialport: BYID }, headers: { 'if-match': brev } })
  assert.equal(rb.statusCode, 200, rb.text)
  const r2 = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { mode: 'serial', serialport: '/dev/ttyUSB1' }, headers: { 'if-match': rev } })
  assert.equal(r2.statusCode, 409, r2.text)
  assert.equal(r2.body.error.code, 'PORT_IN_USE')
  // ttyUSB0 は空いた
  const r3 = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { mode: 'serial', serialport: '/dev/ttyUSB0' }, headers: { 'if-match': rev } })
  assert.equal(r3.statusCode, 200, r3.text)
  // シミュレータに戻す（serialport に 'simulator' の候補を渡す）。シミュレータ同士は重ならない
  const r4 = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { serialport: 'simulator' }, headers: { 'if-match': r3.body.rev } })
  assert.equal(r4.statusCode, 200, r4.text)
  assert.equal(r4.body.fields.mode.value, 'simulator')
  assert.equal(r4.body.fields.mode.source, 'runtime', '画面の値として残す（設定ノードと同じ値でも）')
  // 無効の台のポートは選べる（b を無効にすると BYID が空く）
  const brev2 = (await req(ctx, 'GET', B + '/adapters/cfg-b/config')).body.rev
  assert.equal((await req(ctx, 'PUT', B + '/adapters/cfg-b/config', { body: { enabled: false }, headers: { 'if-match': brev2 } })).statusCode, 200)
  const rev5 = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
  const r5 = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { mode: 'serial', serialport: BYID }, headers: { 'if-match': rev5 } })
  assert.equal(r5.statusCode, 200, r5.text)
  // 名前だけの保存は、今の重なりを理由に断らない（b を有効に戻すと重なるが、a の名前は変えられる）
  const brev3 = (await req(ctx, 'GET', B + '/adapters/cfg-b/config')).body.rev
  // b を有効に戻すのは、a が同じ実体を使っているので断る
  const rb2 = await req(ctx, 'PUT', B + '/adapters/cfg-b/config', { body: { enabled: null }, headers: { 'if-match': brev3 } })
  assert.equal(rb2.statusCode, 409, rb2.text)
  assert.match(rb2.body.error.message, /電力メーター/)
  const rn = await req(ctx, 'PUT', B + '/adapters/cfg-b/config', { body: { name: '動力（予備）' }, headers: { 'if-match': brev3 } })
  assert.equal(rn.statusCode, 200, rn.text)
  // 片付け
  for (const id of ['cfg-a', 'cfg-b']) {
    const rv = (await req(ctx, 'GET', B + `/adapters/${id}/config`)).body.rev
    assert.equal((await req(ctx, 'DELETE', B + `/adapters/${id}/config`, { headers: { 'if-match': rv } })).statusCode, 200)
  }
})

test('422: 有効でシリアルなのにポートが無くなる構成は断る（画面と同じ規則）。ポート・接続先・有効を変えない保存と、全部外す（DELETE）は断らない', async () => {
  // 前は 200 で受け、開き直すと SerialTransport が作れず sequencer の無い台が残った。
  // 戻すと落ちるもの: service.js の saveConfig の「シリアルでポートなし」の検査を外す
  const c = makeCtx()
  const a = makeAdapter(c.registry, 'np-a', { name: 'シミュレータの台' })
  const p = makeAdapter(c.registry, 'np-p', { name: 'ポートの無い台', attach: false, routeBId: OTHER_ID, meta: { mode: 'serial', port: '', portLabel: '' } })
  a.h.editorConfig = { name: 'シミュレータの台', role: '電力', enabled: null, mode: 'simulator', serialport: null, serialbaud: 115200, deviceKey: 'npa', expectedMac: null, autoStart: null, scanDurations: null }
  // エディタの設定ノードそのものがシリアルでポートなし（エディタでデプロイした）
  p.h.editorConfig = { name: 'ポートの無い台', role: '動力', enabled: null, mode: 'serial', serialport: null, serialbaud: 115200, deviceKey: 'npp', expectedMac: null, autoStart: null, scanDurations: null }
  try {
    const rev = (await req(c, 'GET', B + '/adapters/np-a/config')).body.rev
    for (const body of [{ mode: 'serial' }, { mode: 'serial', serialport: null }, { mode: 'serial', serialport: '   ' }]) {
      const r = await req(c, 'PUT', B + '/adapters/np-a/config', { body, headers: { 'if-match': rev } })
      assert.equal(r.statusCode, 422, `${JSON.stringify(body)}: ${r.text}`)
      assert.equal(r.body.error.code, 'VALIDATION')
      assert.ok(r.body.error.details && typeof r.body.error.details.serialport === 'string', r.text)
      assert.match(r.body.error.details.serialport, /ポート/)
    }
    assert.equal((await req(c, 'GET', B + '/adapters/np-a/config')).body.rev, rev, '保存しない')
    assert.equal((await req(c, 'GET', B + '/adapters/np-a')).body.mode, 'simulator', '効かせない')
    // ポートも渡せば通る
    const ok = await req(c, 'PUT', B + '/adapters/np-a/config', { body: { mode: 'serial', serialport: '/dev/ttyUSB9' }, headers: { 'if-match': rev } })
    assert.equal(ok.statusCode, 200, ok.text)
    // ポートだけ外す（設定ノードの値 = 空に戻す）とシリアルのままポートが無くなるので断る
    const off = await req(c, 'PUT', B + '/adapters/np-a/config', { body: { serialport: null }, headers: { 'if-match': ok.body.rev } })
    assert.equal(off.statusCode, 422, off.text)
    assert.ok(off.body.error.details.serialport)
    // 設定ノードの値が既にポートなし: ポート・接続先・有効を変えない保存（名前だけ）は断らない（画面も差分の項目だけを確かめる）
    const prev = (await req(c, 'GET', B + '/adapters/np-p/config')).body.rev
    const name = await req(c, 'PUT', B + '/adapters/np-p/config', { body: { name: '予備' }, headers: { 'if-match': prev } })
    assert.equal(name.statusCode, 200, name.text)
    // 無効にするのは通る（ポートを開かない）。有効に戻す（true・null = 設定ノードの値）のは断る
    const dis = await req(c, 'PUT', B + '/adapters/np-p/config', { body: { enabled: false }, headers: { 'if-match': name.body.rev } })
    assert.equal(dis.statusCode, 200, dis.text)
    for (const v of [true, null]) {
      const on = await req(c, 'PUT', B + '/adapters/np-p/config', { body: { enabled: v }, headers: { 'if-match': dis.body.rev } })
      assert.equal(on.statusCode, 422, `${v}: ${on.text}`)
      assert.ok(on.body.error.details.serialport)
    }
    // 全部外す（設定ノードの値に戻す）は、設定ノードの値がポートなしでも断らない（エディタの値に戻せなくならないように）
    const del = await req(c, 'DELETE', B + '/adapters/np-p/config', { headers: { 'if-match': dis.body.rev } })
    assert.equal(del.statusCode, 200, del.text)
    const delA = await req(c, 'DELETE', B + '/adapters/np-a/config', { headers: { 'if-match': ok.body.rev } })
    assert.equal(delA.statusCode, 200, delA.text)
  } finally {
    c.rt.hub.dispose()
    await a.seq.destroy()
  }
})

test('409 BUSY: 開き直しの最中は、構成と認証情報の変更・操作・診断を断る（待たない）。終われば通る', async () => {
  // 決めたこと: 開き直しの最中に次の変更が来たら 409 BUSY（待たずに断る。画面は「終わってからもう一度」）。
  // 戻すと落ちるもの: service.js の saveConfig / saveCredentials / requireUsable で h.reconfiguring を見ない
  ctx.a.h.setReconfiguring(true)
  try {
    const rev = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
    assert.equal((await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.applying, true, 'Config.applying')
    for (const [m, u, body, h] of [
      ['PUT', '/adapters/cfg-a/config', { name: 'x' }, { 'if-match': rev }],
      ['DELETE', '/adapters/cfg-a/config', undefined, { 'if-match': rev }],
      ['PUT', '/adapters/cfg-a/credentials', { routeBId: ID, routeBPassword: PW }, {}],
      ['DELETE', '/adapters/cfg-a/credentials', undefined, {}],
      ['POST', '/adapters/cfg-a/actions/poll', undefined, {}],
      ['POST', '/adapters/cfg-a/diag', { name: 'ropt' }, {}],
    ]) {
      const r = await req(ctx, m, B + u, { body, headers: h })
      assert.equal(r.statusCode, 409, `${m} ${u}: ${r.text}`)
      assert.equal(r.body.error.code, 'BUSY')
      assert.match(r.body.error.message, /接続し直している途中/)
    }
    assert.equal((await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev, rev, '保存しない')
  } finally {
    ctx.a.h.setReconfiguring(false)
  }
  const rev = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
  const ok = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { name: 'あとで' }, headers: { 'if-match': rev } })
  assert.equal(ok.statusCode, 200, ok.text)
  assert.equal((await req(ctx, 'DELETE', B + '/adapters/cfg-a/config', { headers: { 'if-match': ok.body.rev } })).statusCode, 200)
})

test('PUT / DELETE credentials: 値を応答・ログ・監査・settings.json に入れない。<userDir>/wsuha-broute/credentials/<id>.json に置く', async () => {
  // 戻すと落ちるもの: http-api.js の putCredentials で本文を返す・service.js の saveCredentials でログに値を書く
  const v = await req(ctx, 'PUT', B + '/adapters/cfg-a/credentials', { body: { routeBId: ID.slice(2), routeBPassword: PW } })
  assert.equal(v.statusCode, 422, v.text)
  assert.ok(v.body.error.details.routeBId)
  assert.ok(!v.text.includes(ID.slice(2)) && !v.text.includes(PW), '422 の理由に値を入れない')
  const ok = await req(ctx, 'PUT', B + '/adapters/cfg-a/credentials', { body: { routeBId: ID.toLowerCase(), routeBPassword: PW } })
  assert.equal(ok.statusCode, 200, ok.text)
  assert.ok(!ok.text.toUpperCase().includes(ID) && !ok.text.toUpperCase().includes(PW), '応答に値が出ている')
  assert.equal(ok.body.credentials.stored.by, 'web-ui')
  assert.equal(typeof ok.body.credentials.stored.at, 'number')
  const file = path.join(ctx.userDir, 'wsuha-broute', 'credentials', 'cfg-a.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.id, ID, 'ファイルには大文字で残す')
  assert.equal(saved.password, PW)
  const settingsFile = path.join(ctx.userDir, 'wsuha-broute', 'settings.json')
  if (fs.existsSync(settingsFile)) assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(ID))
  const logs = (await req(ctx, 'GET', B + '/adapters/cfg-a/logs?limit=1000')).body.items
  assert.ok(logs.some((l) => /画面から B ルートの認証 ID とパスワードを保存しました（値は記録しません）/.test(l.text)))
  const del = await req(ctx, 'DELETE', B + '/adapters/cfg-a/credentials')
  assert.equal(del.statusCode, 200, del.text)
  assert.equal(del.body.credentials.stored, null)
  assert.ok(!fs.existsSync(file), 'ファイルを消す')
})

test('PUT config: 環境変数の置き換えの形（${…}・$(…)）は 422 で、保存しない', async () => {
  // 戻すと落ちるもの: config-fields.js の checkField の text から ENV_REF の判定を外す
  const c = makeCtx()
  const { seq } = makeAdapter(c.registry, 'env-a', { meta: { mode: 'simulator' } })
  const url = B + '/adapters/env-a/config'
  const before = (await req(c, 'GET', url)).body
  const r = await req(c, 'PUT', url, {
    body: { name: '${WSUHA_BROUTE_PASSWORD_OTHERKEY}' },
    headers: { 'content-type': 'application/json', 'if-match': `"${before.rev}"`, origin: 'http://127.0.0.1:1880', host: '127.0.0.1:1880' },
  })
  assert.equal(r.statusCode, 422, r.text)
  assert.equal(r.body.error.code, 'VALIDATION')
  assert.match(r.body.error.details.name, /環境変数/, r.text)
  assert.equal((await req(c, 'GET', url)).body.rev, before.rev, '保存しない')
  await seq.destroy()
})

test('GET serialports: by-id を先に・使っている台（ownedBy）・シミュレータの候補が最後に 1 つ', async () => {
  // 戻すと落ちるもの: service.js の serialPorts でシミュレータの候補を足さない・ownedBy を付けない
  const r = await req(ctx, 'GET', B + '/serialports')
  assert.equal(r.statusCode, 200, r.text)
  const items = r.body.items
  assert.equal(typeof r.body.at, 'number')
  assert.equal(items[0].path, BYID)
  assert.equal(items[0].byId, true)
  const usb0 = items.find((x) => x.path === '/dev/ttyUSB0')
  assert.deepEqual(usb0.ownedBy, { id: 'cfg-b', name: '動力メーター' })
  assert.deepEqual(usb0.usedBy, { kind: 'adapter', id: 'cfg-b', name: '動力メーター', type: 'wsuha-device' })
  // 同じ機器は 1 つにまとめる: ttyUSB1 は by-id の候補の aliases に入る
  assert.equal(items.find((x) => x.path === '/dev/ttyUSB1'), undefined)
  assert.ok(items[0].aliases.includes('/dev/ttyUSB1'), JSON.stringify(items[0]))
  assert.equal(items[0].ownedBy, null)
  const last = items[items.length - 1]
  assert.equal(last.path, 'simulator')
  assert.equal(last.simulator, true)
  assert.equal(items.filter((x) => x.simulator).length, 1)
  for (const it of items) {
    assert.deepEqual(Object.keys(it).sort(), ['aliases', 'byId', 'byIdPath', 'hint', 'kind', 'label', 'manufacturer', 'ownedBy', 'path', 'portLabel', 'productId', 'realPath', 'serialNumber', 'simulator', 'usedBy', 'vendorId'])
  }
})

test('SSE の config: 構成を保存したら全部の接続へ {adapterId, config}。値は入らない', async () => {
  // 戻すと落ちるもの: sse.js の ALL に config を入れない・registry の 'config' を購読しない
  const s = ctx.fake.openStream(B + '/stream')
  await s.done
  const rev = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
  const ok = await req(ctx, 'PUT', B + '/adapters/cfg-a/config', { body: { role: '電灯' }, headers: { 'if-match': rev } })
  assert.equal(ok.statusCode, 200)
  const frames = () => parseSse(s.res.text).filter((f) => f.event === 'config')
  await waitFor(() => frames().some((f) => f.data.adapterId === 'cfg-a' && f.data.config.fields.role.value === '電灯'), 3000, 'SSE の config')
  await req(ctx, 'PUT', B + '/adapters/cfg-a/credentials', { body: { routeBId: ID, routeBPassword: PW } })
  await waitFor(() => frames().some((f) => f.data.config.credentials.stored), 3000, '認証情報を保存したあとの config')
  seen.push(s.res.text)
  s.req.emit('close')
  await req(ctx, 'DELETE', B + '/adapters/cfg-a/credentials')
  const rev2 = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
  await req(ctx, 'DELETE', B + '/adapters/cfg-a/config', { headers: { 'if-match': rev2 } })
})

test('守り: 構成と認証情報の書き込みにも 415・BAD_ORIGIN・BAD_HOST（12.1 の全部）', async () => {
  const rev = (await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev
  for (const [m, u, body, h] of [
    ['PUT', '/adapters/cfg-a/config', { name: 'x' }, { 'if-match': rev }],
    ['DELETE', '/adapters/cfg-a/config', undefined, { 'if-match': rev }],
    ['PUT', '/adapters/cfg-a/credentials', { routeBId: ID, routeBPassword: PW }, {}],
    ['DELETE', '/adapters/cfg-a/credentials', undefined, {}],
  ]) {
    const t = await req(ctx, m, B + u, { body, headers: Object.assign({ 'content-type': 'text/plain' }, h) })
    assert.equal(t.statusCode, 415, `${m} ${u}`)
    const o = await req(ctx, m, B + u, { body, headers: Object.assign({ origin: 'http://evil.example' }, h) })
    assert.equal(o.statusCode, 403, `${m} ${u}`)
    assert.equal(o.body.error.code, 'BAD_ORIGIN')
    const hh = await req(ctx, m, B + u, { body, headers: Object.assign({ host: 'evil.example.com' }, h) })
    assert.equal(hh.statusCode, 403)
    assert.equal(hh.body.error.code, 'BAD_HOST')
  }
  const g = await req(ctx, 'GET', B + '/adapters/cfg-a/config', { headers: { host: 'evil.example.com' } })
  assert.equal(g.body.error.code, 'BAD_HOST', '読み出しも BAD_HOST')
  assert.equal((await req(ctx, 'GET', B + '/serialports', { headers: { host: 'evil.example.com' } })).statusCode, 403)
  assert.equal((await req(ctx, 'GET', B + '/adapters/cfg-a/config')).body.rev, rev, '何も変わらない')
})

test('403 CONFIG_LOCKED（wsuhaBroute.uiConfig === false）: 構成と認証情報の書き込みだけを断る。読み出し・運用設定・操作は今までどおり。readOnly は 403 READ_ONLY', async () => {
  // 戻すと落ちるもの: http-api.js の requireConfigWritable を外す
  const c = makeCtx({ wsuhaBroute: { uiConfig: false } })
  const a = makeAdapter(c.registry, 'lock-a', { name: '鍵' })
  try {
    const g = await req(c, 'GET', B + '/adapters/lock-a/config')
    assert.equal(g.statusCode, 200)
    assert.equal(g.body.locked, true)
    assert.match(g.body.lockedReason, /uiConfig/)
    assert.equal((await req(c, 'GET', B + '/meta')).body.configLocked, true)
    for (const [m, u, body, h] of [
      ['PUT', '/adapters/lock-a/config', { name: 'x' }, { 'if-match': '0' }],
      ['DELETE', '/adapters/lock-a/config', undefined, { 'if-match': '0' }],
      ['PUT', '/adapters/lock-a/credentials', { routeBId: ID, routeBPassword: PW }, {}],
      ['DELETE', '/adapters/lock-a/credentials', undefined, {}],
    ]) {
      const r = await req(c, m, B + u, { body, headers: h })
      assert.equal(r.statusCode, 403, `${m} ${u}: ${r.text}`)
      assert.equal(r.body.error.code, 'CONFIG_LOCKED')
    }
    assert.ok(!fs.existsSync(path.join(c.userDir, 'wsuha-broute', 'credentials')), '保存しない')
    const srev = (await req(c, 'GET', B + '/adapters/lock-a/settings')).body.rev
    const s = await req(c, 'PUT', B + '/adapters/lock-a/settings', { body: { pollIntervalSec: 60 }, headers: { 'if-match': srev } })
    assert.equal(s.statusCode, 200, '運用設定は変えられる')
    const crb = await req(c, 'POST', B + '/adapters/lock-a/actions/clear-radio-block')
    assert.equal(crb.statusCode, 200, '操作はできる')
  } finally {
    c.rt.hub.dispose()
    await a.seq.destroy()
  }
  const ro = makeCtx({ wsuhaBroute: { readOnly: true } })
  const a2 = makeAdapter(ro.registry, 'ro-a', { name: '読むだけ' })
  try {
    const r = await req(ro, 'PUT', B + '/adapters/ro-a/config', { body: { name: 'x' }, headers: { 'if-match': '0' } })
    assert.equal(r.statusCode, 403)
    assert.equal(r.body.error.code, 'READ_ONLY')
    const rc = await req(ro, 'PUT', B + '/adapters/ro-a/credentials', { body: { routeBId: ID, routeBPassword: PW } })
    assert.equal(rc.body.error.code, 'READ_ONLY')
    assert.equal((await req(ro, 'GET', B + '/adapters/ro-a/config')).statusCode, 200)
  } finally {
    ro.rt.hub.dispose()
    await a2.seq.destroy()
  }
})

test('全部の応答・SSE のフレーム・ログ・監査に、認証 ID とパスワードが出ない（試験で見たもの全部を探す）', () => {
  const text = seen.join('\n') + JSON.stringify(ctx.fake.logs)
  for (const s of [ID, PW, ID.toLowerCase(), PW.toLowerCase(), ID.slice(0, 4) + '…' + ID.slice(-4)]) {
    assert.ok(!text.includes(s), `秘密（${s.slice(0, 4)}…）が出ている`)
  }
  assert.ok(seen.length > 30, '探したものが十分にある')
})
