import type { Node } from "./api.ts"

type Speed = { rx: number; tx: number }

// 同一批快照按节点保存，筛选改变后仍能回算同一批机器的历史，不混入同组其他节点。
const frames: Map<number, Speed>[] = []
const KEEP = 60

export function recordNodeSpeeds(nodes: Pick<Node, "id" | "online" | "metrics">[]): void {
  frames.push(new Map(nodes.map((node) => [node.id, {
    rx: node.online && node.metrics ? node.metrics.net_rx : 0,
    tx: node.online && node.metrics ? node.metrics.net_tx : 0,
  }])))
  if (frames.length > KEEP) frames.shift()
}

export function speedSeriesOf(nodes: Pick<Node, "id">[]): Speed[] {
  const ids = new Set(nodes.map((node) => node.id))
  return frames.map((frame) => {
    const total = { rx: 0, tx: 0 }
    for (const id of ids) {
      const speed = frame.get(id)
      if (!speed) continue
      total.rx += speed.rx
      total.tx += speed.tx
    }
    return total
  })
}
