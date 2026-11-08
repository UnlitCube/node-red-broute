'use strict'

// ============================================================================
//  SKSTACK-IP モジュール + スマートメーター のシミュレーター
// ============================================================================
//
//  実機が無くても、ダッシュボードやフローを組み立てて動かせるようにするための
//  transport。単体テストの相手役も兼ねる。
//
//  実機の挙動を写してある:
//    ・出力行はすべて CRLF 終端。SFE=1 の間はコマンドをエコーバックする
//      (実機のバイト列と同じ形)
//    ・SKLL64 は OK を返さず、変換結果のアドレス 1 行だけを返す
//    ・SKSCAN は OK → (EVENT 20 + EPANDESC) → EVENT 22 の順
//    ・SKJOIN は OK → EVENT 25 (または EVENT 24)。S3 が未設定なら FAIL ER10
//    ・SKSENDTO は OK → EVENT 21 → ERXUDP
//    ・ERXUDP のデータ部は WOPT の設定に従う (既定はバイナリ表示)
//    ・SKSREG の読み出しは ESREG <値> → OK。SFD (送信時間の積算) は電波を出すたびに増える
//    ・知らないコマンドは FAIL ER04
//
//  fail オプションで異常系を起こせるので、再接続まわりのテストに使える。
//
//  「マニュアル n.n」は ROHM BP35C0 コマンドマニュアル Ver1.2.0 の節を指す。

const { EventEmitter } = require('events')
const { LineSplitter } = require('./line-splitter')

const DEFAULTS = {
  mac: '001D129012345678',
  ipv6: 'FE80:0000:0000:0000:021D:1290:1234:5678',
  // 架空のメーター。meterIpv6 は meterAddr の EUI-64 から作った値にする (SKLL64 の応答と合わせる)
  meterAddr: '0011223344556677',
  meterIpv6: 'FE80:0000:0000:0000:0211:2233:4455:6677',
  channel: 0x3b,
  panId: '1234',
  // pairId は既定を持たない。SKSETRBID で入れた認証 ID の下 8 桁に従うので、どの認証情報でもつながる。
  // 別の契約のメーターを試すときだけ指定する
  lqi: 0x62,
  version: '1.5.2',
  echo: true, // SFE の初期値は 1
  wopt: 0x00, // ERXUDP はバイナリ表示が出荷時の既定
  // このスキャン時間以上でないとメーターが見つからない (実機の再現)
  minScanDuration: 5,
  // 自分の契約のメーターが電波の届く範囲に居るか。
  // false にすると、スキャンには extraPans しか出てこない。
  meterPresent: true,
  // 近所の別契約のメーター。スキャンには出てくるが PANA は通らない。
  // 動力と電力が並んで設置されている場所を再現する。
  extraPans: [],
  latencyMs: 5, // 1 行ごとの遅延
  joinMs: 300,
  // スキャン所要時間の倍率。テストでは 0.01 などにして待ち時間を詰める。
  scanTimeScale: 1,
  // 異常系の注入
  fail: {
    join: 0, // 最初の n 回の SKJOIN を EVENT 24 にする
    sendto: 0, // 最初の n 回の SKSENDTO を EVENT 21 PARAM=1 にする
    noEchonetResponse: 0, // 最初の n 回、ERXUDP を返さない
    sregWrite: [], // SKSREG <reg> <値> の書き込みを FAIL ER06 にするレジスタ (例: ['SA2'])
    // 最初の n 回の SKSENDTO を EVENT 21 PARAM=2 (アドレス要請) にする。
    // 実機では続いて EVENT 02 が出て自動再送されるが、
    // nsNoAnswer を立てると EVENT 02 を出さない (宛先誤りの再現)。
    ns: 0,
    nsNoAnswer: false,
    // SKSENDTO に一切応答しない (受付状態のまま固まる実機症状の再現)。
    // <CR> を受け取ったら FAIL を返して抜ける。
    mute: 0,
    // 最初の n 回の open() を失敗させる (起動時にアダプタがまだ無い状態の再現)。
    open: 0,
    // EPC ごとに、最初の n 回を PDC=0 (Get_SNA) で返す。持っているのに一時的に拒否する実機の再現。
    // 例: { E7: 1 }。キーは 16 進 ('E7' / '0xE7')。
    sna: {},
    // SKSREG <reg> の読み出しを FAIL ER06 にするレジスタ (例: ['SFD'])。
    // SFD を持たない古いファームの再現と、診断の失敗の試験に使う。
    sreg: [],
  },
  // SKSREG SFD (無線の送信時間の積算 [ms]) の初期値。概要の「送信積算」のゲージを dev で動かして見るため。
  txTotalMs: 0,
  // ERXUDP (ECHONET の応答) を返すまでの遅れ [ms]。
  echonetDelayMs: 120,
  meter: {
    power: 436, // 瞬時電力 [W]
    currentR: 150, // 0.1A 単位
    currentT: 300,
    cumulative: 615320, // 生カウント
    cumulativeReverse: 4,
    coefficient: 1,
    unitCode: 0x01, // 0.1 kWh
    digits: 6,
  },
}

class SimulatorTransport extends EventEmitter {
  constructor(config) {
    super()
    this.config = deepMerge(DEFAULTS, config || {})
    // 実機の初期状態まで写すので、Sequencer が「利用者の操作が要らない注意」の重さを下げる目印にする
    this.simulated = true
    this.state = {
      open: false,
      echo: this.config.echo,
      wopt: this.config.wopt,
      side: 0,
      s2: 0x21,
      s3: 'FFFF',
      pskSet: false,
      rbidSet: false,
      joined: false,
      joinFailures: 0,
      sendFailures: 0,
      missed: 0,
      muted: 0, // fail.mute で黙った回数
      nsCount: 0, // fail.ns でアドレス要請にした回数
      openFailures: 0,
      snaGiven: {}, // EPC ごとに、何回 Get_SNA で返したか
      // SKSREG で読めるレジスタ (診断の読み出し用。値の意味は _onSksreg の表)
      pairing: null, // S0A。SKSETRBID が認証 ID の下 8 文字を入れる
      frameCounter: 0, // S07。暗号化して送ったフレームの数
      beacon: 1, // S15
      panaLifetime: 86400, // S16 [秒]
      autoRejoin: 1, // S17
      txTotalMs: Math.max(0, Math.floor(Number(this.config.txTotalMs) || 0)), // SFD [ms]
      txWindowAt: Date.now(),
    }
    this._splitter = new LineSplitter()
    this._inbox = Buffer.alloc(0)
    this._expectBinary = null
    this.sent = [] // テストから見るための送信履歴
    this._outbox = [] // 出す予定の行 (出す時刻の順。_later)
    this._outboxTimer = null
  }

  get isOpen() {
    return this.state.open
  }

  open() {
    if (this.state.open) return Promise.resolve()
    if (this.state.openFailures < this.config.fail.open) {
      this.state.openFailures++
      return Promise.reject(new Error('Error: No such file or directory, cannot open /dev/ttyUSB-sim'))
    }
    this.state.open = true
    this._later(() => this.emit('open'), 1)
    return Promise.resolve()
  }

  close() {
    if (!this.state.open) return Promise.resolve()
    this.state.open = false
    clearTimeout(this._outboxTimer)
    this._outboxTimer = null
    this._outbox.length = 0
    this.emit('close')
    return Promise.resolve()
  }

  write(buffer) {
    if (!this.state.open) return Promise.reject(new Error('ポートが開いていません'))
    this._inbox = Buffer.concat([this._inbox, Buffer.from(buffer)])
    this._consume()
    return Promise.resolve()
  }

  // ---- 入力の取り込み ----------------------------------------------------

  _consume() {
    // SKSENDTO のデータ部は「指定バイト数ぴったり」で、改行では終わらない。
    // 揃うまでコマンド受付状態から抜けない、という実機の挙動を再現する。
    if (this._expectBinary) {
      const need = this._expectBinary.length
      if (this._inbox.length < need) return
      const data = this._inbox.slice(0, need)
      this._inbox = this._inbox.slice(need)
      const ctx = this._expectBinary
      this._expectBinary = null
      this._onSendToData(ctx, data)
      return this._consume()
    }

    // SKSENDTO だけはデータ部が CR で終わらないので、行としては切れない。
    // 引数が 6 つ揃った時点でコマンドとして受け付け、
    // 続きを <DATALEN> バイトのデータとして数える (実機と同じ扱い)。
    const head = this._inbox.toString('latin1').match(/^\n*(SKSENDTO(?:[ \t]+[^ \t\r\n]+){6}[ \t])/i)
    if (head) {
      this._inbox = this._inbox.slice(Buffer.byteLength(head[0], 'latin1'))
      this._onCommand(head[1].trim())
      return this._consume()
    }

    let idx
    while ((idx = this._inbox.indexOf(0x0d)) !== -1) {
      const line = this._inbox.slice(0, idx).toString('latin1').replace(/^\n+/, '')
      this._inbox = this._inbox.slice(idx + 1)
      this._onCommand(line)
      if (this._expectBinary) return this._consume()
    }
  }

  // ---- 出力 --------------------------------------------------------------

  /** 実機と同じく CRLF 終端で 1 行出す。 */
  _emitLine(text, delayMs) {
    this._later(() => {
      if (!this.state.open) return
      const bytes = Buffer.from(text + '\r\n', 'latin1')
      for (const l of this._splitter.push(bytes)) this.emit('line', l)
    }, delayMs === undefined ? this.config.latencyMs : delayMs)
  }

  _emitRaw(buf, delayMs) {
    this._later(() => {
      if (!this.state.open) return
      for (const l of this._splitter.push(Buffer.concat([Buffer.from(buf), Buffer.from('\r\n', 'latin1')]))) {
        this.emit('line', l)
      }
    }, delayMs === undefined ? this.config.latencyMs : delayMs)
  }

  /**
   * ms のあとに動かす。出す順は時刻の順に保つ (実機のシリアルは行が入れ替わらない)。
   *
   * 1 行に 1 本ずつタイマーを張ると、Node は同じ長さのタイマーをまとめて動かすので、イベントループが遅れたときに
   * 順が入れ替わる。EPANDESC の Addr の行だけが見出しより先に届き、Addr の無いスキャン結果になることがあった。
   * タイマーは 1 本にして、ここで順を持つ。
   *
   * 時刻は単調な時計（performance.now）で数える。壁時計（Date.now）は NTP の補正や VM の時刻合わせで飛び、
   * 進むと先の行がまとめて早く出て（待ちの切れる前に応答が届く）、戻ると戻った分だけ行が止まる。
   * 出すのは setTimeout（単調な時計）なので、順を持つ時刻も同じ時計にそろえる。
   */
  _later(fn, ms) {
    const at = performance.now() + ms
    let i = this._outbox.length
    while (i > 0 && this._outbox[i - 1].at > at) i--
    this._outbox.splice(i, 0, { at, fn })
    this._armOutbox()
  }

  _armOutbox() {
    clearTimeout(this._outboxTimer)
    this._outboxTimer = null
    if (!this._outbox.length) return
    this._outboxTimer = setTimeout(() => this._drainOutbox(), Math.max(0, this._outbox[0].at - performance.now()))
  }

  _drainOutbox() {
    const now = performance.now()
    while (this._outbox.length && this._outbox[0].at <= now) this._outbox.shift().fn()
    this._armOutbox()
  }

  _ok(value, delayMs) {
    this._emitLine(value === undefined ? 'OK' : 'OK ' + value, delayMs)
  }

  _fail(code, delayMs) {
    this._emitLine('FAIL ' + (code || 'ER04'), delayMs)
  }

  // ---- コマンド処理 ------------------------------------------------------

  _onCommand(raw) {
    const line = raw.replace(/[\r\n]+$/, '')
    this.sent.push(line)

    // マニュアル 3.9 の復旧手順。SKSENDTO に無言のまま固まっているとき、
    // <CR> を 1 つ受け取ったら FAIL を返して受付状態から抜ける (実機と同じ)。
    if (this.state.stuck) {
      this.state.stuck = false
      this._fail('ER09')
      if (line === '') return
    }

    if (this.state.echo && line !== '') this._emitLine(line, 1)

    if (line === '') return // 裸の CR は応答なし (実機と同じ)

    const parts = line.split(/\s+/)
    const cmd = parts[0].toUpperCase()

    switch (cmd) {
      case 'SKRESET':
        this.state.joined = false
        this.state.pskSet = false
        this.state.rbidSet = false
        this.state.s2 = 0x21
        this.state.s3 = 'FFFF'
        this.state.pairing = null
        this.state.echo = true // SFE は FLASH 保存対象外なので初期値に戻る
        this.state.rssiInErxudp = false // SA2 も同じ。SKRESET のたびに入れ直す必要がある
        // SFD (送信時間の積算) は戻さない。電波法の 1 時間の枠はリセットで消えないので、
        // 実機も積算を持ち越すものとして扱う (実機での確認はしていない)
        return this._ok()

      case 'SKVER':
        this._emitLine('EVER ' + this.config.version)
        return this._ok(undefined, this.config.latencyMs * 2)

      case 'SKAPPVER':
        this._emitLine('EAPPVER simulator')
        return this._ok(undefined, this.config.latencyMs * 2)

      case 'SKINFO':
        // 実機は末尾に余分なスペースを 1 つ付ける
        this._emitLine(
          `EINFO ${this.config.ipv6} ${this.config.mac} ${pad2(this.state.s2)} ${this.state.s3} ${this.state.side} `
        )
        return this._ok(undefined, this.config.latencyMs * 2)

      case 'SKSREG':
        return this._onSksreg(parts)

      case 'ROPT':
        return this._ok(pad2(this.state.wopt))

      case 'WOPT': {
        const v = parseInt(parts[1], 16)
        if (isNaN(v)) return this._fail('ER06')
        this.state.wopt = v
        return this._ok()
      }

      case 'SKSETPWD': {
        const len = parseInt(parts[1], 16)
        const pwd = parts[2] || ''
        // <LEN> は 16 進。桁が合わないと不定値になる (実機は FAIL を返さない)
        if (isNaN(len) || len < 1 || len > 32) return this._fail('ER06')
        if (!/^[0-9A-Z]+$/.test(pwd)) return this._fail('ER06')
        this.state.pskSet = pwd.length === len
        return this._ok()
      }

      case 'SKSETRBID': {
        const id = parts[1] || ''
        if (id.length !== 32) return this._fail('ER06')
        this.state.rbidSet = true
        // 実機と同じく、認証 ID の下 8 文字を Pairing ID (S0A) にする
        this.state.pairing = id.slice(-8).toUpperCase()
        return this._ok()
      }

      case 'SKSCAN':
        return this._onScan(parts)

      case 'SKLL64': {
        const addr = parts[1] || ''
        if (addr.length !== 16) return this._fail('ER06')
        // SKLL64 は OK を返さない。変換結果 1 行だけ (マニュアル 3.31)
        return this._emitLine(this.config.meterIpv6)
      }

      case 'SKJOIN':
        return this._onJoin(parts)

      case 'SKREJOIN':
        if (!this.state.joined) return this._fail('ER10')
        this._ok()
        this._addTx(120, 4) // PANA の再認証 (送るのはおよそ 4 フレーム)
        return this._emitLine(`EVENT 25 ${this.config.meterIpv6} 0`, this.config.joinMs)

      case 'SKTERM':
        if (!this.state.joined) return this._fail('ER10')
        this.state.joined = false
        this._ok()
        this._addTx(60)
        return this._emitLine(`EVENT 27 ${this.config.meterIpv6} 0`, this.config.joinMs)

      case 'SKSENDTO':
        return this._onSendTo(parts, line)

      case 'SKPING':
        this._ok()
        this._addTx(16)
        return this._emitLine(`EPONG 0 ${parts[2] || this.config.meterIpv6}`, 200)

      case 'SKTABLE':
        return this._onTable(parts)

      default:
        return this._fail('ER04')
    }
  }

  _onSksreg(parts) {
    const reg = normReg(parts[1])
    const val = parts[2]
    if (val === undefined) {
      // 読み出しは BP35C0 と同じく「ESREG <値>」→「OK」
      if ((this.config.fail.sreg || []).map(normReg).indexOf(reg) >= 0) return this._fail('ER06')
      const cur = this._readRegister(reg)
      if (cur === undefined) return this._fail('ER06')
      this._emitLine('ESREG ' + cur)
      return this._ok(undefined, this.config.latencyMs * 2)
    }
    if ((this.config.fail.sregWrite || []).map(normReg).indexOf(reg) >= 0) return this._fail('ER06')
    const n = parseInt(val, 16)
    switch (reg) {
      case 'SFE':
        this.state.echo = val !== '0'
        return this._ok()
      case 'SF0':
        this.state.side = n || 0
        return this._ok()
      case 'S02':
        this.state.s2 = n
        return this._ok()
      case 'S03':
        this.state.s3 = val.toUpperCase()
        return this._ok()
      case 'S15':
        this.state.beacon = n ? 1 : 0
        return this._ok()
      case 'S16':
        if (Number.isFinite(n)) this.state.panaLifetime = n
        return this._ok()
      case 'S17':
        this.state.autoRejoin = n ? 1 : 0
        return this._ok()
      case 'SA2':
        this.state.rssiInErxudp = val !== '0'
        return this._ok()
      default:
        return this._ok()
    }
  }

  /**
   * SKSREG <reg> で読める値 (知らないレジスタは undefined → FAIL ER06)。
   * 桁は SKSTACK-IP のレジスタの幅に合わせる (8 ビットは 2 桁・16 ビットは 4 桁・32 ビットは 8 桁・フラグは 1 桁)。
   * Web UI の診断の許可リスト (S02 S03 S07 S0A S15 S16 S17 SA2 SFD SFE SF0) は全部答える。
   */
  _readRegister(reg) {
    const s = this.state
    switch (reg) {
      case 'S02': // 使っているチャンネル
        return pad2(s.s2)
      case 'S03': // PAN ID
        return s.s3
      case 'S07': // フレームカウンター (暗号化して送ったフレームの数)
        return hex8(s.frameCounter)
      case 'S0A': // Pairing ID (SKSETRBID の前は 0)
        return s.pairing || '00000000'
      case 'S15': // ビーコンに応答するか
        return String(s.beacon)
      case 'S16': // PANA セッションの寿命 [秒]。初期値 86400
        return hex8(s.panaLifetime)
      case 'S17': // 自動再認証
        return String(s.autoRejoin)
      case 'SA2': // ERXUDP に RSSI を付けるか
        return s.rssiInErxudp ? '1' : '0'
      case 'SFD': // 無線の送信時間の積算 [ms]
        this._rollTxWindow()
        return hex8(s.txTotalMs)
      case 'SFE': // エコーバック
        return s.echo ? '1' : '0'
      case 'SF0': // B ルート (0) / HAN (1)
        return String(s.side)
      default:
        return undefined
    }
  }

  /**
   * 無線で送ったぶんを SFD (送信時間の積算 [ms]) に足す。
   * 920MHz 帯 Wi-SUN の 100kbps で、PHY・MAC・6LoWPAN・UDP のヘッダをおよそ 60 バイトとして 1 フレームずつ数える。
   * 実機の値に合わせたものではない (積算が送るたびに増えることと、概要のゲージを確かめるための目安)。
   */
  _addTx(bytes, frames) {
    this._rollTxWindow()
    const per = Math.max(1, Math.ceil(((Math.max(0, bytes) + 60) * 8) / 100))
    this.state.txTotalMs += per * (frames || 1)
  }

  /** ARIB STD-T108 の上限は 1 時間あたり 360 秒。積算を 1 時間ごとに数え直す (実機の数え方は未確認)。 */
  _rollTxWindow() {
    const now = Date.now()
    if (now - this.state.txWindowAt >= 3600 * 1000) {
      this.state.txTotalMs = 0
      this.state.txWindowAt = now
    }
  }

  _onScan(parts) {
    const mode = parseInt(parts[1], 10)
    const duration = parseInt(parts[3], 16) // <DURATION> は 16 進
    if (parts.length < 5) return this._fail('ER05') // <SIDE> の付け忘れ
    // <CHANNEL_MASK> は 32 ビットの 16 進。最下位ビットがチャネル 33
    if (!/^[0-9A-F]{1,8}$/i.test(parts[2])) return this._fail('ER06')
    const mask = parseInt(parts[2], 16) >>> 0
    const inMask = (ch) => ch >= 33 && ch <= 60 && ((mask >>> (ch - 33)) & 1) === 1
    this._ok()

    if (mode === 0) {
      // ED スキャン: EVENT 1F → EEDSCAN
      this._emitLine(`EVENT 1F ${this.config.ipv6} 0`, 200)
      const pairs = []
      for (let ch = 0x21; ch <= 0x3c; ch++) pairs.push(pad2(ch), pad2(2 + (ch % 7)))
      this._emitLine('EEDSCAN', 210)
      this._emitLine('0 ' + pairs.join(' '), 220)
      return
    }

    // アクティブスキャン。DURATION が足りないと見つからない。
    // マニュアル: 1ch あたり 0.0096*(2^DURATION+1) 秒。時間も送信もマスクのチャネルの数で決まる
    let channels = 0
    for (let ch = 33; ch <= 60; ch++) if (inMask(ch)) channels++
    const scanMs = Math.max(10, Math.round(0.0096 * (Math.pow(2, duration) + 1) * channels * 1000 * this.config.scanTimeScale))
    const longEnough = duration >= this.config.minScanDuration
    this._addTx(8, channels) // チャンネルごとにビーコン要求を 1 つ送る

    // 実機では、PairID が一致しないメーターもビーコンに応答してくる
    // (動力と電力が並んでいる場所では、別の契約のメーターが見える)。
    // だからスキャンには全部出す。どれが自分の契約かは PairID で見分ける。
    const c = this.config
    const pans = []
    if (c.meterPresent && this.state.rbidSet && longEnough && inMask(c.channel)) {
      pans.push({ panId: c.panId, pairId: c.pairId || this.state.pairing, channel: c.channel, addr: c.meterAddr, lqi: c.lqi })
    }
    // 別契約のメーターは、こちらの設定に関係なく応答してくる
    if (duration >= 4) {
      for (const e of c.extraPans || []) {
        const channel = e.channel === undefined ? c.channel : e.channel
        if (!inMask(channel)) continue
        pans.push({
          panId: e.panId,
          pairId: e.pairId,
          channel,
          addr: e.meterAddr || 'FFFFFFFFFFFFFFFF',
          lqi: e.lqi === undefined ? 0xf0 : e.lqi,
        })
      }
    }

    let t = Math.round(scanMs / 2)
    for (const pan of pans) {
      this._emitLine(`EVENT 20 ${this.config.meterIpv6} 0`, t)
      const detail = [
        'EPANDESC',
        `  Channel:${pad2(pan.channel)}`,
        '  Channel Page:09',
        `  Pan ID:${pan.panId}`,
        `  Addr:${pan.addr}`,
        `  LQI:${pad2(pan.lqi)}`,
        '  Side:0',
        `  PairID:${pan.pairId}`,
      ]
      detail.forEach((l, i) => this._emitLine(l, t + 1 + i))
      t += detail.length + 3
    }
    this._emitLine(`EVENT 22 ${this.config.ipv6} 0`, Math.max(scanMs, t + 5))
  }

  _onJoin(parts) {
    // S3 に PAN ID が入っていなければ、認証を始めずに FAIL ER10 で返す (モジュールの設定だけが消えたときの形)
    if (String(this.state.s3).toUpperCase() === 'FFFF') return this._fail('ER10')
    // PANA の認証で送るのはおよそ 4 フレーム (通っても通らなくても送っている)
    this._addTx(120, 4)
    // 別契約のメーターへ繋ごうとしても PANA は通らない
    if (String(this.state.s3).toUpperCase() !== String(this.config.panId).toUpperCase()) {
      this._ok()
      return this._emitLine(`EVENT 24 ${this.config.meterIpv6} 0`, this.config.joinMs)
    }
    if (!this.state.pskSet || !this.state.rbidSet) {
      // PSK 未設定で SKJOIN すると認証に失敗する
      this._ok()
      return this._emitLine(`EVENT 24 ${this.config.meterIpv6} 0`, this.config.joinMs)
    }
    this._ok()
    if (this.state.joinFailures < this.config.fail.join) {
      this.state.joinFailures++
      return this._emitLine(`EVENT 24 ${this.config.meterIpv6} 0`, this.config.joinMs)
    }
    this.state.joined = true
    return this._emitLine(`EVENT 25 ${this.config.meterIpv6} 0`, this.config.joinMs)
  }

  _onSendTo(parts, line) {
    // SKSENDTO <HANDLE> <IPADDR> <PORT> <SEC> <SIDE> <DATALEN> <DATA>
    if (parts.length < 7) return this._fail('ER05')
    const len = parseInt(parts[6], 16)
    if (isNaN(len) || len < 1) return this._fail('ER06')
    // データ部は改行では終わらない。指定バイト数揃うまで待つ。
    //
    // PANA セッションが無い場合 (マニュアル 3.9: 使っていないハンドルを指定すると
    // FAIL ER10) も、先に FAIL を返してはいけない。モジュールは既に
    // DATALEN バイトを待つ状態に入っているので、先に返すと続くデータ部が
    // コマンド行として解釈され、実機には無い ER04 の連鎖が起きる。
    this._expectBinary = { length: len, port: parts[3], failWith: this.state.joined ? null : 'ER10' }
  }

  _onSendToData(ctx, data) {
    if (ctx.failWith) return this._fail(ctx.failWith)
    // 応答を一切返さない。実機で SKSENDTO が無言で固まる症状。
    if (this.state.muted < this.config.fail.mute) {
      this.state.muted++
      this.state.stuck = true
      return
    }

    this._ok()
    // 暗号化して 1 フレーム送った (送れなかった EVENT 21 PARAM=1 でも、電波は出している)
    this.state.frameCounter = (this.state.frameCounter + 1) >>> 0
    this._addTx(data.length)

    if (this.state.sendFailures < this.config.fail.sendto) {
      this.state.sendFailures++
      return this._emitLine(`EVENT 21 ${this.config.meterIpv6} 0 01`, 50)
    }

    // アドレス要請 (NS) を実行した場合。マニュアル 3.9。
    if (this.state.nsCount < this.config.fail.ns) {
      this.state.nsCount++
      this._emitLine(`EVENT 21 ${this.config.meterIpv6} 0 02`, 50)
      if (this.config.fail.nsNoAnswer) return // EVENT 02 を返さない
      this._emitLine(`EVENT 02 ${this.config.meterIpv6} 0`, 80)
    } else {
      this._emitLine(`EVENT 21 ${this.config.meterIpv6} 0 00`, 50)
    }

    if (this.state.missed < this.config.fail.noEchonetResponse) {
      this.state.missed++
      return // 応答を返さない (無応答の再現)
    }

    const response = this._buildEchonetResponse(data)
    if (!response) return

    const hex = response.toString('hex').toUpperCase()
    const body = this.state.wopt & 0x01 ? hex : null
    // SA2=1 なら受信の強さを付ける (2 の補数の 16 進 [dBm])。ゆっくり上下させて、推移の LQI のグラフを dev で見られるようにする
    const rssi = this.state.rssiInErxudp ? ((Math.round(-82 + 10 * Math.sin(Date.now() / 300000)) + 256) & 0xff).toString(16).toUpperCase().padStart(2, '0') + ' ' : ''
    const head = `ERXUDP ${this.config.meterIpv6} ${this.config.ipv6} 0E1A ${ctx.port} ${this.config.meterAddr} ${rssi}1 0 ${pad4(response.length)} `
    const delay = this.config.echonetDelayMs
    if (body !== null) {
      this._emitLine(head + body, delay)
    } else {
      // バイナリ表示。データ中に 0x0D が入ると行が割れる、という実機の弱点も再現する
      this._emitRaw(Buffer.concat([Buffer.from(head, 'latin1'), response]), delay)
    }
  }

  /** 受け取った Get 要求に対する Get_Res を組み立てる。 */
  _buildEchonetResponse(req) {
    if (req.length < 12 || req[0] !== 0x10 || req[1] !== 0x81) return null
    const tid = req.readUInt16BE(2)
    const esv = req[10]
    const opc = req[11]
    if (esv !== 0x62) return null // Get 以外は相手にしない

    const m = this.config.meter
    const props = []
    let p = 12
    let allOk = true
    for (let i = 0; i < opc && p + 1 < req.length; i++) {
      const epc = req[p]
      const pdc = req[p + 1]
      p += 2 + pdc
      const edt = this._denyOnce(epc) ? null : this._propertyValue(epc, m)
      if (edt === null) {
        allOk = false
        props.push(Buffer.from([epc, 0x00])) // 未対応は PDC=0
      } else {
        props.push(Buffer.concat([Buffer.from([epc, edt.length]), edt]))
      }
    }

    const head = Buffer.from([
      0x10, 0x81,
      (tid >> 8) & 0xff, tid & 0xff,
      0x02, 0x88, 0x01, // SEOJ = メーター
      0x05, 0xff, 0x01, // DEOJ = コントローラ
      allOk ? 0x72 : 0x52, // Get_Res / Get_SNA
      props.length,
    ])
    return Buffer.concat([head].concat(props))
  }

  /** fail.sna に指定された EPC を、指定回数だけ拒否する。 */
  _denyOnce(epc) {
    const table = this.config.fail.sna || {}
    for (const [k, n] of Object.entries(table)) {
      if (parseInt(String(k).replace(/^0x/i, ''), 16) !== epc) continue
      const given = this.state.snaGiven[epc] || 0
      if (given >= n) return false
      this.state.snaGiven[epc] = given + 1
      return true
    }
    return false
  }

  _propertyValue(epc, m) {
    const b = (n) => Buffer.from([n])
    switch (epc) {
      case 0x80: return b(0x30) // 動作状態 ON
      case 0x82: return Buffer.from([0x00, 0x00, 0x47, 0x00])
      case 0x88: return b(0x42) // 異常なし
      case 0x8a: return Buffer.from([0x00, 0x00, 0x06])
      case 0x8d: return Buffer.from('SIMULATOR0', 'ascii')
      case 0xd3: return int32(m.coefficient)
      case 0xd7: return b(m.digits)
      case 0xe0: return int32(m.cumulative)
      case 0xe1: return b(m.unitCode)
      case 0xe3: return int32(m.cumulativeReverse)
      case 0xe7: {
        // 少しだけ揺らして、グラフが動くようにする
        const jitter = Math.round((Math.sin(Date.now() / 30000) * m.power) / 10)
        return int32s(m.power + jitter)
      }
      case 0xe8: {
        const buf = Buffer.alloc(4)
        buf.writeInt16BE(m.currentR, 0)
        buf.writeInt16BE(m.currentT, 2)
        return buf
      }
      case 0xea:
      case 0xeb: {
        // メーターの時計は日本時間。サーバーの時間帯で作ると、UTC のサーバーで確定の時刻が 9 時間ずれる
        const d = new Date(Date.now() + 9 * 3600000)
        const buf = Buffer.alloc(11)
        buf.writeUInt16BE(d.getUTCFullYear(), 0)
        buf[2] = d.getUTCMonth() + 1
        buf[3] = d.getUTCDate()
        buf[4] = d.getUTCHours()
        buf[5] = d.getUTCMinutes() < 30 ? 0 : 30
        buf[6] = 0
        buf.writeUInt32BE(epc === 0xea ? m.cumulative : m.cumulativeReverse, 7)
        return buf
      }
      case 0x9f: {
        // Get プロパティマップ。
        // 形式はプロパティ数で決まる (ECHONET Lite 規格 付表):
        //   16 未満 … 先頭にプロパティ数、続けて EPC をそのまま並べる
        //   16 以上 … 先頭にプロパティ数、続けて 16 バイトのビットマップ
        const epcs = [0x80, 0x82, 0x88, 0x8a, 0x8d, 0x97, 0x98, 0x9d, 0x9e, 0x9f,
                      0xd3, 0xd7, 0xe0, 0xe1, 0xe3, 0xe7, 0xe8, 0xea, 0xeb]
        if (epcs.length < 16) {
          return Buffer.from([epcs.length].concat(epcs))
        }
        const buf = Buffer.alloc(17)
        buf[0] = epcs.length
        for (const e of epcs) {
          const col = e & 0x0f
          const bit = ((e >> 4) & 0x0f) - 8
          if (bit >= 0 && bit < 8) buf[1 + col] |= 1 << bit
        }
        return buf
      }
      default:
        return null // 未対応 → Get_SNA
    }
  }

  _onTable(parts) {
    const which = (parts[1] || '1').toUpperCase()
    if (which === '1') {
      this._emitLine('EADDR')
      this._emitLine(this.config.ipv6, this.config.latencyMs * 2)
      return this._ok(undefined, this.config.latencyMs * 3)
    }
    if (which === '2') {
      this._emitLine('ENEIGHBOR')
      if (this.state.joined) this._emitLine(`${this.config.meterIpv6} ${this.config.meterAddr}`, this.config.latencyMs * 2)
      return this._ok(undefined, this.config.latencyMs * 3)
    }
    return this._ok()
  }
}

// ---------------------------------------------------------------------------
function int32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}
function int32s(n) {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n | 0, 0)
  return b
}
function pad2(n) {
  return ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
}
function pad4(n) {
  return ('000' + (n & 0xffff).toString(16).toUpperCase()).slice(-4)
}
function hex8(n) {
  return ('0000000' + (n >>> 0).toString(16).toUpperCase()).slice(-8)
}
/** レジスタ名をそろえる (S2 → S02、SA → S0A。SKSTACK-IP はどちらの書き方も受け付ける)。 */
function normReg(r) {
  const s = String(r || '').toUpperCase()
  return /^S[0-9A-F]$/.test(s) ? 'S0' + s.slice(1) : s
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)

/**
 * 既定値と指定値を重ねる。
 *
 * 入れ子のオブジェクトは、指定が無くても必ず複製する。
 * 浅く写すと config.fail が DEFAULTS.fail と同じ実体になり、
 * あとから書き換えたときに**別のインスタンスまで巻き添えになる**
 * (1 つのテストが仕込んだ異常が以降全部に効く)。
 */
function deepMerge(base, over) {
  if (Array.isArray(base)) return (Array.isArray(over) ? over : base).slice()
  const out = {}
  for (const k of Object.keys(base || {})) {
    const v = base[k]
    out[k] = isPlainObject(v) ? deepMerge(v, {}) : Array.isArray(v) ? v.slice() : v
  }
  for (const k of Object.keys(over || {})) {
    const v = over[k]
    out[k] = isPlainObject(v) ? deepMerge(isPlainObject(base && base[k]) ? base[k] : {}, v) : v
  }
  return out
}

module.exports = { SimulatorTransport }
