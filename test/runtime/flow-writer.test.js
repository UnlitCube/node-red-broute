'use strict'

// lib/runtime/flow-writer.js の本物のコード（add-adapter.test.js は偽物に替えているので、ここが無いと守られない）。
//  - nodes/*.html の defaults と同じ名前・型・既定値（違うと、次のデプロイで足した台が作り直される）
//  - runtime の実体の探し方（別の実体は使わない・探す順）
//  - 使えるか（版・セーフモード・readOnly）
//  - 足し方（タブ・id・version_mismatch・失敗の形）
// 本物の Node-RED に載せた確かめは flow-writer-embedded.test.js。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fw = require('../../lib/runtime/flow-writer')
const { ApiError } = require('../../lib/runtime/errors')
const { loadDefinition } = require('./html-defaults')

const clone = (v) => JSON.parse(JSON.stringify(v))

function fakeRed(over) {
  const httpNode = function () {}
  const getNode = function () {}
  return Object.assign({ httpNode, nodes: { getNode }, settings: {}, version: () => '3.1.3' }, over)
}

/** 動いている Node-RED と同じ実体の @node-red/runtime。 */
function runtimeOf(RED, over) {
  return Object.assign({ flows: { getFlows() {}, setFlows() {} }, httpNode: RED.httpNode, _: { nodes: { getNode: RED.nodes.getNode } } }, over)
}

/** flows の出し入れだけを持つ偽物（getFlows・setFlows の形は @node-red/runtime のとおり）。 */
function fakeFlows(initial, o) {
  const opt = o || {}
  const st = { flows: clone(initial || []), rev: 'r0', gets: 0, sets: [] }
  const api = {
    flows: {
      getFlows: async () => {
        st.gets++
        if (opt.onGet) opt.onGet(st)
        return { flows: clone(st.flows), rev: st.rev }
      },
      setFlows: async (a) => {
        st.sets.push(clone(a))
        if (opt.onSet) opt.onSet(st, a)
        st.flows = clone(a.flows.flows)
        st.rev = 'r' + st.sets.length
        return { rev: st.rev }
      },
    },
    _: { flows: { state: () => (opt.state === undefined ? 'start' : opt.state) } },
  }
  if (opt.live) api._.settings = opt.live
  return { st, api }
}

function writerOf(api, over) {
  const logs = []
  const w = fw.createFlowWriter(Object.assign({ RED: fakeRed(), runtimeApi: api, version: () => '3.1.3', log: (l, t) => logs.push([l, t]) }, over))
  return Object.assign(w, { logs })
}

const SPEC = {
  deviceId: 'dev1',
  brouteId: 'brt1',
  tabId: null,
  device: { name: '', enabled: true, role: '電力', mode: 'simulator', serialport: '', serialbaud: 115200, deviceKey: '', expectedMac: '', autoStart: true, simulatorOptions: '' },
  broute: {},
}

const apiErr = (status, code) => (e) => e instanceof ApiError && e.status === status && e.code === code

test('html の defaults と DEVICE_DEFAULTS・BROUTE_DEFAULTS は名前・型・既定値が同じ', () => {
  // 違うと、エディタが読み直したノードは「変わった」と判定され、次のデプロイで足した台が作り直される。
  // 戻すと落ちるもの: html の defaults に項目を足す・既定値を変える・flow-writer の表の項目を消す
  for (const [name, table] of [
    ['wsuha-device', fw.DEVICE_DEFAULTS],
    ['wsuha-broute', fw.BROUTE_DEFAULTS],
  ]) {
    const d = loadDefinition(name).defaults
    assert.deepEqual(Object.keys(table).sort(), Object.keys(d).sort(), name + ' の項目の名前')
    for (const k of Object.keys(d)) {
      assert.equal(typeof table[k], typeof d[k].value, `${name}.${k} の型`)
      assert.deepEqual(table[k], d[k].value, `${name}.${k} の既定値`)
    }
  }
})

test('deviceNode・brouteNode: 表の名前だけを書く。型の違う値は既定値に戻す。設定ノードに z を付けない', () => {
  // 戻すと落ちるもの: deviceNode・brouteNode が受けた値をそのまま写す
  const d = fw.deviceNode('d1', { role: '電力', serialbaud: '9600', autoStart: 'yes', extra: 'x', routeBId: 'x' })
  assert.deepEqual(Object.keys(d).sort(), Object.keys(fw.DEVICE_DEFAULTS).concat(['id', 'type']).sort())
  assert.equal(d.type, 'wsuha-device')
  assert.equal(d.role, '電力')
  assert.equal(d.serialbaud, 115200, '数でないものは既定値')
  assert.equal(d.autoStart, true, '真偽でないものは既定値')
  assert.equal('z' in d, false, 'z があると「すべてのフロー」で選べない')
  const b = fw.brouteNode('b1', 't1', 'd1', { name: 'x', emitLogs: 1, waitSec: 60 }, 160)
  assert.deepEqual(Object.keys(b).sort(), Object.keys(fw.BROUTE_DEFAULTS).concat(['id', 'type', 'z', 'x', 'y', 'wires']).sort())
  assert.equal(b.device, 'd1')
  assert.equal(b.z, 't1')
  assert.equal(b.y, 160)
  assert.equal(b.waitSec, 60)
  assert.equal(b.emitLogs, false)
  assert.deepEqual(b.wires, [[], []], '出力は 2 つ')
})

test('sameRuntime: flows の関数・httpNode・getNode の全部が同じ実体のときだけ true', () => {
  // 戻すと落ちるもの: sameRuntime の httpNode か getNode の比較を外す（別の Node-RED のフローを書き換える）
  const RED = fakeRed()
  assert.equal(fw.sameRuntime(runtimeOf(RED), RED), true)
  for (const m of [
    null,
    {},
    runtimeOf(RED, { flows: {} }),
    runtimeOf(RED, { httpNode: function () {} }),
    runtimeOf(RED, { _: { nodes: { getNode: function () {} } } }),
    runtimeOf(RED, { _: undefined }),
  ]) {
    assert.equal(fw.sameRuntime(m, RED), false)
  }
  const throws = runtimeOf(RED)
  Object.defineProperty(throws, 'httpNode', {
    get() {
      throw new Error('初期化の前')
    },
  })
  assert.equal(fw.sameRuntime(throws, RED), false, 'httpNode の getter が投げても止まらない')
  assert.equal(fw.sameRuntime(runtimeOf(RED), { httpNode: null, nodes: RED.nodes }), false)
})

test('findRuntimeApi: require.cache を先に見る。別の実体は使わず、mainRequire の 2 つの道へ進む', () => {
  // 戻すと落ちるもの: findRuntimeApi で sameRuntime を見ない・探す順を変える
  const RED = fakeRed()
  const good = runtimeOf(RED)
  const other = runtimeOf(fakeRed())
  const file = path.join('x', 'node_modules', '@node-red', 'runtime', 'lib', 'index.js')
  const never = () => {
    throw new Error('呼ばない')
  }

  let r = fw.findRuntimeApi(RED, { cache: { [file]: { exports: good } }, mainRequire: never })
  assert.equal(r.api, good)
  assert.equal(r.how, 'require.cache')

  // 名前の違うファイルは見ない
  r = fw.findRuntimeApi(RED, { cache: { 'x/other/lib/index.js': { exports: good } }, mainRequire: null })
  assert.equal(r.api, null)

  // キャッシュの実体が別物: 使わずに次の道へ
  const asked = []
  r = fw.findRuntimeApi(RED, {
    cache: { [file]: { exports: other } },
    mainRequire: (m) => {
      asked.push(m)
      return good
    },
  })
  assert.equal(r.api, good)
  assert.equal(r.how, 'require.main.require("@node-red/runtime")')
  assert.deepEqual(asked, ['@node-red/runtime'])
  assert.equal(r.tried.length, 1)

  // @node-red/runtime が読めなければ node-red の runtime
  r = fw.findRuntimeApi(RED, {
    cache: {},
    mainRequire: (m) => {
      if (m === '@node-red/runtime') throw Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' })
      return { runtime: good }
    },
  })
  assert.equal(r.api, good)
  assert.equal(r.how, 'require.main.require("node-red").runtime')
  assert.match(r.tried[0], /MODULE_NOT_FOUND/)

  // どれも別物なら無し
  r = fw.findRuntimeApi(RED, { cache: { [file]: { exports: other } }, mainRequire: () => ({ runtime: other, flows: other.flows }) })
  assert.equal(r.api, null)
  assert.equal(r.how, null)
  assert.equal(r.tried.length, 3)
})

test('availability: 確かめた版だけ使える。ほかの版は理由つきで NOT_AVAILABLE', () => {
  // 戻すと落ちるもの: VERIFIED_VERSIONS を広げすぎる・3.1 に戻す
  const { api } = fakeFlows()
  for (const [v, ok] of [
    ['3.0.2', false],
    ['3.1.0', true],
    ['3.1.3', true],
    ['3.1.15', true],
    ['3.2.0', false],
    ['4.0.0', true],
    ['4.0.9', true],
    ['4.1.2', true],
    ['4.2.0', false],
    ['5.0.0', false],
    ['13.1.0', false],
    [null, false],
  ]) {
    const a = writerOf(api, { version: () => v }).availability()
    assert.equal(a.available, ok, String(v))
    assert.equal(a.code, ok ? null : 'NOT_AVAILABLE', String(v))
    if (!ok) assert.match(a.reason, /版/)
    assert.equal(a.version, v)
  }
  assert.equal(writerOf(api, { version: () => { throw new Error('x') } }).availability().available, false, '版を読めなければ使わない')
})

test('availability: 実体が見つからなければ NOT_AVAILABLE。ログは 1 回だけ。見つかれば覚える', () => {
  const RED = fakeRed()
  const w = fw.createFlowWriter({ RED, version: () => '3.1.3', deps: { cache: {}, mainRequire: null }, log: (l, t) => logs.push([l, t]) })
  const logs = []
  assert.equal(w.availability().code, 'NOT_AVAILABLE')
  assert.equal(w.availability().code, 'NOT_AVAILABLE')
  assert.equal(logs.filter(([l]) => l === 'warn').length, 1, '毎回は書かない')
  let found = 0
  const good = runtimeOf(RED)
  const w2 = fw.createFlowWriter({
    RED,
    version: () => '3.1.3',
    log: () => {},
    deps: {
      cache: {},
      mainRequire: () => {
        found++
        return good
      },
    },
  })
  assert.equal(w2.availability().available, true)
  assert.equal(w2.availability().available, true)
  assert.equal(found, 1)
})

test('availability: セーフモードは今のフローの状態で決める。起動時の設定の写しが残っていても、開始したら使える', () => {
  // 案内どおりにエディタでフローを開始しても、再起動するまで 409 FLOWS_LOCKED のままだった。
  // 戻すと落ちるもの: flow-writer.js の availability で RED.settings.safeMode を先に見る
  const at = (state, settings) => writerOf(fakeFlows([], { state }).api, { RED: fakeRed({ settings }) }).availability()
  assert.equal(at('safe', {}).code, 'FLOWS_LOCKED')
  assert.match(at('safe', {}).reason, /セーフモード/)
  assert.equal(at('start', { safeMode: true }).available, true, '開始したあとは写しの true を見ない')
  assert.equal(at('stop', { safeMode: true }).available, true)
  // 状態が分からない実体（state の関数が無い）では、設定を見て閉じる側に倒す
  const unknown = (settings) => writerOf({ flows: {} }, { RED: fakeRed({ settings }) }).availability()
  assert.equal(unknown({ safeMode: true }).code, 'FLOWS_LOCKED')
  assert.equal(unknown({}).available, true)
})

test('availability: ランタイムの本物の設定にセーフモードが立っていれば、状態が safe になる前でも閉じる。消えたら開く', () => {
  // 起動の途中は状態が start のまま（safe になるのは依存の確かめのあと）で、この間に追加すると止めていたフローが全部動き出した。
  // 戻すと落ちるもの: flow-writer.js の safeModeNow で api._.settings を見ない
  const at = (state, live, settings) => writerOf(fakeFlows([], { state, live }).api, { RED: fakeRed({ settings }) }).availability()
  for (const state of ['start', 'stop']) {
    const r = at(state, { safeMode: true }, {})
    assert.equal(r.code, 'FLOWS_LOCKED', state)
    assert.match(r.reason, /セーフモード/, state)
  }
  assert.equal(at('start', {}, { safeMode: true }).available, true, '本物の設定から消えたら、写しの true を見ない')
  assert.equal(at('safe', {}, {}).code, 'FLOWS_LOCKED', '状態が safe なら閉じる')
  // 本物の設定を読めない実体は、状態が分かっていれば状態で決める
  const unreadable = fakeFlows([], { state: 'start' }).api
  Object.defineProperty(unreadable._, 'settings', {
    get() {
      throw new Error('読めない')
    },
  })
  assert.equal(writerOf(unreadable, { RED: fakeRed({ settings: { safeMode: true } }) }).availability().available, true)
})

test('availability: Node-RED の readOnly は FLOWS_LOCKED（true だけ）', () => {
  const at = (readOnly) => writerOf(fakeFlows().api, { RED: fakeRed({ settings: { readOnly } }) }).availability()
  assert.equal(at(true).code, 'FLOWS_LOCKED')
  assert.match(at(true).reason, /readOnly/)
  assert.equal(at(false).available, true)
  assert.equal(at('true').available, true)
})

test('add: タブ・設定ノード・B ルートノードを足す。ほかのノードに触らない。nodes のデプロイで rev を渡す。認証情報を入れない', async () => {
  // 戻すと落ちるもの: deploymentType を 'full' にする（全部のフローが止まる）・rev を渡さない（同時のデプロイを潰す）
  const others = [
    { id: 't1', type: 'tab', label: 'A' },
    { id: 'i1', type: 'inject', z: 't1', x: 100, y: 100, wires: [[]] },
  ]
  const { st, api } = fakeFlows(others)
  const w = writerOf(api)
  const r = await w.add(SPEC)
  assert.equal(r.deviceId, 'dev1')
  assert.equal(r.brouteId, 'brt1')
  assert.equal(r.tabLabel, fw.TAB_LABEL)
  assert.equal(r.tabCreated, true)
  assert.equal(r.tabDisabled, false)
  assert.equal(r.rev, 'r1')
  assert.equal(st.sets.length, 1)
  const a = st.sets[0]
  assert.equal(a.deploymentType, 'nodes')
  assert.equal(a.flows.rev, 'r0')
  assert.deepEqual(a.flows.flows.slice(0, 2), others, 'ほかのノードはそのまま')
  const tab = st.flows.find((n) => n.type === 'tab' && n.id === r.tabId)
  assert.equal(tab.label, fw.TAB_LABEL)
  assert.equal(tab.disabled, false)
  const dev = st.flows.find((n) => n.id === 'dev1')
  const brt = st.flows.find((n) => n.id === 'brt1')
  assert.equal('z' in dev, false)
  assert.equal(dev.role, '電力')
  assert.equal(brt.z, r.tabId)
  assert.equal(brt.device, 'dev1')
  assert.equal(brt.y, 80, 'タブが空なら 80')
  assert.ok(!/credentials|routeBId|routeBPassword/.test(JSON.stringify(st.flows)), '認証情報をフローに入れない')
})

test('add: 置き場所のタブがあればそこへ、一番下の y + 80。利用者が付けた名前で返す。無効のタブは tabDisabled で知らせる', async () => {
  // 戻すと落ちるもの: flow-writer.js の add の戻り値に tabDisabled を足さない
  for (const disabled of [false, true]) {
    const { st, api } = fakeFlows([
      { id: 'tt', type: 'tab', label: '受電盤', disabled },
      { id: 'n1', type: 'wsuha-broute', z: 'tt', x: 200, y: 80, wires: [[], []] },
      { id: 'n2', type: 'wsuha-broute', z: 'tt', x: 200, y: 240, wires: [[], []] },
      { id: 'n3', type: 'inject', z: 'other', x: 1, y: 9000, wires: [[]] },
    ])
    const r = await writerOf(api).add(Object.assign({}, SPEC, { tabId: 'tt' }))
    assert.equal(r.tabId, 'tt')
    assert.equal(r.tabCreated, false)
    assert.equal(r.tabLabel, '受電盤')
    assert.equal(r.tabDisabled, disabled)
    assert.equal(st.flows.filter((n) => n.type === 'tab').length, 1, '新しいタブを作らない')
    assert.equal(st.flows.find((n) => n.id === 'brt1').y, 320, 'ほかのタブのノードは数えない')
    assert.equal(st.flows.find((n) => n.id === 'tt').disabled, disabled, '利用者のタブを勝手に変えない')
  }
})

test('add: 置き場所のタブが消えていたら作り直す（id はフローの中の id と重ねない）', async () => {
  const ids = ['t1', 'dev1', 'brt1', 'fresh']
  const RED = fakeRed({ util: { generateId: () => ids.shift() } })
  const { st, api } = fakeFlows([{ id: 't1', type: 'tab', label: 'A' }])
  const r = await writerOf(api, { RED }).add(Object.assign({}, SPEC, { tabId: 'gone' }))
  assert.equal(r.tabCreated, true)
  assert.equal(r.tabId, 'fresh', '重なる id は使わない')
  assert.equal(st.flows.filter((n) => n.type === 'tab').length, 2)
})

test('add: version_mismatch は getFlows から 1 回だけやり直す。2 回続いたら 409 BUSY（同時のデプロイの変更を消さない）', async () => {
  // 戻すと落ちるもの: add の attempt の判定を外す（やり直さない・やり直し続ける）・読み直さずに同じ本文を送る
  const mismatch = () => Object.assign(new Error('rev'), { code: 'version_mismatch' })
  const once = fakeFlows([{ id: 't1', type: 'tab', label: 'A' }], {
    onSet: (st) => {
      if (st.sets.length === 1) {
        st.flows.push({ id: 'editor1', type: 'tab', label: 'エディタが同時に足した' })
        st.rev = 'r-editor'
        throw mismatch()
      }
    },
  })
  const r = await writerOf(once.api).add(SPEC)
  assert.equal(r.tabCreated, true)
  assert.equal(once.st.gets, 2)
  assert.equal(once.st.sets[1].flows.rev, 'r-editor', '読み直した rev で送る')
  assert.ok(once.st.flows.some((n) => n.id === 'editor1'), '同時のデプロイの変更を残す')

  const always = fakeFlows([], {
    onSet: () => {
      throw mismatch()
    },
  })
  await assert.rejects(writerOf(always.api).add(SPEC), apiErr(409, 'BUSY'))
  assert.equal(always.st.sets.length, 2, '2 回まで')
})

test('add: 失敗の形。マージの途中は FLOWS_LOCKED、ほかは INTERNAL で、原文（パス）は画面に返さずログにだけ書く', async () => {
  // 戻すと落ちるもの: mapSaveError で err.message をそのまま返す
  const merge = fakeFlows([], {
    onSet: () => {
      throw Object.assign(new Error('x'), { code: 'git_merge_conflict' })
    },
  })
  await assert.rejects(writerOf(merge.api).add(SPEC), apiErr(409, 'FLOWS_LOCKED'))

  const secretPath = '/home/someone/.node-red/flows.json'
  const disk = fakeFlows([], {
    onSet: () => {
      throw new Error('EACCES: permission denied, open ' + secretPath)
    },
  })
  const w = writerOf(disk.api)
  await assert.rejects(w.add(SPEC), (e) => apiErr(500, 'INTERNAL')(e) && !e.message.includes(secretPath))
  assert.ok(w.logs.some(([l, t]) => l === 'warn' && t.includes(secretPath)), 'ログには原文')

  const read = fakeFlows([], {
    onGet: () => {
      throw new Error('読めません ' + secretPath)
    },
  })
  await assert.rejects(writerOf(read.api).add(SPEC), (e) => apiErr(500, 'INTERNAL')(e) && !e.message.includes(secretPath))
  assert.equal(read.st.sets.length, 0)
})

test('add: 新しい id がフローの中の id と重なったら書かない', async () => {
  const { st, api } = fakeFlows([{ id: 'dev1', type: 'inject' }])
  await assert.rejects(writerOf(api).add(SPEC), apiErr(500, 'INTERNAL'))
  assert.equal(st.sets.length, 0)
})

test('add: 使えないときは読みも書きもせずに、503 NOT_AVAILABLE か 409 FLOWS_LOCKED', async () => {
  const a = fakeFlows()
  await assert.rejects(writerOf(a.api, { version: () => '9.9.9' }).add(SPEC), apiErr(503, 'NOT_AVAILABLE'))
  assert.equal(a.st.gets, 0)
  const b = fakeFlows([], { state: 'safe' })
  await assert.rejects(writerOf(b.api).add(SPEC), apiErr(409, 'FLOWS_LOCKED'))
  assert.equal(b.st.gets, 0)
})

test('add: 画面の要求の控えを、エディタのデプロイと同じ形で setFlows に渡す', async () => {
  // flows.set の監査が見るのは opts.req で、opts.user はストレージへ渡るだけ。user だけを渡すと、誰の操作か残らない。
  // 戻すと落ちるもの: flow-writer.js の add で setFlows の req を外す
  const { st, api } = fakeFlows([])
  const w = writerOf(api)
  const reqLog = { user: { username: 'admin', permissions: '*' }, path: '/wsuha-broute/api/v1/adapters', ip: '192.0.2.1' }
  await w.add({ deviceId: 'd1', brouteId: 'b1', device: { role: '電力' }, broute: {}, reqLog })
  assert.deepEqual(st.sets[0].req, reqLog)
  assert.deepEqual(st.sets[0].user, reqLog.user)
  // フローの入力からは控えが無い
  const other = fakeFlows([])
  await writerOf(other.api).add({ deviceId: 'd1', brouteId: 'b1', device: { role: '電力' }, broute: {} })
  assert.equal(other.st.sets[0].req, undefined)
  assert.equal(other.st.sets[0].user, undefined)
})

test('runtime の実体を見つけても、Node-RED のログに info を出さない。見つからないときの warn は残す', () => {
  // Web UI を開くだけで、利用者にできることの無い内部の語がログに出ていた。
  // 戻すと落ちるもの: flow-writer.js の runtimeApi で見つけた道を log('info', …) で書く
  const RED = fakeRed()
  const logs = []
  const found = fw.createFlowWriter({
    RED,
    log: (l, t) => logs.push([l, t]),
    deps: { cache: { [path.join('x', '@node-red', 'runtime', 'lib', 'index.js')]: { exports: runtimeOf(RED) } }, mainRequire: null },
  })
  assert.equal(found.availability().available, true)
  assert.deepEqual(logs, [])
  const missing = fw.createFlowWriter({ RED, log: (l, t) => logs.push([l, t]), deps: { cache: {}, mainRequire: null } })
  assert.equal(missing.availability().available, false)
  assert.equal(logs.filter(([l]) => l === 'warn').length, 1)
})
