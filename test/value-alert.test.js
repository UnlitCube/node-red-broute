'use strict'

// 接続の確認は通るのに定期の値が来ない状態を、本物の wsuha-device と wsuha-broute に通す。
// sequencer の試験（test/sequencer-timeline.test.js）は alert の条件を写して見ているので、
// ここでは出力 2 の alert まで届くことを見る。値は全部架空。
//
// 戻すと落ちるもの: lib/sequencer.js の _poll の再接続の前の consecutiveFailures++ を外す（alert が届かない）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { waitFor } = require('./runtime/fake-red')
const { createKit, out2, connected } = require('./nodes/node-kit')

const kit = createKit()

afterEach(() => kit.cleanup())

test('定期の取得に応答が無いまま繋ぎ直しを繰り返すと、出力 2 に alert が届き、理由が付く', async () => {
  const fake = kit.setup()
  const dev = kit.createDevice(fake, 'value-alert', { deviceKey: 'valuealert' })
  const b = kit.createBroute(fake, 'value-alert', { name: '値', alertAfterFailures: 3 })
  await connected(dev)
  const seq = dev.sequencer
  await waitFor(() => seq.state.lastValueAt !== null, 8000, '最初の定期の値')
  assert.equal(seq.state.consecutiveFailures, 0)

  // 接続の確認（0x80）にだけ答える。待ち時間も詰める
  Object.assign(seq.options, { pollIntervalSec: 0.05, responseTimeoutMs: 30, responseResends: 0 })
  const sim = seq.transport
  const orig = sim._onSendToData.bind(sim)
  sim._onSendToData = (ctx, data) => {
    if (Buffer.from(data)[12] === 0x80) return orig(ctx, data)
    sim._ok()
    sim._emitLine(`EVENT 21 ${sim.config.meterIpv6} 0 00`, 1)
  }
  seq.pollNow()

  await waitFor(() => out2(b, 'alert').length >= 1, 15000, 'alert')
  const alert = out2(b, 'alert')[0].payload
  assert.ok(alert.consecutiveFailures >= 3, String(alert.consecutiveFailures))
  assert.match(alert.reason, /定期的に取りに行く値が 3 回続けて届きません/)
  assert.ok(seq.state.counters.joins >= 3, '前提: 接続の確認は通り続けている')
})

test('接続の確認にだけ答えるメーターでは、alert は 1 回で、値がまた届くまで recovered を流さない', async () => {
  const fake = kit.setup()
  const dev = kit.createDevice(fake, 'value-flap', { deviceKey: 'valueflap' })
  const b = kit.createBroute(fake, 'value-flap', { name: '値', alertAfterFailures: 3 })
  await connected(dev)
  const seq = dev.sequencer
  await waitFor(() => seq.state.lastValueAt !== null, 8000, '最初の定期の値')

  Object.assign(seq.options, { pollIntervalSec: 0.05, responseTimeoutMs: 30, responseResends: 0 })
  const sim = seq.transport
  const orig = sim._onSendToData.bind(sim)
  sim._onSendToData = (ctx, data) => {
    if (Buffer.from(data)[12] === 0x80) return orig(ctx, data)
    sim._ok()
    sim._emitLine(`EVENT 21 ${sim.config.meterIpv6} 0 00`, 1)
  }
  seq.pollNow()
  await waitFor(() => out2(b, 'alert').length >= 1, 15000, 'alert')
  const joins = seq.state.counters.joins
  // 繋ぎ直しが何度か通るまで待つ（前は通るたびに recovered が出て、次に切れると alert が出直していた）
  await waitFor(() => seq.state.counters.joins >= joins + 3, 20000, '繋ぎ直し 3 回')
  assert.equal(out2(b, 'alert').length, 1, 'alert は 1 回だけ')
  assert.equal(out2(b, 'recovered').length, 0, '値が届くまで recovered を流さない')

  // 値がまた届くようにすると、recovered が 1 回流れる
  sim._onSendToData = orig
  await waitFor(() => out2(b, 'recovered').length >= 1, 40000, 'recovered')
  assert.equal(out2(b, 'recovered').length, 1)
  assert.equal(seq.state.consecutiveFailures, 0)
})
