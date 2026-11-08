'use strict'

// view-model（lib/runtime/view-model.js）。許可リストで組み立てること、秘密を出さないこと。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const vm = require('../../lib/runtime/view-model')
const { createRegistry } = require('../../lib/runtime/registry')
const { ID, PW } = require('./fake-red')
const { makeAdapter, connect } = require('./adapter-kit')

const SUMMARY_KEYS = [
  'id', 'name', 'role', 'deviceKey', 'enabled', 'mode', 'port', 'portLabel', 'consumers',
  'phase', 'phaseText', 'phaseSince', 'health', 'running', 'portOpen', 'connected',
  'power', 'current', 'lastValueAt', 'stale', 'consecutiveFailures', 'ladder', 'overridden',
  'lqi', 'radioBlocked', 'keyBlocked', 'txBudgetMs',
  // フローの入力を、つながるまで預かっている数（一覧の行と状態タブ）
  'pendingCommands',
  // 名前を入れたか・つながらないときの案内・送信を休む線
  'named', 'connectHint', 'txGuardSec',
].sort()
const DETAIL_EXTRA = [
  'meter', 'device', 'calibration', 'join', 'counters', 'sendFails', 'pollIntervalSec', 'pollEpcs',
  'snaHold', 'supportedEpcs', 'wopt', 'lastError', 'credentials', 'recordingSince', 'libVersion',
]
const VALUE_ROW_KEYS = ['epc', 'key', 'name', 'label', 'value', 'unit', 'display', 'at', 'meterAt', 'fresh', 'held', 'supported'].sort()
const IDHINT = ID.slice(0, 4) + '…' + ID.slice(-4)

/** 秘密が文字列のどこにも無いこと。大文字・小文字の両方で探す。 */
function assertNoSecrets(text, where) {
  const s = String(text)
  for (const x of [ID, PW, ID.toLowerCase(), PW.toLowerCase(), IDHINT]) {
    assert.ok(!s.includes(x), `${where} に秘密（${x.slice(0, 4)}…）が出ている`)
  }
  assert.ok(!/idHint/.test(s), `${where} に idHint の項目がある`)
}

test('接続した 1 台の全部の形に、認証 ID・パスワード・idHint が出ない', async () => {
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'vm1')
  await connect(seq)
  await seq.get([0xe7, 0xe8], 'test')
  // 秘密を含む文字列を、見せる経路に流し込んでみる（ログ・停止の理由・直近のエラー）
  seq._log('warn', `わざと ID=${ID} PW=${PW}`)
  await seq.stop(`理由 ${PW}`, { external: true })
  seq.state.lastError = { message: 'エラー ' + ID, at: Date.now() }

  const snap = seq.snapshot()
  assert.ok(snap.credentials.idHint, '前提: snapshot には idHint がある（だから許可リストで組む）')

  const input = h.inspect()
  const now = Date.now()
  const summary = vm.buildSummary(input, now)
  const detail = vm.buildDetail(input, now)
  const rows = vm.buildValueRows(input, now)
  const settings = vm.buildSettings({ rec: null, configValues: h.configValues, snap, options: seq.options, enabled: true })
  const logs = h.logsAfter({ after: 0, limit: 1000 })
  for (const [name, v] of Object.entries({ summary, detail, rows, settings, logs })) {
    assertNoSecrets(JSON.stringify(v), name)
  }
  assert.equal(detail.overridden.stopped.reason, '理由 ********', '停止の理由も伏せ字')
  assert.equal(detail.lastError.message, 'エラー ********')
  assert.equal(detail.credentials.pairId, ID.slice(-8), 'PairID（ID の下 8 桁）は出してよい')
  assert.equal(detail.credentials.configured, true)
  await seq.destroy()
})

test('Summary・Detail・ValueRow は許可した項目だけ', async () => {
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'vm2')
  await connect(seq)
  await seq.get([0xe7, 0xe8], 'test')
  const input = h.inspect()
  const now = Date.now()
  const s = vm.buildSummary(input, now)
  assert.deepEqual(Object.keys(s).sort(), SUMMARY_KEYS)
  const d = vm.buildDetail(input, now)
  assert.deepEqual(Object.keys(d).sort(), SUMMARY_KEYS.concat(DETAIL_EXTRA).sort())
  assert.deepEqual(Object.keys(d.meter).sort(), ['addr', 'channel', 'channelMHz', 'ipv6', 'lqi', 'lqiAt', 'pairId', 'panid', 'rssi'])
  assert.deepEqual(Object.keys(d.credentials).sort(), ['configured', 'pairId', 'source'])
  assert.deepEqual(Object.keys(d.health).sort(), ['level', 'nextAction', 'reasons', 'title'])

  assert.equal(s.health.level, 'ok')
  assert.equal(s.phase, 'connected')
  assert.equal(typeof s.power.value, 'number')
  assert.equal(typeof s.current.r, 'number')
  assert.equal(s.current.total, Math.round((s.current.r + s.current.t) * 10) / 10)
  assert.deepEqual(d.pollEpcs, ['0xE7', '0xE8'], "EPC は '0xE7' の形")
  assert.ok(d.supportedEpcs.every((x) => /^0x[0-9A-F]{2}$/.test(x)))

  const rows = vm.buildValueRows(input, now)
  assert.ok(rows.length > 3)
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), VALUE_ROW_KEYS)
  const e7 = rows.find((r) => r.epc === '0xE7')
  assert.equal(e7.key, 'instantPower')
  assert.equal(e7.unit, 'W')
  assert.equal(e7.fresh, true)
  assert.equal(e7.held, null)
  const d3 = rows.find((r) => r.epc === '0xD3')
  assert.equal(d3.fresh, true, '接続時に 1 回だけ取る値は古くならない')
  assert.deepEqual(rows.map((r) => r.epc), rows.map((r) => r.epc).slice().sort(), 'EPC の順')
  await seq.destroy()
})

test('AdapterDetail.recordingSince: 最初に claim した時刻。無ければ null', async () => {
  // 動いている Node-RED に足した台は、足す前の時間に記録が無い。画面はこの時刻より前を途切れに数えない。
  // 戻すと落ちるもの: view-model.js の buildDetail か registry.js の inspect から recordingSince を外す
  const reg = createRegistry()
  const t0 = Date.now()
  const { h, seq } = makeAdapter(reg, 'vm-rec')
  const d = vm.buildDetail(h.inspect(), Date.now())
  assert.ok(d.recordingSince >= t0 && d.recordingSince <= Date.now(), String(d.recordingSince))
  assert.ok(!('recordingSince' in vm.buildSummary(h.inspect(), Date.now())), '一覧の形は増やさない')
  assert.equal(vm.buildDetail({ id: 'x', meta: {}, snap: null, consumers: 0 }, Date.now()).recordingSince, null)
  await seq.destroy()
})

test('定時積算の確定の時刻は、サーバーの時刻帯に関係なく日本時間で読む', () => {
  // メーターの時計は日本時間。サーバーの時刻帯で読むと、TZ が日本でないサーバーで画面も read も 9 時間ずれる。
  // 戻すと落ちるもの: view-model.js の stampMs を new Date(年, 月, …) に戻す（TZ=UTC の側が落ちる）
  const script = `
    const vm = require(${JSON.stringify(require.resolve('../../lib/runtime/view-model'))})
    const v = { timestamp: '2026-11-07 08:00:00', display: '2026-11-07 08:00:00 / 41582.7 kWh' }
    const a = vm.splitStamp(v, v.display)
    const b = vm.splitStamp({}, v.display)
    process.stdout.write(JSON.stringify([a.meterAt, b.meterAt, a.display, vm.stampText(a.meterAt)]))
  `
  const want = Date.UTC(2026, 10, 6, 23, 0, 0)
  for (const TZ of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
    const out = execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ }), encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), [want, want, '41582.7 kWh', '2026-11-07 08:00'], TZ)
  }
  // 日をまたぐ時刻（日本時間の 0 時台は UTC の前の日）
  assert.equal(vm.splitStamp({ timestamp: '2026-01-01 00:30:00' }, '').meterAt, Date.UTC(2025, 11, 31, 15, 30, 0))
  assert.equal(vm.stampText(Date.UTC(2025, 11, 31, 15, 30, 0)), '2026-01-01 00:30')
})

test('控えている EPC・持っていない EPC・古い値の印', () => {
  const now = 1_800_000_000_000
  const input = {
    id: 'x',
    meta: { enabled: true },
    snap: {
      phase: 'connected',
      connected: true,
      running: true,
      portOpen: true,
      pollIntervalSec: 30,
      pollEpcs: [0xe7, 0xe8],
      supportedEpcs: ['0x80', '0xE7'],
      snaHold: { '0xE8': { count: 2, until: now + 60000, at: now }, '0xE0': { count: 1, until: now - 1, at: now - 10 } },
      known: { '0xE7': { name: '瞬時電力計測値', value: 436, display: '436 W', unit: 'W', at: now - 200000 } },
    },
    phaseSince: now - 500000,
  }
  const rows = vm.buildValueRows(input, now)
  const e7 = rows.find((r) => r.epc === '0xE7')
  const e8 = rows.find((r) => r.epc === '0xE8')
  assert.equal(e7.fresh, false, '取得間隔 × 3 + 30 秒より古い')
  assert.equal(e7.supported, true)
  assert.deepEqual(e8.held, { until: now + 60000, count: 2 }, '控えている間')
  assert.equal(e8.value, null, 'まだ値が無い定期取得の EPC も行を出す')
  assert.equal(e8.supported, false, '0x9F に載っていない')
  assert.equal(rows.find((r) => r.epc === '0xE0').held, null, '期限が過ぎた控えは出さない')

  const s = vm.buildSummary(input, now)
  assert.equal(s.stale, true)
  assert.equal(s.health.level, 'stale')
  input.snap.supportedEpcs = []
  assert.equal(vm.buildValueRows(input, now)[0].supported, null, 'マップが無ければ null')
})

test('繋がった直後は、前回の値が古くても stale にしない', () => {
  const now = 1_800_000_000_000
  const input = {
    id: 'x',
    meta: { enabled: true },
    snap: { phase: 'connected', connected: true, running: true, portOpen: true, pollIntervalSec: 30, lastValueAt: now - 3600000 },
    phaseSince: now - 1000,
  }
  assert.equal(vm.buildSummary(input, now).stale, false)
})

test('sequencer が無い（無効・初期化前）ときも形を返す', () => {
  const s = vm.buildDetail({ id: 'off', meta: { enabled: false, name: '無効の台' }, snap: null, consumers: 0 }, Date.now())
  assert.equal(s.health.level, 'disabled')
  assert.equal(s.phase, 'disabled')
  assert.equal(s.phaseText, '無効')
  assert.equal(s.power.value, null)
  assert.deepEqual(s.pollEpcs, ['0xE7', '0xE8'])
  assert.deepEqual(Object.keys(s).sort(), SUMMARY_KEYS.concat(DETAIL_EXTRA).sort())
})

test('health に、初期化の失敗（buildError）と有効を外した所（enabledBy）を渡す。形の項目は増やさない', () => {
  // 戻すと落ちるもの: view-model.js の buildSummary で buildError・enabledBy を health に渡さない
  const err = vm.buildDetail(
    { id: 'np', meta: { enabled: true, name: 'ポートなし', mode: 'serial', port: '' }, snap: null, consumers: 0, buildError: { message: 'シリアルポートのパスが指定されていません', at: 1 } },
    Date.now()
  )
  assert.equal(err.phase, 'error')
  assert.equal(err.health.level, 'bad')
  assert.equal(err.health.title, 'アダプタを初期化できませんでした')
  assert.deepEqual(err.health.reasons, ['シリアルポートのパスが指定されていません'])
  assert.deepEqual(Object.keys(err).sort(), SUMMARY_KEYS.concat(DETAIL_EXTRA).sort())
  const off = vm.buildDetail(
    { id: 'off2', meta: { enabled: false, name: '画面で無効' }, enabledBy: { source: 'runtime', by: 'web-ui', label: '画面' }, snap: null, consumers: 0 },
    Date.now()
  )
  assert.equal(off.health.level, 'disabled')
  assert.deepEqual(off.health.reasons, ['画面で無効にしています。ポートは開きません'])
  assert.deepEqual(Object.keys(off).sort(), SUMMARY_KEYS.concat(DETAIL_EXTRA).sort())
})

test('一覧は重い順、同じなら名前の順', () => {
  const mk = (id, name, level) => ({ id, name, health: { level } })
  const out = vm.sortSummaries([mk('1', 'い', 'ok'), mk('2', 'あ', 'ok'), mk('3', 'う', 'bad'), mk('4', 'え', 'disabled')])
  assert.deepEqual(out.map((x) => x.id), ['3', '2', '1', '4'])
})

test('Settings の出どころ: 上書き → 運用設定 → 設定ノード → 既定値', () => {
  const rec = {
    rev: 'r9',
    fields: { pollIntervalSec: { value: 60, configAtSet: 30, by: 'dev', at: 123 }, slowIntervalSec: { value: 600, configAtSet: null } },
  }
  const snap = { pollIntervalSec: 45, pollEpcs: [0xe7], overrides: { pollIntervalSec: 45, pollEpcs: null } }
  const s = vm.buildSettings({
    rec,
    configValues: { pollIntervalSec: '30', pollEpcs: 'E7, E8', slowIntervalSec: null, halfHourIntervalSec: null },
    snap,
    options: { slowIntervalSec: 600, halfHourIntervalSec: 1800 },
    enabled: true,
  })
  assert.equal(s.rev, 'r9')
  assert.equal(s.fields.pollIntervalSec.source, 'override')
  assert.equal(s.fields.pollIntervalSec.value, 45)
  assert.equal(s.fields.pollIntervalSec.configValue, 30)
  assert.equal(s.fields.pollIntervalSec.by, 'dev')
  assert.equal(s.fields.pollIntervalSec.min, 15)
  assert.equal(s.fields.pollIntervalSec.max, 3600)
  assert.equal(s.fields.pollIntervalSec.unit, '秒')
  assert.equal(s.fields.pollEpcs.source, 'config')
  assert.deepEqual(s.fields.pollEpcs.configValue, ['0xE7', '0xE8'])
  assert.equal(s.fields.slowIntervalSec.source, 'runtime')
  assert.equal(s.fields.halfHourIntervalSec.source, 'default')
  assert.equal(s.fields.halfHourIntervalSec.value, 1800)
  assert.equal(s.fields.halfHourIntervalSec.default, 1800)
  assert.ok(s.warnings.some((w) => /一時的な上書き/.test(w)))
  // 12.2: runtimeValue は運用設定そのものの値（上書きの下にあっても）。無ければ null
  // 戻すと落ちるもの: view-model.js の buildSettings で runtimeValue を入れない
  assert.equal(s.fields.pollIntervalSec.runtimeValue, 60, '上書き（45）の下の運用設定')
  assert.equal(s.fields.slowIntervalSec.runtimeValue, 600)
  assert.equal(s.fields.pollEpcs.runtimeValue, null)
  assert.equal(s.fields.halfHourIntervalSec.runtimeValue, null)
  const e = vm.buildSettings({ rec: { rev: 'r1', fields: { pollEpcs: { value: ['0xe7', 0xe8], configAtSet: null } } }, snap, options: {}, enabled: true })
  assert.deepEqual(e.fields.pollEpcs.runtimeValue, ['0xE7', '0xE8'], 'EPC は value と同じ書き方（0xE7）にそろえる')
})

test('認証情報が無い台は、health が「認証情報がありません」になる（view-model が credentials.configured を渡す）', async () => {
  // 戻すと落ちるもの: view-model.js の buildSummary から health へ credentials を渡すのをやめる
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'vm-nocred', { credentials: false })
  try {
    await seq.transport.open()
    await seq.start() // 認証情報が無いので need-secrets で止まる
    const d = vm.buildDetail(h.inspect(), Date.now())
    assert.equal(d.credentials.configured, false)
    assert.equal(d.health.level, 'idle')
    assert.equal(d.health.title, '認証情報がありません')
    assert.equal(d.health.nextAction, '設定タブの「B ルートの認証 ID とパスワード」で入れてください（設定ノードか環境変数でも入れられます）')
    assert.equal(vm.buildSummary(h.inspect(), Date.now()).health.title, '認証情報がありません', '一覧も同じ')
    // sequencer が無い（分からない）ときは決めつけない
    const off = vm.buildSummary({ id: 'x', meta: { enabled: true }, snap: null }, Date.now())
    assert.equal(off.health.title, '停止')
  } finally {
    await seq.destroy()
  }
})

test('sequencer の無い台（無効・初期化の失敗）でも、認証情報を入れてあれば configured は true。Config と食い違わない', () => {
  // 状態タブの「未設定」と「はじめに」の「まだ入れていません」が、入れてある台に出ていた。
  // 戻すと落ちるもの: view-model.js の buildDetail で credentialState を見ない
  const now = 1_800_000_000_000
  const base = { id: 'x', snap: null, pairId: '89ABCDEF', credentialSource: '設定ノード' }
  for (const over of [{ meta: { enabled: false } }, { meta: { enabled: true }, buildError: { message: 'シリアルポートのパスが指定されていません', at: now } }]) {
    const d = vm.buildDetail(Object.assign({}, base, over, { credentialState: { configured: true, envOverrides: false } }), now)
    assert.deepEqual(d.credentials, { configured: true, source: '設定ノード', pairId: '89ABCDEF' }, JSON.stringify(over))
    const none = vm.buildDetail(Object.assign({}, base, over, { credentialState: { configured: false } }), now)
    assert.deepEqual(none.credentials, { configured: false, source: '設定ノード', pairId: null }, '入れていなければ false で PairID も出さない')
  }
  // 設定ノードの状態が無ければ sequencer の値
  const noState = (snap) => vm.buildDetail(Object.assign({}, base, { meta: {}, snap }), now).credentials.configured
  assert.equal(noState({ phase: 'idle', credentials: { configured: true } }), true)
  assert.equal(noState({ phase: 'idle', credentials: { configured: false } }), false)
  assert.equal(noState(null), false)
  // 開き直す前（sequencer は前の値のまま）でも、保存した値で答える
  const fresh = vm.buildDetail(Object.assign({}, base, { meta: {}, snap: { phase: 'idle', credentials: { configured: false } }, credentialState: { configured: true } }), now)
  assert.equal(fresh.credentials.configured, true)
})

test('handle の inspect の credentialState: 無効にして sequencer を外しても残る。値は configured と envOverrides だけ', async () => {
  // 戻すと落ちるもの: registry.js の inspect() に credentialState を足さない・そのまま写す
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'vm-cs')
  h.updateInfo({ credentialState: { configured: true, envOverrides: true, routeBId: ID } })
  h.detach(seq)
  const input = h.inspect()
  assert.equal(input.snap, null)
  assert.deepEqual(input.credentialState, { configured: true, envOverrides: true })
  assertNoSecrets(JSON.stringify(input), 'inspect')
  assert.equal(vm.buildDetail(input, Date.now()).credentials.configured, true)
  assert.equal(vm.buildDetail(input, Date.now()).credentials.pairId, ID.slice(-8))
  await seq.destroy()
})

test('connectHint: sequencer の値を許可リストで写す。つながっていれば null。直近のエラーの文言からは推さない', () => {
  // 文言で推すと、次の失敗で lastError が上書きされて案内が出たり消えたりする。
  // 戻すと落ちるもの: view-model.js の connectHintOf に文言の照らし合わせを戻す
  const now = 1_800_000_000_000
  const input = (snap) => ({ id: 'x', meta: { enabled: true }, snap: Object.assign({ phase: 'joining', running: true, portOpen: true, connected: false }, snap) })
  const s = vm.buildSummary(input({ connectHint: { kind: 'credentials', since: now - 60000, rounds: 2.9, secret: PW } }), now)
  assert.deepEqual(s.connectHint, { kind: 'credentials', since: now - 60000, rounds: 2 })
  assert.match(s.health.nextAction, /電波が弱い/)
  assert.deepEqual(vm.buildSummary(input({ connectHint: { kind: 'no-meter', since: now, rounds: 1 } }), now).connectHint, { kind: 'no-meter', since: now, rounds: 1 })
  assert.equal(vm.buildSummary(input({ connected: true, connectHint: { kind: 'no-meter', since: now, rounds: 1 } }), now).connectHint, null)
  assert.equal(vm.buildSummary(input({ connectHint: null }), now).connectHint, null)
  assert.equal(vm.buildSummary(input({ connectHint: { kind: 'other' } }), now).connectHint, null)
  // 鍵が無くても文言から推さない
  for (const message of ['メーターとの認証が 31 分通りません。メーターを探し直します', 'メーターが見つかりませんでした。認証 ID が正しいか、アダプタとメーターの距離を確かめてください']) {
    const r = vm.buildSummary(input({ phase: 'scanning', lastError: { message, at: now } }), now)
    assert.equal(r.connectHint, null, message)
  }
})

test('health へ直近のエラーの code を渡す（serialport の案内は code で分けるので、途中で落とすと USB の切断に戻る）', () => {
  // 戻すと落ちるもの: view-model.js の buildSummary で lastError の code を health に渡さない
  const now = 1_800_000_000_000
  const snap = { phase: 'opening', running: true, portOpen: false, connected: false, lastError: { message: 'serialport を読み込めません。', code: 'SERIALPORT_MISSING', at: now } }
  const s = vm.buildSummary({ id: 'x', meta: { enabled: true, port: '/dev/ttyUSB0' }, snap }, now)
  assert.equal(s.health.title, 'serialport が入っていません')
  const d = vm.buildDetail({ id: 'x', meta: { enabled: true, port: '/dev/ttyUSB0' }, snap }, now)
  assert.match(d.lastError.hint, /npm install serialport@12/)
  assert.deepEqual(Object.keys(d.lastError).sort(), ['at', 'hint', 'message'], '画面に出す形は増やさない')
})

test('値の表の名前は日本語（値がまだ無い・控えている EPC も、英語のキーを名前にしない）', () => {
  // E2E で見つけた: 0x81 が Get_SNA で控えに回ると、名前が「installationLocation」と英語のまま出た。
  // 戻すと落ちるもの: view-model.js の makeRow の名前の既定を normalize の MAP のキーに戻す
  const EL = require('../../lib/echonet')
  const now = 1_800_000_000_000
  const all = Object.keys(EL.EPC).map(Number)
  const snaHold = {}
  for (const n of all) snaHold[vm.epcHex(n)] = { count: 1, until: now + 60000, at: now }
  const input = { id: 'x', meta: { enabled: true }, snap: { phase: 'connected', connected: true, running: true, portOpen: true, pollEpcs: [0xe7], snaHold, known: {} } }
  const rows = vm.buildValueRows(input, now)
  assert.equal(rows.length, all.length)
  const row81 = rows.find((r) => r.epc === '0x81')
  assert.equal(row81.name, '設置場所')
  assert.equal(row81.key, 'installationLocation', 'key（正規化のキー）は英語のまま')
  for (const r of rows) {
    assert.ok(/[ぁ-んァ-ヶ一-龠]/.test(r.name), `${r.epc} の名前が日本語でない: ${r.name}`)
    assert.ok(!/^[A-Za-z]+$/.test(r.name), `${r.epc} の名前が英語のキー: ${r.name}`)
  }
  // 知らない EPC は「不明な EPC」と番号
  const unknown = vm.buildValueRows({ id: 'x', meta: {}, snap: { pollEpcs: [0xf5], known: {} } }, now)
  assert.equal(unknown[0].name, '不明な EPC 0xF5')
})

test('EPC の名前の表: 機器オブジェクトのスーパークラスと低圧スマート電力量メータ（0x0288）を一通り日本語で持つ', () => {
  // 計測値の表・診断の「任意の EPC」で、0x83 などを聞いたときに「不明なEPC」と出さないため。
  // 出典: ECHONET 機器オブジェクト詳細規定（スーパークラス 0x80〜0x9F・クラス 0x0288）
  const EL = require('../../lib/echonet')
  const SUPER = [0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
    0x93, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f]
  const METER = [0xd3, 0xd7, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe7, 0xe8, 0xea, 0xeb, 0xec, 0xed]
  for (const n of SUPER.concat(METER)) {
    const m = EL.EPC[n]
    assert.ok(m, `0x${n.toString(16).toUpperCase()} が表に無い`)
    assert.ok(/[ぁ-んァ-ヶ一-龠]/.test(m.name), `0x${n.toString(16).toUpperCase()} の名前が日本語でない: ${m.name}`)
  }
  // 足した名前でも、値の読み方（decode）は今までどおり落ちずに生データを返す
  const v = EL.decode(0x83, Buffer.from('FE00000000000000000000000000000000', 'hex'), {})
  assert.equal(v.name, '識別番号')
  assert.equal(typeof v.display, 'string')
})

test('エディタで外れた項目（照合の dropped）は、by が editor・at が外した時刻。出どころは設定ノードのまま。上書きの掛かった項目には付けない', () => {
  // 画面では「エディタ」と出す。照合は記録から項目を消すので、前は by / at が null のままだった。
  // 戻すと落ちるもの: view-model.js の buildSettings で dropped の項目に by: 'editor' と at を入れない
  const at = 1793900000000
  const snap = { pollIntervalSec: 90, pollEpcs: [0xe7], overrides: { pollIntervalSec: 90, pollEpcs: null } }
  const s = vm.buildSettings({
    rec: { rev: 'r2', fields: {} },
    configValues: { pollIntervalSec: 45, pollEpcs: 'E7', slowIntervalSec: null, halfHourIntervalSec: null },
    snap,
    options: { slowIntervalSec: 300, halfHourIntervalSec: 1800 },
    enabled: true,
    dropped: [
      { field: 'pollEpcs', value: ['0xE7', '0xE8'], configAtSet: null, configNow: ['0xE7'], at },
      { field: 'slowIntervalSec', value: 600, configAtSet: null, configNow: null, at },
      { field: 'pollIntervalSec', value: 60, configAtSet: 30, configNow: 45, at },
    ],
  })
  assert.equal(s.fields.pollEpcs.source, 'config')
  assert.equal(s.fields.pollEpcs.by, 'editor')
  assert.equal(s.fields.pollEpcs.at, at)
  assert.equal(s.fields.pollEpcs.runtimeValue, null, '運用設定はもう無い')
  assert.equal(s.fields.slowIntervalSec.source, 'default', '設定ノードが空なら既定値')
  assert.equal(s.fields.slowIntervalSec.by, 'editor')
  assert.equal(s.fields.slowIntervalSec.at, at)
  // 上書きの掛かった項目: by / at を付けると、画面は「上書きの下に運用設定あり」と読む
  assert.equal(s.fields.pollIntervalSec.source, 'override')
  assert.equal(s.fields.pollIntervalSec.by, null)
  assert.equal(s.fields.pollIntervalSec.at, null)
  // 外していない項目は今までどおり
  assert.equal(s.fields.halfHourIntervalSec.by, null)
  assert.equal(s.fields.halfHourIntervalSec.at, null)
  assert.equal(s.warnings.filter((w) => /外しました/.test(w)).length, 3, '注意の文も今までどおり')
  // 運用設定がある項目は、その by / at（照合の記録より運用設定を優先）
  const r = vm.buildSettings({
    rec: { rev: 'r3', fields: { pollEpcs: { value: ['0xE7', '0xE3'], configAtSet: ['0xE7'], by: 'web-ui', at: at + 1 } } },
    configValues: { pollEpcs: 'E7' },
    snap: { pollIntervalSec: 30, pollEpcs: [0xe7, 0xe3], overrides: { pollIntervalSec: null, pollEpcs: null } },
    options: {},
    enabled: true,
    dropped: [{ field: 'pollEpcs', value: ['0xE7', '0xE8'], configAtSet: null, configNow: ['0xE7'], at }],
  })
  assert.equal(r.fields.pollEpcs.source, 'runtime')
  assert.equal(r.fields.pollEpcs.by, 'web-ui')
  assert.equal(r.fields.pollEpcs.at, at + 1)
})

test('pendingCommands: handle の預かりの数といちばん古いものの待ち時間。0 件なら oldestMs は null', () => {
  // 戻すと落ちるもの: view-model.js の buildSummary に pendingCommands を入れない・0 件で oldestMs を出す
  const base = { id: 'pc', meta: { name: 'x', enabled: true }, snap: null }
  assert.deepEqual(vm.buildSummary(base, 1).pendingCommands, { count: 0, oldestMs: null }, '項目が無い入力（古い handle）')
  assert.deepEqual(vm.buildSummary(Object.assign({ pending: { count: 3, oldestMs: 4500 } }, base), 1).pendingCommands, { count: 3, oldestMs: 4500 })
  assert.deepEqual(vm.buildDetail(Object.assign({ pending: { count: 0, oldestMs: 99 } }, base), 1).pendingCommands, { count: 0, oldestMs: null })
})
