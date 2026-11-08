// ui/components/* を偽の DOM（test/ui/fake-dom.mjs）に描いて、表示と操作を確かめる。
// レイアウト（幅・横スクロール）はここでは測れない。それは実ブラウザで見る。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mount, click, typeInto, fire, settle, $, $$, textOf, buttonByText } from './fake-dom.mjs'

installDom()
const { html } = await import('../../ui/html.js')
const { S } = await import('../../ui/strings.js')
const { LiveChip, TopBar, Notices } = await import('../../ui/components/topbar.js')
const { ListPane } = await import('../../ui/components/list-pane.js')
const { DetailPane } = await import('../../ui/components/detail-pane.js')
const { SettingsTab } = await import('../../ui/components/tab-settings.js')
const { DiagTab } = await import('../../ui/components/tab-diag.js')
const { StatusTab } = await import('../../ui/components/tab-status.js')
const { valueState } = await import('../../ui/components/tab-values.js')

const H = (level, extra = {}) => Object.assign({ level, title: S.health[level], reasons: [], nextAction: null }, extra)
const adapter = (id, extra = {}) =>
  Object.assign(
    {
      id,
      name: 'アダプタ ' + id,
      role: '電力',
      enabled: true,
      running: true,
      connected: true,
      portOpen: true,
      health: H('ok'),
      power: { value: 500, at: 1000 },
      current: { r: 3, t: 2, total: 5, at: 1000 },
      overridden: { stopped: null, any: false },
      stale: false,
      lastValueAt: 1000,
      consecutiveFailures: 0,
      device: {},
      credentials: {},
    },
    extra,
  )
const count = (hay, needle) => hay.split(needle).length - 1
const cls = (el) => String((el && el.getAttribute('class')) || '').split(/\s+/)

// ---- 上の帯 ---------------------------------------------------------------------

// 状態は色・アイコン・文字の 3 つで示す。
// 戻すと落ちるもの: LiveChip のアイコンを外す（点だけに戻す）→ svg が無い。
test('帯のリアルタイムの状態は、色・アイコン・文字の 3 つで示す（ライブ・再接続中・5 秒ごとに更新）', async () => {
  const cases = [
    ['live', 'ok', 'live', S.live.live],
    ['reconnecting', 'warn', 'busy', S.live.reconnecting],
    ['polling', 'stale', 'offline', S.live.polling],
    ['connecting', 'warn', 'busy', S.live.connecting],
    ['stopped', 'neutral', 'offline', S.live.stopped],
  ]
  for (const [state, tone, icon, label] of cases) {
    const m = await mount(html`<${LiveChip} state=${state} />`)
    const chip = $(m.root, '.live-chip')
    assert.ok(cls(chip).includes('tone-' + tone), state + ': 色')
    const svg = $(chip, 'svg.icon')
    assert.equal(svg && svg.getAttribute('data-icon'), icon, state + ': 表 LIVE のアイコン')
    assert.equal(textOf($(chip, '.live-label')), label, state + ': 文字')
    await m.unmount()
  }
})

// 360px で「5 秒ごとに更新」のとき、テーマのボタンが 2 行目に落ちた。文を隠すと色・アイコン・文字の 3 つが欠けるので、短くする。
// 戻すと落ちるもの: topbar.js の short を外す・strings.js の live.short を消す
test('帯のリアルタイムの状態: 幅の狭い端末のための短い文は、長い 2 つの状態にだけ持つ', async () => {
  for (const [state, short] of [['reconnecting', S.live.short.reconnecting], ['polling', S.live.short.polling]]) {
    const m = await mount(html`<${LiveChip} state=${state} />`)
    assert.equal(textOf($(m.root, '.live-label-short')), short)
    assert.ok(cls($(m.root, '.live-label')).includes('live-label-long'))
    await m.unmount()
  }
  const m = await mount(html`<${LiveChip} state="live" />`)
  assert.equal(!!$(m.root, '.live-label-short'), false)
  assert.equal(cls($(m.root, '.live-label')).includes('live-label-long'), false, '短い文の無い状態は、幅が狭くても隠さない')
  await m.unmount()
})

// 帯は 1 行。ユーザー名・権限・ログアウトは無い。版の警告・読み出しのみはここに出す。
test('上の帯: 要約・版の警告・読み出しのみ（settings.js）。ユーザー名やログアウトは出さない', async () => {
  const items = [adapter('a'), adapter('b', { health: H('bad') }), adapter('c', { health: H('stopped') }), adapter('d', { health: H('stale') })]
  const meta = { apiVersion: 1, libVersion: '2.0.0-beta.1', diskVersion: '2.0.0-beta.2', startedAt: 1, nodeRed: '3.1.3', readOnly: true }
  const m = await mount(html`<${TopBar} meta=${meta} items=${items} live="live" theme="system" onTheme=${() => {}} />`)
  const bar = $(m.root, '.topbar')
  const t = textOf(bar)
  assert.deepEqual(
    $$(bar, '.count').map(textOf),
    [S.header.summaryOk, S.header.summaryAttention, S.header.summaryBad, S.header.summaryStopped].map((l) => l + '1'),
  )
  assert.equal($$(bar, '.count svg.icon').length, 4, '要約もアイコンつき')
  assert.ok(t.includes(S.header.restartNeeded), '版のずれ')
  assert.ok(t.includes(S.header.readOnly), '読み出しのみ')
  assert.equal($$(bar, 'button').length, 1, 'ボタンはテーマの切り替えだけ')
  await m.unmount()
  // 版が同じ・読み出しのみでない
  const m2 = await mount(html`<${TopBar} meta=${Object.assign({}, meta, { diskVersion: meta.libVersion, readOnly: false })} items=${items} live="live" theme="dark" onTheme=${() => {}} />`)
  assert.equal(textOf(m2.root).includes(S.header.restartNeeded), false)
  assert.equal(textOf(m2.root).includes(S.header.readOnly), false)
  await m2.unmount()
})

// リアルタイム更新が止まった（'stopped'）ときも「再試行」を出す（5 秒ごとの更新のときと同じ）。
// 戻すと落ちるもの: Notices を polling のときだけにする → stopped で帯もボタンも出ない。
test('帯の下の知らせ: 5 秒ごとに更新・停止のどちらでも「再試行」を出し、押すと繋ぎ直す', async () => {
  for (const [live, text] of [['polling', S.banner.polling], ['stopped', S.banner.stopped]]) {
    let n = 0
    const m = await mount(html`<${Notices} live=${live} stale=${false} onRetryLive=${() => n++} />`)
    assert.equal(typeof text, 'string', live + ': 文言')
    assert.ok(textOf(m.root).includes(text), live + ': ' + textOf(m.root))
    click(buttonByText(m.root, S.retry))
    assert.equal(n, 1, live + ': 再試行')
    await m.unmount()
  }
  for (const live of ['live', 'connecting', 'reconnecting']) {
    const m = await mount(html`<${Notices} live=${live} stale=${false} onRetryLive=${() => {}} />`)
    assert.equal(textOf(m.root), '', live + ' では出さない')
    await m.unmount()
  }
})

// ---- 左ペイン ---------------------------------------------------------------------

const listProps = (items, extra = {}) => Object.assign({ list: { items, status: 'ok' }, selectedId: null, tab: 'status', editorRoot: 'http://h/', onRetry: () => {} }, extra)

// 戻すと落ちるもの: 一覧の行が power.fresh を見ない（合計からは外れているのに、どの行が古いか分からない）
test('一覧: 瞬時電力が古くて合計に入れていない台は、行の瞬時電力に古い印を付ける', async () => {
  const items = [adapter('a'), adapter('b', { power: { value: 9000, at: 1, fresh: false } })]
  const m = await mount(html`<${ListPane} ...${listProps(items)} />`)
  const marked = $$(m.root, '.row-power [data-power-stale="1"]')
  assert.equal(marked.length, 1)
  assert.equal(textOf(marked[0]), '9,000 W')
  assert.equal(marked[0].getAttribute('title'), S.list.powerStaleTitle)
  await m.unmount()
})

// 戻すと落ちるもの: totalPower が stale を見ない → 古い値（9,000 W）が合計に入る。
test('一覧: 全台の合計に値の古い台を入れず、「n 台は値が古いため除外」と添える', async () => {
  const items = [adapter('a', { power: { value: 500, at: 1 } }), adapter('b', { power: { value: 9000, at: 1 }, stale: true, health: H('stale') })]
  const m = await mount(html`<${ListPane} ...${listProps(items)} />`)
  const total = $(m.root, '.total')
  assert.equal(textOf($(total, '.power')), '500 W')
  assert.ok(textOf(total).includes(S.list.totalPowerStale(1)))
  assert.ok($(total, 'svg.icon[data-icon="stale"]'), '除外の注記はアイコンつき')
  await m.unmount()
  const m2 = await mount(html`<${ListPane} ...${listProps([adapter('a')])} />`)
  assert.equal(textOf($(m2.root, '.total')).includes('値が古いため除いています'), false)
  await m2.unmount()
})

test('一覧の行: 健康のアイコンと色・名前・契約・瞬時電力（売電）・最終受信（stale は橙）。選んでいる行を強調し、今のタブのまま移る', async () => {
  const items = [
    adapter('bad1', { health: H('bad', { title: 'USB が切断されています', reasons: ['USB が切断されています'] }), stale: true }),
    adapter('ok2', { role: '動力', power: { value: -1234, at: 1 } }),
  ]
  const m = await mount(html`<${ListPane} ...${listProps(items, { selectedId: 'ok2', tab: 'logs' })} />`)
  const rows = $$(m.root, 'a.row')
  assert.deepEqual(rows.map((r) => r.getAttribute('data-id')), ['bad1', 'ok2'], 'サーバーの並びのまま')
  // 1 行目: 異常
  const r1 = rows[0]
  assert.ok(cls($(r1, '.hicon')).includes('tone-text-danger'), '色')
  assert.equal($(r1, '.hicon svg').getAttribute('data-icon'), 'bad', 'アイコン')
  assert.equal($(r1, '.hicon svg').getAttribute('aria-label'), S.health.bad, '読み上げの文字')
  assert.ok(cls($(r1, '.row-rx')).includes('tone-text-stale'), '最終受信は橙')
  assert.equal(textOf($(r1, '.row-why')), 'USB が切断されています')
  assert.equal(r1.getAttribute('aria-current'), null)
  // 2 行目: 選んでいる・売電・理由なし
  const r2 = rows[1]
  assert.equal(r2.getAttribute('aria-current'), 'page')
  assert.ok(cls(r2).includes('row-on'))
  assert.equal(textOf($(r2, '.row-power')), '売電 −1,234 W')
  assert.ok(cls($(r2, '.power')).includes('power-export'))
  assert.ok(textOf(r2).includes('動力'), '契約')
  assert.equal(!!$(r2, '.row-why'), false, '計測中は理由を出さない')
  assert.equal(r2.getAttribute('href'), '#/adapters/ok2/logs', '今のタブのまま移る')
  await m.unmount()
})

// 一覧の行にも、預かりがあれば小さく出す: 色・アイコン・文字の 3 つ。0 件と、項目の無い古いサーバーでは出さない。
// 戻すと落ちるもの: 一覧の行に預かりを出さない・0 件でも出す。
test('一覧の行: 預かっているコマンドがあれば小さく「預かり n」。0 件・項目が無ければ出さない', async () => {
  const items = [adapter('p1', { pendingCommands: { count: 3, oldestMs: 1000 } }), adapter('p0', { pendingCommands: { count: 0, oldestMs: null } }), adapter('px')]
  const m = await mount(html`<${ListPane} ...${listProps(items)} />`)
  const rows = $$(m.root, 'a.row')
  const p = $(rows[0], '.row-pending')
  assert.ok(p, '預かりの印')
  assert.equal(textOf(p), S.list.pending(3))
  assert.ok(cls(p).includes('tone-text-warn'), '色')
  assert.ok($(p, 'svg.icon[data-icon="queue"]'), 'アイコン')
  assert.equal(p.getAttribute('title'), S.list.pendingTitle(3))
  assert.equal($(rows[1], '.row-pending'), null, '0 件は出さない')
  assert.equal($(rows[2], '.row-pending'), null, '項目が無ければ出さない')
  await m.unmount()
})

// 戻すと落ちるもの: 一覧の行が health.reasons と overridden.stopped の両方を出す → 理由が 2 回。
test('一覧の行: 外部の停止の理由は 1 回だけ（停止中（理由））', async () => {
  const a = adapter('n1', {
    running: false,
    overridden: { stopped: { reason: '点検の作業', at: 1 }, any: true },
    health: H('stopped', { reasons: ['点検の作業'] }),
  })
  const m = await mount(html`<${ListPane} ...${listProps([a])} />`)
  const row = $(m.root, 'a.row')
  assert.equal(count(textOf(row), '点検の作業'), 1, textOf(row))
  assert.equal(textOf($(row, '.row-why')), S.flags.stopped('点検の作業'))
  await m.unmount()
})

test('一覧: 0 台なら設定ノードを作る案内とエディタへのリンク', async () => {
  const m = await mount(html`<${ListPane} ...${listProps([])} />`)
  assert.ok(textOf(m.root).includes(S.list.emptyBody))
  const link = buttonByText(m.root, S.list.openEditor) || $(m.root, 'a.btn')
  assert.equal(link.getAttribute('href'), 'http://h/')
  await m.unmount()
})

// 戻すと落ちるもの: list-pane.js で add.variant を見ない（ボタンは「エディタで追加…」なのに「アダプタを追加」と案内する）
test('一覧: 0 台で、この画面から追加できないサーバーでは、案内の文もエディタの手順に合わせる', async () => {
  const m = await mount(html`<${ListPane} ...${listProps([], { add: { variant: 'editor', reason: null, limit: null }, onOpenAdd: () => {} })} />`)
  assert.ok(textOf(m.root).includes(S.list.emptyBodyEditor), textOf(m.root))
  assert.ok(textOf(m.root).includes(S.list.addInEditor), 'ボタンと同じ名前')
  assert.equal(textOf(m.root).includes(S.list.emptyBody), false)
  await m.unmount()
  const add = await mount(html`<${ListPane} ...${listProps([], { add: { variant: 'add', reason: null, limit: null }, onOpenAdd: () => {} })} />`)
  assert.ok(textOf(add.root).includes(S.list.emptyBody))
  await add.unmount()
})

// Meta.editorRoot が null（settings.js の httpAdminRoot が false か disableEditor が true）ならエディタは無い。リンクを出さず、無いことを書く。
// 戻すと落ちるもの: editorRoot が null でもリンクを出す（href="null" の「エディタを開く」が残る）。
test('一覧: エディタが無効なサーバー（editorRoot が null）では、リンクを出さず「このサーバーではエディタが無効です」', async () => {
  const m = await mount(html`<${ListPane} ...${listProps([], { editorRoot: null })} />`)
  assert.ok(textOf(m.root).includes(S.list.emptyBody))
  assert.equal($$(m.root, 'a').length, 0, 'エディタへのリンクを出さない')
  assert.ok(textOf(m.root).includes('このサーバーではエディタが無効です'), textOf(m.root))
  await m.unmount()
})

// ---- 右ペインの見出し -----------------------------------------------------------------

const detailProps = (a, extra = {}) =>
  Object.assign(
    {
      id: a.id,
      tab: 'status',
      back: false,
      detail: { status: 'ok', data: a, error: null },
      values: null,
      writeReason: null,
      diagResults: [],
      editorRoot: 'http://h/',
      onAction: async () => ({ ok: true }),
      onDiag: async () => ({ ok: true }),
      onRetry: () => {},
    },
    extra,
  )

function stoppedAdapter(extra = {}) {
  return adapter(
    'n1',
    Object.assign(
      {
        mode: 'serial',
        port: '/dev/ttyUSB0',
        running: false,
        connected: false,
        radioBlocked: true,
        overridden: { stopped: { reason: '点検の確認', at: 1 }, any: true },
        health: H('stopped', { reasons: ['点検の確認'], nextAction: '「開始」か「自動運転に戻す」で再開します' }),
      },
      extra,
    ),
  )
}

// 停止の理由を 2 回出さない。戻すと落ちるもの: 見出しに「停止中（理由）」のバッジも出す。
test('詳細の見出し: 外部の停止の理由は 1 か所（「止めた理由: …」の行）。送信制限中のバッジ・「次に」は残る', async () => {
  const a = stoppedAdapter()
  const m = await mount(html`<${DetailPane} ...${detailProps(a)} />`)
  const head = $(m.root, '.dhead')
  assert.equal(count(textOf(head), '点検の確認'), 1, textOf(head))
  assert.ok(textOf($(head, '.why-reasons')).includes(S.detail.stopReason('点検の確認')))
  assert.ok(textOf(head).includes(S.flags.radioBlocked))
  assert.ok(textOf($(head, '.why-next')).includes('「開始」か「自動運転に戻す」で再開します'))
  assert.ok(buttonByText(head, S.actions.start), '止まっているので「開始」')
  assert.equal(!!buttonByText(head, S.actions.stop), false)
  await m.unmount()
})

test('詳細の主な値の 1 行: 瞬時電力・R / T 相・積算（正 / 逆、kWh）・最終受信・LQI', async () => {
  const a = adapter('n1', { power: { value: 458, at: 1 }, current: { r: 15, t: 30, at: 1 }, lqi: 98 })
  const values = { status: 'ok', items: [{ epc: '0xE0', value: 61532, unit: 'kWh', display: '61532 kWh' }, { epc: '0xE3', value: 0.4, unit: 'kWh', display: '0.4 kWh' }] }
  const m = await mount(html`<${DetailPane} ...${detailProps(a, { values })} />`)
  const k = textOf($(m.root, '.kpis'))
  for (const s of ['458 W', '15.0 A', '30.0 A', '61,532 kWh / 0.4 kWh', S.detail.kpi.lastRx, S.status.lqiLevels.fair]) assert.ok(k.includes(s), s + ' が無い: ' + k)
  // 戻すと落ちるもの: 言葉だけを出して、LQI の数を title に隠す（指の端末では title を読めない）
  const lqi = $$(m.root, '.kpis [data-kpi]').find((e) => e.getAttribute('data-kpi') === 'lqi')
  assert.ok(lqi, '電波の強さの欄がある')
  assert.equal(textOf(lqi), 'ふつう（LQI 98）')
  assert.ok(lqi.getAttribute('title').includes('dBm'), 'title はおよその dBm')
  await m.unmount()
})

// 既定の定期取得は E7 だけなので、「-」のままだと壊れて見える。
// 戻すと落ちるもの: Kpis の phase を formatAmps だけにする・値があっても「取得していません」を出す
test('詳細の主な値: 接続している台の定期の値に E8 が無いとき、R / T 相は「-」でなく取得していないと書く', async () => {
  const kpis = async (over) => {
    const m = await mount(html`<${DetailPane} ...${detailProps(adapter('n1', Object.assign({ connected: true, pollEpcs: ['0xE7'], current: { r: null, t: null } }, over)))} />`)
    const dds = $$(m.root, '.kpis dd').slice(1, 3)
    const out = dds.map((e) => [textOf(e), e.getAttribute('title')])
    await m.unmount()
    return out
  }
  assert.deepEqual(await kpis({}), [[S.detail.kpi.notPolled, S.values.currentNotPolled], [S.detail.kpi.notPolled, S.values.currentNotPolled]])
  assert.deepEqual((await kpis({ pollEpcs: ['0xE7', '0xE8'] })).map((x) => x[0]), [S.none, S.none], 'E8 を取っているなら待てば来る')
  assert.deepEqual((await kpis({ connected: false })).map((x) => x[0]), [S.none, S.none], '接続の前は「-」')
  assert.deepEqual((await kpis({ current: { r: 15, t: 30, at: 1 } })).map((x) => x[0]), ['15.0 A', '30.0 A'], '前に取れた値は残す')
})

// 止めた直後は connected が true のまま。サーバーは 409 で断るので、押せる形にしない。
// 戻すと落ちるもの: pollReason の stoppedByOverride を外す
test('詳細の操作: 外部の指示で止めている台は、接続が残っていても「今すぐ取得」を押せない', async () => {
  const a = stoppedAdapter({ connected: true })
  const m = await mount(html`<${DetailPane} ...${detailProps(a)} />`)
  const poll = buttonByText($(m.root, '.dhead'), S.actions.poll)
  assert.equal(poll.hasAttribute('disabled'), true)
  assert.ok(textOf($(m.root, '.actions')).includes(S.actions.stoppedPollReason) || (poll.getAttribute('title') || '').includes(S.actions.stoppedPollReason), textOf($(m.root, '.actions')))
  await m.unmount()
})

test('詳細: 5 つのタブ（状態 / 計測値 / 設定 / 診断 / ログ）。← 一覧 は 1 ペインのときだけ', async () => {
  const a = adapter('n1')
  const m = await mount(html`<${DetailPane} ...${detailProps(a, { tab: 'settings' })} settings=${null} />`)
  assert.deepEqual($$(m.root, '.tabs a').map(textOf), ['状態', '計測値', '設定', '診断', 'ログ'])
  assert.equal($(m.root, '.tabs a[aria-current="page"]').getAttribute('href'), '#/adapters/n1/settings')
  assert.equal(!!$(m.root, '.back-link'), false)
  await m.unmount()
  const m2 = await mount(html`<${DetailPane} ...${detailProps(a, { back: true })} />`)
  const back = $(m2.root, '.back-link')
  assert.equal(textOf(back), '← 一覧')
  assert.equal(back.getAttribute('href'), '#/')
  await m2.unmount()
})

// readOnly なら操作と保存のボタンを無効にして理由を添える。
test('読み出しのみ: 操作のボタンを無効にし、理由を 1 か所に添える', async () => {
  const a = adapter('n1')
  const m = await mount(html`<${DetailPane} ...${detailProps(a, { writeReason: S.actions.readOnlyReason })} />`)
  for (const label of [S.actions.poll, S.actions.reconnect, S.actions.stop]) {
    const b = buttonByText(m.root, label)
    assert.equal(b.hasAttribute('disabled'), true, label)
    assert.equal(b.getAttribute('title'), S.actions.readOnlyReason, label)
  }
  assert.equal(count(textOf($(m.root, '.dhead')), S.actions.readOnlyReason), 1)
  await m.unmount()
})

// SSE の 404: 右ペインに「見つかりません（デプロイで消えた可能性があります）」。
test('詳細が見つからない（404）: 右ペインに「見つかりません（デプロイで消えた可能性があります）」', async () => {
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter('gone'), { detail: { status: 'notFound', data: null, error: { status: 404 } } })} />`)
  assert.ok(textOf(m.root).includes(S.detail.notFound))
  assert.ok(S.detail.notFound.includes('見つかりません（デプロイで消えた可能性があります）'))
  await m.unmount()
})

// ---- 409 BUSY と連打 ---------------------------------------------------

// 戻すと落ちるもの: DetailPane の run の ref の歯止めを外す → 同じ描画の間の 2 回目の押下も送る。
test('「今すぐ取得」: 押している間は無効で、同じ瞬間の 2 回目は送らない。BUSY で返ったら押せる状態に戻る', async () => {
  const a = adapter('n1')
  const calls = []
  let release
  const onAction = (id, action) => {
    calls.push(action)
    return new Promise((r) => {
      release = () => r({ ok: false, busy: true })
    })
  }
  const m = await mount(html`<${DetailPane} ...${detailProps(a, { onAction })} />`)
  const btn = buttonByText(m.root, S.actions.poll)
  click(btn)
  click(btn)
  await settle()
  assert.deepEqual(calls, ['poll'], '2 回目は送らない')
  assert.equal(buttonByText(m.root, S.actions.poll).hasAttribute('disabled'), true, '押している間は無効')
  release()
  await settle()
  const after = buttonByText(m.root, S.actions.poll)
  assert.equal(after.hasAttribute('disabled'), false, 'BUSY で返ったら押せる')
  assert.equal(after.getAttribute('aria-busy'), null)
  await m.unmount()
})

// ---- 診断（1 つのフォーム + 直下の結果） ---------------------------------------------------

const selectCommand = (root, value) => {
  const sel = $(root, 'select[name="command"]')
  sel.value = value
  fire(sel, 'change')
}

// 戻すと落ちるもの: DiagTab の run の ref の歯止めを外す → onDiag が 2 回呼ばれる。
test('診断: 1 つのフォームで、同じ瞬間の 2 回目の送信はしない（電波の要求を積まない）', async () => {
  const calls = []
  let release
  const onDiag = (id, name, args) => {
    calls.push([name, args])
    return new Promise((r) => {
      release = () => r({ ok: false, busy: true })
    })
  }
  const m = await mount(html`<${DiagTab} id="n1" writeReason=${null} diagResults=${[]} onDiag=${onDiag} />`)
  assert.equal($$(m.root, 'form').length, 1, 'フォームは 1 つ')
  selectCommand(m.root, 'propmap')
  await settle()
  assert.ok(textOf(m.root).includes(S.diag.radioNote), '電波を使うものには印')
  const form = $(m.root, 'form.diag-form')
  fire(form, 'submit')
  fire(form, 'submit')
  await settle()
  assert.deepEqual(calls, [['propmap', undefined]])
  release()
  await settle()
  assert.equal($(m.root, 'form.diag-form button[type="submit"]').getAttribute('aria-busy'), null, 'busy を解く')
  await m.unmount()
})

test('診断: 引数（テーブル・レジスタ・EPC）を送り、結果はフォームのすぐ下に新しい順・時刻つきで並ぶ', async () => {
  const sent = []
  const onDiag = async (id, name, args) => (sent.push([name, args]), { ok: true })
  const t0 = new Date(2026, 10, 6, 9, 0, 0).getTime()
  const results = [
    { key: 'k3', name: 'epc', args: { epcs: ['EA'] }, at: t0 + 6000, ok: true, result: { lines: [], values: [{ epc: '0xEA', name: '定時積算電力量計測値（正方向）', display: '61532 kWh', meterAt: new Date(2026, 10, 6, 8, 30, 0).getTime() }] } },
    { key: 'k2', name: 'epc', args: { epcs: ['E7'] }, at: t0 + 5000, ok: true, result: { lines: [], values: [{ epc: '0xE7', name: '瞬時電力計測値', display: '458 W' }] } },
    { key: 'k1', name: 'sreg', args: { reg: 'SFD' }, at: t0, ok: false, error: { message: 'FAIL ER06', status: 502 } },
  ]
  const m = await mount(html`<${DiagTab} id="n1" writeReason=${null} diagResults=${results} onDiag=${onDiag} />`)
  const items = $$(m.root, 'ol.results li.result')
  assert.deepEqual(items.map((li) => li.getAttribute('data-name')), ['epc', 'epc', 'sreg'], '新しい順')
  // 戻すと落ちるもの: tab-diag.js の値の列が meterAt を見ない
  assert.ok(textOf(items[0]).includes('61532 kWh ' + S.values.meterFixed('08:30')), textOf(items[0]))
  assert.ok(textOf(items[1]).includes('09:00:05'))
  assert.ok(textOf(items[1]).includes('458 W'))
  assert.equal(textOf(items[1]).includes('確定'), false, 'meterAt の無い値には添えない')
  assert.ok(cls(items[2]).includes('result-failed'))
  assert.ok(textOf(items[2]).includes('FAIL ER06'))
  // フォームの後ろに結果
  const form = $(m.root, 'form.diag-form')
  const kids = form.parentNode.childNodes
  assert.ok(kids.indexOf(form) < kids.indexOf($(m.root, 'ol.results')))

  selectCommand(m.root, 'epc')
  await settle()
  typeInto($(m.root, 'input[name="epcs"]'), 'e7, 0xE8')
  await settle()
  fire($(m.root, 'form.diag-form'), 'submit')
  await settle()
  assert.deepEqual(sent, [['epc', { epcs: ['E7', 'E8'] }]])
  await m.unmount()
})

test('診断: 送れない EPC（EC）は送らずに理由を出す。読み出しのみなら実行を無効にして理由を出す', async () => {
  const sent = []
  const m = await mount(html`<${DiagTab} id="n1" writeReason=${null} diagResults=${[]} onDiag=${async (i, n) => (sent.push(n), { ok: true })} />`)
  selectCommand(m.root, 'epc')
  await settle()
  typeInto($(m.root, 'input[name="epcs"]'), 'E7 EC')
  await settle()
  assert.equal($(m.root, 'form.diag-form button[type="submit"]').hasAttribute('disabled'), true)
  assert.ok(textOf($(m.root, '.field-error')).includes('EC'))
  fire($(m.root, 'form.diag-form'), 'submit')
  await settle()
  assert.deepEqual(sent, [])
  await m.unmount()

  const m2 = await mount(html`<${DiagTab} id="n1" writeReason=${S.actions.readOnlyReason} diagResults=${[]} onDiag=${async () => ({ ok: true })} />`)
  const run = $(m2.root, 'form.diag-form button[type="submit"]')
  assert.equal(run.hasAttribute('disabled'), true)
  assert.equal(run.getAttribute('title'), S.actions.readOnlyReason)
  assert.ok(textOf(m2.root).includes(S.actions.readOnlyReason))
  await m2.unmount()
})

// ---- 状態タブ・計測値の鮮度 ---------------------------------------------------------------

// 接続の段階は、文字の 1 行ではなくステッパーで見せる。
// 状態は色（class）・アイコン（済みはチェック・失敗は ×・いまの段は回る印）・文字（段の名前と読み上げの状態）の 3 つで示す。
// 戻すと落ちるもの: 文字の 1 行（.phase-line）に戻す・済みのチェックを外す・いまの段の回る印を外す・説明（phaseHelp）を外す。
const statusAdapter = (extra = {}) =>
  adapter(
    'n1',
    Object.assign(
      {
        phase: 'joining',
        phaseText: 'メーターと認証中',
        phaseSince: Date.now() - 20 * 1000,
        health: H('busy'),
        connected: false,
        ladder: 1,
        consecutiveFailures: 2,
        join: { burst: 2, attempt: 3 },
        meter: { panid: '1234', channel: 59, channelMHz: 927.7, lqi: 98, addr: 'A', ipv6: 'B', pairId: '89ABCDEF' },
        calibration: { coefficient: 1, unitFactor: 0.1, digits: 6 },
        credentials: { configured: true, source: '環境変数', pairId: '89ABCDEF' },
        counters: { tx: 29, rx: 61, failures: 0, timeouts: 0, joins: 1, reconnects: 0, resends: 7, resendRecovered: 6, targetedScans: 5, fullScans: 4 },
        sendFails: { busy: 0, noNa: 0, mute: 0, fail: 2 },
        txBudgetMs: null,
      },
      extra,
    ),
  )
const stateOf = (li) => cls(li).find((c) => /^step-(done|now|fail|todo|off)$/.test(c))

test('状態タブ: 電波の強さは言葉と LQI の数を併記する', async () => {
  const m = await mount(html`<${StatusTab} a=${statusAdapter()} />`)
  assert.ok(textOf(m.root).includes('ふつう（LQI 98）'), textOf(m.root))
  await m.unmount()
})

test('状態タブ: 接続の段階はステッパー（丸・線・済みは緑のチェック・いまの段は強調と回る印・まだは灰）。下にいまの段の文と説明', async () => {
  const m = await mount(html`<${StatusTab} a=${statusAdapter()} />`)
  assert.equal($$(m.root, '.phase-line').length, 0, '文字の 1 行は使わない')
  const list = $(m.root, 'ol.steps')
  assert.ok(list, 'ステッパー')
  assert.equal(list.getAttribute('aria-label'), S.status.phaseStepsLabel)
  const steps = $$(list, 'li.step')
  assert.deepEqual(
    steps.map((li) => textOf($(li, '.step-label'))),
    S.status.phaseSteps,
  )
  assert.deepEqual(steps.map(stateOf), ['step-done', 'step-done', 'step-done', 'step-now', 'step-todo', 'step-todo'])
  for (const li of steps.slice(0, 3)) assert.equal($(li, '.step-dot svg.icon').getAttribute('data-icon'), 'check', '済みは緑のチェック')
  const now = steps[3]
  assert.equal(now.getAttribute('aria-current'), 'step')
  assert.ok($(now, '.step-dot .step-spin'), 'いまの段は回る印（動き）')
  assert.equal(textOf($(now, '.sr-only')), S.status.phaseState.now, '読み上げの状態')
  assert.equal($(steps[4], '.step-dot svg'), null, 'まだの段は空の丸')
  assert.equal(textOf($(steps[4], '.sr-only')), S.status.phaseState.todo)
  const cap = textOf($(m.root, '.steps-caption'))
  assert.ok(cap.includes('メーターと認証中'), 'いまの段の文（phaseText）')
  assert.ok(cap.includes(S.status.phaseSince('20 秒')), '経過: ' + cap)
  assert.ok(textOf(m.root).includes(S.status.phaseHelp.joining), 'いまの段の説明')
  await m.unmount()
})

test('状態タブ: 接続済みは全部の段にチェックと「接続済み · 13 分経過」。切断・失敗は赤の ×、停止中は点線の丸と「進めていません」', async () => {
  const ok = await mount(
    html`<${StatusTab} a=${statusAdapter({ phase: 'connected', phaseText: '接続済み', phaseSince: Date.now() - 13 * 60000 - 5000, health: H('ok'), connected: true, ladder: 0 })} />`,
  )
  assert.equal($$(ok.root, 'li.step-done').length, 6)
  assert.equal($$(ok.root, '.step-dot svg.icon[data-icon="check"]').length, 6)
  assert.equal(textOf($(ok.root, '.steps-caption')), '接続済み · ' + S.status.phaseSince('13 分'))
  await ok.unmount()

  const down = await mount(html`<${StatusTab} a=${statusAdapter({ phase: 'port-down', phaseText: 'ポート切断', health: H('bad') })} />`)
  const first = $(down.root, 'li.step')
  assert.equal(stateOf(first), 'step-fail', '切断は段 0 が失敗')
  assert.equal($(first, '.step-dot svg.icon').getAttribute('data-icon'), 'close', '失敗は ×')
  assert.equal(textOf($(first, '.sr-only')), S.status.phaseState.fail)
  assert.ok(cls($(down.root, '.steps-caption .phase-text')).includes('tone-text-danger'), '失敗の段の文は赤')
  await down.unmount()

  // サーバーの時計がブラウザより少し進んでいても（phaseSince が未来）、経過は「0 秒経過」と出す（実ブラウザで経過が消えた）
  const skew = await mount(html`<${StatusTab} a=${statusAdapter({ phase: 'connected', phaseText: '接続済み', phaseSince: Date.now() + 3000, health: H('ok'), connected: true })} />`)
  assert.equal(textOf($(skew.root, '.steps-caption')), '接続済み · ' + S.status.phaseSince('0 秒'))
  await skew.unmount()

  const failing = await mount(html`<${StatusTab} a=${statusAdapter({ phase: 'scanning', health: H('bad'), consecutiveFailures: 3 })} />`)
  assert.equal(stateOf($$(failing.root, 'li.step')[2]), 'step-fail', '手順の途中で bad ならいまの段が失敗')
  await failing.unmount()

  const idle = await mount(html`<${StatusTab} a=${statusAdapter({ phase: 'overridden', phaseText: '外部の指示で停止中', health: H('stopped') })} />`)
  assert.equal($$(idle.root, 'li.step-off').length, 6)
  assert.ok(cls($(idle.root, 'ol.steps')).includes('steps-off'))
  assert.equal($(idle.root, 'li.step[aria-current]'), null)
  assert.ok(textOf(idle.root).includes(S.status.phaseOff))
  assert.ok(textOf($(idle.root, '.steps-caption')).includes('外部の指示で停止中'))
  await idle.unmount()
})

// 「再接続の段: 段 0〜3 を説明つきの縦の並びで、いまの段を強調。連続失敗・PANA の巡目は横に」
// 戻すと落ちるもの: 「今の段」の 1 行（キーと値）に戻す・強調を外す・連続失敗を外す。
test('状態タブ: 再接続の段は段 0〜3 の説明つきの縦の並びで、いまの段を強調。連続失敗・PANA の巡目は横に', async () => {
  const m = await mount(html`<${StatusTab} a=${statusAdapter()} />`)
  const items = $$(m.root, 'ol.ladder li.ladder-step')
  assert.equal(items.length, 4)
  items.forEach((li, i) => {
    assert.ok(textOf(li).includes(S.status.ladderNum(i)), '段の番号')
    assert.ok(textOf(li).includes(S.status.ladderSteps[i]), '段の名前')
    assert.ok(textOf(li).includes(S.confirm.ladderHints[i]), '段の説明')
  })
  // 段階 2 は知っているチャネルから探す。名前と説明で同じ語句を 2 度書かない
  assert.ok(textOf(items[2]).includes('同じチャネルを探す → 全チャネルを探す'), textOf(items[2]))
  assert.equal(textOf(items[2]).split('同じチャネルを探す').length - 1, 1, textOf(items[2]))
  const cur = items[1]
  assert.equal(cur.getAttribute('aria-current'), 'step')
  assert.ok(cls(cur).includes('ladder-now') && cls(cur).includes('tone-warn'), 'いまの段を強調（黄）')
  assert.ok(textOf(cur).includes(S.status.ladderTagNow))
  assert.equal($$(m.root, 'li.ladder-now').length, 1)
  const side = $(m.root, '.reconnect-side')
  assert.ok(textOf(side).includes(S.status.failures) && textOf(side).includes(S.status.failuresCount(2)), '連続失敗')
  assert.ok(textOf(side).includes(S.status.joinBurst) && textOf(side).includes(S.status.joinBurstValue(2, 3)), 'PANA の巡目')
  assert.ok($(side, '.tone-text-danger'), '連続失敗が 1 以上なら赤')
  await m.unmount()

  const on = await mount(html`<${StatusTab} a=${statusAdapter({ phase: 'connected', connected: true, health: H('ok'), ladder: 0, consecutiveFailures: 0 })} />`)
  const first = $(on.root, 'li.ladder-now')
  assert.ok(textOf(first).includes(S.status.ladderTagNext), 'つながっていれば「切れたらここから」')
  assert.ok(cls(first).includes('tone-neutral'))
  assert.equal($(on.root, '.reconnect-side .tone-text-danger'), null)
  await on.unmount()
})

// 「送信積算: 1 時間あたり 360 秒のうちの使った秒数をゲージ（棒。70% を超えたら注意の色、自分から休む線を示す）。まだ読んでいなければ今の文」
// 戻すと落ちるもの: 「n / 360 秒」の文字だけに戻す・注意の色を外す・休む線を外す。
test('状態タブ: 送信積算は 360 秒のうちの棒のゲージ。70% を超えたら注意の色、自分から休む線（250 秒）。未読なら案内', async () => {
  const m = await mount(html`<${StatusTab} a=${statusAdapter({ txBudgetMs: 123456 })} />`)
  const g = $(m.root, '.gauge')
  assert.ok(g, 'ゲージ')
  assert.ok(textOf(g).includes(S.status.txLabel('123')))
  assert.ok(textOf(g).includes(S.status.txPercent(34)))
  const svg = $(g, 'svg.gauge-bar')
  assert.equal(svg.getAttribute('viewBox'), '0 0 360 12')
  assert.equal(svg.getAttribute('role'), 'img')
  assert.equal(svg.getAttribute('aria-label'), S.status.txAria('123', 34))
  const fill = $(svg, 'rect.gauge-fill')
  assert.equal(String(fill.getAttribute('width')), '123')
  assert.ok(cls(fill).includes('gauge-fill-ok'))
  const guard = $(svg, 'line.gauge-guard')
  assert.equal(String(guard.getAttribute('x1')), '250')
  assert.ok(textOf(g).includes(S.status.txGuard(250)), '休む線の説明')
  assert.ok(textOf(m.root).includes(S.status.txNote))
  await m.unmount()

  const hot = await mount(html`<${StatusTab} a=${statusAdapter({ txBudgetMs: 260000 })} />`)
  assert.ok(cls($(hot.root, 'rect.gauge-fill')).includes('gauge-fill-warn'), '70% を超えたら注意の色')
  assert.ok(cls($(hot.root, '.gauge-value')).includes('tone-text-warn'), '数も注意の色')
  await hot.unmount()

  const none = await mount(html`<${StatusTab} a=${statusAdapter({ txBudgetMs: null })} />`)
  assert.equal($(none.root, '.gauge-bar'), null)
  assert.ok(textOf(none.root).includes(S.status.txUnknown))
  await none.unmount()
})

// 状態タブに、預かっている数と、いちばん古いものの待ち時間（pendingCommands: {count, oldestMs}）。
// 戻すと落ちるもの: 預かりの行を出さない・0 件で「0 件」と出す・項目の無い古いサーバーで「なし」と言い切る。
test('状態タブ: 預かっているコマンドは件数といちばん古いものの待ち時間。0 件は「なし」、項目の無い古いサーバーでは出さない', async () => {
  const m = await mount(html`<${StatusTab} a=${statusAdapter({ pendingCommands: { count: 2, oldestMs: 45000 } })} />`)
  const row = $(m.root, '.pending-row')
  assert.ok(row, '預かりの行')
  assert.ok(textOf(row).includes(S.status.groups.pending))
  assert.ok(textOf(row).includes(S.status.pendingValue(2, '45 秒')), textOf(row))
  assert.ok(cls($(row, 'td')).includes('tone-text-warn'), '預かりがあれば注意の色')
  assert.ok($(row, 'svg.icon[data-icon="queue"]'), 'アイコン')
  assert.ok(textOf(m.root).includes(S.status.pendingHint))
  await m.unmount()

  const zero = await mount(html`<${StatusTab} a=${statusAdapter({ pendingCommands: { count: 0, oldestMs: null } })} />`)
  assert.equal(textOf($(zero.root, '.pending-row td')), S.status.pendingNone)
  assert.equal(textOf(zero.root).includes(S.status.pendingHint), false, '0 件なら説明は出さない')
  await zero.unmount()

  const old = await mount(html`<${StatusTab} a=${statusAdapter()} />`)
  assert.equal($(old.root, '.pending-row'), null, '項目が無ければ出さない')
  await old.unmount()
})

// 「メーター・換算・アダプタ・カウンタは、今のキーと値の表のまま、見出しとアイコンを整える」。カードの入れ子は作らない。
test('状態タブ: メーター・換算・アダプタ・認証情報・カウンタ・直近のエラーは、アイコンつきの見出しとキーと値の表。カードを並べない', async () => {
  const m = await mount(html`<${StatusTab} a=${statusAdapter()} />`)
  assert.equal($$(m.root, '.card').length, 0, 'カードを並べない')
  const titles = $$(m.root, '.st-title')
  const g = S.status.groups
  // 初めての人が見るものを先に。換算・アダプタ・カウンタは「詳しい状態」の折りたたみの中
  assert.deepEqual(titles.map(textOf), [g.phase, g.lastError, g.meter, g.credentials, g.reconnect, g.tx, g.calibration, g.adapter, g.counters])
  const icons = titles.map((t) => $(t, 'svg.icon').getAttribute('data-icon'))
  assert.deepEqual(icons, ['plug', 'warn', 'signal', 'key', 'refresh', 'radio', 'sliders', 'chip', 'list'], '見出しのアイコン（知らない名前で info に落ちない）')
  assert.equal($$(m.root, 'table.kv-table').length, 5, 'キーと値の表（メーター・換算・アダプタ・認証情報・カウンタ）')
  const t = textOf(m.root)
  for (const s of ['1234', '59（927.7 MHz）', '環境変数', '送信 29', '送信失敗 2', S.status.noError]) assert.ok(t.includes(s), s)
  // 再接続の作戦が効いているかを、画面で確かめる数（ラベルの無いキーは黙って落ちる）
  for (const s of ['送り直し 7', '送り直しで取れた 6', '同じチャネルのスキャン 5', '全チャネルのスキャン 4']) assert.ok(t.includes(s), s)
  // 見出しは h2（右ペインの見出しの h1 の下）。並べた section が見出しを名前に持つ
  for (const sec of $$(m.root, 'section.st-sec')) {
    const id = sec.getAttribute('aria-labelledby')
    assert.ok(id && $(sec, 'h2#' + id), 'section の名前は見出し')
  }
  await m.unmount()
})

test('計測値の鮮度の列: 控え中（n 分後）・このメーターは持っていない・最新・古い（サーバーの fresh のまま）', () => {
  const now = 1_000_000
  assert.deepEqual(valueState({ held: { until: now + 5 * 60000, count: 1 }, fresh: true }, now), { tone: 'warn', text: S.values.held(5) })
  assert.deepEqual(valueState({ held: { until: now - 1, count: 1 }, fresh: false }, now), { tone: 'warn', text: S.values.heldSoon })
  assert.deepEqual(valueState({ supported: false, fresh: false }, now), { tone: 'dim', text: S.values.unsupported })
  assert.deepEqual(valueState({ fresh: true }, now), { tone: 'ok', text: S.values.fresh })
  assert.deepEqual(valueState({ fresh: false, at: 1 }, now), { tone: 'dim', text: S.values.old })
})

// read と同じもの: 計測値の表は持っている値をそのまま出し、まだ一度も取れていない値（read の missing。
// 定期取得の EPC・控え中で値の無い行）は「古い」ではなく「まだ取れていません」と出す。
// 戻すと落ちるもの: 値の無い行を fresh: false のまま「古い」と出す。
test('計測値の鮮度の列: まだ一度も取れていない値（時刻も値も無い行）は「まだ取れていません」。控え中・持っていないが先', () => {
  const now = 1_000_000
  assert.deepEqual(valueState({ value: null, display: '', at: null, fresh: false, held: null, supported: null }, now), { tone: 'dim', text: S.values.missing })
  assert.deepEqual(valueState({ value: null, at: null, fresh: false, supported: false }, now), { tone: 'dim', text: S.values.unsupported })
  assert.deepEqual(valueState({ value: null, at: null, fresh: false, held: { until: now + 60000, count: 1 } }, now), { tone: 'warn', text: S.values.held(1) })
  assert.deepEqual(valueState({ value: 0, at: now - 1000, fresh: false }, now), { tone: 'dim', text: S.values.old }, '値が 0 でも取れている')
})

// ---- 設定タブ（出どころ） --------------------------------------------------------

function settingsData(rev, over = {}) {
  const f = (value, source, extra = {}) => Object.assign({ value, source, configValue: value, default: value, by: null, at: null }, extra)
  const fields = {
    pollIntervalSec: f(30, 'config', { min: 15, max: 3600 }),
    pollEpcs: f(['0xE7'], 'default'),
    slowIntervalSec: f(300, 'default', { min: 60, max: 3600 }),
    halfHourIntervalSec: f(1800, 'default', { min: 300, max: 7200 }),
  }
  for (const k of Object.keys(over)) fields[k] = Object.assign({}, fields[k], over[k])
  return { rev, fields, warnings: [] }
}

const settingsProps = (data, extra = {}) =>
  Object.assign(
    {
      a: adapter('n1', { supportedEpcs: null }),
      settings: { status: 'ok', data, error: null },
      writeReason: null,
      editorRoot: 'http://h/',
      onSaveSettings: async () => ({ ok: true, settings: data }),
      onResetSettings: async () => ({ ok: true, settings: data }),
      onReloadSettings: () => {},
    },
    extra,
  )

const withData = (props, data) => Object.assign({}, props, { settings: { status: 'ok', data, error: null } })
const chip = (root, epc) => root.querySelectorAll('.chips .chip').find((b) => textOf(b) === epc) || null
const formState = (root) => textOf($(root, '.form-state'))
const saveButton = (root) => $(root, '.settings-form button[type="submit"]')
const has = (root, s) => textOf(root).includes(s)
// 出どころは基本設定には出さず、詳細設定の「出どころ」の表にまとめた
const sourceOf = (root, field) => textOf($(root, `.src-row[data-field="${field}"] .set-source`))

// 出どころに「画面」「フロー（<名前>）」。戻すと落ちるもの: by をそのまま出す・出さない。
test('設定: 出どころ（運用設定・設定ノード・既定・一時的な上書き）と、変えた経路（画面 / フロー（名前））と時刻', async () => {
  const at = new Date(2026, 10, 6, 10, 0, 0).getTime()
  const data = settingsData('r1', {
    pollIntervalSec: { value: 60, source: 'runtime', by: 'flow:取得の上書き', at, configValue: 30 },
    pollEpcs: { value: ['0xE7', '0xE8'], source: 'runtime', by: 'web-ui', at },
    slowIntervalSec: { source: 'override' },
  })
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data)} />`)
  assert.ok(sourceOf(m.root, 'pollIntervalSec').startsWith(S.settings.source.runtime + ' · フロー（取得の上書き） · 2026/11/06 10:00:00'), sourceOf(m.root, 'pollIntervalSec'))
  assert.ok(textOf($(m.root, '.src-row[data-field="pollIntervalSec"]')).includes(S.settings.configValue('30 秒')))
  assert.ok(sourceOf(m.root, 'pollEpcs').startsWith(S.settings.source.runtime + ' · 画面 · '))
  assert.ok(sourceOf(m.root, 'slowIntervalSec').startsWith(S.settings.source.override))
  assert.ok(sourceOf(m.root, 'halfHourIntervalSec').startsWith(S.settings.source.default))
  assert.equal(sourceOf(m.root, 'halfHourIntervalSec').includes('画面'), false)
  // 同じことはノードからもできる、と 1 行
  assert.equal(count(textOf(m.root), S.settings.tabFooter), 1)
  assert.ok(S.settings.tabFooter.includes('フローの入力（settings・config・credentials）とエディタの設定ノード'))
  await m.unmount()
})

// view-model は override を runtime より優先するので、上書きの下に運用設定がある項目の source は 'override'。
// by / at があれば運用設定がある。「設定ノードの値に戻す」（DELETE）を押せるようにし、出どころにも運用設定があることを出す。
// 戻すと落ちるもの: tab-settings.js の hasRuntime を source === 'runtime' だけに戻す → 戻すのボタンが無効のまま。
test('設定: 一時的な上書きの下に運用設定がある項目は「運用設定あり（画面 · 時刻）」を出し、「設定ノードの値に戻す」を押せる', async () => {
  const at = new Date(2026, 10, 6, 10, 0, 0).getTime()
  const data = settingsData('r1', { pollIntervalSec: { value: 120, source: 'override', by: 'web-ui', at, configValue: 30 } })
  const resets = []
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data, { onResetSettings: async (rev) => (resets.push(rev), { ok: true, settings: data }) })} />`)
  const reset = buttonByText(m.root, S.settings.reset)
  assert.equal(reset.hasAttribute('disabled'), false, '上書きの下の運用設定を外せる')
  assert.equal(typeof S.settings.runtimeUnder, 'function', 'strings.js に runtimeUnder が無い')
  const src = sourceOf(m.root, 'pollIntervalSec')
  assert.ok(src.startsWith(S.settings.source.override), src)
  assert.ok(src.includes(S.settings.runtimeUnder('画面', '2026/11/06 10:00:00')), src)
  click(reset)
  await settle()
  fire($(m.root, '.dialog-form'), 'submit')
  await settle()
  assert.deepEqual(resets, ['r1'])
  await m.unmount()
  // 上書きだけ（運用設定が無い）なら押せない・運用設定ありとは出さない
  const only = settingsData('r1', { pollIntervalSec: { value: 120, source: 'override', configValue: 30 } })
  const m2 = await mount(html`<${SettingsTab} ...${settingsProps(only)} />`)
  assert.equal(buttonByText(m2.root, S.settings.reset), null, '外す運用設定が無ければ出さない')
  assert.equal(sourceOf(m2.root, 'pollIntervalSec').includes(S.settings.source.runtime), false)
  await m2.unmount()
})

// SettingField.runtimeValue（運用設定そのものの値。無ければ null）。上書きの下にある運用設定は、値まで出す。
// runtimeValue の無い古いサーバーでは、上の試験のとおり経路と時刻だけ。
// 戻すと落ちるもの: SourceCell で runtimeValue を使わない →「1 分 · 画面 · …」が出ない・経路も時刻も無い項目を「運用設定あり」にしない。
test('設定: 上書きの下の運用設定は「運用設定あり（値 · 画面 · 時刻）」と値まで出す（runtimeValue）', async () => {
  const at = new Date(2026, 10, 6, 10, 0, 0).getTime()
  const data = settingsData('r1', {
    pollIntervalSec: { value: 120, source: 'override', runtimeValue: 60, by: 'web-ui', at, configValue: 30 },
    pollEpcs: { value: ['0xE7'], source: 'override', runtimeValue: ['0xE7', '0xE8'], by: 'flow:取得の上書き', at },
  })
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data)} />`)
  const src = sourceOf(m.root, 'pollIntervalSec')
  assert.ok(src.startsWith(S.settings.source.override), src)
  assert.ok(src.includes('運用設定あり（1 分 · 画面 · 2026/11/06 10:00:00）'), src)
  assert.ok(sourceOf(m.root, 'pollEpcs').includes('運用設定あり（E7 E8 · フロー（取得の上書き） · 2026/11/06 10:00:00）'), sourceOf(m.root, 'pollEpcs'))
  await m.unmount()

  // 経路と時刻が無くても（前の版の settings.json）、runtimeValue があれば運用設定がある。値を出し、外せる
  const bare = settingsData('r1', { pollIntervalSec: { value: 120, source: 'override', runtimeValue: 45, configValue: 30 } })
  const m2 = await mount(html`<${SettingsTab} ...${settingsProps(bare)} />`)
  assert.ok(sourceOf(m2.root, 'pollIntervalSec').includes('運用設定あり（45 秒）'), sourceOf(m2.root, 'pollIntervalSec'))
  assert.equal(buttonByText(m2.root, S.settings.reset).hasAttribute('disabled'), false, '上書きの下の運用設定を外せる')
  await m2.unmount()

  // runtimeValue が null（運用設定は無い）: 運用設定ありとは出さず、外すものも無い
  const none = settingsData('r1', { pollIntervalSec: { value: 120, source: 'override', runtimeValue: null, configValue: 30 } })
  const m3 = await mount(html`<${SettingsTab} ...${settingsProps(none)} />`)
  assert.equal(sourceOf(m3.root, 'pollIntervalSec').includes(S.settings.source.runtime), false, sourceOf(m3.root, 'pollIntervalSec'))
  assert.equal(buttonByText(m3.root, S.settings.reset), null)
  await m3.unmount()
})

// サーバーは、エディタの照合で運用設定を外した項目に by 'editor' と外した時刻を付ける
// （source は config のまま、runtimeValue は null）。これを「運用設定あり」と読んではいけない（外すものが無いのに「設定ノードの値に戻す」が押せる）。
// 出どころには「設定ノード · エディタ · 時刻」と出す。
// 戻すと落ちるもの: hasRuntimeRecord が runtimeValue のある新しいサーバーでも by / at を見る → 戻すのボタンが押せる。
test('設定: エディタで外した項目（by editor・runtimeValue null）は運用設定ありにせず、「設定ノード · エディタ · 時刻」と出す', async () => {
  const at = new Date(2026, 10, 6, 10, 0, 0).getTime()
  const data = settingsData('r1', { pollIntervalSec: { value: 45, source: 'config', runtimeValue: null, by: 'editor', at, configValue: 45 } })
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data)} />`)
  assert.equal(buttonByText(m.root, S.settings.reset), null, '外す運用設定は無い')
  const src = sourceOf(m.root, 'pollIntervalSec')
  assert.ok(src.startsWith(S.settings.source.config), src)
  assert.equal(src.includes('運用設定あり'), false, src)
  assert.ok(src.includes('エディタ'), src)
  assert.ok(src.includes('2026/11/06 10:00:00'), src)
  await m.unmount()
})

// 設定ノードに値が無い項目が「設定ノード: - · 既定: 5 分」と出ると読めない。
// 戻すと落ちるもの: 設定ノードの値が無いときに S.none（-）を出す。
test('設定: 出どころの下の行は、設定ノードに値が無ければ「設定ノード: 未設定 · 既定: 5 分」', async () => {
  const data = settingsData('r1', {
    slowIntervalSec: { value: 300, source: 'default', configValue: null, default: 300 },
    pollEpcs: { value: ['0xE7'], source: 'default', configValue: [], default: ['0xE7'] },
    halfHourIntervalSec: { value: 1800, source: 'default', configValue: null, default: 1800 },
  })
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data)} />`)
  const base = (f) => textOf($(m.root, `.src-row[data-field="${f}"] .set-base`))
  assert.equal(base('slowIntervalSec'), '設定ノード: 未設定 · 既定: 5 分')
  assert.equal(base('halfHourIntervalSec'), '設定ノード: 未設定 · 既定: 30 分')
  assert.equal(base('pollEpcs'), '設定ノード: 未設定 · 既定: E7', '空の配列も値が無い')
  assert.equal(base('pollIntervalSec'), '設定ノード: 30 秒 · 既定: 30 秒', '値があればそのまま')
  await m.unmount()
})

// 構成の「エディタで開く」も Meta.editorRoot から作る（app.js が editorRootOf で決めて渡す）。null なら出さない。
// 戻すと落ちるもの: editorRoot が null でも「エディタで開く」を出す（href="null#node/n1"）。
test('設定: 構成の「エディタで開く」は editorRoot の #node/<id>。null ならリンクを出さず「このサーバーではエディタが無効です」', async () => {
  const data = settingsData('r1')
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data, { editorRoot: 'http://h/admin/' })} />`)
  const link = $(m.root, 'a[target="_blank"]')
  assert.equal(link && link.getAttribute('href'), 'http://h/admin/#node/n1')
  assert.equal(textOf(m.root).includes('このサーバーではエディタが無効です'), false)
  await m.unmount()
  const m2 = await mount(html`<${SettingsTab} ...${settingsProps(data, { editorRoot: null })} />`)
  assert.equal($$(m2.root, 'a').length, 0, 'エディタへのリンクを出さない')
  assert.ok(textOf(m2.root).includes('このサーバーではエディタが無効です'), textOf(m2.root).slice(-120))
  await m2.unmount()
})

// Meta.editorRoot が null になるのは httpAdminRoot: false だけではない。
// サーバーは disableEditor: true でも null にする（service.js の editorRootOf。httpRoot: false は httpNodeRoot も切るので画面が出ない）。
// 理由を httpAdminRoot: false だけに決めつけると、disableEditor: true だけを書いたサーバーで、無い設定を探させる。
// 戻すと落ちるもの: strings.js の editorDisabled を「（settings.js の httpAdminRoot: false）」だけにする。
test('エディタが無効のときの文は、httpAdminRoot: false と disableEditor: true の両方を挙げる（一覧と設定）', async () => {
  const m = await mount(html`<${ListPane} ...${listProps([], { editorRoot: null })} />`)
  const m2 = await mount(html`<${SettingsTab} ...${settingsProps(settingsData('r1'), { editorRoot: null })} />`)
  for (const [where, root] of [['一覧', m.root], ['設定', m2.root]]) {
    const t = textOf(root)
    assert.ok(t.includes('このサーバーではエディタが無効です'), where + ': ' + t.slice(-160))
    assert.ok(t.includes('httpAdminRoot: false'), where + ': httpAdminRoot: false を挙げていない')
    assert.ok(t.includes('disableEditor: true'), where + ': disableEditor: true を挙げていない: ' + t.slice(-160))
  }
  await m.unmount()
  await m2.unmount()
})

test('設定: 読み出しのみなら、入力・保存・戻すを無効にして理由を添える', async () => {
  const data = settingsData('r1', { pollIntervalSec: { source: 'runtime', by: 'web-ui', at: 1 } })
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data, { writeReason: S.actions.readOnlyReason })} />`)
  assert.equal(saveButton(m.root).hasAttribute('disabled'), true)
  assert.equal(buttonByText(m.root, S.settings.reset).hasAttribute('disabled'), true)
  assert.equal($(m.root, '#in-slowIntervalSec').hasAttribute('disabled'), true)
  assert.ok(has(m.root, S.actions.readOnlyReason))
  await m.unmount()
})

// 戻すと落ちるもの: validateDraft が差分に入らない項目も検証する → 取得間隔（7200 秒）のエラーで保存のダイアログが開かない。
test('設定: 触っていない項目が範囲の外（設定ノードの取得間隔 7200 秒）でも、EPC だけの変更は保存できる。範囲の外は注意だけ出す', async () => {
  const data = settingsData('r1', { pollIntervalSec: { value: 7200, configValue: 7200 } })
  const saved = []
  const props = settingsProps(data, {
    onSaveSettings: async (patch, rev) => {
      saved.push({ patch, rev })
      return { ok: true, settings: data }
    },
  })
  const m = await mount(html`<${SettingsTab} ...${props} />`)
  assert.equal(has(m.root, S.settings.outOfRangeKept(15, 3600)), true, '範囲の外の注意')
  assert.equal(!!$(m.root, '.set-row-error'), false, '触っていない項目をエラーにしない')

  click(chip(m.root, 'E8'))
  await settle()
  assert.equal(formState(m.root), S.settings.dirty)
  fire($(m.root, '.settings-form'), 'submit')
  await settle()
  const dlg = $(m.root, '.dialog-form')
  assert.ok(dlg, '保存の確認が開く')
  assert.match(textOf($(m.root, '.diff-table')), /E8/)
  assert.equal(has($(m.root, '.diff-table'), S.settings.fields.pollIntervalSec), false, '差分は EPC だけ')
  fire(dlg, 'submit')
  await settle()
  assert.deepEqual(saved, [{ patch: { pollEpcs: ['E7', 'E8'] }, rev: 'r1' }])
  await m.unmount()
})

test('設定: 変えた項目が範囲の外なら、保存の前に止めてその項目にエラーを出す', async () => {
  const data = settingsData('r1')
  const saved = []
  const m = await mount(html`<${SettingsTab} ...${settingsProps(data, { onSaveSettings: async (p) => (saved.push(p), { ok: true, settings: data }) })} />`)
  typeInto($(m.root, '#in-slowIntervalSec'), '30')
  await settle()
  fire($(m.root, '.settings-form'), 'submit')
  await settle()
  assert.equal(!!$(m.root, '.dialog-form'), false)
  assert.equal(has($(m.root, '.set-row-error'), S.settings.errRange(60, 3600)), true)
  assert.deepEqual(saved, [])
  await m.unmount()
})

// 戻すと落ちるもの: 下書きを rev の変化でだけ取り込む → 読み直したあとも「ほかの場所で変わりました」が残る。
test('設定: 412 のあとの「読み直す」は 1 回で効く（新しい値を取り込み、帯も「変更があります」も消える）', async () => {
  const r1 = settingsData('r1')
  let reloads = 0
  const props = settingsProps(r1, {
    onSaveSettings: async () => ({ ok: false, error: { status: 412, code: 'REVISION_MISMATCH', message: 'ほかの場所で先に変更されました' } }),
    onReloadSettings: () => reloads++,
  })
  const m = await mount(html`<${SettingsTab} ...${props} />`)
  click(chip(m.root, 'E8'))
  await settle()
  fire($(m.root, '.settings-form'), 'submit')
  await settle()
  fire($(m.root, '.dialog-form'), 'submit')
  await settle()
  assert.equal(has(m.root, S.settings.conflict), true)

  click(buttonByText(m.root, S.reload))
  await settle()
  assert.equal(reloads, 1)
  const r2 = settingsData('r2', { pollIntervalSec: { value: 60, source: 'runtime' }, pollEpcs: { value: ['0xE7', '0xE0'], source: 'runtime' } })
  await m.rerender(html`<${SettingsTab} ...${withData(props, r2)} />`)
  assert.equal(has(m.root, S.settings.conflict), false)
  assert.equal(has(m.root, S.settings.updatedElsewhere), false)
  assert.equal(formState(m.root), S.settings.noChanges)
  assert.equal(saveButton(m.root).hasAttribute('disabled'), true)
  assert.equal(chip(m.root, 'E0').getAttribute('aria-pressed'), 'true', '新しい値を取り込む')
  assert.equal(chip(m.root, 'E8').getAttribute('aria-pressed'), 'false')
  await m.unmount()
})

// 戻すと落ちるもの: 下書きを rev の変化でだけ取り込む → rev が同じまま上書きの値が変わると「変更があります」になる。
test('設定: 一時的な上書き（source が override）の値だけが変わっても、触っていない項目は「変更があります」にならない', async () => {
  const r1 = settingsData('r1')
  const props = settingsProps(r1)
  const m = await mount(html`<${SettingsTab} ...${props} />`)
  assert.equal(formState(m.root), S.settings.noChanges)
  const ov = settingsData('r1', { pollIntervalSec: { value: 60, source: 'override' } })
  await m.rerender(html`<${SettingsTab} ...${withData(props, ov)} />`)
  assert.equal(formState(m.root), S.settings.noChanges)
  assert.equal(saveButton(m.root).hasAttribute('disabled'), true)
  assert.equal($(m.root, '#in-pollIntervalSec').value, '60', '上書きの値を出す')
  assert.ok(has(m.root, S.settings.overrideActive))
  await m.unmount()
})

test('設定: 手で変えた項目は残し、触っていない項目はサーバーの新しい値に付いていく（rev が変わったら知らせる）', async () => {
  const r1 = settingsData('r1')
  const props = settingsProps(r1)
  const m = await mount(html`<${SettingsTab} ...${props} />`)
  typeInto($(m.root, '#in-slowIntervalSec'), '600')
  await settle()
  const r2 = settingsData('r2', { halfHourIntervalSec: { value: 3600, source: 'runtime' } })
  await m.rerender(html`<${SettingsTab} ...${withData(props, r2)} />`)
  assert.equal($(m.root, '#in-slowIntervalSec').value, '600', '手で変えた値は残す')
  assert.equal($(m.root, '#in-halfHourIntervalSec').value, '3600', '触っていない項目は新しい値')
  assert.equal(formState(m.root), S.settings.dirty)
  assert.equal(has(m.root, S.settings.updatedElsewhere), true)
  typeInto($(m.root, '#in-slowIntervalSec'), '300')
  await settle()
  assert.equal(formState(m.root), S.settings.noChanges)
  assert.equal(has(m.root, S.settings.updatedElsewhere), false)
  await m.unmount()
})

// 戻すと落ちるもの: DetailPane の SettingsTab の key を外す → 別の台へ移っても、前の台で手で変えた値が残る。
test('設定: 別の台の設定タブへ移ったら、前の台で手で変えた値を持ち越さない', async () => {
  const data = settingsData('r1')
  const base = (id) =>
    detailProps(adapter(id, { supportedEpcs: null }), {
      tab: 'settings',
      settings: { status: 'ok', data, error: null },
      onSaveSettings: async () => ({ ok: true, settings: data }),
      onResetSettings: async () => ({ ok: true, settings: data }),
      onReloadSettings: () => {},
    })
  const m = await mount(html`<${DetailPane} ...${base('n1')} />`)
  typeInto($(m.root, '#in-slowIntervalSec'), '600')
  await settle()
  assert.equal(formState(m.root), S.settings.dirty)
  await m.rerender(html`<${DetailPane} ...${base('n2')} />`)
  assert.equal(formState(m.root), S.settings.noChanges)
  assert.equal($(m.root, '#in-slowIntervalSec').value, '300')
  await m.unmount()
})

// ---- 「その他」のメニュー -----------------------------------------------------------------

// 実ブラウザの 390px では、ボタンが行の左に折り返し、右端に揃えた一覧が x=-220 まではみ出した。
// 戻すと落ちるもの: menuAlign を使わずいつも右端に揃える → 狭い幅の 'left' が落ちる。
test('「その他」の一覧: 右端に揃えると画面の左からはみ出すときは左端に揃える', async () => {
  const { Menu, menuAlign } = await import('../../ui/components/menu.js')
  assert.equal(menuAlign({ left: 16, right: 100 }, 390), 'left', '390px で行の左に折り返したボタン')
  assert.equal(menuAlign({ left: 668, right: 752 }, 1280), 'right', 'PC の行の右寄りのボタン')
  assert.equal(menuAlign({ left: 400, right: 480 }, 520), 'right')
  assert.equal(menuAlign(null, 390), 'left')
  // 偽の DOM の要素の大きさは 0（ボタンは左端）なので、左端に揃う
  const m = await mount(html`<${Menu} label=${S.actions.more} items=${[{ key: 'a', label: S.actions.auto, onSelect: () => {} }]} />`)
  click($(m.root, '.menu button'))
  await settle()
  assert.ok(cls($(m.root, '.menu-list')).includes('menu-list-left'))
  await m.unmount()
})
