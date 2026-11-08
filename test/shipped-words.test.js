'use strict'

// 配布物に、開発の経緯の語を残さない番人。読み手が持っていない文書の章番号や、作業の番号を説明に使っても、
// npm から入れた人には何も伝わらない。コメントでも文でも同じなので、ファイルの全文を見る。
//
// 見るのは package.json の files に書いたものの全部（ui/vendor は同梱の第三者のコードなので見ない）。
// files に足せば、ここも自動で見る。
//
// 実在の値はここに書かない（語の一覧そのものが機微になる）。実在の値は test/pack.test.js が、
// リポジトリの外の一覧で見る。
// 当たった文は出さず、ファイルと行だけを出す（試験の記録に本文を写さないため）。
//
// 戻すと落ちるもの: 下の語をコメントへ戻す・files の読み方を変えて 0 件にする・語の表から語を消す。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['vendor', 'node_modules'])

/** 開発の経緯の語。「契約」は電力の契約の意味で使うので、章番号が続くものだけを見る。 */
const WORDS = [
  /本人/,
  /本番/,
  /現場/,
  // プレビューは別の語
  /(?<!プ)レビュー/,
  /改訂 ?\d/,
  /契約 ?\d+(?:\.\d+| ?章)/,
  // 作業の段の名前と指摘の番号
  /\b[A-Z]-RV?\d/,
  /\bB-B\d-\d/,
  /\b(?:ADD|AUD|SEC|PUB|SPEC)-\d/,
  /コア担当/,
  // 配布しない手元の資料
  /実機確認メモ/,
  /bp35c0\.txt/,
]

/** docs/ の下を指す文字列（https://…/docs/… のように前に続きがあるものは除く）。 */
const DOCS_REF = /(?<![\w./-])docs\/([^\s)\]'"`、。）]+)/g

/** 配布しない文書への参照か。読み手の手元に無い文書を説明に使わない。 */
function citesMissingDoc(line, docsDir) {
  for (const m of line.matchAll(DOCS_REF)) {
    if (!fs.existsSync(path.join(docsDir, m[1]))) return true
  }
  return false
}

/** 語が当たる行の番号（1 から）。語は返さない。 */
function linesWithWords(text, docsDir) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (WORDS.some((w) => w.test(line)) || citesMissingDoc(line, docsDir)) out.push(i + 1)
  })
  return out
}

function walk(full) {
  if (!fs.statSync(full).isDirectory()) return [full]
  const out = []
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
    out.push(...walk(path.join(full, e.name)))
  }
  return out
}

function shippedFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const all = []
  for (const entry of pkg.files) all.push(...walk(path.join(ROOT, entry)))
  return all
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

test('語の表: 経緯の語に当たり、ふつうの言葉には当たらない', () => {
  const docsDir = path.join(ROOT, 'docs')
  const hits = [
    '本人の指示',
    '本番の画面',
    '現場で踏んだ',
    'レビュー #2',
    '改訂 5',
    '契約 13.2',
    '契約 8 章',
    'B-R7 #3',
    'A-RV5A-03',
    'B-B3-05',
    'ADD-03',
    'SEC-01',
    'コア担当',
    'docs/webui-api-v1.md',
    'docs/実機確認メモ.md',
    '(bp35c0.txt:708)',
  ]
  for (const s of hits) assert.deepEqual(linesWithWords(s, docsDir), [1], s)
  const plain = [
    'プレビューを出します',
    '電力の契約 2 台',
    '契約（電力・動力）',
    'docs/API.md を見てください',
    '[docs/FLOW.md](docs/FLOW.md)',
    '<https://nodered.org/docs/api/admin/oauth/>',
    'RS-WSUHA',
    'EUI-64',
  ]
  for (const s of plain) assert.deepEqual(linesWithWords(s, docsDir), [], s)
  assert.deepEqual(linesWithWords('1 行目\n2 行目\r\n本人\r\n', docsDir), [3], '行の番号を数え違えない')
})

test('見る対象: package.json の files の全部で、空振りしない', () => {
  const names = shippedFiles().map(rel)
  for (const f of ['lib/sequencer.js', 'lib/runtime/service.js', 'nodes/wsuha-device.js', 'nodes/wsuha-device.html', 'ui/strings.js', 'ui/styles/app.css', 'docs/API.md', 'examples/01-simulator.json', 'README.md', 'CHANGELOG.md']) {
    assert.ok(names.includes(f), f)
  }
  assert.ok(!names.some((f) => f.startsWith('ui/vendor/')), '同梱の第三者のコードは見ない')
})

test('配布物に開発の経緯の語が無い', () => {
  const docsDir = path.join(ROOT, 'docs')
  const found = []
  for (const file of shippedFiles()) {
    for (const line of linesWithWords(fs.readFileSync(file, 'utf8'), docsDir)) found.push(`${rel(file)}:${line}`)
  }
  assert.deepEqual(found, [], `開発の経緯の語が残っています（ファイル:行）。\n${found.join('\n')}`)
})

// 改行をまたぐ「」。1 行ずつ見る語の表では掛からない。書き手の言葉で書けば、引用符の中で改行する長さの文にはならない
const QUOTE_OVER_LINES = /「[^「」\n]*\n[^「」]*」/
// 文に出す（マニュアル n.n）。どのマニュアルかが読み手に分からない。コードのコメントの (マニュアル 3.4) は半角の括弧で書く
const MANUAL_IN_TEXT = /（マニュアル/

/** 配布物の .js のうち、文書の引用を持ち込まないかを見る分（同梱の第三者のコードは shippedFiles が外す）。 */
function shippedScripts() {
  return shippedFiles().filter((f) => /\.js$/.test(f))
}

test('語の表: 改行をまたぐ引用と、文の中のマニュアルの節に当たり、ふつうの書き方には当たらない', () => {
  assert.ok(QUOTE_OVER_LINES.test('// 超えると「以後の送信は\n// 取り消される」と書いてある'))
  assert.ok(!QUOTE_OVER_LINES.test('// 「開始」を押します\n// 「停止」を押します'))
  assert.ok(MANUAL_IN_TEXT.test("'設定を確かめてください（マニュアル 3.4）'"))
  assert.ok(!MANUAL_IN_TEXT.test('// 3 回で止める (マニュアル 3.4)'))
})

// 戻すと落ちるもの: lib/sequencer.js の _guardTxBudget の説明を引用に戻す・ログの文に（マニュアル n.n）を戻す
test('配布物の .js に、文書の文を引いた形が残っていない', () => {
  const quoted = []
  const cited = []
  for (const file of shippedScripts()) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    if (QUOTE_OVER_LINES.test(text)) quoted.push(rel(file))
    text.split('\n').forEach((line, i) => {
      if (MANUAL_IN_TEXT.test(line)) cited.push(`${rel(file)}:${i + 1}`)
    })
  }
  assert.deepEqual(quoted, [], '改行をまたぐ「」があるファイル')
  assert.deepEqual(cited, [], '（マニュアル がある行')
  assert.ok(shippedScripts().map(rel).includes('lib/sequencer.js'), '対象を取り違えて 0 件で通らない')
})
