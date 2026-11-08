// ログタブ: SSE で流れるログ（レベルの絞り込み・検索・一時停止・.txt で保存）。新しい行を上に出す。
// text は伏せ字済みだが、機器から届いた文字列を含む。必ずテキストとして描く。
import { html, cx, useState, useMemo } from '../html.js'
import { Icon } from './icons.js'
import { Loading, Failure, Empty } from './common.js'
import { S } from '../strings.js'
import { formatTime, formatDateTime, stampForFile } from '../format.js'

const RANK = { debug: 0, info: 1, good: 1, warn: 2, error: 3 }
const MIN = { all: 0, info: 1, warn: 2, error: 3 }
const LEVEL_TONE = { debug: 'neutral', info: 'neutral', good: 'ok', warn: 'warn', error: 'danger' }
const LEVEL_ICON = { debug: 'code', info: 'info', good: 'ok', warn: 'warn', error: 'bad' }

/** レベルと文字で絞る（純関数として外からも使う）。 */
export function filterLogs(items, level, query) {
  const min = MIN[level] === undefined ? 0 : MIN[level]
  const q = String(query || '').trim().toLowerCase()
  return (items || []).filter((r) => (RANK[r.level] === undefined ? 1 : RANK[r.level]) >= min && (!q || String(r.text || '').toLowerCase().includes(q)))
}

/** .txt に書く行（古い順）。 */
export function logsToText(rows) {
  return rows.map((r) => `${formatDateTime(r.at)} [${(r.level || '').toUpperCase()}] ${r.text}`).join('\n') + '\n'
}

function download(name, body) {
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function LogsTab({ a, logs, onReloadLogs }) {
  const [level, setLevel] = useState('all')
  const [query, setQuery] = useState('')
  const [paused, setPaused] = useState(null) // 一時停止した時点の items

  const live = (logs && logs.items) || []
  const source = paused || live
  const filtered = useMemo(() => filterLogs(source, level, query), [source, level, query])
  const newCount = paused ? Math.max(0, live.length - paused.length) : 0

  if (!logs || logs.status === 'loading') return html`<${Loading} />`
  if (!logs.items) return html`<${Failure} title=${S.logs.loadFailed} error=${logs.error} onRetry=${onReloadLogs} />`

  const shown = filtered.slice().reverse()
  const name = String(a.name || a.id).replace(/[^\w.-]+/g, '_')

  return html`<section class="section" aria-label=${S.logs.title}>
    <div class="toolbar">
      <label class="field field-inline">
        <span class="field-label">${S.logs.levelLabel}</span>
        <select class="input select" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
          ${Object.keys(S.logs.levels).map((k) => html`<option value=${k}>${S.logs.levels[k]}</option>`)}
        </select>
      </label>
      <label class="search">
        <span class="sr-only">${S.logs.search}</span>
        <input class="input" type="search" value=${query} placeholder=${S.logs.searchPlaceholder} onInput=${(e) => setQuery(e.currentTarget.value)} />
      </label>
      <button type="button" class=${cx('btn', paused && 'btn-on')} aria-pressed=${paused ? 'true' : 'false'} onClick=${() => setPaused(paused ? null : live)}>
        <${Icon} name=${paused ? 'play' : 'pause'} size=${16} /><span>${paused ? S.logs.resume : S.logs.pause}</span>
      </button>
      <button type="button" class="btn" disabled=${!filtered.length} onClick=${() => download(`wsuha-broute-${name}-${stampForFile(Date.now())}.txt`, logsToText(filtered))}>
        <${Icon} name="download" size=${16} /><span>${S.logs.save}</span>
      </button>
    </div>
    <p class="logs-status muted">
      ${paused ? html`<strong class="tone-text-warn">${S.logs.pausedNew(newCount)}</strong> · ` : null}${S.logs.count(filtered.length, source.length)}
    </p>
    ${!source.length
      ? html`<${Empty}>${S.logs.empty}</${Empty}>`
      : !filtered.length
        ? html`<${Empty} action=${html`<button type="button" class="btn" onClick=${() => (setLevel('all'), setQuery(''))}>${S.logs.clearFilter}</button>`}>${S.logs.emptyFiltered}</${Empty}>`
        : html`<ol class="logs" aria-label=${S.logs.title}>
            ${shown.map(
              (r) => html`<li key=${r.seq} class=${cx('log', 'log-' + r.level)}>
                <time class="log-time num" datetime=${new Date(r.at).toISOString()} title=${formatDateTime(r.at)}>${formatTime(r.at)}</time>
                <span class=${cx('log-level', 'tone-text-' + (LEVEL_TONE[r.level] || 'neutral'))}>
                  <${Icon} name=${LEVEL_ICON[r.level] || 'info'} size=${12} /><span>${S.logs.levelNames[r.level] || r.level}</span>
                </span>
                <span class="log-text">${r.text}</span>
              </li>`,
            )}
          </ol>`}
  </section>`
}
