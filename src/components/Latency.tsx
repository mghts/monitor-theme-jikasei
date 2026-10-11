import { useEffect, useMemo, useState } from "react"

import { api, type Node } from "@/lib/api"
import { linePath } from "@/lib/chart-path"
import { clockFor } from "@/lib/format"
import { latestPing, withHistorySlot, withTimeGaps } from "@/lib/history"
import { latencyLineOptions } from "@/lib/site-settings"
import { useLatencyStyle } from "@/lib/theme-config"

/** `/api/nodes/{id}/metrics?series=ping` 返回里，本组件用到的几块（形状同详情页）。 */
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
type Probes = Record<string, string>
type Loss = Record<string, number>

type Probe = { id: number; name: string; points: PingPoint[]; loss: number; step?: number }

function normalize(d: { ping?: PingPoint[]; probes?: Probes; loss?: Loss; step?: number }): Probe[] {
  const ping = d.ping ?? []
  const names = d.probes ?? {}
  const loss = d.loss ?? {}
  return [...new Set(ping.map((p) => p.task_id))]
    .map((id) => ({
      id,
      name: names[String(id)] ?? `探测 ${id}`,
      points: ping.filter((p) => p.task_id === id).sort((a, b) => a.ts - b.ts),
      loss: Number(loss[String(id)] ?? 0),
      step: d.step,
    }))
    .filter((p) => p.points.length > 0)
}

/**
 * 卡片的延迟数据多久算过期。页面上其余数字跟着 hub 的快照在跳，这一块要是只在挂载时
 * 取一次，访客开着页面看十几分钟仍是进页面那一刻的延迟。到点重新取一次，成本与首屏
 * 相同（仍走上面那个三条并发的队列）。
 */
const TTL = 60_000

/**
 * 拉本节点最近一小时的延迟：点数取 40，够画一条能看出起伏的走势线，又不至于让每张
 * 卡片多背一大坨。刷新失败保留上次结果，并明确标记失败，避免把网络错误当作没有探测。
 *
 * 每 `TTL` 刷新一次；页面切到后台时不发（省掉访客看不见的流量），回到前台时若手上这份
 * 已经过期就补一次。同一时刻只允许一条在飞，避免慢请求叠着打。
 */
function useNodePing(id: number) {
  const [probes, setProbes] = useState<Probe[] | null>(null)
  const [failed, setFailed] = useState("")
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let alive = true
    let busy = false
    let fetchedAt = 0
    let controller: AbortController | null = null
    // oxlint-disable-next-line react/set-state-in-effect
    setProbes(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    const load = () => {
      if (document.visibilityState !== "visible" || busy || Date.now() - fetchedAt < TTL) return
      busy = true
      fetchedAt = Date.now()
      const request = new AbortController()
      controller = request
      withHistorySlot(
        () => api<{ ping?: PingPoint[]; probes?: Probes; loss?: Loss; step?: number }>(
          `/nodes/${id}/metrics?hours=1&points=40&series=ping`,
          { signal: request.signal },
        ),
        request.signal,
      )
        .then((d) => {
          if (alive && !request.signal.aborted) { setProbes(normalize(d)); setFailed(""); setNow(Date.now()) }
        })
        .catch((e: Error) => {
          if (alive && !request.signal.aborted) setFailed(e.message || "网络错误")
        })
        .finally(() => {
          busy = false
          if (alive && request.signal.aborted && document.visibilityState === "visible") load()
        })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") { setNow(Date.now()); load() }
      else { fetchedAt = 0; controller?.abort() }
    }
    load()
    const timer = window.setInterval(onVisible, TTL)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      alive = false
      controller?.abort()
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [id])
  return { probes, failed, now }
}

// 延迟分档：顺畅 / 偏高 / 糟，三档都走灰阶——这一块不抢旁边网络数的颜色，只用深浅说话。
// 阈值取整百毫秒，跨海线路普遍在 150-200 之间，想改就改这两个数。丢包只要不为零，
// 至少抬到「偏高」；到 5% 直接算「糟」。
const GOOD_MS = 100
const WARN_MS = 200
type Tone = "ok" | "warn" | "bad" | "none"

function toneOf(ms: number | null, loss: number): Tone {
  if (ms === null) return "none"
  if (loss >= 5 || ms >= WARN_MS) return "bad"
  if (loss > 0 || ms >= GOOD_MS) return "warn"
  return "ok"
}

// 越糟越深：顺畅用弱化灰（和旁边的线路名同色，安静），偏高转深，糟用前景色顶格。
// 数值与走势线共用这一个灰阶，一条线越黑越该看一眼。
const toneClass = (tone: Tone) =>
  tone === "bad" ? "text-foreground"
    : tone === "warn" ? "text-foreground/70"
      : "text-muted-foreground"

const SPARK_W = 100
const SPARK_H = 20

/** 走势线与详情共用样式和路径算法；null 时间仍占轴宽，不压缩丢包或采样缺口。 */
function Sparkline({ points, probeId, className, step }: { points: PingPoint[]; probeId: number; className: string; step?: number }) {
  const { style } = useLatencyStyle()
  const options = latencyLineOptions(style)
  const nums = points.filter((point) => Number.isFinite(point.ts) && typeof point.latency === "number" && Number.isFinite(point.latency))
    .map((point) => point.latency as number)
  if (nums.length < 2) return <span className="min-w-0 flex-1" />
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const times = points.filter((point) => Number.isFinite(point.ts)).map((point) => point.ts)
  const first = Math.min(...times)
  const last = Math.max(...times)
  const ratio = (value: number, low: number, high: number) => {
    if (high === low) return 0
    const span = high - low
    // 极端有限坐标相减也可能溢出，先减半后归一化；不向 SVG 传 NaN/Infinity。
    const position = Number.isFinite(span) ? (value - low) / span : (value / 2 - low / 2) / (high / 2 - low / 2)
    return Math.max(0, Math.min(1, position))
  }
  const path = linePath(withTimeGaps(points, step).map((point) => point !== null && Number.isFinite(point.ts) && typeof point.latency === "number" && Number.isFinite(point.latency)
    ? { x: ratio(point.ts, first, last) * SPARK_W, y: SPARK_H - 2 - ratio(point.latency, min, max) * (SPARK_H - 4) }
    : null), options)
  return (
    <svg
      data-latency-sparkline={probeId}
      data-connect-gaps={options.connectGaps}
      data-smooth-lines={options.smooth}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`h-4 min-w-0 flex-1 ${className}`}
      aria-hidden="true"
    >
      <path
        data-series={`t${probeId}`}
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/**
 * 卡面与浮层共用的一份行选择：站长在后台「三网延迟」里填了名字就按名字取、按填写的顺序，
 * 留空则按后台顺序自动取前三条；两处都卡在三条以内（与设置项里写的「最多三个」一致）。
 * 匹配用的是 ping 任务的名字，改过名、删过任务的那一行自然落空、不占位——三条的上限卡在
 * **真正渲染出来的行**上，所以先按名字取、再截断（反过来写的话，填写清单里前三个名字有一个
 * 对不上，访客就只看到两行，而设置项里明明写着三条）。
 */
function pickRows(probes: Probe[] | null, lines: string): Probe[] {
  const all = probes ?? []
  const wanted = [...new Set(lines.split("\n").map((s) => s.trim()).filter(Boolean))]
  if (wanted.length === 0) return all.slice(0, 3)
  const byName = new Map<string, Probe>()
  for (const p of all) if (!byName.has(p.name)) byName.set(p.name, p)
  return wanted
    .map((name) => byName.get(name))
    .filter((p): p is Probe => p !== undefined)
    .slice(0, 3)
}

const sampleClock = clockFor(168)

/** 卡面与浮层使用同一读数：最新桶超时就显示超时，旧桶明确附上样本时间。 */
function ProbeRow({ probe, now, compact = false }: { probe: Probe; now: number; compact?: boolean }) {
  const { sample, stale } = latestPing(probe.points, now)
  const ms = sample?.latency ?? null
  const gray = toneClass(toneOf(ms, probe.loss))
  return (
    <span className="block text-xs" title={sample ? `样本时间：${new Date(sample.ts * 1_000).toLocaleString("zh-CN")}` : "没有样本"}>
      <span className="flex items-center gap-2">
        <span className={`${compact ? "w-14" : "w-16"} shrink-0 truncate text-muted-foreground`}>{probe.name}</span>
        <span className={`tnum ${compact ? "w-12" : "w-14"} shrink-0 text-right font-medium ${gray}`}>
          {ms === null ? "超时" : `${ms} ms`}
        </span>
        <Sparkline points={probe.points} probeId={probe.id} className={gray} step={probe.step} />
        <span className={`tnum ${compact ? "w-9" : "w-10"} shrink-0 text-right text-muted-foreground`}>
          {probe.loss > 0 ? `${probe.loss.toFixed(1)}%` : "0.0%"}
        </span>
      </span>
      {stale && <span className="mt-0.5 block text-right text-[10px] text-muted-foreground">数据陈旧{sample ? ` · ${sampleClock(sample.ts * 1_000)}` : ""}</span>}
    </span>
  )
}

/**
 * 卡片底部那组「三网延迟」：一条线路一行——线路名、当前延迟、一小时走势、丢包率。
 * 数据来自 hub 的 ping 历史（同详情页的延迟图），按 `task_id` 一条一条摊开；线路名用的是
 * 站长在后台给 ping 任务起的名字，所以「广东电信」这类带地域的叫法原样呈现。
 * 延迟与走势只走灰阶，越糟越深（见 toneClass）。站长可在后台「三网延迟」里指定显示哪几条
 * （按 ping 任务名匹配，一行一个，最多三条）；留空时按后台顺序自动取前三条。数据每 60 秒
 * 刷新一次（页面在后台时不取）。
 */
export function LatencyPanel({ node, lines }: { node: Node; lines: string }) {
  const { probes, failed, now } = useNodePing(node.id)
  const rows = useMemo(() => pickRows(probes, lines), [probes, lines])
  if (rows.length === 0 && !failed) return null
  return (
    // `data-latency` 是给护栏认「这一档摊没摊三网延迟」的锚点（`data-net` 同一套做法：
    // 按类名找会在改版后失配，而失配的表现是"看着没坏"）。
    <div data-latency="" className="mt-4 space-y-1.5 border-t pt-4">
      {rows.map((p) => <ProbeRow key={p.id} probe={p} now={now} />)}
      {failed && <span className="block text-xs text-destructive" role="status">延迟刷新失败：{failed}</span>}
    </div>
  )
}

/**
 * 经典档浮层底部那三网延迟：一条线路一行——线路名、当前延迟、一小时走势、丢包率，
 * 与「延迟」档卡面同一套（同一个 `useNodePing`、同一套灰阶与走势线）。
 *
 * 两条口径：
 * ① **只有浮层打开时才会挂载**（调用处写在 `peekOpen` 里）⇒ 经典档默认一个 ping 请求都不发，
 *    点开哪台才取哪台；取不到、或这台没有延迟数据就整块不渲染（连分隔线一起没有）。
 * ② 行选择与卡面共用 `pickRows`：站长在后台「三网延迟」里指定、最多三条，留空取前三条。
 *
 * 这一块自带顶部分隔线（`border-t`）——它排在「到期」下面，靠这条线把「计费那几行」与
 * 「现在通不通」分开；没有数据时整块不渲染，所以也不会留下一条孤零零的线。
 */
export function PeekLatency({ node, lines }: { node: Node; lines: string }) {
  const { probes, failed, now } = useNodePing(node.id)
  const rows = useMemo(() => pickRows(probes, lines), [probes, lines])
  if (rows.length === 0 && !failed) return null
  return (
    <span data-peek-latency="" className="block space-y-1 border-t pt-2">
      {rows.map((p) => <ProbeRow key={p.id} probe={p} now={now} compact />)}
      {failed && <span className="block text-xs text-destructive" role="status">延迟刷新失败：{failed}</span>}
    </span>
  )
}
