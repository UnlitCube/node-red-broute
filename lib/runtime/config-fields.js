'use strict'

// ============================================================================
//  構成（ポート・認証情報以外の接続の設定など）の項目・検証・そろえ方
// ============================================================================
//
//  画面（PUT adapters/:id/config）・フロー（wsuha-broute の入力 config）・エディタ（設定ノード）の
//  どこから変えても、ここの同じ検証を通り、同じ settings.json（adapters[id].config）に残る。
//
//  値の出どころは 2 層（運用設定と同じ規則。一時的な上書きは無い）:
//    runtime（画面かフローで保存した値。settings.json）> config（エディタの設定ノードの値）> default（既定値）
//
//  connection が true の項目は、変わったらその台だけ SKTERM してポートを閉じ、新しい値で開き直す
//  （nodes/wsuha-device.js の reconfigure）。それ以外は開き直さずに効かせる。
//  enabled は開き直しではなく、開く・閉じる（無効 → ポートを閉じる、有効 → 開く）。
//
//  ここは Node-RED に依存しない。

/**
 * ボーレートの許す値。BP35C0 の WUART（UART の速さの設定）が選べる値と同じ。
 * RS-WSUHA の既定は 115200（8 / なし / 1）。表に無い値はアダプタと話せないので断る。
 */
const BAUDS = [2400, 4800, 9600, 19200, 38400, 57600, 115200]
const DEFAULT_SCAN = [4, 5, 6, 7, 8]
/** シミュレータの候補のポート名（GET serialports の 1 つ。選ぶと mode が simulator になる）。 */
const SIMULATOR_PORT = 'simulator'
const CONTROL = /[\u0000-\u001f\u007f]/
/**
 * Node-RED はノードを作るときに、値の全体が ${…} か $(…) の文字列を環境変数の値へ置き換える
 * （@node-red/runtime の mapEnvVarProperties。判定はこの式と同じで、'x${A}' のように一部だけなら置き換わらない）。
 * 画面とフローから受けた文字をそのまま設定ノードへ書くと、置き換わった値が一覧に出て、
 * ほかの台のパスワードを含むプロセスの環境変数を誰でも読めてしまう。
 */
const ENV_REF = /^\$(\{\S+\}|\(\S+\))$/

/**
 * 構成の項目。順は画面と追加の画面の並び（基本設定 → 詳細設定）。
 *   connection: 変わったらポートを開き直す
 *   tier:       'basic'（基本設定）| 'advanced'（詳細設定）。**割り振りの正はここ**。
 *               画面は tier だけで出し分け、2 つ目の表を持たない。エディタの HTML は試験で照らす。
 *   label:      画面・エディタ・README で使う言葉（そろえる）
 */
const CONFIG_FIELDS = {
  role: { label: '契約', type: 'text', maxLength: 32, default: null, connection: false, tier: 'basic' },
  name: { label: '名前', type: 'text', maxLength: 100, default: null, connection: false, tier: 'basic' },
  mode: { label: '接続先', type: 'enum', values: ['serial', 'simulator'], default: 'serial', connection: true, tier: 'basic' },
  // 基本（実機のときだけ）。シミュレーターのときは画面が出さない
  serialport: { label: 'ポート', type: 'port', maxLength: 256, default: null, connection: true, tier: 'basic' },
  enabled: { label: '有効', type: 'boolean', default: true, connection: false, tier: 'advanced' },
  autoStart: { label: '自動で始める', type: 'boolean', default: true, connection: false, tier: 'advanced' },
  serialbaud: { label: '通信速度', type: 'baud', values: BAUDS, default: 115200, connection: true, tier: 'advanced' },
  deviceKey: { label: 'デバイスキー', type: 'key', maxLength: 32, default: null, connection: true, tier: 'advanced' },
  expectedMac: { label: '想定 MAC', type: 'mac', default: null, connection: true, tier: 'advanced' },
  scanDurations: {
    label: 'スキャンの段階',
    type: 'durations',
    min: 2,
    max: 14,
    maxItems: 8,
    default: DEFAULT_SCAN,
    connection: false,
    tier: 'advanced',
  },
}
const TIERS = ['basic', 'advanced']
const CONFIG_FIELD_NAMES = Object.keys(CONFIG_FIELDS)
const CONNECTION_FIELDS = CONFIG_FIELD_NAMES.filter((k) => CONFIG_FIELDS[k].connection)

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

function canonical(v) {
  return JSON.stringify(v === undefined ? null : v)
}

function sameValue(a, b) {
  return canonical(a) === canonical(b)
}

/** '4,5,6' や [4, '5'] を整数の並びにする。読めない要素があれば null。空も null。 */
function intList(v) {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/).filter((x) => x !== '') : null
  if (!parts || !parts.length) return null
  const out = []
  for (const x of parts) {
    if (typeof x === 'number' && Number.isInteger(x)) out.push(x)
    else if (typeof x === 'string' && /^\s*\d+\s*$/.test(x)) out.push(parseInt(x, 10))
    else return null
  }
  return out
}

/**
 * エディタの設定ノードの値（config.*）を、比べられる形にそろえる（寛容に読む。検証はしない）。
 * 空・無い・読めないものは null（= 既定値）。1.x のフロー（enabled が無い）も null。
 */
function normalizeConfigField(field, v) {
  if (v === undefined || v === null) return null
  switch (field) {
    case 'name':
    case 'role':
    case 'serialport':
    case 'deviceKey': {
      const s = String(v).trim()
      return s === '' ? null : s
    }
    case 'expectedMac': {
      // 検証（type: 'mac'）と同じ形にそろえる。区切りを残すと、シーケンサーの照合で同じ MAC が別物になる
      const s = String(v).trim().replace(/[:-]/g, '').toUpperCase()
      return s === '' ? null : s
    }
    case 'enabled':
    case 'autoStart':
      return typeof v === 'boolean' ? v : null
    case 'mode':
      return v === 'simulator' || v === 'serial' ? v : null
    case 'serialbaud': {
      const n = typeof v === 'number' ? v : /^\s*\d+\s*$/.test(String(v)) ? parseInt(v, 10) : NaN
      return Number.isInteger(n) && n > 0 ? n : null
    }
    case 'scanDurations': {
      // 1.x と同じく寛容に読む（読めない要素は捨てる。'4,5,x' → [4, 5]）
      const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/))
        .map((x) => (typeof x === 'number' ? Math.trunc(x) : parseInt(String(x), 10)))
        .filter((n) => !isNaN(n))
      return list.length ? list : null
    }
    default:
      return null
  }
}

/** 設定ノードの config から、構成の項目の値（そろえたもの）を取り出す。 */
function configValuesFromNode(config) {
  const c = config || {}
  const out = {}
  for (const k of CONFIG_FIELD_NAMES) out[k] = normalizeConfigField(k, c[k])
  return out
}

/** 保存してある値（runtime）を、検証済みの形として読む（壊れた記録を効かせないため）。読めなければ undefined。 */
function storedValueOk(field, v) {
  const r = checkField(field, v)
  return r.error ? undefined : r.value
}

/**
 * 1 項目を検証する（PUT の本文・フローの payload）。
 * @returns {{value?: any, error?: string}}
 */
function checkField(field, v) {
  const def = CONFIG_FIELDS[field]
  switch (def.type) {
    case 'text': {
      if (typeof v !== 'string') return { error: `${def.maxLength} 文字までの文字列で指定してください（空にもできます）` }
      const s = v.trim()
      if (s.length > def.maxLength) return { error: `${def.maxLength} 文字までにしてください` }
      if (CONTROL.test(s)) return { error: '改行や制御文字は使えません' }
      if (ENV_REF.test(s)) return { error: '${…} や $(…) だけの値は、Node-RED が環境変数の値に置き換えるため使えません。別の文字を入れてください' }
      return { value: s }
    }
    case 'boolean':
      if (typeof v !== 'boolean') return { error: 'true か false で指定してください' }
      return { value: v }
    case 'enum':
      if (def.values.indexOf(v) < 0) return { error: `${def.values.map((x) => `"${x}"`).join('・')} のどれかを指定してください` }
      return { value: v }
    case 'port': {
      if (typeof v !== 'string') return { error: 'ポートのパスを文字列で指定してください（例: "/dev/serial/by-id/…"・"/dev/ttyUSB0"・"COM3"）' }
      const s = v.trim()
      if (!s) return { error: 'ポートのパスを指定してください' }
      if (s.length > def.maxLength) return { error: `${def.maxLength} 文字までにしてください` }
      if (CONTROL.test(s)) return { error: '改行や制御文字は使えません' }
      if (s === SIMULATOR_PORT) return { value: s }
      if (!isPortPath(s)) {
        return { error: '/ で始まるパス（例: /dev/serial/by-id/…・/dev/ttyUSB0）か COM3 の形で指定してください' }
      }
      return { value: s }
    }
    case 'baud': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) : NaN
      if (!Number.isInteger(n) || def.values.indexOf(n) < 0) {
        return { error: `${def.values.join('・')} のどれかを指定してください（RS-WSUHA は 115200）` }
      }
      return { value: n }
    }
    case 'key': {
      if (typeof v !== 'string') return { error: '英数字と _ - で 32 文字までの文字列で指定してください（空にもできます）' }
      const s = v.trim()
      if (s !== '' && !/^[A-Za-z0-9_-]{1,32}$/.test(s)) return { error: '英数字と _ - で 32 文字までにしてください' }
      return { value: s }
    }
    case 'mac': {
      if (typeof v !== 'string') return { error: '16 桁の 16 進数で指定してください（空にもできます）' }
      const s = v.trim().replace(/[:-]/g, '').toUpperCase()
      if (s !== '' && !/^[0-9A-F]{16}$/.test(s)) return { error: '16 桁の 16 進数で指定してください（例: 001D129100000000）' }
      return { value: s }
    }
    case 'durations': {
      const list = intList(v)
      if (!list || list.length > def.maxItems) {
        return { error: `${def.min}〜${def.max} の整数を 1〜${def.maxItems} 個、配列か "4,5,6" の形で指定してください` }
      }
      for (const n of list) {
        if (n < def.min || n > def.max) return { error: `${def.min}〜${def.max} の整数で指定してください（${n} は範囲の外です）` }
      }
      return { value: list }
    }
    default:
      return { error: 'この項目は変えられません' }
  }
}

/** 本文がシミュレーターを選び、serialport を空で送っているか（実機用の欄が空のまま送られる形）。 */
function blankPortForSimulator(body) {
  return body.mode === 'simulator' && typeof body.serialport === 'string' && body.serialport.trim() === ''
}

/**
 * PUT adapters/:id/config の本文（フローの入力 config の payload）を検査する。
 * 値が null の項目は「画面かフローで保存した値を外す（設定ノードの値に戻す）」。
 * serialport に 'simulator'（GET serialports のシミュレータの候補）を渡すと、mode を simulator にする。
 * シミュレーターにする本文の空の serialport は、使わない項目なので無視する（ポートの値は変えない）。
 * @returns {{changes: object, errors: object}}
 */
function validateConfigInput(body) {
  const changes = {}
  const errors = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors._ = '本文は JSON のオブジェクトで送ってください'
    return { changes, errors }
  }
  const keys = Object.keys(body)
  for (const k of keys) {
    if (CONFIG_FIELD_NAMES.indexOf(k) >= 0) continue
    if (k === 'routeBId' || k === 'routeBPassword') errors[k] = '認証 ID とパスワードは credentials で保存してください（config には入れません）'
    else errors[k] = 'この項目は変えられません'
  }
  for (const k of CONFIG_FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue
    const v = body[k]
    if (v === null) {
      changes[k] = null
      continue
    }
    if (k === 'serialport' && blankPortForSimulator(body)) continue
    const r = checkField(k, v)
    if (r.error) errors[k] = r.error
    else changes[k] = r.value
  }
  // シミュレーターの候補を選んだ: 接続先をシミュレーターにする（ポートの値は変えない）
  if (changes.serialport === SIMULATOR_PORT) {
    delete changes.serialport
    if (Object.prototype.hasOwnProperty.call(body, 'mode') && body.mode !== 'simulator') {
      errors.serialport = 'シミュレーターの候補を選んだときは、接続先（mode）を "serial" にできません'
    } else {
      changes.mode = 'simulator'
    }
  }
  if (!keys.length) errors._ = '変える項目がありません'
  return { changes, errors }
}

/**
 * 効いている構成。画面かフローで保存した値（stored の fields。検証を通るものだけ）> 設定ノードの値 > 既定値。
 * @param {object} editor  configValuesFromNode() の結果
 * @param {object|null} stored settings.json の adapters[id].config（{field: {value, …}}）
 */
function effectiveConfig(editor, stored) {
  const out = {}
  for (const k of CONFIG_FIELD_NAMES) {
    const s = stored && stored[k] ? storedValueOk(k, stored[k].value) : undefined
    const e = editor ? editor[k] : null
    out[k] = clone(s !== undefined ? s : e !== null && e !== undefined ? e : CONFIG_FIELDS[k].default)
  }
  return out
}

/** 変わった項目の名前（a と b は effectiveConfig の形）。 */
function changedFields(a, b) {
  return CONFIG_FIELD_NAMES.filter((k) => !sameValue(a ? a[k] : null, b ? b[k] : null))
}

/** ログと画面に出す値の書き方（秘密は入らない項目だけ）。 */
function describeConfigValue(field, v) {
  if (v === null || v === undefined || v === '') return '未設定'
  if (field === 'enabled' || field === 'autoStart') return v ? 'オン' : 'オフ'
  if (field === 'mode') return v === 'simulator' ? 'シミュレーター' : 'Wi-SUN アダプタ（実機）'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

/** ポートの値として受ける形（/ で始まるパス・COM3・\\.\COM10）。 */
function isPortPath(s) {
  return /^\//.test(s) || /^COM\d{1,3}$/i.test(s) || /^\\\\\.\\COM\d{1,3}$/i.test(s)
}

/** by-id・by-path の名前か（実体の ttyUSB0 などから短い名前を作る）。 */
function isLinkPath(p) {
  return /^\/dev\/serial\/by-(?:id|path)\//.test(p)
}

/** 1 つのパスの短い名前。読めなければ null。 */
function shortPortName(p) {
  const s = String(p || '').trim()
  if (!s) return null
  let m = /(?:^|\/)tty(USB|ACM)(\d+)$/.exec(s)
  if (m) return m[1] + m[2]
  m = /^(?:\\\\\.\\)?(COM\d{1,3})$/i.exec(s)
  if (m) return m[1].toUpperCase()
  if (isLinkPath(s)) return null
  const base = s.split(/[\\/]/).pop()
  return base || null
}

/** 長い名前は末尾 16 文字に「…」を付ける。 */
function tail16(s) {
  const t = String(s)
  return t.length > 16 ? '…' + t.slice(-16) : t
}

/**
 * ノードの表示・一覧・見出しに使うポートの短い名前。
 *   simulator → 「シミュレーター」・空 → 「ポート未設定」
 *   /dev/ttyUSB0 → USB0・/dev/ttyACM0 → ACM0・COM3 → COM3（\\.\COM10 → COM10）
 *   /dev/serial/by-id/… → 実体（realPath）から同じ規則で作る。実体が読めなければ末尾 16 文字に「…」
 *   ほかのパス（/dev/ttyAMA0 など）→ 最後の名前（16 文字を超えたら末尾 16 文字に「…」）
 * @param {string} mode 'serial' | 'simulator'
 * @param {string} port 設定したパス
 * @param {string|null} [realPath] by-id の実体（/dev/ttyUSB0）。undefined なら by-id・by-path のときだけ fs.realpathSync で読む
 *   （読めなければ末尾 16 文字）。null なら読まない
 */
function portLabelOf(mode, port, realPath) {
  if (mode === 'simulator' || port === SIMULATOR_PORT) return 'シミュレーター'
  const p = String(port || '').trim()
  if (!p) return 'ポート未設定'
  if (isLinkPath(p)) {
    let real = realPath
    if (real === undefined) {
      try {
        real = require('fs').realpathSync(p)
      } catch (e) {
        real = null // 抜けている・別の機械の by-id
      }
    }
    const fromReal = real && real !== p ? shortPortName(real) : null
    if (fromReal && !isLinkPath(String(real))) return tail16(fromReal)
    return tail16(p.split('/').pop() || p)
  }
  const s = shortPortName(p)
  return s ? tail16(s) : tail16(p)
}

/** 追加の本文で受ける項目。知らない項目は 422。 */
const ADD_FIELDS = ['role', 'name', 'mode', 'serialport', 'serialbaud', 'deviceKey', 'expectedMac', 'autoStart', 'routeBId', 'routeBPassword']

/**
 * 追加の本文（POST adapters・フローの add-adapter の payload）を検査する。形の検査は PUT config と同じ（checkField）。
 * 認証情報は両方か、どちらも無いか（片方だけは 422）。形の確かめは呼んだ側が credentials-store の validateCredentialsInput で行う。
 * name は入れなければ空のまま（電力・動力などの契約で埋めない）。
 * @returns {{value: object|null, errors: object, credentials: {routeBId, routeBPassword}|null}}
 *   value は {role, name, mode, serialport, serialbaud, deviceKey, expectedMac, autoStart}（既定値を当てたもの）
 */
function validateAddInput(body) {
  const errors = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors._ = '本文は JSON のオブジェクトで送ってください'
    return { value: null, errors, credentials: null }
  }
  for (const k of Object.keys(body)) {
    if (ADD_FIELDS.indexOf(k) < 0) errors[k] = 'この項目は受け付けません'
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== null && body[k] !== undefined
  const v = {
    role: '',
    name: '',
    mode: 'serial',
    serialport: '',
    serialbaud: CONFIG_FIELDS.serialbaud.default,
    deviceKey: '',
    expectedMac: '',
    autoStart: true,
  }
  // 契約（必須。画面は「電力」「動力」「その他（名前を入力）」から選ぶ）
  if (!has('role')) errors.role = '契約を選んでください（電力・動力か、契約の名前）'
  else {
    const r = checkField('role', body.role)
    if (r.error) errors.role = r.error
    else if (!r.value) errors.role = '契約を選んでください（電力・動力か、契約の名前）'
    else v.role = r.value
  }
  for (const k of ['name', 'mode', 'serialbaud', 'deviceKey', 'expectedMac', 'autoStart']) {
    if (!has(k)) continue
    const r = checkField(k, body[k])
    if (r.error) errors[k] = r.error
    else v[k] = r.value
  }
  if (has('serialport') && !blankPortForSimulator(body)) {
    const r = checkField('serialport', body.serialport)
    if (r.error) errors.serialport = r.error
    else if (r.value === SIMULATOR_PORT) {
      // シミュレーターの候補を選んだ（PUT config と同じ）
      if (has('mode') && body.mode !== 'simulator') errors.serialport = 'シミュレーターの候補を選んだときは、接続先（mode）を "serial" にできません'
      else v.mode = 'simulator'
    } else v.serialport = r.value
  }
  if (v.mode === 'simulator') v.serialport = ''
  else if (!errors.serialport && !errors.mode && !v.serialport) errors.serialport = '接続先が Wi-SUN アダプタ（実機）のときは、ポートを選ぶか入力してください'
  // 認証情報（両方か、どちらも無いか）
  const hasId = Object.prototype.hasOwnProperty.call(body, 'routeBId') && body.routeBId !== null && body.routeBId !== undefined && body.routeBId !== ''
  const hasPw =
    Object.prototype.hasOwnProperty.call(body, 'routeBPassword') && body.routeBPassword !== null && body.routeBPassword !== undefined && body.routeBPassword !== ''
  let credentials = null
  if (hasId !== hasPw) {
    if (!hasId) errors.routeBId = '認証 ID とパスワードは両方入れるか、両方とも空にしてください'
    else errors.routeBPassword = '認証 ID とパスワードは両方入れるか、両方とも空にしてください'
  } else if (hasId) {
    credentials = { routeBId: body.routeBId, routeBPassword: body.routeBPassword }
  }
  return { value: Object.keys(errors).length ? null : v, errors, credentials }
}

/** 項目の基本設定 / 詳細設定。知らない項目は null。 */
function tierOf(field) {
  return CONFIG_FIELDS[field] ? CONFIG_FIELDS[field].tier : null
}

module.exports = {
  CONFIG_FIELDS,
  CONFIG_FIELD_NAMES,
  CONNECTION_FIELDS,
  TIERS,
  BAUDS,
  DEFAULT_SCAN,
  SIMULATOR_PORT,
  ADD_FIELDS,
  normalizeConfigField,
  configValuesFromNode,
  validateConfigInput,
  validateAddInput,
  checkField,
  storedValueOk,
  effectiveConfig,
  changedFields,
  describeConfigValue,
  portLabelOf,
  isPortPath,
  tierOf,
  sameValue,
}
