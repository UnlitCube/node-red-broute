'use strict'

// lib/sequencer.js の外から読む面と守り:
//   コマンドの文字: 改行・制御文字・ASCII 以外の文字を含むコマンドを断る（raw・_pump・commandKind・maskCommand）
//   閉じる途中: destroy の SKTERM を、reconnect・stop が取り消さない
//   段階: 再接続の段階は 0〜3 の整数だけ（isLadder）
//   code: CommandError に機械が読む code（画面の API の code と同じ値）
//   公開の面: 相の一覧（PHASE_NAMES）と送信を休む線（snapshot().txBudgetGuardMs）、
//             非公開の項目の代わりの小さな面（generation・isRunning・isEchonetBusy・queueLength・currentCommand・collectingOnce・pollNow）
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const S = require('../lib/sequencer')
const { Sequencer } = S
const { createRegistry } = require('../lib/runtime/registry')
const { commandKind } = require('../lib/runtime/pending')
const outputs = require('../lib/runtime/outputs')
const { makeAdapter, connect } = require('./runtime/adapter-kit')
const { ID, PW } = require('./runtime/fake-red')

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
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('待ち時間を超えました: ' + (what || '条件'))
}

/** 片付けの一覧に載せた 1 台ぶんのアダプタ。 */
function adapter(id, opts) {
  const a = makeAdapter(createRegistry(), id, opts)
  live.push(a.seq)
  return a
}

/** 書いたバイトを覚えるだけの偽のポート（開いている）。 */
class WriteSpy extends EventEmitter {
  constructor() {
    super()
    this.writes = []
    this.isOpen = true
  }
  open() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
  write(b) {
    this.writes.push(Buffer.from(b))
    return Promise.resolve()
  }
  get text() {
    return Buffer.concat(this.writes).toString('latin1')
  }
}

function spySeq(opts) {
  const t = new WriteSpy()
  const seq = new Sequencer(t, Object.assign({ label: 'x', commandTimeout: 150, commandMaxTries: 1 }, opts))
  seq.state.portOpen = true
  live.push(seq)
  return { seq, t }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60))

// ---------------------------------------------------------------------------
//  コマンドの文字
// ---------------------------------------------------------------------------

test('raw() は改行・制御文字・ASCII 以外の文字を含むコマンドを断り、アダプタに何も書かない（FLASH を消耗するコマンドの禁止を抜けない）', async () => {
  // 戻すと落ちるもの: sequencer.js の raw() の最初の commandTextProblem を外す（先頭だけの検査に戻す）
  for (const cmd of ['SKINFO\rWOPT 01', 'SKINFO\nWUART 03', 'SKINFO\r\nSKSAVE', 'SKINFOčSKSAVE', 'SKINFO\tSKERASE', 'SKINFO\u0000', 'SKVER\u007f']) {
    const { seq, t } = spySeq()
    const err = await seq.raw(cmd).then(
      () => null,
      (e) => e
    )
    await settle()
    assert.ok(err, JSON.stringify(cmd) + ' を断る')
    assert.equal(err.code, 'VALIDATION', JSON.stringify(cmd))
    assert.match(err.message, /改行・制御文字・ASCII 以外/)
    assert.equal(t.text, '', JSON.stringify(cmd) + ' は書かない: ' + JSON.stringify(t.text))
    seq.removeAllListeners()
  }
  // 前後の空白（行末の CR を含む）は今までどおり外して送る
  const { seq, t } = spySeq()
  const p = seq.raw('  SKVER\r').catch(() => {})
  await settle()
  assert.equal(t.text, 'SKVER\r')
  seq._abortQueue('試験の片付け')
  await p
})

test('送信制限中（radioBlocked）でも、改行で 2 つ目に SKSENDTO を混ぜたものは書かない。小文字の sksendto も保留する', async () => {
  // 戻すと落ちるもの: raw() の commandTextProblem を外す・RADIO_COMMAND の /i を外す
  for (const cmd of ['SKINFO\rSKSENDTO 1 X', 'sksendto 1 X', 'SKSENDTO 1 X']) {
    const { seq, t } = spySeq()
    seq.state.radioBlocked = true
    const p = seq.raw(cmd).catch((e) => e)
    await settle(80)
    assert.equal(t.text, '', JSON.stringify(cmd) + ' → ' + JSON.stringify(t.text))
    seq._abortQueue('試験の片付け')
    await p
    seq.removeAllListeners()
  }
})

test('_pump も、raw() を通らない道の改行入りのコマンドを書かない（多重の守り）。空のコマンド（入力バッファを流す裸の CR）は今までどおり送る', async () => {
  // 戻すと落ちるもの: sequencer.js の _pump の COMMAND_TEXT の確かめを外す
  const { seq, t } = spySeq()
  const err = await seq._send('SKINFO\rWOPT 01', { ok: true }, { tries: 1 }).then(
    () => null,
    (e) => e
  )
  await settle()
  assert.ok(err)
  assert.equal(err.code, 'VALIDATION')
  assert.equal(t.text, '')
  const flush = seq._send('', { settle: 20 }, { label: 'flush', tries: 1 })
  await flush
  assert.equal(t.text, '\r', '裸の CR')
  seq.removeAllListeners()
})

test('預かりの種類分け（commandKind）は改行入りを module にしない。伏せ字（maskCommand）は 2 つ目の SKSETPWD の値を出さない', () => {
  // 戻すと落ちるもの: pending.js の commandKind の isCommandText・outputs.js の maskCommand の isCommandText を外す
  assert.equal(commandKind('SKINFO'), 'module')
  assert.equal(commandKind('SKINFO\rWUART 03'), 'meter', '止めた台でも流れる module にしない')
  assert.equal(commandKind('SKVER\nSKSAVE'), 'meter')
  assert.equal(commandKind('SKINFOčSKSAVE'), 'meter')
  const shown = outputs.maskCommand('SKINFO\rSKSETPWD C ' + PW)
  assert.ok(!shown.includes(PW), shown)
  assert.equal(outputs.maskCommand('SKSETPWD C ' + PW), 'SKSETPWD C ********', '今までの伏せ方')
  assert.equal(outputs.maskCommand('SKINFO'), 'SKINFO')
  assert.equal(S.isCommandText('SKINFO'), true)
  assert.equal(S.isCommandText('SKINFO\r'), true, '前後の空白は外して見る')
  assert.equal(S.isCommandText('SKINFO\rX'), false)
  assert.equal(S.isCommandText(''), false)
  assert.equal(S.isCommandText(null), false)
})

// ---------------------------------------------------------------------------
//  CommandError の code
// ---------------------------------------------------------------------------

test('本物の sequencer が投げる失敗に、画面の API と同じ code が付く（文言を変えても code で読める）', async () => {
  // 戻すと落ちるもの: sequencer.js の CommandError に code を付けない（どれか 1 つでも）
  // 未接続の get（メーターのアドレスが無い）→ NOT_CONNECTED
  const a = spySeq()
  a.seq._running = true
  const e1 = await a.seq.get([0xe7], 'manual').then(
    () => null,
    (e) => e
  )
  assert.equal(e1 && e1.code, 'NOT_CONNECTED', e1 && e1.message)
  // 送信総和時間の制限中 → RADIO_BLOCKED（blockedBy: radio）
  a.seq.state.meter.ipv6 = 'FE80:0000:0000:0000:0000:0000:0000:0001'
  a.seq.state.radioBlocked = true
  const e2 = await a.seq.get([0xe7], 'manual').then(
    () => null,
    (e) => e
  )
  assert.equal(e2 && e2.code, 'RADIO_BLOCKED')
  assert.equal(e2.blockedBy, 'radio')
  a.seq.state.radioBlocked = false
  // 滞留（待ち行列の上限）→ BUSY
  a.seq.options.maxQueuedRequests = 0
  const e3 = await a.seq.get([0xe7], 'manual').then(
    () => null,
    (e) => e
  )
  assert.equal(e3 && e3.code, 'BUSY')
  assert.equal(e3.queueFull, true)
  a.seq.removeAllListeners()
  // FLASH を消耗する → FORBIDDEN_COMMAND（forbidden: true）
  const e4 = await spySeq().seq.raw('WOPT 01').then(
    () => null,
    (e) => e
  )
  assert.equal(e4.code, 'FORBIDDEN_COMMAND')
  assert.equal(e4.forbidden, true)
  const e5 = await spySeq().seq.raw('SKSREG SFE 0').then(
    () => null,
    (e) => e
  )
  assert.equal(e5.code, 'FORBIDDEN_COMMAND')
  // 応答が無い → TIMEOUT
  const b = spySeq({ commandTimeout: 40 })
  const e6 = await b.seq.raw('SKVER').then(
    () => null,
    (e) => e
  )
  assert.equal(e6 && e6.code, 'TIMEOUT')
  assert.equal(e6.timeout, true)
  b.seq.removeAllListeners()
  // 書き込めない → PORT_DOWN
  const c = spySeq()
  c.t.write = () => Promise.reject(new Error('ポートが開いていません'))
  const e7 = await c.seq.raw('SKVER').then(
    () => null,
    (e) => e
  )
  assert.equal(e7 && e7.code, 'PORT_DOWN')
  c.seq.removeAllListeners()
  // PANA 認証中の保留が時間を過ぎた → RADIO_BLOCKED（blockedBy: pana）
  const d = spySeq({ commandTimeout: 30 })
  d.seq.state.phase = 'reauth'
  const e8 = await d.seq.raw('SKSENDTO 1 X').then(
    () => null,
    (e) => e
  )
  assert.equal(e8 && e8.code, 'RADIO_BLOCKED')
  assert.equal(e8.blockedBy, 'pana')
  d.seq.removeAllListeners()
})

test('アダプタの FAIL はアダプタの code（ER06 など）のまま。ほかの CommandError は、決めた例外を除いて全部 code を持つ', async () => {
  // 戻すと落ちるもの: sequencer.js の CommandError の作り方から code を外す（新しく足すときに付け忘れる）
  const { seq } = adapter('cf-er', { sim: { fail: { sreg: ['SFD'] } } })
  await connect(seq)
  const e1 = await seq.raw('SKSREG SFD').then(
    () => null,
    (e) => e
  )
  assert.equal(e1 && e1.code, 'ER06')
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sequencer.js'), 'utf8').replace(/\r\n/g, '\n')
  // code を持たない（持たせない）もの: 接続の手順の中の失敗（再接続に回るだけで、画面の API とフローには出ない）と、
  // FAIL・EVENT（アダプタの値・event を持つ）
  const EXEMPT = [/認証情報が未設定か/, /メーターが見つかりませんでした/, /メーターとの認証/, /\{ event: e\.num \}/, /code: e\.code/]
  const calls = []
  let i = -1
  while ((i = src.indexOf('new CommandError(', i + 1)) >= 0) {
    // 呼び出しの終わり（括弧の対応）まで
    let depth = 0
    let j = i + 'new CommandError'.length
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')' && --depth === 0) break
    }
    calls.push(src.slice(i, j + 1))
  }
  assert.ok(calls.length >= 20, String(calls.length))
  const missing = calls.filter((c) => !/\bcode: '[A-Z_]+'/.test(c) && !EXEMPT.some((re) => re.test(c)))
  assert.deepEqual(missing, [], 'code の無い CommandError')
  // code の値は画面の API の code の中だけ
  const codes = Array.from(new Set(calls.map((c) => (c.match(/\bcode: '([A-Z_]+)'/) || [])[1]).filter(Boolean))).sort()
  assert.deepEqual(codes, ['BUSY', 'DEVICE_ERROR', 'FORBIDDEN_COMMAND', 'NOT_CONNECTED', 'PORT_DOWN', 'RADIO_BLOCKED', 'TIMEOUT', 'VALIDATION'])
})

// ---------------------------------------------------------------------------
//  閉じる途中の SKTERM
// ---------------------------------------------------------------------------

test('閉じる途中（destroy の SKTERM の最中）の reconnect・stop・start は、その SKTERM を取り消さない', async () => {
  // 戻すと落ちるもの: sequencer.js の reconnect の isClosing の確かめを外し、かつ _abortQueue の keepOnAbort を外す
  const { seq, transport } = adapter('cl-1')
  await connect(seq)
  transport.config.latencyMs = 250 // SKTERM の応答（EVENT 27）を遅らせる
  const logs = []
  seq.on('log', (l) => logs.push(l))
  const closing = seq.destroy()
  await waitFor(() => /SKTERM/.test(String(seq.currentCommand() || '')), 2000, 'SKTERM の送信')
  assert.equal(seq.isClosing(), true)
  await seq.reconnect('試験の reconnect', 0)
  await seq.stop('試験の stop', { external: true })
  await seq.start()
  await closing
  const texts = logs.map((l) => l.level + ' ' + l.text)
  assert.ok(!texts.some((t) => /終了時の SKTERM が通りませんでした/.test(t)), texts.filter((t) => /SKTERM/.test(t)).join(' | '))
  assert.ok(texts.some((t) => /メーターとのセッションを終了してから閉じます/.test(t)), 'SKTERM が通った')
  assert.ok(texts.some((t) => /閉じている途中なので、再接続しません/.test(t)))
  assert.equal(transport.sent.filter((c) => c === 'SKRESET').length, 1, '閉じる途中に SKRESET から繋ぎ直さない（最初の 1 回だけ）')
})

// ---------------------------------------------------------------------------
//  段階
// ---------------------------------------------------------------------------

test('isLadder は 0〜3 の整数だけ。reconnect に外れた段階を渡しても state.ladder に入れない', async () => {
  // 戻すと落ちるもの: sequencer.js の reconnect を `if (typeof ladder === 'number') this.state.ladder = ladder` に戻す
  for (const v of [0, 1, 2, 3]) assert.equal(S.isLadder(v), true, String(v))
  for (const v of [-1, 4, 7, 1.5, '2', null, undefined, NaN]) assert.equal(S.isLadder(v), false, String(v))
  assert.equal(S.LADDER_MAX, 3)
  const { seq } = spySeq()
  seq.setCredentials(ID, PW, '試験')
  await seq.reconnect('試験', 7)
  assert.equal(seq.state.ladder, 0, '7 は入れない')
  await seq.reconnect('試験', 2)
  assert.equal(seq.state.ladder, 2)
  await seq.destroy()
})

// ---------------------------------------------------------------------------
//  公開の面
// ---------------------------------------------------------------------------

test('相の一覧（PHASE_NAMES）に、sequencer が実際に入れる相が全部ある（画面のステッパーの比べる元）', () => {
  // 戻すと落ちるもの: sequencer.js に新しい相を足して PHASES に足さない
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sequencer.js'), 'utf8')
  const used = Array.from(new Set((src.match(/_setPhase\('([a-z-]+)'/g) || []).map((s) => s.slice(11, -1))))
  assert.ok(used.length >= 13, used.join(','))
  for (const p of used) assert.ok(S.PHASE_NAMES.indexOf(p) >= 0, p + ' が PHASE_NAMES に無い')
  assert.deepEqual(S.PHASE_NAMES, Object.keys(S.PHASES))
  // PHASES にあって使っていないのは 'error'（予約。画面は「手順の外」として扱う）だけ
  assert.deepEqual(S.PHASE_NAMES.filter((p) => used.indexOf(p) < 0), ['error'])
})

test('snapshot() に送信を休む線（txBudgetGuardMs）。見張りを切っていれば null', () => {
  // 戻すと落ちるもの: snapshot に txBudgetGuardMs を載せない
  const a = new Sequencer(new EventEmitter(), {})
  assert.equal(a.snapshot().txBudgetGuardMs, S.DEFAULTS.txBudgetGuardMs)
  assert.equal(S.DEFAULTS.txBudgetGuardMs, 250000)
  const b = new Sequencer(new EventEmitter(), { txBudgetGuardMs: 200000 })
  assert.equal(b.snapshot().txBudgetGuardMs, 200000)
  const c = new Sequencer(new EventEmitter(), { txBudgetGuard: false })
  assert.equal(c.snapshot().txBudgetGuardMs, null)
})

test('公開の面（generation・isRunning・isEchonetBusy・queueLength・currentCommand・collectingOnce・pollNow）が、中の状態と同じことを言う', async () => {
  // 戻すと落ちるもの: 公開の面のどれかを外す・中の項目と違うものを返す
  const { seq } = adapter('face-1', { seq: { pollIntervalSec: 30 } })
  assert.equal(seq.generation, seq._generation)
  assert.equal(seq.isRunning(), false)
  assert.equal(seq.isEchonetBusy(), false)
  assert.equal(seq.queueLength(), 0)
  assert.equal(seq.currentCommand(), null)
  assert.equal(seq.collectingOnce(), null)
  await connect(seq)
  assert.equal(seq.isRunning(), true)
  const g = seq.generation
  // 取得の途中は isEchonetBusy
  const p = seq.get([0xe7], 'manual')
  assert.equal(seq.isEchonetBusy(), true)
  await p
  await waitFor(() => !seq.isEchonetBusy(), 4000, '取得が終わる')
  assert.equal(seq.isEchonetBusy(), !!seq._pending || seq._requestDepth > 0)
  // 秘密の引数は伏せる
  seq._current = { command: 'SKSETPWD C ' + PW }
  assert.equal(seq.currentCommand(), 'SKSETPWD C ********')
  seq._current = null
  // pollNow は今すぐの取得を張る。取得の途中かどうかは、その取得の SKSENDTO を送る瞬間に見る。
  // シミュレーターでは取得の途中（送ってから OK・応答・EVENT 21 を読むまで）が 50ms ほどしかない。
  // 間を空けて isEchonetBusy を見張ると、CPU が足りずにイベントループが 50ms を超えて止まったとき、
  // 止まっている間に全部が届いて途中を一度も見ないまま待ちが切れる（送った直後に 80ms 止めると再現する）
  const busyAtSend = []
  const onLog = (l) => {
    if (l.level === 'tx' && /SKSENDTO/.test(l.text)) busyAtSend.push(seq.isEchonetBusy())
  }
  seq.on('log', onLog)
  seq.pollNow()
  assert.ok(seq._pollTimer)
  await waitFor(() => busyAtSend.length > 0, 2000, '今すぐの取得')
  await waitFor(() => !seq.isEchonetBusy(), 4000, '取得が終わる')
  seq.removeListener('log', onLog)
  assert.equal(busyAtSend[0], true, '取得の途中は isEchonetBusy')
  // reconnect で世代が進む
  await seq.reconnect('試験')
  assert.ok(seq.generation > g)
  await seq.stop('試験')
  assert.equal(seq.isRunning(), false)
})

test('lib/runtime の pending・outputs・registry と nodes/ は、sequencer の非公開の項目を触らない', () => {
  // 戻すと落ちるもの: これらのファイルに seq._generation・sequencer._running などを書き戻す
  const root = path.join(__dirname, '..')
  const files = ['lib/runtime/pending.js', 'lib/runtime/outputs.js', 'lib/runtime/registry.js', 'nodes/wsuha-device.js', 'nodes/wsuha-broute.js']
  const PRIVATE = /\b(?:seq|sequencer|cur|s)\._(?:generation|running|pending|requestDepth|queue|current|collectingOnce|schedulePoll)\b/g
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    const hits = src.match(PRIVATE) || []
    assert.deepEqual(hits, [], f)
  }
})
