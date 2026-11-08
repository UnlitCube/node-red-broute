'use strict'

// ============================================================================
//  フローへアダプタを足す
// ============================================================================
//
//  Node-RED の runtime API（@node-red/runtime の flows.getFlows / setFlows）を、deploymentType 'nodes'
//  （変更したノードだけ）で呼ぶ。エディタのデプロイ（POST /flows）が呼ぶのと同じ関数なので、
//  api/flows.js の mutex でエディタのデプロイと 1 本ずつになり、rev の照合（version_mismatch）もそのまま効く。
//  止まって作り直されるのは足した 2 つだけで、ほかのタブ・ほかの設定ノード・セッションには触らない。
//
//  足すもの（エディタの書き出しと同じ形。nodes/*.html の defaults と同じ名前・同じ型だけ。1 つでも違うと、
//  次にエディタでデプロイしたときに diffNodes が「変わった」と判定して作り直す）:
//    - 設定ノード wsuha-device（z なし = すべてのフローで使える。addFlow は z を付けるので使わない）
//    - B ルートノード wsuha-broute（専用タブ「B ルート（Web UI で追加）」に。wires は [[],[]]、y はタブの中で最も下 + 80）
//    - タブ（webUiTabId のタブが無ければ作る）
//  認証情報はフローの JSON にも flows_cred.json にも入れない（呼んだ側が credentials-store に先に書く）。
//
//  **弱み**: ノードに渡る RED（createNodeApi）には flows が無いので、読み込み済みの @node-red/runtime の実体を探す
//  （公式の道ではない）。探す順は require.cache の …/@node-red/runtime/lib/index.js →
//  require.main.require('@node-red/runtime') → require.main.require('node-red').runtime。
//  見つけたものが動いている Node-RED と同じ実体かは、m.httpNode === RED.httpNode と m._.nodes.getNode === RED.nodes.getNode の
//  両方で確かめる。同じでなければ使わない。
//  動作を確かめた版（VERIFIED_VERSIONS。3.1.3・4.0.9・4.1.2 で確かめた）だけで使う。
//  ほかの版は「確かめていません」で止め、画面はエディタへの案内に切り替える。
//
//  使えないとき（availability）:
//    NOT_AVAILABLE（503）… 実体が見つからない・確かめていない版
//    FLOWS_LOCKED（409）… セーフモード（setFlows が全体の開始に変わり、止めていたフローが全部動き出す）・
//                         Node-RED の settings.js の readOnly（保存されない）。プロジェクトのマージの途中は書くときに分かる
//
//  ここは画面の API・service から呼ぶ。検証（本文・台数・ポート・デバイスキー・PairID・1 本ずつ）は service.addAdapter が先に済ませる。

const path = require('path')
const crypto = require('crypto')
const { ApiError } = require('./errors')

/** 足した台の置き場所のタブ（和欧間に空白）。 */
const TAB_LABEL = 'B ルート（Web UI で追加）'
const TAB_INFO =
  'Web UI の「アダプタを追加」と、フローの add-adapter で追加したノードの置き場所です。\n' +
  '出力 1（計測値）・出力 2（状態の変化とイベント）を、ほかのノードへつないで使えます。ノードはほかのタブへ移しても構いません。'
/**
 * 画面からの追加を確かめた Node-RED の版。runtime の実体を探す道は公式ではないので、足せる・エディタの画面からのデプロイで
 * 作り直されない・ほかの台が止まらない、を本物で通してから広げる（test/runtime/flow-writer-embedded.test.js）。
 * 3.1.3・4.0.9・4.1.2 で通した。
 */
const VERIFIED_VERSIONS = /^(3\.1|4\.[01])\.\d+/

/** nodes/wsuha-device.html の defaults（名前・型・既定値）。試験で html と照らす。 */
const DEVICE_DEFAULTS = {
  name: '',
  enabled: true,
  role: '',
  mode: 'serial',
  serialport: '',
  serialbaud: 115200,
  deviceKey: '',
  expectedMac: '',
  pollInterval: 30,
  pollEpcs: 'E7, E8',
  slowIntervalSec: '',
  halfHourIntervalSec: '',
  autoStart: true,
  autoWriteWopt: true,
  scanDurations: '4,5,6,7,8',
  simulatorOptions: '',
}

/** nodes/wsuha-broute.html の defaults。 */
const BROUTE_DEFAULTS = {
  name: '',
  device: '',
  epcFilter: '',
  emitMeasurements: true,
  emitStatus: true,
  emitLogs: false,
  emitRaw: false,
  alertAfterFailures: 3,
  waitSec: 120,
}

const MSG = {
  notFound: 'この Node-RED では、画面からアダプタを追加できません。エディタで追加してください',
  version: (v) => `この Node-RED の版（${v || '不明'}）では、画面からの追加の動作を確かめていません。エディタで追加してください`,
  safe: 'Node-RED がセーフモードで動いているため、アダプタを追加できません（追加すると全部のフローが動き出します）。エディタでフローを開始してから試してください',
  readOnly: 'Node-RED の settings.js の readOnly が true なので、追加してもフローに保存されません。エディタで追加してください',
  merge: 'プロジェクトがマージの途中なので、フローを保存できません。エディタでマージを済ませてください',
  mismatch: 'エディタで同時にデプロイされました。もう一度押してください',
  save: 'アダプタを追加できませんでした（フローを保存できません）。Node-RED のログを確かめてください',
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

/**
 * runtime API の実体が、動いている Node-RED と同じものか。
 * @param {object} m @node-red/runtime の module.exports
 * @param {object} RED ノードに渡された RED
 */
function sameRuntime(m, RED) {
  if (!m || typeof m !== 'object' || !m.flows || typeof m.flows.getFlows !== 'function' || typeof m.flows.setFlows !== 'function') return false
  let httpNode
  try {
    httpNode = m.httpNode
  } catch (e) {
    return false
  }
  const nodes = m._ && m._.nodes
  return !!RED && !!RED.httpNode && httpNode === RED.httpNode && !!nodes && !!RED.nodes && nodes.getNode === RED.nodes.getNode
}

/**
 * 読み込み済みの @node-red/runtime の実体を探す。
 * @param {object} RED
 * @param {object} [deps] {cache（既定 require.cache）, mainRequire（既定 require.main.require）}（試験で差し替える）
 * @returns {{api: object|null, how: string|null, tried: string[]}}
 */
function findRuntimeApi(RED, deps) {
  const d = deps || {}
  const cache = d.cache || require.cache
  const tried = []
  const tail = path.join('@node-red', 'runtime', 'lib', 'index.js')
  const tailPosix = '@node-red/runtime/lib/index.js'
  for (const id of Object.keys(cache || {})) {
    if (!id.endsWith(tail) && !id.endsWith(tailPosix)) continue
    const entry = cache[id]
    const m = entry && entry.exports
    if (sameRuntime(m, RED)) return { api: m, how: 'require.cache', tried }
    tried.push('require.cache: 動いているものと別の実体')
  }
  const mainRequire =
    d.mainRequire !== undefined ? d.mainRequire : require.main && typeof require.main.require === 'function' ? (x) => require.main.require(x) : null
  const ways = [
    ['require.main.require("@node-red/runtime")', () => mainRequire('@node-red/runtime')],
    ['require.main.require("node-red").runtime', () => mainRequire('node-red').runtime],
  ]
  if (typeof mainRequire === 'function') {
    for (const [how, get] of ways) {
      try {
        const m = get()
        if (sameRuntime(m, RED)) return { api: m, how, tried }
        tried.push(how + ': 動いているものと別の実体')
      } catch (e) {
        tried.push(how + ': ' + (e && e.code ? e.code : '読めません'))
      }
    }
  }
  return { api: null, how: null, tried }
}

/**
 * @param {object} opts
 * @param {object} opts.RED
 * @param {function} [opts.log]       (level, text) Node-RED のログ
 * @param {object} [opts.runtimeApi]  試験用: 探さずにこれを使う（{flows: {getFlows, setFlows, getState?}, _?: {flows: {state}}}）
 * @param {function} [opts.version]   試験用: Node-RED の版（既定 RED.version()）
 * @param {object} [opts.deps]        試験用: findRuntimeApi の deps
 */
function createFlowWriter(opts) {
  const o = opts || {}
  const RED = o.RED || {}
  const log = typeof o.log === 'function' ? o.log : function () {}
  let found = o.runtimeApi ? { api: o.runtimeApi, how: 'injected', tried: [] } : null
  let triedLogged = false

  function versionNow() {
    try {
      const v = typeof o.version === 'function' ? o.version() : typeof RED.version === 'function' ? RED.version() : null
      return v === null || v === undefined ? null : String(v)
    } catch (e) {
      return null
    }
  }

  function runtimeApi() {
    if (found && found.api) return found.api
    const r = findRuntimeApi(RED, o.deps)
    if (r.api) {
      found = r
      return r.api
    }
    if (!triedLogged) {
      triedLogged = true
      log('warn', 'Web UI からの追加に使う Node-RED の runtime API が見つかりません（' + r.tried.join(' / ') + '）。エディタでの追加はふつうに使えます')
    }
    return null
  }

  /** 今のフローの状態（'start'・'stop'・'safe'。分からなければ null）。 */
  function flowsState() {
    const api = found && found.api ? found.api : null
    try {
      const f = api && api._ && api._.flows
      if (f && typeof f.state === 'function') return String(f.state())
    } catch (e) {
      /* 分からない */
    }
    return null
  }

  /**
   * いまセーフモードか。
   * 見るのはランタイムの本物の設定（api._.settings）。起動の途中からフローの状態が safe になる前も立っていて、
   * エディタでフローを開始すると消える。フローの状態だけを見ると、start から safe へ移る間に setFlows が通り、
   * 止めていたフローが全部動き出す。ノードに渡る RED.settings の safeMode は起動時の写しで、開始しても true のまま残る。
   * 本物の設定が読めない実体では、フローの状態が分からないときだけ写しを見て閉じる側に倒す。
   */
  function safeModeNow(api) {
    const state = flowsState()
    if (state === 'safe') return true
    try {
      const live = api && api._ && api._.settings
      if (live) return !!live.safeMode
    } catch (e) {
      /* 読めない */
    }
    return state === null && !!(RED.settings || {}).safeMode
  }

  /**
   * 使えるか（Meta.addAdapter.available と POST の 2 番目の確かめ）。
   * @returns {{available: boolean, reason: string|null, code: 'NOT_AVAILABLE'|'FLOWS_LOCKED'|null, version: string|null}}
   */
  function availability() {
    const version = versionNow()
    const api = runtimeApi()
    if (!api) return { available: false, reason: MSG.notFound, code: 'NOT_AVAILABLE', version }
    if (!(version && VERIFIED_VERSIONS.test(version))) {
      return { available: false, reason: MSG.version(version), code: 'NOT_AVAILABLE', version }
    }
    if (safeModeNow(api)) return { available: false, reason: MSG.safe, code: 'FLOWS_LOCKED', version }
    if ((RED.settings || {}).readOnly === true) return { available: false, reason: MSG.readOnly, code: 'FLOWS_LOCKED', version }
    return { available: true, reason: null, code: null, version }
  }

  /** ノードの id（16 桁の 16 進。Node-RED の RED.util.generateId と同じ形）。 */
  function newId() {
    try {
      if (RED.util && typeof RED.util.generateId === 'function') return String(RED.util.generateId())
    } catch (e) {
      /* 下へ */
    }
    return crypto.randomBytes(8).toString('hex')
  }

  /** setFlows の失敗を、画面とフローに返す形にする（原文は Node-RED のログにだけ。パスを含むため）。 */
  function mapSaveError(err) {
    if (err instanceof ApiError) return err
    const code = err && err.code ? String(err.code) : ''
    if (code === 'version_mismatch') return new ApiError(409, 'BUSY', MSG.mismatch)
    if (code === 'git_merge_conflict') return new ApiError(409, 'FLOWS_LOCKED', MSG.merge)
    log('warn', 'アダプタを追加できませんでした（フローを保存できません）: ' + (err && err.message ? err.message : String(err)))
    return new ApiError(500, 'INTERNAL', MSG.save)
  }

  /**
   * 足す（getFlows → 複製して足す → setFlows（'nodes'）。version_mismatch なら getFlows から 1 回だけやり直す）。
   * @param {object} spec
   *   spec.deviceId, spec.brouteId   … 先に決めた id（認証情報を先に書くため）
   *   spec.device                    … 設定ノードの項目（DEVICE_DEFAULTS の名前だけ。足りない項目は既定値）
   *   spec.broute                    … B ルートノードの項目（BROUTE_DEFAULTS の名前だけ。device は deviceId）
   *   spec.tabId                     … 置き場所のタブ（settings.json の webUiTabId。無い・消えたなら作る）
   *   spec.reqLog                    … 画面の要求の控え {user, path, ip}（Node-RED の監査 flows.set に、誰が変えたかを残す）
   * @returns {Promise<{deviceId, brouteId, tabId, tabLabel, tabCreated, tabDisabled, rev}>}
   */
  async function add(spec) {
    const av = availability()
    if (!av.available) throw new ApiError(av.code === 'FLOWS_LOCKED' ? 409 : 503, av.code, av.reason)
    const api = runtimeApi()
    const deviceId = String(spec.deviceId)
    const brouteId = String(spec.brouteId)
    for (let attempt = 0; ; attempt++) {
      let cur
      try {
        cur = await api.flows.getFlows({})
      } catch (err) {
        throw mapSaveError(err)
      }
      const flows = clone((cur && cur.flows) || [])
      const ids = new Set(flows.map((n) => n && n.id))
      if (ids.has(deviceId) || ids.has(brouteId)) {
        log('warn', 'アダプタを追加できませんでした: 新しいノードの id がフローの中の id と重なりました')
        throw new ApiError(500, 'INTERNAL', MSG.save)
      }
      let tab = spec.tabId ? flows.find((n) => n && n.type === 'tab' && n.id === spec.tabId) || null : null
      let tabCreated = false
      if (!tab) {
        let tid = newId()
        while (ids.has(tid) || tid === deviceId || tid === brouteId) tid = newId()
        tab = { id: tid, type: 'tab', label: TAB_LABEL, disabled: false, info: TAB_INFO }
        flows.push(tab)
        tabCreated = true
      }
      const ys = flows.filter((n) => n && n.z === tab.id && typeof n.y === 'number').map((n) => n.y)
      const y = ys.length ? Math.max.apply(null, ys) + 80 : 80
      const device = deviceNode(deviceId, spec.device)
      const broute = brouteNode(brouteId, tab.id, deviceId, spec.broute, y)
      flows.push(device, broute)
      try {
        // エディタのデプロイと同じ渡し方。flows.set の監査が見るのは req（user はストレージへ渡るだけ）
        const who = spec.reqLog || undefined
        const r = await api.flows.setFlows({ flows: { flows, rev: cur.rev }, deploymentType: 'nodes', user: who && who.user, req: who })
        return {
          deviceId,
          brouteId,
          tabId: tab.id,
          tabLabel: tab.label || TAB_LABEL,
          tabCreated,
          // 無効のタブのノードは動かない。利用者が無効にしたタブを勝手に変えず、呼んだ側が warnings で知らせる
          tabDisabled: tab.disabled === true,
          rev: r && r.rev ? String(r.rev) : null,
        }
      } catch (err) {
        if (err && err.code === 'version_mismatch' && attempt === 0) continue
        throw mapSaveError(err)
      }
    }
  }

  return { availability, flowsState, newId, add, TAB_LABEL }
}

/** 設定ノード（z なし）。項目は DEVICE_DEFAULTS の名前だけ・同じ型。 */
function deviceNode(id, values) {
  const v = values || {}
  const n = { id, type: 'wsuha-device' }
  for (const k of Object.keys(DEVICE_DEFAULTS)) {
    const def = DEVICE_DEFAULTS[k]
    const x = v[k]
    n[k] = x === undefined || x === null || typeof x !== typeof def ? def : x
  }
  return n
}

/** B ルートノード（専用タブ）。項目は BROUTE_DEFAULTS の名前だけ・同じ型と、z・x・y・wires。 */
function brouteNode(id, tabId, deviceId, values, y) {
  const v = values || {}
  const n = { id, type: 'wsuha-broute', z: tabId }
  for (const k of Object.keys(BROUTE_DEFAULTS)) {
    const def = BROUTE_DEFAULTS[k]
    const x = v[k]
    n[k] = x === undefined || x === null || typeof x !== typeof def ? def : x
  }
  n.device = deviceId
  n.x = 200
  n.y = y
  n.wires = [[], []]
  return n
}

module.exports = {
  createFlowWriter,
  findRuntimeApi,
  sameRuntime,
  deviceNode,
  brouteNode,
  DEVICE_DEFAULTS,
  BROUTE_DEFAULTS,
  TAB_LABEL,
  TAB_INFO,
  VERIFIED_VERSIONS,
}
