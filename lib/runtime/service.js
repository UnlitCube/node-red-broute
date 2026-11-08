'use strict'

// ============================================================================
//  画面（HTTP API）とフロー（wsuha-broute ノードの入力）で共有する操作
// ============================================================================
//
//  画面は窓口の 1 つで、正はノード。
//  **画面だけの機能を作らない。** 運用設定の保存・全部外す・読む、診断、状態（AdapterDetail）は、
//  画面（lib/runtime/http-api.js）からもフロー（nodes/wsuha-broute.js）からもここを通る。
//  同じ検証・同じ settings-store・同じ registry を使うので、どこから変えてもほかの 2 つに映る。
//
//  失敗は ApiError（status・code・日本語の message・details）で投げる。
//  画面はそれを HTTP の状態と {error:{code, message}} にし、フローは出力 2 の error にする。
//
//  変えた人（by）はログインが無いので経路で書く:
//    'web-ui'          画面
//    'flow:<名前か id>' wsuha-broute ノードの入力
//    'editor'          エディタで設定ノードの値を変えてデプロイし、運用設定が外れた
//
//  読み出しも全部ノードからできる: 一覧と合計（adapters）・推移（trend）・ログ（logs）・Meta も、
//  画面の GET とフローの入力（topic が adapters・trend・logs・meta）がここの同じ関数と同じ検証を通る。
//
//  ここは Node-RED に依存しない（RED を受け取らない。settings.js の値は p.settings で受け取る）。

//  最新値の読み出し: 画面の GET adapters/:id/read とフローの入力 read が readOf・staleOf を通る。
//  無線を使わずに持っている値で答え、maxAgeSec より古い・無い値があるときだけ、呼んだ側が refreshValues で取りに行く
//  （フローは預かりの規則に乗せ、画面はすぐ答える）。

//  構成: 名前・契約・有効・接続先・ポート・ボーレート・デバイスキー・想定 MAC・自動開始・スキャン時間と、
//  B ルート認証情報（値は返さない）も、画面（PUT config / credentials）とフロー（入力 config / credentials）がここを通る。
//  効かせ方は設定ノード（nodes/wsuha-device.js の reconfigure）: 接続に関わる項目が変わったらその台だけ開き直す。
//  開き直しの最中に次の構成・認証情報の変更が来たら、待たずに 409 BUSY（終わってからもう一度）。

//  アダプタの追加: 画面の POST adapters とフローの add-adapter が addAdapter を通る。
//  検証（422）→ 使えるか（503 NOT_AVAILABLE / 409 FLOWS_LOCKED）→ 台数（409 LIMIT_REACHED）→ ポート（409 PORT_IN_USE。
//  ほかの台とフローのシリアルのノード）→ デバイスキー（409 DEVICE_KEY_IN_USE）→ PairID（409 PAIR_IN_USE）→ 1 本ずつ（409 BUSY）。
//  フローを書くのは flow-writer.js（runtime API の setFlows。'nodes' のデプロイ）。画面の守り（readOnly・uiConfig・uiAddAdapter）は
//  http-api.js が先に掛ける（フローの入力には掛けない）。

const fs = require('fs')
const path = require('path')
const vm = require('./view-model')
const { validateSettingsInput, normalizeConfigValue, RevisionMismatch, FIELDS } = require('./settings-store')
const { LIB_VERSION } = require('./registry')
const { toEpc } = require('../sequencer')
const cf = require('./config-fields')
const { validateCredentialsInput, envCredentialsOf, pairIdOf } = require('./credentials-store')
const outputs = require('./outputs')
const rv = require('./read-values')
const { TAB_LABEL } = require('./flow-writer')
const { NEXT: HEALTH_NEXT } = require('./health')
const { authMeta } = require('./editor-auth')

/** 画面とフローから足せる台数の上限（wsuha-device の数。無効の台も数える）。 */
const ADD_LIMIT = 8
/** 足したあと、設定ノードが registry に載る（claim）まで待つ長さ [ms]。 */
const ADD_CLAIM_MS = 10000

const BULKY = [0xe2, 0xe4, 0xec]
const SREG_ALLOWED = ['S02', 'S03', 'S07', 'S0A', 'S15', 'S16', 'S17', 'SA2', 'SFD', 'SFE', 'SF0']
const TABLE_ALLOWED = ['1', '2', 'E', 'F']
const EDITOR = 'editor'
const WEB_UI = 'web-ui'
/** 推移の範囲（trend）。 */
const RANGES = { '1h': 3600 * 1000, '6h': 6 * 3600 * 1000, '24h': 24 * 3600 * 1000 }
/** 1 系列の点数の上限。 */
const TREND_MAX_POINTS = 720
const LOG_LEVELS = ['info', 'warn', 'error']
const LOG_LIMIT_DEFAULT = 200
const LOG_LIMIT_MAX = 1000
/** 入れ替えたのに再起動していないのを見分けるため、ディスクの package.json を毎回読む（Meta.diskVersion）。 */
const PKG_JSON = path.join(__dirname, '..', '..', 'package.json')

// 失敗の形は errors.js（預かりの待ち行列 pending.js と共有する。ここから出し直すので、今までどおり service から読める）
const { ApiError } = require('./errors')

/** 待ちに上限を付ける。上限を過ぎても元の処理は続く（結果は捨てる）。 */
function withTimeout(promise, ms, what) {
  let timer = null
  const p = Promise.resolve(promise)
  p.catch(() => {}) // 上限で先に返したあとの失敗を、未処理の拒否にしない
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${what}が ${Math.round(ms / 1000)} 秒以内に終わりませんでした（処理は続いています）`)
      e.timeout = true
      reject(e)
    }, ms)
    if (timer.unref) timer.unref()
  })
  return Promise.race([p, guard]).then(
    (v) => {
      clearTimeout(timer)
      return v
    },
    (e) => {
      clearTimeout(timer)
      throw e
    }
  )
}

/**
 * sequencer の CommandError の code（機械が読む印。lib/sequencer.js が付ける）→ API の状態と code。
 * 文言を直しても API とフローの code が変わらないように、code をいちばん先に見る。
 * ER06・FAIL（アダプタが返した失敗の番号）は下の 502 DEVICE_ERROR。
 */
const SEQ_CODES = {
  FORBIDDEN_COMMAND: [403, 'FORBIDDEN_COMMAND'],
  ABORTED: [409, 'BUSY'],
  QUEUE_FULL: [409, 'BUSY'],
  BUSY: [409, 'BUSY'],
  RADIO_BLOCKED: [409, 'RADIO_BLOCKED'],
  PANA_BUSY: [409, 'BUSY'],
  KEY_BLOCKED: [409, 'BUSY'],
  TIMEOUT: [504, 'TIMEOUT'],
  NOT_CONNECTED: [503, 'NOT_CONNECTED'],
  PORT_DOWN: [503, 'PORT_DOWN'],
  DEVICE_ERROR: [502, 'DEVICE_ERROR'],
}

/** code ごとの message（無ければ sequencer の文言のまま）。 */
function messageFor(code, msg) {
  if (code === 'NOT_CONNECTED') return 'メーターとつながっていません'
  if (code === 'ABORTED') return '別の処理（再接続・停止など）で取り消されました: ' + msg
  if (code === 'DEVICE_ERROR') return 'アダプタが失敗を返しました: ' + msg
  return msg
}

/**
 * sequencer の失敗を、状態と code にする。分からないものは null（呼んだ側が 500 にする）。
 * 見る順: ApiError → err.code（SEQ_CODES・ER\d\d・FAIL）→ 印（forbidden・aborted・queueFull・blocked・timeout）→
 * 文言の正規表現（後ろの予備。code を付けていない古い sequencer と、ほかから来たエラーのため）。
 */
function mapError(err) {
  if (err instanceof ApiError) return err
  const msg = String((err && err.message) || err || '')
  const code = err && typeof err.code === 'string' ? err.code : ''
  if (code && Object.prototype.hasOwnProperty.call(SEQ_CODES, code)) {
    const [status, apiCode] = SEQ_CODES[code]
    return new ApiError(status, apiCode, messageFor(code, msg))
  }
  if (code && /^(ER\d\d|FAIL)$/.test(code)) return new ApiError(502, 'DEVICE_ERROR', messageFor('DEVICE_ERROR', msg))
  if (err && err.forbidden) return new ApiError(403, 'FORBIDDEN_COMMAND', msg)
  if (err && err.aborted) return new ApiError(409, 'BUSY', messageFor('ABORTED', msg))
  if (err && err.queueFull) return new ApiError(409, 'BUSY', msg)
  if (err && err.blocked) return new ApiError(409, 'RADIO_BLOCKED', msg)
  if (err && err.timeout) return new ApiError(504, 'TIMEOUT', msg)
  // ここから下は予備（文言の照らし合わせ）
  if (/送信総和時間/.test(msg)) return new ApiError(409, 'RADIO_BLOCKED', msg)
  if (/タイムアウト/.test(msg)) return new ApiError(504, 'TIMEOUT', msg)
  if (/滞留|前の要求/.test(msg)) return new ApiError(409, 'BUSY', msg)
  if (/接続先アドレスが未確定/.test(msg)) return new ApiError(503, 'NOT_CONNECTED', messageFor('NOT_CONNECTED', msg))
  if (/ポートが開いていません|送信できません/.test(msg)) return new ApiError(503, 'PORT_DOWN', msg)
  return null
}

/** EPC の配列を検査して数値にする（1〜6 個・E2/E4/EC は不可・重なりは 1 つに）。 */
function parseEpcList(v, field) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 6) {
    throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { [field]: '1〜6 個の EPC を配列で指定してください（例: ["E7"]）' })
  }
  const out = []
  for (const x of v) {
    const n = typeof x === 'string' || typeof x === 'number' ? toEpc(x) : null
    if (n === null) {
      throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { [field]: `EPC を 16 進で指定してください: ${String(x).slice(0, 16)}` })
    }
    if (BULKY.indexOf(n) >= 0) {
      throw new ApiError(422, 'VALIDATION', '入力を確かめてください', {
        [field]: `${vm.epcHex(n).slice(2)} は履歴のため、ここでは取得できません（E2・E4・EC は不可）`,
      })
    }
    if (out.indexOf(n) < 0) out.push(n)
  }
  return out
}

/** 診断の入力を、送るもの（SK コマンドか EPC）に直す。許可リストに無いものは 403、形の誤りは 422。 */
function planDiag(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const name = typeof b.name === 'string' ? b.name : ''
  const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {}
  switch (name) {
    case 'info':
      return { name, commands: ['SKINFO', 'SKVER', 'SKAPPVER'] }
    case 'table': {
      const which = String(args.which === undefined ? '' : args.which).toUpperCase()
      if (TABLE_ALLOWED.indexOf(which) < 0) {
        throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { which: "'1'・'2'・'E'・'F' のどれかを指定してください" })
      }
      return { name, commands: ['SKTABLE ' + which] }
    }
    case 'ropt':
      return { name, commands: ['ROPT'] }
    case 'sreg': {
      if (args.value !== undefined) {
        throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { value: 'レジスタは読み出しだけです。値は付けられません' })
      }
      const reg = String(args.reg === undefined ? '' : args.reg).trim().toUpperCase()
      if (/\s/.test(reg)) {
        throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { reg: 'レジスタは読み出しだけです。値は付けられません' })
      }
      if (SREG_ALLOWED.indexOf(reg) < 0) {
        throw new ApiError(403, 'FORBIDDEN_COMMAND', `レジスタ ${reg.slice(0, 8) || '(空)'} の読み出しは許可されていません`)
      }
      return { name, commands: ['SKSREG ' + reg] }
    }
    case 'propmap':
      return { name, epcs: [0x9d, 0x9e, 0x9f] }
    case 'epc':
      return { name, epcs: parseEpcList(args.epcs, 'epcs') }
    default:
      throw new ApiError(403, 'FORBIDDEN_COMMAND', `この診断は受け付けていません: ${name.slice(0, 40) || '(空)'}`)
  }
}

// ---------------------------------------------------------------------------
//  読み出しの引数（画面のクエリ文字列とフローの payload の両方を受ける）
// ---------------------------------------------------------------------------

function absent(v) {
  return v === undefined || v === null || v === ''
}

/** 0 以上の整数（数か、数字だけの文字列）。それ以外は null。 */
function nonNegativeInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null
  const n = parseInt(v, 10)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * 推移の範囲（'1h'・'6h'・'24h'。省略は '1h'）。外れたら 422。
 * RANGES[range] で引くと 'constructor'・'toString' が Object の持ち物で真になり、from・to が NaN の 200 を返していた。
 */
function parseRange(v) {
  const range = absent(v) ? '1h' : String(v)
  if (!Object.prototype.hasOwnProperty.call(RANGES, range)) {
    throw new ApiError(422, 'VALIDATION', '入力を確かめてください', { range: '1h・6h・24h のどれかを指定してください' })
  }
  return range
}

/**
 * ログの引数 {after?, limit?, level?}。外れたら 422（項目ごとの理由は details）。
 * @returns {{after: number, limit: number, level: string|null}}
 */
function parseLogQuery(q) {
  const src = q && typeof q === 'object' && !Array.isArray(q) ? q : {}
  const details = {}
  let after = 0
  let limit = LOG_LIMIT_DEFAULT
  let level = null
  if (!absent(src.after)) {
    const n = nonNegativeInt(src.after)
    if (n === null) details.after = '0 以上の整数で指定してください'
    else after = n
  }
  if (!absent(src.limit)) {
    const n = nonNegativeInt(src.limit)
    if (n === null || n < 1 || n > LOG_LIMIT_MAX) details.limit = `1〜${LOG_LIMIT_MAX} の整数で指定してください`
    else limit = n
  }
  if (!absent(src.level)) {
    level = String(src.level)
    if (LOG_LEVELS.indexOf(level) < 0) details.level = 'info・warn・error のどれかを指定してください'
  }
  if (Object.keys(details).length) throw new ApiError(422, 'VALIDATION', '入力を確かめてください', details)
  return { after, limit, level }
}

/**
 * 全台の瞬時電力の合計（画面はこの total を使う。ui/store.js の totalPower は total を返さない古いサーバー向けで、power.fresh を見ない）。
 * - 無効の台は数えない（enabled にも入れない）。
 * - 値が古い（stale）台と、瞬時電力そのものが古い台（power.fresh が false）は足さず、staleCount に数える（画面は「n 台は瞬時電力が古いため除いています」）。
 * - 値の無い台（停止中・まだ届いていない）は足さない。
 * @returns {{power: number|null, count: number, enabled: number, staleCount: number}}
 */
function totalOf(items) {
  let sum = 0
  let count = 0
  let enabled = 0
  let staleCount = 0
  for (const a of items || []) {
    if (!a || a.enabled === false) continue
    enabled++
    const v = a.power ? a.power.value : null
    if (typeof v !== 'number' || !isFinite(v)) continue
    if (a.stale === true || (a.power && a.power.fresh === false)) {
      staleCount++
      continue
    }
    sum += v
    count++
  }
  return { power: count ? sum : null, count, enabled, staleCount }
}

/**
 * エディタの入口（Meta.editorRoot）。settings.js の httpAdminRoot に前後の / を付けたもの（Node-RED の red.js の formatRoot と同じ）。
 * httpAdminRoot が無ければ httpRoot、それも無ければ '/'。エディタが無い（httpAdminRoot・httpRoot が false、disableEditor）なら null。
 */
function editorRootOf(settings) {
  const s = settings || {}
  if (s.httpRoot === false || s.httpAdminRoot === false || s.disableEditor === true) return null
  let root = s.httpAdminRoot || s.httpRoot || '/'
  if (typeof root !== 'string') root = '/'
  if (root.charAt(0) !== '/') root = '/' + root
  if (root.slice(-1) !== '/') root += '/'
  return root
}

/** settings.js の wsuhaBroute.readOnly === true か（true 以外の値は読み出しのみにしない）。画面からの操作だけを止める。 */
function isReadOnly(settings) {
  const w = settings && settings.wsuhaBroute
  return !!(w && w.readOnly === true)
}

/** settings.js の wsuhaBroute.uiConfig === false か（画面からの構成と認証情報の書き込みだけを止める）。 */
function isConfigLocked(settings) {
  const w = settings && settings.wsuhaBroute
  return !!(w && w.uiConfig === false)
}

const CONFIG_LOCKED_MESSAGE = 'このサーバーでは画面からアダプタと認証情報を変えられません（settings.js の wsuhaBroute.uiConfig）。エディタの設定ノードかフローの入力で変えてください'

/**
 * 画面からの追加を止めているか（settings.js の wsuhaBroute.uiAddAdapter === false か、uiConfig === false）。
 * 既定は止めない。フローの add-adapter には掛けない（readOnly・uiConfig と同じ）。
 */
function isAddLocked(settings) {
  const w = settings && settings.wsuhaBroute
  return !!(w && (w.uiAddAdapter === false || w.uiConfig === false))
}

const SERIALPORT_MESSAGE = 'serialport を読み込めないので、ポートの候補を出せません。' + HEALTH_NEXT.serialport + '。'

const ADD_LOCKED_MESSAGE = 'settings.js の設定で、画面からの追加を止めています（wsuhaBroute.uiAddAdapter か uiConfig）。エディタで追加してください'

// ---------------------------------------------------------------------------
//  ポートの候補の見分け（サーバーの 1 か所。エディタの 🔍 と画面が同じ印を使う）
// ---------------------------------------------------------------------------

/** Wi-SUN アダプタ（RS-WSUHA）の名前。 */
const WSUHA_RE = /RS-?WSUHA|RATOC|BP35/i
/** FTDI のチップを使う、分かっている別の機器（TWELITE の MONOSTICK・I-O DATA の CO2 センサーなど）。 */
const OTHER_RE = /MONO[\s_.-]*WIRELESS|MONOSTICK|TWELITE|I[\s_.-]?O[\s_.-]?DATA|IODATA/i
const FTDI_VENDOR = '0403'

/**
 * ポートの候補の種類。
 *   wsuha: ほかの wsuha-device が使っている機器か、名前・manufacturer に RS-WSUHA・RATOC・BP35 を含む
 *   maybe: FTDI（vendorId 0403。名前・manufacturer の FTDI でも）で、分かっている別の機器ではない
 *   other: それ以外
 * @param {{texts: string[], manufacturer: string, vendorId: string, usedByAdapter: boolean}} p
 * @returns {{kind: 'wsuha'|'maybe'|'other', hint: string|null}}
 */
function classifyPort(p) {
  const all = (p.texts || []).concat([p.manufacturer || '']).join(' ')
  if (p.usedByAdapter || WSUHA_RE.test(all)) return { kind: 'wsuha', hint: 'Wi-SUN アダプタ（RS-WSUHA）です' }
  if (OTHER_RE.test(all)) {
    const what = /I[\s_.-]?O[\s_.-]?DATA|IODATA/i.test(all) ? 'I-O DATA の機器' : 'TWELITE（MONOSTICK）'
    return { kind: 'other', hint: `Wi-SUN アダプタではありません（${what}です）` }
  }
  const ftdi = String(p.vendorId || '').toLowerCase() === FTDI_VENDOR || /FTDI/i.test(all)
  if (ftdi) return { kind: 'maybe', hint: 'Wi-SUN アダプタ（RS-WSUHA）かもしれません（FTDI の USB シリアル）' }
  return { kind: 'other', hint: 'Wi-SUN アダプタではないようです' }
}

/**
 * ポートの実体（/dev/serial/by-id/… は指す先）で比べるための鍵。読めなければ書いたまま。Windows は大文字小文字を見ない。
 * @param {function} [realpath] 試験で差し替える
 */
function portKey(p, realpath) {
  // \\.\COM12 は Windows で 10 番以上を開くときの書き方で、COM12 と同じポート
  let s = String(p || '').trim().replace(/^\\\\\.\\(COM\d{1,3})$/i, '$1')
  try {
    s = (realpath || fs.realpathSync)(s)
  } catch (e) {
    /* 無いポート（抜けている・別の機械）は書いたままで比べる */
  }
  return process.platform === 'win32' || /^COM\d+$/i.test(s) ? s.toLowerCase() : s
}

function readDiskVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version || null
  } catch (e) {
    return null
  }
}

/** 変えた人（by）を、ログと画面に出す日本語にする。 */
function byLabel(by) {
  if (by === WEB_UI) return '画面'
  if (by === EDITOR) return 'エディタ'
  if (typeof by === 'string' && by.indexOf('flow:') === 0) return `フロー（${by.slice(5)}）`
  return by ? String(by) : '不明な経路'
}

function fmt(v) {
  if (v === null || v === undefined) return '未設定'
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/^0x/i, '')).join(', ')
  return String(v)
}

/**
 * 診断の結果の形。{ok, name, at, result:{lines, values?}}（画面が読む）に、下の項目を足したもの。
 * 画面の API（POST diag）とフローの出力 2 の diag で同じ。どれも JSON の往復で変わらない（outputs.plain を通す）。
 *   device・deviceKey … 契約名とキー（出力 2 のほかの topic と同じ。フローではノードが設定ノードの値で入れ直す）
 *   command  … 送ったもの。SK コマンド（info は 3 つを ' / ' でつなぐ）か、ECHONET の取得なら 'Get E7 E8'
 *   ts       … at（ミリ秒の数）と同じ時刻の ISO 8601
 *   lines    … 受け取った行（result.lines と同じ。伏せ字済み）
 *   parsed   … 項目に分けた結果（sk-results の parseCommandResult。info は SKINFO・SKVER・SKAPPVER を 1 つにまとめる。
 *              ECHONET の取得は {values: {E7: ValueRow, …}}）。失敗なら null
 *   error    … 失敗なら {code, message, advice, retryable}（FAIL ER06 など）。成功なら null
 *   commands … SK コマンドごとの {command, ok, lines, parsed, error}（ECHONET の取得は []）
 */
function diagPayload(h, plan, out, steps, at, ok) {
  const meta = (h && h.meta) || {}
  const epcHex = (n) => vm.epcHex(n).slice(2)
  const command = plan.commands ? plan.commands.join(' / ') : 'Get ' + (plan.epcs || []).map(epcHex).join(' ')
  let parsed = null
  let error = null
  if (plan.commands) {
    const bad = steps.filter((s) => !s.ok)
    if (bad.length) error = bad[bad.length - 1].error
    else {
      const parts = steps.map((s) => s.parsed).filter((x) => x && typeof x === 'object')
      parsed = parts.length ? Object.assign.apply(null, [{}].concat(parts)) : null
    }
  } else if (ok) {
    const values = {}
    for (const v of out.values || []) values[String(v.epc).replace(/^0x/i, '')] = v
    parsed = { values }
  }
  const body = { ok: !!ok, name: plan.name, at, result: out }
  return outputs.plain(
    Object.assign(body, {
      // 設定ノードの規則（空のデバイスキーは id）と同じにして、API の返事をフローの出力と突き合わせられるようにする
      device: meta.role || meta.deviceKey || (h && h.id) || null,
      deviceKey: meta.deviceKey || (h && h.id) || null,
      command,
      ts: outputs.stamp(at).ts,
      lines: out.lines.slice(),
      parsed,
      error,
      commands: steps,
    })
  )
}

/**
 * @param {object} p
 * @param {object} p.registry
 * @param {object} p.store     settings-store
 * @param {function} [p.log]   (level, text) Node-RED のログ
 * @param {function} [p.now]
 * @param {object} [p.timeouts] {diag, get} [ms]
 * @param {function|object} [p.settings] settings.js の値（RED.settings）。関数なら毎回呼ぶ（readOnly・editorRoot）
 * @param {function} [p.nodeRedVersion] Node-RED の版（RED.version()）
 * @param {object} [p.credStore] credentials-store（画面かフローで保存した認証情報。無ければ保存できない）
 * @param {function} [p.listPorts] ポートの候補（既定は SerialTransport.candidates。試験で差し替える）
 * @param {function} [p.serialportAvailable] serialport を読み込めるか（既定は SerialTransport.available。試験で差し替える）
 * @param {function} [p.realpath] ポートの実体を求める（既定 fs.realpathSync。試験で差し替える）
 * @param {function} [p.eachNode] Node-RED の RED.nodes.eachNode（フローのノードを数える・シリアルのノードを探す）
 * @param {object} [p.flowWriter] flow-writer.js（アダプタの追加。無ければ 503 NOT_AVAILABLE）
 * @param {function} [p.audit] (event, extra, reqLog?) 監査（Node-RED の RED.log.audit。'wsuha-broute.' を前に付ける）
 * @param {object} [p.env] 環境変数（既定 process.env。試験で差し替える）
 */
function createService(p) {
  const registry = p.registry
  const store = p.store
  const credStore = p.credStore || null
  const realpath = typeof p.realpath === 'function' ? p.realpath : undefined
  const log = typeof p.log === 'function' ? p.log : function () {}
  const now = typeof p.now === 'function' ? p.now : Date.now
  const TO = Object.assign({ get: 30000, diag: 15000, addClaim: ADD_CLAIM_MS }, p.timeouts || {})
  const flowWriter = p.flowWriter || null
  const audit = typeof p.audit === 'function' ? p.audit : function () {}
  const env = () => p.env || process.env
  /** フローのノードを 1 つずつ（無ければ何もしない）。 */
  const eachNode = (cb) => {
    if (typeof p.eachNode !== 'function') return
    try {
      p.eachNode(cb)
    } catch (err) {
      log('warn', 'フローのノードを読めませんでした: ' + (err && err.message))
    }
  }
  const settingsNow = () => {
    try {
      return (typeof p.settings === 'function' ? p.settings() : p.settings) || {}
    } catch (e) {
      return {}
    }
  }

  // ---------------------------------------------------------------------------
  //  アダプタと状態
  // ---------------------------------------------------------------------------

  /** 設定ノードが居る handle。無ければ 404。 */
  function adapter(id) {
    const h = id !== undefined && id !== null && id !== '' ? registry.get(id) : null
    if (!h || !h.claimed) {
      throw new ApiError(404, 'ADAPTER_NOT_FOUND', 'アダプタが見つかりません（設定ノードを削除したか、まだデプロイしていません）')
    }
    return h
  }

  function requireUsable(h) {
    if (h.reconfiguring) throw busyReconfiguring()
    if (h.meta.enabled === false) {
      throw new ApiError(409, 'DISABLED', 'アダプタが無効です。設定タブの「アダプタと接続」の詳細設定か、エディタの設定ノードで有効にしてください')
    }
    const seq = h.sequencer
    if (!seq) throw new ApiError(503, 'PORT_DOWN', 'アダプタを初期化できていません。接続先とポートを確かめてください')
    return seq
  }

  function requirePort(seq) {
    if (!seq.state.portOpen) throw new ApiError(503, 'PORT_DOWN', 'ポートが開いていません。USB の接続を確かめてください')
  }

  function requireMeter(seq) {
    // 止めている間はつながらないので、待っても直らない。ポートや接続より先に見て、再開の仕方を案内する
    if (seq.state.overrides && seq.state.overrides.stopped) {
      throw new ApiError(409, 'STOPPED_BY_OVERRIDE', '外部の指示で停止中のためメーターへ取りに行きません。先に「開始」か「自動運転に戻す」を押してください')
    }
    requirePort(seq)
    if (!seq.state.connected || seq.state.phase !== 'connected') {
      throw new ApiError(503, 'NOT_CONNECTED', 'メーターとつながっていません。つながるのを待ってから、もう一度試してください')
    }
    if (seq.state.radioBlocked) {
      throw new ApiError(409, 'RADIO_BLOCKED', '電波の送信時間の上限に達しているため、いまは送れません。制限が解けると自動で再開します')
    }
  }

  /** 画面の GET adapters/:id と同じ形（AdapterDetail）。 */
  function detailOf(h) {
    return vm.buildDetail(h.inspect(), now())
  }

  // ---------------------------------------------------------------------------
  //  読み出し（画面の GET とフローの入力で共有）
  // ---------------------------------------------------------------------------

  /** 設定ノードの居る全台の AdapterSummary（health の重い順 → 名前）。 */
  function summaries() {
    const t = now()
    return vm.sortSummaries(registry.list().map((h) => vm.buildSummary(h.inspect(), t)))
  }

  /** 画面の GET adapters・フローの adapters: {items: AdapterSummary[], total}。 */
  function listAdapters() {
    const items = summaries()
    return { items, total: totalOf(items) }
  }

  /** 画面の GET adapters/:id/trend・フローの trend。range は '1h'・'6h'・'24h'（省略は '1h'）。 */
  function trendOf(h, range) {
    return h.trend(RANGES[parseRange(range)], now(), TREND_MAX_POINTS)
  }

  /** 画面の GET adapters/:id/logs・フローの logs。q は {after?, limit?, level?}（文字列でも数でもよい）。 */
  function logsOf(h, q) {
    return h.logsAfter(parseLogQuery(q))
  }

  /** 画面の GET meta・フローの meta（Meta）。画面と API を載せていないサーバーでもフローから読める。 */
  function metaOf() {
    const s = settingsNow()
    let nodeRed = null
    try {
      nodeRed = typeof p.nodeRedVersion === 'function' ? p.nodeRedVersion() : null
      nodeRed = nodeRed === null || nodeRed === undefined ? null : String(nodeRed)
    } catch (e) {
      nodeRed = null
    }
    return {
      apiVersion: 1,
      libVersion: LIB_VERSION,
      diskVersion: readDiskVersion(),
      startedAt: registry.startedAt,
      nodeRed,
      readOnly: isReadOnly(s),
      // settings.js の wsuhaBroute.uiConfig === false なら、画面から構成と認証情報を変えられない
      configLocked: isConfigLocked(s),
      editorRoot: editorRootOf(s),
      // 画面からの追加
      addAdapter: addAdapterMeta(s),
      auth: authMeta(s, editorRootOf(s)),
    }
  }

  /**
   * Meta.addAdapter = {available, reason, count, limit: 8, tabLabel, envOverrides, locked, lockedReason}。
   *   available・reason: この Node-RED で足せるか（flow-writer の availability。false なら画面はエディタへの案内に切り替える）
   *   count: 今の wsuha-device の数（無効の台も数える）。limit 以上なら画面はボタンを押せなくする
   *   envOverrides: 接尾辞の無い環境変数 WSUHA_BROUTE_ID・WSUHA_BROUTE_PASSWORD がある（足した台の認証情報より優先される）
   *   locked・lockedReason: settings.js の wsuhaBroute.uiAddAdapter === false か uiConfig === false（画面からの追加は 403 CONFIG_LOCKED）
   *     （契約の形に足した項目。readOnly は Meta.readOnly のまま）
   */
  function addAdapterMeta(s) {
    let av = { available: false, reason: '画面からの追加の仕組みを用意できていません（Node-RED のログを確かめてください）' }
    try {
      if (flowWriter) av = flowWriter.availability()
    } catch (err) {
      av = { available: false, reason: '画面からの追加の仕組みを確かめられませんでした（Node-RED のログを確かめてください）' }
    }
    const locked = isAddLocked(s)
    return {
      available: !!av.available,
      reason: av.available ? null : av.reason || null,
      count: deviceCount(),
      limit: ADD_LIMIT,
      tabLabel: TAB_LABEL,
      envOverrides: !!envCredentialsOf('', env()),
      locked,
      lockedReason: locked ? ADD_LOCKED_MESSAGE : null,
    }
  }

  /** 今の wsuha-device の数（フローの中の数。無効の台・Node-RED で無効にした設定ノードも数える。読めなければ registry の数）。 */
  function deviceCount() {
    let n = 0
    let seen = false
    eachNode((x) => {
      seen = true
      if (x && x.type === 'wsuha-device') n++
    })
    return seen ? n : registry.list().length
  }

  /** settings.js の wsuhaBroute.readOnly（画面からの操作だけを止める）。 */
  function readOnly() {
    return isReadOnly(settingsNow())
  }

  /** settings.js の wsuhaBroute.uiConfig === false（画面からの構成と認証情報の書き込みだけを止める）。 */
  function configLocked() {
    return isConfigLocked(settingsNow())
  }

  // ---------------------------------------------------------------------------
  //  最新値の読み出し
  // ---------------------------------------------------------------------------

  /**
   * read の返事（無線を使わない）。req は read-values の parseReadRequest / parseReadQuery の結果。
   * @param {object} [o] {refreshed: number[]（取りに行った EPC）, refreshedSince: number（取りに行き始めた時刻 [ms]。Date.now）,
   *   device, deviceKey（フローではノードが入れる）}
   */
  function readOf(h, req, o) {
    const opt = o || {}
    const meta = h.meta || {}
    return rv.buildRead({
      // 既定は設定ノードの規則（空のデバイスキーは id）と同じ。フローはノードが同じ値を入れる
      device: opt.device !== undefined ? opt.device : meta.role || meta.deviceKey || h.id,
      deviceKey: opt.deviceKey !== undefined ? opt.deviceKey : meta.deviceKey || h.id,
      known: typeof h.knownValues === 'function' ? h.knownValues() : {},
      req,
      inspect: h.inspect(),
      now: now(),
      refreshed: opt.refreshed,
      refreshedSince: opt.refreshedSince,
      redact: h.redact,
    })
  }

  /** maxAgeSec より古い・無いので取り直す EPC（maxAgeSec が無ければ空）。 */
  function staleOf(h, req) {
    return rv.staleEpcs({ known: typeof h.knownValues === 'function' ? h.knownValues() : {}, req, inspect: h.inspect(), now: now() })
  }

  /** 取り直す（履歴は 1 つずつ、ほかは 6 個ずつ）。値は sequencer の state.values と出力 1 に入る（purpose は manual）。 */
  async function refreshValues(seq, epcs) {
    let last = null
    for (const g of rv.refreshGroups(epcs)) last = await seq.get(g, 'manual')
    return last
  }

  // ---------------------------------------------------------------------------
  //  運用設定
  // ---------------------------------------------------------------------------

  /**
   * 運用設定を外した項目に戻す値（設定ノードの値か既定値）。
   * 設定ノードの値は 'E7, E8' のような文字列のことがあるので、そろえてから返す
   * （そのまま setBaseline に渡すと、1 つの EPC として読めずに無視される）。
   */
  function fallbackValue(handle, field) {
    const cfg = normalizeConfigValue(field, handle.configValues ? handle.configValues[field] : null)
    if (cfg !== null) return cfg
    return FIELDS[field] ? FIELDS[field].default : null
  }

  /**
   * 起動時（設定ノードを作るとき）の照合。configAtSet と今の設定ノードの値が違う項目（エディタで後から変えた）を外す。
   * 外したら、wsuha-broute の出力 2 への知らせはデプロイが済む（flows:started）まで待つ
   * （設定ノードは先に作られ、使っているノードはまだ居ない）。SSE には今すぐ知らせる。
   */
  function reconcile(handle) {
    let dropped = []
    try {
      dropped = store.reconcile(handle.id, handle.configValues || {}, EDITOR)
    } catch (err) {
      log('warn', '運用設定を照合できませんでした: ' + err.message)
      return []
    }
    const at = now()
    handle.settingsDropped = dropped.map((d) => Object.assign({ at }, d))
    for (const d of dropped) {
      const label = FIELDS[d.field] ? FIELDS[d.field].label : d.field
      const text =
        `設定ノードの${label}が変わったため（${fmt(d.configAtSet)} → ${fmt(d.configNow)}）、` +
        `運用設定（${fmt(d.value)}）を外しました`
      handle.log('warn', text)
      log('warn', `${handle.meta.name || handle.id}: ${text}`)
    }
    if (dropped.length) handle.settingsChanged(EDITOR, null, { deferNodes: true })
    return dropped
  }

  /** 運用設定があれば sequencer に効かせる（作り直したときにも呼ぶ）。 */
  function applyStored(handle, seq) {
    const rec = store.get(handle.id)
    if (!rec || !seq) return null
    const partial = {}
    for (const [k, f] of Object.entries(rec.fields || {})) partial[k] = f.value
    if (!Object.keys(partial).length) return null
    try {
      return seq.setBaseline(partial)
    } catch (err) {
      log('warn', '運用設定を反映できませんでした: ' + err.message)
      return null
    }
  }

  /** Settings の形。 */
  function settingsOf(handle) {
    const seq = handle.sequencer
    return vm.buildSettings({
      rec: store.get(handle.id),
      configValues: handle.configValues,
      snap: seq ? seq.snapshot() : null,
      options: seq ? seq.options : null,
      enabled: handle.meta.enabled,
      dropped: handle.settingsDropped,
      rev: store.rev(handle.id),
      // 定期取得の候補の「このメーターは持っていません」（作り直しても前の 0x9F を使う）
      supportedEpcs: typeof handle.knownSupportedEpcs === 'function' ? handle.knownSupportedEpcs() : undefined,
    })
  }

  function revOf(handle) {
    return store.rev(handle.id)
  }

  function applyChanges(h, changes) {
    const seq = h.sequencer
    if (!seq) return
    const partial = {}
    for (const [k, v] of Object.entries(changes)) partial[k] = v === null ? fallbackValue(h, k) : v
    if (Object.keys(partial).length) seq.setBaseline(partial)
  }

  /** 照合で外したときの記録（Settings.warnings の元）から、fields の項目を外す。fields が null なら全部。 */
  function dropNotices(h, fields) {
    const list = Array.isArray(h.settingsDropped) ? h.settingsDropped : []
    h.settingsDropped = fields === null ? [] : list.filter((d) => fields.indexOf(d.field) < 0)
  }

  function saveOrThrow(fn) {
    try {
      return fn()
    } catch (err) {
      if (err instanceof RevisionMismatch) throw new ApiError(412, 'REVISION_MISMATCH', err.message)
      log('error', '運用設定を保存できませんでした: ' + err.message)
      throw new ApiError(500, 'INTERNAL', '運用設定を保存できませんでした。Node-RED のログを確かめてください')
    }
  }

  /**
   * 運用設定を保存して効かせる（画面の PUT settings・フローの settings）。
   * @param {object} h      handle
   * @param {object} body   {pollIntervalSec?, pollEpcs?, slowIntervalSec?, halfHourIntervalSec?}（null で外す）
   * @param {object} o      {by, ifMatch?, origin?} ifMatch が undefined なら版を照合しない（フローで msg.rev が無いとき）
   * @returns {object} Settings
   */
  function saveSettings(h, body, o) {
    const opt = o || {}
    const { changes, errors } = validateSettingsInput(body)
    if (Object.keys(errors).length) throw new ApiError(422, 'VALIDATION', '入力を確かめてください', errors)
    const ifMatch = opt.ifMatch === undefined ? store.rev(h.id) : opt.ifMatch
    saveOrThrow(() => store.update(h.id, { ifMatch, changes, configValues: h.configValues, by: opt.by || null }))
    // エディタの照合で外したときの注意は、その項目を保存し直したら消す（残すと、いま効いている値と
    // 「運用設定を外しました」が同時に出る）。ほかの項目の注意は、次に設定ノードを作り直すまで残す
    dropNotices(h, Object.keys(changes))
    applyChanges(h, changes)
    const parts = Object.entries(changes).map(([k, v]) => `${FIELDS[k].label} ${v === null ? '→ 設定ノードの値' : fmt(v)}`)
    h.log('info', `${byLabel(opt.by)}から運用設定を変えました: ${parts.join(' / ')}`)
    h.settingsChanged(opt.by || null, opt.origin || null)
    return settingsOf(h)
  }

  /**
   * 運用設定を全部外す（画面の DELETE settings・フローの settings-reset）。
   * @param {object} o {by, ifMatch?, origin?}
   */
  function clearSettings(h, o) {
    const opt = o || {}
    const ifMatch = opt.ifMatch === undefined ? store.rev(h.id) : opt.ifMatch
    const before = store.get(h.id)
    saveOrThrow(() => store.clear(h.id, { ifMatch, by: opt.by || null }))
    dropNotices(h, null) // 全部外した。照合で外したときの注意も全部消す
    const changes = {}
    for (const k of Object.keys((before && before.fields) || {})) changes[k] = null
    applyChanges(h, changes)
    h.log('info', `${byLabel(opt.by)}から運用設定を全部外しました（設定ノードの値に戻します）`)
    h.settingsChanged(opt.by || null, opt.origin || null)
    return settingsOf(h)
  }

  // ---------------------------------------------------------------------------
  //  構成
  // ---------------------------------------------------------------------------

  function busyReconfiguring() {
    return new ApiError(409, 'BUSY', 'このアダプタは接続し直している途中です。少し待ってから、もう一度試してください')
  }

  /** 効いている構成（画面かフローで保存した値 > 設定ノード > 既定値）。 */
  function effectiveConfigOf(handle) {
    return cf.effectiveConfig(handle.editorConfig || {}, store.getConfig(handle.id).fields)
  }

  /**
   * 「有効」を画面かフローで変えているかを handle.enabledBy に入れる。無ければ null（設定ノードの値）。
   * 健康（health.js）の無効の理由と次の一手と、設定ノードを作ったときのログを、変えた所で分けるため
   * （画面かフローで外した台は、エディタで印を付けてデプロイしても戻らない: configAtSet の後勝ち）。
   * 構成を保存する・全部外す・照合するたびに入れ直す。
   */
  function syncEnabledBy(handle) {
    let f = null
    try {
      f = store.getConfig(handle.id).fields.enabled || null
    } catch (e) {
      f = null
    }
    const runtime = !!f && cf.storedValueOk('enabled', f.value) !== undefined
    handle.enabledBy = runtime ? { source: 'runtime', by: f.by || null, label: f.by ? byLabel(f.by) : null } : null
  }

  /**
   * 起動時（設定ノードを作るとき）の構成の照合。configAtSet と今の設定ノードの値が違う項目（エディタで後から変えた）を外す。
   * handle.editorConfig を先に入れておく。外したら wsuha-broute の出力 2 への知らせは flows:started まで待つ。
   */
  function reconcileConfig(handle) {
    let dropped = []
    try {
      dropped = store.reconcileConfig(handle.id, handle.editorConfig || {}, EDITOR)
    } catch (err) {
      log('warn', '接続の設定を照合できませんでした: ' + err.message)
      handle.configDropped = []
      syncEnabledBy(handle)
      return []
    }
    syncEnabledBy(handle)
    const at = now()
    handle.configDropped = dropped.map((d) => Object.assign({ at }, d))
    for (const d of dropped) {
      const def = cf.CONFIG_FIELDS[d.field]
      const label = def ? def.label : d.field
      const text =
        `設定ノードの${label}が変わったため（${cf.describeConfigValue(d.field, d.configAtSet)} → ${cf.describeConfigValue(d.field, d.configNow)}）、` +
        `Web UI かフローで保存した値（${cf.describeConfigValue(d.field, d.value)}）を外しました`
      handle.log('warn', text)
      log('warn', `${(handle.meta && handle.meta.name) || handle.id}: ${text}`)
    }
    if (dropped.length) handle.configChanged(EDITOR, null, { deferNodes: true })
    return dropped
  }

  /**
   * Config の credentials（値は入れない）。configured は設定ノードが決めた認証情報の形（保存した直後の返事でも、
   * 開き直す前の sequencer ではなく新しい値で答える）。設定ノードの居ない handle は sequencer の値。
   */
  function credentialsOf(h) {
    const seq = h.sequencer
    const snap = seq ? seq.snapshot() : null
    const st = h.credentialState || {}
    const configured = h.credentialState ? !!st.configured : snap && snap.credentials ? !!snap.credentials.configured : false
    let stored = null
    try {
      stored = credStore ? credStore.info(h.id) : null
    } catch (e) {
      stored = null
    }
    return {
      configured,
      source: h.credentialSource === undefined ? null : h.credentialSource,
      pairId: configured ? h.inspect().pairId : null,
      envOverrides: !!st.envOverrides,
      stored,
    }
  }

  /** Config（画面の GET config・フローの get-config・エディタ用）。 */
  function configOf(h) {
    return vm.buildConfig({
      rec: store.getConfig(h.id),
      editor: h.editorConfig,
      credentials: credentialsOf(h),
      applying: !!h.reconfiguring,
      locked: configLocked(),
      lockedReason: CONFIG_LOCKED_MESSAGE,
      dropped: h.configDropped,
      enabled: h.meta.enabled,
    })
  }

  function configRevOf(h) {
    return store.configRev(h.id)
  }

  /** そのポートを開いている（開こうとしている）ほかの台。無ければ null。シミュレータは数えない。 */
  function portUser(port, exceptId) {
    if (!port || port === cf.SIMULATOR_PORT) return null
    const want = portKey(port, realpath)
    for (const other of registry.list()) {
      if (other.id === exceptId) continue
      const m = other.meta || {}
      if (m.enabled === false || m.mode === 'simulator' || !m.port) continue
      if (portKey(m.port, realpath) === want) return other
    }
    return null
  }

  /** 文の中に出す台の名前（displayText。「電力（USB0）」など）。 */
  function nameOfHandle(other) {
    try {
      return vm.displayNameOf(vm.buildSummary(other.inspect(), now()))
    } catch (e) {
      return (other.meta && other.meta.name) || other.id
    }
  }

  /**
   * フローの中で、wsuha-device 以外のノード（serial-port など）が使っているポート。
   * 実体（portKey）→ {id, name, type}。無効のノード（d: true）とシミュレーターは数えない。
   */
  function flowPorts() {
    const out = new Map()
    eachNode((n) => {
      if (!n || n.type === 'wsuha-device' || n.d === true) return
      const sp = typeof n.serialport === 'string' ? n.serialport.trim() : ''
      if (!sp || sp === cf.SIMULATOR_PORT) return
      const key = portKey(sp, realpath)
      if (out.has(key)) return
      const name = typeof n.name === 'string' && n.name.trim() ? n.name.trim() : sp
      out.set(key, { id: String(n.id), name: name.slice(0, 100), type: String(n.type || '') })
    })
    return out
  }

  /** そのポートを使っているフローのノード（無ければ null）。 */
  function flowPortUser(port) {
    if (!port || port === cf.SIMULATOR_PORT) return null
    return flowPorts().get(portKey(port, realpath)) || null
  }

  function checkPortFree(h, next, prev) {
    if (!next.enabled || next.mode !== 'serial' || !next.serialport) return
    // ポート・接続先・有効のどれも変えない保存（名前だけなど）は、今の重なりを理由に断らない
    if (prev && ['serialport', 'mode', 'enabled'].every((k) => cf.sameValue(prev[k], next[k]))) return
    const port = String(next.serialport).slice(0, 120)
    const other = portUser(next.serialport, h ? h.id : null)
    if (other) {
      const who = nameOfHandle(other)
      throw new ApiError(409, 'PORT_IN_USE', `ポート ${port} は「${who}」が使っています。その台のポートを変えるか無効にしてから選んでください`, {
        serialport: `「${who}」が使っています`,
        adapterId: other.id,
      })
    }
    // フローのシリアルのノード（TWELITE の serial-port など）が使っているポート
    const node = flowPortUser(next.serialport)
    if (node) {
      throw new ApiError(
        409,
        'PORT_IN_USE',
        `ポート ${port} はフローのノード「${node.name}」（${node.type}）が使っています。` +
          '違う機器にコマンドを送ると、そのフローが止まることがあります。Wi-SUN アダプタのポートを選び直してください',
        { serialport: `フロー「${node.name}」が使っています`, nodeId: node.id }
      )
    }
  }

  /** デバイスキーの重なり（大文字小文字を区別しない。空は比べない）。 */
  function checkDeviceKeyFree(selfId, key) {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return
    for (const other of registry.list()) {
      if (other.id === selfId) continue
      const ok = String((other.meta && other.meta.deviceKey) || '').trim().toLowerCase()
      if (ok && ok === k) {
        const who = nameOfHandle(other)
        throw new ApiError(
          409,
          'DEVICE_KEY_IN_USE',
          `デバイスキー ${String(key).slice(0, 32)} は「${who}」が使っています。環境変数と秘密ファイルの名前が重なるので、別のキーにするか空にしてください`,
          { deviceKey: `「${who}」が使っています`, adapterId: other.id }
        )
      }
    }
  }

  /**
   * 同じ PairID（認証 ID の下 8 桁）で動いている、ほかの有効な実機の台（シミュレーターは比べない）。
   * 同じメーターに 2 台で PANA 接続すると、後からつないだ方が前の接続を切る。
   */
  function pairUser(pairId, selfId) {
    if (!pairId) return null
    for (const other of registry.list()) {
      if (other.id === selfId) continue
      const m = other.meta || {}
      if (m.enabled === false || m.mode === 'simulator') continue
      let pid = null
      try {
        pid = other.inspect().pairId
      } catch (e) {
        pid = null
      }
      if (pid && String(pid).toUpperCase() === pairId) return other
    }
    return null
  }

  function checkPairFree(selfId, pairId, field) {
    const other = pairUser(pairId, selfId)
    if (!other) return
    const who = nameOfHandle(other)
    throw new ApiError(
      409,
      'PAIR_IN_USE',
      `同じ認証 ID を「${who}」が使っています。同じメーターに 2 台でつなぐと、互いの接続を切り合います。使っている台を無効にしてから入れてください`,
      { [field || 'routeBId']: `「${who}」と同じ認証 ID です`, adapterId: other.id }
    )
  }

  /**
   * 構成を変えたあとに効く認証 ID の PairID（PUT config でデバイスキー・接続先・有効を変えるとき）。
   * 環境変数（その接尾辞か、接尾辞の無いもの）> 画面かフローで保存した値 > 今の値（環境変数でなければ変わらない）。
   * 環境変数が外れて設定ノードの値になるときは、値がここから見えないので null（比べない）。
   */
  function pairAfterConfig(h, next) {
    const e = envCredentialsOf(next.deviceKey, env())
    if (e) return pairIdOf(e.id)
    let stored = null
    try {
      stored = credStore ? credStore.read(h.id) : null
    } catch (err) {
      stored = null
    }
    if (stored && stored.id) return pairIdOf(stored.id)
    const cs = h.credentialState || {}
    if (cs.envOverrides) return null
    try {
      const pid = h.inspect().pairId
      return pid ? String(pid).toUpperCase() : null
    } catch (err) {
      return null
    }
  }

  /**
   * 組み合わせの検証: 有効でシリアルなのにポートが無い構成は、保存する前に 422 で断る。
   * そのまま開き直すと SerialTransport が作れず、sequencer の無い台が残る（画面の config-model.js の fieldError と同じ規則）。
   * ポート・接続先・有効のどれも変えない保存（名前だけなど）は、設定ノードの値が既にその形でも断らない（画面も差分の項目だけを確かめる）。
   * 全部外す（clearConfig）には掛けない（設定ノードの値に戻せなくならないように）。
   */
  function checkPortGiven(next, prev) {
    if (next.enabled === false || next.mode !== 'serial' || String(next.serialport || '').trim()) return
    if (prev && ['serialport', 'mode', 'enabled'].every((k) => cf.sameValue(prev[k], next[k]))) return
    throw new ApiError(422, 'VALIDATION', '入力を確かめてください', {
      serialport: '接続先が Wi-SUN アダプタ（実機）のときは、ポートを選ぶか入力してください',
    })
  }

  function saveConfigOrThrow(fn) {
    try {
      return fn()
    } catch (err) {
      if (err instanceof RevisionMismatch) throw new ApiError(412, 'REVISION_MISMATCH', err.message)
      log('error', '接続の設定を保存できませんでした: ' + err.message)
      throw new ApiError(500, 'INTERNAL', '接続の設定を保存できませんでした。Node-RED のログを確かめてください')
    }
  }

  /** 照合で外した注意（Config.warnings の元）から、fields の項目を外す。null なら全部。 */
  function dropConfigNotices(h, fields) {
    const list = Array.isArray(h.configDropped) ? h.configDropped : []
    h.configDropped = fields === null ? [] : list.filter((d) => fields.indexOf(d.field) < 0)
  }

  function startReconfigure(h, next, by) {
    try {
      const p = h.reconfigure(next, { by })
      if (p && typeof p.catch === 'function') p.catch((err) => log('warn', '接続の設定を反映できませんでした: ' + (err && err.message)))
    } catch (err) {
      log('warn', '接続の設定を反映できませんでした: ' + (err && err.message))
    }
  }

  /**
   * 構成を保存して効かせる（画面の PUT config・フローの config）。
   * 検証（422）→ 版（412）→ 開き直しの最中（409 BUSY）→ 組み合わせ（422。シリアルでポートなし）→ ほかの台のポート（409 PORT_IN_USE）
   * → 保存 → 効かせる。
   * 接続に関わる項目が変わったら、その台だけ裏で開き直す（PUT はすぐ返し、Config.applying が true になる）。
   * @param {object} o {by, ifMatch?, origin?} ifMatch が undefined なら版を照合しない（フローで msg.rev が無いとき）
   */
  function saveConfig(h, body, o) {
    const opt = o || {}
    const { changes, errors } = cf.validateConfigInput(body)
    if (Object.keys(errors).length) throw new ApiError(422, 'VALIDATION', '入力を確かめてください', errors)
    const cur = store.configRev(h.id)
    const ifMatch = opt.ifMatch === undefined ? cur : opt.ifMatch
    if (ifMatch === null || String(ifMatch) !== cur) throw new ApiError(412, 'REVISION_MISMATCH', 'ほかの場所で先に変更されました。読み直してください')
    if (h.reconfiguring) throw busyReconfiguring()
    const prev = effectiveConfigOf(h)
    const nextStored = store.getConfig(h.id).fields
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete nextStored[k]
      else nextStored[k] = { value: v }
    }
    const next = cf.effectiveConfig(h.editorConfig || {}, nextStored)
    checkPortGiven(next, prev)
    checkPortFree(h, next, prev)
    // デバイスキーの重なり（変えたときだけ）と、同じ認証 ID の台（デバイスキー・接続先・有効を変えて、効く認証情報が変わりうるとき）
    if (!cf.sameValue(prev.deviceKey, next.deviceKey)) checkDeviceKeyFree(h.id, next.deviceKey)
    const pairField = ['deviceKey', 'mode', 'enabled'].filter((k) => !cf.sameValue(prev[k], next[k]))[0]
    if (pairField && next.enabled !== false && next.mode === 'serial') checkPairFree(h.id, pairAfterConfig(h, next), pairField)
    saveConfigOrThrow(() => store.updateConfig(h.id, { ifMatch, changes, configValues: h.editorConfig || {}, by: opt.by || null }))
    syncEnabledBy(h)
    dropConfigNotices(h, Object.keys(changes))
    const parts = Object.entries(changes).map(([k, v]) => {
      const label = cf.CONFIG_FIELDS[k].label
      return `${label} ${v === null ? '→ 設定ノードの値' : cf.describeConfigValue(k, v)}`
    })
    h.log('info', `${byLabel(opt.by)}から接続の設定を変えました: ${parts.join(' / ')}`)
    startReconfigure(h, next, opt.by || null)
    h.configChanged(opt.by || null, opt.origin || null)
    return configOf(h)
  }

  /** 構成を全部外して設定ノードの値に戻す（画面の DELETE config・フローの config-reset）。 */
  function clearConfig(h, o) {
    const opt = o || {}
    const cur = store.configRev(h.id)
    const ifMatch = opt.ifMatch === undefined ? cur : opt.ifMatch
    if (ifMatch === null || String(ifMatch) !== cur) throw new ApiError(412, 'REVISION_MISMATCH', 'ほかの場所で先に変更されました。読み直してください')
    if (h.reconfiguring) throw busyReconfiguring()
    const prev = effectiveConfigOf(h)
    const next = cf.effectiveConfig(h.editorConfig || {}, {})
    checkPortFree(h, next, prev)
    saveConfigOrThrow(() => store.clearConfig(h.id, { ifMatch, by: opt.by || null }))
    syncEnabledBy(h)
    dropConfigNotices(h, null)
    h.log('info', `${byLabel(opt.by)}から接続の設定を全部外しました（設定ノードの値に戻します）`)
    startReconfigure(h, next, opt.by || null)
    h.configChanged(opt.by || null, opt.origin || null)
    return configOf(h)
  }

  function requireCredStore() {
    if (!credStore) throw new ApiError(503, 'PORT_DOWN', '認証情報を保存する場所を用意できていません（Node-RED のログを確かめてください）')
  }

  /**
   * B ルート認証情報を保存する（画面の PUT credentials・フローの credentials）。**値は返さない・ログに出さない**。
   * 効いている値が変わったら（環境変数が優先されていなければ）、その台だけ開き直す。
   * @returns {object} Config の credentials（{configured, source, pairId, envOverrides, stored}）
   */
  function saveCredentials(h, body, o) {
    const opt = o || {}
    const v = validateCredentialsInput(body)
    if (Object.keys(v.errors).length) throw new ApiError(422, 'VALIDATION', '入力を確かめてください', v.errors)
    requireCredStore()
    if (h.reconfiguring) throw busyReconfiguring()
    // 同じ認証 ID で動いているほかの実機の台。環境変数が優先される台では、保存しても効く値は変わらない
    const m = h.meta || {}
    if (m.enabled !== false && m.mode !== 'simulator' && !envCredentialsOf(m.deviceKey, env())) checkPairFree(h.id, pairIdOf(v.id), 'routeBId')
    try {
      credStore.write(h.id, { id: v.id, password: v.password, by: opt.by || null, editorFingerprint: h.editorFingerprint })
    } catch (err) {
      log('error', `認証情報を保存できませんでした（${err.code || 'ERROR'}）`)
      throw new ApiError(500, 'INTERNAL', '認証情報を保存できませんでした。Node-RED のログを確かめてください')
    }
    h.log('info', `${byLabel(opt.by)}から B ルートの認証 ID とパスワードを保存しました（値は記録しません）`)
    startReconfigure(h, null, opt.by || null)
    h.configChanged(opt.by || null, opt.origin || null)
    return credentialsOf(h)
  }

  /**
   * 画面かフローで保存した値を消したあとに効く出どころの文（ログ用。値は入れない）。
   * 環境変数が優先されていれば変わらない。エディタの値があればそれ。どちらも無ければ秘密ファイルか、認証情報なし
   */
  function afterClearText(h) {
    const cs = h.credentialState || {}
    if (cs.envOverrides) return '環境変数が優先されているので、効いている値は変わりません'
    let editor = 'none'
    try {
      editor = typeof h.editorFingerprint === 'function' ? h.editorFingerprint('') : 'none'
    } catch (e) {
      editor = 'none'
    }
    if (editor !== 'none') return '設定ノードの値に戻します'
    // シミュレーターは認証情報がどこにも無くても架空の値で動く（wsuha-device の resolveCredentials）
    const last = h.meta && h.meta.mode === 'simulator' ? 'シミュレーターの架空の値に戻ります' : '認証情報なしになります'
    return `設定ノードの値も空なので、秘密ファイルがあればそれを使い、無ければ${last}`
  }

  /** 画面かフローで保存した認証情報を消す（画面の DELETE credentials・フローの credentials-reset）。 */
  function clearCredentials(h, o) {
    const opt = o || {}
    requireCredStore()
    if (h.reconfiguring) throw busyReconfiguring()
    let removed = false
    try {
      removed = credStore.remove(h.id)
    } catch (err) {
      log('error', `認証情報を消せませんでした（${err.code || 'ERROR'}）`)
      throw new ApiError(500, 'INTERNAL', '認証情報を消せませんでした。Node-RED のログを確かめてください')
    }
    if (removed) {
      h.log('info', `${byLabel(opt.by)}から、画面かフローで保存した B ルートの認証 ID とパスワードを消しました（${afterClearText(h)}）`)
      startReconfigure(h, null, opt.by || null)
      h.configChanged(opt.by || null, opt.origin || null)
    }
    return credentialsOf(h)
  }

  /**
   * ポートの候補（画面の GET serialports・フローの serialports・エディタの 🔍）。
   * - 機器（実体）ごとに 1 件。path は by-id があればそれ、同じ実体のほかの名前（ttyUSB0 など）は aliases。by-id を先に。
   * - kind（'wsuha'|'maybe'|'other'）と hint（classifyPort。判定はここの 1 か所）。
   * - usedBy: 使っている台（{kind: 'adapter', id, name: 「電力（USB0）」, type: 'wsuha-device'}）か、
   *   フローのシリアルのノード（{kind: 'flow', id, name, type: 'serial-port' など}）。無ければ null。
   *   ownedBy（{id, name}。使っている台）は前の形のまま残す。
   * - シミュレーターの候補を最後に 1 つ（simulator: true。画面は接続先で選ぶので候補から外す）。
   * - serialportAvailable（読み込めるか）と serialportMessage（読み込めないときの案内。読めれば null）。
   */
  async function serialPorts() {
    let list = []
    try {
      list = typeof p.listPorts === 'function' ? await p.listPorts() : await require('../serial-transport').SerialTransport.candidates()
    } catch (err) {
      list = []
    }
    // 機器（実体）ごとにまとめる（候補の並びの順を保つ）
    const groups = new Map()
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || typeof x.path !== 'string' || !x.path || x.path === cf.SIMULATOR_PORT) continue
      const key = portKey(typeof x.realPath === 'string' && x.realPath ? x.realPath : x.path, realpath)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(x)
    }
    const fp = flowPorts()
    const items = []
    for (const [key, g] of groups) {
      const primary = g.filter((x) => x.byId)[0] || g[0]
      const pick = (k) => {
        for (const x of [primary].concat(g)) if (x && x[k]) return String(x[k])
        return ''
      }
      const realPath = typeof primary.realPath === 'string' && primary.realPath ? primary.realPath : primary.path
      const aliases = []
      for (const x of g) {
        for (const pth of [x.path, x.realPath, x.byIdPath]) {
          if (typeof pth === 'string' && pth && pth !== primary.path && aliases.indexOf(pth) < 0) aliases.push(pth)
        }
      }
      const owner = portUser(primary.path, null)
      const node = owner ? null : fp.get(key) || null
      const usedBy = owner
        ? { kind: 'adapter', id: owner.id, name: nameOfHandle(owner), type: 'wsuha-device' }
        : node
          ? { kind: 'flow', id: node.id, name: node.name, type: node.type }
          : null
      const texts = [primary.label || ''].concat(g.map((x) => x.path))
      const c = classifyPort({ texts, manufacturer: pick('manufacturer'), vendorId: pick('vendorId'), usedByAdapter: !!owner })
      items.push({
        path: primary.path,
        label: typeof primary.label === 'string' ? primary.label : primary.path,
        manufacturer: pick('manufacturer'),
        serialNumber: pick('serialNumber'),
        vendorId: pick('vendorId'),
        productId: pick('productId'),
        byId: !!primary.byId,
        realPath,
        byIdPath: typeof primary.byIdPath === 'string' ? primary.byIdPath : primary.byId ? primary.path : null,
        // 一覧と見出しと同じ短い名前（USB0 など）。画面は「USB0 — FTDI（by-id）」の形で出す
        portLabel: cf.portLabelOf('serial', primary.path, realPath),
        simulator: false,
        ownedBy: owner ? { id: owner.id, name: (owner.meta && owner.meta.name) || owner.id } : null,
        kind: c.kind,
        hint: c.hint,
        usedBy,
        aliases,
      })
    }
    items.push({
      path: cf.SIMULATOR_PORT,
      label: 'シミュレーター（実機なしで試す）',
      manufacturer: '',
      serialNumber: '',
      vendorId: '',
      productId: '',
      byId: false,
      realPath: cf.SIMULATOR_PORT,
      byIdPath: null,
      portLabel: 'シミュレーター',
      simulator: true,
      ownedBy: null,
      kind: 'other',
      hint: null,
      usedBy: null,
      aliases: [],
    })
    const ready = await serialportReady()
    // serialport を読み込めないと実機の候補が 0 件になる。利用者が機器を疑わないように、理由を別の項目で返す
    return { items, at: now(), serialportAvailable: ready, serialportMessage: ready ? null : SERIALPORT_MESSAGE }
  }

  /** serialport を読み込めるか。確かめられないときは読めるものとして扱う（候補の欄に誤った案内を出さない）。 */
  async function serialportReady() {
    try {
      const check = typeof p.serialportAvailable === 'function' ? p.serialportAvailable : require('../serial-transport').SerialTransport.available
      return typeof check === 'function' ? !!(await check()) : true
    } catch (err) {
      return true
    }
  }

  // ---------------------------------------------------------------------------
  //  アダプタの追加
  // ---------------------------------------------------------------------------

  let adding = false

  function waitClaim(id, ms) {
    return new Promise((resolve) => {
      const until = Date.now() + ms
      const tick = () => {
        const h = registry.get(id)
        if (h && h.claimed) return resolve(true)
        if (Date.now() >= until) return resolve(false)
        const t = setTimeout(tick, 50)
        if (t.unref) t.unref()
      }
      tick()
    })
  }

  /**
   * アダプタ（設定ノードと B ルートノード）を 1 台足す（画面の POST adapters・フローの add-adapter）。
   * 画面の守り（BAD_HOST・415・BAD_ORIGIN・認証・READ_ONLY・CONFIG_LOCKED・64 KB）は http-api.js が先に掛ける。ここでは掛けない。
   * @param {object} body {role, name?, mode?, serialport, serialbaud?, deviceKey?, expectedMac?, autoStart?, routeBId?, routeBPassword?}
   * @param {object} [o] {by: 'web-ui' | 'flow:<名前>', ip?: string（監査に残す接続元）, reqLog?: {user, path, ip}（画面の要求の控え。
   *   誰が flows.json を変えたかを監査に残す。フローの入力には無い）, origin?: そのノード}
   * @returns {Promise<object>} {ok: true, message, adapter: AdapterDetail|null, nodes: {deviceId, brouteId, tabId, tabLabel, tabCreated},
   *   started: boolean, warnings: string[]}
   *   画面の HTTP の状態は started で決まる（true = 201 動き出した、false = 202 フローには足したが、まだ動いていない）
   * @throws {ApiError} 422 VALIDATION / 503 NOT_AVAILABLE / 409 FLOWS_LOCKED・LIMIT_REACHED・PORT_IN_USE・DEVICE_KEY_IN_USE・
   *   PAIR_IN_USE・BUSY / 500 INTERNAL（パスは入れない）
   */
  async function addAdapter(body, o) {
    const opt = o || {}
    const by = opt.by || null
    // 1. 検証（知らない項目・形・認証情報の片方だけ）
    const v = cf.validateAddInput(body)
    const errors = Object.assign({}, v.errors)
    let cred = null
    if (v.credentials) {
      const c = validateCredentialsInput(v.credentials)
      for (const [k, why] of Object.entries(c.errors)) errors[k] = why
      if (!Object.keys(c.errors).length) cred = { id: c.id, password: c.password }
    }
    if (Object.keys(errors).length || !v.value) throw new ApiError(422, 'VALIDATION', '入力を確かめてください', errors)
    const value = v.value
    // 2. 使えるか
    if (!flowWriter) throw new ApiError(503, 'NOT_AVAILABLE', '画面からの追加の仕組みを用意できていません（Node-RED のログを確かめてください）')
    const av = flowWriter.availability()
    if (!av.available) throw new ApiError(av.code === 'FLOWS_LOCKED' ? 409 : 503, av.code || 'NOT_AVAILABLE', av.reason || '画面からの追加は使えません')
    if (cred) requireCredStore()
    // 3. 台数（無効の台も数える）
    if (deviceCount() >= ADD_LIMIT) {
      throw new ApiError(409, 'LIMIT_REACHED', `アダプタは ${ADD_LIMIT} 台までです（無効の台も数えます）。使っていない台をエディタで消してから追加してください`)
    }
    // 4. ポート（ほかの台とフローのノード）
    if (value.mode === 'serial') checkPortFree(null, { enabled: true, mode: 'serial', serialport: value.serialport }, null)
    // 5. デバイスキー
    checkDeviceKeyFree(null, value.deviceKey)
    // 6. 同じ認証 ID（効く認証情報。接尾辞の無い環境変数を含む）
    const envCred = envCredentialsOf(value.deviceKey, env())
    const effId = envCred ? envCred.id : cred ? cred.id : null
    if (value.mode === 'serial') checkPairFree(null, pairIdOf(effId), cred && !envCred ? 'routeBId' : 'deviceKey')
    // 7. 1 本ずつ
    if (adding) throw new ApiError(409, 'BUSY', '前の追加がまだ終わっていません。終わってからもう一度押してください')
    adding = true
    try {
      return await writeAdapter(value, cred, envCred, by, opt)
    } finally {
      adding = false
    }
  }

  async function writeAdapter(value, cred, envCred, by, opt) {
    const deviceId = flowWriter.newId()
    let brouteId = flowWriter.newId()
    while (brouteId === deviceId) brouteId = flowWriter.newId()
    // 1. 認証情報（エディタの値は空なので、控えの指紋 credAtSet は 'none'。あとでエディタで入れたらエディタが勝つ）
    let credWritten = false
    if (cred) {
      try {
        credStore.write(deviceId, { id: cred.id, password: cred.password, by, editorId: null, editorPassword: null })
        credWritten = true
      } catch (err) {
        log('error', `認証情報を保存できませんでした（${err.code || 'ERROR'}）`)
        throw new ApiError(500, 'INTERNAL', 'アダプタを追加できませんでした（認証情報を保存できません）。Node-RED のログを確かめてください')
      }
    }
    // 2. フローに足す（名前は空のまま。シミュレーターの PairID は入れた認証 ID に従うので、固定の値を書かない。
    //    書くと、あとで認証情報を変えた台がメーターを見つけられなくなる）
    let added
    try {
      added = await flowWriter.add({
        deviceId,
        brouteId,
        tabId: store.webUiTabId(),
        reqLog: opt.reqLog,
        device: {
          name: value.name,
          enabled: true,
          role: value.role,
          mode: value.mode,
          serialport: value.mode === 'simulator' ? '' : value.serialport,
          serialbaud: value.serialbaud,
          deviceKey: value.deviceKey,
          expectedMac: value.expectedMac,
          autoStart: value.autoStart,
          simulatorOptions: '',
        },
        broute: {},
      })
    } catch (err) {
      if (credWritten) {
        try {
          credStore.remove(deviceId)
        } catch (e) {
          log('warn', `追加できなかった台の認証情報を消せませんでした（${e.code || 'ERROR'}）`)
        }
      }
      throw err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', 'アダプタを追加できませんでした（フローを保存できません）。Node-RED のログを確かめてください')
    }
    // 3. 足した印（settings.json）。書けなくても台は残す
    const at = now()
    try {
      store.markCreated(deviceId, { by, at, brouteId: added.brouteId, tabId: added.tabId })
    } catch (err) {
      log('warn', '追加した台の記録を settings.json に書けませんでした（台はフローに入っています）: ' + err.message)
    }
    // 4. 動き出す（設定ノードが registry に載る）まで待つ。フローが止まっていれば待たない
    const state = typeof flowWriter.flowsState === 'function' ? flowWriter.flowsState() : null
    const claimed = state === 'stop' ? false : await waitClaim(deviceId, TO.addClaim)
    // 5. 監査（adapterId・brouteId・by・ip と、画面からなら Node-RED が足す user・path。本文は入れない）
    audit('adapter.add', { adapterId: deviceId, brouteId: added.brouteId, by, ip: opt.ip || null }, opt.reqLog || null)
    const h = claimed ? registry.get(deviceId) : null
    const adapter = h ? detailOf(h) : null
    const warnings = []
    if (envCred) {
      warnings.push(
        cred
          ? `環境変数（WSUHA_BROUTE_ID${envCred.suffixed ? '_' + String(value.deviceKey).toUpperCase() : ''}）が設定されているため、画面で入れた認証情報は効きません`
          : `認証 ID とパスワードは環境変数（WSUHA_BROUTE_ID${envCred.suffixed ? '_' + String(value.deviceKey).toUpperCase() : ''}）の値を使います`
      )
    }
    if (value.name) {
      const same = registry.list().filter((x) => x.id !== deviceId && x.meta && x.meta.name === value.name)
      if (same.length) warnings.push(`同じ名前「${value.name}」の台があります`)
    }
    if (added.tabDisabled) warnings.push(`置き場所のタブ「${added.tabLabel}」が無効です。エディタでタブを有効にすると出力が流れます`)
    const display = adapter
      ? vm.displayNameOf(adapter)
      : vm.displayNameOf({ name: value.name, named: !!value.name, role: value.role, portLabel: cf.portLabelOf(value.mode, value.serialport) })
    const nodes = { deviceId, brouteId: added.brouteId, tabId: added.tabId, tabLabel: added.tabLabel, tabCreated: !!added.tabCreated }
    const text = `${byLabel(by)}からアダプタを追加しました（フローのタブ「${added.tabLabel}」）`
    if (h) h.log('info', text)
    log('info', `${display} (${deviceId}): ${text}`)
    if (claimed) {
      return { ok: true, message: `「${display}」を追加しました`, adapter, nodes, started: true, warnings }
    }
    return {
      ok: true,
      message: state === 'stop' ? 'フローには追加しました。Node-RED のフローが止まっているため、まだ動いていません' : 'フローには追加しました。動き出すのを待っています',
      adapter,
      nodes,
      started: false,
      warnings,
    }
  }

  // ---------------------------------------------------------------------------
  //  診断
  // ---------------------------------------------------------------------------

  /** 入力と状態を確かめる（何も送らない）。 */
  function prepareDiag(h, body) {
    const plan = planDiag(body)
    const seq = requireUsable(h)
    if (plan.epcs) requireMeter(seq)
    else requirePort(seq)
    return { plan, seq }
  }

  /**
   * 診断を送る。
   * @param {object} o {by, startGet?(seq, fn)} startGet は電波の取得の始め方（画面は 1 台 1 本の枠を通す）
   * @returns {Promise<object>} diagPayload の形（{ok:true, name, at, result:{lines, values?}} に出力の項目を足したもの）。
   *   SK コマンドが失敗したとき（FAIL ER06・応答なし）は、投げる例外の err.diag に ok:false の同じ形を付ける
   *   （フローの出力 2 に diag の ok:false として出すため。画面の API は今までどおり 502 などで返す）
   */
  async function executeDiag(h, prepared, o) {
    const opt = o || {}
    const { plan, seq } = prepared
    const out = { lines: [] }
    const steps = []
    if (plan.commands) {
      for (const cmd of plan.commands) {
        try {
          const r = await withTimeout(seq.diagRead(cmd), TO.diag, cmd)
          const ls = r.lines.map((l) => h.redact(l))
          for (const l of ls) out.lines.push(l)
          steps.push(outputs.commandStep(cmd, ls, true))
        } catch (err) {
          const ls = err && Array.isArray(err.lines) ? err.lines.map((l) => h.redact(l)) : []
          for (const l of ls) out.lines.push(l)
          steps.push(outputs.commandStep(cmd, ls, false, err))
          if (err && typeof err === 'object') err.diag = diagPayload(h, plan, out, steps, now(), false)
          throw err
        }
      }
    } else {
      const start = () => seq.get(plan.epcs, 'diag')
      const r = await withTimeout(typeof opt.startGet === 'function' ? opt.startGet(seq, start) : start(), TO.get, '取得')
      out.values = vm.valueRowsFromValues(h.inspect(), r && r.values, now())
      // 定時積算は display から確定の時刻を分けてあるので、診断の行には足し直す（メーターの時計を確かめる場面でもある）
      for (const v of out.values) {
        out.lines.push(`${v.epc.slice(2)} ${v.name}: ${v.display}${typeof v.meterAt === 'number' ? `（確定 ${vm.stampText(v.meterAt)}）` : ''}`)
      }
    }
    h.log('info', `${byLabel(opt.by)}から診断「${plan.name}」を実行しました`)
    return diagPayload(h, plan, out, steps, now(), true)
  }

  /** 診断を 1 回（フローの入力。3 秒の制限は掛けない）。 */
  async function runDiag(h, body, o) {
    return executeDiag(h, prepareDiag(h, body), o)
  }

  return {
    adapter,
    requireUsable,
    requirePort,
    requireMeter,
    detailOf,
    summaries,
    listAdapters,
    trendOf,
    logsOf,
    metaOf,
    readOf,
    staleOf,
    refreshValues,
    readOnly,
    configLocked,
    fallbackValue,
    reconcile,
    applyStored,
    settingsOf,
    revOf,
    saveSettings,
    clearSettings,
    // 構成
    effectiveConfigOf,
    reconcileConfig,
    configOf,
    configRevOf,
    credentialsOf,
    saveConfig,
    clearConfig,
    saveCredentials,
    clearCredentials,
    serialPorts,
    portUser,
    flowPortUser,
    credStore,
    // アダプタの追加
    addAdapter,
    addAdapterMeta,
    deviceCount,
    addLocked: () => isAddLocked(settingsNow()),
    prepareDiag,
    executeDiag,
    runDiag,
    TO,
  }
}

module.exports = {
  createService,
  ApiError,
  mapError,
  withTimeout,
  parseEpcList,
  planDiag,
  parseRange,
  parseLogQuery,
  totalOf,
  editorRootOf,
  isReadOnly,
  isConfigLocked,
  isAddLocked,
  CONFIG_LOCKED_MESSAGE,
  ADD_LOCKED_MESSAGE,
  ADD_LIMIT,
  SEQ_CODES,
  classifyPort,
  portKey,
  byLabel,
  fmt,
  diagPayload,
  SREG_ALLOWED,
  TABLE_ALLOWED,
  RANGES,
  WEB_UI,
  EDITOR,
}
