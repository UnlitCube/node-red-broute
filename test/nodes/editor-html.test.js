'use strict'

// エディタの編集画面（nodes/wsuha-device.html の <script>）を、偽の RED と偽の jQuery で動かす。
// 5 分 / 30 分の間隔の欄の検証・運用設定が効いている項目の表示・「Web UI で開く」は httpNodeRoot から。
// 本物のエディタ（ブラウザ）では動かしていない。DOM は値と表示の有無だけを持つ偽物。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { FAIL, makeJq: makeJqOf, makeTabs, elementOf, unknownFa } = require('./editor-kit')

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-device.html'), 'utf8').replace(/\r\n/g, '\n')
const TEMPLATE = HTML.slice(HTML.indexOf('data-template-name="wsuha-device"'), HTML.indexOf('data-help-name="wsuha-device"'))
const HELP = HTML.slice(HTML.indexOf('data-help-name="wsuha-device"'))

/** 偽の jQuery。テンプレートで隠してある要素は隠した状態で始める。 */
const makeJq = (json) => makeJqOf(json, { html: TEMPLATE })

/**
 * エディタに届く検証の範囲（RED.settings.wsuhaDeviceRanges）。本物は nodes/wsuha-device.js の editorRanges で、
 * settings-store の FIELDS と config-fields の CONFIG_FIELDS から作る。ここも同じ所から作り、数字を直書きしない。
 */
function realRanges() {
  const cf = require('../../lib/runtime/config-fields')
  const { FIELDS } = require('../../lib/runtime/settings-store')
  const sec = (f) => ({ min: f.min, max: f.max, default: f.default })
  return {
    pollIntervalSec: sec(FIELDS.pollIntervalSec),
    slowIntervalSec: sec(FIELDS.slowIntervalSec),
    halfHourIntervalSec: sec(FIELDS.halfHourIntervalSec),
    pollEpcs: { min: FIELDS.pollEpcs.min || 1, max: FIELDS.pollEpcs.max || 6, bulky: ['E2', 'E4', 'EC'] },
    name: { maxLength: cf.CONFIG_FIELDS.name.maxLength },
    role: { maxLength: cf.CONFIG_FIELDS.role.maxLength },
    deviceKey: { maxLength: cf.CONFIG_FIELDS.deviceKey.maxLength },
    bauds: cf.CONFIG_FIELDS.serialbaud.values,
    defaultBaud: cf.CONFIG_FIELDS.serialbaud.default,
  }
}

function loadDef(settings, others) {
  const m = HTML.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)
  assert.ok(m, '<script> がある')
  let def = null
  const tabs = makeTabs()
  const RED = {
    settings: Object.assign({ wsuhaDeviceRanges: realRanges() }, settings || {}),
    validators: { number: () => () => true },
    tabs: { create: tabs.create },
    nodes: {
      registerType(name, d) {
        assert.equal(name, 'wsuha-device')
        def = d
      },
      eachConfig(fn) {
        for (const n of others || []) fn(n)
      },
    },
  }
  return { RED, tabs, run: ($) => new Function('RED', '$', m[1])(RED, $), get def() {
    return def
  } }
}

const SETTINGS = {
  rev: 'r1',
  warnings: [],
  fields: {
    pollIntervalSec: { value: 30, source: 'config', configValue: 30, default: 30, unit: '秒', by: null, at: null },
    pollEpcs: { value: ['0xE7', '0xE8'], source: 'runtime', configValue: ['0xE7'], default: ['0xE7'], by: 'flow:記録用', at: 1793900000000 },
    slowIntervalSec: { value: 600, source: 'runtime', configValue: null, default: 300, unit: '秒', by: 'web-ui', at: 1793900000000 },
    halfHourIntervalSec: { value: 900, source: 'override', configValue: null, default: 1800, unit: '秒', by: null, at: null },
  },
}

/**
 * エディタに届く RED.settings を、本物（@node-red/runtime/lib/api/settings.js の getRuntimeSettings）と同じ形にする。
 *   httpNodeRoot: runtime.settings.httpNodeRoot || '/'   … false でも '/' が届く
 *   wsuhaDeviceWebUi: registerType の settings（exportable）の値
 */
function editorSettings(serverHttpNodeRoot, webUi) {
  const s = { httpNodeRoot: serverHttpNodeRoot || '/' }
  if (webUi !== undefined) s.wsuhaDeviceWebUi = webUi
  return s
}

function openEditor(httpNodeRoot, settingsResponse, webUi) {
  const l = loadDef(editorSettings(httpNodeRoot, webUi))
  const jq = makeJq((url) => {
    if (url === 'wsuha-broute/serialports') return { items: [], serialportMessage: null }
    if (url === 'wsuha-broute/device/' + encodeURIComponent('dev 1') + '/settings') return settingsResponse
    return undefined
  })
  l.run(jq.$)
  const node = { id: 'dev 1', enabled: true }
  l.def.oneditprepare.call(node)
  return { def: l.def, jq }
}

test('5 分 / 30 分の間隔の欄: 空か範囲の中の整数だけを通す（運用設定の検証と同じ範囲）', () => {
  const l = loadDef({})
  l.run(makeJq(() => undefined).$)
  const slow = l.def.defaults.slowIntervalSec
  const half = l.def.defaults.halfHourIntervalSec
  assert.equal(slow.value, '', '既定は空（= 300 秒）')
  assert.equal(half.value, '')
  for (const [v, want] of [['', true], [undefined, true], [null, true], [' ', true], ['60', true], ['3600', true], [600, true], ['59', false], ['3601', false], ['1.5', false], ['abc', false]]) {
    assert.equal(slow.validate(v), want, `slow ${JSON.stringify(v)}`)
  }
  for (const [v, want] of [['', true], ['300', true], ['7200', true], ['299', false], ['7201', false]]) {
    assert.equal(half.validate(v), want, `halfHour ${JSON.stringify(v)}`)
  }
})

test('取得間隔・定期取得の EPC の欄: 画面とフローの検証と同じ範囲だけを通す', () => {
  // 1.x のままだと、取得間隔は RED.validators.number() だけ（5 や 99999 が通る）、EPC は検証なし（E2・EC・7 個が通る）。
  // 戻すと落ちるもの: wsuha-device.html の pollInterval・pollEpcs の validate を 1.x の形に戻す
  const l = loadDef({})
  l.run(makeJq(() => undefined).$)
  const iv = l.def.defaults.pollInterval
  const ep = l.def.defaults.pollEpcs
  assert.equal(iv.value, 30)
  assert.equal(ep.value, 'E7, E8', '既定は瞬時電力と瞬時電流')
  for (const [v, want] of [['', true], [undefined, true], [15, true], ['15', true], [30, true], ['3600', true], [' 60 ', true],
    ['14', false], [5, false], ['3601', false], [99999, false], ['1.5', false], ['abc', false], ['-30', false]]) {
    assert.equal(iv.validate(v), want, `pollInterval ${JSON.stringify(v)}`)
  }
  for (const [v, want] of [['', true], [undefined, true], ['E7', true], ['E7, E8', true], ['e7,e8', true], ['0xE7 0xE8', true],
    ['E7, E8, E0, E3, D3, E1', true], ['E7, E7, E8', true], ['E7,,E8', true],
    ['E2', false], ['E7, EC', false], ['e4', false], ['0xE2', false], ['E7, E8, E0, E3, D3, E1, EA', false],
    ['ZZ', false], ['E7;E8', false], ['123', false], ['7', false]]) {
    assert.equal(ep.validate(v), want, `pollEpcs ${JSON.stringify(v)}`)
  }
})

test('編集画面を開くと、運用設定が効いている項目にその値と「ここで値を変えてデプロイすると…」を出す', () => {
  const { jq } = openEditor('/', SETTINGS)
  assert.ok(jq.calls.includes('wsuha-broute/device/dev%201/settings'), jq.calls.join(' | '))
  const slow = jq.get('#wsuha-rt-slowIntervalSec')
  assert.equal(slow.visible, true)
  assert.match(slow.textAll, /運用設定が効いています: 600 秒/)
  assert.match(slow.textAll, /Web UI/)
  assert.match(slow.textAll, /ここで値を変えてデプロイすると、この項目の運用設定は外れます/)
  const epcs = jq.get('#wsuha-rt-pollEpcs')
  assert.equal(epcs.visible, true)
  assert.match(epcs.textAll, /E7, E8/)
  assert.match(epcs.textAll, /フロー（記録用）/)
  assert.equal(jq.get('#wsuha-rt-pollIntervalSec').visible, false, '設定ノードの値のままの項目には出さない')
  const half = jq.get('#wsuha-rt-halfHourIntervalSec')
  assert.equal(half.visible, true)
  assert.match(half.textAll, /一時的な上書き/)
})

test('一時的な上書きが掛かった項目に運用設定もあれば、その値（runtimeValue）と変えた人・時刻、「ここで値を変えてデプロイすると…」を出す', () => {
  // 上書きの下にある運用設定は、エディタで値を変えてデプロイすると外れるのに、前は何も出さなかった。
  // 戻すと落ちるもの: wsuha-device.html の override の分岐で runtimeValue を見ない
  const at = 1793900000000
  const s = JSON.parse(JSON.stringify(SETTINGS))
  s.fields.pollIntervalSec = { value: 90, source: 'override', runtimeValue: 60, configValue: 30, default: 30, unit: '秒', by: 'flow:記録用', at }
  s.fields.pollEpcs = { value: ['0xE7'], source: 'override', runtimeValue: ['0xE7', '0xE8'], configValue: ['0xE7'], default: ['0xE7'], by: 'web-ui', at }
  s.fields.halfHourIntervalSec = { value: 900, source: 'override', runtimeValue: null, configValue: null, default: 1800, unit: '秒', by: null, at: null }
  const { jq } = openEditor('/', s)

  const iv = jq.get('#wsuha-rt-pollIntervalSec')
  assert.equal(iv.visible, true)
  assert.match(iv.textAll, /一時的な上書き/)
  assert.match(iv.textAll, /90 秒/)
  assert.match(iv.textAll, /運用設定[^。]*60 秒/, iv.textAll)
  assert.match(iv.textAll, /フロー（記録用）/)
  assert.ok(iv.textAll.includes(new Date(at).toLocaleString()), '変えた時刻')
  assert.match(iv.textAll, /ここで値を変えてデプロイすると、この項目の運用設定は外れます/)

  const ep = jq.get('#wsuha-rt-pollEpcs')
  assert.match(ep.textAll, /運用設定[^。]*E7, E8/, ep.textAll)
  assert.match(ep.textAll, /Web UI/)
  assert.match(ep.textAll, /ここで値を変えてデプロイすると、この項目の運用設定は外れます/)

  // 運用設定の無い上書きには「運用設定は外れます」を出さない（外れるものが無い）
  const half = jq.get('#wsuha-rt-halfHourIntervalSec')
  assert.equal(half.visible, true)
  assert.match(half.textAll, /一時的な上書き/)
  assert.ok(!/運用設定/.test(half.textAll), half.textAll)
})

test('「Web UI で開く」は RED.settings.httpNodeRoot から作る（無ければ /）', () => {
  const up = { available: true, reason: null }
  for (const [root, webUi, href] of [
    ['/', up, '/wsuha-broute/ui/#/adapters/dev%201'],
    [undefined, up, '/wsuha-broute/ui/#/adapters/dev%201'],
    ['/api', up, '/api/wsuha-broute/ui/#/adapters/dev%201'],
    ['/api/', up, '/api/wsuha-broute/ui/#/adapters/dev%201'],
    ['/', undefined, '/wsuha-broute/ui/#/adapters/dev%201'], // 古いサーバー（載せたかどうかが届かない）は今までどおり出す
  ]) {
    const { jq } = openEditor(root, undefined, webUi)
    assert.equal(jq.get('#wsuha-open-ui').attrs.href, href, String(root))
    assert.equal(jq.get('#wsuha-open-ui').visible, true)
  }
})

test('「Web UI で開く」: 画面を載せていないサーバー（httpNodeRoot: false・wsuhaBroute.ui: false）では隠して理由を出す', () => {
  // 本物のエディタには httpNodeRoot: false が '/' として届くので、httpNodeRoot だけでは分からない。
  // 設定ノードが registerType の settings（wsuhaDeviceWebUi）で、画面を載せたかどうかを渡す。
  // 戻すと落ちるもの: wsuha-device.html で RED.settings.wsuhaDeviceWebUi を見ない（httpNodeRoot === false だけを見る）
  for (const [serverRoot, reason] of [
    [false, 'settings.js の httpNodeRoot が false です（httpNode を使っていない）'],
    ['/', 'settings.js の wsuhaBroute.ui が false です'],
  ]) {
    const { jq } = openEditor(serverRoot, undefined, { available: false, reason })
    assert.equal(jq.get('#wsuha-open-ui').visible, false, String(serverRoot))
    const tip = jq.get('#wsuha-open-ui-tip').textAll
    assert.ok(tip.includes(reason), tip)
    assert.match(tip, /Web UI はありません/)
    assert.match(tip, /settings/, 'ほかの窓口（この画面とフローの入力）を案内する')
  }
})

test('エディタで値を変えて運用設定が外れた項目（by が editor）には、「エディタ」と外した時刻を出す。一時的な上書きはデプロイでは外れないと書く', () => {
  // 前は by / at が届かず、byText('editor') は使われなかった。
  // 一時的な上書きはデプロイ（設定ノードの変更を含む）をまたいで残る。前は「この設定ノードを変えてデプロイすると外れる」と書いていた。
  // 戻すと落ちるもの: wsuha-device.html で by が editor の項目を出さない・上書きの説明を前の文に戻す
  const at = 1793900000000
  const s = JSON.parse(JSON.stringify(SETTINGS))
  s.fields.pollIntervalSec = { value: 45, source: 'config', runtimeValue: null, configValue: 45, default: 30, unit: '秒', by: 'editor', at }
  const { jq } = openEditor('/', s)
  const iv = jq.get('#wsuha-rt-pollIntervalSec')
  assert.equal(iv.visible, true)
  assert.match(iv.textAll, /運用設定を外しました/)
  assert.match(iv.textAll, /エディタ/)
  assert.ok(iv.textAll.includes(new Date(at).toLocaleString()), '外した時刻')
  const half = jq.get('#wsuha-rt-halfHourIntervalSec')
  assert.match(half.textAll, /一時的な上書き/)
  assert.match(half.textAll, /デプロイ[^。]*では外れません/, half.textAll)
  assert.ok(!/変えてデプロイするか/.test(half.textAll), half.textAll)
  // 設定ノードの値のままの項目（by が無い）には出さない
  const plain = JSON.parse(JSON.stringify(SETTINGS))
  assert.equal(openEditor('/', plain).jq.get('#wsuha-rt-pollIntervalSec').visible, false)
})

// ---------------------------------------------------------------------------
//  「プロパティ」欄の下の、名前つきのチェックの一覧（文字の欄と行き来する）
//  画面かフローで変えた構成・認証情報が効いている項目の表示
// ---------------------------------------------------------------------------

const epcCatalog = require('../../lib/runtime/epc-catalog')

/** 編集画面を開く。values は開く前の入力欄の値（Node-RED が node の値を入れておく）。 */
function openEditor2(opts) {
  const o = opts || {}
  const settings = editorSettings('/', { available: true, reason: null })
  if (o.catalog !== false) settings.wsuhaDeviceEpcCatalog = o.catalog || epcCatalog.catalog()
  const l = loadDef(settings)
  const jq = makeJq((url) => {
    if (url === 'wsuha-broute/serialports') return { items: o.ports || [], serialportMessage: o.serialportMessage || null }
    if (url === 'wsuha-broute/device/dev%201/settings') return o.settings
    if (url === 'wsuha-broute/device/dev%201/config') return o.config
    return undefined
  })
  for (const [k, v] of Object.entries(o.values || {})) jq.get('#node-config-input-' + k).value = v
  l.run(jq.$)
  const node = Object.assign({ id: 'dev 1', enabled: true }, o.node)
  // 検証は本物のエディタと同じく node._def から読む（「n 件の注意」の数え方）
  node._def = l.def
  l.def.oneditprepare.call(node)
  return { jq, def: l.def, tabs: l.tabs, node }
}

/** 一覧のチェックの要素（EPC → 要素）と、行の文字。 */
function epcRows(jq) {
  const out = {}
  // よく使う 4 つは基本設定の #wsuha-epc-common、ほかは折りたたみの #wsuha-epc-list
  for (const row of jq.get('#wsuha-epc-common').children.concat(jq.get('#wsuha-epc-list').children)) {
    if (row.tag !== 'label') continue
    const cb = row.children[0]
    out[cb.attrs['data-epc']] = { cb, text: row.textAll, note: row.children[row.children.length - 1] }
  }
  return out
}

function click(row, on) {
  row.cb.props.checked = on
  row.cb.handlers.change()
}

test('プロパティ欄の下に、名前と説明つきのチェックの一覧を出す（まとまりの見出しつき。履歴は出さない）', () => {
  // 戻すと落ちるもの: wsuha-device.html の一覧を作る処理を外す・registerType の settings で表を渡さない
  const { jq } = openEditor2({ values: { pollEpcs: 'E7, E8' } })
  const rows = epcRows(jq)
  assert.ok(Object.keys(rows).length > 10, Object.keys(rows).join(','))
  for (const h of ['E2', 'E4', 'EC']) assert.ok(!rows[h], `履歴 ${h} は出さない`)
  assert.match(rows.E7.text, /瞬時電力 — いま使っている電力 \[W\]。売電のときはマイナス（E7）/)
  assert.match(rows.E0.text, /買電/)
  assert.equal(rows.E7.cb.attrs.type, 'checkbox')
  assert.equal(rows.E7.cb.props.checked, true, '文字の欄の E7 に印')
  assert.equal(rows.E8.cb.props.checked, true)
  assert.equal(rows.E0.cb.props.checked, false)
  const heads = jq.get('#wsuha-epc-list').children.filter((c) => c.tag === 'div').map((c) => c.textAll)
  assert.deepEqual(heads, ['定時の積算', 'メーターの情報', 'そのほか（メーターはふつう持っていません）'])
  assert.match(jq.get('#wsuha-epc-count').textAll, /2 \/ 6 個/)
})

test('一覧の名前は短い名前（label）を先に見る。label の無い表は規格の名前（name）のまま', () => {
  // 戻すと落ちるもの: wsuha-device.html の epcRow を it.name だけにする
  const catalog = epcCatalog.catalog()
  const e7 = catalog.items.find((it) => it.epc === '0xE7')
  e7.label = '短い名前'
  delete catalog.items.find((it) => it.epc === '0xE8').label
  const rows = epcRows(openEditor2({ catalog, values: { pollEpcs: 'E7' } }).jq)
  assert.match(rows.E7.text, /^短い名前 — /)
  assert.match(rows.E8.text, /^瞬時電流計測値 — /)
})

test('チェックを変えると文字の欄を書き直し、文字の欄を直すとチェックが付き直す（表に無い EPC は残す）', () => {
  // 戻すと落ちるもの: wsuha-device.html の syncText / syncChecks
  const { jq } = openEditor2({ values: { pollEpcs: 'e7, D0' } })
  const input = jq.get('#node-config-input-pollEpcs')
  const rows = epcRows(jq)
  assert.equal(rows.E7.cb.props.checked, true, '小文字でも読む')
  click(rows.E0, true)
  assert.equal(input.value, 'E7, D0, E0', '付けたものを後ろに足す。表に無い D0 は残す')
  click(rows.E7, false)
  assert.equal(input.value, 'D0, E0')
  click(rows.E3, true)
  assert.equal(input.value, 'D0, E0, E3')
  assert.match(jq.get('#wsuha-epc-count').textAll, /3 \/ 6 個/)
  // 文字の欄を書き換える
  input.value = '0xE8 EA'
  input.handlers.input()
  assert.equal(rows.E8.cb.props.checked, true)
  assert.equal(rows.EA.cb.props.checked, true)
  assert.equal(rows.E0.cb.props.checked, false)
  assert.equal(rows.E3.cb.props.checked, false)
  input.value = 'E7, E8, E0, E3, D3, E1, EA'
  input.handlers.change()
  assert.match(jq.get('#wsuha-epc-count').textAll, /6 個までです/)
  input.value = ''
  input.handlers.input()
  assert.match(jq.get('#wsuha-epc-count').textAll, /空なら瞬時電力 E7/)
})

test('メーターが持っていない値（運用設定の options の supported が false）に「このメーターは持っていません」を出す。表の無い古いサーバーでは一覧を隠す', () => {
  const settings = JSON.parse(JSON.stringify(SETTINGS))
  settings.fields.pollEpcs.options = [
    { epc: '0xE7', supported: true },
    { epc: '0xE3', supported: false },
    { epc: '0xE0', supported: null },
  ]
  const { jq } = openEditor2({ values: { pollEpcs: 'E7' }, settings })
  const rows = epcRows(jq)
  assert.match(rows.E3.note.textAll, /このメーターは持っていません/)
  assert.equal(rows.E7.note.textAll, '')
  assert.equal(rows.E0.note.textAll, '', 'マップが無い（null）ときは何も出さない')
  const old = openEditor2({ catalog: false, values: { pollEpcs: 'E7' } })
  assert.equal(old.jq.get('#wsuha-epc-list').visible, false)
})

test('画面かフローで変えた構成が効いている項目に、その値と「ここで値を変えてデプロイすると、この項目の画面の値は外れます」を出す', () => {
  // 戻すと落ちるもの: wsuha-device.html で GET device/:id/config を読まない
  const at = 1793900000000
  const f = (value, source, extra) => Object.assign({ value, source, runtimeValue: source === 'runtime' ? value : null, configValue: null, by: null, at: null }, extra)
  const config = {
    rev: 'c1',
    fields: {
      name: f('二階', 'runtime', { by: 'web-ui', at }),
      enabled: f(false, 'runtime', { by: 'flow:切替', at }),
      role: f('電力', 'config'),
      mode: f('simulator', 'runtime', { by: 'web-ui', at }),
      serialport: f('/dev/serial/by-id/usb-X', 'runtime', { by: 'web-ui', at }),
      serialbaud: f(115200, 'config', { by: 'editor', at }),
      deviceKey: f('', 'runtime', { by: 'web-ui', at }),
      expectedMac: f(null, 'default'),
      autoStart: f(true, 'default'),
      scanDurations: f([5, 6], 'runtime', { by: 'web-ui', at }),
    },
    credentials: { configured: true, source: '画面かフローで保存した値', pairId: '89ABCDEF', envOverrides: false, stored: { by: 'web-ui', at } },
    applying: false,
    locked: false,
    lockedReason: null,
    warnings: [],
  }
  const { jq } = openEditor2({ config })
  const name = jq.get('#wsuha-cfg-name')
  assert.equal(name.visible, true)
  assert.match(name.textAll, /Web UI かフローで変えた値が効いています: 二階/)
  assert.match(name.textAll, /Web UI/)
  assert.ok(name.textAll.includes(new Date(at).toLocaleString()))
  assert.match(name.textAll, /ここで値を変えてデプロイすると、この項目の Web UI かフローの値は外れます/)
  assert.match(jq.get('#wsuha-cfg-enabled').textAll, /オフ/)
  assert.match(jq.get('#wsuha-cfg-enabled').textAll, /フロー（切替）/)
  assert.match(jq.get('#wsuha-cfg-mode').textAll, /シミュレーター/)
  assert.match(jq.get('#wsuha-cfg-serialport').textAll, /\/dev\/serial\/by-id\/usb-X/)
  assert.match(jq.get('#wsuha-cfg-deviceKey').textAll, /（空）/)
  assert.match(jq.get('#wsuha-cfg-scanDurations').textAll, /5, 6/)
  assert.equal(jq.get('#wsuha-cfg-role').visible, false, '設定ノードの値のままの項目には出さない')
  assert.equal(jq.get('#wsuha-cfg-expectedMac').visible, false)
  assert.match(jq.get('#wsuha-cfg-serialbaud').textAll, /Web UI かフローで変えた値を外しました/, 'エディタで外した項目')
  const cred = jq.get('#wsuha-cfg-credentials')
  assert.equal(cred.visible, true)
  assert.match(cred.textAll, /Web UI かフローで保存した値が効いています（値は出しません）/)
  // Web UI とエディタのどちらからでも入れられるので、後から入れた方が効く
  assert.match(cred.textAll, /ここで別の値を入れてデプロイすると、こちらが効きます/)
  assert.match(cred.textAll, /後から入れた方が効きます/)
  // 同じ値の入れ直し・空か片方だけのデプロイでは外れない。外す道（画面の「画面の値を消す」・フローの credentials-reset）を書く
  // 戻すと落ちるもの: wsuha-device.html の文言を「ここで入れてデプロイすると、こちらが効きます」だけにする
  assert.match(cred.textAll, /今と同じ値を入れ直しても変わりません/)
  assert.match(cred.textAll, /空か片方だけにしてデプロイしても外れません/)
  assert.match(cred.textAll, /「画面で入れた値を消す…」/)
  assert.match(cred.textAll, /credentials-reset/)
  // 環境変数が優先されるとき
  const env = JSON.parse(JSON.stringify(config))
  env.credentials = { configured: true, source: '環境変数', pairId: null, envOverrides: true, stored: { by: 'web-ui', at } }
  assert.match(openEditor2({ config: env }).jq.get('#wsuha-cfg-credentials').textAll, /環境変数が優先されています/)
  // 保存した値が無ければ出さない
  const none = JSON.parse(JSON.stringify(config))
  none.credentials = { configured: true, source: '設定ノード', pairId: null, envOverrides: false, stored: null }
  assert.equal(openEditor2({ config: none }).jq.get('#wsuha-cfg-credentials').visible, false)
})

test('ポートの候補: ほかの台が使っているポートにはその名前を添える', () => {
  const { jq } = openEditor2({
    ports: [
      { path: '/dev/serial/by-id/usb-A', manufacturer: 'FTDI', ownedBy: { id: 'other', name: '動力' } },
      { path: '/dev/ttyUSB0', manufacturer: '', ownedBy: null },
    ],
  })
  // datalist はやめて、🔍 で全部の候補を出す（Chrome の datalist は今の値に合う候補しか出さない）
  jq.get('#wsuha-port-lookup').handlers.click({ preventDefault() {} })
  const opts = jq.get('#node-config-input-serialport').props.autocomplete.source
  assert.equal(opts.length, 2)
  assert.match(opts[0].label, /「動力」が使っています/)
  assert.equal(opts[0].value, '/dev/serial/by-id/usb-A')
  assert.equal(opts[1].value, '/dev/ttyUSB0')
  assert.doesNotMatch(opts[1].label, /使っています/)
})

test('ポートの候補: serialport が無いサーバーでは入れ方を出し、「見つかりません」と言わない', () => {
  // 戻すと落ちるもの: wsuha-device.html の loadPorts で serialportMessage を見ない
  const message = 'serialport を読み込めないので、ポートの候補を出せません。'
  const { jq } = openEditor2({ serialportMessage: message })
  assert.equal(jq.get('#wsuha-port-hint').ownText, message)
  const none = openEditor2({}).jq.get('#wsuha-port-hint').ownText
  assert.match(none, /ポートが見つかりません/, '読めて候補が無いときは、今までの文')
})

test('5 分 / 30 分の取得の説明に、取る値を名前で書く', () => {
  const tpl = HTML.slice(HTML.indexOf('data-template-name="wsuha-device"'), HTML.indexOf('data-help-name="wsuha-device"'))
  const slow = tpl.slice(tpl.indexOf('node-config-input-slowIntervalSec'), tpl.indexOf('node-config-input-halfHourIntervalSec'))
  assert.match(slow, /積算電力量（買電・売電）・動作状態・異常発生状態を取りに行く間隔/)
  const help = HTML.slice(HTML.indexOf('data-help-name="wsuha-device"'))
  assert.match(help, /積算電力量の買電（<code>E0<\/code>）/)
  assert.match(help, /売電（<code>E3<\/code>）/)
  assert.match(help, /定時積算の買電（<code>EA<\/code>）/)
})

test('認証情報の欄の説明: 画面かフローで保存した値とこの画面の値は、後から入れた方が効く（優先の表も同じ）', () => {
  // 戻すと落ちるもの: wsuha-device.html の説明を「画面の値がこの画面の値より優先」のままにする
  const text = HTML.replace(/\r/g, '')
  const form = text.slice(text.indexOf('data-template-name="wsuha-device"'), text.indexOf('data-help-name="wsuha-device"'))
  const help = text.slice(text.indexOf('data-help-name="wsuha-device"'))
  assert.match(form, /後から入れた方が効きます/, '欄の上の説明')
  assert.ok(!/この画面の値より優先されます/.test(text), '前の「画面の値が常に優先」の説明が残っている')
  assert.match(help, /後から入れた方/, 'ヘルプの優先の表')
  // 同じ値の入れ直しと、空か片方だけのデプロイでは画面の値は外れない。外すのは画面の「画面の値を消す」かフローの credentials-reset
  // 戻すと落ちるもの: 欄の上の説明とヘルプの優先の表に、外れない場合と外す道を書かない
  assert.match(form, /同じ値の入れ直しと、空か片方だけのデプロイでは外れません/, '欄の上の説明')
  assert.match(help, /今と同じ値を入れ直しても、欄を空か片方だけにしてデプロイしても、Web UI かフローの値は外れません/, 'ヘルプの優先の表')
  assert.match(help, /credentials-reset/)
})

// ---------------------------------------------------------------------------
//  編集画面の作り（基本設定 / 詳細設定・「n 件の注意」・添え書き・選択肢）
// ---------------------------------------------------------------------------

const cf = require('../../lib/runtime/config-fields')
const { FIELDS: SETTING_FIELDS } = require('../../lib/runtime/settings-store')

/** 接続の設定と運用設定の項目を、編集画面の欄の id にする。 */
const FIELD_INPUT = {
  role: 'wsuha-role-select',
  name: 'node-config-input-name',
  mode: 'node-config-input-mode',
  serialport: 'node-config-input-serialport',
  pollIntervalSec: 'node-config-input-pollInterval',
  pollEpcs: 'node-config-input-pollEpcs',
  enabled: 'node-config-input-enabled',
  autoStart: 'node-config-input-autoStart',
  serialbaud: 'node-config-input-serialbaud',
  deviceKey: 'node-config-input-deviceKey',
  expectedMac: 'node-config-input-expectedMac',
  scanDurations: 'node-config-input-scanDurations',
  slowIntervalSec: 'node-config-input-slowIntervalSec',
  halfHourIntervalSec: 'node-config-input-halfHourIntervalSec',
}

test('基本設定と詳細設定の割り振りが、サーバーの tier と同じ（名前だけタブの上）', () => {
  // 戻すと落ちるもの: 欄を別のタブへ動かす・tier を変えて HTML を直さない
  const basic = elementOf(TEMPLATE, 'wsuha-device-tab-basic')
  const advanced = elementOf(TEMPLATE, 'wsuha-device-tab-advanced')
  const tabsAt = TEMPLATE.indexOf('id="wsuha-device-tabs"')
  assert.ok(TEMPLATE.indexOf('id="node-config-input-name"') < tabsAt, '名前はタブの上')
  const tiers = Object.assign({}, ...Object.keys(cf.CONFIG_FIELDS).map((k) => ({ [k]: cf.CONFIG_FIELDS[k].tier })), ...Object.keys(SETTING_FIELDS).map((k) => ({ [k]: SETTING_FIELDS[k].tier })))
  assert.deepEqual(Object.keys(tiers).sort(), Object.keys(FIELD_INPUT).sort(), '欄の表に全部の項目がある')
  for (const [k, tier] of Object.entries(tiers)) {
    if (k === 'name') continue
    const inBasic = basic.includes(`id="${FIELD_INPUT[k]}"`)
    const inAdvanced = advanced.includes(`id="${FIELD_INPUT[k]}"`)
    assert.equal(inBasic, tier === 'basic', k + ' は基本設定か')
    assert.equal(inAdvanced, tier === 'advanced', k + ' は詳細設定か')
  }
})

test('「詳細設定（n 件の注意）」: 注記と入力の誤りを項目ごとに数える（同じ項目の注記と誤りは 1 件）', () => {
  // 戻すと落ちるもの: markAdvanced を外す・advancedProblems で注記と誤りを別々に足す
  const at = 1793900000000
  const f = (value, source, extra) => Object.assign({ value, source, runtimeValue: source === 'runtime' ? value : null, configValue: null, by: null, at: null }, extra)
  const fields = {}
  for (const k of Object.keys(cf.CONFIG_FIELDS)) fields[k] = f(null, 'default')
  const config = { rev: 'c1', fields, credentials: { configured: true, source: '設定ノード', pairId: null, envOverrides: false, stored: null } }
  const name = (o) => o.tabs.names['wsuha-device-tab-advanced']
  assert.deepEqual(openEditor2({ config }).tabs.added.map((t) => t.label), ['基本設定', '詳細設定'])
  assert.equal(name(openEditor2({ config })), '詳細設定', '何も無ければそのまま')
  // 注記だけ
  fields.deviceKey = f('usb0', 'runtime', { by: 'web-ui', at })
  assert.equal(name(openEditor2({ config })), '詳細設定（1 件の注意）')
  // 同じ項目に注記と誤り: 1 件
  assert.equal(name(openEditor2({ config, node: {}, values: { deviceKey: '!!!' } })), '詳細設定（1 件の注意）')
  // 別の項目の誤りを足す: 2 件
  assert.equal(name(openEditor2({ config, values: { deviceKey: '!!!', expectedMac: 'XYZ' } })), '詳細設定（2 件の注意）')
})

test('「Web UI で開く」の添え書き: 文が無いときは隠す（form-tips は空でも黄色い枠が見える）。文を入れたら見せる', () => {
  // 戻すと落ちるもの: テンプレートの display:none を外す・文を入れるところの show() を外す
  assert.match(TEMPLATE, /id="wsuha-open-ui-tip"[^>]*display:none/)
  // デプロイ済み: 添え書きは隠れたまま
  const deployed = openEditor2({ config: { fields: {}, credentials: null } })
  assert.equal(deployed.jq.get('#wsuha-open-ui-tip').visible, false)
  assert.equal(deployed.jq.get('#wsuha-open-ui').visible, true)
  // 未デプロイ（GET device/:id/config が 404）: リンクを隠して「デプロイすると開けます」
  const fresh = openEditor2({ config: FAIL })
  assert.equal(fresh.jq.get('#wsuha-open-ui').visible, false)
  assert.equal(fresh.jq.get('#wsuha-open-ui-tip').visible, true)
  assert.equal(fresh.jq.get('#wsuha-open-ui-tip').textAll, 'デプロイすると開けます')
  // Web UI の無いサーバー
  const none = openEditor('/', undefined, { available: false, reason: 'settings.js の wsuhaBroute.ui が false です' })
  assert.equal(none.jq.get('#wsuha-open-ui-tip').visible, true)
})

test('設定ノードの下の帯が無効のときだけ、基本設定の先頭に注意を出す', () => {
  // 戻すと落ちるもの: node.d を見ない
  assert.equal(openEditor2({ node: { d: true } }).jq.get('#wsuha-footer-disabled').visible, true)
  assert.equal(openEditor2({}).jq.get('#wsuha-footer-disabled').visible, false)
})

test('契約の select: 電力・動力・その他（今の値を欄に入れて開く）の 3 通り。datalist は使わない', () => {
  // 戻すと落ちるもの: oneditprepare で今の値から選択を決めない・datalist に戻す
  const open = (role) => openEditor2({ node: { role }, values: { role } }).jq
  assert.equal(open('電力').get('#wsuha-role-select').value, '電力')
  assert.equal(open('動力').get('#wsuha-role-select').value, '動力')
  const other = open('高圧')
  assert.equal(other.get('#wsuha-role-select').value, '_other')
  assert.equal(other.get('#node-config-input-role').value, '高圧')
  assert.equal(other.get('#wsuha-role-other').visible, true)
  assert.equal(open('').get('#wsuha-role-select').value, '')
  assert.ok(!/list=|datalist/.test(TEMPLATE))
})

test('ポートの 🔍 は、今の値に関係なく全部の候補を出す', () => {
  // 戻すと落ちるもの: autocomplete('search', '') を呼ばない（今の値で絞られる）
  const { jq } = openEditor2({ ports: [{ path: '/dev/ttyUSB0' }, { path: '/dev/ttyUSB1' }], values: { serialport: '/dev/ttyUSB0' } })
  jq.get('#wsuha-port-lookup').handlers.click({ preventDefault() {} })
  const input = jq.get('#node-config-input-serialport')
  assert.equal(input.props.autocomplete.minLength, 0)
  assert.equal(input.props.autocompleteSearch, '')
})

test('通信速度の選択肢はサーバーの BAUDS と同じ。先頭は既定。今の値が候補に無くても出す', () => {
  // 戻すと落ちるもの: select を埋める処理を外す
  const { jq } = openEditor2({ node: { serialbaud: 1200 } })
  const opts = jq.get('#node-config-input-serialbaud').children.map((o) => o.attrs.value)
  assert.equal(opts[0], String(cf.CONFIG_FIELDS.serialbaud.default))
  assert.deepEqual(opts.slice(0, -1).map(Number).sort((a, b) => a - b), cf.BAUDS.slice().sort((a, b) => a - b))
  assert.equal(opts[opts.length - 1], '1200')
})

test('エディタの表示: 同じ契約が 2 台あるときだけポートを添える。パレットの名前は「Wi-SUN アダプタ」', () => {
  // 戻すと落ちるもの: label で eachConfig を見ない・paletteLabel を外す
  const a = { id: 'a', type: 'wsuha-device', role: '電力', mode: 'serial', serialport: '/dev/ttyUSB0' }
  const b = { id: 'b', type: 'wsuha-device', role: '電力', mode: 'serial', serialport: '/dev/ttyUSB1' }
  const c = { id: 'c', type: 'wsuha-device', role: '動力', mode: 'serial', serialport: '/dev/ttyUSB2' }
  const two = loadDef({}, [a, b, c])
  two.run(makeJq(() => undefined).$)
  assert.equal(two.def.label.call(a), '電力（USB0）')
  assert.equal(two.def.label.call(c), '動力')
  const one = loadDef({}, [a, c])
  one.run(makeJq(() => undefined).$)
  assert.equal(one.def.label.call(a), '電力')
  assert.equal(two.def.paletteLabel, 'Wi-SUN アダプタ')
})

test('アイコンは Font Awesome 4.7 にあるものだけ', () => {
  // 戻すと落ちるもの: fa-fingerprint のように 4.7 に無い名前を使う（空の四角になる）
  assert.deepEqual(unknownFa(HTML), [])
})

test('ヘルプ: Web UI に独自のログインは無いが、Node-RED に認証があるサーバーでは変更にエディタのログインが要る', () => {
  // 戻すと落ちるもの: 「Web UI と API にログインはありません」の文に戻す
  assert.ok(!/Web UI と API にログインはありません/.test(HELP))
  assert.match(HELP, /Web UI に独自のログインはありません/)
  assert.match(HELP, /Node-RED に認証（<code>adminAuth<\/code>）があるサーバーでは、変更にはエディタのログインが要ります/)
  assert.match(HELP, /wsuha-broute\.write/)
  assert.match(HELP, /httpNodeAuth/)
})

test('シミュレーター: 認証情報の欄の下に要らないことを書き、ヘルプの優先の順と出どころの名前にも書く', () => {
  // 戻すと落ちるもの: 案内を消す
  assert.match(TEMPLATE, /wsuha-sim-only">シミュレーターでは、入れなくても架空の値で動きます/)
  assert.match(HELP, /接続先がシミュレーターで、上のどれも無いときだけ、架空の値/)
  assert.match(HELP, /「シミュレーターの架空の値」/)
  assert.match(HELP, /デプロイするだけで動きます/)
})

// ---------------------------------------------------------------------------
//  認証 ID とパスワードの欄（どちらも password の型）
// ---------------------------------------------------------------------------

const CRED_FIELDS = '#node-config-input-routeBId, #node-config-input-routeBPassword'
const TEST_ID = '0123456789ABCDEF0123456789ABCDEF'
const TEST_PW = 'ABCDEF123456'

test('認証 ID は password の型: 値を GET /credentials から読めないようにする。欄も伏せ字', () => {
  // text の型だと、read の権限の利用者と adminAuth の無いサーバーの匿名が値を読める。
  // 戻すと落ちるもの: wsuha-device.html の credentials か欄の type を text に戻す
  const l = loadDef({})
  l.run(makeJq(() => undefined).$)
  assert.equal(l.def.credentials.routeBId.type, 'password')
  assert.equal(l.def.credentials.routeBPassword.type, 'password')
  const input = /<input\b[^>]*\bid="node-config-input-routeBId"[^>]*>/.exec(TEMPLATE)
  assert.ok(input, '認証 ID の欄がある')
  assert.match(input[0], /type="password"/)
  assert.match(input[0], /autocomplete="new-password"/, 'ブラウザーの保存と自動入力に渡さない')
})

test('認証の欄: 保存済みの印は書式の誤りに数えない。入れ直した値は確かめ、消した欄は未設定と出す', () => {
  // 戻すと落ちるもの: check() の id !== KEPT を外す（「認証 ID は 32 桁…（いま 8 文字）」が値を変えなくても出る）
  const { jq } = openEditor2({
    values: { routeBId: '__PWRD__', routeBPassword: '__PWRD__' },
    node: { credentials: { has_routeBId: true, has_routeBPassword: true } },
  })
  const warn = jq.get('#wsuha-cred-warn')
  const state = jq.get('#wsuha-cred-state')
  assert.equal(warn.visible, false, warn.textAll)
  assert.equal(state.textAll, '設定済み', '未デプロイでも欄の印と has_ から分かる')
  const id = jq.get('#node-config-input-routeBId')
  const edited = jq.get(CRED_FIELDS).handlers.input
  id.value = '12AB'
  edited()
  assert.equal(warn.visible, true)
  assert.match(warn.textAll, /認証 ID は 32 桁の 16 進数/)
  id.value = ''
  edited()
  assert.equal(warn.visible, false)
  assert.equal(state.textAll, '未設定', '消した欄を「設定済み」と言わない')
  id.value = TEST_ID
  edited()
  assert.equal(state.textAll, '設定済み')
})

test('認証の欄: 印があっても has_ が無ければ値は無い（欄の文字だけを信じない）', () => {
  // 戻すと落ちるもの: credFilled で has_ を見ない
  const { jq } = openEditor2({
    values: { routeBId: '__PWRD__', routeBPassword: '__PWRD__' },
    node: { credentials: { has_routeBId: false, has_routeBPassword: true } },
  })
  assert.equal(jq.get('#wsuha-cred-state').textAll, '未設定')
})

/** 接続の設定の応答（認証情報の出どころだけを変える）。 */
function configOf(credentials) {
  return { fields: {}, credentials: Object.assign({ configured: true, envOverrides: false, stored: null, pairId: '89ABCDEF' }, credentials) }
}

test('架空の値で動いている台: シミュレーターなら「設定済み」、接続先を実機にすると「未設定」。欄に入れれば「設定済み」', () => {
  // 架空の値はシミュレーターだけのもの。実機に切り替えて欄が空のままデプロイすると「認証情報がありません」で止まる。
  // 戻すと落ちるもの: credState の fake の分岐を外す・接続先の change で credState を呼び直さない
  const { jq } = openEditor2({
    node: { mode: 'simulator' },
    values: { mode: 'simulator' },
    config: configOf({ source: 'シミュレーターの架空の値' }),
  })
  const state = jq.get('#wsuha-cred-state')
  const mode = jq.get('#node-config-input-mode')
  assert.equal(state.textAll, '設定済み')
  assert.match(state.attrs.title, /89ABCDEF/)
  mode.value = 'serial'
  mode.handlers.change()
  assert.equal(state.textAll, '未設定')
  assert.equal(state.attrs.title, '', '架空の値の PairID を実機の台に見せない')
  jq.get('#node-config-input-routeBId').value = TEST_ID
  jq.get('#node-config-input-routeBPassword').value = TEST_PW
  jq.get(CRED_FIELDS).handlers.input()
  assert.equal(state.textAll, '設定済み')
  jq.get('#node-config-input-routeBId').value = ''
  jq.get('#node-config-input-routeBPassword').value = ''
  mode.value = 'simulator'
  mode.handlers.change()
  assert.equal(state.textAll, '設定済み', 'シミュレーターへ戻すと架空の値で動く')
})

test('本物の値で動いている台は、接続先を切り替えても状態の 1 行が変わらない', () => {
  // 戻すと落ちるもの: credState の fake の分岐で出どころを見ない（接続先だけで「未設定」にする）
  for (const [cr, want] of [
    [{ source: '設定ノード' }, '設定済み'],
    [{ source: '環境変数', envOverrides: true }, '環境変数が優先されています（ここで入れても、いまは効きません）'],
    [{ source: '画面かフローで保存した値', stored: { by: 'web-ui', at: 1 } }, 'Web UI かフローで保存した値が効いています'],
  ]) {
    const { jq } = openEditor2({ node: { mode: 'simulator' }, values: { mode: 'simulator' }, config: configOf(cr) })
    const mode = jq.get('#node-config-input-mode')
    assert.equal(jq.get('#wsuha-cred-state').textAll, want)
    mode.value = 'serial'
    mode.handlers.change()
    assert.equal(jq.get('#wsuha-cred-state').textAll, want)
  }
})

test('架空の値の出どころの文は、実行時（wsuha-device.js）と編集画面で同じ', () => {
  // 戻すと落ちるもの: どちらかの文だけを変える（編集画面の見分けが黙って効かなくなる）
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-device.js'), 'utf8')
  const server = /SIMULATOR_CREDENTIALS = \{[^}]*source: '([^']+)'/.exec(js)
  const editor = /SIMULATOR_SOURCE = '([^']+)'/.exec(HTML)
  assert.ok(server && editor)
  assert.equal(editor[1], server[1])
})

// ---------------------------------------------------------------------------
//  項目の無いフローを開いて保存しても、動きを変えない
// ---------------------------------------------------------------------------

test('項目の無いフロー: 有効・自動で始める・受信の形式はオンで見せる。値を持っているフローは触らない', () => {
  // 実行時は無い項目をオンとして扱うが、エディタはチェックを外して見せる。そのまま保存すると false になり、デプロイのあと黙って止まる。
  // 戻すと落ちるもの: oneditprepare の補いから autoStart か autoWriteWopt を外す
  for (const missing of [undefined, null]) {
    const { jq } = openEditor2({ node: { enabled: missing, autoStart: missing, autoWriteWopt: missing } })
    for (const k of ['enabled', 'autoStart', 'autoWriteWopt']) {
      assert.equal(jq.get('#node-config-input-' + k).props.checked, true, k + ' が ' + missing)
    }
  }
  const set = openEditor2({ node: { enabled: false, autoStart: false, autoWriteWopt: false } })
  for (const k of ['enabled', 'autoStart', 'autoWriteWopt']) {
    assert.equal(set.jq.get('#node-config-input-' + k).props.checked, undefined, k + ' は Node-RED が入れた値のまま')
  }
})

test('手書きのフローの模擬設定がオブジェクトなら、JSON の文字にして見せる（保存しても読めない値に変えない）', () => {
  // 戻すと落ちるもの: oneditprepare の JSON.stringify を外す（欄が [object Object] のまま保存される）
  const o = { meter: { power: 1200 } }
  const { jq, def, node } = openEditor2({ node: { mode: 'simulator', simulatorOptions: o }, values: { mode: 'simulator', simulatorOptions: '[object Object]' } })
  const input = jq.get('#node-config-input-simulatorOptions')
  assert.deepEqual(JSON.parse(input.value), o)
  assert.equal(def.defaults.simulatorOptions.validate.call(node, input.value), true)
})

// ---------------------------------------------------------------------------
//  検証が編集中のノードだけを見る
// ---------------------------------------------------------------------------

test('契約の「その他で空」は編集中のノードだけを断る。閉じたあとは、ほかの台の検証に残らない', () => {
  // 設定ノードを削除したあとも select を握ったままだと、契約が空のほかの台が全部「不正なノード」になる。
  // 戻すと落ちるもの: oneditdelete を外す・wsuhaText の editing.node === this を外す
  for (const close of ['oneditdelete', 'oneditsave', 'oneditcancel']) {
    const { jq, def, node } = openEditor2({ node: { role: 'ほかの契約' }, values: { role: 'ほかの契約' } })
    const role = def.defaults.role.validate
    const other = { id: 'other', role: '' }
    assert.equal(jq.get('#wsuha-role-select').value, '_other')
    assert.equal(role.call(node, ''), false, '編集中のノードが空なら断る')
    assert.equal(role.call(other, ''), true, 'ほかの台は契約が空でよい')
    assert.equal(typeof def[close], 'function', close)
    def[close].call(node)
    assert.equal(role.call(node, ''), true, close + ' のあとは残らない')
  }
})

test('模擬設定の検証: シミュレーターの台は空か JSON のオブジェクトだけを通す。実機の台は隠れた欄なので見ない', () => {
  // 戻すと落ちるもの: defaults の simulatorOptions の validate を外す・wsuhaSimOptions で接続先を見ない
  const l = loadDef({})
  l.run(makeJq(() => undefined).$)
  const v = l.def.defaults.simulatorOptions.validate
  const sim = { mode: 'simulator' }
  for (const [value, want] of [
    ['', true],
    [undefined, true],
    [' ', true],
    ['{"meter":{"power":1200}}', true],
    [{ meter: { power: 1200 } }, true],
    ['{"meter":{"power":1200}', false],
    ['[1]', false],
    ['5', false],
    ['null', false],
    ['"x"', false],
  ]) {
    assert.equal(v.call(sim, value), want, JSON.stringify(value))
  }
  assert.equal(v.call({ mode: 'serial' }, '{"meter":'), true, '実機の台は見ない')
})

test('模擬設定の誤りは、編集画面の今の接続先で判定し、タブの名前の「n 件の注意」に数える', () => {
  // 戻すと落ちるもの: advancedProblems の一覧から simulatorOptions を外す・接続先の change で markAdvanced を呼ばない
  const bad = '{"meter":'
  const { jq, tabs } = openEditor2({ node: { mode: 'serial', simulatorOptions: bad }, values: { mode: 'serial', simulatorOptions: bad } })
  const name = () => tabs.names['wsuha-device-tab-advanced']
  assert.equal(name(), '詳細設定')
  const mode = jq.get('#node-config-input-mode')
  mode.value = 'simulator'
  mode.handlers.change()
  assert.equal(name(), '詳細設定（1 件の注意）')
  mode.value = 'serial'
  mode.handlers.change()
  assert.equal(name(), '詳細設定')
})

test('定期取得の値に読めない値や履歴があると、畳んだ「ほかの値」を開いて理由を出す', () => {
  // 記号の欄は既定で閉じた中にあるので、赤枠が見えず、ノードが赤い理由が編集画面から分からない。
  // 戻すと落ちるもの: 折りたたみを無条件に閉じる・開くときにアイコンを変えない（次のクリックが逆に動く）・#wsuha-epc-error を出さない
  const { jq } = openEditor2({ values: { pollEpcs: 'E7, E2' } })
  const more = jq.get('#wsuha-epc-more')
  const icon = jq.get('#wsuha-epc-more-icon')
  const error = jq.get('#wsuha-epc-error')
  assert.equal(more.visible, true)
  assert.equal(icon.attrs.class, 'fa fa-angle-down')
  assert.equal(error.visible, true)
  assert.match(error.textAll, /読めない値か、履歴（E2・E4・EC）が入っています/)
  jq.get('#wsuha-epc-more-toggle').handlers.click({ preventDefault() {} })
  assert.equal(more.visible, false, '次のクリックで閉じる')
  assert.equal(icon.attrs.class, 'fa fa-angle-right')
  const input = jq.get('#node-config-input-pollEpcs')
  input.value = 'E7'
  input.handlers.change()
  assert.equal(error.visible, false, '直したら消える')
  input.value = 'E7, 0E7'
  input.handlers.change()
  assert.equal(error.visible, true, '読めない値も同じ')

  for (const values of [{ pollEpcs: 'E7, E8' }, { pollEpcs: '' }, {}]) {
    const ok = openEditor2({ values }).jq
    assert.equal(ok.get('#wsuha-epc-more').visible, false, JSON.stringify(values) + ' は閉じたまま')
    assert.equal(ok.get('#wsuha-epc-more-icon').attrs.class, 'fa fa-angle-right')
    assert.equal(ok.get('#wsuha-epc-error').visible, false)
  }
})

// ---------------------------------------------------------------------------
//  ヘルプが実物の動きと合っている
// ---------------------------------------------------------------------------

test('ヘルプ: デプロイの種類が「全て」（既定）なら接続は切れる。語は Node-RED のメニューと同じ', () => {
  // 既定のデプロイでも切れないと読める文だと、既定のまま使う人が誤る。
  // 戻すと落ちるもの: 「閉じるのは…Node-RED を止めたときだけです」の文に戻す
  assert.ok(!/Node-RED を止めたときだけです/.test(HELP))
  assert.ok(!/全体のデプロイ/.test(HELP.slice(0, HELP.indexOf('<h3>基本設定と詳細設定'))), 'メニューの語は「全て」')
  assert.match(HELP, /デプロイの種類が「全て」（既定）のとき、Node-RED を止めたときです/)
  assert.match(HELP, /「変更したノード」か「変更したフロー」/)
  assert.match(HELP, /つなぎ直すまで 1 分前後止まります/)
  assert.match(HELP, /Node-RED 3\.1\.3 は、この編集画面を開いたあとのデプロイでは、値を変えていなくても設定ノードを作り直します/)
})

test('ヘルプ: はじめにの手順は、選択肢ではなく隣のボタンで追加する（Node-RED 3 と 4 で違う）', () => {
  // 3.1.3 は「新規に…」を選んでも画面が開かず、4.1.2 は設定ノードが 1 つあると選択肢に無い。
  // 戻すと落ちるもの: 「新規に…を選びます」だけの手順に戻す
  const first = HELP.slice(HELP.indexOf('<h3>はじめに</h3>'), HELP.indexOf('</ol>'))
  assert.match(first, /右のボタン（Node-RED 3 は鉛筆、4 は ＋）を押して/)
  assert.ok(!/アダプタの「新規に Wi-SUN アダプタ を追加\.\.\.」を選びます/.test(first))
})

test('ヘルプ: 確かめたアダプタは RS-WSUHA だけと書き、チップの帰属は書かない。秘密ファイルを探す場所は実物と同じ', () => {
  // 戻すと落ちるもの: 「RATOC RS-WSUHA など、ROHM SKSTACK-IP 系」の文に戻す・探す場所を userDir だけにする
  assert.match(HELP, /確かめたのは RATOC RS-WSUHA だけです/)
  assert.ok(!/ROHM/.test(HELP.slice(0, HELP.indexOf('<h3>はじめに</h3>'))))
  assert.match(HELP, /userDir・作業ディレクトリ・ホームの順に探します/)
  assert.ok(!/&lt;userDir&gt;\/wsuha-broute-&lt;デバイスキー&gt;\.secret\.json/.test(HELP))
})

test('ヘルプ: 認証 ID も読み出せない。追加は flows.json を書く。エディタを別の方法で閉じたサーバーは変更を全部断る', () => {
  // 戻すと落ちるもの: 認証のある無しの 2 通りだけの説明に戻す・flows.json の注意を消す
  assert.match(HELP, /認証 ID もパスワードと同じ扱いで/)
  const sec = HELP.slice(HELP.indexOf('<h3>Web UI のセキュリティ</h3>'), HELP.indexOf('<h3>認証情報の優先順位</h3>'))
  assert.match(sec, /［アダプタを追加］で <code>flows\.json<\/code> へ台を追加できます/)
  assert.match(sec, /uiAddAdapter: false/)
  for (const w of ['httpAdminAuth', 'httpAdminMiddleware', 'httpAdminRoot: false', 'allowAnonymousWrites: true', 'httpNodeAuth', 'httpNodeMiddleware']) {
    assert.ok(sec.includes(w), w)
  }
  assert.match(sec, /Web UI からの変更を全部断ります/)
})
