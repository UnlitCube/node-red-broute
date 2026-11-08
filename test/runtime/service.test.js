'use strict'

// lib/runtime/service.js（画面とフローで共有する運用設定の操作）を、本物の registry・settings-store で確かめる。
// 画面（http-api.test.js）とフロー（test/nodes/flow-io.test.js）を通さずに、service の規則だけを見る。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRegistry } = require('../../lib/runtime/registry')
const { createSettingsStore } = require('../../lib/runtime/settings-store')
const { createService } = require('../../lib/runtime/service')
const { makeAdapter, connect } = require('./adapter-kit')
const { tmpDir } = require('./fake-red')

function setup() {
  const store = createSettingsStore({ file: path.join(tmpDir('wsuha-svc-'), 'wsuha-broute', 'settings.json'), log: () => {} })
  const registry = createRegistry()
  const service = createService({ registry, store, log: () => {} })
  return { store, registry, service }
}

/** 設定ノードを作り直す（エディタで値を変えてデプロイした）。照合で外れたものを返す。 */
function redeploy(ctx, h, configValues) {
  h.release(h._owner, false)
  h.claim({}, { meta: { name: 'a1' }, configValues })
  return ctx.service.reconcile(h)
}

const DROPPED = /設定ノードの取得間隔が変わったため、運用設定（60）を外しました/

test('read と diag の device・deviceKey は、デバイスキーが空の台でも設定ノードの規則（id）で返す', async () => {
  // フローは node.deviceKey（空なら id）を入れるので、API だけ null だと同じ台の出力を突き合わせられなかった。
  // 戻すと落ちるもの: service.js の readOf と diagPayload の既定を null に戻す
  const ctx = setup()
  const noRole = makeAdapter(ctx.registry, 'd1aaaaaaaaaaaaa1', { meta: { role: null, deviceKey: '' } })
  const withRole = makeAdapter(ctx.registry, 'd2aaaaaaaaaaaaa2', { meta: { role: '電力', deviceKey: '' }, credentials: false })
  const keyed = makeAdapter(ctx.registry, 'd3aaaaaaaaaaaaa3', { meta: { role: null, deviceKey: 'usb0' }, credentials: false })
  try {
    await connect(noRole.seq)
    const req = { epcs: null, maxAgeSec: null }
    for (const [h, device, deviceKey] of [
      [noRole.h, 'd1aaaaaaaaaaaaa1', 'd1aaaaaaaaaaaaa1'],
      [withRole.h, '電力', 'd2aaaaaaaaaaaaa2'],
      [keyed.h, 'usb0', 'usb0'],
    ]) {
      const read = ctx.service.readOf(h, req)
      assert.equal(read.device, device)
      assert.equal(read.deviceKey, deviceKey)
    }
    const diag = await ctx.service.runDiag(noRole.h, { name: 'ropt' }, { by: 'web-ui' })
    assert.equal(diag.device, 'd1aaaaaaaaaaaaa1')
    assert.equal(diag.deviceKey, 'd1aaaaaaaaaaaaa1')
    // フローはノードが入れる値が先に立つ
    assert.equal(ctx.service.readOf(noRole.h, req, { device: 'x', deviceKey: 'y' }).deviceKey, 'y')
  } finally {
    await noRole.seq.destroy()
    await withRole.seq.destroy()
    await keyed.seq.destroy()
  }
})

test('診断の行: 定時積算は確定の時刻を添える（display からは分けてあるので、足さないと診断から消える）', async () => {
  // 戻すと落ちるもの: service.js の executeDiag で meterAt を行に足さない
  const ctx = setup()
  const { h, seq } = makeAdapter(ctx.registry, 'a1')
  try {
    await connect(seq)
    const d = await ctx.service.runDiag(h, { name: 'epc', args: { epcs: ['EA', 'E7'] } }, { by: 'web-ui' })
    const ea = d.result.lines.find((l) => l.startsWith('EA '))
    const e7 = d.result.lines.find((l) => l.startsWith('E7 '))
    assert.match(ea, /kWh（確定 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/, ea)
    assert.ok(!/確定/.test(e7), e7)
  } finally {
    await seq.destroy()
  }
})

test('エディタの照合で外したときの注意は、その項目を保存し直す・全部外すと消える（ほかの項目の注意は残す）', () => {
  // 注意（Settings.warnings）は handle.settingsDropped から作る。消すのが設定ノードの作り直し（claim）だけだと、
  // 保存し直した値が効いているのに「運用設定（60）を外しました」が画面・フローの返事・出力 2 に出続ける。
  // 戻すと落ちるもの: service.js の saveSettings・clearSettings で settingsDropped から外さない
  const ctx = setup()
  const h = ctx.registry.upsert('a1')
  h.claim({}, { meta: { name: 'a1' }, configValues: { pollIntervalSec: 30, slowIntervalSec: null } })
  ctx.service.reconcile(h)
  ctx.service.saveSettings(h, { pollIntervalSec: 60, slowIntervalSec: 600 }, { by: 'web-ui' })
  assert.deepEqual(ctx.service.settingsOf(h).warnings, [])

  // エディタで取得間隔と 5 分の間隔を変えて作り直す → 両方外れて注意が 2 つ
  const dropped = redeploy(ctx, h, { pollIntervalSec: 45, slowIntervalSec: 900 })
  assert.equal(dropped.length, 2)
  let s = ctx.service.settingsOf(h)
  assert.equal(s.fields.pollIntervalSec.source, 'config')
  assert.ok(s.warnings.some((w) => DROPPED.test(w)), s.warnings.join(' | '))
  assert.ok(s.warnings.some((w) => /積算の取得間隔が変わったため/.test(w)), s.warnings.join(' | '))

  // 取得間隔だけを同じ 60 で保存し直す → その項目の注意だけ消える
  s = ctx.service.saveSettings(h, { pollIntervalSec: 60 }, { by: 'flow:x' })
  assert.equal(s.fields.pollIntervalSec.value, 60)
  assert.equal(s.fields.pollIntervalSec.source, 'runtime')
  assert.ok(!s.warnings.some((w) => DROPPED.test(w)), '保存し直した項目の「外しました」が残っている: ' + s.warnings.join(' | '))
  assert.ok(s.warnings.some((w) => /積算の取得間隔が変わったため/.test(w)), 'ほかの項目の注意は残す')

  // 値を null（その項目の運用設定を外す）で送っても、その項目の注意は消える
  redeploy(ctx, h, { pollIntervalSec: 50, slowIntervalSec: 900 })
  assert.ok(ctx.service.settingsOf(h).warnings.some((w) => /取得間隔が変わったため/.test(w)))
  s = ctx.service.saveSettings(h, { pollIntervalSec: null }, { by: 'web-ui' })
  assert.ok(!s.warnings.some((w) => /取得間隔が変わったため/.test(w)), s.warnings.join(' | '))

  // 全部外す → 注意も全部消える
  ctx.service.saveSettings(h, { slowIntervalSec: 1200 }, { by: 'web-ui' })
  redeploy(ctx, h, { pollIntervalSec: 50, slowIntervalSec: 1000 })
  assert.ok(ctx.service.settingsOf(h).warnings.some((w) => /積算の取得間隔が変わったため/.test(w)))
  s = ctx.service.clearSettings(h, { by: 'web-ui' })
  assert.deepEqual(s.warnings, [], s.warnings.join(' | '))

  // 検証で断った保存では消さない（何も変えていない）
  ctx.service.saveSettings(h, { pollIntervalSec: 60 }, { by: 'web-ui' })
  redeploy(ctx, h, { pollIntervalSec: 40, slowIntervalSec: 1000 })
  assert.throws(() => ctx.service.saveSettings(h, { pollIntervalSec: 5 }, { by: 'web-ui' }), (e) => e.code === 'VALIDATION')
  assert.ok(ctx.service.settingsOf(h).warnings.some((w) => /取得間隔が変わったため/.test(w)))
})

test('合計（adapters の total）: 画面の左ペインの合計と同じ規則（無効は数えない・古い値は除いて数える・値の無い台は足さない・売電は負のまま足す）', () => {
  // adapters の「合計」と「n 台は値が古いため除外」。ui/store.js の totalPower と同じ規則にする。
  // 戻すと落ちるもの: service.js の totalOf で stale を除かない・無効の台を数える・値の無い台を count に入れる
  const { totalOf } = require('../../lib/runtime/service')
  const a = (id, value, extra) => Object.assign({ id, enabled: true, stale: false, power: { value, at: 1 } }, extra)
  assert.deepEqual(
    totalOf([
      a('1', 1200),
      a('2', -300), // 逆潮流（売電）
      a('3', 500, { stale: true }),
      a('4', null), // 停止中・まだ届いていない
      a('5', 800, { enabled: false }),
      a('6', NaN),
    ]),
    { power: 900, count: 2, enabled: 5, staleCount: 1 }
  )
  assert.deepEqual(totalOf([]), { power: null, count: 0, enabled: 0, staleCount: 0 })
  assert.deepEqual(totalOf([a('1', 10, { stale: true })]), { power: null, count: 0, enabled: 1, staleCount: 1 }, '足した台が無ければ power は null')
})

test('読み出しの引数: logs は数でも文字列でもよく、null・空は省略と同じ。trend の範囲は Object の持ち物の名前を通さない', () => {
  // 戻すと落ちるもの: service.js の parseLogQuery・parseRange を外す（画面とフローで検証が分かれる）
  const { parseLogQuery, parseRange } = require('../../lib/runtime/service')
  assert.deepEqual(parseLogQuery({}), { after: 0, limit: 200, level: null })
  assert.deepEqual(parseLogQuery(undefined), { after: 0, limit: 200, level: null })
  assert.deepEqual(parseLogQuery({ after: null, limit: '', level: null }), { after: 0, limit: 200, level: null })
  assert.deepEqual(parseLogQuery({ after: 7, limit: '50', level: 'warn' }), { after: 7, limit: 50, level: 'warn' })
  for (const q of [{ after: -1 }, { after: '1e3' }, { after: [1, 2] }, { limit: 1001 }, { limit: '0' }, { level: 'debug' }]) {
    assert.throws(() => parseLogQuery(q), (e) => e.status === 422 && e.code === 'VALIDATION', JSON.stringify(q))
  }
  assert.equal(parseRange(undefined), '1h')
  assert.equal(parseRange(''), '1h')
  assert.equal(parseRange('24h'), '24h')
  for (const r of ['2h', 'constructor', 'hasOwnProperty', '__proto__', '1H']) {
    assert.throws(() => parseRange(r), (e) => e.status === 422 && !!(e.details && e.details.range), r)
  }
})

test('portKey: Windows の \\\\.\\COM12 と COM12 は同じポート（大文字小文字も見ない）。Linux のパスはそのまま', () => {
  // 別のポートとして扱うと 409 にならず、同じ機器を 2 台で開こうとして片方が開けないまま動き続ける。
  // 戻すと落ちるもの: service.js の portKey の \\\\.\\ を外す置き換え
  const { portKey } = require('../../lib/runtime/service')
  const none = () => {
    throw new Error('ENOENT')
  }
  assert.equal(portKey('\\\\.\\COM12', none), portKey('COM12', none))
  assert.equal(portKey('\\\\.\\com12', none), portKey('COM12', none))
  assert.equal(portKey('  \\\\.\\COM3 ', none), portKey('com3', none))
  assert.notEqual(portKey('\\\\.\\COM12', none), portKey('COM13', none))
  assert.equal(portKey('/dev/ttyUSB0', (p) => p), process.platform === 'win32' ? '/dev/ttyusb0' : '/dev/ttyUSB0')
})

test('ポートの重なり: \\\\.\\COM12 で開いている台があると、COM12 の保存は 409 PORT_IN_USE', () => {
  // 戻すと落ちるもの: service.js の portKey の \\\\.\\ を外す置き換え
  const ctx = setup()
  const a = ctx.registry.upsert('a1')
  a.claim({}, { meta: { name: '一階', enabled: true, mode: 'serial', port: '\\\\.\\COM12', role: '電力', portLabel: 'COM12' } })
  const b = ctx.registry.upsert('b1')
  b.claim({}, { meta: { name: '二階', enabled: true, mode: 'serial', port: '/dev/ttyUSB9', role: '動力', portLabel: 'USB9' }, editorConfig: { mode: 'serial', serialport: '/dev/ttyUSB9' } })
  assert.equal(ctx.service.portUser('COM12', 'b1').id, 'a1')
  assert.throws(() => ctx.service.saveConfig(b, { serialport: 'COM12' }, { by: 'web-ui' }), (e) => e.code === 'PORT_IN_USE' && e.status === 409)
})

test('GET serialports: serialport を読み込めないと、候補が空の理由を項目で返す。読めれば null', async () => {
  // 候補がシミュレーターだけになるのに理由が出ず、利用者が機器を疑っていた。
  // 戻すと落ちるもの: service.js の serialPorts で serialportAvailable と serialportMessage を返さない
  const path = require('node:path')
  const make = (serialportAvailable) => {
    const store = createSettingsStore({ file: path.join(tmpDir('wsuha-svc-'), 'wsuha-broute', 'settings.json'), log: () => {} })
    return createService({ registry: createRegistry(), store, log: () => {}, listPorts: async () => [], serialportAvailable })
  }
  const miss = await make(() => false).serialPorts()
  assert.equal(miss.serialportAvailable, false)
  assert.match(miss.serialportMessage, /serialport を読み込めない/)
  assert.match(miss.serialportMessage, /npm install serialport@12/)
  assert.ok(!/Require stack|node_modules/.test(miss.serialportMessage))
  assert.equal(miss.items.length, 1, 'シミュレーターの候補は出す')
  const ok = await make(async () => true).serialPorts()
  assert.equal(ok.serialportAvailable, true)
  assert.equal(ok.serialportMessage, null)
  const unknown = await make(() => {
    throw new Error('x')
  }).serialPorts()
  assert.equal(unknown.serialportAvailable, true, '確かめられなければ誤った案内を出さない')
})
