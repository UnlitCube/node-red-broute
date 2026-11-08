// 設定タブ: 3 枚のカードをこの順に並べる。
//   「アダプタと接続」・「B ルートの認証 ID とパスワード」（config-section.js）・「計測」（このファイル。運用設定 4 項目）。
// - 各カードの中で基本設定と <details class="more"> の詳細設定。出し分けは API の tier だけ（tier の無い古いサーバーは全部基本設定）。
//   「定期的に取りに行く値」は、よく使う 4 つ（E7・E8・E0・E3）を基本設定に、ほかを詳細設定の閉じた「ほかの値」に。
// - 基本設定に出どころの列は出さない。値が設定ノードと違う項目にだけチップ。出どころの全部は詳細設定の表。
// - 保存は差分を見せて確かめてから PUT（If-Match）。412 なら「ほかの場所で先に変更されました」。
// - タブの末尾に 1 行だけ: 同じことはフローの入力（settings・config・credentials）とエディタの設定ノードでもできる。
// - options が無い（古いサーバー）ときは今までの記号のチップ（EpcChips）。
//
// 下書き: 手で変えた項目（edits）だけを持ち、触っていない項目はいつもサーバーの今の値を出す。
//   - rev が同じまま一時的な上書き（source が override）の値だけ変わっても、触っていない項目は「変更があります」にならない。
//   - 「読み直す」は edits を捨てるだけなので、届いた新しい値がそのまま出る（1 回で効く）。
// 検証: 差分に入る項目だけ。触っていない項目が範囲の外なら注意を出すだけで、保存は止めない。
import { html, cx, useState, useEffect, useRef } from '../html.js'
import { Icon } from './icons.js'
import { Loading, Failure, Notice, MoreDetails, SourceChip } from './common.js'
import { Dialog } from './dialog.js'
import { ConfigSection, Card, SaveBar, useCloseDialogWhenHidden } from './config-section.js'
import { S } from '../strings.js'
import { formatInterval, formatEpc, epcName, formatDateTime, formatBy, normEpc } from '../format.js'
import { FIELDS, mergeDraft, pruneEdits, validateDraft, untouchedNotes, diffDraft, epcCandidates, rangeOf, epcOptionGroups, epcOptionsOf, epcLabel, splitEpcOptions } from '../settings-model.js'
import { isBasic } from '../config-model.js'
import { sourceChip, hasRuntimeRecord } from '../source-view.js'

export { hasRuntimeRecord }

const isSet = (v) => v !== null && v !== undefined

function fmtValue(name, v, options) {
  if (!isSet(v)) return S.none
  if (name === 'pollEpcs') {
    const list = Array.isArray(v) ? v : [v]
    return (options ? list.map((e) => epcLabel(e, options)).join(S.listSep) : list.map(formatEpc).join(' ')) || S.none
  }
  return typeof v === 'number' ? formatInterval(v) : String(v)
}

/** 設定ノードの値。空（null・空の配列）なら「未設定」（「設定ノード: -」では読めない）。 */
function fmtConfigValue(name, v, options) {
  if (!isSet(v) || (Array.isArray(v) && !v.length)) return S.settings.unset
  return fmtValue(name, v, options)
}

/** 出どころの表の 1 マス: 出どころの名前・変えた経路・時刻（運用設定のとき・エディタで運用設定を外したとき）。 */
export function SourceCell({ name, field }) {
  if (!field) return html`<span class="muted">${S.none}</span>`
  const src = field.source
  const rec = hasRuntimeRecord(field)
  // EPC は options があれば名前で（「瞬時電力（E7）」）
  const options = name === 'pollEpcs' && Array.isArray(field.options) && field.options.length ? field.options : null
  // エディタで運用設定を外した項目（source は config / default、by は 'editor'）も、外した経路と時刻を出す
  const dropped = !rec && field.by === 'editor'
  const by = rec || dropped ? formatBy(field.by) : null
  const when = (rec || dropped) && typeof field.at === 'number' ? formatDateTime(field.at) : null
  // 上書きの下にある運用設定（上書きが外れたら効く）。runtimeValue があれば値も出す（古いサーバーは経路と時刻だけ）
  const under = src === 'override' && rec
  const underValue = under && isSet(field.runtimeValue) ? fmtValue(name, field.runtimeValue, options) : null
  return html`<div class="set-source">
    <span class=${cx('src', 'src-' + src)} title=${S.settings.sourceHint[src] || undefined}>${S.settings.source[src] || String(src)}</span>
    ${under ? html`<span class="src-by" title=${S.settings.sourceHint.runtime}> · ${S.settings.runtimeUnder(underValue, by, when)}</span>` : null}
    ${!under && by ? html`<span class="src-by"> · ${by}</span>` : null}
    ${!under && when ? html`<span class="muted num"> · ${when}</span>` : null}
  </div>`
}

/** 設定ノードの値と既定の値（出どころの表の右の列）。 */
function BaseCell({ name, field }) {
  if (!field) return html`<span class="muted">${S.none}</span>`
  const options = name === 'pollEpcs' && Array.isArray(field.options) && field.options.length ? field.options : null
  return html`<div class="set-base">${S.settings.configValue(fmtConfigValue(name, field.configValue, options))} · ${S.settings.defaultValue(fmtValue(name, field.default, options))}</div>`
}

function SourceTable({ fields }) {
  return html`<div class="table-wrap src-wrap">
    <table class="table src-table" aria-label=${S.settings.sourceTable}>
      <thead><tr><th scope="col">${S.settings.colItem}</th><th scope="col">${S.settings.colValue}</th><th scope="col">${S.settings.colSource}</th><th scope="col">${S.settings.colConfig}</th></tr></thead>
      <tbody>
        ${FIELDS.map((n) => {
          const f = fields[n]
          const options = n === 'pollEpcs' && f && Array.isArray(f.options) && f.options.length ? f.options : null
          return html`<tr class="src-row" data-field=${n} key=${n}>
            <th scope="row">${S.settings.fields[n]}</th>
            <td>${fmtValue(n, f ? f.value : null, options)}</td>
            <td><${SourceCell} name=${n} field=${f} /></td>
            <td class="muted"><${BaseCell} name=${n} field=${f} /></td>
          </tr>`
        })}
      </tbody>
    </table>
  </div>`
}

function SecondsInput({ name, value, onInput, disabled, range, invalid }) {
  const n = Number(value)
  return html`<span class="input-unit">
    <input
      class="input input-num"
      id=${'in-' + name}
      type="number"
      inputmode="numeric"
      min=${range.min}
      max=${range.max}
      step="1"
      value=${value}
      disabled=${disabled}
      aria-labelledby=${'lbl-' + name}
      aria-describedby=${'hint-' + name}
      aria-invalid=${invalid ? 'true' : undefined}
      onInput=${(e) => onInput(e.currentTarget.value)}
    />
    <span>${S.settings.secUnit}</span>
    ${Number.isInteger(n) && n >= 60 ? html`<span class="muted">= ${formatInterval(n)}</span>` : null}
    <span class="muted">(${S.settings.range(range.min, range.max)})</span>
  </span>`
}

function EpcChips({ selected, onChange, disabled, supported, max }) {
  const { list, fromMeter } = epcCandidates(supported, selected)
  const full = selected.length >= max
  function toggle(e) {
    if (selected.includes(e)) onChange(selected.filter((x) => x !== e))
    else if (!full) onChange(selected.concat([e]))
  }
  return html`<div class="epc-picker">
    <div class="chips" role="group" aria-labelledby="lbl-pollEpcs">
      ${list.map((e) => {
        const on = selected.includes(e)
        const blocked = !on && full
        return html`<button
          type="button"
          class=${cx('chip', on && 'chip-on')}
          aria-pressed=${on ? 'true' : 'false'}
          disabled=${disabled || blocked}
          title=${blocked ? S.settings.epcTooMany : epcName(e) || undefined}
          onClick=${() => toggle(e)}
        ><span class="mono">${e}</span></button>`
      })}
    </div>
    <p class="hint">${S.settings.epcSelected(selected.length)} · ${fromMeter ? S.settings.epcFromMeter : S.settings.epcDefault}</p>
  </div>`
}

/** EPC のチェックの一覧（名前・小さな記号・短い説明。メーターが持っていない値は薄く選べない）。 */
function EpcPick({ items, selected, onToggle, disabled, full, label }) {
  return html`<div class="epc-opts" role="group" aria-label=${label}>
    ${items.map((o) => {
      const on = selected.includes(o.epc)
      const na = o.supported === false
      const blocked = !on && (full || na)
      const title = !on && na ? S.settings.epcUnsupportedTitle : !on && full ? S.settings.epcTooMany : undefined
      const desc = o.desc || (o.unit ? S.settings.epcUnit(o.unit) : '')
      return html`<label class=${cx('epc-opt', on && 'epc-opt-on', na && 'epc-opt-off')} data-epc=${o.epc} title=${title} key=${o.epc}>
        <input type="checkbox" checked=${on} disabled=${disabled || blocked} aria-describedby=${desc ? 'epc-d-' + o.epc : undefined} onChange=${() => onToggle(o.epc)} />
        <span class="epc-opt-main"><span class="epc-opt-name">${o.name}</span><span class="epc-code mono">${o.epc}</span></span>
        ${desc ? html`<span class="epc-desc" id=${'epc-d-' + o.epc}>${desc}</span>` : null}
        ${na ? html`<span class="epc-na">${S.settings.epcUnsupported}</span>` : null}
      </label>`
    })}
  </div>`
}

/** 最初から開いておくまとまり（ほかは選んでいる値があるときだけ開く。メーターの情報・そのほかは数が多い）。 */
const EPC_OPEN_GROUPS = ['common', 'scheduled', 'selected']

/**
 * 「定期的に取りに行く値」をまとまり（よく使う / 定時の積算 / メーターの情報）ごとのチェックの一覧で選ぶ。
 * メーターが持っていない値（supported === false）は薄く「このメーターは持っていません」。選んでいなければ選べない（外すのはできる）。
 */
/** shownElsewhere: ほかの所（基本設定のよく使う値）に出している EPC。「今の値（一覧に無いもの）」に二重に出さない。 */
function EpcOptions({ options, selected, onToggle, disabled, full, shownElsewhere = [] }) {
  const groups = epcOptionGroups(options, selected.filter((e) => !shownElsewhere.includes(e)))
  // まとまりの開閉は、そのまとまりを最初に描いたときだけ決める（あとは利用者の開閉のまま。値を外した・描き直したで勝手に閉じない）
  const firstOpen = useRef({})
  const isOpen = (g) => {
    if (!Object.prototype.hasOwnProperty.call(firstOpen.current, g.group)) {
      firstOpen.current[g.group] = EPC_OPEN_GROUPS.includes(g.group) || g.items.some((o) => selected.includes(o.epc))
    }
    return firstOpen.current[g.group]
  }
  return html`<div class="epc-groups" role="group" aria-labelledby="lbl-pollEpcs">
    ${groups.map((g) => {
      const label = S.settings.epcGroups[g.group] || S.settings.epcGroupOther
      const on = g.items.filter((o) => selected.includes(o.epc)).length
      return html`<details class="epc-group" key=${g.group} data-group=${g.group} open=${isOpen(g)}>
        <summary class="epc-group-title"><span class="epc-group-name">${label}</span><span class="epc-group-count">${S.settings.epcGroupCount(g.items.length, on)}</span></summary>
        <${EpcPick} items=${g.items} selected=${selected} onToggle=${onToggle} disabled=${disabled} full=${full} label=${label} />
      </details>`
    })}
  </div>`
}

function SettingRow({ name, field, error, note, children }) {
  const chip = sourceChip(field, { valueText: (v) => fmtConfigValue(name, v, name === 'pollEpcs' && field && Array.isArray(field.options) && field.options.length ? field.options : null) })
  return html`<div class=${cx('set-row', error && 'set-row-error')} data-field=${name}>
    <div class="set-label">
      <span class="set-name-line"><span id=${'lbl-' + name} class="set-name">${S.settings.fields[name]}</span><${SourceChip} chip=${chip} /></span>
      <span id=${'hint-' + name} class="hint">${S.settings.hints[name]}</span>
    </div>
    <div class="set-input">
      ${children}
      ${error ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${error}</span></p>` : null}
      ${!error && note ? html`<p class="field-note tone-text-warn"><${Icon} name="warn" size=${14} /><span>${note}</span></p>` : null}
      ${field && field.source === 'override' ? html`<p class="field-note tone-text-info"><${Icon} name="hand" size=${14} /><span>${S.settings.overrideActive}</span></p>` : null}
    </div>
  </div>`
}

/** 項目の入力欄へ。「定期的に取りに行く値」は欄が 1 つではないので、最初の押せるチェックへ。 */
function focusField(name) {
  if (typeof document === 'undefined') return
  const row = '.set-row[data-field="pollEpcs"] '
  const el = name === 'pollEpcs' ? document.querySelector(row + 'input:not([disabled]), ' + row + 'button:not([disabled])') : document.getElementById('in-' + name)
  if (el && typeof el.focus === 'function') el.focus()
}

/** 「計測」のカード（運用設定 4 項目）。 */
function MeasureCard(props) {
  const { a, settings, writeReason, onSaveSettings, onResetSettings, onReloadSettings, storage, active } = props
  const data = settings && settings.data
  // 手で変えた項目だけ（{field: 入力の値}）。触っていない項目は data に付いていく
  const [edits, setEdits] = useState({})
  // 手で変え始めたときの rev（If-Match と「ほかで変わった」の判定に使う）。変えていなければ null
  const [baseRev, setBaseRev] = useState(null)
  const [serverErrors, setServerErrors] = useState({})
  const [conflict, setConflict] = useState(false)
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const [errTick, setErrTick] = useState(0)
  // 画面の上から見て最初の誤りの欄へ（下の描画で作る）。確認ダイアログが閉じたあとに動かす（開いている間は外の欄にフォーカスできない）
  const focusFirst = useRef(null)
  useEffect(() => {
    if (errTick && focusFirst.current) focusFirst.current()
  }, [errTick])

  useCloseDialogWhenHidden(active, setDialog)

  const draft = data ? mergeDraft(data, edits) : null
  const changes = draft ? diffDraft(draft, data) : { patch: {}, changes: [] }
  const dirty = changes.changes.length > 0

  // 手で変えた値がサーバーの値と同じになった（ほかの場所で同じ値を保存した・上書きが同じ値になった）: 変えていない扱いに戻す
  useEffect(() => {
    if (!data || baseRev === null || dirty) return
    setEdits({})
    setBaseRev(null)
  }, [data, dirty, baseRev])

  const head = (body) => html`<${Card} card="measure" title=${S.settings.cardTitle} icon="chart">${body}</${Card}>`
  if (!settings || settings.status === 'loading') return head(html`<${Loading} />`)
  if (!data) return head(html`<${Failure} title=${S.settings.loadFailed} error=${settings.error} onRetry=${onReloadSettings} />`)

  const readOnly = !!writeReason
  const clientErrors = validateDraft(draft, data)
  const notes = untouchedNotes(draft, data)
  const errors = Object.assign({}, tried ? clientErrors : {}, serverErrors)
  const remoteChanged = baseRev !== null && data.rev !== baseRev && dirty
  const fields = data.fields || {}
  const epcOptions = epcOptionsOf(data)
  const max = rangeOf(data, 'pollEpcs').max
  const selected = draft.pollEpcs
  const full = selected.length >= max
  const split = epcOptions ? splitEpcOptions(epcOptions) : null
  const basicNames = FIELDS.filter((n) => isBasic(data, n))
  const advancedNames = FIELDS.filter((n) => !isBasic(data, n))
  const othersSelected = split ? split.others.filter((o) => selected.includes(normEpc(o && o.epc))).length : 0
  focusFirst.current = () => {
    const first = basicNames.concat(advancedNames).find((n) => errors[n])
    if (first) focusField(first)
  }

  function forget() {
    setEdits({})
    setBaseRev(null)
    setServerErrors({})
    setTried(false)
  }

  function set(name, value) {
    const next = pruneEdits(Object.assign({}, edits, { [name]: value }), data)
    const any = Object.keys(next).length > 0
    setEdits(next)
    setBaseRev(any ? (baseRev === null ? data.rev : baseRev) : null)
    if (serverErrors[name]) {
      const nextErrors = Object.assign({}, serverErrors)
      delete nextErrors[name]
      setServerErrors(nextErrors)
    }
  }

  function toggleEpc(e) {
    if (selected.includes(e)) set('pollEpcs', selected.filter((x) => x !== e))
    else if (!full) set('pollEpcs', selected.concat([e]))
  }

  function reload() {
    forget()
    setConflict(false)
    onReloadSettings()
  }

  function askSave() {
    setTried(true)
    if (Object.keys(clientErrors).length) {
      setErrTick((n) => n + 1)
      return
    }
    if (!dirty) return
    setDialog('save')
  }

  async function save() {
    setBusy(true)
    const r = await onSaveSettings(changes.patch, baseRev || data.rev)
    setBusy(false)
    setDialog(null)
    if (r.ok) {
      forget()
      return
    }
    if (r.error && r.error.status === 412) setConflict(true)
    else if (r.error && r.error.status === 422 && r.error.details) {
      setServerErrors(Object.assign({}, r.error.details))
      setErrTick((n) => n + 1)
    }
  }

  async function reset() {
    setBusy(true)
    const r = await onResetSettings(baseRev || data.rev)
    setBusy(false)
    setDialog(null)
    if (r.ok) forget()
    else if (r.error && r.error.status === 412) setConflict(true)
  }

  // 上書きの下にある運用設定も「設定ノードの値に戻す」（DELETE）で外せる
  const hasRuntime = FIELDS.some((n) => hasRuntimeRecord(fields[n]))
  const off = readOnly || busy
  const reloadButton = html`<button type="button" class="btn btn-sm" onClick=${reload}><${Icon} name="refresh" size=${14} />${S.reload}</button>`
  const advErrors = advancedNames.filter((n) => errors[n])
  // 項目の数を出す（同じ項目に出どころと誤りの両方があっても 1 件）
  const advNotes = new Set([...advancedNames.filter((n) => sourceChip(fields[n])), ...advErrors]).size

  const secondsRow = (name) => html`<${SettingRow} key=${name} name=${name} field=${fields[name]} error=${errors[name]} note=${notes[name]}>
    <${SecondsInput} name=${name} value=${draft[name]} onInput=${(v) => set(name, v)} disabled=${off} range=${rangeOf(data, name)} invalid=${!!errors[name]} />
  </${SettingRow}>`

  // 「定期的に取りに行く値」: 基本設定ならよく使う 4 つと「n / 6 個」。詳細設定なら全部
  const epcBasicPart = epcOptions
    ? html`<div class="epc-picker">
        <${EpcPick} items=${split.common} selected=${selected} onToggle=${toggleEpc} disabled=${off} full=${full} label=${S.settings.epcGroups.common} />
        <p class="hint epc-count">${S.settings.epcCount(selected.length, max)}</p>
      </div>`
    : html`<${EpcChips} selected=${selected} onChange=${(v) => set('pollEpcs', v)} disabled=${off} supported=${a.supportedEpcs} max=${max} />`
  const epcOthersPart =
    epcOptions && split.others.length
      ? html`<details class="epc-group epc-others" data-group="others">
          <summary class="epc-group-title"><span class="epc-group-name">${S.settings.epcOthers}</span><span class="epc-group-count">${S.settings.epcGroupCount(epcOptionGroups(split.others, []).reduce((n, g) => n + g.items.length, 0), othersSelected)}</span></summary>
          <${EpcOptions} options=${split.others} selected=${selected} onToggle=${toggleEpc} disabled=${off} full=${full} shownElsewhere=${split.common.map((o) => o.epc)} />
        </details>`
      : null
  const epcRow = (part) => html`<${SettingRow} key="pollEpcs" name="pollEpcs" field=${fields.pollEpcs} error=${errors.pollEpcs} note=${notes.pollEpcs}>${part}</${SettingRow}>`
  const rowOf = (n, where) => {
    if (n !== 'pollEpcs') return secondsRow(n)
    if (where === 'basic') return epcRow(epcBasicPart)
    // tier が詳細設定（全部を詳細設定に）
    return epcRow(epcOptions ? html`<div class="epc-picker"><${EpcOptions} options=${epcOptions} selected=${selected} onToggle=${toggleEpc} disabled=${off} full=${full} /><p class="hint epc-count">${S.settings.epcCount(selected.length, max)}</p></div>` : epcBasicPart)
  }
  const pollBasic = basicNames.includes('pollEpcs')
  const slow = draft.slowIntervalSec === '' ? S.none : formatInterval(Number(draft.slowIntervalSec))
  const half = draft.halfHourIntervalSec === '' ? S.none : formatInterval(Number(draft.halfHourIntervalSec))
  const summary = [S.settings.moreSummary(slow, half), othersSelected ? S.settings.moreOthers(othersSelected) : null].filter(Boolean).join(S.more.sep)

  return html`<${Card} card="measure" title=${S.settings.cardTitle} icon="chart">
    ${conflict
      ? html`<${Notice} tone="danger" icon="warn" action=${reloadButton}>${S.settings.conflict}</${Notice}>`
      : remoteChanged
        ? html`<${Notice} tone="warn" icon="info" action=${reloadButton}>${S.settings.updatedElsewhere}</${Notice}>`
        : null}
    ${(data.warnings || []).map((w) => html`<${Notice} tone="warn" icon="warn">${w}</${Notice}>`)}

    <form class="settings-form measure-form card-form" onSubmit=${(e) => (e.preventDefault(), askSave())} novalidate>
      ${basicNames.map((n) => rowOf(n, 'basic'))}
      <${MoreDetails}
        card="measure"
        storage=${storage}
        summary=${summary}
        notes=${advNotes}
        forceOpen=${advErrors.length ? String(errTick) : null}
        onOpened=${() => focusFirst.current()}
      >
        ${pollBasic && epcOthersPart
          ? html`<div class="set-row" data-field="pollEpcs-others">
              <div class="set-label"><span class="set-name">${S.settings.epcOthers}</span><span class="hint">${S.settings.hints.pollEpcs}</span></div>
              <div class="set-input">${epcOthersPart}</div>
            </div>`
          : null}
        ${advancedNames.map((n) => rowOf(n, 'advanced'))}
        <h3 class="more-sub">${S.settings.sourceTable}</h3>
        <${SourceTable} fields=${fields} />
        ${hasRuntime
          ? html`<p><button type="button" class="btn" disabled=${off} title=${readOnly ? writeReason : undefined} onClick=${() => setDialog('reset')}><span>${S.settings.reset}</span></button></p>`
          : null}
      </${MoreDetails}>
      <${SaveBar} dirty=${dirty} dirtyText=${S.settings.dirty} cleanText=${S.settings.noChanges} label=${S.settings.save} disabled=${off || !dirty} title=${readOnly ? writeReason : null} />
      ${readOnly ? html`<p class="readonly-note"><${Icon} name="lock" size=${14} /><span>${writeReason}</span></p>` : null}
    </form>

    <${Dialog} open=${dialog === 'save'} title=${S.confirm.settingsTitle} icon="edit" busy=${busy} onClose=${() => setDialog(null)} onConfirm=${save} confirmLabel=${S.confirm.settingsOk}>
      <p>${S.confirm.settingsBody}</p>
      <table class="table diff-table">
        <thead><tr><th scope="col"></th><th scope="col">${S.confirm.from}</th><th scope="col">${S.confirm.to}</th></tr></thead>
        <tbody>
          ${changes.changes.map((c) => html`<tr><th scope="row">${c.label}</th><td class="mono muted">${c.from}</td><td class="mono"><strong>${c.to}</strong></td></tr>`)}
        </tbody>
      </table>
    </${Dialog}>
    <${Dialog} open=${dialog === 'reset'} title=${S.confirm.resetTitle} icon="refresh" tone="warn" busy=${busy} onClose=${() => setDialog(null)} onConfirm=${reset} confirmLabel=${S.confirm.resetOk}>
      <p>${S.confirm.resetBody}</p>
    </${Dialog}>
  </${Card}>`
}

/**
 * @param props DetailPane の props（a・settings・writeReason・config・serialports・configWriteReason・storage・focusReq・nameOf・
 *   onSaveSettings などと、構成の onSaveConfig など）。config を渡さない呼び手では、今までの「アダプタと接続（読むだけ）」。
 *   active: false なら隠す。ほかのタブを見ている間も描いたままにして、下書きと認証の欄の入力を黙って消さない。
 */
export function SettingsTab(props) {
  return html`<div class="settings-tab" hidden=${props.active === false} aria-label=${S.detail.tabs.settings}>
    <${ConfigSection} ...${props} />
    <${MeasureCard} ...${props} />
    <p class="also-nodes tab-footer"><${Icon} name="info" size=${14} /><span>${S.settings.tabFooter}</span></p>
  </div>`
}
