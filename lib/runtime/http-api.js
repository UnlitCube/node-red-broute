'use strict'

// ============================================================================
//  HTTP API v1・SSE・画面の登録（{httpNodeRoot}wsuha-broute/…）
// ============================================================================
//
//  nodes/wsuha-device.js のモジュール関数から install(RED) を 1 回だけ呼ぶ。
//
//  - 画面と API は **httpNode**（ダッシュボードの /ui/ と同じ側）に載せる。画面に独自のログインは持たない。
//    settings.js に adminAuth があるサーバーでは、変更はエディタにログインした人だけができる。
//    エディタを adminAuth 以外の方法で閉じたサーバーでは、変更を全部断る（どちらも editor-auth.js）。
//    読むのも限りたいときは Node-RED の httpNodeAuth を使う。
//  - httpNodeRoot === false（httpNode を切っている）か settings.js の wsuhaBroute.ui === false なら載せず、warn を 1 行。
//    載せないときも、運用設定の照合・適用とフローの入力（service）は動く。
//  - 全部のルート（画面・API・SSE）の前に:
//      a. CORS のヘッダ（Access-Control-Allow-*）を外す。httpAdminRoot と httpNodeRoot が同じ '/' のサーバー（既定）では、
//         エディタ（adminApp）の cors({origin:'*'}) がこちらの応答にも先に Access-Control-Allow-Origin: * を付けるため。
//         残すと、どのサイトのページからでも計測値・MAC・ログを読めてしまう。
//      b. Host を許可リストで照らす。外れたら 403 BAD_HOST（DNS リバインディング: 攻撃者の名前を LAN のアドレスに
//         向け直すと Origin も Host もその名前になり、BAD_ORIGIN を抜ける）。
//         既定で通すのは IP の直書き・1 語の名前（localhost・raspberrypi）・公開の DNS に登録できない名前（.local・.lan・
//         .home.arpa・.internal・.localhost）・このホストの名前（os.hostname()）。settings.js の wsuhaBroute.allowedHosts で足せる。
//  - 読み出し（GET・SSE）は誰でも。書き込み（PUT / DELETE / POST）の守りはこの順（上の b の BAD_HOST のあと）:
//      1. Content-Type: application/json が無い・違う → 415 UNSUPPORTED_MEDIA_TYPE
//         （フォームや text/plain の POST は、別のサイトからプリフライト無しで送れるため）
//      2. Origin があって、Host と同じオリジン（スキーム・ホスト・ポート）でない → 403 BAD_ORIGIN
//         （Origin が無い curl・http request ノードは通す）
//      3. 変更に認証が要るサーバーでは、エディタのトークンで確かめる → 401 LOGIN_REQUIRED・403 FORBIDDEN
//      4. settings.js の wsuhaBroute.readOnly === true → 403 READ_ONLY
//      5. 構成・認証情報・アダプタの追加だけ: wsuhaBroute.uiConfig === false（追加は uiAddAdapter === false でも）→ 403 CONFIG_LOCKED
//      6. 本文を読む（Node-RED の httpNode は読まない。http in ノードがルートごとに読む）。64 KB まで
//         （httpAdminRoot と httpNodeRoot が同じサーバーでは、エディタの body-parser が先に読み終えているが、大きさは同じ規則で見る）
//    CORS のヘッダは自分では付けない（上の a で外す）。
//  - 電波を使う GET read（maxAgeSec より古い値を取りに行くとき）も同じ守りを通す。詳しくは handlers.read。
//  - ハンドラの例外は 500 の JSON にして返す。**プロセスを落とさない**
//    （同じ Node-RED でほかのフローも動いている）。
//  - 応答は JSON・Cache-Control: no-store。失敗は {error:{code, message（日本語）}}。
//  - 運用設定・診断・状態の中身は service.js（フローの入力と共有）。変えた人は 'web-ui'。
//  - 認証情報の値は応答・監査・ログに入れない（応答は Config。credentials は configured・source・pairId・envOverrides・stored だけ）。
//  - POST adapters（アダプタの追加）の中身は service.addAdapter と flow-writer.js。201（動き出した）か 202（フローには足した）と Location。
//  - flows:started で、フローに無い id の保存した値（credentials/<id>.json と settings.json の adapters[id]）の数を warn 1 行。

const path = require('path')
const net = require('net')
const os = require('os')
const { getRegistry } = require('./registry')
const vm = require('./view-model')
const { createSettingsStore } = require('./settings-store')
const { createCredentialsStore } = require('./credentials-store')
const svc = require('./service')
const { createSseHub } = require('./sse')
const { createStaticUi } = require('./static-ui')
const readValues = require('./read-values')
const { createFlowWriter } = require('./flow-writer')
const { createEditorAuth, LOGIN_REQUIRED_MESSAGE, FORBIDDEN_MESSAGE, NO_LOGIN_MESSAGE } = require('./editor-auth')

const { ApiError, mapError, withTimeout, parseEpcList, WEB_UI } = svc
/** 前の名前（試験と呼び出し側の互換）。 */
const HttpError = ApiError

const BASE = '/wsuha-broute/api/v1'
const PKG_DIR = path.join(__dirname, '..', '..')
const UI_DIR = path.join(PKG_DIR, 'ui')

/** 診断とメーターへの取り直しの、1 台あたりの間隔 [ms]。 */
const DIAG_INTERVAL_MS = 3000
const MAX_BODY_BYTES = 64 * 1024
/** 画面の API が 1 回に取り直せる EPC の数（1 回の Get に載る数と同じ）。 */
const MAX_REFRESH_EPCS = 6
/** 認証を通らなかった変更を、Node-RED のログへ続けて書かない間隔 [ms]（監査には毎回残す）。 */
const DENIED_WARN_MS = 60000
/** 同じ RED へ二重に登録しないための印。 */
const installed = new WeakMap()
const ACTIONS = ['start', 'stop', 'auto', 'reconnect', 'terminate', 'poll', 'get', 'clear-radio-block']
const ACTION_LABEL = {
  start: '開始',
  stop: '停止',
  auto: '自動運転に戻す',
  reconnect: '再接続',
  terminate: 'セッション終了',
  poll: '今すぐ取得',
  get: '指定の取得',
  'clear-radio-block': '送信制限の手動解除',
}
const READ_ONLY_MESSAGE = 'このサーバーでは画面からの操作を止めています（settings.js の wsuhaBroute.readOnly）'
/** 応答から外す CORS のヘッダ（エディタの cors が付けるものと、その仲間）。 */
const CORS_HEADERS = [
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Allow-Credentials',
  'Access-Control-Expose-Headers',
  'Access-Control-Max-Age',
]

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v)
  res.end(text)
}

function sendError(res, err) {
  const body = { error: { code: err.code, message: err.message } }
  if (err.details) body.error.details = err.details
  sendJson(res, err.status, body, err.headers)
}

function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query
  const q = {}
  const s = String(req.url || '').split('?')[1] || ''
  for (const part of s.split('&')) {
    if (!part) continue
    const [k, v] = part.split('=')
    try {
      q[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '))
    } catch (e) {
      /* 読めないものは捨てる */
    }
  }
  return q
}

function header(req, name) {
  const h = req.headers || {}
  const v = h[name] !== undefined ? h[name] : h[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

/**
 * 本文の形が application/json か（charset などの引数は見ない。大文字小文字も見ない）。
 * 書き込みはこれを必須にする。フォーム（x-www-form-urlencoded・multipart）と
 * text/plain の POST はプリフライト無しで別のサイトから送れる。
 */
function isJsonRequest(req) {
  const v = header(req, 'content-type')
  if (v === undefined || v === null) return false
  return String(v).split(';')[0].trim().toLowerCase() === 'application/json'
}

/** 要求のスキームの候補。req.protocol（express。trust proxy に従う）と、TLS を終端するリバースプロキシの X-Forwarded-Proto。 */
function schemesOf(req) {
  const out = []
  if (typeof req.protocol === 'string' && req.protocol) out.push(req.protocol.toLowerCase())
  else {
    const sock = req.socket || req.connection
    out.push(req.secure || (sock && sock.encrypted) ? 'https' : 'http')
  }
  const fwd = header(req, 'x-forwarded-proto')
  if (fwd) {
    const s = String(fwd).split(',')[0].trim().toLowerCase()
    if ((s === 'http' || s === 'https') && out.indexOf(s) < 0) out.push(s)
  }
  return out
}

/**
 * Origin が Host と同じオリジン（スキーム・ホスト・ポート）か。Origin が無い（空も）なら true。
 * 'null'（サンドボックスの iframe・file://）や読めない値は false。Host が無ければ false。
 * 既定のポートの省略・ホスト名の大文字小文字は URL のオリジンでそろえる。
 */
function isSameOrigin(req) {
  const origin = header(req, 'origin')
  if (origin === undefined || origin === null || String(origin) === '') return true
  let o
  try {
    o = new URL(String(origin)).origin
  } catch (e) {
    return false
  }
  if (!o || o === 'null') return false
  const host = header(req, 'host')
  if (!host) return false
  for (const scheme of schemesOf(req)) {
    try {
      if (new URL(`${scheme}://${String(host).trim()}`).origin === o) return true
    } catch (e) {
      /* 読めない Host は合わない */
    }
  }
  return false
}

// ---------------------------------------------------------------------------
//  Host の許可リスト（DNS リバインディング）
// ---------------------------------------------------------------------------

/**
 * 公開の DNS に登録できない名前の末尾。攻撃者はこの名前を自分のアドレスに向けられないので、リバインディングに使えない。
 *   .local（mDNS。RFC 6762）・.localhost（RFC 6761）・.home.arpa（RFC 8375）・.internal（ICANN が私用に取り置き）・
 *   .lan（家庭用ルーターの既定。委任されていない）
 */
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.home.arpa', '.internal', '.lan']

/**
 * ブラウザが別のサイトから送った要求か（Sec-Fetch-Site が cross-site・same-site）。
 * GET は img や a からも送れて Origin が付かないことがあるので、電波を使う GET（read の maxAgeSec）はこれも見る。
 * 無い（curl・http request ノード・古いブラウザ）・same-origin・none（アドレス欄に打った）は通す。
 * ブラウザがこのヘッダを付けるのは https と localhost だけなので、ふつうの http の LAN では hasRadioHeader が守りになる。
 */
function crossSiteFetch(req) {
  const v = String(header(req, 'sec-fetch-site') || '').toLowerCase()
  return v === 'cross-site' || v === 'same-site'
}

/**
 * 電波を使う GET に X-Wsuha-Radio: 1 が付いているか。
 * img タグのような単純な要求は独自のヘッダを付けられない。fetch で付けると CORS の要求になってブラウザが Origin を付けるので、
 * isSameOrigin で止まる（既定の httpAdminRoot: '/' ではプリフライトにエディタが答えるが、本物の要求には Origin が載る）。
 */
function hasRadioHeader(req) {
  return String(header(req, 'x-wsuha-radio') || '').trim() === '1'
}

/**
 * Host ヘッダ（や allowedHosts の 1 項目）から、比べるホスト名を取り出す。
 * 小文字・ポートなし・IPv6 の [] なし・末尾の . なし。Host の形でなければ null（user@host や / を含むものなど）。
 */
function hostNameOf(value) {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/.exec(String(value).trim())
  if (!m) return null
  let name = m[1].toLowerCase()
  if (name[0] === '[') name = name.slice(1, -1)
  name = name.replace(/\.$/, '')
  return name || null
}

/** settings.js の wsuhaBroute.allowedHosts（文字列か配列）を、比べる形にそろえる。'.' で始まる項目は下の名前も許す。 */
function normalizeAllowedHosts(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  const out = []
  for (const x of list) {
    if (typeof x !== 'string') continue
    const t = x.trim()
    if (!t) continue
    const suffix = t[0] === '.'
    const name = hostNameOf(suffix ? t.slice(1) : t)
    if (name) out.push(suffix ? '.' + name : name)
  }
  return out
}

/**
 * Host がこのサーバーを指す名前として許されるか。
 * Host が無い（空も）なら true（ブラウザは必ず付ける。無いのは curl の HTTP/1.0 などで、リバインディングではない）。
 * @param {string|undefined} host Host ヘッダ
 * @param {object} [opts] {allowedHosts, hostname（既定 os.hostname()）}
 */
function isAllowedHost(host, opts) {
  if (host === undefined || host === null || String(host).trim() === '') return true
  const name = hostNameOf(host)
  if (!name) return false
  if (net.isIP(name)) return true // IP の直書き（攻撃者はそのオリジンでページを出せない）
  if (name.indexOf('.') < 0) return true // 1 語の名前（localhost・raspberrypi・nodered）。公開の DNS の名前ではない
  for (const suf of PRIVATE_SUFFIXES) if (name.endsWith(suf)) return true
  const o = opts || {}
  let own = o.hostname
  if (own === undefined) {
    try {
      own = os.hostname()
    } catch (e) {
      own = ''
    }
  }
  if (own && name === String(own).toLowerCase().replace(/\.$/, '')) return true
  for (const a of normalizeAllowedHosts(o.allowedHosts)) {
    if (a[0] === '.' ? name === a.slice(1) || name.endsWith(a) : name === a) return true
  }
  return false
}

/** If-Match の値（引用符と W/ を外す）。無ければ null。 */
function parseIfMatch(req) {
  const v = header(req, 'if-match')
  if (v === undefined || v === null || String(v).trim() === '') return null
  return String(v)
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1')
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v)
}

/** settings.js の wsuhaBroute.sse から、SSE の本数の上限だけを取り出す（正の整数。1000 まで）。 */
function sseLimitsFrom(v) {
  const out = {}
  if (!v || typeof v !== 'object') return out
  for (const k of ['maxConnections', 'maxPerClient']) {
    if (isInt(v[k]) && v[k] > 0 && v[k] <= 1000) out[k] = v[k]
  }
  return out
}

/** 監査に残す接続元（express の req.ip。無ければソケットの remoteAddress）。 */
function clientIpOf(req) {
  if (req && typeof req.ip === 'string' && req.ip) return req.ip
  const s = req && (req.socket || req.connection)
  return s && typeof s.remoteAddress === 'string' ? s.remoteAddress : null
}

/** 監査と flows.set に渡す要求の控え（Node-RED の getRequestLogObject と同じ形。本文もヘッダも入れない）。 */
function requestLogOf(req) {
  return { user: req.user, path: req.path, ip: clientIpOf(req) }
}

function tooLargeBody(limit) {
  return new ApiError(422, 'VALIDATION', `本文が大きすぎます（${Math.round(limit / 1024)} KB まで）`, { _: '本文が大きすぎます' })
}

/** 本文を読む（上限つき）。読み終わる前に閉じたら失敗。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function' || req.readableEnded) return resolve('')
    const chunks = []
    let size = 0
    let done = false
    const finish = (err, text) => {
      if (done) return
      done = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      if (err) reject(err)
      else resolve(text)
    }
    const onData = (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
      size += b.length
      if (size > limit) {
        finish(tooLargeBody(limit))
        if (typeof req.resume === 'function') req.resume() // 残りは読み捨てる
        return
      }
      chunks.push(b)
    }
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'))
    const onError = (e) => finish(e)
    const onAborted = () => finish(new Error('本文を読み終わる前に切れました'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * 書き込みの本文を JSON として読んで req.body に置く。空なら {}。
 * 先に別のミドルウェア（httpNodeMiddleware の body-parser など）が読んでいたら、それを使う。
 * 既定の根が同じサーバーでは、エディタの body-parser（上限 5 MB）がいつも先に読むので、根に依らず同じ上限になるよう大きさを見る。
 */
async function parseJsonBody(req) {
  if (req._body || (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body))) {
    const n = Number(header(req, 'content-length'))
    const size = Number.isFinite(n) && n > 0 ? n : Buffer.byteLength(JSON.stringify(req.body === undefined ? null : req.body), 'utf8')
    if (size > MAX_BODY_BYTES) throw tooLargeBody(MAX_BODY_BYTES)
    return req.body
  }
  let text
  if (typeof req.body === 'string') text = req.body
  else if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8')
  else text = await readBody(req, MAX_BODY_BYTES)
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw tooLargeBody(MAX_BODY_BYTES)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { _: '本文を JSON として読めません' })
  }
}

/**
 * Node-RED に API・SSE・画面を登録する。同じ RED には 1 回だけ。
 * @param {object} RED
 * @param {object} [options] {registry, store, uiDir, sse: {…}, now, timeouts, diagIntervalMs}
 * @returns {object} runtime（設定ノードが運用設定の照合と適用に、wsuha-broute がフローの入力に使う）
 */
function install(RED, options) {
  const o = options || {}
  if (RED && typeof RED === 'object' && installed.has(RED)) return installed.get(RED)

  const registry = o.registry || getRegistry()
  const now = typeof o.now === 'function' ? o.now : Date.now
  // 待ちの上限 [ms]。上限を過ぎたら 504 を返す（元の処理は続く）。試験で詰められるようにしてある。
  // terminate は SKJOIN の最中だと 38 秒ほどかかる（SKTERM が認証の終わりまで保留になる）
  const TO = Object.assign({ terminate: 70000, get: 30000, diag: 15000 }, o.timeouts || {})
  const diagIntervalMs = typeof o.diagIntervalMs === 'number' ? o.diagIntervalMs : DIAG_INTERVAL_MS
  const settings = (RED && RED.settings) || {}
  const log = (level, text) => {
    try {
      if (RED && RED.log && typeof RED.log[level] === 'function') RED.log[level]('[wsuha-broute] ' + text)
    } catch (e) {
      /* ログに出せなくても続ける */
    }
  }
  const audit = (event, req, extra) => {
    try {
      if (RED && RED.log && typeof RED.log.audit === 'function') {
        RED.log.audit(Object.assign({ event: 'wsuha-broute.' + event }, extra || {}), req)
      }
    } catch (e) {
      /* 同上 */
    }
  }

  const userDir = settings.userDir
  const store =
    o.store ||
    createSettingsStore({
      file: userDir ? path.join(userDir, 'wsuha-broute', 'settings.json') : null,
      log: (level, text) => log(level === 'warn' ? 'warn' : 'info', text),
      now,
    })
  if (!userDir) log('warn', 'userDir が分からないため、運用設定・接続の設定・Web UI で保存した認証情報は再起動で消えます')
  // 画面かフローで保存した B ルート認証情報。settings.json には入れない
  const credStore =
    o.credStore ||
    createCredentialsStore({
      dir: userDir ? path.join(userDir, 'wsuha-broute', 'credentials') : null,
      log: (level, text) => log(level === 'warn' ? 'warn' : 'info', text),
      now,
    })

  // 画面とフローからのアダプタの追加。runtime API の実体を探すのは、使うとき（Meta・POST）に
  const flowWriter =
    o.flowWriter !== undefined
      ? o.flowWriter
      : createFlowWriter({ RED, log: (level, text) => log(level === 'warn' ? 'warn' : 'info', text), runtimeApi: o.runtimeApi, version: o.nodeRedVersion })
  const eachNode =
    typeof o.eachNode === 'function'
      ? o.eachNode
      : RED && RED.nodes && typeof RED.nodes.eachNode === 'function'
        ? (cb) => RED.nodes.eachNode(cb)
        : undefined
  const service = svc.createService({
    registry,
    store,
    credStore,
    log,
    now,
    timeouts: Object.assign({ get: TO.get, diag: TO.diag }, typeof TO.addClaim === 'number' ? { addClaim: TO.addClaim } : {}),
    // readOnly・uiConfig・editorRoot（Meta）は settings.js の値を毎回読む
    settings: () => (RED && RED.settings) || {},
    nodeRedVersion: () => (RED && typeof RED.version === 'function' ? RED.version() : null),
    listPorts: o.listPorts,
    realpath: o.realpath,
    eachNode,
    flowWriter,
    env: o.env,
    // 誰が変えたかを残すときだけ、呼んだ側が要求の控えを渡す（requestLogOf。本文は入れない）
    audit: (event, extra, reqLog) => audit(event, reqLog || null, extra),
  })
  const readOnly = service.readOnly

  // ---------------------------------------------------------------------------
  //  view
  // ---------------------------------------------------------------------------

  const views = {
    // SSE の adapters。画面の GET adapters・フローの adapters と同じ関数（service.js）。total も載せる
    summaries: () => service.summaries(),
    adapters: () => service.listAdapters(),
    detail: (id) => {
      const h = registry.get(id)
      return h && h.claimed ? vm.buildDetail(h.inspect(), now()) : null
    },
    measurement: (id, result) => {
      const h = registry.get(id)
      if (!h || !h.claimed) return null
      return vm.valueRowsFromValues(h.inspect(), result && result.values, now())
    },
    settings: (id) => {
      const h = registry.get(id)
      return h && h.claimed ? service.settingsOf(h) : null
    },
    // SSE の config（構成が変わったとき）
    config: (id) => {
      const h = registry.get(id)
      return h && h.claimed ? service.configOf(h) : null
    },
  }

  // ---------------------------------------------------------------------------
  //  フローに無い台の、保存した値
  // ---------------------------------------------------------------------------
  //
  //  設定ノードを消しても、画面かフローで保存した認証情報（credentials/<id>.json）と settings.json の adapters[id] は残す
  //  （無効化・切り取り → 貼り付けで値を失わないため）。
  //  代わりにデプロイが済むたびに、フローに無い id の数を Node-RED のログに warn 1 行で知らせる（値は出さない。id は出す）。
  //  同じ顔ぶれのままのデプロイでは繰り返さない。

  let orphanKey = ''

  /**
   * フローの中の wsuha-device の id（Node-RED で無効にした設定ノードも数える）。
   * complete は eachNode でフローが見えたか。見えなければ registry で代えるので、フローの全部とは言えない。
   * サブフローの中の設定ノードは、動くときの id が <インスタンス>-<テンプレート> で、eachNode にはテンプレートの id しか出ない。
   * 今いる台を足さないと、動いている台の値を「フローに無い」と知らせ、値の無い記録は片付けてしまう。
   */
  function flowDevices() {
    const ids = new Set()
    let complete = false
    if (eachNode) {
      try {
        eachNode((n) => {
          complete = true
          if (n && n.type === 'wsuha-device') ids.add(String(n.id))
        })
      } catch (err) {
        complete = false
      }
    }
    for (const h of complete ? registry.list() : registry.all()) ids.add(h.id)
    return { ids, complete }
  }

  /** 画面かフローで保存した値を持つ記録か。足した印（created）と版だけの記録は、消しても失う値が無い。 */
  function hasSavedValues(id) {
    if (typeof store.get !== 'function') return true
    const r = store.get(id)
    if (!r) return false
    return Object.keys(r.fields || {}).length > 0 || Object.keys(r.config || {}).length > 0
  }

  function warnOrphans() {
    const { ids: live, complete } = flowDevices()
    let creds = []
    let recs = []
    try {
      creds = typeof credStore.ids === 'function' ? credStore.ids() : []
    } catch (e) {
      creds = []
    }
    try {
      recs = typeof store.ids === 'function' ? store.ids() : []
    } catch (e) {
      recs = []
    }
    const oc = creds.filter((id) => !live.has(String(id))).sort()
    const gone = recs.filter((id) => !live.has(String(id)))
    const orphans = gone.filter(hasSavedValues).sort()
    // 足した台をエディタで消すのが正規の手順なので、値の無い記録はここで片付ける（残すと再起動のたびに知らせることになる）。
    // フローが見えていないときは、居る台の記録を消さないように触らない
    if (complete && typeof store.forget === 'function') {
      for (const id of gone) {
        if (orphans.indexOf(id) >= 0) continue
        try {
          store.forget(id)
        } catch (err) {
          log('warn', '消した台の記録を片付けられませんでした: ' + err.message)
        }
      }
    }
    const key = oc.join(',') + '|' + orphans.join(',')
    if (key === orphanKey) return
    orphanKey = key
    if (!oc.length && !orphans.length) return
    const all = Array.from(new Set(oc.concat(orphans))).sort()
    const shown = all.slice(0, 10).join(', ') + (all.length > 10 ? ` ほか ${all.length - 10} 件` : '')
    log(
      'warn',
      `フローに無い設定ノード ${all.length} 台分の、Web UI かフローで保存した値が残っています` +
        `（認証情報 ${oc.length} 件・運用設定と接続の設定 ${orphans.length} 件。id: ${shown}）。` +
        '同じ id の設定ノードを読み込み直すと、また効きます。要らなければ、Node-RED を止めてから <userDir>/wsuha-broute/credentials/<id>.json と ' +
        'settings.json の adapters の <id> を消してください（settings.json は、動いている間に消しても次の保存で戻ります。README の「消した台の値」）'
    )
  }

  // ---------------------------------------------------------------------------
  //  Node-RED のイベント（画面を載せないときも登録する）
  // ---------------------------------------------------------------------------
  let hub = null
  const events = RED && RED.events
  if (events && typeof events.on === 'function') {
    // デプロイが済んだら、フローから消えた設定ノードの handle を片付け、
    // エディタの変更で外れた運用設定を wsuha-broute の出力 2 へ知らせる
    events.on('flows:started', () => {
      try {
        registry.prune()
      } catch (err) {
        log('warn', 'アダプタの一覧を片付けられませんでした: ' + err.message)
      }
      try {
        warnOrphans()
      } catch (err) {
        /* 知らせられなくても続ける */
      }
      for (const h of registry.list()) {
        try {
          h.flushSettingsNotice()
        } catch (err) {
          log('warn', '運用設定の変化を知らせられませんでした: ' + err.message)
        }
        try {
          h.flushConfigNotice()
        } catch (err) {
          log('warn', '接続の設定の変化を知らせられませんでした: ' + err.message)
        }
      }
    })
    // Node-RED が止まるとき（デプロイ以外の停止）は、預かっていたフローの入力を SHUTDOWN で返し、SSE を全部閉じる。
    // Node-RED 3.1 はフローを止め終えてから runtime-state の stop（deploy なし）を出す。デプロイ（deploy: true）では返さない
    // （預かったものは、作り直した設定ノードの新しい sequencer で続ける）。
    // 3.1.3 では、この時点で下流のノードも Catch も閉じている（flows/index.js は flows:stopped のあとにこれを出す）ので、
    // 返した error は出力 2 にも Catch にも届かない（Catch が無ければ done(err) の [error] が 1 行ずつ出るだけ）。
    // 閉じる前の合図（flows:stopping）はデプロイと停止で見分けられないので、取りやめた件数は Catch の有無に関係なく
    // Node-RED のログに warn で 1 行残す
    events.on('runtime-event', (ev) => {
      try {
        if (ev && ev.id === 'runtime-state' && ev.payload && ev.payload.state === 'stop' && !ev.payload.deploy) {
          for (const h of registry.all()) {
            try {
              const n = h.pending ? h.pending.shutdown() : 0
              if (n > 0) {
                const m = h.meta || {}
                const name = m.name || m.role || h.id
                log(
                  'warn',
                  `${name} (${h.id}): Node-RED を止めるため、預かっていた指示 ${n} 件を取りやめました` +
                    '（止めるときは下流のノードと Catch がもう閉じているので、出力 2 の error と Catch には届きません）'
                )
              }
            } catch (err) {
              log('warn', '預かっていた指示を返せませんでした: ' + err.message)
            }
          }
          if (hub) hub.closeAll()
        }
      } catch (err) {
        /* 閉じられなくても続ける */
      }
    })
  }

  const runtime = {
    registry,
    store,
    // 画面とフローからのアダプタの追加（flow-writer.js）
    flowWriter,
    // 画面かフローで保存した認証情報。読み出し（read）は設定ノードだけが使う（値を画面とログに出さない）
    credentials: credStore,
    service,
    hub: null,
    views,
    handlers: null,
    mounted: false,
    reconcile: service.reconcile,
    applyStored: service.applyStored,
    fallbackValue: service.fallbackValue,
    settingsOf: service.settingsOf,
    skipped: [],
    uiProblem: null,
    /** 画面と API を載せなかった理由（載せたら null）。エディタの「Web UI で開く」を隠すのに使う。 */
    notMountedReason: null,
  }
  if (RED && typeof RED === 'object') installed.set(RED, runtime)

  // ---------------------------------------------------------------------------
  //  載せるかどうか
  // ---------------------------------------------------------------------------
  let notMounted = null
  if (settings.httpNodeRoot === false) notMounted = 'settings.js の httpNodeRoot が false です'
  else if (settings.wsuhaBroute && settings.wsuhaBroute.ui === false) notMounted = 'settings.js の wsuhaBroute.ui が false です'
  else if (!RED || !RED.httpNode) notMounted = 'RED.httpNode がありません'
  if (notMounted) {
    log('warn', `Web UI と API を載せません: ${notMounted}。運用設定とフローの入力は動きます`)
    runtime.notMountedReason = notMounted
    return runtime
  }

  hub = createSseHub({
    registry,
    views,
    // 本数の上限は settings.js の wsuhaBroute.sse（{maxConnections, maxPerClient}。正の整数だけ）でも変えられる
    options: Object.assign(sseLimitsFrom(settings.wsuhaBroute && settings.wsuhaBroute.sse), o.sse || {}),
    now,
    onError: (err) => log('warn', 'SSE: ' + (err && err.message)),
  })
  runtime.hub = hub

  // ---------------------------------------------------------------------------
  //  ECHONET の待ち行列を API で埋めない
  // ---------------------------------------------------------------------------
  //
  //  sequencer の ECHONET 要求は 1 本ずつで、待ち行列の上限（maxQueuedRequests、既定 4）を
  //  超えると「滞留しています」で断る。画面の連打で待ち行列を埋めると、周期の取得が断られる
  //  （滞留は取りこぼしに数えないが、その回の計測は抜ける）。
  //  そこで画面から足す ECHONET の要求は、1 台あたり 1 本までにする（フローの入力には掛けない）。

  /** API からの ECHONET の要求が終わっていない sequencer（作り直した sequencer は別に数える）。 */
  const apiInFlight = new WeakSet()

  function requireApiSlot(seq) {
    if (apiInFlight.has(seq)) {
      throw new ApiError(409, 'BUSY', '前の取得がまだ終わっていません。終わってからもう一度試してください')
    }
  }

  /**
   * API からの ECHONET の要求を 1 台あたり 1 本にして始める。
   * 待ちの上限（504）で先に返しても、元の要求が終わるまでは次を受け付けない
   * （返したあとも待ち行列には残っているため）。
   */
  function startApiRequest(seq, start) {
    requireApiSlot(seq)
    apiInFlight.add(seq)
    let p
    try {
      p = Promise.resolve(start())
    } catch (err) {
      apiInFlight.delete(seq)
      throw err
    }
    const done = () => apiInFlight.delete(seq)
    p.then(done, done)
    return p
  }

  /** 診断とメーターへの取り直しが最後に使った時刻（台ごと。電波と待ち行列を取り合うので同じ枠にする）。 */
  const radioAt = new Map()

  /** 枠が空いていれば今の時刻を返す。空いていなければ 429。断るときに枠を使わないよう、使うのは呼んだ側が radioAt に書いてから。 */
  function requireRadioWindow(id, label) {
    const t = now()
    const last = radioAt.get(id) || 0
    if (last && t - last < diagIntervalMs) {
      const retry = Math.max(1, Math.ceil((last + diagIntervalMs - t) / 1000))
      throw new ApiError(429, 'RATE_LIMITED', `${label}は 1 台あたり ${diagIntervalMs / 1000} 秒に 1 回までです。${retry} 秒待ってください`, null, {
        'Retry-After': String(retry),
      })
    }
    return t
  }

  // ---------------------------------------------------------------------------
  //  全部のルートの前（CORS のヘッダを外す・Host を照らす）
  // ---------------------------------------------------------------------------

  /**
   * a. CORS のヘッダを外す。httpAdminRoot と httpNodeRoot が同じ '/' だと、エディタの cors({origin:'*'})
   *    （@node-red/editor-api）がこちらの応答にも先に付ける。プリフライト（OPTIONS）はエディタが先に 204 で返すので
   *    ここでは止められないが、本物の要求の応答に Allow-Origin が無ければ、ブラウザは別のサイトのページに中身を渡さない。
   */
  function stripCors(req, res, next) {
    for (const k of CORS_HEADERS) {
      try {
        res.removeHeader(k)
      } catch (e) {
        /* 送ったあとなどで外せなくても続ける */
      }
    }
    next()
  }

  const hostPolicy = { allowedHosts: normalizeAllowedHosts(settings.wsuhaBroute && settings.wsuhaBroute.allowedHosts) }
  const badHostSeen = new Set()

  /** b. Host を許可リストで照らす。json は API（JSON で返す）か画面（文で返す）か。 */
  function hostGuard(json) {
    return function requireAllowedHost(req, res, next) {
      const host = header(req, 'host')
      if (isAllowedHost(host, hostPolicy)) return next()
      const name = hostNameOf(host) || '(読めない値)'
      if (!badHostSeen.has(name) && badHostSeen.size < 100) {
        badHostSeen.add(name)
        log(
          'warn',
          `許可していないホスト名（Host ${String(host).slice(0, 200)}）での要求を断りました（DNS リバインディングの対策）。` +
            `この名前で Web UI を開くなら、settings.js の wsuhaBroute.allowedHosts に追加してください（例: allowedHosts: ['${name}']）`
        )
      }
      const message =
        `このアドレス（${name}）では Web UI と API を開けません。IP アドレスか localhost で開くか、` +
        `Node-RED の settings.js の wsuhaBroute.allowedHosts にこの名前を追加してください`
      if (json) return sendError(res, new ApiError(403, 'BAD_HOST', message))
      res.statusCode = 403
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(message)
    }
  }

  // ---------------------------------------------------------------------------
  //  書き込みの守り
  // ---------------------------------------------------------------------------

  /** 1. application/json でなければ 415 で止める（本文の無い actions も同じ）。 */
  function requireJson(req, res, next) {
    if (isJsonRequest(req)) return next()
    sendError(
      res,
      new ApiError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        '書き込みの要求には Content-Type: application/json を付けてください（フォームや text/plain の送信は受け付けません）'
      )
    )
  }

  const badOriginSeen = new Set()
  /** 2. Origin があって Host と同じオリジンでなければ 403 BAD_ORIGIN。 */
  function requireSameOrigin(req, res, next) {
    if (isSameOrigin(req)) return next()
    const key = `${String(header(req, 'origin')).slice(0, 200)} | ${String(header(req, 'host') || '').slice(0, 200)}`
    if (!badOriginSeen.has(key) && badOriginSeen.size < 100) {
      badOriginSeen.add(key)
      log(
        'warn',
        `別のオリジンからの書き込みを断りました（Origin ${key.replace(' | ', '・Host ')}）。` +
          'リバースプロキシを通しているなら、Host を書き換えないでください（nginx なら proxy_set_header Host $host）。' +
          'TLS を終端するときは X-Forwarded-Proto も渡してください（nginx なら proxy_set_header X-Forwarded-Proto $scheme）'
      )
    }
    sendError(res, new ApiError(403, 'BAD_ORIGIN', '別のサイト（オリジン）からの操作は受け付けません。この画面のアドレスから操作してください'))
  }

  const editorAuth = createEditorAuth({ RED, log, editorRootOf: svc.editorRootOf })
  editorAuth.warnIfClosed()
  let deniedWarnAt = null
  let deniedSkipped = 0

  /** 認証を通らなかった変更を残す（値は入れない）。監査は毎回、warn は続いたら間引いて件数だけ次に書く。 */
  function recordDenied(req, err) {
    audit('auth.denied', req, { code: err.code, method: req.method })
    const t = now()
    if (deniedWarnAt !== null && t - deniedWarnAt < DENIED_WARN_MS) {
      deniedSkipped += 1
      return
    }
    deniedWarnAt = t
    const more = deniedSkipped ? `。前の知らせのあと、ほかに ${deniedSkipped} 件を断っています` : ''
    deniedSkipped = 0
    const where = String(req.originalUrl || req.url || '').split('?')[0].slice(0, 200)
    log('warn', `認証を通らなかった変更を断りました（${err.code}・${req.method} ${where}・接続元 ${clientIpOf(req) || '不明'}${more}）`)
  }

  /** 変更に認証が要るサーバーで、この要求が変更できることを確かめる。できなければ 401 か 403 を投げる。 */
  async function authorize(req) {
    const r = await editorAuth.check(req)
    if (r.canWrite) return
    const err =
      r.denied === 'forbidden'
        ? new ApiError(403, 'FORBIDDEN', FORBIDDEN_MESSAGE)
        : new ApiError(401, 'LOGIN_REQUIRED', editorAuth.closed() ? NO_LOGIN_MESSAGE : LOGIN_REQUIRED_MESSAGE)
    recordDenied(req, err)
    throw err
  }

  /** 3. 変更に認証が要るサーバーでは、エディタのトークンで確かめる。 */
  function requireLogin(req, res, next) {
    if (!editorAuth.required()) return next()
    authorize(req).then(
      () => next(),
      (err) => {
        // 確かめる途中の思わぬ失敗も、通さない側に倒す
        const e = err instanceof ApiError ? err : new ApiError(401, 'LOGIN_REQUIRED', LOGIN_REQUIRED_MESSAGE)
        try {
          if (!res.headersSent) sendError(res, e)
        } catch (e2) {
          /* 返せなくても落とさない */
        }
      }
    )
  }

  /** 4. settings.js の wsuhaBroute.readOnly === true なら 403 READ_ONLY。 */
  function requireWritable(req, res, next) {
    if (!readOnly()) return next()
    sendError(res, new ApiError(403, 'READ_ONLY', READ_ONLY_MESSAGE))
  }

  /** 5. 構成と認証情報の書き込みだけ: settings.js の wsuhaBroute.uiConfig === false なら 403 CONFIG_LOCKED。 */
  function requireConfigWritable(req, res, next) {
    if (!service.configLocked()) return next()
    sendError(res, new ApiError(403, 'CONFIG_LOCKED', svc.CONFIG_LOCKED_MESSAGE))
  }

  /** 5. アダプタの追加だけ: uiConfig === false か uiAddAdapter === false なら 403 CONFIG_LOCKED。 */
  function requireAddWritable(req, res, next) {
    if (service.configLocked()) return sendError(res, new ApiError(403, 'CONFIG_LOCKED', svc.CONFIG_LOCKED_MESSAGE))
    if (service.addLocked()) return sendError(res, new ApiError(403, 'CONFIG_LOCKED', svc.ADD_LOCKED_MESSAGE))
    next()
  }

  /** 6. 本文を JSON として読む（Node-RED の httpNode は読まない）。 */
  function readJson(req, res, next) {
    parseJsonBody(req).then(
      (body) => {
        req.body = body
        next()
      },
      (err) => {
        const e = err instanceof ApiError ? err : new ApiError(422, 'VALIDATION', '本文を読めませんでした', { _: '本文を読めませんでした' })
        try {
          if (!res.headersSent) sendError(res, e)
        } catch (e2) {
          /* 返せなくても落とさない */
        }
      }
    )
  }

  // ---------------------------------------------------------------------------
  //  ハンドラ
  // ---------------------------------------------------------------------------

  function adapterOr404(req) {
    return service.adapter(req.params && req.params.id)
  }

  const handlers = {}

  // 読み出し（meta・adapters・trend・logs）の中身と検証は service.js。フローの入力（topic が同じ名前）と同じ関数を通る

  handlers.meta = (req, res) => {
    sendJson(res, 200, Object.assign(service.metaOf(), { auth: editorAuth.meta() }))
  }

  /** 画面が操作を止めるかを決めるための返事。読むだけなので、匿名でも切れたトークンでも 200。 */
  handlers.session = async (req, res) => {
    sendJson(res, 200, await editorAuth.session(req))
  }

  handlers.adapters = (req, res) => {
    sendJson(res, 200, service.listAdapters())
  }

  handlers.adapter = (req, res) => {
    const h = adapterOr404(req)
    sendJson(res, 200, service.detailOf(h))
  }

  handlers.values = (req, res) => {
    const h = adapterOr404(req)
    const t = now()
    sendJson(res, 200, { items: vm.buildValueRows(h.inspect(), t), at: t })
  }

  handlers.trend = (req, res) => {
    const h = adapterOr404(req)
    sendJson(res, 200, service.trendOf(h, queryOf(req).range))
  }

  handlers.logs = (req, res) => {
    const h = adapterOr404(req)
    const q = queryOf(req)
    sendJson(res, 200, service.logsOf(h, { after: q.after, limit: q.limit, level: q.level }))
  }

  // --- 最新値の読み出し -----------------------------------------------------------
  //  maxAgeSec が無いか、頼んだ値が全部それより新しければ、無線を使わずに持っている値で答える（誰でも読める）。
  //  取りに行くとき（電波を使う）は GET でも変更と同じに守る。順は次のとおり:
  //    X-Wsuha-Radio が無い・別のサイトから → 403 BAD_ORIGIN（GET は img などで別のサイトからも送れる）
  //    認証 → 401 LOGIN_REQUIRED・403 FORBIDDEN、読み出しのみ → 403 READ_ONLY
  //    頼んだ EPC のうち取り直すものが 7 個以上 → 422 VALIDATION（定期取得の値を全部取り直すときは数を問わない）
  //    未接続 → すぐ 503（画面の API は預からない）、1 台 3 秒の枠 → 429 RATE_LIMITED、1 台 1 本 → 409 BUSY、上限を過ぎたら 504

  handlers.read = async (req, res) => {
    const h = adapterOr404(req)
    const rq = readValues.parseReadQuery(queryOf(req))
    const stale = service.staleOf(h, rq)
    if (!stale.length) {
      sendJson(res, 200, service.readOf(h, rq))
      return
    }
    if (!isSameOrigin(req) || crossSiteFetch(req)) {
      throw new ApiError(403, 'BAD_ORIGIN', '別のサイト（オリジン）からは、メーターへ取りに行く読み出し（maxAgeSec）を受け付けません。この画面のアドレスから開いてください')
    }
    if (!hasRadioHeader(req)) {
      throw new ApiError(
        403,
        'BAD_ORIGIN',
        'メーターへ取りに行く読み出し（maxAgeSec）には X-Wsuha-Radio: 1 のヘッダーが要ります。別のサイトから電波を使わせないためです。スクリプトから呼ぶときは、このヘッダーを付けてください'
      )
    }
    if (editorAuth.required()) await authorize(req)
    if (readOnly()) throw new ApiError(403, 'READ_ONLY', READ_ONLY_MESSAGE)
    if (rq.epcs && stale.length > MAX_REFRESH_EPCS) {
      throw new ApiError(422, 'VALIDATION', '入力を確かめてください', {
        epcs: `メーターへ取りに行けるのは 1 回に ${MAX_REFRESH_EPCS} 個までです（今回は ${stale.length} 個）。分けて読み出してください`,
      })
    }
    const seq = service.requireUsable(h)
    service.requireMeter(seq)
    const t = requireRadioWindow(h.id, 'メーターへの取り直し')
    requireApiSlot(seq)
    radioAt.set(h.id, t)
    // 取りに行き始めた時刻（値の at と同じ Date.now）。これより後に取れた値は fresh
    let since = null
    await withTimeout(
      startApiRequest(seq, () => {
        since = Date.now()
        return service.refreshValues(seq, stale)
      }),
      TO.get,
      '取得'
    )
    audit('read', req, { adapterId: h.id, by: WEB_UI, refreshed: stale.length })
    sendJson(res, 200, service.readOf(h, rq, { refreshed: stale, refreshedSince: since }))
  }

  handlers.getSettings = (req, res) => {
    const h = adapterOr404(req)
    const s = service.settingsOf(h)
    sendJson(res, 200, s, { ETag: `"${s.rev}"` })
  }

  /** 画面の保存は If-Match が必須（無い・違うなら 412）。 */
  function ifMatchOf(h, req) {
    const ifMatch = parseIfMatch(req)
    if (ifMatch === null) {
      throw new ApiError(412, 'REVISION_MISMATCH', '版（If-Match）が付いていません。設定を読み直してから保存してください')
    }
    if (ifMatch !== service.revOf(h)) throw new ApiError(412, 'REVISION_MISMATCH', 'ほかの場所で先に変更されました。読み直してください')
    return ifMatch
  }

  handlers.putSettings = (req, res) => {
    const h = adapterOr404(req)
    const ifMatch = ifMatchOf(h, req)
    const s = service.saveSettings(h, req.body, { by: WEB_UI, ifMatch })
    audit('settings.put', req, { adapterId: h.id, by: WEB_UI })
    sendJson(res, 200, s, { ETag: `"${s.rev}"` })
  }

  handlers.deleteSettings = (req, res) => {
    const h = adapterOr404(req)
    const ifMatch = ifMatchOf(h, req)
    const s = service.clearSettings(h, { by: WEB_UI, ifMatch })
    audit('settings.delete', req, { adapterId: h.id, by: WEB_UI })
    sendJson(res, 200, s, { ETag: `"${s.rev}"` })
  }

  // --- 構成と認証情報 ------------------------------------

  handlers.serialports = async (req, res) => {
    sendJson(res, 200, await service.serialPorts())
  }

  handlers.getConfig = (req, res) => {
    const h = adapterOr404(req)
    const c = service.configOf(h)
    sendJson(res, 200, c, { ETag: `"${c.rev}"` })
  }

  /** 構成の保存も If-Match が必須（無い・違うなら 412）。版は運用設定とは別（configRev）。 */
  function configIfMatchOf(h, req) {
    const ifMatch = parseIfMatch(req)
    if (ifMatch === null) {
      throw new ApiError(412, 'REVISION_MISMATCH', '版（If-Match）が付いていません。接続の設定を読み直してから保存してください')
    }
    if (ifMatch !== service.configRevOf(h)) throw new ApiError(412, 'REVISION_MISMATCH', 'ほかの場所で先に変更されました。読み直してください')
    return ifMatch
  }

  handlers.putConfig = (req, res) => {
    const h = adapterOr404(req)
    const ifMatch = configIfMatchOf(h, req)
    const fields = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body).slice(0, 20) : []
    const c = service.saveConfig(h, req.body, { by: WEB_UI, ifMatch })
    audit('config.put', req, { adapterId: h.id, by: WEB_UI, fields })
    sendJson(res, 200, c, { ETag: `"${c.rev}"` })
  }

  handlers.deleteConfig = (req, res) => {
    const h = adapterOr404(req)
    const ifMatch = configIfMatchOf(h, req)
    const c = service.clearConfig(h, { by: WEB_UI, ifMatch })
    audit('config.delete', req, { adapterId: h.id, by: WEB_UI })
    sendJson(res, 200, c, { ETag: `"${c.rev}"` })
  }

  /** 応答に値を入れない（Config ごと返す。credentials は configured・source・pairId・envOverrides・stored だけ）。 */
  handlers.putCredentials = (req, res) => {
    const h = adapterOr404(req)
    service.saveCredentials(h, req.body, { by: WEB_UI })
    // 監査には誰がどの台を変えたかだけ（本文は入れない）
    audit('credentials.put', req, { adapterId: h.id, by: WEB_UI })
    const c = service.configOf(h)
    sendJson(res, 200, c, { ETag: `"${c.rev}"` })
  }

  handlers.deleteCredentials = (req, res) => {
    const h = adapterOr404(req)
    service.clearCredentials(h, { by: WEB_UI })
    audit('credentials.delete', req, { adapterId: h.id, by: WEB_UI })
    const c = service.configOf(h)
    sendJson(res, 200, c, { ETag: `"${c.rev}"` })
  }

  // --- アダプタの追加 ------------------------------------
  //  中身は service.addAdapter（フローの add-adapter と同じ関数）。201 = 動き出した・202 = フローには足した（まだ動いていない）。
  //  Location は相対（adapters/<id>）。本文の認証情報は応答・監査・ログに入れない

  handlers.addAdapter = async (req, res) => {
    const out = await service.addAdapter(req.body, { by: WEB_UI, ip: clientIpOf(req), reqLog: requestLogOf(req) })
    const status = out.started ? 201 : 202
    sendJson(res, status, out, { Location: 'adapters/' + encodeURIComponent(out.nodes.deviceId) })
  }

  handlers.action = async (req, res) => {
    const h = adapterOr404(req)
    const action = String((req.params && req.params.action) || '')
    if (ACTIONS.indexOf(action) < 0) throw new ApiError(404, 'NOT_FOUND', `対応していない操作です: ${action.slice(0, 40)}`)
    const body = req.body && typeof req.body === 'object' ? req.body : {}

    // 入力の検査（状態より先に）
    let reason = null
    let ladder
    let epcs = null
    if (action === 'stop') {
      reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (reason.length < 1 || reason.length > 200) {
        throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { reason: '止める理由を 1〜200 文字で書いてください' })
      }
    }
    if (action === 'reconnect' && body.ladder !== undefined && body.ladder !== null) {
      if (!isInt(body.ladder) || body.ladder < 0 || body.ladder > 3) {
        throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { ladder: '0〜3 の整数で指定してください' })
      }
      ladder = body.ladder
    }
    if (action === 'get') epcs = parseEpcList(body.epcs, 'epcs')

    const seq = service.requireUsable(h)
    let message = ''
    let result
    switch (action) {
      case 'start': {
        const was = seq.isRunning()
        await seq.start()
        if (seq.state.phase === 'need-secrets') {
          throw new ApiError(503, 'NOT_CONNECTED', 'B ルートの認証 ID とパスワードが未設定か書式が違うため、開始できません。設定タブで入れてください')
        }
        message = was ? 'すでに自動運転中です' : '自動運転を始めました'
        break
      }
      case 'stop':
        await seq.stop(reason, { external: true })
        // 停止の上書きはデプロイをまたいで残る（registry の AdapterHandle が持ち越す）
        message = '自動運転を止めました。止めた状態はデプロイしても続きます（「開始」か「自動運転に戻す」で再開します。Node-RED を再起動しても自動運転に戻ります）'
        break
      case 'auto':
        seq.resetOverrides('Web UI')
        message = '上書きを外して、設定どおりの自動運転に戻しました'
        break
      case 'reconnect':
        if (seq.state.overrides.stopped) {
          throw new ApiError(
            409,
            'STOPPED_BY_OVERRIDE',
            '外部の指示で停止中のため再接続しません。先に「開始」か「自動運転に戻す」を押してください'
          )
        }
        await seq.reconnect('画面から', ladder)
        message = ladder === undefined ? '再接続します' : `段 ${ladder} から再接続します`
        break
      case 'terminate':
        service.requirePort(seq)
        await withTimeout(seq.terminate(), TO.terminate, 'セッションの終了')
        message = 'メーターとのセッションを終了して止めました。「開始」か「自動運転に戻す」で再開します'
        break
      case 'poll':
        service.requireMeter(seq)
        // 押すたびに取得を足すと、溢れた分が待ち行列から断られる（上の説明）。
        // 取得の途中なら、その取得が「今すぐの取得」になるので、足さずに 409 で知らせる。
        // 同じ瞬間に 2 回届いても、pollNow は前のタイマーを消してから張るので 1 回にまとまる
        if (seq.isEchonetBusy()) {
          throw new ApiError(409, 'BUSY', 'いま取得の途中です。終わってからもう一度押してください')
        }
        seq.pollNow()
        message = '今すぐ取得します'
        break
      case 'get': {
        service.requireMeter(seq)
        const r = await withTimeout(
          startApiRequest(seq, () => seq.get(epcs, 'manual')),
          TO.get,
          '取得'
        )
        result = vm.valueRowsFromValues(h.inspect(), r && r.values, now())
        message = `${result.length} 件取得しました`
        break
      }
      case 'clear-radio-block':
        message = seq.clearRadioBlock() ? '送信制限の扱いを解除しました' : '送信制限は掛かっていません'
        break
    }
    h.log('info', `画面から「${ACTION_LABEL[action]}」を実行しました${reason ? '（理由: ' + reason + '）' : ''}`)
    audit('action', req, { adapterId: h.id, action, by: WEB_UI })
    const out = { ok: true, message, adapter: service.detailOf(h) }
    if (result !== undefined) out.result = result
    sendJson(res, 200, out)
  }

  const diagBusy = new Set()

  handlers.diag = async (req, res) => {
    const h = adapterOr404(req)
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const prepared = service.prepareDiag(h, body)
    const t = requireRadioWindow(h.id, '診断')
    if (diagBusy.has(h.id)) throw new ApiError(409, 'BUSY', '前の診断がまだ終わっていません。終わってからもう一度試してください')
    // 電波を使う取得は「指定の取得」と同じ枠（1 台 1 本）。断るときは 3 秒の枠を使わない
    if (prepared.plan.epcs) requireApiSlot(prepared.seq)
    radioAt.set(h.id, t)
    diagBusy.add(h.id)
    try {
      const out = await service.executeDiag(h, prepared, { by: WEB_UI, startGet: startApiRequest })
      audit('diag', req, { adapterId: h.id, name: out.name, by: WEB_UI })
      sendJson(res, 200, out)
    } finally {
      diagBusy.delete(h.id)
    }
  }

  handlers.stream = (req, res) => {
    const q = queryOf(req)
    const adapterId = q.adapter === undefined || q.adapter === '' ? null : String(q.adapter)
    if (adapterId !== null) {
      const h = registry.get(adapterId)
      if (!h || !h.claimed) throw new ApiError(404, 'ADAPTER_NOT_FOUND', 'アダプタが見つかりません')
    }
    const lastEventId = header(req, 'last-event-id') !== undefined ? header(req, 'last-event-id') : q.lastEventId
    hub.handle(req, res, { adapterId, logs: q.logs === '1' || q.logs === 'true', lastEventId })
  }

  handlers.notFound = (req, res) => {
    throw new ApiError(404, 'NOT_FOUND', 'その API はありません')
  }

  /** 例外を 500（か対応する状態）の JSON にして返す。プロセスへ投げない。 */
  function wrap(fn) {
    return function (req, res) {
      let p
      try {
        p = Promise.resolve(fn(req, res))
      } catch (err) {
        p = Promise.reject(err)
      }
      return p.catch((err) => {
        let e = mapError(err)
        if (!e) {
          log('error', `API ${req.method || ''} ${String(req.originalUrl || req.url || '').split('?')[0]}: ${err && err.stack ? err.stack : err}`)
          e = new ApiError(500, 'INTERNAL', '内部エラーが起きました。Node-RED のログを確かめてください')
        }
        try {
          if (!res.headersSent) sendError(res, e)
          else res.end()
        } catch (e2) {
          /* 返せなくてもプロセスは落とさない */
        }
      })
    }
  }

  // ---------------------------------------------------------------------------
  //  登録（httpNode）
  // ---------------------------------------------------------------------------

  const router = RED.httpNode
  const skipped = runtime.skipped
  const apiGuard = [stripCors, hostGuard(true)]
  const uiGuard = [stripCors, hostGuard(false)]
  /** 全部のルートの前に、CORS のヘッダを外して Host を照らす（API は JSON、画面は文で断る）。 */
  function route(method, p, ...fns) {
    if (!router || typeof router[method] !== 'function') {
      skipped.push(method.toUpperCase() + ' ' + p)
      return
    }
    const guard = typeof p === 'string' && p.indexOf(BASE + '/') === 0 ? apiGuard : uiGuard
    router[method](p, ...guard, ...fns)
  }

  // 書き込み: 415 → BAD_ORIGIN → 認証 → READ_ONLY → 本文を読む、の順
  const write = [requireJson, requireSameOrigin, requireLogin, requireWritable, readJson]
  // 構成と認証情報の書き込み: READ_ONLY のあとに CONFIG_LOCKED
  const configWrite = [requireJson, requireSameOrigin, requireLogin, requireWritable, requireConfigWritable, readJson]
  // アダプタの追加: READ_ONLY のあとに CONFIG_LOCKED（uiConfig === false か uiAddAdapter === false）
  const addWrite = [requireJson, requireSameOrigin, requireLogin, requireWritable, requireAddWritable, readJson]

  route('get', BASE + '/meta', wrap(handlers.meta))
  route('get', BASE + '/session', wrap(handlers.session))
  route('get', BASE + '/serialports', wrap(handlers.serialports))
  route('get', BASE + '/adapters', wrap(handlers.adapters))
  route('post', BASE + '/adapters', ...addWrite, wrap(handlers.addAdapter))
  route('get', BASE + '/adapters/:id', wrap(handlers.adapter))
  route('get', BASE + '/adapters/:id/values', wrap(handlers.values))
  route('get', BASE + '/adapters/:id/trend', wrap(handlers.trend))
  route('get', BASE + '/adapters/:id/logs', wrap(handlers.logs))
  route('get', BASE + '/adapters/:id/read', wrap(handlers.read))
  route('get', BASE + '/adapters/:id/settings', wrap(handlers.getSettings))
  route('put', BASE + '/adapters/:id/settings', ...write, wrap(handlers.putSettings))
  route('delete', BASE + '/adapters/:id/settings', ...write, wrap(handlers.deleteSettings))
  route('get', BASE + '/adapters/:id/config', wrap(handlers.getConfig))
  route('put', BASE + '/adapters/:id/config', ...configWrite, wrap(handlers.putConfig))
  route('delete', BASE + '/adapters/:id/config', ...configWrite, wrap(handlers.deleteConfig))
  route('put', BASE + '/adapters/:id/credentials', ...configWrite, wrap(handlers.putCredentials))
  route('delete', BASE + '/adapters/:id/credentials', ...configWrite, wrap(handlers.deleteCredentials))
  route('post', BASE + '/adapters/:id/actions/:action', ...write, wrap(handlers.action))
  route('post', BASE + '/adapters/:id/diag', ...write, wrap(handlers.diag))
  route('get', BASE + '/stream', wrap(handlers.stream))
  for (const m of ['get', 'put', 'post', 'delete']) route(m, BASE + '/*', wrap(handlers.notFound))

  const ui = createStaticUi({ uiDir: o.uiDir || UI_DIR })
  route('get', /^\/wsuha-broute\/?$/, wrap(ui.redirectRoot))
  route('get', /^\/wsuha-broute\/ui(?:\/.*)?$/, wrap(ui.serve))
  if (skipped.length) log('warn', 'Web UI の API の一部を登録できませんでした（httpNode に無い）: ' + skipped.join(', '))
  const uiProblem = ui.problem()
  if (uiProblem) {
    log(
      'warn',
      `${uiProblem}。/wsuha-broute/ui/ は 404 になります（API は動きます）。` +
        'パッケージに ui/ が入っているか（package.json の files）を確かめてください'
    )
  }

  runtime.handlers = handlers
  runtime.mounted = true
  runtime.uiProblem = uiProblem
  return runtime
}

module.exports = {
  install,
  mapError,
  withTimeout,
  parseIfMatch,
  isJsonRequest,
  isSameOrigin,
  crossSiteFetch,
  hasRadioHeader,
  isAllowedHost,
  hostNameOf,
  normalizeAllowedHosts,
  parseJsonBody,
  CORS_HEADERS,
  HttpError,
  ApiError,
  BASE,
  SREG_ALLOWED: svc.SREG_ALLOWED,
  READ_ONLY_MESSAGE,
}
