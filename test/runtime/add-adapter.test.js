'use strict'

// アダプタの追加。画面の POST adapters と、フローの入力 add-adapter が service.addAdapter を通る。
// flow-writer（本物の Node-RED の runtime API）は偽物に替える。本物は flow-writer-embedded.test.js で確かめる。

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { createFakeRed, tmpDir, ID, PW } = require('./fake-red')
const { createRegistry } = require('../../lib/runtime/registry')
const { install } = require('../../lib/runtime/http-api')
const { makeAdapter } = require('./adapter-kit')
const cf = require('../../lib/runtime/config-fields')

const B = '/wsuha-broute/api/v1'
const ORIGIN = 'http://127.0.0.1:1880'
const OTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'

const opened = []
after(async () => {
  for (const o of opened) await o.close()
})

function fakeWriter(over) {
  let n = 0
  const calls = []
  return Object.assign(
    {
      calls,
      availability: () => ({ available: true, reason: null }),
      newId: () => 'new' + ++n,
      flowsState: () => 'stop',
      add: async (spec) => {
        calls.push(spec)
        return { brouteId: spec.brouteId, tabId: 'tab1', tabLabel: 'B ルート（Web UI で追加）', tabCreated: true }
      },
    },
    over,
  )
}

function makeCtx({ writer, settings, env, tokens } = {}) {
  const userDir = tmpDir('wsuha-add-')
  const fake = createFakeRed({ userDir, settings: settings || {}, env, tokens })
  const registry = createRegistry()
  const w = writer === undefined ? fakeWriter() : writer
  const rt = install(fake.RED, {
    registry,
    uiDir: tmpDir('wsuha-add-ui-'),
    diagIntervalMs: 0,
    sse: { throttleMs: 20, pingMs: 60000, maxAgeMs: 600000 },
    flowWriter: w,
    listPorts: async () => [],
  })
  const ctx = { userDir, fake, registry, rt, writer: w, close: async () => rt.close && rt.close() }
  opened.push(ctx)
  return ctx
}

const post = (c, body, headers) =>
  c.fake.request('POST', B + '/adapters', { body, headers: Object.assign({ 'content-type': 'application/json', origin: ORIGIN, host: '127.0.0.1:1880' }, headers) })

const SIM = { role: '動力', mode: 'simulator' }
const SERIAL = { role: '電力', mode: 'serial', serialport: '/dev/ttyUSB7' }

test('POST adapters: 誰が足したかを監査と flows.set へ渡す（本文は入れない）', async () => {
  // ほかの書き込みには Node-RED が user を足すのに、flows.json を変える追加だけ誰の操作か分からなかった。
  // 戻すと落ちるもの: http-api.js の handlers.addAdapter で reqLog を渡さない・service.js の audit か flowWriter.add に渡さない
  const c = makeCtx({ settings: { adminAuth: { type: 'credentials' } }, tokens: { 'tok-admin': { username: 'admin', permissions: '*' } } })
  const r = await post(c, Object.assign({}, SIM, { routeBId: ID, routeBPassword: PW }), { 'x-wsuha-editor-token': 'tok-admin' })
  assert.equal(r.statusCode, 202, r.text)
  const audit = c.fake.logs.filter(([l, t]) => l === 'audit' && /wsuha-broute\.adapter\.add/.test(t)).map(([, t]) => JSON.parse(t))
  assert.equal(audit.length, 1)
  assert.equal(audit[0].user.username, 'admin')
  assert.equal(audit[0].path, B + '/adapters')
  assert.equal(audit[0].adapterId, 'new1')
  assert.equal(audit[0].by, 'web-ui')
  const log = c.writer.calls[0].reqLog
  assert.equal(log.user.username, 'admin')
  assert.equal(log.path, B + '/adapters')
  const all = JSON.stringify(c.fake.logs) + JSON.stringify(log)
  assert.ok(!all.includes(ID) && !all.includes(PW), '監査に本文を入れない')
})

test('POST adapters: フローに足す（名前は空のまま）。動き出す前は 202・nodes に id。認証情報はフローの本文に入れない', async () => {
  const c = makeCtx()
  const r = await post(c, Object.assign({}, SERIAL, { routeBId: ID, routeBPassword: PW }))
  assert.equal(r.statusCode, 202, r.text)
  assert.equal(r.body.started, false)
  assert.equal(r.body.adapter, null)
  assert.equal(r.body.nodes.deviceId, 'new1')
  assert.equal(r.body.nodes.brouteId, 'new2')
  assert.equal(c.writer.calls.length, 1)
  const spec = c.writer.calls[0]
  assert.equal(spec.device.name, '', '名前を自動で埋めない（「[電力] 電力」に戻るため）')
  assert.equal(spec.device.role, '電力')
  assert.equal(spec.device.serialport, '/dev/ttyUSB7')
  assert.equal(spec.device.deviceKey, '', 'デバイスキーを提案しない（環境変数を黙って拾うため）')
  const text = JSON.stringify(spec) + r.text
  assert.equal(text.includes(ID) || text.includes(PW), false, 'フローの本文と応答に値を入れない')
})

test('シミュレーターの台に固定の PairID を書かない（あとで認証情報を変えると、メーターが見つからなくなるため）', async () => {
  // 戻すと落ちるもの: service.js の writeAdapter で simulatorOptions に pairId を入れる
  const c = makeCtx()
  const r = await post(c, Object.assign({}, SIM, { routeBId: ID, routeBPassword: PW }))
  assert.equal(r.statusCode, 202, r.text)
  assert.equal(c.writer.calls[0].device.simulatorOptions, '')
})

test('POST adapters の検証: 契約は必須・実機はポートが必須・知らない項目は 422・認証情報は片方だけ断る', async () => {
  const c = makeCtx()
  for (const [body, field] of [
    [{ mode: 'simulator' }, 'role'],
    [{ role: '電力', mode: 'serial' }, 'serialport'],
    [Object.assign({}, SIM, { foo: 1 }), 'foo'],
    [Object.assign({}, SIM, { routeBId: ID }), 'routeBPassword'],
    [Object.assign({}, SIM, { routeBId: 'XYZ', routeBPassword: PW }), 'routeBId'],
  ]) {
    const r = await post(c, body)
    assert.equal(r.statusCode, 422, r.text)
    assert.equal(r.body.error.code, 'VALIDATION')
    assert.ok(r.body.error.details[field], field + ': ' + r.text)
  }
  assert.equal(c.writer.calls.length, 0, '書かない')
})

test('環境変数の置き換えの形（${…}・$(…)）は、画面の POST でもフローの add-adapter でも 422 で、フローへ書かない', async () => {
  // 設定ノードの role と name へそのまま書くと、Node-RED が環境変数の値に置き換え、一覧に出る（ほかの台のパスワードまで読める）。
  // 戻すと落ちるもの: config-fields.js の checkField の text から ENV_REF の判定を外す
  const c = makeCtx()
  for (const body of [
    { role: '${NODE_RED_HOME}', mode: 'simulator' },
    { role: '電力', name: '$(NODE_RED_CREDENTIAL_SECRET)', mode: 'simulator' },
  ]) {
    const r = await post(c, body)
    assert.equal(r.statusCode, 422, r.text)
    assert.equal(r.body.error.code, 'VALIDATION')
    await assert.rejects(c.rt.service.addAdapter(body, { by: 'flow:試験' }), (e) => e.status === 422 && e.code === 'VALIDATION')
  }
  assert.equal(c.writer.calls.length, 0, '書かない')
})

test('置き場所のタブが無効なら、足せても warnings で知らせる（B ルートノードは動かない。タブの名前は利用者の付けたもの）', async () => {
  // 戻すと落ちるもの: service.js の writeAdapter で added.tabDisabled を見ない
  const w = fakeWriter({ add: async (spec) => ({ brouteId: spec.brouteId, tabId: 't', tabLabel: '休止中のタブ', tabCreated: false, tabDisabled: true }) })
  const c = makeCtx({ writer: w })
  const r = await post(c, SIM)
  assert.equal(r.statusCode, 202, r.text)
  assert.equal(r.body.warnings.length, 1, r.text)
  assert.match(r.body.warnings[0], /「休止中のタブ」が無効です/)
  const ok = makeCtx()
  assert.deepEqual((await post(ok, SIM)).body.warnings, [], '有効なタブなら何も出さない')
})

test('守りの順: 415 → BAD_ORIGIN → READ_ONLY → CONFIG_LOCKED。uiAddAdapter: false と uiConfig: false は 403', async () => {
  const c = makeCtx()
  const noType = await c.fake.request('POST', B + '/adapters', { body: SIM, headers: { 'content-type': 'text/plain', origin: ORIGIN, host: '127.0.0.1:1880' } })
  assert.equal(noType.statusCode, 415, noType.text)
  const bad = await post(c, SIM, { origin: 'http://evil.example' })
  assert.equal(bad.statusCode, 403, bad.text)
  assert.equal(bad.body.error.code, 'BAD_ORIGIN')
  const ro = makeCtx({ settings: { wsuhaBroute: { readOnly: true } } })
  const r1 = await post(ro, SIM)
  assert.equal(r1.statusCode, 403, r1.text)
  assert.equal(r1.body.error.code, 'READ_ONLY')
  for (const s of [{ uiAddAdapter: false }, { uiConfig: false }]) {
    const k = makeCtx({ settings: { wsuhaBroute: s } })
    const r = await post(k, SIM)
    assert.equal(r.statusCode, 403, r.text)
    assert.equal(r.body.error.code, 'CONFIG_LOCKED')
    assert.equal(k.writer.calls.length, 0)
  }
})

test('使えないとき: 実体が無ければ 503 NOT_AVAILABLE、セーフモードなどは 409 FLOWS_LOCKED。Meta.addAdapter にも理由', async () => {
  const none = makeCtx({ writer: fakeWriter({ availability: () => ({ available: false, code: 'NOT_AVAILABLE', reason: '確かめていない版です' }) }) })
  const r = await post(none, SIM)
  assert.equal(r.statusCode, 503, r.text)
  assert.equal(r.body.error.code, 'NOT_AVAILABLE')
  const meta = (await none.fake.request('GET', B + '/meta')).body.addAdapter
  assert.equal(meta.available, false)
  assert.equal(meta.reason, '確かめていない版です')
  assert.equal(meta.limit, 8)
  const safe = makeCtx({ writer: fakeWriter({ availability: () => ({ available: false, code: 'FLOWS_LOCKED', reason: 'セーフモードです' }) }) })
  const r2 = await post(safe, SIM)
  assert.equal(r2.statusCode, 409, r2.text)
  assert.equal(r2.body.error.code, 'FLOWS_LOCKED')
})

test('409: ほかの台のポート・デバイスキー・同じ認証 ID は足さない。台数の上限は 8', async () => {
  const c = makeCtx()
  makeAdapter(c.registry, 'a1', { name: '一階', routeBId: OTHER_ID, meta: { mode: 'serial', port: '/dev/ttyUSB7', portLabel: 'USB7', deviceKey: 'one' } })
  const p = await post(c, SERIAL)
  assert.equal(p.statusCode, 409, p.text)
  assert.equal(p.body.error.code, 'PORT_IN_USE')
  assert.match(p.body.error.message, /一階/)
  const k = await post(c, Object.assign({}, SIM, { deviceKey: 'one' }))
  assert.equal(k.statusCode, 409, k.text)
  assert.equal(k.body.error.code, 'DEVICE_KEY_IN_USE')
  const q = await post(c, { role: '電力', mode: 'serial', serialport: '/dev/ttyUSB8', routeBId: OTHER_ID, routeBPassword: PW })
  assert.equal(q.statusCode, 409, q.text)
  assert.equal(q.body.error.code, 'PAIR_IN_USE')
  assert.equal(JSON.stringify(q.body).includes(OTHER_ID), false, '応答に ID を入れない')
  assert.equal(c.writer.calls.length, 0)

  const full = makeCtx()
  for (let i = 0; i < 8; i++) makeAdapter(full.registry, 'f' + i, { name: '台' + i, routeBId: OTHER_ID.slice(0, 31) + i, meta: { deviceKey: 'k' + i } })
  const l = await post(full, SIM)
  assert.equal(l.statusCode, 409, l.text)
  assert.equal(l.body.error.code, 'LIMIT_REACHED')
})

test('書けなかったら、先に保存した認証情報を消す。次の追加は通る（1 本ずつの枠を残さない）', async () => {
  let fail = true
  const w = fakeWriter({
    add: async (spec) => {
      if (fail) throw new Error('disk full')
      return { brouteId: spec.brouteId, tabId: 't', tabLabel: 'x', tabCreated: false }
    },
  })
  const c = makeCtx({ writer: w })
  const r = await post(c, Object.assign({}, SIM, { routeBId: ID, routeBPassword: PW }))
  assert.equal(r.statusCode, 500, r.text)
  assert.equal(r.text.includes('disk full'), false, '内部の文言を返さない')
  const fs = require('node:fs')
  const path = require('node:path')
  const dir = path.join(c.userDir, 'wsuha-broute', 'credentials')
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], '認証情報を残さない')
  fail = false
  assert.equal((await post(c, SIM)).statusCode, 202)
})

test('tier: 構成の全部の項目にあり、基本設定と詳細設定の割り振りが決めたとおり', () => {
  const basic = Object.keys(cf.CONFIG_FIELDS).filter((k) => cf.CONFIG_FIELDS[k].tier === 'basic')
  assert.deepEqual(basic, ['role', 'name', 'mode', 'serialport'])
  for (const k of Object.keys(cf.CONFIG_FIELDS)) assert.ok(['basic', 'advanced'].includes(cf.CONFIG_FIELDS[k].tier), k)
})

test('portLabelOf: ttyACM は ACMn・by-id は実体から・空・シミュレーター', () => {
  assert.equal(cf.portLabelOf('serial', '/dev/ttyUSB0'), 'USB0')
  assert.equal(cf.portLabelOf('serial', '/dev/ttyACM1'), 'ACM1')
  assert.equal(cf.portLabelOf('serial', 'COM3'), 'COM3')
  assert.equal(cf.portLabelOf('serial', '/dev/serial/by-id/usb-FTDI_FT230X_Basic_UART_DEADBEEF-if00-port0', '/dev/ttyUSB2'), 'USB2')
  assert.equal(cf.portLabelOf('simulator', ''), 'シミュレーター')
  assert.equal(cf.portLabelOf('serial', ''), 'ポート未設定')
  const cut = cf.portLabelOf('serial', '/dev/serial/by-id/usb-FTDI_FT230X_Basic_UART_DEADBEEF-if00-port0')
  assert.ok(cut.startsWith('…') || cut.endsWith('…'), cut)
})
