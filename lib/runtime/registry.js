'use strict'

// ============================================================================
//  registry と AdapterHandle（プロセスに 1 つ）
// ============================================================================
//
//  設定ノード（wsuha-device）1 つにつき AdapterHandle を 1 つ持つ。id は設定ノードの id。
//
//  handle は **sequencer を作り直しても同じオブジェクト**のまま残る。
//  wsuha-broute ノード・SSE・HTTP API は sequencer ではなく handle を購読するので、
//  「どちらが先に作られたか」（register の順序）に頼らずに、再デプロイしても値が届き続ける。
//
//    設定ノード ──attach(seq)──▶ AdapterHandle ──on('measurement' …)──▶ wsuha-broute
//                                     │                 ├─ 'settings' {by, origin}（運用設定が変わった。出力 2 へ）
//                                     │                 └─ 'config' {by, origin}（構成が変わった。出力 2 へ）
//                                     ├─ 構成の変更を効かせる関数（設定ノードの reconfigure）と、開き直しの最中か（reconfiguring）
//                                     ├─ 一時的な上書き（停止・取得間隔・EPC）の持ち越し: detach で写し、次の attach で当て直す
//                                     │   （デプロイをまたいで残り、Node-RED の再起動で消える。設定ノードを削除したら捨てる）
//                                     ├─ logs のリング（1,000 件・連番）
//                                     ├─ trend のリング（E7・E8 を 24 時間。10 秒に 1 点まで）
//                                     ├─ 預かりの待ち行列（pending。フローの入力の get・command などを、つながるまで預かる）
//                                     ├─ いま分かっている値の写し（knownValues。作り直しても前の値で read に答える）
//                                     └─ registry へ 'changed' / 'measurement' / 'logRow' / 'settings' / 'config' を中継（SSE が読む）
//
//  ここは Node-RED に依存しない（RED を受け取らない）。

const { EventEmitter } = require('events')
const crypto = require('crypto')
const { DEFAULTS } = require('../sequencer')
const { portLabelOf } = require('./config-fields')
const { createPendingQueue } = require('./pending')

let LIB_VERSION = 'unknown'
try {
  LIB_VERSION = require('../../package.json').version
} catch (e) {
  /* 単体で使われた場合 */
}

/** sequencer から wsuha-broute へそのまま中継するイベント。'error' は中継しない（受け手が居ないと投げるため）。 */
const FORWARD = ['measurement', 'status', 'phase', 'log', 'sk', 'raw', 'mismatch', 'connected', 'device', 'meter', 'calibration', 'table', 'edscan']
/** registry に「この 1 台が変わった」と知らせるイベント。 */
const CHANGES = ['status', 'phase', 'device', 'meter', 'calibration', 'connected', 'mismatch']

const LOG_RING = 1000
const TREND_SPAN_MS = 24 * 3600 * 1000
const TREND_STEP_MS = 10 * 1000
const LOG_LEVELS = ['debug', 'info', 'good', 'warn', 'error']
const LOG_RANK = { debug: 0, info: 1, good: 1, warn: 2, error: 3 }
const MAX_TEXT = 2000

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * sequencer の一時的な上書き（state.overrides）を写す。どれも掛かっていなければ null。
 * @returns {{stopped: object|null, pollIntervalSec: number|null, pollEpcs: number[]|null}|null}
 */
function readOverrides(seq) {
  const o = seq && seq.state && seq.state.overrides
  if (!o) return null
  const c = {
    stopped: o.stopped && typeof o.stopped === 'object' ? Object.assign({}, o.stopped) : null,
    pollIntervalSec: typeof o.pollIntervalSec === 'number' && isFinite(o.pollIntervalSec) ? o.pollIntervalSec : null,
    pollEpcs: Array.isArray(o.pollEpcs) && o.pollEpcs.length ? o.pollEpcs.slice() : null,
  }
  return c.stopped || c.pollIntervalSec !== null || c.pollEpcs ? c : null
}

function cloneOverrides(c) {
  return {
    stopped: c.stopped ? Object.assign({}, c.stopped) : null,
    pollIntervalSec: c.pollIntervalSec,
    pollEpcs: c.pollEpcs ? c.pollEpcs.slice() : null,
  }
}

/** ログに出す上書きの中身（例: 「停止: 点検中 / 取得間隔 60 秒」）。 */
function describeOverrides(c) {
  const parts = []
  if (c.stopped) parts.push('停止: ' + String(c.stopped.reason || '外部の指示').slice(0, 200))
  if (c.pollIntervalSec !== null) parts.push(`取得間隔 ${c.pollIntervalSec} 秒`)
  if (c.pollEpcs) {
    const hex = c.pollEpcs.map((n) => (typeof n === 'number' ? n.toString(16).toUpperCase().padStart(2, '0') : String(n)))
    parts.push('定期的に取りに行く値 ' + hex.join(', '))
  }
  return parts.join(' / ')
}

function mapLevel(level) {
  if (LOG_LEVELS.indexOf(level) >= 0) return level
  if (level === 'tx' || level === 'rx' || level === 'trace') return 'debug'
  return 'info'
}

class AdapterHandle extends EventEmitter {
  constructor(id, registry) {
    super()
    this.setMaxListeners(0)
    this.id = String(id)
    this._registry = registry
    this.createdAt = Date.now()
    // 今の記録の始まり（このプロセスで最初に claim した時刻）。推移はこの handle が持つので、これより前の時間に記録はない。
    // 接続先を変えて推移を捨てたら、その時刻に進める（forgetSupported）
    this.recordingSince = null
    this.meta = {
      name: this.id,
      named: false,
      role: null,
      deviceKey: '',
      enabled: true,
      mode: 'serial',
      port: '',
      portLabel: '',
      expectedMac: null,
    }
    this.credentialSource = null
    this.configValues = {}
    this.settingsDropped = []
    this._pendingSettings = null
    // 構成: エディタの設定ノードの値（そろえたもの）と、照合で外した項目
    this.editorConfig = {}
    this.configDropped = []
    this._pendingConfig = null
    // 「有効」を画面かフローで変えているか（{source: 'runtime', by, label}。設定ノードの値なら null）。service が入れる
    this.enabledBy = null
    // 認証情報の状態（値は持たない）: {configured, pairId, envOverrides}。設定ノードが入れる
    this.credentialState = null
    // 構成を効かせる関数（設定ノードが入れる）と、開き直しの最中か
    this._reconfigure = null
    this.reconfiguring = false
    this.buildError = null
    this._owner = null
    this._seq = null
    this._fwd = null
    // 一時的な上書き（停止・取得間隔・EPC）の持ち越し。sequencer を外すときに写し、次に付けたものへ当て直す。
    // 寿命: デプロイをまたいで残り、Node-RED の再起動（registry が新しくなる）で消える
    this._carry = null
    this._consumers = new Set()
    // 秘密はプロパティに置かない（JSON にしても出ないように、閉じ込めた関数で持つ）
    let secretRe = null
    let pairId = null
    // 伏せ字にする値。構成の変更で認証情報が変わったあとも、前の値を伏せ続ける（足すだけ。12 個まで）
    let secretList = []
    // 効いている認証 ID の指紋（このプロセスだけの塩つきの sha256。値そのものは持たない）。undefined = まだ一度も受け取っていない。
    // 認証 ID が変わった（別の契約 = 別のメーターに繋がりうる）かを、エディタのデプロイの道（claim）でも見るため
    let credKey
    const credSalt = crypto.randomBytes(16).toString('hex')
    const keyOf = (id) => {
      const v = typeof id === 'string' ? id.trim().toUpperCase() : ''
      return v ? crypto.createHash('sha256').update(credSalt + '\n' + v).digest('hex') : 'none'
    }
    /** 認証 ID が前に受け取ったものと違えば true（初めてなら false）。指紋は入れ替える。 */
    this._credentialIdChanged = (id) => {
      const next = keyOf(id)
      const changed = credKey !== undefined && credKey !== next
      credKey = next
      return changed
    }
    this._setSecrets = (list, id, opts) => {
      const vals = (list || []).filter((s) => typeof s === 'string' && s.length >= 4)
      const keep = opts && opts.keep ? secretList : []
      secretList = keep.concat(vals.filter((v) => keep.indexOf(v) < 0)).slice(-12)
      // 長いものから当てる（短い値が長い値の一部を先に伏せて、残りが見えないように）
      const sorted = secretList.slice().sort((a, b) => b.length - a.length)
      secretRe = sorted.length ? new RegExp(sorted.map(escapeRe).join('|'), 'gi') : null
      pairId = typeof id === 'string' && /^[0-9A-Fa-f]{32}$/.test(id.trim()) ? id.trim().slice(-8).toUpperCase() : null
    }
    // エディタの設定ノードの認証情報の指紋を作る関数（credentials-store の credAtSet。値は閉じ込めたまま）
    let editorFingerprint = null
    this._setEditorFingerprint = (fn) => {
      editorFingerprint = typeof fn === 'function' ? fn : null
    }
    this.editorFingerprint = (salt) => (editorFingerprint ? editorFingerprint(salt) : 'none')
    this.redact = (text) => {
      if (text === null || text === undefined) return text
      const s = String(text)
      return secretRe ? s.replace(secretRe, '********') : s
    }
    this._pairId = () => pairId
    this._logs = []
    this._logSeq = 0
    this._trend = [] // [ts, W|null, R|null, T|null]
    // 前の sequencer で取れていた値（{meterAddr, values}）。作り直した sequencer がまだ取っていない値を read に出すため
    this._carriedValues = null
    // 認証情報が変わって忘れたときに付いていた sequencer（前の契約）。その値とマップは read に出さず、detach でも写さない
    this._forgottenSeq = null
    // 接続の段階が変わった回数（phase のイベントと attach で増える）。預かりのやり直しを「つなぎ直したあと」にするため
    this.phaseEpoch = 0
    // 相が connected になったときの sequencer とその世代（{seq, gen}）。reconnect() の直後は世代だけが先に変わり、
    // 相はまだ connected に見えるので、預かり（pending.js）がこれと今の世代を比べる
    this.connectedGen = null
    // 預かり。sequencer を作り直しても同じもの（デプロイをまたいで続く）。状態が変わるたびに見直す（_changed）
    this.pending = createPendingQueue({
      handle: this,
      log: (level, text) => this.log(level, text),
      onChange: () => this._changed(),
    })
  }

  // --- 持ち主（設定ノード） ---------------------------------------------------

  /** 設定ノードがこの handle を使い始める。meta・秘密（伏せ字用）・設定ノードの値を受け取る。 */
  claim(owner, info) {
    const i = info || {}
    this._owner = owner || true
    if (this.recordingSince === null) this.recordingSince = Date.now()
    if (i.meta) this.meta = Object.assign({}, this.meta, i.meta)
    this.credentialSource = i.credentialSource === undefined ? this.credentialSource : i.credentialSource
    this.configValues = i.configValues || {}
    this.settingsDropped = []
    this.buildError = null
    if (i.secrets) this._setSecrets(i.secrets, i.credentialId)
    // エディタで認証 ID を変えてデプロイした（別の契約）: 前のメーターの値の写しとプロパティマップを捨てる。
    // 画面とフローの変更（wsuha-device.js の _reconfigure）は updateInfo と forgetSupported() で捨てる。
    // そのときは前の sequencer がまだ付いているので、forgetSupported() はその sequencer の値を「前の契約のもの」と印を付け、
    // 閉じるときの detach でも写さない（写し直すと、read が前の契約の値を fresh で返す）
    if (Object.prototype.hasOwnProperty.call(i, 'credentialId') && this._credentialIdChanged(i.credentialId)) this.forgetSupported()
    if (typeof i.onListenerError === 'function') this._onListenerError = i.onListenerError
    // 構成。照合で外した項目（configDropped）は、作るたびに service.reconcileConfig が入れ直す
    if (i.editorConfig) this.editorConfig = Object.assign({}, i.editorConfig)
    this.credentialState = i.credentialState ? Object.assign({}, i.credentialState) : null
    this._reconfigure = typeof i.reconfigure === 'function' ? i.reconfigure : null
    this._setEditorFingerprint(i.editorFingerprint)
    this.reconfiguring = false
    this._changed()
  }

  /**
   * 構成の変更を効かせたあとに、設定ノードが表示と伏せ字の値を入れ直す（claim のように持ち主や注意は消さない）。
   * 秘密（secrets）は足すだけ（前の認証情報も、古いログの写しなどから出ないように伏せ続ける）。
   */
  updateInfo(info) {
    const i = info || {}
    if (i.meta) this.meta = Object.assign({}, this.meta, i.meta)
    if (i.credentialSource !== undefined) this.credentialSource = i.credentialSource
    if (i.credentialState !== undefined) this.credentialState = i.credentialState ? Object.assign({}, i.credentialState) : null
    if (i.secrets) this._setSecrets(i.secrets, i.credentialId, { keep: true })
    if (Object.prototype.hasOwnProperty.call(i, 'credentialId') && this._credentialIdChanged(i.credentialId)) this.forgetSupported()
    this._changed()
  }

  /**
   * 構成（と認証情報）の変更を効かせる。設定ノードの関数（claim の reconfigure）に渡す。
   * 設定ノードが居ない（試験の handle など）ときは、表示（meta）だけを入れ直す。
   * @param {object|null} next 新しく効く構成（config-fields の effectiveConfig）。null は認証情報だけが変わった
   * @param {object} [info] {by}
   */
  reconfigure(next, info) {
    if (this._reconfigure) {
      try {
        return this._reconfigure(next, info || {})
      } catch (err) {
        this._listenerError(err)
        return null
      }
    }
    if (next) this.updateInfo({ meta: metaFromConfig(next, this.id) })
    return null
  }

  /** 開き直しの最中かを入れる（設定ノードが呼ぶ）。終わったら構成が変わったとして知らせる（Config.applying）。 */
  setReconfiguring(on) {
    const v = !!on
    if (this.reconfiguring === v) return
    this.reconfiguring = v
    if (this._registry) this._registry._relay('config', this.id)
    this._changed()
  }

  /**
   * 設定ノードが閉じた。removed なら registry から外す候補にする（flows:started で片付ける）。
   * removed（設定ノードを削除した）なら、持ち越していた一時的な上書きも捨てる。
   * @returns {{text: string}|null} 捨てた上書き（呼んだ側が Node-RED のログに 1 行残す）
   */
  release(owner, removed) {
    if (this._owner !== owner && owner !== undefined) return null
    this._owner = null
    this.removed = !!removed
    let dropped = null
    // 設定ノードを削除した: 預かっていたものは、もうどの sequencer でも実行できない
    if (removed && this.pending) this.pending.shutdown('設定ノード（Wi-SUN アダプタ）を削除したため、預かっていた指示を取りやめました')
    if (removed && this._carry) {
      dropped = { overrides: this._carry, text: '設定ノードを削除したため、一時的な上書き（' + describeOverrides(this._carry) + '）も外しました' }
      this._carry = null
    }
    this._changed()
    return dropped
  }

  /** 次に付ける sequencer へ当て直す、一時的な上書き（無ければ null）。読むだけ（試験と診断用）。 */
  get carriedOverrides() {
    return this._carry ? cloneOverrides(this._carry) : null
  }

  get claimed() {
    return !!this._owner
  }

  // --- sequencer --------------------------------------------------------------

  get sequencer() {
    return this._seq
  }

  /**
   * sequencer を付ける。前の sequencer で掛かっていた一時的な上書き（停止・取得間隔・EPC）があれば当て直す。
   * Node-RED の既定のデプロイ（全体）は設定ノードも作り直すので、当て直さないと「点検中」で止めた台が
   * 関係の無い変更のデプロイで黙って動き出す。停止を当て直した sequencer は start しない（wsuha-device.js の _open）。
   * @returns {{overrides: object, text: string}|null} 当て直したもの（呼んだ側が Node-RED のログに 1 行残す）
   */
  attach(seq) {
    if (this._seq === seq) return null
    if (this._seq) this.detach(this._seq)
    this._seq = seq
    this.phaseEpoch++ // 新しい sequencer（作り直し）も段階の変化に数える
    this.connectedGen = seq && seq.state && seq.state.phase === 'connected' ? { seq, gen: seq.generation } : null
    this.buildError = null
    const fwd = {}
    for (const name of FORWARD) {
      fwd[name] = (payload) => this._onSeqEvent(name, payload)
    }
    this._fwd = fwd
    for (const name of FORWARD) seq.on(name, fwd[name])
    let carried = null
    try {
      carried = this._restoreOverrides(seq)
    } catch (err) {
      this._listenerError(err)
    }
    this._changed()
    return carried
  }

  /**
   * このメーターが持っている EPC（Get プロパティマップ 0x9F。'0xE7' の形）。
   * sequencer を作り直したあと（デプロイ・構成の変更）も、新しい sequencer が 0x9F を読むまでは前の値を返す
   * （画面の「このメーターは持っていません」が作り直しのたびに消えて、SSE の settings が出直さないように）。
   * まだ一度も読めていなければ空。forgetSupported() で忘れる（別のメーターに繋ぎ直すとき）。
   */
  knownSupportedEpcs() {
    // 忘れた（認証情報が変わった）あとの前の sequencer のマップは、前のメーターのもの。入れ直さない
    const st = this._seq && this._seq !== this._forgottenSeq && this._seq.state
    const list = st && Array.isArray(st.supportedEpcs) ? st.supportedEpcs : null
    if (list && list.length) {
      this._supported = list.map((n) => (typeof n === 'number' ? '0x' + ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2) : String(n)))
    }
    return this._supported ? this._supported.slice() : []
  }

  /**
   * 前のメーター（前の契約）のプロパティマップと値の写しと推移を忘れる（認証情報が変わって、別のメーターに繋ぎ直すとき）。
   * いま付いている sequencer（閉じる前の前の契約のもの）の値とマップも、read と画面に出さず、detach でも写さない。
   */
  forgetSupported() {
    this._supported = null
    // 別のメーター（別の契約）に繋ぎ直す: 前のメーターの値も read に出さない
    this._carriedValues = null
    // 前のメーターの点を今のメーターの推移に混ぜない。記録の始まりも進める（捨てた時間を、画面が途切れに数えないように）
    this._trend = []
    if (this.recordingSince !== null) this.recordingSince = Date.now()
    this._forgottenSeq = this._seq || null
  }

  /**
   * いま分かっている値（EPC の '0xE7' → sequencer の state.values の 1 件 {epc, name, value, unit, display, at, …}）。
   * 今の sequencer の値に、作り直す前の sequencer で取れていた値（まだ取り直していないもの）を足す（read が使う）。
   * 前の値は、今のメーターのアドレスが分かっていて前のものと違えば使わない（別のメーター）。値の写しを返す（書き換えない）。
   */
  knownValues() {
    // 忘れた（認証情報が変わった）前の sequencer の値は、前の契約のもの。出さない
    const st = this._seq && this._seq !== this._forgottenSeq && this._seq.state
    const cur = st && st.values && typeof st.values === 'object' ? st.values : {}
    const out = {}
    const c = this._carriedValues
    const addr = st && st.meter ? st.meter.addr : null
    if (c && c.values && (!addr || !c.meterAddr || c.meterAddr === addr)) {
      for (const k of Object.keys(c.values)) out[k] = c.values[k]
    }
    for (const k of Object.keys(cur)) out[k] = cur[k]
    return out
  }

  /** seq を渡したときは、それが今の sequencer のときだけ外す（古い sequencer の後片付けで今のを外さない）。 */
  detach(seq) {
    if (!this._seq) return
    if (seq && seq !== this._seq) return
    const s = this._seq
    if (this._forgottenSeq === s) {
      // 認証情報が変わった（forgetSupported のあと）: 前の契約の値とマップは写さない
      this._forgottenSeq = null
    } else {
      this.knownSupportedEpcs() // 覚えてから外す
      // いま分かっている値を写しておく（次に付ける sequencer がまだ取っていない値を read に出す）
      try {
        const vals = this.knownValues()
        const addr = s.state && s.state.meter ? s.state.meter.addr : null
        const carriedAddr = this._carriedValues ? this._carriedValues.meterAddr : null
        this._carriedValues = Object.keys(vals).length ? { meterAddr: addr || carriedAddr || null, values: vals } : this._carriedValues
      } catch (err) {
        this._listenerError(err)
      }
    }
    // 一時的な上書きを写しておく（次に付ける sequencer へ当て直す）。上書きが無ければ持ち越さない
    this._carry = readOverrides(s)
    const fwd = this._fwd || {}
    for (const name of FORWARD) {
      if (fwd[name]) s.removeListener(name, fwd[name])
    }
    this._seq = null
    this._fwd = null
    this._changed()
  }

  /**
   * 持ち越した上書きを、付けたばかりの sequencer に掛ける。
   * 取得間隔・EPC は外部の上書きとして（基準 = 設定ノードと運用設定の値は変えない。auto で戻る）、
   * 停止は外部の指示の停止として（理由と止めた時刻はそのまま）。アダプタのログに warn で 1 行残す。
   */
  _restoreOverrides(seq) {
    const c = this._carry
    this._carry = null
    if (!c) return null
    if (c.pollIntervalSec !== null && typeof seq.setPollInterval === 'function') {
      seq.setPollInterval(c.pollIntervalSec, { external: true })
    }
    if (c.pollEpcs && c.pollEpcs.length && typeof seq.setPollEpcs === 'function') {
      seq.setPollEpcs(c.pollEpcs, { external: true })
    }
    if (c.stopped && typeof seq.stop === 'function') {
      // stop は async だが、外部の指示の停止は待たずに状態まで変わる（まだ start していない sequencer）
      const p = seq.stop(c.stopped.reason, { external: true })
      if (p && typeof p.catch === 'function') p.catch((err) => this._listenerError(err))
      const now = seq.state && seq.state.overrides ? seq.state.overrides.stopped : null
      if (now && typeof c.stopped.at === 'number') now.at = c.stopped.at
    }
    const text =
      'デプロイの前に掛かっていた一時的な上書きを引き継ぎました（' +
      describeOverrides(c) +
      '）。' +
      (c.stopped
        ? '自動運転に戻すには、Web UI の「開始」か「自動運転に戻す」を押すか、フローの start か auto を送ってください'
        : '設定どおりに戻すには、Web UI の「自動運転に戻す」を押すか、フローの auto を送ってください') +
      '（Node-RED を再起動しても外れます）'
    this.log('warn', text)
    return { overrides: cloneOverrides(c), text }
  }

  setBuildError(err) {
    this.buildError = err ? { message: String(err.message || err), at: Date.now() } : null
    this._changed()
  }

  snapshot() {
    return this._seq ? this._seq.snapshot() : null
  }

  // --- 使っているノード（数を出すだけ。開閉には使わない） -------------------

  addConsumer(c) {
    const before = this._consumers.size
    this._consumers.add(c)
    if (this._consumers.size !== before) this._changed()
  }

  removeConsumer(c) {
    if (this._consumers.delete(c)) this._changed()
  }

  get consumers() {
    return this._consumers.size
  }

  // --- イベント ---------------------------------------------------------------

  _onSeqEvent(name, payload) {
    try {
      if (name === 'log') {
        const entry = payload || {}
        const text = this.redact(entry.text)
        this._pushLog(entry.level, text, entry.ts)
        this._safeEmit('log', Object.assign({}, entry, { text }))
        return
      }
      if (name === 'raw') {
        this._safeEmit('raw', this.redact(payload))
        return
      }
      // 接続の段階が変わった回数（預かりのやり直しは、失敗のあとに段階が変わってから = つなぎ直してから）
      if (name === 'phase') {
        this.phaseEpoch++
        // 相が connected になったときの世代（預かりが reconnect() の直後を見分ける）
        if (payload && payload.to === 'connected' && this._seq) this.connectedGen = { seq: this._seq, gen: this._seq.generation }
      }
      if (name === 'measurement') this._recordTrend(payload)
      this._safeEmit(name, payload)
      if (name === 'measurement' && this._registry) this._registry._relay('measurement', this.id, payload)
      if (CHANGES.indexOf(name) >= 0) this._changed()
    } catch (err) {
      this._listenerError(err)
    }
  }

  /** 受け手の 1 つが投げても、ほかの受け手と sequencer の手順を止めない。 */
  _safeEmit(name, ...args) {
    const ls = this.listeners(name)
    for (const fn of ls) {
      try {
        fn.apply(this, args)
      } catch (err) {
        this._listenerError(err)
      }
    }
  }

  _listenerError(err) {
    try {
      if (this._onListenerError) this._onListenerError(err)
    } catch (e) {
      /* 知らせる先でも失敗したら諦める */
    }
  }

  _changed() {
    if (this._registry) this._registry._relay('changed', this.id)
    // 預かり: つながった・止めた・無効にした・作り直した、のどれでも見直す
    if (this.pending) {
      try {
        this.pending.kick()
      } catch (err) {
        this._listenerError(err)
      }
    }
  }

  /**
   * sequencer が status を出さない変化（setPollInterval・setPollEpcs の一時的な上書き）を知らせる。
   * SSE が adapter と settings を出し直す。
   */
  notifyChanged() {
    this._changed()
  }

  /**
   * 運用設定が変わったことを知らせる。
   *   - registry の 'settings'（SSE が読む）
   *   - handle の 'settings' {by, origin}（wsuha-broute が購読し、出力 2 に settings を出す）
   * by は変えた経路（'web-ui'・'flow:<名前>'・'editor'）。origin はフローの入力で変えたときのそのノード
   * （そのノードは入力の msg で返事をするので、購読の側では出さない）。
   * opts.deferNodes なら、wsuha-broute への知らせは flushSettingsNotice() まで待つ
   * （エディタで外したとき。設定ノードを作っている途中で、使っているノードがまだ作られていない）。
   */
  settingsChanged(by, origin, opts) {
    if (this._registry) this._registry._relay('settings', this.id)
    const ev = { by: by || null, origin: origin || null }
    if (opts && opts.deferNodes) this._pendingSettings = ev
    else this._safeEmit('settings', ev)
    this._changed()
  }

  /** 待たせていた運用設定の知らせを wsuha-broute へ出す（デプロイが済んだとき = flows:started）。 */
  flushSettingsNotice() {
    const ev = this._pendingSettings
    if (!ev) return false
    this._pendingSettings = null
    this._safeEmit('settings', ev)
    return true
  }

  /**
   * 構成（と認証情報の出どころ）が変わったことを知らせる。settingsChanged と同じ規則:
   *   - registry の 'config'（SSE が読む）
   *   - handle の 'config' {by, origin}（wsuha-broute が出力 2 に config を出す。origin のノードは自分の返事で済ませる）
   *   - opts.deferNodes なら wsuha-broute への知らせは flushConfigNotice() まで待つ（エディタの照合で外したとき）
   */
  configChanged(by, origin, opts) {
    if (this._registry) this._registry._relay('config', this.id)
    const ev = { by: by || null, origin: origin || null }
    if (opts && opts.deferNodes) this._pendingConfig = ev
    else this._safeEmit('config', ev)
    this._changed()
  }

  flushConfigNotice() {
    const ev = this._pendingConfig
    if (!ev) return false
    this._pendingConfig = null
    this._safeEmit('config', ev)
    return true
  }

  // --- logs -------------------------------------------------------------------

  /** ログのリングに 1 行足す（設定ノード・API からの記録にも使う）。 */
  log(level, text) {
    const t = this.redact(text)
    this._pushLog(level, t, Date.now())
  }

  _pushLog(level, text, ts) {
    let s = text === null || text === undefined ? '' : String(text)
    if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT) + '…'
    const row = { seq: ++this._logSeq, at: typeof ts === 'number' ? ts : Date.now(), level: mapLevel(level), text: s }
    this._logs.push(row)
    if (this._logs.length > LOG_RING) this._logs.splice(0, this._logs.length - LOG_RING)
    if (this._registry) this._registry._relay('logRow', this.id, row)
    return row
  }

  get lastLogSeq() {
    return this._logSeq
  }

  /**
   * @param {object} q {after, limit, level} level は info / warn / error（その重さ以上）
   * @returns {{items, nextSeq, dropped}}
   */
  logsAfter(q) {
    let after = Math.max(0, Math.floor(Number(q && q.after) || 0))
    // 再起動で連番が戻った（受け手の after の方が新しい）ときは、最初から渡し直す
    if (after > this._logSeq) after = 0
    const limit = Math.max(1, Math.min(LOG_RING, Number(q && q.limit) || 200))
    const min = q && q.level ? LOG_RANK[q.level] : 0
    const items = []
    const oldest = this._logs.length ? this._logs[0].seq : this._logSeq + 1
    const dropped = after > 0 && after + 1 < oldest ? oldest - after - 1 : 0
    let nextSeq = after
    for (const row of this._logs) {
      if (row.seq <= after) continue
      if (items.length >= limit) break
      nextSeq = row.seq
      if (LOG_RANK[row.level] >= min) items.push(Object.assign({}, row))
    }
    if (nextSeq < after) nextSeq = after
    return { items, nextSeq, dropped }
  }

  // --- trend ------------------------------------------------------------------

  _recordTrend(result) {
    if (!result || !Array.isArray(result.values)) return
    // 忘れたあと（forgetSupported）に、閉じる前の sequencer が出した前のメーターの値は入れない
    if (this._seq && this._seq === this._forgottenSeq) return
    // 診断（Web UI の「任意の EPC」・プロパティマップ）で取った値は推移に入れない。
    // 計測値の表（snapshot().known）と SSE の measurement には出る
    if (result.purpose === 'diag') return
    let w = null
    let r = null
    let t = null
    for (const v of result.values) {
      if (!v) continue
      if (v.epc === 0xe7 && typeof v.value === 'number' && isFinite(v.value)) w = v.value
      if (v.epc === 0xe8 && v.value && typeof v.value === 'object') {
        if (typeof v.value.r === 'number') r = v.value.r
        if (typeof v.value.t === 'number') t = v.value.t
      }
    }
    // 受信の強さ（応答のたびに sequencer が更新する）。無ければ null（線を描かない）
    const snap = this._seq && typeof this._seq.snapshot === 'function' ? this._seq.snapshot() : null
    const q = snap && snap.meter && typeof snap.meter.lqi === 'number' ? snap.meter.lqi : null
    // E7・E8 の無い応答でも LQI は残す（定期取得を積算だけにした台でも、電波の推移を空にしないため）。電力の系列は trend() が null の点を除く
    if (w === null && r === null && t === null && q === null) return
    const ts = typeof result.ts === 'number' ? result.ts : Date.now()
    const last = this._trend.length ? this._trend[this._trend.length - 1] : null
    if (last && Math.floor(last[0] / TREND_STEP_MS) === Math.floor(ts / TREND_STEP_MS)) {
      // 同じ 10 秒の枠: 後の値で上書きし、届いていない系列は前の値を残す
      last[0] = ts
      if (w !== null) last[1] = w
      if (r !== null) last[2] = r
      if (t !== null) last[3] = t
      // LQI は枠の中の最小を残す（手動の取得が重なっても、落ち込みを後の値で消さない）
      if (q !== null) last[4] = typeof last[4] === 'number' ? Math.min(last[4], q) : q
    } else {
      this._trend.push([ts, w, r, t, q])
    }
    const limit = ts - TREND_SPAN_MS
    let drop = 0
    while (drop < this._trend.length && this._trend[drop][0] < limit) drop++
    if (drop) this._trend.splice(0, drop)
  }

  /**
   * @param {number} rangeMs 1h / 6h / 24h
   * @param {number} [now]
   * @param {number} [maxPoints] 1 系列の点数の上限（既定 720）
   */
  trend(rangeMs, now, maxPoints) {
    const to = typeof now === 'number' ? now : Date.now()
    const from = to - rangeMs
    const cap = maxPoints || 720
    const pts = this._trend.filter((p) => p[0] >= from && p[0] <= to)
    const series = (idx) => decimate(pts.filter((p) => p[idx] !== null).map((p) => [p[0], p[idx]]), cap)
    // LQI は枠の中の最小を残す（落ち込みを隠さない）
    const lqi = decimateMin(pts.filter((p) => typeof p[4] === 'number').map((p) => [p[0], p[4]]), cap)
    return { series: { power: series(1), currentR: series(2), currentT: series(3), lqi }, from, to }
  }

  // --- view-model への入力 ----------------------------------------------------

  /** view-model が読む入力。秘密は入れない（pairId は ID の下 8 桁 = 電波にも出る値）。 */
  inspect() {
    const seq = this._seq
    const o = seq ? seq.options : null
    return {
      id: this.id,
      meta: Object.assign({}, this.meta),
      consumers: this._consumers.size,
      snap: seq ? seq.snapshot() : null,
      phaseSince: seq && seq.state ? seq.state.phaseSince : this.createdAt,
      options: o
        ? {
            pollIntervalSec: o.pollIntervalSec,
            pollEpcs: o.pollEpcs,
            slowIntervalSec: o.slowIntervalSec,
            halfHourIntervalSec: o.halfHourIntervalSec,
            slowEpcs: o.slowEpcs,
            halfHourEpcs: o.halfHourEpcs,
            onceEpcs: o.onceEpcs,
          }
        : null,
      pairId: this._pairId(),
      credentialSource: this.credentialSource,
      // 設定ノードが決めた認証情報の状態（値は含まない）。sequencer の無い台（無効・初期化の失敗）でも答えるため
      credentialState: this.credentialState
        ? { configured: !!this.credentialState.configured, envOverrides: !!this.credentialState.envOverrides }
        : null,
      buildError: this.buildError,
      enabledBy: this.enabledBy ? Object.assign({}, this.enabledBy) : null,
      recordingSince: this.recordingSince,
      // 預かっている数と、いちばん古いものの待ち時間（pendingCommands）
      pending: this.pending ? this.pending.stats() : { count: 0, oldestMs: null },
      libVersion: LIB_VERSION,
      redact: this.redact,
    }
  }
}

/**
 * 効いている構成（config-fields の effectiveConfig）から、一覧と詳細に出す meta を作る。
 * 名前は 名前 → 契約 → ポート → id の順（設定ノードと同じ。出力の device を変えないため、代わりの値のまま残す）。
 * named は、設定ノードか画面・フローで名前を入れたか（画面は named でなければポートの短い名前を出す）。
 */
function metaFromConfig(eff, id) {
  const e = eff || {}
  const sim = e.mode === 'simulator'
  const port = sim ? 'simulator' : e.serialport || ''
  return {
    name: e.name || e.role || port || String(id),
    named: typeof e.name === 'string' && e.name.trim() !== '',
    role: e.role || null,
    deviceKey: e.deviceKey || '',
    enabled: e.enabled !== false,
    mode: sim ? 'simulator' : 'serial',
    port,
    portLabel: portLabelOf(sim ? 'simulator' : 'serial', port),
    expectedMac: e.expectedMac || null,
  }
}

/** 間引く。n 点を cap 点以下にまとめる（各まとまりの最後の時刻・平均値）。 */
function decimate(points, cap) {
  if (points.length <= cap) return points
  const size = Math.ceil(points.length / cap)
  const out = []
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size)
    let sum = 0
    for (const p of chunk) sum += p[1]
    out.push([chunk[chunk.length - 1][0], Math.round((sum / chunk.length) * 10) / 10])
  }
  return out
}

/** 点を cap 個までに減らす。枠の中でいちばん小さい値を残す。 */
function decimateMin(points, cap) {
  if (points.length <= cap) return points
  const size = Math.ceil(points.length / cap)
  const out = []
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size)
    let min = chunk[0][1]
    for (const p of chunk) if (p[1] < min) min = p[1]
    out.push([chunk[chunk.length - 1][0], min])
  }
  return out
}

class Registry extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(0)
    this.startedAt = Date.now()
    this._handles = new Map()
  }

  /** id の handle を返す。無ければ作る。 */
  upsert(id) {
    const key = String(id)
    let h = this._handles.get(key)
    if (!h) {
      h = new AdapterHandle(key, this)
      this._handles.set(key, h)
      this._relay('added', key)
    }
    return h
  }

  get(id) {
    return this._handles.get(String(id)) || null
  }

  /** 設定ノードが居る handle だけ（一覧・API に出すもの）。 */
  list() {
    return Array.from(this._handles.values()).filter((h) => h.claimed)
  }

  all() {
    return Array.from(this._handles.values())
  }

  remove(id) {
    const h = this._handles.get(String(id))
    if (!h) return false
    if (h.sequencer) h.detach()
    this._handles.delete(String(id))
    this._relay('removed', String(id))
    return true
  }

  /** フローから消えた handle（設定ノードが居ない）を片付ける。flows:started で呼ぶ。 */
  prune() {
    const gone = []
    for (const h of this._handles.values()) {
      if (!h.claimed) gone.push(h.id)
    }
    for (const id of gone) this.remove(id)
    return gone
  }

  _relay(type, id, payload) {
    try {
      this.emit(type, id, payload)
    } catch (err) {
      /* SSE などの受け手の失敗で、計測の流れを止めない */
    }
  }
}

let singleton = null

/** プロセスに 1 つの registry。 */
function getRegistry() {
  if (!singleton) singleton = new Registry()
  return singleton
}

/** 試験用。独立した registry を作る。 */
function createRegistry() {
  return new Registry()
}

module.exports = {
  getRegistry,
  createRegistry,
  Registry,
  AdapterHandle,
  FORWARD,
  readOverrides,
  describeOverrides,
  metaFromConfig,
  LOG_RING,
  TREND_STEP_MS,
  TREND_SPAN_MS,
  LIB_VERSION,
  DEFAULTS,
}
