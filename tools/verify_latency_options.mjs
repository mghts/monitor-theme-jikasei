// 本机 dist + 含丢包/缺测的桩数据；原生 Chrome/CDP，无额外依赖。
// 跑法：node tools/verify_latency_options.mjs [输出目录]
// 默认新建唯一临时目录。截图、报告与 Chrome profile 全部保留，不删除任何文件。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'monitor-latency-options-'))
mkdirSync(OUT, { recursive: true })
const DIST = resolve('dist')
if (!existsSync(join(DIST, 'index.html'))) throw new Error('缺少 dist/index.html；请先构建项目')
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
if (!CHROME) throw new Error('未找到 Chrome；可设置 CHROME_PATH')
if (typeof WebSocket === 'undefined') throw new Error('本工具需要提供原生 WebSocket 的 Node.js 版本')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const GB = 1024 ** 3
const START = Math.floor(Date.now() / 1000) - 2100
// 两条线路共用真实时间轴，间隔不等；第二条另外缺两个采样桶。
const OFFSETS = [0, 60, 150, 210, 360, 420, 480, 630, 690, 780, 840, 900, 1080, 1140, 1230, 1290, 1410, 1470, 1560, 1620, 1770, 1830]
const LATENCIES = [40, 52, 43, 58, 44, 49, null, null, 45, 53, 41, 720, 43, 55, 46, null, 48, 56, 42, 51, 44, 50]
const PING = {
  // Monitor v1.4.0 src/api.rs:437-439：未请求的另一系列也以空数组返回。
  metrics: [],
  ping: OFFSETS.flatMap((offset, i) => [
    { task_id: 1, ts: START + offset, latency: LATENCIES[i], loss: LATENCIES[i] === null ? 100 : i === 10 ? 25 : 0, band: LATENCIES[i] === null ? null : [LATENCIES[i] - 3, LATENCIES[i] + 4] },
    ...(i === 4 || i === 14 ? [] : [{ task_id: 2, ts: START + offset, latency: i === 16 ? null : 88 + (i % 4) * 5, loss: i === 16 ? 100 : i === 6 ? 25 : 0 }]),
  ]),
  probes: { 1: '电信夹具', 2: '联通夹具' },
  // 整个窗口的统计由后端给出，不是各桶 loss 的平均值。
  loss: { 1: 12.5, 2: 3.75 },
  step: 60,
}
const METRICS = { ping: [], probes: {}, loss: {}, step: 60, metrics: OFFSETS.map((offset, i) => ({
  ts: START + offset, cpu: i === 6 || i === 7 ? null : 4 + (i % 6) * 2,
  mem_used: i === 6 || i === 7 ? null : 400_000_000 + i * 4_000_000,
  disk_used: i === 6 || i === 7 ? null : 1_000_000_000 + i * 2_000_000,
  net_rx: i === 6 || i === 7 ? null : 300 + i * 50,
  net_tx: i === 6 || i === 7 ? null : 200 + i * 20,
})) }
const NODE = {
  id: 1, name: '延迟选项验收', sort: 1, public: true, online: true, country: 'JP', country_pin: '', group: '',
  last_seen: Math.floor(Date.now() / 1000), os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.4.0', price: 12, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: '2027-01-01', expires_in: 90, traffic_limit: 100 * GB, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 20 * GB, total_tx: 10 * GB, month_rx: 3 * GB, month_tx: GB, month_start: '2026-10-01', day_rx: GB, day_tx: GB / 2, public_remark: '',
  metrics: { uptime: 400000, cpu: 12, load: [0.1, 0.2, 0.3], mem_used: GB, mem_total: 2 * GB, swap_used: 0, swap_total: 0, disk_used: 10 * GB, disk_total: 40 * GB, net_rx: 1024, net_tx: 512, procs: 50, tcp: 10, udp: 2, total_rx: 20 * GB, total_tx: 10 * GB, month_rx: 3 * GB, month_tx: GB },
}
let config = { cardStyle: 'detailed', listTop: 'none' }
let configDelay = 0
const requests = []
const configResponses = []
const results = []
const exceptions = []
const delayedEvidence = []
let base = ''
let chrome
let ws
let chromeError
const pending = new Map()
let commandId = 0
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const server = createServer((req, res) => {
  const url = new URL(req.url, base)
  if (url.pathname.startsWith('/api/')) {
    let body = {}
    if (url.pathname === '/api/me') body = { authed: false, github: false, public_page: true, site: base, site_name: '延迟选项验收', history_days: 30 }
    else if (url.pathname === '/api/nodes') body = { nodes: [NODE] }
    else if (url.pathname.endsWith('/config')) {
      const saved = { ...config }
      const response = { latencyStyle: saved.latencyStyle ?? '(missing)', requestedAt: Date.now(), delay: configDelay }
      configResponses.push(response)
      setTimeout(() => {
        response.sentAt = Date.now()
        if (!res.destroyed) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(saved))
        }
      }, configDelay)
      return
    }
    else if (url.pathname === '/api/version') body = { version: '1.4.0' }
    else if (url.pathname === '/api/nodes/1/metrics') {
      requests.push(url.pathname + url.search)
      body = url.searchParams.get('series') === 'ping' ? PING : METRICS
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const path = resolve(DIST, '.' + url.pathname)
  const file = (path === DIST || path.startsWith(DIST + sep)) && existsSync(path) && statSync(path).isFile() ? path : join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})

function send(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    const id = ++commandId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 10000)
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolveCall(message.result)
      },
      reject, timer,
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(fn, ...args) {
  const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
}
async function waitFor(fn, ...args) {
  for (let i = 0; i < 60; i++) {
    if (await evaluate(fn, ...args)) return
    await sleep(150)
  }
  throw new Error(`等待页面状态超时：${fn.toString().slice(0, 120)}`)
}
async function clickText(text) {
  if (!(await evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === text)
    button?.click()
    return !!button
  }, text))) throw new Error(`未找到按钮：${text}`)
  await sleep(120)
}
function chartState() {
  const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
  const chart = svg?.closest('[data-chart]')
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right } }
  return {
    exists: !!svg, connect: chart?.getAttribute('data-connect-gaps'), smooth: chart?.getAttribute('data-smooth-lines'),
    paths: [...(svg?.querySelectorAll('path[data-series]') || [])].map((p) => ({ key: p.dataset.series, d: p.getAttribute('d') || '' })),
    bands: [...(svg?.querySelectorAll('path[stroke="none"]') || [])].map((p) => p.getAttribute('d')),
    legend: [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('夹具')).map((b) => b.textContent.trim()),
    controls: [...document.querySelectorAll('[data-latency-option]')].map((el) => ({ key: el.dataset.latencyOption, checked: el.checked, label: el.closest('label')?.textContent.trim(), ...rect(el.closest('label')) })),
    svg: svg ? rect(svg) : null,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    reset: !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重置'),
  }
}
const state = () => evaluate(chartState)
const ready = () => waitFor(() => document.querySelector('svg[aria-label="节点延迟走势"] path[data-series]')?.getAttribute('d')?.length > 0)
async function options(connect, smooth) {
  for (const [key, desired] of [['connect-gaps', connect], ['smooth-lines', smooth]]) {
    const found = await evaluate((key, desired) => {
      const input = document.querySelector(`[data-latency-option="${key}"]`)
      if (input && input.checked !== desired) input.click()
      return !!input
    }, key, desired)
    if (!found) throw new Error(`缺少选项：${key}`)
  }
  await waitFor((connect, smooth) => {
    const el = document.querySelector('svg[aria-label="节点延迟走势"]')?.closest('[data-chart]')
    return el?.dataset.connectGaps === String(connect) && el?.dataset.smoothLines === String(smooth)
  }, connect, smooth)
  return state()
}
async function hoverAt(index) {
  const ratio = (OFFSETS[index] - OFFSETS[0]) / (OFFSETS.at(-1) - OFFSETS[0])
  await evaluate((ratio) => {
    const rect = document.querySelector('svg[aria-label="节点延迟走势"] rect[fill="transparent"]')
    const r = rect.getBoundingClientRect()
    rect.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.x + r.width * ratio, clientY: r.y + r.height / 2 }))
  }, ratio)
  await waitFor(() => !!document.querySelector('svg[aria-label="节点延迟走势"]')?.closest('[data-chart]')?.querySelector('ul'))
  return evaluate(() => document.querySelector('svg[aria-label="节点延迟走势"]')?.closest('[data-chart]')?.querySelector('ul')?.textContent || '')
}
async function screenshot(name) {
  await evaluate(() => document.querySelector('svg[aria-label="节点延迟走势"]')?.scrollIntoView({ block: 'center' }))
  await sleep(120)
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(result.data, 'base64'))
}
function resourceState() {
  return [...document.querySelectorAll('svg[role="img"]')].filter((svg) => svg.getAttribute('aria-label') !== '节点延迟走势').map((svg) => {
    const box = svg.closest('[data-chart]')
    return { label: svg.getAttribute('aria-label'), connect: box?.dataset.connectGaps, smooth: box?.dataset.smoothLines,
      paths: [...svg.querySelectorAll('path[data-series]')].map((path) => ({ key: path.dataset.series, d: path.getAttribute('d') || '' })) }
  })
}
async function openDetail(width) {
  configDelay = 0
  config = { cardStyle: 'detailed', listTop: 'none' }
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 640 })
  await send('Page.navigate', { url: `${base}/node/1?case=${width}-${Date.now()}` })
  await waitFor(() => document.querySelectorAll('svg[role="img"][aria-label]').length === 4 && !!document.querySelector('path[data-series="cpu"]')?.getAttribute('d'))
  await sleep(200)
}

const STYLES = { broken: [false, false], connected: [true, false], smooth: [false, true], connectedSmooth: [true, true] }
function sparkState() {
  return [...document.querySelectorAll('svg[data-latency-sparkline]')].map((svg) => ({
    id: svg.dataset.latencySparkline, connect: svg.dataset.connectGaps, smooth: svg.dataset.smoothLines,
    paths: [...svg.querySelectorAll('path[data-series]')].map((p) => ({ key: p.dataset.series, d: p.getAttribute('d') || '' })),
    text: svg.parentElement.textContent.trim(),
  }))
}
function pathsMatch(paths, connect, smooth, breaks) {
  return paths.length === 2 && paths.every((p) => p.d.length > 0 && (p.d.match(/M/g) || []).length === (connect ? 1 : breaks[p.key]) && (smooth ? p.d.includes('C') : p.d.includes('L') && !p.d.includes('C')))
}
function sparksMatch(sparks, connect, smooth) {
  return sparks.length === 2 && sparks.every((s) => s.connect === String(connect) && s.smooth === String(smooth) && s.paths.length === 1) && pathsMatch(sparks.flatMap((s) => s.paths), connect, smooth, { t1: 3, t2: 2 })
}
function detailMatches(detail, connect, smooth) {
  return detail.connect === String(connect) && detail.smooth === String(smooth) && detail.controls.length === 2 && detail.controls.every((control) => control.checked === (control.key === 'connect-gaps' ? connect : smooth)) && pathsMatch(detail.paths, connect, smooth, { t1: 3, t2: 4 })
}
async function navigateConfig(saved, path = '/', { width = 1280, delay = 0 } = {}) {
  config = { cardStyle: 'detailed', listTop: 'none', ...saved }
  configDelay = delay
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 640 })
  await send('Page.navigate', { url: `${base}${path}?config=${Date.now()}-${configResponses.length}` })
}
async function readySparks(connect, smooth) {
  await waitFor((connect, smooth) => {
    const svgs = [...document.querySelectorAll('svg[data-latency-sparkline]')]
    return svgs.length === 2 && svgs.every((svg) => svg.dataset.connectGaps === String(connect) && svg.dataset.smoothLines === String(smooth) && svg.querySelector('path[data-series]')?.getAttribute('d'))
  }, connect, smooth)
  return evaluate(sparkState)
}
async function readyDetailStyle(connect, smooth) {
  await ready()
  await waitFor((connect, smooth) => {
    const chart = document.querySelector('svg[aria-label="节点延迟走势"]')?.closest('[data-chart]')
    return chart?.dataset.connectGaps === String(connect) && chart?.dataset.smoothLines === String(smooth)
  }, connect, smooth)
  return state()
}
async function openConfiguredDetail(saved) {
  await navigateConfig(saved, '/node/1')
  await waitFor(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '网络延迟'))
  await clickText('网络延迟')
}

try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  base = `http://127.0.0.1:${server.address().port}`
  const profile = join(OUT, 'chrome-profile')
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-proxy-server', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  chrome.on('error', (error) => { chromeError = error })
  const portFile = join(profile, 'DevToolsActivePort')
  let wsUrl
  for (let i = 0; i < 100 && !wsUrl; i++) {
    if (chromeError) throw chromeError
    try {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      wsUrl = pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl
    } catch { /* Chrome 正在创建调试端口。 */ }
    if (!wsUrl) await sleep(200)
  }
  if (!wsUrl) throw new Error('Chrome 未提供 CDP；临时 profile 已保留')
  ws = new WebSocket(wsUrl)
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000)
    ws.onopen = () => { clearTimeout(timer); resolveOpen() }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')) }
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { const call = pending.get(message.id); pending.delete(message.id); call.resolve(message) }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
  }
  await send('Runtime.enable')
  await send('Page.enable')

  console.log(`本地夹具 ${base}；输出 ${OUT}`)
  await openDetail(1280)
  const resourcesBefore = await evaluate(resourceState)
  check('资源夹具绘出四张图且保留空档', resourcesBefore.length === 4 && resourcesBefore.every((r) => r.paths.length && r.paths.every((p) => (p.d.match(/M/g) || []).length >= 2 && !p.d.includes('C'))))
  await clickText('网络延迟')
  await ready()
  const baseline = await state()
  check('两个选项默认关闭，原始延迟折线保留丢包/缺测断点', baseline.connect === 'false' && baseline.smooth === 'false' && baseline.controls.length === 2 && baseline.controls.every((c) => !c.checked) && baseline.paths.length === 2 && baseline.paths.every((p) => (p.d.match(/M/g) || []).length >= 2 && p.d.includes('L') && !p.d.includes('C')), JSON.stringify(baseline.paths.map((p) => ({ key: p.key, moves: (p.d.match(/M/g) || []).length }))))
  const xs = [...baseline.paths[0].d.matchAll(/[ML]([\d.-]+),[\d.-]+/g)].map((m) => Number(m[1]))
  check('非等距采样按时间比例绘制', xs.length > 5 && new Set(xs.slice(1, 6).map((x, i) => Math.round((x - xs[i]) * 10))).size > 1)
  const lossTip = await hoverAt(6)
  const partialLossTip = await hoverAt(10)
  check('原始 tooltip 保留无响应、100% 丢包及部分丢包', lossTip.includes('电信夹具无响应丢 100%') && lossTip.includes('联通夹具') && lossTip.includes('丢 25%') && partialLossTip.includes('电信夹具41 ms丢 25%'), JSON.stringify({ lossTip, partialLossTip }))
  check('窗口丢包统计取后端总值', baseline.legend.includes('电信夹具丢 13%') && baseline.legend.includes('联通夹具丢 4%'), JSON.stringify(baseline.legend))
  for (const [connect, smooth] of [[true, false], [false, true], [true, true], [false, false]]) {
    const current = await options(connect, smooth)
    check(`四组合：连接=${connect}，平滑=${smooth}`, current.paths.length === 2 && current.paths.every((p, i) => (p.d.match(/M/g) || []).length === (connect ? 1 : (baseline.paths[i].d.match(/M/g) || []).length) && (smooth ? p.d.includes('C') : p.d.includes('L') && !p.d.includes('C'))), JSON.stringify(current.paths.map((p) => ({ key: p.key, moves: (p.d.match(/M/g) || []).length, cubic: p.d.includes('C') }))))
    const tip = await hoverAt(6)
    const partial = await hoverAt(10)
    check(`显示选项不改变 tooltip/丢包统计：${connect}/${smooth}`, tip === lossTip && partial === partialLossTip && JSON.stringify(current.legend) === JSON.stringify(baseline.legend))
  }
  await options(true, true)
  for (const [label, hours] of [['1 小时', 1], ['24 小时', 24], ['7 天', 168]]) {
    const before = requests.length
    await clickText(label)
    await waitFor(() => ![...document.querySelectorAll('[role="status"]')].some((el) => el.textContent.includes('刷新中')))
    await ready()
    const current = await state()
    check(`切换 ${label} 保留两个选项且请求对应窗口`, requests.slice(before).some((request) => new URL(request, base).searchParams.get('hours') === String(hours) && new URL(request, base).searchParams.get('series') === 'ping') && current.connect === 'true' && current.smooth === 'true' && current.paths.every((p) => p.d.includes('C')), requests.slice(before).join(' ; '))
  }
  await evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('联通夹具'))?.click())
  await waitFor(() => document.querySelectorAll('svg[aria-label="节点延迟走势"] path[data-series]').length === 1)
  const single = await state()
  check('隐藏探测后单条曲线仍应用选项；band 保留分段且不跨丢包', single.paths[0]?.key === 't1' && single.paths[0].d.includes('C') && (single.paths[0].d.match(/M/g) || []).length === 1 && single.bands.length === 3 && single.bands.every((d) => !d.includes('C')), `bands=${single.bands.length}`)
  await evaluate(() => [...document.querySelectorAll('label')].find((label) => label.textContent.trim() === '削峰')?.querySelector('input')?.click())
  await waitFor(() => !!document.querySelector('svg[aria-label="节点延迟走势"] path[data-series="s1"]'))
  const despiked = await state()
  check('削峰仍独立切换，并保留连接/平滑显示', despiked.paths[0]?.key === 's1' && despiked.paths[0].d.includes('C') && despiked.paths[0].d !== single.paths[0].d && despiked.connect === 'true' && despiked.smooth === 'true')
  check('削峰后无响应和丢包仍保留', (await hoverAt(6)).includes('电信夹具无响应丢 100%'))
  // Pointer 事件分帧派发，避免 React 尚未提交 drag 状态时就松手。
  for (const [type, ratio] of [['pointerdown', 0.15], ['pointermove', 0.70], ['pointerup', 0.70]]) {
    await evaluate((type, ratio) => {
      const el = document.querySelector('svg[aria-label="节点延迟走势"] rect[fill="transparent"]')
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.x + r.width * ratio, clientY: r.y + r.height / 2 }))
    }, type, ratio)
    await sleep(120)
  }
  const zoomed = await state()
  check('拖选缩放仍工作，两个显示选项仍开启', zoomed.reset && zoomed.paths[0]?.d !== despiked.paths[0].d && zoomed.connect === 'true' && zoomed.smooth === 'true')
  await clickText('重置')
  const reset = await state()
  check('重置恢复完整时间范围', !reset.reset && reset.paths[0]?.d === despiked.paths[0].d)
  await screenshot('detail-1280-options-on')
  await clickText('资源')
  await waitFor(() => document.querySelectorAll('svg[role="img"][aria-label]').length === 4 && !!document.querySelector('path[data-series="cpu"]')?.getAttribute('d'))
  const resourcesAfter = await evaluate(resourceState)
  check('延迟选项不影响资源图的断点和折线', JSON.stringify(resourcesAfter) === JSON.stringify(resourcesBefore) && resourcesAfter.every((r) => r.connect === 'false' && r.smooth === 'false'))

  for (const width of [1280, 360]) {
    await openDetail(width)
    await clickText('网络延迟')
    await ready()
    await options(true, true)
    const detail = await state()
    check(`${width}px 详情选项完整可见且无横向溢出`, !detail.overflow && detail.controls.length === 2 && detail.controls.every((c) => c.w > 0 && c.x >= -1 && c.right <= width + 1) && detail.svg?.w > 100, JSON.stringify({ overflow: detail.overflow, controls: detail.controls, svg: detail.svg }))
    await screenshot(`detail-${width}-layout`)
    config = { cardStyle: 'compact', listTop: 'none' }
    await send('Page.navigate', { url: `${base}/?compact=${width}-${Date.now()}` })
    await waitFor(() => !!document.querySelector('tbody tr[role="button"]'))
    await evaluate(() => document.querySelector('tbody tr[role="button"]').click())
    await ready()
    const initial = await state()
    check(`${width}px 紧凑展开有两个默认关闭选项`, initial.controls.length === 2 && initial.controls.every((c) => !c.checked) && initial.connect === 'false' && initial.smooth === 'false')
    const compact = await options(true, true)
    check(`${width}px 紧凑展开可独立开启且布局完整`, !compact.overflow && compact.controls.every((c) => c.w > 0 && c.x >= -1 && c.right <= width + 1) && compact.paths.every((p) => p.d.includes('C') && (p.d.match(/M/g) || []).length === 1), JSON.stringify({ overflow: compact.overflow, controls: compact.controls }))
    check(`${width}px 紧凑展开保留完整详情入口`, await evaluate(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '完整详情 ›')))
    if (width === 360) {
      const buttons = await evaluate(() => [...document.querySelector('[data-latency-option]')?.closest('label')?.parentElement?.querySelectorAll('button') || []].map((button) => {
        const r = button.getBoundingClientRect()
        const css = getComputedStyle(button)
        const range = document.createRange()
        range.selectNodeContents(button)
        const text = range.getBoundingClientRect()
        return { text: button.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
          lineHeight: css.lineHeight, whiteSpace: css.whiteSpace,
          textRect: { x: text.x, y: text.y, w: text.width, h: text.height, right: text.right, bottom: text.bottom },
          visible: r.width > 0 && r.height > 0 && css.visibility !== 'hidden' && css.display !== 'none' && r.bottom > 0 && r.top < innerHeight }
      }).filter((button) => button.visible))
      const detailButton = buttons.find((button) => button.text === '完整详情 ›')
      const text = detailButton?.textRect
      const lineHeight = Number.parseFloat(detailButton?.lineHeight || '')
      check('360px 紧凑完整详情入口单行且文字不被裁切', !!detailButton && detailButton.h <= 24 && detailButton.h <= lineHeight + 1 && detailButton.whiteSpace === 'nowrap' && text.w > 0 && text.h <= lineHeight + 1 && text.x >= detailButton.x - 1 && text.right <= detailButton.right + 1 && text.y >= detailButton.y - 1 && text.bottom <= detailButton.bottom + 1 && text.x >= -1 && text.right <= 361, JSON.stringify(detailButton))
      check('360px 延迟工具栏当前可见按钮全部位于视口内', buttons.length > 0 && buttons.every((button) => button.x >= -1 && button.right <= 361 && button.y >= -1 && button.bottom <= 1101), JSON.stringify(buttons))
    }
    await screenshot(`compact-${width}-options-on`)
    await clickText('完整详情 ›')
    await waitFor(() => location.pathname === '/node/1' && !!document.querySelector('dl'))
    check(`${width}px 完整详情入口能打开节点详情`, await evaluate(() => location.pathname === '/node/1' && !!document.querySelector('dl')))
  }

  // 站点默认值统一卡面、经典浮层、详情和紧凑展开；每轮用完整导航隔离会话临时选择。
  let sparkBaselineText
  for (const [style, [connect, smooth]] of Object.entries(STYLES)) {
    for (const cardStyle of ['detailed', 'latency']) {
      await navigateConfig({ cardStyle, latencyStyle: style })
      const sparks = await readySparks(connect, smooth)
      const text = sparks.map((spark) => spark.text)
      if (!sparkBaselineText) sparkBaselineText = text
      check(`站点默认 ${style}：${cardStyle} 卡面曲线与采样/丢包读数一致`, sparksMatch(sparks, connect, smooth) && JSON.stringify(text) === JSON.stringify(sparkBaselineText), JSON.stringify(sparks.map((spark) => ({ id: spark.id, connect: spark.connect, smooth: spark.smooth, text: spark.text, paths: spark.paths.map((p) => ({ key: p.key, moves: (p.d.match(/M/g) || []).length, cubic: p.d.includes('C') })) }))))
      if (style === 'connectedSmooth' && cardStyle === 'detailed') await screenshot('site-connectedSmooth-detailed-1280')
    }
    await openConfiguredDetail({ latencyStyle: style })
    const detail = await readyDetailStyle(connect, smooth)
    check(`站点默认 ${style}：详情 checkbox 与主曲线同步且丢包仍保留`, detailMatches(detail, connect, smooth) && (await hoverAt(6)) === lossTip && JSON.stringify(detail.legend) === JSON.stringify(baseline.legend), JSON.stringify({ connect: detail.connect, smooth: detail.smooth, paths: detail.paths.map((p) => ({ key: p.key, moves: (p.d.match(/M/g) || []).length, cubic: p.d.includes('C') })) }))
    await navigateConfig({ cardStyle: 'compact', latencyStyle: style })
    await waitFor(() => !!document.querySelector('tbody tr[role="button"]'))
    await evaluate(() => document.querySelector('tbody tr[role="button"]').click())
    check(`站点默认 ${style}：紧凑展开同步`, detailMatches(await readyDetailStyle(connect, smooth), connect, smooth))
    await navigateConfig({ cardStyle: 'classic', latencyStyle: style })
    await waitFor(() => !!document.querySelector('[data-note-popover]'))
    await evaluate(() => document.querySelector('[data-note-popover]').click())
    const peekSparks = await readySparks(connect, smooth)
    check(`站点默认 ${style}：classic 浮层曲线与读数同步`, sparksMatch(peekSparks, connect, smooth) && JSON.stringify(peekSparks.map((spark) => spark.text)) === JSON.stringify(sparkBaselineText))
    if (style === 'connectedSmooth') await screenshot('site-connectedSmooth-classic-1280')
  }

  // 在新文档最早的绘制中记录曲线属性，证明迟到的配置会更新已挂载组件。
  // 详情页初始是资源页签，观察器一看到延迟页签便点开，使 broken 首帧发生在配置返回前。
  const observeDefaults = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${(() => {
    window.__latencyObservations = []
    let selectedLatency = false
    const remember = (state) => {
      if (!window.__latencyObservations.some((old) => old.kind === state.kind && old.source === state.source && old.connect === state.connect && old.smooth === state.smooth)) window.__latencyObservations.push({ ...state, at: performance.now() })
    }
    const record = () => {
      if (!selectedLatency && location.pathname === '/node/1') {
        const tab = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '网络延迟')
        if (tab) { selectedLatency = true; tab.click() }
      }
      // checkbox 出现即证明 NodeDetail 已挂载；历史请求与 ResizeObserver 完成后才有路径。
      const connect = document.querySelector('[data-latency-option="connect-gaps"]')
      const smooth = document.querySelector('[data-latency-option="smooth-lines"]')
      if (connect && smooth) remember({ kind: 'detail', connect: String(connect.checked), smooth: String(smooth.checked), source: 'controls' })
      for (const svg of document.querySelectorAll('svg[data-latency-sparkline], svg[aria-label="节点延迟走势"]')) {
        if (!svg.querySelector('path[data-series]')?.getAttribute('d')) continue
        const element = svg.hasAttribute('data-latency-sparkline') ? svg : svg.closest('[data-chart]')
        remember({ kind: svg.hasAttribute('data-latency-sparkline') ? 'spark' : 'detail', connect: element.dataset.connectGaps, smooth: element.dataset.smoothLines, source: 'svg' })
      }
    }
    new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-connect-gaps', 'data-smooth-lines', 'd'] })
  }).toString()})()` })
  const lateConfigDelay = 1000
  for (const [kind, path] of [['spark', '/'], ['detail', '/node/1']]) {
    await navigateConfig({ latencyStyle: 'connectedSmooth' }, path, { delay: lateConfigDelay })
    if (kind === 'detail') {
      await waitFor(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '网络延迟'))
      await evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '网络延迟').click())
    }
    const final = kind === 'spark' ? sparksMatch(await readySparks(true, true), true, true) : detailMatches(await readyDetailStyle(true, true), true, true)
    const observations = await evaluate(() => window.__latencyObservations)
    const response = configResponses.at(-1)
    delayedEvidence.push({ kind, response, observations })
    check(`配置延迟 ${lateConfigDelay}ms：${kind} 从 broken 首帧跟随站点默认`, final && observations.some((state) => state.kind === kind && state.source === 'svg' && state.connect === 'false' && state.smooth === 'false') && observations.some((state) => state.kind === kind && state.source === 'svg' && state.connect === 'true' && state.smooth === 'true') && response.delay === lateConfigDelay && response.sentAt - response.requestedAt >= lateConfigDelay - 15, JSON.stringify({ response, observations }))
  }
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: observeDefaults.identifier })

  await openConfiguredDetail({ latencyStyle: 'connected', cardStyle: 'detailed' })
  await readyDetailStyle(true, false)
  const sessionBefore = await evaluate(() => ({ timeOrigin: performance.timeOrigin, storage: JSON.stringify(Object.fromEntries(Object.entries(localStorage))) }))
  await options(false, true)
  await clickText('延迟选项验收')
  await waitFor(() => location.pathname === '/')
  const temporarySparks = await readySparks(false, true)
  const sessionAfter = await evaluate(() => ({ timeOrigin: performance.timeOrigin, storage: JSON.stringify(Object.fromEntries(Object.entries(localStorage))) }))
  check('详情临时切换后 SPA 返回首页同步，且未写入本地存储', sparksMatch(temporarySparks, false, true) && sessionBefore.timeOrigin === sessionAfter.timeOrigin && sessionBefore.storage === sessionAfter.storage, JSON.stringify({ before: sessionBefore, after: sessionAfter }))
  await send('Page.reload', { ignoreCache: true })
  const refreshedSparks = await readySparks(true, false)
  check('刷新后丢弃临时选项，恢复站点 connected 默认', sparksMatch(refreshedSparks, true, false) && (await evaluate(() => performance.timeOrigin)) !== sessionBefore.timeOrigin)
  await evaluate(() => document.querySelector('[data-slot="card"][role="button"]').click())
  await waitFor(() => location.pathname === '/node/1' && [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '网络延迟'))
  await clickText('网络延迟')
  await readyDetailStyle(true, false)
  await options(false, true)
  await clickText('恢复默认')
  const restoredDetail = detailMatches(await readyDetailStyle(true, false), true, false)
  const restoredButtonGone = await evaluate(() => ![...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '恢复默认'))
  await clickText('延迟选项验收')
  await waitFor(() => location.pathname === '/')
  check('恢复默认按钮还原站点样式，SPA 返回首页继续保持', restoredDetail && restoredButtonGone && sparksMatch(await readySparks(true, false), true, false))

  for (const [label, saved] of [['旧配置未设置样式', {}], ['无效样式值', { latencyStyle: 'invalid-value' }]]) {
    await navigateConfig(saved)
    const homeBroken = sparksMatch(await readySparks(false, false), false, false)
    await openConfiguredDetail(saved)
    const detailBroken = detailMatches(await readyDetailStyle(false, false), false, false)
    check(`${label}：首页和详情安全回退 broken`, homeBroken && detailBroken)
  }
  check('验收期间无未捕获页面异常', exceptions.length === 0, exceptions.join(' ; '))
} catch (error) {
  check('验收脚本完成', false, error.stack || String(error))
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ output: OUT, base, fixture: { offsets: OFFSETS, rawLatencies: LATENCIES, overallLoss: PING.loss, apiFields: ['metrics', 'ping', 'probes', 'loss', 'step'] }, results, requests, configResponses, delayedEvidence, exceptions }, null, 2))
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP 已关闭')) }
  pending.clear()
  ws?.close()
  chrome?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
}
console.log(`\n结果：${results.filter((r) => r.ok).length} 通过，${results.filter((r) => !r.ok).length} 失败；报告 ${join(OUT, 'report.json')}`)
if (results.some((r) => !r.ok)) process.exitCode = 1
