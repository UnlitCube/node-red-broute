'use strict'

// ノードの寿命（nodes/wsuha-device.js・nodes/wsuha-broute.js）。
// test/sequencer.test.js と同じ偽の RED のやり方で、実際のノードのコンストラクタを動かす。
//
//  - wsuha-device が registry に載る。enabled なら使っているノードが無くてもポートを開く。enabled=false で開かない
//  - wsuha-broute は AdapterHandle 経由で measurement を受ける（出力の形は今のまま）
//  - wsuha-broute だけを作り直しても（部分デプロイ）SKTERM が出ず、再接続しない
//  - 作る順序に頼らない（設定ノードの sequencer が畳まれている間に作ったノードにも届く）
//  画面の API は httpNode に載る。画面と同じ操作の入力と出力は test/nodes/flow-io.test.js。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { getRegistry } = require('../../lib/runtime/registry')
const { createFakeRed, waitFor, tmpDir, ID, PW } = require('../runtime/fake-red')

const SIM = JSON.stringify({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, pairId: ID.slice(-8), echonetDelayMs: 5 })
let seq = 0
const open = [] // 後片付けするノード（作った順）

function setup(opts) {
  const fake = createFakeRed(opts)
  require('../../nodes/wsuha-device.js')(fake.RED)
  require('../../nodes/wsuha-broute.js')(fake.RED)
  return fake
}

function devConfig(id, extra) {
  return Object.assign(
    {
      id,
      name: '試験のアダプタ',
      role: '電力',
      mode: 'simulator',
      deviceKey: 'lifecycle' + id.replace(/[^A-Za-z0-9]/g, ''),
      pollInterval: 30,
      pollEpcs: 'E7',
      scanDurations: '4,5',
      simulatorOptions: SIM,
      _credentials: { routeBId: ID, routeBPassword: PW },
    },
    extra
  )
}

/** 待ち時間を詰める。コンストラクタが返った直後（手順が動き出す前）に呼ぶ。 */
function speedUp(seqObj) {
  Object.assign(seqObj.options, {
    resetSettleMs: 20,
    scanRounds: 1,
    commandTimeout: 2000,
    joinTimeout: 3000,
    sendTimeout: 2000,
    joinRetryMs: 50,
    joinBurstBackoffMs: [60],
    txBudgetGuard: false,
    minPollIntervalSec: 1,
    pollIntervalSec: 1,
  })
}

function createDevice(fake, id, extra) {
  const dev = fake.create('wsuha-device', devConfig(id, extra))
  if (dev.sequencer) speedUp(dev.sequencer)
  open.push([fake, dev])
  return dev
}

function createBroute(fake, devId, extra) {
  const id = 'broute-' + ++seq
  const node = fake.create('wsuha-broute', Object.assign({ id, device: devId }, extra))
  open.push([fake, node])
  return node
}

const measurements = (node) => node._sent.filter((m) => Array.isArray(m) && m[0])
const skterms = (dev) => dev.sequencer.transport.sent.filter((c) => /^SKTERM/.test(c)).length

// 接続の待ちは長めにとる（負荷の下では数秒かかり、VM が数秒止まることもある。通る試験の時間は変わらない）
async function connected(dev) {
  await waitFor(() => dev.sequencer && dev.sequencer.isConnected, 30000, '接続')
}

afterEach(async () => {
  // 作った逆順に閉じる（Node-RED の停止と同じく、設定ノードは最後）
  while (open.length) {
    const [fake, node] = open.pop()
    if (fake.nodes.get(node.id) === node) await fake.close(node, true)
  }
})

test('wsuha-device は registry に載り、enabled なら使っているノードが無くてもポートを開く', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'life-reg')
  const h = getRegistry().get('life-reg')
  assert.ok(h && h.claimed, 'registry に載る')
  assert.equal(dev.handle, h)
  assert.equal(h.sequencer, dev.sequencer, 'handle に sequencer が付く')
  assert.equal(h.meta.name, '試験のアダプタ')
  assert.equal(h.meta.enabled, true)
  assert.equal(h.consumers, 0)
  await connected(dev)
  assert.equal(dev.sequencer.state.portOpen, true, 'wsuha-broute が 1 つも無くても開く')

  // API からも見える（モジュール関数で 1 回だけ登録した API）
  const r = await fake.request('GET', '/wsuha-broute/api/v1/adapters/life-reg')
  assert.equal(r.statusCode, 200)
  assert.equal(r.body.connected, true)
  assert.equal(fake.routes.filter((x) => x.method === 'GET' && x.path === '/wsuha-broute/api/v1/meta').length, 1, 'API の登録は 1 回だけ')
  assert.equal(fake.routes.filter((x) => x.path === '/wsuha-broute/serialports').length, 1, '既存の serialports は残す')
})

test('エディタのポートの候補: シミュレーターを除いた items と、serialport を読み込めないときの serialportMessage を返す', async () => {
  // 戻すと落ちるもの: wsuha-device.js の /wsuha-broute/serialports で serialportMessage を返さない（エディタが「見つかりません」と言う）
  const fake = setup()
  const dev = createDevice(fake, 'life-ports')
  dev.runtime.service.serialPorts = async () => ({ items: [{ path: 'simulator', simulator: true }], serialportAvailable: false, serialportMessage: '入れ方の文' })
  const miss = await fake.request('GET', '/wsuha-broute/serialports', { app: 'admin' })
  assert.deepEqual(miss.body, { items: [], serialportMessage: '入れ方の文' })
  dev.runtime.service.serialPorts = async () => ({ items: [{ path: '/dev/ttyUSB0' }], serialportAvailable: true, serialportMessage: null })
  const ok = await fake.request('GET', '/wsuha-broute/serialports', { app: 'admin' })
  assert.deepEqual(ok.body, { items: [{ path: '/dev/ttyUSB0' }], serialportMessage: null })
  dev.runtime.service.serialPorts = async () => {
    throw new Error('読めない')
  }
  const failed = await fake.request('GET', '/wsuha-broute/serialports', { app: 'admin' })
  assert.deepEqual(failed.body, { items: [], serialportMessage: null }, '失敗しても同じ形')
})

test('enabled=false なら開かない（wsuha-broute を作っても開かない）', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'life-off', { enabled: false })
  assert.equal(dev.sequencer, null)
  const b = createBroute(fake, 'life-off')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(dev.sequencer, null, '使っているノードがあっても開かない')
  assert.equal(getRegistry().get('life-off').sequencer, null)
  assert.equal(getRegistry().get('life-off').consumers, 1)
  const st = b._statuses[b._statuses.length - 1]
  assert.equal(st.fill, 'grey')
  assert.match(st.text, /無効/)
  // 入力は理由つきで断る
  let doneErr = null
  b.emit('input', { topic: 'poll' }, () => {}, (err) => (doneErr = err))
  await waitFor(() => doneErr !== null, 1000, 'done')
  assert.match(doneErr.message, /無効/)
  const r = await fake.request('GET', '/wsuha-broute/api/v1/adapters/life-off')
  assert.equal(r.body.health.level, 'disabled')
  assert.equal(r.body.consumers, 1)
})

test('wsuha-broute は AdapterHandle 経由で measurement を受ける（出力の形は今のまま）', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'life-meas')
  const b = createBroute(fake, 'life-meas')
  assert.equal(dev.handle.consumers, 1)
  assert.ok(dev.handle.listenerCount('measurement') >= 1, 'handle を購読している')
  assert.equal(dev.sequencer.listeners('measurement').length, 1, 'sequencer には handle の中継の 1 つだけ')
  await connected(dev)
  await waitFor(() => measurements(b).some((m) => m[0].payload.values.instantPower), 5000, '瞬時電力の出力')
  const msg = measurements(b).find((m) => m[0].payload.values.instantPower)
  assert.equal(msg.length, 2)
  assert.equal(msg[1], null)
  assert.equal(msg[0].topic, '電力')
  const p = msg[0].payload
  assert.equal(p.device, '電力')
  assert.equal(p.port, 'simulator')
  assert.equal(typeof p.ts, 'string')
  assert.equal(typeof p.values.instantPower.value, 'number')
  assert.equal(p.values.instantPower.unit, 'W')
  assert.equal(p.values.instantPower.epc, 'E7')
  // 状態の出力（出力 2）も今のまま
  assert.ok(b._sent.some((m) => m[1] && m[1].topic === 'status' && m[1].payload.device === '電力'))
  const st = b._statuses[b._statuses.length - 1]
  assert.equal(st.fill, 'green')
})

test('wsuha-broute だけを作り直しても（部分デプロイ）SKTERM が出ず、再接続しない', async () => {
  // 1.x は使っているノードが 0 になると sequencer を畳み（SKTERM）、次のノードで作り直していた。
  // 戻すと落ちるもの: wsuha-device.js の unregister を「0 になったら _close()」に戻す
  const fake = setup()
  const dev = createDevice(fake, 'life-partial')
  const b1 = createBroute(fake, 'life-partial')
  await connected(dev)
  await waitFor(() => measurements(b1).length > 0, 5000, '最初の出力')
  const seqBefore = dev.sequencer
  const termBefore = skterms(dev)
  const reconnects = seqBefore.state.counters.reconnects
  const joins = seqBefore.state.counters.joins

  await fake.close(b1, false) // このノードだけ変更してデプロイ
  const b1Count = b1._sent.length
  await new Promise((r) => setTimeout(r, 50))
  const b2 = createBroute(fake, 'life-partial')

  await waitFor(() => measurements(b2).length > 0, 5000, '作り直したノードへの出力')
  assert.equal(dev.sequencer, seqBefore, 'sequencer を作り直さない')
  assert.equal(skterms(dev), termBefore, 'SKTERM を送らない')
  assert.equal(seqBefore.state.counters.reconnects, reconnects, '再接続しない')
  assert.equal(seqBefore.state.counters.joins, joins, 'PANA 認証をやり直さない')
  assert.equal(seqBefore.isConnected, true)
  assert.equal(b1._sent.length, b1Count, '閉じたノードには届かない（二重に流れない）')
  assert.equal(dev.handle.consumers, 1)

  // 削除（removed）しても同じ
  await fake.close(b2, true)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(skterms(dev), termBefore)
  assert.equal(dev.sequencer.isConnected, true)
  assert.equal(dev.handle.consumers, 0)
})

test('作る順序に頼らない: 設定ノードの sequencer が畳まれている間に作ったノードにも届く', async () => {
  // 1.x で直した不具合の守り: 「sequencer が null の間に作られたノードの出力だけ黙って止まる」
  const fake = setup()
  const dev = createDevice(fake, 'life-order')
  await connected(dev)
  await dev._close() // sequencer を畳む（無効化 → 有効化などで起きる）
  assert.equal(dev.sequencer, null)
  assert.equal(dev.handle.sequencer, null)

  const b = createBroute(fake, 'life-order') // handle を購読 → register で作り直される
  assert.ok(dev.sequencer, '作り直す')
  speedUp(dev.sequencer)
  assert.equal(dev.handle.sequencer, dev.sequencer)
  await connected(dev)
  await waitFor(() => measurements(b).length > 0, 5000, '作り直した sequencer からの出力')
})

test('full デプロイ（設定ノードも作り直す）: 閉じるときは SKTERM し、新しいノードに届き、古いノードには届かない', async () => {
  const fake = setup()
  const dev1 = createDevice(fake, 'life-full')
  const b1 = createBroute(fake, 'life-full')
  await connected(dev1)
  await waitFor(() => measurements(b1).length > 0, 5000, '最初の出力')
  const h = dev1.handle
  const seq1 = dev1.sequencer

  await fake.close(b1, false)
  await fake.close(dev1, false)
  assert.ok(seq1.transport.sent.some((c) => /^SKTERM/.test(c)), '設定ノードを閉じるときは SKTERM してから閉じる')
  assert.equal(h.sequencer, null, 'handle から外す')
  const b1Count = b1._sent.length

  const dev2 = createDevice(fake, 'life-full')
  assert.equal(dev2.handle, h, '同じ id なら同じ handle')
  const b2 = createBroute(fake, 'life-full')
  await connected(dev2)
  await waitFor(() => measurements(b2).length > 0, 5000, '新しいノードへの出力')
  assert.equal(b1._sent.length, b1Count)
  assert.ok(h.logsAfter({ limit: 1000 }).items.length > 0, 'ログのリングは handle に残る')
})

test('削除した設定ノードは flows:started で一覧から外す', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'life-removed')
  await connected(dev)
  await fake.close(dev, true)
  assert.ok(getRegistry().get('life-removed'), 'flows:started までは残す')
  fake.events.emit('flows:started', {})
  assert.equal(getRegistry().get('life-removed'), null)
})

test('起動時に運用設定を効かせ、設定ノードの値を後から変えた項目は外す', async () => {
  const userDir = tmpDir('wsuha-life-')
  const file = path.join(userDir, 'wsuha-broute', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      adapters: {
        'life-rt': {
          rev: 'r1',
          updatedAt: 1,
          updatedBy: 'dev',
          fields: {
            pollIntervalSec: { value: 60, configAtSet: 30, by: 'dev', at: 1 },
            pollEpcs: { value: ['0xE7', '0xE8'], configAtSet: ['0xE7'], by: 'dev', at: 1 },
          },
        },
      },
    })
  )
  const fake = setup({ userDir })
  const dev = createDevice(fake, 'life-rt')
  // speedUp で pollIntervalSec を詰める前の値を見る
  assert.equal(dev.sequencer._baseline.pollIntervalSec, 60, '運用設定の取得間隔')
  assert.deepEqual(dev.sequencer.options.pollEpcs, [0xe7, 0xe8], '運用設定のプロパティ')
  await fake.close(dev, false)

  // エディタで取得間隔を 45 秒に変えてデプロイした
  const fake2 = setup({ userDir })
  const dev2 = fake2.create('wsuha-device', devConfig('life-rt', { pollInterval: 45 }))
  open.push([fake2, dev2])
  assert.equal(dev2.sequencer.options.pollIntervalSec, 45, '設定ノードの値が効く')
  assert.deepEqual(dev2.sequencer.options.pollEpcs, [0xe7, 0xe8], 'ほかの項目の運用設定は残す')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(disk.adapters['life-rt'].fields), ['pollEpcs'])
  assert.ok(dev2.handle.logsAfter({ limit: 1000 }).items.some((x) => /設定ノードの取得間隔が変わったため（30 → 45）/.test(x.text)))
  const r = await fake2.request('GET', '/wsuha-broute/api/v1/adapters/life-rt/settings')
  assert.equal(r.body.fields.pollIntervalSec.source, 'config')
  assert.ok(r.body.warnings.some((w) => /外しました/.test(w)))
})

// ---------------------------------------------------------------------------
//  認証情報の出どころと、認証情報が無いときの健康・使われていない設定ノード
// ---------------------------------------------------------------------------

/** 認証情報を持たない設定ノードの config（設定ノードの credentials も env も無い）。 */
function noCredConfig(id, deviceKey, extra) {
  const c = devConfig(id, Object.assign({ deviceKey }, extra))
  delete c._credentials
  return c
}

/** パスワードだけの設定ノードの config。そろっていないので動かず、シミュレーターの架空の値にも置き換わらない。 */
function halfCredConfig(id, deviceKey) {
  return devConfig(id, { deviceKey, _credentials: { routeBPassword: 'ZYXWVU987654' } })
}

/** 見えるもの全部（API・SSE・出力 2・handle）を 1 本の文字列にする。 */
async function everythingVisible(fake, id, broute) {
  const parts = []
  parts.push((await fake.request('GET', '/wsuha-broute/api/v1/adapters/' + id)).text)
  parts.push((await fake.request('GET', '/wsuha-broute/api/v1/adapters')).text)
  const s = fake.openStream('/wsuha-broute/api/v1/stream?adapter=' + id + '&logs=1')
  await s.done
  parts.push(s.res.text)
  s.req.emit('close')
  broute.emit('input', { topic: 'status' }, (m) => broute._sent.push(m), () => {})
  await waitFor(() => broute._sent.some((m) => Array.isArray(m) && m[1] && m[1].topic === 'status'), 2000, '出力 2 の status')
  parts.push(JSON.stringify(broute._sent))
  parts.push(JSON.stringify(fake.nodes.get(id).handle.credentialSource))
  parts.push(JSON.stringify(fake.nodes.get(id).credentialSource))
  return parts.join('\n')
}

test('認証情報の出どころに、秘密ファイルの絶対パスと JSON.parse の文（入力の断片）を出さない', async () => {
  // 前は source に「見つかりません → <userDir>/wsuha-broute-<key>.secret.json (Unexpected token …)」が入り、
  // HTTP・SSE・出力 2 に流れていた。JSON.parse の文は壊れたファイルの中身の断片を含む。
  // 戻すと落ちるもの: wsuha-device.js の resolveCredentials で tried に file と err.message を入れる形に戻す
  const userDir = tmpDir('wsuha-secret-')
  const key = 'brokenjson'
  const FRAG = 'LEAKFRAGMENT9Q'
  // 「キー: 値」で書いてしまった秘密ファイル。JSON.parse の文は入力を含む:
  // Node 20 以降は行をそのまま（… "id: LEAKFRAGMENT9Q" is not valid JSON）、Node 18 は先頭の 1 文字（Unexpected token i in JSON …）。
  // どちらでも、下で「断片」と「JSON.parse の文そのもの」の両方が出ないことを見る
  const body = `id: ${FRAG}`
  fs.writeFileSync(path.join(userDir, `wsuha-broute-${key}.secret.json`), body)
  let parseMsg = ''
  try {
    JSON.parse(body)
  } catch (e) {
    parseMsg = e.message
  }
  assert.match(parseMsg, /Unexpected token|is not valid JSON/, '前提: JSON.parse の文の形（' + parseMsg + '）')

  const fake = setup({ userDir })
  const dev = fake.create('wsuha-device', noCredConfig('life-secret-bad', key))
  open.push([fake, dev])
  const b = createBroute(fake, 'life-secret-bad')
  const text = await everythingVisible(fake, 'life-secret-bad', b)
  assert.ok(!text.includes(FRAG), '壊れたファイルの中身の断片が出ている')
  // JSON の中ではバックスラッシュが 2 つになるので、両方の形で探す
  assert.ok(!text.includes(userDir) && !text.includes(JSON.stringify(userDir).slice(1, -1)), '秘密ファイルの絶対パスが出ている')
  assert.ok(!/Unexpected token|is not valid JSON|ENOENT|EACCES/.test(text), 'err.message や code がそのまま出ている')

  const detail = (await fake.request('GET', '/wsuha-broute/api/v1/adapters/life-secret-bad')).body
  assert.equal(detail.credentials.configured, false)
  assert.match(detail.credentials.source, /ファイル（wsuha-broute-brokenjson\.secret\.json）: 形式が正しくありません/)
  assert.match(detail.credentials.source, /環境変数/)
  assert.match(detail.credentials.source, /設定ノード/)
  // Node-RED のログ（RED.log）には詳しく出してよい（運用者が直すため）
  assert.ok(fake.logs.some(([l, t]) => l === 'warn' && t.includes(`wsuha-broute-${key}.secret.json`) && t.includes(userDir)), 'RED.log に場所を残す')
})

test('認証情報の出どころ: 見つからない・読めた（ファイル名だけ）', async () => {
  const userDir = tmpDir('wsuha-secret-')
  // 読めたファイル
  fs.writeFileSync(path.join(userDir, 'wsuha-broute-goodfile.secret.json'), JSON.stringify({ goodfile: { id: ID, password: PW } }))
  const fake = setup({ userDir })
  const ok = createDevice(fake, 'life-secret-ok', { deviceKey: 'goodfile', _credentials: undefined })
  assert.equal(ok.handle.credentialSource, 'ファイル（wsuha-broute-goodfile.secret.json）')
  assert.equal(ok.sequencer.snapshot().credentials.source, 'ファイル（wsuha-broute-goodfile.secret.json）')
  await connected(ok)
  const d1 = (await fake.request('GET', '/wsuha-broute/api/v1/adapters/life-secret-ok')).body
  assert.equal(d1.credentials.configured, true)
  assert.equal(d1.credentials.source, 'ファイル（wsuha-broute-goodfile.secret.json）')
  // 秘密ファイルは移行用。動きは止めず、入れ直しを勧める
  // 戻すと落ちるもの: wsuha-device.js で fromSecretFile を見ない
  const moved = /認証情報をファイル（wsuha-broute-goodfile\.secret\.json）から読みました。秘密ファイルは移行用です。Web UI かエディタで入れ直してください/
  assert.ok(ok.handle.logsAfter(0).items.some((l) => l.level === 'warn' && moved.test(l.text)), 'Web UI のログ')
  assert.ok(fake.logs.some(([l, t]) => l === 'warn' && moved.test(t)), 'Node-RED のログ')
  assert.ok(!fake.logs.some(([, t]) => t.includes(ID) || t.includes(PW)), '値は出さない')

  // 無いファイル
  const none = fake.create('wsuha-device', halfCredConfig('life-secret-none', 'nofile'))
  open.push([fake, none])
  const src = none.handle.credentialSource
  assert.match(src, /ファイル（wsuha-broute-nofile\.secret\.json）: 見つかりません/)
  assert.ok(!src.includes(userDir) && !src.includes(process.cwd()), src)
  assert.equal(none.sequencer.snapshot().credentials.source, src, '出力 2 の status にも同じ安全な文を出す')
  // 設定ノードの値
  const cfg = createDevice(fake, 'life-secret-cfg', { deviceKey: 'cfgonly' })
  assert.equal(cfg.handle.credentialSource, '設定ノード')
})

test('認証情報がそろわないまま起動した台は、health が「認証情報がありません」（「開始」を勧めない）', async () => {
  const fake = setup()
  const dev = fake.create('wsuha-device', halfCredConfig('life-nocred', 'nocred'))
  open.push([fake, dev])
  await waitFor(() => dev.sequencer && !dev._opening, 3000, '開き終わる')
  assert.equal(dev.sequencer._running, false, '前提: 認証情報が無いので自動運転を始めていない')
  const r = await fake.request('GET', '/wsuha-broute/api/v1/adapters/life-nocred')
  assert.equal(r.body.health.level, 'idle')
  assert.equal(r.body.health.title, '認証情報がありません')
  assert.equal(r.body.health.nextAction, '設定タブの「B ルートの認証 ID とパスワード」で入れてください（設定ノードか環境変数でも入れられます）')
  const list = await fake.request('GET', '/wsuha-broute/api/v1/adapters')
  assert.equal(list.body.items.find((x) => x.id === 'life-nocred').health.title, '認証情報がありません')
})

test('serialport が無いときは「開けるまで再試行します」と書かず、次の一手の文をそのまま出す', async () => {
  // 入れ直さない限り、待っても直らない。
  // 戻すと落ちるもの: wsuha-device.js の _open で SERIALPORT_MISSING を見ない
  const fake = setup()
  const text = 'serialport を読み込めません。パレットからこのノードを入れ直してください'
  const opened = async (id, err) => {
    const dev = fake.create('wsuha-device', devConfig(id, { mode: 'serial', serialport: '/dev/ttyFAKE9', enabled: false, autoStart: false }))
    open.push([fake, dev])
    dev.enabled = true
    dev._build()
    dev.sequencer.transport.open = async () => {
      throw err
    }
    await dev._open()
    return dev._errors
  }
  const missing = await opened('life-nosp', Object.assign(new Error(text), { code: 'SERIALPORT_MISSING' }))
  assert.deepEqual(missing, [text])
  const other = await opened('life-busy', new Error('ポートが使われています'))
  assert.deepEqual(other, ['ポートを開けません（開けるまで再試行します）: ポートが使われています'], 'ほかの失敗は今までどおり')
})

test('診断（purpose が diag）で取った値は、wsuha-broute の出力 1 と推移に出さない（計測値の表と SSE には出す）', async () => {
  // 診断の「任意の EPC」や Web UI の propmap を押すたびに、出力 1（DB などへ流しているもの）に
  // 計測値と同じ形で流れていた。指定の取得（manual）は今までどおり出力 1 に出す。
  // 戻すと落ちるもの: wsuha-broute.js の measurement で purpose === 'diag' を見るのをやめる
  const fake = setup()
  const dev = createDevice(fake, 'life-diag')
  const b = createBroute(fake, 'life-diag')
  await connected(dev)
  await waitFor(() => measurements(b).length > 0, 5000, '最初の出力')
  const seqObj = dev.sequencer
  Object.assign(seqObj.options, { pollIntervalSec: 30 })
  seqObj._schedulePoll()
  await waitFor(() => seqObj._requestDepth === 0 && !seqObj._pending, 5000, '取得の途中が終わる')
  const s = fake.openStream('/wsuha-broute/api/v1/stream?adapter=life-diag')
  await s.done
  const withCurrent = () => measurements(b).filter((m) => m[0].payload.values.instantCurrent)
  const trendR = () => dev.handle.trend(3600 * 1000, Date.now() + 1000).series.currentR.length

  // E8（瞬時電流）は定期取得していない。API の診断（diag の epc）で取る
  const r = await fake.request('POST', '/wsuha-broute/api/v1/adapters/life-diag/diag', { body: { name: 'epc', args: { epcs: ['E8'] } } })
  assert.equal(r.statusCode, 200, r.text)
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(withCurrent().length, 0, '診断の値を出力 1 に出さない')
  assert.equal(trendR(), 0, '診断の値を推移に入れない')
  const values = (await fake.request('GET', '/wsuha-broute/api/v1/adapters/life-diag/values')).body
  const e8 = values.items.find((x) => x.epc === '0xE8')
  assert.ok(e8 && e8.value && typeof e8.value.r === 'number', '計測値の表には出す')
  await waitFor(() => /event: measurement\n/.test(s.res.text), 2000, 'SSE の measurement')
  assert.ok(s.res.text.includes('"epc":"0xE8"'), 'SSE の measurement には出す')
  s.req.emit('close')

  // 指定の取得（フローの入力の get = manual）は出力 1 と推移に出す
  let doneErr
  b.emit('input', { topic: 'get', payload: 'E8' }, (m) => b._sent.push(m), (err) => (doneErr = err || null))
  await waitFor(() => doneErr !== undefined, 5000, 'get の done')
  assert.equal(doneErr, null)
  await waitFor(() => withCurrent().length === 1, 2000, '指定の取得は出力 1 に出す')
  assert.equal(trendR(), 1, '指定の取得は推移に入れる')
})

test('使っているノードが 0 の有効な設定ノードは、flows:started のあとに RED.log.warn を 1 回だけ出す（デプロイのたびに出さない）', async () => {
  // 予備のつもりで置いた設定ノードも、enabled ならポートを開いて電波を使い続ける。
  // 戻すと落ちるもの: wsuha-device.js の flows:started で使われていない設定ノードを warn するのをやめる・1 回に絞るのをやめる
  const fake = setup()
  const MSG = 'この設定ノードを使っているノードがありません。予備なら設定ノードの「有効」を外してください'
  const warns = () => fake.logs.filter(([l, t]) => l === 'warn' && t.includes(MSG)).map(([, t]) => t)
  createDevice(fake, 'life-unused', { name: '予備のアダプタ' })
  createDevice(fake, 'life-used', { name: '使っているアダプタ' })
  createBroute(fake, 'life-used')
  createDevice(fake, 'life-unused-off', { name: '無効のアダプタ', enabled: false })
  assert.deepEqual(warns(), [], 'flows:started の前（ノードを作っている途中）は出さない')

  fake.events.emit('flows:started', { type: 'full' })
  assert.equal(warns().length, 1, warns().join(' | '))
  assert.match(warns()[0], /予備のアダプタ/)
  assert.match(warns()[0], /life-unused/)
  assert.ok(!warns().some((t) => /使っているアダプタ|無効のアダプタ/.test(t)), '使っている・無効の設定ノードには出さない')

  // 同じ状態のままの再デプロイ（部分デプロイ・設定ノードの作り直し）では繰り返さない
  fake.events.emit('flows:started', { type: 'nodes' })
  const old = fake.nodes.get('life-unused')
  await fake.close(old, false)
  createDevice(fake, 'life-unused', { name: '予備のアダプタ' })
  fake.events.emit('flows:started', { type: 'full' })
  assert.equal(warns().length, 1, 'デプロイのたびに出さない: ' + warns().join(' | '))

  // 使われたら印を消す。また使われなくなったら 1 回だけ出す
  const b = createBroute(fake, 'life-unused')
  fake.events.emit('flows:started', { type: 'nodes' })
  assert.equal(warns().length, 1)
  await fake.close(b, true)
  fake.events.emit('flows:started', { type: 'nodes' })
  fake.events.emit('flows:started', { type: 'nodes' })
  assert.equal(warns().length, 2, '使われなくなったら 1 回: ' + warns().join(' | '))
  // Node-RED のログ（RED.log）にだけ出す。アダプタのログ（画面・SSE）には出さない
  const rows = getRegistry().get('life-unused').logsAfter({ limit: 1000 }).items
  assert.ok(rows.length > 0, '前提: アダプタのログはある')
  assert.ok(!rows.some((r) => r.text.includes(MSG)))
})
