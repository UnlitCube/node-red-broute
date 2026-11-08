// 設定タブの純関数: EPC を名前で選ぶ・構成の下書きと差分・ポートの候補・認証情報の検証、
// それに store（config・serialports・configLocked）・api（serialports・config・credentials）・operations（保存と失敗の出し方）。
// 部品の描画は test/ui/config-ui.test.mjs、App 全体（古いサーバーで壊れない）は test/ui/app.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { S } from '../../ui/strings.js'
import { epcOptionGroups, epcLabel, diffDraft, draftFrom } from '../../ui/settings-model.js'
import {
  CONFIG_FIELDS,
  RECONNECT_FIELDS,
  configDraftFrom,
  mergeConfigDraft,
  changedConfigFields,
  pruneConfigEdits,
  validateConfigDraft,
  diffConfigDraft,
  configValueText,
  portOptions,
  portOptionText,
  isSimulatorPort,
  validateCredentials,
  normMac,
  hasConfigRecord,
} from '../../ui/config-model.js'
import { reducer, initialState, configBlockReason, configSignature } from '../../ui/store.js'
import { createApi } from '../../ui/api.js'
import { createOperations } from '../../ui/operations.js'
import { createLoaders } from '../../ui/loaders.js'

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'

// ---- EPC を名前で選ぶ ----------------------------------------------------------

const OPTIONS = [
  { epc: '0xE7', name: '瞬時電力', desc: 'いま使っている電力 [W]。売電のときはマイナス', group: 'common', unit: 'W', supported: true },
  { epc: '0xE8', name: '瞬時電流', desc: 'R 相と T 相の電流 [A]', group: 'common', unit: 'A', supported: true },
  { epc: '0x80', name: '動作状態', desc: 'メーターが動いているか', group: 'info', unit: '', supported: false },
  { epc: '0xEA', name: '定時積算電力量（買電）', desc: '30 分ごとの確定値', group: 'scheduled', unit: 'kWh', supported: null },
  { epc: '0xE2', name: '積算電力量履歴 1', desc: '履歴', group: 'common', unit: 'kWh', supported: true },
  { epc: '0xF0', name: '知らないまとまり', desc: '', group: 'vendor', unit: '', supported: null },
]

// まとまりの順（よく使う / 定時の積算 / メーターの情報）。履歴（E2・E4・EC）は出さない。選択中で options に無い値も残す。
// 戻すと落ちるもの: 履歴を外さない・サーバーの並びのまま返す・選択中の値を落とす。
test('epcOptionGroups: よく使う → 定時の積算 → メーターの情報 → 知らないまとまり → 今の値。履歴は出さない', () => {
  const groups = epcOptionGroups(OPTIONS, ['E7', 'D3'])
  assert.deepEqual(
    groups.map((g) => [g.group, g.items.map((i) => i.epc)]),
    [
      ['common', ['E7', 'E8']],
      ['scheduled', ['EA']],
      ['info', ['80']],
      ['vendor', ['F0']],
      ['selected', ['D3']],
    ],
  )
  const e7 = groups[0].items[0]
  assert.deepEqual(e7, { epc: 'E7', name: '瞬時電力', desc: 'いま使っている電力 [W]。売電のときはマイナス', unit: 'W', supported: true })
  assert.equal(groups[2].items[0].supported, false)
  assert.equal(groups[1].items[0].supported, null)
  // options に無い選択中の値は、名前の分かるものは名前で（D3 = 係数）
  assert.equal(groups[4].items[0].name, '係数')
  // 空・形の違う options は空の並び（呼び手が今の記号のチップに戻す）
  assert.deepEqual(epcOptionGroups(null, ['E7']), [])
  assert.deepEqual(epcOptionGroups([], ['E7']), [])
})

test('EPC の名前: options の label（短い名前）を先に見る。label が無ければ name', () => {
  // 戻すと落ちるもの: epcOptionGroups・epcLabel を str(o.name) だけにする
  const options = [
    { epc: '0xE7', name: '瞬時電力計測値', label: '瞬時電力', desc: '', group: 'common', unit: 'W', supported: true },
    { epc: '0xE8', name: '瞬時電流計測値', label: null, desc: '', group: 'common', unit: 'A', supported: true },
  ]
  assert.deepEqual(epcOptionGroups(options, [])[0].items.map((o) => o.name), ['瞬時電力', '瞬時電流計測値'])
  assert.equal(epcLabel('0xE7', options), '瞬時電力（E7）')
  assert.equal(epcLabel('0xE8', options), '瞬時電流計測値（E8）')
})

test('epcLabel・diffDraft: options があれば EPC を名前で（瞬時電力（E7））、無ければ今までどおり記号', () => {
  assert.equal(epcLabel('0xE7', OPTIONS), '瞬時電力（E7）')
  assert.equal(epcLabel('E7', null), 'E7')
  const settings = {
    rev: 'r1',
    fields: {
      pollIntervalSec: { value: 30, source: 'config' },
      pollEpcs: { value: ['0xE7'], source: 'default', options: OPTIONS },
      slowIntervalSec: { value: 300, source: 'default' },
      halfHourIntervalSec: { value: 1800, source: 'default' },
    },
  }
  const d = Object.assign(draftFrom(settings), { pollEpcs: ['E7', 'E8'] })
  const c = diffDraft(d, settings).changes[0]
  assert.equal(c.from, '瞬時電力（E7）')
  assert.equal(c.to, '瞬時電力（E7）・瞬時電流（E8）')
  assert.deepEqual(diffDraft(d, settings).patch, { pollEpcs: ['E7', 'E8'] }, '送るのは記号のまま')
  delete settings.fields.pollEpcs.options
  assert.equal(diffDraft(d, settings).changes[0].to, 'E7 E8')
})

test('EPC の文言: 見出しは「定期的に取りに行く値」、5 分 / 30 分の説明は取る値を名前で書く', () => {
  assert.equal(S.settings.fields.pollEpcs, '定期的に取りに行く値')
  assert.match(S.settings.hints.slowIntervalSec, /積算電力量（買電・売電）/)
  assert.match(S.settings.hints.slowIntervalSec, /動作状態/)
  assert.match(S.settings.hints.slowIntervalSec, /異常発生状態/)
  assert.match(S.settings.hints.halfHourIntervalSec, /確定する積算/)
  // 16 進の記号だけの説明に戻さない
  assert.equal(/E0・E3|EA・EB/.test(S.settings.hints.slowIntervalSec + S.settings.hints.halfHourIntervalSec), false)
})

// ---- 構成の下書き・検証・差分 -------------------------------------------------------

function cfgField(value, extra = {}) {
  return Object.assign({ value, source: 'config', configValue: value, default: null, runtimeValue: null, by: null, at: null }, extra)
}

function configData(rev = 'c1', over = {}) {
  const fields = {
    name: cfgField('電力メーター'),
    role: cfgField('電力'),
    enabled: cfgField(true, { default: true }),
    mode: cfgField('serial', { default: 'serial' }),
    serialport: cfgField('/dev/ttyUSB0'),
    serialbaud: cfgField(115200, { default: 115200, options: [9600, 19200, 38400, 57600, 115200] }),
    deviceKey: cfgField('usb0'),
    expectedMac: cfgField(''),
    autoStart: cfgField(true, { default: true }),
    scanDurations: cfgField('4,5,6,7,8', { default: '4,5,6,7,8' }),
  }
  for (const k of Object.keys(over)) fields[k] = Object.assign({}, fields[k], over[k])
  return { rev, fields, warnings: [], credentials: { configured: true, source: '設定ノード', pairId: '89ABCDEF', envOverrides: false } }
}

test('configDraftFrom: 文字は文字のまま、真偽は真偽、速度とスキャンの段階は入力欄の文字', () => {
  assert.deepEqual(configDraftFrom(configData()), {
    name: '電力メーター',
    role: '電力',
    enabled: true,
    mode: 'serial',
    serialport: '/dev/ttyUSB0',
    serialbaud: '115200',
    deviceKey: 'usb0',
    expectedMac: '',
    autoStart: true,
    scanDurations: '4,5,6,7,8',
  })
  // 配列のスキャンの段階・値の無い項目・知らない mode
  const d = configDraftFrom(configData('c1', { scanDurations: { value: [4, 5, 6] }, role: { value: null }, mode: { value: 'x' } }))
  assert.equal(d.scanDurations, '4,5,6')
  assert.equal(d.role, '')
  assert.equal(d.mode, 'serial')
  // fields の無い Config（壊れた応答）でも落ちない
  assert.equal(configDraftFrom({}).enabled, true)
  assert.deepEqual(CONFIG_FIELDS, ['name', 'role', 'enabled', 'mode', 'serialport', 'serialbaud', 'deviceKey', 'expectedMac', 'autoStart', 'scanDurations'])
  assert.deepEqual(RECONNECT_FIELDS, ['mode', 'serialport', 'serialbaud', 'deviceKey', 'expectedMac'])
})

test('mergeConfigDraft・changedConfigFields・pruneConfigEdits: 手で変えた項目だけを重ね、同じ値に戻したものは外す', () => {
  const c = configData()
  assert.deepEqual(changedConfigFields(mergeConfigDraft(c, {}), c), [])
  const edits = { name: ' 電力メーター ', serialport: '/dev/ttyUSB1', expectedMac: '00:11:22:33:44:55:66:77', scanDurations: '4, 5, 6, 7, 8' }
  const d = mergeConfigDraft(c, edits)
  // 前後の空白・MAC の区切りと大文字小文字・スキャンの段階の空白は、変えた扱いにしない（MAC は値が変わったので変更）
  assert.deepEqual(changedConfigFields(d, c), ['serialport', 'expectedMac'])
  assert.deepEqual(pruneConfigEdits(edits, c), { serialport: '/dev/ttyUSB1', expectedMac: '00:11:22:33:44:55:66:77' })
  assert.deepEqual(edits.name, ' 電力メーター ', '渡した edits は書き換えない')
})

test('validateConfigDraft: 変えた項目だけ。MAC は 16 桁の 16 進・デバイスキーは英数字と _ -・スキャンは 2〜14 の整数・速度は表の値・シリアルならポートが要る', () => {
  const c = configData()
  const v = (edits) => validateConfigDraft(mergeConfigDraft(c, edits), c)
  assert.deepEqual(v({ expectedMac: '0011223344556677' }), {})
  assert.deepEqual(v({ expectedMac: '00112233' }), { expectedMac: S.config.errMac })
  assert.deepEqual(v({ expectedMac: '' }), {}, '空は照合しない（外す）')
  assert.deepEqual(v({ deviceKey: 'usb-0_A' }), {})
  assert.deepEqual(v({ deviceKey: 'usb 0' }), { deviceKey: S.config.errDeviceKey })
  assert.deepEqual(v({ scanDurations: '3,4' }), {})
  assert.deepEqual(v({ scanDurations: '1,4' }), { scanDurations: S.config.errScan(2, 14) })
  assert.deepEqual(v({ scanDurations: '' }), { scanDurations: S.config.errScan(2, 14) })
  assert.deepEqual(v({ scanDurations: '4,x' }), { scanDurations: S.config.errScan(2, 14) })
  assert.deepEqual(v({ serialbaud: '9600' }), {})
  assert.deepEqual(v({ serialbaud: '12345' }), { serialbaud: S.config.errBaud })
  assert.deepEqual(v({ serialport: '' }), { serialport: S.config.errPort })
  assert.deepEqual(v({ serialport: '', mode: 'simulator' }), {}, 'シミュレータならポートは要らない')
  // シリアルに戻したのにポートが空（触っていない項目でも、mode を変えたら確かめる）
  const sim = configData('c1', { mode: { value: 'simulator' }, serialport: { value: '' } })
  assert.deepEqual(validateConfigDraft(mergeConfigDraft(sim, { mode: 'serial' }), sim), { serialport: S.config.errPort })
  // 触っていない項目が形の外（サーバーの値）でも止めない
  const odd = configData('c1', { expectedMac: { value: 'zz' } })
  assert.deepEqual(validateConfigDraft(mergeConfigDraft(odd, { name: '別の名前' }), odd), {})
  // スキャンの段階の範囲は SettingField の min / max が正
  const narrow = configData('c1', { scanDurations: { min: 3, max: 8 } })
  assert.deepEqual(validateConfigDraft(mergeConfigDraft(narrow, { scanDurations: '9' }), narrow), { scanDurations: S.config.errScan(3, 8) })
})

test('diffConfigDraft: 送る本文は型をそろえ（速度は数・スキャンはサーバーと同じ形・MAC は大文字）、接続に関わる項目なら reconnect', () => {
  const c = configData()
  const r = diffConfigDraft(mergeConfigDraft(c, { name: '新しい名前', autoStart: false }), c)
  assert.deepEqual(r.patch, { name: '新しい名前', autoStart: false })
  assert.equal(r.reconnect, false)
  assert.deepEqual(
    r.changes.map((x) => [x.field, x.label, x.from, x.to]),
    [
      ['name', S.config.fields.name, '電力メーター', '新しい名前'],
      ['autoStart', S.config.fields.autoStart, S.config.yes, S.config.no],
    ],
  )
  const r2 = diffConfigDraft(mergeConfigDraft(c, { serialbaud: '9600', expectedMac: '00-11-22-33-44-55-66-77', scanDurations: '4 5 6' }), c)
  assert.deepEqual(r2.patch, { serialbaud: 9600, expectedMac: '0011223344556677', scanDurations: '4,5,6' })
  assert.equal(r2.reconnect, true)
  // サーバーが配列で持っているスキャンの段階は配列で送る
  const arr = configData('c1', { scanDurations: { value: [4, 5, 6, 7, 8], configValue: [4, 5, 6, 7, 8] } })
  assert.deepEqual(diffConfigDraft(mergeConfigDraft(arr, { scanDurations: '6,7' }), arr).patch, { scanDurations: [6, 7] })
  // 有効を外すのは disabling（確認に「計測を止めます」）
  const off = diffConfigDraft(mergeConfigDraft(c, { enabled: false }), c)
  assert.equal(off.disabling, true)
  assert.deepEqual(off.patch, { enabled: false })
  // mode の切り替え
  const m = diffConfigDraft(mergeConfigDraft(c, { mode: 'simulator' }), c)
  assert.deepEqual(m.changes.map((x) => [x.from, x.to]), [[S.config.modes.serial, S.config.modes.simulator]])
  assert.equal(m.reconnect, true)
  assert.deepEqual(diffConfigDraft(mergeConfigDraft(c, {}), c), { patch: {}, changes: [], reconnect: false, disabling: false })
})

test('configValueText: 空・未設定・真偽・接続先・速度の表示', () => {
  assert.equal(configValueText('name', ''), S.config.empty)
  assert.equal(configValueText('name', null), S.settings.unset)
  assert.equal(configValueText('enabled', true), S.config.enabledOn)
  assert.equal(configValueText('enabled', false), S.config.enabledOff)
  assert.equal(configValueText('autoStart', false), S.config.no)
  assert.equal(configValueText('mode', 'simulator'), S.config.modes.simulator)
  assert.equal(configValueText('serialbaud', 115200), '115200 bps')
  assert.equal(configValueText('scanDurations', [4, 5]), '4,5')
})

// 「画面かフローで保存した値がある」は runtimeValue だけで判断する（by が 'editor' の項目は外したあと）
test('hasConfigRecord: source が runtime か、runtimeValue がある。by editor・runtimeValue null は無い', () => {
  assert.equal(hasConfigRecord(cfgField('x', { source: 'runtime', runtimeValue: 'x', by: 'web-ui' })), true)
  assert.equal(hasConfigRecord(cfgField('x', { source: 'config', runtimeValue: null, by: 'editor', at: 1 })), false)
  assert.equal(hasConfigRecord(cfgField(false, { source: 'runtime', runtimeValue: false })), true, 'false も値')
  assert.equal(hasConfigRecord(null), false)
})

// ---- ポートの候補 ------------------------------------------------------------------

test('portOptions: 機器ごとに 1 つ・by-id があれば値は by-id。シミュレーターは除く（接続先で選ぶ）。今の値が候補に無ければ missing', () => {
  const BY1 = '/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0'
  const BY2 = '/dev/serial/by-id/usb-FTDI_X-if00-port0'
  const items = [
    { path: '/dev/ttyUSB0', label: 'RS-WSUHA', manufacturer: 'RATOC Systems', byId: BY1 },
    { path: '/dev/ttyAMA0', label: '', manufacturer: '', byId: null },
    { path: BY2, label: 'FT232R', manufacturer: 'FTDI', byId: true, realPath: '/dev/ttyUSB1' },
    { path: 'simulator', label: 'シミュレーター', simulator: true },
    { path: '/dev/ttyAMA0' },
    null,
    { label: 'パスが無い' },
  ]
  const o = portOptions(items, '/dev/ttyS9')
  assert.deepEqual(o.items.map((x) => [x.value, x.byId]), [[BY1, true], ['/dev/ttyAMA0', false], [BY2, true]])
  assert.equal(o.items[0].short, 'USB0')
  assert.equal(o.items[0].detail, 'RATOC Systems')
  assert.equal(o.items[2].short, 'USB1', 'by-id は realPath から短い名前を作る')
  assert.equal(o.missing, '/dev/ttyS9', '候補に無い今の値')
  assert.equal(o.selected, null)
  assert.equal(portOptions(items, '/dev/ttyUSB0').selected.value, BY1, '今の値の実体が同じなら、その候補を選んだ状態にする')
  assert.equal(isSimulatorPort({ path: 'simulator' }), true)
  assert.equal(isSimulatorPort({ path: '/dev/ttyUSB0', kind: 'simulator' }), true)
  assert.equal(isSimulatorPort({ path: '/dev/ttyUSB0' }), false)
  assert.deepEqual(portOptions(null, '').items, [])
  // COM（Windows）も 1 つの候補
  const com = portOptions([{ path: 'COM3', manufacturer: 'Silicon Labs' }], 'COM3')
  assert.deepEqual(com.items.map((x) => [x.value, x.short, x.detail]), [['COM3', 'COM3', 'Silicon Labs']])
  assert.equal(com.missing, null)
})

// サーバー（lib/runtime/service.js の serialPorts）の形: kind・usedBy・aliases。
// 戻すと落ちるもの: kind で分けない・ほかの台の usedBy を used に入れない・自分の usedBy まで使用中にする。
test('portOptions: kind で optgroup を分け、ほかの台とフローが使っているポートは used に入れる（自分は除く）。nameOf で文の中の名前に読み替える', () => {
  const BY = '/dev/serial/by-id/usb-FTDI_FT230X_Basic_UART_DEADBEEF-if00-port0'
  const items = [
    { path: BY, manufacturer: 'FTDI', byId: true, realPath: '/dev/ttyUSB0', aliases: ['/dev/ttyUSB0'], kind: 'wsuha', hint: null, usedBy: { kind: 'adapter', id: 'n1', name: '電力' } },
    { path: '/dev/ttyUSB1', manufacturer: '', byId: false, realPath: '/dev/ttyUSB1', aliases: [], kind: 'maybe', hint: null, usedBy: { kind: 'adapter', id: 'n2', name: '動力' } },
    { path: '/dev/ttyACM0', manufacturer: 'ACME', byId: false, realPath: '/dev/ttyACM0', aliases: [], kind: 'other', hint: 'ほかの機器', usedBy: { kind: 'flow', id: 'f1', name: 'ほかの無線', type: 'serial-port' } },
    { path: 'simulator', simulator: true },
  ]
  const o = portOptions(items, '/dev/ttyUSB0', 'n1', (id, name) => (id === 'n2' ? '動力（USB1）' : name))
  assert.deepEqual(o.groups.map((g) => [g.key, g.items.map((d) => d.short)]), [['wsuha', ['USB0', 'USB1']], ['other', ['ACM0']]])
  assert.equal(o.selected.value, BY, 'alias の値でも今の候補')
  assert.equal(o.items[0].used, null, '自分が使っているポートは選べる')
  assert.equal(o.items[1].used.name, '動力（USB1）')
  assert.equal(o.items[2].used.kind, 'flow')
  assert.ok(portOptionText(o.items[1]).includes('動力（USB1）'), portOptionText(o.items[1]))
  assert.ok(portOptionText(o.items[2]).includes('ほかの無線'), portOptionText(o.items[2]))
})

test('構成の検証はサーバーと同じ形: ポートは / で始まるか COM3、スキャンの段階は maxItems 個まで、名前は maxLength まで、速度は values の表', () => {
  const c = configData('c1', {
    name: { maxLength: 10 },
    scanDurations: { value: [4, 5, 6, 7, 8], min: 2, max: 14, maxItems: 3 },
    serialbaud: { options: undefined, values: [9600, 115200] },
  })
  const v = (edits) => validateConfigDraft(mergeConfigDraft(c, edits), c)
  assert.deepEqual(v({ serialport: 'ttyUSB0' }), { serialport: S.config.errPortForm })
  assert.deepEqual(v({ serialport: 'COM3' }), {})
  assert.deepEqual(v({ serialport: '\\\\.\\COM12' }), {})
  assert.deepEqual(v({ scanDurations: '4,5,6,7' }), { scanDurations: S.config.errScan(2, 14, 3) })
  assert.deepEqual(v({ scanDurations: '4,5,6' }), {})
  assert.deepEqual(v({ name: '12345678901' }), { name: S.config.errTooLong(10) })
  assert.deepEqual(v({ serialbaud: '19200' }), { serialbaud: S.config.errBaud })
  assert.deepEqual(v({ serialbaud: '9600' }), {})
  assert.deepEqual(v({ deviceKey: 'k'.repeat(33) }), { deviceKey: S.config.errDeviceKey })
  // 配列で持っているスキャンの段階は配列で送る
  assert.deepEqual(diffConfigDraft(mergeConfigDraft(c, { scanDurations: '6,7' }), c).patch, { scanDurations: [6, 7] })
})

test('diffConfigDraft: 接続に関わるかはサーバーの印（SettingField.connection）が正', () => {
  const c = configData('c1', { name: { connection: true }, serialbaud: { connection: false } })
  assert.equal(diffConfigDraft(mergeConfigDraft(c, { name: 'x' }), c).reconnect, true)
  assert.equal(diffConfigDraft(mergeConfigDraft(c, { serialbaud: '9600' }), c).reconnect, false)
})

// ---- 認証情報 --------------------------------------------------------------------

test('validateCredentials: ID は 32 桁の 16 進数・パスワードは 12 桁の英数字。理由の文に入力した値を入れない', () => {
  assert.deepEqual(validateCredentials(ID, PW), {})
  const e = validateCredentials('0123', 'ABC-DEF12345')
  assert.equal(e.routeBId, S.config.credIdInvalid)
  assert.equal(e.routeBPassword, S.config.credPasswordInvalid)
  assert.deepEqual(Object.keys(validateCredentials('', '')).sort(), ['routeBId', 'routeBPassword'])
  for (const msg of Object.values(validateCredentials(ID + 'X', PW + 'X'))) {
    assert.equal(msg.includes(ID) || msg.includes(PW), false)
  }
  assert.equal(normMac('00:11:22:33:44:55:66:77'), '0011223344556677')
})

// 画面の ID の検証が「32 桁の英数字」で、サーバー（32 桁の 16 進数）と違った。G〜Z を含む ID が画面を通り、
// 「接続し直します」の確認まで進んでから 422 で断られていた。
// 戻すと落ちるもの: /^[0-9A-Za-z]{32}$/ に戻す（G〜Z が通る）・trim しない（前後の空白でサーバーは通るのに画面が断る）・文言を「英数字」に戻す。
test('validateCredentials: ID は 32 桁の 16 進数（G〜Z は断る）・前後の空白は除いて見る。文言も 16 進数', () => {
  assert.deepEqual(validateCredentials('G123456789ABCDEF0123456789ABCDEF', PW), { routeBId: S.config.credIdInvalid })
  assert.deepEqual(validateCredentials('0123456789ABCDEF0123456789ABCDEZ', PW), { routeBId: S.config.credIdInvalid })
  assert.deepEqual(validateCredentials(ID.toLowerCase(), PW.toLowerCase()), {}, '小文字の 16 進はサーバーが大文字にする')
  assert.deepEqual(validateCredentials(' ' + ID + '\t', ' ' + PW + ' '), {}, '前後の空白はサーバーが trim する')
  assert.deepEqual(validateCredentials(ID.slice(0, 16) + ' ' + ID.slice(17), PW), { routeBId: S.config.credIdInvalid }, '中の空白は断る')
  for (const s of [S.config.credIdInvalid, S.config.credIdHint]) {
    assert.ok(s.includes('16 進数'), s)
    assert.equal(s.includes('英数字'), false, s)
  }
})

// 画面の検証とサーバー（lib/runtime/credentials-store.js の validateCredentialsInput）の判定が、同じ入力で食い違わないこと。
// 画面だけが通す値は「確認のあとで 422」、サーバーだけが通す値は「正しい値なのに保存できない」になる。
test('validateCredentials: 通すか断るかがサーバーの validateCredentialsInput と同じ（項目ごと）', () => {
  const require = createRequire(import.meta.url)
  const { validateCredentialsInput } = require('../../lib/runtime/credentials-store.js')
  const ids = [ID, ID.toLowerCase(), ' ' + ID + ' ', 'G' + ID.slice(1), ID.slice(0, 31), ID + '0', '', 'ABCDEFABCDEFABCDEFABCDEFABCDEFAG', 'Ａ'.repeat(32), ID.slice(0, 31) + '-']
  const pws = [PW, PW.toLowerCase(), ' ' + PW + ' ', 'ABC-DEF12345', PW.slice(0, 11), PW + 'A', '', 'GHIJKLMNOPQR', 'ＡＢＣＤＥＦ123456']
  for (const id of ids) {
    for (const pw of pws) {
      const ui = validateCredentials(id, pw)
      const sv = validateCredentialsInput({ routeBId: id, routeBPassword: pw }).errors
      assert.equal(!!ui.routeBId, !!sv.routeBId, `ID の判定（長さ ${id.length}）`)
      assert.equal(!!ui.routeBPassword, !!sv.routeBPassword, `パスワードの判定（長さ ${pw.length}）`)
    }
  }
})

// ---- store --------------------------------------------------------------------------

test('store: 構成の読み込み・古いサーバー（unsupported）・失敗・ポートの候補・CONFIG_LOCKED', () => {
  let s = reducer(initialState, { type: 'config/loaded', id: 'a1', config: configData() })
  assert.equal(s.configs.a1.status, 'ok')
  assert.equal(s.configs.a1.data.rev, 'c1')
  s = reducer(s, { type: 'config/failed', id: 'a1', error: { status: 500, message: 'x' } })
  assert.equal(s.configs.a1.status, 'ok', '前の値は残す')
  assert.equal(s.configs.a1.error.status, 500)
  s = reducer(s, { type: 'config/unsupported', id: 'a2' })
  assert.equal(s.configs.a2.status, 'unsupported')
  s = reducer(s, { type: 'config/failed', id: 'a3', error: { status: 503 } })
  assert.equal(s.configs.a3.status, 'error')

  s = reducer(s, { type: 'serialports/loading' })
  assert.equal(s.serialports.status, 'loading')
  s = reducer(s, { type: 'serialports/loaded', items: [{ path: '/dev/ttyUSB0' }], at: 5 })
  assert.deepEqual(s.serialports, { items: [{ path: '/dev/ttyUSB0' }], at: 5, status: 'ok', error: null, message: null })
  s = reducer(s, { type: 'serialports/loading' })
  assert.equal(s.serialports.status, 'ok', '読み直しの間も前の候補を出す')
  assert.equal(s.serialports.loading, true)
  s = reducer(s, { type: 'serialports/failed', error: { status: 500 } })
  assert.equal(s.serialports.status, 'ok')
  assert.equal(s.serialports.loading, false)
  s = reducer(s, { type: 'serialports/unsupported' })
  assert.equal(s.serialports.status, 'unsupported')

  // CONFIG_LOCKED は構成と認証情報の書き込みだけを止める（運用設定と操作は writeBlockReason のまま）
  assert.equal(configBlockReason(initialState, S), null)
  const locked = reducer(initialState, { type: 'configLocked', reason: 'このサーバーでは画面から構成を変えられません' })
  assert.equal(configBlockReason(locked, S), 'このサーバーでは画面から構成を変えられません')
  const ro = reducer(locked, { type: 'readOnly', reason: '読み出しのみです' })
  assert.equal(configBlockReason(ro, S), '読み出しのみです', '読み出しのみが先')
  const metaLocked = reducer(initialState, { type: 'meta', meta: { readOnly: false, configLocked: true } })
  assert.equal(configBlockReason(metaLocked, S), S.config.lockedReason)
  // サーバーが「止めていない」と言えば、前に受けた 403 CONFIG_LOCKED の止めも外す
  const unlocked = reducer(locked, { type: 'meta', meta: { readOnly: false, configLocked: false } })
  assert.equal(configBlockReason(unlocked, S), null)
  // configLocked を返さない古いサーバーの meta では外さない
  assert.equal(configBlockReason(reducer(locked, { type: 'meta', meta: { readOnly: false } }), S), 'このサーバーでは画面から構成を変えられません')
})

test('configSignature: 名前・契約・有効・接続先・ポート・デバイスキー・想定 MAC・認証情報が変わったときだけ変わる', () => {
  const a = { name: 'x', role: '電力', enabled: true, mode: 'serial', port: '/dev/ttyUSB0', deviceKey: 'usb0', device: { expectedMac: null }, credentials: { configured: true, source: '設定ノード', pairId: '89ABCDEF' }, power: { value: 1 } }
  const s0 = configSignature(a)
  assert.equal(configSignature(Object.assign({}, a, { power: { value: 2 } })), s0)
  for (const change of [{ name: 'y' }, { role: '動力' }, { enabled: false }, { mode: 'simulator' }, { port: '/dev/ttyUSB1' }, { deviceKey: 'k' }, { device: { expectedMac: '0011223344556677' } }, { credentials: { configured: true, source: '画面', pairId: '89ABCDEF' } }]) {
    assert.notEqual(configSignature(Object.assign({}, a, change)), s0, JSON.stringify(change))
  }
  assert.equal(configSignature(null), null)
})

// ---- api ----------------------------------------------------------------------------

function recordingFetch(respond) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const r = respond(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

test('api: serialports・config（GET / PUT / DELETE。If-Match）・credentials（PUT / DELETE）の URL と本文', async () => {
  const { calls, fetchImpl } = recordingFetch(() => ({ body: {} }))
  const api = createApi({ base: 'http://h/n/wsuha-broute/api/v1/', fetchImpl })
  await api.serialports()
  await api.config('a/1')
  await api.putConfig('a/1', 'c1', { name: 'x' })
  await api.resetConfig('a/1', 'c2')
  await api.putCredentials('a/1', { routeBId: ID, routeBPassword: PW })
  await api.clearCredentials('a/1')
  const view = calls.map((c) => [c.init.method, c.url, c.init.headers['If-Match'] || null, c.init.body === undefined ? null : JSON.parse(c.init.body)])
  assert.deepEqual(view, [
    ['GET', 'http://h/n/wsuha-broute/api/v1/serialports', null, null],
    ['GET', 'http://h/n/wsuha-broute/api/v1/adapters/a%2F1/config', null, null],
    ['PUT', 'http://h/n/wsuha-broute/api/v1/adapters/a%2F1/config', 'c1', { name: 'x' }],
    ['DELETE', 'http://h/n/wsuha-broute/api/v1/adapters/a%2F1/config', 'c2', null],
    ['PUT', 'http://h/n/wsuha-broute/api/v1/adapters/a%2F1/credentials', null, { routeBId: ID, routeBPassword: PW }],
    ['DELETE', 'http://h/n/wsuha-broute/api/v1/adapters/a%2F1/credentials', null, null],
  ])
  for (const c of calls.filter((x) => x.init.method !== 'GET')) assert.equal(c.init.headers['Content-Type'], 'application/json', c.init.method + ' ' + c.url)
})

// ---- loaders ---------------------------------------------------------------------------

test('loaders: GET config の 404 NOT_FOUND（古いサーバー）は unsupported、404 ADAPTER_NOT_FOUND とほかの失敗は failed', async () => {
  const cases = [
    [{ status: 404, body: { error: { code: 'NOT_FOUND', message: 'その API はありません' } } }, 'config/unsupported'],
    [{ status: 404, body: { error: { code: 'ADAPTER_NOT_FOUND', message: 'アダプタが見つかりません' } } }, 'config/failed'],
    [{ status: 500, body: { error: { code: 'INTERNAL', message: 'x' } } }, 'config/failed'],
    [{ status: 200, body: configData() }, 'config/loaded'],
  ]
  for (const [res, want] of cases) {
    const { fetchImpl } = recordingFetch(() => res)
    const seen = []
    const load = createLoaders({ api: createApi({ base: 'http://h/wsuha-broute/api/v1/', fetchImpl }), dispatch: (a) => seen.push(a), getState: () => initialState })
    await load.config('a1')
    assert.equal(seen[seen.length - 1].type, want, JSON.stringify(res.body).slice(0, 60))
  }
  // ポートの候補: 古いサーバー（404 NOT_FOUND）は unsupported
  const { fetchImpl } = recordingFetch(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'その API はありません' } } }))
  const seen = []
  await createLoaders({ api: createApi({ base: 'http://h/wsuha-broute/api/v1/', fetchImpl }), dispatch: (a) => seen.push(a), getState: () => initialState }).serialports()
  assert.deepEqual(seen.map((a) => a.type), ['serialports/loading', 'serialports/unsupported'])
})

// ---- operations ---------------------------------------------------------------------

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code, message })
}

function opsWith(api) {
  const actions = []
  const toasts = []
  const ops = createOperations({ api, dispatch: (a) => actions.push(a), toast: (tone, title, body) => toasts.push({ tone, title, body }) })
  return { ops, actions, toasts }
}

test('構成の保存: 成功は Config を入れて ok のトースト。412・422・409 PORT_IN_USE はトーストにせず呼び手へ（画面が message をそのまま出す）', async () => {
  const saved = configData('c2')
  const ok = opsWith({ putConfig: async () => saved })
  const r = await ok.ops.saveConfig('a1', { name: 'x' }, 'c1')
  assert.equal(r.ok, true)
  assert.deepEqual(ok.actions, [{ type: 'config/loaded', id: 'a1', config: saved }])
  assert.equal(ok.toasts[0].tone, 'ok')

  for (const [status, code] of [[412, 'REVISION_MISMATCH'], [422, 'VALIDATION'], [409, 'PORT_IN_USE']]) {
    const t = opsWith({ putConfig: async () => { throw apiError(status, code, 'サーバーの文') } })
    const r2 = await t.ops.saveConfig('a1', {}, 'c1')
    assert.equal(r2.ok, false)
    assert.equal(r2.error.code, code)
    assert.deepEqual(t.toasts, [], code + ' はトーストにしない')
  }
})

test('構成の保存・戻す・認証情報: 403 CONFIG_LOCKED は構成の止め（configLocked）、READ_ONLY は読み出しのみ。message はそのまま', async () => {
  for (const [method, args] of [['saveConfig', ['a1', { name: 'x' }, 'c1']], ['resetConfig', ['a1', 'c1']], ['saveCredentials', ['a1', { routeBId: ID, routeBPassword: PW }]], ['clearCredentials', ['a1']]]) {
    const apiName = { saveConfig: 'putConfig', resetConfig: 'resetConfig', saveCredentials: 'putCredentials', clearCredentials: 'clearCredentials' }[method]
    const locked = opsWith({ [apiName]: async () => { throw apiError(403, 'CONFIG_LOCKED', '構成の変更を止めています（サーバーの文）') } })
    await locked.ops[method](...args)
    assert.deepEqual(locked.actions, [{ type: 'configLocked', reason: '構成の変更を止めています（サーバーの文）' }], method)
    assert.equal(locked.toasts[0].tone, 'danger')
    assert.equal(locked.toasts[0].body, '構成の変更を止めています（サーバーの文）')
    const ro = opsWith({ [apiName]: async () => { throw apiError(403, 'READ_ONLY', '読み出しのみ（サーバーの文）') } })
    await ro.ops[method](...args)
    assert.deepEqual(ro.actions, [{ type: 'readOnly', reason: '読み出しのみ（サーバーの文）' }], method)
  }
})

// 認証情報の値は画面・API の応答・ログ・出力のどこにも出さない。画面の側では store（dispatch）とトーストに入れない。
// 戻すと落ちるもの: saveCredentials が送った本文を dispatch やトーストに載せる。
test('認証情報の保存: 送った値を dispatch・トースト・戻り値に入れない。応答が Config ならそれを入れる', async () => {
  const sent = []
  const t = opsWith({
    putCredentials: async (id, body) => {
      sent.push(body)
      return configData('c3')
    },
  })
  const r = await t.ops.saveCredentials('a1', { routeBId: ID, routeBPassword: PW })
  assert.deepEqual(sent, [{ routeBId: ID, routeBPassword: PW }])
  assert.equal(r.ok, true)
  const everything = JSON.stringify({ actions: t.actions, toasts: t.toasts, r })
  assert.equal(everything.includes(ID), false)
  assert.equal(everything.includes(PW), false)
  assert.equal(t.actions[0].type, 'config/loaded')
  // 応答が Config の形でない（{ok:true} など）なら、何も入れない（呼び手が GET config で取り直す）
  const t2 = opsWith({ putCredentials: async () => ({ ok: true, credentials: { configured: true } }) })
  const r2 = await t2.ops.saveCredentials('a1', { routeBId: ID, routeBPassword: PW })
  assert.equal(r2.ok, true)
  assert.deepEqual(t2.actions, [])
  // 失敗しても値を出さない（422 の message はサーバーの文のまま）
  const t3 = opsWith({ putCredentials: async () => { throw apiError(422, 'VALIDATION', '認証 ID は 32 桁です') } })
  const r3 = await t3.ops.saveCredentials('a1', { routeBId: ID, routeBPassword: PW })
  assert.equal(r3.ok, false)
  assert.equal(JSON.stringify({ a: t3.actions, t: t3.toasts }).includes(ID), false)
})
