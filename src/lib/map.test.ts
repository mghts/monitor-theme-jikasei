import assert from "node:assert/strict"
import { flatCamera, flatNodes, MAP_BOUNDS, MAP_VIEW, mapGraticule, mapHitAreas, mapLabelCamera, mapPaths, mapViewport, prepareMapRings } from "./map.ts"
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
// 宽屏按高度铺开，手机按宽度铺开；取消底注留白后上下居中，仍是完整的 2:1 世界。
assert.deepEqual(mapViewport(830, 320), { w: 830, h: 320, bounds: { x: 119, y: 12, w: 592, h: 296 } })
assert.deepEqual(mapViewport(358, 250), { w: 358, h: 250, bounds: { x: 12, y: 41.5, w: 334, h: 167 } })
for (const [width, height] of [[286, 250], [326, 250], [734, 320], [830, 400], [1200, 320], [350, 600]]) {
  const { w, h, bounds: b } = mapViewport(width, height)
  close(b.w / b.h, 2, "地图宽高比")
  assert.ok(b.x >= 12 && b.y >= 12 && w - b.x - b.w >= 12 && h - b.y - b.h >= 12)
  close(b.y, h - b.y - b.h, "上下留白相等")
  assert.ok(Math.abs(b.x - 12) < 1e-8 || Math.abs(b.y - 12) < 1e-8, "至少一个方向铺到可用区域边缘")
  const full = flatCamera(0, 0, 100, b)
  close(full.at(-180, 90)!.x, b.x)
  close(full.at(-180, 90)!.y, b.y)
  close(full.at(180, -90)!.x, b.x + b.w)
  close(full.at(180, -90)!.y, b.y + b.h)
}
for (const invalid of [NaN, Infinity, -Infinity, 0, -1, 48]) {
  assert.deepEqual(mapViewport(invalid, invalid), mapViewport())
}
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
const node = (id: number, ll: [number, number]) => ({ id, nodeIds: [id], memberLabels: [{ id, name: `示例 ${id}`, code: "US", index: id }], key: `node-${id}`, name: `示例 ${id}`, code: "US", online: true, offlineCount: 0, index: id, count: 1, region: { key: "US", code: "US", city: "", label: "US", base: ll }, ll }) as GlobeNode
const points = [node(1, [0, 0]), node(2, [170, 0]), node(3, [NaN, 0])]
const placed = flatNodes(points, flatCamera(0, 0, 150))
assert.deepEqual(placed.map((p) => [p.id, p.visible]), [[1, true], [2, false]])
assert.deepEqual([placed[0].px, placed[0].py], [230, 115])
assert.equal(placed[0].region, points[0].region)
assert.deepEqual(placed.map((p) => p.nodeIds), [[1], [2]], "2D 投影保留未合并信标的精确成员")
const memberIds = [4, 8, 9, 12, 6]
const mixedNode = { ...node(4, [0, 0]), nodeIds: memberIds, memberLabels: memberIds.map((id, index) => ({ id, name: `示例 ${id}`, code: "US", index })), online: false, count: 5, offlineCount: 2 }
assert.deepEqual(flatNodes([mixedNode], camera).map((p) => [p.count, p.offlineCount, p.online]), [[5, 2, false]], "2D 投影保留聚合真实状态")
assert.deepEqual(flatNodes([mixedNode], camera).map((p) => p.nodeIds), [[4, 8, 9, 12, 6]], "2D 投影保留全部聚合成员及其顺序")
assert.deepEqual(flatNodes([mixedNode], camera).map((p) => p.memberLabels), [mixedNode.memberLabels], "2D 投影完整保留真实成员标签，名称和顺序不改")

// 不移动不同地区的真实落点：重叠的圆形 hit 按最近中心的中垂线分区。
// polygon 本身是 circle 的裁切边界；方框的圆外角落不属于实际命中区域。
const polygonOf = (value: string): Point[] => value ? value.split(" ").map((pair) => pair.split(",").map(Number) as Point) : []
const hitPoints = Object.freeze([Object.freeze({ px: 10, py: 10 }), Object.freeze({ px: 16, py: 10 })])
const hitBefore = JSON.stringify(hitPoints)
const twoAreas = mapHitAreas(hitPoints, 8).map(polygonOf)
assert.equal(twoAreas.length, 2)
assert.ok(twoAreas[0].every(([x]) => x <= 13), "左圆裁在独立推导的 x=13 中垂线左侧")
assert.ok(twoAreas[1].every(([x]) => x >= 13), "右圆裁在独立推导的 x=13 中垂线右侧")
assert.ok(twoAreas.every((polygon) => polygon.some(([x]) => x === 13)), "两圆都保留中垂线边界")
assert.equal(inside([twoAreas[0]], 12, 10), true)
assert.equal(inside([twoAreas[1]], 12, 10), false)
assert.equal(inside([twoAreas[0]], 14, 10), false)
assert.equal(inside([twoAreas[1]], 14, 10), true)
assert.equal(JSON.stringify(hitPoints), hitBefore, "冻结的命中坐标保持不变")

const triangle = [{ px: 10, py: 10 }, { px: 16, py: 10 }, { px: 12, py: 15 }]
const triangleBefore = structuredClone(triangle)
const triangleAreas = mapHitAreas(triangle, 8).map(polygonOf)
const hitCounts = [0, 0, 0]
let checkedHits = 0
for (let x = 2.137; x < 24; x += 0.41) for (let y = 2.283; y < 23; y += 0.47) {
  const distances = triangle.map((point) => Math.hypot(x - point.px, y - point.py))
  const minimum = Math.min(...distances)
  if (minimum >= 8 - 1e-9) continue
  const nearest = distances.map((distance, index) => ({ distance, index })).filter(({ distance }) => Math.abs(distance - minimum) < 1e-9)
  if (nearest.length !== 1) continue // 中垂线边界本身属于浏览器绘制顺序处理的 tie。
  const hits = triangleAreas.map((polygon, index) => ({ polygon, index }))
    .filter(({ polygon, index }) => distances[index] < 8 && inside([polygon], x, y)).map(({ index }) => index)
  assert.deepEqual(hits, [nearest[0].index], `重叠圆内网格点只命中最近中心 ${x},${y}`)
  hitCounts[hits[0]]++
  checkedHits++
}
assert.ok(checkedHits > 1000 && hitCounts.every((count) => count > 100), "三点网格覆盖每个圆的独立可点击区域")
assert.deepEqual(triangle, triangleBefore, "命中分割不改落点和输入顺序")

const separate = [{ px: 0, py: 0 }, { px: 30, py: 40 }]
const separateAreas = mapHitAreas(separate, 4).map(polygonOf)
assert.deepEqual(separateAreas, [[[-4, -4], [4, -4], [4, 4], [-4, 4]], [[26, 36], [34, 36], [34, 44], [26, 44]]], "圆不重叠时保留原矩形裁切，不改变原 hit")

// 完全重复的中心没有唯一最近点；以输入顺序等角分扇区，让每个未合并地区仍可选择。
for (const count of [2, 3]) {
  const duplicates = Array.from({ length: count }, () => ({ px: 10, py: 10 }))
  const duplicateAreas = mapHitAreas(duplicates, 8).map(polygonOf)
  close(duplicateAreas.reduce((sum, polygon) => sum + area(polygon), 0), 16 * 16, "重复中心扇区完整分配原裁切方框")
  duplicateAreas.forEach((polygon, index) => {
    assert.ok(polygon.length >= 3 && area(polygon) > 0, "每个重复中心保留非退化可点击扇区")
    const angle = (index + 0.5) * Math.PI * 2 / count
    const x = 10 + Math.cos(angle) * 4, y = 10 + Math.sin(angle) * 4
    assert.deepEqual(duplicateAreas.map((shape, i) => inside([shape], x, y) ? i : -1).filter((i) => i >= 0), [index], "各扇区内部只命中对应输入成员")
  })
  for (let x = 2.137; x < 18; x += 0.61) for (let y = 2.283; y < 18; y += 0.73) {
    if (Math.hypot(x - 10, y - 10) >= 8) continue
    const hits = duplicateAreas.filter((polygon) => inside([polygon], x, y))
    assert.equal(hits.length, 1, "重复中心各圆内非边界网格点恰好落入一个可点击扇区")
  }
  assert.deepEqual(mapHitAreas(duplicates, 8), mapHitAreas(duplicates, 8), "重复中心分割在相同输入下可重复")
}
for (const radius of [NaN, Infinity, -Infinity, 0, -1]) assert.deepEqual(mapHitAreas(hitPoints, radius), ["", ""], "非法半径安全返回空区域")
const unsafe = [{ px: NaN, py: 0 }, { px: 0, py: Infinity }, { px: Number.MAX_VALUE, py: 0 }, { px: 0, py: 0 }]
const safeAreas = mapHitAreas(unsafe, 8)
assert.deepEqual(safeAreas.slice(0, 3), ["", "", ""], "非法或浮点方框退化的节点安全忽略")
assert.deepEqual(polygonOf(safeAreas[3]), [[-8, -8], [8, -8], [8, 8], [-8, 8]], "无效邻居不影响有效节点")
assert.ok(mapHitAreas([{ px: Number.MAX_VALUE, py: 0 }, { px: 0, py: 0 }], Number.MAX_VALUE).every((value) => !/NaN|Infinity/.test(value)), "极端数值不输出非有限 SVG 坐标")
assert.deepEqual(mapHitAreas([], 8), [], "空输入不产生区域")

const original = structuredClone(WORLD_OUTLINES)
prepareMapRings(WORLD_OUTLINES)
mapPaths(flatCamera(100, 30, 150), world)
assert.deepEqual(WORLD_OUTLINES, original)
assert.deepEqual(crossing, [[170, 10], [-170, 10], [-170, -10], [170, -10]])
assert.equal(prepareMapRings([[], [[NaN, 0], [0, 1], [1, 0]]]).rings.length, 0)

console.log("平面地图：等距投影、日期线拆分、填充/岸线裁切、南极、缩放平移、节点与输入不变全部通过")
