'use strict'

// ============================================================================
//  Wi-SUN B ルート シーケンサー
// ============================================================================
//
//  SKSTACK-IP モジュール (ROHM BP35C0 系 / RATOC RS-WSUHA) を相手に
//  「接続して、定期的に計測値を取り、切れたら繋ぎ直す」を面倒みるクラス。
//
//  Node-RED には一切依存しない。依存するのは注入された transport だけなので、
//  実機なしで単体テストできる (lib/simulator-transport.js が実機の応答を再現する)。
//
//  ---------------------------------------------------------------------
//  なぜ Promise と EventEmitter なのか
//  ---------------------------------------------------------------------
//  同じ処理を Node-RED の function ノードで書くと、状態をコンテキストに
//  置く必要があるためクロージャが使えず、完了ハンドラを「名前」で引く
//  ディスパッチ表にせざるを得ない。接続手順が
//  「コマンド → ハンドラ名 → 次のコマンド」という飛び石になり、
//  順番を追うのに表を行き来することになる。
//
//  独自ノードなら素直に書ける:
//
//      await this._send('SKSETPWD ...')
//      const pan = await this._scan()
//      await this._send('SKJOIN ' + pan.ipv6, { events: [0x25] })
//
//  手順そのものがコードの並びになる。分岐も try/catch もそのまま書ける。
//
//  ---------------------------------------------------------------------
//  典拠: ROHM BP35C0 コマンドマニュアル Ver1.2.0 (No.63TR001J Rev.002)
//  このファイルの「マニュアル n.n」は、この文書の節を指す。要点は次のとおり (要約)。
//    3 章冒頭  SK コマンドは必ず応答を待ってから次を実行する
//    3.4       EVENT 24 は 3 回までリトライ / EVENT 25 でも疎通確認をする
//    3.9       SKSENDTO は OK と EVENT 21 の両方を待つ
//    3.11      SKSCAN 0 は EVENT 1F + EEDSCAN まで次を出さない
//    3.17      SKSETPWD の <LEN> は 16 進、<PWD> は大文字の英数字
//    3.19      SKSETRBID は 32 文字。下位 8 文字が Pairing ID になる
//    3.32      WOPT は実行のたびに FLASH へ書き込む (上限 10,000 回)
//    7 章      FAIL ERxx とその推奨処理
//    8 章      無線送信コマンド禁止期間
//    10.4      リセット後は 3 秒以上待つ
//    10.5.2    再接続は 4 段階で試す
//    10.7      FW 1.5.2 rev15 は 49 日で自動再認証が止まる

const { EventEmitter } = require('events')
const SK = require('./sk-protocol')
const EL = require('./echonet')

/** 既定値。コンストラクタの options で上書きできる。 */
const DEFAULTS = {
  // --- スキャン ---
  scanMode: 2, // 2 = アクティブスキャン (Pairing IE あり)。SKSETRBID の後に使う
  channelMask: 'FFFFFFFF',
  scanDurations: [4, 5, 6, 7, 8], // 見つからなければ順に伸ばす
  // 段階 2 に上がったら、まず知っているチャネルだけを探す (全チャネルの約 1/28 の時間と送信で済む)
  knownChannelScanDurations: [6, 7, 8],
  scanRounds: 3, // 一巡して駄目なら、間を空けて何巡するか

  // --- 送信 ---
  side: 0, // B 面
  udpHandle: 1, // ハンドル 1 = ポート 3610 (ECHONET Lite)
  echonetPort: '0E1A',
  secure: 1,

  // --- ポーリング ---
  pollIntervalSec: 30,
  minPollIntervalSec: 15,
  pollEpcs: [0xe7, 0xe8], // 瞬時電力と瞬時電流（1 回の要求に載る）
  pollMissLimit: 3,

  // --- 取れるものは全部取る (階層取得) ---
  //
  // 全部を毎回取ると ARIB STD-T108 の送信総和時間 (1 時間 360 秒) を食う。
  // 性質ごとに間隔を変える。1 回の Get には複数の EPC を載せられるので
  // (ECHONET Lite の OPC)、同じ階層はまとめて 1 通で取る。
  collectAll: true,
  // 接続時に 1 回だけ。変わらないもの。
  //   D3 係数 / E1 単位 / D7 有効桁数 … 積算値の換算に必須
  //   8A メーカコード / 8D 製造番号 / 82 規格Version / 81 設置場所
  //   9F Get プロパティマップ … メーターが何を持っているかを教えてくれる
  onceEpcs: [0xd3, 0xe1, 0xd7, 0x9f, 0x8a, 0x8d, 0x82, 0x81],
  // ゆっくり変わるもの。既定 5 分。
  //   E0/E3 積算電力量 (正/逆) / 88 異常発生状態 / 80 動作状態
  slowEpcs: [0xe0, 0xe3, 0x88, 0x80],
  slowIntervalSec: 300,
  // 30 分ごとにしか変わらないもの。メーターからの自発通知 (INF) でも届くので、
  // 取りこぼしたときの保険として低頻度で取る。
  //   EA/EB 定時積算電力量 (正/逆)
  halfHourEpcs: [0xea, 0xeb],
  halfHourIntervalSec: 1800,
  // 1 通あたりの EPC 数の上限。応答が大きいと無線区間で分割されて時間がかかる。
  maxEpcsPerRequest: 6,
  // 階層の間隔の下限。テストで詰められるようにしてある。
  minTierIntervalSec: 30,

  // --- Get_SNA で拒否された EPC の扱い ---
  //
  // 1 回の Get_SNA で「このメーターは持っていない」と決めつけない。
  // メーターは一時的に PDC=0 を返すことがあり、瞬時電力 (E7) のように毎回取る値でも起きる。
  // 未対応として定期取得から外すと、メーターが元に戻っても二度と取らなくなる。
  //
  // 拒否されたら、しばらく要求を控えてから聞き直す。拒否が続くたびに間隔を倍にし、
  // 上限で頭打ちにする。本当に持っていない EPC でも、上限ごとに 1 回聞くだけで済む。
  snaHoldSec: 300,
  // Get プロパティマップ (0x9F) に載っている EPC の上限。
  // 載っているのに拒否されたのは一時的なものなので、長くは控えない。
  snaHoldMaxSupportedSec: 900,
  // 載っていない、または 0x9F を取れていないときの上限。
  snaHoldMaxSec: 6 * 3600,

  // --- タイムアウト (ミリ秒) ---
  commandTimeout: 5000,
  resetTimeout: 8000,
  resetSettleMs: 3000, // マニュアル 10.4
  joinTimeout: 90000,
  sendTimeout: 20000,
  bulkySendTimeout: 70000, // 履歴系は応答が分割されるので長くとる
  // SKSENDTO が通ったあと、ECHONET の応答を待つ長さ。メーターの応答はふつう数秒で、ほとんどが 10 秒以内に返る。
  // 送信の再試行のぶんまで含めて長く待つと、1 回落とすたびに計測が数分止まるので、短く区切って送り直す。
  responseTimeoutMs: 12000,
  responseResends: 1, // 応答が無いときに同じ EPC を送り直す回数。送り直しても無ければ取りこぼしに数える
  edScanTimeout: 40000,

  // --- リトライ ---
  //
  // マニュアル 3.4 は EVENT 24 が 3 回続いたらエラーとして扱うよう求めている。これは
  // **1 バーストの回数**として守る。その先にあるのは設定値を人が確かめる案内で、
  // 接続をやめる指示ではない。
  // 10.5.2 にも再接続回数の上限は無く、通信を保つ役目は上位の機器の側にあるとしている。
  joinMaxTries: 3, // 1 バーストの SKJOIN 回数 (マニュアル 3.4)
  joinRetryMs: 5000, // バースト内の間隔
  // バースト間の待ち。最後の値で頭打ちにして、同じアドレスへ粘る。
  joinBurstBackoffMs: [15000, 30000, 60000, 120000],
  joinPersistMs: 30 * 60 * 1000, // 同じアドレスへ粘る時間。0 = 無制限
  joinTermBeforeRetry: true, // 2 巡目以降、SKJOIN の前に SKTERM を 1 回
  joinRekeyEveryBursts: 3, // n 巡ごとに SKSETPWD/SKSETRBID を入れ直す (SKRESET は不要)
  joinResetAfterWindows: 3, // 粘り窓を n 回使い切ったら SKRESET 周回を挟む
  credentialHintAfterMs: 15 * 60 * 1000, // 認証情報の確認を促すまでの時間
  // SKJOIN を出してから EVENT 24/25 が返るまでは無線送信コマンドを出せない
  // (マニュアル 8 章)。取りこぼしたときのための保険 (仕様上の最大は約 38 秒)。
  panaPendingMaxMs: 60 * 1000,
  // --- ARIB STD-T108 の送信総和時間 (1 時間あたり 360 秒) ---
  // SFD = 無線送信の積算時間 [ミリ秒]。読むだけなら電波を使わない。
  txBudgetGuard: true,
  txBudgetGuardMs: 250000, // 360 秒の約 70% で休む
  txBudgetPauseMs: 10 * 60 * 1000,
  commandMaxTries: 2,
  sendMaxTries: 3, // マニュアル 3.9: SKSENDTO の送信リトライは 3 回連続まで
  // EVENT 21 <PARAM>=01 (キャリアセンスビジー・Ack 無し) の再試行の間隔。混雑は数秒続くので 1〜2 秒では空けきれない
  sendRetryDelaysMs: [2000, 5000],
  sendRetryJitter: 0.2, // ±20% ゆらす (同じ間隔で混雑に当たり続けないように)
  naWaitMs: 4000, // EVENT 21 <PARAM>=02 のあと EVENT 02 を待つ時間 (マニュアル 3.9)
  maxQueuedRequests: 4, // ECHONET 要求の待ち行列の上限

  // --- その他 ---
  label: null, // ログや出力に付ける名前 (動力 / 電力 など)
  expectedMac: null, // 指定するとポート取り違えを検出できる
  autoWriteWopt: true, // ERXUDP がバイナリ表示なら WOPT 01 を 1 回だけ書く
  radioBlockMaxMs: 70 * 60 * 1000, // EVENT 33 を取りこぼした場合の保険
  keyBlockMaxMs: 60 * 1000, // EVENT 55 を取りこぼした場合の保険 (マニュアル 8 章)
  // EVENT 29 のあと、モジュールが自動で行う PANA 再認証の見切り時間。
  // マニュアル 8 章では EVENT 24/25 が返るまで無線コマンドを出せないので、
  // 永久に待つと「静かに止まる」状態そのものになる (10.7 の 49 日問題)。
  reauthTimeoutMs: 180 * 1000,
  // 再試行の待ち時間の基準。段の数を掛け、連続失敗のたびに倍にする。
  retryBaseMs: 5000,
  // 再試行の待ち時間の上限。無人運転なので「あきらめる」段は作らず、
  // 間隔だけ伸ばして頭打ちにする (電波の送信総和時間を食い潰さないため)。
  maxRetryDelayMs: 5 * 60 * 1000,
  // 「途中のフェーズのまま、キューも空で何も動いていない」状態の見張り。
  // 自動運転では、静かに止まるのが一番困る。
  watchdogIntervalMs: 15000,
  watchdogStallMs: 45000,
}

/** 配列を n 個ずつに切る。1 通に載せる EPC の数を抑えるのに使う。 */
function chunk(list, n) {
  const out = []
  for (let i = 0; i < list.length; i += Math.max(1, n)) out.push(list.slice(i, i + Math.max(1, n)))
  return out
}

/** 応答が大きく、無線区間で分割されるプロパティ。 */
const BULKY_EPCS = new Set([0xe2, 0xe4, 0xec])

/** 定期の取得の目的 (_request の purpose)。ここで値が届いたときだけ「値が来た」と見る (_noteValueArrived)。 */
const PERIODIC_PURPOSES = new Set(['poll', 'slow', 'halfHour'])

/**
 * ER10 (受け付けたが実行に失敗) の原因はコマンドごとに決まっている。
 * マニュアル 7 章の推奨処理はコマンドを出すタイミングを確かめることだけで、
 * それでは何を見ればよいか分からないので、具体の確認先を出す。
 */
const ER10_ADVICE = {
  SKJOIN: 'パスワード（SKSETPWD）と認証 ID（SKSETRBID）が設定済みか、S3 に PAN ID が入っているかを確かめてください',
  SKREJOIN: 'メーターとのセッションがありません。SKJOIN からやり直してください',
  SKSENDTO: 'メーターとの認証が完了していないか、宛先アドレスが解決していません',
  SKSCAN: '別のスキャンが進行中か、チャネルマスクが不正です',
  SKTERM: 'メーターとのセッションがありません',
  SKSETPWD: '長さの指定（LEN）と実際の文字数が一致しているかを確かめてください',
  SKSETRBID: '認証 ID は 32 桁の 16 進数です',
  SKLL64: 'MAC アドレスの書式を確かめてください',
  SKPING: '宛先アドレスに届くかを確かめてください',
}

function failAdvice(code, command) {
  if (code !== 'ER10') return null
  const head = String(command || '').split(' ')[0].toUpperCase()
  return ER10_ADVICE[head] || null
}

/** 無線送信を伴うコマンド (マニュアル 8 章の禁止期間で止める対象)。小文字で書かれても同じに扱う。 */
const RADIO_COMMAND = /^(SKSCAN|SKJOIN|SKREJOIN|SKSENDTO|SKPING|SKJOINFOR|SKTERM|SKTERMFOR|SKAUTOUPD|SKOPEN)\b/i

/** PANA 接続を始めるコマンド。OK を返すと、EVENT 24/25 が返るまで無線を出してはいけない (マニュアル 8 章)。 */
const PANA_COMMAND = /^(SKJOIN|SKREJOIN|SKJOINFOR)\b/i

/**
 * SK コマンドとして送ってよい文字 (印字できる ASCII と空白だけ)。
 *
 * 改行 (CR・LF)・制御文字・ASCII 以外の文字を混ぜると、1 回の書き込みで 2 つ目のコマンドがアダプタに届く。
 * 先頭だけを見る検査 (FLASH を消耗するコマンドの禁止・送信制限中の保留・預かりの種類分け・伏せ字) を全部すり抜ける
 * (例: "SKINFO\rWUART 03"。"SKINFOčSKSAVE" も、送るときの 'ascii' への変換で č が CR になる)。
 * raw() と _pump() と、フローの入力の検査 (nodes/wsuha-broute.js・lib/runtime/pending.js・outputs.js) が同じものを使う。
 */
const COMMAND_TEXT = /^[\x20-\x7e]+$/

/** SK コマンドの文字が送れる形か (前後の空白は外して見る)。 */
function isCommandText(command) {
  if (typeof command !== 'string') return false
  const s = command.trim()
  return s.length > 0 && COMMAND_TEXT.test(s)
}

/** isCommandText に外れたときの理由 (日本語)。通れば null。 */
function commandTextProblem(command) {
  const s = command === undefined || command === null ? '' : String(command).trim()
  if (!s) return 'コマンドが空です'
  if (!COMMAND_TEXT.test(s)) return 'コマンドに改行・制御文字・ASCII 以外の文字は使えません（1 回に送れるのは 1 つのコマンドだけです）'
  return null
}

/** 再接続の段階の上限 (0 PANA 再認証 / 1 PANA 初回認証 / 2 再スキャン / 3 SKRESET から全部。マニュアル 10.5.2)。 */
const LADDER_MAX = 3

/** 再接続の段階として受け付ける値か (0〜3 の整数)。画面の API とフローの入力 reconnect の検証と同じ。 */
function isLadder(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= LADDER_MAX
}

/** 接続の段階。画面表示と、どこで止まっているかの判断に使う。 */
const PHASES = {
  idle: '停止中',
  overridden: '外部の指示で停止中',
  opening: 'ポートを開いています',
  'port-down': 'ポート切断',
  'need-secrets': '認証情報が未設定か、書式が違います',
  resetting: '初期化中',
  configuring: '設定中',
  scanning: 'メーターを探しています',
  joining: 'メーターと認証中',
  rejoining: 'メーターと再認証中',
  reauth: '自動再認証待ち',
  verifying: '接続を確認中',
  connected: '接続済み',
  error: 'エラー',
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 読み込まれているコードの版。package.json から取る。 */
let LIB_VERSION = 'unknown'
try {
  LIB_VERSION = require('../package.json').version
} catch (e) {
  /* 単体で使われた場合 */
}

/** 中断を表す。再接続やstop で進行中の手順を畳むときに投げる。 */
class Aborted extends Error {
  constructor(reason) {
    super(reason || '中断されました')
    this.name = 'Aborted'
    this.aborted = true
  }
}

/**
 * コマンドが FAIL / タイムアウトで終わったことを表す。
 *
 * code は機械が読む失敗の種類 (文言を正規表現で比べずに済むように)。値は画面の API の code と同じ:
 *   'TIMEOUT'           応答が時間内に返らない (コマンド・ECHONET)
 *   'BUSY'              ECHONET 要求が滞留している・前の要求が終わらない
 *   'NOT_CONNECTED'     接続先 (メーター) のアドレスが未確定
 *   'PORT_DOWN'         ポートに書き込めない
 *   'RADIO_BLOCKED'     無線を出してはいけない期間 (blockedBy: 'radio' 送信総和時間 / 'pana' PANA 認証中 / 'key' 自動鍵配信中)
 *   'FORBIDDEN_COMMAND' 送ってはいけないコマンド (FLASH を消耗する・シーケンサーが持っている・診断の許可リストの外)
 *   'VALIDATION'        入力の形の誤り (空・改行や制御文字を含むコマンド・EPC が無い)
 *   'DEVICE_ERROR'      アダプタが送信の失敗を知らせた (EVENT 21 <PARAM>=01。キャリアセンスビジー・Ack 無し)
 * アダプタが FAIL を返したときの code はアダプタの値のまま ('ER04'〜'ER10'・'FAIL'。画面の API では DEVICE_ERROR)。
 * 取り消し (Aborted) は code を持たず、aborted: true (画面の API では BUSY)。
 */
class CommandError extends Error {
  constructor(message, info) {
    super(message)
    this.name = 'CommandError'
    Object.assign(this, info || {})
  }
}

class Sequencer extends EventEmitter {
  /**
   * @param {object} transport 'line' / 'open' / 'close' / 'error' を出す EventEmitter。
   *                           write(Buffer) → Promise を持つこと。
   * @param {object} options   DEFAULTS を参照
   */
  constructor(transport, options) {
    super()
    this.transport = transport
    // undefined の項目は既定値を上書きさせない。
    // 設定ノードは空欄を undefined で渡してくる。素の Object.assign だと
    // scanDurations が undefined になり、スキャンのたびに TypeError で落ちる。
    const given = {}
    for (const [k, v] of Object.entries(options || {})) if (v !== undefined) given[k] = v
    this.options = Object.assign({}, DEFAULTS, given)
    // 取得間隔の下限は、設定ノードから来た値にも効かせる。
    // setPollInterval() でしか丸めていなかったため、設定で 5 秒にすると 5 秒ごとに撃っていた。
    this._pollClampedFrom = null
    if (!(this.options.pollIntervalSec >= this.options.minPollIntervalSec)) {
      this._pollClampedFrom = this.options.pollIntervalSec
      this.options.pollIntervalSec = this.options.minPollIntervalSec
    }

    this.credentials = { id: null, password: null, source: null }

    this._queue = []
    this._current = null
    this._loopActive = false // _loop の二重起動よけ
    this._wake = null // 再試行の待ちを途中で起こすための関数
    this._waitingFor = null // 意図して待っている理由 (見張りに叩かれないため)
    this._acc = SK.newAccumulator()
    this._generation = 0 // 進行中の手順を無効化するための世代番号
    this._running = false
    this._closed = false

    this._pollTimer = null
    this._tierTimers = { slow: null, halfHour: null }
    // 階層ごとに最後に取りに行った時刻。再接続のたびに周期を最初から
    // 数え直すと、5 分未満の間隔で再接続が続く環境では積算が一度も取れない。
    this._tierLastAt = { slow: 0, halfHour: 0 }
    // モジュールの状態が分からない (作った直後・ポートを開けなかった・ポートが閉じた・
    // SKRESET のあと鍵と S2・S3 がまだ入っていない・SKJOIN が FAIL ER10 で返った)。
    // 立っている間は、段階に関係なく SKRESET からやり直す。
    // 段階だけで表すと、粘り窓の _resetLadder(2) や開けなかった回数の積み上げで
    // 段階が動き、初期化 (SFE 0・鍵・S2/S3) を飛ばして SKSCAN や SKJOIN から始めていた。
    this._needReset = true
    // SKRESET の前に SKTERM を 1 回撃つ。作った直後も、ポートが閉じたあとも同じ。
    // モジュールが通電したままなら、メーター側に PANA セッションが残っていることがある
    // (USB だけ再列挙された・前の Sequencer が接続の途中で閉じた・プロセスが落ちた)。
    // 残したまま SKJOIN すると、9 時間 EVENT 24 が続いた記録がある。
    // セッションが無ければ ER10 ですぐ返るだけなので、失敗には数えない (_tryTerm)。
    this._termBeforeReset = true
    // EVENT 25 でセッションができてから、終わったと分かるまで立てておく。
    // state.connected は取りこぼしや再接続で先に下りるので、閉じるときの判定には足りない (destroy)。
    this._panaSession = false
    // 認証情報の確認を促す error を出したか。粘りの窓をまたいで持つ (窓ごとに出すと 30 分おきに同じ文が並ぶ)。
    // 認証が通ったときと、認証情報を入れ直したときに下ろす
    this._credentialHinted = false
    this._detailShown = null // Node-RED のログへ最後に出した原文 (_reportDetail)
    // 再試行の待ちの長さと、同じ段を繰り返したときの段上げを決める数。接続が確かめられたら戻す。
    // 画面と alert に見せる連続失敗 (state.consecutiveFailures) とは分ける。あちらは認証の巡ごとにも増えるので、
    // 同じ数で決めると、認証が長く通らなかったあとの 1 回の失敗で待ちが上限の 5 分になる
    this._retryFailures = 0
    this._terminating = null // terminate の SKTERM の決着を待つ Promise (送っている間だけ)
    this._radioTimer = null
    this._keyTimer = null
    this._reauthTimer = null
    this._flushTimer = null
    this._watchdogTimer = null
    this._stalledSince = 0
    this._lastProgress = null

    this.state = {
      phase: 'idle',
      phaseSince: Date.now(),
      portOpen: false,
      connected: false,
      device: { version: null, mac: null, ipv6: null },
      meter: { addr: null, ipv6: null, channel: null, channelHex: null, channelMHz: null, panid: null, lqi: null, rssi: null, lqiAt: null, pairId: null },
      calibration: { coefficient: null, unitFactor: null, digits: null },
      radioBlocked: false,
      keyBlocked: false, // EVENT 54 〜 EVENT 55 (自動鍵配信中) はコマンド禁止
      wopt: null,
      ladder: 0,
      consecutiveFailures: 0, // 連続で失敗した回数 (画面と alert に見せる数)。主な値が届いたら 0 に戻す (_noteValueArrived)
      // PANA 接続の粘り具合。画面と切り分けのために出す。
      join: { burst: 0, attempt: 0, windows: 0, windowStartedAt: null, last: null },
      // つながらないときの案内。null か {kind: 'credentials' | 'no-meter', since, rounds}。
      // lastError の文言から推すと、次の失敗で上書きされて案内が消えたり出たりする。理由ごとにここで持ち続ける。
      connectHint: null,
      // SKJOIN/SKREJOIN を出してから EVENT 24/25 が返るまでの印 (マニュアル 8 章)
      panaPending: null,
      txBudgetMs: null, // SKSREG SFD で読んだ無線送信の積算時間
      // 外から来たメッセージによる上書き。null = 設定ノードのとおり。
      // 「自動運転が基本、入力は上書きだけ」を状態としても見えるようにする。
      overrides: { stopped: null, pollIntervalSec: null, pollEpcs: null },
      lastError: null,
      lastValueAt: null, // 主な値が最後に届いた時刻 (_noteValueArrived・_isMainValue)
      // 最後の主な値のあと、最初に繋がった時刻。主な値が届いたら null に戻す。値が来ないまま繋ぎ直しても延ばさない
      // (画面の「値が古い」の猶予の起点。繋ぎ直すたびに猶予が延びると、古い値がいつまでも合計に入る)
      valueWaitSince: null,
      pollMisses: 0,
      // マニュアル 3.9 の 3 回連続の判定に使う連続失敗カウンタ。
      //   sendBusy  EVENT 21 <PARAM>=01 (送信失敗)
      //   sendNoNa  EVENT 21 <PARAM>=02 のあと EVENT 02 が来ない (宛先誤り)
      //   sendMute  OK も EVENT 21 も返らない (モジュール側が受け付けていない)
      //   fail      OK も EVENT 21 も無く FAIL ERxx で終わった
      sendFails: { busy: 0, noNa: 0, mute: 0, fail: 0 },
      // Get_SNA で拒否されて、いま要求を控えている EPC。
      //   '0xE7': { count: 連続で拒否された回数, until: 控える期限 (ms), at: 最後に拒否された時刻 }
      // 値が取れたら消す。期限が来たらまた聞く。
      snaHold: {},
      // Get プロパティマップ (0x9F) で分かった「このメーターが持っている EPC」
      supportedEpcs: [],
      // これまでに取れた値をすべて覚えておく。
      // 取得のたびに全部を取り直すわけではないので、
      // 「いま分かっている全部」を下流へ渡せるようにする。
      values: {},
      counters: { tx: 0, rx: 0, failures: 0, timeouts: 0, joins: 0, reconnects: 0, resends: 0, resendRecovered: 0, targetedScans: 0, fullScans: 0 },
    }

    // 上書きを戻すときの基準 (= 設定ノードの値)。
    this._baseline = {
      pollIntervalSec: this.options.pollIntervalSec,
      pollEpcs: this.options.pollEpcs.slice(),
    }

    this._pending = null // 送信中の ECHONET 要求 {tid, epcs, purpose, timer, resolve, reject}
    this._requestChain = Promise.resolve() // ECHONET 要求を 1 件ずつに直列化する
    this._collectingOnce = null // 接続時の取得の途中なら、済んだら解ける Promise（_afterJoin。預かりが見る）
    this._requestDepth = 0
    this._scanResults = []
    this._lastGoodDurationIndex = null

    transport.on('line', (buf) => this._onLine(buf))
    transport.on('open', () => this._onPortOpen())
    transport.on('close', () => this._onPortClose())
    transport.on('error', (err) => this._log('error', 'シリアル: ' + err.message))
  }

  // =========================================================================
  //  公開 API
  // =========================================================================

  /** 認証情報を差し込む。接続前ならこれだけで start() できる。 */
  setCredentials(id, password, source) {
    // マニュアル 3.17: SKSETPWD の英字は大文字で渡す決まり。
    // 小文字のまま送ると SKSETPWD は OK を返すのに誤った PSK が登録され、
    // SKJOIN が EVENT 24 で落ちるまで原因が分からない。
    const before = this.credentials
    this.credentials = {
      id: id ? String(id).trim().toUpperCase() : null,
      password: password ? String(password).trim().toUpperCase() : null,
      source: source || null,
    }
    // 入れ直したあとも「認証が通りません」と出し続けない
    if (before.id !== this.credentials.id || before.password !== this.credentials.password) {
      this.state.connectHint = null
      this._credentialHinted = false
    }
    const problems = this.validateCredentials()
    // 認証情報が未設定で止まっていたなら、入った時点で自分から動き出す。
    // 無人運転では「あとで設定したのに動いていない」が起きやすい。
    if (!problems.length && !this._running && !this._closed && this.state.phase === 'need-secrets') {
      this._log('good', '認証情報が設定されました。自動運転を始めます')
      this.start()
    }
    return problems
  }

  /** 認証情報の書式を検査する。問題があればその一覧を返す。 */
  validateCredentials() {
    const problems = []
    const { id, password } = this.credentials
    if (!id) problems.push('認証 ID が未設定')
    else if (!/^[0-9A-F]{32}$/.test(id)) problems.push(`認証 ID は 32 桁の 16 進数です（いま ${id.length} 文字）`)
    if (!password) problems.push('パスワードが未設定')
    else if (password.length !== 12) problems.push(`パスワードは 12 桁の英数字です（いま ${password.length} 文字）`)
    else if (!/^[0-9A-Z]{12}$/.test(password)) problems.push('パスワードに使える文字は英数字だけです')
    return problems
  }

  /** 自動運転を開始する。接続とポーリングを回し続ける。 */
  async start() {
    if (this._running) return
    if (this.isClosing()) {
      this._log('warn', '閉じている途中なので、自動運転を始めません')
      return
    }
    const problems = this.validateCredentials()
    if (problems.length) {
      this._setPhase('need-secrets', problems.join(' / '))
      this._log('error', '認証情報が未設定か、書式が違います: ' + problems.join(' / '))
      return
    }
    this._running = true
    this.state.overrides.stopped = null // 止めていた上書きは解除
    if (this._pollClampedFrom !== null) {
      this._log(
        'warn',
        `取得間隔 ${this._pollClampedFrom} 秒は下限より短いので ${this.options.pollIntervalSec} 秒にしました` +
          '（1 回の SKSENDTO は OK と EVENT 21 の両方を待つため）'
      )
      this._pollClampedFrom = null
    }
    this._log('info', '自動運転を開始します')
    this._startWatchdog()
    // 再試行の待ちが残っていたら起こす。_loop は走っている間は何もしないので、起こさないと待ちが明けるまで動かない
    this._wakeUp()
    this._loop() // 待たない (中では失敗しても再接続し続ける)
  }

  /**
   * 自動運転を止める。進行中の手順は畳む。
   *
   * 内部の失敗でここへ来ることは無い。エラーは必ず再接続に回る。
   * 止まるのは、外から止めろと言われたときと、ノードを畳むときだけ。
   */
  async stop(reason, opts) {
    this._running = false
    this._markReauthBlock()
    this._bumpGeneration()
    this._wakeUp()
    this._abortQueue(reason || '停止');
    this._clearPending('停止')
    this._stopCollecting()
    this._stopWatchdog()
    this._clearReauthTimeout()
    this.state.connectHint = null // 止めたら、つなごうとしていない
    if (opts && opts.external) {
      this.state.overrides.stopped = { reason: reason || '外部の指示', at: Date.now() }
      this._setPhase('overridden', reason || '外部の指示')
      this._log('warn', '外部の指示で自動運転を止めました。auto を送ると設定どおりに戻ります')
    } else {
      this._setPhase('idle', reason || '停止')
      this._log('info', '自動運転を停止しました')
    }
  }

  /** 後片付け。ノードを削除・再デプロイするときに呼ぶ。 */
  async destroy() {
    // 接続したまま閉じると、**相手側にセッションが残る**。
    //
    // メーターは接続が 1 つ成立している間、ほかの接続を受け付けず、SKTERM で終えて初めて
    // 新しい接続を受け付ける (マニュアル 3.4・3.6)。
    //
    // SKTERM せずに再起動すると、メーターのセッションが切れるまで何時間も SKJOIN が
    // EVENT 24 を返し続けることがある。再デプロイのたびにこれが起きるので、閉じる前に必ず畳む。
    //
    // 閉じる途中に来た reconnect・stop・start (フローの入力など) は、この SKTERM を取り消さない。
    // 取り消すと、メーター側に PANA セッションを残したまま閉じる
    this._destroying = true
    // connected だけでは足りない。取りこぼしで下ろしたあとの SKJOIN や疎通確認の途中で閉じても、セッションは残っている。
    // ポートが閉じていたら送れないので、待たない
    if ((this.state.connected || this._panaSession) && this.state.portOpen && !this._closed) {
      let guard = null
      try {
        const terminated = await Promise.race([
          this._send('SKTERM', { ok: true, events: [0x27], failEvents: [0x28] }, { timeout: 5000, tries: 1, keepOnAbort: true, optional: true }).then(() => true),
          // Node-RED の close には制限時間がある。閉じるのを妨げない
          new Promise((r) => {
            guard = setTimeout(() => r(false), 6000)
          }),
        ])
        // 上限に先を越されたら、セッションは残っている。切り分けの記録が事実と逆にならないよう、通ったときだけ終了と書く
        if (terminated) this._log('info', 'メーターとのセッションを終了してから閉じます')
        else this._log('warn', '閉じる前に SKTERM を完了できませんでした（次の起動で送り直します）')
      } catch (err) {
        // ER10 はセッションが無いということで、畳めている
        if (err.code !== 'ER10') this._log('warn', '終了時の SKTERM が通りませんでした: ' + err.message)
      } finally {
        clearTimeout(guard)
      }
    }

    // SKTERM が上限 (6 秒) までに終わらず、送信制限などで待ち行列に残っていても、閉じるときは畳む
    if (this._current) this._current.keepOnAbort = false
    for (const item of this._queue) item.keepOnAbort = false
    this._closed = true
    await this.stop('終了')
    this._stopWatchdog()
    this._clearReauthTimeout()
    if (this._radioTimer) clearTimeout(this._radioTimer)
    if (this._keyTimer) clearTimeout(this._keyTimer)
    if (this._flushTimer) clearTimeout(this._flushTimer)
    // ここにも上限を置く。close が返らないと、設定ノードの片付けと構成の変更がいつまでも終わらない
    let closeGuard = null
    try {
      const closed = await Promise.race([
        Promise.resolve(this.transport.close()).then(() => true),
        new Promise((r) => {
          closeGuard = setTimeout(() => r(false), 3000)
        }),
      ])
      if (!closed) this._log('warn', 'シリアルポートが 3 秒たっても閉じないので、待たずに終えます')
    } catch (e) {
      /* 閉じられなくても続行 */
    } finally {
      clearTimeout(closeGuard)
    }
    this.removeAllListeners()
  }

  /**
   * 任意の SK コマンドを 1 つ実行する。
   * キューに乗るので、他のコマンドと混ざっても順序は守られる。
   * @returns {Promise<object>} 応答 (OK の値やイベント)
   */
  raw(command, opts) {
    // 印字できる ASCII 以外 (改行・制御文字・ASCII 以外の文字) は、下の検査より先に断る。
    // 混ぜると 1 回の書き込みで 2 つ目のコマンドが届き、先頭だけを見る下の検査をすり抜ける
    const bad = commandTextProblem(command)
    if (bad) return Promise.reject(new CommandError(bad, { code: 'VALIDATION' }))
    const cmd = String(command).trim()
    const why = forbiddenRawCommand(cmd)
    if (why) return Promise.reject(new CommandError(why, { code: 'FORBIDDEN_COMMAND', forbidden: true, command: cmd }))
    const o = opts || {}
    return this._send(cmd, { ok: true }, { timeout: o.timeout, tries: o.tries, onLine: o.onLine })
  }

  /**
   * ECHONET Lite のプロパティを取得する。
   * @param {number[]} epcs
   * @returns {Promise<{values: object[], tid: number, esv: string}>}
   */
  async get(epcs, purpose) {
    const list = (Array.isArray(epcs) ? epcs : [epcs]).map(toEpc).filter((n) => n !== null)
    if (!list.length) throw new CommandError('取得する EPC が指定されていません', { code: 'VALIDATION' })
    return this._request(list, purpose || 'manual')
  }

  /** いま繋がっているか。 */
  get isConnected() {
    return this.state.phase === 'connected'
  }

  // --- 外 (lib/runtime・nodes) から読むための小さな公開の面 ---------------------
  // 非公開の項目 (_generation・_running・_pending・_requestDepth・_queue・_current・_collectingOnce) を
  // 外から直に触らない。中の積み方を変えても、ここの意味を保てば外は壊れない。

  /** 進行中の手順の世代。再接続・停止・ポートの切断のたびに増える (預かりと registry が「つなぎ直したか」を見る)。 */
  get generation() {
    return this._generation
  }

  /** 自動運転中か (start してから stop・terminate するまで)。 */
  isRunning() {
    return !!this._running
  }

  /** 閉じている途中か、閉じたか (destroy のあと)。 */
  isClosing() {
    return !!(this._destroying || this._closed)
  }

  /** ECHONET の要求を送信中か、待ち行列にあるか (周期・階層・API・フローのどれでも)。 */
  isEchonetBusy() {
    return !!this._pending || (this._requestDepth || 0) > 0
  }

  /** SK コマンドの待ち行列の長さ (実行中のものは数えない)。 */
  queueLength() {
    return this._queue.length
  }

  /** 実行中の SK コマンド (無ければ null)。秘密の引数 (SKSETPWD など) は伏せる。 */
  currentCommand() {
    const c = this._current
    return c ? SK.maskSecretCommand(c.command) : null
  }

  /** 接続時に 1 度だけ取る値 (係数・単位など) を取っている途中なら、その Promise (済めば解ける)。無ければ null。 */
  collectingOnce() {
    return this._collectingOnce || null
  }

  /** 定期取得を今すぐ 1 回 (自動運転中でつながっているときだけ。次の周期はそこから数える)。 */
  pollNow() {
    this._schedulePoll(0)
  }

  /** 画面表示用の状態スナップショット。 */
  snapshot() {
    return {
      // 読み込まれているコードの版。
      // ノードのコードを入れ替えたのに反映されていない、を見分けるために出す
      // (パレットの再インストールだけでは require キャッシュが残ることがある)。
      libVersion: LIB_VERSION,
      label: this.options.label || null,
      phase: this.state.phase,
      phaseText: PHASES[this.state.phase] || this.state.phase,
      running: this._running,
      portOpen: this.state.portOpen,
      connected: this.state.connected,
      device: Object.assign({}, this.state.device),
      meter: Object.assign({}, this.state.meter),
      calibration: Object.assign({}, this.state.calibration),
      radioBlocked: this.state.radioBlocked,
      keyBlocked: this.state.keyBlocked,
      ladder: this.state.ladder,
      consecutiveFailures: this.state.consecutiveFailures,
      join: Object.assign({}, this.state.join),
      connectHint: this.state.connectHint ? Object.assign({}, this.state.connectHint) : null,
      txBudgetMs: this.state.txBudgetMs,
      // 送信積算がここを超えると、PANA を粘るのをやめて自分から休む [ms] (見張りを切っていれば null)。
      // 画面の送信積算のゲージの線 (画面に写しを持たせない)
      txBudgetGuardMs: this.options.txBudgetGuard ? this.options.txBudgetGuardMs : null,
      overrides: {
        stopped: this.state.overrides.stopped ? Object.assign({}, this.state.overrides.stopped) : null,
        pollIntervalSec: this.state.overrides.pollIntervalSec,
        pollEpcs: this.state.overrides.pollEpcs ? this.state.overrides.pollEpcs.slice() : null,
        any:
          !!this.state.overrides.stopped ||
          this.state.overrides.pollIntervalSec !== null ||
          this.state.overrides.pollEpcs !== null,
      },
      wopt: this.state.wopt,
      sendFails: Object.assign({}, this.state.sendFails),
      pollIntervalSec: this.options.pollIntervalSec,
      pollEpcs: this.options.pollEpcs.slice(),
      // Get_SNA で拒否されて、いま要求を控えている EPC (期限が来たらまた聞く。永久には外さない)。
      // 互換のために unsupportedEpcs の名前のまま出す。
      unsupportedEpcs: this._heldEpcs().map(hexEpc),
      snaHold: Object.keys(this.state.snaHold).reduce((acc, k) => {
        acc[k] = Object.assign({}, this.state.snaHold[k])
        return acc
      }, {}),
      supportedEpcs: this.state.supportedEpcs.map(hexEpc),
      // いま分かっている全プロパティ (取得時刻つき)。
      // 階層取得では毎回 全部が来るわけではないので、ここに溜めたものを配る。
      known: Object.keys(this.state.values).sort().reduce((acc, k) => {
        const v = this.state.values[k]
        acc[k] = { name: v.name, display: v.display, value: v.value, unit: v.unit, at: v.at }
        return acc
      }, {}),
      lastValueAt: this.state.lastValueAt,
      valueWaitSince: this.state.valueWaitSince,
      lastError: this.state.lastError,
      queued: this._queue.length,
      current: this._current ? this._current.label : null,
      counters: Object.assign({}, this.state.counters),
      credentials: {
        configured: this.validateCredentials().length === 0,
        source: this.credentials.source,
        idHint: this.credentials.id ? this.credentials.id.slice(0, 4) + '…' + this.credentials.id.slice(-4) : null,
      },
    }
  }

  /** ポーリング間隔を変える。下限は options.minPollIntervalSec。 */
  setPollInterval(sec, opts) {
    const n = parseInt(sec, 10)
    if (isNaN(n)) return this.options.pollIntervalSec
    const min = this.options.minPollIntervalSec
    if (n < min) {
      this._log('warn', `取得間隔の下限は ${min} 秒です（1 回の SKSENDTO は OK と EVENT 21 の両方を待つため）`)
      this.options.pollIntervalSec = min
    } else {
      this.options.pollIntervalSec = n
    }
    // 外から来た指示は「設定の上書き」として記録する。
    // 記録しておけば、画面で素の設定と区別でき、あとで戻せる。
    if (opts && opts.external) this.state.overrides.pollIntervalSec = this.options.pollIntervalSec
    if (this.isConnected) this._schedulePoll()
    return this.options.pollIntervalSec
  }

  /** 定期取得するプロパティを変える。 */
  setPollEpcs(epcs, opts) {
    const list = (Array.isArray(epcs) ? epcs : [epcs]).map(toEpc).filter((n) => n !== null)
    if (!list.length) return this.options.pollEpcs
    this.options.pollEpcs = list
    if (opts && opts.external) this.state.overrides.pollEpcs = list.slice()
    this._log('info', '定期的に取りに行く値: ' + list.map(hexEpc).join(', '))
    return this.options.pollEpcs
  }

  /**
   * 外から来た上書きを全部やめて、設定ノードの値に戻す。
   * 停止させられていた場合は自動運転も再開する。
   *
   * 無人運転では「誰かが一度 stop を投げたまま忘れる」のが一番危ない。
   * 元に戻す入口を 1 つ用意しておく。
   */
  /**
   * 上書きを 1 項目だけやめて、設定ノードの値に戻す。
   *
   * 「取得間隔の上書きをやめたい」だけのときに resetOverrides() を呼ぶと、
   * 停止の上書きまで解除されて、点検中のアダプタが動き出してしまう。
   */
  /**
   * 設定ノードで指定された定期取得プロパティ。
   *
   * Get_SNA で拒否されたものもここでは外さない。外すと二度と戻らない
   * (一時的な拒否だけで、瞬時電力のような毎回取る値が取れなくなる)。
   * 控えている間の絞り込みは、送る直前に _pollable() でする。
   */
  _configuredEpcs() {
    return this._baseline.pollEpcs.slice()
  }

  resetOverride(name) {
    const o = this.state.overrides
    if (name === 'pollIntervalSec' && o.pollIntervalSec !== null) {
      this.options.pollIntervalSec = this._baseline.pollIntervalSec
      o.pollIntervalSec = null
      this._log('info', `取得間隔を設定どおり（${this.options.pollIntervalSec} 秒）に戻しました`)
      if (this.isConnected) this._schedulePoll()
    } else if (name === 'pollEpcs' && o.pollEpcs !== null) {
      this.options.pollEpcs = this._configuredEpcs()
      o.pollEpcs = null
      this._log('info', '定期的に取りに行く値を設定どおりに戻しました: ' + this.options.pollEpcs.map(hexEpc).join(', '))
    }
    this.emit('status', this.snapshot())
    return this.snapshot().overrides
  }

  resetOverrides(reason) {
    const o = this.state.overrides
    const back = []

    if (o.pollIntervalSec !== null) {
      this.options.pollIntervalSec = this._baseline.pollIntervalSec
      o.pollIntervalSec = null
      back.push(`取得間隔 ${this.options.pollIntervalSec} 秒`)
    }
    if (o.pollEpcs !== null) {
      this.options.pollEpcs = this._configuredEpcs()
      o.pollEpcs = null
      back.push('定期的に取りに行く値 ' + this.options.pollEpcs.map(hexEpc).join(', '))
    }

    const wasStopped = !!o.stopped
    o.stopped = null

    if (back.length) this._log('info', '設定どおりに戻しました: ' + back.join(' / '))
    if (wasStopped || !this._running) {
      this._log('info', `自動運転に戻します${reason ? '（' + reason + '）' : ''}`)
      this.start()
    } else if (this.isConnected) {
      this._schedulePoll()
    }
    this.emit('status', this.snapshot())
    return this.snapshot().overrides
  }

  /** 段階的な再接続を明示的に始める。 */
  async reconnect(reason, ladder) {
    // 閉じている途中 (destroy の SKTERM の最中) は、再接続しない。
    // ここで _abortQueue すると、閉じる前の SKTERM を取り消し、メーター側にセッションが残る
    if (this.isClosing()) {
      this._log('warn', `閉じている途中なので、再接続しません（${reason || '指示'}）`)
      return
    }
    // 外部から止められているなら、再接続では起こさない。
    //
    // reconnect は「一時的な上書き」として案内しているのに、
    // 「続く上書き」である stop / terminate を黙って解除していた。
    // 点検のために止めたアダプタが、画面の再接続ボタンひとつで動き出す。
    if (this.state.overrides.stopped) {
      this._log(
        'warn',
        `外部の指示で停止中のため再接続しません（${this.state.overrides.stopped.reason}）。` +
          'start か auto で自動運転に戻してください'
      )
      return
    }
    // 段階は 0〜3 の整数だけ (画面の API とフローの入力は先に 422 で断る。ここは最後の守り)
    if (isLadder(ladder)) this.state.ladder = ladder
    else if (ladder !== undefined && ladder !== null) this._log('warn', `再接続の段 ${String(ladder).slice(0, 20)} は 0〜${LADDER_MAX} の整数ではないので、いまの段のまま再接続します`)
    if (!this._running) {
      this._running = true
      this._startWatchdog()
      this._log('info', '再接続のため、自動運転を始めました')
    }
    this._bumpGeneration()
    // 繋ぎ直している間は「計測中」と見せない。下ろさないと、値が古くなるまで緑のままになる
    this._markDown()
    // 取得のタイマーも止める。止めないと、古いセッションのまま階層の要求が
    // 出ていき、そのあと疎通確認がその応答待ちの後ろで最大 70 秒待たされる。
    // 繋がり直したら _afterJoin がまた張る。
    this._stopCollecting()
    this._abortQueue('再接続')
    this._clearPending('再接続')
    this._log('warn', `再接続します（段 ${this.state.ladder}）: ${reason || '指示'}`)
    this.state.counters.reconnects++
    this._wakeUp() // 再試行の待ちに入っていたら、待たせずに始める
    this._loop()
  }

  /**
   * PANA セッションを明示的に終了して、自動運転を止める。
   *
   * 手順は stop() と同じように畳んでから SKTERM を送る。畳まないと、実行中の SKSCAN が終わったあとに続きが流れ、
   * SKTERM のあとに SKJOIN を送って、終えたはずのセッションを張り直す。
   * 応答待ちも畳む。残すと、タイマーが止めたあとに SKSENDTO を送り直し、セッションの無いモジュールから ER10 が返って段階まで動く。
   */
  async terminate() {
    // 前の SKTERM の決着を待っている間の 2 回目 (画面の二重送信など)。畳むと、送った SKTERM を失敗と書き、もう 1 回送る
    if (this._terminating && !this._running) return this._terminating
    this._running = false
    this.state.overrides.stopped = { reason: 'セッションを終了', at: Date.now() }
    this._markReauthBlock()
    this._bumpGeneration()
    this._wakeUp()
    this._abortQueue('セッションを終了')
    this._clearPending('セッションを終了')
    this._stopCollecting()
    this._stopWatchdog()
    this._clearReauthTimeout()
    this.state.connectHint = null
    this._markDown()
    // SKTERM の結果を待たずに移す。待っている間に start されたとき、終わったあとで運転中の相を上書きしないように
    this._setPhase('overridden', 'セッションを終了')
    // ポートが閉じていると、SKTERM は開くまで待ち行列に残り、この Promise が返らない。
    // 残ったセッションは、次の起動の SKRESET の前に畳む (_termBeforeReset)
    if (!this.state.portOpen) {
      this._log('warn', 'ポートが閉じているので SKTERM を送らずに止めました（次の起動で送ります）。auto を送ると自動運転に戻ります')
      return
    }
    const done = this._sendTerminate().finally(() => {
      if (this._terminating === done) this._terminating = null
    })
    this._terminating = done
    return done
  }

  /** terminate の SKTERM を送り、決着まで待つ。失敗しても投げない (_runLoop がこの決着を待つ)。 */
  async _sendTerminate() {
    try {
      // 認証の途中で呼ばれると、SKTERM は EVENT 24/25 が返るまで保留になる。
      // 保留の見切り (panaPendingMaxMs) より先にあきらめると、セッションを残したまま終えてしまう
      await this._send(
        'SKTERM',
        { ok: true, events: [0x27], failEvents: [0x28] },
        { timeout: Math.max(15000, this.options.panaPendingMaxMs + 5000), tries: 1, optional: true }
      )
    } catch (err) {
      // ER10 はセッションが無いということで、EVENT 28 はセッションを終えた扱い。どちらも畳めている
      if (err.code === 'ER10') {
        this._panaSession = false
      } else if (err.event !== 0x28) {
        this._log('warn', 'メーターとのセッションを終了できませんでした: ' + err.message)
        this.emit('status', this.snapshot())
        return
      }
    }
    if (!this._running) this._log('warn', '外部の指示でセッションを終了しました。auto を送ると自動運転に戻ります')
    this.emit('status', this.snapshot())
  }

  /** EVENT 33 を取りこぼした場合の手動解除。 */
  clearRadioBlock() {
    if (!this.state.radioBlocked) {
      this._log('info', '送信制限は掛かっていません')
      return false
    }
    this._setRadioBlocked(false, '手動解除')
    return true
  }

  /**
   * スキャンの DURATION の並びを変える (画面とフローの構成の変更)。次のスキャンから効く。再接続しない。
   * 前回うまくいった位置 (_lastGoodDurationIndex) は、新しい並びの外を指すとスキャンを 1 回も撃たなくなるので忘れる。
   * @param {number[]} list 2〜14 の整数の並び (検証は lib/runtime/config-fields.js)
   * @returns {number[]} 効いた並び
   */
  setScanDurations(list) {
    const next = (Array.isArray(list) ? list : []).filter((n) => Number.isInteger(n) && n >= 0 && n <= 14)
    if (!next.length) return this.options.scanDurations.slice()
    this.options.scanDurations = next.slice()
    this._lastGoodDurationIndex = null
    this._log('info', `スキャンの段階を ${next.join(', ')} にしました（次のスキャンから）`)
    return next.slice()
  }
  /**
   * 基準（設定どおりの値）を変える。Web UI の運用設定（settings.json）から呼ぶ。
   *
   * _baseline と options の両方を変え、取得の予定を組み直す。再接続はしない。
   * 外部の上書き（入力メッセージの interval / epcs）が掛かっている項目は、options は変えず
   * _baseline だけ変える。上書きを外したときに、新しい基準へ戻るようにするため。
   * 下限は minPollIntervalSec・minTierIntervalSec で丸める。
   *
   * @param {object} partial {pollIntervalSec?, pollEpcs?, slowIntervalSec?, halfHourIntervalSec?}
   * @returns {object} いま効いている値
   */
  setBaseline(partial) {
    const p = partial || {}
    const o = this.options
    const ov = this.state.overrides
    const changed = []
    let pollChanged = false
    const tiers = []

    if (p.pollIntervalSec !== undefined && p.pollIntervalSec !== null) {
      let n = parseInt(p.pollIntervalSec, 10)
      if (!isNaN(n)) {
        if (n < o.minPollIntervalSec) {
          this._log('warn', `取得間隔の下限は ${o.minPollIntervalSec} 秒です（${n} 秒は ${o.minPollIntervalSec} 秒にします）`)
          n = o.minPollIntervalSec
        }
        this._baseline.pollIntervalSec = n
        if (ov.pollIntervalSec === null && o.pollIntervalSec !== n) {
          o.pollIntervalSec = n
          pollChanged = true
        }
        changed.push(`取得間隔 ${n} 秒`)
      }
    }

    if (p.pollEpcs !== undefined && p.pollEpcs !== null) {
      const list = (Array.isArray(p.pollEpcs) ? p.pollEpcs : [p.pollEpcs]).map(toEpc).filter((n) => n !== null)
      if (list.length) {
        this._baseline.pollEpcs = list.slice()
        if (ov.pollEpcs === null) o.pollEpcs = list.slice()
        changed.push('定期的に取りに行く値 ' + list.map(hexEpc).join(', '))
      }
    }

    for (const [key, tier, label] of [
      ['slowIntervalSec', 'slow', '積算の取得間隔'],
      ['halfHourIntervalSec', 'halfHour', '定時積算の取得間隔'],
    ]) {
      if (p[key] === undefined || p[key] === null) continue
      let n = parseInt(p[key], 10)
      if (isNaN(n)) continue
      if (n < o.minTierIntervalSec) n = o.minTierIntervalSec
      this._baseline[key] = n
      if (o[key] !== n) {
        o[key] = n
        tiers.push(tier)
      }
      changed.push(`${label} ${n} 秒`)
    }

    if (changed.length) {
      this._log('info', '設定を変えました（再接続しません）: ' + changed.join(' / '))
      if (this.isConnected) {
        if (pollChanged) this._schedulePoll()
        for (const tier of tiers) this._scheduleTier(tier)
      }
      this.emit('status', this.snapshot())
    }
    return {
      pollIntervalSec: o.pollIntervalSec,
      pollEpcs: o.pollEpcs.slice(),
      slowIntervalSec: o.slowIntervalSec,
      halfHourIntervalSec: o.halfHourIntervalSec,
    }
  }

  /**
   * 電波を使わない読み出しを 1 つ送り、受け取った行を返す (Web UI の診断)。
   *
   * 許可リストのコマンドだけを raw() と同じキューで送る。
   *   SKINFO / SKVER / SKAPPVER / ROPT / SKTABLE 1|2|E|F /
   *   SKSREG S02|S03|S07|S0A|S15|S16|S17|SA2|SFD|SFE|SF0 (読み出しだけ。値を付けたものは通さない)
   * 許可リストに無ければ FORBIDDEN_COMMAND の CommandError。
   * 行は、このコマンドが実行中の間に受け取ったもの (ERXUDP は除く)。認証 ID とパスワードは伏せる。
   *
   * @returns {Promise<{command: string, lines: string[], result: object}>}
   */
  diagRead(command) {
    const cmd = String(command || '').trim().replace(/\s+/g, ' ').toUpperCase()
    const allowed = /^(SKINFO|SKVER|SKAPPVER|ROPT|SKTABLE [12EF]|SKSREG (S02|S03|S07|S0A|S15|S16|S17|SA2|SFD|SFE|SF0))$/
    if (!allowed.test(cmd)) {
      return Promise.reject(
        new CommandError(`${cmd.split(' ')[0] || '(空)'} は診断の読み出しとして許可されていません`, {
          code: 'FORBIDDEN_COMMAND',
          forbidden: true,
          command: cmd,
        })
      )
    }
    const secrets = [this.credentials.id, this.credentials.password].filter((s) => typeof s === 'string' && s.length >= 4)
    const mask = (line) => {
      let s = String(line)
      for (const x of secrets) s = s.split(x).join('********').split(x.toLowerCase()).join('********')
      return s
    }
    this._diagSeq = (this._diagSeq || 0) + 1
    const label = `${cmd.split(' ')[0]} [診断 ${this._diagSeq}]`
    const lines = []
    const onRaw = (line) => {
      if (!this._current || this._current.label !== label) return
      if (/^ERXUDP\b/.test(String(line))) return
      lines.push(mask(line))
    }
    this.on('raw', onRaw)
    const done = () => this.removeListener('raw', onRaw)
    return this._send(cmd, { ok: true }, { label, tries: 1, diag: true }).then(
      (result) => {
        done()
        // 送信時間の積算 (SFD) は、PANA が通らないときの見張り (_guardTxBudget) でしか読んでいない。
        // 診断で読んだ値も入れて、概要の「送信積算」(snapshot().txBudgetMs) を埋める
        if (cmd === 'SKSREG SFD' && result && /^[0-9A-F]{1,8}$/i.test(String(result.register || ''))) {
          this.state.txBudgetMs = parseInt(result.register, 16)
          this.emit('status', this.snapshot())
        }
        return { command: cmd, lines, result }
      },
      (err) => {
        done()
        if (err && typeof err === 'object') err.lines = lines
        throw err
      }
    )
  }

  // =========================================================================
  //  接続手順
  // =========================================================================

  /**
   * 自動運転の本体。接続し、切れたら段階的に繋ぎ直す。
   * 例外は握って再接続に回すので、呼び出し側は await しなくてよい。
   */
  async _loop() {
    // 二重起動を防ぐ。
    // reconnect() は「畳んでから _loop() を呼ぶ」が、呼んだ時点で
    // 既に走っている _loop が _untilDisconnected の中にいると、
    // そちらは世代交代に気づいて次の周回へ進む。
    // 守らないと SKRESET や SKSCAN を二重に撃ち、モジュールを固める。
    if (this._loopActive) return
    this._loopActive = true
    try {
      await this._runLoop()
    } finally {
      this._loopActive = false
    }
  }

  async _runLoop() {
    // ここは「あきらめない」ことが仕様。無人運転では、
    // 止まったことに誰も気づけないほうが、繋ぎ直しを繰り返すより困る。
    // 抜けるのは stop() / destroy() で明示的に止められたときだけ。
    while (this._running && !this._closed) {
      const gen = this._generation
      try {
        await this._ensurePortOpen()
        // 開くのを待っている間に止められたら、続きへ進まない (止めた相を手順が上書きする)
        this._assertAlive()
        // terminate の SKTERM の決着を待ってから段を選ぶ。セッションがまだあるように見えて、SKTERM のあとに SKREJOIN を送り ER10 で空振りする
        if (this._terminating) {
          await this._terminating
          this._assertAlive()
        }
        // モジュールの状態が分からないときは、段階に関係なく最初から。
        const known = !this._needReset
        // SKREJOIN はセッションが無ければ ER10 で終わるだけなので、そのときは段 0 でも SKJOIN から
        if (known && this.state.ladder === 0 && this.state.meter.ipv6 && this._panaSession) {
          await this._rejoin()
        } else if (known && this.state.ladder <= 1 && this.state.meter.ipv6) {
          await this._joinKnownMeter()
        } else if (known && this.state.ladder === 2 && this.credentials.id) {
          await this._scanAndJoin()
        } else {
          await this._fullSequence()
        }
        // ここまで来たら接続できている。切れるまで待つ。
        // 連続失敗はここでは戻さない。接続の確認が通っても値が来るとは限らない (_noteValueArrived)
        this.state.ladder = 0
        this._retryFailures = 0
        await this._untilDisconnected(gen)
      } catch (err) {
        if (!this._running || this._closed) return // stop() / destroy()
        if (err && err.aborted) {
          // reconnect() による畳み込み。段階は呼んだ側が決めているので、
          // ここで return すると誰も手順を再開しないまま静かに止まる。
          // 接続の途中の失敗を手当てした (_handled) ときだけは、数えて待つ。待たないと SKJOIN とスキャンが
          // 間を空けずに回って送信時間を食い、連続失敗も 0 のままで知らせが出ない
          if (err.handled) await this._afterHandledFailure(err)
          continue
        }
        // 数えてから状態を配る。順序を逆にすると、
        // 画面や通知が 1 回ぶん古い連続失敗回数を見ることになる。
        if (err.stage === 'join' && this.state.meter.ipv6) {
          // SKJOIN だけが通らない状態。SKRESET まで上げても意味が無い
          // (段階 3 の周回でもキー設定は毎回入れ直していて、それでも通らない)。
          // まず再スキャンでアドレスとチャネルを取り直す。
          this.state.join.windows++
          if (this.state.join.windows >= this.options.joinResetAfterWindows) {
            this.state.join.windows = 0
            this._bumpLadder(3)
          } else {
            this._resetLadder(2, '認証をやり直せる時間を使い切ったので、スキャンからやり直します')
          }
        } else {
          this._bumpLadder()
        }
        // 粘りの窓の終わりは、_joinKnownMeter がバーストの終わりに数えてある
        if (err.stage !== 'join') this.state.consecutiveFailures++
        this._retryFailures++
        this._recordError(err)
        const wait = this._retryDelay(err)
        this._log(
          'error',
          `${err.message} — ${Math.round(wait / 1000)} 秒後に段 ${this.state.ladder} で再試行します` +
            `（連続 ${this.state.consecutiveFailures} 回目。自動運転は止めません）`
        )
        this._abortQueue('再接続前の整理')
        this._clearPending('再接続前の整理')
        await this._sleep(wait)
      }
    }
  }

  /**
   * 接続の途中で手当てした失敗 (_handled) を数えて、間を空ける。
   *
   * 段は _afterSendFailure が決めているが、同じ段を繰り返しても直らないときは 1 つ上げる。
   * 上げないと、SKJOIN は通るのに SKSENDTO だけが ER10 を返す状態で、同じ段を回り続けて SKRESET に届かない。
   */
  async _afterHandledFailure(err) {
    this.state.consecutiveFailures++
    this._retryFailures++
    if (this._retryFailures % Math.max(1, this.options.pollMissLimit) === 0) this._bumpLadder()
    this._recordError(err)
    const wait = this._retryDelay(err)
    this._log(
      'warn',
      `${err.message} — ${Math.round(wait / 1000)} 秒後に段 ${this.state.ladder} で再試行します` +
        `（連続 ${this.state.consecutiveFailures} 回目。自動運転は止めません）`
    )
    await this._sleep(wait)
    // 止められた・ポートが閉じたなら、もう粘らない。見張りへ進むと、止めたあとに SFD を読み、積算が多いと 10 分寝て start が効かない
    if (!this._running || this._closed || !this.state.portOpen) return
    try {
      await this._guardTxBudget()
    } catch (e) {
      // 畳まれただけ。ここは _runLoop の catch の中なので、投げると自動運転が黙って止まる
    }
  }

  /**
   * 再試行までの待ち時間。
   *
   * あきらめる段は作らない。ただし失敗が続いているときに
   * 15 秒ごとに SKSCAN を撃ち続けると、ARIB STD-T108 の送信総和時間
   * (1 時間あたり 360 秒) を自分で食い潰し、EVENT 32 で全部止まる。
   * 連続失敗に応じて間隔を伸ばし、上限で頭打ちにする。
   */
  /**
   * 途中で起こせる待ち。
   *
   * 再試行の間隔は連続失敗で 5 分まで伸びる。素の setTimeout で寝ると、
   * 画面の「再接続」を押しても最大 5 分反応しないことになる。
   */
  _sleep(ms, why) {
    return new Promise((resolve) => {
      // 「いま意図して待っている」ことを見張りに伝える。
      // 伝えないと、再試行の待ちそのものを滞留と誤判定して叩き切られ、
      // maxRetryDelayMs (5 分) まで伸ばしたはずの間隔が
      // 見張りの周期 (約 75 秒) で頭打ちになる。
      this._waitingFor = why || '再試行の待ち'
      const done = () => {
        this._wake = null
        this._waitingFor = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      this._wake = () => {
        clearTimeout(timer)
        done()
      }
    })
  }

  /**
   * いま「意図して待っている」なら、その理由。
   * 見張り (_checkStall) はこれを叩かない。止まっているのではなく、
   * 待つのが正しい状態だから。
   */
  _deliberateWait() {
    if (this._waitingFor) return this._waitingFor
    if (this.state.radioBlocked) return '送信総和時間の制限中（EVENT 32）'
    if (this.state.keyBlocked) return '自動鍵配信中（EVENT 54）'
    if (this.state.phase === 'reauth') return 'メーターと再認証中（EVENT 29）'
    return null
  }

  /** 待っている最中なら今すぐ起こす。 */
  _wakeUp() {
    if (this._wake) this._wake()
  }

  _retryDelay(err) {
    if (err && err.stage === 'join') {
      // 粘りは _joinKnownMeter の中で済ませている。外側でさらに 5 分待つと
      // 再スキャンの間隔まで伸びて、粘る意味が消える。
      return this._burstBackoff(this.options.joinBurstBackoffMs.length)
    }
    const base = this.options.retryBaseMs * Math.max(1, this.state.ladder)
    const steps = Math.min(6, Math.max(0, this._retryFailures - 1))
    return Math.min(this.options.maxRetryDelayMs, base * Math.pow(2, steps))
  }

  /** 接続が切れるまで待つ。切れたら resolve して _loop に戻る。 */
  _untilDisconnected(gen) {
    return new Promise((resolve) => {
      const check = () => {
        if (this._generation !== gen || !this._running || this._closed) return resolve()
        // EVENT 29 の自動再認証中は「切れた」とみなさない。
        //
        // マニュアル 8 章では EVENT 29 〜 EVENT 24/25 の間は無線送信コマンドを
        // 出せない。ここで戻ってしまうと _runLoop が次の周回へ進み、
        // _rejoin() の 1 行目 _setPhase('rejoining') が
        //   ・_pump の禁止判定 (phase === 'reauth') を自分で外し
        //   ・_setPhase の from === 'reauth' 分岐で見切りタイマーまで消す
        // ため、禁止期間のまっただ中で SKREJOIN を撃つことになる。
        //
        // 'reauth' から出る道は 3 つしかない:
        //   EVENT 25 (成功) / EVENT 24 (失敗) / _armReauthTimeout の見切り
        // どれも phase を動かすので、ここはそれを待つだけでよい。
        // 'verifying' も待つ。EVENT 25 のあと _afterJoin は
        //   verifying へ移す → 疎通確認 (Get 0x80) → connected = true
        // の順に進むので、その途中は connected がまだ false。
        // ここで「切れた」と判断すると、疎通確認中に SKREJOIN を撃ってしまう。
        if (this.state.phase === 'reauth' || this.state.phase === 'verifying') return setTimeout(check, 250)
        if (!this.state.connected) return resolve()
        setTimeout(check, 1000)
      }
      check()
    })
  }

  async _ensurePortOpen() {
    if (this.state.portOpen) return
    this._setPhase('opening')
    try {
      await this.transport.open()
    } catch (err) {
      // 開けなかった回数だけ段階が上がる。段階 2 で開くと初期化を飛ばして
      // SKSCAN から始めていたので、開けたら必ず SKRESET からにする。
      this._needReset = true
      this._reportDetail(err)
      throw err
    }
    // open イベントで portOpen が立つ。立たない実装のために補う。
    this.state.portOpen = true
  }

  /**
   * 利用者に見せない原文 (Require stack の絶対パスなど) を、Node-RED のログだけへ出す。
   * 'log' は画面のログにも流れるので使わない。同じ原文は 1 回だけにする (再試行のたびに複数行を残さない)。
   */
  _reportDetail(err) {
    if (!err || !err.detail || err.detail === this._detailShown) return
    this._detailShown = err.detail
    if (this.listenerCount('error')) this.emit('error', new Error(`${err.message} — ${err.detail}`))
  }

  /** リセットから接続完了までの全部。 */
  async _fullSequence() {
    const problems = this.validateCredentials()
    if (problems.length) {
      this._setPhase('need-secrets', problems.join(' / '))
      throw new CommandError('認証情報が未設定か、書式が違います: ' + problems.join(' / '))
    }

    this._setPhase('resetting')

    // 裸の <CR> を 1 回。モジュールの入力バッファに前回の書きかけが残っていると、
    // 次のコマンドがそれに連結されて FAIL ER04 になる (実機で再現済み)。
    // マニュアル 7 章の ER09 復旧手順と同じ考え方。応答は見ない。
    await this._send('', { settle: 400 }, { label: 'flush', tries: 1 })

    if (this._termBeforeReset || this._panaSession) {
      // 通電したままのモジュールに前のセッションが残っている場合に備え、
      // メーター側のセッションを畳んでからリセットする (コンストラクタの説明を参照)。
      // 段階 3 で来たときも同じ。認証は通るのに ECHONET が返らない状態から上がると、セッションがある
      await this._tryTerm()
      this._termBeforeReset = false
    }

    // 下ろすのは、鍵と S2・S3 が入ったあと (_scanAndJoin)。途中で畳まれて段を指定した reconnect が来たとき、
    // 「状態が分かっている」と見ると、設定の消えたモジュールへ SKJOIN を撃って 30 分粘る
    this._needReset = true
    await this._send('SKRESET', { ok: true }, { timeout: this.options.resetTimeout })
    await delay(this.options.resetSettleMs) // マニュアル 10.4
    // この 3 秒の窓で stop されても、_abortQueue が畳めるのは
    // 「そのときキューに居る分」だけ。ここで見ないと、停止指示のあとに
    // 続きの SKSREG / SKSCAN が流れてフェーズが overridden を上書きする。
    this._assertAlive()

    this._setPhase('configuring')

    // エコーバックを止める。SFE は FLASH 保存の対象外なので毎回必要。
    await this._send('SKSREG SFE 0')
    // アクティブ MAC 面を B 面に固定する。同じく RAM のみ。
    await this._send('SKSREG SF0 0')
    // ERXUDP に受信の強さ (RSSI) を付ける (マニュアル 4.1)。これで応答のたびに LQI が分かる。FLASH には書かない。
    // 通らないモジュールでも計測は続ける (LQI はスキャンのときだけになる)
    try {
      await this._send('SKSREG SA2 1', { ok: true }, { tries: 1, optional: true })
    } catch (err) {
      if (err && err.aborted) throw err
      this._log('info', 'ERXUDP に受信の強さを付けられませんでした（LQI はスキャンのときだけ更新します）')
    }

    const ver = await this._send('SKVER')
    if (ver.version) {
      this.state.device.version = ver.version
      this.emit('device', Object.assign({}, this.state.device))
      if (ver.version.startsWith('1.5.2')) {
        // マニュアル 10.7 の既知不具合。SKVER は rev を返さないので対象前提で警告する。
        this._log(this._noticeLevel(), `アダプタのファームウェア ${ver.version} には、49 日動かし続けるとメーターとの認証の更新が止まる既知の不具合があります。ノードが応答を確かめて自動でつなぎ直すので、操作は要りません`)
      }
    }

    await this._identify()
    await this._ensureHexErxudp()
    await this._sendKeys()
    await this._scanAndJoin()
  }

  /** SKINFO で自分の MAC を確認する。ポート取り違えの検出。 */
  async _identify() {
    const info = await this._send('SKINFO')
    if (!info.mac) return
    this.state.device.mac = info.mac
    this.state.device.ipv6 = info.ipv6
    this.emit('device', Object.assign({}, this.state.device))

    const expected = this.options.expectedMac
    if (expected && String(expected).toUpperCase() !== info.mac.toUpperCase()) {
      // /dev/ttyUSB* の番号は USB の列挙順で決まり、再起動や抜き差しで入れ替わる。
      // 設定したつもりの個体と実際に開いた個体がずれる事故をここで拾う。
      this._log('error', `このポートにつながっているのは想定と違うアダプタです。想定 ${expected} / 実際 ${info.mac}`)
      this.emit('mismatch', { expected, actual: info.mac })
    } else {
      this._log('info', `アダプタを確かめました: MAC=${info.mac}`)
    }
  }

  /**
   * ERXUDP のデータ部を 16 進 ASCII 表示にする。
   *
   * 受信は CR 区切りなので、バイナリ表示のままだとデータ中の 0x0D で
   * 行が割れて復元できない。16 進 ASCII なら [0-9A-F] しか出ない。
   *
   * ただし WOPT は実行のたびに FLASH へ書き込み、上限は 10,000 回。
   * ROPT で現在値を読み、必要なときだけ 1 回書く。設定は FLASH に残るので
   * 2 回目以降の起動では書き込みが発生しない。
   */
  async _ensureHexErxudp() {
    const ropt = await this._send('ROPT', { ok: true }, { crlf: false })
    const mode = ropt.value !== undefined && ropt.value !== null ? parseInt(ropt.value, 16) : NaN
    this.state.wopt = isNaN(mode) ? null : mode

    if (isNaN(mode)) {
      this._log('warn', 'ROPT の値を読めませんでした。WOPT の設定は変更しません')
      return
    }
    if (mode & 0x01) {
      this._log('info', `ERXUDP は既に 16 進 ASCII 表示です（WOPT=0x${pad2(mode)}）`)
      return
    }
    if (!this.options.autoWriteWopt) {
      this._log('warn', 'ERXUDP がバイナリ表示ですが、WOPT の自動書き込みが無効です。計測値を復元できない可能性があります')
      return
    }
    this._log(this._noticeLevel(), 'アダプタの受信データの表示形式が初期値のままです。計測値を読める 16 進表示へ 1 回だけ書き換えます（設定はアダプタに残るので、次の起動では書き換えません）')
    await this._send('WOPT 01', { ok: true }, { crlf: false })
    this.state.wopt = 1
    this._log('info', '受信データの表示形式を 16 進表示へ書き換えました')
  }

  /** スキャンしてメーターを見つけ、設定して接続する。 */
  async _scanAndJoin() {
    // メーターのチャネルはふつう変わらない。まず知っているチャネルだけを探し、見えなければ全チャネル
    const pan = (await this._scanKnownChannel()) || (await this._scan())
    this._setPhase('configuring')
    await this._send(`SKSREG S2 ${pan.channelHex}`)
    await this._send(`SKSREG S3 ${pan.panId}`)
    // SKLL64 は OK を返さず、変換したアドレス 1 行だけを返す (マニュアル 3.31)。
    const ll = await this._send(`SKLL64 ${pan.addr}`, { ipv6: true })
    this.state.meter.ipv6 = ll.address
    this._needReset = false // 鍵も S2・S3 も入った
    this._log('info', `IPv6 リンクローカルアドレス: ${ll.address}`)
    this.emit('meter', Object.assign({}, this.state.meter))
    await this._joinKnownMeter()
  }

  /**
   * 知っているチャネルだけのアクティブスキャン。見えたらその PAN、見えなければ null (呼び手が全チャネルへ)。
   * SKSCAN の CHANNEL_MASK は最下位ビットがチャネル 33。
   */
  async _scanKnownChannel() {
    const ch = this.state.meter.channel
    if (typeof ch !== 'number' || ch < 33 || ch > 60) return null
    const mask = ((1 << (ch - 33)) >>> 0).toString(16).toUpperCase().padStart(8, '0')
    for (const dur of this.options.knownChannelScanDurations || []) {
      this._setPhase('scanning', `チャネル ${ch}・スキャンの段階 ${dur}`)
      this.state.counters.targetedScans++
      this._scanResults = []
      const estimate = 0.0096 * (Math.pow(2, dur) + 1) * 1000
      await this._send(
        `SKSCAN ${this.options.scanMode} ${mask} ${dur.toString(16).toUpperCase()} ${this.options.side}`,
        { events: [0x22] },
        { label: `SKSCAN(ch${ch} D=${dur})`, timeout: Math.max(10000, Math.round(estimate * 2 + 5000)), tries: 1 }
      )
      const best = this._scanResults.length ? this._pickPan(this._scanResults) : null
      if (best) {
        this._adoptPan(best)
        return best
      }
      this._log(this._noticeLevel(), `チャネル ${ch} のスキャンの段階 ${dur} ではメーターが見つかりません`)
    }
    this._log('warn', `チャネル ${ch} ではメーターが見つかりません。全チャネルを探します`)
    return null
  }

  /** 見つけたメーターを控える。別のメーターなら、前のメーターで学んだことを捨てる。 */
  _adoptPan(best) {
    // 別のメーターに繋ぎ直すなら、前のメーターで学んだことを捨てる。
    // (検定満了による取り替えなど。プロパティマップ・係数・控えている EPC・
    //  取れた値を引き継ぐと、古い係数で換算したり、前の製造番号を出し続けたりする)
    if (this.state.meter.addr && this.state.meter.addr !== best.addr) {
      this._forgetMeter(`メーターが替わりました（${this.state.meter.addr} → ${best.addr}）`)
    }
    Object.assign(this.state.meter, {
      addr: best.addr,
      channel: best.channel,
      channelHex: best.channelHex,
      channelMHz: best.channelMHz,
      panid: best.panId,
      lqi: best.lqi,
      rssi: null,
      lqiAt: Date.now(),
      pairId: best.pairId,
    })
    this._log('info', `メーターを見つけました: ch${best.channel}（${best.channelMHz} MHz）PAN=${best.panId} LQI=${best.lqi} Addr=${best.addr}`)
    this.emit('meter', Object.assign({}, this.state.meter))
    this._clearConnectHint('no-meter')
  }

  /** つながらないときの案内を立てる。同じ理由が続く間は、始まりの時刻を保って回数だけ足す。 */
  _noteConnectHint(kind, since, rounds) {
    const h = this.state.connectHint
    this.state.connectHint = h && h.kind === kind ? { kind, since: h.since, rounds: h.rounds + 1 } : { kind, since, rounds }
    this.emit('status', this.snapshot())
  }

  /** 案内を下ろす。kind を渡すと、その理由のときだけ。 */
  _clearConnectHint(kind) {
    const h = this.state.connectHint
    if (!h || (kind && h.kind !== kind)) return
    this.state.connectHint = null
    this.emit('status', this.snapshot())
  }

  /** アクティブスキャン。見つかるまで DURATION を段階的に伸ばす。 */
  async _scan() {
    const gen = this._generation
    const durations = this.options.scanDurations
    const startedAt = Date.now()
    this.state.counters.fullScans++
    // 前回うまくいった DURATION の 1 つ手前から始める。
    // 記録値そのものから始めると、最大値で成功した環境では
    // 「段階を上げる」枝に二度と入れなくなる。
    let start = this._lastGoodDurationIndex === null ? 0 : Math.max(0, this._lastGoodDurationIndex - 1)

    for (let round = 0; round < this.options.scanRounds; round++) {
      for (let i = start; i < durations.length; i++) {
        const dur = durations[i]
        this._setPhase('scanning', `スキャンの段階 ${dur}`)
        this._scanResults = []
        // <DURATION> は UINT8 = 16 進で解釈される。10 進のまま送ると
        // 10 以上で桁が変わり、実スキャン時間が跳ね上がる (10 → 0x10 = 16)。
        const durHex = dur.toString(16).toUpperCase()
        // マニュアル: 1ch あたり 0.0096*(2^DURATION+1) 秒、全 28ch
        const estimate = 0.0096 * (Math.pow(2, dur) + 1) * 28 * 1000
        await this._send(
          `SKSCAN ${this.options.scanMode} ${this.options.channelMask} ${durHex} ${this.options.side}`,
          { events: [0x22] }, // EVENT 22 = アクティブスキャン完了
          { label: `SKSCAN(D=${dur})`, timeout: Math.max(30000, Math.round(estimate * 2 + 5000)), tries: 1 }
        )
        if (this._scanResults.length) {
          const best = this._pickPan(this._scanResults)
          if (!best) {
            // 電波は届いているが、自分の契約のメーターではなかった。
            // ここで打ち切らずに次の DURATION を試しても同じなので、
            // 何が見えているかを出して終わる。
            this._log(
              'warn',
              `PAN は ${this._scanResults.length} 件見つかりましたが、この認証情報に対応するメーターがありません` +
                `（見えている PairID: ${this._scanResults.map((r) => r.pairId || '-').join(', ')} / ` +
                `必要な PairID: ${this._pairId() || '不明'}）`
            )
            continue
          }
          this._lastGoodDurationIndex = i
          this._adoptPan(best)
          return best
        }
        this._log(this._noticeLevel(), `スキャンの段階 ${dur} ではメーターが見つかりません。探す時間を長くして続けます`)
      }
      start = 0 // 2 巡目以降は最短からやり直す
      this._noteConnectHint('no-meter', startedAt, 1)
      if (round + 1 < this.options.scanRounds) {
        this._log('warn', '一巡して見つかりませんでした。60 秒待って最初からやり直します')
        await this._sleep(60000, 'スキャンの巡回待ち') // 画面から再接続を押されたら途中でも起きる
        this._assertAlive()
        // 起こされた理由が再接続なら、古いスキャンを続けない。
        // _assertAlive は _closed と _running しか見ないので、
        // reconnect() で起こされても素通りして SKSCAN を撃ってしまう。
        if (this._generation !== gen) throw new Aborted('再接続の指示')
      }
    }
    throw new CommandError('メーターが見つかりませんでした。認証 ID が正しいか、アダプタとメーターの距離を確かめてください')
  }

  /**
   * 自分の契約のメーターを選ぶ。
   *
   * SKSETRBID は「認証 ID の下位 8 文字」を Pairing ID (S0A) として設定する
   * (マニュアル 3.19)。EPANDESC の PairID はその PAN の Pairing ID なので、
   * **一致するものが自分の契約のメーター**。
   *
   * 電波の強さで選んではいけない。動力と電力のように 2 つのメーターが
   * 並んで設置されている場所では、隣の契約のメーターの方が強いことが普通にあり、
   * そちらへ SKJOIN して EVENT 24 を繰り返すことになる
   * (認証情報が違うように見えるので、原因に気づきにくい)。
   */
  _pickPan(results) {
    const want = this._pairId()
    if (want) {
      const matched = results.filter((r) => (r.pairId || '').toUpperCase() === want)
      if (matched.length) {
        // 同じ PairID が複数返ることは無いはずだが、念のため電波の良い方
        return matched.reduce((a, b) => ((b.lqi || 0) > (a.lqi || 0) ? b : a))
      }
      // PairID を返さないメーター (SKSCAN mode 3 相当) の場合は判定できない。
      // その場合だけ電波の強さで選ぶ。
      const noPairId = results.filter((r) => !r.pairId)
      if (noPairId.length) {
        this._log('warn', 'PairID を返さない PAN しかありません。電波の強いものを選びます')
        return noPairId.reduce((a, b) => ((b.lqi || 0) > (a.lqi || 0) ? b : a))
      }
      return null
    }
    // 認証 ID が無い状況では判定材料が無い
    return results.reduce((a, b) => ((b.lqi || 0) > (a.lqi || 0) ? b : a))
  }

  /** 自分の Pairing ID (認証 ID の下位 8 文字)。 */
  _pairId() {
    const id = this.credentials.id
    return id && id.length >= 8 ? id.slice(-8).toUpperCase() : null
  }

  /** 既知のメーターへ PANA 接続する。EVENT 24 は 3 回までリトライ (マニュアル 3.4)。 */
  async _joinKnownMeter() {
    const addr = this.state.meter.ipv6
    if (!addr) throw new CommandError('接続先アドレスが未確定です', { code: 'NOT_CONNECTED' })

    const gen = this._generation
    const startedAt = Date.now()
    const persistMs = this.options.joinPersistMs
    let verifyError = null // 直近の試行で、認証は通ったのに疎通確認で失敗した理由
    let joinError = null // 直近の SKJOIN の失敗
    let failedBursts = 0 // 認証を送って通らなかった巡の数 (送信の制限で送れなかった巡は数えない)
    this.state.join.windowStartedAt = startedAt

    for (let burst = 1; ; burst++) {
      this.state.join.burst = burst

      if (burst > 1) {
        // 相手側に古いセッションが残っていると、新規の接続を受け付けない
        // (マニュアル 3.4)。こちらに残っている分だけでも落としておく。
        // セッションが無ければ FAIL ER10 が返るだけで害は無い。
        if (this.options.joinTermBeforeRetry) await this._tryTerm()
        // キーの入れ直し。SKSETPWD は SKRESET 無しで上書きできる
        // (SKRESET が要るのは SKSETPSK のほう)。
        const every = this.options.joinRekeyEveryBursts
        if (every > 0 && burst % every === 1) await this._sendKeys()
      }

      for (let attempt = 1; attempt <= this.options.joinMaxTries; attempt++) {
        this.state.join.attempt = attempt
        this._setPhase('joining', `${burst} 巡目 ${attempt}/${this.options.joinMaxTries}`)
        this.emit('status', this.snapshot())
        const t0 = Date.now()
        let joined = false
        verifyError = null
        try {
          await this._send(`SKJOIN ${addr}`, { events: [0x25], failEvents: [0x24] }, { timeout: this.options.joinTimeout, tries: 1, quiet: true })
          joined = true
          this.state.join.burst = 0
          await this._afterJoin()
          return
        } catch (err) {
          if (err && err.aborted) throw err
          // SKJOIN の FAIL ER10 は、鍵か S3 が無いモジュールの返事 (ER10_ADVICE)。同じアドレスへ粘っても通らないので、最初からやり直す。
          // USB はつながったままモジュールの設定だけが消えると、ポートが閉じる道を通らないのでここで気づく
          if (!joined && err && err.code === 'ER10') {
            this._needReset = true
            throw err
          }
          // 認証が通らないのと、通ったのに ECHONET が返らないのは、利用者がすることが違う
          if (joined) verifyError = err
          else joinError = err
          // SKJOIN の失敗はここの 1 行にまとめる (想定内の再試行なので、error にしない)。経過時間は切り分けに要る。
          // 仕様上、モジュールは 1 回の SKJOIN の中で 7 回再送し、EVENT 24/25 までは最大およそ 38 秒
          // (2+4+8+8+8+8+8 秒、マニュアル 3.4 の待機時間表)。2 秒で返る 24 と 38 秒かけて返る 24 は、意味がまるで違う
          const last = this.state.join.last
          this._log(
            'warn',
            (joined
              ? 'メーターとの認証は通りましたが、メーターから応答がありません'
              : err && err.blocked
                ? 'メーターへ認証を送れませんでした'
                : 'メーターとの認証が通りませんでした') +
              `（${burst} 巡目 ${attempt}/${this.options.joinMaxTries}・` +
              `${((Date.now() - t0) / 1000).toFixed(1)} 秒）: ${err.message}` +
              (!joined && last && last.num === 0x24 && last.sender ? ` 相手=${last.sender}` : '')
          )
          if (attempt < this.options.joinMaxTries) {
            await this._sleep(this.options.joinRetryMs, 'SKJOIN の再試行待ち')
            this._assertAlive()
            if (this._generation !== gen) throw new Aborted('再接続の指示')
          }
        }
      }

      // ここがマニュアル 3.4 の、3 回続いたらエラーとして扱う所。
      // 設定値の確認を促すが、接続をやめることは求められていない。
      //
      // 連続失敗はバーストごとに数える。粘りの窓 (30 分) の終わりにしか数えないと、認証が通らない・応答だけ止まった状態の
      // 知らせが 1 時間半遅れる。理由もここで残す。応答待ちの失敗は _fail を通らないので、残さないと画面に理由が出ない
      //
      // 送信の制限で送れなかった巡は数えない (SKJOIN が保留のまま断られた・認証のあとの確認が断られた)。
      // 数えると、1 度も送っていないのに「n 回続けて通りません」と書き、制限を待つしかない間に段の案内が出る
      const held = verifyError ? verifyError.code === 'RADIO_BLOCKED' : !!(joinError && joinError.blocked)
      if (held) {
        this._recordError({ message: `メーターへ送信できていません: ${(verifyError || joinError).message}。制限が解けると自動で再開します`, code: 'RADIO_BLOCKED' })
      } else {
        failedBursts++
        this.state.consecutiveFailures++
        this._recordError(
          verifyError
            ? { message: `メーターとの認証は通りますが、メーターの応答がありません（${verifyError.message}）`, code: verifyError.code }
            : {
                // この文は alert の理由にも出る。EVENT の名前は内部の語なので番号だけにする
                message: `メーターとの認証が ${failedBursts * this.options.joinMaxTries} 回続けて通りません: ${joinError.event === 0x24 ? 'EVENT 24' : joinError.message}`,
                code: joinError.code,
              }
        )
      }
      const elapsed = Date.now() - startedAt
      const last = this.state.join.last
      const authPassed = held || !!(last && last.num === 0x25) // 送れていない・通ったことがあるなら、認証情報の案内は的外れ
      const hint = this.state.connectHint
      if (!authPassed && (elapsed >= this.options.credentialHintAfterMs || (hint && hint.kind === 'credentials'))) {
        this._noteConnectHint('credentials', startedAt, burst)
      }
      if (!authPassed && !this._credentialHinted && elapsed >= this.options.credentialHintAfterMs) {
        this._credentialHinted = true
        this._log(
          'error',
          `メーターとの認証が ${Math.round(elapsed / 60000)} 分（${failedBursts * this.options.joinMaxTries} 回）通りません。` +
            '認証 ID かパスワードが誤っている可能性があります。' +
            `ただし PairID ${this._pairId() || '不明'} のメーター自体は見つかっており、` +
            'EVENT 24 は接続が完了しなかったことを示すだけで、原因までは分かりません。' +
            'メーターに前の接続が残っている場合も同じ症状になります。自動運転は止めません'
        )
      }

      // 送れていない間は窓を終えない。メーターを探しても同じ制限で送れない
      if (!held && persistMs > 0 && elapsed >= persistMs) {
        const minutes = Math.round(elapsed / 60000)
        const e = new CommandError(
          verifyError
            ? `メーターとの認証は通りますが、メーターの応答が ${minutes} 分ありません（${verifyError.message}）。メーターを探し直します`
            : `メーターとの認証が ${minutes} 分通りません。メーターを探し直します`
        )
        e.stage = 'join'
        throw e
      }

      const wait = this._burstBackoff(burst)
      this._log('warn', `${Math.round(wait / 1000)} 秒待って ${burst + 1} 巡目の SKJOIN を送ります（段は上げません）`)
      // 素の delay ではなく _sleep を使う。_deliberateWait に載らないと、
      // 見張りがこの待ちを滞留と誤判定して SKRESET を撃つ。
      await this._sleep(wait, 'SKJOIN の次の巡の待ち')
      this._assertAlive()
      if (this._generation !== gen) throw new Aborted('再接続の指示')
      await this._guardTxBudget()
    }
  }

  /** バースト間の待ち。配列の最後の値で頭打ち。 */
  _burstBackoff(burst) {
    const list = this.options.joinBurstBackoffMs
    return list[Math.min(Math.max(1, burst) - 1, list.length - 1)]
  }

  /** 残っている PANA セッションを落とす。無ければ FAIL が返るだけ。 */
  async _tryTerm() {
    try {
      await this._send('SKTERM', { ok: true, events: [0x27], failEvents: [0x28] }, { timeout: 15000, tries: 1, optional: true })
      this._log('info', '前のセッションが残っていたので終了しました')
    } catch (err) {
      if (err && err.aborted) throw err
      // ER10 = セッションが無い。EVENT 28 = 終了扱い (_onSkEvent がログに残す)。どちらも正常な結果なので黙って進む。
      if (err.code !== 'ER10' && err.event !== 0x28) this._log('warn', 'SKTERM が通りませんでした: ' + err.message)
      if (err.code === 'ER10') this._panaSession = false
    }
    this._markDown()
  }

  /**
   * SKSETPWD / SKSETRBID の投入。順序はマニュアル 9.2.2 の例に合わせる。
   *
   * <LEN> は 16 進 (マニュアル 3 章の引数規約)。12 桁なら 'C'。10 進で '12' と書くと LEN=0x12=18 と解釈され、
   * 足りない分が不定値のまま PSK が登録される。FAIL にならないぶん質が悪い。
   */
  async _sendKeys() {
    const len = this.credentials.password.length.toString(16).toUpperCase()
    await this._send(`SKSETPWD ${len} ${this.credentials.password}`)
    await this._send(`SKSETRBID ${this.credentials.id}`)
  }

  /**
   * ARIB STD-T108 の送信総和時間 (1 時間あたり 360 秒) を自分で見張る。
   *
   * SFD は無線送信の積算時間 [ミリ秒]。読むだけなら電波を使わない。
   * 超えると EVENT 32 が出て、それ以後の送信はアダプタが取り消す。
   * 粘るなら、その手前で自分から休むほうが早く復帰できる。
   */
  async _guardTxBudget() {
    if (!this.options.txBudgetGuard) return
    let used = null
    try {
      // SFD を持たない古いファームもある。失敗に数えると、直近のエラーが接続の不調と関係のない文に置き換わる
      const r = await this._send('SKSREG SFD', { ok: true }, { timeout: this.options.commandTimeout, tries: 1, optional: true })
      used = parseInt(r.register, 16)
    } catch (err) {
      if (err && err.aborted) throw err
      return // 読めなくても粘りを止める理由にはしない
    }
    if (!Number.isFinite(used)) return
    this.state.txBudgetMs = used
    if (used < this.options.txBudgetGuardMs) return
    this._log(
      'warn',
      `無線の送信積算時間が ${Math.round(used / 1000)} 秒です` +
        '（ARIB STD-T108 の上限は 1 時間あたり 360 秒）。' +
        `EVENT 32 で全部止まる前に ${Math.round(this.options.txBudgetPauseMs / 60000)} 分休みます`
    )
    const gen = this._generation
    await this._sleep(this.options.txBudgetPauseMs, '送信時間に余裕ができるまでの待ち')
    // 待っている間に再接続・停止・ポート切断があったら、呼び出し元の手順を続けない。
    this._assertAlive()
    if (this._generation !== gen) throw new Aborted('再接続の指示')
  }

  /** PANA 再認証 (ラダー段 0)。 */
  async _rejoin() {
    this._setPhase('rejoining')
    await this._send('SKREJOIN', { events: [0x25], failEvents: [0x24] }, { timeout: this.options.joinTimeout, tries: 1 })
    await this._afterJoin()
  }

  /**
   * PANA 認証が通ったあとの疎通確認。
   *
   * EVENT 25 が返っても、メーター側では接続が完了していないことがある
   * (マニュアル 3.4)。さらに、PANA や下位層は応答するのに ECHONET Lite だけ
   * 返さなくなるメーターもある (マニュアル 10.5.2)。
   * そこで Get を 1 発撃ち、応答が返って初めて「接続済み」とする。
   */
  async _afterJoin() {
    this.state.counters.joins++
    this.state.pollMisses = 0
    this._log('good', 'メーターとの認証が完了しました')

    this._setPhase('verifying')
    await this._request([0x80], 'verify')
    // 疎通が確かめられてから数え直す。SKJOIN が通っただけで数え直すと、ECHONET だけ返らない状態で
    // 粘りを使い切った回数が 1 より上に行かず、SKRESET に永久に届かない
    this.state.join.windows = 0

    // 接続時の取得（下の _collectOnce）が済むまで立てておく印（済んだら解ける Promise）。
    // フローの入力の預かり（lib/runtime/pending.js）は、これが解けてから流す。
    // 先に流すと、預かった積算（E0・E3）が係数・単位より先に走り、未換算のまま出力 1 に出る
    let onceDone = null
    this._collectingOnce = new Promise((r) => {
      onceDone = r
    })
    try {
      this.state.connected = true
      this.state.connectHint = null
      this.state.ladder = 0
      // 定期に取る値が 1 つも無い台は、値を待っても来ないので接続で数え直す
      if (!this._hasPeriodicEpcs()) this.state.consecutiveFailures = 0
      if (this.state.valueWaitSince === null) this.state.valueWaitSince = Date.now()
      this._setPhase('connected', '接続を確認しました')
      this._log('good', 'メーターとの通信を確かめました')
      this.emit('connected', this.snapshot())

      // 接続直後に「変わらないもの」を取る。
      //
      // 積算電力量を kWh に直すには係数(0xD3)と単位(0xE1)が要る。
      // ついでに Get プロパティマップ(0x9F)も取っておくと、
      // このメーターが何を持っているかが分かり、以後むだ撃ちしなくて済む。
      await this._collectOnce()
    } finally {
      this._collectingOnce = null
      onceDone()
    }
    this._schedulePoll(0)
    this._scheduleTier('slow')
    this._scheduleTier('halfHour')
  }

  /**
   * つながりが切れたことにする（接続が切れる所は全部ここを通す）。
   * つながったまま主な値が止まっていた台（最後の主な値が「値が古い」の線より前）は、その時刻を猶予の起点に残す。
   * 残さないと、次につながったときに猶予が付き直り、止まっていた瞬時電力が「計測中」に戻って合計に入る
   */
  _markDown() {
    const s = this.state
    if (s.connected && s.valueWaitSince === null && s.lastValueAt !== null) {
      const sec = Number(this.options.pollIntervalSec) > 0 ? Number(this.options.pollIntervalSec) : 30
      if (Date.now() - s.lastValueAt > (sec * 3 + 30) * 1000) s.valueWaitSince = s.lastValueAt
    }
    s.connected = false
  }

  /** 定期に取る値が 1 つでも設定されているか。 */
  _hasPeriodicEpcs() {
    const o = this.options
    return o.pollEpcs.length > 0 || (!!o.collectAll && (o.slowEpcs.length > 0 || o.halfHourEpcs.length > 0))
  }

  /**
   * 定期の取得で値が 1 件以上届いたときの記録。
   *
   * 「生きている」(待っていた応答が来た。pollMisses) と「値が来た」は分ける。
   * 接続の確認 (0x80) と全部断られた Get_SNA は生きているだけで、値は来ていない。同じに扱うと、値が 1 件も取れないのに
   * 計測中のままで、値が古いとも出ない。連続失敗もここで戻す。接続が通っただけで戻すと、値が取れないまま
   * 繋ぎ直す回が 0 に戻り続けて alert が鳴らない
   */
  _noteValueArrived(purpose, values) {
    if (!this._isMainValue(purpose, values || [])) return
    this.state.lastValueAt = Date.now()
    this.state.valueWaitSince = null
    if (this.state.connected) this.state.consecutiveFailures = 0
  }

  /**
   * 届いた値が「主な値」か。値の古さ (lastValueAt)・画面の猶予の起点 (valueWaitSince)・連続失敗の 0 戻し・
   * 出力 2 の recovered は、どれもこの 1 つの基準で決める。
   * 主な値は、瞬時電力 (0xE7) を取得間隔で取っていれば瞬時電力、取っていなければ取得間隔で取る値のどれか、
   * 取得間隔の値が無ければ定期の取得 (5 分・30 分) の値。
   * 5 分ごとの積算や瞬時電流だけ届いて瞬時電力が来ない台を「値が来ている」と見ると、古い瞬時電力が
   * 計測中のまま全台の合計に入り、alert も recovered も瞬時電力と関係なく動く
   */
  _isMainValue(purpose, values) {
    if (!PERIODIC_PURPOSES.has(purpose)) return false
    const eps = this.options.pollEpcs
    if (!eps.length) return values.length > 0
    if (purpose !== 'poll') return false
    const main = eps.indexOf(0xe7) >= 0 ? [0xe7] : eps
    return values.some((v) => v && main.indexOf(v.epc) >= 0)
  }

  /** 接続時に 1 回だけ取るもの。1 通に載る数ずつ分けて投げる。 */
  async _collectOnce() {
    const want = this.options.collectAll
      ? this.options.onceEpcs
      : [0xd3, 0xe1, 0xd7].filter(() => this.state.calibration.coefficient === null || this.state.calibration.unitFactor === null)
    const list = this._pollable(want)
    if (!list.length) return

    for (const batch of chunk(list, this.options.maxEpcsPerRequest)) {
      try {
        await this._request(batch, 'once')
      } catch (err) {
        if (err && err.aborted) throw err
        // ここで失敗しても運転は続ける。係数が無ければ積算は未換算で出す。
        this._log('warn', `接続時の取得に失敗しました（${batch.map(hexEpc).join(', ')}）: ${err.message}`)
      }
    }
    const c = this.state.calibration
    if (c.coefficient === null || c.unitFactor === null) {
      this._log('warn', '係数・単位を取得できませんでした。積算電力量は未換算のまま出します')
    }
  }

  /**
   * このメーターに要求してよい EPC だけに絞る。
   *
   * Get プロパティマップ (0x9F) を取れていれば、それに載っていないものは
   * 送らない。載っていないものを聞くと Get_SNA が返るだけで、
   * 電波の時間をむだにする。
   */
  _pollable(epcs, opts) {
    const useMap = !(opts && opts.map === false)
    const supported = this.state.supportedEpcs
    const held = new Set(this._heldEpcs())
    return epcs.filter((e) => {
      if (held.has(e)) return false
      if (useMap && supported && supported.length && supported.indexOf(e) < 0) return false
      return true
    })
  }

  /** いま Get_SNA のために要求を控えている EPC (数値)。期限が過ぎたものは含めない。 */
  _heldEpcs(now) {
    const t = now || Date.now()
    const out = []
    for (const [k, h] of Object.entries(this.state.snaHold)) {
      if (h && h.until > t) out.push(parseInt(k.replace(/^0x/i, ''), 16))
    }
    return out.sort((a, b) => a - b)
  }

  /**
   * Get_SNA で拒否された EPC を、しばらく控える。
   *
   * 永久には外さない。拒否が続くたびに控える時間を倍にし、上限で頭打ちにする。
   * Get プロパティマップ (0x9F) に載っているものは一時的な拒否とみなし、上限を短くする。
   */
  _noteDenied(epc) {
    const key = hexEpc(epc)
    const now = Date.now()
    const prev = this.state.snaHold[key]
    const wasHeld = !!(prev && prev.until > now)
    if (wasHeld) {
      // 控えている最中に聞いて拒否された (定期取得の全部を控えていて、
      // 生存確認のために設定どおりに聞いたとき)。回数は増やさない。
      // 増やすと、倍増が時間ではなく聞いた回数で進み、30 秒ごとの取得なら
      // 数分で上限まで伸びる。
      prev.at = now
      return
    }
    const count = (prev ? prev.count : 0) + 1
    const listed = this.state.supportedEpcs.length > 0 && this.state.supportedEpcs.indexOf(epc) >= 0
    const capSec = listed ? this.options.snaHoldMaxSupportedSec : this.options.snaHoldMaxSec
    const sec = Math.min(capSec, this.options.snaHoldSec * Math.pow(2, Math.min(count - 1, 20)))
    this.state.snaHold[key] = { count, until: now + sec * 1000, at: now }
    const span = sec < 60 ? `${sec} 秒` : sec < 3600 ? `${Math.round(sec / 60)} 分` : `${Math.round(sec / 360) / 10} 時間`
    this._log(
      this._noticeLevel(),
      `メーターが ${key} を返しませんでした（${count} 回目）。${span}おいてから聞き直します` +
        (listed ? '（プロパティマップには載っているので、一時的なものとみなします）' : '')
    )
  }

  /** 値が取れた EPC は、控えるのをやめる。 */
  _noteGranted(epc) {
    const key = hexEpc(epc)
    const prev = this.state.snaHold[key]
    if (!prev) return
    delete this.state.snaHold[key]
    this._log('good', `${key} がまた取れるようになりました（拒否 ${prev.count} 回のあと）`)
  }

  /** メーターごとに学んだことを捨てる。別のメーターに繋ぎ直すときに呼ぶ。 */
  _forgetMeter(why) {
    this.state.supportedEpcs = []
    this.state.snaHold = {}
    this.state.values = {}
    this.state.calibration = { coefficient: null, unitFactor: null, digits: null }
    this._tierLastAt = { slow: 0, halfHour: 0 }
    this._log('warn', `${why}。前のメーターの情報（プロパティマップ・係数・取れた値）を消しました`)
  }

  _scheduleTier(tier) {
    this._stopTier(tier)
    if (!this._running || !this.isConnected || !this.options.collectAll) return
    const sec = tier === 'slow' ? this.options.slowIntervalSec : this.options.halfHourIntervalSec
    const minMs = this.options.minTierIntervalSec * 1000
    const intervalMs = Math.max(this.options.minTierIntervalSec, sec) * 1000
    // 前回からの経過を引き継ぐ。再接続のたびに満期から数え直すと、
    // 再接続が周期より短い間隔で続いたときに、その階層が一度も動かない。
    // 期限を過ぎていれば下限 (既定 30 秒) で取りに行く。初めての接続は満期で。
    // 初めて張るときは、その時刻から周期を数え始める。0 のままにすると、
    // 最初の 1 回が済むまでは再接続のたびに満期から数え直してしまう。
    if (!this._tierLastAt[tier]) this._tierLastAt[tier] = Date.now()
    const last = this._tierLastAt[tier]
    const wait = Math.max(minMs, last + intervalMs - Date.now())
    this._tierTimers[tier] = setTimeout(() => this._pollTier(tier), wait)
  }

  _stopTier(tier) {
    if (this._tierTimers[tier]) {
      clearTimeout(this._tierTimers[tier])
      this._tierTimers[tier] = null
    }
  }

  async _pollTier(tier) {
    if (!this._running || !this.isConnected) return
    if (this.state.radioBlocked) return this._scheduleTier(tier)
    let want = tier === 'slow' ? this.options.slowEpcs : this.options.halfHourEpcs
    // 係数・単位が取れていなければ、5 分の階層で取り直す。
    // 接続時の 1 回を取りこぼすと、次の再接続まで積算が未換算 (null) のままになる。
    const c = this.state.calibration
    if (tier === 'slow' && (c.coefficient === null || c.unitFactor === null)) {
      want = [0xd3, 0xe1, 0xd7].concat(want.filter((e) => e !== 0xd3 && e !== 0xe1 && e !== 0xd7))
    }
    const list = this._pollable(want)
    for (const batch of chunk(list, this.options.maxEpcsPerRequest)) {
      try {
        await this._request(batch, tier)
      } catch (err) {
        // 再接続などで畳まれた。周期の記録は進めない (繋がり直したらすぐ取りに行く)。
        if (err && err.aborted) return
        this._log('warn', `${tier} の取得に失敗しました（${batch.map(hexEpc).join(', ')}）: ${err.message}`)
      }
    }
    this._tierLastAt[tier] = Date.now()
    this._scheduleTier(tier)
  }

  // =========================================================================
  //  ECHONET Lite
  // =========================================================================

  /**
   * Get 要求を送り、応答を待つ。
   * @returns {Promise<{values, tid, esv}>}
   */
  /**
   * ECHONET の要求を 1 件ずつに直列化する。
   *
   * モジュールは SKSENDTO の応答 (OK + EVENT 21) を待ってから次を出す必要があり、
   * 応答の突き合わせも TID 1 本ぶんしか持てない。
   * そこで「前の要求が終わってから次を送る」を待ち行列で保証する。
   *
   * 重なったら弾く実装にすると、接続直後の係数取得と重なっただけで
   * 利用者の get() が失敗する。待たせるほうが自然。
   */
  async _request(epcs, purpose) {
    if (this._requestDepth >= this.options.maxQueuedRequests) {
      // queueFull: メーターの不調ではなく、こちらの要求が多すぎただけ (周期の取得はこれを取りこぼしに数えない)
      throw new CommandError('ECHONET 要求が滞留しています。間隔を空けてください', { code: 'BUSY', queueFull: true, purpose })
    }
    this._requestDepth++
    const gen = this._generation
    const previous = this._requestChain
    let release
    this._requestChain = new Promise((r) => {
      release = r
    })
    let guard = null
    try {
      // 前の要求が宙に浮いたままだと、ここで永久に待つことになる。
      // 待ちにも上限を設けて、詰まっていることが分かるようにする。
      // 前の要求は送信リトライ (マニュアル 3.9) を使い切るまで終わらない。
      // 1 回ぶんで見切ると、再送の途中で後続が「詰まっている」と誤報する。
      const worst = this.options.bulkySendTimeout * Math.max(1, this.options.sendMaxTries) + 20000
      await Promise.race([
        previous,
        new Promise((_, rej) => {
          guard = setTimeout(() => rej(new CommandError('前の要求が終わらないため取りやめました', { code: 'BUSY' })), worst)
        }),
      ])
      // 勝負がついたら見切りのタイマーは要らない。消さないと 1 要求ごとに
      // 230 秒のタイマーが残り、テストのプロセスが終われず、畳んだ後も参照が残る。
      clearTimeout(guard)
      this._assertAlive()
      // 待っている間に再接続などで世代が変わったら、古いセッションへは送らない。
      // _assertAlive は _closed と _running しか見ないので、ここで見る。
      if (this._generation !== gen) throw new Aborted('再接続の指示')
      return await this._performRequest(epcs, purpose)
    } finally {
      clearTimeout(guard)
      this._requestDepth--
      release()
    }
  }

  async _performRequest(epcs, purpose) {
    if (!this.state.meter.ipv6) throw new CommandError('接続先アドレスが未確定です', { code: 'NOT_CONNECTED' })
    if (this.state.radioBlocked) throw new CommandError('ARIB 送信総和時間の制限中（EVENT 32）です', { code: 'RADIO_BLOCKED', blockedBy: 'radio' })
    if (this._pending) throw new CommandError('前の要求の応答待ちです', { code: 'BUSY' })

    let list = epcs.slice()
    const bulky = list.some((e) => BULKY_EPCS.has(e))
    if (bulky && list.length > 1) {
      // 履歴系は 1 件で 200 バイトを超え、無線区間で分割される。
      // 他の EPC を足すとフラグメントが増えて待ち時間が跳ね上がる。
      list = list.filter((e) => BULKY_EPCS.has(e)).slice(0, 1)
      this._log('warn', '履歴は単独でしか取得できません。ほかの EPC を外しました')
    }

    const tid = this._nextTid()
    this._rememberPurpose(tid, purpose || 'poll')
    const o = this.options
    const timeout = bulky ? o.bulkySendTimeout : o.sendTimeout
    const tries = Math.max(1, o.sendMaxTries)
    const addr = this.state.meter.ipv6
    const sendFrame = async (t) => {
      const frame = EL.buildGet(list, t)
      // DATALEN は必ず組み立てたフレームの長さから作る。
      // 決め打ちすると、実データと食い違ったときに
      // 「バイト数が揃うまでコマンド受付状態から抜けない」= 無応答で固着する。
      const cmd = `SKSENDTO ${o.udpHandle} ${addr} ${o.echonetPort} ${o.secure} ${o.side} ${hex4(frame.length)}`
      // マニュアル 3.9: OK と EVENT 21 の両方が返るまで次のコマンドを出さない
      await this._send(cmd, { ok: true, events: [0x21] }, { binary: frame, timeout, tries, label: 'SKSENDTO' })
      // 1 回でも通れば、連続失敗の数え直し
      this.state.sendFails = { busy: 0, noNa: 0, mute: 0, fail: 0 }
    }

    const answer = new Promise((resolve, reject) => {
      this._pending = {
        tid,
        tids: [tid], // 送り直したら増える。どれの応答でも受け取る
        epcs: list,
        purpose: purpose || 'poll',
        resolve,
        reject,
        resent: false,
        // 見張りの目安。応答の待ち時間は送信が通ってから数える (_armResponse)
        deadline: Date.now() + timeout * tries + 10000,
        timer: null,
      }
    })
    // 応答待ちの reject を誰も拾わないケースに備える (ポーリング経路は catch する)
    answer.catch(() => {})
    const pending = this._pending

    try {
      await sendFrame(tid)
    } catch (err) {
      this._clearPending('送信失敗')
      this._afterSendFailure(err)
      throw err
    }
    // 履歴は分割されて時間がかかるので長く待ち、送り直さない
    const responseMs = bulky ? o.bulkySendTimeout : Math.min(o.responseTimeoutMs, o.sendTimeout)
    this._armResponse(pending, responseMs, bulky ? 0 : Math.max(0, o.responseResends), sendFrame)
    return answer
  }

  /**
   * 送信が通ってから応答を待つ。待つ長さは送信の再試行を含まない。
   * 応答が無ければ resends 回まで送り直し、それでも無ければ取りこぼしに数える。
   */
  _armResponse(pending, ms, resends, sendFrame) {
    if (this._pending !== pending) return // もう答えが来た・取り消された
    pending.deadline = Date.now() + ms
    pending.timer = setTimeout(() => {
      if (this._pending !== pending) return
      pending.timer = null
      // 止めたあとに電波を出さない
      if (!this._running) {
        this._clearPending('停止')
        return
      }
      if (resends > 0) {
        this._resendRequest(pending, ms, resends - 1, sendFrame)
        return
      }
      this._pending = null
      this.state.pollMisses++
      this._log('warn', `メーターからの応答がありません（連続 ${this.state.pollMisses} 回）`)
      pending.reject(new CommandError('ECHONET 応答のタイムアウト', { code: 'TIMEOUT', timeout: true, tid: pending.tid, purpose: pending.purpose, counted: true }))
    }, ms)
  }

  /** 同じ EPC を新しい TID で送り直す。前の TID の応答が遅れて届いても受け取る (先に来た方を使う)。 */
  async _resendRequest(pending, ms, resends, sendFrame) {
    const o = this.options
    const tid = this._nextTid()
    this._rememberPurpose(tid, pending.purpose)
    pending.tids.push(tid)
    pending.resent = true
    pending.deadline = Date.now() + o.sendTimeout * Math.max(1, o.sendMaxTries) + 10000
    this.state.counters.resends++
    this._log('info', '応答が無いので 1 回送り直します')
    try {
      await sendFrame(tid)
    } catch (err) {
      if (this._pending !== pending) return // 前の応答が届いた・取り消された
      this._pending = null
      this._afterSendFailure(err)
      pending.reject(err)
      return
    }
    this._armResponse(pending, ms, resends, sendFrame)
  }

  /**
   * SKSENDTO が 3 回のリトライでも通らなかったときの後始末。
   *
   * マニュアル 3.9 のエラー時の処理の欄に沿っている (PARAM=01 だけは下の理由で変えている)。
   * 3 回のリトライは _send の tries が行うので、ここへ来た時点で
   * 「3 回連続で失敗した」= 仕様上エラーとみなす条件を満たしている。
   *
   *   PARAM=01 送信失敗       → 取りこぼし 1 回に数える。続けば pollMissLimit で段階 1 (マニュアルの勧めはスキャンから)
   *   PARAM=02 EVENT 02 無し  → 宛先アドレスが誤っている可能性。アドレスを取り直す
   *   応答なし                → コマンドが受け付けられていない。SKRESET からやり直す
   */
  _afterSendFailure(err) {
    if (!err || err.aborted) return
    // 禁止期間で出せなかっただけ。セッションの失敗ではないので段階を上げない。
    // 制限が解ければ次のポーリングでそのまま通る。
    if (err.blocked) return
    // sendFail でも timeout でもない = FAIL ERxx で終わったということ。
    //
    // ここを「該当なし」で素通りさせていたため、PANA セッションだけ黙って
    // 失われて SKSENDTO が FAIL ER10 を返し続ける状態で、段階上げも再接続も
    // 走らなかった。応答待ちのタイマーは _clearPending が先に潰すので
    // pollMisses も増えず、phase='connected' のまま無進捗のポーリングが続く。
    // 「緑のまま静かに止まる」= 無人運転で一番困る状態だった。
    const kind = err.sendFail || (err.timeout ? 'mute' : 'fail')

    const f = this.state.sendFails
    f[kind] = (f[kind] || 0) + 1
    const tries = Math.max(1, this.options.sendMaxTries)

    if (kind === 'fail') {
      // マニュアル 3.9: 使っていないハンドルを指定すると FAIL ER10 になる。
      // ER09 (UART 入力エラー) や ER06 でもここへ来る。いずれにせよ
      // 「送れていない」ので、放っておくと値が取れないまま静かに続く。
      this._log(
        'error',
        `SKSENDTO が ${failCodeOf(err)} で終わりました。${err.advice || ''} ` +
          'セッションが失われている可能性が高いため、メーターとの認証からやり直します'
      )
      this._markDown()
      this._bumpLadder(1)
      this._handled(err, `SKSENDTO が ${failCodeOf(err)} で終了`)
      return
    }

    if (kind === 'busy') {
      // マニュアル 3.9 は通信が切れたとみてスキャンからやり直すよう勧めるが、これは電波の混雑でふつうに起き、
      // メーターのチャネルと PAN は変わっていない。数秒の混雑ですぐ全チャネルを探すと、計測が 10 分以上止まる。
      // 取りこぼし 1 回に数えて、続けば pollMissLimit で段階 1 (同じメーターへ SKJOIN) に任せる
      this.state.pollMisses++
      err.counted = true
      this._log(
        'warn',
        `UDP 送信失敗（EVENT 21 <PARAM>=01）が ${tries} 回続きました。電波の混雑のことが多いので、取りこぼしに数えて続けます` +
          `（連続 ${this.state.pollMisses} 回）`
      )
      return
    }

    if (kind === 'noNa') {
      this._log(
        'error',
        `アドレス解決（EVENT 02）が ${tries} 回続けて返りませんでした。` +
          '宛先アドレスが誤っている可能性が高いため、メーターを探すところからやり直します'
      )
      this._markDown()
      this._bumpLadder(2)
      this._handled(err, '宛先アドレスが解決しない')
      return
    }

    this._log(
      'error',
      `SKSENDTO への応答が ${tries} 回続けてありませんでした。` +
        'アダプタの初期化からやり直します'
    )
    this._markDown()
    this._bumpLadder(3)
    this._handled(err, 'SKSENDTO が無応答')
  }

  /**
   * 「この失敗はここで手当てしたので、上の階層は再試行しないでほしい」。
   *
   * 段階を決めて reconnect した直後に、呼び出し元 (_joinKnownMeter の
   * SKJOIN リトライなど) がローカルに再試行すると、せっかく上げた段階が
   * 使われないまま同じ失敗を繰り返す。aborted の印を付けて、
   * 「自分で畳んだ」経路と同じ扱いにする。
   * handled の印は、再接続の指示で畳んだのと区別するため。_runLoop はこの失敗を連続失敗に数えて待つ。
   */
  _handled(err, reason) {
    if (err) {
      err.aborted = true
      err.handled = true
    }
    if (this._running) this.reconnect(reason)
  }

  _nextTid() {
    this._tid = ((this._tid || 0) + 1) & 0xffff
    if (this._tid === 0) this._tid = 1
    // 周回して同じ番号を使うなら、前の遅れた応答を待つ印は要らない。残すと新しい応答を捨てる
    if (this._lateTids) this._lateTids.delete(this._tid)
    return this._tid
  }

  /**
   * 送った要求の TID と目的 (purpose) を、直近のぶんだけ覚えておく。
   * 応答待ちを畳んだあとで届いた応答 (遅れた Get_Res) にも、送ったときの目的を付けるため。
   * measurement の purpose で、診断 (diag) の値を出力 1 と推移に流さないようにしている。
   */
  _rememberPurpose(tid, purpose) {
    if (!this._tidPurposes) this._tidPurposes = new Map()
    this._tidPurposes.delete(tid)
    this._tidPurposes.set(tid, purpose)
    if (this._tidPurposes.size > 32) this._tidPurposes.delete(this._tidPurposes.keys().next().value)
  }

  /**
   * 応答待ちを畳む。
   *
   * 呼ばれるのは「自分で畳むと決めたとき」だけ (停止・再接続・ポート切断・
   * 送信失敗)。Aborted で投げないと、下流の `err.aborted` 判定をすり抜けて
   * 「メーターが応答しない」と同じ扱いになり、意図的な停止が失敗として
   * 数えられて段階を上げてしまう。
   */
  _clearPending(reason) {
    if (!this._pending) return
    clearTimeout(this._pending.timer)
    const p = this._pending
    this._pending = null
    p.reject(new Aborted(reason || '要求を取り消しました'))
  }

  // =========================================================================
  //  ポーリング
  // =========================================================================

  _schedulePoll(delayMs) {
    this._stopPolling()
    if (!this._running || !this.isConnected) return
    const ms = delayMs === undefined ? this.options.pollIntervalSec * 1000 : delayMs
    this._pollTimer = setTimeout(() => this._poll(), ms)
  }

  /**
   * 速い周期 (瞬時値) のタイマーだけ止める。
   *
   * ここで階層タイマーまで止めてはいけない。_schedulePoll が毎回
   * これを呼ぶので、30 秒ごとのポーリングのたびに 5 分・30 分階層の
   * タイマーが消え、接続直後の 1 回しか動かなくなる。
   */
  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  }

  /** 取得をすべて止める。運転を止めるときだけ使う。 */
  _stopCollecting() {
    this._stopPolling()
    this._stopTier('slow')
    this._stopTier('halfHour')
  }

  async _poll() {
    if (!this._running || !this.isConnected) return
    if (this.state.radioBlocked) {
      this._schedulePoll()
      return
    }
    try {
      // Get_SNA で控えている EPC は外して聞く。全部控えているときは、
      // 生存確認を兼ねているので設定どおりに聞く (Get_SNA も応答なので生きていると分かる)。
      // プロパティマップ (0x9F) では絞らない。設定した EPC を黙って聞かなくなると、
      // 理由がどこにも出ないまま取れない (マップに無ければ Get_SNA が返り、控えに回る)。
      const list = this._pollable(this.options.pollEpcs, { map: false })
      await this._request(list.length ? list : this.options.pollEpcs, 'poll')
    } catch (err) {
      if (err && err.aborted) {
        // 定期の取得が送れず、手当てして繋ぎ直す回。接続の確認は通るので、ここで数えないと増えない
        if (err.handled) this.state.consecutiveFailures++
        return
      }
      // 待ち行列が埋まっていて断られただけ (フローの入力の get / poll を続けて流したなど)。
      // メーターは元気なので取りこぼしには数えない。数えると、要求の多さだけで 3 回で
      // PANA の初回認証からやり直し、計測が数十秒止まる。次の周期でまた取りに行く
      if (err && err.queueFull) {
        this._log('warn', '定期的な取得を見送りました（ECHONET 要求が滞留しています。取りこぼしには数えません）')
        this._schedulePoll()
        return
      }
      // 応答待ちのタイムアウトだけでなく、送信そのものの失敗も
      // 「値が取れなかった」として数える。数えないと、SKSENDTO が毎回
      // 失敗する状態で pollMissLimit に永久に到達しない。
      if (!err.counted) this.state.pollMisses++
      if (this.state.pollMisses >= this.options.pollMissLimit) {
        this.state.pollMisses = 0
        this._markDown()
        // 下位層は生きているのに ECHONET だけ返らない状態 (マニュアル 10.5.2)。
        // 再認証しても直らないことが多いので、初回認証からやり直す。
        this._bumpLadder(1)
        // 値が取れないまま繋ぎ直す回も連続失敗に数え、理由を残す。接続の確認は通るので、接続の道では増えない。
        // 応答待ちの失敗は _fail を通らないので、残さないと alert と画面に理由が出ない
        this.state.consecutiveFailures++
        this._recordError({
          message: `定期的に取りに行く値が ${this.options.pollMissLimit} 回続けて届きません（${err.message}）。メーターとの認証からやり直します`,
          code: err.code,
        })
        // 止められている最中に遅れて届いた失敗で運転を復活させない。
        // reconnect() は止まっていると自動運転を入れ直すので、
        // ここのガードが無いと外部からの stop が勝手に解除される。
        if (this._running) this.reconnect(`応答が ${this.options.pollMissLimit} 回連続でありません`)
        return
      }
    }
    this._schedulePoll()
  }

  // =========================================================================
  //  コマンドキュー
  // =========================================================================

  /**
   * コマンドを 1 つ送り、期待する応答を待つ。
   *
   * expect の形:
   *   { ok: true }              "OK" で完了 (値があれば .value に入る)
   *   { ipv6: true }            裸の IPv6 アドレス 1 行で完了 (SKLL64)
   *   { events: [0x25] }        このイベントで完了
   *   { failEvents: [0x24] }    このイベントで失敗
   *   { settle: 400 }           送るだけ。指定ミリ秒で完了 (応答を見ない)
   *
   * @returns {Promise<object>} 集めた応答
   */
  _send(command, expect, opts) {
    const o = opts || {}
    return new Promise((resolve, reject) => {
      this._queue.push({
        command: String(command),
        expect: expect || { ok: true },
        timeout: o.timeout || this.options.commandTimeout,
        maxTries: o.tries === undefined ? this.options.commandMaxTries : o.tries,
        tries: 0,
        crlf: o.crlf === true, // 既定は CR のみ (実機で確認済み)
        binary: o.binary || null,
        // Web UI の診断の読み出し (diagRead)。失敗のログと数え方だけが違う (_fail)
        diag: !!o.diag,
        // 通らなくても接続の不調ではないコマンド (SKSREG SA2・セッションが無いときの SKTERM)。呼んだ側が結果を判断する (_fail)
        optional: !!o.optional,
        // 失敗を数えるが、失敗の行は呼んだ側が 1 行にまとめて出す (SKJOIN。_fail・_onSkEvent)
        quiet: !!o.quiet,
        // 閉じる前の SKTERM (destroy)。reconnect・stop の _abortQueue で取り消さない
        keepOnAbort: !!o.keepOnAbort,
        // このコマンドが実行中の間に受け取った行を渡す先 (フローの入力 command の結果の lines。outputs.runCommand)
        onLine: typeof o.onLine === 'function' ? o.onLine : null,
        label: o.label || String(command).split(' ')[0] || 'cmd',
        generation: this._generation,
        result: {},
        seen: {},
        resolve,
        reject,
      })
      this._pump()
    })
  }

  _pump() {
    if (this._current || !this._queue.length) {
      // 保留していた相手が居なくなったら、待ちの記録も消す。
      // 残すと見張りが永久に何も見なくなる。
      if (!this._queue.length && this._waitingFor && !this._wake) this._waitingFor = null
      return
    }
    if (!this.state.portOpen) return

    const item = this._queue[0]

    // 1 回の書き込みで送るのは 1 つのコマンドだけ (raw() の検査を抜けたときのもう 1 段の守り)。
    // raw() を通らない道 (内部の _send) でも、改行・制御文字・ASCII 以外の文字を含むものは書かない
    // (空は、入力バッファを流す裸の <CR>。_fullSequence の flush)
    if (item.command !== '' && !COMMAND_TEXT.test(item.command)) {
      this._queue.shift()
      this._log('error', '改行・制御文字・ASCII 以外の文字を含むコマンドは送りません: ' + item.label)
      item.reject(new CommandError(commandTextProblem(item.command) || 'コマンドを送れません', { code: 'VALIDATION', command: item.label }))
      setTimeout(() => this._pump(), 0)
      return
    }

    // 無線送信コマンドを出してはいけない期間 (マニュアル 8 章):
    //   ・送信総和時間の制限中   EVENT 32 〜 EVENT 33
    //   ・PANA 接続/認証中       EVENT 29 〜 EVENT 24/25
    //   ・自動鍵配信中           EVENT 54 〜 EVENT 55
    // SKJOIN/SKREJOIN 中はキューが埋まっているので自然に止まる。
    if (RADIO_COMMAND.test(item.command)) {
      // SKJOIN を出してから EVENT 24/25 が返るまでも禁止期間 (マニュアル 8 章)。
      // SKJOIN が joinTimeout で終わった場合、イベントはまだ来ていないので
      // ここで止めないと禁止期間のまっただ中に次を撃つことになる。
      const pana =
        this.state.panaPending && Date.now() - this.state.panaPending.at < this.options.panaPendingMaxMs
      const why = this.state.radioBlocked
        ? '送信総和時間の制限中（EVENT 32）'
        : this.state.phase === 'reauth'
          ? 'メーターと再認証中（EVENT 29）'
          : pana
            ? 'メーターと認証中（EVENT 24/25 待ち）'
            : this.state.keyBlocked
              ? '自動鍵配信中（EVENT 54）'
              : null
      if (why) {
        if (item.blockedFor !== why) {
          item.blockedFor = why
          item.blockedSince = Date.now()
          this._log('info', why + 'のため ' + item.label + ' を保留します')
        }
        // 保留中のコマンドは期限を持たない (期限はキューから出したあとに張る)。
        // 送信総和時間の制限は最大 1 時間続くので、そのまま待たせると
        // 入力から投げた terminate や raw が何十分も返らず、
        // Node-RED 側の done() も呼ばれないままになる。
        // 自分の待ち時間ぶんだけ待って、駄目なら理由を付けて返す。
        const waited = Date.now() - item.blockedSince
        if (waited > item.timeout) {
          // _fail は「実行中の項目」しか扱えない (this._current との一致を見る)。
          // これはまだキューの中なので、自分で取り出して返す。
          this._queue.shift()
          this.state.counters.failures++
          this._log('warn', `${why}のため ${item.label} を実行できませんでした`)
          item.reject(
            new CommandError(`${why}のため実行できませんでした`, {
              code: 'RADIO_BLOCKED',
              command: SK.maskSecretCommand(item.command),
              blocked: true,
              blockedBy: this.state.radioBlocked ? 'radio' : this.state.keyBlocked && !pana && this.state.phase !== 'reauth' ? 'key' : 'pana',
            })
          )
          setTimeout(() => this._pump(), 0)
          return
        }
        this._waitingFor = why
        setTimeout(() => this._pump(), 1000)
        return
      }
      item.blockedFor = null
      this._waitingFor = null
    }

    this._queue.shift()
    item.tries++
    item.seen = {}
    item.result = {}
    // 前回の試行の判定結果を持ち越さない。
    // 消し忘れると、送り直して EVENT 21 <PARAM>=00 が返っても
    // 前回の「送信失敗」が残っていて失敗のままになる。
    item.failedUdp = null
    item.sendFail = null
    item.udpParam = null
    item.awaitingNa = false
    this._current = item

    // 見張り (_checkStall) が「まだ待っていい時間」を判断するための期限。
    // これを置き忘れると、時間のかかる SKSCAN を滞留と誤判定して叩き切る。
    if (item.expect.settle) {
      item.deadline = Date.now() + item.expect.settle
      item.timer = setTimeout(() => this._settle(item, item.result), item.expect.settle)
    } else {
      item.deadline = Date.now() + item.timeout
      item.timer = setTimeout(() => {
        this.state.counters.timeouts++
        this._fail(
          item,
          new CommandError(`タイムアウト（${Math.round(item.timeout / 1000)} 秒）`, { code: 'TIMEOUT', command: SK.maskSecretCommand(item.command), timeout: true })
        )
      }, item.timeout)
    }

    // 行末は CR で統一する。
    // マニュアルは SK=CRLF / プロダクト設定=CR と書き分けているが、
    // 実機は SK コマンドも CR 単独で正しく応答する。
    // 揃えれば分岐が消え、余った LF が次の行頭に付く経路も無くなる。
    const eol = item.crlf ? '\r\n' : '\r'
    const head = Buffer.from(item.command + (item.binary ? ' ' : eol), 'ascii')
    const payload = item.binary ? Buffer.concat([head, item.binary]) : head

    // PANA 接続コマンドを出した印。EVENT 24/25 で落とす (マニュアル 8 章)。
    if (PANA_COMMAND.test(item.command)) {
      this.state.panaPending = { at: Date.now(), command: item.label }
    }
    // SKRESET で内部の変数は全部初期値に戻る (マニュアル 3.26)。
    // PANA 待ちの印を消しておかないと、リセット後の SKSCAN が
    // 存在しない禁止期間で保留され続ける。
    if (/^SKRESET\b/.test(item.command)) {
      this.state.panaPending = null
      this._markDown()
      this._panaSession = false
    }

    this.state.counters.tx++
    this._log('tx', '→ ' + SK.maskSecretCommand(item.command) + (item.binary ? ` [${item.binary.length} バイト]` : ''))

    Promise.resolve(this.transport.write(payload)).catch((err) => {
      this._fail(item, new CommandError('送信できません: ' + err.message, { code: 'PORT_DOWN' }))
    })
  }

  /**
   * 進行中のコマンドの待ち時間を張り直す。
   * 「EVENT 21 は返ったが、続く EVENT 02 を待つ」のように、
   * 途中まで進んだものに別の期限を与えるために使う。
   */
  _rearm(item, ms, message, info) {
    if (this._current !== item) return
    clearTimeout(item.timer)
    item.deadline = Date.now() + ms
    item.timer = setTimeout(() => {
      this.state.counters.timeouts++
      this._fail(item, new CommandError(message, Object.assign({ code: 'TIMEOUT', command: SK.maskSecretCommand(item.command), timeout: true }, info)))
    }, ms)
  }

  _settle(item, result) {
    if (this._current !== item) return
    clearTimeout(item.timer)
    this._current = null
    item.resolve(result)
    this._pump()
  }

  _fail(item, err) {
    if (this._current !== item) return
    clearTimeout(item.timer)
    this._current = null
    // Web UI の診断の読み出し (diagRead) の失敗。接続や取得の不調ではない (古いファームが
    // SFD を知らない、など) ので、warn 1 行だけ残して返す。失敗の数・lastError・error のログ
    // (Node-RED のログの error と健康の判定) には混ぜない。再試行もしない (tries は 1)
    if (item.diag) {
      this._log('warn', `診断の読み出しに失敗しました: ${SK.maskSecretCommand(item.command)} — ${err.message}`)
      item.reject(err)
      this._pump()
      return
    }
    // 通らなくても困らないコマンド。失敗の数・lastError・error のログに混ぜず、再試行もしない。
    // 混ぜると、セッションの無い普通の起動や SA2 を持たないモジュールで、画面の直近のエラーが接続のたびに残る
    if (item.optional) {
      item.reject(err)
      this._pump()
      return
    }
    this.state.counters.failures++
    this.state.lastError = { command: SK.maskSecretCommand(item.command), label: item.label, message: err.message, code: err.code || null, at: Date.now() }

    // マニュアル 7 章。ER04 / ER05 / ER06 はコマンド名か引数そのものが誤っている。
    // 同じ文字列をもう一度送れば必ず同じ FAIL が返るので、再試行は時間の無駄。
    // 上の階層へ早く返したほうが、段階的な再接続に入るのも早い。
    if (err && err.retryable === false && err.code) {
      this._log('error', `${err.code} は再試行しても変わりません。${err.advice || 'コマンド名と引数を確かめてください'}`)
      item.tries = item.maxTries
    }

    if (item.tries < item.maxTries && !item.expect.settle) {
      // マニュアル 3.9 のタイムアウトの欄にある復旧手順。
      // SKSENDTO は「コマンド行 + DATALEN バイトのデータ」で 1 コマンドなので、
      // バイト数が食い違うとモジュールは受付状態のまま無言で固まる。
      // <CR> を 1 つ送ると FAIL を返して受付状態から抜ける。
      if (item.label === 'SKSENDTO' && err.timeout && !item.seen.ok) {
        this._log('warn', 'SKSENDTO に応答がありません。<CR> を送って受付状態を解きます')
        Promise.resolve(this.transport.write(Buffer.from('\r', 'ascii'))).catch(() => {})
      }
      this._log('warn', `再試行（${item.tries}/${item.maxTries}）: ${SK.maskSecretCommand(item.command)} — ${err.message}`)
      this._queue.unshift(item)
      setTimeout(() => this._pump(), err.sendFail === 'busy' ? this._sendRetryDelay(item.tries) : Math.min(8000, 500 * Math.pow(2, item.tries)))
      return
    }
    // 電波の混雑 (EVENT 21 <PARAM>=01) は想定内の失敗。数え方はそのままで、行は _afterSendFailure の warn の 1 行にまとめる
    if (!item.quiet && err.sendFail !== 'busy') this._log('error', `失敗: ${SK.maskSecretCommand(item.command)} — ${err.message}`)
    item.reject(err)
    this._pump()
  }

  /** EVENT 21 <PARAM>=01 の n 回目の再試行までの待ち [ms]。±sendRetryJitter ゆらす。 */
  _sendRetryDelay(n) {
    const list = this.options.sendRetryDelaysMs
    const base = list[Math.min(Math.max(0, n - 1), list.length - 1)]
    const j = this.options.sendRetryJitter || 0
    return Math.round(base * (1 - j + Math.random() * 2 * j))
  }

  /**
   * 進行中・待機中のコマンドをすべて畳む。
   * 閉じる前の SKTERM (keepOnAbort) だけは残す (閉じる途中の reconnect・stop で取り消させない)。
   */
  _abortQueue(reason) {
    const aborted = new Aborted(reason)
    if (this._current && !this._current.keepOnAbort) {
      clearTimeout(this._current.timer)
      this._current.reject(aborted)
      this._current = null
    }
    const keep = []
    while (this._queue.length) {
      const item = this._queue.shift()
      if (item.keepOnAbort) keep.push(item)
      else item.reject(aborted)
    }
    for (const item of keep) this._queue.push(item)
  }

  _bumpGeneration() {
    this._generation++
  }

  _assertAlive() {
    if (this._closed || !this._running) throw new Aborted('停止しました')
  }

  /**
   * 段階を明示的に戻す。
   *
   * _bumpLadder は「固定値を代入すると段を往復して 3 に到達しない」ため
   * 単調増加にしてあるが、SKJOIN だけが失敗している場合は
   * SKRESET まで上げても意味が無い。そこだけ戻せるようにする。
   */
  _resetLadder(to, why) {
    if (this.state.ladder === to) return
    this._log('info', `段を ${this.state.ladder} → ${to} にします: ${why}`)
    this.state.ladder = to
  }

  _bumpLadder(to) {
    // 再接続ラダー (マニュアル 10.5.2):
    //   0 PANA 再認証 / 1 PANA 初回認証 / 2 再スキャン / 3 SKRESET から全部
    // 必ず単調に進める。固定値を代入すると段を往復して 3 に到達しない。
    const next = typeof to === 'number' ? to : this.state.ladder + 1
    this.state.ladder = Math.max(this.state.ladder, Math.min(LADDER_MAX, next))
  }

  // =========================================================================
  //  受信
  // =========================================================================

  _onLine(buf) {
    // 応答は <CRLF>本文<CRLF> の形で返る。CR で区切っているので、
    // 各行の先頭に前の行の LF が残る。前後の改行をまとめて落とす。
    const received = (Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf))
      .replace(/^[\r\n]+/, '')
      .replace(/[\r\n]+$/, '')
    if (!received.trim()) return

    // エコーバックが有効な間は、送ったコマンドがそのまま返る。認証情報の値を受信の行として先へ渡さない
    const line = SK.maskSecretCommand(received)
    this.emit('raw', line)
    // 実行中のコマンドが行を集めている (フローの入力 command の lines)。受け手の失敗で受信を止めない
    if (this._current && this._current.onLine) {
      try {
        this._current.onLine(line)
      } catch (e) {
        /* 集める側の失敗は無視する */
      }
    }

    // 複数行イベントの終端が来ないまま止まった場合の保険。
    // pending が残ると、その間に届いた ERXUDP や EVENT が表の行として消える。
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => {
      const rest = SK.flush(this._acc).filter(Boolean)
      if (rest.length) {
        // スキャンの結果には終わりの印が無く、次の行が来るまで閉じられない。
        // 残りのチャネルを探す間に 2 秒空くのはふつうのことなので、異常として知らせない
        if (rest[0].kind !== 'epandesc') {
          this._log('warn', `アダプタの複数行の応答が途中で止まったので、届いたところまでで確定しました（${rest[0].name || rest[0].kind}）`)
        }
        rest.forEach((e) => this._dispatch(e))
      }
    }, 2000)

    for (const event of SK.feed(this._acc, line)) {
      if (event) this._dispatch(event)
    }
  }

  _dispatch(e) {
    this.state.counters.rx++
    this.emit('sk', e)

    switch (e.kind) {
      case 'event':
        this._onSkEvent(e)
        break
      case 'epandesc':
        // 割り込みの ERXUDP で途中まで確定した結果は使わない。Addr が無いまま進むと SKLL64 が ER06 で落ち、
        // 別のメーターと見なして、前のメーターで学んだことまで消す
        if (!e.addr || !e.panId) {
          this._log('warn', 'スキャンの結果が途中で切れていたので使いません。続けて探します')
          break
        }
        this._scanResults.push(e)
        this._log('info', `PAN を見つけました: ch${e.channel} PAN=${e.panId} LQI=${e.lqi} Addr=${e.addr}`)
        break
      case 'erxudp':
        this._onErxudp(e)
        break
      case 'einfo':
        this._log('info', `SKINFO: MAC=${e.mac} ch=${e.channel} PAN=${e.panid}`)
        break
      case 'table':
        this._log('info', `${e.name}: ${e.lines.length} 行`)
        this.emit('table', e)
        break
      case 'eedscan':
        this._log('info', `ED スキャン結果: ${e.channels.length} チャネル`)
        this.emit('edscan', e)
        break
      default:
        break
    }

    this._matchCurrent(e)
  }

  /** いま待っているコマンドの完了条件を満たしたか見る。 */
  _matchCurrent(e) {
    const item = this._current
    if (!item) {
      if (e.kind === 'fail') this._log('warn', `待っているコマンドが無いのに FAIL を受け取りました: ${e.code}`)
      return
    }
    // 応答を見ない種類 (裸の CR など) は、何が返っても無視する
    if (item.expect.settle) return

    if (e.kind === 'fail') {
      // FAIL は PANA 接続を始めていないので、EVENT 24/25 は来ない。印を残すと、次の無線コマンドが見切りの 60 秒まで待たされる
      if (PANA_COMMAND.test(item.command)) this.state.panaPending = null
      // ER09 は UART 入力エラー。マニュアル 7 章の推奨処理は <CR> を送ること。
      // LF を足すとモジュールが空行として扱い FAIL を 1 つ余分に返す。
      if (e.code === 'ER09') {
        Promise.resolve(this.transport.write(Buffer.from('\r', 'ascii'))).catch(() => {})
      }
      // 推奨処理 (sk-protocol の ERROR_CODES。マニュアル 7 章の要約) をメッセージに載せる。
      // 画面に出るのは失敗した 1 行なので、そこに次の一手が書いてあるのが親切。
      const advice = failAdvice(e.code, item.command) || e.advice || ''
      this._fail(
        item,
        new CommandError(`${e.code} ${e.message}${advice ? ' — ' + advice : ''}`, {
          code: e.code,
          advice,
          retryable: e.retryable,
        })
      )
      return
    }

    const ex = item.expect
    if (e.kind === 'ok' && ex.ok) {
      item.seen.ok = true
      item.result.value = e.value
    }
    if (e.kind === 'ipv6' && ex.ipv6) {
      item.seen.ipv6 = true
      item.result.address = e.address
    }
    if (e.kind === 'ever') item.result.version = e.version
    if (e.kind === 'einfo') Object.assign(item.result, { mac: e.mac, ipv6: e.ipv6, channel: e.channel, panid: e.panid })
    if (e.kind === 'esreg') item.result.register = e.value
    if (e.kind === 'table') item.result.table = e
    if (e.kind === 'epong') item.result.pong = e

    if (e.kind === 'event') {
      if (ex.failEvents && ex.failEvents.indexOf(e.num) >= 0) {
        this._fail(item, new CommandError(`EVENT ${e.numHex}（${e.name}）`, { event: e.num }))
        return
      }
      if (ex.events && ex.events.indexOf(e.num) >= 0) {
        // EVENT 21 <PARAM> の意味 (マニュアル 3.9 の実行結果の欄)
        //   00 送信成功                 → 完了
        //   01 送信失敗                 → 送信リトライ。3 回連続ならエラー
        //   02 アドレス要請 (NS) を実行 → EVENT 02 を待つ。来なければ送信リトライ
        if (e.num === 0x21 && e.udp) {
          if (e.udp.ok === false) {
            item.failedUdp = e.udp.text
            item.udpParam = e.param
            item.sendFail = 'busy'
          } else if (e.param === 2) {
            // ここで完了にすると、アドレスが解決していないのに
            // 「送れた」ことになり、応答が来ないまま待ち続ける。
            item.awaitingNa = true
            this._log('info', 'アドレス要請（NS）を実行しました。EVENT 02 を待ちます')
            this._rearm(item, this.options.naWaitMs, 'EVENT 02（アドレス解決）が返りません', { sendFail: 'noNa' })
            return
          }
        }
        item.seen.event = true
      }

      // NS のあとの EVENT 02 (NA 受信) で、送信は成立したとみなす。
      // マニュアル 3.9 の表では EVENT 02 に処理は要らないことになっているが、
      // これを待たずに次へ進むと宛先誤りを検出できない。
      if (e.num === 0x02 && item.awaitingNa) {
        item.awaitingNa = false
        item.seen.event = true
      }
    }

    let need = 0
    let got = 0
    if (ex.ok) { need++; if (item.seen.ok) got++ }
    if (ex.ipv6) { need++; if (item.seen.ipv6) got++ }
    if (ex.events && ex.events.length) { need++; if (item.seen.event) got++ }

    if (need > 0 && got === need) {
      if (item.failedUdp) {
        this._fail(item, new CommandError(item.failedUdp, { code: 'DEVICE_ERROR', sendFail: item.sendFail, udpParam: item.udpParam }))
      } else {
        this._settle(item, item.result)
      }
    }
  }

  /** 自発イベント。進行中のコマンドとは無関係に飛んでくる。 */
  _onSkEvent(e) {
    // PANA 接続の決着 (マニュアル 8 章の禁止期間の終わり)。
    // フェーズに関係なく必ず記録する。ここを phase で絞ると、
    // SKJOIN 中の EVENT 24 が「どこにも残らない」ことになる。
    if (e.num === 0x24 || e.num === 0x25) {
      const p = this.state.panaPending
      const ms = p ? Date.now() - p.at : null
      this.state.panaPending = null
      this.state.join.last = { num: e.num, sender: e.sender || null, elapsedMs: ms, at: Date.now() }
      if (e.num === 0x25) {
        this._panaSession = true
        this._credentialHinted = false
        this._clearConnectHint('credentials') // 認証は通った
      }
      // 止めている間の自動再認証の失敗。相が reauth ではないので下の case 0x24 を通らない。
      // セッションはもう無いので、次の開始は SKREJOIN (ER10 で空振りする) ではなく SKJOIN から
      if (e.num === 0x24 && p && p.command === 'EVENT 29') {
        this._panaSession = false
        this._bumpLadder(1)
      }
      // SKJOIN の失敗は _joinKnownMeter が 1 行にまとめる。ここへ残るのは、再認証の失敗と、呼び手のいない EVENT 24。
      //
      // level を warn にしているのは、info だと node.debug() に落ちて
      // Node-RED の既定ログレベルでは見えないため。
      if (e.num === 0x24 && !(this._current && this._current.quiet)) {
        this._log(
          'warn',
          `EVENT 24（メーターとの認証に失敗）相手=${e.sender || '不明'}` +
            (ms === null ? '' : ` / SKJOIN から ${(ms / 1000).toFixed(1)} 秒`) +
            '（仕様上の最大は約 38 秒で、内部で 7 回送り直します）'
        )
      }
      this._pump() // 禁止期間が明けた
    }

    switch (e.num) {
      case 0x26: // 相手からセッション終了要求
        this._log('warn', 'メーターからセッション終了の要求を受け取りました')
        this._markDown()
        this._bumpLadder(1) // 再認証ではなく初回認証から
        if (this._running) this.reconnect('EVENT 26 セッション終了要求')
        break

      case 0x27: // セッション終了成功
        this._markDown()
        this._panaSession = false
        this._log('info', 'メーターとのセッションを終了しました')
        break

      case 0x28: // 終了要求がタイムアウト (セッションは終了扱い)
        this._markDown()
        this._panaSession = false
        this._log('warn', 'セッション終了の要求に応答がありませんでした（セッションは終了したものとして扱います）')
        break

      case 0x29: // ライフタイム 80% 経過 → モジュールが自動で再認証する
        this._log('info', 'セッションの寿命が切れました。自動の再認証を待ちます')
        this._markDown()
        // 止めている間もモジュールは再認証を続ける。相は止めた理由のまま動かさず、無線の禁止期間の印だけ立てる
        if (!this._running) {
          this.state.panaPending = { at: Date.now(), command: 'EVENT 29' }
          break
        }
        this._setPhase('reauth')
        this._armReauthTimeout()
        break

      case 0x25: // 自動再認証が成功した
        this._clearReauthTimeout()
        if (this.state.phase === 'reauth') {
          this._log('good', '自動再認証が完了しました')
          this._afterJoin().catch((err) => {
            if (!err.aborted) this.reconnect('自動の再認証のあと、接続を確かめられませんでした: ' + err.message)
          })
        }
        break

      case 0x24: // 自動再認証が失敗した
        this._clearReauthTimeout()
        if (this.state.phase === 'reauth') {
          this._bumpLadder(1)
          if (this._running) this.reconnect('自動再認証に失敗（EVENT 24）')
        }
        break

      case 0x32: // ARIB108 送信総和時間の制限が発動
        this._setRadioBlocked(true)
        break

      case 0x33: // 制限解除
        this._setRadioBlocked(false)
        break

      // --- 以下は HAN (コーディネーター) 側の鍵管理イベント ---------------
      // B ルート (デバイス側) では本来出ない。出たということは
      // 相手や面の取り違えが起きているので、黙って捨てずに残す。
      case 0x45: // 別のキーインデックスの暗号文を受信した
        this._log('warn', 'EVENT 45: 使用中と異なる暗号鍵の通信を受信しました（B ルートでは通常発生しません）')
        break

      case 0x52: // 鍵配布に対する応答が無かった
        this._log('warn', 'EVENT 52: 鍵配布に応答がありません（B ルートでは通常発生しません）')
        break

      case 0x54: // 自動鍵配信を開始した → EVENT 55 までコマンド禁止
        this._setKeyBlocked(true)
        break

      case 0x55: // 自動鍵配信が終わった
        this._setKeyBlocked(false)
        break

      case 0xc0:
        this._log('info', 'スリープから復帰しました')
        break

      default:
        break
    }
  }

  /**
   * EVENT 29 のあと、EVENT 24/25 が返ってこない場合の見切り。
   *
   * マニュアル 8 章により、この間は無線送信コマンドを出せない。
   * つまり待ち続けると、ポーリングも再接続も一切動かないまま静かに止まる。
   * ファームウェア 1.5.2 rev15 では電源投入から約 49 日でこれが常態化する
   * (マニュアル 10.7)。時間を切って、自分から繋ぎ直す。
   */
  _armReauthTimeout() {
    this._clearReauthTimeout()
    this._reauthTimer = setTimeout(() => {
      this._reauthTimer = null
      if (this.state.phase !== 'reauth') return
      this._log(
        'error',
        `自動再認証（EVENT 29）から ${Math.round(this.options.reauthTimeoutMs / 1000)} 秒たっても ` +
          'EVENT 24/25 が返りません。メーターとの認証からやり直します'
      )
      this._bumpLadder(1)
      if (this._running) this.reconnect('自動再認証が返らない')
    }, this.options.reauthTimeoutMs)
  }

  _clearReauthTimeout() {
    if (this._reauthTimer) {
      clearTimeout(this._reauthTimer)
      this._reauthTimer = null
    }
  }

  /**
   * 自動再認証の途中で止めるときは、無線の禁止期間の印を残す。
   * 止めてもモジュールは再認証を続けるので、相が reauth から動くと禁止期間を守らなくなる。
   * 印は EVENT 24/25 で下り、返らなくても panaPendingMaxMs で切れる。
   */
  _markReauthBlock() {
    if (this.state.phase === 'reauth') this.state.panaPending = { at: Date.now(), command: 'EVENT 29' }
  }

  /** EVENT 54 〜 EVENT 55 の間は無線コマンドを出さない (マニュアル 8 章)。 */
  _setKeyBlocked(blocked) {
    if (this.state.keyBlocked === blocked) return
    this.state.keyBlocked = blocked
    if (this._keyTimer) {
      clearTimeout(this._keyTimer)
      this._keyTimer = null
    }
    if (blocked) {
      this._log('warn', '自動鍵配信が始まりました（EVENT 54）。EVENT 55 まで無線コマンドを止めます')
      // EVENT 55 を取りこぼすと送信が止まったままになる。
      this._keyTimer = setTimeout(() => {
        this._log('warn', 'EVENT 55 が来ないため、自動鍵配信中の扱いを解除します')
        this._setKeyBlocked(false)
      }, this.options.keyBlockMaxMs)
    } else {
      this._log('info', '自動鍵配信が終わりました（EVENT 55）')
      this._pump()
    }
    this.emit('status', this.snapshot())
  }

  _setRadioBlocked(blocked, why) {
    if (this.state.radioBlocked === blocked) return
    this.state.radioBlocked = blocked
    if (this._radioTimer) {
      clearTimeout(this._radioTimer)
      this._radioTimer = null
    }
    if (blocked) {
      this._log('error', 'ARIB STD-T108 の送信総和時間制限が発動しました。EVENT 33 まで送信を止めます')
      // EVENT 33 を取りこぼすと送信が止まったままになる。制限は 1 時間あたりの
      // 累積で判定されるので、十分に超えたら保険として解除する。
      this._radioTimer = setTimeout(() => {
        this._log('warn', 'EVENT 33 を受信しないまま時間が経過したため、送信制限の扱いを解除します')
        this._setRadioBlocked(false, 'タイムアウト')
      }, this.options.radioBlockMaxMs)
    } else {
      this._log('good', `送信総和時間の制限が解除されました${why ? '（' + why + '）' : ''}`)
      this._pump()
    }
    this.emit('status', this.snapshot())
  }

  /** 受信した UDP。ECHONET Lite のポートのものだけ解釈する。 */
  _onErxudp(e) {
    // PANA (716) や MLE (19788) の ERXUDP も飛んでくる。
    // それを ECHONET として読むと、でたらめな EPC/PDC になる。
    if (e.lport !== null && e.lport !== 0x0e1a) return

    if (e.encoding === 'empty') return
    if (e.encoding !== 'hex' || !e.hex) {
      this._log('warn', 'ERXUDP のデータ部を 16 進として読めませんでした。WOPT 01 の設定を確かめてください')
      return
    }

    let frame
    try {
      frame = EL.parseFrame(Buffer.from(e.hex, 'hex'))
    } catch (err) {
      this._log('warn', 'ECHONET フレームを解釈できません: ' + err.message)
      return
    }
    if (!frame) {
      this._log('warn', 'ECHONET Lite フレームとして解釈できません: ' + e.hex)
      return
    }
    // スマートメーター (0288xx) 以外からの電文は無視する
    if (!frame.fromMeter) return

    // 受信の強さ (SA2=1 のとき)。応答のたびに LQI を更新する
    if (typeof e.lqi === 'number') {
      this.state.meter.lqi = e.lqi
      this.state.meter.rssi = typeof e.rssi === 'number' ? e.rssi : null
      this.state.meter.lqiAt = Date.now()
    }

    // 送り直したあとに届いた、もう片方の応答。同じ値を二度出さない。
    // 自発の通知 (INF) はこちらの要求の応答ではないので、TID がたまたま同じでも捨てない
    if (!frame.isInf && this._lateTids && this._lateTids.delete(frame.tid)) return
    const result = this._decodeFrame(frame, e)
    // 何のための取得だったか ('poll'・'once'・'verify'・'slow'・'halfHour'・'manual'・'diag' など。_request の purpose)。
    // メーターの自発の通知 (INF) は 'inf'。分からなければ null。
    // 受け手 (wsuha-broute の出力 1・推移) が診断の値を混ぜないために見る
    const matched = !!(this._pending && this._pending.tids.includes(frame.tid))
    result.purpose = matched
      ? this._pending.purpose
      : frame.isInf
        ? 'inf'
        : (this._tidPurposes && this._tidPurposes.get(frame.tid)) || null

    // 待っていた要求への応答だったときだけ「生きている」と判断する。
    // lport が 3610 というだけでは、こちらの要求への応答とは限らない
    // (メーターは状変時に INF を自発送信する)。ここを緩めると
    // 「PANA は生きているが ECHONET Lite だけ返らない」状態を検出できなくなる。
    if (matched) {
      const p = this._pending
      clearTimeout(p.timer)
      this._pending = null
      this.state.pollMisses = 0
      if (p.resent) {
        this.state.counters.resendRecovered++
        if (!this._lateTids || this._lateTids.size > 16) this._lateTids = new Set()
        for (const t of p.tids) if (t !== frame.tid) this._lateTids.add(t)
      }
      p.resolve(result)
    } else if (frame.isInf) {
      this._log('info', `メーターからの状態通知（INF）: ${result.values.map((v) => v.name).join(', ')}`)
    }

    if (result.values.length) {
      this._remember(result.values)
      result.known = this.state.values // いま分かっている全部
      this._noteValueArrived(result.purpose, result.values)
      this.emit('measurement', result)
      this.emit('status', this.snapshot()) // 係数などが入った状態を配る
    }
  }

  /**
   * 取れた値を覚えておく。
   *
   * 階層取得では、1 回の受信に含まれるのは要求した EPC だけ。
   * 積算電力量は 5 分に 1 回、製造番号は接続時に 1 回しか来ないので、
   * 「いま分かっている全部」をここに溜めて下流へ渡せるようにする。
   */
  _remember(values) {
    const now = Date.now()
    for (const v of values) {
      if (v == null || v.epc === undefined) continue
      this.state.values[hexEpc(v.epc)] = Object.assign({}, v, { at: now })
    }
  }

  /** フレームを値に変換し、係数・未対応 EPC を学習する。 */
  _decodeFrame(frame, erxudp) {
    const ts = Date.now()
    const ctx = {
      coefficient: this.state.calibration.coefficient,
      unitFactor: this.state.calibration.unitFactor,
    }
    // 同じ電文に係数・単位が入っていれば、先に読んで換算に使う。
    // 係数の取り直し (5 分の階層で D3/E1 と E0/E3 を 1 通にまとめる) では、
    // 先に読まないと同じ電文の積算が未換算 (null) のまま出てしまう。
    for (const p of frame.props) {
      if (p.pdc === 0 || (p.epc !== 0xd3 && p.epc !== 0xe1)) continue
      const v = EL.decode(p.epc, p.edt, ctx)
      if (typeof v.value !== 'number') continue
      if (p.epc === 0xd3) ctx.coefficient = v.value
      if (p.epc === 0xe1) ctx.unitFactor = v.value
    }

    // Get_SNA (0x52) = 要求のどれかが読めなかった、という応答。
    // 重要なのは「読めたプロパティの値は同じ電文に入っている」こと。
    // 0x72 だけを受理すると、成功した分まで捨てたうえに「応答なし」と
    // 誤判定してリトライし続ける無限ループになる。
    //
    // 拒否された EPC は「しばらく控える」だけにする。定期取得の設定からは外さない。
    // メーターは一時的に PDC=0 を返すことがあるので、1 回の拒否で設定から外すと、
    // 瞬時電力のような毎回取る値まで二度と取れなくなる。
    if (frame.isGetSna) {
      for (const p of frame.props) if (p.pdc === 0) this._noteDenied(p.epc)
    }

    const values = []
    const calib = {}
    for (const p of frame.props) {
      if (p.pdc === 0) continue
      this._noteGranted(p.epc)
      const v = EL.decode(p.epc, p.edt, ctx)
      v.ts = ts
      v.tid = frame.tid
      v.esv = frame.esvName
      // Get プロパティマップ。このメーターが持っている EPC の一覧。
      // 以後、ここに無いものは要求しない (Get_SNA が返るだけで電波の無駄)。
      if (p.epc === 0x9f && Array.isArray(v.value) && v.value.length) {
        this.state.supportedEpcs = v.value.slice().sort((a, b) => a - b)
        this._log(
          'info',
          `このメーターが持っている値 ${v.value.length} 件: ` + this.state.supportedEpcs.map(hexEpc).join(', ')
        )
      }
      if (p.epc === 0xd3 && typeof v.value === 'number') calib.coefficient = v.value
      if (p.epc === 0xe1 && typeof v.value === 'number') calib.unitFactor = v.value
      if (p.epc === 0xd7 && typeof v.value === 'number') calib.digits = v.value
      values.push(v)
    }

    if (Object.keys(calib).length) {
      Object.assign(this.state.calibration, calib)
      this._log('info', `係数/単位を取得しました: 係数=${this.state.calibration.coefficient} 単位=${this.state.calibration.unitFactor} kWh`)
      this.emit('calibration', Object.assign({}, this.state.calibration))
    }

    return {
      ts,
      tid: frame.tid,
      esv: frame.esvName,
      isInf: frame.isInf,
      isGetSna: frame.isGetSna,
      from: erxudp ? erxudp.sender : null,
      values,
    }
  }

  // =========================================================================
  //  ポートの開閉
  // =========================================================================

  _onPortOpen() {
    this.state.portOpen = true
    this._log('good', 'シリアルポートが開きました')
    // 止めている間の抜き差しで、開いているのに「ポート切断」と出し続けない
    if (!this._running && this.state.phase === 'port-down') this._setPhase(this.state.overrides.stopped ? 'overridden' : 'idle')
    this.emit('status', this.snapshot())
    this._pump()
    // 開けずに再試行の待ち (最大 5 分) に入っていたら、待たずに始める。
    // ポートは transport が自分で開き直すので、開いたことを合図にする。
    // 起こすのは再試行の待ちだけ。送信時間の予算待ち (ARIB) やバースト待ちを
    // 起こすと、休むべきところで SKJOIN を撃ってしまう。
    if (this._running && !this._closed && this._waitingFor === '再試行の待ち') this._wakeUp()
  }

  _onPortClose() {
    this.state.portOpen = false
    this._markDown()
    // 自分で閉じたとき (再デプロイ・終了) は異常ではない。
    this._log(this._closed ? 'info' : 'error', 'シリアルポートが閉じました')
    // 残った応答待ちは、復帰後のシーケンス途中で誤って再接続を撃つ原因になる。
    this._abortQueue('ポート切断')
    this._clearPending('ポート切断')
    this._stopCollecting()
    // USB の抜き差しや電源の瞬断では、モジュールがリセットされて RAM の設定
    // (SFE・S2・S3・PSK・RBID) が消えている。開き直したあと SKREJOIN や SKJOIN から始めても
    // FAIL ER10 が返るだけなので、最初 (SKRESET) からやり直す。
    if (!this._closed) {
      this._needReset = true
      this._termBeforeReset = true
      this._bumpLadder(3) // 画面の段階の表示のため。どこから始めるかは _needReset が決める
      if (this._running) {
        // 進行中の手順 (SKJOIN のバースト待ちなど) を畳む。畳まないと、開き直した瞬間に
        // キューに溜まった SKTERM・SKJOIN が、設定の消えたモジュールへ流れる。
        this._bumpGeneration()
        this._wakeUp()
      }
    }
    this._setPhase('port-down')
    this.emit('status', this.snapshot())
  }

  // =========================================================================
  //  補助
  // =========================================================================

  /**
   * 静かに止まっていないかの見張り。
   *
   * 途中のフェーズなのに、送信中のコマンドも待ち行列も応答待ちも無い、
   * という状態が続いたら、どこかで手順が切れている。
   * 自動運転では誰も見ていないので、時間で引き剥がして最初からやり直す。
   *
   * (「scanning のまま tx が増えない」状態は、例外でも失敗でもないので、
   *  カウンタにもログにも何も出ない。)
   */
  _startWatchdog() {
    this._stopWatchdog()
    this._stalledSince = 0
    this._watchdogTimer = setInterval(() => this._checkStall(), this.options.watchdogIntervalMs)
    if (this._watchdogTimer.unref) this._watchdogTimer.unref()
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer)
      this._watchdogTimer = null
    }
    this._stalledSince = 0
  }

  _checkStall() {
    if (!this._running || this._closed) return
    const TRANSIENT = ['opening', 'resetting', 'configuring', 'scanning', 'joining', 'rejoining', 'verifying']
    if (TRANSIENT.indexOf(this.state.phase) < 0) {
      this._stalledSince = 0
      this._lastProgress = null
      return
    }

    // 判定は「期限」で行う。「何か入っているかどうか」では駄目だった。
    //
    //   ・「送信中や待ち行列が空なら滞留」では、
    //     宙に浮いた応答待ち (_pending) が残ると永久に発火しない
    //     (scanning のまま止まっても気づけない)
    //   ・「送受信が進まなければ滞留」では、
    //     SKSCAN は DURATION=8 で約 69 秒かかる。その間 tx も rx も動かないので、
    //       正常な長いコマンドを途中で叩き切ってしまう
    //
    // 正しくは「期限を持った仕事を抱えているなら、その期限までは待つ」。
    // 期限を過ぎても誰も後始末をしていない = どこかで手順が切れている。
    // 待つのが正しい状態を叩かない。
    //   ・再試行までの待ち (_sleep)
    //   ・マニュアル 8 章の無線送信禁止期間 (EVENT 32 / 54 / 29)
    // ここを見ていなかったため、EVENT 32 で送信を止めている最中に
    // 「手順が切れた」と誤判定して SKRESET を撃ち続けていた。
    const waiting = this._deliberateWait()
    if (waiting) {
      this._stalledSince = 0
      this._lastProgress = null
      return
    }

    const now = Date.now()
    const GRACE = 5000
    if (this._current && this._current.deadline && now < this._current.deadline + GRACE) {
      this._stalledSince = 0
      return
    }
    if (this._pending && this._pending.deadline && now < this._pending.deadline + GRACE) {
      this._stalledSince = 0
      return
    }

    const progress = `${this.state.phase}:${this.state.counters.tx}:${this.state.counters.rx}`
    if (progress !== this._lastProgress) {
      this._lastProgress = progress
      this._stalledSince = 0
      return
    }
    if (!this._stalledSince) {
      this._stalledSince = Date.now()
      return
    }
    if (now - this._stalledSince < this.options.watchdogStallMs) return

    this._stalledSince = 0
    this._lastProgress = null
    this._log(
      'error',
      `「${PHASES[this.state.phase] || this.state.phase}」のまま ${Math.round(this.options.watchdogStallMs / 1000)} 秒以上、` +
        '送受信が 1 件も進みませんでした。手順が切れたとみなして最初からやり直します' +
        (this._current ? `（実行中: ${this._current.label}）` : '') +
        (this._pending ? '（応答待ちが残っています）' : '')
    )
    // 取り残しを確実に畳んでからやり直す。
    // ここを掃除しないと、次の手順がまた同じ待ちに引っかかる。
    this._abortQueue('滞留の解消')
    this._clearPending('滞留の解消')
    this._requestChain = Promise.resolve()
    this._requestDepth = 0
    this.state.ladder = 3 // SKRESET から全部
    this.reconnect('処理が止まったため')
  }

  _setPhase(phase, reason) {
    if (this.state.phase === phase) return
    const from = this.state.phase
    // reauth から抜けたら、その見切りタイマーは役目を終えている。
    // 残すと、繋ぎ直したあとに古いタイマーが再接続を蹴る。
    if (from === 'reauth' && phase !== 'reauth') this._clearReauthTimeout()
    this.state.phase = phase
    this.state.phaseSince = Date.now()
    this._stalledSince = 0 // フェーズが動いた = 生きている
    this._log('info', `接続の段階: ${PHASES[from] || from} → ${PHASES[phase] || phase}${reason ? '（' + reason + '）' : ''}`)
    this.emit('phase', { from, to: phase, reason: reason || null, text: PHASES[phase] || phase })
    this.emit('status', this.snapshot())
  }

  _recordError(err) {
    // code は機械が読む印。文言を比べずに原因で分けられるように残す
    this.state.lastError = { message: err.message, code: err.code || null, at: Date.now() }
    this.emit('status', this.snapshot())
  }

  _log(level, text) {
    this.emit('log', { level, text, phase: this.state.phase, ts: Date.now() })
  }

  /**
   * 利用者の操作が要らない注意の重さ。実機では気づけるように warn で残す。
   * シミュレーターは実機の初期状態まで写すので、初めて動かす人が異常と読まないように info へ下げる。
   */
  _noticeLevel() {
    return this.transport && this.transport.simulated ? 'info' : 'warn'
  }
}

// ---------------------------------------------------------------------------
/**
 * EPC の指定を数値に直す。
 *
 * 型で意味を分ける:
 *   数値   0xE7 / 231     → そのままの値 (JS で書いたときの自然な意味)
 *   文字列 'E7' / '0xE7'  → 16 進として読む
 *
 * 文字列を 16 進とみなすのは、EPC が常に 16 進表記で語られるため。
 * '80' を 10 進で読むと 0x50 になり、黙って別のプロパティを要求してしまう。
 */
function toEpc(x) {
  if (x === null || x === undefined) return null
  let n
  if (typeof x === 'number') {
    n = Math.trunc(x)
  } else {
    const s = String(x).trim().replace(/^0x/i, '')
    if (!s || !/^[0-9A-Fa-f]{1,2}$/.test(s)) return null
    n = parseInt(s, 16)
  }
  return isNaN(n) || n < 0 || n > 0xff ? null : n
}

function hexEpc(n) {
  return '0x' + pad2(n)
}

function pad2(n) {
  return ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
}

function hex4(n) {
  return ('000' + (n & 0xffff).toString(16).toUpperCase()).slice(-4)
}

/**
 * raw() から送ってはいけないコマンドの理由。送ってよければ null。
 *   FLASH を消耗するもの (書き込み回数の上限は 10,000 回で、戻せない): WOPT・WUART・SKSAVE・SKERASE
 *   このクラスの前提 (SF0 = アクティブ MAC 面・SFE = エコーバック) を変えるもの: SKSREG SF0 / SFE の書き込み
 * フローの入力 command は預かる前に同じ規則で断る (nodes/wsuha-broute.js の forbiddenCommand)。
 */
function forbiddenRawCommand(command) {
  const c = String(command === undefined || command === null ? '' : command).trim()
  if (/^(WOPT|WUART|SKSAVE|SKERASE)\b/i.test(c)) return `${c.split(' ')[0]} は FLASH を消耗するため command からは実行できません`
  if (/^SKSREG\s+SF[0E]\b/i.test(c)) return `${c} はノードが管理しているため command からは変更できません`
  return null
}

/** SKSENDTO の失敗のログに出す、アダプタの FAIL の値 (ER10 など)。それ以外の失敗は 'FAIL'。 */
function failCodeOf(err) {
  const c = err && err.code ? String(err.code) : ''
  return /^(ER\d\d|FAIL)$/.test(c) ? c : 'FAIL'
}

/** 接続の段階の名前 (PHASES のキー。画面のステッパーと比べるのに使う)。 */
const PHASE_NAMES = Object.keys(PHASES)

module.exports = {
  Sequencer,
  PHASES,
  PHASE_NAMES,
  DEFAULTS,
  Aborted,
  CommandError,
  toEpc,
  isCommandText,
  commandTextProblem,
  forbiddenRawCommand,
  isLadder,
  LADDER_MAX,
}
