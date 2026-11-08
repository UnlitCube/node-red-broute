'use strict'

// lib/sequencer.js に足した 2 つ: setBaseline(partial) と diagRead(command)。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Sequencer } = require('../../lib/sequencer')
const { createRegistry } = require('../../lib/runtime/registry')
const { makeAdapter, connect } = require('./adapter-kit')
const { ID, PW, waitFor } = require('./fake-red')

// 試験が途中で落ちても片付ける。回ったままの sequencer を残すと、Node 18 では試験のファイルが終わらない
const live = []
afterEach(async () => {
  for (const s of live.splice(0)) await s.destroy().catch(() => {})
})

test('setBaseline は基準と効いている値の両方を変え、再接続しない', async () => {
  const { seq, transport } = makeAdapter(createRegistry(), 'sb1', { seq: { pollIntervalSec: 30, minTierIntervalSec: 1 } })
  live.push(seq)
  await connect(seq)
  const sentBefore = transport.sent.length
  const reconnects = seq.state.counters.reconnects
  const statuses = []
  seq.on('status', (s) => statuses.push(s))

  const out = seq.setBaseline({ pollIntervalSec: 60, pollEpcs: ['E7', '0xE8'], slowIntervalSec: 600, halfHourIntervalSec: 900 })
  assert.deepEqual(out, { pollIntervalSec: 60, pollEpcs: [0xe7, 0xe8], slowIntervalSec: 600, halfHourIntervalSec: 900 })
  assert.equal(seq.options.pollIntervalSec, 60)
  assert.equal(seq._baseline.pollIntervalSec, 60)
  assert.deepEqual(seq._baseline.pollEpcs, [0xe7, 0xe8])
  assert.equal(seq.options.slowIntervalSec, 600)
  assert.equal(seq.options.halfHourIntervalSec, 900)
  assert.ok(statuses.length >= 1, '状態を配る')
  assert.ok(seq._pollTimer, '取得の予定を組み直す')
  assert.ok(seq._tierTimers.slow && seq._tierTimers.halfHour)

  await new Promise((r) => setTimeout(r, 100))
  assert.equal(seq.state.counters.reconnects, reconnects, '再接続しない')
  assert.ok(
    !transport.sent.slice(sentBefore).some((c) => /^(SKRESET|SKTERM|SKJOIN|SKREJOIN|SKSCAN)/.test(c)),
    '接続の手順のコマンドを送らない'
  )
  assert.equal(seq.isConnected, true)
  await seq.destroy()
})

test('外部の上書きが掛かっている項目は、基準だけ変えて、上書きを外すと新しい基準へ戻る', async () => {
  const seq = new Sequencer(new EventEmitter(), { pollIntervalSec: 30, minPollIntervalSec: 15 })
  seq.setPollInterval(120, { external: true })
  seq.setPollEpcs(['E0'], { external: true })
  seq.setBaseline({ pollIntervalSec: 45, pollEpcs: ['E7', 'E8'] })
  assert.equal(seq.options.pollIntervalSec, 120, '上書き中は効いている値を変えない')
  assert.deepEqual(seq.options.pollEpcs, [0xe0])
  assert.equal(seq._baseline.pollIntervalSec, 45)
  seq.resetOverride('pollIntervalSec')
  assert.equal(seq.options.pollIntervalSec, 45, '上書きを外すと新しい基準')
  seq.resetOverrides('試験')
  assert.deepEqual(seq.options.pollEpcs, [0xe7, 0xe8])
  await seq.destroy()
})

test('下限で丸める・空や不正な値は無視する', async () => {
  const seq = new Sequencer(new EventEmitter(), { pollIntervalSec: 30, minPollIntervalSec: 15, minTierIntervalSec: 30 })
  const logs = []
  seq.on('log', (l) => logs.push(l.text))
  seq.setBaseline({ pollIntervalSec: 5, slowIntervalSec: 10 })
  assert.equal(seq.options.pollIntervalSec, 15)
  assert.equal(seq.options.slowIntervalSec, 30)
  assert.ok(logs.some((t) => /下限は 15 秒/.test(t)))
  const before = JSON.stringify(seq.options)
  seq.setBaseline({ pollIntervalSec: null, pollEpcs: [], halfHourIntervalSec: 'abc' })
  seq.setBaseline(undefined)
  assert.equal(JSON.stringify(seq.options), before)
  await seq.destroy()
})

test('diagRead は許可したコマンドだけを送り、受け取った行を返す', async () => {
  const { seq, transport } = makeAdapter(createRegistry(), 'dr1')
  live.push(seq)
  await connect(seq)
  const rawListeners = seq.listenerCount('raw')
  const info = await seq.diagRead('skinfo')
  assert.equal(info.command, 'SKINFO')
  assert.ok(info.lines.some((l) => /^EINFO /.test(l)), info.lines.join(' | '))
  assert.ok(info.lines.includes('OK'))
  const ver = await seq.diagRead('SKVER')
  assert.ok(ver.lines.some((l) => /^EVER /.test(l)))
  const ropt = await seq.diagRead('ROPT')
  assert.ok(ropt.lines.some((l) => /^OK /.test(l)))
  const table = await seq.diagRead('SKTABLE 2')
  assert.ok(table.lines.includes('ENEIGHBOR'))
  const reg = await seq.diagRead('SKSREG S02')
  assert.ok(reg.lines.some((l) => /^ESREG /.test(l)))
  assert.equal(seq.listenerCount('raw'), rawListeners, '終わったら受け手を外す')

  for (const bad of ['SKSREG S02 21', 'SKSREG SFE 1', 'SKRESET', 'SKSETPWD C ' + PW, 'WOPT 01', 'SKTERM', 'SKSREG S99', 'SKTABLE 3', '', 'SKINFO; SKRESET']) {
    await assert.rejects(() => seq.diagRead(bad), (e) => e.code === 'FORBIDDEN_COMMAND' && e.forbidden === true, bad)
  }
  assert.ok(!transport.sent.some((c) => /^SKSREG S02 21|^SKSREG S99|^SKTABLE 3/.test(c)), '許可していないものは送らない')
  await seq.destroy()
})

test('diagRead の行から認証 ID とパスワードを伏せ、ERXUDP は入れない', async () => {
  // 応答に秘密が混ざる個体を真似る偽の transport
  const t = new EventEmitter()
  t.write = (buf) => {
    const line = String(buf).trim()
    if (line === 'SKINFO') {
      setTimeout(() => {
        t.emit('line', `EINFO ${ID} ${PW.toLowerCase()}\r\n`)
        t.emit('line', 'ERXUDP FE80::1 FE80::2 0E1A 0E1A 001D 1 0 0004 00000000\r\n')
        t.emit('line', 'OK\r\n')
      }, 5)
    }
    return Promise.resolve()
  }
  t.open = () => Promise.resolve()
  t.close = () => Promise.resolve()
  const seq = new Sequencer(t, {})
  seq.setCredentials(ID, PW, 'test')
  seq.state.portOpen = true
  const r = await seq.diagRead('SKINFO')
  const text = r.lines.join('\n')
  assert.ok(!text.includes(ID) && !text.toLowerCase().includes(PW.toLowerCase()), text)
  assert.match(text, /EINFO \*{8} \*{8}/)
  assert.ok(!/ERXUDP/.test(text))
  await seq.destroy()
})

// 落ちたときも sequencer を必ず畳む（畳まないとタイマーが残り、試験のプロセスが終わらない）
test('diagRead が FAIL で終わったら、それまでの行を付けて投げる', async () => {
  // シミュレーターの fail.sreg で、SFD の読み出しに FAIL ER06 を返させる（実機の古いファームの再現）
  const { seq } = makeAdapter(createRegistry(), 'dr2', { sim: { fail: { sreg: ['SFD'] } } })
  try {
    await connect(seq)
    await assert.rejects(
      () => seq.diagRead('SKSREG SFD'),
      (e) => e.code === 'ER06' && Array.isArray(e.lines) && e.lines.some((l) => /^FAIL ER06/.test(l))
    )
    await waitFor(() => !seq._current, 2000, 'キューが空く')
  } finally {
    await seq.destroy()
  }
})

test('診断の失敗は warn の 1 行だけ。error を出さず、lastError・失敗の数・健康の判定に混ぜない', async () => {
  // dev で SKSREG SFD が FAIL ER06 を返すと、アダプタのログに error が 2 行
  // （「ER06 は再試行しても変わりません…」と「失敗: SKSREG SFD …」）出て、Node-RED のログの error にも出ていた。
  // 通常の手順（接続・取得）の失敗のログの水準は変えない（下の 2 つ目の確かめ）。
  // 戻すと落ちるもの: sequencer.js の _fail で diag の項目を見分けるのをやめる・diagRead が diag の印を付けるのをやめる
  const { seq, transport } = makeAdapter(createRegistry(), 'dr3', { sim: { fail: { sreg: ['SFD'] } } })
  try {
    await connect(seq)
    const logs = []
    seq.on('log', (l) => logs.push(l))
    const lastError = seq.state.lastError
    const failures = seq.state.counters.failures
    await assert.rejects(() => seq.diagRead('SKSREG SFD'), (e) => e.code === 'ER06')
    await waitFor(() => !seq._current, 2000, 'キューが空く')
    const shown = logs.filter((l) => l.level !== 'tx' && l.level !== 'rx' && l.level !== 'debug')
    assert.equal(shown.filter((l) => l.level === 'error').length, 0, 'error を出さない: ' + shown.map((l) => `[${l.level}] ${l.text}`).join(' | '))
    const warns = shown.filter((l) => l.level === 'warn')
    assert.equal(warns.length, 1, 'warn は 1 行: ' + warns.map((l) => l.text).join(' | '))
    assert.match(warns[0].text, /診断/)
    assert.match(warns[0].text, /SKSREG SFD/)
    assert.match(warns[0].text, /ER06/)
    assert.equal(seq.state.lastError, lastError, 'lastError に入れない')
    assert.equal(seq.state.counters.failures, failures, '失敗の数に入れない')
    assert.equal(seq.isConnected, true)

    // 通常の手順の失敗は今までどおり error（raw() で同じコマンドを送る）
    logs.length = 0
    await assert.rejects(() => seq.raw('SKSREG SFD'), (e) => e.code === 'ER06')
    assert.ok(logs.some((l) => l.level === 'error' && /失敗: SKSREG SFD/.test(l.text)), '診断以外の失敗は error のまま')
    assert.notEqual(seq.state.lastError, lastError, '診断以外の失敗は lastError に入る')
    assert.ok(transport.sent.filter((c) => c === 'SKSREG SFD').length >= 2)
  } finally {
    await seq.destroy()
  }
})

test('診断で SKSREG SFD を読んだら、送信積算（txBudgetMs）にも入れる（概要の「送信積算」が埋まる）', async () => {
  // 送信積算は、PANA が通らないときの見張り（_guardTxBudget）でしか読んでいなかったので、
  // 普通に繋がっている台（dev のシミュレーターも）では null のままだった。診断の読み出しでも埋める。
  // 戻すと落ちるもの: diagRead で SFD の値を state.txBudgetMs に入れるのをやめる
  const { h, seq } = makeAdapter(createRegistry(), 'dr4')
  try {
    await connect(seq)
    assert.equal(seq.snapshot().txBudgetMs, null, '前提: まだ読んでいない')
    await seq.get([0xe7], 'test')
    const statuses = []
    seq.on('status', (s) => statuses.push(s.txBudgetMs))
    const r = await seq.diagRead('SKSREG SFD')
    const line = r.lines.find((l) => /^ESREG /.test(l))
    assert.ok(line, r.lines.join(' | '))
    const ms = parseInt(line.split(' ')[1], 16)
    assert.ok(ms > 0, 'ECHONET を送ったぶん積算が増えている: ' + line)
    assert.equal(seq.snapshot().txBudgetMs, ms)
    assert.ok(statuses.indexOf(ms) >= 0, '状態を配る（SSE の adapter で画面が更新される）')
    const vm = require('../../lib/runtime/view-model')
    assert.equal(vm.buildSummary(h.inspect(), Date.now()).txBudgetMs, ms, 'AdapterSummary の txBudgetMs に出る')
    // 送るたびに増える
    await seq.get([0xe7], 'test')
    const r2 = await seq.diagRead('SKSREG SFD')
    assert.ok(seq.snapshot().txBudgetMs > ms, r2.lines.join(' | '))
    // ほかのレジスタの読み出しでは変えない
    const before = seq.snapshot().txBudgetMs
    await seq.diagRead('SKSREG S16')
    assert.equal(seq.snapshot().txBudgetMs, before)
  } finally {
    await seq.destroy()
  }
})
