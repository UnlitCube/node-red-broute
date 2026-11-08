// 設定タブの下書き・検証・差分（純関数。test/ui/store.test.mjs・test/ui/config.test.mjs）。
// 範囲は Settings.fields の min / max を正とし、無いときだけ契約の値（下の FALLBACK）を使う。
// EPC は SettingField.pollEpcs.options（[{epc, name, label, desc, group, unit, supported}]）があれば名前で出す（短い名前の label を先に見る）。
// 無い（古いサーバー）ときは今までどおり 16 進の記号。
import { S } from './strings.js'
import { normEpc, FORBIDDEN_POLL_EPCS, formatInterval, formatEpc, epcName } from './format.js'

export const FIELDS = ['pollIntervalSec', 'pollEpcs', 'slowIntervalSec', 'halfHourIntervalSec']

const FALLBACK = {
  pollIntervalSec: { min: 15, max: 3600 },
  slowIntervalSec: { min: 60, max: 3600 },
  halfHourIntervalSec: { min: 300, max: 7200 },
  pollEpcs: { min: 1, max: 6 },
}

export function rangeOf(settings, name) {
  const f = settings && settings.fields && settings.fields[name]
  const fb = FALLBACK[name]
  return {
    min: f && typeof f.min === 'number' ? f.min : fb.min,
    max: f && typeof f.max === 'number' ? f.max : fb.max,
  }
}

function epcList(v) {
  return (Array.isArray(v) ? v : []).map(normEpc).filter(Boolean)
}

/** サーバーの Settings から下書きを作る。数値は入力欄のための文字列にする。 */
export function draftFrom(settings) {
  const f = (settings && settings.fields) || {}
  const num = (n) => (f[n] && f[n].value !== null && f[n].value !== undefined ? String(f[n].value) : '')
  return {
    pollIntervalSec: num('pollIntervalSec'),
    pollEpcs: epcList(f.pollEpcs && f.pollEpcs.value),
    slowIntervalSec: num('slowIntervalSec'),
    halfHourIntervalSec: num('halfHourIntervalSec'),
  }
}

/** 1 項目の検証。通れば null、通らなければ理由の文。 */
function fieldError(name, value, settings) {
  if (name === 'pollEpcs') {
    const epcs = Array.isArray(value) ? value : []
    const { min, max } = rangeOf(settings, 'pollEpcs')
    const ng = epcs.filter((e) => FORBIDDEN_POLL_EPCS.includes(e))
    if (ng.length) return S.settings.epcForbidden(ng.join(S.listSep))
    if (epcs.length < min) return S.settings.epcTooFew
    if (epcs.length > max) return S.settings.epcTooMany
    return null
  }
  const raw = String(value === undefined || value === null ? '' : value).trim()
  const { min, max } = rangeOf(settings, name)
  if (!/^\d+$/.test(raw)) return S.settings.errInteger
  const n = Number(raw)
  if (n < min || n > max) return S.settings.errRange(min, max)
  return null
}

function numText(v) {
  return String(v === undefined || v === null ? '' : v).trim()
}

/** 下書きのうち、サーバーの今の値から変わった項目の名前（FIELDS の順）。 */
export function changedFields(draft, settings) {
  const base = draftFrom(settings)
  return FIELDS.filter((name) => (name === 'pollEpcs' ? !sameList(draft.pollEpcs || [], base.pollEpcs) : numText(draft[name]) !== base[name]))
}

/**
 * 下書きを検証する。検証するのは差分に入る項目（PUT で送るもの）だけ。
 * 触っていない項目が範囲の外でも保存は止めない（それは untouchedNotes の注意）。
 * @returns {{[field]: string}}（空なら通る）
 */
export function validateDraft(draft, settings) {
  const errors = {}
  for (const name of changedFields(draft, settings)) {
    const e = fieldError(name, draft[name], settings)
    if (e) errors[name] = e
  }
  return errors
}

/**
 * 触っていない項目のうち、今の値が画面の検証を通らないもの（例: 設定ノードの取得間隔が 7200 秒）。
 * 送らないので保存は止めず、項目の横に注意を出すだけ。値が空（サーバーに値が無い）なら何も言わない。
 * @returns {{[field]: string}}
 */
export function untouchedNotes(draft, settings) {
  const changed = changedFields(draft, settings)
  const notes = {}
  for (const name of FIELDS) {
    if (changed.includes(name)) continue
    const v = draft[name]
    if (name !== 'pollEpcs' && numText(v) === '') continue
    if (!fieldError(name, v, settings)) continue
    if (name === 'pollEpcs') notes[name] = S.settings.epcKept
    else {
      const { min, max } = rangeOf(settings, name)
      notes[name] = S.settings.outOfRangeKept(min, max)
    }
  }
  return notes
}

/**
 * 画面に出す下書き: サーバーの今の値に、手で変えた項目（edits）だけを重ねる。
 * 触っていない項目は、運用設定の保存・一時的な上書き（rev が変わらない）のどちらの変化にも付いていく。
 */
export function mergeDraft(settings, edits) {
  const d = draftFrom(settings)
  for (const name of FIELDS) {
    if (!edits || !Object.prototype.hasOwnProperty.call(edits, name)) continue
    d[name] = name === 'pollEpcs' ? (Array.isArray(edits[name]) ? edits[name].slice() : []) : edits[name]
  }
  return d
}

/** 手で変えた項目のうち、サーバーの今の値と同じになったものを外す（触っていない扱いに戻す）。新しいオブジェクトを返す。 */
export function pruneEdits(edits, settings) {
  const changed = changedFields(mergeDraft(settings, edits), settings)
  const out = {}
  for (const name of changed) if (edits && Object.prototype.hasOwnProperty.call(edits, name)) out[name] = edits[name]
  return out
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * 下書きとサーバーの値の差分。PUT の本文と、確認ダイアログの行を返す。
 * @returns {{patch: object, changes: {field: string, label: string, from: string, to: string}[]}}
 */
export function diffDraft(draft, settings) {
  const base = draftFrom(settings)
  const options = epcOptionsOf(settings)
  const epcText = (list) => (options ? list.map((e) => epcLabel(e, options)).join(S.listSep) : list.map(formatEpc).join(' ')) || S.none
  const patch = {}
  const changes = []
  for (const name of ['pollIntervalSec', 'slowIntervalSec', 'halfHourIntervalSec']) {
    const to = numText(draft[name])
    if (to !== base[name]) {
      patch[name] = Number(to)
      changes.push({
        field: name,
        label: S.settings.fields[name],
        from: base[name] === '' ? S.none : formatInterval(Number(base[name])),
        to: formatInterval(Number(to)),
      })
    }
  }
  const epcs = draft.pollEpcs || []
  if (!sameList(epcs, base.pollEpcs)) {
    patch.pollEpcs = epcs.slice()
    changes.push({
      field: 'pollEpcs',
      label: S.settings.fields.pollEpcs,
      from: epcText(base.pollEpcs),
      to: epcText(epcs),
    })
  }
  return { patch, changes }
}

// ---- EPC を名前で選ぶ ----------------------------------------------------------------

/** まとまりの並び（よく使う / 定時の積算 / メーターの情報）。知らないまとまりはこの後ろ、サーバーの順。 */
export const EPC_GROUP_ORDER = ['common', 'scheduled', 'info']

const str = (v) => (typeof v === 'string' ? v : '')

/** Settings の pollEpcs.options（空・形の違うものは null）。 */
export function epcOptionsOf(settings) {
  const f = settings && settings.fields && settings.fields.pollEpcs
  const o = f && f.options
  return Array.isArray(o) && o.length ? o : null
}

/**
 * options をまとまりごとに並べる。履歴（E2・E4・EC）と読めない EPC・重なりは捨てる。
 * 選んでいるのに options に無い値は、最後の 'selected' に入れる（外せるように）。
 * supported は true / false / null（マップが無い）のどれか。options が無ければ空の並び（呼び手が記号のチップに戻す）。
 * @returns {{group: string, items: {epc, name, desc, unit, supported}[]}[]}
 */
export function epcOptionGroups(options, selected) {
  if (!Array.isArray(options) || !options.length) return []
  const seen = new Set()
  const byGroup = new Map()
  for (const o of options) {
    const epc = normEpc(o && o.epc)
    if (!epc || FORBIDDEN_POLL_EPCS.includes(epc) || seen.has(epc)) continue
    seen.add(epc)
    const g = str(o.group) || 'other'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push({
      epc,
      name: str(o.label) || str(o.name) || epcName(epc) || epc,
      desc: str(o.desc),
      unit: str(o.unit),
      supported: o.supported === true ? true : o.supported === false ? false : null,
    })
  }
  const groups = []
  for (const g of EPC_GROUP_ORDER) if (byGroup.has(g)) groups.push({ group: g, items: byGroup.get(g) })
  for (const [g, items] of byGroup) if (!EPC_GROUP_ORDER.includes(g)) groups.push({ group: g, items })
  const extra = []
  for (const e of selected || []) {
    const n = normEpc(e)
    if (n && !seen.has(n) && !extra.some((x) => x.epc === n)) extra.push({ epc: n, name: epcName(n) || n, desc: '', unit: '', supported: null })
  }
  if (extra.length) groups.push({ group: 'selected', items: extra })
  return groups
}

/** EPC の表示。options に名前があれば「瞬時電力（E7）」、無ければ記号（E7）。 */
export function epcLabel(epc, options) {
  const code = formatEpc(epc)
  const want = normEpc(epc)
  const o = Array.isArray(options) ? options.find((x) => x && normEpc(x.epc) === want) : null
  const name = o && (str(o.label) || str(o.name))
  return name ? S.settings.epcLabel(name, code) : code
}

export const DEFAULT_EPC_CANDIDATES = ['E7', 'E8', 'E0', 'E3', 'EA', 'EB', '80', '88', 'D3', 'D7', 'E1', 'E5', '8A', '8D', '97', '98']

/** EPC のチップの候補。0x9F（supportedEpcs）があればそれで絞り、選択中のものは必ず残す。 */
export function epcCandidates(supportedEpcs, selected) {
  const supported = epcList(supportedEpcs).filter((e) => !FORBIDDEN_POLL_EPCS.includes(e) && !['9D', '9E', '9F'].includes(e))
  const base = supported.length ? supported : DEFAULT_EPC_CANDIDATES
  const out = base.slice()
  for (const e of selected || []) if (!out.includes(e)) out.push(e)
  return { list: out, fromMeter: supported.length > 0 }
}

// ---- 基本設定と詳細設定 --------------------------------------------------------------

/** 「定期的に取りに行く値」のうち、基本設定に出すよく使う 4 つ。ほかは詳細設定の「ほかの値」。 */
export const COMMON_EPCS = ['E7', 'E8', 'E0', 'E3']

/**
 * options を基本設定（よく使う 4 つ。この順）とほか（詳細設定の「ほかの値」）に分ける。
 * 履歴（E2・E4・EC）はどちらにも入れない（epcOptionGroups と同じ）。
 * @returns {{common: object[], others: object[]}} common は epcOptionGroups の items と同じ形
 */
export function splitEpcOptions(options) {
  if (!Array.isArray(options) || !options.length) return { common: [], others: [] }
  const all = []
  for (const g of epcOptionGroups(options, [])) for (const it of g.items) all.push(it)
  const common = COMMON_EPCS.map((e) => all.find((it) => it.epc === e)).filter(Boolean)
  const others = options.filter((o) => {
    const e = normEpc(o && o.epc)
    return e && !COMMON_EPCS.includes(e)
  })
  return { common, others }
}
