'use strict'

// ============================================================================
//  運用設定（<userDir>/wsuha-broute/settings.json）
// ============================================================================
//
//  Web UI から変えた取得間隔などを、再起動をまたいで残す。秘密は入れない。
//
//    {version:1, adapters:{"<設定ノードの id>":{rev, updatedAt, updatedBy,
//        fields:{pollIntervalSec:{value, configAtSet, by, at}, …}}}}
//
//  - 書くとき: .tmp に書いて rename。前の版は .bak に写す。ディレクトリ 700・ファイル 600。
//  - 壊れていたら .bad-<日時> に退避して空で始める（止まらない）。
//  - rev は保存のたびに変わる。If-Match と違えば REVISION_MISMATCH。
//  - configAtSet: 保存したときの設定ノードの値。起動時に今の値と違えば
//    （エディタで後から変えた）その項目の運用設定を外す（reconcile）。
//  - updatedBy / by は人の名前ではなく経路（画面に独自のログインが無いため）:
//    'web-ui'（画面）・'flow:<wsuha-broute ノードの名前か id>'（フローの入力）・'editor'（照合で外した）。
//
//  構成も同じファイルの同じ記録に、運用設定と同じ規則で持つ:
//
//    adapters[id].config = {name:{value, configAtSet, by, at}, serialport:{…}, …}
//    adapters[id].configRev・configUpdatedAt・configUpdatedBy
//
//  rev は運用設定（rev）と構成（configRev）で別にする。画面が運用設定を保存しても、開いている構成の欄が
//  412 にならないように（逆も同じ）。運用設定を全部外しても構成は残し、構成を全部外しても運用設定は残す。
//  B ルートの認証情報はここに入れない（credentials-store.js。<userDir>/wsuha-broute/credentials/<id>.json）。
//
//  画面かフローで足した台の印も同じファイルに持つ:
//
//    adapters[id].created = {by, at, brouteId, tabId}      … 足した経路・時刻・B ルートノードと置き場所のタブの id
//    webUiTabId                                            … 足した台の置き場所のタブ（「B ルート（Web UI で追加）」）の id
//
//  照合（reconcile・reconcileConfig）は、無い（null）と既定値を同じとみなして比べる。
//
//  ファイル操作は同期で行う。小さなファイルを稀に書くだけなので、
//  同じプロセスの中で読み書きが混ざらないことを優先する。

const fs = require('fs')
const path = require('path')
const { DEFAULTS, toEpc } = require('../sequencer')
const { CONFIG_FIELDS, CONFIG_FIELD_NAMES, normalizeConfigField } = require('./config-fields')

const VERSION = 1
const BULKY = ['0xE2', '0xE4', '0xEC']

/**
 * 運用設定で変えられる項目。min/max は値（pollEpcs は個数）。
 * tier は基本設定 / 詳細設定（割り振りの正はここと config-fields の CONFIG_FIELDS）。
 * label は画面・エディタ・README で使う言葉（そろえる）。
 */
const FIELDS = {
  pollIntervalSec: { label: '取得間隔', min: 15, max: 3600, unit: '秒', default: DEFAULTS.pollIntervalSec, tier: 'basic' },
  pollEpcs: { label: '定期的に取りに行く値', min: 1, max: 6, default: DEFAULTS.pollEpcs.map(epcHex), tier: 'basic' },
  slowIntervalSec: { label: '積算の取得間隔', min: 60, max: 3600, unit: '秒', default: DEFAULTS.slowIntervalSec, tier: 'advanced' },
  halfHourIntervalSec: {
    label: '定時積算の取得間隔',
    min: 300,
    max: 7200,
    unit: '秒',
    default: DEFAULTS.halfHourIntervalSec,
    tier: 'advanced',
  },
}
const FIELD_NAMES = Object.keys(FIELDS)

/**
 * 照合で比べる形: 無い（null）は既定値とみなす。
 * 設定ノードに項目が無い（1.x・生成器の形）ときに画面で保存し、あとでエディタが同じ既定値を書いた
 * （「完了」を押すと enabled: true が入る）だけで、画面の値を外さないため。
 */
function withDefault(def, v) {
  return v === null || v === undefined ? (def ? def.default : null) : v
}

function epcHex(n) {
  return '0x' + ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
}

let revCounter = 0
function newRev(now) {
  revCounter = (revCounter + 1) % 1679616 // 36^4
  return (now || Date.now()).toString(36) + '-' + revCounter.toString(36)
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

function canonical(v) {
  return JSON.stringify(v === undefined ? null : v)
}

/** 値を比べられる形にそろえる（pollEpcs は '0xE7' の配列、数は整数、無ければ null）。 */
function normalizeConfigValue(field, v) {
  if (v === undefined || v === null || v === '') return null
  if (field === 'pollEpcs') {
    const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/))
      .map((x) => (typeof x === 'string' ? x.trim() : x))
      .filter((x) => x !== '' && x !== null && x !== undefined)
      .map(toEpc)
      .filter((n) => n !== null)
    return list.length ? list.map(epcHex) : null
  }
  const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function isIntegerLike(v) {
  if (typeof v === 'number') return Number.isInteger(v)
  return typeof v === 'string' && /^\s*\d+\s*$/.test(v)
}

/**
 * PUT の本文を検査する。
 * @returns {{changes: object, errors: object}} changes の値が null の項目は「運用設定を外す」
 */
function validateSettingsInput(body) {
  const changes = {}
  const errors = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors._ = '本文は JSON のオブジェクトで送ってください'
    return { changes, errors }
  }
  const keys = Object.keys(body)
  for (const k of keys) {
    if (FIELD_NAMES.indexOf(k) < 0) errors[k] = 'この項目は変えられません'
  }
  for (const k of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue
    const v = body[k]
    if (v === null) {
      changes[k] = null
      continue
    }
    const def = FIELDS[k]
    if (k === 'pollEpcs') {
      if (!Array.isArray(v)) {
        errors[k] = 'EPC の配列で指定してください（例: ["E7", "E8"]）'
        continue
      }
      if (v.length < def.min || v.length > def.max) {
        errors[k] = `${def.min}〜${def.max} 個で指定してください`
        continue
      }
      const out = []
      let bad = null
      for (const x of v) {
        const n = typeof x === 'string' || typeof x === 'number' ? toEpc(x) : null
        if (n === null) {
          bad = `EPC を 16 進で指定してください（例: "E7"）: ${String(x).slice(0, 16)}`
          break
        }
        const h = epcHex(n)
        if (BULKY.indexOf(h) >= 0) {
          bad = `${h.slice(2)} は履歴のため、定期的に取りに行く値にできません`
          break
        }
        if (out.indexOf(h) >= 0) {
          bad = `${h.slice(2)} が重複しています`
          break
        }
        out.push(h)
      }
      if (bad) errors[k] = bad
      else changes[k] = out
      continue
    }
    if (!isIntegerLike(v)) {
      errors[k] = `${def.min}〜${def.max} の整数で指定してください`
      continue
    }
    const n = typeof v === 'number' ? v : parseInt(v, 10)
    if (n < def.min || n > def.max) {
      errors[k] = `${def.min}〜${def.max} の整数で指定してください`
      continue
    }
    changes[k] = n
  }
  if (!keys.length) errors._ = '変える項目がありません'
  return { changes, errors }
}

function stamp(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

class RevisionMismatch extends Error {
  constructor(current) {
    super('ほかの場所で先に変更されました。読み直してください')
    this.name = 'RevisionMismatch'
    this.code = 'REVISION_MISMATCH'
    this.currentRev = current
  }
}

/**
 * @param {object} opts
 * @param {string|null} opts.file  settings.json の絶対パス。null なら保存しない（メモリだけ）
 * @param {function} [opts.log]    (level, text) 退避などを知らせる
 * @param {function} [opts.now]
 */
function createSettingsStore(opts) {
  const o = opts || {}
  const file = o.file || null
  const log = typeof o.log === 'function' ? o.log : function () {}
  const nowFn = typeof o.now === 'function' ? o.now : Date.now
  let data = null // {version, adapters}

  function empty() {
    return { version: VERSION, adapters: {} }
  }

  function validRecord(r) {
    if (!r || typeof r !== 'object' || typeof r.rev !== 'string') return false
    if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields)) return false
    for (const [k, f] of Object.entries(r.fields)) {
      if (FIELD_NAMES.indexOf(k) < 0) return false
      if (!f || typeof f !== 'object' || f.value === undefined || f.value === null) return false
    }
    return true
  }

  /** 構成の部分（config・configRev）。無いのは正しい（まだ画面で構成を変えていない）。 */
  function validConfigPart(r) {
    if (r.config === undefined && r.configRev === undefined) return true
    if (typeof r.configRev !== 'string') return false
    if (!r.config || typeof r.config !== 'object' || Array.isArray(r.config)) return false
    for (const [k, f] of Object.entries(r.config)) {
      if (CONFIG_FIELD_NAMES.indexOf(k) < 0) return false
      if (!f || typeof f !== 'object' || f.value === undefined || f.value === null) return false
    }
    return true
  }

  function quarantine(reason) {
    const bad = `${file}.bad-${stamp(nowFn())}`
    try {
      fs.renameSync(file, bad)
      log('warn', `運用設定のファイルが壊れていたので退避し、空で始めます（${reason}）: ${bad}`)
    } catch (err) {
      log('warn', `運用設定のファイルが壊れていて、退避もできませんでした（${reason}）: ${err.message}`)
    }
  }

  function load() {
    if (data) return data
    data = empty()
    if (!file) return data
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') log('warn', `運用設定のファイルを読めません。空で始めます: ${err.message}`)
      return data
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      quarantine('JSON として読めません')
      return data
    }
    if (!parsed || parsed.version !== VERSION || !parsed.adapters || typeof parsed.adapters !== 'object') {
      quarantine('形が違います')
      return data
    }
    for (const [id, rec] of Object.entries(parsed.adapters)) {
      if (!validRecord(rec)) {
        log('warn', `運用設定のうち ${id} の記録が壊れていたので読み飛ばしました`)
        continue
      }
      if (!validConfigPart(rec)) {
        // 運用設定は使い、構成だけ捨てる（設定ノードの値で動く。次に書くときに消える）
        log('warn', `運用設定のうち ${id} の接続の設定（Web UI で変えたポートなど）が壊れていたので読み飛ばしました（設定ノードの値で動きます）`)
        delete rec.config
        delete rec.configRev
        delete rec.configUpdatedAt
        delete rec.configUpdatedBy
      }
      data.adapters[id] = rec
    }
    // 画面かフローで足した台の置き場所のタブ（エディタはタブの独自の項目を書き出さないので、印はここに置く）
    if (typeof parsed.webUiTabId === 'string' && parsed.webUiTabId) data.webUiTabId = parsed.webUiTabId
    return data
  }

  function writeFile(next) {
    if (!file) return
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(dir, 0o700)
    } catch (e) {
      /* Windows など、権限を変えられない環境では続ける */
    }
    const tmp = file + '.tmp'
    const body = JSON.stringify(next, null, 2) + '\n'
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, body)
      try {
        fs.fsyncSync(fd)
      } catch (e) {
        /* fsync できないファイルシステムでも続ける */
      }
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.chmodSync(tmp, 0o600)
    } catch (e) {
      /* 同上 */
    }
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, file + '.bak')
        fs.chmodSync(file + '.bak', 0o600)
      } catch (e) {
        log('warn', '運用設定の前の版を .bak に写せませんでした: ' + e.message)
      }
    }
    fs.renameSync(tmp, file)
  }

  /** 次の状態を作って書き、書けてから入れ替える（書けなければ前のまま）。 */
  function commit(mutate) {
    const cur = load()
    const next = clone(cur)
    const result = mutate(next)
    writeFile(next)
    data = next
    return result
  }

  function get(id) {
    const r = load().adapters[id]
    return r ? clone(r) : null
  }

  function rev(id) {
    const r = load().adapters[id]
    return r ? r.rev : '0'
  }

  function checkRev(id, ifMatch) {
    const cur = rev(id)
    if (ifMatch === undefined || ifMatch === null || String(ifMatch) !== cur) throw new RevisionMismatch(cur)
  }

  /**
   * 項目を変える。changes の値が null ならその項目を外す。
   * @param {object} p {ifMatch, changes, configValues, by}
   * @returns {object} 新しい記録
   */
  function update(id, p) {
    checkRev(id, p.ifMatch)
    const now = nowFn()
    return commit((next) => {
      const rec = next.adapters[id] || { rev: '0', updatedAt: null, updatedBy: null, fields: {} }
      for (const [k, v] of Object.entries(p.changes || {})) {
        if (FIELD_NAMES.indexOf(k) < 0) continue
        if (v === null) {
          delete rec.fields[k]
        } else {
          rec.fields[k] = {
            value: clone(v),
            configAtSet: normalizeConfigValue(k, p.configValues ? p.configValues[k] : null),
            by: p.by || null,
            at: now,
          }
        }
      }
      rec.rev = newRev(now)
      rec.updatedAt = now
      rec.updatedBy = p.by || null
      next.adapters[id] = rec
      return clone(rec)
    })
  }

  /**
   * 運用設定を全部外す。記録そのものは残す（rev を進めて、古い rev の書き込みを断れるように）。
   * 構成（config）は残す（運用設定の「設定ノードの値に戻す」で、画面で変えたポートまで戻さない）。
   */
  function clear(id, p) {
    checkRev(id, p.ifMatch)
    const now = nowFn()
    return commit((next) => {
      const rec = Object.assign({}, next.adapters[id] || {}, { rev: newRev(now), updatedAt: now, updatedBy: p.by || null, fields: {} })
      next.adapters[id] = rec
      return clone(rec)
    })
  }

  /**
   * 起動時の照合。configAtSet と今の設定ノードの値が違う項目は外す。
   * @param {string} [by] 外した経路（既定 'editor'）
   * @returns {Array<{field, value, configAtSet, configNow}>} 外した項目
   */
  function reconcile(id, configValues, by) {
    const rec = load().adapters[id]
    if (!rec) return []
    const dropped = []
    for (const [k, f] of Object.entries(rec.fields)) {
      const now = normalizeConfigValue(k, configValues ? configValues[k] : null)
      const atSet = f.configAtSet === undefined ? null : f.configAtSet
      // 無い（null）と既定値は同じとみなす（reconcileConfig と同じ形）
      if (canonical(withDefault(FIELDS[k], now)) !== canonical(withDefault(FIELDS[k], atSet))) {
        dropped.push({ field: k, value: clone(f.value), configAtSet: clone(f.configAtSet), configNow: now })
      }
    }
    if (!dropped.length) return dropped
    try {
      const t = nowFn()
      commit((next) => {
        const r = next.adapters[id]
        for (const d of dropped) delete r.fields[d.field]
        r.rev = newRev(t)
        r.updatedAt = t
        r.updatedBy = by || 'editor'
      })
    } catch (err) {
      log('warn', '運用設定の照合の結果を保存できませんでした（このまま動かします）: ' + err.message)
      // 書けなくても、効かせないことだけはメモリ上で守る
      const r = load().adapters[id]
      for (const d of dropped) delete r.fields[d.field]
    }
    return dropped
  }

  // ---------------------------------------------------------------------------
  //  構成。運用設定と同じ規則（rev・If-Match・configAtSet・by・at）
  // ---------------------------------------------------------------------------

  /** 構成の記録 {rev, updatedAt, updatedBy, fields}。無ければ rev '0' の空。 */
  function getConfig(id) {
    const r = load().adapters[id]
    return {
      rev: r && typeof r.configRev === 'string' ? r.configRev : '0',
      updatedAt: r && r.configUpdatedAt !== undefined ? r.configUpdatedAt : null,
      updatedBy: r && r.configUpdatedBy !== undefined ? r.configUpdatedBy : null,
      fields: r && r.config ? clone(r.config) : {},
    }
  }

  function configRev(id) {
    const r = load().adapters[id]
    return r && typeof r.configRev === 'string' ? r.configRev : '0'
  }

  function checkConfigRev(id, ifMatch) {
    const cur = configRev(id)
    if (ifMatch === undefined || ifMatch === null || String(ifMatch) !== cur) throw new RevisionMismatch(cur)
  }

  function recordFor(next, id) {
    if (!next.adapters[id]) next.adapters[id] = { rev: '0', updatedAt: null, updatedBy: null, fields: {} }
    const rec = next.adapters[id]
    if (!rec.config) rec.config = {}
    return rec
  }

  /**
   * 構成の項目を変える。changes の値が null ならその項目を外す。
   * @param {object} p {ifMatch, changes, configValues（そろえた設定ノードの値）, by}
   * @returns {object} getConfig と同じ形
   */
  function updateConfig(id, p) {
    checkConfigRev(id, p.ifMatch)
    const now = nowFn()
    commit((next) => {
      const rec = recordFor(next, id)
      for (const [k, v] of Object.entries(p.changes || {})) {
        if (CONFIG_FIELD_NAMES.indexOf(k) < 0) continue
        if (v === null) delete rec.config[k]
        else {
          rec.config[k] = {
            value: clone(v),
            configAtSet: normalizeConfigField(k, p.configValues ? p.configValues[k] : null),
            by: p.by || null,
            at: now,
          }
        }
      }
      rec.configRev = newRev(now)
      rec.configUpdatedAt = now
      rec.configUpdatedBy = p.by || null
    })
    return getConfig(id)
  }

  /** 構成を全部外す（設定ノードの値に戻す）。運用設定は残す。記録は残して configRev を進める。 */
  function clearConfig(id, p) {
    checkConfigRev(id, p.ifMatch)
    const now = nowFn()
    commit((next) => {
      const rec = recordFor(next, id)
      rec.config = {}
      rec.configRev = newRev(now)
      rec.configUpdatedAt = now
      rec.configUpdatedBy = p.by || null
    })
    return getConfig(id)
  }

  /**
   * 起動時の構成の照合。configAtSet と今の設定ノードの値（そろえたもの）が違う項目は外す（エディタを優先）。
   * @returns {Array<{field, value, configAtSet, configNow}>} 外した項目
   */
  function reconcileConfig(id, configValues, by) {
    const rec = load().adapters[id]
    if (!rec || !rec.config) return []
    const dropped = []
    for (const [k, f] of Object.entries(rec.config)) {
      const nowV = normalizeConfigField(k, configValues ? configValues[k] : null)
      const atSet = f.configAtSet === undefined ? null : f.configAtSet
      // 無い（null）と既定値は同じとみなす。enabled の無い設定ノード（1.x・生成器の形）を画面で無効にしたあと、
      // エディタで別の項目を直して「完了」すると enabled: true が書かれる。既定値を当てずに比べると null ≠ true で画面の値を外し、
      // 無効にした台が有効に戻ってポートを開いていた
      if (canonical(withDefault(CONFIG_FIELDS[k], nowV)) !== canonical(withDefault(CONFIG_FIELDS[k], atSet))) {
        dropped.push({ field: k, value: clone(f.value), configAtSet: clone(f.configAtSet), configNow: nowV })
      }
    }
    if (!dropped.length) return dropped
    try {
      const t = nowFn()
      commit((next) => {
        const r = next.adapters[id]
        for (const d of dropped) delete r.config[d.field]
        r.configRev = newRev(t)
        r.configUpdatedAt = t
        r.configUpdatedBy = by || 'editor'
      })
    } catch (err) {
      log('warn', '接続の設定の照合の結果を保存できませんでした（このまま動かします）: ' + err.message)
      const r = load().adapters[id]
      for (const d of dropped) delete r.config[d.field]
    }
    return dropped
  }

  // ---------------------------------------------------------------------------
  //  画面かフローで足した台の印
  // ---------------------------------------------------------------------------

  /**
   * 足した台の印 adapters[id].created = {by, at, brouteId, tabId} と、置き場所のタブ（webUiTabId）を書く。
   * 運用設定・構成の rev は変えない（開いている画面の欄を 412 にしない）。
   */
  function markCreated(id, created) {
    const c = created || {}
    return commit((next) => {
      if (!next.adapters[id]) next.adapters[id] = { rev: '0', updatedAt: null, updatedBy: null, fields: {} }
      next.adapters[id].created = {
        by: c.by || null,
        at: typeof c.at === 'number' ? c.at : nowFn(),
        brouteId: c.brouteId ? String(c.brouteId) : null,
        tabId: c.tabId ? String(c.tabId) : null,
      }
      if (c.tabId) next.webUiTabId = String(c.tabId)
      return clone(next.adapters[id].created)
    })
  }

  /**
   * 台の記録を消す（フローから消えた台の片付け）。値の残る記録は呼び手が残す:
   * 同じ id の設定ノードを読み込み直したときに、また効かせるため。
   * @returns {boolean} 消したか
   */
  function forget(id) {
    if (!Object.prototype.hasOwnProperty.call(load().adapters, id)) return false
    return commit((next) => {
      delete next.adapters[id]
      return true
    })
  }

  /** 足した台の置き場所のタブの id（無ければ null）。 */
  function webUiTabId() {
    const d = load()
    return typeof d.webUiTabId === 'string' && d.webUiTabId ? d.webUiTabId : null
  }

  /** 記録のある設定ノードの id（孤児の数を知らせるため）。 */
  function ids() {
    return Object.keys(load().adapters)
  }

  return {
    get,
    rev,
    update,
    clear,
    reconcile,
    load,
    file,
    getConfig,
    configRev,
    updateConfig,
    clearConfig,
    reconcileConfig,
    markCreated,
    forget,
    webUiTabId,
    ids,
  }
}

/** 基本設定 / 詳細設定。知らない項目は null。 */
function tierOf(field) {
  return FIELDS[field] ? FIELDS[field].tier : null
}

module.exports = {
  createSettingsStore,
  validateSettingsInput,
  normalizeConfigValue,
  RevisionMismatch,
  FIELDS,
  FIELD_NAMES,
  epcHex,
  tierOf,
  // EPC の 1 つを数にする（'E7'・'0xE7'・0xE7。読めなければ null。'0E7'・'E7Z' は null）。
  // 設定ノードの pollEpcs の読み方をここにそろえる（nodes/wsuha-device.js が使う）
  toEpc,
}
