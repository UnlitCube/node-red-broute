'use strict'

// 画面とフローへ渡す形に足したもの: 消した台の記録の片付け・フローの meta の auth・read の label と meterAt・
// 認証情報を消したあとの文。どれも別の層の呼び手がいるので、本物の store・service を通して確かめる。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { install } = require('../../lib/runtime/http-api')
const { createRegistry } = require('../../lib/runtime/registry')
const { createSettingsStore } = require('../../lib/runtime/settings-store')
const { createCredentialsStore } = require('../../lib/runtime/credentials-store')
const { createService } = require('../../lib/runtime/service')
const rv = require('../../lib/runtime/read-values')
const { createFakeRed, tmpDir, ID, PW } = require('./fake-red')
const { createKit, input, connected } = require('../nodes/node-kit')

function storeAt(dir) {
  return createSettingsStore({ file: path.join(dir, 'settings.json'), log: () => {} })
}

test('store.forget: 記録だけを消し、読み直しても戻らない。ほかの記録と置き場所のタブは残す', () => {
  // 戻すと落ちるもの: settings-store.js の forget を消す・ファイルへ書かない・next でなく手元の値を消す
  const dir = tmpDir('wsuha-forget-')
  const store = storeAt(dir)
  store.markCreated('gone', { by: 'web-ui', brouteId: 'b1', tabId: 't1' })
  store.update('kept', { changes: { pollIntervalSec: 60 }, by: 'web-ui', configValues: {}, ifMatch: store.rev('kept') })
  const rev = store.rev('kept')

  assert.equal(store.forget('gone'), true)
  assert.equal(store.forget('gone'), false, '2 回目は何も消さない')
  assert.equal(store.forget('toString'), false, 'Object の既定の名前を記録と読まない')
  assert.deepEqual(store.ids(), ['kept'])
  assert.equal(store.rev('kept'), rev, 'ほかの台の版は変えない')
  assert.equal(store.webUiTabId(), 't1')

  assert.deepEqual(storeAt(dir).ids(), ['kept'], 'ファイルからも消えている')
})

test('消した台の片付けは、本物の store で値の無い記録を消し、値のある記録を残す', () => {
  // http-api.js は store.forget があるときだけ呼ぶので、store の側に無いと黙って何もしない。
  // 戻すと落ちるもの: settings-store.js の返す関数の一覧から forget を外す
  const fake = createFakeRed()
  const dir = tmpDir('wsuha-forget-')
  const store = storeAt(dir)
  const rt = install(fake.RED, {
    registry: createRegistry(),
    store,
    eachNode: (cb) => cb({ id: 'live', type: 'wsuha-device' }),
    uiDir: tmpDir('wsuha-ui-'),
  })
  try {
    store.markCreated('empty', { by: 'web-ui', brouteId: 'b1', tabId: 't1' })
    store.update('valued', { changes: { pollIntervalSec: 60 }, by: 'web-ui', configValues: {}, ifMatch: store.rev('valued') })
    fake.events.emit('flows:started', {})
    assert.deepEqual(store.ids(), ['valued'])
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), /"empty"/)
  } finally {
    rt.hub.dispose()
  }
})

test('フローの meta にも auth が入り、GET meta と同じ形になる', () => {
  // 画面でできることはノードからもできるようにするので、ノードの側で足さなくても同じ値が出るようにする。
  // 戻すと落ちるもの: service.js の metaOf で auth を外す
  const metaOf = (settings) => {
    const store = storeAt(tmpDir('wsuha-meta-'))
    return createService({ registry: createRegistry(), store, settings }).metaOf()
  }
  assert.deepEqual(metaOf({}).auth, { required: false, available: true, editorPath: '/', nodeRoot: '/' })
  assert.deepEqual(metaOf({ adminAuth: { type: 'credentials' }, httpAdminRoot: '/admin' }).auth, {
    required: true,
    available: true,
    editorPath: '/admin/',
    nodeRoot: '/',
  })
  assert.deepEqual(metaOf({ adminAuth: { type: 'credentials' }, httpAdminRoot: false }).auth, {
    required: true,
    available: false,
    editorPath: null,
    nodeRoot: '/',
  })
  // エディタを別の方法で閉じたサーバーも、GET meta と同じ形
  assert.deepEqual(metaOf({ httpAdminRoot: false }).auth, { required: true, available: false, editorPath: null, nodeRoot: '/' })
})

// メーターの時計は日本時間（08:30 は UTC の 23:30）。試験を流す機械の時刻帯に頼らないよう UTC で書く
const NOW = Date.UTC(2026, 10, 7, 0, 0, 0)
const STAMP = Date.UTC(2026, 10, 6, 23, 30, 0)

function readOne(key, value) {
  return rv.buildRead({ device: 'a', deviceKey: 'k', known: { [key]: value }, req: { epcs: null, maxAgeSec: null }, inspect: {}, now: NOW }).values
}

test('read: 定時積算は確定の時刻を meterAt に分け、display から除く。at は受信の時刻のまま', () => {
  // 画面の計測値の表（makeRow）と同じ形にする。同じ関数で分けないと、read で埋めた行だけ表示が変わる。
  // 戻すと落ちるもの: read-values.js の bodyOf で splitStamp を通さない
  for (const [hex, name, label] of [
    ['0xEA', 'scheduledCumulativeForward', '定時積算（買電）'],
    ['0xEB', 'scheduledCumulativeReverse', '定時積算（売電）'],
  ]) {
    const b = readOne(hex, { value: 123.4, unit: 'kWh', display: '2026-11-07 08:30:00 / 123.4 kWh', timestamp: '2026-11-07 08:30:00', at: NOW - 5000 })[name]
    assert.equal(b.display, '123.4 kWh')
    assert.equal(b.meterAt, STAMP)
    assert.equal(b.at, NOW - 5000, '受信の時刻')
    assert.equal(b.label, label)
  }
})

test('read: 短い名前の無い EPC は label が null。定時積算でない値の meterAt は null で、display は変えない', () => {
  // 戻すと落ちるもの: read-values.js の bodyOf で label・meterAt を足さない・どの EPC でも時刻を切る
  const p = readOne('0xE7', { value: 436, unit: 'W', display: '2026-11-07 08:30:00 / 436 W', at: NOW - 1000 }).instantPower
  assert.equal(p.label, '瞬時電力')
  assert.equal(p.meterAt, null)
  assert.equal(p.display, '2026-11-07 08:30:00 / 436 W')
  const u = readOne('0xD0', { value: 1, display: '1', at: NOW - 1000 }).D0
  assert.equal(u.label, null)
  assert.equal(u.meterAt, null)
})

test('同じ台の read と diag は、API とフローで device と deviceKey が同じ（デバイスキーも契約も空の台）', async () => {
  // 同じ関数を通しても既定の値が違い、API の返事をフローの出力と突き合わせられなかった。
  // 戻すと落ちるもの: service.js の readOf と diagPayload の既定を null に戻す
  const kit = createKit()
  const B = '/wsuha-broute/api/v1'
  try {
    const fake = kit.setup()
    const dev = kit.createDevice(fake, 'nokeyaaaaaaaaaa1', { deviceKey: '', role: '' })
    const b = kit.createBroute(fake, dev.id)
    await connected(dev)
    const flowRead = (await input(b, { topic: 'read' })).sent[0][1].payload
    const apiRead = (await fake.request('GET', `${B}/adapters/${dev.id}/read`)).body
    assert.equal(apiRead.deviceKey, flowRead.deviceKey)
    assert.equal(apiRead.device, flowRead.device)
    assert.equal(apiRead.deviceKey, dev.id, '空のデバイスキーは設定ノードの id')
    const flowDiag = (await input(b, { topic: 'diag', payload: { name: 'ropt' } })).sent[0][1].payload
    const apiDiag = (await fake.request('POST', `${B}/adapters/${dev.id}/diag`, { body: { name: 'ropt' } })).body
    assert.equal(apiDiag.deviceKey, flowDiag.deviceKey)
    assert.equal(apiDiag.device, flowDiag.device)
  } finally {
    await kit.cleanup()
  }
})

/** 保存した認証情報を消して、handle のログの文を返す。 */
function clearLogOf(mode) {
  const registry = createRegistry()
  const credStore = createCredentialsStore({ dir: tmpDir('wsuha-cred-') })
  const service = createService({ registry, store: storeAt(tmpDir('wsuha-clear-')), credStore })
  const h = registry.upsert('a1')
  h.claim({ id: 'a1' }, { meta: { name: 'a1', mode, enabled: true } })
  credStore.write('a1', { id: ID, password: PW, by: 'web-ui' })
  service.clearCredentials(h, { by: 'web-ui' })
  const rows = h.logsAfter({ limit: 100 }).items.filter((r) => /B ルートの認証 ID とパスワードを消しました/.test(r.text))
  assert.equal(rows.length, 1)
  return rows[0].text
}

test('認証情報を消したあとの文: シミュレーターは架空の値に戻ると言い、実機は認証情報なしと言う', () => {
  // シミュレーターは認証情報がどこにも無くても架空の値で動くので、「認証情報なし」は事実と違う。
  // 戻すと落ちるもの: service.js の afterClearText で接続先を見ない
  assert.match(clearLogOf('simulator'), /無ければシミュレーターの架空の値に戻ります/)
  assert.match(clearLogOf('serial'), /無ければ認証情報なしになります/)
})
