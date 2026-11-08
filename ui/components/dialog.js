// 確認ダイアログ（<dialog> の showModal。フォーカスの閉じ込めと Esc はブラウザに任せる）。
// 何が起きるかを本文に書く。危険な操作は右端の主ボタンを danger にする。
// <dialog> は最前面の層に出るので、トーストと帯は幕の下に隠れる。操作の失敗は本文の下に出す（error）。
import { html, cx, useEffect, useRef } from '../html.js'
import { Icon } from './icons.js'
import { S } from '../strings.js'

function show(el) {
  if (typeof el.showModal === 'function') el.showModal()
  else el.setAttribute('open', '')
}

function hide(el) {
  if (typeof el.close === 'function') el.close()
  else el.removeAttribute('open')
}

/**
 * <dialog> の開閉を props の open に合わせる（確認ダイアログと追加のモーダルで同じものを使う）。
 * 操作の無いまま続く Esc は、Chromium が cancel を止めさせずに <dialog> を閉じる。open は true のままなので、
 * 放っておくと結果が見えないまま、次にボタンを押しても開かなくなる。
 * 送っている間に閉じられたら開き直し、送っていなければ閉じたものとして onClose を呼ぶ。
 * @param {{current: HTMLDialogElement|null}} ref
 * @param {{open: boolean, isBusy: () => boolean, onClose: () => void, onShown?: (el: HTMLDialogElement) => void}} opts
 *   onShown は開いた直後（開き直しも）。showModal の既定は最初のボタン（閉じる）なので、当てたい所へフォーカスを移す。
 */
export function useModal(ref, opts) {
  const latest = useRef(opts)
  latest.current = opts
  // 自分で閉じたときの close のイベントは次の番に届く。その間に開き直すと、ブラウザに閉じられたものと取り違える
  const selfClosed = useRef(false)
  const { open } = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) {
      show(el)
      if (latest.current.onShown) latest.current.onShown(el)
    } else if (!open && el.open) {
      selfClosed.current = typeof el.close === 'function'
      hide(el)
    }
  }, [open])

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const onCancel = (e) => {
      e.preventDefault()
      if (!latest.current.isBusy()) latest.current.onClose()
    }
    const onClosed = () => {
      if (selfClosed.current) {
        selfClosed.current = false
        return
      }
      const now = latest.current
      if (!now.open || el.open) return
      if (!now.isBusy()) {
        now.onClose()
        return
      }
      show(el)
      if (now.onShown) now.onShown(el)
    }
    el.addEventListener('cancel', onCancel)
    el.addEventListener('close', onClosed)
    return () => {
      el.removeEventListener('cancel', onCancel)
      el.removeEventListener('close', onClosed)
    }
  }, [])
}

/** 開いた直後のフォーカスの既定。閉じるボタンに当たると Enter 1 回で閉じ、読み上げも本文から始まらない。 */
const FOCUS_CANCEL = '.dialog-foot .btn'

/**
 * @param {{open: boolean, title: string, tone?: 'default'|'danger'|'warn', icon?: string,
 *   onClose: () => void, onConfirm?: () => void, confirmLabel?: string, confirmDisabled?: boolean,
 *   busy?: boolean, error?: string|null, initialFocus?: string, children: any}} props
 *   error は操作の失敗の文（本文の下に出す）。initialFocus は開いたときに当てる要素のセレクター（既定はキャンセル）。
 */
export function Dialog({ open, title, tone = 'default', icon, onClose, onConfirm, confirmLabel, confirmDisabled, busy, error, initialFocus = FOCUS_CANCEL, children, wide }) {
  const ref = useRef(null)
  const focusInitial = (el) => {
    const target = el.querySelector(initialFocus)
    if (target) target.focus()
  }
  useModal(ref, { open, isBusy: () => !!busy, onClose, onShown: focusInitial })

  // 押したボタンは送っている間 disabled になり、フォーカスが外れる。開いたまま戻ったら（失敗）、キーボードの続きを元の位置から始める
  const wasBusy = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (wasBusy.current && !busy && el && el.open) focusInitial(el)
    wasBusy.current = !!busy
  }, [busy])

  function submit(e) {
    e.preventDefault()
    if (!confirmDisabled && !busy && onConfirm) onConfirm()
  }

  return html`<dialog ref=${ref} class=${cx('dialog', wide && 'dialog-wide', 'dialog-' + tone)} aria-labelledby="dialog-title">
    ${open
      ? html`<form method="dialog" class="dialog-form" onSubmit=${submit}>
          <header class="dialog-head">
            ${icon ? html`<span class=${cx('dialog-icon', 'tone-' + (tone === 'default' ? 'accent' : tone))}><${Icon} name=${icon} size=${20} /></span>` : null}
            <h2 id="dialog-title" class="dialog-title">${title}</h2>
            <button type="button" class="btn-icon" onClick=${() => !busy && onClose()} aria-label=${S.close} title=${S.close}>
              <${Icon} name="close" size=${18} />
            </button>
          </header>
          <div class="dialog-body">
            ${children}
            ${error ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${error}</span></p>` : null}
          </div>
          <footer class="dialog-foot">
            <button type="button" class="btn" onClick=${() => !busy && onClose()} disabled=${busy}>${S.cancel}</button>
            ${onConfirm
              ? html`<button type="submit" class=${cx('btn', tone === 'danger' ? 'btn-danger' : tone === 'warn' ? 'btn-warn' : 'btn-primary')} disabled=${confirmDisabled || busy} aria-busy=${busy ? 'true' : undefined}>
                  ${busy ? html`<span class="spinner spinner-sm" aria-hidden="true"></span>` : null}
                  <span>${confirmLabel}</span>
                </button>`
              : null}
          </footer>
        </form>`
      : null}
  </dialog>`
}
