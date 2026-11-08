// 設定タブの「アダプタと接続」と「B ルートの認証 ID とパスワード」のカード。
// - 各カードの中で基本設定と <details class="more"> の詳細設定に分ける。出し分けは API の tier だけ（2 つ目の表を持たない。
//   tier の無い古いサーバーでは全部基本設定）。項目の並びは CONFIG_ORDER の順。
// - 基本設定に出どころの列は出さない。値が設定ノードと違う項目にだけ、ラベルの横にチップ。出どころの全部は詳細設定の表。
// - 保存のボタンはカードごとに 1 つ。カードの下端の全幅のバーに置き、中身を文言で言う（「接続の設定を保存…」「認証情報を保存…」）。
// - 構成の API（GET adapters/:id/config）が無い古いサーバー（404 NOT_FOUND）では、今までの読むだけの表を出す（壊れない）。
// - 保存は差分を見せて確かめてから PUT（If-Match）。確認の文は台の状態で変える。412・409 PORT_IN_USE・422 は API の message。
// - 読み出しのみ（readOnly）と CONFIG_LOCKED は configWriteReason で受け、2 つのカードを読むだけにして理由を 1 回出す。
// - 認証情報の値は、入力欄（DOM）の中にだけある。state・store・トースト・確認ダイアログ・属性に入れず、保存したら入力欄を空にする。
//   画面に出すのは「設定済み」・出どころ・PairID と、入力した桁数だけ。
import { html, cx, useState, useEffect, useRef } from '../html.js'
import { Icon } from './icons.js'
import { Loading, Failure, Notice, MoreDetails, SourceChip } from './common.js'
import { Dialog } from './dialog.js'
import { RoleSelect, ModeSegment, PortSelect } from './form-parts.js'
import { S } from '../strings.js'
import { text, formatBy, formatDateTime } from '../format.js'
import { editorNodeHref } from '../route.js'
import { sourceChip } from '../source-view.js'
import {
  CONFIG_FIELDS,
  CONFIG_ORDER,
  DEFAULT_BAUD,
  mergeConfigDraft,
  pruneConfigEdits,
  validateConfigDraft,
  diffConfigDraft,
  configValueText,
  configDraftFrom,
  configMoreSummary,
  hasConfigRecord,
  baudChoices,
  validateCredentials,
  maxLengthOf,
  isBasic,
  isCustomRole,
  reconnectNote,
} from '../config-model.js'

/** 構成の項目の入力欄の id（ラベル・ヒント・フォーカスの先）。 */
const inputId = (name) => (name === 'serialport' ? 'cfg-in-serialport-pick' : name === 'mode' ? 'cfg-in-mode-serial' : 'cfg-in-' + name)

function EditorLink({ editorRoot, id }) {
  // editorRoot が null（エディタが無効なサーバー）ならリンクを出さず、無いことを書く
  return editorRoot
    ? html`<a class="btn btn-sm" href=${editorNodeHref(editorRoot, id)} target="_blank" rel="noopener"><${Icon} name="external" size=${14} /><span>${S.settings.openEditor}</span></a>`
    : html`<span class="hint">${S.editorDisabled}</span>`
}

/** カード（見出し・右上の操作・中身）。data-card で 3 枚を見分ける。 */
export function Card({ card, section, title, icon, action, children }) {
  return html`<section class="card" data-card=${card} data-section=${section || undefined} aria-labelledby=${'card-' + card}>
    <div class="card-head">
      <h2 class="card-title" id=${'card-' + card}>${icon ? html`<${Icon} name=${icon} size=${16} />` : null}<span>${title}</span></h2>
      ${action || null}
    </div>
    ${children}
  </section>`
}

/** 構成の API が無い古いサーバー（と、config を渡さない呼び手）: 今までの読むだけの表。 */
function ReadOnlyConfig({ a, editorRoot }) {
  const dev = a.device || {}
  const cred = a.credentials || {}
  const rows = [
    [S.status.port, text(a.portLabel || a.port)],
    [S.status.deviceKey, text(a.deviceKey)],
    [S.status.macExpected, text(dev.expectedMac)],
    [S.status.credSource, text(cred.source)],
  ]
  return html`<${Card} card="connection" section="config-readonly" title=${S.settings.configTitle} icon="plug" action=${html`<${EditorLink} editorRoot=${editorRoot} id=${a.id} />`}>
    <p class="hint">${S.settings.configLead}</p>
    <table class="kv-table">
      <tbody>${rows.map(([k, v]) => html`<tr><th scope="row">${k}</th><td>${v}</td></tr>`)}</tbody>
    </table>
  </${Card}>`
}

/** 出どころの表の 1 マス: 設定ノード / 画面 / フロー（名前）（画面かフローで保存した値）/ エディタ（照合で外した）と時刻。 */
export function ConfigSourceCell({ name, field }) {
  if (!field) return html`<span class="muted">${S.none}</span>`
  const rec = hasConfigRecord(field)
  const dropped = !rec && field.by === 'editor'
  const main = rec ? formatBy(field.by) || S.config.sourceSaved : field.source === 'default' ? S.config.sourceDefault : S.config.sourceConfig
  const hint = rec ? S.config.sourceHint.saved : field.source === 'default' ? S.config.sourceHint.default : S.config.sourceHint.config
  const when = (rec || dropped) && typeof field.at === 'number' ? formatDateTime(field.at) : null
  return html`<div class="set-source">
    <span class=${cx('src', rec ? 'src-runtime' : 'src-config')} title=${hint}>${main}</span>
    ${dropped ? html`<span class="src-by"> · ${S.settings.byEditor}</span>` : null}
    ${when ? html`<span class="muted num"> · ${when}</span>` : null}
  </div>`
}

/** 詳細設定の「出どころ」の表（項目・効いている値・出どころ・設定ノードの値）。 */
function ConfigSourceTable({ names, fields }) {
  return html`<div class="table-wrap src-wrap">
    <table class="table src-table" aria-label=${S.settings.sourceTable}>
      <thead><tr><th scope="col">${S.settings.colItem}</th><th scope="col">${S.settings.colValue}</th><th scope="col">${S.settings.colSource}</th><th scope="col">${S.settings.colConfig}</th></tr></thead>
      <tbody>
        ${names.map((n) => {
          const f = fields[n]
          return html`<tr class="src-row" data-field=${n} key=${n}>
            <th scope="row">${S.config.fields[n]}</th>
            <td class="mono">${configValueText(n, f ? f.value : null)}</td>
            <td><${ConfigSourceCell} name=${n} field=${f} /></td>
            <td class="mono muted">${configValueText(n, f ? f.configValue : null)}</td>
          </tr>`
        })}
      </tbody>
    </table>
  </div>`
}

/** 1 項目の行: ラベル（とチップ）・ヒント・入力・誤り。 */
function ConfigRow({ name, chip, error, note, children }) {
  return html`<div class=${cx('set-row', error && 'set-row-error')} data-field=${name}>
    <div class="set-label">
      <span class="set-name-line"><span id=${'cfg-lbl-' + name} class="set-name">${S.config.fields[name]}</span><${SourceChip} chip=${chip} /></span>
      <span id=${'cfg-hint-' + name} class="hint">${S.config.hints[name]}</span>
    </div>
    <div class="set-input">
      ${children}
      ${error ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${error}</span></p>` : null}
      ${!error && note ? html`<p class="field-note tone-text-warn"><${Icon} name="warn" size=${14} /><span>${note}</span></p>` : null}
    </div>
  </div>`
}

/** 1 行の文字の入力欄。 */
function TextInput({ name, value, onInput, disabled, invalid, mono, placeholder, maxlength }) {
  return html`<input
    class=${cx('input', mono && 'mono')}
    id=${'cfg-in-' + name}
    type="text"
    value=${value}
    disabled=${disabled}
    placeholder=${placeholder || undefined}
    maxlength=${maxlength || undefined}
    spellcheck=${false}
    autocapitalize="off"
    autocomplete="off"
    aria-labelledby=${'cfg-lbl-' + name}
    aria-describedby=${'cfg-hint-' + name}
    aria-invalid=${invalid ? 'true' : undefined}
    onInput=${(e) => onInput(e.currentTarget.value)}
  />`
}

function Check({ name, checked, label, onChange, disabled }) {
  return html`<label class="check">
    <input type="checkbox" id=${'cfg-in-' + name} checked=${!!checked} disabled=${disabled} aria-describedby=${'cfg-hint-' + name} onChange=${() => onChange(!checked)} />
    <span>${label}</span>
  </label>`
}

/** 保存のバー（カードの下端の全幅）: 状態の文と、中身を言う主ボタン。 */
export function SaveBar({ dirty, dirtyText, cleanText, label, disabled, title, extra }) {
  return html`<div class="save-bar">
    <span class=${cx('form-state', dirty && 'tone-text-warn')}>${dirty ? dirtyText : cleanText}</span>
    <span class="tb-spacer"></span>
    ${extra || null}
    <button type="submit" class="btn btn-primary" disabled=${disabled} title=${title || undefined}><span>${label}</span></button>
  </div>`
}

function focusById(id) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null
  if (el && typeof el.focus === 'function') el.focus()
}

/**
 * 設定タブを隠すときに、開いている確認ダイアログを閉じる。隠した中の <dialog> はモーダルのまま残り、
 * 見えないのに画面全体の操作を止める（ブラウザの「戻る」でタブだけが替わったとき）。
 */
export function useCloseDialogWhenHidden(active, setDialog) {
  useEffect(() => {
    if (active === false) setDialog(null)
  }, [active])
}

/** 「B ルートの認証 ID とパスワード」の状態の 1 行。 */
export function credStateText(c) {
  if (c.envOverrides) return { text: S.config.credStateEnv, tone: 'warn', icon: 'warn' }
  if (c.configured === true && c.stored && typeof c.stored === 'object') return { text: S.config.credStateStored, tone: 'ok', icon: 'ok' }
  if (c.configured === true) return { text: S.config.credStateConfigured, tone: 'ok', icon: 'ok' }
  if (c.configured === false) return { text: S.config.credStateMissing, tone: 'danger', icon: 'bad' }
  return { text: S.none, tone: 'neutral', icon: 'info' }
}

/**
 * 認証情報のカード（書き込むだけ）。値は入力欄の DOM の中にだけ置き、state には桁数と検証の結果だけを持つ。
 * 設定済みなら欄を閉じておき、［入れ直す］で開く。focusReq が 'credentials' なら欄を開いて認証 ID にフォーカスする（はじめにの［入力する］）。
 */
function CredentialsCard({ a, cred, reason, autoStart, storage, focusReq, active, onSave, onClear }) {
  const idRef = useRef(null)
  const pwRef = useRef(null)
  const c = cred || {}
  const [lens, setLens] = useState({ id: 0, pw: 0 })
  const [errors, setErrors] = useState({})
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(c.configured !== true)
  const [errTick, setErrTick] = useState(0)
  const wantFocus = useRef(false)
  const blocked = !!reason
  const off = blocked || busy

  const read = () => ({ routeBId: (idRef.current && idRef.current.value) || '', routeBPassword: (pwRef.current && pwRef.current.value) || '' })
  function clearInputs() {
    if (idRef.current) idRef.current.value = ''
    if (pwRef.current) pwRef.current.value = ''
  }
  function wipe() {
    clearInputs()
    setLens({ id: 0, pw: 0 })
  }
  // 別の台へ移る・タブを閉じるときも、入力欄の値を残さない（ブラウザの「戻る」のフォームの復元に残さない）
  useEffect(() => () => clearInputs(), [])

  // 消したあとなど、未設定になったら欄を開く（設定済みのときだけ閉じておく）
  useEffect(() => {
    if (c.configured === false) setOpen(true)
  }, [c.configured])

  useCloseDialogWhenHidden(active, setDialog)

  // 誤りの欄へ。確認ダイアログが閉じたあとに動かす（開いている間は外の欄にフォーカスできない）
  useEffect(() => {
    if (!errTick) return
    if (errors.routeBId) focusById('cfg-cred-id')
    else if (errors.routeBPassword) focusById('cfg-cred-password')
  }, [errTick])

  // はじめにの［入力する］・［認証 ID とパスワードを入れ直す］: 欄を開いてフォーカス
  useEffect(() => {
    if (!focusReq || focusReq.target !== 'credentials') return
    wantFocus.current = true
    if (!open) setOpen(true)
    else {
      wantFocus.current = false
      focusById('cfg-cred-id')
    }
  }, [focusReq])
  useEffect(() => {
    if (!open || !wantFocus.current) return
    wantFocus.current = false
    focusById('cfg-cred-id')
  }, [open])

  function onLen() {
    const v = read()
    setLens({ id: v.routeBId.length, pw: v.routeBPassword.length })
    if (Object.keys(errors).length) setErrors({})
  }

  function askSave(e) {
    if (e) e.preventDefault()
    const v = read()
    const errs = validateCredentials(v.routeBId, v.routeBPassword)
    setErrors(errs)
    if (Object.keys(errs).length) {
      setErrTick((n) => n + 1)
      return
    }
    setDialog('save')
  }

  async function save() {
    const v = read()
    setBusy(true)
    const r = await onSave(v)
    setBusy(false)
    setDialog(null)
    if (r && r.ok) {
      wipe()
      setErrors({})
      setOpen(false)
    } else if (r && r.error && r.error.status === 422) {
      const d = (r.error.details && typeof r.error.details === 'object' && r.error.details) || {}
      setErrors({ routeBId: d.routeBId || null, routeBPassword: d.routeBPassword || null, form: d.routeBId || d.routeBPassword ? null : r.error.message })
      setErrTick((n) => n + 1)
    } else if (r && r.error && r.error.message && r.error.status === 409) {
      setErrors({ form: r.error.message })
    }
  }

  async function clear() {
    setBusy(true)
    const r = await onClear()
    setBusy(false)
    setDialog(null)
    if (r && r.ok) wipe()
  }

  // 設定済みの台で［入れ直す］をやめる。入れかけた値は残さない
  function cancelEntry() {
    wipe()
    setErrors({})
    setOpen(false)
  }

  const st = credStateText(c)
  // 画面かフローで保存した値があるか（credentials.stored: {by, at} | null）。stored を返さないサーバーでは「消す」をいつも出す
  const knowsStored = Object.prototype.hasOwnProperty.call(c, 'stored')
  const stored = c.stored && typeof c.stored === 'object' ? c.stored : null
  const canClear = !knowsStored || !!stored
  const err = (k) => (errors[k] ? html`<span class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${errors[k]}</span></span>` : null)
  const summary = [c.pairId ? S.config.credPairId + ' ' + c.pairId : null, c.source || null].filter(Boolean).join(S.more.sep)
  return html`<${Card} card="credentials" title=${S.config.credTitle} icon="key">
    <form class="cred-form card-form" onSubmit=${askSave} novalidate autocomplete="off">
      <p class=${cx('cred-state', 'tone-text-' + st.tone)} data-state=${st.tone}><${Icon} name=${st.icon} size=${16} /><span>${st.text}</span></p>
      <p class="hint">${S.config.credLead}</p>
      ${open
        ? html`<div class="cred-fields">
            <label class="field">
              <span class="field-label">${S.config.credId}</span>
              <input
                class="input mono"
                id="cfg-cred-id"
                type="text"
                ref=${idRef}
                name="wsuha-route-b-id"
                maxlength="32"
                disabled=${off}
                autocomplete="off"
                autocapitalize="off"
                autocorrect=${false}
                spellcheck=${false}
                aria-describedby="cfg-cred-id-hint"
                aria-invalid=${errors.routeBId ? 'true' : undefined}
                onInput=${onLen}
              />
              <span class="field-hint" id="cfg-cred-id-hint">${S.config.credIdHint} · ${S.config.credCount(lens.id, 32)}</span>
              ${err('routeBId')}
            </label>
            <label class="field">
              <span class="field-label">${S.config.credPassword}</span>
              <input
                class="input mono"
                id="cfg-cred-password"
                type="password"
                ref=${pwRef}
                name="wsuha-route-b-password"
                maxlength="12"
                disabled=${off}
                autocomplete="new-password"
                aria-describedby="cfg-cred-pw-hint"
                aria-invalid=${errors.routeBPassword ? 'true' : undefined}
                onInput=${onLen}
              />
              <span class="field-hint" id="cfg-cred-pw-hint">${S.config.credPasswordHint} · ${S.config.credCount(lens.pw, 12)}</span>
              ${err('routeBPassword')}
            </label>
            ${c.configured === true
              ? html`<p><button type="button" class="btn btn-sm cred-cancel" disabled=${busy} onClick=${cancelEntry}><span>${S.config.credCancel}</span></button></p>`
              : null}
          </div>`
        : html`<p><button type="button" class="btn btn-sm cred-reenter" disabled=${blocked} title=${reason || undefined} onClick=${() => setOpen(true)}>
            <${Icon} name="edit" size=${14} /><span>${S.config.credReenter}</span>
          </button></p>`}
      ${errors.form ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${errors.form}</span></p>` : null}
      <${MoreDetails} card="credentials" storage=${storage} summary=${summary}>
        <table class="kv-table">
          <tbody>
            <tr><th scope="row">${S.config.credPairId}</th><td class="mono">${text(c.pairId)}</td></tr>
            <tr><th scope="row">${S.config.credSource}</th><td>${text(c.source)}</td></tr>
            ${knowsStored
              ? html`<tr><th scope="row">${S.config.credStored}</th><td>${stored ? S.config.credStoredYes(formatBy(stored.by), typeof stored.at === 'number' ? formatDateTime(stored.at) : null) : S.config.credStoredNo}</td></tr>`
              : null}
          </tbody>
        </table>
        <p class="hint">${S.config.credPrecedence}</p>
        ${canClear
          ? html`<p><button type="button" class="btn" disabled=${off} title=${reason || undefined} onClick=${() => setDialog('clear')}><span>${S.config.credClear}</span></button></p>`
          : null}
      </${MoreDetails}>
      <${SaveBar}
        dirty=${lens.id > 0 || lens.pw > 0}
        dirtyText=${S.config.dirty}
        cleanText=${S.config.noChanges}
        label=${S.config.credSave}
        disabled=${off || !open || (!lens.id && !lens.pw)}
        title=${reason}
      />
    </form>
    <${Dialog} open=${dialog === 'save'} title=${S.config.credSaveTitle} icon="edit" tone="warn" busy=${busy} onClose=${() => setDialog(null)} onConfirm=${save} confirmLabel=${S.config.credSaveOk}>
      <p>${S.config.credSaveBody}</p>
      <p class="callout tone-warn"><${Icon} name="warn" size=${16} /><span>${reconnectNote(a, autoStart)}</span></p>
      ${c.envOverrides ? html`<p class="callout tone-warn"><${Icon} name="warn" size=${16} /><span>${S.config.credEnvOverrides}</span></p>` : null}
    </${Dialog}>
    <${Dialog} open=${dialog === 'clear'} title=${S.config.credClearTitle} icon="warn" tone="danger" busy=${busy} onClose=${() => setDialog(null)} onConfirm=${clear} confirmLabel=${S.config.credClearOk}>
      <p>${S.config.credClearBody}</p>
    </${Dialog}>
  </${Card}>`
}

/** 「アダプタと接続」のカード（構成の 10 項目）。 */
function ConnectionCard({ a, data, serialports, reason, editorRoot, storage, focusReq, active, nameOf, onSaveConfig, onResetConfig, onReloadConfig, onLoadSerialports }) {
  // 手で変えた項目（edits）・変え始めたときの rev（baseRev）・契約の select で「その他」を選んだか（roleMode）。
  // 続けて 2 つの欄に入れても前の入力を落とさないよう、1 つの state で関数で更新する
  const [work, setWork] = useState({ edits: {}, baseRev: null, roleMode: null })
  const { edits, baseRev } = work
  const [serverErrors, setServerErrors] = useState({})
  const [conflict, setConflict] = useState(null)
  const [formError, setFormError] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  // 誤りが出るたびに増やす（最初の誤りの欄へフォーカスする。詳細設定の欄なら開いてから）
  const [errTick, setErrTick] = useState(0)

  const draft = mergeConfigDraft(data, edits)
  const roleOther = work.roleMode === 'other' || (work.roleMode === null && isCustomRole(draft.role))
  const diff = diffConfigDraft(draft, data)
  const dirty = diff.changes.length > 0

  // 手で変えた値がサーバーの値と同じになったら、変えていない扱いに戻す（運用設定と同じ）
  useEffect(() => {
    if (baseRev === null || dirty) return
    setWork((w) => ({ edits: {}, baseRev: null, roleMode: w.roleMode === 'other' ? 'other' : null }))
  }, [data, dirty, baseRev])

  // ポートの候補は、設定タブを開くたびに読む（USB を挿した・ほかの台が使い始めたを映す。読み直す間も前の候補を出す）
  useEffect(() => {
    if (onLoadSerialports && active !== false) onLoadSerialports()
  }, [active])

  useCloseDialogWhenHidden(active, setDialog)

  // はじめにの［ポートを選ぶ］: ポートの欄へフォーカス
  useEffect(() => {
    if (focusReq && focusReq.target === 'serialport') focusById(draft.mode === 'simulator' ? 'cfg-in-mode-serial' : 'cfg-in-serialport-pick')
  }, [focusReq])

  const blocked = !!reason
  const off = blocked || busy
  const clientErrors = validateConfigDraft(draft, data, { roleOther })
  const errors = Object.assign({}, tried ? clientErrors : {}, serverErrors)
  const remoteChanged = baseRev !== null && data.rev !== baseRev && dirty
  const fields = data.fields || {}
  const serial = draft.mode !== 'simulator'
  const serverDraft = configDraftFrom(data)
  // 無いときだけ出す（シミュレーターではポートと速度を出さない）
  const shown = (n) => serial || (n !== 'serialport' && n !== 'serialbaud')
  const basic = CONFIG_ORDER.filter((n) => shown(n) && isBasic(data, n))
  const advanced = CONFIG_ORDER.filter((n) => shown(n) && !isBasic(data, n))
  // ポートの手入力は、ポートが基本設定なら詳細設定に、ポートが詳細設定ならその行の中に
  const manualInAdvanced = serial && isBasic(data, 'serialport')
  const chipOf = (n) => sourceChip(fields[n], { config: true, valueText: (v) => configValueText(n, v) })
  const advErrors = advanced.filter((n) => errors[n])
  // 項目の数を出す（同じ項目に出どころと誤りの両方があっても 1 件）
  const notes = new Set([...advanced.filter((n) => chipOf(n)), ...advErrors]).size
  // 画面の上から見て最初の誤りの欄へ。「その他」のときは select でなく文字の欄へ
  const focusFirst = () => {
    const first = basic.concat(advanced).find((n) => errors[n])
    if (first) focusById(first === 'role' && roleOther ? 'cfg-in-role-other' : inputId(first))
  }

  // 確認ダイアログが閉じたあとに動かす。閉じた詳細設定の中の欄は、MoreDetails が開いてから（onOpened）
  useEffect(() => {
    if (errTick) focusFirst()
  }, [errTick])

  function forget() {
    setWork({ edits: {}, baseRev: null, roleMode: null })
    setServerErrors({})
    setFormError(null)
    setTried(false)
  }

  function clearError(name) {
    if (serverErrors[name] || formError) {
      setServerErrors((prev) => {
        const e = Object.assign({}, prev)
        delete e[name]
        return e
      })
      setFormError(null)
    }
  }

  function set(name, value, roleMode) {
    setWork((w) => {
      const next = pruneConfigEdits(Object.assign({}, w.edits, { [name]: value }), data)
      const any = Object.keys(next).length > 0
      return { edits: next, baseRev: any ? (w.baseRev === null ? data.rev : w.baseRev) : null, roleMode: roleMode === undefined ? w.roleMode : roleMode }
    })
    clearError(name)
  }

  function reload() {
    forget()
    setConflict(null)
    if (onReloadConfig) onReloadConfig()
  }

  function askSave(e) {
    if (e) e.preventDefault()
    setTried(true)
    if (Object.keys(clientErrors).length) {
      setErrTick((n) => n + 1)
      return
    }
    if (!dirty) return
    setDialog('save')
  }

  // 無効の帯の［有効にする］: 有効に印を付けて、保存の確認を開く
  function enableNow() {
    set('enabled', true)
    setTried(true)
    setDialog('save')
  }

  function failedSave(err) {
    if (!err) return
    if (err.status === 412) setConflict(err.message || S.config.conflict)
    else if (err.status === 409 && err.code === 'PORT_IN_USE') {
      // ポートの行が見えていればその下に、シミュレーターで隠れていれば帯に（message はそのまま）
      if (serial) {
        setServerErrors(Object.assign({}, serverErrors, { serialport: err.message }))
        setErrTick((n) => n + 1)
      } else setFormError(err.message)
    } else if (err.status === 422) {
      const d = err.details && typeof err.details === 'object' ? err.details : {}
      const known = {}
      for (const k of Object.keys(d)) if (CONFIG_FIELDS.includes(k)) known[k] = d[k]
      setServerErrors(known)
      if (!Object.keys(known).length) setFormError(err.message)
      else setErrTick((n) => n + 1)
    } else if (err.status === 409 && err.message) setFormError(err.message)
  }

  async function save() {
    setBusy(true)
    const r = await onSaveConfig(diff.patch, baseRev || data.rev)
    setBusy(false)
    setDialog(null)
    if (r && r.ok) forget()
    else if (r) failedSave(r.error)
  }

  async function reset() {
    setBusy(true)
    const r = await onResetConfig(baseRev || data.rev)
    setBusy(false)
    setDialog(null)
    if (r && r.ok) forget()
    else if (r) failedSave(r.error)
  }

  const hasRecord = CONFIG_FIELDS.some((n) => hasConfigRecord(fields[n]))
  const reloadButton = html`<button type="button" class="btn btn-sm" onClick=${reload}><${Icon} name="refresh" size=${14} />${S.reload}</button>`
  const row = (name, input, note) => html`<${ConfigRow} key=${name} name=${name} chip=${chipOf(name)} error=${errors[name]} note=${note}>${input}</${ConfigRow}>`
  const textRow = (name, opts = {}) =>
    row(name, html`<${TextInput} name=${name} value=${draft[name]} onInput=${(v) => set(name, v)} disabled=${off} invalid=${!!errors[name]} ...${opts} />`)
  const bauds = baudChoices(data, draft.serialbaud)
  const manual = html`<input
    class="input mono"
    id="cfg-in-serialport"
    type="text"
    value=${draft.serialport}
    disabled=${off}
    placeholder=${S.config.portPlaceholder}
    spellcheck=${false}
    autocapitalize="off"
    autocomplete="off"
    aria-label=${S.config.portManual}
    aria-describedby="cfg-hint-serialport"
    aria-invalid=${errors.serialport ? 'true' : undefined}
    onInput=${(e) => set('serialport', e.currentTarget.value)}
  />`
  const devMac = a.device && a.device.mac ? String(a.device.mac) : null

  const render = {
    role: () =>
      row(
        'role',
        html`<${RoleSelect}
          prefix="cfg"
          value=${draft.role}
          other=${roleOther}
          onChange=${(v, other) => set('role', v, other ? 'other' : 'preset')}
          disabled=${off}
          invalid=${!!errors.role}
          labelledBy="cfg-lbl-role"
          describedBy="cfg-hint-role"
        />`,
      ),
    name: () => textRow('name', { maxlength: maxLengthOf(data, 'name') || 100, placeholder: S.config.namePlaceholder }),
    mode: () =>
      row(
        'mode',
        html`<${ModeSegment} prefix="cfg" name=${'cfg-mode-' + a.id} value=${draft.mode} onChange=${(m) => set('mode', m)} disabled=${off} labelledBy="cfg-lbl-mode" />
          ${serial ? null : html`<p class="hint">${S.config.simulatorNoPort}</p>`}`,
      ),
    serialport: () =>
      row(
        'serialport',
        html`<${PortSelect}
            id="cfg-in-serialport-pick"
            value=${draft.serialport}
            selfId=${a.id}
            serialports=${serialports}
            onPick=${(v) => set('serialport', v)}
            onReload=${onLoadSerialports}
            disabled=${off}
            invalid=${!!errors.serialport}
            labelledBy="cfg-lbl-serialport"
            describedBy="cfg-hint-serialport"
            nameOf=${nameOf}
          />
          ${manualInAdvanced ? null : manual}`,
      ),
    enabled: () => row('enabled', html`<${Check} name="enabled" checked=${draft.enabled} label=${S.config.enabledLabel} onChange=${(v) => set('enabled', v)} disabled=${off} />`),
    autoStart: () => row('autoStart', html`<${Check} name="autoStart" checked=${draft.autoStart} label=${S.config.autoStartLabel} onChange=${(v) => set('autoStart', v)} disabled=${off} />`),
    serialbaud: () =>
      row(
        'serialbaud',
        html`<select class="input select" id="cfg-in-serialbaud" value=${draft.serialbaud} disabled=${off} aria-labelledby="cfg-lbl-serialbaud" aria-describedby="cfg-hint-serialbaud" onChange=${(e) => set('serialbaud', e.currentTarget.value)}>
          ${draft.serialbaud === '' ? html`<option value="">${S.none}</option>` : null}
          ${bauds.map((b) => html`<option value=${String(b)} key=${b}>${b === DEFAULT_BAUD ? S.config.baudDefault(b) : S.config.baud(b)}</option>`)}
        </select>`,
      ),
    deviceKey: () => textRow('deviceKey', { mono: true, maxlength: maxLengthOf(data, 'deviceKey') || 32 }),
    expectedMac: () =>
      row(
        'expectedMac',
        html`<div class="input-with-btn">
          <${TextInput} name="expectedMac" value=${draft.expectedMac} onInput=${(v) => set('expectedMac', v)} disabled=${off} invalid=${!!errors.expectedMac} mono maxlength=${23} />
          <button type="button" class="btn btn-sm" disabled=${off || !devMac} onClick=${() => set('expectedMac', devMac)}><span>${S.config.macFromDevice}</span></button>
        </div>`,
      ),
    scanDurations: () => textRow('scanDurations', { mono: true, placeholder: '4,5,6,7,8', maxlength: 64 }),
  }

  const tableNames = CONFIG_ORDER.filter(shown)
  return html`<${Card} card="connection" section="config" title=${S.config.title} icon="plug" action=${html`<${EditorLink} editorRoot=${editorRoot} id=${a.id} />`}>
    ${blocked ? html`<p class="readonly-note"><${Icon} name="lock" size=${14} /><span>${reason}</span></p>` : null}
    ${conflict
      ? html`<${Notice} tone="danger" icon="warn" action=${reloadButton}>${conflict}</${Notice}>`
      : remoteChanged
        ? html`<${Notice} tone="warn" icon="info" action=${reloadButton}>${S.config.updatedElsewhere}</${Notice}>`
        : null}
    ${formError ? html`<${Notice} tone="danger" icon="bad">${formError}</${Notice}>` : null}
    ${data.applying ? html`<${Notice} tone="info" icon="busy">${S.config.applying}</${Notice}>` : null}
    ${(data.warnings || []).filter((w) => !(typeof w === 'string' && w.indexOf(S.config.credEnvWarningMarker) >= 0)).map((w) => html`<${Notice} tone="warn" icon="warn">${w}</${Notice}>`)}

    <form class="settings-form config-form card-form" onSubmit=${askSave} novalidate>
      ${serverDraft.enabled === false
        ? html`<div class="disabled-band" role="status">
            <${Icon} name="disabled" size=${16} /><span>${S.config.disabledBand}</span>
            <button type="button" class="btn btn-sm" disabled=${off} onClick=${enableNow}><span>${S.config.enableNow}</span></button>
          </div>`
        : null}
      ${basic.map((n) => render[n]())}
      <${MoreDetails}
        card="connection"
        storage=${storage}
        summary=${configMoreSummary(draft)}
        notes=${notes}
        forceOpen=${advErrors.length ? String(errTick) : null}
        onOpened=${focusFirst}
      >
        ${manualInAdvanced
          ? html`<div class=${cx('set-row', errors.serialport && 'set-row-error')} data-field="serialport-manual">
              <div class="set-label"><span class="set-name">${S.config.portManual}</span></div>
              <div class="set-input">${manual}</div>
            </div>`
          : null}
        ${advanced.map((n) => render[n]())}
        <h3 class="more-sub">${S.settings.sourceTable}</h3>
        <${ConfigSourceTable} names=${tableNames} fields=${fields} />
        ${hasRecord
          ? html`<p><button type="button" class="btn" disabled=${off} title=${reason || undefined} onClick=${() => setDialog('reset')}><span>${S.config.reset}</span></button></p>`
          : null}
      </${MoreDetails}>
      <${SaveBar} dirty=${dirty} dirtyText=${S.config.dirty} cleanText=${S.config.noChanges} label=${S.config.save} disabled=${off || !dirty} title=${reason} />
    </form>

    <${Dialog}
      open=${dialog === 'save'}
      title=${S.config.saveTitle}
      icon="edit"
      tone=${diff.reconnect || diff.disabling ? 'warn' : 'default'}
      busy=${busy}
      onClose=${() => setDialog(null)}
      onConfirm=${save}
      confirmLabel=${S.config.saveOk}
    >
      <p>${S.config.saveBody}</p>
      <table class="table diff-table">
        <thead><tr><th scope="col"></th><th scope="col">${S.confirm.from}</th><th scope="col">${S.confirm.to}</th></tr></thead>
        <tbody>
          ${diff.changes.map((c) => html`<tr key=${c.field}><th scope="row">${c.label}</th><td class="mono muted">${c.from}</td><td class="mono"><strong>${c.to}</strong></td></tr>`)}
        </tbody>
      </table>
      ${diff.reconnect ? html`<p class="callout tone-warn"><${Icon} name="warn" size=${16} /><span>${reconnectNote(a, draft.autoStart)}</span></p>` : null}
      ${diff.disabling ? html`<p class="callout tone-warn"><${Icon} name="warn" size=${16} /><span>${S.config.disableWarn}</span></p>` : null}
    </${Dialog}>
    <${Dialog} open=${dialog === 'reset'} title=${S.config.resetTitle} icon="refresh" tone="warn" busy=${busy} onClose=${() => setDialog(null)} onConfirm=${reset} confirmLabel=${S.config.resetOk}>
      <p>${S.config.resetBody}</p>
    </${Dialog}>
  </${Card}>`
}

/**
 * 設定タブの「アダプタと接続」と「B ルートの認証 ID とパスワード」の 2 枚。props は SettingsTab のもの（a・config・serialports・
 * configWriteReason・editorRoot・storage・focusReq・items・onSaveConfig・onResetConfig・onReloadConfig・onLoadSerialports・
 * onSaveCredentials・onClearCredentials）。
 * config を渡さない呼び手・構成の API が無いサーバー（unsupported）は、今までの読むだけの表。
 */
export function ConfigSection(props) {
  const { a, config, editorRoot, onReloadConfig } = props
  if (config === undefined || config === null || config.status === 'unsupported') return html`<${ReadOnlyConfig} a=${a} editorRoot=${editorRoot} />`
  if (!config.data) {
    return html`<${Card} card="connection" section="config" title=${S.config.title} icon="plug" action=${html`<${EditorLink} editorRoot=${editorRoot} id=${a.id} />`}>
      ${config.status === 'error'
        ? html`<${Failure} title=${S.config.loadFailed} error=${config.error} onRetry=${onReloadConfig} />`
        : html`<${Loading} />`}
    </${Card}>`
  }
  const data = config.data
  const reason = props.configWriteReason || props.writeReason || (data.locked ? data.lockedReason || S.config.lockedReason : null)
  const cred = data.credentials || a.credentials || {}
  const autoStart = configDraftFrom(data).autoStart
  return html`<${ConnectionCard}
      a=${a}
      data=${data}
      serialports=${props.serialports}
      reason=${reason}
      editorRoot=${editorRoot}
      storage=${props.storage}
      focusReq=${props.focusReq}
      active=${props.active}
      nameOf=${props.nameOf}
      onSaveConfig=${props.onSaveConfig}
      onResetConfig=${props.onResetConfig}
      onReloadConfig=${onReloadConfig}
      onLoadSerialports=${props.onLoadSerialports}
    />
    <${CredentialsCard}
      a=${a}
      cred=${cred}
      reason=${reason}
      autoStart=${autoStart}
      storage=${props.storage}
      focusReq=${props.focusReq}
      active=${props.active}
      onSave=${props.onSaveCredentials}
      onClear=${props.onClearCredentials}
    />`
}
