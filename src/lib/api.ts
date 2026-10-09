import { useEffect, useState } from "react"
import { recordNodeSpeeds } from "./speed-history.ts"
import { ApiError, requestJSON, startNodeTransport } from "./transport.ts"
export { ApiError } from "./transport.ts"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  /** Set by the operator; empty is ungrouped. Absent from a hub predating groups. */
  group?: string
  /**
   * 站长在后台写给访客的一行说明（单行、≤100 字，留空是空串）。hub 1.3.2 起随**公开视图**
   * 一起下发，所以匿名也拿得到——与最下面那个私有的 `remark` 不是一回事。老 hub 没有这个 key。
   * 这是访客可见的那条备注（见 `@/lib/notes`）：主题这边没有备注设置项，只读 hub 下发的字段。
   */
  public_remark?: string | null
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  /**
   * Days until `expires_at` on the hub's calendar, negative once past, null
   * without a date. Absent on older hubs.
   */
  expires_in?: number | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** This period's usage as the plan meters it (`traffic_mode`). Absent on older hubs. */
  month_used?: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel only. */
  hostname?: string
  ip?: string
  remark?: string
}

/** Every group in use, in the order of the first node carrying it: the operator's node order decides the tab order. */
export function groupsOf(nodes: Pick<Node, "group">[]): string[] {
  return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
}

/**
 * 分组筛选的一次求值：把「选中的那一档」归一化，并给出要显示的节点、标签行的内容与总台数。
 *
 * 归一化：选中的分组被改名/解散、或「未分组」里已经没人了，都回落「全部」而不是停在一个
 * 什么都看不见的筛选上，且不记住——以后出现同名分组也不会自己接手这个页面。
 * 标签行整行关掉（listTop 不含 groups）时 `current` 恒为 null：站长在后台一关，
 * 访客手里的分组选中态就作废。
 *
 * ★App 与 NodeList 读**同一次**求值：概览卡片取 `shown`、下面的列表也取 `shown`，
 * 两边不可能各说一套。早先概览卡片拿的是全量节点，切了分组后上面写着「3 / 4 · Node B」、
 * 下面却只剩一个分组那两张卡片 —— 参考站（monitor 内置 default 主题）的概览四格拿的
 * 就是筛选后的节点，这里对齐它。
 */
export function groupView(nodes: Node[], group: string | null, showTabs: boolean) {
  const groups = groupsOf(nodes)
  const ungrouped = nodes.filter((n) => !n.group).length
  const current = !showTabs ? null : group === null || (group === "" ? ungrouped > 0 : groups.includes(group)) ? group : null
  const shown = current === null ? nodes : nodes.filter((n) => (n.group ?? "") === current)
  const tabs = [
    [null, "全部", nodes.length] as const,
    ...groups.map((g) => [g, g, nodes.filter((n) => n.group === g).length] as const),
    ...(ungrouped ? [["", "未分组", ungrouped] as const] : []),
  ]
  return { groups, ungrouped, current, shown, tabs, total: nodes.length, showTabs }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJSON<T>(`/api${path}`, init)
}

/**
 * Throughput, one sample per push, as a series for every node (null) and one per
 * group ("" for the ungrouped), so the summary above a group tab draws that
 * group's line rather than the fleet's. Held beside the stream that feeds it
 * rather than in the tile that draws it: the summary unmounts while a node page
 * is open, so a buffer held there would restart empty on every return. Two
 * minutes at the hub's push interval; a group no node carries any more is
 * dropped. Keyed null rather than by any string, since a group may be named
 * anything, "*" included.
 */
const KEEP = 60
export const speedHistory = new Map<string | null, { rx: number; tx: number }[]>()

export function sample(nodes: Node[]) {
  recordNodeSpeeds(nodes)
  const totals = new Map<string | null, { rx: number; tx: number }>()
  for (const n of nodes) {
    for (const key of [null, n.group ?? ""]) {
      const total = totals.get(key) ?? { rx: 0, tx: 0 }
      if (n.online && n.metrics) {
        total.rx += n.metrics.net_rx
        total.tx += n.metrics.net_tx
      }
      totals.set(key, total)
    }
  }
  for (const key of speedHistory.keys()) if (!totals.has(key)) speedHistory.delete(key)
  for (const [key, total] of totals) {
    const series = speedHistory.get(key) ?? []
    series.push(total)
    if (series.length > KEEP) series.shift()
    speedHistory.set(key, series)
  }
}

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: unknown): Node[] {
  if (!Array.isArray(nodes)) throw new Error("节点数据格式错误")
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.id) || raw.id <= 0) return []
    const node = raw as Node
    const safe = { ...node }
    for (const key of ["name", "country", "os", "kernel", "arch", "virt", "cpu_name", "agent_version",
      "currency", "billing_cycle", "traffic_mode", "month_start"] as const) {
      if (typeof safe[key] !== "string") safe[key] = ""
    }
    // Old hubs omit optional metadata; normalize only fields that are actually present.
    for (const key of ["group", "public_remark", "remark", "hostname", "ip"] as const) {
      if (safe[key] != null && typeof safe[key] !== "string") safe[key] = ""
    }
    if (!/^[A-Za-z]{2}$/.test(safe.country)) safe.country = ""
    for (const key of ["last_seen", "cpu_cores", "mem_total", "swap_total", "disk_total", "price", "traffic_limit",
      "traffic_reset_day", "total_rx", "total_tx", "month_rx", "month_tx", "day_rx", "day_tx"] as const) {
      if (!number(safe[key])) safe[key] = 0
    }
    if (safe.month_used !== undefined && !number(safe.month_used)) delete safe.month_used
    if (typeof safe.expires_in !== "number" || !Number.isFinite(safe.expires_in)) delete safe.expires_in
    if (typeof safe.expires_at !== "string") safe.expires_at = null
    if (typeof safe.sort !== "number" || !Number.isFinite(safe.sort)) safe.sort = 0
    safe.online = safe.online === true
    safe.public = safe.public === true
    const m = safe.metrics
    safe.metrics = m && typeof m === "object" && fields.every((key) => number(m[key])) &&
      Array.isArray(m.load) && m.load.length === 3 && m.load.every(number) ? m : null
    return [Object.keys(safe).every((key) => safe[key as keyof Node] === node[key as keyof Node]) &&
      Object.keys(safe).length === Object.keys(node).length ? node : safe]
  })
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds, falling
 * back to polling if it cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set when the hub answers 401: the status page has been closed to anonymous
  // callers since this tab loaded. The hub also ends the stream, so this surfaces
  // on the fallback fetch the reconnect starts; a close allows a client to
  // re-query its state but cannot compel it.
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    const readNodes = (data: unknown) => {
      if (!data || typeof data !== "object" || !Array.isArray((data as { nodes?: unknown }).nodes)) {
        throw new Error("节点数据格式错误")
      }
      return safeNodes((data as { nodes: unknown[] }).nodes)
    }
    return startNodeTransport({
      fetchNodes: (signal) => api<unknown>("/nodes", { signal }).then(readNodes),
      openSocket: () => new WebSocket(url),
      parseMessage: (data) => readNodes(JSON.parse(data)),
      receive: (safe) => {
        sample(safe)
        setNodes(safe)
        setError(null)
        setClosed(false)
      },
      fail: (error) => {
        setError(error instanceof Error ? error.message || "网络错误" : "网络错误")
        if (error instanceof ApiError && error.status === 401) setClosed(true)
      },
    })
  }, [])

  return { nodes, error, closed }
}
