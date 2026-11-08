'use strict'

// 試験用: 本物の Node-RED を子プロセスで立てる（embedded-red-server.js）。
// flow-writer-embedded.test.js と editor-auth-embedded.test.js が使う。
//
// 本物の Node-RED が入っていない環境（ふつうの開発機）では、呼ぶ側の試験を飛ばす（skip）。流し方は呼ぶ側の冒頭に書いてある。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

function findHome() {
  for (const dir of [process.env.WSUHA_TEST_NODE_RED, '/usr/src/node-red']) {
    if (!dir) continue
    try {
      require.resolve('node-red', { paths: [dir] })
      return dir
    } catch (e) {
      /* 次へ */
    }
  }
  return null
}

const HOME = findHome()
/** node:test の skip に渡す値。 */
const skip = HOME ? false : '本物の Node-RED が無い環境では流しません（ファイルの冒頭に流し方）'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, what, ms) {
  const end = Date.now() + (ms || 15000)
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(what + ' が時間内に起きませんでした')
    await sleep(100)
  }
}

/**
 * 本物の Node-RED を子プロセスで立てる。
 * @param {object[]} flows 先に置く flows.json
 * @param {object} [opt] {env, safe, settings: 足す settings の JS の式（文字列。関数を書くため）か、JSON にできるオブジェクト}
 */
async function boot(flows, opt) {
  const o = opt || {}
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsuha-embed-'))
  fs.writeFileSync(path.join(userDir, 'flows.json'), JSON.stringify(flows))
  const env = Object.assign({}, process.env, o.env, { WSUHA_TEST_NODE_RED: HOME, WSUHA_TEST_USERDIR: userDir, WSUHA_TEST_SAFE: o.safe ? '1' : '' })
  if (o.settings) {
    const file = path.join(userDir, 'test-settings.js')
    fs.writeFileSync(file, 'module.exports = ' + (typeof o.settings === 'string' ? o.settings : JSON.stringify(o.settings)) + '\n')
    env.WSUHA_TEST_SETTINGS = file
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'embedded-red-server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => {
      out += b
      const m = /READY (\d+) (\S+)/.exec(out)
      if (m) resolve({ port: Number(m[1]), version: m[2] })
    })
    child.on('exit', (c) => reject(new Error('Node-RED が起動しませんでした（' + c + '）')))
  })
  const base = `http://127.0.0.1:${ready.port}`
  async function j(method, url, body, headers) {
    const r = await fetch(base + url, {
      method,
      headers: Object.assign(body === undefined ? {} : { 'content-type': 'application/json' }, headers),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    let data = text
    try {
      data = JSON.parse(text)
    } catch (e) {
      /* 文字のまま */
    }
    return { status: r.status, body: data, text, headers: r.headers }
  }
  return {
    version: ready.version,
    userDir,
    base,
    j,
    /** 子プロセスの標準出力（Node-RED のログと監査）。 */
    stdout: () => out,
    file: (n) => path.join(userDir, n),
    close: async () => {
      child.removeAllListeners('exit')
      const done = new Promise((r) => child.on('exit', r))
      child.kill('SIGTERM')
      await Promise.race([done, sleep(5000)])
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(userDir, { recursive: true, force: true })
    },
  }
}

module.exports = { HOME, skip, sleep, until, boot }
