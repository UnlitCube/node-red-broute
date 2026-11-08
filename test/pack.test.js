'use strict'

// 配布物（npm pack）と、npm のページと読み込みの「サンプル」にそのまま出るもの
// （README・CHANGELOG・docs・examples・LICENSE）を確かめる。
// 文書は実装と別に腐るので、実装の側から機械で確かめられるものは確かめる。
//
// パッケージだけを別のリポジトリへ載せても流れるよう、git には頼らない。
// git の無視の設定をリポジトリごと確かめる試験は、それぞれのリポジトリの側に置く。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PKG = path.resolve(__dirname, '..')

const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8')
const pkg = () => JSON.parse(read('package.json'))

let packedCache = null
function packedFiles() {
  if (packedCache) return packedCache
  // Windows の npm は npm.cmd。shell を通さずに呼ぶため、node から npm-cli.js を探さずに shell: true で呼ぶ
  const out = execFileSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: PKG, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'],
  })
  packedCache = JSON.parse(out)[0].files.map((f) => f.path)
  return packedCache
}

// ---------------------------------------------------------------------------
//  配布物の一覧と package.json
// ---------------------------------------------------------------------------

test('配布物に LICENSE・通知・docs・examples が入り、test は入らない', { timeout: 60000 }, () => {
  const files = packedFiles()
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CHANGELOG.md', 'docs/API.md', 'docs/FLOW.md', 'docs/DEVELOPMENT.md',
    'examples/01-simulator.json', 'examples/02-real-adapter.json', 'examples/03-alert-and-settings.json',
    'lib/runtime/credentials-store.js', 'ui/vendor/LICENSES/preact-LICENSE.txt', 'ui/vendor/LICENSES/htm-LICENSE.txt']) {
    assert.ok(files.includes(f), `配布物に ${f} がありません`)
  }
  const tests = files.filter((f) => f.startsWith('test/'))
  assert.deepEqual(tests, [], '試験は配布物に入れない')
})

test('リポジトリの設定のファイルは配布物に入らない', { timeout: 60000 }, () => {
  const dots = packedFiles().filter((f) => f.split('/').some((part) => part.startsWith('.')))
  assert.deepEqual(dots, [], 'ドットファイルは配布物に入れない')
})

test('package.json: 確かめた版と、serialport の入れ方', () => {
  const p = pkg()
  assert.equal(p['node-red'].version, '>=3.1.0', 'node-red.version は確かめた範囲に合わせる')
  assert.equal(p.engines.node, '>=18')
  // peer の optional は npm が入れない。パレットから入れただけでは実機につながらなかった
  assert.equal(p.optionalDependencies && p.optionalDependencies.serialport, '^12.0.0', 'serialport は任意の依存の ^12（^13 は Node 18 で入らない）')
  assert.equal(p.peerDependencies, undefined, 'peerDependencies に serialport を戻さない')
  assert.equal(p.peerDependenciesMeta, undefined)
  assert.ok(p.description.includes('tested with RATOC RS-WSUHA'), '確かめたアダプタを超えて対応を名乗らない')
  assert.ok(!/other BP35C0/i.test(p.description))
})

test('npm test: 引用したグロブに頼らず、全部の層のファイルを流す', () => {
  const p = pkg()
  // 引用したグロブを Node が展開するのは Node 21 以降。engines の下限の 18 では止まる
  assert.ok(!/\*/.test(p.scripts.test), `npm test にグロブがあります: ${p.scripts.test}`)
  const list = execFileSync(process.execPath, ['test/run-all.js', '--list'], { cwd: PKG, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
  const walk = (dir) => fs.readdirSync(path.join(PKG, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) return walk(rel)
    return /\.test\.m?js$/.test(e.name) ? [rel] : []
  })
  assert.deepEqual(list, walk('test').sort(), 'test/ の下の試験が全部流れる')
  for (const layer of ['test/runtime/', 'test/nodes/', 'test/ui/']) {
    assert.ok(list.some((f) => f.startsWith(layer)), `${layer} の試験が流れていません`)
  }
})

test('npm test: 全体の上限を過ぎたら、止めて失敗を返す', () => {
  // Node 18 には試験の時間の上限の引数が無い。止まったままにせず、赤で終わること
  const r = spawnSync(process.execPath, ['test/run-all.js', 'line-splitter', '--limit-ms=1'], { cwd: PKG, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /終わらないので止めました/)
})

// ---------------------------------------------------------------------------
//  パッケージだけを別のリポジトリへ載せるとき
// ---------------------------------------------------------------------------

test('.gitattributes: 同梱の部品の改行を git に変えさせない', () => {
  // core.autocrlf=true の Windows で取り出すと、部品のバイトが変わって VERSIONS.json の sha256 と合わなくなる
  const rules = read('.gitattributes').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
  assert.ok(rules.includes('ui/vendor/** -text'), `ui/vendor の -text がありません: ${rules.join(' / ')}`)
})

test('.gitignore: 秘密は名前を絞って無視し、パッケージのソースと試験に当てない', () => {
  // credentials* の広い形は lib/runtime/credentials-store.js まで無視して、取り出した版が読み込めなくなる
  const rules = read('.gitignore').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
  for (const r of ['node_modules/', '*.tgz', '*.log', '.env', '.env.*']) assert.ok(rules.includes(r), `.gitignore に ${r} がありません`)
  assert.ok(!rules.some((r) => /credentials/i.test(r)), 'credentials の語を無視の規則に使わない')
})

// ---------------------------------------------------------------------------
//  ライセンスと第三者の通知
// ---------------------------------------------------------------------------

test('LICENSE は MIT の全文で、package.json と合う', () => {
  const t = read('LICENSE')
  assert.equal(pkg().license, 'MIT')
  assert.match(t, /^MIT License/)
  assert.match(t, /Copyright \(c\) 2026 UnlitCube/)
  assert.match(t, /Permission is hereby granted, free of charge/)
  assert.match(t, /THE SOFTWARE IS PROVIDED "AS IS"/)
})

test('THIRD_PARTY_NOTICES は、同梱の版とライセンスに合う', () => {
  const v = JSON.parse(read('ui/vendor/VERSIONS.json'))
  const notices = read('THIRD_PARTY_NOTICES.md')
  const rows = notices.split(/\r?\n/).filter((l) => l.startsWith('|'))
  for (const [file, f] of Object.entries(v.files)) {
    assert.ok(rows.some((r) => r.includes(`ui/vendor/${file}`) && r.includes(`| ${f.version} |`) && r.includes(`| ${f.license} |`)),
      `${file}（${f.package} ${f.version}・${f.license}）が表と合いません`)
    if (f.changes.length) assert.ok(notices.includes(`\`ui/vendor/${file}\`: `) && !notices.includes(`\`ui/vendor/${file}\`: 改変していません`), `${file} の改変が書かれていません`)
    else assert.ok(notices.includes(`\`ui/vendor/${file}\`: 改変していません`), `${file} は改変していないと書く`)
  }
  for (const rel of Object.values(v.licenses)) {
    assert.ok(notices.includes(`ui/vendor/${rel}`), `許諾文の場所 ${rel} が書かれていません`)
    assert.ok(fs.existsSync(path.join(PKG, 'ui/vendor', rel)), `${rel} がありません`)
  }
})

test('THIRD_PARTY_NOTICES の著作権の表示は、許諾文の著作権者と同じ', () => {
  const notices = read('THIRD_PARTY_NOTICES.md')
  const copyright = (rel) => {
    const lines = read(rel).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^Copyright (\(c\) )?\d/.test(l))
    return lines[lines.length - 1]
  }
  const htm = copyright('ui/vendor/LICENSES/htm-LICENSE.txt')
  assert.ok(htm, '前提: htm の許諾文に著作権の行がある')
  assert.ok(notices.includes(`- htm: ${htm}`), `通知に htm の著作権者がありません: ${htm}`)
})

// ---------------------------------------------------------------------------
//  例（読み込みの「サンプル」に出る）
// ---------------------------------------------------------------------------

const EXAMPLE_TYPES = new Set(['tab', 'comment', 'inject', 'debug', 'switch', 'catch', 'wsuha-device', 'wsuha-broute'])
const NODE_KEYS = new Set(['id', 'type', 'z', 'x', 'y', 'wires'])

function examples() {
  return fs.readdirSync(path.join(PKG, 'examples')).filter((f) => f.endsWith('.json')).sort()
}

/** nodes/*.html の registerType の defaults の項目名（例の項目は、エディタが読み書きするものと同じにする）。 */
function editorDefaults(file) {
  // CRLF の HTML でも同じ位置で読めるよう、改行をそろえてから探す
  const html = read(file).replace(/\r\n/g, '\n')
  const start = html.indexOf('defaults: {')
  assert.ok(start >= 0, `${file} に defaults がありません`)
  const open = html.indexOf('{', start)
  const line = html.lastIndexOf('\n', start)
  const indent = start - line - 1
  const end = html.indexOf(`\n${' '.repeat(indent)}}`, open)
  const body = html.slice(open, end)
  const re = new RegExp(`^ {${indent + 2}}(\\w+): \\{`, 'gm')
  return [...body.matchAll(re)].map((m) => m[1])
}

test('例は 3 本あり、名前は ASCII', () => {
  assert.deepEqual(examples(), ['01-simulator.json', '02-real-adapter.json', '03-alert-and-settings.json'])
  for (const f of examples()) assert.match(f, /^[\x21-\x7e]+$/)
})

test('例: 読み込める形で、認証情報と実在の値を持たない', () => {
  const deviceKeys = editorDefaults('nodes/wsuha-device.html').sort()
  const brouteKeys = editorDefaults('nodes/wsuha-broute.html').sort()
  assert.ok(deviceKeys.includes('simulatorOptions') && brouteKeys.includes('device'), '前提: defaults を読めている')

  for (const f of examples()) {
    const text = read(`examples/${f}`)
    const nodes = JSON.parse(text)
    assert.ok(Array.isArray(nodes) && nodes.length > 2, `${f} はノードの配列`)
    const ids = new Set(nodes.map((n) => n.id))
    assert.equal(ids.size, nodes.length, `${f}: id が重なっています`)
    assert.ok(!/credentials|routeBId|routeBPassword/.test(text), `${f}: 認証情報の項目を持たない`)
    // 認証 ID のような 32 桁と、MAC のような 16 桁の 16 進数を書かない
    assert.ok(!/\b[0-9A-Fa-f]{32}\b|\b[0-9A-F]{16}\b/.test(text), `${f}: 認証 ID や MAC のような値があります`)
    assert.ok(!/by-id\/|\/dev\/tty[A-Z]+\d/.test(text), `${f}: 特定の機器のポートを書かない`)

    for (const n of nodes) {
      assert.ok(EXAMPLE_TYPES.has(n.type), `${f}: 型 ${n.type} はこのパッケージとコアの型ではありません`)
      if (n.z !== undefined) assert.ok(nodes.some((t) => t.id === n.z && t.type === 'tab'), `${f}: ${n.id} の z が切れています`)
      for (const w of (n.wires || []).flat()) assert.ok(ids.has(w), `${f}: ${n.id} の配線先 ${w} がありません`)
      if (n.type === 'wsuha-device') {
        assert.equal(n.z, undefined, `${f}: 設定ノードに z を付けない`)
        assert.equal(n.simulatorOptions, '', `${f}: simulatorOptions に値を書かない（シミュレーターは架空の既定で動く）`)
        assert.equal(n.serialport, '', `${f}: ポートは空にして、読み込んだ人が選ぶ`)
        assert.deepEqual(Object.keys(n).filter((k) => !NODE_KEYS.has(k)).sort(), deviceKeys, `${f}: 設定ノードの項目がエディタの defaults と違います`)
      }
      if (n.type === 'wsuha-broute') {
        assert.ok(nodes.some((d) => d.id === n.device && d.type === 'wsuha-device'), `${f}: B ルートノードの device が切れています`)
        assert.deepEqual(Object.keys(n).filter((k) => !NODE_KEYS.has(k)).sort(), brouteKeys, `${f}: B ルートノードの項目がエディタの defaults と違います`)
        assert.equal(n.wires.length, 2, `${f}: B ルートノードの出力は 2 つ`)
      }
    }
  }
})

test('例: 01 と 03 はシミュレーター、02 は実機', () => {
  const dev = (f) => JSON.parse(read(`examples/${f}`)).find((n) => n.type === 'wsuha-device')
  assert.equal(dev('01-simulator.json').mode, 'simulator')
  assert.equal(dev('03-alert-and-settings.json').mode, 'simulator')
  assert.equal(dev('02-real-adapter.json').mode, 'serial')
  // 03 は、README の説明どおりの操作を inject から送る
  const topics = JSON.parse(read('examples/03-alert-and-settings.json')).filter((n) => n.type === 'inject').map((n) => n.topic)
  for (const t of ['settings', 'settings-reset', 'diag', 'detail', 'read']) assert.ok(topics.includes(t), `03 に ${t} の inject がありません`)
})

// ---------------------------------------------------------------------------
//  CHANGELOG
// ---------------------------------------------------------------------------

/** リリースの本文を切り出すのと同じ規則。見出しが無くても本文が空でも空文字を返す。 */
function changelogSection(text, version) {
  const wanted = version.replace(/^v/, '')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => {
    const m = /^##\s+v?(\S+)/.exec(l)
    return m && m[1].replace(/^v/, '') === wanted
  })
  if (start < 0) return ''
  const body = []
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break
    body.push(l)
  }
  return body.join('\n').trim()
}

test('CHANGELOG: 見出しの形がそろい、今の版を切り出せる', () => {
  const t = read('CHANGELOG.md')
  const heads = t.split(/\r?\n/).filter((l) => l.startsWith('## '))
  assert.equal(heads[0], '## vNext', '先頭は ## vNext（消さない）')
  for (const h of heads.slice(1)) {
    assert.match(h, /^## v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)? \(\d{4}-\d{2}-\d{2}\)$/, `見出しの形が違います（半角括弧と v）: ${h}`)
  }
  const version = pkg().version
  assert.ok(heads.some((h) => h.startsWith(`## v${version} (`)), `${version} の見出しがありません`)
  assert.notEqual(changelogSection(t, version), '', `${version} の節を切り出せません`)
  assert.equal(changelogSection('# 履歴\n\n## vNext\n\n## v1.0.0 (2026-01-01)\n- あ\n', 'vNext'), '', '前提: 空の節は空文字')
  assert.equal(changelogSection('## 1.0.0（2026-01-01）\n- あ\n', '1.0.0'), '', '前提: 全角括弧の見出しは切り出せない')
})

test('CHANGELOG: 動作が変わる変更が、いちばん新しい節（vNext が空なら最新の版）の先頭にある', () => {
  const log = read('CHANGELOG.md')
  let v = changelogSection(log, 'vNext')
  if (!v.trim()) {
    const m = log.match(/^## v(\d+\.\d+\.\d+(?:-[\w.]+)?) \(\d{4}-\d{2}-\d{2}\)$/m)
    assert.ok(m, '版の見出しが「## vX.Y.Z (YYYY-MM-DD)」の形')
    assert.equal(m[1], require('../package.json').version, '最新の版の見出しは package.json の版')
    v = changelogSection(log, 'v' + m[1])
  }
  assert.match(v, /^### ⚠ 動作が変わる変更/)
  for (const w of ['adminAuth', 'X-Wsuha-Editor-Token', 'X-Wsuha-Radio', 'serialport', '3.1', 'allowAnonymousWrites', 'event', 'wiring']) {
    assert.ok(v.includes(w), `vNext に ${w} の変更がありません`)
  }
})

// ---------------------------------------------------------------------------
//  README と docs
// ---------------------------------------------------------------------------

const PUBLIC_DOCS = ['README.md', 'CHANGELOG.md', 'docs/API.md', 'docs/FLOW.md', 'docs/DEVELOPMENT.md', 'THIRD_PARTY_NOTICES.md']

test('文書の相対リンクは、配布物の中のファイルを指す', { timeout: 60000 }, () => {
  const files = new Set(packedFiles())
  for (const doc of PUBLIC_DOCS) {
    for (const m of read(doc).matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
      const target = decodeURIComponent(m[1].split('#')[0])
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc), target))
      assert.ok(files.has(rel), `${doc} のリンク ${m[1]} の先が配布物にありません`)
    }
  }
})

test('文書に開発の経緯と内部の語を書かない', () => {
  const internal = /改訂\s*\d|契約\s*\d|レビュー|本番|本人|現場|この環境で実測|この開発サーバ|Zabbix|PANA/
  const wording = /シミュレータ(?!ー)|ユーザ(?!ー)|ブラウザ(?!ー)/
  for (const doc of PUBLIC_DOCS) {
    read(doc).split(/\r?\n/).forEach((line, i) => {
      assert.ok(!internal.test(line), `${doc}:${i + 1} に内部の語があります`)
      assert.ok(!wording.test(line), `${doc}:${i + 1} の長音が用語の決まりと違います`)
    })
  }
})

test('README: 認証の説明が今の動きと合う', () => {
  const t = read('README.md')
  for (const old of ['**ログインはありません**', 'Web UI にはログインがありません', 'ログインが無いので', 'この Web UI には関係しません', 'optional peer', 'エディタと同じく誰でも変更できます', 'Web UI の変更だけを許す']) {
    assert.ok(!t.includes(old), `古い説明が残っています: ${old}`)
  }
  assert.ok(t.includes('Node-RED に認証（`adminAuth`）があるサーバーでは、Web UI からの変更にはエディタのログインが要ります'))
  assert.ok(t.includes('読める人を限るのは、Node-RED の `httpNodeAuth`'))
  assert.ok(t.includes('`adminAuth` が無いサーバーは、誰でも変更できます'))
  assert.ok(t.includes('`wsuhaBroute: { allowAnonymousWrites: true }`'), 'エディタを別の方法で閉じたサーバーの開き方')
  assert.ok(t.includes('`flows.write` の権限は見ません'), '追加は flows.write を見ない')
  assert.ok(t.includes('`httpNodeMiddleware` は `http in` ノードにしか掛からない'))
  assert.ok(t.includes('インターネットへ直接出さないでください'))
  assert.ok(t.includes('X-Forwarded-Proto'), 'リバースプロキシの注意')
  assert.ok(t.includes('TOO_MANY_STREAMS'))
})

test('README と CHANGELOG: 確かめた Node-RED の版がそろう', () => {
  for (const doc of ['README.md', 'CHANGELOG.md']) {
    assert.ok(read(doc).includes('3.1.3・4.0.9・4.1.2'), `${doc} に確かめた版がありません`)
  }
  assert.ok(!read('README.md').includes('3.1.3 と 4.1.2'), '前の版の組み合わせが残っています')
})

test('README: 非公式の注記と、利用者の責任の範囲がある', () => {
  const t = read('README.md')
  assert.ok(t.includes('本パッケージは非公式のソフトウェアです。ラトックシステム株式会社、ローム株式会社、一般送配電事業者、エコーネットコンソーシアム、Wi-SUN Alliance とは関係がなく、承認も受けていません。記載の会社名・製品名・規格名は、各社の商標または登録商標の場合があります。'))
  assert.ok(t.includes('This is an unofficial package. It is not affiliated with or endorsed by RATOC Systems, ROHM, the Japanese transmission and distribution companies, the ECHONET Consortium or the Wi-SUN Alliance.'))
  for (const w of ['一般送配電事業者', '技術基準適合証明', '工事設計認証', '無保証', '請求の値と一致するとは限りません', 'dialout', '--device', 'by-id']) {
    assert.ok(t.includes(w), `README に ${w} がありません`)
  }
  // マニュアルの文の直接の引用は、自分の言葉の説明と出典に替えた
  assert.ok(!/マニュアル[^。]*に「/.test(t), 'マニュアルの文を「」で引用しない')
})

test('README の見出し: 実装の文が指す節がある', () => {
  const heads = read('README.md').split(/\r?\n/).filter((l) => l.startsWith('#')).map((l) => l.replace(/^#+\s*/, ''))
  const dir = path.join(PKG, 'lib/runtime')
  let refs = 0
  for (const f of fs.readdirSync(dir)) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/README の「([^」]+)」/g)) {
      refs++
      assert.ok(heads.includes(m[1]), `${f} が指す README の節「${m[1]}」がありません`)
    }
  }
  assert.ok(refs > 0, '前提: 実装の文が README の節を指している')
})

test('README が挙げる項目とボタンの名前は、エディタと Web UI の実物にある', () => {
  const t = read('README.md')
  const code = ['nodes/wsuha-device.html', 'nodes/wsuha-broute.html', 'ui/strings.js'].map(read).join('\n')
  // 読み手がエディタや Web UI で探す語。別の語に変えたら、README も一緒に直す
  for (const w of ['異常の通知', 'Web UI で開く', '送信制限を手動で解除…', 'アダプタを追加', '取得間隔', '定期的に取りに行く値',
    'Wi-SUN アダプタ（実機）', 'シミュレーター（実機なしで試す）', '想定 MAC', 'Node-RED にログイン']) {
    assert.ok(code.includes(w), `実物に「${w}」がありません`)
  }
  for (const w of ['異常の通知', 'Web UI で開く', '送信制限を手動で解除…', 'アダプタを追加', '取得間隔', '定期的に取りに行く値',
    'Wi-SUN アダプタ（実機）', 'シミュレーター（実機なしで試す）', '想定 MAC']) {
    assert.ok(t.includes(w), `README に「${w}」がありません`)
  }
})

test('docs/DEVELOPMENT.md: 既定で飛ばす試験の流し方がある', () => {
  const t = read('docs/DEVELOPMENT.md')
  for (const w of ['WSUHA_TEST_NODE_RED', 'WSUHA_PLAYWRIGHT', 'WSUHA_BANNED_FILE']) {
    assert.ok(t.includes(w), `docs/DEVELOPMENT.md に ${w} がありません`)
  }
  for (const f of ['test/runtime/embedded-kit.js', 'test/ui/browser.test.mjs', 'test/pack.test.js']) {
    assert.ok(fs.existsSync(path.join(PKG, f)), `前提: ${f} がある`)
  }
  assert.ok(read('test/runtime/embedded-kit.js').includes('WSUHA_TEST_NODE_RED'), '前提: 試験が同じ環境変数を読む')
  assert.ok(read('test/ui/browser.test.mjs').includes('WSUHA_PLAYWRIGHT'), '前提: 試験が同じ環境変数を読む')
})

/** lib/runtime の実装から、API のルートと code と settings.js の項目を読む。 */
function implemented() {
  const api = read('lib/runtime/http-api.js')
  const routes = [...api.matchAll(/route\('(get|put|post|delete)', BASE \+ '\/([^']+)'/g)]
    .filter((m) => !m[2].includes('*'))
    .map((m) => ({ method: m[1].toUpperCase(), path: m[2] }))
  const runtime = fs.readdirSync(path.join(PKG, 'lib/runtime')).map((f) => read(`lib/runtime/${f}`)).join('\n')
  const codes = new Set([...runtime.matchAll(/ApiError\(\s*\d{3},\s*'([A-Z_]+)'/g)].map((m) => m[1]))
  const settings = new Set([...runtime.matchAll(/wsuhaBroute\.(\w+)/g)].map((m) => m[1]))
  return { routes, codes, settings }
}

test('docs/API.md: 実装の全部のルートと code を説明している', () => {
  const doc = read('docs/API.md')
  const rows = doc.split(/\r?\n/).filter((l) => l.startsWith('| '))
  const { routes, codes } = implemented()
  assert.ok(routes.length > 15, `前提: ルートを読めている（${routes.length}）`)
  assert.ok(codes.size > 15, `前提: code を読めている（${codes.size}）`)
  for (const r of routes) {
    assert.ok(rows.some((l) => l.startsWith(`| ${r.method} | \`${r.path}`)), `${r.method} ${r.path} が docs/API.md の表にありません`)
  }
  // 逆向きも見る（消したルートを説明に残さない）
  for (const l of rows) {
    const m = /^\| (GET|PUT|POST|DELETE) \| `([^`?]+)/.exec(l)
    if (m) assert.ok(routes.some((r) => r.method === m[1] && r.path === m[2]), `docs/API.md の ${m[1]} ${m[2]} は実装にありません`)
  }
  for (const c of codes) assert.ok(doc.includes(`\`${c}\``), `code ${c} が docs/API.md にありません`)
  // 守りの要は、実装の形が変わっても説明から落とさない
  assert.ok(rows.some((l) => l.startsWith('| GET | `session`')), 'GET session が docs/API.md の表にありません')
  for (const w of ['X-Wsuha-Editor-Token', 'X-Wsuha-Radio: 1', 'LOGIN_REQUIRED', 'FORBIDDEN', 'TOO_MANY_STREAMS']) {
    assert.ok(doc.includes(w), `docs/API.md に ${w} がありません`)
  }
})

test('docs/API.md: 型の項目がサーバーの返す形と合う', () => {
  const doc = read('docs/API.md')
  const auth = require('../lib/runtime/editor-auth').authMeta({}, '/')
  for (const k of Object.keys(auth)) assert.match(doc, new RegExp(`auth: \\{[^}]*\\b${k}:`), `Meta.auth の ${k} が docs/API.md にありません`)
  assert.match(doc, /recordingSince: number\|null/, 'AdapterDetail.recordingSince が docs/API.md にありません')
})

test('settings.js の wsuhaBroute の項目は、全部 README と docs/API.md の表にある', () => {
  const { settings } = implemented()
  for (const k of ['ui', 'readOnly', 'uiConfig', 'uiAddAdapter', 'allowedHosts', 'sse', 'allowAnonymousWrites']) {
    assert.ok(settings.has(k), `前提: 実装が wsuhaBroute.${k} を読む`)
  }
  for (const doc of ['README.md', 'docs/API.md']) {
    const rows = read(doc).split(/\r?\n/).filter((l) => l.startsWith('| `'))
    for (const k of settings) assert.ok(rows.some((l) => l.startsWith(`| \`${k}\` |`)), `${doc} の表に wsuhaBroute.${k} がありません`)
  }
})

test('配布物に、禁止語リスト（リポジトリの外）の値が無い', { timeout: 60000 }, (t) => {
  // リスト自体が機微情報の一覧になるので、リポジトリに置かない。失敗しても、当たった値は出さない
  const list = process.env.WSUHA_BANNED_FILE
  if (!list) return t.skip('WSUHA_BANNED_FILE を指定していません')
  const patterns = fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => new RegExp(s))
  assert.ok(patterns.length > 0, '前提: 禁止語リストを読めている')
  const hits = []
  for (const f of packedFiles()) {
    const text = read(f)
    if (patterns.some((re) => re.test(text))) hits.push(f)
  }
  assert.deepEqual(hits, [], `禁止語に当たったファイル: ${hits.join(', ')}`)
})
