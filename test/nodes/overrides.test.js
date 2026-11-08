'use strict'

// 一時的な上書き（停止・取得間隔・定期取得の EPC）の寿命と、フローの interval / epcs の検証。
//
//  - 上書きは registry の AdapterHandle が持ち、デプロイをまたいで残る
//    （Node-RED の既定のデプロイは「全体」で、設定ノードも作り直す。設定ノードの変更・無効 → 有効も同じ）。
//    Node-RED の再起動でだけ消える（registry はメモリにしか無い）。理由は「点検中に別の変更をデプロイしても、勝手に動き出さない」。
//    設定ノードを削除したら外し、Node-RED のログに 1 行残す。
//  - フローの interval / epcs は、画面の PUT settings・フローの settings・設定ノードと同じ検証
//    （取得間隔は 15〜3600 の整数、EPC は 1〜6 個で履歴の E2・E4・EC は不可）。外れたら出力 2 の error に
//    code 'VALIDATION' と details（E2 を混ぜると、取得のたびに履歴だけが残って瞬時電力が取れなかった）。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { getRegistry, createRegistry } = require('../../lib/runtime/registry')
const { Sequencer } = require('../../lib/sequencer')
const { SimulatorTransport } = require('../../lib/simulator-transport')
const { waitFor } = require('../runtime/fake-red')
const { createKit, input, out2, connected } = require('./node-kit')

const kit = createKit()
const { setup, createDevice, createBroute } = kit
const B = '/wsuha-broute/api/v1'

afterEach(() => kit.cleanup())

/** 設定ノードがポートを開き終わり、start するかどうかが決まるまで待つ。 */
async function opened(dev) {
  await waitFor(() => dev.sequencer && dev.sequencer.state.portOpen && !dev._opening, 5000, 'ポートを開く')
}

/**
 * 全体のデプロイと同じ: wsuha-broute → 設定ノードの順に閉じ（removed=false）、同じ id で作り直す。
 * devExtra で設定ノードの値を変えられる（エディタで変えてデプロイした）。
 */
async function redeploy(fake, dev, broutes, devExtra) {
  for (const b of broutes) await fake.close(b, false)
  await fake.close(dev, false)
  const dev2 = createDevice(fake, dev.id, devExtra)
  const b2 = broutes.map((b) => createBroute(fake, dev.id, { name: b.name }))
  return { dev: dev2, broutes: b2 }
}

const radioCommands = (seq) => seq.transport.sent.filter((c) => /^SK(SCAN|JOIN|REJOIN|SENDTO)\b/.test(c))

// ---------------------------------------------------------------------------
//  一時的な上書きの寿命
// ---------------------------------------------------------------------------

test('停止の上書き（点検中）は、全体のデプロイ（設定ノードの作り直し）をまたいで残る。電波を出さず、理由と時刻もそのまま', async () => {
  // 前は、設定ノードを作り直すと new Sequencer → autoStart で start() し、「点検中」で止めた台がログも無く電波を出し始めた。
  // 戻すと落ちるもの: registry.js の detach で上書きを写さない・attach で当て直さない・
  //                   wsuha-device.js の _open で停止の上書きがあっても start() する
  const fake = setup()
  let dev = createDevice(fake, 'ov-stop')
  const h = dev.handle
  const b0 = createBroute(fake, 'ov-stop', { name: '点検' })
  await connected(dev)
  const r = await input(b0, { topic: 'stop', payload: { reason: '点検中' } })
  assert.equal(r.err, null)
  const at = dev.sequencer.state.overrides.stopped.at
  assert.equal(typeof at, 'number')

  const next = await redeploy(fake, dev, [b0])
  dev = next.dev
  const b = next.broutes[0]
  assert.equal(dev.handle, h, '同じ handle')
  await opened(dev)
  await new Promise((res) => setTimeout(res, 300)) // 動き出すならこの間に SKSCAN などを送る
  const seq = dev.sequencer
  assert.equal(seq._running, false, '自動運転に戻らない')
  assert.equal(seq.state.phase, 'overridden', '外部の指示で停止中')
  assert.deepEqual(seq.state.overrides.stopped, { reason: '点検中', at }, '理由と止めた時刻はそのまま')
  assert.deepEqual(radioCommands(seq), [], '電波を出さない')

  // 画面・フローにも「停止中（点検中）」で出る
  const d = await fake.request('GET', B + '/adapters/ov-stop')
  assert.equal(d.statusCode, 200, d.text)
  assert.equal(d.body.health.level, 'stopped')
  assert.equal(d.body.overridden.stopped.reason, '点検中')
  const st = (await input(b, { topic: 'status' })).sent[0][1]
  assert.equal(st.payload.health.level, 'stopped')

  // 引き継いだことを、アダプタのログと Node-RED のログ（設定ノードの warn）に残す
  const logs = h.logsAfter({ limit: 1000 }).items
  assert.ok(
    logs.some((x) => x.level === 'warn' && /引き継ぎ/.test(x.text) && /点検中/.test(x.text)),
    logs.map((x) => x.text).join('\n')
  )
  assert.ok(dev._warns.some((w) => /引き継ぎ/.test(w) && /点検中/.test(w)), dev._warns.join('\n'))

  // 「開始」で自動運転に戻る
  const s = await input(b, { topic: 'start' })
  assert.equal(s.err, null)
  await connected(dev)
  assert.equal(dev.sequencer.state.overrides.stopped, null)
})

test('画面の「停止」も、全体のデプロイをまたいで残る。応答の文は「デプロイでは外れません」', async () => {
  // 戻すと落ちるもの: registry.js の attach で当て直さない・http-api.js の停止の文を「再起動すると戻る」だけに戻す
  const fake = setup()
  let dev = createDevice(fake, 'ov-web')
  const b0 = createBroute(fake, 'ov-web')
  await connected(dev)
  const r = await fake.request('POST', B + '/adapters/ov-web/actions/stop', { body: { reason: '盤の点検' } })
  assert.equal(r.statusCode, 200, r.text)
  assert.match(r.body.message, /止めた状態はデプロイしても続きます/)
  dev = (await redeploy(fake, dev, [b0])).dev
  await opened(dev)
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(dev.sequencer._running, false)
  assert.equal(dev.sequencer.state.overrides.stopped.reason, '盤の点検')
  assert.deepEqual(radioCommands(dev.sequencer), [])
  const list = (await fake.request('GET', B + '/adapters')).body.items.filter((a) => a.id === 'ov-web')
  assert.equal(list[0].health.level, 'stopped', '一覧でも停止中')
})

test('セッション終了（terminate）の停止も残る。設定ノードを無効 → 有効にしても残る', async () => {
  // 戻すと落ちるもの: registry.js の attach で当て直さない・claim で上書きを捨てる
  const fake = setup()
  let dev = createDevice(fake, 'ov-term')
  let b = createBroute(fake, 'ov-term')
  await connected(dev)
  const t = await input(b, { topic: 'terminate' })
  assert.equal(t.err, null)
  assert.equal(dev.sequencer.state.overrides.stopped.reason, 'セッションを終了')

  // 無効にしてデプロイ: ポートを開かない
  let next = await redeploy(fake, dev, [b], { enabled: false })
  dev = next.dev
  b = next.broutes[0]
  assert.equal(dev.sequencer, null)
  // 有効に戻してデプロイ: 止めたまま
  next = await redeploy(fake, dev, [b], { enabled: true })
  dev = next.dev
  await opened(dev)
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(dev.sequencer._running, false, '自動運転に戻らない')
  assert.equal(dev.sequencer.state.overrides.stopped.reason, 'セッションを終了')
  assert.deepEqual(radioCommands(dev.sequencer), [])
  // 画面の「自動運転に戻す」で戻る
  const auto = await fake.request('POST', B + '/adapters/ov-term/actions/auto')
  assert.equal(auto.statusCode, 200, auto.text)
  await connected(dev)
})

test('取得間隔・EPC の上書きも、設定ノードの値を変えたデプロイをまたいで残る。auto で設定ノードの新しい値に戻る', async () => {
  // 戻すと落ちるもの: registry.js の attach で取得間隔・EPC の上書きを当て直さない
  const fake = setup()
  let dev = createDevice(fake, 'ov-int')
  let b = createBroute(fake, 'ov-int', { name: '上書き' })
  await connected(dev)
  assert.equal((await input(b, { topic: 'interval', payload: 90 })).err, null)
  assert.equal((await input(b, { topic: 'epcs', payload: ['E7', 'E8'] })).err, null)

  // エディタで取得間隔を 45 秒に変えてデプロイした
  const next = await redeploy(fake, dev, [b], { pollInterval: 45 })
  dev = next.dev
  b = next.broutes[0]
  await connected(dev)
  const seq = dev.sequencer
  assert.equal(seq._running, true, '停止の上書きは無いので動く')
  assert.equal(seq.options.pollIntervalSec, 90, '取得間隔の上書きは残る')
  assert.deepEqual(seq.options.pollEpcs, [0xe7, 0xe8], 'EPC の上書きは残る')
  assert.deepEqual(seq.state.overrides.pollEpcs, [0xe7, 0xe8])
  const s = (await input(b, { topic: 'get-settings' })).sent[0][1].payload
  assert.equal(s.fields.pollIntervalSec.source, 'override')
  assert.equal(s.fields.pollIntervalSec.value, 90)
  assert.equal(s.fields.pollIntervalSec.configValue, 45)
  assert.equal(s.fields.pollEpcs.source, 'override')

  // auto で外すと、設定ノードの新しい値（45 秒・E7）に戻る
  assert.equal((await input(b, { topic: 'auto' })).err, null)
  assert.equal(seq.options.pollIntervalSec, 45)
  assert.deepEqual(seq.options.pollEpcs, [0xe7])
})

test('上書きが無ければ、デプロイのあとは今までどおり自動運転で始まる（引き継ぎのログも出さない）', async () => {
  const fake = setup()
  let dev = createDevice(fake, 'ov-none')
  const b = createBroute(fake, 'ov-none')
  await connected(dev)
  // 止めてから「自動運転に戻す」: 上書きは全部外れている
  await input(b, { topic: 'stop', payload: { reason: '一時' } })
  await input(b, { topic: 'auto' })
  await connected(dev)
  dev = (await redeploy(fake, dev, [b])).dev
  await connected(dev)
  assert.equal(dev.sequencer._running, true)
  assert.deepEqual(dev.sequencer.state.overrides, { stopped: null, pollIntervalSec: null, pollEpcs: null })
  assert.ok(!dev.handle.logsAfter({ limit: 1000 }).items.some((x) => /引き継ぎ/.test(x.text)))
})

test('設定ノードを削除したら上書きは外し、Node-RED のログに 1 行残す。同じ id で作り直すと自動運転で始まる', async () => {
  // 戻すと落ちるもの: registry.js の release で removed のとき上書きを捨てない・wsuha-device.js の close でログに出さない
  const fake = setup()
  const dev = createDevice(fake, 'ov-del')
  const b = createBroute(fake, 'ov-del')
  await connected(dev)
  await input(b, { topic: 'stop', payload: { reason: '撤去' } })
  await fake.close(b, true)
  await fake.close(dev, true)
  const line = fake.logs.filter(([lv, text]) => /一時的な上書き/.test(text) && /撤去/.test(text))
  assert.equal(line.length, 1, JSON.stringify(fake.logs.slice(-5)))
  fake.events.emit('flows:started', {})
  assert.equal(getRegistry().get('ov-del'), null)

  // 同じ id を貼り直した（新しい設定ノード）
  const dev2 = createDevice(fake, 'ov-del')
  await connected(dev2)
  assert.equal(dev2.sequencer.state.overrides.stopped, null)
})

test('registry: 新しい sequencer を古いものの後片付けより先に付けても、上書きを持ち越す。遅れた detach は今のものに触らない', () => {
  // Node-RED の close が時間切れになると、古い設定ノードの後片付け（SKTERM の待ち）の途中で新しい設定ノードが出来る。
  // 戻すと落ちるもの: registry.js の attach で、前の sequencer を外すときに上書きを写さない
  const reg = createRegistry()
  const h = reg.upsert('u-carry')
  const s1 = new Sequencer(new SimulatorTransport({}), { pollIntervalSec: 30 })
  h.attach(s1)
  s1.stop('点検中', { external: true })
  s1.setPollInterval(120, { external: true })
  s1.setPollEpcs([0xe7, 0xe0], { external: true })
  const at = s1.state.overrides.stopped.at

  const s2 = new Sequencer(new SimulatorTransport({}), { pollIntervalSec: 30 })
  const carried = h.attach(s2)
  assert.ok(carried && typeof carried.text === 'string', '引き継いだものを返す')
  assert.deepEqual(s2.state.overrides.stopped, { reason: '点検中', at })
  assert.equal(s2.state.phase, 'overridden')
  assert.equal(s2.options.pollIntervalSec, 120)
  assert.equal(s2.state.overrides.pollIntervalSec, 120)
  assert.deepEqual(s2.options.pollEpcs, [0xe7, 0xe0])
  assert.equal(s2._baseline.pollIntervalSec, 30, '基準（設定ノードの値）は変えない')

  h.detach(s1) // 遅れて来た古い後片付け
  assert.equal(h.sequencer, s2)
  // 上書きの無い sequencer を外して付け直しても、何も持ち越さない
  s2.resetOverrides('試験')
  s2.stop('終了') // destroy と同じ（外部の指示ではない停止）
  h.detach(s2)
  const s3 = new Sequencer(new SimulatorTransport({}), {})
  assert.equal(h.attach(s3), null)
  assert.deepEqual(s3.state.overrides, { stopped: null, pollIntervalSec: null, pollEpcs: null })
})

// ---------------------------------------------------------------------------
//  フローの interval / epcs の検証
// ---------------------------------------------------------------------------

test('入力 interval・epcs: 画面と同じ検証（15〜3600 の整数・1〜6 個で履歴の E2・E4・EC は不可）。外れたら error（VALIDATION と details）で上書きを掛けない', async () => {
  // 前は epcs ['E7','E2'] が通り、取得のたびに履歴の E2 だけが残って瞬時電力が取れなかった。interval は上の限りが無かった。
  // 戻すと落ちるもの: wsuha-broute.js の interval / epcs で validateSettingsInput を通さない・error に code と details を付けない
  const fake = setup()
  const dev = createDevice(fake, 'ov-val')
  const b = createBroute(fake, 'ov-val', { name: '検証' })
  await connected(dev)
  const seq = dev.sequencer
  const before = { interval: seq.options.pollIntervalSec, epcs: seq.options.pollEpcs.slice() }

  const bad = [
    ['epcs', ['E7', 'E2'], 'pollEpcs'],
    ['epcs', ['E4'], 'pollEpcs'],
    ['epcs', 'EC', 'pollEpcs'],
    ['epcs', 0xe2, 'pollEpcs'],
    ['epcs', [], 'pollEpcs'],
    ['epcs', ['E7', 'E8', 'E0', 'E3', 'D3', 'D7', 'E1'], 'pollEpcs'],
    ['epcs', ['ZZ'], 'pollEpcs'],
    ['epcs', { epcs: ['E7', 'EC'] }, 'pollEpcs'],
    ['interval', 99999, 'pollIntervalSec'],
    ['interval', 3601, 'pollIntervalSec'],
    ['interval', 14, 'pollIntervalSec'],
    ['interval', 60.5, 'pollIntervalSec'],
    ['interval', 'abc', 'pollIntervalSec'],
    ['interval', Date.now(), 'pollIntervalSec'], // inject の既定の payload（時刻）
    ['interval', { value: 0 }, 'pollIntervalSec'],
  ]
  for (const [topic, payload, field] of bad) {
    const what = `${topic} ${JSON.stringify(payload)}`
    const r = await input(b, { topic, payload })
    assert.ok(r.err, what + ': done(err)（Catch で拾える）')
    assert.equal(r.sent.length, 1, what)
    const e = r.sent[0][1]
    assert.equal(e.topic, 'error', what)
    assert.equal(e.payload.code, 'VALIDATION', what)
    assert.equal(e.payload.action, topic, what)
    assert.equal(typeof e.payload.details[field], 'string', what + ': details.' + field)
    assert.match(e.payload.message, /確かめてください/, what)
  }
  assert.equal(seq.options.pollIntervalSec, before.interval, '取得間隔は変わらない')
  assert.deepEqual(seq.options.pollEpcs, before.epcs, 'EPC は変わらない')
  assert.deepEqual(seq.state.overrides, { stopped: null, pollIntervalSec: null, pollEpcs: null }, '上書きは掛からない')

  // 範囲の中は今までどおり上書きになる
  const good = [
    ['interval', 15, 15],
    ['interval', '3600', 3600],
    ['interval', { value: 60 }, 60],
  ]
  for (const [topic, payload, want] of good) {
    const r = await input(b, { topic, payload })
    assert.equal(r.err, null, `${topic} ${JSON.stringify(payload)}: ${r.err && r.err.message}`)
    assert.equal(seq.options.pollIntervalSec, want)
    assert.equal(seq.state.overrides.pollIntervalSec, want)
  }
  for (const [payload, want] of [
    ['E7', [0xe7]],
    [0xe7, [0xe7]],
    [['E7', '0xE8'], [0xe7, 0xe8]],
    ['E7, E8, E0', [0xe7, 0xe8, 0xe0]],
    [{ epcs: ['E7', 'E3'] }, [0xe7, 0xe3]],
  ]) {
    const r = await input(b, { topic: 'epcs', payload })
    assert.equal(r.err, null, `epcs ${JSON.stringify(payload)}: ${r.err && r.err.message}`)
    assert.deepEqual(seq.options.pollEpcs, want, JSON.stringify(payload))
  }
  // 空は今までどおり「その項目の上書きをやめる」
  assert.equal((await input(b, { topic: 'interval', payload: null })).err, null)
  assert.equal((await input(b, { topic: 'epcs', payload: '' })).err, null)
  assert.deepEqual(seq.state.overrides, { stopped: null, pollIntervalSec: null, pollEpcs: null })
  assert.equal(out2(b, 'error').length, bad.length, 'error は断ったものだけ')
})
