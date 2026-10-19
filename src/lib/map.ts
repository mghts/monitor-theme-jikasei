import type { Camera, GlobeNode, GlobeView } from "./globe.ts"
import type { Ring } from "./world.ts"

export const MAP_VIEW = { w: 460, h: 240, viewBox: "0 0 460 240" } as const
/** 2:1 等距矩形；组件可按实际可用区域传入自适应边界。 */
export const MAP_BOUNDS = { x: 20, y: 10, w: 420, h: 210 } as const
export type MapBounds = { x: number; y: number; w: number; h: number }
export type MapPoint = { x: number; y: number; visible: boolean }
export type FlatCamera = { lon: number; lat: number; zoom: number; bounds: MapBounds; at(lon: number, lat: number): MapPoint | null }
export type PreparedMap = { rings: Ring[] }
export type FlatNode = GlobeNode & { px: number; py: number; visible: boolean }
type GeoBox = { left: number; right: number; bottom: number; top: number }
const EPS = 1e-9

/** 用 CSS 像素作 SVG 坐标，完整世界居中铺开，四周仅留信标光晕所需的空间。 */
export function mapViewport(width: number = MAP_VIEW.w, height: number = MAP_VIEW.h): { w: number; h: number; bounds: MapBounds } {
  const w = Number.isFinite(width) && width > 48 ? width : MAP_VIEW.w
  const h = Number.isFinite(height) && height > 48 ? height : MAP_VIEW.h
  const mapWidth = Math.min(w - 24, 2 * (h - 24))
  const mapHeight = mapWidth / 2
  return { w, h, bounds: { x: (w - mapWidth) / 2, y: (h - mapHeight) / 2, w: mapWidth, h: mapHeight } }
}

/** 保留 +180/-180 各自的边框，其他经度折回一周；不对大数做可能溢出的加法。 */
function longitude(value: number): number {
  if (value >= -180 && value <= 180) return value
  const lon = value % 360
  return lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon
}

function project(cam: FlatCamera, lon: number, lat: number): MapPoint {
  const { bounds: b } = cam
  const scale = cam.zoom / 100
  const x = b.x + b.w / 2 + (lon - cam.lon) / 360 * b.w * scale
  const y = b.y + b.h / 2 - (lat - cam.lat) / 180 * b.h * scale
  return { x, y, visible: x >= b.x - EPS && x <= b.x + b.w + EPS && y >= b.y - EPS && y <= b.y + b.h + EPS }
}

/** 相机只改变投影，viewport 固定；中心经度可绕一周，纬度限制到两极。 */
export function flatCamera(lon = 0, lat = 0, zoom = 100, bounds: MapBounds = MAP_BOUNDS): FlatCamera {
  const validBounds = [bounds.x, bounds.y, bounds.w, bounds.h, bounds.x + bounds.w, bounds.y + bounds.h].every(Number.isFinite) && bounds.w > 0 && bounds.h > 0
  const cam: FlatCamera = {
    lon: Number.isFinite(lon) ? longitude(lon) : 0,
    lat: Number.isFinite(lat) ? Math.max(-90, Math.min(90, lat)) : 0,
    zoom: Number.isFinite(zoom) ? Math.max(50, Math.min(150, zoom)) : 100,
    bounds: validBounds ? { ...bounds } : { ...MAP_BOUNDS },
    at(nodeLon, nodeLat) {
      if (!Number.isFinite(nodeLon) || !Number.isFinite(nodeLat) || nodeLat < -90 || nodeLat > 90) return null
      // 先各自归一化，避免有限经度相减先溢出。
      const delta = longitude(longitude(nodeLon) - cam.lon)
      const p = project(cam, cam.lon + delta, nodeLat)
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null
    },
  }
  return cam
}

/** 供现有左右标签排布使用；裁切外节点不参与排布，2D 的可见点 k 恒为 1。 */
export function mapLabelCamera(cam: FlatCamera, view: GlobeView): Pick<Camera, "view" | "at"> {
  return { view, at(lon, lat) { const p = cam.at(lon, lat); return p?.visible ? { x: p.x, y: p.y, k: 1 } : null } }
}

/** 不更改输入；按相邻点的近路展开经度，让跨日期变更线的小岛保持为小岛。 */
export function prepareMapRings(rings: Ring[]): PreparedMap {
  const prepared: Ring[] = []
  for (const ring of rings) {
    if (ring.length < 3 || ring.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90)) continue
    const next: Ring = []
    ring.forEach(([rawLon, lat], i) => {
      let lon = longitude(rawLon)
      if (i) {
        const previous = next[i - 1]
        // world.ts 南极环显式包含 [+180,-90]→[-180,-90]：它是极地封口，必须横跨地图底边。
        const polarEdge = Math.abs(lat) === 90 && lat === previous[1] && Math.abs(rawLon - ring[i - 1][0]) >= 359
        lon = polarEdge ? previous[0] + longitude(rawLon) - longitude(ring[i - 1][0])
          : lon + Math.round((previous[0] - lon) / 360) * 360
      }
      next.push([lon, lat])
    })
    prepared.push(next)
  }
  return { rings: prepared }
}

/** 缩小时仍只显示一份世界；放大时只取 viewport 内的经纬范围。 */
function geoBox(cam: FlatCamera): GeoBox {
  const halfLon = 180 / Math.max(1, cam.zoom / 100)
  const halfLat = 90 / (cam.zoom / 100)
  return { left: cam.lon - halfLon, right: cam.lon + halfLon, bottom: Math.max(-90, cam.lat - halfLat), top: Math.min(90, cam.lat + halfLat) }
}

/** Sutherland–Hodgman：填充需要沿裁切边界闭合，描边则不能画这些人工边。 */
function clipPolygon(ring: Ring, box: GeoBox): Ring {
  let points = ring
  for (const [axis, edge, lower] of [[0, box.left, true], [0, box.right, false], [1, box.bottom, true], [1, box.top, false]] as const) {
    const output: Ring = []
    if (!points.length) break
    const inside = (p: [number, number]) => lower ? p[axis] >= edge : p[axis] <= edge
    let previous = points[points.length - 1]
    for (const current of points) {
      if (inside(previous) !== inside(current)) {
        const t = (edge - previous[axis]) / (current[axis] - previous[axis])
        const p: [number, number] = [previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]
        p[axis] = edge
        output.push(p)
      }
      if (inside(current)) output.push(current)
      previous = current
    }
    points = output
  }
  return points
}

/** Liang–Barsky：逐条海岸线裁切，不连接不同可见段，也不沿 viewport 补描边。 */
function clipLine(a: [number, number], b: [number, number], box: GeoBox): Ring | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const p = [-dx, dx, -dy, dy]
  const q = [a[0] - box.left, box.right - a[0], a[1] - box.bottom, box.top - a[1]]
  let first = 0
  let last = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue }
    const t = q[i] / p[i]
    if (p[i] < 0) first = Math.max(first, t)
    else last = Math.min(last, t)
    if (first > last) return null
  }
  return [[a[0] + dx * first, a[1] + dy * first], [a[0] + dx * last, a[1] + dy * last]]
}

const coordinate = (p: MapPoint) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`
const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS

/** 每个经度副本先拆分/裁切，再投影；不会把日期变更线两侧用一条伪海岸线相连。 */
export function mapPaths(cam: FlatCamera, prepared: PreparedMap): { fill: string; stroke: string } {
  const box = geoBox(cam)
  let fill = ""
  let stroke = ""
  for (const ring of prepared.rings) {
    const minLon = Math.min(...ring.map((p) => p[0]))
    const maxLon = Math.max(...ring.map((p) => p[0]))
    const firstCopy = Math.ceil((box.left - maxLon) / 360)
    const lastCopy = Math.floor((box.right - minLon) / 360)
    for (let copy = firstCopy; copy <= lastCopy; copy++) {
      const shifted: Ring = ring.map(([lon, lat]) => [lon + copy * 360, lat])
      const polygon = clipPolygon(shifted, box)
      const area = polygon.reduce((sum, p, i) => {
        const next = polygon[(i + 1) % polygon.length]
        return sum + p[0] * next[1] - next[0] * p[1]
      }, 0)
      if (polygon.length >= 3 && Math.abs(area) > EPS) {
        fill += polygon.map(([lon, lat], i) => `${i ? "L" : "M"} ${coordinate(project(cam, lon, lat))} `).join("") + "Z "
      }
      let previous: [number, number] | null = null
      for (let i = 0; i < shifted.length; i++) {
        const a = shifted[i]
        const b = shifted[(i + 1) % shifted.length]
        // 原始数据也有在 ±180 与南极底边上的人工封口；保留填充，不把它描成海岸线。
        const seamEdge = Math.abs(a[0] - b[0]) < EPS && Math.abs(Math.abs(longitude(a[0])) - 180) < EPS
        const poleEdge = a[1] === b[1] && Math.abs(a[1]) === 90
        if (seamEdge || poleEdge) { previous = null; continue }
        const clipped = clipLine(a, b, box)
        if (!clipped || same(clipped[0], clipped[1])) { previous = null; continue }
        if (!previous || !same(previous, clipped[0])) stroke += `M ${coordinate(project(cam, clipped[0][0], clipped[0][1]))} `
        stroke += `L ${coordinate(project(cam, clipped[1][0], clipped[1][1]))} `
        previous = clipped[1]
      }
    }
  }
  return { fill: fill.trim(), stroke: stroke.trim() }
}

export function mapGraticule(cam: FlatCamera, lonStep = 30, latStep = 30): Array<{ d: string; width: number; equator: boolean }> {
  const box = geoBox(cam)
  const longitudeStep = Number.isFinite(lonStep) && lonStep >= 1 ? Math.min(360, lonStep) : 30
  const latitudeStep = Number.isFinite(latStep) && latStep >= 1 ? Math.min(180, latStep) : 30
  const wires: Array<{ d: string; width: number; equator: boolean }> = []
  const line = (a: [number, number], b: [number, number], equator = false) => {
    const clipped = clipLine(a, b, box)
    if (!clipped || same(clipped[0], clipped[1])) return
    wires.push({ d: `M ${coordinate(project(cam, clipped[0][0], clipped[0][1]))} L ${coordinate(project(cam, clipped[1][0], clipped[1][1]))}`, width: equator ? 1 : 0.65, equator })
  }
  for (let lon = -180; lon < 180; lon += longitudeStep) {
    const shifted = cam.lon + longitude(lon - cam.lon)
    line([shifted, -90], [shifted, 90])
  }
  const latitudes = new Set([0])
  for (let lat = -90 + latitudeStep; lat < 90; lat += latitudeStep) latitudes.add(lat)
  for (const lat of latitudes) line([cam.lon - 180, lat], [cam.lon + 180, lat], lat === 0)
  return wires
}

/** 保留可见标记供组件裁切；非法坐标不生成针，原节点对象与顺序保持不变。 */
export function flatNodes(points: GlobeNode[], cam: FlatCamera): FlatNode[] {
  return points.flatMap((node) => {
    const p = cam.at(node.ll[0], node.ll[1])
    return p ? [{ ...node, px: p.x, py: p.y, visible: p.visible }] : []
  })
}

/**
 * 供圆形 hit 使用的最近中心裁切区（全局 SVG 坐标），不移动标记或改变地区语义。
 * 只裁切距离 < 2r 的邻点；方框圆外的角落不影响实际圆形命中。
 * 完全重复的中心按输入顺序等角分区，中心及分界线仍是不可唯一分配的共同边界。
 * 非法半径返回全空；非法坐标、溢出或浮点精度不足以表示方框的点只返回自身空区。
 */
export function mapHitAreas(points: readonly { px: number; py: number }[], radius: number): string[] {
  if (!Number.isFinite(radius) || radius <= 0) return points.map(() => "")
  type Vertex = [number, number]
  // 在单位半径坐标里裁切，避免大坐标的平方、点积和中点运算溢出。
  const clip = (polygon: Vertex[], nx: number, ny: number, limit: number): Vertex[] => {
    const next: Vertex[] = []
    if (!polygon.length) return next
    let previous = polygon[polygon.length - 1]
    let before = nx * previous[0] + ny * previous[1] - limit
    for (const current of polygon) {
      const after = nx * current[0] + ny * current[1] - limit
      if ((before <= 0) !== (after <= 0)) {
        const t = before / (before - after)
        next.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t])
      }
      if (after <= 0) next.push(current)
      previous = current
      before = after
    }
    return next
  }
  const valid = points.map((point) => {
    if (!point || !Number.isFinite(point.px) || !Number.isFinite(point.py)) return false
    const x0 = point.px - radius, x1 = point.px + radius, y0 = point.py - radius, y1 = point.py + radius
    return [x0, x1, y0, y1].every(Number.isFinite) && x0 < x1 && y0 < y1
  })
  const duplicates = new Map<string, number[]>()
  points.forEach((point, index) => {
    if (!valid[index]) return
    const key = `${point.px}:${point.py}`
    const indices = duplicates.get(key) ?? []
    indices.push(index)
    duplicates.set(key, indices)
  })
  return points.map((point, index) => {
    if (!valid[index]) return ""
    let polygon: Vertex[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    const identical = duplicates.get(`${point.px}:${point.py}`)!
    if (identical.length > 1) {
      const rank = identical.indexOf(index)
      const start = rank * Math.PI * 2 / identical.length
      const end = (rank + 1) * Math.PI * 2 / identical.length
      // 2 个及以上重复中心的每片角度 <= 180°，可用两条过中心半平面表达。
      polygon = clip(polygon, Math.sin(start), -Math.cos(start), 0)
      polygon = clip(polygon, -Math.sin(end), Math.cos(end), 0)
    }
    for (let otherIndex = 0; otherIndex < points.length && polygon.length; otherIndex++) {
      if (otherIndex === index || !valid[otherIndex]) continue
      const other = points[otherIndex]
      const dx = other.px - point.px, dy = other.py - point.py
      const distance = Math.hypot(dx, dy)
      if (!distance || !Number.isFinite(distance) || distance / radius >= 2) continue
      polygon = clip(polygon, dx / distance, dy / distance, distance / radius / 2)
    }
    return polygon.length >= 3
      ? polygon.map(([x, y]) => `${point.px + x * radius},${point.py + y * radius}`).join(" ")
      : ""
  })
}
