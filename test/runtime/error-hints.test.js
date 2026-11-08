'use strict'

// 直近のエラーの「何をすればよいか」（lib/runtime/error-hints.js）。
// 機器・OS・sequencer が実際に出す文で確かめる（文の形が変わると hint が黙って消えるため）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { hintOf, HINTS } = require('../../lib/runtime/error-hints')

test('ポートを開けないときの実際の文（Windows・Linux のロック・権限）に、的を射た hint が付く', () => {
  // 戻すと落ちるもの: HINTS から権限・ロック・見つからないの 3 行を外す（前は null か「挿さっているか」だけだった）
  const rows = [
    ['Error: Opening COM3: File not found', /このポートが見つかりません/],
    ['Error: Opening COM3: Access denied', /このポートを開く権限がありません/],
    ['Error: Error: Permission denied, cannot open /dev/ttyUSB0', /dialout グループ/],
    ['EACCES: permission denied, open /dev/ttyUSB0', /権限/],
    ['Error Resource temporarily unavailable Cannot lock port', /ほかのプログラムがこのポートを開いています/],
    // glibc の EBUSY の文（試験の作った文でなく、Linux で実際に出る形）と、macOS の文
    ['Error: Device or resource busy, cannot open /dev/ttyUSB0', /ほかのプログラム/],
    ['Error: Resource busy, cannot open /dev/ttyUSB0', /ほかのプログラム/],
    ['EBUSY: resource busy or locked', /ほかのプログラム/],
    ['Error: No such file or directory, cannot open /dev/ttyUSB0', /このポートが見つかりません/],
    ['ENOENT: no such file or directory, open /dev/ttyUSB0', /このポートが見つかりません/],
  ]
  for (const [message, want] of rows) assert.match(String(hintOf(message)), want, message)
})

test('sequencer のコマンドの時間切れの文に hint が付く（今の文と、前の書き方の両方）', () => {
  // 戻すと落ちるもの: タイムアウトの行を外す・「（20 秒）」の全角の括弧を読まない
  for (const message of ['タイムアウト（20 秒）', 'タイムアウト (20秒)']) {
    assert.match(String(hintOf(message)), /アダプタから応答がありませんでした/, message)
  }
  assert.match(String(hintOf('ECHONET 応答のタイムアウト')), /メーターから応答がありませんでした/, 'メーターの時間切れは別の文')
})

test('認証が通らない文は、電波を先に勧めてから認証情報を確かめさせる（正しい値を入れ直させない）', () => {
  // 電波が悪い間も認証の失敗が続くので、認証情報だけを疑わせると、開き直しでさらに止まる。
  // 戻すと落ちるもの: hint を「パスワードと認証 ID が正しいかを確かめてください」だけに戻す
  for (const message of ['EVENT 24（PANA 接続エラー）', 'メーターとの認証が 31 分通りません。メーターを探し直します', 'メーターとの認証が通りませんでした']) {
    const h = String(hintOf(message))
    assert.match(h, /電波が弱い/, message)
    assert.match(h, /パスワード（12 桁）と認証 ID/, message)
    assert.ok(h.indexOf('電波') < h.indexOf('パスワード'), h)
    assert.ok(!/PANA|EVENT/.test(h), h)
  }
})

test('認証は通ったあとの失敗は、認証情報を疑わせない', () => {
  // 戻すと落ちるもの: HINTS から「認証は通り」の行を外す（/PANA/ に当たって認証情報の案内になる）
  for (const message of ['メーターとの認証は通りましたが、メーターから応答がありません (1 巡目 1/3): 理由', 'メーターとの認証は通りますが、メーターの応答が 3 分ありません。メーターを探し直します']) {
    const h = String(hintOf(message))
    assert.match(h, /認証は通りました/, message)
    assert.ok(!/パスワード/.test(h), h)
  }
})

test('serialport を読み込めない文: 入れ直す手順。ほかの USB の案内に流れない', () => {
  // 戻すと落ちるもの: HINTS の先頭の serialport の行を外す（前は null）
  const h = String(hintOf('serialport を読み込めません。パレットからこのノードを入れ直すか、userDir で npm install serialport@12 を実行して、Node-RED を再起動してください'))
  assert.match(h, /npm install serialport@12/)
  assert.match(h, /Node-RED を再起動/)
  assert.ok(!/挿さっている/.test(h), h)
})

test('今までの文も同じ案内のまま（順を変えても崩れない）', () => {
  const rows = [
    ['UDP 送信失敗（EVENT 21 <PARAM>=01）が 3 回続きました', /電波の混雑/],
    ['UDP 送信失敗（キャリアセンスビジー / 送信時間制限 / Ack 無し / 鍵無し）', /電波の混雑/],
    ['ARIB 送信総和時間の制限中（EVENT 32）です', /1 時間に 360 秒/],
    ['メーターが見つかりませんでした。認証 ID が正しいか、アダプタとメーターの距離を確かめてください', /認証 ID が正しいか/],
    ['認証情報が未設定か、書式が違います: 認証 ID', /設定タブ/],
    ['ポートが開いていません', /USB のアダプタと通信できませんでした/],
    ['Error: Cannot open /dev/ttyUSB0', /USB のアダプタと通信できませんでした/],
    ['ポートが未設定です。設定ノードか Web UI の「アダプタと接続」で、ポートを選ぶか入力してください', /ポートを選んでください/],
    ['ECHONET 要求が滞留しています。間隔を空けてください', /要求が重なりました/],
    ['接続先アドレスが未確定です', /まだつながっていません/],
    ['FAIL ER06', /コマンドを受け付けませんでした/],
  ]
  for (const [message, want] of rows) assert.match(String(hintOf(message)), want, message)
  for (const m of [null, undefined, '', '読めない文']) assert.equal(hintOf(m), null)
})

test('EVENT 02 が返らないときの文に hint が付く', () => {
  // sequencer は応答の待ちが切れると、この文を lastError に入れる。前はどの規則にも当たらず、画面に案内が出なかった。
  // 戻すと落ちるもの: HINTS の EVENT 02 の行を外す
  const h = String(hintOf('EVENT 02（アドレス解決）が返りません'))
  assert.match(h, /メーターの応答を確かめられませんでした/)
  assert.match(h, /電波の強さ/)
})

test('今の文に無い選択肢を規則に残さない', () => {
  // 文を直したあとの選択肢は、当たらないのに読み手には「この文が出る」と見える。
  // 戻すと落ちるもの: HINTS に下の語を戻す
  const sources = HINTS.map((h) => h.re.source).join('|')
  for (const dead of ['応答が時間内に返りません', 'シリアルポートのパスが指定されていません', '切断']) {
    assert.ok(!sources.includes(dead), dead)
  }
})

test('文は「です・ます」で終わり、内部の語（EVENT の番号・SK コマンド）を出さない。ほかのプログラムの呼び方をそろえる', () => {
  for (const { hint } of HINTS) {
    assert.match(hint, /。$/, hint)
    assert.ok(!/EVENT \d|SK[A-Z]{3,}|PANA|SFD/.test(hint), hint)
    assert.ok(!/ほかのアプリ/.test(hint), hint)
  }
})
