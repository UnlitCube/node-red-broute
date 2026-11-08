// ui/app.js の App を、偽の DOM と偽の API（fetch）で丸ごと描いて確かめる。
// - 画面のログインは無い: どの要求にも Authorization が無く、ログイン画面を出さずに一覧と詳細が出る。
// - Node-RED の認証があるサーバー: 値は誰でも見え、操作と保存はエディタにログインした人だけ。
// - 2 ペイン（PC）: 何も選んでいなければ一覧の先頭を location.replace で選ぶ。
// - 1 ペイン（900px 未満）: #/ は一覧だけ、#/adapters/… は詳細だけ（← 一覧）。
// - meta.readOnly なら操作を無効にして理由を出す。stream?adapter= の 404 は右ペインの「見つかりません」。
//
// 戻すと落ちるもの:
//   - autoSelectHref を呼ばない → PC で右ペインが「選んでください」のまま
//   - paneLayout を幅で分けない → 390px でも 2 ペインが並ぶ
//   - api.js に Authorization を戻す
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, settle, click, typeInto, fire, $, $$, textOf, buttonByText } from './fake-dom.mjs'
import { H, summary, detail, configFor, fakeServer, memStorage, appStarter, wait, until, countOf, streamCalls } from './fake-server.mjs'

const dom = installDom({ width: 1280 })
const win = dom.window
const { html } = await import('../../ui/html.js')
const { S } = await import('../../ui/strings.js')
const { App } = await import('../../ui/app.js')

// 試験が途中で落ちても、描いた App を必ず外す
const mounted = []
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount()
})
const start = appStarter({ win, html, App, mounted })

const cls = (el) => el.getAttribute('class') || ''
const hasAuthHeader = (c) => Object.keys((c.init && c.init.headers) || {}).some((k) => k.toLowerCase() === 'authorization')

test('PC（1280px）: ログインなしで開き、何も選んでいなければ一覧の先頭（重い順の先頭）を location.replace で選ぶ', async () => {
  const server = fakeServer({ items: [summary('bad1', { health: H('bad') }), summary('ok2')] })
  const m = await start({ width: 1280, hash: '', server })
  assert.ok(await until(() => !!$(m.root, '.pane-detail .dhead')), '右ペインに詳細')
  assert.deepEqual(win.replaced, ['#/adapters/bad1/status'], '履歴を増やさずに先頭へ')
  assert.ok($(m.root, '.pane-list'), '左ペイン')
  assert.equal(textOf($(m.root, '.dhead-name')), 'アダプタ bad1')
  assert.equal($(m.root, 'a.row[aria-current="page"]').getAttribute('data-id'), 'bad1', '選んでいる行を強調')
  assert.equal(!!$(m.root, '.back-link'), false, '2 ペインでは ← 一覧 を出さない')
  assert.equal(!!$(m.root, 'input[type="password"]'), false, 'ログイン画面は無い')
  assert.ok(server.calls.length > 5)
  assert.deepEqual(server.calls.filter(hasAuthHeader).map((c) => c.url), [], 'Authorization を付けない')
  // 書き込みの要求にも付けない（今すぐ取得）
  click(buttonByText(m.root, S.actions.poll))
  await settle()
  const post = server.calls.find((c) => c.init.method === 'POST')
  assert.ok(post, 'POST を送った')
  assert.equal(hasAuthHeader(post), false)
  assert.equal(post.init.headers['Content-Type'], 'application/json')
  await m.unmount()
})

test('PC: 選んでいる台があれば、そのまま（先頭へ飛ばない）', async () => {
  const server = fakeServer({ items: [summary('bad1', { health: H('bad') }), summary('ok2')] })
  const m = await start({ width: 1280, hash: '#/adapters/ok2/logs', server })
  assert.deepEqual(win.replaced, [])
  assert.equal(textOf($(m.root, '.dhead-name')), 'アダプタ ok2')
  assert.equal($(m.root, '.tabs a[aria-current="page"]').getAttribute('href'), '#/adapters/ok2/logs')
  await m.unmount()
})

test('390px: #/ は一覧だけ（先頭へ飛ばない）。行を選ぶと詳細だけになり、← 一覧 で戻る', async () => {
  const server = fakeServer({ items: [summary('a1'), summary('a2')] })
  const m = await start({ width: 390, hash: '#/', server })
  assert.deepEqual(win.replaced, [], '狭い幅では先頭を選ばない')
  assert.ok($(m.root, '.pane-list'))
  assert.equal(!!$(m.root, '.pane-detail'), false, '詳細は出さない')
  win.navigate($$(m.root, 'a.row')[1].getAttribute('href'))
  await settle(3)
  assert.equal(!!$(m.root, '.pane-list'), false, '一覧は出さない')
  assert.equal(textOf($(m.root, '.dhead-name')), 'アダプタ a2')
  const back = $(m.root, '.back-link')
  assert.equal(textOf(back), '← 一覧')
  win.navigate(back.getAttribute('href'))
  await settle(3)
  assert.ok($(m.root, '.pane-list'))
  assert.equal($(m.root, '.pane-detail').hasAttribute('hidden'), true, '詳細は隠す（設定の下書きを同じ台へ戻るまで持つ）')
  assert.equal(!!$(m.root, '.dhead'), false, '隠している間は見出しを描かない')
  // 幅を広げたら 2 ペインになり、先頭を選ぶ
  win.setViewport(1280)
  assert.ok(await until(() => !!$(m.root, '.pane-list') && !!$(m.root, '.pane-detail .dhead')), '2 ペイン')
  assert.deepEqual(win.replaced, ['#/adapters/a1/status'])
  await m.unmount()
})

test('読み出しのみ（meta.readOnly）: 帯に「読み出しのみ（settings.js）」、操作のボタンは無効で理由を添える', async () => {
  const server = fakeServer({ items: [summary('a1')], metaOver: { readOnly: true } })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(textOf($(m.root, '.topbar')).includes(S.header.readOnly))
  const poll = buttonByText(m.root, S.actions.poll)
  assert.equal(poll.hasAttribute('disabled'), true)
  assert.equal(poll.getAttribute('title'), S.actions.readOnlyReason)
  assert.ok(textOf($(m.root, '.dhead')).includes(S.actions.readOnlyReason))
  await m.unmount()
})

test('版のずれ: 帯に「Node-RED の再起動が必要です」', async () => {
  const server = fakeServer({ items: [summary('a1')], metaOver: { diskVersion: '2.0.0-beta.2' } })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(textOf($(m.root, '.topbar')).includes(S.header.restartNeeded))
  await m.unmount()
})

// stream?adapter=<id> が 404 なら繋ぎ直さず、右ペインに「見つかりません（デプロイで消えた可能性があります）」。
// 一覧の更新は止めない（?adapter= を付けない SSE で受ける）。
test('stream?adapter=<id> が 404: その台へは繋ぎ直さず、右ペインに「見つかりません（デプロイで消えた可能性があります）」', async () => {
  const server = fakeServer({ items: [summary('a2')], notFoundStream: ['a1'] })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(textOf($(m.root, '.pane-detail')).includes(S.detail.notFound))
  assert.ok(textOf($(m.root, '.pane-detail')).includes(S.detail.notFoundHint), '戻れば自動で出すと添える')
  await wait(200)
  assert.equal(streamCalls(server, 'a1'), 1, '?adapter=a1 へは繋ぎ直さない')
  assert.equal(textOf($(m.root, '.notices')).includes(S.banner.polling), false, '「リアルタイム更新が切れています」にしない')
  await m.unmount()
})

// 「停止」の帯（リアルタイム更新が止まっています・再試行）は、SSE が止まったまま戻らないときのもの。
// ?adapter=<id> の 404 では、すぐに ?adapter= を付けない SSE に作り直すので、古い SSE の 'stopped' で帯と「停止」を一瞬でも出さない
// （出すと帯が出て消え、ペインが上下にずれてちらつく。useEffect は描画の次のフレームなので、その間は見えていた）。
// 戻すと落ちるもの: sse-client.js で onNotFound より先に 'stopped' を知らせる・app.js で作り直す前の 'stopped' を抑えない。
test('stream?adapter=<id> の 404 で SSE を作り直すとき、「停止」の帯と chip を一瞬も出さない（ちらつかない）', async () => {
  for (const order of ['sse-first', 'detail-first']) {
    const server = fakeServer({ items: [summary('a2')], notFoundStream: ['a1'] })
    // 応答の順を決める: SSE の 404 を先に返す / 詳細の 404 を先に返す
    const inner = server.fetchImpl
    server.fetchImpl = async (url, init) => {
      const u = new URL(url)
      const isStream = u.pathname.endsWith('/stream') && u.searchParams.get('adapter') === 'a1'
      const isDetail = /\/adapters\/a1$/.test(u.pathname)
      if ((order === 'sse-first' && isDetail) || (order === 'detail-first' && isStream)) await wait(30)
      return inner(url, init)
    }
    const seen = new Set()
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const n = document.body.querySelector('.notices')
        const c = document.body.querySelector('.live-chip')
        if (n && textOf(n).includes(S.banner.stopped)) seen.add('帯')
        if (c && textOf(c) === S.live.stopped) seen.add('chip')
        await wait(2)
      }
    })()
    const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
    assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes(S.detail.notFound)), order)
    assert.ok(await until(() => streamCalls(server, null) === 1), order + ': ?adapter= なしの SSE に作り直す')
    await wait(150)
    sampling = false
    await sampler
    assert.deepEqual([...seen], [], order + ': 「停止」を出した')
    await m.unmount()
  }
})

// 一覧にあるのに ?adapter= の SSE だけが 404 を返し続ける（claim が外れる途中・サーバーの食い違い）とき、
// 「一覧にある → 取り直す → 200 → ?adapter= → 404 → …」を繰り返さない（作り直しの条件を誤ると暴走する）。
// 戻すと落ちるもの: needsDetailRecheck を「notFound で一覧にあれば確かめる」にする → GET と SSE が止まらない。
test('一覧にあるのに ?adapter= の SSE だけが 404 を返し続けても、GET と SSE を繰り返さない（暴走しない）', async () => {
  const server = fakeServer({ items: [summary('a1')], notFoundStream: ['a1'], liveStreams: true })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  await wait(600)
  assert.ok(streamCalls(server, 'a1') <= 2, '?adapter=a1: ' + streamCalls(server, 'a1'))
  assert.ok(countOf(server, /\/adapters\/a1$/) <= 2, 'GET adapters/a1: ' + countOf(server, /\/adapters\/a1$/))
  await m.unmount()
})

// 一覧の変化を取りこぼした（一覧に最初からあるのに詳細だけが 404 だった。再起動の直後に listen が startFlows より先など）ときも、
// 「見つかりません」の間は間隔ごとに確かめ直し、取れたら詳細と ?adapter= の SSE に戻る。
// 戻すと落ちるもの: app.js の recheckMs の setInterval を外す → 「見つかりません」のまま。
test('「見つかりません」の間は間隔ごとにも確かめ直し、取れたら詳細に戻る（一覧が変わらなくても）', async () => {
  const server = fakeServer({ items: [summary('a1')], unclaimed: ['a1'], liveStreams: true })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { recheckMs: 100 } })
  assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes(S.detail.notFound)))
  server.unclaimed.delete('a1') // claim された（一覧は変わらない）
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a1'), textOf($(m.root, '.pane-detail')).slice(0, 80))
  assert.ok(await until(() => server.openStreams().some((s) => s.adapter === 'a1')), '?adapter=a1 で繋ぎ直す')
  const n = countOf(server, /\/adapters\/a1$/)
  await wait(400)
  assert.equal(countOf(server, /\/adapters\/a1$/), n, '戻ったら間隔ごとの確かめ直しは止める')
  await m.unmount()
})

// 404 ADAPTER_NOT_FOUND で SSE を止めると、一覧（左ペイン）の更新まで止まり、台が戻っても読み直すまで何も出なかった
// （「Web UI で開く」をデプロイ前に押した・古いブックマーク・エディタの「フローを停止」）。
// 戻すと落ちるもの: app.js の streamId を notFound でも route.id のままにする（?adapter= を付けない SSE を開かない）
//   →「adapter なしの SSE で一覧を受け続ける」が落ちる。
test('stream?adapter=<id> が 404 のあとも一覧の更新は止めず（?adapter= なしの SSE）、台が戻ったら取り直して ?adapter= で繋ぎ直す', async () => {
  const server = fakeServer({ items: [summary('a2')], liveStreams: true })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes(S.detail.notFound)), '右ペインは「見つかりません」')
  assert.ok(await until(() => streamCalls(server, null) === 1), 'adapter なしの SSE で一覧を受け続ける')
  assert.ok(await until(() => textOf($(m.root, '.live-chip')) === S.live.live), textOf($(m.root, '.live-chip')))
  assert.equal(streamCalls(server, 'a1'), 1, '見つからない間は ?adapter=a1 へ繋ぎ直さない')
  assert.equal($$(m.root, 'a.row').length, 1)
  const before = { values: countOf(server, /\/adapters\/a1\/values$/), logs: countOf(server, /\/adapters\/a1\/logs$/), settings: countOf(server, /\/adapters\/a1\/settings$/) }

  // デプロイで a1 が戻った: SSE の adapters に a1 が入る → GET adapters/a1 → 詳細を出し、?adapter=a1 で繋ぎ直す
  server.setItems([summary('a1'), summary('a2')])
  server.pushAll('adapters', { items: server.items })
  assert.ok(await until(() => $$(m.root, 'a.row').length === 2), '一覧が SSE で更新される')
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a1'), '右ペインに a1 の詳細')
  assert.ok(await until(() => streamCalls(server, 'a1') === 2), '?adapter=a1 で繋ぎ直す')
  assert.ok(await until(() => server.openStreams().length === 1 && server.openStreams()[0].adapter === 'a1'), '?adapter= なしの SSE は閉じる')
  assert.ok(await until(() => countOf(server, /\/adapters\/a1\/values$/) > before.values), '計測値も取り直す')
  assert.ok(countOf(server, /\/adapters\/a1\/logs$/) > before.logs, 'ログも取り直す')
  assert.ok(countOf(server, /\/adapters\/a1\/settings$/) > before.settings, '設定も取り直す')
  assert.equal(textOf($(m.root, '.live-chip')), S.live.live)
  await m.unmount()
})

// 詳細を開いている台を削除してデプロイすると、SSE は繋がったまま 'adapters'（その台が抜けた一覧）だけが届き、
// 右ペインは消えた台の最後の詳細を「ライブ」のまま出し続けた。
// 戻すと落ちるもの: app.js の「一覧から消えたら GET adapters/:id で確かめる」を外す →「確かめ直す」が落ちる。
test('詳細を開いている台が一覧から消えたら（削除のデプロイ）GET で確かめ、404 なら「見つかりません」。戻れば詳細に戻る', async () => {
  const server = fakeServer({ items: [summary('a1'), summary('a2')], liveStreams: true })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => textOf($(m.root, '.live-chip')) === S.live.live))
  assert.ok($(m.root, '.pane-detail .dhead'))
  const det0 = countOf(server, /\/adapters\/a1$/)

  server.setItems([summary('a2')])
  server.pushAll('adapters', { items: server.items }) // SSE は繋がったまま。届くのは adapters だけ
  assert.ok(await until(() => countOf(server, /\/adapters\/a1$/) > det0), '一覧から消えたら GET adapters/a1 で確かめ直す')
  assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes(S.detail.notFound)), textOf($(m.root, '.pane-detail')).slice(0, 80))
  assert.equal(!!$(m.root, '.pane-detail .dhead'), false, '消えた台の詳細（操作のボタン）を出し続けない')
  assert.ok(await until(() => streamCalls(server, null) === 1), '一覧は ?adapter= なしの SSE で受ける')
  const det1 = countOf(server, /\/adapters\/a1$/)
  // 一覧が変わっても、消えたままなら確かめない（a1 が無い一覧では GET しない）
  server.pushAll('adapters', { items: [summary('a2', { power: { value: 600, at: 2000 } })] })
  await settle(2)
  assert.equal(countOf(server, /\/adapters\/a1$/), det1, '戻っていない間は GET しない')

  // full デプロイで作り直された: 一覧に戻る → 詳細に戻る
  server.setItems([summary('a1'), summary('a2')])
  server.pushAll('adapters', { items: server.items })
  assert.ok(await until(() => !!$(m.root, '.pane-detail .dhead')), '詳細に戻る')
  assert.ok(await until(() => streamCalls(server, 'a1') === 2))
  await m.unmount()
})

// 一時的な上書き（フローの interval・epcs、画面の「自動運転に戻す」）は SSE の settings を出さないので、
// 設定タブの出どころと値が古いままだった。adapter の pollIntervalSec・pollEpcs・overridden が変わったら settings を取り直す。
// 戻すと落ちるもの: app.js の settingsSignature の取り直しを外す →「上書きが掛かったら設定を取り直す」が落ちる。
test('上書きの変化（adapter の pollIntervalSec・overridden.any）で設定を取り直し、出どころが「一時的な上書き」になる。「自動運転に戻す」でも戻る', async () => {
  let ov = null
  const settingsOf = () => {
    const f = (value, source) => ({ value, source, configValue: 30, default: 30, min: 15, max: 3600, by: null, at: null })
    return {
      rev: 'r1',
      fields: {
        pollIntervalSec: ov === null ? f(30, 'config') : f(ov, 'override'),
        pollEpcs: { value: ['0xE7'], source: 'default', configValue: null, default: ['0xE7'], by: null, at: null },
        slowIntervalSec: { value: 300, source: 'default', configValue: null, default: 300, min: 60, max: 3600, by: null, at: null },
        halfHourIntervalSec: { value: 1800, source: 'default', configValue: null, default: 1800, min: 300, max: 7200, by: null, at: null },
      },
      warnings: [],
    }
  }
  const a1 = (extra = {}) => summary('a1', Object.assign({ pollIntervalSec: ov === null ? 30 : ov, overridden: { stopped: null, any: ov !== null } }, extra))
  const server = fakeServer({
    items: [a1()],
    liveStreams: true,
    settingsOf,
    onAction: (id, name) => {
      if (name === 'auto') {
        ov = null
        server.setItems([a1()])
      }
    },
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server })
  const settingsCalls = () => countOf(server, /\/adapters\/a1\/settings$/)
  const source = () => textOf($(m.root, '.src-row[data-field="pollIntervalSec"] .set-source'))
  assert.ok(await until(() => source().startsWith(S.settings.source.config)), source())
  const s0 = settingsCalls()

  // フローから interval 120（一時的な上書き）: SSE には adapter だけが届く
  ov = 120
  server.setItems([a1()])
  server.pushAll('adapter', detail(a1()))
  assert.ok(await until(() => settingsCalls() === s0 + 1), '上書きが掛かったら設定を取り直す')
  assert.ok(await until(() => source().startsWith(S.settings.source.override)), source())

  // 設定に関係しない変化（瞬時電力だけ）では取り直さない
  server.pushAll('adapter', detail(a1({ power: { value: 900, at: 5000 } })))
  await settle(3)
  assert.equal(settingsCalls(), s0 + 1, '関係しない変化では取り直さない')

  // 画面の「自動運転に戻す」: 応答の adapter で上書きが外れたことが分かる → 取り直して「設定ノード」に戻る
  click(buttonByText(m.root, S.actions.more))
  await settle(1)
  click(buttonByText($(m.root, '.menu-list'), S.actions.auto))
  assert.ok(await until(() => source().startsWith(S.settings.source.config)), source())
  assert.ok(settingsCalls() >= s0 + 2)
  await m.unmount()
})

// SSE が使えない間（5 秒ごとの取得）は、サーバーの SSE の settings も届かない。
// 周期の GET adapters/:id で上書きが変わったと分かったら、settings を取り直す。
// 戻すと落ちるもの: app.js の settingsSignature の取り直しを外す → 出どころが「設定ノード」のまま。
test('SSE が使えない間（5 秒ごとの取得）も、上書きの変化で設定を取り直す', async () => {
  let ov = null
  const settingsOf = () => ({
    rev: 'r1',
    fields: { pollIntervalSec: { value: ov === null ? 30 : ov, source: ov === null ? 'config' : 'override', configValue: 30, default: 30, min: 15, max: 3600, by: null, at: null } },
    warnings: [],
  })
  const a1 = () => summary('a1', { pollIntervalSec: ov === null ? 30 : ov, overridden: { stopped: null, any: ov !== null } })
  const server = fakeServer({ items: [a1()], streamDown: true, settingsOf })
  const m = await start({
    width: 1280,
    hash: '#/adapters/a1/settings',
    server,
    env: { pollMs: 50, liveOptions: { retryDelaysMs: [5, 5], pollRetryMs: 60_000 } },
  })
  const source = () => textOf($(m.root, '.src-row[data-field="pollIntervalSec"] .set-source'))
  assert.ok(await until(() => textOf($(m.root, '.live-chip .live-label')) === S.live.polling))
  assert.ok(await until(() => source().startsWith(S.settings.source.config)), source())
  ov = 120
  server.setItems([a1()])
  assert.ok(await until(() => source().startsWith(S.settings.source.override)), source())
  await m.unmount()
})
// 「エディタを開く / エディタで開く」は Meta.editorRoot（httpAdminRoot）から作る。
// httpNodeRoot が /n/ で httpAdminRoot が / のサーバーで、画面の 2 つ上（/n/）を開いていた。
// 古いサーバー（editorRoot が無い）では今までどおり 2 つ上、null（エディタが無効）ならリンクを出さない。
// 戻すと落ちるもの: app.js が meta を見ずに editorRootFrom(href) のまま → '/' と '/admin/' と null の場合が落ちる。
test('エディタへのリンクは meta.editorRoot から作る（無ければ画面の 2 つ上・null なら出さずに理由を書く）', async () => {
  const page = 'http://127.0.0.1:3985/n/wsuha-broute/ui/'
  const cases = [
    [{ editorRoot: '/' }, 'http://127.0.0.1:3985/'],
    [{ editorRoot: '/admin/' }, 'http://127.0.0.1:3985/admin/'],
    [{ editorRoot: undefined }, 'http://127.0.0.1:3985/n/'],
    [{ editorRoot: null }, null],
  ]
  for (const [metaOver, want] of cases) {
    const label = JSON.stringify(metaOver)
    // 設定タブの構成の「エディタで開く」
    const server = fakeServer({ items: [summary('a1')], metaOver, settingsOf: () => ({ rev: 'r1', fields: {}, warnings: [] }) })
    const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server, env: { href: page + '#/adapters/a1/settings' } })
    assert.ok(await until(() => countOf(server, /\/meta$/) > 0 && !!$(m.root, '.pane-detail .card-head')), label)
    await settle(2)
    const link = () => $(m.root, '.pane-detail a[target="_blank"]')
    if (want) assert.ok(await until(() => link() && link().getAttribute('href') === want + '#node/a1'), label + ' ' + (link() && link().getAttribute('href')))
    else {
      assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes('このサーバーではエディタが無効です')), label)
      assert.equal(link(), null, label + ': リンクを出さない')
    }
    await m.unmount()

    // 0 台の一覧の「エディタを開く」
    const empty = fakeServer({ items: [], metaOver })
    const m2 = await start({ width: 1280, hash: '', server: empty, env: { href: page } })
    assert.ok(await until(() => countOf(empty, /\/meta$/) > 0 && textOf($(m2.root, '.pane-list')).includes(S.list.emptyBody)), label)
    await settle(2)
    const link2 = () => $(m2.root, '.pane-list a[target="_blank"]')
    if (want) assert.ok(await until(() => link2() && link2().getAttribute('href') === want), label + ' ' + (link2() && link2().getAttribute('href')))
    else {
      assert.ok(await until(() => textOf($(m2.root, '.pane-list')).includes('このサーバーではエディタが無効です')), label)
      assert.equal(link2(), null, label + ': リンクを出さない')
    }
    await m2.unmount()
  }
})

// 計測値タブを開いている間は、values を周期で取り直す（サーバーの fresh で古い値を古く見せる）。
// 戻すと落ちるもの: app.js の計測値タブの setInterval を外す → 取り直しが 1 回（入ったときだけ）になる。
test('計測値タブを開いている間は values を周期で取り直し、ほかのタブへ移ったら止める', async () => {
  const server = fakeServer({ items: [summary('a1')] })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server, env: { valuesRefreshMs: 60 } })
  const values = /\/adapters\/a1\/values$/
  const first = countOf(server, values)
  assert.ok(await until(() => countOf(server, values) >= first + 3), `取り直していない: ${first} → ${countOf(server, values)}`)
  win.navigate('#/adapters/a1/status')
  await settle(2)
  const afterLeave = countOf(server, values)
  await wait(300)
  assert.equal(countOf(server, values), afterLeave, '状態タブでは取り直さない')
  await m.unmount()
})

// 3 回続けて繋がらなければ、5 秒ごとの GET adapters（と adapters/:id）に切り替え、帯を出す。
// 戻すと落ちるもの: app.js の polling の setInterval を外す → adapters を取り直さない。
test('SSE が 3 回続けて繋がらなければ「5 秒ごとに更新」にし、帯を出して adapters と adapters/:id を周期で取る', async () => {
  const server = fakeServer({ items: [summary('a1')], streamDown: true })
  const m = await start({
    width: 1280,
    hash: '#/adapters/a1/status',
    server,
    env: { pollMs: 50, liveOptions: { retryDelaysMs: [5, 5], pollRetryMs: 60_000 } },
  })
  assert.ok(await until(() => textOf($(m.root, '.live-chip .live-label')) === S.live.polling), textOf($(m.root, '.live-chip')))
  await settle(1)
  assert.ok(textOf($(m.root, '.notices')).includes(S.banner.polling))
  const list0 = countOf(server, /\/adapters$/)
  const det0 = countOf(server, /\/adapters\/a1$/)
  assert.ok(await until(() => countOf(server, /\/adapters$/) >= list0 + 3), '一覧を周期で取る')
  assert.ok(await until(() => countOf(server, /\/adapters\/a1$/) >= det0 + 3), '選んでいる台の詳細も周期で取る')
  assert.equal(countOf(server, /\/stream$/), 3, '繋ぎ直しは 3 回で止め、30 秒ごとの試しまで待つ')
  await m.unmount()
})

// ---- 構成とポートの候補 ------------------------------------------------------

const CRED_ID = '0123456789ABCDEF0123456789ABCDEF'
const CRED_PW = 'ABCDEF123456'

const PORT_LIST = { items: [{ path: '/dev/ttyUSB0', label: 'RS-WSUHA', manufacturer: 'RATOC Systems', byId: '/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0' }], at: 1000 }
const cfgSection = (m) => $(m.root, '.pane-detail section[data-section="config"]')

// GET config と GET serialports のあるサーバーでは、設定タブの構成が編集できる「構成」になり、ポートの候補が出る。
// 戻すと落ちるもの: app.js が load.config を呼ばない（読み込み中のまま）・DetailPane に config を渡さない（読むだけのまま）。
test('構成の API のあるサーバー: 設定タブに編集できる「構成」とポートの候補。serialports は開いたときに 1 回読む', async () => {
  const server = fakeServer({ items: [summary('a1')], configOf: (id) => configFor(id), ports: PORT_LIST })
  const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server })
  assert.ok(await until(() => !!cfgSection(m) && !!$(cfgSection(m), '#cfg-in-name')), textOf($(m.root, '.pane-detail')).slice(-200))
  assert.equal($(cfgSection(m), '#cfg-in-name').value, 'アダプタ a1')
  assert.ok(await until(() => $$(cfgSection(m), '.port-select option').some((o) => o.value === '/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0')))
  assert.equal(countOf(server, /\/serialports$/), 1)
  assert.equal(countOf(server, /\/adapters\/a1\/config$/) >= 1, true)
  assert.equal(textOf(m.root).includes(S.settings.configTitle), false, '「構成（読むだけ）」は出さない')
  await m.unmount()
})

// 古いサーバー（構成の API が無い: 404 NOT_FOUND）でも壊れず、今までの「構成（読むだけ）」と「エディタで開く」。
// 戻すと落ちるもの: loaders.js が 404 NOT_FOUND を unsupported にしない →「構成を取得できませんでした」になる。
test('構成の API の無い古いサーバー: 「構成（読むだけ）」のまま壊れない（ポートの候補も読まない）', async () => {
  const server = fakeServer({ items: [summary('a1')] })
  const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server })
  assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes(S.settings.configTitle)), textOf($(m.root, '.pane-detail')).slice(-200))
  assert.equal(textOf($(m.root, '.pane-detail')).includes(S.config.loadFailed), false)
  assert.equal(!!$(m.root, '#cfg-cred-id'), false)
  assert.equal(countOf(server, /\/serialports$/), 0)
  assert.ok($(m.root, '.pane-detail a[target="_blank"]'), 'エディタで開く')
  await m.unmount()
})

// SSE の config（構成が変わった）と、詳細の構成の印（名前・ポートなど）の変化で、構成を新しくする。
test('構成は SSE の config で新しくなり、config のイベントが無くても詳細の名前やポートが変われば取り直す', async () => {
  let name = '最初の名前'
  const server = fakeServer({
    items: [summary('a1')],
    liveStreams: true,
    configOf: (id) => configFor(id, { name: { value: name, source: 'config', configValue: name } }),
    ports: PORT_LIST,
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server })
  const nameIn = () => $(cfgSection(m) || m.root, '#cfg-in-name')
  assert.ok(await until(() => nameIn() && nameIn().value === '最初の名前'))
  server.pushAll('config', { adapterId: 'a1', config: configFor('a1', { name: { value: 'SSE の名前', source: 'runtime', runtimeValue: 'SSE の名前', by: 'web-ui', at: 1 } }) })
  assert.ok(await until(() => nameIn().value === 'SSE の名前'), nameIn().value)
  // config のイベントを出さないサーバー: 詳細の port が変わったら GET config を取り直す
  const before = countOf(server, /\/adapters\/a1\/config$/)
  name = '取り直した名前'
  server.pushAll('adapter', detail(summary('a1', { port: '/dev/ttyUSB1' })))
  assert.ok(await until(() => countOf(server, /\/adapters\/a1\/config$/) > before), '取り直す')
  assert.ok(await until(() => nameIn().value === '取り直した名前'), nameIn().value)
  await m.unmount()
})

// settings.js の wsuhaBroute.uiConfig: false なら 403 CONFIG_LOCKED。構成と認証情報のボタンを止めて message を出す。運用設定と操作は止めない。
test('構成の保存が 403 CONFIG_LOCKED: 構成と認証情報を止めて message を出す。運用設定と操作は止めない', async () => {
  const msg = '構成の変更を止めています（settings.js の wsuhaBroute.uiConfig）'
  const server = fakeServer({
    items: [summary('a1')],
    configOf: (id) => configFor(id),
    ports: PORT_LIST,
    settingsOf: () => ({ rev: 'r1', fields: { slowIntervalSec: { value: 300, source: 'default', configValue: null, default: 300, min: 60, max: 3600 } }, warnings: [] }),
    onConfigWrite: () => ({ status: 403, body: { error: { code: 'CONFIG_LOCKED', message: msg } } }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server })
  assert.ok(await until(() => !!$(m.root, '#cfg-in-name')))
  typeInto($(m.root, '#cfg-in-name'), '新しい名前')
  await settle()
  fire($(m.root, 'form.config-form'), 'submit')
  await settle()
  fire($(m.root, '.dialog-form'), 'submit')
  assert.ok(await until(() => $(m.root, '#cfg-in-name').hasAttribute('disabled')), '構成を止める')
  assert.ok(textOf(cfgSection(m)).includes(msg))
  assert.equal(buttonByText(m.root, S.config.credReenter).hasAttribute('disabled'), true, '認証情報の欄も開かせない')
  assert.equal($(m.root, '#in-slowIntervalSec').hasAttribute('disabled'), false, '運用設定は止めない')
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), false, '操作は止めない')
  await m.unmount()
})

// 認証情報の値は PUT credentials の本文にだけ載る。ほかの要求・画面には出さない。保存したら GET config で状態を取り直す。
test('認証情報の保存: 値は PUT credentials の本文だけ。画面に残さず、GET config で状態を取り直す', async () => {
  const writes = []
  const server = fakeServer({
    items: [summary('a1')],
    configOf: (id) => configFor(id),
    ports: PORT_LIST,
    onConfigWrite: (method, kind, id, body) => (writes.push({ method, kind, id, body }), { status: 200, body: { ok: true } }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/settings', server })
  // 設定済みなら欄は閉じている。［入れ直す］で開く
  assert.ok(await until(() => !!buttonByText(m.root, S.config.credReenter)))
  click(buttonByText(m.root, S.config.credReenter))
  assert.ok(await until(() => !!$(m.root, '#cfg-cred-id')))
  typeInto($(m.root, '#cfg-cred-id'), CRED_ID)
  typeInto($(m.root, '#cfg-cred-password'), CRED_PW)
  await settle()
  fire($(m.root, 'form.cred-form'), 'submit')
  await settle()
  const before = countOf(server, /\/adapters\/a1\/config$/)
  fire($(m.root, '.dialog-form'), 'submit')
  assert.ok(await until(() => writes.length === 1))
  assert.deepEqual(writes[0], { method: 'PUT', kind: 'credentials', id: 'a1', body: { routeBId: CRED_ID, routeBPassword: CRED_PW } })
  assert.ok(await until(() => countOf(server, /\/adapters\/a1\/config$/) > before), '状態を取り直す')
  const others = server.calls.filter((c) => !/\/credentials$/.test(new URL(c.url).pathname))
  assert.equal(JSON.stringify(others.map((c) => [c.url, c.init.body || null])).includes(CRED_ID), false, 'ほかの要求に値を載せない')
  assert.equal($(m.root, '#cfg-cred-id'), null, '保存したら欄を閉じる（値を残さない）')
  assert.equal(textOf(m.root).includes(CRED_ID) || textOf(m.root).includes(CRED_PW), false)
  await m.unmount()
})

// 見えていないタブが SSE を持ち続けると、同じホストの接続の枠（HTTP/1.1 で 6 本）を埋めて、ほかのタブとエディタを待たせる。
// 戻すと落ちるもの: app.js の paused を外す（見えなくなっても SSE を閉じない）・戻ったときに取り直さない。
test('見えていないタブが続いたら SSE を閉じ、見えたら繋ぎ直して取り直す', async () => {
  // 偽の document には visibilitychange が無いので、受け手だけ持たせる
  const fns = []
  document.addEventListener = (t, f) => t === 'visibilitychange' && fns.push(f)
  document.removeEventListener = (t, f) => fns.splice(fns.indexOf(f), 1)
  const changed = () => fns.slice().forEach((f) => f())
  const server = fakeServer({ items: [summary('a1')], liveStreams: true })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { hiddenPauseMs: 20 } })
  assert.ok(await until(() => server.openStreams().length === 1), '繋がる')
  const before = countOf(server, /\/adapters$/)
  document.hidden = true
  changed()
  assert.ok(await until(() => server.openStreams().length === 0), '閉じる')
  document.hidden = false
  changed()
  assert.ok(await until(() => server.openStreams().length === 1), '繋ぎ直す')
  assert.ok(await until(() => countOf(server, /\/adapters$/) > before), '閉じていた間のことを取り直す')
  await m.unmount()
  delete document.addEventListener
  delete document.removeEventListener
  delete document.hidden
})

// ---- Node-RED の認証（値は誰でも見え、変更はエディタにログインした人だけ） ------------------------

const TOKEN = 'ZmFrZS10b2tlbi1mb3ItdGVzdHM'
const TOKEN_HEADER = 'X-Wsuha-Editor-Token'
const authMeta = (over = {}) => ({ auth: Object.assign({ required: true, available: true, editorPath: '/' }, over) })
/** 本物の GET session と同じく、トークンがあればログイン済み（匿名でも 200）。 */
const sessionByToken = (h) => {
  const ok = h[TOKEN_HEADER] === TOKEN
  return { required: true, loggedIn: ok, canWrite: ok }
}
const putToken = (s, key = 'auth-tokens') => s.set(key, JSON.stringify({ access_token: TOKEN, expires_in: 604800, token_type: 'Bearer' }))
const countSession = (server) => countOf(server, /\/session$/)
const withToken = (server) => server.calls.filter((c) => (c.init.headers || {})[TOKEN_HEADER] !== undefined).map((c) => (c.init.method || 'GET') + ' ' + new URL(c.url).pathname.replace(/^.*\/api\/v1\//, ''))

// 戻すと落ちるもの: app.js が帯に authReason を渡さない・loginHref を作らない・writeBlockReason が auth を見ない
test('認証あり・ログインしていない: 値と状態は見える。操作は止め、帯の［Node-RED にログイン］はエディタを別のタブで開く', async () => {
  const server = fakeServer({ items: [summary('a1')], metaOver: Object.assign({}, ADD_META, authMeta({ editorPath: '/admin/' })), sessionOf: sessionByToken })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => textOf($(m.root, '.notices')).includes(S.auth.loginRequired)), textOf($(m.root, '.notices')))
  const link = $(m.root, '.notices a.btn')
  assert.ok(link, 'ログインのリンク')
  assert.equal(textOf(link), S.auth.login)
  assert.equal(link.getAttribute('href'), 'http://127.0.0.1:3985/admin/')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.equal(link.getAttribute('rel'), 'noopener')
  assert.equal(textOf($(m.root, '.dhead-name')), 'アダプタ a1', '値と状態は見える')
  assert.equal($$(m.root, 'a.row').length, 1)
  const poll = buttonByText(m.root, S.actions.poll)
  assert.equal(poll.hasAttribute('disabled'), true)
  assert.equal(poll.getAttribute('title'), S.auth.loginRequired)
  assert.equal(!!$(m.root, 'input[type="password"]'), false, '画面にログインのフォームを作らない')
  assert.equal(textOf($(m.root, '.pane-list')).includes(S.auth.loginRequired), true, '追加のボタンの下にも理由')
  assert.equal($(m.root, '[data-add="add"]').hasAttribute('disabled'), true)
  await m.unmount()
})

// 戻すと落ちるもの: createApi に storage を渡さない・load.meta が session を読まない・トークンを全部の要求に載せる
test('認証あり・ログイン済み: 案内は一度も出さず操作できる。トークンは session と変更の要求にだけ載る', async () => {
  const storage = memStorage()
  putToken(storage, 'auth-tokens-admin')
  const server = fakeServer({ items: [summary('a1'), summary('a2')], metaOver: authMeta({ editorPath: '/admin/' }), sessionOf: sessionByToken })
  const seen = new Set()
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const n = document.body.querySelector('.notices')
      if (n && textOf(n).includes(S.auth.loginRequired)) seen.add('帯')
      await wait(2)
    }
  })()
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { storage } })
  assert.ok(await until(() => countSession(server) > 0))
  await settle(2)
  sampling = false
  await sampler
  assert.deepEqual([...seen], [], 'ログインしている人に案内を出した')
  const poll = buttonByText(m.root, S.actions.poll)
  assert.equal(poll.hasAttribute('disabled'), false)
  click(poll)
  assert.ok(await until(() => server.calls.some((c) => c.init.method === 'POST')))
  // エディタのパスが分かったあとの読むだけの要求にも載せない（タブを移ると取り直す）
  const reads = countOf(server, /\/adapters\/a2\/values$/)
  win.navigate('#/adapters/a2/values')
  assert.ok(await until(() => countOf(server, /\/adapters\/a2\/values$/) > reads))
  await settle(2)
  assert.deepEqual(withToken(server), ['GET session', 'POST adapters/a1/actions/poll'])
  assert.deepEqual(server.calls.filter(hasAuthHeader).map((c) => c.url), [], 'Authorization は使わない')
  assert.equal(textOf(m.root).includes(TOKEN), false)
  await m.unmount()
})

// 戻すと落ちるもの: app.js の storage・focus の待ち受けを外す
test('別のタブでログインして戻ると止めが解け、ログアウトすると掛け直す（storage・focus）', async () => {
  const storage = memStorage()
  const server = fakeServer({ items: [summary('a1')], metaOver: authMeta(), sessionOf: sessionByToken })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { storage } })
  const band = () => textOf($(m.root, '.notices')).includes(S.auth.loginRequired)
  assert.ok(await until(band))
  putToken(storage)
  win.fire('storage', { key: 'auth-tokens' })
  assert.ok(await until(() => !band()), 'storage で解ける')
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), false)
  storage.remove('auth-tokens')
  win.fire('focus')
  assert.ok(await until(band), 'focus で掛け直す')
  // エディタがほかの設定を書いただけでは問い合わせない
  const n = countSession(server)
  win.fire('storage', { key: 'editor-tab-state' })
  await settle(1)
  assert.equal(countSession(server), n)
  await m.unmount()
})

test('認証の無いサーバー: session を問い合わせず、案内も出さない。focus でも問い合わせない', async () => {
  const server = fakeServer({ items: [summary('a1')], metaOver: { auth: { required: false, available: false, editorPath: null } } })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => countOf(server, /\/meta$/) > 0))
  win.fire('focus')
  await settle(2)
  assert.equal(countSession(server), 0)
  assert.equal(textOf(m.root).includes(S.auth.loginRequired), false)
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), false)
  await m.unmount()
})

// 戻すと落ちるもの: operations.js が 401 LOGIN_REQUIRED を止めに映さない
test('変更が 401 LOGIN_REQUIRED（トークンが切れた）: 止めて同じ案内を出す', async () => {
  const storage = memStorage()
  putToken(storage)
  const server = fakeServer({ items: [summary('a1')], metaOver: authMeta(), sessionOf: sessionByToken })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { storage } })
  assert.ok(await until(() => countSession(server) > 0 && buttonByText(m.root, S.actions.poll).hasAttribute('disabled') === false))
  server.denyWrites = { status: 401, body: { error: { code: 'LOGIN_REQUIRED', message: S.auth.loginRequired } } }
  click(buttonByText(m.root, S.actions.poll))
  assert.ok(await until(() => textOf($(m.root, '.notices')).includes(S.auth.loginRequired)), textOf(m.root).slice(0, 200))
  assert.ok($(m.root, '.notices a.btn'), 'ログインのリンク')
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), true)
  await m.unmount()
})

test('権限が足りない: 別の文を出し、ログインを勧めない', async () => {
  const storage = memStorage()
  putToken(storage)
  const server = fakeServer({ items: [summary('a1')], metaOver: authMeta(), sessionOf: () => ({ required: true, loggedIn: true, canWrite: false }) })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { storage } })
  assert.ok(await until(() => textOf($(m.root, '.notices')).includes(S.auth.forbidden)), textOf($(m.root, '.notices')))
  assert.equal(!!$(m.root, '.notices a.btn'), false)
  assert.equal(buttonByText(m.root, S.actions.poll).getAttribute('title'), S.auth.forbidden)
  await m.unmount()
})

// ログインを勧めても手が無いので、案内の文を分ける。
// 戻すと落ちるもの: store.js の authBlockReason が available を見ない
test('ログインできないサーバー（available が false）: 帯に入口が無いことだけを出し、リンクを出さない', async () => {
  const server = fakeServer({
    items: [summary('a1')],
    metaOver: authMeta({ available: false, editorPath: null }),
    sessionOf: () => ({ required: true, loggedIn: false, canWrite: false }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => textOf($(m.root, '.notices')).includes(S.auth.noLogin)))
  assert.equal(textOf(m.root).includes(S.auth.loginRequired), false)
  assert.equal(!!$(m.root, '.notices a.btn'), false)
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), true)
  await m.unmount()
})

// 戻すと落ちるもの: loaders.js が editorPathOf を通さない（鍵が読めない）・app.js が href を渡さない
test('接頭辞の裏（逆プロキシ）: エディタと同じ鍵のトークンを読み、ログインのリンクは接頭辞の中を指す', async () => {
  const storage = memStorage()
  const server = fakeServer({ items: [summary('a1')], metaOver: authMeta({ editorPath: '/', nodeRoot: '/' }), sessionOf: sessionByToken })
  const href = 'http://127.0.0.1:3985/nodered/wsuha-broute/ui/'
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { storage, href } })
  assert.ok(await until(() => !!$(m.root, '.notices a.btn')))
  assert.equal($(m.root, '.notices a.btn').getAttribute('href'), 'http://127.0.0.1:3985/nodered/')
  // エディタは接頭辞の入った鍵に置く
  putToken(storage, 'auth-tokens-nodered')
  win.fire('focus')
  assert.ok(await until(() => !$(m.root, '.notices a.btn')), '帯が消える')
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), false)
  await m.unmount()
})

test('読み出しのみのサーバー: ログインしても解けないので、ログインの案内を出さない', async () => {
  const server = fakeServer({ items: [summary('a1')], metaOver: Object.assign({ readOnly: true }, authMeta()), sessionOf: sessionByToken })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => buttonByText(m.root, S.actions.poll).getAttribute('title') === S.actions.readOnlyReason))
  await settle(2)
  assert.equal(textOf(m.root).includes(S.auth.loginRequired), false)
  await m.unmount()
})

// ---- App を通して初めて分かる配線（部品の試験は props を直接渡すので見えない） ---------------------

// 実物の service.totalOf の値と違う数にして、画面が数え直していないことを見る。
// 戻すと落ちるもの: app.js の SSE の adapters で total を渡さない → 500 W（画面の数え直し）になる
test('一覧の合計は SSE の total を使う（REST の total も消さない）', async () => {
  const server = fakeServer({ items: [summary('a1')], liveStreams: true, total: { power: 111, count: 9, enabled: 9, staleCount: 0 } })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  const total = () => textOf($(m.root, '.total'))
  assert.ok(await until(() => textOf($(m.root, '.live-chip')) === S.live.live))
  assert.ok(total().includes('111 W'), total())
  assert.ok(total().includes(S.list.totalPowerNote(9, 9)), total())
  server.pushAll('adapters', { items: server.items, total: { power: 999, count: 1, enabled: 2, staleCount: 0 } })
  assert.ok(await until(() => total().includes('999 W')), total())
  assert.ok(total().includes(S.list.totalPowerNote(1, 2)), total())
  await m.unmount()
})

// 戻すと落ちるもの: app.js の DetailPane に meta を渡さない → 「17 時 26 分より前は記録がありません。」のまま
test('推移: Node-RED の起動が範囲の中なら「再起動したため記録がありません」', async () => {
  const now = Date.now()
  const startedAt = now - 20 * 60e3
  const pts = []
  for (let t = startedAt + 30e3; t <= now; t += 30e3) pts.push([t, 100])
  const server = fakeServer({
    items: [summary('a1')],
    metaOver: { startedAt },
    trendOf: () => ({ series: { power: pts, currentR: [], currentT: [], lqi: [] }, from: now - 3600e3, to: now }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  const before = () => textOf($(m.root, '.trend-before'))
  assert.ok(await until(() => before() !== ''), textOf($(m.root, '.pane-detail')).slice(-200))
  const d = new Date(pts[0][0])
  assert.equal(before(), S.values.noDataRestart(d.getHours(), d.getMinutes()))
  await m.unmount()
})

// 戻すと落ちるもの: skip-link の preventDefault を外す → #main が「一覧」と読まれ、先頭の台へ移って下書きも消える
test('本文へ移動: 経路を変えず、本文にフォーカスを移す', async () => {
  const server = fakeServer({ items: [summary('a1'), summary('a2')] })
  const m = await start({ width: 1280, hash: '#/adapters/a2/settings', server })
  const ev = click($(m.root, '.skip-link'))
  assert.equal(ev.defaultPrevented, true, 'リンクの遷移を止める')
  assert.equal(document.activeElement === $(m.root, '#main'), true, '本文へ')
  assert.equal(win.location.hash, '#/adapters/a2/settings')
  await m.unmount()
})

const ADD_META = { addAdapter: { available: true, reason: null, count: 1, limit: 8, tabLabel: 'B ルート（Web UI で追加）', envOverrides: false }, editorRoot: '/' }

async function addSimulator(m) {
  assert.ok(await until(() => {
    const b = $(m.root, '[data-add="add"]')
    return !!b && !b.hasAttribute('disabled')
  }))
  click($(m.root, '[data-add="add"]'))
  assert.ok(await until(() => !!$(m.root, '#add-in-role')))
  const sel = $(m.root, '#add-in-role')
  sel.value = '動力'
  fire(sel, 'change')
  await settle()
  fire($(m.root, '#add-in-mode-simulator'), 'change')
  await settle()
  fire($(m.root, 'form.add-form'), 'submit')
}

// 設定ノードの id をエディタに渡すと、全部の欄が空の編集画面が開く。
// 戻すと落ちるもの: app.js の nodeId を r.nodes.deviceId に戻す
test('追加の 201: 緑のトーストの［エディタで開く］は B ルートノードを指す。新しい台の状態タブへ移る', async () => {
  const added = summary('d2', { name: '動力の台' })
  const server = fakeServer({
    items: [summary('a1')],
    metaOver: ADD_META,
    onAddAdapter: () => {
      server.setItems([summary('a1'), added])
      return { status: 201, body: { ok: true, message: '追加しました', adapter: detail(added), nodes: { deviceId: 'd2', brouteId: 'b2', tabId: 't1', tabLabel: 'x', tabCreated: true }, started: true, warnings: [] } }
    },
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  await addSimulator(m)
  assert.ok(await until(() => !!$(m.root, '.toast')), textOf(m.root).slice(-200))
  const toast = $(m.root, '.toast')
  assert.ok(cls(toast).includes('tone-ok'), cls(toast))
  assert.equal(textOf($(toast, '.toast-title')), S.add.added('動力の台'))
  assert.equal($(toast, '.toast-action').getAttribute('href'), 'http://127.0.0.1:3985/#node/b2/edit')
  assert.ok(await until(() => win.location.hash === '#/adapters/d2/status'), win.location.hash)
  await m.unmount()
})

// 202（10 秒以内に動き出さなかった）は注意のトーストで、見つかりませんの回復で拾う。
// 戻すと落ちるもの: 緑のトーストのままにする・一覧へ移す（PC では先頭の別の台が開く）
test('追加の 202: 注意のトーストを出し、足した台を開いて待つ。動き出すと自動で表示し直す', async () => {
  const message = 'フローには追加しました。動き出すのを待っています'
  const added = summary('d9', { name: '動力の台' })
  const server = fakeServer({
    items: [summary('a1')],
    liveStreams: true,
    metaOver: ADD_META,
    onAddAdapter: () => ({ status: 202, body: { ok: true, message, adapter: null, nodes: { deviceId: 'd9', brouteId: 'b9', tabId: 't1', tabLabel: 'x', tabCreated: true }, started: false, warnings: [] } }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  await addSimulator(m)
  assert.ok(await until(() => !!$(m.root, '.toast')), textOf(m.root).slice(-200))
  const toast = $(m.root, '.toast')
  assert.ok(cls(toast).includes('tone-warn'), cls(toast))
  assert.equal(textOf($(toast, '.toast-title')), message)
  assert.equal(!!$(toast, '.toast-text'), false, '同じ文を 2 度出さない')
  assert.equal($(toast, '.toast-action').getAttribute('href'), 'http://127.0.0.1:3985/#node/b9/edit')
  assert.ok(await until(() => win.location.hash === '#/adapters/d9/status'), win.location.hash)
  assert.ok(await until(() => textOf($(m.root, '.pane-detail')).includes(S.detail.notFoundHint)), textOf($(m.root, '.pane-detail')).slice(0, 100))
  server.setItems([summary('a1'), added])
  server.pushAll('adapters', { items: server.items })
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === '動力の台'), '動き出すと表示し直す')
  await m.unmount()
})

// CONFIG_LOCKED は state に映らないので、帯に出さないと［追加］を押しても何も起きないように見える。
// 開いたままの画面の meta は 5 分ごとにしか新しくならない。
// 戻すと落ちるもの: add-pane.js の BLOCKING_CODES に CONFIG_LOCKED を戻す・app.js の onAdd が load.meta() を呼ばない・
//   帯があるのに add.reason の知らせも出す
test('追加の 403 CONFIG_LOCKED: 帯にサーバーの文を出す。meta を取り直して［追加］を止め、同じ趣旨の文を重ねない', async () => {
  const message = 'settings.js で止めています。エディタで追加してください'
  const metaOver = Object.assign({}, ADD_META)
  const server = fakeServer({
    items: [summary('a1')],
    metaOver,
    onAddAdapter: () => {
      metaOver.addAdapter = Object.assign({}, ADD_META.addAdapter, { locked: true })
      return { status: 403, body: { error: { code: 'CONFIG_LOCKED', message } } }
    },
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  await addSimulator(m)
  const wrap = () => $(m.root, '.add-form-wrap')
  assert.ok(await until(() => textOf(wrap()).includes(message)), textOf(wrap()).slice(0, 200))
  assert.ok(textOf(wrap()).includes(S.add.errors.CONFIG_LOCKED), '見出し')
  assert.ok(await until(() => $(m.root, '.add-bar button[type="submit"]').hasAttribute('disabled')), '止めが新しくなる')
  assert.equal($(m.root, '[data-add="add"]').hasAttribute('disabled'), true, '一覧のボタンも止まる')
  assert.equal(textOf(wrap()).includes(S.list.addLocked), false, textOf(wrap()).slice(0, 200))
  assert.equal(textOf(wrap()).split(message).length - 1, 1, '帯は 1 回')
  await m.unmount()
})

// スマートフォンの全画面のモーダルでは裏の帯が見えず、閉じると入力が消える。モーダルの中からログインへ行けないと行き止まりになる。
// 戻すと落ちるもの: add-pane.js の知らせにリンクを渡さない・帯にも同じ文を出す・app.js が loginHref を渡さない
test('追加の 401 LOGIN_REQUIRED: 理由は 1 回で、モーダルの中からログインへ行ける。ログインして戻ると入力を残したまま押せる', async () => {
  const storage = memStorage()
  putToken(storage)
  const server = fakeServer({
    items: [summary('a1')],
    metaOver: Object.assign({}, ADD_META, authMeta()),
    sessionOf: sessionByToken,
    onAddAdapter: () => ({ status: 401, body: { error: { code: 'LOGIN_REQUIRED', message: S.auth.loginRequired } } }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server, env: { storage } })
  await addSimulator(m)
  const wrap = () => $(m.root, '.add-form-wrap')
  assert.ok(await until(() => textOf(wrap()).includes(S.auth.loginRequired)), textOf(wrap()).slice(0, 200))
  assert.equal($(m.root, '.add-bar button[type="submit"]').hasAttribute('disabled'), true, '送れなくする')
  assert.equal(textOf(wrap()).split(S.auth.loginRequired).length - 1, 1, textOf(wrap()).slice(0, 200))
  assert.equal(textOf(wrap()).includes(S.add.errors.LOGIN_REQUIRED), false, '同じ趣旨の見出しを重ねない')
  const link = $(wrap(), '.notice a.btn')
  assert.ok(link, 'ログインのリンク')
  assert.equal(link.getAttribute('target'), '_blank', '入力を失わないように別のタブで開く')
  assert.ok(textOf(link).includes(S.auth.login))
  assert.ok(textOf($(m.root, '.notices')).includes(S.auth.loginRequired))
  const roleBefore = $(m.root, '#add-in-role').value
  // 別のタブでログインして戻る
  putToken(storage)
  win.fire('focus')
  assert.ok(await until(() => !$(m.root, '.add-bar button[type="submit"]').hasAttribute('disabled')), '止めを解く')
  assert.equal($(m.root, '#add-in-role').value, roleBefore, '入力が残る')
  assert.equal(!!$(wrap(), '.notice a.btn'), false)
  await m.unmount()
})
