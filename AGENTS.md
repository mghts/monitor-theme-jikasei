# 项目约定

- 使用简体中文沟通；代码标识符、命令、文件名和原始日志保持原语言。
- 当前维护与发布仓库为 `https://github.com/mghts/monitor-theme-jikasei`，默认分支为 `master`。
  `origin` 指向此 fork，`upstream` 保留原作者仓库 `https://github.com/akanotanin/monitor-theme-jikasei`。
- 保留原主题作者 `akanotanin` 的署名、上游来源与 `LICENSE` 中的 MIT 版权和许可。
  安装包的 `theme.json.url`、页脚源码链接及其验收脚本应指向当前 fork。

## 接手项目

- 先读本文件与 `README.md`，执行 `git status --short --branch`，确认当前分支、未提交改动及任务范围。
  询问、评审或方案讨论先回答；用户明确要求修改时再编辑文件，避免把讨论变成实现。
- 当前版本从 `package.json`、`theme.json` 和 `package-lock.json` 读取，不在本文件重复维护。
  近期变化查 `git log`；是否已发布、是否为最新版本须核对 GitHub Release 与远端 tag。
- `README.md` 记录安装方法和完整产品行为；下列入口及口径用于定位代码、避免回归。
  源码变化后应同步相关说明，不把旧聊天、临时截图或 `/tmp` 报告当作永久状态来源。
- Hub 版本及安装状态不能由主题版本推断。核查兼容性时阅读指定版本的官方发布说明和源码，
  区分源码核对、夹具测试和实际 Hub 验证；匿名接口无权查询时，不宣称已确认线上版本。

## 主要代码入口

| 模块 | 文件入口 |
|---|---|
| 页面、筛选与详情入口 | `src/App.tsx`；`src/lib/search.ts` |
| 公开接口、实时更新与降级 | `src/lib/api.ts`；`src/lib/transport.ts` |
| 3D / 2D 地图、信标与地区 | `src/components/Globe.tsx`；`src/lib/globe.ts`；`src/lib/map.ts`；`src/lib/world.ts` |
| 首页节点卡片与延迟图 | `src/components/NodeCard.tsx`；`src/components/Latency.tsx` |
| 详情图表、路径与历史请求 | `src/components/NodeDetail.tsx`；`src/components/Chart.tsx`；`src/components/ChartTooltip.tsx`；`src/lib/chart-path.ts`；`src/lib/resource-history.ts`；`src/lib/history.ts`；`src/lib/ranges.ts` |
| 概览、预算与读数宽度 | `src/components/Summary.tsx`；`src/lib/summary.ts`；`src/lib/money.ts`；`src/lib/speed-history.ts` |
| 自动汇率、离线报价与币种清单 | `src/lib/exchange-rates.ts`；`src/lib/use-exchange-rates.ts`；`src/lib/exchange-rates-snapshot.ts`；`src/lib/currency-codes.ts` |
| 设置、默认值与校验 | `theme.json`；`src/lib/site-settings.ts`；`src/lib/theme-config.ts`；`scripts/check-config.mjs` |
| 构建、主题包与发布 | `package.json`；`scripts/package.mjs`；`scripts/package.test.mjs`；`.github/workflows/release.yml` |

## 必须保留的行为与口径

- 地图默认为旋转的 3D；扫掠经线与地球共用暂停时间，恢复不能跳跃。
  同地点合并为一个信标，悬停展示全部成员，点击多成员信标先选择节点；信标与命中区随缩放变化。
  3D 保留每个成员的名称引线但信标旁不显示台数；2D 不显示两侧名称引线；均不画节点装饰连线。
  未确认城市时展示国家或地区全名，不能把国家坐标当作已确认城市。
- 延迟线形由同一主题设置同步控制首页、浮层、紧凑展开及详情；连接断点和平滑只改变显示，
  不补造延迟值、不抹去丢包与无响应。削峰是独立选项。
- Monitor 1.4.1 增加 `swap_used`、`tcp`、`udp`、`procs` 历史字段。新增序列是区间均值，
  计数由 Hub 取整；零值有效，缺失或非法值保留断点，旧 Hub 缺字段时隐藏对应图并提示。
  TCP / UDP 独立处理缺测、共用一图；计数轴使用整数，Swap 量程覆盖当前容量和历史峰值。
- 概览、预算和节点列表共用分组 → 地区 → 搜索后的结果；地图保留当前分组的全部节点与地区，
  不缩成搜索或地区筛选后的子集。预算排除零价和一次性买断；无有效到期信息的节点仅不计入剩余价值。
  计费台数可以少于总节点数，不能为凑齐台数补价格或假汇率。
- 月度预算按周期月数摊销；支持 `1m`–`1200m`。剩余价值封顶于一个周期价格，属于估算：
  命名年付 / 两年付 / 三年付及 `12m` / `24m` / `36m` 用 365 / 730 / 1095 天，其他自定义月数每月按 30 天。
  无效或空周期保留按月付回退。大额读数须检查真实文字宽度，不能仅凭取整的 `scrollWidth/clientWidth` 判定未裁切。
- 汇率为无需密钥的每日参考价，不能称为秒级实时行情；显示原始报价日期与来源。
  正常每 6 小时及跨 UTC 日期检查更新，失败 15 分钟后重试；镜像、有效缓存和离线报价按现有顺序回退。
  `CODE=人民币汇率` 的人工值优先；支持范围以币种清单和有效报价为准，缺价明确提示未计入。
  仅需自动折算外币时请求报价，旧日期不能覆盖较新的有效报价。
  请求只获取固定 CNY 基准的完整表，不发送节点信息、价格或认证；保留响应大小、超时、缓存与报价校验。
- 访客偏好存储失败时当前会话仍可用；文本按纯文本展示，不能把节点名称、备注等直接插入 HTML。
  WebSocket 失败或被限流时保留 REST 降级及恢复逻辑。

## 检查与浏览器验收

- 发布 workflow 使用 Node.js 24；本机运行时须支持直接执行 `.ts` 和原生 `WebSocket`，并通过相同检查。
  必做命令仍是 `npm run lint`、`npm test`、`npm run check` 和 `npm run package`。
- 在新的空临时副本构建，保留原工作区 `dist/` 与 `release/`。优先独立安装依赖；复用本机依赖时，
  只链接 `node_modules` 的顶层依赖条目，排除 `.tmp`、`.vite`、`.vite-temp`、`.cache`，让副本独立生成缓存。
  不要链接整个 `node_modules`，也不要在复用链接的目录执行会重建依赖的 `npm ci`。
  macOS 打包使用 `COPYFILE_DISABLE=1 npm run package`，避免 AppleDouble 文件混入包。
- 浏览器验收按改动范围选择，需要本机 Chrome / Chromium 和可监听的 localhost 端口。
  以下命令在已构建的临时副本根目录执行；每轮保留独立截图、JSON 报告、日志和浏览器 profile：

  ```sh
  CHART_DIST="$PWD/dist" node tools/verify_detail_charts.mjs
  node tools/verify_summary.mjs 5321
  FX_DIST="$PWD/dist" node tools/verify_exchange_rates.mjs
  ```

  资源 / 延迟图修改选第一项，概览 / 预算 / 筛选 / 读数布局修改选第二项，汇率修改选第三项。
  Summary 从当前目录的 `dist/` 读取，HTTP 端口默认 5321、CDP 为端口 + 4000；占用时换一个同时可用的端口。
  预算专项可用 `node tools/verify_summary.mjs 5321 --custom-only`，不能省略前面的端口参数。
  图表工具可用 `SHOT_DIR` 指定新的证据目录；汇率工具的第一个参数可指定证据父目录。
  Summary 的浏览器覆盖变量为 `CHROME`，汇率工具为 `CHROME_PATH`；图表工具自动查找已列出的浏览器路径。
- 本地夹具不需要登录或修改真实 Hub；汇率验收拦截第三方请求，其通过不能证明公开汇率源当前可用。
  线上只读核查与夹具结果分别记录，不能把浏览器模拟当成真实 Hub 版本验证。
- 当前 lint 已有 4 条警告：`tools/verify_latency_range.mjs` 的 `no-useless-escape` 一条，
  `src/App.tsx` 的 `react(immutability)` 两条与 `react(set-state-in-effect)` 一条。
  这是交接基线，不是跳过检查或忽略新增告警的许可；以本轮实际输出为准，修复后更新本段。

## 每批修改后的发布

- 用户已授权默认在每完成一批修改后发布一个新版本；将完成检查、推送和发布作为这批工作的组成部分。
- 缺陷修复递增 patch，新增兼容功能递增 minor，破坏兼容性的改动递增 major。
  同步 `package.json`、`theme.json`、`package-lock.json` 的版本，使用不带 `v` 的数字 tag `x.x.x`。
- 完成相关回归检查、`npm run lint`、`npm test`、`npm run check`、构建与主题包内容校验后，
  提交并推送 `master` 与数字 tag 至 `origin`，发布 GitHub Release。
- Release 必须包含可安装的 `theme.tar.gz`、版本化主题包与各自的 SHA-256 校验文件；
  确认资产可下载，发布成功后向用户报告版本和链接。检查或发布失败须明确报告，不宣称已完成。
- 发布主题包不自动修改、部署或升级线上探针；线上操作需用户另外明确授权。

## 保留文件与产物

- 不覆盖用户已有改动。修改前阅读相关文件，改动保持集中，保留现有项目风格。
- 禁止直接删除目录或批量删除文件；确有必要时须先列出目标、原因、影响与恢复方式，逐次取得用户明确授权。
- 构建或打包前检查已有 `dist/` 和发布产物。优先在新的空临时副本中验证；
  如需在原工作区重新生成，先将旧产物移动到明确且唯一的备份路径并记录位置，完整保留供恢复。
  不得通过清空输出目录、覆盖或强制重置绕过删除限制。
