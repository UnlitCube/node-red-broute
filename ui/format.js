// 表示の整形（純関数。DOM に触らない。test/ui/format.test.mjs）。
// 値が無い・算出できないときは 0 ではなく S.none（-）を返す。
import { S, EPC_NAMES } from './strings.js'

const MINUS = '−' // 負号は U+2212（ハイフンより幅と高さが数字に揃う）

const nfCache = new Map()
function nf(min, max) {
  const key = min + ':' + max
  let f = nfCache.get(key)
  if (!f) {
    f = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: min, maximumFractionDigits: max })
    nfCache.set(key, f)
  }
  return f
}

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 文の先頭（最初の行の max 文字まで。切ったら … を付ける）。 */
export function textHead(v, max = 40) {
  const line = String(v === null || v === undefined ? '' : v).split(/\r?\n/)[0].trim()
  const chars = Array.from(line)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : line
}

/** 3 桁区切り。負の数は U+2212 を付ける。 */
export function formatNumber(v, maxDigits = 0, minDigits = 0) {
  if (!isNum(v)) return S.none
  const body = nf(minDigits, Math.max(minDigits, maxDigits)).format(Math.abs(v))
  // -0.04 を 0 桁で丸めると「−0」になるので、丸めた結果が 0 なら符号を付けない
  const zero = Number(body.replace(/,/g, '')) === 0
  return v < 0 && !zero ? MINUS + body : body
}

/**
 * 瞬時電力（E7）。逆潮流（負）は「売電 −1,234 W」。
 * @returns {{text: string, unit: string, exporting: boolean, label: string|null, full: string}}
 */
export function formatPower(w) {
  if (!isNum(w)) return { text: S.none, unit: '', exporting: false, label: null, full: S.none }
  const exporting = w < 0
  const text = formatNumber(w, 0)
  const label = exporting ? S.power.exportLabel : null
  const full = (label ? label + ' ' : '') + text + ' W'
  return { text, unit: 'W', exporting, label, full }
}

/** 電流 [A]。小数 1 桁。 */
export function formatAmps(a) {
  if (!isNum(a)) return S.none
  return formatNumber(a, 1, 1) + ' A'
}

/** 電力量 [kWh]。桁は有効桁に合わせて最大 digits 桁。 */
export function formatKwh(v, digits = 3) {
  if (!isNum(v)) return S.none
  return formatNumber(v, digits) + ' kWh'
}

/** 秒の長さ（45 秒・3 分 20 秒・2 時間 5 分・1 日 3 時間）。 */
export function formatDuration(sec) {
  if (!isNum(sec) || sec < 0) return S.none
  const s = Math.floor(sec)
  if (s < 60) return S.time.sec(s)
  if (s < 3600) return S.time.minSec(Math.floor(s / 60), s % 60)
  if (s < 86400) return S.time.hourMin(Math.floor(s / 3600), Math.floor((s % 3600) / 60))
  return S.time.dayHour(Math.floor(s / 86400), Math.floor((s % 86400) / 3600))
}

/** 秒の間隔を短く（15 秒・1 分・5 分・1 時間・90 秒）。 */
export function formatInterval(sec) {
  if (!isNum(sec)) return S.none
  if (sec >= 3600 && sec % 3600 === 0) return S.time.hourMin(sec / 3600, 0)
  if (sec >= 60 && sec % 60 === 0) return S.time.minSec(sec / 60, 0)
  return S.time.sec(sec)
}

/** 相対時刻（12 秒前・3 分前・2 時間後）。at と now はミリ秒。 */
export function formatRelative(at, now) {
  if (!isNum(at) || !isNum(now)) return S.none
  const diff = Math.round((now - at) / 1000)
  const past = diff >= 0
  const d = Math.abs(diff)
  if (d < 5) return S.time.justNow
  if (d < 60) return past ? S.time.secAgo(d) : S.time.secLater(d)
  const m = Math.floor(d / 60)
  if (m < 60) return past ? S.time.minAgo(m) : S.time.minLater(m)
  const h = Math.floor(m / 60)
  if (h < 48) return past ? S.time.hourAgo(h) : S.time.hourLater(h)
  const days = Math.floor(h / 24)
  return past ? S.time.dayAgo(days) : S.time.dayLater(days)
}

const pad = (n) => String(n).padStart(2, '0')

/** 端末の時刻で HH:MM:SS。 */
export function formatTime(at) {
  if (!isNum(at)) return S.none
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 端末の時刻で HH:MM（グラフの目盛り）。 */
export function formatClock(at) {
  if (!isNum(at)) return S.none
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 端末の時刻で YYYY/MM/DD HH:MM:SS。 */
export function formatDateTime(at) {
  if (!isNum(at)) return S.none
  const d = new Date(at)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${formatTime(at)}`
}

/** ファイル名に使う日時（20261105-091503）。 */
export function stampForFile(at) {
  const d = new Date(at)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** EPC を 'E7' の形に揃える（'0xE7'・'e7'・231 を受ける）。読めなければ null。 */
export function normEpc(x) {
  if (x === null || x === undefined) return null
  if (typeof x === 'number') {
    if (!Number.isInteger(x) || x < 0 || x > 255) return null
    return x.toString(16).toUpperCase().padStart(2, '0')
  }
  const s = String(x).trim().replace(/^0x/i, '')
  if (!/^[0-9A-Fa-f]{1,2}$/.test(s)) return null
  return s.toUpperCase().padStart(2, '0')
}

/** EPC の表示（E7）。読めなければ受け取った文字列のまま。 */
export function formatEpc(x) {
  return normEpc(x) || (x === null || x === undefined ? S.none : String(x))
}

/** EPC の名前。知らなければ空文字。 */
export function epcName(x) {
  const e = normEpc(x)
  return (e && EPC_NAMES[e]) || ''
}

/** 定期取得・任意の取得で送れない EPC（履歴。応答が大きく、送信の積算を食う）。 */
export const FORBIDDEN_POLL_EPCS = ['E2', 'E4', 'EC']

/**
 * 空白・カンマ区切りの EPC の列を読む（'E7, 0xE8 e0'）。
 * @returns {{epcs: string[], error: string|null}}
 */
export function parseEpcList(text, { min = 1, max = 6, forbidden = FORBIDDEN_POLL_EPCS } = {}) {
  const tokens = String(text || '')
    .split(/[\s,、]+/)
    .filter(Boolean)
  const epcs = []
  const bad = []
  for (const t of tokens) {
    const e = normEpc(t)
    if (!e) bad.push(t)
    else if (!epcs.includes(e)) epcs.push(e)
  }
  if (bad.length) return { epcs, error: S.settings.epcUnreadable(bad.join(' ')) }
  const ng = epcs.filter((e) => forbidden.includes(e))
  if (ng.length) return { epcs, error: S.settings.epcForbidden(ng.join(S.listSep)) }
  if (epcs.length < min) return { epcs, error: S.settings.epcTooFew }
  if (epcs.length > max) return { epcs, error: S.settings.epcTooMany }
  return { epcs, error: null }
}

/** 健康の段階 → 色調（tokens.css の状態色の名前）。 */
export function healthTone(level) {
  switch (level) {
    case 'ok':
      return 'ok'
    case 'busy':
      return 'warn'
    case 'stale':
      return 'stale'
    case 'bad':
      return 'danger'
    case 'stopped':
      return 'info'
    default:
      return 'neutral' // idle・disabled・不明
  }
}

/** 健康の段階の短い名前（API の title が無いとき）。 */
export function healthLabel(level) {
  return S.health[level] || S.unknown
}

/** 値の表示。null・undefined・空文字は「-」。 */
export function text(v) {
  if (v === null || v === undefined || v === '') return S.none
  return String(v)
}

/** 送信積算 [ms] → 秒（四捨五入）。 */
export function txSeconds(ms) {
  return isNum(ms) ? Math.round(ms / 1000) : null
}

/** 接続の段階 → 段の番号（0〜5）。手順の外（停止・未設定・エラー）は -1。 */
export function phaseStep(phase) {
  switch (phase) {
    case 'opening':
    case 'port-down':
      return 0
    case 'resetting':
    case 'configuring':
      return 1
    case 'scanning':
      return 2
    case 'joining':
    case 'rejoining':
    case 'reauth':
      return 3
    case 'verifying':
      return 4
    case 'connected':
      return 5
    default:
      return -1
  }
}

/**
 * 運用設定を変えた人（人の名前ではなく経路）。
 * 'web-ui' →「画面」、'flow:<名前>' →「フロー（<名前>）」、'editor' →「エディタ」。無ければ null。
 * 知らない値（前の版の settings.json に残ったユーザー名など）はそのまま出す。
 */
export function formatBy(by) {
  if (by === null || by === undefined || by === '') return null
  const s = String(by)
  if (s === 'web-ui') return S.settings.byWebUi
  if (s.indexOf('flow:') === 0) return S.settings.byFlow(s.slice(5) || S.unknown)
  if (s === 'editor') return S.settings.byEditor
  return s
}

/** 積算電力量の計測値の行（E0・E3）を「61,532 kWh」に。数値でなければ display、行が無ければ「-」。 */
export function formatEnergy(row) {
  if (!row) return S.none
  if (isNum(row.value)) return formatNumber(row.value, 3) + ' kWh'
  return text(row.display)
}
