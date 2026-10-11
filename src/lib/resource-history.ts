import { axisTop } from "./format.ts"

const EXTRA_METRICS = ["swap_used", "tcp", "udp", "procs"] as const
type ExtraMetric = typeof EXTRA_METRICS[number]

export type MetricPoint = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
} & Partial<Record<ExtraMetric, number | null>>

/** 1.4.1 才返回这些历史字段；缺测不等于零，合法零值也表明 Hub 提供了该序列。 */
export function resourceHistory(points: readonly MetricPoint[]) {
  const available = { swap_used: false, tcp: false, udp: false, procs: false }
  const peaks = { swap_used: 0, tcp: 0, udp: 0, procs: 0 }
  const rows = points.map((point) => {
    const row = { ...point, ts: point.ts * 1_000 }
    for (const key of EXTRA_METRICS) {
      const value = point[key]
      row[key] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
      if (row[key] !== null) {
        available[key] = true
        peaks[key] = Math.max(peaks[key], row[key])
      }
    }
    return row
  })
  return { rows, available, peaks }
}

/** axisTop 的十进制步长允许 1.5，计数轴的四等分刻度则必须都是整数。 */
export function countAxisTop(peak: number): number {
  return Math.ceil(axisTop(peak, 4) / 4) * 4
}
