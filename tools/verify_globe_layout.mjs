// 地球的**版面**验收（不比对世界数据，只看画出来的东西自不自洽）：
//   ① 陆地路径里没有「一步跨过半个圆盘」的直线 —— 那正是「陆地随自转残缺/多填」的元凶
//      （收口没沿地平线走时，实测抓过 168.9 单位一步的弦，几乎就是直径）
//   ② 定位点、连线、线路弧都落在圆盘里（≤ 半径）
//   ③ 地区标签互不重叠、也不被 SVG 视口裁切
// 八种视口均测默认与 50% / 150% 缩放；字号与命中行为由 verify_globe.mjs 另行验收。
//
// 用法：node tools/verify_globe_layout.mjs；LAYOUT_CHECK_GROUP=mobile 仅测320/360/390/430px。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.LAYOUT_PORT || 5201)
const DIST = process.env.LAYOUT_DIST || process.env.MAP_DIST || 'dist'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
// 桩数据：几个挤在一起的城市（同一个地区行）+ 跨洲分布，逼出「标签挤在一起」和「点贴地平线」两种情况
const NODES = {
  nodes: [
    { id: 1, name: '东京一号', online: true, country: 'JP', group: '亚太', region: 'JP · Tokyo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 2, name: '东京二号', online: true, country: 'JP', group: '亚太', region: 'JP · Tokyo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 3, name: '东京三号', online: false, country: 'JP', group: '亚太', region: 'JP · Tokyo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 1073741824, disk_total: 21474836480, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 4, name: '法兰克福一号', online: true, country: 'DE', group: '欧洲', region: 'DE · Frankfurt am Main', os: 'Ubuntu 24.04', cpu_name: 'Xeon', cpu_cores: 4, mem_total: 8589934592, disk_total: 107374182400, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 5, name: '圣何塞', online: true, country: 'US', group: '北美', region: 'US · San Jose', os: 'AlmaLinux 9', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 4294967296, disk_total: 64424509440, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 6, name: '悉尼', online: true, country: 'AU', group: '亚太', region: 'AU · Sydney', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 2147483648, disk_total: 32212254720, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 7, name: '新加坡', online: false, country: 'SG', group: '亚太', region: 'SG · Singapore', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 1073741824, disk_total: 21474836480, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 8, name: '圣保罗', online: true, country: 'BR', group: '南美', region: 'BR · São Paulo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 4294967296, disk_total: 64424509440, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    // ★ 赤道 + 西经 78 一带：那两处收口 bug（弦 + 走向判反）**只在这个视角露头**，
    //   默认视角（lon 80 / lat 30）与东京、法兰克福那些地区行都看不见 —— 反向自测就漏过。
    { id: 9, name: '基多', online: true, country: 'EC', group: '南美', region: 'EC · Quito', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 2147483648, disk_total: 32212254720, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 10, name: '利马', online: true, country: 'PE', group: '南美', region: 'PE · Lima', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 2147483648, disk_total: 32212254720, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    // 两个**超长名字**：把「窄屏截断」这条路走出来（截断必须真的放得下，不能靠 SVG 视口去裁）。
    { id: 11, name: 'Demo Node Tokyo Datacenter Gen 2', online: true, country: 'JP', group: '亚太', region: 'JP · Tokyo Datacenter', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 12, name: 'Demo Node Sao Paulo Datacenter Gen 3', online: true, country: 'BR', group: '南美', region: 'BR · Sao Paulo Datacenter', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 4294967296, disk_total: 64424509440, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
  ],
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '版面验收' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? { listTop: 'bothBudget', cardStyle: 'detailed', remarkPlacement: 'both' } : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join(DIST, normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync(join(DIST, 'index.html')))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${PORT}`

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p)) || 'chrome'
const dbgPort = 9930 + Math.floor(Math.random() * 50)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globelayout-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 起不来')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await send('Runtime.enable'); await send('Page.enable')

// 在页面里跑的那段：默认 VIEW 不变，非默认倍率从实际圆盘读取参数，避免拿 r=92 误判。
const PROBE = `(() => {
  const svg = document.querySelector('.globe-atlas svg')
  if (!svg) return { error: '找不到地球 SVG（.globe-atlas svg）' }
  const host = document.querySelector('.globe-atlas') || svg.parentElement
  const disk = svg.querySelector('.globe-disk')
  if (!disk) return { error: '找不到地球圆盘（.globe-disk）' }
  const CX = +disk.getAttribute('cx'), CY = +disk.getAttribute('cy'), R = +disk.getAttribute('r')
  const num = (s) => { const m = String(s).match(/-?\\d+(\\.\\d+)?/g) || []; return m.map(Number) }
  const radius = (x, y) => Math.hypot(x - CX, y - CY)
  // ① 陆地（与海岸线）：逐步长 —— 弦 bug 会在这里露出来（实测抓过 168.9 单位一步）
  // ★ 必须按子路径（每个 M 一段）分开量：两条子路径之间本来就不画线，
  //   跨段量出来的「一步」是假的（实测会报 183 单位的假跨步）。
  let maxStep = 0, maxStepAt = '', segCount = 0, ptCount = 0, landPaths = 0
  for (const p of svg.querySelectorAll('path.globe-land, path.globe-coast')) {
    landPaths++
    const d = p.getAttribute('d') || ''
    for (const chunk of d.split('M').slice(1)) {
      segCount++
      const nums = num(chunk)
      let prev = null
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = nums[i], y = nums[i + 1]
        ptCount++
        if (prev) { const s = Math.hypot(x - prev[0], y - prev[1]); if (s > maxStep) { maxStep = s; maxStepAt = prev[0].toFixed(1) + ',' + prev[1].toFixed(1) + ' -> ' + x.toFixed(1) + ',' + y.toFixed(1) } }
        prev = [x, y]
      }
    }
  }
  // ①b 闭合弦：子路径最后一点 → 第一点（SVG 填充会隐含把这条直线连上）。
  //   ★ 这一刀曾经是**横跨圆盘的弦**：大环被地平线切成两段时，旧收口走到「下一个可见顶点」
  //     就停、再 Z 拉回段首 —— 实测弦长 99.9 单位（直径 184），弦与地平线之间那一牙陆地
  //     整个丢掉，就是站长圈出来的「本来是陆地却没有正确显示」。
  //     判据：**两头都贴在地平线上、弦又很长** = 出错（全可见环的收尾边、以及段首不在地平线
  //     的兜底情形不算 —— 那些是数据自己的边，本来就长）。
  let maxChord = 0, maxChordAt = ''
  for (const p of svg.querySelectorAll('path.globe-land')) {
    const d = p.getAttribute('d') || ''
    for (const chunk of d.split('M').slice(1)) {
      const nums = num(chunk)
      if (nums.length < 4) continue
      const x0 = nums[0], y0 = nums[1]
      const x1 = nums[nums.length - 2], y1 = nums[nums.length - 1]
      const chord = Math.hypot(x1 - x0, y1 - y0)
      if (radius(x0, y0) > R * 0.97 && radius(x1, y1) > R * 0.97 && chord > maxChord) {
        maxChord = chord
        maxChordAt = x0.toFixed(1) + ',' + y0.toFixed(1) + ' → ' + x1.toFixed(1) + ',' + y1.toFixed(1)
      }
    }
  }
  // ② 点（定位点 + 命中区）与线（连线/线路弧）是否都在盘内。
  // 标签引线本来就延伸到圆盘之外，不能把它拿来判圆盘越界（50% 时尤其容易误报）。
  const outside = []
  const pins = [...svg.querySelectorAll('.globe-pin, circle.hit')]
  for (const c of pins) {
    const x = +(c.getAttribute('data-marker-x') ?? c.getAttribute('cx'))
    const y = +(c.getAttribute('data-marker-y') ?? c.getAttribute('cy'))
    const rr = radius(x, y)
    if (rr > R + 0.6) outside.push('点(' + x + ',' + y + ') r=' + rr.toFixed(1) + ' .' + c.getAttribute('class'))
  }
  let lineWorst = 0, lineAt = '', lineCount = 0
  for (const p of svg.querySelectorAll('path.globe-wire, path.globe-sweep, path.globe-link')) {
    lineCount++
    const nums = num(p.getAttribute('d') || '')
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const rr = radius(nums[i], nums[i + 1])
      if (rr > lineWorst && rr < 1e4) { lineWorst = rr; lineAt = nums[i] + ',' + nums[i + 1] }
    }
  }
  if (lineWorst > R * 1.35) outside.push('线最远 ' + lineWorst.toFixed(1) + ' @' + lineAt)
  // ③ 标签：互不重叠 + 不越界
  const labels = [...svg.querySelectorAll('text.globe-label, text.globe-count')].map((t) => {
    const b = t.getBBox()
    const screen = t.getBoundingClientRect()
    const raw = t.textContent || ''
    // ★ 判「截没截」要看全文：显示用的那截（slice 16）会把结尾的省略号切掉，于是永远查不出来。
    return { text: raw.slice(0, 16), full: raw, x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2, screen: { l: screen.left, t: screen.top, r: screen.right, b: screen.bottom } }
  }).filter((b) => b.w > 0)
  const overlaps = []
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j]
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    if (ox > 0.5 && oy > 0.5) overlaps.push(a.text + ' × ' + b.text + ' (' + ox.toFixed(1) + '×' + oy.toFixed(1) + ')')
  }
  const spill = labels.filter((b) => radius(b.cx, b.cy) > R - 1).map((b) => b.text + ' r=' + radius(b.cx, b.cy).toFixed(1))
  // ★ 真裁切框是 SVG 元素本身（视口），不是 viewBox：宽屏时画布两侧的空白是给长名字溢出的。
  const hostBox = host.getBoundingClientRect()
  const svgBox = svg.getBoundingClientRect()
  const clipped = labels.filter(({ screen: b }) => b.l < svgBox.left - 0.5 || b.r > svgBox.right + 0.5 || b.t < svgBox.top - 0.5 || b.b > svgBox.bottom + 0.5)
    .map((b) => b.text + ' px ' + b.screen.l.toFixed(0) + ',' + b.screen.t.toFixed(0) + '→' + b.screen.r.toFixed(0) + ',' + b.screen.b.toFixed(0) + '（盒 ' + hostBox.width.toFixed(0) + '×' + hostBox.height.toFixed(0) + '）')
  const truncated = labels.filter((b) => b.full.includes('…')).map((b) => b.full)
  // 放大后的宽屏也可能需要省略长名称；直接量全文与当前真实边界，不能只以视口宽度判断。
  const unnecessaryTruncation = []
  for (const text of svg.querySelectorAll('text.globe-label')) {
    if (!(text.textContent || '').includes('…')) continue
    const node = ${JSON.stringify(NODES.nodes.map(({id, name, country}) => ({id, name, country})))}.find((item) => item.id === Number(text.getAttribute('data-label-node')))
    if (!node) continue
    const end = text.getAttribute('text-anchor') === 'end'
    const full = end ? node.name + ' · ' + node.country : node.country + ' · ' + node.name
    const matrix = text.getScreenCTM()
    const anchor = new DOMPoint(Number(text.getAttribute('x')), Number(text.getAttribute('y'))).matrixTransform(matrix)
    const available = end ? anchor.x - svgBox.left : svgBox.right - anchor.x
    const probe = text.cloneNode(true)
    probe.textContent = full
    svg.appendChild(probe)
    const fullWidth = probe.getBoundingClientRect().width
    probe.remove()
    const margin = 9 * Math.abs(matrix.a) // 六单位边距及三单位描边余量。
    if (fullWidth + margin < available - 1) unnecessaryTruncation.push(full + ' ' + fullWidth.toFixed(1) + 'px / 可用 ' + available.toFixed(1) + 'px')
  }
  const caption = svg.querySelector('.globe-caption')?.getBoundingClientRect()
  const captionOverlap = caption ? labels.filter((b) => b.screen.b > caption.top + 0.5).map((b) => b.full) : ['找不到底部经纬度文案']
  const captionClipped = !caption || caption.left < svgBox.left - 0.5 || caption.right > svgBox.right + 0.5 || caption.top < svgBox.top - 0.5 || caption.bottom > svgBox.bottom + 0.5
  const toolbar = document.querySelector('.globe-toolbar')?.getBoundingClientRect()
  const dockOverlap = toolbar ? labels.filter((b) => b.screen.b > toolbar.top + 0.5).map((b) => b.full) : ['找不到底角控件']
  if (toolbar && caption && caption.bottom > toolbar.top + 0.5) dockOverlap.push('底部经纬度文案')
  // 标签本来就摆在圆盘两侧那两摞里（viewBox 460 宽、盘只占中间 184），所以「越出地平线」是设计。
  // 真正要钉住的是：**没有被 viewBox 裁掉的字**。
  const vb = (svg.getAttribute('viewBox') || '0 0 460 240').split(/ +/).map(Number)
  const outOfBox = labels.filter((b) => b.x < vb[0] - 1 || b.y < vb[1] - 1 || b.x + b.w > vb[0] + vb[2] + 1 || b.y + b.h > vb[1] + vb[3] + 1)
    .map((b) => b.text + ' @' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ' ' + b.w.toFixed(0) + '×' + b.h.toFixed(0))
  const slider = document.querySelector('.globe-controls input[type="range"]')
  const hits = [...svg.querySelectorAll('.hit[data-node]')]
  const memberLabels = [...svg.querySelectorAll('text.globe-label')]
  const memberStems = [...svg.querySelectorAll('path.globe-stem')]
  const groups = [[1, 2, 3, 11], [8, 12]]
  const expected = hits.flatMap((hit) => (groups.find((group) => group.includes(Number(hit.dataset.node))) || [Number(hit.dataset.node)]).map((id) => ({ id, key: hit.dataset.pinKey, x: Number(hit.getAttribute('cx')), y: Number(hit.getAttribute('cy')) })))
  const memberIssues = []
  if (memberLabels.length !== expected.length || memberStems.length !== expected.length) memberIssues.push('数量 ' + memberLabels.length + '/' + memberStems.length + '/' + expected.length)
  for (const item of expected) {
    const names = memberLabels.filter((text) => Number(text.dataset.labelNode) === item.id && text.dataset.pinKey === item.key)
    const stems = memberStems.filter((path) => Number(path.dataset.labelNode) === item.id && path.dataset.pinKey === item.key)
    const origin = stems.length === 1 ? num(stems[0].getAttribute('d')).slice(0, 2) : []
    if (names.length !== 1 || stems.length !== 1 || origin.length !== 2 || Math.abs(origin[0] - item.x) > 0.15 || Math.abs(origin[1] - item.y) > 0.15) memberIssues.push('成员 ' + item.id + ' 标签/引线或起点不符')
  }
  return { radius: R, zoom: slider ? Number(slider.value) : null, landPaths, maxStep, maxStepAt, maxChord, maxChordAt, segCount, ptCount, pins: pins.length, lineCount, lineWorst, outside, labels: labels.map((b) => ({ text: b.text, w: +b.w.toFixed(1) })), labelCount: labels.length, countLabels: svg.querySelectorAll('.globe-count').length, memberIssues, overlaps, spill, outOfBox, clipped, truncated, unnecessaryTruncation, captionOverlap, captionClipped, dockOverlap, hostW: +hostBox.width.toFixed(0), viewBox: vb.join(' ') }
})()`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

const PHONE_SIZES = [[430, 900, '大手机 430'], [390, 844, '手机 390'], [360, 780, '小手机 360'], [320, 720, '窄手机 320']]
const SIZES = process.env.ONLY ? [[Number(process.env.ONLY), 780, 'only']] : process.env.LAYOUT_CHECK_GROUP === 'mobile' ? PHONE_SIZES : [[1440, 900, '桌面 1440'], [1024, 768, '小桌面 1024'], [768, 1024, '平板 768'], [560, 900, '窄窗 560'], ...PHONE_SIZES]
for (const [w, h, tag] of SIZES) {
  console.log(`\n=== ${tag} ${w}×${h} ===`)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 500 })
  await send('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 60; i++) { await sleep(250); if (await js('!!document.querySelector(".globe-atlas svg")')) break }
  await sleep(1500)
  // 两趟：默认视角（lon 80 / lat 30），以及**点一下赤道 + 西经 78 那条地区行**之后。
  // 为什么要第二趟：收口那两处 bug 只在赤道视角露头，默认视角完全看不见。
  // ★ 那条「横跨圆盘的弦」现在这里也守得住：①b 会量子路径的**闭合弦**，两头都贴地平线
  //   又超 16 单位就报错（旧收口在 200°E/65°N 实测 99.9 单位）。逐像素对账（globe-diff-image.mjs）
  //   是另一道网，两处都要绿。
  //   这里另外守的是：任何视角下都不该出现「一步跨过半个圆盘」的直线、点线越界、标签重叠或被裁。
  const passes = [['默认视角', null, 100], ['赤道视角（点 EC 地区行）', 'EC', 100], ['赤道视角 · 缩小 50%', null, 50], ['赤道视角 · 放大 150%', null, 150]]
  for (const [label, region, zoom] of passes) {
    if (region) {
      // ★ 这条必须断言「那一行找得到」：夹具里那台厄瓜多尔机器早先在 COUNTRY_LL 之外、
      //   根本不上地区列表，这里点了个寂寞 —— 那一趟量的其实还是上一个角度，而断言在空集上
      //   照样全绿（2026-10-08 补：国家表扩到常见 IDC 国家后才真正点得中）。
      const found = await js(`(() => { const b = document.querySelector('.globe-reg[data-region-code="${region}"]'); if (b) b.click(); return !!b })()`)
      check(`${tag}·${label}：那一行找得到（点了才真的转过去）`, found === true)
      await sleep(1400)
    }
    if (zoom !== 100) {
      const focused = await js(`(() => { const slider = document.querySelector('.globe-controls input[type="range"]'); if (!slider) return false; slider.focus(); return document.activeElement === slider })()`)
      check(`${tag}·${label}：缩放滑条可获得焦点`, focused === true)
      const key = zoom === 50 ? 'Home' : 'End'
      const keyCode = zoom === 50 ? 36 : 35
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode })
      await sleep(400)
    }
    const d = await js(PROBE)
    if (d?.error) { check(`${tag}·${label} 找到地球 SVG`, false, d.error); continue }
    console.log(`    ${label}：陆地 ${d.landPaths} 条 / ${d.segCount} 段 / ${d.ptCount} 点｜定位点 ${d.pins} 个｜线 ${d.lineCount} 条（最远 ${d.lineWorst.toFixed(1)}）｜标签 ${d.labelCount} 条`)
    console.log(`      最远一步 ${d.maxStep.toFixed(1)} 单位 @ ${d.maxStepAt}`)
    if (process.env.DEBUG) console.log('      标签宽：' + d.labels.map((l) => l.text + '=' + l.w.toFixed(0)).join(' | '))
    // ★ 先钉住「探针确实看到了东西」——否则下面几条会在空集上假 PASS
    check(`${tag}·${label} 探针确实量到了陆地/定位点/标签`, d.landPaths > 0 && d.pins > 0 && d.labelCount > 0, `land=${d.landPaths} pins=${d.pins} labels=${d.labelCount}`)
    check(`${tag}·${label} 圆盘半径与当前滑条倍率一致`, d.zoom === zoom && d.radius === 92 * zoom / 100, `倍率 ${d.zoom}% / r=${d.radius}`)
    const scale = d.radius / 92
    check(`${tag}·${label} 陆地路径没有「一步跨过半个圆盘」的直线`, d.maxStep <= 40 * scale + 0.1, `最大 ${d.maxStep.toFixed(1)} / 上限 ${(40 * scale).toFixed(1)} @ ${d.maxStepAt}`)
    // ★ 收口那刀：两头都贴地平线时，闭合弦必须短（旧版这里是 99.9 单位的横跨弦 → 丢一牙陆地）。
    check(`${tag}·${label} 贴地平线的收口没有横跨圆盘的长弦`, d.maxChord <= 16 * scale + 0.1, `最长 ${d.maxChord.toFixed(1)} / 上限 ${(16 * scale).toFixed(1)} @ ${d.maxChordAt}`)
    check(`${tag}·${label} 定位点/连线都在圆盘内`, d.outside.length === 0, d.outside.slice(0, 4).join(' | '))
    check(`${tag}·${label} 同地点每成员保留独立标签与同起点引线`, d.memberIssues.length === 0, d.memberIssues.slice(0, 4).join(' | '))
    check(`${tag}·${label} 信标旁没有台数文本`, d.countLabels === 0, 'globe-count=' + d.countLabels)
    check(`${tag}·${label} 地区标签互不重叠`, d.overlaps.length === 0, d.overlaps.slice(0, 3).join(' | '))
    check(`${tag}·${label} 地区标签都落在 SVG 盒里（没有半个字被视口裁掉）`, d.clipped.length === 0, `盒宽 ${d.hostW}｜${d.clipped.slice(0, 3).join(' | ')}`)
    check(`${tag}·${label} 底部经纬度文案在所有标签下方`, d.captionOverlap.length === 0, d.captionOverlap.slice(0, 3).join(' | '))
    check(`${tag}·${label} 底部经纬度文案完整，标签与说明不覆盖底角控件`, !d.captionClipped && d.dockOverlap.length === 0, d.dockOverlap.slice(0, 3).join(' | '))
    if (d.truncated.length) console.log(`      截断 ${d.truncated.length} 条：${d.truncated.slice(0, 3).join(' | ')}`)
    // 宽屏地图变大后，长名称可能需要省略；有实际余量却省略仍然属于回归。
    if (tag.startsWith('桌面 1440') && zoom === 100) check(`${tag}·${label} 全文有实际余量时不截字`, d.unnecessaryTruncation.length === 0, d.unnecessaryTruncation.slice(0, 3).join(' | '))
  }
  // 后续几何验收从 100% 开始，不能留下上一趟的 150% 状态。
  await js(`document.querySelector('.globe-controls button[aria-label="重置地球缩放"]')?.click()`)
  await sleep(150)
  const restored = await js(PROBE)
  check(`${tag}：极值验收之后恢复默认倍率`, restored?.zoom === 100 && restored?.radius === 92)
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)
