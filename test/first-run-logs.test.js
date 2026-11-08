'use strict'

// 初めて動かしたときのログ。シミュレーターは実機の初期状態まで写すので、そのままだと
// 「ファームウェアの不具合」「表示形式の書き換え」「見つかりません」が warn で並び、異常に見える。
// 実機では気づけるように warn のまま残す。どちらも内部の語は使わない。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Sequencer } = require('../lib/sequencer')
const { SimulatorTransport } = require('../lib/simulator-transport')
const { SerialTransport } = require('../lib/serial-transport')
const { hintOf } = require('../lib/runtime/error-hints')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'
const INTERNAL_WORDS = /PANA|ERXUDP|WOPT|FLASH|DURATION|Get_SNA|epandesc|マニュアル/

const FIRMWARE = /ファームウェア .*既知の不具合/
const DISPLAY_FORMAT = /受信データの表示形式が初期値のまま/
const NOT_FOUND = /スキャンの段階 4 ではメーターが見つかりません/
const DENIED = /メーターが 0x81 を返しませんでした/

// 待ちは単調な時計で測る。壁時計は飛ぶことがある
async function waitFor(fn, what) {
  const limit = performance.now() + 8000
  while (performance.now() < limit) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('待ち時間を超えました: ' + what)
}

/** シミュレーターの既定のまま（バージョン・表示形式・スキャンの段階）で、待ち時間だけを詰めて接続する。 */
async function connectOnce(onTransport) {
  const transport = new SimulatorTransport({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005 })
  if (onTransport) onTransport(transport)
  const seq = new Sequencer(transport, {
    resetSettleMs: 20,
    scanRounds: 1,
    commandTimeout: 2000,
    joinTimeout: 3000,
    sendTimeout: 2000,
    txBudgetGuard: false,
  })
  const logs = []
  seq.on('log', (l) => logs.push(l))
  seq.on('error', () => {})
  seq.setCredentials(ID, PW, '試験')
  // 落ちても片付ける。回ったままの sequencer を残すと、Node 18 では試験のプロセスが終わらない
  try {
    await seq.start()
    await waitFor(() => seq.isConnected, '接続')
    // 接続時の一括取得まで見る。シミュレーターの持っていない値を聞いて断られるのも、初回の注意の 1 つ
    await seq.collectingOnce()
  } finally {
    await seq.destroy()
  }
  return logs
}

function levelOf(logs, re) {
  const hit = logs.find((l) => re.test(l.text))
  assert.ok(hit, '出ていません: ' + re + '\n' + logs.map((l) => `[${l.level}] ${l.text}`).join('\n'))
  return hit
}

test('シミュレーターの初回の接続は warn を出さない（注意は info で残す）', async () => {
  // 戻すと落ちるもの: sequencer.js の _noticeLevel を 'warn' 固定にする・simulator-transport.js の simulated を消す
  const logs = await connectOnce()
  assert.deepEqual(logs.filter((l) => l.level === 'warn').map((l) => l.text), [])
  for (const re of [FIRMWARE, DISPLAY_FORMAT, NOT_FOUND, DENIED]) assert.equal(levelOf(logs, re).level, 'info')
})

test('実機では同じ注意を warn で残す。文に内部の語を出さない', async () => {
  // 戻すと落ちるもの: _noticeLevel をいつも 'info' にする・文を内部の語へ戻す
  const logs = await connectOnce((transport) => {
    transport.simulated = false
  })
  for (const re of [FIRMWARE, DISPLAY_FORMAT, NOT_FOUND, DENIED]) {
    const hit = levelOf(logs, re)
    assert.equal(hit.level, 'warn')
    assert.doesNotMatch(hit.text, INTERNAL_WORDS)
  }
})

test('スキャンの結果は、次の行まで 2 秒空いても異常として知らせない。表の途切れは知らせる', async () => {
  // スキャンの結果には終わりの印が無く、実機でも残りのチャネルを探す間は次の行が来ない。
  // 戻すと落ちるもの: sequencer.js の _onLine で epandesc の分岐を外す・表の warn も消す
  const seq = new Sequencer(new SimulatorTransport({}), {})
  const logs = []
  seq.on('log', (l) => logs.push(l))
  const feed = (lines) => lines.forEach((l) => seq._onLine(Buffer.from(l, 'latin1')))
  try {
    feed(['EPANDESC', '  Channel:3B', '  Channel Page:09', '  Pan ID:1234', '  Addr:0011223344556677', '  LQI:62', '  Side:0', '  PairID:89ABCDEF'])
    await new Promise((r) => setTimeout(r, 2200))
    assert.equal(seq._scanResults.length, 1, '届いた分は確定している')
    assert.deepEqual(logs.filter((l) => l.level === 'warn').map((l) => l.text), [])
    feed(['EADDR', 'FE80:0000:0000:0000:021D:1290:1234:5678'])
    await new Promise((r) => setTimeout(r, 2200))
    const warns = logs.filter((l) => l.level === 'warn')
    assert.equal(warns.length, 1, warns.map((l) => l.text).join(' | '))
    assert.match(warns[0].text, /複数行の応答が途中で止まった/)
    assert.match(warns[0].text, /EADDR/)
  } finally {
    await seq.destroy()
  }
})

test('ポートが空のときの文は、何が足りないかと、どこで選ぶかを言う', () => {
  // 設定ノードの _build が先に同じ文で断るので、ここは lib を単体で使うときの文になる。
  // 戻すと落ちるもの: serial-transport.js の文を前の形へ戻す・error-hints.js の規則から外す
  let err = null
  try {
    new SerialTransport({ path: '' })
  } catch (e) {
    err = e
  }
  assert.ok(err, '断っていない')
  assert.match(err.message, /^ポートが未設定です/)
  assert.match(err.message, /ポートを選ぶか入力してください/)
  assert.match(hintOf(err.message), /ポートを選んでください/)
})
