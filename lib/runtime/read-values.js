'use strict'

// ============================================================================
//  最新値の読み出し（状態を持って読み出しに答える）
// ============================================================================
//
//  wsuha-broute の入力 read と、画面の API の GET adapters/:id/read が、ここの同じ関数を通る。
//  無線を使わずに、持っている値（sequencer の state.values。作り直す前の値も registry の handle が持ち越す）ですぐ答える。
//  maxAgeSec を付けたときだけ、頼んだ値のどれかがそれより古い・無いなら、取りに行ってから答える（取りに行くのは呼んだ側）。
//
//  返事の形（出力 1 の all と同じ流儀。JSON の往復で変わらない）:
//    { device, deviceKey, ts, at, maxAgeSec, values: { <key>: { epc, name, value, unit, display, at, ts, fresh, ageSec, … } },
//      missing: ['E8', …], refreshed: ['E7', …] }
//    - key は出力 1 と同じ英語の名前（instantPower など）。名前の無い EPC は 16 進（'D0'）
//    - 値の中身は出力 1 の all と同じ（instantCurrent なら r・t・total など）。value も必ず入れる（E8 は {r, t}）。
//      display は画面の計測値の表と同じ形（view-model の rowDisplay。EA・EB は確定の時刻を meterAt に分ける）
//    - at は取れた時刻（ミリ秒の数）、ts は同じ時刻の ISO 8601。ageSec は何秒前か（0.1 秒単位）
//    - label は画面の計測値の表と同じ短い名前（無い EPC は null）。name は規格の名前のまま
//    - meterAt は定時積算（EA・EB）の確定の時刻（ミリ秒の数。ほかの値は null）。display はそれを除いた形
//    - fresh は、maxAgeSec があればそれより新しいか。無ければ画面の鮮度と同じ規則（view-model の isFreshAt）。
//      この回に取り直した値（refreshed に入っていて、取り直しを始めた時刻 refreshedSince より後に取れたもの）はいつも true
//      （maxAgeSec: 0 =「いつも取り直す」で、取り直したばかりの値を古いと言わないため。取り直す単位が 2 つ以上でも）
//    - missing はまだ一度も取れていない値（頼んだもの。全部のときは定期取得の値）。refreshed は今回取りに行った EPC
//
//  ここは Node-RED に依存しない。

const { ApiError } = require('./errors')
const { MAP, isoLocal } = require('../normalize')
const EL = require('../echonet')
const vm = require('./view-model')
const outputs = require('./outputs')
const catalog = require('./epc-catalog')

const BULKY = [0xe2, 0xe4, 0xec]
const MAX_ITEMS = 64
const GROUP = 6
/** 正規化の名前（instantPower など）→ EPC。 */
const KEY_TO_EPC = {}
for (const [epc, m] of Object.entries(MAP)) KEY_TO_EPC[m.key] = Number(epc)

function pad2(n) {
  return ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
}

function invalid(field, why) {
  return new ApiError(422, 'VALIDATION', '入力を確かめてください', { [field]: why })
}

/** EPC の 1 つ（'E7'・'0xE7'・0xE7）か、正規化の名前（'instantPower'）。読めなければ null。 */
function epcOf(x, allowKey) {
  if (typeof x === 'number') return Number.isInteger(x) && x >= 0 && x <= 0xff ? x : null
  if (typeof x !== 'string') return null
  const s = x.trim()
  if (allowKey && Object.prototype.hasOwnProperty.call(KEY_TO_EPC, s)) return KEY_TO_EPC[s]
  const h = s.replace(/^0x/i, '')
  if (!/^[0-9A-Fa-f]{1,2}$/.test(h)) return null
  return parseInt(h, 16)
}

function pushUnique(out, n) {
  if (out.indexOf(n) < 0) out.push(n)
}

/** EPC の並び（配列か 'E7, E8'）。名前も受ける。外れたら VALIDATION。 */
function epcList(v, field) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : null
  if (!list) throw invalid(field, 'EPC を配列（例: ["E7", "E8"]）で指定してください')
  if (list.length > MAX_ITEMS) throw invalid(field, `${MAX_ITEMS} 個までにしてください`)
  const out = []
  for (const x of list) {
    const n = epcOf(x, true)
    if (n === null) throw invalid(field, `EPC を 16 進（例: "E7"）か名前（例: "instantPower"）で指定してください: ${String(x).slice(0, 24)}`)
    pushUnique(out, n)
  }
  return out
}

function keyList(v) {
  if (!Array.isArray(v)) throw invalid('keys', '名前を配列（例: ["instantPower"]）で指定してください')
  if (v.length > MAX_ITEMS) throw invalid('keys', `${MAX_ITEMS} 個までにしてください`)
  const out = []
  for (const k of v) {
    if (typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(KEY_TO_EPC, k)) {
      throw invalid('keys', `使えない名前です: ${String(k).slice(0, 40)}（出力 1 の values の名前を指定してください。例: instantPower・instantCurrent・cumulativeForward）`)
    }
    pushUnique(out, KEY_TO_EPC[k])
  }
  return out
}

/** maxAgeSec（0 以上の数か、数字の文字列）。無ければ null。外れたら VALIDATION。 */
function maxAgeOf(v) {
  if (v === undefined || v === null || v === '') return null
  let n = null
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = parseFloat(v)
  if (n === null || !Number.isFinite(n) || n < 0 || n > 31536000) {
    throw invalid('maxAgeSec', '0 以上の秒数（例: 60）で指定してください')
  }
  return n
}

/**
 * フローの入力 read の payload を読む。
 *   payload なし・''・{}・inject の時刻（0〜255 の外の数）→ 全部
 *   'E7' / 'E7, E8' / ['E7', 'E8'] / 0xE7 / {epcs: [...]} / {keys: ['instantPower', …]} → その値だけ
 *   maxAgeSec は payload.maxAgeSec か、無ければ msg.maxAgeSec（2 つ目の引数）
 * @returns {{epcs: number[]|null, maxAgeSec: number|null}} epcs が null なら全部
 */
function parseReadRequest(payload, msgMaxAgeSec) {
  const p = payload
  let epcs = null
  let maxAge = maxAgeOf(msgMaxAgeSec)
  if (p === undefined || p === null || p === '') {
    // 全部
  } else if (typeof p === 'number') {
    // get と同じく 0xE7 は EPC。inject の既定の payload（時刻）は「payload なし」と同じ
    if (Number.isInteger(p) && p >= 0 && p <= 0xff) epcs = [p]
  } else if (typeof p === 'string' || Array.isArray(p)) {
    epcs = epcList(p, 'epcs')
  } else if (typeof p === 'object') {
    const out = []
    let any = false
    if (p.epcs !== undefined && p.epcs !== null) {
      if (!Array.isArray(p.epcs)) throw invalid('epcs', 'EPC を配列（例: ["E7", "E8"]）で指定してください')
      for (const n of epcList(p.epcs, 'epcs')) pushUnique(out, n)
      any = true
    }
    if (p.keys !== undefined && p.keys !== null) {
      for (const n of keyList(p.keys)) pushUnique(out, n)
      any = true
    }
    if (out.length > MAX_ITEMS) throw invalid('epcs', `${MAX_ITEMS} 個までにしてください`)
    epcs = any ? out : null
    if (p.maxAgeSec !== undefined && p.maxAgeSec !== null && p.maxAgeSec !== '') maxAge = maxAgeOf(p.maxAgeSec)
  } else {
    throw invalid('_', "payload は無しか、'E7'・['E7', 'E8']・{epcs, keys, maxAgeSec} で指定してください")
  }
  if (epcs && !epcs.length) epcs = null
  return { epcs, maxAgeSec: maxAge }
}

/** 画面の API のクエリ（epcs=E7,E8&keys=instantPower&maxAgeSec=60）。 */
function parseReadQuery(q) {
  const src = q && typeof q === 'object' ? q : {}
  const out = []
  let any = false
  if (src.epcs !== undefined && src.epcs !== '') {
    for (const n of epcList(String(src.epcs), 'epcs')) pushUnique(out, n)
    any = true
  }
  if (src.keys !== undefined && src.keys !== '') {
    for (const n of keyList(String(src.keys).split(/[\s,]+/).filter(Boolean))) pushUnique(out, n)
    any = true
  }
  if (out.length > MAX_ITEMS) throw invalid('epcs', `${MAX_ITEMS} 個までにしてください`)
  return { epcs: any && out.length ? out : null, maxAgeSec: maxAgeOf(src.maxAgeSec) }
}

/** known（'0xE7' → 値）から EPC の値を引く。 */
function valueOf(known, epc) {
  const k = known || {}
  return k['0x' + pad2(epc)] || null
}

/** このメーターが持っていない（0x9F に無い）か。マップがまだ無ければ false。 */
function unsupported(inspect, epc) {
  const list = inspect && inspect.snap && Array.isArray(inspect.snap.supportedEpcs) ? inspect.snap.supportedEpcs : []
  if (!list.length) return false
  return list.indexOf('0x' + pad2(epc)) < 0
}

/** 頼んだ EPC。全部（null）なら定期取得の値（持っていないと分かっているものは除く）。 */
function targetsOf(p) {
  if (p.req && Array.isArray(p.req.epcs)) return p.req.epcs.slice()
  return vm.periodicEpcs(p.inspect).filter((n) => !unsupported(p.inspect, n))
}

/**
 * 取り直しの要る EPC（maxAgeSec より古い・無いもの）。maxAgeSec が無ければ空（無線を使わない）。
 * 履歴（E2・E4・EC）は取りに行かない（1 回の read で 1 件ずつ無線で取りに行くと、Get が何本も出る）。
 * 持っていれば今の値で答え、無ければ buildRead が missing に入れる。履歴を取るのは get（1 件ずつ）。
 * @param {object} p {known, req: {epcs, maxAgeSec}, inspect, now}
 */
function staleEpcs(p) {
  const maxAge = p.req ? p.req.maxAgeSec : null
  if (maxAge === null || maxAge === undefined) return []
  const limit = maxAge * 1000
  const out = []
  for (const n of targetsOf(p)) {
    if (BULKY.indexOf(n) >= 0) continue
    // 0x9F に無い EPC は聞いても断られるだけで、電波を使い、控えの表とログを増やす。buildRead が missing に入れる
    if (unsupported(p.inspect, n)) continue
    const v = valueOf(p.known, n)
    const at = v && typeof v.at === 'number' ? v.at : null
    if (at === null || p.now - at > limit || maxAge === 0) out.push(n)
  }
  return out
}

/** 取りに行く単位（履歴は 1 つずつ、ほかは 6 個ずつ。sequencer は履歴をほかと一緒に送らないため）。 */
function refreshGroups(epcs) {
  const normal = []
  const groups = []
  for (const n of epcs || []) {
    if (BULKY.indexOf(n) >= 0) continue
    normal.push(n)
  }
  for (let i = 0; i < normal.length; i += GROUP) groups.push(normal.slice(i, i + GROUP))
  for (const n of epcs || []) if (BULKY.indexOf(n) >= 0) groups.push([n])
  return groups
}

function round1(x) {
  return Math.round(x * 10) / 10
}

/** 1 つの値の返事（出力 1 の all と同じ中身に、at・ts・ageSec・fresh）。 */
function bodyOf(p, epc, v) {
  const m = MAP[epc]
  const body = m ? m.pick(v) : { value: vm.sanitizeValue(v.value) }
  if (!Object.prototype.hasOwnProperty.call(body, 'value') || body.value === undefined) body.value = vm.sanitizeValue(v.value)
  if (body.unit === undefined) body.unit = v.unit ? String(v.unit) : null
  body.epc = pad2(epc)
  body.name = v.name || (EL.EPC[epc] ? EL.EPC[epc].name : '不明な EPC 0x' + pad2(epc))
  body.label = catalog.labelOf(epc)
  // 下の body.at は受信の時刻で上書きするので、定時積算の確定の時刻は別の項目に残す
  const row = vm.rowDisplay(epc, v)
  body.display = row.display
  body.meterAt = row.meterAt
  if (v.note) body.note = v.note
  const at = typeof v.at === 'number' && isFinite(v.at) ? v.at : null
  body.at = at
  body.ts = at === null ? null : isoLocal(at)
  body.ageSec = at === null ? null : round1(Math.max(0, p.now - at) / 1000)
  const maxAge = p.req ? p.req.maxAgeSec : null
  if (at === null) body.fresh = false
  else if (refreshedNow(p, epc, at)) body.fresh = true
  else body.fresh = maxAge !== null && maxAge !== undefined ? p.now - at <= maxAge * 1000 : vm.isFreshAt(p.inspect, epc, at, p.now)
  return body
}

/** この回に取り直した値か（refreshed に入っていて、取り直しを始めた時刻より後に取れた）。 */
function refreshedNow(p, epc, at) {
  if (typeof p.refreshedSince !== 'number' || !isFinite(p.refreshedSince)) return false
  if (!Array.isArray(p.refreshed) || p.refreshed.indexOf(epc) < 0) return false
  return at >= p.refreshedSince
}

/**
 * read の返事を作る（無線を使わない）。
 * @param {object} p {device, deviceKey, known, req: {epcs, maxAgeSec}, inspect（handle.inspect()）, now, refreshed?: number[],
 *   refreshedSince?: number（取り直しを始めた時刻 [ms]。値の at と同じ時計 = Date.now）, redact?}
 */
function buildRead(p) {
  const now = typeof p.now === 'number' ? p.now : Date.now()
  const q = Object.assign({}, p, { now })
  const known = p.known || {}
  const values = {}
  const missing = []
  const all = !(p.req && Array.isArray(p.req.epcs))
  let list
  if (all) {
    const set = new Set()
    for (const k of Object.keys(known)) {
      const n = epcOf(k, false)
      if (n !== null) set.add(n)
    }
    list = Array.from(set).sort((a, b) => a - b)
    for (const n of targetsOf(q)) if (!valueOf(known, n)) missing.push(pad2(n))
  } else {
    list = p.req.epcs
  }
  for (const n of list) {
    const v = valueOf(known, n)
    if (!v) {
      if (!all) missing.push(pad2(n))
      continue
    }
    const m = MAP[n]
    values[m ? m.key : pad2(n)] = bodyOf(q, n, v)
  }
  const t = outputs.stamp(now)
  const out = {
    device: p.device === undefined ? null : p.device,
    deviceKey: p.deviceKey === undefined ? null : p.deviceKey,
    ts: t.ts,
    at: t.at,
    maxAgeSec: p.req && typeof p.req.maxAgeSec === 'number' ? p.req.maxAgeSec : null,
    values,
    missing,
    refreshed: (p.refreshed || []).map(pad2),
  }
  // 機器から届いた文字列（製造番号・表示）にも、認証情報の伏せ字を当てる（ほかの出力と同じ）
  const safe = outputs.plain(out)
  if (typeof p.redact === 'function') {
    for (const b of Object.values(safe.values)) {
      if (typeof b.display === 'string') b.display = p.redact(b.display)
      if (typeof b.value === 'string') b.value = p.redact(b.value)
    }
  }
  return safe
}

module.exports = { parseReadRequest, parseReadQuery, staleEpcs, refreshGroups, buildRead, KEY_TO_EPC }
