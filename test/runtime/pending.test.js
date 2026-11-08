'use strict'

// 「コマンドの再接続はノードの中で（預かり）」の待ち行列（lib/runtime/pending.js）。
// registry の AdapterHandle が持つ（sequencer を作り直しても同じ待ち行列）。シミュレータの sequencer で確かめる。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createRegistry } = require('../../lib/runtime/registry')
const pending = require('../../lib/runtime/pending')
const { makeAdapter, connect, waitReady } = require('./adapter-kit')
const { waitFor } = require('./fake-red')

const opened = []
afterEach(async () => {
  while (opened.length) {
    const s = opened.pop()
    try {
      await s.destroy()
    } catch (e) {
      /* 片付けの失敗は試験の結果にしない */
    }
  }
})

function adapter(id, opts) {
  const registry = createRegistry()
  const a = makeAdapter(registry, id, opts)
  opened.push(a.seq)
  return Object.assign({ registry }, a)
}

/** 結果か失敗を、待たずに覚える。 */
function track(p) {
  const t = { done: false, value: undefined, err: null }
  p.then(
    (v) => {
      t.done = true
      t.value = v
    },
    (e) => {
      t.done = true
      t.err = e
    }
  )
  return t
}

test('未接続のあいだに来たものは預かり、つながったら来た順に実行する。モジュールだけで答えるものはポートが開けば待たない', async () => {
  // 戻すと落ちるもの: pending.js の ready で module を meter と同じに扱う（接続まで待たせる）・待たずに実行する・順を変える
  const { h, seq } = adapter('p-order')
  const order = []
  const q = h.pending
  assert.ok(q, 'handle が待ち行列を持つ')
  const g1 = track(q.submit({ kind: 'meter', label: 'get E7', timeoutMs: 8000, run: async (s) => (order.push('g1'), s.get([0xe7], 'manual')) }))
  const m1 = track(q.submit({ kind: 'module', label: 'SKVER', timeoutMs: 8000, run: async (s) => (order.push('m1'), s.raw('SKVER')) }))
  const g2 = track(q.submit({ kind: 'meter', label: 'get E8', timeoutMs: 8000, run: async (s) => (order.push('g2'), s.get([0xe8], 'manual')) }))
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(order, [], 'ポートが閉じている間は何も送らない')
  const st = q.stats()
  assert.equal(st.count, 3)
  assert.equal(typeof st.oldestMs, 'number')
  assert.ok(st.oldestMs >= 40, 'いちばん古いものの待ち時間: ' + st.oldestMs)
  const ins = h.inspect().pending
  assert.equal(ins.count, 3, 'inspect（view-model の入力）にも出る')
  assert.ok(ins.oldestMs >= st.oldestMs)
  // ポートを開く: モジュールだけで答える SKVER はここで走る（接続は待たない）
  await seq.transport.open()
  await waitFor(() => m1.done, 3000, 'SKVER')
  assert.equal(m1.err, null)
  assert.deepEqual(order, ['m1'])
  assert.equal(g1.done || g2.done, false, '無線の要るものは接続を待つ')
  seq.start()
  await waitFor(() => g1.done && g2.done, 8000, 'get の返事')
  assert.equal(g1.err, null, g1.err && g1.err.message)
  assert.equal(g2.err, null, g2.err && g2.err.message)
  assert.deepEqual(order, ['m1', 'g1', 'g2'], '来た順')
  assert.equal(g1.value.values[0].epc, 0xe7)
  assert.deepEqual(q.stats(), { count: 0, oldestMs: null })
})

test('待つ長さを過ぎたら NOT_CONNECTED（waitedMs つき）。0 秒なら待たない', { timeout: 10000 }, async () => {
  // 戻すと落ちるもの: 待ちの timer を張らない・waitedMs を付けない
  const { h } = adapter('p-timeout')
  // かかった長さは単調な時計で測る（壁時計は飛ぶことがあり、Docker の VM では 30 秒ごとに 1 秒ほど進む）
  const t0 = performance.now()
  await assert.rejects(
    h.pending.submit({ kind: 'meter', label: 'get E7', timeoutMs: 150, run: async () => 'x' }),
    (err) => {
      assert.equal(err.code, 'NOT_CONNECTED')
      assert.equal(err.status, 503)
      assert.equal(typeof err.waitedMs, 'number')
      assert.ok(err.waitedMs >= 140 && performance.now() - t0 >= 140, 'waitedMs: ' + err.waitedMs)
      assert.match(err.message, /つながらないまま/)
      return true
    }
  )
  await assert.rejects(h.pending.submit({ kind: 'module', label: 'SKINFO', timeoutMs: 0, run: async () => 'x' }), (err) => {
    assert.equal(err.code, 'NOT_CONNECTED')
    assert.equal(err.waitedMs, 0)
    assert.match(err.message, /ポート/)
    return true
  })
  assert.equal(h.pending.stats().count, 0, '過ぎたものは数から外す')
})

test('外部の指示で止めている（stop・terminate）・無効のときは待たずにすぐ失敗。待っている間に止めたら、待っているものもすぐ失敗', async () => {
  // 戻すと落ちるもの: pending.js の immediate で overrides.stopped・meta.enabled を見ない・kick で待っているものを見直さない
  const { h, seq } = adapter('p-stop')
  await seq.stop('点検', { external: true })
  const t0 = performance.now()
  await assert.rejects(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 5000, run: async () => 'x' }), (err) => {
    assert.equal(err.code, 'STOPPED_BY_OVERRIDE')
    assert.equal(err.status, 409)
    assert.match(err.message, /点検/)
    return true
  })
  assert.ok(performance.now() - t0 < 1000, '待たない')
  // 待っている間に止めた
  await seq.start()
  const w = track(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 5000, run: async () => 'x' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(w.done, false)
  await seq.stop('止める', { external: true })
  await waitFor(() => w.done, 1000, '待っていたものの失敗')
  assert.equal(w.err.code, 'STOPPED_BY_OVERRIDE')
  // 無効
  h.meta.enabled = false
  await assert.rejects(h.pending.submit({ kind: 'module', label: 'SKINFO', timeoutMs: 5000, run: async () => 'x' }), (err) => {
    assert.equal(err.code, 'DISABLED')
    return true
  })
})

test('預かれる数の上限（既定 20）を超えたら BUSY。同じ取得は未接続のあいだだけ 1 回にまとめる', async () => {
  // 戻すと落ちるもの: 上限を見ない・sig を見てまとめない・接続中もまとめる
  const { h, seq } = adapter('p-limit')
  assert.equal(pending.DEFAULT_LIMIT, 20)
  const runs = []
  const ts = []
  for (let i = 0; i < 20; i++) {
    ts.push(track(h.pending.submit({ kind: 'meter', label: 'poll', sig: 'poll', timeoutMs: 8000, run: async (s) => (runs.push(i), s.get([0xe7], 'manual')) })))
  }
  assert.equal(h.pending.stats().count, 20)
  await assert.rejects(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 8000, run: async () => 'x' }), (err) => {
    assert.equal(err.code, 'BUSY')
    assert.equal(err.status, 409)
    return true
  })
  await connect(seq)
  await waitFor(() => ts.every((t) => t.done), 8000, '20 件の返事')
  assert.ok(ts.every((t) => !t.err), '全部が答えを受け取る')
  assert.equal(runs.length, 1, '未接続のあいだに重なった同じ取得は 1 回の取得でまとめる（電波を節約）: ' + runs.length)
  // 接続中はまとめない（今までどおり 1 通ごとに取得する）
  const more = []
  for (let i = 0; i < 3; i++) more.push(track(h.pending.submit({ kind: 'meter', label: 'poll', sig: 'poll', timeoutMs: 8000, run: async (s) => (runs.push(i), s.get([0xe7], 'manual')) })))
  await waitFor(() => more.every((t) => t.done), 8000, '接続中の 3 件')
  assert.equal(runs.length, 4, '接続中は 1 通ごと')
})

test('実行の途中でセッションが切れたら、つなぎ直したあと 1 回だけやり直す。2 回目も失敗したら失敗を返す', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: 切れたときにやり直さない・何回もやり直す
  // 戻すと落ちるもの（追加）: pending.js の reconnected を外す（reconnect() の直後はまだ connected に見えるので、つなぎ直す前に送る）
  const { h, seq } = adapter('p-retry')
  await connect(seq)
  const phases = []
  seq.on('phase', (c) => phases.push(c.to))
  let n = 0
  let mark = 0
  let seen = null
  const r = await h.pending.submit({
    kind: 'meter',
    label: 'get E7',
    timeoutMs: 8000,
    run: async (s) => {
      n++
      if (n === 1) {
        mark = phases.length
        s.reconnect('試験: セッションが切れた')
        const e = new Error('再接続の指示')
        e.aborted = true
        throw e
      }
      // 呼ばれたときの段階も（handle の受け手が先に動くので、この試験の phase の受け手より先に呼ばれる）
      seen = phases.slice(mark).concat([s.state.phase])
      return s.get([0xe7], 'manual')
    },
  })
  assert.equal(n, 2, '1 回だけやり直した')
  assert.ok(seen.some((p) => p !== 'connected'), 'つなぎ直してから送った（失敗のあとの段階: ' + seen.join(' → ') + '）')
  assert.equal(seen[seen.length - 1], 'connected')
  assert.equal(r.values[0].epc, 0xe7)
  assert.ok(h.logsAfter({ limit: 1000 }).items.some((x) => /もう一度送ります/.test(x.text)), 'アダプタのログに 1 行')
  await waitReady(seq)
  let m = 0
  await assert.rejects(
    h.pending.submit({
      kind: 'meter',
      label: 'get E7',
      timeoutMs: 8000,
      run: async (s) => {
        m++
        s.reconnect('試験: また切れた')
        const e = new Error('ECHONET 応答のタイムアウト')
        e.timeout = true
        throw e
      },
    }),
    /タイムアウト/
  )
  assert.equal(m, 2, 'やり直しは 1 回だけ')
  // 切れていない失敗（接続したまま FAIL など）はやり直さない
  await waitReady(seq)
  let k = 0
  await assert.rejects(h.pending.submit({ kind: 'meter', label: 'x', timeoutMs: 8000, run: async () => { k++; throw new Error('FAIL ER04') } }), /ER04/)
  assert.equal(k, 1)
})

test('sequencer を作り直しても（detach → attach）、預かったものは新しい sequencer で続ける', async () => {
  // 戻すと落ちるもの: 待ち行列を sequencer に持たせる（作り直すと消える）・attach のあとに見直さない
  const registry = createRegistry()
  const a = makeAdapter(registry, 'p-redeploy', { sim: { meterPresent: false } })
  opened.push(a.seq)
  const seen = []
  const w = track(a.h.pending.submit({ kind: 'meter', label: 'get E7', timeoutMs: 8000, run: async (s) => (seen.push(s), s.get([0xe7], 'manual')) }))
  await connectOpenOnly(a.seq)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(w.done, false, 'メーターが居ないので待っている')
  // 設定ノードの作り直し（デプロイ）と同じ: 前の sequencer を畳んで外し、新しいものを付ける
  await a.seq.destroy()
  a.h.detach(a.seq)
  assert.equal(a.h.pending.stats().count, 1, '外している間も預かったまま')
  const b = makeAdapter(registry, 'p-redeploy', { owner: { id: 'p-redeploy-2' } })
  opened.push(b.seq)
  assert.equal(b.h, a.h, '同じ handle')
  await connect(b.seq)
  await waitFor(() => w.done, 8000, '新しい sequencer での返事')
  assert.equal(w.err, null, w.err && w.err.message)
  assert.deepEqual(seen, [b.seq], '新しい sequencer で実行した')
})

async function connectOpenOnly(seq) {
  await seq.transport.open()
  seq.start()
}

test('送信制限（EVENT 32）の間は預かり、解けたら実行する', async () => {
  // 戻すと落ちるもの: ready で radioBlocked を見ない
  const { h, seq } = adapter('p-radio')
  await connect(seq)
  seq._setRadioBlocked(true, '試験')
  let ran = false
  const w = track(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 8000, run: async (s) => ((ran = true), s.get([0xe7], 'manual')) }))
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(ran, false, '送信制限の間は送らない')
  seq.clearRadioBlock()
  await waitFor(() => w.done, 8000, '解けたあとの返事')
  assert.equal(w.err, null)
  assert.equal(ran, true)
})

test('Node-RED の停止（shutdown）: 預かったものを SHUTDOWN で返す。持ち主のノードを指して取りやめもできる', async () => {
  // 戻すと落ちるもの: shutdown で待っているものを返さない・cancelOwner が持ち主を見ない
  const { h } = adapter('p-shutdown')
  const a = track(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 8000, ownerId: 'n1', run: async () => 'x' }))
  const b = track(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 8000, ownerId: 'n2', run: async () => 'x' }))
  const c = track(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 8000, ownerId: 'n2', run: async () => 'x' }))
  assert.equal(h.pending.cancelOwner('n1', '試験のため'), 1)
  await waitFor(() => a.done, 500, '取りやめ')
  assert.equal(a.err.code, 'SHUTDOWN')
  assert.equal(b.done, false)
  assert.equal(h.pending.shutdown(), 2)
  await waitFor(() => b.done && c.done, 500, 'SHUTDOWN')
  assert.equal(b.err.code, 'SHUTDOWN')
  assert.equal(c.err.code, 'SHUTDOWN')
  assert.deepEqual(h.pending.stats(), { count: 0, oldestMs: null })
})

test('アダプタを初期化できなかった台（buildError で sequencer が無い）は待たずに PORT_DOWN', async () => {
  // 戻すと落ちるもの: buildError を見ずに待たせる（構成を直すまでつながらないのに 120 秒待たせる）
  const registry = createRegistry()
  const h = registry.upsert('p-build')
  h.claim({ id: 'p-build' }, { meta: { name: 'x', enabled: true } })
  h.setBuildError(new Error('ポートがありません'))
  await assert.rejects(h.pending.submit({ kind: 'meter', label: 'get', timeoutMs: 5000, run: async () => 'x' }), (err) => {
    assert.equal(err.code, 'PORT_DOWN')
    assert.match(err.message, /初期化できませんでした/)
    return true
  })
})

test('commandKind: モジュールだけで答えるコマンド（SKINFO・SKVER・SKAPPVER・SKTABLE・ROPT・SKSREG）と、それ以外', () => {
  for (const c of ['SKINFO', 'skver', 'SKAPPVER', 'SKTABLE E', 'ROPT', 'SKSREG S02', ' SKSREG SFD ']) assert.equal(pending.commandKind(c), 'module', c)
  for (const c of ['SKSENDTO 1 FE80 0E1A 1 0 0004', 'SKPING FE80', 'SKSCAN 2 FFFFFFFF 6 0', 'SKINFOX', '']) assert.equal(pending.commandKind(c), 'meter', c)
})

// ---------------------------------------------------------------------------
//  預かりの時計・再接続の直後・送信制限・接続時の一括取得
// ---------------------------------------------------------------------------

test('つながっているあいだは、前のものの実行が長引いても後ろのものを NOT_CONNECTED にしない（待つ長さは、つながっていない間だけ数える）。モジュールだけで答えるものは meter の実行中でも先に流す', { timeout: 20000 }, async () => {
  // 戻すと落ちるもの: pending.js で待つ長さの時計を submit から実行まで止めない（つながっていても前のものの後ろで切れる）・
  // kick で実行中のものがあると kind に関係なく次を始めない（SKINFO が meter の get の後ろで待つ）
  const { h, seq } = adapter('p-busy')
  await connect(seq)
  let release = null
  const slow = track(h.pending.submit({ kind: 'meter', label: '応答の遅い get', timeoutMs: 200, run: () => new Promise((r) => (release = r)) }))
  const g = track(h.pending.submit({ kind: 'meter', label: 'get E8', timeoutMs: 200, run: (s) => s.get([0xe8], 'manual') }))
  const m = track(h.pending.submit({ kind: 'module', label: 'SKINFO', timeoutMs: 200, run: (s) => s.raw('SKINFO') }))
  await waitFor(() => m.done, 3000, 'SKINFO（meter の実行中でも答える）')
  assert.equal(m.err, null, m.err && m.err.message)
  assert.equal(slow.done, false)
  // 待つ長さ（200 ms）を過ぎても、つながっているので後ろの get は NOT_CONNECTED にしない
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(g.done, false, 'つながっているあいだは切らない: ' + (g.err && g.err.message))
  assert.equal(h.pending.stats().count, 2, '実行中の 1 件と、順番を待つ 1 件')
  release('ok')
  await waitFor(() => g.done, 5000, '後ろの get')
  assert.equal(g.err, null, g.err && g.err.message)
  assert.equal(slow.value, 'ok')
  // つながっていない間は数える（ポートが閉じたら、待っているものは待つ長さで切れる）
  let release2 = null
  const slow2 = track(h.pending.submit({ kind: 'meter', label: '応答の遅い get', timeoutMs: 300, run: () => new Promise((r) => (release2 = r)) }))
  const g2 = track(h.pending.submit({ kind: 'meter', label: 'get E7', timeoutMs: 300, run: (s) => s.get([0xe7], 'manual') }))
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(g2.done, false, 'つながっている間の 400 ms は数えない')
  const t0 = performance.now()
  await seq.transport.close()
  await waitFor(() => g2.done, 3000, 'ポートが閉じたあとの待つ長さ')
  assert.equal(g2.err.code, 'NOT_CONNECTED')
  assert.ok(performance.now() - t0 >= 250, '閉じてから待つ長さぶん待った: ' + (performance.now() - t0))
  assert.ok(g2.err.waitedMs >= 650, 'waitedMs は届いてからの長さ: ' + g2.err.waitedMs)
  release2('late')
  await waitFor(() => slow2.done, 3000)
})

test('reconnect() の直後（相がまだ connected に見える間）に来たものは預かり、つなぎ直したあとに送る', { timeout: 20000 }, async () => {
  // 戻すと落ちるもの: pending.js の ready で、相が connected になったときの世代（registry の connectedGen）と今の世代を比べない
  const { h, seq } = adapter('p-recon')
  await connect(seq)
  const phases = []
  seq.on('phase', (c) => phases.push(c.to))
  seq.reconnect('試験: 再接続の指示', 0)
  assert.equal(seq.state.phase, 'connected', '指示の直後はまだ connected に見える（sequencer は少し後に相を変える）')
  let seen = null
  const w = track(
    h.pending.submit({
      kind: 'meter',
      label: 'get E7',
      timeoutMs: 8000,
      run: (s) => {
        seen = phases.slice()
        return s.get([0xe7], 'manual')
      },
    })
  )
  assert.equal(seen, null, '指示の直後には送らない（古いセッションへ送らない）')
  assert.equal(h.pending.stats().count, 1, '預かった')
  await waitFor(() => w.done, 8000, 'つなぎ直したあとの返事')
  assert.equal(w.err, null, w.err && w.err.message)
  assert.ok(seen.some((p) => p !== 'connected'), 'つなぎ直してから送った: ' + seen.join(' → '))
  assert.equal(seen[seen.length - 1], 'connected')
})

test('実行を始めたあとに送信制限（EVENT 32）が掛かって断られたら、数えずに預かり直し、解けたら送る', { timeout: 20000 }, async () => {
  // 戻すと落ちるもの: pending.js の失敗の扱いで err.blocked・state.radioBlocked を見ない（すぐ RADIO_BLOCKED で返す）
  const { h, seq } = adapter('p-radio2')
  await connect(seq)
  let n = 0
  const w = track(
    h.pending.submit({
      kind: 'meter',
      label: 'get E7',
      timeoutMs: 8000,
      run: (s) => {
        n++
        if (n === 1) {
          // 実行を始めた直後（sequencer の要求の待ちの間）に EVENT 32 が来た
          s._setRadioBlocked(true, '試験')
          setTimeout(() => s.clearRadioBlock(), 300)
        }
        return s.get([0xe7], 'manual')
      },
    })
  )
  await waitFor(() => w.done, 8000, '解けたあとの返事')
  assert.equal(w.err, null, w.err && w.err.message)
  assert.equal(n, 2, '解けてからもう一度送った')
  assert.equal(w.value.values[0].epc, 0xe7)
  // 送信制限での預かり直しは、切れたときの「1 回だけのやり直し」に数えない
  let k = 0
  const w2 = track(
    h.pending.submit({
      kind: 'meter',
      label: 'get E8',
      timeoutMs: 8000,
      run: (s) => {
        k++
        if (k === 1) {
          s._setRadioBlocked(true, '試験')
          setTimeout(() => s.clearRadioBlock(), 200)
          return s.get([0xe8], 'manual')
        }
        if (k === 2) {
          s.reconnect('試験: 切れた')
          const e = new Error('再接続の指示')
          e.aborted = true
          return Promise.reject(e)
        }
        return s.get([0xe8], 'manual')
      },
    })
  )
  await waitFor(() => w2.done, 15000, '制限 → 切断のあとの返事')
  assert.equal(w2.err, null, w2.err && w2.err.message)
  assert.equal(k, 3, '制限で 1 回・切れたやり直しで 1 回')
})

test('つながった直後の、接続時に 1 度だけ取る値（係数・単位）を取り終えてから、預かったものを流す', { timeout: 20000 }, async () => {
  // 戻すと落ちるもの: sequencer.js の _afterJoin で _collectingOnce を立てない・pending.js の ready で見ない
  // （預かった E0・E3 が係数より先に走り、積算が未換算のまま出力 1 に出る）
  const registry = createRegistry()
  const a = makeAdapter(registry, 'p-once', { sim: { meterPresent: false } })
  opened.push(a.seq)
  let calib = 'not-run'
  const w = track(
    a.h.pending.submit({
      kind: 'meter',
      label: 'get E0 E3',
      timeoutMs: 8000,
      run: (s) => {
        calib = s.state.calibration.coefficient
        return s.get([0xe0, 0xe3], 'manual')
      },
    })
  )
  await connectOpenOnly(a.seq)
  a.seq.transport.config.meterPresent = true
  await waitFor(() => w.done, 10000, '預かった get')
  assert.equal(w.err, null, w.err && w.err.message)
  assert.notEqual(calib, null, '係数を取ってから走った')
  assert.notEqual(calib, 'not-run')
  const e0 = w.value.values.find((v) => v.epc === 0xe0)
  assert.equal(typeof e0.value, 'number', '積算は換算して出る: ' + JSON.stringify(e0))
})
