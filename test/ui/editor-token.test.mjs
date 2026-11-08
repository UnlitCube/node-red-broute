// ui/editor-token.js: エディタのトークンを読む、ただ 1 つの場所。
// 鍵の作り方は Node-RED の RED.settings.authTokensSuffix（pathname の末尾の / を除いて / を - に）と同じでなければ、
// エディタにログインしていてもトークンが見つからない。
//
// 戻すと落ちるもの:
//   - 接尾辞を付けない → /admin/ のエディタのログインが見つからない
//   - 文字列でないトークンや壊れた JSON で例外を投げる → 画面の操作が全部止まる
//   - 形を調べずにヘッダへ渡す → fetch の例外が「サーバーに接続できません」に化ける
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editorTokenKey, readEditorToken, isEditorTokenEvent } from '../../ui/editor-token.js'
import { editorPathOf } from '../../ui/api.js'

const TOKEN = 'ZmFrZS10b2tlbi1mb3ItdGVzdHM'
const box = (entries) => {
  const m = new Map(Object.entries(entries || {}))
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) }
}

test('鍵の接尾辞は Node-RED と同じ作り方（末尾の / を除いて / を - に）', () => {
  assert.equal(editorTokenKey('/'), 'auth-tokens')
  assert.equal(editorTokenKey('/admin/'), 'auth-tokens-admin')
  assert.equal(editorTokenKey('/a/b/'), 'auth-tokens-a-b')
  assert.equal(editorTokenKey('/admin'), 'auth-tokens-admin', '末尾の / が無くても同じ鍵')
  assert.equal(editorTokenKey(null), null, 'エディタのパスが分からなければ読まない')
  assert.equal(editorTokenKey(undefined), null)
})

test('エディタが置いた JSON から access_token を読む。パスが違えば読まない', () => {
  const s = box({ 'auth-tokens-admin': JSON.stringify({ access_token: TOKEN, expires_in: 604800, token_type: 'Bearer' }) })
  assert.equal(readEditorToken(s, '/admin/'), TOKEN)
  assert.equal(readEditorToken(s, '/'), null, 'ほかのパスのエディタのトークンを使わない')
  assert.equal(readEditorToken(s, null), null)
})

// 逆プロキシが /nodered/ を外すサーバーでは、エディタの鍵は auth-tokens-nodered になる。
// 戻すと落ちるもの: api.js の editorPathOf が接頭辞を足さない → ログインしても鍵が読めず、帯が消えない
test('接頭辞の裏: エディタのパスに接頭辞を足した鍵を読む。接頭辞が無ければ今までと同じ鍵', () => {
  const page = (p) => 'https://example.test' + p + 'wsuha-broute/ui/#/adapters/a1/status'
  const meta = (editorPath, nodeRoot) => ({ auth: { required: true, available: true, editorPath, nodeRoot } })
  assert.equal(editorTokenKey(editorPathOf(meta('/', '/'), page('/'))), 'auth-tokens')
  assert.equal(editorTokenKey(editorPathOf(meta('/', '/'), page('/nodered/'))), 'auth-tokens-nodered')
  assert.equal(editorTokenKey(editorPathOf(meta('/admin/', '/'), page('/nodered/'))), 'auth-tokens-nodered-admin')
  assert.equal(editorTokenKey(editorPathOf(meta('/', '/n/'), page('/nodered/n/'))), 'auth-tokens-nodered')
  assert.equal(editorTokenKey(editorPathOf(meta('/', '/n/'), page('/n/'))), 'auth-tokens')
  // nodeRoot を返さないサーバーは今までどおり
  assert.equal(editorTokenKey(editorPathOf({ auth: { editorPath: '/admin/' } }, page('/nodered/'))), 'auth-tokens-admin')
  assert.equal(editorPathOf({ auth: { editorPath: null, nodeRoot: '/' } }, page('/')), null)
})

test('呼ぶたびに読み直す（別のタブのログイン・ログアウトが次の要求から効く）', () => {
  const s = box()
  assert.equal(readEditorToken(s, '/'), null)
  s.set('auth-tokens', JSON.stringify({ access_token: TOKEN }))
  assert.equal(readEditorToken(s, '/'), TOKEN)
  s.remove('auth-tokens')
  assert.equal(readEditorToken(s, '/'), null)
})

test('無い・壊れている・形の違う値は null で、例外にしない', () => {
  assert.equal(readEditorToken(null, '/'), null)
  assert.equal(readEditorToken({}, '/'), null)
  for (const raw of ['{not json', 'null', '123', '""', '{}', '{"access_token":1}', '{"access_token":""}']) {
    assert.equal(readEditorToken(box({ 'auth-tokens': raw }), '/'), null, raw)
  }
  const thrower = {
    get() {
      throw new Error('blocked')
    },
  }
  assert.equal(readEditorToken(thrower, '/'), null, 'ストレージが使えないブラウザーでも止まらない')
})

test('ヘッダに載せられない形の値は読まない（空白・改行・日本語）', () => {
  for (const t of ['a b', 'a\nb', 'トークン']) {
    assert.equal(readEditorToken(box({ 'auth-tokens': JSON.stringify({ access_token: t }) }), '/'), null, t)
  }
})

test('storage のイベントは、エディタのトークンの変更だけを拾う', () => {
  assert.equal(isEditorTokenEvent({ key: 'auth-tokens' }), true)
  assert.equal(isEditorTokenEvent({ key: 'auth-tokens-admin' }), true)
  assert.equal(isEditorTokenEvent({ key: null }), true, 'localStorage.clear()')
  assert.equal(isEditorTokenEvent({ key: 'wsuha-broute:theme' }), false)
  assert.equal(isEditorTokenEvent({ key: 'editor-tab-state' }), false)
})
