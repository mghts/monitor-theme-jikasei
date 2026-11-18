// 拍 README 的桌面、地图与手机预览图（面板缩略图是 preview.png，由 preview-cover.mjs 生成）：
//   ① preview-desktop.png  桌面列表页，含地图、计费概览与节点卡片
//   ② preview-globe.png   桌面 1440 下的「节点地球」整块（含右侧地区列表）
//   ③ preview-globe-dark.png  同一块的深色版（明暗双色那一句的对照）
//   ④ preview-mobile.png  手机 390×844@2x 的列表页首屏
//
// 用法：node tools/shot_preview_set.mjs [输出目录=仓库根]
//
// 为什么要这一份（而不是直接对着现网拍）：
//   1. 公开仓库里的预览图**不能带真实机器名/IP**——这里用 tools/globe-nodes-fixture.json 那套
//      中性演示数据（「测试节点 · 城市」口径），拍出来的图可以直接进 README。
//   2. 本机 WebSocket 推送固定的演示网速，让桌面和手机预览能显示上下行曲线。
//   3. 视口按内容量、裁剪按**量出来的几何**（先 getBoundingClientRect 再 clip），不猜坐标。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUTDIR = (process.argv[2] || '.').replace(/\/$/, '')
const PORT = 5212
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const NODES = JSON.parse(readFileSync('tools/globe-nodes-fixture.json', 'utf8'))
// 仅用于截图的演示价格与到期天数，不读取真实 Hub。统一使用 CNY，避免请求第三方汇率。
NODES.nodes = NODES.nodes.map((node, i) => ({ ...node,
  price: [24, 36, 18, 32, 28, 16, 42][i % 7], currency: 'CNY', billing_cycle: 'monthly',
  expires_in: [2, 6, 18, 30, 12, 22, 45][i % 7],
}))
const CONFIG = { listTop: 'bothBudget', cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '', globeOn: true, themeMode: 'system' }

const pingPayload = (id) => {
  const now = Math.floor(Date.now() / 1000)
  const ping = []
  for (const [task, base] of [[1, 62], [2, 92], [3, 121]]) {
    for (let i = 59; i >= 0; i--) {
      const jitter = ((i * 7 + task * 13 + id * 5) % 17) - 8
      ping.push({ ts: now - i * 60, task_id: task, latency: Math.max(8, base + jitter) })
    }
  }
  return { metrics: [], ping, step: 60, probes: { 1: '电信', 2: '联通', 3: '移动' }, loss: {} }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me'
      ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'Monitor M', history_days: 30 }
      : path === '/api/nodes' ? NODES
        : path.includes('/config') ? CONFIG
          : path.includes('/metrics') ? pingPayload(Number((path.match(/nodes\/(\d+)/) || [])[1] || 1))
            : { nodes: [] }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(body))
  }
  if (path.startsWith('/chicken/')) { res.writeHead(404); return res.end('no') }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file)) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
// 每次连接按相同顺序回放一段网速，让截图中的曲线可复现。
const down = [42, 46, 40, 60, 55, 48, 67, 63, 50, 53, 48, 54]
const up =   [23, 22, 30, 27, 32, 21, 29, 36, 32, 28, 24, 30]
server.on('upgrade', (req, socket) => {
  if (req.url !== '/api/ws') return socket.end()
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  let step = 0
  const timer = setInterval(() => {
    const nodes = NODES.nodes.map((node, i) => ({ ...node, metrics: { ...node.metrics,
      net_rx: down[step] * (i + 1) * 1024, net_tx: up[step] * (i + 1) * 1024,
    }}))
    const payload = Buffer.from(JSON.stringify({ nodes }))
    // 这组固定节点的 JSON 长度介于 126 与 65535 字节，使用 16 位长度的文本帧。
    const header = Buffer.from([0x81, 126, 0, 0])
    header.writeUInt16BE(payload.length, 2)
    socket.write(Buffer.concat([header, payload]))
    if (++step === down.length) clearInterval(timer)
  }, 150)
  socket.on('data', frame => { if ((frame[0] & 0x0f) === 8) socket.end() })
  socket.on('error', () => socket.destroy())
  socket.on('close', () => clearInterval(timer))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9987
let wsUrl = null
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1440,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/shotset-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { } ; if (!wsUrl) await sleep(300) }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const errs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text) }
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

const shoot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
  writeFileSync(join(OUTDIR, name), Buffer.from(r.result.data, 'base64'))
  const bytes = Buffer.from(r.result.data, 'base64').length
  console.log(`${name}  ${clip.width}×${clip.height} @${clip.scale}  ${(bytes / 1024).toFixed(0)}KB`)
}

const waitReady = async () => {
  for (let i = 0; i < 60; i++) { await sleep(400); if (await js('!!document.querySelector(".globe-panel")')) break }
  await sleep(3500)
  if (!await js('document.querySelectorAll("polyline[data-transfer]").length === 2')) throw new Error('缺少演示网速曲线')
}

// ① / ② 桌面：地球整块（亮 / 暗各一张，同一机位）
for (const [dark, name] of [[false, 'preview-globe.png'], [true, 'preview-globe-dark.png']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 2, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitReady()
  if (!dark) {
    // 截至第一排卡片的完整下沿，避免截出下一排的半张卡片。
    const firstRowBottom = await js(`Math.ceil(Math.max(...Array.from(document.querySelectorAll('[data-card-style="detailed"] > [data-slot="card"]')).slice(0, 3).map(el => el.getBoundingClientRect().bottom + scrollY)))`)
    if (!Number.isFinite(firstRowBottom) || firstRowBottom <= 0) throw new Error('未找到节点卡片，无法生成桌面预览')
    await shoot('preview-desktop.png', { x: 0, y: 0, width: 1440, height: firstRowBottom + 6, scale: 1 })
  }
  const geo = JSON.parse(await js(`(() => { const el = document.querySelector('.globe-panel'); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y + scrollY, w: r.width, h: r.height }) })()`))
  await shoot(name, { x: Math.round(geo.x), y: Math.round(geo.y), width: Math.round(geo.w), height: Math.round(geo.h), scale: 1 })
}

// ③ 手机 390×844@2x 的列表页首屏
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await waitReady()
await shoot('preview-mobile.png', { x: 0, y: 0, width: 390, height: 844, scale: 1 })

console.log('控制台异常:', errs.length ? errs.join(' | ') : '无')
ws.close(); chrome.kill(); server.close()
