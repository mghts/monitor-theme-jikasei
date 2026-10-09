import assert from "node:assert/strict"
import { createHistoryQueue, latestPing, PING_STALE_MS, timeIndexAtRatio, timeRangeIndices } from "./history.ts"

// 离线缺口占了大半画布时，光标仍必须选中它实际指着的样本。
const irregular = [0, 60, 3600, 3660].map((ts) => ({ ts }))
assert.equal(timeIndexAtRatio(irregular, 60 / 3660), 1)
assert.equal(timeIndexAtRatio(irregular, 3600 / 3660), 2)
assert.equal(timeIndexAtRatio(irregular, 0.5), 1, "缺口中按时间距离选最近样本")
assert.equal(timeIndexAtRatio(irregular, -1), 0)
assert.equal(timeIndexAtRatio(irregular, 2), 3)
assert.equal(timeIndexAtRatio([], 0.5), -1)
assert.equal(timeIndexAtRatio([{ ts: 100 }], 0.5), 0)

// 滚动刷新删去最早样本、增加最新样本，选区应锚定原来两端的时间。
assert.deepEqual(timeRangeIndices([0, 60, 120, 180].map((ts) => ({ ts })), [60, 180]), [1, 3])
assert.deepEqual(timeRangeIndices([60, 120, 180, 240].map((ts) => ({ ts })), [60, 180]), [0, 2])
assert.deepEqual(timeRangeIndices([120, 180, 240].map((ts) => ({ ts })), [60, 180]), [0, 1])
assert.equal(timeRangeIndices([240, 300].map((ts) => ({ ts })), [60, 180]), null, "已移出窗口的选区回全图")
assert.equal(timeRangeIndices(irregular, null), null)

const now = 1_800_000_000_000
const points = [
  { ts: now / 1000 - 120, latency: 25 },
  { ts: now / 1000 - 60, latency: null },
  { ts: now / 1000, latency: null },
]
assert.equal(latestPing(points, now).sample?.latency, null, "最新连续超时不能回溯到旧的正常值")
assert.equal(latestPing([...points].reverse(), now).sample?.ts, now / 1000, "按时间认最新样本")
assert.equal(latestPing([{ ts: now / 1000 - 180, latency: 25 }], now).stale, false)
assert.equal(latestPing([{ ts: now / 1000, latency: 25 }], now + PING_STALE_MS + 1).stale, true)
assert.deepEqual(latestPing([], now), { sample: null, stale: true })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

// 多张卡片与详情同时挂载：最多两条在飞，排队取消的请求不能迟到后执行。
{
  const queue = createHistoryQueue(2)
  const gates = Array.from({ length: 4 }, deferred)
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const started: number[] = []
  let running = 0
  let peak = 0
  const requests = gates.map((gate, i) => queue(async () => {
    started.push(i)
    running++
    peak = Math.max(peak, running)
    await gate.promise
    running--
    return i
  }, controllers[i].signal))
  const cancelled = assert.rejects(requests[2], { name: "AbortError" })
  await flush()
  assert.deepEqual(started, [0, 1])
  controllers[2].abort()
  await cancelled
  gates[0].resolve()
  await requests[0]
  await flush()
  assert.deepEqual(started, [0, 1, 3])
  gates[1].resolve()
  gates[3].resolve()
  assert.deepEqual(await Promise.all([requests[1], requests[3]]), [1, 3])
  assert.equal(peak, 2)
}

// 正在飞行的请求被取消后，释放名额让后面的详情继续读取。
{
  const queue = createHistoryQueue(1)
  const controller = new AbortController()
  const first = queue(() => new Promise<void>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
  }), controller.signal)
  const aborted = assert.rejects(first, { name: "AbortError" })
  const next = queue(async () => "next", new AbortController().signal)
  await flush()
  controller.abort()
  await aborted
  assert.equal(await next, "next")
}

// 同一帧卸载（拿到名额后、真正发出前取消）也不能发请求或锁死队列。
{
  const queue = createHistoryQueue(1)
  const controller = new AbortController()
  let called = false
  const request = queue(async () => { called = true }, controller.signal)
  const aborted = assert.rejects(request, { name: "AbortError" })
  controller.abort()
  await aborted
  assert.equal(called, false)
  assert.equal(await queue(async () => 42, new AbortController().signal), 42)
}

console.log("历史数据：时间命中、缩放保持、最新超时、陈旧状态、并发与取消全部通过")
