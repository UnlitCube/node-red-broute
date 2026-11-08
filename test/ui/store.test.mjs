// ui/store.js の reducer と選び出し、ui/settings-model.js、ログの絞り込み（経路は route.test.mjs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, initialState, summarize, totalPower, writeBlockReason, authBlockReason, configBlockReason, appendPoint, mergeValues, mergeRead, findValue, LOG_CAP, TOAST_CAP } from '../../ui/store.js'
import { draftFrom, validateDraft, diffDraft, epcCandidates, DEFAULT_EPC_CANDIDATES, changedFields, untouchedNotes, mergeDraft, pruneEdits } from '../../ui/settings-model.js'
import { filterLogs, logsToText } from '../../ui/components/tab-logs.js'
import { S } from '../../ui/strings.js'
import { createRequire } from 'node:module'

const vm = createRequire(import.meta.url)('../../lib/runtime/view-model.js')

const H = (level) => ({ level, title: level, reasons: [], nextAction: null })
const adapter = (id, extra = {}) =>
  Object.assign(
    {
      id,
      name: 'アダプタ ' + id,
      enabled: true,
      health: H('ok'),
      power: { value: 500, at: 1000 },
      current: { r: 3, t: 2, total: 5, at: 1000 },
      overridden: { stopped: null, any: false },
    },
    extra,
  )

const run = (actions, state = initialState) => actions.reduce(reducer, state)

test('一覧を読み、詳細で同じ id の行を置き換える', () => {
  const s = run([
    { type: 'list/loaded', items: [adapter('a'), adapter('b')], at: 1 },
    { type: 'detail/loaded', adapter: adapter('b', { name: '新しい名前', meter: { lqi: 90 } }) },
  ])
  assert.equal(s.list.items[1].name, '新しい名前')
  assert.equal(s.list.items[0].name, 'アダプタ a')
  assert.equal(s.details.b.data.meter.lqi, 90)
  assert.equal(s.details.b.status, 'ok')
})

test('一覧の取得に失敗: 前の一覧があれば残して「古い」にする、無ければ error', () => {
  const err = { status: 0, message: 'x' }
  const first = run([{ type: 'list/failed', error: err }])
  assert.equal(first.list.status, 'error')
  assert.equal(first.stale, false)
  const later = run([{ type: 'list/loaded', items: [adapter('a')] }, { type: 'list/failed', error: err }])
  assert.equal(later.list.status, 'ok')
  assert.equal(later.list.items.length, 1)
  assert.equal(later.stale, true)
  assert.equal(run([{ type: 'list/loaded', items: [] }], later).stale, false)
})

test('詳細の 404 は notFound、ほかの失敗は前の値を残す', () => {
  const nf = run([{ type: 'detail/failed', id: 'x', error: { status: 404 } }])
  assert.equal(nf.details.x.status, 'notFound')
  const kept = run([{ type: 'detail/loaded', adapter: adapter('x') }, { type: 'detail/failed', id: 'x', error: { status: 503 } }])
  assert.equal(kept.details.x.status, 'ok')
  assert.equal(kept.details.x.data.id, 'x')
})

// 「見つかりません」は、確かめ直しの間（detail/loading）とほかの失敗（503 など）では外さない。
// 外すと、app.js が ?adapter= の SSE へ戻って 404 を受け直し、右ペインに消えた台の古い詳細がちらつく。
// 戻すと落ちるもの: detail/loading・detail/failed で前の notFound を見ない（prev.data があれば 'ok' にする）。
test('詳細の notFound は、取り直しの間とほかの失敗では残し、取れたら ok に戻る', () => {
  const nf = run([{ type: 'detail/loaded', adapter: adapter('x') }, { type: 'detail/failed', id: 'x', error: { status: 404 } }])
  assert.equal(nf.details.x.status, 'notFound')
  assert.equal(run([{ type: 'detail/loading', id: 'x' }], nf).details.x.status, 'notFound', '取り直しの間')
  assert.equal(run([{ type: 'detail/failed', id: 'x', error: { status: 503 } }], nf).details.x.status, 'notFound', 'ほかの失敗')
  assert.equal(run([{ type: 'detail/loading', id: 'x' }, { type: 'detail/loaded', adapter: adapter('x') }], nf).details.x.status, 'ok')
})

// 一覧の変化から、選んでいる台の詳細を GET で確かめ直すか。
// 戻すと落ちるもの: 消えたときの判定（had && !has）を外す・notFound で一覧に戻ったときの判定を外す・
//   notFound で一覧にあり続けるときも確かめる（app.test の「暴走しない」も落ちる）。
test('needsDetailRecheck: 選んでいる台が一覧から消えたとき、notFound の台が一覧に戻ったときだけ確かめる', async () => {
  const { needsDetailRecheck } = await import('../../ui/store.js')
  assert.equal(typeof needsDetailRecheck, 'function', 'store.js に needsDetailRecheck が無い')
  const a1 = adapter('a1')
  const a2 = adapter('a2')
  assert.equal(needsDetailRecheck([a1, a2], [a2], 'a1', 'ok'), true, '消えた（削除のデプロイ）')
  assert.equal(needsDetailRecheck([a1, a2], [a2], 'a1', 'loading'), true, '取っている途中に消えても確かめる（古い応答で ok にしない）')
  assert.equal(needsDetailRecheck([a1, a2], [a1, a2], 'a1', 'ok'), false, '残っている')
  assert.equal(needsDetailRecheck([a2], [a2], 'a1', 'ok'), false, '前から無い（経路の取得に任せる）')
  assert.equal(needsDetailRecheck(null, [a2], 'a1', 'loading'), false, '最初の一覧')
  assert.equal(needsDetailRecheck([a2], [a1, a2], 'a1', 'notFound'), true, '戻った')
  assert.equal(needsDetailRecheck([a2], [a2], 'a1', 'notFound'), false, '消えたまま')
  assert.equal(needsDetailRecheck([a1], [a1], 'a1', 'notFound'), false, '一覧にあり続ける（stream だけが 404）では繰り返さない')
  assert.equal(needsDetailRecheck(null, [a1], 'a1', 'notFound'), false, '最初の一覧')
  const same = [a1]
  assert.equal(needsDetailRecheck(same, same, 'a1', 'notFound'), false, '一覧が変わっていない（詳細の状態が変わっただけ）')
  assert.equal(needsDetailRecheck([a1], [a1], null, 'ok'), false, '何も選んでいない')
  assert.equal(needsDetailRecheck([a1], null, 'a1', 'ok'), false, '一覧が無い')
})

// 一時的な上書きは SSE の settings を出さないので、adapter の値の変化から設定を取り直す。
// 戻すと落ちるもの: settingsSignature に pollIntervalSec・pollEpcs・overridden を入れない。
test('settingsSignature: 取得間隔・定期取得の EPC・上書きが変わったときだけ変わる', async () => {
  const { settingsSignature } = await import('../../ui/store.js')
  assert.equal(typeof settingsSignature, 'function', 'store.js に settingsSignature が無い')
  const base = adapter('a1', { pollIntervalSec: 30, pollEpcs: ['0xE7', '0xE8'] })
  const sig = settingsSignature(base)
  assert.equal(typeof sig, 'string')
  assert.equal(settingsSignature(null), null)
  assert.equal(settingsSignature(Object.assign({}, base, { power: { value: 900, at: 2 }, phase: 'x' })), sig, '設定に関係しない変化')
  assert.notEqual(settingsSignature(Object.assign({}, base, { pollIntervalSec: 120 })), sig, '取得間隔')
  assert.notEqual(settingsSignature(Object.assign({}, base, { pollEpcs: ['0xE7'] })), sig, '定期取得の EPC')
  assert.notEqual(settingsSignature(Object.assign({}, base, { overridden: { stopped: null, any: true } })), sig, '同じ値の上書き')
})

// サーバーは有効 / 無効でも SSE の settings を出す（Settings の warnings に「アダプタが無効です…」が入る）。
// SSE が使えない間（5 秒ごとの取得）も同じ変化で取り直すよう、有効 / 無効も印に入れる。
// 戻すと落ちるもの: settingsSignature に enabled を入れない。
test('settingsSignature: 有効 / 無効が変わっても変わる（SSE の settings と同じ変化で取り直す）', async () => {
  const { settingsSignature } = await import('../../ui/store.js')
  const base = adapter('a1', { enabled: true, pollIntervalSec: 30, pollEpcs: ['0xE7'] })
  assert.notEqual(settingsSignature(Object.assign({}, base, { enabled: false })), settingsSignature(base), '有効 → 無効')
  // enabled の無い詳細（古い形）は有効と同じに扱う（取り直しを繰り返さない）
  const noField = Object.assign({}, base)
  delete noField.enabled
  assert.equal(settingsSignature(noField), settingsSignature(base))
})

test('appendPoint: 新しい点だけ足し、窓より古い点を捨てる', () => {
  let pts = appendPoint([], 1000, 1, 5000)
  pts = appendPoint(pts, 2000, 2, 5000)
  assert.equal(appendPoint(pts, 2000, 9, 5000), pts) // 同じ時刻は足さない（同じ配列を返す）
  assert.equal(appendPoint(pts, 1500, 9, 5000), pts)
  pts = appendPoint(pts, 7000, 3, 5000)
  assert.deepEqual(pts, [[2000, 2], [7000, 3]])
  assert.deepEqual(appendPoint(pts, 'x', 1, 5000), pts)
})

test('appendPoint: 同じ枠の点は後の値で置き換える。merge を渡すと、置き換える値をそれで決める', () => {
  const lower = (a, b) => Math.min(a, b)
  let pts = appendPoint([], 1000, 40, 60000, 5000)
  assert.deepEqual(appendPoint(pts, 2000, 90, 60000, 5000), [[2000, 90]])
  pts = appendPoint(pts, 2000, 90, 60000, 5000, lower)
  assert.deepEqual(pts, [[2000, 40]], '時刻は新しい点、値は merge の結果')
  assert.deepEqual(appendPoint(pts, 6000, 90, 60000, 5000, lower), [[2000, 40], [6000, 90]], '次の枠は足すだけ')
})

test('推移の LQI: 同じ枠に落ちた点は小さい方を残す（電力は後の値のまま）', () => {
  // 戻すと落ちるもの: store.js の absorbAdapter で LQI に lowerLqi を渡さない（落ち込みが後の値に隠れる）
  const t0 = 1_000_000_000_000 // 1 時間の範囲の枠は 5 秒
  const seen = (at, lqi, value) => ({ type: 'detail/loaded', adapter: adapter('a', { power: { value, at }, meter: { lqi, lqiAt: at } }) })
  const s = run([
    { type: 'trend/loaded', id: 'a', range: '1h', series: { power: [], currentR: [], currentT: [], lqi: [] }, from: t0 - 3600e3, to: t0 },
    seen(t0, 40, 100),
    seen(t0 + 1000, 90, 200),
    seen(t0 + 6000, 70, 300),
  ])
  assert.deepEqual(s.trends.a.series.lqi, [[t0 + 1000, 40], [t0 + 6000, 70]])
  assert.deepEqual(s.trends.a.series.power, [[t0 + 1000, 200], [t0 + 6000, 300]])
})

test('アダプタの更新で、読み込み済みの推移に点が足される', () => {
  const s = run([
    { type: 'trend/loaded', id: 'a', range: '1h', series: { power: [[0, 100]], currentR: [], currentT: [] }, from: -3600e3, to: 0 },
    { type: 'detail/loaded', adapter: adapter('a', { power: { value: 700, at: 30e3 }, current: { r: 4, t: null, at: 30e3 } }) },
  ])
  assert.deepEqual(s.trends.a.series.power, [[0, 100], [30e3, 700]])
  assert.deepEqual(s.trends.a.series.currentR, [[30e3, 4]])
  assert.deepEqual(s.trends.a.series.currentT, [])
  assert.equal(s.trends.a.to, 30e3)
  // 同じ値をもう一度受けても増えない
  const again = reducer(s, { type: 'detail/loaded', adapter: adapter('a', { power: { value: 700, at: 30e3 }, current: { at: 30e3 } }) })
  assert.equal(again.trends.a.series.power.length, 2)
})

test('計測値: EPC で混ぜる。届かなかった行の fresh はサーバーの値のまま（画面で書き換えない）', () => {
  const rows = [
    { epc: 'E7', name: '瞬時電力', display: '500 W', fresh: true, at: 1 },
    { epc: 'E0', name: '積算', display: '1 kWh', fresh: true, at: 1 },
    { epc: 'D3', name: '係数', display: '1', fresh: false, at: 1 },
  ]
  const s = run([
    { type: 'values/loaded', id: 'a', items: rows, at: 1 },
    { type: 'measurement', adapterId: 'a', at: 2, items: [{ epc: 'E7', name: '瞬時電力', display: '600 W', fresh: true, at: 2 }] },
  ])
  const byEpc = Object.fromEntries(s.values.a.items.map((r) => [r.epc, r]))
  assert.equal(byEpc.E7.display, '600 W')
  assert.equal(byEpc.E7.fresh, true)
  assert.equal(byEpc.E0.fresh, true)
  assert.equal(byEpc.D3.fresh, false)
  assert.equal(s.values.a.at, 2)
  assert.deepEqual(mergeValues(null, [{ epc: 'E8' }, { epc: '80' }]).map((r) => r.epc), ['80', 'E8'])
})

// 戻すと落ちるもの: mergeValues で「届かなかった行の fresh を false にする」に戻す（R2 の再現）。
test('計測値の鮮度: 速い周期の受信の後も、画面の fresh がサーバー（view-model）の fresh と同じ', () => {
  const now = 1_800_000_000_000
  const input = {
    snap: {
      known: {
        '0xE7': { value: 500, unit: 'W', display: '500 W', at: now - 10_000 },
        '0xE0': { value: 1234.5, unit: 'kWh', display: '1234.5 kWh', at: now - 60_000 }, // 5 分ごと
        '0xD3': { value: 1, unit: null, display: '1', at: now - 3_600_000 }, // 1 回だけ
      },
    },
    options: { pollIntervalSec: 30, pollEpcs: [0xe7], slowIntervalSec: 300 },
  }
  let s = reducer(initialState, { type: 'values/loaded', id: 'a1', items: vm.buildValueRows(input, now), at: now })
  const later = now + 30_000
  const meas = vm.valueRowsFromValues(input, [{ epc: 0xe7, value: 510, unit: 'W', display: '510 W', ts: later }], later)
  s = reducer(s, { type: 'measurement', adapterId: 'a1', at: later, items: meas })
  input.snap.known['0xE7'] = { value: 510, unit: 'W', display: '510 W', at: later }
  const server = Object.fromEntries(vm.buildValueRows(input, later).map((r) => [r.epc, r.fresh]))
  const ui = Object.fromEntries(s.values.a1.items.map((r) => [r.epc, r.fresh]))
  assert.deepEqual(server, { '0xD3': true, '0xE0': true, '0xE7': true })
  assert.deepEqual(ui, server)
})

test('計測値の取り直し: 受信が止まった行はサーバーの fresh で古くなる。応答より後に SSE で届いた行は残す', () => {
  const at = 10_000_000
  let s = run([
    { type: 'values/loaded', id: 'a', items: [{ epc: '0xE7', display: '500 W', fresh: true, at: at - 5_000 }, { epc: '0xE0', display: '1 kWh', fresh: true, at: at - 5_000 }], at },
  ])
  // 10 分後の取り直し: 受信が止まっていて、サーバーは古いと言う
  const t1 = at + 600_000
  s = reducer(s, { type: 'values/loaded', id: 'a', items: [{ epc: '0xE7', display: '500 W', fresh: false, at: at - 5_000 }, { epc: '0xE0', display: '1 kWh', fresh: false, at: at - 5_000 }], at: t1 })
  assert.deepEqual(s.values.a.items.map((r) => [r.epc, r.fresh]), [['0xE0', false], ['0xE7', false]])
  // REST の応答（t2 の時点の表）より先に、t2 より後の measurement が着いた
  const t2 = t1 + 30_000
  s = reducer(s, { type: 'measurement', adapterId: 'a', at: t2 + 1_000, items: [{ epc: '0xE7', display: '700 W', fresh: true, at: t2 + 1_000 }, { epc: '0xE8', display: '3 A', fresh: true, at: t2 + 1_000 }] })
  s = reducer(s, { type: 'values/loaded', id: 'a', items: [{ epc: '0xE7', display: '650 W', fresh: true, at: t2 - 2_000 }, { epc: '0xE0', display: '1 kWh', fresh: false, at: at - 5_000 }], at: t2 })
  const byEpc = Object.fromEntries(s.values.a.items.map((r) => [r.epc, r]))
  assert.equal(byEpc['0xE7'].display, '700 W')
  assert.equal(byEpc['0xE8'].display, '3 A')
  assert.equal(byEpc['0xE0'].fresh, false)
  // 応答の時刻より前の行は応答で置き換える（再起動で消えた値を残さない）
  s = reducer(s, { type: 'values/loaded', id: 'a', items: [{ epc: '0xE7', display: '', fresh: false, at: null }], at: t2 + 60_000 })
  assert.deepEqual(s.values.a.items.map((r) => [r.epc, r.display]), [['0xE7', '']])
})

test('ログ: seq で重複を捨て、上限で古い行を落とす', () => {
  let s = run([{ type: 'logs/loaded', id: 'a', items: [{ seq: 1, at: 1, level: 'info', text: 'a' }], nextSeq: 1 }])
  s = reducer(s, { type: 'log', id: 'a', row: { seq: 1, at: 1, level: 'info', text: 'dup' } })
  s = reducer(s, { type: 'log', id: 'a', row: { seq: 2, at: 2, level: 'warn', text: 'b' } })
  assert.deepEqual(s.logs.a.items.map((r) => r.seq), [1, 2])
  assert.equal(s.logs.a.nextSeq, 2)
  s = reducer(s, { type: 'logs/more', id: 'a', items: [{ seq: 2, text: 'dup' }, { seq: 3, at: 3, level: 'error', text: 'c' }], nextSeq: 3 })
  assert.deepEqual(s.logs.a.items.map((r) => r.seq), [1, 2, 3])
  const many = Array.from({ length: LOG_CAP + 10 }, (_, i) => ({ seq: 10 + i, at: i, level: 'info', text: String(i) }))
  s = reducer(s, { type: 'logs/more', id: 'a', items: many, nextSeq: 9999 })
  assert.equal(s.logs.a.items.length, LOG_CAP)
  assert.equal(s.logs.a.items[s.logs.a.items.length - 1].seq, 10 + LOG_CAP + 9)
  assert.equal(s.logs.a.nextSeq, 9999)
  // まだ読んでいないアダプタへの log も受ける
  const fresh = reducer(initialState, { type: 'log', id: 'z', row: { seq: 5, at: 5, level: 'info', text: 'x' } })
  assert.equal(fresh.logs.z.items.length, 1)
})

test('推移の範囲を変えると読み直し中になり、失敗しても前の系列を残す', () => {
  let s = run([{ type: 'trend/loaded', id: 'a', range: '1h', series: { power: [[1, 1]] }, from: 0, to: 1 }])
  assert.deepEqual(s.trends.a.series.currentR, [])
  s = reducer(s, { type: 'trend/loading', id: 'a', range: '6h' })
  assert.equal(s.trends.a.status, 'loading')
  assert.equal(s.trends.a.series, null)
  s = reducer(s, { type: 'trend/failed', id: 'a', range: '6h', error: { message: 'x' } })
  assert.equal(s.trends.a.status, 'error')
  const kept = run([{ type: 'trend/loaded', id: 'a', range: '1h', series: { power: [] } }, { type: 'trend/loading', id: 'a', range: '1h' }, { type: 'trend/failed', id: 'a', range: '1h', error: {} }])
  assert.equal(kept.trends.a.status, 'ok')
})

test('要約: 計測中 / 注意 / 異常 / 停止中 / 無効（知らない段階は注意）', () => {
  const items = ['ok', 'ok', 'busy', 'stale', 'bad', 'stopped', 'idle', 'disabled', 'weird'].map((l, i) => adapter(String(i), { health: H(l) }))
  assert.deepEqual(summarize(items), { ok: 2, attention: 3, bad: 1, stopped: 2, disabled: 1, total: 9 })
  assert.deepEqual(summarize(null), { ok: 0, attention: 0, bad: 0, stopped: 0, disabled: 0, total: 0 })
})

test('全台の合計: 値の無い台は足さず、無効は数えない', () => {
  const items = [adapter('a', { power: { value: 500 } }), adapter('b', { power: { value: -800 } }), adapter('c', { power: { value: null } }), adapter('d', { enabled: false, power: { value: 999 } })]
  assert.deepEqual(totalPower(items), { sum: -300, count: 2, total: 3, staleCount: 0 })
  assert.deepEqual(totalPower([adapter('x', { power: { value: null } })]), { sum: null, count: 0, total: 1, staleCount: 0 })
})

// 全台の合計に stale のアダプタ（と無効・停止中で値の無いもの）を入れない。除いたら「n 台は値が古いため除外」。
// 戻すと落ちるもの: totalPower が stale を見ない → 古い値（9,000 W）が合計に入る。
test('全台の合計: stale（値が古い）の台は足さず、何台除いたかを返す', () => {
  const items = [
    adapter('a', { power: { value: 500 }, stale: false }),
    adapter('b', { power: { value: 9000 }, stale: true, health: H('stale') }),
    adapter('c', { power: { value: 1200 }, stale: true, health: H('stopped') }),
    adapter('d', { power: { value: null }, stale: false, health: H('idle') }),
    adapter('e', { enabled: false, power: { value: 999 }, stale: true, health: H('disabled') }),
  ]
  assert.deepEqual(totalPower(items), { sum: 500, count: 1, total: 4, staleCount: 2 })
  // 全部が古い: 合計は出さず、除いた台数だけ
  assert.deepEqual(totalPower([adapter('x', { stale: true })]), { sum: null, count: 0, total: 1, staleCount: 1 })
  assert.equal(S.list.totalPowerStale(2), '2 台は瞬時電力が古いため除いています')
})

// 権限・ログインは無い。止めるのは meta.readOnly（settings.js の wsuhaBroute.readOnly）だけ。
// 戻すと落ちるもの: 前の canWrite を見る形 → readOnly:false の meta でも「読み出しのみ」になる。
test('書き込みの可否と理由: 認証の無いサーバーは meta.readOnly と 403 READ_ONLY だけを見る', () => {
  const st = (meta, readOnly = null) => Object.assign({}, initialState, { meta, readOnly })
  const meta = (readOnly) => ({ apiVersion: 1, libVersion: '2.0.0-beta.1', diskVersion: '2.0.0-beta.1', startedAt: 1, nodeRed: '3.1.3', readOnly })
  assert.equal(writeBlockReason(st(meta(false)), S), null)
  assert.equal(writeBlockReason(st(meta(true)), S), S.actions.readOnlyReason)
  assert.ok(S.actions.readOnlyReason.includes('settings.js の wsuhaBroute.readOnly'))
  // meta をまだ読めていない間は止めない（サーバーが 403 READ_ONLY で止め、そこで読み出しのみになる）
  assert.equal(writeBlockReason(st(null), S), null)
  assert.equal(writeBlockReason(st(meta(false), 'サーバーの理由'), S), 'サーバーの理由')
})

// ログインの入口が無いサーバーで「ログインしてください」と言っても手が無い。
// 戻すと落ちるもの: authBlockReason が available を見ない・meta を読む前に入口が無いと決める
test('認証の止め: 入口の無いサーバーは別の文。権限が足りない人とログインできる人の文は変えない', () => {
  const st = (auth, meta = {}) => Object.assign({}, initialState, { meta, auth: Object.assign({ required: true, available: true, loggedIn: false, canWrite: false }, auth) })
  assert.equal(authBlockReason(st({}), S), S.auth.loginRequired)
  assert.equal(authBlockReason(st({ available: false }), S), S.auth.noLogin)
  assert.equal(authBlockReason(st({ loggedIn: true }), S), S.auth.forbidden)
  assert.equal(authBlockReason(st({ available: false, loggedIn: true }), S), S.auth.forbidden, 'API のトークンで入った人に入口の話をしない')
  assert.equal(authBlockReason(st({ canWrite: true }), S), null)
  assert.equal(authBlockReason(st({ available: false }, null), S), S.auth.loginRequired, 'meta を読む前は入口の有無が分からない')
  assert.equal(writeBlockReason(st({ available: false }), S), S.auth.noLogin)
})

// 認証のあるサーバーでは、変更はエディタにログインした人だけ。値を見るのは止めない（止めるのは writeBlockReason を通る操作だけ）。
// 戻すと落ちるもの: writeBlockReason が auth を見ない・canWrite の初期値を true にする（読めるまで開いてしまう）・
//   権限不足にもログインを勧める。
const authMeta = (over = {}) => ({ readOnly: false, auth: Object.assign({ required: true, available: true, editorPath: '/' }, over) })

test('認証: session を読めるまでは閉じる。ログインしていれば開く', () => {
  const s0 = reducer(initialState, { type: 'meta', meta: authMeta() })
  assert.equal(s0.auth.required, true)
  assert.equal(s0.auth.available, true)
  assert.equal(writeBlockReason(s0, S), S.auth.loginRequired, 'session を読めていない間は開かない')
  const s1 = reducer(initialState, { type: 'meta', meta: authMeta(), session: { required: true, loggedIn: true, canWrite: true } })
  assert.equal(writeBlockReason(s1, S), null)
  const s2 = reducer(s1, { type: 'auth/session', session: { required: true, loggedIn: false, canWrite: false } })
  assert.equal(writeBlockReason(s2, S), S.auth.loginRequired, '別のタブでログアウトした')
  assert.equal(configBlockReason(s2, S), S.auth.loginRequired, '構成と認証情報も止める')
})

test('認証: 権限が足りない人にはログインを勧めず、別の文を出す', () => {
  const s = reducer(initialState, { type: 'meta', meta: authMeta(), session: { required: true, loggedIn: true, canWrite: false } })
  assert.equal(writeBlockReason(s, S), S.auth.forbidden)
  assert.equal(S.auth.forbidden, 'このユーザーには変更の権限がありません')
  assert.equal(S.auth.loginRequired, '変更するには Node-RED にログインしてください')
})

test('認証: adminAuth.default で匿名に権限があるサーバーは、ログインしていなくても開く', () => {
  const s = reducer(initialState, { type: 'meta', meta: authMeta(), session: { required: true, loggedIn: false, canWrite: true } })
  assert.equal(writeBlockReason(s, S), null)
})

test('認証: 認証の無いサーバーと、meta.auth の無い古いサーバーは止めない', () => {
  const none = reducer(initialState, { type: 'meta', meta: { readOnly: false, auth: { required: false, available: false, editorPath: null } } })
  assert.equal(writeBlockReason(none, S), null)
  const old = reducer(initialState, { type: 'meta', meta: { readOnly: false } })
  assert.equal(writeBlockReason(old, S), null)
  assert.equal(authBlockReason(Object.assign({}, initialState, { auth: undefined }), S), null)
})

test('認証: 書き込みが断られたら止める（トークンが切れた・権限が足りない）。次の session で解ける', () => {
  const open = reducer(initialState, { type: 'meta', meta: authMeta(), session: { required: true, loggedIn: true, canWrite: true } })
  const expired = reducer(open, { type: 'auth/denied', loggedIn: false })
  assert.equal(writeBlockReason(expired, S), S.auth.loginRequired)
  const lacking = reducer(open, { type: 'auth/denied', loggedIn: true })
  assert.equal(writeBlockReason(lacking, S), S.auth.forbidden)
  const back = reducer(expired, { type: 'auth/session', session: { required: true, loggedIn: true, canWrite: true } })
  assert.equal(writeBlockReason(back, S), null)
})

test('認証: 読み出しのみはログインしても解けないので、その理由を先に出す', () => {
  const s = reducer(initialState, { type: 'meta', meta: Object.assign(authMeta(), { readOnly: true }), session: { required: true, loggedIn: false, canWrite: false } })
  assert.equal(writeBlockReason(s, S), S.actions.readOnlyReason)
})

test('認証: session の答えは真偽だけを取り出す。トークンを state に入れない', () => {
  const token = 'ZmFrZS10b2tlbi1mb3ItdGVzdHM'
  const s = reducer(initialState, { type: 'auth/session', session: { required: true, loggedIn: true, canWrite: true, access_token: token, user: { username: 'x' } } })
  assert.deepEqual(s.auth, { required: true, available: false, loggedIn: true, canWrite: true })
  assert.equal(JSON.stringify(s).includes(token), false)
  assert.equal(reducer(s, { type: 'auth/session', session: null }).auth, s.auth, '読めなかったら今のまま')
})

test('findValue: 計測値の行を EPC で引く（0xE0・E0 のどちらの形でも）', () => {
  const items = [{ epc: '0xE0', value: 61532, display: '61532 kWh' }, { epc: 'E3', value: 0.4 }]
  assert.equal(findValue(items, 'E0').value, 61532)
  assert.equal(findValue(items, '0xE3').value, 0.4)
  assert.equal(findValue(items, 'E7'), null)
  assert.equal(findValue(null, 'E7'), null)
})

test('トーストは上限を超えたら古いものから落とす', () => {
  let s = initialState
  for (let i = 1; i <= TOAST_CAP + 2; i++) s = reducer(s, { type: 'toast/add', toast: { id: i, tone: 'ok', title: String(i) } })
  assert.equal(s.toasts.length, TOAST_CAP)
  assert.equal(s.toasts[0].id, 3)
  s = reducer(s, { type: 'toast/remove', id: 3 })
  assert.equal(s.toasts[0].id, 4)
})

test('知らない action は同じ state を返す。live / stale は変わらなければ同じ state', () => {
  assert.equal(reducer(initialState, { type: 'nope' }), initialState)
  assert.equal(reducer(initialState, { type: 'live', state: 'connecting' }), initialState)
  assert.equal(reducer(initialState, { type: 'stale', value: false }), initialState)
})

// ---- 設定 ---------------------------------------------------------------------

const settings = {
  rev: 'r1',
  fields: {
    pollIntervalSec: { value: 30, source: 'config', configValue: 30, default: 30, min: 15, max: 3600 },
    pollEpcs: { value: ['0xE7'], source: 'default', configValue: ['0xE7'], default: ['0xE7'] },
    slowIntervalSec: { value: 300, source: 'runtime', configValue: 300, default: 300, min: 60, max: 3600 },
    halfHourIntervalSec: { value: 1800, source: 'default', configValue: 1800, default: 1800 },
  },
  warnings: [],
}

test('draftFrom: 数値は文字列、EPC は E7 の形', () => {
  assert.deepEqual(draftFrom(settings), { pollIntervalSec: '30', pollEpcs: ['E7'], slowIntervalSec: '300', halfHourIntervalSec: '1800' })
})

test('validateDraft: 整数・範囲（min/max は Settings が正、無ければ契約の値）・EPC の個数と禁止', () => {
  const ok = draftFrom(settings)
  assert.deepEqual(validateDraft(ok, settings), {})
  const bad = Object.assign({}, ok, { pollIntervalSec: '10', slowIntervalSec: '1.5', halfHourIntervalSec: '8000', pollEpcs: [] })
  const e = validateDraft(bad, settings)
  assert.equal(e.pollIntervalSec, S.settings.errRange(15, 3600))
  assert.equal(e.slowIntervalSec, S.settings.errInteger)
  assert.equal(e.halfHourIntervalSec, S.settings.errRange(300, 7200))
  assert.equal(e.pollEpcs, S.settings.epcTooFew)
  assert.match(validateDraft(Object.assign({}, ok, { pollEpcs: ['E7', 'EC'] }), settings).pollEpcs, /EC/)
  assert.equal(validateDraft(Object.assign({}, ok, { pollEpcs: ['E7', 'E8', 'E0', 'E3', 'EA', 'EB', '80'] }), settings).pollEpcs, S.settings.epcTooMany)
})

test('diffDraft: 変えた項目だけを PUT の本文に入れ、確認の行を作る', () => {
  const d = Object.assign(draftFrom(settings), { pollIntervalSec: '60', pollEpcs: ['E7', 'E8'] })
  const { patch, changes } = diffDraft(d, settings)
  assert.deepEqual(patch, { pollIntervalSec: 60, pollEpcs: ['E7', 'E8'] })
  assert.deepEqual(
    changes.map((c) => [c.field, c.from, c.to]),
    [
      ['pollIntervalSec', '30 秒', '1 分'],
      ['pollEpcs', 'E7', 'E7 E8'],
    ],
  )
  assert.deepEqual(diffDraft(draftFrom(settings), settings), { patch: {}, changes: [] })
})

// 検証は差分に入る項目だけ。触っていない項目が範囲の外なら、注意を出すだけで保存を止めない。
// 戻すと落ちるもの: validateDraft が全部の項目を検証する → 設定ノードの 7200 秒がエラーになる。
test('validateDraft: 変えた項目だけを検証する。触っていない範囲の外の値は untouchedNotes の注意だけ', () => {
  const wide = JSON.parse(JSON.stringify(settings))
  wide.fields.pollIntervalSec.value = 7200
  wide.fields.pollIntervalSec.configValue = 7200
  const d = Object.assign(draftFrom(wide), { pollEpcs: ['E7', 'E8'] })
  assert.deepEqual(changedFields(d, wide), ['pollEpcs'])
  assert.deepEqual(validateDraft(d, wide), {})
  assert.deepEqual(untouchedNotes(d, wide), { pollIntervalSec: S.settings.outOfRangeKept(15, 3600) })
  assert.deepEqual(diffDraft(d, wide).patch, { pollEpcs: ['E7', 'E8'] })
  // 範囲の外の項目を変えた（まだ外）ならエラー。注意は出さない
  const d2 = Object.assign({}, d, { pollIntervalSec: '5000' })
  assert.deepEqual(validateDraft(d2, wide), { pollIntervalSec: S.settings.errRange(15, 3600) })
  assert.deepEqual(untouchedNotes(d2, wide), {})
  // 触っていない EPC が送れない組み合わせ（サーバーの値に E2）でも、ほかの項目の変更は止めない
  const epcBad = JSON.parse(JSON.stringify(settings))
  epcBad.fields.pollEpcs.value = ['0xE7', '0xE2']
  const d3 = Object.assign(draftFrom(epcBad), { slowIntervalSec: '600' })
  assert.deepEqual(validateDraft(d3, epcBad), {})
  assert.deepEqual(untouchedNotes(d3, epcBad), { pollEpcs: S.settings.epcKept })
})

// 下書きは「手で変えた項目」だけを持ち、触っていない項目はいつもサーバーの今の値を出す。
test('mergeDraft・pruneEdits: 手で変えた項目だけを重ね、サーバーの値と同じに戻したものは外す', () => {
  assert.deepEqual(mergeDraft(settings, {}), draftFrom(settings))
  assert.deepEqual(mergeDraft(settings, { slowIntervalSec: '600', other: 'x' }), Object.assign(draftFrom(settings), { slowIntervalSec: '600' }))
  const edits = { slowIntervalSec: '300', pollEpcs: ['E7'], halfHourIntervalSec: '900' }
  assert.deepEqual(pruneEdits(edits, settings), { halfHourIntervalSec: '900' })
  assert.deepEqual(pruneEdits({}, settings), {})
  // 渡した edits は書き換えない
  assert.deepEqual(edits, { slowIntervalSec: '300', pollEpcs: ['E7'], halfHourIntervalSec: '900' })
})

test('epcCandidates: 0x9F で絞り、履歴とマップは外し、選択中は必ず残す', () => {
  const r = epcCandidates(['0x80', '0xE7', '0xE2', '0x9F', '0xE8'], ['E7', 'D3'])
  assert.deepEqual(r, { list: ['80', 'E7', 'E8', 'D3'], fromMeter: true })
  const d = epcCandidates([], ['E7'])
  assert.equal(d.fromMeter, false)
  assert.deepEqual(d.list, DEFAULT_EPC_CANDIDATES)
})

// ---- ログ -----------------------------------------------------------------------

test('ログの絞り込み（レベル・文字）と .txt の行', () => {
  const rows = [
    { seq: 1, at: new Date(2026, 0, 2, 3, 4, 5).getTime(), level: 'debug', text: 'SKVER' },
    { seq: 2, at: 2, level: 'info', text: '接続しました' },
    { seq: 3, at: 3, level: 'good', text: 'PANA OK' },
    { seq: 4, at: 4, level: 'warn', text: 'EVENT 24' },
    { seq: 5, at: 5, level: 'error', text: 'タイムアウト' },
  ]
  assert.equal(filterLogs(rows, 'all', '').length, 5)
  assert.deepEqual(filterLogs(rows, 'info', '').map((r) => r.seq), [2, 3, 4, 5])
  assert.deepEqual(filterLogs(rows, 'warn', '').map((r) => r.seq), [4, 5])
  assert.deepEqual(filterLogs(rows, 'error', '').map((r) => r.seq), [5])
  assert.deepEqual(filterLogs(rows, 'all', 'event').map((r) => r.seq), [4])
  assert.equal(logsToText(rows.slice(0, 1)), '2026/01/02 03:04:05 [DEBUG] SKVER\n')
})

// ---- 推移の遅れた応答 -----------------------------------------------------------------------------

// 戻すと落ちるもの: trend/loaded・trend/failed が今の range と比べない
test('推移: 範囲を切り替えたあとに届いた前の範囲の応答は捨てる（成功も失敗も）', () => {
  const series = (v) => ({ power: [[1, v]] })
  const loading = (range) => ({ type: 'trend/loading', id: 'a1', range })
  const loaded = (range, v) => ({ type: 'trend/loaded', id: 'a1', range, series: series(v), from: 0, to: 2 })
  const s = run([loading('24h'), loading('1h'), loaded('1h', 100), loaded('24h', 240)])
  assert.equal(s.trends.a1.range, '1h')
  assert.deepEqual(s.trends.a1.series.power, [[1, 100]])
  const f = run([loading('24h'), loading('1h'), loaded('1h', 100), { type: 'trend/failed', id: 'a1', range: '24h', error: { message: 'x' } }])
  assert.equal(f.trends.a1.error, null, '前の範囲の失敗を今の範囲に出さない')
  // 前の範囲の応答が先に届いても、今の範囲を読んでいる最中のまま
  const early = run([loading('24h'), loading('1h'), loaded('24h', 240)])
  assert.equal(early.trends.a1.status, 'loading')
  assert.equal(early.trends.a1.series, null)
  // まだ推移を持っていない台の応答は受ける
  assert.equal(run([loaded('6h', 60)]).trends.a1.range, '6h')
})

// ---- 計測値の表に read を重ねる -------------------------------------------------------------------

// 作り直しの直後は表の値が空で、read の値の行に置き換わる。短い名前と確定の時刻を捨てると、値が戻るまで表が変わって見える。
// 戻すと落ちるもの: mergeRead の行に label・meterAt を写さない
test('mergeRead: 表の短い名前と確定の時刻を残す。read が持っていれば read の確定の時刻を使う', () => {
  const row = (epc, label, meterAt) => ({ epc, key: 'k' + epc, name: '正式な名前 ' + epc, label, value: null, unit: null, display: '', at: null, meterAt, fresh: false, held: null, supported: null })
  const items = [row('0xE7', '瞬時電力', null), row('0xEA', '定時積算（買電）', 1000)]
  const out = mergeRead(items, {
    values: {
      instantPower: { epc: 'E7', name: '瞬時電力計測値', value: 746, unit: 'W', display: '746 W', at: 2000, fresh: true },
      scheduledCumulativeForward: { epc: 'EA', name: '定時積算電力量計測値(正方向)', value: 41582.7, unit: 'kWh', display: '41582.7 kWh', at: 2000, fresh: true, meterAt: 1800 },
      faultStatus: { epc: '88', name: '異常発生状態', label: '異常', value: 'x', unit: null, display: 'なし', at: 2000, fresh: true },
    },
    missing: [],
  })
  const by = (e) => out.find((r) => r.epc === e)
  assert.equal(by('0xE7').label, '瞬時電力')
  assert.equal(by('0xE7').display, '746 W')
  assert.equal(by('0xE7').meterAt, null)
  assert.equal(by('0xEA').label, '定時積算（買電）')
  assert.equal(by('0xEA').meterAt, 1800, 'read の時刻が新しい')
  assert.equal(by('0x88').label, '異常', '表に無い行は read の短い名前')
  const kept = mergeRead(items, { values: { scheduledCumulativeForward: { epc: 'EA', value: 1, at: 2000 } }, missing: [] })
  assert.equal(kept.find((r) => r.epc === '0xEA').meterAt, 1000, 'read に無ければ表の時刻のまま')
})
