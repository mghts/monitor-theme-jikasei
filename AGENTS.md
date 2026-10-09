# 项目约定

- 使用简体中文沟通；代码标识符、命令、文件名和原始日志保持原语言。
- 当前维护与发布仓库为 `https://github.com/mghts/monitor-theme-jikasei`，默认分支为 `master`。
  `origin` 指向此 fork，`upstream` 保留原作者仓库 `https://github.com/akanotanin/monitor-theme-jikasei`。
- 保留原主题作者 `akanotanin` 的署名、上游来源与 `LICENSE` 中的 MIT 版权和许可。
  安装包的 `theme.json.url`、页脚源码链接及其验收脚本应指向当前 fork。

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
