'use strict'

// 試験用: 偽の RED に wsuha-device・wsuha-broute を載せ、待ち時間を詰めたノードを作る。
// （test/nodes/lifecycle.test.js と同じやり方。ここは test/nodes/*.test.js の glob に入らない名前にしてある）

const { createFakeRed, waitFor, ID, PW } = require('../runtime/fake-red')

const SIM = JSON.stringify({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8), echonetDelayMs: 5 })

function createKit() {
  let seq = 0
  const open = [] // 後片付けするノード（作った順）

  function setup(opts) {
    const fake = createFakeRed(opts)
    require('../../nodes/wsuha-device.js')(fake.RED)
    require('../../nodes/wsuha-broute.js')(fake.RED)
    return fake
  }

  function devConfig(id, extra) {
    return Object.assign(
      {
        id,
        name: '試験のアダプタ',
        role: '電力',
        mode: 'simulator',
        deviceKey: 'kit' + id.replace(/[^A-Za-z0-9]/g, ''),
        pollInterval: 30,
        pollEpcs: 'E7',
        scanDurations: '4,5',
        simulatorOptions: SIM,
        _credentials: { routeBId: ID, routeBPassword: PW },
      },
      extra
    )
  }

  /** 待ち時間を詰める（取得間隔は詰めない: 運用設定の試験で値を見るため）。コンストラクタが返った直後に呼ぶ。 */
  function speedUp(seqObj) {
    Object.assign(seqObj.options, {
      resetSettleMs: 20,
      scanRounds: 1,
      commandTimeout: 2000,
      joinTimeout: 3000,
      sendTimeout: 2000,
      joinRetryMs: 50,
      joinBurstBackoffMs: [60],
      txBudgetGuard: false,
      minPollIntervalSec: 1,
    })
  }

  function createDevice(fake, id, extra) {
    const dev = fake.create('wsuha-device', devConfig(id, extra))
    if (dev.sequencer) speedUp(dev.sequencer)
    open.push([fake, dev])
    return dev
  }

  function createBroute(fake, devId, extra) {
    const id = 'broute-' + ++seq
    const node = fake.create('wsuha-broute', Object.assign({ id, device: devId }, extra))
    open.push([fake, node])
    return node
  }

  /** 作った逆順に閉じる（Node-RED の停止と同じく、設定ノードは最後）。 */
  async function cleanup() {
    while (open.length) {
      const [fake, node] = open.pop()
      if (fake.nodes.get(node.id) === node) await fake.close(node, true)
    }
  }

  return { setup, devConfig, speedUp, createDevice, createBroute, cleanup, open }
}

/** 入力を 1 通送り、done が呼ばれるまで待つ。send で送ったものは node._sent にも積む。 */
function input(node, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sent = []
    const t = setTimeout(() => reject(new Error('done が呼ばれません: ' + JSON.stringify(msg).slice(0, 80))), timeoutMs || 8000)
    node.emit(
      'input',
      msg,
      (m) => {
        sent.push(m)
        node._sent.push(m)
      },
      (err) => {
        clearTimeout(t)
        resolve({ err: err || null, sent })
      }
    )
  })
}

/** 出力 2 のうち topic が合うもの。 */
function out2(node, topic) {
  return node._sent.filter((m) => Array.isArray(m) && m[1] && (!topic || m[1].topic === topic)).map((m) => m[1])
}

// 接続の待ち。通る試験でも負荷の下では 1〜6 秒かかり、VM や共有フォルダが数秒止まることもあるので、上限は長めにとる
// （起きないまま止まらないための上限で、通る試験の時間は変わらない。後始末は作ったときに open へ載せてある）
const CONNECT_MS = 30000

async function connected(dev) {
  await waitFor(() => dev.sequencer && dev.sequencer.isConnected, CONNECT_MS, '接続')
  await waitFor(() => dev.sequencer._requestDepth === 0 && !dev.sequencer._pending, CONNECT_MS, '接続時の取得')
}

module.exports = { createKit, input, out2, connected, SIM }
