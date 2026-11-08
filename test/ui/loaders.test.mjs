// ui/loaders.js（REST での取得）を、サーバーの実物と reducer（ui/store.js）につないで試す。
// ログはサーバーの実物のリング（lib/runtime/registry.js の AdapterHandle.logsAfter）を、
// 計測値はサーバーの実物の view-model（lib/runtime/view-model.js）を使う（契約の意味が食い違えば落ちる）。
//
// 戻すと落ちるもの:
//   - fetchRecentLogs を「after なし・limit 200 の 1 回だけ」に戻す → 「新しい行まで全部」「1,000 行を超えた」が落ちる
//   - store.js の logs/loading〜logs/loaded の控え（pending）を外す → 「取っている間に SSE で届いた行」が落ちる
//   - meta と session を別々に入れる → ログインしている人にも「ログインしてください」が一瞬出る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { reducer, initialState, LOG_CAP } from '../../ui/store.js'
import { createLoaders, fetchRecentLogs, LOG_PAGE } from '../../ui/loaders.js'
import { filterLogs } from '../../ui/components/tab-logs.js'

const require = createRequire(import.meta.url)
const { AdapterHandle, LOG_RING } = require('../../lib/runtime/registry.js')

const T0 = 1_800_000_000_000

/** 認証の試験の箱。session の答えは順番に返す（関数なら呼ぶ）。 */
function authBox(meta, session) {
  const b = { state: initialState, seen: [], paths: [], sessionCalls: 0 }
  const dispatch = (a) => {
    b.seen.push(a)
    b.state = reducer(b.state, a)
  }
  const api = {
    setEditorPath: (p) => b.paths.push(p),
    meta: async () => meta,
    session: async () => {
      b.sessionCalls++
      return typeof session === 'function' ? session(b.sessionCalls) : session
    },
  }
  b.load = createLoaders({ api, dispatch, getState: () => b.state })
  return b
}

const AUTH = { required: true, available: true, editorPath: '/admin/' }

test('ポートの候補: serialportMessage（serialport を読み込めないときの案内）を state に入れる', async () => {
  // 戻すと落ちるもの: loaders.js で serialportMessage を渡さない・store.js の serialports/loaded で写さない
  const b = { state: initialState }
  const answer = { items: [], at: T0, serialportAvailable: false, serialportMessage: 'serialport を読み込めないので…' }
  const load = createLoaders({ api: { serialports: async () => answer }, dispatch: (a) => (b.state = reducer(b.state, a)), getState: () => b.state })
  await load.serialports()
  assert.equal(b.state.serialports.message, answer.serialportMessage)
  answer.serialportMessage = null
  await load.serialports()
  assert.equal(b.state.serialports.message, null, '読めるようになったら消す')
})

test('認証のあるサーバー: meta のあと session を読み、1 回の dispatch で入れる。エディタのパスを api に渡す', async () => {
  const b = authBox({ readOnly: false, auth: AUTH }, { required: true, loggedIn: true, canWrite: true })
  await b.load.meta()
  assert.deepEqual(b.paths, ['/admin/'])
  assert.equal(b.seen.length, 1, 'meta と session を分けると、ログインしている人にも案内が一瞬出る')
  assert.deepEqual(b.state.auth, { required: true, available: true, loggedIn: true, canWrite: true })
})

test('認証の無いサーバー: session を問い合わせず、トークンも読ませない', async () => {
  const b = authBox({ readOnly: false, auth: { required: false, available: false, editorPath: null } }, null)
  await b.load.meta()
  await b.load.session()
  assert.deepEqual(b.paths, [null])
  assert.equal(b.sessionCalls, 0)
  const old = authBox({ readOnly: false }, null)
  await old.load.meta()
  assert.equal(old.sessionCalls, 0, 'meta.auth の無い古いサーバー')
})

test('session を読めないときは閉じたまま（meta は入れる）', async () => {
  const b = authBox({ readOnly: false, auth: AUTH }, () => {
    throw new Error('network')
  })
  await b.load.meta()
  assert.ok(b.state.meta)
  assert.equal(b.state.auth.required, true)
  assert.equal(b.state.auth.canWrite, false)
})

test('取り直し: 遅れて着いた古い答えで、新しい答えを上書きしない', async () => {
  const release = []
  const b = authBox({ readOnly: false, auth: AUTH }, (n) =>
    n === 1 ? { required: true, loggedIn: false, canWrite: false } : new Promise((r) => release.push(r)),
  )
  await b.load.meta()
  const older = b.load.session()
  const newer = b.load.session()
  release[1]({ required: true, loggedIn: true, canWrite: true })
  await newer
  release[0]({ required: true, loggedIn: false, canWrite: false })
  await older
  assert.equal(b.state.auth.canWrite, true)
})

function handleWith(n, id = 'a1') {
  const h = new AdapterHandle(id, null)
  for (let i = 1; i <= n; i++) h._pushLog('info', 'line ' + i, T0 + i * 1000)
  return h
}

/**
 * http-api の logs と同じ検証（after は 0 以上の整数・limit は 1〜1000）をして、実物の logsAfter を呼ぶ偽の api。
 * hooks.afterRespond: 応答を作った後・返す前に呼ぶ（その間に SSE の行が届く競合を作る）。
 */
function fakeApi(getHandle, hooks = {}) {
  const calls = []
  return {
    calls,
    logs: async (id, { after, limit = 200, level } = {}) => {
      calls.push({ after, limit })
      if (after !== undefined && !(Number.isInteger(after) && after >= 0)) throw Object.assign(new Error('after'), { status: 422 })
      if (!(Number.isInteger(limit) && limit >= 1 && limit <= 1000)) throw Object.assign(new Error('limit'), { status: 422 })
      const r = JSON.parse(JSON.stringify(getHandle().logsAfter({ after: after || 0, limit, level: level || null })))
      if (hooks.afterRespond) hooks.afterRespond(calls.length)
      await new Promise((res) => setImmediate(res))
      return r
    },
  }
}

/** reducer を回す小さな箱（app.js の useReducer の代わり）。 */
function store(state = initialState) {
  const box = { state }
  box.dispatch = (a) => {
    box.state = reducer(box.state, a)
  }
  box.getState = () => box.state
  return box
}

/** LogsTab と同じ並べ方（新しい行を上）。 */
const shown = (s, id = 'a1') => filterLogs(s.logs[id].items, 'all', '').slice().reverse().map((r) => r.seq)

test('前提: サーバーのリングは 1,000 行、画面の上限はそれ以上、1 回の limit の上限は 1,000', () => {
  assert.equal(LOG_RING, 1000)
  assert.ok(LOG_CAP >= LOG_RING)
  assert.equal(LOG_PAGE, 1000)
})

test('最初のログの取得は、リングのいちばん新しい行まで全部取る（古い 200 行で止まらない）', async () => {
  const h = handleWith(900)
  const r = await fetchRecentLogs(fakeApi(() => h), 'a1')
  assert.equal(r.items.length, 900)
  assert.equal(r.items[0].seq, 1)
  assert.equal(r.items[r.items.length - 1].seq, 900)
  assert.equal(r.nextSeq, 900)
})

test('リングが 1,000 行を超えていても、新しい方の 1,000 行を取り、間が抜けない', async () => {
  const h = handleWith(1500)
  const api = fakeApi(() => h)
  const r = await fetchRecentLogs(api, 'a1')
  assert.deepEqual([r.items[0].seq, r.items[r.items.length - 1].seq, r.items.length], [501, 1500, 1000])
  assert.ok(r.items.every((row, i) => i === 0 || row.seq === r.items[i - 1].seq + 1), '連番が途切れない')
  assert.equal(r.nextSeq, 1500)
  assert.ok(api.calls.length <= 3, String(api.calls.length))
  // 0 行でも落ちない
  const empty = await fetchRecentLogs(fakeApi(() => new AdapterHandle('a1', null)), 'a1')
  assert.deepEqual(empty, { items: [], nextSeq: 0 })
})

test('小さな頁でも nextSeq をたどって末尾まで取り、keep 行だけ残す', async () => {
  const h = handleWith(450)
  const api = fakeApi(() => h)
  const r = await fetchRecentLogs(api, 'a1', { pageSize: 100, keep: 300 })
  assert.deepEqual([r.items[0].seq, r.items[r.items.length - 1].seq, r.items.length, r.nextSeq], [151, 450, 300, 450])
  assert.deepEqual(api.calls.map((c) => c.after), [undefined, 100, 200, 300, 400])
})

test('取っている途中で Node-RED が再起動して連番が戻ったら、新しい方の行だけにする', async () => {
  let h = handleWith(250)
  const api = fakeApi(() => h, {
    afterRespond: (n) => {
      if (n === 1) h = handleWith(30) // 1 回目の応答の後に再起動（連番が 1 から）
    },
  })
  const r = await fetchRecentLogs(api, 'a1', { pageSize: 100 })
  assert.deepEqual(r.items.map((x) => x.seq), Array.from({ length: 30 }, (_, i) => i + 1))
  assert.equal(r.nextSeq, 30)
})

test('ログタブ: 取得の後に SSE で届いた行が、取った行のすぐ上に続く（R1: 901, 200, 199 にならない）', async () => {
  const h = handleWith(900)
  const st = store()
  const load = createLoaders({ api: fakeApi(() => h), dispatch: st.dispatch, getState: st.getState })
  await load.logs('a1')
  const row = h._pushLog('info', 'line 901 (SSE)', T0 + 901_000)
  st.dispatch({ type: 'log', id: 'a1', row })
  assert.deepEqual(shown(st.state).slice(0, 3), [901, 900, 899])
  assert.equal(st.state.logs.a1.items.length, 901)
  assert.equal(st.state.logs.a1.nextSeq, 901)
})

test('ログタブ: 取っている間に SSE で届いた行（応答より先に着いた行）を、応答で消さない', async () => {
  const h = handleWith(300)
  const st = store()
  const api = fakeApi(() => h, {
    afterRespond: (n) => {
      if (n !== 1) return
      // サーバーが応答を作った後に 2 行増え、その SSE が REST の応答より先に画面へ着く
      for (const i of [301, 302]) st.dispatch({ type: 'log', id: 'a1', row: h._pushLog('warn', 'line ' + i, T0 + i * 1000) })
    },
  })
  const load = createLoaders({ api, dispatch: st.dispatch, getState: st.getState })
  await load.logs('a1')
  const seqs = st.state.logs.a1.items.map((r) => r.seq)
  assert.deepEqual([seqs.length, seqs[0], seqs[seqs.length - 1]], [302, 1, 302])
  assert.equal(new Set(seqs).size, seqs.length, '重複しない')
  assert.equal(st.state.logs.a1.nextSeq, 302)
  assert.equal(st.state.logs.a1.loading, 0)
  assert.equal(st.state.logs.a1.pending, null)
  // そのあとのポーリング（moreLogs）は、抜けも重複も無く続く
  for (const i of [303, 304]) h._pushLog('info', 'line ' + i, T0 + i * 1000)
  await load.moreLogs('a1')
  assert.deepEqual(st.state.logs.a1.items.slice(-4).map((r) => r.seq), [301, 302, 303, 304])
})

test('ログタブ: Node-RED の再起動（reset）の後の取り直しで、新しい連番の行に置き換わり、取得中の SSE の行も残る', async () => {
  let h = handleWith(700)
  const st = store()
  const api = fakeApi(() => h)
  const load = createLoaders({ api, dispatch: st.dispatch, getState: st.getState })
  await load.logs('a1')
  assert.equal(st.state.logs.a1.items.length, 700)
  // 再起動: 連番が 1 から。reset を受けて取り直す。応答の前に新しい連番の行が SSE で届く
  h = handleWith(5)
  api.logs = ((orig) => async (...a) => {
    const r = await orig(...a)
    st.dispatch({ type: 'log', id: 'a1', row: h._pushLog('info', 'after restart', T0) })
    return r
  })(api.logs)
  await load.logs('a1')
  assert.deepEqual(st.state.logs.a1.items.map((r) => r.seq), [1, 2, 3, 4, 5, 6])
  assert.equal(st.state.logs.a1.nextSeq, 6)
})

test('ポーリング中に Node-RED が再起動して連番が戻っても、ログが止まらない', async () => {
  let h = handleWith(50)
  const st = store()
  const load = createLoaders({ api: fakeApi(() => h), dispatch: st.dispatch, getState: st.getState })
  await load.logs('a1')
  h = handleWith(3)
  await load.moreLogs('a1')
  assert.deepEqual(st.state.logs.a1.items.map((r) => r.seq), [1, 2, 3])
  h._pushLog('info', 'next', T0)
  await load.moreLogs('a1')
  assert.deepEqual(st.state.logs.a1.items.map((r) => r.seq), [1, 2, 3, 4])
})

test('ログの取得に失敗しても、控えを残し続けない（重なった取り直しは全部終わるまで控える）', () => {
  let s = initialState
  s = reducer(s, { type: 'logs/loading', id: 'a1' })
  s = reducer(s, { type: 'logs/loading', id: 'a1' })
  s = reducer(s, { type: 'log', id: 'a1', row: { seq: 10, at: 1, level: 'info', text: 'x' } })
  s = reducer(s, { type: 'logs/failed', id: 'a1', error: { status: 503 } })
  assert.equal(s.logs.a1.loading, 1)
  assert.equal(s.logs.a1.pending.length, 1)
  s = reducer(s, { type: 'logs/loaded', id: 'a1', items: [{ seq: 9, at: 1, level: 'info', text: 'y' }], nextSeq: 9 })
  assert.deepEqual(s.logs.a1.items.map((r) => r.seq), [9, 10])
  assert.equal(s.logs.a1.loading, 0)
  assert.equal(s.logs.a1.pending, null)
  // 取り直していないときの SSE の行は控えない
  s = reducer(s, { type: 'log', id: 'a1', row: { seq: 11, at: 1, level: 'info', text: 'z' } })
  assert.equal(s.logs.a1.pending, null)
})

// 計測値の表は、ノードの read と同じ「持っている値」を出す。サーバーの実物の view-model（GET values の表）と
// read-values（GET read）で、設定ノードを作り直した直後（今の sequencer は E8 だけ、registry は前の sequencer の E7 も持つ）を作る。
// 戻すと落ちるもの: loaders.values が GET values だけを見る（E7 が「まだ取れていません」のまま・定期取得の残りの行が出ない）。
test('計測値: 表（GET values）に read の持っている値（作り直す前の値）と、まだ取れていない定期取得の値（missing）を重ねる', async () => {
  const vm = require('../../lib/runtime/view-model.js')
  const rv = require('../../lib/runtime/read-values.js')
  const { valueState } = await import('../../ui/components/tab-values.js')
  const now = T0
  const e7 = { epc: 0xe7, name: '瞬時電力計測値', value: 746, unit: 'W', display: '746 W', at: now - 10_000 }
  const e8 = { epc: 0xe8, name: '瞬時電流計測値', value: { r: 3, t: 2 }, unit: 'A', display: 'R 3.0 A / T 2.0 A', at: now - 5_000 }
  const input = { snap: { known: { '0xE8': e8 }, pollEpcs: ['0xE7', '0xE8'], snaHold: {}, supportedEpcs: [] }, options: null }
  const valuesRes = JSON.parse(JSON.stringify({ items: vm.buildValueRows(input, now), at: now }))
  const readRes = JSON.parse(JSON.stringify(rv.buildRead({ device: '電力', deviceKey: 'sim0', known: { '0xE7': e7, '0xE8': e8 }, req: null, inspect: input, now })))
  // 前提: 表では E7 の値が無く、read には E7 があり、missing に定期取得の残り（5 分・30 分ごとの値）がある
  assert.equal(valuesRes.items.find((r) => r.epc === '0xE7').at, null)
  assert.equal(readRes.values.instantPower.display, '746 W')
  assert.ok(readRes.missing.length >= 2, JSON.stringify(readRes.missing))

  const calls = []
  const api = {
    values: async (id) => (calls.push('values ' + id), valuesRes),
    read: async (id) => (calls.push('read ' + id), readRes),
  }
  const st = store()
  await createLoaders({ api, dispatch: st.dispatch, getState: st.getState }).values('a1')
  assert.deepEqual(calls.sort(), ['read a1', 'values a1'])
  const items = st.state.values.a1.items
  const e7row = items.find((r) => r.epc === '0xE7')
  assert.equal(e7row.display, '746 W', '作り直す前の値も read と同じく出す')
  assert.equal(e7row.at, e7.at)
  assert.equal(e7row.key, 'instantPower')
  const e8row = items.find((r) => r.epc === '0xE8')
  assert.deepEqual(e8row, valuesRes.items.find((r) => r.epc === '0xE8'), '表に値のある行は表のまま（控え中・持っているかを残す）')
  for (const m of readRes.missing) {
    const row = items.find((r) => r.epc === '0x' + m)
    assert.ok(row, 'missing の行: ' + m)
    assert.equal(valueState(row, now).text, (await import('../../ui/strings.js')).S.values.missing, m)
    assert.ok(row.name, '名前（日本語）: ' + m)
  }
  assert.deepEqual(items.map((r) => r.epc), items.map((r) => r.epc).slice().sort(), 'EPC の順')

  // read の無い古いサーバー（404）・read だけの失敗は、表のまま
  const old = store()
  const notFound = Object.assign(new Error('見つかりません'), { status: 404, code: 'NOT_FOUND' })
  await createLoaders({ api: { values: async () => valuesRes, read: async () => Promise.reject(notFound) }, dispatch: old.dispatch, getState: old.getState }).values('a1')
  assert.deepEqual(old.state.values.a1.items, valuesRes.items)
  assert.equal(old.state.values.a1.status, 'ok')
})
