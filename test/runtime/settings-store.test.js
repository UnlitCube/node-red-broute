'use strict'

// 運用設定のファイル（lib/runtime/settings-store.js）。
// 原子的な書き込み・壊れたファイル・If-Match・configAtSet の規則・入力の検査。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createSettingsStore, validateSettingsInput, RevisionMismatch } = require('../../lib/runtime/settings-store')
const { tmpDir } = require('./fake-red')

function setup() {
  const dir = tmpDir('wsuha-store-')
  const file = path.join(dir, 'wsuha-broute', 'settings.json')
  const logs = []
  const store = createSettingsStore({ file, log: (l, t) => logs.push([l, t]) })
  return { dir, file, store, logs }
}

const CFG = { pollIntervalSec: '30', pollEpcs: 'E7', slowIntervalSec: null, halfHourIntervalSec: null }

test('書くときは .tmp に書いて rename し、前の版を .bak に残す', () => {
  const { file, store } = setup()
  assert.equal(store.rev('a'), '0', '記録が無ければ rev は 0')
  const r1 = store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: CFG, by: 'dev' })
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.existsSync(file + '.tmp'), '.tmp を残さない')
  assert.ok(!fs.existsSync(file + '.bak'), '初回は前の版が無い')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.deepEqual(onDisk.adapters.a.fields.pollIntervalSec.value, 60)
  assert.equal(onDisk.adapters.a.fields.pollIntervalSec.configAtSet, 30, '保存したときの設定ノードの値')
  assert.equal(onDisk.adapters.a.updatedBy, 'dev')

  const r2 = store.update('a', { ifMatch: r1.rev, changes: { pollEpcs: ['0xE7', '0xE8'] }, configValues: CFG, by: 'op' })
  assert.notEqual(r2.rev, r1.rev, '保存のたびに rev が変わる')
  const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'))
  assert.equal(bak.adapters.a.rev, r1.rev, '前の版が .bak にある')
  // 別のインスタンス（再起動）で読める
  const again = createSettingsStore({ file })
  assert.equal(again.rev('a'), r2.rev)
  assert.deepEqual(again.get('a').fields.pollEpcs.value, ['0xE7', '0xE8'])
})

test('ディレクトリ 700・ファイル 600（POSIX のみ）', { skip: process.platform === 'win32' ? 'Windows はファイルの権限ビットを持たない' : false }, () => {
  const { file, store } = setup()
  store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: CFG })
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('If-Match が違えば REVISION_MISMATCH で、ファイルは変えない', () => {
  const { file, store } = setup()
  const r1 = store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: CFG })
  const before = fs.readFileSync(file)
  assert.throws(() => store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 90 }, configValues: CFG }), RevisionMismatch)
  assert.throws(() => store.update('a', { ifMatch: undefined, changes: { pollIntervalSec: 90 }, configValues: CFG }), (e) => e.code === 'REVISION_MISMATCH')
  assert.throws(() => store.clear('a', { ifMatch: 'xyz' }), RevisionMismatch)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(store.rev('a'), r1.rev)
})

test('全部外しても記録は残し、古い rev の書き込みを断れる（ABA を起こさない）', () => {
  const { store } = setup()
  const r0 = store.rev('a')
  const r1 = store.update('a', { ifMatch: r0, changes: { pollIntervalSec: 60 }, configValues: CFG })
  const r2 = store.clear('a', { ifMatch: r1.rev })
  assert.deepEqual(r2.fields, {})
  assert.notEqual(r2.rev, '0')
  assert.throws(() => store.update('a', { ifMatch: r0, changes: { pollIntervalSec: 90 }, configValues: CFG }), RevisionMismatch)
})

test('null を渡した項目だけ外す', () => {
  const { store } = setup()
  const r1 = store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60, slowIntervalSec: 600 }, configValues: CFG })
  const r2 = store.update('a', { ifMatch: r1.rev, changes: { pollIntervalSec: null }, configValues: CFG })
  assert.deepEqual(Object.keys(r2.fields), ['slowIntervalSec'])
})

test('壊れたファイルは .bad-<日時> に退避して空で始める（止まらない）', () => {
  const { file, logs } = setup()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ 壊れている')
  const store = createSettingsStore({ file, log: (l, t) => logs.push([l, t]) })
  assert.equal(store.get('a'), null)
  const bad = fs.readdirSync(path.dirname(file)).filter((f) => /^settings\.json\.bad-\d{8}-\d{6}$/.test(f))
  assert.equal(bad.length, 1, '退避したファイルが 1 つある')
  assert.ok(!fs.existsSync(file), '元の場所には残さない')
  assert.ok(logs.some(([l, t]) => l === 'warn' && /壊れていた/.test(t)))
  // そのまま書ける
  store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: CFG })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).adapters.a.fields.pollIntervalSec.value, 60)
})

test('形の違うファイル（版が違う）も退避する。1 台ぶんだけ壊れていたらその台だけ読み飛ばす', () => {
  const a = setup()
  fs.mkdirSync(path.dirname(a.file), { recursive: true })
  fs.writeFileSync(a.file, JSON.stringify({ version: 99, adapters: {} }))
  createSettingsStore({ file: a.file }).get('x')
  assert.ok(fs.readdirSync(path.dirname(a.file)).some((f) => f.startsWith('settings.json.bad-')))

  const b = setup()
  fs.mkdirSync(path.dirname(b.file), { recursive: true })
  fs.writeFileSync(
    b.file,
    JSON.stringify({
      version: 1,
      adapters: {
        good: { rev: 'r1', fields: { pollIntervalSec: { value: 60, configAtSet: 30 } } },
        bad: { rev: 5, fields: 'x' },
      },
    })
  )
  const s = createSettingsStore({ file: b.file, log: (l, t) => b.logs.push([l, t]) })
  assert.equal(s.get('good').fields.pollIntervalSec.value, 60)
  assert.equal(s.get('bad'), null)
  assert.ok(b.logs.some(([, t]) => /bad の記録が壊れていた/.test(t)))
})

test('configAtSet と今の設定ノードの値が違う項目は、起動時の照合で外す', () => {
  const { file, store } = setup()
  const r1 = store.update('a', {
    ifMatch: '0',
    changes: { pollIntervalSec: 60, pollEpcs: ['0xE7', '0xE8'], slowIntervalSec: 600 },
    configValues: CFG,
  })
  // 同じ値なら何もしない（'E7' と ['0xE7'] のような書き方の違いは同じとみなす）
  assert.deepEqual(store.reconcile('a', { pollIntervalSec: 30, pollEpcs: '0xE7', slowIntervalSec: '' }), [])
  assert.equal(store.rev('a'), r1.rev)
  // エディタで取得間隔だけ 45 秒に変えた
  const dropped = store.reconcile('a', { pollIntervalSec: '45', pollEpcs: 'E7', slowIntervalSec: null })
  assert.deepEqual(dropped.map((d) => d.field), ['pollIntervalSec'])
  assert.equal(dropped[0].configAtSet, 30)
  assert.equal(dropped[0].configNow, 45)
  assert.deepEqual(Object.keys(store.get('a').fields).sort(), ['pollEpcs', 'slowIntervalSec'])
  assert.notEqual(store.rev('a'), r1.rev, '外したら保存して rev を進める')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).adapters.a
  assert.deepEqual(Object.keys(disk.fields).sort(), ['pollEpcs', 'slowIntervalSec'])
  assert.equal(disk.updatedBy, 'editor', '外した経路は editor（人ではなく経路を書く）')
  // 5 分の間隔（2.0 で設定ノードに足した欄）も照合する。エディタで 900 秒を入れた
  const d2 = store.reconcile('a', { pollIntervalSec: '45', pollEpcs: 'E7', slowIntervalSec: '900' })
  assert.deepEqual(d2.map((d) => d.field), ['slowIntervalSec'])
  assert.equal(d2[0].configAtSet, null)
  assert.equal(d2[0].configNow, 900)
})

test('保存先が無い（userDir が分からない）ときはメモリだけで動く', () => {
  const store = createSettingsStore({ file: null })
  const r = store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: CFG })
  assert.equal(store.get('a').rev, r.rev)
})

test('書けなかったら前の状態のまま（メモリも変えない）', () => {
  const { dir } = setup()
  // ファイルの置き場所に同名のファイルを置いて、ディレクトリを作れなくする
  const blocker = path.join(dir, 'blocked')
  fs.writeFileSync(blocker, 'x')
  const store = createSettingsStore({ file: path.join(blocker, 'settings.json') })
  assert.throws(() => store.update('a', { ifMatch: '0', changes: { pollIntervalSec: 60 }, configValues: CFG }))
  assert.equal(store.get('a'), null)
  assert.equal(store.rev('a'), '0')
})

test('入力の検査（PUT の本文）', () => {
  const ok = validateSettingsInput({ pollIntervalSec: 60, pollEpcs: ['E7', '0xE8'], slowIntervalSec: '600', halfHourIntervalSec: null })
  assert.deepEqual(ok.errors, {})
  assert.deepEqual(ok.changes, { pollIntervalSec: 60, pollEpcs: ['0xE7', '0xE8'], slowIntervalSec: 600, halfHourIntervalSec: null })

  const cases = [
    [{ pollIntervalSec: 14 }, 'pollIntervalSec'],
    [{ pollIntervalSec: 3601 }, 'pollIntervalSec'],
    [{ pollIntervalSec: 30.5 }, 'pollIntervalSec'],
    [{ pollIntervalSec: '3e1' }, 'pollIntervalSec'],
    [{ pollIntervalSec: true }, 'pollIntervalSec'],
    [{ pollEpcs: [] }, 'pollEpcs'],
    [{ pollEpcs: ['E7', 'E8', 'E0', 'E3', '80', '88', 'D3'] }, 'pollEpcs'],
    [{ pollEpcs: ['E2'] }, 'pollEpcs'],
    [{ pollEpcs: ['E4'] }, 'pollEpcs'],
    [{ pollEpcs: ['EC'] }, 'pollEpcs'],
    [{ pollEpcs: ['ZZ'] }, 'pollEpcs'],
    [{ pollEpcs: ['E7', 'e7'] }, 'pollEpcs'],
    [{ pollEpcs: 'E7' }, 'pollEpcs'],
    [{ slowIntervalSec: 59 }, 'slowIntervalSec'],
    [{ slowIntervalSec: 3601 }, 'slowIntervalSec'],
    [{ halfHourIntervalSec: 299 }, 'halfHourIntervalSec'],
    [{ halfHourIntervalSec: 7201 }, 'halfHourIntervalSec'],
    [{ password: 'x' }, 'password'],
    [{}, '_'],
  ]
  for (const [body, field] of cases) {
    const r = validateSettingsInput(body)
    assert.ok(r.errors[field], `${JSON.stringify(body)} は ${field} の誤り`)
  }
  assert.ok(validateSettingsInput(null).errors._)
  assert.ok(validateSettingsInput([1]).errors._)
})
