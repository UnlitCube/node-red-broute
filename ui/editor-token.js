// エディタのログインのトークンを読む、ただ 1 つの場所（ほかのファイルで読むと test/ui/safety.test.mjs が落ちる）。
// 画面は独自のログインのフォームを持たない。Node-RED のエディタは、ログインすると同じオリジンの localStorage の
// auth-tokens<接尾辞> に {access_token, …} を JSON で置くので、それを借りて変更の要求に添える。
// 値は store に入れず、要求のたびに読み直す。別のタブでログイン・ログアウトしても次の要求から効き、
// 画面の状態の写しにトークンが残らない。

const KEY = 'auth-tokens'

/**
 * トークンの鍵。接尾辞は Node-RED の RED.settings.authTokensSuffix と同じ作り方で、
 * エディタのパスの末尾の / を除いて / を - にしたもの（/ は空、/admin/ は -admin）。
 * @param {string|null|undefined} editorPath ブラウザから見たエディタのパス（api.js の editorPathOf）
 * @returns {string|null} エディタのパスが分からなければ null
 */
export function editorTokenKey(editorPath) {
  if (typeof editorPath !== 'string') return null
  return KEY + editorPath.replace(/\/+$/, '').replace(/\//g, '-')
}

/**
 * いまのトークン。無い・読めない・ヘッダに載せられない形なら null（要求はトークンなしで送り、サーバーが 401 で断る）。
 * @param {{get: (k: string) => string|null}|null|undefined} storage safeStorage
 * @param {string|null|undefined} editorPath ブラウザから見たエディタのパス（api.js の editorPathOf）
 * @returns {string|null}
 */
export function readEditorToken(storage, editorPath) {
  const key = editorTokenKey(editorPath)
  if (!key || !storage || typeof storage.get !== 'function') return null
  try {
    const raw = storage.get(key)
    const tokens = raw ? JSON.parse(raw) : null
    const t = tokens && tokens.access_token
    // 空白や日本語が混ざった値を fetch のヘッダに渡すと例外になり、「サーバーに接続できません」と誤って出る
    return typeof t === 'string' && /^[\x21-\x7e]+$/.test(t) ? t : null
  } catch (e) {
    return null
  }
}

/** storage のイベントが、エディタのログイン・ログアウトか（key が null は全部を消したとき）。 */
export function isEditorTokenEvent(e) {
  return !e || e.key === null || e.key === undefined || String(e.key).startsWith(KEY)
}
