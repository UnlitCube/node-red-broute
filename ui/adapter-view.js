// 一覧の行と詳細の見出しに出す理由とバッジ（純関数。test/ui/adapter-view.test.mjs）。
// 停止の理由は 1 か所だけ（2 回出さない）。一覧の行には停止中や異常の短い理由。
// 契約のバッジの種類（roleKind）と、名前の無い台の名前の欄（nameSlot）・文の中の名前（displayText）。
import { S } from './strings.js'
import { healthLabel, normEpc } from './format.js'

/**
 * つながっているのに、定期的に取りに行く値に瞬時電流（E8）が無い台か。待っても電流の値は届かない。
 * pollEpcs が無い形（一覧の行）は分からないので false。
 */
export function currentNotPolled(a) {
  return !!a && a.connected === true && Array.isArray(a.pollEpcs) && !a.pollEpcs.some((e) => normEpc(e) === 'E8')
}

// ---- 契約のバッジ ----------------------------------------------------------------

/**
 * 契約の種類。前後の空白を外して「電力」「動力」と完全に一致したときだけ色を付ける（select の値と色を 1 対 1 にする）。
 * 「低圧電力」のように「電力」を含むだけの名前は other（中立の色）。空は null（バッジを出さない）。
 * @returns {'light'|'motive'|'other'|null}
 */
export function roleKind(role) {
  const r = typeof role === 'string' ? role.trim() : ''
  if (!r) return null
  if (r === S.roles.light) return 'light'
  if (r === S.roles.motive) return 'motive'
  return 'other'
}

/** バッジの文字は 8 文字まで（超えたら「…」で切り、title に全文）。 */
export const ROLE_BADGE_MAX = 8

/** バッジの文字（切ったか・全文）。空なら null。 */
export function roleBadgeText(role) {
  const r = typeof role === 'string' ? role.trim() : ''
  if (!r) return null
  const chars = Array.from(r)
  if (chars.length <= ROLE_BADGE_MAX) return { text: r, full: r, cut: false }
  return { text: chars.slice(0, ROLE_BADGE_MAX).join('') + '…', full: r, cut: true }
}

// ---- 名前の無い台の表示 ----------------------------------------------------------

const trim = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 名前を入れた台か。サーバーの named（設定ノードか、画面・フローで名前を入れたか）が正。
 * named の無い古いサーバーでは、name が空・契約・ポート・ポートの短い名前・id と同じなら「名前なし」とみなす
 * （古いサーバーは name に name || role || port の代わりの値を入れる）。
 */
export function isNamed(a) {
  if (!a) return false
  const name = trim(a.name)
  if (!name) return false
  if (typeof a.named === 'boolean') return a.named
  return ![trim(a.role), trim(a.port), trim(a.portLabel), trim(a.id)].includes(name)
}

/** ポートの短い名前（サーバーの portLabel。無ければポート・id）。 */
function portShortOf(a) {
  return trim(a && a.portLabel) || trim(a && a.port) || trim(a && a.id)
}

/**
 * 名前の欄（一覧の行と見出しの h1）に出すもの: `named && name.trim() !== role.trim() ? name : portLabel`。
 * 名前が契約と同じなら、契約はバッジに出るので、ポートの短い名前を出す（「[電力] 電力」にしない）。
 * @returns {{text: string, isName: boolean}}
 */
export function nameSlot(a) {
  const name = trim(a && a.name)
  if (isNamed(a) && name !== trim(a.role)) return { text: name, isName: true }
  return { text: portShortOf(a), isName: false }
}

/**
 * 文の中の名前（トースト・確認・ダイアログの見出し・ブラウザーのタブの題）。
 * 名前の欄が name ならその名前、そうでなければ「電力（USB0）」（契約が無ければ「USB0」）。
 */
export function displayText(a) {
  const slot = nameSlot(a)
  if (slot.isName) return slot.text
  const role = trim(a && a.role)
  return role ? S.detail.displayName(role, slot.text) : slot.text
}

function stopOf(a) {
  const st = a && a.overridden && a.overridden.stopped
  return st && st.reason ? st : null
}

/**
 * 詳細の見出し: ピルと違う文の title・理由の行・次に（依頼のことも予告のこともある）。
 * 外部の停止の理由は、health.reasons にあれば「止めた理由: …」にして 1 回、無ければ（無効が先に効くなど）末尾に 1 回足す。
 * @returns {{level: string|null, title: string|null, reasons: string[], next: string|null}}
 */
export function headline(a) {
  const h = (a && a.health) || {}
  const level = h.level || null
  const label = healthLabel(level)
  const title = h.title && h.title !== label ? h.title : null
  const raw = Array.isArray(h.reasons) ? h.reasons : []
  const st = stopOf(a)
  const reasons = raw.filter((r) => r !== title).map((r) => (st && r === st.reason ? S.detail.stopReason(r) : r))
  if (st && raw.indexOf(st.reason) < 0) reasons.push(S.detail.stopReason(st.reason))
  return { level, title, reasons, next: h.nextAction || null }
}

/** 一覧の行の短い理由（計測中なら null）。停止中なら「停止中（理由）」。 */
export function shortReason(a) {
  const h = (a && a.health) || null
  const level = h && h.level
  if (level === 'ok') return null
  const st = stopOf(a)
  if (st) return S.flags.stopped(st.reason)
  if (!h) return S.unknown
  const label = healthLabel(level)
  if (h.title && h.title !== label) return h.title
  if (Array.isArray(h.reasons) && h.reasons.length) return h.reasons[0]
  return label
}

/**
 * 詳細の見出しの小さなバッジ。停止は理由の行が受け持つので出さない（上書き中も、停止の上書きなら出さない）。
 * @returns {{tone: string, icon: string, text: string, title?: string}[]}
 */
export function adapterFlags(a) {
  const out = []
  const ov = (a && a.overridden) || {}
  if (!ov.stopped && ov.any) out.push({ tone: 'info', icon: 'hand', text: S.flags.overridden, title: S.flags.overriddenTitle })
  if (a && a.radioBlocked) out.push({ tone: 'warn', icon: 'radioOff', text: S.flags.radioBlocked, title: S.flags.radioBlockedTitle })
  if (a && a.keyBlocked) out.push({ tone: 'warn', icon: 'key', text: S.flags.keyBlocked })
  if (a && a.device && a.device.macMatches === false) out.push({ tone: 'danger', icon: 'chip', text: S.flags.wrongDevice, title: S.flags.wrongDeviceTitle })
  return out
}
