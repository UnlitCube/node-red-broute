'use strict'

// シミュレーターを相手に、接続シーケンス全体と異常系を通しで確かめる。
// 実機は要らない。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Sequencer } = require('../lib/sequencer')
const { SimulatorTransport } = require('../lib/simulator-transport')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'

// 試験が途中で落ちても片付ける。回ったままの sequencer を残すと、Node 18 では試験のプロセスが終わらない
const live = []
afterEach(async () => {
  for (const s of live.splice(0)) await s.destroy().catch(() => {})
})

/** 条件が満たされるまで待つ。満たされなければ例外。壁時計は飛ぶことがあるので、単調な時計で測る。 */
async function waitFor(fn, timeoutMs, what) {
  const limit = performance.now() + (timeoutMs || 5000)
  while (performance.now() < limit) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('待ち時間を超えました: ' + (what || '条件'))
}

/**
 * 接続し、接続直後の係数取得まで終わるのを待つ。
 * 失敗したときは、どこで止まったかが分かるように直近のログを出す。
 */
async function waitReady(seq, ms, logs) {
  try {
    await waitFor(() => seq.isConnected, ms || 8000, '接続')
    // 接続直後に「変わらないもの」を一括で取りに行く (係数・単位・
    // プロパティマップ・製造番号など)。その要求と重ならないよう、
    // 全部終わって静かになるまで待ってから次へ進む。
    await waitFor(() => seq.snapshot().calibration.unitFactor !== null, ms || 8000, '係数の取得')
    await waitFor(
      () => seq._requestDepth === 0 && !seq._current && seq._queue.length === 0,
      ms || 8000,
      '接続時の一括取得'
    )
  } catch (e) {
    const s = seq.snapshot()
    const tail = (logs || []).slice(-15).map((l) => `  [${l.level}] ${l.text}`).join('\n')
    throw new Error(
      `${e.message}\n  phase=${s.phase} portOpen=${s.portOpen} queued=${s.queued} current=${s.current}\n${tail}`
    )
  }
}

/** テスト用に、待ち時間を詰めたシーケンサー一式を作る。 */
function build(simConfig, seqOptions) {
  const transport = new SimulatorTransport(
    // PairID は認証 ID の下位 8 文字。
    // 実機と同じ関係にしておかないと、メーターの選別が試せない。
    Object.assign({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8) }, simConfig)
  )
  const seq = new Sequencer(
    transport,
    Object.assign(
      {
        resetSettleMs: 20,
        scanDurations: [4, 5],
        scanRounds: 1,
        pollIntervalSec: 1,
        minPollIntervalSec: 1,
        commandTimeout: 2000,
        joinTimeout: 3000,
        sendTimeout: 2000,
        joinRetryMs: 50,
        // 粘りの時間も詰める。製品の既定 (バースト間 15〜120 秒 / 30 分粘る)
        // をそのまま使うと、SKJOIN が 1 回失敗するだけでテストが 30 分待つ。
        joinBurstBackoffMs: [60],
        joinPersistMs: 2500,
        credentialHintAfterMs: 800,
        txBudgetGuard: false, // SKSREG SFD の往復をテストでは挟まない
      },
      seqOptions
    )
  )
  seq.setCredentials(ID, PW, 'test')
  const logs = []
  seq.on('log', (l) => logs.push(l))
  live.push(seq)
  return { transport, seq, logs }
}

test('接続シーケンスが最後まで通り、係数まで取得する', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  const s = seq.snapshot()
  assert.equal(s.phase, 'connected')
  assert.equal(s.meter.panid, '1234')
  assert.equal(s.meter.channel, 59)
  assert.equal(s.calibration.coefficient, 1)
  assert.equal(s.calibration.unitFactor, 0.1)
  assert.equal(s.counters.failures, 0, '失敗が無いこと')

  // 送ったコマンドの順序が仕様どおりか
  const sent = transport.sent.filter((c) => c !== '')
  // 通電したままのモジュールに残ったセッションを畳んでからリセットする。無ければ ER10 で返るだけで、失敗には数えない
  const order = ['SKTERM', 'SKRESET', 'SKSREG SFE 0', 'SKSREG SF0 0', 'SKSREG SA2 1', 'SKVER', 'SKINFO', 'ROPT']
  order.forEach((cmd, i) => assert.equal(sent[i], cmd, `${i} 番目は ${cmd}`))
  assert.ok(sent.some((c) => c.startsWith('SKSETPWD C ')), 'SKSETPWD の <LEN> は 16 進の C')
  assert.ok(sent.some((c) => c === 'SKSETRBID ' + ID))
  assert.ok(sent.some((c) => c.startsWith('SKLL64 ')))
  assert.ok(sent.some((c) => c.startsWith('SKJOIN ')))

  await seq.destroy()
})

test('EVENT 25 だけでは接続済みにせず、疎通確認が通って初めて connected になる', async () => {
  // メーターが ECHONET に応答しない状況。PANA は通る。
  const { seq, logs } = build({ fail: { noEchonetResponse: 99 } }, { sendTimeout: 300, scanRounds: 1 })
  const phases = []
  seq.on('phase', (p) => phases.push(p.to))
  await seq.start()
  await waitFor(() => phases.includes('verifying'), 8000, 'verifying へ到達')
  // 疎通確認が通らないので connected にはならない
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(seq.isConnected, false, 'ECHONET が返らないうちは接続済みにしない')
  await seq.destroy()
})

test('SKJOIN が 2 回失敗しても 3 回目で接続できる', async () => {
  const { seq, logs } = build({ fail: { join: 2 } })
  await seq.start()
  await waitReady(seq, 10000)
  assert.equal(seq.snapshot().counters.joins, 1)
  assert.ok(
    logs.some((l) => /メーターとの認証が通りませんでした（1 巡目 1\/3・[\d.]+ 秒）/.test(l.text)),
    '1 回目の失敗が、巡目と所要時間つきでログに残ること'
  )
  await seq.destroy()
})

test('SKJOIN が繰り返し失敗したら、認証情報を疑うよう促す (ただし止めない)', async () => {
  const { seq, logs } = build(
    { fail: { join: 99 } },
    { scanRounds: 1, credentialHintAfterMs: 0, joinBurstBackoffMs: [50], joinRetryMs: 10, joinTimeout: 1500 }
  )
  await seq.start()
  await waitFor(
    () => logs.some((l) => /認証 ID かパスワードが誤っている可能性/.test(l.text)),
    15000,
    '認証情報を促すログ'
  )
  // 促すだけで、あきらめない (マニュアル 3.4 の「エラー時の処理」は
  // 人への確認指示であって、接続をやめろとは書かれていない)。
  const hint = logs.find((l) => /認証 ID かパスワードが誤っている/.test(l.text))
  assert.ok(/自動運転は止めません/.test(hint.text), 'あきらめないことを明記すること')
  assert.ok(/メーター自体は見つかっており/.test(hint.text), '断定しないこと')
  await seq.destroy()
})

test('EVENT 24 のあとも段階を上げずに同じアドレスへ撃ち直す', async () => {
  const { seq, transport, logs } = build(
    { fail: { join: 99 } },
    { scanRounds: 1, joinBurstBackoffMs: [40], joinRetryMs: 10, joinTimeout: 1500, credentialHintAfterMs: 999999 }
  )
  await seq.start()

  // 3 回 (1 バースト) で見切らず、2 巡目へ進むこと
  await waitFor(() => seq.state.join.burst >= 2, 15000, '2 巡目')
  // 粘っている間は段階を上げない。初回接続の途中なので 0 のまま居られるのが正しい。
  assert.ok(seq.state.ladder < 2, `SKRESET (段階 3) まで飛ばさないこと (実際: ${seq.state.ladder})`)
  assert.ok(
    logs.some((l) => /2 巡目の SKJOIN を送ります（段は上げません）/.test(l.text)),
    '粘っていることがログに残ること'
  )
  // 2 巡目の前に SKTERM を入れる (相手に残ったセッション対策)
  assert.ok(transport.sent.some((c) => /^SKTERM/.test(c)), 'SKJOIN の前にセッションを畳むこと')
  await seq.destroy()
})

test('接続したまま閉じるときは SKTERM してから閉じる', async () => {
  // 残したまま再起動すると、相手が「接続済み」を握ったままになり、
  // 以後の SKJOIN が EVENT 24 を返し続ける (マニュアル 3.4 / 3.6)。
  const { seq, transport, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  transport.sent.length = 0
  await seq.destroy()
  assert.ok(transport.sent.some((c) => /^SKTERM/.test(c)), '閉じる前に SKTERM を送ること')
})

test('ROPT が 01 を返す個体には WOPT を書かない (FLASH を消耗させない)', async () => {
  const { seq, transport, logs } = build({ wopt: 0x01 })
  await seq.start()
  await waitReady(seq, null, logs)
  assert.equal(transport.sent.filter((c) => /^WOPT/i.test(c)).length, 0, 'WOPT を書いていないこと')
  await seq.destroy()
})

test('ERXUDP がバイナリ表示の個体には WOPT 01 を 1 回だけ書く', async () => {
  const { seq, transport, logs } = build({ wopt: 0x00 })
  await seq.start()
  await waitReady(seq, null, logs)
  assert.equal(transport.sent.filter((c) => /^WOPT/i.test(c)).length, 1, 'WOPT は 1 回だけ')
  await seq.destroy()
})

test('定期取得が回り、計測値が流れてくる', async () => {
  const { seq, logs } = build()
  const got = []
  seq.on('measurement', (m) => got.push(m))
  await seq.start()
  await waitFor(() => got.some((m) => m.values.some((v) => v.epc === 0xe7)), 9000, '瞬時電力の受信')
  const power = got.flatMap((m) => m.values).find((v) => v.epc === 0xe7)
  assert.equal(typeof power.value, 'number')
  assert.match(power.display, / W$/)
  await seq.destroy()
})

test('積算電力量が係数と単位で kWh に換算される', async () => {
  const { seq, logs } = build({ meter: { cumulative: 615320, coefficient: 1, unitCode: 0x01 } })
  await seq.start()
  await waitReady(seq, null, logs)
  const res = await seq.get([0xe0])
  const v = res.values[0]
  // 615320 カウント × 係数 1 × 0.1 kWh = 61532 kWh
  assert.equal(v.value, 61532)
  assert.equal(v.display, '61532 kWh')
  await seq.destroy()
})

test('Get_SNA で拒否された EPC は控えるが、定期取得の設定からは外さない', async () => {
  // E8 はプロパティマップに載っている。マップの絞り込みではなく、控えで外れることを見る。
  const { seq, logs } = build({ fail: { sna: { E8: 99 } } }, { pollEpcs: [0xe7, 0xe8] })
  await seq.start()
  await waitReady(seq, null, logs)
  await waitFor(() => seq.snapshot().unsupportedEpcs.includes('0xE8'), 5000, '控えている EPC として記録')
  assert.deepEqual(seq.snapshot().pollEpcs, [0xe7, 0xe8], '設定は変えないこと (外すと二度と戻らない)')
  assert.deepEqual(seq._pollable([0xe7, 0xe8], { map: false }), [0xe7], '控えている間は送らないこと')
  await seq.destroy()
})

test('Get_SNA が 1 回返っても、控える期間が過ぎたら聞き直して値が戻る', async () => {
  // メーターは一時的に E7 を拒否することがある。定期取得から外すと、再接続しても設定どおりに戻しても二度と取れない。
  // シミュレーター側の回数と公開の状態で見る (中のフィールドの形に頼らない)。
  const { seq, transport, logs } = build({ fail: { sna: { E7: 1 } } }, { pollEpcs: [0xe7, 0xe8], snaHoldSec: 2 })
  const got = []
  seq.on('measurement', (m) => got.push(m))
  await seq.start()
  await waitReady(seq, null, logs)

  await waitFor(() => (transport.state.snaGiven[0xe7] || 0) >= 1, 5000, 'E7 の拒否')
  assert.deepEqual(seq.options.pollEpcs, [0xe7, 0xe8], '定期取得の設定から外さないこと')
  const from = got.length
  await waitFor(
    () => got.slice(from).some((m) => m.values.some((v) => v.epc === 0xe7)),
    10000,
    '控える期間のあと、E7 がまた取れること'
  )
  assert.ok(!seq.snapshot().unsupportedEpcs.includes('0xE7'), '取れたら控えるのをやめること')
  await seq.destroy()
})

test('控えている最中に聞いて拒否されても、控える回数を増やさない', async () => {
  // 定期取得の全部を控えていると、生存確認のために設定どおりに聞く。
  // そのたびに回数を増やすと、倍増が聞いた回数で進み、数分で 6 時間まで伸びる。
  const { seq } = build({}, { snaHoldSec: 300 })
  seq._noteDenied(0xe7)
  const until = seq.state.snaHold['0xE7'].until
  for (let i = 0; i < 5; i++) seq._noteDenied(0xe7)
  assert.equal(seq.state.snaHold['0xE7'].count, 1, '控えている間は回数を増やさないこと')
  assert.equal(seq.state.snaHold['0xE7'].until, until, '控える期限も延ばさないこと')
  await seq.destroy()
})

test('Get_SNA が続くと控える時間を延ばすが、0x9F に載っている EPC は長く控えない', async () => {
  const { seq } = build({}, { snaHoldSec: 300, snaHoldMaxSupportedSec: 900, snaHoldMaxSec: 21600 })
  seq.state.supportedEpcs = [0xe7] // プロパティマップに E7 は載っている

  // 控える期限が来て聞き直し、また拒否された、を繰り返す
  const deniedAfterExpiry = (epc, times) => {
    for (let i = 0; i < times; i++) {
      const h = seq.state.snaHold[EL_HEX(epc)]
      if (h) h.until = Date.now() - 1
      seq._noteDenied(epc)
    }
  }
  const EL_HEX = (e) => '0x' + e.toString(16).toUpperCase().padStart(2, '0')

  seq._noteDenied(0xe7)
  const first = seq.state.snaHold['0xE7'].until - Date.now()
  assert.ok(first > 290 * 1000 && first <= 300 * 1000, '1 回目は snaHoldSec (実際: ' + first + ')')
  deniedAfterExpiry(0xe7, 1)
  const second = seq.state.snaHold['0xE7'].until - Date.now()
  assert.ok(second > 590 * 1000 && second <= 600 * 1000, '2 回目は倍 (実際: ' + second + ')')
  deniedAfterExpiry(0xe7, 10)
  const listed = seq.state.snaHold['0xE7'].until - Date.now()
  assert.ok(listed <= 900 * 1000, '載っているものは snaHoldMaxSupportedSec で頭打ち (実際: ' + listed + ')')

  deniedAfterExpiry(0xe0, 10) // 載っていない
  const unlisted = seq.state.snaHold['0xE0'].until - Date.now()
  assert.ok(unlisted > 900 * 1000 && unlisted <= 21600 * 1000, '載っていないものは長く控える (実際: ' + unlisted + ')')

  seq._noteGranted(0xe7)
  assert.equal(seq.state.snaHold['0xE7'], undefined, '取れたら控えるのをやめること')
  await seq.destroy()
})

test('Get_SNA でも、取得できたプロパティの値は受け取れる', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)
  // 0xE7 は対応、0xFF は未対応 → ESV は Get_SNA になるが E7 の値は入っている
  const res = await seq.get([0xe7, 0xff])
  assert.equal(res.isGetSna, true)
  assert.equal(res.values.length, 1, '読めた分だけ値が入る')
  assert.equal(res.values[0].epc, 0xe7)
  await seq.destroy()
})

test('EPC の指定は、文字列なら 16 進・数値ならその値', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)
  const byString = await seq.get(['80'])
  const byNumber = await seq.get([0x80])
  assert.equal(byString.values[0].epc, 0x80, "'80' は 0x80 と読む")
  assert.equal(byNumber.values[0].epc, 0x80, '0x80 はそのまま')
  await seq.destroy()
})

test('FLASH を消耗するコマンドと管理下のレジスタは raw() から実行できない', async () => {
  const { seq, logs } = build()
  await assert.rejects(() => seq.raw('WOPT 01'), /FLASH/)
  await assert.rejects(() => seq.raw('SKSAVE'), /FLASH/)
  await assert.rejects(() => seq.raw('SKSREG SF0 1'), /ノードが管理/)
  await assert.rejects(() => seq.raw('SKSREG SFE 1'), /ノードが管理/)
  await seq.destroy()
})

test('知らないコマンドは FAIL として拾い、理由が分かる形で返る', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitFor(() => seq.snapshot().portOpen, 3000, 'ポート')
  await assert.rejects(() => seq.raw('SKNOSUCH'), /ER04/)
  await seq.destroy()
})

test('取得間隔は下限より短くできない', async () => {
  const { seq, logs } = build({}, { minPollIntervalSec: 15 })
  assert.equal(seq.setPollInterval(5), 15, '下限に丸める')
  assert.equal(seq.setPollInterval(60), 60)
  await seq.destroy()
})

test('EVENT 32 の間は無線コマンドを送らず、EVENT 33 で再開する', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  // 送信総和時間の制限が発動した状況を作る
  seq._dispatch({ kind: 'event', num: 0x32, numHex: '32', name: 'ARIB108送信総和時間の制限が発動', severity: 'error' })
  assert.equal(seq.snapshot().radioBlocked, true)

  const before = transport.sent.filter((c) => c.startsWith('SKSENDTO')).length
  seq.get([0xe7]).catch(() => {}) // 送信されないはず
  await new Promise((r) => setTimeout(r, 300))
  const during = transport.sent.filter((c) => c.startsWith('SKSENDTO')).length
  assert.equal(during, before, '制限中は SKSENDTO を出さない')

  seq._dispatch({ kind: 'event', num: 0x33, numHex: '33', name: '制限解除', severity: 'good' })
  assert.equal(seq.snapshot().radioBlocked, false)
  await seq.destroy()
})

test('stop() で進行中の手順が畳まれ、待っている Promise も解決される', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitFor(() => seq.snapshot().phase !== 'idle', 3000, '開始')
  const pending = seq.raw('SKINFO').then(
    () => 'resolved',
    (e) => (e.aborted ? 'aborted' : 'rejected:' + e.message)
  )
  await seq.stop('テスト')
  const outcome = await pending
  assert.ok(outcome === 'aborted' || outcome === 'resolved', '放置されないこと: ' + outcome)
  assert.equal(seq.snapshot().phase, 'idle')
  await seq.destroy()
})

test('認証情報の書式を送信前に弾く', async () => {
  const { seq, logs } = build()
  assert.deepEqual(seq.setCredentials(ID, PW), [], '正しい組は問題なし')
  assert.ok(seq.setCredentials('short', PW).some((p) => /32 桁/.test(p)))
  assert.ok(seq.setCredentials(ID, 'short').some((p) => /12 桁の英数字/.test(p)))
  assert.ok(seq.setCredentials(ID, 'あいうえおかきくけこさし').some((p) => /英数字/.test(p)))
  await seq.destroy()
})

test('パスワードは大文字に直して送る (マニュアル 3.17)', async () => {
  const { seq, transport, logs } = build()
  seq.setCredentials(ID.toLowerCase(), 'abcdef123456', 'test')
  await seq.start()
  await waitFor(() => transport.sent.some((c) => c.startsWith('SKSETRBID')), 6000, 'SKSETPWD/SKSETRBID')
  const cmd = transport.sent.find((c) => c.startsWith('SKSETPWD'))
  assert.equal(cmd, 'SKSETPWD C ABCDEF123456', '大文字化して送ること')
  const rbid = transport.sent.find((c) => c.startsWith('SKSETRBID'))
  assert.equal(rbid, 'SKSETRBID ' + ID.toUpperCase())
  await seq.destroy()
})

test('ログにパスワードを残さない', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitFor(() => logs.some((l) => /SKSETPWD/.test(l.text)), 6000, 'SKSETPWD のログ')
  const joined = logs.map((l) => l.text).join('\n')
  assert.ok(!joined.includes(PW), 'パスワードが平文で残っていないこと')
  assert.ok(/SKSETPWD C \*{4,}/.test(joined), '伏せ字になっていること')
  assert.ok(!joined.includes(ID), '認証 ID も伏せること')
  await seq.destroy()
})

test('スキャンで見つからなければ DURATION を段階的に伸ばす', async () => {
  // minScanDuration=5 なので DURATION=4 では見つからない
  const { seq, transport, logs } = build({ minScanDuration: 5 })
  await seq.start()
  await waitReady(seq, null, logs)
  const scans = transport.sent.filter((c) => c.startsWith('SKSCAN 2'))
  assert.ok(scans.length >= 2, '1 段階目で見つからず、次を試したこと')
  assert.equal(scans[0], 'SKSCAN 2 FFFFFFFF 4 0')
  assert.equal(scans[1], 'SKSCAN 2 FFFFFFFF 5 0')
  await seq.destroy()
})

test('DURATION は 16 進で送る', async () => {
  const { seq, transport, logs } = build({ minScanDuration: 16 }, { scanDurations: [16], scanRounds: 1 })
  await seq.start()
  await waitFor(() => transport.sent.some((c) => c.startsWith('SKSCAN 2')), 6000, 'SKSCAN')
  const scan = transport.sent.find((c) => c.startsWith('SKSCAN 2'))
  assert.equal(scan, 'SKSCAN 2 FFFFFFFF 10 0', '16 は 0x10 として送る')
  await seq.destroy()
})

test('SKSENDTO は DATALEN とデータ長が一致し、データ末尾に改行を付けない', async () => {
  const writes = []
  const { seq, transport, logs } = build()
  const origWrite = transport.write.bind(transport)
  transport.write = (buf) => {
    writes.push(Buffer.from(buf))
    return origWrite(buf)
  }
  await seq.start()
  await waitReady(seq, null, logs)

  const sendto = writes.find((b) => b.toString('latin1').startsWith('SKSENDTO'))
  assert.ok(sendto, 'SKSENDTO の書き込みがあること')
  const text = sendto.toString('latin1')
  const m = text.match(/^SKSENDTO \d+ \S+ \S+ \d+ \d+ ([0-9A-F]{4}) /)
  assert.ok(m, 'ヘッダーの書式が仕様どおり: ' + text.slice(0, 60))
  const declared = parseInt(m[1], 16)
  const actual = sendto.length - m[0].length
  assert.equal(actual, declared, 'DATALEN と実データ長が一致すること')
  assert.notEqual(sendto[sendto.length - 1], 0x0d, 'データ末尾に CR を付けない')
  assert.notEqual(sendto[sendto.length - 1], 0x0a, 'データ末尾に LF を付けない')
  await seq.destroy()
})

test('送信するコマンドの行末は CR', async () => {
  const writes = []
  const { seq, transport, logs } = build()
  const origWrite = transport.write.bind(transport)
  transport.write = (buf) => {
    writes.push(Buffer.from(buf))
    return origWrite(buf)
  }
  await seq.start()
  await waitFor(() => writes.some((b) => b.toString('latin1').startsWith('SKVER')), 6000, 'SKVER')
  const skver = writes.find((b) => b.toString('latin1').startsWith('SKVER'))
  assert.equal(skver.toString('latin1'), 'SKVER\r', 'CR のみで終わること')
  await seq.destroy()
})

// ---------------------------------------------------------------------------
// 動力と電力が並んで設置されている場所
// ---------------------------------------------------------------------------

test('隣の契約のメーターの方が電波が強くても、自分の契約の方へ繋ぐ', async () => {
  // 電波の強さで選ぶと、隣のメーターへ SKJOIN して
  // EVENT 24 を繰り返し、「認証情報が違う」ように見える。
  // 正しくは PairID (認証 ID の下位 8 文字) で選ぶ。
  const myPairId = ID.slice(-8) // '89ABCDEF'
  const { seq, transport, logs } = build({
    panId: '1234',
    pairId: myPairId,
    lqi: 0x30, // こちらは電波が弱い
    extraPans: [{ panId: 'AAAA', pairId: 'DEADBEEF', lqi: 0xf0 }], // 隣は強い
  })
  await seq.start()
  await waitReady(seq, 10000)

  const s = seq.snapshot()
  assert.equal(s.meter.panid, '1234', '自分の契約の PAN へ繋ぐこと')
  assert.equal(s.meter.pairId.toUpperCase(), myPairId.toUpperCase())
  // 隣へ SKJOIN しようとしていないこと
  const joins = transport.sent.filter((c) => c.startsWith('SKJOIN'))
  assert.equal(joins.length, 1, 'SKJOIN は 1 回だけ (隣へ試していない)')
  assert.equal(s.counters.failures, 0)
  await seq.destroy()
})

test('自分の契約のメーターが居なければ、その旨を出して SKJOIN を撃たない', async () => {
  const { seq, transport, logs } = build(
    {
      meterPresent: false, // 自分の契約のメーターは圏外
      extraPans: [{ panId: 'AAAA', pairId: 'DEADBEEF', lqi: 0xf0 }],
    },
    { scanDurations: [4, 5], scanRounds: 1 }
  )
  await seq.start()
  await waitFor(
    () => logs.some((l) => /この認証情報に対応するメーターがありません/.test(l.text)),
    10000,
    '対応するメーター無しのログ'
  )
  assert.equal(transport.sent.filter((c) => c.startsWith('SKJOIN')).length, 0, '隣のメーターへ SKJOIN しないこと')
  await seq.destroy()
})

test('途中のフェーズで静かに止まったら、watchdog が引き剥がして繋ぎ直す', async () => {
  // 「scanning のまま送信も待ち行列も無い」状態は、例外でも失敗でもないので、カウンタにもログにも何も出ない。
  const { seq, logs } = build({}, { watchdogIntervalMs: 60, watchdogStallMs: 400 })
  await seq.start()
  await waitReady(seq, null, logs)

  // 手順が切れた状態を作る: 途中のフェーズのまま、何も進まない
  seq._abortQueue('テスト')
  seq._clearPending('テスト')
  seq._stopPolling()
  seq.state.phase = 'scanning'
  seq.state.phaseSince = Date.now()
  seq.state.connected = false

  await waitFor(
    () => logs.some((l) => /手順が切れたとみなして最初からやり直します/.test(l.text)),
    5000,
    'watchdog の検出'
  )
  // 引き剥がしたあと、実際に繋ぎ直せること
  await waitReady(seq, 12000)
  assert.equal(seq.snapshot().phase, 'connected')
  await seq.destroy()
})

test('正常に動いている間は watchdog が誤作動しない', async () => {
  const { seq, logs } = build({}, { watchdogIntervalMs: 50, watchdogStallMs: 400, pollIntervalSec: 1 })
  await seq.start()
  await waitReady(seq, null, logs)
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(
    logs.filter((l) => /手順が切れた/.test(l.text)).length,
    0,
    '接続できている間に引き剥がさないこと'
  )
  assert.equal(seq.snapshot().phase, 'connected')
  await seq.destroy()
})

test('応答待ちが宙に浮いていても watchdog が発火する', async () => {
  // 「_pending があれば動いている」と見なすと、宙に浮いた応答待ちが残ったときに永久に発火しない。
  const { seq, logs } = build({}, { watchdogIntervalMs: 60, watchdogStallMs: 400 })
  await seq.start()
  await waitReady(seq, null, logs)

  seq._abortQueue('テスト')
  seq._stopPolling()
  seq.state.phase = 'scanning'
  seq.state.connected = false
  // タイマーの無い、解決しない応答待ちを残す (取り残しの再現)
  // 期限はとうに過ぎているのに誰も後始末をしていない状態
  seq._pending = { tid: 999, epcs: [0xe7], purpose: 'poll', deadline: Date.now() - 60000, timer: setTimeout(() => {}, 1e9), resolve() {}, reject() {} }

  await waitFor(
    () => logs.some((l) => /手順が切れたとみなして最初からやり直します/.test(l.text)),
    5000,
    'watchdog の検出'
  )
  assert.equal(seq._pending, null, '取り残した応答待ちを畳むこと')
  await seq.destroy()
})

test('送受信が進んでいる間は watchdog が発火しない', async () => {
  const { seq, logs } = build({}, { watchdogIntervalMs: 40, watchdogStallMs: 400, pollIntervalSec: 1 })
  await seq.start()
  await waitReady(seq, null, logs)
  // 接続後もポーリングで tx/rx が動き続ける
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(logs.filter((l) => /手順が切れた/.test(l.text)).length, 0)
  await seq.destroy()
})

test('watchdog は「期限」で判定する (時間のかかるコマンドを叩き切らない)', async () => {
  // SKSCAN は DURATION=8 で約 69 秒かかる。その間 tx も rx も動かないので、
  // 「進んでいないから滞留」とだけ判定すると正常な長いスキャンを途中で切ってしまう。
  // 期限を持っている仕事は、その期限までは待つこと。
  //
  // タイミングに左右されないよう _checkStall() を直接呼んで確かめる。
  const { seq, logs } = build({}, { watchdogStallMs: 0 })
  seq._running = true
  seq.state.phase = 'scanning'

  // まだ期限内の、時間のかかるコマンドを抱えている
  seq._current = { label: 'SKSCAN(D=8)', deadline: Date.now() + 70000 }
  seq._checkStall()
  seq._checkStall()
  assert.equal(logs.filter((l) => /手順が切れた/.test(l.text)).length, 0, '期限内は発火しないこと')

  // 期限内の応答待ちも同じ
  seq._current = null
  seq._pending = { tid: 1, deadline: Date.now() + 30000, timer: setTimeout(() => {}, 1), resolve() {}, reject() {} }
  seq._checkStall()
  seq._checkStall()
  assert.equal(logs.filter((l) => /手順が切れた/.test(l.text)).length, 0, '期限内の応答待ちも守ること')

  // 期限を過ぎても誰も後始末をしていない = 手順が切れている
  seq._pending.deadline = Date.now() - 60000
  seq._checkStall() // 進み具合を記録
  seq._checkStall() // 滞留の起点を記録
  seq._checkStall() // stallMs=0 なのでここで発火
  assert.ok(
    logs.some((l) => /手順が切れたとみなして最初からやり直します/.test(l.text)),
    '期限切れなら発火すること'
  )
  assert.equal(seq._pending, null, '取り残した応答待ちを畳むこと')

  await seq.destroy()
})

// ===========================================================================
//  マニュアル 3.9 — SKSENDTO の実行結果イベントに対する処理
// ===========================================================================

/** 接続してから異常を注入する。接続手順そのものを壊さないため。 */
function inject(transport, fail) {
  transport.config.fail = Object.assign({}, transport.config.fail, fail)
  Object.assign(transport.state, { sendFailures: 0, missed: 0, nsCount: 0, muted: 0 })
}

test('EVENT 21 <PARAM>=02 のあとは EVENT 02 を待ってから送信完了とみなす', async () => {
  const { seq, transport, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  inject(transport, { ns: 1 })
  const r = await seq.get([0xe7], 'test')
  assert.ok(
    r.values.find((v) => v.epc === 0xe7),
    'アドレス要請 (NS) を挟んでも、解決後の再送で値が取れること'
  )
  await seq.destroy()
})

test('EVENT 02 が返らないときは送り直し、続けばアドレスを取り直す', async () => {
  const { seq, transport, logs } = build({}, { sendMaxTries: 2, naWaitMs: 80, sendTimeout: 1500 })
  await seq.start()
  await waitReady(seq, null, logs)

  inject(transport, { ns: 99, nsNoAnswer: true })
  transport.sent.length = 0
  await assert.rejects(() => seq.get([0xe7], 'test'), /EVENT 02/)

  const sendtos = transport.sent.filter((c) => /^SKSENDTO/.test(c)).length
  assert.ok(sendtos >= 2, 'EVENT 02 が来なければ送信リトライすること (マニュアル 3.9)')
  assert.ok(
    logs.some((l) => /宛先アドレスが誤っている可能性/.test(l.text)),
    'リトライを使い切ったら「宛先アドレスが誤っている可能性」へ進むこと'
  )
  assert.ok(seq.state.ladder >= 2, 'スキャンからアドレスを取り直す段階へ上げること')
  await seq.destroy()
})

// 数秒の混雑で全チャネルのスキャンへ入ると、計測が 10 分以上止まる。
// 戻すと落ちるもの: _afterSendFailure の busy で _bumpLadder(2) に戻す。
test('EVENT 21 <PARAM>=01 が続いても全チャネルのスキャンにしない。取りこぼしに数える', async () => {
  const { seq, transport, logs } = build({}, { sendMaxTries: 2, sendTimeout: 1500, sendRetryDelaysMs: [20], pollIntervalSec: 60 })
  await seq.start()
  await waitReady(seq, null, logs)

  inject(transport, { sendto: 99 })
  await assert.rejects(() => seq.get([0xe7], 'test'), /UDP 送信失敗/)

  assert.ok(logs.some((l) => /取りこぼしに数えて続けます/.test(l.text)), logs.slice(-3).map((l) => l.text).join(' | '))
  assert.equal(seq.state.ladder, 0, '段階は上げない')
  assert.equal(seq.state.pollMisses, 1)
  assert.equal(seq.isConnected, true, '接続は切らない')
  // 失敗しても自動運転をやめないこと
  assert.equal(seq._running, true)
  assert.equal(seq.snapshot().overrides.stopped, null)
  await seq.destroy()
})

test('SKSENDTO が無応答なら <CR> を送って受付状態を解く', async () => {
  const { seq, transport, logs } = build({}, { sendMaxTries: 2, sendTimeout: 400 })
  await seq.start()
  await waitReady(seq, null, logs)

  transport.sent.length = 0
  inject(transport, { mute: 1 })
  const r = await seq.get([0xe7], 'test')

  assert.ok(
    logs.some((l) => /<CR> を送って受付状態を解きます/.test(l.text)),
    'マニュアル 3.9 のタイムアウト復旧手順を実行すること'
  )
  assert.ok(
    transport.sent.some((c) => c === ''),
    '裸の <CR> が実際にモジュールへ届いていること'
  )
  assert.ok(r.values.find((v) => v.epc === 0xe7), '復旧して送り直せば値は取れること')
  await seq.destroy()
})

test('ER04 のような引数エラーは再試行しない', async () => {
  const { seq, transport, logs } = build({}, { commandMaxTries: 3 })
  await seq.start()
  await waitReady(seq, null, logs)

  transport.sent.length = 0
  await assert.rejects(() => seq.raw('SKNOSUCHCOMMAND'), /ER04/)

  const tries = transport.sent.filter((c) => /^SKNOSUCHCOMMAND/.test(c)).length
  assert.equal(tries, 1, '同じ FAIL が返るだけなので 1 回で見切ること')
  assert.ok(logs.some((l) => /再試行しても変わりません/.test(l.text)))
  await seq.destroy()
})

// ===========================================================================
//  マニュアル 8 章 — 無線送信コマンド禁止期間 / 10.7 — 49 日問題
// ===========================================================================

test('EVENT 54 から EVENT 55 までは無線コマンドを出さない', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  seq._onSkEvent({ kind: 'event', num: 0x54, numHex: '54' })
  assert.equal(seq.snapshot().keyBlocked, true)

  const pending = seq.get([0xe7], 'test')
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(
    logs.some((l) => /自動鍵配信中（EVENT 54）のため SKSENDTO を保留/.test(l.text)),
    '保留したことがログに残ること'
  )

  seq._onSkEvent({ kind: 'event', num: 0x55, numHex: '55' })
  assert.equal(seq.snapshot().keyBlocked, false)
  await pending // 解除されたら、捨てずに送られること
  await seq.destroy()
})

test('EVENT 29 のあと EVENT 24/25 が来なければ自分から繋ぎ直す', async () => {
  const { seq, logs } = build({}, { reauthTimeoutMs: 100 })
  await seq.start()
  await waitReady(seq, null, logs)

  seq._onSkEvent({ kind: 'event', num: 0x29, numHex: '29' })
  assert.equal(seq.snapshot().phase, 'reauth')

  // 待ちっぱなしにすると、8 章により無線コマンドが出せないまま
  // ポーリングも再接続も止まる (10.7 の 49 日問題)。
  await waitFor(
    () => logs.some((l) => /EVENT 24\/25 が返りません/.test(l.text)),
    4000,
    '再認証の見切り'
  )
  assert.ok(seq.state.ladder >= 1, 'PANA 初回認証からやり直す段階へ上げること')
  await seq.destroy()
})

test('EVENT 25 が来れば再認証の見切りは発火しない', async () => {
  const { seq, logs } = build({}, { reauthTimeoutMs: 100 })
  await seq.start()
  await waitReady(seq, null, logs)

  seq._onSkEvent({ kind: 'event', num: 0x29, numHex: '29' })
  seq._onSkEvent({ kind: 'event', num: 0x25, numHex: '25' })
  await new Promise((r) => setTimeout(r, 400))

  assert.ok(
    !logs.some((l) => /EVENT 24\/25 が返りません/.test(l.text)),
    '再認証が成功したのに古いタイマーが再接続を蹴らないこと'
  )
  await seq.destroy()
})

// ===========================================================================
//  無人運転 — あきらめない / 入力は上書きだけ
// ===========================================================================

test('接続に失敗し続けても自動運転をやめない', async () => {
  const { seq, logs } = build(
    { meterPresent: false },
    { scanRounds: 1, scanDurations: [4], maxRetryDelayMs: 300 }
  )
  await seq.start()

  await waitFor(() => seq.state.consecutiveFailures >= 2, 15000, '2 回目の失敗')
  assert.equal(seq._running, true, '失敗が続いても自動運転は入のままであること')
  assert.equal(seq.snapshot().overrides.stopped, null, '内部の失敗で「停止」扱いにしないこと')
  await seq.destroy()
})

test('再試行の間隔は伸びるが、あきらめる段は無い', async () => {
  const { seq, logs } = build({}, { maxRetryDelayMs: 300000 })

  seq.state.ladder = 1
  seq._retryFailures = 1
  const first = seq._retryDelay()

  seq._retryFailures = 3
  assert.ok(seq._retryDelay() > first, '失敗が続くと間隔が伸びること')

  seq.state.ladder = 3
  seq._retryFailures = 999
  assert.equal(seq._retryDelay(), 300000, '上限で頭打ちになること (止まりはしない)')
  await seq.destroy()
})

test('reconnect を連打しても手順が二重に走らない', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  await seq.reconnect('試験 1', 3)
  await seq.reconnect('試験 2', 3)
  await seq.reconnect('試験 3', 3)
  // SKRESET や SKSCAN が二重に飛ぶとモジュールが固まる。
  assert.equal(seq._loopActive, true, '走っている手順は 1 本だけであること')

  await waitFor(() => seq.isConnected, 12000, '繋ぎ直し')
  await seq.destroy()
})

test('stop は外部からの上書きとして残り、auto で設定どおりに戻る', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  const base = seq.options.pollIntervalSec
  seq.setPollInterval(120, { external: true })
  await seq.stop('点検中', { external: true })

  let s = seq.snapshot()
  assert.equal(s.phase, 'overridden', '故障ではなく「外部の指示で停止中」と分かること')
  assert.equal(s.overrides.stopped.reason, '点検中')
  assert.equal(s.overrides.pollIntervalSec, 120)
  assert.equal(s.overrides.any, true)

  seq.resetOverrides('試験')
  s = seq.snapshot()
  assert.equal(s.overrides.stopped, null)
  assert.equal(s.overrides.any, false)
  assert.equal(seq.options.pollIntervalSec, base, '設定ノードの値へ戻ること')
  assert.equal(seq._running, true, '自動運転が再開すること')
  await seq.destroy()
})

test('start は止めていた上書きだけを外す (間隔の上書きは残す)', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  seq.setPollInterval(90, { external: true })
  await seq.stop('点検中', { external: true })
  await seq.start()

  const s = seq.snapshot()
  assert.equal(s.overrides.stopped, null, '運転は再開すること')
  assert.equal(s.overrides.pollIntervalSec, 90, '間隔の上書きは勝手に戻さないこと')
  await seq.destroy()
})

test('認証情報が未設定なら止まるが、入った時点で自分から動き出す', async () => {
  const { seq, logs } = build()
  seq.setCredentials(null, null, 'test')
  await seq.start()
  assert.equal(seq.snapshot().phase, 'need-secrets')
  assert.equal(seq._running, false)

  seq.setCredentials(ID, PW, 'test')
  await waitFor(() => seq._running, 2000, '自動運転の開始')
  await waitReady(seq, null, logs)
  assert.equal(seq.isConnected, true)
  await seq.destroy()
})

test('連続失敗の回数は、状態を配る前に数える', async () => {
  // 画面や通知が 1 回ぶん古い数字を見ないこと。
  // 通知は「N 回続けて失敗したら」で出すので、ここがずれると 1 回遅れて鳴る。
  const { seq } = build({ meterPresent: false }, { scanRounds: 1, scanDurations: [4], maxRetryDelayMs: 200 })
  const withError = []
  seq.on('status', (s) => {
    if (s.lastError) withError.push(s.consecutiveFailures)
  })
  await seq.start()
  await waitFor(() => withError.length >= 1, 15000, '最初の失敗')
  assert.ok(withError[0] >= 1, `失敗を配る時点で 0 のままにしないこと (実際: ${withError[0]})`)
  await seq.destroy()
})

// ===========================================================================
//  動かして踏んだ欠陥の回帰テスト
//
//  同じ穴を二度開けないための番人なので、消すときは理由を書くこと。
// ===========================================================================

test('SKSENDTO が FAIL で終わったら、緑のまま止まらずに繋ぎ直す', async () => {
  // PANA セッションだけ黙って失われると、以後 SKSENDTO は FAIL ER10 を返す。
  // _afterSendFailure がこれを素通りさせると、段階上げも再接続も走らず、応答待ちタイマーは先に潰されるので
  // pollMisses も増えず、phase='connected' のまま無進捗で回り続ける。
  const { seq, transport, logs } = build({}, { sendMaxTries: 1, sendTimeout: 800 })
  await seq.start()
  await waitReady(seq, null, logs)

  transport.state.joined = false // メーター側からセッションが消えた状態
  await assert.rejects(() => seq.get([0xe7], 'test'), /ER10/)

  assert.ok(
    logs.some((l) => /セッションが失われている可能性/.test(l.text)),
    'FAIL で終わったことを失敗として扱うこと'
  )
  assert.ok(seq.state.ladder >= 1, '段階を上げること (実際: ' + seq.state.ladder + ')')
  assert.equal(seq.state.connected, false, '接続済みのふりを続けないこと')
  assert.equal(seq._running, true, '自動運転はやめないこと')
  await seq.destroy()
})

test('EVENT 29 の間は無線コマンドを一切出さない (マニュアル 8 章)', async () => {
  // 見切り時間は既定の長さにする。短くすると _untilDisconnected の周期より
  // 先にタイマーが落ちてしまい、禁止期間を守れていなくてもテストが通る。
  const { seq, transport, logs } = build({}, { reauthTimeoutMs: 180000 })
  await seq.start()
  await waitReady(seq, null, logs)

  transport.sent.length = 0
  seq._onSkEvent({ kind: 'event', num: 0x29, numHex: '29' })

  // _untilDisconnected は 1 秒周期。ここで「切れた」と判断して _rejoin() へ進むと、
  // その 1 行目 _setPhase('rejoining') が禁止判定そのものと見切りタイマーを両方消す。
  await new Promise((r) => setTimeout(r, 1800))

  const radio = transport.sent.filter((c) => /^(SKJOIN|SKREJOIN|SKSENDTO|SKSCAN|SKRESET|SKPING)/.test(c))
  assert.deepEqual(radio, [], '禁止期間中に無線コマンドを出さないこと')
  assert.equal(seq.snapshot().phase, 'reauth', 'EVENT 24/25 を待ち続けること')
  assert.ok(seq._reauthTimer, '49 日問題用の見切りタイマーを消さないこと')
  await seq.destroy()
})

test('EVENT 25 で再認証が終われば、繋ぎ直さずそのまま続く', async () => {
  const { seq, transport, logs } = build({}, { reauthTimeoutMs: 180000 })
  await seq.start()
  await waitReady(seq, null, logs)

  seq._onSkEvent({ kind: 'event', num: 0x29, numHex: '29' })
  assert.equal(seq.snapshot().phase, 'reauth')

  transport.sent.length = 0
  seq._onSkEvent({ kind: 'event', num: 0x25, numHex: '25' })
  await waitFor(() => seq.isConnected, 5000, '再認証後の復帰')

  assert.equal(
    transport.sent.filter((c) => /^SKREJOIN/.test(c)).length,
    0,
    '自動再認証が成功したのに繋ぎ直さないこと'
  )
  assert.equal(seq._reauthTimer, null, '見切りタイマーを片付けること')
  await seq.destroy()
})

test('見張りは「意図して待っている」状態を叩かない', async () => {
  const { seq, logs } = build({}, { watchdogStallMs: 0 })
  seq._running = true
  seq.state.phase = 'scanning'

  // (a) 再試行までの待ち。
  //     ここを滞留と誤判定して叩き切ると、maxRetryDelayMs (5 分) まで伸ばした間隔が約 75 秒で頭打ちになる。
  const sleeping = seq._sleep(5000, '再試行の待ち')
  assert.equal(seq._deliberateWait(), '再試行の待ち')
  seq._checkStall()
  seq._checkStall()
  seq._checkStall()
  assert.equal(logs.filter((l) => /手順が切れた/.test(l.text)).length, 0, '待ちを叩かないこと')
  seq._wakeUp()
  await sleeping

  // (b) 送信総和時間の制限中 (EVENT 32)。ここを叩くと、制限中ずっと約 75 秒おきに SKRESET を撃ち続ける。
  seq._onSkEvent({ kind: 'event', num: 0x32, numHex: '32' })
  assert.equal(seq.snapshot().radioBlocked, true)
  seq._checkStall()
  seq._checkStall()
  seq._checkStall()
  assert.equal(
    logs.filter((l) => /手順が切れた/.test(l.text)).length,
    0,
    '送信制限中に SKRESET を撃たないこと'
  )
  await seq.destroy()
})

test('停止中に遅れて届いた失敗で、自動運転が勝手に復活しない', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  // ポーリングが飛んでいる最中に stop が入り、そのあと失敗が返る状況。
  seq.state.pollMisses = seq.options.pollMissLimit
  seq._request = async () => {
    await seq.stop('点検中', { external: true })
    throw new Error('応答なし')
  }
  await seq._poll()

  assert.equal(seq._running, false, '止めたままであること')
  assert.ok(seq.snapshot().overrides.stopped, '外部指示の上書きが残っていること')
  await seq.destroy()
})

test('自分で畳んだ応答待ちは Aborted として返る', async () => {
  // CommandError で返すと、下流の err.aborted 判定をすり抜けて
  // 「メーターが応答しない」と同じ扱いになり、意図的な停止が
  // 失敗として数えられて段階が上がってしまう。
  const { seq } = build()
  let caught = null
  seq._pending = {
    tid: 1,
    timer: setTimeout(() => {}, 1000),
    resolve() {},
    reject(e) {
      caught = e
    },
  }
  seq._clearPending('停止')
  assert.ok(caught && caught.aborted, 'aborted の印が付くこと')
  await seq.destroy()
})

test('reconnect は外部指示の停止を解除しない', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  await seq.stop('点検中', { external: true })
  await seq.reconnect('画面の再接続ボタン')

  assert.equal(seq._running, false, '再接続で勝手に動き出さないこと')
  assert.ok(seq.snapshot().overrides.stopped, '停止の上書きが残ること')
  assert.ok(logs.some((l) => /停止中のため再接続しません/.test(l.text)), '理由を残すこと')
  await seq.destroy()
})

test('interval に空を渡しても、停止の上書きまでは解除しない', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  const base = seq.options.pollIntervalSec
  seq.setPollInterval(120, { external: true })
  await seq.stop('点検中', { external: true })

  seq.resetOverride('pollIntervalSec')

  assert.equal(seq.options.pollIntervalSec, base, '取得間隔だけ戻ること')
  assert.equal(seq.snapshot().overrides.pollIntervalSec, null)
  assert.ok(seq.snapshot().overrides.stopped, '停止の上書きは残ること')
  assert.equal(seq._running, false, '止めたままであること')
  await seq.destroy()
})

test('設定どおりに戻すと設定の EPC が全部戻り、控えている EPC は送る直前に外す', async () => {
  // 拒否された EPC を設定から外すと、一時的な拒否で瞬時電力を永久に失う。
  // 設定は設定どおりに戻し、控えている間だけ _pollable() で外す。
  // 実際に Get_SNA を受けさせてから戻す。EA は毎回拒否させる。
  const { seq, logs } = build({ fail: { sna: { EA: 99 } } }, { pollEpcs: [0xe7, 0xe0, 0xea] })
  await seq.start()
  await waitReady(seq, null, logs)
  await waitFor(() => seq.snapshot().unsupportedEpcs.includes('0xEA'), 5000, 'EA の拒否')
  seq.setPollEpcs([0xe7], { external: true })

  seq.resetOverrides('試験')

  assert.deepEqual(seq.options.pollEpcs, [0xe7, 0xe0, 0xea], '設定どおりに戻すこと')
  assert.deepEqual(seq._pollable(seq.options.pollEpcs, { map: false }), [0xe7, 0xe0], '控えている EA は送らないこと')
  await seq.destroy()
})

test('禁止期間で出せないコマンドは、待ち時間で理由を付けて返る', async () => {
  // 保留中のコマンドは期限を持たない。そのまま待たせると、
  // 入力から投げた terminate や raw が最大 1 時間返らず、
  // Node-RED 側の done() も呼ばれないままになる。
  const { seq, logs } = build({}, { commandTimeout: 300 })
  await seq.start()
  await waitReady(seq, null, logs)

  seq._onSkEvent({ kind: 'event', num: 0x32, numHex: '32' })
  await assert.rejects(() => seq.raw('SKPING FE80:0000:0000:0000:0000:0000:0000:0001'), /のため実行できませんでした/)
  await seq.destroy()
})

test('設定ノードの sequencer は、畳まれても作り直せる', async () => {
  // 最後の wsuha-broute ノードが閉じると sequencer は destroy されて null になる。
  // 設定ノード自身はプロセスに残るので、作り直せないと
  // ノードの貼り直しや無効化 → 有効化で二度と復活しない。
  const src = require('node:fs').readFileSync(require.resolve('../nodes/wsuha-device.js'), 'utf8')
  assert.ok(/node\._build = function/.test(src), '組み立てを関数として持つこと')
  assert.ok(/if \(!node\._build\(\)\) return/.test(src), '_open で作り直すこと')
})

test('速い周期の再スケジュールで、ゆっくりした階層のタイマーを消さない', async () => {
  // _schedulePoll は毎回 _stopPolling を呼ぶ。そこで階層タイマーまで
  // 止めてしまうと、5 分・30 分の取得が接続直後の 1 回しか動かない。
  const { seq, logs } = build({}, { slowIntervalSec: 30, halfHourIntervalSec: 30 })
  await seq.start()
  await waitReady(seq, null, logs)

  assert.ok(seq._tierTimers.slow, '接続後に 5 分階層のタイマーが張られること')
  assert.ok(seq._tierTimers.halfHour, '接続後に 30 分階層のタイマーが張られること')

  seq._schedulePoll(60000) // 速い周期の張り直し
  assert.ok(seq._tierTimers.slow, '張り直しで消えないこと')
  assert.ok(seq._tierTimers.halfHour, '張り直しで消えないこと')

  await seq.stop('試験')
  assert.equal(seq._tierTimers.slow, null, '運転を止めたら片付けること')
  assert.equal(seq._tierTimers.halfHour, null, '運転を止めたら片付けること')
  await seq.destroy()
})

test('メーターが持たないプロパティは要求しない', async () => {
  const { seq } = build()
  seq.state.supportedEpcs = [0x80, 0xe7, 0xe8] // 積算は持っていないメーター
  assert.deepEqual(seq._pollable([0xe0, 0xe3, 0x88, 0x80]), [0x80], '持っているものだけ残すこと')

  seq.state.supportedEpcs = [] // プロパティマップを取れていない場合
  assert.deepEqual(seq._pollable([0xe0, 0x80]), [0xe0, 0x80], '分からないときは絞り込まないこと')

  // Get_SNA で拒否されて控えているもの。メソッドを呼ばず状態で与える。
  seq.state.snaHold = { '0xE0': { count: 1, until: Date.now() + 60000, at: Date.now() } }
  assert.deepEqual(seq._pollable([0xe0, 0x80]), [0x80], '拒否されて控えている間は外すこと')
  seq.state.snaHold['0xE0'].until = Date.now() - 1 // 控える期限が過ぎた
  assert.deepEqual(seq._pollable([0xe0, 0x80]), [0xe0, 0x80], '期限が過ぎたらまた聞くこと')
  await seq.destroy()
})

test('取れた値は覚えておき、いま分かっている全部を出せる', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  const known = seq.snapshot().known
  assert.ok(known['0xD3'], '接続時に取った係数が残ること')
  assert.ok(known['0xE1'], '接続時に取った単位が残ること')
  assert.ok(typeof known['0xD3'].at === 'number', '取得時刻を持つこと')

  await seq.get([0xe7], 'test')
  const after = seq.snapshot().known
  assert.ok(after['0xE7'], '新しく取った値が入ること')
  assert.ok(after['0xD3'], '前に取った値が消えないこと')
  await seq.destroy()
})

test('ノードは設定ノードへ登録してからイベントに結び付ける', async () => {
  // 順序に頼ると、フローの再デプロイのたびに出力だけ黙って止まる。
  //   古いノードが閉じる → sequencer は destroy されて null
  //   → 新しいノードが出来た時点ではまだ null → ハンドラが繋がらない
  //   → register() で作り直されるが、もう結び付いていない
  // 接続も計測も動くので、ログを見ても異常に見えない。
  //
  // ノードは AdapterHandle（sequencer を作り直しても同じオブジェクト）を購読するので、
  // 登録の順序に頼らない。ソースの文字列の位置ではなく、振る舞いを見る:
  // 設定ノードの sequencer が畳まれている間に wsuha-broute を作り直しても（再デプロイ）、measurement が出力に届く。
  // 戻すと落ちるもの: wsuha-broute.js の購読先を handle から「その時点の node.device.sequencer」に戻す。
  const { createFakeRed } = require('./runtime/fake-red')
  const fake = createFakeRed()
  require('../nodes/wsuha-device.js')(fake.RED)
  require('../nodes/wsuha-broute.js')(fake.RED)
  const tune = (s) =>
    Object.assign(s.options, { resetSettleMs: 20, scanRounds: 1, txBudgetGuard: false, minPollIntervalSec: 1, pollIntervalSec: 1 })
  const dev = fake.create('wsuha-device', {
    id: 'seqtest-redeploy',
    role: '電力',
    mode: 'simulator',
    deviceKey: 'seqtestredeploy',
    scanDurations: '4,5',
    simulatorOptions: JSON.stringify({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8), echonetDelayMs: 5 }),
    _credentials: { routeBId: ID, routeBPassword: PW },
  })
  live.push({ destroy: async () => dev._close() })
  tune(dev.sequencer)
  const out = (n) => n._sent.filter((m) => Array.isArray(m) && m[0] && m[0].payload && m[0].payload.values)
  const b1 = fake.create('wsuha-broute', { id: 'seqtest-b1', device: 'seqtest-redeploy' })
  await waitFor(() => out(b1).length > 0, 8000, '最初の出力')

  // 再デプロイ: 古いノードが閉じ、設定ノードの sequencer が畳まれている間に、新しいノードが出来る
  await fake.close(b1, false)
  const b1Count = b1._sent.length
  await dev._close()
  assert.equal(dev.sequencer, null, '前提: sequencer が null の間に作る')
  const b2 = fake.create('wsuha-broute', { id: 'seqtest-b2', device: 'seqtest-redeploy' })
  assert.ok(dev.sequencer, '設定ノードは作り直される')
  tune(dev.sequencer)
  await waitFor(() => out(b2).length > 0, 8000, '作り直したノードへの出力')
  assert.equal(b1._sent.length, b1Count, '閉じた古いノードには届かない')

  await fake.close(b2, true)
  await fake.close(dev, true)
})

// ===========================================================================
//  階層の取得と、再接続のあいだの周期の回帰テスト。
//  どれも振る舞いの検査で落ちる形にしてある (新しいフィールドの TypeError だけで落ちる形にはしない)。
// ===========================================================================

test('階層の取得が済んだら、次の周期のタイマーを張り直す', async () => {
  // 末尾の張り直しが無いと、5 分・30 分の取得が接続直後の 1 回しか動かない。
  const { seq, logs } = build({}, { slowIntervalSec: 1, halfHourIntervalSec: 1, minTierIntervalSec: 1 })
  const asked = []
  const orig = seq._request.bind(seq)
  seq._request = (epcs, purpose) => {
    asked.push(purpose)
    return orig(epcs, purpose)
  }
  await seq.start()
  await waitReady(seq, null, logs)
  await waitFor(() => asked.filter((p) => p === 'slow').length >= 2, 8000, '5 分階層が 2 回動く')
  await waitFor(() => asked.filter((p) => p === 'halfHour').length >= 2, 8000, '30 分階層が 2 回動く')
  await seq.destroy()
})

test('前回の階層取得から周期を過ぎていれば、張り直したときすぐ取りに行く', async () => {
  // 再接続のたびに満期 (5 分) から数え直すと、5 分より短い間隔で
  // 再接続が続く環境では、積算電力量が一度も取れない。
  // 中のフィールドに触らず、6 分前に 1 回取ったことにする。
  const { seq } = build({}, { slowIntervalSec: 300, minTierIntervalSec: 1 })
  seq._running = true
  seq.state.phase = 'connected'
  seq._request = async () => {}
  const realNow = Date.now
  try {
    Date.now = () => realNow() - 360 * 1000 // 6 分前に 5 分の階層を取った
    await seq._pollTier('slow')
  } finally {
    Date.now = realNow
  }
  seq._scheduleTier('slow') // 再接続で張り直す
  const overdue = seq._tierTimers.slow._idleTimeout
  assert.ok(overdue <= 1000, '期限を過ぎていればすぐ取りに行くこと (実際: ' + overdue + ' ms)')

  try {
    Date.now = () => realNow() - 60 * 1000 // 1 分前に取った
    await seq._pollTier('slow')
  } finally {
    Date.now = realNow
  }
  seq._scheduleTier('slow')
  const rest = seq._tierTimers.slow._idleTimeout
  assert.ok(rest > 230 * 1000 && rest <= 240 * 1000, '残りの時間だけ待つこと (実際: ' + rest + ' ms)')
  seq._running = false
  seq._stopCollecting()
  await seq.destroy()
})

test('最初の階層取得の前に再接続が続いても、周期が来たら取りに行く', async () => {
  // 起動直後 (まだ 1 回も取っていない) に、周期より短い間隔で再接続が続く場合。
  // 初回を「満期から」にすると、再接続のたびに数え直して一度も取らない。
  // 周期 5 秒に対して、約 2.5 秒ごとに再接続する。
  const { seq, logs } = build({}, { slowIntervalSec: 5, halfHourIntervalSec: 1800, minTierIntervalSec: 1 })
  const asked = []
  const orig = seq._request.bind(seq)
  seq._request = (epcs, purpose) => {
    asked.push(purpose)
    return orig(epcs, purpose)
  }
  await seq.start()
  await waitReady(seq, null, logs)
  for (let i = 0; i < 6 && !asked.includes('slow'); i++) {
    await new Promise((r) => setTimeout(r, 1200)) // 下限 (1 秒) より長く繋がっている
    if (asked.includes('slow')) break
    seq.reconnect('試験 (周期より短い間隔の再接続)')
    await waitFor(() => seq.isConnected, 8000, '繋がり直す')
  }
  // 再接続のたびに満期 (5 秒) から数え直す作りだと、ここまでに一度も動かない。
  await waitFor(() => asked.includes('slow'), 3000, '5 分階層 (ここでは 5 秒) が 1 回は動く')
  await seq.destroy()
})

test('係数を取り直した電文の積算は、その場で換算する', async () => {
  // 係数の取り直しでは D3/E1 と E0/E3 が 1 通にまとまる。係数を先に読まないと、
  // 同じ電文の積算が未換算 (null) で出て、下流に届くのが 1 周期遅れる。
  const { seq, logs } = build({ meter: { cumulative: 615320, coefficient: 1, unitCode: 0x01 } })
  await seq.start()
  await waitReady(seq, null, logs)
  seq._stopCollecting()
  seq.state.calibration = { coefficient: null, unitFactor: null, digits: null }
  await seq._pollTier('slow')
  const e0 = seq.state.values['0xE0']
  assert.ok(e0, 'E0 を取ること')
  assert.equal(e0.value, 61532, '同じ電文の係数で換算すること (実際: ' + e0.value + ')')
  await seq.destroy()
})

test('定期取得はプロパティマップに載っていない EPC も聞く (黙って外さない)', async () => {
  const { seq } = build({}, { pollEpcs: [0xe7, 0xe8] })
  seq.state.supportedEpcs = [0x80, 0xe7] // E8 が載っていないマップ
  seq._running = true
  seq.state.phase = 'connected'
  const asked = []
  seq._request = async (epcs) => {
    asked.push(epcs)
  }
  await seq._poll()
  assert.deepEqual(asked[0], [0xe7, 0xe8], '設定どおりに聞くこと (マップに無ければ Get_SNA が返り、控えに回る)')
  seq._running = false
  seq._stopCollecting()
  await seq.destroy()
})

test('係数・単位を取りこぼしたら、5 分の階層で取り直す', async () => {
  const { seq } = build()
  const asked = []
  seq._running = true
  seq.state.phase = 'connected'
  seq._request = async (epcs, purpose) => {
    asked.push({ epcs, purpose })
  }
  await seq._pollTier('slow')
  assert.ok(asked.length > 0 && asked[0].epcs.includes(0xd3) && asked[0].epcs.includes(0xe1), '係数と単位を足すこと')

  seq.state.calibration.coefficient = 1
  seq.state.calibration.unitFactor = 0.1
  asked.length = 0
  await seq._pollTier('slow')
  assert.ok(!asked.some((a) => a.epcs.includes(0xd3)), '取れていれば足さないこと')

  seq._running = false
  seq._stopCollecting()
  await seq.destroy()
})

test('再接続の指示で、取得のタイマーを止め、順番待ちの要求を古いセッションへ送らない', async () => {
  const { seq, transport, logs } = build({}, { slowIntervalSec: 300 })
  await seq.start()
  await waitReady(seq, null, logs)

  transport.config.echonetDelayMs = 1500 // 1 本目の応答を遅らせ、2 本目を順番待ちにする
  const first = seq.get([0xe7]).catch((e) => e)
  const second = seq.get([0xe8]).catch((e) => e)
  await waitFor(() => seq._pending, 3000, '1 本目の送信')

  seq.reconnect('試験')
  assert.equal(seq._tierTimers.slow, null, '階層のタイマーを止めること')
  assert.equal(seq._pollTimer, null, '速い周期のタイマーを止めること')

  const r1 = await first
  const r2 = await second
  assert.ok(r1 && r1.aborted, '応答待ちの要求は Aborted で返ること')
  assert.ok(r2 && r2.aborted, '順番待ちの要求も Aborted で返ること (実際: ' + (r2 && r2.message) + ')')
  transport.config.echonetDelayMs = 120
  await waitFor(() => seq.isConnected, 8000, '繋がり直す')
  await seq.destroy()
})

test('自動再認証 (EVENT 25) のあとの疎通確認が 1 秒より長くかかっても、SKREJOIN を撃たない', async () => {
  // _untilDisconnected は 1 秒周期で見る。'verifying' を待たないと、
  // 疎通確認の応答が 1 秒より遅いときに「切れた」と判断して SKREJOIN を撃つ。
  // シミュレーターの応答が速い (120 ms) ままだと、この不具合はテストで見えない。
  const { seq, transport, logs } = build({}, { reauthTimeoutMs: 180000 })
  await seq.start()
  await waitReady(seq, null, logs)
  seq._stopCollecting() // 定期取得と重ならないように

  transport.config.echonetDelayMs = 2500
  seq._onSkEvent({ kind: 'event', num: 0x29, numHex: '29' })
  transport.sent.length = 0
  seq._onSkEvent({ kind: 'event', num: 0x25, numHex: '25' })
  await waitFor(() => seq.isConnected, 8000, '疎通確認の完了')

  assert.equal(transport.sent.filter((c) => /^SKREJOIN/.test(c)).length, 0, '疎通確認の最中に SKREJOIN を撃たないこと')
  await seq.destroy()
})

test('シリアルポートが閉じたら、開き直したあと SKRESET からやり直す', async () => {
  // USB の抜き差しや電源の瞬断ではモジュールの RAM の設定が消えている。
  // SKREJOIN から始めても FAIL ER10 が返るだけ。
  const { seq, transport, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  transport.sent.length = 0
  await transport.close()
  assert.equal(seq.state.ladder, 3, '段階 3 (SKRESET から) に上げること')
  await waitFor(() => transport.sent.some((c) => /^SKRESET/.test(c)), 8000, 'SKRESET からやり直す')
  assert.equal(transport.sent.filter((c) => /^SKREJOIN/.test(c)).length, 0, 'SKREJOIN から始めないこと')
  await waitFor(() => seq.isConnected, 10000, '繋がり直す')
  await seq.destroy()
})

test('別のメーターに繋ぎ直したら、前のメーターで学んだことを消す', async () => {
  const { seq, logs } = build()
  await seq.start()
  await waitReady(seq, null, logs)

  await seq.get([0xfe]).catch(() => {}) // シミュレーターは FE を持たない → 本物の Get_SNA
  await waitFor(() => seq.snapshot().unsupportedEpcs.includes('0xFE'), 3000, 'FE の拒否')
  seq.state.meter.addr = '0000000000000001' // 別のメーターに繋がっていたことにする
  seq.state.values['0xFE'] = { name: '目印', value: 1, at: Date.now() }
  seq.reconnect('試験', 2) // 再スキャンから
  await waitFor(() => seq.isConnected && !seq.state.values['0xFE'], 10000, '繋ぎ直して学習を消す')
  assert.ok(!seq.snapshot().unsupportedEpcs.includes('0xFE'), '控えていた EPC も消すこと')
  await seq.destroy()
})

test('再試行の待ちの最中にポートが開いたら、待ちを起こしてすぐ繋ぐ', async () => {
  // 起動時にアダプタが無く、開けずに再試行の待ち (15 秒以上) に入った場合。
  // 実機では transport が 5 秒ごとに自分で開き直すので、開いたことを合図に待ちを起こす。
  const { seq, transport } = build({ fail: { open: 1 } })
  seq.start()
  await waitFor(() => seq._waitingFor, 3000, '開けずに再試行の待ちへ入る')
  await transport.open()
  await waitFor(() => seq.isConnected, 5000, '待ちを起こして繋がる (再試行の待ちは 15 秒以上)')
  await seq.destroy()
})

test('起動時に何度か開けなくても、開けたら SKRESET から始める (初期化を飛ばさない)', async () => {
  // 開けなかった回数だけ段階が上がり、段階 2 で開くと SKSCAN から始めていた。
  // そのモジュールには SFE 0・鍵・S2/S3 が入っていない。
  const { seq, transport, logs } = build({ fail: { open: 2 } }, { maxRetryDelayMs: 50 })
  await seq.start()
  await waitReady(seq, 10000, logs)
  const iReset = transport.sent.findIndex((c) => /^SKRESET/.test(c))
  const iScan = transport.sent.findIndex((c) => /^SKSCAN/.test(c))
  assert.ok(iReset >= 0 && iReset < iScan, 'SKSCAN より先に SKRESET を撃つこと (SKRESET=' + iReset + ' SKSCAN=' + iScan + ')')
  await seq.destroy()
})

test('SKJOIN の待ちの最中にポートが閉じたら、開き直したあと SKTERM → SKRESET から始める', async () => {
  // USB の抜き差しでモジュールの設定が消えたのに、待っていた手順がそのまま続き、
  // 開いた瞬間に溜まっていた SKTERM・SKJOIN を流していた。粘り窓が尽きると段階も 3 → 2 に戻され、
  // SKRESET を一度も撃たなかった。
  const { seq, transport } = build({ fail: { join: 999 } }, { joinBurstBackoffMs: [3000], joinPersistMs: 60000 })
  seq.start()
  await waitFor(() => seq._waitingFor === 'SKJOIN の次の巡の待ち', 8000, 'SKJOIN のバースト待ちに入る')

  transport.sent.length = 0 // 閉じたあとに送ったものだけを見る
  await transport.close()
  await transport.open() // 実機では transport が自分で開き直す (シミュレーターはループの open で開く)
  await waitFor(() => transport.sent.some((c) => /^SKRESET/.test(c)), 8000, 'SKRESET からやり直す')

  const iTerm = transport.sent.findIndex((c) => /^SKTERM/.test(c))
  const iReset = transport.sent.findIndex((c) => /^SKRESET/.test(c))
  const iJoin = transport.sent.findIndex((c) => /^SKJOIN/.test(c))
  assert.ok(iJoin < 0 || iReset < iJoin, 'SKRESET より前に SKJOIN を撃たないこと (送った順: ' + transport.sent.slice(0, 6).join(' / ') + ')')
  assert.ok(iTerm >= 0 && iTerm < iReset, 'SKRESET の前に SKTERM を 1 回撃つこと (メーター側のセッションを畳む)')
  await seq.destroy()
})

test('設定の空欄 (undefined) で既定値を消さない・取得間隔の下限は設定値にも効く', async () => {
  const s = new Sequencer(new SimulatorTransport({}), { scanDurations: undefined, pollIntervalSec: 5 })
  assert.deepEqual(s.options.scanDurations, [4, 5, 6, 7, 8], '既定のスキャン時間が残ること')
  assert.equal(s.options.pollIntervalSec, 15, '下限 15 秒に丸めること')
  await s.destroy()
})

test('起動時にポートを開けなくても、開けた時点で自動運転が始まる', async () => {
  // Node-RED が USB の列挙より先に立ち上がると、最初の open が失敗する。
  // そこで return すると start() に届かず、「開 / 停止中」のまま黙って止まる。
  const { EventEmitter } = require('node:events')
  const types = {}
  const errors = []
  const RED = {
    settings: { userDir: require('node:os').tmpdir() },
    httpAdmin: { get() {} },
    auth: { needsPermission: () => (req, res, next) => next() },
    nodes: {
      createNode(node, config) {
        EventEmitter.call(node)
        for (const k of ['on', 'once', 'emit', 'removeListener', 'removeAllListeners', 'listeners']) {
          node[k] = EventEmitter.prototype[k]
        }
        node.id = config.id
        node.credentials = config._credentials || {}
        node.error = (m) => errors.push(String(m))
        node.warn = () => {}
        node.debug = () => {}
        node.log = () => {}
        node.status = () => {}
      },
      registerType(name, ctor) {
        types[name] = ctor
      },
    },
  }
  require('../nodes/wsuha-device.js')(RED)
  const Device = types['wsuha-device']
  const node = new Device({
    id: 'dev-test',
    mode: 'simulator',
    deviceKey: 'usbtest',
    pollInterval: 30,
    scanDurations: '4,5',
    simulatorOptions: JSON.stringify({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8), fail: { open: 1 } }),
    _credentials: { routeBId: ID, routeBPassword: PW },
  })
  node.register({ id: 'consumer' })
  live.push({ destroy: async () => node._close() })
  await waitFor(() => node.sequencer && node.sequencer._running, 3000, '自動運転の開始')
  assert.ok(errors.some((e) => /開けません/.test(e)), '開けなかったことは error で残すこと')
  await waitFor(() => node.sequencer.state.portOpen, 5000, 'ポートが開く')
  await node._close()
})

// ===========================================================================
//  要求の目的と、ECHONET の待ち行列
// ===========================================================================

test('measurement に purpose（要求の目的）を載せる: poll・manual・diag・階層・INF', async () => {
  // 診断（diag）で取った値を、出力 1 と推移に流さないための印。値は _request の purpose と同じ。
  // 戻すと落ちるもの: _onErxudp で result.purpose を付けるのをやめる
  const { seq, transport, logs } = build({ echonetDelayMs: 5 }, { pollIntervalSec: 30 })
  try {
    const got = []
    seq.on('measurement', (r) => got.push([r.purpose, r.values.map((v) => v.epc)]))
    await transport.open()
    seq.start()
    await waitReady(seq, 8000, logs)
    await waitFor(() => got.some(([p]) => p === 'poll'), 3000, '接続直後の定期取得')
    assert.ok(got.some(([p]) => p === 'verify'), '疎通確認: ' + JSON.stringify(got))
    assert.ok(got.some(([p]) => p === 'once'), '接続時の一括取得')

    got.length = 0
    await seq.get([0xe8], 'diag')
    await seq.get([0xe8])
    await seq._pollTier('slow')
    assert.deepEqual(got.map(([p]) => p), ['diag', 'manual', 'slow'], JSON.stringify(got))

    // メーターからの自発の通知（INF）は 'inf'。直前の要求の TID と同じでも取り違えない
    got.length = 0
    const inf = Buffer.from([0x10, 0x81, (seq._tid >> 8) & 0xff, seq._tid & 0xff, 0x02, 0x88, 0x01, 0x05, 0xff, 0x01, 0x73, 0x01, 0xe7, 0x04, 0x00, 0x00, 0x01, 0x00])
    const len = ('000' + inf.length.toString(16).toUpperCase()).slice(-4)
    const c = transport.config
    transport._emitLine(`ERXUDP ${c.meterIpv6} ${c.ipv6} 0E1A 0E1A ${c.meterAddr} 1 0 ${len} ${inf.toString('hex').toUpperCase()}`, 1)
    await waitFor(() => got.length > 0, 2000, 'INF')
    assert.deepEqual(got[0], ['inf', [0xe7]])

    // 応答待ちを先に畳んだあとで届いた応答も、送ったときの目的で返す（診断の遅れた応答を出力 1 に流さない）
    got.length = 0
    transport.config.echonetDelayMs = 300
    const late = seq.get([0xe8], 'diag').catch((e) => e)
    await waitFor(() => seq._pending, 2000, '応答待ち')
    const p = seq._pending
    clearTimeout(p.timer)
    seq._pending = null
    p.reject(new Error('試験: 先に見切った'))
    await late
    await waitFor(() => got.length > 0, 3000, '遅れて届いた応答')
    assert.deepEqual(got[0], ['diag', [0xe8]])
  } finally {
    await seq.destroy()
  }
})

test('フローの入力が ECHONET の待ち行列を埋めても、周期の取得を取りこぼしに数えず再接続しない', async () => {
  // _request の「滞留しています」は queueFull: true。_poll はそれを pollMisses に数えない。
  // 数えると、フローの get / poll を連打しただけで周期の取得が応答なしと同じに扱われ、
  // 3 回で PANA の初回認証からやり直す（メーターは元気なのに計測が数十秒止まる）。
  // 戻すと落ちるもの: _poll の catch で queueFull を数えないのをやめる
  const { seq, transport, logs } = build({ echonetDelayMs: 5 }, { pollIntervalSec: 1 })
  let stop = false
  try {
    await transport.open()
    seq.start()
    await waitReady(seq, 8000, logs)
    const before = { reconnects: seq.state.counters.reconnects, joins: seq.state.counters.joins }
    // 応答が遅い（取得間隔の 3 倍より長い）間に、待ち行列が埋まったまま周期の取得が 3 回来る形。
    // 応答が 1 つでも届くと pollMisses は 0 に戻るので、それより前に 3 回断られる長さにする
    transport.config.echonetDelayMs = 3500
    let other = 0
    // wsuha-broute の入力（topic: get）を間を空けずに流し続ける = 待ち行列（既定 4）が常に埋まっている
    const flood = (async () => {
      while (!stop) {
        while (seq._requestDepth < seq.options.maxQueuedRequests) {
          seq.get([0xe7], 'manual').catch((e) => {
            if (!(e && (e.queueFull || e.aborted))) other++
          })
        }
        await new Promise((r) => setTimeout(r, 20))
      }
    })()
    let maxMisses = 0
    const until = performance.now() + 3300 // 最初の応答（3.5 秒後）より前に、周期の取得（1 秒）が 3 回断られる長さ
    while (performance.now() < until && seq.state.counters.reconnects === before.reconnects) {
      maxMisses = Math.max(maxMisses, seq.state.pollMisses)
      await new Promise((r) => setTimeout(r, 20))
    }
    stop = true
    await flood
    const rejected = logs.filter((l) => /定期的な取得を見送りました/.test(l.text))
    assert.equal(maxMisses, 0, '取りこぼし（pollMisses）に数えない')
    assert.equal(seq.state.counters.reconnects, before.reconnects, '再接続しない')
    assert.equal(seq.state.counters.joins, before.joins, 'PANA をやり直さない')
    assert.equal(seq.isConnected, true)
    assert.ok(!logs.some((l) => /連続でありません|再接続します/.test(l.text)), logs.filter((l) => /再接続/.test(l.text)).map((l) => l.text).join(' | '))
    assert.ok(rejected.length >= 3, '前提: 周期の取得が待ち行列の満杯で 3 回以上断られた（' + rejected.length + ' 回）')
    assert.ok(rejected.every((l) => l.level === 'warn'), 'ログは warn 1 行')
    assert.equal(other, 0, '滞留以外では断られていない')
    // フローの入力にも、滞留の印（queueFull）が付いて返る（待ち行列はまだ埋まっている）
    const errs = []
    for (let i = 0; i < seq.options.maxQueuedRequests + 1; i++) seq.get([0xe7], 'manual').catch((e) => errs.push(e))
    await new Promise((r) => setTimeout(r, 20))
    const full = errs.find((e) => /滞留/.test(e.message))
    assert.ok(full && full.queueFull === true, '滞留の CommandError に queueFull: true')
  } finally {
    stop = true
    await seq.destroy()
  }
})

test('setScanDurations: 構成の変更で次のスキャンから効き、前回うまくいった位置を忘れる（新しい並びの外を指して 1 回も撃たない、を起こさない）', async () => {
  // 戻すと落ちるもの: sequencer.js の setScanDurations で _lastGoodDurationIndex を消さない
  const { seq, transport, logs } = build({ minScanDuration: 8 }, { scanDurations: [4, 5, 6, 7, 8], knownChannelScanDurations: [] })
  await seq.start()
  await waitReady(seq, null, logs)
  assert.equal(seq._lastGoodDurationIndex, 4, '前提: 5 つ目（8）で見つかった')
  // 範囲の外・空は受けない（今のまま）
  assert.deepEqual(seq.setScanDurations([]), [4, 5, 6, 7, 8])
  assert.deepEqual(seq.setScanDurations(['x', 15]), [4, 5, 6, 7, 8])
  assert.equal(seq._lastGoodDurationIndex, 4)
  assert.deepEqual(seq.setScanDurations([8]), [8])
  assert.deepEqual(seq.options.scanDurations, [8])
  assert.equal(seq._lastGoodDurationIndex, null)
  assert.ok(logs.some((l) => /スキャンの段階を 8 にしました/.test(l.text)))
  // 再スキャン（段階 2）で新しい並びの 8 を撃つ。前の位置（4）のままだと 1 回も撃たない
  const before = transport.sent.filter((c) => c.startsWith('SKSCAN 2')).length
  await seq.reconnect('試験', 2)
  await waitFor(() => transport.sent.filter((c) => c.startsWith('SKSCAN 2')).length > before, 8000, '再スキャン')
  const scans = transport.sent.filter((c) => c.startsWith('SKSCAN 2')).slice(before)
  assert.equal(scans[0], 'SKSCAN 2 FFFFFFFF 8 0')
  await waitReady(seq, null, logs)
  await seq.destroy()
})
