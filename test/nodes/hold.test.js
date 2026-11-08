'use strict'

// 最新値の読み出し（read）とコマンドの預かりを、偽の RED とシミュレーターで確かめる。
//
//  - read: 持っている値で無線を使わずにすぐ答える（入力の msg を引き継ぐ・JSON の往復で変わらない）。maxAgeSec より古ければ取りに行く
//  - 預かり: 未接続のときの get・command・read（maxAgeSec）を預かり、つながったら来た順に返す。途中で切れたら 1 回だけやり直す。
//    待つ長さを過ぎたら NOT_CONNECTED（waitedMs）・止めているときはすぐ STOPPED_BY_OVERRIDE・上限で BUSY・
//    デプロイをまたいで続く・Node-RED の停止とノードの削除で SHUTDOWN・status / detail に pendingCommands
//  - 画面の API: GET adapters/:id/read（maxAgeSec なしは無線を使わない。取りに行くときは預からずにすぐ答える）
//  - つながっているときの今までの topic（get・poll）は今までどおり 1 通ごとに取得する
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { waitFor, ID, PW } = require('../runtime/fake-red')
const { createKit, input, out2, connected, SIM } = require('./node-kit')

const kit = createKit()
const { setup, createDevice, createBroute } = kit
const B = '/wsuha-broute/api/v1'
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/

afterEach(() => kit.cleanup())

/** メーターが居ない（つながらない）シミュレータ。あとで transport.config.meterPresent = true で現す。 */
function absentSim(extra) {
  return JSON.stringify(Object.assign(JSON.parse(SIM), { meterPresent: false }, extra || {}))
}

/** 再試行の待ちを詰める（メーターが居ない間のスキャンの繰り返し）。 */
function fastRetry(dev) {
  dev.sequencer.options.maxRetryDelayMs = 100
  dev.sequencer.options.panaPendingMaxMs = 300
}

/** 入力を送り、done を待たずに結果を覚える。 */
function later(node, msg, timeoutMs) {
  const t = { done: false, err: null, sent: [], at: 0 }
  t.promise = input(node, msg, timeoutMs || 20000).then((r) => {
    t.done = true
    t.err = r.err
    t.sent = r.sent
    t.at = Date.now()
    return r
  })
  return t
}

/** 接続の直後は、接続時に 1 度だけ取る値（係数・製造番号など）しか持っていない。瞬時値と積算を 1 度取っておく。 */
async function prime(b) {
  const r = await input(b, { topic: 'get', payload: ['E7', 'E8', 'E0'] })
  assert.equal(r.err, null, r.err && r.err.message)
}

/** 入力を送るだけ（done を待たない・時間切れにしない）。 */
function fire(node, msg) {
  const t = { done: false, err: null, sent: [] }
  node.emit(
    'input',
    msg,
    (m) => {
      t.sent.push(m)
      node._sent.push(m)
    },
    (err) => {
      t.done = true
      t.err = err || null
    }
  )
  return t
}

function sendtoCount(dev) {
  return dev.sequencer.transport.sent.filter((l) => /^SKSENDTO/.test(String(l))).length
}

function assertNoSecrets(text, what) {
  for (const x of [ID, PW, ID.toLowerCase(), PW.toLowerCase(), ID.slice(0, 4) + '…' + ID.slice(-4)]) {
    assert.ok(!text.includes(x), `${what} に秘密（${x.slice(0, 4)}…）が出ている`)
  }
}

// ---------------------------------------------------------------------------
//  read
// ---------------------------------------------------------------------------

test('read: 持っている値で無線を使わずにすぐ答える（出力 2 の read・入力の msg を引き継ぐ・JSON の往復で変わらない）', async () => {
  // 戻すと落ちるもの: wsuha-broute.js で read を受けない（未知の指示）・read で sequencer.get を呼ぶ・msg を引き継がない
  const fake = setup()
  const dev = createDevice(fake, 'rd-now')
  const b = createBroute(fake, 'rd-now', { name: '読む係' })
  await connected(dev)
  await prime(b)
  const before = sendtoCount(dev)
  const r = await input(b, { topic: 'read', correlation: 'c-9' })
  assert.equal(r.err, null, r.err && r.err.message)
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0][0], null)
  const m = r.sent[0][1]
  assert.equal(m.topic, 'read')
  assert.equal(m.correlation, 'c-9', '入力の msg を引き継ぐ')
  const p = m.payload
  assert.deepEqual(Object.keys(p), ['device', 'deviceKey', 'ts', 'at', 'maxAgeSec', 'values', 'missing', 'refreshed'])
  assert.equal(p.device, '電力')
  assert.equal(p.deviceKey, dev.deviceKey)
  assert.match(p.ts, ISO)
  assert.equal(typeof p.at, 'number')
  const w = p.values.instantPower
  assert.ok(w, '瞬時電力: ' + Object.keys(p.values).join(', '))
  assert.equal(w.epc, 'E7')
  assert.equal(typeof w.value, 'number')
  assert.equal(w.unit, 'W')
  assert.equal(typeof w.at, 'number')
  assert.match(w.ts, ISO)
  assert.equal(typeof w.ageSec, 'number')
  assert.equal(w.fresh, true)
  assert.ok(p.values.cumulativeForward, '接続時に取る積算も持っている')
  assert.deepEqual(p.refreshed, [])
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p, 'JSON の往復で変わらない')
  assert.equal(sendtoCount(dev), before, '無線を使わない')
  // 頼んだ値だけ・名前で頼む・まだ無い値は missing
  const one = await input(b, { topic: 'read', payload: 'E7' })
  assert.deepEqual(Object.keys(one.sent[0][1].payload.values), ['instantPower'])
  const keys = await input(b, { topic: 'read', payload: { keys: ['instantCurrent'], epcs: ['EA'] } })
  assert.deepEqual(Object.keys(keys.sent[0][1].payload.values), ['instantCurrent'])
  assert.deepEqual(keys.sent[0][1].payload.missing, ['EA'], '30 分の定時積算はまだ無い')
  // 読めない入力は VALIDATION（入力の msg で error）
  const bad = await input(b, { topic: 'read', payload: ['E7', 'ZZ'], correlation: 'c-x' })
  assert.ok(bad.err)
  assert.equal(bad.sent[0][1].topic, 'error')
  assert.equal(bad.sent[0][1].correlation, 'c-x')
  assert.equal(bad.sent[0][1].payload.code, 'VALIDATION')
  assert.ok(bad.sent[0][1].payload.details.epcs)
  assert.equal(sendtoCount(dev), before, 'どれも無線を使わない')
  assertNoSecrets(JSON.stringify(b._sent), '出力')
})

test('read: maxAgeSec より古い・無い値があるときだけ取りに行ってから答える（refreshed）。新しければ無線を使わない', async () => {
  // 戻すと落ちるもの: read で maxAgeSec を見ない・staleOf で古さを見ない
  const fake = setup()
  const dev = createDevice(fake, 'rd-age')
  const b = createBroute(fake, 'rd-age')
  await connected(dev)
  await prime(b)
  let n = sendtoCount(dev)
  const fresh = await input(b, { topic: 'read', payload: { epcs: ['E7'], maxAgeSec: 3600 } })
  assert.equal(fresh.err, null)
  assert.deepEqual(fresh.sent[0][1].payload.refreshed, [])
  assert.equal(fresh.sent[0][1].payload.maxAgeSec, 3600)
  assert.equal(sendtoCount(dev), n, '1 時間より新しいので取りに行かない')
  await new Promise((r) => setTimeout(r, 1100))
  const old = await input(b, { topic: 'read', payload: ['E7', 'E8'], maxAgeSec: 1 })
  assert.equal(old.err, null, old.err && old.err.message)
  const p = old.sent[0][1].payload
  assert.deepEqual(p.refreshed, ['E7', 'E8'], 'msg.maxAgeSec でも取りに行く')
  assert.ok(sendtoCount(dev) > n, '取りに行った')
  assert.ok(p.values.instantPower.ageSec < 1, '取り直した値: ' + p.values.instantPower.ageSec)
  assert.equal(p.values.instantPower.fresh, true)
  // 取りに行った値は出力 1 にも出る（get と同じ）
  assert.ok(b._sent.some((x) => x[0] && x[0].payload && x[0].payload.values && x[0].payload.values.instantPower), '出力 1')
})

test('read: デプロイで sequencer を作り直しても、前に取れていた値で答える（まだ取り直していない値）', async () => {
  // 戻すと落ちるもの: registry の detach で値を写さない（knownValues）
  const fake = setup()
  const dev = createDevice(fake, 'rd-carry')
  const b = createBroute(fake, 'rd-carry')
  await connected(dev)
  await prime(b)
  const before = (await input(b, { topic: 'read', payload: 'E0' })).sent[0][1].payload.values.cumulativeForward
  assert.ok(before)
  await fake.close(b, false)
  await fake.close(dev, false)
  // 作り直した設定ノードはメーターが居ない（まだ何も取れていない）
  const dev2 = createDevice(fake, 'rd-carry', { simulatorOptions: absentSim() })
  const b2 = createBroute(fake, 'rd-carry')
  const r = await input(b2, { topic: 'read', payload: 'E0' })
  assert.equal(r.err, null)
  const v = r.sent[0][1].payload.values.cumulativeForward
  assert.ok(v, '前の sequencer の値で答える')
  assert.equal(v.at, before.at, '取れた時刻はそのまま（ageSec で古さが分かる）')
  assert.equal(dev2.sequencer.state.values['0xE0'], undefined, '新しい sequencer はまだ取っていない')
})

// ---------------------------------------------------------------------------
//  預かり
// ---------------------------------------------------------------------------

test('未接続のときの get・command・read（maxAgeSec）を預かり、つながったら来た順に返す（SKINFO はポートが開けば待たない）。status と detail に pendingCommands', async () => {
  // 戻すと落ちるもの: wsuha-broute.js の heldTopic を外して前の形（sequencer.get をすぐ呼ぶ）に戻す →「接続先アドレスが未確定です」ですぐ error
  const fake = setup()
  const dev = createDevice(fake, 'hd-order', { simulatorOptions: absentSim() })
  fastRetry(dev)
  const b = createBroute(fake, 'hd-order', { name: '預ける係' })
  const g = later(b, { topic: 'get', payload: 'E7' })
  const r = later(b, { topic: 'read', payload: { epcs: ['E8'], maxAgeSec: 0 }, correlation: 'r-1' })
  const c = later(b, { topic: 'command', payload: 'SKINFO' })
  await waitFor(() => c.done, 8000, 'SKINFO（ポートが開けば待たない）')
  assert.equal(c.err, null, c.err && c.err.message)
  assert.equal(c.sent[0][1].topic, 'command-result')
  assert.equal(c.sent[0][1].payload.ok, true)
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(g.done || r.done, false, '無線の要るものはつながるまで待つ（error にしない）')
  // 状態に預かりの数
  assert.equal(dev.handle.pending.stats().count, 2)
  const st = await input(b, { topic: 'status' })
  assert.equal(st.sent[0][1].payload.pendingCommands.count, 2)
  assert.equal(typeof st.sent[0][1].payload.pendingCommands.oldestMs, 'number')
  const d = await input(b, { topic: 'detail' })
  assert.equal(d.sent[0][1].payload.pendingCommands.count, 2)
  const api = await fake.request('GET', `${B}/adapters/hd-order`)
  assert.equal(api.body.pendingCommands.count, 2, '画面の API の詳細にも')
  const list = await fake.request('GET', `${B}/adapters`)
  assert.equal(list.body.items.find((x) => x.id === 'hd-order').pendingCommands.count, 2, '一覧にも')
  // メーターを現す → つながる → 来た順に返る
  dev.sequencer.transport.config.meterPresent = true
  await Promise.all([g.promise, r.promise])
  assert.equal(g.err, null, g.err && g.err.message)
  assert.equal(r.err, null, r.err && r.err.message)
  assert.ok(g.at <= r.at, '来た順（get が先）')
  assert.ok(b._sent.some((x) => x[0] && x[0].payload.values && x[0].payload.values.instantPower), 'get の値は出力 1')
  const rp = r.sent[0][1]
  assert.equal(rp.topic, 'read')
  assert.equal(rp.correlation, 'r-1')
  assert.deepEqual(rp.payload.refreshed, ['E8'])
  assert.ok(rp.payload.values.instantCurrent)
  assert.deepEqual(dev.handle.pending.stats(), { count: 0, oldestMs: null })
})

test('待つ長さを過ぎたら NOT_CONNECTED（waitedMs）と done(err)。msg.timeoutSec とノードの「つながるまで待つ長さ」', async () => {
  // 戻すと落ちるもの: waitMsOf で msg.timeoutSec・config.waitSec を見ない・errorPayload に waitedMs を入れない
  const fake = setup()
  createDevice(fake, 'hd-wait', { simulatorOptions: absentSim() })
  const b = createBroute(fake, 'hd-wait', { waitSec: 0.3 })
  const b2 = createBroute(fake, 'hd-wait')
  const t0 = Date.now()
  const r = await input(b, { topic: 'get', payload: 'E7' })
  assert.ok(Date.now() - t0 >= 280, 'ノードの設定の 0.3 秒は待つ')
  assert.ok(r.err)
  const e = r.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload
  assert.equal(e.code, 'NOT_CONNECTED')
  assert.equal(typeof e.waitedMs, 'number')
  assert.ok(e.waitedMs >= 280, 'waitedMs: ' + e.waitedMs)
  assert.equal(e.action, 'get')
  assert.equal(typeof e.ts, 'string', 'ts は ISO の文字列（1.x のまま）')
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e)
  // msg.timeoutSec が優先（既定 120 秒のノードでも）
  const t1 = Date.now()
  const r2 = await input(b2, { topic: 'diag', payload: { name: 'epc', args: { epcs: ['E7'] } }, timeoutSec: 0.2 })
  assert.ok(Date.now() - t1 < 3000)
  assert.equal(r2.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload.code, 'NOT_CONNECTED')
  // 読めない timeoutSec は VALIDATION
  const r3 = await input(b2, { topic: 'get', payload: 'E7', timeoutSec: -1 })
  assert.equal(r3.sent[0][1].payload.code, 'VALIDATION')
  assert.ok(r3.sent[0][1].payload.details.timeoutSec)
  // ノードの設定が範囲の外なら既定にして warn
  const b3 = createBroute(fake, 'hd-wait', { waitSec: 99999 })
  assert.ok(b3._warns.some((w) => /つながるまで待つ長さ/.test(w)), b3._warns.join(' / '))
})

test('外部の指示で止めているとき（stop・terminate）は待たずに STOPPED_BY_OVERRIDE。待っている間に止めても', async () => {
  // 戻すと落ちるもの: pending.js の hopeless で overrides.stopped を見ない
  const fake = setup()
  const dev = createDevice(fake, 'hd-stop')
  const b = createBroute(fake, 'hd-stop')
  await connected(dev)
  await input(b, { topic: 'stop', payload: { reason: '点検中' } })
  const t0 = Date.now()
  for (const msg of [{ topic: 'get', payload: 'E7' }, { topic: 'poll' }, { topic: 'read', payload: { maxAgeSec: 0 } }, { topic: 'diag', payload: { name: 'propmap' } }]) {
    const r = await input(b, msg)
    assert.ok(r.err, msg.topic)
    const e = r.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload
    assert.equal(e.code, 'STOPPED_BY_OVERRIDE', msg.topic)
    assert.match(e.message, /点検中/)
  }
  assert.ok(Date.now() - t0 < 2000, '待たない')
  // モジュールだけで答えるコマンドは、ポートが開いていれば止めていても答える（接続を待たない）
  const c = await input(b, { topic: 'command', payload: 'SKVER' })
  assert.equal(c.err, null)
  // terminate も同じ
  await input(b, { topic: 'start' })
  await connected(dev)
  await input(b, { topic: 'terminate' })
  const t = await input(b, { topic: 'get', payload: 'E7' })
  assert.equal(t.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload.code, 'STOPPED_BY_OVERRIDE')
})

test('預かれる数の上限（20）を超えたら BUSY。未接続のあいだに重なった同じ poll は 1 回の取得でまとめて答える', async () => {
  // 戻すと落ちるもの: 上限を見ない・同じ取得をまとめない（つながった瞬間に 20 回の取得）
  const fake = setup()
  const dev = createDevice(fake, 'hd-busy', { simulatorOptions: absentSim() })
  fastRetry(dev)
  const b = createBroute(fake, 'hd-busy')
  const held = []
  for (let i = 0; i < 20; i++) held.push(later(b, { topic: 'poll', payload: Date.now() }))
  await waitFor(() => dev.handle.pending.stats().count === 20, 2000, '20 件')
  const r = await input(b, { topic: 'get', payload: 'E7' })
  assert.ok(r.err)
  assert.equal(r.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload.code, 'BUSY')
  dev.sequencer.transport.config.meterPresent = true
  await Promise.all(held.map((x) => x.promise))
  assert.ok(held.every((x) => !x.err), '20 件とも done()')
  const manual = dev.sequencer.transport.sent.filter((l) => /^SKSENDTO/.test(String(l))).length
  assert.ok(manual < 12, '1 回の取得でまとめた（接続時の取得を合わせても少ない）: ' + manual)
})

test('つながっているときの get・poll は今までどおり 1 通ごとに取得する（まとめない）', async () => {
  // 戻すと落ちるもの: 接続中もまとめる
  const fake = setup()
  const dev = createDevice(fake, 'hd-live')
  const b = createBroute(fake, 'hd-live')
  await connected(dev)
  const seq = dev.sequencer
  const calls = []
  const orig = seq.get.bind(seq)
  seq.get = (epcs, purpose) => {
    calls.push(purpose)
    return orig(epcs, purpose)
  }
  const rs = await Promise.all([input(b, { topic: 'get', payload: 'E7' }), input(b, { topic: 'get', payload: 'E7' }), input(b, { topic: 'poll' })])
  assert.ok(rs.every((x) => !x.err))
  assert.deepEqual(calls.filter((p) => p === 'manual'), ['manual', 'manual', 'manual'], '1 通ごとに取得する')
})

test('実行の途中でセッションが切れたら（SKSENDTO が無応答で再接続に入った）、つなぎ直したあとに 1 回だけやり直す', async () => {
  // 戻すと落ちるもの: pending.js の dropped を外す（1 回目の失敗をそのまま error にする）
  const fake = setup()
  const dev = createDevice(fake, 'hd-retry')
  const b = createBroute(fake, 'hd-retry')
  await connected(dev)
  // 戻すと落ちるもの（追加）: pending.js の reconnected を外す（つなぎ直す前の、まだ connected に見える間に送り直す）
  const seq = dev.sequencer
  const tr = seq.transport
  // 次の SKSENDTO に 3 回続けて答えない → sequencer は SKRESET からやり直す
  // （EVENT 21 PARAM=01 の連続では再接続にしない）
  tr.state.muted = 0
  tr.config.fail.mute = 3
  const reconnects = seq.state.counters.reconnects
  // 送った順に、接続の段階と手で頼んだ取得を並べる
  const events = []
  seq.on('phase', (c) => events.push('phase:' + c.to))
  const orig = seq.get.bind(seq)
  seq.get = (epcs, purpose) => {
    // 呼ばれたときの段階も（handle の受け手が先に動くので、この試験の phase の受け手より先に呼ばれることがある）
    if (purpose === 'manual') events.push('get@' + seq.state.phase)
    return orig(epcs, purpose)
  }
  const r = await input(b, { topic: 'get', payload: 'E7' }, 30000)
  assert.equal(r.err, null, r.err && r.err.message)
  assert.ok(seq.state.counters.reconnects > reconnects, '再接続した')
  const gets = events.map((e, i) => (e.startsWith('get@') ? i : -1)).filter((i) => i >= 0)
  assert.equal(gets.length, 2, '1 回目と、やり直しの 1 回: ' + events.join(' '))
  const between = events.slice(gets[0] + 1, gets[1])
  assert.ok(between.some((e) => e.startsWith('phase:') && e !== 'phase:connected'), 'つなぎ直してから送り直した: ' + events.join(' '))
  assert.equal(events[gets[1]], 'get@connected', 'connected に戻ってから: ' + events.join(' '))
  assert.ok(dev.handle.logsAfter({ limit: 1000 }).items.some((x) => /もう一度送ります/.test(x.text)), 'アダプタのログに 1 行')
  assert.equal(r.sent.filter((x) => x[1] && x[1].topic === 'error').length, 0)
})

test('デプロイ（設定ノードとこのノードの作り直し）をまたいで続き、返事は同じ id の新しいノードから出る', async () => {
  // 戻すと落ちるもの: 預かりを sequencer に持たせる・返事を前のノードの send で出す（閉じたノードからは出ない）
  const fake = setup()
  const dev = createDevice(fake, 'hd-deploy', { simulatorOptions: absentSim() })
  fastRetry(dev)
  const b = createBroute(fake, 'hd-deploy', { name: '前' })
  const held = fire(b, { topic: 'read', payload: { epcs: ['E7'], maxAgeSec: 0 }, correlation: 'dep-1' })
  await waitFor(() => dev.handle.pending.stats().count === 1, 2000, '預かる')
  // Node-RED の全体のデプロイ: 使っているノード → 設定ノードの順に閉じて、同じ id で作り直す
  await fake.close(b, false)
  await fake.close(dev, false)
  assert.equal(dev.handle.pending.stats().count, 1, '作り直しの間も預かったまま')
  const dev2 = createDevice(fake, 'hd-deploy') // こんどはメーターが居る
  const b2 = fake.create('wsuha-broute', { id: b.id, device: 'hd-deploy', name: '後' })
  kit.open.push([fake, b2])
  fake.events.emit('flows:started', { type: 'full' })
  await waitFor(() => b2._sent.some((m) => m[1] && m[1].topic === 'read'), 20000, '新しいノードからの read')
  const reply = b2._sent.find((m) => m[1] && m[1].topic === 'read')[1]
  assert.equal(reply.correlation, 'dep-1', '入力の msg を引き継ぐ')
  assert.deepEqual(reply.payload.refreshed, ['E7'])
  assert.ok(reply.payload.values.instantPower)
  assert.equal(held.done, false, '前のノードの done は呼ばない（閉じている）')
  assert.ok(!b._sent.some((m) => m[1] && m[1].topic === 'read'), '前のノードからは出さない')
  assert.ok(dev2.sequencer, '新しい sequencer で実行した')
})

test('Node-RED の停止で、預かったものを SHUTDOWN で返す。ノードを削除したときもそのノードの分を SHUTDOWN', async () => {
  // 戻すと落ちるもの: http-api.js の runtime-event で pending.shutdown を呼ばない・close で cancelOwner を呼ばない
  // ここは偽の RED でノードを閉じる前に runtime-state の stop を出す（返事の形を見るため）。
  // Node-RED 3.1.3 の本当の順（ノードを閉じてから stop。error は届かない）は、下の「Node-RED 3.1 の停止の順」の試験
  const fake = setup()
  createDevice(fake, 'hd-down', { simulatorOptions: absentSim() })
  const b1 = createBroute(fake, 'hd-down')
  const b2 = createBroute(fake, 'hd-down')
  const a = later(b1, { topic: 'get', payload: 'E7' })
  const c = later(b2, { topic: 'command', payload: 'SKSENDTO 1 FE80:0000:0000:0000:0000:0000:0000:0001 0E1A 1 0 0001 X' })
  await waitFor(() => b1.device.handle.pending.stats().count === 2, 2000, '預かる')
  await fake.close(b2, true)
  await c.promise
  assert.equal(c.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload.code, 'SHUTDOWN', '削除したノードの分')
  assert.equal(a.done, false, 'ほかのノードの分は残る')
  fake.events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop', deploy: true } })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(a.done, false, 'デプロイの停止（deploy: true）では返さない')
  fake.events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop' } })
  await a.promise
  assert.ok(a.err)
  const e = a.sent.find((x) => x[1] && x[1].topic === 'error')[1].payload
  assert.equal(e.code, 'SHUTDOWN')
  assert.match(e.message, /Node-RED を止める/)
})

// ---------------------------------------------------------------------------
//  画面の API: GET adapters/:id/read
// ---------------------------------------------------------------------------

/** 電波を使う GET read に要るヘッダ（画面は必ず付ける）。 */
const RADIO = { 'x-wsuha-radio': '1' }

test('GET adapters/:id/read: maxAgeSec なしは無線を使わない。取りに行くときは預からず、未接続は 503・別のサイトと X-Wsuha-Radio なしは 403・readOnly は 403', async () => {
  // 戻すと落ちるもの: http-api.js の read のルートを外す（404）・maxAgeSec なしで取りに行く・別のサイトの GET で電波を使う
  const fake = setup()
  const dev = createDevice(fake, 'api-read')
  const b = createBroute(fake, 'api-read')
  await connected(dev)
  await prime(b)
  const n = sendtoCount(dev)
  const r = await fake.request('GET', `${B}/adapters/api-read/read?epcs=E7,E8`)
  assert.equal(r.statusCode, 200, r.text)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.deepEqual(Object.keys(r.body.values), ['instantPower', 'instantCurrent'])
  assert.equal(r.body.device, '電力')
  assert.equal(sendtoCount(dev), n, '無線を使わない')
  const all = await fake.request('GET', `${B}/adapters/api-read/read`)
  assert.ok(all.body.values.instantPower && all.body.values.cumulativeForward)
  // X-Wsuha-Radio が無ければ、同じオリジンでも電波を使わない
  const bare = await fake.request('GET', `${B}/adapters/api-read/read?keys=instantPower&maxAgeSec=0`)
  assert.equal(bare.statusCode, 403, bare.text)
  assert.equal(bare.body.error.code, 'BAD_ORIGIN')
  assert.equal(sendtoCount(dev), n, 'ヘッダが無ければ電波を使わない')
  // 取りに行く
  const age = await fake.request('GET', `${B}/adapters/api-read/read?keys=instantPower&maxAgeSec=0`, { headers: RADIO })
  assert.equal(age.statusCode, 200, age.text)
  assert.deepEqual(age.body.refreshed, ['E7'])
  assert.ok(sendtoCount(dev) > n)
  // 別のサイトのページからの GET（img など）では電波を使わない。持っている値だけなら答える
  const cross = await fake.request('GET', `${B}/adapters/api-read/read?epcs=E7&maxAgeSec=0`, { headers: Object.assign({ 'sec-fetch-site': 'cross-site' }, RADIO) })
  assert.equal(cross.statusCode, 403, cross.text)
  assert.equal(cross.body.error.code, 'BAD_ORIGIN')
  const crossOk = await fake.request('GET', `${B}/adapters/api-read/read?epcs=E7`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossOk.statusCode, 200, '無線を使わない読み出しは今までの GET と同じ')
  const origin = await fake.request('GET', `${B}/adapters/api-read/read?epcs=E7&maxAgeSec=0`, { headers: Object.assign({ origin: 'http://evil.example' }, RADIO) })
  assert.equal(origin.body.error.code, 'BAD_ORIGIN')
  // 入力の検証・404
  assert.equal((await fake.request('GET', `${B}/adapters/api-read/read?epcs=E7,QQ`)).body.error.code, 'VALIDATION')
  assert.equal((await fake.request('GET', `${B}/adapters/api-read/read?maxAgeSec=-1`)).statusCode, 422)
  assert.equal((await fake.request('GET', `${B}/adapters/nope/read`)).body.error.code, 'ADAPTER_NOT_FOUND')
  // readOnly なら取りに行くものだけ 403
  fake.settings.wsuhaBroute = { readOnly: true }
  try {
    assert.equal((await fake.request('GET', `${B}/adapters/api-read/read?maxAgeSec=0`, { headers: RADIO })).body.error.code, 'READ_ONLY')
    assert.equal((await fake.request('GET', `${B}/adapters/api-read/read`)).statusCode, 200)
  } finally {
    delete fake.settings.wsuhaBroute
  }
  // 未接続は預からずにすぐ 503（画面は状態が見えているので待たせない）
  await dev.sequencer.stop('試験', { external: false })
  dev.sequencer.state.connected = false
  dev.sequencer._setPhase('idle', '試験')
  const t0 = Date.now()
  const down = await fake.request('GET', `${B}/adapters/api-read/read?epcs=E7&maxAgeSec=0`, { headers: RADIO })
  assert.equal(down.statusCode, 503, down.text)
  assert.equal(down.body.error.code, 'NOT_CONNECTED')
  assert.ok(Date.now() - t0 < 1000)
  assertNoSecrets(JSON.stringify([r.body, all.body, age.body]), 'API の応答')
})

// ---------------------------------------------------------------------------
//  預かりの細かい動き
// ---------------------------------------------------------------------------

test('つながっているときは、前の get の応答が遅くても、後ろの get・SKINFO を NOT_CONNECTED にしない。SKINFO は get の実行中でも答える', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: pending.js で待つ長さの時計を submit から実行まで止めない・kick で実行中があると kind に関係なく待たせる
  const fake = setup()
  const dev = createDevice(fake, 'hd-slowm')
  const b = createBroute(fake, 'hd-slowm', { waitSec: 0.5 })
  await connected(dev)
  // メーターの応答を遅くする（待つ長さ 0.5 秒より長い）
  dev.sequencer.transport.config.echonetDelayMs = 1200
  const a = later(b, { topic: 'get', payload: 'E7' })
  const c = later(b, { topic: 'get', payload: 'E8' })
  const d = later(b, { topic: 'command', payload: 'SKINFO' })
  await Promise.all([a.promise, c.promise, d.promise])
  for (const [t, what] of [[a, 'get E7'], [c, 'get E8'], [d, 'SKINFO']]) {
    const e = t.sent.find((x) => x[1] && x[1].topic === 'error')
    assert.equal(t.err, null, what + ': ' + (e ? e[1].payload.code + ' / ' + e[1].payload.message : t.err && t.err.message))
  }
  assert.ok(d.at <= a.at, 'SKINFO は get の応答を待たない（1.x と同じ）')
  assert.ok(a.at <= c.at, 'get は来た順')
})

test('read の maxAgeSec: 0（いつも取り直す）で取り直した値は fresh: true。取り直す単位が 2 つ以上でも', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: read-values.js の bodyOf で、この回に取り直した値（refreshedSince より後）を fresh にしない
  const fake = setup()
  const dev = createDevice(fake, 'rd-zero')
  const b = createBroute(fake, 'rd-zero')
  await connected(dev)
  await prime(b)
  await new Promise((r) => setTimeout(r, 30))
  const one = await input(b, { topic: 'read', payload: { epcs: ['E7'], maxAgeSec: 0 } })
  assert.equal(one.err, null, one.err && one.err.message)
  const p1 = one.sent[0][1].payload
  assert.deepEqual(p1.refreshed, ['E7'])
  assert.equal(p1.values.instantPower.fresh, true, 'この回に取り直した値: ' + JSON.stringify(p1.values.instantPower))
  // 7 個（6 個ずつ取り直すので 2 回）。最初の回の値も fresh
  const seven = ['E7', 'E8', 'E0', 'E3', 'D3', 'E1', '80']
  const many = await input(b, { topic: 'read', payload: { epcs: seven, maxAgeSec: 0 } })
  assert.equal(many.err, null, many.err && many.err.message)
  const p2 = many.sent[0][1].payload
  assert.deepEqual(p2.refreshed, seven)
  for (const [k, v] of Object.entries(p2.values)) assert.equal(v.fresh, true, k + ': ' + JSON.stringify(v))
  // 画面の API も同じ
  const api = await fake.request('GET', B + '/adapters/rd-zero/read?epcs=E7&maxAgeSec=0', { headers: RADIO })
  assert.equal(api.statusCode, 200, api.text)
  assert.equal(api.body.values.instantPower.fresh, true, JSON.stringify(api.body.values.instantPower))
  // 取り直していない値は、今までどおり maxAgeSec で決まる
  const plain = await input(b, { topic: 'read', payload: { epcs: ['E7'] }, maxAgeSec: 3600 })
  assert.equal(plain.sent[0][1].payload.values.instantPower.fresh, true)
  assert.deepEqual(plain.sent[0][1].payload.refreshed, [])
})

test('エディタで認証 ID を変えてデプロイしたら、つながる前の read に前の契約の値を出さない（同じ ID なら出す）', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: registry.js の claim で認証 ID の変化を見ない（forgetSupported を呼ばない）
  const fake = setup()
  const dev = createDevice(fake, 'rd-other')
  const b = createBroute(fake, 'rd-other')
  await connected(dev)
  await prime(b)
  await fake.close(b, false)
  await fake.close(dev, false)
  // 同じ ID のまま作り直す（メーターが居ない）: 前の値で答える
  const dev2 = createDevice(fake, 'rd-other', { simulatorOptions: absentSim() })
  const b2 = createBroute(fake, 'rd-other')
  const same = (await input(b2, { topic: 'read' })).sent[0][1].payload
  assert.ok(same.values.instantPower, '同じ契約なら前の値を出す')
  assert.ok(same.values.serialNumber, '製造番号も')
  await fake.close(b2, false)
  await fake.close(dev2, false)
  // 別の認証 ID（架空の値）にしてデプロイ。メーターは居ない（つながらない）
  const OTHER = 'FEDCBA9876543210FEDCBA9876543210'
  const dev3 = createDevice(fake, 'rd-other', { simulatorOptions: absentSim(), _credentials: { routeBId: OTHER, routeBPassword: PW } })
  const b3 = createBroute(fake, 'rd-other')
  const r = await input(b3, { topic: 'read' })
  assert.equal(r.err, null)
  const p = r.sent[0][1].payload
  assert.deepEqual(Object.keys(p.values), [], '前の契約の値は出さない: ' + Object.keys(p.values).join(','))
  assert.ok(p.missing.indexOf('E7') >= 0, 'まだ取れていない')
  assert.deepEqual(dev3.handle.knownSupportedEpcs(), [], '前のメーターのプロパティマップも忘れる')
})

test('未接続のときに預かった積算（E0・E3）は、接続時の係数・単位を取ってから走り、出力 1 に換算した値で出る', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: sequencer.js の _afterJoin で _collectingOnce を立てない・pending.js の ready で見ない
  const fake = setup()
  const dev = createDevice(fake, 'hd-cumul', { simulatorOptions: absentSim() })
  fastRetry(dev)
  const b = createBroute(fake, 'hd-cumul')
  const g = later(b, { topic: 'get', payload: ['E0', 'E3'] })
  await waitFor(() => dev.handle.pending.stats().count === 1, 2000, '預かる')
  dev.sequencer.transport.config.meterPresent = true
  await g.promise
  assert.equal(g.err, null, g.err && g.err.message)
  const out1 = b._sent.filter((m) => m[0] && m[0].payload && m[0].payload.values && m[0].payload.values.cumulativeForward)
  assert.ok(out1.length >= 1, '出力 1 に積算')
  const first = out1[0][0].payload.values.cumulativeForward
  assert.equal(typeof first.value, 'number', '換算した値（未換算の null ではない）: ' + JSON.stringify(first))
  assert.doesNotMatch(String(first.display), /未換算/)
})

test('Node-RED 3.1 の停止の順（ノードを閉じてから runtime-state の stop）でも、取りやめた件数を Node-RED のログに warn で残す', async () => {
  // 戻すと落ちるもの: http-api.js の runtime-event で、pending.shutdown() の数を warn で残さない
  // （3.1.3 はフローを止め終えてから runtime-state の stop を出すので、下流のノードも Catch も閉じていて、返した error はどこにも届かない）
  const fake = setup()
  const dev = createDevice(fake, 'hd-stop31', { simulatorOptions: absentSim(), name: '止める台' })
  const b1 = createBroute(fake, 'hd-stop31')
  const a = later(b1, { topic: 'get', payload: 'E7' })
  const c = later(b1, { topic: 'read', payload: { epcs: ['E8'], maxAgeSec: 0 } })
  await waitFor(() => dev.handle.pending.stats().count === 2, 2000, '預かる')
  // 3.1.3 の stopFlows と同じ順: 使っているノード → 設定ノードを閉じる（removed: false）→ flows:stopped → runtime-state stop
  await fake.close(b1, false)
  await fake.close(dev, false)
  assert.equal(dev.handle.pending.stats().count, 2, 'ノードを閉じた時点では、デプロイと見分けられないので残す')
  fake.events.emit('flows:stopped', { type: 'full' })
  fake.events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop', deploy: false }, retain: true })
  await Promise.all([a.promise, c.promise])
  assert.deepEqual(dev.handle.pending.stats(), { count: 0, oldestMs: null })
  const warns = fake.logs.filter(([l, t]) => l === 'warn' && /預かっていた指示 2 件を取りやめました/.test(t))
  assert.equal(warns.length, 1, 'Node-RED のログに件数を 1 行: ' + JSON.stringify(fake.logs.filter(([l]) => l === 'warn')))
  assert.match(warns[0][1], /止める台/)
  assert.match(warns[0][1], /Catch/)
})
