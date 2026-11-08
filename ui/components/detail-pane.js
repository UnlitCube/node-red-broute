// 右ペイン: 見出し（契約のバッジ・名前の欄・健康・理由は 1 か所・次に）・主な値の 1 行・
// 操作・5 つのタブ。
// - 見出しは「[バッジ] 名前（h1）[健康のピル][フラグ]」。名前を入れた台だけ、ポートの短い名前を小さく添える（ポートを 2 回出さない）。
// - 状態タブの「はじめに」を出すかはここで決める: 設定が足りない間（ポートが空・認証情報なし）と、
//   足りたあともこのページを開いている間はつながるまで出し続ける。つながったら消し、トースト「メーターにつながりました」。
//   出している間と、状態タブの案内の帯（connectHint）を出している間は、見出しの「次に」を出さない（同じ案内を 2 か所に出さない）。
// - 「はじめに」のボタンは設定タブへ移り、該当のカードの欄にフォーカスする（focusReq）。
// - 確認ダイアログの操作が失敗したとき: 401・403 は閉じて帯と理由の文に任せる（設定の保存と同じ）。ほかはダイアログの中に出す
//   （<dialog> の幕がトーストに掛かるので、閉じないと失敗が読めない）。
// - hidden: 1 ペインで一覧へ戻っている間。同じ台へ戻るまで設定タブだけを隠して残し、ほかは描かない。
import { html, cx, useState, useEffect, useRef } from '../html.js'
import { Icon } from './icons.js'
import { HealthPill, Badge, RoleBadge, Loading, Failure, Empty, ActionButton, RelTime } from './common.js'
import { Menu } from './menu.js'
import { Dialog } from './dialog.js'
import { PowerText } from './list-pane.js'
import { StatusTab } from './tab-status.js'
import { ValuesTab } from './tab-values.js'
import { SettingsTab } from './tab-settings.js'
import { DiagTab } from './tab-diag.js'
import { LogsTab } from './tab-logs.js'
import { S } from '../strings.js'
import { formatAmps, formatEnergy, formatInterval, healthTone, isNum } from '../format.js'
import { findValue } from '../store.js'
import { TABS, detailHref, listHref } from '../route.js'
import { headline, adapterFlags, nameSlot, displayText, currentNotPolled } from '../adapter-view.js'
import { needsOnboarding, lqiLevel, connectHintText } from '../status-view.js'

function StopDialog({ open, busy, error: failure, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const area = useRef(null)
  useEffect(() => {
    if (open) {
      setReason('')
      setTouched(false)
    }
  }, [open])
  const trimmed = reason.trim()
  const error = !trimmed ? S.confirm.stopReasonRequired : trimmed.length > 200 ? S.confirm.stopReasonTooLong : null
  return html`<${Dialog}
    open=${open}
    title=${S.confirm.stopTitle}
    icon="stop"
    tone="danger"
    busy=${busy}
    error=${failure}
    initialFocus="textarea"
    onClose=${onClose}
    onConfirm=${() => {
      setTouched(true)
      if (!error) onConfirm(trimmed)
      else if (area.current) area.current.focus()
    }}
    confirmLabel=${S.confirm.stopOk}
  >
    <p>${S.confirm.stopBody}</p>
    <label class="field">
      <span class="field-label">${S.confirm.stopReason}</span>
      <textarea
        ref=${area}
        class="input textarea"
        rows="3"
        maxlength="200"
        value=${reason}
        onInput=${(e) => setReason(e.currentTarget.value)}
        aria-invalid=${touched && error ? 'true' : undefined}
        aria-describedby="stop-reason-hint"
      ></textarea>
      <span id="stop-reason-hint" class="field-hint">${S.confirm.stopReasonHint}</span>
      ${touched && error ? html`<span class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${error}</span></span>` : null}
    </label>
  </${Dialog}>`
}

function ReconnectDialog({ open, busy, error, onClose, onConfirm, current }) {
  const [ladder, setLadder] = useState('auto')
  useEffect(() => {
    if (open) setLadder('auto')
  }, [open])
  const opts = [{ v: 'auto', label: S.confirm.ladderAuto, hint: S.confirm.ladderAutoHint }].concat(
    [0, 1, 2, 3].map((n) => ({ v: String(n), label: S.confirm.ladder(n), hint: S.confirm.ladderHints[n] })),
  )
  const isReset = ladder === '3'
  return html`<${Dialog}
    open=${open}
    title=${S.confirm.reconnectTitle}
    icon="refresh"
    tone=${isReset ? 'warn' : 'default'}
    busy=${busy}
    error=${error}
    initialFocus='input[type="radio"]:checked'
    onClose=${onClose}
    onConfirm=${() => onConfirm(ladder === 'auto' ? undefined : Number(ladder))}
    confirmLabel=${S.confirm.reconnectOk}
  >
    <p>${S.confirm.reconnectBody}</p>
    <fieldset class="choices">
      <legend class="sr-only">${S.confirm.reconnectTitle}</legend>
      ${opts.map(
        (o) => html`<label class=${cx('choice', ladder === o.v && 'choice-on')}>
          <input type="radio" name="ladder" value=${o.v} checked=${ladder === o.v} onChange=${() => setLadder(o.v)} />
          <span class="choice-text">
            <span class="choice-label">${o.label}${o.v !== 'auto' && Number(o.v) === current ? html` <span class="muted">(${S.confirm.ladderNow})</span>` : null}</span>
            ${isReset && o.v === '3' ? null : html`<span class="choice-hint">${o.hint}</span>`}
          </span>
        </label>`,
      )}
    </fieldset>
    ${isReset ? html`<p class="callout tone-warn"><${Icon} name="warn" size=${16} /><span>${S.confirm.ladder3Warn}</span></p>` : null}
  </${Dialog}>`
}

function SimpleConfirm({ open, busy, error, onClose, onConfirm, title, body, okLabel, tone = 'danger', icon = 'warn' }) {
  return html`<${Dialog} open=${open} title=${title} icon=${icon} tone=${tone} busy=${busy} error=${error} onClose=${onClose} onConfirm=${onConfirm} confirmLabel=${okLabel}>
    <p>${body}</p>
  </${Dialog}>`
}

/** 積算の行が取れているか（値か、換算前の表示がある）。 */
const hasEnergy = (r) => !!r && (isNum(r.value) || (typeof r.display === 'string' && r.display !== '' && r.display !== '—'))

/**
 * 主な値の 1 行（瞬時電力・R / T 相・積算（買電 / 売電）・最終受信・電波の強さ）。
 * 積算がまだ取れていないときは「取得待ち（5 分ごと）」を灰色で（間隔は積算の取得間隔）。
 * 無効の台と止まっている台は待っても取れないので、取得待ちとは書かない。
 * 電波の強さは「強い / ふつう / 弱い」と LQI の数の併記。
 * 瞬時電流を定期的に取りに行っていない台の R / T 相も、待っても取れないので「-」でなく理由を出す。
 */
function Kpis({ a, values, slowSec }) {
  const cur = a.current || {}
  const items = values && values.items
  const e0 = findValue(items, 'E0')
  const e3 = findValue(items, 'E3')
  const empty = !hasEnergy(e0) && !hasEnergy(e3)
  const waiting = empty && a.enabled !== false && a.running !== false
  const energy = waiting
    ? S.detail.kpi.energyWait(formatInterval(isNum(slowSec) && slowSec > 0 ? slowSec : 300))
    : empty
      ? S.none
      : `${formatEnergy(e0)} / ${formatEnergy(e3)}`
  const lqi = lqiLevel(a.lqi)
  const notPolled = currentNotPolled(a)
  const phase = (v) =>
    !isNum(v) && notPolled
      ? html`<dd class="num kpi-wait" title=${S.values.currentNotPolled}>${S.detail.kpi.notPolled}</dd>`
      : html`<dd class="num">${formatAmps(v)}</dd>`
  return html`<dl class="kpis" aria-label=${S.detail.kpi.label}>
    <div><dt>${S.detail.kpi.power}</dt><dd><${PowerText} watts=${a.power && a.power.value} stale=${!!(a.power && a.power.fresh === false)} /></dd></div>
    <div><dt>${S.detail.kpi.r}</dt>${phase(cur.r)}</div>
    <div><dt>${S.detail.kpi.t}</dt>${phase(cur.t)}</div>
    <div><dt>${S.detail.kpi.energy}</dt><dd class=${cx('num', waiting && 'kpi-wait')} data-kpi="energy">${energy}</dd></div>
    <div><dt>${S.detail.kpi.lastRx}</dt><dd class=${cx('num', a.stale && 'tone-text-stale')}><${RelTime} at=${a.lastValueAt} /></dd></div>
    <div><dt>${S.detail.kpi.lqi}</dt><dd class=${cx(lqi && lqi.tone === 'warn' && 'tone-text-warn')} title=${lqi ? lqi.title : undefined} data-kpi="lqi">${lqi ? lqi.label : S.none}</dd></div>
  </dl>`
}

function Header({ a, values, slowSec, back, writeReason, bandReason, busy, onAction, openDialog, hideNext }) {
  const ov = a.overridden || {}
  const stoppedByOverride = !!ov.stopped
  const base = writeReason || (a.enabled === false ? S.actions.disabledReason : null)
  // 止めた直後は connected が true のままなので、接続より先に止めを見る
  const pollReason = base || (stoppedByOverride ? S.actions.stoppedPollReason : !a.connected ? S.actions.notConnectedReason : null)
  const reconnectReason = base || (stoppedByOverride ? S.actions.stoppedReconnectReason : null)
  const h = headline(a)
  if (hideNext) h.next = null
  const tone = healthTone(h.level)
  const flags = adapterFlags(a)
  const slot = nameSlot(a)

  const menuItems = [
    { key: 'auto', label: S.actions.auto, icon: 'hand', hint: S.actions.autoHint, reason: base || (!ov.any ? S.actions.noOverride : null), onSelect: () => onAction('auto') },
    { key: 'terminate', label: S.actions.terminate, icon: 'stop', tone: 'danger', reason: base, onSelect: () => openDialog('terminate') },
    {
      key: 'clear',
      label: S.actions.clearRadioBlock,
      icon: 'radioOff',
      reason: base || (!a.radioBlocked ? S.actions.clearRadioNotBlocked : null),
      onSelect: () => openDialog('clearRadio'),
    },
  ]

  return html`<header class="dhead">
    ${back ? html`<a class="back-link" href=${listHref()}>${S.detail.back}</a>` : null}
    <div class="dhead-title">
      <${RoleBadge} role=${a.role} lg=${true} />
      <h1 class="dhead-name" id="detail-name" title=${!slot.isName && a.port ? a.port : undefined}>${slot.text}</h1>
      ${slot.isName ? html`<span class="muted dhead-port" title=${a.port || undefined}><${Icon} name="plug" size=${13} />${a.portLabel || a.port || S.none}</span>` : null}
      <${HealthPill} health=${a.health} />
      ${flags.map((f) => html`<${Badge} tone=${f.tone} icon=${f.icon} title=${f.title}>${f.text}</${Badge}>`)}
    </div>
    ${h.title || h.reasons.length || h.next
      ? html`<div class=${cx('why', 'edge-' + tone)}>
          ${h.title ? html`<p class=${cx('why-title', 'tone-text-' + tone)}>${h.title}</p>` : null}
          ${h.reasons.length ? html`<ul class="why-reasons" aria-label=${S.detail.reasons}>${h.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : null}
          ${h.next ? html`<p class="why-next"><span class="muted">${S.detail.next}: </span>${h.next}</p>` : null}
        </div>`
      : null}
    <${Kpis} a=${a} values=${values} slowSec=${slowSec} />
    <div class="actions" role="group" aria-label=${S.actions.label}>
      <${ActionButton} icon="poll" reason=${pollReason} busy=${busy === 'poll'} onClick=${() => onAction('poll')}>${S.actions.poll}</${ActionButton}>
      <${ActionButton} icon="refresh" reason=${reconnectReason} busy=${busy === 'reconnect'} onClick=${() => openDialog('reconnect')}>${S.actions.reconnect}</${ActionButton}>
      ${a.running && !stoppedByOverride
        ? html`<${ActionButton} icon="stop" variant="danger-ghost" reason=${base} busy=${busy === 'stop'} onClick=${() => openDialog('stop')}>${S.actions.stop}</${ActionButton}>`
        : html`<${ActionButton} icon="play" variant="primary" reason=${base} busy=${busy === 'start'} onClick=${() => onAction('start')}>${S.actions.start}</${ActionButton}>`}
      <${Menu} label=${S.actions.more} items=${menuItems} />
    </div>
    ${writeReason && writeReason !== bandReason ? html`<p class="readonly-note"><${Icon} name="lock" size=${14} /><span>${writeReason}</span></p>` : null}
  </header>`
}

/** 構成の「自動で始める」（読めていなければ null）。 */
function autoStartOf(config) {
  const f = config && config.data && config.data.fields && config.data.fields.autoStart
  return f && typeof f.value === 'boolean' ? f.value : null
}

/** 運用設定の積算の取得間隔（秒。読めていなければ null）。 */
function slowSecOf(settings) {
  const f = settings && settings.data && settings.data.fields && settings.data.fields.slowIntervalSec
  return f && isNum(f.value) ? f.value : null
}

let focusSeq = 0

export function DetailPane(props) {
  const { id, tab, detail, onAction, onRetry, writeReason, bandReason, back, values, hasItems, navigate, onToast, items, hidden = false } = props
  const [dialog, setDialog] = useState(null)
  const [dialogError, setDialogError] = useState(null)
  const [busy, setBusy] = useState(null)
  // 押している間の歯止め。state は次の描画まで古いので、同じ瞬間の 2 回目（連打・キーの繰り返し）は ref で止める
  const busyRef = useRef(null)
  // 「はじめに」: 一度出したら、このページを開いている間はつながるまで出し続ける
  const live = detail && detail.data ? detail.data : null
  const need = needsOnboarding(live)
  const connected = !!(live && live.connected)
  const [onbSticky, setOnbSticky] = useState(false)
  useEffect(() => {
    if (!live) return
    if (need && !onbSticky) setOnbSticky(true)
    else if (onbSticky && !need && connected) {
      setOnbSticky(false)
      if (onToast) onToast('ok', S.onboarding.connected)
    }
  }, [need, connected, !!live])
  const showOnb = !!live && (need || (onbSticky && !connected))
  // 状態タブの案内の帯。見出しの「次に」と同じことを言うので、帯が見えている間は見出しから外す
  const showHint = tab === 'status' && !!live && !showOnb && !!connectHintText(live.connectHint)
  // 「はじめに」のボタン: 設定タブへ移って、その欄にフォーカスする。設定タブから離れたら忘れる
  const [focusReq, setFocusReq] = useState(null)
  useEffect(() => {
    if (tab !== 'settings') setFocusReq(null)
  }, [tab])
  // 設定タブは一度開いたら隠すだけにする。タブを行き来するだけで 3 枚のカードの下書きが消えると、保存したつもりの値を失う。
  // 1 ペインの［← 一覧］とブラウザの戻るでも同じ（app.js が hidden で残す）。別の台へ移ると DetailPane ごと作り直すので、手で変えた値は持ち越さない
  const [settingsOpened, setSettingsOpened] = useState(false)
  useEffect(() => {
    if (tab === 'settings') setSettingsOpened(true)
  }, [tab])
  // 隠した要素の中に <dialog> を開いたまま残すと、見えない幕がページ全体の操作を止める
  useEffect(() => {
    if (!hidden) return
    setDialogError(null)
    setDialog(null)
  }, [hidden])

  let body
  if (!id) body = html`<${Empty}>${hasItems ? S.detail.pick : S.detail.none}</${Empty}>`
  else if (!detail || detail.status === 'loading') body = html`<${Loading} />`
  else if (detail.status === 'notFound') {
    // 一覧に戻ってきたら app.js が取り直して詳細に戻す
    body = html`${back ? html`<a class="back-link" href=${listHref()}>${S.detail.back}</a>` : null}<${Empty} title=${S.detail.notFound}>${S.detail.notFoundHint}</${Empty}>`
  } else if (!detail.data) body = html`<${Failure} title=${S.detail.loadFailed} error=${detail.error} onRetry=${onRetry} />`
  if (body) return html`<section class="pane pane-detail" hidden=${hidden}>${body}</section>`

  const a = detail.data

  function closeDialog() {
    setDialogError(null)
    setDialog(null)
  }

  async function run(action, reqBody) {
    if (busy || busyRef.current) return
    busyRef.current = action
    setBusy(action)
    setDialogError(null)
    let r = null
    try {
      r = await onAction(id, action, reqBody)
    } finally {
      busyRef.current = null
      setBusy(null)
    }
    if (!r) return
    const denied = !r.ok && r.error && (r.error.status === 401 || r.error.status === 403)
    if (r.ok || denied) setDialog(null)
    else if (dialog && r.error) setDialogError(r.error.message || S.actions.failed)
  }

  function onGoto(target) {
    setFocusReq({ target, n: ++focusSeq })
    if (navigate) navigate(detailHref(id, 'settings'))
  }
  // ポートの候補の「（「電力（USB0）」が使っています）」を、一覧の台の文の中の名前にする
  const nameOf = (otherId, name) => {
    const it = Array.isArray(items) ? items.find((x) => x && x.id === otherId) : null
    return it ? displayText(it) : name
  }

  const tabBody = {
    status: () =>
      html`<${StatusTab}
        a=${a}
        onboarding=${showOnb}
        autoStart=${autoStartOf(props.config)}
        onGoto=${onGoto}
        onAction=${(name) => run(name)}
        onDiag=${props.onDiag}
        writeReason=${writeReason}
        storage=${props.storage}
      />`,
    values: () => html`<${ValuesTab} ...${props} a=${a} />`,
    diag: () => html`<${DiagTab} ...${props} a=${a} />`,
    logs: () => html`<${LogsTab} ...${props} a=${a} />`,
  }[tab]

  return html`<section class="pane pane-detail" aria-labelledby="detail-name" hidden=${hidden}>
    ${hidden
      ? null
      : html`<${Header} a=${a} values=${values} slowSec=${slowSecOf(props.settings)} back=${back} writeReason=${writeReason} bandReason=${bandReason} busy=${busy} onAction=${run} openDialog=${setDialog} hideNext=${showOnb || showHint} />`}
    ${hidden
      ? null
      : html`<nav class="tabs" aria-label=${S.detail.tabsLabel}>
          ${TABS.map(
            (t) => html`<a class=${cx('tab', t === tab && 'tab-on')} href=${detailHref(id, t)} aria-current=${t === tab ? 'page' : undefined}>${S.detail.tabs[t]}</a>`,
          )}
        </nav>`}
    <div class="tab-body">
      ${tabBody && !hidden ? tabBody() : null}
      ${tab === 'settings' || settingsOpened
        ? html`<${SettingsTab} key=${'settings-' + id} ...${props} a=${a} focusReq=${focusReq} nameOf=${nameOf} active=${tab === 'settings' && !hidden} />`
        : null}
    </div>

    <${StopDialog} open=${dialog === 'stop'} busy=${busy === 'stop'} error=${dialogError} onClose=${closeDialog} onConfirm=${(reason) => run('stop', { reason })} />
    <${ReconnectDialog}
      open=${dialog === 'reconnect'}
      busy=${busy === 'reconnect'}
      error=${dialogError}
      current=${a.ladder}
      onClose=${closeDialog}
      onConfirm=${(ladder) => run('reconnect', ladder === undefined ? {} : { ladder })}
    />
    <${SimpleConfirm}
      open=${dialog === 'terminate'}
      busy=${busy === 'terminate'}
      error=${dialogError}
      title=${S.confirm.terminateTitle}
      body=${S.confirm.terminateBody}
      okLabel=${S.confirm.terminateOk}
      icon="stop"
      onClose=${closeDialog}
      onConfirm=${() => run('terminate')}
    />
    <${SimpleConfirm}
      open=${dialog === 'clearRadio'}
      busy=${busy === 'clear-radio-block'}
      error=${dialogError}
      title=${S.confirm.clearRadioTitle}
      body=${S.confirm.clearRadioBody}
      okLabel=${S.confirm.clearRadioOk}
      tone="warn"
      icon="radioOff"
      onClose=${closeDialog}
      onConfirm=${() => run('clear-radio-block')}
    />
  </section>`
}
