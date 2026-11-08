// 出どころのチップ（純関数。test/ui/config.test.mjs）。
// 基本設定には出どころの列を出さない。値が設定ノードと違う項目（画面かフローで保存した・一時的な上書き）にだけ、
// ラベルの横に小さなチップを付ける。title に変えた時刻と設定ノードの値。出どころの全部は詳細設定の「出どころ」の表。
import { S } from './strings.js'
import { formatDateTime } from './format.js'
import { hasConfigRecord } from './config-model.js'

const isSet = (v) => v !== null && v !== undefined
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)

/**
 * その項目に運用設定（settings.json）があるか。view-model は一時的な上書きを運用設定より優先するので、
 * 上書きの下に運用設定がある項目の source は 'override'。そのときも by / at は運用設定のものが入る。
 * runtimeValue（運用設定そのものの値。無ければ null）があれば、それだけが正（by / at は、エディタの照合で
 * 運用設定を外した項目にも 'editor' と外した時刻で付くので、運用設定がある印にならない）。
 */
export function hasRuntimeRecord(field) {
  if (!field) return false
  if (field.source === 'runtime') return true
  if (own(field, 'runtimeValue')) return isSet(field.runtimeValue)
  return isSet(field.by) || isSet(field.at)
}

/** 変えた経路の言葉（「画面で変更」「フロー（名前）で変更」）。 */
function byText(by) {
  if (by === 'web-ui') return S.chip.webUi
  if (typeof by === 'string' && by.indexOf('flow:') === 0) return S.chip.flow(by.slice(5) || S.unknown)
  if (typeof by === 'string' && by && by !== 'editor') return S.chip.other(by)
  return S.chip.saved
}

/**
 * 出どころのチップ。付けない項目は null。
 * @param {object} field SettingField / ConfigField
 * @param {{config?: boolean, valueText?: (v: any) => string}} [opts] config: 構成の項目（一時的な上書きが無い）。
 *   valueText は title の「設定ノードの値」の書き方。
 * @returns {{kind: 'override'|'saved', text: string, tone: string, title: string}|null}
 */
export function sourceChip(field, opts = {}) {
  if (!field) return null
  const vt = opts.valueText || ((v) => (isSet(v) ? String(v) : S.settings.unset))
  const cfg = vt(field.configValue)
  const at = typeof field.at === 'number' ? formatDateTime(field.at) : null
  if (!opts.config && field.source === 'override') {
    return { kind: 'override', text: S.chip.override, tone: 'info', title: S.chip.title(null, cfg) }
  }
  const rec = opts.config ? hasConfigRecord(field) : hasRuntimeRecord(field)
  if (!rec) return null
  return { kind: 'saved', text: byText(field.by), tone: 'accent', title: S.chip.title(at, cfg) }
}
