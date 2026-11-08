'use strict'

// 既定の待ち時間のまま、数分から数時間ぶんの動きを見る。
//
// 待ちの長さそのものが仕様のもの（SKJOIN の保留の 60 秒・粘りの 30 分・再試行の 5 分）は、実時間では流せないし、
// 詰めると意味が変わる。そこで setTimeout と Date.now を仮想の時計へ差し替える。時計は試験が進めた分しか進まないので、
// 負荷も壁時計の飛びも結果に効かない。node --test はファイルごとに別のプロセスで流すので、差し替えはほかの試験へ漏れない。
// 値は全部架空。
//
// 戻すと落ちるもの: それぞれの試験に書いた。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')

// ---- 仮想の時計 -----------------------------------------------------------------------------

const realImmediate = global.setImmediate
const START = Date.UTC(2030, 0, 1)
let now = START
let nextId = 1
const timers = new Map()

function addTimer(fn, ms, args, repeat) {
  const id = nextId++
  const wait = Math.max(1, Number(ms) || 0)
  const t = {
    id,
    fn,
    args,
    at: now + wait,
    repeat: repeat ? wait : 0,
    unref() {
      return this
    },
    ref() {
      return this
    },
  }
  timers.set(id, t)
  return t
}

function removeTimer(t) {
  if (t === undefined || t === null) return
  timers.delete(typeof t === 'object' ? t.id : t)
}

global.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false)
global.clearTimeout = removeTimer
global.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true)
global.clearInterval = removeTimer
Date.now = () => now

const flush = () => new Promise((r) => realImmediate(r))

/** 時計を ms だけ進め、その間に来るタイマーを順に動かす。 */
async function advance(ms) {
  const end = now + ms
  for (;;) {
    await flush()
    let next = null
    for (const t of timers.values()) {
      if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t
    }
    if (!next) break
    now = Math.max(now, next.at)
    if (next.repeat) next.at = now + next.repeat
    else timers.delete(next.id)
    next.fn(...next.args)
  }
  now = end
  await flush()
  await flush()
}

/** 条件が成り立つまで進める。成り立ったら経過 [ms] を、maxMs までに成り立たなければ -1 を返す。 */
async function until(pred, maxMs, stepMs) {
  const t0 = now
  while (now - t0 < maxMs) {
    if (pred()) return now - t0
    await advance(stepMs || 50)
  }
  return pred() ? now - t0 : -1
}

const MINUTE = 60000
const HOUR = 60 * MINUTE

// ---- 組み立て ------------------------------------------------------------------------------

const { Sequencer } = require('../lib/sequencer')
const { SimulatorTransport } = require('../lib/simulator-transport')
const vm = require('../lib/runtime/view-model')
const { NEXT } = require('../lib/runtime/health')
const { hintOf } = require('../lib/runtime/error-hints')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'
const BIG = 1e9

/** 受け取ったコマンドの名前を、時刻つきで覚えるシミュレーター。 */
class LoggedSim extends SimulatorTransport {
  constructor(config) {
    super(config)
    this.log = []
    this.hook = null // (コマンド名, シミュレーター) → true なら既定の処理をしない
  }
  _onCommand(raw) {
    const name = raw.trim().split(/\s+/)[0].toUpperCase()
    this.log.push({ at: now, name, line: name === 'SKSETPWD' || name === 'SKSETRBID' ? name : raw.trim() })
    if (this.hook && this.hook(name, this)) return
    return super._onCommand(raw)
  }
  /** t 以後に受け取ったコマンドの名前（入力バッファを流す裸の CR は除く）。 */
  namesSince(t) {
    return this.log.filter((c) => c.at >= t && c.name).map((c) => c.name)
  }
}

const live = []

async function closeOf(seq) {
  let done = false
  const finish = () => {
    done = true
  }
  seq.destroy().then(finish, finish)
  await until(() => done, 30000, 20)
}

// 試験が途中で落ちても片付け、次の試験へタイマーを持ち越さない
afterEach(async () => {
  for (const s of live.splice(0)) await closeOf(s)
  timers.clear()
})

function build(simConfig, seqOptions) {
  const sim = new LoggedSim(Object.assign({ scanTimeScale: 1, joinMs: 1500, wopt: 1, latencyMs: 5 }, simConfig))
  const seq = new Sequencer(sim, Object.assign({ label: '試験' }, seqOptions))
  const logs = []
  seq.on('log', (l) => logs.push({ at: now, level: l.level, text: l.text }))
  seq.on('error', () => {})
  seq.setCredentials(ID, PW, 'test')
  live.push(seq)
  return { sim, seq, logs }
}

async function running(k) {
  await k.sim.open()
  k.seq.start()
}

async function connected(k) {
  await running(k)
  assert.ok((await until(() => k.seq.state.phase === 'connected', MINUTE)) >= 0, '接続する')
  await advance(5000)
}

/** 待っている最中の SKSENDTO を全部 FAIL ER10 にする（SKJOIN は通るのに送信だけ断られるモジュール）。 */
function refuseSendTo(sim) {
  sim._onSendToData = () => sim._fail('ER10')
}

const lines = (logs, re, levels) => logs.filter((l) => re.test(l.text) && (!levels || levels.includes(l.level)))
const event = (sim, num) => sim._emitLine(`EVENT ${num} ${sim.config.meterIpv6} 0`, 1)

// ---- terminate -----------------------------------------------------------------------------

// 戻すと落ちるもの: terminate の _abortQueue を外す（SKSCAN の続きが流れ、SKTERM のあとに SKJOIN を送ってセッションを張り直す）
test('スキャンの最中に terminate すると、SKTERM のあとに何も送らず、止めた相のまま終わる', async () => {
  const k = build()
  await running(k)
  await until(() => k.seq.state.phase === 'scanning', 30000, 10)
  await advance(500)
  const from = now
  let done = false
  k.seq.terminate().then(() => (done = true))
  await advance(5 * MINUTE)
  assert.deepEqual(k.sim.namesSince(from), ['SKTERM'])
  const s = k.seq.snapshot()
  assert.equal(done, true)
  assert.equal(s.phase, 'overridden')
  assert.equal(s.running, false)
  assert.equal(s.overrides.stopped.reason, 'セッションを終了')
  assert.equal(k.sim.state.joined, false)
  // セッションが無いので ER10 が返るだけ。ふつうの操作に error を残さない
  assert.equal(s.lastError, null)
  assert.equal(lines(k.logs, /./, ['error']).length, 0, lines(k.logs, /./, ['error']).map((l) => l.text).join(' | '))
})

// 戻すと落ちるもの: terminate の _abortQueue を外す（SKRESET のあとの設定の続きが流れる）
test('SKRESET のあとの設定の最中に terminate しても、続きの設定を送らない', async () => {
  const k = build()
  await running(k)
  await until(() => k.sim.log.some((c) => c.name === 'SKRESET'), 30000, 10)
  await advance(3200) // 待ちが明けて、設定のコマンドを送っている最中
  const from = now
  k.seq.terminate()
  await advance(5 * MINUTE)
  assert.deepEqual(k.sim.namesSince(from), ['SKTERM'])
  assert.equal(k.seq.snapshot().phase, 'overridden')
})

for (const joinMs of [1500, 16000, 30000]) {
  // 戻すと落ちるもの: terminate の SKTERM の timeout を 15 秒に戻す（16 秒より長い SKJOIN の最中だと SKTERM が 1 度も出ず、セッションが残る）
  test(`SKJOIN の最中に terminate すると、EVENT 25 のあとで SKTERM を送り、セッションを残さない（${joinMs / 1000} 秒の SKJOIN）`, async () => {
    const k = build({ joinMs })
    await running(k)
    await until(() => k.sim.log.some((c) => c.name === 'SKJOIN'), 2 * MINUTE, 10)
    await advance(200)
    const from = now
    let done = false
    k.seq.terminate().then(() => (done = true))
    await advance(3 * MINUTE)
    assert.equal(done, true)
    assert.deepEqual(k.sim.namesSince(from), ['SKTERM'])
    assert.equal(k.sim.state.joined, false, 'メーターにセッションを残さない')
    assert.equal(k.seq.snapshot().phase, 'overridden')
    assert.equal(k.seq._panaSession, false)
  })
}

// 戻すと落ちるもの: terminate の _wakeUp を外す（_runLoop が待ちの中に残り、そのあとの start が待ちが明けるまで効かない）
test('terminate は再試行の待ちを起こす。そのあとの start は待ちの残りを待たない', async () => {
  const k = build({}, { retryBaseMs: 5 * MINUTE, maxRetryDelayMs: 5 * MINUTE, sendMaxTries: 1 })
  await connected(k)
  refuseSendTo(k.sim)
  await k.seq.reconnect('試験', 1)
  assert.ok((await until(() => k.seq._waitingFor === '再試行の待ち', MINUTE, 10)) >= 0, '前提: 待ちに入る')
  k.seq.terminate()
  await advance(3000)
  assert.equal(k.seq._loopActive, false, '手順を畳んだ')
  k.sim._onSendToData = SimulatorTransport.prototype._onSendToData.bind(k.sim)
  const from = now
  k.seq.start()
  await advance(2000)
  assert.ok(k.sim.namesSince(from).length > 0, '待ちの残りを待たずに動き出す')
})

// 戻すと落ちるもの: start の _wakeUp を外す
test('start は残っている待ちを起こす', async () => {
  const k = build()
  await k.sim.open()
  await advance(10) // ポートが開いた知らせも待ちを起こすので、先に済ませる
  let woken = false
  k.seq._sleep(HOUR, '再試行の待ち').then(() => (woken = true))
  k.seq.start()
  await advance(10)
  assert.equal(woken, true)
})

// 戻すと落ちるもの: terminate の portOpen の確かめを外す（SKTERM が待ち行列に残り、Promise が返らない。ポートが開くと止めた台へ SKTERM が出る）
test('ポートが閉じていても terminate は終わり、SKTERM を残さない', async () => {
  const k = build({ fail: { open: BIG } })
  k.seq.start()
  await until(() => k.seq._waitingFor === '再試行の待ち', MINUTE, 10)
  let done = false
  k.seq.terminate().then(() => (done = true))
  await advance(100)
  assert.equal(done, true)
  assert.equal(k.seq.queueLength(), 0)
  assert.equal(k.seq.snapshot().phase, 'overridden')
  assert.equal(lines(k.logs, /外部の指示でセッションを終了しました/).length, 0, '終了していないので、終了したと書かない')
  assert.equal(lines(k.logs, /SKTERM を送らずに止めました/, ['warn']).length, 1)
  k.sim.config.fail.open = 0
  const from = now
  await k.sim.open()
  await advance(5000)
  assert.deepEqual(k.sim.namesSince(from), [], '止めたままで、何も送らない')
  assert.equal(k.seq.snapshot().phase, 'overridden')
})

// 戻すと落ちるもの: _runLoop の _ensurePortOpen のあとの _assertAlive を外す（止めたあとに初期化が流れて、止めた相を上書きする）
test('ポートを開いている途中で止めたら、開いたあとで手順へ進まない', async () => {
  const k = build()
  const open = k.sim.open.bind(k.sim)
  k.sim.open = () => new Promise((resolve) => setTimeout(() => open().then(resolve), 5000))
  k.seq.start()
  await advance(1000)
  await k.seq.stop('点検中', { external: true })
  await advance(30000)
  assert.deepEqual(k.sim.namesSince(0), [])
  assert.equal(k.seq.snapshot().phase, 'overridden')
  assert.equal(k.seq.snapshot().portOpen, true)
})

// 戻すと落ちるもの: terminate の最後で _setPhase('overridden') を呼ぶ形に戻す（SKTERM の待ちの間に start すると、運転中の相を上書きする）
test('terminate の SKTERM を待っている間に start しても、終わったあとで止めた相へ戻さない', async () => {
  const k = build({ joinMs: 8000 })
  await running(k)
  await until(() => k.sim.log.some((c) => c.name === 'SKJOIN'), 2 * MINUTE, 10)
  await advance(200)
  k.seq.terminate()
  await advance(500)
  k.seq.start()
  assert.ok((await until(() => k.seq.state.phase === 'connected', 2 * MINUTE)) >= 0, 'つながる')
  await advance(30000)
  assert.equal(k.seq.snapshot().phase, 'connected')
  assert.equal(k.seq.snapshot().overrides.stopped, null)
})

// ---- 連続失敗の知らせ ------------------------------------------------------------------------

/** 連続失敗が 3 回に届いた時刻と、そのときの状態を見張る。 */
function watchThird(seq) {
  const hit = { at: null, status: null }
  seq.on('status', (s) => {
    if (hit.at === null && s.consecutiveFailures >= 3) {
      hit.at = now
      hit.status = s
    }
  })
  return hit
}

// 戻すと落ちるもの: _joinKnownMeter のバーストの終わりの consecutiveFailures++ を外す（粘りの窓を 3 つ使い切る 1 時間半まで届かない）
test('認証が通らないときは、約 5〜7 分で連続失敗が 3 回に届き、理由も残る', async () => {
  const k = build({ joinMs: 38000, fail: { join: BIG } })
  const third = watchThird(k.seq)
  const from = now
  await running(k)
  await advance(10 * MINUTE)
  assert.ok(third.at !== null, '10 分以内に届く')
  const took = third.at - from
  assert.ok(took >= 5 * MINUTE && took <= 8 * MINUTE, `${took / 1000} 秒`)
  assert.match(third.status.lastError.message, /メーターとの認証が \d+ 回続けて通りません: EVENT 24/)
})

// 戻すと落ちるもの: バーストの終わりの _recordError を外す（応答待ちの失敗は _fail を通らないので、30 分は lastError が null のまま）
test('認証は通るのに応答が無いときも、約 5〜7 分で届く。理由は最初の巡の終わりから出る', async () => {
  const k = build({ fail: { noEchonetResponse: BIG } })
  const third = watchThird(k.seq)
  const from = now
  await running(k)
  assert.ok((await until(() => k.seq.state.join.burst > 1 || k.seq.state.consecutiveFailures > 0, 5 * MINUTE)) >= 0)
  await advance(MINUTE)
  assert.match(k.seq.snapshot().lastError.message, /メーターとの認証は通りますが、メーターの応答がありません（ECHONET 応答のタイムアウト）/)
  await advance(10 * MINUTE)
  assert.ok(third.at !== null, '10 分以内に届く')
  const took = third.at - from
  assert.ok(took >= 4 * MINUTE && took <= 8 * MINUTE, `${took / 1000} 秒`)
})

test('接続のあとで応答だけ止まっても、止まってから約 7 分で届く', async () => {
  const k = build()
  await connected(k)
  await advance(10 * MINUTE)
  const third = watchThird(k.seq)
  k.sim.config.fail.noEchonetResponse = BIG
  const from = now
  await advance(12 * MINUTE)
  assert.ok(third.at !== null, '12 分以内に届く')
  const took = third.at - from
  assert.ok(took >= 5 * MINUTE && took <= 9 * MINUTE, `${took / 1000} 秒`)
})

test('混雑（EVENT 21 <PARAM>=01）が続いても、約 3 分で届く', async () => {
  const k = build({ fail: { sendto: BIG } })
  const third = watchThird(k.seq)
  const from = now
  await running(k)
  await advance(6 * MINUTE)
  assert.ok(third.at !== null)
  assert.ok(third.at - from <= 5 * MINUTE, `${(third.at - from) / 1000} 秒`)
})

// 戻すと落ちるもの: _runLoop の err.stage の条件を外す（粘りの窓の終わりで同じバーストを 2 回数える）
test('粘りの窓の終わりで、同じバーストを 2 回数えない', async () => {
  const k = build({ fail: { join: BIG } }, { joinPersistMs: 3 * MINUTE })
  await running(k)
  await advance(8 * MINUTE)
  assert.ok(k.seq.snapshot().counters.targetedScans >= 1, '前提: 窓を使い切ってスキャンへ進んだ')
  const bursts = Math.floor(k.sim.log.filter((c) => c.name === 'SKJOIN').length / 3)
  assert.equal(k.seq.snapshot().consecutiveFailures, bursts)
})

// ---- モジュールの設定が消えたとき -----------------------------------------------------------

// 戻すと落ちるもの: _fullSequence の SKRESET の直後で _needReset を下ろす形に戻す（設定が入る前の reconnect で SKJOIN を 30 分粘る）
test('初期化の途中で段を指定して再接続しても、最初からやり直して数秒でつながる', async () => {
  const k = build()
  await connected(k)
  await k.seq.reconnect('試験', 3)
  await until(() => k.seq.state.phase === 'scanning', 30000, 10)
  const from = now
  await k.seq.reconnect('もう一度', 0)
  const took = await until(() => k.seq.state.phase === 'connected', 10 * MINUTE, 100)
  assert.ok(took >= 0 && took < MINUTE, `${took / 1000} 秒`)
  const names = k.sim.namesSince(from)
  assert.ok(names.indexOf('SKRESET') >= 0 && names.indexOf('SKRESET') < names.indexOf('SKJOIN'), '設定の入っていないモジュールへ SKJOIN を撃たない: ' + names.join(' '))
  assert.equal(k.seq.snapshot().lastError, null)
})

// 戻すと落ちるもの: _joinKnownMeter の ER10 の分岐を外す（同じアドレスへ 30 分粘る）・シミュレーターの S3 の FAIL ER10 を外す
test('USB はつながったままモジュールの設定だけが消えても、SKJOIN の FAIL ER10 で気づいて 1 分以内に戻る', async () => {
  const k = build()
  await connected(k)
  await advance(MINUTE)
  Object.assign(k.sim.state, { joined: false, pskSet: false, rbidSet: false, s2: 0x21, s3: 'FFFF', pairing: null, echo: true, rssiInErxudp: false })
  const from = now
  await until(() => k.seq.state.phase !== 'connected', 2 * MINUTE, 100)
  const took = await until(() => k.seq.state.phase === 'connected' && k.seq.state.connected, 40 * MINUTE, 500)
  assert.ok(took >= 0 && now - from < MINUTE, `${(now - from) / 1000} 秒`)
  assert.ok(k.sim.namesSince(from).includes('SKRESET'), '最初からやり直している')
})

// 戻すと落ちるもの: _dispatch の epandesc の確かめを外す（SKLL64 null が ER06 で落ち、別のメーターと見なして学んだことを消す）
test('途中で切れたスキャンの結果は使わない', async () => {
  const k = build()
  await connected(k)
  const addr = k.seq.state.meter.addr
  const coefficient = k.seq.state.calibration.coefficient
  assert.ok(coefficient !== null, '前提: 係数を取れている')
  k.seq._scanResults = []
  k.seq._dispatch({ kind: 'epandesc', channel: 59, channelHex: '3B', panId: '1234', addr: null, lqi: 98, pairId: ID.slice(-8) })
  assert.deepEqual(k.seq._scanResults, [])
  assert.equal(lines(k.logs, /スキャンの結果が途中で切れていた/, ['warn']).length, 1)
  assert.equal(k.seq.state.meter.addr, addr)
  assert.equal(k.seq.state.calibration.coefficient, coefficient)
})

test('シミュレーターの SKJOIN: S3 が無ければ FAIL ER10、別の契約の S3 なら EVENT 24 のまま', async () => {
  const sim = new LoggedSim({ latencyMs: 1, joinMs: 10 })
  const received = []
  sim.on('line', (b) => received.push(b.toString('latin1').trim()))
  await sim.open()
  sim.state.echo = false
  await sim.write(Buffer.from('SKJOIN ' + sim.config.meterIpv6 + '\r'))
  await advance(100)
  assert.deepEqual(received, ['FAIL ER10'], 'S3 が無い')
  received.length = 0
  sim.state.s3 = 'AAAA'
  await sim.write(Buffer.from('SKJOIN ' + sim.config.meterIpv6 + '\r'))
  await advance(100)
  assert.equal(received[0], 'OK')
  assert.match(received[1], /^EVENT 24 /, '別の契約のメーターは認証で落ちる')
  await sim.close()
})

// ---- セッションが無いとき -------------------------------------------------------------------

// 戻すと落ちるもの: _runLoop の段 0 の条件から _panaSession を外す（SKREJOIN が ER10 で終わり、error と lastError が残る）
test('terminate のあとの自動運転は SKJOIN から始まり、失敗に数えない', async () => {
  const k = build()
  await connected(k)
  k.seq.terminate()
  await advance(3000)
  const before = k.seq.snapshot().counters.failures
  const from = now
  k.seq.resetOverrides('試験')
  const took = await until(() => k.seq.state.phase === 'connected', 2 * MINUTE, 100)
  assert.ok(took >= 0 && took < 10000, `${took / 1000} 秒`)
  assert.equal(k.sim.namesSince(from)[0], 'SKJOIN')
  assert.equal(k.seq.snapshot().counters.failures, before)
  assert.equal(k.seq.snapshot().lastError, null)
})

// 戻すと落ちるもの: _matchCurrent の panaPending の下ろしを外す（EVENT 24/25 が来ないので、次の SKJOIN が見切りの 60 秒まで待たされる）
test('SKREJOIN が FAIL で終わったら、次の SKJOIN を保留しない', async () => {
  const k = build()
  await connected(k)
  k.sim.hook = (name, sim) => {
    if (name !== 'SKREJOIN') return false
    sim._fail('ER10')
    return true
  }
  const from = now
  await k.seq.reconnect('試験', 0)
  await until(() => k.sim.namesSince(from).includes('SKREJOIN'), 10000, 10)
  await advance(50)
  assert.equal(k.seq.state.panaPending, null)
  const took = await until(() => k.sim.namesSince(from).includes('SKJOIN'), 2 * MINUTE, 100)
  assert.ok(took >= 0 && took < 20000, `${took / 1000} 秒`)
  assert.equal(lines(k.logs, /を保留します/).length, 0)
})

// ---- 送信時間の見張り -----------------------------------------------------------------------

// 戻すと落ちるもの: _guardTxBudget の SKSREG SFD から optional を外す（失敗に数え、lastError が ER06 に置き換わる）
test('SFD を読めないファームでも、直近のエラーは接続の失敗のまま', async () => {
  const k = build({ fail: { sreg: ['SFD'] } })
  refuseSendTo(k.sim)
  const reasons = new Set()
  k.seq.on('status', (s) => {
    if (s.consecutiveFailures >= 3 && s.lastError) reasons.add(s.lastError.code)
  })
  await running(k)
  await advance(10 * MINUTE)
  assert.ok(k.sim.log.some((c) => /^SKSREG SFD/.test(c.line)), '前提: SFD を読みに行っている')
  assert.deepEqual([...reasons], ['ER10'])
  assert.equal(lines(k.logs, /SFD/, ['warn', 'error']).length, 0)
})

// 戻すと落ちるもの: _afterHandledFailure の待ちのあとの確かめを外す（止めたあとに SFD を読み、積算が多いと 10 分寝て start が効かない）
test('再試行の待ちの最中に止めたら SFD を読みに行かず、start はすぐ効く', async () => {
  const k = build({ txTotalMs: 260000 })
  await k.sim.open()
  refuseSendTo(k.sim)
  k.seq.start()
  assert.ok((await until(() => k.seq._waitingFor === '再試行の待ち', 2 * MINUTE)) >= 0)
  await k.seq.stop('一度止める', { external: true })
  await advance(500)
  assert.equal(k.sim.log.filter((c) => /^SKSREG SFD/.test(c.line)).length, 0)
  assert.equal(k.seq._waitingFor, null)
  assert.equal(k.seq._loopActive, false)
  k.sim._onSendToData = SimulatorTransport.prototype._onSendToData.bind(k.sim)
  const from = now
  k.seq.start()
  await advance(2000)
  assert.ok(k.sim.namesSince(from).length > 0)
})

test('再試行の待ちの最中にポートが閉じたら、SFD を待ち行列に残さない', async () => {
  const k = build({ txTotalMs: 260000 })
  await k.sim.open()
  refuseSendTo(k.sim)
  k.seq.start()
  assert.ok((await until(() => k.seq._waitingFor === '再試行の待ち', 2 * MINUTE)) >= 0)
  k.sim.config.fail.open = BIG
  k.sim.state.openFailures = 0
  await k.sim.close()
  await advance(30000)
  assert.equal(k.seq.queueLength(), 0)
})

// ---- 止めている間 ---------------------------------------------------------------------------

// 戻すと落ちるもの: case 0x29 の !_running の分岐を外す（phase が reauth → verifying へ動く）
test('止めている間の EVENT 29・EVENT 25 で相を動かさない', async () => {
  const k = build()
  await connected(k)
  await k.seq.stop('点検中', { external: true })
  event(k.sim, '29')
  await advance(100)
  assert.equal(k.seq.snapshot().phase, 'overridden')
  event(k.sim, '25')
  await advance(MINUTE)
  const s = k.seq.snapshot()
  assert.equal(s.phase, 'overridden')
  assert.equal(s.running, false)
  assert.equal(s.overrides.stopped.reason, '点検中')
  assert.equal(k.seq.state.panaPending, null, 'EVENT 25 で下りる')
})

// 戻すと落ちるもの: case 0x29 の panaPending の印を外す（止めている間の再認証の最中に電波を出す）
test('止めている間の EVENT 29 のあと、無線のコマンドを保留する。返らなくても 60 秒で明ける', async () => {
  const k = build()
  await connected(k)
  await k.seq.stop('点検中', { external: true })
  event(k.sim, '29')
  await advance(100)
  const from = now
  let result = null
  const ping = () =>
    k.seq.raw('SKPING ' + k.sim.config.meterIpv6).then(
      () => (result = 'ok'),
      (e) => (result = e.code)
    )
  ping()
  await advance(30000)
  assert.deepEqual(k.sim.namesSince(from), [], '禁止期間に送らない')
  assert.equal(result, 'RADIO_BLOCKED', '呼び手は自分の待ち時間で理由を受け取る')
  await advance(40000)
  ping()
  await advance(1000)
  assert.deepEqual(k.sim.namesSince(from), ['SKPING'], '見切りのあとは送る')
  assert.equal(result, 'ok')
})

// 戻すと落ちるもの: stop の _markReauthBlock を外す（相が reauth から動くと、再認証の最中に電波を出す）
test('自動再認証の途中で止めても、無線のコマンドを保留する', async () => {
  const k = build()
  await connected(k)
  event(k.sim, '29')
  await advance(100)
  assert.equal(k.seq.state.phase, 'reauth')
  await k.seq.stop('点検中', { external: true })
  const from = now
  k.seq.raw('SKPING ' + k.sim.config.meterIpv6).catch(() => {})
  await advance(3000)
  assert.deepEqual(k.sim.namesSince(from), [])
  event(k.sim, '25')
  await advance(1000)
  assert.deepEqual(k.sim.namesSince(from), ['SKPING'], 'EVENT 25 で明ける')
})

// 戻すと落ちるもの: terminate の _markReauthBlock を外す（再認証の最中に SKTERM を送る）
test('自動再認証の途中で terminate すると、EVENT 24/25 が返ってから SKTERM を送る', async () => {
  const k = build()
  await connected(k)
  event(k.sim, '29')
  await advance(100)
  const from = now
  let done = false
  k.seq.terminate().then(() => (done = true))
  await advance(20000)
  assert.deepEqual(k.sim.namesSince(from), [])
  event(k.sim, '25')
  await advance(5000)
  assert.deepEqual(k.sim.namesSince(from), ['SKTERM'])
  assert.equal(done, true)
  assert.equal(k.sim.state.joined, false)
})

// 戻すと落ちるもの: _onPortOpen の port-down の戻しを外す（開いているのに「ポート切断」のまま）
test('止めている間に抜いて差しても、止めた相へ戻る', async () => {
  const k = build()
  await connected(k)
  await k.seq.stop('点検中', { external: true })
  await k.sim.close()
  assert.equal(k.seq.snapshot().phase, 'port-down')
  await k.sim.open()
  await advance(100)
  const s = k.seq.snapshot()
  assert.equal(s.phase, 'overridden')
  assert.equal(s.portOpen, true)
})

// ---- 閉じるとき -----------------------------------------------------------------------------

// 戻すと落ちるもの: destroy の race の結果を見ない（SKTERM が保留のままでも「終了してから閉じます」と記録する）
test('閉じる前に SKTERM が終わらなかったら、終了したと記録しない', async () => {
  const k = build()
  await connected(k)
  event(k.sim, '32')
  await advance(100)
  let done = false
  k.seq.destroy().then(() => (done = true))
  await until(() => done, 20000, 20)
  assert.equal(done, true)
  assert.equal(k.seq._panaSession, true, '前提: セッションは残っている')
  assert.equal(lines(k.logs, /メーターとのセッションを終了してから閉じます/).length, 0)
  assert.equal(lines(k.logs, /閉じる前に SKTERM を完了できませんでした/, ['warn']).length, 1)
})

// 戻すと落ちるもの: destroy の transport.close の上限を外す（close が返らないと destroy がいつまでも終わらない）
test('transport.close が返らなくても、destroy は 3 秒で終わる。終わったあとにタイマーを残さない', async () => {
  const k = build()
  await connected(k)
  await k.seq.stop('試験')
  k.sim.close = () => new Promise(() => {})
  k.seq._panaSession = false
  k.seq.state.connected = false
  const sent = []
  k.seq.on('log', (l) => sent.push(l.text))
  let done = false
  k.seq.destroy().then(() => (done = true))
  await advance(3100)
  assert.equal(done, true)
  assert.ok(sent.some((t) => /シリアルポートが 3 秒たっても閉じない/.test(t)), sent.join(' | '))
  k.sim.close = SimulatorTransport.prototype.close.bind(k.sim)
  await k.sim.close()
})

test('閉じるときの上限のタイマーを残さない。destroy は 2 回呼んでも落ちない', async () => {
  const k = build()
  await connected(k)
  await closeOf(k.seq)
  await advance(1100) // 接続が切れるのを見ている 1 秒ごとの確かめは、次の回で終わる
  assert.deepEqual([...timers.values()].map((t) => t.at - now), [])
  await closeOf(k.seq)
})

// ---- ログの量 -------------------------------------------------------------------------------

// 戻すと落ちるもの: hinted を _joinKnownMeter の局所に戻す（窓ごとに出る）・_fail の quiet を外す（失敗 1 回が error を含む 3 行になる）
test('認証が通らないときの案内の error は 1 度だけ。SKJOIN の失敗 1 回は warn 1 行にまとめ、数え方は変えない', async () => {
  const k = build({ joinMs: 38000, fail: { join: BIG } })
  await running(k)
  await advance(2 * HOUR)
  const hint = lines(k.logs, /認証 ID かパスワードが誤っている可能性/, ['error'])
  assert.equal(hint.length, 1)
  const joins = k.sim.log.filter((c) => c.name === 'SKJOIN').length
  assert.ok(joins >= 30, '前提: 粘りの窓をまたいでいる ' + joins)
  assert.ok(k.seq.state.join.windows >= 1 || k.seq.state.ladder >= 2, '前提: 窓を使い切っている')
  assert.equal(lines(k.logs, /失敗: SKJOIN/).length, 0, 'error の行にしない')
  assert.equal(lines(k.logs, /^EVENT 24/).length, 0, 'EVENT 24 の行と 2 重にしない')
  const failed = lines(k.logs, /メーターとの認証が通りませんでした/, ['warn'])
  assert.ok(Math.abs(failed.length - joins) <= 1, `失敗 ${joins} 回に warn ${failed.length} 行`)
  assert.match(failed[0].text, /（1 巡目 1\/3・38\.0 秒）: EVENT 24（PANA 接続エラー） 相手=FE80:/)
  assert.ok(k.seq.snapshot().counters.failures >= joins - 1, '失敗の数は数え続ける')
})

// 戻すと落ちるもの: setCredentials で _credentialHinted を下ろさない
test('認証情報を入れ直したら、案内はもう一度出る', async () => {
  const k = build({ fail: { join: BIG } }, { credentialHintAfterMs: 2 * MINUTE })
  await running(k)
  await advance(5 * MINUTE)
  assert.equal(lines(k.logs, /認証 ID かパスワードが誤っている可能性/).length, 1)
  k.seq.setCredentials(ID, PW, 'test')
  await advance(5 * MINUTE)
  assert.equal(lines(k.logs, /認証 ID かパスワードが誤っている可能性/).length, 1, '同じ値なら出し直さない')
  k.seq.setCredentials(ID, 'FEDCBA654321', 'test')
  await advance(5 * MINUTE)
  assert.equal(lines(k.logs, /認証 ID かパスワードが誤っている可能性/).length, 2)
})

// 戻すと落ちるもの: EVENT 25 で _credentialHinted を下ろさない
test('認証が 1 度通ったあとにまた通らなくなったら、案内はもう一度出る', async () => {
  const k = build({ fail: { join: BIG } }, { credentialHintAfterMs: 2 * MINUTE })
  await running(k)
  await advance(5 * MINUTE)
  assert.equal(lines(k.logs, /認証 ID かパスワードが誤っている可能性/).length, 1)
  k.sim.config.fail.join = 0
  assert.ok((await until(() => k.seq.state.phase === 'connected', 10 * MINUTE)) >= 0, 'つながる')
  k.sim.config.fail.join = BIG
  k.sim.state.joinFailures = 0
  // 通ったあとの失敗は、最後の結果が EVENT 25 の間は認証情報の案内を出さない。新しい EVENT 24 で判定し直す
  await k.seq.reconnect('試験', 1)
  await advance(5 * MINUTE)
  assert.equal(lines(k.logs, /認証 ID かパスワードが誤っている可能性/).length, 2)
})

// ---- 「生きている」と「値が来た」 ------------------------------------------------------------

/** 本物の view-model で健康の判定を取る（phaseSince は registry と同じく state の値）。 */
function summaryOf(seq) {
  return vm.buildSummary(
    {
      id: 'a',
      meta: { name: '試験', enabled: true, mode: 'simulator', port: 'sim' },
      snap: seq.snapshot(),
      phaseSince: seq.state.phaseSince,
      consumers: 1,
      options: { pollIntervalSec: seq.options.pollIntervalSec },
    },
    now
  )
}

/** Get の最初の EPC（0x80 なら接続の確認）。 */
const firstEpc = (data) => Buffer.from(data)[12]

/** 接続の確認（0x80）にだけ答え、ほかの Get は送信が通るだけで応答しないメーター。 */
function answerOnlyVerify(sim) {
  const orig = sim._onSendToData.bind(sim)
  sim._onSendToData = (ctx, data) => {
    if (firstEpc(data) === 0x80) return orig(ctx, data)
    sim._ok()
    sim._emitLine(`EVENT 21 ${sim.config.meterIpv6} 0 00`, 50)
  }
}

/** メーターから ECHONET の電文を 1 通届ける。 */
function erxudp(sim, frame, delayMs) {
  const len = frame.length.toString(16).toUpperCase().padStart(4, '0')
  sim._emitLine(`ERXUDP ${sim.config.meterIpv6} ${sim.config.ipv6} 0E1A 0E1A ${sim.config.meterAddr} 1 0 ${len} ${frame.toString('hex').toUpperCase()}`, delayMs)
}

/** 接続の確認（0x80）にだけ答え、ほかの Get は全部 Get_SNA（PDC=0）で断るメーター。 */
function denyAllButVerify(sim) {
  const orig = sim._onSendToData.bind(sim)
  sim._onSendToData = (ctx, data) => {
    if (firstEpc(data) === 0x80) return orig(ctx, data)
    const b = Buffer.from(data)
    const opc = b[11]
    const parts = [Buffer.from([0x10, 0x81]), b.slice(2, 4), Buffer.from([0x02, 0x88, 0x01, 0x05, 0xff, 0x01, 0x52, opc])]
    for (let i = 0, p = 12; i < opc; i++, p += 2 + b[p + 1]) parts.push(Buffer.from([b[p], 0]))
    sim._ok()
    sim._emitLine(`EVENT 21 ${sim.config.meterIpv6} 0 00`, 50)
    erxudp(sim, Buffer.concat(parts), 80)
  }
}

/** メーターの応答を元に戻す。 */
function restoreMeter(sim) {
  sim._onSendToData = SimulatorTransport.prototype._onSendToData.bind(sim)
}

// 戻すと落ちるもの: _poll の再接続の前の consecutiveFailures++ を外す（連続失敗が増えない）・
//                   _runLoop で接続のたびに連続失敗を 0 に戻す（3 回に届かない）・
//                   _recordError を外す（alert と画面に理由が出ない）
test('定期の取得に応答が無いまま繋ぎ直しを繰り返すと、連続失敗が増えて alert の条件に届き、健康の判定は異常になる', async () => {
  const k = build()
  await connected(k)
  await advance(10 * MINUTE)
  answerOnlyVerify(k.sim)
  const lastValue = k.seq.state.lastValueAt
  const hit = { at: null, status: null }
  // wsuha-broute の alert の条件（接続済みの間は鳴らない）
  k.seq.on('status', (s) => {
    if (hit.at === null && s.phase !== 'connected' && s.consecutiveFailures >= 3) {
      hit.at = now
      hit.status = s
    }
  })
  const from = now
  await advance(8 * MINUTE)
  assert.ok(hit.at !== null, '8 分以内に届く')
  assert.ok(hit.at - from <= 6 * MINUTE, `${(hit.at - from) / 1000} 秒`)
  assert.match(hit.status.lastError.message, /定期的に取りに行く値が 3 回続けて届きません（ECHONET 応答のタイムアウト）/)
  assert.ok(k.seq.snapshot().counters.joins >= 4, '前提: 接続の確認は通り続けている')
  assert.equal(k.seq.state.lastValueAt, lastValue, '接続の確認の応答で進めない')

  const waitFrom = k.seq.state.valueWaitSince
  assert.ok(waitFrom !== null && waitFrom >= lastValue, '猶予の起点を持つ（つながったまま値が止まった台は最後の値の時刻）')
  for (let i = 0; i < 12; i++) {
    await advance(10000)
    const s = summaryOf(k.seq)
    assert.equal(s.health.level, 'bad', `${s.health.level} ${s.health.title}`)
    assert.match(s.health.title, /接続に \d+ 回続けて失敗しています/)
    // 繋ぎ直すたびに猶予の起点を延ばさない（延ばすと古い瞬時電力が全台の合計に入り続ける）
    assert.equal(k.seq.state.valueWaitSince, waitFrom)
    if (s.phase === 'connected') assert.equal(s.stale, true, '値が来ないまま繋ぎ直した間も古いとみなす')
  }

  // 戻ったら、最初の定期の値で数え直す
  restoreMeter(k.sim)
  assert.ok((await until(() => k.seq.state.consecutiveFailures === 0, 3 * MINUTE, 100)) >= 0, '定期の値で 0 に戻る')
  assert.ok(k.seq.state.lastValueAt > lastValue)
  await advance(1000)
  assert.equal(summaryOf(k.seq).health.level, 'ok')
})

// 戻すと落ちるもの: _poll の catch の err.handled の数えを外す（接続の確認は通るのに定期の取得だけ送れない状態で増えない）
test('定期の取得だけ送れず繋ぎ直しを繰り返すときも、連続失敗に数える', async () => {
  const k = build({}, { collectAll: false, sendMaxTries: 1 })
  await connected(k)
  const orig = k.sim._onSendToData.bind(k.sim)
  k.sim._onSendToData = (ctx, data) => (firstEpc(data) === 0x80 ? orig(ctx, data) : k.sim._fail('ER10'))
  await advance(5 * MINUTE)
  assert.ok(k.seq.snapshot().consecutiveFailures >= 3, String(k.seq.snapshot().consecutiveFailures))
})

// 戻すと落ちるもの: _onErxudp で待っていた応答ならいつでも lastValueAt を進める（Get_SNA でも進み、計測中のまま）
test('定期の取得が全部 Get_SNA なら値が古いと出す。応答はあるので繋ぎ直さず、控えは続き、戻れば消える', async () => {
  const k = build()
  await connected(k)
  await advance(MINUTE)
  const reconnects = k.seq.snapshot().counters.reconnects
  const joins = k.seq.snapshot().counters.joins
  denyAllButVerify(k.sim)
  const lastValue = k.seq.state.lastValueAt
  await advance(3 * MINUTE)

  const s = summaryOf(k.seq)
  assert.equal(k.seq.state.lastValueAt, lastValue)
  assert.equal(s.stale, true)
  assert.equal(s.health.level, 'stale')
  assert.match(s.health.title, /値が届いていません（最終 \d+ 分前）/)
  // 控えの動き: E7 は控えているが、全部控えているときは設定どおりに聞き続ける
  const snap = k.seq.snapshot()
  assert.ok(snap.unsupportedEpcs.includes('0xE7'), snap.unsupportedEpcs.join(' '))
  assert.deepEqual(snap.pollEpcs, [0xe7, 0xe8], '定期取得の設定からは外さない')
  assert.equal(k.seq.state.pollMisses, 0, '応答があるので取りこぼしに数えない')
  assert.equal(snap.counters.reconnects, reconnects)
  assert.equal(snap.counters.joins, joins)
  const sent = k.sim.log.filter((c) => c.name === 'SKSENDTO').length
  await advance(2 * MINUTE)
  assert.ok(k.sim.log.filter((c) => c.name === 'SKSENDTO').length > sent, '聞き続ける')

  restoreMeter(k.sim)
  assert.ok((await until(() => k.seq.state.lastValueAt > lastValue, 2 * MINUTE, 100)) >= 0, '値が戻る')
  await advance(1000)
  assert.equal(k.seq.snapshot().snaHold['0xE7'], undefined)
  assert.equal(summaryOf(k.seq).stale, false)
  assert.equal(summaryOf(k.seq).health.level, 'ok')
})

// 戻すと落ちるもの: _isMainValue で瞬時電力（E7）を特別に見ない（瞬時電流や 5 分ごとの値で「値が来た」と見る）
test('瞬時電力を取っていて瞬時電力だけ断られると、瞬時電流や 5 分ごとの値が届いても値が来たと見ない', async () => {
  const k = build({ fail: { sna: { E7: BIG } } }, { pollEpcs: [0xe7, 0xe8] })
  await running(k)
  const held = () => k.seq.snapshot().unsupportedEpcs.includes('0xE7')
  assert.ok((await until(held, MINUTE, 10)) >= 0, '前提: E7 は断られた')
  await advance(6 * MINUTE)
  assert.ok(k.seq.state.values['0xE8'], '前提: 瞬時電流は届いている')
  assert.equal(k.seq.state.lastValueAt, null, '瞬時電力が来ていないので進めない')
  const waitFrom = k.seq.state.valueWaitSince
  assert.ok(waitFrom !== null, '最初につながった時刻を持ち続ける')
  const s = summaryOf(k.seq)
  assert.equal(s.stale, true)
  assert.equal(s.health.level, 'stale')
  assert.match(s.health.nextAction, /メーターがこの値を返していません/)

  // つなぎ直しても猶予の起点を延ばさない（延ばすと、つなぎ直すたびに「計測中」に戻る）
  const t0 = now
  await k.seq.reconnect('試験', 1)
  const back = () => k.seq.state.connected && k.seq.state.phase === 'connected' && k.seq.state.phaseSince > t0
  assert.ok((await until(back, 5 * MINUTE, 100)) >= 0, 'つながり直す')
  assert.equal(k.seq.state.valueWaitSince, waitFrom)
  assert.equal(summaryOf(k.seq).stale, true, 'つながり直した直後も古いとみなす')
})

// 戻すと落ちるもの: _markDown で、つながったまま主な値が止まっていた台の起点を残さない（再接続のたびに猶予が付き直す）
test('つながったまま瞬時電力が止まった台は、つなぎ直しても猶予を付け直さない', async () => {
  const k = build({}, { pollEpcs: [0xe7, 0xe8] })
  await connected(k)
  await advance(2 * MINUTE)
  assert.ok(k.seq.state.lastValueAt !== null, '前提: 瞬時電力は届いていた')
  assert.equal(k.seq.state.valueWaitSince, null)
  // ここから瞬時電力だけ断られ続ける（瞬時電流は届く）
  k.sim.config.fail.sna = { E7: BIG }
  await advance(10 * MINUTE)
  const last = k.seq.state.lastValueAt
  assert.equal(summaryOf(k.seq).stale, true, '前提: 古いとみなしている')
  const t0 = now
  await k.seq.reconnect('試験', 1)
  const back = () => k.seq.state.connected && k.seq.state.phase === 'connected' && k.seq.state.phaseSince > t0
  assert.ok((await until(back, 5 * MINUTE, 100)) >= 0, 'つながり直す')
  assert.equal(k.seq.state.valueWaitSince, last, '最後の瞬時電力の時刻を起点に残す')
  assert.equal(summaryOf(k.seq).stale, true, 'つながり直した直後も古いとみなす')
})

// 戻すと落ちるもの: _isMainValue が取得間隔の値に瞬時電力が無い台でも瞬時電力だけを見る
test('取得間隔の値に瞬時電力が無い台は、取得間隔の値が届けば値が来たと見る', async () => {
  const k = build({}, { pollEpcs: [0xe8] })
  await running(k)
  assert.ok((await until(() => k.seq.state.lastValueAt !== null, 2 * MINUTE, 100)) >= 0, '瞬時電流で進む')
  assert.equal(k.seq.state.valueWaitSince, null)
  assert.equal(summaryOf(k.seq).stale, false)
})

// 戻すと落ちるもの: _onErxudp で接続の確認の応答でも lastValueAt を進める
test('接続の確認では lastValueAt を進めず、接続の直後を値が古いと言わない', async () => {
  const k = build()
  const seen = []
  k.seq.on('connected', () => seen.push(summaryOf(k.seq)))
  await connected(k)
  assert.equal(seen[0].lastValueAt, null)
  assert.equal(seen[0].stale, false)
  assert.equal(seen[0].health.level, 'ok')

  // 長く切れたあとも、繋がった時点で古いと言わない
  k.sim.config.fail.join = BIG
  k.sim.state.joined = false
  event(k.sim, '26')
  await advance(20 * MINUTE)
  k.sim.config.fail.join = 0
  k.sim.state.joinFailures = 0
  assert.ok((await until(() => seen.length === 2, 10 * MINUTE, 100)) >= 0, 'つながり直す')
  assert.ok(now - seen[1].lastValueAt > 15 * MINUTE, '前提: 最後の値は古い')
  assert.equal(seen[1].stale, false)
  assert.ok((await until(() => k.seq.state.consecutiveFailures === 0, MINUTE, 100)) >= 0, '定期の値で 0 に戻る')
  await advance(1000)
  assert.equal(summaryOf(k.seq).health.level, 'ok')
})

// 戻すと落ちるもの: PERIODIC_PURPOSES に 'once' を追加する（接続のたびに進み、定期の値が来ないのに古いと出ない）
test('接続時の取得では lastValueAt を進めない', async () => {
  const k = build()
  const orig = k.sim._onSendToData.bind(k.sim)
  k.sim._onSendToData = (ctx, data) => {
    if (firstEpc(data) !== 0xe7) return orig(ctx, data)
    k.sim._ok()
    k.sim._emitLine(`EVENT 21 ${k.sim.config.meterIpv6} 0 00`, 50)
  }
  await connected(k)
  await advance(5000)
  assert.notEqual(k.seq.state.calibration.coefficient, null, '前提: 接続時の取得は通っている')
  assert.equal(k.seq.state.lastValueAt, null)
})

// 戻すと落ちるもの: _noteValueArrived の state.connected の確かめを外す（切れている間に届いた遅れた値で数え直す）
test('繋ぎ直しの途中に遅れて届いた定期の値は、値としては数えるが、連続失敗は戻さない', async () => {
  const k = build({ joinMs: 30000 })
  await connected(k)
  await advance(MINUTE)
  const tid = k.seq._tid
  k.seq.state.consecutiveFailures = 2
  await k.seq.reconnect('試験', 1)
  await advance(1000)
  const lastValue = k.seq.state.lastValueAt
  erxudp(k.sim, Buffer.from([0x10, 0x81, tid >> 8, tid & 0xff, 0x02, 0x88, 0x01, 0x05, 0xff, 0x01, 0x72, 0x01, 0xe7, 0x04, 0x00, 0x00, 0x01, 0x00]), 1)
  await advance(100)
  assert.equal(k.seq.state.connected, false, '前提: 繋ぎ直しの途中')
  assert.ok(k.seq.state.lastValueAt > lastValue)
  assert.equal(k.seq.state.consecutiveFailures, 2)
})

// 戻すと落ちるもの: _onErxudp の INF の枝で lastValueAt を進める
test('メーターの自発の通知（INF）では lastValueAt を進めない', async () => {
  const k = build()
  await connected(k)
  await advance(MINUTE)
  denyAllButVerify(k.sim)
  const lastValue = k.seq.state.lastValueAt
  await advance(MINUTE)
  erxudp(k.sim, Buffer.from([0x10, 0x81, 0xff, 0xf0, 0x02, 0x88, 0x01, 0x05, 0xff, 0x01, 0x73, 0x01, 0xe7, 0x04, 0x00, 0x00, 0x01, 0x00]), 1)
  await advance(100)
  assert.equal(k.seq.snapshot().known['0xE7'].value, 256, '前提: 値としては受け取っている')
  assert.equal(k.seq.state.lastValueAt, lastValue)
})

// 戻すと落ちるもの: _afterJoin の数え直しを外す（値を待っても来ないので、連続失敗が残り続ける）
test('定期に取る値が 1 つも無い台は、接続で連続失敗を数え直す', async () => {
  const k = build({ fail: { join: 3 } }, { pollEpcs: [], collectAll: false })
  await running(k)
  assert.ok((await until(() => k.seq.state.consecutiveFailures === 1, 3 * MINUTE)) >= 0, '前提: 1 巡失敗する')
  assert.ok((await until(() => k.seq.state.phase === 'connected', 3 * MINUTE)) >= 0, 'つながる')
  assert.equal(k.seq.snapshot().consecutiveFailures, 0)
})

// 戻すと落ちるもの: _afterJoin の条件を外していつも 0 に戻す（値が来るまで数え続けない）
test('定期に取る値がある台は、接続の時点では数え直さず、最初の定期の値で数え直す', async () => {
  const k = build({ fail: { join: 3 } })
  const atConnect = []
  k.seq.on('connected', (s) => atConnect.push(s.consecutiveFailures))
  await connected(k)
  assert.deepEqual(atConnect, [1])
  assert.equal(k.seq.snapshot().consecutiveFailures, 0)
})

// ---- 再試行の待ちの数 ------------------------------------------------------------------------

/** 接続のあと、認証が通らない状態を ms 続ける。 */
async function authOutage(k, ms) {
  k.sim.config.fail.join = BIG
  k.sim.state.joined = false
  event(k.sim, '26')
  await advance(ms)
  k.sim.config.fail.join = 0
  k.sim.state.joinFailures = 0
}

// 戻すと落ちるもの: _retryDelay と _afterHandledFailure の段上げを、認証の巡も数える連続失敗で決める（5 分待ち）
test('認証が長く通らなかったあとの SKSENDTO の 1 回の ER10 は、短い待ちのまま段も上げずに戻る', async () => {
  const k = build()
  await connected(k)
  await authOutage(k, 20 * MINUTE)
  assert.ok(k.seq.state.consecutiveFailures >= 5, '前提: 連続失敗は認証の巡で増えている')
  const shown = k.seq.state.consecutiveFailures
  const orig = k.sim._onSendToData.bind(k.sim)
  let er10 = 3
  k.sim._onSendToData = (ctx, data) => (er10 > 0 ? (er10--, k.sim._fail('ER10')) : orig(ctx, data))
  const from = now
  const took = await until(() => k.seq.state.phase === 'connected', 10 * MINUTE, 100)
  assert.ok(took >= 0 && took < 2 * MINUTE, `${took / 1000} 秒`)
  const wait = k.logs.filter((l) => l.at >= from && /秒後に段/.test(l.text))
  assert.equal(wait.length, 1)
  assert.match(wait[0].text, /5 秒後に段 1 で再試行します（連続 \d+ 回目/)
  assert.ok(k.seq.snapshot().consecutiveFailures > shown, '見せる数は続けて数える')
})

// 戻すと落ちるもの: 上と同じ（SKJOIN の FAIL ER10 の道）
test('認証が長く通らなかったあとの SKJOIN の FAIL ER10 は、短い待ちで初期化からやり直す', async () => {
  const k = build()
  await connected(k)
  await authOutage(k, 20 * MINUTE)
  let er10 = 1
  k.sim.hook = (name, sim) => {
    if (name !== 'SKJOIN' || er10 < 1) return false
    er10--
    sim._fail('ER10')
    return true
  }
  const from = now
  const took = await until(() => k.seq.state.phase === 'connected', 10 * MINUTE, 100)
  assert.ok(took >= 0 && took < 2 * MINUTE, `${took / 1000} 秒`)
  assert.ok(k.sim.namesSince(from).includes('SKRESET'), '前提: 初期化からやり直した')
  assert.equal(lines(k.logs, /300 秒後に段/).length, 0)
})

// 戻すと落ちるもの: 接続ができたときに待ちの数を戻さない（前の失敗の分だけ、次の障害の待ちが伸びる）
test('待ちの数は接続ができたら戻す', async () => {
  const k = build({}, { sendMaxTries: 1 })
  await connected(k)
  refuseSendTo(k.sim)
  await k.seq.reconnect('試験', 1)
  await advance(2 * MINUTE)
  assert.ok(k.seq._retryFailures >= 2, '前提: 失敗が続いている ' + k.seq._retryFailures)
  restoreMeter(k.sim)
  assert.ok((await until(() => k.seq.state.phase === 'connected', 10 * MINUTE)) >= 0, 'つながる')
  await advance(5000)
  assert.equal(k.seq._retryFailures, 0)
})

// ---- 止めている間の決着 ----------------------------------------------------------------------

// 戻すと落ちるもの: _onSkEvent の止めている間の EVENT 24 の枝を外す（SKREJOIN が ER10 で空振りし、error と lastError が残る）
test('止めている間に自動再認証が失敗したら、次の開始は SKJOIN から。error も lastError も残さない', async () => {
  const k = build()
  await connected(k)
  await k.seq.stop('点検', { external: true })
  event(k.sim, '29')
  await advance(500)
  k.sim.state.joined = false
  event(k.sim, '24')
  await advance(500)
  const from = now
  k.seq.start()
  const took = await until(() => k.seq.state.phase === 'connected', 2 * MINUTE, 100)
  assert.ok(took >= 0 && took < 10000, `${took / 1000} 秒`)
  assert.equal(k.sim.namesSince(from)[0], 'SKJOIN')
  assert.equal(k.seq.snapshot().lastError, null)
  assert.equal(k.seq.snapshot().consecutiveFailures, 0)
  assert.equal(lines(k.logs, /./, ['error']).length, 0)
})

// 戻すと落ちるもの: _runLoop の _terminating の待ちを外す（SKTERM のあとの SKREJOIN が ER10 で空振りする）
test('terminate の SKTERM の決着を待っている間に start しても、SKREJOIN を空振りしない', async () => {
  const k = build()
  await connected(k)
  k.sim.config.joinMs = 10000
  const failures = k.seq.snapshot().counters.failures
  const from = now
  let done = false
  k.seq.terminate().then(() => (done = true))
  await advance(500)
  k.seq.start()
  const took = await until(() => k.seq.state.phase === 'connected', 2 * MINUTE, 100)
  assert.ok(took >= 0, 'つながる')
  assert.equal(done, true)
  assert.deepEqual(k.sim.namesSince(from).slice(0, 2), ['SKTERM', 'SKJOIN'])
  assert.equal(k.seq.snapshot().counters.failures, failures)
  assert.equal(k.seq.snapshot().lastError, null)
})

// 戻すと落ちるもの: terminate の先頭の _terminating の確かめを外す（1 回目の SKTERM を畳み、逆の warn が残る）
test('terminate を続けて 2 回呼んでも、SKTERM は 1 回で、終了できなかったと書かない', async () => {
  const k = build()
  await connected(k)
  const from = now
  const results = []
  k.seq.terminate().then(() => results.push(1))
  await advance(100)
  k.seq.terminate().then(() => results.push(2))
  await advance(30000)
  assert.deepEqual(k.sim.namesSince(from), ['SKTERM'])
  assert.deepEqual(results.sort(), [1, 2])
  assert.equal(lines(k.logs, /メーターとのセッションを終了できませんでした/).length, 0)
  assert.equal(lines(k.logs, /外部の指示でセッションを終了しました/).length, 1)
  assert.equal(k.seq._terminating, null)
})

// 戻すと落ちるもの: 2 回目の確かめから !this._running を外す（start のあとの terminate が効かない）
test('terminate のあと start してからの terminate は効く', async () => {
  const k = build()
  await connected(k)
  k.sim.config.joinMs = 10000
  k.seq.terminate()
  await advance(500)
  k.seq.start()
  await advance(500)
  k.seq.terminate()
  await advance(MINUTE)
  assert.equal(k.seq.isRunning(), false)
  assert.equal(k.seq.snapshot().phase, 'overridden')
  assert.equal(k.sim.state.joined, false)
})

// ---- 送信の制限の間 --------------------------------------------------------------------------

// 戻すと落ちるもの: held の枝を外す（送っていないのに連続失敗が増え、「n 回続けて通りません」と書き、段の案内が出る）
test('送信の制限の間は、送れなかった認証を失敗に数えず、制限を待つ案内のまま。解けたら戻る', async () => {
  const k = build()
  await connected(k)
  k.sim.state.joined = false
  event(k.sim, '26')
  await advance(200)
  k.sim._emitLine(`EVENT 32 ${k.sim.config.ipv6} 0`, 1)
  await advance(5000)
  k.seq.state.join.last = null // 認証が 1 度も通っていない台でも、認証情報を疑わせない
  const from = now
  await advance(50 * MINUTE)

  assert.equal(k.sim.namesSince(from).filter((n) => n === 'SKJOIN').length, 0, '前提: 1 度も送っていない')
  const s = k.seq.snapshot()
  assert.equal(s.consecutiveFailures, 0)
  assert.equal(s.ladder, 1, 'メーターを探しに行かない')
  assert.equal(s.connectHint, null)
  assert.equal(lines(k.logs, /認証 ID かパスワードが誤っている可能性/).length, 0)
  assert.match(s.lastError.message, /メーターへ送信できていません: .*送信総和時間.*制限が解けると自動で再開します/)
  assert.doesNotMatch(s.lastError.message, /続けて通りません/)
  assert.equal(lines(k.logs, /メーターとの認証が通りませんでした/).filter((l) => l.at >= from).length, 0)
  const h = summaryOf(k.seq).health
  assert.equal(h.level, 'busy')
  assert.equal(h.nextAction, NEXT.radio)
  assert.match(hintOf(s.lastError.message), /電波の送信時間の上限/)

  k.sim._emitLine(`EVENT 33 ${k.sim.config.ipv6} 0`, 1)
  const took = await until(() => k.seq.state.phase === 'connected', 5 * MINUTE, 100)
  assert.ok(took >= 0 && took < 3 * MINUTE, `${took / 1000} 秒`)
})

// 戻すと落ちるもの: failedBursts ではなく巡の番号で回数を書く（制限の間の巡まで数える）
test('制限が解けたあとの回数は、実際に送った分だけを書く', async () => {
  const k = build()
  await connected(k)
  k.sim.config.fail.join = BIG
  k.sim.state.joined = false
  event(k.sim, '26')
  await advance(200)
  k.sim._emitLine(`EVENT 32 ${k.sim.config.ipv6} 0`, 1)
  await advance(20 * MINUTE)
  const from = now
  k.sim._emitLine(`EVENT 33 ${k.sim.config.ipv6} 0`, 1)
  assert.ok((await until(() => k.seq.state.consecutiveFailures === 1, 10 * MINUTE, 100)) >= 0, '送った巡は数える')
  assert.ok(k.sim.namesSince(from).includes('SKJOIN'), '前提: 送っている')
  assert.match(k.seq.snapshot().lastError.message, /メーターとの認証が 3 回続けて通りません: EVENT 24/)
})

// ---- 電波の混雑のログ ------------------------------------------------------------------------

// 戻すと落ちるもの: _fail の sendFail の条件を外す（混雑のたびに error の行がデバッグ欄へ出る）
test('電波の混雑で送信が通らなくても error の行を出さず、warn の 1 行にまとめる。失敗の数と lastError はそのまま', async () => {
  const k = build()
  await connected(k)
  await advance(MINUTE)
  const failures = k.seq.snapshot().counters.failures
  const from = now
  k.sim.config.fail.sendto = k.sim.state.sendFailures + 3
  await advance(MINUTE)
  const since = k.logs.filter((l) => l.at >= from)
  assert.equal(lines(since, /./, ['error']).length, 0, lines(since, /./, ['error']).map((l) => l.text).join(' | '))
  assert.equal(lines(since, /UDP 送信失敗（EVENT 21 <PARAM>=01）が 3 回続きました/, ['warn']).length, 1)
  const s = k.seq.snapshot()
  assert.ok(s.counters.failures > failures, '失敗の数は数える')
  assert.equal(s.lastError.label, 'SKSENDTO')
  assert.equal(s.phase, 'connected')
})
