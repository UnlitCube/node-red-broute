'use strict'

// 試験用: 起きるはずのことが起きるまで待つ。試験のキットと各ファイルの waitFor・until は、ここを通して同じ規則で待つ。
// （test/*.test.js の glob に入らない名前にしてある）
//
// ここの上限は「〜ms 未満で終わる」を確かめる線ではない。起きないまま止まらないための上限で、通る試験の時間は変わらない。
//  - 時計は単調な時計（performance.now）で測る。壁時計は飛ぶことがある（Docker の VM で 30 秒ごとに秒単位）
//  - 期限を過ぎても、投げる前に条件をもう一度見る（期限の間際に眠り、起きたときには済んでいたものを赤にしない）
//  - プロセスごと止まっていた間は数えない。VM や共有フォルダが数秒止まると、1 回の眠り（数 ms〜100 ms）が何秒にも延びる。
//    止まりが明けると、止まる前に張られたタイマーが順に走り、待っていたことはその後で起きる。
//    そこで眠り 1 回ぶんは「頼んだ長さ + STALL_MS」までしか数えない。
//    （run-all の途中で Node 18 のコンテナを 10 秒止めると、接続の待ちなどが「待ち時間を超えました」で落ちた）
//    負荷で遅いだけの眠り（Node 18・CPU 2 でも数百 ms）は、そのまま数える

const STALL_MS = 1000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * fn() が真になるまで、stepMs ずつ眠って見直す。{ ok, value } を返す（value は最後の fn() の値）。
 * fn は Promise を返してもよい。fn そのものにかかった時間（fetch の往復など）は、そのまま数える。
 */
async function poll(fn, ms, stepMs) {
  const step = stepMs > 0 ? stepMs : 10
  let left = ms
  for (;;) {
    const a = performance.now()
    const value = await fn()
    if (value) return { ok: true, value }
    left -= performance.now() - a
    if (left <= 0) return { ok: false, value }
    const b = performance.now()
    await sleep(step)
    left -= Math.min(performance.now() - b, step + STALL_MS)
  }
}

/** fn() が真になるまで待ち、true を返す。ms の間に成り立たなければ「待ち時間を超えました: what」で投げる。 */
async function waitFor(fn, ms, what, stepMs) {
  const r = await poll(fn, ms, stepMs)
  if (!r.ok) throw new Error('待ち時間を超えました: ' + (what || '条件'))
  return true
}

module.exports = { poll, waitFor, sleep, STALL_MS }
