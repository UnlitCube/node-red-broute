// 言い回しの番人。用語の揺れは人の目では漏れて積み上がるので、使わない語を機械で落とす。
// 見るのは利用者に届く文だけ: ui/strings.js・nodes/*.html（ヘルプと画面）・lib/**/*.js の文字列・README.md。
// コメントは見ない（コメントの開発の経緯の語は shipped-comments.test.mjs が見る）。
//
// 戻すと落ちるもの: 下の語を文へ戻す・strings.js に参照の無いキーを足す・対象のファイルを取り違えて 0 件にする。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S } from '../../ui/strings.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '../..')
const rel = (f) => path.relative(pkg, f).split(path.sep).join('/')

function walk(dir, ext) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'vendor' && e.name !== 'node_modules') out.push(...walk(p, ext))
    } else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

/**
 * JS のコメントを空白にする（行番号を保つ）。文字列とテンプレートの中の // は残す。
 * 正規表現リテラルの中の引用符で読み違えないよう、' と " は行の終わりで閉じたことにする。
 */
export function stripJsComments(src) {
  let out = ''
  let i = 0
  let mode = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      }
      i++
    } else if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        i += 2
      } else {
        if (c === '\n') out += c
        i++
      }
    } else if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line'
        i += 2
      } else if (c === '/' && n === '*') {
        mode = 'block'
        i += 2
      } else {
        if (c === "'" || c === '"' || c === '`') mode = c
        out += c
        i++
      }
    } else {
      out += c
      if (c === '\\') {
        out += n === undefined ? '' : n
        i += 2
        continue
      }
      if (c === mode || (c === '\n' && mode !== '`')) mode = 'code'
      i++
    }
  }
  return out
}

/** HTML のコメントと、スクリプトの中の JS のコメントを空白にする（ヘルプの本文は残す）。 */
export function stripHtmlComments(src) {
  const noHtml = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
  return noHtml.replace(/(<script\b[^>]*type="text\/javascript"[^>]*>)([\s\S]*?)(<\/script>)/g, (_, a, body, b) => a + stripJsComments(body) + b)
}

const targets = [
  { file: path.join(pkg, 'ui/strings.js'), strip: stripJsComments, screen: true },
  ...walk(path.join(pkg, 'nodes'), '.html').map((file) => ({ file, strip: stripHtmlComments, screen: true })),
  ...walk(path.join(pkg, 'lib'), '.js').map((file) => ({ file, strip: stripJsComments, screen: false })),
  { file: path.join(pkg, 'README.md'), strip: (s) => s, screen: false },
  ...walk(path.join(pkg, 'docs'), '.md').map((file) => ({ file, strip: (s) => s, screen: false })),
]

/** どの文にも使わない語。 */
const BANNED = [
  { word: /B ルート認証情報/, use: '「B ルートの認証 ID とパスワード」か、短くは「認証情報」' },
  { word: /シミュレータ(?!ー)/, use: '「シミュレーター」' },
  { word: /定期取得/, use: '「定期的に取りに行く値」' },
  // パレットの検索で見つからない例として「Bルート」を挙げるヘルプの 1 文だけは、語の説明なので通す
  { word: /Bルート(?!」では見つかりません)/, use: '「B ルート」（和欧間に空白）' },
  { word: /不明なEPC/, use: '「不明な EPC」' },
  { word: /繋/, use: '「つなぐ」' },
  { word: /スマホ/, use: '「スマートフォン」' },
  { word: /ボーレート/, use: '「通信速度」' },
  { word: /32 桁の英数字/, use: '「32 桁の 16 進数（0〜9・A〜F）」' },
  { word: /つなぎ方/, use: '「接続先」' },
  { word: /スキャン時間/, use: '「スキャンの段階」' },
  { word: /デプロイ後に自動で開始/, use: '「自動で始める」' },
  { word: /詳細な設定/, use: '「詳細設定」' },
  { word: /ヘッダ(?!ー)/, use: '「ヘッダー」' },
  { word: /カウンタ(?!ー)/, use: '「カウンター」' },
  { word: /疎通/, use: '「通信を確かめる」' },
  { word: /足[すしせ]/, use: '「追加」' },
  { word: /の守り/, use: '「保護」' },
  // 実在のホスト名。この試験のソースにも書かないよう、分けて組み立てる
  { word: new RegExp(['wsuha', 'pi'].join('-')), use: '実在のホスト名は書かない' },
]
/** 画面とエディタの文だけで使わない語（README の「ファイルの構成」は別の意味なので見ない）。 */
const BANNED_ON_SCREEN = [{ word: /構成/, use: '「アダプタと接続」' }]

/** 文の中の使わない語を「行番号: 語 → 使う語」で返す。 */
export function findBanned(text, rules) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const r of rules) {
      const m = line.match(r.word)
      if (m) hits.push(`${i + 1}: ${m[0]} → ${r.use}`)
    }
  })
  return hits
}

test('対象のファイルがある（空振りしない）', () => {
  const names = targets.map((t) => rel(t.file))
  for (const f of ['ui/strings.js', 'nodes/wsuha-device.html', 'nodes/wsuha-broute.html', 'lib/sequencer.js', 'lib/runtime/view-model.js', 'README.md']) {
    assert.ok(names.includes(f), f)
  }
  assert.ok(targets.length >= 15, String(targets.length))
  for (const t of targets) assert.ok(t.strip(fs.readFileSync(t.file, 'utf8')).length > 0, rel(t.file))
})

test('使わない語が文に無い（ui/strings.js・nodes/*.html・lib/**/*.js の文字列・README.md）', () => {
  const hits = []
  for (const t of targets) {
    const text = t.strip(fs.readFileSync(t.file, 'utf8'))
    const rules = t.screen ? BANNED.concat(BANNED_ON_SCREEN) : BANNED
    for (const h of findBanned(text, rules)) hits.push(rel(t.file) + ':' + h)
  }
  assert.deepEqual(hits, [])
})

test('負の対照: 番人は語を見つけ、コメントの中は見ない', () => {
  assert.equal(findBanned("const a = 'B ルート認証情報'", BANNED).length, 1)
  assert.equal(findBanned("const a = 'シミュレータ'", BANNED).length, 1)
  assert.equal(findBanned("const a = 'シミュレーター'", BANNED).length, 0, '長音を付ければ通る')
  assert.equal(findBanned('定期取得の値を繋ぐ', BANNED).length, 2)
  assert.equal(findBanned('ボーレートと詳細な設定', BANNED).length, 2)
  assert.equal(findBanned('「Bルート計測」のタブ', BANNED).length, 1)
  assert.equal(findBanned('空白の無い「Bルート」では見つかりません', BANNED).length, 0)
  assert.equal(findBanned('構成', BANNED).length, 0, '「構成」は画面の文だけ')
  assert.equal(findBanned('構成', BANNED_ON_SCREEN).length, 1)
  assert.equal(findBanned(stripJsComments('// 定期取得\n/* 定期取得 */\nconst a = 1'), BANNED).length, 0)
  assert.equal(findBanned(stripJsComments("const a = 'http://x/定期取得'"), BANNED).length, 1, '文字列の中の // はコメントではない')
  assert.equal(findBanned(stripJsComments('const a = `x\n// 定期取得\n`'), BANNED).length, 1, 'テンプレートの中の // はコメントではない')
  assert.equal(findBanned(stripJsComments("const r = /['\"]/\nconst b = 1 // 定期取得\nconst a = '定期取得'"), BANNED).length, 1, '正規表現の引用符のあとの行を読み違えない')
  assert.equal(findBanned(stripHtmlComments('<!-- 構成 --><p>本文</p>'), BANNED_ON_SCREEN).length, 0)
  assert.equal(findBanned(stripHtmlComments('<script type="text/javascript">// 構成\nconst a = 1</script>'), BANNED_ON_SCREEN).length, 0)
  assert.equal(findBanned(stripHtmlComments('<script type="text/html"><p>構成</p></script>'), BANNED_ON_SCREEN).length, 1, 'ヘルプの本文は見る')
})

// 誰も参照しない文言は、言い回しを直すときの手間だけを増やし、古い語の逃げ場になる。
// 2 段目のキーだけを見る。health と 3 段目は状態の名前などで動的に引く辞書なので、参照を文字列では追えない。
const DYNAMIC_SECTIONS = ['health']

function uiSources() {
  return walk(path.join(pkg, 'ui'), '.js')
    .filter((f) => rel(f) !== 'ui/strings.js')
    .map((f) => stripJsComments(fs.readFileSync(f, 'utf8')))
    .join('\n')
}

export function unusedKeys(strings, src) {
  const out = []
  for (const [section, value] of Object.entries(strings)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || DYNAMIC_SECTIONS.includes(section)) continue
    for (const [key, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) continue
      if (!new RegExp(`\\bS\\.${section}\\.${key}(?![\\w$])`).test(src)) out.push(`S.${section}.${key}`)
    }
  }
  return out
}

test('strings.js の文言は全部どこかで使っている', () => {
  assert.deepEqual(unusedKeys(S, uiSources()), [])
})

test('負の対照: 参照の無いキーを見つける。辞書と別のセクションの同じ名前には惑わされない', () => {
  const strings = { values: { propList: '一覧', fresh: '最新', ranges: { '1h': '1 時間' } }, health: { ok: '計測中' } }
  assert.deepEqual(unusedKeys(strings, 'S.values.fresh S.settings.propList S.values.propListX'), ['S.values.propList'])
})
