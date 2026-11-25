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
type ResourceSort = "cpu" | "memory" | "disk"
export type NodeSortPreference = { mode: NodeSort; readings?: ReadonlyMap<number, number> }

const NODE_SORT_KEY = "jikasei:node_sort"
const nameOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })

export function isResourceSort(mode: NodeSort): mode is ResourceSort {
  return mode === "cpu" || mode === "memory" || mode === "disk"
}

export function savedNodeSort(): NodeSort {
  try {
    const saved = localStorage.getItem(NODE_SORT_KEY)
    if (saved !== null && Object.hasOwn(NODE_SORT_LABELS, saved)) return saved as NodeSort
  } catch {
    // 禁止存储时仍可在当前会话里切换。
  }
  return "default"
}

export function saveNodeSort(mode: NodeSort) {
  try {
    if (mode === "default") localStorage.removeItem(NODE_SORT_KEY)
    else localStorage.setItem(NODE_SORT_KEY, mode)
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
export function sortNodes(nodes: Node[], { mode, readings }: NodeSortPreference, rates: Record<string, number>): Node[] {
  if (mode === "default") return nodes
  if (mode === "name") return [...nodes].sort((a, b) => nameOrder.compare(a.name, b.name))

  const rank = (node: Node) => {
    switch (mode) {
      case "offline": return Number(node.online)
      case "expiry": return expiryDaysOf(node) ?? Infinity
      case "traffic": return -monthUsage(node)
      case "monthly": return -(monthlyCostOf(node, rates) ?? -Infinity)
      default: return -(readings?.get(node.id) ?? -Infinity)
    }
  }
  return nodes
    .map((node) => ({ node, rank: rank(node) }))
    .sort((a, b) => a.rank === b.rank ? 0 : a.rank - b.rank)
    .map(({ node }) => node)
}
