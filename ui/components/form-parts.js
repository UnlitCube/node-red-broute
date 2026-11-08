// 設定タブ（アダプタと接続）と追加のモーダルで同じものを使う入力の部品。
// 部品を 1 つにすれば、試験も 1 つ（test/ui/config-ui.test.mjs・add.test.mjs）。
// - RoleSelect: 契約の select（未設定 / 電力 / 動力 / その他（名前を入力））。datalist は使わない（Chrome は今の値に合う候補しか出さない）。
// - ModeSegment: 接続先の 2 択（Wi-SUN アダプタ（実機）/ シミュレーター（実機なしで試す））。ポートの真上に置く。
// - PortSelect: GET serialports の候補（機器ごとに 1 つ・optgroup・使われているものは選べない）と［候補を読み直す］。
import { html, cx } from '../html.js'
import { Icon } from './icons.js'
import { S } from '../strings.js'
import { formatTime } from '../format.js'
import { ROLE_PRESETS, ROLE_OTHER, isCustomRole, portOptions, portOptionText } from '../config-model.js'

/**
 * 契約の select。value は保存する文字列、other は「その他（名前を入力）」を選んでいるか。
 * onChange(value, other)。required（追加の画面）なら先頭は「選んでください」（選べない）で「未設定」を出さない。
 */
export function RoleSelect({ prefix, value, other, onChange, disabled, invalid, required = false, labelledBy, describedBy }) {
  const v = typeof value === 'string' ? value : ''
  const t = v.trim()
  const custom = other || isCustomRole(v)
  const sel = custom ? ROLE_OTHER : ROLE_PRESETS.includes(t) ? t : ''
  function pick(e) {
    const next = e.currentTarget.value
    if (next === ROLE_OTHER) onChange(isCustomRole(v) ? v : '', true)
    else onChange(next, false)
  }
  return html`<div class="role-pick">
    <select
      class="input select role-select"
      id=${prefix + '-in-role'}
      value=${sel}
      disabled=${disabled}
      required=${required || undefined}
      aria-labelledby=${labelledBy}
      aria-describedby=${describedBy}
      aria-invalid=${invalid && !custom ? 'true' : undefined}
      onChange=${pick}
    >
      ${required
        ? html`<option value="" disabled>${S.roles.pick}</option>`
        : html`<option value="">${S.roles.unset}</option>`}
      ${ROLE_PRESETS.map((r) => html`<option value=${r} key=${r}>${r}</option>`)}
      <option value=${ROLE_OTHER}>${S.roles.other}</option>
    </select>
    ${custom
      ? html`<input
          class="input role-other"
          id=${prefix + '-in-role-other'}
          type="text"
          value=${v}
          maxlength="32"
          disabled=${disabled}
          spellcheck=${false}
          autocomplete="off"
          aria-label=${S.roles.otherLabel}
          aria-describedby=${describedBy}
          aria-invalid=${invalid ? 'true' : undefined}
          onInput=${(e) => onChange(e.currentTarget.value, true)}
        />`
      : null}
  </div>`
}

/** 接続先の 2 択（ラジオをセグメントの見た目で）。 */
export function ModeSegment({ prefix, name, value, onChange, disabled, labelledBy }) {
  return html`<div class="radios seg-radios" role="radiogroup" aria-labelledby=${labelledBy}>
    ${['serial', 'simulator'].map(
      (m) => html`<label class=${cx('radio', value === m && 'radio-on')} key=${m}>
        <input type="radio" id=${prefix ? prefix + '-in-mode-' + m : undefined} name=${name} value=${m} checked=${value === m} disabled=${disabled} onChange=${() => onChange(m)} />
        <span>${S.config.modes[m]}</span>
      </label>`,
    )}
  </div>`
}

/** 候補の数・読み込み中・読めない、の 1 行。 */
function portNote(sp, count) {
  const loading = sp.status === 'loading' || !!sp.loading
  if (loading && !sp.items) return S.config.portLoading
  if (sp.status === 'unsupported') return S.config.portUnsupported
  if (sp.status === 'error') return S.config.portFailed
  // serialport が無いサーバーでは候補を探せていない。「見つかりません」と言わず、入れ方と手で入力する先を出す
  if (sp.message) return `${sp.message}${S.config.portManualHint}`
  if (Array.isArray(sp.items) && !count) return S.config.portNone
  if (Array.isArray(sp.items)) return S.config.portCount(count, typeof sp.at === 'number' ? formatTime(sp.at) : null)
  return null
}

/**
 * ポートの select。value はいまの入力の値（触らなければサーバーの値のまま）。
 * 今の値の実体が候補と同じなら、その候補を選んだ状態で出し、値は変えない（触らずに保存しても差分が出ない）。
 * 候補に無ければ、先頭に「今の値: <パス>（見つかりません）」。候補を読めていない間（読み込み中・失敗・候補を返さないサーバー・serialport が無いサーバー）は
 * 見つからないとは言えないので、今の値だけを出す。ほかの台・フローが使っている候補は選べない。
 * ほかの USB シリアル機器（kind が other）を選んだら注意を出す。
 */
export function PortSelect({ id, value, selfId, serialports, onPick, onReload, disabled, invalid, labelledBy, describedBy, nameOf }) {
  const sp = serialports || {}
  const po = portOptions(sp.items, value, selfId, nameOf)
  const selValue = po.selected ? po.selected.value : po.missing || ''
  const loading = sp.status === 'loading' || !!sp.loading
  const note = portNote(sp, po.items.length)
  const groupLabel = { wsuha: S.config.portGroupWsuha, other: S.config.portGroupOther }
  const option = (d) => html`<option value=${d.value} key=${d.value} disabled=${!!d.used} title=${d.hint || undefined} data-kind=${d.kind || undefined}>${portOptionText(d)}</option>`
  return html`<div class="port-pick">
    <div class="port-pick-row">
      <select
        class="input select port-select"
        id=${id}
        value=${selValue}
        disabled=${disabled}
        aria-labelledby=${labelledBy}
        aria-describedby=${describedBy}
        aria-invalid=${invalid ? 'true' : undefined}
        onChange=${(e) => {
          const v = e.currentTarget.value
          if (v && v !== selValue) onPick(v)
        }}
      >
        ${!selValue ? html`<option value="">${S.config.portPick}</option>` : null}
        ${po.missing
          ? Array.isArray(sp.items) && !sp.message
            ? html`<option value=${po.missing} data-missing="1">${S.config.portMissing(po.missing)}</option>`
            : html`<option value=${po.missing}>${po.missing}</option>`
          : null}
        ${po.groups.map((g) =>
          g.key ? html`<optgroup label=${groupLabel[g.key]} key=${g.key} data-group=${g.key}>${g.items.map(option)}</optgroup>` : g.items.map(option),
        )}
      </select>
      ${sp.status !== 'unsupported' && onReload
        ? html`<button type="button" class="btn btn-sm" disabled=${loading} aria-busy=${loading ? 'true' : undefined} onClick=${onReload}>
            <${Icon} name="refresh" size=${14} /><span>${S.config.portReload}</span>
          </button>`
        : null}
    </div>
    ${po.selected && po.selected.kind === 'other'
      ? html`<p class="field-note tone-text-warn port-other"><${Icon} name="warn" size=${14} /><span>${S.config.portOtherWarn}</span></p>`
      : null}
    ${po.selected && po.selected.hint ? html`<p class="hint port-hint">${po.selected.hint}</p>` : null}
    ${note ? html`<p class="hint port-note">${note}</p>` : null}
  </div>`
}
