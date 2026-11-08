# 開発

## 試験

```bash
npm test                      # 全部（実機は要りません。シミュレーターを相手にします）
node test/run-all.js runtime  # パスに runtime を含むファイルだけ
node test/run-all.js --list   # 流すファイルの一覧
```

Node.js 18 以上で流せます。

次の試験は、指定しないと飛ばします（飛ばした数は試験の結果に出ます）。

| 指定 | 流れるもの |
|---|---|
| `WSUHA_TEST_NODE_RED=<node-red の入ったディレクトリ> npm test` | 本物の Node-RED に載せる試験（`test/runtime/flow-writer-embedded.test.js`・`editor-auth-embedded.test.js`） |
| `WSUHA_PLAYWRIGHT=<playwright-core のディレクトリ> node --test test/ui/browser.test.mjs` | 実ブラウザーの試験 |
| `WSUHA_BANNED_FILE=<禁止語の一覧のファイル> node --test test/pack.test.js` | 配布物に一覧の値が無いことを見る試験（1 行に 1 つの正規表現。一覧はリポジトリに置きません） |

`ui/vendor/` の部品は、`VERSIONS.json` の sha256 と 1 バイトも違えないようにしています。`.gitattributes` の `ui/vendor/** -text` は、`core.autocrlf` が改行を変えないようにするためのものです。消さないでください。

## 構成

```
lib/
  sk-protocol.js         SKSTACK-IP の応答とイベントの解析（副作用なし）
  sk-results.js          コマンドの応答を項目に分ける
  echonet.js             ECHONET Lite の組み立てと解釈（副作用なし）
  sequencer.js           状態機械・コマンドの待ち行列・再接続（中核）
  line-splitter.js       受信のバイト列を CR で行に切る
  serial-transport.js    シリアルポート
  simulator-transport.js 実機の応答を再現するシミュレーター
  normalize.js           受信したプロパティを正規化した JSON にする
  runtime/               Web UI の API・SSE・運用設定・認証情報の保存など
nodes/
  wsuha-device.js/.html  設定ノード（接続・認証情報・定期的な取得）
  wsuha-broute.js/.html  B ルートノード（パレットに出るノード）
ui/                      Web UI（Preact と htm を同梱。ビルドしません）
examples/                読み込みの「サンプル」に出るフロー
```

`lib/` は Node-RED に依存していないので、単体で `require` して使えます。

```js
const { Sequencer } = require('@unlitcube/node-red-broute/lib/sequencer')
const { SerialTransport } = require('@unlitcube/node-red-broute/lib/serial-transport')

const seq = new Sequencer(new SerialTransport({ path: '/dev/ttyUSB0' }))
seq.setCredentials(process.env.WSUHA_BROUTE_ID, process.env.WSUHA_BROUTE_PASSWORD)
seq.on('measurement', (m) => console.log(m.values.map((v) => `${v.name}=${v.display}`).join(' / ')))
seq.start().catch((e) => console.error(e.message))
```

## 受信の区切りが CR である理由

SKSTACK の応答は `<CRLF>本文<CRLF>` ですが、プロダクト設定コマンド（`WOPT`・`ROPT`・`WUART`・`RUART`）の応答は CR で終わり、LF が付きません。LF で区切ると、この系統の応答がいつまでも行として確定しません。

CR で区切れば両方とも 1 行になり、CRLF で終わる行は次の行頭に LF が残るだけです（パーサーで落としています）。

## 参照

- ROHM BP35C0 コマンドマニュアル
- ECHONET Lite 規格書 / 機器オブジェクト詳細規定 <https://echonet.jp/spec_g/>
