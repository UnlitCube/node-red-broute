// ============================================================================
//  SKSTACK-IP (ROHM BP35C0 / RS-WSUHA) の応答・イベント行パーサ
//  シーケンサーと lib/sk-results.js が使う共有ライブラリ。副作用なし。
// ============================================================================
//
// 出典: BP35C0 コマンドマニュアル Ver1.2.0 (No.63TR001J Rev.002)
//   3章 コマンドリファレンス / 4章 イベント / 7章 エラーコード
//
// 設計方針:
//   * 受信は必ず「行」単位で扱う。固定バイトオフセットで切り出さない。
//     ERXUDP のヘッダー長は <RSSI> (SA2=1 のとき出現) や表記により変動するため、
//     オフセット決め打ちは必ず壊れる。
//   * ERXUDP のデータ部は WOPT 01 で 16 進 ASCII にしてから受けることを前提とする。
//     受信は CR (0x0D) 区切りなので、バイナリのままだと
//     データ中の 0x0D で行が割れて復元不能になる。
//   * 行の末尾から数えて DATALEN / DATA を取ることで、<SIDE> や <RSSI> の
//     有無 (モジュール差・レジスタ設定差) に影響されない解析にする。

var SK = (function () {
  // ---- エラーコード (マニュアル 7章) -------------------------------------
  var ERROR_CODES = {
    ER01: { reserved: true, message: 'Reserved' },
    ER02: { reserved: true, message: 'Reserved' },
    ER03: { reserved: true, message: 'Reserved' },
    ER04: { message: 'アダプタが対応していないコマンドです', advice: 'コマンド名と引数を確かめてください', retry: false },
    ER05: { message: '引数の数が合っていません', advice: 'コマンド名と引数を確かめてください', retry: false },
    ER06: { message: '引数の形か値の範囲が合っていません', advice: 'コマンド名と引数を確かめてください', retry: false },
    ER07: { reserved: true, message: 'Reserved' },
    ER08: { reserved: true, message: 'Reserved' },
    ER09: { message: 'UART の入力でエラーが起きました', advice: '<CR> を送って戻してから、コマンドを実行し直してください', retry: true },
    ER10: { message: 'コマンドは受け付けられましたが、実行に失敗しました', advice: 'コマンドを送るタイミングが適切かを確かめてください', retry: true },
  }

  // ---- EVENT 番号 (マニュアル 4.10) ---------------------------------------
  var EVENTS = {
    0x01: { name: 'NS 受信', severity: 'info' },
    0x02: { name: 'NA 受信', severity: 'info' },
    0x05: { name: 'Echo Request 受信', severity: 'info' },
    0x1f: { name: 'ED スキャン完了', severity: 'info' },
    0x20: { name: 'Beacon 受信', severity: 'info' },
    0x21: { name: 'UDP 送信処理完了', severity: 'info' },
    0x22: { name: 'アクティブスキャン完了', severity: 'info' },
    0x24: { name: 'PANA 接続エラー', severity: 'error' },
    0x25: { name: 'PANA 接続完了', severity: 'good' },
    0x26: { name: 'セッション終了要求を受信', severity: 'warn' },
    0x27: { name: 'PANA セッション終了成功', severity: 'info' },
    0x28: { name: 'PANA セッション終了要求がタイムアウト', severity: 'warn' },
    0x29: { name: 'セッションライフタイム期限切れ', severity: 'warn' },
    0x32: { name: 'ARIB108 送信総和時間の制限が発動', severity: 'error' },
    0x33: { name: 'ARIB108 送信総和時間の制限が解除', severity: 'good' },
    0x45: { name: '異なるキーインデックスの暗号文を受信', severity: 'warn' },
    0x46: { name: '鍵更新メッセージ未受信タイムアウト', severity: 'warn' },
    0x50: { name: '鍵配布メッセージ送信', severity: 'info' },
    0x51: { name: '鍵配布応答受信', severity: 'info' },
    0x52: { name: '鍵配布応答なし', severity: 'warn' },
    0x53: { name: '鍵要求メッセージ受信', severity: 'info' },
    0x54: { name: '自動鍵配信開始', severity: 'info' },
    0x55: { name: '自動鍵配信終了', severity: 'info' },
    0x56: { name: 'イニシャルセットアップモード開始', severity: 'info' },
    0x57: { name: 'イニシャルセットアップモード終了', severity: 'info' },
    0xc0: { name: 'スリープモードから復帰', severity: 'info' },
  }

  // EVENT 21 の <PARAM> (UDP 送信結果)
  var UDP_RESULT = {
    0: { ok: true, text: 'UDP 送信成功' },
    1: { ok: false, text: 'UDP 送信失敗（キャリアセンスビジー / 送信時間制限 / Ack 無し / 鍵無し）' },
    2: { ok: true, text: 'アドレス要請（NS）を実行しました。解決すると自動で送り直します' },
  }

  // ---- 仮想レジスタ (SKSREG) の意味と単位 ---------------------------------
  // Web UI の診断で読む 11 個 (S02 S03 S07 S0A S15 S16 S17 SA2 SFD SFE SF0)。
  // 出典はマニュアルのレジスタの一覧。ここに無いレジスタは「意味が分からない」として扱う。
  // kind は値の読み方 (lib/sk-results.js の describeRegister):
  //   channel … 論理チャネル番号 (16 進)。周波数に換算できる
  //   id      … 16 進の識別子。文字列のまま。unset の値なら「未設定」
  //   u32 / seconds / ms … 16 進の数
  //   flag    … 0 / 1。off / on がそれぞれの意味
  //   enum    … values の表
  var REGISTERS = {
    S02: { name: 'チャネル', unit: 'ch', kind: 'channel', desc: '使っている周波数の論理チャネル番号（33〜60）です。スキャンで見つけたメーターに合わせて書き込みます' },
    S03: { name: 'PAN ID', unit: '', kind: 'id', unset: 'FFFF', desc: 'つなぐメーターの PAN ID です。スキャンで見つけた値を書き込みます。FFFF は未設定です' },
    S07: { name: 'フレームカウンター', unit: '', kind: 'u32', desc: 'MAC 層の暗号化に使うフレームカウンターです。暗号化して送るたびに増えます' },
    S0A: { name: 'Pairing ID', unit: '', kind: 'id', unset: '00000000', desc: 'スキャンで自分の契約のメーターを見分ける ID です。SKSETRBID で認証 ID の下 8 桁が入ります' },
    S15: { name: 'ビーコンへの応答', unit: '', kind: 'flag', off: '応答しない', on: '応答する', desc: 'ほかの機器のビーコン要求に応答するかを表します' },
    S16: { name: 'PANA セッションの寿命', unit: '秒', kind: 'seconds', desc: 'PANA のセッションの有効期間です。初期値は 86400 秒（24 時間）です' },
    S17: { name: '自動再認証', unit: '', kind: 'flag', off: '無効', on: '有効', desc: 'PANA のセッションの寿命が切れる前に、自動で認証し直すかを表します' },
    SA2: { name: 'ERXUDP の RSSI 表示', unit: '', kind: 'flag', off: '付けない', on: '付ける', desc: 'ERXUDP に受信の強さ（RSSI）を付けるかを表します' },
    SFD: { name: '送信時間の積算', unit: 'ms', kind: 'ms', limitMs: 360000, desc: '無線で送信した時間の積算です。ARIB STD-T108 の上限は 1 時間あたり 360 秒で、超えると EVENT 32 で送信が止まります' },
    SFE: { name: 'エコーバック', unit: '', kind: 'flag', off: 'しない', on: 'する', desc: '送ったコマンドをそのまま返すかを表します。FLASH に残らないので、電源を入れ直すと 1 に戻ります' },
    SF0: { name: '使う MAC 面', unit: '', kind: 'enum', values: { 0: 'B ルート', 1: 'HAN' }, desc: 'コマンドの対象にする MAC 面です（BP35C0 は B ルートと HAN の 2 面を持ちます）' },
  }

  /** レジスタ名をそろえる (S2 → S02、SA → S0A。SKSTACK-IP はどちらの書き方も受け付ける)。 */
  function normalizeRegister(r) {
    var s = String(r === undefined || r === null ? '' : r).trim().toUpperCase()
    return /^S[0-9A-F]$/.test(s) ? 'S0' + s.slice(1) : s
  }

  /** 認証情報 (パスワード・認証 ID・PSK・鍵) を書くコマンドか。 */
  function isSecretCommand(command) {
    return /^\s*SKSET/i.test(String(command === undefined || command === null ? '' : command))
  }

  /**
   * 認証情報を書くコマンドの値を伏せる。ほかの文はそのまま返す。
   *
   * ログ・lastError・失敗の command・受信のエコー・フローの返事の全部がここを通る。伏せ方を 1 か所にして、
   * 呼び手ごとの伏せ忘れを作らない。コマンドの文で判断するのは、フローから送った別の値も同じように伏せるため
   * (registry の redact は、いま効いている認証情報しか知らない)。
   *
   * 最後の引数だけを伏せると、引数が 1 つ多いときに本当の値が残るので、コマンド名のあとを全部伏せる。
   * SKSETPWD の <LEN> のような 2 桁までの 16 進の先頭の引数は、値が続くときだけ切り分けのために残す。
   */
  function maskSecretCommand(command) {
    var s = String(command === undefined || command === null ? '' : command)
    if (!isSecretCommand(s)) return s
    var t = s.trim().split(/\s+/)
    if (t.length < 2) return s
    if (t.length > 2 && /^[0-9A-Fa-f]{1,2}$/.test(t[1])) return t[0] + ' ' + t[1] + ' ********'
    return t[0] + ' ********'
  }

  // 論理チャネル番号 -> 周波数[MHz] (マニュアル 6章)
  function channelToMHz(ch) {
    if (ch < 33 || ch > 60) return null
    return Math.round((922.5 + (ch - 33) * 0.2) * 10) / 10
  }

  /**
   * ERXUDP の <RSSI> の欄を読む。負の数 (2 の補数の 16 進) なら dBm、0 以上なら LQI とみなす。
   * LQI はスキャン (EPANDESC) と同じ尺度にそろえる (ROHM の換算 RSSI ≒ 0.275 × LQI − 104.27 の逆。近似。0〜255 に丸める)。
   * @returns {{rssi: number, lqi: number}|null}
   */
  function signalOf(tok) {
    if (typeof tok !== 'string' || !/^([0-9A-Fa-f]{2}|[0-9A-Fa-f]{4})$/.test(tok)) return null
    var bits = tok.length * 4
    var v = parseInt(tok, 16)
    if (v >= Math.pow(2, bits - 1)) v -= Math.pow(2, bits)
    if (v < 0) {
      var lqi = Math.round((v + 104.27) / 0.275)
      return { rssi: v, lqi: Math.max(0, Math.min(255, lqi)) }
    }
    return { rssi: Math.round(0.275 * v - 104.27), lqi: Math.min(255, v) }
  }

  function isHex(s) {
    return /^[0-9A-Fa-f]+$/.test(s)
  }

  // ---- 1 行の分類 ---------------------------------------------------------
  /**
   * SKSTACK からの 1 行を構造化する。
   * 改行・CR は呼び出し側で落としておくこと。
   * @param {string} line
   * @returns {object} { kind, ... }
   */
  function parseLine(line) {
    var raw = line
    var s = String(line).replace(/[\r\n]+$/, '')
    var t = s.trim()

    if (t === '') return { kind: 'blank', raw: raw }

    // --- 成否応答 ---
    if (t === 'OK') return { kind: 'ok', raw: raw, value: null }
    if (/^OK\s+/.test(t)) return { kind: 'ok', raw: raw, value: t.slice(3).trim() }

    var fail = t.match(/^FAIL\s+(ER\d{2})/)
    if (fail) {
      var code = fail[1]
      var info = ERROR_CODES[code] || { message: '未知のエラーコード', retry: false }
      return { kind: 'fail', raw: raw, code: code, message: info.message, advice: info.advice || '', retryable: !!info.retry }
    }
    if (t === 'FAIL') return { kind: 'fail', raw: raw, code: 'FAIL', message: 'コード無しの失敗応答', retryable: false }

    // --- EVENT <NUM> <SENDER> <SIDE> [<PARAM>] ---
    if (/^EVENT\b/.test(t)) {
      var p = t.split(/\s+/)
      var num = parseInt(p[1], 16)
      var meta = EVENTS[num] || { name: '未定義イベント', severity: 'warn' }
      var ev = {
        kind: 'event',
        raw: raw,
        num: num,
        numHex: p[1],
        name: meta.name,
        severity: meta.severity,
        sender: p[2] || null,
        side: p[3] !== undefined ? parseInt(p[3], 16) : null,
        param: p[4] !== undefined ? parseInt(p[4], 16) : null,
      }
      if (num === 0x21 && ev.param !== null) {
        ev.udp = UDP_RESULT[ev.param] || { ok: false, text: '不明な送信結果 ' + ev.param }
      }
      return ev
    }

    // --- ERXUDP ---
    // ERXUDP <SENDER> <DEST> <RPORT> <LPORT> <SENDERLLA> [<RSSI>] <SECURED> <SIDE> <DATALEN> <DATA>
    // フィールド数はモジュール/レジスタ設定で変わるため、末尾から数えて取る。
    if (/^ERXUDP\b/.test(t)) {
      var f = t.split(/\s+/)
      var data = f[f.length - 1]
      var lenTok = f[f.length - 2]
      var datalen = isHex(lenTok) ? parseInt(lenTok, 16) : null
      var out = {
        kind: 'erxudp',
        raw: raw,
        sender: f[1] || null,
        dest: f[2] || null,
        rport: f[3] ? parseInt(f[3], 16) : null,
        lport: f[4] ? parseInt(f[4], 16) : null,
        senderlla: f[5] || null,
        datalen: datalen,
        data: data,
        fieldCount: f.length,
      }
      // <RSSI> は SA2=1 のときだけ現れる (SENDERLLA のすぐ後ろ)。BP35C0 の欄は RSSI なしで 10 個、ありで 11 個
      if (f.length === 11) {
        var sig = signalOf(f[6])
        if (sig) {
          out.rssi = sig.rssi
          out.lqi = sig.lqi
        }
      }
      // DATALEN=0 のときはデータ部が無いので、行は DATALEN で終わる。
      // 末尾から数える実装では data に DATALEN、lenTok に SIDE が入ってしまうため、
      // 先にこのケースを判定して「空」として扱う。
      // (ここを拾い損ねると「WOPT 01 が未設定では」という誤った警告を出す)
      if (data === '0000' || (isHex(data) && data.length === 4 && parseInt(data, 16) === 0)) {
        out.datalen = 0
        out.data = ''
        out.hex = ''
        out.encoding = 'empty'
        return out
      }
      // 16 進 ASCII (WOPT 01) なら文字数はバイト数の 2 倍になる。
      // 一致すれば安全に Buffer 化できる。一致しなければバイナリ表示のまま
      // 届いた可能性が高く、行が割れている恐れがあるので hex にしない。
      if (datalen !== null && isHex(data) && data.length === datalen * 2) {
        out.hex = data.toUpperCase()
        out.encoding = 'hex'
      } else {
        out.encoding = 'binary-or-broken'
        out.note = 'データ部が 16 進 ASCII として解釈できません。WOPT 01 が未設定の可能性があります'
      }
      return out
    }

    // --- EPANDESC / EEDSCAN / EADDR ... は複数行。ここではヘッダだけ返す ---
    if (t === 'EPANDESC') return { kind: 'multiline-start', raw: raw, name: 'EPANDESC', mode: 'kv' }
    if (t === 'EEDSCAN') return { kind: 'multiline-start', raw: raw, name: 'EEDSCAN', mode: 'lines', expect: 1 }
    if (t === 'EADDR') return { kind: 'multiline-start', raw: raw, name: 'EADDR', mode: 'until-ok' }
    if (t === 'ENEIGHBOR') return { kind: 'multiline-start', raw: raw, name: 'ENEIGHBOR', mode: 'until-ok' }
    if (t === 'EPORT') return { kind: 'multiline-start', raw: raw, name: 'EPORT', mode: 'until-ok' }
    if (t === 'ESEC') return { kind: 'multiline-start', raw: raw, name: 'ESEC', mode: 'until-ok' }
    if (t === 'ENBR') return { kind: 'multiline-start', raw: raw, name: 'ENBR', mode: 'until-ok' }
    if (t === 'EHANDLE') return { kind: 'multiline-start', raw: raw, name: 'EHANDLE', mode: 'until-ok' }

    // --- EINFO (SKINFO の応答) ---
    if (/^EINFO\b/.test(t)) {
      var e = t.split(/\s+/)
      return {
        kind: 'einfo',
        raw: raw,
        ipv6: e[1] || null,
        mac: e[2] || null,
        channel: e[3] ? parseInt(e[3], 16) : null,
        channelHex: e[3] || null,
        panid: e[4] || null,
        side: e[5] !== undefined ? parseInt(e[5], 16) : null,
      }
    }

    // --- ESREG (SKSREG 読み出しの応答) ---
    if (/^ESREG\b/.test(t)) {
      return { kind: 'esreg', raw: raw, value: t.replace(/^ESREG\s+/, '').trim() }
    }

    // --- EPONG (SKPING の応答) ---
    if (/^EPONG\b/.test(t)) {
      var g = t.split(/\s+/)
      return { kind: 'epong', raw: raw, side: g[1] !== undefined ? parseInt(g[1], 16) : null, sender: g[2] || null }
    }

    // --- SKLL64 の応答は裸の IPv6 アドレス 1 行 (OK が付かない) ---
    if (/^[0-9A-Fa-f]{4}(:[0-9A-Fa-f]{4}){7}$/.test(t)) {
      return { kind: 'ipv6', raw: raw, address: t.toUpperCase() }
    }

    // --- SKVER / SKAPPVER の応答 ---
    if (/^EVER\b/.test(t)) {
      return { kind: 'ever', raw: raw, version: t.replace(/^EVER\s+/, '').trim() }
    }
    if (/^EAPPVER\b/.test(t)) {
      return { kind: 'eappver', raw: raw, version: t.replace(/^EAPPVER\s+/, '').trim() }
    }

    // --- 上記以外 (エコーバックされたコマンド、未知の行) ---
    if (/^(SK|W|R)[A-Z0-9]+/.test(t)) return { kind: 'echo', raw: raw, text: t }

    return { kind: 'unknown', raw: raw, text: t }
  }

  // ---- 複数行イベントの組み立て -------------------------------------------
  /**
   * 行を順に食わせて、複数行イベントを 1 個のオブジェクトにまとめる。
   * シーケンサーがアキュムレーターを 1 つ持ち続け、受信した行を順に渡す。
   *
   *   var acc = SK.newAccumulator()
   *   var results = SK.feed(acc, '受信した1行')   // 0 個以上の確定イベントが返る
   */
  // EPANDESC の明細行 (マニュアル 4.5 で固定)
  var EPANDESC_KEYS = /^(Channel|Channel Page|Pan ID|Addr|LQI|Side|PairID)\s*:/

  /** EPANDESC の明細行か (前後の空白と末尾の改行は見ない)。組み立て中かどうかは見ない。 */
  function isEpandescField(line) {
    return EPANDESC_KEYS.test(String(line === undefined || line === null ? '' : line).replace(/[\r\n]+$/, '').trim())
  }

  // SKTABLE の表の見出し (複数行の 1 行目) ごとの意味と、行の列の名前。
  // 列の名前が無い表は、行を空白で区切ったトークンのまま扱う。
  var TABLES = {
    EADDR: { title: 'IP アドレスの一覧', columns: ['ipv6'] },
    ENEIGHBOR: { title: 'ネイバーキャッシュ（近くの機器の IPv6 アドレスと MAC アドレス）', columns: ['ipv6', 'mac'] },
    EPORT: { title: '待ち受けポートの一覧', columns: [] },
    EHANDLE: { title: 'TCP のハンドルの一覧', columns: [] },
  }

  /**
   * 複数行イベントの組み立て中でも素通しすべき行か。
   * 自発イベントは組み立て中かどうかに関係なく飛んでくる。
   */
  function isInterrupt(parsed) {
    if (!parsed) return false
    return parsed.kind === 'event' || parsed.kind === 'erxudp'
  }

  function newAccumulator() {
    return { pending: null, lines: [] }
  }

  function finishPending(acc) {
    if (!acc.pending) return null
    var name = acc.pending.name
    var lines = acc.lines
    acc.pending = null
    acc.lines = []

    if (name === 'EPANDESC') return parseEpandesc(lines)
    if (name === 'EEDSCAN') return parseEedscan(lines)
    return { kind: 'table', name: name, lines: lines }
  }

  function parseEpandesc(lines) {
    var kv = {}
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].trim().match(/^([^:]+):(.*)$/)
      if (m) kv[m[1].trim()] = m[2].trim()
    }
    var ch = kv['Channel'] !== undefined ? parseInt(kv['Channel'], 16) : null
    return {
      kind: 'epandesc',
      channel: ch,
      channelHex: kv['Channel'] || null,
      channelMHz: ch === null ? null : channelToMHz(ch),
      channelPage: kv['Channel Page'] || null,
      panId: kv['Pan ID'] || null,
      addr: kv['Addr'] || null,
      lqi: kv['LQI'] !== undefined ? parseInt(kv['LQI'], 16) : null,
      side: kv['Side'] !== undefined ? parseInt(kv['Side'], 16) : null,
      pairId: kv['PairID'] || null,
      fields: kv,
    }
  }

  function parseEedscan(lines) {
    var toks = (lines[0] || '').trim().split(/\s+/)
    var side = toks.length ? parseInt(toks[0], 16) : null
    var pairs = []
    for (var i = 1; i + 1 < toks.length; i += 2) {
      var ch = parseInt(toks[i], 16)
      var rssi = parseInt(toks[i + 1], 16)
      pairs.push({ channel: ch, channelMHz: channelToMHz(ch), rssi: rssi })
    }
    return { kind: 'eedscan', side: side, channels: pairs }
  }

  /**
   * 1 行食わせる。確定したイベントの配列を返す (通常は 0 or 1 個、
   * 複数行の終端と同時に次の行が確定する場合に 2 個)。
   */
  function feed(acc, line) {
    var out = []
    var parsed = parseLine(line)

    // エコーバックは自分が送ったコマンドが返ってきただけなので、常に捨てる。
    // ここで捨てないと、複数行イベントの組み立て中にエコーが挟まったときに
    // そのイベントが途中で打ち切られてしまう
    // (SKSREG SFE 0 が効く前や、何らかの理由でエコーが復活した場合に起きる)。
    if (parsed.kind === 'echo') return out

    if (acc.pending) {
      var mode = acc.pending.mode
      var t = String(line).replace(/[\r\n]+$/, '').trim()

      // 複数行イベントを組み立てている最中でも、自発イベント (EVENT / ERXUDP) は
      // いつでも割り込んでくる。これを表の行として飲み込むと、
      //   ・計測値 (ERXUDP) が消える
      //   ・切断通知 (EVENT 26) を取りこぼして接続済みのまま止まる
      // という、症状から原因に辿り着けない壊れ方をする。
      // どのモードでも、割り込みは pending を保ったまま素通しさせる。
      if (isInterrupt(parsed)) {
        // EPANDESC (kv) は「明細行以外が来た時点で終わり」。
        // スキャン完了の EVENT 22 がまさにその終端なので、
        // 先に確定させてから素通ししないと、
        // 「EVENT 22 を受けた時点ではまだ PAN が 0 件」になってしまう
        // (スキャンのたびに『PAN が見つかりません』と誤判定する)。
        //
        // 表形式 (until-ok / lines) は OK か規定行数が終端なので、
        // 割り込みで確定させてはいけない。保ったまま素通しする。
        if (mode === 'kv') {
          out.push(finishPending(acc))
        }
        out.push(parsed)
        return out
      }

      // 別の複数行イベントが始まったら、いま組み立て中のものを確定して切り替える。
      // (EPANDESC は PAN を発見するたびに連続して飛んでくる)
      if (parsed.kind === 'multiline-start') {
        out.push(finishPending(acc))
        acc.pending = { name: parsed.name, mode: parsed.mode, expect: parsed.expect || 0 }
        acc.lines = []
        return out
      }

      if (mode === 'kv') {
        // EPANDESC の明細行はマニュアル 4.5 で固定。ホワイトリストで受ける。
        // 「コロンを含む行」を条件にすると、エコーバックされたコマンドまで
        // フィールドとして取り込んでしまう。
        if (EPANDESC_KEYS.test(t)) {
          acc.lines.push(t)
          return out
        }
        out.push(finishPending(acc))
      } else if (mode === 'lines') {
        acc.lines.push(t)
        if (acc.lines.length >= acc.pending.expect) {
          out.push(finishPending(acc))
          return out
        }
        return out
      } else if (mode === 'until-ok') {
        if (parsed.kind === 'ok' || parsed.kind === 'fail') {
          out.push(finishPending(acc))
          out.push(parsed)
          return out
        }
        acc.lines.push(t)
        return out
      }
    }

    if (parsed.kind === 'multiline-start') {
      acc.pending = { name: parsed.name, mode: parsed.mode, expect: parsed.expect || 0 }
      acc.lines = []
      return out
    }

    out.push(parsed)
    return out
  }

  /** 溜まっている複数行イベントを強制的に確定させる (タイムアウト時など)。 */
  function flush(acc) {
    var r = finishPending(acc)
    return r ? [r] : []
  }

  return {
    ERROR_CODES: ERROR_CODES,
    EVENTS: EVENTS,
    UDP_RESULT: UDP_RESULT,
    channelToMHz: channelToMHz,
    parseLine: parseLine,
    newAccumulator: newAccumulator,
    feed: feed,
    flush: flush,
    parseEpandesc: parseEpandesc,
    parseEedscan: parseEedscan,
    // lib/sk-results.js が使うもの
    REGISTERS: REGISTERS,
    TABLES: TABLES,
    EPANDESC_KEYS: EPANDESC_KEYS,
    normalizeRegister: normalizeRegister,
    isEpandescField: isEpandescField,
    // lib/sequencer.js と lib/runtime/outputs.js が使うもの
    isSecretCommand: isSecretCommand,
    maskSecretCommand: maskSecretCommand,
  }
})()

// Node-RED のノードから require して使う。
module.exports = SK
