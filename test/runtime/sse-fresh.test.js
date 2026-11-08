'use strict'

// SSE は、事象が無くても時間で変わる値の古さ（stale・power.fresh・健康の段）を送る。
// メーターが値を断り続ける台は取得の応答に値が無く、registry の changed が来ないので、
// 画面は古くなったことを知らないまま「計測中」を出し続けていた。値は全部架空。
//
// 戻すと落ちるもの: sse.js の checkFreshness のタイマーを張らない・古さを比べない・dispose で止めない

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createSseHub } = require('../../lib/runtime/sse')

function fakeRes() {
  const res = new EventEmitter()
  res.text = ''
  res.headers = {}
  res.statusCode = 0
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v)
  res.write = (t) => {
    res.text += t
    return true
  }
  res.end = () => res.emit('finish')
  return res
}

/** 書かれた adapters の事象の中身を順に返す */
function adapterEvents(res) {
  const out = []
  for (const block of res.text.split('\n\n')) {
    if (!/^(id: \d+\n)?event: adapters\n/.test(block)) continue
    out.push(JSON.parse(block.slice(block.indexOf('data: ') + 6)))
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function rig() {
  const registry = new EventEmitter()
  registry.list = () => []
  const state = {
    items: [{ id: 'a1', stale: false, health: { level: 'ok' }, power: { value: 400, at: 1, fresh: true } }],
    total: { power: 400, count: 1, enabled: 1, staleCount: 0 },
  }
  const views = {
    adapters: () => JSON.parse(JSON.stringify(state)),
    summaries: () => JSON.parse(JSON.stringify(state.items)),
    detail: (id) => ({ id }),
    measurement: () => null,
    settings: () => null,
  }
  const hub = createSseHub({ registry, views, options: { freshCheckMs: 20, throttleMs: 0, pingMs: 60000, maxAgeMs: 600000 } })
  return { hub, state }
}

test('時間で値が古くなったら、事象が無くても一覧を送る。変わらなければ送らない', async () => {
  const { hub, state } = rig()
  try {
    const req = new EventEmitter()
    const res = fakeRes()
    hub.handle(req, res, { adapterId: null, logs: false })
    await sleep(80)
    const before = adapterEvents(res).length
    assert.equal(before, 1, '最初の一覧だけ。古さが変わらない間は送らない')

    // 時間が経って古くなった（registry の事象は来ない）
    state.items[0].stale = true
    state.items[0].health = { level: 'stale' }
    state.items[0].power.fresh = false
    state.total = { power: null, count: 0, enabled: 1, staleCount: 1 }
    await sleep(120)
    const events = adapterEvents(res)
    assert.ok(events.length > before, '古くなったことを送る')
    const last = events[events.length - 1]
    assert.equal(last.items[0].stale, true)
    assert.equal(last.total.staleCount, 1)

    // 同じ古さのままなら、それ以上は送らない
    const settled = adapterEvents(res).length
    await sleep(100)
    assert.equal(adapterEvents(res).length, settled)
  } finally {
    hub.dispose()
  }
})

test('接続が無い間は見直さない。dispose のあとは見直さない', async () => {
  // 一覧を作り直した回数で見る
  let built = 0
  const registry = new EventEmitter()
  registry.list = () => []
  const views = {
    adapters: () => {
      built++
      return { items: [], total: { power: null, count: 0, enabled: 0, staleCount: 0 } }
    },
    summaries: () => [],
    detail: () => null,
    measurement: () => null,
    settings: () => null,
  }
  const options = { freshCheckMs: 20, throttleMs: 0, pingMs: 60000, maxAgeMs: 600000 }

  const lonely = createSseHub({ registry, views, options })
  await sleep(100)
  lonely.dispose()
  assert.equal(built, 0, '接続が無い間は作り直さない')

  const hub = createSseHub({ registry, views, options })
  hub.handle(new EventEmitter(), fakeRes(), { adapterId: null, logs: false })
  await sleep(60)
  assert.ok(built > 1, '前提: 接続がある間は見直している')
  hub.dispose()
  // dispose は接続を閉じるので、それだけでは見直しが空振りする。止めたことは、閉じたあとにつないだ 1 本で見る
  // （最初の一覧の 1 回だけ作り、そのあとは作り直さない）
  const n = built
  hub.handle(new EventEmitter(), fakeRes(), { adapterId: null, logs: false })
  await sleep(80)
  assert.equal(built, n + 1, 'dispose のあとは見直さない')
  hub.closeAll()
})
