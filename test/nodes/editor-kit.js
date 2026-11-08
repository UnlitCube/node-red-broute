'use strict'

// 編集画面（nodes/*.html の <script>）を動かす偽の jQuery と、偽の RED.tabs。
// DOM は値と表示の有無だけを持つ偽物なので、見た目と本物の jQuery の動きは本物のエディタで確かめる。
// ここは test/nodes/*.test.js の glob に入らない名前にしてある（試験そのものではない）。

/** getJSON の応答を失敗にする印（未デプロイの設定ノードの 404 など）。 */
const FAIL = Symbol('getJSON の失敗')

/** 偽の要素。text は子を含めた文字列。 */
function makeEl(tag) {
  const el = {
    tag,
    attrs: {},
    props: {},
    ownText: '',
    children: [],
    visible: true,
    value: '',
    handlers: {},
    get textAll() {
      return this.ownText + this.children.map((c) => c.textAll).join('')
    },
  }
  return el
}

/** テンプレートの中で、最初から隠してある要素の #id。 */
function hiddenIds(html) {
  const out = new Set()
  for (const m of String(html || '').matchAll(/<\w+\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])
    if (id && /display:\s*none/.test(m[0])) out.add('#' + id[1])
  }
  return out
}

/**
 * @param {function} json URL から応答を返す（undefined は応答なし、FAIL は失敗）
 * @param {object} [opts] {html}: テンプレート。display:none の要素は隠した状態で始める（本物と同じ）
 */
function makeJq(json, opts) {
  const els = new Map()
  const calls = []
  const hidden = hiddenIds(opts && opts.html)
  function get(sel) {
    if (!els.has(sel)) {
      const el = makeEl(sel)
      if (hidden.has(sel)) el.visible = false
      els.set(sel, el)
    }
    return els.get(sel)
  }
  function wrap(el) {
    const w = {
      el,
      attr(k, v) {
        if (v === undefined) return el.attrs[k]
        el.attrs[k] = v
        return w
      },
      text(v) {
        if (v === undefined) return el.textAll
        el.ownText = String(v)
        el.children = []
        return w
      },
      empty() {
        el.ownText = ''
        el.children = []
        return w
      },
      append(child) {
        el.children.push(child.el)
        return w
      },
      hide() {
        el.visible = false
        return w
      },
      show() {
        el.visible = true
        return w
      },
      toggle(on) {
        el.visible = on === undefined ? !el.visible : !!on
        return w
      },
      on(ev, fn) {
        for (const e of String(ev).split(/\s+/)) el.handlers[e] = fn
        return w
      },
      val(v) {
        if (v === undefined) return el.value
        el.value = v
        return w
      },
      prop(k, v) {
        if (v === undefined) return el.props[k]
        el.props[k] = v
        return w
      },
      addClass(c) {
        el.attrs.class = ((el.attrs.class || '') + ' ' + c).trim()
        return w
      },
      removeClass(c) {
        el.attrs.class = String(el.attrs.class || '').split(/\s+/).filter((x) => x !== c).join(' ')
        return w
      },
      trigger() {
        return w
      },
      children() {
        return wrap(makeEl(el.tag + '>*'))
      },
      autocomplete(o, arg) {
        if (o && typeof o === 'object') el.props.autocomplete = o
        else if (o === 'search') el.props.autocompleteSearch = arg
        return w
      },
    }
    return w
  }
  const $ = (sel) => {
    if (typeof sel === 'string' && /^<(\w+)>$/.test(sel)) return wrap(makeEl(sel.slice(1, -1)))
    return wrap(get(sel))
  }
  $.getJSON = (url, cb) => {
    calls.push(url)
    const r = json(url)
    if (r !== undefined && r !== FAIL) cb(r)
    return {
      fail(fn) {
        if (r === FAIL) fn()
      },
    }
  }
  return { $, get, calls }
}

/** 偽の RED.tabs。作ったタブと、名前の変更を覚える（RED.tabs.create の代わりに渡す）。 */
function makeTabs() {
  const t = {
    id: null,
    onchange: null,
    added: [],
    names: {},
    create(o) {
      t.id = o.id
      t.onchange = o.onchange
      return {
        addTab(tab) {
          t.added.push(tab)
          t.names[tab.id] = tab.label
        },
        renameTab(id, label) {
          t.names[id] = label
        },
        resize() {},
      }
    },
  }
  return t
}

/** テンプレートの中の、ある要素（id）の開始タグから閉じるまでの文字列。同じ名前のタグの入れ子を数える。 */
function elementOf(html, id) {
  const open = new RegExp('<(\\w+)\\b[^>]*\\bid="' + id + '"[^>]*>').exec(html)
  if (!open) return ''
  const tag = open[1]
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '>', 'g')
  re.lastIndex = open.index
  let depth = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(open.index, m.index + m[0].length)
  }
  return html.slice(open.index)
}

/**
 * Font Awesome 4.7 の名前か（エディタが持っているのは 4.7。無い名前は黙って空の四角になる）。
 * ノードで使ってよいものだけを並べる。足すときは 4.7 にあることを確かめてから。
 */
const FA_47 = new Set([
  'fa-angle-down', 'fa-angle-right', 'fa-barcode', 'fa-bell', 'fa-bolt', 'fa-clock-o', 'fa-cogs', 'fa-exchange',
  'fa-exclamation-triangle', 'fa-external-link', 'fa-file-text-o', 'fa-hashtag', 'fa-hourglass', 'fa-hourglass-half',
  'fa-id-card-o', 'fa-key', 'fa-line-chart', 'fa-list', 'fa-list-alt', 'fa-microchip', 'fa-play', 'fa-plug', 'fa-power-off',
  'fa-random', 'fa-search', 'fa-tachometer', 'fa-tag',
])

/** HTML の中の fa-* の名前のうち、4.7 の許可リストに無いもの。 */
function unknownFa(html) {
  return Array.from(new Set(html.match(/\bfa-[a-z0-9-]+/g) || [])).filter((c) => !FA_47.has(c))
}

module.exports = { FAIL, makeEl, makeJq, makeTabs, elementOf, unknownFa }
