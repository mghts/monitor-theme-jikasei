// Node 原生测试，无外部请求或真实定时器：独立检查折算方向、缓存和生命周期。
import assert from "node:assert/strict"
import { FIAT_CODES } from "./currency-codes.ts"
import { BUILTIN_FX, FX_CACHE_KEY, FX_ENDPOINTS, createFxStore, parseCache, parsePayload } from "./exchange-rates.ts"
import type { FxSchedule, FxSnapshot } from "./exchange-rates.ts"

const NOW = Date.parse("2026-10-11T08:00:00Z")
const HOUR = 60 * 60 * 1000
const quotes = Object.fromEntries(FIAT_CODES.map((code) => [code.toLowerCase(), 0.5]))
Object.assign(quotes, { cny: 1, usd: 1 / 7, jpy: 24, nok: 1.4, huf: 48, twd: 4.7, rub: 12, xcg: 0.25, zwg: 4, sle: 3.5, ved: 130 })
const payload = (date = "2026-10-11") => ({ date, cny: { ...quotes } })
const parsed = parsePayload(payload(), NOW)!
const cache = (snapshot: FxSnapshot) => JSON.stringify({ version: 1, snapshot })
const response = (body = payload()) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

assert.equal(FIAT_CODES.length, 155, "SIX 普通货币名单规模固定，不能用 crypto 凑覆盖率")
assert(FIAT_CODES.every((code) => Object.hasOwn(BUILTIN_FX.rates, code)), "内置 CC0 快照覆盖全部普通货币")
assert.equal(BUILTIN_FX.rates.CNY, 1)
assert.equal(BUILTIN_FX.date, "2026-10-10", "内置报价日期保留原始源日期")
assert.equal(parsed.rates.USD, 7, "CNY 基准报价取倒数：USD 不得按原报价相乘")
assert.equal(parsed.rates.JPY, 1 / 24, "日元转换方向不能颠倒")
for (const code of ["NOK", "HUF", "TWD", "RUB", "XCG", "ZWG", "SLE", "VED", "SVC", "KPW"]) assert(parsed.rates[code] > 0, `支持 ${code}`)
assert.equal(parsed.fetchedAtMs, NOW)
assert.equal(parsed.source, "currency-api")
assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.rates), "getSnapshot 不能被调用方悄悄改率")

const extra = payload()
Object.assign(extra.cny, { btc: 500, eth: 300, xyz: 1, XXX: 1, USD: 100, ang: 0.25, bgn: 0.25, xau: 0.0001 })
const filtered = parsePayload(extra, NOW)!
assert.equal(filtered.rates.BTC, undefined)
assert.equal(filtered.rates.ETH, undefined)
assert.equal(filtered.rates.XYZ, undefined)
assert.equal(filtered.rates.XXX, undefined)
assert.equal(filtered.rates.USD, 7, "非规范大小写键不能覆盖小写报价")
assert.equal(filtered.rates.ANG, 4, "历史 ISO 货币保留原面额，不猜新币换算")
assert.equal(filtered.rates.BGN, 4)
assert.equal(filtered.rates.XAU, 10000, "合法 X 前缀的金属代码不被三字母粗筛误删")

for (const date of ["2026-02-30", "2026-13-01", "2026-10-12", "2026-1-1", "bad"]) assert.equal(parsePayload(payload(date), NOW), null, `拒绝日期 ${date}`)
for (const value of [0, -1, NaN, Infinity, 1e-13, 1e13, "24", null]) {
  const bad = payload()
  bad.cny.jpy = value as number
  assert.equal(parsePayload(bad, NOW)?.rates.JPY, undefined, `坏报价 ${String(value)} 不变成零元`)
}
for (const value of [0, 1.000001, "1", null]) assert.equal(parsePayload({ ...payload(), cny: { ...quotes, cny: value } }, NOW), null, "基准必须严格 CNY=1")
assert.equal(parsePayload({ date: "2026-10-11", usd: quotes }, NOW), null, "不能拿 USD 基准误当 CNY")
assert.equal(parsePayload(Object.create(payload()), NOW), null, "必须有 own date/cny")
const throwing = { get date() { throw new Error("getter") }, cny: quotes }
assert.equal(parsePayload(throwing, NOW), null, "不可信 getter 不能让页面崩溃")

const partial = payload()
for (const code of FIAT_CODES.filter((code) => code !== "CNY").slice(0, 15)) delete partial.cny[code.toLowerCase()]
assert(parsePayload(partial, NOW), "140 个有效普通货币仍可使用，缺价明确排除")
delete partial.cny[FIAT_CODES.filter((code) => code !== "CNY")[15].toLowerCase()]
assert.equal(parsePayload(partial, NOW), null, "不足 140 个普通货币不覆盖已有完整报价")
assert.equal(parsePayload({ ...payload(), cny: { ...quotes, ...Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`extra${i}`, 1])) } }, NOW), null, "异常键数有上限")

assert.deepEqual(parseCache(cache(parsed), NOW), parsed, "缓存已是1币→CNY，读取不能二次取倒数")
for (const raw of [null, "{", "x".repeat(128 * 1024 + 1), JSON.stringify({ version: 2, snapshot: parsed })]) assert.equal(parseCache(raw, NOW), null)
for (const replacement of [
  { source: "https://evil.example" }, { date: "2026-10-12" }, { fetchedAtMs: NOW + 1 },
  { fetchedAtMs: Infinity }, { fetchedAtMs: 0 }, { fetchedAtMs: NOW - 24 * HOUR },
  { rates: { ...parsed.rates, CNY: 2 } }, { rates: { CNY: 1, USD: 7 } },
]) assert.equal(parseCache(cache({ ...parsed, ...replacement } as FxSnapshot), NOW), null, `拒绝坏缓存 ${JSON.stringify(replacement).slice(0, 80)}`)

function clock(initial = NOW) {
  let time = initial
  let sequence = 0
  const jobs = new Map<number, { at: number; callback: () => void }>()
  const schedule: FxSchedule = {
    setTimeout: (callback, delayMs) => { const id = ++sequence; jobs.set(id, { at: time + delayMs, callback }); return id },
    clearTimeout: (handle) => { jobs.delete(handle as number) },
  }
  return {
    now: () => time,
    schedule,
    size: () => jobs.size,
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        time = next[1].at
        jobs.delete(next[0])
        next[1].callback()
        await flush()
      }
      time = end
      await flush()
    },
  }
}

function memory(raw: string | null = null) {
  let saved = raw
  const writes: string[] = []
  return { writes, getItem: (key: string) => { assert.equal(key, FX_CACHE_KEY); return saved }, setItem: (key: string, value: string) => { assert.equal(key, FX_CACHE_KEY); saved = value; writes.push(value) } }
}

// StrictMode 的首订阅同步清理不会发网络请求；重订阅只发一轮。
{
  const timer = clock()
  const stored = memory()
  const calls: { url: string; init?: RequestInit }[] = []
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => stored, fetch: async (url, init) => { calls.push({ url: String(url), init }); return response() } })
  const original = store.getSnapshot()
  assert.strictEqual(store.getSnapshot(), original, "空读快照引用稳定")
  store.subscribe(() => {})()
  await timer.advance(0)
  assert.equal(calls.length, 0, "StrictMode cleanup 取消0ms启动")
  const unsubscribe = store.subscribe(() => {})
  await timer.advance(0)
  assert.equal(calls.length, 1)
  assert.equal(store.getSnapshot().origin, "network")
  assert.equal(stored.writes.length, 1)
  assert.equal(calls[0].url.split("?")[0], FX_ENDPOINTS[0])
  assert.equal(calls[0].init?.credentials, "omit")
  assert.equal(calls[0].init?.referrerPolicy, "no-referrer")
  assert.equal(calls[0].init?.cache, "no-store")
  assert.equal(calls[0].init?.headers, undefined, "不上传后台鉴权或节点数据")
  assert.equal(calls[0].init?.body, undefined)
  const one = store.refresh(true)
  assert.strictEqual(store.refresh(true), one, "单flight共用同一promise")
  await one
  unsubscribe()
  assert.equal(timer.size(), 0, "最后订阅退出取消后续刷新")
}

// 新缓存跨 reload 使用；6h后或UTC跨日自动重新请求。
{
  const timer = clock()
  let count = 0
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => memory(cache(parsed)), fetch: async () => { count++; return response() } })
  const unsubscribe = store.subscribe(() => {})
  await timer.advance(0)
  assert.equal(count, 0)
  assert.equal(store.getSnapshot().origin, "cache")
  await timer.advance(6 * HOUR)
  assert.equal(count, 1)
  unsubscribe()
}
{
  const start = Date.parse("2026-10-10T23:59:00Z")
  const timer = clock(start)
  const previous = parsePayload(payload("2026-10-10"), start)!
  let count = 0
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => memory(cache(previous)), fetch: async () => { count++; return response() } })
  const unsubscribe = store.subscribe(() => {})
  await timer.advance(60 * 1000)
  assert.equal(count, 1, "UTC跨日无需等满6h")
  assert.equal(store.getSnapshot().snapshot.date, "2026-10-11")
  unsubscribe()
}

// HTTP、协议、过量正文或超时均切到镜像；超时覆盖正文而非只等待headers。
for (const failure of ["http", "json", "too-large", "content-length", "old-date", "body-timeout"]) {
  const timer = clock()
  let count = 0
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => undefined, fetch: async () => {
    if (++count === 2) return response()
    if (failure === "http") return new Response("limited", { status: 429 })
    if (failure === "json") return response({ date: "2026-10-11", cny: { cny: 1, usd: 1 } })
    if (failure === "too-large") return new Response(" ".repeat(128 * 1024 + 1))
    if (failure === "content-length") return new Response("{}", { headers: { "content-length": String(128 * 1024 + 1) } })
    if (failure === "old-date") return response(payload("2026-10-09"))
    return { ok: true, headers: new Headers(), text: () => new Promise<string>(() => {}) } as Response
  } })
  const task = store.refresh()
  await flush()
  if (failure === "body-timeout") await timer.advance(8000)
  await task
  assert.equal(count, 2, `${failure} 切镜像`)
  assert.equal(store.getSnapshot().failed, false)
  assert.equal(store.getSnapshot().origin, "network")
  store.dispose()
  assert.equal(timer.size(), 0)
}

// 无 Content-Length 的大流不能先整包读进内存；越界立即取消，尾部不再读取。
{
  const timer = clock()
  let calls = 0
  let chunksRead = 0
  let cancelled = 0
  const chunks = [new Uint8Array(64 * 1024).fill(32), new Uint8Array(64 * 1024).fill(32), new Uint8Array(1).fill(32), new Uint8Array(64 * 1024).fill(32)]
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[chunksRead++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 })
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => undefined, fetch: async () => {
    if (++calls > 1) return response()
    const result = new Response(stream)
    assert.equal(result.headers.get("content-length"), null)
    return result
  } })
  await store.refresh()
  assert.equal(chunksRead, 3, "128KiB+1字节时停止，不读取额外尾部")
  assert.equal(cancelled, 1, "超限取消流读者")
  assert.equal(calls, 2, "超限流切换镜像")
  assert.equal(store.getSnapshot().origin, "network")
  store.dispose()
}

// 正常 UTF-8 JSON 的中文字节跨分块仍能还原，不误判为协议失败。
{
  const timer = clock()
  const bytes = new TextEncoder().encode(JSON.stringify({ note: "人民币💴每日参考报价", ...payload() }))
  const firstMultibyte = bytes.findIndex((byte) => byte >= 0x80)
  const chunks = [bytes.slice(0, firstMultibyte + 1), bytes.slice(firstMultibyte + 1, firstMultibyte + 2), bytes.slice(firstMultibyte + 2)]
  let index = 0
  let calls = 0
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++])
      else controller.close()
    },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 })
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => undefined, fetch: async () => { calls++; return new Response(stream) } })
  await store.refresh()
  assert.equal(calls, 1, "正常跨块 UTF-8 无需备用源")
  assert.equal(cancelled, 0, "正常结束不取消已完成流")
  assert.equal(store.getSnapshot().snapshot.rates.USD, 7)
  assert.equal(store.getSnapshot().snapshot.date, "2026-10-11")
  assert.equal(store.getSnapshot().failed, false)
  store.dispose()
}

// 所有源失败保留旧报价和日期，15min重试；旧日期不能覆盖更晚的缓存。
{
  const timer = clock()
  const stored = memory(cache(parsed))
  let calls = 0
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => stored, fetch: async () => { calls++; return response(payload("2026-10-10")) } })
  const unsubscribe = store.subscribe(() => {})
  await store.refresh(true)
  assert.equal(store.getSnapshot().snapshot.date, "2026-10-11")
  assert.equal(store.getSnapshot().snapshot.rates.USD, 7)
  assert.equal(store.getSnapshot().origin, "cache")
  assert.equal(store.getSnapshot().failed, true)
  assert.equal(stored.writes.length, 0, "失败/旧报价不污染cache")
  await timer.advance(15 * 60 * 1000)
  assert.equal(calls, 4, "失败后15min会重试两源")
  unsubscribe()
}

// Storage getter/setter被拒不影响换算；后台不可见时不发新请求。
{
  const timer = clock()
  let visible = false
  let count = 0
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, canRefresh: () => visible, storage: () => { throw new Error("blocked") }, fetch: async () => { count++; return response() } })
  const unsubscribe = store.subscribe(() => {})
  await timer.advance(0)
  assert.equal(count, 0)
  assert.equal(store.getSnapshot().origin, "builtin")
  visible = true
  await store.refresh()
  assert.equal(count, 1)
  assert.equal(store.getSnapshot().origin, "network", "存储getter拒绝仍可更新")
  unsubscribe()
}
{
  const timer = clock()
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => ({ getItem: () => null, setItem: () => { throw new Error("blocked write") } }), fetch: async () => response() })
  await store.refresh()
  assert.equal(store.getSnapshot().origin, "network", "缓存写入被拒仍可更新")
  store.dispose()
}

// 卸载同步abort、隔离旧promise；重新订阅能发新请求且旧回调不能publish。
{
  const timer = clock()
  const stored = memory()
  let finish: (response: Response) => void
  let calls = 0
  let signal: AbortSignal | undefined
  const store = createFxStore({ now: timer.now, schedule: timer.schedule, storage: () => stored, fetch: async (_, init) => {
    calls++
    signal = init?.signal ?? undefined
    if (calls === 1) return new Promise<Response>((resolve) => { finish = resolve })
    return response()
  } })
  const unsubscribe = store.subscribe(() => {})
  await timer.advance(0)
  const old = store.refresh()
  unsubscribe()
  assert(signal?.aborted, "最后unsubscribe同步中止请求")
  assert.equal(timer.size(), 0, "deadline也在abort时取消")
  const nextUnsubscribe = store.subscribe(() => {})
  await timer.advance(0)
  assert.equal(calls, 2)
  assert.equal(store.getSnapshot().origin, "network")
  const stable = store.getSnapshot()
  finish!(response(payload("2026-10-10")))
  await old
  await flush()
  assert.strictEqual(store.getSnapshot(), stable, "旧请求回调不覆盖新snapshot")
  assert.equal(stored.writes.length, 1)
  nextUnsubscribe()
  store.dispose()
  await store.refresh(true)
  assert.equal(calls, 2, "dispose后不可再发送请求")
}

console.log("自动汇率：全部通过（ISO覆盖、倒数、缓存/镜像/正文超时、刷新与卸载隔离）")
