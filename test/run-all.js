'use strict'

// test/ の下の試験を全部集めて、`node --test` にファイル名で渡す。
//
// `node --test "test/*.test.js"` のように引用したグロブを Node 自身が展開するのは Node 21 以降で、
// engines の下限の Node 18 と 20 では「ファイルが見つからない」で止まる。シェルの展開にも頼れない
// （Windows の cmd は展開しない）。そこでファイルは自分で集める。
// グロブを階層ごとに並べると、ディレクトリを足したときに試験が黙って流れなくなるので、下の階層まで全部たどる。
//
//   node test/run-all.js            全部流す
//   node test/run-all.js --list     流すファイルの一覧を出して終わる
//   node test/run-all.js runtime    パスに runtime を含むファイルだけ流す
//   node test/run-all.js --test-name-pattern=Host
//                                   -- で始まる引数は node にそのまま渡す
//   node test/run-all.js --limit-ms=60000
//                                   全体の上限を変える（既定 20 分）

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const TEST_FILE = /\.test\.m?js$/
// Node 18 には試験の時間の上限を指定する引数が無く、1 本が止まると npm test がいつまでも終わらない。
// 全部を流しても数分なので、緑のまま終わらない状態を赤に変えるための上限を、全体に掛ける
const RUN_LIMIT_MS = 20 * 60 * 1000

function collect(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full))
    else if (entry.isFile() && TEST_FILE.test(entry.name)) out.push(full)
  }
  return out
}

/** 版ごとに使える `node --test` の引数。古い Node に知らない引数を渡すと、起動の時点で止まる。 */
function versionFlags(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  const atLeast = (m, n) => major > m || (major === m && minor >= n)
  const flags = []
  // 試験の中で閉じ忘れたタイマーやソケットが 1 つあるだけで、1 本のファイルの試験がいつまでも終わらなくなるのを防ぐ
  if (atLeast(22, 0) || (major === 20 && minor >= 14)) flags.push('--test-force-exit')
  // 止まったままになるのを防ぐだけの上限。ファイル全体にも効くので、再接続の試験（数分）を切らない長さにする
  if (atLeast(21, 2) || (major === 20 && minor >= 11)) flags.push('--test-timeout=600000')
  return flags
}

function main(argv) {
  const list = argv.includes('--list')
  const limitArg = argv.find((a) => a.startsWith('--limit-ms='))
  const limitMs = limitArg ? Number(limitArg.split('=')[1]) : RUN_LIMIT_MS
  const nodeArgs = argv.filter((a) => a.startsWith('--') && a !== '--list' && a !== limitArg)
  const filters = argv.filter((a) => !a.startsWith('--'))

  const files = collect(__dirname)
    .map((f) => path.relative(ROOT, f))
    .filter((f) => !filters.length || filters.some((s) => f.split(path.sep).join('/').includes(s)))
    .sort()

  if (!files.length) {
    console.error('流す試験が 1 本もありません。test/ の下のファイルと、引数の絞り込みを確かめてください')
    return 1
  }
  if (list) {
    for (const f of files) console.log(f.split(path.sep).join('/'))
    return 0
  }

  const r = spawnSync(process.execPath, ['--test', ...versionFlags(process.version), ...nodeArgs, ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: limitMs,
    killSignal: 'SIGKILL',
  })
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.error(`試験が ${Math.round(limitMs / 1000)} 秒で終わらないので止めました。止まっているファイルを、1 本ずつ流して探してください`)
    return 1
  }
  if (r.error) {
    console.error(`node --test を起動できませんでした: ${r.error.message}`)
    return 1
  }
  // シグナルで止まったときは status が null になる
  return r.status === null ? 1 : r.status
}

process.exitCode = main(process.argv.slice(2))
