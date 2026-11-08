'use strict'

// シミュレーターは、接続先を選んでデプロイするだけで動く（認証情報も pairId の指定も要らない）。
// 架空の値は最後の手段で、手がかり（環境変数・保存した値・設定ノードの値・秘密ファイル）があれば使わない。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createKit, connected, input } = require('./node-kit')
const { waitFor, ID, PW } = require('../runtime/fake-red')

const kit = createKit()
const B = '/wsuha-broute/api/v1'
const FAKE_SOURCE = 'シミュレーターの架空の値'
/** 試験の時間を詰めるだけの模擬設定。pairId は渡さない（一般の利用者も渡さない）。 */
const QUICK = JSON.stringify({ latencyMs: 1, joinMs: 10, scanTimeScale: 0.005, echonetDelayMs: 5 })

afterEach(() => kit.cleanup())

/** 認証情報も pairId も渡さない設定ノード。 */
function bare(id, extra) {
  const c = kit.devConfig(id, Object.assign({ simulatorOptions: QUICK }, extra))
  if (!extra || !extra._credentials) delete c._credentials
  return c
}

function create(fake, id, extra) {
  const dev = fake.create('wsuha-device', bare(id, extra))
  if (dev.sequencer) kit.speedUp(dev.sequencer)
  kit.open.push([fake, dev])
  return dev
}

async function settled(dev) {
  await waitFor(() => !dev.handle.reconfiguring, 15000, '開き直しの終わり')
}

/** 開き直しのあとも待ち時間を詰める。 */
function keepQuick(dev) {
  const orig = dev._build
  dev._build = function () {
    const had = dev.sequencer
    const r = orig.call(dev)
    if (dev.sequencer && dev.sequencer !== had) kit.speedUp(dev.sequencer)
    return r
  }
}

test('認証情報が何も無いシミュレーターは、架空の値で動く。出どころは「シミュレーターの架空の値」', async () => {
  // 戻すと落ちるもの: wsuha-device.js の resolveCredentials の最後の手段を外す（health が「認証情報がありません」で止まる）
  const fake = kit.setup()
  const dev = create(fake, 'sim-bare')
  assert.equal(dev.handle.credentialSource, FAKE_SOURCE)
  await connected(dev)
  const d = (await fake.request('GET', `${B}/adapters/sim-bare`)).body
  assert.equal(d.credentials.configured, true)
  assert.equal(d.credentials.source, FAKE_SOURCE)
  assert.equal(d.health.title === '認証情報がありません', false)
  assert.ok(!(dev._warns || []).some((w) => /未設定です/.test(w)), (dev._warns || []).join(' / '))
})

test('架空の値は最後の手段: 環境変数・設定ノード・秘密ファイル・保存した値があれば、そちらが効く', async () => {
  // 戻すと落ちるもの: 最後の手段を resolveCredentials の先のほう（秘密ファイルを探す前）に置く
  const fake = kit.setup()
  const OTHER = 'FEDCBA9876543210FEDCBA9876543210'
  const OTHER_PW = 'ZYXWVU987654'

  const editor = create(fake, 'sim-ed', { _credentials: { routeBId: OTHER, routeBPassword: OTHER_PW } })
  assert.equal(editor.handle.credentialSource, '設定ノード')

  fs.writeFileSync(path.join(fake.settings.userDir, 'wsuha-broute-simfile.secret.json'), JSON.stringify({ simfile: { id: OTHER, password: OTHER_PW } }))
  const file = create(fake, 'sim-file', { deviceKey: 'simfile' })
  assert.equal(file.handle.credentialSource, 'ファイル（wsuha-broute-simfile.secret.json）')

  process.env.WSUHA_BROUTE_ID_SIMENV = OTHER
  process.env.WSUHA_BROUTE_PASSWORD_SIMENV = OTHER_PW
  try {
    assert.equal(create(fake, 'sim-env', { deviceKey: 'simenv' }).handle.credentialSource, '環境変数')
  } finally {
    delete process.env.WSUHA_BROUTE_ID_SIMENV
    delete process.env.WSUHA_BROUTE_PASSWORD_SIMENV
  }
})

test('保存した値を入れると、その ID で動く。消すと架空の値に戻って、またつながる', async () => {
  // 戻すと落ちるもの: _reconfigure の resolveNow が効いている接続先を見ない
  const fake = kit.setup()
  const OTHER = 'FEDCBA9876543210FEDCBA9876543210'
  const dev = create(fake, 'sim-stored')
  kit.createBroute(fake, 'sim-stored')
  keepQuick(dev)
  await connected(dev)
  const put = await fake.request('PUT', `${B}/adapters/sim-stored/credentials`, { body: { routeBId: OTHER, routeBPassword: 'ZYXWVU987654' } })
  assert.equal(put.statusCode, 200)
  await settled(dev)
  await connected(dev)
  assert.equal(dev.handle.credentialSource, '画面かフローで保存した値')
  assert.equal(dev.sequencer.credentials.id, OTHER)
  assert.equal((await fake.request('DELETE', `${B}/adapters/sim-stored/credentials`)).statusCode, 200)
  await settled(dev)
  await connected(dev)
  assert.equal(dev.handle.credentialSource, FAKE_SOURCE)
  assert.equal(dev.sequencer.credentials.id, ID)
})

test('実機の台には架空の値を使わない', () => {
  // 戻すと落ちるもの: 接続先を見ずに架空の値を返す（実機のメーターへ架空の ID で認証しに行く）
  const fake = kit.setup()
  const dev = create(fake, 'sim-serial', { mode: 'serial', serialport: '/dev/ttyFAKE9', enabled: false })
  assert.match(dev.handle.credentialSource, /^見つかりません → /)
  assert.equal(dev.handle.credentialState.configured, false)
})

test('入れかけの値があるときは架空の値にしない（入れ間違いに気づけるように）', () => {
  // 戻すと落ちるもの: resolveCredentials の untouched の条件から入れかけの判定を外す
  const fake = kit.setup()
  const idOnly = create(fake, 'sim-id', { _credentials: { routeBId: ID } })
  assert.match(idOnly.handle.credentialSource, /設定ノード: ID だけ/)
  const pwOnly = create(fake, 'sim-pw', { _credentials: { routeBPassword: PW } })
  assert.match(pwOnly.handle.credentialSource, /設定ノード: パスワードだけ/)
  process.env.WSUHA_BROUTE_ID_SIMHALF = ID
  try {
    const envHalf = create(fake, 'sim-envhalf', { deviceKey: 'simhalf' })
    assert.match(envHalf.handle.credentialSource, /環境変数（[^）]*）: ID だけ/)
  } finally {
    delete process.env.WSUHA_BROUTE_ID_SIMHALF
  }
})

test('読めない秘密ファイルがあるときも架空の値にしない（理由を出す）', () => {
  // 戻すと落ちるもの: resolveCredentials の untouched の条件から worst を外す
  const fake = kit.setup()
  fs.writeFileSync(path.join(fake.settings.userDir, 'wsuha-broute-simbroken.secret.json'), 'id: 値ではない')
  const dev = create(fake, 'sim-broken', { deviceKey: 'simbroken' })
  assert.match(dev.handle.credentialSource, /ファイル（wsuha-broute-simbroken\.secret\.json）: 形式が正しくありません/)
})

test('接続先を変えると、架空の値の扱いも変わる（シミュレーター → 実機で外れ、実機 → シミュレーターで入る）', async () => {
  // 戻すと落ちるもの: resolveCredentials が設定ノードを作ったときの接続先だけを見る
  const fake = kit.setup()
  const dev = create(fake, 'sim-mode')
  keepQuick(dev)
  await connected(dev)
  const cfg = async (body) => {
    const rev = (await fake.request('GET', `${B}/adapters/sim-mode/config`)).body.rev
    const r = await fake.request('PUT', `${B}/adapters/sim-mode/config`, { body, headers: { 'if-match': rev } })
    assert.equal(r.statusCode, 200, r.text)
    await settled(dev)
  }
  await cfg({ mode: 'serial', serialport: '/dev/ttyFAKE9' })
  assert.match(dev.handle.credentialSource, /^見つかりません → /)
  await cfg({ mode: 'simulator' })
  assert.equal(dev.handle.credentialSource, FAKE_SOURCE)
})

test('見つからないときの文: デバイスキーが空の台は環境変数の名前を 1 度だけ出し、ある台は 2 つとも出す', () => {
  // 例のフローの既定はデバイスキーが空で、初めての人が最初に見る文。
  // 戻すと落ちるもの: wsuha-device.js の tried を suffix の有無で分けない（WSUHA_BROUTE_ID / WSUHA_BROUTE_ID になる）
  const fake = kit.setup()
  const none = create(fake, 'sim-nokey', { mode: 'serial', serialport: '/dev/ttyFAKE8', deviceKey: '' })
  assert.match(none.handle.credentialSource, /環境変数（WSUHA_BROUTE_ID）: 未設定/)
  assert.ok(!/WSUHA_BROUTE_ID \/ WSUHA_BROUTE_ID/.test(none.handle.credentialSource), none.handle.credentialSource)
  const keyed = create(fake, 'sim-keyed', { mode: 'serial', serialport: '/dev/ttyFAKE7', deviceKey: 'usb0' })
  assert.match(keyed.handle.credentialSource, /環境変数（WSUHA_BROUTE_ID_USB0 \/ WSUHA_BROUTE_ID）: 未設定/)
})

/** 同じ認証 ID のシミュレーターの台を作り、瞬時電力を 1 回取る。 */
async function measured(fake, id) {
  const dev = create(fake, id, { _credentials: { routeBId: ID, routeBPassword: PW } })
  keepQuick(dev)
  const b = kit.createBroute(fake, id)
  await connected(dev)
  assert.equal((await input(b, { topic: 'get', payload: 'E7' })).err, null)
  return { dev, b }
}

/** read の値（EPC を 1 つ指定した返事の payload）。 */
async function readE7(b) {
  const r = await input(b, { topic: 'read', payload: 'E7' })
  assert.equal(r.err, null, r.err && r.err.message)
  return r.sent[0][1].payload
}

test('同じ認証 ID のまま接続先を実機へ変えたら、シミュレーターの値を read に出さない（フローの config）', { timeout: 30000 }, async () => {
  // 実機が値を返すまで、架空の計測値を本物として下流へ流さないため。
  // 戻すと落ちるもの: wsuha-device.js の _reconfigure の forgetSupported の条件から mode を外す
  const fake = kit.setup()
  const { dev, b } = await measured(fake, 'sim-real')
  assert.ok((await readE7(b)).values.instantPower, '前提: シミュレーターの値がある')
  const c = await input(b, { topic: 'config', payload: { mode: 'serial', serialport: '/dev/ttyFAKE2' } }, 15000)
  assert.equal(c.err, null, c.err && c.err.message)
  const during = await readE7(b)
  assert.deepEqual(Object.keys(during.values), [], '開き直しの最中も出さない')
  await settled(dev)
  const after = await readE7(b)
  assert.deepEqual(Object.keys(after.values), [])
  assert.deepEqual(after.missing, ['E7'])
})

test('同じ認証 ID のまま接続先を変えてデプロイしても、シミュレーターの値を read に出さない（エディタの設定ノード）', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: wsuha-device.js の modeChanged の forgetSupported を外す（detach が値を写したまま残る）
  const fake = kit.setup()
  const { dev, b } = await measured(fake, 'sim-deploy')
  await fake.close(b, false)
  await fake.close(dev, false)
  const dev2 = create(fake, 'sim-deploy', { mode: 'serial', serialport: '/dev/ttyFAKE3', _credentials: { routeBId: ID, routeBPassword: PW } })
  const b2 = kit.createBroute(fake, 'sim-deploy')
  assert.equal(dev2.eff.mode, 'serial')
  assert.deepEqual(Object.keys((await readE7(b2)).values), [])
})

test('接続先を変えないデプロイは、作り直す前の値で read に答える（写しを捨てすぎない）', { timeout: 30000 }, async () => {
  // 戻すと落ちるもの: modeChanged の判定をやめて、デプロイのたびに forgetSupported を呼ぶ
  const fake = kit.setup()
  const { dev, b } = await measured(fake, 'sim-keep')
  await fake.close(b, false)
  await fake.close(dev, false)
  const dev2 = create(fake, 'sim-keep', { _credentials: { routeBId: ID, routeBPassword: PW } })
  const b2 = kit.createBroute(fake, 'sim-keep')
  assert.equal(dev2.eff.mode, 'simulator')
  assert.ok((await readE7(b2)).values.instantPower, '前の値が残る')
})

test('模擬設定を読めないときは既定の動きで続け、Node-RED のログに 1 回だけ知らせる', { timeout: 30000 }, async () => {
  // 閉じ括弧を忘れると、エラーも warn も無いまま既定のシミュレーターが動いていた。
  // 戻すと落ちるもの: wsuha-device.js の simulatorOptionsOf の warn を外す・_simulatorOptionsWarned を見ない（開き直すたびに出る）
  const fake = kit.setup()
  const text = /模擬設定を JSON のオブジェクトとして読めないので、シミュレーターは既定の動きをします/
  const warned = (d) => (d._warns || []).filter((w) => text.test(w)).length
  const bad = create(fake, 'sim-badopt', { simulatorOptions: '{"meter":{"power":1200}' })
  await waitFor(() => !bad._opening, 5000, '開く処理の終わり')
  assert.equal(warned(bad), 1)
  assert.ok(bad.sequencer, '計測は止めない')
  assert.equal(bad.sequencer.transport.config.meter.power, 436, '既定の動き')
  await bad._close()
  assert.equal(bad._build(), true)
  assert.equal(warned(bad), 1, '開き直しても繰り返さない')
  for (const [id, raw] of [['sim-arr', '[1]'], ['sim-num', '5']]) {
    const d = create(fake, id, { simulatorOptions: raw })
    assert.equal(warned(d), 1, raw)
  }
})

test('模擬設定が空か、正しい JSON のときは知らせない。実機の台は読まないので知らせない', () => {
  // 戻すと落ちるもの: simulatorOptionsOf の空の確かめを外す（parseJson は空でも null を返す）・_build の外で読む
  const fake = kit.setup()
  const noise = (d) => (d._warns || []).filter((w) => /模擬設定/.test(w))
  for (const [id, raw] of [['sim-empty', ''], ['sim-blank', ' '], ['sim-none', undefined], ['sim-good', QUICK]]) {
    assert.deepEqual(noise(create(fake, id, { simulatorOptions: raw })), [], String(raw))
  }
  assert.deepEqual(noise(create(fake, 'sim-obj', { simulatorOptions: { latencyMs: 1 } })), [], 'オブジェクトのままでも読める')
  assert.deepEqual(noise(create(fake, 'sim-serial', { mode: 'serial', serialport: '/dev/ttyFAKE6', simulatorOptions: '{"x"' })), [])
})
