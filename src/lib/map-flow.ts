import type { GlobeNode, GlobeView } from "./globe.ts"
import type { FlatCamera, MapBounds } from "./map.ts"

type Point = { x: number; y: number }
type FlowPoint = Pick<GlobeNode, "key" | "id" | "count" | "offlineCount"> & { px: number; py: number }
type FlowProjection = { globe: GlobeView } | { flat: FlatCamera }

export function flowMapBounds({ bounds, zoom }: FlatCamera): MapBounds {
  const scale = Math.min(1, zoom / 100)
  const w = bounds.w * scale
  const h = bounds.h * scale
  return { x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h }
}

function arc(start: Point, end: Point, scale: number, projection: FlowProjection, bounds: MapBounds | null) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 2 * scale) return null
  const control = {
    x: (start.x + end.x) / 2 + (length - Math.abs(dx)) * 0.18,
    y: (start.y + end.y) / 2 - length * 0.37,
  }
  if ("globe" in projection) {
    const { cx, cy, r } = projection.globe
    const radius = Math.hypot(control.x - cx, control.y - cy)
    if (radius > r) {
      control.x = cx + (control.x - cx) * r / radius
      control.y = cy + (control.y - cy) * r / radius
    }
  } else if (bounds) {
    control.y = Math.max(bounds.y, control.y)
  }

  // 把箭头画在曲线切线上；箭头在光点停下时仍可辨认流向。
  const t = 0.68
  const u = 1 - t
  const tip = { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y }
  const angle = Math.atan2(u * (control.y - start.y) + t * (end.y - control.y), u * (control.x - start.x) + t * (end.x - control.x))
  const size = Math.min(4 * scale, length * 0.18)
  const back = { x: tip.x - Math.cos(angle) * size, y: tip.y - Math.sin(angle) * size }
  const cross = { x: -Math.sin(angle) * size * 0.58, y: Math.cos(angle) * size * 0.58 }
  const xy = ({ x, y }: Point) => `${x.toFixed(2)} ${y.toFixed(2)}`
  return {
    d: `M ${xy(start)} Q ${xy(control)} ${xy(end)}`,
    arrow: `M ${xy({ x: back.x + cross.x, y: back.y + cross.y })} L ${xy(tip)} L ${xy({ x: back.x - cross.x, y: back.y - cross.y })}`,
  }
}

/** 3D 调用方传入当前可见半球；2D 用最短经度差，过地图接缝时绘制两端并交由视口裁切。 */
export function mapFlowPaths(points: FlowPoint[], center: FlowPoint, centerOnline: boolean, scale: number, projection: FlowProjection) {
  const flat = "flat" in projection ? projection.flat : null
  const bounds = flat ? flowMapBounds(flat) : null
  const worldWidth = flat ? flat.bounds.w * flat.zoom / 100 : 0
  return points.flatMap((point) => {
    if (point.key === center.key) return []
    const active = centerOnline && point.offlineCount < point.count
    const delta = point.px - center.px
    const x = worldWidth ? point.px - Math.round(delta / worldWidth) * worldWidth : point.px
    const copies = worldWidth ? [0, -1, 1] : [0]
    return copies.flatMap((copy) => {
      const start = { x: x + copy * worldWidth, y: point.py }
      const end = { x: center.px + copy * worldWidth, y: center.py }
      if (bounds && (Math.max(start.x, end.x) <= bounds.x || Math.min(start.x, end.x) >= bounds.x + bounds.w)) return []
      const path = arc(start, end, scale, projection, bounds)
      return path ? [{ ...path, key: `${point.key}:${copy}`, active, delay: -(point.id % 13) * 0.24 }] : []
    })
  })
}
