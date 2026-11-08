// ui/adapter-view.js: 一覧の行と詳細の見出しに出す理由（純関数）。
// 停止の理由は 1 か所だけ（2 回出さない）。一覧の行には停止中や異常の短い理由。
//
// 戻すと落ちるもの:
//   - headline が health.reasons と overridden.stopped の両方から理由を出す → 「止めた理由」が 2 回
//   - headline が、健康が stopped でない（無効が先に効く）ときに停止の理由を落とす → 理由が 0 回
//   - shortReason が健康 ok の台にも理由を返す
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headline, shortReason, adapterFlags } from '../../ui/adapter-view.js'
import { S } from '../../ui/strings.js'

const H = (level, extra = {}) => Object.assign({ level, title: S.health[level], reasons: [], nextAction: null }, extra)
const a = (extra = {}) => Object.assign({ id: 'n1', name: 'x', health: H('ok'), overridden: { stopped: null, any: false } }, extra)
const count = (list, needle) => list.join('\n').split(needle).length - 1

test('外部の停止（健康が stopped）: 理由は reasons の 1 行だけで、「止めた理由: …」を付ける', () => {
  const x = a({
    overridden: { stopped: { reason: '点検', at: 1 }, any: true },
    health: H('stopped', { title: '外部の指示で停止中', reasons: ['点検'], nextAction: '「開始」で再開します' }),
  })
  const h = headline(x)
  assert.equal(h.title, null, 'ピルと同じ文の title は出さない')
  assert.deepEqual(h.reasons, [S.detail.stopReason('点検')])
  assert.equal(h.next, '「開始」で再開します')
  assert.equal(count(h.reasons, '点検'), 1)
  assert.equal(shortReason(x), S.flags.stopped('点検'))
  assert.equal(adapterFlags(x).some((f) => f.text.includes('点検')), false, 'バッジに理由を重ねない')
})

test('無効で止めてある台（健康は disabled）: 停止の理由を reasons に 1 回だけ足す', () => {
  const x = a({
    enabled: false,
    overridden: { stopped: { reason: '点検', at: 1 }, any: true },
    health: H('disabled', { title: '無効', reasons: ['設定ノードで無効にしています'] }),
  })
  const h = headline(x)
  assert.deepEqual(h.reasons, ['設定ノードで無効にしています', S.detail.stopReason('点検')])
  assert.equal(count(h.reasons, '点検'), 1)
})

test('異常: ピルと違う title は見出しに出し、reasons から同じ文を除く。一覧の短い理由は title', () => {
  const x = a({ health: H('bad', { title: 'USB が切断されています', reasons: ['USB が切断されています', 'ポートを開けません'], nextAction: '挿し直してください' }) })
  const h = headline(x)
  assert.equal(h.title, 'USB が切断されています')
  assert.deepEqual(h.reasons, ['ポートを開けません'])
  assert.equal(shortReason(x), 'USB が切断されています')
})

test('計測中は短い理由を出さない。title がピルと同じなら reasons の先頭、無ければ健康の名前', () => {
  assert.equal(shortReason(a()), null)
  assert.equal(shortReason(a({ health: H('busy', { reasons: ['スキャン中'] }) })), 'スキャン中')
  assert.equal(shortReason(a({ health: H('idle') })), S.health.idle)
  assert.equal(shortReason(a({ health: null })), S.unknown)
})

test('バッジ: 上書き中（停止以外）・送信制限中・鍵の更新中・別の個体', () => {
  assert.deepEqual(adapterFlags(a()).map((f) => f.text), [])
  const x = a({ overridden: { stopped: null, any: true }, radioBlocked: true, keyBlocked: true, device: { macMatches: false } })
  assert.deepEqual(adapterFlags(x).map((f) => f.text), [S.flags.overridden, S.flags.radioBlocked, S.flags.keyBlocked, S.flags.wrongDevice])
  // 停止の上書きは理由の行が受け持つので「上書き中」も出さない
  const st = a({ overridden: { stopped: { reason: 'r', at: 1 }, any: true } })
  assert.deepEqual(adapterFlags(st).map((f) => f.text), [])
})
