'use strict'

// 試験の待ち（test/wait-kit.js）の規則そのもの。キットと各ファイルの waitFor・until はここを通るので、規則が崩れると
// 負荷や VM の止まりで落ちる試験が、また散らばって出る。
//
// プロセスごと止まるのは、同期の空回りで真似る（タイマーも止まる。明けると、止まる前に張られたタイマーが順に走る）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { poll, waitFor, STALL_MS } = require('./wait-kit')

/** イベントループごと ms 止める（VM・共有フォルダの詰まりの代わり）。 */
function freeze(ms) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* 止まっている */
  }
}

// 戻すと落ちるもの: 期限を過ぎたら fn を見ずに投げる（前の fake-red.js・sequencer*.test.js の waitFor の形）
test('期限を過ぎても、投げる前に条件をもう一度見る（期限の間際に止まり、明けたときには済んでいたものを赤にしない）', async () => {
  let done = false
  setTimeout(() => {
    freeze(300) // 待ちの上限（100 ms）より長く止まる
    done = true // 止まりが明ける時には済んでいる
  }, 0)
  assert.equal(await waitFor(() => done, 100, '止まりの間に済んだもの'), true)
})

// 戻すと落ちるもの: 止まっていた間も待ちに数える（眠りの 1 回ぶんを頼んだ長さ + STALL_MS で打ち切らない）。
// 期限のあとに 1 回見るだけでも落ちる（待っていたことは、止まりが明けたあとのタイマーで起きる）
test('プロセスごと止まっていた間は数えない。明けたあとのタイマーで済むものも待つ', async () => {
  assert.ok(STALL_MS < 2500, '前提: 止める長さは STALL_MS より長い')
  let done = false
  setTimeout(() => {
    freeze(2500) // 待ちの上限（1.5 秒）より長く止まる
    setTimeout(() => {
      done = true // 止まりが明けてから 50 ms 後に済む
    }, 50)
  }, 0)
  assert.equal(await waitFor(() => done, 1500, '止まりが明けたあとに済むもの'), true)
})

test('起きないときは上限で投げる。止まりを数えなくても、待ちは終わる', async () => {
  const t0 = performance.now()
  await assert.rejects(waitFor(() => false, 200, '起きないもの'), /^Error: 待ち時間を超えました: 起きないもの$/)
  const r = await poll(() => 0, 200, 10)
  assert.deepEqual(r, { ok: false, value: 0 }, '最後の値を返す')
  assert.ok(performance.now() - t0 < 10000, '上限の何倍も待たない')
})

test('fn が Promise を返すときは、その値を返し、かかった時間はそのまま数える', async () => {
  let n = 0
  const r = await poll(async () => (++n >= 3 ? { n } : null), 5000, 1)
  assert.deepEqual(r, { ok: true, value: { n: 3 } })
  const t0 = performance.now()
  const slow = await poll(() => new Promise((res) => setTimeout(() => res(false), 40)), 100, 1)
  assert.equal(slow.ok, false)
  assert.ok(performance.now() - t0 < 5000, 'fn の時間を数えずに回り続けない')
})
