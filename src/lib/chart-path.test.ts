import assert from "node:assert/strict"
import { linePath, type PlotPoint } from "./chart-path.ts"

type Segment = { command: string; values: number[] }
const segments = (path: string): Segment[] => [...path.matchAll(/([MLC])([^MLC]*)/g)].map((match) => ({
  command: match[1],
  values: (match[2].match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number),
}))
const endpoint = ({ values }: Segment) => ({ x: values[values.length - 2], y: values[values.length - 1] })
const commands = (path: string) => segments(path).map((segment) => segment.command).join("")

// 丢包出现在头尾与中间：默认逐段画，跨缺口只连接有效样本，完整保留原点。
const loss = [null, { x: 0, y: 20 }, { x: 10, y: 40 }, { x: 15, y: 25 }, null, null, { x: 70, y: 35 }, { x: 95, y: 15 }, { x: 100, y: 30 }, null]
assert.equal(linePath(loss), "M0.0,20.0L10.0,40.0L15.0,25.0M70.0,35.0L95.0,15.0L100.0,30.0")
assert.equal(linePath(loss, { connectGaps: true }), "M0.0,20.0L10.0,40.0L15.0,25.0L70.0,35.0L95.0,15.0L100.0,30.0")
assert.equal(commands(linePath(loss, { smooth: true })), "MCCMCC")
assert.equal(commands(linePath(loss, { connectGaps: true, smooth: true })), "MCCCCC")
for (const connectGaps of [false, true]) {
  for (const smooth of [false, true]) {
    const path = linePath(loss, { connectGaps, smooth })
    assert.deepEqual(segments(path).map(endpoint), loss.filter((point) => point !== null), "四种组合均保留有效样本端点")
    assert.equal(linePath([null, null, null], { connectGaps, smooth }), "")
    assert.equal(linePath([], { connectGaps, smooth }), "")
    assert.equal(linePath([null, { x: 12, y: 0 }, null], { connectGaps, smooth }), "M12.0,0.0")
    assert.equal(linePath([{ x: 1, y: 2 }, { x: 20, y: 30 }], { connectGaps, smooth }), "M1.0,2.0L20.0,30.0")
  }
}
assert.equal(linePath([{ x: 0, y: 2 }, null, { x: 100, y: 3 }], { smooth: true }), "M0.0,2.0M100.0,3.0")
assert.equal(linePath([{ x: 0, y: 2 }, null, { x: 100, y: 3 }], { connectGaps: true, smooth: true }), "M0.0,2.0L100.0,3.0")

// 独立采样 SVG Bezier，验证非等距尖峰、平台与反向段；不重复实现切线算法。
function checkShape(points: PlotPoint[]) {
  const drawn = segments(linePath(points, { smooth: true }))
  assert.deepEqual(drawn.map(endpoint), points)
  let previous = endpoint(drawn[0])
  for (const segment of drawn.slice(1)) {
    const next = endpoint(segment)
    let lastX = previous.x
    let lastY = previous.y
    for (let j = 0; j <= 100; j++) {
      const t = j / 100
      const q = 1 - t
      const x = segment.command === "L" ? previous.x * q + next.x * t
        : previous.x * q ** 3 + 3 * segment.values[0] * q ** 2 * t + 3 * segment.values[2] * q * t ** 2 + next.x * t ** 3
      const y = segment.command === "L" ? previous.y * q + next.y * t
        : previous.y * q ** 3 + 3 * segment.values[1] * q ** 2 * t + 3 * segment.values[3] * q * t ** 2 + next.y * t ** 3
      assert.ok(Number.isFinite(x) && Number.isFinite(y))
      assert.ok(x >= lastX - 1e-9, "沿实际时间向前，不折返")
      assert.ok(y >= Math.min(previous.y, next.y) - 1e-9 && y <= Math.max(previous.y, next.y) + 1e-9, "不超相邻样本范围")
      assert.ok(y >= -1e-9, "非负样本不能制造负延迟")
      assert.ok(next.y >= previous.y ? y >= lastY - 1e-9 : y <= lastY + 1e-9, "每个区间保形单调")
      lastX = x
      lastY = y
    }
    previous = next
  }
}
checkShape([{ x: 0, y: 0 }, { x: 1, y: 1000 }, { x: 120, y: 0 }, { x: 121, y: 5 }, { x: 2000, y: 5 }, { x: 2001, y: 0 }])
checkShape([{ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 100, y: 4 }, { x: 101, y: 50 }, { x: 500, y: 51 }])
checkShape([{ x: 0, y: 100 }, { x: 1, y: 5 }, { x: 90, y: 4 }, { x: 300, y: 0 }])

// 保留 x/y 时，相邻时间间隔改变必须影响内部控制点；不能按样本序号平滑。
const regular = segments(linePath([{ x: 0, y: 0 }, { x: 1, y: 10 }, { x: 2, y: 20 }], { smooth: true }))
const irregular = segments(linePath([{ x: 0, y: 0 }, { x: 1, y: 10 }, { x: 100, y: 20 }], { smooth: true }))
assert.notEqual(regular[1].values[3], irregular[1].values[3])

// 重复/逆序时间只让异常那一步退回线段，既不丢点，也不产生无效控制点。
for (const points of [
  [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 8 }, { x: 2, y: 3 }, { x: 3, y: 4 }],
  [{ x: 0, y: 1 }, { x: 2, y: 8 }, { x: 1, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }],
]) {
  const path = linePath(points, { smooth: true })
  const drawn = segments(path)
  assert.deepEqual(drawn.map(endpoint), points)
  assert.equal(drawn[2].command, "L")
  assert.equal(drawn[3].command, "C", "异常时间之后仍可平滑独立递增片段")
  assert.doesNotMatch(path, /NaN|Infinity/)
}

// 极端有限坐标可能让相减/相除溢出；仅那一步回退，非法坐标则断开。
for (const points of [
  [{ x: -1e308, y: 10 }, { x: 1e308, y: 20 }, { x: 1.1e308, y: 30 }],
  [{ x: 0, y: -1e308 }, { x: 1, y: 1e308 }, { x: 2, y: 0 }],
  [{ x: 0, y: 0 }, { x: Number.MIN_VALUE, y: 1 }, { x: 1, y: 2 }],
]) assert.doesNotMatch(linePath(points, { smooth: true }), /NaN|Infinity/)
assert.equal(linePath([{ x: 0, y: 1 }, { x: NaN, y: 2 }, { x: 2, y: Infinity }, { x: 3, y: 4 }], { smooth: true, connectGaps: true }), "M0.0,1.0M3.0,4.0")

// 输入对象可被冻结；路径生成不排序、不插补、不回写原样本。
const frozen = Object.freeze(loss.map((point) => point === null ? null : Object.freeze({ ...point })))
const original = structuredClone(frozen)
for (const connectGaps of [false, true]) for (const smooth of [false, true]) linePath(frozen as Array<PlotPoint | null>, { connectGaps, smooth })
assert.deepEqual(frozen, original)

console.log("图表路径：断点/连缺口、独立平滑、非等距单调、异常时间与输入不变全部通过")
