import type { Camera, GlobeNode, GlobeView, Pt } from "./globe.ts"
import type { FlatCamera, MapBounds } from "./map.ts"

type Point = { x: number; y: number }
type FlowPoint = Pick<GlobeNode, "key" | "id" | "count" | "offlineCount"> & { px: number; py: number }
type Vector = [number, number, number]
type FlowPath = {
  key: string
  d: string
  arrow: string
  active: boolean
  delay: number
  front?: string
  back?: string
  arrowBack?: boolean
}
type PreparedGlobeFlow = Pick<FlowPath, "key" | "active" | "delay"> & { samples: Vector[] }
const GLOBE_FLOW_LIFT = 0.34
const xy = ({ x, y }: Point) => `${x.toFixed(2)} ${y.toFixed(2)}`

function arrow(tip: Point, angle: number, size: number): string {
  const back = { x: tip.x - Math.cos(angle) * size, y: tip.y - Math.sin(angle) * size }
  const cross = { x: -Math.sin(angle) * size * 0.58, y: Math.cos(angle) * size * 0.58 }
  return `M ${xy({ x: back.x + cross.x, y: back.y + cross.y })} L ${xy(tip)} L ${xy({ x: back.x - cross.x, y: back.y - cross.y })}`
}

/** 给最高空间弧预留上下留白；球体半径与缩放口径仍由 zoomView 决定。 */
export function globeFlowView(view: GlobeView): GlobeView {
  const margin = view.r * GLOBE_FLOW_LIFT
  return { ...view, cy: view.cy + margin, h: view.h + margin * 2 }
}

function unit([lon, lat]: [number, number]): Vector {
  const a = lon * Math.PI / 180
  const b = lat * Math.PI / 180
  return [Math.cos(b) * Math.sin(a), Math.sin(b), Math.cos(b) * Math.cos(a)]
}

export function globeFlowPoint(cam: Camera, location: [number, number]): Pt {
  return cam.flat(...unit(location))
}

/** 地点变化时预计算单位球上的大圆与径向抬升，旋转帧只做相机投影。 */
export function prepareGlobeFlows(points: GlobeNode[], center: GlobeNode, centerOnline: boolean): PreparedGlobeFlow[] {
  const end = unit(center.ll)
  return points.flatMap((point) => {
    if (point.key === center.key) return []
    const start = unit(point.ll)
    const dot = Math.max(-1, Math.min(1, start.reduce((sum, value, i) => sum + value * end[i], 0)))
    const angle = Math.acos(dot)
    if (angle < 1e-8) return []
    let tangent = end.map((value, i) => value - dot * start[i])
    let length = Math.hypot(...tangent)
    if (length < 1e-8) {
      // 对跖点的大圆不唯一；选稳定的垂直方向，避免除以零及随相机翻转。
      tangent = Math.abs(start[1]) < 0.9 ? [-start[2], 0, start[0]] : [0, start[2], -start[1]]
      length = Math.hypot(...tangent)
    }
    const direction = tangent.map((value) => value / length)
    const lift = 0.12 + (GLOBE_FLOW_LIFT - 0.12) * angle / Math.PI
    const samples = Array.from({ length: 65 }, (_, index): Vector => {
      const t = index / 64
      const radius = 1 + lift * Math.sin(Math.PI * t)
      return start.map((value, i) => radius * (value * Math.cos(angle * t) + direction[i] * Math.sin(angle * t))) as Vector
    })
    return [{ key: point.key, active: centerOnline && point.offlineCount < point.count, delay: -(point.id % 13) * 0.24, samples }]
  })
}

function occluded(point: Pt, view: GlobeView): boolean {
  return point.k < -1e-8 && Math.hypot(point.x - view.cx, point.y - view.cy) < view.r
}

function splitDepth(samples: Pt[], view: GlobeView) {
  const parts = ["", ""]
  let previous = samples[0]
  let side = Number(occluded(previous, view))
  parts[side] = `M ${xy(previous)}`
  for (const point of samples.slice(1)) {
    const nextSide = Number(occluded(point, view))
    if (side !== nextSide) {
      let low = 0
      let high = 1
      const at = (t: number) => ({ x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t, k: previous.k + (point.k - previous.k) * t })
      for (let i = 0; i < 18; i++) {
        const middle = (low + high) / 2
        if (Number(occluded(at(middle), view)) === side) low = middle
        else high = middle
      }
      const crossing = xy(at((low + high) / 2))
      parts[side] += ` L ${crossing}`
      parts[nextSide] += ` M ${crossing}`
    }
    parts[nextSide] += ` L ${xy(point)}`
    previous = point
    side = nextSide
  }
  return { front: parts[0].trim(), back: parts[1].trim() }
}

/** 包含背面端点的完整路线；按球体遮挡切分实线与透视虚线。 */
export function globeFlowPaths(flows: PreparedGlobeFlow[], cam: Camera, scale: number): FlowPath[] {
  return flows.map(({ samples, ...flow }) => {
    const projected = samples.map((point) => cam.flat(...point))
    const tipIndex = Math.floor((projected.length - 1) * 0.68)
    const tip = projected[tipIndex]
    const before = projected[tipIndex - 1]
    const after = projected[tipIndex + 1]
    const angle = Math.atan2(after.y - before.y, after.x - before.x)
    return {
      ...flow,
      d: projected.map((point, i) => `${i ? "L" : "M"} ${xy(point)}`).join(" "),
      ...splitDepth(projected, cam.view),
      arrow: arrow(tip, angle, 4 * scale),
      arrowBack: occluded(tip, cam.view),
    }
  })
}

export function flowMapBounds({ bounds, zoom }: FlatCamera): MapBounds {
  const scale = Math.min(1, zoom / 100)
  const w = bounds.w * scale
  const h = bounds.h * scale
  return { x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h }
}

function arc(start: Point, end: Point, scale: number, bounds: MapBounds) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 2 * scale) return null
  const control = {
    x: (start.x + end.x) / 2 + (length - Math.abs(dx)) * 0.18,
    y: (start.y + end.y) / 2 - length * 0.37,
  }
  control.y = Math.max(bounds.y, control.y)

  // 把箭头画在曲线切线上；箭头在光点停下时仍可辨认流向。
  const t = 0.68
  const u = 1 - t
  const tip = { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y }
  const angle = Math.atan2(u * (control.y - start.y) + t * (end.y - control.y), u * (control.x - start.x) + t * (end.x - control.x))
  const size = Math.min(4 * scale, length * 0.18)
  return {
    d: `M ${xy(start)} Q ${xy(control)} ${xy(end)}`,
    arrow: arrow(tip, angle, size),
  }
}

/** 2D 用最短经度差，过地图接缝时绘制两端并交由视口裁切。 */
export function mapFlowPaths(points: FlowPoint[], center: FlowPoint, centerOnline: boolean, scale: number, flat: FlatCamera): FlowPath[] {
  const bounds = flowMapBounds(flat)
  const worldWidth = flat.bounds.w * flat.zoom / 100
  return points.flatMap((point) => {
    if (point.key === center.key) return []
    const active = centerOnline && point.offlineCount < point.count
    const delta = point.px - center.px
    const x = worldWidth ? point.px - Math.round(delta / worldWidth) * worldWidth : point.px
    const copies = worldWidth ? [0, -1, 1] : [0]
    return copies.flatMap((copy) => {
      const start = { x: x + copy * worldWidth, y: point.py }
      const end = { x: center.px + copy * worldWidth, y: center.py }
      if (Math.max(start.x, end.x) <= bounds.x || Math.min(start.x, end.x) >= bounds.x + bounds.w) return []
      const path = arc(start, end, scale, bounds)
      return path ? [{ ...path, key: `${point.key}:${copy}`, active, delay: -(point.id % 13) * 0.24 }] : []
    })
  })
}
