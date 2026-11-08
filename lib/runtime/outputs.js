'use strict'

// ============================================================================
//  wsuha-broute の出力の形
// ============================================================================
//
//  出力 1 と出力 2 の msg.payload は、どの topic でも「JSON にそのまま変換できるただのオブジェクト」にする
//  （文字列・Buffer・Date・Map・関数・undefined の値・NaN・循環を入れない）。
//  JSON.parse(JSON.stringify(payload)) が元と同じになるので、後ろに json ノードやパーサーを挟まずに使える。
//
//  ・行（raw）とコマンドの結果（command-result・diag）を項目に分けるのは lib/sk-results.js
//    （describeLine・parseCommandResult。行の分け方はシーケンサと同じ sk-protocol）。
//  ・時刻は at（ミリ秒の数）と ts（ISO 8601 の文字列。ローカルの時差つき。出力 1 と同じ isoLocal）の両方。
//    例外は log の ts: 1.x からミリ秒の数で、既存のフローが読んでいる。名前と型はそのままにして、at を足すだけにする。
//  ・ノードは送る直前に必ず plain() を通す（nodes/wsuha-broute.js の send1・send2）。
//  ・秘密: 行は registry の redact（認証 ID・パスワード）を通したものを使う。SKSET… の引数は command に写さない。
//
//  ここは Node-RED に依存しない。

const SK = require('../sk-protocol')
const SR = require('../sk-results')
const { isoLocal } = require('../normalize')
const { isCommandText } = require('../sequencer')

/** JSON の往復で変わらない、ただのオブジェクトにする（sk-results の toJsonSafe）。 */
const plain = SR.toJsonSafe

/** 時刻の 2 つの書き方。at はミリ秒の数、ts は ISO 8601（ローカルの時差つき）。 */
function stamp(at) {
  const t = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
  return { at: t, ts: isoLocal(t) }
}

/**
 * 認証情報を書くコマンド（SKSETPWD・SKSETRBID・SKSETPSK など）の値を伏せる（sk-protocol の maskSecretCommand。
 * 最後の引数だけを伏せると、値のあとに引数が 1 つ多いときに本当の値が残る）。
 * 改行・制御文字・ASCII 以外の文字を含むものは、全部を伏せる（先頭だけを見ると 2 つ目の SKSETPWD の値が出る。
 * そういうコマンドは sequencer の raw() が送る前に断る）。
 */
function maskCommand(command, redact) {
  if (command !== undefined && command !== null && String(command).trim() !== '' && !isCommandText(String(command))) return '********'
  const s = SK.maskSecretCommand(String(command === undefined || command === null ? '' : command).trim())
  return typeof redact === 'function' ? String(redact(s)) : s
}

/**
 * 生の行を項目に分けるときの文脈（sequencer の今の状態から）。
 *   coefficient・unitFactor … ERXUDP の積算電力量を kWh にする（0xD3・0xE1）
 *   command                 … いま実行中の SKSREG（ESREG の値に意味と単位を付ける）。ほかのコマンドは渡さない
 */
function lineContext(seq) {
  const ctx = {}
  if (!seq || !seq.state) return ctx
  const cal = seq.state.calibration || {}
  if (typeof cal.coefficient === 'number' && Number.isFinite(cal.coefficient)) ctx.coefficient = cal.coefficient
  if (typeof cal.unitFactor === 'number' && Number.isFinite(cal.unitFactor)) ctx.unitFactor = cal.unitFactor
  const now = typeof seq.currentCommand === 'function' ? seq.currentCommand() : null
  const cur = typeof now === 'string' ? now : ''
  if (/^SKSREG\s+\S+$/i.test(cur.trim())) ctx.command = cur.trim()
  return ctx
}

/**
 * 出力 2 の raw: {device, deviceKey, at, ts, line, kind, parsed}。
 * @param {object} o {device, deviceKey, line, at?, ctx?, describer?} describer は sk-results の createLineDescriber
 *   （複数行の表やスキャンの続きを分けるため、ノードごとに 1 つ持つ）。無ければ 1 行だけで分ける
 */
function rawPayload(o) {
  const line = o.line === null || o.line === undefined ? '' : String(o.line)
  const d = o.describer ? o.describer.describe(line, o.ctx) : SR.describeLine(line, o.ctx)
  const t = stamp(o.at)
  return plain({
    device: o.device === undefined ? null : o.device,
    deviceKey: o.deviceKey === undefined ? null : o.deviceKey,
    at: t.at,
    ts: t.ts,
    line,
    kind: d.kind,
    parsed: d.parsed,
  })
}

/** sequencer の失敗を、結果の error の形にする（行に FAIL が無いとき。タイムアウト・取り消しなど）。 */
function errorOf(err) {
  const code = err && err.code ? String(err.code) : err && err.timeout ? 'TIMEOUT' : 'FAILED'
  return { code, message: err && err.message ? String(err.message) : '失敗しました', advice: '', retryable: false }
}

/**
 * 1 つの SK コマンドの結果: {command, ok, lines, parsed, error}。
 *   parsed・error は parseCommandResult（最後の成否の行で決める）。sequencer の成否（ok）が分かっていればそれを優先する
 *   （行を集め損ねても、成功を失敗と書かない）。
 * @param {string} command 送ったコマンド（伏せ字済み）
 * @param {string[]} lines このコマンドの間に受け取った行（伏せ字済み）
 * @param {boolean} [ok] sequencer の成否
 * @param {Error} [err] 失敗のときの例外（行に FAIL が無いときの error に使う）
 */
function commandStep(command, lines, ok, err) {
  const r = SR.parseCommandResult(command, lines || [])
  const okv = typeof ok === 'boolean' ? ok : r.ok
  return plain({
    command: String(command === undefined || command === null ? '' : command),
    ok: okv,
    lines: r.lines,
    parsed: okv ? r.parsed : null,
    error: okv ? null : r.error || errorOf(err),
  })
}

/**
 * 出力 2 の command-result: {device, deviceKey, command, ok, at, ts, lines, parsed, error, result}。
 *   result は 1.x の形（sequencer.raw() の戻り値）。1.x のフローが読んでいるかもしれないので残す（足すだけ）。失敗のときは無い。
 * @param {object} o {device, deviceKey, command, lines, ok?, err?, result?, at?}
 */
function commandPayload(o) {
  const s = commandStep(o.command, o.lines, o.ok, o.err)
  const t = stamp(o.at)
  const out = {
    device: o.device === undefined ? null : o.device,
    deviceKey: o.deviceKey === undefined ? null : o.deviceKey,
    command: s.command,
    ok: s.ok,
    at: t.at,
    ts: t.ts,
    lines: s.lines,
    parsed: s.parsed,
    error: s.error,
  }
  if (o.result !== undefined) out.result = o.result
  return plain(out)
}

/**
 * 出力 2 の log: {device, deviceKey, level, text, phase, ts, at}。
 * ts は 1.x からミリ秒の数（既存のフローが読む）。at は同じ時刻（ほかの topic とそろえるために足す）。
 */
function logPayload(entry, o) {
  const e = entry || {}
  const at = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now()
  const out = Object.assign({ device: o.device === undefined ? null : o.device, deviceKey: o.deviceKey === undefined ? null : o.deviceKey }, e)
  if (typeof out.ts !== 'number') out.ts = at
  out.at = at
  return plain(out)
}

/**
 * 出力 2 の phase・event（と、時刻の無い 1.x の形のもの）: 前に device・deviceKey、後ろに at・ts を足す。
 * 中身の項目（phase の from・to・reason・text、event の num・name・sender・param など）は 1.x のまま。
 */
function eventPayload(body, o) {
  const t = stamp(o.at)
  const out = Object.assign({ device: o.device === undefined ? null : o.device, deviceKey: o.deviceKey === undefined ? null : o.deviceKey }, body || {})
  if (out.at === undefined) out.at = t.at
  if (out.ts === undefined) out.ts = t.ts
  return plain(out)
}

/**
 * sequencer.raw(command) を送り、このコマンドを実行している間に受け取った行（伏せ字済み）を集める。
 *
 * 行は sequencer が渡す（raw の onLine。そのコマンドが実行中の間に受け取った行だけ。再試行の間の空きも含めない）。
 * sequencer の待ち行列（_queue・_current）を外から覗かない。
 * ラベルは変えない（失敗したときの lastError.label は 1.x と同じ）。ERXUDP（電波から届いた別の電文）は入れない。
 *
 * @returns {Promise<{result: object, lines: string[]}>} 失敗のときは err.lines に集めた行を付けて投げる
 */
function runCommand(seq, command, redact) {
  const lines = []
  const onLine = (line) => {
    const s = String(line)
    if (/^ERXUDP\b/.test(s)) return
    lines.push(typeof redact === 'function' ? String(redact(s)) : s)
  }
  const p = seq.raw(command, { onLine })
  return Promise.resolve(p).then(
    (result) => ({ result, lines }),
    (err) => {
      if (err && typeof err === 'object') err.lines = lines
      throw err
    }
  )
}

module.exports = {
  plain,
  stamp,
  maskCommand,
  lineContext,
  rawPayload,
  errorOf,
  commandStep,
  commandPayload,
  logPayload,
  eventPayload,
  runCommand,
}
