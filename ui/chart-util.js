// グラフの計算（純関数。test/ui/format.test.mjs で一緒に確かめる）。

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 目盛りに使う「きりのよい」数を count 個前後で返す。min=max でも 2 本以上返す。 */
export function niceTicks(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) return []
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.5 : 1
    min -= pad
    max += pad
  }
  if (min > max) [min, max] = [max, min]
  const raw = (max - min) / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const out = []
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)))
  return out
}

/** 目盛りの数を、刻みが読める桁数で書くときの小数の桁数（0.25 刻みなら 2）。丸めると実際の位置と違う数が並ぶ。 */
export function tickDigits(ticks) {
  if (!ticks || ticks.length < 2) return 0
  const s = Number(Math.abs(ticks[1] - ticks[0]).toPrecision(12)).toFixed(12).replace(/0+$/, '')
  return s.length - s.indexOf('.') - 1
}

/** 点列の値の範囲（null は飛ばす）。無ければ null。 */
export function extent(seriesList) {
  let lo = Infinity
  let hi = -Infinity
  for (const pts of seriesList) {
    for (const p of pts || []) {
      if (!isNum(p[1])) continue
      if (p[1] < lo) lo = p[1]
      if (p[1] > hi) hi = p[1]
    }
  }
  return lo === Infinity ? null : [lo, hi]
}

/** 点と点の間が maxGapMs より空いた所・値が null の所で、線を切る。 */
export function segments(points, maxGapMs) {
  const out = []
  let cur = []
  let prevTs = null
  for (const p of points || []) {
    if (!p || !isNum(p[0])) continue
    if (!isNum(p[1])) {
      if (cur.length) out.push(cur)
      cur = []
      prevTs = p[0]
      continue
    }
    if (prevTs !== null && cur.length && p[0] - prevTs > maxGapMs) {
      out.push(cur)
      cur = []
    }
    cur.push(p)
    prevTs = p[0]
  }
  if (cur.length) out.push(cur)
  return out
}

/** 点の間隔の中央値（ms）。2 点未満なら null。 */
export function medianStep(points) {
  const d = []
  for (let i = 1; i < (points || []).length; i++) {
    const a = points[i - 1][0]
    const b = points[i][0]
    if (isNum(a) && isNum(b) && b > a) d.push(b - a)
  }
  if (!d.length) return null
  d.sort((x, y) => x - y)
  return d[Math.floor(d.length / 2)]
}

/** 線を切る間隔: 中央値の 4 倍（ただし 2 分以上）。 */
export function gapThreshold(points) {
  const m = medianStep(points)
  return Math.max(120e3, (m || 30e3) * 4)
}

/**
 * 推移の途切れと、値が取れていた時間の割合（サーバーの形は変えず、画面の点と線を切る間隔だけから作る）。
 * - 途切れ（gaps）: 値のある 2 点の間が threshold より空いた所と、値が null の点をはさむ所（どちらも線を切る所）。
 *   最後の点から範囲の終わり（to）まで threshold より空いていれば、それも途切れ（いま値が来ていない）。
 * - 範囲の先頭から最初の点までが threshold より長いとき:
 *   記録の始まり（since）が範囲より前なら、その間も計測していたはずの時間なので途切れにする。
 *   始まりが範囲の中か分からない（since が無い）なら、記録そのものが無いので帯にせず noDataUntil にする。
 * - 取れていた割合（coverage）は、途切れを数える間（noDataUntil があれば最初の点から、無ければ範囲の先頭から to まで）のうち、
 *   途切れでない時間の割合（0〜1）。点が無ければ null。
 * @param {[number, number|null][]} points 時刻の昇順
 * @param {number} [since] この台の記録の始まり（呼び手が recordedSince で作る）
 * @returns {{gaps: {from: number, to: number, ms: number}[], coverage: number|null, count: number, longestMs: number, noDataUntil: number|null}}
 */
export function gapStats(points, threshold, from, to, since) {
  const pts = (points || []).filter((p) => p && isNum(p[0]))
  const valid = pts.filter((p) => isNum(p[1]))
  const out = { gaps: [], coverage: null, count: 0, longestMs: 0, noDataUntil: null }
  if (!valid.length) return out
  const th = isNum(threshold) && threshold > 0 ? threshold : 120e3
  const end = isNum(to) ? Math.max(to, valid[valid.length - 1][0]) : valid[valid.length - 1][0]
  const first = valid[0][0]
  const headMissing = isNum(from) && first - from > th
  const headGap = headMissing && isNum(since) && since <= from
  const start = headGap ? from : isNum(from) ? Math.max(from, first) : first
  if (headGap) out.gaps.push({ from, to: first, ms: first - from })
  else if (headMissing) out.noDataUntil = first
  let prev = null
  let cut = false
  for (const p of pts) {
    if (!isNum(p[1])) {
      if (prev !== null) cut = true
      continue
    }
    if (prev !== null && (cut || p[0] - prev > th)) out.gaps.push({ from: prev, to: p[0], ms: p[0] - prev })
    prev = p[0]
    cut = false
  }
  if (prev !== null && end - prev > th) out.gaps.push({ from: prev, to: end, ms: end - prev })
  const span = end - start
  let missing = 0
  for (const g of out.gaps) {
    missing += Math.max(0, Math.min(g.to, end) - Math.max(g.from, start))
    if (g.ms > out.longestMs) out.longestMs = g.ms
  }
  out.count = out.gaps.length
  out.coverage = span > 0 ? Math.max(0, Math.min(1, (span - missing) / span)) : 1
  return out
}

/**
 * この台の記録の始まり。Node-RED の起動のあとに追加した台・有効にした台は、起動の時刻ではまだ台が無かった。
 * その時間を途切れにすると、台の不調に見える。recordingSince の無いサーバーは起動の時刻で見る。
 * @param {number} [startedAt] Node-RED を起動した時刻（Meta.startedAt）
 * @param {number|null} [recordingSince] このプロセスで台が動き始めた時刻（AdapterDetail.recordingSince）
 * @returns {number|undefined}
 */
export function recordedSince(startedAt, recordingSince) {
  return isNum(startedAt) && isNum(recordingSince) ? Math.max(startedAt, recordingSince) : startedAt
}

/**
 * 吹き出しの文字の幅の見積もり（12px の文字。描く前に箱の幅を決めるので、実測はできない）。
 * @returns {number} px
 */
export function tipTextWidth(s) {
  let w = 0
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0xff ? 11.5 : 6.5
  return w
}

/**
 * 吹き出しの左端。カーソルの右に出し、入らなければ左へ回す。どちらでも [left, right] からはみ出さないように丸める。
 * @returns {number}
 */
export function tipLeft(cursorX, boxWidth, left, right) {
  const x = cursorX + 12 + boxWidth <= right ? cursorX + 12 : cursorX - 12 - boxWidth
  return Math.max(left, Math.min(x, right - boxWidth))
}

const TIME_STEPS = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3]

/** 時刻の目盛り（端末のローカル時刻で、分・時のきりのよい所）。 */
export function timeTicks(from, to, maxTicks) {
  if (!isNum(from) || !isNum(to) || to <= from || maxTicks < 1) return []
  const span = to - from
  const step = TIME_STEPS.find((s) => span / s <= maxTicks) || TIME_STEPS[TIME_STEPS.length - 1]
  // ローカル時刻の 0 時を基準に揃える（UTC 基準だと時差で 30 分ずれた目盛りになる国がある）
  const d = new Date(from)
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  let t = base + Math.ceil((from - base) / step) * step
  const out = []
  for (; t <= to; t += step) out.push(t)
  return out
}

/** 時刻の列から、ts に最も近い点の位置（二分探索）。 */
export function nearestIndex(points, ts) {
  if (!points || !points.length) return -1
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] < ts) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(points[lo - 1][0] - ts) <= Math.abs(points[lo][0] - ts)) return lo - 1
  return lo
}

/** 点列を SVG の path の d にする。 */
export function linePath(points, x, y) {
  let d = ''
  for (let i = 0; i < points.length; i++) {
    d += (i ? 'L' : 'M') + x(points[i][0]).toFixed(1) + ' ' + y(points[i][1]).toFixed(1)
  }
  return d
}

/** 点列と基準線（y0）の間を塗る path。 */
export function areaPath(points, x, y, y0) {
  if (!points.length) return ''
  const base = y0.toFixed(1)
  let d = 'M' + x(points[0][0]).toFixed(1) + ' ' + base
  for (const p of points) d += 'L' + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)
  d += 'L' + x(points[points.length - 1][0]).toFixed(1) + ' ' + base + 'Z'
  return d
}
