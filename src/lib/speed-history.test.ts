import assert from "node:assert/strict"
import type { Node } from "./api.ts"
import { recordNodeSpeeds, speedSeriesOf } from "./speed-history.ts"

const node = (id: number, rx: number, online = true) => ({
  id, online, metrics: { net_rx: rx, net_tx: rx * 2 },
}) as Node

assert.deepEqual(speedSeriesOf([]), [])
recordNodeSpeeds([node(1, 10), node(2, 90), node(3, 1000, false)])
recordNodeSpeeds([node(1, 20), node(2, 80), node(4, 5)])
assert.deepEqual(speedSeriesOf([{ id: 1 }]), [{ rx: 10, tx: 20 }, { rx: 20, tx: 40 }], "搜索或地区筛选后只计当前节点")
assert.deepEqual(speedSeriesOf([{ id: 1 }, { id: 2 }]), [{ rx: 100, tx: 200 }, { rx: 100, tx: 200 }], "取消筛选后恢复完整历史")
assert.deepEqual(speedSeriesOf([{ id: 3 }]), [{ rx: 0, tx: 0 }, { rx: 0, tx: 0 }], "离线与缺席节点不贡献速率")
assert.deepEqual(speedSeriesOf([{ id: 4 }]), [{ rx: 0, tx: 0 }, { rx: 5, tx: 10 }], "新增节点不套用其他节点的历史")
assert.deepEqual(speedSeriesOf([{ id: 1 }, { id: 1 }]), speedSeriesOf([{ id: 1 }]), "节点不能重复计数")
assert.deepEqual(speedSeriesOf([]), [{ rx: 0, tx: 0 }, { rx: 0, tx: 0 }], "空筛选的数字与曲线同为零")
for (let i = 0; i < 65; i++) recordNodeSpeeds([node(1, i)])
assert.equal(speedSeriesOf([{ id: 1 }]).length, 60, "历史有界")
assert.deepEqual(speedSeriesOf([{ id: 1 }])[0], { rx: 5, tx: 10 })
assert.deepEqual(speedSeriesOf([{ id: 1 }]).at(-1), { rx: 64, tx: 128 })
console.log("筛选后的速度历史：全部通过")
