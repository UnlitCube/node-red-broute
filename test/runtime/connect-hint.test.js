'use strict'

// つながらないときの案内を、本物の Sequencer と SimulatorTransport から画面の形（view-model・health）まで通して見る。
// 部品ごとの試験は緑でも、配線の途中で値が落ちると案内は出ない。
// 案内を立てる規則そのものは test/sequencer-recovery.test.js。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRegistry } = require('../../lib/runtime/registry')
const vm = require('../../lib/runtime/view-model')
const { makeAdapter, waitReady } = require('./adapter-kit')
const { waitFor } = require('./fake-red')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const summaryOf = (h) => vm.buildSummary(h.inspect(), Date.now())

async function start(seq) {
  await seq.transport.open()
  seq.start()
}

test('認証が通らない台: 案内が出続ける。粘りの途中でも消えず、つながったら消える', async () => {
  // 前は直近のエラーの文言から推していたので、次の失敗で上書きされて出たり消えたりし、最初の 30 分は出なかった。
  // 戻すと落ちるもの: view-model.js の connectHintOf を文言の照らし合わせに戻す・sequencer の connectHint を読まない
  const reg = createRegistry()
  const { h, seq, transport } = makeAdapter(reg, 'hint-cred', {
    sim: { fail: { join: 1000 } },
    seq: { credentialHintAfterMs: 100, joinPersistMs: 60000 },
  })
  await start(seq)
  await waitFor(() => summaryOf(h).connectHint, 8000, '案内')
  const seen = []
  for (let i = 0; i < 20; i++) {
    seen.push(summaryOf(h))
    await sleep(25)
  }
  for (const s of seen) {
    assert.equal(s.connected, false)
    assert.equal(s.connectHint && s.connectHint.kind, 'credentials', '途中で消えない')
    assert.match(s.health.nextAction, /電波が弱い/)
    assert.match(s.health.reasons[0], /認証が \d+ 分通りません/)
  }
  // メーターが認証を通すようになると消える
  transport.config.fail.join = 0
  await waitReady(seq)
  assert.equal(summaryOf(h).connectHint, null)
  // 連続失敗は定期の値が届いてから戻る（接続の確認が通っても、値が来るとは限らない）
  seq.pollNow()
  await waitFor(() => seq.state.consecutiveFailures === 0, 8000, '定期の値')
  const ok = summaryOf(h)
  assert.equal(ok.connectHint, null)
  assert.equal(ok.health.level, 'ok', JSON.stringify(ok.health))
  await seq.destroy()
})

test('メーターが見つからない台: 種類は no-meter で、探した回数が画面の文に出る', async () => {
  // 戻すと落ちるもの: view-model.js の connectHintOf を文言の照らし合わせに戻す（rounds が 1 に固定される）
  const reg = createRegistry()
  const { h, seq } = makeAdapter(reg, 'hint-none', { sim: { pairId: 'DEADBEEF' }, seq: { scanRounds: 1 } })
  await start(seq)
  await waitFor(() => {
    const c = summaryOf(h).connectHint
    return c && c.rounds >= 2 ? c : null
  }, 12000, '2 回目の探索')
  const s = summaryOf(h)
  assert.equal(s.connectHint.kind, 'no-meter')
  assert.match(s.health.reasons[0], /この認証 ID のメーターが見つかりません（\d+ 回探しました）/)
  assert.match(s.health.nextAction, /認証 ID が正しいか/)
  await seq.destroy()
})

test('serialport を読み込めない台: 本物の Sequencer を通っても code が落ちず、USB の切断と言わない', async () => {
  // health は code で分ける。sequencer の lastError が message だけだと、ここで「USB が切断されています」に戻る。
  // 戻すと落ちるもの: sequencer.js の lastError から code を落とす・view-model.js が code を health に渡さない
  const reg = createRegistry()
  const { h, seq, transport } = makeAdapter(reg, 'no-sp', { meta: { mode: 'serial', port: '/dev/ttyUSB9', portLabel: 'USB9' } })
  const miss = Object.assign(new Error('serialport を読み込めません。パレットからこのノードを入れ直すか、userDir で npm install serialport@12 を実行して、Node-RED を再起動してください'), {
    code: 'SERIALPORT_MISSING',
  })
  transport.open = async () => {
    throw miss
  }
  seq.start()
  await waitFor(() => summaryOf(h).portOpen === false && h.inspect().snap.lastError, 5000, '直近のエラー')
  const s = summaryOf(h)
  assert.equal(s.health.title, 'serialport が入っていません', JSON.stringify(s.health))
  assert.equal(s.health.level, 'bad')
  const d = vm.buildDetail(h.inspect(), Date.now())
  assert.match(d.lastError.hint, /npm install serialport@12/)
  await seq.destroy()
})
