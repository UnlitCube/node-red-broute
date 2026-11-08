'use strict'

// serialport が読み込めない環境（パレットから入れただけ・ネイティブのビルドが通らない）で、
// 何をすればよいかが分かる文を返し、Require stack の絶対パスを外へ出さないことを確かめる。
// 本物の serialport の有無に頼らないように、Module._load で読み込みの結果を差し替える。

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { SerialTransport } = require('../lib/serial-transport')
const { Sequencer } = require('../lib/sequencer')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'

const REQUIRE_FAILURE = "Cannot find module 'serialport'\nRequire stack:\n- /tmp/u/node_modules/x/lib/serial-transport.js\n- /tmp/u/node_modules/x/nodes/wsuha-device.js"

const realLoad = Module._load
let answer = null // 関数なら呼ぶ（投げれば読み込み失敗）

// 試験が途中で落ちても片付ける。回ったままの sequencer を残すと、Node 18 では試験のプロセスが終わらない
const live = []

beforeEach(() => {
  answer = () => {
    const e = new Error(REQUIRE_FAILURE)
    e.code = 'MODULE_NOT_FOUND'
    throw e
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'serialport') return answer()
    return realLoad.call(this, request, parent, isMain)
  }
})

afterEach(async () => {
  Module._load = realLoad
  for (const s of live.splice(0)) await s.destroy().catch(() => {})
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 待ちは単調な時計で測る。壁時計は飛ぶことがある
async function waitFor(fn, ms, what) {
  const limit = performance.now() + (ms || 3000)
  while (performance.now() < limit) {
    if (fn()) return true
    await sleep(5)
  }
  throw new Error('待ち時間を超えました: ' + (what || '条件'))
}

/** 開くだけの偽の serialport。 */
class FakePort extends EventEmitter {
  constructor(opts) {
    super()
    this.opts = opts
    this.isOpen = false
  }
  open(cb) {
    this.isOpen = true
    cb(null)
  }
  close(cb) {
    this.isOpen = false
    cb()
  }
}

// 戻すと落ちるもの: open() の失敗に require の文言をそのまま付ける
test('serialport が読み込めないと、code と次の一手を返し、Require stack を文言に入れない', async () => {
  const t = new SerialTransport({ path: '/dev/ttyUSB0' })
  const e = await t.open().then(
    () => null,
    (x) => x,
  )
  assert.ok(e)
  assert.equal(e.code, 'SERIALPORT_MISSING')
  assert.equal(
    e.message,
    'serialport を読み込めません。パレットからこのノードを入れ直すか、userDir で npm install serialport@12 を実行して、Node-RED を再起動してください',
  )
  assert.doesNotMatch(e.message, /Require stack|\/tmp\/u/)
  assert.match(e.detail, /Require stack/, '原文はログへ渡すために持つ')
})

// 戻すと落ちるもの: Promise の中で _opening を null にする書き方に戻す（外の代入で失敗した Promise が残る）
test('開けなかったあとの open() は、前の失敗を返し続けず、読み込み直す', async () => {
  const t = new SerialTransport({ path: '/dev/ttyUSB0' })
  await assert.rejects(() => t.open(), { code: 'SERIALPORT_MISSING' })
  assert.equal(t._opening, null)
  answer = () => ({ SerialPort: FakePort })
  await t.open()
  assert.equal(t.isOpen, true)
  await t.close()
})

test('new SerialPort が投げても、開き直せる', async () => {
  let thrown = false
  class Picky extends FakePort {
    constructor(opts) {
      super(opts)
      if (!thrown) {
        thrown = true
        throw new Error('開けません')
      }
    }
  }
  answer = () => ({ SerialPort: Picky })
  const t = new SerialTransport({ path: '/dev/ttyUSB0' })
  await assert.rejects(() => t.open(), /開けません/)
  await t.open()
  assert.equal(t.isOpen, true)
  await t.close()
})

// 戻すと落ちるもの: available() を足さない・読み込みの失敗を投げる
test('available() は読み込めるかを返す。list と candidates は読み込めなくても空を返す', async () => {
  assert.equal(SerialTransport.available(), false)
  assert.deepEqual(await SerialTransport.list(), [])
  assert.deepEqual(await SerialTransport.candidates({ byIdDir: null }), [])
  class Listed extends FakePort {
    static async list() {
      return [{ path: '/dev/ttyUSB0', manufacturer: 'FTDI' }]
    }
  }
  answer = () => ({ SerialPort: Listed })
  assert.equal(SerialTransport.available(), true)
  assert.equal((await SerialTransport.list())[0].path, '/dev/ttyUSB0')
})

test('古い serialport（既定の export が本体）も読める', async () => {
  answer = () => FakePort
  const t = new SerialTransport({ path: '/dev/ttyUSB0' })
  await t.open()
  assert.equal(t.isOpen, true)
  await t.close()
})

// 戻すと落ちるもの: _recordError が code を落とす・_reportDetail を 'log' へ流す（画面のログに Require stack が出る）
test('Sequencer を通すと lastError に code が残り、原文は error のイベントにだけ 1 回出る', async () => {
  const seq = new Sequencer(new SerialTransport({ path: '/dev/ttyUSB0' }), { retryBaseMs: 10, maxRetryDelayMs: 20 })
  live.push(seq)
  seq.setCredentials(ID, PW, 'test')
  const logs = []
  const details = []
  seq.on('log', (l) => logs.push(l.text))
  seq.on('error', (e) => details.push(e.message))
  await seq.start()
  await waitFor(() => seq.state.consecutiveFailures >= 3, 3000, '開く再試行')
  const s = seq.snapshot()
  assert.equal(s.lastError.code, 'SERIALPORT_MISSING')
  assert.equal(s.phase, 'opening')
  assert.doesNotMatch(JSON.stringify(s), /Require stack/)
  assert.doesNotMatch(logs.join('\n'), /Require stack/)
  assert.equal(details.length, 1, '再試行のたびに複数行を残さない')
  assert.match(details[0], /Require stack/)
  await seq.destroy()
})

test('error の受け手が居なくても落ちない', async () => {
  const seq = new Sequencer(new SerialTransport({ path: '/dev/ttyUSB0' }), { retryBaseMs: 10, maxRetryDelayMs: 20 })
  live.push(seq)
  seq.setCredentials(ID, PW, 'test')
  await seq.start()
  await waitFor(() => seq.state.consecutiveFailures >= 1, 3000, '開く再試行')
  assert.equal(seq.snapshot().lastError.code, 'SERIALPORT_MISSING')
  await seq.destroy()
})

/** open の結果を差し替えられる偽の serialport。reason が文字なら開けない。 */
function flakyPort() {
  const box = { reason: 'Error: No such file or directory', opened: 0 }
  class Flaky extends FakePort {
    // 本物の serialport は open の結果をあとから返す
    open(cb) {
      box.opened++
      setImmediate(() => (box.reason ? cb(new Error(box.reason)) : super.open(cb)))
    }
  }
  return { box, Flaky }
}

// 戻すと落ちるもの: _scheduleReconnect の catch で毎回 emit('error') する（抜けている間 5 秒ごとに同じ error が出る）
test('自動の開き直しの失敗は、文が変わったときだけ知らせる。開いたら数え直す', async () => {
  const { box, Flaky } = flakyPort()
  answer = () => ({ SerialPort: Flaky })
  const t = new SerialTransport({ path: '/dev/ttyUSB0', reconnectMs: 5 })
  const errors = []
  t.on('error', (e) => errors.push(e.message))
  await assert.rejects(() => t.open(), /No such file/)
  await waitFor(() => box.opened >= 6, 3000, '開き直し')
  assert.equal(errors.length, 1, '同じ失敗は 1 回: ' + errors.join(' | '))

  box.reason = 'Error: Permission denied'
  const seen = box.opened
  await waitFor(() => box.opened >= seen + 4, 3000, '別の理由の開き直し')
  assert.deepEqual(errors, ['Error: No such file or directory', 'Error: Permission denied'], '文が変われば知らせる')

  box.reason = null
  await waitFor(() => t.isOpen, 3000, '開く')
  box.reason = 'Error: Permission denied'
  t.port.isOpen = false
  t.port.emit('close')
  await waitFor(() => errors.length === 3, 3000, '開いたあとの失敗')
  assert.equal(errors[2], 'Error: Permission denied', '一度開いたら、同じ文でも新しい失敗として知らせる')
  await t.close()
})
