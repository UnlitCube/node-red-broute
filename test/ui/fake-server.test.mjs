// 偽のサーバーが本物の形のままであることを見張る。手で足した項目が本物に無い・本物の項目が偽物から抜けると、ここで落ちる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { summary, detail, configFor, settingsFor, fakeServer, memStorage } from './fake-server.mjs'

const require = createRequire(import.meta.url)
const vm = require('../../lib/runtime/view-model.js')

const sorted = (o) => Object.keys(o).sort()
const API = 'http://127.0.0.1:3985/wsuha-broute/api/v1/'
const get = async (server, path) => (await server.fetchImpl(API + path, {})).json()

test('一覧と詳細の項目は、本物の view-model と同じ', () => {
  assert.deepEqual(sorted(summary('a1')), sorted(vm.buildSummary({ id: 'x' })))
  assert.deepEqual(sorted(detail(summary('a1'))), sorted(vm.buildDetail({ id: 'x' })))
  // 入れ子の形も本物と同じ（power.fresh を偽物が落としても、1 段目の比較では気づかない）
  const real = vm.buildSummary({ id: 'x' })
  for (const k of ['power', 'current']) assert.deepEqual(sorted(summary('a1')[k]), sorted(real[k]), k)
})

// 戻すと落ちるもの: 偽物の counters を手で 6 項目に書く（段を進める作戦の 4 項目が画面に出なくても緑になる）
test('詳細の counters は、本物の全部の項目を持つ', async () => {
  const server = fakeServer({ items: [summary('a1')] })
  const d = await get(server, 'adapters/a1')
  assert.deepEqual(sorted(d.counters), sorted(vm.buildDetail({ id: 'x' }).counters))
  assert.ok(d.counters.fullScans !== undefined)
})

// 戻すと落ちるもの: 偽物の応答から total・lqi・read を外す
test('GET adapters の total、GET trend の series.lqi、GET read の values と missing がある', async () => {
  const at = Date.now() - 1000
  const server = fakeServer({ items: [summary('a1')], known: () => ({ '0xE7': { value: 500, unit: 'W', display: '500 W', at, name: '瞬時電力計測値' } }), trendRows: () => [[at, 500, 3, 2, 54]] })
  const list = await get(server, 'adapters')
  assert.deepEqual(sorted(list.total), ['count', 'enabled', 'power', 'staleCount'])
  assert.equal(list.total.power, 500)
  const tr = await get(server, 'adapters/a1/trend?range=1h')
  assert.deepEqual(sorted(tr.series), ['currentR', 'currentT', 'lqi', 'power'])
  assert.deepEqual(tr.series.lqi, [[at, 54]])
  assert.equal(tr.to - tr.from, 3600e3)
  const rd = await get(server, 'adapters/a1/read')
  assert.equal(rd.values.instantPower.value, 500)
  assert.deepEqual(rd.missing, ['E8'], '定期取得でまだ取れていない値')
  const v = await get(server, 'adapters/a1/values')
  assert.equal(v.items[0].label, '瞬時電力', '表の短い名前（読むだけの値にも入る）')
})

test('構成と運用設定は本物の形（tier・options）で、値だけ試験のもの', () => {
  const c = configFor('a1', { name: { value: '別の名前' } })
  assert.equal(c.fields.name.value, '別の名前')
  assert.equal(c.fields.name.tier, 'basic')
  assert.equal(c.fields.deviceKey.tier, 'advanced')
  assert.ok(c.fields.serialbaud.values.includes(2400))
  const s = settingsFor()
  assert.equal(s.fields.pollIntervalSec.tier, 'basic')
  assert.equal(s.fields.slowIntervalSec.tier, 'advanced')
})

test('memStorage は safeStorage と同じ形で読み書きする', () => {
  const s = memStorage()
  s.set('k', 'v')
  assert.equal(s.get('k'), 'v')
  s.remove('k')
  assert.equal(s.get('k'), null)
})
