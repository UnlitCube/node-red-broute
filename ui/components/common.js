// 小さな共通部品（ピル・健康のアイコン・バッジ・契約のバッジ・出どころのチップ・詳細設定の折りたたみ・知らせ・相対時刻・
// 読み込み・空・失敗・理由つきのボタン）。
// 飾りを減らす（カードの入れ子・大きな余白を使わない）。
import { html, cx, useNow, useState, useEffect, useRef } from '../html.js'
import { Icon, HEALTH_ICON } from './icons.js'
import { S } from '../strings.js'
import { healthTone, healthLabel, formatRelative, formatDateTime } from '../format.js'
import { roleKind, roleBadgeText } from '../adapter-view.js'

const ROLE_ICON = { light: 'bulb', motive: 'motor', other: 'tag' }

/**
 * 契約のバッジ。角 6px・1px の枠つきのタグ（状態のピルは角丸で枠なしなので、形でも見分けられる）。
 * 電力 = --role-light と電球、動力 = --role-motive とモーター、ほか = --neutral とタグ。空なら出さない。
 * 文字は契約名そのまま。8 文字を超えたら「…」で切り、title に全文。lg は詳細の見出し（高さ 22px）。
 */
export function RoleBadge({ role, lg = false }) {
  const kind = roleKind(role)
  if (!kind) return null
  const t = roleBadgeText(role)
  return html`<span class=${cx('role-badge', 'role-' + kind, lg && 'role-badge-lg')} data-role=${kind} title=${t.cut ? t.full : S.roles.badgeTitle(t.full)}>
    <${Icon} name=${ROLE_ICON[kind]} size=${lg ? 14 : 12} />
    <span class="role-text">${t.text}</span>
  </span>`
}

/** 出どころのチップ（値が設定ノードと違う項目だけ。ラベルの横）。chip は source-view.js の sourceChip の戻り値。 */
export function SourceChip({ chip }) {
  if (!chip) return null
  return html`<span class=${cx('src-chip', 'tone-' + (chip.tone || 'accent'))} title=${chip.title || undefined} data-chip=${chip.kind}>${chip.text}</span>`
}

/** このブラウザーに保存する開閉の鍵（wsuha-broute:more:<card>）。 */
export const moreKey = (card) => 'wsuha-broute:more:' + card

function readOpen(storage, card) {
  try {
    return !!storage && storage.get(moreKey(card)) === '1'
  } catch (e) {
    return false
  }
}

/**
 * 詳細設定の折りたたみ（<details class="more">）。既定は閉じる。開閉はこのブラウザーに保存する（storage は safeStorage。
 * 無い・使えないときは保存しない）。
 * forceOpen は保存を試みるたびに変わる印（空でない文字列）。新しい印で閉じていれば開き、開いてから onOpened を呼ぶ
 * （閉じた details の中の欄にはフォーカスできないので、開いた描画のあと）。開いていれば何もしない。
 * フォーカスは保存を試みた呼び手が動かす。ここで動かすと、入力で誤りが 1 つ減るたびに入力中の欄から飛び、次のキーが別の欄に入る。
 * summary は「詳細設定」と今の値の要約、注意があれば「（n 件の注意）」。
 */
export function MoreDetails({ card, storage, summary, notes, forceOpen, onOpened, label, children }) {
  const [open, setOpen] = useState(() => readOpen(storage, card))
  const ref = useRef(null)
  const wantFocus = useRef(false)
  useEffect(() => {
    if (!forceOpen || open) return
    wantFocus.current = true
    setOpen(true)
  }, [forceOpen])
  useEffect(() => {
    if (!open || !wantFocus.current) return
    wantFocus.current = false
    if (onOpened) onOpened()
  }, [open])
  function onToggle(e) {
    const next = !!e.currentTarget.open
    if (next === open) return
    setOpen(next)
    try {
      if (storage) storage.set(moreKey(card), next ? '1' : '0')
    } catch (err) {
      /* 保存できなくても画面は動く */
    }
  }
  return html`<details class="more" data-card=${card} open=${open} onToggle=${onToggle} ref=${ref}>
    <summary class="more-summary">
      <span class="more-title">${label || S.more.title}</span>
      ${summary ? html`<span class="more-sum muted">${summary}</span>` : null}
      ${notes ? html`<span class="more-notes tone-text-warn">${S.more.notes(notes)}</span>` : null}
    </summary>
    <div class="more-body">${children}</div>
  </details>`
}

/** 健康のピル。色・アイコン・文字の 3 つで示す。詳しい文（health.title）は title 属性に。 */
export function HealthPill({ health }) {
  const level = (health && health.level) || 'unknown'
  const label = healthLabel(level)
  const title = health && health.title && health.title !== label ? health.title : undefined
  return html`<span class=${cx('pill', 'tone-' + healthTone(level))} data-level=${level} title=${title}>
    <${Icon} name=${HEALTH_ICON[level] || 'info'} size=${14} />
    <span>${label}</span>
  </span>`
}

/** 一覧の行の健康のアイコン（色とアイコン。文字は読み上げ用に添える）。 */
export function HealthIcon({ health }) {
  const level = (health && health.level) || 'unknown'
  return html`<span class=${cx('hicon', 'tone-text-' + healthTone(level))} data-level=${level}>
    <${Icon} name=${HEALTH_ICON[level] || 'info'} size=${16} label=${healthLabel(level)} />
  </span>`
}

/** 色調つきの小さなバッジ（アイコンは任意）。 */
export function Badge({ tone = 'neutral', icon, children, title }) {
  return html`<span class=${cx('badge', 'tone-' + tone)} title=${title || undefined}>
    ${icon ? html`<${Icon} name=${icon} size=${12} />` : null}
    <span>${children}</span>
  </span>`
}

/** 1 行の知らせ（帯の下・タブの上）。 */
export function Notice({ tone = 'info', icon = 'info', children, action }) {
  return html`<div class=${cx('notice', 'tone-' + tone)} role=${tone === 'danger' ? 'alert' : 'status'}>
    <${Icon} name=${icon} size=${16} />
    <div class="notice-text">${children}</div>
    ${action || null}
  </div>`
}

/** 相対時刻（1 秒ごとに描き直す）。title に絶対時刻。 */
export function RelTime({ at }) {
  const now = useNow(typeof at === 'number')
  if (typeof at !== 'number') return html`<span>${S.none}</span>`
  return html`<time datetime=${new Date(at).toISOString()} title=${formatDateTime(at)}>${formatRelative(at, now)}</time>`
}

export function Loading({ label }) {
  return html`<div class="state state-loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span><span>${label || S.loading}</span>
  </div>`
}

/** 0 件・未設定の空状態（短い文と、あれば操作）。 */
export function Empty({ title, children, action }) {
  return html`<div class="state state-empty">
    ${title ? html`<p class="state-title">${title}</p>` : null}
    ${children ? html`<p>${children}</p>` : null}
    ${action || null}
  </div>`
}

/** 取得の失敗。message は API の日本語をそのまま出す。 */
export function Failure({ title, error, onRetry }) {
  return html`<div class="state state-failure" role="alert">
    <p class="state-title tone-text-danger"><${Icon} name="bad" size=${16} /><span>${title}</span></p>
    ${error && error.message ? html`<p>${error.message}</p>` : null}
    ${onRetry ? html`<button type="button" class="btn btn-sm" onClick=${onRetry}><${Icon} name="refresh" size=${14} />${S.retry}</button>` : null}
  </div>`
}

/** 押せない理由つきのボタン。reason があれば disabled にして理由を title に出す（見える理由は呼び手が 1 か所に出す）。 */
export function ActionButton({ icon, children, onClick, reason, busy, variant = 'default', type = 'button' }) {
  const disabled = !!reason || !!busy
  return html`<button
    type=${type}
    class=${cx('btn', variant !== 'default' && 'btn-' + variant)}
    onClick=${disabled ? undefined : onClick}
    disabled=${disabled}
    title=${reason || undefined}
    aria-busy=${busy ? 'true' : undefined}
  >
    ${busy ? html`<span class="spinner spinner-sm" aria-hidden="true"></span>` : icon ? html`<${Icon} name=${icon} size=${16} />` : null}
    <span>${children}</span>
  </button>`
}
