// ui/styles/app.css の見た目の約束のうち、偽の DOM では測れないもの（幅で変わる表の列）を CSS の規則として見張る。
// 本当の幅は実ブラウザで測る。ここは「規則を消した・戻した」を落とすための番人。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = fs.readFileSync(path.resolve(here, '../../ui/styles/app.css'), 'utf8').split(String.fromCharCode(13)).join('').replace(/\/\*[\s\S]*?\*\//g, '')

/** セレクターがそのまま一致する規則の中身を全部つなげたもの（無ければ空）。 */
function bodyOf(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return [...css.matchAll(new RegExp('(?:^|[}\\s,])' + esc + '\\s*\\{([^}]*)\\}', 'g'))].map((m) => m[1]).join(';')
}

/** @media の条件が query の塊を取り除いた残りと、塊の中身を返す。 */
function splitMedia(src, query) {
  const head = '@media ' + query
  let rest = ''
  let inner = ''
  let i = 0
  for (;;) {
    const at = src.indexOf(head, i)
    if (at < 0) return { rest: rest + src.slice(i), inner }
    rest += src.slice(i, at)
    let j = src.indexOf('{', at) + 1
    const open = j
    for (let depth = 1; depth; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
    }
    inner += src.slice(open, j - 1)
    i = j
  }
}

// 読み込み中の表示が左上に出ていた。横だけ真ん中にしても、ペインの高さが中身のままだと表示は上の端に残る。
// 高さの鎖（帯の下いっぱいのペイン → その高さいっぱいの箱 → 箱の中の真ん中）のどこが切れても、位置は上へ戻る。
// 実際の位置は test/ui/browser.test.mjs が実ブラウザで測る。
// 戻すと落ちるもの: index.html の boot を外す・下の規則のどれかを消す
test('読み込み中の表示: 開いた直後は画面の真ん中、ペインの中はペインの縦横の真ん中で、高さが飛ばない', () => {
  const index = fs.readFileSync(path.resolve(here, '../../ui/index.html'), 'utf8')
  assert.ok(index.includes('class="state state-loading boot"'), 'index.html')
  assert.match(bodyOf('.state-loading'), /justify-items:\s*center/, '横の真ん中')
  // 2 ペインの高さ・1 ペインの高さ
  assert.match(bodyOf('.shell'), /min-height:\s*100dvh/)
  assert.match(bodyOf('.panes'), /flex:\s*1 1 auto/)
  assert.match(bodyOf('.shell-narrow .panes'), /display:\s*grid/, '1 ペインでもペインを伸ばす')
  assert.match(bodyOf('.shell-wide .panes'), /display:\s*grid/)
  // ペインの高さいっぱいの箱の、縦の真ん中
  assert.match(bodyOf('.pane > .state-loading'), /min-height:\s*100%/)
  assert.match(bodyOf('.pane > .state-loading'), /align-content:\s*center/)
  // ペインの余白は上下で違うので、読み込みの間は外す（残すと真ん中からずれる）
  assert.match(bodyOf('.pane:has(> .state-loading)'), /padding-top:\s*0/)
  assert.match(bodyOf('.pane:has(> .state-loading)'), /padding-bottom:\s*0/)
  // 開いた直後の表示は、帯の分だけ下げてペインの表示と同じ高さにする（指の端末は帯が 53px）
  const boot = bodyOf('.boot')
  assert.match(boot, /min-height:\s*100dvh/)
  assert.match(boot, /align-content:\s*center/)
  assert.match(boot, /padding-top:[^;]*44px/)
  assert.match(boot, /padding-top:[^;]*53px/)
})

// 触ったあとの色が次に触るまで残っていた（:hover は指の端末でも効き、離しても外れない）。
// 戻すと落ちるもの: :hover の規則を @media (hover: hover) の外へ出す
test('ホバーの色は @media (hover: hover) の中にだけ書く', () => {
  const { rest, inner } = splitMedia(css, '(hover: hover)')
  assert.equal(rest.includes(':hover'), false, rest.slice(Math.max(0, rest.indexOf(':hover') - 40), rest.indexOf(':hover') + 40))
  for (const s of ['.row:hover', '.tab:hover', '.btn:hover', '.btn-primary:hover', '.btn-danger:hover', '.btn-icon:hover', '.menu-item:hover', 'a:hover']) assert.ok(inner.includes(s), s)
})

// 幅で列の数が 1〜5 に変わり、iPad の横では 1 台が 5 行に伸びていた。
// 戻すと落ちるもの: repeat(auto-fit, …) に戻す・.fact-wide の規則を消す（電流の値が省略される）
test('左ペインの小さな表: どの幅でも 2 列。1 枠に入らない値は 2 列分を使い、空いた枠を後ろで詰める', () => {
  const facts = bodyOf('.row-facts')
  assert.match(facts, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.equal(facts.includes('auto-fit'), false)
  assert.match(facts, /grid-auto-flow:\s*dense/)
  assert.match(bodyOf('.row-facts > .fact-wide'), /grid-column:\s*1 \/ -1/)
  assert.match(bodyOf('.row-facts > div'), /align-items:\s*baseline/, '等幅の値の基準線をそろえる')
})

// 戻すと落ちるもの: .kpis dd より弱いセレクターにする（太さが効かず、値に見える）
test('「取得待ち」の文は値より弱く見せる', () => {
  const wait = bodyOf('.kpis dd.kpi-wait')
  assert.match(wait, /color:\s*var\(--text-dim\)/)
  assert.match(wait, /font-weight:\s*400/)
})

// 戻すと落ちるもの: .set-label の align-content を消す（欄が高い行で、説明が名前から離れる）
test('設定の項目の見出しは上に詰める', () => {
  assert.match(bodyOf('.set-label'), /align-content:\s*start/)
})

// 戻すと落ちるもの: .notice の padding を var(--page-pad) だけに戻す（横向きの iPhone でノッチに文字が掛かる）
test('帯の下の知らせは左右のノッチを避ける', () => {
  const notice = bodyOf('.notice')
  assert.ok(notice.includes('env(safe-area-inset-left'), notice)
  assert.ok(notice.includes('env(safe-area-inset-right'), notice)
})

// 2 ペインは .shell の高さが画面に固定されるので、中身が長いと帯が縮み、指の端末の 44px のボタンが帯からはみ出した。
// 戻すと落ちるもの: .topbar・.notices の flex: none を消す
test('上の帯と知らせは、ペインの中身に押されて縮まない', () => {
  assert.match(bodyOf('.topbar'), /flex:\s*none/)
  assert.match(bodyOf('.notices'), /flex:\s*none/)
})

// 360px で帯が 2 行に折り返していた。
// 戻すと落ちるもの: 400px 未満の節を消す
test('幅の狭いスマートフォンでは、リアルタイムの状態を短い文に替えて帯を 1 行に保つ', () => {
  const { inner } = splitMedia(css, '(max-width: 399px)')
  assert.match(bodyOf('.live-label-short'), /display:\s*none/)
  assert.match(inner, /\.live-label-long\s*\{[^}]*display:\s*none/)
  assert.match(inner, /\.live-label-short\s*\{[^}]*display:\s*inline/)
  assert.match(inner, /\.topbar\s*\{[^}]*column-gap/)
})

// 340〜349px では、切れたときの状態の文があるとテーマのボタンが 2 行目へ落ちた。
// 戻すと落ちるもの: 名前を外す幅を 349px より狭くする
test('幅 349px までは名前を外して、状態の文が長くても帯を 1 行に保つ', () => {
  assert.match(splitMedia(css, '(max-width: 349px)').inner, /\.brand\s*\{[^}]*display:\s*none/)
})

// SVG の中の rect は計算値の display が inline のままで、Chromium は touch-action を見ない。効かせるのは svg の要素。
// 戻すと落ちるもの: touch-action を .chart-hit へ戻す・pinch-zoom を外す（グラフの上から始めた拡大が止まる）
test('グラフの指の操作は svg の要素で決める。横はなぞって読み、縦のスクロールとピンチの拡大は残す', () => {
  assert.match(bodyOf('.chart-svg'), /touch-action:\s*pan-y pinch-zoom/)
  assert.equal(/touch-action/.test(bodyOf('.chart-hit')), false)
})

// 戻すと落ちるもの: app.css の pointer: coarse の節を消す・2 ペインの分かれ目を route.js とずらす
test('スマホと iPad: 指の端末は押せる大きさ 44px と入力欄 16px。ノッチの余白。2 ペインの分かれ目は route.js と同じ', async () => {
  const coarse = css.slice(css.indexOf('@media (pointer: coarse)'))
  assert.ok(css.includes('@media (pointer: coarse)'))
  assert.match(coarse, /min-height:\s*44px/)
  assert.match(coarse, /\.input,\s*\.select,\s*textarea\s*\{[^}]*font-size:\s*var\(--fs-md\)/)
  // 1 ペインの主な移動・チェック・折りたたみも指で押す
  assert.match(coarse, /\.back-link\s*\{[^}]*min-height:\s*44px/)
  assert.match(coarse, /\.check\s*\{[^}]*min-height:\s*44px/)
  assert.match(coarse, /\.epc-group-title,\s*\.prop-list summary\s*\{[^}]*min-height:\s*44px/)
  for (const s of ['env(safe-area-inset-top', 'env(safe-area-inset-bottom', 'env(safe-area-inset-left', 'env(safe-area-inset-right']) assert.ok(css.includes(s), s)
  assert.equal(/backdrop-filter/.test(css), false, 'iOS の Safari は backdrop-filter のある帯の色を延ばさない')
  const { WIDE_QUERY } = await import('../../ui/route.js')
  assert.ok(css.includes('@media ' + WIDE_QUERY), WIDE_QUERY)
  const index = fs.readFileSync(path.resolve(here, '../../ui/index.html'), 'utf8')
  assert.equal(index.split('name="theme-color"').length - 1, 2, 'ライトとダークの theme-color')
})

/** 最も外側の規則（@ の外）と、@container (min-width: Npx) の中身を分けて返す。 */
function splitRules(src) {
  const top = []
  const containers = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const head = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < src.length && depth) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    const body = src.slice(open + 1, j - 1)
    const m = head.match(/^@container\s*\(min-width:\s*(\d+)px\)$/)
    if (m) containers.push({ minWidth: Number(m[1]), body })
    else if (!head.startsWith('@')) top.push({ selector: head, body })
    i = j
  }
  return { top, containers }
}

function declOf(body, selector, prop) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?:^|[}\\s,])' + esc + '\\s*\\{([^}]*)\\}', 'm')
  const m = body.match(re)
  if (!m) return null
  const d = m[1].match(new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+)'))
  return d ? d[1].trim() : null
}

// 実ブラウザで見つけた: PC の幅で、状態タブと構成（読むだけ）のキーと値の表の値の列が画面の真ん中から始まり、
// キーとの間が大きく空いた（キーの列が width: 38%）。広いペインではキーの列を固定の幅（rem）にし、値をその右に寄せる。
// 390px（1 ペイン。右ペインの中身は約 358px）では割合のまま（固定の幅ではキーが半分以上を取る）。
// 戻すと落ちるもの: @container の固定の幅の規則を消す・割合の規則を固定の幅に置き換える。
test('キーと値の表: 広いペインではキーの列を固定の幅（rem）、390px の 1 ペインでは割合のまま', () => {
  const sel = ".kv-table th[scope='row']"
  const { top, containers } = splitRules(css)
  const base = top.find((r) => r.selector === sel)
  assert.ok(base, '割合の規則（@ の外）が無い')
  const baseWidth = declOf(sel + '{' + base.body + '}', sel, 'width')
  assert.match(String(baseWidth), /^\d+(\.\d+)?%$/, '狭い幅のキーの列は割合: ' + baseWidth)

  const wide = containers.filter((c) => declOf(c.body, sel, 'width'))
  assert.equal(wide.length, 1, '広いペインの規則（@container (min-width: …)）が 1 つ')
  const w = declOf(wide[0].body, sel, 'width')
  const rem = String(w).match(/^(\d+(?:\.\d+)?)rem$/)
  assert.ok(rem, '広いペインのキーの列は rem の固定の幅: ' + w)
  assert.ok(Number(rem[1]) >= 10 && Number(rem[1]) <= 14, '12rem 前後: ' + w)
  // 390px の右ペインの中身（390 − 左右 16px = 358px）では効かず、PC の 2 ペイン（1280px で約 900px）では効く
  assert.ok(wide[0].minWidth > 358 && wide[0].minWidth <= 600, 'しきい値: ' + wide[0].minWidth)
})

// 構成（390px で横スクロールなし）: ポートの候補の select は、いちばん長い /dev/serial/by-id/… の option の幅に
// 広がろうとするので、行の中で縮めるには min-width: 0 と幅の上限が要る。「定期的に取りに行く値」の 1 行は、
// 説明の列が縮める（minmax(0, 1fr)）。偽の DOM では幅を測れないので規則を見張る（本当の幅は実ブラウザで見る）。
// 戻すと落ちるもの: .port-select の min-width: 0 を消す・.epc-opt の列を auto 1fr にする。
test('構成のポートの候補と「定期的に取りに行く値」の行は、390px の 1 ペインで縮められる', () => {
  const { top } = splitRules(css)
  const rule = (sel) => {
    const r = top.find((x) => x.selector === sel)
    assert.ok(r, sel + ' の規則が無い')
    return (prop) => declOf(sel + '{' + r.body + '}', sel, prop)
  }
  const port = rule('.port-select')
  assert.equal(port('min-width'), '0')
  assert.equal(port('width'), '100%')
  assert.equal(rule('.port-pick')('min-width'), '0')
  assert.equal(rule('.epc-opt')('grid-template-columns'), 'auto minmax(0, 1fr)')
  assert.equal(rule('.epc-group')('min-width'), '0', 'fieldset の既定の min-width: min-content を外す')
})

/** @media / @container の見出しが head に合う塊の中身を全部返す。 */
function atBlocks(src, re) {
  const out = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const head = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < src.length && depth) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    if (re.test(head)) out.push({ head, body: src.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

// 接続の段階はステッパー。390px（右ペインの中身は約 358px）では折り返す（横スクロールなし）。
// 広いペインは 6 段を 1 列に、狭いペインは 3 段 × 2 行にし、2 行目の頭（4 段目）の前の線を消す。
// 戻すと落ちるもの: 折り返しの規則を消す・6 列を固定の幅にする・しきい値を 358px より下にする。
test('接続の段階のステッパー: 6 段を縮められる列で並べ、狭いペイン（390px の 1 ペイン）では 3 段 × 2 行に折り返す', () => {
  const { top } = splitRules(css)
  const steps = top.find((r) => r.selector === '.steps')
  assert.ok(steps, '.steps の規則が無い')
  assert.equal(declOf('.steps{' + steps.body + '}', '.steps', 'grid-template-columns'), 'repeat(6, minmax(0, 1fr))')
  const narrow = atBlocks(css, /^@container\s*\(max-width:\s*\d+px\)$/).filter((b) => /\.steps\s*\{/.test(b.body))
  assert.equal(narrow.length, 1, '狭いペインの折り返しの規則')
  const max = Number(narrow[0].head.match(/(\d+)px/)[1])
  assert.ok(max >= 358 && max < 440, '390px の 1 ペイン（358px）で効き、PC の 2 ペインの右（約 440px 以上）では効かない: ' + max)
  assert.equal(declOf(narrow[0].body, '.steps', 'grid-template-columns'), 'repeat(3, minmax(0, 1fr))')
  assert.match(narrow[0].body, /\.step:nth-child\(4\)::before\s*\{[^}]*display:\s*none/, '2 行目の頭の前の線を消す')
  const step = top.find((r) => r.selector === '.step')
  assert.equal(declOf('.step{' + step.body + '}', '.step', 'min-width'), '0', '段の中身で列を広げない')
})

// 「いまの段は強調と動き（prefers-reduced-motion では止める）」。
// 戻すと落ちるもの: いまの段の動きを消す・動きを減らす設定で止める規則を消す。
test('ステッパーのいまの段は動く。動きを減らす設定（prefers-reduced-motion: reduce）では止める', () => {
  const { top } = splitRules(css)
  const spin = top.find((r) => r.selector === '.step-spin')
  assert.ok(spin && /animation:\s*\S/.test(spin.body), 'いまの段の回る印に animation')
  const pulse = top.find((r) => r.selector === '.step-now .step-dot')
  assert.ok(pulse && /animation:\s*\S/.test(pulse.body), 'いまの段の丸に animation')
  const reduce = atBlocks(css, /^@media\s*\(prefers-reduced-motion:\s*reduce\)$/)
  assert.ok(reduce.length >= 1)
  const body = reduce.map((b) => b.body).join('\n')
  assert.match(body, /\.step-spin[\s\S]*?\{[^}]*animation:\s*none/, '回る印を止める')
  assert.match(body, /\.step-now \.step-dot[\s\S]*?\{[^}]*animation:\s*none/, '丸の動きを止める')
})

// 再接続の段と横の数（連続失敗・PANA の巡目）: 狭いペインでは縦に重ね、広いペインで横に並べる（390px で横スクロールなし）。
// 戻すと落ちるもの: 横に並べる列をいつも掛ける。
test('再接続の段と横の数は、広いペインだけ横に並べる（390px では縦に重ねる）', () => {
  const { top, containers } = splitRules(css)
  const base = top.find((r) => r.selector === '.reconnect')
  assert.ok(base, '.reconnect の規則が無い')
  assert.equal(declOf('.reconnect{' + base.body + '}', '.reconnect', 'grid-template-columns'), null, '狭い幅では 1 列')
  const wide = containers.filter((c) => declOf(c.body, '.reconnect', 'grid-template-columns'))
  assert.equal(wide.length, 1)
  assert.ok(wide[0].minWidth > 358, 'しきい値: ' + wide[0].minWidth)
  assert.match(declOf(wide[0].body, '.reconnect', 'grid-template-columns'), /^minmax\(0, 1fr\)/)
})

// 実ブラウザで見つけた: 失敗の段の文（.phase-text に tone-text-danger）が赤にならなかった。.phase-text の color が、
// 先に書いた .tone-text-danger（同じ詳細度）を後ろから上書きしていた。.phase-text は色を持たない（本文の色のまま）。
// 戻すと落ちるもの: .phase-text { color: var(--text) } を足す。
test('接続の段階の文（.phase-text）は色を持たない（失敗のときの tone-text-danger を上書きしない）', () => {
  const { top } = splitRules(css)
  const rules = top.filter((r) => r.selector.split(',').map((x) => x.trim()).includes('.phase-text'))
  for (const r of rules) assert.equal(declOf('.phase-text{' + r.body + '}', '.phase-text', 'color'), null)
  const tone = top.find((r) => r.selector === '.tone-text-danger')
  assert.ok(tone, '.tone-text-danger の規則がある')
})

// .settings-tab の display: grid が hidden の既定に勝つので、消すと隠したタブが下に並んで見える。
// 戻すと落ちるもの: app.css の .settings-tab[hidden] を消す
test('隠した設定タブは表示しない', () => {
  assert.match(css, /\.settings-tab\[hidden\]\s*\{[^}]*display:\s*none/)
})
