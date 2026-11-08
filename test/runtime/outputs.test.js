'use strict'

// lib/runtime/outputs.js: 出力の payload の形と、コマンドの間に受け取った行の集め方。
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const O = require('../../lib/runtime/outputs')
const SK = require('../../lib/sk-protocol')
const { createLineDescriber } = require('../../lib/sk-results')
const { Sequencer } = require('../../lib/sequencer')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/

function roundTrips(x) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(x)), x)
}

test('stamp: at はミリ秒の数、ts はローカルの時差つきの ISO 8601（出力 1 の ts と同じ書き方）', () => {
  const t = O.stamp(Date.UTC(2026, 10, 6, 0, 0, 0))
  assert.equal(t.at, Date.UTC(2026, 10, 6, 0, 0, 0))
  assert.match(t.ts, ISO)
  assert.equal(new Date(t.ts).getTime(), t.at)
  assert.equal(typeof O.stamp().at, 'number', '省くと今')
  assert.equal(typeof O.stamp(NaN).at, 'number')
})

test('maskCommand: SKSET… の最後の引数を伏せ、伏せ字の関数も通す', () => {
  // 戻すと落ちるもの: maskCommand で SKSET… の引数を伏せない
  assert.equal(O.maskCommand('SKSETPWD C ' + PW), 'SKSETPWD C ********')
  assert.equal(O.maskCommand('skSetRbid ' + ID), 'skSetRbid ********')
  assert.equal(O.maskCommand('  SKINFO  '), 'SKINFO')
  assert.equal(O.maskCommand('SKSREG S02'), 'SKSREG S02')
  assert.equal(O.maskCommand('SKSENDTO x ' + PW, (s) => s.split(PW).join('********')), 'SKSENDTO x ********')
  assert.equal(O.maskCommand(null), '')
})

test('maskCommand: 値のあとに引数が多くても値を残さない（失敗の command-result にも出ない）', () => {
  // 最後の引数だけを伏せていたので、「SKSETPWD C <値> X」の <値> が出力 2 の command に平文で残った。
  // 戻すと落ちるもの: outputs.js の maskCommand で SK.maskSecretCommand を使わず、最後の引数だけを伏せる
  for (const [input, value, want] of [
    ['SKSETPWD C ' + PW + ' X', PW, 'SKSETPWD C ********'],
    ['SKSETRBID ' + ID + ' 1', ID, 'SKSETRBID ********'],
    ['  sksetpwd  C  ' + PW + '  X  Y  ', PW, 'sksetpwd C ********'],
  ]) {
    const masked = O.maskCommand(input)
    assert.equal(masked, want)
    assert.equal(masked, SK.maskSecretCommand(input), 'ログと lastError と同じ伏せ方')
    const out = O.commandPayload({ device: '電力', deviceKey: 'usb0', command: masked, lines: ['FAIL ER06'], ok: false })
    assert.equal(out.ok, false)
    assert.ok(!JSON.stringify(out).includes(value), JSON.stringify(out))
  }
})

test('rawPayload: {device, deviceKey, at, ts, line, kind, parsed}。複数行の表は describer で続きの行まで分ける', () => {
  // 戻すと落ちるもの: rawPayload で describeLine を通さない・describer の文脈を使わない
  const d = createLineDescriber()
  const base = { device: '電力', deviceKey: 'usb0', at: 1000, describer: d }
  const head = O.rawPayload(Object.assign({ line: 'EADDR' }, base))
  assert.deepEqual(Object.keys(head), ['device', 'deviceKey', 'at', 'ts', 'line', 'kind', 'parsed'])
  assert.equal(head.kind, 'etable')
  assert.equal(head.at, 1000)
  assert.match(head.ts, ISO)
  const row = O.rawPayload(Object.assign({ line: 'FE80:0000:0000:0000:021D:1290:1234:5678' }, base))
  assert.equal(row.kind, 'etable', '表の続きの行（describer が無ければ ipv6 になる）')
  assert.equal(row.parsed.part, 'row')
  const ok = O.rawPayload(Object.assign({ line: 'OK' }, base))
  assert.equal(ok.kind, 'ok')
  const alone = O.rawPayload({ device: null, deviceKey: null, line: 'FE80:0000:0000:0000:021D:1290:1234:5678' })
  assert.equal(alone.kind, 'ipv6')
  const ev = O.rawPayload({ device: '電力', deviceKey: 'usb0', line: 'EVENT 25 FE80:0000:0000:0000:021D:1290:1234:5678 0' })
  assert.equal(ev.kind, 'event')
  assert.equal(ev.parsed.num, 0x25)
  // ESREG は実行中の SKSREG の文脈で意味が付く
  const reg = O.rawPayload({ device: '電力', deviceKey: 'usb0', line: 'ESREG 3B', ctx: { command: 'SKSREG S02' } })
  assert.equal(reg.parsed.register, 'S02')
  assert.equal(reg.parsed.value, 0x3b)
  for (const x of [head, row, ok, alone, ev, reg]) roundTrips(x)
})

test('lineContext: 係数・単位と、実行中の SKSREG だけを渡す（ほかのコマンドは渡さない）。実行中のものは sequencer の currentCommand() で読む', () => {
  // 前は seq._current を外から直に読んでいた
  let cur = 'SKSREG SFD'
  const seq = { state: { calibration: { coefficient: 1, unitFactor: 0.1 } }, currentCommand: () => cur }
  assert.deepEqual(O.lineContext(seq), { coefficient: 1, unitFactor: 0.1, command: 'SKSREG SFD' })
  cur = 'SKSETPWD C ********'
  assert.deepEqual(O.lineContext(seq), { coefficient: 1, unitFactor: 0.1 })
  seq.state.calibration = { coefficient: null, unitFactor: null }
  cur = null
  assert.deepEqual(O.lineContext(seq), {})
  assert.deepEqual(O.lineContext(null), {})
  // 本物の sequencer の currentCommand() は秘密の引数を伏せる（伏せていなくても SKSREG 以外は渡さない）
  const real = new Sequencer(new EventEmitter(), {})
  real._current = { command: 'SKSREG S02', secret: false }
  assert.equal(O.lineContext(real).command, 'SKSREG S02')
  real._current = { command: 'SKSETPWD C ' + PW }
  assert.equal(O.lineContext(real).command, undefined)
  real._current = null
})

test('commandPayload: 成否は sequencer の結果を優先し、失敗の error は FAIL の行から（無ければ例外から）', () => {
  // 戻すと落ちるもの: commandStep で sequencer の成否を使わない・行に FAIL が無いときに error を作らない
  const ok = O.commandPayload({
    device: '電力',
    deviceKey: 'usb0',
    command: 'SKVER',
    lines: ['EVER 1.5.2', 'OK'],
    ok: true,
    result: { version: '1.5.2', x: undefined },
    at: 5,
  })
  assert.deepEqual(Object.keys(ok), ['device', 'deviceKey', 'command', 'ok', 'at', 'ts', 'lines', 'parsed', 'error', 'result'])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.parsed, { version: '1.5.2' })
  assert.equal(ok.error, null)
  assert.deepEqual(ok.result, { version: '1.5.2' }, 'result も JSON の往復で変わらない形に')
  roundTrips(ok)
  const fail = O.commandPayload({ device: '電力', deviceKey: 'usb0', command: 'SKFOO', lines: ['FAIL ER04'], ok: false })
  assert.equal(fail.ok, false)
  assert.equal(fail.parsed, null)
  assert.equal(fail.error.code, 'ER04')
  assert.equal(fail.result, undefined)
  roundTrips(fail)
  const to = O.commandPayload({
    device: '電力',
    deviceKey: 'usb0',
    command: 'SKINFO',
    lines: [],
    ok: false,
    err: Object.assign(new Error('タイムアウト (2秒)'), { timeout: true }),
  })
  assert.equal(to.error.code, 'NO_RESPONSE', '行に成否が無ければ「応答なし」')
  // 行を集め損ねても、sequencer が成功と言ったものを失敗と書かない
  const lost = O.commandStep('SKINFO', [], true)
  assert.equal(lost.ok, true)
  assert.equal(lost.error, null)
  // 行に OK があっても、sequencer が失敗と言ったら失敗（error は例外から）
  const aborted = O.commandStep('SKVER', ['EVER 1', 'OK'], false, new Error('取り消し'))
  assert.equal(aborted.ok, false)
  assert.equal(aborted.error.code, 'FAILED')
  assert.equal(aborted.error.message, '取り消し')
})

test('logPayload: ts はミリ秒の数のまま（既存のフローが読む）。at を足し、device・deviceKey を前に', () => {
  // 戻すと落ちるもの: logPayload で ts を ISO にする・at を足さない
  const p = O.logPayload({ level: 'info', text: 'フェーズ: idle → opening', phase: 'opening', ts: 1234 }, { device: '電力', deviceKey: 'usb0' })
  assert.deepEqual(p, { device: '電力', deviceKey: 'usb0', level: 'info', text: 'フェーズ: idle → opening', phase: 'opening', ts: 1234, at: 1234 })
  const q = O.logPayload({ level: 'warn', text: 'x', extra: undefined }, { device: null })
  assert.equal(typeof q.ts, 'number')
  assert.equal(q.at, q.ts)
  assert.ok(!('extra' in q))
  roundTrips(q)
})

test('eventPayload: 1.x の項目の前に device・deviceKey、後ろに at・ts（持っていれば上書きしない）', () => {
  const p = O.eventPayload({ from: 'idle', to: 'opening', reason: null, text: 'ポートを開いています' }, { device: '電力', deviceKey: 'usb0', at: 99 })
  assert.deepEqual(Object.keys(p), ['device', 'deviceKey', 'from', 'to', 'reason', 'text', 'at', 'ts'])
  assert.equal(p.at, 99)
  const e = O.eventPayload({ kind: 'event', num: 0x25, side: undefined }, { device: '電力', deviceKey: 'usb0' })
  assert.ok(!('side' in e))
  roundTrips(e)
})

/**
 * sequencer の raw(command, {onLine}) と同じ約束の偽物: 1 本ずつ実行し、受け取った行は 'raw' に出してから
 * 実行中の項目の onLine に渡す（sequencer の _onLine と同じ順）。
 */
function fakeSeq() {
  const seq = new EventEmitter()
  const queue = []
  let current = null
  seq.raw = (cmd, opts) =>
    new Promise((resolve, reject) => {
      queue.push({ command: cmd, onLine: opts && opts.onLine, resolve, reject })
      if (!current) current = queue.shift()
    })
  seq.line = (text) => {
    seq.emit('raw', text)
    if (current && current.onLine) current.onLine(text)
  }
  seq.finish = (ok, value) => {
    const it = current
    current = queue.shift() || null
    if (ok) it.resolve(value)
    else it.reject(value)
  }
  return seq
}

test('runCommand: そのコマンドが実行中の間に受け取った行だけを集める（前のコマンド・ERXUDP・終わったあとの行は入れない）。伏せ字を通す', async () => {
  // 戻すと落ちるもの: runCommand で raw に onLine を渡さない・ERXUDP を入れる・redact を通さない
  const seq = fakeSeq()
  const first = seq.raw('SKVER') // 先に実行中のもの（sequencer 自身のコマンドのつもり）
  const p = O.runCommand(seq, 'SKINFO', (s) => s.split(ID).join('********'))
  seq.line('EVER 1.5.2') // 前のコマンドの行
  seq.line('OK')
  seq.finish(true, { version: '1.5.2' })
  await first
  seq.line('EINFO FE80:0000:0000:0000:021D:1290:1234:5678 001D129012345678 21 FFFF 0 ' + ID)
  seq.line('ERXUDP FE80:0000:0000:0000:021D:1290:1234:5678 FF02:0000:0000:0000:0000:0000:0000:0001 0E1A 0E1A 001D129012345678 1 0 0002 0102')
  seq.line('OK')
  seq.finish(true, { mac: '001D129012345678' })
  seq.line('EVENT 21 FE80 0 00') // 終わったあと
  const r = await p
  assert.deepEqual(r.lines, ['EINFO FE80:0000:0000:0000:021D:1290:1234:5678 001D129012345678 21 FFFF 0 ********', 'OK'])
  assert.deepEqual(r.result, { mac: '001D129012345678' })
  assert.equal(seq.listenerCount('raw'), 0, 'sequencer の raw イベントには受け手を付けない（前は付けて外していた）')

  // 失敗: 集めた行を err.lines に付けて投げる
  const p2 = O.runCommand(seq, 'SKFOO')
  seq.line('FAIL ER04')
  const e = Object.assign(new Error('ER04'), { code: 'ER04' })
  seq.finish(false, e)
  await assert.rejects(p2, (err) => err === e && err.lines.length === 1 && err.lines[0] === 'FAIL ER04')
  assert.equal(seq.listenerCount('raw'), 0)

  // 送る前に断られた（約束がすぐ失敗）: 行は空
  seq.raw = () => Promise.reject(new Error('WOPT は FLASH を消耗するため command からは実行できません'))
  await assert.rejects(O.runCommand(seq, 'WOPT 01'), (err) => Array.isArray(err.lines) && err.lines.length === 0)
  assert.equal(seq.listenerCount('raw'), 0)
})

test('runCommand: 本物の sequencer で、前に積まれたコマンドの行を混ぜず、自分のコマンドの行だけを集める（raw の onLine）', async () => {
  // 前は sequencer の _queue・_current を外から覗いて自分の項目を探していた。
  // 戻すと落ちるもの: sequencer.js の _send で onLine を項目に入れない・_onLine で実行中の項目の onLine を呼ばない
  class Port extends EventEmitter {
    constructor() {
      super()
      this.isOpen = true
      this.writes = []
    }
    open() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
    write(b) {
      this.writes.push(String(b))
      return Promise.resolve()
    }
  }
  const port = new Port()
  const seq = new Sequencer(port, { commandTimeout: 1000, commandMaxTries: 1 })
  seq.state.portOpen = true
  port.on('line', (l) => seq._onLine(l))
  const first = seq.raw('SKVER')
  const p = O.runCommand(seq, 'SKAPPVER')
  // 前のコマンド（SKVER）の応答
  seq._onLine('EVER 1.5.2')
  seq._onLine('OK')
  await first
  // 自分のコマンド（SKAPPVER）の応答
  seq._onLine('EAPPVER rev1.0')
  seq._onLine('OK')
  const r = await p
  assert.deepEqual(r.lines, ['EAPPVER rev1.0', 'OK'])
  assert.deepEqual(port.writes, ['SKVER\r', 'SKAPPVER\r'])
  seq.removeAllListeners()
})
