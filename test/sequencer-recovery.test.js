'use strict'

// 接続が通らないときの立て直しと、その知らせ方。本物の Sequencer と SimulatorTransport で確かめる。
//   - 送信の失敗に機械が読む code が付く
//   - 認証は通るのに ECHONET が返らないときも、段階を上げて SKRESET に届く
//   - 接続の途中の失敗は数えて待つ（SKJOIN とスキャンが間を空けずに回らない）
//   - 閉じるとき・起動するときにセッションを残さない
//   - つながらないときの案内は理由ごとに持ち続ける
//   - 再送の配線（再試行の間隔・取りこぼしの数え方・送り直しの失敗・見張り・SA2）
// 各試験の上の「戻すと落ちるもの」は、写しの上で実際に外して確かめた。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Sequencer } = require('../lib/sequencer')
const { SimulatorTransport } = require('../lib/simulator-transport')
const { mapError } = require('../lib/runtime/service')
const { connectHintOf } = require('../lib/runtime/view-model')
const { hintOf } = require('../lib/runtime/error-hints')
const { health } = require('../lib/runtime/health')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 試験が途中で落ちても片付ける。回ったままの sequencer を残すと、Node 18 では試験のプロセスが終わらない
const live = []
afterEach(async () => {
  for (const s of live.splice(0)) await s.destroy().catch(() => {})
})

// 時間は単調な時計で測る。壁時計は飛ぶことがあり（Docker の VM で秒単位）、飛ぶと待ちが早く切れる
async function waitFor(fn, ms, what) {
  const limit = performance.now() + (ms || 5000)
  while (performance.now() < limit) {
    if (fn()) return true
    await sleep(5)
  }
  throw new Error('待ち時間を超えました: ' + (what || '条件'))
}

function build(simConfig, seqOptions) {
  const transport = new SimulatorTransport(Object.assign({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005 }, simConfig))
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
        responseTimeoutMs: 40,
        sendRetryDelaysMs: [10, 20],
        joinRetryMs: 10,
        joinBurstBackoffMs: [20],
        joinPersistMs: 200,
        credentialHintAfterMs: 100000,
        retryBaseMs: 30,
        maxRetryDelayMs: 2000,
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
  await waitFor(() => seq.snapshot().known['0xE7'], 8000, '最初の取得')
  await waitFor(() => seq._requestDepth === 0 && !seq._current && seq._queue.length === 0, 8000, '接続時の取得')
}

function inject(transport, fail) {
  transport.config.fail = Object.assign({}, transport.config.fail, fail)
  Object.assign(transport.state, { sendFailures: 0, missed: 0, nsCount: 0, muted: 0 })
}

const texts = (logs, re) => logs.filter((l) => re.test(l.text))
const count = (transport, re) => transport.sent.filter((c) => re.test(c)).length

/** SKSENDTO のデータ部を受けたら FAIL ER10 を返す（SKJOIN は通るのに送信だけ断られるモジュール）。 */
function refuseSendTo(transport) {
  transport._onSendToData = function () {
    return this._fail('ER10')
  }
}

// ---- シミュレーターの行の順 -------------------------------------------------------------------

// 戻すと落ちるもの: _later を 1 行 1 本のタイマーに戻す（遅れたときに、先に張った同じ長さのタイマーの行が先に出る）
test('イベントループが遅れても、シミュレーターの行は出す時刻の順に届く', async () => {
  const transport = new SimulatorTransport({ latencyMs: 1 })
  await transport.open()
  await sleep(5)
  const got = []
  transport.on('line', (b) => got.push(b.toString('latin1').trim()))
  setTimeout(() => {}, 10) // 同じ長さのタイマーが先に動く形を作る
  const until = performance.now() + 3
  while (performance.now() < until) {
    /* 張る時刻をずらす */
  }
  const expected = []
  for (let ms = 6; ms <= 13; ms++) {
    transport._emitLine('L' + ms, ms)
    expected.push('L' + ms)
  }
  const stall = performance.now() + 40
  while (performance.now() < stall) {
    /* イベントループを止める */
  }
  await sleep(30)
  assert.deepEqual(got, expected)
  await transport.close()
})

// 戻すと落ちるもの: _later・_armOutbox・_drainOutbox の時刻を Date.now に戻す
// （進むと 400ms 先の行がすぐ出る行と一緒に出る・戻ると 1 時間止まる）
test('壁時計が進んでも戻っても、シミュレーターの行は決めた遅れで届く（早まらない・止まらない）', async () => {
  // Docker の VM では Date.now が 30 秒ごとに 1 秒ほど進む。NTP で時刻を合わせたときは戻ることもある
  const realNow = Date.now
  let shift = 0
  const transport = new SimulatorTransport({ latencyMs: 1 })
  await transport.open()
  await sleep(5)
  const got = []
  transport.on('line', (b) => got.push({ text: b.toString('latin1').trim(), at: performance.now() }))
  const arrived = (text) => got.find((g) => g.text === text)
  try {
    Date.now = () => realNow() + shift
    // 進む: 400ms 先の行を張ってから壁時計を 5 秒進め、すぐ出す行を足す（足すと出す順の箱が張り直される）。
    // 見るのは届いた時刻だけ（CPU が足りずに 400ms 止まれば、正しくても 2 行は一緒に届く）
    const t0 = performance.now()
    transport._emitLine('LATE', 400)
    shift = 5000
    transport._emitLine('SOON', 1)
    await waitFor(() => arrived('LATE'), 3000, '400ms 先の行')
    assert.ok(arrived('SOON'), 'すぐ出す行も届いた')
    const lateMs = Math.round(arrived('LATE').at - t0)
    assert.ok(lateMs >= 395, `壁時計が進んだだけで、400ms 先の行が ${lateMs}ms で出た`)
    // 戻る: 50ms 先の行を張ってから壁時計を 1 時間戻す
    transport._emitLine('BACK', 50)
    shift -= 3600 * 1000
    await waitFor(() => arrived('BACK'), 3000, '壁時計が戻ったあとの 50ms 先の行')
  } finally {
    Date.now = realNow
    await transport.close()
  }
})

// ---- 送信の失敗の code ------------------------------------------------------------------------

// 戻すと落ちるもの: _matchCurrent の UDP 送信失敗の CommandError から code を外す（API が 500 INTERNAL になる）
test('手動の取得が UDP 送信失敗で終わると、502 DEVICE_ERROR に読める', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  inject(transport, { sendto: 3 })
  const e = await seq.get([0xe7], 'test').then(
    () => null,
    (x) => x,
  )
  assert.ok(e, '失敗すること')
  assert.equal(e.code, 'DEVICE_ERROR')
  assert.equal(e.sendFail, 'busy', '取りこぼしの判断に使う印は残す')
  const api = mapError(e)
  assert.equal(api.status, 502)
  assert.equal(api.code, 'DEVICE_ERROR')
  await seq.destroy()
})

// ---- 認証は通るのに ECHONET が返らない --------------------------------------------------------

// 戻すと落ちるもの: join.windows を SKJOIN の成功で 0 に戻す（段階 1 と 2 を回り続ける）
test('認証は通るのに ECHONET が返らないままなら、粘りを使い切るたびに数えて SKRESET に届く', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  transport.sent.length = 0
  inject(transport, { noEchonetResponse: 1e9 })
  await seq.reconnect('試験', 1)
  await waitFor(() => transport.sent.includes('SKRESET'), 12000, 'SKRESET')
  assert.ok(count(transport, /^SKSCAN/) >= 2, '先にスキャンからやり直している')
  // セッションを畳まずにリセットすると、メーター側に残って SKJOIN が通らなくなる
  const term = transport.sent.lastIndexOf('SKTERM', transport.sent.indexOf('SKRESET'))
  assert.equal(transport.sent.indexOf('SKRESET') - term, 1, 'SKRESET の直前に SKTERM')
  await seq.destroy()
})

test('粘りの回数は、疎通が確かめられたら 0 に戻る', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1e9 })
  await seq.reconnect('試験', 1)
  await waitFor(() => seq.state.join.windows >= 1, 8000, '粘りを 1 回使い切る')
  inject(transport, { noEchonetResponse: 0 })
  await waitFor(() => seq.state.phase === 'connected', 8000, '復旧')
  assert.equal(seq.state.join.windows, 0)
  await seq.destroy()
})

// ---- 接続の途中で手当てした失敗は、数えて待つ -----------------------------------------------

// 戻すと落ちるもの: _runLoop の err.handled の分岐を外す（待たずに回り、連続失敗が 0 のまま）
test('接続の途中で SKSENDTO が ER10 のままなら、連続失敗に数え、間を空け、待つ秒数をログに出す', async () => {
  const { seq, transport, logs } = build({}, { retryBaseMs: 200, joinRetryMs: 500, joinBurstBackoffMs: [500], joinPersistMs: 100000 })
  await seq.start()
  await ready(seq)
  const joinedAt = []
  const write = transport.write.bind(transport)
  transport.write = (b) => {
    if (/^SKJOIN/.test(b.toString('latin1'))) joinedAt.push(performance.now())
    return write(b)
  }
  refuseSendTo(transport)
  await seq.reconnect('試験', 1)
  // 1 回の失敗は ER10 の再試行（1 秒 + 2 秒）のぶんだけかかる。負荷が高いときのために余裕を持つ（守る内容は数え方で、速さではない）
  await waitFor(() => seq.state.consecutiveFailures >= 2, 30000, '2 回目の失敗')
  assert.ok(joinedAt.length >= 2, String(joinedAt.length))
  assert.ok(joinedAt[1] - joinedAt[0] >= 180, `SKJOIN の間隔 ${joinedAt[1] - joinedAt[0]} ms`)
  assert.ok(texts(logs, /0 秒後に段 1 で再試行します（連続 1 回目/).length >= 1, 'いつやり直すかをログに残す')
  assert.equal(seq.snapshot().connected, false)
  assert.match(seq.snapshot().lastError.message, /ER10/, '連続失敗の知らせに理由が要る')
  await seq.destroy()
})

// 戻すと落ちるもの: _afterHandledFailure の _bumpLadder を外す（段 1 を回り続ける）
test('手当てを繰り返しても直らなければ段を上げて、SKRESET に届く', async () => {
  const { seq, transport } = build({}, { joinPersistMs: 100000, sendMaxTries: 1 })
  await seq.start()
  await ready(seq)
  transport.sent.length = 0
  // B ルートノードの alert は、status の連続失敗の数と理由を見て 1 度だけ出す
  const failing = []
  seq.on('status', (s) => {
    if (s.phase !== 'connected' && s.consecutiveFailures >= 3) failing.push(s)
  })
  refuseSendTo(transport)
  await seq.reconnect('試験', 1)
  await waitFor(() => transport.sent.includes('SKRESET'), 10000, 'SKRESET')
  assert.ok(count(transport, /^SKSCAN/) >= 1, '段 2 を通っている')
  assert.ok(failing.length >= 1, 'alert の条件が status に届く')
  assert.match(failing[0].lastError.message, /ER10/)
  await seq.destroy()
})

// 戻すと落ちるもの: _afterHandledFailure の _guardTxBudget を外す（送信時間の見張りを通らない）
test('接続の途中で手当てした失敗のあとも、送信時間の見張りを通る', async () => {
  const { seq, transport, logs } = build({ txTotalMs: 300000 }, { txBudgetGuard: true, txBudgetPauseMs: 30, joinPersistMs: 100000 })
  await seq.start()
  await ready(seq)
  refuseSendTo(transport)
  await seq.reconnect('試験', 1)
  await waitFor(() => texts(logs, /全部止まる前に/).length >= 1, 5000, '見張りのログ')
  await seq.destroy()
})

// 戻すと落ちるもの: _afterSendFailure の noNa の枝と reconnect() の両方で connected を下ろさない
test('宛先が解決しない状態が続いても connected を上げたまま回らず、連続失敗に数える', async () => {
  const { seq, transport } = build({}, { naWaitMs: 20, sendMaxTries: 1, pollIntervalSec: 1, joinPersistMs: 100000 })
  await seq.start()
  await ready(seq)
  inject(transport, { ns: 1e9, nsNoAnswer: true })
  await waitFor(() => seq.state.consecutiveFailures >= 1, 8000, '連続失敗')
  assert.equal(seq.snapshot().connected, false)
  assert.ok(seq.snapshot().ladder >= 2, 'スキャンからアドレスを取り直す')
  await seq.destroy()
})

// ---- 閉じるとき・起動するときにセッションを残さない -------------------------------------------

// 戻すと落ちるもの: _termBeforeReset の初期値を false に戻す（前の Sequencer のセッションが残る）
test('セッションが残ったモジュールを開いても、SKRESET の前に SKTERM で畳む', async () => {
  const { seq, transport } = build()
  await transport.open()
  transport.state.joined = true
  await seq.start()
  await ready(seq)
  const term = transport.sent.indexOf('SKTERM')
  assert.ok(term >= 0, 'SKTERM を送る')
  assert.ok(term < transport.sent.indexOf('SKRESET'), '先に SKTERM')
  await seq.destroy()
})

// 戻すと落ちるもの: _tryTerm の SKTERM から optional を外す（普通の起動で「失敗: SKTERM — ER10」が残る）
test('セッションが無い普通の起動では、SKTERM の ER10 を失敗に数えない', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await ready(seq)
  assert.ok(transport.sent.includes('SKTERM'))
  const s = seq.snapshot()
  assert.equal(s.lastError, null)
  assert.equal(s.counters.failures, 0)
  assert.equal(logs.filter((l) => l.level === 'error').length, 0, logs.map((l) => l.text).join(' / '))
  assert.equal(texts(logs, /SKTERM/).filter((l) => l.level === 'warn').length, 0)
  await seq.destroy()
})

test('SKTERM が ER10 以外で通らないときは warn を残す', async () => {
  const { seq, transport, logs } = build()
  await transport.open()
  const on = transport._onCommand.bind(transport)
  transport._onCommand = function (raw) {
    if (raw === 'SKTERM') return this._fail('ER09')
    return on(raw)
  }
  await seq.start()
  await ready(seq)
  assert.equal(texts(logs, /SKTERM が通りませんでした/).length, 1)
  await seq.destroy()
})

// 戻すと落ちるもの: destroy の条件を state.connected だけに戻す
test('取りこぼしで connected を下ろしたあとの接続の途中で閉じても、SKTERM を送る', async () => {
  const { seq, transport } = build({}, { pollIntervalSec: 1, joinPersistMs: 60000 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1e9 })
  await waitFor(() => seq.state.phase === 'verifying', 20000, '疎通確認')
  assert.equal(seq.snapshot().connected, false)
  assert.equal(transport.state.joined, true, 'セッションは残っている')
  transport.sent.length = 0
  await seq.destroy()
  assert.ok(transport.sent.includes('SKTERM'))
  assert.equal(transport.state.joined, false, 'メーターにセッションを残さない')
})

// 戻すと落ちるもの: destroy の条件から state.portOpen を外す（送れないのに上限の 6 秒待つ）
test('ポートが閉じていたら、閉じるときに SKTERM を待たない', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  inject(transport, { open: 1e9 }) // 開き直せない（抜かれたまま）
  transport.state.openFailures = 0
  await transport.close()
  assert.equal(seq.state.portOpen, false)
  const t0 = performance.now()
  await seq.destroy()
  assert.ok(performance.now() - t0 < 4000, `${performance.now() - t0} ms（上限の 6 秒を待たない）`)
})

test('閉じるときの SKTERM が ER10 でも warn を残さない（セッションが無いなら畳めている）', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await ready(seq)
  transport.state.joined = false
  await seq.destroy()
  assert.equal(texts(logs, /終了時の SKTERM が通りませんでした/).length, 0)
  assert.equal(texts(logs, /失敗: SKTERM/).length, 0)
})

// ---- 再接続の間の見え方 -----------------------------------------------------------------------

// 戻すと落ちるもの: reconnect() の state.connected = false を外す（値が古くなるまで「計測中」のまま）
test('再接続を始めたら connected を下ろす。health は計測中と言わない', async () => {
  const { seq } = build()
  await seq.start()
  await ready(seq)
  await seq.reconnect('試験', 1)
  const s = seq.snapshot()
  assert.equal(s.connected, false)
  const h = health({ enabled: true, running: true, portOpen: true, connected: s.connected, phase: 'joining', phaseText: '認証中', consecutiveFailures: 0, ladder: 1 }, Date.now())
  assert.notEqual(h.level, 'ok')
  await waitFor(() => seq.snapshot().connected === true, 8000, '復旧')
  await seq.destroy()
})

// ---- terminate --------------------------------------------------------------------------------

// 戻すと落ちるもの: terminate の _clearPending を外す（応答待ちがタイマーまで残る。_armResponse の守りも外すと、止めたあとに
// SKSENDTO を 3 回送り、ER10 の error が出て段階が動く）
test('取得の途中で terminate しても、SKTERM のあとに電波を出さず、段階も動かさない', async () => {
  const { seq, transport, logs } = build({}, { responseTimeoutMs: 300 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 5 })
  transport.sent.length = 0
  const pending = seq.get([0xe7], 'test').then(
    () => null,
    (e) => e,
  )
  await sleep(30)
  await seq.terminate()
  assert.equal(seq._pending, null, '応答待ちを畳んでから終える')
  const at = transport.sent.indexOf('SKTERM')
  assert.ok(at >= 0)
  await sleep(800)
  const e = await pending
  assert.ok(e && e.aborted, '止めたことで畳まれた')
  assert.equal(transport.sent.slice(at + 1).filter((c) => /^SKSENDTO/.test(c)).length, 0)
  assert.equal(seq.state.ladder, 0)
  assert.equal(seq.state.phase, 'overridden')
  assert.equal(logs.filter((l) => l.level === 'error').length, 0)
  await seq.destroy()
})

// 戻すと落ちるもの: _armResponse のタイマーの !_running の守りを外す
test('自動運転を止めたあとに応答待ちのタイマーが切れても、送り直さない', async () => {
  const { seq, transport } = build({}, { responseTimeoutMs: 60 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 5 })
  transport.sent.length = 0
  const pending = seq.get([0xe7], 'test').then(
    () => null,
    (e) => e,
  )
  await waitFor(() => seq._pending && seq._pending.timer, 2000, '応答待ち')
  seq._running = false
  const e = await pending
  assert.ok(e && e.aborted)
  assert.equal(count(transport, /^SKSENDTO/), 1)
  seq._running = true
  await seq.destroy()
})

// ---- 送り直したあとの TID ---------------------------------------------------------------------

async function withLateTid(seq, transport) {
  inject(transport, { noEchonetResponse: 1 })
  await seq.get([0xe7], 'test')
  assert.equal(seq._lateTids.size, 1, '遅れた応答を待つ印')
  return [...seq._lateTids][0]
}

// 戻すと落ちるもの: _nextTid の _lateTids.delete を外す（新しい応答を捨てて余分に送り直す）
test('周回して同じ TID を使うときは、古い印で新しい応答を捨てない', async () => {
  const { seq, transport } = build({}, { responseTimeoutMs: 100 })
  await seq.start()
  await ready(seq)
  const stale = await withLateTid(seq, transport)
  seq._tid = stale - 1
  const before = seq.snapshot().counters.resends
  const r = await seq.get([0xe7], 'test')
  assert.equal(r.tid, stale)
  assert.equal(seq.snapshot().counters.resends, before, '送り直していない')
  await seq.destroy()
})

// 戻すと落ちるもの: _onErxudp の !frame.isInf を外す（たまたま同じ TID の自発の通知を黙って捨てる）
test('遅れた応答の印と同じ TID の自発の通知（INF）を捨てない', async () => {
  const { seq, transport } = build({}, { responseTimeoutMs: 100 })
  await seq.start()
  await ready(seq)
  const stale = await withLateTid(seq, transport)
  const seen = []
  seq.on('measurement', (m) => seen.push(m.purpose))
  const inf = Buffer.from([0x10, 0x81, (stale >> 8) & 255, stale & 255, 0x02, 0x88, 0x01, 0x05, 0xff, 0x01, 0x73, 0x01, 0x80, 0x01, 0x30])
  seq._onErxudp({ lport: 0x0e1a, encoding: 'hex', hex: inf.toString('hex').toUpperCase(), sender: 'x' })
  assert.deepEqual(seen, ['inf'])
  assert.equal(seq._lateTids.size, 1, 'こちらの応答の印は残す')
  await seq.destroy()
})

// ---- つながらないときの案内 -------------------------------------------------------------------

test('snapshot は connectHint の鍵を必ず持つ（無いときは null）', async () => {
  const { seq } = build()
  assert.ok(Object.prototype.hasOwnProperty.call(seq.snapshot(), 'connectHint'))
  assert.equal(seq.snapshot().connectHint, null)
  await seq.start()
  await ready(seq)
  assert.equal(seq.snapshot().connectHint, null)
  await seq.destroy()
})

// 戻すと落ちるもの: _joinKnownMeter の _noteConnectHint を外す・connected で null に戻さない
test('認証が通らないと credentials の案内が出続け、粘りを使い切っても消えず、つながると消える', async () => {
  const { seq, transport } = build({ fail: { join: 1e9 } }, { credentialHintAfterMs: 60, joinPersistMs: 300 })
  await seq.start()
  await waitFor(() => seq.snapshot().connectHint, 8000, '案内')
  const first = seq.snapshot().connectHint
  assert.equal(first.kind, 'credentials')
  assert.equal(typeof first.since, 'number')
  assert.ok(first.rounds >= 1)

  // 次の SKJOIN の失敗・粘りの終わり・スキャンを挟んでも、案内は続く
  const until = performance.now() + 1000
  const seen = []
  while (performance.now() < until) {
    seen.push(seq.snapshot().connectHint)
    await sleep(5)
  }
  assert.ok(seq.snapshot().counters.targetedScans >= 1, '粘りを使い切ってスキャンへ進んだ')
  assert.equal(seen.filter((h) => !h).length, 0, '案内が消えない')
  assert.equal(seen[seen.length - 1].since, first.since, '始まりの時刻は保つ')
  assert.ok(seen[seen.length - 1].rounds > first.rounds, '巡の数が増える')

  const s = seq.snapshot()
  const view = connectHintOf(s, Date.now())
  assert.equal(view.kind, 'credentials')
  const h = health({ enabled: true, running: true, portOpen: true, connected: false, phase: s.phase, phaseText: s.phaseText, connectHint: view, consecutiveFailures: 0, ladder: s.ladder }, Date.now())
  assert.match(h.reasons.join(' '), /認証/)
  assert.ok(h.nextAction, '次にすることを出す')

  transport.config.fail.join = 0
  await waitFor(() => seq.snapshot().connected, 8000, '復旧')
  assert.equal(seq.snapshot().connectHint, null)
  await seq.destroy()
})

// 戻すと落ちるもの: _onSkEvent の EVENT 25 で案内を下ろさない
test('EVENT 25 が返ったら、疎通確認がまだでも credentials の案内を下ろす', async () => {
  const { seq, transport } = build({ fail: { join: 1e9 } }, { credentialHintAfterMs: 0, joinPersistMs: 100000 })
  await seq.start()
  await waitFor(() => seq.snapshot().connectHint, 8000, '案内')
  inject(transport, { noEchonetResponse: 1e9 })
  transport.config.fail.join = 0
  await waitFor(() => seq.state.phase === 'verifying', 8000, '疎通確認')
  assert.equal(seq.snapshot().connectHint, null)
  await seq.destroy()
})

// 戻すと落ちるもの: 粘りの文と案内を SKJOIN の失敗と分けない（認証情報は正しいのにパスワードを確かめるよう案内する）
test('認証は通るのに ECHONET が返らないときは、認証の失敗とは書かず、案内も出さない', async () => {
  const { seq, transport, logs } = build({}, { credentialHintAfterMs: 0, joinPersistMs: 100 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1e9 })
  await seq.reconnect('試験', 1)
  await waitFor(() => /分ありません/.test((seq.snapshot().lastError || {}).message), 8000, '粘りの終わり')
  const s = seq.snapshot()
  assert.equal(s.join.last.num, 0x25)
  assert.match(s.lastError.message, /^メーターとの認証は通りますが、メーターの応答が \d+ 分ありません（ECHONET 応答のタイムアウト）/)
  assert.equal(s.connectHint, null)
  assert.ok(texts(logs, /メーターとの認証は通りましたが、メーターから応答がありません（1 巡目 1\/3/).length >= 1)
  assert.equal(texts(logs, /メーターとの認証が通りませんでした/).length, 0)
  assert.equal(texts(logs, /認証 ID かパスワードが誤っている/).length, 0, '認証情報を疑うログを出さない')
  assert.doesNotMatch(hintOf(s.lastError.message) || '', /パスワード/, '画面の 1 行もパスワードを勧めない')
  await seq.destroy()
})

// 戻すと落ちるもの: _scan の _noteConnectHint を外す・_adoptPan で下ろさない
test('対応するメーターが見えないと no-meter の案内が出て、探した数が増え、見つかると消える', async () => {
  const { seq, transport } = build({ pairId: 'FFFFFFFF' }, { maxRetryDelayMs: 50 })
  await seq.start()
  await waitFor(() => seq.snapshot().connectHint, 8000, '案内')
  const first = seq.snapshot().connectHint
  assert.equal(first.kind, 'no-meter')
  await waitFor(() => seq.snapshot().connectHint.rounds >= 3, 8000, '探した数')
  assert.equal(seq.snapshot().connectHint.since, first.since)
  inject(transport, { join: 1e9 })
  transport.config.pairId = ID.slice(-8)
  await waitFor(() => !seq.snapshot().connectHint, 8000, '見つかる')
  assert.equal(seq.snapshot().connected, false, '見つかった時点で下ろす（つながるのを待たない）')
  transport.config.fail.join = 0
  await waitFor(() => seq.isConnected, 8000, '接続')
  await seq.destroy()
})

// 戻すと落ちるもの: _afterJoin で connectHint を null に戻さない（段 0 は EVENT 25 も _adoptPan も no-meter を下ろさない道）
test('段 0 でつながっても、案内を残さない', async () => {
  const { seq, transport } = build({}, { retryBaseMs: 3000, maxRetryDelayMs: 3000 })
  await seq.start()
  await ready(seq)
  transport.config.meterPresent = false
  await seq.reconnect('試験', 2)
  await waitFor(() => seq.snapshot().connectHint, 8000, '案内')
  assert.equal(seq.snapshot().connectHint.kind, 'no-meter')
  transport.config.meterPresent = true
  await seq.reconnect('試験', 0)
  await waitFor(() => seq.snapshot().connected, 8000, '再認証')
  assert.equal(seq.snapshot().connectHint, null)
  await seq.destroy()
})

// 戻すと落ちるもの: setCredentials と stop で案内を下ろさない
test('認証情報を入れ直すか止めたら、古い案内を残さない', async () => {
  const { seq } = build({ fail: { join: 1e9 } }, { credentialHintAfterMs: 0, joinPersistMs: 100000 })
  await seq.start()
  await waitFor(() => seq.snapshot().connectHint, 8000, '案内')
  seq.setCredentials(ID, PW, 'test')
  assert.ok(seq.snapshot().connectHint, '同じ値なら下ろさない')
  seq.setCredentials(ID, 'FEDCBA654321', 'test')
  assert.equal(seq.snapshot().connectHint, null)
  await waitFor(() => seq.snapshot().connectHint, 8000, '案内がまた出る')
  await seq.stop('試験')
  assert.equal(seq.snapshot().connectHint, null)
  await seq.destroy()
})

// ---- 再送の配線 -------------------------------------------------------------------------------

// 戻すと落ちるもの: _fail で _sendRetryDelay を呼ばない（関数を直に呼ぶ試験では見えない）
test('UDP 送信失敗の再試行は sendRetryDelaysMs の間隔で送る', async () => {
  const { seq, transport } = build({}, { sendRetryDelaysMs: [300, 700], sendRetryJitter: 0, sendMaxTries: 3 })
  await seq.start()
  await ready(seq)
  const times = []
  const write = transport.write.bind(transport)
  transport.write = (b) => {
    if (/^SKSENDTO/.test(b.toString('latin1'))) times.push(performance.now())
    return write(b)
  }
  inject(transport, { sendto: 3 })
  await seq.get([0xe7], 'test').catch(() => {})
  assert.equal(times.length, 3)
  const gaps = [times[1] - times[0], times[2] - times[1]]
  // 間隔は EVENT 21 が返ってから数えるので、シミュレーターの 50 ms と遅れのぶんだけ長い。
  // 上の限りは、ほかの間隔（sendRetryDelaysMs を使わないときの 1 秒・2 秒）との間に置く
  assert.ok(gaps[0] >= 295 && gaps[0] < 950, `1 回目 ${gaps[0]} ms`)
  assert.ok(gaps[1] >= 695 && gaps[1] < 1900, `2 回目 ${gaps[1]} ms`)
  await seq.destroy()
})

// 戻すと落ちるもの: _armResponse の reject から counted を外す（_poll がもう 1 回数える）
test('定期取得で応答を落としたら、取りこぼしは 1 回に 1 だけ増える', async () => {
  const { seq, transport, logs } = build({}, { pollMissLimit: 5 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 2 })
  seq.pollNow()
  await waitFor(() => texts(logs, /応答がありません（連続 1 回）/).length === 1, 3000, '取りこぼし')
  await sleep(30) // _poll の catch まで進める
  assert.equal(seq.state.pollMisses, 1)
  await seq.destroy()
})

// 戻すと落ちるもの: _afterSendFailure の busy の err.counted を外す（_poll がもう 1 回数える）
test('定期取得が UDP 送信失敗で終わっても、取りこぼしは 1 回に 1 だけ増える', async () => {
  const { seq, transport, logs } = build({}, { pollMissLimit: 5 })
  await seq.start()
  await ready(seq)
  inject(transport, { sendto: 3 })
  seq.pollNow()
  await waitFor(() => texts(logs, /UDP 送信失敗（EVENT 21/).length === 1, 3000, '送信失敗')
  await sleep(30)
  assert.equal(seq.state.pollMisses, 1)
  await seq.destroy()
})

// 戻すと落ちるもの: _resendRequest の失敗で _afterSendFailure を呼ばない（段階が上がらず、ER10 が続いても繋ぎ直さない）
test('送り直しの SKSENDTO が ER10 で終わったら、段階を上げて繋ぎ直す', async () => {
  const { seq, transport, logs } = build({}, { sendMaxTries: 1, responseTimeoutMs: 50 })
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1 })
  const original = transport._onSendToData
  let n = 0
  transport._onSendToData = function (ctx, data) {
    n++
    if (n === 2) {
      transport._onSendToData = original
      return this._fail('ER10')
    }
    return original.call(this, ctx, data)
  }
  transport.sent.length = 0
  await seq.get([0xe7], 'test').catch(() => {})
  await waitFor(() => transport.sent.some((c) => /^SKJOIN/.test(c)), 3000, 'SKJOIN')
  assert.ok(texts(logs, /再接続します（段 1）/).length >= 1)
  await seq.destroy()
})

// 戻すと落ちるもの: _resendRequest の pending.deadline を外す（再試行の待ちを滞留と誤判定して SKRESET へ飛ぶ）
test('接続を確かめる送り直しが再試行を待っている間は、見張りが叩かない', async () => {
  const { seq, transport, logs } = build(
    {},
    { watchdogIntervalMs: 30, watchdogStallMs: 60, responseTimeoutMs: 60, sendRetryDelaysMs: [5800], sendRetryJitter: 0, sendMaxTries: 2, joinPersistMs: 100000 },
  )
  await seq.start()
  await ready(seq)
  inject(transport, { noEchonetResponse: 1 })
  const original = transport._onSendToData
  let n = 0
  transport._onSendToData = function (ctx, data) {
    n++
    if (n === 2) {
      transport.config.fail.sendto = 1
      transport.state.sendFailures = 0
    }
    return original.call(this, ctx, data)
  }
  transport.sent.length = 0
  await seq.reconnect('試験', 1)
  await waitFor(() => n >= 3, 30000, '再試行の送信')
  assert.equal(texts(logs, /送受信が 1 件も進みませんでした/).length, 0)
  assert.equal(transport.sent.includes('SKRESET'), false)
  await seq.destroy()
})

// 戻すと落ちるもの: SKSREG SA2 1 を最初の 1 回しか送らない（シミュレーターも実機と同じく SKRESET で 0 に戻る）
test('SKRESET のあとも応答に受信の強さが付く', async () => {
  const { seq, transport } = build()
  await seq.start()
  await ready(seq)
  transport.sent.length = 0
  await seq.reconnect('試験', 3)
  await waitFor(() => transport.sent.includes('SKRESET'), 5000, 'SKRESET')
  await waitFor(() => seq.state.phase === 'connected', 8000, '接続')
  await waitFor(() => seq.snapshot().meter.rssi !== null, 3000, '受信の強さ')
  assert.equal(typeof seq.snapshot().meter.rssi, 'number')
  await seq.destroy()
})

for (const [channel, mask] of [
  [33, '00000001'],
  [59, '04000000'],
  [60, '08000000'],
]) {
  // 戻すと落ちるもの: _scanKnownChannel のマスクの式（期待は式でなく固定の値で書く）
  test(`知っているチャネルのスキャンのマスク: ch${channel} → ${mask}`, async () => {
    const { seq, transport } = build({ channel })
    await seq.start()
    await ready(seq)
    transport.sent.length = 0
    await seq.reconnect('試験', 2)
    await waitFor(() => transport.sent.some((c) => /^SKJOIN/.test(c)), 5000, 'SKJOIN')
    assert.equal(transport.sent.filter((c) => /^SKSCAN/.test(c))[0], `SKSCAN 2 ${mask} 6 0`)
    await seq.destroy()
  })
}
