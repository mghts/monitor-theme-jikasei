# Monitor M

[Monitor](https://github.com/monitor-probe/monitor) 的第三方主题，由 [mghts](https://github.com/mghts) 维护。
提供节点地图、资源与延迟图表、月度预算和到期提醒，支持桌面与手机。

[下载安装](https://github.com/mghts/monitor-theme-jikasei/releases/latest) · [使用说明](GUIDE.md) · [反馈问题](https://github.com/mghts/monitor-theme-jikasei/issues)

![Monitor M 桌面预览，使用演示数据](preview-desktop.png?v=1.41.5)

## 功能

- **节点地图**：3D 地球与 2D 世界地图，按分组、地区查看节点，可配置中心节点流向示意。
- **五种布局**：经典、简约、延迟、详细、紧凑，访客可自行切换。
- **监控图表**：资源历史、网络延迟、丢包与缺测提示，支持时间范围和延迟线形设置。
- **计费概览**：按月摊销预算、外币参考汇率、最近到期节点和已过期台数。
- **外观设置**：默认与 Gruvbox 配色，支持亮色、暗色、随系统或按北京时间自动切换。

纯静态前端，读取 Hub 接口；国旗、地图与图标随主题提供。外币自动折算按需请求每日参考汇率。

## 安装与更新

在 Monitor 后台的主题 GitHub 安装入口填写：

```text
https://github.com/mghts/monitor-theme-jikasei
```

也可以从 [最新 Release](https://github.com/mghts/monitor-theme-jikasei/releases/latest) 下载 `theme.tar.gz`，上传至后台安装。
下载同页的 `theme.tar.gz.sha256` 后，可在文件所在目录校验：

```sh
shasum -a 256 -c theme.tar.gz.sha256
```

主题名称现为 **Monitor M**。原先已从本仓库安装的主题可直接更新，已有主题设置和访客偏好继续保留。
仍使用原作者仓库的实例，需要从上述地址安装一次，后续 GitHub 更新才会跟随本仓库。

## 预览

以下截图均由当前版本与演示数据生成，不包含真实服务器信息。

<details>
<summary>地图与手机预览</summary>

| 亮色地图 | 暗色地图 |
|:---:|:---:|
| ![亮色地图](preview-globe.png?v=1.41.1) | ![暗色地图](preview-globe-dark.png?v=1.41.1) |

<img src="preview-mobile.png?v=1.41.5" alt="手机列表页" width="260">

</details>

<details>
<summary>五种列表布局</summary>

| 经典 | 简约 |
|:---:|:---:|
| ![经典布局](preview-classic.png?v=1.41.1) | ![简约布局](preview-plain.png?v=1.41.1) |
| **延迟** | **详细（默认）** |
| ![延迟布局](preview-latency.png?v=1.41.1) | ![详细布局](preview-detailed.png?v=1.41.1) |
| **紧凑** | |
| ![紧凑布局](preview-compact.png?v=1.41.1) | |

</details>

## 设置与说明

站点默认值在后台「主题 → 主题设置」中调整。站点名称和站点图标由 Hub 后台管理。
访客切换布局、地图和明暗只影响自己的浏览器。

完整设置、地图操作、预算口径、图表兼容性与开发方法见 [使用说明](GUIDE.md)。
Swap、TCP / UDP 和进程历史依赖 Hub 提供对应字段；旧 Hub 缺少时会隐藏相应图表并提示。

## 来源与许可

本项目基于 [akanotanin/jikasei](https://github.com/akanotanin/monitor-theme-jikasei) 持续维护，
原主题基于 `monitor-theme-default` v1.1.0。感谢原作者 `akanotanin` 与 Monitor 项目的工作。

采用 [MIT License](LICENSE)，保留上游版权与许可。仓库地址和内部安装标识沿用原名，以兼容已有安装与更新。
