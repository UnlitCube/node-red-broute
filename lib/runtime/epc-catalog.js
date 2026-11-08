'use strict'

// ============================================================================
//  EPC を名前で選ぶための表
// ============================================================================
//
//  画面の「定期的に取りに行く値」とエディタの「プロパティ」欄で、16 進の記号ではなく名前と短い説明で選べるようにする。
//  名前・説明・まとまりの正は lib/echonet.js の EPC の表（name・desc・group）。ここはそれを並べて渡すだけ。
//
//  - 履歴（group 'history': E2・E4・EC・EE）は候補に出さない（1 件が大きく、定期取得にできない・向かない）。
//  - 並びはまとまり（GROUPS の順）→ まとまりの中の順（よく使うは E7・E8・E0・E3、ほかは EPC の順）。
//  - supported は Get プロパティマップ（0x9F）に載っているか。マップがまだ無ければ null。
//
//  ここは Node-RED に依存しない。

const EL = require('../echonet')

/** まとまり（画面とエディタの見出し）。 */
const GROUPS = [
  { id: 'common', label: 'よく使う' },
  { id: 'scheduled', label: '定時の積算' },
  { id: 'info', label: 'メーターの情報' },
  { id: 'other', label: 'そのほか（メーターはふつう持っていません）' },
]
const GROUP_IDS = GROUPS.map((g) => g.id)
/** よく使うの並び（瞬時電力・瞬時電流・積算電力量（買電）・積算電力量（売電））。 */
const COMMON_ORDER = [0xe7, 0xe8, 0xe0, 0xe3]

function epcHex(n) {
  return '0x' + EL.hex2(n)
}

function rank(n) {
  const m = EL.EPC[n]
  const g = GROUP_IDS.indexOf(m.group)
  const i = m.group === 'common' && COMMON_ORDER.indexOf(n) >= 0 ? COMMON_ORDER.indexOf(n) : n
  return g * 1000 + i
}

/** 候補にする EPC（履歴とまとまりの無いものを除く）の数値の並び。 */
function pollableEpcs() {
  return Object.keys(EL.EPC)
    .map(Number)
    .filter((n) => GROUP_IDS.indexOf(EL.EPC[n].group) >= 0)
    .sort((a, b) => rank(a) - rank(b))
}

function itemOf(n) {
  const m = EL.EPC[n]
  return { epc: epcHex(n), name: m.name, label: labelOf(n), desc: m.desc || '', group: m.group, unit: m.unit ? String(m.unit) : null }
}

/**
 * エディタに渡す表（registerType の settings: RED.settings.wsuhaDeviceEpcCatalog）。
 * name は規格の名前のまま。選ぶ人に見せるのは label || name（ValueRow と同じ形）。
 * @returns {{groups: Array<{id, label}>, items: Array<{epc, name, label, desc, group, unit}>}}
 */
function catalog() {
  return { groups: GROUPS.map((g) => Object.assign({}, g)), items: pollableEpcs().map(itemOf) }
}

/**
 * SettingField.pollEpcs.options（画面とフローの get-settings が同じものを受け取る）。
 * @param {object|null} snap sequencer の snapshot()（supportedEpcs を読む）
 * @returns {Array<{epc, name, label, desc, group, unit, supported}>}
 */
function pollEpcOptions(snap) {
  const list = snap && Array.isArray(snap.supportedEpcs) ? snap.supportedEpcs.map(String) : []
  return pollableEpcs().map((n) => {
    const it = itemOf(n)
    it.supported = list.length ? list.indexOf(it.epc) >= 0 : null
    return it
  })
}

/**
 * 5 分 / 30 分の取得で取る値の名前（SettingField.slowIntervalSec / halfHourIntervalSec の takes）。
 * @param {number[]} epcs sequencer の options.slowEpcs / halfHourEpcs
 * @returns {Array<{epc, name, desc}>}
 */
function takesOf(epcs) {
  return (Array.isArray(epcs) ? epcs : [])
    .filter((n) => typeof n === 'number')
    .map((n) => {
      const m = EL.EPC[n]
      return { epc: epcHex(n), name: m ? m.name : '不明な EPC ' + epcHex(n), desc: m && m.desc ? m.desc : '' }
    })
}

/**
 * 計測値の表と定期取得の選択肢に出す短い名前（ValueRow.label・SettingField.pollEpcs.options の label）。
 * name（規格の名前。出力 1 と read に入る）は変えず、画面の表と主な値と選択肢だけがこれを使う。無い EPC は null（画面は name を出す）。
 */
const SHORT_LABELS = {
  0x80: '動作状態',
  0x81: '設置場所',
  0x82: '規格の版',
  0x83: '識別番号',
  0x88: '異常の有無',
  0x8a: 'メーカー',
  0x8c: '商品コード',
  0x8d: '製造番号',
  0x8e: '製造年月日',
  0x97: 'メーターの時刻',
  0x98: 'メーターの日付',
  0x9d: '知らせてくる値の一覧',
  0x9e: '書き込める値の一覧',
  0x9f: '読み出せる値の一覧',
  0xd3: '係数',
  0xd7: '積算の有効桁数',
  0xe0: '積算電力量（買電）',
  0xe1: '積算の単位',
  0xe2: '積算の履歴（買電）',
  0xe3: '積算電力量（売電）',
  0xe4: '積算の履歴（売電）',
  0xe5: '履歴の収集日',
  0xe7: '瞬時電力',
  0xe8: '瞬時電流',
  0xea: '定時積算（買電）',
  0xeb: '定時積算（売電）',
  0xec: '積算の履歴 2',
  0xed: '履歴 2 の収集日時',
}

/** 短い名前（無ければ null）。 */
function labelOf(n) {
  const k = typeof n === 'number' ? n & 0xff : parseInt(String(n).replace(/^0x/i, ''), 16)
  return Object.prototype.hasOwnProperty.call(SHORT_LABELS, k) ? SHORT_LABELS[k] : null
}

/** 「積算電力量計測値(正方向)・…」の 1 行（エディタと説明の文に使う）。 */
function namesText(epcs) {
  return takesOf(epcs)
    .map((t) => `${t.name}（${t.epc.slice(2)}）`)
    .join('・')
}

module.exports = { GROUPS, COMMON_ORDER, SHORT_LABELS, catalog, pollEpcOptions, takesOf, namesText, pollableEpcs, labelOf }
