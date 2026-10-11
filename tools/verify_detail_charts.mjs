// 详情资源图的原生 Chrome 验收。Monitor 1.4.1 的新增字段是可选历史数据，缺测不能伪造为零。
// 运行：CHART_DIST=/absolute/fresh/dist SHOT_DIR=/absolute/new/evidence node tools/verify_detail_charts.mjs
// 可选保留旧真站模式：node tools/verify_detail_charts.mjs <local-url> <http-upstream-hub>
// 本机夹具不访问真实 Hub；金额、断点与坐标预期不导入任何生产归一化/图表 helper。
import { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { join, extname, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REAL = process.argv[2] || ''
const UPSTREAM = (process.argv[3] || '').replace(/\/$/, '')
const PORT = Number(process.env.CHART_PORT || 0)
let BASE = REAL || `http://127.0.0.1:${PORT}`
const DIST = resolve(process.env.CHART_DIST || 'dist')
const SHOTS = process.env.SHOT_DIR || mkdtempSync(join(tmpdir(), 'monitor-detail-charts-'))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(SHOTS, { recursive: true })
let passed = 0, failed = 0
const results = [], evidence = [], historyRequests = [], errors = [], external = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}
const EXTRA = ['swap_used', 'tcp', 'udp', 'procs']
const START = 1790300000
const node = {
  id: 1, name: '东京一号', group: '东京', country: 'JP', os: 'Debian GNU/Linux 12 (bookworm)',
  sort: 1, online: true, public: true, country_pin: '', last_seen: 1790311292,
  kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'AMD EPYC 7763', cpu_cores: 2, mem_total: 2147483648,
  swap_total: 2147483648, disk_total: 42949672960, traffic_limit: 536870912000, traffic_mode: 'sum', billing_cycle: 'monthly',
  currency: 'CNY', price: 349, expires_at: '2027-07-21', expires_in: 299, month_start: '2026-09-21',
  traffic_reset_day: 21, day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970,
  total_rx: 5707805336, total_tx: 5203609923,
  metrics: { cpu: 13, load: [0, 0, 0], mem_used: 431800320, mem_total: 2147483648, swap_used: 268435456, swap_total: 2147483648, disk_used: 1524510720, disk_total: 42949672960, net_rx: 867, net_tx: 465, procs: 75, tcp: 16, udp: 3, uptime: 318521, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923 },
}
const NODES = { nodes: [node] }
const samples = Array.from({ length: 40 }, (_, i) => {
  const gap = i >= 12 && i <= 15
  return { ts: START + i * 300, cpu: gap ? null : 4 + (i % 7) * 2,
    mem_used: gap ? null : 400_000_000 + i * 5_000_000, disk_used: gap ? null : 1_500_000_000 + i * 1_000_000,
    net_rx: gap ? null : 300 + i * 10, net_tx: gap ? null : 200 + i * 8,
    swap_used: gap ? null : (i % 5) * 134217728,
    tcp: gap ? null : (i === 0 ? 0 : 20 + (i % 5)), udp: gap ? null : i % 4,
    procs: gap ? null : (i === 0 ? 0 : 48 + (i % 5) * 12) }
})
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))
let fixture = 'modern'
const HISTORIES = {
  modern: { metrics: samples },
  legacy: { metrics: samples.map((row) => without(row, EXTRA)) },
  partial: { metrics: samples.map((row, i) => {
    const next = without(row, ['tcp'])
    if (i < 4 || i > 36 || (i >= 18 && i <= 21)) delete next.swap_used
    if (i >= 27 && i <= 29) next.udp = null
    if (i >= 18 && i <= 21) delete next.procs
    return next
  }) },
  'tcp-only': { metrics: samples.map((row) => without(row, ['swap_used', 'udp', 'procs'])) },
  zero: { metrics: samples.map((row) => ({ ...row, swap_used: 0, tcp: 0, udp: 0, procs: 0 })) },
  invalid: { metrics: samples.map((row, i) => ({ ...row, swap_used: null, tcp: i % 2 ? -1 : '12', udp: null, procs: i % 2 ? [] : null })) },
  empty: { metrics: [] },
  'capacity-off': { metrics: samples },
  'capacity-reduced': { metrics: samples, step: 300 },
  'capacity-covering': { metrics: samples, step: 300 },
  'omitted-buckets': { metrics: samples.filter((_row, i) => i < 12 || i > 15), step: 300 },
  'single-hidden': { metrics: samples, step: 300 },
}
const PING = {
  ping: Array.from({ length: 40 }, (_, i) => ({ task_id: 1, ts: START + i * 300, latency: 30 + (i % 5) * 3,
    band: [28 + (i % 5) * 3, 34 + (i % 5) * 3], loss: 0 })),
  probes: { 1: '北京电信' }, loss: { 1: 0.4 },
  step: 300,
}
function pingFor(hours) {
  if (fixture === 'omitted-buckets') return { ...PING, ping: PING.ping.filter((_row, i) => i < 12 || i > 15) }
  if (fixture === 'single-hidden') return {
    ...PING, probes: { 1: '线路 A', 2: '线路 B' }, loss: {},
    ping: [...PING.ping, ...(hours === '1' ? [] : PING.ping.map((point) => ({ ...point, task_id: 2, latency: 80 })))],
  }
  return PING
}
const serveFile = (res, path) => {
  const file = join(DIST, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync(join(DIST, 'index.html'))) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const url = new URL(req.url, BASE)
  const path = url.pathname, full = path + url.search
  if (path.includes('/metrics') && url.searchParams.get('series') === 'metrics') historyRequests.push({ fixture, at: Date.now(), path: full })
  if (path.startsWith('/api/')) {
    if (UPSTREAM) {
      const up = new URL(UPSTREAM + full)
      const proxied = request(up, { method: req.method, headers: { host: up.host, accept: req.headers.accept || '*/*' } }, (r) => {
        res.writeHead(r.statusCode || 502, { 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
        r.pipe(res)
      })
      proxied.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })) })
      return req.pipe(proxied)
    }
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: BASE, site_name: '图表', history_days: 7 }
      : path === '/api/nodes' ? NODES
        : path.endsWith('/config') ? { listTop: 'both', cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '' }
          : path.includes('/metrics') ? (url.searchParams.get('series') === 'metrics' ? HISTORIES[fixture] : url.searchParams.get('series') === 'ping' ? pingFor(url.searchParams.get('hours')) : { metrics: [], ping: [], probes: {}, loss: {} }) : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
if (!REAL) { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); BASE = `http://127.0.0.1:${server.address().port}` }
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const profile = join(SHOTS, 'chrome-profile')
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1000,1200', '--force-device-scale-factor=2',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 120 && !wsUrl; i++) {
  try { const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* Chrome 尚未就绪。 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) { chrome.kill(); server.close(); throw new Error('Chrome 起不来') }
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id
  const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
  pending.set(next, (response) => { clearTimeout(timer); if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(response) })
  ws.send(JSON.stringify({ id: next, method, params }))
})
ws.onmessage = (e) => {
  const message = JSON.parse(e.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params?.exceptionDetails?.exception?.description || '异常')
  if (message.method === 'Fetch.requestPaused') {
    external.push({ url: message.params.request.url, resourceType: message.params.resourceType })
    void send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'BlockedByClient' }).catch((e) => errors.push(String(e)))
  }
}
const js = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text)
  return response.result?.result?.value
}
await send('Runtime.enable'); await send('Page.enable')
// 只在夹具模式拦截第三方 URL，保证隔离验收不会访问外网。
if (!REAL && !UPSTREAM) await send('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }, { urlPattern: 'http://*', requestStage: 'Request' }] })
// Fetch 的本地请求需继续，外部请求才拒绝。
const originalMessage = ws.onmessage
ws.onmessage = (e) => {
  const message = JSON.parse(e.data)
  if (message.method === 'Fetch.requestPaused' && message.params.request.url.startsWith(BASE + '/')) { void send('Fetch.continueRequest', { requestId: message.params.requestId }).catch((e) => errors.push(String(e))); return }
  originalMessage(e)
}
async function viewport(width = 1000, dark = false, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 2, mobile })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
}
await viewport()
const PROBE = `(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom} }
  const panels = [...document.querySelectorAll('h4')].filter((h) => /^(CPU|内存|网络速率|硬盘|Swap|连接数|进程数)/.test(h.textContent || ''))
  return panels.map((h) => {
    const box = h.parentElement, svg = box.querySelector('svg'), chart = box.querySelector('[data-chart]')
    const texts = svg ? [...svg.querySelectorAll('text')] : []
    const paths = svg ? [...svg.querySelectorAll('path')] : []
    return { title:h.textContent, chartH:chart?.getBoundingClientRect().height ?? 0, svg:rect(svg), panel:rect(box),
      ariaLabel:svg?.getAttribute('aria-label'), plot:rect(svg?.querySelector('rect[fill="transparent"]')),
      clip:svg ? (()=>{const clip=svg.querySelector('clipPath'),r=clip?.querySelector('rect');return {id:clip?.id,
        reference:svg.querySelector('path[data-series]')?.parentElement.getAttribute('clip-path'),
        x:+r?.getAttribute('x'),y:+r?.getAttribute('y'),w:+r?.getAttribute('width'),h:+r?.getAttribute('height')}})():null,
      plotLocal:svg ? (()=>{const r=svg.querySelector('rect[fill="transparent"]');return {x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')}})():null,
      ys:texts.filter((t)=>t.getAttribute('text-anchor')==='end').map((t)=>t.textContent),
      xs:texts.filter((t)=>t.getAttribute('text-anchor')==='middle').map((t)=>t.textContent),
      labels:texts.map((t)=>({text:t.textContent,...rect(t)})),
      area:paths.filter((p)=>getComputedStyle(p).fill!=='none').length,
      line:paths.filter((p)=>p.hasAttribute('data-series')).length,
      series:paths.filter((p)=>p.hasAttribute('data-series')).map((p)=>({key:p.getAttribute('data-series'),d:p.getAttribute('d'),moves:(p.getAttribute('d').match(/M/g)||[]).length})),
      breaks:paths.map((p)=>(p.getAttribute('d').match(/M/g)||[]).length) }
  })
})()`
const inspect = () => js(PROBE)
const chartOf = (charts, prefix) => charts.find((chart) => chart.title.startsWith(prefix))
async function pageState() {
  return js(`(() => ({missing:[...document.querySelectorAll('p')].find((p)=>p.textContent.startsWith('当前 Hub 或这段历史未提供'))?.textContent.trim()??null,
    means:[...document.querySelectorAll('p')].find((p)=>p.textContent.includes('为采样区间均值'))?.textContent.trim()??null,
    empty:document.body.textContent.includes('这段时间没有历史数据'),width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    dark:document.documentElement.classList.contains('dark')}))()`)
}
async function open(url, expected = 7) {
  const before = historyRequests.length
  await send('Page.navigate', { url })
  let charts = []
  for (let i = 0; i < 50; i++) {
    await sleep(200)
    charts = await inspect()
    const state = await pageState()
    if (REAL || UPSTREAM) { if ([4,5,6,7].includes(charts.length) && charts.every((c) => c.svg && c.line > 0)) break }
    else if (historyRequests.length > before && (expected === 0 ? state.empty && charts.length === 0 : charts.length === expected && charts.every((c) => c.svg && c.line > 0))) break
  }
  await sleep(150)
  return inspect()
}
async function caseOpen(name, count) {
  fixture = name
  node.swap_total = name === 'capacity-off' || name === 'zero' ? 0 : 2147483648
  node.metrics.swap_total = node.swap_total
  node.mem_total = name === 'capacity-reduced' ? 134217728 : name === 'capacity-covering' ? 700_000_000 : 2147483648
  node.disk_total = name === 'capacity-reduced' ? 268435456 : name === 'capacity-covering' ? 1_800_000_000 : 42949672960
  node.metrics.mem_total = node.mem_total
  node.metrics.disk_total = node.disk_total
  const charts = await open(`${BASE}/node/1?fixture=${encodeURIComponent(name)}`, count)
  const state = await pageState()
  evidence.push({fixture:name,charts,state})
  check(`${name}: 面板数为 ${count}`, charts.length === count, charts.map((c)=>c.title).join(' / '))
  return {charts,state}
}
async function shot(name, selector) {
  const clip = await js(`(() => {
    const el=document.querySelector(${JSON.stringify(selector || 'main')});if(!el)return null
    const r=el.getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y+scrollY),width:Math.max(1,r.width),height:Math.max(1,r.height),scale:1}
  })()`)
  if (!clip) throw new Error(`截图目标不存在: ${selector || 'main'}`)
  const r=await send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:true})
  writeFileSync(join(SHOTS,name+'.png'),Buffer.from(r.result.data,'base64'))
  console.log(`SHOT ${join(SHOTS,name+'.png')}`)
}
async function hover(prefix, index, fy = .5) {
  await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:2,y:2})
  await js(`(() => {const h=[...document.querySelectorAll('h4')].find(h=>h.textContent.startsWith(${JSON.stringify(prefix)}));h?.parentElement.scrollIntoView({block:'center'});return !!h})()`)
  await sleep(100)
  const charts = await inspect(), plot = chartOf(charts,prefix)?.plot
  if (!plot) return null
  const x=plot.x+plot.w*index/39, y=plot.y+plot.h*fy
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y})
  await sleep(150)
  return js(`(() => {const h=[...document.querySelectorAll('h4')].find(h=>h.textContent.startsWith(${JSON.stringify(prefix)}));const el=h?.parentElement.querySelector('[data-chart] .rounded-lg');if(!el)return null;const b=el.getBoundingClientRect();return {text:el.textContent,rows:[...el.querySelectorAll('li')].map(li=>li.textContent),x:b.x,y:b.y,w:b.width,h:b.height}})()`)
}
const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const coords = (path) => [...path.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m)=>({x:Number(m[1]),y:Number(m[2])}))
function verifySeries(name, charts, fields) {
  for (const key of fields) {
    const chart=charts.find((chart)=>chart.series.some((series)=>series.key===key)), series=chart?.series.find((series)=>series.key===key)
    const rows=HISTORIES[name].metrics, indices=rows.flatMap((row,i)=>valid(row[key])?[i]:[])
    let runs=0,previous=-2
    for(const index of indices){if(index!==previous+1 || (HISTORIES[name].step && rows[index].ts-rows[previous].ts>HISTORIES[name].step))runs++;previous=index}
    const points=coords(series?.d||'')
    check(`${name}/${key}: 有效采样逐点保留、缺测处断线`, !!series && series.moves===runs && points.length===indices.length,
      `点=${points.length}/${indices.length};段=${series?.moves}/${runs}`)
    const p=chart?.plotLocal
    check(`${name}/${key}: 使用完整时间域且线条在绘图区内`, !!p && points.length===indices.length && points.every((point,i)=>
      Math.abs(point.x-(p.x+p.w*(rows[indices[i]].ts-rows[0].ts)/(rows.at(-1).ts-rows[0].ts)))<=.11 && point.y>=p.y-.11 && point.y<=p.y+p.h+.11) && !/NaN|Infinity|[CQ]/.test(series?.d||''), series?.d?.slice(0,100))
    if (key==='tcp'||key==='udp'||key==='procs') check(`${name}/${key}: 计数刻度为不同整数`, chart.ys.length===5 && chart.ys.every((t)=>/^\d+$/.test(t)) && new Set(chart.ys).size===5,chart.ys.join('/'))
  }
}
function verifyMissing(name,state,names) {
  const actual=state.missing?.match(/未提供 (.+) 数据/)?.[1]?.split('、')||[]
  check(`${name}: 缺字段说明准确，不伪造零`, JSON.stringify(actual)===JSON.stringify(names),state.missing||'无缺字段说明')
}

try {
  console.log(`DETAIL dist=${DIST} evidence=${SHOTS}`)
  const initial=await open(`${BASE}/node/1`,7)
  const charts=initial
  const count=REAL||UPSTREAM?charts.length:7
  check('资源面板完整（旧四图及可用新增三图）', charts.length===count && ([4,5,6,7].includes(count)),charts.map(c=>c.title).join('/'))
  check('每块 SVG 撑满 160px 图表容器',charts.length===count && charts.every(c=>c.svg&&Math.abs(c.svg.h-c.chartH)<=2&&c.chartH===160))
  check('每张 SVG 都有 aria-label',charts.length>0&&charts.every(c=>!!c.ariaLabel))
  check('数据路径由每图独立的绘图区 clipPath 裁剪，坐标轴仍在其外',charts.length>0&&new Set(charts.map(c=>c.clip?.id)).size===charts.length&&charts.every(c=>
    c.clip?.id&&c.clip.reference===`url(#${c.clip.id})`&&['x','y','w','h'].every(key=>c.clip[key]===c.plotLocal[key])))
  check('五条 Y 刻度和真实 HH:MM 时间轴',charts.length>0&&charts.every(c=>c.ys.length===5&&c.xs.length>=3&&c.xs.every(s=>/^\d{2}:\d{2}$/.test(s))))
  const cpu=chartOf(charts,'CPU'), memory=chartOf(charts,'内存'), network=chartOf(charts,'网络速率'), disk=chartOf(charts,'硬盘')
  check('旧 CPU/内存/硬盘面积填充及网络双折线保留',cpu?.area>=1&&memory?.area>=1&&disk?.area>=1&&network?.area===0&&network?.line===2)
  if (!REAL&&!UPSTREAM) {
    check('旧 CPU 五刻度保持准确',JSON.stringify(cpu?.ys)===JSON.stringify(['0%','4%','8%','12%','16%']),JSON.stringify(cpu?.ys))
    check('旧网络速率/字节单位保留',network.ys.every(s=>s.endsWith('/s'))&&memory.ys.every(s=>s.endsWith('B'))&&disk.ys.every(s=>s.endsWith('B')))
    check('旧字段空采样仍为断点',charts.every(c=>c.breaks.some(n=>n===2)))
    verifySeries('modern',charts,EXTRA)
    const state=await pageState()
    verifyMissing('modern',state,[])
    check('注明采样区间均值和 Hub 取整',!!state.means&&state.means.includes('采样区间均值')&&state.means.includes('Hub 取整'),state.means||'')
  }
  const tip=await hover('CPU',20,.5)
  check('真实鼠标悬停显示 CPU 名称和百分比',!!tip&&tip.text.includes('CPU')&&tip.text.includes('%'),JSON.stringify(tip))
  const up=await hover('CPU',20,.15), down=await hover('CPU',20,.85)
  const cpuPlot=chartOf(await inspect(),'CPU')?.plot
  check('Tooltip 随鼠标上下移动且不越绘图区',!!up&&!!down&&down.y-up.y>20&&up.y>=cpuPlot.y-2&&down.y+down.h<=cpuPlot.bottom+2,JSON.stringify({up,down,plot:cpuPlot}))
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2})
  await shot('01-modern-desktop')
  if (!REAL&&!UPSTREAM) {
    for(const [prefix,expect] of [['Swap','Swap0 B'],['连接数','TCP0'],['进程数','进程0']]) {
      const zeroTip=await hover(prefix,0)
      check(`modern/${prefix}: 合法零采样 tooltip 保留`,!!zeroTip&&zeroTip.rows.some(row=>row.replace(/\s/g,'')===expect.replace(/\s/g,'')),JSON.stringify(zeroTip))
    }
    const legacy=await caseOpen('legacy',4)
    verifyMissing('legacy',legacy.state,['Swap','TCP','UDP','进程数'])
    check('旧 Hub 不显示新增面板/均值注记',legacy.charts.every(c=>!c.series.some(s=>EXTRA.includes(s.key)))&&legacy.state.means===null)
    await shot('02-legacy-desktop')
    const partial=await caseOpen('partial',7)
    verifyMissing('partial',partial.state,['TCP'])
    check('TCP 全缺时连接数仅绘制 UDP',JSON.stringify(chartOf(partial.charts,'连接数')?.series.map(s=>s.key))===JSON.stringify(['udp']))
    verifySeries('partial',partial.charts,['swap_used','udp','procs'])
    const missingTip=await hover('Swap',20)
    check('局部缺采样 Tooltip 不报零 Swap',missingTip===null,JSON.stringify(missingTip))
    const connectionsTip=await hover('连接数',20)
    check('缺 TCP Tooltip 只显示真实 UDP',connectionsTip?.rows.length===1&&connectionsTip.rows[0]==='UDP0',JSON.stringify(connectionsTip))
    await shot('03-partial-desktop')
    const one=await caseOpen('tcp-only',5)
    verifyMissing('tcp-only',one.state,['Swap','UDP','进程数'])
    check('UDP 全缺时仅绘制 TCP 且旧四图保留',JSON.stringify(chartOf(one.charts,'连接数')?.series.map(s=>s.key))===JSON.stringify(['tcp']))
    verifySeries('tcp-only',one.charts,['tcp'])
    const zero=await caseOpen('zero',7)
    verifyMissing('zero',zero.state,[])
    verifySeries('zero',zero.charts,EXTRA)
    check('零值新增四序列沿零基线绘制',zero.charts.flatMap(c=>c.series.filter(s=>EXTRA.includes(s.key)).map(s=>coords(s.d).every(point=>Math.abs(point.y-c.plotLocal.y-c.plotLocal.h)<.11))).every(Boolean))
    for(const [prefix,expectedRows] of [['Swap',['Swap0 B']],['连接数',['TCP0','UDP0']],['进程数',['进程0']]]) {
      const value=await hover(prefix,20)
      check(`zero/${prefix}: 全零 tooltip 准确`,!!value&&JSON.stringify(value.rows)===JSON.stringify(expectedRows),JSON.stringify(value))
    }
    const invalid=await caseOpen('invalid',4)
    verifyMissing('invalid',invalid.state,['Swap','TCP','UDP','进程数'])
    check('全 null / 非数值 / 负值不会显示伪造新增图',invalid.charts.every(c=>c.series.every(s=>!EXTRA.includes(s.key))))
    const empty=await caseOpen('empty',0)
    check('全部无历史时使用全局空态，无新增缺字段误导',empty.state.empty&&empty.state.missing===null&&empty.state.means===null)
    const disabled=await caseOpen('capacity-off',7)
    verifySeries('capacity-off',disabled.charts,['swap_used'])
    check('当前 Swap 容量为零但正历史仍完整显示',chartOf(disabled.charts,'Swap').ys.some(t=>t!=='0 B'))
    const reduced=await caseOpen('capacity-reduced',7)
    verifySeries('capacity-reduced',reduced.charts,['mem_used','disk_used'])
    await shot('capacity-reduced-resources')
    const covering=await caseOpen('capacity-covering',7)
    for(const [prefix,key,total] of [['内存','mem_used',node.mem_total],['硬盘','disk_used',node.disk_total]]) {
      const chart=chartOf(covering.charts,prefix),p=chart.plotLocal
      const actual=coords(chart.series.find(series=>series.key===key).d),validRows=samples.filter(row=>valid(row[key]))
      check(`容量覆盖历史时 ${prefix} 仍固定当前容量`,actual.length===validRows.length&&actual.every((point,i)=>Math.abs(point.y-(p.y+p.h-validRows[i][key]/total*p.h))<=.11))
    }
    const omitted=await caseOpen('omitted-buckets',7)
    verifySeries('omitted-buckets',omitted.charts,['cpu','mem_used','disk_used','net_rx','net_tx',...EXTRA])
    await shot('omitted-buckets-resources')
    for(const width of [320,390]) for(const dark of [false,true]) {
      await viewport(width,dark,true)
      const phone=await caseOpen('modern',7)
      const name=`mobile-${width}-${dark?'dark':'light'}`
      check(`${name}: 实际视口与明暗匹配`,phone.state.width===width&&phone.state.dark===dark,JSON.stringify(phone.state))
      check(`${name}: 图表、刻度无水平裁切/页面溢出`,phone.state.scrollWidth<=width&&phone.charts.every(c=>
        c.svg.x>=-.5&&c.svg.right<=width+.5&&c.labels.every(t=>t.x>=-.5&&t.right<=width+.5)),JSON.stringify(phone.charts.map(c=>({title:c.title,svgRight:c.svg.right,labelLeft:Math.min(...c.labels.map(t=>t.x)),labelRight:Math.max(...c.labels.map(t=>t.right))}))))
      check(`${name}: 七图垂直分隔且各为160px`,phone.charts.length===7&&phone.charts.every((c,i)=>c.chartH===160&&(!i||c.panel.y>=phone.charts[i-1].panel.bottom+1)))
      await sleep(400)
      const stable=await inspect()
      check(`${name}: ResizeObserver 后尺寸/路径稳定`,JSON.stringify(stable.map(c=>({w:c.svg.w,h:c.svg.h,series:c.series})))===JSON.stringify(phone.charts.map(c=>({w:c.svg.w,h:c.svg.h,series:c.series}))))
      await shot(`${name}-resources`)
    }
    await viewport(1000,false,false)
    await caseOpen('modern',7)
    await js('window.scrollTo(0,0)')
  }
// ── 二、延迟页签：拖选缩放（原来 recharts 的 Brush，现在是在图上横向拖一段 + 一枚重置） ──
if (!REAL) {
  console.log('\n二、延迟页签（拖选缩放 / 重置）:')
  await js(`(() => { window.scrollTo(0,0); const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '网络延迟'); b && b.click(); return !!b })()`)
  let latency = null
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    latency = JSON.parse(await js(`(() => {
      const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
      if (!svg) return 'null'
      const rect = svg.querySelector('rect[fill="transparent"]')
      const r = rect ? rect.getBoundingClientRect() : null
      const xs = [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent)
      return JSON.stringify({
        xs,
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        lines: svg.querySelectorAll('path[stroke-width="1.5"]').length,
        lineInfo: [...svg.querySelectorAll('path[stroke-width="1.5"]')].map((p) => (p.getAttribute('d') || '').slice(0, 24) + ' | ' + p.getAttribute('stroke')),
        bands: svg.querySelectorAll('path[fill-opacity="0.16"]').length,
      })
    })()`))
    if (latency && latency.rect) break
  }
  check('延迟图画出来了（一条线路 + 那块区间 band）', !!latency && latency.lines === 1 && latency.bands === 1,
    JSON.stringify(latency && { lines: latency.lines, bands: latency.bands, lineInfo: latency.lineInfo }))
  const before = latency?.xs ?? []
  const r = latency?.rect
  if (r) {
    // 用**真鼠标事件**：合成的 PointerEvent 没有有效 pointerId，setPointerCapture 会抛。
    const y = r.y + Math.round(r.h / 2)
    const from = r.x + Math.round(r.w * 0.3)
    const to = r.x + Math.round(r.w * 0.6)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to, y, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(450)
    const after = JSON.parse(await js(`(() => {
      const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
      return JSON.stringify({
        xs: [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent),
        reset: !![...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '重置'),
      })
    })()`))
    check('横向拖选一段之后窗口收窄了（X 轴刻度变了）', JSON.stringify(after.xs) !== JSON.stringify(before),
      `前 ${JSON.stringify(before)} → 后 ${JSON.stringify(after.xs)}`)
    check('缩放之后出现「重置」', after.reset === true, `reset=${after.reset}`)
    await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '重置'); b && b.click(); return true })()`)
    await sleep(450)
    const back = JSON.parse(await js(`(() => { const svg = document.querySelector('svg[aria-label="节点延迟走势"]'); return JSON.stringify([...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent)) })()`))
    check('点「重置」回到整段窗口', JSON.stringify(back) === JSON.stringify(before), JSON.stringify(back))
    const gone = await js(`(() => ![...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '重置'))()`)
    check('重置之后那枚按钮自己收掉', gone === true, `gone=${gone}`)
    // 悬停：那枚自绘 tooltip 走的是 PingTooltip（最慢的排最前、超时标「无响应」、带丢包率），
    // 这条断言专门盯「换图之后它还接得上」。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + Math.round(r.w * 0.5), y: r.y + Math.round(r.h / 2) })
    await sleep(300)
    const tip = await js(`(() => {
      const el = [...document.querySelectorAll('div')].find((d) => (d.textContent || '').includes('北京电信') && (d.className || '').includes('rounded-lg'))
      return el ? el.textContent : null
    })()`)
    check('延迟图悬停出 tooltip（线路名 + 毫秒值）', !!tip && /北京电信/.test(tip) && /ms/.test(tip), JSON.stringify(tip))
    await shot('latency-chart', 'svg[aria-label="节点延迟走势"]')
  } else {
    check('拿到延迟图的绘图区（拖选的前提）', false, '没找到 rect')
  }
}

if (!REAL && !UPSTREAM) {
  const openLatency = async (name) => {
    await caseOpen(name, 7)
    await js(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='网络延迟').click() })()`)
    for (let i = 0; i < 30; i++) {
      if (await js(`!!document.querySelector('svg[aria-label="节点延迟走势"] path[data-series]')`)) return
      await sleep(100)
    }
    throw new Error('延迟夹具没有就绪')
  }
  const latencyState = () => js(`(() => {
    const svg=document.querySelector('svg[aria-label="节点延迟走势"]');return {
      paths:[...(svg?.querySelectorAll('path[data-series]')||[])].map(p=>({key:p.dataset.series,d:p.getAttribute('d'),moves:(p.getAttribute('d').match(/M/g)||[]).length})),
      bands:svg?.querySelectorAll('path[fill-opacity="0.16"]').length??0,
      connect:document.querySelector('[data-latency-option="connect-gaps"]')?.checked,
      empty:document.body.textContent.includes('没有选中任何探测'),
      legend:[...document.querySelectorAll('button')].filter(b=>/^线路 [AB]$/.test(b.textContent.trim())).map(b=>b.textContent.trim())}
  })()`)
  await openLatency('omitted-buckets')
  const broken=await latencyState()
  check('整桶省略时默认延迟线和 band 保留缺口',broken.connect===false&&broken.paths[0]?.moves===2&&coords(broken.paths[0].d).length===36&&broken.bands===2,JSON.stringify(broken))
  await js(`document.querySelector('[data-latency-option="connect-gaps"]').click()`)
  await sleep(150)
  const connected=await latencyState()
  check('仅开启连接断点时主线跨空桶，band 与真实采样保持',connected.connect===true&&connected.paths[0]?.moves===1&&coords(connected.paths[0].d).length===36&&connected.bands===2,JSON.stringify(connected))
  await shot('omitted-buckets-latency')
  await openLatency('single-hidden')
  await js(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='线路 A').click() })()`)
  await sleep(150)
  await js(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='1 小时').click() })()`)
  let hidden
  for (let i = 0; i < 30; i++) {
    await sleep(100)
    hidden=await latencyState()
    if(hidden.empty) break
  }
  check('隐藏线路成为唯一健康线路时仍有图例恢复入口',hidden.empty&&hidden.paths.length===0&&JSON.stringify(hidden.legend)===JSON.stringify(['线路 A']),JSON.stringify(hidden))
  await shot('hidden-single-probe-recovery')
  await js(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='线路 A').click() })()`)
  await sleep(200)
  const restored=await latencyState()
  check('点击保留的单线路图例恢复真实曲线',!restored.empty&&restored.paths.length===1&&restored.paths[0].key==='t1'&&restored.paths[0].d.length>0,JSON.stringify(restored))
  evidence.push({fixture:'omitted-buckets-ping',broken,connected},{fixture:'hidden-single-probe',hidden,restored})
}

  check('没有页面 JavaScript 异常',errors.length===0,JSON.stringify(errors))
  if(!REAL&&!UPSTREAM) check('隔离 CNY 夹具没有第三方请求',external.length===0,JSON.stringify(external))
} catch(error) {
  check('浏览器验收执行完成',false,error.stack||String(error))
} finally {
  const report={dist:DIST,base:BASE,passed,failed,results,evidence,historyRequests,exceptions:errors,external,screenshots:SHOTS}
  writeFileSync(join(SHOTS,'report.json'),JSON.stringify(report,null,2)+'\n')
  console.log(`\n结果: PASS ${passed} / FAIL ${failed}; REPORT ${join(SHOTS,'report.json')}`)
  ws.close()
  chrome.kill()
  server.close()
}
process.exit(failed?1:0)
