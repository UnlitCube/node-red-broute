// ui/vendor/: 同梱した Preact・hooks・htm が VERSIONS.json の sha256 と一致し、相対の import だけを持つ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const vendor = path.resolve(here, '../../ui/vendor')
const versions = JSON.parse(fs.readFileSync(path.join(vendor, 'VERSIONS.json'), 'utf8'))

test('VERSIONS.json の sha256 と、同梱したファイルが一致する', () => {
  const names = Object.keys(versions.files)
  assert.deepEqual(names.sort(), ['hooks.mjs', 'htm.mjs', 'preact.mjs'])
  for (const name of names) {
    const buf = fs.readFileSync(path.join(vendor, name))
    const sum = crypto.createHash('sha256').update(buf).digest('hex')
    assert.equal(sum, versions.files[name].sha256, name)
    assert.match(versions.files[name].version, /^\d+\.\d+\.\d+$/)
    assert.match(versions.files[name].integrity, /^sha512-/)
  }
})

test('vendor のファイルは VERSIONS.json に載ったものとライセンスだけ', () => {
  const listed = new Set(Object.keys(versions.files).concat(['VERSIONS.json', 'LICENSES']))
  for (const f of fs.readdirSync(vendor)) assert.ok(listed.has(f), '載っていないファイル: ' + f)
  for (const rel of Object.values(versions.licenses)) {
    const p = path.join(vendor, rel)
    assert.ok(fs.statSync(p).size > 500, 'ライセンス文が短すぎる: ' + rel)
  }
})

test('import は相対だけ（裸の指定子・外部の URL が無い）。sourceMappingURL も無い', () => {
  for (const name of Object.keys(versions.files)) {
    const src = fs.readFileSync(path.join(vendor, name), 'utf8')
    const specs = [...src.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map((m) => m[1])
    for (const s of specs) assert.ok(s.startsWith('./'), `${name}: ${s}`)
    assert.equal(/sourceMappingURL/.test(src), false, name)
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(src), false, name + ' に外部の URL がある')
  }
})

test('Preact・hooks・htm を Node からも読み込め、htm で要素を組める', async () => {
  const preact = await import(pathToFileURL(path.join(vendor, 'preact.mjs')).href)
  const hooks = await import(pathToFileURL(path.join(vendor, 'hooks.mjs')).href)
  const htm = (await import(pathToFileURL(path.join(vendor, 'htm.mjs')).href)).default
  for (const k of ['h', 'render', 'Fragment', 'createContext']) assert.equal(typeof preact[k] === 'function' || typeof preact[k] === 'object', true, k)
  for (const k of ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useReducer', 'useLayoutEffect', 'useContext']) assert.equal(typeof hooks[k], 'function', k)
  const html = htm.bind(preact.h)
  const v = html`<p class="x">${'<b>値</b>'}</p>`
  assert.equal(v.type, 'p')
  assert.equal(v.props.class, 'x')
  assert.equal(v.props.children, '<b>値</b>') // 値は子の文字列のまま（HTML として読まれない）
})
