'use strict'

// シミュレーターの定時積算（EA・EB）の時刻は、サーバーの時間帯に関係なく日本時間で作る。
// メーターの時計は日本時間なので、読む側（view-model）は +09:00 で読む。サーバーの時間帯で作ると、
// UTC のサーバーでは確定の時刻が 9 時間ずれる。
//
// 戻すと落ちるもの: _propertyValue の 0xEA・0xEB を new Date() の getHours などに戻す（UTC と New York で落ちる）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const EL = require('../lib/echonet')
const vm = require('../lib/runtime/view-model')
const { SimulatorTransport } = require('../lib/simulator-transport')

const TZ = process.env.TZ
const HALF_HOUR = 30 * 60 * 1000

afterEach(() => {
  if (TZ === undefined) delete process.env.TZ
  else process.env.TZ = TZ
})

for (const [tz, offsetHours] of [
  ['UTC', 0],
  ['Asia/Tokyo', 9],
  ['America/New_York', null],
]) {
  test(`定時積算の確定の時刻は、サーバーの時間帯が ${tz} でも直前の 30 分の区切りになる`, () => {
    process.env.TZ = tz
    if (offsetHours !== null) assert.equal(new Date(0).getHours(), offsetHours, '前提: 時間帯が切り替わっている')
    const sim = new SimulatorTransport({})
    for (const epc of [0xea, 0xeb]) {
      const v = EL.decode(epc, sim._propertyValue(epc, sim.config.meter), { coefficient: 1, unitFactor: 1 })
      const { meterAt } = vm.splitStamp(v, '')
      const age = Date.now() - meterAt
      assert.ok(age >= 0 && age < HALF_HOUR + 60000, `${v.timestamp} は ${age} ミリ秒前`)
    }
  })
}
