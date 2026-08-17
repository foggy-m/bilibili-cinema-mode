# 🎬 B站影院模式 (Bilibili Cinema Mode)

> 🍿 将 Bilibili 分 P 与合集视频无缝整合为一部沉浸式电影体验的 Chrome 浏览器扩展（Manifest V3）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tests](https://img.shields.io/badge/tests-32%20passed-brightgreen.svg)](tests/unit.test.js)

---

## ✨ 核心特性

- 🎞️ **全剧统合进度条**：将所有分P或合集视频的总时长合并为统一时间线，支持分P分界标记、章节分段着色、跨P点击/拖拽/键盘跳转。
- ⚡ **字节级无缝预加载（秒开切P）**：后台自动预取下一分P视频流，在内存中进行字节切片合成（206 响应），彻底告别切集黑屏等待。
- 🧊 **冻结帧过渡与音量淡入淡出**：切集瞬间冻结前一分P末帧至 Canvas 遮罩，新分P首帧渲染后平滑淡出，伴随音量渐变过渡。
- 🎭 **沉浸式影院界面**：自动隐藏播放器内外杂乱的分P列表、推荐弹窗与干扰元素；支持关灯模式与右上角水印淡化。
- 🎨 **10 种精美进度条主题样式**：
  - 🌌 **极光 (Aurora)**：北欧幻彩翡翠与碧蓝紫罗兰极光流光，搭配星芒钻石滑块与流光微晕。
  - 🌅 **暮色 (Sunset Glow)**：暖调落日红霞与流金余晖，温润护眼、沉浸感拉满。
  - ⚡ **赛博 (Cyberpunk)**：赛博矩阵能量脉冲光带与矩阵扫描线，科幻电光粒子质感。
  - 🌸 **樱粉 (Sakura)**：B站经典萌系樱花流光与珍珠白滑块，番剧与日常视频绝配。
  - 🌊 **流光 (Flow)**：动态扫光波浪流光，平滑无缝光泽。
  - 🔮 **霓虹 (Neon)**：赛博霓虹激光呼吸脉冲，高亮发光边缘。
  - 🎞️ **胶片 (Film)**：复古 35mm 电影胶片齿孔与暖金胶片色调。
  - 📑 **章节 (Chapter)**：多分 P 独立区间交替分段着色，集数边界一目了然。
  - 💎 **极简 (Minimal)**：极致纤细悬浮线，干净无干扰。
  - 🔷 **经典 (Classic)**：B站经典主题青蓝色调。
- 🖼️ **进度条悬停画面预览**：鼠标悬停进度条时即时展示对应时间点的分镜缩略图（Bilibili Videoshot 雪碧图）与分P标题。
- ⏱️ **记忆播放进度与跳过片头片尾**：跨会话记忆观影进度；支持全局/按视频独立设置片头片尾跳过，以及按电影时间线标记跳过指定片段。
- ☁️ **跨标签页与跨设备同步**：播放设置、跳过片段与观影记录通过 `chrome.storage.sync` 自动跨设备多端同步。
- 🪟 **多功能 Popup 弹窗**：支持快速启停影院模式、继续播放当前影片、查看最近观影历史与视频收藏夹。

---

## 🚀 安装指引

### 方式：以开发者模式加载

1. 下载或 Clone 本仓库代码到本地：
   ```bash
   git clone https://github.com/<你的用户名>/bilibili-cinema-mode.git
   ```
2. 打开 Google Chrome 或 Edge 浏览器，访问扩展管理页面：
   - Chrome：地址栏输入 `chrome://extensions/`
   - Edge：地址栏输入 `edge://extensions/`
3. 开启右上角的 **「开发者模式」** (Developer mode)。
4. 点击左上角的 **「加载已解压的扩展程序」** (Load unpacked)。
5. 选择下载或解压后的插件文件夹根目录即可。
6. 打开任意 B 站多分 P 视频或合集视频页面（如 `https://www.bilibili.com/video/BV...`），插件将自动激活影院模式！

---

## ⌨️ 快捷键说明

| 快捷键 | 功能 |
|---|---|
| `Alt + C` | 快速切换开启 / 关闭影院模式 |
| `Alt + L` | 快速切换开启 / 关闭关灯模式 |
| `Alt + [` | 标记当前时间点为跳过片段起点 |
| `Alt + ]` | 标记当前时间点为跳过片段终点 |
| `←` / `→` (聚焦进度条时) | 前进 / 后退 10 秒 |
| `PageUp` / `PageDown` | 前进 / 后退 60 秒 |
| `Home` / `End` | 跳转至全剧开头 / 结尾 |

---

## 🏗️ 技术架构

本项目遵循 Chrome 扩展 Manifest V3 规范，采用纯原生 JavaScript / CSS 实现，无第三方运行时依赖。

```
├── manifest.json         # Manifest V3 配置文件
├── background.js         # Service Worker 后台脚本（标签页管理与弹窗 API）
├── player-bridge.js      # MAIN world 脚本（接管播放器内核、playurl 拦截与字节级预取）
├── cinema-utils.js       # 纯函数工具库（时间换算、sidx 解析、Range 解析、章节着色计算）
├── cinema-core.js        # 核心状态机、配置持久化与跨标签页同步
├── cinema-player.js      # 播放器生命周期、无缝切P调度与 Canvas 冻结帧渲染
├── cinema-ui.js          # 底部进度条接管、6种主题样式、悬停雪碧图预览与设置面板
├── cinema-skips.js       # 跳过片段标记与区间碰撞检测
├── content.js            # 内容脚本引导与双世界 (CustomEvent) 消息通道
├── content.css           # 影院模式样式体系、设计令牌与动效
├── popup.html / js / css # 工具栏弹窗（历史记录、收藏夹与快捷开关）
└── tests/unit.test.js    # Node.js 原生测试套件（32 个纯函数与算法单测）
```

### 双世界通信设计
- **MAIN World (`player-bridge.js`)**：注入页面主上下文，负责访问播放器底层 `window.player` API，拦截 `playurl` 响应并在本地合成 206 字节流。
- **ISOLATED World (`content.js` + `cinema-*.js`)**：运行在隔离沙箱，负责 DOM 构建、事件绑定、安全存储 (`chrome.storage`) 与 UI 渲染。
- 两者通过定制的 `CustomEvent` 协议进行高性能、零污染的双向通信。

---

## 🧪 单元测试

本项目包含 32 项核心算法与纯逻辑测试用例（覆盖时间格式化、前缀和时间线映射、sidx 媒体索引解析、206 Range 覆盖判定、章节色彩插值等）：

```bash
npm test
# 或
node --test tests/unit.test.js
```

---

## 🔒 隐私与安全声明

- **零数据上报**：本扩展不包含任何数据统计、分析埋点或外部远程服务器请求。
- **本地存储**：所有配置、跳过片段标记与观影历史均保存在浏览器本地或用户本人的 Chrome 账号同步云（`chrome.storage.sync`）。
- **权限极简**：仅请求 `storage`（本地与同步存储）和 `tabs`（播放完毕自动关闭标签页可选功能）权限。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
