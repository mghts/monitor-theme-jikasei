/// <reference types="node" />
import assert from "node:assert/strict"
import { ApiError, REQUEST_TIMEOUT_MS, requestJSON, startNodeTransport, type LiveSocket } from "./transport.ts"

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class Clock {
  now = 0
  next = 0
  tasks = new Map<number, { at: number; callback: () => void }>()
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.next
    this.tasks.set(id, { at: this.now + delay, callback })
    return () => { this.tasks.delete(id) }
  }
  async advance(delay: number) {
    const end = this.now + delay
    await flush()
    for (;;) {
      const first = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!first) break
      this.now = first[1].at
      this.tasks.delete(first[0])
      first[1].callback()
      await flush()
    }
    this.now = end
  }
}

class Socket implements LiveSocket {
  onmessage: LiveSocket["onmessage"] = null
  onerror: LiveSocket["onerror"] = null
  onclose: LiveSocket["onclose"] = null
  closed = false
  close() { this.closed = true }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>) }
}

function harness(socketFails = false, random = () => 0.5) {
  const clock = new Clock()
  const received: string[] = []
  const errors: unknown[] = []
  const sockets: Socket[] = []
  const requests: { signal: AbortSignal; resolve(value: string): void; reject(error: unknown): void }[] = []
  const connects: number[] = []
  const stop = startNodeTransport({
    fetchNodes: (signal) => new Promise<string>((resolve, reject) => { requests.push({ signal, resolve, reject }) }),
    openSocket: () => {
      connects.push(clock.now)
      if (socketFails) throw new Error("offline")
      const socket = new Socket()
      sockets.push(socket)
      return socket
    },
    parseMessage: (text) => {
      const data = JSON.parse(text)
      if (typeof data !== "string") throw new Error("bad frame")
      return data
    },
    receive: (value) => { received.push(value) },
    fail: (error) => { errors.push(error) },
    schedule: clock.schedule,
    random,
  })
  return { clock, received, errors, sockets, requests, connects, stop }
}

// REST may finish after a push, including after a reconnect. Neither may rewind the view.
{
  const h = harness()
  h.sockets[0].message("live-new")
  assert.equal(h.requests[0].signal.aborted, true)
  h.requests[0].resolve("initial-old")
  await flush()
  assert.deepEqual(h.received, ["live-new"])
  h.sockets[0].onclose?.({} as CloseEvent)
  h.requests[1].resolve("fallback")
  await h.clock.advance(5000)
  assert.equal(h.requests.length, 3)
  h.sockets[1].message("recovered-new")
  h.requests[2].resolve("poll-old")
  await flush()
  assert.deepEqual(h.received, ["live-new", "fallback", "recovered-new"])
  h.stop()
  assert.equal(h.clock.tasks.size, 0)
}

// A slow request does not overlap subsequent fallback polls or reconnection attempts.
{
  const h = harness(true)
  await h.clock.advance(60_000)
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve("slow-result")
  await h.clock.advance(4999)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(1)
  assert.equal(h.requests.length, 2)
  h.stop()
  assert.equal(h.requests[1].signal.aborted, true)
  h.requests[1].resolve("after-unmount")
  await flush()
  assert.deepEqual(h.received, ["slow-result"])
  assert.equal(h.clock.tasks.size, 0)
}

// Invalid JSON/shape and a connected socket that never reports both restore polling.
{
  const h = harness()
  h.requests[0].resolve("initial")
  await flush()
  assert.doesNotThrow(() => h.sockets[0].onmessage?.({ data: "{" } as MessageEvent<string>))
  assert.equal(h.sockets[0].closed, true)
  h.requests[1].resolve("fallback")
  await h.clock.advance(5000)
  h.sockets[1].message({ nodes: null })
  assert.equal(h.sockets[1].closed, true)
  assert.equal(h.errors.length, 2)
  h.stop()
  const idle = harness()
  idle.requests[0].resolve("initial")
  await idle.clock.advance(15_000)
  assert.equal(idle.sockets[0].closed, true)
  assert.ok(idle.errors.some((error) => error instanceof Error && error.message.includes("未更新")))
  idle.stop()
}

// Reconnect delays grow, stay capped, and stop completely on teardown.
{
  const h = harness(true)
  await h.clock.advance(255_000)
  const gaps = h.connects.slice(1).map((at, i) => at - h.connects[i])
  assert.deepEqual(gaps.slice(0, 4), [5000, 10_000, 20_000, 40_000])
  assert.ok(gaps.slice(4).every((gap) => gap === 60_000))
  h.stop()
  const count = h.connects.length
  await h.clock.advance(60_000)
  assert.equal(h.connects.length, count)
  const low = harness(true, () => 0)
  const high = harness(true, () => 1)
  await low.clock.advance(3999)
  await high.clock.advance(5999)
  assert.equal(low.connects.length, 1)
  assert.equal(high.connects.length, 1)
  await low.clock.advance(1)
  await high.clock.advance(1)
  assert.equal(low.connects[1], 4000)
  assert.equal(high.connects[1], 6000)
  low.stop()
  high.stop()
}

// HTTP deadlines also bound a stalled JSON body, while caller cancellation stays usable.
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const clock = new Clock()
const cancels = new Map<number, () => void>()
globalThis.setTimeout = ((callback: () => void, delay: number) => {
  const id = clock.next + 1
  cancels.set(id, clock.schedule(callback, delay))
  return id
}) as unknown as typeof setTimeout
globalThis.clearTimeout = ((id: number) => { cancels.get(id)?.(); cancels.delete(id) }) as unknown as typeof clearTimeout
try {
  let fetchedSignal: AbortSignal | undefined
  globalThis.fetch = async (_url, init) => {
    fetchedSignal = init?.signal ?? undefined
    return {
      ok: true, status: 200,
      json: () => new Promise((_, reject) => {
        fetchedSignal?.addEventListener("abort", () => reject(fetchedSignal?.reason), { once: true })
      }),
    } as Response
  }
  const timed = requestJSON("/api/nodes")
  const rejection = assert.rejects(timed, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError")
  await clock.advance(REQUEST_TIMEOUT_MS)
  await rejection
  assert.equal(fetchedSignal?.aborted, true)
  assert.equal(clock.tasks.size, 0)

  const controller = new AbortController()
  const canceled = requestJSON("/api/nodes", { signal: controller.signal })
  const canceledCheck = assert.rejects(canceled, (error: unknown) => error instanceof DOMException && error.name === "AbortError")
  await flush()
  controller.abort()
  await canceledCheck
  assert.equal(clock.tasks.size, 0)

  controller.abort()
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.signal?.aborted, true)
    throw init?.signal?.reason
  }
  await assert.rejects(requestJSON("/api/nodes", { signal: controller.signal }), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError")
  assert.equal(clock.tasks.size, 0)

  let headers: Headers | undefined
  globalThis.fetch = async (_url, init) => {
    headers = new Headers(init?.headers)
    return new Response(null, { status: 204 })
  }
  const empty = await requestJSON("/api/test", { body: "{}", headers: new Headers({ Authorization: "test" }) })
  assert.equal(empty, undefined)
  assert.equal(headers?.get("authorization"), "test")
  assert.equal(headers?.get("content-type"), "application/json")
  globalThis.fetch = async () => new Response(null, { status: 502 })
  await assert.rejects(requestJSON("/api/test"), (error: unknown) => error instanceof ApiError && error.message === "HTTP 502")
  assert.equal(clock.tasks.size, 0)
} finally {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
}
console.log("live transport ordering, fallback, backoff, cancellation and HTTP deadlines pass")
