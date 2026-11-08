// アイコン（inline SVG。外部のアイコンフォントを読まない）。線は currentColor で、文字の色に従う。
// 形はこのアプリのために描いた単純な図形（他のアイコン集の写しではない）。
import { html } from '../html.js'

const P = {
  bolt: html`<path d="M13 2 4 14h7l-1 8 9-12h-7z" />`,
  ok: html`<circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16.5 9.5" />`,
  warn: html`<path d="M12 3 2 20h20z" /><path d="M12 10v4.5" /><path d="M12 17.5h.01" />`,
  stale: html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />`,
  bad: html`<circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />`,
  stopped: html`<circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" />`,
  idle: html`<rect x="5" y="5" width="14" height="14" rx="2" />`,
  disabled: html`<circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" />`,
  busy: html`<path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" />`,
  sun: html`<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />`,
  moon: html`<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />`,
  monitor: html`<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />`,
  back: html`<path d="m15 18-6-6 6-6" />`,
  down: html`<path d="m6 9 6 6 6-6" />`,
  external: html`<path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />`,
  download: html`<path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" />`,
  search: html`<circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />`,
  play: html`<path d="M7 5v14l11-7z" />`,
  pause: html`<path d="M8 5v14M16 5v14" />`,
  stop: html`<rect x="6" y="6" width="12" height="12" rx="1.5" />`,
  refresh: html`<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5" /><path d="M20 4v4.5h-4.5" /><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5" /><path d="M4 20v-4.5h4.5" />`,
  poll: html`<path d="M3 12h4l2.5-6 5 12 2.5-6h4" />`,
  more: html`<circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" />`,
  plug: html`<path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" />`,
  signal: html`<path d="M4 20v-3M9 20v-7M14 20v-11M19 20V4" />`,
  radioOff: html`<path d="M5 12a7 7 0 0 1 2-5M19 12a7 7 0 0 0-2-5" /><path d="M8.5 12a3.5 3.5 0 0 1 1-2.5M15.5 12a3.5 3.5 0 0 0-1-2.5" /><circle cx="12" cy="12" r="1" /><path d="m4 4 16 16" />`,
  hand: html`<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11" /><path d="M10 10V5a1.5 1.5 0 0 1 3 0v5" /><path d="M13 10V6a1.5 1.5 0 0 1 3 0v6" /><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L4 15.2a1.6 1.6 0 0 1 2.4-2L8 15" />`,
  chip: html`<rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />`,
  key: html`<circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" />`,
  info: html`<circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><path d="M12 7.5h.01" />`,
  close: html`<path d="M6 6l12 12M18 6 6 18" />`,
  live: html`<circle cx="12" cy="12" r="3" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />`,
  offline: html`<path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="m4 4 16 16" />`,
  chart: html`<path d="M3 3v18h18" /><path d="m7 15 4-5 3 3 5-7" />`,
  list: html`<path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />`,
  edit: html`<path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" />`,
  lock: html`<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />`,
  code: html`<path d="m9 8-5 4 5 4M15 8l5 4-5 4" />`,
  // 状態タブ（ステッパーの済み・預かり・換算・送信積算）
  check: html`<path d="m5.5 12.5 4 4 9-9" />`,
  queue: html`<path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" /><path d="M6.5 5h11L20 13.5V19H4v-5.5z" />`,
  sliders: html`<path d="M5 4v16M12 4v16M19 4v16" /><path d="M3 15h4M10 8h4M17 13h4" />`,
  radio: html`<path d="M5 12a7 7 0 0 1 2-5M19 12a7 7 0 0 0-2-5" /><path d="M8.5 12a3.5 3.5 0 0 1 1-2.5M15.5 12a3.5 3.5 0 0 0-1-2.5" /><circle cx="12" cy="12" r="1" /><path d="M12 13v8" />`,
  // 契約のバッジ（電力 = 電球・動力 = モーター（3 枚羽根）・そのほか = タグ）と、追加の「＋」
  bulb: html`<path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />`,
  motor: html`<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="1.6" /><path d="M12 10.4V5.5M13.4 12.8l4.2 2.4M10.6 12.8l-4.2 2.4" />`,
  tag: html`<path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8" r="1.2" />`,
  plus: html`<path d="M12 5v14M5 12h14" />`,
}

/**
 * @param {{name: keyof typeof P, size?: number, label?: string}} props
 *   label があれば読み上げる（role=img）。無ければ飾り（aria-hidden）。
 */
export function Icon({ name, size = 18, label, class: cls }) {
  const body = P[name] || P.info
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true', focusable: 'false' }
  return html`<svg
    class=${'icon' + (cls ? ' ' + cls : '')}
    data-icon=${P[name] ? name : 'info'}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ...${a11y}
  >${body}</svg>`
}

export const HEALTH_ICON = {
  ok: 'ok',
  busy: 'busy',
  stale: 'stale',
  bad: 'bad',
  stopped: 'stopped',
  idle: 'idle',
  disabled: 'disabled',
}
