// 本机 dist + 合成节点夹具，使用原生 Chrome/CDP；不访问线上探针，不引入依赖。
// 用法：node tools/verify_map_controls.mjs [输出目录]；可指定 CHROME_PATH / MAP_DIST。
// MAP_BASELINE_DIST 可指向保留的旧 dist，实测同夹具的地图尺寸作为前后对照。
// MAP_CHECK_GROUP=interactions 仅运行节点悬停、选择与实时更新，便于失败后定向复验。
// MAP_CHECK_GROUP=locations 仅运行小队同地点合并、逐成员引线、缩放与准确详情。
// MAP_CHECK_GROUP=mobile-layout 对比保留旧版的手机上下留白，并检查标签、控件与节点交互。
// 再设 MAP_LOCATION_NEIGHBORS_ONLY=1 可仅复验 Tokyo→Osaka→Tokyo 连续悬停。
// 再设 MAP_INTERACTION_TOUCH_ONLY=1 可仅复验 320px/2D/亮的触屏选择完整前置步骤。
// 临时 Chrome profile、截图与 report.json 全部保留；验收退出只终止本脚本创建的进程。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const parentOutput = process.argv[2] ? resolve(process.argv[2]) : tmpdir()
mkdirSync(parentOutput, { recursive: true })
const OUT = mkdtempSync(join(parentOutput, 'monitor-map-controls-'))
const DIST = resolve(process.env.MAP_DIST || 'dist')
const BASELINE_DIST = process.env.MAP_BASELINE_DIST ? resolve(process.env.MAP_BASELINE_DIST) : null
const INTERACTIONS_ONLY = process.env.MAP_CHECK_GROUP === 'interactions'
const LOCATIONS_ONLY = process.env.MAP_CHECK_GROUP === 'locations'
const MOBILE_LAYOUT_ONLY = process.env.MAP_CHECK_GROUP === 'mobile-layout'
const NEIGHBORS_ONLY = LOCATIONS_ONLY && process.env.MAP_LOCATION_NEIGHBORS_ONLY === '1'
const TARGETED = INTERACTIONS_ONLY || LOCATIONS_ONLY || MOBILE_LAYOUT_ONLY
const TOUCH_ONLY = INTERACTIONS_ONLY && process.env.MAP_INTERACTION_TOUCH_ONLY === '1'
let servingDist = MOBILE_LAYOUT_ONLY ? BASELINE_DIST || DIST : TARGETED ? DIST : BASELINE_DIST || DIST
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
if (!CHROME) throw new Error('未找到 Chrome；可设置 CHROME_PATH')
if (!existsSync(join(DIST, 'index.html'))) throw new Error('缺少 dist/index.html；请先构建项目')
if (BASELINE_DIST && !existsSync(join(BASELINE_DIST, 'index.html'))) throw new Error('MAP_BASELINE_DIST 缺少 index.html')
if (typeof WebSocket === 'undefined') throw new Error('本工具需要提供原生 WebSocket 的 Node.js 版本')

const MODE_KEY = 'jikasei:map_mode'
const SPIN_KEY = 'jikasei:map_spin'
const GB = 1024 ** 3
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' }
const makeNode = (id, name, country, group, online = true) => ({
  id, name, country, group, online, public: true, sort: id, country_pin: '', last_seen: Math.floor(Date.now() / 1000),
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.4.0', price: 12, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: '2027-01-01', expires_in: 90, traffic_limit: 100 * GB, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: GB, total_tx: GB, month_rx: GB, month_tx: GB, month_start: '2026-10-01', day_rx: GB, day_tx: GB / 2, public_remark: '',
  metrics: { uptime: 400000, cpu: 12, load: [0.1, 0.2, 0.3], mem_used: GB, mem_total: 2 * GB, swap_used: 0, swap_total: 0, disk_used: 10 * GB, disk_total: 40 * GB, net_rx: 1024, net_tx: 512, procs: 50, tcp: 10, udp: 2, total_rx: GB, total_tx: GB, month_rx: GB, month_tx: GB },
})
// 东京两台含离线；跨半球、近日期变更线、长标签、缺失国家覆盖投影与命中边界。
let nodes = [
  makeNode(1, 'Tokyo 一号', 'JP', '亚太'), makeNode(2, 'Tokyo 二号', 'JP', '亚太', false),
  makeNode(3, 'Frankfurt 一号', 'DE', '欧洲', false), makeNode(4, 'Seattle 一号', 'US', '美洲'),
  makeNode(5, 'Singapore 一号', 'SG', '亚太'), makeNode(6, 'Sydney 一号', 'AU', '亚太'),
  makeNode(7, 'São Paulo 一号', 'BR', '美洲'), makeNode(8, 'Auckland Datacenter Very Long Example Name', 'NZ', '亚太'),
  makeNode(9, 'Toronto 一号', 'CA', '美洲'), makeNode(10, '芬兰节点', 'FI', '欧洲'),
  makeNode(11, 'Xi’an-01', 'CN', '亚太'), makeNode(12, '未定位节点', '', '未定位'),
  makeNode(13, 'Seattle-跨国反例', 'CN', '亚太'),
]
const locatedIds = nodes.filter((node) => node.country).map((node) => node.id).sort((a, b) => a - b)
const xssName = 'Tokyo <img src=x onerror="window.__mapXss=1"> & "测试节点"'
const interactionNodes = () => [
  ...Array.from({ length: 6 }, (_, i) => makeNode(401 + i, i === 5 ? xssName : `Tokyo 交互${i + 1}`, 'JP', '交互', i < 3)),
  ...Array.from({ length: 6 }, (_, i) => makeNode(501 + i, `Frankfurt 交互${i + 1}`, 'DE', '交互', false)),
  ...Array.from({ length: 6 }, (_, i) => makeNode(601 + i, `Singapore 交互${i + 1}`, 'SG', '交互')),
]
// 总数 10 台，复现旧 <30 总量且同地点 <5 不合并；同国不同城市必须分开。
const smallLocationGroups = [
  { ids: [801, 802, 803], code: 'HK', city: 'Hong Kong' },
  { ids: [811, 812], code: 'SG', city: 'Singapore' },
  { ids: [821, 822], code: 'US', city: 'Los Angeles' },
  { ids: [831], code: 'US', city: 'Seattle' },
  { ids: [841], code: 'JP', city: 'Tokyo' }, { ids: [842], code: 'JP', city: 'Osaka' },
]
const smallLocationNodes = () => [
  makeNode(801, 'Hong Kong 一号', 'HK', '小队'), makeNode(802, '香港离线二号', 'HK', '小队', false), makeNode(803, 'HK 三号', 'HK', '小队'),
  makeNode(811, 'Singapore 一号', 'SG', '小队'), makeNode(812, 'Singapore 二号', 'SG', '小队'),
  makeNode(821, 'Los Angeles 离线一号', 'US', '小队', false), makeNode(822, 'Los Angeles 离线二号', 'US', '小队', false),
  makeNode(831, 'Seattle 独立节点', 'US', '小队'),
  makeNode(841, 'Tokyo 近城市单节点', 'JP', '小队'), makeNode(842, 'Osaka 近城市单节点', 'JP', '小队', false),
]
// 预期成员来自夹具声明，不能按同一国家推断，否则不同美国城市误合并会假绿。
const fixtureGroups = [
  [1, 2], ...[101, 201, 301].map((start) => Array.from({ length: 5 }, (_, i) => start + i)),
  ...[401, 501, 601].map((start) => Array.from({ length: 6 }, (_, i) => start + i)),
  ...smallLocationGroups.map((group) => group.ids),
]
const NODE_UI = {
  tooltip: '[data-map-tooltip]', tooltipMember: '[data-map-tooltip-member]',
  dialog: '[data-map-node-dialog]', option: '[data-map-node-option]', close: '[data-map-node-close]', overlay: '[data-map-node-overlay]',
  name: '[data-map-node-name]', idAttribute: 'data-map-node-option', tooltipIdAttribute: 'data-map-tooltip-member', onlineAttribute: 'data-online',
}
const requests = []
const results = []
const evidence = []
const baseline = new Map()
const diagnostics = []
const exceptions = []
let base = 'http://127.0.0.1'
let chrome, chromeError, ws
let commandId = 0
const pending = new Map()
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const server = createServer((req, res) => {
  const url = new URL(req.url, base)
  if (url.pathname.startsWith('/api/')) {
    requests.push({ path: url.pathname + url.search, at: Date.now(), dist: servingDist })
    const body = url.pathname === '/api/me' ? { authed: false, github: false, public_page: true, site_name: '地图控件验收', history_days: 30 }
      : url.pathname === '/api/nodes' ? { nodes }
        : url.pathname.endsWith('/config') ? { globeOn: true, cardStyle: 'detailed', listTop: 'groups', themeMode: 'system' }
          : url.pathname === '/api/version' ? { version: '1.4.0' }
            : { metrics: [], ping: [], probes: {}, loss: {}, step: 60 }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const path = resolve(servingDist, '.' + url.pathname)
  const file = (path === servingDist || path.startsWith(servingDist + sep)) && existsSync(path) && statSync(path).isFile() ? path : join(servingDist, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') })

function send(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    const id = ++commandId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 10000)
    pending.set(id, { timer, reject, resolve: (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolveCall(message.result)
    } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(fn, ...args) {
  const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
}
async function waitFor(fn, ...args) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(fn, ...args)) return
    await sleep(150)
  }
  throw new Error(`等待页面状态超时：${fn.toString().slice(0, 130)}`)
}
const ready = () => waitFor(() => document.querySelector('.globe-panel[data-map-mode] svg[data-map-canvas] path.globe-land')?.getAttribute('d')?.length > 0)
async function control(key) {
  const found = await evaluate((key) => {
    const button = document.querySelector(`[data-map-control="${key}"]`)
    if (!button || button.disabled) return false
    button.click()
    return true
  }, key)
  if (!found) throw new Error(`找不到可用的地图按钮：${key}`)
  await sleep(150)
}
async function mode(value) {
  await control(`mode-${value}`)
  await waitFor((value) => document.querySelector('.globe-panel')?.dataset.mapMode === value, value)
}
async function motion(value) {
  // 地区定位时按钮表示暂停；点开始旋转解除定位而不取消地区筛选。
  for (let i = 0; i < 2; i++) {
    const current = await state()
    if (current.spin === String(value) && (!value || current.spinPressed === 'true')) break
    await control('spin')
  }
  await waitFor((value) => document.querySelector('.globe-panel')?.dataset.mapSpin === String(value), value)
  await sleep(150)
}
async function viewport(width, height, mobile = width < 500) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 1 })
}
async function media(dark, reduced = false) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
  await sleep(150)
}
async function navigate() {
  await send('Page.navigate', { url: base + '/' })
  await ready()
  await waitFor(() => document.querySelectorAll('[data-slot="card"] h3').length > 0)
  await sleep(250)
}
async function preferences(modeValue, spinValue) {
  await evaluate((modeKey, spinKey, modeValue, spinValue) => {
    for (const [key, value] of [[modeKey, modeValue], [spinKey, spinValue]]) {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
    localStorage.removeItem('jikasei:globe')
  }, MODE_KEY, SPIN_KEY, modeValue, spinValue)
  await navigate()
}
function inspect() {
  const panel = document.querySelector('.globe-panel')
  const svg = panel?.querySelector('svg[data-map-canvas]')
  if (!panel || !svg) return { missing: true }
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } }
  const svgBox = rect(svg)
  const paths = [...svg.querySelectorAll('path.globe-land,path.globe-coast,path.globe-wire,path.globe-sweep')].map((el) => ({ kind: el.getAttribute('class'), d: el.getAttribute('d') || '' }))
  const labels = [...svg.querySelectorAll('text.globe-label,text.globe-count')].map((el) => ({ text: el.textContent, ...rect(el) })).filter((el) => el.w > 0)
  const clipped = labels.filter((r) => r.x < svgBox.x - 1 || r.right > svgBox.right + 1 || r.y < svgBox.y - 1 || r.bottom > svgBox.bottom + 1).map((r) => r.text)
  const overlaps = []
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j]
    if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) overlaps.push([a.text, b.text])
  }
  const caption = svg.querySelector('.globe-caption')
  const spin = panel.querySelector('[data-map-control="spin"]')
  const controls = [...panel.querySelectorAll('.globe-toolbar button,.globe-controls input')].map((el) => {
    const box = rect(el)
    const hit = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2)
    return { name: el.dataset.mapControl || el.getAttribute('aria-label'), disabled: el.disabled, visible: box.w > 0 && box.h > 0, hittable: hit === el || el.contains(hit), ...box }
  })
  const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
  const pinBoxes = [...svg.querySelectorAll('[data-node]')].map((el) => ({ text: `node:${el.dataset.node}`, ...rect(el) }))
  const ink = [...labels, ...pinBoxes, ...(caption ? [{ text: 'caption', ...rect(caption) }] : [])]
  const controlObscures = controls.filter((control) => control.visible).flatMap((control) => ink.filter((item) => intersects(control, item)).map((item) => `${control.name}:${item.text}`))
  const projection = svg.querySelector('.globe-disk,.globe-map-frame')
  const bodyInk = [...(projection ? [rect(projection)] : []), ...labels]
  const bodyTop = bodyInk.length ? Math.min(...bodyInk.map((item) => item.y)) : null
  const bodyBottom = bodyInk.length ? Math.max(...bodyInk.map((item) => item.bottom)) : null
  const colorContext = document.createElement('canvas').getContext('2d')
  const color = (value) => {
    if (!colorContext || !value || value === 'none' || value.startsWith('url(')) return null
    colorContext.clearRect(0, 0, 1, 1)
    colorContext.fillStyle = '#000'
    colorContext.fillStyle = value
    colorContext.fillRect(0, 0, 1, 1)
    return [...colorContext.getImageData(0, 0, 1, 1).data]
  }
  const part = (element) => {
    if (!element) return null
    const style = getComputedStyle(element), matrix = element.getScreenCTM(), box = rect(element)
    const scaleX = matrix ? Math.hypot(matrix.a, matrix.b) : 1
    const scaleY = matrix ? Math.hypot(matrix.c, matrix.d) : 1
    const strokeWidth = parseFloat(style.strokeWidth) || 0
    const strokePixels = style.stroke === 'none' ? 0 : strokeWidth * (style.vectorEffect === 'non-scaling-stroke' ? 1 : Math.max(scaleX, scaleY))
    let effectiveOpacity = 1
    for (let parent = element; parent; parent = parent.parentElement) {
      effectiveOpacity *= Number(getComputedStyle(parent).opacity)
      if (parent === svg) break
    }
    const gradientId = style.fill.match(/#([^)'"\s]+)/)?.[1]
    const gradient = gradientId ? document.getElementById(gradientId) : null
    return {
      tag: element.tagName, state: element.dataset.markerState, fill: style.fill, stroke: style.stroke,
      fillColor: color(style.fill), strokeColor: color(style.stroke), strokeWidth: style.strokeWidth, strokePixels,
      opacity: Number(style.opacity), effectiveOpacity, fillOpacity: Number(style.fillOpacity),
      animationName: style.animationName, animationDuration: style.animationDuration, animationPlayState: style.animationPlayState,
      d: element.getAttribute('d'), r: element.getAttribute('r'), ...box,
      outerWidth: box.w + strokePixels, outerHeight: box.h + strokePixels,
      stops: gradient ? [...gradient.querySelectorAll('stop')].map((stop) => ({ color: color(getComputedStyle(stop).stopColor), opacity: Number(getComputedStyle(stop).stopOpacity) })) : [],
    }
  }
  const pins = [...svg.querySelectorAll('.hit[data-node]')].map((el) => {
    const x = Number(el.getAttribute('cx')), y = Number(el.getAttribute('cy'))
    const marker = [...(el.parentElement?.querySelectorAll('.globe-pin') || [])].find((candidate) => {
      if (candidate.hasAttribute('data-marker-x')) return Math.abs(Number(candidate.dataset.markerX) - x) < 0.15 && Math.abs(Number(candidate.dataset.markerY) - y) < 0.15
      const b = candidate.getBBox()
      return Math.abs(b.x + b.width / 2 - x) < 0.15 && Math.abs(b.y + b.height / 2 - y) < 0.15
    })
    const core = el.parentElement?.querySelector('.globe-pin-core')
    const ring = el.parentElement?.querySelector('.globe-pin-ring')
    const halo = el.parentElement?.querySelector('.globe-pin-halo')
    const detail = el.parentElement?.querySelector('.globe-pin-detail')
    return {
      id: Number(el.dataset.node), key: el.dataset.pinKey, online: el.dataset.online, count: Number(el.dataset.count),
      offlineCount: Number(el.dataset.offlineCount), markerState: el.dataset.markerState,
      region: el.dataset.region, x: el.getAttribute('cx'), y: el.getAttribute('cy'), hitBox: rect(el),
      title: el.querySelector('title')?.textContent.trim() || el.getAttribute('aria-label'), hit: el.classList.contains('hit'), ring: !!marker,
      role: el.getAttribute('role'), tabIndex: el.getAttribute('tabindex'), accessibleName: el.getAttribute('aria-label'),
      describedBy: el.getAttribute('aria-describedby'), popup: el.getAttribute('aria-haspopup'), expanded: el.getAttribute('aria-expanded'),
      marker: marker ? { ...part(marker), core: part(core), ring: part(ring), halo: part(halo), detail: part(detail), beacon: !!marker.closest('.globe-beacon') } : null,
    }
  })
  return {
    mode: panel.dataset.mapMode, spin: panel.dataset.mapSpin, spinning: panel.dataset.mapSpinning,
    pulse: panel.dataset.markerPulse,
    spinPressed: spin?.getAttribute('aria-pressed'), spinDisabled: !spin || spin.disabled,
    zoom: Number(panel.querySelector('input[type="range"]')?.value), drag: panel.querySelector('.globe-atlas')?.dataset.drag,
    touchAction: getComputedStyle(panel.querySelector('.globe-atlas')).touchAction,
    paths, caption: caption?.textContent, pins,
    memberLabels: [...svg.querySelectorAll('text.globe-label')].map((el) => ({ id: Number(el.dataset.labelNode), key: el.dataset.pinKey, text: el.textContent, ...rect(el) })),
    memberStems: [...svg.querySelectorAll('path.globe-stem')].map((el) => {
      const d = el.getAttribute('d') || '', origin = d.match(/^M\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/)
      return { id: Number(el.dataset.labelNode), key: el.dataset.pinKey, d, x: origin ? Number(origin[1]) : null, y: origin ? Number(origin[2]) : null }
    }),
    sweepTime: svg.hasAttribute('data-sweep-time') ? Number(svg.dataset.sweepTime) : null,
    sweepLongitude: svg.hasAttribute('data-sweep-longitude') ? Number(svg.dataset.sweepLongitude) : null,
    cameraLongitude: svg.hasAttribute('data-camera-longitude') ? Number(svg.dataset.cameraLongitude) : null,
    cameraLatitude: svg.hasAttribute('data-camera-latitude') ? Number(svg.dataset.cameraLatitude) : null,
    cameraView: { w: 460, h: svg.viewBox.baseVal.height, cx: Number(svg.dataset.cameraCx), cy: Number(svg.dataset.cameraCy), r: Number(svg.dataset.cameraR) },
    nameLabels: svg.querySelectorAll('.globe-label').length, countLabels: svg.querySelectorAll('.globe-count').length,
    stems: svg.querySelectorAll('.globe-stem').length, links: svg.querySelectorAll('.globe-link').length,
    selected: !!svg.querySelector('.globe-selected'), markersAboveSelection: !svg.querySelector('.globe-selected') || [...svg.querySelectorAll('.globe-pin')].every((marker) => !!(svg.querySelector('.globe-selected').compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING)),
    mapFrame: !!svg.querySelector('.globe-map-frame'), globeDisk: !!svg.querySelector('.globe-disk'),
    rows: [...panel.querySelectorAll('.globe-reg')].map((el) => ({ text: el.querySelector('span')?.textContent.trim(), code: el.querySelector('img')?.getAttribute('src')?.match(/\/([^/]+)\.svg$/)?.[1], count: Number(el.querySelector('b')?.textContent), pressed: el.getAttribute('aria-pressed'), title: el.title, offline: !!el.querySelector('.globe-reg-dot') })),
    cards: [...document.querySelectorAll('[data-slot="card"] h3')].map((el) => el.textContent.trim()),
    dark: document.documentElement.classList.contains('dark'), overflow: document.documentElement.scrollWidth > innerWidth + 1,
    colors: { land: getComputedStyle(svg.querySelector('.globe-land')).fill, coast: getComputedStyle(svg.querySelector('.globe-coast')).stroke },
    clipped, overlaps, captionOverlap: caption ? labels.filter((r) => r.bottom > rect(caption).y + 1).map((r) => r.text) : ['missing caption'],
    labels: labels.length, controls, controlObscures, projection: projection ? rect(projection) : null,
    bodyTop, bodyBottom, captionBox: caption ? rect(caption) : null,
    viewportWidth: innerWidth, svg: svgBox, viewBox: svg.getAttribute('viewBox'), resizeObserverErrors: window.__mapResizeErrors || [], host: rect(panel.querySelector('.globe-atlas')),
    main: rect(panel.querySelector('.globe-main')), toolbar: rect(panel.querySelector('.globe-toolbar')),
    modeGroup: rect(panel.querySelector('.globe-map-controls')), zoomGroup: rect(panel.querySelector('.globe-controls')),
  }
}
async function state(label) {
  const snapshot = await evaluate(inspect)
  if (label) evidence.push({ label, at: Date.now(), ...snapshot })
  return snapshot
}
const geometry = (snapshot) => JSON.stringify({ paths: snapshot.paths, caption: snapshot.caption, pins: snapshot.pins?.map(({ id, x, y }) => ({ id, x, y })) })
async function stable(name, expected = false) {
  await sleep(200)
  const first = await state(name + ':before')
  await sleep(1100)
  const second = await state(name + ':after')
  check(name, first.spinning === String(expected) && second.spinning === String(expected) && (geometry(first) === geometry(second)) !== expected, `actual=${second.spinning}, geometryChanged=${geometry(first) !== geometry(second)}`)
  return second
}
async function zoom(key) {
  const found = await evaluate(() => { const input = document.querySelector('.globe-controls input[type="range"]'); input?.focus(); return !!input })
  if (!found) throw new Error('找不到地图缩放滑条')
  const code = { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39 }[key]
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  await sleep(200)
}
async function resetZoom() {
  await clearPointer()
  const found = await evaluate(() => { const b = document.querySelector('.globe-controls .globe-zoom-reset'); b?.click(); return !!b })
  if (!found) throw new Error('找不到缩放重置按钮')
  await sleep(200)
}
async function mouseDrag(dx, dy = 0) {
  const position = await evaluate(() => {
    const svg = document.querySelector('.globe-atlas svg')
    const point = svg.createSVGPoint()
    // 在圆盘/地图边缘的空处起手，避免按到针后把拖动误当成导航。
    const frame = svg.querySelector('.globe-map-frame')
    point.x = frame ? Number(frame.getAttribute('x')) + 12 : Number(svg.querySelector('.globe-disk').getAttribute('cx'))
    point.y = frame ? Number(frame.getAttribute('y')) + 12 : Number(svg.querySelector('.globe-disk').getAttribute('cy')) - Number(svg.querySelector('.globe-disk').getAttribute('r')) + 14
    const p = point.matrixTransform(svg.getScreenCTM())
    return { x: p.x, y: p.y }
  })
  await dragFrom(position, dx, dy)
}
async function dragFrom(position, dx, dy = 0, touch = false) {
  const point = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }]
  if (touch) await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(position.x, position.y) })
  else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 })
  }
  for (let i = 1; i <= 6; i++) {
    const x = position.x + dx * i / 6, y = position.y + dy * i / 6
    if (touch) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) })
    else await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(50)
  }
  if (touch) await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  else await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x + dx, y: position.y + dy, button: 'left', clickCount: 1 })
  await sleep(touch ? 350 : 200)
}
async function touchDrag(dx, dy) {
  const position = await evaluate(() => {
    const r = document.querySelector('.globe-atlas').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.7 }
  })
  const point = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }]
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(position.x, position.y) })
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(position.x + dx * i / 8, position.y + dy * i / 8) })
    await sleep(50)
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(350)
}
async function region(code) {
  const found = await evaluate((code) => {
    const button = [...document.querySelectorAll('.globe-reg:not(.globe-reg-all)')].find((el) => el.querySelector(`img[src="/flags/${code}.svg"]`))
    button?.click()
    return !!button
  }, code)
  if (!found) throw new Error(`找不到地区行：${code}`)
  await sleep(250)
}
async function allRegions() {
  await evaluate(() => document.querySelector('.globe-reg-all')?.click())
  await sleep(200)
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  if (result.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
}
async function clearPointer() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  // Radix 的可悬停 Tooltip 在 leave 后建立过渡区域；再移到区域外，模拟连续鼠标移动。
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: await evaluate(() => innerWidth - 2), y: 2 })
  await evaluate(() => { if (document.activeElement?.closest('svg[data-map-canvas]')) document.activeElement.blur() })
  await sleep(250)
}
async function keyPress(key) {
  const code = { Enter: 'Enter', ' ': 'Space', Escape: 'Escape', Tab: 'Tab' }[key]
  const windowsVirtualKeyCode = { Enter: 13, ' ': 32, Escape: 27, Tab: 9 }[key]
  const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text, unmodifiedText: text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  await sleep(200)
}
async function clickAt(target, touch = false) {
  if (touch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] })
    await sleep(80)
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  }
  await sleep(touch ? 350 : 200)
}
async function pinTarget(preferred = 4, exact = false) {
  const target = await evaluate((preferred, exact) => {
    const hits = [...document.querySelectorAll('svg[data-map-canvas] .hit[data-node]')]
    hits.sort((a, b) => Number(b.dataset.node === String(preferred)) - Number(a.dataset.node === String(preferred)))
    for (const hit of hits) {
      if (exact && hit.dataset.node !== String(preferred)) continue
      const r = hit.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
      if (document.elementFromPoint(x, y)?.closest('.hit[data-node]') !== hit) continue
      return { id: Number(hit.dataset.node), count: Number(hit.dataset.count), offlineCount: Number(hit.dataset.offlineCount), title: hit.querySelector('title')?.textContent.trim() || hit.getAttribute('aria-label'), x, y }
    }
    return null
  }, preferred, exact)
  if (!target) throw new Error(`找不到可实际命中的节点：${preferred}${exact ? '（精确）' : ''}`)
  return target
}
const expectedMembers = (target) => {
  const ids = fixtureGroups.find((group) => group.includes(target.id)) || [target.id]
  return nodes.filter((node) => ids.includes(node.id))
}
function inspectNodeUi(selectors) {
  const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } }
  const read = (selector, memberSelector, idAttribute) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const box = rect(element), style = getComputedStyle(element)
    return {
      ...box, visible: box.w > 0 && box.h > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
      role: element.getAttribute('role') || element.querySelector('[role="tooltip"]')?.getAttribute('role'), text: element.textContent,
      accessibleName: element.getAttribute('aria-label'),
      modal: element.getAttribute('aria-modal'), labelledBy: element.getAttribute('aria-labelledby'),
      members: [...element.querySelectorAll(memberSelector)].map((member) => {
        const r = rect(member), hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2)
        return { id: Number(member.getAttribute(idAttribute)), name: member.querySelector(selectors.name)?.textContent, online: member.getAttribute(selectors.onlineAttribute), text: member.textContent, hittable: hit === member || member.contains(hit), ...r }
      }),
      injected: !!element.querySelector('img[src="x"],svg[onload],script'),
    }
  }
  const dialog = document.querySelector(selectors.dialog), overlay = document.querySelector(selectors.overlay)
  return {
    tooltip: read(selectors.tooltip, selectors.tooltipMember, selectors.tooltipIdAttribute), dialog: read(selectors.dialog, selectors.option, selectors.idAttribute),
    dialogFocused: !!dialog?.contains(document.activeElement), backgroundHidden: !!document.querySelector('main')?.closest('[aria-hidden="true"]'), overlayEvents: overlay ? getComputedStyle(overlay).pointerEvents : null,
    focused: { tag: document.activeElement?.tagName, node: document.activeElement?.getAttribute('data-node'), option: document.activeElement?.getAttribute('data-map-node-option') },
    path: location.pathname, scrollY, innerWidth, innerHeight, xss: window.__mapXss ?? null,
  }
}
async function nodeUi(label) {
  const snapshot = await evaluate(inspectNodeUi, NODE_UI)
  if (label) evidence.push({ label, at: Date.now(), nodeUi: snapshot })
  return snapshot
}
function memberChecks(tag, list, expected) {
  check(`${tag}：全部成员名称和真实在线状态准确`, list && list.length === expected.length && expected.every((node) => list.some((member) => member.id === node.id && member.name === node.name && member.online === (node.online ? '1' : '0') && member.text.includes(node.online ? '在线' : '离线'))), list?.map((member) => `${member.id}:${member.online}:${member.name}`).join(' | '))
}
function uiBoundsChecks(tag, ui, kind) {
  const box = ui[kind]
  check(`${tag}：${kind === 'dialog' ? '选择框' : '悬停内容'}实际可见且完整位于屏幕内`, box?.visible && box.x >= -1 && box.right <= ui.innerWidth + 1 && box.y >= -1 && box.bottom <= ui.innerHeight + 1, box ? `${box.x.toFixed(1)},${box.y.toFixed(1)} ${box.w.toFixed(1)}×${box.h.toFixed(1)}` : 'missing UI')
  check(`${tag}：名称中的HTML作为文本显示`, box && !box.injected && ui.xss === null)
}
async function actualTarget(selector) {
  const target = await evaluate((selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    element.scrollIntoView({ block: 'nearest' })
    const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return hit === element || element.contains(hit) ? { x, y } : null
  }, selector)
  if (!target) throw new Error(`元素不可实际命中：${selector}`)
  return target
}
function dockChecks(tag, snapshot) {
  const { main, toolbar, modeGroup, zoomGroup, host } = snapshot
  const controls = snapshot.controls.filter((r) => r.visible)
  const within = (box, parent) => box.x >= parent.x - 1 && box.right <= parent.right + 1 && box.y >= parent.y - 1 && box.bottom <= parent.bottom + 1
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
  check(`${tag}：显示组左下、缩放组右下，底行不占画布`, modeGroup.x - main.x >= -1 && modeGroup.x - main.x <= 20 && main.right - zoomGroup.right >= -1 && main.right - zoomGroup.right <= 20 && main.bottom - toolbar.bottom <= 1 && host.bottom <= toolbar.y + 1 && within(modeGroup, toolbar) && within(zoomGroup, toolbar), `atlasBottom=${host.bottom.toFixed(1)}, dockTop=${toolbar.y.toFixed(1)}, groupGap=${(zoomGroup.x - modeGroup.right).toFixed(1)}`)
  check(`${tag}：两组同底行且互不重叠`, Math.abs(modeGroup.bottom - zoomGroup.bottom) <= 1 && !overlap(modeGroup, zoomGroup), `bottomDifference=${(modeGroup.bottom - zoomGroup.bottom).toFixed(1)}`)
  const hidden = snapshot.controls.filter((r) => !r.visible).map((r) => r.name).sort()
  const expectedHidden = snapshot.viewportWidth < 360 ? ['放大地球', '缩小地球'].sort() : []
  check(`${tag}：可见控件完整且启用项实际命中，无互相遮挡`, JSON.stringify(hidden) === JSON.stringify(expectedHidden) && controls.length === 7 - expectedHidden.length && controls.every((r) => (r.disabled || r.hittable) && r.w >= (snapshot.viewportWidth < 1200 ? 31 : 24) && r.h >= (snapshot.viewportWidth < 1200 ? 39 : 20) && within(r, toolbar)) && controls.every((a, i) => controls.slice(i + 1).every((b) => !overlap(a, b))), controls.filter((r) => (!r.disabled && !r.hittable) || !within(r, toolbar)).map((r) => r.name).join(' | '))
  check(`${tag}：控件不遮节点、名称与地图底注`, snapshot.controlObscures.length === 0, snapshot.controlObscures.slice(0, 4).join(' | '))
}
function growthChecks(tag, snapshot, width, selectedMode) {
  const previous = baseline.get(`${selectedMode}-${width}`)
  const oldHeight = previous?.host.h ?? 320
  diagnostics.push({ label: tag, mode: selectedMode, host: snapshot.host, projection: snapshot.projection, baselineHost: previous?.host, baselineProjection: previous?.projection, widthRatio: previous?.projection && snapshot.projection ? snapshot.projection.w / previous.projection.w : null })
  if (width > 720) check(`${tag}：画布空间不缩小`, snapshot.host.h >= oldHeight - 0.5, `${oldHeight.toFixed(1)}→${snapshot.host.h.toFixed(1)}px`)
  if (!previous) return
  const before = previous.projection
  const after = snapshot.projection
  check(`${tag}：实际地图尺寸不缩小`, before && after && after.w >= before.w - 0.5 && after.h >= before.h - 0.5, before && after ? `${before.w.toFixed(1)}×${before.h.toFixed(1)}→${after.w.toFixed(1)}×${after.h.toFixed(1)}px` : 'missing rendered projection')
}
function mobileWhitespaceChecks(tag, previous, snapshot) {
  const gaps = (item) => ({
    top: item.bodyTop - item.host.y,
    beforeCaption: item.captionBox.y - item.bodyBottom,
    afterCaption: item.toolbar.y - item.captionBox.bottom,
  })
  const measurable = [previous, snapshot].every((item) => item.projection && item.captionBox && Number.isFinite(item.bodyTop) && Number.isFinite(item.bodyBottom))
  check(`${tag}：上下留白比较确实量到地图、标签与底注`, measurable)
  if (!measurable) return
  const before = gaps(previous), after = gaps(snapshot)
  diagnostics.push({ label: tag, baselineHost: previous.host, host: snapshot.host, baselineGaps: before, gaps: after, baselineProjection: previous.projection, projection: snapshot.projection })
  check(`${tag}：压缩画布留白而不挤小地图`, snapshot.host.h <= previous.host.h - 10 && snapshot.projection.w >= previous.projection.w - 1 && snapshot.projection.h >= previous.projection.h - 1, `${previous.host.h.toFixed(1)}→${snapshot.host.h.toFixed(1)}px；地图 ${previous.projection.w.toFixed(1)}×${previous.projection.h.toFixed(1)}→${snapshot.projection.w.toFixed(1)}×${snapshot.projection.h.toFixed(1)}px`)
  check(`${tag}：地图上方空白减少且图形未被裁`, after.top >= -1 && after.top <= before.top - 4, `${before.top.toFixed(1)}→${after.top.toFixed(1)}px`)
  const bottomBefore = before.beforeCaption + before.afterCaption
  const bottomAfter = after.beforeCaption + after.afterCaption
  check(`${tag}：地图到说明及底角控件的空白减少`, after.beforeCaption >= -1 && after.afterCaption >= -1 && bottomAfter <= bottomBefore - 4, `${bottomBefore.toFixed(1)}→${bottomAfter.toFixed(1)}px`)
}
function renderingChecks(tag, snapshot) {
  check(`${tag}：没有节点间装饰性路径`, snapshot.links === 0, `globe-link=${snapshot.links}`)
  check(`${tag}：信标旁不再显示台数文本`, snapshot.countLabels === 0, `globe-count=${snapshot.countLabels}`)
  check(`${tag}：节点圈、命中区域与名称状态说明保留`, snapshot.pins.length > 0 && snapshot.pins.every((p) => p.hit && p.ring && p.title && p.count > 0), `pins=${snapshot.pins.length}`)
  markerChecks(tag, snapshot)
  sharedOriginChecks(tag, snapshot)
  if (snapshot.mode === '2d') {
    check(`${tag}：2D没有节点名称、引线和计数字样`, snapshot.nameLabels === 0 && snapshot.stems === 0 && snapshot.countLabels === 0, `names=${snapshot.nameLabels}, stems=${snapshot.stems}, counts=${snapshot.countLabels}`)
    const { host, projection } = snapshot
    const worldWidth = Math.min(host.w - 24, 2 * (host.h - 40))
    const worldHeight = worldWidth / 2
    const expectedX = host.x + (host.w - worldWidth) / 2
    const expectedY = host.y + 8 + (host.h - 40 - worldHeight) / 2
    check(`${tag}：矩形地图用满实际可用区且保留底注空间`, projection && Math.abs(projection.w - worldWidth) <= 2 && Math.abs(projection.h - worldHeight) <= 2 && Math.abs(projection.x - expectedX) <= 2 && Math.abs(projection.y - expectedY) <= 2, projection ? `map=${projection.w.toFixed(1)}×${projection.h.toFixed(1)}, usable=${worldWidth.toFixed(1)}×${worldHeight.toFixed(1)}` : 'missing map frame')
  }
}
function sharedOriginChecks(tag, snapshot) {
  if (snapshot.mode !== '3d') return
  const expected = snapshot.pins.flatMap((pin) => expectedMembers(pin).map((node) => ({ id: node.id, key: pin.key, x: Number(pin.x), y: Number(pin.y) })))
  const labels = snapshot.memberLabels, stems = snapshot.memberStems
  check(`${tag}：每个可见地点一枚信标，每成员各一标签与引线`, expected.length > 0 && labels.length === expected.length && stems.length === expected.length && new Set(labels.map((label) => label.id)).size === expected.length && new Set(stems.map((stem) => stem.id)).size === expected.length && expected.every((member) => labels.some((label) => label.id === member.id && label.key === member.key) && stems.some((stem) => stem.id === member.id && stem.key === member.key)), `pins=${snapshot.pins.length}, members=${expected.length}, labels=${labels.length}, stems=${stems.length}`)
  check(`${tag}：同地点全部成员引线从唯一信标中心出发`, expected.every((member) => {
    const stem = stems.find((candidate) => candidate.id === member.id && candidate.key === member.key)
    return stem && Number.isFinite(stem.x) && Number.isFinite(stem.y) && Math.abs(stem.x - member.x) <= 0.15 && Math.abs(stem.y - member.y) <= 0.15 && !/NaN|Infinity/.test(stem.d)
  }), stems.map((stem) => `${stem.id}@${stem.x},${stem.y}`).join(' | '))
}
function markerChecks(tag, snapshot) {
  const expectedState = (p) => p.offlineCount === 0 ? 'online' : p.offlineCount === p.count ? 'offline' : 'mixed'
  const green = (rgba) => rgba?.[1] > rgba[0] + 12 && rgba[1] > rgba[2] + 4
  const red = (rgba) => rgba?.[0] > rgba[1] + 20 && rgba[0] > rgba[2] + 20
  const close = (value, expected) => Number.isFinite(value) && Math.abs(value - expected) <= 0.2
  const scale = snapshot.zoom / 100
  check(`${tag}：信标结构与真实在线计数一致`, snapshot.pins.length > 0 && snapshot.pins.every((p) => Number.isInteger(p.offlineCount) && p.offlineCount >= 0 && p.offlineCount <= p.count && p.markerState === expectedState(p) && p.marker?.state === expectedState(p) && p.online === String(p.offlineCount === 0 ? 1 : 0) && p.marker.tag === 'circle' && p.marker.beacon && p.marker.ring?.tag === 'circle' && p.marker.halo?.tag === 'circle' && (p.markerState !== 'mixed' || p.marker.core?.tag === 'circle')), snapshot.pins.map((p) => `${p.id}:${p.markerState}/${p.offlineCount}/${p.count}`).join(' | '))
  check(`${tag}：核心、外圈含描边与光晕按当前${snapshot.zoom}%同比缩放`, snapshot.pins.every((p) => close(p.marker?.w, 6.4 * scale) && close(p.marker?.h, 6.4 * scale) && close(p.marker?.ring?.outerWidth, 11.52 * scale) && close(p.marker?.ring?.outerHeight, 11.52 * scale) && close(p.marker?.halo?.w, 15.04 * scale) && close(p.marker?.halo?.h, 15.04 * scale)), snapshot.pins.map((p) => `${p.id}:${p.marker?.w?.toFixed(2)}/${p.marker?.ring?.outerWidth?.toFixed(2)}/${p.marker?.halo?.w?.toFixed(2)}px`).join(' | '))
  check(`${tag}：透明命中区域随倍率缩放，保持100%直径18px基准`, snapshot.pins.every((p) => close(p.hitBox.w, 18 * scale) && close(p.hitBox.h, 18 * scale)), snapshot.pins.map((p) => `${p.id}:${p.hitBox.w.toFixed(2)}×${p.hitBox.h.toFixed(2)}`).join(' | '))
  check(`${tag}：可见核心与原透明命中圆中心一致`, snapshot.pins.every((p) => p.marker && Math.abs(p.marker.x + p.marker.w / 2 - p.hitBox.x - p.hitBox.w / 2) <= 0.2 && Math.abs(p.marker.y + p.marker.h / 2 - p.hitBox.y - p.hitBox.h / 2) <= 0.2))
  check(`${tag}：核心常亮无黑描边，外圈描边与倍率同步`, snapshot.pins.every((p) => p.marker?.stroke === 'none' && p.marker.opacity === 1 && p.marker.effectiveOpacity === 1 && p.marker.fillOpacity === 1 && p.marker.animationName === 'none' && Math.abs(p.marker.ring?.strokePixels - 0.64 * scale) <= 0.05 && (p.markerState === 'online' ? green(p.marker.ring?.strokeColor) : red(p.marker.ring?.strokeColor))))
  check(`${tag}：在线绿芯、离线红芯短横线、部分离线绿芯红圈`, snapshot.pins.every((p) => p.markerState === 'offline' ? red(p.marker?.fillColor) && p.marker.detail?.tag === 'path' && p.marker.detail.d?.length > 5 && p.marker.detail.w > 1 && p.marker.detail.h <= 0.2 : green(p.marker?.fillColor) && !p.marker.detail && (p.markerState !== 'mixed' || red(p.marker.ring?.strokeColor))))
  check(`${tag}：光晕渐隐且非在线状态没有呼吸动画`, snapshot.pins.every((p) => p.marker?.halo?.stops.length >= 3 && p.marker.halo.stops.at(-1).opacity === 0 && (p.markerState === 'online' ? green(p.marker.halo.stops[0].color) : red(p.marker.halo.stops[0].color) && p.marker.halo.animationName === 'none')))
  check(`${tag}：title说明真实在线/离线状态与台数`, snapshot.pins.every((p) => p.count > 1 ? new RegExp(`在线\\s*${p.count - p.offlineCount}\\s*台`).test(p.title) && new RegExp(`离线\\s*${p.offlineCount}\\s*台`).test(p.title) : p.title?.includes(p.offlineCount ? '离线' : '在线') && p.offlineCount === Number(!nodes.find((node) => node.id === p.id)?.online)))
  const online = snapshot.pins.find((p) => p.markerState === 'online')?.marker
  const offline = snapshot.pins.find((p) => p.markerState === 'offline')?.marker
  if (online && offline) check(`${tag}：在线与离线有颜色和短横线双重区别`, online.fill !== offline.fill && !online.detail && !!offline.detail, `${online.fill} ↔ ${offline.fill}`)
  if (snapshot.selected) check(`${tag}：选中地区不会盖住节点状态图形`, snapshot.markersAboveSelection)
}

async function beaconMotionChecks(tag, active) {
  await clearPointer()
  await evaluate(() => { window.__mapBeaconNodes = new Map([...document.querySelectorAll('svg[data-map-canvas] .hit')].map((hit) => [Number(hit.dataset.node), hit.parentElement.querySelector('.globe-pin-halo')])) })
  const samples = [await state(`${tag}:pulse-0`)]
  for (let i = 1; i <= 4; i++) { await sleep(300); samples.push(await state(`${tag}:pulse-${i}`)) }
  const common = samples[0].pins.filter((pin) => samples.every((sample) => sample.pins.some((candidate) => candidate.id === pin.id && candidate.markerState === pin.markerState)))
  const series = (pin) => samples.map((sample) => sample.pins.find((candidate) => candidate.id === pin.id).marker)
  const spread = (values) => Math.max(...values) - Math.min(...values)
  const online = common.filter((pin) => pin.markerState === 'online')
  const steady = common.filter((pin) => pin.markerState !== 'online')
  check(`${tag}：呼吸总门控符合实际状态`, samples.every((sample) => sample.pulse === String(active)), samples.map((sample) => sample.pulse).join(' / '))
  check(`${tag}：所有核心始终常亮，呼吸不改核心和外圈`, common.length > 0 && common.every((pin) => series(pin).every((marker) => marker?.opacity === 1 && marker.effectiveOpacity === 1 && marker.fillOpacity === 1) && spread(series(pin).map((marker) => marker.ring.effectiveOpacity)) <= 0.001))
  check(`${tag}：在线光晕${active ? '实际轻微呼吸' : '实际静止'}`, online.length > 0 && online.every((pin) => {
    const halos = series(pin).map((marker) => marker.halo)
    const delta = spread(halos.map((halo) => halo?.effectiveOpacity))
    return active ? delta > 0.025 && halos.every((halo) => halo.animationName !== 'none' && halo.animationPlayState === 'running' && halo.opacity >= 0.35 && halo.opacity <= 0.8) : delta <= 0.001 && halos.every((halo) => halo.animationName === 'none' || halo.animationPlayState === 'paused')
  }), online.map((pin) => `${pin.id}:${spread(series(pin).map((marker) => marker.halo?.effectiveOpacity)).toFixed(3)}`).join(' | '))
  if (steady.length) check(`${tag}：离线和部分离线光晕不呼吸`, steady.every((pin) => spread(series(pin).map((marker) => marker.halo?.effectiveOpacity)) <= 0.001 && series(pin).every((marker) => marker.halo.animationName === 'none')))
  check(`${tag}：跨重画保留光晕DOM，呼吸不会每帧重启`, await evaluate((ids) => ids.every((id) => window.__mapBeaconNodes.get(id) === document.querySelector(`svg[data-map-canvas] .hit[data-node="${id}"]`)?.parentElement.querySelector('.globe-pin-halo')), common.map((pin) => pin.id)))
}

async function beaconGateChecks() {
  await viewport(1440, 1000)
  await media(false)
  await preferences('2d', '0')
  for (const selectedMode of ['2d', '3d']) {
    await mode(selectedMode)
    await resetZoom()
    await evaluate(() => scrollTo(0, 0))
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'true')
    check(`${selectedMode}：呼吸独立于旋转暂停`, (await state()).spinning === 'false')
    await beaconMotionChecks(`${selectedMode}/旋转暂停仍呼吸`, true)
    await media(false, true)
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'false')
    await beaconMotionChecks(`${selectedMode}/reduce-motion`, false)
    await media(false)
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'true')
    await evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'false')
    await beaconMotionChecks(`${selectedMode}/后台`, false)
    await evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'true')
    await evaluate(() => { const space = document.createElement('div'); space.style.height = '2500px'; document.body.append(space); scrollTo(0, document.documentElement.scrollHeight) })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'false')
    await beaconMotionChecks(`${selectedMode}/离屏`, false)
    await evaluate(() => scrollTo(0, 0))
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.markerPulse === 'true')
    await beaconMotionChecks(`${selectedMode}/门控恢复`, true)
  }
}
async function physicalControl(key) {
  const target = await evaluate((key) => {
    const button = key.startsWith('mode-') || key === 'spin' ? document.querySelector(`[data-map-control="${key}"]`) : document.querySelector(`.globe-controls button[aria-label="${key}"]`)
    if (!button || button.disabled) return null
    const r = button.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, key)
  if (!target) throw new Error(`找不到实际可点击的控件：${key}`)
  await clickAt(target)
}
async function hoverNode(tag, preferred = 4, exact = false) {
  await clearPointer()
  const before = await state(`${tag}:hover-before`)
  const target = await pinTarget(preferred, exact)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await waitFor((selector) => !!document.querySelector(selector)?.getBoundingClientRect().width, NODE_UI.tooltip)
  await sleep(250)
  const hovered = await state(`${tag}:hover-active`)
  const ui = await nodeUi(`${tag}:tooltip`)
  const node = nodes.find((n) => n.id === target.id)
  check(`${tag}：真实悬停命中节点并有完整无障碍名称`, node && (target.count > 1 ? target.title?.includes(`×${target.count}`) && new RegExp(`在线\\s*${target.count - target.offlineCount}\\s*台`).test(target.title) && new RegExp(`离线\\s*${target.offlineCount}\\s*台`).test(target.title) : target.title?.includes(node.name)) && await evaluate((id) => document.querySelector(`svg[data-map-canvas] [data-node="${id}"]`)?.matches(':hover'), target.id), `${target.id}:${target.title}`)
  const beforePin = before.pins.find((pin) => pin.id === target.id), activePin = hovered.pins.find((pin) => pin.id === target.id)
  check(`${tag}：只有当前信标实际放大约1.25倍`, beforePin && activePin && Math.abs(activePin.marker.w / beforePin.marker.w - 1.25) <= 0.04 && hovered.pins.filter((pin) => pin.id !== target.id).every((pin) => Math.abs(pin.marker.w - before.pins.find((old) => old.id === pin.id)?.marker.w) <= 0.2), `core ${beforePin?.marker?.w.toFixed(2)}→${activePin?.marker?.w.toFixed(2)}px`)
  check(`${tag}：悬停只放大可见信标，不改变透明命中区域`, beforePin && activePin && Math.abs(activePin.hitBox.w - beforePin.hitBox.w) <= 0.2 && Math.abs(activePin.hitBox.h - beforePin.hitBox.h) <= 0.2)
  check(`${tag}：悬停内容有tooltip语义且不会导航`, ui.tooltip?.role === 'tooltip' && ui.path === '/' && await evaluate((id) => {
    const trigger = document.querySelector(`svg[data-map-canvas] .hit[data-node="${id}"]`)
    return trigger?.getAttribute('aria-describedby')?.split(' ').some((descriptionId) => document.getElementById(descriptionId)?.getAttribute('role') === 'tooltip')
  }, target.id))
  memberChecks(`${tag}/tooltip`, ui.tooltip?.members, expectedMembers(target))
  check(`${tag}：Tooltip只显示节点、状态与计数，不含操作提示`, ui.tooltip && !/(点击|请选择|选择要|查看详情|click|tap|press|select a node)/i.test(`${ui.tooltip.text} ${ui.tooltip.accessibleName || ''}`), ui.tooltip?.text)
  uiBoundsChecks(tag, ui, 'tooltip')
  await screenshot(`hover-${tag.replaceAll('/', '-')}`)
  await clearPointer()
  const restored = await state(`${tag}:hover-restored`)
  check(`${tag}：离开恢复信标大小并移除悬停内容`, !(await nodeUi()).tooltip?.visible && restored.pins.every((pin) => Math.abs(pin.marker.w - before.pins.find((old) => old.id === pin.id)?.marker.w) <= 0.2))
  return target
}
async function openNodeAndReturn(tag, target, selectedMode) {
  const node = nodes.find((n) => n.id === target.id)
  if (target.count > 1) {
    await openChoice(`${tag}/同地点选择`, target.id)
    await chooseMember(tag, target.id)
  } else await clickAt(target)
  await waitFor((id, name) => location.pathname === `/node/${id}` && document.querySelector('h2')?.textContent === name, target.id, node.name)
  check(`${tag}：无侧边名称后真实点针仍打开正确节点`, await evaluate(() => !!document.querySelector('main')))
  await evaluate(() => [...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === '地图控件验收')?.click())
  await ready()
  await waitFor((count) => document.querySelectorAll('[data-slot="card"] h3').length === count, nodes.length)
  check(`${tag}：详情返回保留地图模式与全部节点`, (await state()).mode === selectedMode)
  await evaluate(() => scrollTo(0, 0))
}
async function returnHome(selectedMode) {
  await evaluate(() => [...document.querySelectorAll('header button')].find((button) => button.textContent.trim() === '地图控件验收')?.click())
  await ready()
  await waitFor((count) => document.querySelectorAll('[data-slot="card"] h3').length === count, nodes.length)
  await evaluate(() => scrollTo(0, 0))
  await clearPointer()
  check(`${selectedMode}：返回首页保持地图模式`, (await state()).mode === selectedMode)
}
async function focusPin(id) {
  const focused = await evaluate((id) => {
    const pin = document.querySelector(`svg[data-map-canvas] .hit[data-node="${id}"]`)
    pin?.focus({ preventScroll: true })
    return pin && document.activeElement === pin && pin.getAttribute('role') === 'button' && pin.tabIndex === 0 && !pin.closest('svg').hasAttribute('aria-hidden')
  }, id)
  check(`节点${id}：地图针有可聚焦按钮语义且SVG未隐藏`, focused)
  if (!focused) throw new Error(`节点不可通过键盘聚焦：${id}`)
}
async function openChoice(tag, id = 401, activation = 'mouse') {
  await clearPointer()
  const target = await pinTarget(id, true)
  if (target.count < 2) throw new Error(`选择夹具必须聚合：${id}`)
  if (activation === 'Enter' || activation === ' ') {
    await focusPin(id)
    await keyPress(activation)
  } else if (activation === 'AT') {
    await evaluate((id) => document.querySelector(`svg[data-map-canvas] .hit[data-node="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })), id)
    await sleep(200)
  } else await clickAt(target, activation === 'touch')
  await waitFor((selector) => !!document.querySelector(selector), NODE_UI.dialog)
  const ui = await nodeUi(`${tag}:dialog`)
  check(`${tag}：聚合激活先打开选择框，未自动进入第一台`, ui.path === '/' && ui.dialog?.role === 'dialog' && ui.dialog.labelledBy && !target.title.includes('第一台'))
  check(`${tag}：模态选择框接管焦点且后台不可交互`, ui.dialogFocused && ui.backgroundHidden && ui.overlayEvents !== 'none', JSON.stringify({ focused: ui.focused, dialogFocused: ui.dialogFocused, backgroundHidden: ui.backgroundHidden, overlayEvents: ui.overlayEvents }))
  memberChecks(`${tag}/选择框`, ui.dialog?.members, expectedMembers(target))
  uiBoundsChecks(tag, ui, 'dialog')
  return target
}
async function dismissChoice(tag, mechanism, pinId = 401) {
  if (mechanism === 'Escape') await keyPress('Escape')
  else if (mechanism === 'close') await clickAt(await actualTarget(NODE_UI.close))
  else {
    const outside = await evaluate((selector) => {
      const overlay = document.querySelector(selector)
      for (const [x, y] of [[2, 2], [innerWidth - 2, 2], [2, innerHeight - 2]]) {
        const hit = document.elementFromPoint(x, y)
        if (overlay && (hit === overlay || overlay.contains(hit))) return { x, y }
      }
      return null
    }, NODE_UI.overlay)
    if (!outside) throw new Error('没有可实际点击的选择框外侧遮罩')
    await clickAt(outside)
  }
  await waitFor((selector) => !document.querySelector(selector), NODE_UI.dialog)
  const ui = await nodeUi(`${tag}:dismissed`)
  check(`${tag}：${mechanism}关闭选择框且不导航`, !ui.dialog && ui.path === '/')
  check(`${tag}：关闭后焦点返回原地图针`, await evaluate((id) => document.activeElement === document.querySelector(`svg[data-map-canvas] .hit[data-node="${id}"]`), pinId))
  await clearPointer()
}
const optionSelector = (id) => `${NODE_UI.option.slice(0, -1)}="${id}"]`
async function chooseMember(tag, id, activation = 'mouse') {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`选择的节点不在当前夹具：${id}`)
  const selector = optionSelector(id)
  const target = await actualTarget(selector)
  if (activation === 'Enter' || activation === ' ') {
    await evaluate((selector) => document.querySelector(selector).focus({ preventScroll: true }), selector)
    await keyPress(activation)
  } else await clickAt(target, activation === 'touch')
  await waitFor((id, name) => location.pathname === `/node/${id}` && document.querySelector('h2')?.textContent === name, id, node.name)
  check(`${tag}：选择${node.online ? '非首在线' : '离线'}成员打开准确详情`, await evaluate((id) => location.pathname === `/node/${id}` && !!document.querySelector('main'), id), `${id}:${node.name}`)
}
async function singleActivationChecks() {
  nodes = [makeNode(701, 'Tokyo 单节点键盘', 'JP', '交互'), makeNode(702, 'Frankfurt 离线键盘', 'DE', '交互', false), makeNode(703, 'Singapore 单节点', 'SG', '交互')]
  await viewport(360, 780)
  for (const selectedMode of ['2d', '3d']) for (const dark of [false, true]) {
    const tag = `单针/${selectedMode}/360/${dark ? '暗' : '亮'}`
    await media(dark)
    await preferences(selectedMode, '0')
    await hoverNode(tag, 701, true)
    for (const [activation, id] of [['Enter', 701], [' ', 702], ['touch', 702], ['AT', 701]]) {
      await clearPointer()
      if (activation === 'touch') await clickAt(await pinTarget(id, true), true)
      else if (activation === 'AT') await evaluate((id) => document.querySelector(`svg[data-map-canvas] .hit[data-node="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })), id)
      else { await focusPin(id); await keyPress(activation) }
      const expected = nodes.find((node) => node.id === id)
      await waitFor((id, name) => location.pathname === `/node/${id}` && document.querySelector('h2')?.textContent === name, id, expected.name)
      check(`${tag}：${activation === ' ' ? 'Space' : activation}直接打开准确单节点且不显示选择框`, !(await nodeUi()).dialog && await evaluate((id) => location.pathname === `/node/${id}`, id))
      await returnHome(selectedMode)
    }
    await clearPointer()
    const cancelled = await pinTarget(701, true)
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cancelled.x, y: cancelled.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] })
    await sleep(80)
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cancelled.x, y: cancelled.y - 55, id: 1, radiusX: 2, radiusY: 2, force: 1 }] })
    await send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await sleep(250)
    await evaluate(() => scrollTo(0, 0))
    const cancelState = await state()
    check(`${tag}：针上竖滑touchCancel不打开详情或选择框且结束drag`, cancelState.drag === 'false' && (await nodeUi()).path === '/' && !(await nodeUi()).dialog)
    const prior = await evaluate(() => {
      const wanted = document.querySelector('svg[data-map-canvas] .hit[data-node="701"]')
      const tabbable = [...document.querySelectorAll('button,input,a[href],[tabindex]')].filter((element) => element.tabIndex >= 0 && !element.disabled && element.getBoundingClientRect().width > 0 && !element.closest('[aria-hidden="true"]'))
      const previous = tabbable[tabbable.indexOf(wanted) - 1]
      previous?.focus({ preventScroll: true })
      return !!previous && document.activeElement === previous
    })
    if (!prior) throw new Error('找不到地图第一枚针的前一个Tab焦点')
    await keyPress('Tab')
    await waitFor((selector) => !!document.querySelector(selector), NODE_UI.tooltip)
    await sleep(250)
    const afterTab = await state(`${tag}:touch-cancel-tab`), tabUi = await nodeUi(`${tag}:touch-cancel-tooltip`)
    check(`${tag}：touchCancel后真实Tab回同针仍放大并显示Tooltip`, await evaluate(() => document.activeElement === document.querySelector('svg[data-map-canvas] .hit[data-node="701"]') && document.activeElement.matches(':focus-visible')) && Math.abs(afterTab.pins.find((pin) => pin.id === 701)?.marker?.w - 8) <= 0.2 && tabUi.tooltip?.visible)
    memberChecks(`${tag}/touchCancel后键盘提示`, tabUi.tooltip?.members, nodes.filter((node) => node.id === 701))
    await clearPointer()
  }
}
async function nodeInteractionChecks() {
  const ordinaryNodes = nodes
  for (const [width, height] of TOUCH_ONLY ? [[320, 720]] : [[1440, 1000], [320, 720]]) {
    await viewport(width, height)
    for (const selectedMode of TOUCH_ONLY ? ['2d'] : ['2d', '3d']) for (const dark of TOUCH_ONLY ? [false] : [false, true]) {
      nodes = interactionNodes()
      const tag = `聚合交互/${selectedMode}/${width}/${dark ? '暗' : '亮'}`
      await media(dark)
      await preferences(selectedMode, '0')
      await waitFor(() => document.querySelectorAll('svg[data-map-canvas] .hit').length === 3)
      await resetZoom()
      await hoverNode(tag, 401, true)
      for (const mechanism of ['Escape', 'close', 'outside']) {
        await openChoice(`${tag}/${mechanism}`)
        if (mechanism === 'Escape') await screenshot(`node-choice-${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
        await dismissChoice(tag, mechanism)
      }
      await openChoice(`${tag}/detail=0合成点击`, 401, 'AT')
      await dismissChoice(`${tag}/detail=0合成点击`, 'Escape')
      for (const id of [402, 404]) {
        await openChoice(`${tag}/鼠标选择${id}`)
        await chooseMember(tag, id)
        await returnHome(selectedMode)
      }
      for (const [activation, id] of [['Enter', 402], [' ', 404]]) {
        const key = activation === ' ' ? 'Space' : activation
        await openChoice(`${tag}/${key}`, 401, activation)
        await chooseMember(`${tag}/${key}`, id, activation)
        await returnHome(selectedMode)
      }
      if (width <= 360) {
        await openChoice(`${tag}/触屏`, 401, 'touch')
        await chooseMember(`${tag}/触屏`, 404, 'touch')
        await returnHome(selectedMode)
      }
      for (const touch of width <= 360 ? [false, true] : [false]) {
        await resetZoom()
        if (selectedMode === '2d') await zoom('End')
        await clearPointer()
        const before = await state()
        await dragFrom(await pinTarget(selectedMode === '2d' ? 501 : 401, true), 32, 3, touch)
        const after = await state(`${tag}:${touch ? 'touch' : 'mouse'}-pin-drag`), ui = await nodeUi()
        check(`${tag}：${touch ? '触屏' : '鼠标'}从针起手拖动不误开选择框或详情`, geometry(before) !== geometry(after) && after.drag === 'false' && ui.path === '/' && !ui.dialog)
        await region('JP')
        await allRegions()
      }
      await screenshot(`node-interactions-${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
    }
  }

  if (TOUCH_ONLY) { nodes = ordinaryNodes; await navigate(); return }

  nodes = interactionNodes()
  await viewport(360, 780)
  await media(true)
  await preferences('2d', '0')
  await openChoice('实时列表/修改前')
  const removedName = nodes.find((node) => node.id === 405).name
  nodes = nodes.filter((node) => node.id !== 405).map((node) => node.id === 402 ? { ...node, name: 'Tokyo 实时改名节点' } : node.id === 404 ? { ...node, online: true } : node)
  await waitFor((selectors) => {
    const dialog = document.querySelector(selectors.dialog)
    const options = dialog?.querySelectorAll(selectors.option)
    return options?.length === 5 && dialog.querySelector('[data-map-node-option="402"] [data-map-node-name]')?.textContent === 'Tokyo 实时改名节点' && dialog.querySelector('[data-map-node-option="404"]')?.dataset.online === '1' && !dialog.querySelector('[data-map-node-option="405"]')
  }, NODE_UI)
  await waitFor((count) => document.querySelectorAll('[data-slot="card"] h3').length === count, nodes.length)
  const live = await nodeUi('实时列表/修改后'), map = await state('实时列表/针同步')
  memberChecks('实时列表/改名删除与上线', live.dialog?.members, nodes.filter((node) => node.country === 'JP'))
  check('实时列表：移除删除成员、保留HTML字面名称、地图计数同步', !live.dialog.text.includes(removedName) && !live.dialog.injected && live.xss === null && map.pins.find((pin) => pin.id === 401)?.count === 5 && map.pins.find((pin) => pin.id === 401)?.offlineCount === 1 && map.cards.includes('Tokyo 实时改名节点') && !map.cards.includes(removedName))
  await screenshot('node-choice-live-updated')
  await dismissChoice('实时列表', 'Escape')
  await hoverNode('实时列表/tooltip同步', 401, true)
  await openChoice('实时列表/全部移除前')
  nodes = nodes.filter((node) => node.country !== 'JP')
  await waitFor((selector) => !document.querySelector(selector), NODE_UI.dialog)
  await waitFor(() => !document.querySelector('svg[data-map-canvas] .hit[data-region^="JP"]'))
  check('实时删除整个地区后关闭旧选择框且不导航', (await nodeUi()).path === '/' && !(await nodeUi()).dialog)

  nodes = interactionNodes()
  await viewport(1440, 1000)
  await media(false)
  await preferences('3d', '1')
  await clearPointer()
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  const target = await pinTarget(401, true)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'false')
  await stable('悬停暂时冻结3D岸线和扫掠，旋转偏好保留')
  check('悬停不改旋转偏好', (await state()).spin === 'true')
  await clearPointer()
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  await openChoice('旋转中聚合选择')
  await stable('选择框期间3D岸线和扫掠冻结')
  check('选择框不改旋转偏好', (await state()).spin === 'true')
  await dismissChoice('旋转中聚合选择', 'Escape')
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  await stable('退出节点交互后3D旋转恢复', true)
  await singleActivationChecks()
  nodes = ordinaryNodes
  await navigate()
}
async function locateSmallGroup(group) {
  await allRegions() // 清掉上一个筛选；点同一地区会取消筛选，不能当作再次定位。
  const found = await evaluate((code, city) => {
    const row = [...document.querySelectorAll('.globe-reg:not(.globe-reg-all)')].find((button) => button.dataset.regionCode === code && button.querySelector('span')?.textContent.trim() === city)
    row?.click()
    return !!row
  }, group.code, group.city)
  if (!found) throw new Error(`小队夹具缺少地区：${group.code}/${group.city}`)
  await sleep(250)
}
async function neighboringHoverChecks(tag) {
  await clearPointer()
  const before = await state(`${tag}:neighbor-before`)
  const centers = new Map([841, 842].map((id) => {
    const pin = before.pins.find((candidate) => candidate.id === id)
    return [id, pin?.marker && { x: pin.marker.x + pin.marker.w / 2, y: pin.marker.y + pin.marker.h / 2 }]
  }))
  for (const id of [841, 842, 841]) {
    const center = centers.get(id)
    if (!center) throw new Error(`连续悬停夹具缺少近城市针：${id}`)
    // 不移远、不blur，模拟指针直接跨过两个城市的最近中心分界。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center })
    await sleep(500)
    const ui = await nodeUi(`${tag}:continuous-${id}`), current = await state(`${tag}:continuous-marker-${id}`)
    const actual = await evaluate(({ x, y }) => Number(document.elementFromPoint(x, y)?.closest('.hit[data-node]')?.dataset.node), center)
    check(`${tag}：连续移入${id}真实命中自身且Tooltip立即切换`, actual === id && ui.tooltip?.visible && ui.tooltip.members.length === 1 && ui.tooltip.members[0].id === id, `hit=${actual}, tooltip=${ui.tooltip?.members?.map((member) => member.id).join(',') ?? 'none'}`)
    check(`${tag}：连续悬停仅放大当前${id}，邻针恢复`, [841, 842].every((wanted) => {
      const marker = current.pins.find((pin) => pin.id === wanted)?.marker, old = before.pins.find((pin) => pin.id === wanted)?.marker
      return marker && old && Math.abs(marker.w / old.w - (wanted === id ? 1.25 : 1)) <= 0.04
    }), current.pins.filter((pin) => [841, 842].includes(pin.id)).map((pin) => `${pin.id}:${pin.marker?.w.toFixed(2)}`).join(' | '))
    memberChecks(`${tag}/连续悬停${id}`, ui.tooltip?.members, nodes.filter((node) => node.id === id))
    await screenshot(`neighbor-hover-${tag.replaceAll('/', '-')}-${id}`)
  }
  await clearPointer()
}
async function smallLocationChecks() {
  const ordinaryNodes = nodes
  for (const [width, height] of [[1440, 1000], [320, 720]]) {
    await viewport(width, height)
    for (const selectedMode of ['2d', '3d']) for (const dark of [false, true]) {
      nodes = smallLocationNodes()
      const tag = `小队10台/${selectedMode}/${width}/${dark ? '暗' : '亮'}`
      await media(dark)
      await preferences(selectedMode, '0')
      await resetZoom()
      const initial = await state(`${tag}:default`)
      if (selectedMode === '2d') {
        check(`${tag}：HK3、Singapore2、LA2各一信标，同国不同城市保持独立`, initial.pins.length === 6 && smallLocationGroups.every((group) => {
          const pins = initial.pins.filter((pin) => group.ids.includes(pin.id))
          return pins.length === 1 && pins[0].count === group.ids.length
        }), initial.pins.map((pin) => `${pin.id}×${pin.count}`).join(' | '))
        check(`${tag}：所有10台成员完整保留，没有同地点重复hit或丢成员`, JSON.stringify(initial.pins.flatMap((pin) => expectedMembers(pin).map((node) => node.id)).sort((a, b) => a - b)) === JSON.stringify(nodes.map((node) => node.id).sort((a, b) => a - b)) && new Set(initial.pins.map((pin) => pin.key)).size === initial.pins.length)
      }
      await neighboringHoverChecks(tag)
      if (NEIGHBORS_ONLY) continue
      for (const id of [841, 842]) {
        await clearPointer()
        const snapshot = await state(`${tag}:near-city-${id}`), pin = snapshot.pins.find((candidate) => candidate.id === id)
        const center = pin?.marker && { x: pin.marker.x + pin.marker.w / 2, y: pin.marker.y + pin.marker.h / 2 }
        const actual = center && await evaluate(({ x, y }) => Number(document.elementFromPoint(x, y)?.closest('.hit[data-node]')?.dataset.node), center)
        check(`${tag}：近城市${id}真实核心中心命中自身，未被另一城市截走`, pin?.count === 1 && actual === id, `center=${JSON.stringify(center)}, hit=${actual}`)
        await hoverNode(`${tag}/近城市${id}`, id, true)
        await clickAt(await pinTarget(id, true), width <= 360)
        const node = nodes.find((candidate) => candidate.id === id)
        await waitFor((id, name) => location.pathname === `/node/${id}` && document.querySelector('h2')?.textContent === name, id, node.name)
        check(`${tag}：近城市${id}分别激活准确详情且不打开聚合选择`, (await nodeUi()).path === `/node/${id}` && !(await nodeUi()).dialog)
        await preferences(selectedMode, '0')
      }
      for (const group of smallLocationGroups.filter((item) => item.ids.length > 1)) {
        const pointTag = `${tag}/${group.city}`
        await locateSmallGroup(group)
        await resetZoom()
        const before = await state(`${pointTag}:100`)
        const locationPins = before.pins.filter((pin) => group.ids.includes(pin.id))
        check(`${pointTag}：不足旧门槛仍只有一处可见hit与信标，台数准确`, locationPins.length === 1 && locationPins[0].count === group.ids.length && locationPins[0].marker?.beacon, locationPins.map((pin) => `${pin.id}×${pin.count}`).join(' | '))
        layoutChecks(`${pointTag}/100%`, before)
        await hoverNode(`${pointTag}/100%`, group.ids[0], true)
        for (const [key, percent] of [['Home', 50], ['End', 150]]) {
          await zoom(key)
          const snapshot = await state(`${pointTag}:${percent}`)
          check(`${pointTag}/${percent}%：缩放不导航、不拖动且目标地点只有一枚针`, snapshot.zoom === percent && snapshot.drag === 'false' && (await nodeUi()).path === '/' && snapshot.pins.filter((pin) => group.ids.includes(pin.id)).length === 1)
          layoutChecks(`${pointTag}/${percent}%`, snapshot)
          await hoverNode(`${pointTag}/${percent}%`, group.ids[0], true)
        }
        await resetZoom()
        // 每一名成员都实际选择，尤其非首台及离线台；不能只验证Dialog列出了名字。
        for (const id of group.ids) {
          await locateSmallGroup(group)
          await openChoice(`${pointTag}/成员${id}`, group.ids[0], width <= 360 ? 'touch' : 'mouse')
          if (id === group.ids[0]) await screenshot(`small-choice-${selectedMode}-${width}-${dark ? 'dark' : 'light'}-${group.city.replaceAll(' ', '-')}`)
          await chooseMember(pointTag, id, width <= 360 ? 'touch' : 'mouse')
          await preferences(selectedMode, '0') // 重载清除地区筛选，下一名成员重新定位，避免沿用旧相机。
          check(`${pointTag}：详情返回首页保持地图模式`, (await state()).mode === selectedMode && (await nodeUi()).path === '/')
        }
      }
      await screenshot(`small-locations-${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
    }
  }
  nodes = ordinaryNodes
  await navigate()
}
async function mobileLayoutChecks() {
  if (!BASELINE_DIST) throw new Error('mobile-layout 需要 MAP_BASELINE_DIST，避免未比较旧版留白就宣称改善')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__mapResizeErrors = []; window.addEventListener("error", event => { if (/ResizeObserver loop/i.test(event.message)) window.__mapResizeErrors.push(event.message) })' })
  nodes = smallLocationNodes()
  const sizes = [[320, 720], [360, 780], [390, 844], [430, 900]]
  for (const [width, height] of sizes) {
    await viewport(width, height)
    await media(false)
    for (const selectedMode of ['2d', '3d']) {
      await preferences(selectedMode, '0')
      for (const [key, percent] of [[null, 100], ['Home', 50], ['End', 150]]) {
        if (key) await zoom(key)
        const snapshot = await state(`baseline-mobile-${selectedMode}-${width}-${percent}`)
        if (!snapshot.projection || snapshot.zoom !== percent || snapshot.mode !== selectedMode || snapshot.viewportWidth !== width || snapshot.dark) throw new Error(`旧版手机基准无效：${selectedMode}/${width}/${percent}`)
        baseline.set(`${selectedMode}-${width}-${percent}`, snapshot)
        if (percent === 100) await screenshot(`baseline-mobile-${selectedMode}-${width}`)
      }
    }
  }
  servingDist = DIST
  for (const [width, height] of sizes) {
    await viewport(width, height)
    for (const selectedMode of ['2d', '3d']) for (const dark of [false, true]) {
      await media(dark)
      await preferences(selectedMode, '0')
      const tag = `手机紧凑/${selectedMode}/${width}/${dark ? '暗' : '亮'}`
      for (const [key, percent] of [[null, 100], ['Home', 50], ['End', 150]]) {
        if (key) await zoom(key)
        const snapshot = await state(`${tag}:${percent}`)
        check(`${tag}/${percent}%：模式、主题与视口准确，缩放未导航或拖动`, snapshot.mode === selectedMode && snapshot.dark === dark && snapshot.viewportWidth === width && snapshot.zoom === percent && snapshot.drag === 'false' && snapshot.spinning === 'false' && (await nodeUi()).path === '/')
        mobileWhitespaceChecks(`${tag}/${percent}%`, baseline.get(`${selectedMode}-${width}-${percent}`), snapshot)
        layoutChecks(`${tag}/${percent}%`, snapshot)
        await sleep(450)
        const settled = await state(`${tag}:${percent}:settled`)
        check(`${tag}/${percent}%：尺寸观察器收敛，画布与标签不持续来回变化`, Math.abs(settled.host.h - snapshot.host.h) <= 0.5 && Math.abs(settled.host.w - snapshot.host.w) <= 0.5 && settled.viewBox === snapshot.viewBox && geometry(settled) === geometry(snapshot) && JSON.stringify(settled.memberLabels) === JSON.stringify(snapshot.memberLabels) && JSON.stringify(settled.memberStems) === JSON.stringify(snapshot.memberStems) && settled.resizeObserverErrors.length === 0, `height=${snapshot.host.h.toFixed(2)}→${settled.host.h.toFixed(2)}, viewBox=${snapshot.viewBox}, errors=${JSON.stringify(settled.resizeObserverErrors)}`)
        if (percent === 100 || width === 320) await screenshot(`compact-mobile-${selectedMode}-${width}-${dark ? 'dark' : 'light'}-${percent}`)
      }
      await resetZoom()
      await hoverNode(`${tag}/悬停`, 801, true)
      await openChoice(`${tag}/触屏选择`, 801, 'touch')
      await screenshot(`compact-mobile-choice-${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
      await chooseMember(`${tag}/触屏选择`, 802, 'touch')
      await returnHome(selectedMode)
      if (width === 390 && !dark) {
        await zoom('End')
        const before = await state()
        await touchDrag(45, 0)
        const dragged = await state(`${tag}:horizontal-touch`)
        check(`${tag}：减少盒高后横向触摸仍拖动地图且不误开详情`, geometry(before) !== geometry(dragged) && dragged.drag === 'false' && (await nodeUi()).path === '/')
        layoutChecks(`${tag}/触摸平移后`, dragged)
        await evaluate(() => scrollTo(0, 0))
        await touchDrag(0, -85)
        check(`${tag}：竖向触摸仍滚动页面并取消地图拖动`, await evaluate(() => scrollY > 10) && (await state()).drag === 'false' && (await state()).touchAction.includes('pan-y') && (await nodeUi()).path === '/')
        await evaluate(() => scrollTo(0, 0))
      }
    }
  }
}
function installRafGate() {
  let next = 0
  const callbacks = new Map()
  window.requestAnimationFrame = (callback) => { const id = ++next; callbacks.set(id, callback); return id }
  window.cancelAnimationFrame = (id) => callbacks.delete(id)
  window.__mapRafGate = { frame: (ahead = 80) => {
    const at = performance.now() + ahead
    const frame = [...callbacks.values()]
    callbacks.clear()
    for (const callback of frame) callback(at)
    return { at, callbacks: frame.length }
  } }
}
async function sweepPathCheck(tag, snapshot) {
  const { camera, globeProfile, graticule, sweepLonAt } = await import('../src/lib/globe.ts')
  const expectedLongitude = sweepLonAt(snapshot.sweepTime)
  check(`${tag}：扫掠逻辑时间与实际角度对应`, Number.isFinite(snapshot.sweepTime) && Number.isFinite(snapshot.sweepLongitude) && Math.abs(expectedLongitude - snapshot.sweepLongitude) < 1e-6, `time=${snapshot.sweepTime}, longitude=${snapshot.sweepLongitude}`)
  const expected = graticule(camera(snapshot.cameraLongitude, snapshot.cameraLatitude, snapshot.cameraView), globeProfile('medium'), expectedLongitude).filter((wire) => wire.sweep >= 0).map((wire) => wire.d)
  const actual = snapshot.paths.filter((wire) => wire.kind === 'globe-sweep').map((wire) => wire.d)
  check(`${tag}：真实SVG扫掠路径匹配同一相机与逻辑角度`, Number.isFinite(snapshot.cameraLongitude) && Number.isFinite(snapshot.cameraLatitude) && expected.length > 0 && JSON.stringify(actual) === JSON.stringify(expected), `paths=${actual.length}/${expected.length}`)
}
async function continuityCase(name, pause, resume) {
  await pause()
  const before = await state(`${name}:paused`)
  const wallStart = await evaluate(() => Date.now())
  await sleep(4000)
  const frozen = await state(`${name}:after-4s`)
  const wallElapsed = await evaluate(() => Date.now()) - wallStart
  check(`${name}：暂停4秒逻辑时间和真实路径均冻结`, wallElapsed >= 3900 && before.spinning === 'false' && frozen.spinning === 'false' && frozen.sweepTime === before.sweepTime && geometry(frozen) === geometry(before), `wall=${wallElapsed}ms, logical=${frozen.sweepTime - before.sweepTime}ms`)
  await resume()
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  const resumed = await state(`${name}:before-first-frame`)
  check(`${name}：恢复前不补暂停时间`, resumed.sweepTime === frozen.sweepTime, `logical=${resumed.sweepTime - frozen.sweepTime}ms`)
  const frame = await evaluate(() => window.__mapRafGate.frame(80))
  await waitFor((time) => Number(document.querySelector('svg[data-map-canvas]')?.dataset.sweepTime) > time, frozen.sweepTime)
  const after = await state(`${name}:first-frame`)
  const delta = after.sweepTime - frozen.sweepTime
  check(`${name}：恢复首个短帧连续，不追赶4秒墙上时间`, frame.callbacks > 0 && delta > 0 && delta < 500, `firstFrame=${delta.toFixed(2)}ms, wallPause=${wallElapsed}ms`)
  await sweepPathCheck(name, after)
}
async function sweepContinuity() {
  await navigate() // 重新载入正常存储上下文，移除前面故意拒绝Storage的当前文档。
  const gate = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installRafGate.toString()})()` })
  await viewport(1440, 1000)
  await media(false)
  await preferences('3d', '1')
  await evaluate(() => window.__mapRafGate.frame(80))
  await sleep(100)
  await sweepPathCheck('连续性基准', await state('sweep-controlled-baseline'))
  await continuityCase('手动暂停恢复', () => control('spin'), () => control('spin'))
  await continuityCase('2D返回3D', () => mode('2d'), () => mode('3d'))
  let held
  await continuityCase('拖动暂停恢复', async () => {
    held = await evaluate(() => {
      const svg = document.querySelector('svg[data-map-canvas]'), disk = svg.querySelector('.globe-disk'), point = svg.createSVGPoint()
      point.x = Number(disk.getAttribute('cx'))
      point.y = Number(disk.getAttribute('cy')) - Number(disk.getAttribute('r')) + 14
      const p = point.matrixTransform(svg.getScreenCTM())
      return { x: p.x, y: p.y }
    })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...held, button: 'left', clickCount: 1 })
    held.x += 15
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...held, button: 'left', buttons: 1 })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'false')
  }, async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...held, button: 'left', clickCount: 1 })
    await sleep(120)
  })
  await continuityCase('地区定位重新开始', () => region('JP'), () => control('spin'))
  await allRegions()
  await continuityCase('离屏恢复', async () => {
    await evaluate(() => { const space = document.createElement('div'); space.style.height = '2500px'; document.body.append(space); scrollTo(0, document.documentElement.scrollHeight) })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'false')
  }, async () => {
    await evaluate(() => scrollTo(0, 0))
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  })
  await continuityCase('减弱动态效果恢复', () => media(false, true), () => media(false))
  await continuityCase('visibilitychange恢复', async () => {
    await evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'false')
  }, async () => {
    await evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  })
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: gate.identifier })
  await navigate()
}
async function aggregateMarkerChecks() {
  const ordinaryNodes = nodes
  nodes = [
    ...Array.from({ length: 5 }, (_, i) => makeNode(101 + i, `Tokyo 聚合${i + 1}`, 'JP', '聚合', i < 3)),
    ...Array.from({ length: 5 }, (_, i) => makeNode(201 + i, `Frankfurt 聚合${i + 1}`, 'DE', '聚合', false)),
    ...Array.from({ length: 5 }, (_, i) => makeNode(301 + i, `Singapore 聚合${i + 1}`, 'SG', '聚合')),
  ]
  await viewport(1440, 1000)
  await media(false)
  await preferences('2d', '0')
  await waitFor(() => document.querySelectorAll('svg[data-map-canvas] [data-node]').length === 3)
  for (const selectedMode of ['2d', '3d']) {
    await mode(selectedMode)
    for (const dark of [false, true]) {
      await media(dark)
      await clearPointer()
      const snapshot = await state(`markers-aggregate-${selectedMode}-${dark ? 'dark' : 'light'}`)
      const mixed = snapshot.pins.find((p) => p.id === 101)
      const offline = snapshot.pins.find((p) => p.id === 201)
      const online = snapshot.pins.find((p) => p.id === 301)
      renderingChecks(`聚合/${selectedMode}/${dark ? '暗' : '亮'}`, snapshot)
      check(`聚合/${selectedMode}/${dark ? '暗' : '亮'}：三种真实状态精确区分`, mixed?.count === 5 && mixed.offlineCount === 2 && mixed.markerState === 'mixed' && offline?.count === 5 && offline.offlineCount === 5 && offline.markerState === 'offline' && online?.count === 5 && online.offlineCount === 0 && online.markerState === 'online')
      check(`聚合/${selectedMode}/${dark ? '暗' : '亮'}：部分离线绿芯红圈，三种信标保持准确状态`, mixed?.marker?.tag === 'circle' && mixed.marker.core?.tag === 'circle' && mixed.marker.fill === online?.marker?.fill && offline?.marker?.tag === 'circle' && offline.marker.detail?.tag === 'path' && !mixed.marker.detail && mixed.marker.ring?.stroke === offline.marker.ring?.stroke && mixed.marker.ring?.stroke !== online.marker.ring?.stroke)
      if (selectedMode === '2d') await beaconMotionChecks(`聚合/${selectedMode}/${dark ? '暗' : '亮'}`, true)
      await hoverNode(`聚合/${selectedMode}/${dark ? '暗' : '亮'}`, 101)
      await screenshot(`markers-aggregate-${selectedMode}-${dark ? 'dark' : 'light'}`)
    }
    await region('JP')
    const selected = await state(`markers-selected-${selectedMode}`)
    check(`聚合/${selectedMode}：地区定位不会盖住部分离线核心`, selected.selected && selected.markersAboveSelection && selected.pins.find((p) => p.id === 101)?.marker?.core)
    await allRegions()
  }
  await mode('2d')
  await media(false)
  const before = (await state('markers-live-mixed-before')).pins.find((p) => p.id === 101)
  nodes = nodes.map((n) => n.country === 'JP' ? { ...n, online: true } : n)
  await waitFor(() => document.querySelector('svg[data-map-canvas] [data-node="101"]')?.dataset.markerState === 'online')
  const after = await state('markers-live-online-after')
  const online = after.pins.find((p) => p.id === 101)
  check('实时聚合由部分离线恢复全在线，红圈变绿圈且计数与title同步', before?.markerState === 'mixed' && before.marker?.core && online?.markerState === 'online' && online.marker?.tag === 'circle' && online.count === 5 && online.offlineCount === 0 && /在线\s*5\s*台/.test(online.title) && /离线\s*0\s*台/.test(online.title) && before.marker.fill === online.marker.fill && before.marker.ring?.stroke !== online.marker.ring?.stroke)
  markerChecks('实时聚合全在线', after)
  await screenshot('markers-aggregate-live-online')
  nodes = nodes.map((n) => n.country === 'JP' ? { ...n, online: false } : n)
  await waitFor(() => document.querySelector('svg[data-map-canvas] [data-node="101"]')?.dataset.markerState === 'offline')
  const allOffline = await state('markers-live-offline-after')
  const offline = allOffline.pins.find((p) => p.id === 101)
  check('实时聚合全离线改为红芯短横，title计数正确', offline?.markerState === 'offline' && offline.marker?.tag === 'circle' && offline.marker.detail?.tag === 'path' && offline.marker.fill !== online.marker.fill && offline.count === 5 && offline.offlineCount === 5 && /在线\s*0\s*台/.test(offline.title) && /离线\s*5\s*台/.test(offline.title))
  markerChecks('实时聚合全离线', allOffline)
  await screenshot('markers-aggregate-live-offline')
  nodes = ordinaryNodes
  await navigate()
}
function layoutChecks(tag, snapshot) {
  check(`${tag}：实际绘出陆地与定位点，3D名称仍保留`, snapshot.paths?.some((p) => p.kind === 'globe-land' && p.d.length > 100) && snapshot.pins.length > 0 && (snapshot.mode === '2d' || snapshot.nameLabels > 0))
  check(`${tag}：路径与命中坐标有限`, snapshot.paths.every((p) => !/NaN|Infinity/.test(p.d)) && snapshot.pins.every((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))))
  check(`${tag}：控件与页面不横向溢出`, !snapshot.overflow && snapshot.controls.filter((r) => r.visible).every((r) => r.x >= -1 && r.right <= snapshot.svg.x + snapshot.svg.w + 40 && r.h >= 20))
  check(`${tag}：标签未被画布裁切且未压底注`, snapshot.clipped.length === 0 && snapshot.captionOverlap.length === 0, [...snapshot.clipped, ...snapshot.captionOverlap].slice(0, 4).join(' | '))
  check(`${tag}：标签互不重叠`, snapshot.overlaps.length === 0, JSON.stringify(snapshot.overlaps.slice(0, 3)))
  renderingChecks(tag, snapshot)
  dockChecks(tag, snapshot)
}

try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  base = `http://127.0.0.1:${server.address().port}`
  const profile = join(OUT, 'chrome-profile')
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-proxy-server', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  chrome.on('error', (error) => { chromeError = error })
  let wsUrl
  for (let i = 0; i < 100 && !wsUrl; i++) {
    if (chromeError) throw chromeError
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((page) => page.type === 'page')?.webSocketDebuggerUrl
    } catch { /* 等待 Chrome 创建调试端口。 */ }
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
  if (BASELINE_DIST && !TARGETED) {
    await viewport(1440, 1000)
    await media(false)
    await navigate()
    await motion(false)
    for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [360, 780], [320, 720]]) {
      await viewport(width, height)
      for (const selectedMode of ['3d', '2d']) {
        await mode(selectedMode)
        await resetZoom()
        const snapshot = await state(`baseline-${selectedMode}-${width}`)
        if (!snapshot.projection || snapshot.zoom !== 100) throw new Error(`旧版尺寸基准无效：${selectedMode}/${width}`)
        baseline.set(`${selectedMode}-${width}`, snapshot)
      }
    }
    servingDist = DIST
    await preferences(null, null)
  }
  await viewport(1440, 1000)
  await media(false)
  await navigate()
  console.log(`本地夹具 ${base}；输出 ${OUT}`)
  if (MOBILE_LAYOUT_ONLY) await mobileLayoutChecks()
  if (!TARGETED) {
  const initial = await state('first-visit')
  check('首访默认 3D、旋转开启、两个模式按钮语义明确', initial.mode === '3d' && initial.spin === 'true' && initial.spinning === 'true' && await evaluate(() => document.querySelector('[data-map-control="mode-3d"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-map-control="mode-2d"]')?.getAttribute('aria-pressed') === 'false'))
  renderingChecks('首访3D', initial)
  await stable('默认旋转实际改变岸线与扫掠', true)
  await beaconMotionChecks('默认3D旋转', true)
  const configCalls = requests.filter((r) => r.path.endsWith('/config')).length
  await motion(false)
  await stable('关闭旋转后岸线与扫掠都停止')
  const beforeDrag = await state()
  await mouseDrag(65, 12)
  const afterDrag = await state()
  check('暂停期间仍可拖动3D，松手不误开节点', geometry(beforeDrag) !== geometry(afterDrag) && await evaluate(() => location.pathname === '/') && afterDrag.drag === 'false')
  await stable('暂停期间松手后无惯性或自动旋转')
  const frozen = await state()
  await media(true)
  await zoom('Home')
  check('滑条键盘缩小到50%，未抢地球拖拽', (await state()).zoom === 50 && (await state()).drag === 'false')
  await resetZoom()
  const restored = await state()
  check('暂停期间明暗与缩放重绘不推进扫掠时钟', restored.dark && restored.zoom === 100 && geometry(restored) === geometry(frozen))
  await send('Page.reload', { ignoreCache: true })
  await ready()
  check('刷新记住访客暂停偏好', (await state()).mode === '3d' && (await state()).spin === 'false')
  await stable('刷新后仍保持停止')
  await motion(true)
  await stable('重新开启后旋转实际恢复', true)

  await mode('2d')
  const flat = await state('2d-default')
  check('2D模式是真平面且无扫掠，保留旋转偏好', flat.mapFrame && !flat.globeDisk && flat.spin === 'true' && flat.spinDisabled && flat.spinning === 'false' && !flat.paths.some((p) => p.kind === 'globe-sweep'))
  renderingChecks('默认2D', flat)
  check('2D默认完整表示所有可定位成员，不画缺失国家的假针', JSON.stringify(flat.pins.flatMap((p) => expectedMembers(p).map((node) => node.id)).sort((a, b) => a - b)) === JSON.stringify(locatedIds), JSON.stringify(flat.pins.map((p) => ({ id: p.id, count: p.count }))))
  check('2D保留离线成员与地区离线提示', flat.pins.some((p) => p.id === 1 && p.count === 2 && p.offlineCount === 1 && p.markerState === 'mixed') && flat.rows.some((r) => r.code === 'JP' && r.count === 2 && r.offline && r.title.includes('1 台离线')))
  check('国家兜底显示全名、Unicode单引号城市正确、跨国城市不串落点', flat.rows.some((r) => r.code === 'FI' && r.text === 'Finland') && flat.rows.some((r) => r.code === 'CN' && r.text === "Xi'an") && flat.rows.some((r) => r.code === 'CN' && r.text === 'China') && flat.pins.some((p) => p.id === 13 && p.region === 'CN'))
  await stable('2D岸线与节点位置保持静止')
  check('地图按钮不额外请求站点配置', requests.filter((r) => r.path.endsWith('/config')).length === configCalls + 1)
  await send('Page.reload', { ignoreCache: true })
  await ready()
  check('刷新恢复2D及原旋转偏好，缩放回默认', (await state()).mode === '2d' && (await state()).spin === 'true' && (await state()).zoom === 100)
  await region('JP')
  const filtered = await state('2d-region-jp')
  check('2D地区按钮筛选同一批节点且定位标记可见', JSON.stringify(filtered.cards.sort()) === JSON.stringify(nodes.filter((n) => n.country === 'JP').map((n) => n.name).sort()) && await evaluate(() => !!document.querySelector('.globe-selected-core')))
  await mode('3d')
  check('切回3D保留地区筛选与暂停定位', (await state()).cards.length === 2 && (await state()).spinning === 'false')
  await stable('地区定位暂停包含扫掠')
  await motion(true)
  check('开始旋转解除定位暂停并保留地区筛选与标记', (await state()).spinning === 'true' && (await state()).cards.length === 2 && await evaluate(() => !!document.querySelector('.globe-selected-core')))
  await allRegions()
  await mode('2d')
  await zoom('End')
  const zoomed = await state()
  await mouseDrag(50, 18)
  const panned = await state()
  check('2D150%可鼠标平移，松手保持静止', zoomed.zoom === 150 && geometry(zoomed) !== geometry(panned) && panned.drag === 'false' && await evaluate(() => location.pathname === '/'))
  await stable('2D平移后没有惯性动画')
  await resetZoom()
  check('2D重置还原全图100%与全部地点成员', (await state()).zoom === 100 && (await state()).pins.reduce((sum, p) => sum + p.count, 0) === locatedIds.length)
  const pin = await evaluate(() => {
    const el = document.querySelector('svg[data-map-canvas] [data-node="4"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!pin) throw new Error('2D找不到可点击的Seattle针')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pin, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pin, button: 'left', clickCount: 1 })
  await waitFor(() => location.pathname === '/node/4' && document.querySelector('h2')?.textContent === 'Seattle 一号')
  check('2D真实鼠标点击针打开对应节点详情，未白屏', await evaluate(() => document.body.textContent.includes('Seattle 一号') && !!document.querySelector('main')))
  await evaluate(() => [...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === '地图控件验收')?.click())
  await ready()
  check('SPA返回首页保留2D偏好', (await state()).mode === '2d')
  const offlineMarker = (await state('small-pair-live-mixed-before')).pins.find((p) => p.id === 1)
  nodes = nodes.map((n) => n.id === 2 ? { ...n, online: true } : n)
  await waitFor(() => document.querySelector('svg[data-map-canvas] [data-node="1"]')?.dataset.markerState === 'online')
  const live = await state('small-pair-live-online-after')
  const onlineMarker = live.pins.find((p) => p.id === 1)
  check('节点恢复在线后2D针与地区离线提示同步更新', !live.rows.find((r) => r.code === 'JP')?.offline)
  check('两台同地点离线成员上线后由绿芯红圈变绿圈，计数与title同步', offlineMarker?.markerState === 'mixed' && offlineMarker.count === 2 && offlineMarker.offlineCount === 1 && offlineMarker.marker?.tag === 'circle' && /离线\s*1\s*台/.test(offlineMarker.title) && onlineMarker?.markerState === 'online' && onlineMarker.count === 2 && onlineMarker.offlineCount === 0 && onlineMarker.marker?.tag === 'circle' && !onlineMarker.marker.detail && /在线\s*2\s*台/.test(onlineMarker.title) && offlineMarker.marker.ring.stroke !== onlineMarker.marker.ring.stroke)
  await evaluate(() => [...document.querySelectorAll('[role="group"][aria-label="分组"] button')].find((b) => b.textContent.startsWith('欧洲'))?.click())
  await waitFor(() => document.querySelectorAll('[data-slot="card"] h3').length === 2)
  check('2D分组筛选同步地图、地区与卡片', (await state()).pins.every((p) => p.id === 3 || p.id === 10) && (await state()).rows.filter((r) => r.code).every((r) => r.code === 'DE' || r.code === 'FI'))
  await evaluate(() => document.querySelector('[role="group"][aria-label="分组"] button')?.click())
  await waitFor((count) => document.querySelectorAll('[data-slot="card"] h3').length === count, nodes.length)

  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [360, 780], [320, 720]]) {
    await viewport(width, height)
    for (const selectedMode of ['3d', '2d']) {
      await mode(selectedMode)
      if (selectedMode === '3d') await motion(false)
      await resetZoom()
      await evaluate(() => scrollTo(0, 0))
      let lightColors
      for (const dark of [false, true]) {
        await media(dark)
        await resetZoom()
        const snapshot = await state(`${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
        layoutChecks(`${selectedMode}/${width}/${dark ? '暗' : '亮'}`, snapshot)
        if (!dark) growthChecks(`${selectedMode}/${width}`, snapshot, width, selectedMode)
        check(`${selectedMode}/${width}：跟随明暗且停转状态不变`, snapshot.dark === dark && snapshot.spinning === 'false')
        if (dark) check(`${selectedMode}/${width}：陆地与海岸线实际跟随主题配色`, snapshot.colors.land !== lightColors.land && snapshot.colors.coast !== lightColors.coast)
        else lightColors = snapshot.colors
        await screenshot(`${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
        for (const [key, expected] of [['Home', 50], ['End', 150]]) {
          await zoom(key)
          const snapshot = await state(`${selectedMode}-${width}-${dark ? 'dark' : 'light'}-${expected}-zoom`)
          const tag = `${selectedMode}/${width}/${dark ? '暗' : '亮'}/${expected}%`
          check(`${tag}：缩放有效且不溢出`, snapshot.zoom === expected && !snapshot.overflow && snapshot.drag === 'false' && snapshot.paths.every((p) => !/NaN|Infinity/.test(p.d)))
          renderingChecks(tag, snapshot)
          dockChecks(tag, snapshot)
          if (width <= 390) await screenshot(`${selectedMode}-${width}-${dark ? 'dark' : 'light'}-zoom-${expected}`)
        }
      }
      if (selectedMode === '2d') {
        const beforePan = await state()
        await mouseDrag(30, 12)
        const afterPan = await state(`${selectedMode}-${width}-150-pan`)
        check(`2d/${width}：铺大地图150%仍可真实鼠标平移，松手不导航`, geometry(beforePan) !== geometry(afterPan) && afterPan.drag === 'false' && await evaluate(() => location.pathname === '/'))
        renderingChecks(`2d/${width}/平移后`, afterPan)
      }
      await resetZoom()
      const hovered = await hoverNode(`${selectedMode}/${width}`)
      if (selectedMode === '2d') await openNodeAndReturn(`2d/${width}`, hovered, selectedMode)
      if (width >= 360) {
        await physicalControl('缩小地球')
        check(`${selectedMode}/${width}：底角缩小按钮真实点击有效且不拖地图`, (await state()).zoom === 90 && (await state()).drag === 'false')
        await physicalControl('放大地球')
        check(`${selectedMode}/${width}：底角放大按钮真实点击有效`, (await state()).zoom === 100)
      } else {
        await zoom('Home')
        check(`${selectedMode}/320：极窄滑条达到50%且不拖地图`, (await state()).zoom === 50 && (await state()).drag === 'false')
        await physicalControl('重置地球缩放')
        check(`${selectedMode}/320：极窄重置真实点击回100%`, (await state()).zoom === 100)
      }
      await physicalControl(selectedMode === '3d' ? 'mode-2d' : 'mode-3d')
      await physicalControl(`mode-${selectedMode}`)
      check(`${selectedMode}/${width}：左下角模式真实点击往返有效`, (await state()).mode === selectedMode && await evaluate(() => location.pathname === '/'))
      if (selectedMode === '3d') {
        await physicalControl('spin')
        check(`3d/${width}：左下角旋转真实点击可开启`, (await state()).spinning === 'true')
        await physicalControl('spin')
        check(`3d/${width}：左下角旋转真实点击可暂停`, (await state()).spinning === 'false')
      }
      if (width === 390) {
        const beforeHorizontal = await state()
        await touchDrag(55, 0)
        const afterHorizontal = await state()
        check(`${selectedMode}手机真实横向touch可拖拽且不会打开节点`, geometry(beforeHorizontal) !== geometry(afterHorizontal) && afterHorizontal.drag === 'false' && await evaluate(() => location.pathname === '/'))
        await evaluate(() => scrollTo(0, 0))
        await touchDrag(0, -85)
        check(`${selectedMode}手机真实竖向touch允许滚页且取消drag`, await evaluate(() => scrollY > 10) && (await state()).drag === 'false' && (await state()).touchAction.includes('pan-y') && await evaluate(() => location.pathname === '/'))
        await evaluate(() => scrollTo(0, 0))
      }
    }
  }

  await viewport(1440, 1000)
  await media(false)
  await mode('3d')
  await motion(true)
  await media(false, true)
  check('减弱动态效果覆盖实际动画，但保留旋转偏好', (await state()).spin === 'true' && (await state()).spinning === 'false' && (await state()).spinDisabled)
  await stable('减弱动态效果时岸线与扫掠都静止')
  await media(false)
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  await evaluate(() => { const space = document.createElement('div'); space.id = 'map-test-scroll-space'; space.style.height = '2500px'; document.body.append(space); scrollTo(0, document.documentElement.scrollHeight) })
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'false')
  await stable('滚出视口后实际动画停止')
  await evaluate(() => scrollTo(0, 0))
  await waitFor(() => document.querySelector('.globe-panel')?.dataset.mapSpinning === 'true')
  await stable('回到视口后动画恢复', true)
  for (const [modeValue, spinValue] of [['garbage', 'garbage'], ['"2d"', 'false'], ['', ''], ['3D', 'null']]) {
    await preferences(modeValue, spinValue)
    const snapshot = await state()
    check(`畸形偏好 ${JSON.stringify([modeValue, spinValue])} 回退首访默认`, snapshot.mode === '3d' && snapshot.spin === 'true' && snapshot.spinning === 'true')
  }
  await preferences('2d', '0')
  check('合法2D/暂停偏好恢复，切回3D仍暂停', (await state()).mode === '2d' && (await state()).spin === 'false')
  await mode('3d')
  await stable('从已保存2D切回3D遵循暂停偏好')
  const denied = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage denied", "SecurityError") } })' })
  await navigate()
  const deniedState = await state()
  check('存储拒绝时安全回退3D与旋转默认', deniedState.mode === '3d' && deniedState.spin === 'true' && deniedState.spinning === 'true')
  await motion(false)
  await mode('2d')
  check('存储拒绝时控件仍可在本次会话工作', (await state()).mode === '2d' && (await state()).spin === 'false')
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: denied.identifier })
  // 移除启动脚本只影响下次加载，先恢复未覆写 localStorage 的 document。
  await navigate()
  await beaconGateChecks()
  await sweepContinuity()
  await aggregateMarkerChecks()
  }
  if (!MOBILE_LAYOUT_ONLY) {
    if (!LOCATIONS_ONLY) await nodeInteractionChecks()
    if (!TOUCH_ONLY) await smallLocationChecks()
  }
  check('验收期间无未捕获页面异常', exceptions.length === 0, exceptions.join(' ; '))
} catch (error) {
  check('地图控件回归脚本完成', false, error.stack || String(error))
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ output: OUT, dist: DIST, baselineDist: BASELINE_DIST, checkGroup: MOBILE_LAYOUT_ONLY ? 'mobile-layout' : LOCATIONS_ONLY ? 'locations' : INTERACTIONS_ONLY ? 'interactions' : 'all', touchOnly: TOUCH_ONLY, neighborsOnly: NEIGHBORS_ONLY, base, preferences: { modeKey: MODE_KEY, spinKey: SPIN_KEY }, results, evidence, diagnostics, requests, exceptions }, null, 2))
  writeFileSync(join(OUT, 'checks.log'), results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n') + '\n')
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP 已关闭')) }
  pending.clear()
  ws?.close()
  chrome?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
}
console.log(`\n结果：${results.filter((r) => r.ok).length} 通过，${results.filter((r) => !r.ok).length} 失败；报告 ${join(OUT, 'report.json')}`)
if (results.some((r) => !r.ok)) process.exitCode = 1
