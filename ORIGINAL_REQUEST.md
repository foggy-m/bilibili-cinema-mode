# Original User Request

## 2026-08-17T10:20:44Z

This is a single self-contained fix; keep it small and focused.

B站影院模式扩展（bilibili-cinema-mode）进度条重构：移除顶部悬浮进度条与角标，将影院模式的核心功能（全剧多P合并总时间线、分P分界标记、跨P拖拽跳转、悬停视频分镜缩略图预览、6种自定义主题样式、跳过片段标记）深度集成并无缝覆盖至播放器底部的原生控制栏进度条区域。

Working directory: d:/bilibili-cinema-mode
Integrity mode: development

## Requirements

### R1. 移除顶部进度条及顶部角标
- 移除位于播放器顶部的 `#cinema-progress-bar`、`#cinema-time-label`、`#cinema-part-label` 等顶部悬浮元素，彻底消除顶部界面的视觉不协调与遮挡。

### R2. 底部控制栏进度条接管与多P时间线统合
- 接管/无缝覆盖 B 站播放器底部的原生进度条容器（如 `.bpx-player-progress-wrap` 或 `.bpx-player-control-bottom` 相应层级）：
  - 进度条宽度与位置严格契合原生底栏，跟随原生控制栏一同响应 hover 自动展开与淡入淡出；
  - 进度条总量程映射为全剧多P累计总时长（`totalDuration`），实时播放进度反映跨分P累计时间；
  - 同步更新底栏时间文本显示为全剧时间（例如 `已播总时间 / 全剧总时长`）；
  - 支持在底部进度条上点击、拖拽（Scrubbing）以及键盘（方向键/PgUp/PgDn/Home/End）无缝跨分P跳转播放（Seek）。

### R3. 影院级样式与扩展特性无缝移植
- 将原顶部进度条的独有特性完整移植到底部进度条中：
  - **分P分界标记**：在底部进度条对应累计时间节点渲染分P标记线（Markers）；
  - **自定义主题样式**：支持全部 6 种样式（经典 classic、流光 flow、极简 minimal、霓虹 neon、胶片 film、章节分段着色 chapter）；
  - **悬停分镜预览**：悬停或拖拽底部进度条时，弹出监视器分镜造型的气泡，展示对应时间点的分P标题、时间码以及 videoshot 雪碧图画面缩略图；
  - **跳过片段标记**：将标记的跳过片段区间正确渲染在底部进度条相应位置。

### R4. 生命周期与兼容性保障
- 在视频切换、SPA 路由跳转、播放器重建、退出影院模式或单P视频时，能够平稳清理并还原原生底栏展示；
- 兼容普通、宽屏、网页全屏和原生全屏等所有显示模式。

## Acceptance Criteria

### 视觉与布局表现
- [ ] 视频顶部不再出现任何进度条或时间/分P角标；
- [ ] 影院模式开启且为多P/合集视频时，底部控制栏展示全剧合并进度条及全剧时间；
- [ ] 底部进度条支持 6 种主题样式的正确渲染与切换，且章节（Chapter）样式能正确按各分P区间分段着色。

### 交互与功能验证
- [ ] 底部进度条点击与拖拽可精准跨分P跳转（Seek）到指定时间点并正常播放；
- [ ] 悬停在底部进度条时，能展示正确的跨P时间码、分P名称以及画面雪碧图缩略图；
- [ ] 键盘聚焦后通过方向键/翻页键能够正常调节全剧进度；
- [ ] 禁用影院模式或处于单P视频时，不破坏B站原生播放与控制栏功能。

### 代码与回归测试
- [ ] 运行 `node --test tests/unit.test.js` 单元测试全部通过；
- [ ] 代码修改保持模块职责清晰（`cinema-ui.js`、`content.css`、`cinema-player.js` 等），无全局变量污染或内存泄漏风险。

## 2026-08-17T10:26:08Z

用户补充了一个新需求：
在视频播放时，B站播放器右上角的 UP 主名字与 Bilibili 水印（.bpx-player-watermark, .bilibili-player-watermark, [class*="watermark"], .bpx-player-top-issue 等）之前设置的去干扰淡化/模糊没有生效（如全屏/大屏下右上角的“UP主名称 bilibili”水印）。请在本次重构中一并检查并修复该问题，确保在开启影院模式或全屏暗场播放时，右上角水印能被正确隐藏/模糊淡化。
