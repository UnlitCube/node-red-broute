// 触ったあとの動き（確認ダイアログ・メニュー・グラフの吹き出し）を偽の DOM で確かめる。
// 指の pointerup のあとに来る pointerleave と、Esc の連打で <dialog> が閉じる動きは偽の DOM に無いので、ここではイベントを手で起こす。
// 本物の動きは test/ui/browser.test.mjs が実ブラウザで見る。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mount, click, fire, settle, until, $, $$, textOf, buttonByText } from './fake-dom.mjs'

installDom()
const { html, useState, useEffect } = await import('../../ui/html.js')
const { S } = await import('../../ui/strings.js')
const { Dialog } = await import('../../ui/components/dialog.js')
const { AddDialog } = await import('../../ui/components/add-pane.js')
const { DetailPane } = await import('../../ui/components/detail-pane.js')
const { ListPane } = await import('../../ui/components/list-pane.js')
const { Menu } = await import('../../ui/components/menu.js')
const { TrendChart } = await import('../../ui/components/charts.js')
const { StatusTab } = await import('../../ui/components/tab-status.js')

const H = (level, extra = {}) => Object.assign({ level, title: S.health[level], reasons: [], nextAction: null }, extra)
const adapter = (extra = {}) =>
  Object.assign(
    {
      id: 'n1',
      name: 'アダプタ n1',
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
const detailProps = (a, extra = {}) =>
  Object.assign(
    {
      id: a.id,
      tab: 'status',
      back: false,
      detail: { status: 'ok', data: a, error: null },
      values: null,
      settings: null,
      config: null,
      logs: null,
      trend: null,
      writeReason: null,
      onAction: async () => ({ ok: true }),
      onRetry: () => {},
    },
    extra,
  )
const active = () => document.activeElement
const dialogOpen = (root) => !!$(root, 'dialog[open]')

// ---- 確認ダイアログ ----------------------------------------------------------------------

function Harness({ busy = false, onClosed, ...rest }) {
  const [open, setOpen] = useState(true)
  return html`<div>
    <button type="button" class="again" onClick=${() => setOpen(true)}>開く</button>
    <${Dialog}
      open=${open}
      title="題"
      busy=${busy}
      onClose=${() => {
        if (onClosed) onClosed()
        setOpen(false)
      }}
      onConfirm=${() => {}}
      confirmLabel="実行"
      ...${rest}
    ><p>本文</p><textarea></textarea></${Dialog}>
  </div>`
}

// 閉じるボタンに当たると、Enter 1 回で閉じる。
// 戻すと落ちるもの: dialog.js の onShown を外す・既定を閉じるボタンのままにする
test('確認ダイアログ: 開いたときのフォーカスは既定でキャンセル、initialFocus があればそこ', async () => {
  const m = await mount(html`<${Harness} />`)
  assert.ok(await until(() => textOf(active()) === S.cancel), textOf(active()))
  await m.unmount()
  const m2 = await mount(html`<${Harness} initialFocus="textarea" />`)
  assert.ok(await until(() => active() === $(m2.root, 'dialog[open] textarea')), active().localName)
  await m2.unmount()
})

// <dialog> は最前面の層に出るので、トーストは幕の下に隠れる。ダイアログの中に出さないと失敗が読めない。
test('確認ダイアログ: 操作の失敗の文は本文の下に role="alert" で出す', async () => {
  const m = await mount(html`<${Harness} error="いまは止められません。" />`)
  assert.ok(await until(() => !!$(m.root, 'dialog[open] .dialog-body [role="alert"]')))
  assert.equal(textOf($(m.root, 'dialog[open] .dialog-body [role="alert"]')), 'いまは止められません。')
  await m.unmount()
})

// 操作の無いまま続く Esc は cancel を止められず、<dialog> だけが閉じる（偽の DOM では el.close() で同じ状態を作る）。
// 戻すと落ちるもの: useModal の close のイベントを外す → 閉じたまま、結果が見えず、次に押しても開かない
test('確認ダイアログ: 送っている間にブラウザが閉じても開き直す', async () => {
  let closed = 0
  const m = await mount(html`<${Harness} busy=${true} onClosed=${() => closed++} />`)
  const dlg = $(m.root, 'dialog')
  assert.ok(await until(() => dlg.open))
  dlg.close()
  assert.equal(dlg.open, false)
  assert.ok(await until(() => dlg.open), '開き直す')
  assert.equal(closed, 0, '送っている間は閉じたことにしない')
  await m.unmount()
})

test('確認ダイアログ: 送っていないときにブラウザが閉じたら、閉じた状態にそろえて、次はまた開ける', async () => {
  let closed = 0
  const m = await mount(html`<${Harness} onClosed=${() => closed++} />`)
  const dlg = $(m.root, 'dialog')
  assert.ok(await until(() => dlg.open))
  dlg.close()
  assert.ok(await until(() => closed === 1), String(closed))
  await settle()
  assert.equal(dlg.open, false)
  click($(m.root, '.again'))
  assert.ok(await until(() => dlg.open), '状態と <dialog> がそろっていないと、ここで開かない')
  await m.unmount()
})

// 閉じてすぐ開き直すと、自分で閉じたときの close のイベントが、open を true に戻したあと・<dialog> を開き直す前に届く。
// 戻すと落ちるもの: useModal の selfClosed を外す → ブラウザに閉じられたものと取り違えて、開き直した直後に閉じる
test('確認ダイアログ: 自分で閉じたときのイベントを、ブラウザに閉じられたものと取り違えない', async () => {
  let closed = 0
  function Reopen() {
    const [open, setOpen] = useState(true)
    useEffect(() => {
      if (!open) setOpen(true)
    }, [open])
    return html`<${Dialog} open=${open} title="題" onClose=${() => {
      closed++
      if (closed < 5) setOpen(false)
    }} onConfirm=${() => {}} confirmLabel="実行"><p>本文</p></${Dialog}>`
  }
  const m = await mount(html`<${Reopen} />`)
  assert.ok(await until(() => !!buttonByText(m.root, S.cancel)))
  click(buttonByText(m.root, S.cancel))
  assert.ok(await until(() => closed === 1))
  await settle(6)
  assert.ok(await until(() => $(m.root, 'dialog').open))
  await settle(3)
  assert.equal(closed, 1)
  assert.equal($(m.root, 'dialog').open, true)
  await m.unmount()
})

// 押したボタンは送っている間 disabled になり、フォーカスが外れる。
// 戻すと落ちるもの: dialog.js の wasBusy の effect を外す
test('確認ダイアログ: 送り終えて開いたまま戻ったら、フォーカスを元の位置へ戻す', async () => {
  function Busy() {
    const [busy, setBusy] = useState(true)
    return html`<div><button type="button" class="done" onClick=${() => setBusy(false)}>終わる</button><${Dialog} open=${true} title="題" busy=${busy} onClose=${() => {}} onConfirm=${() => {}} confirmLabel="実行" initialFocus="textarea"><textarea></textarea></${Dialog}></div>`
  }
  const m = await mount(html`<${Busy} />`)
  assert.ok(await until(() => $(m.root, 'dialog').open))
  await settle()
  document.activeElement = document.body
  fire($(m.root, '.done'), 'click')
  assert.ok(await until(() => active() === $(m.root, 'dialog[open] textarea')), active().localName)
  await m.unmount()
})

// ---- 追加のモーダル ----------------------------------------------------------------------

const addProps = (extra = {}) =>
  Object.assign(
    {
      open: true,
      meta: { addAdapter: { available: true, limit: 8, count: 1 } },
      add: { variant: 'add', reason: null, limit: 8 },
      serialports: { items: [], status: 'ok', at: 1 },
      editorRoot: '/',
      onLoadSerialports: () => {},
      onAdd: async () => ({ ok: false, error: { status: 503, code: 'NOT_AVAILABLE', message: 'x' } }),
      onClose: () => {},
    },
    extra,
  )

// 戻すと落ちるもの: add-pane.js が useModal を使わない
test('追加のモーダル: 開いたときのフォーカスは先頭の欄。ブラウザに閉じられたら状態へ伝える', async () => {
  let closed = 0
  const m = await mount(html`<${AddDialog} ...${addProps({ onClose: () => closed++ })} />`)
  assert.ok(await until(() => active().getAttribute && active().getAttribute('id') === 'add-in-role'))
  $(m.root, 'dialog').close()
  assert.ok(await until(() => closed === 1), String(closed))
  await m.unmount()
})

test('追加のモーダル（エディタの手順）: フォーカスは閉じるボタンでなく、エディタを開くリンク', async () => {
  const m = await mount(html`<${AddDialog} ...${addProps({ add: { variant: 'editor', reason: null, limit: null } })} />`)
  assert.ok(await until(() => active() === $(m.root, '.add-editor a.btn')), active().localName)
  await m.unmount()
})

// 送れなくなった理由と帯の文が 3 回並んでいた。
// 戻すと落ちるもの: add-pane.js の BLOCKING_CODES を外す
test('追加のモーダル: 送れない理由は 1 か所。読み出しのみなどログインで解けない理由にはリンクを出さない', async () => {
  const reason = S.list.addReadOnly
  const m = await mount(html`<${AddDialog} ...${addProps({ add: { variant: 'add', reason, limit: 8 } })} />`)
  assert.ok(await until(() => !!$(m.root, '.add-form-wrap')))
  const wrap = $(m.root, '.add-form-wrap')
  assert.equal(textOf(wrap).split(reason).length - 1, 1)
  assert.equal(!!$(wrap, '.notice a'), false)
  await m.unmount()
  const m2 = await mount(html`<${AddDialog} ...${addProps({ add: { variant: 'add', reason: S.auth.loginRequired, limit: 8 }, loginHref: 'http://127.0.0.1:1880/' })} />`)
  assert.ok(await until(() => !!$(m2.root, '.add-form-wrap .notice a.btn')))
  assert.equal($(m2.root, '.add-form-wrap .notice a.btn').getAttribute('href'), 'http://127.0.0.1:1880/')
  await m2.unmount()
})

// ---- 詳細の操作 --------------------------------------------------------------------------

async function openStop(m) {
  click(buttonByText(m.root, S.actions.stop))
  assert.ok(await until(() => !!$(m.root, 'dialog[open] textarea')))
  const area = $(m.root, 'dialog[open] textarea')
  area.value = '点検のため'
  fire(area, 'input')
  assert.ok(await until(() => $(m.root, 'dialog[open] textarea').value === '点検のため'))
  await settle()
}

// トーストは <dialog> の幕の下に隠れ、閉じられない。
// 戻すと落ちるもの: detail-pane.js の run が失敗の文を Dialog へ渡さない
test('確認ダイアログの操作の失敗（503）: ダイアログを開いたまま中に出す。閉じて開き直すと消えている', async () => {
  const onAction = async () => ({ ok: false, error: { status: 503, code: 'NOT_RUNNING', message: 'アダプタが動いていません。' } })
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter(), { onAction })} />`)
  await openStop(m)
  fire($(m.root, 'dialog[open] form'), 'submit')
  assert.ok(await until(() => !!$(m.root, 'dialog[open] .dialog-body [role="alert"]')), '開いたまま中に出す')
  assert.equal(textOf($(m.root, 'dialog[open] .dialog-body [role="alert"]')), 'アダプタが動いていません。')
  assert.ok(await until(() => !buttonByText($(m.root, 'dialog[open]'), S.cancel).hasAttribute('disabled')))
  click(buttonByText($(m.root, 'dialog[open]'), S.cancel))
  assert.ok(await until(() => !dialogOpen(m.root)))
  click(buttonByText(m.root, S.actions.stop))
  assert.ok(await until(() => dialogOpen(m.root)))
  await settle()
  assert.equal(!!$(m.root, 'dialog[open] [role="alert"]'), false, '前の失敗を残さない')
  await m.unmount()
})

// 401 のあとはダイアログの中に手が無い（ログインの入口は帯）。設定の保存も失敗で閉じる。
// 戻すと落ちるもの: detail-pane.js の run が 401・403 でも閉じない
test('確認ダイアログの操作の失敗（401・403）: 閉じて帯と理由の文に任せる', async () => {
  for (const status of [401, 403]) {
    const onAction = async () => ({ ok: false, error: { status, code: 'X', message: S.auth.loginRequired } })
    const m = await mount(html`<${DetailPane} ...${detailProps(adapter(), { onAction })} />`)
    await openStop(m)
    fire($(m.root, 'dialog[open] form'), 'submit')
    assert.ok(await until(() => !dialogOpen(m.root)), String(status))
    await m.unmount()
  }
})

// 戻すと落ちるもの: StopDialog の initialFocus と、空で押したときの focus を外す
test('停止: 開いたら理由の欄へ。空で押すと誤りを出して欄へ戻す', async () => {
  let sent = 0
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter(), { onAction: async () => (sent++, { ok: true }) })} />`)
  click(buttonByText(m.root, S.actions.stop))
  const area = () => $(m.root, 'dialog[open] textarea')
  assert.ok(await until(() => !!area() && active() === area()), active().localName)
  $(m.root, 'dialog[open] button[type="submit"]').focus()
  fire($(m.root, 'dialog[open] form'), 'submit')
  assert.ok(await until(() => textOf($(m.root, 'dialog[open]')).includes(S.confirm.stopReasonRequired)))
  assert.equal(sent, 0)
  assert.equal(active() === area(), true, '欄へ戻す')
  await m.unmount()
})

// 欄から離れただけで誤りを出すと、ダイアログの高さが変わって［キャンセル］が動き、押しても閉じなくなる（実ブラウザの試験も見る）。
// 戻すと落ちるもの: 理由の欄の onBlur で setTouched(true) を呼ぶ
test('停止: 何も書かずに欄から離れても誤りを出さない。出すのは［停止する］を押したときだけ', async () => {
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter())} />`)
  click(buttonByText(m.root, S.actions.stop))
  const area = () => $(m.root, 'dialog[open] textarea')
  assert.ok(await until(() => !!area() && active() === area()))
  fire(area(), 'blur')
  await settle()
  assert.equal(textOf($(m.root, 'dialog[open]')).includes(S.confirm.stopReasonRequired), false)
  assert.equal(area().hasAttribute('aria-invalid'), false)
  await m.unmount()
})

// 段 3 の説明と警告の囲みが同じ文で 2 度並んでいた。
// 戻すと落ちるもの: detail-pane.js の isReset の分岐を外す
test('再接続: 開いたら選んでいるラジオへ。段 3 を選ぶと、説明は出さず警告だけにする', async () => {
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter())} />`)
  click(buttonByText(m.root, S.actions.reconnect))
  assert.ok(await until(() => active().value === 'auto'), String(active().value))
  const radio = $$(m.root, 'dialog[open] input').find((i) => i.value === '3')
  radio.checked = true
  fire(radio, 'change')
  assert.ok(await until(() => textOf($(m.root, 'dialog[open]')).includes(S.confirm.ladder3Warn)))
  const body = textOf($(m.root, 'dialog[open]'))
  assert.equal(body.split(S.confirm.ladderHints[3]).length - 1, 1, body)
  assert.ok(body.includes(S.confirm.ladder3Warn))
  await m.unmount()
})

// ---- 同じ文を重ねない --------------------------------------------------------------------

// 帯は上にあるので見出しでは省く。読むだけの欄のカードの理由は、その場に残す（帯はスクロールで消え、ボタンの title は指で読めない）。
// 戻すと落ちるもの: Header の bandReason の比べを外す
test('見出しの理由: 帯と同じ文は出さない。帯の無い止め（読み出しのみ）は出す', async () => {
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter(), { writeReason: S.auth.loginRequired, bandReason: S.auth.loginRequired })} />`)
  assert.equal(!!$(m.root, '.dhead .readonly-note'), false)
  assert.equal(buttonByText(m.root, S.actions.poll).getAttribute('title'), S.auth.loginRequired, 'ボタンの理由は残す')
  await m.unmount()
  const m2 = await mount(html`<${DetailPane} ...${detailProps(adapter(), { writeReason: S.actions.readOnlyReason })} />`)
  assert.equal(textOf($(m2.root, '.dhead .readonly-note')), S.actions.readOnlyReason)
  await m2.unmount()
})

// 戻すと落ちるもの: DetailPane の showHint を外す・StatusTab の err.hint の比べを外す
test('つながらない台: 案内の帯を出す状態タブでは、見出しの「次に」と直近のエラーの文で同じことを言わない', async () => {
  const a = adapter({
    connected: false,
    connectHint: { kind: 'no-meter' },
    lastError: { message: 'スキャンに失敗しました', hint: S.status.hintNoMeter, at: Date.now(), code: null },
    health: H('bad', { title: 'メーターが見つかりません', nextAction: S.status.hintNoMeter }),
    credentials: { configured: true, source: '環境変数' },
    port: '/dev/ttyUSB0',
  })
  const m = await mount(html`<${DetailPane} ...${detailProps(a)} />`)
  assert.ok(await until(() => !$(m.root, '.why-next')), '見出しの「次に」を外す')
  const all = textOf($(m.root, '.pane-detail'))
  assert.equal(all.split(S.status.hintNoMeter).length - 1, 1, all.slice(0, 400))
  assert.ok(all.includes('スキャンに失敗しました'), '機器の文は残す')
  await m.unmount()
  // ほかのタブでは帯が無いので、見出しの案内を残す
  const m2 = await mount(html`<${DetailPane} ...${detailProps(a, { tab: 'logs' })} />`)
  assert.ok(textOf($(m2.root, '.why-next')).includes(S.status.hintNoMeter))
  await m2.unmount()
})

const listProps = (items, extra = {}) =>
  Object.assign({ list: { status: 'ok', items, error: null, total: null }, selectedId: null, tab: 'status', editorRoot: '/', onRetry: () => {}, add: { variant: 'add', reason: null, limit: null }, onOpenAdd: () => {} }, extra)

// 戻すと落ちるもの: list-pane.js の Row が状態の欄と比べない
test('一覧の行: 状態の欄と同じ文は 2 行目に出さない。違う文は出す', async () => {
  const same = adapter({ connected: false, phaseText: 'メーターと認証中', health: H('busy', { title: 'メーターと認証中' }) })
  const m = await mount(html`<${ListPane} ...${listProps([same])} />`)
  assert.equal(!!$(m.root, '.row-why'), false)
  assert.ok(textOf($(m.root, '[data-fact="state"]')).includes('メーターと認証中'))
  await m.unmount()
  const differ = adapter({ health: H('bad', { title: 'USB が切断されています' }) })
  const m2 = await mount(html`<${ListPane} ...${listProps([differ])} />`)
  assert.equal(textOf($(m2.root, '.row-why')), 'USB が切断されています')
  await m2.unmount()
})

// 戻すと落ちるもの: ListPane の bandReason の比べを外す
test('一覧の追加ボタンの理由: 帯と同じ文は読み上げにだけ残す', async () => {
  const add = { variant: 'add', reason: S.auth.loginRequired, limit: null }
  const m = await mount(html`<${ListPane} ...${listProps([adapter()], { add, bandReason: S.auth.loginRequired })} />`)
  const why = $(m.root, '#list-add-why')
  assert.ok(why, 'ボタンの aria-describedby の先')
  assert.ok(String(why.getAttribute('class')).split(/\s+/).includes('sr-only'))
  await m.unmount()
  const m2 = await mount(html`<${ListPane} ...${listProps([adapter()], { add })} />`)
  assert.equal(String($(m2.root, '#list-add-why').getAttribute('class')).split(/\s+/).includes('sr-only'), false)
  await m2.unmount()
})

// 「エディタで追加」の手順を案内しながら、その下に「エディタが無効です」と出ていた。
// 戻すと落ちるもの: ListPane の noWay の分岐を外す・AddButton が editorRoot を見ない
test('0 台で画面からもエディタからも追加できないサーバー: 手順を案内せず、無いことを書く', async () => {
  const m = await mount(html`<${ListPane} ...${listProps([], { add: { variant: 'editor', reason: null, limit: null }, editorRoot: null })} />`)
  const text = textOf($(m.root, '.pane-list'))
  assert.ok(text.includes(S.list.emptyBodyNoWay), text)
  assert.equal(text.includes(S.list.emptyBodyEditor), false)
  assert.equal(!!$(m.root, '[data-add]'), false, '辿れない手順のボタンを出さない')
  await m.unmount()
})

// ---- 取得待ち ----------------------------------------------------------------------------

// 無効の台と止まっている台は、待っても積算は取れない。
// 戻すと落ちるもの: Kpis の waiting が enabled・running を見ない
test('積算の「取得待ち」: 動いている台だけ出す。無効の台と止まっている台は値なし', async () => {
  const energy = (root) => $(root, '[data-kpi="energy"]')
  const m = await mount(html`<${DetailPane} ...${detailProps(adapter())} />`)
  assert.ok(String(energy(m.root).getAttribute('class')).includes('kpi-wait'))
  assert.ok(textOf(energy(m.root)).startsWith('取得待ち'))
  await m.unmount()
  for (const over of [{ enabled: false }, { running: false }]) {
    const m2 = await mount(html`<${DetailPane} ...${detailProps(adapter(over))} />`)
    assert.equal(textOf(energy(m2.root)), S.none, JSON.stringify(over))
    assert.equal(String(energy(m2.root).getAttribute('class')).includes('kpi-wait'), false)
    await m2.unmount()
  }
})

// ---- メニュー ----------------------------------------------------------------------------

const menu = (extra) => html`<${Menu} label=${S.actions.more} items=${[{ key: 'a', label: S.actions.auto, onSelect: () => {} }]} ...${extra} />`

// Safari はクリックでボタンへフォーカスを移さない。行き先は無いか、tabindex の付いた親（main）になる。そこで閉じると項目を押せない。
// 戻すと落ちるもの: menu.js の onFocusOut を外す・relatedTarget が無いときや親のときも閉じる
test('メニュー: フォーカスが外へ出ると閉じる。行き先が無い・親へ移る・中で移るときは閉じない', async () => {
  const m = await mount(html`<div class="parent" tabindex="-1"><button type="button" class="outside">外</button>${menu()}</div>`)
  const list = () => $(m.root, '.menu-list')
  const opener = () => $(m.root, '.menu button[aria-haspopup]')
  click(opener())
  assert.ok(await until(() => !!list()))
  await settle()
  const item = $(m.root, '[role="menuitem"]')
  fire(item, 'focusout', { relatedTarget: null })
  await settle()
  assert.ok(list(), '行き先が分からなければ閉じない')
  fire(item, 'focusout', { relatedTarget: $(m.root, '.parent') })
  await settle()
  assert.ok(list(), 'メニューを含む親へ移っただけ')
  fire(item, 'focusout', { relatedTarget: opener() })
  await settle()
  assert.ok(list(), 'メニューの中で移っただけ')
  fire(item, 'focusout', { relatedTarget: $(m.root, '.outside') })
  assert.ok(await until(() => !list()))
  await m.unmount()
})

// ---- グラフの吹き出し --------------------------------------------------------------------

const T0 = 1_700_000_000_000
const chart = (extra = {}) => {
  const points = []
  for (let i = 0; i <= 60; i++) points.push([T0 + i * 60e3, 100 + i])
  return html`<${TrendChart} title="電力" series=${[{ key: 'p', label: '瞬時電力', cls: 'series-power', points }]} from=${T0} to=${T0 + 3600e3} format=${(v) => v + ' W'} ...${extra} />`
}
const X = 120
const X2 = 360

/** 指で触る（タップ）。ブラウザは pointerup のあとに必ず pointerleave を送る。 */
function tap(hit, offsetX) {
  fire(hit, 'pointerdown', { pointerType: 'touch', offsetX, clientX: offsetX })
  fire(hit, 'pointerup', { pointerType: 'touch', offsetX, clientX: offsetX })
  fire(hit, 'pointerleave', { pointerType: 'touch', offsetX, clientX: offsetX })
}

// 指を離した瞬間に吹き出しが消え、値が読めなかった。
// 戻すと落ちるもの: charts.js の onLeave が pointerType を見ない
test('グラフの吹き出し: 指を離しても残る。マウスは外れたら消える', async () => {
  const m = await mount(chart())
  const hit = $(m.root, '.chart-hit')
  tap(hit, X)
  assert.ok(await until(() => !!$(m.root, '.chart-tip')), '離したあとも残る')
  await settle()
  assert.ok($(m.root, '.chart-tip'), '離したあとも残る')
  await m.unmount()
  const m2 = await mount(chart())
  const hit2 = $(m2.root, '.chart-hit')
  fire(hit2, 'pointermove', { pointerType: 'mouse', offsetX: X, clientX: X })
  assert.ok(await until(() => !!$(m2.root, '.chart-tip')))
  fire($(m2.root, '.chart-hit'), 'pointerleave', { pointerType: 'mouse' })
  assert.ok(await until(() => !$(m2.root, '.chart-tip')))
  await m2.unmount()
})

// 戻すと落ちるもの: charts.js の document の pointerdown を外す
test('グラフの吹き出し: グラフの外を押すと消す', async () => {
  const m = await mount(html`<div><p class="outside">外</p>${chart()}</div>`)
  tap($(m.root, '.chart-hit'), X)
  assert.ok(await until(() => !!$(m.root, '.chart-tip')))
  await settle(2)
  fire($(m.root, '.outside'), 'pointerdown', { pointerType: 'touch' })
  assert.ok(await until(() => !$(m.root, '.chart-tip')))
  await m.unmount()
})

// 戻すと落ちるもの: charts.js の onDown の sameSpot を外す・dismissed を外す（続く pointermove で開き直す）
test('グラフの吹き出し: 同じ所をもう一度押すと消し、別の所を押すと移る', async () => {
  const m = await mount(chart())
  const hit = $(m.root, '.chart-hit')
  tap(hit, X)
  assert.ok(await until(() => !!$(m.root, '.chart-tip')))
  await settle()
  const first = textOf($(m.root, '.chart-tip'))
  tap(hit, X2)
  assert.ok(await until(() => textOf($(m.root, '.chart-tip')) !== first), '別の所へ移る')
  await settle()
  fire(hit, 'pointerdown', { pointerType: 'touch', offsetX: X2, clientX: X2 })
  assert.ok(await until(() => !$(m.root, '.chart-tip')))
  await settle()
  fire(hit, 'pointermove', { pointerType: 'touch', offsetX: X2 + 1, clientX: X2 + 1 })
  await settle(2)
  assert.equal(!!$(m.root, '.chart-tip'), false, '同じ指の揺れで開き直さない')
  fire(hit, 'pointerup', { pointerType: 'touch', offsetX: X2, clientX: X2 })
  tap(hit, X2)
  assert.ok(await until(() => !!$(m.root, '.chart-tip')), '指を離したあとは、また押せる')
  await m.unmount()
})

// 戻すと落ちるもの: charts.js の onCancel を外す
test('グラフの吹き出し: 指が縦のスクロールに変わったら残さない', async () => {
  const m = await mount(chart())
  const hit = $(m.root, '.chart-hit')
  fire(hit, 'pointerdown', { pointerType: 'touch', offsetX: X, clientX: X })
  assert.ok(await until(() => !!$(m.root, '.chart-tip')))
  fire(hit, 'pointercancel', { pointerType: 'touch' })
  fire(hit, 'pointerleave', { pointerType: 'touch' })
  assert.ok(await until(() => !$(m.root, '.chart-tip')))
  await m.unmount()
})

// 幅の狭い端末では、途切れの文は 2 行に、値は系列の名前を省いて、描ける範囲に収める。
// 戻すと落ちるもの: charts.js の tipWidth(full) <= iw の分岐を外す
test('グラフの吹き出し: 1 行に入らない幅では文を畳み、箱が範囲からはみ出さない', async () => {
  const W = 288
  const lqi = { key: 'q', label: S.values.seriesLqi, cls: 'series-lqi', points: [] }
  for (let i = 0; i <= 60; i++) lqi.points.push([T0 + i * 60e3, 60])
  const proto = Object.getPrototypeOf(document.documentElement)
  const rect = proto.getBoundingClientRect
  proto.getBoundingClientRect = function narrow() {
    return this.getAttribute && String(this.getAttribute('class')).includes('chart-wrap') ? { width: W, height: 120, top: 0, left: 0, right: W, bottom: 120 } : rect.call(this)
  }
  try {
    const m2 = await mount(html`<${TrendChart} title="LQI" series=${[lqi]} from=${T0} to=${T0 + 3600e3} format=${S.values.lqiTip} />`)
    await settle(2)
    const hit = $(m2.root, '.chart-hit')
    fire(hit, 'pointerdown', { pointerType: 'touch', offsetX: 80, clientX: 80 })
    assert.ok(await until(() => !!$(m2.root, '.chart-tip-box')))
    const box = $(m2.root, '.chart-tip-box')
    const lines = $$(m2.root, '.chart-tip-text').map(textOf)
    assert.equal(lines.some((l) => l.includes(S.values.seriesLqi)), false, lines.join(' / '))
    assert.ok(lines.some((l) => l.startsWith('LQI 60')), lines.join(' / '))
    const x = Number(box.getAttribute('x'))
    assert.ok(x >= 60 && x + Number(box.getAttribute('width')) <= W - 12, x + ' ' + box.getAttribute('width'))
    await m2.unmount()
  } finally {
    proto.getBoundingClientRect = rect
  }
})

// 値の無いグラフに「0 / 0.25 / …」の軸が出て、値があるように見えた。
// 戻すと落ちるもの: charts.js の empty の分岐を外す
test('グラフ: 値の無いグラフには軸の数を出さない', async () => {
  const m = await mount(html`<${TrendChart} title="電力" series=${[{ key: 'p', label: '瞬時電力', cls: 'series-power', points: [] }]} from=${T0} to=${T0 + 3600e3} format=${(v) => v + ' W'} />`)
  assert.equal($$(m.root, 'text.chart-axis[text-anchor="end"]').length, 0)
  assert.ok(textOf($(m.root, '.chart-empty')).includes(S.values.trendEmpty))
  await m.unmount()
})

// 状態タブを単独で描く（DetailPane を通らない呼び方でも落ちないことの確かめ）
test('状態タブ: 案内の帯が無ければ、直近のエラーは案内の文を先に出す', async () => {
  const a = adapter({ lastError: { message: '機器の文', hint: '案内の文', at: Date.now(), code: null } })
  const m = await mount(html`<${StatusTab} a=${a} />`)
  assert.equal(textOf($(m.root, '.last-error-text')), '案内の文')
  assert.ok(textOf($(m.root, '.last-error-device')).includes('機器の文'))
  await m.unmount()
})
