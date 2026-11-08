// 設定タブの「定期的に取りに行く値」と「構成」・認証情報を偽の DOM に描いて確かめる。
// レイアウト（390px の横スクロール）はここでは測れない（実ブラウザで見る）。CSS の規則は test/ui/layout.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mount, click, typeInto, fire, settle, until, $, $$, textOf, buttonByText } from './fake-dom.mjs'

installDom()
const { html } = await import('../../ui/html.js')
const { S } = await import('../../ui/strings.js')
const { SettingsTab } = await import('../../ui/components/tab-settings.js')
const { ROLE_OTHER } = await import('../../ui/config-model.js')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'
const AT = new Date(2026, 10, 6, 10, 0, 0).getTime()
const AT_TEXT = '2026/11/06 10:00:00'

const adapter = (extra = {}) =>
  Object.assign(
    {
      id: 'n1',
      name: '電力メーター',
      role: '電力',
      enabled: true,
      mode: 'serial',
      port: '/dev/ttyUSB0',
      portLabel: 'RS-WSUHA',
      deviceKey: 'usb0',
      supportedEpcs: null,
      device: { expectedMac: null },
      credentials: { configured: true, source: '設定ノード', pairId: '89ABCDEF' },
      overridden: { stopped: null, any: false },
    },
    extra,
  )

const OPTIONS = [
  { epc: '0xE7', name: '瞬時電力', desc: 'いま使っている電力 [W]。売電のときはマイナス', group: 'common', unit: 'W', supported: true },
  { epc: '0xE8', name: '瞬時電流', desc: 'R 相と T 相の電流 [A]', group: 'common', unit: 'A', supported: true },
  { epc: '0xE0', name: '積算電力量（買電）', desc: '', group: 'common', unit: 'kWh', supported: true },
  { epc: '0xEA', name: '定時積算電力量（買電）', desc: '30 分ごとの確定値', group: 'scheduled', unit: 'kWh', supported: null },
  { epc: '0x80', name: '動作状態', desc: 'メーターが動いているか', group: 'info', unit: '', supported: false },
  { epc: '0x88', name: '異常発生状態', desc: 'メーターの異常の有無', group: 'info', unit: '', supported: false },
  { epc: '0xE2', name: '積算電力量履歴 1', desc: '履歴', group: 'common', unit: 'kWh', supported: true },
]

function settingsData(rev = 'r1', { options = OPTIONS, epcs = ['0xE7'] } = {}) {
  const f = (value, source, extra = {}) => Object.assign({ value, source, configValue: value, default: value, runtimeValue: null, by: null, at: null }, extra)
  return {
    rev,
    fields: {
      pollIntervalSec: f(30, 'config', { min: 15, max: 3600 }),
      pollEpcs: f(epcs, 'default', options ? { options, min: 1, max: 6 } : { min: 1, max: 6 }),
      slowIntervalSec: f(300, 'default', { min: 60, max: 3600 }),
      halfHourIntervalSec: f(1800, 'default', { min: 300, max: 7200 }),
    },
    warnings: [],
  }
}

function cfgField(value, extra = {}) {
  return Object.assign({ value, source: 'config', configValue: value, default: null, runtimeValue: null, by: null, at: null }, extra)
}

function configData(rev = 'c1', over = {}, cred = {}) {
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
  return { rev, fields, warnings: [], credentials: Object.assign({ configured: true, source: '設定ノード', pairId: '89ABCDEF', envOverrides: false }, cred) }
}

const PORTS = {
  items: [
    { path: '/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0', label: 'RS-WSUHA', manufacturer: 'RATOC Systems', byId: true, realPath: '/dev/ttyUSB0', portLabel: 'USB0', kind: 'wsuha', hint: null, usedBy: null, aliases: ['/dev/ttyUSB0'] },
    { path: '/dev/ttyUSB1', label: '', manufacturer: 'FTDI', byId: false, realPath: '/dev/ttyUSB1', portLabel: 'USB1', kind: 'maybe', hint: null, usedBy: null, aliases: [] },
    { path: 'simulator', label: 'シミュレーター', simulator: true },
  ],
  at: AT,
  status: 'ok',
  error: null,
}

function props(extra = {}) {
  const calls = { saveConfig: [], resetConfig: [], reloadConfig: 0, ports: 0, cred: [], clear: 0, saveSettings: [] }
  const p = Object.assign(
    {
      a: adapter(),
      settings: { status: 'ok', data: settingsData(), error: null },
      config: { status: 'ok', data: configData(), error: null },
      serialports: PORTS,
      writeReason: null,
      configWriteReason: null,
      editorRoot: 'http://h/',
      onSaveSettings: async (patch, rev) => (calls.saveSettings.push({ patch, rev }), { ok: true }),
      onResetSettings: async () => ({ ok: true }),
      onReloadSettings: () => {},
      onSaveConfig: async (patch, rev) => (calls.saveConfig.push({ patch, rev }), { ok: true }),
      onResetConfig: async (rev) => (calls.resetConfig.push(rev), { ok: true }),
      onReloadConfig: () => calls.reloadConfig++,
      onLoadSerialports: () => calls.ports++,
      onSaveCredentials: async (body) => (calls.cred.push(body), { ok: true }),
      onClearCredentials: async () => (calls.clear++, { ok: true }),
    },
    extra,
  )
  return { p, calls }
}

const cfg = (root) => $(root, 'section[data-section="config"]')
const row = (root, f) => $(root, `.set-row[data-field="${f}"]`)
// 出どころは基本設定には出さず、詳細設定の「出どころ」の表にまとめた
const srcOf = (root, f) => textOf($(root, `.src-row[data-field="${f}"]`))
/** B ルートの認証 ID とパスワードのカード。 */
const credCard = (root) => $(root, 'section[data-card="credentials"]')
/** 設定済みなら欄は閉じている。［入れ直す］で開く。 */
async function openCred(root) {
  click(buttonByText(credCard(root), S.config.credReenter))
  await settle()
  return credCard(root)
}
const optOf = (root, epc) => $(root, `.epc-opt[data-epc="${epc}"]`)
const has = (root, s) => textOf(root).includes(s)
const cls = (el) => String((el && el.getAttribute('class')) || '').split(/\s+/)
async function openSave(root) {
  fire($(cfg(root), 'form.config-form'), 'submit')
  await settle()
  return $(root, '.dialog-form')
}

// ---- 定期的に取りに行く値 --------------------------------------------------------------

// EPC の記号だけでは意味が分からないので、名前と短い説明で選び、記号は小さく添える。
// 戻すと落ちるもの: options があっても記号のチップ（EpcChips）を出す・まとまりの見出しを出さない・履歴を出す。
test('定期的に取りに行く値: まとまりごと（よく使う / 定時の積算 / メーターの情報）に、名前・説明・小さな記号。履歴は出さない', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const r = row(m.root, 'pollEpcs')
  assert.ok(textOf($(r, '.set-name')) === '定期的に取りに行く値', textOf($(r, '.set-name')))
  assert.equal($$(r, '.chips .chip').length, 0, '記号のチップではない')
  // よく使う値は基本設定にそのまま並び、ほかの値は詳細設定の「ほかの値」にまとまりごと
  assert.ok(textOf($(r, '.epc-count')).includes(S.settings.epcCount(1, 6)))
  const others = $(m.root, 'details.epc-others')
  assert.deepEqual($$(others, '.epc-groups .epc-group-name').map(textOf), [S.settings.epcGroups.scheduled, S.settings.epcGroups.info])
  // 数の多いまとまり（メーターの情報）は、選んでいなければ閉じておく。定時の積算は開く
  const openOf = (g) => $(others, `details.epc-group[data-group="${g}"]`).open
  assert.deepEqual(['scheduled', 'info'].map(openOf), [true, false])
  const e7 = optOf(m.root, 'E7')
  assert.equal(textOf($(e7, '.epc-opt-name')), '瞬時電力')
  assert.equal(textOf($(e7, '.epc-code')), 'E7', '記号は小さく添える')
  assert.ok(textOf($(e7, '.epc-desc')).includes('いま使っている電力'))
  assert.equal($(e7, 'input[type="checkbox"]').checked, true)
  // 説明の無い値は単位を出す
  assert.equal(textOf($(optOf(m.root, 'E0'), '.epc-desc')), '[kWh]')
  assert.equal(optOf(m.root, 'E2'), null, '履歴は出さない')
  await m.unmount()
})

// メーターが持っていない値（0x9F に無い）は薄く「このメーターは持っていません」。選んでいなければ選べない。
test('定期的に取りに行く値: メーターが持っていない値は薄く「このメーターは持っていません」。選んでいる値は外せる', async () => {
  const { p } = props({ settings: { status: 'ok', data: settingsData('r1', { epcs: ['0xE7', '0x88'] }), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const o80 = optOf(m.root, '80')
  assert.ok(cls(o80).includes('epc-opt-off'))
  assert.ok(textOf(o80).includes(S.settings.epcUnsupported))
  assert.equal($(o80, 'input').hasAttribute('disabled'), true, '持っていない値は選べない')
  const o88 = optOf(m.root, '88')
  assert.equal($(o88, 'input').hasAttribute('disabled'), false, '選んでいる値は外せる')
  // マップの無い値（supported null）は普通
  assert.equal(cls(optOf(m.root, 'EA')).includes('epc-opt-off'), false)
  // 選んでいる値（88）のあるまとまりは開く
  assert.equal($(m.root, 'details.epc-group[data-group="info"]').open, true)
  await m.unmount()
})

// まとまりの開閉は、最初に描いたときだけ決め、あとは利用者の開閉に従う。
// 戻すと落ちるもの: details の open を描画ごとに「選んでいる値があるか」で決め直す → メーターの情報の最後の 1 つを外した瞬間に、
//   触っている最中のまとまりが閉じる（Preact は open が true → false に変わったときに DOM を閉じる）。
test('定期的に取りに行く値: まとまりの開閉は最初だけ決め、値を外しても・描き直しても勝手に閉じない', async () => {
  const { p } = props({ settings: { status: 'ok', data: settingsData('r1', { epcs: ['0xE7', '0x88'] }), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const info = () => $(m.root, 'details.epc-group[data-group="info"]')
  assert.equal(info().open, true, '選んでいる値（88）があるので開いている')
  fire($(optOf(m.root, '88'), 'input'), 'change')
  await settle()
  assert.equal($(optOf(m.root, '88'), 'input').checked, false)
  assert.equal(info().open, true, '外しても閉じない')
  // 利用者が閉じたまとまりは、描き直しても閉じたまま
  const sched = () => $(m.root, 'details.epc-group[data-group="scheduled"]')
  sched().open = false
  fire(sched(), 'toggle', { bubbles: false })
  await settle()
  await m.rerender(html`<${SettingsTab} ...${Object.assign({}, p, { settings: { status: 'ok', data: settingsData('r2'), error: null } })} />`)
  assert.equal(sched().open, false)
  assert.equal(info().open, true)
  await m.unmount()
})

test('定期的に取りに行く値: 選ぶと保存の本文は記号、確認は名前で。6 個を超えては選べない', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  fire($(optOf(m.root, 'E8'), 'input'), 'change')
  await settle()
  assert.equal($(optOf(m.root, 'E8'), 'input').checked, true)
  fire($(m.root, 'form.measure-form'), 'submit')
  await settle()
  const diff = textOf($(m.root, '.diff-table'))
  assert.ok(diff.includes('瞬時電力（E7）・瞬時電流（E8）'), diff)
  fire($(m.root, '.dialog-form'), 'submit')
  await settle()
  assert.deepEqual(calls.saveSettings, [{ patch: { pollEpcs: ['E7', 'E8'] }, rev: 'r1' }])
  await m.unmount()

  const six = settingsData('r1', { epcs: ['0xE7', '0xE8', '0xE0', '0xEA', '0xD3', '0xD7'] })
  const { p: p2 } = props({ settings: { status: 'ok', data: six, error: null } })
  const m2 = await mount(html`<${SettingsTab} ...${p2} />`)
  assert.equal($(optOf(m2.root, '80'), 'input').hasAttribute('disabled'), true)
  // options に無い選択中の値（D3・D7）も「今の値」のまとまりに出て外せる
  assert.ok(textOf($(m2.root, 'details.epc-others')).includes(S.settings.epcGroups.selected))
  assert.equal($(optOf(m2.root, 'D3'), 'input').checked, true)
  await m2.unmount()
})

// options が無い（古いサーバー）ときは今の記号の並びに戻る。
test('定期的に取りに行く値: options の無い古いサーバーでは、今の記号のチップのまま', async () => {
  const { p } = props({ settings: { status: 'ok', data: settingsData('r1', { options: null }), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.ok($$(row(m.root, 'pollEpcs'), '.chips .chip').length > 0)
  assert.equal($$(m.root, '.epc-opt').length, 0)
  await m.unmount()
})

test('5 分 / 30 分の取得の説明は、取る値を名前で書く', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.ok(textOf($(row(m.root, 'slowIntervalSec'), '.set-label')).includes(S.settings.hints.slowIntervalSec))
  assert.ok(S.settings.hints.slowIntervalSec.includes('積算電力量'), S.settings.hints.slowIntervalSec)
  assert.ok(S.settings.hints.halfHourIntervalSec.includes('確定する積算'), S.settings.hints.halfHourIntervalSec)
  await m.unmount()
})

// ---- 構成 -------------------------------------------------------------------------

// 「構成（読むだけ）」を編集できる「構成」に。項目ごとに出どころ（設定ノード / 画面 / フロー（名前） / エディタ）と時刻。
// 戻すと落ちるもの: 読むだけの表のまま・出どころを出さない・by をそのまま出す。
test('構成: 10 項目の入力と、出どころ（設定ノード / 画面 · 時刻 / フロー（名前） · 時刻 / 設定ノード · エディタ · 時刻）', async () => {
  const data = configData('c1', {
    name: { value: '新しい名前', source: 'runtime', runtimeValue: '新しい名前', by: 'web-ui', at: AT },
    role: { value: '動力', source: 'runtime', runtimeValue: '動力', by: 'flow:構成の入力', at: AT },
    deviceKey: { value: 'usb0', source: 'config', by: 'editor', at: AT },
  })
  const { p } = props({ config: { status: 'ok', data, error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  assert.ok(c, '構成の区切り')
  assert.equal(textOf($(c, '.card-title')), S.config.title)
  for (const f of ['name', 'role', 'enabled', 'mode', 'serialport', 'serialbaud', 'deviceKey', 'expectedMac', 'autoStart', 'scanDurations']) {
    assert.ok(row(c, f), f + ' の行')
  }
  assert.equal($(c, '#cfg-in-name').value, '新しい名前')
  assert.equal($(c, '#cfg-in-enabled').checked, true)
  assert.equal($(c, '#cfg-in-serialbaud').value, '115200')
  assert.ok(srcOf(c, 'name').includes('画面 · ' + AT_TEXT), srcOf(c, 'name'))
  assert.ok(srcOf(c, 'role').includes('フロー（構成の入力） · ' + AT_TEXT), srcOf(c, 'role'))
  assert.ok(srcOf(c, 'role').includes('電力'), '設定ノードの値も添える')
  assert.ok(srcOf(c, 'deviceKey').includes(S.config.sourceConfig + ' · エディタ · ' + AT_TEXT), srcOf(c, 'deviceKey'))
  assert.ok(srcOf(c, 'serialport').includes(S.config.sourceConfig), srcOf(c, 'serialport'))
  // 同じことはフローの入力とエディタでもできる、と設定タブの下に 1 行
  assert.equal(textOf(m.root).split(S.settings.tabFooter).length - 1, 1)
  // 「エディタで開く」は残す
  assert.equal($(c, 'a[target="_blank"]').getAttribute('href'), 'http://h/#node/n1')
  await m.unmount()
})

// ポートは GET serialports の候補から選ぶ（by-id を先に、ラベルとメーカー）。手入力もできる。「候補を読み直す」。
test('構成のポート: 候補は by-id を先に、ラベルとメーカー。シミュレータの候補は出さない。選ぶと手入力の欄に入り、手入力もできる', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const r = row(cfg(m.root), 'serialport')
  const sel = $(r, 'select')
  const opts = $$(sel, 'option')
  // 機器ごとに 1 つ。今の値（ttyUSB0）の実体と同じ by-id の候補を選んだ状態で出し、値は変えない
  assert.deepEqual(
    opts.map((o) => o.value), // Preact は option の value をプロパティで入れる（属性ではない）
    ['/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0', '/dev/ttyUSB1'],
  )
  assert.equal(sel.value, '/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0')
  assert.ok(textOf(opts[0]).includes('USB0') && textOf(opts[0]).includes('RATOC Systems'), textOf(opts[0]))
  assert.equal(opts.some((o) => textOf(o).includes('シミュレータ')), false)
  assert.ok(textOf(r).includes(S.config.portCount(2, '10:00:00')), textOf(r))
  assert.equal(textOf($(cfg(m.root), '.form-state')), S.config.noChanges, '触らなければ差分にしない')
  // 選ぶ → 詳細設定の手入力の欄に入る → 差分になる
  sel.value = '/dev/ttyUSB1'
  fire(sel, 'change')
  await settle()
  assert.equal($(cfg(m.root), '#cfg-in-serialport').value, '/dev/ttyUSB1')
  assert.equal(textOf($(cfg(m.root), '.form-state')), S.config.dirty)
  // 手入力（候補に無い値は「今の値」として先頭に出る）
  typeInto($(cfg(m.root), '#cfg-in-serialport'), 'COM3')
  await settle()
  assert.equal($(r, 'select').value, 'COM3')
  // 読み直す
  click(buttonByText(r, S.config.portReload))
  assert.equal(calls.ports >= 1, true)
  await m.unmount()
})

test('構成のポート: 候補を返さない古いサーバー・候補が 0 件・読めない、のどれでも手入力でき、理由を出す', async () => {
  for (const [serialports, want] of [
    [{ items: null, status: 'unsupported', error: null }, S.config.portUnsupported],
    [{ items: [], at: AT, status: 'ok', error: null }, S.config.portNone],
    [{ items: null, status: 'error', error: { message: 'x' } }, S.config.portFailed],
    [{ items: [], at: AT, status: 'ok', error: null, message: 'serialport を読み込めないので…' }, 'serialport を読み込めないので…'],
  ]) {
    const { p } = props({ serialports })
    const m = await mount(html`<${SettingsTab} ...${p} />`)
    const r = row(cfg(m.root), 'serialport')
    assert.ok(textOf(r).includes(want), want + ': ' + textOf(r))
    assert.equal(!!$(cfg(m.root), '#cfg-in-serialport'), true, '手入力の欄（詳細設定）')
    await m.unmount()
  }
})

test('構成: 接続先をシミュレータにすると、ポートと速度の行を隠して「使いません」と添える', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  const sim = $$(c, 'input[type="radio"]').find((i) => i.value === 'simulator') // value はプロパティ
  fire(sim, 'change')
  await settle()
  assert.equal(row(c, 'serialport'), null)
  assert.equal(row(c, 'serialbaud'), null)
  assert.ok(textOf(row(c, 'mode')).includes(S.config.simulatorNoPort))
  await m.unmount()
})

// 保存は差分を見せる確認ダイアログ。接続に関わる項目が入っていれば「接続し直します（30〜90 秒止まります）」。
// 戻すと落ちるもの: 確かめずに PUT する・接続に関わる項目でも注意を出さない・名前だけの変更でも注意を出す。
test('構成の保存: 差分の確認。名前だけなら接続し直さない。ポートを変えたら「接続し直します（30〜90 秒止まります）」', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  typeInto($(c, '#cfg-in-name'), '電力（東）')
  await settle()
  let dlg = await openSave(m.root)
  assert.ok(dlg, '確認が開く')
  assert.ok(textOf($(m.root, '.diff-table')).includes('電力（東）'))
  assert.equal(has(dlg, S.config.reconnectWarn), false, '名前だけなら接続し直さない')
  click(buttonByText(dlg, S.cancel))
  await settle()

  typeInto($(c, '#cfg-in-serialport'), '/dev/ttyUSB1')
  typeInto($(c, '#cfg-in-expectedMac'), '00:11:22:33:44:55:66:77')
  await settle()
  dlg = await openSave(m.root)
  assert.ok(has(dlg, S.config.reconnectWarn), textOf(dlg))
  assert.ok(textOf($(m.root, '.diff-table')).includes('0011223344556677'))
  fire(dlg, 'submit')
  await settle()
  assert.deepEqual(calls.saveConfig, [{ patch: { name: '電力（東）', serialport: '/dev/ttyUSB1', expectedMac: '0011223344556677' }, rev: 'c1' }])
  await m.unmount()
})

test('構成の保存: 有効を外すと「ポートを閉じ、計測を止めます」。形の外の値は保存の前に止める', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  fire($(c, '#cfg-in-enabled'), 'change')
  await settle()
  const dlg = await openSave(m.root)
  assert.ok(has(dlg, S.config.disableWarn))
  click(buttonByText(dlg, S.cancel))
  await settle()
  typeInto($(c, '#cfg-in-scanDurations'), '1,2')
  await settle()
  assert.equal(await openSave(m.root), null, '確認を開かない')
  assert.ok(textOf(row(c, 'scanDurations')).includes(S.config.errScan(2, 14)))
  assert.deepEqual(calls.saveConfig, [])
  await m.unmount()
})

// 412・409 PORT_IN_USE は API の message をそのまま出す。422 は項目の横に。
test('構成の保存の失敗: 412 は API の message と「読み直す」、409 PORT_IN_USE はポートの横に message、422 は項目の横に', async () => {
  const results = [
    { ok: false, error: { status: 412, code: 'REVISION_MISMATCH', message: '構成はほかの場所で先に変わりました（サーバーの文）' } },
    { ok: false, error: { status: 409, code: 'PORT_IN_USE', message: '/dev/ttyUSB1 は「動力」が使っています（サーバーの文）' } },
    { ok: false, error: { status: 422, code: 'VALIDATION', message: '入力を確かめてください', details: { deviceKey: 'デバイスキーが長すぎます（サーバーの文）' } } },
  ]
  let i = 0
  const { p, calls } = props({ onSaveConfig: async () => results[i++] })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  typeInto($(c, '#cfg-in-serialport'), '/dev/ttyUSB1')
  await settle()
  fire(await openSave(m.root), 'submit')
  await settle()
  assert.ok(has(c, '構成はほかの場所で先に変わりました（サーバーの文）'), textOf(c).slice(0, 300))
  click(buttonByText(c, S.reload))
  await settle()
  assert.equal(calls.reloadConfig, 1)

  typeInto($(c, '#cfg-in-serialport'), '/dev/ttyUSB1')
  await settle()
  fire(await openSave(m.root), 'submit')
  await settle()
  assert.ok(textOf(row(c, 'serialport')).includes('/dev/ttyUSB1 は「動力」が使っています（サーバーの文）'), textOf(row(c, 'serialport')))

  typeInto($(c, '#cfg-in-deviceKey'), 'k1')
  await settle()
  fire(await openSave(m.root), 'submit')
  await settle()
  assert.ok(textOf(row(c, 'deviceKey')).includes('デバイスキーが長すぎます（サーバーの文）'))
  await m.unmount()
})

test('構成の「設定ノードの値に戻す」: 画面かフローで保存した値が無ければ押せない。あれば確かめて DELETE（If-Match）', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.equal(buttonByText(cfg(m.root), S.config.reset), null, '戻す値が無ければボタンを出さない')
  await m.unmount()
  const data = configData('c7', { serialport: { value: '/dev/ttyUSB1', source: 'runtime', runtimeValue: '/dev/ttyUSB1', by: 'web-ui', at: AT } })
  const { p: p2, calls } = props({ config: { status: 'ok', data, error: null } })
  const m2 = await mount(html`<${SettingsTab} ...${p2} />`)
  click(buttonByText(cfg(m2.root), S.config.reset))
  await settle()
  const dlg = $(m2.root, '.dialog-form')
  assert.ok(has(dlg, '30〜90 秒止まります'))
  fire(dlg, 'submit')
  await settle()
  assert.deepEqual(calls.resetConfig, ['c7'])
  await m2.unmount()
})

// readOnly と CONFIG_LOCKED でボタンを止めて理由を出す。CONFIG_LOCKED は構成だけ（運用設定は今までどおり）。
// 戻すと落ちるもの: 構成のボタンを writeReason だけで止める（CONFIG_LOCKED で止まらない）・運用設定まで止める。
test('構成の止め: CONFIG_LOCKED なら構成と認証情報の入力・保存を止めて理由を出し、運用設定の保存は止めない', async () => {
  const reason = 'このサーバーでは画面から構成を変えられません（サーバーの文）'
  const { p } = props({ configWriteReason: reason })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  for (const sel of ['#cfg-in-name', '#cfg-in-enabled', '#cfg-in-serialport']) {
    assert.equal($(c, sel).hasAttribute('disabled'), true, sel)
  }
  assert.equal($(c, 'form.config-form button[type="submit"]').hasAttribute('disabled'), true)
  // 認証情報は欄を開かせない（［入れ直す］を止める）
  assert.equal(buttonByText(credCard(m.root), S.config.credReenter).hasAttribute('disabled'), true)
  assert.equal(buttonByText(credCard(m.root), S.config.credClear).hasAttribute('disabled'), true)
  assert.ok(has(c, reason))
  // 運用設定は止めない
  assert.equal($(m.root, '#in-slowIntervalSec').hasAttribute('disabled'), false)
  await m.unmount()
  // 読み出しのみ（writeReason と configWriteReason の両方に入る）
  const { p: p2 } = props({ writeReason: S.actions.readOnlyReason, configWriteReason: S.actions.readOnlyReason })
  const m2 = await mount(html`<${SettingsTab} ...${p2} />`)
  assert.equal($(cfg(m2.root), '#cfg-in-name').hasAttribute('disabled'), true)
  assert.equal($(m2.root, '#in-slowIntervalSec').hasAttribute('disabled'), true)
  await m2.unmount()
})

// ---- 認証情報 ------------------------------------------------------------------------

// 書き込むだけの欄。値は画面のどこにも出さない（出すのは設定済み・出どころ・PairID）。パスワードは type=password。
// 戻すと落ちるもの: 保存後も入力欄に値を残す・確認ダイアログに値を出す・パスワードを type=text にする。
test('認証情報: 書き込むだけ。パスワードは type=password、確認に値を出さず、保存後は入力欄を空にする', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = await openCred(m.root)
  assert.ok(has(c, S.config.credTitle))
  assert.ok(has(c, '89ABCDEF'), 'PairID')
  assert.ok(has(c, '設定ノード'), '出どころ')
  const idIn = $(c, '#cfg-cred-id')
  const pwIn = $(c, '#cfg-cred-password')
  assert.equal(pwIn.getAttribute('type'), 'password')
  assert.equal(pwIn.getAttribute('autocomplete'), 'new-password')
  assert.equal(idIn.getAttribute('autocomplete'), 'off')
  assert.equal(idIn.hasAttribute('value'), false, '値を属性に持たない')
  typeInto(idIn, ID)
  typeInto(pwIn, PW)
  await settle()
  assert.ok(has(c, S.config.credCount(32, 32)), '桁数だけ出す')
  fire($(c, 'form.cred-form'), 'submit')
  await settle()
  const dlg = $(m.root, '.dialog-form')
  assert.ok(dlg, '確認が開く')
  assert.equal(textOf(dlg).includes(ID) || textOf(dlg).includes(PW), false, '確認に値を出さない')
  fire(dlg, 'submit')
  await settle()
  assert.deepEqual(calls.cred, [{ routeBId: ID, routeBPassword: PW }])
  assert.equal($(c, '#cfg-cred-id'), null, '保存したら欄を閉じる（値を残さない）')
  const all = textOf(m.root) + JSON.stringify($$(m.root, '*').map((e) => e.attributes))
  assert.equal(all.includes(ID) || all.includes(PW), false, '画面のどこにも値が無い')
  await m.unmount()
})

// 認証情報は画面と設定ノードの両方から入れられ、後から入れた方が効く。
// 欄の説明に「ここで保存すると、エディタの設定ノードの値より優先します。エディタで値を変えてデプロイすると、エディタの値が効きます」。
// 環境変数が優先のときの注意は今のまま（1 回だけ）。
// 戻すと落ちるもの: 後勝ちの文を外す・環境変数が優先のときに後勝ちの文で注意を置き換える。
test('認証情報: 欄の説明は後勝ち（ここで保存すると設定ノードの値より優先・エディタで変えてデプロイするとエディタの値）。環境変数の注意は今のまま', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const box = credCard(m.root)
  assert.ok(has(box, S.config.credPrecedence), '後勝ちの文')
  assert.ok(S.config.credPrecedence.includes('ここで保存すると、エディタの設定ノードの値より優先します'))
  assert.ok(S.config.credPrecedence.includes('エディタで値を変えてデプロイすると、エディタの値が効きます'))
  assert.ok(has(box, S.config.credLead), '書き込むだけの説明は残す')
  assert.equal(has(box, S.config.credStateEnv), false, '環境変数が効いていなければ注意は出さない')
  await m.unmount()

  const env = props({ config: { status: 'ok', data: configData('c1', {}, { envOverrides: true, source: '環境変数' }), error: null } })
  const m2 = await mount(html`<${SettingsTab} ...${env.p} />`)
  const box2 = credCard(m2.root)
  assert.ok(has(box2, S.config.credStateEnv), '環境変数の注意は状態の行に')
  assert.equal(textOf(box2).split('環境変数が優先').length - 1, 1, '環境変数の注意は 1 回')
  assert.ok(has(box2, S.config.credPrecedence), '後勝ちの文も残す（エディタとの間の規則）')
  await m2.unmount()
})

test('認証情報: 形の違う値は送らずに理由を出す（理由に値を入れない）。環境変数が優先されるなら注意。「画面の値を消す」は確かめて DELETE', async () => {
  const data = configData('c1', {}, { envOverrides: true, source: '環境変数' })
  // サーバー（lib/runtime/view-model.js の buildConfig）は Config.warnings にも同じ注意を入れる。認証情報の欄の 1 回だけにする
  data.warnings = ['B ルート認証情報は環境変数が優先されるので、画面かフローで保存しても効きません', 'ほかの注意（サーバーの文）']
  const { p, calls } = props({ config: { status: 'ok', data, error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.ok(has(cfg(m.root), 'ほかの注意（サーバーの文）'), 'ほかの warnings は出す')
  assert.equal(has(cfg(m.root), '環境変数が優先'), false, 'Config.warnings の同じ注意は、接続のカードに出さない')
  const c = await openCred(m.root)
  assert.ok(has(c, S.config.credStateEnv))
  assert.equal(textOf(c).split('環境変数が優先').length - 1, 1, '環境変数の注意は 1 回')
  typeInto($(c, '#cfg-cred-id'), '0123')
  typeInto($(c, '#cfg-cred-password'), PW)
  await settle()
  fire($(c, 'form.cred-form'), 'submit')
  await settle()
  assert.equal(!!$(m.root, '.dialog-form'), false, '確認を開かない')
  assert.ok(has(c, S.config.credIdInvalid))
  assert.equal(has(c, PW), false)
  assert.deepEqual(calls.cred, [])

  click(buttonByText($(c, '.cred-form'), S.config.credClear))
  await settle()
  const dlg = $(m.root, '.dialog-form')
  assert.ok(has(dlg, S.config.credClearBody))
  fire(dlg, 'submit')
  await settle()
  assert.equal(calls.clear, 1)
  await m.unmount()
})

// 32 桁でも 16 進でない英字（G〜Z）を含む ID は、確認「接続し直します」を開かずに欄の下で断る（サーバーは 422 で断る）。
// 戻すと落ちるもの: 画面の検証を「32 桁の英数字」に戻す（確認が開き、送ってから断られる）・案内を「英数字」に戻す。
test('認証情報: 16 進でない英字を含む 32 桁の ID は、確認を開かずに「16 進数」の理由を出す', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  // 落ちたときも外す（描いた部品とその購読を、あとの試験に残さない）
  try {
    const c = await openCred(m.root)
    assert.ok(has($(c, '#cfg-cred-id-hint'), S.config.credIdHint))
    assert.ok(has($(c, '#cfg-cred-id-hint'), '16 進数'), '欄の案内も 16 進数')
    typeInto($(c, '#cfg-cred-id'), 'G' + ID.slice(1))
    typeInto($(c, '#cfg-cred-password'), PW)
    await settle()
    fire($(c, 'form.cred-form'), 'submit')
    await settle()
    // 要素を assert にそのまま渡さない（落ちたとき DOM 全体をたどって終わらない。test/ui/fake-dom.mjs の頭）
    assert.equal(!!$(m.root, '.dialog-form'), false, '確認を開かない')
    assert.ok(has(c, S.config.credIdInvalid))
    assert.ok(has(c, '16 進数'))
    assert.equal($(c, '#cfg-cred-id').getAttribute('aria-invalid'), 'true')
    assert.deepEqual(calls.cred, [])
  } finally {
    await m.unmount()
  }
})

// サーバーの Config の印: locked（uiConfig: false。lockedReason）・applying（開き直しの最中）・credentials.stored（画面かフローで保存した値）。
// 戻すと落ちるもの: Config.locked を見ない（CONFIG_LOCKED の 403 を受けるまで押せる）・stored が null でも「画面の値を消す」を押せる。
test('構成: Config.locked なら止めて lockedReason を出す。applying なら「接続し直しています」。stored が無ければ「画面の値を消す」を押せない', async () => {
  const locked = configData('c1')
  locked.locked = true
  locked.lockedReason = '画面から構成を変えられません（サーバーの文）'
  const { p } = props({ config: { status: 'ok', data: locked, error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.equal($(cfg(m.root), '#cfg-in-name').hasAttribute('disabled'), true)
  assert.ok(has(cfg(m.root), '画面から構成を変えられません（サーバーの文）'))
  await m.unmount()

  const busy = configData('c1', {}, { stored: null })
  busy.applying = true
  const { p: p2 } = props({ config: { status: 'ok', data: busy, error: null } })
  const m2 = await mount(html`<${SettingsTab} ...${p2} />`)
  assert.ok(has(cfg(m2.root), S.config.applying))
  assert.equal(buttonByText(credCard(m2.root), S.config.credClear), null, '消すものが無ければボタンを出さない')
  const storedRow = $$(credCard(m2.root), 'tr').find((tr) => textOf($(tr, 'th')) === S.config.credStored)
  assert.equal(textOf($(storedRow, 'td')), S.config.credStoredNo)
  await m2.unmount()

  const saved = configData('c1', {}, { stored: { by: 'flow:認証の入力', at: AT }, source: '画面かフロー' })
  const { p: p3 } = props({ config: { status: 'ok', data: saved, error: null } })
  const m3 = await mount(html`<${SettingsTab} ...${p3} />`)
  assert.equal(buttonByText(credCard(m3.root), S.config.credClear).hasAttribute('disabled'), false)
  assert.ok(has(credCard(m3.root), S.config.credStoredYes('フロー（認証の入力）', AT_TEXT)), textOf(credCard(m3.root)))
  await m3.unmount()
})

// ---- 古いサーバー・読み込み中・失敗 ---------------------------------------------------------------

// 構成の API が無いサーバー（404 NOT_FOUND）では、今までの「構成（読むだけ）」に戻る（壊れない）。
test('構成: 古いサーバー（unsupported）は「構成（読むだけ）」と「エディタで開く」。読み込み中・失敗も出し分ける', async () => {
  const { p } = props({ config: { status: 'unsupported', data: null, error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.ok(has(m.root, S.settings.configTitle))
  assert.ok(has(m.root, S.settings.configLead))
  assert.equal(!!$(m.root, '#cfg-cred-id'), false, '認証情報の入力欄は出さない')
  assert.equal($(m.root, 'a[target="_blank"]').getAttribute('href'), 'http://h/#node/n1')
  await m.unmount()

  const { p: p2 } = props({ config: { status: 'loading', data: null, error: null } })
  const m2 = await mount(html`<${SettingsTab} ...${p2} />`)
  assert.ok(textOf(cfg(m2.root)).includes(S.loading))
  await m2.unmount()

  const { p: p3, calls } = props({ config: { status: 'error', data: null, error: { message: '構成を読めません（サーバーの文）' } } })
  const m3 = await mount(html`<${SettingsTab} ...${p3} />`)
  assert.ok(has(m3.root, S.config.loadFailed))
  assert.ok(has(m3.root, '構成を読めません（サーバーの文）'))
  click(buttonByText(cfg(m3.root), S.retry))
  assert.equal(calls.reloadConfig, 1)
  await m3.unmount()
})

// 下書きの規則（運用設定と同じ）: 手で変えた項目は残し、触っていない項目はサーバーの新しい値に付いていく。
test('構成の下書き: 手で変えた項目は残し、触っていない項目は新しい値に付いていく（rev が変わったら知らせる）', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = () => cfg(m.root)
  typeInto($(c(), '#cfg-in-name'), '手で変えた名前')
  await settle()
  const next = configData('c2', { role: { value: '動力', source: 'runtime', runtimeValue: '動力', by: 'flow:x', at: AT } })
  await m.rerender(html`<${SettingsTab} ...${Object.assign({}, p, { config: { status: 'ok', data: next, error: null } })} />`)
  assert.equal($(c(), '#cfg-in-name').value, '手で変えた名前')
  assert.equal($(c(), '#cfg-in-role').value, '動力')
  assert.ok(has(c(), S.config.updatedElsewhere))
  await m.unmount()
})

// ---- 誤りのフォーカス（入力中の欄を奪わない・画面の上から見て最初の誤りの欄へ） -------------------------

const activeId = () => (document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('id') : null)
const moreOf = (root, card) => $(root, `details.more[data-card="${card}"]`)
/** 本物の tier（積算と定時積算は詳細設定）。 */
function tieredSettings() {
  const d = settingsData()
  for (const n of ['pollIntervalSec', 'pollEpcs']) d.fields[n].tier = 'basic'
  for (const n of ['slowIntervalSec', 'halfHourIntervalSec']) d.fields[n].tier = 'advanced'
  return d
}
const ADV = { tier: 'advanced' }
const tieredConfig = (extra = {}) => configData('c1', Object.assign({ enabled: ADV, autoStart: ADV, serialbaud: ADV, deviceKey: ADV, expectedMac: ADV, scanDurations: ADV }, extra))
const pickRole = async (root, v) => {
  const sel = $(root, '#cfg-in-role')
  sel.value = v
  fire(sel, 'change')
  await settle()
}

// 実ブラウザで再現した: 積算と定時積算を両方誤りにして保存 → 定時積算の欄で 1800 と打つと、途中でフォーカスが積算の欄へ飛び、
// 次のキーがそちらへ入って 10 になった。
// 戻すと落ちるもの: forceOpen に誤りの欄の一覧を入れる・同じ印でもう一度動かす
test('誤りが 1 つ減っても、入力中の欄からフォーカスが動かない。直した欄をまた誤りにしても動かない（計測のカード）', async () => {
  const { p } = props({ settings: { status: 'ok', data: tieredSettings(), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  typeInto($(m.root, '#in-slowIntervalSec'), '1')
  await settle()
  typeInto($(m.root, '#in-halfHourIntervalSec'), '1')
  await settle()
  fire($(m.root, 'form.measure-form'), 'submit')
  assert.ok(await until(() => activeId() === 'in-slowIntervalSec'), '最初の誤りの欄へ: ' + activeId())
  assert.equal(moreOf(m.root, 'measure').hasAttribute('open'), true, '閉じた詳細設定を開く')

  $(m.root, '#in-halfHourIntervalSec').focus()
  typeInto($(m.root, '#in-halfHourIntervalSec'), '1800')
  await settle(2)
  assert.equal(activeId(), 'in-halfHourIntervalSec', '入力中の欄のまま')
  typeInto($(m.root, '#in-slowIntervalSec'), '300')
  await settle(2)
  assert.equal(activeId(), 'in-halfHourIntervalSec', '誤りが全部消えても動かない')
  typeInto($(m.root, '#in-slowIntervalSec'), '1')
  await settle(2)
  assert.equal(activeId(), 'in-halfHourIntervalSec', '別の欄をまた誤りにしても動かない')

  // 次の保存の試みでは、また最初の誤りの欄へ
  fire($(m.root, 'form.measure-form'), 'submit')
  assert.ok(await until(() => activeId() === 'in-slowIntervalSec'), String(activeId()))
  await m.unmount()
})

test('誤りが 1 つ減っても、入力中の欄からフォーカスが動かない（接続のカード）', async () => {
  const { p } = props({ config: { status: 'ok', data: tieredConfig(), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  typeInto($(m.root, '#cfg-in-expectedMac'), 'xx')
  typeInto($(m.root, '#cfg-in-scanDurations'), 'x')
  await settle()
  fire($(m.root, 'form.config-form'), 'submit')
  await settle(3)
  assert.equal(activeId(), 'cfg-in-expectedMac')
  $(m.root, '#cfg-in-scanDurations').focus()
  typeInto($(m.root, '#cfg-in-scanDurations'), '4,5')
  await settle(2)
  assert.equal(activeId(), 'cfg-in-scanDurations', '入力中の欄のまま')
  await m.unmount()
})

// 戻すと落ちるもの: inputId が「その他」を見ない → select へ行き、文字の欄に入れられない
test('契約を「その他」のまま空で保存すると、文字の欄へフォーカスする', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  await pickRole(m.root, ROLE_OTHER)
  fire($(m.root, 'form.config-form'), 'submit')
  await settle(2)
  assert.ok(textOf(row(m.root, 'role')).length > 0)
  assert.ok($(row(m.root, 'role'), '.field-error'))
  assert.equal(activeId(), 'cfg-in-role-other')
  await m.unmount()
})

// 実ブラウザで再現した: 誤りの文は基本設定のポートの行に出るのに、詳細設定が開いて手入力の欄へ飛んでいた。
// 戻すと落ちるもの: advErrors に serialport を足す
test('409 PORT_IN_USE: 詳細設定を開かず、誤りの文のある基本設定のポートの欄へ', async () => {
  const { p } = props({
    config: { status: 'ok', data: tieredConfig(), error: null },
    onSaveConfig: async () => ({ ok: false, error: { status: 409, code: 'PORT_IN_USE', message: 'このポートは「動力」が使っています（サーバーの文）' } }),
  })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const pick = $(m.root, '#cfg-in-serialport-pick')
  pick.value = '/dev/ttyUSB1'
  fire(pick, 'change')
  await settle()
  fire(await openSave(m.root), 'submit')
  await settle(3)
  assert.ok(textOf(row(m.root, 'serialport')).includes('このポートは「動力」が使っています（サーバーの文）'))
  assert.equal(moreOf(m.root, 'connection').hasAttribute('open'), false, '詳細設定は開かない')
  assert.equal(activeId(), 'cfg-in-serialport-pick')
  await m.unmount()
})

// 戻すと落ちるもの: 詳細設定の onOpened が advErrors[0] へフォーカスする（基本設定の誤りが先でも詳細設定へ飛ぶ）
test('基本設定と詳細設定の両方に誤りがあるときは、詳細設定を開いて基本設定の最初の誤りの欄へ', async () => {
  const { p } = props({ config: { status: 'ok', data: tieredConfig(), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  await pickRole(m.root, ROLE_OTHER)
  typeInto($(m.root, '#cfg-in-scanDurations'), 'x')
  await settle()
  fire($(m.root, 'form.config-form'), 'submit')
  await settle(3)
  assert.equal(moreOf(m.root, 'connection').hasAttribute('open'), true)
  assert.equal(activeId(), 'cfg-in-role-other')
  await m.unmount()
})

// 開いている詳細設定では MoreDetails は何もしないので、フォーカスは保存を試みた呼び手が動かす。
// 戻すと落ちるもの: config-section.js の errTick の effect を外す
test('422: 開いている詳細設定の欄へ、確認ダイアログが閉じたあとにフォーカスする', async () => {
  const storage = { get: (k) => (k === 'wsuha-broute:more:connection' ? '1' : null), set() {} }
  const { p } = props({
    storage,
    config: { status: 'ok', data: tieredConfig(), error: null },
    onSaveConfig: async () => ({ ok: false, error: { status: 422, message: '入力を確かめてください', details: { deviceKey: 'デバイスキーが長すぎます（サーバーの文）' } } }),
  })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.equal(moreOf(m.root, 'connection').hasAttribute('open'), true)
  typeInto($(m.root, '#cfg-in-deviceKey'), 'k1')
  await settle()
  fire(await openSave(m.root), 'submit')
  await settle(3)
  assert.equal(activeId(), 'cfg-in-deviceKey')
  await m.unmount()
})

test('422 で閉じた詳細設定を開いて、その欄へ（計測のカードの基本設定の欄も）', async () => {
  const results = [
    { ok: false, error: { status: 422, message: '入力を確かめてください', details: { slowIntervalSec: '範囲の外です（サーバーの文）' } } },
    { ok: false, error: { status: 422, message: '入力を確かめてください', details: { pollIntervalSec: '範囲の外です（サーバーの文）' } } },
  ]
  let i = 0
  const { p } = props({ settings: { status: 'ok', data: tieredSettings(), error: null }, onSaveSettings: async () => results[i++] })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const save = async () => {
    fire($(m.root, 'form.measure-form'), 'submit')
    await settle(2)
    fire($(m.root, '.dialog-form'), 'submit')
    await settle(3)
  }
  typeInto($(m.root, '#in-slowIntervalSec'), '301')
  await settle()
  await save()
  assert.equal(moreOf(m.root, 'measure').hasAttribute('open'), true)
  assert.equal(activeId(), 'in-slowIntervalSec')
  typeInto($(m.root, '#in-pollIntervalSec'), '31')
  await settle()
  await save()
  assert.equal(activeId(), 'in-pollIntervalSec')
  await m.unmount()
})

// 戻すと落ちるもの: span（lbl-pollEpcs）へフォーカスする。偽の DOM もブラウザと同じく、span には当たらない
test('定期的に取りに行く値を全部外して保存すると、最初の押せるチェックへフォーカスする', async () => {
  const { p } = props({ settings: { status: 'ok', data: tieredSettings(), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const first = () => $(row(m.root, 'pollEpcs'), 'input:not([disabled])')
  fire($(row(m.root, 'pollEpcs'), '.epc-opt[data-epc="E7"] input'), 'change')
  await settle()
  fire($(m.root, 'form.measure-form'), 'submit')
  assert.ok(await until(() => document.activeElement === first()), String(activeId()))
  assert.ok($(row(m.root, 'pollEpcs'), '.field-error'))
  await m.unmount()
})

test('認証情報の 422: 確認ダイアログが閉じたあと、誤りの欄へフォーカスする', async () => {
  const { p } = props({ onSaveCredentials: async () => ({ ok: false, error: { status: 422, message: '入力を確かめてください', details: { routeBPassword: 'パスワードの形が違います（サーバーの文）' } } }) })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = await openCred(m.root)
  typeInto($(c, '#cfg-cred-id'), ID)
  typeInto($(c, '#cfg-cred-password'), PW)
  await settle()
  fire($(c, 'form.cred-form'), 'submit')
  await settle(2)
  fire($(m.root, 'section[data-card="credentials"] .dialog-form'), 'submit')
  await settle(3)
  assert.ok(textOf(c).includes('パスワードの形が違います（サーバーの文）'))
  assert.equal(activeId(), 'cfg-cred-password')
  await m.unmount()
})

// ---- 認証の欄の開閉 -----------------------------------------------------------------------------

const withCred = (cred) => ({ status: 'ok', data: configData('c1', {}, cred), error: null })

// 戻すと落ちるもの: open を mount のときだけ決める → 未設定なのに［入れ直す］しか出ない
test('認証の欄: 保存した値を消して未設定になったら開く。設定済みに戻しても入力中の欄は閉じない', async () => {
  const { p } = props({ config: withCred({ configured: true, stored: { by: 'web-ui', at: AT } }) })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.equal(!!$(m.root, '#cfg-cred-id'), false, '設定済みなら閉じておく')
  await m.rerender(html`<${SettingsTab} ...${Object.assign({}, p, { config: withCred({ configured: false, source: null, pairId: null, stored: null }) })} />`)
  await settle(2)
  assert.ok($(m.root, '#cfg-cred-id'), '未設定なら開く')
  assert.equal(!!buttonByText(m.root, S.config.credReenter), false)
  assert.equal(!!buttonByText(m.root, S.config.credCancel), false, '未設定の台は閉じられない')
  await m.unmount()
})

// 戻すと落ちるもの: ［やめる］で入力を消さない
test('認証の欄: ［入れ直す］で開いたら［やめる］で閉じられ、入れかけた値を残さない', async () => {
  const { p, calls } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  await openCred(m.root)
  typeInto($(m.root, '#cfg-cred-id'), ID)
  await settle()
  click(buttonByText(m.root, S.config.credCancel))
  await settle()
  assert.equal(!!$(m.root, '#cfg-cred-id'), false)
  assert.equal(textOf(credCard(m.root)).includes(ID), false)
  assert.ok(has($(credCard(m.root), '.save-bar'), S.config.noChanges), '入力の桁数も忘れる（「変更があります」を残さない）')
  await openCred(m.root)
  assert.equal($(m.root, '#cfg-cred-id').value, '', '開き直しても空')
  assert.ok(has(credCard(m.root), S.config.credCount(0, 32)), '桁数も 0 から')
  assert.deepEqual(calls.cred, [])
  await m.unmount()
})

// ---- ポートの select ----------------------------------------------------------------------------

// 実機が動いている台で「見つかりません」と出ると、アダプタが抜けたと誤解する。
// 戻すと落ちるもの: form-parts.js が候補を読めているかを見ない
test('ポート: 候補を読めていない間は「見つかりません」と言わず今の値を出す。読めて候補に無いときだけ言う', async () => {
  const opt = (root) => $$(root, '#cfg-in-serialport-pick option').find((o) => o.value === '/dev/ttyS9')
  const cfgWith = { status: 'ok', data: configData('c1', { serialport: { value: '/dev/ttyS9', configValue: '/dev/ttyS9' } }), error: null }
  for (const sp of [{ items: null, status: 'loading' }, { items: null, status: 'error', error: { message: 'x' } }, { items: null, status: 'unsupported' }]) {
    const { p } = props({ config: cfgWith, serialports: sp })
    const m = await mount(html`<${SettingsTab} ...${p} />`)
    assert.ok(opt(m.root), sp.status)
    assert.equal(textOf(opt(m.root)), '/dev/ttyS9', sp.status)
    assert.equal(opt(m.root).hasAttribute('data-missing'), false, sp.status)
    await m.unmount()
  }
  const { p } = props({ config: cfgWith, serialports: { items: [], status: 'ok', at: AT } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.equal(textOf(opt(m.root)), S.config.portMissing('/dev/ttyS9'))
  await m.unmount()
})

// 戻すと落ちるもの: form-parts.js の portNote で sp.message を見ない・PortSelect で sp.message のときも「見つかりません」と言う
test('ポート: serialport が無いサーバーでは入れ方を出し、「見つかりません」と言わない', async () => {
  const message = 'serialport を読み込めないので、ポートの候補を出せません。'
  const opt = (root) => $$(root, '#cfg-in-serialport-pick option').find((o) => o.value === '/dev/ttyS9')
  const cfgWith = { status: 'ok', data: configData('c1', { serialport: { value: '/dev/ttyS9', configValue: '/dev/ttyS9' } }), error: null }
  const { p } = props({ config: cfgWith, serialports: { items: [], status: 'ok', at: AT, message } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.equal(textOf($(m.root, '.port-note')), message + S.config.portManualHint, '手で入力する先も案内する（欄は閉じた詳細設定の中にある）')
  assert.equal(textOf(opt(m.root)), '/dev/ttyS9')
  assert.equal(opt(m.root).hasAttribute('data-missing'), false)
  await m.unmount()
})

// 戻すと落ちるもの: config-section.js と tab-settings.js で、出どころと誤りを別々に足す（同じ項目が 2 件になる）
test('詳細設定の「n 件の注意」は項目の数。同じ項目に出どころと誤りの両方があっても 1 件', async () => {
  const held = { value: 'usb9', source: 'runtime', runtimeValue: 'usb9', by: 'web-ui', at: AT - 60000, tier: 'advanced' }
  const { p } = props({ config: { status: 'ok', data: configData('c1', { deviceKey: held }), error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const c = cfg(m.root)
  const notes = () => textOf($(c, '.more-notes'))
  assert.equal(notes(), S.more.notes(1), '出どころだけ')
  typeInto($(c, '#cfg-in-deviceKey'), '!!!')
  await settle()
  await openSave(m.root)
  assert.ok(textOf(row(c, 'deviceKey')).includes(S.config.errDeviceKey), textOf(row(c, 'deviceKey')))
  assert.equal(notes(), S.more.notes(1), '同じ項目の誤りは数え足さない')
  await m.unmount()
})

test('計測のカードの「n 件の注意」も項目の数', async () => {
  const data = settingsData()
  Object.assign(data.fields.slowIntervalSec, { source: 'runtime', runtimeValue: 300, by: 'web-ui', at: AT - 60000, tier: 'advanced' })
  const { p } = props({ settings: { status: 'ok', data, error: null } })
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  const card = $(m.root, 'form.measure-form')
  assert.equal(textOf($(card, '.more-notes')), S.more.notes(1), '出どころだけ')
  typeInto($(m.root, '#in-slowIntervalSec'), '1')
  await settle()
  fire(card, 'submit')
  await settle()
  assert.equal($(m.root, '#in-slowIntervalSec').getAttribute('aria-invalid'), 'true', '誤りが出ている')
  assert.equal(textOf($(card, '.more-notes')), S.more.notes(1), '同じ項目の誤りは数え足さない')
  await m.unmount()
})

// ---- 契約の select ------------------------------------------------------------------------------

// 戻すと落ちるもの: RoleSelect を datalist に戻す（Chrome は今の値に合う候補しか出さず、動力を選べない）
test('契約の select: 電力の台で動力に変えると差分「電力 → 動力」。「高圧」で開くと「その他」で欄に今の値', async () => {
  const { p } = props()
  const m = await mount(html`<${SettingsTab} ...${p} />`)
  assert.ok($$(m.root, '#cfg-in-role option').some((o) => o.value === '動力'))
  await pickRole(m.root, '動力')
  const form = await openSave(m.root)
  const diff = $$(form, '.diff-table tbody tr').find((r) => textOf($(r, 'th')) === S.config.fields.role)
  assert.ok(diff, textOf(form))
  assert.deepEqual($$(diff, 'td').map(textOf), ['電力', '動力'])
  await m.unmount()

  const c = props({ config: { status: 'ok', data: configData('c1', { role: { value: '高圧', configValue: '高圧' } }), error: null } })
  const m2 = await mount(html`<${SettingsTab} ...${c.p} />`)
  assert.equal($(m2.root, '#cfg-in-role').value, ROLE_OTHER)
  assert.equal($(m2.root, '#cfg-in-role-other').value, '高圧')
  await m2.unmount()
})
