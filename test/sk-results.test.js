'use strict'

// SKSTACK-IP の行とコマンドの結果を、JSON にそのまま変換できるただのオブジェクトに直す（lib/sk-results.js）。
// 出力の payload は「後ろに json ノードやパーサーを挟まずに使える」こと。
//
// 行の形は実機の応答に合わせた（先頭に残る LF・EINFO の末尾の空白・ROPT の「OK 00」・
// 1 発目の「FAIL ER04」・SFE=1 のエコーバック・スキャンの EVENT 20 → EPANDESC → EVENT 22 の並び）。
// 後半はシミュレーター（lib/simulator-transport.js）に実際にコマンドを送って返ってきた行で確かめる。
// 値は全部架空（認証 ID 0123456789ABCDEF0123456789ABCDEF・パスワード ABCDEF123456・PAN 8888 など）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const SK = require('../lib/sk-protocol')
const EL = require('../lib/echonet')
const SR = require('../lib/sk-results')
const { SimulatorTransport } = require('../lib/simulator-transport')

const OWN_IPV6 = 'FE80:0000:0000:0000:021D:1290:1234:5678'
const OWN_MAC = '001D129012345678'
const METER_ADDR = '12345678ABCDEF01'
const METER_IPV6 = 'FE80:0000:0000:0000:1034:5678:ABCD:EF01'
const PAN = '8888'
const PAIR = '89ABCDEF'
const ROUTE_B_ID = '0123456789ABCDEF0123456789ABCDEF'
const ROUTE_B_PWD = 'ABCDEF123456'

// ---------------------------------------------------------------------------
// ただのオブジェクトか（Buffer・Date・Map・関数・undefined・NaN・-0・循環を入れていないか）
// ---------------------------------------------------------------------------

function walkPlain(v, path) {
  if (v === null) return
  const t = typeof v
  if (t === 'string' || t === 'boolean') return
  if (t === 'number') {
    assert.ok(Number.isFinite(v) && !Object.is(v, -0), `${path} は有限の数であること（${v}）`)
    return
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      assert.ok(i in v, `${path}[${i}] が穴でないこと`)
      walkPlain(v[i], `${path}[${i}]`)
    }
    return
  }
  assert.equal(t, 'object', `${path} の型が ${t}`)
  assert.equal(Object.getPrototypeOf(v), Object.prototype, `${path} がただのオブジェクトであること`)
  for (const k of Object.keys(v)) walkPlain(v[k], `${path}.${k}`)
}

/** 結果がただのオブジェクトで、JSON の往復で変わらないことを確かめて返す。 */
function plain(value, label) {
  const name = label || '結果'
  walkPlain(value, name)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value, `${name}: JSON の往復で変わらないこと`)
  return value
}

// ---------------------------------------------------------------------------
// 試験用の電文
// ---------------------------------------------------------------------------

const hex2 = (n) => ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
const hex4 = (n) => ('000' + (n & 0xffff).toString(16).toUpperCase()).slice(-4)

/** ECHONET Lite の電文（メーター → コントローラ）を 16 進で。props は [[EPC, EDT の 16 進]]。 */
function elFrame(tid, esv, props) {
  return (
    '1081' + hex4(tid) + '028801' + '05FF01' + esv + hex2(props.length) +
    props.map(([epc, edt]) => epc + hex2(edt.length / 2) + edt).join('')
  )
}

/** ERXUDP の 1 行（BP35C0 の形: ... <SENDERLLA> [<RSSI>] <SECURED> <SIDE> <DATALEN> <DATA>）。 */
function erxudpLine(dataHex, opts) {
  const o = opts || {}
  const mid = o.mid || (o.rssi ? `${o.rssi} 1 0` : '1 0')
  const lport = o.lport || '0E1A'
  return `ERXUDP ${METER_IPV6} ${OWN_IPV6} 0E1A ${lport} ${METER_ADDR} ${mid} ${hex4(dataHex.length / 2)} ${dataHex}`
}

// sk-protocol.test.js にもある Get_Res（TID 1・E7 = 0x000001B4 = 436 W）
const GET_RES_E7 = '1081000102880105FF017201E704000001B4'

// ---------------------------------------------------------------------------
// sk-protocol.js に足したもの
// ---------------------------------------------------------------------------

test('sk-protocol: 診断で読む 11 個のレジスタに意味と単位がある', () => {
  const allowed = ['S02', 'S03', 'S07', 'S0A', 'S15', 'S16', 'S17', 'SA2', 'SFD', 'SFE', 'SF0']
  for (const r of allowed) {
    const m = SK.REGISTERS[r]
    assert.ok(m, `${r} が表にあること`)
    assert.equal(typeof m.name, 'string')
    assert.ok(m.name.length > 0)
    assert.equal(typeof m.desc, 'string')
    assert.ok(['channel', 'id', 'u32', 'seconds', 'ms', 'flag', 'enum'].indexOf(m.kind) >= 0, `${r} の kind`)
  }
  assert.equal(SK.REGISTERS.S16.unit, '秒')
  assert.equal(SK.REGISTERS.SFD.unit, 'ms')
  assert.equal(SK.REGISTERS.SFD.limitMs, 360000, 'ARIB STD-T108 の 1 時間あたり 360 秒')
  plain(SK.REGISTERS, 'REGISTERS')
  plain(SK.TABLES, 'TABLES')
})

test('sk-protocol: レジスタ名をそろえる（S2 → S02、sa → S0A。SA2・SFD はそのまま）', () => {
  assert.equal(SK.normalizeRegister('S2'), 'S02')
  assert.equal(SK.normalizeRegister('s3'), 'S03')
  assert.equal(SK.normalizeRegister('SA'), 'S0A')
  assert.equal(SK.normalizeRegister(' sfd '), 'SFD')
  assert.equal(SK.normalizeRegister('SA2'), 'SA2')
  assert.equal(SK.normalizeRegister('S16'), 'S16')
  assert.equal(SK.normalizeRegister(undefined), '')
})

test('sk-protocol: EPANDESC の明細行はマニュアルの 7 つのキーだけ', () => {
  assert.equal(SK.isEpandescField('  Channel:21'), true)
  assert.equal(SK.isEpandescField('  Channel Page:09\r'), true)
  assert.equal(SK.isEpandescField('  PairID:' + PAIR), true)
  assert.equal(SK.isEpandescField(`SKSENDTO 1 ${METER_IPV6} 0E1A 1 0 000E`), false, 'コロンを含むエコーを明細にしない')
  assert.equal(SK.isEpandescField('Foo:1'), false)
  assert.ok(SK.EPANDESC_KEYS instanceof RegExp)
})

test('sk-protocol: 今までの関数の形はそのまま', () => {
  for (const k of ['ERROR_CODES', 'EVENTS', 'UDP_RESULT', 'channelToMHz', 'parseLine', 'newAccumulator', 'feed', 'flush', 'parseEpandesc', 'parseEedscan']) {
    assert.ok(SK[k] !== undefined, `${k} が残っていること`)
  }
  assert.equal(SK.parseLine('ESREG 0021').value, '0021')
  assert.equal(SK.parseLine('EVER 1.5.2').version, '1.5.2')
})

// ---------------------------------------------------------------------------
// describeLine: 1 行
// ---------------------------------------------------------------------------

test('describeLine: OK と FAIL（実機の先頭の LF・末尾の CR を落とす）', () => {
  assert.deepEqual(plain(SR.describeLine('\nOK')), { kind: 'ok', parsed: { value: null } })
  assert.deepEqual(plain(SR.describeLine('\nOK 00\r')), { kind: 'ok', parsed: { value: '00' } }, 'ROPT の応答（実測: 0A 4F 4B 20 30 30 0D）')

  // 実機の 1 発目の FAIL ER04（入力バッファに前のフローの書きかけが残っていた）
  const f = plain(SR.describeLine('\nFAIL ER04'))
  assert.deepEqual(f, {
    kind: 'fail',
    parsed: { code: 'ER04', message: SK.ERROR_CODES.ER04.message, advice: SK.ERROR_CODES.ER04.advice, retryable: false },
  })
  assert.equal(plain(SR.describeLine('FAIL ER10')).parsed.retryable, true)
  assert.equal(plain(SR.describeLine('FAIL')).parsed.code, 'FAIL')
  const unknown = plain(SR.describeLine('FAIL ER11'))
  assert.equal(unknown.parsed.message, '未知のエラーコード')
  assert.equal(unknown.parsed.advice, '')
})

test('describeLine: EVENT（名前・重さ・送り元・面・PARAM と UDP の送信結果）', () => {
  assert.deepEqual(plain(SR.describeLine(`EVENT 25 ${METER_IPV6} 0`)), {
    kind: 'event',
    parsed: { num: 0x25, numHex: '25', name: 'PANA 接続完了', severity: 'good', sender: METER_IPV6, side: 0, param: null },
  })
  const ns = plain(SR.describeLine(`EVENT 21 ${METER_IPV6} 0 02`))
  assert.equal(ns.parsed.param, 2)
  assert.deepEqual(ns.parsed.udp, SK.UDP_RESULT[2])
  assert.equal(plain(SR.describeLine(`EVENT 1f ${OWN_IPV6} 0`)).parsed.numHex, '1F')
  assert.equal(plain(SR.describeLine('EVENT 32 FE80:0000:0000:0000:0000:0000:0000:0000 FF')).parsed.severity, 'error')

  // 壊れた EVENT 行でも NaN を出さない（JSON にすると null に化けて往復で変わる）
  const broken = plain(SR.describeLine('EVENT ZZ'))
  assert.equal(broken.kind, 'event')
  assert.equal(broken.parsed.num, null)
  assert.equal(broken.parsed.name, '未定義イベント')
})

test('describeLine: ERXUDP を 16 進のデータと ECHONET Lite の解釈まで分ける', () => {
  const d = plain(SR.describeLine(erxudpLine(GET_RES_E7)))
  assert.equal(d.kind, 'erxudp')
  assert.deepEqual(d.parsed, {
    sender: METER_IPV6,
    dest: OWN_IPV6,
    rport: 0x0e1a,
    lport: 0x0e1a,
    senderLla: METER_ADDR,
    rssiHex: null,
    secured: true,
    side: 0,
    datalen: 18,
    data: GET_RES_E7,
    encoding: 'hex',
    echonet: {
      tid: 1,
      seoj: '028801',
      seojName: '低圧スマート電力量メータ',
      deoj: '05FF01',
      deojName: 'コントローラ',
      esv: '72',
      esvName: 'Get_Res',
      opc: 1,
      props: [{ epc: 'E7', name: '瞬時電力計測値', unit: 'W', pdc: 4, edt: '000001B4', value: 436, display: '436 W' }],
    },
  })
})

test('describeLine: ERXUDP の RSSI つき（SA2=1）・SIDE なし（BP35A1 の形）も同じ解釈', () => {
  const withRssi = plain(SR.describeLine(erxudpLine(GET_RES_E7, { rssi: 'C8' })))
  assert.equal(withRssi.parsed.rssiHex, 'C8')
  assert.equal(withRssi.parsed.secured, true)
  assert.equal(withRssi.parsed.side, 0)
  assert.equal(withRssi.parsed.echonet.props[0].value, 436)

  const noSide = plain(SR.describeLine(erxudpLine(GET_RES_E7, { mid: '1' })))
  assert.equal(noSide.parsed.secured, true)
  assert.equal(noSide.parsed.side, null)
  assert.equal(noSide.parsed.echonet.props[0].value, 436)

  const plainText = plain(SR.describeLine(erxudpLine(GET_RES_E7, { mid: '0 0' })))
  assert.equal(plainText.parsed.secured, false, 'SECURED=0 は暗号化なし')
})

test('describeLine: ERXUDP が 16 進でない・データ無し・ECHONET でない', () => {
  const broken = plain(SR.describeLine(`ERXUDP ${METER_IPV6} ${OWN_IPV6} 0E1A 0E1A ${METER_ADDR} 1 0 0012 ????`))
  assert.equal(broken.parsed.encoding, 'binary-or-broken')
  assert.equal(broken.parsed.data, null, '16 進でないデータを 16 進の欄に入れない')
  assert.equal(broken.parsed.echonet, null)
  assert.match(broken.parsed.note, /WOPT 01/)

  const empty = plain(SR.describeLine(`ERXUDP ${METER_IPV6} ${OWN_IPV6} 0E1A 0E1A ${METER_ADDR} 1 0 0000`))
  assert.equal(empty.parsed.encoding, 'empty')
  assert.equal(empty.parsed.datalen, 0)
  assert.equal(empty.parsed.data, '')
  assert.equal(empty.parsed.secured, true)
  assert.equal(empty.parsed.side, 0)
  assert.equal(empty.parsed.echonet, null)
  assert.equal(empty.parsed.note, undefined)

  // PANA (02CC) の電文は ECHONET Lite ではない
  const pana = plain(SR.describeLine(erxudpLine('0000001C00000002', { lport: '02CC' })))
  assert.equal(pana.parsed.encoding, 'hex')
  assert.equal(pana.parsed.lport, 0x02cc)
  assert.equal(pana.parsed.echonet, null)

  // ポートが 16 進でない壊れた行でも NaN を出さない
  const badPort = plain(SR.describeLine(`ERXUDP ${METER_IPV6} ${OWN_IPV6} XX YY ${METER_ADDR} 1 0 0012 ${GET_RES_E7}`))
  assert.equal(badPort.parsed.rport, null)
  assert.equal(badPort.parsed.lport, null)
})

test('describeLine: ECHONET の値（積算は係数と単位があれば kWh・電流・定時積算・プロパティマップ・Get_SNA）', () => {
  const frame = elFrame(0x0042, '72', [
    ['E0', '0001E240'], // 123456 カウント
    ['E8', '0096012C'], // R 相 15.0 A / T 相 30.0 A
    ['EA', '07EA0B060A0000' + '0001E240'], // 2026-11-06 10:00:00
    ['9F', '038088E7'],
    ['8D', Buffer.from('TEST000001', 'ascii').toString('hex').toUpperCase()],
  ])
  const raw = plain(SR.describeLine(erxudpLine(frame)))
  const byEpc = (d) => Object.fromEntries(d.parsed.echonet.props.map((p) => [p.epc, p]))
  const a = byEpc(raw)
  assert.equal(raw.parsed.echonet.tid, 0x42)
  assert.equal(a.E0.value, null, '係数と単位が分からなければ kWh にしない')
  assert.equal(a.E0.rawCount, 123456)
  assert.match(a.E0.note, /0xD3/)
  assert.deepEqual(a.E8.value, { r: 15, t: 30 })
  assert.equal(a.E8.total, 45)
  assert.equal(a.E8.unit, 'A')
  assert.equal(a.EA.timestamp, '2026-11-06 10:00:00')
  assert.deepEqual(a['9F'].value, ['80', '88', 'E7'], 'プロパティマップは EPC の 16 進で（出力 1 の getPropertyMap と同じ）')
  assert.equal(a['8D'].value, 'TEST000001')

  const conv = plain(SR.describeLine(erxudpLine(frame), { coefficient: 1, unitFactor: 0.1 }))
  const b = byEpc(conv)
  assert.equal(b.E0.value, 12345.6)
  assert.equal(b.E0.coefficient, 1)
  assert.equal(b.E0.unitFactor, 0.1)
  assert.equal(b.EA.value, 12345.6)

  // Get_SNA: 持っていない値は PDC=0 で返る
  const sna = plain(SR.describeLine(erxudpLine(elFrame(0x0043, '52', [['E7', '000001B4'], ['81', '']]))))
  assert.equal(sna.parsed.echonet.esvName, 'Get_SNA')
  const s = byEpc(sna)
  assert.equal(s.E7.value, 436)
  assert.equal(s['81'].pdc, 0)
  assert.equal(s['81'].edt, '')
  assert.equal(s['81'].value, null)
  assert.equal(s['81'].name, '設置場所')
  assert.match(s['81'].note, /PDC=0/)

  // 知らない EPC は名前を作って値は生の 16 進
  const unknown = plain(SR.describeLine(erxudpLine(elFrame(0x0044, '72', [['F5', '0102']]))))
  assert.equal(unknown.parsed.echonet.props[0].name, '不明な EPC 0xF5')
  assert.equal(unknown.parsed.echonet.props[0].value, '0102')
})

test('describeLine: EINFO（実機の末尾の空白つき）は SKINFO と同じ形', () => {
  // 実測の書式: EINFO <IPADDR> <ADDR64> <CH> <PAN> <SIDE> <空白>
  const d = plain(SR.describeLine(`\nEINFO ${OWN_IPV6} ${OWN_MAC} 21 FFFF 0 \r`))
  assert.deepEqual(d, {
    kind: 'einfo',
    parsed: { ipv6: OWN_IPV6, mac: OWN_MAC, channel: 33, channelHex: '21', channelMHz: 922.5, panId: 'FFFF', side: 0, addr16: null },
  })
  const joined = plain(SR.describeLine(`EINFO ${OWN_IPV6} ${OWN_MAC} 3B ${PAN} 0 `))
  assert.equal(joined.parsed.channel, 59)
  assert.equal(joined.parsed.channelMHz, 927.7)
  assert.equal(joined.parsed.panId, PAN)
  // BP35A1 の書式（5 つ目が ADDR16）
  const a1 = plain(SR.describeLine(`EINFO ${OWN_IPV6} ${OWN_MAC} 21 ${PAN} FFFE`))
  assert.equal(a1.parsed.addr16, 'FFFE')
  assert.equal(a1.parsed.side, null)
})

test('describeLine: EVER・EAPPVER・ESREG・EPONG・SKLL64 の応答・エコー・空行・その他', () => {
  assert.deepEqual(plain(SR.describeLine('\nEVER 1.5.2')), { kind: 'ever', parsed: { version: '1.5.2' } })
  assert.deepEqual(plain(SR.describeLine('EAPPVER simulator')), { kind: 'eappver', parsed: { appVersion: 'simulator' } })
  assert.deepEqual(plain(SR.describeLine('ESREG 21')), {
    kind: 'esreg',
    parsed: { register: null, raw: '21', value: '21', unit: null, meaning: null, description: null, text: null },
  })
  // どのレジスタを読んだかが分かれば（ctx.command）、意味と単位まで
  const s16 = plain(SR.describeLine('ESREG 00015180', { command: 'SKSREG S16' }))
  assert.equal(s16.parsed.register, 'S16')
  assert.equal(s16.parsed.value, 86400)
  assert.equal(s16.parsed.unit, '秒')
  assert.equal(s16.parsed.meaning, 'PANA セッションの寿命')

  assert.deepEqual(plain(SR.describeLine(`EPONG 0 ${METER_IPV6}`)), { kind: 'epong', parsed: { side: 0, sender: METER_IPV6 } })
  assert.deepEqual(plain(SR.describeLine(METER_IPV6)), { kind: 'ipv6', parsed: { ipv6: METER_IPV6 } })

  // エコーバック（SFE=1 の実測: 送った SKVER がそのまま返る）
  assert.deepEqual(plain(SR.describeLine('\nSKVER')), { kind: 'echo', parsed: { command: 'SKVER', args: [] } })
  assert.deepEqual(plain(SR.describeLine('SKSREG S2 21')), { kind: 'echo', parsed: { command: 'SKSREG', args: ['S2', '21'] } })
  assert.deepEqual(plain(SR.describeLine('WOPT 01')), { kind: 'echo', parsed: { command: 'WOPT', args: ['01'] } })
  // 認証情報を書くコマンドのエコーは、引数を parsed に写さない
  for (const line of [`SKSETPWD C ${ROUTE_B_PWD}`, `SKSETRBID ${ROUTE_B_ID}`]) {
    const e = plain(SR.describeLine(line))
    assert.equal(e.kind, 'echo')
    assert.equal(e.parsed.args, null)
    assert.equal(e.parsed.masked, true)
    const json = JSON.stringify(e)
    assert.ok(json.indexOf(ROUTE_B_PWD) < 0 && json.indexOf(ROUTE_B_ID) < 0, 'parsed に認証情報が入らないこと')
  }

  assert.deepEqual(plain(SR.describeLine('')), { kind: 'blank', parsed: null })
  assert.deepEqual(plain(SR.describeLine('\r\n')), { kind: 'blank', parsed: null })
  assert.deepEqual(plain(SR.describeLine('hello world')), { kind: 'other', parsed: null })
  assert.deepEqual(plain(SR.describeLine(undefined)), { kind: 'blank', parsed: null })
  // Buffer（シリアルの行そのまま）も受ける
  assert.deepEqual(plain(SR.describeLine(Buffer.from('\nEVER 1.5.2\r', 'latin1'))), { kind: 'ever', parsed: { version: '1.5.2' } })
})

test('describeLine: 複数行の見出しと明細（EPANDESC は見出しなしでも、EEDSCAN と表は文脈で）', () => {
  assert.deepEqual(plain(SR.describeLine('EPANDESC')), { kind: 'epandesc', parsed: { part: 'start' } })
  assert.deepEqual(plain(SR.describeLine('  Channel:21')), {
    kind: 'epandesc',
    parsed: { part: 'field', key: 'Channel', field: 'channel', raw: '21', value: 33, channelMHz: 922.5 },
  })
  assert.deepEqual(plain(SR.describeLine('  Pan ID:' + PAN)).parsed, { part: 'field', key: 'Pan ID', field: 'panId', raw: PAN, value: PAN })
  assert.equal(plain(SR.describeLine('  LQI:E1')).parsed.value, 0xe1)
  assert.equal(plain(SR.describeLine('  Channel Page:09')).parsed.value, '09')
  assert.equal(plain(SR.describeLine('  PairID:' + PAIR)).parsed.field, 'pairId')

  assert.deepEqual(plain(SR.describeLine('EEDSCAN')), { kind: 'eedscan', parsed: { part: 'start' } })
  // ED スキャンのデータ行は、見出しの後でなければ分からない
  assert.equal(plain(SR.describeLine('0 21 04 22 04 23 03')).kind, 'other')
  const inEd = SR.nextContext(null, 'EEDSCAN')
  assert.deepEqual(plain(SR.describeLine('0 21 04 22 04 23 03', inEd)), {
    kind: 'eedscan',
    parsed: {
      part: 'data',
      side: 0,
      channels: [
        { channel: 33, channelMHz: 922.5, rssi: 4 },
        { channel: 34, channelMHz: 922.7, rssi: 4 },
        { channel: 35, channelMHz: 922.9, rssi: 3 },
      ],
    },
  })

  assert.deepEqual(plain(SR.describeLine('EADDR')), { kind: 'etable', parsed: { part: 'start', name: 'EADDR', title: SK.TABLES.EADDR.title } })
  const inAddr = SR.nextContext(null, 'EADDR')
  assert.deepEqual(plain(SR.describeLine(OWN_IPV6, inAddr)), {
    kind: 'etable',
    parsed: { part: 'row', name: 'EADDR', tokens: [OWN_IPV6], ipv6: OWN_IPV6 },
  })
  const inNbr = SR.nextContext(null, 'ENEIGHBOR')
  assert.deepEqual(plain(SR.describeLine(`${METER_IPV6} ${METER_ADDR}`, inNbr)), {
    kind: 'etable',
    parsed: { part: 'row', name: 'ENEIGHBOR', tokens: [METER_IPV6, METER_ADDR], ipv6: METER_IPV6, mac: METER_ADDR },
  })
  // 見出しの意味が分からない表（ESEC など）は、トークンだけ
  const inSec = SR.nextContext(null, 'ESEC')
  assert.deepEqual(plain(SR.describeLine('01 02 03', inSec)).parsed, { part: 'row', name: 'ESEC', tokens: ['01', '02', '03'] })
  assert.equal(plain(SR.describeLine('ESEC')).parsed.title, null)
})

// ---------------------------------------------------------------------------
// nextContext / createLineDescriber: 行の並び（シーケンサーの feed と同じ区切り方）
// ---------------------------------------------------------------------------

function describeAll(lines, extra) {
  const d = SR.createLineDescriber()
  return lines.map((l) => plain(d.describe(l, extra)))
}

test('行の並び: スキャン（実機の並び OK → EVENT 20 → EPANDESC → EVENT 22）', () => {
  const lines = [
    '\nOK',
    `EVENT 20 ${METER_IPV6} 0`,
    'EPANDESC',
    '  Channel:21',
    '  Channel Page:09',
    '  Pan ID:' + PAN,
    '  Addr:' + METER_ADDR,
    '  LQI:62',
    '  Side:0',
    '  PairID:' + PAIR,
    `EVENT 22 ${OWN_IPV6} 0`,
  ]
  const out = describeAll(lines)
  assert.deepEqual(
    out.map((d) => d.kind),
    ['ok', 'event', 'epandesc', 'epandesc', 'epandesc', 'epandesc', 'epandesc', 'epandesc', 'epandesc', 'epandesc', 'event']
  )
  assert.deepEqual(out.slice(3, 10).map((d) => d.parsed.field), ['channel', 'channelPage', 'panId', 'addr', 'lqi', 'side', 'pairId'])
  assert.equal(out[10].parsed.num, 0x22)
})

test('行の並び: 表の途中に割り込んだ ERXUDP と EVENT を行にしない・OK で表を閉じる', () => {
  const lines = ['ENEIGHBOR', `${METER_IPV6} ${METER_ADDR}`, erxudpLine(GET_RES_E7), `EVENT 26 ${METER_IPV6} 0`, 'OK', OWN_IPV6]
  const out = describeAll(lines)
  assert.deepEqual(out.map((d) => d.kind), ['etable', 'etable', 'erxudp', 'event', 'ok', 'ipv6'])
  assert.equal(out[2].parsed.echonet.props[0].value, 436)
})

test('行の並び: EEDSCAN の前に割り込んだ EVENT 33 をデータにしない', () => {
  const lines = [`EVENT 1F ${OWN_IPV6} 0`, 'EEDSCAN', 'EVENT 33 FE80:0000:0000:0000:0000:0000:0000:0000 FF', '0 21 04 22 04', '0 21 04']
  const out = describeAll(lines)
  assert.deepEqual(out.map((d) => d.kind), ['event', 'eedscan', 'event', 'eedscan', 'other'])
  assert.equal(out[3].parsed.part, 'data')
  assert.equal(out[3].parsed.channels.length, 2)
})

test('行の並び: 閉じない表でも、ほかの応答（EVER・EINFO）を表の行にしない', () => {
  const out = describeAll(['EADDR', OWN_IPV6, 'EVER 1.5.2', `EINFO ${OWN_IPV6} ${OWN_MAC} 21 FFFF 0 `])
  assert.deepEqual(out.map((d) => d.kind), ['etable', 'etable', 'ever', 'einfo'])
})

test('行の並び: 終端が来ない複数行は 2 秒で閉じる（シーケンサーの flush と同じ）', () => {
  let now = 1000
  const d = SR.createLineDescriber({ now: () => now })
  assert.equal(d.describe('EADDR').kind, 'etable')
  now += 1500
  assert.equal(d.describe(OWN_IPV6).kind, 'etable', '2 秒以内は表の続き')
  assert.deepEqual(plain(d.context()), { multiline: { name: 'EADDR', mode: 'until-ok', expect: 0, rows: 1 } })
  now += 2001
  assert.equal(d.describe(METER_IPV6).kind, 'ipv6', '2 秒を過ぎたら表は閉じている')
  d.reset()
  assert.deepEqual(d.context(), { multiline: null })
})

test('nextContext は渡した文脈を書き換えず、JSON にできる形を返す', () => {
  const ctx = Object.freeze({ multiline: Object.freeze({ name: 'EADDR', mode: 'until-ok', expect: 0, rows: 2 }), coefficient: 1 })
  const before = JSON.stringify(ctx)
  const next = plain(SR.nextContext(ctx, OWN_IPV6))
  assert.equal(JSON.stringify(ctx), before)
  assert.deepEqual(next, { multiline: { name: 'EADDR', mode: 'until-ok', expect: 0, rows: 3 }, coefficient: 1 })
  assert.deepEqual(plain(SR.nextContext(next, 'OK')), { multiline: null, coefficient: 1 })
  // EPANDESC (kv) は明細以外の行で閉じる。EEDSCAN (lines) は 1 行で閉じる
  const kv = SR.nextContext(SR.nextContext(null, 'EPANDESC'), '  Channel:21')
  assert.equal(kv.multiline.name, 'EPANDESC')
  assert.equal(SR.nextContext(kv, `EVENT 22 ${OWN_IPV6} 0`).multiline, null)
  assert.equal(SR.nextContext(SR.nextContext(null, 'EEDSCAN'), '0 21 04').multiline, null)
  // エコーは文脈を変えない（feed と同じ）
  assert.deepEqual(SR.nextContext({ multiline: null }, 'SKTABLE 1'), { multiline: null })
})

// ---------------------------------------------------------------------------
// parseCommandResult: コマンドごとの結果
// ---------------------------------------------------------------------------

test('parseCommandResult: SKINFO・SKVER（エコーつきの実測の形）・SKAPPVER', () => {
  const info = plain(SR.parseCommandResult('SKINFO', [`\nEINFO ${OWN_IPV6} ${OWN_MAC} 3B ${PAN} 0 \r`, '\nOK\r']))
  assert.deepEqual(info, {
    ok: true,
    lines: [`EINFO ${OWN_IPV6} ${OWN_MAC} 3B ${PAN} 0 `, 'OK'],
    parsed: { ipv6: OWN_IPV6, mac: OWN_MAC, channel: 59, channelHex: '3B', channelMHz: 927.7, panId: PAN, side: 0, addr16: null },
    error: null,
  })

  const ver = plain(SR.parseCommandResult('SKVER', ['\nSKVER', '\nEVER 1.5.2', '\nOK']))
  assert.deepEqual(ver, { ok: true, lines: ['SKVER', 'EVER 1.5.2', 'OK'], parsed: { version: '1.5.2' }, error: null })
  assert.deepEqual(plain(SR.parseCommandResult(' skver ', ['EVER 1.5.2', 'OK'])).parsed, { version: '1.5.2' }, '小文字と前後の空白')

  assert.deepEqual(plain(SR.parseCommandResult('SKAPPVER', ['EAPPVER simulator', 'OK'])).parsed, { appVersion: 'simulator' })
})

test('parseCommandResult: FAIL ERxx は ok: false と error（ERROR_CODES の日本語）', () => {
  // 実機の 1 発目
  const r = plain(SR.parseCommandResult('SKVER', ['\nFAIL ER04']))
  assert.deepEqual(r, {
    ok: false,
    lines: ['FAIL ER04'],
    parsed: null,
    error: { code: 'ER04', message: SK.ERROR_CODES.ER04.message, advice: SK.ERROR_CODES.ER04.advice, retryable: false },
  })
  const sreg = plain(SR.parseCommandResult('SKSREG SFD', ['FAIL ER06']))
  assert.equal(sreg.ok, false)
  assert.equal(sreg.error.code, 'ER06')
  assert.equal(sreg.error.message, SK.ERROR_CODES.ER06.message)
  // 失敗のあとに繰り返して通ったら、最後の成否で決める
  const retried = plain(SR.parseCommandResult('SKVER', ['FAIL ER04', 'EVER 1.5.2', 'OK']))
  assert.equal(retried.ok, true)
  assert.deepEqual(retried.parsed, { version: '1.5.2' })
})

test('parseCommandResult: 応答が無い・行が配列でない', () => {
  const none = plain(SR.parseCommandResult('SKINFO', []))
  assert.equal(none.ok, false)
  assert.equal(none.parsed, null)
  assert.equal(none.error.code, 'NO_RESPONSE')
  assert.deepEqual(plain(SR.parseCommandResult('SKINFO', undefined)).lines, [])
  assert.deepEqual(plain(SR.parseCommandResult(undefined, 'OK')).lines, [])
  // EINFO が来たが OK がまだ（途中で時間切れ）
  const partial = plain(SR.parseCommandResult('SKINFO', [`EINFO ${OWN_IPV6} ${OWN_MAC} 21 FFFF 0 `]))
  assert.equal(partial.ok, false)
  assert.equal(partial.error.code, 'NO_RESPONSE')
})

test('parseCommandResult: ROPT は WOPT の値と ERXUDP の表示（bit0）', () => {
  assert.deepEqual(plain(SR.parseCommandResult('ROPT', ['\nOK 00\r'])).parsed, { wopt: 0, woptHex: '00', erxudpFormat: 'binary' })
  assert.deepEqual(plain(SR.parseCommandResult('ROPT', ['OK 01'])).parsed, { wopt: 1, woptHex: '01', erxudpFormat: 'hex' })
  assert.deepEqual(plain(SR.parseCommandResult('ROPT', ['OK 03'])).parsed, { wopt: 3, woptHex: '03', erxudpFormat: 'hex' })
  assert.deepEqual(plain(SR.parseCommandResult('ROPT', ['OK'])).parsed, { wopt: null, woptHex: null, erxudpFormat: null })
})

test('parseCommandResult: SKSREG の 11 個の意味と単位', () => {
  const read = (reg, value) => plain(SR.parseCommandResult(`SKSREG ${reg}`, [`ESREG ${value}`, 'OK']), reg).parsed

  const s02 = read('S02', '21')
  assert.equal(s02.register, 'S02')
  assert.equal(s02.raw, '21')
  assert.equal(s02.value, 33)
  assert.equal(s02.unit, 'ch')
  assert.equal(s02.meaning, 'チャネル')
  assert.equal(s02.channelMHz, 922.5)
  assert.equal(s02.text, '33 ch（922.5 MHz）')
  assert.equal(s02.written, false)
  assert.equal(read('S2', '3B').register, 'S02', 'S2 の書き方もそろえる')

  assert.equal(read('S03', PAN).value, PAN)
  assert.equal(read('S03', PAN).meaning, 'PAN ID')
  assert.equal(read('S03', 'FFFF').text, '未設定（FFFF）')
  assert.equal(read('S07', '0000002A').value, 42)
  assert.equal(read('S07', '0000002A').meaning, 'フレームカウンター')
  assert.equal(read('S0A', PAIR).value, PAIR)
  assert.equal(read('S0A', '00000000').text, '未設定（00000000）')
  assert.equal(read('S15', '1').text, '応答する')
  assert.equal(read('S15', '0').text, '応答しない')

  const s16 = read('S16', '00015180')
  assert.equal(s16.value, 86400)
  assert.equal(s16.unit, '秒')
  assert.equal(s16.text, '86400 秒（24 時間）')
  assert.equal(read('S16', '0000003C').text, '60 秒（1 分）')

  assert.equal(read('S17', '1').text, '有効')
  assert.equal(read('SA2', '0').text, '付けない')
  assert.equal(read('SA2', '1').text, '付ける')

  const sfd = read('SFD', '00000BB8')
  assert.equal(sfd.value, 3000)
  assert.equal(sfd.unit, 'ms')
  assert.equal(sfd.meaning, '送信時間の積算')
  assert.equal(sfd.limitMs, 360000)
  assert.equal(sfd.percent, 0.8)
  assert.match(sfd.text, /^3000 ms（3\.0 秒/)

  assert.equal(read('SFE', '0').text, 'しない')
  assert.equal(read('SF0', '0').text, 'B ルート')
  assert.equal(read('SF0', '1').text, 'HAN')
  assert.equal(read('SF0', '7').text, '不明（7）')
  for (const r of ['S02', 'S03', 'S07', 'S0A', 'S15', 'S16', 'S17', 'SA2', 'SFD', 'SFE', 'SF0']) {
    assert.equal(typeof read(r, '1').description, 'string', `${r} の説明`)
  }

  // 読めない値・分からないレジスタ
  const bad = read('S16', 'ZZ')
  assert.equal(bad.value, null)
  assert.equal(bad.text, '読めない値（ZZ）')
  const unknown = read('S01', OWN_MAC)
  assert.deepEqual(unknown, { register: 'S01', raw: OWN_MAC, value: OWN_MAC, unit: null, meaning: null, description: null, text: null, written: false })

  // 書き込み（SKSREG S2 21）は、書いた値の意味
  const w = plain(SR.parseCommandResult('SKSREG S2 21', ['OK'])).parsed
  assert.equal(w.written, true)
  assert.equal(w.register, 'S02')
  assert.equal(w.value, 33)
})

test('parseCommandResult: SKTABLE は表を配列に', () => {
  const t1 = plain(SR.parseCommandResult('SKTABLE 1', ['EADDR', OWN_IPV6, 'OK']))
  assert.equal(t1.ok, true)
  assert.deepEqual(t1.parsed, { table: '1', name: 'EADDR', title: SK.TABLES.EADDR.title, rows: [{ tokens: [OWN_IPV6], ipv6: OWN_IPV6 }] })

  // 計測値（ERXUDP）と自発イベントが割り込んでも、表は本物の行だけ
  const t2 = plain(
    SR.parseCommandResult('SKTABLE 2', ['ENEIGHBOR', `${METER_IPV6} ${METER_ADDR}`, erxudpLine(GET_RES_E7), `EVENT 29 ${METER_IPV6} 0`, 'OK'])
  )
  assert.deepEqual(t2.parsed.rows, [{ tokens: [METER_IPV6, METER_ADDR], ipv6: METER_IPV6, mac: METER_ADDR }])
  assert.equal(t2.lines.length, 5, 'lines は受け取ったまま残す')

  assert.deepEqual(plain(SR.parseCommandResult('sktable e', ['OK'])).parsed, { table: 'E', name: null, title: null, rows: [] })
})

test('parseCommandResult: SKLL64 は OK の無い IPv6 の 1 行で成功', () => {
  assert.deepEqual(plain(SR.parseCommandResult(`SKLL64 ${METER_ADDR}`, [METER_IPV6])), {
    ok: true,
    lines: [METER_IPV6],
    parsed: { mac: METER_ADDR, ipv6: METER_IPV6 },
    error: null,
  })
  assert.equal(plain(SR.parseCommandResult('SKLL64 1234', ['FAIL ER06'])).error.code, 'ER06')
})

test('parseCommandResult: SKSCAN は PAN の一覧（アクティブスキャン）とチャネルの一覧（ED スキャン）', () => {
  const pan = (ch, id, addr, lqi, pair) => [
    `EVENT 20 ${METER_IPV6} 0`,
    'EPANDESC',
    `  Channel:${ch}`,
    '  Channel Page:09',
    `  Pan ID:${id}`,
    `  Addr:${addr}`,
    `  LQI:${lqi}`,
    '  Side:0',
    `  PairID:${pair}`,
  ]
  const lines = ['OK'].concat(pan('21', PAN, METER_ADDR, '62', PAIR), pan('3B', '9999', 'FEDCBA9876543210', 'F0', '01234567'), [`EVENT 22 ${OWN_IPV6} 0`])
  const r = plain(SR.parseCommandResult('SKSCAN 2 FFFFFFFF 6 0', lines))
  assert.equal(r.ok, true)
  assert.deepEqual(r.parsed, {
    mode: 2,
    duration: 6,
    side: 0,
    completed: true,
    pans: [
      { channel: 33, channelHex: '21', channelMHz: 922.5, channelPage: '09', panId: PAN, addr: METER_ADDR, lqi: 0x62, side: 0, pairId: PAIR },
      { channel: 59, channelHex: '3B', channelMHz: 927.7, channelPage: '09', panId: '9999', addr: 'FEDCBA9876543210', lqi: 0xf0, side: 0, pairId: '01234567' },
    ],
  })
  // OK だけ（まだスキャン中）
  assert.deepEqual(plain(SR.parseCommandResult('SKSCAN 2 FFFFFFFF 4 0', ['OK'])).parsed, { mode: 2, duration: 4, side: 0, completed: false, pans: [] })

  const ed = plain(SR.parseCommandResult('SKSCAN 0 FFFFFFFF 3 0', ['OK', `EVENT 1F ${OWN_IPV6} 0`, 'EEDSCAN', '0 21 04 22 05']))
  assert.deepEqual(ed.parsed, {
    mode: 0,
    duration: 3,
    side: 0,
    completed: true,
    channels: [
      { channel: 33, channelMHz: 922.5, rssi: 4 },
      { channel: 34, channelMHz: 922.7, rssi: 5 },
    ],
  })
  assert.equal(plain(SR.parseCommandResult('SKSCAN 2 FFFFFFFF 6', ['FAIL ER05'])).error.code, 'ER05', 'SIDE の付け忘れ')
})

test('parseCommandResult: 知らないコマンドは parsed: null で lines は残す', () => {
  const r = plain(SR.parseCommandResult('SKSETPWD C ********', ['OK']))
  assert.deepEqual(r, { ok: true, lines: ['OK'], parsed: null, error: null })
  const join = plain(SR.parseCommandResult(`SKJOIN ${METER_IPV6}`, ['OK', `EVENT 25 ${METER_IPV6} 0`]))
  assert.equal(join.parsed, null)
  assert.equal(join.lines.length, 2)
})

// ---------------------------------------------------------------------------
// toJsonSafe
// ---------------------------------------------------------------------------

test('toJsonSafe: Buffer・Date・NaN・-0・undefined・関数・Map・循環を JSON の往復で変わらない形に', () => {
  const cyc = { a: 1 }
  cyc.self = cyc
  const input = {
    buf: Buffer.from([0x01, 0xab]),
    date: new Date(Date.UTC(2026, 10, 6, 1, 2, 3)),
    nan: NaN,
    inf: Infinity,
    negZero: -0,
    undef: undefined,
    fn: () => 1,
    map: new Map([['k', 1]]),
    set: new Set([1, 2]),
    arr: [1, undefined, NaN], // 穴も
    nested: { cyc },
  }
  input.arr.length = 4
  const out = plain(SR.toJsonSafe(input), 'toJsonSafe')
  assert.deepEqual(out, {
    buf: '01AB',
    date: '2026-11-06T01:02:03.000Z',
    nan: null,
    inf: null,
    negZero: 0,
    map: { k: 1 },
    set: [1, 2],
    arr: [1, null, null, null],
    nested: { cyc: { a: 1, self: null } },
  })
  // __proto__ という名前の持ち物で、プロトタイプを書き換えない
  const tricky = SR.toJsonSafe(JSON.parse('{"__proto__": {"x": 1}}'))
  assert.equal(Object.getPrototypeOf(tricky), Object.prototype)
  plain(tricky, '__proto__')
})

// ---------------------------------------------------------------------------
// シミュレーターの応答の行で、全部の関数を通す
// ---------------------------------------------------------------------------

/**
 * シミュレーターを開き、コマンドを 1 つずつ送って、返ってきた行（Buffer）を集める。
 * run(cmd, done, binary) は done(これまでの行の文字列) が真になるまで待つ。
 */
async function withSimulator(fn) {
  const sim = new SimulatorTransport({
    latencyMs: 1,
    joinMs: 5,
    scanTimeScale: 0.001,
    // 実機と同じく EVENT 21（シミュレーターは 50 ms）のあとに ERXUDP が届くようにする
    echonetDelayMs: 60,
    channel: 0x21,
    panId: PAN,
    pairId: PAIR,
    meterAddr: METER_ADDR,
    meterIpv6: METER_IPV6,
    meter: { cumulative: 123456 },
  })
  const all = []
  let waiter = null
  sim.on('line', (buf) => {
    all.push(buf)
    if (waiter) waiter()
  })
  await sim.open()
  const run = (cmd, done, binary) =>
    new Promise((resolve, reject) => {
      const start = all.length
      const text = () => all.slice(start).map((b) => b.toString('latin1').replace(/^[\r\n]+/, ''))
      const timer = setTimeout(() => {
        waiter = null
        reject(new Error(`${cmd}: 応答が揃いません（${text().join(' | ')}）`))
      }, 3000)
      waiter = () => {
        if (!done(text())) return
        clearTimeout(timer)
        waiter = null
        resolve(all.slice(start))
      }
      const head = Buffer.from(cmd + (binary ? ' ' : '\r'), 'latin1')
      sim.write(binary ? Buffer.concat([head, binary]) : head)
    })
  try {
    return await fn(run, all)
  } finally {
    await sim.close()
  }
}

const untilDone = (got) => got.some((l) => /^(OK|FAIL)\b/.test(l))
const untilStarts = (prefix) => (got) => got.some((l) => l.indexOf(prefix) === 0)

test('シミュレーターの応答: 接続の手順と診断の読み出しを全部の関数に通す', async () => {
  await withSimulator(async (run, all) => {
    const results = []
    const cmd = async (command, done, binary) => {
      const lines = await run(command, done || untilDone, binary)
      const r = plain(SR.parseCommandResult(command, lines), command)
      results.push(r)
      return r
    }

    // エコーバックが残っている状態（SFE=1）の SKVER
    const ver = await cmd('SKVER')
    assert.equal(ver.ok, true)
    assert.equal(ver.lines[0], 'SKVER', 'エコーの行も lines に残す')
    assert.deepEqual(ver.parsed, { version: '1.5.2' })
    await cmd('SKSREG SFE 0')

    assert.deepEqual((await cmd('SKAPPVER')).parsed, { appVersion: 'simulator' })
    assert.deepEqual((await cmd('SKINFO')).parsed, {
      ipv6: OWN_IPV6,
      mac: OWN_MAC,
      channel: 33,
      channelHex: '21',
      channelMHz: 922.5,
      panId: 'FFFF',
      side: 0,
      addr16: null,
    })
    assert.deepEqual((await cmd('ROPT')).parsed, { wopt: 0, woptHex: '00', erxudpFormat: 'binary' })

    // 診断の許可リストの 11 個
    const expected = { S02: 33, S03: 'FFFF', S07: 0, S0A: '00000000', S15: 1, S16: 86400, S17: 1, SA2: 0, SFE: 0, SF0: 0 }
    for (const reg of ['S02', 'S03', 'S07', 'S0A', 'S15', 'S16', 'S17', 'SA2', 'SFD', 'SFE', 'SF0']) {
      const r = await cmd(`SKSREG ${reg}`)
      assert.equal(r.ok, true, reg)
      assert.equal(r.parsed.register, reg)
      assert.equal(typeof r.parsed.meaning, 'string', `${reg} の意味`)
      assert.ok(r.parsed.text, `${reg} の表示`)
      if (reg === 'SFD') assert.equal(typeof r.parsed.value, 'number')
      else assert.equal(r.parsed.value, expected[reg], reg)
    }
    const badReg = await cmd('SKSREG S99')
    assert.equal(badReg.ok, false)
    assert.equal(badReg.error.code, 'ER06')
    const unknownCmd = await cmd('SKXYZ')
    assert.equal(unknownCmd.error.code, 'ER04')
    assert.equal(unknownCmd.error.message, SK.ERROR_CODES.ER04.message)

    assert.deepEqual((await cmd('SKTABLE 1')).parsed.rows, [{ tokens: [OWN_IPV6], ipv6: OWN_IPV6 }])
    assert.deepEqual((await cmd('SKTABLE 2')).parsed, { table: '2', name: 'ENEIGHBOR', title: SK.TABLES.ENEIGHBOR.title, rows: [] })

    assert.equal((await cmd(`SKSETPWD C ${ROUTE_B_PWD}`)).parsed, null)
    assert.equal((await cmd(`SKSETRBID ${ROUTE_B_ID}`)).ok, true)
    assert.equal((await cmd('SKSREG S0A')).parsed.value, PAIR, 'SKSETRBID で認証 ID の下 8 桁が Pairing ID に入る')

    const scan = await cmd('SKSCAN 2 FFFFFFFF 6 0', untilStarts('EVENT 22'))
    assert.equal(scan.parsed.completed, true)
    assert.deepEqual(scan.parsed.pans, [
      { channel: 33, channelHex: '21', channelMHz: 922.5, channelPage: '09', panId: PAN, addr: METER_ADDR, lqi: 0x62, side: 0, pairId: PAIR },
    ])
    const ed = await cmd('SKSCAN 0 FFFFFFFF 3 0', (got) => got.indexOf('EEDSCAN') >= 0 && got.indexOf('EEDSCAN') < got.length - 1)
    assert.equal(ed.parsed.mode, 0)
    assert.equal(ed.parsed.channels.length, 28, '33〜60ch')
    assert.deepEqual(ed.parsed.channels[0], { channel: 33, channelMHz: 922.5, rssi: 2 + (33 % 7) })

    assert.equal((await cmd('SKSREG S2 21')).parsed.written, true)
    await cmd(`SKSREG S3 ${PAN}`)
    const ll = await cmd(`SKLL64 ${METER_ADDR}`, (got) => got.length > 0)
    assert.deepEqual(ll.parsed, { mac: METER_ADDR, ipv6: METER_IPV6 })
    const join = await cmd(`SKJOIN ${METER_IPV6}`, untilStarts('EVENT 25'))
    assert.equal(join.ok, true)
    assert.equal(join.parsed, null)
    assert.deepEqual((await cmd('SKTABLE 2')).parsed.rows, [{ tokens: [METER_IPV6, METER_ADDR], ipv6: METER_IPV6, mac: METER_ADDR }])

    // WOPT 00 のまま（出荷時）: ERXUDP のデータ部はバイナリで、16 進として読めない
    // 送信の結果（EVENT 21）と応答（ERXUDP）の両方が揃うまで待つ（前の送信の行を次の窓に持ち越さない）
    const send = (epcs, tid) => {
      const frame = EL.buildGet(epcs, tid)
      const done = (got) => untilStarts('EVENT 21')(got) && untilStarts('ERXUDP')(got)
      return run(`SKSENDTO 1 ${METER_IPV6} 0E1A 1 0 ${hex4(frame.length)}`, done, frame)
    }
    const binLines = await send([0xe7, 0xe8], 0x0041)
    const binErx = binLines.find((b) => /^\n?ERXUDP/.test(b.toString('latin1')))
    const bin = plain(SR.describeLine(binErx))
    assert.equal(bin.kind, 'erxudp')
    assert.notEqual(bin.parsed.encoding, 'hex')
    assert.equal(bin.parsed.echonet, null)

    await cmd('WOPT 01')
    assert.deepEqual((await cmd('ROPT')).parsed, { wopt: 1, woptHex: '01', erxudpFormat: 'hex' })

    // WOPT 01: 16 進で届き、ECHONET Lite の値まで読める
    const hexLines = await send([0xe7, 0xe8, 0xe0, 0xd3, 0xe1], 0x0042)
    const udpDone = plain(SR.describeLine(hexLines.find((b) => /^\n?EVENT 21/.test(b.toString('latin1')))))
    assert.equal(udpDone.parsed.udp.ok, true)
    const erx = hexLines.find((b) => /^\n?ERXUDP/.test(b.toString('latin1')))
    const res = plain(SR.describeLine(erx, { coefficient: 1, unitFactor: 0.1 }))
    assert.equal(res.parsed.encoding, 'hex')
    assert.equal(res.parsed.echonet.esvName, 'Get_Res')
    assert.equal(res.parsed.echonet.tid, 0x42)
    const props = Object.fromEntries(res.parsed.echonet.props.map((p) => [p.epc, p]))
    assert.deepEqual(Object.keys(props), ['E7', 'E8', 'E0', 'D3', 'E1'])
    assert.equal(typeof props.E7.value, 'number')
    assert.ok(props.E7.value > 300 && props.E7.value < 500, `瞬時電力 ${props.E7.value} W`)
    assert.deepEqual(props.E8.value, { r: 15, t: 30 })
    assert.equal(props.E0.value, 12345.6)
    assert.equal(props.E1.value, 0.1)

    // 持っていない値（0x81）を混ぜると Get_SNA
    const snaLines = await send([0xe7, 0x81], 0x0043)
    const sna = plain(SR.describeLine(snaLines.find((b) => /^\n?ERXUDP/.test(b.toString('latin1')))))
    assert.equal(sna.parsed.echonet.esvName, 'Get_SNA')
    assert.equal(sna.parsed.echonet.props[1].pdc, 0)

    // 全部の結果が JSON の往復で変わらない
    plain(results, 'parseCommandResult の全部')

    // 受け取った全部の行を、届いた順に 1 行ずつ分ける（出力の raw と同じ使い方）
    const d = SR.createLineDescriber()
    const described = all.map((b) => plain(d.describe(b, { coefficient: 1, unitFactor: 0.1 })))
    const kinds = new Set(described.map((x) => x.kind))
    assert.ok(!kinds.has('other'), `シミュレーターが出す行は全部どれかの種類に分かれること（${[...kinds].join(', ')}）`)
    for (const k of ['echo', 'ever', 'ok', 'esreg', 'eappver', 'einfo', 'fail', 'etable', 'event', 'epandesc', 'eedscan', 'ipv6', 'erxudp']) {
      assert.ok(kinds.has(k), `${k} の行があること`)
    }
    const fields = described.filter((x) => x.kind === 'epandesc' && x.parsed.part === 'field').map((x) => x.parsed.field)
    assert.deepEqual(fields, ['channel', 'channelPage', 'panId', 'addr', 'lqi', 'side', 'pairId'])
    const edData = described.filter((x) => x.kind === 'eedscan' && x.parsed.part === 'data')
    assert.equal(edData.length, 1)
    assert.equal(edData[0].parsed.channels.length, 28)
    const rows = described.filter((x) => x.kind === 'etable' && x.parsed.part === 'row')
    assert.deepEqual(rows.map((x) => x.parsed.name), ['EADDR', 'ENEIGHBOR'])
    // SKLL64 の応答は表の行ではなく ipv6
    assert.ok(described.some((x) => x.kind === 'ipv6' && x.parsed.ipv6 === METER_IPV6))
    // 認証情報は、どの結果にも入らない（エコーは SFE 0 の後なので来ないが、念のため）
    const json = JSON.stringify(described) + JSON.stringify(results)
    assert.ok(json.indexOf(ROUTE_B_PWD) < 0 && json.indexOf(ROUTE_B_ID) < 0)
  })
})
