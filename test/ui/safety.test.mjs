// ui/ の番人: 値を HTML として描かない・外部を読まない・文言は strings.js だけ・import が全部たどれる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { S } from '../../ui/strings.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ui = path.resolve(here, '../../ui')

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'vendor') out.push(...walk(p))
    } else out.push(p)
  }
  return out
}

const files = walk(ui)
const jsFiles = files.filter((f) => f.endsWith('.js'))
const rel = (f) => path.relative(ui, f).split(path.sep).join('/')

/** コメントを外す（文字列の中の // は ui/ のコードに無い前提。あれば番人を直す）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1')
}

test('対象のファイルがある（空振りしない）', () => {
  assert.ok(jsFiles.length >= 20, String(jsFiles.length))
  assert.ok(jsFiles.some((f) => rel(f) === 'app.js'))
})

test('値を HTML として描く API・eval を使わない', () => {
  const bad = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write|\beval\s*\(|new\s+Function\s*\(/
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    assert.equal(bad.test(src), false, rel(f) + ': ' + (src.match(bad) || [])[0])
  }
})

test('style 属性を使わない（CSP の style-src self）・外部の URL を読まない', () => {
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    assert.equal(/\sstyle=/.test(src), false, rel(f) + ' に style 属性')
    assert.equal(/https?:\/\//.test(src), false, rel(f) + ' に外部の URL')
  }
})

test('日本語の文言は strings.js だけに書く（コメントは除く）', () => {
  const ja = /[぀-ヿ㐀-鿿！-｠]/
  for (const f of jsFiles) {
    if (rel(f) === 'strings.js') continue
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n')
    const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => ja.test(l))
    assert.deepEqual(hits, [], rel(f))
  }
})

// 画面は独自のログインを持たない（フォーム・dev ログイン・トークンの保存・ログアウトを作らない）。
// エディタのトークンは借りるだけで、読むのは ui/editor-token.js の 1 か所。読む場所が増えると、store や画面に写す穴が増える。
// 戻すと落ちるもの: ui/auth.js や components/login.js を戻す・api.js に Authorization を戻す・ほかのファイルで auth-tokens を読む。
const LOGIN_REMNANTS = /\bAuthorization\b|\bBearer\b|auth\/token|auth\/revoke|auth\/login|wsuha-broute-dev|onUnauthorized|getToken|logout|wsuha-broute:(?!theme'|more:)/i
const EDITOR_TOKEN_READS = /access_token|auth-tokens/i
const TOKEN_FILE = 'editor-token.js'

test('ログインの名残が無い（ファイル・トークンの送信と保存・dev ログイン・ログアウト）', () => {
  assert.equal(fs.existsSync(path.join(ui, 'auth.js')), false, 'ui/auth.js')
  assert.equal(fs.existsSync(path.join(ui, 'components', 'login.js')), false, 'ui/components/login.js')
  const hits = []
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const m = src.match(LOGIN_REMNANTS)
    if (m) hits.push(rel(f) + ': ' + m[0])
  }
  assert.deepEqual(hits, [])
  // 「ログイン」の文言は、Node-RED の認証の案内（S.auth と追加の失敗の見出し）だけ。ログアウトは画面に無い
  const strings = stripComments(fs.readFileSync(path.join(ui, 'strings.js'), 'utf8'))
  assert.equal(/ログアウト/.test(strings), false)
  // core.autocrlf=true の Windows で取り出すと、ファイルは CRLF になる
  const rest = strings.replace(/\r?\n  auth: \{[\s\S]*?\r?\n  \},\r?\n/, '\n').replace(/\r?\n\s*LOGIN_REQUIRED: .*\r?\n/, '\n')
  assert.notEqual(rest, strings, 'S.auth を外せていない')
  assert.equal(/ログイン/.test(rest), false)
})

test('エディタのトークンを読むのは ui/editor-token.js だけ', () => {
  const hits = []
  for (const f of jsFiles) {
    if (rel(f) === TOKEN_FILE) continue
    const m = stripComments(fs.readFileSync(f, 'utf8')).match(EDITOR_TOKEN_READS)
    if (m) hits.push(rel(f) + ': ' + m[0])
  }
  assert.deepEqual(hits, [])
  // 読むだけで、書き換えない（ログイン・ログアウトはエディタの仕事）
  const src = stripComments(fs.readFileSync(path.join(ui, TOKEN_FILE), 'utf8'))
  assert.ok(EDITOR_TOKEN_READS.test(src), TOKEN_FILE + ' が読んでいない')
  assert.equal(/\.(set|remove|setItem|removeItem)\s*\(/.test(src), false)
})

test('負の対照: 番人は Authorization とトークンの鍵を見つける', () => {
  assert.equal(LOGIN_REMNANTS.test("headers.Authorization = 'Bearer ' + t"), true)
  assert.equal(LOGIN_REMNANTS.test("storage.get('wsuha-broute:token')"), true)
  assert.equal(LOGIN_REMNANTS.test("export const THEME_KEY = 'wsuha-broute:theme'"), false)
  assert.equal(EDITOR_TOKEN_READS.test("storage.get('auth-tokens')"), true)
  assert.equal(EDITOR_TOKEN_READS.test('tokens.access_token'), true)
})

test('負の対照: 番人はコメントの外の日本語と innerHTML を見つける', () => {
  const ja = /[぀-ヿ㐀-鿿]/
  assert.equal(ja.test(stripComments("// 説明\nconst a = 'x'")), false)
  assert.equal(ja.test(stripComments("const a = '直書き'")), true)
  assert.equal(/\binnerHTML\b/.test(stripComments('el.innerHTML = v // innerHTML')), true)
})

test('strings.js: ASCII の ... と、文の終わりの半角の ? を使わない', () => {
  const src = fs.readFileSync(path.join(ui, 'strings.js'), 'utf8')
  assert.equal(src.includes('...'), false)
  assert.equal(/\?['`]/.test(src), false)
})

test('コンポーネントが参照する S.* がすべて strings.js にある', () => {
  const missing = []
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/\bS((?:\.[A-Za-z_$][\w$]*)+)/g)) {
      let v = S
      for (const k of m[1].slice(1).split('.')) v = v === undefined || v === null ? undefined : v[k]
      if (v === undefined) missing.push(`${rel(f)}: S${m[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})

// ---- import のつながり ----------------------------------------------------------

function importsOf(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
}

test('import は相対で、指す先のファイルがある。app.js から全部の .js にたどり着く', () => {
  const seen = new Set()
  const stack = [path.join(ui, 'app.js')]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    if (f.includes(`${path.sep}vendor${path.sep}`)) continue
    for (const spec of importsOf(f)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${rel(f)}: ${spec}`)
      const target = path.resolve(path.dirname(f), spec)
      assert.ok(fs.existsSync(target), `${rel(f)}: ${spec} が無い`)
      stack.push(target)
    }
  }
  const orphans = jsFiles.filter((f) => !seen.has(f) && rel(f) !== 'theme-init.js')
  assert.deepEqual(orphans.map(rel), [])
})

test('すべてのモジュールを Node で読み込める（構文と import のつながり）', async () => {
  for (const f of jsFiles) {
    if (rel(f) === 'theme-init.js') continue
    await import(pathToFileURL(f).href)
  }
})

test('index.html: 参照するファイルがあり、インラインのスクリプト・style 属性・外部の URL が無い', () => {
  const src = fs.readFileSync(path.join(ui, 'index.html'), 'utf8')
  const refs = [...src.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
  assert.ok(refs.length >= 5)
  for (const r of refs) assert.ok(fs.existsSync(path.join(ui, r)), r)
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(src), false, 'インラインのスクリプト')
  assert.equal(/\sstyle=/.test(src), false)
  assert.equal(/<style/.test(src), false)
  assert.equal(/https?:\/\//.test(src), false)
  // テーマは初回描画の前（モジュールより先の同期スクリプト）
  assert.ok(src.indexOf('theme-init.js') < src.indexOf('app.js'))
  assert.equal(/<script src="theme-init.js"[^>]*(defer|async|type="module")/.test(src), false)
})

// Chrome の datalist は今の値に合う候補しか出さず、「動力」を選べなかった。選ぶ項目は select にする。
// 戻すと落ちるもの: ui/ か nodes/ の入力欄を list= と datalist に戻す
// Preact は DOM に同名のプロパティがあると代入する。el.spellcheck = "false" は文字列なので true になり、
// 認証 ID の欄までスペルチェックが効く。偽の DOM では属性の文字列しか見えないので、ソースで見張る。
// 戻すと落ちるもの: spellcheck="false" や autocorrect="off" を部品へ戻す
test('真偽のプロパティに文字列を渡さない（spellcheck・autocorrect は式で渡す）', () => {
  const bad = []
  for (const f of jsFiles) {
    if (/\b(?:spellcheck|autocorrect)="/.test(fs.readFileSync(f, 'utf8'))) bad.push(rel(f))
  }
  assert.deepEqual(bad, [])
  const uses = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('')
  assert.ok(uses.split('spellcheck=${false}').length - 1 >= 10, '入力欄の全部に付いている')
  // 認証 ID の欄は、自動修正も止める
  assert.ok(uses.split('autocorrect=${false}').length - 1 >= 2)
})

test('選ぶ項目に datalist を使わない（画面とエディタ）', () => {
  const nodes = path.resolve(ui, '../nodes')
  const editors = fs.readdirSync(nodes).filter((n) => n.endsWith('.html')).map((n) => path.join(nodes, n))
  assert.ok(editors.length >= 2, '空振りしない')
  const uses = (src) => /<datalist\b/.test(src) || /<input\b[^>]*\slist=/.test(src)
  for (const f of jsFiles.concat(editors)) assert.equal(uses(stripComments(fs.readFileSync(f, 'utf8'))), false, f)
  assert.equal(uses('<input type="text" list="x" />'), true, '負の対照: 番人は見つける')
  assert.equal(uses('<datalist id="x"></datalist>'), true, '負の対照: 番人は見つける')
})
