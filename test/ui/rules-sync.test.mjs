// 画面とサーバーに分かれて書いてある規則を照らす。片方だけ直すと黙ってずれるので、ここで落とす。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { phaseStep } from '../../ui/format.js'
import { TX_GUARD_SEC } from '../../ui/status-view.js'
import { totalPower } from '../../ui/store.js'
import { DEFAULT_BAUDS, baudChoices, DEFAULT_BAUD } from '../../ui/config-model.js'
import { S } from '../../ui/strings.js'

const require = createRequire(import.meta.url)
const { PHASE_NAMES, DEFAULTS } = require('../../lib/sequencer.js')

/** ステッパーに段が無くてよい相（動いていない・接続の途中ではない）。増えたら、ここか format.js の phaseStep に足す。 */
const NO_STEP = ['idle', 'overridden', 'need-secrets', 'error'] // error は status-view.js の phaseStepper が今の段を失敗にする

test('sequencer の相は、全部ステッパーの段に割り当てるか、段が無いと決めてある', () => {
  assert.ok(PHASE_NAMES.length >= 8, PHASE_NAMES.join(','))
  const unknown = PHASE_NAMES.filter((p) => phaseStep(p) < 0 && !NO_STEP.includes(p))
  assert.deepEqual(unknown, [], 'format.js の phaseStep に無い相')
  assert.equal(phaseStep('connected'), 5)
})

test('送信を休む線の予備値は、sequencer の txBudgetGuardMs の既定と同じ', () => {
  assert.ok(DEFAULTS, 'sequencer の既定値を export している')
  assert.equal(TX_GUARD_SEC * 1000, DEFAULTS.txBudgetGuardMs)
})

// 追加のモーダルは Config を持たないので、画面の表がそのまま候補になる。ずれると、選べる値がサーバーに断られ、許す値を選べない。
test('通信速度の候補: 画面の予備の表はサーバーの BAUDS と同じ。モーダルの先頭は既定の 115200', () => {
  const { BAUDS } = require('../../lib/runtime/config-fields.js')
  assert.deepEqual(DEFAULT_BAUDS, BAUDS)
  const list = baudChoices(null, String(DEFAULT_BAUD))
  assert.equal(list[0], 115200)
  assert.deepEqual(list.slice().sort((a, b) => a - b), BAUDS, '候補はサーバーの表のとおり')
})

// 契約の counters は全部を「詳しい状態」に出す。ラベルの無いキーは黙って落ちる（API は返すのに画面に出ない型）。
test('状態タブの回数: 画面のラベルは、サーバーの counters のキーと同じ', () => {
  const { buildDetail } = require('../../lib/runtime/view-model.js')
  assert.deepEqual(Object.keys(S.status.counters).sort(), Object.keys(buildDetail({ id: 'x' }).counters).sort())
})

test('全台の合計: 画面の予備の計算と service.js の totalOf が同じ答え', () => {
  const { totalOf } = require('../../lib/runtime/service.js')
  const items = [
    { enabled: true, power: { value: 100 }, stale: false },
    { enabled: true, power: { value: -30 }, stale: false }, // 売電は負のまま足す
    { enabled: true, power: { value: 500 }, stale: true }, // 値が古い台は除く
    { enabled: true, power: { value: null }, stale: false }, // 値の無い台は足さない
    { enabled: false, power: { value: 900 }, stale: false }, // 無効は数えない
  ]
  const s = totalOf(items)
  const u = totalPower(items)
  assert.equal(s.power, 70)
  assert.equal(u.sum, s.power)
  assert.equal(u.count, s.count)
  assert.equal(u.total, s.enabled)
  assert.equal(u.staleCount, s.staleCount)
})
