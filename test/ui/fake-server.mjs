// 画面の試験の偽のサーバー（fetch の代役）。App を丸ごと描く試験はここを通す。
//
// 応答の形は、手で書かず lib/runtime の本物の関数から作る（view-model・service.totalOf・read-values・AdapterHandle.trend）。
// 手で書いた形は、サーバーが足した項目が試験に現れない。total・series.lqi・counters の項目・read を持たない偽物の下で、
// 「API は返すのに画面に出ない」配線の落ちが緑のまま残った。形の照合は test/ui/fake-server.test.mjs。
//
// 使い方:
//   const server = fakeServer({ items: [summary('a1')], liveStreams: true })
//   const start = appStarter({ win, html, App, mounted })   // mounted は afterEach で外す配列
//   const m = await start({ width: 1280, hash: '#/adapters/a1/values', server })
import { createRequire } from 'node:module'
import { mount, settle } from './fake-dom.mjs'
import { S } from '../../ui/strings.js'

const require = createRequire(import.meta.url)
const vm = require('../../lib/runtime/view-model.js')
const { totalOf } = require('../../lib/runtime/service.js')
const { buildRead } = require('../../lib/runtime/read-values.js')
const { AdapterHandle } = require('../../lib/runtime/registry.js')

export const BASE = 'http://127.0.0.1:3985/wsuha-broute/ui/'
export const NOT_FOUND = { error: { code: 'ADAPTER_NOT_FOUND', message: 'アダプタが見つかりません' } }
export const NO_API = { error: { code: 'NOT_FOUND', message: 'その API はありません' } }

const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 }
const TREND_MAX_POINTS = 720

/** 本物の形（空の入力で全部の項目が返る）。値だけを試験用に上書きする。 */
const REAL_SUMMARY = vm.buildSummary({ id: 'x' }, 1000)
const REAL_DETAIL = vm.buildDetail({ id: 'x' }, 1000)

export const H = (level, extra = {}) => Object.assign({ level, title: S.health[level], reasons: [], nextAction: null }, extra)

/** 一覧の 1 台（名前のある、つながっている実機の台）。 */
export const summary = (id, extra = {}) =>
  Object.assign(
    {},
    REAL_SUMMARY,
    {
      id,
      name: 'アダプタ ' + id,
      named: true,
      role: '電力',
      running: true,
      connected: true,
      portOpen: true,
      port: '/dev/ttyUSB0',
      portLabel: 'USB0',
      phase: 'connected',
      phaseText: '接続済み',
      health: H('ok'),
      power: Object.assign({}, REAL_SUMMARY.power, { value: 500, at: 1000, fresh: true }),
      current: { r: 3, t: 2, total: 5, at: 1000 },
      lastValueAt: 1000,
    },
    extra,
  )

/** 詳細（一覧の 1 台に、詳細だけの項目を足したもの）。 */
export const detail = (s) => Object.assign({}, REAL_DETAIL, { credentials: { configured: true, source: '環境変数', pairId: null } }, s)

/** GET adapters/:id/config。over は項目ごとに本物の形へ重ねる。 */
export function configFor(id, over = {}) {
  const c = vm.buildConfig({
    rec: { rev: 'c1', fields: {} },
    editor: { name: 'アダプタ ' + id, role: '電力', enabled: true, mode: 'serial', serialport: '/dev/ttyUSB0', serialbaud: 115200, deviceKey: 'usb0', expectedMac: '', autoStart: true, scanDurations: '4,5,6,7,8' },
    credentials: { configured: true, source: '設定ノード', pairId: '89ABCDEF', envOverrides: false },
    enabled: true,
  })
  for (const k of Object.keys(over)) c.fields[k] = Object.assign({}, c.fields[k], over[k])
  return c
}

/** GET adapters/:id/settings。 */
export function settingsFor(over = {}) {
  const c = vm.buildSettings({ rec: { rev: 'r1', fields: {} }, configValues: { pollIntervalSec: 30 } })
  for (const k of Object.keys(over)) c.fields[k] = Object.assign({}, c.fields[k], over[k])
  return c
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * cond が真になるまで待つ（npm test の並列で遅くなっても落ちないよう、上限は長め）。
 * 時計は単調な時計で測る（壁時計は飛ぶことがあり、Docker の VM では 30 秒ごとに 1 秒ほど進む。進むと待ちが早く切れる）。
 */
export async function until(cond, ms = 3000) {
  const end = performance.now() + ms
  while (!cond() && performance.now() < end) await wait(20)
  return cond()
}

export const countOf = (server, re) => server.calls.filter((c) => re.test(new URL(c.url).pathname)).length

/** stream を繋いだ回数（adapter が null なら ?adapter= を付けないもの）。 */
export const streamCalls = (server, adapter) =>
  server.calls.filter((c) => {
    const u = new URL(c.url)
    return u.pathname.endsWith('/stream') && u.searchParams.get('adapter') === adapter
  }).length

export const memStorage = () => {
  const m = new Map()
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) }
}

/**
 * 偽の API。items の台を持ち（setItems で変える）、meta は metaOver で変える。
 * - stream: notFoundStream の台だけ 404、ほかは開いたまま（イベントは来ない）。
 *   liveStreams なら本物のサーバー（lib/runtime/sse.js）と同じく、繋いだら hello・adapters（?adapter= ならその adapter も）を送り、
 *   push / pushAll で後からイベントを送れる。?adapter= の台が items に無ければ 404 ADAPTER_NOT_FOUND（claim されていない台）。
 * - unclaimed: 一覧にはあるのに、詳細と ?adapter= の SSE が 404 の台（一覧を取ってから claim が外れた・戻る途中）。
 * - total: GET adapters と SSE の adapters の合計。無ければ本物の totalOf で数える。
 * - settingsOf(id)・onAction(id, name): GET settings の中身と、actions の前の変化。
 * - configOf(id)・ports・onConfigWrite(method, kind, id, body): 構成とポートの候補。無ければ古いサーバーと同じ 404 NOT_FOUND。
 * - known(id): 今の sequencer の値（GET values）。read(id): registry が持ち越した値も含む値（GET read）。無ければ known と同じ。
 * - trendRows(id): 本物の AdapterHandle が持つ行（[ts, power, r, t, lqi]）。trendOf(id) があれば応答をそのまま返す。
 * - onDiag(id, name): POST diag の応答（{status, body}）。sessionOf(headers): GET session。onAddAdapter(body): POST adapters。
 * - denyWrites（server の値）: actions を断る応答（{status, body}）。
 */
export function fakeServer({ items, metaOver = {}, notFoundStream = [], unclaimed = [], streamDown = false, liveStreams = false, settingsOf = null, onAction = null, configOf = null, ports = null, onConfigWrite = null, sessionOf = null, onAddAdapter = null, trendOf = null, trendRows = null, known = null, read = null, onDiag = null, total = undefined } = {}) {
  const calls = []
  const streams = []
  let seq = 0
  const server = { calls, streams, items, unclaimed: new Set(unclaimed), denyWrites: null, total }
  const totalNow = (list) => (server.total === undefined ? totalOf(list) : server.total)
  const frame = (type, data) => `id: ${++seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  function openStream(adapter, signal) {
    const enc = new TextEncoder()
    const s = { adapter, closed: false, ctl: null }
    if (signal) {
      signal.addEventListener('abort', () => {
        if (s.closed) return
        s.closed = true
        try {
          s.ctl.error(new DOMException('aborted', 'AbortError'))
        } catch (e) {
          /* 閉じたあと */
        }
      })
    }
    s.push = (type, data) => {
      if (!s.closed) s.ctl.enqueue(enc.encode(frame(type, data)))
    }
    const body = new ReadableStream({
      start(c) {
        s.ctl = c
      },
      cancel() {
        s.closed = true
      },
    })
    streams.push(s)
    s.push('hello', { serverTime: 1, seq })
    s.push('adapters', { items: server.items, total: totalNow(server.items) })
    const a = adapter && server.items.find((x) => x.id === adapter)
    if (a) s.push('adapter', detail(a))
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  server.setItems = (next) => {
    server.items = next
  }
  /** 開いている全部の SSE に送る（adapter は ?adapter= のその台にだけ）。adapters に total が無ければ本物と同じく足す。 */
  server.pushAll = (type, data) => {
    const body = type === 'adapters' && data.total === undefined ? Object.assign({}, data, { total: totalNow(data.items) }) : data
    for (const s of streams) if (!s.closed && (type !== 'adapter' || s.adapter === data.id)) s.push(type, body)
  }
  server.openStreams = () => streams.filter((s) => !s.closed)
  const inspectOf = (id) => ({ id, options: { pollEpcs: ['0xE7', '0xE8'], slowEpcs: [], halfHourEpcs: [], onceEpcs: [] }, snap: { known: known ? known(id) : {} } })
  server.fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    // 本物の通信と同じく、応答はタイマーの番を挟んでから返す（マイクロタスクだけで回り続ける暴走で、試験の待ちが止まらないように）
    await new Promise((r) => setTimeout(r, 0))
    const u = new URL(url)
    // httpNodeRoot が / 以外（/n/wsuha-broute/api/v1/…）でも読む
    const p = u.pathname.replace(/^.*?\/wsuha-broute\/api\/v1\//, '')
    if (p === 'meta') {
      return json(
        200,
        Object.assign(
          {
            apiVersion: 1,
            libVersion: '2.0.0-beta.1',
            diskVersion: '2.0.0-beta.1',
            startedAt: 1,
            nodeRed: '3.1.3',
            readOnly: false,
            configLocked: false,
            editorRoot: '/',
            addAdapter: { available: true, reason: null, count: server.items.length, limit: 8, tabLabel: 'B ルート（Web UI で追加）', envOverrides: false, locked: false, lockedReason: null },
            auth: { required: false, available: false, editorPath: null },
          },
          metaOver,
        ),
      )
    }
    if (p === 'session') return sessionOf ? json(200, sessionOf(init.headers || {})) : json(404, NO_API)
    if (p === 'adapters' && init.method === 'POST') {
      const r = onAddAdapter ? onAddAdapter(JSON.parse(init.body)) : { status: 404, body: NO_API }
      return json(r.status, r.body)
    }
    if (p === 'adapters') return json(200, { items: server.items, total: totalNow(server.items) })
    if (p === 'serialports') return ports ? json(200, typeof ports === 'function' ? ports() : ports) : json(404, NO_API)
    const cfg = p.match(/^adapters\/([^/]+)\/(config|credentials)$/)
    if (cfg) {
      const id = decodeURIComponent(cfg[1])
      const method = init.method || 'GET'
      if (!configOf) return json(404, NO_API)
      if (method === 'GET' && cfg[2] === 'config') return json(200, configOf(id))
      if (onConfigWrite) {
        const r = onConfigWrite(method, cfg[2], id, init.body === undefined ? null : JSON.parse(init.body), init.headers || {})
        return json(r.status || 200, r.body)
      }
      return json(404, NO_API)
    }
    if (p === 'stream') {
      const id = u.searchParams.get('adapter')
      if (id && (notFoundStream.includes(id) || server.unclaimed.has(id))) return json(404, NOT_FOUND)
      if (streamDown) return new Response('Bad Gateway', { status: 502 })
      if (!liveStreams) return new Promise(() => {}) // 開いたまま（イベントは来ない）
      if (id && !server.items.some((x) => x.id === id)) return json(404, NOT_FOUND)
      return openStream(id, init.signal)
    }
    const act = p.match(/^adapters\/([^/]+)\/actions\/([\w-]+)$/)
    if (act && init.method === 'POST') {
      const id = decodeURIComponent(act[1])
      if (server.denyWrites) return json(server.denyWrites.status, server.denyWrites.body)
      if (onAction) onAction(id, act[2])
      const a = server.items.find((x) => x.id === id)
      if (!a) return json(404, NOT_FOUND)
      return json(200, { ok: true, message: '受け付けました', adapter: detail(a) })
    }
    const dg = p.match(/^adapters\/([^/]+)\/diag$/)
    if (dg && init.method === 'POST') {
      const r = onDiag ? onDiag(decodeURIComponent(dg[1]), JSON.parse(init.body).name) : { status: 200, body: { at: Date.now(), result: {} } }
      return json(r.status, r.body)
    }
    const m = p.match(/^adapters\/([^/]+)(?:\/(\w+))?$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const a = server.unclaimed.has(id) ? null : server.items.find((x) => x.id === id)
      if (!a) return json(404, NOT_FOUND)
      const now = Date.now()
      if (!m[2]) return json(200, detail(a))
      if (m[2] === 'values') return json(200, { items: vm.buildValueRows(inspectOf(id), now), at: now })
      if (m[2] === 'read') {
        const inspect = inspectOf(id)
        return json(200, buildRead({ device: a.role, deviceKey: a.deviceKey, known: read ? read(id) : inspect.snap.known, req: { epcs: null, maxAgeSec: null }, inspect, now }))
      }
      if (m[2] === 'settings') return json(200, settingsOf ? settingsOf(id) : settingsFor())
      if (m[2] === 'logs') return json(200, { items: [], nextSeq: 0 })
      if (m[2] === 'trend') {
        if (trendOf) return json(200, trendOf(id))
        return json(200, AdapterHandle.prototype.trend.call({ _trend: trendRows ? trendRows(id) : [] }, RANGE_MS[u.searchParams.get('range') || '1h'], now, TREND_MAX_POINTS))
      }
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'x' } })
  }
  return server
}

/**
 * App を描く関数を作る。mounted に積むので、afterEach で全部外す（試験が途中で落ちても、SSE の繋ぎ直しのタイマーでプロセスが終わらなくなるのを防ぐ）。
 * @param {{win: object, html: Function, App: Function, mounted: object[]}} deps
 */
export function appStarter({ win, html, App, mounted }) {
  return async function start({ width, hash = '', server, env = {} }) {
    win.setViewport(width)
    win.location.hash = hash
    win.replaced.length = 0
    const m = await mount(html`<${App} env=${Object.assign({ href: BASE + hash, storage: memStorage(), fetchImpl: server.fetchImpl }, env)} />`)
    await settle(3)
    let gone = false
    const unmount = m.unmount
    m.unmount = async () => {
      if (gone) return
      gone = true
      await unmount()
    }
    mounted.push(m)
    return m
  }
}
