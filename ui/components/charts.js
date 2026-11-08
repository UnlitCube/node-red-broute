// 推移のグラフ（手で描く SVG。色は tokens.css のクラスで当てる。style 属性は使わない）。
// 線を切る所（途切れ）を薄い帯で塗り、凡例に「計測できなかった時間」。帯に触れる（ホバー・タップ）と
//   「08:36〜08:54（18 分）計測できませんでした」。計算は chart-util.js の gapStats（純関数）。
// 指で触れた吹き出しは、指を離しても残す（マウスと違い、離した直後に pointerleave が来る）。
//   グラフの外を押すか、同じ所をもう一度押すと消す。
// 目盛り・線・面・帯の計算は useMemo にくるみ、関係の無い描き直し（SSE の log・hover）では作り直さない。
import { html, cx, useRef, useState, useEffect, useMemo, useWidth } from '../html.js'
import { S } from '../strings.js'
import { niceTicks, tickDigits, extent, segments, gapThreshold, gapStats, timeTicks, nearestIndex, linePath, areaPath, tipTextWidth, tipLeft } from '../chart-util.js'
import { formatClock, formatTime, formatNumber } from '../format.js'

let uid = 0
const nextId = (p) => `${p}-${++uid}`

/** 途切れの長さ（18 分・1 時間 5 分）。1 分に満たなくても 1 分と書く。 */
export function gapDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60000))
  return m < 60 ? S.time.minSec(m, 0) : S.time.hourMin(Math.floor(m / 60), m % 60)
}

/** 帯の文（「08:36〜08:54（18 分）計測できませんでした」）。 */
export function gapText(g) {
  return S.values.gapTip(formatClock(g.from), formatClock(g.to), gapDuration(g.ms))
}

/** 帯の文を 2 行に分けたもの。 */
const gapLines = (g) => S.values.gapTipLines(formatClock(g.from), formatClock(g.to), gapDuration(g.ms))

/** 吹き出しの箱の幅（左右の余白 10px）。 */
const tipWidth = (lines) => Math.max(...lines.map(tipTextWidth)) + 20

/** 指（とペン）の操作か。マウスとホバーの扱いを分ける。 */
const isTouch = (ev) => ev.pointerType === 'touch' || ev.pointerType === 'pen'

/** 2 つの吹き出しが同じ所のものか。 */
const sameSpot = (a, b) => !!a && !!b && (a.gap ? !!b.gap && a.gap.from === b.gap.from : !b.gap && a.at === b.at)

/**
 * 推移のグラフ。
 * @param {{title: string, series: {key: string, label: string, cls: string, points: [number, number|null][]}[],
 *   from: number, to: number, format: (v: number) => string, signed?: boolean, height?: number,
 *   gaps?: {from: number, to: number, ms: number}[], emptyText?: string}} props
 *   signed: 0 より下（売電）の面を別の色で塗る。
 *   gaps: 途切れの帯。同じ時間軸のグラフは呼び手が 1 回だけ計算して同じ値を渡す（LQI は電力が取れない間も届くので、
 *   系列ごとに計算すると帯の位置がそろわない）。無ければ、点のある最初の系列から作る。点が 1 つも無いグラフには帯を出さない。
 *   emptyText: 点が無いときの文（無ければ「まだ推移がありません」）。
 */
export function TrendChart({ title, series, from, to, format, signed = false, height = 220, gaps: sharedGaps, emptyText }) {
  const wrap = useRef(null)
  const width = useWidth(wrap, 640)
  const [hover, setHover] = useState(null)
  // 同じ所をもう一度押して消した指の操作。続く pointermove で開き直さない
  const dismissed = useRef(false)
  const clipUp = useMemo(() => nextId('clip-up'), [])
  const clipDown = useMemo(() => nextId('clip-down'), [])

  const m = { l: 60, r: 12, t: 12, b: 28 }
  const W = Math.max(240, width)
  const H = height
  const iw = W - m.l - m.r
  const ih = H - m.t - m.b
  const t0 = from
  const t1 = to > from ? to : from + 1

  // 点の列（参照）が変わったときだけ、目盛り・線・面・帯を作り直す
  const pointsKey = series.map((s) => s.points)
  const g = useMemo(() => {
    const all = series.map((s) => (s.points || []).filter((p) => p && typeof p[0] === 'number'))
    const ext = extent(all)
    const yTicks = ext ? niceTicks(Math.min(0, ext[0]), Math.max(0, ext[1]), 4) : niceTicks(0, 1, 4)
    const lo = yTicks[0]
    const hi = yTicks[yTicks.length - 1]
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * ih
    const zeroY = y(0)
    const paths = all.map((pts) => {
      const segs = segments(pts, gapThreshold(pts))
      const drawn = segs.filter((sg) => sg.length > 1)
      return {
        lines: drawn.map((sg) => linePath(sg, x, y)),
        areas: signed ? drawn.map((sg) => areaPath(sg, x, y, zeroY)) : [],
        // 途切れの間に 1 点だけ取れた所。線にならないので点で描く（描かないと取れた値が見えず、空のグラフに見える）
        dots: segs.filter((sg) => sg.length === 1).map((sg) => ({ cx: x(sg[0][0]), cy: y(sg[0][1]) })),
      }
    })
    const base = all.find((p) => p.length) || []
    const found = base.length ? sharedGaps || gapStats(base, gapThreshold(base), t0, t1).gaps : []
    const gaps = found.filter((gp) => gp.to > t0)
    const bands = gaps.map((gp) => {
      const x0 = x(Math.max(gp.from, t0))
      const x1 = x(Math.min(gp.to, t1))
      return { gap: gp, x: x0, w: Math.max(1, x1 - x0) }
    })
    return { all, ext, yTicks, x, y, zeroY, paths, base, gaps, bands, xTicks: timeTicks(t0, t1, Math.max(2, Math.floor(iw / 72))) }
  }, [t0, t1, W, H, signed, sharedGaps].concat(pointsKey))
  const { all, ext, yTicks, x, y, zeroY, paths, base, gaps, bands, xTicks } = g
  const yDigits = tickDigits(yTicks)

  const pinned = !!(hover && hover.touch)
  useEffect(() => {
    if (!pinned) return undefined
    const onDown = (e) => {
      if (!(wrap.current && wrap.current.contains(e.target))) setHover(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [pinned])

  const latest = series.map((s, i) => {
    const pts = all[i]
    for (let k = pts.length - 1; k >= 0; k--) if (typeof pts[k][1] === 'number') return { s, v: pts[k][1] }
    return { s, v: null }
  })
  const aria = S.values.chartAria(title, latest.map((l) => `${l.s.label} ${l.v === null ? S.none : format(l.v)}`).join('、'))

  /** 触れた位置の吹き出しの中身（無ければ null）。 */
  function hoverAt(ev) {
    const svg = ev.currentTarget.ownerSVGElement || ev.currentTarget
    const rect = svg.getBoundingClientRect()
    const px = rect.width ? ((ev.clientX - rect.left) / rect.width) * W : ev.offsetX
    if (!(px >= m.l && px <= W - m.r)) return null
    const ts = t0 + ((px - m.l) / iw) * (t1 - t0)
    const touch = isTouch(ev)
    // 途切れの帯の上なら、その帯の文（「08:36〜08:54（18 分）計測できませんでした」）
    const gap = gaps.find((gp) => ts > gp.from && ts < gp.to)
    if (gap) return { gap, px, touch }
    const idx = nearestIndex(base, ts)
    if (idx < 0) return null
    const at = base[idx][0]
    const rows = series.map((s, i) => {
      const j = nearestIndex(all[i], at)
      const p = j >= 0 ? all[i][j] : null
      return { s, v: p && Math.abs(p[0] - at) < 90e3 ? p[1] : null }
    })
    return { at, rows, touch }
  }

  function onMove(ev) {
    if (!dismissed.current) setHover(hoverAt(ev))
  }

  function onDown(ev) {
    const next = hoverAt(ev)
    dismissed.current = isTouch(ev) && pinned && sameSpot(hover, next)
    setHover(dismissed.current ? null : next)
  }

  function onUp() {
    dismissed.current = false
  }

  function onLeave(ev) {
    if (!isTouch(ev)) setHover(null)
  }

  // 指が縦のスクロールに変わった。読むために置いた指ではないので、吹き出しを残さない
  function onCancel() {
    dismissed.current = false
    setHover(null)
  }

  const empty = !ext
  // 文ごとに行を分け、軸の文字が無いので全体の真ん中に置く（幅の狭いスマートフォンでは、1 行のままでも描く範囲の真ん中でもはみ出す）
  const emptyLines = empty ? (emptyText || S.values.trendEmpty).match(/[^。]+。?/g) : []
  const emptyX = W / 2
  let tip = null
  if (hover && hover.gap) {
    const full = [gapText(hover.gap)]
    const lines = tipWidth(full) <= iw ? full : gapLines(hover.gap)
    const tw = tipWidth(lines)
    const hx = Math.min(Math.max(hover.px, m.l), W - m.r)
    const tx = tipLeft(hx, tw, m.l, W - m.r)
    tip = html`<g class="chart-tip" pointer-events="none" data-tip="gap">
      <rect class="chart-tip-box" x=${tx} y=${m.t + 4} width=${tw} height=${lines.length * 18 + 10} rx="8" />
      ${lines.map((l, i) => html`<text class="chart-tip-text" x=${tx + 10} y=${m.t + 22 + i * 18}>${l}</text>`)}
    </g>`
  } else if (hover) {
    const hx = x(hover.at)
    const valueOf = (r) => (r.v === null || r.v === undefined ? S.none : format(r.v))
    const time = formatTime(hover.at)
    const named = [time].concat(hover.rows.map((r) => `${r.s.label}  ${valueOf(r)}`))
    // 幅の狭い端末で入らないときは、系列の名前を省いて値だけにする（グラフの題と凡例に同じ名前がある）
    const lines = tipWidth(named) <= iw ? named : [time].concat(hover.rows.map(valueOf))
    const tw = tipWidth(lines)
    const th = lines.length * 18 + 10
    const tx = tipLeft(hx, tw, m.l, W - m.r)
    tip = html`<g class="chart-tip" pointer-events="none">
      <line class="chart-cursor" x1=${hx} x2=${hx} y1=${m.t} y2=${m.t + ih} />
      ${hover.rows.map((r) => (typeof r.v === 'number' ? html`<circle class=${cx('chart-dot', r.s.cls)} cx=${hx} cy=${y(r.v)} r="3.5" />` : null))}
      <rect class="chart-tip-box" x=${tx} y=${m.t + 4} width=${tw} height=${th} rx="8" />
      ${lines.map((l, i) => html`<text class=${cx('chart-tip-text', i === 0 && 'chart-tip-time')} x=${tx + 10} y=${m.t + 22 + i * 18}>${l}</text>`)}
    </g>`
  }

  return html`<figure class="chart">
    <div class="chart-wrap" ref=${wrap}>
      <svg class="chart-svg" width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${aria}>
        <defs>
          <clipPath id=${clipUp}><rect x=${m.l} y=${m.t} width=${iw} height=${Math.max(0, zeroY - m.t)} /></clipPath>
          <clipPath id=${clipDown}><rect x=${m.l} y=${zeroY} width=${iw} height=${Math.max(0, m.t + ih - zeroY)} /></clipPath>
        </defs>
        ${bands.map((b) => html`<rect class="chart-gap" x=${b.x} y=${m.t} width=${b.w} height=${ih} data-from=${b.gap.from} data-to=${b.gap.to}><title>${gapText(b.gap)}</title></rect>`)}
        ${yTicks.map(
          (v) => html`<g>
            <line class=${cx('chart-grid', v === 0 && 'chart-grid-zero')} x1=${m.l} x2=${W - m.r} y1=${y(v)} y2=${y(v)} />
            ${empty ? null : html`<text class="chart-axis" x=${m.l - 8} y=${y(v) + 4} text-anchor="end">${formatNumber(v, yDigits)}</text>`}
          </g>`,
        )}
        ${xTicks.map(
          (t) => html`<g>
            <line class="chart-tick" x1=${x(t)} x2=${x(t)} y1=${m.t + ih} y2=${m.t + ih + 4} />
            <text class="chart-axis" x=${x(t)} y=${H - 8} text-anchor="middle">${formatClock(t)}</text>
          </g>`,
        )}
        ${series.map((s, i) => {
          const p = paths[i]
          if (!p.lines.length && !p.dots.length) return null
          return html`<g class=${cx('chart-series', s.cls)}>
            ${signed
              ? html`<g clip-path=${`url(#${clipUp})`}>${p.areas.map((d) => html`<path class="chart-area" d=${d} />`)}</g>
                  <g clip-path=${`url(#${clipDown})`}>${p.areas.map((d) => html`<path class="chart-area chart-area-neg" d=${d} />`)}</g>`
              : null}
            ${p.lines.map((d) => html`<path class="chart-line" d=${d} />`)}
            ${p.dots.map((d) => html`<circle class="chart-dot" cx=${d.cx} cy=${d.cy} r="2.5" />`)}
          </g>`
        })}
        ${empty
          ? html`<text class="chart-empty" x=${emptyX} y=${m.t + ih / 2 - (emptyLines.length - 1) * 9} text-anchor="middle">
              ${emptyLines.map((l, i) => html`<tspan x=${emptyX} dy=${i ? 18 : 0}>${l}</tspan>`)}
            </text>`
          : null}
        ${tip}
        <rect
          class="chart-hit"
          x=${m.l}
          y=${m.t}
          width=${iw}
          height=${ih}
          onPointerMove=${onMove}
          onPointerDown=${onDown}
          onPointerUp=${onUp}
          onPointerCancel=${onCancel}
          onPointerLeave=${onLeave}
        />
      </svg>
    </div>
    <figcaption class="chart-legend">
      ${series.map((s) => html`<span class="legend-item"><span class=${cx('legend-swatch', s.cls)} aria-hidden="true"></span>${s.label}</span>`)}
      ${signed ? html`<span class="legend-item"><span class="legend-swatch series-export" aria-hidden="true"></span>${S.power.exportLabel}</span>` : null}
      ${bands.length ? html`<span class="legend-item legend-gap-item"><span class="legend-gap" aria-hidden="true"></span>${S.values.gapLegend}</span>` : null}
    </figcaption>
  </figure>`
}
