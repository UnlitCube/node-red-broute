// ui/route.js: ハッシュの経路と、2 ペイン（PC）/ 1 ペイン（900px 未満）の決め方。
//
// 戻すと落ちるもの:
//   - paneLayout が幅を見ない（いつも 2 ペイン）→ 狭い幅の「一覧だけ」「詳細だけ・← 一覧」が落ちる
//   - autoSelectHref が幅を見ない → 狭い幅の #/ でも先頭へ飛ぶ（一覧が見えない）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TABS, parseRoute, listHref, detailHref, editorNodeHref, paneLayout, autoSelectHref, WIDE_QUERY } from '../../ui/route.js'

test('タブは 状態 / 計測値 / 設定 / 診断 / ログ の 5 つ。知らないタブ（前の版の overview を含む）は状態', () => {
  assert.deepEqual(TABS, ['status', 'values', 'settings', 'diag', 'logs'])
  assert.deepEqual(parseRoute('#/adapters/n1/logs'), { name: 'detail', id: 'n1', tab: 'logs' })
  assert.deepEqual(parseRoute('#/adapters/n1'), { name: 'detail', id: 'n1', tab: 'status' })
  assert.deepEqual(parseRoute('#/adapters/n1/overview'), { name: 'detail', id: 'n1', tab: 'status' })
  assert.deepEqual(parseRoute('#/adapters/n1/nope'), { name: 'detail', id: 'n1', tab: 'status' })
})

test('id はエンコードして往復できる。壊れたエンコードと空は一覧', () => {
  const href = detailHref('a/b c', 'settings')
  assert.equal(href, '#/adapters/a%2Fb%20c/settings')
  assert.deepEqual(parseRoute(href), { name: 'detail', id: 'a/b c', tab: 'settings' })
  assert.equal(detailHref('x', 'weird'), '#/adapters/x/status')
  assert.deepEqual(parseRoute('#/adapters/%E0%A4%A'), { name: 'list' })
  assert.deepEqual(parseRoute(''), { name: 'list' })
  assert.deepEqual(parseRoute('#/'), { name: 'list' })
  assert.equal(listHref(), '#/')
  assert.equal(editorNodeHref('/', 'a1'), '/#node/a1')
  assert.equal(editorNodeHref('/red/', null), '/red/')
})

test('PC と iPad の横（幅 900px 以上）は 2 ペイン。← 一覧 は出さない', () => {
  assert.equal(WIDE_QUERY, '(min-width: 900px)')
  assert.deepEqual(paneLayout({ name: 'list' }, true), { list: true, detail: true, back: false })
  assert.deepEqual(paneLayout({ name: 'detail', id: 'a', tab: 'status' }, true), { list: true, detail: true, back: false })
})

test('900px 未満は 1 ペイン: #/ は一覧だけ、#/adapters/… は詳細だけ（左上に ← 一覧）', () => {
  assert.deepEqual(paneLayout({ name: 'list' }, false), { list: true, detail: false, back: false })
  assert.deepEqual(paneLayout({ name: 'detail', id: 'a', tab: 'logs' }, false), { list: false, detail: true, back: true })
})

test('PC で何も選んでいなければ、一覧の先頭（health の重い順の先頭）を選ぶ先を返す。狭い幅・選び済み・0 台・未取得は null', () => {
  const items = [{ id: 'bad 1' }, { id: 'ok-2' }]
  assert.equal(autoSelectHref({ name: 'list' }, items, true), '#/adapters/bad%201/status')
  assert.equal(autoSelectHref({ name: 'list' }, items, false), null)
  assert.equal(autoSelectHref({ name: 'detail', id: 'ok-2', tab: 'logs' }, items, true), null)
  assert.equal(autoSelectHref({ name: 'list' }, [], true), null)
  assert.equal(autoSelectHref({ name: 'list' }, null, true), null)
})
