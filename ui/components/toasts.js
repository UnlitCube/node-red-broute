// 操作の結果のトースト。成功は数秒で消え、失敗は閉じるまで残す（app.js が時間を決める）。
// action（{label, href}）があれば、別のタブで開くリンクを添える（追加したあとの［エディタで開く］）。
import { html, cx } from '../html.js'
import { Icon } from './icons.js'
import { S } from '../strings.js'

const ICON = { ok: 'ok', danger: 'bad', warn: 'warn', info: 'info' }

export function Toasts({ toasts, onDismiss }) {
  return html`<div class="toasts" aria-live="polite" aria-relevant="additions">
    ${toasts.map(
      (t) => html`<div key=${t.id} class=${cx('toast', 'tone-' + t.tone)} role=${t.tone === 'danger' ? 'alert' : 'status'}>
        <${Icon} name=${ICON[t.tone] || 'info'} size=${18} />
        <div class="toast-body">
          <strong class="toast-title">${t.title}</strong>
          ${t.body ? html`<span class="toast-text">${t.body}</span>` : null}
          ${t.action && t.action.href
            ? html`<a class="toast-action" href=${t.action.href} target="_blank" rel="noopener"><${Icon} name="external" size=${13} /><span>${t.action.label}</span></a>`
            : null}
        </div>
        <button type="button" class="btn-icon" onClick=${() => onDismiss(t.id)} aria-label=${S.close} title=${S.close}>
          <${Icon} name="close" size=${16} />
        </button>
      </div>`,
    )}
  </div>`
}
