// 详情脚本失败恢复与不可见地图筛选验收；仅使用本地夹具，不连接真实 Hub。
// 运行：DETAIL_DIST=/absolute/fresh/dist node tools/verify_detail_loading.mjs
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const DIST = resolve(process.env.DETAIL_DIST || 'dist')
const OUTPUT = mkdtempSync(join(tmpdir(), 'monitor-detail-loading-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = [], errors = [], chunkRequests = [], logs = []
const log = (line) => { logs.push(line); console.log(line) }
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const GB = 1024 ** 3
const node = (id, country) => ({
  id, name: `Node ${country}`, sort: id, public: true, online: true, country, group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm',
  cpu_name: 'Xeon', cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  price: 100, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1, total_rx: 0, total_tx: 0,
  month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
  metrics: { uptime: 400000, cpu: 5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: GB,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
    net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, tcp: 10, udp: 2, procs: 100 },
})
const nodes = [node(1, 'JP'), node(2, 'US')]
const samples = [1, 2, 3].map((i) => ({ ts: Math.floor(Date.now() / 1000) - (4 - i) * 60,
  cpu: 5 + i, mem_used: GB, disk_used: 10 * GB, net_rx: 100 + i, net_tx: 20,
  swap_used: 0, tcp: 10, udp: 2, procs: 100 }))
const history = { metrics: samples, ping: samples.map(({ ts }, i) => ({ task_id: 1, ts, latency: 20 + i })), probes: { 1: '探测' }, loss: {} }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
let fixture = 'normal', failures = 0
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = (data) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site_name: '加载验收', history_days: 7 })
  if (path === '/api/nodes') return json({ nodes })
  if (path.endsWith('/config')) {
    const current = fixture
    if (current === 'delayed-config') await sleep(2500)
    return json({ listTop: 'none', cardStyle: current === 'compact' ? 'compact' : 'classic', globeOn: current === 'map-toggle', remarkPlacement: 'both' })
  }
  if (path.includes('/metrics')) return json(history)
  if (path.startsWith('/chicken/')) return json({})
  if (/\/NodeDetail-[^/]+\.js$/.test(path)) {
    const failed = failures > 0
    chunkRequests.push({ fixture, path, failed, at: Date.now() })
    if (failed) { failures--; res.writeHead(503, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); return res.end('') }
  }
  const file = join(DIST, path === '/' ? '/index.html' : path)
  const actual = existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(actual)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(actual))
})
server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!CHROME) { server.close(); throw new Error('Chrome unavailable') }
const profile = join(OUTPUT, 'chrome-profile')
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking', '--disable-component-update',
  '--disable-sync', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let wsUrl
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等待独立 Chrome。 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) { chrome.kill(); server.close(); throw new Error('Chrome unavailable') }
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolveCall, reject) => {
  const next = ++id
  const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
  pending.set(next, (message) => {
    clearTimeout(timer)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolveCall(message.result)
  })
  ws.send(JSON.stringify({ id: next, method, params }))
})
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
  else if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params
    void send(request.url.startsWith(BASE + '/') ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      request.url.startsWith(BASE + '/') ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch((error) => errors.push(String(error)))
  }
}
const js = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
  return response.result?.value
}
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i++) { if (await js(expression)) return true; await sleep(100) }
  return false
}
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const shot = async (name) => {
  const response = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUTPUT, name + '.png'), Buffer.from(response.data, 'base64'))
}
const cards = () => js(`document.querySelectorAll('[data-slot="card"][role="button"]').length`)
const unhandled = async () => js('window.__unhandled || []')
log(`验收证据目录：${OUTPUT}`)
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__unhandled=[];addEventListener('unhandledrejection',e=>window.__unhandled.push(String(e.reason)))` })

  fixture = 'normal'; failures = 1
  await send('Page.navigate', { url: BASE + '/?case=prewarm-failure' })
  await waitFor(`document.querySelectorAll('[data-slot="card"][role="button"]').length===2`)
  for (let i = 0; i < 50 && !chunkRequests.some((request) => request.failed); i++) await sleep(100)
  await sleep(200)
  check('首页预热确实遇到一次脚本 503', chunkRequests.some((request) => request.failed))
  check('预热失败仍保留列表且无未处理 rejection', await cards() === 2 && (await unhandled()).length === 0)
  await click('[data-slot="card"][role="button"]')
  check('整页详情显示加载失败入口，顶栏仍可用', await waitFor(`!!document.querySelector('[data-detail-load-error]')`) && await js(`!!document.querySelector('header') && location.pathname==='/node/1'`))
  await shot('01-detail-failure')
  await click('[data-detail-back]')
  check('失败页面可返回列表', await waitFor(`location.pathname==='/' && document.querySelectorAll('[data-slot="card"][role="button"]').length===2`))
  await click('[data-slot="card"][role="button"]')
  await waitFor(`!!document.querySelector('[data-detail-reload]')`)
  await click('[data-detail-reload]')
  check('刷新绕过失败模块缓存并恢复整页详情', await waitFor(`!!document.querySelector('main h2') && !!document.querySelector('[data-chart]') && !document.querySelector('[data-detail-load-error]')`))
  check('刷新后重新请求脚本且无未处理 rejection', chunkRequests.filter((request) => request.fixture === 'normal').length >= 2 && (await unhandled()).length === 0)
  await shot('02-detail-recovered')

  fixture = 'compact'; failures = 1
  await send('Page.navigate', { url: BASE + '/?case=compact-failure' })
  await waitFor(`!!document.querySelector('[data-card-style="compact"] tbody tr[role="button"]')`)
  await click('[data-card-style="compact"] tbody tr[role="button"]')
  check('紧凑展开使用相同加载失败入口', await waitFor(`!!document.querySelector('[data-detail-load-error]')`) && await js(`document.querySelector('[data-detail-back]').textContent==='收起展开'`))
  await shot('03-compact-failure')
  await click('[data-detail-back]')
  check('失败的紧凑展开可以收起', await js(`!document.querySelector('[data-detail-load-error]') && document.querySelector('tbody tr[role="button"]').getAttribute('aria-expanded')==='false'`))
  await click('[data-card-style="compact"] tbody tr[role="button"]')
  await waitFor(`!!document.querySelector('[data-detail-reload]')`)
  await click('[data-detail-reload]')
  await waitFor(`!!document.querySelector('[data-card-style="compact"] tbody tr[role="button"]')`)
  await click('[data-card-style="compact"] tbody tr[role="button"]')
  check('刷新后紧凑延迟图可正常展开', await waitFor(`!!document.querySelector('[data-chart]') && !document.querySelector('[data-detail-load-error]')`))
  check('紧凑恢复无未处理 rejection', (await unhandled()).length === 0)
  await shot('04-compact-recovered')

  fixture = 'delayed-config'
  await send('Page.navigate', { url: BASE + '/?case=delayed-config' })
  await waitFor(`!!document.querySelector('[data-region-code="JP"]')`)
  await click('[data-region-code="JP"]')
  check('配置返回前选择 JP 生效', await cards() === 1)
  check('站点配置关闭地图后立即恢复全部节点', await waitFor(`!document.querySelector('[data-map-mode]') && !document.querySelector('.globe-toggle') && document.querySelectorAll('[data-slot="card"][role="button"]').length===2`))
  await shot('05-hidden-map-unfiltered')

  fixture = 'map-toggle'
  await send('Page.navigate', { url: BASE + '/?case=map-toggle' })
  await waitFor(`!!document.querySelector('[data-note-popover]') && !!document.querySelector('[data-region-code="JP"]')`)
  await click('[data-region-code="JP"]')
  await click('.globe-toggle')
  check('访客关闭地图时仍清除地区筛选', await cards() === 2)
  await click('.globe-toggle')
  check('重新打开地图不会复活旧地区筛选', await waitFor(`!!document.querySelector('[data-map-mode]')`) && await cards() === 2 && await js(`document.querySelector('.globe-reg-all').getAttribute('aria-pressed')==='true'`))
  check('全部用例没有未捕获运行异常', errors.length === 0, errors.join('\n'))
} catch (error) {
  check('验收执行完整', false, String(error))
} finally {
  writeFileSync(join(OUTPUT, 'report.json'), JSON.stringify({ results, errors, chunkRequests }, null, 2))
  writeFileSync(join(OUTPUT, 'log.txt'), logs.join('\n') + '\n')
  ws.close(); chrome.kill(); server.closeAllConnections(); server.close()
}
process.exitCode = results.some((result) => !result.ok) ? 1 : 0
