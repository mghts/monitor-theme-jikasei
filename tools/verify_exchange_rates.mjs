// 用真实生产构建与 Chrome/CDP 验证每日汇率。所有第三方请求都在 Request 阶段拦截，不访问外网。
// 用法：FX_DIST=/path/to/dist node tools/verify_exchange_rates.mjs [保留证据的父目录]
// 只创建本地服务、独立 Chrome profile、截图与 JSON 报告；退出时关闭本工具创建的进程。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const DIST = resolve(process.env.FX_DIST || 'dist')
const parent = process.argv[2] ? resolve(process.argv[2]) : tmpdir()
mkdirSync(parent, { recursive: true })
const OUT = mkdtempSync(join(parent, 'monitor-exchange-rates-'))
// 固定的生产白名单；只允许可选的时间桶 query，不重写生产 fetch。
const PRIMARY_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json'
const BACKUP_URL = 'https://latest.currency-api.pages.dev/v1/currencies/cny.json'
const CACHE_KEY = 'jikasei:exchange_rates:v1'
const MAX_AGE_MS = 6 * 60 * 60 * 1000
const INFO_SELECTOR = '[data-exchange-rate-status]'
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
if (!CHROME || !existsSync(join(DIST, 'index.html'))) throw new Error('缺少 Chrome 或 FX_DIST/index.html')
if (typeof WebSocket === 'undefined') throw new Error('需要带原生 WebSocket 的 Node.js')

const GB = 1024 ** 3
const node = (id, name, currency, price, cycle = 'monthly', left = 15) => ({
  id, name, currency, price, billing_cycle: cycle, expires_in: left, expires_at: null,
  online: true, public: true, sort: id, country: 'JP', group: '汇率', last_seen: Math.floor(Date.now() / 1000),
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * GB, disk_total: 40 * GB, swap_total: 0, agent_version: '1.4.0',
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1, public_remark: '',
  total_rx: GB, total_tx: GB, month_rx: GB, month_tx: GB, month_start: '2026-10-01', day_rx: GB, day_tx: GB,
  metrics: { uptime: 400000, cpu: 12, load: [0.1, 0.2, 0.3], mem_used: GB, mem_total: 2 * GB, swap_used: 0, swap_total: 0, disk_used: GB, disk_total: 40 * GB, net_rx: 0, net_tx: 0, procs: 20, tcp: 2, udp: 0, total_rx: GB, total_tx: GB, month_rx: GB, month_tx: GB },
})
const MIXED = [
  node(1, '美元月付', 'USD', 10), node(2, '欧元季付', 'EUR', 30, 'quarterly', 45),
  node(3, '迪拉姆月付', 'AED', 10, 'monthly', 30), node(4, '人民币月付', 'CNY', 20),
  node(5, '未知币种', 'XYZ', 100),
]
const RARE = [
  node(11, '匈牙利币', 'HUF', 600, 'monthly', 18), node(12, '挪威年付', 'NOK', 72, 'yearly', 192),
  node(13, '乌克兰币', 'UAH', 100), node(14, '澳门币', 'MOP', 10, 'monthly', 30),
  node(15, '科威特币', 'KWD', 2, 'monthly', 30), node(16, '中非币', 'XAF', 600),
  node(17, '智利币', 'CLP', 1000), node(18, '阿富汗币', 'AFN', 100, 'monthly', 30),
  node(19, '人民币月付', 'CNY', 20), node(20, '未知币种', 'XYZ', 100),
]
const CNY_ONLY = [node(31, '仅人民币', 'CNY', 20)]
const BUILTIN_ONLY = [node(41, '美元月付', 'USD', 10), node(42, '人民币月付', 'CNY', 20)]
// 独立合计预期来自这些手工夹具价，绝不导入生产 budgetOf 或汇率归一化函数。
const QUOTES = { CNY: 1, USD: 7.5, EUR: 8, AED: 2, HUF: 0.025, NOK: 0.7, UAH: 0.18, MOP: 0.9, KWD: 24, XAF: 0.01, CLP: 0.008, AFN: 0.1, JPY: 0.05, HKD: 0.96, SGD: 5.5, XYZ: 0.001, BTC: 100000 }
// 独立协议夹具：SIX 当前普通货币清单（2026-10 核查）；完整响应不能靠几个美元样本冒充。
const ISO_CODES = 'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG'.split(' ')
const payload = (date, quotes = QUOTES) => ({ date, cny: { ...Object.fromEntries(ISO_CODES.map((code) => [code.toLowerCase(), 1])), ...Object.fromEntries(Object.entries(quotes).map(([code, quote]) => [code.toLowerCase(), 1 / quote])) } })
let nodes = MIXED
let listTop = 'budget'
let exchangeRates = ''
let scenario = 'starting'
let base = ''
let plan = { primary: 'hold', backup: 'fail' }
const requests = [], localRequests = [], results = [], evidence = [], exceptions = [], interceptErrors = []
const paused = new Map()
let chrome, chromeError, ws, closing = false, commandId = 0
const pending = new Map()
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const server = createServer((req, res) => {
  const url = new URL(req.url, base)
  if (url.pathname.startsWith('/api/')) {
    localRequests.push({ path: url.pathname, scenario, at: Date.now() })
    const data = url.pathname === '/api/me' ? { authed: false, github: false, public_page: true, site_name: '每日汇率验收' }
      : url.pathname === '/api/nodes' ? { nodes }
        : url.pathname.endsWith('/config') ? { listTop, exchangeRates, cardStyle: 'plain', globeOn: false, themeMode: 'system' }
          : url.pathname === '/api/version' ? { version: '1.4.0' }
            : { metrics: [], ping: [], probes: {}, loss: {}, step: 60 }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(data))
  }
  const path = resolve(DIST, '.' + url.pathname)
  const file = (path === DIST || path.startsWith(DIST + sep)) && existsSync(path) && statSync(path).isFile() ? path : join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
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
  const response = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result?.value
}
async function waitFor(fn, ...args) {
  for (let i = 0; i < 100; i++) { if (await evaluate(fn, ...args)) return; await sleep(100) }
  throw new Error(`页面状态未到达：${fn.toString().slice(0, 140)}`)
}
async function fulfill(requestId, data, responseCode = 200) {
  await send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: [
    { name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
  ], body: Buffer.from(JSON.stringify(data)).toString('base64') })
}
async function intercept({ requestId, request }) {
  if (request.url.startsWith(base + '/')) return send('Fetch.continueRequest', { requestId })
  const actual = new URL(request.url)
  const query = [...actual.searchParams]
  const allowedQuery = !actual.hash && !actual.username && !actual.password && query.length === 1 && query[0][0] === 't' && /^\d+$/.test(query[0][1])
  const normalized = actual.origin + actual.pathname
  const kind = !allowedQuery ? 'unexpected' : normalized === PRIMARY_URL ? 'primary' : normalized === BACKUP_URL ? 'backup' : 'unexpected'
  const headers = Object.keys(request.headers)
  requests.push({ scenario, kind, url: request.url, method: request.method, at: Date.now(), hasPostData: !!request.postData, authenticated: headers.some((key) => /^(cookie|authorization)$/i.test(key)), referrer: headers.find((key) => /^referer$/i.test(key)) ? request.headers[headers.find((key) => /^referer$/i.test(key))] : null })
  if (kind === 'unexpected' || plan[kind] === 'fail') return send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
  if (plan[kind] === 'hold') { paused.set(requestId, { kind, scenario }); return }
  if (plan[kind]?.status) return fulfill(requestId, plan[kind].body || { error: 'fixture unavailable' }, plan[kind].status)
  return fulfill(requestId, plan[kind])
}
async function release(kind, body, responseCode = 200) {
  const match = [...paused].find(([, item]) => item.kind === kind && item.scenario === scenario)
  if (!match) throw new Error(`没有暂停的 ${kind} 请求`)
  paused.delete(match[0])
  await fulfill(match[0], body, responseCode)
}
async function viewport(width = 1440, height = 1000, dark = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 500 })
  await send('Emulation.setTouchEmulationEnabled', { enabled: width < 500, maxTouchPoints: 1 })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
}
async function navigate() {
  await send('Page.navigate', { url: base + '/?fx-case=' + encodeURIComponent(scenario) })
  await waitFor((label, count) => new URL(location.href).searchParams.get('fx-case') === label && document.readyState === 'complete' && document.querySelectorAll('[data-slot="card"][role="button"]').length === count, scenario, nodes.length)
  await sleep(100)
}
function inspect(infoSelector, cacheKey) {
  const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } }
  const cards = [...document.querySelectorAll('[data-slot="card"]')]
  const blocks = cards.flatMap((card) => [...card.children]).filter((block) => ['月度预算', '剩余价值'].includes(block.firstElementChild?.textContent.trim()))
  const info = document.querySelector(infoSelector)
  return {
    budgets: blocks.map((block) => ({ title: block.firstElementChild.textContent.trim(), number: block.children[1]?.textContent.trim(), foot: block.children[2]?.textContent.trim(), hint: block.getAttribute('title'), numberClipped: !!block.children[1] && block.children[1].scrollWidth > block.children[1].clientWidth + 1, ...rect(block) })),
    info: info ? { text: info.textContent.trim(), title: info.getAttribute('title'), attrs: Object.fromEntries([...info.attributes].map((attr) => [attr.name, attr.value])), scrollWidth: info.scrollWidth, clientWidth: info.clientWidth, parts: [...info.children].map((part) => ({ text: part.textContent.trim(), clipped: part.scrollWidth > part.clientWidth + 1, ...rect(part) })), visible: getComputedStyle(info).display !== 'none' && rect(info).h > 0, ...rect(info) } : null,
    cache: localStorage.getItem(cacheKey), viewportWidth: innerWidth, dark: document.documentElement.classList.contains('dark'), overflow: document.documentElement.scrollWidth > innerWidth + 1,
    nodes: cards.filter((card) => card.getAttribute('role') === 'button').length, body: document.body.innerText,
  }
}
async function state(label) {
  const snapshot = await evaluate(inspect, INFO_SELECTOR, CACHE_KEY)
  if (label) evidence.push({ label, at: Date.now(), ...snapshot })
  return snapshot
}
const amount = (snapshot, title) => Number(snapshot.budgets.find((block) => block.title === title)?.number?.match(/¥\s*([\d,]+(?:\.\d+)?)/)?.[1]?.replaceAll(',', ''))
function budgetChecks(tag, snapshot, monthly, remaining, count) {
  check(`${tag}：月度预算准确`, amount(snapshot, '月度预算') === monthly, snapshot.budgets.find((block) => block.title === '月度预算')?.number)
  check(`${tag}：剩余价值准确`, amount(snapshot, '剩余价值') === remaining, snapshot.budgets.find((block) => block.title === '剩余价值')?.number)
  check(`${tag}：两块覆盖台数准确，未知币种未计入`, snapshot.budgets.length === 2 && snapshot.budgets[0].foot === `${count} 台计费` && snapshot.budgets[1].foot === `${count} 台未到期`, snapshot.budgets.map((block) => block.foot).join(' / '))
}
async function screenshot(label) {
  const response = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(OUT, label + '.png'), Buffer.from(response.data, 'base64'))
}
async function runChecks() {
  check('独立全局响应夹具覆盖 155 种当前法币，代码无重复', ISO_CODES.length === 155 && new Set(ISO_CODES).size === 155)
  const today = new Date().toISOString().slice(0, 10)
  const scenarioRequests = () => requests.filter((request) => request.scenario === scenario)
  const clearCache = () => evaluate((key) => localStorage.removeItem(key), CACHE_KEY)
  const seedCache = (cache) => evaluate((key, value) => localStorage.setItem(key, JSON.stringify(value)), CACHE_KEY, cache)
  const waitBudget = () => waitFor(() => [...document.querySelectorAll('[data-slot="card"]')].flatMap((card) => [...card.children]).filter((block) => ['月度预算', '剩余价值'].includes(block.firstElementChild?.textContent.trim())).length === 2)
  const waitFx = (origin, failed = false) => waitFor((selector, expectedOrigin, expectedFailed) => {
    const info = document.querySelector(selector)
    return info?.getAttribute('data-fx-origin') === expectedOrigin && info.getAttribute('data-fx-failed') === String(expectedFailed) && info.getAttribute('data-fx-loading') === 'false'
  }, INFO_SELECTOR, origin, failed)
  const requestChecks = (tag, primary, backup) => {
    const actual = scenarioRequests()
    check(`${tag}：主/备用请求数准确，共享请求没有按预算或节点重复`, actual.filter((r) => r.kind === 'primary').length === primary && actual.filter((r) => r.kind === 'backup').length === backup && actual.length === primary + backup, actual.map((r) => r.kind).join(' → '))
  }
  const metadataChecks = (tag, snapshot, origin, failed, wording, date) => {
    check(`${tag}：来源、失败和加载状态一致`, snapshot.info?.attrs['data-fx-origin'] === origin && snapshot.info.attrs['data-fx-failed'] === String(failed) && snapshot.info.attrs['data-fx-loading'] === 'false', JSON.stringify(snapshot.info?.attrs))
    check(`${tag}：页面明确显示报价日期与回退状态`, snapshot.info?.text.includes(wording) && snapshot.info.text.includes(date), snapshot.info?.text)
  }
  const noRequestCheck = async (tag, before) => {
    await sleep(450)
    check(`${tag}：无需折算时不访问第三方汇率`, requests.length === before, JSON.stringify(requests.slice(before)))
  }

  // 先建立本地 origin；只清本工具的单个缓存 key，保留独立 profile 内其它状态。
  scenario = 'bootstrap'
  nodes = CNY_ONLY
  listTop = 'none'
  plan = { primary: 'fail', backup: 'fail' }
  await navigate()
  await clearCache()
  await send('Network.enable')
  const sameSite = await send('Network.setCookie', { name: 'fixture_site_cookie', value: 'local_only', url: base + '/' })
  const primaryCookie = await send('Network.setCookie', { name: 'fixture_provider_cookie', value: 'primary_only', url: PRIMARY_URL, secure: true, sameSite: 'None' })
  const backupCookie = await send('Network.setCookie', { name: 'fixture_provider_cookie', value: 'backup_only', url: BACKUP_URL, secure: true, sameSite: 'None' })
  const providerCookies = await send('Network.getCookies', { urls: [PRIMARY_URL, BACKUP_URL] })
  check('隐私夹具：站点和两提供方 cookie 确实已设置', sameSite.success && primaryCookie.success && backupCookie.success && providerCookies.cookies.filter((cookie) => cookie.name === 'fixture_provider_cookie').length === 2)

  scenario = 'primary-success'
  nodes = MIXED
  listTop = 'budget'
  exchangeRates = ''
  plan = { primary: 'hold', backup: 'fail' }
  await navigate()
  await waitBudget()
  await waitFor((selector) => document.querySelector(selector)?.getAttribute('data-fx-loading') === 'true', INFO_SELECTOR)
  const loading = await state('before-primary-response')
  const builtinDate = loading.info?.text.match(/\d{4}-\d{2}-\d{2}/)?.[0]
  if (!builtinDate) throw new Error('页面没有给出内置报价日期')
  check('冷启动：网络响应前两预算已有有限内置读数，明确显示正在更新', loading.info.attrs['data-fx-origin'] === 'builtin' && loading.info.text.includes('正在更新') && ['月度预算', '剩余价值'].every((title) => Number.isFinite(amount(loading, title)) && amount(loading, title) > 0), JSON.stringify(loading.budgets))
  await release('primary', payload(today))
  await waitFx('network')
  const updated = await state('primary-success')
  budgetChecks('主源成功', updated, 195, 187.5, '4/5')
  metadataChecks('主源成功', updated, 'network', false, '已自动更新', today)
  check('自动更新：两个预算同步从内置报价变为新参考价', ['月度预算', '剩余价值'].every((title) => amount(updated, title) !== amount(loading, title)))
  check('未知币种：有价格的 XYZ 明示未计入，不能使用提供方额外代币报价', updated.info.text.includes('1 种币种缺少报价，未计入') && updated.budgets.every((block) => block.hint.includes('XYZ 没有汇率，未计入')))
  const fullCache = JSON.parse(updated.cache || 'null')
  check('缓存：保存带版本、日期、来源和获取时间的完整全局表', fullCache?.version === 1 && fullCache.snapshot?.source === 'currency-api' && fullCache.snapshot.date === today && Number.isFinite(fullCache.snapshot.fetchedAtMs) && fullCache.snapshot.fetchedAtMs > 0 && ISO_CODES.every((code) => Number.isFinite(fullCache.snapshot.rates[code]) && fullCache.snapshot.rates[code] > 0), fullCache ? `${Object.keys(fullCache.snapshot?.rates || {}).length} 币种` : '无缓存')
  check('缓存：倒数方向正确，未知币种和加密币未进入表', fullCache?.snapshot?.rates.USD === 7.5 && fullCache.snapshot.rates.CNY === 1 && !Object.hasOwn(fullCache.snapshot.rates, 'XYZ') && !Object.hasOwn(fullCache.snapshot.rates, 'BTC'))
  requestChecks('主源成功', 1, 0)
  await screenshot('01-primary-success-desktop')

  scenario = 'cache-reload'
  plan = { primary: 'fail', backup: 'fail' }
  const beforeReload = requests.length
  await navigate()
  await waitFx('cache')
  const reloaded = await state('cache-reload')
  budgetChecks('新鲜缓存重载', reloaded, 195, 187.5, '4/5')
  metadataChecks('新鲜缓存重载', reloaded, 'cache', false, '使用缓存', today)
  await noRequestCheck('新鲜缓存重载', beforeReload)

  scenario = 'rare-currencies'
  nodes = RARE
  const beforeRare = requests.length
  await navigate()
  await waitFx('cache')
  const rare = await state('rare-currencies')
  budgetChecks('少见币种全局覆盖', rare, 138.2, 128.51, '9/10')
  check('少见币种：新节点所需八种报价来自原缓存且说明完整', rare.budgets.every((block) => ['HUF', 'NOK', 'UAH', 'MOP', 'KWD', 'XAF', 'CLP', 'AFN'].every((code) => block.hint.includes(`1 ${code} =`))) && rare.info.text.includes(today))
  await noRequestCheck('少见币种全局覆盖', beforeRare)
  await screenshot('02-rare-currencies-desktop')

  scenario = 'manual-priority'
  nodes = MIXED
  exchangeRates = 'USD=7.1\nAED=2.3\nXYZ=bad\nEUR=0\nHUF=-1\nNOK=Infinity\nBTC=bad\nCNY=99'
  const beforeManual = requests.length
  await navigate()
  await waitFx('cache')
  const manual = await state('manual-priority')
  budgetChecks('手工价优先', manual, 194, 188.5, '4/5')
  check('手工价：明确区分自定义和每日价，非法项未成为零报价', manual.budgets.every((block) => block.hint.includes('1 USD = ¥7.1') && block.hint.includes('1 AED = ¥2.3') && block.hint.includes('自定义') && block.hint.includes(`1 EUR = ¥8，${today}`) && block.hint.includes('XYZ 没有汇率，未计入')) && manual.info.text.includes('忽略 6 项无效自定义汇率'), manual.info.text)
  check('手工价：人民币始终为 1，手工配置不污染自动全局缓存', manual.cache === reloaded.cache)
  await noRequestCheck('手工价优先且自动价已有缓存', beforeManual)

  scenario = 'all-manual'
  await clearCache()
  nodes = [node(51, '手工美元', 'USD', 10), node(52, '手工未知币', 'XYZ', 10), node(53, '仅人民币', 'CNY', 20)]
  exchangeRates = 'USD=7.1\nXYZ=2'
  const beforeAllManual = requests.length
  await navigate()
  await waitBudget()
  const allManual = await state('all-manual')
  budgetChecks('所有外币已有手工价', allManual, 111, 55.5, '3')
  check('全手工：允许显式补未知币价，标明自定义且不冒用自动日期', allManual.info?.text === '自定义汇率' && allManual.budgets.every((block) => block.hint.includes('1 XYZ = ¥2') && block.hint.includes('自定义') && !block.hint.includes(today)) && allManual.cache === null)
  await noRequestCheck('所有外币已有手工价', beforeAllManual)

  scenario = 'backup-success'
  await clearCache()
  nodes = MIXED
  exchangeRates = ''
  plan = { primary: { status: 503 }, backup: payload(today, { ...QUOTES, USD: 8, EUR: 9, AED: 2.5 }) }
  await navigate()
  await waitFx('network')
  const backup = await state('backup-success')
  budgetChecks('主源失败备用成功', backup, 215, 210, '4/5')
  metadataChecks('主源失败备用成功', backup, 'network', false, '已自动更新', today)
  requestChecks('主源失败备用成功', 1, 1)
  check('备用：严格主源失败后才使用备用响应', scenarioRequests().map((request) => request.kind).join(',') === 'primary,backup' && JSON.parse(backup.cache).snapshot.rates.USD === 8)
  await screenshot('03-backup-success-desktop')

  scenario = 'both-fail-cache'
  plan = { primary: 'fail', backup: 'fail' }
  const preserved = JSON.parse(backup.cache)
  const staleAt = Date.now() - MAX_AGE_MS - 1000
  const staleDate = new Date(staleAt).toISOString().slice(0, 10)
  const canSeedExpired = staleDate >= builtinDate
  if (canSeedExpired) {
    preserved.snapshot.fetchedAtMs = staleAt
    preserved.snapshot.date = staleDate
    await seedCache(preserved)
  }
  await navigate()
  if (!canSeedExpired) {
    await waitFx('cache')
    // 若当前 UTC 时间不足 6h，使用真实 online 恢复事件强制重试，避免伪造未来获取时间。
    await evaluate(() => window.dispatchEvent(new Event('online')))
  }
  await waitFx('cache', true)
  const failedCache = await state(canSeedExpired ? 'expired-cache-both-fail' : 'online-cache-both-fail')
  budgetChecks('双源失败保留缓存', failedCache, 215, 210, '4/5')
  metadataChecks('双源失败保留缓存', failedCache, 'cache', true, '更新失败，使用缓存报价', preserved.snapshot.date)
  check('双源失败：保留原缓存获取时间/日期/值，没有把失败保存为新报价', JSON.stringify(JSON.parse(failedCache.cache)) === JSON.stringify(preserved))
  requestChecks('双源失败保留缓存', 1, 1)
  const failedRequestCount = requests.length
  await sleep(400)
  check('双源失败：不会立即重复请求形成刷新风暴', requests.length === failedRequestCount)
  await screenshot('04-cache-failed-desktop')
  for (const width of [320, 390]) {
    for (const dark of [false, true]) {
      await viewport(width, 900, dark)
      await sleep(450)
      const mobile = await state(`cache-failed-${width}-${dark ? 'dark' : 'light'}`)
      const info = mobile.info
      check(`窄屏 ${width}/${dark ? '暗' : '亮'}：实际视口和颜色模式正确`, mobile.viewportWidth === width && mobile.dark === dark)
      check(`窄屏 ${width}/${dark ? '暗' : '亮'}：日期、失败和缺报价说明完整，没有水平裁切`, !!info?.visible && info.text.includes('更新失败，使用缓存报价') && info.text.includes(preserved.snapshot.date) && info.text.includes('1 种币种缺少报价，未计入') && !mobile.overflow && info.x >= -1 && info.right <= width + 1 && info.scrollWidth <= info.clientWidth + 1 && info.parts.every((part) => !part.clipped && part.x >= info.x - 1 && part.right <= info.right + 1 && part.y >= info.y - 1 && part.bottom <= info.bottom + 1), JSON.stringify(info))
      budgetChecks(`窄屏 ${width}/${dark ? '暗' : '亮'} 缓存回退`, mobile, 215, 210, '4/5')
      check(`窄屏 ${width}/${dark ? '暗' : '亮'}：两个金额没有省略截断`, mobile.budgets.every((block) => !block.numberClipped))
      await screenshot(`05-cache-failed-${width}-${dark ? 'dark' : 'light'}`)
    }
  }
  await viewport()

  scenario = 'both-fail-builtin'
  await clearCache()
  nodes = BUILTIN_ONLY
  plan = { primary: 'hold', backup: 'fail' }
  await navigate()
  await waitBudget()
  await waitFor((selector) => document.querySelector(selector)?.getAttribute('data-fx-loading') === 'true', INFO_SELECTOR)
  const builtinBefore = await state('builtin-before-failure')
  await release('primary', { error: 'fixture unavailable' }, 503)
  await waitFx('builtin', true)
  const failedBuiltin = await state('both-fail-builtin')
  metadataChecks('双源失败无缓存', failedBuiltin, 'builtin', true, '更新失败，使用内置报价', builtinDate)
  check('双源失败无缓存：两个预算保留有限内置数值而非空值或零', ['月度预算', '剩余价值'].every((title) => Number.isFinite(amount(failedBuiltin, title)) && amount(failedBuiltin, title) > 0 && amount(failedBuiltin, title) === amount(builtinBefore, title)) && failedBuiltin.budgets.every((block) => block.foot.startsWith('2 台')), JSON.stringify(failedBuiltin.budgets))
  check('双源失败无缓存：剩余价值仍遵守半周期口径，不伪造成功缓存', Math.abs(amount(failedBuiltin, '剩余价值') - ((amount(failedBuiltin, '月度预算') - 20) / 2 + 10)) <= 0.011 && failedBuiltin.cache === null)
  requestChecks('双源失败无缓存', 1, 1)
  await screenshot('06-builtin-failed-desktop')

  scenario = 'invalid-manual-unknown'
  await clearCache()
  nodes = [node(61, '未知币报价无效', 'XYZ', 10), node(62, '人民币', 'CNY', 20)]
  exchangeRates = 'XYZ=NaN\nUSD=-1'
  plan = { primary: 'fail', backup: 'fail' }
  await navigate()
  await waitFx('builtin', true)
  const invalid = await state('invalid-manual-unknown')
  budgetChecks('非法手工未知币', invalid, 20, 10, '1/2')
  check('非法手工未知币：缺报价和非法输入均明示，不以默认 1/0 计入', invalid.info.text.includes('忽略 2 项无效自定义汇率') && invalid.info.text.includes('1 种币种缺少报价，未计入') && invalid.budgets.every((block) => block.hint.includes('XYZ 没有汇率，未计入')))

  scenario = 'cny-only'
  await clearCache()
  nodes = CNY_ONLY
  exchangeRates = ''
  const beforeCny = requests.length
  await navigate()
  await waitBudget()
  const cnyOnly = await state('cny-only')
  budgetChecks('仅人民币', cnyOnly, 20, 10, '1')
  check('仅人民币：没有多余汇率状态或缓存', cnyOnly.info === null && cnyOnly.cache === null)
  await noRequestCheck('仅人民币', beforeCny)

  for (const mode of ['summary', 'both', 'groups', 'none']) {
    scenario = `non-finance-${mode}`
    await clearCache()
    nodes = MIXED
    listTop = mode
    const before = requests.length
    await navigate()
    await noRequestCheck(`非预算布局 ${mode}`, before)
    const nonFinance = await state(scenario)
    check(`非预算布局 ${mode}：无两预算与汇率状态`, nonFinance.budgets.length === 0 && nonFinance.info === null && nonFinance.nodes === MIXED.length)
  }
  scenario = 'once-only'
  await clearCache()
  listTop = 'budget'
  nodes = [node(71, '一次性美元', 'USD', 10, 'once')]
  const beforeOnce = requests.length
  await navigate()
  await waitBudget()
  await noRequestCheck('只有一次性费用', beforeOnce)
  const once = await state('once-only')
  check('只有一次性费用：两预算保持空值，不折算成零或月费，也不显示虚假汇率状态', once.budgets.length === 2 && once.budgets.every((block) => block.number === '—') && once.info === null && once.cache === null, JSON.stringify(once.budgets))
}
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  base = `http://127.0.0.1:${server.address().port}`
  const profile = join(OUT, 'chrome-profile')
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--no-proxy-server', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  chrome.on('error', (error) => { chromeError = error })
  let wsUrl
  for (let i = 0; i < 100 && !wsUrl; i++) {
    if (chromeError) throw chromeError
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((page) => page.type === 'page')?.webSocketDebuggerUrl
    } catch { /* 等待 Chrome 写入调试端口。 */ }
    if (!wsUrl) await sleep(200)
  }
  if (!wsUrl) throw new Error('Chrome 未提供 CDP；profile 已保留')
  ws = new WebSocket(wsUrl)
  await new Promise((resolveOpen, reject) => { ws.onopen = resolveOpen; ws.onerror = () => reject(new Error('CDP 连接失败')) })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { const call = pending.get(message.id); pending.delete(message.id); call.resolve(message) }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    else if (message.method === 'Fetch.requestPaused') intercept(message.params).catch((error) => { if (!closing) interceptErrors.push(error.stack || String(error)) })
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await viewport()
  console.log(`本地夹具 ${base}；输出 ${OUT}`)
  await runChecks()
  check('所有外部请求限于真实白名单URL，未携带凭据、来源页或节点内容', requests.length > 0 && requests.every((request) => request.kind !== 'unexpected' && request.method === 'GET' && !request.authenticated && request.referrer === null && !request.hasPostData), JSON.stringify(requests.map(({ url, method, authenticated, referrer, hasPostData }) => ({ url, method, authenticated, referrer, hasPostData }))))
  check('验收期间无未捕获页面异常与CDP拦截错误', exceptions.length === 0 && interceptErrors.length === 0, [...exceptions, ...interceptErrors].join(' ; '))
} catch (error) {
  check('每日汇率浏览器回归完成', false, error.stack || String(error))
} finally {
  closing = true
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ output: OUT, dist: DIST, base, urls: { primary: PRIMARY_URL, backup: BACKUP_URL }, cacheKey: CACHE_KEY, results, evidence, requests, localRequests, exceptions, interceptErrors }, null, 2))
  writeFileSync(join(OUT, 'checks.log'), results.map((result) => `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' — ' + result.detail : ''}`).join('\n') + '\n')
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP 已关闭')) }
  pending.clear()
  ws?.close()
  chrome?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
}
console.log(`结果：${results.filter((result) => result.ok).length} 通过，${results.filter((result) => !result.ok).length} 失败；报告 ${join(OUT, 'report.json')}`)
if (results.some((result) => !result.ok)) process.exitCode = 1
