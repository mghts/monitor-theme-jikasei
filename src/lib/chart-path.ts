export type PlotPoint = { x: number; y: number }

type LineOptions = { connectGaps?: boolean; smooth?: boolean }

const coordinate = (point: PlotPoint) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`
const finite = (point: PlotPoint) => Number.isFinite(point.x) && Number.isFinite(point.y)
const clamp = (value: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), value))

/** 只在严格递增且差值可计算的时间区间内求导，其余相邻点仍可用直线呈现。 */
function safeInterval(a: PlotPoint, b: PlotPoint): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dx > 0 && Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dy / dx)
}

/** 单调 Hermite 的内部切线：按真实 x 间隔加权，转折与平坦处切线为零。 */
function tangent(before: number, after: number, left: number, right: number): number {
  if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return 0
  // 归一化间距与斜率，避免 2*h 或 1/d 在极端有限数值上先溢出。
  const width = Math.max(left, right)
  const h0 = left / width
  const h1 = right / width
  const w0 = 2 * h1 + h0
  const w1 = h1 + 2 * h0
  const low = Math.min(Math.abs(before), Math.abs(after))
  const high = Math.max(Math.abs(before), Math.abs(after))
  const value = low * ((w0 + w1) / (w0 * (low / Math.abs(before)) + w1 * (low / Math.abs(after))))
  return Math.sign(before) * Math.min(high, Number.isFinite(value) ? value : low)
}

/** 返回同一递增片段的后续命令；第一点已经由调用方的 M 或 L 写入。 */
function smoothSegments(points: PlotPoint[]): string {
  if (points.length < 2) return ""
  if (points.length === 2) return `L${coordinate(points[1])}`
  const widths = points.slice(1).map((point, i) => point.x - points[i].x)
  const slopes = points.slice(1).map((point, i) => (point.y - points[i].y) / widths[i])
  const tangents = [slopes[0]]
  for (let i = 1; i < points.length - 1; i++) {
    tangents.push(tangent(slopes[i - 1], slopes[i], widths[i - 1], widths[i]))
  }
  tangents.push(slopes[slopes.length - 1])
  let path = ""
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const slope = slopes[i]
    // 用斜率比值表示控制点在相邻 y 范围中的位置，避免 h*m 的乘法溢出。
    const ratio = (value: number) => slope === 0 ? 0 : Math.max(0, Math.min(3, value / slope)) / 3
    const dy = b.y - a.y
    const first = {
      x: clamp(a.x + widths[i] / 3, a.x, b.x),
      y: clamp(a.y + dy * ratio(tangents[i]), a.y, b.y),
    }
    const second = {
      x: clamp(b.x - widths[i] / 3, a.x, b.x),
      y: clamp(b.y - dy * ratio(tangents[i + 1]), a.y, b.y),
    }
    // 两个控制点都在相邻样本的范围中，Bezier 不会产生过冲或越过零延迟。
    path += `C${coordinate(first)} ${coordinate(second)} ${coordinate(b)}`
  }
  return path
}

function runPath(points: PlotPoint[], smooth: boolean): string {
  if (!points.length) return ""
  let path = `M${coordinate(points[0])}`
  if (!smooth) return path + points.slice(1).map((point) => `L${coordinate(point)}`).join("")
  let start = 0
  while (start < points.length - 1) {
    let end = start
    while (end + 1 < points.length && safeInterval(points[end], points[end + 1])) end++
    path += smoothSegments(points.slice(start, end + 1))
    if (end === points.length - 1) break
    // 重复、逆序或溢出的 x 间隔不参与切线计算，保留采样顺序并退回直线。
    path += `L${coordinate(points[end + 1])}`
    start = end + 1
  }
  return path
}

/** 只生成 SVG 路径，不插补、排序或修改样本；默认 null 断段，两个选项互相独立。 */
export function linePath(points: Array<PlotPoint | null>, options: LineOptions = {}): string {
  let path = ""
  let run: PlotPoint[] = []
  const flush = () => {
    path += runPath(run, options.smooth === true)
    run = []
  }
  for (const point of points) {
    if (point === null) {
      if (!options.connectGaps) flush()
    } else if (finite(point)) {
      run.push(point)
    } else {
      // 非有限坐标无法绘制，断段，避免把损坏的坐标序列送入 SVG。
      flush()
    }
  }
  flush()
  return path
}
