'use strict'

// B ルートノードの編集画面とヘルプ（nodes/wsuha-broute.html）。
//  - アダプタと名前はタブの上、その下に RED.tabs の「基本設定」「詳細設定」（設定ノードと同じ作り）
//  - 効かない epcFilter の欄を出さず、defaults には残す（既存のフローの値を壊さない）
//  - ヘルプは、今の出力（status の counters・trend の lqi・meta・serialports）に追いついている
// 偽の RED と偽の jQuery で <script> を動かし、文は HTML の文字列で見る。
//
// 戻すと落ちるもの（それぞれの試験に書いた）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { makeJq, makeTabs, elementOf, unknownFa } = require('./editor-kit')
const { createKit, input, connected } = require('./node-kit')

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'wsuha-broute.html'), 'utf8')

function section(name) {
  const m = HTML.match(new RegExp('data-' + name + '-name="wsuha-broute">([\\s\\S]*?)</script>'))
  return m[1]
}

/** registerType の定義を読む。opts.devices は RED.nodes.node で引ける設定ノード。 */
function load(opts) {
  const o = opts || {}
  const script = HTML.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1]
  const tabs = makeTabs()
  const jq = makeJq(() => undefined, { html: section('template') })
  let def = null
  const RED = {
    nodes: { registerType: (name, d) => (def = d), node: (id) => (o.devices || {})[id] || null },
    tabs: { create: tabs.create },
  }
  vm.runInNewContext(script, { RED, $: jq.$, setTimeout: (fn) => fn() })
  return { def, tabs, jq }
}

/** 編集画面を開く。node は開くノード、values は Node-RED が入れておく欄の値。 */
function open(node, values) {
  const l = load()
  for (const [k, v] of Object.entries(values || {})) l.jq.get('#node-input-' + k).value = v
  l.def.oneditprepare.call(node || {})
  return l
}

test('編集画面: アダプタと名前はタブの上。基本設定は出力 1・2、詳細設定は異常の通知・待つ長さ・動作ログ・生の行', () => {
  // 戻すと落ちるもの: 平らなフォームに戻す・欄の置き場所を変える
  const form = section('template')
  const tabsAt = form.indexOf('id="wsuha-broute-tabs"')
  assert.ok(tabsAt > 0, 'タブがある')
  for (const k of ['device', 'name']) {
    const at = form.indexOf(`id="node-input-${k}"`)
    assert.ok(at > 0 && at < tabsAt, `${k} はタブの上`)
  }
  const basic = elementOf(form, 'wsuha-broute-tab-basic')
  const advanced = elementOf(form, 'wsuha-broute-tab-advanced')
  const inside = (html) => (html.match(/id="node-input-(\w+)"/g) || []).map((s) => s.slice(15, -1))
  assert.deepEqual(inside(basic), ['emitMeasurements', 'emitStatus'])
  assert.deepEqual(inside(advanced), ['alertAfterFailures', 'waitSec', 'emitLogs', 'emitRaw'])
  assert.match(advanced.split('\n')[0], /display:none/, '詳細設定は閉じて始める')
  // ほかの欄が 2 つのタブの外に増えていない
  assert.deepEqual(inside(form).sort(), ['alertAfterFailures', 'device', 'emitLogs', 'emitMeasurements', 'emitRaw', 'emitStatus', 'name', 'waitSec'])
})

test('編集画面の文言: 出力の名前・回数と秒の添え字・添え書き。ラベルは 120px、説明は 1 行まで、アイコンは 4.7 にあるもの', () => {
  // 戻すと落ちるもの: 欄の文言を前の語に戻す・長い説明を欄の下に戻す・ラベルの幅を外す
  const form = section('template')
  assert.match(form, /出力 1<\/label>[\s\S]*?計測値/)
  assert.match(form, /出力 2<\/label>[\s\S]*?状態の変化とイベント/)
  const status = form.slice(form.indexOf('node-input-emitStatus'), form.indexOf('wsuha-broute-tab-advanced'))
  assert.match(status, /入力への返事（read・settings など）は、外しても出力 2 に出ます/)
  assert.match(form, /異常の通知<\/label>[\s\S]*?回続けて失敗したら/)
  assert.match(form, /つながるまで<br \/>待つ長さ<\/label>[\s\S]*?秒/)
  assert.match(form, /動作ログ/)
  assert.match(form, /受信した生の行/)
  assert.match(form, /\.form-row > label \{ width: 120px; \}/)
  for (const m of form.matchAll(/<div class="form-tips[^"]*">([\s\S]*?)<\/div>/g)) {
    assert.ok(!/<br|\n/.test(m[1]), '説明は 1 行まで: ' + m[1])
    assert.ok(m[1].length <= 40, '説明が長い: ' + m[1])
  }
  assert.deepEqual(unknownFa(form), [])
  for (const w of ['Bルート', '構成', '接続先ごと', '状態・イベント', '秒数']) assert.ok(!form.includes(w), `使わない語: ${w}`)
})

test('効かない epcFilter: 欄と説明を出さず、defaults には残す', () => {
  // 実行時に読まれないのに「E7 だけにすると瞬時電力しか流れません」と説明していた。
  // 戻すと落ちるもの: 欄を戻す（node-input-epcFilter）・defaults から消す（既存のフローの値が保存のときに消える）
  const form = section('template')
  assert.ok(!/epcFilter/.test(form), '欄が残っている')
  assert.ok(!/絞り込み/.test(form), '説明が残っている')
  assert.ok(!/epcFilter|絞り込み/.test(section('help')))
  assert.ok(load().def.defaults.epcFilter, 'defaults に残す')
  assert.equal(load().def.defaults.epcFilter.value, '')
})

test('異常の通知の検証: 0〜100 の整数か空。-1・1.5・101 を弾く', () => {
  // 戻すと落ちるもの: RED.validators.number(true) に戻す（-1 と 1.5 が通る）
  const ok = load().def.defaults.alertAfterFailures.validate
  assert.equal(typeof ok, 'function')
  for (const v of ['', undefined, null, ' ', 0, '0', 1, 3, '3', ' 3 ', 100, '100']) assert.equal(ok(v), true, JSON.stringify(v))
  for (const v of [-1, '-1', 1.5, '1.5', 101, '101', 'abc', '1e2', '0x10']) assert.equal(ok(v), false, JSON.stringify(v))
  assert.equal(load().def.defaults.alertAfterFailures.value, 3)
})

test('つながるまで待つ長さの検証: 既定 120 秒。空か 0〜3600 の数', () => {
  // 戻すと落ちるもの: defaults に waitSec を足さない・範囲を見ない
  const def = load().def
  assert.equal(def.defaults.waitSec.value, 120)
  const ok = def.defaults.waitSec.validate
  for (const v of ['', 0, 1, 120, '30', 3600, 0.5]) assert.equal(ok(v), true, String(v))
  for (const v of [-1, 3601, 'abc', '1e9']) assert.equal(ok(v), false, String(v))
})

test('表示: 名前 → 「B ルート: 」と設定ノードの表示 → 「B ルート」。出力の名前とパレットの名前', () => {
  // 戻すと落ちるもの: 「Bルート: 」に戻す・設定ノードの label を呼ばずに name だけを見る（名前の無い台で「B ルート: 」だけになる）
  const dev = { name: '', role: '電力', _def: { label() { return this.role } } }
  const { def } = load({ devices: { d1: dev, d2: { name: '分電盤' } } })
  assert.equal(def.label.call({ name: '計測', device: 'd1' }), '計測')
  assert.equal(def.label.call({ name: '', device: 'd1' }), 'B ルート: 電力')
  assert.equal(def.label.call({ name: '', device: 'd2' }), 'B ルート: 分電盤')
  assert.equal(def.label.call({ name: '', device: 'none' }), 'B ルート')
  assert.equal(def.paletteLabel, 'B ルート')
  assert.deepEqual(Array.from(def.outputLabels), ['計測値', '状態の変化とイベント'])
})

test('タブ: 基本設定から始まり、選んだタブだけを見せる', () => {
  // 戻すと落ちるもの: oneditprepare で RED.tabs.create を呼ばない・タブの順を変える
  const { tabs, jq } = open({})
  assert.equal(tabs.id, 'wsuha-broute-tabs')
  assert.deepEqual(tabs.added.map((t) => t.label), ['基本設定', '詳細設定'])
  assert.deepEqual(tabs.added.map((t) => t.id), ['wsuha-broute-tab-basic', 'wsuha-broute-tab-advanced'])
  tabs.onchange({ id: 'wsuha-broute-tab-advanced' })
  assert.equal(jq.get('#wsuha-broute-tab-advanced').visible, true)
})

test('詳細設定に入力の誤りがあると、タブの名前が「詳細設定（n 件の注意）」になる。直すと戻る', () => {
  // 戻すと落ちるもの: oneditprepare の markAdvanced を外す・欄の変更で数え直さない
  const { tabs, jq } = open({ alertAfterFailures: '-1' }, { alertAfterFailures: '-1', waitSec: '120' })
  const name = () => tabs.names['wsuha-broute-tab-advanced']
  assert.equal(name(), '詳細設定（1 件の注意）')
  const wait = jq.get('#node-input-waitSec')
  wait.value = 'abc'
  jq.get('#wsuha-broute-tab-advanced input').handlers.input()
  assert.equal(name(), '詳細設定（2 件の注意）')
  wait.value = '60'
  jq.get('#node-input-alertAfterFailures').value = '3'
  jq.get('#wsuha-broute-tab-advanced input').handlers.change()
  assert.equal(name(), '詳細設定')
})

test('項目の無い前の版のフロー: 実行時の既定を見せる（そのまま保存しても動きを変えない）', () => {
  // 実行時は undefined を「出力は出す・3 回で通知」と読むが、エディタは印なし・空で見せる。そのまま保存すると「出さない」「通知しない」に変わる。
  // 戻すと落ちるもの: oneditprepare の 3 行を外す
  const { jq } = open({})
  assert.equal(jq.get('#node-input-emitMeasurements').props.checked, true)
  assert.equal(jq.get('#node-input-emitStatus').props.checked, true)
  assert.equal(jq.get('#node-input-alertAfterFailures').value, '3')
  // 値を持っているフローは触らない
  const set = open({ emitMeasurements: false, emitStatus: false, alertAfterFailures: '' }, { alertAfterFailures: '' })
  assert.equal(set.jq.get('#node-input-emitMeasurements').props.checked, undefined)
  assert.equal(set.jq.get('#node-input-emitStatus').props.checked, undefined)
  assert.equal(set.jq.get('#node-input-alertAfterFailures').value, '')
})

test('ヘルプの冒頭: はじめに（3 行）と、パレットの探し方・シミュレーターの案内', () => {
  // 戻すと落ちるもの: 「はじめに」を外す・3 行でなくなる
  const help = section('help')
  const at = help.indexOf('<h3>はじめに</h3>')
  assert.ok(at > 0 && at < help.indexOf('<h3>入力'), 'ヘルプの先のほうにある')
  assert.equal(help.indexOf('<p>'), help.indexOf('<p>Wi-SUN B ルートで'), '1 段落目はパレットの説明になるので、ノードの説明のまま')
  const list = help.slice(at, help.indexOf('</ol>', at))
  assert.equal(list.split('<li>').length - 1, 3)
  assert.match(list, /新規に Wi-SUN アダプタ を追加/)
  assert.match(list, /B ルートの認証 ID とパスワード/)
  assert.match(help, /「B ルート」か「broute」で見つかります/)
  assert.match(help, /シミュレーター（実機なしで試す）/)
})

test('ヘルプ: 編集画面から移した説明が全部ある。欄の名前は今の名前', () => {
  // 戻すと落ちるもの: 欄の下から説明を消したまま、ヘルプに移さない
  const help = section('help')
  const items = help.slice(help.indexOf('<h3>編集画面の項目</h3>'), help.indexOf('<h3>入力'))
  for (const w of ['出力 1', '出力 2', '異常の通知', 'つながるまで待つ長さ', '動作ログ', '受信した生の行', 'Catch ノード', 'alert', 'recovered', '0 か空なら通知しません',
    'msg.timeoutSec', 'NOT_CONNECTED', '空なら 120 秒', '0 なら待ちません', '0〜3600']) {
    assert.ok(items.includes(w), `編集画面の項目に ${w}`)
  }
  assert.ok(!help.includes('待つ秒数'), '前の欄の名前が残っている')
  assert.ok(!help.includes('状態の変化と自発イベント'), '前の欄の名前が残っている')
  assert.ok(!help.includes('出力 2 — 状態・イベント'), '前の見出しが残っている')
  assert.match(help, /<h3>出力 2 — 状態の変化とイベント<\/h3>/)
})

test('ヘルプ: 入力の read（payload の形・maxAgeSec・無線を使わない）と、預かり（待つ長さ・やり直し・止めている・上限・デプロイ・停止）', () => {
  // 戻すと落ちるもの: ヘルプに read と預かりの説明を書かない
  const help = section('help')
  assert.match(help, /<code>read<\/code>/)
  assert.match(help, /maxAgeSec/)
  assert.match(help, /電波を使わず/)
  assert.match(help, /missing/)
  assert.match(help, /ageSec/)
  assert.match(help, /預か/)
  for (const w of ['msg.timeoutSec', 'NOT_CONNECTED', 'waitedMs', 'STOPPED_BY_OVERRIDE', 'DISABLED', 'BUSY', 'SHUTDOWN', 'pendingCommands', '1 回だけ']) {
    assert.ok(help.includes(w), 'ヘルプに ' + w)
  }
  // モジュールだけで答えるコマンド
  for (const c of ['SKINFO', 'SKVER', 'SKAPPVER', 'SKTABLE', 'ROPT', 'SKSREG']) assert.ok(help.includes(c), c)
  // 出力 2 の表に read の行
  const out2 = help.slice(help.indexOf('出力 2 — '))
  assert.match(out2, /<tr><td><code>read<\/code><\/td>/)
  // 前の説明（未接続の get は即 error）が残っていない
  assert.ok(!/下の上書きを送ると、出力 2 に <code>error<\/code>/.test(help), '前の説明が残っている')
})

test('ヘルプ: LQI は近似値で、換算の式を書く。読み出しの API の守りと、認証がこの入力に掛からないことを書く', () => {
  // 戻すと落ちるもの: 近似の説明を外す・API の X-Wsuha-Radio と adminAuth の説明を書かない
  const help = section('help')
  const meter = help.slice(help.indexOf('<dt>payload.meter'), help.indexOf('<dt>payload.values'))
  assert.match(meter, /近似値/)
  assert.match(meter, /0\.275 × LQI − 104\.27/)
  assert.match(meter, /応答ごとに変わります/)
  assert.match(help, /X-Wsuha-Radio: 1/)
  assert.match(help, /3 秒に 1 回/)
  assert.match(help, /Node-RED の認証（<code>adminAuth<\/code>）は Web UI からの操作だけを止め、このノードの入力には掛かりません/)
  const httpIn = help.slice(help.indexOf('<b>注意</b>: <code>http in</code>'))
  assert.match(httpIn.slice(0, httpIn.indexOf('</p>')), /adminAuth/, 'http in の経路に認証が掛からないことも書く')
})

test('ヘルプの出力 2 の表が、実際の出力に追いついている（status の counters・trend の系列・meta・serialports）', async () => {
  // 実物の返事の鍵が表に無ければ落ちる。出力に項目を足してヘルプを忘れたときに気づくため。
  // 戻すと落ちるもの: 表の trend から lqi を、meta から addAdapter を、status から counters の項目を、serialports から serialportAvailable を、logs から dropped を消す
  const help = section('help')
  const out = help.slice(help.indexOf('<h3>出力 2 — '))
  const row = (t) => {
    const at = out.indexOf(`<tr><td><code>${t}</code></td>`)
    assert.ok(at >= 0, `出力 2 の表に ${t}`)
    return out.slice(at, out.indexOf('</tr>', at))
  }
  const kit = createKit()
  const fake = kit.setup()
  const dev = kit.createDevice(fake, 'bh-out')
  const b = kit.createBroute(fake, 'bh-out')
  try {
    await connected(dev)
    const reply = async (topic) => (await input(b, { topic })).sent[0][1].payload
    const meta = await reply('meta')
    for (const k of Object.keys(meta)) assert.ok(row('meta').includes(k), `meta の ${k}`)
    const trend = await reply('trend')
    for (const k of Object.keys(trend.series)) assert.ok(row('trend').includes(k), `trend の ${k}`)
    const counters = dev.sequencer.snapshot().counters
    for (const k of Object.keys(counters)) assert.ok(row('status').includes(k), `status の counters の ${k}`)
    for (const k of Object.keys(meta.auth)) assert.ok(row('meta').includes(k), `meta の auth の ${k}`)
    const ports = row('serialports')
    for (const k of ['kind', 'hint', 'usedBy', 'aliases', 'portLabel']) assert.ok(ports.includes(k), `serialports の ${k}`)
    for (const k of Object.keys(await reply('serialports'))) assert.ok(ports.includes(k), `serialports の ${k}`)
    for (const k of Object.keys(await reply('logs'))) assert.ok(row('logs').includes(k), `logs の ${k}`)
    assert.match(row('trend'), /最小/, 'lqi の間引き')
    assert.match(row('status'), /connectHint/)
  } finally {
    await kit.cleanup()
  }
})

test('ヘルプと編集画面の言い回し: 決めた語にそろえる（構成・半角の括弧の説明・「画面」の呼び方）', () => {
  // 戻すと落ちるもの: 前の語を書き足す
  const text = section('template') + section('help')
  for (const w of ['B ルート認証情報', '構成', 'シミュレータ（', 'シミュレータ ', '繋', '画面 (Web UI)', 'Bルート:']) {
    assert.ok(!text.includes(w), `使わない語: ${w}`)
  }
  // 文の中の半角の括弧（コードの例の中は除く）
  const plain = section('help').replace(/<code>[\s\S]*?<\/code>/g, '').replace(/<[^>]+>/g, '')
  assert.ok(!/[ぁ-んァ-ヶ一-龠]\s?\(|\)[ぁ-んァ-ヶ一-龠]/.test(plain), '半角の括弧が残っている')
})

test('ヘルプ: このノードだけの再デプロイで接続が切れないのは、デプロイの種類が「全て」でないときだけ', () => {
  // 戻すと落ちるもの: 「このノードだけを変更して再デプロイしても、メーターとの接続は切れません」だけの文に戻す
  const help = section('help')
  assert.match(help, /デプロイの種類が「変更したノード」か「変更したフロー」なら/)
  assert.match(help, /デプロイの種類が「全て」（既定）のときは設定ノードも作り直す/)
})

test('ヘルプ: はじめにの手順は、隣のボタンでアダプタを追加する（Node-RED 3 と 4 で違う）', () => {
  // 戻すと落ちるもの: 「新規に…を選び」だけの手順に戻す
  const help = section('help')
  const first = help.slice(help.indexOf('<h3>はじめに</h3>'), help.indexOf('</ol>'))
  assert.match(first, /右のボタン（Node-RED 3 は鉛筆、4 は ＋）を押して/)
})

test('ヘルプ: 「一時的な上書き」は続く上書きだけを指す。状態に残らない入力は「その場の指示」と呼ぶ', () => {
  // 同じ語で「状態に残らないもの」と「デプロイをまたいで残るもの」を指すと、読む人が逆に取る。
  // 戻すと落ちるもの: 見出しを「一時的な上書き」に戻す・入力の 2 種類の説明を「そのときだけ…」に戻す
  const help = section('help')
  assert.match(help, /<h4>その場の指示（状態には残りません）<\/h4>/)
  assert.match(help, /<h4>続く上書き（解除するまで残ります）<\/h4>/)
  assert.ok(!/<h4>一時的な上書き/.test(help))
  assert.match(help, /入力は 2 種類です。<b>その場の指示と上書き<\/b>/)
})

test('ヘルプ: command の result は開発の版の名前で説明しない。read は認証 ID か接続先を変えると前の値を出さない', () => {
  // 戻すと落ちるもの: 「result は前の版（1.x）の形」の文に戻す・read の但し書きを消す
  const help = section('help')
  assert.match(help, /<code>result<\/code> は応答の値をまとめた古い形で、成功のときだけ入ります/)
  assert.ok(!help.includes('1.x'), '公開の読み手に通じない版の名前')
  assert.match(help, /認証 ID か接続先を変えたときは、前の値を出しません/)
  assert.match(help, /payload が文字列でないときは送らず/)
})
