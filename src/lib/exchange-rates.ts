import { FIAT_CODES, KNOWN_CURRENCY_CODES } from "./currency-codes.ts"
import { BUILTIN_FX_DATE, BUILTIN_FX_RATES } from "./exchange-rates-snapshot.ts"

/** 所有内部汇率均为「1 单位币种 = N CNY」，与远程 CNY 基准报价的方向相反。 */
export type FxSnapshot = {
  rates: Readonly<Record<string, number>>
  date: string
  source: "currency-api"
  fetchedAtMs: number
}

export type FxState = {
  snapshot: FxSnapshot
  loading: boolean
  failed: boolean
  origin: "builtin" | "cache" | "network"
}

export const FX_CACHE_KEY = "jikasei:exchange_rates:v1"
export const FX_ENDPOINTS = Object.freeze([
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json",
  "https://latest.currency-api.pages.dev/v1/currencies/cny.json",
])

export const BUILTIN_FX: FxSnapshot = Object.freeze({
  rates: BUILTIN_FX_RATES,
  date: BUILTIN_FX_DATE,
  source: "currency-api",
  // 内置数据不冒充访客已经联网获取的缓存；origin=builtin 始终触发首次更新。
  fetchedAtMs: 0,
})

const MAX_BODY_BYTES = 128 * 1024
const MAX_ENTRIES = 1024
const MIN_FIAT_COUNT = 140
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000
const DEFAULT_RETRY_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1e-12 && value <= 1e12
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

function validDate(value: unknown, now: number): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(now)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && utcDay(time) === value && value <= utcDay(now)
}

/** 拒绝不完整响应；无效或未知项不计入，也不会被替换为 0/1。 */
function parseRates(value: unknown, inverse: boolean): Readonly<Record<string, number>> | null {
  const source = object(value)
  if (!source) return null
  const entries = Object.entries(source)
  if (entries.length > MAX_ENTRIES) return null
  const identityKey = inverse ? "cny" : "CNY"
  if (!Object.hasOwn(source, identityKey) || source[identityKey] !== 1) return null
  const rates: Record<string, number> = {}
  for (const [rawCode, value] of entries) {
    const code = inverse ? rawCode.toUpperCase() : rawCode
    // 远程字段必须是小写，缓存必须是大写；拒绝同一币种的大小写重复键。
    if (rawCode !== (inverse ? code.toLowerCase() : code) || !KNOWN_CURRENCY_CODES.has(code) || !validRate(value)) continue
    const rate = inverse ? 1 / value : value
    if (validRate(rate)) rates[code] = rate
  }
  if (FIAT_CODES.reduce((count, code) => count + Number(Object.hasOwn(rates, code)), 0) < MIN_FIAT_COUNT) return null
  return Object.freeze(rates)
}

/** CNY 基准 JSON 的 date 是上游每日数据日期；不会推测精确到秒的交易报价时间。 */
export function parsePayload(payload: unknown, now = Date.now()): FxSnapshot | null {
  try {
    const data = object(payload)
    if (!data || !Object.hasOwn(data, "date") || !Object.hasOwn(data, "cny") || !validDate(data.date, now)) return null
    const rates = parseRates(data.cny, true)
    return rates ? Object.freeze({ rates, date: data.date, source: "currency-api", fetchedAtMs: now }) : null
  } catch {
    return null
  }
}

/** 缓存只保存固定 source ID；任何链接、展示标签或任意未来刷新时间均不受信任。 */
export function parseCache(raw: unknown, now = Date.now()): FxSnapshot | null {
  try {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null
    const data = object(JSON.parse(raw))
    const snapshot = object(data?.snapshot)
    if (!data || data.version !== 1 || !snapshot || snapshot.source !== "currency-api" || !validDate(snapshot.date, now)) return null
    const fetchedAtMs = snapshot.fetchedAtMs
    if (typeof fetchedAtMs !== "number" || !Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0 || fetchedAtMs > now) return null
    // 报价不可能晚于获取日期；防伪造历史获取时间绕过刷新检查。
    if (snapshot.date > utcDay(fetchedAtMs)) return null
    const rates = parseRates(snapshot.rates, false)
    return rates ? Object.freeze({ rates, date: snapshot.date, source: "currency-api", fetchedAtMs }) : null
  } catch {
    return null
  }
}

/** 生产响应按字节有界读取；UTF-8 跨 chunk 时交给流式 decoder，避免截断字符。 */
async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (typeof response.body?.getReader !== "function") {
    // 简化的 fetch 夹具可能只有 text()；外层 deadline 仍覆盖这一步。
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new Error("Exchange rate response is too large")
    return body
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const parts: string[] = []
  let bytes = 0
  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    // 不等待上游取消完成，否则坏流可以阻塞镜像切换；吞掉取消自身的拒绝。
    try { void reader.cancel().catch(() => {}) } catch { /* 释放失败不能覆盖原来的错误。 */ }
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    if (signal.aborted) throw new Error("Exchange rate request aborted")
    for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new Error("Exchange rate request aborted")
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) throw new Error("Exchange rate response is too large")
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join("")
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal.removeEventListener("abort", cancel)
    try { reader.releaseLock() } catch { /* 已被取消的读取无需再保持锁。 */ }
  }
}

type StorageLike = Pick<Storage, "getItem" | "setItem">
export type FxSchedule = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}
export type FxStoreOptions = {
  fetch?: typeof fetch
  storage?: () => StorageLike | undefined
  now?: () => number
  timeoutMs?: number
  refreshMs?: number
  retryMs?: number
  canRefresh?: () => boolean
  schedule?: FxSchedule
}

/** 每个页面共用一个 store：只按时间刷新，不随节点更新或逐台发送请求。 */
export function createFxStore(options: FxStoreOptions = {}) {
  const now = options.now ?? Date.now
  const fetcher = options.fetch ?? globalThis.fetch
  const storage = options.storage ?? (() => globalThis.localStorage)
  const schedule: FxSchedule = options.schedule ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const duration = (value: number | undefined, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
  const timeoutMs = duration(options.timeoutMs, 8000)
  const refreshMs = duration(options.refreshMs, DEFAULT_REFRESH_MS)
  const retryMs = duration(options.retryMs, DEFAULT_RETRY_MS)
  let cached: FxSnapshot | null = null
  try { cached = parseCache(storage()?.getItem(FX_CACHE_KEY), now()) } catch { /* 浏览器可能拒绝 storage getter。 */ }
  if (cached && cached.date < BUILTIN_FX.date) cached = null
  let state: FxState = { snapshot: cached ?? BUILTIN_FX, origin: cached ? "cache" : "builtin", loading: false, failed: false }
  const listeners = new Set<() => void>()
  let timer: unknown
  let active: AbortController | undefined
  let pending: Promise<void> | undefined
  let generation = 0
  let disposed = false
  let retryAtMs = 0

  function notify(next: FxState) {
    state = next
    for (const listener of [...listeners]) listener()
  }

  function clearTimer() {
    if (timer !== undefined) schedule.clearTimeout(timer)
    timer = undefined
  }

  function allowed() {
    try { return options.canRefresh?.() !== false } catch { return false }
  }

  function due() {
    return state.failed || state.origin === "builtin" || now() - state.snapshot.fetchedAtMs >= refreshMs || utcDay(now()) !== utcDay(state.snapshot.fetchedAtMs)
  }

  function arm(delayMs?: number) {
    clearTimer()
    if (disposed || !listeners.size) return
    const time = now()
    const midnight = (Math.floor(time / DAY_MS) + 1) * DAY_MS
    const delay = delayMs ?? Math.max(1, Math.min(state.snapshot.fetchedAtMs + refreshMs - time, midnight - time))
    timer = schedule.setTimeout(() => {
      timer = undefined
      void refresh()
    }, Math.max(0, delay))
  }

  async function request(endpoint: string, controller: AbortController): Promise<FxSnapshot> {
    // Deadline 同时覆盖 response body；abort 不被忽略时亦用 race 确保可进入备用源。
    let deadline: unknown
    let rejectAbort: (reason: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => {
      if (deadline !== undefined) schedule.clearTimeout(deadline)
      rejectAbort(new Error("Exchange rate request aborted"))
    }
    controller.signal.addEventListener("abort", onAbort, { once: true })
    const timedOut = new Promise<never>((_, reject) => {
      deadline = schedule.setTimeout(() => {
        controller.abort()
        reject(new Error("Exchange rate request timed out"))
      }, timeoutMs)
    })
    const operation = (async () => {
      const response = await fetcher(`${endpoint}?t=${Math.floor(now() / DEFAULT_REFRESH_MS)}`, {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      })
      if (!response.ok) throw new Error(`Exchange rate HTTP ${response.status}`)
      const length = response.headers.get("content-length")
      if (length && Number(length) > MAX_BODY_BYTES) throw new Error("Exchange rate response is too large")
      const body = await readBody(response, controller.signal)
      const snapshot = parsePayload(JSON.parse(body), now())
      if (!snapshot) throw new Error("Invalid exchange rate response")
      return snapshot
    })()
    try {
      return await Promise.race([operation, timedOut, aborted])
    } finally {
      controller.signal.removeEventListener("abort", onAbort)
      if (deadline !== undefined) schedule.clearTimeout(deadline)
    }
  }

  function refresh(force = false): Promise<void> {
    if (disposed) return Promise.resolve()
    if (pending) return pending
    if (!allowed()) { arm(retryMs); return Promise.resolve() }
    if (!force && state.failed && now() < retryAtMs) { arm(retryAtMs - now()); return Promise.resolve() }
    if (!force && !due()) { arm(); return Promise.resolve() }
    clearTimer()
    const current = ++generation
    // 放到 microtask 后才开始，pending 在任何 fetch/订阅回调之前已经就绪。
    const task = Promise.resolve().then(async () => {
      let result: FxSnapshot | undefined
      for (const endpoint of FX_ENDPOINTS) {
        if (current !== generation || disposed) return
        const controller = new AbortController()
        active = controller
        try {
          const snapshot = await request(endpoint, controller)
          if (current !== generation || disposed) return
          if (snapshot.date < state.snapshot.date) continue
          result = snapshot
          break
        } catch {
          if (current !== generation || disposed) return
        }
      }
      if (current !== generation || disposed) return
      if (result) {
        retryAtMs = 0
        try { storage()?.setItem(FX_CACHE_KEY, JSON.stringify({ version: 1, snapshot: result })) } catch { /* 更新不依赖缓存可写。 */ }
        notify({ snapshot: result, origin: "network", loading: false, failed: false })
      } else {
        retryAtMs = now() + retryMs
        notify({ ...state, loading: false, failed: true })
      }
    }).finally(() => {
      if (current !== generation) return
      pending = undefined
      active = undefined
      arm(state.failed ? retryMs : undefined)
    })
    pending = task
    notify({ ...state, loading: true, failed: false })
    return task
  }

  function stop() {
    generation++
    clearTimer()
    active?.abort()
    active = undefined
    pending = undefined
    if (state.loading) state = { ...state, loading: false }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {}
      listeners.add(listener)
      // StrictMode 的立即 cleanup 会取消此任务，不会产生两次无意义的外部 GET。
      if (listeners.size === 1) arm(0)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) stop()
      }
    },
    refresh,
    dispose() {
      disposed = true
      listeners.clear()
      stop()
    },
  }
}
