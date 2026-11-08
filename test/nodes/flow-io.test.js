'use strict'

// 画面でできることは、全部ノードからもできる。
//
//  - wsuha-broute の入力: settings・settings-reset・get-settings・diag・detail（画面と同じ検証・同じ settings-store）
//  - 出力 2: 運用設定が変わったとき（画面・フロー・エディタのどれでも）、その設定ノードを使う全部の wsuha-broute から 1 通ずつ
//    settings（msg.changedBy つき）。status の payload に health
//  - 設定ノード（wsuha-device）: 5 分 / 30 分の間隔の欄・configAtSet の照合は 4 項目・エディタ用の
//    GET {httpAdminRoot}wsuha-broute/device/:id/settings
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { getRegistry } = require('../../lib/runtime/registry')
const { waitFor, parseSse, tmpDir, ID, PW } = require('../runtime/fake-red')
const { createKit, input, out2, connected } = require('./node-kit')

const kit = createKit()
const { setup, createDevice, createBroute } = kit
const B = '/wsuha-broute/api/v1'

afterEach(() => kit.cleanup())

const IDHINT = ID.slice(0, 4) + '…' + ID.slice(-4)
/** 認証 ID・パスワード・idHint（ID の先頭 4 桁と末尾 4 桁。出力 2 の status からも 2.0 で外した）が出ないこと。 */
function assertNoSecrets(text, what) {
  const list = [ID, PW, ID.toLowerCase(), PW.toLowerCase(), IDHINT]
  for (const x of list) {
    assert.ok(!text.includes(x), `${what} に秘密（${x.slice(0, 4)}…）が出ている`)
  }
}

// ---------------------------------------------------------------------------
//  入力 settings・settings-reset・get-settings
// ---------------------------------------------------------------------------

test('入力 settings: 運用設定を保存して効かせ、出力 2 に settings（changedBy は flow:<名前>）。GET settings と SSE に映る', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の settings の入力を外す・by を 'flow:…' にしない・
  //                   registry の settingsChanged で handle の 'settings' を出さない
  const fake = setup()
  const dev = createDevice(fake, 'io-set')
  const other = createDevice(fake, 'io-set-other')
  const b1 = createBroute(fake, 'io-set', { name: '記録用' })
  const b2 = createBroute(fake, 'io-set')
  const b3 = createBroute(fake, 'io-set-other')
  await connected(dev)
  const reconnects = dev.sequencer.state.counters.reconnects
  const s = fake.openStream(B + '/stream?adapter=io-set')
  await s.done

  const msg = { topic: 'settings', payload: { pollIntervalSec: 60, pollEpcs: ['E7', 'E8'], slowIntervalSec: 600 }, correlation: 'c-1' }
  const { err, sent } = await input(b1, msg)
  assert.equal(err, null)
  assert.equal(sent.length, 1, '返事は 1 通')
  const reply = sent[0][1]
  assert.equal(sent[0][0], null)
  assert.equal(reply.topic, 'settings')
  assert.equal(reply.changedBy, 'flow:記録用')
  assert.equal(reply.correlation, 'c-1', '入力の msg の項目を残す（http in などから配線できる）')
  const f = reply.payload.fields
  assert.equal(f.pollIntervalSec.value, 60)
  assert.equal(f.pollIntervalSec.source, 'runtime')
  assert.equal(f.pollIntervalSec.by, 'flow:記録用')
  assert.deepEqual(f.pollEpcs.value, ['0xE7', '0xE8'])
  assert.equal(f.slowIntervalSec.value, 600)
  assert.equal(typeof reply.payload.rev, 'string')
  // sequencer に効いた（再接続なし）
  assert.equal(dev.sequencer.options.pollIntervalSec, 60)
  assert.deepEqual(dev.sequencer.options.pollEpcs, [0xe7, 0xe8])
  assert.equal(dev.sequencer.options.slowIntervalSec, 600)
  assert.equal(dev.sequencer.state.counters.reconnects, reconnects, '再接続しない')
  // 同じ設定ノードを使うほかのノードからも 1 通。別の設定ノードのノードからは出ない
  assert.equal(out2(b1, 'settings').length, 1, '頼んだノードは返事の 1 通だけ（二重に出さない）')
  assert.equal(out2(b2, 'settings').length, 1)
  assert.equal(out2(b2, 'settings')[0].changedBy, 'flow:記録用')
  assert.equal(out2(b2, 'settings')[0].payload.fields.pollIntervalSec.value, 60)
  assert.equal(out2(b3, 'settings').length, 0)
  assert.equal(other.sequencer.options.pollIntervalSec, 30, '別のアダプタには効かない')
  // 画面（GET settings と SSE）に映る
  const g = await fake.request('GET', B + '/adapters/io-set/settings')
  assert.equal(g.body.fields.pollIntervalSec.value, 60)
  assert.equal(g.body.fields.pollIntervalSec.by, 'flow:記録用')
  assert.equal(g.body.rev, reply.payload.rev)
  await waitFor(() => parseSse(s.res.text).some((x) => x.event === 'settings'), 2000, 'SSE の settings')
  const ev = parseSse(s.res.text).find((x) => x.event === 'settings')
  assert.equal(ev.data.adapterId, 'io-set')
  assert.equal(ev.data.settings.fields.pollIntervalSec.by, 'flow:記録用')
  s.req.emit('close')
  // settings.json の updatedBy と、アダプタのログ
  const disk = JSON.parse(fs.readFileSync(path.join(fake.settings.userDir, 'wsuha-broute', 'settings.json'), 'utf8'))
  assert.equal(disk.adapters['io-set'].updatedBy, 'flow:記録用')
  assert.ok(dev.handle.logsAfter({ limit: 1000 }).items.some((x) => /フロー（記録用）から運用設定を変えました/.test(x.text)))

  // 名前の無いノードは id で記録する
  const r2 = await input(b2, { topic: 'settings', payload: { pollIntervalSec: null } })
  assert.equal(r2.err, null)
  assert.equal(r2.sent[0][1].changedBy, 'flow:' + b2.id)
  assert.equal(dev.sequencer.options.pollIntervalSec, 30, 'null でその項目の運用設定を外し、設定ノードの値に戻る')
  assert.equal(out2(b1, 'settings').length, 2)
  assert.equal(out2(b1, 'settings')[1].changedBy, 'flow:' + b2.id)
})

test('入力 settings: 検証の失敗は error（VALIDATION と details）、rev の食い違いは error（REVISION_MISMATCH）。どちらも効かせない', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の settings で validateSettingsInput を通さない・msg.rev を If-Match にしない
  const fake = setup()
  const dev = createDevice(fake, 'io-bad')
  const b = createBroute(fake, 'io-bad')
  const b2 = createBroute(fake, 'io-bad')
  const bad = [
    [{ pollIntervalSec: 5 }, 'pollIntervalSec'],
    [{ pollEpcs: ['E2'] }, 'pollEpcs'],
    [{ slowIntervalSec: 59 }, 'slowIntervalSec'],
    [{ halfHourIntervalSec: 7201 }, 'halfHourIntervalSec'],
    [{ nope: 1 }, 'nope'],
    ['60', '_'],
    [{}, '_'],
  ]
  for (const [payload, field] of bad) {
    const { err, sent } = await input(b, { topic: 'settings', payload })
    assert.ok(err, JSON.stringify(payload) + ' は done(err)')
    const e = sent.map((m) => m[1]).find((m) => m.topic === 'error')
    assert.ok(e, JSON.stringify(payload) + ' は出力 2 に error')
    assert.equal(e.payload.code, 'VALIDATION', JSON.stringify(payload))
    assert.equal(e.payload.action, 'settings')
    assert.ok(e.payload.details && e.payload.details[field], `${JSON.stringify(payload)} の details.${field}: ${JSON.stringify(e.payload.details)}`)
    assert.equal(typeof e.payload.message, 'string')
  }
  assert.equal(out2(b, 'settings').length + out2(b2, 'settings').length, 0, '断ったら settings を出さない')
  assert.equal(dev.sequencer.options.pollIntervalSec, 30)

  // msg.rev（If-Match）
  const cur = (await input(b, { topic: 'get-settings' })).sent[0][1].payload.rev
  const mismatch = await input(b, { topic: 'settings', payload: { pollIntervalSec: 90 }, rev: 'old-rev' })
  assert.ok(mismatch.err)
  assert.equal(mismatch.sent[0][1].topic, 'error')
  assert.equal(mismatch.sent[0][1].payload.code, 'REVISION_MISMATCH')
  assert.equal(dev.sequencer.options.pollIntervalSec, 30)
  const ok = await input(b, { topic: 'settings', payload: { pollIntervalSec: 90 }, rev: cur })
  assert.equal(ok.err, null)
  assert.equal(dev.sequencer.options.pollIntervalSec, 90)
  // payload.action で指示しても同じ（action の項目は設定の項目に数えない）
  const viaAction = await input(b, { payload: { action: 'settings', pollIntervalSec: 120 } })
  assert.equal(viaAction.err, null, viaAction.err && viaAction.err.message)
  assert.equal(dev.sequencer.options.pollIntervalSec, 120)
})

test('SettingField.runtimeValue: 一時的な上書きの下にある運用設定の値（無ければ null）。フロー・画面・エディタ用のどれでも同じ', async () => {
  // 上書きが掛かると value と source は上書きのものになり、運用設定の値はどこからも読めなかった。
  // 戻すと落ちるもの: view-model.js の buildSettings で runtimeValue を入れない
  const fake = setup()
  const dev = createDevice(fake, 'io-rtv')
  const b = createBroute(fake, 'io-rtv', { name: 'R' })
  await connected(dev)
  let s = (await input(b, { topic: 'get-settings' })).sent[0][1].payload
  for (const k of Object.keys(s.fields)) assert.equal(s.fields[k].runtimeValue, null, k + ': 運用設定が無ければ null')

  await input(b, { topic: 'settings', payload: { pollIntervalSec: 60, pollEpcs: ['E7', 'E8'] } })
  await input(b, { topic: 'interval', payload: 90 })
  await input(b, { topic: 'epcs', payload: ['E7'] })
  s = (await input(b, { topic: 'get-settings' })).sent[0][1].payload
  assert.equal(s.fields.pollIntervalSec.source, 'override')
  assert.equal(s.fields.pollIntervalSec.value, 90)
  assert.equal(s.fields.pollIntervalSec.runtimeValue, 60, '上書きの下の運用設定')
  assert.equal(s.fields.pollIntervalSec.by, 'flow:R')
  assert.equal(s.fields.pollEpcs.source, 'override')
  assert.deepEqual(s.fields.pollEpcs.runtimeValue, ['0xE7', '0xE8'], 'EPC は value と同じ書き方（0xE7）')
  assert.equal(s.fields.slowIntervalSec.runtimeValue, null)
  const api = (await fake.request('GET', B + '/adapters/io-rtv/settings')).body
  assert.equal(api.fields.pollIntervalSec.runtimeValue, 60, '画面の GET settings')
  const ed = (await fake.request('GET', '/wsuha-broute/device/io-rtv/settings', { app: 'admin' })).body
  assert.deepEqual(ed.fields.pollEpcs.runtimeValue, ['0xE7', '0xE8'], 'エディタ用の GET device/:id/settings')

  // 上書きを外すと、運用設定が value に戻る（runtimeValue は同じ値）
  await input(b, { topic: 'auto' })
  s = (await input(b, { topic: 'get-settings' })).sent[0][1].payload
  assert.equal(s.fields.pollIntervalSec.source, 'runtime')
  assert.equal(s.fields.pollIntervalSec.value, 60)
  assert.equal(s.fields.pollIntervalSec.runtimeValue, 60)
})

test('入力 settings-reset と get-settings: 全部外す（全部のノードから 1 通）・読むだけ（頼んだノードだけ）', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の settings-reset・get-settings の入力を外す
  const fake = setup()
  const dev = createDevice(fake, 'io-reset')
  const b1 = createBroute(fake, 'io-reset', { name: 'A' })
  const b2 = createBroute(fake, 'io-reset', { name: 'B' })
  await input(b1, { topic: 'settings', payload: { pollIntervalSec: 75, halfHourIntervalSec: 900 } })
  assert.equal(dev.sequencer.options.halfHourIntervalSec, 900)

  // get-settings は頼んだノードだけに返す（変化ではないので changedBy は付けない）
  const before2 = out2(b2, 'settings').length
  const g = await input(b2, { topic: 'get-settings', changedBy: 'まぎらわしい値' })
  assert.equal(g.err, null)
  assert.equal(g.sent.length, 1)
  assert.equal(g.sent[0][1].topic, 'settings')
  assert.equal(g.sent[0][1].payload.fields.pollIntervalSec.value, 75)
  assert.equal(g.sent[0][1].changedBy, undefined)
  assert.equal(out2(b2, 'settings').length, before2 + 1)
  assert.equal(out2(b1, 'settings').length, 1, 'ほかのノードには出さない')

  // settings-reset（msg.rev が違えば断る）
  const bad = await input(b2, { topic: 'settings-reset', rev: 'nope' })
  assert.equal(bad.sent[0][1].payload.code, 'REVISION_MISMATCH')
  assert.equal(dev.sequencer.options.halfHourIntervalSec, 900)
  const r = await input(b2, { topic: 'settings-reset' })
  assert.equal(r.err, null)
  const s = r.sent[0][1]
  assert.equal(s.topic, 'settings')
  assert.equal(s.changedBy, 'flow:B')
  for (const k of Object.keys(s.payload.fields)) assert.notEqual(s.payload.fields[k].source, 'runtime', k)
  assert.equal(dev.sequencer.options.pollIntervalSec, 30, '設定ノードの値に戻る')
  assert.equal(dev.sequencer.options.halfHourIntervalSec, 1800, '設定ノードで空の項目は既定値に戻る')
  assert.equal(out2(b1, 'settings').length, 2)
  assert.equal(out2(b1, 'settings')[1].changedBy, 'flow:B')
  assert.ok(dev.handle.logsAfter({ limit: 1000 }).items.some((x) => /フロー（B）から運用設定を全部外しました/.test(x.text)))
})

test('画面（http-api）から保存・全部外すと、出力 2 に settings（changedBy は web-ui）が全部のノードから 1 通ずつ出る', async () => {
  // 戻すと落ちるもの: http-api.js の PUT / DELETE で settingsChanged に by を渡さない・wsuha-broute.js で handle の settings を購読しない
  const fake = setup()
  createDevice(fake, 'io-ui')
  const b1 = createBroute(fake, 'io-ui')
  const b2 = createBroute(fake, 'io-ui')
  const rev = (await fake.request('GET', B + '/adapters/io-ui/settings')).body.rev
  const r = await fake.request('PUT', B + '/adapters/io-ui/settings', { body: { pollEpcs: ['E7', 'E0'] }, headers: { 'if-match': rev } })
  assert.equal(r.statusCode, 200, r.text)
  for (const b of [b1, b2]) {
    const s = out2(b, 'settings')
    assert.equal(s.length, 1)
    assert.equal(s[0].changedBy, 'web-ui')
    assert.deepEqual(s[0].payload.fields.pollEpcs.value, ['0xE7', '0xE0'])
    assert.equal(s[0].payload.rev, r.body.rev)
  }
  const d = await fake.request('DELETE', B + '/adapters/io-ui/settings', { headers: { 'if-match': r.body.rev } })
  assert.equal(d.statusCode, 200, d.text)
  for (const b of [b1, b2]) {
    const s = out2(b, 'settings')
    assert.equal(s.length, 2)
    assert.equal(s[1].changedBy, 'web-ui')
    assert.equal(s[1].payload.fields.pollEpcs.source, 'config')
  }
  // 断った書き込み（412）では出さない
  await fake.request('PUT', B + '/adapters/io-ui/settings', { body: { pollIntervalSec: 60 }, headers: { 'if-match': 'old' } })
  assert.equal(out2(b1, 'settings').length, 2)
})

test('エディタで設定ノードの値を変えて作り直すと、その項目の運用設定が外れ、デプロイのあと出力 2 に settings（changedBy は editor）が出る', async () => {
  // 戻すと落ちるもの: wsuha-device.js の configValues に slowIntervalSec を入れない（4 項目の照合）・
  //                   http-api.js の flows:started で、エディタで外した知らせを wsuha-broute に出さない
  const userDir = tmpDir('wsuha-io-')
  const fake = setup({ userDir })
  const dev1 = createDevice(fake, 'io-ed')
  const b1 = createBroute(fake, 'io-ed')
  await input(b1, { topic: 'settings', payload: { pollIntervalSec: 60, slowIntervalSec: 600, halfHourIntervalSec: 900 } })
  assert.equal(dev1.sequencer.options.slowIntervalSec, 600)

  // 1. 同じ値のまま作り直す（名前だけ変えた）: 外さない・知らせない
  await fake.close(b1, false)
  await fake.close(dev1, false)
  const dev2 = createDevice(fake, 'io-ed', { name: '名前だけ変えた' })
  const b2 = createBroute(fake, 'io-ed')
  fake.events.emit('flows:started', { type: 'full' })
  assert.equal(out2(b2, 'settings').length, 0, '何も外れていなければ出さない')
  assert.equal(dev2.sequencer.options.slowIntervalSec, 600, '運用設定は残る')
  assert.equal(dev2.sequencer.options.pollIntervalSec, 60)

  // 2. エディタで 5 分の間隔（新しい欄）と取得間隔を変えて作り直す
  await fake.close(b2, false)
  await fake.close(dev2, false)
  const dev3 = createDevice(fake, 'io-ed', { slowIntervalSec: '900', pollInterval: 45 })
  const b3 = createBroute(fake, 'io-ed')
  const b4 = createBroute(fake, 'io-ed')
  assert.equal(out2(b3, 'settings').length, 0, 'デプロイが済む（flows:started）までは出さない（ほかのノードがまだ作られていない）')
  fake.events.emit('flows:started', { type: 'full' })
  for (const b of [b3, b4]) {
    const s = out2(b, 'settings')
    assert.equal(s.length, 1, 'デプロイのあとに 1 通')
    assert.equal(s[0].changedBy, 'editor')
    assert.equal(s[0].payload.fields.slowIntervalSec.source, 'config')
    assert.equal(s[0].payload.fields.slowIntervalSec.value, 900)
    assert.equal(s[0].payload.fields.pollIntervalSec.source, 'config')
    assert.equal(s[0].payload.fields.pollIntervalSec.value, 45)
    assert.equal(s[0].payload.fields.halfHourIntervalSec.source, 'runtime', '変えていない項目の運用設定は残る')
    assert.ok(s[0].payload.warnings.some((w) => /積算の取得間隔が変わったため/.test(w)), s[0].payload.warnings.join(' | '))
  }
  assert.equal(dev3.sequencer.options.slowIntervalSec, 900, '設定ノードの値が効く')
  assert.equal(dev3.sequencer.options.halfHourIntervalSec, 900)
  fake.events.emit('flows:started', { type: 'nodes' })
  assert.equal(out2(b3, 'settings').length, 1, '次のデプロイで繰り返さない')
  const disk = JSON.parse(fs.readFileSync(path.join(userDir, 'wsuha-broute', 'settings.json'), 'utf8'))
  assert.deepEqual(Object.keys(disk.adapters['io-ed'].fields), ['halfHourIntervalSec'])
  assert.equal(disk.adapters['io-ed'].updatedBy, 'editor')
  // 画面（GET settings）でも出どころが「設定ノード」に戻っている
  const g = await fake.request('GET', B + '/adapters/io-ed/settings')
  assert.equal(g.body.fields.slowIntervalSec.source, 'config')
})

test('SSE の settings: 一時的な上書き（フローの interval / epcs）・画面の「自動運転に戻す」・運用設定の無い項目のエディタでの変更でも出る。値が同じなら出さない', async () => {
  // 画面の設定タブは SSE の settings でしか取り直さないので、出ないと古い出どころと値のまま。
  // 戻すと落ちるもの: sse.js の changed で Settings を照らして出す処理を外す・
  //                   wsuha-broute.js の interval / epcs のあとの handle.notifyChanged() を外す（上書きは status を出さない）
  const fake = setup()
  const dev = createDevice(fake, 'io-sse')
  const b = createBroute(fake, 'io-sse', { name: 'n1' })
  await connected(dev)
  const s = fake.openStream(B + '/stream?adapter=io-sse')
  await s.done
  const frames = () => parseSse(s.res.text).filter((f) => f.event === 'settings' && f.data.adapterId === 'io-sse')
  const last = () => (frames().length ? frames()[frames().length - 1].data.settings.fields : null)
  const settle = () => new Promise((r) => setTimeout(r, 700)) // SSE の間引き（500 ms）より長く
  await settle()
  const n0 = frames().length

  // 1. フローの interval（一時的な上書き）
  await input(b, { topic: 'interval', payload: 60 })
  await waitFor(() => frames().length > n0 && last().pollIntervalSec.source === 'override', 3000, 'interval のあとの settings')
  assert.equal(last().pollIntervalSec.value, 60)
  // 2. フローの epcs
  await input(b, { topic: 'epcs', payload: ['E7', 'E8'] })
  await waitFor(() => last().pollEpcs.source === 'override', 3000, 'epcs のあとの settings')
  assert.deepEqual(last().pollEpcs.value, ['0xE7', '0xE8'])
  // 3. 画面の「自動運転に戻す」
  const auto = await fake.request('POST', B + '/adapters/io-sse/actions/auto')
  assert.equal(auto.statusCode, 200, auto.text)
  await waitFor(() => last().pollIntervalSec.source === 'config' && last().pollEpcs.source === 'config', 3000, 'auto のあとの settings')
  assert.equal(last().pollIntervalSec.value, 30)
  // 4. 値の変わらない状態の変化では出さない
  await settle()
  const n1 = frames().length
  dev.sequencer.emit('status', dev.sequencer.snapshot())
  await input(b, { topic: 'interval', payload: null }) // 上書きが無いので何も変わらない
  await settle()
  assert.equal(frames().length, n1, '同じ値の settings を繰り返さない')
  // 5. 運用設定の保存（PUT）は 1 通だけ（二重に出さない）
  const rev = (await fake.request('GET', B + '/adapters/io-sse/settings')).body.rev
  const put = await fake.request('PUT', B + '/adapters/io-sse/settings', { body: { slowIntervalSec: 600 }, headers: { 'if-match': rev } })
  assert.equal(put.statusCode, 200, put.text)
  await settle()
  assert.equal(frames().length, n1 + 1, 'PUT で 1 通')
  assert.equal(last().slowIntervalSec.source, 'runtime')
  // 6. 同じ値のまま作り直す（名前だけ変えた）: 出さない。止めてから作るまでの間（本物ではデプロイの途中）も待つ
  await fake.close(b, false)
  await fake.close(dev, false)
  await settle()
  createDevice(fake, 'io-sse', { name: '名前だけ変えた' })
  const b1 = createBroute(fake, 'io-sse')
  fake.events.emit('flows:started', { type: 'full' })
  await settle()
  assert.equal(frames().length, n1 + 1, '同じ値のまま作り直しても出さない')
  // 7. 運用設定の無い項目を、エディタで変えて作り直す（30 → 45）
  await fake.close(b1, false)
  await fake.close(fake.nodes.get('io-sse'), false)
  const dev2 = createDevice(fake, 'io-sse', { pollInterval: 45 })
  createBroute(fake, 'io-sse')
  fake.events.emit('flows:started', { type: 'full' })
  await waitFor(() => last().pollIntervalSec.source === 'config' && last().pollIntervalSec.value === 45, 3000, 'エディタの変更のあとの settings')
  assert.equal(last().slowIntervalSec.source, 'runtime', '運用設定のある項目はそのまま')
  assert.equal(dev2.handle.id, 'io-sse')
  s.req.emit('close')
})

// ---------------------------------------------------------------------------
//  入力 diag・detail と、status の health
// ---------------------------------------------------------------------------

test('入力 diag: 画面の診断と同じ許可リスト・同じ検証。出力 2 に diag。3 秒の制限は掛けない', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の diag の入力を外す・planDiag を通さない
  const fake = setup()
  const dev = createDevice(fake, 'io-diag')
  const b = createBroute(fake, 'io-diag')
  await connected(dev)

  let r = await input(b, { topic: 'diag', payload: { name: 'info' } })
  assert.equal(r.err, null, r.err && r.err.message)
  let d = r.sent[0][1]
  assert.equal(d.topic, 'diag')
  assert.equal(d.payload.name, 'info')
  assert.equal(d.payload.ok, true)
  assert.equal(typeof d.payload.at, 'number')
  assert.ok(d.payload.result.lines.some((l) => /^EVER/.test(l)), d.payload.result.lines.join(' | '))
  // 続けてすぐ（3 秒の制限はフローには掛けない）
  r = await input(b, { topic: 'diag', payload: { name: 'sreg', args: { reg: 'SFD' } } })
  assert.equal(r.err, null, r.err && r.err.message)
  assert.ok(r.sent[0][1].payload.result.lines.some((l) => /^ESREG [0-9A-F]{8}$/.test(l)))
  r = await input(b, { topic: 'diag', payload: { name: 'epc', args: { epcs: ['E8'] } } })
  assert.equal(r.err, null, r.err && r.err.message)
  assert.equal(r.sent[0][1].payload.result.values[0].epc, '0xE8')
  r = await input(b, { payload: { action: 'diag', name: 'ropt' } })
  assert.equal(r.err, null, 'payload.action でも指示できる')
  assert.equal(r.sent[0][1].payload.name, 'ropt')

  const sentBefore = dev.sequencer.transport.sent.length
  for (const [payload, code] of [
    [{ name: 'raw', args: { command: 'SKRESET' } }, 'FORBIDDEN_COMMAND'],
    [{ name: 'sreg', args: { reg: 'S99' } }, 'FORBIDDEN_COMMAND'],
    [{ name: 'sreg', args: { reg: 'S02', value: '21' } }, 'VALIDATION'],
    [{ name: 'table', args: { which: '3' } }, 'VALIDATION'],
    [{ name: 'epc', args: { epcs: ['E2'] } }, 'VALIDATION'],
    ['info', 'FORBIDDEN_COMMAND'],
  ]) {
    const x = await input(b, { topic: 'diag', payload })
    assert.ok(x.err, JSON.stringify(payload))
    const e = x.sent[0][1]
    assert.equal(e.topic, 'error', JSON.stringify(payload))
    assert.equal(e.payload.code, code, JSON.stringify(payload))
    assert.equal(e.payload.action, 'diag')
  }
  assert.equal(dev.sequencer.transport.sent.length, sentBefore, '断ったものは何も送らない')

  // アダプタの失敗（FAIL ER06）は DEVICE_ERROR。その前に結果を ok: false で出す
  dev.sequencer.transport.config.fail.sreg = ['SFD']
  try {
    const x = await input(b, { topic: 'diag', payload: { name: 'sreg', args: { reg: 'SFD' } } })
    assert.ok(x.err)
    assert.deepEqual(x.sent.map((m) => m[1].topic), ['diag', 'error'])
    assert.equal(x.sent[1][1].payload.code, 'DEVICE_ERROR')
    const d = x.sent[0][1].payload
    assert.equal(d.ok, false)
    assert.equal(d.error.code, 'ER06')
    assert.equal(d.command, 'SKSREG SFD')
    assert.equal(d.parsed, null)
    assert.ok(d.lines.some((l) => /^FAIL ER06/.test(l)), d.lines.join(' | '))
  } finally {
    dev.sequencer.transport.config.fail.sreg = []
  }
  assert.ok(dev.handle.logsAfter({ limit: 1000 }).items.some((x) => /フロー（broute-\d+）から診断「info」を実行しました/.test(x.text)))
})

test('入力 detail: 画面と同じ形の状態（AdapterDetail）を出力 2 へ。秘密は入らない', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の detail の入力を外す
  const fake = setup()
  const dev = createDevice(fake, 'io-detail')
  const b = createBroute(fake, 'io-detail')
  await connected(dev)
  const { err, sent } = await input(b, { topic: 'detail' })
  assert.equal(err, null)
  const d = sent[0][1]
  assert.equal(d.topic, 'detail')
  const api = (await fake.request('GET', B + '/adapters/io-detail')).body
  assert.equal(d.payload.id, 'io-detail')
  assert.deepEqual(Object.keys(d.payload).sort(), Object.keys(api).sort(), '画面の GET adapters/:id と同じ形')
  assert.equal(d.payload.health.level, 'ok')
  assert.equal(d.payload.credentials.pairId, ID.slice(-8))
  assertNoSecrets(JSON.stringify(d), 'detail')
})

// ---------------------------------------------------------------------------
//  入力 trend・logs・adapters・meta（読み出しも全部ノードから）
// ---------------------------------------------------------------------------

test('入力 trend・logs・adapters・meta: 画面の API と同じ形で、出力 2 に同じ topic で返す（入力の msg を引き継ぐ）', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の SHARED_TOPICS から trend・logs・adapters・meta を外す（「未知の指示です」になる）・
  //                   service.js の listAdapters で total を作らない・metaOf に editorRoot を入れない
  const fake = setup()
  const dev = createDevice(fake, 'io-rd')
  createDevice(fake, 'io-rd-off', { enabled: false })
  const b = createBroute(fake, 'io-rd', { name: '読み出し' })
  await connected(dev)
  assert.equal((await input(b, { topic: 'get', payload: ['E7', 'E8'] })).err, null)

  // trend（payload {range}）
  let r = await input(b, { topic: 'trend', payload: { range: '6h' }, correlation: 't-1' })
  assert.equal(r.err, null, r.err && r.err.message)
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0][0], null)
  let m = r.sent[0][1]
  assert.equal(m.topic, 'trend')
  assert.equal(m.correlation, 't-1', '入力の msg の項目を残す')
  assert.deepEqual(Object.keys(m.payload).sort(), ['from', 'series', 'to'])
  assert.equal(m.payload.to - m.payload.from, 6 * 3600 * 1000)
  assert.ok(m.payload.series.power.length >= 1, '取った値が推移に入っている')
  const api = (await fake.request('GET', B + '/adapters/io-rd/trend?range=6h')).body
  assert.deepEqual(m.payload.series, api.series, '画面の GET trend と同じ')
  // payload が無い・inject の時刻（数）なら 1h。文字列なら範囲。payload.action でも指示できる
  r = await input(b, { topic: 'trend', payload: Date.now() })
  assert.equal(r.sent[0][1].payload.to - r.sent[0][1].payload.from, 3600 * 1000)
  r = await input(b, { topic: 'trend', payload: '24h' })
  assert.equal(r.sent[0][1].payload.to - r.sent[0][1].payload.from, 24 * 3600 * 1000)
  r = await input(b, { payload: { action: 'trend', range: '24h' } })
  assert.equal(r.err, null)
  assert.equal(r.sent[0][1].topic, 'trend')
  for (const range of ['2h', 'constructor', 'toString', '__proto__']) {
    const x = await input(b, { topic: 'trend', payload: { range } })
    assert.ok(x.err, range + ' は done(err)')
    assert.equal(x.sent[0][1].topic, 'error', range)
    assert.equal(x.sent[0][1].payload.code, 'VALIDATION', range)
    assert.ok(x.sent[0][1].payload.details.range, range)
  }

  // logs（payload {after?, limit?, level?}。数でも文字列でもよい）
  r = await input(b, { topic: 'logs', payload: { after: 0, limit: 5 } })
  assert.equal(r.err, null, r.err && r.err.message)
  m = r.sent[0][1]
  assert.equal(m.topic, 'logs')
  assert.deepEqual(m.payload.items.map((x) => x.seq), [1, 2, 3, 4, 5], '古い順')
  assert.equal(m.payload.nextSeq, 5)
  const apiLogs = (await fake.request('GET', B + '/adapters/io-rd/logs?after=0&limit=5')).body
  assert.deepEqual(m.payload, apiLogs, '画面の GET logs と同じ')
  r = await input(b, { topic: 'logs', payload: { after: '3', limit: '2' } })
  assert.deepEqual(r.sent[0][1].payload.items.map((x) => x.seq), [4, 5])
  r = await input(b, { topic: 'logs', payload: { level: 'warn' } })
  assert.ok(r.sent[0][1].payload.items.every((x) => x.level === 'warn' || x.level === 'error'))
  r = await input(b, { topic: 'logs' })
  assert.equal(r.err, null)
  assert.ok(r.sent[0][1].payload.items.length >= 5, '引数が無ければ先頭から 200 件まで')
  for (const [q, field] of [
    [{ after: -1 }, 'after'],
    [{ after: 1.5 }, 'after'],
    [{ after: 'x' }, 'after'],
    [{ after: true }, 'after'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 1001 }, 'limit'],
    [{ level: 'debugx' }, 'level'],
  ]) {
    const x = await input(b, { topic: 'logs', payload: q })
    assert.ok(x.err, JSON.stringify(q))
    assert.equal(x.sent[0][1].payload.code, 'VALIDATION', JSON.stringify(q))
    assert.ok(x.sent[0][1].payload.details[field], JSON.stringify(q))
  }

  // adapters（全台の AdapterSummary[] と合計）
  r = await input(b, { topic: 'adapters' })
  assert.equal(r.err, null)
  m = r.sent[0][1]
  assert.equal(m.topic, 'adapters')
  const apiList = (await fake.request('GET', B + '/adapters')).body
  assert.deepEqual(m.payload.items.map((x) => x.id), apiList.items.map((x) => x.id), '画面の GET adapters と同じ並び')
  assert.ok(m.payload.items.some((x) => x.id === 'io-rd-off'), '無効の台も一覧には出る')
  assert.deepEqual(Object.keys(m.payload.items[0]).sort(), Object.keys(apiList.items[0]).sort(), '同じ形（AdapterSummary）')
  const mine = m.payload.items.find((x) => x.id === 'io-rd')
  assert.equal(typeof mine.power.value, 'number')
  assert.deepEqual(Object.keys(m.payload.total).sort(), ['count', 'enabled', 'power', 'staleCount'])
  assert.equal(m.payload.total.count, 1, '値の届いている有効な台だけを足す')
  assert.equal(m.payload.total.enabled, 1, '無効の台は数えない')
  assert.equal(m.payload.total.staleCount, 0)
  assert.equal(m.payload.total.power, mine.power.value)
  assert.deepEqual(m.payload.total, apiList.total, '画面の GET adapters と同じ合計')

  // meta（版のずれの確かめ・editorRoot）
  r = await input(b, { topic: 'meta' })
  assert.equal(r.err, null)
  m = r.sent[0][1]
  assert.equal(m.topic, 'meta')
  const apiMeta = (await fake.request('GET', B + '/meta')).body
  assert.deepEqual(m.payload, apiMeta, '画面の GET meta と同じ')
  assert.equal(m.payload.editorRoot, '/')
  assert.equal(m.payload.libVersion, m.payload.diskVersion)

  assertNoSecrets(JSON.stringify(out2(b)), '出力 2')
})

test('入力 trend・logs・adapters・meta: 設定ノードが無効でも、画面と API を載せていない（ui: false）サーバーでも使える', async () => {
  // 戻すと落ちるもの: service.js の metaOf を http-api.js（載せたときだけ）に戻す
  const fake = setup({ settings: { wsuhaBroute: { ui: false, readOnly: true }, httpAdminRoot: '/admin' } })
  createDevice(fake, 'io-rd-x', { enabled: false })
  const b = createBroute(fake, 'io-rd-x')
  assert.equal(fake.routes.filter((x) => String(x.path).indexOf('/wsuha-broute/api') === 0).length, 0, '前提: API は載っていない')
  for (const [topic, payload] of [['trend', { range: '1h' }], ['logs', { limit: 10 }], ['adapters', undefined], ['meta', undefined]]) {
    const r = await input(b, { topic, payload })
    assert.equal(r.err, null, topic + ': ' + (r.err && r.err.message))
    assert.equal(r.sent[0][1].topic, topic)
  }
  const meta = (await input(b, { topic: 'meta' })).sent[0][1].payload
  assert.equal(meta.editorRoot, '/admin/')
  assert.equal(meta.readOnly, true, 'readOnly は settings.js の値（フローの入力には掛けない）')
  assert.equal(meta.apiVersion, 1)
  const list = (await input(b, { topic: 'adapters' })).sent[0][1].payload
  assert.ok(list.items.some((x) => x.id === 'io-rd-x' && x.health.level === 'disabled'))
  assert.deepEqual(list.total, { power: null, count: 0, enabled: 0, staleCount: 0 })
})

test('status の payload に health を足す。既存の項目は変えない', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の withMeta で health を足さない
  const fake = setup()
  const dev = createDevice(fake, 'io-health')
  const b = createBroute(fake, 'io-health')
  await connected(dev)
  const { sent } = await input(b, { topic: 'status' })
  const st = sent[0][1]
  assert.equal(st.topic, 'status')
  assert.deepEqual(Object.keys(st.payload.health).sort(), ['level', 'nextAction', 'reasons', 'title'])
  assert.equal(st.payload.health.level, 'ok')
  assert.equal(st.payload.health.title, '計測中')
  // 既存の項目
  assert.equal(st.payload.device, '電力')
  assert.equal(st.payload.phase, 'connected')
  assert.equal(typeof st.payload.ts, 'string')
  assert.ok(st.payload.adapter && 'mac' in st.payload.adapter)
  // 停止の上書きを掛けると stopped になる（自発の status にも付く）
  await input(b, { topic: 'stop', payload: { reason: '点検' } })
  const last = out2(b, 'status').pop()
  assert.equal(last.payload.health.level, 'stopped')
  assert.deepEqual(last.payload.health.reasons, ['点検'])
  assertNoSecrets(JSON.stringify(out2(b)), '出力 2')
  assert.ok(!JSON.stringify(st.payload.health).includes(IDHINT), 'health には idHint も入れない')
})

test('出力 2 の status・recovered の credentials は {configured, source, pairId} だけ（認証 ID の先頭 4 桁を含む idHint を出さない）', async () => {
  // idHint はやめた。1.x のダッシュボードは status を認証の無い /ui に流していた。
  // 戻すと落ちるもの: wsuha-broute.js の withMeta で snapshot の credentials をそのまま出す
  const fake = setup()
  const dev = createDevice(fake, 'io-cred')
  const b = createBroute(fake, 'io-cred')
  await connected(dev)
  assert.ok(dev.sequencer.snapshot().credentials.idHint, '前提: snapshot には idHint がある')
  await input(b, { topic: 'status' })
  await input(b, { topic: 'stop', payload: { reason: '点検' } })
  await input(b, { topic: 'auto' })
  const list = out2(b, 'status')
  assert.ok(list.length >= 3, list.length + ' 通')
  for (const st of list) {
    assert.deepEqual(st.payload.credentials, { configured: true, source: '設定ノード', pairId: ID.slice(-8) })
  }
  const all = JSON.stringify(out2(b))
  assert.ok(!/idHint/.test(all), '出力 2 に idHint の項目がある')
  assert.ok(!all.includes(ID.slice(0, 4) + '…'), '認証 ID の先頭 4 桁が出ている')
  assertNoSecrets(all, '出力 2')
})

test('無効の設定ノードでも settings・get-settings・detail は使える。diag は error（DISABLED）', async () => {
  const fake = setup()
  createDevice(fake, 'io-off', { enabled: false })
  const b = createBroute(fake, 'io-off')
  const g = await input(b, { topic: 'get-settings' })
  assert.equal(g.err, null)
  assert.ok(g.sent[0][1].payload.warnings.some((w) => /無効/.test(w)))
  const s = await input(b, { topic: 'settings', payload: { pollIntervalSec: 120 } })
  assert.equal(s.err, null, s.err && s.err.message)
  assert.equal(s.sent[0][1].payload.fields.pollIntervalSec.source, 'runtime')
  const d = await input(b, { topic: 'detail' })
  assert.equal(d.sent[0][1].payload.health.level, 'disabled')
  const x = await input(b, { topic: 'diag', payload: { name: 'info' } })
  assert.ok(x.err)
  assert.equal(x.sent[0][1].payload.code, 'DISABLED')
  // 取り直しの要らない read は無効でも答える（無線を使わない）。取り直しの要る read は DISABLED
  const rd = await input(b, { topic: 'read' })
  assert.equal(rd.err, null, rd.err && rd.err.message)
  assert.equal(rd.sent[0][1].topic, 'read')
  assert.deepEqual(rd.sent[0][1].payload.values, {})
  const rd2 = await input(b, { topic: 'read', payload: { maxAgeSec: 0 } })
  assert.ok(rd2.err)
  assert.equal(rd2.sent[0][1].payload.code, 'DISABLED')
  // 既存の topic は今までどおり（無効なら理由つきで断る）
  const p = await input(b, { topic: 'poll' })
  assert.match(p.err.message, /無効/)
})

test('sequencer の無いとき（無効・開き直しの最中・初期化前）の今までの topic も、出力 2 の error（code つき）と done(err)', async () => {
  // 失敗は出力 2 の error（device・action・code・message・details・ts）と done(err)。
  // 前は done(err) だけで出力 2 に何も出ず、error を見て通知するフローに届かなかった。
  // code は預かりの道に合わせる: 無効は DISABLED、開き直しの最中は BUSY（預かりの道では預かる）、ほかは PORT_DOWN。
  // 戻すと落ちるもの: wsuha-broute.js の「sequencer が無い」の道で send2 を外す
  const fake = setup()
  createDevice(fake, 'io-noseq', { enabled: false })
  const b = createBroute(fake, 'io-noseq', { name: '無効の台' })
  const topics = [
    ['get', 'E7'],
    ['poll', ''],
    ['command', 'SKINFO'],
    ['status', ''],
    ['stop', { reason: '点検' }],
    ['start', ''],
    ['interval', 60],
    ['epcs', 'E7'],
  ]
  for (const [topic, payload] of topics) {
    const r = await input(b, { topic, payload })
    assert.ok(r.err, `${topic}: done(err)`)
    assert.match(r.err.message, /無効/)
    const errs = r.sent.filter((m) => m[1] && m[1].topic === 'error')
    assert.equal(errs.length, 1, `${topic}: 出力 2 の error が 1 通`)
    const e = errs[0][1].payload
    assert.equal(e.code, 'DISABLED', topic)
    assert.equal(e.action, topic)
    assert.equal(e.device, '電力')
    assert.equal(typeof e.message, 'string')
    assert.equal(typeof e.ts, 'string', 'ts は ISO の文字列（1.x のまま）')
    assert.equal(typeof e.at, 'number')
    assert.deepEqual(JSON.parse(JSON.stringify(e)), e, 'JSON の往復で変わらない')
  }
  // 開き直しの最中（sequencer が無い間）: 預からない topic（status など）は BUSY。
  // get・command は預かり、開き直してつながったら実行する（前は BUSY / PORT_DOWN ですぐ断っていた）
  const dev = createDevice(fake, 'io-noseq2')
  const b2 = createBroute(fake, 'io-noseq2')
  await connected(dev)
  await dev._close()
  dev.handle.setReconfiguring(true)
  let heldGet = null
  let heldCmd = null
  try {
    const r = await input(b2, { topic: 'status' })
    assert.ok(r.err)
    assert.equal(r.sent.filter((m) => m[1] && m[1].topic === 'error')[0][1].payload.code, 'BUSY')
    heldGet = input(b2, { topic: 'get', payload: 'E7' }, 20000)
    await waitFor(() => dev.handle.pending.stats().count === 1, 2000, 'get を預かる')
  } finally {
    dev.handle.setReconfiguring(false)
  }
  // 作り直しの合間（sequencer が無い・初期化の失敗ではない）: status は PORT_DOWN、command は預かる
  const r2 = await input(b2, { topic: 'status' })
  assert.ok(r2.err)
  assert.equal(r2.sent.filter((m) => m[1] && m[1].topic === 'error')[0][1].payload.code, 'PORT_DOWN')
  heldCmd = input(b2, { topic: 'command', payload: 'SKVER' }, 20000)
  await waitFor(() => dev.handle.pending.stats().count === 2, 2000, 'command を預かる')
  // 開き直す: 預かった command（ポートが開けば）と get（つながれば）が実行される
  dev._build()
  kit.speedUp(dev.sequencer)
  await dev._open()
  const [g, c] = await Promise.all([heldGet, heldCmd])
  assert.equal(c.err, null, c.err && c.err.message)
  assert.equal(c.sent[0][1].topic, 'command-result')
  assert.equal(g.err, null, g.err && g.err.message)
  assert.deepEqual(dev.handle.pending.stats(), { count: 0, oldestMs: null })
})

// ---------------------------------------------------------------------------
//  設定ノード（wsuha-device）: 5 分 / 30 分の間隔・エディタ用の httpAdmin
// ---------------------------------------------------------------------------

test('設定ノードの 5 分 / 30 分の間隔: sequencer に渡す。空・1.x のフロー（項目なし）は既定。範囲の外は既定にして warn', async () => {
  // 戻すと落ちるもの: wsuha-device.js で slowIntervalSec・halfHourIntervalSec を sequencer の options に渡さない
  const fake = setup()
  const set = createDevice(fake, 'io-tier', { slowIntervalSec: '600', halfHourIntervalSec: 3600 })
  assert.equal(set.sequencer.options.slowIntervalSec, 600)
  assert.equal(set.sequencer.options.halfHourIntervalSec, 3600)
  assert.equal(set.handle.configValues.slowIntervalSec, 600)
  assert.equal(set.handle.configValues.halfHourIntervalSec, 3600)
  const blank = createDevice(fake, 'io-tier-blank', { slowIntervalSec: '', halfHourIntervalSec: ' ' })
  assert.equal(blank.sequencer.options.slowIntervalSec, 300)
  assert.equal(blank.sequencer.options.halfHourIntervalSec, 1800)
  assert.equal(blank.handle.configValues.slowIntervalSec, null)
  const old = createDevice(fake, 'io-tier-1x') // 1.x のフローには項目が無い
  assert.equal(old.sequencer.options.slowIntervalSec, 300)
  assert.equal(old.handle.configValues.halfHourIntervalSec, null)
  const out = createDevice(fake, 'io-tier-out', { slowIntervalSec: '5', halfHourIntervalSec: '99999' })
  assert.equal(out.sequencer.options.slowIntervalSec, 300, '範囲の外（60〜3600）は既定値')
  assert.equal(out.sequencer.options.halfHourIntervalSec, 1800, '範囲の外（300〜7200）は既定値')
  assert.equal(out.handle.configValues.slowIntervalSec, null)
  assert.ok(out._warns.some((w) => /積算の取得間隔/.test(w) && /60〜3600/.test(w)), out._warns.join(' | '))
  const g = await fake.request('GET', B + '/adapters/io-tier/settings')
  assert.equal(g.body.fields.slowIntervalSec.source, 'config')
  assert.equal(g.body.fields.slowIntervalSec.configValue, 600)
})

test('設定ノードの定期取得の EPC に E2・E4・EC（履歴）があれば外して warn。残りが無ければ既定（E7・E8）。外したあとに戻る値（設定ノードの値）も同じ', async () => {
  // sequencer は履歴を含む一覧から履歴の 1 つだけを残すので、'E7, E2' だと毎回 E2 だけを取り、瞬時電力が取れなくなる。
  // 戻すと落ちるもの: wsuha-device.js で設定ノードの pollEpcs から履歴を外さない
  const fake = setup()
  const mixed = createDevice(fake, 'io-bulky', { pollEpcs: 'E7, E2, e8, EC' })
  assert.deepEqual(mixed.sequencer.options.pollEpcs, [0xe7, 0xe8])
  assert.ok(mixed._warns.some((w) => /E2/.test(w) && /EC/.test(w) && /外し/.test(w)), mixed._warns.join(' | '))
  const b = createBroute(fake, 'io-bulky')
  const g = await input(b, { topic: 'get-settings' })
  assert.deepEqual(g.sent[0][1].payload.fields.pollEpcs.configValue, ['0xE7', '0xE8'])
  // 運用設定を保存して全部外すと、設定ノードの値（履歴を外したもの）に戻る
  await input(b, { topic: 'settings', payload: { pollEpcs: ['E0'] } })
  assert.deepEqual(mixed.sequencer.options.pollEpcs, [0xe0])
  await input(b, { topic: 'settings-reset' })
  assert.deepEqual(mixed.sequencer.options.pollEpcs, [0xe7, 0xe8])

  const only = createDevice(fake, 'io-bulky2', { pollEpcs: 'E2' })
  assert.deepEqual(only.sequencer.options.pollEpcs, [0xe7, 0xe8], '残りが無ければ既定の E7・E8')
  assert.ok(only._warns.some((w) => /E2/.test(w)), only._warns.join(' | '))
  const ok = createDevice(fake, 'io-bulky3', { pollEpcs: 'E7, E8' })
  assert.deepEqual(ok.sequencer.options.pollEpcs, [0xe7, 0xe8])
  assert.ok(!ok._warns.some((w) => /履歴/.test(w)), '履歴が無ければ warn しない')
})

test('エディタ用の GET {httpAdminRoot}wsuha-broute/device/:id/settings（needsPermission wsuha-device.read・形は Settings）', async () => {
  // 戻すと落ちるもの: wsuha-device.js の httpAdmin の device/:id/settings を外す
  const fake = setup()
  const dev = createDevice(fake, 'io-editor')
  const b = createBroute(fake, 'io-editor')
  await input(b, { topic: 'settings', payload: { halfHourIntervalSec: 1200 } })
  const route = fake.routes.find((r) => r.method === 'GET' && r.path === '/wsuha-broute/device/:id/settings')
  assert.ok(route, '登録されている')
  assert.equal(route.app, 'admin', 'エディタ用なので httpAdmin')
  assert.equal(route.handlers[0].permission, 'wsuha-device.read')
  const denied = await fake.request('GET', '/wsuha-broute/device/io-editor/settings', { app: 'admin', unauthenticated: true })
  assert.equal(denied.statusCode, 401, 'エディタにログインしていなければ Node-RED が 401')
  const r = await fake.request('GET', '/wsuha-broute/device/io-editor/settings', { app: 'admin' })
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.deepEqual(Object.keys(r.body.fields).sort(), ['halfHourIntervalSec', 'pollEpcs', 'pollIntervalSec', 'slowIntervalSec'])
  assert.equal(r.body.fields.halfHourIntervalSec.source, 'runtime')
  assert.equal(r.body.fields.halfHourIntervalSec.value, 1200)
  assert.equal(r.body.fields.halfHourIntervalSec.by, 'flow:' + b.id)
  const api = (await fake.request('GET', B + '/adapters/io-editor/settings')).body
  assert.deepEqual(r.body, api, '画面の GET settings と同じ')
  const none = await fake.request('GET', '/wsuha-broute/device/nope/settings', { app: 'admin' })
  assert.equal(none.statusCode, 404)
  assert.equal(none.body.error.code, 'ADAPTER_NOT_FOUND')
  assert.ok(dev.handle)
})

test('wsuha-broute を使う設定ノードは 1 つの registry に載り、画面の API とフローの入力が同じ store を使う', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'io-same')
  const b = createBroute(fake, 'io-same')
  assert.equal(getRegistry().get('io-same'), dev.handle)
  const viaFlow = (await input(b, { topic: 'settings', payload: { pollIntervalSec: 200 } })).sent[0][1].payload
  const viaApi = (await fake.request('GET', B + '/adapters/io-same/settings')).body
  assert.deepEqual(viaFlow, viaApi)
})

// ---------------------------------------------------------------------------
//  エディタのヘルプと編集画面（文言の有無だけを見る。エディタの JS は動かしていない）
// ---------------------------------------------------------------------------

test('wsuha-broute のヘルプに、画面と同じ操作の入力と出力の表がある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-broute.html'), 'utf8')
  const help = html.slice(html.indexOf('data-help-name="wsuha-broute"'))
  for (const t of ['settings', 'settings-reset', 'get-settings', 'diag', 'detail', 'changedBy', 'health', 'msg.rev', 'flow:']) {
    assert.ok(help.includes(t), `ヘルプに ${t} が無い`)
  }
  // 読み出しの入力（trend・logs・adapters・meta）と、出力 2 の返事の行（入力と同じ topic）
  // 戻すと落ちるもの: wsuha-broute.html の入力の表と出力 2 の表から、読み出しの 4 つを外す
  // 行の頭（1 列目）で探す。入力の表の 4 列目（出力 2 の topic）にも同じ <td><code>meta</code></td> がある
  const inputTable = help.slice(help.indexOf('<h4>Web UI と同じ読み出し'), help.indexOf('<h3>出力 1'))
  const outputTable = help.slice(help.indexOf('<h3>出力 2'))
  assert.ok(inputTable.length > 0 && outputTable.length > 0, '読み出しの節と出力 2 の節がある')
  for (const t of ['trend', 'logs', 'adapters', 'meta']) {
    assert.ok(inputTable.includes(`<tr><td><code>${t}</code></td>`), `入力の表に ${t} の行が無い`)
    assert.ok(outputTable.includes(`<tr><td><code>${t}</code></td><td><code>${t}</code> の入力への返事`), `出力 2 の表に ${t} の行が無い`)
  }
  for (const t of ['editorRoot', 'range', 'after', 'limit', 'level', 'total']) {
    assert.ok(help.includes(t), `ヘルプに ${t} が無い`)
  }
  // 失敗は Catch で拾える・出力 2 の settings は「状態の変化」の入切に関係なく出る・get-settings の返事に changedBy は無い
  assert.match(help, /Catch/)
  assert.match(outputTable, /入切に関係なく/)
  assert.match(outputTable, /get-settings<\/code> の返事には <code>changedBy<\/code> を付けません/)
})

test('設定ノードは、画面を載せたかどうかをエディタへ渡す（registerType の settings: wsuhaDeviceWebUi、exportable）', () => {
  // エディタの RED.settings.httpNodeRoot は、サーバーが false でも '/' になる（getRuntimeSettings）。
  // wsuhaBroute.ui: false もエディタには届かない。設定ノードの型の設定として渡す。
  // Node-RED は、型の設定の名前が型の名前（wsuha-device → wsuhaDevice）で始まらないと登録しない（registerNodeSettings）。
  // 戻すと落ちるもの: wsuha-device.js の registerType に settings を渡さない
  const normalised = 'wsuha-device'.replace(/[^a-zA-Z0-9]/g, ' ').trim().replace(/ +/g, ' ').replace(/ ./g, (s) => s.charAt(1).toUpperCase())
  for (const [settings, available, reason] of [
    [{}, true, null],
    [{ httpNodeRoot: '/api/' }, true, null],
    [{ httpNodeRoot: false }, false, /httpNodeRoot が false/],
    [{ wsuhaBroute: { ui: false } }, false, /wsuhaBroute\.ui が false/],
  ]) {
    const fake = setup({ settings })
    const opts = fake.typeOpts['wsuha-device']
    assert.ok(opts && opts.credentials && opts.credentials.routeBPassword, '認証情報の定義がある')
    // text の型は GET /credentials/wsuha-device/<id> が値を返す。戻すと落ちるもの: wsuha-device.js の routeBId を text に戻す
    assert.deepEqual(opts.credentials, { routeBId: { type: 'password' }, routeBPassword: { type: 'password' } })
    const names = Object.keys((opts && opts.settings) || {})
    // EPC の表（wsuhaDeviceEpcCatalog）も渡す
    assert.deepEqual(names, ['wsuhaDeviceWebUi', 'wsuhaDeviceEpcCatalog', 'wsuhaDeviceRanges'], JSON.stringify(settings))
    for (const n of names) assert.ok(n.startsWith(normalised), `${n} は ${normalised} で始まる`)
    const s = opts.settings.wsuhaDeviceWebUi
    assert.equal(s.exportable, true)
    assert.equal(s.value.available, available, JSON.stringify(settings))
    if (reason) assert.match(s.value.reason, reason)
    else assert.equal(s.value.reason, null)
    assert.ok(!/[\\/]ui[\\/]|node_modules/.test(JSON.stringify(s.value)), 'サーバーのパスを入れない')
  }
})

test('wsuha-broute のヘルプ: http in から繋ぐ配線には、画面の API の守りが掛からないことを書く', () => {
  // http in の道には 415・BAD_ORIGIN・readOnly が掛からず、別のサイトのふつうのフォームや <img> からも届く。
  // ヘルプの勧めどおりに書き込み（stop・terminate・settings-reset）まで繋ぐと、画面の API で塞いだ CSRF を作り直してしまう。
  // 戻すと落ちるもの: wsuha-broute.html の http in の注意を消す
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-broute.html'), 'utf8')
  const help = html.slice(html.indexOf('data-help-name="wsuha-broute"'))
  const at = help.indexOf('<code>http in</code>')
  assert.ok(at >= 0, 'http in の配線の説明がある')
  const near = help.slice(at, at + 1800)
  for (const re of [/別のサイト/, /フォーム/, /httpNodeAuth/, /Origin/, /readOnly/, /get-settings/, /detail/]) {
    assert.match(near, re, 'http in の説明の近くに ' + re + ' が無い')
  }
  // 掛からない守りに Host（BAD_HOST）も入る。読み出しは trend・logs・adapters・meta も
  // 戻すと落ちるもの: wsuha-broute.html の http in の注意から Host と読み出しの 4 つを外す
  for (const re of [/Host/, /BAD_HOST/, /trend/, /logs/, /adapters/, /meta/, /msg\.req\.headers\.origin/]) {
    assert.match(near, re, 'http in の説明の近くに ' + re + ' が無い')
  }
})

test('wsuha-device の編集画面: 5 分 / 30 分の間隔の欄・運用設定の表示・Web UI のリンクは httpNodeRoot から', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-device.html'), 'utf8')
  for (const t of [
    'node-config-input-slowIntervalSec',
    'node-config-input-halfHourIntervalSec',
    'wsuha-broute/device/',
    'RED.settings.httpNodeRoot',
    'ここで値を変えてデプロイすると、この項目の運用設定は外れます',
  ]) {
    assert.ok(html.includes(t), `wsuha-device.html に ${t} が無い`)
  }
  const help = html.slice(html.indexOf('data-help-name="wsuha-device"'))
  // 知らない名前は 403 BAD_HOST、足すのは allowedHosts。idHint は外した
  // 戻すと落ちるもの: wsuha-device.html のヘルプから BAD_HOST・allowedHosts・idHint の記述を消す
  for (const t of ['BAD_HOST', 'allowedHosts']) assert.ok(help.includes(t), `wsuha-device のヘルプに ${t} が無い`)
})

test('エディタで外れた項目は、変えた人が editor・時刻が外したとき（フローの get-settings・画面の GET settings・エディタ用・出力 2 の settings）。保存し直すと消える', async () => {
  // 画面では「エディタ」。照合は記録から項目を消すので、前は by / at が null で、
  // 画面の「変えた人: エディタ」と時刻は決して出なかった（注意の文 warnings だけ）。
  // 戻すと落ちるもの: view-model.js の buildSettings で照合の dropped の項目に by: 'editor' と at を入れない
  const userDir = tmpDir('wsuha-io-')
  const fake = setup({ userDir })
  let dev = createDevice(fake, 'io-edby', { pollInterval: 30 })
  let b = createBroute(fake, 'io-edby', { name: 'E' })
  await connected(dev)
  assert.equal((await input(b, { topic: 'settings', payload: { pollIntervalSec: 60 } })).err, null)
  await fake.close(b, false)
  await fake.close(dev, false)
  const t0 = Date.now()
  dev = createDevice(fake, 'io-edby', { pollInterval: 45 }) // エディタで 45 秒に変えてデプロイした
  b = createBroute(fake, 'io-edby', { name: 'E' })
  fake.events.emit('flows:started', { type: 'full' })

  const check = (f, what) => {
    assert.equal(f.source, 'config', what)
    assert.equal(f.value, 45, what)
    assert.equal(f.by, 'editor', what + ': 変えた人')
    assert.ok(typeof f.at === 'number' && f.at >= t0 && f.at <= Date.now(), what + ': 外した時刻 ' + f.at)
    assert.equal(f.runtimeValue, null, what)
  }
  // デプロイのあとの知らせ（出力 2 の settings。入力への返事より先に見る）
  const notice = out2(b, 'settings')
  assert.equal(notice.length, 1)
  assert.equal(notice[0].changedBy, 'editor')
  check(notice[0].payload.fields.pollIntervalSec, '出力 2 の settings')
  const flow = (await input(b, { topic: 'get-settings' })).sent[0][1].payload
  check(flow.fields.pollIntervalSec, 'フローの get-settings')
  assert.ok(flow.warnings.some((w) => /取得間隔が変わったため、運用設定（60）を外しました/.test(w)), '注意の文は今までどおり')
  check((await fake.request('GET', B + '/adapters/io-edby/settings')).body.fields.pollIntervalSec, '画面の GET settings')
  check((await fake.request('GET', '/wsuha-broute/device/io-edby/settings', { app: 'admin' })).body.fields.pollIntervalSec, 'エディタ用')
  assert.equal(flow.fields.slowIntervalSec.by, null, '外していない項目には付けない')

  // 保存し直すと、その項目は運用設定（フローの名前）になる
  await input(b, { topic: 'settings', payload: { pollIntervalSec: 90 } })
  const again = (await input(b, { topic: 'get-settings' })).sent[0][1].payload.fields.pollIntervalSec
  assert.equal(again.source, 'runtime')
  assert.equal(again.by, 'flow:E')
})
