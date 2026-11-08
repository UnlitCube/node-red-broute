'use strict'

// ============================================================================
//  画面かフローで保存した B ルート認証情報（<userDir>/wsuha-broute/credentials/<設定ノードの id>.json）
// ============================================================================
//
//  - 値は **ここにだけ** 置く。settings.json・画面・API・SSE・ログのリング・出力 2・Node-RED のログには出さない。
//    読み出す関数（read）は設定ノード（nodes/wsuha-device.js）だけが使い、sequencer へ渡す。
//  - ディレクトリ 700・ファイル 600。.tmp に書いて rename（途中で落ちても半端なファイルを残さない）。
//  - 優先の順（nodes/wsuha-device.js の resolveCredentials）:
//      環境変数 > 画面かフローで保存した値（ここ）> エディタの設定ノードの値 > 秘密ファイル（移行用）
//  - credAtSet: 保存したときの「エディタの設定ノードの認証情報」の指紋（塩つきの sha256）。
//    運用設定の configAtSet と同じ後勝ち（認証情報は画面とエディタのどちらからでも変えられるため）:
//    あとからエディタで認証情報を入れ直したら（指紋が変わったら）ここの値を外してエディタを優先する。
//    エディタの値そのものはここに書かない。指紋から値は戻せない（塩はファイルごと・保存ごとの乱数）。
//    エディタの値が空なら指紋は 'none'（空のまま画面で保存し、あとでエディタで入れたら外れる）。
//    エディタを空にした・片方だけ入っているのは「入れ直し」に数えない: 外さずに、控えの指紋を今の値に書き換えて画面の値を残す
//    （平文を flows_cred.json から消すつもりで空にした・鍵を失って Node-RED が認証情報を空にして始めた、のどちらでも、
//    画面の値が唯一の写しのことがある。片方だけの値は使えないので、外すと動いている台の認証情報が無くなって計測が止まる）。
//    あとでエディタに両方を入れたら、今までどおりエディタが勝つ。
//    古い形のファイルは同じものを editorAtSet と書いている。読むときは両方を受ける。
//  - 壊れたファイルは .bad-<日時> に退避する（600 のまま）。理由は code だけをログに出す
//    （JSON.parse の文は入力の断片 = 秘密を含むことがあるため）。
//
//  ここは Node-RED に依存しない。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const VERSION = 1

function stamp(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 設定ノードの id をファイル名にする（/ や .. を入れない）。英数字と _ - だけならそのまま、ほかは 16 進にする。 */
function fileNameOf(id) {
  const s = String(id)
  if (/^[A-Za-z0-9_-]{1,100}$/.test(s)) return s + '.json'
  return 'x' + Buffer.from(s, 'utf8').toString('hex').slice(0, 200) + '.json'
}

/** エディタの認証情報の指紋。空（未入力）は 'none'。 */
function fingerprint(salt, id, password) {
  const i = id ? String(id).trim().toUpperCase() : ''
  const p = password ? String(password).trim().toUpperCase() : ''
  if (!i && !p) return 'none'
  return crypto.createHash('sha256').update(String(salt) + '\n' + i + '\n' + p).digest('hex')
}

/**
 * 認証情報の形を確かめる（今の sequencer の検証と同じ: ID は 32 桁の 16 進数、パスワードは 12 桁の英数字）。
 * 理由の文に値を入れない（長さだけ）。
 * @returns {{id?: string, password?: string, errors: object}}
 */
function validateCredentialsInput(body) {
  const errors = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors._ = '本文は JSON のオブジェクト {routeBId, routeBPassword} で送ってください'
    return { errors }
  }
  for (const k of Object.keys(body)) {
    if (k !== 'routeBId' && k !== 'routeBPassword') errors[k] = 'この項目は受け付けません（routeBId と routeBPassword だけ）'
  }
  const id = typeof body.routeBId === 'string' ? body.routeBId.trim() : null
  const pw = typeof body.routeBPassword === 'string' ? body.routeBPassword.trim() : null
  if (id === null) errors.routeBId = '認証 ID を文字列で指定してください（32 桁の 16 進数）'
  else if (!/^[0-9A-Fa-f]{32}$/.test(id)) errors.routeBId = `認証 ID は 32 桁の 16 進数です（いま ${id.length} 文字）`
  if (pw === null) errors.routeBPassword = 'パスワードを文字列で指定してください（12 桁の英数字）'
  else if (!/^[0-9A-Za-z]{12}$/.test(pw)) errors.routeBPassword = `パスワードは 12 桁の英数字です（いま ${pw.length} 文字）`
  if (Object.keys(errors).length) return { errors }
  return { id: id.toUpperCase(), password: pw.toUpperCase(), errors }
}

/**
 * @param {object} opts
 * @param {string|null} opts.dir  credentials のディレクトリ（<userDir>/wsuha-broute/credentials）。null ならメモリだけ
 * @param {function} [opts.log]   (level, text)
 * @param {function} [opts.now]
 */
function createCredentialsStore(opts) {
  const o = opts || {}
  const dir = o.dir || null
  const log = typeof o.log === 'function' ? o.log : function () {}
  const nowFn = typeof o.now === 'function' ? o.now : Date.now
  const memory = new Map() // dir が無いとき（userDir が分からない）
  // 読んだ結果（無いことも）。書くのはこのプロセスだけなので、書く・消すときに捨てる
  // （画面の Config は状態が変わるたびに作り直すので、そのたびにファイルを読まないため）。
  // 手でファイルを置き換えたら Node-RED の再起動で読み直す
  const cache = new Map()

  function fileOf(id) {
    return dir ? path.join(dir, fileNameOf(id)) : null
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(dir, 0o700)
      fs.chmodSync(path.dirname(dir), 0o700)
    } catch (e) {
      /* Windows など、権限を変えられない環境では続ける */
    }
  }

  function quarantine(file, why) {
    const bad = `${file}.bad-${stamp(nowFn())}`
    try {
      fs.renameSync(file, bad)
      try {
        fs.chmodSync(bad, 0o600)
      } catch (e) {
        /* 同上 */
      }
      log('warn', `Web UI かフローで保存した認証情報のファイルが壊れていたので退避しました（${why}）: ${path.basename(bad)}`)
    } catch (err) {
      log('warn', `Web UI かフローで保存した認証情報のファイルが壊れていて、退避もできませんでした（${why}・${err.code || 'ERROR'}）`)
    }
  }

  /**
   * 保存した値を読む（設定ノードだけが使う。値を画面やログに出さない）。
   * @returns {{id, password, by, at, salt, credAtSet}|null}
   */
  function read(id) {
    if (!dir) {
      const m = memory.get(String(id))
      return m ? Object.assign({}, m) : null
    }
    const key = String(id)
    if (cache.has(key)) {
      const c = cache.get(key)
      return c ? Object.assign({}, c) : null
    }
    const r = readFile(id)
    cache.set(key, r)
    return r ? Object.assign({}, r) : null
  }

  function readFile(id) {
    const file = fileOf(id)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') log('warn', `Web UI かフローで保存した認証情報のファイルを読めません（${err.code || 'ERROR'}）。設定ノードの値で動きます`)
      return null
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (err) {
      quarantine(file, 'JSON として読めません')
      return null
    }
    const ok =
      body &&
      body.version === VERSION &&
      typeof body.id === 'string' &&
      /^[0-9A-F]{32}$/.test(body.id) &&
      typeof body.password === 'string' &&
      /^[0-9A-Z]{12}$/.test(body.password) &&
      typeof body.salt === 'string'
    if (!ok) {
      quarantine(file, '形が違います')
      return null
    }
    return {
      id: body.id,
      password: body.password,
      by: typeof body.by === 'string' ? body.by : null,
      at: typeof body.at === 'number' ? body.at : null,
      salt: body.salt,
      // 古い形のファイルの editorAtSet も同じもの
      credAtSet: typeof body.credAtSet === 'string' ? body.credAtSet : typeof body.editorAtSet === 'string' ? body.editorAtSet : null,
    }
  }

  /** 保存してあるか・誰がいつ（値は返さない）。 */
  function info(id) {
    const r = read(id)
    return r ? { by: r.by, at: r.at } : null
  }

  /**
   * 保存する。.tmp（600）に書いて rename。
   * @param {object} p {id, password, by, editorFingerprint(salt) | editorId, editorPassword}
   *   エディタの設定ノードのいまの認証情報は指紋だけを残す（AdapterHandle.editorFingerprint が値を閉じ込めたまま作る）
   */
  function write(nodeId, p) {
    const salt = crypto.randomBytes(16).toString('hex')
    const rec = {
      version: VERSION,
      id: String(p.id).toUpperCase(),
      password: String(p.password).toUpperCase(),
      by: p.by || null,
      at: nowFn(),
      salt,
      credAtSet: typeof p.editorFingerprint === 'function' ? String(p.editorFingerprint(salt)) : fingerprint(salt, p.editorId, p.editorPassword),
    }
    if (!dir) {
      memory.set(String(nodeId), rec)
      return { by: rec.by, at: rec.at }
    }
    ensureDir()
    cache.delete(String(nodeId))
    const file = fileOf(nodeId)
    const tmp = file + '.tmp'
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(rec, null, 2) + '\n')
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
    fs.renameSync(tmp, file)
    return { by: rec.by, at: rec.at }
  }

  /**
   * 消す。<id>.json を消したら true。
   * 書きかけの .tmp と、壊れたときの退避 .bad-<日時>（平文の断片を含みうる）も一緒に消す。
   * 退避と書きかけだけが残っていた（<id>.json が無い）ときは false（効いている値は変わらない）。
   */
  function remove(nodeId) {
    if (!dir) return memory.delete(String(nodeId))
    cache.delete(String(nodeId))
    const file = fileOf(nodeId)
    let removed = false
    try {
      fs.unlinkSync(file)
      removed = true
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const base = path.basename(file)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch (e) {
      names = []
    }
    for (const n of names) {
      if (n !== base + '.tmp' && n.indexOf(base + '.bad-') !== 0) continue
      try {
        fs.unlinkSync(path.join(dir, n))
      } catch (e) {
        log('warn', `Web UI かフローで保存した認証情報の退避か書きかけを消せませんでした（${e.code || 'ERROR'}）: ${n}`)
      }
    }
    return removed
  }

  /**
   * 保存してある台のファイル名から戻した id（孤児の数を知らせるため。値は読まない）。
   * fileNameOf が 16 進にした名前（x…）も戻す。.tmp・.bad-* は数えない。
   */
  function ids() {
    if (!dir) return Array.from(memory.keys())
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch (e) {
      return []
    }
    const out = []
    for (const n of names) {
      const m = /^(.+)\.json$/.exec(n)
      if (!m) continue
      const stem = m[1]
      if (/^x[0-9a-f]+$/.test(stem) && stem.length % 2 === 1) {
        // 16 進にした名前か（そのままの id が x で始まる 16 進の並びのこともあるので、作り直して同じかで見分ける）
        const decoded = Buffer.from(stem.slice(1), 'hex').toString('utf8')
        if (fileNameOf(decoded) === n) {
          out.push(decoded)
          continue
        }
      }
      out.push(stem)
    }
    return out
  }

  /** 控えの指紋（credAtSet）だけを書き換える（値・by・at・塩はそのまま。.tmp に書いて rename）。 */
  function rewriteCredAtSet(nodeId, r, credAtSet) {
    const rec = { version: VERSION, id: r.id, password: r.password, by: r.by, at: r.at, salt: r.salt, credAtSet }
    if (!dir) {
      memory.set(String(nodeId), rec)
      return
    }
    cache.delete(String(nodeId))
    const file = fileOf(nodeId)
    const tmp = file + '.tmp'
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(rec, null, 2) + '\n')
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
      /* Windows など、権限を変えられない環境では続ける */
    }
    fs.renameSync(tmp, file)
  }

  /**
   * 起動時の照合。保存したときのエディタの認証情報（指紋）と今の値が違えば（エディタで入れ直した）、保存した値を外す。
   * 今のエディタの値が空か片方だけなら外さない: 入れ直しではない（使える値が無い）。控えの指紋を今の値にして残す。
   * @returns {boolean} 外したら true
   */
  function reconcile(nodeId, editorId, editorPassword) {
    const r = read(nodeId)
    if (!r || r.credAtSet === null) return false
    const now = fingerprint(r.salt, editorId, editorPassword)
    if (now === r.credAtSet) return false
    const full = !!(editorId && String(editorId).trim()) && !!(editorPassword && String(editorPassword).trim())
    if (!full) {
      try {
        rewriteCredAtSet(nodeId, r, now)
        log('info', '設定ノードの認証情報が空か片方だけです。Web UI かフローで保存した認証情報を使い続けます（両方入れると設定ノードの値が優先されます）')
      } catch (err) {
        log('warn', `Web UI かフローで保存した認証情報の控えを書き換えられませんでした（${err.code || 'ERROR'}）。保存した値はそのまま使います`)
      }
      return false
    }
    try {
      remove(nodeId)
    } catch (err) {
      log('warn', `Web UI かフローで保存した認証情報を外せませんでした（${err.code || 'ERROR'}）`)
      return false
    }
    return true
  }

  return { read, info, write, remove, reconcile, ids, dir }
}

/**
 * その台に効く環境変数の認証情報（WSUHA_BROUTE_ID_<KEY> か、接尾辞の無い WSUHA_BROUTE_ID。パスワードも同じ）。
 * 規則は nodes/wsuha-device.js の resolveCredentials の 1 番目と同じ（ID とパスワードの両方があれば効く）。
 * 値を返すのは PairID を比べるため（409 PAIR_IN_USE）。呼んだ側は値を応答・ログに出さない。
 * @param {string} deviceKey 効いている構成のデバイスキー（空なら接尾辞なしだけ）
 * @param {object} [env] 既定は process.env（試験で差し替える）
 * @returns {{id: string, password: string, suffixed: boolean}|null}
 */
function envCredentialsOf(deviceKey, env) {
  const e = env || process.env
  const pick = (name) => {
    const v = e[name]
    if (v === undefined || v === null) return null
    const s = String(v).trim()
    return s === '' ? null : s
  }
  const key = String(deviceKey || '').trim()
  const suffix = key ? '_' + key.toUpperCase() : ''
  const sid = suffix ? pick('WSUHA_BROUTE_ID' + suffix) : null
  const spw = suffix ? pick('WSUHA_BROUTE_PASSWORD' + suffix) : null
  const id = sid || pick('WSUHA_BROUTE_ID')
  const pw = spw || pick('WSUHA_BROUTE_PASSWORD')
  if (!id || !pw) return null
  return { id, password: pw, suffixed: !!sid }
}

/** 認証 ID の PairID（下 8 桁。電波にも出る値）。ID の形でなければ null。 */
function pairIdOf(id) {
  const s = typeof id === 'string' ? id.trim() : ''
  return /^[0-9A-Fa-f]{32}$/.test(s) ? s.slice(-8).toUpperCase() : null
}

module.exports = { createCredentialsStore, validateCredentialsInput, fingerprint, fileNameOf, envCredentialsOf, pairIdOf }
