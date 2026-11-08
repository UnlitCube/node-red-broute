'use strict'

// ============================================================================
//  API で出す形（view-model）
// ============================================================================
//
//  **許可リストで組み立てる。** sequencer の snapshot() をそのまま返さない。
//  snapshot には認証 ID の一部（idHint）など、画面に要らないものが入るため。
//  ここで作る形には、認証 ID・パスワード・idHint を入れない
//  （試験で全部の形を JSON にして文字列で検索している）。
//
//  入力は registry の AdapterHandle.inspect() が作る:
//    { id, meta:{name, role, deviceKey, enabled, mode, port, portLabel, expectedMac, named?},
//      consumers, snap (snapshot() か null), phaseSince, options, pairId, credentialSource, credentialState,
//      buildError, enabledBy, recordingSince, libVersion, redact }
//
//  画面のために足してある項目:
//    AdapterSummary に named（名前を入れたか）・connectHint（つながらないときの案内）・txGuardSec（送信を休む線）。
//    portLabel は config-fields の portLabelOf の規則（USB0・ACM0・シミュレーター・ポート未設定）。
//    AdapterDetail.lastError に hint（何をすればよいかの 1 行。error-hints.js）。
//    AdapterDetail.recordingSince（今の記録の始まり。このプロセスで最初に claim した時刻で、接続先を変えて推移を捨てたらその時刻）。
//    画面が推移の途切れを数え始める時刻で、動いている Node-RED に足した台の「足す前の時間」と、捨てた時間を途切れに数えないために渡す。
//    ValueRow に label（短い名前）・meterAt（EA・EB の確定の時刻）。display は単位を 1 回だけ含む（画面は単位の列を持たない）。
//    Settings と Config の各 field に tier（'basic' | 'advanced'）。

const { health, staleAfterMs, levelOrder } = require('./health')
const { MAP } = require('../normalize')
const EL = require('../echonet')
const { DEFAULTS: SEQ_DEFAULTS } = require('../sequencer')
const { FIELDS, FIELD_NAMES, normalizeConfigValue } = require('./settings-store')
const { CONFIG_FIELDS, CONFIG_FIELD_NAMES, storedValueOk, describeConfigValue, portLabelOf } = require('./config-fields')
const catalog = require('./epc-catalog')
const { hintOf } = require('./error-hints')

const DEFAULT_ONCE = [0xd3, 0xe1, 0xd7, 0x9f, 0x8a, 0x8d, 0x82, 0x81]
const DEFAULT_SLOW = [0xe0, 0xe3, 0x88, 0x80]
const DEFAULT_HALF = [0xea, 0xeb]

function epcHex(n) {
  return '0x' + ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
}

function epcNum(s) {
  if (typeof s === 'number') return s & 0xff
  const n = parseInt(String(s).replace(/^0x/i, ''), 16)
  return isNaN(n) ? null : n
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null
}

function str(v) {
  return v === null || v === undefined ? null : String(v)
}

function identity(s) {
  return s
}

function textOf(input, v) {
  if (v === null || v === undefined) return null
  const r = input && typeof input.redact === 'function' ? input.redact : identity
  return r(String(v))
}

/**
 * 機器から届いた値を JSON に出せる形にそろえる。
 * 数・文字列・真偽・null・配列・素のオブジェクトだけを通し、深さを抑える。
 */
function sanitizeValue(v, depth) {
  const d = depth || 0
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) : v
  if (typeof v === 'boolean') return v
  if (Buffer.isBuffer(v)) return v.toString('hex').toUpperCase()
  if (d >= 4) return null
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => sanitizeValue(x, d + 1))
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).slice(0, 50)) out[k] = sanitizeValue(v[k], d + 1)
    return out
  }
  return null
}

function opts(input) {
  const o = (input && input.options) || {}
  const snap = input && input.snap
  return {
    pollIntervalSec: num(snap && snap.pollIntervalSec) || num(o.pollIntervalSec) || FIELDS.pollIntervalSec.default,
    pollEpcs: (snap && Array.isArray(snap.pollEpcs) ? snap.pollEpcs.map(epcNum) : o.pollEpcs || [0xe7, 0xe8]).filter(
      (n) => n !== null
    ),
    slowIntervalSec: num(o.slowIntervalSec) || FIELDS.slowIntervalSec.default,
    halfHourIntervalSec: num(o.halfHourIntervalSec) || FIELDS.halfHourIntervalSec.default,
    slowEpcs: Array.isArray(o.slowEpcs) ? o.slowEpcs : DEFAULT_SLOW,
    halfHourEpcs: Array.isArray(o.halfHourEpcs) ? o.halfHourEpcs : DEFAULT_HALF,
    onceEpcs: Array.isArray(o.onceEpcs) ? o.onceEpcs : DEFAULT_ONCE,
  }
}

/** その EPC の値を「新しい」とみなす長さ [ms]。Infinity は「変わらない値」。 */
function freshForMs(epc, o) {
  if (o.pollEpcs.indexOf(epc) >= 0) return staleAfterMs(o.pollIntervalSec)
  if (o.onceEpcs.indexOf(epc) >= 0) return Infinity
  if (o.slowEpcs.indexOf(epc) >= 0) return (o.slowIntervalSec * 2 + 60) * 1000
  if (o.halfHourEpcs.indexOf(epc) >= 0) return (o.halfHourIntervalSec * 2 + 60) * 1000
  return staleAfterMs(o.pollIntervalSec)
}

/**
 * その時刻に取れた値が、いま新しいか（計測値の表の fresh と同じ規則。read でも使う）。
 * 定期取得の値は取得間隔の 3 倍 + 30 秒、5 分 / 30 分の値はその間隔の 2 倍 + 60 秒、接続時に 1 度だけ取る値は古くならない。
 */
function isFreshAt(input, epc, at, now) {
  const a = num(at)
  if (a === null) return false
  return now - a <= freshForMs(epcNum(epc), opts(input))
}

/** 定期取得する EPC（取得間隔ごと・5 分・30 分。数の昇順）。read の「全部」で、まだ無い値と取り直す値を決める。 */
function periodicEpcs(input) {
  const o = opts(input)
  const set = new Set()
  for (const list of [o.pollEpcs, o.slowEpcs, o.halfHourEpcs]) {
    for (const x of list || []) {
      const n = epcNum(x)
      if (n !== null) set.add(n)
    }
  }
  return Array.from(set).sort((a, b) => a - b)
}

/** 預かっている数と、いちばん古いものの待ち時間（pendingCommands）。無ければ {count: 0, oldestMs: null}。 */
function pendingOf(input) {
  const p = input && input.pending
  const count = p ? num(p.count) || 0 : 0
  return { count, oldestMs: count > 0 ? num(p.oldestMs) : null }
}

function heldOf(snap, hex, now) {
  const h = snap && snap.snaHold ? snap.snaHold[hex] : null
  if (!h || !(num(h.until) > now)) return null
  return { until: h.until, count: num(h.count) || 0 }
}

function supportedOf(snap, hex) {
  const list = snap && Array.isArray(snap.supportedEpcs) ? snap.supportedEpcs : []
  if (!list.length) return null
  return list.indexOf(hex) >= 0
}

/**
 * 表に出す名前。届いた値の名前 → EPC の名前の表（日本語）→「不明な EPC 0xXX」。
 * 値がまだ無い行（控えている・定期取得でまだ届いていない）で、正規化のキー（installationLocation など英語）を
 * 名前にしない。key は正規化のキーのまま別に出す。
 */
function nameOf(epc, v) {
  if (v && typeof v.name === 'string' && v.name) return v.name
  const meta = EL.EPC[epc]
  return meta ? meta.name : '不明な EPC 0x' + EL.hex2(epc)
}

/** 定時積算（EA・EB）の display の先頭の確定の時刻「YYYY-MM-DD HH:MM:SS / …」。 */
const STAMP_RE = /^\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\s*\/\s*/

/** B ルートのメーターの時計は日本時間。 */
const METER_UTC_OFFSET_HOURS = 9

/** メーターの時計の 'YYYY-MM-DD HH:MM:SS' をミリ秒の数にする。サーバーの時刻帯に関係なく +09:00 で読む。読めなければ null。 */
function stampMs(y, mo, d, h, mi, se) {
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - METER_UTC_OFFSET_HOURS, Number(mi), Number(se))
  return isFinite(t) ? t : null
}

/** meterAt（ミリ秒の数）をメーターの時計の 'YYYY-MM-DD HH:MM' に戻す。サーバーの時刻帯に関係なく日本時間で書く。 */
function stampText(ms) {
  const d = new Date(ms + METER_UTC_OFFSET_HOURS * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 定時積算の確定の時刻（v.timestamp か display の先頭）と、時刻を除いた display。 */
function splitStamp(v, display) {
  const ts = v && typeof v.timestamp === 'string' ? v.timestamp : null
  let at = null
  if (ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts.trim())
    if (m) at = stampMs(m[1], m[2], m[3], m[4], m[5], m[6])
  }
  const m2 = STAMP_RE.exec(display)
  if (m2) {
    if (at === null) at = stampMs(m2[1], m2[2], m2[3], m2[4], m2[5], m2[6])
    return { meterAt: at, display: display.slice(m2[0].length) }
  }
  return { meterAt: at, display }
}

/**
 * 設置場所（0x81）のコードの意味（ECHONET Lite の機器オブジェクトのスーパークラスの「設置場所」の表）。
 * 1 バイト: 0x00 未設定・0xFF 不定・0x01 位置情報（17 バイト。1 バイトでは来ない）・ビット 7 が 1 なら利用者が決めた値。
 * それ以外はビット 6〜3 が場所、ビット 2〜0 が番号。分からない値は null（display は生の値のまま）。
 */
const LOCATIONS = ['', 'リビング', 'ダイニング', 'キッチン', '浴室', 'トイレ', '洗面所・脱衣所', '廊下', '部屋', '階段', '玄関', '納戸', '庭・外周', '車庫', 'ベランダ・バルコニー', 'その他']

function locationText(raw) {
  const m = /^(?:0x)?([0-9A-Fa-f]{2})$/.exec(String(raw === null || raw === undefined ? '' : raw).trim())
  if (!m) return null
  const b = parseInt(m[1], 16)
  const hex = '0x' + m[1].toUpperCase()
  if (b === 0x00) return `未設定（${hex}）`
  if (b === 0xff) return `不定（${hex}）`
  if (b === 0x01) return null
  if (b & 0x80) return `利用者が決めた場所（${hex}）`
  const place = LOCATIONS[(b >> 3) & 0x0f]
  if (!place) return null
  const no = b & 0x07
  return no ? `${place} ${no}（${hex}）` : `${place}（${hex}）`
}

/** display に単位を 1 回だけ含める（画面は単位の列を持たない）。数だけの display には単位を足す。 */
function withUnit(display, unit) {
  if (!display || !unit) return display
  if (display.indexOf(unit) >= 0) return display
  return /^-?[\d.,]+$/.test(display.trim()) ? display.trim() + ' ' + unit : display
}

/**
 * 値の display と確定の時刻（計測値の表と read で同じ形にするための 1 か所）。
 * @returns {{display: string, meterAt: number|null, unit: string|null}}
 */
function rowDisplay(epc, v) {
  const unit = v && v.unit ? String(v.unit) : null
  let display = v && v.display !== undefined && v.display !== null ? String(v.display) : ''
  let meterAt = null
  // 定時積算は値と確定の時刻（meterAt）を分ける（機器の文字列は「YYYY-MM-DD HH:MM:SS / 値 kWh」の 1 つで、表では読みにくい）
  if (epc === 0xea || epc === 0xeb) {
    const sp = splitStamp(v, display)
    meterAt = sp.meterAt
    display = sp.display
  }
  // 設置場所はコードの意味を出す（value は生の値のまま。16 進のコードだけでは読めない）
  if (epc === 0x81 && v) {
    const loc = locationText(v.value !== undefined && v.value !== null ? v.value : display)
    if (loc) display = loc
  }
  return { display: withUnit(display, unit), meterAt, unit }
}

function makeRow(input, epc, v, now, fresh) {
  const hex = epcHex(epc)
  const m = MAP[epc]
  const at = v ? num(v.at !== undefined ? v.at : v.ts) : null
  const o = opts(input)
  const { display, meterAt, unit } = rowDisplay(epc, v)
  return {
    epc: hex,
    key: m ? m.key : null,
    name: textOf(input, nameOf(epc, v)),
    label: catalog.labelOf(epc),
    value: v ? sanitizeValue(v.value) : null,
    unit,
    display: display ? textOf(input, display) : '',
    at,
    meterAt,
    fresh: fresh !== undefined ? fresh : at !== null && now - at <= freshForMs(epc, o),
    held: heldOf(input.snap, hex, now),
    supported: supportedOf(input.snap, hex),
  }
}

/**
 * 計測値の表。snapshot().known（いま分かっている全部）に、
 * 控えている EPC と定期取得の EPC（まだ値が無いもの）を足す。EPC の順。
 */
function buildValueRows(input, now) {
  const t = typeof now === 'number' ? now : Date.now()
  const snap = input && input.snap
  const known = (snap && snap.known) || {}
  const set = {}
  for (const k of Object.keys(known)) {
    const n = epcNum(k)
    if (n !== null) set[n] = known[k]
  }
  for (const k of Object.keys((snap && snap.snaHold) || {})) {
    const n = epcNum(k)
    if (n !== null && !(n in set)) set[n] = null
  }
  for (const n of opts(input).pollEpcs) if (!(n in set)) set[n] = null
  return Object.keys(set)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => makeRow(input, n, set[n], t))
}

/** 1 回の受信（measurement イベントの values）を ValueRow にする。 */
function valueRowsFromValues(input, values, now) {
  const t = typeof now === 'number' ? now : Date.now()
  return (values || [])
    .filter((v) => v && typeof v.epc === 'number')
    .map((v) => makeRow(input, v.epc, v, t, true))
}

function round1(x) {
  return Math.round(x * 10) / 10
}

function power(snap) {
  const v = snap && snap.known ? snap.known['0xE7'] : null
  return { value: v ? num(v.value) : null, at: v ? num(v.at) : null }
}

function current(snap) {
  const v = snap && snap.known ? snap.known['0xE8'] : null
  const val = v && v.value && typeof v.value === 'object' ? v.value : null
  const r = val ? num(val.r) : null
  const t = val ? num(val.t) : null
  return { r, t, total: r === null ? null : t === null ? r : round1(r + t), at: v ? num(v.at) : null }
}

function isStale(input, snap, now) {
  if (!snap) return false
  const limit = staleAfterMs(opts(input).pollIntervalSec)
  // lastValueAt は主な値（瞬時電力など）が届いた時刻。5 分・30 分の値では進まない（sequencer の _isMainValue）
  const last = num(snap.lastValueAt)
  if (snap.connected) {
    // 繋がってから最初の値を待つ間だけ猶予する。起点は「最後の主な値のあと、最初に繋がった時刻」（valueWaitSince）。
    // null は「待っていない」（主な値が届いている）ので猶予しない。値が来ないまま繋ぎ直すたびに起点が延びると、
    // 古い値がいつまでも合計に入る。項目の無い形（前の版の snapshot）だけ phaseSince を使う
    const wait = snap.valueWaitSince
    const since = snap.phase === 'connected' ? (wait === undefined ? num(input.phaseSince) || 0 : num(wait) || 0) : 0
    const ref = Math.max(last || 0, since)
    return ref > 0 ? now - ref > limit : false
  }
  return last !== null ? now - last > limit : false
}

/** 取得間隔の値のどれかを、メーターが断っていて今も控えているか（health の次の一手を分ける。計測値の表の held と同じ規則） */
function pollHeldOf(input, snap, now) {
  const held = (snap && snap.snaHold) || {}
  // 見るのは主な値（sequencer の _isMainValue と同じ選び方: 瞬時電力を取っていれば瞬時電力だけ）
  const eps = opts(input).pollEpcs
  const main = eps.indexOf(0xe7) >= 0 ? [0xe7] : eps
  return main.some((n) => {
    const h = held[epcHex(n)]
    return !!h && typeof h.until === 'number' && h.until > now
  })
}

function phaseOf(input) {
  const meta = input.meta || {}
  const snap = input.snap
  if (meta.enabled === false) return { phase: 'disabled', phaseText: '無効' }
  if (!snap) {
    if (input.buildError) return { phase: 'error', phaseText: 'アダプタを初期化できませんでした' }
    return { phase: 'idle', phaseText: '停止中' }
  }
  return { phase: String(snap.phase), phaseText: String(snap.phaseText || snap.phase) }
}

function macMatches(expected, mac) {
  if (!expected || !mac) return null
  return String(expected).toUpperCase() === String(mac).toUpperCase()
}

function stoppedOf(input, snap) {
  const s = snap && snap.overrides ? snap.overrides.stopped : null
  if (!s) return null
  return { reason: textOf(input, s.reason) || '', at: num(s.at) }
}

/**
 * 名前を入れたか。設定ノードか画面・フローで名前を入れていれば true。
 * meta.named（設定ノードと registry が入れる）が無い版では、name が代わりの値（契約・ポート・id）と同じかで推す。
 */
function namedOf(input) {
  const meta = input.meta || {}
  if (typeof meta.named === 'boolean') return meta.named
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  if (!name) return false
  const same = (x) => typeof x === 'string' && x.trim() !== '' && x.trim() === name
  return !same(meta.role) && !same(meta.port) && name !== String(input.id)
}

/**
 * 文の中に出す台の名前（displayText。トースト・確認・サーバーの message）。
 *   名前を入れていて契約と違えば、その名前。そうでなければ「電力（USB0）」。契約が無ければ「USB0」。
 * @param {object} s AdapterSummary（name・role・named・portLabel）か、同じ項目を持つもの
 */
function displayNameOf(s) {
  const x = s || {}
  const name = typeof x.name === 'string' ? x.name.trim() : ''
  const role = typeof x.role === 'string' ? x.role.trim() : ''
  const label = typeof x.portLabel === 'string' && x.portLabel ? x.portLabel : x.id ? String(x.id) : ''
  if (x.named && name && name !== role) return name
  return role ? `${role}（${label}）` : label
}

const HINT_KINDS = ['credentials', 'no-meter']

/**
 * つながらないときの案内。sequencer の snapshot().connectHint（{kind, since, rounds}）を許可リストで写す。
 * つながっていれば null。直近のエラーの文言からは推さない（次の失敗で上書きされるので案内が出たり消えたりする）。
 */
function connectHintOf(snap) {
  if (!snap || snap.connected) return null
  const h = snap.connectHint
  if (!h || typeof h !== 'object' || HINT_KINDS.indexOf(h.kind) < 0) return null
  return { kind: h.kind, since: num(h.since), rounds: Math.max(0, Math.floor(num(h.rounds) || 0)) }
}

/**
 * 認証情報が揃っているか（AdapterDetail.credentials）。設定ノードが決めた状態を先に見るので、
 * sequencer の無い台（無効・初期化の失敗）にも答えられて、Config の credentials と食い違わない。
 * 設定ノードの状態が無い handle は sequencer の値。
 */
function configuredOf(input) {
  if (input.credentialState) return !!input.credentialState.configured
  return !!(input.snap && input.snap.credentials && input.snap.credentials.configured)
}

/**
 * 送信を休む線 [秒]（sequencer の txBudgetGuardMs。画面の送信積算のゲージ）。
 * snapshot か options に無ければ sequencer の既定値。休まない設定（txBudgetGuard: false）なら null。
 */
function txGuardSecOf(input) {
  const snap = input.snap || {}
  const o = input.options || {}
  if (snap.txBudgetGuard === false || o.txBudgetGuard === false) return null
  let ms = num(snap.txBudgetGuardMs)
  if (ms === null) ms = num(o.txBudgetGuardMs)
  if (ms === null) ms = SEQ_DEFAULTS.txBudgetGuardMs
  return typeof ms === 'number' && ms > 0 ? Math.round(ms / 1000) : null
}

/** AdapterSummary。 */
function buildSummary(input, now) {
  const t = typeof now === 'number' ? now : Date.now()
  const meta = input.meta || {}
  const snap = input.snap || null
  const ph = phaseOf(input)
  const stale = isStale(input, snap, t)
  const pw = power(snap)
  // 合計に足すのは瞬時電力そのものなので、その値が新しいかを持たせる（取得間隔の値から瞬時電力を外した台や、
  // 瞬時電力だけ断られている台で、古い瞬時電力を合計に入れない）
  pw.fresh = pw.at === null ? null : isFreshAt(input, 0xe7, pw.at, t)
  const cur = current(snap)
  const stopped = stoppedOf(input, snap)
  const mode = meta.mode === 'simulator' ? 'simulator' : 'serial'
  const out = {
    id: String(input.id),
    // 名前の無い台は代わりの値（契約・ポート・id）のまま（出力の device を変えない）。画面は named と portLabel で出し分ける
    name: textOf(input, meta.name) || String(input.id),
    named: namedOf(input),
    role: meta.role ? textOf(input, meta.role) : null,
    deviceKey: str(meta.deviceKey) || '',
    enabled: meta.enabled !== false,
    mode,
    port: textOf(input, meta.port) || '',
    portLabel: textOf(input, meta.portLabel || portLabelOf(mode, meta.port || '', meta.realPath)) || '',
    consumers: num(input.consumers) || 0,
    phase: ph.phase,
    phaseText: ph.phaseText,
    phaseSince: num(input.phaseSince),
    health: null,
    running: !!(snap && snap.running),
    portOpen: !!(snap && snap.portOpen),
    connected: !!(snap && snap.connected),
    power: pw,
    current: cur,
    lastValueAt: snap ? num(snap.lastValueAt) : null,
    stale,
    consecutiveFailures: snap ? num(snap.consecutiveFailures) || 0 : 0,
    ladder: snap ? num(snap.ladder) || 0 : 0,
    overridden: { stopped, any: !!(snap && snap.overrides && snap.overrides.any) },
    lqi: snap && snap.meter ? num(snap.meter.lqi) : null,
    radioBlocked: !!(snap && snap.radioBlocked),
    keyBlocked: !!(snap && snap.keyBlocked),
    txBudgetMs: snap ? num(snap.txBudgetMs) : null,
    txGuardSec: txGuardSecOf(input),
    // フローの入力を、つながるまで預かっている数（一覧の行と状態タブに出す）
    pendingCommands: pendingOf(input),
    // つながらないときの案内。health の reasons と nextAction にも出る
    connectHint: connectHintOf(snap),
  }
  const dev = snap && snap.device ? snap.device : {}
  // 認証情報が揃っているか。sequencer が無い（無効・初期化前）ときは分からないので null（health は決めつけない）
  const configured = snap && snap.credentials ? !!snap.credentials.configured : null
  // 有効を外した所（画面かフロー）と、sequencer を作れなかった理由も健康の判定に渡す
  const eb = input.enabledBy && input.enabledBy.source === 'runtime' ? input.enabledBy : null
  out.health = health(
    {
      enabled: out.enabled,
      enabledBy: eb ? { source: 'runtime', by: str(eb.by) || null, label: eb.label ? textOf(input, eb.label) : null } : null,
      buildError: !snap && input.buildError ? { message: textOf(input, input.buildError.message) } : null,
      credentials: { configured },
      port: out.port,
      portOpen: out.portOpen,
      running: out.running,
      connected: out.connected,
      stale: out.stale,
      lastValueAt: out.lastValueAt,
      pollHeld: pollHeldOf(input, snap, t),
      overridden: out.overridden,
      device: { macMatches: macMatches(meta.expectedMac, dev.mac), expectedMac: meta.expectedMac || null, mac: dev.mac || null },
      consecutiveFailures: out.consecutiveFailures,
      ladder: out.ladder,
      phase: out.phase,
      phaseText: out.phaseText,
      radioBlocked: out.radioBlocked,
      keyBlocked: out.keyBlocked,
      lastError: snap && snap.lastError ? { message: textOf(input, snap.lastError.message), code: str(snap.lastError.code) } : null,
      connectHint: out.connectHint,
    },
    t
  )
  return out
}

/** AdapterDetail。Summary に詳細を足す（どれも許可した項目だけ）。 */
function buildDetail(input, now) {
  const t = typeof now === 'number' ? now : Date.now()
  const s = buildSummary(input, t)
  const snap = input.snap || null
  const meta = input.meta || {}
  const m = (snap && snap.meter) || {}
  const dev = (snap && snap.device) || {}
  const cal = (snap && snap.calibration) || {}
  const join = (snap && snap.join) || {}
  const c = (snap && snap.counters) || {}
  const sf = (snap && snap.sendFails) || {}
  const o = opts(input)
  const last = join.last && typeof join.last === 'object' ? join.last : null
  const snaHold = {}
  for (const [k, h] of Object.entries((snap && snap.snaHold) || {})) {
    if (!/^0x[0-9A-F]{2}$/.test(k) || !h) continue
    snaHold[k] = { count: num(h.count) || 0, until: num(h.until), at: num(h.at) }
  }
  const expectedMac = meta.expectedMac ? String(meta.expectedMac).toUpperCase() : null
  const configured = configuredOf(input)
  return Object.assign(s, {
    meter: {
      addr: str(m.addr),
      ipv6: str(m.ipv6),
      channel: num(m.channel),
      channelMHz: num(m.channelMHz),
      panid: str(m.panid),
      lqi: num(m.lqi),
      rssi: num(m.rssi),
      lqiAt: num(m.lqiAt),
      pairId: str(m.pairId),
    },
    device: {
      version: str(dev.version),
      mac: str(dev.mac),
      expectedMac,
      macMatches: macMatches(expectedMac, dev.mac),
    },
    calibration: { coefficient: num(cal.coefficient), unitFactor: num(cal.unitFactor), digits: num(cal.digits) },
    join: {
      burst: num(join.burst) || 0,
      attempt: num(join.attempt) || 0,
      windows: num(join.windows) || 0,
      windowStartedAt: num(join.windowStartedAt),
      last: last
        ? { num: num(last.num), sender: str(last.sender), elapsedMs: num(last.elapsedMs), at: num(last.at) }
        : null,
    },
    counters: {
      tx: num(c.tx) || 0,
      rx: num(c.rx) || 0,
      failures: num(c.failures) || 0,
      timeouts: num(c.timeouts) || 0,
      joins: num(c.joins) || 0,
      reconnects: num(c.reconnects) || 0,
      resends: num(c.resends) || 0,
      resendRecovered: num(c.resendRecovered) || 0,
      targetedScans: num(c.targetedScans) || 0,
      fullScans: num(c.fullScans) || 0,
    },
    sendFails: { busy: num(sf.busy) || 0, noNa: num(sf.noNa) || 0, mute: num(sf.mute) || 0, fail: num(sf.fail) || 0 },
    pollIntervalSec: o.pollIntervalSec,
    pollEpcs: o.pollEpcs.map(epcHex),
    snaHold,
    supportedEpcs: snap && Array.isArray(snap.supportedEpcs) ? snap.supportedEpcs.map(String) : [],
    wopt: snap && (typeof snap.wopt === 'number' || typeof snap.wopt === 'string') ? snap.wopt : null,
    // hint は何をすればよいかの 1 行（分からなければ null）。機器の文言（message）はそのまま
    lastError:
      snap && snap.lastError && snap.lastError.message
        ? { message: textOf(input, snap.lastError.message), at: num(snap.lastError.at), hint: hintOf(snap.lastError.message) }
        : input.buildError
          ? { message: textOf(input, input.buildError.message), at: num(input.buildError.at), hint: hintOf(input.buildError.message) }
          : null,
    credentials: {
      configured,
      source: textOf(input, input.credentialSource),
      pairId: configured && input.pairId ? String(input.pairId) : null,
    },
    recordingSince: num(input.recordingSince),
    libVersion: str(input.libVersion) || (snap ? str(snap.libVersion) : null) || 'unknown',
  })
}

function sortSummaries(items) {
  return items.slice().sort((a, b) => {
    const d = levelOrder(a.health.level) - levelOrder(b.health.level)
    if (d) return d
    const n = String(a.name).localeCompare(String(b.name), 'ja')
    return n || String(a.id).localeCompare(String(b.id))
  })
}

/**
 * Settings。出どころは 一時的な上書き（override）→ 運用設定（runtime）→ 設定ノード（config）→ 既定値（default）。
 * @param {object} p {rec (運用設定の記録か null), configValues, snap, options, enabled, dropped, rev}
 */
function buildSettings(p) {
  const rec = p.rec || null
  const snap = p.snap || null
  const o = p.options || {}
  const fields = {}
  const warnings = []
  // 照合（エディタで設定ノードの値を変えてデプロイ）で運用設定を外した項目（handle.settingsDropped。外した時刻 at つき）
  const droppedOf = {}
  for (const d of p.dropped || []) if (d && FIELDS[d.field]) droppedOf[d.field] = d
  for (const k of FIELD_NAMES) {
    const def = FIELDS[k]
    const cfg = normalizeConfigValue(k, p.configValues ? p.configValues[k] : null)
    const rt = rec && rec.fields && rec.fields[k] ? rec.fields[k] : null
    let override = null
    if (snap && snap.overrides && (k === 'pollIntervalSec' || k === 'pollEpcs')) {
      const ov = snap.overrides[k]
      if (ov !== null && ov !== undefined) override = k === 'pollEpcs' ? ov.map((x) => epcHex(epcNum(x))) : ov
    }
    let effective = null
    if (snap && k === 'pollIntervalSec') effective = num(snap.pollIntervalSec)
    else if (snap && k === 'pollEpcs' && Array.isArray(snap.pollEpcs)) effective = snap.pollEpcs.map((x) => epcHex(epcNum(x)))
    else if (snap && (k === 'slowIntervalSec' || k === 'halfHourIntervalSec')) effective = num(o[k])
    const source = override !== null ? 'override' : rt ? 'runtime' : cfg !== null ? 'config' : 'default'
    if (effective === null) {
      effective = override !== null ? override : rt ? rt.value : cfg !== null ? cfg : def.default
    }
    const f = {
      value: effective,
      source,
      // 運用設定そのものの値（無ければ null）。一時的な上書きの下にあっても出す（画面とエディタで
      // 「上書きを外すとこの値に戻る」「エディタで変えてデプロイすると外れる」を出すため）。書き方は value と同じ（EPC は '0xE7'）
      runtimeValue: rt ? normalizeConfigValue(k, rt.value) : null,
      configValue: cfg,
      default: def.default,
      min: def.min,
      max: def.max,
      by: rt ? str(rt.by) : null,
      at: rt ? num(rt.at) : null,
      // 基本設定 / 詳細設定（正は settings-store の FIELDS）
      tier: def.tier,
    }
    // エディタで外れた項目は、変えた人を 'editor'（画面は「エディタ」）、時刻を外したときにする。
    // 照合は記録から項目を消すので、rt が無く by / at が null のままだった。出どころは設定ノード（か既定値）のまま。
    // 一時的な上書きが掛かった項目には付けない（画面は上書きの by / at を「上書きの下の運用設定」と読む）
    if (!rt && override === null && droppedOf[k]) {
      f.by = 'editor'
      f.at = num(droppedOf[k].at)
    }
    if (def.unit) f.unit = def.unit
    // EPC を名前で選ぶ。候補（履歴の E2・E4・EC は入れない）と、まとまりの見出し
    if (k === 'pollEpcs') {
      f.options = catalog.pollEpcOptions(Array.isArray(p.supportedEpcs) ? { supportedEpcs: p.supportedEpcs } : snap)
      f.groups = catalog.GROUPS.map((g) => Object.assign({}, g))
    }
    // 5 分 / 30 分の取得で何を取るか（名前で。sequencer の slowEpcs / halfHourEpcs）
    if (k === 'slowIntervalSec') f.takes = catalog.takesOf(Array.isArray(o.slowEpcs) ? o.slowEpcs : DEFAULT_SLOW)
    if (k === 'halfHourIntervalSec') f.takes = catalog.takesOf(Array.isArray(o.halfHourEpcs) ? o.halfHourEpcs : DEFAULT_HALF)
    fields[k] = f
    if (override !== null && rt) {
      warnings.push(`${def.label}に一時的な上書きが掛かっています。運用設定は上書きを外したときに効きます`)
    }
  }
  if (p.enabled === false) warnings.push('アダプタが無効です。設定は次に有効にしたときに効きます')
  for (const d of p.dropped || []) {
    const def = FIELDS[d.field]
    if (!def) continue
    warnings.push(`設定ノードの${def.label}が変わったため、運用設定（${fmt(d.value)}）を外しました`)
  }
  return { rev: String(p.rev || (rec && rec.rev) || '0'), fields, warnings }
}

function fmt(v) {
  return Array.isArray(v) ? v.map((x) => String(x).replace(/^0x/, '')).join(', ') : String(v)
}

/** 構成の項目の選択肢（画面の選択とエディタの説明に使う）。 */
const CONFIG_CHOICES = {
  mode: [
    { value: 'serial', label: 'Wi-SUN アダプタ（実機）' },
    { value: 'simulator', label: 'シミュレーター（実機なしで試す）' },
  ],
}

/**
 * Config（Settings と同じ形で、fields が構成の項目）。
 * 出どころは 画面かフローで保存した値（runtime）→ 設定ノード（config）→ 既定値（default）。
 * **認証 ID とパスワードは入れない**（credentials は configured・source・pairId・envOverrides・stored だけ）。
 * @param {object} p {rec: store.getConfig(), editor: そろえた設定ノードの値, credentials, applying, locked, lockedReason, dropped, enabled}
 */
function buildConfig(p) {
  const rec = p.rec || { rev: '0', fields: {} }
  const stored = rec.fields || {}
  const editor = p.editor || {}
  const fields = {}
  const warnings = []
  const droppedOf = {}
  for (const d of p.dropped || []) if (d && CONFIG_FIELDS[d.field]) droppedOf[d.field] = d
  for (const k of CONFIG_FIELD_NAMES) {
    const def = CONFIG_FIELDS[k]
    const rt = stored[k] ? stored[k] : null
    const rtValue = rt ? storedValueOk(k, rt.value) : undefined
    const cfg = editor[k] === undefined ? null : editor[k]
    const source = rtValue !== undefined ? 'runtime' : cfg !== null ? 'config' : 'default'
    const value = rtValue !== undefined ? rtValue : cfg !== null ? cfg : def.default
    const f = {
      label: def.label,
      value: sanitizeValue(value),
      source,
      runtimeValue: rtValue !== undefined ? sanitizeValue(rtValue) : null,
      configValue: sanitizeValue(cfg),
      default: sanitizeValue(def.default),
      connection: !!def.connection,
      by: rtValue !== undefined ? str(rt.by) : null,
      at: rtValue !== undefined ? num(rt.at) : null,
      // 基本設定 / 詳細設定（正は config-fields の CONFIG_FIELDS）
      tier: def.tier,
    }
    if (def.maxLength) f.maxLength = def.maxLength
    if (def.type === 'baud') f.values = def.values.slice()
    if (def.type === 'durations') {
      f.min = def.min
      f.max = def.max
      f.maxItems = def.maxItems
    }
    if (CONFIG_CHOICES[k]) f.options = CONFIG_CHOICES[k].map((c) => Object.assign({}, c))
    // エディタで値を変えて、画面かフローの値が外れた項目（運用設定と同じく by: 'editor' と外した時刻）
    if (rtValue === undefined && droppedOf[k]) {
      f.by = 'editor'
      f.at = num(droppedOf[k].at)
    }
    fields[k] = f
  }
  for (const d of p.dropped || []) {
    const def = CONFIG_FIELDS[d.field]
    if (!def) continue
    warnings.push(`設定ノードの${def.label}が変わったため、画面かフローで保存した値（${describeConfigValue(d.field, d.value)}）を外しました`)
  }
  const c = p.credentials || {}
  const credentials = {
    configured: !!c.configured,
    source: c.source === null || c.source === undefined ? null : String(c.source),
    pairId: c.configured && typeof c.pairId === 'string' ? c.pairId : null,
    envOverrides: !!c.envOverrides,
    stored: c.stored && typeof c.stored === 'object' ? { by: str(c.stored.by), at: num(c.stored.at) } : null,
  }
  if (credentials.envOverrides) {
    warnings.push('認証 ID とパスワードは環境変数が優先されるので、画面かフローで保存しても効きません')
  }
  if (p.enabled === false) warnings.push('アダプタが無効です。有効にするとポートを開きます')
  return {
    rev: String(rec.rev || '0'),
    fields,
    credentials,
    applying: !!p.applying,
    locked: !!p.locked,
    lockedReason: p.locked ? str(p.lockedReason) : null,
    warnings,
  }
}

module.exports = {
  displayNameOf,
  namedOf,
  connectHintOf,
  txGuardSecOf,
  locationText,
  splitStamp,
  stampText,
  rowDisplay,
  buildSummary,
  buildDetail,
  buildValueRows,
  valueRowsFromValues,
  buildSettings,
  buildConfig,
  sortSummaries,
  sanitizeValue,
  epcHex,
  epcNum,
  isFreshAt,
  periodicEpcs,
  pendingOf,
}
