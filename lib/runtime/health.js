'use strict'

// ============================================================================
//  健康の判定（純関数）
// ============================================================================
//
//  画面の「計測中 / 接続中 / 異常 …」のピルと、一覧の並び順の元。
//  上から順に見て、最初に当てはまったものを返す。
//
//    enabled=false              → disabled 「無効」（理由と次の一手は、有効を外した所で分ける: enabledBy）
//    buildError（sequencer が無い）→ bad    「アダプタを初期化できませんでした」（接続先とポートを確かめる。「開始」を勧めない）
//    !portOpen && lastError.code が SERIALPORT_MISSING → bad 「serialport が入っていません」（挿し直しても直らないので USB と言わない）
//    !portOpen && running       → bad      lastError が権限不足なら「ポートを開く権限がありません」、
//                                          ほかのプログラムが使っているなら「ほかのプログラムがポートを使っています」
//                                          （どちらも挿し直しても直らない）。それ以外は「USB が切断されています」
//    overridden.stopped         → stopped  「外部の指示で停止中」
//    credentials.configured === false → idle 「認証情報がありません」（「開始」を勧めない）
//    !running                   → idle     「停止」
//    macMatches === false       → bad      「想定と違うアダプタです」
//    connected && stale         → stale    「値が届いていません（最終 n 分前）」
//    connectHint（!connected）  → busy（連続失敗 3 回以上なら bad）。認証が通らない・メーターが見つからないときの案内（sequencer が立てる）
//    consecutiveFailures >= 3   → bad      「接続に n 回続けて失敗しています」
//    !connected                 → busy     「接続中」
//    それ以外                   → ok       「計測中」
//
//  nextAction は作業の言葉にし、画面の新しいカードの名前（設定タブの「アダプタと接続」
//  「B ルートの認証 ID とパスワード」）を指す。EVENT の番号・SK コマンド・「構成」を使わない（番号は画面の「詳しい状態」へ）。

const { PORT_DENIED_RE, PORT_BUSY_RE } = require('./error-hints')

/** 再接続の段の名前（段階 0〜3。PANA・SKRESET を使わない）。 */
const LADDER_TEXT = ['認証だけ', '分かっているメーターへ', 'メーターを探すところから', 'アダプタの初期化から']

/** よく使う次の一手（画面のカードの名前と合わせる）。 */
const NEXT = {
  pollHeld: 'メーターがこの値を返していません。時間をおいて自動で聞き直します（設定は変えません）',
  enableRuntime: '設定タブの「アダプタと接続」の詳細設定で「有効」に印を付けて保存するか、フローの config で {enabled: true} を送ると動き出します',
  enableEditor: 'エディタで設定ノードの「有効」に印を付けてデプロイすると動き出します',
  checkPort: '設定タブの「アダプタと接続」か設定ノードで、接続先（Wi-SUN アダプタ / シミュレーター）とポートを確かめてください',
  credentials: '設定タブの「B ルートの認証 ID とパスワード」で入れてください（設定ノードか環境変数でも入れられます）',
  radio: '電波の送信時間の上限（1 時間に 360 秒）に達したため、制限が解けるのを待っています（自動で再開します）',
  key: 'メーターとの暗号の鍵の更新が終わるのを待っています（自動で再開します）',
  reauth: 'メーターとの認証のやり直しが終わるのを待っています（自動で再開します）',
  // 電波が悪いだけでも認証は通らない（正しい値を入れ直させると、開き直しでさらに止まる）ので、電波を先に勧める
  hintCredentials:
    '前はつながっていたなら、電波が弱いことが多いです（自動でやり直します。アダプタの置き場所を確かめてください）。' +
    '初めての接続なら、B ルートのパスワード（12 桁）と認証 ID を確かめてください',
  hintNoMeter: '認証 ID が正しいか、電力会社から B ルートの利用開始の連絡が届いているか、アダプタとメーターの距離を確かめてください',
  serialport: 'パレットからこのノードを入れ直すか、userDir で npm install serialport@12 を実行して、Node-RED を再起動してください',
  portDenied: 'ほかのプログラムが使っていないか、Linux なら Node-RED を動かすユーザーが dialout グループに入っているかを確かめてください',
  portBusy: 'そのプログラムを止めるか、別のポートを選んでください',
}

/** つながらないときの案内（connectHint）の理由の文。 */
function hintReason(h, now) {
  if (h.kind === 'credentials') {
    const since = typeof h.since === 'number' && isFinite(h.since) ? minutesAgo(h.since, now) : null
    return since === null ? 'メーターは見つかりましたが、認証が通りません' : `メーターは見つかりましたが、認証が ${since} 分通りません`
  }
  const rounds = Number(h.rounds) > 0 ? Math.floor(Number(h.rounds)) : 0
  return rounds > 0 ? `この認証 ID のメーターが見つかりません（${rounds} 回探しました）` : 'この認証 ID のメーターが見つかりません'
}

/** 一覧の並び（重い順）。小さいほど上。 */
const LEVEL_ORDER = { bad: 0, stale: 1, busy: 2, stopped: 3, idle: 4, ok: 5, disabled: 6 }

/** stale とみなす経過時間 [ms]。最後の値が「取得間隔 × 3 + 30 秒」より古い。 */
function staleAfterMs(pollIntervalSec) {
  const sec = Number(pollIntervalSec) > 0 ? Number(pollIntervalSec) : 30
  return (sec * 3 + 30) * 1000
}

function ladderText(n) {
  const i = Number(n)
  return i >= 0 && i < LADDER_TEXT.length ? LADDER_TEXT[i] : null
}

function minutesAgo(at, now) {
  return Math.max(1, Math.floor((now - at) / 60000))
}

/**
 * @param {object} d   AdapterDetail に近い形（enabled, portOpen, running, connected, stale, lastValueAt,
 *                     overridden, device.macMatches, consecutiveFailures, ladder, phase, phaseText,
 *                     radioBlocked, keyBlocked, lastError, credentials）と、
 *                     enabledBy（有効を画面かフローで変えていれば {source: 'runtime', by, label}。設定ノードの値なら null）・
 *                     buildError（sequencer を作れなかった理由 {message}。作れていれば null）・
 *                     connectHint（{kind: 'credentials'|'no-meter', since, rounds}|null）
 * @param {number} now 現在時刻 [ms]
 * @returns {{level: string, title: string, reasons: string[], nextAction: string|null}}
 */
function health(d, now) {
  const t = typeof now === 'number' ? now : Date.now()
  const x = d || {}
  const reasons = []
  const lastErr = x.lastError && x.lastError.message ? String(x.lastError.message) : null
  const macMatches = x.device && x.device.macMatches !== undefined ? x.device.macMatches : x.macMatches

  if (x.enabled === false) {
    // 画面かフローで外した台は、エディタの「有効」を変えずにデプロイしても戻らない（画面かフローの値が効いたまま。後勝ち）
    const eb = x.enabledBy && x.enabledBy.source === 'runtime' ? x.enabledBy : null
    if (eb) {
      return {
        level: 'disabled',
        title: '無効',
        reasons: [`${eb.label ? String(eb.label) : '画面かフロー'}で無効にしています。ポートは開きません`],
        nextAction: NEXT.enableRuntime,
      }
    }
    return {
      level: 'disabled',
      title: '無効',
      reasons: ['設定ノードで無効にしています。ポートは開きません'],
      nextAction: NEXT.enableEditor,
    }
  }

  // sequencer を作れなかった（今は「接続先がシリアルでポートが空」だけ）。「開始」を押しても 503 になるだけなので、
  // 次の一手は構成の確かめにする
  if (x.buildError && !x.running) {
    if (x.buildError.message) reasons.push(String(x.buildError.message))
    return {
      level: 'bad',
      title: 'アダプタを初期化できませんでした',
      reasons,
      nextAction: NEXT.checkPort,
    }
  }

  // serialport を読み込めない: 利用者が USB やケーブルを疑わないように、切断より先に見る
  if (!x.portOpen && x.lastError && x.lastError.code === 'SERIALPORT_MISSING') {
    if (x.port) reasons.push(`ポート ${x.port} を開けません`)
    return { level: 'bad', title: 'serialport が入っていません', reasons, nextAction: NEXT.serialport }
  }

  if (!x.portOpen && x.running) {
    if (x.port) reasons.push(`ポート ${x.port} が開いていません`)
    if (lastErr) reasons.push(lastErr)
    if (lastErr && PORT_DENIED_RE.test(lastErr)) return { level: 'bad', title: 'ポートを開く権限がありません', reasons, nextAction: NEXT.portDenied }
    if (lastErr && PORT_BUSY_RE.test(lastErr)) return { level: 'bad', title: 'ほかのプログラムがポートを使っています', reasons, nextAction: NEXT.portBusy }
    return {
      level: 'bad',
      title: 'USB が切断されています',
      reasons,
      nextAction: 'USB の接続を確かめてください。挿し直すと自動で再開します',
    }
  }

  const stopped = x.overridden && x.overridden.stopped
  if (stopped) {
    if (stopped.reason) reasons.push(String(stopped.reason))
    return {
      level: 'stopped',
      title: '外部の指示で停止中',
      reasons,
      nextAction: '「開始」か「自動運転に戻す」で再開します。Node-RED を再起動しても自動運転に戻ります',
    }
  }

  // 認証情報が無い（未設定か書式が違う）。「開始」を押しても 503 になるだけなので、次の一手は設定にする。
  // configured が分からない（null・項目なし = sequencer が無い）ときは決めつけない
  if (x.credentials && x.credentials.configured === false) {
    reasons.push('B ルートの認証 ID とパスワードが未設定か、書式が違います')
    return {
      level: 'idle',
      title: '認証情報がありません',
      reasons,
      nextAction: NEXT.credentials,
    }
  }

  if (!x.running) {
    if (x.phase === 'need-secrets') {
      reasons.push('B ルートの認証 ID とパスワードが未設定か、書式が違います')
      return { level: 'idle', title: '停止', reasons, nextAction: NEXT.credentials }
    }
    if (x.phaseText) reasons.push(String(x.phaseText))
    return { level: 'idle', title: '停止', reasons, nextAction: '「開始」で自動運転を始めます' }
  }

  if (macMatches === false) {
    const exp = x.device && x.device.expectedMac
    const mac = x.device && x.device.mac
    if (exp || mac) reasons.push(`想定 ${exp || '不明'} / 実際 ${mac || '不明'}`)
    return {
      level: 'bad',
      title: '想定と違うアダプタです',
      reasons,
      nextAction: '設定タブの「アダプタと接続」でポートと想定 MAC を確かめてください（USB の番号は抜き差しで入れ替わります）',
    }
  }

  const fails = Number(x.consecutiveFailures) || 0

  // 連続失敗が続く台は、値が古いことより失敗を先に知らせる（下の bad の枝。alert と同じ判断）。
  // ただし、つながっていてメーターが値を断っているだけのときは、やり直しは起きないので控えの案内を先に出す
  if (x.connected && x.stale && (fails < 3 || x.pollHeld)) {
    // 何が届いていないかを名前で書く（瞬時電流や積算は届いていることがあるので、「値」とだけ書くと全部止まったと読める）
    const what = typeof x.mainLabel === 'string' && x.mainLabel ? x.mainLabel : '値'
    const title =
      typeof x.lastValueAt === 'number'
        ? `${what}が届いていません（最終 ${minutesAgo(x.lastValueAt, t)} 分前）`
        : `接続してから、まだ${what}が届いていません`
    if (x.radioBlocked) reasons.push('電波の送信時間の上限に達しています（送信制限）')
    return {
      level: 'stale',
      title,
      reasons,
      nextAction: x.radioBlocked
        ? NEXT.radio
        : x.pollHeld
          ? NEXT.pollHeld
          : '応答が 3 回続けて無ければ自動で再接続します。急ぐときは「再接続」を押してください',
    }
  }

  // つながらないときの案内: 認証情報の誤りやメーターが見つからないとき、「接続中」と段の文だけを出し続けない
  const hint = !x.connected && x.connectHint && (x.connectHint.kind === 'credentials' || x.connectHint.kind === 'no-meter') ? x.connectHint : null
  if (hint) {
    reasons.push(hintReason(hint, t))
    return {
      level: fails >= 3 ? 'bad' : 'busy',
      title: fails >= 3 ? `接続に ${fails} 回続けて失敗しています` : '接続中',
      reasons,
      nextAction: hint.kind === 'credentials' ? NEXT.hintCredentials : NEXT.hintNoMeter,
    }
  }
  if (fails >= 3) {
    if (lastErr) reasons.push(lastErr)
    const lt = ladderText(x.ladder)
    // つながっている台はやり直しを待っていない（主な値が届けば 0 に戻る）ので、段の案内を出さない
    const next = x.connected
      ? x.pollHeld
        ? NEXT.pollHeld
        : 'つながっています。定期的に取りに行く値が届けば、連続失敗は 0 に戻ります'
      : lt
        ? `段 ${x.ladder}（${lt}）でやり直します`
        : '自動でやり直します'
    return {
      level: 'bad',
      title: `接続に ${fails} 回続けて失敗しています`,
      reasons,
      nextAction: next,
    }
  }

  if (!x.connected) {
    if (x.phaseText) reasons.push(String(x.phaseText))
    let nextAction = null
    if (x.radioBlocked) nextAction = NEXT.radio
    else if (x.keyBlocked) nextAction = NEXT.key
    else if (x.phase === 'reauth') nextAction = NEXT.reauth
    else if (fails > 0 && ladderText(x.ladder)) nextAction = `段 ${x.ladder}（${ladderText(x.ladder)}）でやり直します`
    return { level: 'busy', title: '接続中', reasons, nextAction }
  }

  return { level: 'ok', title: '計測中', reasons, nextAction: null }
}

function levelOrder(level) {
  return LEVEL_ORDER[level] === undefined ? 99 : LEVEL_ORDER[level]
}

module.exports = { health, staleAfterMs, levelOrder, ladderText, LEVEL_ORDER, LADDER_TEXT, NEXT }
