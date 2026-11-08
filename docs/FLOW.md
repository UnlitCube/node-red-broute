# フローの入出力

B ルートノード（`wsuha-broute`）の入力と出力の一覧です。エディタの右のタブのヘルプにも同じ説明があります。

## 入力

入力を配線しなくても動きます。デプロイすると、ノードが自分でポートを開き、メーターを探して認証し、設定した間隔で計測を続け、切れたらつなぎ直します。

入力は 2 種類です。

- **上書き** — そのときだけ通常の動きを変えます。
- **Web UI と同じ操作と読み出し** — Web UI でできることを、フローからも行えます。

`msg.topic` で指示します（`msg.payload.action` でも指定できます）。知らない topic は、出力 2 に `error`（`VALIDATION`）を出します（Catch でも拾えます）。

### その場の指示（状態には残りません）

| topic | payload | 動作 |
|---|---|---|
| `get` | `'E7'` / `['E7','E8']` / `0xE7` | 指定した値を今すぐ取得します（つながっていなければ預かります） |
| `poll` | — | 定期的に取りに行く値を今すぐ 1 回取得します（つながっていなければ預かります） |
| `command` | `'SKINFO'` | 任意の SK コマンドを送ります（つながっていなければ預かります。アダプタだけで答えるもの（SKINFO・SKVER・SKAPPVER・SKTABLE・ROPT・SKSREG）は、ポートが開いていれば待ちません。FLASH を消耗するものは断ります）。payload が文字列でないと `VALIDATION` です |
| `reconnect` | `{ ladder: 0..3 }` | 段を指定してつなぎ直します |
| `status` | — | 現在の状態を出力 2 へ出します |
| `clear-radio-block` | — | 送信制限の解除の知らせを取りこぼしたときに、手動で解除します |

### 続く上書き（解除するまで残ります）

| topic | payload | 動作 |
|---|---|---|
| `stop` | `{ reason: '点検中' }` | 自動運転を止めます |
| `terminate` | — | メーターとのセッションを終了して止めます |
| `interval` | `60` | 取得間隔 [秒]。15〜3600 の整数です |
| `epcs` | `['E7','E0']` / `'E7, E8'` | 定期的に取りに行く値。1〜6 個で、履歴（`E2`・`E4`・`EC`）と重複は不可です |

範囲の外の `interval` / `epcs` は上書きを掛けず、出力 2 に `error`（`VALIDATION`）を出します。

掛かっている上書きは状態の `overrides` に出ます。`stop` / `terminate` で止まっているときは、接続の段階（`phase`）が `idle` ではなく `overridden`（外部の指示で停止中）になり、ノードの表示も青になります。故障で止まったのか、誰かが止めたのかを取り違えないためです。

上書きはデプロイをまたいで残ります（全体のデプロイ・設定ノードの値の変更・「有効」の入れ直しでも外れません）。点検中の停止が勝手に解けないためです。外れるのは、`auto`（停止は `start` でも）・Node-RED の再起動・設定ノードの削除のときです。

### 上書きの解除

| topic | 動作 |
|---|---|
| `start` / `resume` | 止めていた上書きだけ外します（取得間隔と定期的に取りに行く値の上書きは残します） |
| `auto` / `reset` | 上書きを全部外して設定どおりに戻します（運用設定があればその値に戻ります。設定ノードの値まで戻すのは `settings-reset` です） |
| `interval` / `epcs` に空（`null`） | その項目だけ設定どおりに戻します |

### Web UI と同じ操作（運用設定・接続の設定・認証情報・診断）

| topic | payload | 動作 |
|---|---|---|
| `settings` | `{ pollIntervalSec?, pollEpcs?, slowIntervalSec?, halfHourIntervalSec? }`（`null` でその項目を外します） | 運用設定を保存して効かせます。再起動しても残ります。`msg.rev` があれば食い違いを断ります。結果は出力 2 の `settings` です |
| `settings-reset` | — | 運用設定を全部外します。`msg.rev` があれば食い違いを断ります |
| `diag` | `{ name, args? }` | 診断します（Web UI の診断タブと同じ許可リスト）。結果は出力 2 の `diag` です |
| `config` | `{ serialport?, serialbaud?, mode?, name?, role?, enabled?, deviceKey?, expectedMac?, autoStart?, scanDurations? }`（`null` でその項目を外します） | 接続の設定を変えます。接続に関わる項目なら、その台だけ接続し直します。`msg.rev` があれば食い違いを断ります。結果は出力 2 の `config` です |
| `config-reset` | — | Web UI とフローで変えた接続の設定を全部外し、設定ノードの値に戻します。`msg.rev` があれば食い違いを断ります |
| `credentials` | `{ routeBId, routeBPassword }` | B ルートの認証 ID とパスワードを保存します（返事に値は入れません）。**inject や change に値を書くと `flows.json` に平文で残る**ので、環境変数か、Web UI かエディタで入れてください |
| `credentials-reset` | — | Web UI とフローで保存した認証情報を消します（エディタの値か環境変数に戻ります） |
| `add-adapter` | `{ role, mode, serialport?, routeBId?, routeBPassword?, … }` | アダプタを追加します。Web UI の［アダプタを追加］と同じです（[API.md](API.md) の「アダプタの追加」）。認証情報を inject に書くと `flows.json` に平文で残ります |

運用設定が変わると、どこから変えても出力 2 に `settings` が流れます。

操作（停止・再接続・今すぐ取得など）は、上の表の topic がそのまま Web UI の操作と同じです。

### 最新値の読み出し（`read`）

ノードは取った値の最新のものを持っています。`read` が来たら、**電波を使わずに**、持っている値ですぐ出力 2 の `read` で返します。入力の `msg` を引き継ぐので、`http in` からつないで `http response` で返せます。

| payload | 返すもの |
|---|---|
| なし / `{}` | 持っている値の全部（まだ取れていない定期的に取る値は `missing`） |
| `'E7'` / `['E7','E8']` / `{ epcs: [...] }` / `{ keys: ['instantPower'] }` | その値だけ |
| 上のどれかに `maxAgeSec: 60`（か `msg.maxAgeSec`） | 60 秒より古い値と無い値だけ、メーターへ取りに行ってから返します（取りに行くのは下の預かりの規則のとおりです）。メーターが持っていない値（プロパティマップに無い EPC）は取りに行かず、`missing` に入れます |

返事の形: `{device, deviceKey, ts, at, maxAgeSec, values: {instantPower: {epc, name, label, value, unit, display, meterAt, at, ts, fresh, ageSec}, …}, missing, refreshed}`（`meterAt` は定時積算の確定の時刻で、ほかの値は `null` です）

### 預かり（つながっていないときの指示）

つながっていないとき（接続中・再接続中）に来た `get`・`poll`・`command`・`diag`・取り直しの要る `read` は、エラーで返さずに**預かり、つながったら来た順に実行**します。

- 途中で切れたら、つなぎ直したあとに 1 回だけやり直します。
- 待つ長さはノードの「つながるまで待つ長さ」（既定 120 秒）か `msg.timeoutSec` です（つながっていない間だけ数えます）。過ぎたら出力 2 に `error`（`NOT_CONNECTED`・`waitedMs`）を出します。
- 自動運転を止めている（`stop`・`terminate`）ときは、メーターへの取得（`get`・`poll`・取り直しの要る `read`・`diag` の `epc` / `propmap`）はすぐ `STOPPED_BY_OVERRIDE` です。アダプタだけで答えるコマンド（SKINFO・SKVER・SKAPPVER・SKTABLE・ROPT・SKSREG）は、止めていてもポートが開いていれば実行します。設定ノードが無効ならすぐ `DISABLED`、21 件目からは `BUSY` です。
- 預かった入力の `done()` は、実行して済んだときに呼びます（complete ノードで見られます。失敗は Catch で拾えます）。
- 預かっている数は状態の `pendingCommands`（`{count, oldestMs}`）と、Web UI の状態タブに出ます。
- Node-RED を止めると、預かっていた指示は取りやめ、件数を Node-RED のログに warn で残します。
- Web UI の操作（今すぐ取得など）は預かりません（つながっていなければ、すぐに知らせます）。

### Web UI と同じ読み出し

| topic | payload | 出力 2 へ |
|---|---|---|
| `get-settings` | — | 今の設定と出どころ（`settings`） |
| `detail` | — | Web UI と同じ形の状態（`detail`） |
| `trend` | `{ range }`（`'1h'`・`'6h'`・`'24h'`）か、その文字列。inject の時刻のような数は `1h` | 直近の推移（`trend`）。`{ series: { power, currentR, currentT, lqi }, from, to }` の形で、`lqi` は間引くときに枠の中の最小を残します |
| `logs` | `{ after?, limit?, level? }` | アダプタのログの履歴（`logs`）。`{ items, nextSeq, dropped }` の形で、`dropped` は持てる件数を超えて先に消え、渡せなかった件数です |
| `adapters` | — | 全台の一覧と合計（`adapters`） |
| `meta` | — | 版（パッケージを入れ替えたあとに再起動したかを確かめられます）・エディタの場所・`addAdapter`（アダプタを追加できるか）・`auth`（Node-RED の認証の状態）（`meta`） |
| `get-config` | — | 接続の設定と出どころ、認証情報の状態（設定済みか・出どころ・PairID。値は出しません）（`config`） |
| `serialports` | — | つながっているシリアルポートの候補（`serialports`）。項目ごとに `portLabel`（`USB0` のような短い名前）・`kind`（`wsuha`・`maybe`・`other`）・`hint`・`usedBy`（使っている台やノード）・`aliases`（同じ機器のほかの名前）があります。`serialport` を読み込めないときは `serialportAvailable` が `false` で、`serialportMessage` に入れ方の案内が入ります |

読み出しは、設定ノードが無効でも、Web UI を載せていないサーバー（`wsuhaBroute.ui: false`）でも使えます。失敗は出力 2 の `error` です（Catch でも拾えます）。

> `http in` から書き込みの topic（`settings`・`stop` など）へつなぐと、Web UI の API の保護（Content-Type・Origin・Host・Node-RED の認証・`readOnly`）は掛かりません。別のサイトのフォームからも届くので、つなぐのは読み出しだけにするか、`httpNodeAuth` と `msg.req.headers.origin` の確認を自分で追加してください。

### EPC の書き方

文字列（`'E7'`）は 16 進として読み、数値（`0xE7`）はその値のまま使います。`'80'` を 10 進と解釈して別の値を取りに行く誤りを防ぐためです。

## 出力 1 — 計測値

1 回の取得につき 1 通の正規化した JSON を出します。形は [README](../README.md#出力-1--計測値) の例のとおりです。

診断（Web UI の診断タブ・入力の `diag`）で取った値は、出力 1 の 1 通にはなりません（次の計測の `all` には `fresh: false` で入ります）。

`meter.lqi` は、応答を受け取ったときの受信の強さ（RSSI）から ROHM の換算式（RSSI ≒ 0.275 × LQI − 104.27）を逆に解いて求めた近似値です。

## 出力 2 — 状態の変化とイベント

payload はどの topic でも、JSON にそのまま変換できるオブジェクトです（文字列や Buffer で出すものはありません）。

| topic | いつ出るか | payload |
|---|---|---|
| `status` | 状態が変わったとき・入力の `status` | 状態の全部に `device`（契約名）・`deviceKey`・`port`・`health` を加えたもの。`credentials` は `{configured, source, pairId}` だけで、アダプタ自身の情報は `adapter` です。`counters` は `{tx, rx, failures, timeouts, joins, reconnects, resends, resendRecovered, targetedScans, fullScans}` です。`connectHint` はつながらないときの案内で、`{kind, since, rounds}`（`kind` は `credentials`・`no-meter`）か `null` です |
| `phase` / `event` | 接続の段階が変わったとき・アダプタの自発イベント | `{device, …}` |
| `log` | 動作ログ（詳細設定の「動作ログ」に印のとき） | `{device, deviceKey, ts（ミリ秒）, at, level, text}` |
| `raw` | 受信した生の行（詳細設定の「受信した生の行」に印のとき） | `{device, deviceKey, at, line, kind, parsed}`（`kind` は `event`・`erxudp`・`epandesc`・`ok`・`fail` など、`parsed` は項目に分けたものです） |
| `command-result` / `diag` | 入力の `command` / `diag` の返事 | `{device, command, ok, at, lines, parsed, error}`。`parsed` はコマンドごとに項目に分けたものです（SKINFO → `{ipv6, mac, channel, channelMHz, panId, addr16}`、ROPT → `{wopt, erxudpFormat}`、SKSREG → `{register, value, meaning}`、SKTABLE → `{table, name, title, rows}` など） |
| `error` / `alert` / `recovered` | 失敗・連続失敗・復旧 | `{device, action, code, message, details, ts}` など（`ts` は ISO の文字列です） |
| `settings` / `config` | 運用設定・接続の設定が変わったとき（どこから変えても）と、入力の返事 | `Settings` / `Config`（`msg.changedBy` に変えた経路が入ります） |
| `read` | 入力の `read` の返事 | 上の「最新値の読み出し」の形 |
| `detail` / `trend` / `logs` / `adapters` / `meta` / `serialports` / `add-adapter` | 入力の返事 | Web UI の API と同じ形（[API.md](API.md)） |
| `credentials` | 入力の `credentials`・`credentials-reset` の返事 | `Config` の `credentials` の部分だけ（値は入りません） |

### alert の例

```json
{
  "topic": "alert",
  "payload": {
    "device": "電力", "deviceKey": "usb0", "port": "/dev/ttyUSB0",
    "phase": "joining", "consecutiveFailures": 3, "ladder": 1,
    "reason": "メーターとの認証が 9 回続けて通りません: EVENT 24",
    "ts": "2026-09-24T17:39:32+09:00", "at": 1790239172000
  }
}
```
