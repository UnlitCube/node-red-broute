// ui/operations.js（書き込みの操作: actions・設定の保存・診断）。偽の api と reducer の箱で試す。
//
// 戻すと落ちるもの:
//   - 409 BUSY の見分けを外す → 「今すぐ取得」は「操作できませんでした」（danger）、診断は失敗の結果が 1 件積まれる
//   - 読み出しのみの見分けを前の FORBIDDEN に戻す → 403 READ_ONLY でボタンが押せるまま
//   - BAD_ORIGIN も読み出しのみにする → 別のオリジンの 1 回の失敗で、この画面の操作が全部止まる
//   - 401 LOGIN_REQUIRED・403 FORBIDDEN を止めに映さない → トークンが切れたあともボタンが押せるまま
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOperations, isBusyError } from '../../ui/operations.js'
import { ApiError } from '../../ui/api.js'
import { reducer, initialState, writeBlockReason } from '../../ui/store.js'
import { S } from '../../ui/strings.js'

function box() {
  const b = { state: initialState, actions: [], toasts: [] }
  b.dispatch = (a) => {
    b.actions.push(a)
    b.state = reducer(b.state, a)
  }
  b.toast = (tone, title, body) => b.toasts.push({ tone, title, body: body || null })
  return b
}

const busy = (message) => new ApiError({ status: 409, code: 'BUSY', message })
const loginErr = () => new ApiError({ status: 401, code: 'LOGIN_REQUIRED', message: S.auth.loginRequired })
const forbiddenErr = () => new ApiError({ status: 403, code: 'FORBIDDEN', message: S.auth.forbidden })

/** どの書き込みも err で断る偽の api。 */
function deniedApi(err) {
  const reject = async () => {
    throw err
  }
  return { action: reject, putSettings: reject, resetSettings: reject, putConfig: reject, resetConfig: reject, putCredentials: reject, clearCredentials: reject, addAdapter: reject, diag: reject }
}

test('変更が 401 LOGIN_REQUIRED: 全部の操作で、止めに映して同じ案内を出す', async () => {
  const calls = {
    action: (o) => o.action('n1', 'poll'),
    saveSettings: (o) => o.saveSettings('n1', {}, 'r'),
    resetSettings: (o) => o.resetSettings('n1', 'r'),
    saveConfig: (o) => o.saveConfig('n1', {}, 'r'),
    resetConfig: (o) => o.resetConfig('n1', 'r'),
    saveCredentials: (o) => o.saveCredentials('n1', {}),
    clearCredentials: (o) => o.clearCredentials('n1'),
    addAdapter: (o) => o.addAdapter({}),
    diag: (o) => o.diag('n1', 'info'),
  }
  for (const [name, run] of Object.entries(calls)) {
    const b = box()
    const ops = createOperations({ api: deniedApi(loginErr()), dispatch: b.dispatch, toast: b.toast })
    const r = await run(ops)
    assert.equal(r.ok, false, name)
    assert.equal(b.state.auth.canWrite, false, name)
    assert.equal(b.state.auth.required, true, name)
    assert.equal(writeBlockReason(b.state, S), S.auth.loginRequired, name)
    assert.equal(b.state.readOnly, null, name + ': 読み出しのみにしない')
    // 追加はモーダルの帯に出すので、トーストを重ねない
    if (name !== 'addAdapter') assert.deepEqual(b.toasts, [{ tone: 'danger', title: S.actions.failed, body: S.auth.loginRequired }], name)
  }
})

test('変更が 403 FORBIDDEN: 権限が足りないと分かるように止める', async () => {
  const b = box()
  const ops = createOperations({ api: deniedApi(forbiddenErr()), dispatch: b.dispatch, toast: b.toast })
  await ops.action('n1', 'poll')
  assert.equal(b.state.auth.loggedIn, true)
  assert.equal(writeBlockReason(b.state, S), S.auth.forbidden)
})

test('ほかの 401・403 は止めに映さない（Basic 認証の 401・BAD_ORIGIN・FORBIDDEN_COMMAND）', async () => {
  for (const err of [
    new ApiError({ status: 401, code: 'HTTP_401', message: 'x' }),
    new ApiError({ status: 403, code: 'BAD_ORIGIN', message: 'x' }),
    new ApiError({ status: 403, code: 'FORBIDDEN_COMMAND', message: 'x' }),
  ]) {
    const b = box()
    const ops = createOperations({ api: deniedApi(err), dispatch: b.dispatch, toast: b.toast })
    await ops.action('n1', 'poll')
    assert.equal(b.state.auth.required, false, err.code)
    assert.equal(writeBlockReason(b.state, S), null, err.code)
  }
})

test('isBusyError: 409 BUSY だけ（ほかの 409 は違う）', () => {
  assert.equal(isBusyError(busy('x')), true)
  assert.equal(isBusyError(new ApiError({ status: 409, code: 'STOPPED_BY_OVERRIDE', message: 'x' })), false)
  assert.equal(isBusyError(new ApiError({ status: 503, code: 'BUSY', message: 'x' })), false)
  assert.equal(isBusyError(null), false)
})

// poll は ECHONET の要求が送信中・待ち行列にあれば 409 BUSY。サーバーの message をそのまま出す。
test('「今すぐ取得」が 409 BUSY: サーバーの message を注意のトーストで出し、失敗（danger）にしない', async () => {
  const b = box()
  const message = 'いま取得の途中です。終わってからもう一度押してください'
  const api = {
    action: async () => {
      throw busy(message)
    },
  }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  const r = await ops.action('n1', 'poll')
  assert.equal(r.ok, false)
  assert.equal(r.busy, true)
  assert.deepEqual(b.toasts, [{ tone: 'warn', title: S.actions.busy, body: message }])
  assert.equal(b.state.readOnly, null)
})

// 失敗はサーバーの日本語の message をトーストに出す（409 BUSY・415・403 BAD_ORIGIN / READ_ONLY を含む）。
test('ほかの失敗は danger のトーストにサーバーの message。403 READ_ONLY だけ読み出しのみにする（BAD_ORIGIN・415 はしない）', async () => {
  const b = box()
  const errs = {
    poll: new ApiError({ status: 503, code: 'NOT_CONNECTED', message: 'メーターに接続していません' }),
    auto: new ApiError({ status: 403, code: 'BAD_ORIGIN', message: '別のサイトからの操作は受け付けません' }),
    terminate: new ApiError({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type: application/json で送ってください' }),
    stop: new ApiError({ status: 403, code: 'READ_ONLY', message: 'このサーバーでは画面からの操作を止めています（settings.js の wsuhaBroute.readOnly）' }),
  }
  const api = {
    action: async (id, action) => {
      throw errs[action]
    },
  }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  await ops.action('n1', 'poll')
  await ops.action('n1', 'auto')
  await ops.action('n1', 'terminate')
  assert.equal(b.state.readOnly, null, 'BAD_ORIGIN と 415 では読み出しのみにしない')
  await ops.action('n1', 'stop', { reason: '点検' })
  assert.deepEqual(
    b.toasts.map((t) => [t.tone, t.title, t.body]),
    ['poll', 'auto', 'terminate', 'stop'].map((k) => ['danger', S.actions.failed, errs[k].message]),
  )
  assert.equal(b.state.readOnly, errs.stop.message)
})

test('診断・設定の保存も、403 READ_ONLY なら読み出しのみにする', async () => {
  const ro = () => new ApiError({ status: 403, code: 'READ_ONLY', message: '止めています' })
  for (const run of [(ops) => ops.diag('n1', 'info'), (ops) => ops.saveSettings('n1', { pollIntervalSec: 30 }, 'r1'), (ops) => ops.resetSettings('n1', 'r1')]) {
    const b = box()
    const api = {
      diag: async () => {
        throw ro()
      },
      putSettings: async () => {
        throw ro()
      },
      resetSettings: async () => {
        throw ro()
      },
    }
    await run(createOperations({ api, dispatch: b.dispatch, toast: b.toast }))
    assert.equal(b.state.readOnly, '止めています')
  }
})

test('成功は ok のトーストと、応答の adapter を詳細に入れる', async () => {
  const b = box()
  const api = { action: async () => ({ ok: true, message: '取得を始めました', adapter: { id: 'n1', name: 'x' } }) }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  assert.deepEqual(await ops.action('n1', 'poll'), { ok: true })
  assert.deepEqual(b.toasts, [{ tone: 'ok', title: S.actions.done, body: '取得を始めました' }])
  assert.equal(b.state.details.n1.data.name, 'x')
})

// API からの電波の取得（diag の epc / propmap）は 1 台 1 本。重なったら 409 BUSY。
test('診断（epc・propmap）が 409 BUSY: トーストで知らせ、結果には積まない', async () => {
  const b = box()
  const message = 'Web UI からの前の取得がまだ終わっていません。終わってからもう一度試してください'
  const api = {
    diag: async () => {
      throw busy(message)
    },
  }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  for (const name of ['epc', 'propmap']) {
    const r = await ops.diag('n1', name, name === 'epc' ? { epcs: ['E7'] } : undefined)
    assert.equal(r.ok, false)
    assert.equal(r.busy, true)
  }
  assert.deepEqual(b.toasts, [
    { tone: 'warn', title: S.actions.busy, body: message },
    { tone: 'warn', title: S.actions.busy, body: message },
  ])
  assert.equal(b.state.diag.n1, undefined, '結果は積まない')
})

test('診断のほかの失敗（502 DEVICE_ERROR など）は、結果に失敗として残す。成功は結果に足す', async () => {
  const b = box()
  let n = 0
  const api = {
    diag: async () => {
      if (++n === 1) throw new ApiError({ status: 502, code: 'DEVICE_ERROR', message: 'FAIL ER06' })
      return { ok: true, name: 'info', at: 1234, result: { lines: ['EVER 1.2.10'] } }
    },
  }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  await ops.diag('n1', 'sreg', { reg: 'SFD' })
  await ops.diag('n1', 'info')
  const list = b.state.diag.n1
  assert.equal(list.length, 2)
  assert.deepEqual([list[0].name, list[0].ok, list[0].at], ['info', true, 1234])
  assert.deepEqual([list[1].name, list[1].ok, list[1].error.message, list[1].error.status], ['sreg', false, 'FAIL ER06', 502])
  assert.notEqual(list[0].key, list[1].key)
  assert.deepEqual(b.toasts, [])
})

test('設定の保存: 412 と 422 はトーストを出さず呼び手に返す（画面が帯と項目の横に出す）', async () => {
  const b = box()
  const api = {
    putSettings: async (id, rev) => {
      if (rev === 'old') throw new ApiError({ status: 412, code: 'REVISION_MISMATCH', message: 'ほかの人が先に変更しました' })
      if (rev === 'bad') throw new ApiError({ status: 422, code: 'VALIDATION', message: '入力', details: { pollIntervalSec: '15 以上' } })
      return { rev: 'r2', fields: {}, warnings: [] }
    },
  }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  assert.equal((await ops.saveSettings('n1', { pollIntervalSec: 30 }, 'old')).error.status, 412)
  assert.equal((await ops.saveSettings('n1', { pollIntervalSec: 1 }, 'bad')).error.status, 422)
  assert.deepEqual(b.toasts, [])
  const ok = await ops.saveSettings('n1', { pollIntervalSec: 30 }, 'r1')
  assert.equal(ok.ok, true)
  assert.equal(b.state.settings.n1.data.rev, 'r2')
  assert.deepEqual(b.toasts, [{ tone: 'ok', title: S.settings.saved, body: null }])
})

// 戻すと落ちるもの: addAdapter が本文を dispatch や戻り値に含める
test('追加: 認証 ID とパスワードは api に渡すだけで、store・トースト・戻り値に入れない', async () => {
  const ID = '0123456789ABCDEF0123456789ABCDEF'
  const PW = 'ABCDEF123456'
  const sent = []
  const b = box()
  const api = { addAdapter: async (body) => (sent.push(body), { ok: true, adapter: { id: 'd1' }, nodes: { deviceId: 'd1', brouteId: 'b1' }, started: true, warnings: [] }) }
  const ops = createOperations({ api, dispatch: b.dispatch, toast: b.toast })
  const r = await ops.addAdapter({ role: '電力', mode: 'simulator', routeBId: ID, routeBPassword: PW })
  assert.equal(sent[0].routeBId, ID, 'api には渡す')
  const seen = JSON.stringify([b.actions, b.toasts, b.state, r])
  assert.equal(seen.includes(ID), false)
  assert.equal(seen.includes(PW), false)

  const failed = createOperations({ api: { addAdapter: async () => Promise.reject(new ApiError({ status: 409, code: 'PAIR_IN_USE', message: 'ほかの台が使っています' })) }, dispatch: b.dispatch, toast: b.toast })
  const f = await failed.addAdapter({ role: '電力', mode: 'simulator', routeBId: ID, routeBPassword: PW })
  assert.equal(f.ok, false)
  assert.equal(JSON.stringify([b.actions, b.toasts, b.state, f.ok]).includes(ID), false)
})
