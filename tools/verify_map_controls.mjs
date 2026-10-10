// 本机 dist + 合成节点夹具，使用原生 Chrome/CDP；不访问线上探针，不引入依赖。
// 用法：node tools/verify_map_controls.mjs [输出目录]；可指定 CHROME_PATH / MAP_DIST。
// MAP_BASELINE_DIST 可指向保留的 1.30.0 dist，实测同夹具的旧图形尺寸作为前后对照。
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
let servingDist = BASELINE_DIST || DIST
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
  makeNode(3, 'Frankfurt 一号', 'DE', '欧洲'), makeNode(4, 'Seattle 一号', 'US', '美洲'),
  makeNode(5, 'Singapore 一号', 'SG', '亚太'), makeNode(6, 'Sydney 一号', 'AU', '亚太'),
  makeNode(7, 'São Paulo 一号', 'BR', '美洲'), makeNode(8, 'Auckland Datacenter Very Long Example Name', 'NZ', '亚太'),
  makeNode(9, 'Toronto 一号', 'CA', '美洲'), makeNode(10, '芬兰节点', 'FI', '欧洲'),
  makeNode(11, 'Xi’an-01', 'CN', '亚太'), makeNode(12, '未定位节点', '', '未定位'),
  makeNode(13, 'Seattle-跨国反例', 'CN', '亚太'),
]
const locatedIds = nodes.filter((node) => node.country).map((node) => node.id).sort((a, b) => a - b)
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
  return {
    mode: panel.dataset.mapMode, spin: panel.dataset.mapSpin, spinning: panel.dataset.mapSpinning,
    spinPressed: spin?.getAttribute('aria-pressed'), spinDisabled: !spin || spin.disabled,
    zoom: Number(panel.querySelector('input[type="range"]')?.value), drag: panel.querySelector('.globe-atlas')?.dataset.drag,
    touchAction: getComputedStyle(panel.querySelector('.globe-atlas')).touchAction,
    paths, caption: caption?.textContent, pins: [...svg.querySelectorAll('[data-node]')].map((el) => ({ id: Number(el.dataset.node), online: el.dataset.online, count: Number(el.dataset.count), region: el.dataset.region, x: el.getAttribute('cx'), y: el.getAttribute('cy') })),
    mapFrame: !!svg.querySelector('.globe-map-frame'), globeDisk: !!svg.querySelector('.globe-disk'),
    rows: [...panel.querySelectorAll('.globe-reg')].map((el) => ({ text: el.querySelector('span')?.textContent.trim(), code: el.querySelector('img')?.getAttribute('src')?.match(/\/([^/]+)\.svg$/)?.[1], count: Number(el.querySelector('b')?.textContent), pressed: el.getAttribute('aria-pressed'), title: el.title, offline: !!el.querySelector('.globe-reg-dot') })),
    cards: [...document.querySelectorAll('[data-slot="card"] h3')].map((el) => el.textContent.trim()),
    dark: document.documentElement.classList.contains('dark'), overflow: document.documentElement.scrollWidth > innerWidth + 1,
    colors: { land: getComputedStyle(svg.querySelector('.globe-land')).fill, coast: getComputedStyle(svg.querySelector('.globe-coast')).stroke },
    clipped, overlaps, captionOverlap: caption ? labels.filter((r) => r.bottom > rect(caption).y + 1).map((r) => r.text) : ['missing caption'],
    labels: labels.length, controls, controlObscures, projection: projection ? rect(projection) : null,
    viewportWidth: innerWidth, svg: svgBox, host: rect(panel.querySelector('.globe-atlas')),
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
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x + dx * i / 6, y: position.y + dy * i / 6, button: 'left', buttons: 1 })
    await sleep(50)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x + dx, y: position.y + dy, button: 'left', clickCount: 1 })
  await sleep(200)
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
  const oldHeight = previous?.host.h ?? (width <= 720 ? 210 : 280)
  check(`${tag}：实际画布高度增加`, snapshot.host.h > oldHeight + 20, `${oldHeight.toFixed(1)}→${snapshot.host.h.toFixed(1)}px`)
  if (!previous) return
  const before = previous.projection
  const after = snapshot.projection
  const increased = width === 1440
  check(`${tag}：${increased ? '桌面实际地图更大' : '窄屏实际地图不缩小'}`, before && after && (increased ? after.w > before.w + 1 && after.h > before.h + 1 : after.w >= before.w - 0.5 && after.h >= before.h - 0.5), before && after ? `${before.w.toFixed(1)}×${before.h.toFixed(1)}→${after.w.toFixed(1)}×${after.h.toFixed(1)}px` : 'missing rendered projection')
}
async function physicalControl(key) {
  const target = await evaluate((key) => {
    const button = key.startsWith('mode-') || key === 'spin' ? document.querySelector(`[data-map-control="${key}"]`) : document.querySelector(`.globe-controls button[aria-label="${key}"]`)
    if (!button || button.disabled) return null
    const r = button.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, key)
  if (!target) throw new Error(`找不到实际可点击的控件：${key}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 })
  await sleep(200)
}
function layoutChecks(tag, snapshot) {
  check(`${tag}：实际绘出陆地、定位点与标签`, snapshot.paths?.some((p) => p.kind === 'globe-land' && p.d.length > 100) && snapshot.pins.length > 0 && snapshot.labels > 0)
  check(`${tag}：路径与命中坐标有限`, snapshot.paths.every((p) => !/NaN|Infinity/.test(p.d)) && snapshot.pins.every((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))))
  check(`${tag}：控件与页面不横向溢出`, !snapshot.overflow && snapshot.controls.every((r) => r.x >= -1 && r.right <= snapshot.svg.x + snapshot.svg.w + 40 && r.h >= 20))
  check(`${tag}：标签未被画布裁切且未压底注`, snapshot.clipped.length === 0 && snapshot.captionOverlap.length === 0, [...snapshot.clipped, ...snapshot.captionOverlap].slice(0, 4).join(' | '))
  check(`${tag}：标签互不重叠`, snapshot.overlaps.length === 0, JSON.stringify(snapshot.overlaps.slice(0, 3)))
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
  if (BASELINE_DIST) {
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
  const initial = await state('first-visit')
  check('首访默认 3D、旋转开启、两个模式按钮语义明确', initial.mode === '3d' && initial.spin === 'true' && initial.spinning === 'true' && await evaluate(() => document.querySelector('[data-map-control="mode-3d"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-map-control="mode-2d"]')?.getAttribute('aria-pressed') === 'false'))
  await stable('默认旋转实际改变岸线与扫掠', true)
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
  check('2D默认显示所有可定位节点，不画缺失国家的假针', JSON.stringify([...new Set(flat.pins.map((p) => p.id))].sort((a, b) => a - b)) === JSON.stringify(locatedIds), JSON.stringify(flat.pins.map((p) => p.id)))
  check('2D保留离线节点与地区离线提示', flat.pins.some((p) => p.id === 2 && p.online === '0') && flat.rows.some((r) => r.code === 'JP' && r.count === 2 && r.offline && r.title.includes('1 台离线')))
  check('国家兜底显示全名、Unicode单引号城市正确、跨国城市不串落点', flat.rows.some((r) => r.code === 'FI' && r.text === 'Finland') && flat.rows.some((r) => r.code === 'CN' && r.text === "Xi'an") && flat.rows.some((r) => r.code === 'CN' && r.text === 'China') && flat.pins.some((p) => p.id === 13 && p.region === 'CN'))
  await stable('2D没有自动动画')
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
  check('2D重置还原全图100%与所有节点', (await state()).zoom === 100 && new Set((await state()).pins.map((p) => p.id)).size === locatedIds.length)
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
  nodes = nodes.map((n) => n.id === 2 ? { ...n, online: true } : n)
  await waitFor(() => document.querySelector('svg[data-map-canvas] [data-node="2"]')?.dataset.online === '1')
  check('节点恢复在线后2D针与地区离线提示同步更新', !(await state()).rows.find((r) => r.code === 'JP')?.offline)
  await evaluate(() => [...document.querySelectorAll('[role="group"][aria-label="分组"] button')].find((b) => b.textContent.startsWith('欧洲'))?.click())
  await waitFor(() => document.querySelectorAll('[data-slot="card"] h3').length === 2)
  check('2D分组筛选同步地图、地区与卡片', (await state()).pins.every((p) => p.id === 3 || p.id === 10) && (await state()).rows.filter((r) => r.code).every((r) => r.code === 'DE' || r.code === 'FI'))
  await evaluate(() => document.querySelector('[role="group"][aria-label="分组"] button')?.click())
  await waitFor((count) => document.querySelectorAll('[data-slot="card"] h3').length === count, nodes.length)

  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [360, 780]]) {
    await viewport(width, height)
    for (const selectedMode of ['3d', '2d']) {
      await mode(selectedMode)
      if (selectedMode === '3d') await motion(false)
      await resetZoom()
      await evaluate(() => scrollTo(0, 0))
      let lightColors
      for (const dark of [false, true]) {
        await media(dark)
        const snapshot = await state(`${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
        layoutChecks(`${selectedMode}/${width}/${dark ? '暗' : '亮'}`, snapshot)
        if (!dark) growthChecks(`${selectedMode}/${width}`, snapshot, width, selectedMode)
        check(`${selectedMode}/${width}：跟随明暗且停转状态不变`, snapshot.dark === dark && snapshot.spinning === 'false')
        if (dark) check(`${selectedMode}/${width}：陆地与海岸线实际跟随主题配色`, snapshot.colors.land !== lightColors.land && snapshot.colors.coast !== lightColors.coast)
        else lightColors = snapshot.colors
        await screenshot(`${selectedMode}-${width}-${dark ? 'dark' : 'light'}`)
      }
      for (const [key, expected] of [['Home', 50], ['End', 150]]) {
        await zoom(key)
        const snapshot = await state(`${selectedMode}-${width}-${expected}-zoom`)
        check(`${selectedMode}/${width}：${expected}%缩放有效且不溢出`, snapshot.zoom === expected && !snapshot.overflow && snapshot.drag === 'false' && snapshot.paths.every((p) => !/NaN|Infinity/.test(p.d)))
        dockChecks(`${selectedMode}/${width}/${expected}%`, snapshot)
        if (width <= 390) await screenshot(`${selectedMode}-${width}-zoom-${expected}`)
      }
      await resetZoom()
      await physicalControl('缩小地球')
      check(`${selectedMode}/${width}：底角缩小按钮真实点击有效且不拖地图`, (await state()).zoom === 90 && (await state()).drag === 'false')
      await physicalControl('放大地球')
      check(`${selectedMode}/${width}：底角放大按钮真实点击有效`, (await state()).zoom === 100)
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

  // 320px 的极窄布局隐藏 ± 快捷按钮，滑条/读数/重置及模式组仍须真实可用。
  await viewport(320, 720)
  await media(false)
  for (const selectedMode of ['3d', '2d']) {
    await mode(selectedMode)
    if (selectedMode === '3d') await motion(false)
    await resetZoom()
    await evaluate(() => scrollTo(0, 0))
    const snapshot = await state(`${selectedMode}-320-light-diagnostic`)
    const outside = snapshot.controls.filter((r) => r.visible && (r.x < snapshot.main.x - 1 || r.right > snapshot.main.right + 1 || (!r.disabled && !r.hittable))).map((r) => r.name)
    const item = { label: `${selectedMode}/320`, outside, groupGap: snapshot.zoomGroup.x - snapshot.modeGroup.right, controlObscures: snapshot.controlObscures, overflow: snapshot.overflow, projection: snapshot.projection, baselineProjection: baseline.get(`${selectedMode}-320`)?.projection }
    diagnostics.push(item)
    dockChecks(`${selectedMode}/320/极窄`, snapshot)
    check(`${selectedMode}/320：页面不溢出且滑条键盘仍可缩放`, !snapshot.overflow && snapshot.controls.some((r) => r.name === '地球缩放比例' && r.visible && r.hittable))
    await zoom('Home')
    check(`${selectedMode}/320：极窄滑条达到50%且不拖地图`, (await state()).zoom === 50 && (await state()).drag === 'false')
    await physicalControl('重置地球缩放')
    check(`${selectedMode}/320：极窄重置真实点击回100%`, (await state()).zoom === 100)
    console.log(`NOTE  320px额外布局诊断 — ${JSON.stringify(item)}`)
    await screenshot(`${selectedMode}-320-light-diagnostic`)
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
  check('验收期间无未捕获页面异常', exceptions.length === 0, exceptions.join(' ; '))
} catch (error) {
  check('地图控件回归脚本完成', false, error.stack || String(error))
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ output: OUT, dist: DIST, baselineDist: BASELINE_DIST, base, preferences: { modeKey: MODE_KEY, spinKey: SPIN_KEY }, results, evidence, diagnostics, requests, exceptions }, null, 2))
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
