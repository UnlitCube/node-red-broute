// 書き込みの操作（actions・設定の保存と戻し・診断）。app.js から分けた（DOM に触らないので
// test/ui/operations.test.mjs で試せる）。結果は reducer（store.js）へ dispatch し、知らせはトーストで出す。
//
// 失敗の出し方:
//   - 409 BUSY（取得・診断の電波の要求は 1 台 1 本）: 失敗ではなく「いまは受け付けられない」。
//     サーバーの message を注意（warn）のトーストで出す。診断の結果には積まない（実行していないので）。
//   - 403 READ_ONLY（settings.js の wsuhaBroute.readOnly）: サーバーの message を danger のトーストで出し、
//     操作と保存のボタンを無効にして理由を添える（state.readOnly）。
//   - そのほか（403 BAD_ORIGIN・415・503 など）: サーバーの日本語の message を danger のトーストで出す
//     （診断は結果に失敗として残す）。BAD_ORIGIN は別のオリジンからの要求の失敗なので、この画面の操作は止めない。
//   - 403 CONFIG_LOCKED（settings.js の wsuhaBroute.uiConfig: false）: 構成と認証情報の保存だけを止める（state.configLocked）。
//   - 401 LOGIN_REQUIRED・403 FORBIDDEN（Node-RED の認証。トークンが切れた・権限が足りない）: 操作と保存を全部止め、帯で案内する。
//
// 認証情報: 送った ID とパスワードは api に渡すだけで、dispatch・トースト・戻り値に入れない。
import { isReadOnlyError, isConfigLockedError, isLoginRequiredError, isForbiddenError } from './api.js'
import { S } from './strings.js'

/** 応答が Config の形（{rev, fields}）か。 */
function isConfig(r) {
  return !!r && typeof r === 'object' && typeof r.fields === 'object' && r.fields !== null
}

/** 409 BUSY（前の要求がまだ終わっていない）か。 */
export function isBusyError(err) {
  return !!err && err.status === 409 && err.code === 'BUSY'
}

/**
 * @param {{api: object, dispatch: (a: object) => void, toast: (tone: string, title: string, body?: string|null) => void, now?: () => number}} deps
 */
export function createOperations({ api, dispatch, toast, now = Date.now }) {
  let seq = 0

  /** サーバーが認証で断ったなら、画面の止めに映す。@returns {boolean} 認証で断られたか */
  function noteDenied(err) {
    const forbidden = isForbiddenError(err)
    if (!forbidden && !isLoginRequiredError(err)) return false
    dispatch({ type: 'auth/denied', loggedIn: forbidden })
    return true
  }

  /** @returns {boolean} BUSY だったか */
  function failed(err, title) {
    if (isBusyError(err)) {
      toast('warn', S.actions.busy, err.message)
      return true
    }
    if (isReadOnlyError(err)) dispatch({ type: 'readOnly', reason: err.message })
    noteDenied(err)
    toast('danger', title || S.actions.failed, err && err.message)
    return false
  }

  async function action(id, name, body) {
    try {
      const r = await api.action(id, name, body)
      if (r && r.adapter) dispatch({ type: 'detail/loaded', adapter: r.adapter })
      toast('ok', S.actions.done, r && r.message)
      return { ok: true }
    } catch (err) {
      const busy = failed(err)
      return busy ? { ok: false, busy: true, error: err } : { ok: false, error: err }
    }
  }

  async function saveSettings(id, patch, rev) {
    try {
      const settings = await api.putSettings(id, rev, patch)
      dispatch({ type: 'settings/loaded', id, settings })
      toast('ok', S.settings.saved)
      return { ok: true, settings }
    } catch (err) {
      // 412 は帯（ほかの人が先に変更）、422 は項目の横に出すので、トーストにしない
      if (err.status !== 412 && err.status !== 422) failed(err)
      return { ok: false, error: err }
    }
  }

  async function resetSettings(id, rev) {
    try {
      const settings = await api.resetSettings(id, rev)
      dispatch({ type: 'settings/loaded', id, settings })
      toast('ok', S.settings.resetDone)
      return { ok: true, settings }
    } catch (err) {
      if (err.status !== 412) failed(err)
      return { ok: false, error: err }
    }
  }

  /** 構成・認証情報の失敗。403 CONFIG_LOCKED は構成だけの止め、ほかは failed と同じ。 */
  function configFailed(err) {
    if (isConfigLockedError(err)) {
      dispatch({ type: 'configLocked', reason: err.message })
      toast('danger', S.actions.failed, err.message)
      return
    }
    failed(err)
  }

  // 412（帯）・422（項目の横）・409 PORT_IN_USE（ポートの横に message）は、画面が出すのでトーストにしない
  async function saveConfig(id, patch, rev) {
    try {
      const config = await api.putConfig(id, rev, patch)
      const loaded = isConfig(config)
      if (loaded) dispatch({ type: 'config/loaded', id, config })
      toast('ok', S.config.saved)
      return { ok: true, loaded }
    } catch (err) {
      if (!(err && (err.status === 412 || err.status === 422 || (err.status === 409 && err.code === 'PORT_IN_USE')))) configFailed(err)
      return { ok: false, error: err }
    }
  }

  async function resetConfig(id, rev) {
    try {
      const config = await api.resetConfig(id, rev)
      const loaded = isConfig(config)
      if (loaded) dispatch({ type: 'config/loaded', id, config })
      toast('ok', S.config.resetDone)
      return { ok: true, loaded }
    } catch (err) {
      if (!(err && (err.status === 412 || (err.status === 409 && err.code === 'PORT_IN_USE')))) configFailed(err)
      return { ok: false, error: err }
    }
  }

  /** @param {{routeBId: string, routeBPassword: string}} body 送るだけ（どこにも残さない） */
  async function saveCredentials(id, body) {
    try {
      const r = await api.putCredentials(id, body)
      const loaded = isConfig(r)
      if (loaded) dispatch({ type: 'config/loaded', id, config: r })
      toast('ok', S.config.credSaved)
      return { ok: true, loaded }
    } catch (err) {
      if (!(err && err.status === 422)) configFailed(err)
      return { ok: false, error: err }
    }
  }

  async function clearCredentials(id) {
    try {
      const r = await api.clearCredentials(id)
      const loaded = isConfig(r)
      if (loaded) dispatch({ type: 'config/loaded', id, config: r })
      toast('ok', S.config.credCleared)
      return { ok: true, loaded }
    } catch (err) {
      configFailed(err)
      return { ok: false, error: err }
    }
  }

  /**
   * アダプタの追加（POST adapters）。トーストと移り先は呼び手（追加の画面）が決める（201 と 202 で違う）。
   * 失敗は呼び手が帯（409・403・503・500）と項目の下（422）に出す。READ_ONLY は読み出しのみの止めにする。
   * CONFIG_LOCKED は uiAddAdapter: false でも返るので、構成の止め（configLocked）にはしない。
   * 認証情報は api に渡すだけで、dispatch・戻り値に入れない。
   */
  async function addAdapter(body) {
    try {
      const r = (await api.addAdapter(body)) || {}
      if (r.adapter && r.adapter.id) dispatch({ type: 'detail/loaded', adapter: r.adapter })
      return {
        ok: true,
        message: typeof r.message === 'string' ? r.message : null,
        adapter: r.adapter && r.adapter.id ? r.adapter : null,
        nodes: r.nodes && typeof r.nodes === 'object' ? r.nodes : null,
        started: r.started !== false,
        warnings: Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === 'string') : [],
      }
    } catch (err) {
      if (isReadOnlyError(err)) dispatch({ type: 'readOnly', reason: err.message })
      noteDenied(err)
      return { ok: false, error: err }
    }
  }

  async function diag(id, name, args) {
    const key = `d${now()}-${++seq}`
    try {
      const r = await api.diag(id, name, args)
      dispatch({ type: 'diag/add', id, entry: { key, name, args: args || null, at: (r && r.at) || now(), ok: true, result: (r && r.result) || null } })
      return { ok: true, key }
    } catch (err) {
      if (isBusyError(err)) {
        toast('warn', S.actions.busy, err.message)
        return { ok: false, busy: true, error: err }
      }
      if (isReadOnlyError(err)) {
        dispatch({ type: 'readOnly', reason: err.message })
        toast('danger', S.actions.failed, err.message)
      } else if (noteDenied(err)) toast('danger', S.actions.failed, err.message)
      dispatch({
        type: 'diag/add',
        id,
        entry: { key, name, args: args || null, at: now(), ok: false, error: { message: err.message, status: err.status } },
      })
      return { ok: false, key, error: err }
    }
  }

  return { action, saveSettings, resetSettings, saveConfig, resetConfig, saveCredentials, clearCredentials, addAdapter, diag }
}
