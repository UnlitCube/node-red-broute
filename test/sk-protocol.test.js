const { test } = require('node:test')
const assert = require('node:assert/strict')
const SK = require('../lib/sk-protocol')

/** 複数行をまとめて食わせて、確定したイベントの配列を返す。 */
function feedAll(lines) {
  const acc = SK.newAccumulator()
  const out = []
  for (const l of lines) out.push(...SK.feed(acc, l).filter(Boolean))
  out.push(...SK.flush(acc).filter(Boolean))
  return out
}

test('OK / FAIL の分類', () => {
  assert.equal(SK.parseLine('OK').kind, 'ok')
  assert.equal(SK.parseLine('OK 00').value, '00') // ROPT の応答
  const f = SK.parseLine('FAIL ER10')
  assert.equal(f.kind, 'fail')
  assert.equal(f.code, 'ER10')
  assert.equal(f.retryable, true)
  const f6 = SK.parseLine('FAIL ER06')
  assert.equal(f6.retryable, false, 'ER06 は引数不正なので再試行しても無駄')
})

test('EVENT の分解', () => {
  const e = SK.parseLine('EVENT 25 FE80:0000:0000:0000:021D:1290:1234:5678 0')
  assert.equal(e.kind, 'event')
  assert.equal(e.num, 0x25)
  assert.equal(e.name, 'PANA 接続完了')
  assert.equal(e.severity, 'good')
  assert.equal(e.side, 0)
  assert.equal(e.param, null)
})

test('EVENT 21 の PARAM は送信結果として解釈する', () => {
  const ok = SK.parseLine('EVENT 21 FE80:0000:0000:0000:021D:1290:1234:5678 0 00')
  assert.equal(ok.udp.ok, true)
  const ng = SK.parseLine('EVENT 21 FE80:0000:0000:0000:021D:1290:1234:5678 0 01')
  assert.equal(ng.udp.ok, false)
  const ns = SK.parseLine('EVENT 21 FE80:0000:0000:0000:021D:1290:1234:5678 0 02')
  assert.equal(ns.udp.ok, true, 'PARAM=02 は NS 実行。失敗ではない')
})

test('ARIB 送信制限イベントを error / good として拾う', () => {
  assert.equal(SK.parseLine('EVENT 32 FE80:0000:0000:0000:0000:0000:0000:0000 FF').severity, 'error')
  assert.equal(SK.parseLine('EVENT 33 FE80:0000:0000:0000:0000:0000:0000:0000 FF').severity, 'good')
})

test('ERXUDP を末尾から数えて解析する (SIDE あり = BP35C0)', () => {
  // ERXUDP <SENDER> <DEST> <RPORT> <LPORT> <SENDERLLA> <SECURED> <SIDE> <DATALEN> <DATA>
  const line =
    'ERXUDP FE80:0000:0000:0000:5AC2:32FF:FECB:B31F FE80:0000:0000:0000:021D:1291:0004:BE8A 0E1A 0E1A 58C232FFFECBB31F 1 0 0012 ' +
    '108100010288010 5FF017201E70400 0001B4'.replace(/ /g, '')
  const r = SK.parseLine(line)
  assert.equal(r.kind, 'erxudp')
  assert.equal(r.rport, 0x0e1a)
  assert.equal(r.lport, 0x0e1a)
  assert.equal(r.datalen, 0x12)
  assert.equal(r.encoding, 'hex', '文字数 = DATALEN×2 なので 16 進 ASCII と判定できる')
  assert.equal(r.hex.length, 0x12 * 2)
})

test('ERXUDP が RSSI 付き (SA2=1) でも同じ結果になる', () => {
  const data = '1081000102880105FF017201E7040000 01B4'.replace(/ /g, '')
  const withRssi =
    'ERXUDP FE80:0000:0000:0000:5AC2:32FF:FECB:B31F FE80:0000:0000:0000:021D:1291:0004:BE8A 0E1A 0E1A 58C232FFFECBB31F C8 1 0 0012 ' + data
  const r = SK.parseLine(withRssi)
  assert.equal(r.datalen, 0x12)
  assert.equal(r.encoding, 'hex')
  assert.equal(r.hex, data.toUpperCase())
})

test('ERXUDP が 16 進 ASCII でなければ壊れている可能性ありとして印をつける', () => {
  const r = SK.parseLine('ERXUDP FE80::1 FE80::2 0E1A 0E1A 58C232FFFECBB31F 1 0 0012 ????')
  assert.equal(r.encoding, 'binary-or-broken')
  assert.match(r.note, /WOPT 01/)
})

test('EPANDESC を複数行からまとめる', () => {
  const events = feedAll([
    'EVENT 20 FE80:0000:0000:0000:021D:1290:1234:5678 0',
    'EPANDESC',
    '  Channel:21',
    '  Channel Page:09',
    '  Pan ID:8888',
    '  Addr:12345678ABCDEF01',
    '  LQI:E1',
    '  Side:0',
    '  PairID:AABBCCDD',
    'EVENT 22 FE80:0000:0000:0000:021D:1290:1234:5678 0',
  ])
  const pan = events.find((e) => e.kind === 'epandesc')
  assert.ok(pan, 'EPANDESC が確定していること')
  assert.equal(pan.channel, 0x21)
  assert.equal(pan.channelHex, '21')
  assert.equal(pan.channelMHz, 922.5, '33ch = 922.5MHz')
  assert.equal(pan.panId, '8888')
  assert.equal(pan.addr, '12345678ABCDEF01')
  assert.equal(pan.lqi, 0xe1)
  assert.equal(pan.pairId, 'AABBCCDD')

  // EPANDESC の直後の EVENT 22 が飲み込まれずに残ること
  assert.ok(events.some((e) => e.kind === 'event' && e.num === 0x22), 'EVENT 22 が失われないこと')

  // 順序が重要。EVENT 22 (スキャン完了) を受けた時点で EPANDESC が
  // 確定していないと、シーケンサーは「PAN が 1 件も見つからなかった」と
  // 判断して無駄な再スキャンに入る (実機で発生した)。
  const iPan = events.findIndex((e) => e.kind === 'epandesc')
  const iEnd = events.findIndex((e) => e.kind === 'event' && e.num === 0x22)
  assert.ok(iPan >= 0 && iEnd >= 0)
  assert.ok(iPan < iEnd, 'EPANDESC は EVENT 22 より前に確定すること')
})

test('スキャン中に EVENT 20 が挟まっても EPANDESC の順序が崩れない', () => {
  // 実機の並び: EVENT 20 → EPANDESC → (EVENT 20 → EPANDESC …) → EVENT 22
  const events = feedAll([
    'EVENT 20 FE80::1 0',
    'EPANDESC',
    '  Channel:3B',
    '  Pan ID:1234',
    '  Addr:0011223344556677',
    '  LQI:62',
    'EVENT 22 FE80::1 0',
  ])
  const kinds = events.map((e) => e.kind + (e.num !== undefined ? ':' + e.num.toString(16) : ''))
  assert.deepEqual(kinds, ['event:20', 'epandesc', 'event:22'], '確定順が実機の並びと一致すること')
})

test('チャネル番号から周波数への換算', () => {
  assert.equal(SK.channelToMHz(33), 922.5)
  assert.equal(SK.channelToMHz(60), 927.9)
  assert.equal(SK.channelToMHz(32), null)
})

test('SKLL64 の応答 (裸の IPv6 一行) を認識する', () => {
  const r = SK.parseLine('FE80:0000:0000:0000:021D:1290:1234:5678')
  assert.equal(r.kind, 'ipv6')
  assert.equal(r.address, 'FE80:0000:0000:0000:021D:1290:1234:5678')
})

test('SKINFO の EINFO を分解する', () => {
  const r = SK.parseLine('EINFO FE80:0000:0000:0000:021D:1290:1234:5678 001D129012345678 21 8888 0')
  assert.equal(r.kind, 'einfo')
  assert.equal(r.mac, '001D129012345678')
  assert.equal(r.channel, 0x21)
  assert.equal(r.panid, '8888')
})

test('SKSREG 読み出しの ESREG を拾う', () => {
  assert.equal(SK.parseLine('ESREG 0021').value, '0021')
})

test('EEDSCAN を解析する', () => {
  const events = feedAll([
    'EVENT 1F FE80:0000:0000:0000:021D:1290:0003:C890 0',
    'EEDSCAN',
    '0 21 04 22 04 23 03',
  ])
  const ed = events.find((e) => e.kind === 'eedscan')
  assert.ok(ed)
  assert.equal(ed.channels.length, 3)
  assert.deepEqual(ed.channels[0], { channel: 0x21, channelMHz: 922.5, rssi: 4 })
})

test('SKTABLE 系 (EADDR) は OK まで集めて表にする', () => {
  const events = feedAll([
    'EADDR',
    'FE80:0000:0000:0000:021D:1290:1234:5678',
    'FE80:0000:0000:0000:021D:1290:1234:5679',
    'OK',
  ])
  const tbl = events.find((e) => e.kind === 'table')
  assert.ok(tbl)
  assert.equal(tbl.name, 'EADDR')
  assert.equal(tbl.lines.length, 2)
  assert.ok(events.some((e) => e.kind === 'ok'), 'EADDR を閉じた OK も残ること')
})

test('エコーバックされたコマンド行を応答と取り違えない', () => {
  assert.equal(SK.parseLine('SKVER').kind, 'echo')
  assert.equal(SK.parseLine('SKSETPWD C 0123456789AB').kind, 'echo')
})

// 戻すと落ちるもの: maskSecretCommand を最後の引数だけ伏せる形に戻す（引数が 1 つ多いと本当の値が残る）
test('maskSecretCommand: 認証情報を書くコマンドは、コマンド名のあとを全部伏せる。ほかの文は変えない', () => {
  const value = 'NEWPASSWORD0'
  assert.equal(SK.maskSecretCommand('SKSETPWD C ' + value), 'SKSETPWD C ********')
  assert.equal(SK.maskSecretCommand('SKSETRBID ' + value), 'SKSETRBID ********')
  assert.equal(SK.maskSecretCommand('sksetpwd c ' + value), 'sksetpwd c ********', '小文字でも伏せる')
  assert.equal(SK.maskSecretCommand('SKSETPSK 20 ' + value), 'SKSETPSK 20 ********')
  for (const line of ['SKSETPWD ZZ ' + value, 'SKSETPWD C ' + value + ' X', 'SKSETPWD ' + value + ' C', '  SKSETRBID   ' + value + '  ']) {
    assert.ok(!SK.maskSecretCommand(line).includes(value), line)
  }
  assert.equal(SK.maskSecretCommand('SKSETPWD'), 'SKSETPWD', '引数が無ければ伏せるものも無い')
  assert.equal(SK.maskSecretCommand('SKSENDTO 1 FE80:0000 0E1A 1 0 000E'), 'SKSENDTO 1 FE80:0000 0E1A 1 0 000E')
  assert.equal(SK.maskSecretCommand('EVER 1.5.2'), 'EVER 1.5.2')
  assert.equal(SK.maskSecretCommand(undefined), '')
  assert.equal(SK.isSecretCommand('SKSETRBID'), true)
  assert.equal(SK.isSecretCommand('SKSREG S2'), false)
  assert.equal(SK.isSecretCommand(null), false)
})

test('ER の文は、「です・ます」で続けて読める形にする（失敗の文の advice に続けて出す）', () => {
  // 戻すと落ちるもの: 文を辞書形に戻す・message か advice を空にする
  for (const code of ['ER04', 'ER05', 'ER06', 'ER09', 'ER10']) {
    const e = SK.ERROR_CODES[code]
    assert.match(e.message, /(です|ません|ました)$/, code)
    assert.match(e.advice, /ください$/, code)
  }
})

// ---------------------------------------------------------------------------
// 以下は取りこぼしの再発防止
// ---------------------------------------------------------------------------

test('SKTABLE の表を組み立てている最中に来た ERXUDP を飲み込まない', () => {
  // 表の途中に計測値が割り込むのは普通に起きる (ポーリングと診断操作が重なる)。
  // これを表の行として食べてしまうと、計測値が消えたうえに
  // 応答待ちがタイムアウトして不要な再接続が走る。
  const data = '1081000102880105FF017201E704000001B4'
  const events = feedAll([
    'ENEIGHBOR',
    'FE80:0000:0000:0000:021D:1290:1234:5678 001D129012345678',
    `ERXUDP FE80::1 FE80::2 0E1A 0E1A 58C232FFFECBB31F 1 0 0012 ${data}`,
    'EVENT 26 FE80:0000:0000:0000:021D:1290:1234:5678 0',
    'OK',
  ])
  assert.ok(events.some((e) => e.kind === 'erxudp'), 'ERXUDP が素通しされること')
  assert.ok(events.some((e) => e.kind === 'event' && e.num === 0x26), 'EVENT 26 が素通しされること')
  const tbl = events.find((e) => e.kind === 'table')
  assert.ok(tbl)
  assert.equal(tbl.lines.length, 1, '表の行は本物の 1 行だけ')
})

test('EEDSCAN のデータ行の前に割り込んだイベントを結果にしない', () => {
  const events = feedAll([
    'EVENT 1F FE80:0000:0000:0000:021D:1290:0003:C890 0',
    'EEDSCAN',
    'EVENT 33 FE80:0000:0000:0000:0000:0000:0000:0000 FF',
    '0 21 04 22 04',
  ])
  const ed = events.find((e) => e.kind === 'eedscan')
  assert.ok(ed, 'EEDSCAN は本物のデータ行から作られること')
  assert.equal(ed.channels.length, 2)
  assert.ok(events.some((e) => e.kind === 'event' && e.num === 0x33), '割り込んだ EVENT 33 が残ること')
})

test('EPANDESC の途中に混ざったコマンドのエコーをフィールドにしない', () => {
  const events = feedAll([
    'EPANDESC',
    '  Channel:21',
    'SKSENDTO 1 FE80:0000:0000:0000:021D:1290:1234:5678 0E1A 1 0 000E',
    '  Pan ID:8888',
    '  Addr:12345678ABCDEF01',
    'EVENT 22 FE80:0000:0000:0000:021D:1290:1234:5678 0',
  ])
  const pan = events.find((e) => e.kind === 'epandesc')
  assert.ok(pan)
  assert.equal(pan.channel, 0x21)
  assert.deepEqual(
    Object.keys(pan.fields).sort(),
    ['Addr', 'Channel', 'Pan ID'],
    'EPANDESC の既定フィールド以外を取り込まないこと'
  )
})

test('EPANDESC が連続しても前の 1 件を落とさない', () => {
  // スキャンで複数の PAN が見つかると EPANDESC が続けて飛んでくる
  const events = feedAll([
    'EPANDESC',
    '  Channel:21',
    '  Pan ID:8888',
    '  Addr:1111111111111111',
    'EPANDESC',
    '  Channel:3B',
    '  Pan ID:1234',
    '  Addr:2222222222222222',
    'EVENT 22 FE80::1 0',
  ])
  const pans = events.filter((e) => e.kind === 'epandesc')
  assert.equal(pans.length, 2, '2 件とも確定すること')
  assert.equal(pans[0].panId, '8888')
  assert.equal(pans[1].panId, '1234')
  assert.equal(pans[1].channel, 0x3b)
})

test('ERXUDP の DATALEN=0 を「WOPT 未設定」と誤判定しない', () => {
  const r = SK.parseLine('ERXUDP FE80::1 FE80::2 0E1A 0E1A 58C232FFFECBB31F 1 0 0000')
  assert.equal(r.encoding, 'empty', 'データ無しとして扱うこと')
  assert.equal(r.datalen, 0)
  assert.equal(r.note, undefined, 'WOPT の警告を出さないこと')
})

test('flush で組み立てかけの複数行イベントを確定できる', () => {
  // 終端の OK が来ないまま止まった場合の保険
  const acc = SK.newAccumulator()
  SK.feed(acc, 'EADDR')
  SK.feed(acc, 'FE80:0000:0000:0000:021D:1290:1234:5678')
  const flushed = SK.flush(acc)
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].kind, 'table')
  assert.equal(flushed[0].lines.length, 1)
  assert.equal(acc.pending, null, 'flush 後は pending が空になること')
})
