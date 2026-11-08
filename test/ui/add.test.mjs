// アダプタの追加（モーダル）・契約のバッジ・
// 名前の無い台の表示・推移の途切れ・LQI のグラフ。偽の DOM と純関数で確かめる（レイアウトは実ブラウザ）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mount, click, typeInto, fire, settle, $, $$, textOf, buttonByText } from './fake-dom.mjs'

installDom()
const { html } = await import('../../ui/html.js')
const { S } = await import('../../ui/strings.js')
const { AddDialog } = await import('../../ui/components/add-pane.js')
const { RoleBadge } = await import('../../ui/components/common.js')
const { ValuesTab, trendSummary } = await import('../../ui/components/tab-values.js')
const { ROLE_OTHER } = await import('../../ui/config-model.js')
const { rowFacts } = await import('../../ui/components/list-pane.js')
const { roleKind, nameSlot, displayText } = await import('../../ui/adapter-view.js')
const { addButtonState, addedName } = await import('../../ui/add-view.js')
const { gapStats, gapThreshold } = await import('../../ui/chart-util.js')
const { reducer, initialState } = await import('../../ui/store.js')

const ID = '0123456789ABCDEF0123456789ABCDEF'
const PW = 'ABCDEF123456'
const META = { addAdapter: { available: true, reason: null, count: 1, limit: 8, tabLabel: 'B ルート（Web UI で追加）', envOverrides: false } }
const PORTS = { items: [{ path: '/dev/ttyUSB3', manufacturer: 'FTDI', byId: false, realPath: '/dev/ttyUSB3', kind: 'wsuha', usedBy: null, aliases: [] }], status: 'ok', at: 1 }

function dialogProps(extra = {}) {
  const calls = { add: [], close: 0, ports: 0 }
  const p = Object.assign(
    {
      open: true,
      meta: META,
      add: { variant: 'add', reason: null, limit: 8 },
      serialports: PORTS,
      editorRoot: 'http://h/',
      onLoadSerialports: () => calls.ports++,
      onAdd: async (body) => (calls.add.push(body), { ok: true }),
      onClose: () => calls.close++,
    },
    extra,
  )
  return { p, calls }
}

const pickRole = async (root, v) => {
  const sel = $(root, '#add-in-role')
  sel.value = v
  fire(sel, 'change')
  await settle()
}

// 戻すと落ちるもの: 閉じているときも中身を描く（入力が次に開いたときまで残る）
test('追加のモーダル: 開いているときだけ中身を描く。閉じれば入力は残らない', async () => {
  const { p } = dialogProps({ open: false })
  const m = await mount(html`<${AddDialog} ...${p} />`)
  assert.equal($$(m.root, 'dialog.dialog-add').length, 1)
  assert.equal($(m.root, '#add-title'), null)
  await m.rerender(html`<${AddDialog} ...${Object.assign({}, p, { open: true })} />`)
  assert.equal(textOf($(m.root, '#add-title')), S.add.title)
  typeInto($(m.root, '#add-in-name'), '1 階の分電盤')
  await settle()
  await m.rerender(html`<${AddDialog} ...${Object.assign({}, p, { open: false })} />`)
  await m.rerender(html`<${AddDialog} ...${Object.assign({}, p, { open: true })} />`)
  assert.equal($(m.root, '#add-in-name').value, '')
  await m.unmount()
})

test('追加のモーダル: 契約は select（選んでください・電力・動力・その他）で必須。実機はポートが必須。送らずに項目の下に出す', async () => {
  const { p, calls } = dialogProps()
  const m = await mount(html`<${AddDialog} ...${p} />`)
  assert.deepEqual($$(m.root, '#add-in-role option').map(textOf), [S.roles.pick, '電力', '動力', S.roles.other])
  assert.equal($$(m.root, 'datalist').length, 0, 'datalist は使わない（Chrome は今の値に合う候補しか出さない）')
  fire($(m.root, 'form.add-form'), 'submit')
  await settle()
  assert.deepEqual(calls.add, [])
  assert.ok($(m.root, '.set-row[data-field="role"] .field-error'))
  await pickRole(m.root, '動力')
  fire($(m.root, 'form.add-form'), 'submit')
  await settle()
  assert.deepEqual(calls.add, [])
  assert.ok($(m.root, '.set-row[data-field="serialport"] .field-error'))
  await m.unmount()
})

// 戻すと落ちるもの: 認証の欄の値を state に持つ・本文に載せない
test('追加のモーダル: シミュレーターは架空の値を入れて送れる。［やめる］で閉じ、認証の欄を空にする', async () => {
  const { p, calls } = dialogProps()
  const m = await mount(html`<${AddDialog} ...${p} />`)
  await pickRole(m.root, '動力')
  fire($(m.root, '#add-in-mode-simulator'), 'change')
  await settle()
  assert.equal($(m.root, '#add-cred-id').value, ID)
  assert.ok(textOf(m.root).includes(S.add.simCred))
  fire($(m.root, 'form.add-form'), 'submit')
  await settle(3)
  assert.equal(calls.add.length, 1)
  assert.equal(calls.add[0].role, '動力')
  assert.equal(calls.add[0].mode, 'simulator')
  assert.equal(calls.add[0].routeBId, ID)
  assert.equal(calls.add[0].routeBPassword, PW)
  await m.unmount()

  const c = dialogProps()
  const m2 = await mount(html`<${AddDialog} ...${c.p} />`)
  typeInto($(m2.root, '#add-cred-id'), ID)
  await settle()
  click(buttonByText(m2.root, S.add.cancel))
  await settle()
  assert.equal(c.calls.close, 1)
  assert.equal($(m2.root, '#add-cred-id').value, '')
  await m2.unmount()
})

test('追加のモーダル: 409 は項目の下と帯にサーバーの文。閉じない。送っている間は閉じるボタンも止める', async () => {
  let release
  const { p, calls } = dialogProps({
    onAdd: () =>
      new Promise((r) => {
        release = () => r({ ok: false, error: { status: 409, code: 'PORT_IN_USE', message: 'ポートは「電力（USB0）」が使っています' } })
      }),
  })
  const m = await mount(html`<${AddDialog} ...${p} />`)
  await pickRole(m.root, '電力')
  const port = $(m.root, '#add-in-serialport-pick')
  port.value = '/dev/ttyUSB3'
  fire(port, 'change')
  await settle()
  fire($(m.root, 'form.add-form'), 'submit')
  await settle()
  assert.equal($(m.root, '.add-head .btn-icon').hasAttribute('disabled'), true, '送っている間は閉じない')
  release()
  await settle(3)
  assert.ok(textOf($(m.root, '.set-row[data-field="serialport"]')).includes('電力（USB0）'))
  assert.ok(textOf(m.root).includes(S.add.errors.PORT_IN_USE))
  assert.equal(calls.close, 0)
  await m.unmount()
})

test('追加のモーダル: 使えない環境はエディタでの手順と［エディタを開く］', async () => {
  const { p } = dialogProps({ meta: { addAdapter: { available: false, reason: '確かめていない版です' } }, add: { variant: 'editor', reason: null, limit: null } })
  const m = await mount(html`<${AddDialog} ...${p} />`)
  assert.equal(textOf($(m.root, '#add-title')), S.add.editorTitle)
  assert.ok(textOf(m.root).includes('確かめていない版です'))
  assert.equal($$(m.root, '.add-steps li').length, 3)
  assert.equal($(m.root, 'a[target="_blank"]').getAttribute('href'), 'http://h/')
  await m.unmount()
})

test('追加のボタン: 使えない環境は［エディタで追加…］、読み出しのみ・止めている・上限は押せない理由', () => {
  const st = (meta, extra) => Object.assign({ meta, list: { items: [{ id: 'a' }] } }, extra)
  assert.equal(addButtonState(st(null)).variant, 'add')
  assert.equal(addButtonState(st({})).variant, 'editor', '古いサーバー')
  assert.equal(addButtonState(st({ addAdapter: { available: false } })).variant, 'editor')
  assert.equal(addButtonState(st({ addAdapter: { available: true, limit: 8, count: 1 } })).reason, null)
  assert.equal(addButtonState(st({ addAdapter: { available: true, limit: 8, count: 8 } })).reason, S.list.addLimit(8))
  assert.equal(addButtonState(st({ addAdapter: { available: true, locked: true, limit: 8, count: 1 } })).reason, S.list.addLocked)
  assert.equal(addedName(null, { role: '動力', mode: 'serial', serialport: '/dev/ttyUSB1' }), S.detail.displayName('動力', 'USB1'))
})

// 戻すと落ちるもの: add-view.js が writeBlockReason の理由を見ず、いつも「読み出しのみ」と出す（ログインすれば解けるのに、設定の問題に見える）
test('追加のボタン: Node-RED の認証で止めているときは、読み出しのみと言わず、その理由を出す', () => {
  const meta = { readOnly: false, addAdapter: { available: true, limit: 8, count: 1 } }
  const st = (auth, extra) => Object.assign({ meta, list: { items: [{ id: 'a' }] }, auth }, extra)
  assert.equal(addButtonState(st({ required: true, available: true, loggedIn: false, canWrite: false })).reason, S.auth.loginRequired)
  assert.equal(addButtonState(st({ required: true, available: false, loggedIn: false, canWrite: false })).reason, S.auth.noLogin)
  assert.equal(addButtonState(st({ required: true, available: true, loggedIn: true, canWrite: false })).reason, S.auth.forbidden)
  assert.equal(addButtonState(st({ required: true, available: true, loggedIn: true, canWrite: true })).reason, null)
  const ro = st({ required: true, available: true, loggedIn: false, canWrite: false }, { meta: Object.assign({}, meta, { readOnly: true }) })
  assert.equal(addButtonState(ro).reason, S.list.addReadOnly, '読み出しのみはログインしても解けない')
})

// ---- 契約のバッジ・名前の無い台 --------------------------------------------------

test('契約のバッジ: 電力・動力は完全に一致したときだけ色分け。空なら出さない', async () => {
  assert.equal(roleKind('電力'), 'light')
  assert.equal(roleKind(' 動力 '), 'motive')
  assert.equal(roleKind('電灯'), 'other')
  assert.equal(roleKind(''), null)
  assert.equal(roleKind(null), null)
  const m = await mount(html`<div><${RoleBadge} role="電力" /><${RoleBadge} role="動力" lg=${true} /><${RoleBadge} role="長い名前の契約ですよ本当に" /><${RoleBadge} role="" /></div>`)
  const b = $$(m.root, '.role-badge')
  assert.equal(b.length, 3)
  assert.deepEqual(b.map((e) => e.getAttribute('data-role')), ['light', 'motive', 'other'])
  assert.ok(b[1].getAttribute('class').includes('role-badge-lg'))
  assert.ok(textOf(b[2]).endsWith('…'), textOf(b[2]))
  assert.equal(b[2].getAttribute('title'), '長い名前の契約ですよ本当に')
  await m.unmount()
})

test('名前の無い台: 名前の欄はポートの短い名前、文の中は「電力（USB0）」。名前を入れた台はその名前', () => {
  const a = { id: 'x', name: '電力 (/dev/serial/by-id/usb-FTDI-if00-port0)', named: false, role: '電力', portLabel: 'USB0' }
  assert.deepEqual(nameSlot(a), { text: 'USB0', isName: false })
  assert.equal(displayText(a), S.detail.displayName('電力', 'USB0'))
  const n = { id: 'x', name: '1 階', named: true, role: '電力', portLabel: 'USB0' }
  assert.deepEqual(nameSlot(n), { text: '1 階', isName: true })
  assert.equal(displayText(n), '1 階')
})

// ---- 左ペインの情報 --------------------------------------------------------------------

// 2 列の 1 枠に入らない文を省略すると、段の文の末尾やポートの見分けがつかない。
// 戻すと落ちるもの: rowFacts の wide を外す（列の幅は実ブラウザで測る。test/ui/browser.test.mjs）
test('左ペインの行: 1 枠に入らない値だけ 2 列分を使う', () => {
  const base = { connected: true, enabled: true, health: { level: 'ok' }, current: { r: 3, t: 8 }, lqi: 98, portLabel: 'USB1', txBudgetMs: 1000 }
  const slot = { text: '1 階', isName: true }
  const wide = (a) => rowFacts(a, slot).filter((f) => f.wide).map((f) => f.key)
  assert.deepEqual(wide(base), ['current', 'tx'])
  assert.deepEqual(wide(Object.assign({}, base, { current: { r: null, t: null } })), ['tx'], '値の無い電流は 1 枠で足りる')
  const long = Object.assign({}, base, { connected: false, phaseText: 'メーターを探しています', health: { level: 'busy' } })
  assert.deepEqual(wide(long), ['state', 'current', 'tx'])
  assert.deepEqual(wide(Object.assign({}, base, { portLabel: '/dev/serial/a' })), ['current', 'port', 'tx'])
})

// 戻すと落ちるもの: list-pane.js の rowFacts を外す・無効の台にも空の項目を並べる
test('左ペインの行: 状態・瞬時電流・電波の強さ・ポート。送信積算は読めているときだけ。無効の台は状態とポートだけ', () => {
  const a = { connected: true, enabled: true, health: { level: 'ok' }, current: { r: 3, t: 8 }, lqi: 98, portLabel: 'USB1', txBudgetMs: null }
  const slot = { text: '1 階', isName: true }
  const keys = (x, s) => rowFacts(x, s).map((f) => f.key)
  assert.deepEqual(keys(a, slot), ['state', 'current', 'signal', 'port'])
  assert.deepEqual(rowFacts(a, slot).map((f) => f.label), [S.list.factState, '瞬時電流', '電波の強さ', S.list.factPort])
  const by = (x, k) => rowFacts(x, slot).find((f) => f.key === k)
  assert.equal(by(a, 'current').text, 'R 3.0 A / T 8.0 A')
  assert.equal(by(a, 'signal').text, 'ふつう', '左ペインは言葉だけ。LQI の数は詳細で見る')
  assert.deepEqual(keys(a, { text: 'USB1', isName: false }), ['state', 'current', 'signal'], '名前の欄がポートなら重ねない')
  assert.equal(by(Object.assign({}, a, { txBudgetMs: 12400 }), 'tx').text, '12 秒 / 360 秒')
  assert.deepEqual(keys(Object.assign({}, a, { enabled: false }), slot), ['state', 'port'])
  assert.equal(by(Object.assign({}, a, { lqi: 40 }), 'signal').tone, 'warn', '弱い電波は注意の色')
  assert.equal(by(Object.assign({}, a, { connected: false, phaseText: 'スキャン中', health: { level: 'busy' } }), 'state').text, 'スキャン中')
  assert.equal(by(Object.assign({}, a, { current: {} }), 'current').text, S.none)
})

// ---- 推移の途切れ・LQI ----------------------------------------------------------

test('途切れ: 間隔の 4 倍（最低 2 分）を超えたら途切れ。回数・最長・値が取れていた割合', () => {
  const t0 = 1_000_000_000
  const pts = []
  for (let i = 0; i <= 20; i++) pts.push([t0 + i * 30000, 100])
  for (let i = 0; i <= 20; i++) pts.push([t0 + 20 * 30000 + 300000 + i * 30000, 100])
  const th = gapThreshold(pts)
  assert.equal(th, 120000)
  const st = gapStats(pts, th, t0, pts[pts.length - 1][0])
  assert.equal(st.count, 1)
  assert.equal(st.longestMs, 300000)
  assert.equal(st.coverage, 0.8)
  assert.equal(gapStats(pts.slice(0, 20), th, t0, pts[19][0]).count, 0)
})

const valuesProps = (lqi) => {
  const now = Date.now()
  const power = [[now - 60000, 100], [now - 30000, 110]]
  return {
    a: { id: 'n1', pollEpcs: ['0xE7'], supportedEpcs: null },
    trend: { status: 'ok', range: '1h', from: now - 3600000, to: now, series: { power, currentR: [], currentT: [], lqi } },
    values: { status: 'ok', items: [] },
    onRange: () => {},
    onReloadValues: () => {},
  }
}

// 戻すと落ちるもの: tab-values.js の LQI の TrendChart を外す
test('LQI のグラフ: series.lqi があれば「電波の強さ（LQI）」を出す。無ければ（前の版のサーバー・SA2 が通らない）出さない', async () => {
  const now = Date.now()
  const m = await mount(html`<${ValuesTab} ...${valuesProps([[now - 60000, 54], [now - 30000, 60]])} />`)
  assert.ok(textOf(m.root).includes(S.values.seriesLqi), textOf(m.root).slice(0, 200))
  await m.unmount()
  const m2 = await mount(html`<${ValuesTab} ...${valuesProps([])} />`)
  assert.equal(textOf(m2.root).includes(S.values.seriesLqi), false)
  await m2.unmount()
  assert.equal(S.values.lqiTip(54), 'LQI 54（約 −89 dBm）')
})

// 実ブラウザで見つけた: API は series.lqi を返すのに、store が power・currentR・currentT だけを写して捨てていた。
// 戻すと落ちるもの: store.js の trend/loaded で lqi を写さない
test('推移を読み込むと series.lqi も持つ', () => {
  const s = reducer(initialState, { type: 'trend/loaded', id: 'a1', range: '1h', series: { power: [], lqi: [[1, 54]] }, from: 0, to: 1 })
  assert.deepEqual(s.trends.a1.series.lqi, [[1, 54]])
})

test('SSE の詳細で LQI の点を推移に足す（meter.lqiAt が新しいときだけ）', () => {
  const t = 2_000_000_000
  const s0 = Object.assign({}, initialState, {
    trends: { a1: { status: 'ok', range: '1h', from: t - 3600000, to: t, series: { power: [], currentR: [], currentT: [], lqi: [[t - 60000, 50]] } } },
    details: {},
    list: { items: null },
  })
  const s1 = reducer(s0, { type: 'detail/loaded', adapter: { id: 'a1', meter: { lqi: 70, lqiAt: t } } })
  assert.deepEqual(s1.trends.a1.series.lqi[s1.trends.a1.series.lqi.length - 1], [t, 70])
  const s2 = reducer(s1, { type: 'detail/loaded', adapter: { id: 'a1', meter: { lqi: 99, lqiAt: t - 1 } } })
  assert.equal(s2.trends.a1.series.lqi.some((p) => p[1] === 99), false, '古い時刻の点は足さない')
})

// ---- 孤立した点（途切れの間に 1 点だけ取れた所） ------------------------------------------------------

// 1 点の線は 'M x y' だけになり、SVG に何も描かれない。「まだ値がありません」も出ないので空のグラフに見えた。
// 戻すと落ちるもの: charts.js の dots を描かない
test('推移のグラフ: 途切れの間に孤立した 1 点は点で描く。点が 1 つだけのときも空に見せない', async () => {
  const now = Date.now()
  const props = (power) => Object.assign(valuesProps([]), { trend: { status: 'ok', range: '1h', from: now - 3600000, to: now, series: { power, currentR: [], currentT: [], lqi: [] } } })
  const run = (from, n) => Array.from({ length: n }, (_, i) => [from + i * 30000, 100 + i])
  const m = await mount(html`<${ValuesTab} ...${props([...run(now - 3000000, 10), [now - 1800000, 120], ...run(now - 600000, 10)])} />`)
  assert.equal($$(m.root, '.chart-series.series-power .chart-dot').length, 1, '真ん中の 1 点')
  assert.equal($$(m.root, '.chart-series.series-power .chart-line').length, 2, '前後の線')
  await m.unmount()
  const m2 = await mount(html`<${ValuesTab} ...${props([[now - 60000, 100]])} />`)
  assert.equal($$(m2.root, '.chart-series.series-power .chart-dot').length, 1)
  assert.equal($$(m2.root, '.chart-series.series-power .chart-line').length, 0, '線にならない 1 点を線として数えない')
  assert.equal(textOf($(m2.root, 'figure.chart')).includes(S.values.trendEmpty), false, '電力のグラフ')
  await m2.unmount()
})

// 既定の定期取得は E7 だけなので、足した台は接続しても電流が届かない。「接続して値が届くと」のままだと待ち続ける。
// 戻すと落ちるもの: tab-values.js が emptyText を渡さない・currentNotPolled が connected を見ない
test('接続している台の定期の値に E8 が無いとき: 電流のグラフは待っても来ない理由を出す。電力のグラフはそのまま', async () => {
  const now = Date.now()
  const a = (over) => Object.assign({ id: 'n1', connected: true, pollEpcs: ['0xE7'] }, over)
  const props = (ad) => Object.assign(valuesProps([]), { a: ad, trend: { status: 'ok', range: '1h', from: now - 3600000, to: now, series: { power: [], currentR: [], currentT: [], lqi: [] } } })
  const charts = async (ad) => {
    const m = await mount(html`<${ValuesTab} ...${props(ad)} />`)
    const out = $$(m.root, '.chart-empty').map((el) => textOf(el))
    await m.unmount()
    return out
  }
  assert.deepEqual(await charts(a()), [S.values.trendEmpty, S.values.currentNotPolled])
  assert.deepEqual(await charts(a({ pollEpcs: ['0xE7', '0xE8'] })), [S.values.trendEmpty, S.values.trendEmpty], 'E8 を取っているなら待てば来る')
  assert.deepEqual(await charts(a({ connected: false })), [S.values.trendEmpty, S.values.trendEmpty], '接続の前は今までの文')
  const m = await mount(html`<${ValuesTab} ...${props(a())} />`)
  assert.equal($$($$(m.root, '.chart-empty')[1], 'tspan').length, 2, '幅の狭い端末で切れないように文ごとに行を分ける')
  await m.unmount()
})

// ---- 途切れの計算（範囲の先頭の欠け） -----------------------------------------------------------

test('途切れ: 範囲の先頭の欠けは、起動が範囲より前なら途切れ、範囲の中か分からないなら記録が無いものとして数えない', () => {
  const from = 1_000_000_000
  const to = from + 3600000
  const pts = []
  for (let t = from + 2700000; t <= to; t += 30000) pts.push([t, 100])
  const th = gapThreshold(pts)
  const running = gapStats(pts, th, from, to, from - 1)
  assert.equal(running.count, 1)
  assert.deepEqual(running.gaps[0], { from, to: pts[0][0], ms: 2700000 })
  assert.equal(running.coverage, 0.25)
  assert.equal(running.noDataUntil, null)
  assert.equal(running.longestMs, 2700000)
  assert.equal(gapStats(pts, th, from, to, from).count, 1, 'ちょうど範囲の先頭に起動')

  const restarted = gapStats(pts, th, from, to, from + 2600000)
  assert.equal(restarted.count, 0)
  assert.equal(restarted.noDataUntil, pts[0][0])
  assert.equal(restarted.coverage, 1, '記録のある間だけを見る')

  const unknown = gapStats(pts, th, from, to)
  assert.equal(unknown.count, 0, 'startedAt の無いサーバーは今までどおり')
  assert.equal(unknown.noDataUntil, pts[0][0])

  const full = []
  for (let t = from; t <= to; t += 30000) full.push([t, 100])
  assert.equal(gapStats(full, th, from, to, from - 1).count, 0, '先頭に欠けが無ければ途切れにしない')
})

test('グラフの下の文: 途切れの有無と、範囲の先頭の記録の有無で 4 通り', () => {
  const from = 1_000_000_000
  const to = from + 3600000
  const pts = (start, hole) => {
    const out = []
    for (let t = start; t <= to; t += 30000) if (!hole || t < hole[0] || t > hole[1]) out.push([t, 100])
    return out
  }
  const hole = [from + 2000000, from + 2600000]
  assert.equal(trendSummary(pts(from), from, to, '1h', from - 1).coverage, S.values.noGaps(S.values.ranges['1h']))
  assert.ok(trendSummary(pts(from, hole), from, to, '1h', from - 1).coverage.startsWith('この 1 時間で値が取れていた時間: 83%'))
  const start = from + 600000
  const a = trendSummary(pts(start), from, to, '1h', start - 1)
  assert.equal(a.coverage, S.values.noGapsRecorded)
  assert.ok(a.before.includes('再起動'))
  const b = trendSummary(pts(start, hole), from, to, '1h', start - 1)
  assert.ok(b.coverage.startsWith('記録のある間で値が取れていた時間: 79%'), b.coverage)
  // 動いている Node-RED に追加した台: 起動の時刻が範囲より前でも、台が無かった時間は途切れではない
  const added = trendSummary(pts(start), from, to, '1h', from - 3 * 3600e3, start - 1)
  assert.equal(added.stats.count, 0, JSON.stringify(added.stats))
  assert.equal(added.stats.noDataUntil, start)
  assert.equal(added.coverage, S.values.noGapsRecorded)
  const d = new Date(start)
  assert.equal(added.before, S.values.noDataBefore(d.getHours(), d.getMinutes()), '再起動かどうかは起動の時刻だけで決める')
  // 範囲の前から動いている台は、先頭の欠けを途切れに数える
  assert.equal(trendSummary(pts(start), from, to, '1h', from - 3 * 3600e3, from - 3 * 3600e3).stats.count, 1)
  assert.equal(trendSummary(pts(start), from, to, '1h', from - 3 * 3600e3, null).stats.count, 1, 'recordingSince の無いサーバーは起動の時刻で見る')
  const old = trendSummary(pts(start), from, to, '1h')
  assert.equal(old.before.includes('再起動'), false, '起動の時刻が分からなければ「再起動」と言わない')
  // 起動が範囲の中でも、記録の始まりが起動から 5 分を超えていれば、再起動のせいとは書かない（起動のあとで追加した台）
  const from6 = to - 6 * 3600e3
  const late = trendSummary(pts(start), from6, to, '6h', start - 54 * 60e3, start - 1)
  assert.equal(late.before, S.values.noDataBefore(d.getHours(), d.getMinutes()), '追加した台の時刻を再起動の時刻と言わない')
  const soon = trendSummary(pts(start), from6, to, '6h', start - 5 * 60e3, start - 1)
  assert.equal(soon.before, S.values.noDataRestart(d.getHours(), d.getMinutes()), '起動の直後に始まった記録は再起動の文')
})

// ---- 追加のモーダルのフォーカス -----------------------------------------------------------------

const activeId = () => (document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('id') : null)

// 実ブラウザで確かめた: 開いた直後のフォーカスは閉じるボタンで、Enter 1 回で閉じてしまう。
// 戻すと落ちるもの: AddDialog の showModal のあとの focusById を外す
test('追加のモーダル: 開いた直後のフォーカスは最初の入力欄', async () => {
  const { p } = dialogProps({ open: false })
  const m = await mount(html`<${AddDialog} ...${p} />`)
  await m.rerender(html`<${AddDialog} ...${Object.assign({}, p, { open: true })} />`)
  await settle()
  assert.equal(activeId(), 'add-in-role')
  await m.unmount()
})

// 戻すと落ちるもの: ADD_FIELDS の順を画面の順と変える（認証の欄より詳細設定の欄が先に選ばれる）
test('追加のモーダル: 誤りは画面の上から見て最初の欄へ。「その他」は文字の欄へ。詳細設定だけの誤りは開いて欄へ', async () => {
  const { p } = dialogProps({ onAdd: async () => ({ ok: false, error: { status: 422, message: '入力を確かめてください', details: { routeBId: '認証 ID の形が違います（サーバーの文）', deviceKey: 'デバイスキーが長すぎます（サーバーの文）' } } }) })
  const m = await mount(html`<${AddDialog} ...${p} />`)
  await pickRole(m.root, '動力')
  fire($(m.root, '#add-in-mode-simulator'), 'change')
  await settle()
  fire($(m.root, 'form.add-form'), 'submit')
  await settle(3)
  assert.equal($(m.root, 'details.more[data-card="add"]').hasAttribute('open'), true, '詳細設定の誤りでも開く')
  assert.equal(activeId(), 'add-cred-id', '認証の欄は詳細設定より上にある')
  await m.unmount()

  const c = dialogProps()
  const m2 = await mount(html`<${AddDialog} ...${c.p} />`)
  await pickRole(m2.root, ROLE_OTHER)
  fire($(m2.root, 'form.add-form'), 'submit')
  await settle(2)
  assert.equal(activeId(), 'add-in-role-other')
  await m2.unmount()

  const d = dialogProps({ onAdd: async () => ({ ok: false, error: { status: 409, code: 'DEVICE_KEY_IN_USE', message: 'このデバイスキーはほかの台が使っています（サーバーの文）' } }) })
  const m3 = await mount(html`<${AddDialog} ...${d.p} />`)
  await pickRole(m3.root, '動力')
  fire($(m3.root, '#add-in-mode-simulator'), 'change')
  await settle()
  fire($(m3.root, 'form.add-form'), 'submit')
  await settle(3)
  assert.equal(activeId(), 'add-in-deviceKey')
  await m3.unmount()
})

// 戻すと落ちるもの: forceOpen に誤りの欄の一覧を入れる
test('追加のモーダル: 誤りが 1 つ減っても、入力中の欄からフォーカスが動かない', async () => {
  const { p } = dialogProps()
  const m = await mount(html`<${AddDialog} ...${p} />`)
  await pickRole(m.root, '動力')
  fire($(m.root, '#add-in-mode-simulator'), 'change')
  await settle()
  typeInto($(m.root, '#add-in-deviceKey'), '!!')
  typeInto($(m.root, '#add-in-expectedMac'), 'xx')
  await settle()
  fire($(m.root, 'form.add-form'), 'submit')
  await settle(3)
  assert.equal(activeId(), 'add-in-deviceKey')
  $(m.root, '#add-in-expectedMac').focus()
  typeInto($(m.root, '#add-in-expectedMac'), '')
  await settle(2)
  assert.equal(activeId(), 'add-in-expectedMac')
  await m.unmount()
})

// ---- 契約の色分けと名前の無い台 -----------------------------------------------------------------

test('roleKind: 「低圧電力」のような名前はほか。named の無い古いサーバーも名前の欄はポートの短い名前', () => {
  assert.equal(roleKind('低圧電力'), 'other')
  const a = { id: 'x', name: '電力', role: '電力', portLabel: 'USB0' }
  assert.deepEqual(nameSlot(a), { text: 'USB0', isName: false })
  assert.equal(displayText(a), S.detail.displayName('電力', 'USB0'))
})
