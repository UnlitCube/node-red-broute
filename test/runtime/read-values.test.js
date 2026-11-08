'use strict'

// 「状態を持って読み出しに答える」の read（lib/runtime/read-values.js）。純関数を確かめる。
//
//  - 入力の読み方: payload なし（か {}）・'E7'・['E7','E8']・{epcs}・{keys}・maxAgeSec（payload か msg）。外れたら VALIDATION
//  - 返事の形: {device, deviceKey, ts, at, maxAgeSec, values: {key: {epc, name, value, unit, display, at, ts, fresh, ageSec}}, missing, refreshed}
//    （出力 1 の all と同じ流儀。JSON の往復で変わらない）
//  - 取り直しの要る EPC（maxAgeSec より古い・無い）
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const rv = require('../../lib/runtime/read-values')
const vm = require('../../lib/runtime/view-model')

const NOW = 1793900000000
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/

/** sequencer の state.values と同じ形（EL.decode の結果に at）。 */
function known() {
  return {
    '0xE7': { epc: 0xe7, name: '瞬時電力計測値', value: 436, unit: 'W', display: '436 W', at: NOW - 12000 },
    '0xE8': { epc: 0xe8, name: '瞬時電流計測値', value: { r: 15, t: 30 }, total: 45, unit: 'A', display: 'R 15 A / T 30 A', at: NOW - 12000 },
    '0xE0': { epc: 0xe0, name: '積算電力量計測値 (正方向)', value: 61532, rawCount: 615320, unit: 'kWh', display: '61532 kWh', at: NOW - 200000 },
    '0x80': { epc: 0x80, name: '動作状態', value: 0x30, display: 'ON', at: NOW - 3600000 },
    '0x8D': { epc: 0x8d, name: '製造番号', value: '  ABC123  ', display: 'ABC123', at: NOW - 3600000 },
    '0xD0': { epc: 0xd0, name: '不明なEPC 0xD0', value: Buffer.from([1, 2]), display: '0102', at: NOW - 1000 },
  }
}

const inspect = { options: { pollIntervalSec: 30, pollEpcs: [0xe7, 0xe8], slowEpcs: [0xe0, 0xe3], halfHourEpcs: [0xea, 0xeb], slowIntervalSec: 300, halfHourIntervalSec: 1800 }, snap: null }

test('入力の読み方: payload なし・{}・inject の時刻は全部。EPC は文字列・配列・{epcs}、名前は {keys}。maxAgeSec は payload か msg', () => {
  // 戻すと落ちるもの: parseReadRequest で inject の時刻を EPC として読む・keys を読まない・msg.maxAgeSec を見ない
  for (const p of [undefined, null, '', {}, 1793900000000, { action: 'read' }]) {
    assert.deepEqual(rv.parseReadRequest(p), { epcs: null, maxAgeSec: null }, JSON.stringify(p))
  }
  assert.deepEqual(rv.parseReadRequest('E7').epcs, [0xe7])
  assert.deepEqual(rv.parseReadRequest('E7, e8').epcs, [0xe7, 0xe8])
  assert.deepEqual(rv.parseReadRequest(['E8', 'E7', 'E7']).epcs, [0xe8, 0xe7], '重なりは 1 つに。頼んだ順のまま')
  assert.deepEqual(rv.parseReadRequest(0xe7).epcs, [0xe7], '数の EPC（get と同じ）')
  assert.deepEqual(rv.parseReadRequest({ epcs: ['E7'], keys: ['instantCurrent', 'cumulativeForward'] }).epcs, [0xe7, 0xe8, 0xe0])
  assert.deepEqual(rv.parseReadRequest(['instantPower']).epcs, [0xe7], '配列の中の名前も読む')
  assert.equal(rv.parseReadRequest({ epcs: ['E7'], maxAgeSec: 60 }).maxAgeSec, 60)
  assert.equal(rv.parseReadRequest({ epcs: ['E7'] }, 30).maxAgeSec, 30, 'msg.maxAgeSec')
  assert.equal(rv.parseReadRequest({ maxAgeSec: '0' }, 30).maxAgeSec, 0, 'payload の方を使う。数字だけの文字列も')
  assert.equal(rv.parseReadRequest(undefined, 2.5).maxAgeSec, 2.5)
})

test('入力の検証: 読めない EPC・知らない名前・maxAgeSec の誤り・多すぎるものは VALIDATION（details つき）', () => {
  // 戻すと落ちるもの: 読めない EPC を黙って捨てる（get の 1.x の事故と同じ）
  const bad = [
    [['E7', 'ZZ'], 'epcs'],
    ['E7, 1FF', 'epcs'],
    [{ epcs: 'E7' }, 'epcs'],
    [{ keys: ['instantPower', 'nope'] }, 'keys'],
    [{ keys: 'instantPower' }, 'keys'],
    [{ maxAgeSec: -1 }, 'maxAgeSec'],
    [{ maxAgeSec: 'abc' }, 'maxAgeSec'],
    [{ maxAgeSec: Infinity }, 'maxAgeSec'],
    [Array.from({ length: 65 }, (_, i) => i), 'epcs'],
    [true, '_'],
  ]
  for (const [p, field] of bad) {
    assert.throws(
      () => rv.parseReadRequest(p),
      (err) => {
        assert.equal(err.code, 'VALIDATION', JSON.stringify(p))
        assert.equal(err.status, 422)
        assert.ok(err.details && err.details[field], `${JSON.stringify(p)} の details.${field}: ${JSON.stringify(err.details)}`)
        return true
      }
    )
  }
  assert.throws(() => rv.parseReadRequest({}, 'x'), (err) => err.code === 'VALIDATION' && !!err.details.maxAgeSec)
})

test('画面の API のクエリ（epcs=E7,E8&keys=…&maxAgeSec=60）も同じ規則', () => {
  assert.deepEqual(rv.parseReadQuery({}), { epcs: null, maxAgeSec: null })
  assert.deepEqual(rv.parseReadQuery({ epcs: 'E7,E8', maxAgeSec: '60' }), { epcs: [0xe7, 0xe8], maxAgeSec: 60 })
  assert.deepEqual(rv.parseReadQuery({ keys: 'instantPower' }).epcs, [0xe7])
  assert.throws(() => rv.parseReadQuery({ epcs: 'E7,XX' }), (err) => err.code === 'VALIDATION' && !!err.details.epcs)
  assert.throws(() => rv.parseReadQuery({ maxAgeSec: '-3' }), (err) => err.code === 'VALIDATION' && !!err.details.maxAgeSec)
})

test('返事の形: 全部のとき。出力 1 の all と同じ名前と中身に at（数）・ts（ISO）・ageSec・fresh。まだ無い定期取得の値は missing', () => {
  // 戻すと落ちるもの: buildRead で MAP の pick を通さない・at を ISO の文字列にする・missing を出さない
  const out = rv.buildRead({ device: '電力', deviceKey: 'usb0', known: known(), req: { epcs: null, maxAgeSec: null }, inspect, now: NOW })
  assert.deepEqual(Object.keys(out), ['device', 'deviceKey', 'ts', 'at', 'maxAgeSec', 'values', 'missing', 'refreshed'])
  assert.equal(out.device, '電力')
  assert.equal(out.at, NOW)
  assert.match(out.ts, ISO)
  assert.equal(out.maxAgeSec, null)
  assert.deepEqual(out.refreshed, [], '無線を使っていない')
  const p = out.values.instantPower
  assert.deepEqual(Object.keys(p).sort(), ['ageSec', 'at', 'display', 'epc', 'fresh', 'label', 'meterAt', 'name', 'ts', 'unit', 'value'])
  assert.equal(p.epc, 'E7')
  assert.equal(p.value, 436)
  assert.equal(p.unit, 'W')
  assert.equal(p.at, NOW - 12000)
  assert.match(p.ts, ISO)
  assert.equal(p.ageSec, 12)
  assert.equal(p.fresh, true, '取得間隔 30 秒の 3 倍 + 30 秒より新しい')
  const c = out.values.instantCurrent
  assert.equal(c.r, 15)
  assert.equal(c.t, 30)
  assert.equal(c.total, 45)
  assert.deepEqual(c.value, { r: 15, t: 30 }, 'pick に value の無いもの（E8）も value を入れる')
  assert.equal(out.values.cumulativeForward.value, 61532)
  assert.equal(out.values.cumulativeForward.raw, 615320)
  assert.equal(out.values.cumulativeForward.fresh, true, '5 分の取得の値は 5 分 × 2 + 60 秒まで新しい')
  assert.equal(out.values.operationStatus.value, true, '出力 1 の all と同じ（0x30 = ON は true）')
  assert.equal(out.values.operationStatus.fresh, false, '定期取得でない値は取得間隔の 3 倍 + 30 秒で古い（画面の鮮度と同じ）')
  assert.equal(out.values.operationStatus.ageSec, 3600)
  assert.equal(out.values.serialNumber.value, 'ABC123')
  assert.equal(out.values.serialNumber.fresh, true, '接続時に 1 度だけ取る値（製造番号）は古くならない')
  assert.equal(out.values.D0.value, '0102', '名前の無い EPC は 16 進をキーにする。Buffer は 16 進の文字列')
  assert.deepEqual(out.missing, ['E3', 'EA', 'EB'], '定期取得（取得間隔ごと・5 分・30 分）のうちまだ無いもの')
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'JSON の往復で変わらない')
})

test('返事の形: 頼んだ値だけ。maxAgeSec があれば fresh はそれより新しいか。無い値は missing', () => {
  const out = rv.buildRead({ device: '電力', deviceKey: 'usb0', known: known(), req: { epcs: [0xe7, 0xe0, 0xe3], maxAgeSec: 60 }, inspect, now: NOW, refreshed: [0xe7] })
  assert.deepEqual(Object.keys(out.values), ['instantPower', 'cumulativeForward'])
  assert.equal(out.values.instantPower.fresh, true)
  assert.equal(out.values.cumulativeForward.fresh, false, '200 秒前は 60 秒より古い')
  assert.deepEqual(out.missing, ['E3'])
  assert.deepEqual(out.refreshed, ['E7'])
  assert.equal(out.maxAgeSec, 60)
})

test('取り直しの要る EPC: 頼んだもの（全部なら定期取得の値）のうち、maxAgeSec より古い・無いもの。maxAgeSec が無ければ取り直さない', () => {
  // 戻すと落ちるもの: staleEpcs が maxAgeSec を見ない・全部のときに 1 度だけ取る値（製造番号など）まで取り直す
  const k = known()
  assert.deepEqual(rv.staleEpcs({ known: k, req: { epcs: [0xe7, 0xe8], maxAgeSec: null }, inspect, now: NOW }), [])
  assert.deepEqual(rv.staleEpcs({ known: k, req: { epcs: [0xe7, 0xe8], maxAgeSec: 60 }, inspect, now: NOW }), [])
  assert.deepEqual(rv.staleEpcs({ known: k, req: { epcs: [0xe7, 0xe8], maxAgeSec: 10 }, inspect, now: NOW }), [0xe7, 0xe8])
  assert.deepEqual(rv.staleEpcs({ known: k, req: { epcs: [0xe7, 0xe3], maxAgeSec: 60 }, inspect, now: NOW }), [0xe3])
  assert.deepEqual(rv.staleEpcs({ known: k, req: { epcs: [0xe7], maxAgeSec: 0 }, inspect, now: NOW }), [0xe7], '0 はいつも取りに行く')
  assert.deepEqual(
    rv.staleEpcs({ known: k, req: { epcs: null, maxAgeSec: 60 }, inspect, now: NOW }),
    [0xe0, 0xe3, 0xea, 0xeb],
    '全部のときは定期取得の値だけ（接続時に 1 度だけ取る値は取り直さない）'
  )
})

test('取り直し: 0x9F に無い EPC は取りに行かず missing に入れる。0x9F がまだ無ければ絞らない', () => {
  // 1 回の GET で持っていない EPC を 60 個聞けて、Get が 10 本飛び、控えの表とログが増えた。
  // 戻すと落ちるもの: read-values.js の staleEpcs で unsupported を見ない
  const withMap = { options: inspect.options, snap: { supportedEpcs: ['0xE7', '0xE8', '0x9F'] } }
  const req = { epcs: [0xe7, 0xb9, 0xd0, 0xe8], maxAgeSec: 0 }
  assert.deepEqual(rv.staleEpcs({ known: {}, req, inspect: withMap, now: NOW }), [0xe7, 0xe8])
  assert.deepEqual(rv.staleEpcs({ known: {}, req, inspect, now: NOW }), [0xe7, 0xb9, 0xd0, 0xe8], '0x9F がまだ無ければ聞く')
  assert.deepEqual(rv.staleEpcs({ known: {}, req, inspect: { options: inspect.options, snap: { supportedEpcs: [] } }, now: NOW }), [0xe7, 0xb9, 0xd0, 0xe8])
  const out = rv.buildRead({ known: {}, req, inspect: withMap, now: NOW, refreshed: [0xe7, 0xe8] })
  assert.deepEqual(out.missing, ['E7', 'B9', 'D0', 'E8'], '取れなかった値は全部 missing')
  assert.deepEqual(out.refreshed, ['E7', 'E8'], '行かなかった EPC は refreshed に入らない')
})

test('取り直しの分け方: 履歴（E2・E4・EC）は 1 つずつ、ほかは 6 個ずつ', () => {
  assert.deepEqual(rv.refreshGroups([0xe7, 0xe2, 0xe8, 0xe4]), [[0xe7, 0xe8], [0xe2], [0xe4]])
  assert.deepEqual(rv.refreshGroups([1, 2, 3, 4, 5, 6, 7]), [[1, 2, 3, 4, 5, 6], [7]])
  assert.deepEqual(rv.refreshGroups([]), [])
})

test('read の display は、計測値の表と同じ形（設置場所はコードの意味・定時積算は値だけ・数だけなら単位を添える）', () => {
  // 組み立てが 2 か所に分かれていて、画面の表は「庭・外周 1（0x61）」、フローの read は「0x61」だった。
  // 戻すと落ちるもの: read-values.js の bodyOf で view-model の rowDisplay を通さない
  const known = {
    '0x81': { epc: 0x81, value: '61', display: '0x61', at: NOW - 1000 },
    '0xEA': { epc: 0xea, value: 41582.7, unit: 'kWh', display: '2026-11-07 08:00:00 / 41582.7 kWh', timestamp: '2026-11-07 08:00:00', at: NOW - 1000 },
    '0xE7': { epc: 0xe7, value: 436, unit: 'W', display: '436', at: NOW - 1000 },
  }
  const input = { snap: { known }, options: inspect.options }
  const rows = vm.buildValueRows(input, NOW)
  const read = rv.buildRead({ device: '電力', deviceKey: 'usb0', known, req: { epcs: null, maxAgeSec: null }, inspect, now: NOW }).values
  for (const [hex, key, display] of [
    ['0x81', 'installationLocation', '庭・外周 1（0x61）'],
    ['0xEA', 'scheduledCumulativeForward', '41582.7 kWh'],
    ['0xE7', 'instantPower', '436 W'],
  ]) {
    const row = rows.find((r) => r.epc === hex)
    assert.equal(row.display, display)
    assert.equal(read[key].display, display, key)
    assert.equal(read[key].meterAt, row.meterAt, key)
  }
  assert.equal(read.installationLocation.value, '61', '生の値はそのまま')
})
