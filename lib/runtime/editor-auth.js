'use strict'

// ============================================================================
//  Node-RED の認証（settings.js の adminAuth）で、Web UI からの変更を守る
// ============================================================================
//
//  Web UI に独自のログインは持たない。エディタにログインしたときのトークンを画面が
//  X-Wsuha-Editor-Token のヘッダで送り、Node-RED の RED.auth.needsPermission に確かめてもらう。
//  settings.js の permissions がそのまま効く（'*'・'write'・'wsuha-broute.write' は通り、'read' は通らない）。
//  adminAuth.default で匿名に権限を与えたサーバーでは、Node-RED の設定どおりに匿名でも通る。
//
//  Authorization のヘッダでトークンを受けない理由:
//    httpNodeAuth の Basic 認証が同じヘッダを読むので、Bearer を載せるとこのパッケージに届く前に 401 になる。
//    needsPermission はこのヘッダしか読まないので、確かめる間だけ Bearer の形に写し、終わったら元へ戻す。
//
//  res に書かせない理由:
//    needsPermission は失敗の 401 を自分で返す（本文は英語の文か空）。通らなかった理由を画面に渡すため、
//    res の代役で受け止めて JSON にする。書き方は 2 通りある: 認証の失敗は passport が res.statusCode と
//    res.setHeader と res.end で、権限の不足は Node-RED が res.status(401).end() で書く。
//    代役に無いメソッドを呼ばれると、非同期の中で投げられて Node-RED ごと落ちるので、express の主なものをそろえてある。
//
//  閉じる側に倒す:
//    httpAdminRoot: false のサーバーでは Node-RED の認証の仕組みが初期化されず、needsPermission は何も確かめずに
//    next() を呼ぶ。通ったのに req.user が無いときは、確かめられなかったとみなして断る
//    （adminAuth があるときは、匿名でも通るなら passport が req.user を置く）。
//
//  エディタを別の方法で閉じたサーバー（editorGuardedElsewhere）:
//    httpAdminAuth・httpAdminMiddleware（根が別のとき）と httpAdminRoot: false は、エディタと管理 API だけを守り、
//    httpNode には掛からない。放っておくと、エディタを閉じたつもりのサーバーで Web UI だけが匿名で開いたままになる。
//    ログインした人を確かめる手段も無いので、変更を全部断る。読むだけの API と画面はそのまま。
//    開くのは、Node-RED が実際に掛ける httpNodeAuth・httpAuth（httpNode ごと守る）か、
//    wsuhaBroute.allowAnonymousWrites: true（分かったうえで開ける）。
//    httpNodeAuth と httpAuth を掛けるのは node-red の red.js だけで、RED.init で埋め込んだサーバーには掛からない。
//    埋め込みでは書いてあっても守りに数えず、開くのは allowAnonymousWrites だけにする。

const TOKEN_HEADER = 'x-wsuha-editor-token'
const WRITE_PERMISSION = 'wsuha-broute.write'
const LOGIN_REQUIRED_MESSAGE = '変更するには Node-RED にログインしてください'
const FORBIDDEN_MESSAGE = 'このユーザーには変更の権限がありません'
const NO_LOGIN_MESSAGE = 'このサーバーではログインの手段が使えないので、画面から変更できません。settings.js の認証の設定を確かめてください'

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/** 画面が送ったエディタのトークン。無ければ ''。 */
function editorTokenOf(req) {
  const h = (req && req.headers) || {}
  const v = Array.isArray(h[TOKEN_HEADER]) ? h[TOKEN_HEADER][0] : h[TOKEN_HEADER]
  return typeof v === 'string' ? v.trim() : ''
}

/** / で始まり / で終わる形にする（Node-RED の red.js の formatRoot と同じ。埋め込みのサーバーは自分でそろえないので、ここでそろえる）。 */
function formatRoot(root) {
  const s = String(root)
  const head = s.charAt(0) === '/' ? s : '/' + s
  return head.slice(-1) === '/' ? head : head + '/'
}

/** httpNode の根（/ で終わる形）。httpNode を切っているサーバーは null。 */
function nodeRootOf(settings) {
  const s = settings || {}
  if (s.httpRoot === false || s.httpNodeRoot === false) return null
  return formatRoot(s.httpNodeRoot || s.httpRoot || '/')
}

/** red.js で起動したサーバーか。red.js は設定を読んだ直後に settingsFile を置く。RED.init で埋め込んだサーバーには無い。 */
function startedByRedJs(settings) {
  return typeof (settings || {}).settingsFile === 'string'
}

/**
 * エディタを adminAuth 以外の方法で閉じていて、httpNode には守りが掛からないサーバーか。
 * adminAuth は Node-RED に確かめられる。red.js で起動したサーバーの httpNodeAuth と httpAuth は httpNode ごと守る。
 * どちらも、ここで閉じる理由が無い。埋め込みのサーバーでは、httpNodeAuth と httpAuth は書いてあっても掛からないので数えない。
 * httpAdminAuth と httpAdminMiddleware は httpAdmin の根の下だけを守るので、httpNode がその下にあれば httpNode にも掛かる
 * （既定の、根が同じ '/' のサーバーはこちら）。
 * @param {object} settings RED.settings
 */
function editorGuardedElsewhere(settings) {
  const s = settings || {}
  if (s.adminAuth || (startedByRedJs(s) && (s.httpNodeAuth || s.httpAuth))) return false
  if (s.httpAdminRoot === false || s.httpRoot === false) return true
  if (!s.httpAdminAuth && !s.httpAdminMiddleware) return false
  const nodeRoot = nodeRootOf(s)
  return nodeRoot !== null && !nodeRoot.startsWith(formatRoot(s.httpAdminRoot || s.httpRoot || '/'))
}

/** エディタを別の方法で閉じたので、Web UI からの変更も閉じるサーバーか（wsuhaBroute.allowAnonymousWrites: true なら開ける）。 */
function closedElsewhere(settings) {
  const s = settings || {}
  return editorGuardedElsewhere(s) && !(s.wsuhaBroute && s.wsuhaBroute.allowAnonymousWrites === true)
}

/**
 * GET meta の auth。
 * @param {object} settings RED.settings
 * @param {string|null} editorPath エディタの入口（Node-RED のエディタが無ければ null）
 * @returns {{required: boolean, available: boolean, editorPath: string|null, nodeRoot: string|null}}
 *   required は変更に認証が要るか（adminAuth があるか、エディタを別の方法で閉じたサーバー）。
 *   available はエディタでログインできるか。別の方法で閉じたサーバーは、エディタに入れてもログインの手段が無いので false。
 *   nodeRoot は httpNode の根。画面が location.pathname と比べて、逆プロキシが足した接頭辞を求める。
 */
function authMeta(settings, editorPath) {
  const s = settings || {}
  const closed = closedElsewhere(s)
  const path = !closed && typeof editorPath === 'string' ? editorPath : null
  return { required: !!s.adminAuth || closed, available: path !== null, editorPath: path, nodeRoot: nodeRootOf(s) }
}

/** needsPermission に渡す res の代役。何かを返そうとしたら done を呼ぶ。 */
function standInRes(done) {
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    getHeader() {},
    removeHeader() {},
    set: () => res,
    header: () => res,
    type: () => res,
    status(code) {
      res.statusCode = code
      return res
    },
    write: () => true,
    end: () => done(),
    send: () => done(),
    json: () => done(),
    redirect: () => done(),
    sendStatus(code) {
      res.statusCode = code
      done()
    },
  }
  return res
}

/** needsPermission の結果を {passed, error} で受け取る。 */
function runGuard(guard, req) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (out) => {
      if (settled) return
      settled = true
      resolve(out)
    }
    try {
      guard(req, standInRes(() => finish({ passed: false, error: null })), (err) => finish({ passed: !err, error: err || null }))
    } catch (err) {
      finish({ passed: false, error: err })
    }
  })
}

/**
 * @param {object} p
 * @param {object} p.RED
 * @param {function} [p.log] (level, text)
 * @param {function} [p.editorRootOf] (settings) => エディタの入口か null
 */
function createEditorAuth(p) {
  const RED = p.RED
  const log = typeof p.log === 'function' ? p.log : () => {}
  const editorRootOf = typeof p.editorRootOf === 'function' ? p.editorRootOf : () => null
  const settingsNow = () => (RED && RED.settings) || {}

  let closedWarned = false
  function warnClosed() {
    if (closedWarned) return
    closedWarned = true
    log(
      'warn',
      'settings.js に adminAuth がありますが、Node-RED の認証の仕組みを使えません（httpAdminRoot: false など）。' +
        'ログインした人を確かめられないので、Web UI からの変更は全部断ります。変更するには、エディタの API を有効にして Node-RED を再起動してください'
    )
  }

  let guardedWarned = false
  function warnGuarded() {
    if (guardedWarned) return
    guardedWarned = true
    log(
      'warn',
      'エディタを adminAuth 以外の方法で閉じているため（httpAdminAuth・httpAdminMiddleware・httpAdminRoot: false）、' +
        'ログインした人を確かめられません。Web UI からの変更は全部断ります。' +
        (startedByRedJs(settingsNow())
          ? '開くなら settings.js に httpNodeAuth か wsuhaBroute: { allowAnonymousWrites: true } を書いてください'
          : '開くなら Node-RED の設定に wsuhaBroute: { allowAnonymousWrites: true } を書き、守りはホストのアプリで掛けてください（埋め込みの Node-RED には httpNodeAuth が掛かりません）')
    )
  }

  /** adminAuth があるのに、Node-RED の認証の仕組みを使えないと設定から分かるか。 */
  function unusable() {
    const s = settingsNow()
    return !!s.adminAuth && (s.httpAdminRoot === false || s.httpRoot === false || !RED || !RED.auth || typeof RED.auth.needsPermission !== 'function')
  }

  /** 起動時に 1 度呼ぶ。閉じているサーバーなら、断る前にログへ知らせる。 */
  function warnIfClosed() {
    if (unusable()) warnClosed()
    else if (closedElsewhere(settingsNow())) warnGuarded()
  }

  /**
   * この要求が変更できるかを Node-RED に確かめる。失敗しても投げない。
   * @returns {Promise<{required: boolean, loggedIn: boolean, canWrite: boolean, denied: null|'login'|'forbidden'}>}
   *   denied は 'login'（ログインが要る）か 'forbidden'（ログイン済みで権限が足りない）。通るなら null。
   */
  async function check(req) {
    const refuse = (denied, loggedIn) => ({ required: true, loggedIn, canWrite: false, denied })
    if (closedElsewhere(settingsNow())) {
      warnGuarded()
      return refuse('login', false)
    }
    if (!settingsNow().adminAuth) return { required: false, loggedIn: false, canWrite: true, denied: null }
    if (unusable()) {
      warnClosed()
      return refuse('login', false)
    }

    const headers = req.headers || (req.headers = {})
    const token = editorTokenOf(req)
    const hadAuthorization = hasOwn(headers, 'authorization')
    const authorization = headers.authorization
    // 手前の処理が置いた利用者を信じない（確かめたあとの req.user だけを見る）
    delete req.user
    delete req.authInfo
    if (token) headers.authorization = 'Bearer ' + token
    let out
    try {
      out = await runGuard(RED.auth.needsPermission(WRITE_PERMISSION), req)
    } catch (err) {
      out = { passed: false, error: err }
    } finally {
      if (token) {
        if (hadAuthorization) headers.authorization = authorization
        else delete headers.authorization
      }
    }

    const user = req.user
    // adminAuth.default の匿名はログインしていない（ログインすれば権限が増えるかもしれない）
    const person = !!user && !user.anonymous
    if (out.error) {
      log('warn', `ログインの確認に失敗しました（${(out.error && out.error.name) || 'Error'}）。Web UI からの変更を断ります`)
      return refuse('login', false)
    }
    if (out.passed) {
      if (user) return { required: true, loggedIn: person, canWrite: true, denied: null }
      warnClosed()
      return refuse('login', false)
    }
    return person ? refuse('forbidden', true) : refuse('login', false)
  }

  return {
    check,
    warnIfClosed,
    /** 変更に認証が要るサーバーか（adminAuth があるか、エディタを別の方法で閉じた）。 */
    required: () => !!settingsNow().adminAuth || closedElsewhere(settingsNow()),
    /** ログインの手段が無いので、トークンを送っても変更できないサーバーか。 */
    closed: () => unusable() || closedElsewhere(settingsNow()),
    /** GET meta の auth。 */
    meta: () => authMeta(settingsNow(), editorRootOf(settingsNow())),
    /** GET session の返事。匿名でも切れたトークンでも読める（ログインの有無を画面に教えるだけ）。 */
    async session(req) {
      const r = await check(req)
      return { required: r.required, loggedIn: r.loggedIn, canWrite: r.canWrite }
    },
  }
}

module.exports = {
  createEditorAuth,
  authMeta,
  nodeRootOf,
  editorGuardedElsewhere,
  editorTokenOf,
  TOKEN_HEADER,
  WRITE_PERMISSION,
  LOGIN_REQUIRED_MESSAGE,
  FORBIDDEN_MESSAGE,
  NO_LOGIN_MESSAGE,
}
