'use strict'

// wsuha-broute の出力 1 と出力 2 の msg.payload は、どの topic でも
// JSON にそのまま変換できるただのオブジェクト（JSON.parse(JSON.stringify(payload)) が元と同じ）。
// 後ろに json ノードやパーサーを挟まずに使える。
//
//  - 偽の RED とシミュレータで、入力の topic を一通り送り、接続・取得・診断・失敗・ログ・生の行・alert / recovered を起こして、
//    出力 1 と出力 2 に出た全部の payload を確かめる
//  - raw は {device, deviceKey, at, ts, line, kind, parsed}、command-result は {device, deviceKey, command, ok, at, ts, lines, parsed, error}
//  - 既存のフローが読む名前と型（log の ts はミリ秒の数・text・level・device、alert・recovered・error の ts は ISO の文字列）は変えない
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { waitFor, ID, PW } = require('../runtime/fake-red')
const { createKit, input, connected } = require('./node-kit')

const kit = createKit()
const { setup, speedUp } = kit
const B = '/wsuha-broute/api/v1'
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/

afterEach(() => kit.cleanup())

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
}

/** ノードが出した全部の msg を {port, msg} の並びにする（出力 1 と出力 2）。 */
function sentOf(node) {
  const list = []
  for (const m of node._sent) {
    assert.ok(Array.isArray(m) && m.length === 2, '出力は [出力 1, 出力 2] の配列で送る')
    if (m[0]) list.push({ port: 1, msg: m[0] })
    if (m[1]) list.push({ port: 2, msg: m[1] })
  }
  return list
}

/** ただのオブジェクトで、JSON の往復で変わらない（Buffer・Date・undefined・NaN・-0・Map・関数・循環が無い）。 */
function assertJsonPayload(o, what) {
  const p = o.msg.payload
  const label = `${what}: 出力 ${o.port} の ${o.msg.topic}`
  assert.ok(isPlainObject(p), `${label} の payload がただのオブジェクトではない (${p === null ? 'null' : Array.isArray(p) ? 'array' : typeof p})`)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), p, `${label} の payload が JSON の往復で変わる`)
}

function assertNoSecrets(text, what) {
  for (const x of [ID, PW, ID.toLowerCase(), PW.toLowerCase(), ID.slice(0, 4) + '…' + ID.slice(-4)]) {
    assert.ok(!text.includes(x), `${what} に秘密（${x.slice(0, 4)}…）が出ている`)
  }
}

/** メーターが居ない状態で始め（スキャンが空 → 連続失敗 → alert）、E8 を 1 回だけ Get_SNA にする（出力 1 の partial）。 */
function simOptions() {
  return JSON.stringify({
    latencyMs: 1,
    joinMs: 10,
    scanTimeScale: 0.005,
    pairId: ID.slice(-8),
    echonetDelayMs: 5,
    meterPresent: false,
    fail: { sna: { E8: 1 } },
  })
}

/** 1 回失敗させて alert を出し、メーターを現してから繋がるのを待つ（recovered）。 */
async function failOnceThenConnect(dev, b) {
  dev.sequencer.options.maxRetryDelayMs = 100
  await waitFor(() => b._sent.some((m) => m[1] && m[1].topic === 'alert'), 8000, 'alert')
  dev.sequencer.transport.config.meterPresent = true
  await connected(dev)
  await waitFor(() => b._sent.some((m) => m[1] && m[1].topic === 'recovered'), 8000, 'recovered')
}

/**
 * 構成の変更で sequencer を作り直したときも、待ち時間を詰める（config-io.test.js と同じ）。
 * 作り直したシミュレータは設定ノードの simulatorOptions（メーターが居ない）から始まるので、メーターを居ることにする。
 */
function keepFast(dev) {
  const orig = dev._build
  dev._build = function () {
    const had = dev.sequencer
    const r = orig.call(dev)
    if (dev.sequencer && dev.sequencer !== had) {
      speedUp(dev.sequencer)
      if (dev.sequencer.transport && dev.sequencer.transport.config) dev.sequencer.transport.config.meterPresent = true
    }
    return r
  }
}

async function settled(dev) {
  await waitFor(() => !dev.handle.reconfiguring, 15000, '開き直しの終わり')
}

// 送る入力（topic を一通り）。[msg, 失敗してよいか]
function inputsToSend() {
  return [
    [{ topic: 'status' }, false],
    [{ topic: 'get', payload: ['E7', 'E8'] }, false],
    [{ topic: 'get', payload: 'E0' }, false],
    [{ topic: 'poll' }, false],
    [{ topic: 'command', payload: 'SKINFO' }, false],
    [{ topic: 'command', payload: 'SKVER' }, false],
    [{ topic: 'raw', payload: 'SKAPPVER' }, false],
    [{ topic: 'command', payload: { command: 'ROPT' } }, false],
    [{ topic: 'command', payload: 'SKSREG S02' }, false],
    [{ topic: 'command', payload: 'SKTABLE E' }, false],
    [{ topic: 'command', payload: 'SKFOO' }, true], // FAIL ER04
    [{ topic: 'command', payload: 'WOPT 01' }, true], // 送る前に断る（FLASH を消耗する）
    [{ topic: 'interval', payload: 60 }, false],
    [{ topic: 'interval', payload: 5 }, true], // VALIDATION
    [{ topic: 'interval', payload: null }, false],
    [{ topic: 'epcs', payload: 'E7, E8' }, false],
    [{ topic: 'epcs', payload: ['E2'] }, true], // VALIDATION
    [{ topic: 'epcs', payload: null }, false],
    [{ topic: 'clear-radio-block' }, false],
    [{ topic: 'settings', payload: { pollIntervalSec: 45, pollEpcs: ['E7'] } }, false],
    [{ topic: 'settings', payload: { pollIntervalSec: 1 } }, true], // VALIDATION
    [{ topic: 'get-settings' }, false],
    [{ topic: 'settings-reset' }, false],
    [{ topic: 'diag', payload: { name: 'info' } }, false],
    [{ topic: 'diag', payload: { name: 'table', args: { which: 'E' } } }, false],
    [{ topic: 'diag', payload: { name: 'ropt' } }, false],
    [{ topic: 'diag', payload: { name: 'sreg', args: { reg: 'S02' } } }, false],
    [{ topic: 'diag', payload: { name: 'sreg', args: { reg: 'SFD' } } }, false],
    [{ topic: 'diag', payload: { name: 'propmap' } }, false],
    [{ topic: 'diag', payload: { name: 'epc', args: { epcs: ['E7', 'E8'] } } }, false],
    [{ topic: 'diag', payload: { name: 'raw', args: { command: 'SKRESET' } } }, true], // FORBIDDEN_COMMAND
    [{ topic: 'detail' }, false],
    // 最新値の読み出し（無線を使わない・maxAgeSec で取りに行く・読めない EPC は VALIDATION）
    [{ topic: 'read' }, false],
    [{ topic: 'read', payload: ['E7', 'E8'] }, false],
    [{ topic: 'read', payload: { keys: ['instantPower'], maxAgeSec: 0 } }, false],
    [{ topic: 'read', payload: ['ZZ'] }, true], // VALIDATION
    [{ topic: 'trend', payload: '6h' }, false],
    [{ topic: 'logs', payload: { limit: 50 } }, false],
    [{ topic: 'logs', payload: { level: 'nope' } }, true], // VALIDATION
    [{ topic: 'adapters' }, false],
    [{ topic: 'meta' }, false],
    [{ topic: 'serialports' }, false],
    [{ topic: 'get-config' }, false],
    [{ topic: 'config', payload: { name: 'JSON の試験', role: '電力' } }, false],
    [{ topic: 'config', payload: { serialbaud: 12345 } }, true], // VALIDATION
    [{ topic: 'config-reset' }, false],
    [{ topic: 'credentials', payload: { routeBId: ID, routeBPassword: PW } }, false],
    [{ topic: 'credentials', payload: { routeBId: 'short', routeBPassword: PW } }, true], // VALIDATION
    [{ topic: 'credentials-reset' }, false],
    [{ topic: 'stop', payload: { reason: '試験' } }, false],
    [{ topic: 'start' }, false],
    [{ topic: 'stop', payload: { reason: '試験 2' } }, false],
    [{ topic: 'resume' }, false],
    [{ topic: 'terminate' }, false],
    [{ topic: 'auto' }, false],
    [{ topic: 'reset' }, false],
    [{ topic: 'reconnect', payload: { ladder: 0 } }, false],
    [{ topic: 'nope' }, true], // 未知の指示
  ]
}

test('出力 1 と出力 2 の payload は、どの topic でもただのオブジェクトで JSON の往復で変わらない（入力を一通り・接続・取得・診断・失敗・ログ・生の行・alert / recovered）', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の raw を行の文字列のまま出す（payload: line）。
  // （ここで起こしたものは、送る直前の plain() が無くても JSON の往復で変わらなかった。plain() の守りは「壊れた電文」の試験で見る）
  const fake = setup()
  const dev = kit.createDevice(fake, 'json-all', { simulatorOptions: simOptions(), deviceKey: 'jsonall' })
  keepFast(dev)
  const b = kit.createBroute(fake, 'json-all', { name: 'JSON', emitLogs: true, emitRaw: true, alertAfterFailures: 1 })
  const b2 = kit.createBroute(fake, 'json-all') // ほかのノードの変更の知らせ（settings・config）を受ける側
  await failOnceThenConnect(dev, b)

  const failures = []
  for (const [msg, mayFail] of inputsToSend()) {
    const r = await input(b, Object.assign({ correlation: 'c-' + msg.topic }, msg), 20000)
    if (r.err && !mayFail) failures.push(`${msg.topic} ${JSON.stringify(msg.payload)}: ${r.err.message}`)
    if (!r.err && mayFail) failures.push(`${msg.topic} ${JSON.stringify(msg.payload)}: 失敗するはずが通った`)
    if (msg.topic === 'config' || msg.topic === 'config-reset' || msg.topic === 'credentials' || msg.topic === 'credentials-reset') {
      await settled(dev)
    }
    if (msg.topic === 'reconnect') await connected(dev)
  }
  assert.deepEqual(failures, [])
  // 診断の失敗（FAIL ER06）も起こす
  dev.sequencer.transport.config.fail.sreg = ['SFD']
  const x = await input(b, { topic: 'diag', payload: { name: 'sreg', args: { reg: 'SFD' } } })
  dev.sequencer.transport.config.fail.sreg = []
  assert.ok(x.err)
  await connected(dev)
  // 定期の取得が 1 回は出力 1 に出るまで待つ（取得間隔を詰める）
  dev.sequencer.setPollInterval(1)
  const before = sentOf(b).filter((o) => o.port === 1).length
  await waitFor(() => sentOf(b).filter((o) => o.port === 1).length > before, 8000, '定期の取得')

  // --- 全部の payload ---
  const all = sentOf(b).concat(sentOf(b2))
  assert.ok(all.length > 100, '出力が少なすぎる: ' + all.length)
  for (const o of sentOf(b)) assertJsonPayload(o, 'b')
  for (const o of sentOf(b2)) assertJsonPayload(o, 'b2')
  assertNoSecrets(JSON.stringify(all.map((o) => o.msg)), '出力')

  // --- 出た topic（出力 2） ---
  const topics = new Set(sentOf(b).filter((o) => o.port === 2).map((o) => o.msg.topic))
  for (const t of [
    'status', 'phase', 'event', 'log', 'raw', 'command-result', 'error', 'alert', 'recovered',
    'settings', 'config', 'credentials', 'serialports', 'diag', 'detail', 'trend', 'logs', 'adapters', 'meta', 'read',
  ]) {
    assert.ok(topics.has(t), `出力 2 に ${t} が出ていない（出たもの: ${Array.from(topics).join(', ')}）`)
  }
  const topics2 = new Set(sentOf(b2).filter((o) => o.port === 2).map((o) => o.msg.topic))
  assert.ok(topics2.has('settings') && topics2.has('config'), 'ほかのノードの変更の知らせ（settings・config）')
  assert.ok(sentOf(b).filter((o) => o.port === 1).length >= 3, '出力 1 の計測値')
  assert.ok(sentOf(b).some((o) => o.port === 1 && o.msg.payload.partial === true), 'Get_SNA の出力 1（partial）も確かめた')
})

test('raw: {device, deviceKey, at, ts, line, kind, parsed}。ERXUDP は ECHONET の解釈まで、OK・EVENT も項目に分ける', async () => {
  // 戻すと落ちるもの: raw を行の文字列のまま出す・describeLine を通さない・伏せ字の前の行を使う
  const fake = setup()
  const dev = kit.createDevice(fake, 'json-raw')
  const b = kit.createBroute(fake, 'json-raw', { emitRaw: true })
  await connected(dev)
  await input(b, { topic: 'get', payload: ['E7'] })
  const raws = sentOf(b).filter((o) => o.port === 2 && o.msg.topic === 'raw').map((o) => o.msg)
  assert.ok(raws.length > 10, '生の行が少なすぎる: ' + raws.length)
  for (const m of raws) {
    const p = m.payload
    assert.ok(isPlainObject(p), 'raw の payload がただのオブジェクトではない: ' + typeof p)
    assert.deepEqual(Object.keys(p), ['device', 'deviceKey', 'at', 'ts', 'line', 'kind', 'parsed'])
    assert.equal(p.device, '電力')
    assert.equal(p.deviceKey, dev.deviceKey)
    assert.equal(typeof p.at, 'number')
    assert.match(p.ts, ISO)
    assert.equal(typeof p.line, 'string')
    assert.equal(typeof p.kind, 'string')
    assert.equal(m.device, '電力', '1.x の msg.device も残す')
  }
  const kinds = new Set(raws.map((m) => m.payload.kind))
  for (const k of ['ok', 'event', 'erxudp', 'einfo', 'ever']) assert.ok(kinds.has(k), `kind ${k} が無い（${Array.from(kinds).join(', ')}）`)
  const ex = raws.filter((m) => m.payload.kind === 'erxudp' && m.payload.parsed.echonet).map((m) => m.payload.parsed)
  assert.ok(ex.length, 'ECHONET として読めた ERXUDP')
  const e7 = ex.map((p) => p.echonet.props.find((x) => x.epc === 'E7')).filter(Boolean)
  assert.ok(e7.length, 'ERXUDP の中の E7')
  assert.equal(typeof e7[e7.length - 1].value, 'number', '数は数のまま')
  assert.equal(e7[e7.length - 1].name, '瞬時電力計測値')
  assert.equal(typeof ex[0].rport, 'number')
  const ev = raws.find((m) => m.payload.kind === 'event').payload.parsed
  assert.equal(typeof ev.num, 'number')
  assertNoSecrets(JSON.stringify(raws), 'raw')
  assert.ok(!raws.some((m) => /SKSETPWD|SKSETRBID/.test(m.payload.line) && /[0-9A-F]{12}/.test(m.payload.line.split(' ').pop())), 'SKSET… の値')
})

test('command-result: {device, deviceKey, command, ok, at, ts, lines, parsed, error, result}。FAIL は ok: false の結果のあとに error', async () => {
  // 戻すと落ちるもの: command-result を 1.x の {device, command, result} に戻す・runCommand で行を集めない・
  //                   FAIL のときに結果を出さない・SKSET… の引数を command に写す
  const fake = setup()
  const dev = kit.createDevice(fake, 'json-cmd')
  const b = kit.createBroute(fake, 'json-cmd')
  await connected(dev)

  let r = await input(b, { topic: 'command', payload: 'SKINFO' })
  assert.equal(r.err, null)
  assert.equal(r.sent.length, 1)
  let p = r.sent[0][1].payload
  assert.equal(r.sent[0][1].topic, 'command-result')
  assert.deepEqual(Object.keys(p), ['device', 'deviceKey', 'command', 'ok', 'at', 'ts', 'lines', 'parsed', 'error', 'result'])
  assert.equal(p.device, '電力')
  assert.equal(p.command, 'SKINFO')
  assert.equal(p.ok, true)
  assert.equal(p.error, null)
  assert.equal(typeof p.at, 'number')
  assert.match(p.ts, ISO)
  assert.ok(p.lines.some((l) => /^EINFO /.test(l)) && p.lines.some((l) => /^OK/.test(l)), p.lines.join(' | '))
  assert.ok(!p.lines.some((l) => /^ERXUDP/.test(l)), '電波から届いた別の電文は入れない')
  assert.match(p.parsed.mac, /^[0-9A-F]{16}$/)
  assert.equal(typeof p.parsed.channel, 'number')
  assert.equal(typeof p.parsed.channelMHz, 'number')
  assert.match(p.parsed.panId, /^[0-9A-F]{4}$/)
  assert.equal(typeof p.result, 'object', '1.x の result も残す')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), p)

  r = await input(b, { topic: 'command', payload: 'SKSREG S02' })
  p = r.sent[0][1].payload
  assert.equal(p.parsed.register, 'S02')
  assert.equal(typeof p.parsed.value, 'number')
  assert.equal(typeof p.parsed.channelMHz, 'number')
  r = await input(b, { topic: 'command', payload: 'ROPT' })
  assert.equal(r.sent[0][1].payload.parsed.erxudpFormat, 'hex')
  // 複数行の表（EADDR → IPv6 の行 → OK）も、このコマンドの行として集めて表に分ける
  r = await input(b, { topic: 'command', payload: 'SKTABLE 1' })
  p = r.sent[0][1].payload
  assert.deepEqual(p.lines.slice(0, 1), ['EADDR'])
  assert.equal(p.parsed.name, 'EADDR')
  assert.equal(p.parsed.rows.length, 1, JSON.stringify(p.parsed))
  assert.match(p.parsed.rows[0].ipv6, /^FE80:/)
  r = await input(b, { topic: 'command', payload: 'SKVER' })
  assert.equal(typeof r.sent[0][1].payload.parsed.version, 'string')

  // アダプタが FAIL を返した（ER04 は再試行しない）: 結果（ok: false）→ error。done(err) で Catch に届く
  r = await input(b, { topic: 'command', payload: 'SKFOO 1' })
  assert.ok(r.err)
  assert.deepEqual(r.sent.map((m) => m[1].topic), ['command-result', 'error'])
  p = r.sent[0][1].payload
  assert.equal(p.ok, false)
  assert.equal(p.command, 'SKFOO 1')
  assert.equal(p.parsed, null)
  assert.equal(p.error.code, 'ER04')
  assert.equal(typeof p.error.message, 'string')
  assert.ok(p.lines.some((l) => /^FAIL ER04/.test(l)))
  assert.equal(p.result, undefined, '失敗のときは 1.x の result は無い')
  const e = r.sent[1][1].payload
  assert.equal(e.action, 'command')
  assert.equal(e.code, 'DEVICE_ERROR')
  assert.match(e.ts, ISO)
  // 送る前に断ったもの（FLASH を消耗する）は error だけ
  r = await input(b, { topic: 'command', payload: 'WOPT 00' })
  assert.ok(r.err)
  assert.deepEqual(r.sent.map((m) => m[1].topic), ['error'])
  // 認証情報を書くコマンドの値は command に写さない（シミュレータは架空の値を受け取る）
  r = await input(b, { topic: 'command', payload: 'SKSETPWD C ' + PW })
  assert.equal(r.err, null)
  assert.equal(r.sent[0][1].payload.command, 'SKSETPWD C ********')
  assertNoSecrets(JSON.stringify(b._sent), 'command-result')
})

test('log・phase・event・status・alert・recovered・error: 既存のフローが読む名前と型はそのまま（log の ts はミリ秒の数、ほかの ts は ISO）、at を足す', async () => {
  // 戻すと落ちるもの: log の ts を ISO にする・text / level / device の名前を変える（既存のフローが読む）・
  //                   alert・recovered・error の ts をミリ秒にする
  const fake = setup()
  const dev = kit.createDevice(fake, 'json-log', { simulatorOptions: simOptions(), deviceKey: 'jsonlog' })
  const b = kit.createBroute(fake, 'json-log', { emitLogs: true, alertAfterFailures: 1 })
  await failOnceThenConnect(dev, b)
  await input(b, { topic: 'interval', payload: 5 })
  const of = (t) => sentOf(b).filter((o) => o.port === 2 && o.msg.topic === t).map((o) => o.msg.payload)

  const logs = of('log')
  assert.ok(logs.length > 5)
  for (const l of logs) {
    assert.equal(typeof l.ts, 'number', 'log の ts はミリ秒の数（1.x のまま）')
    assert.equal(l.at, l.ts)
    assert.equal(typeof l.text, 'string')
    assert.equal(typeof l.level, 'string')
    assert.equal(l.device, '電力')
    assert.equal(l.deviceKey, 'jsonlog')
  }
  for (const t of ['status', 'alert', 'recovered', 'error']) {
    const list = of(t)
    assert.ok(list.length, t)
    for (const p of list) {
      assert.match(p.ts, ISO, `${t} の ts は ISO の文字列（1.x のまま）`)
      assert.equal(typeof p.at, 'number', `${t} の at`)
      assert.equal(p.device, '電力')
    }
  }
  const alert = of('alert')[0]
  assert.equal(typeof alert.consecutiveFailures, 'number')
  assert.equal(typeof alert.reason, 'string')
  const err = of('error')[0]
  assert.equal(err.action, 'interval')
  assert.equal(typeof err.message, 'string')
  assert.equal(err.code, 'VALIDATION')
  for (const t of ['phase', 'event']) {
    const list = of(t)
    assert.ok(list.length, t)
    for (const p of list) {
      assert.equal(p.device, '電力')
      assert.equal(p.deviceKey, 'jsonlog')
      assert.equal(typeof p.at, 'number')
      assert.match(p.ts, ISO)
    }
  }
  const ph = of('phase')[0]
  assert.ok('from' in ph && 'to' in ph && 'text' in ph, '1.x の phase の項目')
  const st = of('status')[0]
  assert.ok('health' in st && 'credentials' in st && 'phase' in st)
})

test('diag: 画面の API とフローの出力 2 が同じ形。{ok, name, at, result} に device・command・ts・lines・parsed・error・commands', async () => {
  // 戻すと落ちるもの: service.js の diagPayload を通さない（parsed・command が無い）・info の 3 つをまとめない・
  //                   ECHONET の取得の parsed.values を作らない
  const fake = setup()
  const dev = kit.createDevice(fake, 'json-diag')
  const b = kit.createBroute(fake, 'json-diag')
  await connected(dev)

  let r = await input(b, { topic: 'diag', payload: { name: 'info' } })
  assert.equal(r.err, null)
  let p = r.sent[0][1].payload
  const infoKeys = Object.keys(p).sort()
  assert.equal(p.ok, true)
  assert.equal(p.name, 'info')
  assert.equal(p.command, 'SKINFO / SKVER / SKAPPVER')
  assert.equal(p.device, '電力')
  assert.equal(p.deviceKey, dev.deviceKey)
  assert.match(p.ts, ISO)
  assert.deepEqual(p.lines, p.result.lines, '画面が読む result.lines も残す')
  assert.match(p.parsed.mac, /^[0-9A-F]{16}$/)
  assert.equal(typeof p.parsed.version, 'string')
  assert.equal(p.parsed.appVersion, 'simulator')
  assert.equal(p.error, null)
  assert.deepEqual(p.commands.map((c) => [c.command, c.ok]), [['SKINFO', true], ['SKVER', true], ['SKAPPVER', true]])
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), p)

  r = await input(b, { topic: 'diag', payload: { name: 'sreg', args: { reg: 'SFD' } } })
  p = r.sent[0][1].payload
  assert.equal(p.command, 'SKSREG SFD')
  assert.equal(p.parsed.register, 'SFD')
  assert.equal(typeof p.parsed.value, 'number')
  assert.equal(p.parsed.unit, 'ms')

  r = await input(b, { topic: 'diag', payload: { name: 'epc', args: { epcs: ['E7', 'E8'] } } })
  p = r.sent[0][1].payload
  assert.equal(p.command, 'Get E7 E8')
  assert.equal(typeof p.parsed.values.E7.value, 'number')
  assert.equal(p.parsed.values.E7.epc, '0xE7')
  assert.deepEqual(p.commands, [])
  assert.equal(p.result.values.length, 2)

  // 画面の API も同じ形（足した項目と、今までの result）
  const api = await fake.request('POST', B + '/adapters/json-diag/diag', { body: { name: 'info' } })
  assert.equal(api.statusCode, 200, api.text)
  assert.equal(api.body.command, 'SKINFO / SKVER / SKAPPVER')
  assert.match(api.body.parsed.mac, /^[0-9A-F]{16}$/)
  assert.ok(api.body.result.lines.some((l) => /^EVER/.test(l)))
  assert.deepEqual(Object.keys(api.body).sort(), infoKeys)
  assert.deepEqual(infoKeys, ['at', 'command', 'commands', 'device', 'deviceKey', 'error', 'lines', 'name', 'ok', 'parsed', 'result', 'ts'])
})

test('出力 1: 壊れた電文（EDT が短い）でも、payload に undefined の項目を残さない（送る直前の plain()）', async () => {
  // 戻すと落ちるもの: send1 で plain() を通さない（normalize が rawCount・timestamp の無い値から raw: undefined・at: undefined を作る）
  const EL = require('../../lib/echonet')
  const fake = setup()
  const dev = kit.createDevice(fake, 'json-broken')
  const b = kit.createBroute(fake, 'json-broken')
  await connected(dev)
  const now = Date.now()
  // 実際の decode の結果（長さが足りないと value: null・note: '長さ不足' で、rawCount・timestamp・collectDay が無い）
  const values = [
    EL.decode(0xe0, Buffer.from('00', 'hex')),
    EL.decode(0xea, Buffer.from('07EA', 'hex')),
    EL.decode(0xe2, Buffer.from('00', 'hex')),
    EL.decode(0xe7, Buffer.from('000002EE', 'hex')),
  ]
  assert.ok(values.every((v) => v.epc !== undefined))
  const known = {}
  for (const v of values) known['0x' + EL.hex2(v.epc)] = Object.assign({}, v, { at: now })
  const before = b._sent.length
  dev.sequencer.emit('measurement', { values, known, ts: now, esv: undefined, purpose: 'poll' })
  const sent = b._sent.slice(before).filter((m) => m[0])
  assert.equal(sent.length, 1, '出力 1 に 1 通')
  const p = sent[0][0].payload
  assert.ok(isPlainObject(p))
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), p)
  assert.equal(p.values.instantPower.value, 750)
  assert.equal(p.values.cumulativeForward.value, null)
  assert.ok(!('raw' in p.values.cumulativeForward), 'undefined の項目は持たない')
  assert.ok(!('esv' in p), 'undefined の項目は持たない')
})
