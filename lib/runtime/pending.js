'use strict'

// ============================================================================
//  預かり（コマンドの再接続はノードの中で）
// ============================================================================
//
//  無線かモジュールが要るフローの入力（get・poll・command・diag の epc / propmap・取り直しの要る read）が、
//  未接続・再接続中・ポートを開いている途中に来たら、エラーで返さずに預かって、つながったら来た順に実行する。
//
//  - 待ち行列は registry の AdapterHandle が 1 つ持つ（sequencer を作り直しても同じもの = デプロイをまたいで続く）。
//  - kind:
//      'meter'  … スマートメーターとつながっている（phase が connected・送信制限なし・鍵配信中でない）まで待つ
//      'module' … モジュールだけで答える（SKINFO・SKVER・SKAPPVER・SKTABLE・ROPT・SKSREG）。ポートが開いていれば待たない
//  - meter は 1 台につき 1 本ずつ、来た順に実行する（準備のできたものの中で一番古いもの）。
//    つながった瞬間に 20 件を一度に流すと、sequencer の ECHONET の待ち行列（上限 4）があふれるため。
//    module は meter の実行中でも先に流す（SK コマンドの順は sequencer の _send の列が守る。1.x と同じ）。
//  - meter は、つながった直後の「接続時に 1 度だけ取る値」（係数・単位。sequencer の collectingOnce()）を取り終えてから流す
//    （先に流すと、預かった積算 E0・E3 が未換算のまま出力 1 に出る）。
//  - 待つ長さ（timeoutMs。既定 120 秒）は「つながるまで待つ長さ」: つながっていない間（つながっていない・つなぎ直しを待つ）だけ数える。
//    つながっていて、前のものの実行や接続時の取得の後ろで順番を待っている間は数えない。
//    過ぎたら NOT_CONNECTED（waitedMs は届いてからの長さ）。
//  - reconnect() の直後は、sequencer の相がまだ connected に見える（相が変わるのは 1 秒ごとの見回りのあと）。
//    相が connected になったときの世代（registry の handle.connectedGen）と今の世代が違えば、つながっていないとみなす。
//  - 実行の途中でセッションが切れた（再接続・作り直し・ポートの切断・取り消し）なら、つなぎ直したあとに 1 回だけやり直す。
//  - 外部の指示で止めている（stop・terminate）・無効なら待たずに失敗（STOPPED_BY_OVERRIDE・DISABLED）。
//    待っている間にそうなったら、待っているものもすぐ失敗にする。送信制限（EVENT 32）の間は預かる。
//    実行を始めたあとに送信制限で断られたときも、やり直しの回数に数えずに預かり直す（待つ長さの中で）。
//  - 数の上限（既定 20）を超えたら BUSY。
//  - 未接続のあいだに同じ取得（sig が同じ get・poll・read の取り直し）が重なったら、1 回の取得でまとめて答える（電波を節約）。
//    つながっているときはまとめない（今までどおり 1 通ごとに取得する）。
//  - Node-RED の停止（shutdown）・持ち主のノードの削除（cancelOwner）では SHUTDOWN で返す。
//
//  周期の取得（自動運転）は sequencer が回し、ここを通らない。画面の API（actions・diag）も通らない（すぐ答える）。
//  ここは Node-RED に依存しない。

const { ApiError } = require('./errors')
const { isCommandText } = require('../sequencer')

const DEFAULT_LIMIT = 20
const DEFAULT_TIMEOUT_MS = 120000
/** 送信制限で断られて預かり直す回数の上限（制限が解けたように見えて断られ続ける場合に、回り続けないため）。 */
const MAX_BLOCKED_RETRIES = 10
/** モジュールだけで答えるコマンド（ポートが開いていれば接続を待たない）。 */
const MODULE_COMMANDS = ['SKINFO', 'SKVER', 'SKAPPVER', 'SKTABLE', 'ROPT', 'SKSREG']

/**
 * SK コマンドの種類。モジュールだけで答えるものは 'module'、ほかは 'meter'（接続を待つ）。
 * 改行・制御文字・ASCII 以外の文字を含むものは、先頭だけを見ても中身が分からないので 'meter'（止めている台ではすぐ断る。
 * 送る前に sequencer の raw() が断る。"SKINFO\rWUART 03" を module と読むと、止めた台でも流してしまう）。
 */
function commandKind(command) {
  if (!isCommandText(command)) return 'meter'
  const head = String(command).trim().split(/\s+/)[0].toUpperCase()
  return MODULE_COMMANDS.indexOf(head) >= 0 ? 'module' : 'meter'
}

function sec(ms) {
  const s = ms / 1000
  return s >= 10 ? String(Math.round(s)) : String(Math.round(s * 10) / 10)
}

/**
 * @param {object} o
 * @param {object} o.handle   AdapterHandle（sequencer・meta・reconfiguring・buildError・carriedOverrides を読む）
 * @param {function} [o.now]
 * @param {number} [o.limit]
 * @param {function} [o.log]      (level, text) アダプタのログ
 * @param {function} [o.onChange] 数が変わったとき（画面の状態を出し直す）
 */
function createPendingQueue(o) {
  const handle = o.handle
  const now = typeof o.now === 'function' ? o.now : Date.now
  const limit = typeof o.limit === 'number' && o.limit > 0 ? o.limit : DEFAULT_LIMIT
  const log = typeof o.log === 'function' ? o.log : function () {}
  const onChange = typeof o.onChange === 'function' ? o.onChange : function () {}
  let seqNo = 0
  /** 来た順（待っているものと実行中のもの）。job = {id, kind, sig, label, run, attempts, state, waiters, coalesce} */
  let jobs = []
  /** 実行中の meter（1 本だけ）。module は数えない（meter の実行中でも流す） */
  let runningMeter = null
  let kicking = false
  let rekick = false
  /** 接続時の取得（sequencer の collectingOnce()）の終わりに見直すため、then を付けた Promise */
  let hookedOnce = null

  // --- 状態の読み方 ---------------------------------------------------------------

  function seqNow() {
    return handle && handle.sequencer ? handle.sequencer : null
  }

  function enabled() {
    return !(handle && handle.meta && handle.meta.enabled === false)
  }

  /** 外部の指示の停止（stop・terminate）。作り直しの合間（sequencer が無い）は持ち越している上書きを見る。 */
  function stoppedOf() {
    const seq = seqNow()
    if (seq && seq.state && seq.state.overrides) return seq.state.overrides.stopped || null
    const c = handle && handle.carriedOverrides
    return c && c.stopped ? c.stopped : null
  }

  /**
   * つながっているか（待つ長さの時計を止めるか）。module はポートが開いていれば、meter はメーターとつながっていれば。
   * 送信制限（EVENT 32）の間と、再接続を指示した直後（世代が変わったのに相がまだ connected）は、つながっていないとみなす。
   */
  function connectedFor(kind) {
    const seq = seqNow()
    if (!seq || !seq.state || !enabled() || (handle && handle.reconfiguring)) return false
    const st = seq.state
    if (!st.portOpen || st.keyBlocked) return false
    if (kind === 'module') return true
    if (!st.connected || st.phase !== 'connected' || st.radioBlocked) return false
    return !reconnectRequested(seq)
  }

  /** reconnect() の直後か（相が connected になったときの世代と今の世代が違う）。世代の分からない sequencer は見ない。 */
  function reconnectRequested(seq) {
    const cg = handle ? handle.connectedGen : null
    if (!cg || cg.seq !== seq || typeof cg.gen !== 'number' || typeof seq.generation !== 'number') return false
    return seq.generation !== cg.gen
  }

  /** つながった直後の、接続時に 1 度だけ取る値（係数・単位）を取っている途中か。終わったら見直す。 */
  function collectingOnce(seq) {
    const p = seq && typeof seq.collectingOnce === 'function' ? seq.collectingOnce() : null
    if (!p) return false
    if (typeof p.then === 'function' && hookedOnce !== p) {
      hookedOnce = p
      const again = () => {
        if (hookedOnce === p) hookedOnce = null
        kick()
      }
      p.then(again, again)
    }
    return true
  }

  /** 今すぐ実行を始めてよいか（つながっていて、meter なら接続時の取得も済んでいる）。 */
  function ready(kind) {
    if (!connectedFor(kind)) return false
    return kind === 'module' || !collectingOnce(seqNow())
  }

  /** 接続の段階が変わった回数（registry の handle が phase のイベントと attach で数える）。 */
  function epochNow() {
    return handle && typeof handle.phaseEpoch === 'number' ? handle.phaseEpoch : 0
  }

  /** やり直しを待っているものは、失敗のあとに段階が変わった（つなぎ直した）か。やり直しでなければ true。 */
  function reconnected(job) {
    return job.waitEpoch === null || job.waitEpoch === undefined || epochNow() > job.waitEpoch
  }

  /** 待っても良くならない理由（すぐ失敗にする）。無ければ null。 */
  function hopeless(kind) {
    if (!enabled()) {
      return new ApiError(409, 'DISABLED', 'アダプタが無効です（設定ノードか、Web UI の設定タブで有効にしてください）')
    }
    if (ready(kind)) return null
    const stopped = stoppedOf()
    if (stopped) {
      return new ApiError(
        409,
        'STOPPED_BY_OVERRIDE',
        `外部の指示で停止中のため実行しません（${String(stopped.reason || '外部の指示').slice(0, 200)}）。start か auto で自動運転に戻してください`
      )
    }
    if (!seqNow() && handle && handle.buildError && !handle.reconfiguring) {
      return new ApiError(503, 'PORT_DOWN', 'アダプタを初期化できませんでした（接続先とポートを確かめてください）: ' + handle.buildError.message)
    }
    return null
  }

  function phaseText() {
    const seq = seqNow()
    if (!enabled()) return '無効'
    if (handle && handle.reconfiguring) return '設定の変更で接続し直している途中'
    if (!seq) return 'アダプタを用意している途中'
    const st = seq.state || {}
    if (!st.portOpen) return 'ポートが開いていません'
    if (st.radioBlocked) return '送信制限中（EVENT 32）'
    if (st.keyBlocked) return '鍵の更新中'
    const snap = typeof seq.snapshot === 'function' ? seq.snapshot() : null
    return (snap && snap.phaseText) || String(st.phase || '')
  }

  // --- 数 -------------------------------------------------------------------------

  function count() {
    let n = 0
    for (const j of jobs) n += j.waiters.length
    return n
  }

  function stats() {
    let oldest = null
    let n = 0
    for (const j of jobs) {
      for (const w of j.waiters) {
        n++
        if (oldest === null || w.arrivedAt < oldest) oldest = w.arrivedAt
      }
    }
    return { count: n, oldestMs: oldest === null ? null : Math.max(0, now() - oldest) }
  }

  function changed() {
    try {
      onChange()
    } catch (e) {
      /* 知らせる先の失敗で待ち行列を止めない */
    }
  }

  // --- 待ち ------------------------------------------------------------------------

  /** この job は「つながるのを待っている」か（待つ長さを数える）。つながっていて順番を待っているだけなら false。 */
  function counting(job) {
    return !(connectedFor(job.kind) && reconnected(job))
  }

  /** 待つ長さの時計を進める（残りの長さで張る）。張ってあれば何もしない。 */
  function resumeTimer(job, w) {
    if (w.timer) return
    w.since = now()
    const left = Math.max(0, w.timeoutMs - w.spentMs)
    w.timer = setTimeout(() => expire(job, w), left)
    if (w.timer && w.timer.unref) w.timer.unref()
  }

  /** 待つ長さの時計を止める（それまでの長さは spentMs に足す）。 */
  function clearTimer(w) {
    if (!w.timer) return
    clearTimeout(w.timer)
    w.timer = null
    w.spentMs += Math.max(0, now() - w.since)
  }

  /** 待っている job の時計を、今の状態に合わせる（つながっていない間だけ進める）。 */
  function syncTimers(job) {
    const on = counting(job)
    for (const w of job.waiters) {
      if (on) resumeTimer(job, w)
      else clearTimer(w)
    }
  }

  /**
   * @param {number} waitedMs 届いてからの長さ
   * @param {number} [unreadyMs] そのうち、つながっていなかった長さ（待つ長さで数えた分）
   */
  function notConnected(kind, waitedMs, unreadyMs) {
    const what = kind === 'module' ? 'ポートが開かないまま' : 'メーターとつながらないまま'
    const shown = typeof unreadyMs === 'number' ? unreadyMs : waitedMs
    const total = Math.abs(waitedMs - shown) >= 1000 ? `（届いてから ${sec(waitedMs)} 秒）` : ''
    const e = new ApiError(
      503,
      'NOT_CONNECTED',
      `${what} ${sec(shown)} 秒待ちました${total}（いまの状態: ${phaseText()}）。つながってからもう一度送ってください`
    )
    e.waitedMs = waitedMs
    return e
  }

  function expire(job, w) {
    if (!w.timer) return
    w.timer = null
    w.spentMs += Math.max(0, now() - w.since)
    if (job.state !== 'waiting') return // 実行が始まった（待ちは終わっている）
    // つながっていて順番を待っているだけ（見直しの合図が来ないまま状態が戻った）なら切らない。時計は止めたまま
    if (!counting(job)) {
      kick()
      return
    }
    removeWaiter(job, w)
    w.reject(notConnected(job.kind, Math.max(0, now() - w.arrivedAt), w.spentMs))
    changed()
  }

  function removeWaiter(job, w) {
    const i = job.waiters.indexOf(w)
    if (i >= 0) job.waiters.splice(i, 1)
    if (!job.waiters.length && job.state === 'waiting') removeJob(job)
  }

  function removeJob(job) {
    const i = jobs.indexOf(job)
    if (i >= 0) jobs.splice(i, 1)
  }

  function failJob(job, err) {
    const ws = job.waiters.splice(0)
    for (const w of ws) {
      clearTimer(w)
      w.reject(err)
    }
    removeJob(job)
    if (runningMeter === job) runningMeter = null
  }

  /** 失敗が送信制限（EVENT 32）のせいか（同じ sequencer のまま。作り直し・切断は dropped で見る）。 */
  function radioBlockedNow(job, seq, err) {
    if (job.kind !== 'meter') return false
    const cur = seqNow()
    if (!cur || cur !== seq || !cur.state) return false
    return !!((err && err.blocked) || cur.state.radioBlocked)
  }

  // --- 実行 ------------------------------------------------------------------------

  /** 失敗が「セッションが切れた」せいか（つなぎ直したあとに 1 回だけやり直す）。 */
  function dropped(job, seq, err) {
    const cur = seqNow()
    if (cur !== seq) return true // 作り直した（デプロイ・構成の変更）
    if (!cur || !cur.state) return true
    if (!cur.state.portOpen) return true
    if (err && err.aborted) return true // 再接続・ポートの切断で取り消された
    // 実行の間に sequencer が再接続に入った（reconnect・ポートの切断で世代が変わる）。
    // 応答のタイムアウトのあと、相が変わるのは少し後なので、相だけでなく世代でも見る
    if (typeof job.gen === 'number' && cur.generation !== job.gen) return true
    if (job.kind === 'meter' && (!cur.state.connected || cur.state.phase !== 'connected')) return true
    return false
  }

  function start(job) {
    const seq = seqNow()
    job.state = 'running'
    job.attempts++
    job.gen = seq && typeof seq.generation === 'number' ? seq.generation : null
    if (job.kind === 'meter') runningMeter = job
    for (const w of job.waiters) clearTimer(w)
    let p
    try {
      p = Promise.resolve(job.run(seq))
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(
      (value) => {
        if (runningMeter === job) runningMeter = null
        const ws = job.waiters.splice(0)
        removeJob(job)
        for (const w of ws) w.resolve(value)
        changed()
        kick()
      },
      (err) => {
        if (runningMeter === job) runningMeter = null
        if (!job.waiters.length) {
          removeJob(job)
          kick()
          return
        }
        const stop = hopeless(job.kind)
        const lost = dropped(job, seq, err)
        if (stop && (stop.code === 'STOPPED_BY_OVERRIDE' || stop.code === 'DISABLED')) {
          const e = new ApiError(stop.status, stop.code, stop.message + '（実行の途中で取りやめました: ' + String((err && err.message) || err) + '）')
          failJob(job, e)
        } else if (!lost && radioBlockedNow(job, seq, err) && (job.blockedRetries || 0) < MAX_BLOCKED_RETRIES) {
          // 実行を始めたあとに送信制限（EVENT 32）で断られた: やり直しの回数に数えずに預かり直し、解けたら送る。
          // 待つ長さは前の続きから数える（「解けるまで預かる（待つ長さの中で）」）
          job.state = 'waiting'
          job.attempts--
          job.blockedRetries = (job.blockedRetries || 0) + 1
          log('info', `${job.label}: 送信制限（EVENT 32）で断られたので、解けるまで預かり直します`)
        } else if (job.attempts < 2 && lost) {
          job.state = 'waiting'
          // つなぎ直してから送る。sequencer は reconnect() のあと、少し後に段階（phase）を変えるので、
          // 失敗の直後はまだ connected に見える。段階が変わる（つなぎ直して connected に戻る）まで待つ
          job.waitEpoch = job.kind === 'meter' ? epochNow() : null
          // やり直しは、つなぎ直すのを待つ長さを最初から数える
          for (const w of job.waiters) w.spentMs = 0
          log('warn', `${job.label}: 実行の途中でセッションが切れたので、つなぎ直したあとにもう一度送ります（1 回だけ）`)
        } else {
          failJob(job, err)
        }
        changed()
        kick()
      }
    )
  }

  /** 待っているものを見直す（状態が変わったとき。handle が呼ぶ）。 */
  function kick() {
    if (kicking) {
      rekick = true
      return
    }
    kicking = true
    try {
      do {
        rekick = false
        if (!jobs.length) break
        // 待っても良くならないもの（止めた・無効にした）は、待たずに返す
        let changedNow = false
        for (const job of jobs.slice()) {
          if (job.state !== 'waiting') continue
          const e = hopeless(job.kind)
          if (e) {
            failJob(job, e)
            changedNow = true
          }
        }
        if (changedNow) changed()
        // 待つ長さの時計は、つながっていない間だけ進める（つながっていて順番を待つ間は止める）
        for (const job of jobs) if (job.state === 'waiting') syncTimers(job)
        // 来た順に始める。module は meter の実行中でも流す。meter は 1 本ずつ
        for (const job of jobs.slice()) {
          if (job.state !== 'waiting') continue
          if (job.kind === 'meter' && runningMeter) continue
          if (!ready(job.kind) || !reconnected(job)) continue
          start(job)
        }
      } while (rekick)
    } finally {
      kicking = false
    }
  }

  /**
   * 預ける（準備ができていればすぐ実行する）。
   * @param {object} spec {kind: 'meter'|'module', label, run(seq) → Promise, timeoutMs?, sig?, ownerId?}
   * @returns {Promise} run の結果（失敗は ApiError か、run が投げたもの）
   */
  function submit(spec) {
    const s = spec || {}
    const kind = s.kind === 'module' ? 'module' : 'meter'
    const e = hopeless(kind)
    if (e) return Promise.reject(e)
    if (count() >= limit) {
      return Promise.reject(
        new ApiError(409, 'BUSY', `預かっている指示が上限（${limit} 件）に達しています。つながって片付くまで待ってから送ってください`)
      )
    }
    const timeoutMs = typeof s.timeoutMs === 'number' && isFinite(s.timeoutMs) ? Math.max(0, s.timeoutMs) : DEFAULT_TIMEOUT_MS
    // 「つながっているか」で見る（つながっていて順番を待つだけなら、待つ長さが 0 でも預かる）
    const isConnected = connectedFor(kind)
    if (!isConnected && !(timeoutMs > 0)) return Promise.reject(notConnected(kind, 0))
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, arrivedAt: now(), timeoutMs, spentMs: 0, since: 0, timer: null, ownerId: s.ownerId === undefined ? null : s.ownerId }
      // 未接続のあいだに重なった同じ取得は 1 回にまとめる（まだ 1 度も実行していないものだけ）
      let job = null
      if (!isConnected && s.sig) {
        job = jobs.find((j) => j.state === 'waiting' && j.coalesce && j.sig === s.sig && j.attempts === 0) || null
      }
      if (!job) {
        job = {
          id: ++seqNo,
          kind,
          sig: s.sig || null,
          label: String(s.label || kind),
          run: s.run,
          attempts: 0,
          state: 'waiting',
          waiters: [],
          coalesce: !isConnected && !!s.sig,
        }
        jobs.push(job)
      }
      job.waiters.push(w)
      // 時計は kick の syncTimers が張る（つながっていない間だけ）
      changed()
      kick()
    })
  }

  /** 全部を code で返す（Node-RED の停止など）。返した数。 */
  function rejectAll(err) {
    let n = 0
    for (const job of jobs.slice()) {
      n += job.waiters.length
      failJob(job, err)
    }
    runningMeter = null
    if (n) changed()
    return n
  }

  function shutdown(message) {
    return rejectAll(new ApiError(503, 'SHUTDOWN', message || 'Node-RED を止めるため、預かっていた指示を取りやめました'))
  }

  /** 持ち主（wsuha-broute ノードの id）のものだけを SHUTDOWN で返す（ノードを削除したとき）。返した数。 */
  function cancelOwner(ownerId, why) {
    let n = 0
    for (const job of jobs.slice()) {
      for (const w of job.waiters.slice()) {
        if (w.ownerId !== ownerId) continue
        clearTimer(w)
        removeWaiter(job, w)
        n++
        w.reject(new ApiError(503, 'SHUTDOWN', `${why || 'ノードを削除した'}ため、預かっていた指示を取りやめました`))
      }
    }
    if (n) {
      changed()
      kick()
    }
    return n
  }

  return {
    submit,
    kick,
    stats,
    shutdown,
    rejectAll,
    cancelOwner,
    ready,
    get size() {
      return count()
    },
  }
}

module.exports = { createPendingQueue, commandKind, MODULE_COMMANDS, DEFAULT_LIMIT, DEFAULT_TIMEOUT_MS }
