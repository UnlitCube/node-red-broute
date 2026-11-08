// App を丸ごと描いて、サーバーの形 → loaders → store → 部品の配線を確かめる（偽のサーバーの形は本物の関数から作る）。
// 部品に props を直接渡す試験は、途中で落ちた値を見られない（API は返すのに画面に出ない型）。系列や項目を足したら、ここを通す試験も足す。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, settle, click, typeInto, fire, $, $$, textOf, buttonByText } from './fake-dom.mjs'
import { H, summary, detail, configFor, settingsFor, fakeServer, appStarter, wait, until, countOf } from './fake-server.mjs'

const dom = installDom({ width: 1280 })
const win = dom.window
const { html } = await import('../../ui/html.js')
const { S } = await import('../../ui/strings.js')
const { App } = await import('../../ui/app.js')

const mounted = []
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount()
})
const start = appStarter({ win, html, App, mounted })

const MIN = 60e3
const ID = '0123456789ABCDEF0123456789ABCDEF'
const active = () => (document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('id') : null)
const PORTS = {
  items: [
    { path: '/dev/serial/by-id/usb-RATOC_RS-WSUHA_A1-if00-port0', label: 'RS-WSUHA', manufacturer: 'RATOC Systems', byId: true, realPath: '/dev/ttyUSB0', portLabel: 'USB0', kind: 'wsuha', hint: null, usedBy: null, aliases: ['/dev/ttyUSB0'] },
    { path: '/dev/ttyUSB1', manufacturer: 'FTDI', byId: false, realPath: '/dev/ttyUSB1', portLabel: 'USB1', kind: 'maybe', hint: null, usedBy: { kind: 'adapter', id: 'a2', name: '動力（USB1）', type: 'wsuha-device' }, aliases: [] },
  ],
  at: 1000,
}

/** 本物の registry の行（[ts, power, r, t, lqi]）。from から to まで step ごと。 */
function rows(from, to, step = 30e3, fn = () => [100, 3, 2, 60]) {
  const out = []
  for (let t = from; t <= to; t += step) out.push([t, ...fn(t)])
  return out
}

// ---- 状態タブ ------------------------------------------------------------------------------------

// 戻すと落ちるもの: strings.js の counters から 1 つ外す（pairs はラベルのあるキーだけを回す）
test('状態タブの「詳しい状態」: サーバーの counters の値が全部出る', async () => {
  const counters = { tx: 11, rx: 12, failures: 13, timeouts: 14, joins: 15, reconnects: 16, resends: 17, resendRecovered: 18, targetedScans: 19, fullScans: 20 }
  const server = fakeServer({ items: [summary('a1', { counters })] })
  // 一覧の形に無い counters は detail() が受ける
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => !!$(m.root, '[data-sec="counters"]')))
  const text = textOf($(m.root, '[data-sec="counters"]'))
  for (const k of Object.keys(counters)) assert.ok(text.includes(S.status.pair(S.status.counters[k], String(counters[k]))), k + ': ' + text)
})

// 戻すと落ちるもの: tab-status.js の read() で結果を見ない → スピナーが止まるだけで何も出ない
test('「いま読む」の失敗: 押した場所に理由を出す。BUSY はトーストに任せて出さない', async () => {
  let reply = { status: 503, body: { error: { code: 'DEVICE_ERROR', message: 'アダプタが応答しません。USB の接続を確かめてください' } } }
  const server = fakeServer({ items: [summary('a1')], onDiag: () => reply })
  const m = await start({ width: 1280, hash: '#/adapters/a1/status', server })
  assert.ok(await until(() => !!buttonByText(m.root, S.status.txReadNow)))
  const tx = () => $(m.root, '[data-sec="tx"]')
  click(buttonByText(m.root, S.status.txReadNow))
  assert.ok(await until(() => !!$(tx(), '.field-error')), textOf(tx()))
  assert.ok(textOf($(tx(), '.field-error')).includes('アダプタが応答しません'))
  assert.equal($(tx(), '.field-error').getAttribute('role'), 'alert')
  // 押し直すと前の理由を消す。BUSY は失敗ではない
  reply = { status: 409, body: { error: { code: 'BUSY', message: 'ほかの取得が終わるまでお待ちください' } } }
  click(buttonByText(m.root, S.status.txReadNow))
  assert.ok(await until(() => !$(tx(), '.field-error')))
  assert.ok(await until(() => !!$(m.root, '.toast')))
  await settle(2)
  assert.equal(!!$(tx(), '.field-error'), false)
})

// ---- 計測値の表（GET values に GET read を重ねる） -----------------------------------------------

// 作り直しの直後: 今の sequencer はまだ値を持たず、registry が持ち越した値だけがある。
// 戻すと落ちるもの: mergeRead の行に label を写さない → 名前の列が正式な名前に変わる
test('計測値の表: 作り直しの直後も短い名前のまま read の値を出す。まだ取れていない値は「まだ取れていません」', async () => {
  const at = Date.now() - 5000
  const server = fakeServer({
    items: [summary('a1')],
    known: () => ({}),
    read: () => ({ '0xE7': { value: 1234, unit: 'W', display: '1234 W', at, name: '瞬時電力計測値' } }),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  const row = () => $(m.root, 'tr[data-epc="0xE7"]') || $(m.root, 'tr[data-epc="E7"]')
  assert.ok(await until(() => !!row() && textOf(row()).includes('1,234 W')), textOf($(m.root, '.pane-detail')).slice(-200))
  assert.equal(textOf($(row(), '.c-name')), '瞬時電力', '表の短い名前のまま')
  assert.equal($(row(), '.c-name').getAttribute('title'), '瞬時電力計測値', '正式な名前は title')
  const e8 = () => $(m.root, 'tr[data-epc="0xE8"]') || $(m.root, 'tr[data-epc="E8"]')
  assert.ok(e8(), '定期取得でまだ取れていない値の行')
  assert.equal(textOf($(e8(), '.c-state')), S.values.missing)
})

// ---- 推移 ----------------------------------------------------------------------------------------

// 実ブラウザで見つけた型: API は series.lqi を返すのに、途中で落ちて画面に出なかった。
test('推移: サーバーの series.lqi が store を通ってグラフに出る', async () => {
  const now = Date.now()
  const server = fakeServer({ items: [summary('a1')], trendRows: () => rows(now - 10 * MIN, now - 1000) })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  assert.ok(await until(() => $$(m.root, '.chart-series.series-lqi .chart-line').length === 1), textOf($(m.root, '.pane-detail')).slice(0, 200))
  assert.ok(textOf(m.root).includes(S.values.seriesLqi))
})

// 再起動していないのに範囲の先頭が途切れの途中にあると、45 分欠けた 1 時間に「途切れずに取れています」と出ていた。
// 戻すと落ちるもの: gapStats に startedAt を渡さない・先頭の欠けを途切れにしない
test('推移: Node-RED が範囲の前から動いていたら、範囲の先頭の欠けも途切れにして割合に入れる', async () => {
  const now = Date.now()
  const first = now - 15 * MIN
  const server = fakeServer({ items: [summary('a1')], metaOver: { startedAt: now - 5 * 3600e3 }, trendRows: () => rows(first, now - 1000) })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  const cov = () => textOf($(m.root, '.trend-coverage'))
  assert.ok(await until(() => cov() !== ''), textOf($(m.root, '.pane-detail')).slice(0, 200))
  assert.equal(cov().includes('途切れ 1 回'), true, cov())
  assert.ok(cov().includes('25%'), cov())
  assert.equal(cov().includes('途切れずに'), false, cov())
  assert.equal(!!$(m.root, '.trend-before'), false, '記録が無いとは言わない')
  assert.ok($$(m.root, '.chart-gap').length >= 1, '帯を出す')
})

// 戻すと落ちるもの: trendSummary が「記録のある間」の文に切り替えない → 「この 1 時間は途切れずに」と「…より前は記録がありません」が並ぶ
test('推移: 再起動で先頭の記録が無いときは、割合の文を「記録のある間」にして再起動の文を添える', async () => {
  const now = Date.now()
  const startedAt = now - 20 * MIN
  const server = fakeServer({ items: [summary('a1')], metaOver: { startedAt }, trendRows: () => rows(startedAt + 30e3, now - 1000) })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  assert.ok(await until(() => textOf($(m.root, '.trend-coverage')) !== ''))
  assert.equal(textOf($(m.root, '.trend-coverage')), S.values.noGapsRecorded)
  assert.ok(textOf($(m.root, '.trend-before')).includes('再起動'))
  assert.equal($$(m.root, '.chart-gap').length, 0)
})

// LQI はメーターの応答のたびに届くので、電力だけ取れない時間の帯が LQI のグラフに無かった。グラフの下の割合とも食い違う。
// 戻すと落ちるもの: tab-values.js が TrendChart に gaps を渡さない
// 帯の計算は Trend の 1 回だけ。グラフが自分で計算し直すと、起動の時刻を受けないので先頭の途切れが消え、LQI は系列が違うので途中の帯も消える。
// 先頭の欠けと途中の穴の両方があれば、3 枚のどれか 1 枚でも gaps を受け取らないと帯の数が変わる。
// 戻すと落ちるもの: tab-values.js が 3 枚の TrendChart のどれか 1 枚に gaps を渡さない
test('推移: 途切れの帯は 3 枚のグラフで同じ位置に出る（先頭の欠け・電力だけ取れない時間も）', async () => {
  const now = Date.now()
  const hole = (t) => t > now - 30 * MIN && t < now - 20 * MIN
  const server = fakeServer({
    items: [summary('a1')],
    metaOver: { startedAt: now - 5 * 3600e3 },
    trendRows: () => rows(now - 45 * MIN, now - 1000, 30e3, (t) => (hole(t) ? [null, null, null, 60] : [100, 3, 2, 60])),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  assert.ok(await until(() => $$(m.root, '.chart-series.series-lqi').length === 1))
  const charts = $$(m.root, 'figure.chart')
  assert.equal(charts.length, 3)
  const bands = charts.map((c) => $$(c, '.chart-gap').map((b) => b.getAttribute('data-from') + '-' + b.getAttribute('data-to')))
  assert.equal(bands[0].length, 2, JSON.stringify(bands))
  assert.deepEqual(bands[1], bands[0], '電流')
  assert.deepEqual(bands[2], bands[0], 'LQI')
})

// 動いている Node-RED に追加した台は、起動の時刻で見ると「台が無かった時間」が途切れに見え、足した直後に不調と誤る。
// 戻すと落ちるもの: tab-values.js が ValuesTab・Trend に a を渡さない・recordingSince を見ない
test('推移: 途中で追加した台は、台が無かった時間を途切れにせず「より前は記録がありません」と出す', async () => {
  const now = Date.now()
  const since = now - 10 * MIN
  const server = fakeServer({
    items: [summary('a1', { recordingSince: since })],
    metaOver: { startedAt: now - 3 * 3600e3 },
    trendRows: () => rows(since + 5e3, now - 1000),
  })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  assert.ok(await until(() => !!$(m.root, '.trend-before')), textOf($(m.root, '.pane-detail')).slice(0, 300))
  assert.equal($$(m.root, '.chart-gap').length, 0)
  const d = new Date(since + 5e3)
  assert.equal(textOf($(m.root, '.trend-before')), S.values.noDataBefore(d.getHours(), d.getMinutes()))
  assert.equal(textOf($(m.root, '.trend-coverage')), S.values.noGapsRecorded)
})

// 計測が止まると to が最後の点のままで、「いま値が来ていない」の帯が開き直すまで出なかった。
// 戻すと落ちるもの: app.js の計測値タブの周期で推移を取り直さない
test('推移: 計測値タブを開いている間は周期で取り直し、値が来なくなった時間を途切れに出す。ほかのタブでは止める', async () => {
  const last = Date.now() - 1000
  const pts = []
  for (let t = last - 20 * MIN; t <= last; t += 30e3) pts.push([t, 100])
  let to = last
  const server = fakeServer({ items: [summary('a1')], metaOver: { startedAt: 1 }, trendOf: () => ({ series: { power: pts, currentR: [], currentT: [], lqi: [] }, from: to - 3600e3, to }) })
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server, env: { valuesRefreshMs: 60 } })
  assert.ok(await until(() => !!$(m.root, 'figure.chart')))
  assert.equal($$(m.root, '.chart-gap[data-from="' + last + '"]').length, 0, 'まだ途切れていない')
  to = last + 10 * MIN
  assert.ok(await until(() => $$(m.root, '.chart-gap[data-from="' + last + '"]').length >= 1), '止まった時刻からの帯')
  assert.equal(!!$(m.root, '.state-loading'), false, '取り直しでグラフを消さない')

  win.navigate('#/adapters/a1/status')
  await settle(2)
  const n = countOf(server, /\/trend$/)
  await wait(250)
  assert.equal(countOf(server, /\/trend$/), n, 'ほかのタブでは取り直さない')
  win.navigate('#/adapters/a1/values')
  assert.ok(await until(() => countOf(server, /\/trend$/) > n), '戻ったらすぐ取り直す')
})

// 戻すと落ちるもの: reducer の trend/loaded が今の範囲と比べない → 重い 24 時間の応答が最後の選択を上書きする
test('推移: 範囲を続けて切り替えても、遅れた応答が最後の選択を上書きしない', async () => {
  const now = Date.now()
  const server = fakeServer({
    items: [summary('a1')],
    trendOf: () => ({ series: { power: [[now - 1000, 100]], currentR: [], currentT: [], lqi: [] }, from: now - 3600e3, to: now }),
  })
  const inner = server.fetchImpl
  const slowRange = '24h'
  server.fetchImpl = async (url, init) => {
    const r = await inner(url, init)
    if (new URL(url).searchParams.get('range') === slowRange) await wait(150)
    return r
  }
  const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
  assert.ok(await until(() => !!$(m.root, 'figure.chart')))
  click(buttonByText(m.root, S.values.ranges['24h']))
  await settle(1)
  click(buttonByText(m.root, S.values.ranges['1h']))
  await wait(300)
  assert.equal(textOf($(m.root, '.seg-on')), S.values.ranges['1h'])
})

// ---- 設定タブ ------------------------------------------------------------------------------------

const settingsServer = (extra = {}) =>
  fakeServer(Object.assign({ items: [summary('a1'), summary('a2')], configOf: (id) => configFor(id), settingsOf: () => settingsFor(), ports: PORTS }, extra))
const tabHref = (id, tab) => `#/adapters/${id}/${tab}`
async function openSettings(m) {
  assert.ok(await until(() => !!$(m.root, '#cfg-in-name') && !!$(m.root, '#in-pollIntervalSec')), textOf($(m.root, '.pane-detail')).slice(-200))
}

// スマートフォンと iPad の縦の戻り方は［← 一覧］とブラウザの戻るしかない。戻っただけで保存していない値が黙って消えていた。
// 戻すと落ちるもの: app.js の paneId を id に戻す（一覧で DetailPane を外す）・hidden の間に設定タブを描かない
test('設定: 1 ペインで一覧へ戻っても、同じ台へ戻れば下書きと認証の欄の入力が残る。別の台を開くと消える', async () => {
  const server = settingsServer()
  const m = await start({ width: 390, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  typeInto($(m.root, '#cfg-in-name'), '手で変えた名前')
  typeInto($(m.root, '#in-pollIntervalSec'), '45')
  click(buttonByText(m.root, S.config.credReenter))
  await settle()
  typeInto($(m.root, '#cfg-cred-id'), ID)
  await settle()

  // ［← 一覧］のあと、行を押して同じ台へ戻る（行は状態タブを開く）
  win.navigate($(m.root, '.back-link').getAttribute('href'))
  assert.ok(await until(() => !!$(m.root, '.pane-list')))
  assert.equal($(m.root, '.pane-detail').hasAttribute('hidden'), true)
  win.navigate($(m.root, 'a.row[data-id="a1"]').getAttribute('href'))
  assert.ok(await until(() => !$(m.root, '.pane-list') && !!$(m.root, '.dhead')))
  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => !$(m.root, '.settings-tab').hasAttribute('hidden')))
  assert.equal($(m.root, '#cfg-in-name').value, '手で変えた名前')
  assert.equal($(m.root, '#in-pollIntervalSec').value, '45')
  assert.equal($(m.root, '#cfg-cred-id').value, ID, '認証の欄は DOM のまま残る')
  assert.ok(textOf($(m.root, 'section[data-card="measure"] .save-bar')).includes(S.settings.dirty))

  // ブラウザの戻る・進むも同じ（ハッシュが変わるだけ）
  win.navigate('#/')
  assert.ok(await until(() => !!$(m.root, '.pane-list')))
  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => !$(m.root, '.pane-list') && !!$(m.root, '.dhead')))
  assert.equal($(m.root, '#in-pollIntervalSec').value, '45')

  // 別の台へ移ると持ち越さない
  win.navigate('#/')
  assert.ok(await until(() => !!$(m.root, '.pane-list')))
  win.navigate(tabHref('a2', 'settings'))
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a2'))
  await openSettings(m)
  assert.equal($(m.root, '#in-pollIntervalSec').value, '30')
  win.navigate('#/')
  assert.ok(await until(() => !!$(m.root, '.pane-list')))
  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a1'))
  await openSettings(m)
  assert.equal($(m.root, '#in-pollIntervalSec').value, '30', '一度ほかの台へ移ったら、前の台の下書きも消える')
})

// 隠した要素の中に開いたままの <dialog> が残ると、見えない幕が一覧の操作まで止める。
// 戻すと落ちるもの: detail-pane.js の hidden の useEffect を消す・SettingsTab の active に !hidden を入れない
test('1 ペインで確認ダイアログを開いたまま一覧へ戻ると、ダイアログを閉じる。戻っても開き直さず、下書きは残る', async () => {
  const server = settingsServer()
  const m = await start({ width: 390, hash: tabHref('a1', 'status'), server })
  assert.ok(await until(() => !!$(m.root, '.dhead') && !!buttonByText(m.root, S.actions.stop)))
  click(buttonByText(m.root, S.actions.stop))
  assert.ok(await until(() => !!$(m.root, 'dialog[open]')))
  win.navigate('#/')
  assert.ok(await until(() => !!$(m.root, '.pane-list') && !$(m.root, 'dialog[open]')), '停止のダイアログが残る')
  win.navigate(tabHref('a1', 'status'))
  assert.ok(await until(() => !!$(m.root, '.dhead')))
  await settle()
  assert.equal(!!$(m.root, 'dialog[open]'), false, '開き直さない')

  win.navigate(tabHref('a1', 'settings'))
  await openSettings(m)
  typeInto($(m.root, '#in-pollIntervalSec'), '45')
  await settle()
  fire($(m.root, 'form.measure-form'), 'submit')
  assert.ok(await until(() => !!$(m.root, 'dialog[open]')), '保存の確認')
  win.navigate('#/')
  assert.ok(await until(() => !!$(m.root, '.pane-list') && !$(m.root, 'dialog[open]')), '保存の確認が残る')
  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => !!$(m.root, '.dhead')))
  assert.equal($(m.root, '#in-pollIntervalSec').value, '45')
})

// 戻すと落ちるもの: detail-pane.js が設定タブを tab === 'settings' のときだけ描く
test('設定: タブを行き来しても 3 枚のカードの下書きを消さない。認証の欄の入力も残す', async () => {
  const server = settingsServer()
  const m = await start({ width: 1280, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  typeInto($(m.root, '#cfg-in-name'), '手で変えた名前')
  typeInto($(m.root, '#in-pollIntervalSec'), '45')
  click(buttonByText(m.root, S.config.credReenter))
  await settle()
  typeInto($(m.root, '#cfg-cred-id'), ID)
  await settle()

  win.navigate(tabHref('a1', 'status'))
  assert.ok(await until(() => !!$(m.root, '[data-sec="phase"]')))
  assert.equal($(m.root, '.settings-tab').hasAttribute('hidden'), true, 'ほかのタブの間は隠す')

  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => !$(m.root, '.settings-tab').hasAttribute('hidden')))
  assert.equal(!!$(m.root, '[data-sec="phase"]'), false, '状態タブは消える')
  assert.equal($(m.root, '#cfg-in-name').value, '手で変えた名前')
  assert.equal($(m.root, '#in-pollIntervalSec').value, '45')
  assert.equal($(m.root, '#cfg-cred-id').value, ID)
  assert.ok(textOf($(m.root, 'section[data-card="measure"] .save-bar')).includes(S.settings.dirty))
})

test('設定: 一度も開いていない台では描かない（ポートの候補も読まない）。別の台へ移ると下書きを持ち越さない', async () => {
  const server = settingsServer()
  const m = await start({ width: 1280, hash: tabHref('a1', 'status'), server })
  assert.ok(await until(() => !!$(m.root, '[data-sec="phase"]')))
  await settle(2)
  assert.equal(!!$(m.root, '.settings-tab'), false)
  assert.equal(countOf(server, /\/serialports$/), 0)

  // 両方の台の詳細を読んでおく（読み込み中の表示を挟むと、下書きがたまたま消えて試験にならない）
  win.navigate(tabHref('a2', 'settings'))
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a2'))
  await openSettings(m)
  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a1'))
  await openSettings(m)
  typeInto($(m.root, '#in-pollIntervalSec'), '45')
  await settle()
  win.navigate(tabHref('a2', 'settings'))
  assert.ok(await until(() => textOf($(m.root, '.dhead-name')) === 'アダプタ a2'))
  await settle(2)
  assert.equal($(m.root, '#in-pollIntervalSec').value, '30')
})

// 隠した中の <dialog> はモーダルのまま残り、見えないのに画面全体の操作を止める。
// 戻すと落ちるもの: useCloseDialogWhenHidden を外す
test('設定: 確認を開いたままブラウザの「戻る」でタブが替わっても、見えないモーダルを残さない', async () => {
  const server = settingsServer()
  const m = await start({ width: 1280, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  typeInto($(m.root, '#in-pollIntervalSec'), '45')
  await settle()
  fire($(m.root, 'form.measure-form'), 'submit')
  assert.ok(await until(() => !!$(m.root, 'dialog[open]')))
  win.navigate(tabHref('a1', 'status'))
  assert.ok(await until(() => !$(m.root, 'dialog[open]')), '閉じる')
  assert.equal($(m.root, '#in-pollIntervalSec').value, '45', '下書きは残す')
})

// 戻すと落ちるもの: config-section.js の読み込みの条件を status === 'idle' に戻す（ページの中で 1 回だけになる）
test('ポートの候補: 設定タブを開くたび、追加のモーダルを開くたびに読み直す', async () => {
  const server = settingsServer({ metaOver: { editorRoot: '/' } })
  const m = await start({ width: 1280, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  assert.ok(await until(() => countOf(server, /\/serialports$/) === 1))
  win.navigate(tabHref('a1', 'status'))
  await settle(2)
  assert.equal(countOf(server, /\/serialports$/), 1, 'ほかのタブでは読まない')
  win.navigate(tabHref('a1', 'settings'))
  assert.ok(await until(() => countOf(server, /\/serialports$/) === 2), '戻ったら読み直す')

  for (const n of [3, 4]) {
    click($(m.root, '[data-add="add"]'))
    assert.ok(await until(() => !!$(m.root, '#add-in-role')))
    assert.ok(await until(() => countOf(server, /\/serialports$/) === n), '開くたびに読む: ' + countOf(server, /\/serialports$/))
    click(buttonByText(m.root, S.add.cancel))
    assert.ok(await until(() => !$(m.root, '#add-in-role')))
  }
})

// ---- はじめに -------------------------------------------------------------------------------------

const newAdapter = (extra = {}) =>
  summary('n1', Object.assign({ name: 'n1', named: false, port: '', portLabel: 'ポート未設定', running: false, connected: false, portOpen: false, phase: 'idle', phaseText: '停止中', health: H('idle', { nextAction: '次の一手の文' }), credentials: { configured: false, source: null, pairId: null } }, extra))

test('はじめに: 設定が足りない間は出し、見出しの「次に」は出さない。足りていれば出さない', async () => {
  const cases = [
    ['ポートが空', {}, true],
    ['認証情報が無い', { port: '/dev/ttyUSB0', portLabel: 'USB0' }, true],
    ['シミュレーターはポートが空でよい', { mode: 'simulator', port: '', credentials: { configured: true, source: '設定ノード', pairId: null } }, false],
    ['実機で 2 つとも足りている', { port: '/dev/ttyUSB0', portLabel: 'USB0', credentials: { configured: true, source: '設定ノード', pairId: null } }, false],
  ]
  for (const [label, extra, want] of cases) {
    const server = fakeServer({ items: [newAdapter(extra)] })
    const m = await start({ width: 1280, hash: tabHref('n1', 'status'), server })
    assert.ok(await until(() => !!$(m.root, '[data-sec="phase"]')), label)
    await settle(1)
    assert.equal(!!$(m.root, '[data-sec="onboarding"]'), want, label)
    assert.equal(!!$(m.root, '.why-next'), !want, label + ': 「次に」')
    await m.unmount()
  }
})

// 戻すと落ちるもの: DetailPane の focusReq を渡さない・ConnectionCard の focusReq の effect を外す
test('はじめに: ボタンは設定タブへ移ってその欄にフォーカスする。つながると消えてトーストを出す', async () => {
  const server = fakeServer({ items: [newAdapter()], liveStreams: true, configOf: () => configFor('n1', { serialport: { value: '' } }), settingsOf: () => settingsFor(), ports: PORTS })
  const m = await start({ width: 1280, hash: tabHref('n1', 'status'), server })
  assert.ok(await until(() => !!$(m.root, '[data-sec="onboarding"]')))
  assert.ok(await until(() => !!buttonByText(m.root, S.onboarding.pickPort)))
  click(buttonByText(m.root, S.onboarding.pickPort))
  assert.ok(await until(() => active() === 'cfg-in-serialport-pick'), String(active()))
  assert.equal(win.location.hash, tabHref('n1', 'settings'))

  win.navigate(tabHref('n1', 'status'))
  assert.ok(await until(() => !!buttonByText(m.root, S.onboarding.enterCred)))
  await settle(3) // タブを移ったあとの片付け（focusReq を忘れる）が終わってから押す
  click(buttonByText(m.root, S.onboarding.enterCred))
  assert.ok(await until(() => active() === 'cfg-cred-id'), String(active()))

  win.navigate(tabHref('n1', 'status'))
  const on = summary('n1', { name: 'n1', named: false })
  server.setItems([on])
  server.pushAll('adapter', detail(on))
  assert.ok(await until(() => !$(m.root, '[data-sec="onboarding"]')), '消える')
  assert.ok(await until(() => textOf(m.root).includes(S.onboarding.connected)), 'トースト')
})

test('つながらないときの案内: 帯の［認証 ID とパスワードを入れ直す］で閉じた欄を開いてフォーカスする', async () => {
  const a = summary('a1', { connected: false, phase: 'joining', phaseText: '認証中', connectHint: { kind: 'no-meter', since: Date.now() - 5 * MIN, rounds: 3 } })
  const server = fakeServer({ items: [a], configOf: (id) => configFor(id), settingsOf: () => settingsFor(), ports: PORTS })
  const m = await start({ width: 1280, hash: tabHref('a1', 'status'), server })
  assert.ok(await until(() => textOf(m.root).includes(S.status.hintNoMeter)), textOf($(m.root, '.pane-detail')).slice(0, 200))
  click(buttonByText(m.root, S.status.reenterCredentials))
  assert.ok(await until(() => active() === 'cfg-cred-id'), String(active()))
})

// ---- 基本設定と詳細設定 ---------------------------------------------------------------------------

// 戻すと落ちるもの: config-section.js・tab-settings.js が tier を見ずに 2 つ目の表で出し分ける
test('基本で見える項目は、API の tier が basic のものと同じ。詳細設定は既定で閉じている', async () => {
  const server = settingsServer()
  const m = await start({ width: 1280, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  const inMore = (el) => {
    for (let n = el; n; n = n.parentNode) if (n.localName === 'details') return true
    return false
  }
  const rowsOf = (section) => $$($(m.root, section), '.set-row').filter((r) => !inMore(r)).map((r) => r.getAttribute('data-field')).sort()
  const cfg = configFor('a1')
  const set = settingsFor()
  const basicOf = (o) => Object.keys(o.fields).filter((k) => o.fields[k].tier === 'basic').sort()
  assert.ok(basicOf(cfg).length >= 3)
  assert.deepEqual(rowsOf('section[data-card="connection"]'), basicOf(cfg))
  assert.deepEqual(rowsOf('section[data-card="measure"]'), basicOf(set))
  assert.equal($$(m.root, 'details.more').length, 3)
  for (const d of $$(m.root, 'details.more')) assert.equal(d.hasAttribute('open'), false, d.getAttribute('data-card'))
})

// 戻すと落ちるもの: sourceChip が config の値にもチップを付ける
test('チップは画面かフローで変えた項目と一時的な上書きにだけ付く', async () => {
  const server = settingsServer({
    configOf: (id) => configFor(id, { name: { value: '画面の名前', source: 'runtime', runtimeValue: '画面の名前', by: 'web-ui', at: 1000 } }),
    settingsOf: () => settingsFor({ pollIntervalSec: { value: 60, source: 'override' } }),
  })
  const m = await start({ width: 1280, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  assert.ok(await until(() => !!$(m.root, '.set-row[data-field="name"] .src-chip')))
  assert.ok($(m.root, '.set-row[data-field="pollIntervalSec"] .src-chip'))
  for (const f of ['role', 'mode', 'serialport', 'pollEpcs']) assert.equal(!!$(m.root, `.set-row[data-field="${f}"] .src-chip`), false, f)
})

test('ポートの select: 機器ごとに 1 つ。使用中は選べない。触らずに保存しても差分が出ない', async () => {
  const writes = []
  const server = settingsServer({ onConfigWrite: (method, kind, id, body) => (writes.push(body), { status: 200, body: configFor(id) }) })
  const m = await start({ width: 1280, hash: tabHref('a1', 'settings'), server })
  await openSettings(m)
  assert.ok(await until(() => $$(m.root, '#cfg-in-serialport-pick option').length === 2), textOf($(m.root, '#cfg-in-serialport-pick')))
  const opts = $$(m.root, '#cfg-in-serialport-pick option')
  assert.equal(opts[0].hasAttribute('disabled'), false, '今の値の実体は by-id の候補と同じ')
  assert.equal(opts[1].hasAttribute('disabled'), true, 'ほかの台が使っている')
  assert.ok(textOf(opts[1]).includes(S.config.portUsedByAdapter('アダプタ a2')), textOf(opts[1]))
  assert.equal($(m.root, '#cfg-in-serialport-pick').value, PORTS.items[0].path, '今の値の候補を選んだ状態')
  assert.ok(textOf($(m.root, 'section[data-card="connection"] .save-bar')).includes(S.config.noChanges), '差分が出ない')
  assert.equal($(m.root, 'form.config-form button[type="submit"]').hasAttribute('disabled'), true)
  assert.deepEqual(writes, [])
})

// ---- 一覧と見出し ---------------------------------------------------------------------------------

test('契約のバッジ: 行と見出しに色分けのバッジ。契約の文字は行の中に 1 回だけ', async () => {
  const server = fakeServer({ items: [summary('a1', { role: '電力', name: '1 階' }), summary('a2', { role: '動力', name: '2 階' }), summary('a3', { role: '低圧電力', name: '3 階' })] })
  const m = await start({ width: 1280, hash: tabHref('a2', 'status'), server })
  assert.ok(await until(() => $$(m.root, 'a.row').length === 3))
  const row = (id) => $(m.root, `a.row[data-id="${id}"]`)
  assert.ok($(row('a1'), '.role-badge.role-light'))
  assert.ok($(row('a2'), '.role-badge.role-motive'))
  assert.ok($(row('a3'), '.role-badge.role-other'))
  assert.equal(textOf(row('a2')).split('動力').length - 1, 1, textOf(row('a2')))
  assert.ok($(m.root, '.dhead .role-badge.role-motive.role-badge-lg'))
})

// ---- 追加のモーダル -------------------------------------------------------------------------------

// 戻すと落ちるもの: AddDialog の showModal のあとの focusById を外す → 閉じるボタンに当たる
test('追加のモーダル: 最初のフォーカスは契約の欄。経路と一覧の選択は変えない', async () => {
  const server = settingsServer()
  const m = await start({ width: 1280, hash: tabHref('a2', 'settings'), server })
  assert.ok(await until(() => !!$(m.root, '[data-add="add"]') && !$(m.root, '[data-add="add"]').hasAttribute('disabled')))
  click($(m.root, '[data-add="add"]'))
  assert.ok(await until(() => !!$(m.root, '#add-in-role')))
  assert.ok(await until(() => active() === 'add-in-role'), String(active()))
  assert.equal(win.location.hash, tabHref('a2', 'settings'))
  assert.equal($(m.root, 'a.row[aria-current="page"]').getAttribute('data-id'), 'a2')
  assert.ok($(m.root, 'dialog.dialog-add[open]'))
})

// ---- テーマ ---------------------------------------------------------------------------------------

// 戻すと落ちるもの: applyTheme が theme-color を書き換えない → OS と逆のテーマで帯とアドレスバーの色がずれる
test('テーマ: 明示のテーマでは theme-color の 2 本を帯の色にし、system で元の値へ戻す', async () => {
  const meta = (media, content) => {
    const el = document.createElement('meta')
    el.setAttribute('name', 'theme-color')
    el.setAttribute('media', media)
    el.setAttribute('content', content)
    document.documentElement.appendChild(el)
    return el
  }
  const light = meta('(prefers-color-scheme: light)', '#ffffff')
  const dark = meta('(prefers-color-scheme: dark)', '#0e1424')
  const header = { light: '#ffffff', dark: '#0e1424' }
  globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => (k === '--header-bg' ? ' ' + header[document.documentElement.getAttribute('data-theme')] : '') })
  try {
    const server = fakeServer({ items: [summary('a1')] })
    const m = await start({ width: 1280, hash: tabHref('a1', 'status'), server })
    const button = () => $(m.root, '.topbar .btn-icon')
    const colors = () => [light.getAttribute('content'), dark.getAttribute('content')]
    assert.deepEqual(colors(), ['#ffffff', '#0e1424'], 'system は OS の設定に任せる')
    click(button())
    assert.ok(await until(() => document.documentElement.getAttribute('data-theme') === 'light'))
    await settle(1)
    assert.deepEqual(colors(), ['#ffffff', '#ffffff'], 'ライト')
    click(button())
    assert.ok(await until(() => document.documentElement.getAttribute('data-theme') === 'dark'))
    await settle(1)
    assert.deepEqual(colors(), ['#0e1424', '#0e1424'], 'ダーク')
    click(button())
    assert.ok(await until(() => !document.documentElement.hasAttribute('data-theme')))
    await settle(1)
    assert.deepEqual(colors(), ['#ffffff', '#0e1424'], 'system に戻す')
  } finally {
    delete globalThis.getComputedStyle
    light.remove()
    dark.remove()
    document.documentElement.removeAttribute('data-theme')
  }
})
