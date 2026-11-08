// 色トークンのコントラストを計算で確かめる（目視で決めない）。
// - tokens.css をテーマのブロックごとに読み、var() と color-mix() を解いてから比を出す。
// - 対の表に無い組み合わせは検査されないので、使う組を足したら表にも足す。
// - 負の対照: わざと低い値を入れた CSS で、検査が落ちることも確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../../ui')
// core.autocrlf=true で clone すると CSS は CRLF になる。試験の前提を改行に頼らない
const readCss = (name) => fs.readFileSync(path.join(uiDir, name), 'utf8').split(String.fromCharCode(13)).join('')
const tokensCss = readCss('styles/tokens.css')
const appCss = readCss('styles/app.css')

// ---- CSS の小さな読み取り ---------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** セレクタ（完全一致）の直後の { … } の中身の宣言を返す。 */
function block(css, selectorStart) {
  const src = stripComments(css)
  const i = src.indexOf(selectorStart)
  if (i < 0) throw new Error('ブロックが見つからない: ' + selectorStart)
  const open = src.indexOf('{', i)
  const close = src.indexOf('}', open)
  return decls(src.slice(open + 1, close))
}

function decls(body) {
  const out = {}
  for (const part of body.split(';')) {
    const m = part.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** テーマで変わらない :root のブロック（color-mix の薄い面を含む）を全部まとめる。 */
function sharedRootDecls(css) {
  const src = stripComments(css)
  const out = {}
  // 直前の } を消費しない（続けて並んだ :root のブロックも拾う）
  const re = /(?<=^|\})\s*:root\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(src))) Object.assign(out, decls(m[1]))
  return out
}

function themes(css) {
  const shared = sharedRootDecls(css)
  const light = block(css, ":root,\n:root[data-theme='light']")
  const darkMedia = block(css, ":root:not([data-theme='light'])")
  const src = stripComments(css)
  const idx = src.lastIndexOf(":root[data-theme='dark']")
  const darkManual = decls(src.slice(src.indexOf('{', idx) + 1, src.indexOf('}', idx)))
  return {
    light: Object.assign({}, shared, light),
    dark: Object.assign({}, shared, darkMedia),
    darkMedia,
    darkManual,
    lightRaw: light,
  }
}

// ---- 色の計算 ---------------------------------------------------------------

function parseColor(s) {
  s = s.trim().toLowerCase()
  let m = s.match(/^#([0-9a-f]{6})$/)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  throw new Error('読めない色: ' + s)
}

function resolve(theme, value, depth = 0) {
  if (depth > 10) throw new Error('var() が循環している: ' + value)
  const v = value.trim()
  const ref = v.match(/^var\((--[\w-]+)\)$/)
  if (ref) {
    if (!(ref[1] in theme)) throw new Error('未定義のトークン: ' + ref[1])
    return resolve(theme, theme[ref[1]], depth + 1)
  }
  return v
}

/** color-mix(in srgb, A p%, transparent) を返す（不透明度 p の A）。 */
function color(theme, name) {
  if (!(name in theme)) throw new Error('未定義のトークン: ' + name)
  const v = resolve(theme, theme[name])
  const mix = v.match(/^color-mix\(in srgb,\s*(var\(--[\w-]+\)|#[0-9a-f]{6})\s+(var\(--[\w-]+\)|[\d.]+%)\s*,\s*transparent\)$/i)
  if (mix) {
    const base = parseColor(resolve(theme, mix[1]))
    const pct = parseFloat(resolve(theme, mix[2])) / 100
    return { r: base.r, g: base.g, b: base.b, a: pct }
  }
  return parseColor(v)
}

function over(fg, bg) {
  const a = fg.a
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
}

function lum(c) {
  const f = (v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** fg（不透明）を bg の上で。bg は「面」か「面に重ねた薄い面」。 */
function pairRatio(theme, fgName, bgSpec) {
  const [softName, baseName] = bgSpec.split(' on ')
  let bg = color(theme, baseName || softName)
  if (baseName) bg = over(color(theme, softName), bg)
  let fg = color(theme, fgName)
  if (fg.a < 1) fg = over(fg, bg)
  return ratio(fg, bg)
}

// ---- 対の表 -----------------------------------------------------------------

const SURFACES = ['--bg', '--surface', '--surface-raised', '--surface-inset', '--header-bg']
const TONES = ['ok', 'warn', 'stale', 'danger', 'info', 'neutral', 'export']

function pairs() {
  const list = []
  for (const s of SURFACES) {
    for (const fg of ['--text', '--text-dim', '--accent-text']) list.push({ fg, bg: s, min: 4.5 })
    for (const t of TONES) list.push({ fg: '--' + t, bg: s, min: 4.5 })
    list.push({ fg: '--border-input', bg: s, min: 3 })
    list.push({ fg: '--focus', bg: s, min: 3 })
  }
  // 状態の文字は、自分の薄い面の上でも読める（ピル・帯）
  for (const t of TONES) {
    for (const s of ['--surface', '--bg', '--surface-raised']) list.push({ fg: '--' + t, bg: `--${t}-soft on ${s}`, min: 4.5 })
  }
  list.push({ fg: '--text', bg: '--accent-soft on --surface', min: 4.5 })
  // 診断の失敗の結果（結果の一覧の項目・押したカードの直近の結果の行）の本文と時刻（muted）
  for (const fg of ['--text', '--text-dim']) list.push({ fg, bg: '--danger-soft on --surface', min: 4.5 })
  list.push({ fg: '--accent-text', bg: '--accent-soft on --surface', min: 4.5 })
  // 塗りの上の白い文字（ボタン・トースト・注意の確認ボタン）
  for (const solid of ['--accent', '--accent-hover', '--ok-solid', '--warn-solid', '--stale-solid', '--danger-solid', '--danger-solid-hover', '--info-solid', '--neutral-solid']) {
    list.push({ fg: '--on-solid', bg: solid, min: 4.5 })
  }
  // グラフの線（非テキスト）
  for (const s of ['--surface', '--surface-raised']) {
    for (const fg of ['--chart-power', '--chart-r', '--chart-t', '--chart-lqi', '--export-solid']) list.push({ fg, bg: s, min: 3 })
  }
  // 状態タブ（右ペインは --bg の上。一覧の面と同じ --surface でも読める）:
  // - 再接続のいまの段の行（警告・中立の薄い面）の名前と説明
  // - ステッパーの丸（済み・いまの段・失敗の塗りと枠、まだの段の枠）と、送信積算の棒（塗りと休む線を、棒の溝の上で）は非テキスト 3:1
  for (const s of ['--bg', '--surface']) {
    for (const soft of ['--warn-soft', '--neutral-soft']) for (const fg of ['--text', '--text-dim']) list.push({ fg, bg: `${soft} on ${s}`, min: 4.5 })
    for (const fg of ['--ok-solid', '--warn-solid', '--danger-solid', '--border-input']) list.push({ fg, bg: s, min: 3 })
  }
  for (const fg of ['--ok-solid', '--warn-solid', '--danger-solid', '--text']) list.push({ fg, bg: '--surface-inset', min: 3 })
  // 契約のバッジ: 一覧の面・右ペインの面と、自分の薄い面の上で文字が読める
  for (const r of ['--role-light', '--role-motive']) {
    for (const s of ['--surface', '--bg', '--surface-raised']) {
      list.push({ fg: r, bg: s, min: 4.5 })
      list.push({ fg: r, bg: `${r}-soft on ${s}`, min: 4.5 })
    }
  }
  return list
}

function check(css) {
  const t = themes(css)
  const failures = []
  for (const name of ['light', 'dark']) {
    for (const p of pairs()) {
      const r = pairRatio(t[name], p.fg, p.bg)
      if (!(r >= p.min)) failures.push(`${name}: ${p.fg} on ${p.bg} = ${r.toFixed(2)} (< ${p.min})`)
    }
  }
  return failures
}

test('全テーマ × 全面でコントラストが基準を満たす', () => {
  const failures = check(tokensCss)
  assert.deepEqual(failures, [])
})

test('負の対照: 本文の色を薄くすると検査が落ちる', () => {
  const broken = tokensCss.replace('--text-dim: #4c5468;', '--text-dim: #a0a6b4;')
  assert.notEqual(broken, tokensCss)
  const failures = check(broken)
  assert.ok(failures.some((f) => f.startsWith('light: --text-dim')), failures.join('\n'))
})

test('手で選んだダークと OS のダークで、値が同じ', () => {
  const t = themes(tokensCss)
  assert.deepEqual(t.darkManual, t.darkMedia)
})

test('ライトとダークで、定義している変数の集合が同じ', () => {
  const t = themes(tokensCss)
  assert.deepEqual(Object.keys(t.darkMedia).sort(), Object.keys(t.lightRaw).sort())
})

test('app.css に生の色が無く、参照している var() がすべて定義済み', () => {
  const src = stripComments(appCss)
  const raw = src.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)
  assert.equal(raw, null, '生の色: ' + (raw || []).join(', '))
  const t = themes(tokensCss)
  const defined = new Set(Object.keys(t.light))
  // app.css の中で定義する変数（部品の中の局所の変数）も許す
  for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
  const used = new Set([...src.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
  const missing = [...used].filter((n) => !defined.has(n))
  assert.deepEqual(missing, [])
})

test('テーマの保存キーが、初回描画のスクリプトと app.js で同じ', () => {
  const init = fs.readFileSync(path.join(uiDir, 'theme-init.js'), 'utf8')
  const app = fs.readFileSync(path.join(uiDir, 'app.js'), 'utf8')
  assert.match(init, /'wsuha-broute:theme'/)
  assert.match(app, /THEME_KEY = 'wsuha-broute:theme'/)
})

// スマホのアドレスバーの色は上の帯と同じにする。app.js の applyTheme は明示のテーマで帯の色へ書き換え、system でこの 2 本へ戻す。
// 戻すと落ちるもの: tokens.css の --header-bg だけを変える
test('theme-color の 2 本は、ライトとダークの上の帯の色と同じ', () => {
  const index = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8')
  const meta = (scheme) => new RegExp('name="theme-color" media="\\(prefers-color-scheme: ' + scheme + '\\)" content="(#[0-9a-fA-F]+)"').exec(index)[1]
  const headerBg = [...stripComments(tokensCss).matchAll(/--header-bg:\s*(#[0-9a-fA-F]+)/g)].map((m) => m[1])
  assert.equal(headerBg.length, 3, 'ライト・OS のダーク・明示のダーク')
  assert.equal(meta('light'), headerBg[0])
  assert.equal(meta('dark'), headerBg[1])
  assert.equal(headerBg[2], headerBg[1])
})
