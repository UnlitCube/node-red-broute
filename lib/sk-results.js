'use strict'

// ============================================================================
//  SKSTACK-IP の行とコマンドの結果を、JSON にそのまま変換できるオブジェクトに直す
// ============================================================================
//
//  wsuha-broute の出力 (raw・command-result・diag) の payload を、
//  後ろに json ノードやパーサーを挟まずに使えるただのオブジェクトにするための純関数。
//
//  ・行の分け方は lib/sk-protocol.js の parseLine と feed (シーケンサーが使っているもの) に従う。
//    ここで別の読み方を作ると、出力の kind とシーケンサーの解釈が食い違う。
//  ・ERXUDP のデータは、ECHONET Lite として読めれば lib/echonet.js でプロパティの名前と値まで。
//  ・返すものに Buffer・Date・undefined・NaN・-0 を入れない (最後に toJsonSafe を通す)。
//  ・認証 ID とパスワードを伏せるのは呼び出し側 (registry の redact・diagRead の mask)。
//    ここでは SKSET… のエコーの引数を parsed に写さないだけ。

const SK = require('./sk-protocol')
const EL = require('./echonet')

// ---------------------------------------------------------------------------
//  JSON にそのまま変換できる形
// ---------------------------------------------------------------------------

/**
 * 値を「JSON の往復で変わらない」ただのオブジェクトにする。
 *   undefined・関数・Symbol の持ち物は落とす (配列の中なら null)・NaN と Infinity は null・-0 は 0・
 *   Buffer は 16 進の大文字・Date は ISO の文字列・Map はオブジェクト・Set は配列・循環は null。
 */
function toJsonSafe(value) {
  return plain(value, [])
}

function plain(v, stack) {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'string' || t === 'boolean') return v
  if (t === 'number') return Number.isFinite(v) ? (v === 0 ? 0 : v) : null
  if (t === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v)
  if (t !== 'object') return null // function・symbol
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex').toUpperCase()
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString()
  if (stack.indexOf(v) >= 0) return null
  stack.push(v)
  let out
  if (Array.isArray(v) || v instanceof Set) {
    const list = Array.isArray(v) ? v : Array.from(v)
    out = []
    for (let i = 0; i < list.length; i++) out.push(plain(list[i], stack))
  } else if (v instanceof Map) {
    out = {}
    v.forEach((x, k) => put(out, String(k), x, stack))
  } else {
    out = {}
    for (const k of Object.keys(v)) put(out, k, v[k], stack)
  }
  stack.pop()
  return out
}

function put(out, key, x, stack) {
  if (x === undefined || typeof x === 'function' || typeof x === 'symbol') return
  const val = plain(x, stack)
  // '__proto__' を代入するとプロトタイプが変わるので、持ち物として定義する (JSON.parse と同じ)
  if (key === '__proto__') Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true })
  else out[key] = val
}

// ---------------------------------------------------------------------------
//  小さな道具
// ---------------------------------------------------------------------------

function toText(line) {
  if (Buffer.isBuffer(line)) return line.toString('latin1')
  if (line === null || line === undefined) return ''
  return String(line)
}

/** 前後の CR / LF を落とす (応答は <CRLF>本文<CRLF> で、CR で切ると先頭に LF が残る)。 */
function cleanLine(line) {
  return toText(line).replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '')
}

function hexNum(s) {
  const t = String(s === undefined || s === null ? '' : s).trim()
  return /^[0-9A-Fa-f]{1,8}$/.test(t) ? parseInt(t, 16) : null
}

function upperOrNull(s) {
  return s === undefined || s === null || s === '' ? null : String(s).toUpperCase()
}

function round1(x) {
  return Math.round(x * 10) / 10
}

/** 'SKSREG s2  21' → {text: 'SKSREG s2 21', name: 'SKSREG', args: ['s2', '21']} */
function splitCommand(command) {
  const text = toText(command).trim().replace(/\s+/g, ' ')
  const tokens = text ? text.split(' ') : []
  return { text, name: (tokens[0] || '').toUpperCase(), args: tokens.slice(1) }
}


// ---------------------------------------------------------------------------
//  レジスタ (SKSREG)
// ---------------------------------------------------------------------------

/**
 * SKSREG のレジスタの値に意味と単位を付ける。
 * @param {string|null} register 'S16'・'S2' など (分からなければ null)
 * @param {string|null} raw      ESREG の値 (16 進の文字列)
 * @returns {{register, raw, value, unit, meaning, description, text}} 分からないレジスタは meaning: null
 */
function describeRegister(register, raw) {
  const reg = register === undefined || register === null || register === '' ? null : SK.normalizeRegister(register)
  const r = raw === undefined || raw === null ? null : String(raw).trim()
  const meta = reg && Object.prototype.hasOwnProperty.call(SK.REGISTERS, reg) ? SK.REGISTERS[reg] : null
  const out = { register: reg, raw: r, value: r, unit: null, meaning: null, description: null, text: null }
  if (!meta) return toJsonSafe(out)
  out.unit = meta.unit || null
  out.meaning = meta.name
  out.description = meta.desc || null
  if (r === null) {
    out.value = null
    return toJsonSafe(out)
  }
  if (meta.kind === 'id') {
    out.value = r.toUpperCase()
    out.text = meta.unset && out.value === meta.unset ? `未設定（${out.value}）` : out.value
    return toJsonSafe(out)
  }
  const n = hexNum(r)
  out.value = n
  if (n === null) {
    out.text = `読めない値（${r}）`
    return toJsonSafe(out)
  }
  switch (meta.kind) {
    case 'channel': {
      const mhz = SK.channelToMHz(n)
      out.channelMHz = mhz
      out.text = `${n} ch` + (mhz === null ? '（周波数の範囲の外）' : `（${mhz} MHz）`)
      break
    }
    case 'seconds': {
      const span = n >= 3600 ? `${round1(n / 3600)} 時間` : n >= 60 ? `${round1(n / 60)} 分` : null
      out.text = `${n} 秒` + (span ? `（${span}）` : '')
      break
    }
    case 'ms': {
      out.limitMs = meta.limitMs || null
      out.percent = meta.limitMs ? round1((n / meta.limitMs) * 100) : null
      out.text =
        `${n} ms（${(n / 1000).toFixed(1)} 秒` +
        (meta.limitMs ? `。上限は 1 時間あたり ${meta.limitMs / 1000} 秒で、その ${out.percent}%` : '') +
        '）'
      break
    }
    case 'flag':
      out.text = n === 1 ? meta.on : n === 0 ? meta.off : `不明（${r}）`
      break
    case 'enum':
      out.text = meta.values && Object.prototype.hasOwnProperty.call(meta.values, n) ? meta.values[n] : `不明（${r}）`
      break
    default:
      out.text = meta.unit ? `${n} ${meta.unit}` : String(n)
  }
  return toJsonSafe(out)
}

// ---------------------------------------------------------------------------
//  ECHONET Lite (ERXUDP のデータ部)
// ---------------------------------------------------------------------------

// クラスグループコード + クラスコード → 名前 (このパッケージが出会うものだけ)
const OBJECT_CLASS = {
  '0288': '低圧スマート電力量メータ',
  '05FF': 'コントローラ',
  '0EF0': 'ノードプロファイル',
}

// EL.decode が足す項目のうち、出力に残すもの
const DECODE_EXTRAS = ['rawCount', 'coefficient', 'unitFactor', 'timestamp', 'total', 'collectDay', 'converted']

function className(eoj) {
  const k = String(eoj || '').slice(0, 4).toUpperCase()
  return Object.prototype.hasOwnProperty.call(OBJECT_CLASS, k) ? OBJECT_CLASS[k] : null
}

/** 応答と通知 (0x5n の不可応答・0x7n の応答と通知) か。要求の PDC=0 は「値を聞いている」だけ。 */
function isResponseEsv(esv) {
  return (esv >= 0x50 && esv <= 0x5f) || (esv >= 0x70 && esv <= 0x7f)
}

function describeProperty(p, esv, decodeCtx) {
  const meta = Object.prototype.hasOwnProperty.call(EL.EPC, p.epc) ? EL.EPC[p.epc] : null
  const epc = EL.hex2(p.epc)
  const out = {
    epc,
    name: meta ? meta.name : '不明な EPC 0x' + epc,
    unit: meta && meta.unit ? meta.unit : null,
    pdc: p.pdc,
    edt: p.edt.toString('hex').toUpperCase(),
    value: null,
    display: null,
  }
  if (p.pdc === 0) {
    if (isResponseEsv(esv)) out.note = 'メーターがこの値を返しませんでした（PDC=0）'
    return out
  }
  const d = EL.decode(p.epc, p.edt, decodeCtx)
  // プロパティマップは EPC の 16 進の並び (出力 1 の getPropertyMap.epcs と同じ)
  out.value = meta && meta.kind === 'propmap' && Array.isArray(d.value) ? d.value.map(EL.hex2) : d.value
  out.display = d.display === undefined ? null : d.display
  if (d.note) out.note = d.note
  for (const k of DECODE_EXTRAS) if (d[k] !== undefined) out[k] = d[k]
  return out
}

/**
 * ECHONET Lite の電文を解釈する。
 * @param {string|Buffer} data 16 進の文字列か Buffer
 * @param {object} [ctx] {coefficient, unitFactor} 積算電力量を kWh にするのに使う (0xD3・0xE1)
 * @returns {object|null} 電文として読めなければ null
 */
function describeEchonet(data, ctx) {
  let buf = null
  if (Buffer.isBuffer(data)) buf = data
  else if (typeof data === 'string' && /^(?:[0-9A-Fa-f]{2})+$/.test(data)) buf = Buffer.from(data, 'hex')
  if (!buf) return null
  const f = EL.parseFrame(buf)
  if (!f) return null
  const c = ctx || {}
  const decodeCtx = {}
  if (typeof c.coefficient === 'number' && Number.isFinite(c.coefficient)) decodeCtx.coefficient = c.coefficient
  if (typeof c.unitFactor === 'number' && Number.isFinite(c.unitFactor)) decodeCtx.unitFactor = c.unitFactor
  return toJsonSafe({
    tid: f.tid,
    seoj: f.seoj,
    seojName: className(f.seoj),
    deoj: f.deoj,
    deojName: className(f.deoj),
    esv: EL.hex2(f.esv),
    esvName: f.esvName,
    opc: f.opc,
    props: f.props.map((p) => describeProperty(p, f.esv, decodeCtx)),
  })
}

// ---------------------------------------------------------------------------
//  行ごとの中身
// ---------------------------------------------------------------------------

function failInfo(p) {
  return { code: p.code, message: p.message, advice: p.advice || '', retryable: !!p.retryable }
}

function eventInfo(p) {
  const out = {
    num: p.num,
    numHex: upperOrNull(p.numHex),
    name: p.name,
    severity: p.severity,
    sender: p.sender,
    side: p.side,
    param: p.param,
  }
  if (p.udp) out.udp = { ok: p.udp.ok, text: p.udp.text }
  return out
}

/** ERXUDP: 送り元・宛先・ポート・暗号化・面・データ長・データ (16 進) と ECHONET Lite の解釈。 */
function erxudpInfo(p, text, ctx) {
  // ERXUDP <SENDER> <DEST> <RPORT> <LPORT> <SENDERLLA> [<RSSI>] <SECURED> [<SIDE>] <DATALEN> [<DATA>]
  // parseLine と同じく末尾から数える。間の 1〜3 個が [RSSI] SECURED [SIDE]
  const f = text.trim().split(/\s+/)
  const end = p.encoding === 'empty' ? f.length - 1 : f.length - 2
  const mid = end > 6 ? f.slice(6, end) : []
  let rssiHex = null
  let secured = null
  let side = null
  const flag = (s) => (s === '1' ? true : s === '0' ? false : null)
  if (mid.length === 1) {
    secured = flag(mid[0])
  } else if (mid.length === 2) {
    secured = flag(mid[0])
    side = hexNum(mid[1])
  } else if (mid.length === 3) {
    rssiHex = upperOrNull(mid[0])
    secured = flag(mid[1])
    side = hexNum(mid[2])
  }
  const data = p.encoding === 'hex' ? p.hex : p.encoding === 'empty' ? '' : null
  const out = {
    sender: p.sender,
    dest: p.dest,
    rport: p.rport,
    lport: p.lport,
    senderLla: p.senderlla,
    rssiHex,
    secured,
    side,
    datalen: p.datalen,
    data,
    encoding: p.encoding,
    echonet: p.encoding === 'hex' ? describeEchonet(p.hex, ctx) : null,
  }
  if (p.note) out.note = p.note
  return out
}

/** EINFO (SKINFO の応答)。BP35C0 は 5 つ目が SIDE (実機は 0)、BP35A1 は ADDR16 (4 桁)。 */
function einfoInfo(p, text) {
  const f = text.trim().split(/\s+/)
  const fifth = f[5]
  const channel = hexNum(f[3])
  return {
    ipv6: p.ipv6,
    mac: p.mac,
    channel,
    channelHex: upperOrNull(p.channelHex),
    channelMHz: channel === null ? null : SK.channelToMHz(channel),
    panId: upperOrNull(p.panid),
    side: fifth !== undefined && /^[0-9A-Fa-f]$/.test(fifth) ? parseInt(fifth, 16) : null,
    addr16: fifth !== undefined && /^[0-9A-Fa-f]{4}$/.test(fifth) ? fifth.toUpperCase() : null,
  }
}

const EPANDESC_FIELDS = {
  Channel: 'channel',
  'Channel Page': 'channelPage',
  'Pan ID': 'panId',
  Addr: 'addr',
  LQI: 'lqi',
  Side: 'side',
  PairID: 'pairId',
}

function epandescField(text) {
  const m = text.trim().match(/^([^:]+):(.*)$/)
  const key = m ? m[1].trim() : ''
  const raw = m ? m[2].trim() : ''
  const field = Object.prototype.hasOwnProperty.call(EPANDESC_FIELDS, key) ? EPANDESC_FIELDS[key] : null
  const out = { part: 'field', key, field, raw, value: raw }
  if (field === 'channel' || field === 'lqi' || field === 'side') out.value = hexNum(raw)
  if (field === 'channel') out.channelMHz = out.value === null ? null : SK.channelToMHz(out.value)
  return out
}

function edscanData(text) {
  const r = SK.parseEedscan([text])
  return { part: 'data', side: r.side, channels: r.channels }
}

function tableTitle(name) {
  return Object.prototype.hasOwnProperty.call(SK.TABLES, name) ? SK.TABLES[name].title : null
}

/** 表の 1 行。列の名前が分かる表 (EADDR・ENEIGHBOR) は名前を付け、トークンも残す。 */
function tableRow(name, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const row = { tokens }
  const columns = Object.prototype.hasOwnProperty.call(SK.TABLES, name) ? SK.TABLES[name].columns || [] : []
  for (let i = 0; i < columns.length; i++) row[columns[i]] = tokens[i] === undefined ? null : tokens[i]
  return row
}

function echoInfo(text) {
  const c = splitCommand(text)
  // 認証情報を書くコマンドは、エコーの引数を parsed に写さない
  if (SK.isSecretCommand(c.name)) return { command: c.name, args: null, masked: true }
  return { command: c.name, args: c.args }
}

function pick(kind, parsed) {
  return toJsonSafe({ kind, parsed: parsed === undefined ? null : parsed })
}

/**
 * 受信した 1 行を分ける。
 *
 * @param {string|Buffer} line 受信した 1 行 (前後の CR / LF はあってもよい)
 * @param {object} [ctx] 文脈。どれも省いてよい:
 *   multiline   … nextContext が返す組み立て中の複数行 ({name, mode, expect, rows})。
 *                 EEDSCAN のデータ行と SKTABLE の表の行は、これが無いと 'other' / 'ipv6' になる
 *   coefficient・unitFactor … 積算電力量を kWh にする (0xD3・0xE1)
 *   command     … いま送っているコマンド。'SKSREG S16' なら ESREG の値に意味と単位を付ける
 * @returns {{kind: string, parsed: object|null}}
 *   kind: 'ok'・'fail'・'event'・'erxudp'・'epandesc'・'eedscan'・'etable'・'einfo'・'ever'・'eappver'・
 *         'esreg'・'epong'・'ipv6'・'echo'・'blank'・'other'
 */
function describeLine(line, ctx) {
  const text = cleanLine(line)
  const c = ctx || {}
  const p = SK.parseLine(text)
  const m = c.multiline && c.multiline.name ? c.multiline : null

  // 複数行の続き。feed と同じく、割り込み (EVENT・ERXUDP) と成否はいつでも割り込む。
  // 加えて、ほかの応答として読める行 (EVER・EINFO など) は、閉じていない表の行にしない
  if (m && m.mode !== 'kv' && (p.kind === 'unknown' || (p.kind === 'ipv6' && m.mode === 'until-ok'))) {
    if (m.mode === 'lines' && m.name === 'EEDSCAN') return pick('eedscan', edscanData(text))
    if (m.mode === 'until-ok') return pick('etable', Object.assign({ part: 'row', name: m.name }, tableRow(m.name, text)))
  }
  // EPANDESC の明細は固定のキー (ROHM BP35C0 コマンドマニュアル 4.5)。表やスキャンのデータ行の組み立て中でなければ、見出しが無くても分かる
  if (p.kind === 'unknown' && (!m || m.mode === 'kv') && SK.isEpandescField(text)) {
    return pick('epandesc', epandescField(text))
  }

  switch (p.kind) {
    case 'blank':
      return pick('blank', null)
    case 'ok':
      return pick('ok', { value: p.value })
    case 'fail':
      return pick('fail', failInfo(p))
    case 'event':
      return pick('event', eventInfo(p))
    case 'erxudp':
      return pick('erxudp', erxudpInfo(p, text, c))
    case 'multiline-start':
      if (p.name === 'EPANDESC') return pick('epandesc', { part: 'start' })
      if (p.name === 'EEDSCAN') return pick('eedscan', { part: 'start' })
      return pick('etable', { part: 'start', name: p.name, title: tableTitle(p.name) })
    case 'einfo':
      return pick('einfo', einfoInfo(p, text))
    case 'esreg': {
      const sreg = /^SKSREG\s+(\S+)$/i.exec(splitCommand(c.command).text)
      return pick('esreg', describeRegister(sreg ? sreg[1] : null, p.value))
    }
    case 'epong':
      return pick('epong', { side: p.side, sender: p.sender })
    case 'ipv6':
      return pick('ipv6', { ipv6: p.address })
    case 'ever':
      return pick('ever', { version: p.version })
    case 'eappver':
      return pick('eappver', { appVersion: p.version })
    case 'echo':
      return pick('echo', echoInfo(text))
    default:
      return pick('other', null)
  }
}

// ---------------------------------------------------------------------------
//  行の並びの文脈 (複数行のどこにいるか)
// ---------------------------------------------------------------------------

const MAX_ROWS = 1000

/**
 * 1 行受け取ったあとの文脈を返す (渡した ctx は書き換えない)。
 * 複数行の始まりと終わりは sk-protocol の feed で決める (シーケンサーと同じ区切り方)。
 * ctx の multiline 以外の持ち物 (coefficient など) はそのまま引き継ぐ。
 */
function nextContext(ctx, line) {
  const c = ctx || {}
  const acc = SK.newAccumulator()
  const m = c.multiline && c.multiline.name ? c.multiline : null
  if (m) {
    acc.pending = { name: m.name, mode: m.mode, expect: m.expect || 0 }
    // feed が見るのは行の数だけ (lines モードの「規定行数」)。中身は空でよい
    const rows = Math.min(MAX_ROWS, Math.max(0, Math.floor(Number(m.rows) || 0)))
    for (let i = 0; i < rows; i++) acc.lines.push('')
  }
  SK.feed(acc, cleanLine(line))
  const out = Object.assign({}, c)
  out.multiline = acc.pending
    ? { name: acc.pending.name, mode: acc.pending.mode, expect: acc.pending.expect || 0, rows: Math.min(MAX_ROWS, acc.lines.length) }
    : null
  return toJsonSafe(out)
}

/**
 * 受信した行を届いた順に 1 行ずつ分ける道具 (出力の raw 向け)。複数行の文脈を中に持つ。
 * 終端が来ないまま timeoutMs (既定 2 秒。シーケンサーの flush と同じ) 行が途切れたら、組み立て中の複数行を閉じる。
 *
 *   const d = createLineDescriber()
 *   d.describe(line, {coefficient, unitFactor})  // → {kind, parsed}
 *
 * @param {object} [options] {timeoutMs, now}
 */
function createLineDescriber(options) {
  const o = options || {}
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 2000
  const now = typeof o.now === 'function' ? o.now : Date.now
  let multiline = null
  let lastAt = null
  return {
    describe(line, extra) {
      const t = now()
      if (multiline && lastAt !== null && timeoutMs > 0 && t - lastAt > timeoutMs) multiline = null
      lastAt = t
      const d = describeLine(line, Object.assign({}, extra || {}, { multiline }))
      multiline = nextContext({ multiline }, line).multiline
      return d
    },
    context() {
      return toJsonSafe({ multiline })
    },
    reset() {
      multiline = null
      lastAt = null
    },
  }
}

// ---------------------------------------------------------------------------
//  コマンドの結果
// ---------------------------------------------------------------------------

function feedAll(lines) {
  const acc = SK.newAccumulator()
  const out = []
  for (const l of lines) for (const e of SK.feed(acc, l)) if (e) out.push(e)
  for (const e of SK.flush(acc)) if (e) out.push(e)
  return out
}

function lastOf(events, kind) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i]
  return null
}

function panOf(e) {
  return {
    channel: e.channel,
    channelHex: upperOrNull(e.channelHex),
    channelMHz: e.channelMHz,
    channelPage: e.channelPage,
    panId: upperOrNull(e.panId),
    addr: upperOrNull(e.addr),
    lqi: e.lqi,
    side: e.side,
    pairId: e.pairId,
  }
}

function parseByCommand(cmd, events, lines, terminal) {
  switch (cmd.name) {
    case 'SKINFO': {
      const e = lastOf(events, 'einfo')
      return e ? einfoInfo(e, cleanLine(e.raw)) : null
    }
    case 'SKVER': {
      const e = lastOf(events, 'ever')
      return e ? { version: e.version } : null
    }
    case 'SKAPPVER': {
      const e = lastOf(events, 'eappver')
      return e ? { appVersion: e.version } : null
    }
    case 'ROPT': {
      // ROPT の応答は「OK <WOPT の値>」。bit0 が 1 なら ERXUDP のデータ部は 16 進 ASCII
      const hex = terminal && terminal.value ? String(terminal.value).trim().toUpperCase() : null
      const n = hexNum(hex)
      return { wopt: n, woptHex: n === null ? null : hex, erxudpFormat: n === null ? null : n & 0x01 ? 'hex' : 'binary' }
    }
    case 'SKSREG': {
      const reg = cmd.args[0] || null
      if (cmd.args.length >= 2) return Object.assign(describeRegister(reg, cmd.args[1]), { written: true })
      const e = lastOf(events, 'esreg')
      return Object.assign(describeRegister(reg, e ? e.value : null), { written: false })
    }
    case 'SKTABLE': {
      const e = lastOf(events, 'table')
      const which = upperOrNull(cmd.args[0])
      if (!e) return { table: which, name: null, title: null, rows: [] }
      return { table: which, name: e.name, title: tableTitle(e.name), rows: e.lines.map((l) => tableRow(e.name, l)) }
    }
    case 'SKLL64': {
      const e = lastOf(events, 'ipv6')
      return e ? { mac: upperOrNull(cmd.args[0]), ipv6: e.address } : null
    }
    case 'SKSCAN': {
      // SKSCAN <MODE> <CHANNEL_MASK> <DURATION> <SIDE>。0 は ED スキャン、2・3 はアクティブスキャン
      const mode = hexNum(cmd.args[0])
      const head = { mode, duration: hexNum(cmd.args[2]), side: hexNum(cmd.args[3]) }
      if (mode === 0) {
        const ed = lastOf(events, 'eedscan')
        return Object.assign(head, { completed: !!ed, channels: ed ? ed.channels : [] })
      }
      const done = events.some((e) => e.kind === 'event' && e.num === 0x22)
      return Object.assign(head, { completed: done, pans: events.filter((e) => e.kind === 'epandesc').map(panOf) })
    }
    case 'SKPING': {
      const e = lastOf(events, 'epong')
      return { pong: !!e, side: e ? e.side : null, sender: e ? e.sender : null }
    }
    default:
      return null
  }
}

/**
 * 任意の SK コマンド (と診断) の結果を、コマンドごとの項目に分ける。
 *
 * @param {string} command 送ったコマンド ('SKSREG S16' など。大文字小文字と空白はそろえる)
 * @param {Array<string|Buffer>} lines そのコマンドの間に受け取った行 (伏せ字は呼び出し側で済ませておく)
 * @returns {{ok: boolean, lines: string[], parsed: object|null, error: object|null}}
 *   ok    … 最後の成否の行が OK なら true (SKLL64 は OK が無く、IPv6 の 1 行で成功)
 *   lines … 受け取った行 (前後の CR / LF だけ落とす。エコーも残す)
 *   parsed … SKINFO {ipv6, mac, channel, channelHex, channelMHz, panId, side, addr16}・SKVER {version}・
 *            SKAPPVER {appVersion}・ROPT {wopt, woptHex, erxudpFormat}・
 *            SKSREG {register, raw, value, unit, meaning, description, text, written}・
 *            SKTABLE {table, name, title, rows}・SKLL64 {mac, ipv6}・SKSCAN {mode, duration, side, completed, pans | channels}・
 *            SKPING {pong, side, sender}。知らないコマンドと失敗は null
 *   error … 失敗なら {code, message, advice, retryable} (FAIL ERxx は sk-protocol の ERROR_CODES の日本語)。
 *           OK も FAIL も無ければ code 'NO_RESPONSE'。成功なら null
 */
function parseCommandResult(command, lines) {
  const cmd = splitCommand(command)
  const list = Array.isArray(lines) ? lines.map(cleanLine) : []
  const events = feedAll(list)
  let terminal = null
  for (const e of events) if (e.kind === 'ok' || e.kind === 'fail') terminal = e

  let ok
  let error = null
  if (terminal && terminal.kind === 'fail') {
    ok = false
    error = failInfo(terminal)
  } else if (terminal && terminal.kind === 'ok') {
    ok = true
  } else if (cmd.name === 'SKLL64' && lastOf(events, 'ipv6')) {
    ok = true // SKLL64 は OK を返さない (変換結果の 1 行だけ)
  } else {
    ok = false
    error = { code: 'NO_RESPONSE', message: '成否の応答（OK / FAIL）を受け取っていません', advice: '', retryable: true }
  }
  const parsed = ok ? parseByCommand(cmd, events, list, terminal) : null
  return toJsonSafe({ ok, lines: list, parsed, error })
}

module.exports = {
  describeLine,
  nextContext,
  createLineDescriber,
  parseCommandResult,
  describeRegister,
  describeEchonet,
  toJsonSafe,
}
