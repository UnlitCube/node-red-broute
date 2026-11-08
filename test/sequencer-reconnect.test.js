'use strict'

// 応答を 1 回落としたときの待ち方と、電波の混雑で全チャネルのスキャンへ入らないことを見る。
// どちらも計測の途切れに直結する。応答の待ちが長いと 1 回落とすたびに数分止まり、
// 数秒の混雑で全チャネルを探すと 10 分以上止まる。
// 戻すと落ちるもの: それぞれの試験に書いた。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Sequencer } = require('../lib/sequencer')
const { SimulatorTransport } = require('../lib/simulator-transport')
const SK = require('../lib/sk-protocol')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'

// 試験が途中で落ちても片付ける。回ったままの sequencer を残すと、Node 18 では試験のプロセスが終わらない
const live = []
afterEach(async () => {
  for (const s of live.splice(0)) await s.destroy().catch(() => {})
})

// 待ちは単調な時計で測る。壁時計は飛ぶことがある
async function waitFor(fn, ms, what) {
  const limit = performance.now() + (ms || 5000)
  while (performance.now() < limit) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('待ち時間を超えました: ' + (what || '条件'))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function build(simConfig, seqOptions) {
  const transport = new SimulatorTransport(Object.assign({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8) }, simConfig))
  const seq = new Sequencer(
    transport,
    Object.assign(
      {
        resetSettleMs: 20,
        scanDurations: [5],
        scanRounds: 1,
        pollIntervalSec: 60,
        minPollIntervalSec: 1,
        commandTimeout: 2000,
        joinTimeout: 3000,
        sendTimeout: 2000,
        responseTimeoutMs: 150,
        sendRetryDelaysMs: [10, 20],
        joinRetryMs: 50,
        joinBurstBackoffMs: [60],
        joinPersistMs: 2500,
        credentialHintAfterMs: 800,
        txBudgetGuard: false,
      },
      seqOptions,
    ),
  )
  seq.setCredentials(ID, PW, 'test')
  const logs = []
  seq.on('log', (l) => logs.push(l))
  live.push(seq)
  return { transport, seq, logs }
}

async function ready(seq) {
  await waitFor(() => seq.isConnected, 8000, '接続')
  await waitFor(() => seq.snapshot().calibration.unitFactor !== null, 8000, '係数')
  // 最初の定期取得まで待つ。待たないと、試験の途中でその取得が割り込んで数が 1 つずれる
  await waitFor(() => seq.snapshot().known['0xE7'], 8000, '最初の取得')
  await waitFor(() => seq._requestDepth === 0 && !seq._current && seq._queue.length === 0, 8000, '接続時の取得')
}

function inject(transport, fail) {
  transport.config.fail = Object.assign({}, transport.config.fail, fail)
  Object.assign(transport.state, { sendFailures: 0, missed: 0, nsCount: 0, muted: 0 })
}

const texts = (logs, re) => logs.filter((l) => re.test(l.text))

// ---- 応答の待ち方 ---------------------------------------------------------------------------

// 戻すと落ちるもの: _armResponse で送り直さない（responseResends を見ない）
test('応答を 1 回落としても、送り直して取れる。取りこぼしに数えない', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1 })
  const r = await seq.get([0xe7], 'test')
  assert.equal(r.values[0].epc, 0xe7)
  assert.equal(seq.state.pollMisses, 0)
  assert.equal(seq.snapshot().counters.resends, 1)
  assert.equal(seq.snapshot().counters.resendRecovered, 1)
  assert.equal(texts(logs, /応答がありません/).length, 0, '取りこぼしの warn を出さない')
  assert.equal(texts(logs, /応答が無いので 1 回送り直します/).length, 1)
  await seq.destroy()
})

// 戻すと落ちるもの: 待つ長さを sendTimeout × sendMaxTries + 10 秒に戻す（1 回落とすと 70 秒待つ形）
test('送り直しても応答が無ければ取りこぼし 1 回。待つ長さは responseTimeoutMs × 2（再試行のぶんを足さない）', async () => {
  const { seq, transport, logs } = build({}, { sendTimeout: 20000, responseTimeoutMs: 100 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 2 })
  const t0 = performance.now()
  await assert.rejects(() => seq.get([0xe7], 'test'), (e) => e.code === 'TIMEOUT' && e.timeout === true)
  const took = performance.now() - t0
  assert.ok(took < 5000, `送ってから ${took} ms（sendTimeout × sendMaxTries で待つと 60 秒を超える）`)
  assert.equal(seq.state.pollMisses, 1)
  assert.equal(texts(logs, /応答がありません（連続 1 回）/).length, 1)
  await seq.destroy()
})

test('responseResends: 0 なら送り直さない。応答の待ちは sendTimeout を超えない', async () => {
  const { seq, transport } = build({}, { responseResends: 0, sendTimeout: 80, responseTimeoutMs: 100000 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1 })
  const t0 = performance.now()
  await assert.rejects(() => seq.get([0xe7], 'test'), (e) => e.code === 'TIMEOUT')
  assert.ok(performance.now() - t0 < 5000, 'responseTimeoutMs の 100 秒を待たない')
  assert.equal(seq.snapshot().counters.resends, 0)
  await seq.destroy()
})

// 戻すと落ちるもの: _pending.tids で照らさない（前の TID の応答を捨てて 2 回目を待つ）・_lateTids を外す（同じ値が 2 回出る）
test('応答が遅れても、先に届いた方を使い、もう片方は出さない', async () => {
  // 応答は 1 回目の待ちが切れて送り直したあと、2 回目の待ちが切れる前に届く。
  // 待ちと応答の遅れの差が小さいと、負荷が高いときに順番が入れ替わるので、どちらも大きく空ける
  const { seq, transport } = build({ echonetDelayMs: 900 }, { responseTimeoutMs: 600 })
  await seq.start()
  await ready(seq)
  const seen = []
  seq.on('measurement', (m) => m.purpose === 'test' && seen.push(m))
  const recovered = seq.snapshot().counters.resendRecovered // 接続時の取得でも送り直している
  const r = await seq.get([0xe7], 'test')
  assert.equal(r.values[0].epc, 0xe7)
  await sleep(1000) // 送り直した方の応答が届くまで
  assert.equal(seen.length, 1, '同じ値を二度出さない')
  assert.equal(seq.snapshot().counters.resendRecovered, recovered + 1)
  assert.ok(transport.sent.filter((c) => /^SKSENDTO/.test(c)).length >= 2)
  await seq.destroy()
})

test('履歴（E2 など）は長く待ち、送り直さない', async () => {
  const { seq, transport } = build({}, { bulkySendTimeout: 120, responseTimeoutMs: 20 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1 })
  const before = transport.sent.filter((c) => /^SKSENDTO/.test(c)).length
  await assert.rejects(() => seq.get([0xe2], 'test'), (e) => e.code === 'TIMEOUT')
  assert.equal(transport.sent.filter((c) => /^SKSENDTO/.test(c)).length, before + 1)
  await seq.destroy()
})

// ---- UDP 送信失敗 ---------------------------------------------------------------------------

test('EVENT 21 <PARAM>=01 の再試行の間隔は 2 秒 → 5 秒（±20%）', () => {
  const { seq } = build({}, { sendRetryDelaysMs: [2000, 5000], sendRetryJitter: 0.2 })
  for (let i = 0; i < 50; i++) {
    const a = seq._sendRetryDelay(1)
    const b = seq._sendRetryDelay(2)
    const c = seq._sendRetryDelay(9)
    assert.ok(a >= 1600 && a <= 2400, String(a))
    assert.ok(b >= 4000 && b <= 6000, String(b))
    assert.ok(c >= 4000 && c <= 6000, String(c))
  }
})

// 戻すと落ちるもの: _afterSendFailure の busy で段階 2 にする
test('UDP 送信失敗が続いても SKSCAN を撃たず、取りこぼしが 3 回で段階 1（同じメーターへ SKJOIN）', async () => {
  const { seq, transport, logs } = build({}, { pollIntervalSec: 1, sendMaxTries: 2 })
  await seq.start()
  await ready(seq)
  transport.sent.length = 0
  inject(transport, { sendto: 6 })
  await waitFor(() => transport.sent.some((c) => /^SKJOIN/.test(c)), 8000, 'SKJOIN')
  assert.equal(transport.sent.filter((c) => /^SKSCAN/.test(c)).length, 0, 'スキャンしない')
  assert.ok(texts(logs, /再接続します（段 1）/).length >= 1)
  await waitFor(() => seq.isConnected, 8000, '再接続')
  await seq.destroy()
})

// ---- 知っているチャネルを先に -----------------------------------------------------------------

// 戻すと落ちるもの: _scanAndJoin で _scanKnownChannel を呼ばない
test('段階 2 は知っているチャネルだけを探す（CHANNEL_MASK の最下位ビットがチャネル 33）。見えたら全チャネルは探さない', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  assert.equal(seq.snapshot().meter.channel, 59)
  transport.sent.length = 0
  await seq.reconnect('試験', 2)
  await waitFor(() => transport.sent.some((c) => /^SKJOIN/.test(c)), 8000, 'スキャンのあとの SKJOIN')
  await waitFor(() => seq.isConnected, 8000, '再接続')
  const scans = transport.sent.filter((c) => /^SKSCAN/.test(c))
  assert.equal(scans[0], 'SKSCAN 2 04000000 6 0')
  assert.equal(scans.filter((c) => c.includes('FFFFFFFF')).length, 0)
  assert.equal(seq.snapshot().counters.targetedScans, 1)
  await seq.destroy()
})

test('知っているチャネルで 3 回見えなければ全チャネルを探す', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await ready(seq)
  transport.sent.length = 0
  transport.config.meterPresent = false
  await seq.reconnect('試験', 2)
  await waitFor(() => transport.sent.some((c) => c.includes('FFFFFFFF')), 8000, '全チャネル')
  const scans = transport.sent.filter((c) => /^SKSCAN/.test(c))
  assert.deepEqual(scans.slice(0, 3).map((c) => c.split(' ')[3]), ['6', '7', '8'])
  assert.equal(scans[3].split(' ')[2], 'FFFFFFFF')
  assert.ok(texts(logs, /全チャネルを探します/).length >= 1)
  transport.config.meterPresent = true
  await seq.destroy()
})

// ---- LQI ------------------------------------------------------------------------------------

test('ERXUDP の <RSSI>: 11 個の欄のときだけ読む。負なら dBm、DATALEN と DATA の読み方は変わらない', () => {
  const head = 'ERXUDP FE80:0000:0000:0000:021D:1290:1234:5678 FE80:0000:0000:0000:021D:1290:0000:0001 0E1A 0E1A 001D129012345678'
  const a = SK.parseLine(`${head} B5 1 0 0002 1081`)
  assert.equal(a.rssi, -75)
  assert.equal(a.lqi, 106)
  assert.equal(a.datalen, 2)
  assert.equal(a.hex, '1081')
  const b = SK.parseLine(`${head} 1 0 0002 1081`)
  assert.equal(b.rssi, undefined)
  assert.equal(b.hex, '1081')
  assert.equal(SK.parseLine(`${head} FFB5 1 0 0002 1081`).rssi, -75, '4 桁でも読む')
  const c = SK.parseLine(`${head} 5E 1 0 0002 1081`)
  assert.equal(c.lqi, 94, '0 以上なら LQI の尺度')
  assert.equal(SK.parseLine(`${head} XY 1 0 0002 1081`).rssi, undefined)
})

// 戻すと落ちるもの: 初期化で SKSREG SA2 1 を送らない・_onErxudp で meter.lqi を更新しない
test('応答のたびに LQI が変わる（接続中もスキャンの値のままにしない）', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  assert.ok(transport.sent.includes('SKSREG SA2 1'))
  const m = seq.snapshot().meter
  assert.equal(typeof m.rssi, 'number')
  assert.ok(m.rssi < 0, String(m.rssi))
  assert.equal(typeof m.lqi, 'number')
  assert.equal(typeof m.lqiAt, 'number')
  await seq.destroy()
})

// 戻すと落ちるもの: SKSREG SA2 の _send から optional を外す（接続のたびに error と lastError が残る）
test('SKSREG SA2 が通らないモジュールでも接続する。LQI はスキャンのときの値のまま', async () => {
  const { seq, transport, logs } = build({ fail: { sregWrite: ['SA2'] } })
  await seq.start()
  await ready(seq)
  const s = seq.snapshot()
  assert.deepEqual(texts(logs, /受信の強さを付けられませんでした/).map((l) => l.level), ['info'], 'info を 1 行')
  assert.equal(texts(logs, /SA2/).filter((l) => l.level === 'error' || l.level === 'warn').length, 0, 'error も warn も出さない')
  assert.equal(s.lastError, null, '画面の直近のエラーに残さない')
  assert.equal(s.counters.failures, 0, '失敗の数に入れない')
  assert.equal(transport.sent.filter((c) => c === 'SKSREG SA2 1').length, 1, '再試行しない')
  assert.equal(s.meter.rssi, null)
  assert.equal(typeof s.meter.lqi, 'number')
  await seq.destroy()
})
