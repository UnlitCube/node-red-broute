'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { LineSplitter } = require('../lib/line-splitter')

const s = (buf) => buf.toString('latin1')

test('CR で区切る', () => {
  const sp = new LineSplitter()
  assert.deepEqual(sp.push(Buffer.from('OK\r')).map(s), ['OK'])
})

test('CRLF 終端の行は CR で切れ、次の行の先頭に LF が残る', () => {
  // SK コマンドの応答はこの形。残った LF は呼び出し側で落とす。
  const sp = new LineSplitter()
  const lines = sp.push(Buffer.from('SKVER\r\nEVER 1.5.2\r\nOK\r\n')).map(s)
  assert.deepEqual(lines, ['SKVER', '\nEVER 1.5.2', '\nOK'])
})

test('CR 終端だけの応答も 1 行として確定する', () => {
  // プロダクト設定コマンド (ROPT/WOPT/RUART/WUART) の応答は CR 終端。
  // LF で区切る実装だと、これが永久に行にならない。
  const sp = new LineSplitter()
  assert.deepEqual(sp.push(Buffer.from('OK 00\r')).map(s), ['OK 00'])
})

test('チャンクが途中で切れても、続きが来れば 1 行になる', () => {
  const sp = new LineSplitter()
  assert.deepEqual(sp.push(Buffer.from('EVER 1.')).map(s), [])
  assert.deepEqual(sp.push(Buffer.from('5.2\r')).map(s), ['EVER 1.5.2'])
})

test('1 回のチャンクに複数行入っていても全部返す', () => {
  const sp = new LineSplitter()
  const lines = sp.push(Buffer.from('EVENT 20 FE80::1 0\r\nEPANDESC\r\n  Channel:3B\r\n')).map(s)
  assert.equal(lines.length, 3)
  assert.equal(lines[0], 'EVENT 20 FE80::1 0')
})

test('バイナリ中の 0x0D で行が割れる (WOPT 01 が必要な理由)', () => {
  // ERXUDP のデータ部がバイナリ表示のままだと、
  // ECHONET のデータに 0x0D が現れた瞬間に行が割れて復元できない。
  const sp = new LineSplitter()
  const payload = Buffer.from([0x10, 0x81, 0x00, 0x0d, 0x02, 0x88])
  const lines = sp.push(Buffer.concat([Buffer.from('ERXUDP ... '), payload, Buffer.from('\r')]))
  assert.equal(lines.length, 2, 'データ中の 0x0D で割れてしまう')
})

test('区切りが来ないまま溜まり続けたら捨てる', () => {
  let dropped = 0
  const sp = new LineSplitter({ maxLineLength: 64, onOverflow: (n) => (dropped = n) })
  sp.push(Buffer.alloc(100, 0x41))
  assert.ok(dropped >= 100, '溜め込み続けないこと')
  // 捨てたあとも正常に動く
  assert.deepEqual(sp.push(Buffer.from('OK\r')).map(s), ['OK'])
})

test('flush で溜まっている分を取り出せる', () => {
  const sp = new LineSplitter()
  // latin1 で比較するので ASCII で書く
  sp.push(Buffer.from('PARTIAL'))
  assert.equal(s(sp.flush()), 'PARTIAL')
  assert.equal(sp.flush(), null)
})
