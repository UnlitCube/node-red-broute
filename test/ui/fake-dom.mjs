// 試験用の小さな偽の DOM（jsdom は依存に無く、足さない）。
// 同梱の Preact 10 が使う範囲（createElementNS・createTextNode・insertBefore・removeChild・属性・
// addEventListener・nextSibling など）と、試験で要るもの（textContent・querySelectorAll・
// scrollIntoView の記録・focus）だけを持つ。レイアウトは無い（幅や横スクロールはここでは測れない）。
//
// 使い方:
//   import { installDom, mount, click, typeInto, settle, $, $$, textOf } from './fake-dom.mjs'
//   installDom()                         // 最初の import より前に（Preact は読み込み時に requestAnimationFrame の有無を見る）
//   const m = await mount(html`<${Comp} … />`)
//   click($(m.root, 'button.btn-primary')); await settle()
//   await m.unmount()                    // useNow の 1 秒の時計を止める（止めないと試験のプロセスが終わらない）
//
// focus() は本物と同じく、フォーカスできない要素では何も起こさない（span・disabled・閉じた details の中・hidden の中・モーダルの外）。
// showModal() は [autofocus] か最初の押せる要素へ当て、close() は開く前の要素へ戻す。何にでも当たる偽物だと、
// 閉じた詳細設定の中の欄や span へのフォーカスが緑のまま通る。
//
// 要素を assert.equal / deepEqual にそのまま渡さない（assert.equal(!!$(root, sel), false) のように真偽にする）。
// 失敗したとき AssertionError が要素を customInspect なし・深さ 1000 で調べ、循環した DOM 全体をたどって止まる
// （1 件の失敗が 90 秒以上終わらないことがある）。
//
// settle() は決まった時間を待ったあと、Preact の描画と useEffect が残っていれば、無くなるまで待ち足す。
// 並列で流して CPU が足りないと、「送る → 誤りを描く → 詳細設定を開く（useEffect）→ 開いたあとでフォーカス（useEffect）」の
// ような連なりが決まった時間に収まらず、途中の状態を見て赤になる。「動かない」ことを見る試験も、連なりが終わる前に見ると
// 守れていないのに緑になる。そこで描画（options.debounceRendering）と useEffect の flush（options.requestAnimationFrame）を数える。
// 張り方は Preact の既定と同じ（描画はマイクロタスク、useEffect は 35ms の setTimeout のあとの setTimeout）なので、順は変わらない。

import { options as preactOptions } from '../../ui/vendor/preact.mjs'
import waitKit from '../wait-kit.js'

const HTML_NS = 'http://www.w3.org/1999/xhtml'

/** まだ済んでいない Preact の描画と useEffect の flush の数。 */
let preactPending = 0
preactOptions.debounceRendering = (run) => {
  preactPending++
  Promise.resolve().then(() => {
    preactPending--
    run()
  })
}
preactOptions.requestAnimationFrame = (flush) => {
  preactPending++
  setTimeout(() => {
    setTimeout(() => {
      preactPending--
      flush()
    })
  }, 35)
}

class FakeNode {
  constructor(doc, nodeType) {
    this.ownerDocument = doc
    this.nodeType = nodeType
    this.childNodes = []
    this.parentNode = null
  }

  get firstChild() {
    return this.childNodes.length ? this.childNodes[0] : null
  }

  get lastChild() {
    return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const s = this.parentNode.childNodes
    const i = s.indexOf(this)
    return i >= 0 && i + 1 < s.length ? s[i + 1] : null
  }

  get previousSibling() {
    if (!this.parentNode) return null
    const s = this.parentNode.childNodes
    const i = s.indexOf(this)
    return i > 0 ? s[i - 1] : null
  }

  appendChild(child) {
    return this.insertBefore(child, null)
  }

  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child)
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i < 0) this.childNodes.push(child)
    else this.childNodes.splice(i, 0, child)
    child.parentNode = this
    return child
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true
    return false
  }

  get textContent() {
    if (this.nodeType === 3) return this.data
    return this.childNodes.map((c) => c.textContent).join('')
  }

  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (v !== null && v !== undefined && v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v)))
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc, 3)
    this.data = String(data)
  }

  get nodeName() {
    return '#text'
  }
}

/** Preact は「'on' + 小文字の名前」が要素にあるかで、イベント名の大文字小文字を決める。 */
const EVENT_PROPS = ['onclick', 'oninput', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onblur', 'onfocus', 'onpointerdown', 'onpointermove', 'onpointerup', 'onpointercancel', 'onpointerleave', 'oncancel', 'onclose', 'ontoggle']

const NATURALLY_FOCUSABLE = ['input', 'select', 'textarea', 'button', 'summary']

/** ブラウザがフォーカスを当てられる要素か。 */
function isFocusable(el) {
  const doc = el.ownerDocument
  if (!NATURALLY_FOCUSABLE.includes(el.localName) && !(el.localName === 'a' && el.hasAttribute('href')) && !el.hasAttribute('tabindex')) return false
  if (el.hasAttribute('disabled')) return false
  let inner = null
  for (let n = el; n && n.nodeType === 1; inner = n, n = n.parentNode) {
    if (n.hasAttribute('hidden')) return false
    if (n.localName === 'dialog' && !n.hasAttribute('open')) return false
    if (n.localName === 'details' && !n.hasAttribute('open') && (!inner || inner.localName !== 'summary')) return false
  }
  // モーダルの外は inert。DOM から外された <dialog> はモーダルでなくなる
  doc.modals = doc.modals.filter((m) => doc.contains(m.el))
  const top = doc.modals[doc.modals.length - 1]
  return !top || top.el.contains(el)
}

class FakeElement extends FakeNode {
  constructor(doc, ns, tag) {
    super(doc, 1)
    this.namespaceURI = ns || HTML_NS
    this.localName = String(tag).toLowerCase()
    this.tagName = String(tag).toUpperCase()
    this._attrs = new Map()
    this._listeners = new Map()
    this._value = undefined
    this._checked = undefined
    this.style = { cssText: '', setProperty() {}, removeProperty() {} }
  }

  get nodeName() {
    return this.tagName
  }

  setAttribute(name, value) {
    this._attrs.set(String(name), String(value))
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null
  }

  hasAttribute(name) {
    return this._attrs.has(name)
  }

  removeAttribute(name) {
    this._attrs.delete(name)
  }

  get attributes() {
    return [...this._attrs].map(([name, value]) => ({ name, value }))
  }

  // value・checked・open は Preact がプロパティとして入れる（'value' in dom が真）
  get value() {
    return this._value !== undefined ? this._value : this.getAttribute('value') || ''
  }

  set value(v) {
    this._value = v === null || v === undefined ? '' : String(v)
  }

  get checked() {
    return this._checked !== undefined ? this._checked : this.hasAttribute('checked')
  }

  set checked(v) {
    this._checked = !!v
  }

  get open() {
    return this.hasAttribute('open')
  }

  set open(v) {
    if (v) this.setAttribute('open', '')
    else this.removeAttribute('open')
  }

  get disabled() {
    return this.hasAttribute('disabled')
  }

  set disabled(v) {
    if (v) this.setAttribute('disabled', '')
    else this.removeAttribute('disabled')
  }

  showModal() {
    this.setAttribute('open', '')
    const doc = this.ownerDocument
    doc.modals.push({ el: this, returnTo: doc.activeElement })
    const target = this.querySelectorAll('[autofocus]').find(isFocusable) || this.querySelectorAll('*').find(isFocusable)
    doc.activeElement = target || this
  }

  // 本物と同じく、開いていたときだけ close のイベントを次の番に送る
  close() {
    const wasOpen = this.hasAttribute('open')
    this.removeAttribute('open')
    if (wasOpen) setTimeout(() => this.dispatchEvent(makeEvent('close', { bubbles: false })), 0)
    const doc = this.ownerDocument
    const i = doc.modals.findIndex((m) => m.el === this)
    if (i < 0) return
    const [m] = doc.modals.splice(i, 1)
    if (m.returnTo) doc.activeElement = m.returnTo
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type)
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  /** 泡立ちだけ（捕捉の段は無い）。リスナーは this = currentTarget で呼ぶ（Preact の proxy が this.l を読む）。 */
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this
    for (let n = this; n && !ev._stopped; n = n.parentNode) {
      const list = n._listeners ? n._listeners.get(ev.type) : null
      if (!list) continue
      ev.currentTarget = n
      for (const fn of list.slice()) fn.call(n, ev)
      if (!ev.bubbles) break
    }
    return !ev.defaultPrevented
  }

  focus() {
    if (isFocusable(this)) this.ownerDocument.activeElement = this
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
  }

  scrollIntoView(opts) {
    this.ownerDocument.scrolled.push({ el: this, opts: opts === undefined ? null : opts })
  }

  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  }

  matches(selector) {
    return parseSelectorList(selector).some((chain) => matchChain(this, chain))
  }

  querySelectorAll(selector) {
    const chains = parseSelectorList(selector)
    const out = []
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue
        if (chains.some((chain) => matchChain(c, chain))) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
}
for (const p of EVENT_PROPS) FakeElement.prototype[p] = null

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9)
    this.ownerDocument = null
    this.scrolled = []
    this.modals = []
    this._listeners = new Map()
    this.documentElement = new FakeElement(this, HTML_NS, 'html')
    this.body = new FakeElement(this, HTML_NS, 'body')
    this.documentElement.appendChild(this.body)
    this.childNodes = [this.documentElement]
    this.documentElement.parentNode = this
    this.activeElement = this.body
  }

  createElement(tag) {
    return new FakeElement(this, HTML_NS, tag)
  }

  createElementNS(ns, tag) {
    return new FakeElement(this, ns, tag)
  }

  createTextNode(data) {
    return new FakeText(this, data)
  }

  getElementById(id) {
    return this.documentElement.querySelectorAll('*').find((e) => e.getAttribute('id') === id) || null
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector)
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector)
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type)
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
}

// ---- 小さなセレクタ（タグ・#id・.class・[attr]・[attr="v"]・:checked・:not(…)・子孫の空白・カンマ） ----

function splitTop(s, sep) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parseCompound(s) {
  const parts = { tag: null, id: null, classes: [], attrs: [], nots: [], checked: false }
  let i = 0
  const ident = () => {
    const m = /^[A-Za-z0-9_-]+|^\*/.exec(s.slice(i))
    if (!m) throw new Error('読めないセレクタ: ' + s)
    i += m[0].length
    return m[0]
  }
  while (i < s.length) {
    const c = s[i]
    if (c === '#') {
      i++
      parts.id = ident()
    } else if (c === '.') {
      i++
      parts.classes.push(ident())
    } else if (c === '[') {
      const end = s.indexOf(']', i)
      const body = s.slice(i + 1, end)
      i = end + 1
      const m = /^([A-Za-z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(body)
      if (!m) throw new Error('読めない属性セレクタ: ' + body)
      parts.attrs.push({ name: m[1], value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] })
    } else if (s.startsWith(':checked', i)) {
      parts.checked = true
      i += ':checked'.length
    } else if (s.startsWith(':not(', i)) {
      let depth = 0
      let j = i + 4
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++
        else if (s[j] === ')' && --depth === 0) break
      }
      parts.nots.push(parseCompound(s.slice(i + 5, j)))
      i = j + 1
    } else {
      const t = ident()
      parts.tag = t === '*' ? null : t.toLowerCase()
    }
  }
  return parts
}

function parseSelectorList(selector) {
  return splitTop(selector, ',').map((one) => splitTop(one, ' ').map(parseCompound))
}

function matchCompound(el, p) {
  if (!el || el.nodeType !== 1) return false
  if (p.tag && el.localName !== p.tag) return false
  if (p.id && el.getAttribute('id') !== p.id) return false
  if (p.classes.length) {
    const cls = String(el.getAttribute('class') || '').split(/\s+/)
    if (!p.classes.every((c) => cls.includes(c))) return false
  }
  for (const a of p.attrs) {
    if (!el.hasAttribute(a.name)) return false
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false
  }
  if (p.checked && !el.checked) return false
  for (const n of p.nots) if (matchCompound(el, n)) return false
  return true
}

function matchChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false
  let k = chain.length - 2
  for (let n = el.parentNode; n && k >= 0; n = n.parentNode) {
    if (matchCompound(n, chain[k])) k--
  }
  return k < 0
}

// ---- 入れる・描く・操作する ----

let installed = null

/** (min-width: Npx) / (max-width: Npx) だけを読む小さな matchMedia の判定。 */
function mediaMatches(query, width) {
  let ok = true
  for (const m of String(query).matchAll(/\((min|max)-width:\s*(\d+)px\)/g)) {
    const n = Number(m[2])
    if (m[1] === 'min' && !(width >= n)) ok = false
    if (m[1] === 'max' && !(width <= n)) ok = false
  }
  return ok
}

/**
 * 偽の document・window を globalThis に置く（1 つの試験ファイルの中だけ。node --test はファイルごとに別のプロセス）。
 * width は matchMedia が見る画面の幅（setViewport で変えると change を起こす）。
 * location.replace はハッシュを書き換えて hashchange を起こし、呼ばれた先を window.replaced に残す。
 */
export function installDom({ href = 'http://127.0.0.1:3985/wsuha-broute/ui/', width = 1280 } = {}) {
  if (installed) return installed
  const doc = new FakeDocument()
  const listeners = new Map()
  const mediaLists = []
  const emit = (type) => {
    for (const fn of (listeners.get(type) || []).slice()) fn({ type })
  }
  const win = {
    document: doc,
    innerWidth: width,
    location: {
      href,
      hash: '',
      replace(url) {
        const s = String(url)
        win.replaced.push(s)
        const i = s.indexOf('#')
        win.location.hash = i >= 0 ? s.slice(i) : ''
        emit('hashchange')
      },
    },
    replaced: [],
    scrolledTo: [],
    scrollTo(x, y) {
      win.scrolledTo.push([x, y])
    },
    matchMedia(query) {
      const mq = {
        media: query,
        _fns: [],
        get matches() {
          return mediaMatches(query, win.innerWidth)
        },
        addEventListener(type, fn) {
          if (type === 'change') mq._fns.push(fn)
        },
        removeEventListener(type, fn) {
          const i = mq._fns.indexOf(fn)
          if (i >= 0) mq._fns.splice(i, 1)
        },
      }
      mediaLists.push(mq)
      return mq
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type)
      if (list && list.indexOf(fn) >= 0) list.splice(list.indexOf(fn), 1)
    },
    /** 試験から: 画面の幅を変えて、matchMedia の change を起こす。 */
    setViewport(w) {
      win.innerWidth = w
      for (const mq of mediaLists.slice()) for (const fn of mq._fns.slice()) fn({ matches: mq.matches, media: mq.media })
    },
    /** 試験から: window のイベントを起こす（storage・focus）。 */
    fire(type, extra) {
      for (const fn of (listeners.get(type) || []).slice()) fn(Object.assign({ type }, extra))
    },
    /** 試験から: ハッシュを変えて hashchange を起こす（リンクを押したのと同じ）。 */
    navigate(hash) {
      win.location.hash = hash
      emit('hashchange')
    },
  }
  globalThis.document = doc
  globalThis.window = win
  // 試験が途中で落ちて unmount されなくても、useNow の 1 秒の時計（setInterval）でプロセスが止まらないようにする。
  // setTimeout は外さない（settle の待ちまで外れると、待っている途中でプロセスが終わる）。
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = function (...args) {
    const t = realSetInterval(...args)
    if (t && typeof t.unref === 'function') t.unref()
    return t
  }
  installed = { document: doc, window: win }
  return installed
}

/**
 * Preact の描画（マイクロタスク）と useEffect（35ms の setTimeout）を待つ。決まった時間（45ms × rounds）のあと、
 * 描画か useEffect が残っていれば、無くなるまで待ち足す（上限 3 秒。周期で描き直す画面でも先へ進む）。
 * 見るのはタイマーの合間だけでよい。連なりの中では、flush の中の setState や描画の中の useEffect が、数が 0 に戻るのと
 * 同じ同期の処理の中で次を数えるので、合間に 0 と見えたら Preact の仕事は残っていない。
 */
export async function settle(rounds = 2) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 45))
  const limit = performance.now() + 3000
  while (preactPending > 0 && performance.now() < limit) await new Promise((r) => setTimeout(r, 5))
}

/**
 * cond が真になるまで待つ。起きるはずの変化は、これで見る（描画の外の仕事、たとえば偽のサーバーの応答の後も待てる）。
 * 待ちの規則は test/wait-kit.js（単調な時計で測る・期限を過ぎても最後にもう一度見る・プロセスごと止まっていた間は数えない）。
 * @returns {Promise<boolean>} 最後の cond の値
 */
export async function until(cond, ms = 5000) {
  return (await waitKit.poll(cond, ms, 15)).value
}

/** vnode を document.body の下に描く。 */
export async function mount(vnode) {
  const { render } = await import('../../ui/html.js')
  const root = document.createElement('div')
  document.body.appendChild(root)
  render(vnode, root)
  await settle()
  return {
    root,
    async rerender(next) {
      render(next, root)
      await settle()
    },
    async unmount() {
      render(null, root)
      root.remove()
      await settle()
    },
  }
}

function makeEvent(type, extra = {}) {
  return Object.assign(
    {
      type,
      bubbles: true,
      defaultPrevented: false,
      _stopped: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this._stopped = true
      },
    },
    extra,
  )
}

export function fire(el, type, extra) {
  if (!el) throw new Error(type + ': 要素がありません')
  const ev = makeEvent(type, extra)
  el.dispatchEvent(ev)
  return ev
}

/** 押す。ブラウザと同じく、disabled のボタン・入力は click を起こさない（null を返す）。 */
export function click(el) {
  if (!el) throw new Error('click: 要素がありません')
  if (el.hasAttribute && el.hasAttribute('disabled')) return null
  return fire(el, 'click')
}

/** 入力欄に値を入れて input を起こす（Preact の onInput は e.currentTarget.value を読む）。 */
export function typeInto(el, value) {
  if (!el) throw new Error('入力欄がありません')
  el.value = value
  return fire(el, 'input')
}

export function $(root, selector) {
  return root.querySelector(selector)
}

export function $$(root, selector) {
  return root.querySelectorAll(selector)
}

/** 空白をつめた文字列（表示の文言を比べる）。 */
export function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''
}

/** ボタンを表示の文字で探す。 */
export function buttonByText(root, text) {
  return root.querySelectorAll('button').find((b) => textOf(b).includes(text)) || null
}
