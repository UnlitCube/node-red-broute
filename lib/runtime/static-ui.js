'use strict'

// ============================================================================
//  画面（ui/）の静的ファイル
// ============================================================================
//
//  {httpNodeRoot}wsuha-broute/ui/ 以下（httpNode）で、ui/ の **許可したファイルだけ** を認証なしで配る（秘密は入っていない）。
//
//  許可の規則（どれか 1 つでも外れたら 404）:
//    - パスの各部分は英数字で始まり、英数字・. _ - だけ（隠しファイル・.. ・\ ・%2F を通さない）
//    - 拡張子が下の表にある（.map・.md・ソースの元などは配らない）
//    - 実体（シンボリックリンクをたどった先）が ui/ の中のファイル
//    - 配る対象ではないもの（package.json・*.test.* など）ではない
//
//  /wsuha-broute と /wsuha-broute/ と /wsuha-broute/ui は /wsuha-broute/ui/ へ 302。
//  Location は相対で返す（httpNodeRoot やリバースプロキシの接頭辞に依らずに戻れる）。
//
//  ヘッダ: CSP（自分のオリジンだけ）・nosniff・Referrer-Policy: no-referrer・frame-ancestors 'self'・
//          Cache-Control: no-cache と ETag（入れ替えたらすぐ反映する）。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** 拡張子は許していても配らないもの（ui/package.json は Node に ES Modules と知らせるための印）。 */
const NOT_SERVED = /^(package(-lock)?\.json|.*\.(test|spec)\.[A-Za-z]+)$/i
const MAX_BYTES = 5 * 1024 * 1024
const MAX_DEPTH = 5

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function notFound(res) {
  res.statusCode = 404
  securityHeaders(res)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end('見つかりません')
}

function redirect(res, location) {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  securityHeaders(res)
  res.end()
}

function pathOf(req) {
  const p = typeof req.path === 'string' ? req.path : String(req.url || '').split('?')[0]
  return p
}

/**
 * ui/ の中の相対パスが配ってよいものか。よければ [segments] を、だめなら null を返す。
 * @param {string} rel  'index.html' や 'vendor/preact.mjs'（URL のデコード前）
 */
function allowedSegments(rel) {
  let decoded
  try {
    decoded = decodeURIComponent(rel)
  } catch (err) {
    return null
  }
  if (decoded === '') decoded = 'index.html'
  if (/[\\\0]/.test(decoded)) return null
  const segs = decoded.split('/')
  if (segs.length > MAX_DEPTH) return null
  for (const s of segs) if (!SEGMENT.test(s)) return null
  const last = segs[segs.length - 1]
  const ext = path.extname(last).toLowerCase()
  if (!TYPES[ext]) return null
  if (NOT_SERVED.test(last)) return null
  return segs
}

/**
 * @param {object} p {uiDir}
 * @returns {{redirectRoot, serve}} express のハンドラ
 */
function createStaticUi(p) {
  const uiDir = path.resolve(p.uiDir)

  function realUiDir() {
    try {
      return fs.realpathSync(uiDir)
    } catch (err) {
      return null
    }
  }

  /** /wsuha-broute と /wsuha-broute/ → ui/ */
  function redirectRoot(req, res) {
    const pth = pathOf(req)
    redirect(res, pth.endsWith('/') ? 'ui/' : 'wsuha-broute/ui/')
  }

  /** /wsuha-broute/ui と /wsuha-broute/ui/… */
  function serve(req, res) {
    const pth = pathOf(req)
    const i = pth.indexOf('/wsuha-broute/ui')
    const rest = i >= 0 ? pth.slice(i + '/wsuha-broute/ui'.length) : null
    if (rest === null) return notFound(res)
    if (rest === '') return redirect(res, 'ui/')
    if (rest[0] !== '/') return notFound(res)
    const segs = allowedSegments(rest.slice(1))
    if (!segs) return notFound(res)
    const root = realUiDir()
    if (!root) return notFound(res)
    let real
    try {
      real = fs.realpathSync(path.join(uiDir, ...segs))
    } catch (err) {
      return notFound(res)
    }
    if (real.indexOf(root + path.sep) !== 0) return notFound(res)
    let st
    try {
      st = fs.statSync(real)
    } catch (err) {
      return notFound(res)
    }
    if (!st.isFile() || st.size > MAX_BYTES) return notFound(res)
    const body = fs.readFileSync(real)
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"'
    securityHeaders(res)
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('ETag', etag)
    const inm = req.headers && req.headers['if-none-match']
    if (inm && String(inm).split(/\s*,\s*/).indexOf(etag) >= 0) {
      res.statusCode = 304
      return res.end()
    }
    res.statusCode = 200
    // 型は求められた名前の拡張子で決める（許可の判定と同じもの）
    res.setHeader('Content-Type', TYPES[path.extname(segs[segs.length - 1]).toLowerCase()])
    res.setHeader('Content-Length', String(body.length))
    if (req.method === 'HEAD') return res.end()
    res.end(body)
  }

  /**
   * 画面の入口（ui/index.html）があるか。無ければ理由の文を返す（あれば null）。
   * npm pack の files に ui/ が無いと、API は動くのに画面だけ全部 404 になり、気づきにくい。
   */
  function problem() {
    const root = realUiDir()
    if (!root) return `Web UI のディレクトリがありません: ${uiDir}`
    try {
      if (fs.statSync(path.join(root, 'index.html')).isFile()) return null
    } catch (err) {
      /* 下で返す */
    }
    return `Web UI の入口（index.html）がありません: ${path.join(uiDir, 'index.html')}`
  }

  return { redirectRoot, serve, problem }
}

module.exports = { createStaticUi, allowedSegments, CSP, TYPES }
