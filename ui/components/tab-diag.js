// 診断タブ: 1 つのフォーム（コマンドの選択と引数）と「実行」。結果はフォームのすぐ下に、
// 新しいものを上にして時刻つきで並べる（このページの間だけ。store の diag）。電波を使うもの（プロパティマップ・EPC）には印。
// 受け取った行は機器から届いた文字列なので、テキストとして描く。
import { html, cx, useState, useEffect, useRef, useNow } from '../html.js'
import { Icon } from './icons.js'
import { Badge } from './common.js'
import { S } from '../strings.js'
import { formatTime, formatClock, formatDateTime, formatRelative, formatEpc, parseEpcList, text, isNum } from '../format.js'

export const COMMANDS = ['info', 'table', 'ropt', 'sreg', 'propmap', 'epc']
/** 電波を使う（メーターに ECHONET の Get を送る）コマンド。 */
export const RADIO = ['propmap', 'epc']
const TABLES = ['1', '2', 'E', 'F']
const REGS = ['S02', 'S03', 'S07', 'S0A', 'S15', 'S16', 'S17', 'SA2', 'SFD', 'SFE', 'SF0']
const COOLDOWN_MS = 3000

function argsText(args) {
  return args ? Object.values(args).flat().map(String).join(' ') : ''
}

function ResultEntry({ e, now }) {
  return html`<li class=${cx('result', !e.ok && 'result-failed')} data-name=${e.name}>
    <div class="result-head">
      <span class=${e.ok ? 'tone-text-ok' : 'tone-text-danger'}><${Icon} name=${e.ok ? 'ok' : 'bad'} size=${14} label=${e.ok ? S.diag.ok : S.diag.failed} /></span>
      <strong>${S.diag.names[e.name] || e.name}</strong>
      ${argsText(e.args) ? html`<span class="mono muted">${argsText(e.args)}</span>` : null}
      <span class="tb-spacer"></span>
      <time class="muted num" datetime=${new Date(e.at).toISOString()} title=${formatDateTime(e.at)}>${formatTime(e.at)} · ${formatRelative(e.at, now)}</time>
    </div>
    ${e.ok
      ? html`${e.result && Array.isArray(e.result.values) && e.result.values.length
          ? html`<table class="table table-compact">
              <thead><tr><th scope="col">${S.values.colEpc}</th><th scope="col">${S.values.colName}</th><th scope="col">${S.values.colValue}</th></tr></thead>
              <tbody>${e.result.values.map((v) => html`<tr><td class="mono">${formatEpc(v.epc)}</td><td>${text(v.name)}</td><td class="num">${text(v.display)}${isNum(v.meterAt) ? html` <span class="muted">${S.values.meterFixed(formatClock(v.meterAt))}</span>` : null}</td></tr>`)}</tbody>
            </table>`
          : null}
        ${e.result && Array.isArray(e.result.lines) && e.result.lines.length
          ? html`<pre class="console" aria-label=${S.diag.lines}>${e.result.lines.join('\n')}</pre>`
          : !(e.result && e.result.values && e.result.values.length)
            ? html`<p class="muted">${S.diag.noLines}</p>`
            : null}`
      : html`<p class="tone-text-danger">${e.error && e.error.message}</p>`}
  </li>`
}

export function DiagTab({ id, writeReason, diagResults, onDiag }) {
  const now = useNow()
  const [name, setName] = useState('info')
  const [table, setTable] = useState('1')
  const [reg, setReg] = useState('SFD')
  const [epcText, setEpcText] = useState('E7')
  const [busy, setBusy] = useState(false)
  // 押している間の歯止め（state は次の描画まで古い。同じ瞬間の 2 回目で電波の要求を積まない）
  const busyRef = useRef(false)
  const [lastAt, setLastAt] = useState(0)
  const [retryUntil, setRetryUntil] = useState(0)

  useEffect(() => {
    setBusy(false)
    busyRef.current = false
  }, [id])

  const waitUntil = Math.max(lastAt + COOLDOWN_MS, retryUntil)
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const epc = parseEpcList(epcText)
  const argError = name === 'epc' ? epc.error : null
  const reason = writeReason || (wait > 0 ? S.diag.cooldown(wait) : null)

  function argsOf() {
    if (name === 'table') return { which: table }
    if (name === 'sreg') return { reg }
    if (name === 'epc') return { epcs: epc.epcs }
    return undefined
  }

  async function run(e) {
    if (e) e.preventDefault()
    if (busy || busyRef.current || reason || argError) return
    busyRef.current = true
    setBusy(true)
    let r = null
    try {
      r = await onDiag(id, name, argsOf())
    } finally {
      busyRef.current = false
      setBusy(false)
      setLastAt(Date.now())
    }
    if (r && r.error && r.error.status === 429 && typeof r.error.retryAfter === 'number') setRetryUntil(Date.now() + r.error.retryAfter * 1000)
  }

  const results = diagResults || []
  return html`<section class="section" aria-label=${S.detail.tabs.diag}>
    <p class="hint">${S.diag.lead}</p>
    <form class="diag-form" onSubmit=${run} novalidate>
      <label class="field-inline">
        <span class="field-label">${S.diag.command}</span>
        <select class="input select" name="command" value=${name} onChange=${(ev) => setName(ev.currentTarget.value)}>
          ${COMMANDS.map((c) => html`<option value=${c}>${RADIO.includes(c) ? S.diag.withRadio(S.diag.names[c]) : S.diag.names[c]}</option>`)}
        </select>
      </label>
      ${name === 'table'
        ? html`<label class="field-inline">
            <span class="field-label">${S.diag.which}</span>
            <select class="input select" name="which" value=${table} onChange=${(ev) => setTable(ev.currentTarget.value)}>
              ${TABLES.map((t) => html`<option value=${t}>${S.diag.tables[t]}</option>`)}
            </select>
          </label>`
        : null}
      ${name === 'sreg'
        ? html`<label class="field-inline">
            <span class="field-label">${S.diag.reg}</span>
            <select class="input select" name="reg" value=${reg} onChange=${(ev) => setReg(ev.currentTarget.value)}>
              ${REGS.map((r) => html`<option value=${r}>${S.diag.regs[r]}</option>`)}
            </select>
          </label>`
        : null}
      ${name === 'epc'
        ? html`<label class="field-inline">
            <span class="field-label">${S.diag.epcInput}</span>
            <input
              class="input mono input-epc"
              name="epcs"
              value=${epcText}
              placeholder=${S.diag.epcPlaceholder}
              autocapitalize="characters"
              spellcheck=${false}
              aria-invalid=${argError ? 'true' : undefined}
              onInput=${(ev) => setEpcText(ev.currentTarget.value)}
            />
          </label>`
        : null}
      <button type="submit" class="btn btn-primary" disabled=${!!reason || busy || !!argError} title=${reason || undefined} aria-busy=${busy ? 'true' : undefined}>
        ${busy ? html`<span class="spinner spinner-sm" aria-hidden="true"></span>` : html`<${Icon} name="play" size=${16} />`}
        <span>${busy ? S.diag.running : S.diag.run}</span>
      </button>
      ${RADIO.includes(name) ? html`<${Badge} tone="warn" icon="live">${S.diag.radioNote}</${Badge}>` : null}
    </form>
    <p class="hint">${S.diag.hints[name]}</p>
    ${argError ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${argError}</span></p>` : null}
    ${writeReason
      ? html`<p class="readonly-note"><${Icon} name="lock" size=${14} /><span>${writeReason}</span></p>`
      : wait > 0 && !busy
        ? html`<p class="hint">${S.diag.cooldown(wait)}</p>`
        : null}

    <h2 class="section-title">${S.diag.resultsTitle}</h2>
    ${results.length
      ? html`<ol class="results">${results.map((e) => html`<${ResultEntry} key=${e.key} e=${e} now=${now} />`)}</ol>`
      : html`<p class="muted">${S.diag.resultsEmpty}</p>`}
  </section>`
}
