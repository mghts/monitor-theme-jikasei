// 概览卡片的合计口径：全站加总、掉线的机器不贡献速率、最忙的那台按 CPU 占用选。
// 跑法同另外两个：`npm test`（Node 自己剥类型，不需要 runner）。
// 没有任何东西 import 它，所以不进 bundle。
import { expirationsOf, summarize, type Fleet } from "./summary.ts"
import type { Node } from "./api.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

const GB = 1024 ** 3
const TB = 1024 ** 4

function node(id: number, over: Partial<Node> = {}): Node {
  return {
    id, name: `节点${id}`, sort: id, public: true, online: false, country: "", group: "",
    last_seen: 0, metrics: null, os: "", kernel: "", arch: "", virt: "", cpu_name: "",
    cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: "",
    price: 0, currency: "", billing_cycle: "", expires_at: null, traffic_limit: 0,
    traffic_mode: "sum", traffic_reset_day: 1, total_rx: 0, total_tx: 0,
    month_rx: 0, month_tx: 0, month_start: "", day_rx: 0, day_tx: 0,
    ...over,
  }
}

const metrics = (over: Partial<NonNullable<Node["metrics"]>> = {}) => ({
  uptime: 100, cpu: 10, load: [0, 0, 0] as [number, number, number], mem_total: 1, mem_used: 0,
  swap_total: 0, swap_used: 0, disk_total: 1, disk_used: 0, net_rx: 0, net_tx: 0,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, tcp: 0, udp: 0, procs: 0, ...over,
})

const empty: Fleet = {
  total: 0, online: 0, dayRx: 0, dayTx: 0, totalRx: 0, totalTx: 0,
  netRx: 0, netTx: 0, busiest: null,
}

// 一台都没有：四张卡片都该是 0 / 「还没有节点」，不能落成 NaN。
eq(summarize([]), empty, "空列表")

// 三台：①在线带指标 ②在线但还没上报（metrics 空）③掉线带累计流量。
// 速率只算①；累计流量三台都算（hub 保留掉线机器的总量）。
const fleet = summarize([
  node(1, { online: true, day_rx: GB, day_tx: GB / 2, total_rx: 2 * TB, total_tx: 4 * TB, metrics: metrics({ cpu: 12.5, net_rx: 512 * 1024, net_tx: 128 * 1024 }) }),
  node(2, { online: true, metrics: null }),
  node(3, { online: false, total_rx: TB, total_tx: TB, metrics: metrics({ cpu: 99, net_rx: 5 * 1024, net_tx: 5 * 1024 }) }),
])
eq([fleet.total, fleet.online], [3, 2], "总数 / 在线数")
eq([fleet.dayRx, fleet.dayTx], [GB, GB / 2], "今日流量只加 day_rx/day_tx")
eq([fleet.totalRx, fleet.totalTx], [3 * TB, 5 * TB], "累计流量含掉线机器")
eq([fleet.netRx, fleet.netTx], [512 * 1024, 128 * 1024], "速率只算在线且有指标的节点")
eq(fleet.busiest, { name: "节点1", cpu: 12.5 }, "最忙节点：掉线的 99% 不参选")

// 并列时留先出现的那台（列表顺序是站长的偏好，不在主题里替他重排）。
const tied = summarize([
  node(1, { online: true, metrics: metrics({ cpu: 30 }) }),
  node(2, { online: true, metrics: metrics({ cpu: 30 }) }),
])
eq(tied.busiest, { name: "节点1", cpu: 30 }, "最忙节点并列时取先出现的")

// 在线但都没上报指标：没有最忙可说，卡片显示「—」而不是 0%。
const silent = summarize([node(1, { online: true, metrics: null })])
eq([silent.busiest, silent.netRx, silent.online], [null, 0, 1], "在线无指标时报不出最忙节点")

// 老 hub 少了 day_rx/day_tx：缺的按 0 算，不能让合计变成 NaN。
const legacy = { ...node(1, { total_rx: TB }), day_rx: undefined, day_tx: undefined } as unknown as Node
eq(summarize([legacy]).dayRx, 0, "缺 day_rx 的老 hub 按 0 算（不是 NaN）")

eq(expirationsOf([]), { next: null, withinWeek: 0, expired: 0 }, "空列表没有待到期节点")
const expirations = [
  node(1, { name: "已过期", expires_in: -2 }),
  node(2, { name: "七天后", expires_in: 7 }),
  node(3, { name: "八天后", expires_in: 8 }),
  node(4, { name: "免费且离线", price: 0, expires_in: 2 }),
  node(5, { name: "缺汇率", currency: "XYZ", price: 10, expires_in: 2 }),
  node(6, { name: "买断", billing_cycle: "once", expires_in: 0 }),
  node(7, { name: "无日期", expires_in: null }),
]
eq(expirationsOf(expirations), {
  next: { id: 4, name: "免费且离线", days: 2 }, withinWeek: 3, expired: 1,
}, "到期提醒含第7天、零价和缺汇率节点；过期单独计数，买断与无日期排除，并列保留列表顺序")
eq(expirationsOf([...expirations, node(8, { name: "今天到期", expires_in: 0 })]), {
  next: { id: 8, name: "今天到期", days: 0 }, withinWeek: 4, expired: 1,
}, "今天到期优先且计入7天内")
eq(expirationsOf([node(1, { expires_in: -1 }), node(2, { expires_in: -30 })]), {
  next: null, withinWeek: 0, expired: 2,
}, "仅有已过期节点时不伪造下一到期日")
eq(expirationsOf([
  node(1, { expires_in: NaN }), node(2, { expires_in: Infinity }),
  node(3, { expires_in: null, expires_at: "invalid" }),
]), { next: null, withinWeek: 0, expired: 0 }, "非法到期数据不参与提醒")
const future = new Date()
future.setDate(future.getDate() + 5)
const date = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`
eq(expirationsOf([node(9, { expires_at: date })]).next?.days, 5, "旧Hub缺expires_in时兼容日期字段")
eq(expirationsOf([node(9, { expires_at: date, expires_in: 3 })]).next?.days, 3, "Hub天数优先于访客计算日期")

if (failed) {
  console.error(`\n${failed} 处不符`)
  process.exit(1)
}
console.log("概览合计口径：全部通过")
