import assert from "node:assert/strict"
import { flatCamera, flatNodes, MAP_BOUNDS, MAP_VIEW, mapGraticule, mapLabelCamera, mapPaths, prepareMapRings } from "./map.ts"
import type { GlobeNode } from "./globe.ts"
import { COARSE_WORLD_OUTLINES, WORLD_OUTLINES, type Ring } from "./world.ts"

type Point = [number, number]
const paths = (path: string): Point[][] => path.split("M").slice(1).map((part) => {
  const values = (part.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  return Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]] as Point)
})
const close = (got: number, want: number, label = "坐标") => assert.ok(Math.abs(got - want) < 1e-8, `${label}: ${got} vs ${want}`)
const inside = (polygons: Point[][], x: number, y: number) => polygons.some((ring) => {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit
  }
  return hit
})
const area = (ring: Point[]) => Math.abs(ring.reduce((sum, p, i) => {
  const next = ring[(i + 1) % ring.length]
  return sum + p[0] * next[1] - next[0] * p[1]
}, 0)) / 2

// 方向与坐标独立给出预期：东西分别是两边，北在上，默认世界完整可见。
const camera = flatCamera()
assert.equal(MAP_VIEW.viewBox, "0 0 460 240")
assert.deepEqual(camera.at(0, 0), { x: 230, y: 115, visible: true })
assert.deepEqual(camera.at(-180, 90), { x: 20, y: 10, visible: true })
assert.deepEqual(camera.at(180, -90), { x: 440, y: 220, visible: true })
close(camera.at(90, 45)!.x, 335)
close(camera.at(90, 45)!.y, 62.5)
assert.deepEqual(camera.at(540, 0), camera.at(180, 0))
assert.equal(camera.at(NaN, 0), null)
assert.equal(camera.at(0, 91), null)
assert.equal(camera.at(0, Infinity), null)
assert.deepEqual(flatCamera(NaN, Infinity, NaN).at(0, 0), camera.at(0, 0))
assert.equal(flatCamera(0, 500).lat, 90)
assert.equal(flatCamera(0, 0, 10).zoom, 50)
assert.equal(flatCamera(0, 0, 500).zoom, 150)
assert.deepEqual(flatCamera(0, 0, 100, { x: 0, y: 0, w: 0, h: 1 }).bounds, MAP_BOUNDS)
for (const zoom of [50, 100, 150]) {
  const cam = flatCamera(0, 0, zoom)
  assert.deepEqual(cam.at(0, 0), { x: 230, y: 115, visible: true })
  close(cam.at(60, 0)!.x - 230, 70 * zoom / 100)
}
assert.equal(flatCamera(0, 0, 150).at(150, 0)!.visible, false)
assert.equal(flatCamera(0, 0, 150).at(0, 80)!.visible, false)
assert.equal(flatCamera(0, 0, 50).at(180, 90)!.visible, true)
assert.deepEqual(flatCamera(170, 30).at(-190, 30), { x: 230, y: 115, visible: true })
close(flatCamera(170, 0).at(-170, 0)!.x, 230 + 420 / 18)

// 组件的中央边框给标签留空间；缩放只改变内部投影，viewport 与中心保持不变。
const bounds = { x: 100, y: 40, w: 260, h: 130 }
const small = flatCamera(0, 0, 100, bounds)
assert.deepEqual(small.at(0, 0), { x: 230, y: 105, visible: true })
assert.deepEqual(small.at(-180, 90), { x: 100, y: 40, visible: true })
assert.deepEqual(small.at(180, -90), { x: 360, y: 170, visible: true })
const labelCamera = mapLabelCamera(flatCamera(0, 0, 150, bounds), { w: 460, h: 240, cx: 230, cy: 112, r: 92 })
assert.deepEqual(labelCamera.at(0, 0), { x: 230, y: 105, k: 1 })
assert.equal(labelCamera.at(170, 0), null)

// 跨日期线矩形应成为边缘的两块小岛，不能把中间整片海填成陆地。
const crossing: Ring = [[170, 10], [-170, 10], [-170, -10], [170, -10]]
const prepared = prepareMapRings([crossing])
const island = mapPaths(camera, prepared)
const polygons = paths(island.fill)
assert.equal(polygons.length, 2)
assert.ok(Math.abs(polygons.reduce((sum, p) => sum + area(p), 0) - 20 * 20 * (420 / 360) * (210 / 180)) < 5, "日期线岛面积符合投影，允许0.1px坐标取整")
assert.equal(inside(polygons, 230, 115), false)
assert.equal(inside(polygons, 25, 115), true)
assert.equal(inside(polygons, 435, 115), true)
assert.doesNotMatch(island.stroke, /Z/)
for (const stroke of paths(island.stroke)) {
  for (let i = 1; i < stroke.length; i++) assert.ok(Math.abs(stroke[i][0] - stroke[i - 1][0]) < 15, "不横贯地图连日期线")
}
// 面板移到太平洋后，这个跨日期线的岛成为一块完整岛，面积与缩放严格对应。
for (const zoom of [50, 100, 150]) {
  const centered = paths(mapPaths(flatCamera(180, 0, zoom), prepared).fill)
  assert.equal(centered.length, 1)
  const expected = 400 * (420 / 360) * (210 / 180) * (zoom / 100) ** 2
  assert.ok(Math.abs(centered.reduce((sum, p) => sum + area(p), 0) - expected) < 5, "像素取整误差内的面积缩放")
  assert.equal(inside(centered, 230, 115), true)
}
assert.equal(mapPaths(flatCamera(0, 0, 150), prepared).fill, "", "放大后边缘岛在viewport外")

// 经纬线本身可横贯画布，岸线人工封口则不描边；放大时填充/岸线分开裁切。
const wide: Ring = [[-100, 40], [100, 40], [100, -40], [-100, -40]]
const widePrepared = prepareMapRings([wide])
const clipped = mapPaths(flatCamera(0, 0, 150), widePrepared)
// 这里原环经度边长超过180，会按日期线近路处理，中心仍为海洋。
assert.equal(inside(paths(clipped.fill), 230, 115), false)
const centerBox: Ring = [[-140, 40], [0, 40], [140, 40], [140, -40], [0, -40], [-140, -40]]
const boxPath = mapPaths(flatCamera(0, 0, 150), prepareMapRings([centerBox]))
assert.equal(inside(paths(boxPath.fill), 230, 115), true)
const boxStroke = paths(boxPath.stroke)
assert.ok(boxStroke.length >= 2, "左右越界切断为独立海岸线")
for (const run of boxStroke) for (let i = 1; i < run.length; i++) {
  assert.equal(run[i][1], run[i - 1][1], "裁切产生的左右竖边只填充，不伪装成海岸线")
}

// 实际岸线必须含南极底部；缩小只画一份世界，不在两侧重复填充大陆。
const world = prepareMapRings(WORLD_OUTLINES)
const actual = paths(mapPaths(camera, world).fill)
assert.ok(actual.length >= 79)
assert.equal(inside(actual, 230, 218), true, "南极显式极地封口覆盖地图底部")
assert.equal(inside(actual, camera.at(-30, 0)!.x, camera.at(-30, 0)!.y), false, "非洲西侧大西洋保持海洋")
assert.equal(inside(actual, camera.at(15, 0)!.x, camera.at(15, 0)!.y), true, "非洲赤道内陆保持陆地")
for (const run of paths(mapPaths(camera, world).stroke)) for (let i = 1; i < run.length; i++) {
  assert.ok(Math.abs(run[i][0] - run[i - 1][0]) < 210, "不把南极人工封口画成横贯地图的海岸线")
}
const reduced = paths(mapPaths(flatCamera(0, 0, 50), world).fill)
assert.ok(reduced.flat().every(([x, y]) => x >= 125 - 0.1 && x <= 335 + 0.1 && y >= 62.5 - 0.1 && y <= 167.5 + 0.1), "缩小世界居中且没有重复副本")

// 全部实际与粗略环、两套边框、多种中心/缩放都不生成越界或非有限坐标。
for (const rings of [WORLD_OUTLINES, COARSE_WORLD_OUTLINES]) {
  const prep = prepareMapRings(rings)
  for (const bounds of [MAP_BOUNDS, { x: 100, y: 40, w: 260, h: 130 }]) {
    for (const [lon, lat] of [[0, 0], [170, 30], [-175, -40], [80, 60]]) {
      for (const zoom of [50, 100, 150]) {
        const cam = flatCamera(lon, lat, zoom, bounds)
        const land = mapPaths(cam, prep)
        const grid = mapGraticule(cam)
        assert.ok(land.fill.length > 100 && land.stroke.length > 100)
        assert.ok(grid.length >= 5)
        for (const path of [land.fill, land.stroke, ...grid.map((wire) => wire.d)]) {
          assert.doesNotMatch(path, /NaN|Infinity/)
          for (const [x, y] of paths(path).flat()) {
            assert.ok(x >= bounds.x - 0.1 && x <= bounds.x + bounds.w + 0.1 && y >= bounds.y - 0.1 && y <= bounds.y + bounds.h + 0.1)
          }
        }
      }
    }
  }
}
assert.equal(mapGraticule(camera).filter((wire) => wire.equator).length, 1)
assert.equal(mapGraticule(camera, NaN, Number.MIN_VALUE).length, mapGraticule(camera).length)

// 独立的地理点落入原环判据与最终SVG填充一致；避开0.1px取整会影响的海岸边缘。
function nearCoast(lon: number, lat: number) {
  for (const ring of WORLD_OUTLINES) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const length = dx * dx + dy * dy
    const t = length ? Math.max(0, Math.min(1, ((lon - a[0]) * dx + (lat - a[1]) * dy) / length)) : 0
    if (Math.hypot(lon - a[0] - dx * t, lat - a[1] - dy * t) < 0.2) return true
  }
  return false
}
let compared = 0
const geographic = Array.from({ length: 60 }, (_, x) => Array.from({ length: 30 }, (_, y) => [-177 + x * 6, -87 + y * 6] as Point)).flat()
  .filter(([lon, lat]) => !nearCoast(lon, lat))
for (const center of [0, 170]) for (const zoom of [50, 100, 150]) {
  const cam = flatCamera(center, 0, zoom)
  const polygons = paths(mapPaths(cam, world).fill)
  for (const [lon, lat] of geographic) {
    const p = cam.at(lon, lat)!
    if (!p.visible) continue
    assert.equal(inside(polygons, p.x, p.y), inside(WORLD_OUTLINES, lon, lat), `真实岸线填充不丢陆地/不填海洋 @${center}/${zoom}% ${lon},${lat}`)
    compared++
  }
}
assert.ok(compared > 7000, "覆盖数千个真实地理点，不只验证路径非空")

// 节点及输入保持不变；visible区分裁切外点与非法点，保留id/地区/顺序供命中和标签使用。
const node = (id: number, ll: [number, number]) => ({ id, key: `node-${id}`, name: `示例 ${id}`, code: "US", online: true, index: id, count: 1, region: { key: "US", code: "US", city: "", label: "US", base: ll }, ll }) as GlobeNode
const points = [node(1, [0, 0]), node(2, [170, 0]), node(3, [NaN, 0])]
const placed = flatNodes(points, flatCamera(0, 0, 150))
assert.deepEqual(placed.map((p) => [p.id, p.visible]), [[1, true], [2, false]])
assert.deepEqual([placed[0].px, placed[0].py], [230, 115])
assert.equal(placed[0].region, points[0].region)
const original = structuredClone(WORLD_OUTLINES)
prepareMapRings(WORLD_OUTLINES)
mapPaths(flatCamera(100, 30, 150), world)
assert.deepEqual(WORLD_OUTLINES, original)
assert.deepEqual(crossing, [[170, 10], [-170, 10], [-170, -10], [170, -10]])
assert.equal(prepareMapRings([[], [[NaN, 0], [0, 1], [1, 0]]]).rings.length, 0)

console.log("平面地图：等距投影、日期线拆分、填充/岸线裁切、南极、缩放平移、节点与输入不变全部通过")
