// Preact と htm を 1 か所でつなぐ。部品はここから html と hooks を取る。
// 値は必ず html`…${value}…` の子として渡す（テキストとして描かれる）。innerHTML は使わない。
import { h, render, Fragment, createContext } from './vendor/preact.mjs'
import { useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, useLayoutEffect } from './vendor/hooks.mjs'
import htm from './vendor/htm.mjs'

export const html = htm.bind(h)
export { h, render, Fragment, createContext, useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, useLayoutEffect }

// ---- 1 秒ごとの時計（相対時刻の表示用。購読した部品だけが描き直る） ----
const subs = new Set()
let timer = null

function tick() {
  const now = Date.now()
  for (const fn of subs) fn(now)
}

export function useNow(enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    subs.add(setNow)
    if (!timer) timer = setInterval(tick, 1000)
    return () => {
      subs.delete(setNow)
      if (!subs.size && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }, [enabled])
  return now
}

/** クラス名をつなぐ（偽の値は落とす）。 */
export function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/** 要素の幅を測る（グラフの描き直し用）。 */
export function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width)
      if (next > 0) setW((prev) => (Math.abs(prev - next) >= 1 ? next : prev))
    }
    measure()
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/**
 * メディアクエリが合っているか（2 ペインの幅の判定）。matchMedia が無い環境では true（広い画面とみなす）。
 * app.css の @media と同じ式を渡す（route.js の WIDE_QUERY）。
 */
export function useMedia(query) {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !!window.matchMedia(query).matches : true)
  const [matches, setMatches] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const on = () => setMatches(!!mq.matches)
    on()
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', on)
      return () => mq.removeEventListener('change', on)
    }
    if (typeof mq.addListener === 'function') {
      mq.addListener(on)
      return () => mq.removeListener(on)
    }
    return undefined
  }, [query])
  return matches
}
