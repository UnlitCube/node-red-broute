'use strict'

// 画面の静的ファイル（lib/runtime/static-ui.js）。
// 許可したファイルだけを配る・ヘッダ・302・ui/ の外を読ませない。

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { install } = require('../../lib/runtime/http-api')
const { createRegistry } = require('../../lib/runtime/registry')
const { allowedSegments, CSP } = require('../../lib/runtime/static-ui')
const { createFakeRed, tmpDir } = require('./fake-red')

let fake
let rt
let root
before(() => {
  root = tmpDir('wsuha-uiroot-')
  const ui = path.join(root, 'ui')
  fs.mkdirSync(path.join(ui, 'vendor', 'LICENSES'), { recursive: true })
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>B ルート計測</title>')
  fs.writeFileSync(path.join(ui, 'app.mjs'), 'export const x = 1\n')
  fs.writeFileSync(path.join(ui, 'style.css'), 'body{}\n')
  fs.writeFileSync(path.join(ui, 'vendor', 'preact.mjs'), 'export default 1\n')
  fs.writeFileSync(path.join(ui, 'vendor', 'VERSIONS.json'), '{}\n')
  fs.writeFileSync(path.join(ui, 'vendor', 'LICENSES', 'preact.txt'), 'MIT\n')
  fs.writeFileSync(path.join(ui, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(ui, 'app.mjs.map'), '{}\n')
  fs.writeFileSync(path.join(ui, 'notes.md'), '# メモ\n')
  fs.writeFileSync(path.join(ui, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(root, 'outside.js'), 'secret\n')
  fs.mkdirSync(path.join(ui, 'dir.js'))
  try {
    fs.symlinkSync(path.join(root, 'outside.js'), path.join(ui, 'link.js'))
  } catch (e) {
    /* Windows で権限が無いと作れない。その場合は試験の 1 つを飛ばす */
  }
  // ディレクトリのジャンクション（Windows でも権限なしで作れる）で ui/ の外を指す
  fs.mkdirSync(path.join(root, 'outdir'))
  fs.writeFileSync(path.join(root, 'outdir', 'leak.js'), 'secret')
  fs.symlinkSync(path.join(root, 'outdir'), path.join(ui, 'linked'), 'junction')
  // adminAuth があっても、画面は誰でも開ける
  fake = createFakeRed({ settings: { adminAuth: {} } })
  rt = install(fake.RED, { registry: createRegistry(), uiDir: ui })
})
after(() => rt.hub.dispose())

// unauthenticated: 偽の needsPermission が掛かっていれば 401 になる印。掛かっていないことを見る
const get = (url, headers) => fake.request('GET', url, { headers, unauthenticated: true })

test('/wsuha-broute・/wsuha-broute/・/wsuha-broute/ui は /wsuha-broute/ui/ へ 302（相対で返す）', async () => {
  for (const [url, loc] of [
    ['/wsuha-broute', 'wsuha-broute/ui/'],
    ['/wsuha-broute/', 'ui/'],
    ['/wsuha-broute/ui', 'ui/'],
  ]) {
    const r = await get(url)
    assert.equal(r.statusCode, 302, url)
    assert.equal(r.headers.location, loc, url)
    // 相対で解決すると、httpNodeRoot が何でも /…/wsuha-broute/ui/ になる
    for (const rootPath of ['', '/api']) {
      assert.equal(new URL(loc, 'http://h' + rootPath + url).pathname, rootPath + '/wsuha-broute/ui/', rootPath + url)
    }
  }
})

test('index.html と許可したファイルを、認証なしでヘッダ付きで配る', async () => {
  const r = await get('/wsuha-broute/ui/')
  assert.equal(r.statusCode, 200)
  assert.match(r.text, /B ルート計測/)
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(r.headers['content-security-policy'], CSP)
  assert.match(CSP, /default-src 'self'/)
  assert.match(CSP, /script-src 'self'/)
  assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(CSP), '外部や inline を許さない')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['referrer-policy'], 'no-referrer')
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.ok(r.headers.etag)
  for (const [url, type] of [
    ['/wsuha-broute/ui/index.html', 'text/html; charset=utf-8'],
    ['/wsuha-broute/ui/app.mjs', 'text/javascript; charset=utf-8'],
    ['/wsuha-broute/ui/style.css', 'text/css; charset=utf-8'],
    ['/wsuha-broute/ui/vendor/preact.mjs', 'text/javascript; charset=utf-8'],
    ['/wsuha-broute/ui/vendor/VERSIONS.json', 'application/json; charset=utf-8'],
    ['/wsuha-broute/ui/vendor/LICENSES/preact.txt', 'text/plain; charset=utf-8'],
  ]) {
    const x = await get(url)
    assert.equal(x.statusCode, 200, url)
    assert.equal(x.headers['content-type'], type, url)
  }
  // 静的ファイルのルートは httpNode に載り、権限の検査を掛けない（ログインは無い）
  const st = fake.routes.filter((x) => x.path instanceof RegExp)
  assert.equal(st.length, 2)
  for (const x of st) {
    assert.equal(x.app, 'node')
    assert.equal(x.handlers[0].permission, undefined)
  }
})

test('ETag が同じなら 304', async () => {
  const r = await get('/wsuha-broute/ui/app.mjs')
  const again = await get('/wsuha-broute/ui/app.mjs', { 'if-none-match': r.headers.etag })
  assert.equal(again.statusCode, 304)
  assert.equal(again.text, '')
})

test('許可していないファイルと ui/ の外は 404', async () => {
  const bad = [
    '/wsuha-broute/ui/.env',
    '/wsuha-broute/ui/app.mjs.map',
    '/wsuha-broute/ui/notes.md',
    '/wsuha-broute/ui/package.json',
    '/wsuha-broute/ui/nope.js',
    '/wsuha-broute/ui/dir.js',
    '/wsuha-broute/ui/../outside.js',
    '/wsuha-broute/ui/..%2Foutside.js',
    '/wsuha-broute/ui/%2e%2e/outside.js',
    '/wsuha-broute/ui/vendor/..%2F..%2Foutside.js',
    '/wsuha-broute/ui/..%5Coutside.js',
    '/wsuha-broute/ui/vendor/%2e%2e%2f%2e%2e%2foutside.js',
    '/wsuha-broute/ui/%00index.html',
    '/wsuha-broute/ui/index.html%00.js',
    '/wsuha-broute/ui/%E0%A4%A',
    '/wsuha-broute/ui//index.html',
    '/wsuha-broute/uiindex.html',
  ]
  for (const url of bad) {
    const r = await get(url)
    assert.ok(r.statusCode === 404, `${url} → ${r.statusCode}`)
    assert.ok(!/secret|SECRET/.test(r.text), url)
  }
})

test('シンボリックリンクで ui/ の外を指していたら配らない', async (t) => {
  if (!fs.existsSync(path.join(root, 'ui', 'link.js'))) {
    t.skip('この環境ではシンボリックリンクを作れない')
    return
  }
  const r = await get('/wsuha-broute/ui/link.js')
  assert.equal(r.statusCode, 404)
})

test('リンクしたディレクトリで ui/ の外を指していたら配らない（名前の規則は通る形でも）', async () => {
  assert.deepEqual(allowedSegments('linked/leak.js'), ['linked', 'leak.js'], '前提: 名前の規則だけなら通る')
  assert.ok(fs.existsSync(path.join(root, 'ui', 'linked', 'leak.js')), '前提: リンクの先にファイルがある')
  const r = await get('/wsuha-broute/ui/linked/leak.js')
  assert.equal(r.statusCode, 404)
  assert.ok(!/secret/.test(r.text))
})

test('許可の規則（純関数）', () => {
  assert.deepEqual(allowedSegments(''), ['index.html'])
  assert.deepEqual(allowedSegments('vendor/htm.mjs'), ['vendor', 'htm.mjs'])
  for (const bad of ['.git/config', 'a/../b.js', 'a//b.js', 'a\\b.js', 'x.map', 'x', '%zz', 'a/b/c/d/e/f.js', '-x.js', 'package.json', 'sub/package-lock.json', 'format.test.mjs', 'x.spec.js']) {
    assert.equal(allowedSegments(bad), null, bad)
  }
})

test('ui/index.html が無ければ、起動時に警告を 1 行出す（npm pack の files に ui/ が無い配り方）', () => {
  assert.equal(rt.uiProblem, null, 'index.html があれば警告しない')
  assert.ok(!fake.logs.some(([l, t]) => l === 'warn' && /\/wsuha-broute\/ui\/ は 404/.test(t)))
  const empty = tmpDir('wsuha-ui-empty-')
  const missing = path.join(tmpDir('wsuha-ui-none-'), 'ui')
  for (const dir of [empty, missing]) {
    const f = createFakeRed({ settings: {} })
    const r = install(f.RED, { registry: createRegistry(), uiDir: dir })
    try {
      const warns = f.logs.filter(([l, t]) => l === 'warn' && /\/wsuha-broute\/ui\/ は 404/.test(t))
      assert.equal(warns.length, 1, dir)
      assert.match(warns[0][1], /package\.json の files/)
      assert.match(warns[0][1], dir === empty ? /index\.html/ : /ディレクトリがありません/)
      assert.ok(r.uiProblem, dir)
    } finally {
      r.hub.dispose()
    }
  }
})
