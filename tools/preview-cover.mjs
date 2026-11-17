// 生成后台主题卡片的预览封面，使用主题名称与 M 字标，不依赖外部素材。
// 用法：node tools/preview-cover.mjs [输出路径=preview.png] [pure|classic|compact|detailed]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT = process.argv[2] || 'preview.png'
const FORM = process.argv[3] || 'pure'
const W = 1440, H = 810, DPR = 2
const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
if (!CHROME) throw new Error('未找到 Chrome；可设置 CHROME_PATH')
const BANDS = { classic: 'preview-classic.png', compact: 'preview-compact.png', detailed: 'preview-detailed.png' }
if (FORM !== 'pure' && !BANDS[FORM]) throw new Error(`未知形态 ${FORM}`)
const band = BANDS[FORM]
const uri = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#f7f7f4;color:#292824;
font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
body{padding:80px 96px;position:relative}
header{display:flex;align-items:center;gap:24px;color:#77756e;font-size:24px}
.mark{width:64px;height:64px;border-radius:16px}
h1{font-size:${band ? 100 : 150}px;line-height:1.05;letter-spacing:-.055em;font-weight:650;margin-top:${band ? 35 : 120}px}
p{font-size:32px;color:#66645d;margin-top:28px}
footer{position:absolute;left:96px;right:96px;bottom:${band ? 360 : 80}px;padding-top:26px;border-top:1px solid #d8d7d1;
display:flex;justify-content:space-between;align-items:center;font-size:22px;color:#77756e}
.band{position:absolute;left:0;right:0;bottom:0;height:310px;overflow:hidden;border-top:1px solid #d8d7d1}
.band img{width:100%;display:block}
</style><body>
<header><img class="mark" src="${uri('preview-src/site-icon.png')}" alt=""><span>mghts / Monitor 主题</span></header>
<h1>${escape(meta.name)}</h1>
<p>节点地图、监控图表与计费概览</p>
<footer><span>五种列表布局 · 默认 / Gruvbox · 桌面 / 手机</span><span>Monitor Theme</span></footer>
${band ? `<div class="band"><img src="${uri(band)}" alt=""></div>` : ''}
</body></html>`
const dir = mkdtempSync(join(tmpdir(), 'monitor-m-cover-'))
const page = join(dir, 'cover.html')
writeFileSync(page, html)
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--force-device-scale-factor=${DPR}`, `--window-size=${W},${H}`,
  `--user-data-dir=${join(dir, 'profile')}`, `--screenshot=${resolve(OUT)}`, new URL(`file://${page}`).href,
], { stdio: 'pipe' })
const buf = readFileSync(OUT)
const size = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
if (size !== `${W * DPR}x${H * DPR}`) throw new Error(`输出尺寸 ${size}，应为 ${W * DPR}x${H * DPR}`)
if (buf.length < 20000) throw new Error(`输出只有 ${buf.length} 字节，需要检查封面渲染`)
console.log(`${OUT}  ${size}  ${(buf.length / 1024).toFixed(0)}KB  形态=${FORM}`)
