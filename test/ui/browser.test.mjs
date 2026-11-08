// 実ブラウザでしか分からない動きの試験。偽の DOM にはレイアウトが無く、指の pointerleave も、続けて押した Esc で <dialog> が閉じる動きも無い。
// CSS の文字列を見る試験だけでは、「横は真ん中でも縦は上の端」のまま緑で通った。
//
// Playwright は依存に入れない。入っている場所を渡したときだけ流し、渡さなければ skip と出る:
//   WSUHA_PLAYWRIGHT=<playwright-core のディレクトリ> node --test test/ui/browser.test.mjs
//
// 画面は作業ツリーの ui/ をそのまま配り、API は偽のサーバー（test/ui/fake-server.mjs）が答える。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { H, summary, fakeServer } from './fake-server.mjs'

const skip = process.env.WSUHA_PLAYWRIGHT ? false : 'WSUHA_PLAYWRIGHT を渡したときだけ流す'
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

let browser
let server
let origin
let fake

/** ui/ の静的ファイルと、偽のサーバーの API を配る。 */
function start() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname.startsWith('/wsuha-broute/api/v1/')) {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const abort = new AbortController()
        res.on('close', () => abort.abort())
        const r = await fake.fetchImpl('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() || undefined, signal: abort.signal })
        res.writeHead(r.status, Object.fromEntries(r.headers))
        if (r.body) Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res)
        else res.end()
        return
      }
      const file = path.join(ui, url.pathname.replace('/wsuha-broute/ui/', '') || 'index.html')
      if (!file.startsWith(ui) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        const index = path.join(ui, 'index.html')
        res.writeHead(url.pathname.endsWith('/') ? 200 : 404, { 'Content-Type': TYPES['.html'] })
        res.end(url.pathname.endsWith('/') ? fs.readFileSync(index) : '')
        return
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port
      resolve()
    })
  })
}

before(async () => {
  if (skip) return
  const { chromium } = createRequire(import.meta.url)(process.env.WSUHA_PLAYWRIGHT)
  browser = await chromium.launch({ headless: true })
  await start()
})

after(async () => {
  if (skip) return
  await browser.close()
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

const UI = () => origin + '/wsuha-broute/ui/'
const open = (w, h, touch = false) => browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 })

const LONG = { current: { r: 100.5, t: 200.5, total: 301, at: Date.now() }, txBudgetMs: 359000, lqi: 70 }
const adapters = () => [
  summary('a1', LONG),
  summary('a2', Object.assign({}, LONG, { connected: false, phaseText: 'メーターを探しています', health: H('busy', { title: 'メーターを探しています' }) })),
  summary('a3', Object.assign({}, LONG, { name: '', named: false })),
]

// 読み込みの位置を、箱とスピナーの座標で見る。CSS の文字の確かめでは縦の位置が分からない。
// 戻すと落ちるもの: .pane > .state-loading の min-height か align-content を消す・.shell-narrow .panes の grid を消す・.boot の padding-top を消す
test('読み込み中の表示は、ペインの縦横の真ん中に出て、開いた直後の表示から上下へ飛ばない', { skip }, async () => {
  fake = fakeServer({ items: adapters() })
  for (const [w, h, touch] of [[1400, 900, false], [1024, 768, true], [820, 1180, true], [390, 844, true], [360, 740, true]]) {
    const c = await open(w, h, touch)
    const p = await c.newPage()
    let holdJs = true
    let holdApi = true
    const until = async (f) => {
      while (f()) await new Promise((s) => setTimeout(s, 20))
    }
    await p.route('**/app.js', async (r) => {
      await until(() => holdJs)
      r.continue()
    })
    await p.route('**/api/v1/**', async (r) => {
      await until(() => holdApi)
      r.continue().catch(() => {})
    })
    p.goto(UI() + '#/adapters/a1/status', { waitUntil: 'commit' }).catch(() => {})
    await p.waitForSelector('.boot')
    const bootY = await p.evaluate(() => {
      const r = document.querySelector('.boot .spinner').getBoundingClientRect()
      return r.top + r.height / 2
    })
    holdJs = false
    await p.waitForSelector('.shell')
    await p.waitForSelector('.pane > .state-loading')
    const panes = await p.evaluate(() =>
      [...document.querySelectorAll('.pane > .state-loading')].map((el) => {
        const box = el.getBoundingClientRect()
        const pane = el.parentElement.getBoundingClientRect()
        const sp = el.querySelector('.spinner').getBoundingClientRect()
        return { dy: box.top + box.height / 2 - (pane.top + pane.height / 2), dx: sp.left + sp.width / 2 - (pane.left + pane.width / 2), y: sp.top + sp.height / 2 }
      }),
    )
    assert.ok(panes.length >= 1)
    for (const q of panes) {
      assert.ok(Math.abs(q.dy) <= 1, `${w}: 箱の中心とペインの中心 ${q.dy}`)
      assert.ok(Math.abs(q.dx) <= 1, `${w}: 横 ${q.dx}`)
      assert.ok(Math.abs(q.y - bootY) <= 1, `${w}: 開いた直後の表示から ${q.y - bootY}px 飛んだ`)
    }
    holdApi = false
    await c.close()
  }
})

// 戻すと落ちるもの: .row-facts を repeat(auto-fit, …) に戻す・.fact-wide を外す
test('左ペインの小さな表は、どの幅でも 2 列で、値が省略されない', { skip }, async () => {
  fake = fakeServer({ items: adapters() })
  for (const [w, h] of [[360, 740], [390, 844], [768, 1024], [820, 1180], [900, 800], [1024, 768], [1280, 800], [1300, 800], [1366, 768]]) {
    const c = await open(w, h)
    const p = await c.newPage()
    await p.goto(UI() + '#/', { waitUntil: 'commit' })
    await p.waitForSelector('.row-facts')
    const m = await p.evaluate(() => {
      const tables = [...document.querySelectorAll('.row-facts')]
      return {
        cols: [...new Set(tables.map((t) => getComputedStyle(t).gridTemplateColumns.split(' ').length))],
        cut: tables.flatMap((t) => [...t.querySelectorAll('dd')].filter((d) => d.scrollWidth > d.clientWidth).map((d) => d.textContent)),
      }
    })
    assert.deepEqual(m.cols, [2], String(w))
    assert.deepEqual(m.cut, [], String(w))
    await c.close()
  }
})

// 指の pointerup のあとには必ず pointerleave が来る。偽の DOM の試験はこの順を手で書いているので、本物の順で確かめる。
// 戻すと落ちるもの: charts.js の onLeave が pointerType を見ない・tipLeft の丸めを外す
test('グラフの吹き出しは、指を離しても残り、箱が描ける範囲からはみ出さない', { skip }, async () => {
  const now = Date.now()
  const rows = []
  for (let t = now - 3600e3; t < now; t += 30e3) rows.push([t, 500, 3, 2, 60])
  fake = fakeServer({ items: adapters(), metaOver: { startedAt: 1 }, trendRows: () => rows })
  const c = await open(390, 844, true)
  const p = await c.newPage()
  await p.goto(UI() + '#/adapters/a1/values', { waitUntil: 'commit' })
  await p.waitForFunction(() => document.querySelectorAll('.chart-hit').length === 3)
  const cdp = await c.newCDPSession(p)
  for (const frac of [0.05, 0.5, 0.95]) {
    const at = await p.evaluate((f) => {
      const e = document.querySelectorAll('.chart-hit')[2]
      e.scrollIntoView({ block: 'center' })
      const r = e.getBoundingClientRect()
      return { x: r.left + r.width * f, y: r.top + r.height / 2 }
    }, frac)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await p.waitForTimeout(150)
    const tip = await p.evaluate(() => {
      const box = document.querySelector('.chart-tip-box')
      if (!box) return null
      const hit = box.ownerSVGElement.querySelector('.chart-hit')
      const x = Number(box.getAttribute('x'))
      return { x, right: x + Number(box.getAttribute('width')), min: Number(hit.getAttribute('x')), max: Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) }
    })
    assert.ok(tip, frac + ': 離したあとも残る')
    assert.ok(tip.x >= tip.min && tip.right <= tip.max, JSON.stringify(tip))
    // もう一度同じ所を押すと消える
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await p.waitForTimeout(150)
    assert.equal(await p.evaluate(() => document.querySelectorAll('.chart-tip').length), 0, frac + ': 同じ所を押すと消える')
  }
  await c.close()
})

// rect は計算値の display が inline のままで touch-action が効かない。指でなぞると pointercancel が来て吹き出しが消えていた。
// 戻すと落ちるもの: touch-action を .chart-svg から .chart-hit へ戻す
test('グラフを指で横になぞると吹き出しが追いかけ、離しても残る。縦のスワイプはスクロールして吹き出しを消す', { skip }, async () => {
  const now = Date.now()
  const rows = []
  for (let t = now - 3600e3; t < now; t += 30e3) rows.push([t, 500, 3, 2, 60])
  fake = fakeServer({ items: adapters(), metaOver: { startedAt: 1 }, trendRows: () => rows })
  const c = await open(390, 844, true)
  const p = await c.newPage()
  await p.goto(UI() + '#/adapters/a1/values', { waitUntil: 'commit' })
  await p.waitForFunction(() => document.querySelectorAll('.chart-hit').length === 3)
  const cdp = await c.newCDPSession(p)
  const box = await p.evaluate(() => {
    const e = document.querySelector('.chart-hit')
    e.scrollIntoView({ block: 'center' })
    const r = e.getBoundingClientRect()
    return { x: r.left, y: r.top + r.height / 2, w: r.width }
  })
  const tipCount = () => p.evaluate(() => document.querySelectorAll('.chart-tip').length)
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  await touch('touchStart', box.x + box.w * 0.2, box.y)
  let seen = 0
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', box.x + box.w * (0.2 + i * 0.05), box.y)
    await p.waitForTimeout(40)
    seen += await tipCount()
  }
  assert.equal(seen, 10, '動かしている間ずっと出ている')
  await touch('touchEnd')
  await p.waitForTimeout(100)
  assert.equal(await tipCount(), 1, '離しても残る')
  // 同じグラフの上から縦に動かす
  const before = await p.evaluate(() => window.scrollY)
  await touch('touchStart', box.x + box.w * 0.5, box.y)
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', box.x + box.w * 0.5, box.y - i * 12)
    await p.waitForTimeout(30)
  }
  await touch('touchEnd')
  await p.waitForTimeout(150)
  assert.ok((await p.evaluate(() => window.scrollY)) > before, '縦はスクロールする')
  assert.equal(await tipCount(), 0, 'スクロールに変わったら吹き出しを残さない')
  await c.close()
})

// 欄の blur で誤りの行が増えると、ダイアログの高さが変わり、押している間に［キャンセル］が動いて click が外れていた。
// 戻すと落ちるもの: detail-pane.js の理由の欄に onBlur で setTouched(true) を戻す
test('停止のダイアログは、何も書かずに［キャンセル］の上の端を 1 回押すだけで閉じる', { skip }, async () => {
  fake = fakeServer({ items: adapters() })
  for (const [w, h, touch] of [[1366, 768, false], [390, 844, true], [844, 390, true]]) {
    const c = await open(w, h, touch)
    const p = await c.newPage()
    await p.goto(UI() + '#/adapters/a1/status', { waitUntil: 'commit' })
    await p.waitForSelector('.dhead-name')
    const stop = p.locator('.actions .btn', { hasText: '停止' })
    if (touch) await stop.tap()
    else await stop.click()
    await p.waitForSelector('dialog[open] textarea')
    await p.waitForTimeout(200)
    const bb = await p.locator('dialog[open] .dialog-foot .btn').first().boundingBox()
    const x = bb.x + bb.width / 2
    const y = bb.y + 6
    if (touch) await p.touchscreen.tap(x, y)
    else await p.mouse.click(x, y)
    await p.waitForTimeout(300)
    assert.equal(await p.locator('dialog[open]').count(), 0, w + ': 1 回で閉じる')
    await c.close()
  }
})

// 古い meta のまま開いていた画面で、何も起きないように見えていた。
// 戻すと落ちるもの: add-pane.js の BLOCKING_CODES に CONFIG_LOCKED を戻す
test('追加の 403 CONFIG_LOCKED は、モーダルの中の帯にサーバーの文を出す', { skip }, async () => {
  const message = 'settings.js で止めています。エディタで追加してください'
  fake = fakeServer({ items: adapters(), onAddAdapter: () => ({ status: 403, body: { error: { code: 'CONFIG_LOCKED', message } } }) })
  for (const [w, h] of [[390, 844], [1366, 768]]) {
    const c = await open(w, h)
    const p = await c.newPage()
    await p.goto(UI() + '#/', { waitUntil: 'commit' })
    await p.locator('[data-add="add"]').click()
    await p.selectOption('#add-in-role', { index: 1 })
    await p.locator('label[for="add-in-mode-simulator"], #add-in-mode-simulator').first().click()
    await p.locator('.add-bar button[type="submit"]').click()
    await p.waitForSelector('dialog[open] .notice')
    assert.ok((await p.locator('dialog[open] .add-form-wrap').innerText()).includes(message))
    assert.ok(await p.locator('dialog[open] .notice').first().isVisible(), w + ': 見えている')
    await c.close()
  }
})

// 1 ペインの戻り方は［← 一覧］とブラウザの戻るだけ。hidden の残し方は、偽の DOM では見た目を確かめられない。
// 戻すと落ちるもの: app.js の paneId を id に戻す・.pane-detail に hidden より強い display を足す
test('1 ペインの下書きは［← 一覧］とブラウザの戻る・進むでも残り、隠している間は一覧だけが見える', { skip }, async () => {
  fake = fakeServer({ items: adapters() })
  const c = await open(390, 844, true)
  const p = await c.newPage()
  await p.goto(UI() + '#/', { waitUntil: 'commit' })
  await p.waitForSelector('a.row')
  await p.evaluate(() => {
    location.hash = '#/adapters/a1/settings'
  })
  await p.waitForSelector('#in-pollIntervalSec')
  await p.fill('#in-pollIntervalSec', '77')
  await p.locator('.back-link').tap()
  await p.waitForSelector('a.row')
  assert.equal(await p.evaluate(() => document.querySelector('.pane-detail').getBoundingClientRect().height), 0, '隠している間は場所を取らない')
  assert.equal(await p.locator('dialog[open]').count(), 0)
  await p.goBack()
  await p.waitForSelector('.dhead-name')
  assert.equal(await p.inputValue('#in-pollIntervalSec'), '77', '［← 一覧］のあとのブラウザの戻る')
  await p.goBack()
  await p.waitForSelector('a.row')
  await p.goForward()
  await p.waitForSelector('.dhead-name')
  assert.equal(await p.inputValue('#in-pollIntervalSec'), '77', 'ブラウザの戻る・進む')
  await c.close()
})

// 続けて押した Esc は cancel を止められず、<dialog> だけが閉じる。
// 戻すと落ちるもの: dialog.js の useModal の close のイベントを外す
test('送っている間に Esc を続けて押しても、ダイアログは開いたままで、失敗の文が中に出る', { skip }, async () => {
  fake = fakeServer({ items: adapters() })
  const c = await open(1400, 900)
  const p = await c.newPage()
  await p.route('**/actions/stop', async (r) => {
    await new Promise((s) => setTimeout(s, 800))
    r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_RUNNING', message: 'いまは止められません。' } }) })
  })
  await p.goto(UI() + '#/adapters/a1/status', { waitUntil: 'commit' })
  await p.waitForSelector('.dhead-name')
  await p.locator('.actions .btn', { hasText: '停止' }).click()
  await p.locator('dialog[open] textarea').fill('点検のため')
  await p.locator('dialog[open] button[type=submit]').click()
  for (let i = 0; i < 4; i++) {
    await p.keyboard.press('Escape')
    await p.waitForTimeout(60)
  }
  await p.waitForSelector('dialog[open] [role=alert]')
  assert.equal((await p.locator('dialog[open] [role=alert]').innerText()).trim(), 'いまは止められません。')
  await p.keyboard.press('Escape')
  await p.waitForFunction(() => !document.querySelector('dialog[open]'))
  await p.locator('.actions .btn', { hasText: '停止' }).click()
  await p.waitForSelector('dialog[open]')
  await c.close()
})

// 触ったあとの色が次に触るまで残っていた。
// 戻すと落ちるもの: :hover の規則を @media (hover: hover) の外へ出す
test('指の端末では、触ったボタンにホバーの色が残らない', { skip }, async () => {
  fake = fakeServer({ items: adapters() })
  const c = await open(390, 844, true)
  const p = await c.newPage()
  await p.goto(UI() + '#/adapters/a1/status', { waitUntil: 'commit' })
  await p.waitForSelector('.dhead-name')
  assert.equal(await p.evaluate(() => matchMedia('(hover: none)').matches), true)
  const more = p.locator('.actions .menu button[aria-haspopup]')
  await more.tap()
  await p.waitForTimeout(100)
  assert.equal(await more.evaluate((e) => getComputedStyle(e).backgroundImage), 'none')
  await c.close()
})
