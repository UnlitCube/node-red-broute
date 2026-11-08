// 状態タブ。
// 上から順に: はじめに（条件つき）→ 接続の段階 → 直近のエラー → メーターと認証情報の要点 → 「詳しい状態」の折りたたみ
//   （再接続の段・送信積算・換算・アダプタ・カウンタ。開閉はこのブラウザーに保存する）。
// - はじめに: 設定が足りない台（ポートが空・認証情報なし）の 3 つの手順。出すかどうかは DetailPane が決める（つながるまで出し続ける）。
//   ボタンは設定タブの該当のカードへ移ってその欄にフォーカスする。
// - つながらないときの案内（connectHint）: はじめにを出していなければ、帯で出して［認証 ID とパスワードを入れ直す］。
// - 接続の段階: ステッパー（丸・線・済みは緑のチェック・いまの段は強調と回る印・失敗や切断は赤・まだは灰）。SK コマンドの名前は title。
// - 直近のエラー: 24 時間以内のものだけ。何をすればよいか（hint）を先に、機器の文言は小さく。赤は health が bad のときだけ。
// 状態は色・アイコン・文字の 3 つで示す。色は tokens.css のトークンだけ（app.css）。style 属性は使わない（CSP）。
import { html, cx, useNow, useRef, useState } from '../html.js'
import { Badge, RelTime, Notice, MoreDetails } from './common.js'
import { Icon } from './icons.js'
import { S } from '../strings.js'
import { formatNumber, formatDateTime, text, isNum } from '../format.js'
import { phaseStepper, ladderSteps, txGauge, txGuardOf, pendingView, elapsedText, onboardingView, connectHintText, lastErrorView, lqiLevel } from '../status-view.js'

/** 見出しつきの節。id は aria-labelledby に使う（状態タブは 1 度に 1 つ）。 */
function Section({ id, icon, title, children }) {
  return html`<section class="st-sec" aria-labelledby=${'st-' + id} data-sec=${id}>
    <h2 class="st-title" id=${'st-' + id}><${Icon} name=${icon} size=${16} /><span>${title}</span></h2>
    ${children}
  </section>`
}

function Row({ k, v, mono, tone, cls, title }) {
  return html`<tr class=${cls || undefined}>
    <th scope="row">${k}</th>
    <td class=${cx(mono && 'mono', tone && 'tone-text-' + tone)} title=${title || undefined}>${v === null || v === undefined || v === '' ? S.none : v}</td>
  </tr>`
}

function KvTable({ children }) {
  return html`<table class="kv-table"><tbody>${children}</tbody></table>`
}

function pairs(labels, values, warnIfPositive) {
  return Object.keys(labels).map((k) => {
    const v = values[k]
    return html`<span class=${cx('pair', warnIfPositive && v > 0 && 'tone-text-warn')}>${S.status.pair(labels[k], isNum(v) ? formatNumber(v) : S.none)}</span>`
  })
}

const STEP_ICON = { done: 'check', fail: 'close' }

/** 接続の段階のステッパー。段ごとの状態は class（色）・丸の中の印（アイコン）・読み上げの文字の 3 つ。 */
function PhaseStepper({ a }) {
  const st = phaseStepper(a)
  return html`<ol class=${cx('steps', !st.active && 'steps-off')} aria-label=${S.status.phaseStepsLabel}>
    ${st.steps.map((s) => {
      const mark =
        s.state === 'now' ? html`<span class="step-spin" aria-hidden="true"></span>` : STEP_ICON[s.state] ? html`<${Icon} name=${STEP_ICON[s.state]} size=${14} />` : null
      return html`<li class=${'step step-' + s.state} aria-current=${s.state === 'now' || s.state === 'fail' ? 'step' : undefined}>
        <span class="step-dot" aria-hidden="true">${mark}</span>
        <span class="step-label">${s.label}</span>
        <span class="sr-only">${S.status.phaseState[s.state]}</span>
      </li>`
    })}
  </ol>`
}

/** 預かっているコマンド。oldestMs は受け取った時点の値なので、受け取ってからの経過を足して 1 秒ごとに進める。 */
function usePendingSeenAt(p) {
  const ref = useRef({ key: undefined, at: 0 })
  const key = p && typeof p === 'object' ? p.count + ':' + p.oldestMs : null
  if (ref.current.key !== key) ref.current = { key, at: Date.now() }
  return ref.current.at
}

function PendingRow({ p, now, seenAt }) {
  const pv = pendingView(p, seenAt, now)
  if (!pv) return null
  const wait = pv.waitSec === null ? null : elapsedText(pv.waitSec)
  return html`<tr class="pending-row">
    <th scope="row"><span class="pending-key"><${Icon} name="queue" size=${14} /><span>${S.status.groups.pending}</span></span></th>
    <td class=${cx(pv.count > 0 && 'tone-text-warn')}>${pv.count > 0 ? S.status.pendingValue(pv.count, wait) : S.status.pendingNone}</td>
  </tr>`
}

function PhaseSection({ a, now }) {
  const st = phaseStepper(a)
  // サーバーとブラウザの時計が少しずれていても（phaseSince が先）、経過は 0 秒から出す
  const since = isNum(a.phaseSince) ? elapsedText(Math.max(0, now - a.phaseSince) / 1000) : null
  const help = st.active ? S.status.phaseHelp[a.phase] || null : null
  const tech = S.status.phaseTech[a.phase] || null
  const seenAt = usePendingSeenAt(a.pendingCommands)
  const pv = pendingView(a.pendingCommands, seenAt, now)
  return html`<${Section} id="phase" icon="plug" title=${S.status.groups.phase}>
    <${PhaseStepper} a=${a} />
    <p class="steps-caption">
      <strong class=${cx('phase-text', st.failed && 'tone-text-danger')}>${a.phaseText || a.phase || S.none}</strong>${since
        ? html`<span class="muted"> · ${S.status.phaseSince(since)}</span>`
        : null}
    </p>
    ${help ? html`<p class="steps-help muted" title=${tech || undefined}>${help}</p>` : null}
    ${!st.active && !st.failed ? html`<p class="steps-help muted">${S.status.phaseOff}</p>` : null}
    ${pv
      ? html`<${KvTable}><${PendingRow} p=${a.pendingCommands} now=${now} seenAt=${seenAt} /></${KvTable}>
          ${pv.count > 0 ? html`<p class="steps-help muted">${S.status.pendingHint}</p>` : null}`
      : null}
  </${Section}>`
}

function ReconnectSection({ a }) {
  const join = a.join || {}
  const steps = ladderSteps(a)
  const fails = isNum(a.consecutiveFailures) ? a.consecutiveFailures : null
  return html`<${Section} id="reconnect" icon="refresh" title=${S.status.groups.reconnect}>
    <div class="reconnect">
      <ol class="ladder" aria-label=${S.status.ladderLabel}>
        ${steps.map(
          (s) => html`<li class=${cx('ladder-step', s.current && 'ladder-now', s.tone && 'tone-' + s.tone)} aria-current=${s.current ? 'step' : undefined} title=${S.confirm.ladderTech[s.n] || undefined}>
            <span class="ladder-num num" aria-hidden="true">${s.n}</span>
            <span class="ladder-main">
              <span class="ladder-name"><span class="sr-only">${S.status.ladderNum(s.n)}: </span>${s.name}</span>
              <span class="ladder-hint">${s.hint}</span>
            </span>
            ${s.tag ? html`<span class="ladder-tag"><${Icon} name=${s.tone === 'warn' ? 'busy' : 'info'} size=${14} /><span>${s.tag}</span></span>` : null}
          </li>`,
        )}
      </ol>
      <dl class="reconnect-side">
        <div>
          <dt>${S.status.failures}</dt>
          <dd class=${cx('num', fails > 0 && 'tone-text-danger')}>${fails === null ? S.none : S.status.failuresCount(fails)}</dd>
        </div>
        <div>
          <dt>${S.status.joinBurst}</dt>
          <dd class="num">${isNum(join.burst) && join.burst > 0 ? S.status.joinBurstValue(join.burst, join.attempt || 0) : S.none}</dd>
        </div>
      </dl>
    </div>
  </${Section}>`
}

/** 送信積算。まだ読んでいなければ「まだ分かりません。」と［いま読む］（診断の sreg SFD。電波を使わない）。 */
function TxSection({ a, onReadSfd, reason }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const g = txGauge(a.txBudgetMs, txGuardOf(a))
  if (!g) {
    async function read() {
      if (busy || !onReadSfd) return
      setBusy(true)
      setError(null)
      try {
        const r = await onReadSfd()
        // 失敗の結果は診断タブに積まれるだけなので、押したここにも出す（BUSY はトーストが知らせる）
        if (r && !r.ok && !r.busy) setError((r.error && r.error.message) || S.actions.failed)
      } finally {
        setBusy(false)
      }
    }
    return html`<${Section} id="tx" icon="radio" title=${S.status.groups.tx}>
      <p class="tx-unknown"><span class="muted">${S.status.txUnknown}</span>
        ${onReadSfd
          ? html` <button type="button" class="btn btn-sm" disabled=${!!reason || busy} title=${reason || S.status.txReadTitle} aria-busy=${busy ? 'true' : undefined} onClick=${read}>
              ${busy ? html`<span class="spinner spinner-sm" aria-hidden="true"></span>` : html`<${Icon} name="refresh" size=${14} />`}<span>${S.status.txReadNow}</span>
            </button>`
          : null}
      </p>
      ${error ? html`<p class="field-error" role="alert"><${Icon} name="bad" size=${14} /><span>${error}</span></p>` : null}
    </${Section}>`
  }
  const used = formatNumber(g.used)
  return html`<${Section} id="tx" icon="radio" title=${S.status.groups.tx}>
    <div class="gauge">
      <p class="gauge-head">
        <span class="gauge-key muted">${S.status.txUsed}</span>
        <span class=${cx('gauge-value', 'num', g.tone !== 'ok' && 'tone-text-' + g.tone)}>${S.status.txLabel(used)}</span>
        <span class="muted num">${S.status.txPercent(g.pct)}</span>
      </p>
      <svg class="gauge-bar" viewBox="0 0 360 12" preserveAspectRatio="none" role="img" aria-label=${S.status.txAria(used, g.pct)} focusable="false">
        <rect class="gauge-track" x="0" y="0" width="360" height="12" rx="3" vector-effect="non-scaling-stroke" />
        <rect class=${'gauge-fill gauge-fill-' + g.tone} x="0" y="0" width=${g.fill} height="12" rx="3" />
        <line class="gauge-guard" x1=${g.guard} x2=${g.guard} y1="0" y2="12" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="gauge-scale num muted" aria-hidden="true"><span>${S.status.txScaleMin}</span><span>${S.status.txScaleMax}</span></div>
      <p class="gauge-legend"><span class="gauge-swatch" aria-hidden="true"></span><span>${S.status.txGuard(g.guard)}</span></p>
      <p class="muted">${S.status.txNote}</p>
    </div>
  </${Section}>`
}

const ONB_ICON = { done: 'check', fail: 'close' }

/** 「はじめに」の 1 手順。 */
function OnbStep({ n, step, name, action }) {
  return html`<li class=${'onb-step onb-' + step.state} data-step=${n}>
    <span class="onb-mark" aria-hidden="true">${ONB_ICON[step.state] ? html`<${Icon} name=${ONB_ICON[step.state]} size=${14} />` : html`<span class="num">${n}</span>`}</span>
    <span class="onb-main">
      <span class="onb-name">${name}<span class="sr-only">${S.onboarding.stateSr(S.onboarding.state[step.state])}</span></span>
      <span class="onb-text">${step.text}</span>
    </span>
    ${action || null}
  </li>`
}

/** 状態タブの最上部の「はじめに」。 */
function Onboarding({ a, now, autoStart, onGoto, onStart, reason }) {
  const v = onboardingView(a, { autoStart, now })
  const s = v.steps
  const btn = (label, on, extra) =>
    html`<button type="button" class=${cx('btn', 'btn-sm', extra)} disabled=${!!reason && extra === 'btn-primary'} title=${reason || undefined} onClick=${on}><span>${label}</span></button>`
  return html`<section class="onb" aria-labelledby="st-onb" data-sec="onboarding">
    <h2 class="onb-title" id="st-onb"><${Icon} name="info" size=${16} /><span>${S.onboarding.title}</span></h2>
    <p class="hint">${S.onboarding.lead}</p>
    <ol class="onb-steps">
      <${OnbStep} n=${1} step=${s.port} name=${S.onboarding.port} action=${s.port.state !== 'done' ? btn(S.onboarding.pickPort, () => onGoto('serialport')) : null} />
      <${OnbStep} n=${2} step=${s.cred} name=${S.onboarding.cred} action=${s.cred.state !== 'done' ? btn(S.onboarding.enterCred, () => onGoto('credentials')) : null} />
      <${OnbStep}
        n=${3}
        step=${s.wait}
        name=${S.onboarding.wait}
        action=${s.wait.hint
          ? btn(S.status.reenterCredentials, () => onGoto('credentials'))
          : s.wait.start
            ? btn(S.actions.start, onStart, 'btn-primary')
            : null}
      />
    </ol>
  </section>`
}

/**
 * @param {{a: object, onboarding?: boolean, autoStart?: boolean|null, onGoto?: (target: 'serialport'|'credentials') => void,
 *   onAction?: Function, onDiag?: Function, writeReason?: string|null, storage?: object}} props
 */
export function StatusTab({ a, onboarding, autoStart, onGoto, onAction, onDiag, writeReason, storage }) {
  const now = useNow()
  const m = a.meter || {}
  const cal = a.calibration || {}
  const dev = a.device || {}
  const cred = a.credentials || {}
  const go = onGoto || (() => {})
  const hint = connectHintText(a.connectHint, now)
  const err = lastErrorView(a, now)
  const lqi = lqiLevel(isNum(m.lqi) ? m.lqi : a.lqi)
  const macState =
    dev.macMatches === true
      ? html`<${Badge} tone="ok" icon="ok">${S.status.macMatch}</${Badge}>`
      : dev.macMatches === false
        ? html`<${Badge} tone="danger" icon="bad">${S.status.macMismatch}</${Badge}>`
        : html`<span class="muted">${S.status.macNoExpect}</span>`
  const readSfd = onDiag ? () => onDiag(a.id, 'sreg', { reg: 'SFD' }) : null

  return html`<div class="st">
    ${onboarding
      ? html`<${Onboarding} a=${a} now=${now} autoStart=${autoStart} onGoto=${go} onStart=${() => onAction && onAction('start')} reason=${writeReason} />`
      : hint
        ? html`<${Notice}
            tone="warn"
            icon="warn"
            action=${html`<button type="button" class="btn btn-sm" onClick=${() => go('credentials')}><span>${S.status.reenterCredentials}</span></button>`}
          >${hint}</${Notice}>`
        : null}
    <${PhaseSection} a=${a} now=${now} />

    <${Section} id="last-error" icon="warn" title=${S.status.groups.lastError}>
      ${err
        ? html`<div class="last-error">
            ${err.hint && err.hint !== hint
              ? html`<p class=${cx('last-error-text', err.tone === 'danger' && 'tone-text-danger')}>${err.hint}</p>
                  <p class="last-error-device muted">${S.status.deviceText(err.message)}</p>`
              : html`<p class=${cx('last-error-text', err.tone === 'danger' && 'tone-text-danger')}>${err.message}</p>`}
            <p class="muted num"><span>${formatDateTime(err.at)}</span> · <${RelTime} at=${err.at} /></p>
            ${err.recovered ? html`<p class="tone-text-ok last-error-recovered"><${Icon} name="ok" size=${14} /><span>${S.status.recovered}</span></p>` : null}
          </div>`
        : html`<p class="muted">${S.status.noError}</p>`}
    </${Section}>

    <${Section} id="meter" icon="signal" title=${S.status.groups.meter}>
      <${KvTable}>
        <${Row} k=${S.status.panid} v=${text(m.panid)} mono />
        <${Row} k=${S.status.channel} v=${m.channel === null || m.channel === undefined ? S.none : S.status.channelValue(m.channel, m.channelMHz)} mono />
        <${Row} k=${S.status.lqi} v=${lqi ? lqi.label : S.none} title=${lqi ? lqi.title : null} tone=${lqi && lqi.tone === 'warn' ? 'warn' : null} />
        <${Row} k=${S.status.mac} v=${text(m.addr)} mono />
        <${Row} k=${S.status.ipv6} v=${text(m.ipv6)} mono />
        <${Row} k=${S.status.pairId} v=${text(m.pairId)} mono />
      </${KvTable}>
    </${Section}>

    <${Section} id="credentials" icon="key" title=${S.status.groups.credentials}>
      <${KvTable}>
        <${Row}
          k=${S.status.credState}
          v=${cred.configured ? html`<${Badge} tone="ok" icon="ok">${S.status.credConfigured}</${Badge}>` : html`<${Badge} tone="danger" icon="bad">${S.status.credMissing}</${Badge}>`}
        />
        <${Row} k=${S.status.credSource} v=${text(cred.source)} />
        <${Row} k=${S.status.credPairId} v=${text(cred.pairId)} mono />
      </${KvTable}>
    </${Section}>

    <${MoreDetails} card="status" storage=${storage} label=${S.status.groups.details}>
      <div class="st">
        <${ReconnectSection} a=${a} />
        <${TxSection} a=${a} onReadSfd=${readSfd} reason=${writeReason} />

        <${Section} id="calibration" icon="sliders" title=${S.status.groups.calibration}>
          <${KvTable}>
            <${Row} k=${S.status.coefficient} v=${text(cal.coefficient)} mono />
            <${Row} k=${S.status.unitFactor} v=${cal.unitFactor === null || cal.unitFactor === undefined ? S.none : `${cal.unitFactor} kWh`} mono />
            <${Row} k=${S.status.digits} v=${isNum(cal.digits) ? S.status.digitsValue(cal.digits) : S.none} />
          </${KvTable}>
        </${Section}>

        <${Section} id="adapter" icon="chip" title=${S.status.groups.adapter}>
          <${KvTable}>
            <${Row} k=${S.status.port} v=${a.port && a.portLabel && a.port !== a.portLabel ? S.status.portValue(a.portLabel, a.port) : text(a.portLabel || a.port)} />
            <${Row} k=${S.status.mode} v=${a.mode === 'simulator' ? S.status.modeSimulator : S.status.modeSerial} />
            <${Row} k=${S.status.deviceKey} v=${text(a.deviceKey)} mono />
            <${Row} k=${S.status.fw} v=${text(dev.version)} mono />
            <${Row} k=${S.status.macActual} v=${text(dev.mac)} mono />
            <${Row} k=${S.status.macExpected} v=${dev.expectedMac ? html`<span class="mono">${dev.expectedMac}</span> ${macState}` : macState} />
            <${Row} k=${S.status.consumers} v=${isNum(a.consumers) ? S.status.consumersValue(a.consumers) : S.none} />
            <${Row} k=${S.status.version} v=${text(a.libVersion)} mono />
          </${KvTable}>
        </${Section}>

        <${Section} id="counters" icon="list" title=${S.status.groups.counters}>
          <${KvTable}>
            <${Row} k=${S.status.countersLabel} v=${html`<span class="pairs num">${pairs(S.status.counters, a.counters || {}, false)}</span>`} />
            <${Row} k=${S.status.sendFailsLabel} v=${html`<span class="pairs num">${pairs(S.status.sendFails, a.sendFails || {}, true)}</span>`} />
          </${KvTable}>
        </${Section}>
      </div>
    </${MoreDetails}>
  </div>`
}
