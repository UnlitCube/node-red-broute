'use strict'

// ============================================================================
//  wsuha-broute — B ルート計測ノード
// ============================================================================
//
//  **このノード 1 つで完結する。入力は繋がなくてよい。**
//
//  デプロイした時点で勝手にポートを開き、スキャンし、PANA 認証し、
//  設定した間隔で計測を続け、切れたら段階的に繋ぎ直す。
//  失敗しても自動運転をやめることは無い (間隔を伸ばして試し続ける)。
//
//  入力は「そのときだけ通常の動きを上書きする」ためのもの。
//  上書きしたことは状態に残り、auto を送れば設定どおりに戻る。
//
//  ノードの下の表示は **USB (シリアルポート) の状態**。
//  使う人が最初に知りたいのは「アダプタが挿さっているか」なので。
//
//  入力 (msg.topic で指示。msg.payload.action でも可):
//
//    ● その場の指示 (状態には残らない)
//      get        payload = 'E7' / ['E7','E8'] / 0xE7  … 指定プロパティを今すぐ取得
//      poll       —                                    … 定期取得の対象を今すぐ 1 回
//      command    payload = 'SKINFO'                   … 任意の SK コマンド
//      reconnect  payload.ladder = 0..3                … 段階を指定して繋ぎ直す
//      status     —                                    … 現在の状態を出力 2 へ
//      clear-radio-block                               … EVENT 33 取りこぼしの手動解除
//
//    ● 続く上書き (解除するまで残る。状態の overrides に出る)
//      デプロイ (全体・設定ノードの変更・無効 → 有効) をまたいで残り、Node-RED の再起動で外れる
//      (registry の AdapterHandle が持ち越す)。設定ノードを削除しても外れる。
//      stop       payload.reason = '点検中'            … 自動運転を止める
//      terminate  —                                    … PANA セッションを終了して止める
//      interval   payload = 60                         … 取得間隔 [秒] (15〜3600 の整数)
//      epcs       payload = ['E7','E0']                … 定期取得するプロパティ (1〜6 個。履歴の E2・E4・EC は不可)
//      interval・epcs の検証は画面の運用設定と同じ。外れたら出力 2 の error に code 'VALIDATION' と details
//
//    ● 上書きの解除
//      start / resume                                  … 止めていた上書きだけ外す
//      auto / reset                                    … 上書きを全部外して設定どおりに戻す
//      interval / epcs に空 (null) を渡しても、その項目だけ戻る
//
//    ● 画面と同じ操作 (画面だけの機能を作らない)
//      settings        payload = {pollIntervalSec?, pollEpcs?, slowIntervalSec?, halfHourIntervalSec?}
//                      … 運用設定を保存して効かせる (null でその項目を外す。msg.rev があれば版を照合)
//      settings-reset  —  … 運用設定を全部外す
//      get-settings    —  … 今の設定を読む
//      diag            payload = {name, args?}  … 診断 (画面の診断と同じ許可リスト。3 秒の制限は掛けない)
//      detail          —  … 画面と同じ形の状態 (AdapterDetail)
//
//    ● 画面と同じ読み出し (画面の GET と同じ関数・同じ検証)
//      trend           payload = {range: '1h'|'6h'|'24h'} か '6h'  … 推移 (直近 24 時間。省略は 1h)
//      logs            payload = {after?, limit?, level?}         … アダプタのログ (古い順。limit は 1〜1000、省略は 200)
//      adapters        —  … 全台の一覧 (AdapterSummary[]) と瞬時電力の合計 (total)
//      meta            —  … 版 (libVersion・diskVersion)・readOnly・configLocked・editorRoot (エディタの入口)・addAdapter・auth
//      返事は入力の msg に topic と payload を入れて出力 2 へ (http in などから配線できるように msg を引き継ぐ)
//
//    ● 構成と認証情報 (画面の「構成」と同じ。readOnly・uiConfig は画面だけに効き、ここには掛からない)
//      config            payload = {name?, role?, enabled?, mode?, serialport?, serialbaud?, deviceKey?, expectedMac?, autoStart?, scanDurations?}
//                        … 構成を保存して効かせる (null でその項目を外す。msg.rev があれば版を照合)。
//                          接続に関わる項目が変わったら、この台だけ SKTERM してポートを開き直す
//      config-reset      —  … 画面かフローで変えた構成を全部外す (設定ノードの値に戻す)
//      get-config        —  … 今の構成を読む (Config。認証情報の値は入らない)
//      credentials       payload = {routeBId, routeBPassword}  … B ルート認証情報を保存する (返事に値は入れない)
//      credentials-reset —  … 画面かフローで保存した認証情報を消す
//      serialports       —  … ポートの候補 (by-id を先に。使っている台は ownedBy)
//
//    ● 最新値の読み出し (ノードの中に最新値を持っていて、読み出しの指示が来たらすぐ出す)
//      read  payload = なし / 'E7' / ['E7','E8'] / {epcs, keys, maxAgeSec}  … 持っている値で、無線を使わずにすぐ出力 2 の read へ
//            (入力の msg を引き継ぐ)。maxAgeSec (payload か msg.maxAgeSec) より古い・無い値があるときだけ、取りに行ってから答える
//
//    ● 預かり (フローが再接続を気にしなくて済むように、コマンドの待ちはノードの中で持つ)
//      get・poll・command・diag (epc / propmap と SK コマンド)・取り直しの要る read は、未接続・再接続中・ポートを開いている途中に
//      来たらエラーにせず預かり、つながったら来た順に実行する (registry の AdapterHandle の pending。デプロイをまたいで続く)。
//      モジュールだけで答えるコマンド (SKINFO・SKVER・SKAPPVER・SKTABLE・ROPT・SKSREG) はポートが開いていれば待たない。
//      待つ長さはこのノードの「つながるまで待つ長さ」(waitSec。既定 120) か msg.timeoutSec。過ぎたら error (NOT_CONNECTED・waitedMs)。
//      途中で切れたら 1 回だけやり直す。無効ならすぐ error (DISABLED)。止めている (stop・terminate) ときは、
//      メーターが要るもの (get・poll・電波の diag・read の取り直し) はすぐ error (STOPPED_BY_OVERRIDE)、
//      モジュールだけで答えるコマンドはポートが開いていれば実行する (pending.js の hopeless は ready を先に見る)。上限 20 で BUSY。
//      改行・制御文字・ASCII 以外の文字を含む command は預からずに VALIDATION、FLASH を消耗するものは FORBIDDEN_COMMAND。
//      reconnect の ladder は 0〜3 の整数 (外れたら VALIDATION)。止めている台への reconnect は STOPPED_BY_OVERRIDE (画面の API と同じ)。
//      構成の変更で開き直している途中は、預からない topic (status・stop・reconnect など) を BUSY で断る。
//      Node-RED の停止とノードの削除では SHUTDOWN。返事は、デプロイでこのノードを作り直していたら、同じ id の新しいノードから出す
//
//  出力 1 (計測値): 1 回の取得につき 1 通。正規化した JSON。
//    Web UI の診断で取った値 (measurement の purpose が 'diag') は出さない。
//    {
//      "device": "電力", "deviceKey": "usb0", "port": "/dev/ttyUSB0",
//      "ts": "2026-09-24T15:10:00+09:00",
//      "meter": { "panId": "1234", "channel": 33, "mac": "...", "lqi": 99 },
//      "values": {
//        "instantPower":   { "value": 4220, "unit": "W",   "epc": "E7", ... },
//        "instantCurrent": { "r": 19, "t": 25, "unit": "A", "epc": "E8", ... }
//      }
//    }
//
//  出力 2 (状態の変化とイベント): topic = status / phase / event / log / error など
//    status の payload には health (画面と同じ健康の判定) が付く。
//    credentials は画面と同じ {configured, source, pairId} (1.x の idHint = 認証 ID の先頭と末尾 4 桁は 2.0 で外した)。
//    settings は運用設定が変わったとき (画面・フロー・エディタのデプロイのどれでも)、
//    同じ設定ノードを使う全部の wsuha-broute から 1 通ずつ出る (msg.changedBy に 'web-ui' / 'flow:<名前>' / 'editor')。
//    config も同じ規則で、構成 (と認証情報の出どころ) が変わったときに出る。
//
//  出力の形: 出力 1 と出力 2 の payload は、どの topic でも JSON にそのまま変換できるただのオブジェクト。
//    送る直前に必ず lib/runtime/outputs.js の plain() を通す (send1・send2。node.send を直に呼ばない)。
//    raw            {device, deviceKey, at, ts, line, kind, parsed}           (1.x は行の文字列だった。行は payload.line)
//    command-result {device, deviceKey, command, ok, at, ts, lines, parsed, error, result}
//                   (アダプタが FAIL を返した・応答が無いときも ok: false で出し、続けて error)
//    diag           画面の API と同じ {ok, name, at, result} に device・command・ts・lines・parsed・error・commands
//    log            {device, deviceKey, level, text, phase, ts, at}           (ts は 1.x からミリ秒の数のまま。既存のフローが読むので変えない)
//    phase・event   1.x の項目の前に device・deviceKey、後ろに at・ts
//    status・recovered・alert・error  1.x の項目 (ts は ISO の文字列のまま) に at (ミリ秒の数) を足す
//    status には pendingCommands {count, oldestMs} (預かっている数といちばん古いものの待ち時間)。
//    error には預かりの待ちを過ぎたとき waitedMs
//    read           {device, deviceKey, ts, at, maxAgeSec, values: {key: {epc, name, value, unit, display, at, ts, fresh, ageSec}}, missing, refreshed}

const { toEpc, isLadder, LADDER_MAX, commandTextProblem, forbiddenRawCommand } = require('../lib/sequencer')
const { normalize } = require('../lib/normalize')
const vm = require('../lib/runtime/view-model')
const svc = require('../lib/runtime/service')
const { ApiError, mapError } = svc
const pendingLib = require('../lib/runtime/pending')
const readValues = require('../lib/runtime/read-values')
const { validateSettingsInput } = require('../lib/runtime/settings-store')
const { authMeta } = require('../lib/runtime/editor-auth')
const outputs = require('../lib/runtime/outputs')
const { createLineDescriber } = require('../lib/sk-results')

/**
 * 画面と同じ操作と読み出しの topic。設定ノードが無効でも sequencer が無くても受け付ける。
 * 返事は入力と同じ topic (settings-reset と get-settings は settings、config-reset と get-config は config、
 * credentials-reset は credentials)。diag は預かりの道 (heldDiag) を通るので、ここには入れない。
 */
const SHARED_TOPICS = [
  'settings',
  'settings-reset',
  'get-settings',
  'detail',
  'trend',
  'logs',
  'adapters',
  'meta',
  // 構成と認証情報
  'config',
  'config-reset',
  'get-config',
  'credentials',
  'credentials-reset',
  'serialports',
  // アダプタの追加
  'add-adapter',
]

/** 預かるフローの入力。diag と取り直しの要る read も預かる (それぞれの道で)。 */
const HELD_TOPICS = ['get', 'poll', 'command', 'raw']
/** つながるまで待つ長さの範囲と既定 (ノードの設定 waitSec・msg.timeoutSec)。 */
const WAIT_SEC_DEFAULT = 120
const WAIT_SEC_MAX = 3600

/** つながるまで待つ長さ [秒] を読む (0〜3600 の数か数字の文字列)。読めなければ null。 */
function waitSecOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= WAIT_SEC_MAX ? v : null
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const n = parseFloat(v)
    return n <= WAIT_SEC_MAX ? n : null
  }
  return null
}

/**
 * フローの入力 command を預かる前に断るもの (sequencer の raw() と同じ規則。規則そのものは sequencer にある)。
 *   改行・制御文字・ASCII 以外の文字を含む・空 → 422 VALIDATION ("SKINFO\rWUART 03" が先頭だけの検査を抜けていた)
 *   FLASH を消耗する・シーケンサが持っている → 403 FORBIDDEN_COMMAND
 * 断るなら ApiError、送ってよければ null。
 */
function forbiddenCommand(cmd) {
  const text = commandTextProblem(cmd)
  if (text) return new ApiError(422, 'VALIDATION', text, { command: text })
  const why = forbiddenRawCommand(String(cmd))
  if (why) return new ApiError(403, 'FORBIDDEN_COMMAND', why)
  return null
}

/**
 * フローの入力 reconnect の段階 (payload.ladder)。画面の API (POST actions/reconnect) と同じく 0〜3 の整数か、無し。
 * 外れたら 422 VALIDATION。段の数は再試行の待ちの長さにも効くので、範囲の外を通さない。
 */
function ladderOf(body) {
  const v = body && typeof body === 'object' ? body.ladder : undefined
  if (v === undefined || v === null) return undefined
  if (!isLadder(v)) {
    throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { ladder: `0〜${LADDER_MAX} の整数で指定してください` })
  }
  return v
}

module.exports = function (RED) {
  // --- 預かったものの返事の届け先 ----------------------------------------
  // 預かりは registry の AdapterHandle が持ち、デプロイ (設定ノードとこのノードの作り直し) をまたいで続く。
  // 返事は、頼んだノードがまだ居ればそのノードの send / done で、デプロイで作り直していたら同じ id の新しいノードから出す
  // (エラーは新しいノードの error(err, msg) で Catch に渡す)。作り直しの途中 (閉じて次がまだ居ない) に済んだものは、
  // 次ができたら出し、デプロイが済んでも (flows:started) 次が居なければ Node-RED のログに 1 行残して捨てる。
  const live = new Map() // ノードの id → 今のノード
  const mailbox = new Map() // ノードの id → [届けそこねた返事]
  if (RED.events && typeof RED.events.on === 'function') {
    RED.events.on('flows:started', () => {
      for (const [id, list] of Array.from(mailbox.entries())) {
        if (live.has(id)) continue
        mailbox.delete(id)
        try {
          if (RED.log && typeof RED.log.warn === 'function') {
            RED.log.warn(`[wsuha-broute] 預かっていた ${list.length} 件の返事を出せませんでした（送り元のノード ${id} がデプロイのあとに見つかりません）`)
          }
        } catch (e) {
          /* ログに出せなくても続ける */
        }
      }
    })
  }

  /**
   * 預かったものの結果を返す。ticket = {action, ownerId, node, msg, send, done, data, handle}、outcome = {ok, value | err}。
   */
  function deliver(ticket, outcome) {
    const cur = live.get(ticket.ownerId)
    let target = null
    let send = null
    let done = null
    if (cur && cur === ticket.node) {
      target = cur
      send = ticket.send
      done = ticket.done
    } else if (cur) {
      // デプロイで作り直した: 同じ id の新しいノードから出す
      target = cur
      send = (m) => cur.send(m)
      done = (err) => {
        if (err) cur.error(err, ticket.msg)
      }
    } else if (!outcome.ok && outcome.err && outcome.err.code === 'SHUTDOWN') {
      // Node-RED の停止・ノードの削除: 頼んだノードの send / done で返してみる (届く先が閉じていても落とさない)
      target = ticket.node
      send = ticket.send
      done = ticket.done
    } else {
      const list = mailbox.get(ticket.ownerId) || []
      list.push([ticket, outcome])
      mailbox.set(ticket.ownerId, list)
      return
    }
    try {
      target._wsuhaReply(ticket, outcome, send, done)
    } catch (err) {
      try {
        target.error('預かっていた指示の返事を出せませんでした: ' + ((err && err.message) || err))
      } catch (e) {
        /* 返せなくても続ける */
      }
    }
  }

  function WsuhaBrouteNode(config) {
    RED.nodes.createNode(this, config)
    const node = this

    node.device = config.device ? RED.nodes.getNode(config.device) : null
    if (!node.device) {
      // 設定が無い (アダプタを選んでいない) と、id はあるのに見つからない (設定ノードの下の帯で無効にした・消した) を分ける
      if (!config.device) {
        node.status({ fill: 'red', shape: 'ring', text: 'アダプタ未設定' })
        node.error('Wi-SUN アダプタを選んでいません（編集画面の「アダプタ」で選んでください）')
      } else {
        node.status({ fill: 'red', shape: 'ring', text: 'アダプタが無効か、見つかりません' })
        node.error('Wi-SUN アダプタが無効か、見つかりません（設定ノードの下の帯が「無効」になっていないか、消していないかを確かめてください）')
      }
      return
    }

    // 購読先は sequencer ではなく AdapterHandle (lib/runtime/registry.js)。
    // handle は設定ノードが sequencer を作り直しても同じオブジェクトなので、
    // このノードと設定ノードのどちらが先に作られても、再デプロイで出力が止まらない。
    const handle = node.device.handle
    if (!handle) {
      node.status({ fill: 'red', shape: 'ring', text: 'アダプタが無効か、見つかりません' })
      node.error('Wi-SUN アダプタを初期化できていません（接続先とポートを確かめてください）')
      return
    }

    const emitMeasurements = config.emitMeasurements !== false
    const emitStatus = config.emitStatus !== false
    const emitLogs = config.emitLogs === true
    const emitRaw = config.emitRaw === true

    // 名前・契約・ポートは画面とフローの構成の変更で、開き直さずに変わる。使うたびに設定ノードから読む
    const dev = node.device
    const portLabelNow = () => dev.portLabel || 'USB'
    const roleNow = () => dev.role || dev.deviceKey || null
    // 画面の API と同じ service (運用設定・診断・状態)。設定ノードが作る
    const service = node.device.runtime ? node.device.runtime.service : null
    // 運用設定を変えた経路。ログインが無いので人ではなくノードの名前か id
    const by = 'flow:' + (config.name || node.id)
    // つながるまで待つ長さ [秒] (預かりの上限。既定 120 秒。msg.timeoutSec で 1 通ごとに変えられる)。
    // 空・1.x のフロー (項目なし) は既定。範囲 (0〜3600) の外は既定にして warn
    let waitSec = WAIT_SEC_DEFAULT
    if (config.waitSec !== undefined && config.waitSec !== null && config.waitSec !== '') {
      const w = waitSecOf(config.waitSec)
      if (w === null) node.warn(`つながるまで待つ長さ ${String(config.waitSec).slice(0, 20)} は範囲（0〜${WAIT_SEC_MAX} 秒）の外なので、既定の ${WAIT_SEC_DEFAULT} 秒を使います`)
      else waitSec = w
    }

    let lastPower = null

    // --- 出力 (payload は全部 JSON にそのまま変換できるただのオブジェクト) -----------------
    // node.send を直に呼ばず、必ずここを通す。送る直前に plain() で Buffer・Date・undefined・NaN・循環を落とす
    const sendOf = (send) => (typeof send === 'function' ? send : node.send.bind(node))
    function send1(msg, send) {
      msg.payload = outputs.plain(msg.payload)
      sendOf(send)([msg, null])
    }
    function send2(msg, send) {
      msg.payload = outputs.plain(msg.payload)
      sendOf(send)([null, msg])
    }
    /** 出力の device・deviceKey (名前・契約は構成の変更で開き直さずに変わるので、使うたびに読む)。 */
    const who = () => ({ device: roleNow(), deviceKey: node.device.deviceKey })
    // 受信した生の行を項目に分ける道具 (表やスキャンの複数行の続きを覚える)。生の行を出すときだけ作る
    let describer = null

    // --- 復旧しない状態を 1 度だけ知らせる --------------------------------
    //
    // 無人運転では誰も画面を見ていない。このノードは失敗しても運転をやめない
    // ので、放っておくと「ずっと繋ごうとしているが繋がらない」まま静かに続く。
    //
    // 設定ノード側の node.error() は Catch ノードで拾えない (config ノードには
    // z が無い)。通知に回せるよう、パレット側のこのノードから msg 付きで上げる。
    // msg を付けないと Node-RED は Catch へ流さず、ログに出るだけになる。
    //
    // 毎回上げると再試行のたびに鳴り続けるので、繋がるまで 1 度きりにする。
    const alertAfter = config.alertAfterFailures === undefined ? 3 : Number(config.alertAfterFailures)
    let alerted = false

    function checkPersistentFailure(s) {
      if (!s) return
      if (s.phase === 'connected') {
        // 復旧は、繋がったときでなく定期の値が届いて連続失敗が 0 に戻ったときに知らせる。
        // 接続の確認にだけ答えるメーターで、繋ぎ直すたびに recovered と alert が往復しないように
        if (alerted && !(s.consecutiveFailures > 0)) {
          alerted = false
          node.log(`${portLabelNow()}: 接続が復旧しました`)
          send2({ topic: 'recovered', payload: withMeta(s) })
        }
        return
      }
      if (alerted || !alertAfter) return
      if ((s.consecutiveFailures || 0) < alertAfter) return

      alerted = true
      const why = (s.lastError && s.lastError.message) || s.phaseText || s.phase
      const text = `${portLabelNow()}${roleNow() ? '（' + roleNow() + '）' : ''}: ${s.consecutiveFailures} 回続けて接続できません — ${why}`
      const t = outputs.stamp()
      const alert = {
        topic: 'alert',
        payload: {
          device: roleNow(),
          deviceKey: node.device.deviceKey,
          port: node.device.portPath,
          phase: s.phase,
          consecutiveFailures: s.consecutiveFailures,
          ladder: s.ladder,
          reason: why,
          ts: t.ts,
          at: t.at,
        },
      }
      send2(alert)
      // 第 2 引数 (msg) を渡すことで Catch ノードが拾えるようになる
      node.error(text, alert)
    }

    /**
     * ノードの下の表示。
     * 色は「USB が使えているか」を最優先で表す。
     *   赤  … ポートが開いていない (ドングルが抜けている / 他が掴んでいる)
     *   黄  … ポートは開いたが、メーターとはまだ繋がっていない
     *   緑  … 計測できている
     */
    function updateStatus() {
      if (node.device.enabled === false) {
        node.status({ fill: 'grey', shape: 'ring', text: `${portLabelNow()} 無効` })
        return
      }
      const s = handle.snapshot()
      if (!s) {
        node.status({ fill: 'grey', shape: 'ring', text: `${portLabelNow()} 停止` })
        return
      }
      if (!s.portOpen) {
        node.status({ fill: 'red', shape: 'ring', text: `${portLabelNow()} 切断` })
        return
      }
      // 外からの指示で止まっているときは、故障と区別できるように必ず書く。
      // 無人運転では「なぜ止まっているのか」が最初に要る情報になる。
      if (s.overrides && s.overrides.stopped) {
        node.status({ fill: 'blue', shape: 'ring', text: `${portLabelNow()} 外部の指示で停止中` })
        return
      }
      if (s.phase === 'connected') {
        const p = lastPower === null ? '計測中' : `${lastPower} W`
        const mark = s.overrides && s.overrides.any ? ' ✎' : ''
        node.status({ fill: 'green', shape: 'dot', text: `${portLabelNow()} 接続 / ${p}${mark}` })
        return
      }
      const extra = s.radioBlocked ? '送信制限中' : s.keyBlocked ? '鍵の更新中' : s.phaseText
      const retry = s.consecutiveFailures > 1 ? `（再試行 ${s.consecutiveFailures}）` : ''
      node.status({ fill: 'yellow', shape: 'ring', text: `${portLabelNow()} ${extra}${retry}` })
    }

    // --- 購読 ------------------------------------------------------------
    // ハンドラは名前付きで持って close のときに確実に外す。
    // 外し忘れると、再デプロイのたびに同じメッセージが二重に流れる。
    const handlers = {
      measurement(result) {
        const seq = handle.sequencer
        const power = (result.values || []).find((v) => v.epc === 0xe7)
        if (power && typeof power.value === 'number') lastPower = power.value
        updateStatus()

        if (!emitMeasurements) return
        // Web UI の診断（任意の EPC・プロパティマップ）で取った値は出力 1 に流さない。
        // 出力 1 は DB などへ流している計測値で、診断のたびに同じ形の値が混ざると困る。
        // フローの入力の get / poll (manual) は今までどおり出す
        if (result && result.purpose === 'diag') return
        const payload = normalize(result, {
          role: roleNow(),
          deviceKey: node.device.deviceKey,
          port: node.device.portPath,
          meter: seq ? seq.state.meter : null,
          calibration: seq ? seq.state.calibration : null,
        })
        send1({ topic: roleNow() || 'wsuha', payload })
      },

      status(snapshot) {
        checkPersistentFailure(snapshot)
        if (emitStatus) send2({ topic: 'status', payload: withMeta(snapshot) })
        updateStatus()
      },

      phase(change) {
        // {device, deviceKey, from, to, reason, text, at, ts}
        if (emitStatus) send2({ topic: 'phase', payload: outputs.eventPayload(change, who()) })
        updateStatus()
      },

      log(entry) {
        // {device, deviceKey, level, text, phase, ts, at}。ts は 1.x からミリ秒の数 (既存のフローが読むので変えない)
        if (emitLogs) send2({ topic: 'log', payload: outputs.logPayload(entry, who()) })
      },

      sk(event) {
        // 自発イベントだけ。コマンドの応答まで流すと量が多すぎる。
        // {device, deviceKey, kind, raw, num, numHex, name, severity, sender, side, param, udp?, at, ts}
        if (emitStatus && event.kind === 'event') {
          send2({ topic: 'event', payload: outputs.eventPayload(event, who()) })
        }
      },

      raw(line) {
        // {device, deviceKey, at, ts, line, kind, parsed} (1.x は行の文字列だった)。行は registry で伏せ字済み
        if (!emitRaw) return
        if (!describer) describer = createLineDescriber()
        const w = who()
        const payload = outputs.rawPayload({
          device: w.device,
          deviceKey: w.deviceKey,
          line,
          ctx: outputs.lineContext(handle.sequencer),
          describer,
        })
        send2({ topic: 'raw', payload, device: w.device })
      },

      mismatch(info) {
        node.error(`${portLabelNow()}: 想定と違うアダプタがつながっています（想定 ${info.expected} / 実際 ${info.actual}）`)
      },

      // 運用設定が変わった (画面・ほかのノードの入力・エディタのデプロイ)
      // 自分の入力で変えたときは、入力の msg で返事をするのでここでは出さない (1 ノード 1 通)
      settings(ev) {
        if (ev && ev.origin === node) return
        const s = settingsNow()
        if (s) send2({ topic: 'settings', payload: s, changedBy: ev ? ev.by : null })
      },

      // 構成 (と認証情報の出どころ) が変わった (画面・ほかのノードの入力・エディタのデプロイ)
      // payload は Config (認証情報の値は入らない)。自分の入力で変えたときは返事の 1 通だけ
      config(ev) {
        if (ev && ev.origin === node) return
        const c = configNow()
        if (c) send2({ topic: 'config', payload: c, changedBy: ev ? ev.by : null })
      },
    }

    function configNow() {
      if (!service) return null
      try {
        return service.configOf(handle)
      } catch (err) {
        node.warn('接続の設定を読めませんでした: ' + err.message)
        return null
      }
    }

    function settingsNow() {
      if (!service) return null
      try {
        return service.settingsOf(handle)
      } catch (err) {
        node.warn('運用設定を読めませんでした: ' + err.message)
        return null
      }
    }

    /**
     * 画面と同じ健康の判定 (Health) と、認証情報の安全な形 (AdapterDetail の credentials と同じ)。
     * status の payload に付ける。
     */
    function viewNow() {
      try {
        const d = vm.buildDetail(handle.inspect(), Date.now())
        return { health: d.health, credentials: d.credentials }
      } catch (err) {
        return { health: null, credentials: null }
      }
    }

    // 状態メッセージの外枠。
    // snapshot にも device (アダプタの版・MAC) があるので、後ろに置くと
    // 契約名が上書きされて device が [object Object] になる。必ず前に重ねる。
    //
    // credentials は snapshot のもの (idHint = 認証 ID の先頭 4 桁と末尾 4 桁) を出さず、
    // 画面と同じ {configured, source, pairId} に置き換える (認証 ID の一部も外へ出さない)。
    // 1.x のダッシュボードは status を認証の無い /ui に流していた。pairId は ID の下 8 桁 (電波にも出る値)
    function withMeta(snapshot) {
      const v = viewNow()
      const c = (snapshot && snapshot.credentials) || {}
      const t = outputs.stamp()
      return Object.assign({}, snapshot, {
        adapter: snapshot.device,
        device: roleNow(),
        deviceKey: node.device.deviceKey,
        port: node.device.portPath,
        health: v.health,
        credentials: v.credentials || { configured: !!c.configured, source: handle.redact(c.source || null), pairId: null },
        // 預かっている数と、いちばん古いものの待ち時間
        pendingCommands: vm.pendingOf({ pending: handle.pending ? handle.pending.stats() : null }),
        ts: t.ts,
        at: t.at,
      })
    }

    // --- 画面と同じ操作 -------------------------------------
    // 中身は lib/runtime/service.js で、画面の API (http-api.js) と同じ検証・同じ settings-store を通る。
    // 返事は入力の msg を引き継いで出す (http in → このノード → http response のように配線できる)。

    /** 入力の payload から設定の本文を作る (payload.action は項目に数えない)。オブジェクトでなければそのまま (検証で断る)。 */
    function settingsBody(msg) {
      const p = msg.payload
      if (!p || typeof p !== 'object' || Array.isArray(p)) return p
      const out = {}
      for (const k of Object.keys(p)) if (k !== 'action') out[k] = p[k]
      return out
    }

    /** msg.rev (If-Match)。無ければ版を照合しない。 */
    function revOf(msg) {
      return msg.rev === undefined || msg.rev === null || msg.rev === '' ? undefined : String(msg.rev)
    }

    async function shared(action, msg, send) {
      if (!service) {
        throw new ApiError(503, 'PORT_DOWN', '運用設定と診断の仕組みを初期化できていません（Node-RED のログを確かめてください）')
      }
      switch (action) {
        case 'settings':
          msg.payload = service.saveSettings(handle, settingsBody(msg), { by, ifMatch: revOf(msg), origin: node })
          msg.topic = 'settings'
          msg.changedBy = by
          break
        case 'settings-reset':
          msg.payload = service.clearSettings(handle, { by, ifMatch: revOf(msg), origin: node })
          msg.topic = 'settings'
          msg.changedBy = by
          break
        case 'get-settings':
          msg.payload = service.settingsOf(handle)
          msg.topic = 'settings'
          delete msg.changedBy // 変化ではない
          break
        // diag は預かりの道 (input の heldDiag)。ここには来ない
        case 'detail':
          msg.payload = service.detailOf(handle)
          msg.topic = 'detail'
          break
        // --- 読み出し (画面の GET と同じ関数・同じ検証。外れたら VALIDATION) ---
        case 'trend':
          msg.payload = service.trendOf(handle, readArgs(msg, 'range').range)
          msg.topic = 'trend'
          break
        case 'logs':
          msg.payload = service.logsOf(handle, readArgs(msg, null))
          msg.topic = 'logs'
          break
        case 'adapters':
          msg.payload = service.listAdapters()
          msg.topic = 'adapters'
          break
        case 'meta':
          // Web UI の GET meta と同じ形にする (認証の状態は service の外で決まるので、ここで足す)
          msg.payload = Object.assign(service.metaOf(), { auth: authMeta(RED.settings, svc.editorRootOf(RED.settings)) })
          msg.topic = 'meta'
          break
        // --- 構成と認証情報 (画面の PUT / DELETE config・credentials・GET serialports と同じ) ---
        case 'config':
          msg.payload = service.saveConfig(handle, settingsBody(msg), { by, ifMatch: revOf(msg), origin: node })
          msg.topic = 'config'
          msg.changedBy = by
          break
        case 'config-reset':
          msg.payload = service.clearConfig(handle, { by, ifMatch: revOf(msg), origin: node })
          msg.topic = 'config'
          msg.changedBy = by
          break
        case 'get-config':
          msg.payload = service.configOf(handle)
          msg.topic = 'config'
          delete msg.changedBy
          break
        case 'credentials': {
          // 値は返事に入れない (入力の payload を消してから、出どころと「設定済み」だけを入れる)
          const body = settingsBody(msg)
          msg.payload = null
          msg.payload = service.saveCredentials(handle, body, { by, origin: node })
          msg.topic = 'credentials'
          msg.changedBy = by
          break
        }
        case 'credentials-reset':
          msg.payload = service.clearCredentials(handle, { by, origin: node })
          msg.topic = 'credentials'
          msg.changedBy = by
          break
        case 'serialports':
          msg.payload = await service.serialPorts()
          msg.topic = 'serialports'
          break
        // --- アダプタの追加 (画面の POST adapters と同じ関数。readOnly・uiConfig・uiAddAdapter は掛けない) ---
        case 'add-adapter': {
          // 値は返事に入れない (入力の payload を消してから、結果だけを入れる)
          const body = settingsBody(msg)
          msg.payload = null
          msg.payload = await service.addAdapter(body, { by })
          msg.topic = 'add-adapter'
          msg.changedBy = by
          break
        }
      }
      send2(msg, send)
    }

    /**
     * 送ったコマンドが失敗したとき (アダプタが FAIL を返した・応答が無い)。結果として ok: false の形を出せるもの。
     * 送る前に断ったもの (FLASH を消耗するコマンド・ポートが閉じている・取り消し・送信制限) は error だけにする。
     */
    function answeredFailure(err) {
      return !!(err && (/^(ER\d\d|FAIL)$/.test(String(err.code || '')) || err.timeout === true))
    }

    /** error の payload (1.x の {device, action, message, ts} に code・details と deviceKey・at を足す)。 */
    function errorPayload(action, e) {
      const t = outputs.stamp()
      const payload = { device: roleNow(), action, message: e.message, ts: t.ts }
      if (e.code) payload.code = e.code
      if (e.details) payload.details = e.details
      // 預かりの待つ長さを過ぎた (NOT_CONNECTED) ときの、待った長さ [ms]
      if (typeof e.waitedMs === 'number' && isFinite(e.waitedMs)) payload.waitedMs = e.waitedMs
      payload.deviceKey = node.device.deviceKey
      payload.at = t.at
      return payload
    }

    /**
     * 読み出しの引数。payload がオブジェクトならそのまま (payload.action は読まない)。
     * 文字列なら key の値として読む (trend の '6h')。それ以外 (inject の時刻など) は引数なし。
     */
    function readArgs(msg, key) {
      const p = msg.payload
      if (p && typeof p === 'object' && !Array.isArray(p)) return p
      if (key && typeof p === 'string') return { [key]: p }
      return {}
    }

    // --- 預かりと最新値の読み出し --------------------------------------
    // 無線かモジュールが要る入力は handle.pending に預け、つながったら来た順に実行する。
    // 返事は deliver() (モジュールの頭) が、このノードかデプロイで作り直した同じ id のノードの _wsuhaReply で出す。

    /** この msg の待つ長さ [ms]。msg.timeoutSec (0〜3600 秒) かノードの設定。外れたら VALIDATION。 */
    function waitMsOf(msg) {
      if (msg.timeoutSec === undefined || msg.timeoutSec === null || msg.timeoutSec === '') return waitSec * 1000
      const w = waitSecOf(msg.timeoutSec)
      if (w === null) {
        throw new ApiError(422, 'VALIDATION', `つながるまで待つ長さ（msg.timeoutSec）を確かめてください: 0〜${WAIT_SEC_MAX} の秒数`, {
          timeoutSec: `0〜${WAIT_SEC_MAX} の秒数で指定してください`,
        })
      }
      return w * 1000
    }

    /**
     * 預ける。spec は pending の submit と同じ ({kind, label, run, sig?})。data は返事を作るのに要るもの。
     * 結果はモジュールの頭の deliver() が、頼んだ (かデプロイで作り直した) ノードの _wsuhaReply で返す。
     */
    function hold(action, msg, send, done, spec, data) {
      const ticket = { action, ownerId: node.id, node, msg, send, done, data: data || {}, handle }
      let p
      try {
        p = handle.pending.submit(Object.assign({ ownerId: node.id, timeoutMs: waitMsOf(msg) }, spec))
      } catch (err) {
        p = Promise.reject(err)
      }
      p.then(
        (value) => deliver(ticket, { ok: true, value }),
        (err) => deliver(ticket, { ok: false, err })
      )
    }

    /** 今までの topic (get・poll・command) の失敗: 1.x と同じく新しい msg の error (code・details・waitedMs つき) と done(err)。 */
    function failNew(t, err, send, done) {
      const mapped = mapError(err)
      const payload = errorPayload(t.action, {
        message: (err && err.message) || String(err),
        code: mapped ? mapped.code : null,
        details: err instanceof ApiError ? err.details : null,
        waitedMs: err ? err.waitedMs : undefined,
      })
      send2({ topic: 'error', payload }, send)
      done(err instanceof Error ? err : new Error(String(err)))
    }

    /** 画面と同じ操作 (diag・read) の失敗: 入力の msg を引き継いだ error と done(err)。 */
    function failMsg(t, err, send, done) {
      const e = mapError(err) || new ApiError(500, 'INTERNAL', t.handle.redact(String((err && err.message) || err)))
      if (err && typeof err.waitedMs === 'number') e.waitedMs = err.waitedMs
      const msg = t.msg
      msg.topic = 'error'
      msg.payload = errorPayload(t.action, e)
      send2(msg, send)
      done(err instanceof Error ? err : new Error(e.message))
    }

    /** read の返事 (入力の msg を引き継ぐ)。since は取りに行き始めた時刻 (これより後に取れた値は fresh) */
    function readReply(msg, h, req, refreshed, send, since) {
      msg.payload = service.readOf(h, req, { refreshed, refreshedSince: since, device: roleNow(), deviceKey: node.device.deviceKey })
      msg.topic = 'read'
      send2(msg, send)
    }

    /** 預かったものの返事 (このノードの出力の形で)。deliver() から呼ばれる。 */
    const replies = {
      get(t, o, send, done) {
        // 値は measurement のイベントで出力 1 に出る
        if (o.ok) done()
        else failNew(t, o.err, send, done)
      },
      poll(t, o, send, done) {
        if (o.ok) done()
        else failNew(t, o.err, send, done)
      },
      command(t, o, send, done) {
        // command-result: {device, deviceKey, command, ok, at, ts, lines, parsed, error, result}
        const base = Object.assign(who(), { command: t.data.shown })
        if (o.ok) {
          send2({ topic: 'command-result', payload: outputs.commandPayload(Object.assign(base, { lines: o.value.lines, ok: true, result: o.value.result })) }, send)
          done()
          return
        }
        // アダプタが FAIL を返した・応答が無い: ok: false の結果を出してから、今までどおり error
        if (answeredFailure(o.err)) {
          send2({ topic: 'command-result', payload: outputs.commandPayload(Object.assign(base, { lines: o.err.lines || [], ok: false, err: o.err })) }, send)
        }
        failNew(t, o.err, send, done)
      },
      diag(t, o, send, done) {
        if (o.ok) {
          // 画面の API と同じ形 (service の diagPayload)。device・deviceKey は出力 2 のほかの topic とそろえる
          t.msg.payload = Object.assign(o.value, who())
          t.msg.topic = 'diag'
          send2(t.msg, send)
          done()
          return
        }
        // SK コマンドをアダプタが断った (FAIL ER06 など)・応答が無い: 結果を ok: false で出してから error。
        // 結果は新しい msg (入力の msg は error が引き継ぐ。http in から繋いでも返事は 1 つ)
        if (o.err && o.err.diag) send2({ topic: 'diag', payload: Object.assign({}, o.err.diag, who()) }, send)
        failMsg(t, o.err, send, done)
      },
      read(t, o, send, done) {
        if (!o.ok) return failMsg(t, o.err, send, done)
        try {
          readReply(t.msg, t.handle, t.data.req, t.data.stale, send, o.value && typeof o.value.since === 'number' ? o.value.since : null)
          done()
        } catch (err) {
          failMsg(t, err, send, done)
        }
      },
    }
    replies.raw = replies.command
    node._wsuhaReply = (t, o, send, done) => {
      const fn = replies[t.action] || replies.get
      fn(t, o, send, done)
    }

    /** get・poll・command を預ける (入力の形を先に確かめる。読めない入力は預からずにすぐ error)。 */
    function heldTopic(action, msg, body, send, done) {
      try {
        if (action === 'get') {
          const epcs = normalizeEpcs(body.epcs !== undefined ? body.epcs : msg.payload)
          if (!epcs.length) throw new Error("取得する EPC を payload に指定してください（例: 'E7' や ['E7','E8']）")
          const hex = epcs.map((n) => ('0' + n.toString(16).toUpperCase()).slice(-2)).join(' ')
          hold(action, msg, send, done, { kind: 'meter', label: 'get ' + hex, sig: 'get:' + hex, run: (seq) => seq.get(epcs, 'manual') })
          return
        }
        if (action === 'poll') {
          hold(action, msg, send, done, { kind: 'meter', label: 'poll', sig: 'poll', run: (seq) => seq.get(seq.options.pollEpcs, 'manual') })
          return
        }
        // command / raw。SKSET… の引数は command に写さない (表示とログ)
        // 文字列でない payload (inject の時刻・オブジェクト・無し) を文字に変えて送ると、アダプタが FAIL を返すだけで
        // 入力の誤りに見えない。送らずに断る (ほかの入力と同じ VALIDATION)
        const cmd = body.command !== undefined ? body.command : msg.payload
        if (typeof cmd !== 'string' || !cmd.trim()) {
          throw new ApiError(422, 'VALIDATION', "送るコマンドを文字列で指定してください（例: 'SKINFO'）", { command: '文字列で指定してください' })
        }
        const shown = outputs.maskCommand(cmd, handle.redact)
        // 改行の混ざったもの・FLASH を消耗するものは預からずに断る (code は VALIDATION / FORBIDDEN_COMMAND)
        const bad = forbiddenCommand(cmd)
        if (bad) throw bad
        hold(
          action,
          msg,
          send,
          done,
          { kind: pendingLib.commandKind(cmd), label: 'command ' + shown.split(' ')[0], run: (seq) => outputs.runCommand(seq, cmd, handle.redact) },
          { shown }
        )
      } catch (err) {
        failNew({ action }, err, send, done)
      }
    }

    /** diag (Web UI の API と同じ許可リスト)。電波を使う epc / propmap は接続を、SK コマンドはポートが開くのを待つ。 */
    function heldDiag(msg, send, done) {
      const t = { action: 'diag', msg, handle }
      try {
        if (!service) throw new ApiError(503, 'PORT_DOWN', '運用設定と診断の仕組みを初期化できていません（Node-RED のログを確かめてください）')
        const p = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {}
        // 入力の検査 (422・403) は預ける前に
        const plan = svc.planDiag({ name: p.name, args: p.args })
        hold('diag', msg, send, done, {
          kind: plan.epcs ? 'meter' : 'module',
          label: 'diag ' + plan.name,
          run: (seq) => service.executeDiag(handle, { plan, seq }, { by }),
        })
      } catch (err) {
        failMsg(t, err, send, done)
      }
    }

    /** read。持っている値ですぐ答える。maxAgeSec より古い・無い値があるときだけ、預かりの規則で取りに行く。 */
    function heldRead(msg, send, done) {
      const t = { action: 'read', msg, handle }
      try {
        if (!service) throw new ApiError(503, 'PORT_DOWN', '運用設定と診断の仕組みを初期化できていません（Node-RED のログを確かめてください）')
        const req = readValues.parseReadRequest(msg.payload, msg.maxAgeSec)
        const stale = service.staleOf(handle, req)
        if (!stale.length) {
          readReply(msg, handle, req, [], send)
          done()
          return
        }
        const hex = stale.map((n) => ('0' + n.toString(16).toUpperCase()).slice(-2)).join(' ')
        // 取りに行き始めた時刻を結果に入れる (やり直したら、やり直した時刻)。まとめた read も同じ結果を受け取る
        const run = async (seq) => {
          const since = Date.now()
          await service.refreshValues(seq, stale)
          return { since }
        }
        hold('read', msg, send, done, { kind: 'meter', label: 'read ' + hex, sig: 'read:' + hex, run }, { req, stale })
      } catch (err) {
        failMsg(t, err, send, done)
      }
    }

    // 作り直しをまたいだ返事の届け先として載せる (同じ id の前のノードが預けたものも、ここから出る)
    live.set(node.id, node)
    const waiting = mailbox.get(node.id)
    if (waiting) {
      mailbox.delete(node.id)
      for (const [t, o] of waiting) deliver(t, o)
    }

    // handle を購読する。sequencer に直接付けていた 1.x は、
    // 「設定ノードへ登録してから、そこで出来た sequencer に結び付ける」順序に頼っていた
    // (逆だと、再デプロイで sequencer が null の間に作られたノードの出力だけ黙って止まる)。
    // handle は作り直されないので、順序に関係なく繋がる (test/nodes/lifecycle.test.js)。
    for (const [name, fn] of Object.entries(handlers)) handle.on(name, fn)

    // 使っているノードの数を Web UI に出すため。ポートの開閉には使わない
    // (enabled の設定ノードは、使っているノードの数に関係なくポートを開いている)。
    node.device.register(node)
    // 構成の変更で開き直している途中 (handle.reconfiguring) は、sequencer が無いのが正しい
    if (node.device.enabled !== false && !handle.sequencer && !handle.reconfiguring) {
      node.error(`${portLabelNow()}: アダプタを初期化できませんでした（接続先とポートを確かめてください）`)
    }
    updateStatus()

    // --- 入力 ------------------------------------------------------------
    node.on('input', async function (msg, send, done) {
      send = send || node.send.bind(node)
      done = done || ((err) => { if (err) node.error(err, msg) })

      const action = String(
        (msg.payload && typeof msg.payload === 'object' && msg.payload.action) || msg.topic || 'get'
      ).toLowerCase()
      const body = msg.payload && typeof msg.payload === 'object' ? msg.payload : {}

      // 最新値の読み出しと診断 (無線かモジュールが要るものは預かる)
      if (action === 'read') return heldRead(msg, send, done)
      if (action === 'diag') return heldDiag(msg, send, done)

      if (SHARED_TOPICS.indexOf(action) >= 0) {
        try {
          await shared(action, msg, send)
          done()
        } catch (err) {
          // 画面と同じ code (VALIDATION・REVISION_MISMATCH・FORBIDDEN_COMMAND・DISABLED など) を出力 2 の error に入れる
          const e = mapError(err) || new ApiError(500, 'INTERNAL', handle.redact(String((err && err.message) || err)))
          msg.topic = 'error'
          msg.payload = errorPayload(action, e)
          send2(msg, send)
          done(err instanceof Error ? err : new Error(e.message))
        }
        return
      }

      // get・poll・command は預かり。未接続・再接続中・ポートを開いている途中でも error にせず、つながったら実行する
      if (HELD_TOPICS.indexOf(action) >= 0) return heldTopic(action, msg, body, send, done)

      // 入力の形の検査は、状態より先に (画面の API の actions と同じ順)
      let ladder
      try {
        if (action === 'reconnect') ladder = ladderOf(body)
      } catch (err) {
        send2({ topic: 'error', payload: errorPayload(action, err) }, send)
        done(err)
        return
      }

      // ここから先 (今までの topic) は sequencer が要る
      const sequencer = handle.sequencer
      // 開き直しの最中 (構成・認証情報の変更) は、sequencer がまだ前のものでも BUSY。
      // 前の sequencer の SKTERM の最中に来た reconnect・stop を通すと、その SKTERM を取り消し、
      // メーター側に PANA セッションを残したまま開き直してしまう
      if (!sequencer || handle.reconfiguring) {
        // 失敗は出力 2 の error (code つき) と done(err)。done(err) だけでは、error を見て通知するフローに届かない。
        // code: 無効は DISABLED、開き直しの最中は BUSY、ほかは PORT_DOWN (get・poll・command・diag・read は預かる)
        const e =
          node.device.enabled === false
            ? new ApiError(409, 'DISABLED', 'アダプタが無効です（設定ノードか、Web UI の設定タブで有効にしてください）')
            : handle.reconfiguring
              ? new ApiError(409, 'BUSY', '設定の変更で接続し直している途中です。少し待ってから、もう一度送ってください')
              : new ApiError(
                  503,
                  'PORT_DOWN',
                  handle.buildError
                    ? 'アダプタを初期化できませんでした: ' + handle.redact(handle.buildError.message)
                    : 'アダプタを初期化できていません（接続先とポートを確かめてください）'
                )
        send2({ topic: 'error', payload: errorPayload(action, e) }, send)
        done(e)
        return
      }

      try {
        switch (action) {
          // get・poll・command (raw) は上の heldTopic (預かり)

          // --- 上書きを掛ける / 外す -----------------------------------
          case 'start':
          case 'resume':
            // 止めていた上書きだけを外す。
            // 取得間隔やプロパティの上書きには触らない
            // (運転を入れ直しただけで設定が戻ると驚く)。
            await sequencer.start()
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break

          case 'auto':
          case 'reset':
            // 掛かっている上書きを全部外して、設定どおりの自動運転へ戻す。
            sequencer.resetOverrides('入力メッセージ')
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break

          case 'stop':
            await sequencer.stop(body.reason || '入力メッセージ', { external: true })
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break

          case 'reconnect':
            // 止めている台は再接続しない (画面の API と同じ 409 STOPPED_BY_OVERRIDE)。
            // sequencer は warn を 1 行残すだけなので、ここで断らないとフローには成功に見える
            if (sequencer.state.overrides && sequencer.state.overrides.stopped) {
              throw new ApiError(
                409,
                'STOPPED_BY_OVERRIDE',
                `外部の指示で停止中のため再接続しません（${String(sequencer.state.overrides.stopped.reason || '外部の指示').slice(0, 200)}）。先に start か auto を送ってください`
              )
            }
            await sequencer.reconnect('入力メッセージ', ladder)
            break

          case 'terminate':
            await sequencer.terminate()
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break

          case 'status':
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break

          case 'interval': {
            const raw = body.value !== undefined ? body.value : msg.payload
            // 空を渡されたら「上書きをやめる」の意。設定ノードの値へ戻す。
            if (raw === null || raw === '' || raw === undefined) {
              // この項目だけ戻す。resetOverrides() を呼ぶと
              // 停止の上書きまで解除され、止めてあるアダプタが動き出す。
              sequencer.resetOverride('pollIntervalSec')
            } else {
              // 画面の PUT settings・フローの settings と同じ検証 (15〜3600 の整数)。
              // 上の限りを見ないと、inject の既定の payload (時刻) が取得間隔になる
              const v = sequencer.setPollInterval(checkOverride('pollIntervalSec', raw), { external: true })
              node.log(`${portLabelNow()}: 取得間隔を ${v} 秒に上書きしました`)
              // setPollInterval は status を出さない。画面（SSE の adapter・settings）に上書きを映す
              handle.notifyChanged()
            }
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break
          }

          case 'epcs': {
            const raw = body.epcs !== undefined ? body.epcs : msg.payload
            if (raw === null || raw === '' || raw === undefined) {
              sequencer.resetOverride('pollEpcs')
              send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
              break
            }
            // 画面の PUT settings・フローの settings・設定ノードと同じ検証 (1〜6 個。履歴の E2・E4・EC は不可)。
            // ['E7','E2'] を通すと sequencer が履歴の 1 つだけを残し、上書きのあいだ瞬時電力が取れない
            const list = checkOverride('pollEpcs', epcList(raw))
            sequencer.setPollEpcs(list, { external: true })
            handle.notifyChanged() // setPollEpcs も status を出さない（上と同じ）
            send2({ topic: 'status', payload: withMeta(sequencer.snapshot()) }, send)
            break
          }

          case 'clear-radio-block':
            sequencer.clearRadioBlock()
            break

          default:
            throw new ApiError(422, 'VALIDATION', `対応していない指示です: ${action}。topic はノードのヘルプの一覧から選んでください`)
        }
        done()
      } catch (err) {
        // message は 1.x のまま (sequencer の文)。検証の失敗 (interval・epcs) は、画面と同じ操作と同じく code と details を付ける。
        // それ以外も、画面と同じ code に読めるもの (DEVICE_ERROR・TIMEOUT・NOT_CONNECTED・BUSY など) は code を付ける
        const mapped = mapError(err)
        const payload = errorPayload(action, {
          message: (err && err.message) || String(err),
          code: mapped ? mapped.code : null,
          details: err instanceof ApiError ? err.details : null,
        })
        send2({ topic: 'error', payload }, send)
        done(err)
      }
    })

    /**
     * 一時的な上書き (interval・epcs) の値を、運用設定と同じ規則で確かめる (settings-store の validateSettingsInput)。
     * 外れたら ApiError(422, 'VALIDATION', …, {field: 理由})。通れば sequencer に渡す値 (整数・'0xE7' の配列) を返す。
     */
    function checkOverride(field, value) {
      const { changes, errors } = validateSettingsInput({ [field]: value })
      if (errors[field] || !Object.prototype.hasOwnProperty.call(changes, field) || changes[field] === null) {
        const why = errors[field] || '値を指定してください'
        const label = field === 'pollIntervalSec' ? '取得間隔' : '定期的に取りに行く値'
        throw new ApiError(422, 'VALIDATION', `${label}を確かめてください: ${why}`, { [field]: why })
      }
      return changes[field]
    }

    // --- 後片付け --------------------------------------------------------
    node.on('close', function (removed, done) {
      // 外し忘れると、再デプロイのたびに同じメッセージが二重に流れる。
      // 設定ノードには触らない (このノードだけの部分デプロイで SKTERM・再接続を起こさない)。
      for (const [name, fn] of Object.entries(handlers)) handle.removeListener(name, fn)
      // 預かったもの: デプロイで作り直す (removed でない) なら残し、同じ id の新しいノードから返事を出す。
      // 削除したなら、このノードの分を SHUTDOWN で返す (このノードの send / done で)
      node._wsuhaClosed = true
      if (live.get(node.id) === node) live.delete(node.id)
      if (removed && handle.pending) handle.pending.cancelOwner(node.id, 'B ルートノードを削除した')
      node.device.unregister(node, done)
    })
  }

  RED.nodes.registerType('wsuha-broute', WsuhaBrouteNode)

  // -------------------------------------------------------------------------
  function normalizeEpcs(v) {
    if (v === null || v === undefined) return []
    const arr = Array.isArray(v) ? v : [v]
    return arr.map(toEpc).filter((n) => n !== null)
  }

  /**
   * epcs の入力を、検証に渡す配列にする (読めないものも残して検証で断る。黙って捨てない)。
   * 'E7' / 0xE7 / ['E7','E8'] と、設定ノードの欄と同じ 'E7, E8' を受ける。
   */
  function epcList(v) {
    if (Array.isArray(v)) return v
    if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean)
    return [v]
  }
}
