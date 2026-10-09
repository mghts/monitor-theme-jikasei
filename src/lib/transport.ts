/** HTTP and live-stream lifecycle, kept independent of React for ordering tests. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const REQUEST_TIMEOUT_MS = 15_000

/** The deadline includes response-body reads, and preserves the caller's cancellation. */
export async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json")
  const controller = new AbortController()
  const signal = init?.signal
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener("abort", cancel, { once: true })
  const deadline = setTimeout(() => {
    controller.abort(new DOMException("请求超时，请重试", "TimeoutError"))
  }, REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal })
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText || `HTTP ${res.status}`)
    return res.status === 204 ? (undefined as T) : await res.json()
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error
    throw error
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener("abort", cancel)
  }
}

export type LiveSocket = {
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  close(): void
}

type TransportOptions<T> = {
  fetchNodes(signal: AbortSignal): Promise<T>
  openSocket(): LiveSocket
  parseMessage(data: string): T
  receive(data: T): void
  fail(error: unknown): void
  /** Injectable clock/randomness lets tests reproduce stalled connections and recovery. */
  schedule?: (callback: () => void, delay: number) => () => void
  random?: () => number
}

const POLL_MS = 5000
const MAX_RETRY_MS = 60_000
const STREAM_IDLE_MS = 15_000

/** One REST request at a time; only the current stream/request may publish data. */
export function startNodeTransport<T>(options: TransportOptions<T>): () => void {
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  })
  const random = options.random ?? Math.random
  let disposed = false
  let streaming = false
  let socket: LiveSocket | null = null
  let pending: AbortController | null = null
  let poll: (() => void) | null = null
  let retry: (() => void) | null = null
  let watchdog: (() => void) | null = null
  let failures = 0
  let revision = 0

  const fetchOnce = async () => {
    if (disposed || streaming || pending) return
    const controller = new AbortController()
    const startedAt = revision
    pending = controller
    try {
      const data = await options.fetchNodes(controller.signal)
      if (!disposed && !controller.signal.aborted && startedAt === revision) options.receive(data)
    } catch (error) {
      if (!disposed && !controller.signal.aborted && startedAt === revision) options.fail(error)
    } finally {
      if (pending === controller) pending = null
      if (!disposed && !streaming && !poll) poll = schedule(() => { poll = null; void fetchOnce() }, POLL_MS)
    }
  }

  const reconnect = () => {
    if (disposed || retry) return
    // Spread a hub restart across visitors instead of reconnecting them together.
    const base = Math.min(MAX_RETRY_MS, POLL_MS * 2 ** Math.min(failures++, 4))
    const delay = Math.min(MAX_RETRY_MS, Math.round(base * (0.8 + random() * 0.4)))
    retry = schedule(() => { retry = null; connect() }, delay)
  }

  const loseSocket = (current: LiveSocket, error?: unknown) => {
    if (disposed || socket !== current) return
    current.onmessage = current.onerror = current.onclose = null
    socket = null
    streaming = false
    watchdog?.()
    watchdog = null
    current.close()
    if (error !== undefined) options.fail(error)
    // A close can mean public access was revoked: query immediately, including 401.
    poll?.()
    poll = null
    void fetchOnce()
    reconnect()
  }

  const watch = (current: LiveSocket) => {
    watchdog?.()
    watchdog = schedule(() => loseSocket(current, new Error("实时连接长时间未更新，正在重连")), STREAM_IDLE_MS)
  }

  const connect = () => {
    if (disposed) return
    let current: LiveSocket
    try {
      current = options.openSocket()
    } catch (error) {
      options.fail(error)
      void fetchOnce()
      reconnect()
      return
    }
    socket = current
    watch(current)
    current.onmessage = (event) => {
      if (disposed || socket !== current) return
      let data: T
      try {
        data = options.parseMessage(event.data)
      } catch {
        loseSocket(current, new Error("实时数据格式错误，正在重新获取"))
        return
      }
      revision++
      streaming = true
      failures = 0
      poll?.()
      poll = null
      retry?.()
      retry = null
      pending?.abort()
      watch(current)
      options.receive(data)
    }
    current.onerror = () => loseSocket(current)
    current.onclose = () => loseSocket(current)
  }

  void fetchOnce()
  connect()
  return () => {
    disposed = true
    revision++
    poll?.()
    retry?.()
    watchdog?.()
    pending?.abort()
    if (socket) {
      socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
  }
}
