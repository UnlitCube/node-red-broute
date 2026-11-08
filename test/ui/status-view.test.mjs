// ui/status-view.js の純関数（状態タブのステッパー・再接続の段・送信積算のゲージ・預かっているコマンド）。
// 接続の段階のステッパーと、預かり（pendingCommands）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phaseStepper, ladderSteps, txGauge, pendingView, needsOnboarding, onboardingView, connectHintText, lastErrorView, LAST_ERROR_MS, TX_LIMIT_SEC, TX_GUARD_SEC } from '../../ui/status-view.js'
import { S } from '../../ui/strings.js'

const states = (a) => phaseStepper(a).steps.map((s) => s.state)

test('ステッパー: 接続済みは全部済み、途中はいまの段まで済み・その先はまだ、手順の外は全部 off', () => {
  assert.deepEqual(phaseStepper({ phase: 'connected' }).steps.map((s) => s.label), S.status.phaseSteps)
  assert.deepEqual(states({ phase: 'connected', health: { level: 'ok' } }), ['done', 'done', 'done', 'done', 'done', 'done'])
  assert.deepEqual(states({ phase: 'joining', health: { level: 'busy' } }), ['done', 'done', 'done', 'now', 'todo', 'todo'])
  assert.deepEqual(states({ phase: 'opening', health: { level: 'busy' } }), ['now', 'todo', 'todo', 'todo', 'todo', 'todo'])
  assert.deepEqual(states({ phase: 'verifying' }), ['done', 'done', 'done', 'done', 'now', 'todo'])
  for (const phase of ['idle', 'overridden', 'need-secrets', 'disabled', undefined]) {
    const st = phaseStepper({ phase, health: { level: 'idle' } })
    assert.deepEqual(st.steps.map((s) => s.state), Array(6).fill('off'), String(phase))
    assert.equal(st.active, false)
  }
})

// 「失敗や切断は赤」: ポートの切断・初期化できなかった台は段 0 を失敗に。手順の途中で bad（連続失敗など）ならいまの段を失敗に。
// 接続済み（段 5）で bad（別の個体）でも、段は全部済みのまま（理由は見出しが受け持つ）。
test('ステッパー: ポートの切断・初期化の失敗は段 0 が失敗、手順の途中で bad ならいまの段が失敗', () => {
  assert.deepEqual(states({ phase: 'port-down', health: { level: 'bad' } }), ['fail', 'todo', 'todo', 'todo', 'todo', 'todo'])
  assert.deepEqual(states({ phase: 'error', health: { level: 'bad' } }), ['fail', 'todo', 'todo', 'todo', 'todo', 'todo'])
  const st = phaseStepper({ phase: 'scanning', health: { level: 'bad' } })
  assert.deepEqual(st.steps.map((s) => s.state), ['done', 'done', 'fail', 'todo', 'todo', 'todo'])
  assert.equal(st.failed, true)
  assert.deepEqual(states({ phase: 'connected', health: { level: 'bad' } }), Array(6).fill('done'))
  assert.equal(phaseStepper({ phase: 'scanning', health: { level: 'busy' } }).failed, false)
})

test('再接続の段: 段 0〜3 に名前と説明。ladder の段を強調し、つながっていれば「切れたらここから」、でなければ「いまの段」', () => {
  const off = ladderSteps({ ladder: 2, connected: false })
  assert.deepEqual(off.map((s) => s.name), S.status.ladderSteps)
  assert.deepEqual(off.map((s) => s.hint), S.confirm.ladderHints)
  assert.deepEqual(off.map((s) => s.current), [false, false, true, false])
  assert.equal(off[2].tag, S.status.ladderTagNow)
  assert.equal(off[2].tone, 'warn')
  const on = ladderSteps({ ladder: 0, connected: true })
  assert.equal(on[0].tag, S.status.ladderTagNext)
  assert.equal(on[0].tone, 'neutral')
  assert.deepEqual(ladderSteps({ ladder: null }).map((s) => s.current), [false, false, false, false], '段が分からなければ強調しない')
})

test('送信積算のゲージ: まだ読んでいなければ null。70% を超えるか自分から休む線（250 秒）で注意、360 秒で異常。棒は 0〜360 に収める', () => {
  assert.equal(TX_LIMIT_SEC, 360)
  assert.equal(TX_GUARD_SEC, 250)
  assert.equal(txGauge(null), null)
  assert.equal(txGauge(undefined), null)
  assert.deepEqual(txGauge(123456), { used: 123, limit: 360, guard: 250, fill: 123, pct: 34, tone: 'ok' })
  assert.equal(txGauge(249000).tone, 'ok')
  assert.equal(txGauge(250000).tone, 'warn', '自分から休む線')
  assert.equal(txGauge(253000).tone, 'warn', '70% を超えた')
  assert.equal(txGauge(253000).pct, 70)
  const over = txGauge(400000)
  assert.equal(over.tone, 'danger')
  assert.equal(over.fill, 360)
  assert.equal(over.pct, 111)
  assert.equal(txGauge(0).fill, 0)
})

test('預かっているコマンド: 項目が無ければ null（古いサーバー）、0 件は件数だけ、待ち時間は受け取ってからの経過を足して進める', () => {
  assert.equal(pendingView(undefined, 0, 0), null)
  assert.equal(pendingView(null, 0, 0), null)
  assert.equal(pendingView({}, 0, 0), null)
  assert.deepEqual(pendingView({ count: 0, oldestMs: null }, 0, 0), { count: 0, waitSec: null })
  assert.deepEqual(pendingView({ count: 2, oldestMs: 45000 }, 1000, 6000), { count: 2, waitSec: 50 })
  assert.deepEqual(pendingView({ count: 2, oldestMs: 45000 }, 6000, 1000), { count: 2, waitSec: 45 }, '時計が戻っても減らさない')
  assert.deepEqual(pendingView({ count: 1 }, 0, 0), { count: 1, waitSec: null }, '待ち時間が無ければ件数だけ')
})

// ---- はじめに・つながらないときの案内・直近のエラー -------------------------------------------------

const AT = 1_800_000_000_000
const cred = (configured) => ({ configured, source: null, pairId: null })

test('はじめに: 出す条件は「実機でポートが空」か「認証情報が無い」の 2 つだけ', () => {
  assert.equal(needsOnboarding({ mode: 'serial', port: '', credentials: cred(true) }), true)
  assert.equal(needsOnboarding({ mode: 'serial', port: '  ', credentials: cred(true) }), true, '空白だけも空')
  assert.equal(needsOnboarding({ mode: 'serial', port: '/dev/ttyUSB0', credentials: cred(false) }), true)
  assert.equal(needsOnboarding({ mode: 'simulator', port: '', credentials: cred(true) }), false, 'シミュレーターにポートは要らない')
  assert.equal(needsOnboarding({ mode: 'simulator', port: '', credentials: cred(false) }), true)
  assert.equal(needsOnboarding({ mode: 'serial', port: '/dev/ttyUSB0', credentials: cred(true) }), false)
  assert.equal(needsOnboarding({ mode: 'serial', port: '/dev/ttyUSB0' }), false, '認証情報が分からない台は決めつけない')
  assert.equal(needsOnboarding(null), false)
})

// 済 / 未は実際の状態で決める。ボタンを押しただけでは進めない
test('はじめに: 手順の済 / 未 / 失敗は portOpen・credentials・health で決める', () => {
  const base = { mode: 'serial', port: '/dev/ttyUSB0', portLabel: 'USB0', portOpen: false, running: true, connected: false, phase: 'scanning', credentials: cred(true), health: { level: 'busy', reasons: [] } }
  const v = (over, opt) => onboardingView(Object.assign({}, base, over), Object.assign({ now: AT }, opt)).steps
  assert.deepEqual(v({ portOpen: true }).port, { state: 'done', text: S.onboarding.portDone('USB0') })
  assert.deepEqual(v({ port: '', portLabel: '' }).port, { state: 'todo', text: S.onboarding.portTodo })
  assert.deepEqual(v({}).port, { state: 'todo', text: S.onboarding.portWaiting('USB0') })
  assert.deepEqual(v({ health: { level: 'bad', reasons: ['USB が切断されています'] } }).port, { state: 'fail', text: S.onboarding.portFail('USB0', 'USB が切断されています') })
  assert.equal(v({}).cred.state, 'done')
  assert.equal(v({ credentials: cred(false) }).cred.state, 'todo')
  assert.equal(v({}).wait.state, 'todo', 'ポートが開くまで待ちに入らない')
  assert.equal(v({ portOpen: true }).wait.state, 'now')
  assert.equal(v({ portOpen: true }).wait.text, S.status.phaseHelp.scanning)
  assert.equal(v({ portOpen: true, connected: true }).wait.state, 'done')
  // つながらないときの案内があればその文。自動で始めるが外れて止まっていれば「開始」
  const hinted = v({ portOpen: true, connectHint: { kind: 'no-meter', since: AT, rounds: 3 } }).wait
  assert.equal(hinted.text, S.status.hintNoMeter)
  assert.equal(hinted.hint, true)
  const stopped = v({ running: false }, { autoStart: false }).wait
  assert.equal(stopped.text, S.onboarding.pressStart)
  assert.equal(stopped.start, true)
  assert.equal(v({ running: false }, { autoStart: true }).wait.start, false, '自動で始める台には出さない')
})

test('つながらないときの案内: 認証は通らない分数、メーターは文。無ければ null', () => {
  assert.equal(connectHintText({ kind: 'credentials', since: AT - 5 * 60000, rounds: 2 }, AT), S.status.hintCredentials(5))
  assert.equal(connectHintText({ kind: 'credentials', since: AT, rounds: 1 }, AT), S.status.hintCredentials(1), '1 分に満たなくても 0 分とは書かない')
  assert.equal(connectHintText({ kind: 'no-meter', since: AT, rounds: 2 }, AT), S.status.hintNoMeter)
  // 電波が悪いだけでも認証は通らない。正しい値を入れ直させると開き直しでさらに止まるので、電波を先に勧める
  // 戻すと落ちるもの: strings.js の hintCredentials を認証情報の確認だけに戻す
  assert.match(S.status.hintCredentials(5), /認証が 5 分通りません。前はつながっていたなら、電波が弱いことが多いです.*初めての接続なら、B ルートのパスワード/)
  assert.equal(connectHintText(null, AT), null)
  assert.equal(connectHintText({ kind: 'unknown' }, AT), null)
})

test('直近のエラー: 24 時間以内だけ。赤は health が bad のときだけ。そのあと値が届いていれば「その後は計測できています」', () => {
  const a = (over) => Object.assign({ lastError: { message: '機器の文言', hint: '次にすること', at: AT - 3600e3 }, health: { level: 'ok' }, lastValueAt: null }, over)
  assert.deepEqual(lastErrorView(a(), AT), { message: '機器の文言', hint: '次にすること', at: AT - 3600e3, tone: 'neutral', recovered: false })
  assert.equal(lastErrorView(a({ health: { level: 'bad' } }), AT).tone, 'danger')
  assert.equal(lastErrorView(a({ lastValueAt: AT - 60000 }), AT).recovered, true)
  assert.equal(lastErrorView(a({ lastValueAt: AT - 7200e3 }), AT).recovered, false, 'エラーより前の値では戻ったと言わない')
  assert.equal(lastErrorView(a({ lastError: { message: 'x', at: AT - LAST_ERROR_MS - 1 } }), AT), null)
  assert.equal(lastErrorView(a({ lastError: null }), AT), null)
})
