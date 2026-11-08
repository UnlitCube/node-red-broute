// 上の帯（1 行）: 名前・全体の要約・リアルタイムの状態・版の警告・読み出しのみ・テーマ。
// ログインの画面は持たない。Node-RED の認証で変更を止めている間は、帯の下の知らせからエディタへ案内する。
import { html, cx } from '../html.js'
import { Icon } from './icons.js'
import { Notice } from './common.js'
import { S } from '../strings.js'
import { summarize } from '../store.js'
import { listHref } from '../route.js'

const LIVE = {
  connecting: { icon: 'busy', tone: 'warn', label: S.live.connecting, title: S.live.reconnectingTitle },
  live: { icon: 'live', tone: 'ok', label: S.live.live, title: S.live.liveTitle },
  reconnecting: { icon: 'busy', tone: 'warn', label: S.live.reconnecting, short: S.live.short.reconnecting, title: S.live.reconnectingTitle },
  polling: { icon: 'offline', tone: 'stale', label: S.live.polling, short: S.live.short.polling, title: S.live.pollingTitle },
  stopped: { icon: 'offline', tone: 'neutral', label: S.live.stopped, title: S.live.stoppedTitle },
}

const THEME = {
  system: { icon: 'monitor', name: S.header.themeSystem },
  light: { icon: 'sun', name: S.header.themeLight },
  dark: { icon: 'moon', name: S.header.themeDark },
}

/** リアルタイムの状態。色（tone）・アイコン（表 LIVE の icon）・文字の 3 つで示す。 */
export function LiveChip({ state }) {
  const l = LIVE[state] || LIVE.connecting
  return html`<span class=${cx('live-chip', 'tone-' + l.tone)} title=${l.title} role="status">
    <${Icon} name=${l.icon} size=${14} class=${cx('live-icon', state === 'live' && 'live-icon-on')} />
    <span class=${cx('live-label', l.short && 'live-label-long')}>${l.label}</span>
    ${l.short ? html`<span class="live-label-short">${l.short}</span>` : null}
  </span>`
}

function Count({ tone, icon, label, n }) {
  return html`<span class=${cx('count', n > 0 ? 'tone-text-' + tone : 'count-zero')} title=${label}>
    <${Icon} name=${icon} size=${14} />
    <span class="count-label">${label}</span>
    <strong class="num">${n}</strong>
  </span>`
}

/** 版のずれ（読み込んでいる版とディスクの版が違う＝入れ替えたのに再起動していない）。 */
export function versionMismatch(meta) {
  return !!(meta && meta.libVersion && meta.diskVersion && meta.libVersion !== meta.diskVersion)
}

export function TopBar({ meta, items, live, theme, onTheme }) {
  const sum = summarize(items || [])
  const t = THEME[theme] || THEME.system
  const mismatch = versionMismatch(meta)
  return html`<header class="topbar">
    <a class="brand" href=${listHref()}><${Icon} name="bolt" size=${16} /><span>${S.appName}</span></a>
    <span class="summary" role="group" aria-label=${S.header.summaryLabel}>
      <${Count} tone="ok" icon="ok" label=${S.header.summaryOk} n=${sum.ok} />
      <${Count} tone="warn" icon="warn" label=${S.header.summaryAttention} n=${sum.attention} />
      <${Count} tone="danger" icon="bad" label=${S.header.summaryBad} n=${sum.bad} />
      <${Count} tone="info" icon="stopped" label=${S.header.summaryStopped} n=${sum.stopped} />
    </span>
    <${LiveChip} state=${live} />
    ${mismatch
      ? html`<span class="tb-flag tone-text-warn" role="status" title=${S.header.restartDetail(meta.libVersion, meta.diskVersion)}>
          <${Icon} name="warn" size=${14} /><span>${S.header.restartNeeded}</span>
        </span>`
      : null}
    ${meta && meta.readOnly === true
      ? html`<span class="tb-flag tone-text-dim" title=${S.actions.readOnlyReason}><${Icon} name="lock" size=${14} /><span>${S.header.readOnly}</span></span>`
      : null}
    <span class="tb-spacer"></span>
    ${meta && meta.libVersion
      ? html`<span class="tb-ver num muted" title=${S.header.versionTitle(meta.libVersion, meta.diskVersion || S.none, meta.nodeRed || S.none)}>${S.header.version(meta.libVersion)}</span>`
      : null}
    <button type="button" class="btn-icon" onClick=${onTheme} title=${S.header.themeNow(t.name)} aria-label=${S.header.themeNow(t.name)}>
      <${Icon} name=${t.icon} size=${18} />
    </button>
  </header>`
}

/**
 * 帯の下の知らせ（リアルタイム更新が切れた・止まった・取得に失敗して表示が古い）。
 * 止まった（'stopped'）ときも「再試行」を出す（404 のあとは app.js が ?adapter= なしの SSE に作り直すので
 * ふつうは残らないが、残ったときにページの読み直しのほかに戻す手段が無い、にならないように）。
 * authReason は Node-RED の認証で変更を止めている理由。loginHref が無い（ログインできないサーバー・権限が足りない人）なら文だけ。
 */
export function Notices({ live, stale, onRetryLive, authReason, loginHref }) {
  const out = []
  if (authReason) {
    out.push(html`<${Notice}
      icon="lock"
      action=${loginHref
        ? html`<a class="btn btn-sm" href=${loginHref} target="_blank" rel="noopener"><${Icon} name="external" size=${14} /><span>${S.auth.login}</span></a>`
        : null}
    >${authReason}</${Notice}>`)
  }
  if (live === 'polling' || live === 'stopped') {
    out.push(html`<${Notice}
      tone=${live === 'polling' ? 'stale' : 'warn'}
      icon="offline"
      action=${html`<button type="button" class="btn btn-sm" onClick=${onRetryLive}><${Icon} name="refresh" size=${14} />${S.retry}</button>`}
    >${live === 'polling' ? S.banner.polling : S.banner.stopped}</${Notice}>`)
  }
  if (stale) out.push(html`<${Notice} tone="warn" icon="warn">${S.banner.loadFailed}</${Notice}>`)
  if (!out.length) return null
  return html`<div class="notices">${out}</div>`
}
