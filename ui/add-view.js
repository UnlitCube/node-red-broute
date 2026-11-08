// アダプタの追加の見せ方を決める純関数（DOM に触らない。test/ui/add.test.mjs）。
import { S } from './strings.js'
import { writeBlockReason, authBlockReason } from './store.js'
import { displayText } from './adapter-view.js'
import { shortPort } from './config-model.js'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * 一覧の［＋ アダプタを追加］の出し方。
 * - Meta.addAdapter が無い（古いサーバー）か available が false: ［エディタで追加…］（モーダルに手順を出す）
 * - 押せないとき（disabled。理由はボタンの下に文字で）: 読み出しのみ / ログインしていない・権限が足りない /
 *   settings.js で止めている（uiConfig・uiAddAdapter）/ 上限
 * meta をまだ読めていない間は［アダプタを追加］（モーダルが meta を待つ）。
 * @returns {{variant: 'add'|'editor', reason: string|null, limit: number|null}}
 */
export function addButtonState(state) {
  const meta = state && state.meta
  if (!meta) return { variant: 'add', reason: null, limit: null }
  const aa = meta.addAdapter && typeof meta.addAdapter === 'object' ? meta.addAdapter : null
  if (!aa || aa.available === false) return { variant: 'editor', reason: null, limit: null }
  const limit = isNum(aa.limit) ? aa.limit : null
  const blocked = writeBlockReason(state, S)
  if (blocked) return { variant: 'add', reason: blocked === authBlockReason(state, S) ? blocked : S.list.addReadOnly, limit }
  const locked = aa.locked === true || aa.uiAddAdapter === false || meta.uiAddAdapter === false || meta.configLocked === true || !!state.configLocked
  if (locked) return { variant: 'add', reason: S.list.addLocked, limit }
  const items = state.list && Array.isArray(state.list.items) ? state.list.items : null
  const count = isNum(aa.count) ? aa.count : items ? items.length : null
  if (limit !== null && count !== null && count >= limit) return { variant: 'add', reason: S.list.addLimit(limit), limit }
  return { variant: 'add', reason: null, limit }
}

/**
 * 追加したあとのトーストの名前（「動力（USB1）」）。応答の adapter があればその文の中の名前、
 * 無ければ（202 で adapter が null）入力から作る。
 */
export function addedName(adapter, form) {
  if (adapter && adapter.id) return displayText(adapter)
  const name = String((form && form.name) || '').trim()
  if (name) return name
  const role = String((form && form.role) || '').trim()
  const port = form && form.mode === 'simulator' ? S.status.modeSimulator : shortPort(form && form.serialport) || String((form && form.serialport) || '').trim()
  return role && port ? S.detail.displayName(role, port) : role || port
}
