'use strict'

// フローの入力と設定ノードの値の守りを、偽の RED とシミュレーターで確かめる。
//   - 開き直し（構成・認証情報の変更）の最中のフローの reconnect・stop などは BUSY（前の sequencer の SKTERM を取り消さない）
//   - 画面・フローで認証情報を変えたら、前の sequencer の値とプロパティマップを写さない（read が前の契約の値を fresh で返さない）
//   - フローの command に改行・制御文字・ASCII 以外の文字を混ぜたら、預からずに VALIDATION（アダプタに何も書かない）
//   - フローの command の payload が文字列でなければ、送らずに VALIDATION
//   - 設定ノードの pollEpcs は sequencer の toEpc と同じ規則で読む（'0E7' を E7 と読まない。読めない要素は warn）
//   - フローの reconnect の ladder は 0〜3 の整数（外れたら VALIDATION）。止めた台への reconnect は STOPPED_BY_OVERRIDE
//   - diag は預かりの道だけを通る（SHARED_TOPICS には入れない）
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { waitFor, PW } = require('../runtime/fake-red')
const { createKit, input, out2, connected } = require('./node-kit')

const kit = createKit()
const { setup, createDevice, createBroute } = kit
afterEach(() => kit.cleanup())

/** 出力 2 の error の payload（入力の返事の sent から）。 */
function errorOf(r) {
  const m = r.sent.find((x) => Array.isArray(x) && x[1] && x[1].topic === 'error')
  return m ? m[1].payload : null
}

test('開き直しの SKTERM の最中に来たフローの reconnect・stop・status は BUSY。前の sequencer の SKTERM は取り消されない', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: nodes/wsuha-broute.js の `if (!sequencer || handle.reconfiguring)` を `if (!sequencer)` に戻す
  //   （sequencer.js の reconnect の isClosing は残っていても、stop が SKTERM を取り消すので warn で落ちる）
  const fake = setup()
  const dev = createDevice(fake, 'rv-busy')
  const b = createBroute(fake, 'rv-busy')
  await connected(dev)
  const old = dev.sequencer
  old.transport.config.latencyMs = 300 // SKTERM の応答（EVENT 27）を遅らせる
  const c = await input(b, { topic: 'config', payload: { deviceKey: 'other1' } })
  assert.equal(c.err, null, c.err && c.err.message)
  await waitFor(() => /SKTERM/.test(String(old.currentCommand() || '')), 3000, 'SKTERM の送信')
  assert.equal(dev.handle.reconfiguring, true)
  assert.equal(dev.handle.sequencer, old, '前提: handle.sequencer はまだ前のもの')
  for (const msg of [{ topic: 'reconnect' }, { topic: 'stop', payload: { reason: '試験' } }, { topic: 'status' }]) {
    const r = await input(b, msg)
    const e = errorOf(r)
    assert.ok(e, msg.topic + ' は error を出す')
    assert.equal(e.code, 'BUSY', msg.topic)
    assert.ok(r.err, msg.topic + ' は done(err)')
  }
  await waitFor(() => dev.sequencer && dev.sequencer !== old, 15000, '開き直し')
  const rows = dev.handle.logsAfter({ limit: 1000 }).items.map((l) => l.level + ' ' + l.text)
  assert.ok(!rows.some((t) => /終了時の SKTERM が通りませんでした/.test(t)), rows.filter((t) => /SKTERM/.test(t)).join(' | '))
  assert.equal(dev.sequencer.state.overrides.stopped, null, 'BUSY で断った stop は掛からない')
})

test('フローの credentials で別の認証 ID にしたら、開き直した直後の read に前の契約の値を出さず、プロパティマップも写さない', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: lib/runtime/registry.js の forgetSupported で _forgottenSeq を立てない（detach が前の値を写し直す）
  const fake = setup()
  const dev = createDevice(fake, 'rv-cred')
  const b = createBroute(fake, 'rv-cred')
  await connected(dev)
  const r0 = await input(b, { topic: 'get', payload: ['E7', 'E8', 'E0'] })
  assert.equal(r0.err, null)
  assert.ok(dev.handle.knownSupportedEpcs().length > 0, '前提: 前のメーターのマップを持っている')
  const old = dev.sequencer
  // メーターを居なくしておく（新しい sequencer はつながらない）
  const OTHER = 'FEDCBA9876543210FEDCBA9876543210'
  let atAttach = null
  const orig = dev.handle.attach.bind(dev.handle)
  dev.handle.attach = (seq) => {
    const out = orig(seq)
    if (seq !== old && !atAttach) {
      seq.transport.config.meterPresent = false
      atAttach = { supported: dev.handle.knownSupportedEpcs(), carried: dev.handle._carriedValues }
    }
    return out
  }
  const c = await input(b, { topic: 'credentials', payload: { routeBId: OTHER, routeBPassword: PW } })
  assert.equal(c.err, null, c.err && c.err.message)
  // 開き直しの最中（前の sequencer がまだ付いている）の read にも、前の契約の値を出さない
  const during = await input(b, { topic: 'read' })
  assert.deepEqual(Object.keys(during.sent[0][1].payload.values), [], '開き直しの最中も前の契約の値を出さない')
  await waitFor(() => atAttach !== null, 15000, '開き直し')
  assert.deepEqual(atAttach.supported, [], '前のメーターのプロパティマップは写さない')
  assert.equal(atAttach.carried, null, '前の契約の値の写しは作らない')
  const rd = await input(b, { topic: 'read' })
  const p = rd.sent[0][1].payload
  assert.deepEqual(Object.keys(p.values), [], '前の契約の値は出さない: ' + Object.keys(p.values).join(','))
  assert.ok(!p.values.serialNumber, '接続時だけ取る製造番号も')
  dev.handle.attach = orig
})

test('認証情報を変えない構成の変更（デバイスキー）なら、今までどおり前の値で答える（写しを捨てすぎない）', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: registry.js の detach で、忘れていない sequencer の値まで写さない
  const fake = setup()
  const dev = createDevice(fake, 'rv-keep')
  const b = createBroute(fake, 'rv-keep')
  await connected(dev)
  await input(b, { topic: 'get', payload: ['E7'] })
  const old = dev.sequencer
  const c = await input(b, { topic: 'config', payload: { deviceKey: 'other2' } })
  assert.equal(c.err, null)
  await waitFor(() => dev.sequencer && dev.sequencer !== old, 15000, '開き直し')
  dev.sequencer.transport.config.meterPresent = false
  const rd = await input(b, { topic: 'read', payload: ['E7'] })
  assert.ok(rd.sent[0][1].payload.values.instantPower, '同じ契約なら前の値を出す')
})

test('フローの command に改行・制御文字・ASCII 以外の文字を混ぜたら、預からずに VALIDATION。アダプタには何も書かない', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: nodes/wsuha-broute.js の forbiddenCommand の commandTextProblem を外す（先頭だけの検査に戻す）
  const fake = setup()
  const dev = createDevice(fake, 'rv-cmd')
  const b = createBroute(fake, 'rv-cmd')
  await connected(dev)
  const sentBefore = dev.sequencer.transport.sent.length
  for (const cmd of ['SKINFO\rWUART 03', 'SKINFO\nWOPT 01', 'SKINFOčSKSAVE']) {
    const r = await input(b, { topic: 'command', payload: cmd })
    const e = errorOf(r)
    assert.ok(e, JSON.stringify(cmd))
    assert.equal(e.code, 'VALIDATION', JSON.stringify(cmd))
    assert.ok(r.err)
    assert.ok(!out2(b, 'command-result').length, 'command-result は出さない（送っていない）')
  }
  // FLASH を消耗するものは FORBIDDEN_COMMAND（前は code なし）
  const w = await input(b, { topic: 'command', payload: 'WOPT 01' })
  assert.equal(errorOf(w).code, 'FORBIDDEN_COMMAND')
  await new Promise((r) => setTimeout(r, 50))
  const sent = dev.sequencer.transport.sent.slice(sentBefore)
  assert.ok(!sent.some((l) => /WUART|WOPT|SKSAVE/.test(l)), sent.join(' | '))
  // ふつうのコマンドは今までどおり
  const ok = await input(b, { topic: 'command', payload: 'SKVER' })
  assert.equal(ok.err, null, ok.err && ok.err.message)
})

test('フローの command の payload が文字列でないなら、送らずに VALIDATION（文字に変えてアダプタへ送らない）', { timeout: 30000 }, async () => {
  // {} や無しを String() で文字にすると、'[object Object]'・'undefined' が送られ、FAIL ER04 の DEVICE_ERROR に見える。
  // 戻すと落ちるもの: nodes/wsuha-broute.js の heldTopic の typeof cmd の確かめを外す
  const fake = setup()
  const dev = createDevice(fake, 'rv-cmdtype')
  const b = createBroute(fake, 'rv-cmdtype')
  await connected(dev)
  const sentBefore = dev.sequencer.transport.sent.length
  for (const msg of [
    { topic: 'command', payload: {} },
    { topic: 'command' },
    { topic: 'command', payload: 1793900000000 },
    { topic: 'command', payload: '   ' },
    { topic: 'command', payload: { command: 5 } },
    { topic: 'command', payload: { command: '' } },
    { topic: 'raw', payload: null },
  ]) {
    const r = await input(b, msg)
    const e = errorOf(r)
    assert.ok(e, JSON.stringify(msg))
    assert.equal(e.code, 'VALIDATION', JSON.stringify(msg))
    assert.match(e.message, /送るコマンドを文字列で指定してください/)
    assert.ok(e.details && e.details.command, JSON.stringify(msg))
    assert.ok(r.err, 'Catch ノードでも拾える')
  }
  assert.ok(!out2(b, 'command-result').length, 'command-result は出さない（送っていない）')
  await new Promise((r) => setTimeout(r, 50))
  // 周期の取得（SKSENDTO）は走り続けるので、入力の値が送られていないことだけを見る
  const sent = dev.sequencer.transport.sent.slice(sentBefore)
  assert.ok(!sent.some((l) => !/^SKSENDTO /.test(l)), sent.join(' | '))
  for (const msg of [{ topic: 'command', payload: 'SKVER' }, { topic: 'command', payload: { command: 'SKVER' } }, { payload: { action: 'command', command: 'SKVER' } }]) {
    const ok = await input(b, msg)
    assert.equal(ok.err, null, JSON.stringify(msg) + ' ' + (ok.err && ok.err.message))
  }
})

test('フローの reconnect の ladder は 0〜3 の整数だけ（外れたら VALIDATION・details.ladder）。止めた台への reconnect と poll は STOPPED_BY_OVERRIDE', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: nodes/wsuha-broute.js の ladderOf を通さない・止めた台の reconnect で STOPPED_BY_OVERRIDE を投げない
  const fake = setup()
  const dev = createDevice(fake, 'rv-lad')
  const b = createBroute(fake, 'rv-lad')
  await connected(dev)
  for (const ladder of [7, -1, 1.5, '2']) {
    const r = await input(b, { topic: 'reconnect', payload: { ladder } })
    const e = errorOf(r)
    assert.ok(e, JSON.stringify(ladder))
    assert.equal(e.code, 'VALIDATION')
    assert.ok(e.details && e.details.ladder, JSON.stringify(e))
    assert.ok(r.err)
  }
  assert.notEqual(dev.sequencer.state.ladder, 7, '7 は入らない')
  // 正しい段階は通る
  const ok = await input(b, { topic: 'reconnect', payload: { ladder: 0 } })
  assert.equal(ok.err, null, ok.err && ok.err.message)
  // 止める → reconnect は 409 STOPPED_BY_OVERRIDE（画面の API と同じ）
  const s = await input(b, { topic: 'stop', payload: { reason: '点検中' } })
  assert.equal(s.err, null)
  const rc = await input(b, { topic: 'reconnect' })
  const e2 = errorOf(rc)
  assert.ok(e2, '出力 2 に error')
  assert.equal(e2.code, 'STOPPED_BY_OVERRIDE')
  assert.match(e2.message, /点検中/)
  assert.ok(rc.err, 'done(err)')
  const pl = await input(b, { topic: 'poll' })
  assert.equal(errorOf(pl).code, 'STOPPED_BY_OVERRIDE', 'poll も')
  assert.ok(dev.sequencer.state.overrides.stopped, '止めたまま')
})

test('知らない topic は code の VALIDATION を付け、topic の選び方を文に書く', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: nodes/wsuha-broute.js の switch の default を throw new Error に戻す（mapError が読めず、code が付かない）
  const fake = setup()
  const dev = createDevice(fake, 'rv-nope')
  const b = createBroute(fake, 'rv-nope')
  await connected(dev)
  const r = await input(b, { topic: 'nope' })
  const e = errorOf(r)
  assert.ok(e, '出力 2 に error')
  assert.equal(e.code, 'VALIDATION')
  assert.match(e.message, /^対応していない指示です: nope。/)
  assert.match(e.message, /ヘルプ/, '次に何をするかを書く')
  assert.ok(r.err, 'done(err)')
})

test('設定ノードの pollEpcs の読めない要素（0E7・E7Z）は捨てて warn。取る EPC・画面の configValue・settings-reset のあとの値が同じ', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: nodes/wsuha-device.js の parseEpcList を parseInt(x, 16) に戻す（'0E7' を E7 と読む）
  const fake = setup()
  const dev = createDevice(fake, 'rv-epc', { pollEpcs: 'E8, 0E7, E7Z' })
  const b = createBroute(fake, 'rv-epc')
  assert.deepEqual(dev.sequencer.options.pollEpcs, [0xe8], '取る EPC')
  assert.ok(dev._warns.some((t) => /0E7・E7Z は EPC として読めないので外しました/.test(t)), dev._warns.join(' | '))
  const g = await input(b, { topic: 'get-settings' })
  const f = g.sent[0][1].payload.fields.pollEpcs
  assert.deepEqual(f.configValue, ['0xE8'], '画面の設定ノードの値: ' + JSON.stringify(f))
  // 運用設定を入れて外す → 設定ノードの値（E8 だけ）に戻る
  const s = await input(b, { topic: 'settings', payload: { pollEpcs: ['E7', 'E0'] } })
  assert.equal(s.err, null, s.err && s.err.message)
  const r = await input(b, { topic: 'settings-reset' })
  assert.equal(r.err, null)
  assert.deepEqual(dev.sequencer.options.pollEpcs, [0xe8], 'settings-reset のあと')
  // 読める要素だけなら、今までどおり（'0xE7' も 'e7' も）
  const dev2 = createDevice(fake, 'rv-epc2', { pollEpcs: '0xE7 e8' })
  assert.deepEqual(dev2.sequencer.options.pollEpcs, [0xe7, 0xe8])
})

test('SHARED_TOPICS に diag を入れない（diag は預かりの道 heldDiag）', () => {
  // 戻すと落ちるもの: SHARED_TOPICS に 'diag' を戻す
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-broute.js'), 'utf8')
  const m = src.match(/const SHARED_TOPICS = \[([\s\S]*?)\]/)
  assert.ok(m)
  assert.ok(!/'diag'/.test(m[1]), m[1])
})

test('B ルートノードの状態の文: アダプタを選んでいないときは「アダプタ未設定」、選んだ設定ノードが無い（無効・削除）ときは「アダプタが無効か、見つかりません」', () => {
  // 戻すと落ちるもの: nodes/wsuha-broute.js の状態の文を「USB 未設定」に戻す
  const fake = setup()
  const none = fake.create('wsuha-broute', { id: 'rv-st-1', device: '' })
  assert.equal(none._statuses[none._statuses.length - 1].text, 'アダプタ未設定')
  const gone = fake.create('wsuha-broute', { id: 'rv-st-2', device: 'no-such-device' })
  assert.equal(gone._statuses[gone._statuses.length - 1].text, 'アダプタが無効か、見つかりません')
})
