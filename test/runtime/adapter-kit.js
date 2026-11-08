'use strict'

// 試験用: 待ち時間を詰めた sequencer を handle に付けて、1 台ぶんのアダプタを作る。
// （test/sequencer.test.js の build() と同じ詰め方）

const { Sequencer } = require('../../lib/sequencer')
const { SimulatorTransport } = require('../../lib/simulator-transport')
const { ID, PW, waitFor } = require('./fake-red')

function makeAdapter(registry, id, opts) {
  const o = opts || {}
  const transport = new SimulatorTransport(
    Object.assign({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8), echonetDelayMs: 5 }, o.sim)
  )
  const seq = new Sequencer(
    transport,
    Object.assign(
      {
        resetSettleMs: 20,
        scanDurations: [4, 5],
        scanRounds: 1,
        pollIntervalSec: 30,
        minPollIntervalSec: 1,
        commandTimeout: 2000,
        joinTimeout: 3000,
        sendTimeout: 2000,
        joinRetryMs: 50,
        joinBurstBackoffMs: [60],
        joinPersistMs: 2500,
        credentialHintAfterMs: 800,
        txBudgetGuard: false,
      },
      o.seq
    )
  )
  // routeBId: 別の台（同じ認証 ID は PAIR_IN_USE になる）。架空の値だけ
  if (o.credentials !== false) seq.setCredentials(o.routeBId || ID, PW, '設定ノード')
  const h = registry.upsert(id)
  h.claim(o.owner || { id }, {
    meta: Object.assign(
      {
        name: o.name || id,
        named: !!o.name,
        role: '電力',
        deviceKey: 'usb0',
        enabled: true,
        mode: 'simulator',
        port: 'simulator',
        portLabel: 'シミュレータ',
        expectedMac: null,
      },
      o.meta
    ),
    credentialSource: '設定ノード',
    secrets: [ID, PW],
    credentialId: o.routeBId || ID,
    configValues: o.configValues || { pollIntervalSec: 30, pollEpcs: 'E7', slowIntervalSec: null, halfHourIntervalSec: null },
  })
  if (o.attach !== false) h.attach(seq)
  return { h, seq, transport }
}

async function connect(seq, ms) {
  await seq.transport.open()
  seq.start()
  await waitReady(seq, ms)
}

async function waitReady(seq, ms) {
  await waitFor(() => seq.isConnected, ms || 8000, '接続')
  await waitFor(() => seq.snapshot().calibration.unitFactor !== null, ms || 8000, '係数の取得')
  await waitFor(() => seq._requestDepth === 0 && !seq._current && seq._queue.length === 0, ms || 8000, '接続時の一括取得')
}

module.exports = { makeAdapter, connect, waitReady }
