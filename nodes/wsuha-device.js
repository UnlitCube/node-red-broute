'use strict'

// ============================================================================
//  wsuha-device — Wi-SUN アダプタ 1 台を表す設定ノード
// ============================================================================
//
//  役割:
//    ・シリアルポート (またはシミュレーター) を 1 つだけ開く
//    ・B ルート認証情報を解決して保持する
//    ・Sequencer を 1 つ持ち、接続と定期取得を回す
//    ・registry の AdapterHandle に自分を載せる (Web UI・API・wsuha-broute はそこを見る)
//
//  設定ノードにしてある理由は 2 つ。
//
//  1. ポートの排他。物理ポートは 1 プロセスが 1 回だけ開ける。
//     ノードごとに開くと、2 つ目以降が失敗するか、取り合いになる。ここを共有点にする。
//
//  2. 認証情報。設定ノードの credentials は Node-RED が暗号化して
//     flows_cred.json に保存し、**書き出したフロー JSON には含めない**。
//     function ノードに平文で書く方式と違い、エクスポートしても漏れない。
//
//  寿命 (2.0):
//    **enabled (既定 true) ならポートを開く。使っているノードの数では開閉しない。**
//    1.x は「参照している wsuha-broute が 0 になったら閉じる」作りで、
//    wsuha-broute だけを部分デプロイしても SKTERM → 再接続が走っていた
//    (PANA セッションを畳むと、繋がり直すまで 1 分前後かかる)。
//    閉じるのは、この設定ノード自身が閉じるとき (設定の変更・削除・full デプロイ・停止) だけ。
//    wsuha-broute は sequencer ではなく AdapterHandle を購読するので、作り直す順序に関係なく値が届く。
//    一時的な上書き (停止・取得間隔・EPC) も handle が持ち越すので、設定ノードを作り直しても
//    (全体のデプロイ・設定ノードの変更・無効 → 有効) 残る。外れるのは Node-RED の再起動と、設定ノードの削除のときだけ。
//
//  構成 (2.0):
//    名前・契約・有効・接続先・ポート・ボーレート・デバイスキー・想定 MAC・自動開始・スキャン時間は、
//    画面 (PUT config) とフローの入力 (wsuha-broute の config) からも変えられる。効く値は
//      画面かフローで保存した値 (settings.json の adapters[id].config) > この設定ノードの値 > 既定値
//    (node.eff)。エディタで値を変えてデプロイした項目は、画面かフローの値を外す (configAtSet の照合)。
//    認証情報は 環境変数 > 画面かフローで保存した値 (credentials/<id>.json) > 設定ノード > 秘密ファイル。
//    接続に関わる項目 (接続先・ポート・ボーレート・デバイスキー・想定 MAC・認証情報) が変わったら、
//    **この台だけ** SKTERM してポートを閉じ、新しい値で開き直す (node._reconfigure)。AdapterHandle は同じものを使い続けるので、
//    wsuha-broute の購読は切れず、一時的な上書き (停止など) も detach → attach で引き継ぐ。
//    名前・契約・自動開始・スキャン時間は開き直さずに効かせる。有効を外したら閉じ、入れたら開く。

const path = require('path')
const fs = require('fs')
const { Sequencer, toEpc } = require('../lib/sequencer')
const { SerialTransport } = require('../lib/serial-transport')
const { SimulatorTransport } = require('../lib/simulator-transport')
const { getRegistry, metaFromConfig } = require('../lib/runtime/registry')
const httpApi = require('../lib/runtime/http-api')
const cf = require('../lib/runtime/config-fields')
const { fingerprint } = require('../lib/runtime/credentials-store')
const epcCatalog = require('../lib/runtime/epc-catalog')
const { byLabel } = require('../lib/runtime/service')
const { FIELDS: SETTING_FIELDS } = require('../lib/runtime/settings-store')

/** 画面に出す認証情報の出どころの名前 (画面かフローで保存した値)。 */
const STORED_SOURCE = '画面かフローで保存した値'

/**
 * シミュレーターの架空の認証情報。実機のメーターにつながる値ではない。
 * シミュレーターは電波もメーターも使わないので、接続先を選んでデプロイするだけで動くようにする。
 */
const SIMULATOR_CREDENTIALS = { id: '0123456789ABCDEF0123456789ABCDEF', password: 'ABCDEF123456', source: 'シミュレーターの架空の値' }

/** 履歴のプロパティ (1 件で 200 バイトを超える)。定期取得には入れない (運用設定の検証と同じ)。 */
const BULKY_EPCS = [0xe2, 0xe4, 0xec]

module.exports = function (RED) {
  const registry = getRegistry()

  // Web UI の API・SSE・画面を httpNode に登録する (このモジュール関数で 1 回だけ)。
  // 運用設定の照合・適用と、wsuha-broute の入力 (settings・diag など) が使う service もここで作る。
  // httpNodeRoot が false や wsuhaBroute.ui が false のときは、画面と API を載せずに service だけ作る。
  // 失敗しても設定ノード (計測) は動かす。
  let runtime = null
  try {
    runtime = httpApi.install(RED, { registry })
  } catch (err) {
    logRed('error', 'Web UI の API を登録できませんでした（計測は続けます）: ' + err.message)
  }

  // --- 使われていない設定ノードの知らせ ---------------------------------------
  // enabled の設定ノードは、使っているノードが 0 でもポートを開いて電波を使い続ける (2.0 の寿命)。
  // 予備のつもりなら『有効』を外してもらうため、デプロイが済んだ (flows:started) あとに
  // Node-RED のログへ warn を 1 回だけ出す。同じ状態のままのデプロイ (設定ノードの作り直しを含む) では繰り返さない。
  // 使われたら印を消し、また使われなくなったら 1 回だけ出す。
  const liveDevices = new Set()
  const warnedUnused = new Set()
  if (RED.events && typeof RED.events.on === 'function') {
    RED.events.on('flows:started', () => {
      try {
        warnUnusedDevices()
      } catch (err) {
        /* 知らせを出せなくても計測は続ける */
      }
    })
  }

  function warnUnusedDevices() {
    for (const node of liveDevices) {
      if (!node.enabled || node.handle.consumers > 0) {
        warnedUnused.delete(node.id)
        continue
      }
      if (warnedUnused.has(node.id)) continue
      warnedUnused.add(node.id)
      logRed(
        'warn',
        `${node.label}（${node.id}）: この設定ノードを使っているノードがありません。予備なら設定ノードの「有効」を外してください`
      )
    }
  }

  /**
   * 設定画面のポート一覧。{items, serialportMessage}。
   * items は画面の GET serialports と同じ候補 (by-id を先に。使っている台は ownedBy) から、シミュレーターの候補を除いたもの。
   * serialport を読み込めない環境では items が空で、serialportMessage に入れ方が入る
   * (エディタが「ポートが見つかりません」と言わずに済むように)。
   */
  RED.httpAdmin.get('/wsuha-broute/serialports', RED.auth.needsPermission('wsuha-device.read'), async (req, res) => {
    try {
      if (runtime) {
        const r = await runtime.service.serialPorts()
        res.json({ items: r.items.filter((x) => !x.simulator), serialportMessage: r.serialportMessage || null })
      } else res.json({ items: await SerialTransport.list(), serialportMessage: null })
    } catch (err) {
      res.json({ items: [], serialportMessage: null })
    }
  })

  /**
   * 設定画面が開いたときに読む、今の運用設定。形は画面の GET settings と同じ Settings。
   * 運用設定 (画面やフローで保存した値) が効いている項目に、その値と
   * 「ここで値を変えてデプロイすると、この項目の運用設定は外れます」を出すため。
   * エディタ用なので httpAdmin (エディタのログインと wsuha-device.read の権限) に置く。
   */
  RED.httpAdmin.get('/wsuha-broute/device/:id/settings', RED.auth.needsPermission('wsuha-device.read'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const h = registry.get(req.params && req.params.id)
      if (!runtime || !h || !h.claimed) {
        res.status(404).json({
          error: { code: 'ADAPTER_NOT_FOUND', message: 'まだデプロイしていない設定ノードです（デプロイすると運用設定を読めます）' },
        })
        return
      }
      res.json(runtime.service.settingsOf(h))
    } catch (err) {
      logRed('error', '運用設定を読めませんでした: ' + (err && err.stack ? err.stack : err))
      res.status(500).json({ error: { code: 'INTERNAL', message: '運用設定を読めませんでした。Node-RED のログを確かめてください' } })
    }
  })

  /**
   * 設定画面が開いたときに読む、今の構成。形は画面の GET config と同じ Config (認証情報の値は入らない)。
   * 画面かフローで変えた構成が効いている項目に、その値と「ここで値を変えてデプロイすると、この項目の画面の値は外れます」を出すため。
   */
  RED.httpAdmin.get('/wsuha-broute/device/:id/config', RED.auth.needsPermission('wsuha-device.read'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const h = registry.get(req.params && req.params.id)
      if (!runtime || !h || !h.claimed) {
        res.status(404).json({
          error: { code: 'ADAPTER_NOT_FOUND', message: 'まだデプロイしていない設定ノードです（デプロイすると接続の設定を読めます）' },
        })
        return
      }
      res.json(runtime.service.configOf(h))
    } catch (err) {
      logRed('error', '接続の設定を読めませんでした: ' + (err && err.stack ? err.stack : err))
      res.status(500).json({ error: { code: 'INTERNAL', message: '接続の設定を読めませんでした。Node-RED のログを確かめてください' } })
    }
  })

  function WsuhaDeviceNode(config) {
    RED.nodes.createNode(this, config)
    const node = this
    const service = runtime ? runtime.service : null
    const credStore = runtime ? runtime.credentials : null
    // wsuha-broute の入力 (settings・diag・detail など) が使う。画面の API と同じ service
    node.runtime = runtime
    node._closing = false
    node._reopening = null

    // --- registry ----------------------------------------------------------
    // handle は id ごとに 1 つ。再デプロイで設定ノードを作り直しても同じものを使う。
    const handle = registry.upsert(node.id)
    node.handle = handle

    // --- 構成: 画面かフローで保存した値 > この設定ノードの値 > 既定値 ---------
    // エディタで後から変えた項目は、画面かフローの値を外す (照合)。外したら、デプロイが済んだあと出力 2 に config
    const editorConfig = cf.configValuesFromNode(config)
    handle.editorConfig = editorConfig
    if (service) service.reconcileConfig(handle)
    else handle.configDropped = []
    node.eff = service ? service.effectiveConfigOf(handle) : cf.effectiveConfig(editorConfig, null)
    applyIdentity()

    // --- 認証情報 ------------------------------------------------------------
    // エディタで認証情報を入れ直した (保存したときの指紋と違う) なら、画面かフローで保存した値を外す。
    // エディタを空にしただけなら外さない (credentials-store の reconcile)
    const editorCred = node.credentials || {}
    let credDropped = false
    if (credStore) {
      try {
        credDropped = credStore.reconcile(node.id, editorCred.routeBId, editorCred.routeBPassword)
      } catch (err) {
        logRed('warn', `${node.label}: Web UI かフローで保存した認証情報を照合できませんでした（${err.code || 'ERROR'}）`)
      }
    }

    // 優先順位: 環境変数 → 画面かフローで保存した値 → 設定画面の credentials → 秘密ファイル
    //
    // 環境変数を最優先にしているのは、「フローを触らずに値を差し替えたい」需要が一番強いため。
    let resolved = resolveNow()
    if (credDropped) {
      // ログの文は、外したあとに実際に効く出どころから作る (環境変数が優先されていれば「設定ノードの値を使います」と書かない)
      const text = `設定ノードで認証情報を入れ直したため、Web UI かフローで保存した B ルートの認証 ID とパスワードを外しました（${effectiveText(resolved)}）`
      handle.log('warn', text)
      logRed('warn', `${node.label} (${node.id}): ${text}`)
      handle.configChanged('editor', null, { deferNodes: true })
    }
    // 見つからなかったときの詳しい理由 (秘密ファイルの絶対パス・読めなかった理由の原文) は
    // Node-RED のログにだけ出す。画面・SSE・出力 2 には describeSource() の安全な文だけを出す
    if (!resolved.source && resolved.detail && resolved.detail.length) {
      logRed('warn', `${node.label}: 認証情報の秘密ファイルを使えませんでした: ${resolved.detail.join(' / ')}`)
    }
    // 秘密ファイルは前の版から移ってきた環境のためのもので、平文のまま置かれる。動きは止めず、入れ直しを勧める
    if (resolved.fromSecretFile) {
      const text = `認証情報を${resolved.source}から読みました。秘密ファイルは移行用です。Web UI かエディタで入れ直してください`
      handle.log('warn', text)
      logRed('warn', `${node.label} (${node.id}): ${text}`)
    }

    // --- 5 分 / 30 分の取得の間隔 (2.0。空・1.x のフローは既定) ----------------
    // 範囲は運用設定の検証と同じ。外れていたら既定にして warn (エディタを通さずに書いたフロー)
    const tiers = {
      slowIntervalSec: tierInterval(node, config.slowIntervalSec, 'slowIntervalSec'),
      halfHourIntervalSec: tierInterval(node, config.halfHourIntervalSec, 'halfHourIntervalSec'),
    }

    // --- 定期取得の EPC (履歴の E2・E4・EC は外す) -------------------------
    // sequencer は履歴を含む一覧から履歴の 1 つだけを残すので、'E7, E2' だと毎回 E2 だけを取り、
    // 瞬時電力が取れなくなる。画面とフローの検証と同じく、履歴は定期取得に入れない。
    // 運用設定を外したときに戻る値 (configValues) も外したものにする
    const pollEpcs = configuredPollEpcs(node, config.pollEpcs)

    // 接続先が変わった (シミュレーター ⇔ 実機) なら、認証 ID が同じでも値の出どころは別物になる。
    // 持ち越した値を read に残すと、シミュレーターの値を本物の計測値として下流へ流してしまう。
    // handle はデプロイをまたいで残るので、前の接続先はそこに控える (値の写しは claim のあとに捨てる)
    const modeChanged = handle.meterMode !== undefined && handle.meterMode !== node.eff.mode
    handle.meterMode = node.eff.mode

    handle.claim(node, {
      meta: metaFromConfig(node.eff, node.id),
      credentialSource: describeSource(resolved),
      // 伏せ字のためだけに渡す (ログ・診断の行から消す)。handle のプロパティには置かれない
      secrets: [resolved.id, resolved.password],
      credentialId: resolved.id,
      credentialState: credentialState(),
      // 運用設定の照合 (configAtSet。4 項目すべて) と、外したときに戻す値
      configValues: {
        pollIntervalSec: blankToNull(config.pollInterval),
        pollEpcs: pollEpcs.configValue,
        slowIntervalSec: tiers.slowIntervalSec,
        halfHourIntervalSec: tiers.halfHourIntervalSec,
      },
      // 構成の照合と、画面とフローの変更を効かせる関数
      editorConfig,
      reconfigure: (next, info) => node._reconfigure(next, info),
      // 画面かフローで認証情報を保存したときに残す、エディタの認証情報の指紋 (値は閉じ込めたまま)
      editorFingerprint: (salt) => fingerprint(salt, editorCred.routeBId, editorCred.routeBPassword),
      onListenerError: (err) => node.error('受け手の処理で例外が起きました（計測は続けます）: ' + (err && err.message)),
    })
    if (modeChanged) handle.forgetSupported()

    // 運用設定 (画面やフローで変えた値) の照合。エディタで設定ノードの値を後から変えた項目は外す。
    // 外したら、wsuha-broute の出力 2 にはデプロイが済んだあと (flows:started) に settings が出る
    if (runtime) runtime.reconcile(handle)

    node.sequencer = null
    node._opening = null

    /** 効いている構成 (node.eff) から、表示と出力に使う名前を決める。 */
    function applyIdentity() {
      const e = node.eff
      node.enabled = e.enabled !== false
      node.deviceKey = e.deviceKey || node.id
      // この個体が何の契約を見ているか (動力 / 電力 など)。
      // 出力 JSON の device と、ダッシュボードの見出しに使う。
      //
      // どちらの契約に繋がるかを決めるのは USB ポートではなく **認証情報**。
      // SKSETRBID が認証 ID の下位 8 文字を Pairing ID として設定し、
      // SKSCAN はその PairID に一致する PAN しか見つけないため。
      // ポートはただの無線機なので、役割は認証情報と対で設定すること。
      node.role = e.role || null
      // ノードの表示に使う短い名前。/dev/ttyUSB0 → USB0
      node.portPath = e.mode === 'simulator' ? 'simulator' : e.serialport || ''
      node.portLabel = cf.portLabelOf(e.mode, node.portPath)
      // ログに出す名前。エディタの表示 (wsuha-device.html の label) と同じ順: 名前 → 契約 → ポートの短い名前
      node.label = e.name || e.role || node.portLabel || 'Wi-SUN アダプタ'
    }

    /** 認証情報を決める (効いている構成のデバイスキーと、画面かフローで保存した値で)。 */
    function resolveNow() {
      let stored = null
      try {
        stored = credStore ? credStore.read(node.id) : null
      } catch (err) {
        stored = null
      }
      const r = resolveCredentials(RED, node, node.eff, stored)
      node.credentialSource = r.source
      return r
    }

    /** 画面とフローに出す認証情報の状態 (値は入れない)。 */
    function credentialState() {
      return { configured: credentialsLookValid(resolved), envOverrides: resolved.source === '環境変数' }
    }

    // 組み立てを関数にしておく。
    //
    // _close() が sequencer を畳んで null にしたあとも、設定ノード自身はプロセスに残ることがある。
    // 作り直せる形にしておかないと、二度と復活しない (無効化 → 有効化・ノードの貼り直し・構成の変更)。
    node._build = function () {
      if (node.sequencer) return true
      if (!node.enabled || node._closing) return false
      const e = node.eff

      let transport
      try {
        transport =
          e.mode === 'simulator'
            ? new SimulatorTransport(simulatorOptionsOf(node, config.simulatorOptions))
            : new SerialTransport({
                path: e.serialport,
                baudRate: e.serialbaud || 115200,
                autoReconnect: true,
                reconnectMs: 5000,
              })
      } catch (err) {
        // B ルートノードが 1 つ登録するたびに、ここへ来る。同じ文でログを埋めない
        if (node._buildErrorText !== err.message) node.error('アダプタとの接続を用意できません: ' + err.message)
        node._buildErrorText = err.message
        handle.setBuildError(err)
        return false
      }
      node._buildErrorText = null

      const seq = new Sequencer(transport, {
        label: node.role || node.deviceKey,
        expectedMac: e.expectedMac || null,
        pollIntervalSec: toInt(config.pollInterval, 30),
        pollEpcs: pollEpcs.list || [0xe7, 0xe8],
        // null は既定値 (sequencer は undefined の項目で既定値を消さない)
        slowIntervalSec: tiers.slowIntervalSec === null ? undefined : tiers.slowIntervalSec,
        halfHourIntervalSec: tiers.halfHourIntervalSec === null ? undefined : tiers.halfHourIntervalSec,
        autoWriteWopt: config.autoWriteWopt !== false,
        scanDurations: Array.isArray(e.scanDurations) && e.scanDurations.length ? e.scanDurations.slice() : undefined,
      })
      node.sequencer = seq

      // 出どころは安全な文だけ (snapshot().credentials.source → 出力 2 の status にも出る)。
      // 見つからなければ、どこを探したかを残す
      seq.setCredentials(resolved.id, resolved.password, describeSource(resolved))

      seq.on('log', (entry) => {
        // Node-RED のログにも出す。level は自前の語彙なので寄せる。
        const text = handle.redact(entry.text)
        if (entry.level === 'error') node.error(text)
        else if (entry.level === 'warn') node.warn(text)
        else node.debug(text)
      })
      seq.on('error', (err) => node.error(handle.redact(err.message)))

      // handle に付ける。wsuha-broute・SSE・API は handle を見ている。
      // 前の sequencer で掛かっていた一時的な上書き (停止・取得間隔・EPC) は、handle がここで当て直す
      // (デプロイと構成の変更をまたいで残す)。引き継いだら Node-RED のログに 1 行残す
      const carried = handle.attach(seq)
      if (carried) node.warn(carried.text)
      // 画面やフローで変えた運用設定 (取得間隔など) を効かせる
      if (runtime) runtime.applyStored(handle, seq)
      return true
    }

    // --- 使っているノード ------------------------------------------------
    // 数を Web UI に出すだけ。ポートの開閉には使わない。
    node.register = function (consumer) {
      handle.addConsumer(consumer)
      // 畳まれていたら (_close のあと) 作り直す。動いているものは触らない
      // (外部の指示で止めているものを、ノードの貼り直しで動かさないため)。
      // 構成の変更で開き直している途中 (_reopening) は、その手順が開く
      if (node.enabled && !node.sequencer && !node._opening && !node._reopening) node._open()
    }

    node.unregister = function (consumer, done) {
      handle.removeConsumer(consumer)
      if (done) done()
    }

    /**
     * ポートを開いて (必要なら) 自動運転を始める。
     * @param {object} [opts] {resume} 構成の変更で開き直したとき、前に自動運転中だったなら autoStart に関係なく始める
     */
    node._open = function (opts) {
      if (!node.enabled || node._closing) return Promise.resolve()
      if (node._opening) return node._opening
      const resume = !!(opts && opts.resume)
      const run = async function () {
        // 一度畳まれていたら作り直す
        if (!node._build()) return
        const seq = node.sequencer
        const problems = seq.validateCredentials()
        if (problems.length) {
          node.warn('B ルートの認証 ID とパスワードが未設定か、書式が違います: ' + problems.join(' / '))
        }
        try {
          await seq.transport.open()
        } catch (err) {
          // ここで return しない。起動時にアダプタがまだ列挙されていない
          // (Node-RED が USB より先に立ち上がる・抜けていた) と、あとで開けても
          // 自動運転が始まらず「開 / 停止中」のまま黙って止まっていた。
          // 開けなくても自動運転は入れる。シーケンサが開き直しを待って再試行する。
          // serialport が無いときは、待っても直らない。文に次の一手が書いてあるので、そのまま出す
          const missing = err && err.code === 'SERIALPORT_MISSING'
          node.error(missing ? err.message : 'ポートを開けません（開けるまで再試行します）: ' + err.message)
        }
        if (node.sequencer !== seq) return // 開くのを待っている間に畳まれた
        // 停止の上書き (点検中など) を引き継いだ台は動かさない。全体のデプロイや設定ノードの変更で
        // 設定ノードを作り直しても、止めた台が勝手に電波を出し始めないように
        const held = seq.state && seq.state.overrides ? seq.state.overrides.stopped : null
        if ((node.eff.autoStart !== false || resume) && !problems.length && !held) {
          seq.start()
        }
      }
      node._opening = run()
        .catch((err) => node.error('ポートを開けません: ' + err.message))
        .then(() => {
          node._opening = null
        })
      return node._opening
    }

    node._close = async function () {
      const seq = node.sequencer
      if (!seq) return
      // SKTERM (6 秒の上限) → transport を閉じる → handle から外す、の順
      try {
        await seq.destroy()
      } finally {
        handle.detach(seq)
        if (node.sequencer === seq) node.sequencer = null
      }
    }

    /** 開き直しなどを 1 本だけ走らせる。走っている間は handle.reconfiguring（画面とフローの構成の変更は 409 BUSY）。 */
    function runExclusive(fn) {
      handle.setReconfiguring(true)
      const p = Promise.resolve()
        .then(fn)
        .catch((err) => node.error('接続の設定を反映できませんでした: ' + handle.redact(String((err && err.message) || err))))
        .then(() => {
          if (node._reopening === p) node._reopening = null
          handle.setReconfiguring(false)
        })
      node._reopening = p
      return p
    }

    /**
     * 画面かフローで変えた構成 (と認証情報) を効かせる (service が handle.reconfigure 経由で呼ぶ)。
     * @param {object|null} next 新しく効く構成 (config-fields の effectiveConfig)。null は認証情報だけが変わった
     * @param {object} [info] {by}
     * @returns {Promise} 開き直しが終わるまで (開き直さないときはすぐ)
     */
    node._reconfigure = function (next, info) {
      if (node._closing) return Promise.resolve(null)
      const prev = node.eff
      const target = next || prev
      const diff = cf.changedFields(prev, target)
      const before = resolved
      node.eff = target
      applyIdentity()
      resolved = resolveNow()
      const credValuesChanged = resolved.id !== before.id || resolved.password !== before.password
      // 認証情報が変わると、別のメーター (別の契約) に繋がりうる。前のメーターのプロパティマップは忘れる。
      // 接続先が変わったときも同じ (認証 ID が同じでも、シミュレーターの値を実機の値として read に残さない)
      if (credValuesChanged || diff.indexOf('mode') >= 0) handle.forgetSupported()
      handle.meterMode = node.eff.mode
      handle.updateInfo({
        meta: metaFromConfig(node.eff, node.id),
        credentialSource: describeSource(resolved),
        secrets: [resolved.id, resolved.password],
        credentialId: resolved.id,
        credentialState: credentialState(),
      })
      const who = byLabel(info && info.by)
      const seq = node.sequencer
      // 開き直さずに効かせるもの: 契約 (ログと出力の名前)・スキャン時間 (次のスキャンから)。自動開始は次に開くときに効く
      if (seq) {
        seq.options.label = node.role || node.deviceKey
        if (diff.indexOf('scanDurations') >= 0 && typeof seq.setScanDurations === 'function') seq.setScanDurations(node.eff.scanDurations)
      }
      if (diff.indexOf('enabled') >= 0) {
        if (!node.enabled) {
          return runExclusive(async () => {
            await node._close()
            handle.log('info', `${who}から無効にしたので、ポートを閉じました`)
            logRed('info', `${node.label}（${node.id}）: ${who}から無効にしたので、ポートを閉じました`)
          })
        }
        handle.log('info', `${who}から有効にしたので、ポートを開きます`)
        logRed('info', `${node.label}（${node.id}）: ${who}から有効にしたので、ポートを開きます`)
        return runExclusive(() => node._open())
      }
      if (!node.enabled) return Promise.resolve(null) // 無効のまま: 次に有効にしたとき新しい値で開く
      const changed = diff.filter((k) => cf.CONNECTION_FIELDS.indexOf(k) >= 0).map((k) => cf.CONFIG_FIELDS[k].label)
      if (credValuesChanged) changed.push('認証 ID とパスワード')
      if (changed.length) {
        const wasRunning = !!(seq && seq.isRunning())
        const text = `${who}から${changed.join('・')}を変えたので、この台だけ接続し直します（SKTERM してポートを閉じ、新しい値で開きます）`
        handle.log('info', text)
        logRed('info', `${node.label} (${node.id}): ${text}`)
        return runExclusive(async () => {
          // 前の open (設定ノードを作ったときのものなど) がまだ終わっていなければ、終わるのを待ってから閉じる。
          // 待たずに閉じると、続く _open が古い _opening を返し、古い run は「待つ間に畳まれた」で抜けるので、
          // 新しい sequencer ができないまま開き直しが終わり、次のデプロイまで黙って計測が止まっていた
          await Promise.resolve(node._opening).catch(() => {})
          const running = wasRunning || !!(node.sequencer && node.sequencer.isRunning())
          await node._close()
          if (!node._closing) await node._open({ resume: running })
        })
      }
      // 値が同じで出どころの名前だけ変わった (例: 画面で保存した値が設定ノードと同じ)
      if (seq && resolved.source !== before.source) seq.setCredentials(resolved.id, resolved.password, describeSource(resolved))
      return Promise.resolve(null)
    }

    node.on('close', function (removed, done) {
      node._closing = true
      liveDevices.delete(node)
      // フローから消えたら印も消す (同じ id で作り直したときは、印を残して繰り返さない)
      if (removed) warnedUnused.delete(node.id)
      // 構成の変更で開き直している途中なら、それが終わってから閉じる (閉じたあとに開かないように)
      Promise.resolve(node._reopening)
        .catch(() => {})
        .then(() => node._close())
        .catch((err) => node.error('閉じるときに失敗しました: ' + err.message))
        .then(() => {
          // 削除したなら、持ち越していた一時的な上書きも捨てる (捨てたらログに 1 行)
          const dropped = handle.release(node, removed)
          if (dropped) logRed('info', `${node.label} (${node.id}): ${dropped.text}`)
          done()
        })
    })

    liveDevices.add(node)
    if (node.enabled) {
      node._open()
    } else if (handle.enabledBy && handle.enabledBy.source === 'runtime') {
      // 画面かフローで外した台。エディタの「有効」を変えずにデプロイしても、画面かフローの値が効いたまま (後勝ち) なので、
      // 戻し方は画面かフローで案内する
      handle.log(
        'info',
        `${handle.enabledBy.label || '画面かフロー'}で無効にしているため、ポートを開きません` +
          '（画面の設定タブの「アダプタと接続」で「有効」に印を付けて保存するか、フローの config で {enabled: true} を送ると開きます）'
      )
    } else {
      handle.log('info', '設定ノードで無効にしているため、ポートを開きません')
    }
  }

  RED.nodes.registerType('wsuha-device', WsuhaDeviceNode, {
    // Node-RED が暗号化して flows_cred.json に保存する。
    // 書き出したフロー JSON には入らない。
    // 認証 ID も password の型にする。text の型は GET /credentials/wsuha-device/<id> が値を返すので、
    // read の権限の利用者と、adminAuth の無いサーバーの匿名に読まれる。flows_cred.json の形は型で変わらない
    credentials: {
      routeBId: { type: 'password' },
      routeBPassword: { type: 'password' },
    },
    // エディタ (RED.settings.wsuhaDeviceWebUi) へ、画面を載せたかどうかを渡す。
    // エディタに届く httpNodeRoot は、サーバーが false でも '/' になり (getRuntimeSettings)、
    // settings.js の wsuhaBroute.ui も届かない。渡さないと、画面の無いサーバーでも 404 のリンクが出る。
    // 名前は型の名前 (wsuhaDevice) で始める (Node-RED の registerNodeSettings の規則)
    settings: {
      wsuhaDeviceWebUi: { value: webUiState(runtime), exportable: true },
      // 「定期的に取りに行く値」の欄の下に名前つきのチェックの一覧を出すための EPC の表 (履歴は入れない)
      wsuhaDeviceEpcCatalog: { value: epcCatalog.catalog(), exportable: true },
      // 編集画面の検証の範囲 (取得間隔・名前の長さ・通信速度の選択肢など)。運用設定と構成の検証 (settings-store の FIELDS・
      // config-fields の CONFIG_FIELDS) から作る。HTML に数字を直書きしない (FIELDS を変えたら編集画面も変わる)
      wsuhaDeviceRanges: { value: editorRanges(), exportable: true },
    },
  })

  /**
   * 編集画面 (wsuha-device.html) に渡す検証の範囲。値は settings-store の FIELDS と config-fields の CONFIG_FIELDS・BAUDS そのもの。
   * 形: {pollIntervalSec, slowIntervalSec, halfHourIntervalSec: {min, max, default}, pollEpcs: {min, max, bulky},
   *      name・role・deviceKey: {maxLength}, scanDurations: {min, max, maxItems, default}, bauds: number[], defaultBaud}
   */
  function editorRanges() {
    const sec = (f) => ({ min: f.min, max: f.max, default: f.default })
    const C = cf.CONFIG_FIELDS
    return {
      pollIntervalSec: sec(SETTING_FIELDS.pollIntervalSec),
      slowIntervalSec: sec(SETTING_FIELDS.slowIntervalSec),
      halfHourIntervalSec: sec(SETTING_FIELDS.halfHourIntervalSec),
      pollEpcs: { min: SETTING_FIELDS.pollEpcs.min, max: SETTING_FIELDS.pollEpcs.max, bulky: BULKY_EPCS.map((n) => n.toString(16).toUpperCase()) },
      name: { maxLength: C.name.maxLength },
      role: { maxLength: C.role.maxLength },
      deviceKey: { maxLength: C.deviceKey.maxLength },
      scanDurations: { min: C.scanDurations.min, max: C.scanDurations.max, maxItems: C.scanDurations.maxItems, default: C.scanDurations.default.slice() },
      bauds: cf.BAUDS.slice(),
      defaultBaud: C.serialbaud.default,
    }
  }

  // =========================================================================

  /**
   * 編集画面の「Web UI で開く」に渡す、画面を載せたかどうか。{available, reason}。
   * reason は settings.js の何が理由かの文だけ (サーバーのパスは入れない)。
   */
  function webUiState(rt) {
    if (!rt) return { available: false, reason: 'Web UI の API を登録できませんでした（Node-RED のログを確かめてください）' }
    if (!rt.mounted) return { available: false, reason: rt.notMountedReason || 'Web UI を載せていません' }
    if (rt.uiProblem) return { available: false, reason: 'Web UI のファイル（ui/index.html）がありません。パッケージを入れ直してください' }
    return { available: true, reason: null }
  }

  function logRed(level, text) {
    try {
      if (RED.log && typeof RED.log[level] === 'function') RED.log[level]('[wsuha-broute] ' + text)
    } catch (e) {
      /* ログに出せなくても続ける */
    }
  }

  /**
   * 画面・SSE・出力 2 に出す認証情報の出どころ (値は入れない)。
   * 「環境変数」「設定ノード」「ファイル（<ファイル名>）」と、読めなかった理由を日本語にしたものだけ。
   * 秘密ファイルの絶対パスと、読めなかったときの err.message (JSON.parse の文は入力の断片を含む) は入れない
   *。詳しい理由は resolved.detail にあり、Node-RED のログにだけ出す。
   */
  function describeSource(resolved) {
    if (resolved.source) return resolved.source
    return '見つかりません → ' + (resolved.tried || []).join(' / ')
  }

  function blankToNull(v) {
    if (v === undefined || v === null) return null
    if (typeof v === 'string' && v.trim() === '') return null
    return v
  }

  /** 積算 / 定時積算の取得間隔の範囲 [秒]。運用設定の検証 (settings-store の FIELDS) と同じもの (写しを持たない)。 */
  const TIER_RANGE = {
    slowIntervalSec: { min: SETTING_FIELDS.slowIntervalSec.min, max: SETTING_FIELDS.slowIntervalSec.max, def: SETTING_FIELDS.slowIntervalSec.default, label: '積算の取得間隔' },
    halfHourIntervalSec: {
      min: SETTING_FIELDS.halfHourIntervalSec.min,
      max: SETTING_FIELDS.halfHourIntervalSec.max,
      def: SETTING_FIELDS.halfHourIntervalSec.default,
      label: '定時積算の取得間隔',
    },
  }

  /**
   * 設定ノードの 5 分 / 30 分の間隔。空 (1.x のフローは項目なし) は null = 既定値。
   * 整数でない・範囲の外も null にして warn する (sequencer に変な間隔で撃たせない)。
   */
  function tierInterval(node, v, field) {
    const raw = blankToNull(v)
    if (raw === null) return null
    const r = TIER_RANGE[field]
    const n = typeof raw === 'number' ? raw : /^\s*\d+\s*$/.test(String(raw)) ? parseInt(raw, 10) : NaN
    if (!Number.isInteger(n) || n < r.min || n > r.max) {
      node.warn(`${r.label} ${String(raw).slice(0, 20)} 秒は範囲（${r.min}〜${r.max} 秒）の外なので、既定の ${r.def} 秒を使います`)
      return null
    }
    return n
  }


  /**
   * 設定ノードの定期取得の EPC。履歴 (E2・E4・EC) を外し、外したら warn する。
   * @returns {{list: number[]|null, configValue: string|null}}
   *   list は sequencer に渡す一覧 (無ければ null = 既定の E7)。
   *   configValue は運用設定の照合 (configAtSet) と、運用設定を外したときに戻す値。
   *   履歴が無ければ設定ノードの値そのまま (1.x と同じ)。外したら残りを 'E7, E8' の形で (残りが無ければ null)
   */
  function configuredPollEpcs(node, raw) {
    const parsed = parseEpcList(raw)
    const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0')
    // 読めない要素 ('0E7'・'E7Z' など) は、捨てて warn する。読み方は運用設定 (settings-store) と同じ
    // sequencer の toEpc (16 進 1〜2 桁。0x は付けてもよい) にそろえる。読み方が違うと、運用設定を外したときに
    // 戻す値と食い違い、settings-reset で E7 が外れる
    if (parsed.bad.length) {
      node.warn(
        `定期的に取りに行く値の ${parsed.bad.map((s) => s.slice(0, 16)).join('・')} は EPC として読めないので外しました` +
          `（16 進 2 桁で書いてください。例: E7, E8）。` +
          (parsed.list.length ? `残り: ${parsed.list.map(hex).join(', ')}` : '残りが無いので既定の E7 を取ります')
      )
    }
    if (!parsed.list.length) return { list: null, configValue: parsed.bad.length ? null : blankToNull(raw) }
    const kept = parsed.list.filter((n) => BULKY_EPCS.indexOf(n) < 0)
    if (kept.length === parsed.list.length) {
      // 設定ノードの値そのまま (1.x と同じ)。読めない要素を外したときは、残りを 'E7, E8' の形で
      return { list: kept, configValue: parsed.bad.length ? kept.map(hex).join(', ') : blankToNull(raw) }
    }
    const removed = parsed.list.filter((n) => BULKY_EPCS.indexOf(n) >= 0).map(hex)
    node.warn(
      `定期的に取りに行く値から履歴（${removed.join('・')}）を外しました。履歴は定期的に取れません` +
        `（1 件が大きく、ほかの値と一緒に取れないため）。` +
        (kept.length ? `残り: ${kept.map(hex).join(', ')}` : '残りが無いので既定の E7 を取ります')
    )
    return { list: kept.length ? kept : null, configValue: kept.length ? kept.map(hex).join(', ') : null }
  }

  /**
   * B ルート認証情報を決める。
   *
   * 1. 環境変数  WSUHA_BROUTE_ID[_<KEY>] / WSUHA_BROUTE_PASSWORD[_<KEY>]
   * 2. 画面かフローで保存した値 (<userDir>/wsuha-broute/credentials/<id>.json)
   * 3. 設定ノードの credentials (Node-RED が暗号化保存)
   * 4. 秘密ファイル <userDir>/wsuha-broute-<KEY>.secret.json
   * 5. 接続先がシミュレーターで、1〜4 のどれにも手がかりが無いときだけ、架空の値
   *
   * 4 は、秘密ファイルを置いて動かしていた環境をそのまま動かすために残してある。
   * KEY は効いている構成のデバイスキー (画面で変えたらその値)。
   *
   * 戻り値の source と tried は画面に出る (describeSource)。ここに絶対パスや err.message を入れない。
   * detail は Node-RED のログにだけ出す詳しい理由。
   */
  function resolveCredentials(RED, node, eff, stored) {
    const key = String((eff && eff.deviceKey) || '').trim()
    const suffix = key ? '_' + key.toUpperCase() : ''

    const envId = pickEnv('WSUHA_BROUTE_ID' + suffix) || pickEnv('WSUHA_BROUTE_ID')
    const envPw = pickEnv('WSUHA_BROUTE_PASSWORD' + suffix) || pickEnv('WSUHA_BROUTE_PASSWORD')
    if (envId && envPw) {
      return { id: envId, password: envPw, source: '環境変数' }
    }

    if (stored && stored.id && stored.password) {
      return { id: stored.id, password: stored.password, source: STORED_SOURCE }
    }

    const cred = node.credentials || {}
    if (cred.routeBId && cred.routeBPassword) {
      return { id: cred.routeBId, password: cred.routeBPassword, source: '設定ノード' }
    }

    // 秘密ファイル (移行用)。
    // userDir と Node-RED の作業ディレクトリは一致しないことがある
    // (起動の仕方によって cwd がホームのまま、ということが実際にある)。
    // file ノードで書いたファイルは cwd 基準になるので、候補を順に見る。
    const fileName = `wsuha-broute-${key}.secret.json`
    const fileLabel = `ファイル（${fileName}）`
    const detail = []
    let worst = null
    if (key) {
      const dirs = [RED.settings.userDir, process.cwd(), process.env.HOME].filter(Boolean)
      for (const dir of Array.from(new Set(dirs))) {
        const file = path.join(dir, fileName)
        let text
        try {
          text = fs.readFileSync(file, 'utf8')
        } catch (err) {
          detail.push(`${file} (${err.code || err.message})`)
          worst = worse(worst, err.code === 'ENOENT' ? 'ENOENT' : err.code === 'EACCES' || err.code === 'EPERM' ? 'EACCES' : 'OTHER')
          continue
        }
        let body
        try {
          body = JSON.parse(text)
        } catch (err) {
          // JSON.parse の文は入力の断片 (= 認証 ID やパスワード) を引用することがある (Node 20 以上の V8)。
          // 理由は分類だけにする (credentials-store の退避と同じ)
          detail.push(`${file}（JSON として読めません）`)
          worst = worse(worst, 'PARSE')
          continue
        }
        const entry = body && typeof body === 'object' ? body[key] || body : null
        if (entry && entry.id && entry.password) {
          return { id: entry.id, password: entry.password, source: fileLabel, fromSecretFile: true }
        }
        detail.push(`${file}（id か password がありません）`)
        worst = worse(worst, 'EMPTY')
      }
    }

    // シミュレーターの最後の手段。入れかけの値 (ID だけなど) と読めない秘密ファイルがあるときは使わない。
    // 黙って架空の値でつなぐと、入れ間違いに気づけないため
    const untouched = !envId && !envPw && !cred.routeBId && !cred.routeBPassword && (!worst || worst === 'ENOENT')
    if (eff && eff.mode === 'simulator' && untouched) return Object.assign({}, SIMULATOR_CREDENTIALS)

    // 見つからなかった理由を残す。
    // 「なぜ認証情報が見つからないのか」は必ず聞かれるので、
    // どこを探したかが分かる形にしておく (画面に出してよい形で)。
    const envState = envId ? 'ID だけ' : envPw ? 'パスワードだけ' : '未設定'
    const cfgState = cred.routeBId ? 'ID だけ' : cred.routeBPassword ? 'パスワードだけ' : '未入力'
    return {
      id: cred.routeBId || null,
      password: cred.routeBPassword || null,
      source: null,
      tried: [
        // デバイスキーが空の台は、探す環境変数が 1 つだけ。同じ名前を 2 度並べない
        suffix ? `環境変数（WSUHA_BROUTE_ID${suffix} / WSUHA_BROUTE_ID）: ${envState}` : `環境変数（WSUHA_BROUTE_ID）: ${envState}`,
        `${STORED_SOURCE}: 未保存`,
        `設定ノード: ${cfgState}`,
        key ? `${fileLabel}: ${FILE_REASON[worst || 'ENOENT']}` : 'ファイル: デバイスキーが未設定なので探していません',
      ],
      detail,
    }
  }

  /** 画面の値を外したあとに効く出どころの文 (ログ用。値は入れない)。 */
  function effectiveText(r) {
    if (!r || !r.source) return '効く認証情報がありません。設定ノードか Web UI で入れてください'
    if (r.source === '環境変数') return 'いま効いているのは環境変数の値です'
    return `いま効いているのは${r.source}${r.source.endsWith('値') ? '' : 'の値'}です`
  }

  /** 秘密ファイルを読めなかった理由 (code) を、画面に出す日本語にする。 */
  const FILE_REASON = {
    ENOENT: '見つかりません',
    EACCES: '読めません',
    OTHER: '読めません',
    EMPTY: '認証 ID かパスワードがありません',
    PARSE: '形式が正しくありません',
  }
  // 候補の場所が複数あるので、いちばん手がかりになる理由を出す (見つからない < 読めない < 中身が足りない < 形式の誤り)
  const REASON_RANK = { ENOENT: 0, OTHER: 1, EACCES: 2, EMPTY: 3, PARSE: 4 }
  function worse(a, b) {
    if (!a) return b
    return REASON_RANK[b] > REASON_RANK[a] ? b : a
  }

  /** sequencer の validateCredentials と同じ形か (sequencer の無い無効の台でも「設定済み」を出すため)。 */
  function credentialsLookValid(r) {
    const id = r && r.id ? String(r.id).trim().toUpperCase() : ''
    const pw = r && r.password ? String(r.password).trim().toUpperCase() : ''
    return /^[0-9A-F]{32}$/.test(id) && /^[0-9A-Z]{12}$/.test(pw)
  }

  function pickEnv(name) {
    const v = process.env[name]
    if (v === undefined || v === null) return null
    const s = String(v).trim()
    return s === '' ? null : s
  }

  function toInt(v, fallback) {
    const n = parseInt(v, 10)
    return isNaN(n) ? fallback : n
  }

  function parseJson(s) {
    if (!s) return null
    try {
      return typeof s === 'string' ? JSON.parse(s) : s
    } catch (err) {
      return null
    }
  }

  /**
   * 模擬設定 (simulatorOptions) を読む。空は既定の動き。
   * 読めないときも既定の動きで続けるが、閉じ括弧の忘れなどで「効いているつもり」のまま黙って既定値で動かないように、
   * Node-RED のログへ 1 回だけ知らせる (_build はポートを開き直すたびに通るので、同じ文でログを埋めない)。
   */
  function simulatorOptionsOf(node, raw) {
    if (blankToNull(raw) === null) return {}
    const options = parseJson(raw)
    if (options && typeof options === 'object' && !Array.isArray(options)) return options
    if (!node._simulatorOptionsWarned) {
      node._simulatorOptionsWarned = true
      node.warn('模擬設定を JSON のオブジェクトとして読めないので、シミュレーターは既定の動きをします。設定ノードの詳細設定で直してください（例: {"meter":{"power":1200}}）')
    }
    return {}
  }

  /**
   * 設定ノードの「定期取得のプロパティ」の文字 ('E7, E8') を EPC の数の並びにする。
   * 読み方は運用設定の照合 (settings-store の normalizeConfigValue) と同じ sequencer の toEpc。重なりは 1 つに。
   * @returns {{list: number[], bad: string[]}} bad は読めなかった要素 (warn に出す)
   */
  function parseEpcList(s) {
    const list = []
    const bad = []
    if (s === undefined || s === null || s === '') return { list, bad }
    for (const part of String(s).split(/[\s,]+/)) {
      if (!part) continue
      const n = toEpc(part)
      if (n === null) bad.push(part)
      else if (list.indexOf(n) < 0) list.push(n)
    }
    return { list, bad }
  }
}
