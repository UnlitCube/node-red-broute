// 状態タブの見せ方を決める純関数（DOM に触らない。test/ui/status-view.test.mjs）。
// 接続の段階のステッパー・再接続の段・送信積算のゲージ・預かっているコマンド。
// 「はじめに」（初めての台の手順）・つながらないときの案内（connectHint）・直近のエラー（24 時間・hint）。
import { S } from './strings.js'
import { isNum, phaseStep, txSeconds } from './format.js'

/**
 * 経過の長さを粗く（45 秒・13 分・2 時間 5 分・1 日 3 時間）。1 分を超えたら秒を出さない（1 秒ごとに文字が揺れない）。
 * 値が無い・負なら null。
 */
export function elapsedText(sec) {
  if (!isNum(sec) || sec < 0) return null
  const s = Math.floor(sec)
  if (s < 60) return S.time.sec(s)
  if (s < 3600) return S.time.minSec(Math.floor(s / 60), 0)
  if (s < 86400) return S.time.hourMin(Math.floor(s / 3600), Math.floor((s % 3600) / 60))
  return S.time.dayHour(Math.floor(s / 86400), Math.floor((s % 86400) / 3600))
}

/** ARIB STD-T108 の上限（1 時間あたり 360 秒）。 */
export const TX_LIMIT_SEC = 360
/**
 * sequencer の txBudgetGuardMs（250000 ms。360 秒の約 70%）。PANA を粘るとき、ここを超えると自分から休む。
 * サーバーが AdapterDetail に txGuardSec（か txGuardMs）を載せていればそれを使う（規則を 2 か所に持たない）。
 */
export const TX_GUARD_SEC = 250

/** 送信を休む線（秒）。サーバーの txGuardSec・txGuardMs があればそれ、無ければ TX_GUARD_SEC。 */
export function txGuardOf(a) {
  if (a && isNum(a.txGuardSec) && a.txGuardSec > 0) return a.txGuardSec
  if (a && isNum(a.txGuardMs) && a.txGuardMs > 0) return Math.round(a.txGuardMs / 1000)
  return TX_GUARD_SEC
}
/** これを超えたら注意の色（70%）。 */
export const TX_WARN_RATIO = 0.7

/**
 * 接続の段階のステッパー。段ごとの状態は done（済み）・now（いまの段）・fail（失敗・切断）・todo（まだ）・off（手順の外）。
 * - connected（段 5）は全部済み。
 * - port-down（ポート切断）と error（アダプタを初期化できなかった）は段 0 を失敗にする。
 * - 手順の途中（段 0〜4）で健康が bad（連続失敗・USB 切断・別の個体）なら、いまの段を失敗にする。
 * - 停止・無効・認証情報なしなど手順の外は全部 off。
 * @returns {{step: number, active: boolean, failed: boolean, steps: {label: string, state: string}[]}}
 */
export function phaseStepper(a) {
  const phase = a && a.phase
  const level = a && a.health ? a.health.level : null
  let step = phaseStep(phase)
  let failAt = -1
  if (phase === 'port-down' || phase === 'error') {
    step = 0
    failAt = 0
  } else if (step >= 0 && step < 5 && level === 'bad') {
    failAt = step
  }
  const steps = S.status.phaseSteps.map((label, i) => {
    let state
    if (step < 0) state = 'off'
    else if (step === 5 || i < step) state = 'done'
    else if (i === step) state = i === failAt ? 'fail' : 'now'
    else state = 'todo'
    return { label, state }
  })
  return { step, active: step >= 0, failed: failAt >= 0, steps }
}

/**
 * 再接続の段（段 0〜3）。ladder は「次に再接続するときの段」なので、
 * つながっている間は「切れたらここから」、つながっていなければ「いまの段」として強調する。
 * @returns {{n: number, name: string, hint: string, current: boolean, tag: string|null, tone: string|null}[]}
 */
export function ladderSteps(a) {
  const ladder = a && isNum(a.ladder) ? a.ladder : null
  const connected = !!(a && a.connected)
  return S.status.ladderSteps.map((name, n) => {
    const current = n === ladder
    return {
      n,
      name,
      hint: S.confirm.ladderHints[n] || '',
      current,
      tag: current ? (connected ? S.status.ladderTagNext : S.status.ladderTagNow) : null,
      tone: current ? (connected ? 'neutral' : 'warn') : null,
    }
  })
}

/**
 * 送信積算のゲージ。まだ読んでいない（txBudgetMs が null）なら null。
 * tone: 70% を超えるか、自分から休む線（250 秒）に届いたら warn、上限（360 秒）に届いたら danger、それ以外は ok。
 * fill は棒の長さ（0〜360 に収める）。guardSec はサーバーの休む線（無ければ TX_GUARD_SEC）。
 */
export function txGauge(ms, guardSec) {
  const used = txSeconds(ms)
  if (used === null) return null
  const guard = isNum(guardSec) && guardSec > 0 ? Math.min(TX_LIMIT_SEC, guardSec) : TX_GUARD_SEC
  const ratio = used / TX_LIMIT_SEC
  const tone = used >= TX_LIMIT_SEC ? 'danger' : ratio > TX_WARN_RATIO || used >= guard ? 'warn' : 'ok'
  return {
    used,
    limit: TX_LIMIT_SEC,
    guard,
    fill: Math.max(0, Math.min(TX_LIMIT_SEC, used)),
    pct: Math.max(0, Math.round(ratio * 100)),
    tone,
  }
}

/**
 * 預かっているコマンド（pendingCommands: {count, oldestMs}）。
 * oldestMs は状態を作った時点の待ち時間なので、画面が受け取ってからの経過（now − seenAt）を足して進める。
 * 項目の無い古いサーバーは null（何も出さない）。
 * @returns {{count: number, waitSec: number|null}|null}
 */
export function pendingView(p, seenAt, now) {
  if (!p || typeof p !== 'object' || !isNum(p.count)) return null
  const count = Math.max(0, Math.floor(p.count))
  if (!count) return { count: 0, waitSec: null }
  if (!isNum(p.oldestMs)) return { count, waitSec: null }
  const extra = isNum(seenAt) && isNum(now) ? Math.max(0, now - seenAt) : 0
  return { count, waitSec: Math.max(0, (p.oldestMs + extra) / 1000) }
}

// ---- はじめての台と、つながらないときの案内 -------------------------------------------

/**
 * 「はじめに」を出す条件（設定が足りない）。閉じるボタンと閉じた記録は持たない（直せば消える。health と同じ扱い）。
 * - 接続先が実機（シミュレーターでない）で、ポートが空
 * - credentials.configured === false
 */
export function needsOnboarding(a) {
  if (!a) return false
  const noPort = a.mode !== 'simulator' && !String(a.port || '').trim()
  const noCred = !!a.credentials && a.credentials.configured === false
  return noPort || noCred
}

/**
 * つながらないときの案内の文（view-model の connectHint）。無ければ null。
 * credentials: 認証が since から何分通らないか。no-meter: この認証 ID のメーターが見つからない。
 */
export function connectHintText(hint, now) {
  if (!hint || typeof hint !== 'object') return null
  if (hint.kind === 'credentials') {
    const min = isNum(hint.since) && isNum(now) ? Math.max(1, Math.floor((now - hint.since) / 60000)) : 1
    return S.status.hintCredentials(min)
  }
  if (hint.kind === 'no-meter') return S.status.hintNoMeter
  return null
}

/**
 * 「はじめに」の 3 つの手順。済 / 未 / 失敗は実際の状態（portOpen・credentials・phase）で決める（ボタンを押しただけでは進めない）。
 * 1. 契約とポート: 開けた（portOpen）なら済。ポートが空なら未。ポートがあるのに開けていなければ失敗（理由は health）。
 * 2. B ルートの認証 ID とパスワード: configured なら済、でなければ未。
 * 3. メーターにつながるのを待つ: いまの段の文（connectHint があればその文）。自動で始めるが外れていて止まっているなら「開始」。
 * @param {object} a AdapterDetail
 * @param {{autoStart?: boolean|null, now?: number}} [opt]
 */
export function onboardingView(a, opt = {}) {
  const now = isNum(opt.now) ? opt.now : Date.now()
  const label = String((a && a.portLabel) || (a && a.port) || '').trim()
  const port = String((a && a.port) || '').trim()
  const sim = a && a.mode === 'simulator'
  const h = (a && a.health) || {}
  let portStep
  if (a && a.portOpen) portStep = { state: 'done', text: S.onboarding.portDone(label || port) }
  else if (!sim && !port) portStep = { state: 'todo', text: S.onboarding.portTodo }
  else {
    const why = h.level === 'bad' ? (Array.isArray(h.reasons) && h.reasons[0]) || h.title || null : null
    portStep = why ? { state: 'fail', text: S.onboarding.portFail(label || port, why) } : { state: 'todo', text: S.onboarding.portWaiting(label || port) }
  }
  const configured = !!(a && a.credentials && a.credentials.configured === true)
  const credStep = { state: configured ? 'done' : 'todo', text: configured ? S.onboarding.credDone : S.onboarding.credTodo }
  const hint = connectHintText(a && a.connectHint, now)
  const stoppedManual = !!a && a.running === false && opt.autoStart === false
  let waitText
  if (hint) waitText = hint
  else if (stoppedManual) waitText = S.onboarding.pressStart
  else waitText = (a && a.phase && S.status.phaseHelp[a.phase]) || S.onboarding.waitStarting
  const ready = portStep.state === 'done' && credStep.state === 'done'
  const waitStep = { state: a && a.connected ? 'done' : ready ? 'now' : 'todo', text: waitText, hint: !!hint, start: stoppedManual }
  return { steps: { port: portStep, cred: credStep, wait: waitStep } }
}

/** 直近のエラーを出すのは 24 時間以内のものだけ（古いエラーが、今も起きているように読めないように）。 */
export const LAST_ERROR_MS = 24 * 3600 * 1000

/**
 * 直近のエラーの見せ方。24 時間より前・無いなら null。
 * 赤にするのは health が bad のときだけ。そのあと値が届いていれば recovered（「その後は計測できています」）。
 * @returns {{message: string, hint: string|null, at: number, tone: 'danger'|'neutral', recovered: boolean}|null}
 */
export function lastErrorView(a, now) {
  const e = a && a.lastError
  if (!e || !e.message) return null
  const t = isNum(now) ? now : Date.now()
  if (isNum(e.at) && t - e.at > LAST_ERROR_MS) return null
  const bad = !!(a.health && a.health.level === 'bad')
  const recovered = isNum(e.at) && isNum(a.lastValueAt) && a.lastValueAt > e.at
  return { message: String(e.message), hint: typeof e.hint === 'string' && e.hint ? e.hint : null, at: e.at, tone: bad ? 'danger' : 'neutral', recovered }
}

/**
 * 電波の強さ。BP35C0 の LQI（0〜255）を 3 段にする。label は言葉と数の併記、title はおよその dBm。
 * 目安は 100 以上で強い・60 以上でふつう・それより下は弱い（途切れの多い環境では 43〜61 ほど）。
 */
export function lqiLevel(lqi) {
  if (!isNum(lqi)) return null
  const key = lqi >= 100 ? 'strong' : lqi >= 60 ? 'fair' : 'weak'
  const text = S.status.lqiLevels[key]
  return { key, text, label: S.status.lqiLabel(text, lqi), title: S.values.lqiTip(lqi), tone: key === 'weak' ? 'warn' : key === 'fair' ? 'neutral' : 'ok' }
}
