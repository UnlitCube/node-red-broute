'use strict'

// 構成の純粋な部分:
//   - lib/runtime/config-fields.js: 検証の範囲・エディタの値のそろえ方・効く値の決め方
//   - lib/runtime/settings-store.js の構成（rev・If-Match・configAtSet・照合。運用設定とは別の版）
//   - lib/runtime/credentials-store.js: 700 / 600・.tmp → rename・壊れたファイル・指紋の照合・検証の文に値を入れない
//   - lib/runtime/epc-catalog.js と echonet.js の desc・group
//   - lib/serial-transport.js の candidates（by-id を先に）
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cf = require('../../lib/runtime/config-fields')
const { createSettingsStore, RevisionMismatch } = require('../../lib/runtime/settings-store')
const { createCredentialsStore, validateCredentialsInput, fingerprint, fileNameOf } = require('../../lib/runtime/credentials-store')
const catalog = require('../../lib/runtime/epc-catalog')
const EL = require('../../lib/echonet')
const { SerialTransport } = require('../../lib/serial-transport')
const vm = require('../../lib/runtime/view-model')
const { tmpDir, ID, PW } = require('./fake-red')

// ---------------------------------------------------------------------------
//  検証の範囲（決めたこと）
// ---------------------------------------------------------------------------

/** [項目, 値, 通るか, 通ったときの値] */
const CASES = [
  ['name', '1階 分電盤', true, '1階 分電盤'],
  ['name', '  前後の空白  ', true, '前後の空白'],
  ['name', '', true, ''],
  ['name', 'あ'.repeat(100), true],
  ['name', 'あ'.repeat(101), false],
  ['name', '改行\nあり', false],
  ['name', 12, false],
  ['role', '動力', true, '動力'],
  ['role', 'x'.repeat(33), false],
  ['role', '\u0007', false],
  ['enabled', true, true, true],
  ['enabled', false, true, false],
  ['enabled', 'false', false],
  ['enabled', 0, false],
  ['autoStart', false, true, false],
  ['autoStart', 'yes', false],
  ['mode', 'serial', true, 'serial'],
  ['mode', 'simulator', true, 'simulator'],
  ['mode', 'tcp', false],
  ['serialport', '/dev/serial/by-id/usb-FTDI_FT230X_Basic_UART_X-if00-port0', true],
  ['serialport', '/dev/ttyUSB0', true, '/dev/ttyUSB0'],
  ['serialport', 'COM3', true, 'COM3'],
  ['serialport', '\\\\.\\COM12', true],
  ['serialport', ' /dev/ttyUSB1 ', true, '/dev/ttyUSB1'],
  ['serialport', '', false],
  ['serialport', 'ttyUSB0', false],
  ['serialport', '/dev/tty\nUSB0', false],
  ['serialport', '/' + 'a'.repeat(256), false],
  ['serialport', 7, false],
  ['serialbaud', 115200, true, 115200],
  ['serialbaud', '115200', true, 115200],
  ['serialbaud', 9600, true, 9600],
  ['serialbaud', 2400, true, 2400],
  ['serialbaud', 57600, true, 57600],
  ['serialbaud', 230400, false],
  ['serialbaud', 1200, false],
  ['serialbaud', 115200.5, false],
  ['serialbaud', 'fast', false],
  ['deviceKey', 'usb0', true, 'usb0'],
  ['deviceKey', 'USB_0-a', true, 'USB_0-a'],
  ['deviceKey', '', true, ''],
  ['deviceKey', 'usb 0', false],
  ['deviceKey', 'usb.0', false],
  ['deviceKey', 'x'.repeat(33), false],
  ['deviceKey', 'ユーエスビー', false],
  ['expectedMac', '001d129100000000', true, '001D129100000000'],
  ['expectedMac', '00:1D:12:91:00:00:00:00', true, '001D129100000000'],
  ['expectedMac', '', true, ''],
  ['expectedMac', '001D12910000000', false],
  ['expectedMac', '001D12910000000G', false],
  ['expectedMac', 1, false],
  ['scanDurations', [4, 5, 6], true, [4, 5, 6]],
  ['scanDurations', '4,5,6,7,8', true, [4, 5, 6, 7, 8]],
  ['scanDurations', ['2', 14], true, [2, 14]],
  ['scanDurations', [1], false],
  ['scanDurations', [15], false],
  ['scanDurations', [4.5], false],
  ['scanDurations', [], false],
  ['scanDurations', '4,x', false],
  ['scanDurations', [2, 3, 4, 5, 6, 7, 8, 9, 10], false],
]

test('構成の検証: 項目ごとの範囲（serialbaud は表・expectedMac は 16 桁の 16 進・deviceKey は英数字と _ -・scanDurations は 2〜14 の整数 1〜8 個）', () => {
  // 戻すと落ちるもの: config-fields.js の checkField の範囲を緩める・表を外す
  for (const [k, v, ok, want] of CASES) {
    const { changes, errors } = cf.validateConfigInput({ [k]: v })
    if (ok) {
      assert.equal(errors[k], undefined, `${k}=${JSON.stringify(v)} は通る: ${errors[k]}`)
      if (want !== undefined) assert.deepEqual(changes[k], want, `${k}=${JSON.stringify(v)}`)
    } else {
      assert.equal(typeof errors[k], 'string', `${k}=${JSON.stringify(v)} は断る`)
      assert.ok(!(k in changes), `${k} は変えない`)
    }
  }
  assert.deepEqual(cf.BAUDS, [2400, 4800, 9600, 19200, 38400, 57600, 115200])
})

test('構成の検証: 値の全体が ${…} か $(…) の文字は断る（Node-RED が環境変数の値に置き換えて、一覧に出るため）', () => {
  // 戻すと落ちるもの: config-fields.js の checkField の text から ENV_REF の判定を外す
  for (const v of ['${NODE_RED_CREDENTIAL_SECRET}', '$(WSUHA_BROUTE_PASSWORD_KEY)', '  ${X}  ', '${a.b-c}']) {
    for (const k of ['role', 'name']) {
      const r = cf.validateConfigInput({ [k]: v })
      assert.ok(r.errors[k], `${k}=${v}: ${JSON.stringify(r)}`)
      assert.match(r.errors[k], /環境変数/)
      assert.equal(k in r.changes, false, '効かせない')
    }
    const add = cf.validateAddInput({ role: v, name: v, mode: 'simulator' })
    assert.equal(add.value, null)
    assert.ok(add.errors.role && add.errors.name, JSON.stringify(add.errors))
  }
  // Node-RED が置き換えない形は、ふつうの名前として受ける（判定を広げすぎない）
  for (const v of ['x${A}', '${A}x', '$A', '${a b}', '$()', '${}', '電力 $(1)']) {
    assert.deepEqual(cf.validateConfigInput({ name: v }).errors, {}, v)
    assert.equal(cf.validateConfigInput({ name: v }).changes.name, v)
  }
  // 手で書き換えた settings.json の値も効かせない
  assert.equal(cf.effectiveConfig({ name: '一階' }, { name: { value: '${X}' } }).name, '一階')
})

test('構成の検証: null は「画面の値を外す」・知らない項目・認証情報の項目・空の本文・オブジェクトでない本文', () => {
  const r1 = cf.validateConfigInput({ serialport: null, name: null })
  assert.deepEqual(r1.errors, {})
  assert.deepEqual(r1.changes, { serialport: null, name: null })
  const r2 = cf.validateConfigInput({ pollIntervalSec: 60, simulatorOptions: '{}' })
  assert.match(r2.errors.pollIntervalSec, /変えられません/)
  assert.match(r2.errors.simulatorOptions, /変えられません/)
  const r3 = cf.validateConfigInput({ routeBId: ID, routeBPassword: PW })
  assert.match(r3.errors.routeBId, /credentials/)
  assert.ok(!JSON.stringify(r3).includes(ID) && !JSON.stringify(r3).includes(PW), '理由の文に値を入れない')
  assert.match(cf.validateConfigInput({}).errors._, /変える項目がありません/)
  for (const b of [null, 'x', [1], 5]) assert.ok(cf.validateConfigInput(b).errors._, JSON.stringify(b))
})

test('構成の検証: serialport に simulator（GET serialports のシミュレータの候補）を渡すと mode を simulator にする', () => {
  const r = cf.validateConfigInput({ serialport: 'simulator' })
  assert.deepEqual(r.errors, {})
  assert.deepEqual(r.changes, { mode: 'simulator' }, 'ポートの値は変えない')
  const bad = cf.validateConfigInput({ serialport: 'simulator', mode: 'serial' })
  assert.match(bad.errors.serialport, /シミュレータ/)
})

test('エディタの値のそろえ方: 1.x のフロー（enabled・autoStart が無い）・空は null（既定）・寛容に読む', () => {
  const v = cf.configValuesFromNode({ name: '', role: ' 電力 ', mode: 'serial', serialport: '/dev/ttyUSB0', serialbaud: '115200', deviceKey: ' usb0 ', expectedMac: 'aabb', scanDurations: '4,5,x' })
  assert.equal(v.name, null)
  assert.equal(v.role, '電力')
  assert.equal(v.enabled, null)
  assert.equal(v.autoStart, null)
  assert.equal(v.serialbaud, 115200)
  assert.equal(v.deviceKey, 'usb0')
  assert.equal(v.expectedMac, 'AABB', 'そろえるだけで検証はしない（エディタの値はそのまま使う）')
  // シーケンサーは区切りの無い MAC と文字のまま比べるので、区切りを残すと同じ MAC でも「想定と違うアダプタ」になる。
  // 戻すと落ちるもの: config-fields.js の normalizeConfigField('expectedMac') で区切りを外さない
  for (const mac of ['00:1d:12:91:00:00:00:00', '00-1D-12-91-00-00-00-00', ' 001d-1291:00000000 ']) {
    assert.equal(cf.normalizeConfigField('expectedMac', mac), '001D129100000000', mac)
  }
  assert.equal(cf.normalizeConfigField('expectedMac', ' :-: '), null, '区切りだけなら未設定')
  assert.deepEqual(v.scanDurations, [4, 5], '1.x と同じく読めない要素は捨てる')
  const e = cf.effectiveConfig(v, null)
  assert.equal(e.enabled, true, '既定は有効')
  assert.equal(e.autoStart, true)
  assert.equal(e.name, null)
  assert.deepEqual(cf.effectiveConfig({}, null).scanDurations, [4, 5, 6, 7, 8])
})

test('効く値: 画面かフローで保存した値 > 設定ノード > 既定値。検証を通らない保存値（手で壊したなど）は効かせない', () => {
  // 戻すと落ちるもの: effectiveConfig で stored の値をそのまま使う
  const editor = cf.configValuesFromNode({ name: 'A', mode: 'serial', serialport: '/dev/ttyUSB0', serialbaud: 115200 })
  const e = cf.effectiveConfig(editor, { name: { value: 'B' }, serialbaud: { value: 999 }, deviceKey: { value: 'bad key' } })
  assert.equal(e.name, 'B')
  assert.equal(e.serialbaud, 115200, '表に無いボーレートは効かせない')
  assert.equal(e.deviceKey, null)
  assert.deepEqual(cf.changedFields(cf.effectiveConfig(editor, null), e), ['name'])
  assert.equal(cf.CONNECTION_FIELDS.join(','), 'mode,serialport,serialbaud,deviceKey,expectedMac')
})

// ---------------------------------------------------------------------------
//  settings-store の構成
// ---------------------------------------------------------------------------

function storeSetup() {
  const dir = tmpDir('wsuha-cfgstore-')
  const file = path.join(dir, 'wsuha-broute', 'settings.json')
  const logs = []
  const store = createSettingsStore({ file, log: (l, t) => logs.push([l, t]) })
  return { dir, file, store, logs }
}
const EDITOR = cf.configValuesFromNode({ name: '電力', mode: 'serial', serialport: '/dev/ttyUSB0', serialbaud: 115200, deviceKey: 'usb0' })

test('構成の保存: adapters[id].config に {value, configAtSet, by, at}。版（configRev）は運用設定の rev と別', () => {
  // 戻すと落ちるもの: settings-store.js の updateConfig で configAtSet を入れない・rev を運用設定と共にする
  const { file, store } = storeSetup()
  assert.equal(store.configRev('a'), '0')
  const s1 = store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: { pollIntervalSec: 30 }, by: 'web-ui' })
  const c1 = store.updateConfig('a', { ifMatch: '0', changes: { serialport: '/dev/ttyUSB1', name: '二階' }, configValues: EDITOR, by: 'web-ui' })
  assert.notEqual(c1.rev, '0')
  assert.equal(store.rev('a'), s1.rev, '構成を保存しても運用設定の rev は変わらない（開いている設定の欄を 412 にしない）')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(disk.adapters.a.config.serialport.value, '/dev/ttyUSB1')
  assert.equal(disk.adapters.a.config.serialport.configAtSet, '/dev/ttyUSB0', '保存したときの設定ノードの値')
  assert.equal(disk.adapters.a.config.serialport.by, 'web-ui')
  assert.equal(typeof disk.adapters.a.config.serialport.at, 'number')
  assert.equal(disk.adapters.a.configRev, c1.rev)
  assert.equal(disk.adapters.a.fields.pollIntervalSec.value, 60, '運用設定はそのまま')
  // 運用設定を保存しても構成の版は変わらない
  store.update('a', { ifMatch: s1.rev, changes: { pollIntervalSec: 90 }, configValues: {} })
  assert.equal(store.configRev('a'), c1.rev)
  // If-Match
  assert.throws(() => store.updateConfig('a', { ifMatch: '0', changes: { name: 'x' }, configValues: EDITOR }), RevisionMismatch)
  assert.throws(() => store.updateConfig('a', { ifMatch: s1.rev, changes: { name: 'x' }, configValues: EDITOR }), RevisionMismatch, '運用設定の rev では通らない')
  // 別のインスタンス（再起動）でも読める
  const again = createSettingsStore({ file })
  assert.equal(again.getConfig('a').fields.name.value, '二階')
})

test('運用設定を全部外しても構成は残し、構成を全部外しても運用設定は残す', () => {
  // 戻すと落ちるもの: settings-store.js の clear で記録を作り直す（config ごと消える）
  const { store } = storeSetup()
  const s1 = store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: {} })
  const c1 = store.updateConfig('a', { ifMatch: '0', changes: { serialbaud: 9600 }, configValues: EDITOR })
  store.clear('a', { ifMatch: s1.rev })
  assert.deepEqual(store.get('a').fields, {})
  assert.equal(store.getConfig('a').fields.serialbaud.value, 9600, '運用設定を外しても構成は残る')
  assert.equal(store.configRev('a'), c1.rev)
  const s2 = store.update('a', { ifMatch: store.rev('a'), changes: { pollIntervalSec: 45 }, configValues: {} })
  const c2 = store.clearConfig('a', { ifMatch: c1.rev, by: 'web-ui' })
  assert.deepEqual(c2.fields, {})
  assert.notEqual(c2.rev, c1.rev, '全部外しても版を進める（古い版の書き込みを断る）')
  assert.equal(store.get('a').fields.pollIntervalSec.value, 45, '構成を外しても運用設定は残る')
  assert.equal(store.rev('a'), s2.rev)
  assert.throws(() => store.updateConfig('a', { ifMatch: c1.rev, changes: { name: 'x' }, configValues: EDITOR }), RevisionMismatch)
})

test('構成の照合: エディタで後から変えた項目（configAtSet と違う）だけ外す', () => {
  const { store } = storeSetup()
  store.updateConfig('a', { ifMatch: '0', changes: { serialport: '/dev/ttyUSB1', name: '二階' }, configValues: EDITOR, by: 'web-ui' })
  assert.deepEqual(store.reconcileConfig('a', EDITOR, 'editor'), [], '同じ値のまま作り直しても外さない')
  const changed = Object.assign({}, EDITOR, { serialport: '/dev/ttyUSB2' })
  const dropped = store.reconcileConfig('a', changed, 'editor')
  assert.deepEqual(dropped.map((d) => d.field), ['serialport'])
  assert.equal(dropped[0].value, '/dev/ttyUSB1')
  assert.equal(dropped[0].configNow, '/dev/ttyUSB2')
  assert.deepEqual(Object.keys(store.getConfig('a').fields), ['name'])
  assert.equal(store.getConfig('a').updatedBy, 'editor')
})

test('壊れた構成の記録は読み飛ばし（warn）、同じ記録の運用設定は使う', () => {
  const { file, logs } = storeSetup()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, adapters: { a: { rev: 'r1', fields: { pollIntervalSec: { value: 60 } }, configRev: 'c1', config: { serialport: { value: null } } } } })
  )
  const store = createSettingsStore({ file, log: (l, t) => logs.push([l, t]) })
  assert.equal(store.get('a').fields.pollIntervalSec.value, 60)
  assert.deepEqual(store.getConfig('a').fields, {})
  assert.equal(store.configRev('a'), '0')
  assert.ok(logs.some(([l, t]) => l === 'warn' && /接続の設定/.test(t)), JSON.stringify(logs))
})

// ---------------------------------------------------------------------------
//  credentials-store
// ---------------------------------------------------------------------------

function credSetup() {
  const root = tmpDir('wsuha-cred-')
  const dir = path.join(root, 'wsuha-broute', 'credentials')
  const logs = []
  const store = createCredentialsStore({ dir, log: (l, t) => logs.push([l, t]) })
  return { root, dir, store, logs }
}

test('認証情報の保存: <dir>/<id>.json に書き、.tmp を残さない。settings.json は作らない。読んだ値は大文字', () => {
  const { root, dir, store } = credSetup()
  assert.equal(store.read('dev-1'), null)
  store.write('dev-1', { id: ID.toLowerCase(), password: PW.toLowerCase(), by: 'web-ui', editorFingerprint: () => 'none' })
  const file = path.join(dir, 'dev-1.json')
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.existsSync(file + '.tmp'), '.tmp を残さない')
  assert.ok(!fs.existsSync(path.join(root, 'wsuha-broute', 'settings.json')), '運用設定のファイルには入れない')
  const r = store.read('dev-1')
  assert.equal(r.id, ID)
  assert.equal(r.password, PW)
  assert.equal(r.by, 'web-ui')
  assert.deepEqual(store.info('dev-1'), { by: 'web-ui', at: r.at }, 'info に値は入らない')
  assert.ok(!JSON.stringify(store.info('dev-1')).includes(PW))
  // 別のインスタンス（再起動）でも読める
  assert.equal(createCredentialsStore({ dir }).read('dev-1').id, ID)
  assert.equal(store.remove('dev-1'), true)
  assert.equal(store.read('dev-1'), null)
  assert.equal(store.remove('dev-1'), false)
})

test('認証情報のファイル: ディレクトリ 700・ファイル 600（POSIX のみ）', { skip: process.platform === 'win32' ? 'Windows はファイルの権限ビットを持たない' : false }, () => {
  const { dir, store } = credSetup()
  store.write('dev-1', { id: ID, password: PW, by: 'web-ui' })
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.dirname(dir)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, 'dev-1.json')).mode & 0o777, 0o600)
})

test('壊れた認証情報のファイルは .bad-<日時> に退避し、ログに中身（JSON.parse の文）を出さない', () => {
  const { dir, store, logs } = credSetup()
  fs.mkdirSync(dir, { recursive: true })
  const FRAG = 'LEAKFRAGMENT9Q'
  fs.writeFileSync(path.join(dir, 'dev-2.json'), `id: ${FRAG}`)
  assert.equal(store.read('dev-2'), null)
  assert.ok(!fs.existsSync(path.join(dir, 'dev-2.json')))
  assert.ok(fs.readdirSync(dir).some((n) => /^dev-2\.json\.bad-/.test(n)), fs.readdirSync(dir).join(','))
  const text = JSON.stringify(logs)
  assert.ok(!text.includes(FRAG) && !/Unexpected token|is not valid JSON/.test(text), text)
  // 形の違うもの（パスワードが 12 桁でない）も退避
  fs.writeFileSync(path.join(dir, 'dev-3.json'), JSON.stringify({ version: 1, id: ID, password: 'SHORT', salt: 'x' }))
  assert.equal(store.read('dev-3'), null)
})

test('設定ノードの id をファイル名にするとき、/ や .. を入れない', () => {
  assert.equal(fileNameOf('a5e0d0c0b0a00100'), 'a5e0d0c0b0a00100.json')
  for (const id of ['../x', 'a/b', '..', 'dev 1', 'a\\b']) {
    const n = fileNameOf(id)
    assert.ok(/^[A-Za-z0-9_-]+\.json$/.test(n), `${id} → ${n}`)
  }
})

test('エディタの認証情報が片方だけなら入れ直しに数えない。保存した値を残し、あとで両方入れたらエディタが勝つ', () => {
  // 片方だけの値は使えないので、外すと動いている台の認証情報が無くなって計測が止まる。
  // 戻すと落ちるもの: credentials-store.js の reconcile で、エディタの値が両方そろっているかを見ない
  const EDITOR_ID = 'FEDCBA9876543210FEDCBA9876543210'
  const EDITOR_PW = 'ZYXWVU987654'
  const rows = [
    ['ID だけ空にした', EDITOR_ID, EDITOR_PW, '', EDITOR_PW],
    ['パスワードだけ空にした', EDITOR_ID, EDITOR_PW, EDITOR_ID, ''],
    ['空のまま保存して ID だけ入れた', '', '', EDITOR_ID, undefined],
    ['空のまま保存してパスワードだけ入れた', undefined, undefined, '   ', EDITOR_PW],
  ]
  for (const [what, savedId, savedPw, id, pw] of rows) {
    const logs = []
    const store = createCredentialsStore({ dir: path.join(tmpDir('wsuha-cred-'), 'credentials'), log: (l, t) => logs.push([l, t]) })
    store.write('dev-1', { id: ID, password: PW, by: 'web-ui', editorFingerprint: (salt) => fingerprint(salt, savedId, savedPw) })
    assert.equal(store.reconcile('dev-1', id, pw), false, what)
    assert.equal(store.read('dev-1').id, ID, what)
    assert.equal(store.read('dev-1').password, PW, what)
    assert.equal(logs.filter(([l, t]) => l === 'info' && /空か片方だけです/.test(t)).length, 1, what)
    assert.equal(store.reconcile('dev-1', id, pw), false, `${what}: 同じ値のデプロイでは何も起きない`)
    assert.equal(logs.length, 1, `${what}: 同じ値のデプロイで繰り返さない`)
    assert.equal(store.reconcile('dev-1', EDITOR_ID, EDITOR_PW), true, `${what}: 両方入れたらエディタが勝つ`)
    assert.equal(store.read('dev-1'), null, what)
  }
})

test('控えの指紋を書き換えられなくても、保存した値は外さない', () => {
  // 戻すと落ちるもの: credentials-store.js の reconcile で rewriteCredAtSet の失敗を受けない（設定ノードの起動が例外で止まる）
  const logs = []
  const dir = path.join(tmpDir('wsuha-cred-'), 'credentials')
  const store = createCredentialsStore({ dir, log: (l, t) => logs.push([l, t]) })
  store.write('dev-1', { id: ID, password: PW, by: 'web-ui', editorFingerprint: (salt) => fingerprint(salt, 'A', 'B') })
  fs.mkdirSync(path.join(dir, 'dev-1.json.tmp'))
  assert.equal(store.reconcile('dev-1', '', 'B'), false)
  assert.equal(store.read('dev-1').id, ID)
  assert.ok(logs.some(([l, t]) => l === 'warn' && /控えを書き換えられませんでした/.test(t)), JSON.stringify(logs))
})

test('シミュレーターを選ぶ本文の空の serialport は無視する（実機の欄が空のまま送られる形）', () => {
  // ポートの欄を空にしてからシミュレーターへ切り替えると、画面からもこの形が届く。隠れている欄の理由で断られていた。
  // 戻すと落ちるもの: config-fields.js の blankPortForSimulator を外す（追加と PUT のどちらか）
  for (const serialport of ['', '   ']) {
    const add = cf.validateAddInput({ role: 'x', mode: 'simulator', serialport })
    assert.deepEqual(add.errors, {}, JSON.stringify(serialport))
    assert.equal(add.value.mode, 'simulator')
    assert.equal(add.value.serialport, '')
    const put = cf.validateConfigInput({ mode: 'simulator', serialport })
    assert.deepEqual(put.errors, {})
    assert.deepEqual(put.changes, { mode: 'simulator' }, 'ポートの値は変えない')
  }
  // 実機のときは今までどおり断る
  assert.ok(cf.validateAddInput({ role: 'x', mode: 'serial', serialport: '' }).errors.serialport)
  assert.ok(cf.validateConfigInput({ mode: 'serial', serialport: '' }).errors.serialport)
  assert.ok(cf.validateConfigInput({ serialport: '' }).errors.serialport, '接続先を送らないときは今までどおり')
  // シミュレーターでも、書いてある値は確かめる
  assert.ok(cf.validateConfigInput({ mode: 'simulator', serialport: 'ttyUSB0' }).errors.serialport)
  assert.ok(cf.validateAddInput({ role: 'x', mode: 'simulator', serialport: 5 }).errors.serialport)
})

test('エディタで認証情報を入れ直したら（指紋が変わったら）、画面かフローで保存した値を外す', () => {
  // 戻すと落ちるもの: credentials-store.js の reconcile が指紋を比べない
  const { store } = credSetup()
  const EDITOR_ID = 'FEDCBA9876543210FEDCBA9876543210'
  const EDITOR_PW = 'ZYXWVU987654'
  store.write('dev-1', { id: ID, password: PW, by: 'web-ui', editorFingerprint: (salt) => fingerprint(salt, EDITOR_ID, EDITOR_PW) })
  assert.equal(store.reconcile('dev-1', EDITOR_ID, EDITOR_PW), false, '同じなら外さない')
  assert.equal(store.reconcile('dev-1', EDITOR_ID.toLowerCase(), EDITOR_PW), false, '大文字小文字は見ない')
  assert.ok(store.read('dev-1'))
  assert.equal(store.reconcile('dev-1', EDITOR_ID, 'ZYXWVU987650'), true, '入れ直したら外す')
  assert.equal(store.read('dev-1'), null)
  // エディタが空のまま保存 → エディタで入れたら外す
  store.write('dev-1', { id: ID, password: PW, by: 'web-ui', editorFingerprint: (salt) => fingerprint(salt, '', '') })
  assert.equal(store.reconcile('dev-1', undefined, undefined), false)
  assert.equal(store.reconcile('dev-1', EDITOR_ID, EDITOR_PW), true)
  // 指紋から値は分からない（塩つき。同じ値でもファイルごとに違う）
  assert.notEqual(fingerprint('s1', ID, PW), fingerprint('s2', ID, PW))
  assert.equal(fingerprint('s1', '', ''), 'none')
})

test('認証情報の検証: ID は 32 桁の 16 進数・パスワードは 12 桁の英数字。理由の文に値を入れない', () => {
  const ok = validateCredentialsInput({ routeBId: ID.toLowerCase(), routeBPassword: PW.toLowerCase() })
  assert.deepEqual(ok.errors, {})
  assert.equal(ok.id, ID)
  assert.equal(ok.password, PW)
  for (const body of [
    { routeBId: ID.slice(1), routeBPassword: PW },
    { routeBId: ID.slice(0, 31) + 'G', routeBPassword: PW },
    { routeBId: ID, routeBPassword: PW + '7' },
    { routeBId: ID, routeBPassword: 'ABCDEF12345!' },
    { routeBId: ID },
    { routeBId: ID, routeBPassword: PW, extra: ID },
    null,
  ]) {
    const r = validateCredentialsInput(body)
    assert.ok(Object.keys(r.errors).length, JSON.stringify(body))
    const text = JSON.stringify(r.errors)
    for (const secret of [ID, PW, ID.slice(1), PW + '7', 'ABCDEF12345!']) assert.ok(!text.includes(secret), text)
    assert.equal(r.id, undefined)
  }
})

// ---------------------------------------------------------------------------
//  EPC を名前で選ぶ
// ---------------------------------------------------------------------------

test('EPC の表: どの EPC にも desc と group がある（group は common・scheduled・info・other・history）', () => {
  // 戻すと落ちるもの: echonet.js の EPC の表から desc・group を外す
  for (const [k, m] of Object.entries(EL.EPC)) {
    assert.ok(typeof m.desc === 'string' && m.desc.length >= 4, `0x${Number(k).toString(16)} の desc`)
    assert.ok(['common', 'scheduled', 'info', 'other', 'history'].includes(m.group), `0x${Number(k).toString(16)} の group`)
  }
  assert.match(EL.EPC[0xe7].desc, /いま使っている電力/)
  assert.match(EL.EPC[0xe7].desc, /売電のときはマイナス/)
  for (const n of [0xe2, 0xe4, 0xec]) assert.equal(EL.EPC[n].group, 'history')
})

test('定期取得の候補: 履歴（E2・E4・EC）を入れない。まとまりの順（よく使う → 定時の積算 → メーターの情報 → そのほか）、よく使うは E7・E8・E0・E3', () => {
  const c = catalog.catalog()
  assert.deepEqual(c.groups.map((g) => g.id), ['common', 'scheduled', 'info', 'other'])
  assert.equal(c.groups[0].label, 'よく使う')
  const epcs = c.items.map((i) => i.epc)
  for (const h of ['0xE2', '0xE4', '0xEC']) assert.ok(!epcs.includes(h), h)
  assert.deepEqual(epcs.slice(0, 6), ['0xE7', '0xE8', '0xE0', '0xE3', '0xEA', '0xEB'])
  for (const want of ['0x80', '0x82', '0x88', '0x8A', '0x8D', '0x97', '0x98', '0xD3', '0xD7', '0xE1']) {
    assert.equal(c.items.find((i) => i.epc === want).group, 'info', want)
  }
  const e7 = c.items[0]
  assert.deepEqual(Object.keys(e7).sort(), ['desc', 'epc', 'group', 'label', 'name', 'unit'])
  assert.equal(e7.unit, 'W')
  // 並びの group が単調（まとまりごと）
  const order = c.items.map((i) => c.groups.findIndex((g) => g.id === i.group))
  assert.deepEqual(order, order.slice().sort((a, b) => a - b))
})

test('定期取得の選択肢: label は計測値の表と同じ短い名前で、name は規格の名前のまま。短い名前の無い EPC は null', () => {
  // 同じ値が設定タブでは「積算電力量計測値(正方向)」、計測値の表では「積算電力量（買電）」で、呼び名が割れていた。
  // 戻すと落ちるもの: epc-catalog.js の itemOf で label を付けない・name を短い名前に置き換える
  const of = (list, epc) => list.find((o) => o.epc === epc)
  for (const list of [catalog.pollEpcOptions(null), catalog.catalog().items]) {
    assert.equal(of(list, '0xE7').label, '瞬時電力')
    assert.equal(of(list, '0xE7').name, '瞬時電力計測値')
    assert.equal(of(list, '0xE0').label, '積算電力量（買電）')
    assert.equal(of(list, '0xE0').name, '積算電力量計測値(正方向)')
    assert.equal(of(list, '0xE3').label, '積算電力量（売電）')
    assert.equal(of(list, '0xEA').label, '定時積算（買電）')
    for (const o of list) {
      assert.equal(o.label, catalog.labelOf(o.epc), o.epc)
      if (o.label !== null) assert.ok(!/[()]/.test(o.label), '括弧は全角: ' + o.label)
    }
    assert.ok(list.some((o) => o.label === null), '短い名前の無い EPC もある（画面は name を出す）')
  }
})

test('SettingField.pollEpcs.options: supported は 0x9F に載っているか（マップが無ければ null）。5 分 / 30 分は取る値を名前で（takes）', () => {
  // 戻すと落ちるもの: view-model.js の buildSettings で options・takes を付けない
  const s = vm.buildSettings({ rec: null, configValues: {}, snap: { supportedEpcs: ['0xE7', '0xE8'], pollEpcs: ['0xE7'] }, options: null, rev: '0' })
  const opts = s.fields.pollEpcs.options
  assert.ok(Array.isArray(opts) && opts.length > 10)
  assert.deepEqual(Object.keys(opts[0]).sort(), ['desc', 'epc', 'group', 'label', 'name', 'supported', 'unit'])
  assert.equal(opts.find((o) => o.epc === '0xE7').supported, true)
  assert.equal(opts.find((o) => o.epc === '0xE0').supported, false)
  assert.ok(!opts.some((o) => ['0xE2', '0xE4', '0xEC'].includes(o.epc)))
  assert.deepEqual(s.fields.pollEpcs.groups.map((g) => g.id), ['common', 'scheduled', 'info', 'other'])
  const none = vm.buildSettings({ rec: null, configValues: {}, snap: null, options: null, rev: '0' })
  assert.equal(none.fields.pollEpcs.options[0].supported, null, 'マップが無ければ null')
  // 作り直した handle が覚えている 0x9F（supportedEpcs）を優先する
  const kept = vm.buildSettings({ rec: null, configValues: {}, snap: { supportedEpcs: [] }, options: null, rev: '0', supportedEpcs: ['0xE0'] })
  assert.equal(kept.fields.pollEpcs.options.find((o) => o.epc === '0xE0').supported, true)
  const slow = s.fields.slowIntervalSec.takes.map((t) => t.epc)
  assert.deepEqual(slow, ['0xE0', '0xE3', '0x88', '0x80'])
  assert.match(s.fields.slowIntervalSec.takes[0].name, /積算電力量/)
  assert.deepEqual(s.fields.halfHourIntervalSec.takes.map((t) => t.epc), ['0xEA', '0xEB'])
  assert.match(catalog.namesText([0xe0, 0x88]), /積算電力量計測値\(正方向\)（E0）・異常発生状態（88）/)
})

// ---------------------------------------------------------------------------
//  ポートの候補（by-id を先に）
// ---------------------------------------------------------------------------

test('SerialTransport.candidates: /dev/serial/by-id/… を先に、指す先（realPath）と、元のポートからの byIdPath', async () => {
  // 戻すと落ちるもの: serial-transport.js の candidates を外す・by-id を読まない
  const links = { '/dev/serial/by-id/usb-FTDI_A-if00-port0': '/dev/ttyUSB1', '/dev/serial/by-id/usb-FTDI_B-if00-port0': '/dev/ttyUSB0' }
  const fakeFs = {
    readdirSync: (d) => {
      assert.equal(d, '/dev/serial/by-id')
      return ['usb-FTDI_B-if00-port0', 'usb-FTDI_A-if00-port0']
    },
    realpathSync: (p) => links[p] || p,
  }
  const list = async () => [
    { path: '/dev/ttyUSB0', manufacturer: 'FTDI', serialNumber: 'B', vendorId: '0403', productId: '6015' },
    { path: '/dev/ttyUSB1', manufacturer: 'FTDI', serialNumber: 'A', vendorId: '0403', productId: '6015' },
    { path: '/dev/ttyS0' },
  ]
  const c = await SerialTransport.candidates({ list, fs: fakeFs })
  assert.deepEqual(c.map((x) => x.path), [
    '/dev/serial/by-id/usb-FTDI_A-if00-port0',
    '/dev/serial/by-id/usb-FTDI_B-if00-port0',
    '/dev/ttyUSB0',
    '/dev/ttyUSB1',
    '/dev/ttyS0',
  ])
  assert.equal(c[0].byId, true)
  assert.equal(c[0].realPath, '/dev/ttyUSB1')
  assert.equal(c[0].serialNumber, 'A', '指す先のポートの情報')
  assert.match(c[0].label, /ttyUSB1/)
  assert.equal(c[2].byId, false)
  assert.equal(c[2].byIdPath, '/dev/serial/by-id/usb-FTDI_B-if00-port0')
  assert.equal(c[4].byIdPath, null)
  // by-id が無い（Windows など）・列挙に失敗しても落ちない
  const none = await SerialTransport.candidates({
    list: async () => [{ path: 'COM3' }],
    fs: { readdirSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, realpathSync: (p) => p },
  })
  assert.deepEqual(none.map((x) => x.path), ['COM3'])
  assert.deepEqual(await SerialTransport.candidates({ list: async () => { throw new Error('x') }, byIdDir: null }), [])
})
