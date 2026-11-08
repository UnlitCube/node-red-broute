// 設定タブの「構成」の下書き・検証・差分・ポートの候補・認証情報の検証（純関数。test/ui/config.test.mjs）。
// Config は運用設定の Settings と同じ形（{rev, fields: {name: SettingField, …}, warnings, credentials}）。
// 下書きは運用設定と同じく「手で変えた項目（edits）」だけを持ち、触っていない項目はいつもサーバーの今の値を出す。
// 検証は差分に入る項目だけ（触っていない項目がサーバーの値のまま形の外でも、保存は止めない）。
// 認証情報の値はここでも持たない（validateCredentials は受け取った文字列を調べるだけで、理由の文に値を入れない）。
import { S } from './strings.js'

export const CONFIG_FIELDS = ['name', 'role', 'enabled', 'mode', 'serialport', 'serialbaud', 'deviceKey', 'expectedMac', 'autoStart', 'scanDurations']
/** 変えると、その台を接続し直す項目（認証情報も同じだが、それは別の欄）。 */
export const RECONNECT_FIELDS = ['mode', 'serialport', 'serialbaud', 'deviceKey', 'expectedMac']
export const BOOL_FIELDS = ['enabled', 'autoStart']
/** サーバーの表が無いとき（追加のモーダルは Config を持たない）の速度の候補。lib/runtime/config-fields.js の BAUDS と同じ（test/ui/rules-sync.test.mjs）。 */
export const DEFAULT_BAUDS = [2400, 4800, 9600, 19200, 38400, 57600, 115200]
/** スキャンの段階の範囲（SettingField の min / max が無いとき）。 */
const SCAN_RANGE = { min: 2, max: 14, maxItems: 8 }

const isSet = (v) => v !== null && v !== undefined
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)

function fieldsOf(config) {
  return (config && config.fields) || {}
}

/** その項目の今の値（SettingField.value が効いている値。null は「値が無い」で、設定ノードの値に読み替えない）。 */
function currentValue(f) {
  return f && isSet(f.value) ? f.value : null
}

/** スキャンの段階を「4,5,6」の形に（配列・文字列・空白やカンマの混ざりを受ける）。 */
export function scanText(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(',')
  if (!isSet(v)) return ''
  return String(v)
    .split(/[\s,、]+/)
    .filter(Boolean)
    .join(',')
}

/** MAC の比べ方（区切りの : - 空白を外して大文字）。 */
export function normMac(v) {
  return String(isSet(v) ? v : '')
    .replace(/[\s:-]/g, '')
    .toUpperCase()
}

function textOf(v) {
  return isSet(v) ? String(v) : ''
}

/** サーバーの Config から下書き（入力欄の値）を作る。 */
export function configDraftFrom(config) {
  const f = fieldsOf(config)
  const v = (n) => currentValue(f[n])
  // 真偽は値が無ければ既定（それも無ければ dflt）
  const bool = (n, dflt) => {
    const x = v(n)
    if (typeof x === 'boolean') return x
    return f[n] && typeof f[n].default === 'boolean' ? f[n].default : dflt
  }
  return {
    name: textOf(v('name')),
    role: textOf(v('role')),
    enabled: bool('enabled', true),
    mode: v('mode') === 'simulator' ? 'simulator' : 'serial',
    serialport: textOf(v('serialport')),
    serialbaud: textOf(v('serialbaud')),
    deviceKey: textOf(v('deviceKey')),
    expectedMac: textOf(v('expectedMac')),
    autoStart: bool('autoStart', true),
    scanDurations: scanText(v('scanDurations')),
  }
}

/** 比べるための形（前後の空白・MAC の区切りと大文字小文字・スキャンの区切りは同じとみなす）。 */
function comparable(name, v) {
  if (BOOL_FIELDS.includes(name)) return !!v
  if (name === 'expectedMac') return normMac(v)
  if (name === 'scanDurations') return scanText(v)
  return String(isSet(v) ? v : '').trim()
}

/** 下書きのうち、サーバーの今の値から変わった項目（CONFIG_FIELDS の順）。 */
export function changedConfigFields(draft, config) {
  const base = configDraftFrom(config)
  return CONFIG_FIELDS.filter((n) => comparable(n, draft[n]) !== comparable(n, base[n]))
}

/** サーバーの今の値に、手で変えた項目だけを重ねる。 */
export function mergeConfigDraft(config, edits) {
  const d = configDraftFrom(config)
  for (const n of CONFIG_FIELDS) if (own(edits, n)) d[n] = edits[n]
  return d
}

/** 手で変えた項目のうち、サーバーの今の値と同じになったものを外す（新しいオブジェクト）。 */
export function pruneConfigEdits(edits, config) {
  const changed = changedConfigFields(mergeConfigDraft(config, edits), config)
  const out = {}
  for (const n of changed) if (own(edits, n)) out[n] = edits[n]
  return out
}

/** サーバーが許す速度の表（SettingField.serialbaud の values。options でもよい）。無ければ null。 */
function allowedBauds(config) {
  const f = fieldsOf(config).serialbaud
  const raw = f && (Array.isArray(f.values) && f.values.length ? f.values : Array.isArray(f.options) && f.options.length ? f.options : null)
  if (!raw) return null
  const list = raw.map((x) => Number(x && typeof x === 'object' ? x.value : x)).filter((n) => Number.isInteger(n) && n > 0)
  return list.length ? list : null
}

/** 速度の候補（サーバーの表が正、無ければ DEFAULT_BAUDS）。今の値は必ず入れる。 */
export function baudOptions(config, current) {
  const allowed = allowedBauds(config)
  const list = allowed ? allowed.slice() : DEFAULT_BAUDS.slice()
  const cur = Number(current)
  if (Number.isInteger(cur) && cur > 0 && !list.includes(cur)) list.push(cur)
  return list.sort((a, b) => a - b)
}

function scanRange(config) {
  const f = fieldsOf(config).scanDurations
  return {
    min: f && typeof f.min === 'number' ? f.min : SCAN_RANGE.min,
    max: f && typeof f.max === 'number' ? f.max : SCAN_RANGE.max,
    maxItems: f && typeof f.maxItems === 'number' ? f.maxItems : SCAN_RANGE.maxItems,
  }
}

/** 文字の項目の長さの上限（SettingField.maxLength。無ければ null）。 */
export function maxLengthOf(config, name) {
  const f = fieldsOf(config)[name]
  return f && typeof f.maxLength === 'number' && f.maxLength > 0 ? f.maxLength : null
}

/** ポートの形（/ で始まるパスか COM3・\\.\COM3）。サーバーの検証（lib/runtime/config-fields.js）と同じ。 */
function portFormOk(t) {
  return t.charAt(0) === '/' || /^COM\d{1,3}$/i.test(t) || /^\\\\\.\\COM\d{1,3}$/i.test(t)
}

function fieldError(name, draft, config, opts) {
  const v = draft[name]
  switch (name) {
    case 'serialport': {
      if (draft.mode !== 'serial') return null
      const t = String(v || '').trim()
      if (!t) return S.config.errPort
      return portFormOk(t) ? null : S.config.errPortForm
    }
    case 'serialbaud': {
      const n = Number(String(v || '').trim())
      const allowed = allowedBauds(config)
      if (!Number.isInteger(n) || n <= 0) return S.config.errBaud
      if (allowed && !allowed.includes(n)) return S.config.errBaud
      return null
    }
    case 'deviceKey': {
      const t = String(v || '').trim()
      const max = maxLengthOf(config, 'deviceKey') || 32
      return /^[A-Za-z0-9_-]*$/.test(t) && t.length <= max ? null : S.config.errDeviceKey
    }
    case 'name': {
      // 制御文字（タブ・改行）はサーバーが 422 にする。保存の前に止める
      if (/[\u0000-\u001f\u007f]/.test(String(v || ''))) return S.roles.errControl
      const max = maxLengthOf(config, name)
      return max && String(v || '').trim().length > max ? S.config.errTooLong(max) : null
    }
    case 'role':
      return roleError(v, { other: !!(opts && opts.roleOther), max: maxLengthOf(config, 'role') || 32 })
    case 'expectedMac': {
      const m = normMac(v)
      return m === '' || /^[0-9A-F]{16}$/.test(m) ? null : S.config.errMac
    }
    case 'scanDurations': {
      const { min, max, maxItems } = scanRange(config)
      const parts = scanText(v).split(',').filter(Boolean)
      const ok = parts.length > 0 && parts.length <= maxItems && parts.every((p) => /^\d+$/.test(p) && Number(p) >= min && Number(p) <= max)
      return ok ? null : S.config.errScan(min, max, maxItems)
    }
    default:
      return null
  }
}

/**
 * 下書きの検証。差分に入る項目だけ（ポートは、接続先かポートを変えたときにシリアルなら要る）。
 * opts.roleOther: 契約の select で「その他（名前を入力）」を選んでいる（空なら「契約の名前を入力してください」。値が
 * 変わっていなくても見る）。
 * @returns {{[field]: string}}（空なら通る）
 */
export function validateConfigDraft(draft, config, opts) {
  const changed = changedConfigFields(draft, config)
  const errors = {}
  const check = new Set(changed)
  if (check.has('mode')) check.add('serialport')
  if (opts && opts.roleOther) check.add('role')
  for (const n of CONFIG_FIELDS) {
    if (!check.has(n)) continue
    const e = fieldError(n, draft, config, opts)
    if (e) errors[n] = e
  }
  return errors
}

/** 送る値（型をそろえる）。スキャンの段階は、サーバーが配列で持っていれば配列で送る。 */
function patchValue(name, v, config) {
  if (BOOL_FIELDS.includes(name)) return !!v
  if (name === 'serialbaud') return Number(String(v).trim())
  if (name === 'expectedMac') return normMac(v)
  if (name === 'scanDurations') {
    const f = fieldsOf(config).scanDurations
    const asArray = !!f && [f.value, f.configValue, f.default].some(Array.isArray)
    const t = scanText(v)
    return asArray ? t.split(',').filter(Boolean).map(Number) : t
  }
  if (name === 'mode') return v === 'simulator' ? 'simulator' : 'serial'
  return String(isSet(v) ? v : '').trim()
}

/** 値の表示（差分・出どころ）。null は「未設定」、空の文字は「（空）」。 */
export function configValueText(name, v) {
  if (!isSet(v)) return S.settings.unset
  if (name === 'enabled') return v ? S.config.enabledOn : S.config.enabledOff
  if (name === 'autoStart') return v ? S.config.yes : S.config.no
  if (name === 'mode') return S.config.modes[v] || String(v)
  if (name === 'serialbaud') return v === '' ? S.config.empty : S.config.baud(v)
  if (name === 'scanDurations') return scanText(v) || S.config.empty
  const s = String(v)
  return s === '' ? S.config.empty : s
}

/**
 * 下書きとサーバーの値の差分。PUT の本文と、確認ダイアログの行を返す。
 * reconnect: 接続に関わる項目が入っている（確認に「接続し直します（30〜90 秒止まります）」）。
 * disabling: 有効を外す（確認に「計測を止めます」）。
 */
export function diffConfigDraft(draft, config) {
  const base = configDraftFrom(config)
  const patch = {}
  const changes = []
  for (const n of changedConfigFields(draft, config)) {
    patch[n] = patchValue(n, draft[n], config)
    changes.push({
      field: n,
      label: S.config.fields[n],
      from: configValueText(n, BOOL_FIELDS.includes(n) ? base[n] : comparable(n, base[n])),
      to: configValueText(n, patch[n]),
    })
  }
  const f = fieldsOf(config)
  // 接続に関わる項目はサーバーの印（SettingField.connection）が正。無ければ RECONNECT_FIELDS
  const isConnection = (n) => (f[n] && typeof f[n].connection === 'boolean' ? f[n].connection : RECONNECT_FIELDS.includes(n))
  return {
    patch,
    changes,
    reconnect: changes.some((c) => isConnection(c.field)) || (own(patch, 'enabled') && patch.enabled === true),
    disabling: own(patch, 'enabled') && patch.enabled === false,
  }
}

/**
 * その項目に「画面かフローで保存した値」があるか（運用設定の hasRuntimeRecord と同じ規則）。
 * runtimeValue を返すサーバーでは、それだけが正（by が 'editor' の項目は、エディタの照合で外したあと）。
 */
export function hasConfigRecord(field) {
  if (!field) return false
  if (field.source === 'runtime') return true
  if (own(field, 'runtimeValue')) return isSet(field.runtimeValue)
  return isSet(field.by) && field.by !== 'editor'
}

// ---- ポートの候補 ---------------------------------------------------------

/** シミュレータの候補か（接続先で選ぶので、ポートの候補からは除く）。 */
export function isSimulatorPort(item) {
  if (!item) return false
  return item.simulator === true || item.kind === 'simulator' || item.mode === 'simulator' || item.path === 'simulator'
}

const BY_ID = '/dev/serial/by-id/'

const baseName = (p) => String(p).split(/[\\/]/).pop()
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * ポートの短い名前（サーバーの portLabelOf と同じ規則）。ttyUSBn → USBn、ttyACMn → ACMn、COMn・\\.\COMn → COMn。
 * by-id のように短くできない名前は null（呼び手が realPath か名前の末尾で補う）。
 */
export function shortPort(p) {
  const s = str(p)
  if (!s) return null
  let m = /(?:^|[\\/])tty(USB|ACM)(\d+)$/.exec(s)
  if (m) return m[1] + m[2]
  m = /(?:^|\\)(COM\d{1,3})$/i.exec(s)
  if (m) return m[1].toUpperCase()
  return null
}

/** 候補の説明（メーカーか、パスを繰り返さないラベル）。 */
function detailOf(it, names) {
  const manu = str(it.manufacturer)
  if (manu) return manu
  const label = str(it.label)
  if (!label) return ''
  return names.some((n) => n === label || label.indexOf(n) >= 0 || label.indexOf(baseName(n)) >= 0) ? '' : label
}

/** 使っているもの（usedBy: {kind, id, name} | 名前の配列 | null。前の版の ownedBy: {id, name}）。自分なら null。 */
function usedOf(it, selfId) {
  const u = it.usedBy
  if (u && typeof u === 'object' && !Array.isArray(u)) {
    if (u.kind !== 'flow' && u.id !== undefined && u.id === selfId) return null
    return { kind: u.kind === 'flow' ? 'flow' : 'adapter', id: u.id === undefined ? null : u.id, name: str(u.name) || str(u.id) || S.unknown }
  }
  if (Array.isArray(u) && u.length) {
    const names = u.map(str).filter(Boolean)
    if (names.length) return { kind: 'adapter', id: null, name: names.join(S.listSep) }
  }
  const o = it.ownedBy && typeof it.ownedBy === 'object' ? it.ownedBy : null
  if (o && o.id !== selfId) return { kind: 'adapter', id: o.id === undefined ? null : o.id, name: str(o.name) || str(o.id) || S.unknown }
  return null
}

const KINDS = ['wsuha', 'maybe', 'other']

/**
 * GET serialports の items から、ポートの select を作る。
 * - 機器（実体）ごとに 1 つ。値は by-id があればそれ（抜き差しで番号が変わらない）。ほかの名前（ttyUSB0・実体）は names に。
 *   前の版のサーバー（{path: ttyUSB0, byId: '<by-id>'} の 2 つの名前を 1 件で返す）も、同じく 1 つにまとめる。
 * - 表示は「USB0 — FTDI（by-id）」。シミュレーターの候補は除く（接続先で選ぶ）。
 * - kind（wsuha・maybe・other）があれば、optgroup を「Wi-SUN アダプタらしいもの」（wsuha → maybe の順）と「ほかの USB シリアル機器」に分ける。
 *   kind を返さない前の版のサーバーでは optgroup を作らない（1 つのまとまり）。
 * - ほかの台・フローが使っているポート（usedBy。自分 selfId は除く）は used に入れる（画面は選べなくする）。
 *   nameOf(id, name) で、使っている台の文の中の名前（「電力（USB0）」）に読み替えられる。
 * - 今の値（current）の実体が候補のどれかと同じなら selected にその候補（値は変えない）。どれとも違えば missing に今の値。
 * @returns {{groups: {key: string|null, items: object[]}[], items: object[], selected: object|null, missing: string|null}}
 */
export function portOptions(items, current, selfId, nameOf) {
  // 名前 → 機器（同じ実体の名前が別の件に出ても 1 つにまとめる）
  const byName = new Map()
  const list = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.path !== 'string' || !it.path || isSimulatorPort(it)) continue
    const byIdName = typeof it.byId === 'string' && it.byId ? it.byId : null
    const value = byIdName || it.path
    const real = str(it.realPath) || null
    const names = Array.from(new Set([value, it.path, byIdName, real].concat(Array.isArray(it.aliases) ? it.aliases : []).map(str).filter(Boolean)))
    let d = names.map((n) => byName.get(n)).find(Boolean)
    if (d) {
      for (const n of names) {
        if (!d.names.includes(n)) d.names.push(n)
        byName.set(n, d)
      }
      // by-id の名前は後から分かっても値にする（抜き差しで番号が変わらない）
      if (!d.byId && value.indexOf(BY_ID) === 0) {
        d.value = value
        d.byId = true
      }
      continue
    }
    const isById = value.indexOf(BY_ID) === 0 || it.byId === true
    const used = usedOf(it, selfId)
    if (used && used.kind === 'adapter' && typeof nameOf === 'function') used.name = nameOf(used.id, used.name) || used.name
    d = {
      value,
      names,
      byId: isById,
      short: null,
      detail: '',
      kind: KINDS.includes(it.kind) ? it.kind : null,
      hint: str(it.hint) || null,
      used,
    }
    d.short = shortPort(real) || d.names.map(shortPort).find(Boolean) || baseName(value)
    d.detail = detailOf(it, d.names)
    for (const n of names) byName.set(n, d)
    list.push(d)
  }
  const anyKind = list.some((d) => d.kind)
  const groups = anyKind
    ? [
        { key: 'wsuha', items: list.filter((d) => d.kind === 'wsuha').concat(list.filter((d) => d.kind === 'maybe')) },
        { key: 'other', items: list.filter((d) => d.kind !== 'wsuha' && d.kind !== 'maybe') },
      ].filter((g) => g.items.length)
    : list.length
      ? [{ key: null, items: list }]
      : []
  const cur = str(current)
  const selected = cur ? list.find((d) => d.names.includes(cur)) || null : null
  return { groups, items: list, selected, missing: cur && !selected ? cur : null }
}

/** ポートの候補の表示（「USB0 — FTDI（by-id）（「電力（USB1）」が使っています）」）。 */
export function portOptionText(d) {
  const base = S.config.portOption(d.short, d.detail, d.byId)
  if (!d.used) return base
  return base + (d.used.kind === 'flow' ? S.config.portUsedByFlow(d.used.name) : S.config.portUsedByAdapter(d.used.name))
}

// ---- 契約 ---------------------------------------------------------------------

/** select の決まった値（「電力」「動力」）。それ以外の文字は「その他（名前を入力）」。 */
export const ROLE_PRESETS = [S.roles.light, S.roles.motive]
/** select の「その他」の値（保存する値ではない）。 */
export const ROLE_OTHER = '__other__'

/** 今の値が決まった値でない（「その他」で開く）か。空は「未設定」。 */
export function isCustomRole(v) {
  const t = str(v)
  return !!t && !ROLE_PRESETS.includes(t)
}

const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * 契約の検証（1〜32 文字・制御文字なし。「その他」で空なら「契約の名前を入力してください」）。
 * required は追加の画面（未設定を選べない）。通れば null。
 */
export function roleError(value, { other = false, required = false, max = 32 } = {}) {
  const raw = typeof value === 'string' ? value : ''
  const t = raw.trim()
  if (other && !t) return S.roles.errOtherEmpty
  if (!t) return required ? S.roles.errPick : null
  if (CONTROL.test(raw)) return S.roles.errControl
  if (Array.from(t).length > max) return S.config.errTooLong(max)
  return null
}

// ---- 認証情報 ---------------------------------------------------------------------------

/**
 * 認証 ID（32 桁の 16 進数）とパスワード（12 桁の英数字）の形。理由の文に値を入れない。
 * サーバー（lib/runtime/credentials-store.js の validateCredentialsInput）と同じ形: 前後の空白を除いてから見る。
 * 画面だけが通す値は「接続し直します」の確認のあとで 422、サーバーだけが通す値は保存できない、になるのでそろえる。
 */
export function validateCredentials(id, password) {
  const errors = {}
  if (!/^[0-9A-Fa-f]{32}$/.test(String(id || '').trim())) errors.routeBId = S.config.credIdInvalid
  if (!/^[0-9A-Za-z]{12}$/.test(String(password || '').trim())) errors.routeBPassword = S.config.credPasswordInvalid
  return errors
}

// ---- 基本設定と詳細設定 --------------------------------------------------------

/**
 * その項目が基本設定か（SettingField / ConfigField の tier）。出し分けは API の tier だけで決め、画面は 2 つ目の表を持たない。
 * tier の無い古いサーバーでは全部基本設定。
 */
export function isBasic(data, name) {
  const f = data && data.fields && data.fields[name]
  return !f || f.tier !== 'advanced'
}

/** 「アダプタと接続」のカードの項目の並び（どちらの段に出すかは tier）。 */
export const CONFIG_ORDER = ['role', 'name', 'mode', 'serialport', 'enabled', 'autoStart', 'serialbaud', 'deviceKey', 'expectedMac', 'scanDurations']

/** 既定の通信速度（RS-WSUHA）。select の先頭に「115200 bps（既定・RS-WSUHA）」で出す。 */
export const DEFAULT_BAUD = 115200

/** 速度の候補を、既定（115200）を先頭にして並べる。 */
export function baudChoices(config, current) {
  const list = baudOptions(config, current)
  const i = list.indexOf(DEFAULT_BAUD)
  if (i > 0) {
    list.splice(i, 1)
    list.unshift(DEFAULT_BAUD)
  }
  return list
}

/** 詳細設定の summary の要約（「115200 bps · キーなし · MAC の照合なし · 自動で始める」）。 */
export function configMoreSummary(draft) {
  const parts = []
  if (draft.enabled === false) parts.push(S.config.sumDisabled)
  if (draft.mode !== 'simulator' && String(draft.serialbaud || '').trim()) parts.push(S.config.baud(String(draft.serialbaud).trim()))
  const key = String(draft.deviceKey || '').trim()
  parts.push(key ? S.config.sumKey(key) : S.config.sumKeyNone)
  parts.push(normMac(draft.expectedMac) ? S.config.sumMacOn : S.config.sumMacOff)
  parts.push(draft.autoStart === false ? S.config.sumAutoOff : S.config.sumAutoOn)
  return parts.join(S.more.sep)
}

/**
 * 保存の確認の文（台の状態で変える）。
 * - 自動で始めるが外れていて止まっている: 「保存したあと「開始」を押すと接続を始めます」
 * - ポートをまだ開いていない: 「このポートを開いて、接続を始めます」
 * - つながっている・つないでいる途中: 「接続し直します（30〜90 秒止まります）」
 */
export function reconnectNote(a, autoStart) {
  if (a && a.running === false && autoStart === false) return S.config.pressStartNote
  if (a && a.portOpen === false) return S.config.openPortNote
  return S.config.reconnectWarn
}

// ---- アダプタの追加 -----------------------------------------------------------

/** シミュレーターで追加するときに入れておく架空の認証情報（実機では使えない。試験と同じ値）。 */
export const SIM_CRED = { id: '0123456789ABCDEF0123456789ABCDEF', password: 'ABCDEF123456' }

/** 追加の画面の下書きの初期値（名前とデバイスキーは空・自動で始めるはオン）。 */
export function addFormInitial() {
  return { role: '', roleOther: false, name: '', mode: 'serial', serialport: '', serialbaud: String(DEFAULT_BAUD), deviceKey: '', expectedMac: '', autoStart: true }
}

/**
 * 追加の画面の検証。creds は入力欄の長さと値（DOM の中だけにある値を、送る直前にだけ読む）。
 * @param {object} form addFormInitial の形
 * @param {{id: string, password: string}} creds
 * @returns {{[field]: string}}
 */
export function validateAddForm(form, creds) {
  const errors = {}
  const re = roleError(form.role, { other: !!form.roleOther, required: true, max: 32 })
  if (re) errors.role = re
  const name = String(form.name || '')
  if (/[\u0000-\u001f\u007f]/.test(name)) errors.name = S.roles.errControl
  else if (Array.from(name.trim()).length > 100) errors.name = S.config.errTooLong(100)
  if (form.mode !== 'simulator') {
    const p = String(form.serialport || '').trim()
    if (!p) errors.serialport = S.config.errPort
    else if (!portFormOk(p)) errors.serialport = S.config.errPortForm
    const b = Number(String(form.serialbaud || '').trim())
    if (!Number.isInteger(b) || b <= 0) errors.serialbaud = S.config.errBaud
  }
  const key = String(form.deviceKey || '').trim()
  if (!/^[A-Za-z0-9_-]*$/.test(key) || key.length > 32) errors.deviceKey = S.config.errDeviceKey
  const mac = normMac(form.expectedMac)
  if (mac && !/^[0-9A-F]{16}$/.test(mac)) errors.expectedMac = S.config.errMac
  const id = String((creds && creds.id) || '').trim()
  const pw = String((creds && creds.password) || '').trim()
  if (id || pw) {
    if (!id || !pw) errors.routeBPassword = S.config.credPairRequired
    const ce = validateCredentials(id, pw)
    if (id && ce.routeBId) errors.routeBId = ce.routeBId
    if (pw && ce.routeBPassword) errors.routeBPassword = ce.routeBPassword
  }
  return errors
}

/**
 * POST adapters の本文（知らない項目は 422 なので、決まった項目だけ）。
 * 名前とデバイスキーは空なら送らない（サーバーは空のまま書く）。シミュレーターはポートと速度を送らない。
 * 認証情報は両方あるときだけ（片方だけは 422）。
 */
export function addBody(form, creds) {
  const body = { role: String(form.role || '').trim(), mode: form.mode === 'simulator' ? 'simulator' : 'serial' }
  const name = String(form.name || '').trim()
  if (name) body.name = name
  if (body.mode === 'serial') {
    body.serialport = String(form.serialport || '').trim()
    body.serialbaud = Number(String(form.serialbaud || '').trim())
  }
  const key = String(form.deviceKey || '').trim()
  if (key) body.deviceKey = key
  const mac = normMac(form.expectedMac)
  if (mac) body.expectedMac = mac
  body.autoStart = form.autoStart !== false
  const id = String((creds && creds.id) || '').trim()
  const pw = String((creds && creds.password) || '').trim()
  if (id && pw) {
    body.routeBId = id
    body.routeBPassword = pw
  }
  return body
}

/** 追加の画面の項目（422 の details の鍵と同じ名前）。 */
export const ADD_FIELDS = ['role', 'name', 'mode', 'serialport', 'routeBId', 'routeBPassword', 'serialbaud', 'deviceKey', 'expectedMac', 'autoStart']
/** 追加の画面で詳細設定に入れる項目（誤りがあれば開いてフォーカスする）。 */
export const ADD_ADVANCED = ['serialbaud', 'deviceKey', 'expectedMac', 'autoStart']
