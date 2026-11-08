// コメントに開発の経緯の語が戻らないことを見張る。配布物とリポジトリのコメントは、文書の章番号や作業の段名を知らない読み手が読む。
// 「なぜそうするか」だけを書き、章番号・段名・作業の記録は書かない。
//
// 見るのは配布物の lib/**・nodes/**・ui/**（vendor を除く）と、試験の test/** のファイルの全文。文字列も見る。
// 語の表そのものを持つ試験（このファイル・test/shipped-words.test.js・test/pack.test.js）は見ない。
// 「契約」は電力の契約の語でもあるので、数字が続くものだけを見る。
//
// 戻すと落ちるもの: 下の語をコメントへ戻す・HISTORY の語を減らす・対象のファイルを取り違えて 0 件で通る。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '../..')
const rel = (f) => path.relative(pkg, f).split(path.sep).join('/')

const HISTORY = [
  /本人/,
  /本番/,
  /レビュー/,
  /改訂\s*\d/,
  /契約\s*\d/,
  /\b[AB]-(?:RV?\d|B\d)/,
  /\b(?:UI|SEC|ADD|PUB|SPEC|AUD)-\d/,
  /[（。][CFS]\d{1,2}）/,
  /docs\//,
  /\d{4}-\d{2}-\d{2} (?:の|本人|Windows)/,
]

/** 文章に当たった語の一覧。 */
const hitsOf = (text) => HISTORY.filter((re) => re.test(text)).map(String)

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out)
    } else if (/\.(js|mjs|html|css)$/.test(e.name)) out.push(p)
  }
  return out
}

const WORD_TABLES = new Set([fileURLToPath(import.meta.url), path.join(pkg, 'test/shipped-words.test.js'), path.join(pkg, 'test/pack.test.js')])
const targets = ['lib', 'nodes', 'ui', 'test'].flatMap((d) => walk(path.join(pkg, d))).filter((f) => !WORD_TABLES.has(f))

test('対象のファイルが揃っている（取り違えて 0 件で通らない）', () => {
  const names = targets.map(rel)
  for (const f of ['lib/sequencer.js', 'lib/runtime/service.js', 'nodes/wsuha-device.js', 'nodes/wsuha-device.html', 'ui/strings.js', 'ui/styles/app.css', 'test/nodes/hold.test.js', 'test/ui/wording.test.mjs', 'test/sequencer.test.js', 'test/runtime/http-api.test.js']) {
    assert.ok(names.includes(f), f)
  }
  assert.ok(!names.some((f) => f.startsWith('ui/vendor/')), 'vendor は見ない')
  assert.ok(targets.length >= 150, String(targets.length))
})

test('開発の経緯の語が無い', () => {
  const found = []
  for (const f of targets) {
    fs.readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        const hit = hitsOf(line)
        if (hit.length) found.push(`${rel(f)}:${i + 1} ${hit.join(' ')}`)
      })
  }
  assert.deepEqual(found, [])
})

test('負の対照: 経緯の語を見つけ、電力の契約の語は通す', () => {
  for (const s of ['本人の指示', '本番のフロー', 'レビュー #12', '改訂 5', '契約 13.2', '契約 9 章', 'B-R5B-02', 'A-R4A-01', 'B-B3-01', 'UI-05', 'SEC-01', '（C11）', '（同じ案内。C18）', 'docs/webui-api-v1.md', '2026-11-07 のコードレビュー']) {
    assert.ok(hitsOf(s).length > 0, s)
  }
  for (const s of ['契約のバッジ', '名前 → 契約 → ポート', '電力の契約', 'E7 と E8']) assert.deepEqual(hitsOf(s), [], s)
})
