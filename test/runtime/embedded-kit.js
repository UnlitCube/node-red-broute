'use strict'

// 試験用: 本物の Node-RED を子プロセスで立てる（embedded-red-server.js）。
// flow-writer-embedded.test.js と editor-auth-embedded.test.js が使う。
//
// 本物の Node-RED が入っていない環境（ふつうの開発機）では、呼ぶ側の試験を飛ばす（skip）。流し方は呼ぶ側の冒頭に書いてある。

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const waitKit = require('../wait-kit')

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

// 待ちの規則は test/wait-kit.js（単調な時計で測る・期限を過ぎても投げる前にもう一度見る・プロセスごと止まっていた間は数えない）
async function until(fn, what, ms) {
  const r = await waitKit.poll(fn, ms || 15000, 100)
  if (!r.ok) throw new Error(what + ' が時間内に起きませんでした')
  return r.value
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
  // 要求ごとに接続を張り直す（http.request の agent: false。keep-alive の接続を使い回さない）。
  // fetch（undici）では、プロセスごと止まりが明けた直後の要求が「fetch failed」（cause は UND_ERR_SOCKET: other side closed か ECONNRESET）で
  // 落ちた（Node 18 のコンテナを 10 秒止めて確かめた）。止まりの間に Node-RED の側の keep-alive の期限（Node の http の既定は 5 秒）が過ぎ、
  // 明けた直後にサーバーが閉じる接続へ、undici が次の要求を載せる。試験が見たいのは Node-RED の応答なので、使い回しの都合で落とさない
  function j(method, url, body, headers) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const h = Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers)
    if (payload) h['content-length'] = payload.length
    return new Promise((resolve, reject) => {
      const req = http.request(base + url, { method, headers: h, agent: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let data = text
          try {
            data = JSON.parse(text)
          } catch (e) {
            /* 文字のまま */
          }
          const hs = new Headers()
          for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) hs.append(k, x)
          resolve({ status: res.statusCode, body: data, text, headers: hs })
        })
      })
      req.on('error', reject)
      req.end(payload || undefined)
    })
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
