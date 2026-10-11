import assert from "node:assert/strict"
import { quarters } from "./format.ts"
import { countAxisTop, resourceHistory, type MetricPoint } from "./resource-history.ts"

const base: MetricPoint = { ts: 1_700_000_000, cpu: 12, mem_used: 100, disk_used: 200, net_rx: 30, net_tx: 40 }
const old = resourceHistory([base])
assert.deepEqual(old.available, { swap_used: false, tcp: false, udp: false, procs: false })
assert.deepEqual(old.rows[0], { ...base, ts: base.ts * 1_000, swap_used: null, tcp: null, udp: null, procs: null })

const points = [
  { ...base, swap_used: 0, tcp: 0, udp: 0, procs: 0 },
  { ...base, ts: base.ts + 60, swap_used: 1024, tcp: 5, udp: null, procs: 29 },
  { ...base, ts: base.ts + 120, swap_used: -1, tcp: NaN, udp: Infinity, procs: null },
  { ...base, ts: base.ts + 180, swap_used: 512, tcp: 3, udp: 2, procs: 20 },
]
const before = structuredClone(points)
const history = resourceHistory(points)
assert.deepEqual(history.available, { swap_used: true, tcp: true, udp: true, procs: true })
assert.deepEqual(history.peaks, { swap_used: 1024, tcp: 5, udp: 2, procs: 29 })
assert.deepEqual(history.rows.map((row) => row.udp), [0, null, null, 2])
assert.deepEqual(history.rows.map((row) => row.tcp), [0, 5, null, 3])
assert.deepEqual(history.rows.map((row) => row.cpu), [12, 12, 12, 12])
assert.deepEqual(points, before, "转换不能修改响应或原有指标")

const zero = resourceHistory([{ ...base, swap_used: 0, tcp: 0, udp: 0, procs: 0 }])
assert.deepEqual(zero.available, { swap_used: true, tcp: true, udp: true, procs: true })
assert.deepEqual(resourceHistory([{ ...base, tcp: 8 }]).available,
  { swap_used: false, tcp: true, udp: false, procs: false })
assert.deepEqual(resourceHistory([]), {
  rows: [], available: old.available, peaks: { swap_used: 0, tcp: 0, udp: 0, procs: 0 },
})

for (const peak of [0, 1, 5, 29, 99, 101, 1000, 12345]) {
  const top = countAxisTop(peak)
  const ticks = quarters(top)
  assert.ok(top >= Math.max(4, peak), `量程应覆盖峰值 ${peak}`)
  assert.ok(ticks.every(Number.isInteger), `计数刻度应为整数 ${peak}`)
  assert.equal(new Set(ticks).size, ticks.length, "不能出现重复刻度")
}
console.log("resource-history：旧版兼容、零值、断点、单序列和计数轴检查通过")
