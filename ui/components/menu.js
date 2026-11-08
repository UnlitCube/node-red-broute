// 「ほかの操作」のメニュー（ボタン + 下に開く一覧）。外を押す・Esc・フォーカスが外へ出ると閉じる。
import { html, cx, useState, useEffect, useRef } from '../html.js'
import { Icon } from './icons.js'

/**
 * items: [{key, label, icon, onSelect, reason?, tone?}]（reason があれば押せない。理由を添える）
 */
/** 一覧の幅（app.css の .menu-list と同じ: min(320px, 100vw - 32px)）。 */
const LIST_WIDTH = 320

/**
 * 一覧をボタンの右端に揃えるか左端に揃えるか。右端に揃えると画面の左からはみ出すとき（狭い幅でボタンが行の左に
 * 折り返したとき）は左端に揃える。純関数（test/ui/components.test.mjs）。
 */
export function menuAlign(buttonRect, viewportWidth) {
  const vw = viewportWidth > 0 ? viewportWidth : 0
  const w = Math.min(LIST_WIDTH, Math.max(0, vw - 32))
  return buttonRect && buttonRect.right - w >= 8 ? 'right' : 'left'
}

export function Menu({ label, icon = 'more', items }) {
  const [open, setOpen] = useState(false)
  const [align, setAlign] = useState('right')
  const root = useRef(null)
  const btn = useRef(null)

  function toggle() {
    if (!open && btn.current && typeof btn.current.getBoundingClientRect === 'function') {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0
      setAlign(menuAlign(btn.current.getBoundingClientRect(), vw))
    }
    setOpen(!open)
  }

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (root.current && !root.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        if (btn.current) btn.current.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    const first = root.current && root.current.querySelector('[role="menuitem"]:not([disabled])')
    if (first) first.focus()
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Safari はクリックでボタンへフォーカスを移さず、行き先は無いか、フォーカスできる親（tabindex の付いた main）になる。
  // そこで閉じると、項目の click の前に一覧が消えて押せない。外へ出たと言えるのは、メニューを含まない要素へ移ったときだけ
  function onFocusOut(e) {
    const to = e.relatedTarget
    if (open && to && root.current && !root.current.contains(to) && !to.contains(root.current)) setOpen(false)
  }

  function onKeyMenu(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const list = [...root.current.querySelectorAll('[role="menuitem"]:not([disabled])')]
    const i = list.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? list[(i + 1) % list.length] : list[(i - 1 + list.length) % list.length]
    if (next) next.focus()
  }

  return html`<div class="menu" ref=${root} onFocusOut=${onFocusOut}>
    <button
      type="button"
      class="btn"
      ref=${btn}
      aria-haspopup="menu"
      aria-expanded=${open ? 'true' : 'false'}
      aria-label=${label}
      onClick=${toggle}
    >
      <${Icon} name=${icon} size=${16} /><span class="menu-label">${label}</span>
    </button>
    ${open
      ? html`<div class=${cx('menu-list', align === 'left' && 'menu-list-left')} role="menu" aria-label=${label} onKeyDown=${onKeyMenu}>
          ${items.map(
            (it) => html`<button
              type="button"
              role="menuitem"
              class=${cx('menu-item', it.tone && 'tone-text-' + it.tone)}
              disabled=${!!it.reason}
              title=${it.reason || undefined}
              onClick=${() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              <${Icon} name=${it.icon || 'info'} size=${16} />
              <span class="menu-text">
                <span>${it.label}</span>
                ${it.hint || it.reason ? html`<span class="menu-hint">${it.reason || it.hint}</span>` : null}
              </span>
            </button>`,
          )}
        </div>`
      : null}
  </div>`
}
