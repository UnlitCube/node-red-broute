'use strict'

// 応答のたびの LQI を推移に記録する。間引くときは枠の中の最小を残す（落ち込みを隠さない）。
// 戻すと落ちるもの: registry.js の _recordTrend で LQI を持たない・decimateMin を平均に戻す。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRegistry } = require('../../lib/runtime/registry')
const vm = require('../../lib/runtime/view-model')
const { makeAdapter, connect } = require('./adapter-kit')

test('推移に series.lqi が入り、Detail の meter に rssi と lqiAt が入る', async () => {
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'lq1')
  await connect(seq)
  await seq.get([0xe7], 'test')
  const t = h.trend(3600000, Date.now() + 1000, 720)
  assert.ok(t.series.lqi.length >= 1, JSON.stringify(t.series))
  assert.equal(typeof t.series.lqi[0][1], 'number')
  const d = vm.buildDetail(h.inspect(), Date.now())
  assert.ok(d.meter.rssi < 0, String(d.meter.rssi))
  assert.equal(typeof d.meter.lqiAt, 'number')
  for (const k of ['resends', 'resendRecovered', 'targetedScans', 'fullScans']) assert.equal(typeof d.counters[k], 'number', k)
  await seq.destroy()
})

test('間引いても落ち込みを隠さない（枠の中の最小）。値の無い点は線に入れない', () => {
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'lq2', { attach: false })
  const now = 2_000_000_000_000
  h._trend = []
  for (let i = 0; i < 100; i++) h._trend.push([now - (100 - i) * 1000, 100, null, null, i === 50 ? 12 : i === 70 ? null : 90])
  const t = h.trend(3600000, now, 10)
  assert.equal(t.series.lqi.length, 10)
  assert.equal(Math.min(...t.series.lqi.map((p) => p[1])), 12, '落ち込みが残る')
  assert.equal(t.series.lqi.filter((p) => p[1] === null).length, 0)
  assert.equal(h.trend(3600000, now, 720).series.lqi.length, 99)
  seq.destroy()
})

test('E7・E8 の無い応答でも LQI を残す。電力の系列には点を足さない', () => {
  // 定期取得を積算（E0）だけにした台で、meter.lqi は動くのに series.lqi が空のままだった。
  // 戻すと落ちるもの: registry.js の _recordTrend で LQI を見る前に返す
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'lq3', { attach: false })
  h._seq = { snapshot: () => ({ meter: { lqi: 77 } }) }
  const ts = 2_000_000_000_000
  h._recordTrend({ ts, values: [{ epc: 0xe0, value: 123 }] })
  const t = h.trend(3600000, ts + 1000, 720)
  assert.deepEqual(t.series.lqi, [[ts, 77]])
  assert.deepEqual(t.series.power, [], '電力の系列は変わらない')
  assert.deepEqual(t.series.currentR, [])
  // LQI も分からなければ点を足さない
  h._seq = { snapshot: () => ({ meter: { lqi: null } }) }
  h._recordTrend({ ts: ts + 60000, values: [{ epc: 0xe0, value: 124 }] })
  assert.equal(h._trend.length, 1)
  h._seq = null
  seq.destroy()
})

test('同じ 10 秒の枠に応答が重なったら、LQI は最小を残す（電力は後の値で上書きのまま）', () => {
  // 手動の取得が重なると、落ち込みが後の値で消えていた。
  // 戻すと落ちるもの: registry.js の _recordTrend の同じ枠の LQI を後の値で上書きする
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'lq4', { attach: false })
  const ts = 2_000_000_000_000 // 10 秒の枠の始まり
  const seen = [90, 20, 60]
  seen.forEach((lqi, i) => {
    h._seq = { snapshot: () => ({ meter: { lqi } }) }
    h._recordTrend({ ts: ts + i * 1000, values: [{ epc: 0xe7, value: 100 + i }] })
  })
  assert.equal(h._trend.length, 1, '同じ枠は 1 点')
  const t = h.trend(3600000, ts + 5000, 720)
  assert.deepEqual(t.series.lqi, [[ts + 2000, 20]])
  assert.deepEqual(t.series.power, [[ts + 2000, 102]])
  // 枠の中で初めて LQI が分かったときはそのまま入れる
  h._seq = { snapshot: () => ({ meter: {} }) }
  h._recordTrend({ ts: ts + 10000, values: [{ epc: 0xe7, value: 1 }] })
  h._seq = { snapshot: () => ({ meter: { lqi: 44 } }) }
  h._recordTrend({ ts: ts + 11000, values: [{ epc: 0xe7, value: 2 }] })
  assert.equal(h._trend[1][4], 44)
  h._seq = null
  seq.destroy()
})
