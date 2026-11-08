'use strict'

// シミュレーター（lib/simulator-transport.js）の SKSREG の読み出し。
// 診断の「レジスタの読み出し」と、概要の「送信積算」（SFD）を dev で確かめられるようにするため。
// 応答の形は BP35C0 と同じ「ESREG <値>」→「OK」。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SimulatorTransport } = require('../../lib/simulator-transport')
const EL = require('../../lib/echonet')
const { Sequencer } = require('../../lib/sequencer')
const { ID, PW, waitFor } = require('./fake-red')

/** コマンドを 1 つ送り、OK か FAIL が来るまでの行を返す。 */
function send(t, command) {
  return new Promise((resolve, reject) => {
    const lines = []
    const timer = setTimeout(() => {
      t.removeListener('line', onLine)
      reject(new Error('応答がありません: ' + command + ' / ' + lines.join(' | ')))
    }, 2000)
    function onLine(buf) {
      const l = String(buf).trim()
      lines.push(l)
      if (/^(OK|FAIL)\b/.test(l)) {
        clearTimeout(timer)
        t.removeListener('line', onLine)
        resolve(lines)
      }
    }
    t.on('line', onLine)
    t.write(Buffer.from(command + '\r', 'ascii'))
  })
}

async function sreg(t, reg) {
  const lines = await send(t, 'SKSREG ' + reg)
  const e = lines.find((l) => /^ESREG /.test(l))
  assert.ok(e, `${reg}: ESREG が無い: ${lines.join(' | ')}`)
  assert.equal(lines[lines.length - 1], 'OK', `${reg}: 最後は OK`)
  return e.slice('ESREG '.length)
}

function newSim(extra) {
  return new SimulatorTransport(Object.assign({ latencyMs: 1, echo: false, echonetDelayMs: 1 }, extra))
}

/** ECHONET の Get を 1 回送る（SKSENDTO + データ）。EVENT 21 まで待つ。 */
function sendEchonet(t, epcs) {
  const frame = EL.buildGet(epcs, 1)
  const len = ('000' + frame.length.toString(16).toUpperCase()).slice(-4)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('EVENT 21 が来ません')), 2000)
    function onLine(buf) {
      if (/^EVENT 21 /.test(String(buf).trim())) {
        clearTimeout(timer)
        t.removeListener('line', onLine)
        resolve()
      }
    }
    t.on('line', onLine)
    t.write(Buffer.concat([Buffer.from(`SKSENDTO 1 ${t.config.meterIpv6} 0E1A 1 0 ${len} `, 'ascii'), frame]))
  })
}

test('SKSREG SFD: 送信時間の積算（ミリ秒・16 進）を返し、ECHONET を送るたびに増える', async () => {
  const t = newSim()
  await t.open()
  try {
    const v0 = await sreg(t, 'SFD')
    assert.match(v0, /^[0-9A-F]{8}$/, '32 ビットの 16 進 8 桁')
    assert.equal(parseInt(v0, 16), 0, '送る前は 0')
    // PANA を通してから ECHONET を送る
    await send(t, `SKSETPWD C ${PW}`)
    await send(t, `SKSETRBID ${ID}`)
    await send(t, `SKSREG S3 ${t.config.panId}`)
    await send(t, `SKJOIN ${t.config.meterIpv6}`)
    await new Promise((r) => setTimeout(r, t.config.joinMs + 50))
    await sendEchonet(t, [0xe7])
    const v1 = parseInt(await sreg(t, 'SFD'), 16)
    assert.ok(v1 > 0, '送ったぶん増える: ' + v1)
    await sendEchonet(t, [0xe7, 0xe8])
    const v2 = parseInt(await sreg(t, 'SFD'), 16)
    assert.ok(v2 > v1, `さらに増える: ${v1} → ${v2}`)
    // 上限（1 時間 360 秒）に比べて十分小さい（1 回あたり数ミリ秒）
    assert.ok(v2 < 1000, v2)
  } finally {
    await t.close()
  }
})

test('SFD の初期値は txTotalMs で決められる（概要のゲージを dev で動かして見るため）', async () => {
  const t = newSim({ txTotalMs: 123456 })
  await t.open()
  try {
    assert.equal(parseInt(await sreg(t, 'SFD'), 16), 123456)
  } finally {
    await t.close()
  }
})

test('許可リストのレジスタ（S02 S03 S07 S0A S15 S16 S17 SA2 SFD SFE SF0）に、すべて ESREG で答える', async () => {
  const t = newSim()
  await t.open()
  try {
    const before = {}
    for (const reg of ['S02', 'S03', 'S07', 'S0A', 'S15', 'S16', 'S17', 'SA2', 'SFD', 'SFE', 'SF0']) before[reg] = await sreg(t, reg)
    assert.equal(before.S02, '21', 'チャンネルの初期値')
    assert.equal(before.S03, 'FFFF', 'PAN ID の初期値')
    assert.match(before.S07, /^[0-9A-F]{8}$/, 'フレームカウンタ（32 ビット）')
    assert.equal(before.S0A, '00000000', 'Pairing ID は SKSETRBID の前は 0')
    assert.equal(before.S15, '1', 'ビーコン応答')
    assert.equal(parseInt(before.S16, 16), 86400, 'PANA セッションの寿命は 86400 秒')
    assert.equal(before.S17, '1', '自動再認証')
    assert.equal(before.SA2, '0', 'ERXUDP の RSSI は既定で付かない（sequencer が SA2 1 を送る）')
    assert.equal(before.SF0, '0')
    await send(t, `SKSETRBID ${ID}`)
    assert.equal(await sreg(t, 'S0A'), ID.slice(-8), 'Pairing ID は認証 ID の下 8 桁')
    await send(t, 'SKRESET')
    assert.equal(await sreg(t, 'S0A'), '00000000', 'SKRESET で初期値に戻る')
  } finally {
    await t.close()
  }
})

test('fail.sreg に挙げたレジスタは FAIL ER06（診断の失敗の試験に使う）・知らないレジスタも FAIL ER06', async () => {
  const t = newSim({ fail: { sreg: ['SFD'] } })
  await t.open()
  try {
    assert.deepEqual(await send(t, 'SKSREG SFD'), ['FAIL ER06'])
    assert.deepEqual(await send(t, 'SKSREG S99'), ['FAIL ER06'])
    assert.equal(await sreg(t, 'S02'), '21', 'ほかは答える')
  } finally {
    await t.close()
  }
})

/** SKSCAN を送り、EVENT 22 までの行を返す。 */
function scan(t, mask, duration) {
  return new Promise((resolve, reject) => {
    const lines = []
    const timer = setTimeout(() => reject(new Error('EVENT 22 が来ません')), 3000)
    function onLine(buf) {
      const l = String(buf).trim()
      lines.push(l)
      if (/^EVENT 22 /.test(l) || /^FAIL /.test(l)) {
        clearTimeout(timer)
        t.removeListener('line', onLine)
        resolve(lines)
      }
    }
    t.on('line', onLine)
    t.write(Buffer.from(`SKSCAN 2 ${mask} ${duration} 0\r`, 'ascii'))
  })
}

// 戻すと落ちるもの: _onScan が CHANNEL_MASK を読まない（違うチャネルのマスクでもメーターを返す）
test('SKSCAN は CHANNEL_MASK のチャネルだけを探す', async () => {
  const t = newSim({ scanTimeScale: 0.01 })
  await t.open()
  try {
    await send(t, `SKSETRBID ${ID}`)
    const found = (lines) => lines.filter((l) => l === 'EPANDESC').length
    assert.equal(found(await scan(t, '00000001', 6)), 0, 'ch33 だけのマスクに ch59 のメーターは出ない')
    assert.equal(found(await scan(t, '04000000', 6)), 1, 'ch59 のビット')
    assert.equal(found(await scan(t, 'FFFFFFFF', 6)), 1)
    assert.deepEqual(await send(t, 'SKSCAN 2 XYZ 6 0'), ['FAIL ER06'], '16 進でないマスクは断る')
  } finally {
    await t.close()
  }
})

// 戻すと落ちるもの: 時間と送信量を 28 チャネルの固定に戻す
test('1 チャネルのスキャンは、全チャネルの約 1/28 の送信で済む', async () => {
  const t = newSim({ scanTimeScale: 0.01 })
  await t.open()
  try {
    await scan(t, '04000000', 6)
    const one = t.state.txTotalMs
    await scan(t, 'FFFFFFFF', 6)
    const all = t.state.txTotalMs - one
    assert.equal(all, one * 28)
  } finally {
    await t.close()
  }
})

// 戻すと落ちるもの: state に muted・nsCount の初期値を置かない（undefined と比べて、設定の fail が効かない）
test('fail.mute と fail.ns は設定から効く', async () => {
  const frame = EL.buildGet([0xe7], 1)
  const len = ('000' + frame.length.toString(16).toUpperCase()).slice(-4)
  const sendTo = (t) => t.write(Buffer.concat([Buffer.from(`SKSENDTO 1 FE80::1 0E1A 1 0 ${len} `, 'ascii'), frame]))

  const mute = newSim({ fail: { mute: 1 } })
  await mute.open()
  try {
    mute.state.joined = true
    await sendTo(mute)
    assert.equal(mute.state.muted, 1)
    assert.equal(mute.state.stuck, true, '黙って固まる')
  } finally {
    await mute.close()
  }

  const ns = newSim({ fail: { ns: 2 } })
  await ns.open()
  try {
    ns.state.joined = true
    await sendTo(ns)
    assert.equal(ns.state.nsCount, 1)
  } finally {
    await ns.close()
  }
})

// 戻すと落ちるもの: SKRESET で rssiInErxudp を戻さない（SA2 を毎回入れ直さなくても試験が通ってしまう）
test('SKRESET で SA2 は初期値に戻る', async () => {
  const t = newSim()
  await t.open()
  try {
    await send(t, 'SKSREG SA2 1')
    assert.equal(await sreg(t, 'SA2'), '1')
    await send(t, 'SKRESET')
    assert.equal(await sreg(t, 'SA2'), '0')
  } finally {
    await t.close()
  }
})

test('既定のメーターは架空の値で、SKLL64 の応答が EUI-64 の変換と合う', async () => {
  const t = newSim()
  await t.open()
  try {
    const addr = t.config.meterAddr
    assert.equal(addr, '0011223344556677')
    assert.equal(t.config.panId, '1234')
    const lines = await new Promise((resolve) => {
      t.once('line', (b) => resolve(String(b).trim()))
      t.write(Buffer.from(`SKLL64 ${addr}\r`, 'ascii'))
    })
    const first = (parseInt(addr.slice(0, 2), 16) ^ 0x02).toString(16).toUpperCase().padStart(2, '0')
    const eui = first + addr.slice(2)
    assert.equal(lines, 'FE80:0000:0000:0000:' + eui.match(/.{4}/g).join(':'))
  } finally {
    await t.close()
  }
})

// 戻すと落ちるもの: 既定の pairId を戻す（試験と dev は pairId を渡すので、一般の手順だけが動かない）
test('既定のシミュレーターは、どの認証情報でもメーターを返す（PairID は認証 ID の下 8 桁に従う）', async () => {
  const t = newSim({ scanTimeScale: 0.01 })
  await t.open()
  try {
    await send(t, 'SKSETRBID FEDCBA9876543210FEDCBA9876543210')
    const lines = await scan(t, 'FFFFFFFF', 6)
    assert.ok(lines.includes('PairID:76543210'), lines.join(' | '))
    assert.equal(t.config.pairId, undefined)
  } finally {
    await t.close()
  }
})

test('pairId を指定すると、別の契約のメーターとして振る舞う', async () => {
  const t = newSim({ scanTimeScale: 0.01, pairId: 'FFFFFFFF' })
  await t.open()
  try {
    await send(t, `SKSETRBID ${ID}`)
    assert.ok((await scan(t, 'FFFFFFFF', 6)).includes('PairID:FFFFFFFF'))
  } finally {
    await t.close()
  }
})

test('設定なしの SimulatorTransport に Sequencer でつながる', async () => {
  const transport = new SimulatorTransport({ scanTimeScale: 0.01, latencyMs: 1, joinMs: 10 })
  const seq = new Sequencer(transport, { resetSettleMs: 20, scanDurations: [5] })
  seq.setCredentials(ID, PW, 'test')
  await seq.start()
  try {
    await waitFor(() => seq.isConnected, 8000, '接続')
    assert.equal(seq.snapshot().meter.pairId, ID.slice(-8))
  } finally {
    await seq.destroy()
  }
})
