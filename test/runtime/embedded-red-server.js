'use strict'

// 試験用: 本物の Node-RED を使い捨ての userDir で立てる（embedded-kit.js の boot が子プロセスとして流す）。
// 1 プロセスに 1 つしか載らないので、場面ごとに別のプロセスにする。動いている Node-RED には触らない。
//
// 環境変数:
//   WSUHA_TEST_NODE_RED   node-red が入っているディレクトリ
//   WSUHA_TEST_USERDIR    userDir（flows.json を先に置く）
//   WSUHA_TEST_SAFE=1     セーフモードで起動する
//   WSUHA_TEST_SETTINGS   足す settings を書いた JS のファイル（adminAuth・httpAdminRoot など。関数も書けるので JS にしてある）
//                         settingsFile を書くと red.js の起動の形になる（下の basicAuth）
// 標準出力に 'READY <ポート> <版>' を 1 行出す。SIGTERM で止まる。

const http = require('node:http')
const path = require('node:path')

const home = process.env.WSUHA_TEST_NODE_RED
const load = (m) => require(require.resolve(m, { paths: [home] }))
const express = load('express')
const RED = load('node-red')

const settings = {
  userDir: process.env.WSUHA_TEST_USERDIR,
  flowFile: 'flows.json',
  credentialSecret: 'test-only-secret',
  httpAdminRoot: '/admin/',
  httpNodeRoot: '/',
  nodesDir: [path.join(__dirname, '..', '..', 'nodes')],
  safeMode: process.env.WSUHA_TEST_SAFE === '1',
  logging: { console: { level: 'error' } },
  functionGlobalContext: {},
  editorTheme: { tours: false },
  telemetry: { enabled: false },
  diagnostics: { enabled: false },
}
if (process.env.WSUHA_TEST_SETTINGS) Object.assign(settings, require(process.env.WSUHA_TEST_SETTINGS))

/**
 * httpAdminAuth と httpNodeAuth の Basic 認証。掛けるのは Node-RED の red.js で、埋め込みのサーバーには掛からないので、
 * red.js の起動の形（settingsFile を渡した）のときだけ、同じ根に同じ順で同じ規則のものを掛ける（OPTIONS は通す・パスワードは bcrypt）。
 * settingsFile が無ければ本物の埋め込みのまま何も掛けない。
 */
function basicAuth(auth) {
  const bcrypt = load('bcryptjs')
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next()
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '')
    const text = m ? Buffer.from(m[1], 'base64').toString('utf8') : ''
    const i = text.indexOf(':')
    if (i < 0 || text.slice(0, i) !== auth.user || !bcrypt.compareSync(text.slice(i + 1), auth.pass)) {
      res.set('WWW-Authenticate', 'Basic realm="Authorization Required"')
      return res.sendStatus(401)
    }
    next()
  }
}

const app = express()
const server = http.createServer(app)
RED.init(server, settings)
const likeRedJs = typeof settings.settingsFile === 'string'
if (likeRedJs && settings.httpAdminRoot !== false && settings.httpAdminAuth) app.use(settings.httpAdminRoot, basicAuth(settings.httpAdminAuth))
if (settings.httpAdminRoot !== false) app.use(settings.httpAdminRoot, RED.httpAdmin)
if (likeRedJs && settings.httpNodeAuth) app.use(settings.httpNodeRoot, basicAuth(settings.httpNodeAuth))
app.use(settings.httpNodeRoot, RED.httpNode)

async function main() {
  await RED.start()
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`READY ${server.address().port} ${RED.version()}\n`)
  })
}

function stop() {
  Promise.resolve(RED.stop())
    .catch(() => {})
    .finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n')
  process.exit(1)
})
