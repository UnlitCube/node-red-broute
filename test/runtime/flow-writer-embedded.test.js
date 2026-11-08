'use strict'

// 本物の Node-RED に載せて確かめる（偽の RED と偽の flow-writer では見えなかったものを見る）。
//  - 足せる・足した台が動く・flows_cred.json が変わらない・ほかの台が止まらない
//  - エディタと同じ形のデプロイで作り直されない
//  - ${…} が環境変数に置き換わらない（POST も PUT も 422）
//  - セーフモードを抜けたら、再起動なしで足せる
//  - 無効のタブに足すと warnings で知らせる
//  - serialport が無いサーバーの health と GET serialports
//
// 本物の Node-RED が入っていない環境（ふつうの開発機）では飛ばす。流し方:
//   WSUHA_TEST_NODE_RED=<node-red の入ったディレクトリ> node --test test/runtime/flow-writer-embedded.test.js
//   Node-RED の公式の Docker イメージの中（/usr/src/node-red）では、指定しなくても流れる

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { skip, sleep, until, boot: bootRed } = require('./embedded-kit')
const { loadDefinition } = require('./html-defaults')
const { VERIFIED_VERSIONS } = require('../../lib/runtime/flow-writer')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const OTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'
const THIRD_ID = 'ABCDEF0123456789ABCDEF0123456789'
const PW = 'ABCDEF123456'
const A = '/wsuha-broute/api/v1'
const SIM_OPTIONS = { latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, echonetDelayMs: 5 }

/** 本物の Node-RED を立てて、管理 API の v2 の形の読み書きを足す。 */
async function boot(flows, opt) {
  const server = await bootRed(flows, opt)
  const j = server.j
  return Object.assign(server, {
    /** 管理 API の v2 の形（{flows, rev}）。 */
    flows: async () => (await j('GET', '/admin/flows', undefined, { 'node-red-api-version': 'v2' })).body,
    deploy: async (flows2, rev, type) => {
      const r = await j('POST', '/admin/flows', { flows: flows2, rev }, { 'node-red-api-version': 'v2', 'node-red-deployment-type': type || 'nodes' })
      assert.equal(r.status, 200, r.text)
      return r.body
    },
    adapter: async (id) => (await j('GET', `${A}/adapters/${id}`)).body,
  })
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'なし')

/** エディタが読み込んで書き出す形（html の defaults の名前と id・type・z・x・y・wires だけ）。 */
function asEditorWrites(flows) {
  const keep = {
    'wsuha-device': Object.keys(loadDefinition('wsuha-device').defaults).concat(['id', 'type']),
    'wsuha-broute': Object.keys(loadDefinition('wsuha-broute').defaults).concat(['id', 'type', 'z', 'x', 'y', 'wires']),
  }
  return flows.map((n) => {
    const k = keep[n.type]
    if (!k) return n
    const out = {}
    for (const name of k) if (n[name] !== undefined) out[name] = n[name]
    return out
  })
}

const BASE_FLOWS = [
  { id: 'tA', type: 'tab', label: 'A', disabled: false },
  { id: 'inj', type: 'inject', z: 'tA', name: 'x', props: [], repeat: '', once: false, x: 100, y: 100, wires: [[]] },
]

// --- 足す・止めない・作り直さない ---------------------------------------------

let s = null
let firstId = null
let added = null

before(async () => {
  if (skip) return
  // シミュレーターの 1 台（認証情報を flows_cred.json に持つ）を先に動かしておく
  const device = Object.assign({}, require('../../lib/runtime/flow-writer').DEVICE_DEFAULTS, {
    id: 'dev0',
    type: 'wsuha-device',
    role: '電力',
    mode: 'simulator',
    simulatorOptions: JSON.stringify(Object.assign({ pairId: ID.slice(-8) }, SIM_OPTIONS)),
  })
  const flows = BASE_FLOWS.concat([
    device,
    Object.assign({}, require('../../lib/runtime/flow-writer').BROUTE_DEFAULTS, { id: 'brt0', type: 'wsuha-broute', z: 'tA', device: 'dev0', x: 300, y: 100, wires: [[], []] }),
  ])
  s = await boot(BASE_FLOWS, { env: { WSUHA_TEST_FAKE_SECRET: 'fake-secret-value', WSUHA_BROUTE_PASSWORD_OTHERKEY: PW } })
  const cur = await s.flows()
  const withCred = flows.map((n) => (n.id === 'dev0' ? Object.assign({}, n, { credentials: { routeBId: ID, routeBPassword: PW } }) : n))
  await s.deploy(withCred, cur.rev, 'full')
  firstId = 'dev0'
  await until(async () => (await s.adapter(firstId)).connected, '1 台目の接続')
})

after(async () => {
  if (s) await s.close()
})

test('足す: 201・動き出す・タブと 2 つのノードがフローに入る。flows_cred.json は変わらず、ほかの台は止まらない', { skip }, async () => {
  // 戻すと落ちるもの: flow-writer.js の setFlows の deploymentType を 'full' にする（1 台目の phaseSince が変わる）
  assert.match(s.version, VERIFIED_VERSIONS, 'この試験は確かめた版で流す')
  const meta = (await s.j('GET', A + '/meta')).body
  assert.equal(meta.addAdapter.available, true, JSON.stringify(meta.addAdapter))
  assert.equal(meta.nodeRed, s.version)

  const before1 = await s.adapter(firstId)
  const cred = sha(s.file('flows_cred.json'))
  assert.notEqual(cred, 'なし', '前提: 1 台目の認証情報が入っている')

  const r = await s.j('POST', A + '/adapters', { role: '動力', mode: 'simulator', routeBId: OTHER_ID, routeBPassword: PW })
  assert.equal(r.status, 201, r.text)
  assert.equal(r.body.started, true)
  assert.equal(r.body.nodes.tabCreated, true)
  assert.deepEqual(r.body.warnings, [])
  added = r.body.nodes

  // 画面から足した台のシミュレーターは既定の速さで探すので、接続まで時間が掛かる
  const a = await until(async () => {
    const x = await s.adapter(added.deviceId)
    return x.consumers === 1 && x.connected ? x : null
  }, '足した台の接続', 120000)
  assert.equal(a.role, '動力')

  const { flows } = await s.flows()
  const dev = flows.find((n) => n.id === added.deviceId)
  const brt = flows.find((n) => n.id === added.brouteId)
  const tab = flows.find((n) => n.id === added.tabId)
  assert.equal(tab.type, 'tab')
  assert.equal('z' in dev, false)
  assert.equal(brt.z, tab.id)
  assert.equal(brt.device, dev.id)
  assert.ok(!JSON.stringify(flows).includes(OTHER_ID) && !JSON.stringify(flows).includes(PW), '認証情報をフローに入れない')

  assert.equal(sha(s.file('flows_cred.json')), cred, 'flows_cred.json を書き換えない')
  const after1 = await s.adapter(firstId)
  assert.equal(after1.phaseSince, before1.phaseSince, 'ほかの台は作り直されない')
  assert.equal(after1.counters.joins, before1.counters.joins)
  assert.equal(after1.connected, true)
})

test('エディタと同じ形でほかのノードをデプロイしても、足した台もほかの台も作り直されない', { skip }, async () => {
  // 足した台の項目が html の defaults とずれると、エディタのデプロイで「変わった」と判定されて作り直される。
  // 戻すと落ちるもの: flow-writer.js の DEVICE_DEFAULTS・BROUTE_DEFAULTS から項目を消す・余分な項目を書く
  assert.ok(added, '前の試験で足した')
  const a0 = await s.adapter(added.deviceId)
  const b0 = await s.adapter(firstId)
  const { flows, rev } = await s.flows()
  const edited = asEditorWrites(flows).map((n) => (n.id === 'inj' ? Object.assign({}, n, { name: '名前を変えた' }) : n))
  await s.deploy(edited, rev, 'nodes')
  await sleep(1500)
  const a1 = await s.adapter(added.deviceId)
  const b1 = await s.adapter(firstId)
  assert.equal(a1.phaseSince, a0.phaseSince, '足した台が作り直された')
  assert.equal(b1.phaseSince, b0.phaseSince, 'ほかの台が作り直された')
  assert.equal(a1.counters.joins, a0.counters.joins)
  assert.equal(a1.connected, true)
  assert.equal(a1.consumers, 1)
})

test('2 台目を足しても、足してある台は止まらない。同じタブへ入り、下へ並ぶ', { skip }, async () => {
  const a0 = await s.adapter(added.deviceId)
  const r = await s.j('POST', A + '/adapters', { role: '三台目', mode: 'simulator' })
  assert.equal(r.status, 201, r.text)
  assert.equal(r.body.nodes.tabId, added.tabId)
  assert.equal(r.body.nodes.tabCreated, false)
  const a1 = await s.adapter(added.deviceId)
  assert.equal(a1.phaseSince, a0.phaseSince)
  const { flows } = await s.flows()
  const ys = flows.filter((n) => n.z === added.tabId).map((n) => n.y)
  assert.equal(new Set(ys).size, ys.length, ys.join(','))
})

test('${…} と $(…) は、本物の Node-RED でも 422。環境変数の値が画面に出ない', { skip }, async () => {
  // 戻すと落ちるもの: config-fields.js の checkField の text から ENV_REF の判定を外す（201 で値が読める）
  for (const body of [
    { role: '${WSUHA_TEST_FAKE_SECRET}', mode: 'simulator' },
    { role: '電力', name: '$(WSUHA_BROUTE_PASSWORD_OTHERKEY)', mode: 'simulator' },
  ]) {
    const r = await s.j('POST', A + '/adapters', body)
    assert.equal(r.status, 422, r.text)
    assert.equal(r.body.error.code, 'VALIDATION')
  }
  const c = (await s.j('GET', `${A}/adapters/${firstId}/config`)).body
  const put = await s.j('PUT', `${A}/adapters/${firstId}/config`, { name: '${WSUHA_TEST_FAKE_SECRET}' }, { 'if-match': `"${c.rev}"` })
  assert.equal(put.status, 422, put.text)
  const all = (await s.j('GET', A + '/adapters')).text
  assert.ok(!all.includes('fake-secret-value') && !all.includes(PW), '環境変数の値が一覧に出ている')
  // 一部だけなら Node-RED は置き換えない（名前として受ける）
  const part = await s.j('POST', A + '/adapters', { role: 'x${WSUHA_TEST_FAKE_SECRET}', mode: 'simulator' })
  assert.equal(part.status, 201, part.text)
  assert.equal(part.body.adapter.role, 'x${WSUHA_TEST_FAKE_SECRET}')
})

test('足した台の認証情報を入れ直しても、シミュレーターはつながる（PairID を固定しない）', { skip }, async () => {
  // 戻すと落ちるもの: service.js の writeAdapter で simulatorOptions に pairId を入れる（前の ID のままで見つからない）
  const r = await s.j('PUT', `${A}/adapters/${added.deviceId}/credentials`, { routeBId: THIRD_ID, routeBPassword: PW })
  assert.equal(r.status, 200, r.text)
  // 効いている認証情報は保存の直後に変わるので、メーターの側の値で「つなぎ直した」を見る
  const a = await until(async () => {
    const x = await s.adapter(added.deviceId)
    return x.connected && x.meter.pairId === THIRD_ID.slice(-8) ? x : null
  }, '入れ直したあとの接続', 120000)
  assert.equal(a.credentials.pairId, THIRD_ID.slice(-8))
})

test('認証情報を入れてから無効にした台: 詳細の configured と Config の configured が同じ', { skip }, async () => {
  // 戻すと落ちるもの: view-model.js の buildDetail で credentialState を見ない（false と true に分かれる）
  const c = (await s.j('GET', `${A}/adapters/${added.deviceId}/config`)).body
  assert.equal(c.credentials.configured, true)
  const r = await s.j('PUT', `${A}/adapters/${added.deviceId}/config`, { enabled: false }, { 'if-match': `"${c.rev}"` })
  assert.equal(r.status, 200, r.text)
  const d = await until(async () => {
    const x = await s.adapter(added.deviceId)
    return x.enabled === false && x.running === false ? x : null
  }, '無効にする')
  assert.equal(d.credentials.configured, true, JSON.stringify(d.credentials))
  assert.equal(d.credentials.pairId, THIRD_ID.slice(-8))
  assert.equal((await s.j('GET', `${A}/adapters/${added.deviceId}/config`)).body.credentials.configured, true)
})

test('serialport が無いサーバー: USB の切断と言わず、Require stack を出さない。候補の欄に理由を返す', { skip }, async (t) => {
  // 戻すと落ちるもの: health.js の SERIALPORT_MISSING の分岐を外す・sequencer が lastError の code を落とす
  const ports = (await s.j('GET', A + '/serialports')).body
  if (ports.serialportAvailable !== false) {
    t.skip('このサーバーには serialport が入っています')
    return
  }
  assert.match(ports.serialportMessage, /npm install serialport@12/)
  const r = await s.j('POST', A + '/adapters', { role: '実機', mode: 'serial', serialport: '/dev/ttyUSB9', routeBId: THIRD_ID, routeBPassword: PW })
  assert.equal(r.status, 201, r.text)
  const id = r.body.nodes.deviceId
  const d = await until(async () => {
    const x = await s.adapter(id)
    return x.lastError ? x : null
  }, '直近のエラー')
  assert.equal(d.health.title, 'serialport が入っていません', JSON.stringify(d.health))
  assert.match(d.health.nextAction, /npm install serialport@12/)
  assert.ok(!/Require stack|node_modules|\/usr\/src/.test(JSON.stringify(d)), '絶対パスが API に出ている')
  assert.match(d.lastError.hint, /npm install serialport@12/)
})

// --- ほかの筋書き（別の Node-RED） ---------------------------------------------

test('セーフモード: 起動の直後は 409 FLOWS_LOCKED。フローを開始したら、再起動なしで足せる', { skip }, async () => {
  // 起動時の設定の写しが残るので、案内どおりに開始しても再起動するまで足せなかった。
  // 戻すと落ちるもの: flow-writer.js の availability で RED.settings.safeMode を先に見る
  const n = await boot(BASE_FLOWS, { safe: true })
  try {
    const m0 = (await n.j('GET', A + '/meta')).body.addAdapter
    assert.equal(m0.available, false)
    assert.match(m0.reason, /セーフモード/)
    const r0 = await n.j('POST', A + '/adapters', { role: '電力', mode: 'simulator' })
    assert.equal(r0.status, 409, r0.text)
    assert.equal(r0.body.error.code, 'FLOWS_LOCKED')
    const cur = await n.flows()
    await n.deploy(cur.flows, cur.rev, 'full')
    await until(async () => (await n.j('GET', A + '/meta')).body.addAdapter.available, 'フローの開始')
    const r1 = await n.j('POST', A + '/adapters', { role: '電力', mode: 'simulator' })
    assert.equal(r1.status, 201, r1.text)
  } finally {
    await n.close()
  }
})

test('無効のタブが置き場所なら、足せるが B ルートノードは動かない。warnings で知らせ、タブの名前は利用者のもの', { skip }, async () => {
  // 201 と「追加しました」だけで、出力が流れない理由が分からなかった。
  // 戻すと落ちるもの: service.js の writeAdapter で added.tabDisabled を見ない
  const n = await boot(BASE_FLOWS)
  try {
    const first = await n.j('POST', A + '/adapters', { role: '電力', mode: 'simulator' })
    assert.equal(first.status, 201, first.text)
    const { flows, rev } = await n.flows()
    const renamed = flows.map((x) => (x.id === first.body.nodes.tabId ? Object.assign({}, x, { disabled: true, label: '休止中' }) : x))
    await n.deploy(renamed, rev, 'full')
    const r = await n.j('POST', A + '/adapters', { role: '動力', mode: 'simulator' })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.nodes.tabId, first.body.nodes.tabId)
    assert.equal(r.body.adapter.consumers, 0)
    assert.equal(r.body.warnings.length, 1, r.text)
    assert.match(r.body.warnings[0], /「休止中」が無効です/)
  } finally {
    await n.close()
  }
})
