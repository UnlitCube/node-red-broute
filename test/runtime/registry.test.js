'use strict'

// registry と AdapterHandle（lib/runtime/registry.js）。
// 作り直しても同じ handle・イベントの中継・ログのリング・推移のリング・片付け。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createRegistry, LOG_RING } = require('../../lib/runtime/registry')
const { ID, PW } = require('./fake-red')

/** sequencer の代わり（イベントと snapshot だけ）。 */
function fakeSeq() {
  const s = new EventEmitter()
  s.state = { phaseSince: 1 }
  s.options = { pollIntervalSec: 30, pollEpcs: [0xe7] }
  s.snapshot = () => ({ phase: 'connected', credentials: { configured: true, idHint: '0123…CDEF' } })
  return s
}

test('handle は id ごとに 1 つで、sequencer を付け替えても受け手はそのまま', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  assert.equal(reg.upsert('dev1'), h, '同じ id なら同じ handle')
  const got = []
  h.on('measurement', (m) => got.push(m.n))

  const s1 = fakeSeq()
  h.attach(s1)
  s1.emit('measurement', { n: 1, values: [] })
  h.detach(s1)
  s1.emit('measurement', { n: 99, values: [] }) // 外した後の古い sequencer からは届かない

  const s2 = fakeSeq()
  h.attach(s2)
  s2.emit('measurement', { n: 2, values: [] })
  assert.deepEqual(got, [1, 2])
  assert.equal(s1.listenerCount('measurement'), 0, '古い sequencer から受け手を外す')
})

test('古い sequencer の detach で、今の sequencer を外さない', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const s1 = fakeSeq()
  const s2 = fakeSeq()
  h.attach(s1)
  h.attach(s2) // 付け替え（s1 は外れる）
  h.detach(s1) // 遅れて届いた古い後片付け
  assert.equal(h.sequencer, s2)
})

test('受け手の 1 つが例外を投げても、ほかの受け手と sequencer は止まらない', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const errors = []
  h.claim({}, { onListenerError: (e) => errors.push(e.message) })
  const s = fakeSeq()
  h.attach(s)
  const got = []
  h.on('status', () => {
    throw new Error('受け手の失敗')
  })
  h.on('status', () => got.push('2 つ目'))
  assert.doesNotThrow(() => s.emit('status', {}))
  assert.deepEqual(got, ['2 つ目'])
  assert.deepEqual(errors, ['受け手の失敗'])
})

test("'error' は中継しない（受け手が居ないと投げるため）", () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const s = fakeSeq()
  h.attach(s)
  s.on('error', () => {}) // 設定ノードが受ける
  assert.doesNotThrow(() => s.emit('error', new Error('x')))
})

test('ログのリングは 1,000 件・連番。after / level / limit で読める', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const s = fakeSeq()
  h.attach(s)
  for (let i = 1; i <= 1005; i++) {
    s.emit('log', { level: i % 10 === 0 ? 'warn' : i % 3 === 0 ? 'tx' : 'info', text: 'line ' + i, ts: i })
  }
  const all = h.logsAfter({ after: 0, limit: 1000 })
  assert.equal(all.items.length, LOG_RING)
  assert.equal(all.items[0].seq, 6, '古いものから押し出す')
  assert.equal(all.items[all.items.length - 1].seq, 1005)
  assert.equal(all.nextSeq, 1005)
  assert.equal(all.items.find((r) => r.seq === 9).level, 'debug', 'tx は debug に寄せる')

  const page = h.logsAfter({ after: 1000, limit: 2 })
  assert.deepEqual(page.items.map((r) => r.seq), [1001, 1002])
  assert.equal(page.nextSeq, 1002)

  const warn = h.logsAfter({ after: 900, level: 'warn' })
  assert.ok(warn.items.every((r) => r.level === 'warn' || r.level === 'error'))
  assert.equal(warn.items.length, 10)
  assert.equal(warn.nextSeq, 1005, '絞り込んでも、読んだところまで進める')

  const old = h.logsAfter({ after: 1 })
  assert.equal(old.dropped, 4, 'リングから落ちた件数')
  const future = h.logsAfter({ after: 999999 })
  assert.equal(future.items[0].seq, 6, '再起動で連番が戻ったら最初から渡す')
})

test('ログと raw から認証 ID とパスワードを伏せる', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  h.claim({}, { secrets: [ID, PW], credentialId: ID })
  const s = fakeSeq()
  h.attach(s)
  const fwd = []
  const raw = []
  h.on('log', (e) => fwd.push(e.text))
  h.on('raw', (l) => raw.push(l))
  s.emit('log', { level: 'info', text: `id=${ID} pw=${PW.toLowerCase()}` })
  s.emit('raw', `EVENT ${ID}`)
  h.log('warn', 'pw ' + PW)
  const text = JSON.stringify([h.logsAfter({}), fwd, raw])
  assert.ok(!text.includes(ID))
  assert.ok(!text.toLowerCase().includes(PW.toLowerCase()))
  assert.match(text, /\*{8}/)
  // 秘密は handle のプロパティに出ていない
  assert.ok(!JSON.stringify(Object.keys(h).map((k) => [k, typeof h[k] === 'function' ? 'fn' : h[k]])).includes(ID))
  assert.equal(h.inspect().pairId, ID.slice(-8), 'PairID は ID の下 8 桁')
})

test('推移は 10 秒に 1 点まで・24 時間で落とし、720 点まで間引く', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const s = fakeSeq()
  h.attach(s)
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 10000)
  s.emit('measurement', { ts: T0 + 1000, values: [{ epc: 0xe7, value: 100 }] })
  s.emit('measurement', { ts: T0 + 5000, values: [{ epc: 0xe8, value: { r: 1.5, t: 2 } }] })
  s.emit('measurement', { ts: T0 + 9000, values: [{ epc: 0xe7, value: 120 }] })
  let t = h.trend(3600 * 1000, T0 + 10000)
  assert.deepEqual(t.series.power, [[T0 + 9000, 120]], '同じ 10 秒の枠は後の値で上書き')
  assert.deepEqual(t.series.currentR, [[T0 + 9000, 1.5]], '届いていない系列は前の値を残す')
  assert.deepEqual(t.series.currentT, [[T0 + 9000, 2]])

  s.emit('measurement', { ts: T0 + 10000, values: [{ epc: 0xe7, value: -50 }] })
  t = h.trend(3600 * 1000, T0 + 20000)
  assert.equal(t.series.power.length, 2)
  assert.equal(t.series.power[1][1], -50, '逆潮流（負）も残す')
  assert.equal(t.series.currentR.length, 1, 'E7 だけの点に E8 は無い')
  assert.equal(t.to - t.from, 3600 * 1000)

  // 25 時間ぶん 10 秒ごと → 24 時間ぶんだけ残る
  const reg2 = createRegistry()
  const h2 = reg2.upsert('dev2')
  const s2 = fakeSeq()
  h2.attach(s2)
  const start = T0
  const n = 25 * 360
  for (let i = 0; i < n; i++) s2.emit('measurement', { ts: start + i * 10000, values: [{ epc: 0xe7, value: i }] })
  const end = start + (n - 1) * 10000
  const all = h2.trend(48 * 3600 * 1000, end, 100000)
  assert.ok(all.series.power[0][0] >= end - 24 * 3600 * 1000, '24 時間より古い点は落とす')
  assert.equal(all.series.power.length, 24 * 360 + 1)
  const day = h2.trend(24 * 3600 * 1000, end)
  assert.ok(day.series.power.length <= 720, '1 系列 720 点まで')
  assert.ok(day.series.power.length >= 600, "間引きすぎない (実際 " + day.series.power.length + ")")
  assert.equal(day.series.power[day.series.power.length - 1][0], end, '最後の点の時刻を残す')
})

test('設定ノードが居ない handle は一覧に出さず、prune で片付ける', () => {
  const reg = createRegistry()
  const events = []
  reg.on('removed', (id) => events.push('removed:' + id))
  const owner = {}
  const h = reg.upsert('dev1')
  assert.equal(reg.list().length, 0, 'claim 前は出さない')
  h.claim(owner, { meta: { name: 'x' } })
  assert.equal(reg.list().length, 1)
  h.release({}, true) // ほかの持ち主の release は効かない
  assert.equal(reg.list().length, 1)
  h.release(owner, true)
  assert.equal(reg.list().length, 0)
  assert.deepEqual(reg.prune(), ['dev1'])
  assert.equal(reg.get('dev1'), null)
  assert.deepEqual(events, ['removed:dev1'])
})

test('使っているノードの数は数えるだけ', () => {
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const a = {}
  h.addConsumer(a)
  h.addConsumer(a)
  h.addConsumer({})
  assert.equal(h.consumers, 2)
  h.removeConsumer(a)
  assert.equal(h.consumers, 1)
})

test('診断（purpose が diag）の取得は推移に入れない。ほかの目的の取得と、受け手への中継はそのまま', () => {
  // 診断の「任意の EPC」で E7 を取ると、推移に点が混ざっていた。
  // 戻すと落ちるもの: registry.js の _recordTrend で purpose を見るのをやめる
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const s = fakeSeq()
  h.attach(s)
  const got = []
  h.on('measurement', (r) => got.push(r.purpose))
  const relayed = []
  reg.on('measurement', (id, r) => relayed.push(r.purpose))
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 10000)
  s.emit('measurement', { ts: T0 + 1000, purpose: 'diag', values: [{ epc: 0xe7, value: 999 }, { epc: 0xe8, value: { r: 9, t: 9 } }] })
  let t = h.trend(3600 * 1000, T0 + 60000)
  assert.deepEqual(t.series.power, [], '診断の値は推移に入れない')
  assert.deepEqual(t.series.currentR, [])
  for (const purpose of ['poll', 'manual', 'slow', undefined]) {
    s.emit('measurement', { ts: T0 + 20000, purpose, values: [{ epc: 0xe7, value: 100 }] })
  }
  t = h.trend(3600 * 1000, T0 + 60000)
  assert.deepEqual(t.series.power, [[T0 + 20000, 100]], 'ほかの目的（と purpose の無いもの）は入れる')
  assert.deepEqual(got, ['diag', 'poll', 'manual', 'slow', undefined], 'wsuha-broute への中継は全部（出力に流すかは受け手が決める）')
  assert.deepEqual(relayed, ['diag', 'poll', 'manual', 'slow', undefined], 'SSE への中継も全部')
})

test('運用設定の変化: SSE（registry の settings）と wsuha-broute（handle の settings {by, origin}）へ知らせる。エディタの変更は flush まで待つ', () => {
  // 戻すと落ちるもの: settingsChanged で handle の 'settings' を出さない・deferNodes を見ない
  const reg = createRegistry()
  const h = reg.upsert('dev1')
  const sse = []
  reg.on('settings', (id) => sse.push(id))
  const nodes = []
  h.on('settings', (ev) => nodes.push(ev))
  const origin = { id: 'b1' }
  h.settingsChanged('flow:記録用', origin)
  assert.deepEqual(sse, ['dev1'])
  assert.deepEqual(nodes, [{ by: 'flow:記録用', origin }])
  h.settingsChanged('web-ui')
  assert.deepEqual(nodes[1], { by: 'web-ui', origin: null })

  // エディタの変更（設定ノードを作っている途中）: SSE には今すぐ、ノードへはデプロイが済んでから 1 回だけ
  h.settingsChanged('editor', null, { deferNodes: true })
  assert.equal(sse.length, 3)
  assert.equal(nodes.length, 2, 'まだ出さない')
  assert.equal(h.flushSettingsNotice(), true)
  assert.deepEqual(nodes[2], { by: 'editor', origin: null })
  assert.equal(h.flushSettingsNotice(), false, '2 回目は何もしない')
  assert.equal(nodes.length, 3)
})

test('forgetSupported: 前のメーターの推移を捨て、記録の始まりをその時刻に進める。捨てた時間を途切れにしない', async () => {
  // 接続先を変えても前のメーターの点が 24 時間残っていた。点だけを捨てると、捨てた時間を画面が途切れに数える。
  // 戻すと落ちるもの: registry.js の forgetSupported で _trend を空にしない・recordingSince を進めない・
  //   _recordTrend で閉じる前の sequencer の値を止めない
  const { gapStats, gapThreshold, recordedSince } = await import('../../ui/chart-util.js')
  const reg = createRegistry()
  const h = reg.upsert('t1')
  const power = (to) => h.trend(3600000, to).series.power
  const started = Date.now() - 2 * 3600e3
  h.claim({}, { meta: { name: 't1' }, credentialId: ID })
  const s1 = fakeSeq()
  h.attach(s1)
  // 前のメーターの記録が長く続いたあとに、接続先を変えた形
  h.recordingSince = started
  const first = h.recordingSince
  const at = Date.now()
  s1.emit('measurement', { ts: at, values: [{ epc: 0xe7, value: 100 }] })
  assert.deepEqual(power(at + 1000).map((p) => p[1]), [100])

  h.claim({}, { meta: { name: 't1' }, credentialId: ID })
  assert.deepEqual(power(at + 1000).map((p) => p[1]), [100], '同じ認証 ID のデプロイでは捨てない')
  assert.equal(h.recordingSince, first, '同じ認証 ID のデプロイでは進めない')

  h.updateInfo({ credentialId: 'FEDCBA9876543210FEDCBA9876543210' })
  assert.deepEqual(power(at + 1000), [], '別の契約: 前の点を捨てる')
  assert.ok(h.recordingSince >= at, '記録の始まりを進める')
  assert.equal(h.inspect().recordingSince, h.recordingSince)

  s1.emit('measurement', { ts: at + 1, values: [{ epc: 0xe7, value: 200 }] })
  assert.deepEqual(power(at + 1000), [], '閉じる前の sequencer の値は入れない')

  h.detach(s1)
  const s2 = fakeSeq()
  h.attach(s2)
  const next = h.recordingSince + 600e3
  s2.emit('measurement', { ts: next, values: [{ epc: 0xe7, value: 300 }] })
  const pts = power(next + 1000)
  assert.deepEqual(pts.map((p) => p[1]), [300], '今のメーターの点は入る')
  const st = gapStats(pts, gapThreshold(pts), next + 1000 - 3600e3, next + 1000, recordedSince(started, h.recordingSince))
  assert.equal(st.count, 0, '捨てる前の時間は途切れにしない')
  assert.equal(st.noDataUntil, next, '記録が無い時間として出す')
})

test('forgetSupported: まだ claim していない台の recordingSince は null のまま', () => {
  // 戻すと落ちるもの: registry.js の forgetSupported で recordingSince を無条件に入れる（台が動く前の時刻になる）
  const h = createRegistry().upsert('t2')
  h.forgetSupported()
  assert.equal(h.recordingSince, null)
})

test('recordingSince: このプロセスで最初に claim した時刻。デプロイで claim し直しても変えない', async () => {
  // 推移は handle が持つので、作り直しのたびに進めると、持っている記録を「足す前の時間」と読み違える。
  // 戻すと落ちるもの: registry.js の claim で毎回入れ直す・upsert の時刻を使う（claim の前に null でなくなる）
  const reg = createRegistry()
  const h = reg.upsert('a1')
  assert.equal(h.recordingSince, null, 'まだ設定ノードが居ない')
  assert.equal(h.inspect().recordingSince, null)
  const owner = {}
  h.claim(owner, { meta: { name: 'a1' } })
  const first = h.recordingSince
  assert.equal(typeof first, 'number')
  assert.equal(h.inspect().recordingSince, first)
  await new Promise((r) => setTimeout(r, 5))
  h.release(owner, false)
  h.claim({}, { meta: { name: 'a1' } })
  assert.equal(h.recordingSince, first, 'デプロイをまたいで同じ')
  // 消して足し直した台は別の handle で、記録も持ち越さない
  h.release(undefined, true)
  reg.prune()
  const again = reg.upsert('a1')
  again.claim({}, { meta: { name: 'a1' } })
  assert.ok(again.recordingSince > first)
})
