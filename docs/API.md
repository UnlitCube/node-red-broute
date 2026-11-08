# HTTP API と SSE

Web UI が使う REST API と SSE です。ほかのプログラムからも呼べます。Web UI でできることは、同じ内容をフローの入力からもできます（[FLOW.md](FLOW.md)）。

- API: `{httpNodeRoot}wsuha-broute/api/v1/…`
- Web UI: `{httpNodeRoot}wsuha-broute/ui/`

`httpNodeRoot` の既定は `/` なので、ふつうは `http://<Node-RED のホスト>:1880/wsuha-broute/api/v1/` です。この文書のパスは、`api/v1/` より後ろだけを書きます。

`settings.js` で `httpNodeRoot: false` か `wsuhaBroute.ui: false` にしたサーバーでは、API も Web UI も載りません。

## 認証と保護

### 読むとき

読むだけの API と SSE は、Node-RED に届く人なら誰でも使えます。読める人を限るのは、Node-RED の `httpNodeAuth`（Basic 認証）です（`RED.init` で埋め込んだ Node-RED には掛かりません）。`httpNodeMiddleware` は `http in` ノードにしか掛からないので、この API は守れません。

### 変えるとき

PUT・DELETE・POST は、次の順に確かめます。

| 順 | 確かめること | 外れたとき |
|---|---|---|
| 1 | `Host` が許可リストにある | 403 `BAD_HOST` |
| 2 | `Content-Type: application/json` がある（本文が無くても要ります） | 415 `UNSUPPORTED_MEDIA_TYPE` |
| 3 | `Origin` があるなら、`Host` と同じオリジン。`Origin` が無ければ通します（curl など） | 403 `BAD_ORIGIN` |
| 4 | Node-RED に認証（`adminAuth`）があるサーバーでは、ログインと権限。エディタを別の方法で閉じているサーバーは、全部断ります | 401 `LOGIN_REQUIRED`・403 `FORBIDDEN` |
| 5 | `wsuhaBroute.readOnly` が `true` でない | 403 `READ_ONLY` |
| 6 | 接続の設定・認証情報・アダプタの追加は、`wsuhaBroute.uiConfig` と `uiAddAdapter` | 403 `CONFIG_LOCKED` |
| 7 | 本文が 64 KB までの JSON | 422 `VALIDATION` |

`httpAdminRoot` と `httpNodeRoot` が同じサーバー（既定）では、エディタが先に本文を読むので、JSON として読めない本文は Node-RED の 400（HTML）になります。このときは `error.code` がありません。

応答には CORS のヘッダーを付けないので、別のサイトのページは読み取りの結果を受け取れません。

### Node-RED に認証があるサーバー

`adminAuth` があるサーバーでは、変更と、電波を使う読み出しにエディタのトークンが要ります。

```
X-Wsuha-Editor-Token: <エディタのアクセストークン>
```

- `Authorization` ヘッダーではなく、このヘッダーで送ります。`Authorization` は `httpNodeAuth` の Basic 認証と同じヘッダーなので、Bearer を載せると API に届く前に断られます。
- Web UI は、同じオリジンのエディタのログインからトークンを読みます。
- スクリプトから使うときは、Node-RED の Admin API の `POST {httpAdminRoot}auth/token` で取ります（<https://nodered.org/docs/api/admin/oauth>）。

  ```bash
  curl -X POST http://127.0.0.1:1880/auth/token \
    -H 'Content-Type: application/json' \
    -d '{"client_id":"node-red-admin","grant_type":"password","scope":"","username":"<名前>","password":"<パスワード>"}'
  ```

  `scope` は空のままにしてください。`*` を送ると、権限を限った利用者はトークンを取れません。
- 権限は Node-RED の `permissions` のとおりです。`*`・`write`・`wsuha-broute.write` は変更でき、`read` は 403 `FORBIDDEN` です。`adminAuth.default` で匿名に権限を与えているサーバーでは、トークンが無くても通ります。
- `wsuha-broute.write` は、この文書の変更の全部（運用設定・接続の設定・認証情報・操作・アダプタの追加）を許します。アダプタの追加は `flows.json` に書き込みますが、`flows.write` の権限は見ません。
- トークンが無い・切れたときと、匿名に与えた権限が足りないときは 401 `LOGIN_REQUIRED` です。
- `adminAuth` があるのに認証の仕組みが使えないサーバー（`httpAdminRoot: false` など）では、書き込みは全部 401 `LOGIN_REQUIRED` です。
- `adminAuth` が無いサーバーでは、トークンは要りません。ただし、エディタを別の方法で閉じているサーバー（`httpNodeRoot` が `httpAdminRoot` の下に無い `httpAdminAuth`・`httpAdminMiddleware` と、`httpAdminRoot: false`）では、ログインした人を確かめられないので、書き込みは全部 401 `LOGIN_REQUIRED` です。開くなら、`settings.js` に `httpNodeAuth` か `wsuhaBroute: { allowAnonymousWrites: true }` を書いてください。
- `RED.init` で埋め込んだ Node-RED には、`httpNodeAuth` と `httpAuth` が掛かりません（掛けるのは `node-red` のコマンドで起動したサーバーだけです）。書いてあっても守りに数えないので、上のサーバーを開くのは `allowAnonymousWrites` だけです。守りはホストのアプリで掛けてください。
- `disableEditor: true` はエディタを出さないだけで管理 API は開いたままなので、エディタを閉じたことに数えません。守るなら `adminAuth` を書いてください。
- 認証を通らなかった変更は、Node-RED のログに warn で残ります。監査のイベントは `wsuha-broute.auth.denied` で、値は入りません。

```bash
curl -X POST http://127.0.0.1:1880/wsuha-broute/api/v1/adapters/<id>/actions/poll \
  -H 'Content-Type: application/json' \
  -H 'X-Wsuha-Editor-Token: <トークン>' \
  -d '{}'
```

`httpNodeAuth` もあるサーバーでは、Basic 認証（curl なら `-u`）も一緒に付けます。ブラウザーから送った要求が 401 を受けると、ブラウザーは覚えていた Basic 認証を捨てることがあります。

## 応答の形

成功は JSON です。`Cache-Control: no-store` を付けます。

失敗は次の形です。`message` は日本語で、そのまま人に見せられます。`details` は入力の誤りのときに、項目ごとの理由が入ります。

```json
{ "error": { "code": "VALIDATION", "message": "入力を確かめてください", "details": { "reason": "止める理由を 1〜200 文字で書いてください" } } }
```

| 状態 | code | いつ |
|---|---|---|
| 401 | `LOGIN_REQUIRED` | Node-RED の認証があるサーバーで、ログインしていない・トークンが切れた。認証の仕組みが使えないサーバーと、エディタを別の方法で閉じているサーバーでは、全部の書き込み |
| 403 | `FORBIDDEN` | ログインしているが、権限が足りない |
| 403 | `BAD_HOST` | `Host` が許可リストに無い（`wsuhaBroute.allowedHosts` で追加できます） |
| 403 | `BAD_ORIGIN` | 別のオリジンからの要求。電波を使う読み出しに `X-Wsuha-Radio` が無い |
| 403 | `READ_ONLY` | `wsuhaBroute.readOnly` で止めている |
| 403 | `CONFIG_LOCKED` | `wsuhaBroute.uiConfig`・`uiAddAdapter` で止めている |
| 403 | `FORBIDDEN_COMMAND` | 許可していないコマンド |
| 404 | `ADAPTER_NOT_FOUND`・`NOT_FOUND` | アダプタや API が無い |
| 409 | `STOPPED_BY_OVERRIDE` | 外部の指示で止めている（`reconnect`・`poll`・`get`・`diag` の `epc` と `propmap`・`read` の取り直し） |
| 409 | `RADIO_BLOCKED` | 送信の上限で、アダプタが送信を止めている |
| 409 | `BUSY` | 前の取得や開き直しが終わっていない・取得の途中でセッションを終了した |
| 409 | `DISABLED` | 「有効」を外している |
| 409 | `PORT_IN_USE` | ほかの台かフローのシリアルのノードが使っているポート |
| 409 | `FLOWS_LOCKED` | セーフモードなどで、フローを保存できない |
| 409 | `LIMIT_REACHED` | アダプタの上限（8 台）に達した |
| 409 | `DEVICE_KEY_IN_USE` | 同じデバイスキーの台がある |
| 409 | `PAIR_IN_USE` | 同じ認証 ID の台がある |
| 412 | `REVISION_MISMATCH` | `If-Match` が無い・違う（読み直してから保存してください） |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type: application/json` が無い |
| 422 | `VALIDATION` | 入力の誤り（`details` に項目ごとの理由） |
| 429 | `RATE_LIMITED` | 回数の上限を超えた（`Retry-After` つき） |
| 500 | `INTERNAL` | 想定外の失敗（内容は Node-RED のログだけに出します） |
| 502 | `DEVICE_ERROR` | アダプタが失敗を返した・無線の送信に失敗した |
| 503 | `NOT_CONNECTED`・`PORT_DOWN` | メーターにつながっていない・ポートが開いていない |
| 503 | `NOT_AVAILABLE` | この版の Node-RED では Web UI からアダプタを追加できない |
| 503 | `TOO_MANY_STREAMS` | SSE の本数の上限（`Retry-After` つき） |
| 503 | `SHUTDOWN` | Node-RED やノードを止めるときに、預かった指示を取りやめた（フローの出力 2 の `error` だけに出ます） |
| 504 | `TIMEOUT` | 待ちの上限を過ぎた |

`httpNodeAuth` を設定したサーバーでは、Basic 認証が通らないと Node-RED が 401 を返します（JSON ではありません）。`httpAdminRoot` と `httpNodeRoot` が同じサーバーの、読めない本文の 400 も JSON ではありません。

## エンドポイント

`:id` は設定ノードの id です。

### 読む

| メソッド | パス | 応答 |
|---|---|---|
| GET | `meta` | `Meta` |
| GET | `session` | `{required, loggedIn, canWrite}`。`X-Wsuha-Editor-Token` を読みます。匿名でも、切れたトークンでも 200 です。エディタを別の方法で閉じているサーバーは `{required: true, loggedIn: false, canWrite: false}` です |
| GET | `serialports` | `{items: SerialPortItem[], at, serialportAvailable, serialportMessage}`。`serialport` を読み込めないときは `serialportAvailable` が `false` で、`serialportMessage` に入れ方の案内が入ります |
| GET | `adapters` | `{items: AdapterSummary[], total}`。並びは状態の重い順 → 名前。`total` は `{power, count, enabled, staleCount}` で、無効の台は数えず、値の古い台は `power` から除いて `staleCount` に数えます |
| GET | `adapters/:id` | `AdapterDetail` |
| GET | `adapters/:id/values` | `{items: ValueRow[], at}` |
| GET | `adapters/:id/trend?range=1h` | `{series: {power, currentR, currentT, lqi}, from, to}`。系列は `[[時刻, 値], …]` で、1 系列 720 点まで間引きます。`lqi` は間引くときに枠の中の最小を残します。`range` は `1h`・`6h`・`24h` |
| GET | `adapters/:id/logs?after=<seq>&limit=200&level=info` | `{items: LogRow[], nextSeq, dropped}`。`after` より新しいものを古い順に返します。`limit` は 1〜1000、`level` は `info`・`warn`・`error` |
| GET | `adapters/:id/read?epcs=E7,E8&keys=&maxAgeSec=` | 最新値（下の「読み出し」） |
| GET | `adapters/:id/settings` | `Settings`（`ETag` つき） |
| GET | `adapters/:id/config` | `Config`（`ETag` つき） |
| GET | `stream?adapter=<id>&logs=1` | SSE（下の「SSE」） |

### 変える

| メソッド | パス | 本文 | 応答 |
|---|---|---|---|
| PUT | `adapters/:id/settings` | `{pollIntervalSec?, pollEpcs?, slowIntervalSec?, halfHourIntervalSec?}`（`null` でその項目を外します）。`If-Match` が要ります | `Settings` |
| DELETE | `adapters/:id/settings` | `If-Match` が要ります | 運用設定を全部外した `Settings` |
| PUT | `adapters/:id/config` | 接続の設定の項目（`null` でその項目を外します）。`If-Match` が要ります | `Config` |
| DELETE | `adapters/:id/config` | `If-Match` が要ります | 全部外した `Config` |
| PUT | `adapters/:id/credentials` | `{routeBId, routeBPassword}` | `Config`（値は入りません） |
| DELETE | `adapters/:id/credentials` | — | `Config` |
| POST | `adapters/:id/actions/:action` | 下の表 | `{ok, message, adapter: AdapterDetail}` |
| POST | `adapters/:id/diag` | `{name, args?}` | `{ok, name, at, result}` |
| POST | `adapters` | 下の「アダプタの追加」 | 201 か 202 |

`If-Match` には、読んだときの `rev`（`ETag`）を入れます。運用設定と接続の設定の版は別々です。

範囲:

- `pollIntervalSec` は 15〜3600 の整数、`pollEpcs` は 1〜6 個（`E2`・`E4`・`EC` は不可）
- `slowIntervalSec` は 60〜3600、`halfHourIntervalSec` は 300〜7200
- `name` は 100 文字まで、`role` は 32 文字まで。値の全体が `${…}` か `$(…)` の形のものは断ります（Node-RED が環境変数に置き換えるため）
- `mode` は `serial` か `simulator`、`serialbaud` は 2400・4800・9600・19200・38400・57600・115200
- `expectedMac` は 16 桁の 16 進数か空、`deviceKey` は英数字と `_` `-` で 32 文字までか空
- `scanDurations` は 2〜14 の整数を 1〜8 個
- `routeBId` は 32 桁の 16 進数、`routeBPassword` は 12 桁の英数字

### actions

| action | 本文 | 動き |
|---|---|---|
| `start` | — | 自動運転を始めます。外部の指示の停止も外します |
| `stop` | `{reason}`（1〜200 文字） | 自動運転を止めます。デプロイしても止まったままです |
| `auto` | — | 上書きを全部外して、自動運転に戻します |
| `reconnect` | `{ladder?: 0〜3}` | 段を指定してつなぎ直します。止めているときは 409 `STOPPED_BY_OVERRIDE` |
| `terminate` | — | メーターとのセッションを終了して止めます。待ちの上限は 70 秒です（過ぎると 504 `TIMEOUT`） |
| `poll` | — | 定期的に取りに行く値を今すぐ取ります。取得の途中なら 409 `BUSY`、止めているときは 409 `STOPPED_BY_OVERRIDE` |
| `get` | `{epcs: ['E7', …]}`（1〜6 個） | 指定の値を取ります。応答に `result: ValueRow[]` が入ります。止めているときは 409 `STOPPED_BY_OVERRIDE` |
| `clear-radio-block` | — | 送信制限の扱いを手動で解除します |

電波を使う取得（`get`・`diag` の `epc`・`propmap`）は、1 台につき同時に 1 本までです。重なると 409 `BUSY` です。Web UI の API は預かりません。つながっていなければ、すぐ 503 です（フローの入力は預かります）。止めている台は、ポートが閉じていても 503 でなく 409 `STOPPED_BY_OVERRIDE` です。

### diag

| name | args | 読むもの |
|---|---|---|
| `info` | — | アダプタの情報と版 |
| `table` | `{which: '1' \| '2' \| 'E' \| 'F'}` | アダプタの表 |
| `ropt` | — | 受信の形式 |
| `sreg` | `{reg}` | レジスタ（`S02`・`S03`・`S07`・`S0A`・`S15`・`S16`・`S17`・`SA2`・`SFD`・`SFE`・`SF0`。読むだけです） |
| `propmap` | — | プロパティマップ（電波を使います） |
| `epc` | `{epcs: ['E7', …]}` | 任意の EPC（1〜6 個。`E2`・`E4`・`EC` は不可。電波を使います） |

診断は 1 台あたり 3 秒に 1 回までです。超えると 429 `RATE_LIMITED` です。`result` は `{lines: string[], values?: ValueRow[]}` です。定時積算（`EA`・`EB`）の `lines` の行には、「（確定 YYYY-MM-DD HH:MM）」が付きます（日本時間）。

### アダプタの追加

`POST adapters` の本文の項目は次のとおりです。知らない項目は 422 です。

`role`・`name?`・`mode?`・`serialport`・`serialbaud?`・`deviceKey?`・`expectedMac?`・`autoStart?`・`routeBId?`・`routeBPassword?`

- `role` は必須です。`serialport` は実機のときに要ります。
- 認証情報は、両方入れるか、どちらも入れないかのどちらかです。
- 201 は動き出したとき、202 はフローには追加したが、まだ動いていないときです。どちらも `Location` が付きます。
- 応答は `{ok, message, adapter, nodes: {deviceId, brouteId, tabId, tabLabel, tabCreated}, started, warnings}` です。
- 使えるかどうかは `Meta.addAdapter` で分かります。アダプタは 8 台までです（無効の台も数えます）。

## 読み出し（read）

`GET adapters/:id/read` は、ノードが持っている最新の値を返します。

- `epcs` と `keys` で絞れます。どちらも無ければ全部です。
- `maxAgeSec` が無ければ電波を使わず、誰でも読めます。
- `maxAgeSec` を付けると、それより古い値と無い値だけをメーターへ取りに行ってから返します。全部がそれより新しければ、電波を使わずに返します。

メーターへ取りに行くときは、次の決まりがあります。`maxAgeSec` を付けるなら、いつもこのヘッダーを付けてください。

- `X-Wsuha-Radio: 1` のヘッダーが要ります。無ければ 403 `BAD_ORIGIN` です（画像のタグなどから電波を使わせないためです）。
- `adminAuth` があるサーバーでは、`X-Wsuha-Editor-Token` も要ります。
- `wsuhaBroute.readOnly` のサーバーでは 403 `READ_ONLY` です。
- `epcs` を指定したとき、1 回に取り直すのは 6 個までです。超えると 422 `VALIDATION` です。
- プロパティマップ（0x9F）に無い EPC は取りに行かず、`missing` に入れます。
- つながっていなければ、すぐ 503 です。止めている台は 409 `STOPPED_BY_OVERRIDE` です。
- 1 台 3 秒に 1 回までです。超えると 429 `RATE_LIMITED` です。
- 取得は 1 台につき同時に 1 本までです。重なると 409 `BUSY`、待ちの上限を過ぎると 504 `TIMEOUT` です。

応答の形:

```json
{
  "device": "電力", "deviceKey": "usb0", "ts": "2026-11-07T20:35:32+09:00", "at": 1794051332728, "maxAgeSec": null,
  "values": {
    "instantPower": { "value": 409, "unit": "W", "epc": "E7", "name": "瞬時電力計測値", "label": "瞬時電力", "display": "409 W", "meterAt": null, "at": 1794051326441, "ts": "2026-11-07T20:35:26+09:00", "ageSec": 6.3, "fresh": true }
  },
  "missing": [],
  "refreshed": []
}
```

`missing` はまだ取れていない値、`refreshed` は今回取りに行った EPC です。`label` は計測値の表と同じ短い名前です。`meterAt` は定時積算（`EA`・`EB`）の確定の時刻で、メーターの時計を日本時間として読んだミリ秒です。ほかの値は `null` です（`at` は受信の時刻です）。履歴（`E2`・`E4`・`EC`）を指定すると `missing` に入ります。読めない EPC・知らない名前・65 個以上は 422 `VALIDATION` です。

## SSE

`GET stream` は `text/event-stream` で変化を流します。`?adapter=<id>` を付けるとその 1 台の詳細も流し、さらに `logs=1` でログも流します。

| event | data |
|---|---|
| `hello` | `{serverTime, seq}` |
| `adapters` | `{items: AdapterSummary[], total}`（増減と状態の変化。1 秒に 2 回まで） |
| `adapter` | `AdapterDetail`（`?adapter=` の 1 台。1 秒に 2 回まで） |
| `measurement` | `{adapterId, at, items: ValueRow[]}`（`?adapter=` の 1 台） |
| `log` | `LogRow`（`?adapter=` と `logs=1` のとき） |
| `settings` | `{adapterId, settings: Settings}` |
| `config` | `{adapterId, config: Config}` |
| `reset` | `{}`（取りこぼしを再送できません。全部取り直してください） |

- `id:` は全体の通し番号です。`Last-Event-ID` を付けてつなぎ直すと、それより新しいものを再送します。古すぎるときは `reset` を送ります。
- 20 秒ごとにコメントの行（`: ping`）を送ります。1 本は最長 30 分で閉じます。
- 本数は全体で 32 本、接続元ごとに 8 本までです。超えると 503 `TOO_MANY_STREAMS` と `Retry-After` です。`wsuhaBroute.sse` で変えられます。リバースプロキシの裏では全員が 1 つの接続元に見えます。
- Node-RED が止まるときは、全部閉じます。

## データの形

認証 ID とパスワードは、どの形にも入りません。

```ts
type Health = { level: 'ok'|'busy'|'stale'|'bad'|'stopped'|'idle'|'disabled',
  title: string, reasons: string[], nextAction: string|null }
// ok=計測中 busy=接続中・再接続中 stale=つながっているのに値が古い bad=切断・連続失敗など
// stopped=外部の指示で停止中 idle=停止 disabled=無効

type Meta = { apiVersion: 1, libVersion: string, diskVersion: string, startedAt: number, nodeRed: string|null,
  readOnly: boolean, configLocked: boolean,
  editorRoot: string|null,      // エディタの入口。エディタが無ければ null
  auth: { required: boolean, available: boolean, editorPath: string|null, nodeRoot: string|null },
  addAdapter: { available: boolean, reason: string|null, count: number, limit: number, tabLabel: string,
    envOverrides: boolean, locked: boolean, lockedReason: string|null } }
// libVersion と diskVersion が違うなら、Node-RED の再起動が要ります
// auth.required は変更に認証が要るか（adminAuth があるか、エディタを別の方法で閉じているサーバー）、available はエディタでログインできるか、
// editorPath はエディタの入口（ログインできなければ null）、nodeRoot は `httpNodeRoot` を / で始め / で終わる形にした値です（httpNode が無ければ null）

type Session = { required: boolean, loggedIn: boolean, canWrite: boolean }

type AdapterSummary = {
  id: string, name: string, named: boolean, role: string|null, deviceKey: string, enabled: boolean,
  mode: 'serial'|'simulator', port: string, portLabel: string, consumers: number,
  phase: string, phaseText: string, phaseSince: number|null, health: Health,
  running: boolean, portOpen: boolean, connected: boolean,
  power: { value: number|null, at: number|null, fresh: boolean|null },  // 瞬時電力 [W]。売電は負。fresh が false の台は全台の合計に足さない
  current: { r: number|null, t: number|null, total: number|null, at: number|null },  // 瞬時電流 [A]
  lastValueAt: number|null, stale: boolean,               // stale は lastValueAt（主な値の時刻）が「取得間隔 × 3 + 30 秒」より古いとき。つながってから最初の値を待つ間は古いと言わない
  consecutiveFailures: number, ladder: number,
  overridden: { stopped: { reason: string, at: number|null }|null, any: boolean },
  lqi: number|null, radioBlocked: boolean, keyBlocked: boolean,
  txBudgetMs: number|null, txGuardSec: number|null,
  pendingCommands: { count: number, oldestMs: number|null },
  connectHint: { kind: 'credentials'|'no-meter', since: number|null, rounds: number }|null,   // つながらないときの案内。つながると null
}

type AdapterDetail = AdapterSummary & {
  meter: { addr, ipv6, channel, channelMHz, panid, lqi, rssi, lqiAt, pairId },
  device: { version: string|null, mac: string|null, expectedMac: string|null, macMatches: boolean|null },
  calibration: { coefficient, unitFactor, digits },
  join: { burst, attempt, windows, windowStartedAt, last: { num, sender, elapsedMs, at }|null },
  counters: { tx, rx, failures, timeouts, joins, reconnects, resends, resendRecovered, targetedScans, fullScans },
  sendFails: { busy, noNa, mute, fail },
  pollIntervalSec: number, pollEpcs: string[],              // '0xE7' の形
  snaHold: { [epc: string]: { count, until, at } },         // メーターに断られて、聞くのを休んでいる値
  supportedEpcs: string[], wopt: string|number|null,
  lastError: { message: string, at: number|null, hint: string|null }|null,   // hint は何をすればよいかの 1 行
  credentials: { configured: boolean, source: string|null, pairId: string|null },   // source は下の表
  recordingSince: number|null,   // 今の記録の始まり。このプロセスでこの台が動き始めた時刻で、デプロイでは変わりません。
                                 // 認証情報か接続先を変えて推移を捨てたら、その時刻になります。推移の途切れはここから数えます
  libVersion: string,
}

type ValueRow = { epc: string, key: string|null, name: string, label: string|null,
  value: any, unit: string|null, display: string,
  at: number|null, meterAt: number|null, fresh: boolean,
  held: { until: number, count: number }|null, supported: boolean|null }
// display は機器から届いた文字列を含むので、テキストとして扱ってください
// meterAt は定時積算（EA・EB）の確定の時刻で、メーターの時計を日本時間として読んだミリ秒です

type LogRow = { seq: number, at: number, level: 'debug'|'info'|'good'|'warn'|'error', text: string }

type SettingField = { value: any, source: 'override'|'runtime'|'config'|'default',
  runtimeValue: any|null, configValue: any, default: any,
  min?: number, max?: number, unit?: string, by?: string|null, at?: number|null, tier: 'basic'|'advanced',
  // pollEpcs の選択肢。name は規格の名前、label は計測値の表と同じ短い名前です（Web UI は label || name で出します）。
  // supported はメーターが持っているか（分からなければ null）
  options?: { epc: string, name: string, label: string|null, desc: string, group: string, unit: string|null, supported: boolean|null }[],
  groups?: { id: string, label: string }[],
  takes?: { epc: string, name: string, desc: string }[] }   // 積算と定時積算の間隔で取る値
type Settings = { rev: string, fields: { pollIntervalSec: SettingField, pollEpcs: SettingField,
  slowIntervalSec: SettingField, halfHourIntervalSec: SettingField }, warnings: string[] }

type ConfigField = { label: string, value: any, source: 'runtime'|'config'|'default',
  runtimeValue: any|null, configValue: any, default: any,
  connection: boolean,                      // 変わると、その台だけ接続し直す項目
  by: string|null, at: number|null, tier: 'basic'|'advanced',
  maxLength?: number, values?: number[], min?: number, max?: number, maxItems?: number,
  options?: { value: string, label: string }[] }
type Config = { rev: string,
  fields: { role, name, mode, serialport, enabled, autoStart, serialbaud, deviceKey, expectedMac, scanDurations: ConfigField },
  credentials: { configured: boolean, source: string|null, pairId: string|null, envOverrides: boolean,
    stored: { by: string|null, at: number|null }|null },
  applying: boolean,                     // 開き直しの最中。この間の書き込みは 409 BUSY
  locked: boolean, lockedReason: string|null, warnings: string[] }

type SerialPortItem = { path: string, label: string, manufacturer: string, serialNumber: string,
  vendorId: string, productId: string, byId: boolean, realPath: string, byIdPath: string|null,
  portLabel: string, simulator: boolean, ownedBy: { id: string, name: string }|null,
  kind: 'wsuha'|'maybe'|'other', hint: string|null,
  usedBy: { kind: 'adapter'|'flow', id: string, name: string, type: string }|null, aliases: string[] }
```

`lastValueAt` は、主な値（瞬時電力。取得間隔の値に瞬時電力が無ければ取得間隔の値、取得間隔の値が無ければ 5 分・30 分の値）が最後に届いた時刻です。接続の確認・全部断られた応答・メーターの自発の通知では進みません。

`consecutiveFailures` は連続失敗の回数です。

- 増えるのは、接続の失敗（認証は試行 3 回の 1 巡ごとに 1 回）と、定期の取得が届かず、または送れずにつなぎ直す回です。送信の制限で送れなかった回は数えません。
- 0 に戻るのは、つながっている間に主な値（瞬時電力。取得間隔の値に瞬時電力が無ければ取得間隔の値）が届いたときです。接続が通っただけでは戻らないので、`connected` が `true` でも 1 以上のことがあります。

`SettingField.source` の意味は次のとおりです。

| source | 出どころ |
|---|---|
| `override` | 一時的な上書き（フローの `interval` / `epcs`） |
| `runtime` | 運用設定（Web UI かフローで保存した値） |
| `config` | 設定ノードの値 |
| `default` | 既定値 |

`by` は変えた経路で、`web-ui`・`flow:<ノードの名前か id>`・`editor` のどれかです。

`credentials.source` は認証情報の出どころの名前です。値も秘密ファイルのパスも入りません。

| source | 出どころ |
|---|---|
| `環境変数` | `WSUHA_BROUTE_ID` と `WSUHA_BROUTE_PASSWORD`（`_<キー>` つきを含む） |
| `画面かフローで保存した値` | Web UI かフローの入力 `credentials` で保存した値 |
| `設定ノード` | エディタの設定ノードの値 |
| `ファイル（wsuha-broute-<キー>.secret.json）` | 古い版から移すときの秘密ファイル |
| `シミュレーターの架空の値` | 接続先がシミュレーターで、ほかのどこにも値が無いとき |
| `見つかりません → <探した場所ごとの状態>` | どこにも値が無いとき（値や秘密ファイルのパスは入りません。見分けるときは `configured` を見てください） |

`Health` は、`serialport` を読み込めないときに `level: 'bad'`・`title: 'serialport が入っていません'` で、`nextAction` に入れ方の案内が入ります（「USB が切断されています」とは言いません）。ポートを開けない理由が分かるときの `title` は、「ポートを開く権限がありません」「ほかのプログラムがポートを使っています」です。

`lqi` は、応答を受け取ったときの受信の強さ（RSSI）から ROHM の換算式（RSSI ≒ 0.275 × LQI − 104.27）を逆に解いて求めた近似値です。

## settings.js の wsuhaBroute

| 項目 | 既定 | 効くこと |
|---|---|---|
| `ui` | `true` | `false` で Web UI と API を載せません。ノードとフローの入力は動きます |
| `readOnly` | `false` | `true` で Web UI と API からの変更を全部止めます（403 `READ_ONLY`） |
| `uiConfig` | `true` | `false` で Web UI と API からのアダプタと接続の設定、認証情報の変更、アダプタの追加を止めます（403 `CONFIG_LOCKED`） |
| `uiAddAdapter` | `true` | `false` で Web UI と API からのアダプタの追加を止めます（403 `CONFIG_LOCKED`） |
| `allowAnonymousWrites` | `false` | `true` で、エディタを `adminAuth` 以外の方法で閉じているサーバーの変更を開けます。`adminAuth` のあるサーバーの認証は外しません |
| `allowedHosts` | `[]` | `Host` の許可リストに追加する名前（配列か文字列）。`.` で始めると下の名前も通します。ポートは見ません |
| `sse` | `{ maxConnections: 32, maxPerClient: 8 }` | SSE の本数の上限（全体・接続元ごと）。1〜1000 の整数です |

`Host` は、IP・1 語の名前（`localhost`・`raspberrypi` など）・`.local`・`.localhost`・`.home.arpa`・`.internal`・`.lan`・このホストの名前を既定で通します。

どの項目も、フローの入力とエディタには掛かりません。
