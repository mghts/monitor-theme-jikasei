/** 最近点按真实时间查找；rows 必须按 ts 升序，ts 与 target 使用同一单位。 */
export function nearestTimeIndex(rows: { ts: number }[], target: number): number {
  if (rows.length === 0) return -1
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].ts < target) lo = mid + 1
    else hi = mid
  }
  if (lo === 0) return 0
  return target - rows[lo - 1].ts <= rows[lo].ts - target ? lo - 1 : lo
}

/** 绘图区的横向比例 → 时间 → 最近点，离线缺口不会被当成等距采样。 */
export function timeIndexAtRatio(rows: { ts: number }[], ratio: number): number {
  if (rows.length === 0) return -1
  const first = rows[0].ts
  const last = rows[rows.length - 1].ts
  return nearestTimeIndex(rows, first + Math.min(1, Math.max(0, ratio)) * (last - first))
}

/** 用时间保留缩放；滚动窗口移出选区或只剩一个点时回到全图。 */
export function timeRangeIndices(rows: { ts: number }[], range: [number, number] | null): [number, number] | null {
  if (!range || rows.length < 2 || range[1] < rows[0].ts || range[0] > rows[rows.length - 1].ts) return null
  const from = nearestTimeIndex(rows, range[0])
  const to = nearestTimeIndex(rows, range[1])
  return from < to ? [from, to] : null
}

/** 仅按 Hub 给出的桶宽插入显示断点；ts 与 step 使用同一单位，不改写或补造采样。 */
export function withTimeGaps<T extends { ts: number }>(points: readonly T[], step?: number): Array<T | null> {
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) return [...points]
  const display: Array<T | null> = []
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].ts - points[i - 1].ts > step) display.push(null)
    display.push(points[i])
  }
  return display
}

/** 卡片是一小时 / 40 桶，最新桶可能落后约 90 秒；超过三分钟明确标记陈旧。 */
export const PING_STALE_MS = 180_000

export function latestPing<T extends { ts: number; latency: number | null }>(points: T[], now: number) {
  const sample = points.reduce<T | null>((last, point) => !last || point.ts > last.ts ? point : last, null)
  return { sample, stale: !sample || now - sample.ts * 1_000 > PING_STALE_MS }
}

/** 卡片与详情共用限流；排队中的取消不会占用名额，也不会迟到后再发请求。 */
export function createHistoryQueue(concurrency = 3) {
  let running = 0
  const waiting: Array<{ start: () => void }> = []
  const acquire = (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    let released = false
    const release = () => {
      if (released) return
      released = true
      running--
      waiting.shift()?.start()
    }
    const ticket = {
      start: () => {
        signal.removeEventListener("abort", cancel)
        running++
        resolve(release)
      },
    }
    const cancel = () => {
      const at = waiting.indexOf(ticket)
      if (at !== -1) waiting.splice(at, 1)
      reject(signal.reason)
    }
    if (running < concurrency) ticket.start()
    else {
      waiting.push(ticket)
      signal.addEventListener("abort", cancel, { once: true })
    }
  })
  return async <T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    const release = await acquire(signal)
    try {
      signal.throwIfAborted()
      return await request()
    } finally {
      release()
    }
  }
}

export const withHistorySlot = createHistoryQueue()
