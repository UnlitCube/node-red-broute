// 計測値タブ: 推移（1 / 6 / 24 時間。Node-RED のメモリにある範囲だけ）と、全プロパティの表。
// display は機器から届いた文字列を含む。必ずテキストとして描く。鮮度（fresh）はサーバーの値をそのまま使う。
// - 推移: 途切れを薄い帯で塗り（charts.js）、グラフの下に 1 行（値が取れていた時間の割合・途切れの回数・最長）。
//   範囲の途中で Node-RED を再起動して、その前の記録が無いときは帯にせず「n 時 n 分より前は、Node-RED を再起動したため記録がありません」
//   （最初の点が起動から数分以内のときだけ）。
//   範囲の途中で追加した台も帯にせず「n 時 n 分より前は記録がありません」（台が無かった時間は途切れではない）。
//   範囲の前から動いていたなら、先頭の欠けも計測の途切れとして帯にする。
// - 表: 単位の列はなくし、値は「桁区切りの数 + 単位」。EA・EB は時刻の列にメーターの確定の時刻（「08:00 確定」）。
//   9F は「n 個」と出し、名前の一覧は details に。名前の列は短い名前（label。無ければ name）、正式な名前は title。
import { html, cx, useMemo, useNow } from '../html.js'
import { Loading, Failure, Empty } from './common.js'
import { TrendChart, gapDuration } from './charts.js'
import { S } from '../strings.js'
import { formatEpc, formatTime, formatClock, formatDateTime, formatRelative, formatNumber, text, normEpc, epcName, isNum } from '../format.js'
import { gapStats, gapThreshold, recordedSince } from '../chart-util.js'
import { RANGES } from '../store.js'
import { currentNotPolled } from '../adapter-view.js'

/** 起動からこの長さのうちに記録が始まったときだけ、その前の欠けを再起動のせいと書く。起動のあとで追加した台の時刻を、再起動の時刻と言わないため。 */
const RESTART_WINDOW_MS = 5 * 60 * 1000

function RangePicker({ range, onRange }) {
  return html`<div class="segmented" role="group" aria-label=${S.values.rangeLabel}>
    ${Object.keys(RANGES).map(
      (r) => html`<button type="button" class=${cx('seg', r === range && 'seg-on')} aria-pressed=${r === range ? 'true' : 'false'} onClick=${() => onRange(r)}>
        ${S.values.ranges[r]}
      </button>`,
    )}
  </div>`
}

/**
 * グラフの下の 1 行。途切れが無ければ「この 1 時間は途切れずに取れています。」。
 * 範囲の先頭より前の記録が無いときは、割合と文を「記録のある間」の話にして、その時刻を添える
 * （Node-RED の起動がその範囲の中で、最初の点が起動から RESTART_WINDOW_MS 以内なら「再起動したため」）。
 * 記録の始まりが範囲より前なら、先頭の欠けも途切れに数える（gapStats）。再起動かどうかは startedAt だけで決める。
 * @param {number} [startedAt] Meta.startedAt
 * @param {number|null} [recordingSince] AdapterDetail.recordingSince
 * @returns {{coverage: string|null, before: string|null, stats: object}}
 */
export function trendSummary(points, from, to, range, startedAt, recordingSince) {
  const st = gapStats(points, gapThreshold(points), from, to, recordedSince(startedAt, recordingSince))
  const label = S.values.ranges[range] || S.values.ranges['1h']
  const partial = st.noDataUntil !== null
  let coverage = null
  if (st.coverage !== null) {
    const pct = Math.round(st.coverage * 100)
    const longest = gapDuration(st.longestMs)
    if (st.count) coverage = partial ? S.values.coverageRecorded(pct, st.count, longest) : S.values.coverage(label, pct, st.count, longest)
    else coverage = partial ? S.values.noGapsRecorded : S.values.noGaps(label)
  }
  let before = null
  if (partial) {
    const d = new Date(st.noDataUntil)
    const restarted = isNum(startedAt) && startedAt >= from && startedAt <= st.noDataUntil && st.noDataUntil - startedAt <= RESTART_WINDOW_MS
    before = restarted ? S.values.noDataRestart(d.getHours(), d.getMinutes()) : S.values.noDataBefore(d.getHours(), d.getMinutes())
  }
  return { coverage, before, stats: st }
}

function Trend({ a, trend, onRange, meta }) {
  const range = (trend && trend.range) || '1h'
  const s = trend && trend.status !== 'loading' && trend.series ? trend.series : null
  const to = s ? trend.to || Date.now() : null
  const from = s ? trend.from || to - RANGES[range] : null
  const base = s ? (s.power && s.power.length ? s.power : s.currentR) : null
  const startedAt = meta ? meta.startedAt : undefined
  const recordingSince = a ? a.recordingSince : undefined
  // 途切れはここで 1 回だけ計算し、3 枚のグラフとグラフの下の文で同じものを使う。
  // 関係の無い描き直し（SSE の log など）で作り直すと、グラフの計算まで全部やり直しになるので useMemo にくるむ
  const summary = useMemo(() => (base && base.length ? trendSummary(base, from, to, range, startedAt, recordingSince) : null), [base, from, to, range, startedAt, recordingSince])
  const gaps = summary ? summary.stats.gaps : undefined
  let body
  if (!trend || trend.status === 'loading') body = html`<${Loading} />`
  else if (!s) body = html`<${Failure} title=${S.values.trendFailed} error=${trend.error} onRetry=${() => onRange(range)} />`
  else {
    body = html`<${TrendChart}
        title=${S.values.powerChart}
        series=${[{ key: 'power', label: S.values.seriesPower, cls: 'series-power', points: s.power }]}
        from=${from}
        to=${to}
        signed=${true}
        height=${180}
        gaps=${gaps}
        format=${(v) => formatNumber(v) + ' W'}
      />
      <${TrendChart}
        title=${S.values.currentChart}
        series=${[
          { key: 'r', label: S.values.seriesR, cls: 'series-r', points: s.currentR },
          { key: 't', label: S.values.seriesT, cls: 'series-t', points: s.currentT },
        ]}
        from=${from}
        to=${to}
        height=${150}
        gaps=${gaps}
        emptyText=${currentNotPolled(a) ? S.values.currentNotPolled : undefined}
        format=${(v) => formatNumber(v, 1, 1) + ' A'}
      />
      ${s.lqi && s.lqi.length
        ? html`<${TrendChart}
            title=${S.values.lqiChart}
            series=${[{ key: 'lqi', label: S.values.seriesLqi, cls: 'series-lqi', points: s.lqi }]}
            from=${from}
            to=${to}
            height=${120}
            gaps=${gaps}
            format=${S.values.lqiTip}
          />`
        : null}`
  }
  return html`<section class="section" aria-label=${S.values.trendTitle}>
    <div class="section-head">
      <h2 class="section-title">${S.values.trendTitle}</h2>
      <${RangePicker} range=${range} onRange=${onRange} />
    </div>
    ${body}
    ${summary && summary.coverage ? html`<p class=${cx('trend-coverage', summary.stats.count && 'has-gaps')}>${summary.coverage}</p>` : null}
    ${summary && summary.before ? html`<p class="hint trend-before">${summary.before}</p>` : null}
    <p class="hint">${S.values.trendNote}</p>
  </section>`
}

/**
 * 鮮度の列の文言（控え中・このメーターは持っていない・まだ取れていません・最新・古い）。
 * 表は持っている値（read と同じ snapshot().known）をそのまま出す。まだ一度も取れていない値
 * （定期取得の EPC・控え中で値の無い行。read の missing）は時刻が無いので「古い」ではなく「まだ取れていません」。
 */
export function valueState(row, now) {
  if (row.held && typeof row.held.until === 'number') {
    const min = Math.ceil((row.held.until - now) / 60000)
    return { tone: 'warn', text: min > 0 ? S.values.held(min) : S.values.heldSoon }
  }
  if (row.supported === false) return { tone: 'dim', text: S.values.unsupported }
  if (row.fresh) return { tone: 'ok', text: S.values.fresh }
  return typeof row.at === 'number' ? { tone: 'dim', text: S.values.old } : { tone: 'dim', text: S.values.missing }
}

/** 単位を付けて桁区切りで書く量（W・A・kWh）。ほかの単位（桁・kWh/カウントなど）は機器の display のまま。 */
const QUANTITY_UNITS = ['W', 'A', 'kWh']

/**
 * 値の列。
 * - 数で単位が W・A・kWh: 「formatNumber + 単位」（積算電力量単位 E1 は除く。display の「0.1 kWh/カウント」の方が分かる）
 * - E8（{r, t}）: 「R 相 15.0 A / T 相 30.0 A」（T 相が無い単相 2 線は R 相だけ）
 * - 9F（EPC の並び）: 「n 個」と、名前の一覧（list）
 * - それ以外: display
 * @returns {{text: string, list?: string[]}}
 */
export function valueCell(row) {
  const epc = normEpc(row && row.epc)
  const v = row ? row.value : null
  const unit = row && typeof row.unit === 'string' ? row.unit.trim() : ''
  if (epc === 'E8' && v && typeof v === 'object' && !Array.isArray(v)) {
    const a = (x) => (isNum(x) ? formatNumber(x, 1, 1) + ' A' : null)
    if (a(v.r) !== null) return { text: S.values.currentPair(a(v.r), a(v.t)) }
  }
  if ((epc === '9F' || epc === '9D' || epc === '9E') && Array.isArray(v)) {
    const list = v.map((x) => {
      const e = normEpc(x)
      return e ? (epcName(e) ? S.settings.epcLabel(epcName(e), e) : e) : String(x)
    })
    return { text: S.values.propCount(v.length), list }
  }
  if (isNum(v) && QUANTITY_UNITS.includes(unit) && epc !== 'E1') {
    const digits = unit === 'kWh' ? 3 : unit === 'A' ? 1 : 0
    return { text: formatNumber(v, digits, unit === 'A' ? 1 : 0) + ' ' + unit }
  }
  return { text: text(row && row.display) }
}

/** 時刻の列: EA・EB はメーターの確定の時刻（「08:00 確定」）。受け取った時刻は title。 */
function AtCell({ r, now }) {
  if (isNum(r.meterAt)) {
    const title = isNum(r.at) ? S.values.receivedAt(formatDateTime(r.at)) : formatDateTime(r.meterAt)
    return html`<td class="num c-at" title=${title}>${S.values.meterFixed(formatClock(r.meterAt))}</td>`
  }
  return html`<td class="num c-at" title=${typeof r.at === 'number' ? formatDateTime(r.at) : undefined}>
    ${typeof r.at === 'number' ? html`${formatTime(r.at)} <span class="muted">${formatRelative(r.at, now)}</span>` : S.none}
  </td>`
}

function ValuesTable({ values, onReload }) {
  const now = useNow()
  if (!values || values.status === 'loading') return html`<${Loading} />`
  if (!values.items) return html`<${Failure} title=${S.values.loadFailed} error=${values.error} onRetry=${onReload} />`
  if (!values.items.length) return html`<${Empty}>${S.values.empty}</${Empty}>`
  return html`<div class="table-wrap"><table class="table values-table">
    <thead>
      <tr>
        <th scope="col">${S.values.colEpc}</th>
        <th scope="col">${S.values.colName}</th>
        <th scope="col">${S.values.colValue}</th>
        <th scope="col">${S.values.colAt}</th>
        <th scope="col">${S.values.colState}</th>
      </tr>
    </thead>
    <tbody>
      ${values.items.map((r) => {
        const st = valueState(r, now)
        const cell = valueCell(r)
        const label = typeof r.label === 'string' && r.label ? r.label : null
        return html`<tr key=${r.epc} class=${cx(!r.fresh && 'row-dim')} data-epc=${formatEpc(r.epc)}>
          <td class="mono c-epc">${formatEpc(r.epc)}</td>
          <td class="c-name" title=${label && r.name && r.name !== label ? r.name : undefined}>${label || text(r.name)}</td>
          <td class="num c-value">${cell.list
            ? html`<details class="prop-list"><summary>${cell.text}</summary><span class="prop-items">${cell.list.join(S.listSep)}</span></details>`
            : cell.text}</td>
          <${AtCell} r=${r} now=${now} />
          <td class=${'c-state tone-text-' + st.tone}>${st.text}</td>
        </tr>`
      })}
    </tbody>
  </table></div>`
}

export function ValuesTab({ a, trend, values, onRange, onReloadValues, meta }) {
  return html`<${Trend} a=${a} trend=${trend} onRange=${onRange} meta=${meta} />
    <section class="section" aria-label=${S.values.tableTitle}>
      <h2 class="section-title">${S.values.tableTitle}</h2>
      <${ValuesTable} values=${values} onReload=${onReloadValues} />
    </section>`
}
