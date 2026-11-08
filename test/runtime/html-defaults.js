'use strict'

// 試験用: nodes/*.html の registerType の定義（エディタが持つ defaults）を読む。
// flow-writer が書くノードは、エディタが読み直しても同じ形でないと、次のデプロイで作り直される。

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * @param {string} name 'wsuha-device' | 'wsuha-broute'
 * @param {string} [html] html の中身（既定は nodes/<name>.html）
 * @returns {object} registerType に渡された定義
 */
function loadDefinition(name, html) {
  const text = html === undefined ? fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', name + '.html'), 'utf8') : html
  const m = text.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)
  if (!m) throw new Error(name + '.html に <script> がありません')
  let def = null
  const RED = {
    settings: {},
    validators: { number: () => () => true, regex: () => () => true },
    nodes: { registerType: (n, d) => (n === name ? (def = d) : null), node: () => null },
  }
  vm.runInNewContext(m[1], { RED, $: () => ({}) })
  if (!def) throw new Error(name + ' の registerType が見つかりません')
  return def
}

module.exports = { loadDefinition }
