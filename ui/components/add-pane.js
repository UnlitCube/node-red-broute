// アダプタの追加: <dialog> の showModal で開く。フォーカスの閉じ込めと Esc はブラウザに任せる。
// - 設定タブと同じ項目の部品（form-parts.js）を使い、並びも設定タブと同じ。基本: 契約（必須）・名前（任意）・接続先・ポート（実機のとき必須）・
//   認証 ID とパスワード（任意）。詳細設定（閉じておく）: ポートを手で入力・通信速度・デバイスキー（空）・想定 MAC・自動で始める（オン）。
// - 確認ダイアログは出さない。送っている間は「追加しています…」で二度押しを止める。
// - 失敗: 422 は項目の真下（最初の誤りへフォーカス。詳細設定なら開いて）。409・403・503・500 は帯でサーバーの文。入力は残す。
//   403 CONFIG_LOCKED のあとで meta が追いつくと add.reason にも同じ趣旨の文が入るので、帯（次にすることまで書いてある）だけを残す。
//   送れなくなった理由（ログイン切れなど）は 1 か所にまとめ、［Node-RED にログイン］を添える。全画面のモーダルでは裏の帯が見えず、
//   閉じると入力を失うので、モーダルの中からログインへ行けるようにする。ログインして戻ると、入力を残したまま押せるようになる。
// - 認証の欄は DOM の中だけに置き（state・store に入れない）、やめたときと成功したときに消す。
//   シミュレーターのときは架空の値を入れ、「シミュレーター用の架空の値です（実機では使えません）」と出す。
// - Meta.addAdapter.available が false（使えない環境）なら、エディタで追加する手順の 3 行と［エディタを開く］。
import { html, cx, useState, useEffect, useRef } from '../html.js'
import { Icon } from './icons.js'
import { Loading, Notice, MoreDetails } from './common.js'
import { RoleSelect, ModeSegment, PortSelect } from './form-parts.js'
import { useModal } from './dialog.js'
import { S } from '../strings.js'
import { addFormInitial, validateAddForm, addBody, baudChoices, DEFAULT_BAUD, SIM_CRED, ADD_FIELDS, ADD_ADVANCED } from '../config-model.js'

const FIELD_ID = {
  role: 'add-in-role',
  name: 'add-in-name',
  serialport: 'add-in-serialport-pick',
  serialbaud: 'add-in-serialbaud',
  deviceKey: 'add-in-deviceKey',
  expectedMac: 'add-in-expectedMac',
  autoStart: 'add-in-autoStart',
  routeBId: 'add-cred-id',
  routeBPassword: 'add-cred-password',
}

function focusById(id) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null
  if (el && typeof el.focus === 'function') el.focus()
}

function Field({ name, label, required, hint, error, children }) {
  return html`<div class=${cx('set-row', error && 'set-row-error')} data-field=${name}>
    <div class="set-label">
      <span class="set-name-line"><span id=${'add-lbl-' + name} class="set-name">${label}</span>${required ? html`<span class="req">${S.add.required}</span>` : null}</span>
      ${hint ? html`<span id=${'add-hint-' + name} class="hint">${hint}</span>` : null}
    </div>
    <div class="set-input">
      ${children}
      ${error ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${error}</span></p>` : null}
    </div>
  </div>`
}

/** 使えない環境（Meta.addAdapter.available が false・古いサーバー）: エディタで追加する手順。 */
function EditorSteps({ meta, editorRoot }) {
  const reason = meta && meta.addAdapter && typeof meta.addAdapter.reason === 'string' ? meta.addAdapter.reason : null
  return html`<div class="add-editor" data-add="editor">
    <p class="hint">${S.add.editorLead}</p>
    ${reason ? html`<p class="readonly-note"><${Icon} name="info" size=${14} /><span>${reason}</span></p>` : null}
    <ol class="add-steps">${S.add.editorSteps.map((t, i) => html`<li key=${i}><span class="num add-step-n">${i + 1}</span><span>${t}</span></li>`)}</ol>
    ${editorRoot
      ? html`<p><a class="btn btn-primary" href=${editorRoot} target="_blank" rel="noopener"><${Icon} name="external" size=${16} /><span>${S.add.editorOpen}</span></a></p>`
      : html`<p class="hint">${S.editorDisabled}</p>`}
  </div>`
}

/** 送れない理由が add.reason に出る失敗（帯にも出すと同じ文が 2 回並ぶ）。CONFIG_LOCKED は state に映らないので帯に出す。 */
const BLOCKING_CODES = ['LOGIN_REQUIRED', 'FORBIDDEN', 'READ_ONLY']

/**
 * モーダルの中身。開くたびに作り直すので、閉じれば入力は残らない。
 * @param {{meta: object|null, add: {variant: string, reason: string|null}, serialports: object, editorRoot: string|null, loginHref?: string|null,
 *   onLoadSerialports: Function, onAdd: (body: object, form: object) => Promise<{ok: boolean, error?: object}>, onClose: Function,
 *   onBusy?: (busy: boolean) => void, nameOf?: Function}} props
 */
function AddForm({ meta, add, serialports, editorRoot, loginHref, onLoadSerialports, onAdd, onClose, onBusy, nameOf }) {
  const [form, setForm] = useState(addFormInitial)
  const [errors, setErrors] = useState({})
  const [band, setBand] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lens, setLens] = useState({ id: 0, pw: 0 })
  const [simFilled, setSimFilled] = useState(false)
  const [errTick, setErrTick] = useState(0)
  const busyRef = useRef(false)
  const idRef = useRef(null)
  const pwRef = useRef(null)
  const topRef = useRef(null)

  const readCreds = () => ({ id: (idRef.current && idRef.current.value) || '', password: (pwRef.current && pwRef.current.value) || '' })
  function wipe() {
    if (idRef.current) idRef.current.value = ''
    if (pwRef.current) pwRef.current.value = ''
  }
  // 画面を離れる（やめる・成功して移る・別の経路）ときも、認証の欄の値を残さない
  useEffect(() => () => wipe(), [])
  // ポートの候補は、開くたびに読む（USB を挿してから開いた・直前に足した台がポートを使い始めたを映す。読み直す間も前の候補を出す）
  useEffect(() => {
    if (onLoadSerialports) onLoadSerialports()
  }, [])

  const serial = form.mode !== 'simulator'
  const disabledReason = add && add.reason
  const off = busy || !!disabledReason

  function set(name, value, extra) {
    setForm((f) => Object.assign({}, f, { [name]: value }, extra || {}))
    if (errors[name]) {
      const e = Object.assign({}, errors)
      delete e[name]
      setErrors(e)
    }
  }

  function onLen() {
    const c = readCreds()
    setLens({ id: c.id.length, pw: c.password.length })
    if (errors.routeBId || errors.routeBPassword) {
      const e = Object.assign({}, errors)
      delete e.routeBId
      delete e.routeBPassword
      setErrors(e)
    }
    if (simFilled && (c.id !== SIM_CRED.id || c.password !== SIM_CRED.password)) setSimFilled(false)
  }

  // シミュレーターにしたら架空の値を入れる（空のときだけ）。実機に戻したら、架空の値のままなら消す
  function setMode(m) {
    set('mode', m)
    const c = readCreds()
    if (m === 'simulator' && !c.id && !c.password && idRef.current && pwRef.current) {
      idRef.current.value = SIM_CRED.id
      pwRef.current.value = SIM_CRED.password
      setLens({ id: SIM_CRED.id.length, pw: SIM_CRED.password.length })
      setSimFilled(true)
    } else if (m !== 'simulator' && c.id === SIM_CRED.id && c.password === SIM_CRED.password) {
      wipe()
      setLens({ id: 0, pw: 0 })
      setSimFilled(false)
    }
  }

  const advErrors = ADD_ADVANCED.filter((n) => errors[n])
  // 画面の上から見て最初の誤りの欄へ。「その他」のときは select でなく文字の欄へ
  const focusFirst = () => {
    const f = ADD_FIELDS.find((n) => errors[n])
    if (f) focusById(f === 'role' && form.roleOther ? 'add-in-role-other' : FIELD_ID[f])
  }

  // 帯は本文の先頭に出る。送るときは本文の下にいるので、見える所まで戻す（項目の誤りがあれば、続くフォーカスがそこへ移す）
  useEffect(() => {
    if ((band || disabledReason) && topRef.current && typeof topRef.current.scrollIntoView === 'function') topRef.current.scrollIntoView({ block: 'start' })
  }, [band, disabledReason])

  // 閉じた詳細設定の中の欄は、MoreDetails が開いてから（onOpened）
  useEffect(() => {
    if (errTick) focusFirst()
  }, [errTick])

  async function submit(e) {
    if (e) e.preventDefault()
    if (off || busyRef.current) return
    const creds = readCreds()
    const errs = validateAddForm(form, creds)
    setErrors(errs)
    setBand(null)
    if (Object.keys(errs).length) {
      setErrTick((n) => n + 1)
      return
    }
    busyRef.current = true
    setBusy(true)
    if (onBusy) onBusy(true)
    let r = null
    try {
      r = await onAdd(addBody(form, creds), form)
    } finally {
      busyRef.current = false
      setBusy(false)
      if (onBusy) onBusy(false)
    }
    if (r && r.ok) {
      wipe()
      return
    }
    const err = (r && r.error) || {}
    if (err.status === 422 && err.details && typeof err.details === 'object') {
      const known = {}
      for (const k of Object.keys(err.details)) if (ADD_FIELDS.includes(k)) known[k] = err.details[k]
      if (Object.keys(known).length) {
        setErrors(known)
        setErrTick((n) => n + 1)
        return
      }
    }
    const fieldOf = { PORT_IN_USE: 'serialport', DEVICE_KEY_IN_USE: 'deviceKey', PAIR_IN_USE: 'routeBId' }[err.code]
    if (fieldOf && err.message) {
      setErrors({ [fieldOf]: err.message })
      setErrTick((n) => n + 1)
    }
    if (BLOCKING_CODES.includes(err.code)) return
    setBand({ title: (S.add.errors && S.add.errors[err.code]) || S.add.failed, message: err.message || null, locked: err.code === 'CONFIG_LOCKED' })
  }

  function cancel() {
    wipe()
    if (onClose) onClose()
  }

  let body
  if (!meta) body = html`<${Loading} />`
  else if (add && add.variant === 'editor') body = html`<${EditorSteps} meta=${meta} editorRoot=${editorRoot} />`
  else {
    const aa = meta.addAdapter || {}
    const bauds = baudChoices(null, form.serialbaud)
    const hasCreds = lens.id > 0 && lens.pw > 0
    const manual = html`<input
      class="input mono"
      id="add-in-serialport"
      type="text"
      value=${form.serialport}
      disabled=${off}
      placeholder=${S.config.portPlaceholder}
      spellcheck=${false}
      autocapitalize="off"
      autocomplete="off"
      aria-label=${S.config.portManual}
      aria-invalid=${errors.serialport ? 'true' : undefined}
      onInput=${(e) => set('serialport', e.currentTarget.value)}
    />`
    body = html`<div class="add-form-wrap" data-add="form" ref=${topRef}>
      <p class="hint">${S.add.lead}</p>
      ${disabledReason && !(band && band.locked)
        ? html`<${Notice}
            tone="warn"
            icon="lock"
            action=${loginHref
              ? html`<a class="btn btn-sm" href=${loginHref} target="_blank" rel="noopener"><${Icon} name="external" size=${14} /><span>${S.auth.login}</span></a>`
              : null}
          >${disabledReason}</${Notice}>`
        : null}
      ${band
        ? html`<${Notice} tone="danger" icon="bad"><strong>${band.title}</strong>${band.message ? html`<span class="band-msg">${band.message}</span>` : null}</${Notice}>`
        : null}
      <form class="add-form card-form" onSubmit=${submit} novalidate autocomplete="off">
        <${Field} name="role" label=${S.config.fields.role} required=${true} hint=${S.config.hints.role} error=${errors.role}>
          <${RoleSelect}
            prefix="add"
            value=${form.role}
            other=${form.roleOther}
            required=${true}
            onChange=${(v, other) => set('role', v, { roleOther: !!other })}
            disabled=${off}
            invalid=${!!errors.role}
            labelledBy="add-lbl-role"
            describedBy="add-hint-role"
          />
        </${Field}>
        <${Field} name="name" label=${S.config.fields.name} hint=${S.config.hints.name} error=${errors.name}>
          <input
            class="input"
            id="add-in-name"
            type="text"
            value=${form.name}
            maxlength="100"
            disabled=${off}
            placeholder=${S.config.namePlaceholder}
            spellcheck=${false}
            autocomplete="off"
            aria-labelledby="add-lbl-name"
            aria-invalid=${errors.name ? 'true' : undefined}
            onInput=${(e) => set('name', e.currentTarget.value)}
          />
        </${Field}>
        <${Field} name="mode" label=${S.config.fields.mode} hint=${S.config.hints.mode}>
          <${ModeSegment} prefix="add" name="add-mode" value=${form.mode} onChange=${setMode} disabled=${off} labelledBy="add-lbl-mode" />
        </${Field}>
        ${serial
          ? html`<${Field} name="serialport" label=${S.config.fields.serialport} required=${true} hint=${S.config.hints.serialport} error=${errors.serialport}>
              <${PortSelect}
                id="add-in-serialport-pick"
                value=${form.serialport}
                selfId=${null}
                serialports=${serialports}
                onPick=${(v) => set('serialport', v)}
                onReload=${onLoadSerialports}
                disabled=${off}
                invalid=${!!errors.serialport}
                labelledBy="add-lbl-serialport"
                describedBy="add-hint-serialport"
                nameOf=${nameOf}
              />
            </${Field}>`
          : null}
        <${Field} name="credentials" label=${S.config.credTitle} hint=${S.config.credLead}>
          ${aa.envOverrides ? html`<${Notice} tone="warn" icon="warn">${S.add.envOverrides}</${Notice}>` : null}
          <div class="cred-fields">
            <label class="field">
              <span class="field-label">${S.config.credId}</span>
              <input class="input mono" id="add-cred-id" type="text" ref=${idRef} name="wsuha-add-route-b-id" maxlength="32" disabled=${off} autocomplete="off" autocapitalize="off" autocorrect=${false} spellcheck=${false} aria-describedby="add-cred-id-hint" aria-invalid=${errors.routeBId ? 'true' : undefined} onInput=${onLen} />
              <span class="field-hint" id="add-cred-id-hint">${S.config.credIdHint} · ${S.config.credCount(lens.id, 32)}</span>
              ${errors.routeBId ? html`<span class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${errors.routeBId}</span></span>` : null}
            </label>
            <label class="field">
              <span class="field-label">${S.config.credPassword}</span>
              <input class="input mono" id="add-cred-password" type="password" ref=${pwRef} name="wsuha-add-route-b-password" maxlength="12" disabled=${off} autocomplete="new-password" aria-describedby="add-cred-pw-hint" aria-invalid=${errors.routeBPassword ? 'true' : undefined} onInput=${onLen} />
              <span class="field-hint" id="add-cred-pw-hint">${S.config.credPasswordHint} · ${S.config.credCount(lens.pw, 12)}</span>
              ${errors.routeBPassword ? html`<span class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${errors.routeBPassword}</span></span>` : null}
            </label>
          </div>
          <p class="hint">${simFilled && !serial ? S.add.simCred : S.add.credLater}</p>
        </${Field}>
        <${MoreDetails}
          card="add"
          forceOpen=${advErrors.length ? String(errTick) : null}
          onOpened=${focusFirst}
        >
          ${serial ? html`<${Field} name="serialport-manual" label=${S.config.portManual}>${manual}</${Field}>` : null}
          ${serial
            ? html`<${Field} name="serialbaud" label=${S.config.fields.serialbaud} hint=${S.config.hints.serialbaud} error=${errors.serialbaud}>
                <select class="input select" id="add-in-serialbaud" value=${form.serialbaud} disabled=${off} aria-labelledby="add-lbl-serialbaud" onChange=${(e) => set('serialbaud', e.currentTarget.value)}>
                  ${bauds.map((b) => html`<option value=${String(b)} key=${b}>${b === DEFAULT_BAUD ? S.config.baudDefault(b) : S.config.baud(b)}</option>`)}
                </select>
              </${Field}>`
            : null}
          <${Field} name="deviceKey" label=${S.config.fields.deviceKey} hint=${S.config.hints.deviceKey} error=${errors.deviceKey}>
            <input class="input mono" id="add-in-deviceKey" type="text" value=${form.deviceKey} maxlength="32" disabled=${off} spellcheck=${false} autocapitalize="off" autocomplete="off" aria-labelledby="add-lbl-deviceKey" aria-invalid=${errors.deviceKey ? 'true' : undefined} onInput=${(e) => set('deviceKey', e.currentTarget.value)} />
          </${Field}>
          <${Field} name="expectedMac" label=${S.config.fields.expectedMac} hint=${S.config.hints.expectedMac} error=${errors.expectedMac}>
            <input class="input mono" id="add-in-expectedMac" type="text" value=${form.expectedMac} maxlength="23" disabled=${off} spellcheck=${false} autocapitalize="off" autocomplete="off" aria-labelledby="add-lbl-expectedMac" aria-invalid=${errors.expectedMac ? 'true' : undefined} onInput=${(e) => set('expectedMac', e.currentTarget.value)} />
          </${Field}>
          <${Field} name="autoStart" label=${S.config.fields.autoStart} hint=${S.config.hints.autoStart}>
            <label class="check">
              <input type="checkbox" id="add-in-autoStart" checked=${form.autoStart !== false} disabled=${off} onChange=${() => set('autoStart', form.autoStart === false)} />
              <span>${S.config.autoStartLabel}</span>
            </label>
          </${Field}>
        </${MoreDetails}>
        <p class="hint add-footer">${S.add.footer(typeof aa.tabLabel === 'string' && aa.tabLabel ? aa.tabLabel : S.add.tabLabel)}</p>
        <div class="save-bar add-bar">
          <button type="button" class="btn" disabled=${busy} onClick=${cancel}><span>${S.add.cancel}</span></button>
          <span class="tb-spacer"></span>
          <button type="submit" class="btn btn-primary" disabled=${off} aria-busy=${busy ? 'true' : undefined}>
            ${busy ? html`<span class="spinner spinner-sm" aria-hidden="true"></span><span>${S.add.sending}</span>` : html`<${Icon} name="plus" size=${16} /><span>${hasCreds ? S.add.submitConnect : S.add.submit}</span>`}
          </button>
        </div>
      </form>
    </div>`
  }
  return html`<header class="dialog-head add-head">
      <span class="dialog-icon tone-accent"><${Icon} name="plus" size=${20} /></span>
      <h2 id="add-title" class="dialog-title">${add && add.variant === 'editor' ? S.add.editorTitle : S.add.title}</h2>
      <button type="button" class="btn-icon" disabled=${busy} onClick=${cancel} aria-label=${S.close} title=${S.close}><${Icon} name="close" size=${18} /></button>
    </header>
    <div class="add-body">${body}</div>`
}

/**
 * アダプタの追加のモーダル。送っている間は閉じない（Esc・閉じるボタン）。
 * @param {{open: boolean, onClose: Function}} props ほかは AddForm の props
 */
export function AddDialog({ open, onClose, ...rest }) {
  const ref = useRef(null)
  const busyRef = useRef(false)
  useModal(ref, {
    open,
    isBusy: () => busyRef.current,
    onClose,
    // showModal は最初のボタン（閉じる）に当てる。Enter 1 回で閉じてしまい、読み上げも入力の先頭から始まらない
    onShown: (el) => {
      const first = el.querySelector('#' + FIELD_ID.role + ', .add-editor a.btn')
      if (first) first.focus()
    },
  })
  return html`<dialog ref=${ref} class="dialog dialog-add" aria-labelledby="add-title">
    ${open ? html`<${AddForm} ...${rest} onClose=${onClose} onBusy=${(b) => (busyRef.current = b)} />` : null}
  </dialog>`
}
