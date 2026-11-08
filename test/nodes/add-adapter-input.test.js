'use strict'

// B ルートノードの入力 add-adapter。画面の POST adapters と同じ service.addAdapter を通る。
// フローへ足す所までは本物の Node-RED の試験で見る（偽の RED には @node-red/runtime が無いので、ここでは使えない環境の返事を見る）。
// 戻すと落ちるもの: nodes/wsuha-broute.js の SHARED_TOPICS から add-adapter を外す・payload を消さずに返す。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ID, PW } = require('../runtime/fake-red')
const { createKit, input, out2, connected } = require('./node-kit')

const kit = createKit()
const { setup, createDevice, createBroute } = kit
afterEach(() => kit.cleanup())

test('add-adapter: 検証は画面と同じ。誤りは出力 2 の error（code VALIDATION）で、入力の値を返さない', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'dev1')
  const n = createBroute(fake, 'dev1')
  await connected(dev)
  const r = await input(n, { topic: 'add-adapter', payload: { mode: 'simulator', routeBId: ID, routeBPassword: PW } })
  assert.ok(r.err, 'done(err)')
  const e = out2(n, 'error').pop()
  assert.equal(e.payload.code, 'VALIDATION')
  assert.ok(e.payload.details.role, JSON.stringify(e.payload))
  const text = JSON.stringify(n._sent)
  assert.equal(text.includes(ID) || text.includes(PW), false, '返事に値を入れない')
})

test('add-adapter: 使えない環境は 503 と同じ NOT_AVAILABLE。readOnly でも止めずに同じ返事（フローは画面の守りを掛けない）', async () => {
  const fake = setup({ settings: { wsuhaBroute: { readOnly: true, uiAddAdapter: false } } })
  const dev = createDevice(fake, 'dev2')
  const n = createBroute(fake, 'dev2')
  await connected(dev)
  const r = await input(n, { topic: 'add-adapter', payload: { role: '動力', mode: 'simulator' } })
  assert.ok(r.err)
  assert.equal(out2(n, 'error').pop().payload.code, 'NOT_AVAILABLE')
})

test('ヘルプ: 入力と出力 2 の表に add-adapter', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-broute.html'), 'utf8')
  const help = html.slice(html.indexOf('data-help-name="wsuha-broute"'))
  assert.equal(help.split('<tr><td><code>add-adapter</code></td>').length - 1, 2)
})
