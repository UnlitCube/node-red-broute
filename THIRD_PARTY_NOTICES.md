# 第三者のソフトウェアの通知

このパッケージの Web UI は、次のソフトウェアを `ui/vendor/` に同梱しています。ビルドはしていません。npm の公開レジストリから取り出したファイルを、下の改変だけを加えて配っています。版・元のファイル・ハッシュは `ui/vendor/VERSIONS.json` にあります。

| ソフトウェア | 版 | ライセンス | 同梱のファイル | 許諾文 |
|---|---|---|---|---|
| Preact | 10.29.8 | MIT | `ui/vendor/preact.mjs`・`ui/vendor/hooks.mjs` | `ui/vendor/LICENSES/preact-LICENSE.txt` |
| htm | 3.1.1 | Apache-2.0 | `ui/vendor/htm.mjs` | `ui/vendor/LICENSES/htm-LICENSE.txt` |

## 改変の内容

- `ui/vendor/preact.mjs`: 末尾の `sourceMappingURL` の行を外しました（`.map` は同梱しません）。
- `ui/vendor/hooks.mjs`: import の指定子 `"preact"` を `"./preact.mjs"` に直し、末尾の `sourceMappingURL` の行を外しました。
- `ui/vendor/htm.mjs`: 改変していません。

## 著作権の表示

- Preact: Copyright (c) 2015-present Jason Miller
- htm: Copyright 2018 Google Inc.（Apache License, Version 2.0。全文は上の許諾文にあります）

## 同梱していない依存

`serialport`（MIT）は同梱していません。このパッケージを入れるときに、npm が任意の依存として別に入れます。
