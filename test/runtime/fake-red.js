'use strict'

// 試験用の偽の RED と、偽の req / res。
//
//  - httpNode・httpAdmin: get / put / post / delete を記録する偽のルーター（express の非 strict と同じく末尾の / を許す）。
//    記録した routes には、どちらに載ったか（app: 'node' | 'admin'）を付ける。
//    request() は既定で httpNode のルートを探す（エディタ用の httpAdmin は p.app = 'admin'）。
//  - auth.needsPermission: 本物の @node-red/editor-api の動きを写す。
//    adminAuth が無い・httpAdminRoot: false（本物は認証を初期化しない）なら、何も確かめずに next()。
//    adminAuth があれば Authorization の Bearer を opts.tokens で引き、無ければ adminAuth.default の匿名にする。
//    401 の書き方は本物と同じ 2 通り: 認証の失敗は passport が res.statusCode・setHeader・end で、
//    権限の不足は res.status(401).end() で書く。どちらも非同期で書く（本物はトークンを Promise で読む）。
//    req.unauthenticated はエディタ用のルート（httpAdmin）の試験の印で、立っていれば 401（本文は空）。
//  - req は本文を流す Readable（Node-RED の httpNode は本文を読まないので、req.body は置かない）。
//    httpNodeMiddleware などで読んだ形を試すときは p.parsedBody を渡す。
//    Host は既定で 127.0.0.1:1880、protocol は http。
//  - p.resHeaders: ルートより先に res に付いているヘッダ。本物では、httpAdminRoot と httpNodeRoot が同じ '/' のとき、
//    エディタ（adminApp）の cors({origin:'*'}) が httpNode の応答にも先に Access-Control-Allow-Origin: * を付ける。
//  - nodes.registerType の第 3 引数（credentials・settings）は typeOpts に残す。
//  - nodes.createNode: test/sequencer.test.js の偽の RED と同じやり方（EventEmitter を混ぜる）
//  - close(node, removed): Node-RED と同じく close の受け手へ (removed, done) を渡して待つ
//
//  ここは test/*.test.js の glob に入らない名前にしてある（試験そのものではない）。

const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOST = '127.0.0.1:1880'

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'wsuha-test-'))
}

async function waitFor(fn, timeoutMs, what) {
  // Date.now を差し替える試験でも待ちの上限が効くように、時計は performance.now で測る
  const limit = performance.now() + (timeoutMs || 5000)
  while (performance.now() < limit) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('待ち時間を超えました: ' + (what || '条件'))
}

class FakeRes extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.chunks = []
    this.ended = false
    this.headersSent = false
    this.flushed = false
    this.writableLength = 0
  }
  setHeader(k, v) {
    this.headers[String(k).toLowerCase()] = v
  }
  getHeader(k) {
    return this.headers[String(k).toLowerCase()]
  }
  removeHeader(k) {
    delete this.headers[String(k).toLowerCase()]
  }
  flushHeaders() {
    this.flushed = true
    this.headersSent = true
  }
  write(chunk) {
    if (this.ended) throw new Error('閉じた res に書きました')
    this.headersSent = true
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    this.emit('data', String(chunk))
    return true
  }
  end(chunk) {
    if (this.ended) return
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    this.ended = true
    this.headersSent = true
    this.emit('finish')
    this.emit('close')
  }
  status(code) {
    this.statusCode = code
    return this
  }
  json(obj) {
    this.setHeader('Content-Type', 'application/json')
    this.end(JSON.stringify(obj))
  }
  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
  get body() {
    const ct = String(this.headers['content-type'] || '')
    if (/json/.test(ct)) {
      try {
        return JSON.parse(this.text)
      } catch (e) {
        return undefined
      }
    }
    return this.text
  }
}

function compile(p) {
  if (p instanceof RegExp) return { re: p, keys: [] }
  const keys = []
  const src = String(p)
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      if (seg === '*') {
        keys.push('0')
        return '(.*)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { re: new RegExp('^' + src + '\\/?$'), keys }
}

function parseQuery(s) {
  const q = {}
  for (const part of (s || '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = decodeURIComponent(i < 0 ? part : part.slice(0, i))
    q[k] = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '))
  }
  return q
}

/** Node-RED の permissions.hasPermission と同じ規則。 */
function hasPermission(scope, permission) {
  if (Array.isArray(scope)) return scope.some((x) => hasPermission(x, permission))
  if (scope === '*' || scope === permission) return true
  if (scope === 'read' || scope === '*.read') return /^((.+)\.)?read$/.test(permission)
  if (scope === 'write' || scope === '*.write') return /^((.+)\.)?write$/.test(permission)
  return false
}

/**
 * @param {object} [opts] {userDir, settings, noHttpNode, tokens: {<トークン>: {username, permissions}}}
 */
function createFakeRed(opts) {
  const o = opts || {}
  const types = {}
  const typeOpts = {}
  const routes = []
  const nodes = new Map()
  const logs = []
  const events = new EventEmitter()
  function makeRouter(app) {
    const router = {}
    for (const m of ['get', 'put', 'post', 'delete']) {
      router[m] = (p, ...handlers) => routes.push({ app, method: m.toUpperCase(), path: p, handlers, matcher: compile(p) })
    }
    return router
  }
  const settings = Object.assign({ userDir: o.userDir || tmpDir() }, o.settings || {})
  const tokens = o.tokens || {}
  const RED = {
    settings,
    httpAdmin: makeRouter('admin'),
    events,
    auth: {
      needsPermission(perm) {
        const mw = function (req, res, next) {
          if (req.unauthenticated) {
            res.statusCode = 401
            return res.end()
          }
          if (!settings.adminAuth || settings.httpAdminRoot === false) return next()
          Promise.resolve().then(() => {
            const parts = String(req.headers.authorization || '').split(' ')
            const bearer = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : null
            const known = bearer !== null && tokens[bearer]
            const anon = settings.adminAuth.default
            const user = known ? { username: known.username, permissions: known.permissions } : anon ? { anonymous: true, permissions: anon.permissions } : null
            if (!user) {
              // passport の allFailed。Bearer の形が壊れていると passport-http-bearer は 400 で失敗する
              res.statusCode = req.headers.authorization && parts.length !== 2 ? 400 : 401
              if (res.statusCode === 401) res.setHeader('WWW-Authenticate', ['Bearer realm="Users"'])
              return res.end(res.statusCode === 401 ? 'Unauthorized' : 'Bad Request')
            }
            req.user = user
            req.authInfo = { scope: user.permissions }
            if (hasPermission(user.permissions, perm)) return next()
            return res.status(401).end()
          })
        }
        mw.permission = perm
        return mw
      },
    },
    log: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
      debug: (m) => logs.push(['debug', String(m)]),
      trace: () => {},
      // 本物の log.audit と同じく、req があれば user・path・ip を足す
      audit: (e, req) => logs.push(['audit', JSON.stringify(req ? Object.assign({}, e, { user: req.user, path: req.path, ip: req.ip }) : e)]),
    },
    version: () => '3.1.3',
    nodes: {
      createNode(node, config) {
        EventEmitter.call(node)
        for (const k of ['on', 'once', 'emit', 'removeListener', 'removeAllListeners', 'listeners']) {
          node[k] = EventEmitter.prototype[k]
        }
        node.id = config.id
        node.type = config.type
        node.name = config.name
        node.credentials = config._credentials || {}
        node._errors = []
        node._warns = []
        node._sent = []
        node._statuses = []
        node.error = (m) => node._errors.push(String(m && m.message ? m.message : m))
        node.warn = (m) => node._warns.push(String(m))
        node.debug = () => {}
        node.log = () => {}
        node.trace = () => {}
        node.status = (s) => node._statuses.push(s)
        node.send = (msg) => node._sent.push(msg)
        nodes.set(config.id, node)
      },
      registerType(name, ctor, opts) {
        types[name] = ctor
        typeOpts[name] = opts
      },
      getNode(id) {
        return nodes.get(id) || null
      },
    },
  }
  if (!o.noHttpNode) RED.httpNode = makeRouter('node')

  function create(type, config) {
    const Ctor = types[type]
    if (!Ctor) throw new Error('型が登録されていません: ' + type)
    return new Ctor(Object.assign({ type }, config))
  }

  /** Node-RED と同じく close の受け手に (removed, done) を渡し、全部の done を待つ。 */
  function close(node, removed) {
    return new Promise((resolve) => {
      const ls = node.listeners('close')
      let pending = ls.length
      const finish = () => {
        if (--pending <= 0) {
          if (nodes.get(node.id) === node) nodes.delete(node.id)
          resolve()
        }
      }
      if (!pending) {
        pending = 1
        return finish()
      }
      for (const fn of ls) {
        if (fn.length >= 2) fn.call(node, !!removed, finish)
        else if (fn.length === 1) fn.call(node, finish)
        else {
          fn.call(node)
          finish()
        }
      }
    })
  }

  /**
   * 画面（ui/api.js）と同じく、書き込み（PUT / DELETE / POST）には Content-Type: application/json を付ける
   * （無ければ 415）。付けない形を試すときは headers に 'content-type': null を渡す。
   * Host は既定で 127.0.0.1:1880（消すときは 'host': null）。Origin は付けない（curl や http request ノードと同じ）。
   */
  function headersFor(method, given) {
    const h = Object.assign({ host: HOST }, given || {})
    if (method !== 'GET' && !Object.prototype.hasOwnProperty.call(h, 'content-type')) h['content-type'] = 'application/json'
    for (const k of Object.keys(h)) if (h[k] === null || h[k] === undefined) delete h[k]
    return h
  }

  /**
   * req を作る。本文は Readable で流す（Node-RED の httpNode は本文を読まない）。
   * p.body はオブジェクトなら JSON にして流す。p.rawBody は文字列のまま流す。
   * p.parsedBody は、先に別のミドルウェアが読んだ形（req.body と req._body）を置く。
   */
  function makeReq(method, url, p) {
    const q = p || {}
    const [pth, qs] = String(url).split('?')
    let raw = ''
    if (q.rawBody !== undefined) raw = String(q.rawBody)
    else if (q.body !== undefined) raw = JSON.stringify(q.body)
    const req = new Readable({ read() {} })
    if (raw) req.push(Buffer.from(raw, 'utf8'))
    req.push(null)
    Object.assign(req, {
      method,
      url,
      originalUrl: url,
      path: pth,
      protocol: q.protocol || 'http',
      query: parseQuery(qs),
      params: {},
      headers: headersFor(method, q.headers),
      user: q.user,
      ip: q.ip,
      authInfo: q.authInfo,
      unauthenticated: !!q.unauthenticated,
    })
    if (q.parsedBody !== undefined) {
      req.body = q.parsedBody
      req._body = true
    }
    return req
  }

  function findRoute(method, pth, app) {
    for (const r of routes) {
      if (r.method !== method) continue
      if (app && r.app !== app) continue
      const m = r.matcher.re.exec(pth)
      if (!m) continue
      const params = {}
      r.matcher.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] || '')
      })
      return { route: r, params }
    }
    return null
  }

  function run(found, req, res) {
    let i = 0
    const next = (err) => {
      if (err) throw err
      const h = found.route.handlers[i++]
      if (!h) return
      return h(req, res, next)
    }
    return next()
  }

  /** p.resHeaders を、ルートより先に付いたヘッダとして res に置く。 */
  function makeRes(p) {
    const res = new FakeRes()
    for (const [k, v] of Object.entries((p && p.resHeaders) || {})) res.setHeader(k, v)
    return res
  }

  /** ルートを呼んで、res が閉じるまで待つ。p.app は 'node'（既定）か 'admin'。 */
  async function request(method, url, p) {
    const req = makeReq(method, url, p)
    const res = makeRes(p)
    const found = findRoute(method, req.path, (p && p.app) || 'node')
    if (!found) {
      res.statusCode = 404
      res.end('no route')
      return res
    }
    req.params = found.params
    const ended = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`応答が返りません: ${method} ${url}`)), (p && p.timeoutMs) || 20000)
      res.once('finish', () => {
        clearTimeout(t)
        resolve()
      })
    })
    await run(found, req, res)
    await ended
    return res
  }

  /** SSE を開く（閉じるのを待たない）。 */
  function openStream(url, p) {
    const req = makeReq('GET', url, p)
    const res = makeRes(p)
    const found = findRoute('GET', req.path, (p && p.app) || 'node')
    if (!found) throw new Error('ルートがありません: ' + url)
    req.params = found.params
    const done = Promise.resolve(run(found, req, res))
    return { req, res, done }
  }

  return { RED, routes, types, typeOpts, nodes, logs, events, create, close, request, openStream, settings }
}

/** SSE の文字列をフレームに分ける。 */
function parseSse(text) {
  const frames = []
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue
    if (block.startsWith(':')) {
      frames.push({ comment: block.slice(1).trim() })
      continue
    }
    const f = {}
    for (const line of block.split('\n')) {
      const i = line.indexOf(': ')
      if (i < 0) continue
      const k = line.slice(0, i)
      const v = line.slice(i + 2)
      if (k === 'data') f.data = JSON.parse(v)
      else if (k === 'id') f.id = Number(v)
      else f[k] = v
    }
    frames.push(f)
  }
  return frames
}

module.exports = { createFakeRed, FakeRes, parseSse, waitFor, tmpDir, ID, PW, HOST }
