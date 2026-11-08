'use strict'

// ============================================================================
//  シリアルポート transport
// ============================================================================
//
//  Sequencer が期待する契約:
//    open()  → Promise      ポートを開く (開いていれば何もしない)
//    close() → Promise      閉じる
//    write(Buffer) → Promise
//    イベント: 'line' (Buffer, CR を含まない) / 'open' / 'close' / 'error'
//
//  serialport は遅延 require にしてある。
//  シミュレーターだけ使いたい環境や、ネイティブモジュールのビルドが
//  通っていない環境でも、このファイルを読み込むだけでは落ちないようにするため。

const { EventEmitter } = require('events')
const { LineSplitter } = require('./line-splitter')

const DEFAULT_PORT_OPTIONS = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  // RS-WSUHA (FTDI) はフロー制御なし。ハードウェアフロー制御を有効にすると
  // 相手が CTS を上げないため送信が止まる。
  rtscts: false,
  xon: false,
  xoff: false,
}

/** serialport の本体を読み込む。v10 以降は名前付き export。読み込めなければ投げる。 */
function loadSerialPort() {
  const sp = require('serialport')
  return sp.SerialPort || sp
}

/**
 * serialport が読み込めないときの失敗。
 * require の文言は Require stack の絶対パスを含む複数行で、ログインの無い画面と API に出る。
 * 利用者に見せるのは次の一手だけにして、原文は detail に分ける (Sequencer が Node-RED のログだけへ出す)。
 */
function serialportMissing(cause) {
  const e = new Error(
    'serialport を読み込めません。パレットからこのノードを入れ直すか、userDir で npm install serialport@12 を実行して、Node-RED を再起動してください'
  )
  e.code = 'SERIALPORT_MISSING'
  e.detail = cause && cause.message ? String(cause.message) : null
  return e
}

class SerialTransport extends EventEmitter {
  /**
   * @param {object} config { path, baudRate, reconnectMs, autoReconnect }
   */
  constructor(config) {
    super()
    this.config = Object.assign({ reconnectMs: 5000, autoReconnect: true }, config || {})
    if (!this.config.path) throw new Error('ポートが未設定です。設定ノードか Web UI の「アダプタと接続」で、ポートを選ぶか入力してください')
    this.port = null
    this._splitter = new LineSplitter({
      onOverflow: (n) => this.emit('error', new Error(`区切り文字（CR）の無いデータが ${n} バイトたまったので捨てました`)),
    })
    this._reconnectTimer = null
    this._wantOpen = false
    this._opening = null
    this._lastOpenError = null // 自動の開き直しで最後に知らせた失敗の文
  }

  get isOpen() {
    return !!(this.port && this.port.isOpen)
  }

  open() {
    if (this.isOpen) return Promise.resolve()
    if (this._opening) return this._opening
    this._wantOpen = true

    // 同期の失敗は、_opening を持つ前に返す。Promise の中で null にしても、外の代入で
    // 失敗した Promise が残り、以後の open() がずっと同じ失敗を返していた
    let SerialPort
    try {
      SerialPort = loadSerialPort()
    } catch (err) {
      return Promise.reject(serialportMissing(err))
    }

    const opts = Object.assign({}, DEFAULT_PORT_OPTIONS, {
      path: this.config.path,
      baudRate: Number(this.config.baudRate) || DEFAULT_PORT_OPTIONS.baudRate,
      autoOpen: false,
    })

    let port
    try {
      port = new SerialPort(opts)
    } catch (err) {
      return Promise.reject(err)
    }

    this._opening = new Promise((resolve, reject) => {
      port.on('data', (chunk) => {
        for (const line of this._splitter.push(chunk)) this.emit('line', line)
      })
      port.on('error', (err) => this.emit('error', err))
      port.on('close', () => {
        this._splitter.reset()
        this.emit('close')
        this._scheduleReconnect()
      })

      port.open((err) => {
        this._opening = null
        if (err) {
          this._scheduleReconnect()
          return reject(err)
        }
        // 開いている途中で close() された (再デプロイと開き直しが重なった)。
        // ここで受け取ると、閉じる者のいないポートが残り、ロックで次の設定ノードが二度と開けない。
        if (!this._wantOpen) {
          port.close(() => {})
          return reject(new Error('閉じる指示が先に来たため、開いたポートを閉じました'))
        }
        this.port = port
        this._lastOpenError = null
        this._splitter.reset()
        this.emit('open')
        resolve()
      })
    })
    return this._opening
  }

  close() {
    this._wantOpen = false
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    return new Promise((resolve) => {
      if (!this.isOpen) return resolve()
      this.port.close(() => resolve())
    })
  }

  write(buffer) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) return reject(new Error('シリアルポートが開いていません'))
      this.port.write(buffer, (err) => {
        if (err) return reject(err)
        // drain まで待つ。待たないと、SKSENDTO のデータ部が
        // 途中までしか出ていない状態で次の処理に進むことがある。
        this.port.drain((derr) => (derr ? reject(derr) : resolve()))
      })
    })
  }

  _scheduleReconnect() {
    if (!this._wantOpen || !this.config.autoReconnect) return
    if (this._reconnectTimer) return
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this._wantOpen) return
      // 開き直しは 5 秒ごとなので、毎回知らせると 1 日 1 万 7 千行になり、抜ける前の原因の行がログから流れる。
      // 文が変わったときだけ知らせる。続いていることは Sequencer が間隔を伸ばしながら知らせる
      this.open().catch((err) => {
        if (err.message !== this._lastOpenError) this.emit('error', err)
        this._lastOpenError = err.message
      })
    }, this.config.reconnectMs)
  }

  /**
   * 画面とエディタのポートの候補。`/dev/serial/by-id/…` を先に、そのあとに serialport が列挙したポート。
   * by-id の名前は USB の差し直しや起動の順で変わらない (ttyUSB0 / ttyUSB1 は入れ替わる) ので、こちらを勧める。
   * @param {object} [deps] 試験で差し替える {list: async () => ports, byIdDir, fs}
   * @returns {Promise<Array<{path, label, manufacturer, serialNumber, vendorId, productId, byId: boolean, realPath, byIdPath}>>}
   *   byId は path が by-id のリンクか。realPath はリンクの先 (読めなければ path のまま)。byIdPath は、そのポートを指す by-id のリンク
   */
  static async candidates(deps) {
    const d = deps || {}
    const fsx = d.fs || require('fs')
    const byIdDir = d.byIdDir === undefined ? '/dev/serial/by-id' : d.byIdDir
    let ports = []
    try {
      ports = await (typeof d.list === 'function' ? d.list() : SerialTransport.list())
    } catch (err) {
      ports = []
    }
    if (!Array.isArray(ports)) ports = []
    const real = (p) => {
      try {
        return fsx.realpathSync(p)
      } catch (e) {
        return p
      }
    }
    const infoOf = new Map()
    for (const p of ports) if (p && p.path) infoOf.set(real(p.path), p)
    let links = []
    if (byIdDir) {
      try {
        links = fsx.readdirSync(byIdDir).filter((n) => typeof n === 'string' && n && n[0] !== '.').sort()
      } catch (e) {
        links = [] // by-id が無い (Windows・USB のポートが無い Linux)
      }
    }
    const pick = (p) => ({
      manufacturer: (p && p.manufacturer) || '',
      serialNumber: (p && p.serialNumber) || '',
      vendorId: (p && p.vendorId) || '',
      productId: (p && p.productId) || '',
    })
    const out = []
    const linkOf = new Map()
    for (const name of links) {
      const link = byIdDir.replace(/\/+$/, '') + '/' + name
      const target = real(link)
      if (!linkOf.has(target)) linkOf.set(target, link)
      const base = String(target).split(/[\\/]/).pop()
      out.push(
        Object.assign({ path: link, label: `${name} (${base})` }, pick(infoOf.get(target)), { byId: true, realPath: target, byIdPath: link })
      )
    }
    for (const p of ports) {
      if (!p || !p.path) continue
      const target = real(p.path)
      out.push(
        Object.assign({ path: p.path, label: p.path + (p.manufacturer ? ' — ' + p.manufacturer : '') }, pick(p), {
          byId: false,
          realPath: target,
          byIdPath: linkOf.get(target) || null,
        })
      )
    }
    return out
  }

  /** serialport を読み込めるか。ポートの候補が空のときに、理由を出し分けるために使う。 */
  static available() {
    try {
      loadSerialPort()
      return true
    } catch (err) {
      return false
    }
  }

  /** 利用できるシリアルポートの一覧 (設定画面の候補に使う)。 */
  static async list() {
    try {
      const SerialPort = loadSerialPort()
      const ports = await SerialPort.list()
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
        vendorId: p.vendorId || '',
        productId: p.productId || '',
      }))
    } catch (err) {
      return []
    }
  }
}

module.exports = { SerialTransport, DEFAULT_PORT_OPTIONS }
