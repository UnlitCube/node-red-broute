'use strict'

// 構成の変更を設定ノード（wsuha-device）と wsuha-broute で確かめる:
//
//  - 効かせ方: 接続に関わる項目（mode・serialport・serialbaud・deviceKey・expectedMac・認証情報）が変わったら、その台だけ
//    SKTERM してポートを閉じ、新しい値で開き直す。AdapterHandle は同じ・wsuha-broute の購読は切れない・上書きは引き継ぐ。
//    名前・契約・自動開始・スキャン時間は開き直さない。有効を外すと閉じ、入れると開く。
//  - 開き直しの最中の次の変更は 409 BUSY（待たない）。
//  - wsuha-broute の入力 config・config-reset・get-config・credentials・credentials-reset・serialports と、出力 2 の config。
//  - 認証情報の優先: 環境変数 > 画面かフローで保存した値 > 設定ノード > 秘密ファイル。値はどこにも出さない。
//  - エディタで後から変えた項目は画面の値を外す（configAtSet）。エディタ用の GET device/:id/config。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { SerialTransport } = require('../../lib/serial-transport')
const { waitFor, parseSse, tmpDir, ID, PW } = require('../runtime/fake-red')
const { createKit, input, out2, connected } = require('./node-kit')

const kit = createKit()
const { setup, createBroute, speedUp } = kit
const B = '/wsuha-broute/api/v1'

afterEach(async () => {
  await kit.cleanup()
  for (const k of Object.keys(process.env)) if (/^WSUHA_BROUTE_(ID|PASSWORD)_CFGENV/.test(k)) delete process.env[k]
})

/** 設定ノードを作り、開き直しで作る sequencer の待ち時間も詰める。 */
function createDevice(fake, id, extra) {
  const dev = kit.createDevice(fake, id, extra)
  const orig = dev._build
  dev._build = function () {
    const had = dev.sequencer
    const r = orig.call(dev)
    if (dev.sequencer && dev.sequencer !== had) speedUp(dev.sequencer)
    return r
  }
  return dev
}

const measurements = (node) => node._sent.filter((m) => Array.isArray(m) && m[0]).map((m) => m[0])
const skterms = (seq) => seq.transport.sent.filter((c) => /^SKTERM/.test(c)).length

async function getConfig(fake, id) {
  const r = await fake.request('GET', `${B}/adapters/${id}/config`)
  assert.equal(r.statusCode, 200, r.text)
  return r.body
}

async function putConfig(fake, id, body) {
  const rev = (await getConfig(fake, id)).rev
  return fake.request('PUT', `${B}/adapters/${id}/config`, { body, headers: { 'if-match': rev } })
}

async function settled(dev) {
  await waitFor(() => !dev.handle.reconfiguring, 15000, '開き直しの終わり')
}

/** 秘密（認証 ID・パスワード・idHint）が出ないこと。 */
function assertNoSecrets(text, what) {
  for (const x of [ID, PW, ID.toLowerCase(), PW.toLowerCase(), ID.slice(0, 4) + '…' + ID.slice(-4)]) {
    assert.ok(!text.includes(x), `${what} に秘密（${x.slice(0, 4)}…）が出ている`)
  }
}

function noCredConfig(kitObj, id, key) {
  return kitObj.devConfig(id, { deviceKey: key, _credentials: undefined })
}

/** パスワードだけの設定ノードの config。そろっていないので動かず、シミュレーターの架空の値にも置き換わらない。 */
function halfCredConfig(kitObj, id, key) {
  return kitObj.devConfig(id, { deviceKey: key, _credentials: { routeBPassword: 'ZYXWVU987654' } })
}

// ---------------------------------------------------------------------------
//  開き直し
// ---------------------------------------------------------------------------

test('接続に関わる項目（deviceKey）を画面から変えると、その台だけ SKTERM して開き直す。handle は同じ・購読は切れない・上書きは引き継ぐ', async () => {
  // 戻すと落ちるもの: wsuha-device.js の _reconfigure で開き直さない（_close → _open）・handle を作り直す・
  //                   registry の detach / attach で上書きを持ち越さない
  const fake = setup()
  const dev = createDevice(fake, 'cfg-re')
  const other = createDevice(fake, 'cfg-re-other')
  const b = createBroute(fake, 'cfg-re', { name: '記録' })
  const bo = createBroute(fake, 'cfg-re-other')
  await connected(dev)
  await connected(other)
  await input(b, { topic: 'interval', payload: 60 }) // 一時的な上書き
  const h = dev.handle
  const seq1 = dev.sequencer
  const otherSeq = other.sequencer
  const otherTerms = skterms(otherSeq)

  const r = await putConfig(fake, 'cfg-re', { deviceKey: 'cfgnew' })
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.body.applying, true, '開き直しの最中（Config.applying）')
  assert.equal(r.body.fields.deviceKey.value, 'cfgnew')
  // 開き直しの最中の次の変更は待たずに 409 BUSY（決めたこと）
  const busy = await putConfig(fake, 'cfg-re', { name: 'すぐ次' })
  assert.equal(busy.statusCode, 409, busy.text)
  assert.equal(busy.body.error.code, 'BUSY')
  const busyFlow = await input(b, { topic: 'config', payload: { name: 'すぐ次' } })
  assert.equal(busyFlow.sent[0][1].topic, 'error')
  assert.equal(busyFlow.sent[0][1].payload.code, 'BUSY')
  assert.ok(busyFlow.err, 'done(err)')

  await settled(dev)
  assert.ok(skterms(seq1) >= 1, '前の sequencer は SKTERM してから閉じた')
  assert.equal(seq1.transport.isOpen, false, '前のポートは閉じた')
  assert.notEqual(dev.sequencer, seq1, '新しい sequencer で開き直した')
  assert.equal(dev.handle, h, 'AdapterHandle は同じ')
  assert.equal(h.sequencer, dev.sequencer)
  assert.equal(dev.sequencer.state.overrides.pollIntervalSec, 60, '一時的な上書き（interval）を引き継ぐ')
  assert.equal(dev.deviceKey, 'cfgnew')
  assert.equal(other.sequencer, otherSeq, 'ほかの台は開き直さない')
  assert.equal(skterms(otherSeq), otherTerms, 'ほかの台に SKTERM しない')
  // 計測が戻り、wsuha-broute の出力 1 に新しいデバイスキーで届く（購読は切れていない）
  const n = measurements(b).length
  await connected(dev)
  await input(b, { topic: 'poll' })
  await waitFor(() => measurements(b).length > n, 8000, '開き直したあとの出力 1')
  assert.equal(measurements(b)[measurements(b).length - 1].payload.deviceKey, 'cfgnew')
  // 出力 2 の config（画面で変えたので、頼んでいないノードにも changedBy web-ui）。ほかの台のノードには出ない
  const notes = out2(b, 'config')
  assert.ok(notes.some((m) => m.changedBy === 'web-ui' && m.payload.fields.deviceKey.value === 'cfgnew'), JSON.stringify(notes.map((m) => m.changedBy)))
  assert.equal(out2(bo, 'config').length, 0)
  // アダプタのログと Node-RED のログに、何を変えたので開き直したかを 1 行
  const logs = h.logsAfter({ limit: 1000 }).items.map((l) => l.text)
  assert.ok(logs.some((t) => /画面からデバイスキーを変えたので、この台だけ接続し直します/.test(t)), logs.slice(-5).join(' | '))
  assert.ok(fake.logs.some(([l, t]) => l === 'info' && /接続し直します/.test(t)))
  // 片付け（設定ノードの値に戻す = もう一度開き直す）
  const back = await fake.request('DELETE', `${B}/adapters/cfg-re/config`, { headers: { 'if-match': (await getConfig(fake, 'cfg-re')).rev } })
  assert.equal(back.statusCode, 200, back.text)
  await settled(dev)
  assert.equal(dev.deviceKey, dev.handle.meta.deviceKey)
})

test('名前・契約・スキャン時間は開き直さずに効く（SKTERM しない・sequencer はそのまま）。出力の device は新しい契約', async () => {
  // 戻すと落ちるもの: wsuha-device.js の _reconfigure で全部の項目を開き直す・wsuha-broute.js で role を作ったときの値のまま使う
  const fake = setup()
  const dev = createDevice(fake, 'cfg-soft')
  const b = createBroute(fake, 'cfg-soft')
  await connected(dev)
  const seq = dev.sequencer
  const terms = skterms(seq)
  const reconnects = seq.state.counters.reconnects
  const r = await putConfig(fake, 'cfg-soft', { name: '改名した', role: '電灯', scanDurations: [5, 6], autoStart: false })
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.body.applying, false, '開き直さない')
  assert.equal(dev.handle.reconfiguring, false)
  assert.equal(dev.sequencer, seq)
  assert.equal(skterms(seq), terms)
  assert.equal(seq.state.counters.reconnects, reconnects)
  assert.equal(seq.isConnected, true)
  assert.deepEqual(seq.options.scanDurations, [5, 6])
  assert.equal(seq.options.label, '電灯')
  const d = (await fake.request('GET', `${B}/adapters/cfg-soft`)).body
  assert.equal(d.name, '改名した')
  assert.equal(d.role, '電灯')
  const n = measurements(b).length
  await input(b, { topic: 'poll' })
  await waitFor(() => measurements(b).length > n, 5000, '出力 1')
  const m = measurements(b)[measurements(b).length - 1]
  assert.equal(m.topic, '電灯')
  assert.equal(m.payload.device, '電灯')
  const st = await input(b, { topic: 'status' })
  assert.equal(st.sent[0][1].payload.device, '電灯')
})

test('有効を外すとポートを閉じ（SKTERM）、一覧は「無効」。フローの config で入れ直すと開いて自動運転に戻る', async () => {
  // 戻すと落ちるもの: wsuha-device.js の _reconfigure で enabled を見ない
  const fake = setup()
  const dev = createDevice(fake, 'cfg-en')
  const b = createBroute(fake, 'cfg-en', { name: 'スイッチ' })
  await connected(dev)
  const seq = dev.sequencer
  const r = await putConfig(fake, 'cfg-en', { enabled: false })
  assert.equal(r.statusCode, 200, r.text)
  await settled(dev)
  assert.ok(skterms(seq) >= 1)
  assert.equal(dev.sequencer, null)
  assert.equal(dev.enabled, false)
  const d = (await fake.request('GET', `${B}/adapters/cfg-en`)).body
  assert.equal(d.enabled, false)
  assert.equal(d.health.level, 'disabled')
  assert.equal(b._statuses[b._statuses.length - 1].fill, 'grey')
  // 無効のあいだに接続の項目を変えても開かない（次に有効にしたとき効く）
  const r2 = await putConfig(fake, 'cfg-en', { serialbaud: 9600 })
  assert.equal(r2.statusCode, 200)
  assert.equal(dev.sequencer, null)
  // フローの入力で有効に戻す（null = 設定ノードの値 = 有効）
  const { err, sent } = await input(b, { topic: 'config', payload: { enabled: null, serialbaud: null } })
  assert.equal(err, null)
  assert.equal(sent.length, 1, '返事は 1 通')
  assert.equal(sent[0][1].topic, 'config')
  assert.equal(sent[0][1].changedBy, 'flow:スイッチ')
  assert.equal(sent[0][1].payload.fields.enabled.value, true)
  await settled(dev)
  assert.ok(dev.sequencer, '開いた')
  await connected(dev)
  assert.equal(out2(b, 'config').filter((m) => m.changedBy === 'flow:スイッチ').length, 1, '頼んだノードは返事の 1 通だけ（二重に出さない）')
})

test('接続先の切り替え: シミュレーター → シリアル（serialport）→ シミュレータの候補（serialport: simulator）で戻る', async () => {
  // 戻すと落ちるもの: wsuha-device.js の _build で config.mode / config.serialport を読む（node.eff を読まない）
  const fake = setup()
  const dev = createDevice(fake, 'cfg-mode')
  createBroute(fake, 'cfg-mode')
  await connected(dev)
  const r = await putConfig(fake, 'cfg-mode', { mode: 'serial', serialport: '/dev/ttyWSUHATEST9' })
  assert.equal(r.statusCode, 200, r.text)
  await settled(dev)
  assert.ok(dev.sequencer.transport instanceof SerialTransport, 'シリアルの transport で開き直した')
  assert.equal(dev.sequencer.transport.config.path, '/dev/ttyWSUHATEST9')
  const d = (await fake.request('GET', `${B}/adapters/cfg-mode`)).body
  assert.equal(d.mode, 'serial')
  assert.equal(d.port, '/dev/ttyWSUHATEST9')
  // GET serialports のシミュレータの候補を選ぶ
  const ports = (await fake.request('GET', `${B}/serialports`)).body.items
  const sim = ports.find((p) => p.simulator)
  const r2 = await putConfig(fake, 'cfg-mode', { serialport: sim.path })
  assert.equal(r2.statusCode, 200, r2.text)
  assert.equal(r2.body.fields.mode.value, 'simulator')
  await settled(dev)
  assert.ok(!(dev.sequencer.transport instanceof SerialTransport))
  await connected(dev)
  assert.equal((await fake.request('GET', `${B}/adapters/cfg-mode`)).body.port, 'simulator')
})

test('有効でシリアルなのにポートが無くなる構成は、フローの config も画面と同じく断る（error の VALIDATION・details.serialport）。開き直さない', async () => {
  // 前は err null・返事 config で受け、開き直すと「シリアルポートのパスが指定されていません」で sequencer が無いまま残った。
  // 戻すと落ちるもの: service.js の saveConfig の「シリアルでポートなし」の検査を外す
  const fake = setup()
  const dev = createDevice(fake, 'cfg-np')
  const b = createBroute(fake, 'cfg-np', { name: '構成' })
  await connected(dev)
  const seq = dev.sequencer
  const rev = (await getConfig(fake, 'cfg-np')).rev
  for (const payload of [{ mode: 'serial' }, { mode: 'serial', serialport: null }]) {
    const r = await input(b, { topic: 'config', payload })
    assert.ok(r.err, `done(err): ${JSON.stringify(payload)}`)
    assert.equal(r.sent.length, 1)
    const m = r.sent[0][1]
    assert.equal(m.topic, 'error')
    assert.equal(m.payload.code, 'VALIDATION')
    assert.equal(m.payload.action, 'config')
    assert.match(m.payload.details.serialport, /ポート/)
  }
  // 画面の PUT も同じ
  const api = await putConfig(fake, 'cfg-np', { mode: 'serial' })
  assert.equal(api.statusCode, 422, api.text)
  assert.equal(dev.handle.reconfiguring, false, '開き直さない')
  assert.equal(dev.sequencer, seq, 'sequencer はそのまま')
  assert.equal((await getConfig(fake, 'cfg-np')).rev, rev, '保存しない')
  assert.equal(dev.handle.buildError, null)
})

test('エディタでシリアル・ポートなしのまま作った台: 健康は bad「アダプタを初期化できませんでした」（「開始」を勧めない）。名前の保存と config-reset は通る', async () => {
  // 前は idle「停止」・「「開始」で自動運転を始めます」を出し、開始は 503 PORT_DOWN になった。
  // 戻すと落ちるもの: health.js の buildError の判定・view-model.js で buildError を health に渡すのを外す
  const fake = setup()
  const dev = createDevice(fake, 'cfg-npe', { mode: 'serial', serialport: '' })
  const b = createBroute(fake, 'cfg-npe', { name: 'ポートなし' })
  assert.equal(dev.sequencer, null)
  assert.match(dev.handle.buildError.message, /^ポートが未設定です。/)
  // 戻すと落ちるもの: wsuha-device.js の _build で同じ文を毎回 node.error に出す（B ルートノードの数だけ増える）
  // Node-RED はノードを順に作るので、次のノードの登録は前の _open が終わってから届く
  await new Promise((resolve) => setImmediate(resolve))
  createBroute(fake, 'cfg-npe', { name: 'ポートなし 2' })
  assert.equal(dev._errors.filter((t) => /ポートが未設定です/.test(t)).length, 1, dev._errors.join(' / '))
  const d = (await fake.request('GET', `${B}/adapters/cfg-npe`)).body
  assert.equal(d.phase, 'error')
  assert.equal(d.health.level, 'bad')
  assert.equal(d.health.title, 'アダプタを初期化できませんでした')
  assert.ok(d.health.reasons.some((t) => /ポートが未設定です。/.test(t)), d.health.reasons.join(' / '))
  assert.match(d.lastError.hint, /ポートを選んでください/, '次の一手の案内に当たる')
  assert.ok(!/開始/.test(d.health.nextAction), d.health.nextAction)
  // 出力 2 の status の health も同じ（フローの detail）
  const det = await input(b, { topic: 'detail' })
  assert.equal(det.sent[0][1].payload.health.level, 'bad')
  // ポート・接続先・有効を変えない保存は断らない。config-reset（設定ノードの値に戻す）も断らない
  const nm = await input(b, { topic: 'config', payload: { name: '予備の台' } })
  assert.equal(nm.err, null, nm.err && nm.err.message)
  await settled(dev)
  const rs = await input(b, { topic: 'config-reset' })
  assert.equal(rs.err, null, rs.err && rs.err.message)
  await settled(dev)
  // ポートを入れれば開く
  const on = await input(b, { topic: 'config', payload: { serialport: '/dev/ttyWSUHANP1' } })
  assert.equal(on.err, null, on.err && on.err.message)
  await settled(dev)
  assert.ok(dev.sequencer, 'ポートを入れたら sequencer を作る')
  assert.equal(dev.handle.buildError, null)
})

test('画面かフローで有効を外した台の健康とログは、外した所を書き、戻し方を画面とフローで案内する（エディタのデプロイでは戻らない）', async () => {
  // 前はいつも「設定ノードで無効にしています」「エディタで設定ノードの「有効」に印を付けてデプロイ」だった。
  // 戻すと落ちるもの: service.js で handle.enabledBy を入れない・registry の inspect が渡さない・health.js で見ない・
  //                   wsuha-device.js の作ったときのログを分けない
  const fake = setup()
  const dev = createDevice(fake, 'cfg-dsrc')
  const b = createBroute(fake, 'cfg-dsrc', { name: 'スイッチ' })
  await connected(dev)
  const r = await putConfig(fake, 'cfg-dsrc', { enabled: false })
  assert.equal(r.statusCode, 200, r.text)
  await settled(dev)
  let d = (await fake.request('GET', `${B}/adapters/cfg-dsrc`)).body
  assert.equal(d.health.level, 'disabled')
  assert.deepEqual(d.health.reasons, ['画面で無効にしています。ポートは開きません'])
  assert.ok(!/エディタ/.test(d.health.nextAction), d.health.nextAction)
  assert.match(d.health.nextAction, /「アダプタと接続」の詳細設定で「有効」/)
  // フローで外し直すと、フロー（名前）
  await input(b, { topic: 'config', payload: { enabled: null } })
  await settled(dev)
  const f = await input(b, { topic: 'config', payload: { enabled: false } })
  assert.equal(f.err, null, f.err && f.err.message)
  await settled(dev)
  d = (await fake.request('GET', `${B}/adapters/cfg-dsrc`)).body
  assert.deepEqual(d.health.reasons, ['フロー（スイッチ）で無効にしています。ポートは開きません'])
  // デプロイで作り直しても無効のまま。アダプタのログも外した所を書く
  await fake.close(b, false)
  await fake.close(dev, false)
  const dev2 = createDevice(fake, 'cfg-dsrc')
  assert.equal(dev2.sequencer, null)
  const logs = dev2.handle.logsAfter({ limit: 1000 }).items.map((l) => l.text)
  const last = logs.filter((t) => /無効にしているため、ポートを開きません/.test(t)).pop()
  assert.match(last || '', /^フロー（スイッチ）で無効にしているため/, logs.slice(-3).join(' | '))
  // エディタ（設定ノード）で無効にした台は、今までどおりの理由と案内
  const dev3 = createDevice(fake, 'cfg-dsrc-ed', { enabled: false })
  assert.equal(dev3.sequencer, null)
  const d3 = (await fake.request('GET', `${B}/adapters/cfg-dsrc-ed`)).body
  assert.deepEqual(d3.health.reasons, ['設定ノードで無効にしています。ポートは開きません'])
  assert.match(d3.health.nextAction, /エディタで設定ノードの「有効」に印を付けてデプロイ/)
  const logs3 = dev3.handle.logsAfter({ limit: 1000 }).items.map((l) => l.text)
  assert.ok(logs3.some((t) => /^設定ノードで無効にしているため、ポートを開きません/.test(t)), logs3.join(' | '))
  // 画面の値を全部外すと有効に戻り、健康は disabled でなくなる
  const back = await fake.request('DELETE', `${B}/adapters/cfg-dsrc/config`, { headers: { 'if-match': (await getConfig(fake, 'cfg-dsrc')).rev } })
  assert.equal(back.statusCode, 200, back.text)
  await settled(dev2)
  await connected(dev2)
  assert.notEqual((await fake.request('GET', `${B}/adapters/cfg-dsrc`)).body.health.level, 'disabled')
})

test('画面で有効を外したあと、エディタで「有効」を外してデプロイすると、画面の値は外れて健康は「設定ノードで無効」に戻る', async () => {
  // 照合（configAtSet）で画面の値を外したら、外した所の印（handle.enabledBy）も消す。
  // 戻すと落ちるもの: service.js の reconcileConfig で syncEnabledBy を呼ばない（handle は作り直さないので前の印が残る）
  const fake = setup()
  const dev = createDevice(fake, 'cfg-dre')
  const b = createBroute(fake, 'cfg-dre')
  await connected(dev)
  assert.equal((await putConfig(fake, 'cfg-dre', { enabled: false })).statusCode, 200)
  await settled(dev)
  assert.equal(dev.handle.enabledBy && dev.handle.enabledBy.by, 'web-ui')
  await fake.close(b, false)
  await fake.close(dev, false)
  const dev2 = createDevice(fake, 'cfg-dre', { enabled: false })
  assert.equal(dev2.handle, dev.handle, '同じ handle')
  assert.equal(dev2.sequencer, null)
  assert.equal((await getConfig(fake, 'cfg-dre')).fields.enabled.source, 'config', '画面の値は外れた')
  assert.equal(dev2.handle.enabledBy, null)
  const d = (await fake.request('GET', `${B}/adapters/cfg-dre`)).body
  assert.deepEqual(d.health.reasons, ['設定ノードで無効にしています。ポートは開きません'])
  assert.match(d.health.nextAction, /エディタで設定ノードの「有効」に印を付けてデプロイ/)
})

test('最初の open がまだ終わらないうちに接続の項目を変えても、開き直したあとに sequencer がある（計測が黙って止まらない）', async () => {
  // 前は _open が古い _opening を返し、古い run は「待つ間に畳まれた」で抜けて、新しい sequencer ができなかった。
  // 戻すと落ちるもの: wsuha-device.js の開き直しで、最初の open を待たずに _close する
  const { SimulatorTransport } = require('../../lib/simulator-transport')
  const orig = SimulatorTransport.prototype.open
  SimulatorTransport.prototype.open = function () {
    const self = this
    return new Promise((res, rej) => setTimeout(() => orig.call(self).then(res, rej), 300))
  }
  try {
    const fake = setup()
    const dev = createDevice(fake, 'cfg-race')
    const b = createBroute(fake, 'cfg-race')
    assert.ok(dev._opening, '最初の open の途中')
    const r = await putConfig(fake, 'cfg-race', { deviceKey: 'race2' })
    assert.equal(r.statusCode, 200, r.text)
    await settled(dev)
    assert.ok(dev.sequencer, '開き直したあとに sequencer がある')
    assert.equal(dev.handle.sequencer, dev.sequencer)
    assert.equal(dev.deviceKey, 'race2')
    SimulatorTransport.prototype.open = orig
    await connected(dev)
    assert.ok(dev.sequencer._running, '自動運転に戻る')
    // 計測が出力 1 に届く
    const n = measurements(b).length
    await input(b, { topic: 'poll' })
    await waitFor(() => measurements(b).length > n, 8000, '開き直したあとの出力 1')
  } finally {
    SimulatorTransport.prototype.open = orig
  }
})

test('ほかの設定ノードが使っているポートは 409 PORT_IN_USE（フローは error）。シミュレーター同士は重ならない', async () => {
  const fake = setup()
  const a = createDevice(fake, 'cfg-pa', { name: 'A 台', mode: 'serial', serialport: '/dev/ttyWSUHAPA', autoStart: false })
  const bdev = createDevice(fake, 'cfg-pb', { name: 'B 台' })
  const b = createBroute(fake, 'cfg-pb')
  assert.ok(a && bdev)
  const r = await putConfig(fake, 'cfg-pb', { mode: 'serial', serialport: '/dev/ttyWSUHAPA' })
  assert.equal(r.statusCode, 409, r.text)
  assert.equal(r.body.error.code, 'PORT_IN_USE')
  assert.match(r.body.error.message, /A 台/)
  const f = await input(b, { topic: 'config', payload: { mode: 'serial', serialport: '/dev/ttyWSUHAPA' } })
  assert.equal(f.sent[0][1].payload.code, 'PORT_IN_USE')
  const sim = createDevice(fake, 'cfg-pc', { name: 'C 台' })
  assert.ok(sim)
  const r2 = await putConfig(fake, 'cfg-pb', { name: 'B 台（シミュレータのまま）' })
  assert.equal(r2.statusCode, 200, 'シミュレーター同士は重ならない')
})

// ---------------------------------------------------------------------------
//  フローの入力
// ---------------------------------------------------------------------------

test('入力 get-config・config-reset・serialports: 画面と同じ形を出力 2 に同じ topic で返す（入力の msg を引き継ぐ）', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の SHARED_TOPICS から get-config などを外す
  const fake = setup()
  const dev = createDevice(fake, 'cfg-flow')
  const b1 = createBroute(fake, 'cfg-flow', { name: 'n1' })
  const b2 = createBroute(fake, 'cfg-flow', { name: 'n2' })
  await connected(dev)
  const g = await input(b1, { topic: 'get-config', correlation: 'x1' })
  assert.equal(g.err, null)
  const reply = g.sent[0][1]
  assert.equal(reply.topic, 'config')
  assert.equal(reply.correlation, 'x1')
  assert.ok(!('changedBy' in reply), 'get-config の返事に changedBy を付けない')
  const api = await getConfig(fake, 'cfg-flow')
  assert.deepEqual(Object.keys(reply.payload).sort(), Object.keys(api).sort(), '画面の GET config と同じ形')
  assert.deepEqual(reply.payload.fields, api.fields)
  // config（payload.action でも）・msg.rev の照合
  const stale = await input(b1, { topic: 'config', payload: { name: 'x' }, rev: 'zzz' })
  assert.equal(stale.sent[0][1].payload.code, 'REVISION_MISMATCH')
  const bad = await input(b1, { payload: { action: 'config', serialbaud: 1234 } })
  assert.equal(bad.sent[0][1].topic, 'error')
  assert.equal(bad.sent[0][1].payload.code, 'VALIDATION')
  assert.ok(bad.sent[0][1].payload.details.serialbaud)
  const ok = await input(b1, { topic: 'config', payload: { name: 'フローで' }, rev: api.rev })
  assert.equal(ok.err, null)
  assert.equal(ok.sent[0][1].payload.fields.name.by, 'flow:n1')
  assert.equal(out2(b2, 'config').length, 1, 'ほかのノードに 1 通')
  assert.equal(out2(b2, 'config')[0].changedBy, 'flow:n1')
  const reset = await input(b2, { topic: 'config-reset' })
  assert.equal(reset.sent[0][1].topic, 'config')
  assert.equal(reset.sent[0][1].changedBy, 'flow:n2')
  assert.equal(reset.sent[0][1].payload.fields.name.source, 'config')
  // serialports
  const sp = await input(b1, { topic: 'serialports' })
  assert.equal(sp.err, null)
  assert.equal(sp.sent[0][1].topic, 'serialports')
  assert.ok(Array.isArray(sp.sent[0][1].payload.items))
  assert.equal(sp.sent[0][1].payload.items[sp.sent[0][1].payload.items.length - 1].path, 'simulator')
})

test('無効の設定ノードでも config・get-config・credentials は使える（有効に戻せる）。readOnly・uiConfig: false はフローに掛からない', async () => {
  const fake = setup({ settings: { wsuhaBroute: { readOnly: true, uiConfig: false } } })
  const dev = createDevice(fake, 'cfg-dis', { enabled: false })
  const b = createBroute(fake, 'cfg-dis')
  assert.equal(dev.sequencer, null)
  const r = await input(b, { topic: 'get-config' })
  assert.equal(r.err, null)
  assert.equal(r.sent[0][1].payload.fields.enabled.value, false)
  assert.equal(r.sent[0][1].payload.locked, true, '画面は鍵が掛かっている（フローは変えられる）')
  const api = await fake.request('PUT', `${B}/adapters/cfg-dis/config`, { body: { enabled: true }, headers: { 'if-match': r.sent[0][1].payload.rev } })
  assert.equal(api.statusCode, 403, '画面からは READ_ONLY')
  const on = await input(b, { topic: 'config', payload: { enabled: true } })
  assert.equal(on.err, null, on.err && on.err.message)
  await settled(dev)
  assert.ok(dev.sequencer, 'フローからは有効にできる')
  await connected(dev)
})

// ---------------------------------------------------------------------------
//  認証情報
// ---------------------------------------------------------------------------

test('入力 credentials: 返事に値を入れずに保存し、その台だけ開き直して新しい認証情報で繋がる。credentials-reset で戻す', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の credentials で msg.payload を残す・wsuha-device.js の resolveCredentials で保存した値を見ない
  const fake = setup()
  const dev = fake.create('wsuha-device', halfCredConfig(kit, 'cfg-cred', 'cfgcred'))
  kit.open.push([fake, dev])
  const b1 = createBroute(fake, 'cfg-cred', { name: '鍵の係' })
  const b2 = createBroute(fake, 'cfg-cred')
  await waitFor(() => dev.sequencer && !dev._opening, 3000, '開き終わる')
  assert.ok(dev.sequencer.validateCredentials().length > 0, '前提: 認証情報がそろっていない')
  assert.equal(dev.sequencer._running, false)
  const orig = dev._build
  dev._build = function () {
    const had = dev.sequencer
    const r = orig.call(dev)
    if (dev.sequencer && dev.sequencer !== had) speedUp(dev.sequencer)
    return r
  }

  const bad = await input(b1, { topic: 'credentials', payload: { routeBId: ID.slice(3), routeBPassword: PW } })
  assert.equal(bad.sent[0][1].topic, 'error')
  assert.equal(bad.sent[0][1].payload.code, 'VALIDATION')
  assertNoSecrets(JSON.stringify(bad.sent), '検証の失敗の出力')
  assert.ok(!JSON.stringify(bad.sent).includes(ID.slice(3)))

  const msg = { topic: 'credentials', payload: { routeBId: ID, routeBPassword: PW }, correlation: 'k' }
  const { err, sent } = await input(b1, msg)
  assert.equal(err, null)
  assert.equal(sent.length, 1)
  const reply = sent[0][1]
  assert.equal(reply.topic, 'credentials')
  assert.equal(reply.correlation, 'k')
  assert.equal(reply.changedBy, 'flow:鍵の係')
  assertNoSecrets(JSON.stringify(reply), '返事')
  assert.equal(reply.payload.configured, true)
  assert.equal(reply.payload.source, '画面かフローで保存した値')
  assert.equal(reply.payload.stored.by, 'flow:鍵の係')
  assert.equal(reply.payload.pairId, ID.slice(-8))
  // ほかのノードには config（changedBy）
  assert.ok(out2(b2, 'config').some((m) => m.changedBy === 'flow:鍵の係' && m.payload.credentials.configured === true))
  // 開き直して繋がる
  await settled(dev)
  await connected(dev)
  const d = (await fake.request('GET', `${B}/adapters/cfg-cred`)).body
  assert.equal(d.credentials.configured, true)
  assert.equal(d.credentials.source, '画面かフローで保存した値')
  // 置き場所（600 は POSIX のみ。中身は大文字）
  const file = path.join(fake.settings.userDir, 'wsuha-broute', 'credentials', 'cfg-cred.json')
  assert.ok(fs.existsSync(file))
  // 消すと設定ノードの値（ここではパスワードだけ）に戻る
  const r = await input(b1, { topic: 'credentials-reset' })
  assert.equal(r.err, null)
  assert.equal(r.sent[0][1].topic, 'credentials')
  assert.equal(r.sent[0][1].payload.configured, false)
  assert.equal(r.sent[0][1].payload.stored, null)
  assert.ok(!fs.existsSync(file))
  await settled(dev)
  assert.ok(dev.sequencer.validateCredentials().length > 0, '認証情報がそろわない状態に戻った')
  assert.equal(dev.sequencer._running, false)
})

test('認証情報の優先: 環境変数 > 画面かフローで保存した値 > 設定ノード。環境変数があれば envOverrides と注意を出し、保存しても開き直さない', async () => {
  // 戻すと落ちるもの: wsuha-device.js の resolveCredentials の順を変える
  const fake = setup()
  const OTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'
  const OTHER_PW = 'ZYXWVU987654'
  // 設定ノードには別の値。画面で保存した値（ID / PW）が勝つ
  const dev = createDevice(fake, 'cfg-prio', { deviceKey: 'cfgenvx', _credentials: { routeBId: OTHER_ID, routeBPassword: OTHER_PW } })
  const b = createBroute(fake, 'cfg-prio')
  assert.equal(dev.handle.credentialSource, '設定ノード')
  const put = await fake.request('PUT', `${B}/adapters/cfg-prio/credentials`, { body: { routeBId: ID, routeBPassword: PW } })
  assert.equal(put.statusCode, 200, put.text)
  await settled(dev)
  assert.equal(dev.sequencer.credentials.id, ID, '画面で保存した値が設定ノードの値に勝つ')
  assert.equal(dev.handle.credentialSource, '画面かフローで保存した値')
  // 環境変数（デバイスキーの接尾辞つき）が最優先。作り直す（デプロイ）と効く
  process.env.WSUHA_BROUTE_ID_CFGENVX = OTHER_ID
  process.env.WSUHA_BROUTE_PASSWORD_CFGENVX = OTHER_PW
  try {
    await fake.close(b, false)
    await fake.close(dev, false)
    const dev2 = createDevice(fake, 'cfg-prio', { deviceKey: 'cfgenvx', _credentials: { routeBId: OTHER_ID, routeBPassword: OTHER_PW } })
    createBroute(fake, 'cfg-prio')
    assert.equal(dev2.handle.credentialSource, '環境変数')
    const c = await getConfig(fake, 'cfg-prio')
    assert.equal(c.credentials.envOverrides, true)
    assert.ok(c.warnings.some((w) => /環境変数が優先される/.test(w)), c.warnings.join(' / '))
    assert.ok(c.credentials.stored, '画面で保存した値は残っている（環境変数を外すと効く）')
    const seq = dev2.sequencer
    const again = await fake.request('PUT', `${B}/adapters/cfg-prio/credentials`, { body: { routeBId: ID, routeBPassword: PW } })
    assert.equal(again.statusCode, 200)
    assert.equal(again.body.applying, false, '効く値が変わらないので開き直さない')
    assert.equal(dev2.sequencer, seq)
  } finally {
    delete process.env.WSUHA_BROUTE_ID_CFGENVX
    delete process.env.WSUHA_BROUTE_PASSWORD_CFGENVX
  }
})

test('エディタで認証情報を入れ直してデプロイすると、画面かフローで保存した値は外れる（後の明示を優先）', async () => {
  const fake = setup()
  const OTHER_ID = 'FEDCBA9876543210FEDCBA9876543210'
  const OTHER_PW = 'ZYXWVU987654'
  const dev = createDevice(fake, 'cfg-edcred', { _credentials: { routeBId: OTHER_ID, routeBPassword: OTHER_PW } })
  const b = createBroute(fake, 'cfg-edcred')
  assert.equal((await fake.request('PUT', `${B}/adapters/cfg-edcred/credentials`, { body: { routeBId: ID, routeBPassword: PW } })).statusCode, 200)
  await settled(dev)
  // 同じ値のまま作り直す（関係の無いデプロイ）: 外さない
  await fake.close(b, false)
  await fake.close(dev, false)
  const dev2 = createDevice(fake, 'cfg-edcred', { _credentials: { routeBId: OTHER_ID, routeBPassword: OTHER_PW } })
  const b2 = createBroute(fake, 'cfg-edcred')
  assert.equal(dev2.handle.credentialSource, '画面かフローで保存した値')
  // エディタで入れ直した
  await fake.close(b2, false)
  await fake.close(dev2, false)
  const dev3 = createDevice(fake, 'cfg-edcred', { _credentials: { routeBId: OTHER_ID, routeBPassword: 'ZYXWVU987600' } })
  const b3 = createBroute(fake, 'cfg-edcred')
  assert.equal(dev3.handle.credentialSource, '設定ノード')
  assert.equal((await getConfig(fake, 'cfg-edcred')).credentials.stored, null)
  fake.events.emit('flows:started', { type: 'full' })
  assert.ok(out2(b3, 'config').some((m) => m.changedBy === 'editor'), 'デプロイのあと出力 2 に config（changedBy editor）')
  assert.ok(fake.logs.some(([l, t]) => l === 'warn' && /設定ノードで認証情報を入れ直したため/.test(t)))
})

// ---------------------------------------------------------------------------
//  エディタとの照合・エディタ用の読み出し
// ---------------------------------------------------------------------------

test('エディタで構成の項目を変えて作り直すと、その項目の画面の値は外れ、デプロイのあと出力 2 に config（changedBy は editor）', async () => {
  // 戻すと落ちるもの: wsuha-device.js で service.reconcileConfig を呼ばない・registry の flushConfigNotice を flows:started で呼ばない
  const fake = setup()
  const dev = createDevice(fake, 'cfg-ed', { role: '電力' })
  const b = createBroute(fake, 'cfg-ed')
  const r = await putConfig(fake, 'cfg-ed', { name: '画面の名前', role: '画面の契約' })
  assert.equal(r.statusCode, 200)
  await fake.close(b, false)
  await fake.close(dev, false)
  // 名前はそのまま、契約だけエディタで変えた
  createDevice(fake, 'cfg-ed', { role: '動力' })
  const b2 = createBroute(fake, 'cfg-ed')
  assert.equal(out2(b2, 'config').length, 0, '作っている途中では出さない（デプロイが済むまで待つ）')
  fake.events.emit('flows:started', { type: 'full' })
  const notes = out2(b2, 'config')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].changedBy, 'editor')
  const c = notes[0].payload
  assert.equal(c.fields.role.value, '動力')
  assert.equal(c.fields.role.source, 'config')
  assert.equal(c.fields.role.by, 'editor')
  assert.equal(typeof c.fields.role.at, 'number')
  assert.equal(c.fields.name.value, '画面の名前', 'エディタで変えていない項目は画面の値のまま')
  assert.equal(c.fields.name.source, 'runtime')
  assert.ok(c.warnings.some((w) => /設定ノードの契約が変わったため/.test(w)), c.warnings.join(' / '))
  // エディタ用の読み出し（httpAdmin・needsPermission wsuha-device.read）
  const route = fake.routes.find((x) => x.app === 'admin' && x.method === 'GET' && x.path === '/wsuha-broute/device/:id/config')
  assert.ok(route, 'GET {httpAdminRoot}wsuha-broute/device/:id/config')
  assert.equal(route.handlers[0].permission, 'wsuha-device.read')
  const ed = await fake.request('GET', '/wsuha-broute/device/cfg-ed/config', { app: 'admin' })
  assert.equal(ed.statusCode, 200, ed.text)
  assert.deepEqual(ed.body.fields, (await getConfig(fake, 'cfg-ed')).fields)
  assert.equal((await fake.request('GET', '/wsuha-broute/device/cfg-ed/config', { app: 'admin', unauthenticated: true })).statusCode, 401)
  assert.equal((await fake.request('GET', '/wsuha-broute/device/nope/config', { app: 'admin' })).body.error.code, 'ADAPTER_NOT_FOUND')
})

test('SSE の config: 開き直しの始め（applying: true）と終わり（false）を出す', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'cfg-sse')
  createBroute(fake, 'cfg-sse')
  await connected(dev)
  const s = fake.openStream(`${B}/stream?adapter=cfg-sse`)
  await s.done
  assert.equal((await putConfig(fake, 'cfg-sse', { serialbaud: 9600 })).statusCode, 200)
  await settled(dev)
  const frames = () => parseSse(s.res.text).filter((f) => f.event === 'config' && f.data.adapterId === 'cfg-sse')
  await waitFor(() => frames().some((f) => f.data.config.applying === false && f.data.config.fields.serialbaud.value === 9600), 3000, '終わりの config')
  assert.ok(frames().some((f) => f.data.config.applying === true), '始めの config')
  s.req.emit('close')
})

test('構成と認証情報を画面とフローで変えたあと、見えるもの全部（API・SSE・出力 2・ログのリング・Node-RED のログ）に値が出ない', async () => {
  // 戻すと落ちるもの: registry の updateInfo で新しい値を伏せ字に足さない・service.js で値をログに書く
  const fake = setup()
  const dev = fake.create('wsuha-device', noCredConfig(kit, 'cfg-sec', 'cfgsec'))
  kit.open.push([fake, dev])
  const b = createBroute(fake, 'cfg-sec', { emitLogs: true, emitRaw: true })
  const s = fake.openStream(`${B}/stream?adapter=cfg-sec&logs=1`)
  await s.done
  await waitFor(() => dev.sequencer && !dev._opening, 3000, '開き終わる')
  const orig = dev._build
  dev._build = function () {
    const had = dev.sequencer
    const r = orig.call(dev)
    if (dev.sequencer && dev.sequencer !== had) speedUp(dev.sequencer)
    return r
  }
  assert.equal((await fake.request('PUT', `${B}/adapters/cfg-sec/credentials`, { body: { routeBId: ID, routeBPassword: PW } })).statusCode, 200)
  await settled(dev)
  await connected(dev)
  await input(b, { topic: 'command', payload: 'SKINFO' })
  await input(b, { topic: 'diag', payload: { name: 'sreg', args: { reg: 'S0A' } } })
  await input(b, { topic: 'credentials', payload: { routeBId: ID, routeBPassword: PW } })
  await settled(dev)
  const parts = []
  for (const u of ['/adapters/cfg-sec', '/adapters/cfg-sec/config', '/adapters/cfg-sec/settings', '/adapters', '/adapters/cfg-sec/logs?limit=1000', '/meta']) {
    parts.push((await fake.request('GET', B + u)).text)
  }
  parts.push((await fake.request('GET', '/wsuha-broute/device/cfg-sec/config', { app: 'admin' })).text)
  parts.push(s.res.text)
  parts.push(JSON.stringify(b._sent))
  parts.push(JSON.stringify(fake.logs))
  parts.push(JSON.stringify(dev._errors), JSON.stringify(dev._warns), JSON.stringify(b._errors), JSON.stringify(b._warns))
  parts.push(JSON.stringify(dev.handle.logsAfter({ limit: 1000 })))
  const settingsFile = path.join(fake.settings.userDir, 'wsuha-broute', 'settings.json')
  if (fs.existsSync(settingsFile)) parts.push(fs.readFileSync(settingsFile, 'utf8'))
  s.req.emit('close')
  const text = parts.join('\n')
  assert.ok(text.length > 2000)
  assertNoSecrets(text, '見えるもの')
})

// ---------------------------------------------------------------------------
//  ヘルプ
// ---------------------------------------------------------------------------

test('ヘルプ: wsuha-device に構成の 3 つの窓口、wsuha-broute に入力（config ほか）と出力 2 の表', () => {
  // 戻すと落ちるもの: nodes/*.html のヘルプからこの節を外す
  const dev = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-device.html'), 'utf8')
  const help = dev.slice(dev.indexOf('data-help-name="wsuha-device"'))
  assert.match(help, /アダプタと接続の設定、B ルートの認証 ID とパスワード/)
  assert.match(help, /Web UI の設定タブ（「アダプタと接続」「B ルートの認証 ID とパスワード」のカード/)
  assert.match(help, /<code>config<\/code>（アダプタと接続）\/ <code>credentials<\/code>（認証情報/)
  assert.match(help, /この編集画面: 値を変えてデプロイすると、<b>その項目の Web UI かフローの値は外れ<\/b>/)
  assert.match(help, /uiConfig: false/)
  assert.match(help, /credentials\/&lt;設定ノードの id&gt;\.json/)
  const br = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-broute.html'), 'utf8')
  const bh = br.slice(br.indexOf('data-help-name="wsuha-broute"'))
  for (const t of ['config', 'config-reset', 'get-config', 'credentials', 'credentials-reset', 'serialports']) {
    assert.ok(bh.includes(`<tr><td><code>${t}</code></td>`), `入力の表に ${t}`)
  }
  const out = bh.slice(bh.indexOf('出力 2 — 状態の変化とイベント'))
  for (const t of ['config', 'credentials', 'serialports']) assert.ok(out.includes(`<tr><td><code>${t}</code></td>`), `出力 2 の表に ${t}`)
  assert.match(bh, /返事に値は入れません/)
  assert.match(bh, /PORT_IN_USE/)
  assert.match(bh, /BUSY/)
  // inject や change に値を書くと flows.json（書き出し・プロジェクトの git）に平文で残る、の注意と、避け方
  // 戻すと落ちるもの: wsuha-broute.html の credentials の行からこの注意を外す
  const credRow = bh.slice(bh.indexOf('<tr><td><code>credentials</code></td>'), bh.indexOf('<tr><td><code>credentials-reset</code></td>'))
  assert.match(credRow, /flows\.json/)
  assert.match(credRow, /平文/)
  assert.match(credRow, /書き出し/)
  assert.match(credRow, /git/)
  assert.match(credRow, /\$env\(/)
})
