import type { Node } from "./api.ts"
import { monthUsage } from "./format.ts"
import { monthlyCostOf } from "./money.ts"
import { expiryDaysOf } from "./summary.ts"

export const NODE_SORT_LABELS = {
  default: "后台顺序",
  name: "节点名称",
  offline: "离线优先",
  expiry: "到期优先",
  cpu: "CPU占用",
  memory: "内存占用",
  disk: "磁盘占用",
  traffic: "流量使用",
  monthly: "月均费用",
} as const

export type NodeSort = keyof typeof NODE_SORT_LABELS
export type SortDirection = "asc" | "desc"
export type NodeSortChoice = { mode: NodeSort; direction: SortDirection }
type ResourceSort = "cpu" | "memory" | "disk"
export type NodeSortPreference = NodeSortChoice & { readings?: ReadonlyMap<number, number> }

const NODE_SORT_KEY = "jikasei:node_sort"
const nameOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })

export function isResourceSort(mode: NodeSort): mode is ResourceSort {
  return mode === "cpu" || mode === "memory" || mode === "disk"
}

export function defaultSortDirection(mode: NodeSort): SortDirection {
  return mode === "default" || mode === "name" || mode === "offline" || mode === "expiry" ? "asc" : "desc"
}

export function savedNodeSort(): NodeSortChoice {
  try {
    const [saved, direction] = localStorage.getItem(NODE_SORT_KEY)?.split(":") ?? []
    if (saved && Object.hasOwn(NODE_SORT_LABELS, saved)) {
      const mode = saved as NodeSort
      return { mode, direction: direction === "asc" || direction === "desc" ? direction : defaultSortDirection(mode) }
    }
  } catch {
    // 禁止存储时仍可在当前会话里切换。
  }
  return { mode: "default", direction: "asc" }
}

export function saveNodeSort({ mode, direction }: NodeSortChoice) {
  try {
    if (mode === "default") localStorage.removeItem(NODE_SORT_KEY)
    else {
      // 默认方向继续沿用原来的存值，反向时再在同一条记录里附上方向。
      const record = direction === defaultSortDirection(mode) ? mode : `${mode}:${direction}`
      localStorage.setItem(NODE_SORT_KEY, record)
    }
  } catch {
    // 保存失败时仍保留当前选择。
  }
}

export function captureResourceReadings(nodes: Node[], mode: ResourceSort): ReadonlyMap<number, number> {
  const readings = new Map<number, number>()
  for (const node of nodes) {
    const m = node.metrics
    if (!node.online || !m) continue
    const reading = mode === "cpu" ? m.cpu
      : mode === "memory" ? m.mem_used / m.mem_total
      : m.disk_used / m.disk_total
    if (Number.isFinite(reading)) readings.set(node.id, reading)
  }
  return readings
}

/** 输入已按后台排序。稳定排序使并列与缺少读数的节点保留原有次序。 */
export function sortNodes(nodes: Node[], { mode, direction, readings }: NodeSortPreference, rates: Record<string, number>): Node[] {
  if (mode === "default") return nodes
  const sign = direction === "asc" ? 1 : -1
  if (mode === "name") return [...nodes].sort((a, b) => sign * nameOrder.compare(a.name, b.name))

  const rank = (node: Node): number | null => {
    switch (mode) {
      case "offline": return Number(node.online)
      case "expiry": return expiryDaysOf(node)
      case "traffic": return monthUsage(node)
      case "monthly": return monthlyCostOf(node, rates)
      default: return readings?.get(node.id) ?? null
    }
  }
  return nodes
    .map((node) => ({ node, rank: rank(node) }))
    .sort((a, b) => {
      if (a.rank === b.rank) return 0
      if (a.rank === null) return 1
      if (b.rank === null) return -1
      return sign * (a.rank - b.rank)
    })
    .map(({ node }) => node)
}
