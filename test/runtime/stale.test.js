'use strict'

// 値の古さ（stale）の判定と、全台の合計から外すこと。
// 「つながっているのに値が来ない」状態を緑のまま見逃さないための試験。値は全部架空。
// lastValueAt は「主な値（瞬時電力。取得間隔で取っていなければ取得間隔の値）」が届いた時刻（sequencer の _isMainValue）。
//
// 戻すと落ちるもの:
// - 猶予を valueWaitSince でなく今の接続（phaseSince）から数える形（つなぎ直すたびに猶予が延びる）
// - totalOf が瞬時電力そのものの新しさ（power.fresh）を見ない形（取得間隔の値から瞬時電力を外した台で古い値を足す）
// - pollHeld が控えの期限を見ない形・連続失敗が 3 回以上で控えの案内を出さない形

const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('../../lib/runtime/view-model')
const { totalOf } = require('../../lib/runtime/service')

const NOW = Date.UTC(2026, 10, 8, 3, 0, 0)
const MIN = 60 * 1000

/** buildSummary に渡す形。snap は sequencer の snapshot() に近い最小の形 */
function inputOf(snap, phaseSince) {
  return {
    id: 'a1',
    meta: { name: '電力', mode: 'simulator' },
    options: { pollIntervalSec: 30 },
    phaseSince,
    snap: Object.assign(
      {
        phase: 'connected',
        running: true,
        portOpen: true,
        connected: true,
        consecutiveFailures: 0,
        pollIntervalSec: 30,
        pollEpcs: ['0xE7'],
        known: {},
        snaHold: {},
        lastValueAt: null,
        valueWaitSince: null,
        overrides: { stopped: null, pollIntervalSec: null, pollEpcs: null, any: false },
        credentials: { configured: true, source: '環境変数' },
        device: {},
        meter: {},
      },
      snap
    ),
  }
}

test('瞬時電力だけ断られ続けると古いとみなし、控えの案内を出し、合計から外す', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        pollEpcs: ['0xE7', '0xE8'],
        known: { '0xE7': { value: 405, at: NOW - 120 * MIN }, '0xE8': { value: 15, at: NOW - 20 * 1000 }, '0xE0': { value: 1234, at: NOW - 1 * MIN } },
        snaHold: { '0xE7': { count: 4, until: NOW + 5 * MIN, at: NOW - 1 * MIN } },
        lastValueAt: NOW - 120 * MIN,
      },
      NOW - 180 * MIN
    ),
    NOW
  )
  assert.equal(s.stale, true)
  assert.equal(s.health.level, 'stale')
  assert.match(s.health.title, /最終 120 分前/)
  assert.match(s.health.nextAction, /メーターがこの値を返していません/)
  const total = totalOf([s])
  assert.equal(total.power, null)
  assert.equal(total.staleCount, 1)
})

test('値が来ないままつなぎ直す台は、猶予を最後の値のあとの最初の接続から数え、古いとみなす', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        consecutiveFailures: 5,
        known: { '0xE7': { value: 405, at: NOW - 120 * MIN } },
        lastValueAt: NOW - 120 * MIN,
        valueWaitSince: NOW - 118 * MIN,
      },
      NOW - 10 * 1000
    ),
    NOW
  )
  assert.equal(s.stale, true)
  assert.equal(totalOf([s]).power, null, '古い瞬時電力を合計に入れない')
  assert.equal(s.health.level, 'bad', '連続失敗が続く台は、値の古さより失敗を先に知らせる')
})

test('ふつうに切れてつながり直した直後は、最初の値を待つ間は古いと言わない', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        consecutiveFailures: 2,
        known: { '0xE7': { value: 405, at: NOW - 20 * MIN } },
        lastValueAt: NOW - 20 * MIN,
        valueWaitSince: NOW - 10 * 1000,
      },
      NOW - 10 * 1000
    ),
    NOW
  )
  assert.equal(s.stale, false)
  assert.equal(totalOf([s]).power, null, '台は古いと言わないが、足す瞬時電力そのものは古いので合計には入れない')
})

test('値が届いている台（valueWaitSince が null）には猶予を付けない', () => {
  const s = vm.buildSummary(
    inputOf({ known: { '0xE7': { value: 405, at: NOW - 10 * MIN } }, lastValueAt: NOW - 10 * MIN, valueWaitSince: null }, NOW - 10 * 1000),
    NOW
  )
  assert.equal(s.stale, true)
})

test('起動して最初の接続は、値を待つ間だけ猶予する', () => {
  const fresh = vm.buildSummary(inputOf({ valueWaitSince: NOW - 10 * 1000 }, NOW - 10 * 1000), NOW)
  assert.equal(fresh.stale, false)
  const late = vm.buildSummary(inputOf({ valueWaitSince: NOW - 10 * MIN }, NOW - 10 * MIN), NOW)
  assert.equal(late.stale, true, '猶予（取得間隔 × 3 + 30 秒）を過ぎても値が無ければ古い')
  assert.match(late.health.title, /まだ瞬時電力が届いていません/, '何が届いていないかを名前で書く')
})

test('瞬時電力が届いていれば古くなく、合計に入る', () => {
  const s = vm.buildSummary(
    inputOf({ known: { '0xE7': { value: 418, at: NOW - 20 * 1000 } }, lastValueAt: NOW - 20 * 1000 }, NOW - 180 * MIN),
    NOW
  )
  assert.equal(s.stale, false)
  assert.equal(s.power.fresh, true)
  assert.equal(totalOf([s]).power, 418)
})

test('取得間隔の値から瞬時電力を外した台は、台は古くなくても、古い瞬時電力を合計に入れない', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        pollEpcs: ['0xE8'],
        known: { '0xE7': { value: 405, at: NOW - 60 * MIN }, '0xE8': { value: 15, at: NOW - 20 * 1000 } },
        lastValueAt: NOW - 20 * 1000,
      },
      NOW - 180 * MIN
    ),
    NOW
  )
  assert.equal(s.stale, false)
  assert.equal(s.power.fresh, false)
  const total = totalOf([s])
  assert.equal(total.power, null)
  assert.equal(total.staleCount, 1)
})

test('控えの期限が切れて聞き直しても返らないまま（取得間隔の 2 回分を過ぎた）ときは、控えの案内でなく再接続の案内', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        known: { '0xE7': { value: 405, at: NOW - 30 * MIN } },
        snaHold: { '0xE7': { count: 2, until: NOW - 5 * MIN, at: NOW - 10 * MIN } },
        lastValueAt: NOW - 30 * MIN,
      },
      NOW - 180 * MIN
    ),
    NOW
  )
  assert.equal(s.health.level, 'stale')
  assert.doesNotMatch(s.health.nextAction, /メーターがこの値を返していません/)
})

// 戻すと落ちるもの: pollHeldOf が期限（until > now）だけを見る（聞き直すまでの間に、起きない再接続を案内する）
test('控えの期限が切れた直後（聞き直すまで）は、最後に断られたのが最後の値より後なら控えの案内のまま', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        known: { '0xE7': { value: 405, at: NOW - 30 * MIN } },
        snaHold: { '0xE7': { count: 2, until: NOW - 10 * 1000, at: NOW - 6 * MIN } },
        lastValueAt: NOW - 30 * MIN,
      },
      NOW - 180 * MIN
    ),
    NOW
  )
  assert.equal(s.health.level, 'stale')
  assert.match(s.health.nextAction, /メーターがこの値を返していません/)
})

test('連続失敗が 3 回以上でも、つながっていて値を断られているだけなら控えの案内を出す', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        consecutiveFailures: 3,
        known: { '0xE7': { value: 405, at: NOW - 30 * MIN } },
        snaHold: { '0xE7': { count: 4, until: NOW + 5 * MIN, at: NOW - 1 * MIN } },
        lastValueAt: NOW - 30 * MIN,
        valueWaitSince: NOW - 25 * MIN,
      },
      NOW - 25 * MIN
    ),
    NOW
  )
  assert.equal(s.health.level, 'stale')
  assert.match(s.health.nextAction, /メーターがこの値を返していません/)
})

test('連続失敗が残ったままつながっている台の赤は、起きない「段でやり直します」を出さない', () => {
  const plain = vm.buildSummary(
    inputOf({ consecutiveFailures: 4, known: { '0xE7': { value: 405, at: NOW - 60 * 1000 } }, lastValueAt: NOW - 60 * 1000, ladder: 1 }, NOW - 60 * 1000),
    NOW
  )
  assert.equal(plain.health.level, 'bad')
  assert.doesNotMatch(plain.health.nextAction, /段 \d/)
  const held = vm.buildSummary(
    inputOf(
      {
        consecutiveFailures: 4,
        known: { '0xE7': { value: 405, at: NOW - 60 * 1000 } },
        snaHold: { '0xE7': { count: 2, until: NOW + 5 * MIN, at: NOW - 10 * 1000 } },
        lastValueAt: NOW - 60 * 1000,
        ladder: 1,
      },
      NOW - 60 * 1000
    ),
    NOW
  )
  assert.match(held.health.nextAction, /メーターがこの値を返していません/)
})

test('控えの案内は主な値（瞬時電力）の控えだけを見る。瞬時電流だけ控えているときは出さない', () => {
  const s = vm.buildSummary(
    inputOf(
      {
        pollEpcs: ['0xE7', '0xE8'],
        known: { '0xE7': { value: 405, at: NOW - 30 * MIN } },
        snaHold: { '0xE8': { count: 4, until: NOW + 5 * MIN, at: NOW - 1 * MIN } },
        lastValueAt: NOW - 30 * MIN,
      },
      NOW - 180 * MIN
    ),
    NOW
  )
  assert.equal(s.health.level, 'stale')
  assert.doesNotMatch(s.health.nextAction, /メーターがこの値を返していません/)
})

test('取得間隔の値を決めていない台は、主な値の時刻（lastValueAt）で判定する', () => {
  const s = vm.buildSummary(
    inputOf({ pollEpcs: [], known: { '0xE0': { value: 1, at: NOW - 60 * 1000 } }, lastValueAt: NOW - 60 * 1000 }, NOW - 180 * MIN),
    NOW
  )
  assert.equal(s.stale, false)
})
