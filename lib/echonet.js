// ============================================================================
//  ECHONET Lite (低圧スマート電力量メータ / クラス 0x0288) の組み立て・解釈
//  シーケンサー・lib/sk-results.js・lib/runtime が require して使う共有ライブラリ。副作用なし。
// ============================================================================
//
// 電文構成 (ECHONET Lite 規格):
//   EHD1(1) EHD2(1) TID(2) SEOJ(3) DEOJ(3) ESV(1) OPC(1) [EPC(1) PDC(1) EDT(PDC)]×OPC
//
//   EHD1 = 0x10 固定、EHD2 = 0x81 (形式1) 固定。
//   コントローラ (こちら) = 05FF01、低圧スマート電力量メータ = 028801。
//   送信は SEOJ=05FF01 / DEOJ=028801、応答はその逆になる。

var EL = (function () {
  var EHD1 = 0x10
  var EHD2 = 0x81
  var CONTROLLER = [0x05, 0xff, 0x01] // 管理・操作関連機器 / コントローラ / 1
  var METER = [0x02, 0x88, 0x01] // 住宅設備 / 低圧スマート電力量メータ / 1

  // ESV: ECHONET Lite サービスコード
  var ESV = {
    SETI: 0x60, // 書き込み要求 (応答不要)
    SETC: 0x61, // 書き込み要求 (応答要)
    GET: 0x62, // 読み出し要求
    INF_REQ: 0x63,
    SETGET: 0x6e,
    SET_RES: 0x71,
    GET_RES: 0x72, // 読み出し応答
    INF: 0x73, // 状態通知
    INFC: 0x74,
    INFC_RES: 0x7a,
    SETGET_RES: 0x7e,
    SETI_SNA: 0x50,
    SETC_SNA: 0x51,
    GET_SNA: 0x52, // 読み出し不可応答
    INF_SNA: 0x53,
    SETGET_SNA: 0x5e,
  }

  var ESV_NAME = {
    0x60: 'SetI', 0x61: 'SetC', 0x62: 'Get', 0x63: 'INF_REQ', 0x6e: 'SetGet',
    0x71: 'Set_Res', 0x72: 'Get_Res', 0x73: 'INF', 0x74: 'INFC', 0x7a: 'INFC_Res', 0x7e: 'SetGet_Res',
    0x50: 'SetI_SNA', 0x51: 'SetC_SNA', 0x52: 'Get_SNA', 0x53: 'INF_SNA', 0x5e: 'SetGet_SNA',
  }

  // --------------------------------------------------------------------------
  // EPC カタログ
  //   unit    … 表示単位
  //   parse   … EDT(Buffer) -> 値。null を返したら「不明・異常値」
  //   coeff   … true の場合、0xD3 係数と 0xE1 単位を掛けて実量にする必要がある
  //   desc    … 何の値かの短い説明 (画面とエディタで EPC を名前で選ぶため)
  //   group   … まとまり。画面とエディタの並び:
  //               'common'    よく使う (瞬時電力・瞬時電流・積算電力量)
  //               'scheduled' 定時の積算 (30 分ごとの確定値)
  //               'info'      メーターの情報 (動作状態・製造番号・係数など)
  //               'other'     そのほか (機器の共通の項目・プロパティマップ。メーターはふつう持っていない)
  //               'history'   履歴 (1 件が大きい。定期取得の候補に出さない)
  // --------------------------------------------------------------------------
  var EPC = {
    0x80: { name: '動作状態', unit: '', kind: 'state', group: 'info', desc: 'メーターが動いているか（ON / OFF）' },
    0x81: { name: '設置場所', unit: '', kind: 'raw', group: 'info', desc: 'メーターの設置場所（多くは未設定）' },
    0x82: { name: '規格Version情報', unit: '', kind: 'raw', group: 'info', desc: 'メーターが従う ECHONET Lite の規格の版' },
    // 0x83〜0x9C のうち下の 3 行以外は、機器オブジェクトのスーパークラスの名前だけを持つ (読み方は生データ)。
    // メーターが持っていないことが多いが、診断で聞いたときや Get_SNA で控えたときに
    // 「不明なEPC」や英語のキーで出さないため。
    0x83: { name: '識別番号', unit: '', kind: 'hex', group: 'info', desc: 'メーターを見分ける番号' },
    0x84: { name: '瞬時消費電力計測値', unit: '', kind: 'raw', group: 'other', desc: '機器そのものが使っている電力（メーターはふつう持っていません）' },
    0x85: { name: '積算消費電力量計測値', unit: '', kind: 'raw', group: 'other', desc: '機器そのものが使った電力量（メーターはふつう持っていません）' },
    0x86: { name: 'メーカ異常コード', unit: '', kind: 'raw', group: 'other', desc: 'メーカー独自の異常の番号' },
    0x87: { name: '電流制限設定', unit: '%', kind: 'u8', group: 'other', desc: '電流の制限の設定（メーターはふつう持っていません）' },
    0x88: { name: '異常発生状態', unit: '', kind: 'fault', group: 'info', desc: 'メーターに異常が起きているか（あり / なし）' },
    0x89: { name: '異常内容', unit: '', kind: 'raw', group: 'other', desc: '起きている異常の内容の番号' },
    0x8a: { name: 'メーカコード', unit: '', kind: 'hex', group: 'info', desc: 'メーカーの番号（ECHONET コンソーシアムの割り当て）' },
    0x8b: { name: '事業場コード', unit: '', kind: 'hex', group: 'other', desc: '製造した事業場の番号' },
    0x8c: { name: '商品コード', unit: '', kind: 'ascii', group: 'info', desc: 'メーカーが付けた商品の番号' },
    0x8d: { name: '製造番号', unit: '', kind: 'ascii', group: 'info', desc: 'メーターの製造番号' },
    0x8e: { name: '製造年月日', unit: '', kind: 'ymd', group: 'info', desc: 'メーターを作った日' },
    0x8f: { name: '節電動作設定', unit: '', kind: 'raw', group: 'other', desc: '節電の動作の設定（メーターはふつう持っていません）' },
    0x93: { name: '遠隔操作設定', unit: '', kind: 'raw', group: 'other', desc: '遠隔からの操作を受けるかの設定' },
    0x97: { name: '現在時刻設定', unit: '', kind: 'hm', group: 'info', desc: 'メーターの時計の時刻（時:分）' },
    0x98: { name: '現在年月日設定', unit: '', kind: 'ymd', group: 'info', desc: 'メーターの時計の日付' },
    0x99: { name: '電力制限設定', unit: '', kind: 'raw', group: 'other', desc: '電力の制限の設定（メーターはふつう持っていません）' },
    0x9a: { name: '積算運転時間', unit: '', kind: 'raw', group: 'other', desc: '動いていた時間の合計' },
    0x9b: { name: 'SetMプロパティマップ', unit: '', kind: 'propmap', group: 'other', desc: 'まとめて書き込めるプロパティの一覧' },
    0x9c: { name: 'GetMプロパティマップ', unit: '', kind: 'propmap', group: 'other', desc: 'まとめて読み出せるプロパティの一覧' },
    0x9d: { name: '状変アナウンスプロパティマップ', unit: '', kind: 'propmap', group: 'other', desc: '値が変わるとメーターから知らせてくるプロパティの一覧' },
    0x9e: { name: 'Setプロパティマップ', unit: '', kind: 'propmap', group: 'other', desc: '書き込めるプロパティの一覧' },
    0x9f: { name: 'Getプロパティマップ', unit: '', kind: 'propmap', group: 'other', desc: '読み出せるプロパティの一覧（このメーターが持っている値）' },
    0xd3: { name: '係数', unit: '', kind: 'u32', group: 'info', desc: '積算電力量を kWh に直すときに掛ける数' },
    0xd7: { name: '積算電力量有効桁数', unit: '桁', kind: 'u8', group: 'info', desc: '積算電力量の桁数（この桁を超えると 0 に戻る）' },
    0xe0: { name: '積算電力量計測値(正方向)', unit: 'kWh', kind: 'u32', coeff: true, group: 'common', desc: 'これまでに買った電力量の合計（買電）[kWh]' },
    0xe1: { name: '積算電力量単位', unit: '', kind: 'unit', group: 'info', desc: '積算電力量の 1 カウントが何 kWh か' },
    0xe2: { name: '積算電力量計測値履歴1(正方向)', unit: 'kWh', kind: 'history1', coeff: true, group: 'history', desc: '買電の 30 分ごとの積算の 1 日分（履歴。定期的には取れません）' },
    0xe3: { name: '積算電力量計測値(逆方向)', unit: 'kWh', kind: 'u32', coeff: true, group: 'common', desc: 'これまでに売った電力量の合計（売電）[kWh]' },
    0xe4: { name: '積算電力量計測値履歴1(逆方向)', unit: 'kWh', kind: 'history1', coeff: true, group: 'history', desc: '売電の 30 分ごとの積算の 1 日分（履歴。定期的には取れません）' },
    0xe5: { name: '積算履歴収集日1', unit: '日前', kind: 'u8', group: 'info', desc: '履歴 1（E2・E4）で何日前の分を返すかの設定' },
    0xe7: { name: '瞬時電力計測値', unit: 'W', kind: 'i32', group: 'common', desc: 'いま使っている電力 [W]。売電のときはマイナス' },
    0xe8: { name: '瞬時電流計測値', unit: 'A', kind: 'current', group: 'common', desc: 'いま流れている電流 [A]（R 相と T 相）' },
    0xea: { name: '定時積算電力量計測値(正方向)', unit: 'kWh', kind: 'stamped', coeff: true, group: 'scheduled', desc: '30 分ごとの区切りの時刻で確定した買電の積算 [kWh]' },
    0xeb: { name: '定時積算電力量計測値(逆方向)', unit: 'kWh', kind: 'stamped', coeff: true, group: 'scheduled', desc: '30 分ごとの区切りの時刻で確定した売電の積算 [kWh]' },
    0xec: { name: '積算電力量計測値履歴2(正逆)', unit: 'kWh', kind: 'history2', coeff: true, group: 'history', desc: '買電と売電の積算の履歴（定期的には取れません）' },
    0xed: { name: '積算履歴収集日2', unit: '', kind: 'ymdhm', group: 'info', desc: '履歴 2（EC）でいつからの分を返すかの設定' },
    // 新しい版の規格で足された履歴 3 (名前だけ。読み方は生データ)
    0xee: { name: '積算電力量計測値履歴3(正逆)', unit: '', kind: 'raw', group: 'history', desc: '買電と売電の積算の履歴（新しい規格。1 件が大きいので定期的に取るのには向きません）' },
    0xef: { name: '積算履歴収集日3', unit: '', kind: 'raw', group: 'info', desc: '履歴 3（EE）でいつからの分を返すかの設定' },
  }

  // 0xE1 積算電力量単位 -> kWh への倍率
  var UNIT_TABLE = {
    0x00: 1, 0x01: 0.1, 0x02: 0.01, 0x03: 0.001, 0x04: 0.0001,
    0x0a: 10, 0x0b: 100, 0x0c: 1000, 0x0d: 10000,
  }

  function hex2(n) {
    return ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
  }

  /**
   * Get 要求フレームを組み立てる。
   * @param {number[]} epcs 取得したい EPC の配列 (OPC は自動計算)
   * @param {number} tid    トランザクション ID (0-65535)
   * @returns {Buffer}
   */
  function buildGet(epcs, tid) {
    var head = [EHD1, EHD2, (tid >> 8) & 0xff, tid & 0xff]
    var body = [].concat(CONTROLLER, METER, [ESV.GET, epcs.length & 0xff])
    var props = []
    for (var i = 0; i < epcs.length; i++) {
      props.push(epcs[i] & 0xff, 0x00) // Get 要求なので PDC=0、EDT なし
    }
    return Buffer.from(head.concat(body, props))
  }

  /**
   * ECHONET Lite フレームを解釈する。
   * @param {Buffer} buf
   * @returns {object|null} 解釈できなければ null
   */
  function parseFrame(buf) {
    if (!buf || buf.length < 12) return null
    if (buf[0] !== EHD1 || buf[1] !== EHD2) return null
    var tid = buf.readUInt16BE(2)
    var seoj = [buf[4], buf[5], buf[6]]
    var deoj = [buf[7], buf[8], buf[9]]
    var esv = buf[10]
    var opc = buf[11]
    var props = []
    var p = 12
    for (var i = 0; i < opc; i++) {
      if (p + 2 > buf.length) return null
      var epc = buf[p]
      var pdc = buf[p + 1]
      p += 2
      if (p + pdc > buf.length) return null
      props.push({ epc: epc, pdc: pdc, edt: buf.slice(p, p + pdc) })
      p += pdc
    }
    return {
      tid: tid,
      seoj: seoj.map(hex2).join(''),
      deoj: deoj.map(hex2).join(''),
      esv: esv,
      esvName: ESV_NAME[esv] || ('0x' + hex2(esv)),
      opc: opc,
      props: props,
      isGetRes: esv === ESV.GET_RES,
      isGetSna: esv === ESV.GET_SNA,
      isInf: esv === ESV.INF,
      fromMeter: seoj[0] === 0x02 && seoj[1] === 0x88,
    }
  }

  /** 定時積算 (0xEA/0xEB) の先頭 7 バイト = 年(2)月(1)日(1)時(1)分(1)秒(1) */
  function readStampedTime(edt) {
    return {
      year: edt.readUInt16BE(0),
      month: edt[2],
      day: edt[3],
      hour: edt[4],
      minute: edt[5],
      second: edt[6],
    }
  }

  function pad(n, w) {
    var s = String(n)
    while (s.length < w) s = '0' + s
    return s
  }

  function fmtStamp(t) {
    return t.year + '-' + pad(t.month, 2) + '-' + pad(t.day, 2) + ' ' + pad(t.hour, 2) + ':' + pad(t.minute, 2) + ':' + pad(t.second, 2)
  }

  /**
   * EDT を値に変換する。
   * @param {number} epc
   * @param {Buffer} edt
   * @param {object} ctx { coefficient: number, unitFactor: number } 積算値の換算に使う
   * @returns {object} { value, display, unit, raw, note }
   */
  function decode(epc, edt, ctx) {
    ctx = ctx || {}
    var meta = EPC[epc] || { name: '不明な EPC 0x' + hex2(epc), unit: '', kind: 'raw' }
    var out = { epc: epc, epcHex: '0x' + hex2(epc), name: meta.name, unit: meta.unit, raw: edt.toString('hex').toUpperCase() }

    try {
      switch (meta.kind) {
        case 'i32': {
          // 瞬時電力 0xE7。符号付き 32bit。太陽光発電時は負になる。
          if (edt.length < 4) return fail(out, '長さ不足')
          var v = edt.readInt32BE(0)
          // 0x7FFFFFFE / 0x80000002 はオーバーフロー・アンダーフローの規定値
          if (v === 0x7ffffffe || v === -2147483646) return fail(out, '計測値オーバーフロー')
          out.value = v
          out.display = v + ' W'
          return out
        }
        case 'u32': {
          if (edt.length < 4) return fail(out, '長さ不足')
          var raw = edt.readUInt32BE(0)
          out.rawCount = raw
          if (meta.coeff) {
            // 積算電力量は「生カウント × 係数(0xD3) × 単位(0xE1)」で kWh になる
            var k = typeof ctx.coefficient === 'number' ? ctx.coefficient : null
            var u = typeof ctx.unitFactor === 'number' ? ctx.unitFactor : null
            if (k === null || u === null) {
              out.value = null
              out.display = raw + '（未換算: 0xD3 と 0xE1 が必要）'
              out.note = '係数（0xD3）と単位（0xE1）を取得すると kWh に換算できます'
              return out
            }
            out.value = round(raw * k * u, 4)
            out.display = out.value + ' kWh'
            out.coefficient = k
            out.unitFactor = u
          } else {
            out.value = raw
            out.display = String(raw)
          }
          return out
        }
        case 'current': {
          // 瞬時電流 0xE8。R相/T相それぞれ符号付き 16bit、単位 0.1A。
          if (edt.length < 4) return fail(out, '長さ不足')
          var r = edt.readInt16BE(0)
          var t = edt.readInt16BE(2)
          // 0x7FFE はオーバーフロー規定値。単相2線式では T 相に 0x7FFE が入る。
          var rA = r === 0x7ffe ? null : round(r / 10, 1)
          var tA = t === 0x7ffe ? null : round(t / 10, 1)
          out.value = { r: rA, t: tA }
          out.display = 'R 相 ' + (rA === null ? '—' : rA + ' A') + ' / T 相 ' + (tA === null ? '—（単相 2 線）' : tA + ' A')
          if (rA !== null) out.total = tA === null ? rA : round(rA + tA, 1)
          return out
        }
        case 'stamped': {
          // 定時積算 0xEA/0xEB: 日時7バイト + 積算値4バイト
          if (edt.length < 11) return fail(out, '長さ不足')
          var st = readStampedTime(edt)
          var cnt = edt.readUInt32BE(7)
          out.timestamp = fmtStamp(st)
          out.rawCount = cnt
          var k2 = typeof ctx.coefficient === 'number' ? ctx.coefficient : null
          var u2 = typeof ctx.unitFactor === 'number' ? ctx.unitFactor : null
          if (k2 === null || u2 === null) {
            out.value = null
            out.display = out.timestamp + ' / ' + cnt + '（未換算）'
          } else {
            out.value = round(cnt * k2 * u2, 4)
            out.display = out.timestamp + ' / ' + out.value + ' kWh'
          }
          return out
        }
        case 'unit': {
          // 0xE1 積算電力量単位
          if (edt.length < 1) return fail(out, '長さ不足')
          var f = UNIT_TABLE[edt[0]]
          out.value = typeof f === 'number' ? f : null
          out.display = typeof f === 'number' ? f + ' kWh/カウント' : '不明（0x' + hex2(edt[0]) + '）'
          return out
        }
        case 'u8': {
          if (edt.length < 1) return fail(out, '長さ不足')
          out.value = edt[0]
          out.display = edt[0] + (meta.unit ? ' ' + meta.unit : '')
          return out
        }
        case 'state': {
          // 0x80 動作状態: 0x30=ON, 0x31=OFF
          if (edt.length < 1) return fail(out, '長さ不足')
          out.value = edt[0]
          out.display = edt[0] === 0x30 ? 'ON' : edt[0] === 0x31 ? 'OFF' : '0x' + hex2(edt[0])
          return out
        }
        case 'fault': {
          // 0x88 異常発生状態: 0x41=異常あり, 0x42=異常なし
          if (edt.length < 1) return fail(out, '長さ不足')
          out.value = edt[0]
          out.display = edt[0] === 0x42 ? '異常なし' : edt[0] === 0x41 ? '異常あり' : '0x' + hex2(edt[0])
          return out
        }
        case 'hex': {
          out.value = edt.toString('hex').toUpperCase()
          out.display = '0x' + out.value
          return out
        }
        case 'ascii': {
          out.value = edt.toString('ascii').replace(/[^\x20-\x7e]/g, '')
          out.display = out.value
          return out
        }
        case 'hm': {
          // 0x97 現在時刻設定: 時(1) 分(1)
          // 長さを見ないと edt[1] が undefined になり、'12:undefined' という
          // 文字列がそのまま値として下流へ流れる (例外も出ないので気づけない)
          if (edt.length < 2) return fail(out, '長さ不足')
          out.value = pad(edt[0], 2) + ':' + pad(edt[1], 2)
          out.display = out.value
          return out
        }
        case 'ymd': {
          // 0x98 現在年月日設定: 年(2) 月(1) 日(1)
          if (edt.length < 4) return fail(out, '長さ不足')
          out.value = edt.readUInt16BE(0) + '-' + pad(edt[2], 2) + '-' + pad(edt[3], 2)
          out.display = out.value
          return out
        }
        case 'ymdhm': {
          out.value = out.raw
          out.display = out.raw
          return out
        }
        case 'history1': {
          // 0xE2/0xE4: 収集日(2バイト) + 30分毎48コマ × 4バイト = 194 バイト
          if (edt.length < 2) return fail(out, '長さ不足')
          var day = edt.readUInt16BE(0)
          var samples = []
          var k3 = typeof ctx.coefficient === 'number' ? ctx.coefficient : null
          var u3 = typeof ctx.unitFactor === 'number' ? ctx.unitFactor : null
          for (var i = 0; i + 4 <= edt.length - 2; i += 4) {
            var c = edt.readUInt32BE(2 + i)
            if (c === 0xfffffffe) {
              samples.push(null) // 未計測
            } else if (k3 !== null && u3 !== null) {
              samples.push(round(c * k3 * u3, 4))
            } else {
              samples.push(c)
            }
          }
          out.collectDay = day
          out.value = samples
          out.display = day + ' 日前 / ' + samples.length + ' コマ'
          // 規定は 30 分刻みの 48 コマ (2 + 48*4 = 194 バイト)。
          // 揃っていなければ電文が途中で切れているので、
          // 「全コマ未計測」と区別できるよう印をつける。
          if (samples.length !== 48) {
            out.converted = false
            out.note = '履歴が 48 コマそろっていません（' + samples.length + ' コマ / ' + edt.length + ' バイト）。電文が途中で切れている可能性があります'
          } else {
            out.converted = k3 !== null && u3 !== null
          }
          return out
        }
        case 'history2': {
          out.value = out.raw
          out.display = edt.length + ' バイト（生データ）'
          return out
        }
        case 'propmap': {
          out.value = decodePropertyMap(edt)
          out.display = out.value.map(function (x) { return '0x' + hex2(x) }).join(' ')
          return out
        }
        default: {
          out.value = out.raw
          out.display = '0x' + out.raw
          return out
        }
      }
    } catch (e) {
      return fail(out, '解釈失敗: ' + e.message)
    }
  }

  function fail(out, note) {
    out.value = null
    out.display = '—'
    out.note = note
    return out
  }

  function round(v, digits) {
    var m = Math.pow(10, digits)
    return Math.round(v * m) / m
  }

  /**
   * プロパティマップ (0x9D/0x9E/0x9F) を EPC の配列に展開する。
   * 先頭バイトがプロパティ数。16 未満なら以降がそのまま EPC の並び、
   * 16 以上なら 16 バイトのビットマップ形式 (付表2形式)。
   */
  function decodePropertyMap(edt) {
    if (!edt || edt.length < 1) return []
    var n = edt[0]
    var list = []
    if (n < 16) {
      // 直値列挙形式。先頭のプロパティ数に続けて EPC がそのまま並ぶ。
      // 本来 PDC は n+1 になる。食い違っている場合は形式の取り違えなので、
      // 並んでいるバイトを EPC として鵜呑みにしない。
      if (edt.length !== n + 1) return []
      for (var i = 1; i < edt.length; i++) list.push(edt[i])
      return list
    }
    // ビットマップ形式は必ず 1 + 16 バイト
    if (edt.length < 17) return []
    // ビットマップ形式: edt[1..16] が bit0..7 / 列 0x8n..0xFn に対応
    for (var bit = 0; bit < 8; bit++) {
      for (var col = 0; col < 16; col++) {
        if (edt.length < 1 + col + 1) continue
        if (edt[1 + col] & (1 << bit)) {
          list.push(0x80 + bit * 16 + col)
        }
      }
    }
    list.sort(function (a, b) { return a - b })
    return list
  }

  return {
    EHD1: EHD1, EHD2: EHD2, CONTROLLER: CONTROLLER, METER: METER,
    ESV: ESV, ESV_NAME: ESV_NAME, EPC: EPC, UNIT_TABLE: UNIT_TABLE,
    buildGet: buildGet,
    parseFrame: parseFrame,
    decode: decode,
    decodePropertyMap: decodePropertyMap,
    hex2: hex2,
  }
})()

// Node-RED のノードから require して使う。
module.exports = EL
