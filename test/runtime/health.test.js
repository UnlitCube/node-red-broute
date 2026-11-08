'use strict'

// 健康の判定（lib/runtime/health.js）の表と順序。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { health, staleAfterMs, levelOrder } = require('../../lib/runtime/health')
const { Sequencer } = require('../../lib/sequencer')
const { createRegistry } = require('../../lib/runtime/registry')
const vm = require('../../lib/runtime/view-model')
const { waitFor, ID, PW } = require('./fake-red')

const NOW = 1_800_000_000_000
const OK = {
  enabled: true,
  portOpen: true,
  running: true,
  connected: true,
  stale: false,
  lastValueAt: NOW - 5000,
  overridden: { stopped: null, any: false },
  device: { macMatches: true },
  consecutiveFailures: 0,
  ladder: 0,
  phase: 'connected',
  phaseText: '接続済み',
}

function h(over) {
  return health(Object.assign({}, OK, over), NOW)
}

/** 開けないポート。ほかは本物の sequencer・registry・view-model を通す（文の形は lastError まで本物の道で届くものを見る）。 */
class UnopenablePort extends EventEmitter {
  constructor(message) {
    super()
    this.message = message
    this.isOpen = false
  }
  open() {
    return Promise.reject(new Error(this.message))
  }
  close() {
    return Promise.resolve()
  }
  write() {
    return Promise.reject(new Error('Port is not open'))
  }
}

/** ポートを開けなかった台の AdapterDetail。 */
async function detailWhenPortFails(message) {
  const h1 = createRegistry().upsert('n1')
  h1.claim({}, { meta: { name: 'x', role: '電力', deviceKey: '', enabled: true, mode: 'serial', port: '/dev/ttyUSB0', portLabel: 'USB0' }, credentialState: { configured: true, envOverrides: false } })
  const seq = new Sequencer(new UnopenablePort(message), { label: 't' })
  seq.on('error', () => {})
  seq.setCredentials(ID, PW, 'test')
  h1.attach(seq)
  seq.start()
  try {
    await waitFor(() => seq.snapshot().lastError, 3000, 'ポートの失敗')
    return vm.buildDetail(h1.inspect(), Date.now())
  } finally {
    await seq.destroy().catch(() => {})
  }
}

test('ポートを開けない理由が権限やほかのプログラムなら、USB の切断と言わない（挿し直しても直らない）', async () => {
  // 一覧には health しか出ないので、利用者が USB を疑い続ける。同じ画面の hint とも矛盾していた。
  // 戻すと落ちるもの: health.js の !portOpen && running で lastError の文を見ない・EBUSY の文の大文字小文字を分ける
  for (const [message, title, next, hint] of [
    ['Error: Permission denied, cannot open /dev/ttyUSB0', 'ポートを開く権限がありません', /dialout グループ/, /権限がありません/],
    ['Error: Opening COM3: Access denied', 'ポートを開く権限がありません', /dialout グループ/, /権限がありません/],
    ['Error Resource temporarily unavailable Cannot lock port', 'ほかのプログラムがポートを使っています', /別のポートを選んで/, /ほかのプログラム/],
    ['Error: Device or resource busy, cannot open /dev/ttyUSB0', 'ほかのプログラムがポートを使っています', /別のポートを選んで/, /ほかのプログラム/],
  ]) {
    const d = await detailWhenPortFails(message)
    assert.equal(d.health.level, 'bad', message)
    assert.equal(d.health.title, title, message)
    assert.match(d.health.nextAction, next, message)
    assert.ok(!/USB|挿し直/.test(d.health.title + d.health.nextAction), `${message}: ${d.health.nextAction}`)
    assert.ok(d.health.reasons.includes(message), 'どの文で判定したかを残す')
    assert.match(d.lastError.hint, hint, '見出しと hint が同じことを言う')
  }
})

test('ポートが無いときは、今までどおり USB の切断と言う', async () => {
  // 戻すと落ちるもの: health.js の判定を広げて、ENOENT まで権限か使用中にする
  const d = await detailWhenPortFails('Error: No such file or directory, cannot open /dev/ttyUSB0')
  assert.equal(d.health.title, 'USB が切断されています')
  assert.match(d.health.nextAction, /挿し直すと自動で再開します/)
})

test('判定の表', () => {
  const rows = [
    [{}, 'ok', '計測中'],
    [{ enabled: false, portOpen: false }, 'disabled', '無効'],
    [{ portOpen: false }, 'bad', 'USB が切断されています'],
    [{ overridden: { stopped: { reason: '点検中', at: NOW } }, running: false }, 'stopped', '外部の指示で停止中'],
    [{ running: false }, 'idle', '停止'],
    [{ device: { macMatches: false, expectedMac: 'A', mac: 'B' } }, 'bad', '想定と違うアダプタです'],
    [{ stale: true, lastValueAt: NOW - 5 * 60000 }, 'stale', '値が届いていません（最終 5 分前）'],
    [{ connected: false, consecutiveFailures: 3, ladder: 2, phase: 'scanning' }, 'bad', '接続に 3 回続けて失敗しています'],
    [{ connected: false, phase: 'scanning', phaseText: 'スキャン中' }, 'busy', '接続中'],
  ]
  for (const [over, level, title] of rows) {
    const r = h(over)
    assert.equal(r.level, level, JSON.stringify(over))
    assert.equal(r.title, title, JSON.stringify(over))
    assert.ok(Array.isArray(r.reasons))
    assert.ok(r.nextAction === null || typeof r.nextAction === 'string')
  }
})

test('判定の順序（上から最初に当てはまったもの）', () => {
  // 無効は何よりも先
  assert.equal(h({ enabled: false, portOpen: false, running: true, consecutiveFailures: 9 }).level, 'disabled')
  // USB 切断は停止の上書きより先（running のとき）
  assert.equal(h({ portOpen: false, overridden: { stopped: { reason: 'x' } } }).level, 'bad')
  // 走っていなければ USB 切断にはしない
  assert.equal(h({ portOpen: false, running: false }).level, 'idle')
  // 停止の上書きは個体の不一致より先
  assert.equal(h({ running: false, overridden: { stopped: { reason: 'x' } }, device: { macMatches: false } }).level, 'stopped')
  // 個体の不一致は stale より先
  assert.equal(h({ device: { macMatches: false }, stale: true }).level, 'bad')
  // stale は繋がっているときだけ
  assert.equal(h({ connected: false, stale: true, phase: 'scanning' }).level, 'busy')
  // 連続失敗は「接続中」より先
  assert.equal(h({ connected: false, consecutiveFailures: 2 }).level, 'busy')
  assert.equal(h({ connected: false, consecutiveFailures: 3 }).level, 'bad')
})

test('理由と次の一手', () => {
  const stopped = h({ running: false, overridden: { stopped: { reason: '点検のため', at: NOW } } })
  assert.deepEqual(stopped.reasons, ['点検のため'])
  const busy = h({ connected: false, phase: 'scanning', phaseText: 'スキャン中' })
  assert.equal(busy.reasons[0], 'スキャン中', 'phaseText を添える')
  assert.match(h({ connected: false, radioBlocked: true }).nextAction, /送信時間の上限/)
  assert.match(h({ connected: false, consecutiveFailures: 4, ladder: 2 }).nextAction, /段 2（メーターを探すところから）/)
  assert.match(h({ running: false, phase: "need-secrets" }).nextAction, /認証 ID とパスワード/)
  assert.equal(h({}).nextAction, null)
})

test('認証情報が無い（credentials.configured === false）: idle「認証情報がありません」で、「開始」を勧めない', () => {
  // 「開始」を押しても 503 になるだけなので、次の一手は認証情報の設定にする。
  // 戻すと落ちるもの: health.js の credentials の判定を外す（「停止」「「開始」で自動運転を始めます」に戻る）
  const NEXT = '設定タブの「B ルートの認証 ID とパスワード」で入れてください（設定ノードか環境変数でも入れられます）'
  for (const over of [
    { running: false, credentials: { configured: false } },
    { running: false, phase: 'need-secrets', phaseText: '認証情報の待ち', credentials: { configured: false } },
    { running: false, connected: false, portOpen: true, credentials: { configured: false } },
  ]) {
    const r = h(over)
    assert.equal(r.level, 'idle', JSON.stringify(over))
    assert.equal(r.title, '認証情報がありません', JSON.stringify(over))
    assert.equal(r.nextAction, NEXT, JSON.stringify(over))
    assert.ok(!/開始/.test(r.nextAction))
  }
  // 順序: 無効・USB 切断・外部の停止が先
  assert.equal(h({ enabled: false, credentials: { configured: false } }).level, 'disabled')
  assert.equal(h({ portOpen: false, running: true, credentials: { configured: false } }).level, 'bad')
  assert.equal(h({ running: false, overridden: { stopped: { reason: 'x' } }, credentials: { configured: false } }).level, 'stopped')
  // 分からない（null・項目なし）ときは今までどおり
  assert.equal(h({ running: false, credentials: { configured: null } }).title, '停止')
  assert.equal(h({ running: false }).title, '停止')
  assert.equal(h({ credentials: { configured: true } }).level, 'ok')
})

test('無効の理由と次の一手は、有効を外した所で分ける（画面・フローで外したら、エディタのデプロイでは戻らない）', () => {
  // enabled は画面とフローからも変えられる。エディタの値は true のままなので、
  // 「エディタで印を付けてデプロイ」の案内どおりにしても戻らない。
  // 戻すと落ちるもの: health.js で enabledBy を見ない（いつも「設定ノードで無効にしています」）
  const ed = h({ enabled: false })
  assert.deepEqual(ed.reasons, ['設定ノードで無効にしています。ポートは開きません'])
  assert.match(ed.nextAction, /エディタで設定ノードの「有効」に印を付けてデプロイ/)
  const ui = h({ enabled: false, enabledBy: { source: 'runtime', by: 'web-ui', label: '画面' } })
  assert.equal(ui.level, 'disabled')
  assert.equal(ui.title, '無効')
  assert.deepEqual(ui.reasons, ['画面で無効にしています。ポートは開きません'])
  assert.ok(!/エディタ/.test(ui.nextAction), ui.nextAction)
  assert.match(ui.nextAction, /「アダプタと接続」の詳細設定で「有効」/)
  assert.match(ui.nextAction, /\{enabled: true\}/)
  const fl = h({ enabled: false, enabledBy: { source: 'runtime', by: 'flow:スイッチ', label: 'フロー（スイッチ）' } })
  assert.deepEqual(fl.reasons, ['フロー（スイッチ）で無効にしています。ポートは開きません'])
  // 出どころの名前が無ければ「画面かフロー」
  assert.deepEqual(h({ enabled: false, enabledBy: { source: 'runtime' } }).reasons, ['画面かフローで無効にしています。ポートは開きません'])
})

test('アダプタを初期化できなかった（buildError）: bad「アダプタを初期化できませんでした」。「開始」を勧めない', () => {
  // 接続先がシリアルでポートが空の設定ノード（エディタでデプロイしたもの）は sequencer が作れない。
  // 前は idle「停止」・「「開始」で自動運転を始めます」を出し、開始は 503 PORT_DOWN になった。
  // 戻すと落ちるもの: health.js の buildError の判定を外す
  const r = h({ running: false, portOpen: false, connected: false, phase: 'error', phaseText: 'アダプタを初期化できませんでした', buildError: { message: 'シリアルポートのパスが指定されていません' } })
  assert.equal(r.level, 'bad')
  assert.equal(r.title, 'アダプタを初期化できませんでした')
  assert.deepEqual(r.reasons, ['シリアルポートのパスが指定されていません'])
  assert.ok(!/開始/.test(r.nextAction), r.nextAction)
  assert.match(r.nextAction, /接続先.*ポート/)
  // 無効は先（無効なら作らないので buildError は出ないが、順序として）
  assert.equal(h({ enabled: false, running: false, buildError: { message: 'x' } }).level, 'disabled')
  // buildError が無ければ今までどおり
  assert.equal(h({ running: false, buildError: null }).title, '停止')
})

test('つながらないときの案内（connectHint）: 2 種の理由と次の一手。作業の言葉で、内部の語を出さない', () => {
  // 戻すと落ちるもの: health.js の hint の分岐を外す・hintCredentials を認証情報だけの文に戻す
  const cred = h({ connected: false, phase: 'joining', connectHint: { kind: 'credentials', since: NOW - 7 * 60000, rounds: 3 } })
  assert.equal(cred.level, 'busy')
  assert.equal(cred.title, '接続中')
  assert.deepEqual(cred.reasons, ['メーターは見つかりましたが、認証が 7 分通りません'])
  assert.match(cred.nextAction, /電波が弱い/, '電波が悪いだけでも認証は通らないので、電波を先に言う')
  assert.match(cred.nextAction, /パスワード（12 桁）と認証 ID/)
  assert.ok(cred.nextAction.indexOf('電波') < cred.nextAction.indexOf('パスワード'), cred.nextAction)
  const none = h({ connected: false, phase: 'scanning', connectHint: { kind: 'no-meter', since: NOW, rounds: 2 } })
  assert.deepEqual(none.reasons, ['この認証 ID のメーターが見つかりません（2 回探しました）'])
  assert.match(none.nextAction, /認証 ID が正しいか/)
  assert.deepEqual(h({ connected: false, connectHint: { kind: 'no-meter', since: NOW, rounds: 0 } }).reasons, ['この認証 ID のメーターが見つかりません'])
  // 3 回続けて失敗していれば bad。案内の文はそのまま
  const bad = h({ connected: false, consecutiveFailures: 3, connectHint: { kind: 'credentials', since: NOW - 60000, rounds: 1 } })
  assert.equal(bad.level, 'bad')
  assert.equal(bad.title, '接続に 3 回続けて失敗しています')
  assert.match(bad.nextAction, /電波が弱い/)
  for (const r of [cred, none, bad]) assert.ok(!/EVENT|構成|PANA|SK[A-Z]/.test(r.nextAction + r.reasons.join('')), r.nextAction)
  // つながっていれば見ない。知らない種類も見ない
  assert.equal(h({ connectHint: { kind: 'credentials', since: NOW } }).level, 'ok')
  assert.equal(h({ connected: false, connectHint: { kind: 'x' } }).nextAction, null)
})

test('serialport を読み込めない: USB の切断と言わず、入れ直す手順を出す（code で分ける）', () => {
  // 既定の導入で最初に当たる。挿し直しても直らないのに「USB の接続を確かめてください」と出ていた。
  // 戻すと落ちるもの: health.js の SERIALPORT_MISSING の分岐を外す
  const miss = { message: 'serialport を読み込めません。パレットから', code: 'SERIALPORT_MISSING' }
  const r = h({ portOpen: false, port: '/dev/ttyUSB0', lastError: miss })
  assert.equal(r.level, 'bad')
  assert.equal(r.title, 'serialport が入っていません')
  assert.deepEqual(r.reasons, ['ポート /dev/ttyUSB0 を開けません'])
  assert.match(r.nextAction, /パレットからこのノードを入れ直す/)
  assert.match(r.nextAction, /npm install serialport@12/)
  assert.match(r.nextAction, /Node-RED を再起動/)
  assert.ok(!/USB/.test(r.title + r.nextAction), JSON.stringify(r))
  // 文言が同じでも code が無ければ分けない。ほかの code は今までどおり
  assert.equal(h({ portOpen: false, lastError: { message: miss.message } }).title, 'USB が切断されています')
  assert.equal(h({ portOpen: false, lastError: { message: 'x', code: 'ENOENT' } }).title, 'USB が切断されています')
  // 止めていても案内は同じ（再起動するまで直らない）。無効と初期化の失敗は先
  assert.equal(h({ portOpen: false, running: false, lastError: miss }).title, 'serialport が入っていません')
  assert.equal(h({ enabled: false, portOpen: false, lastError: miss }).level, 'disabled')
  assert.equal(h({ portOpen: false, running: false, buildError: { message: 'x' }, lastError: miss }).title, 'アダプタを初期化できませんでした')
  // ポートが開いていれば（入れ直して再起動したあとに残った記録など）見ない
  assert.equal(h({ lastError: miss }).level, 'ok')
})

test('stale の境目は「取得間隔 × 3 + 30 秒」', () => {
  assert.equal(staleAfterMs(30), 120000)
  assert.equal(staleAfterMs(15), 75000)
  assert.equal(staleAfterMs(undefined), 120000)
})

test('一覧の並びは重い順', () => {
  const levels = ['ok', 'disabled', 'busy', 'bad', 'idle', 'stopped', 'stale']
  levels.sort((a, b) => levelOrder(a) - levelOrder(b))
  assert.deepEqual(levels, ['bad', 'stale', 'busy', 'stopped', 'idle', 'ok', 'disabled'])
})
