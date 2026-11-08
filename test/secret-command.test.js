'use strict'

// フローの入力 command で、いま効いている認証情報と違う値の SKSETPWD・SKSETRBID を送ったとき。
// registry の redact は今の値しか知らないので、その値はコマンドの文で伏せるしかない。
// 値の出口を全部通して、どこにも出ないことを見る:
//   出力 2 の log・command-result・error、Web UI の GET logs・GET detail・診断の読み出し、status の lastError、
//   受信のエコー（SFE が 1 のままのモジュールは、送ったコマンドをそのまま返す）。
// 値は全部架空。
//
// 戻すと落ちるもの: それぞれの試験に書いた。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createKit, input, connected } = require('./nodes/node-kit')
const { Sequencer } = require('../lib/sequencer')
const { SimulatorTransport } = require('../lib/simulator-transport')

const kit = createKit()
afterEach(() => kit.cleanup())

const API = '/wsuha-broute/api/v1'
const VALUE = 'NEWPASSWORD0' // いま効いている値とは別の、架空の 12 文字
const ANOTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assertHidden(text, what) {
  assert.ok(!text.includes(VALUE), `${what} にパスワードが出ている`)
  assert.ok(!text.includes(ANOTHER_ID), `${what} に認証 ID が出ている`)
}

/** ノードが出した msg の全部（出力 1 と出力 2）。 */
const allSent = (b) => JSON.stringify(b._sent)

// 戻すと落ちるもの: _pump の tx のログを生のコマンドのまま出す・_fail の lastError を生のコマンドのまま残す
test('command で送った別の値は、ログ・返事・lastError・Web UI の読み出しのどこにも出ない', async () => {
  const fake = kit.setup()
  const dev = kit.createDevice(fake, 'sec-1')
  const b = kit.createBroute(fake, 'sec-1', { name: 'B', emitLogs: true, emitRaw: true })
  await connected(dev)

  // 通るもの
  let r = await input(b, { topic: 'command', payload: 'SKSETPWD C ' + VALUE }, 8000)
  assert.equal(r.err, null)
  assert.equal(r.sent[0][1].payload.command, 'SKSETPWD C ********')
  r = await input(b, { topic: 'command', payload: 'SKSETRBID ' + ANOTHER_ID }, 8000)
  assert.equal(r.err, null)

  // 断られるもの（<LEN> が読めない）。失敗の行と lastError に残る道
  r = await input(b, { topic: 'command', payload: 'SKSETPWD ZZ ' + VALUE }, 8000)
  assert.ok(r.err, '前提: アダプタが断る')
  await sleep(50)

  const status = (await input(b, { topic: 'status' })).sent[0][1].payload
  assert.equal(status.lastError.command, 'SKSETPWD ********')
  assertHidden(JSON.stringify(status), 'status')
  assertHidden(allSent(b), '出力')

  const logs = await fake.request('GET', `${API}/adapters/sec-1/logs?limit=1000`)
  assert.equal(logs.statusCode, 200)
  assert.ok(logs.body.items.some((l) => /→ SKSETPWD C \*{8}/.test(l.text)), '伏せた形でログには残す')
  assertHidden(JSON.stringify(logs.body), 'GET logs')

  const detail = await fake.request('GET', `${API}/adapters/sec-1`)
  assertHidden(JSON.stringify(detail.body), 'GET detail')

  // 診断の読み出しは、フローの入力と Web UI の API の両方を通す
  const diag = await input(b, { topic: 'diag', payload: { name: 'info' } }, 8000)
  assert.equal(diag.err, null)
  assertHidden(allSent(b), '診断のあとの出力')
  const viaApi = await fake.request('POST', `${API}/adapters/sec-1/diag`, { body: { name: 'sreg', args: { reg: 'S0A' } } })
  assert.equal(viaApi.statusCode, 200, viaApi.text)
  assertHidden(JSON.stringify(viaApi.body), 'POST diag')
})

// 戻すと落ちるもの: _onLine で受信の行を伏せない（raw・返事の lines・sk の 3 つの道に値が出る）
test('エコーバックが有効なモジュールでも、受信の行に値を出さない', async () => {
  const transport = new SimulatorTransport({ latencyMs: 1 })
  const seq = new Sequencer(transport, { commandTimeout: 1000 })
  const seen = { raw: [], sk: [], lines: [] }
  seq.on('raw', (l) => seen.raw.push(l))
  seq.on('sk', (e) => seen.sk.push(e))
  seq.on('log', () => {})
  try {
    await transport.open()
    await sleep(10)
    assert.equal(transport.state.echo, true, '前提: エコーバックが有効')
    await seq.raw('SKSETPWD C ' + VALUE, { onLine: (l) => seen.lines.push(l) })
    assert.ok(transport.sent.includes('SKSETPWD C ' + VALUE), '前提: モジュールへは値を送っている')
    assert.ok(seen.raw.includes('SKSETPWD C ********'), seen.raw.join(' | '))
    assert.ok(seen.lines.includes('SKSETPWD C ********'), seen.lines.join(' | '))
    assertHidden(JSON.stringify(seen), 'エコー')
  } finally {
    await seq.destroy()
  }
})

// 戻すと落ちるもの: _pump と _rearm の失敗の command を生のまま持たせる・再試行のログの行を伏せない
test('失敗の command と再試行のログにも値を持たせない', async () => {
  const transport = new SimulatorTransport({ latencyMs: 1 })
  const seq = new Sequencer(transport, { commandTimeout: 30, commandMaxTries: 2 })
  const logs = []
  seq.on('log', (l) => logs.push(l.text))
  try {
    await transport.open()
    await sleep(10)
    transport._onCommand = () => {} // 応答を返さない
    const timedOut = await seq.raw('SKSETPWD C ' + VALUE).then(
      () => null,
      (e) => e
    )
    assert.equal(timedOut.code, 'TIMEOUT')
    assert.equal(timedOut.command, 'SKSETPWD C ********')
    assert.ok(logs.some((t) => /再試行（1\/2）: SKSETPWD C \*{8}/.test(t)), logs.join(' | '))
    assertHidden(logs.join('\n'), 'ログ')
  } finally {
    await seq.destroy()
  }
})
