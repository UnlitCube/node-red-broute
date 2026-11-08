const { test } = require('node:test')
const assert = require('node:assert/strict')
const EL = require('../lib/echonet')

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex')

test('Get 要求フレームを組み立てる (瞬時電力 単発)', () => {
  const f = EL.buildGet([0xe7], 0x0001)
  assert.equal(f.toString('hex').toUpperCase(), '1081000105FF0102880162' + '01' + 'E700')
  assert.equal(f.length, 14, 'アプリノートの 000E (14 バイト) と一致すること')
})

test('Get 要求は OPC>1 で複数 EPC をまとめられる', () => {
  const f = EL.buildGet([0xe7, 0xe8, 0xe0], 0x1234)
  assert.equal(f[11], 3, 'OPC = 3')
  assert.equal(f.length, 12 + 3 * 2)
  assert.equal(f.readUInt16BE(2), 0x1234, 'TID がそのまま入ること')
})

test('アプリノートの実受信フレームを解析できる', () => {
  // 出典: wsuha_broute.pdf p.22 の実測値 (436W)
  const buf = hex('1081 0001 028801 05FF01 72 01 E7 04 000001B4')
  const f = EL.parseFrame(buf)
  assert.ok(f)
  assert.equal(f.tid, 1)
  assert.equal(f.seoj, '028801', '応答では SEOJ がメーター側')
  assert.equal(f.deoj, '05FF01')
  assert.equal(f.esvName, 'Get_Res')
  assert.equal(f.isGetRes, true)
  assert.equal(f.fromMeter, true)
  assert.equal(f.opc, 1)
  assert.equal(f.props[0].epc, 0xe7)
  const v = EL.decode(0xe7, f.props[0].edt, {})
  assert.equal(v.value, 436, 'アプリノート記載の 0x01B4 = 436W')
  assert.equal(v.display, '436 W')
})

test('瞬時電力 0xE7 は符号付き (太陽光発電で負になる)', () => {
  const v = EL.decode(0xe7, hex('FFFFFE0C'), {})
  assert.equal(v.value, -500, '0xFFFFFE0C は -500W。符号なしで読むと 4294966796 になってしまう')
})

test('瞬時電力のオーバーフロー規定値は値なしにする', () => {
  assert.equal(EL.decode(0xe7, hex('7FFFFFFE'), {}).value, null)
  assert.equal(EL.decode(0xe7, hex('80000002'), {}).value, null)
})

test('瞬時電流 0xE8 は R/T 相それぞれ符号付き 0.1A 単位', () => {
  const v = EL.decode(0xe8, hex('0096 0032'), {})
  assert.deepEqual(v.value, { r: 15.0, t: 5.0 }, '0x0096=150 -> 15.0A, 0x0032=50 -> 5.0A')
  assert.equal(v.total, 20)
})

test('単相2線式で T 相が 0x7FFE のときは T 相を「なし」として扱う', () => {
  const v = EL.decode(0xe8, hex('0096 7FFE'), {})
  assert.equal(v.value.r, 15.0)
  assert.equal(v.value.t, null)
  assert.equal(v.total, 15.0, 'T 相なしなら合計は R 相のみ')
  assert.match(v.display, /単相 2 線/)
})

test('瞬時電流は逆潮流で負になる', () => {
  const v = EL.decode(0xe8, hex('FF9C 7FFE'), {})
  assert.equal(v.value.r, -10.0)
})

test('積算電力量 0xE0 は 0xD3 係数と 0xE1 単位を掛けないと kWh にならない', () => {
  const edt = hex('0001E240') // 123456 カウント
  const noCtx = EL.decode(0xe0, edt, {})
  assert.equal(noCtx.value, null, '係数・単位が未取得なら換算しない')
  assert.equal(noCtx.rawCount, 123456)
  assert.match(noCtx.note, /0xD3/)

  const withCtx = EL.decode(0xe0, edt, { coefficient: 1, unitFactor: 0.1 })
  assert.equal(withCtx.value, 12345.6, '123456 × 1 × 0.1kWh = 12345.6kWh')
  assert.equal(withCtx.display, '12345.6 kWh')

  const withCoeff = EL.decode(0xe0, edt, { coefficient: 10, unitFactor: 0.1 })
  assert.equal(withCoeff.value, 123456, '係数 10 が効くこと')
})

test('0xE1 積算電力量単位の対応表', () => {
  assert.equal(EL.decode(0xe1, hex('00'), {}).value, 1)
  assert.equal(EL.decode(0xe1, hex('01'), {}).value, 0.1)
  assert.equal(EL.decode(0xe1, hex('02'), {}).value, 0.01)
  assert.equal(EL.decode(0xe1, hex('0A'), {}).value, 10)
  assert.equal(EL.decode(0xe1, hex('0D'), {}).value, 10000)
  assert.equal(EL.decode(0xe1, hex('FF'), {}).value, null, '未定義値は null')
})

test('定時積算 0xEA は先頭7バイトが日時', () => {
  // 2026-09-24 09:30:00 / 1000000 カウント
  const edt = hex('07EA 09 18 09 1E 00 000F4240')
  const v = EL.decode(0xea, edt, { coefficient: 1, unitFactor: 0.1 })
  assert.equal(v.timestamp, '2026-09-24 09:30:00')
  assert.equal(v.value, 100000)
})

test('Get_SNA (読み出し不可応答) を取り違えない', () => {
  const f = EL.parseFrame(hex('1081 0001 028801 05FF01 52 01 E7 00'))
  assert.equal(f.isGetSna, true)
  assert.equal(f.isGetRes, false)
  assert.equal(f.esvName, 'Get_SNA')
  assert.equal(f.props[0].pdc, 0, 'SNA は EDT なし')
})

test('INF (自発通知) を識別する', () => {
  const f = EL.parseFrame(hex('1081 0000 028801 05FF01 73 01 80 01 30'))
  assert.equal(f.isInf, true)
  assert.equal(EL.decode(0x80, f.props[0].edt, {}).display, 'ON')
})

test('壊れたフレームは null を返す', () => {
  assert.equal(EL.parseFrame(hex('1082 0001 028801 05FF01 72 01 E7 04 000001B4')), null, 'EHD2 が違う')
  assert.equal(EL.parseFrame(hex('1081 00')), null, '短すぎる')
  assert.equal(EL.parseFrame(hex('1081 0001 028801 05FF01 72 01 E7 04 0000')), null, 'PDC がバッファ長を超える')
})

test('プロパティマップ (付表2 ビットマップ形式) を展開する', () => {
  // 先頭 = 16 以上 -> ビットマップ形式。bit0/列0 -> 0x80、bit0/列7 -> 0x87
  const edt = Buffer.alloc(17)
  edt[0] = 16
  edt[1] = 0b00000001 // 列0: bit0 -> 0x80
  edt[8] = 0b00000001 // 列7: bit0 -> 0x87
  const list = EL.decodePropertyMap(edt)
  assert.ok(list.includes(0x80))
  assert.ok(list.includes(0x87))
})

test('プロパティマップ (16未満 = 直値列挙形式)', () => {
  const list = EL.decodePropertyMap(hex('03 80 E7 E0'))
  assert.deepEqual(list, [0x80, 0xe7, 0xe0])
})

test('未知の EPC でも落ちずに生データを返す', () => {
  const v = EL.decode(0xff, hex('DEADBEEF'), {})
  assert.equal(v.value, 'DEADBEEF')
  assert.match(v.name, /不明な EPC/)
})

// ---------------------------------------------------------------------------
// 以下は取りこぼしの再発防止
// ---------------------------------------------------------------------------

test('EDT が短いとき、どの型でも黙ってゴミを返さない', () => {
  // 0x97 は長さを見ないと '12:undefined' という文字列が値として流れていた
  const hm = EL.decode(0x97, hex('0c'), {})
  assert.equal(hm.value, null)
  assert.match(hm.note, /長さ不足/)

  assert.equal(EL.decode(0x98, hex('07EA09'), {}).value, null, '0x98 は 4 バイト必要')
  assert.equal(EL.decode(0x80, Buffer.alloc(0), {}).value, null)
  assert.equal(EL.decode(0x88, Buffer.alloc(0), {}).value, null)
  assert.equal(EL.decode(0xe1, Buffer.alloc(0), {}).value, null)
  assert.equal(EL.decode(0xd7, Buffer.alloc(0), {}).value, null)
})

test('履歴が 48 コマ揃っていなければ換算済みとして扱わない', () => {
  // 電文が途中で切れたケースと「全コマ未計測」を区別できるようにする
  const short = EL.decode(0xe2, hex('0001 00000001 00000002'), { coefficient: 1, unitFactor: 0.1 })
  assert.equal(short.converted, false)
  assert.match(short.note, /48 コマ/)

  const full = Buffer.concat([hex('0001'), Buffer.alloc(48 * 4)])
  const ok = EL.decode(0xe2, full, { coefficient: 1, unitFactor: 0.1 })
  assert.equal(ok.value.length, 48)
  assert.equal(ok.converted, true)
  assert.equal(ok.note, undefined)
})
