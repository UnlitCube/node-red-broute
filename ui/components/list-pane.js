// 左ペイン: 上に全台の合計の瞬時電力、見出しの行「アダプタ（n 台）」と
// ［＋ アダプタを追加］、下にアダプタの行。
// 行の 1 行目: [健康のアイコン][契約のバッジ] 名前の欄 …… 瞬時電力（逆潮流は「売電 −1,234 W」）。
//   名前の欄は名前を入れた台なら名前、そうでなければポートの短い名前（「[電力] USB0」）。
// 行の 2 行目: 最終受信（stale なら橙）・預かり・停止中や異常の短い理由。
// 行の 3 行目から: 2 列の小さな表（状態・瞬時電流・電波の強さ・ポート・送信積算。1 拠点あたり数台の前提で、1 台の様子が一目で分かるように）。
// 並びはサーバーの順（health の重い順 → 名前）。選んでいる行を強調する。
// 合計はサーバーの total があればそれ（無い古いサーバーは画面で数える）。
import { html, cx } from '../html.js'
import { Icon } from './icons.js'
import { HealthIcon, RoleBadge, RelTime, Loading, Empty, Failure } from './common.js'
import { S } from '../strings.js'
import { formatAmps, formatPower, healthLabel, isNum } from '../format.js'
import { listTotal } from '../store.js'
import { detailHref } from '../route.js'
import { shortReason, nameSlot } from '../adapter-view.js'
import { lqiLevel, pendingView } from '../status-view.js'

/** 瞬時電力。stale のときは古い印を付ける（全台の合計に入れていない値。合計の「n 台は…除いています」と対応させる） */
export function PowerText({ watts, stale }) {
  const p = formatPower(watts)
  return html`<span
    class=${cx('power', 'num', p.exporting && 'power-export', stale && 'tone-text-stale')}
    title=${stale ? S.list.powerStaleTitle : undefined}
    data-power-stale=${stale ? '1' : undefined}
  >${p.full}</span>`
}

function Total({ list }) {
  const tp = listTotal(list)
  return html`<section class="total" aria-label=${S.list.totalPower}>
    <div class="total-head">
      <span class="total-label">${S.list.totalPower}</span>
      ${tp.count ? html`<${PowerText} watts=${tp.sum} />` : html`<span class="muted">${S.list.totalPowerNone}</span>`}
    </div>
    ${tp.count || tp.staleCount
      ? html`<p class="total-note muted">
          ${tp.count ? html`<span>${S.list.totalPowerNote(tp.count, tp.total)}</span>` : null}
          ${tp.staleCount
            ? html`<span class="tone-text-stale"><${Icon} name="stale" size=${13} /><span>${S.list.totalPowerStale(tp.staleCount)}</span></span>`
            : null}
        </p>`
      : null}
  </section>`
}

/** 2 列の 1 枠に省略なしで入る文字数（左ペインがいちばん狭い 320px の幅で測った値）。 */
const FACT_SLOT_CHARS = 7

/**
 * 行の小さな表の項目（純関数。無効の台は状態とポートだけ）。
 * wide は 2 列分を使う項目。1 枠に入らない文を省略すると、段の文の末尾やポートの見分けがつかなくなる。
 */
export function rowFacts(a, slot) {
  const level = (a.health && a.health.level) || 'unknown'
  const busy = !a.connected && a.phaseText
  const stateText = level === 'busy' && busy ? a.phaseText : healthLabel(level)
  const state = { key: 'state', label: S.list.factState, text: stateText, wide: stateText.length > FACT_SLOT_CHARS }
  const portText = a.portLabel || S.none
  const port = !slot || slot.isName ? { key: 'port', label: S.list.factPort, text: portText, mono: true, wide: portText.length > FACT_SLOT_CHARS } : null
  if (a.enabled === false) return [state, port].filter(Boolean)
  const cur = a.current || {}
  const lv = lqiLevel(a.lqi)
  const hasCurrent = isNum(cur.r) || isNum(cur.t)
  const list = [
    state,
    { key: 'current', label: S.list.factCurrent, text: hasCurrent ? S.list.factCurrentValue(formatAmps(cur.r), formatAmps(cur.t)) : S.none, num: true, wide: hasCurrent },
    { key: 'signal', label: S.list.factSignal, text: lv ? lv.text : S.none, tone: lv && lv.tone === 'warn' ? 'warn' : null },
    port,
  ]
  if (isNum(a.txBudgetMs)) list.push({ key: 'tx', label: S.list.factTx, text: S.list.factTxValue(Math.round(a.txBudgetMs / 1000)), num: true, wide: true })
  return list.filter(Boolean)
}

function Row({ a, selected, tab }) {
  const pv = pendingView(a.pendingCommands, 0, 0)
  const level = (a.health && a.health.level) || 'unknown'
  const slot = nameSlot(a)
  const facts = rowFacts(a, slot)
  // 状態の欄と同じ文を 2 行目にも出さない
  const reason = shortReason(a)
  const why = facts[0].text === reason ? null : reason
  return html`<li>
    <a
      class=${cx('row', selected && 'row-on')}
      href=${detailHref(a.id, tab)}
      aria-current=${selected ? 'page' : undefined}
      data-id=${a.id}
      data-level=${level}
    >
      <${HealthIcon} health=${a.health} />
      <span class="row-main">
        <span class="row-line">
          <${RoleBadge} role=${a.role} />
          <span class=${cx('row-name', !slot.isName && 'row-name-port')} title=${!slot.isName && a.port ? a.port : undefined}>${slot.text}</span>
          <span class="row-power"><${PowerText} watts=${a.power && a.power.value} stale=${!!(a.power && a.power.fresh === false)} /></span>
        </span>
        <span class="row-line row-sub">
          <span class=${cx('row-rx', 'num', a.stale ? 'tone-text-stale' : 'muted')} title=${a.stale ? S.list.staleTitle : undefined}>
            ${a.stale ? html`<${Icon} name="stale" size=${12} />` : null}<span>${S.list.lastRx}</span> <${RelTime} at=${a.lastValueAt} />
          </span>
          ${pv && pv.count > 0
            ? html`<span class="row-pending tone-text-warn num" title=${S.list.pendingTitle(pv.count)}><${Icon} name="queue" size=${12} /><span>${S.list.pending(pv.count)}</span></span>`
            : null}
          ${why ? html`<span class="row-why">${why}</span>` : null}
        </span>
        <dl class="row-facts">
          ${facts.map(
            (f) => html`<div key=${f.key} class=${cx(f.wide && 'fact-wide')} data-fact=${f.key}><dt>${f.label}</dt><dd class=${cx(f.num && 'num', f.mono && 'mono', f.tone && 'tone-text-' + f.tone)}>${f.text}</dd></div>`,
          )}
        </dl>
      </span>
    </a>
  </li>`
}

/**
 * ［＋ アダプタを追加］（使えない環境では［エディタで追加…］）。押せないときは disabled にし、理由はボタンの下に文字で出す
 * （title だけだとタッチの画面で読めない）。add は add-view.js の addButtonState の戻り値。
 * エディタも無効なサーバーには手順を辿る先が無いので、［エディタで追加…］を出さない。
 */
function AddButton({ add, primary, editorRoot, onOpen }) {
  if (!add) return null
  if (add.variant === 'editor') {
    if (!editorRoot) return null
    return html`<button type="button" class="btn btn-sm" data-add="editor" aria-haspopup="dialog" onClick=${onOpen}>
      <${Icon} name="external" size=${14} /><span>${S.list.addInEditor}</span>
    </button>`
  }
  if (add.reason) {
    return html`<button type="button" class="btn btn-sm" data-add="add" disabled aria-describedby="list-add-why">
      <${Icon} name="plus" size=${14} /><span>${S.list.add}</span>
    </button>`
  }
  return html`<button type="button" class=${cx('btn', 'btn-sm', primary && 'btn-primary')} data-add="add" aria-haspopup="dialog" onClick=${onOpen}>
    <${Icon} name="plus" size=${14} /><span>${S.list.add}</span>
  </button>`
}

export function ListPane({ list, selectedId, tab, editorRoot, bandReason, onRetry, add, onOpenAdd }) {
  let body
  // 帯と同じ文は読み上げにだけ残す（ボタンの aria-describedby が指している）
  const why = add && add.variant === 'add' && add.reason
    ? html`<p class=${cx('list-add-why', 'hint', add.reason === bandReason && 'sr-only')} id="list-add-why">${add.reason}</p>`
    : null
  const noWay = !!add && add.variant === 'editor' && !editorRoot
  if (list.status === 'loading' || (list.status === 'idle' && !list.items)) body = html`<${Loading} />`
  else if (!list.items) body = html`<${Failure} title=${S.list.loadFailed} error=${list.error} onRetry=${onRetry} />`
  else if (!list.items.length) {
    // 0 台: 主ボタンは［アダプタを追加］、副ボタンは［エディタを開く］（editorRoot が null なら出さずに、無いことを書く）
    body = html`<${Empty}
      title=${S.list.emptyTitle}
      action=${html`<div class="empty-actions">
        <${AddButton} add=${add} primary=${true} editorRoot=${editorRoot} onOpen=${onOpenAdd} />
        ${editorRoot
          ? html`<a class="btn btn-sm" href=${editorRoot} target="_blank" rel="noopener"><${Icon} name="external" size=${14} /><span>${S.list.openEditor}</span></a>`
          : html`<p class="hint">${S.editorDisabled}</p>`}
      </div>${why}`}
    >${noWay ? S.list.emptyBodyNoWay : add && add.variant === 'editor' ? S.list.emptyBodyEditor : S.list.emptyBody}</${Empty}>`
  } else {
    body = html`<${Total} list=${list} />
      <div class="list-head">
        <h2 class="list-title">${S.list.heading(list.items.length)}</h2>
        <${AddButton} add=${add} editorRoot=${editorRoot} onOpen=${onOpenAdd} />
      </div>
      ${why}
      <ul class="rows">${list.items.map((a) => html`<${Row} key=${a.id} a=${a} selected=${a.id === selectedId} tab=${tab} />`)}</ul>`
  }
  return html`<nav class="pane pane-list" aria-label=${S.list.label}>${body}</nav>`
}
