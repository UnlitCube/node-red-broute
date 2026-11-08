'use strict'

// B ルート認証情報は、管理画面（とフローの入力）とエディタの設定ノードのプロパティの、どちらからでも設定でき、後から入れた方が効く。
//
//  - 画面かフローで保存するとき、そのときのエディタの値の指紋（塩つきの sha256。値そのものは持たない）を credAtSet として
//    credentials/<id>.json に残す。設定ノードを作るたびに比べ、違えば画面の値を外してエディタの値を使う
//    （ログに 1 行・出力 2 の config（changedBy 'editor'）。値は出さない）
//  - 組み合わせ: 画面 → エディタで変更 → エディタ / エディタ → 画面で保存 → 画面 / 同じ値のまま作り直し → 画面のまま /
//    エディタが空のまま画面で保存 → エディタで入れる → エディタ / 環境変数があれば環境変数
//  - どの経路でも、値が応答・ログ・出力・settings.json に出ない。credentials/*.json にはエディタの値を書かない（指紋だけ）
//
// 値は架空のもの（ID・PW と、それを逆さにしたもの）だけ。
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { ID, PW } = require('../runtime/fake-red')
const { createKit, input, out2 } = require('./node-kit')

const kit = createKit()
const { setup, createDevice, createBroute } = kit
const B = '/wsuha-broute/api/v1'
// 架空の値をもう 1 組（逆さにしたもの）。エディタと画面で違う値を入れるため
const ID2 = ID.split('').reverse().join('')
const PW2 = PW.split('').reverse().join('')

afterEach(() => kit.cleanup())

function credFile(fake, id) {
  return path.join(fake.settings.userDir, 'wsuha-broute', 'credentials', id + '.json')
}

async function putCred(fake, id, routeBId, routeBPassword) {
  const r = await fake.request('PUT', `${B}/adapters/${id}/credentials`, { body: { routeBId, routeBPassword } })
  assert.equal(r.statusCode, 200, r.text)
  return r
}

async function settled(dev) {
  const { waitFor } = require('../runtime/fake-red')
  await waitFor(() => !dev.handle.reconfiguring, 15000, '開き直しの終わり')
}

/** デプロイと同じ: 使っているノード → 設定ノードの順に閉じて、同じ id で作り直す。 */
async function redeploy(fake, dev, b, devExtra) {
  await fake.close(b, false)
  await fake.close(dev, false)
  const d2 = createDevice(fake, dev.id, devExtra)
  const b2 = createBroute(fake, dev.id)
  fake.events.emit('flows:started', { type: 'full' })
  return { dev: d2, b: b2 }
}

test('credentials/<id>.json の指紋は credAtSet。値から戻せない形（塩つき・ファイルごとに違う）で、エディタの値は書かない', async () => {
  // 戻すと落ちるもの: credentials-store.js の write で credAtSet を書かない（前の回の editorAtSet のまま）・塩を付けない
  const fake = setup()
  const dev = createDevice(fake, 'cl-fp', { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  createBroute(fake, 'cl-fp')
  await putCred(fake, 'cl-fp', ID, PW)
  await settled(dev)
  const text = fs.readFileSync(credFile(fake, 'cl-fp'), 'utf8')
  const rec = JSON.parse(text)
  assert.match(rec.credAtSet, /^[0-9a-f]{64}$/, '指紋は sha256 の 16 進')
  assert.equal(rec.editorAtSet, undefined, '前の回の名前では書かない')
  assert.ok(!text.includes(ID2) && !text.includes(PW2) && !text.includes(ID2.toLowerCase()), 'エディタの値は書かない（指紋だけ）')
  const unsalted = crypto.createHash('sha256').update(ID2 + '\n' + PW2).digest('hex')
  assert.notEqual(rec.credAtSet, unsalted, '塩の無い sha256 ではない')
  assert.notEqual(rec.credAtSet, crypto.createHash('sha256').update('\n' + ID2 + '\n' + PW2).digest('hex'))
  // 同じエディタの値でも、保存し直すと塩が変わる（ファイルを並べても同じ値か分からない）
  await putCred(fake, 'cl-fp', ID, PW)
  await settled(dev)
  const rec2 = JSON.parse(fs.readFileSync(credFile(fake, 'cl-fp'), 'utf8'))
  assert.notEqual(rec2.salt, rec.salt)
  assert.notEqual(rec2.credAtSet, rec.credAtSet)
})

test('前の回の editorAtSet で書いたファイルも読める（照合に使う）', async () => {
  // 戻すと落ちるもの: read で editorAtSet を読まない（前に保存した値が照合されず、エディタで入れ直しても外れない）
  const { createCredentialsStore, fingerprint } = require('../../lib/runtime/credentials-store')
  const { tmpDir } = require('../runtime/fake-red')
  const dir = tmpDir('wsuha-cred-old-')
  const salt = 'ab'.repeat(16)
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ version: 1, id: ID, password: PW, by: 'web-ui', at: 1, salt, editorAtSet: fingerprint(salt, ID2, PW2) }))
  const store = createCredentialsStore({ dir })
  assert.equal(store.reconcile('old', ID2, PW2), false, '同じエディタの値なら外さない')
  assert.equal(store.reconcile('old', ID2, 'ZZZZZZZZZZZZ'), true, '違えば外す')
})

test('画面 → エディタで変更 → エディタが効く。ログに 1 行・出力 2 の config（changedBy editor）。値はどこにも出ない', async () => {
  // 戻すと落ちるもの: wsuha-device.js で credStore.reconcile を呼ばない・configChanged を出さない
  const fake = setup()
  const dev = createDevice(fake, 'cl-ui-ed', { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  const b = createBroute(fake, 'cl-ui-ed')
  await putCred(fake, 'cl-ui-ed', ID, PW)
  await settled(dev)
  assert.equal(dev.handle.credentialSource, '画面かフローで保存した値')
  // エディタで別の値を入れてデプロイ（パスワードだけ変えた）
  const PW3 = 'ZYXWVU000000'
  const x = await redeploy(fake, dev, b, { _credentials: { routeBId: ID2, routeBPassword: PW3 } })
  assert.equal(x.dev.handle.credentialSource, '設定ノード', 'エディタの値が効く')
  assert.equal(x.dev.sequencer.credentials.password, PW3)
  assert.ok(!fs.existsSync(credFile(fake, 'cl-ui-ed')), '画面の値は外した')
  const warns = fake.logs.filter(([l, t]) => l === 'warn' && /認証情報を入れ直したため/.test(t))
  assert.equal(warns.length, 1, 'Node-RED のログに 1 行')
  const rows = x.dev.handle.logsAfter({ limit: 1000 }).items.filter((r) => /認証情報を入れ直したため/.test(r.text))
  assert.equal(rows.length, 1, 'アダプタのログに 1 行')
  const notes = out2(x.b, 'config').filter((m) => m.changedBy === 'editor')
  assert.equal(notes.length, 1, 'デプロイのあと出力 2 に config（changedBy editor）が 1 通')
  assert.equal(notes[0].payload.credentials.source, '設定ノード')
  assert.equal(notes[0].payload.credentials.stored, null)
  assertNoValues(fake, [b, x.b], [ID, PW, ID2, PW3])
})

test('エディタ → 画面で保存 → 画面が効く。同じ値のまま作り直しても画面のまま', async () => {
  // 戻すと落ちるもの: resolveCredentials で設定ノードを画面の値より先にする・reconcile が同じ指紋でも外す
  const fake = setup()
  const dev = createDevice(fake, 'cl-ed-ui', { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  const b = createBroute(fake, 'cl-ed-ui')
  assert.equal(dev.handle.credentialSource, '設定ノード')
  await putCred(fake, 'cl-ed-ui', ID, PW)
  await settled(dev)
  assert.equal(dev.handle.credentialSource, '画面かフローで保存した値', '後から入れた画面の値が効く')
  assert.equal(dev.sequencer.credentials.id, ID)
  // 関係の無いデプロイ（エディタの認証情報はそのまま）
  const x = await redeploy(fake, dev, b, { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  assert.equal(x.dev.handle.credentialSource, '画面かフローで保存した値', '同じ値のまま作り直しても画面のまま')
  assert.equal(x.dev.sequencer.credentials.id, ID)
  assert.ok(fs.existsSync(credFile(fake, 'cl-ed-ui')))
  assert.equal(out2(x.b, 'config').filter((m) => m.changedBy === 'editor').length, 0, '外していないので知らせない')
  assert.ok(!fake.logs.some(([, t]) => /認証情報を入れ直したため/.test(t)))
  // 大文字小文字だけ違う値で入れ直しても同じ値（指紋は大文字にそろえてから）
  const y = await redeploy(fake, x.dev, x.b, { _credentials: { routeBId: ID2.toLowerCase(), routeBPassword: PW2.toLowerCase() } })
  assert.equal(y.dev.handle.credentialSource, '画面かフローで保存した値')
  assertNoValues(fake, [b, x.b, y.b], [ID, PW, ID2, PW2])
})

test('エディタが空のまま画面で保存 → エディタで入れる → エディタが効く', async () => {
  // 戻すと落ちるもの: credentials-store.js の fingerprint で空を 'none' にしない（空同士の比べ方が変わる）・reconcile で 'none' を飛ばす
  const fake = setup()
  const dev = createDevice(fake, 'cl-empty', { _credentials: {} })
  const b = createBroute(fake, 'cl-empty')
  await putCred(fake, 'cl-empty', ID, PW)
  await settled(dev)
  assert.equal(dev.handle.credentialSource, '画面かフローで保存した値')
  // 空のまま作り直し → 画面のまま
  const x = await redeploy(fake, dev, b, { _credentials: {} })
  assert.equal(x.dev.handle.credentialSource, '画面かフローで保存した値')
  // エディタで入れた → エディタが効く
  const y = await redeploy(fake, x.dev, x.b, { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  assert.equal(y.dev.handle.credentialSource, '設定ノード')
  assert.equal(y.dev.sequencer.credentials.id, ID2)
  assert.equal(out2(y.b, 'config').filter((m) => m.changedBy === 'editor').length, 1)
  assertNoValues(fake, [b, x.b, y.b], [ID, PW, ID2, PW2])
})

test('環境変数があれば、画面とエディタのどちらで入れても環境変数が効く（画面の値は残し、エディタで入れ直せば外れる）', async () => {
  // 戻すと落ちるもの: resolveCredentials で環境変数を最初に見ない
  const fake = setup()
  process.env.WSUHA_BROUTE_ID_KITCLENV = ID2
  process.env.WSUHA_BROUTE_PASSWORD_KITCLENV = PW2
  try {
    const dev = createDevice(fake, 'cl-env', { deviceKey: 'kitclenv', _credentials: { routeBId: ID, routeBPassword: PW } })
    const b = createBroute(fake, 'cl-env')
    assert.equal(dev.handle.credentialSource, '環境変数')
    await putCred(fake, 'cl-env', ID, PW)
    await settled(dev)
    assert.equal(dev.handle.credentialSource, '環境変数', '画面で保存しても環境変数')
    const c = (await fake.request('GET', `${B}/adapters/cl-env/config`)).body
    assert.equal(c.credentials.envOverrides, true)
    assert.ok(c.credentials.stored, '画面の値は残っている')
    const x = await redeploy(fake, dev, b, { deviceKey: 'kitclenv', _credentials: { routeBId: ID, routeBPassword: 'ABCDEF000000' } })
    assert.equal(x.dev.handle.credentialSource, '環境変数', 'エディタで入れ直しても環境変数')
    assert.ok(!fs.existsSync(credFile(fake, 'cl-env')), 'エディタで入れ直したので画面の値は外れた（後勝ち）')
    assertNoValues(fake, [b, x.b], [ID, PW, ID2, PW2, 'ABCDEF000000'])
  } finally {
    delete process.env.WSUHA_BROUTE_ID_KITCLENV
    delete process.env.WSUHA_BROUTE_PASSWORD_KITCLENV
  }
})

test('フローの入力 credentials で保存しても同じ規則（エディタで入れ直せば外れる）。返事・出力・ログに値は出ない', async () => {
  const fake = setup()
  const dev = createDevice(fake, 'cl-flow', { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  const b = createBroute(fake, 'cl-flow', { name: '鍵' })
  const r = await input(b, { topic: 'credentials', payload: { routeBId: ID, routeBPassword: PW } })
  assert.equal(r.err, null)
  assert.equal(r.sent[0][1].payload.stored.by, 'flow:鍵')
  await settled(dev)
  assert.match(JSON.parse(fs.readFileSync(credFile(fake, 'cl-flow'), 'utf8')).credAtSet, /^[0-9a-f]{64}$/)
  const x = await redeploy(fake, dev, b, { _credentials: { routeBId: ID2, routeBPassword: 'ZYXWVU000001' } })
  assert.equal(x.dev.handle.credentialSource, '設定ノード')
  assertNoValues(fake, [b, x.b], [ID, PW, ID2, 'ZYXWVU000001'])
})

/**
 * 値（大文字と小文字）が、出力 2・Node-RED のログ・アダプタのログ・settings.json・画面の API（config・detail・logs・SSE 以外の GET）に出ないこと。
 * credentials/*.json は画面かフローで保存した値を平文で持つので、ここでは見ない（エディタの値は別の試験で見る）。
 */
function assertNoValues(fake, nodes, values) {
  const list = []
  for (const v of values) list.push(v, v.toLowerCase())
  const outputs = JSON.stringify(nodes.map((n) => n._sent))
  const logs = JSON.stringify(fake.logs)
  const handleLogs = JSON.stringify(nodes.map((n) => n.device && n.device.handle ? n.device.handle.logsAfter({ limit: 1000 }).items : []))
  const settingsFile = path.join(fake.settings.userDir, 'wsuha-broute', 'settings.json')
  const settings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : ''
  for (const [what, text] of [['出力', outputs], ['Node-RED のログ', logs], ['アダプタのログ', handleLogs], ['settings.json', settings]]) {
    for (const v of list) assert.ok(!text.includes(v), `${what} に値（${v.slice(0, 4)}…）が出ている`)
  }
}

// ---------------------------------------------------------------------------
//  空にしたデプロイ・ログの文・壊れた秘密ファイル
// ---------------------------------------------------------------------------

test('エディタの認証情報を空にしてデプロイしても、画面かフローで保存した値は消さない（空にするのは入れ直しに数えない）。そのあとエディタで入れたらエディタが効く', async () => {
  // 戻すと落ちるもの: credentials-store.js の reconcile で、今のエディタの指紋が 'none'（空）でもファイルを消す
  const fake = setup()
  const dev = createDevice(fake, 'cl-clear', { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  const b = createBroute(fake, 'cl-clear')
  await putCred(fake, 'cl-clear', ID, PW)
  await settled(dev)
  assert.equal(dev.handle.credentialSource, '画面かフローで保存した値')
  // 平文を flows_cred.json から消すつもりで、エディタの欄を空にしてデプロイした（鍵を失って Node-RED が空で始めたときも同じ）
  const x = await redeploy(fake, dev, b, { _credentials: {} })
  assert.ok(fs.existsSync(credFile(fake, 'cl-clear')), '画面の値は残す')
  assert.equal(x.dev.handle.credentialSource, '画面かフローで保存した値', '画面の値で動き続ける')
  assert.equal(x.dev.sequencer.credentials.id, ID)
  assert.equal(x.dev.handle.credentialState.configured, true)
  assert.ok(!fake.logs.some(([, t]) => /入れ直したため/.test(t)), '入れ直したとは書かない')
  assert.equal(out2(x.b, 'config').filter((m) => m.changedBy === 'editor').length, 0, '外していないので知らせない')
  assert.equal(JSON.parse(fs.readFileSync(credFile(fake, 'cl-clear'), 'utf8')).credAtSet, 'none', '控えの指紋を「空」にした')
  // 空のまま作り直しても画面のまま
  const y = await redeploy(fake, x.dev, x.b, { _credentials: {} })
  assert.equal(y.dev.handle.credentialSource, '画面かフローで保存した値')
  // あとでエディタに値を入れたら、今までどおりエディタが勝つ（前と同じ値でも、空にしたあとに入れたので「後から入れた」）
  const z = await redeploy(fake, y.dev, y.b, { _credentials: { routeBId: ID2, routeBPassword: PW2 } })
  assert.equal(z.dev.handle.credentialSource, '設定ノード')
  assert.equal(z.dev.sequencer.credentials.id, ID2)
  assert.ok(!fs.existsSync(credFile(fake, 'cl-clear')))
  const warns = fake.logs.filter(([l, t]) => l === 'warn' && /入れ直したため/.test(t))
  assert.equal(warns.length, 1)
  assert.match(warns[0][1], /いま効いているのは設定ノードの値です/)
  assertNoValues(fake, [b, x.b, y.b, z.b], [ID, PW, ID2, PW2])
})

test('画面の値を外したときのログは、実際に効く出どころを書く（環境変数が優先されていれば「設定ノードの値を使います」と書かない）。DELETE も同じ', async () => {
  // ログの文。戻すと落ちるもの: wsuha-device.js の照合のログと service.js の clearCredentials のログを、
  // 出どころに関係なく「設定ノードの値を使います」「設定ノードの値に戻します」にする
  const fake = setup()
  process.env.WSUHA_BROUTE_ID_KITCLENV2 = ID2
  process.env.WSUHA_BROUTE_PASSWORD_KITCLENV2 = PW2
  try {
    const dev = createDevice(fake, 'cl-env2', { deviceKey: 'kitclenv2', _credentials: { routeBId: ID, routeBPassword: PW } })
    const b = createBroute(fake, 'cl-env2')
    await putCred(fake, 'cl-env2', ID, PW)
    await settled(dev)
    // エディタで入れ直した → 画面の値は外れるが、効くのは環境変数
    const x = await redeploy(fake, dev, b, { deviceKey: 'kitclenv2', _credentials: { routeBId: ID, routeBPassword: 'ABCDEF000000' } })
    assert.equal(x.dev.handle.credentialSource, '環境変数')
    const w = fake.logs.filter(([l, t]) => l === 'warn' && /入れ直したため/.test(t))
    assert.equal(w.length, 1)
    assert.match(w[0][1], /環境変数/)
    assert.doesNotMatch(w[0][1], /設定ノードの値を使います/)
    // 画面で保存し直してから DELETE（画面の「消す」）: 環境変数が効いたまま
    await putCred(fake, 'cl-env2', ID, PW)
    await settled(x.dev)
    const del = await fake.request('DELETE', B + '/adapters/cl-env2/credentials')
    assert.equal(del.statusCode, 200, del.text)
    await settled(x.dev)
    const rows = x.dev.handle.logsAfter({ limit: 1000 }).items.filter((r) => /B ルートの認証 ID とパスワードを消しました/.test(r.text))
    assert.equal(rows.length, 1)
    assert.match(rows[0].text, /環境変数/)
    assert.doesNotMatch(rows[0].text, /設定ノードの値に戻します/)
    assertNoValues(fake, [b, x.b], [ID, PW, ID2, PW2, 'ABCDEF000000'])
  } finally {
    delete process.env.WSUHA_BROUTE_ID_KITCLENV2
    delete process.env.WSUHA_BROUTE_PASSWORD_KITCLENV2
  }
  // 環境変数もエディタの値も無いときの DELETE は、「設定ノードの値に戻します」と書かない
  const dev2 = createDevice(fake, 'cl-none', { _credentials: {} })
  createBroute(fake, 'cl-none')
  await putCred(fake, 'cl-none', ID, PW)
  await settled(dev2)
  assert.equal((await fake.request('DELETE', B + '/adapters/cl-none/credentials')).statusCode, 200)
  await settled(dev2)
  const row = dev2.handle.logsAfter({ limit: 1000 }).items.filter((r) => /B ルートの認証 ID とパスワードを消しました/.test(r.text))
  assert.equal(row.length, 1)
  assert.doesNotMatch(row[0].text, /設定ノードの値に戻します/)
  assert.match(row[0].text, /設定ノードの値も空/)
})

test('秘密ファイル（wsuha-broute-<キー>.secret.json）の JSON が壊れていても、JSON.parse の文（入力の断片 = 値）をログに出さない', async () => {
  // 戻すと落ちるもの: wsuha-device.js の resolveCredentials で、読めなかった理由に err.message を入れる
  // （Node 20 以上の JSON.parse の文は入力の断片を引用する。Node 18 でも、理由が「JSON として読めません」でないので落ちる）
  const fake = setup()
  // 架空の値。password の引用符を欠いた壊れた JSON
  const broken = '{"kitclsecret":{"id":"' + ID + '","password":' + PW + '}}'
  fs.writeFileSync(path.join(fake.settings.userDir, 'wsuha-broute-kitclsecret.secret.json'), broken)
  createDevice(fake, 'cl-secret', { _credentials: {} })
  const lines = fake.logs.filter(([, t]) => /secret\.json/.test(t))
  assert.ok(lines.length >= 1, '読めなかったことは Node-RED のログに出す')
  assert.ok(lines.some(([, t]) => /JSON として読めません/.test(t)), '理由は分類だけ: ' + JSON.stringify(lines))
  const all = JSON.stringify(fake.logs)
  for (const v of [ID, PW, ID.slice(0, 10), PW.slice(0, 6), PW.slice(-6), 'ABCDEF1234', 'Unexpected token']) {
    assert.ok(!all.includes(v), 'ログに値の断片（' + v.slice(0, 4) + '…）や JSON.parse の文が出ている')
  }
})
