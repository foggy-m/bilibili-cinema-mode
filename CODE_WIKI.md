# B站影院模式 - Code Wiki

> 将 B 站分 P 视频整合为一部完整电影的浏览器扩展（Manifest V3）。
> 核心能力：无缝自动连播、统一进度条、记忆播放进度、合集视频支持。

---

## 1. 项目概览

| 项目 | 说明 |
|---|---|
| 名称 | B站影院模式 - 分P无缝连播 |
| 版本 | 1.12.0 |
| 类型 | Chrome 扩展（Manifest V3） |
| 匹配站点 | `*://www.bilibili.com/video/*` |
| 权限 | `storage`（本地持久化）、`tabs`（关闭标签页） |
| 构建方式 | 无构建步骤，纯静态 JS/CSS，直接加载目录即可 |
| 测试 | `node --test tests/unit.test.js`（注意：传目录 `tests/` 在 Node v24.2.0 会报 MODULE_NOT_FOUND，必须显式指定文件路径） |
| 文件组成 | `manifest.json`、`background.js`（153 行）、`cinema-utils.js`（纯函数库，浏览器/Node 双环境 UMD，353 行）、`cinema-core.js`（配置/状态/存储，754 行）、`cinema-player.js`（播放控制，~1960 行）、`cinema-ui.js`（界面，~1850 行）、`content.js`（引导，~470 行）、`player-bridge.js`（985 行，预取字节合成/P2P 屏蔽）、`content.css`（~1400 行）、`tests/unit.test.js`（34 用例） |

> **v1.1.0 说明**：原单文件 `content.js`（2789 行）已按职责拆分为 5 个模块文件（见 3.3）。
> **v1.2.0 说明**：新增 `cinema-utils.js` 纯函数模块（`cinema-core` 等改为引用其中的 `formatTime`/`buildCumulative`/`overallToPartOffset`/`qualityTextToQn` 等）；新增单元测试（7/7 通过）；新增画面缩略图预览、跨标签页进度同步、播完提示操作、设置面板分组折叠、设置面板位置持久化。
> **v1.3.0 说明**：新增「极致快速切换」（设置项 `fastSwitch`，默认开）：缓存 playurl 响应并在切换时本地秒回（省一个网络往返）；预取覆盖同码率全部编码变体（AVC/HEVC/AV1）；新增 `fetch` 包装兜底（防播放器流请求迁移到 fetch）；切换过渡层改为等待新分 P 首帧真正渲染后再收起（消除黑屏残留；过渡层 v1.11 已整体删除，该等待机制现用于揭冻帧），`tryAutoPlay` 去掉固定 300ms 延迟。
> **v1.4.0 说明**：预取支持合集（season）模式跨 bvid 预取下一集；短分P（<75s）延迟到播放 15 秒后才启动预取（避免与当前播放抢带宽）；playurl 拦截增加 fnval 格式校验（防播放器请求 mp4 等非 dash 格式时被错误拦截）；`qualityTextToQn` 增加 8K/杜比视界/HDR/裸分辨率数字兜底；bridge 流匹配纯逻辑（`matchStreamUrls`/`extractStreamCode`/`isAudioStreamFilename`）抽入 `cinema-utils.js` 并有单测覆盖（13/13）；`cinema-utils.js` 同时注入 MAIN world 供 player-bridge 复用（IIFE 启动时闭包捕获引用，防页面脚本覆盖全局名）；跳过片段与观影记录迁移至 `chrome.storage.sync`（跨设备同步，旧 local 数据自动迁移）。
> **v1.5.0 说明**：预取架构升级为**字节级本地合成**，根治 v1.3/v1.4 黑屏残留。调研确认：bwp 内嵌 dash.js 对每个 m4s 流发多个带 Range 的 XHR 分片请求（init 段 `bytes=0-1021` + 索引段 `bytes=1022-5985` + 按 sidx 逐媒体段，responseType=arraybuffer）；mcdn/PCDN 节点 206 响应**无缓存头**，旧方案"URL 重写命中 HTTP 缓存"对 mcdn 实际无效（仅 upos 节点带 ETag/Last-Modified 可缓存）；流 URL 鉴权以 query 参数 `deadline`（unix 秒，约 2 小时）为准；P2P(WebRTC) 混流层激活时数据绕过 HTTP。因此预取改为：按 segmentBase+sidx 规划 → head 请求一次拉 init+index → sidx 解析 → 媒体段合并 Range 请求 → 字节存入内存 `byteStore`，切换时播放器 Range 请求命中即本地切片合成 206 响应（零网络延迟），URL 重写降级为超范围请求兜底；新增预取就绪指示、悬停按需预取、切 P 链式预取、P2P 混流屏蔽（删 SDK 全局 + 定期重删 `__DASH_P2P_TYPE__`，激进项默认关）、`byteStore` 内存修剪（上限 6 条）；新增 4 个纯函数（`parseSidx`/`buildSegmentPlan`/`parseRangeHeader`/`rangeCovered`，单测 19/19）。
> **v1.6.0 说明**：UI/美术/动效全面升级（设计评审落地 10 项，无播放/预取逻辑变化）：新增 `:root` 设计令牌体系（圆角/投影/字体/主色）；进度条新增第 6 种「章节」分P分段着色样式、scrubbing ghost 悬停预览、键盘可达性（`role=slider` + 方向键 seek，点击/拖拽/键盘三路径共用新抽取的 `seekToOverallTime`）；切P过渡层升级为幕间标题卡（径向渐变暗角 + 宋体大字「第 N 幕」+ 扫光加载线；**v1.11 已随过渡层整体删除**）；所有面板出入场动效化（设置面板/历史面板/关灯遮罩，消灭 `display` 硬切）；暂停时流光/霓虹动画冻结；齿轮按钮 SVG 化 + hover 旋转；霓虹脉冲 `filter:brightness()` 改 opacity（消除每帧重绘）。
> **v1.7.0 说明**：① 修复进度条悬停画面预览（B站已废弃 playurl 的 `data.preview` 字段，改用 `/x/player/videoshot` 接口取雪碧图帧；修复 max-width/max-height 钳制导致 4K 帧裁切；修复失败结果永久缓存导致一次失败永远看不到缩略图——改为失败 60s TTL 可重试 + -412 风控熔断）；② 分P切换新增 Canvas 冻结帧遮罩（切P瞬间把 P1 末帧 drawImage 到 canvas 盖住播放器，P2 首帧就绪后淡出，消除黑屏感——MSE blob 流 drawImage 不污染 canvas）；③ 切P音量淡入淡出（P1 渐出 200ms + P2 就绪后渐入 200ms，声音平滑过渡）；④ 删除影院画幅 letterbox 与影院氛围增强（关灯回退纯压暗、默认改回 false、文案改回"关灯模式"）。
> **v1.7.1 说明**：① 修复设置按钮在原生全屏时消失的问题——进入全屏时把 `settingsBtn`/`settingsPanel` 移入全屏元素子树，退出时移回 `document.body`（原生全屏只渲染全屏元素子树，挂 body 的按钮此前不可见）；② 修复分P在两个分P之间反复跳转的 bug——根因是 `restoreProgress()` 切换分P时未设 `state.switching`，与 B站自带"继续播放"提示的 `?p=` 参数变化 + `onNavigate` 竞态，叠加短分P（2分钟）上 `skipOutro`（5秒）过早触发 `goToNextPart` 形成循环。新增 `state.restoringProgress` 标记，在进度恢复期间阻止 `onNavigate` 抢夺 `currentIndex` 和 `onTimeUpdate` 触发跳过/预取；`restoreProgress` 切换分P加 `state.switching = true`（try/finally 保证清除）；恢复完成后延迟 2 秒清除标记（给 seek 和 B站提示缓冲窗口）。
> **v1.7.2 说明**：① 状态徽章（右下角）改为常驻不自动隐藏，新增 `showStatusBadge` 设置项控制显隐（默认开）——此前 info/success 类型徽章 5 秒后自动淡出导致用户找不到；② 全屏时徽章随设置按钮一同移入全屏元素子树保持可见。
> **v1.7.3 说明**：`skipIntro`/`skipOutro` 默认值 `true` → `false`（按需开启）。根因复盘：默认跳过片头/片尾各 5 秒，对「电影切分成大量短分P」类视频（如 63 段 × 2 分钟）会导致每段开头被跳 5 秒 + 结尾前 5 秒提前切段，每 2 分钟无声丢失约 10 秒内容，用户感知为"自动跳过十几秒"的 bug。已有用户存储的 `cinemaSettings` 不受默认值变更影响（存储值优先），需手动关闭或把片头/片尾时长设为 0。（**R2 起该功能连同片头/片尾跳过整套删除**）
> **v2.0 精简说明**（多批删除/重构，本文档各章节均已同步）：
> - **整模块删除**：氛围光流光（含设置项与 CSS 三块）、闲置暗场（2.5s 无操作淡化水印/顶栏，含相关 class 与监听）、进度条悬停画面预览（videoshot 雪碧图，tooltip 降级为纯文字时间+分P标题）、页面内观影记录面板（含 H 快捷键与收藏星标）、预取就绪指示器（函数从未定义，仅清除调用点）、章节分段着色渐变（含章节进度条样式与两个渐变函数）、设置面板果冻拉伸（含 `.settling`/`.resizing` 与尺寸记忆）、暂停动画冻结 class、结束卡装饰（THE END 徽标/标题/下一作按钮）。
> - **默认值翻转**：`showStatusBadge=false`（错误提示仍临时闪现约 5 秒）、`hidePartUI=false`、`showSettingsBtn=false`。
> - **进度条样式**：10 种 → **classic | minimal** 两种；旧存储中的非法值由白名单消毒自动回落 `classic`。
> - **设置入口**：S 键 / 双击播放器 / popup「打开播放器设置」按钮（消息 `cinema-open-settings`）；原生全屏隐藏悬浮按钮、面板改为 lazy reparent（全屏内打开时挂到 fullscreenElement 子树，关闭/退出全屏时归还 body）。
> - **结束卡**：v1.11 起连同单行「放映结束」提示整体删除——播完无扩展界面。
> - **观影记录**：仅 popup 展示入口；存储层（`readAllHistory`/`writeAllHistory`/`addHistory` 等）完整保留。
> - **R2 第二轮精简**（本批，功能整套删除）：
>   - **跳过指定片段整模块删除**：`cinema-skips.js` 文件删除（manifest 移除注入）、`enableSkips` 键、`cinemaSkip_*` 存储、Alt+[ / Alt+] 快捷键、进度条右键标记、设置面板「剪辑」组全部移除。
>   - **片头/片尾跳过删除**：`skipIntro`/`skipOutro`/`introDuration`/`outroDuration` 键、`state.ioOverride`、`cinemaIntroOutro` 存储与 `getIntroDuration`/`getOutroDuration`、设置面板片头尾输入框移除。
>   - **幕间 ACT 卡删除**：分P切换不再插幕间卡；`showTransition` 设置键、面板开关、ACT/标题/副题/扫光 CSS 全部移除（`showTransition`/`hideTransition` 函数与 `#cinema-transition` 层已随 v1.11 整体删除）；`useSeamlessCover` 因切P淡入淡出仍在用而保留。
>   - **跨设备同步删除**：`deviceSync` 键、`writeSyncProgress`/`pruneSyncProgress`/`retryPrunedSync`、`cinemaProgressSync` 存储、`loadProgress` 的 sync 分支、`onProgressStorageChanged` 的 sync 分支、备份导出 `progressSync` 段与 `importProgressSyncMerge` 移除；**跨标签页 local 同步完整保留**。
>   - **onboarding 引导弹窗删除**：`showOnboarding` 等三个函数、`onboardingDone` 键、全部 `.cinema-onboarding-*` CSS 与复用它的两个 `cinema-history-*` keyframes 一并删除。
>   - **底栏时间仅接管总时长**：`updateBottomTimeDisplay` 不再覆写原生当前时间，只写总时长元素（三套播放器选择器与容器兜底保持不变）。
> **v3 美化收敛说明**（只读设计审计落地，无功能增删）：
> - **状态徽章**：三类消息（info/success/error）统一约 5 秒自动淡出；error 无视 `showStatusBadge` 开关，info/success 仅在开启时闪现。样式 toast 化（去投影、4px 圆角、12px 字号、6×12 padding）。
> - **动效收敛**：面板/分组/caret 弹跳过弹曲线 → 统一 `cubic-bezier(0.16,1,0.3,1)`；删除过渡文字呼吸（`cinema-pulse`）、键帽录制雷达脉冲（`cinema-keycap-radar`）、开关按压 squish；进度条 fill 0.3s→0.18s、悬停长高补 height 过渡、tooltip 空转 transform 修正为 4px 上浮入场；popup 圆点脉冲 2s→2.4s。
> - **设计令牌**：删除未使用 token（`--c-shadow-glow`、`--c-font-display`、`--c-blue`、`--c-radius-sm/md/lg`）；light 主题面板底色微调至 `rgba(18,18,22,.95)`；popup 与页面内开关统一为 32×18/14px 拇指。
> - **暗角收敛**：`#cinema-vignette` 外圈 0.78→0.6、inset shadow 减淡，与关灯遮罩统一 0.5s 过渡。
> **v1.12 禅意收敛说明**（进度条原生观感校准 + 设置项瘦身，18 键 → 面板 2 键）：
> - **进度条原生校准（Part A）**：轨道 `rgba(255,255,255,.16)→.2`、hover 高 8px→6px 且删 height 过渡（瞬时）、fill 删渐变/圆角改纯色 `#00a1d6` 直角、缓冲条 `.14→.5`、圆头阴影减淡、ghost `::before` 预览层整删、minimal 样式整删（仅存 classic）。
> - **存在感时刻状态机**：分P标记常态 `opacity:0`；悬停距最近标记 ≤12px 时 `markers-revealed` 淡入（全部 0.25/最近 0.85，dense 0.15/0.6）；单P内拖拽全隐形，拖拽跨P（`crossing`）时被越过的边界高亮 0.85；tooltip 时间基准按状态机——远离边界/单P内拖拽 = P 内相对时间（原生观感），近边界/跨P拖拽 = 电影总时间 + 分P pill（跨P为 accent 蓝「→ Pn」）。
> - **设置键瘦身（Part B）**：`DEFAULT_SETTINGS` 18 → 3 键（`enabled`/`autoCloseTab`/`lightsOut` 运行时键）。新增 `FORCED_SETTINGS` 常量（`autoPlayNext`/`seamlessMovie`/`seasonMovie`/`preloadNext`/`fastSwitch`/`progressSync` 恒 true、`hidePartUI` 恒 false——用户裁定保持原生分P列表可见）、`SHORTCUT_DEFAULTS`、`CINEMA_OPACITY=0.85`、`CINEMA_P2P_TEMP_MS=4000`；存储旧值由 `applyLoadedSettings` 末尾 `Object.assign(merged, FORCED_SETTINGS)` 覆写。
> - **删除清单**：设置键 `showSettingsBtn`/`showStatusBadge`/`p2pBlock`/`p2pTempMs`/`lightsOutOpacity`/`progressStyle`/`theme`/`shortcuts` 及全部子项；悬浮齿轮按钮（含拖拽与位置持久化）；快捷键编辑器（编辑器/录制/`SHORTCUT_ACTIONS`/`shortcutCapturing` 状态/冲突检测）；备份导入导出（`exportCinemaBackup`/`importCinemaBackup` + 三个 `importXxxMerge` + 面板「数据」组）；六分组折叠架构（`initSettingsPanelGroups` + 相关 CSS）；徽章收敛为纯 error toast（info/success 调用点删除）。
> - **入口不变**：S 键 / 双击播放器 / popup「打开播放器设置」；面板重写为单卡片（☑ 启用影院模式 / ☑ 播完自动关闭标签页 / ☆ 收藏 / 入口提示），标题栏拖动与位置记忆保留，默认位置视口右上 24px。
> - **P2P 临时屏蔽保留**：常驻 `p2pBlock` 删除，切P关键窗口的临时屏蔽机制（`applyTempP2PBlock`，时长 `CINEMA_P2P_TEMP_MS`）自收自发——下发 `p2pBlock:true` 到点显式下发 `false` 恢复，不依赖 `syncBridgeConfig`；`player-bridge.js` 启动 storage 读点一并删除。
> - **主题删键**：`applyCinemaTheme` 永远跟随系统 `prefers-color-scheme`；popup 浅色判断改用 `matchMedia('(prefers-color-scheme: light)')`。
> 本文档第 5 章中的行号仍指向 v1.0.0 的单文件布局，函数名不变，所在文件见 3.3 模块对照表。

### 1.1 功能特性

1. **无缝自动连播**：当前 P 结束自动切换下一 P，播放器不重建、显示模式（普通/宽屏/网页全屏/原生全屏）全程保持
2. **统一进度条（原生观感校准，v1.12）**：整部电影总进度，可点击/拖拽跳转任意分 P 的任意时间点，含分 P 分隔标记、悬停提示（时间+分P标题）、缓冲进度显示与键盘 seek。平时光学上贴近 B 站原生（轨道 .2/4px、hover 6px 瞬时、纯色 #00a1d6 直角 fill、缓冲条 .5）；分P标记常态隐形，仅在悬停近边界（≤12px）或拖拽跨 P 时浮现（存在感时刻状态机），tooltip 在单P内显示 P 内相对时间、跨P/近边界时显示电影总时间+分P pill。无样式选择（minimal 已删，仅存 classic）
3. **隐藏分 P 界面**：`body.cinema-hide-parts` 机制（含 CSS 规则与 `FORCED_SETTINGS.hidePartUI`）已整体移除——v1.12 起 `hidePartUI` 内化恒 false，规则从未激活，后续版本清理为死代码删除（用户裁定：原生分P列表保持可见）
4. **记忆播放进度**：跨会话续播（7 天内有效）；观影记录经 `chrome.storage.sync` 存储（容量上限 100 条），展示入口在扩展 popup
5. **播放设置记忆**：倍速 / 音量 / 画质 / 弹幕开关跨 P、跨会话保持
6. **下一分 P 预加载**：剩余 <60 秒且当前已播放 ≥15 秒时预取下一分P/下一集（合集模式跨 bvid 同样生效），字节级存入内存 `byteStore`，切换时播放器 Range 请求本地切片合成 206 秒开；悬停分P条目与切 P 落地后还会按需/链式预取
7. **合集（UGC Season）支持**：跨 BV 号连播同一合集
8. **播放完毕自动关闭标签页**：可配置（设置面板保留项），10 秒倒计时气泡
9. **关灯模式**：压暗播放器外区域（`CINEMA_OPACITY=0.85` 固定，滑杆已删）；L 键运行时切换
10. **设置跨设备同步**：设置项存于 `chrome.storage.sync`（旧版本地数据自动迁移）
11. **跨标签页进度同步**：同账号多标签页播放同一视频时，本地保存进度后若监听到其他标签页的新进度，且满足"时间超前 + 旧进度较新 + 距上次保存 >5 秒"则顺延，避免重复抢进度
12. **播完无扩展界面**：整部电影播放完毕不显示任何扩展 UI（v1.11 删除结束卡与「放映结束」提示；仅按需压制 B站原生自动连播，可选的播完关标签页倒计时气泡不受影响）
13. **设置面板单卡片（v1.12）**：☑ 启用影院模式 / ☑ 播完自动关闭标签页 / ☆ 收藏当前视频 / 入口提示；无分组无折叠，标题栏拖动与位置记忆保留，默认位置视口右上
14. **设置面板位置持久化**：面板标题栏拖动记忆上次位置（`localStorage.cinemaSettingsPanelPos`）
15. **极致快速切换**：缓存下一 P 的 playurl 响应并在切换时本地秒回（省一个网络往返，且带 fnval 格式校验防误拦截），保证播放器请求的流 URL 与预取一致 → 必命中缓存；配合冻结帧"等首帧再揭"基本消除切换黑屏
16. **观影记录跨设备同步**：history 分块存于 `chrome.storage.sync`（旧 local 数据自动迁移；progress 存 local 走跨标签页机制）
17. **字节级秒开**：预取从"URL 重写+靠浏览器缓存"升级为字节级本地合成——预取字节存入内存 `byteStore`，切换时播放器 Range 请求命中即本地切片合成 206 响应（零网络延迟），URL 重写降级为超范围请求兜底
18. **悬停按需预取**：悬停分P/剧集条目 400ms 后按需预取该集（不占用自动预取槽位），手动跳集同样秒开
19. **切P窗口临时 P2P 屏蔽（v1.12 起仅此形态）**：常驻 `p2pBlock` 已删；切P关键窗口（`CINEMA_P2P_TEMP_MS=4000`）内删除 P2P SDK 全局（`DIYSdk` 等）+ 250ms 定期重删 `__DASH_P2P_TYPE__`，保证首个媒体段命中 byteStore 预取，窗口到点自收自发恢复
20. **键盘 seek**：进度条 `role=slider` + tabindex，←/→/↑/↓ ±10s、PgUp/PgDn ±60s、Home/End；点击/拖拽/键盘三路径共用 `seekToOverallTime`
21. **冻结帧零黑屏切换**：切P瞬间把 P1 末帧冻结到 canvas 上盖住播放器，P2 首帧就绪后淡出——把"黑屏等待"变成"画面保持"（v1.7.0）
22. **切P音量淡入淡出**：切P前 P1 音量渐变到 0、P2 首帧就绪后渐回，声音平滑过渡（v1.7.0）
23. **设置入口**：S 键 / 双击播放器区域 / popup「打开播放器设置」按钮（悬浮齿轮按钮 v1.12 已删）
24. **底栏总时长接管**：原生底栏「总时长」显示为电影总时长，当前时间由 B站原生自走
25. **全局快捷键（硬编码，v1.12 起不可配置）**：N/P 下一上一 P、S 设置、L 关灯、J/K ±10 秒（`SHORTCUT_DEFAULTS`）

---

## 2. 整体架构

### 2.1 架构总览

```mermaid
graph TB
    M[manifest.json<br/>MV3 配置]
    B[background.js<br/>Service Worker]
    C[cinema-core/player/ui + content.js<br/>ISOLATED world · document_idle · 按序注入]
    P[player-bridge.js<br/>MAIN world · document_start]
    S[(chrome.storage.sync<br/>设置/观影记录)]
    SL[(chrome.storage.local<br/>进度/偏好)]
    LS[(localStorage<br/>徽章与设置按钮位置)]
    SS[(sessionStorage<br/>刷新后恢复显示模式)]
    BP[B站播放器<br/>window.player API]

    M --> B
    M --> C
    M --> P
    C -->|chrome.runtime.sendMessage<br/>closeTab| B
    B -->|chrome.tabs.remove| TAB[关闭标签页]
    C <-->|CustomEvent 双向通信<br/>detail 为 JSON 字符串| P
    P -->|window.player.next/prev/goto<br/>getStates| BP
    P -->|playurl API + 直连预取| BP
    C -->|读/写| S
    C -->|读/写| SL
    C -->|读/写| LS
    C -->|读/写| SS
```

### 2.2 双世界通信模型（核心设计）

Manifest V3 的 content script 默认运行在 **ISOLATED world（隔离世界）**，无法访问页面主世界的 `window.__INITIAL_STATE__` 与 `window.player`。因此项目拆分为两个脚本，通过 **页面上的 CustomEvent** 通信：

| 脚本 | 运行世界 | 注入时机 | 职责 |
|---|---|---|---|
| `player-bridge.js` | MAIN（主世界） | `document_start` | 访问 `window.player` 内部 API 切 P、查询显示模式、执行真实网络预取 |
| `cinema-core.js` 等 5 个文件 | ISOLATED（隔离世界） | `document_idle` | 全部业务逻辑、UI、存储、事件驱动（见 3.3 模块拆分） |

**通信约定**：所有事件 `detail` 一律使用 **JSON 字符串**（跨世界最可靠）；请求带随机 `id`，响应回传同 `id` 以配对，并带超时保护（`setTimeout` 兜底）。

### 2.3 视频数据获取三级策略（`extractPageData`）

1. **方案 1（同步快速）**：`parseFromScriptTags()` 解析页面 `<script>` 标签文本中的 `__INITIAL_STATE__=`（用括号计数法提取完整 JSON，兼容字符串内分号）
2. **方案 2（异步）**：`injectPageDataScript()` 注入临时 `<script>` 到页面主世界读取 `__INITIAL_STATE__`，通过 CustomEvent 回传（3 秒超时）
3. **方案 3（最可靠回退）**：`fetchFromAPI()` 调用 B 站公开 API `x/web-interface/view`

任一层成功即停止；全部失败则每 500ms 重试（最多 20 次），仍失败则显示错误状态徽章并不启用。

### 2.4 模式判定规则（`applyParsedData`）

- 视频自身多 P（`pages.length > 1`）→ **分P模式**（合并为一部电影），同时保留合集信息供播完后跳下一部
- 视频单 P → **分P模式但不合并**（合集内每个条目视为独立影片，不做额外合并）
- 合集（`ugc_season`）元数据仅作参考存储，用于跨 BV 连播与历史展示

---

## 3. 模块职责

### 3.1 manifest.json

扩展的声明入口：权限（`storage`、`tabs`）、Service Worker、两个 content script 的匹配规则与运行环境。

| 字段 | 值 |
|---|---|
| `manifest_version` | 3 |
| `permissions` | `["storage", "tabs"]` |
| `background.service_worker` | `background.js` |
| Content Script 1 | `player-bridge.js`，`document_start`，`MAIN` world |
| Content Script 2 | `cinema-utils.js` → `cinema-core.js` → `cinema-player.js` → `cinema-ui.js` → `content.js` + `content.css`，`document_idle`，隔离世界（**按序注入，共享全局作用域**） |
| 匹配 URL | `*://www.bilibili.com/video/*` |

### 3.2 background.js（20 行）

Service Worker，仅一个职责：监听 `chrome.runtime.onMessage` 中的 `{ type: 'closeTab' }` 消息，关闭发送者所在标签页（`chrome.tabs.remove(sender.tab.id)`），异步 `sendResponse({ ok: true })`。

### 3.3 内容脚本模块拆分（v1.1.0，原 content.js 2789 行 → 5 文件）

5 个文件在同一隔离世界**共享全局作用域**，按 manifest 顺序注入。函数声明相互可见（加载期只声明、运行期才调用），因此跨文件调用无需 import。顶层 `let`/`const`（`settings`、`state`、`ui`、`pageDataPromise`、`lastSavedTime`、`DEFAULT_SETTINGS`、`HISTORY_LIMIT`）各文件互不重复。

> **v1.2.0 拆分**：`cinema-utils.js`（第 1 个注入）承载全部纯函数（UMD 风格，浏览器挂 `window` 全局、Node 走 `module.exports`），其余文件通过全局名直接调用；`computeCumulative`/`overallToPartOffset`/`formatTime`/`qualityTextToQn`/`escapeHtml`/`formatRelativeTime` 均已迁移至此并改为纯函数签名（见 `tests/unit.test.js`）。

| 文件 | 职责 | 主要内容 |
|---|---|---|
| `cinema-utils.js` | 纯函数库（浏览器/Node 双环境） | `formatTime`、`formatRelativeTime`、`escapeHtml`、`qualityTextToQn`（按分辨率优先匹配）、`buildCumulative`、`overallToPartOffset`、`parseSidx`、`buildSegmentPlan`、`parseRangeHeader`、`rangeCovered`（v1.5.0 预取规划） |
| `cinema-core.js` | 配置 / 状态 / 工具 / 全部持久化 | `DEFAULT_SETTINGS`、`state`、工具函数、设置（`sync`）、进度、观影记录（含容量上限）、播放偏好的读写、跨标签页进度同步（`onProgressStorageChanged`）、P2P 屏蔽设置（`p2pBlock`）与 `syncBridgeConfig` 下发 `p2pBlock` |
| `cinema-player.js` | 播放控制 | 数据获取三级策略、视频元素查找、显示模式保持、播放设置记忆、预加载（自动 + 悬停按需 `prefetchPartOnDemand` + 切P链式）、自动关闭标签页、视频事件处理、分P切换（含切P冻结帧集成 `freezeFrame`/`unfreezeFrame` + 音量淡入淡出 `fadeOutVolume`/`fadeInVolume`）、进度恢复 |
| `cinema-ui.js` | 界面 | 统一进度条（原生观感校准 + 存在感时刻状态机：悬停提示/拖拽seek/缓冲显示/分P标记浮现）、冻结帧遮罩（`freezeFrame`/`unfreezeFrame`）、设置面板（v1.12 起单卡片：两个开关+收藏+入口提示，标题栏拖动与位置记忆）、状态徽章（纯 error toast）、关灯模式、悬停按需预取（`setupPrefetchUI`/`setupHoverPrefetch`）、键盘 seek（`onProgressBarKeyDown`/`seekToOverallTime`）、全局快捷键（`SHORTCUT_DEFAULTS`） |
| `content.js` | 引导 | SPA 导航监听、播放器容器变化监听（收窄范围）、`init → proceed → onVideoFound` 流水线、`cleanup` 全量重置、注册跨标签页进度同步监听、popup 消息（`cinema-open-settings`）、启动 |

### 3.4 player-bridge.js（863 行）

运行于页面主世界，仅做"content.js 无法直接做的事"。依赖 `cinema-utils.js`（v1.4.0 起同样注入 MAIN world 且在前，IIFE 启动时闭包捕获 `uMatchStreamUrls`/`uExtractStreamCode`/`uIsAudioStreamFilename`/`uParseSidx`/`uBuildSegmentPlan`/`uParseRangeHeader`/`uRangeCovered` 引用，防页面脚本覆盖全局名）：

| 功能 | 事件 | 实现 |
|---|---|---|
| 播放器内部切 P | `__cinema_switch_part__` | 优先 `player.next(false)` / `player.prev(false)`（新版实测 `goto` 无效），旧版兼容 `player.goto(offset, false)`；不重建播放器、保持全屏 |
| 查询显示模式 | `__cinema_get_mode__` | `player.getStates().mainScreen`：0=普通 1=宽屏 2=网页全屏 |
| 下发配置 | `__cinema_config__` | content.js 同步 `fastSwitch` + 当前播放 `currentCid`（拦截时跳过当前分 P）；`p2pBlock` 通道 v1.12 起仅供切P关键窗口临时屏蔽（`applyTempP2PBlock` 下发 true/false）使用 |
| 下一 P/下一集预取 | `__cinema_prefetch__` | 调 playurl API（响应缓存入 `playurlCache`，含 `fnval:'4048'` 与 `deadline` 有效期）→ 按码率码选目标变体、`rankUrls` 排序候选（upos 优先/mcdn 靠后/backup 优先）→ 按 segmentBase+sidx 规划：head 请求一次拉 `0..headEnd`（init+index）→ content-range 解析 totalSize → `parseSidx` → `buildSegmentPlan` → 媒体段合并单 Range 请求 → 字节存入内存 `byteStore`（`pruneByteStore` 上限 6 条），并写 `prefetchTable` 作 URL 重写兜底 |
| XHR 拦截 | 全局包装 | `setRequestHeader` 包装记录 Range；`send` 分支优先级：**playurl 合成 > 字节合成 > URL 重写兜底 > 真实请求**。字节合成：`byteStore` 命中且 Range 被覆盖 → `serveStoredBytes` 本地切片 206（满足 dash.js XHRLoader 契约）；响应属性用 `configurable: true` 的 `defineProperty` 遮蔽、open 清理、abort 防护 |
| fetch 包装 | 全局包装 | playurl 命中缓存返回 `new Response(json, 200)`；字节合成命中返回 `new Response(sliceBuffer, 206)`（content-type/content-length/content-range/accept-ranges 四项头）；未命中走 URL 重写兜底 |
| P2P 屏蔽 | 配置（v1.12 起仅临时窗口） | `applyP2PBlock`：删除 5 个 P2P SDK 全局（`DIYSdk`/`KSLoader`/`PearDownloader`/`YFDashIO`/`xyvp`）+ 250ms 定期重删 `window.__DASH_P2P_TYPE__`（核心每分片请求现读，删掉即回退 XHR）；`restoreRTC` 停定时器；启动 storage 读点 v1.12 已删（常驻 p2pBlock 键不复存在），仅由 `__cinema_config__` 的 `p2pBlock` 字段驱动。**不替换 `RTCPeerConnection`**（构造即抛错会触发 ~2s connectTimeout 悬挂，反而拖慢切P黑屏） |

### 3.5 content.css

| 区块 | 说明 |
|---|---|
| 隐藏分P界面 | 已移除（`body.cinema-hide-parts` CSS 与 `FORCED_SETTINGS.hidePartUI` 为死代码，v1.12 起恒不激活，清理时整段删除）；`cinema-season-mode` 仍用于合集模式标记 |
| 统一进度条（原生观感校准，v1.12） | 播放器底部 4px 悬浮条（轨道 `rgba(255,255,255,.2)`），hover 瞬时增高至 6px；含缓冲层 `#cinema-progress-buffered`（白 .5）、纯色直角 fill `#00a1d6`、10px 白圆头；分 P 分隔标记常态隐形，存在感时刻（`markers-revealed`/`crossing` 状态类）才浮现 |
| 键盘可达性 | `#cinema-progress-bar`：`role=slider` + `tabindex` + aria-valuemin/max/now；`#cinema-progress-bar:focus-visible` box-shadow 焦点环（v1.6.0） |
| 悬停提示气泡 | `#cinema-progress-tooltip`：flex 纵向排列，`.cinema-tooltip-text`（时间点 + 分P pill）纯文字提示；v1.12 起时间基准按状态机（单P内 = P 内相对时间；近边界/跨P = 电影总时间 + pill） |
| 冻结帧遮罩 | `.cinema-freeze-frame`：canvas 元素满幅盖住播放器（`position:absolute`，z-index 150 高于进度条 100，`opacity` 0↔1 0.3s 过渡，`object-fit: contain` 等比缩放，`pointer-events:none`）（v1.7.0；原同表的过渡层条目已随 v1.11 删除） |
| 设置面板（单卡片，v1.12） | 280px 宽、标题栏可拖动、两个开关（enabled/autoCloseTab）+ 收藏按钮 + 入口提示；无分组折叠/无 select/无快捷键编辑器/无数据组 |
| 播放器容器定位 | `position: relative`（不加 `!important`，避免覆盖 B 站网页全屏的 fixed 规则） |
| 状态徽章 | 右下角固定、纯 error toast（v1.12 起 info/success 类与 CSS 已删）；错误信息闪现约 5 秒后自动淡出 |
| 设计令牌 | `:root` 定义 `--c-radius-pill`、`--c-shadow-pop`、`--c-font-sans/mono` 与主题色令牌（v1.6.0；v3 清理未使用令牌） |
| 面板动效 | 设置面板 `.visible` 用 `opacity/transform/visibility` 过渡（.18s，无 JS 改动）；关灯遮罩 `.on` 切换 opacity .5s（v1.6.0） |
| 关闭标签页提示气泡 | 右下角 10 秒倒计时气泡 |

---

## 4. 核心状态与配置

### 4.1 默认设置（`DEFAULT_SETTINGS`，cinema-core.js）

**v1.12 起仅 3 个存储键**；其余 15 个键内化为常量（见下表下方）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoCloseTab` | `false` | 播放完毕自动关闭标签页 |
| `lightsOut` | `false` | 关灯模式——压暗播放器外区域（运行时由 L 键切换） |

**内化常量**（`FORCED_SETTINGS` 面板不再暴露、存储旧值被 `applyLoadedSettings` 末尾覆写）：

| 常量 | 值 | 理由 |
|---|---|---|
| `FORCED_SETTINGS.autoPlayNext` | `true` | 连播是核心价值 |
| `FORCED_SETTINGS.seamlessMovie` | `true` | 冻帧无缝是核心体验 |
| `FORCED_SETTINGS.seasonMovie` | `true` | 合集合并是核心能力 |
| `FORCED_SETTINGS.preloadNext` | `true` | 无形的速度 |
| `FORCED_SETTINGS.fastSwitch` | `true` | 无形的速度 |
| `FORCED_SETTINGS.progressSync` | `true` | 隐形便利 |
| `SHORTCUT_DEFAULTS` | `{ nextPart:'KeyN', prevPart:'KeyP', toggleSettings:'KeyS', toggleLights:'KeyL', seekBack:'KeyJ', seekForward:'KeyK' }` | 默认键位避开 B 站原生冲突，快捷键编辑器已删 |
| `CINEMA_OPACITY` | `0.85` | 关灯压暗（原 lightsOutOpacity 滑杆删除） |
| `CINEMA_P2P_TEMP_MS` | `4000` | 切P窗口临时 P2P 屏蔽时长（原 p2pTempMs） |

**v1.12 已删除的键**：`autoPlayNext`/`hidePartUI`/`seamlessMovie`/`seasonMovie`/`showSettingsBtn`/`showStatusBadge`/`preloadNext`/`fastSwitch`/`p2pBlock`/`p2pTempMs`/`progressStyle`/`lightsOutOpacity`/`theme`/`progressSync`/`shortcuts`（其中 7 个布尔键转入 `FORCED_SETTINGS`，`theme` 转为永远跟随系统，`progressStyle` 固定 classic，`lightsOutOpacity`/`p2pTempMs` 转常量）。

### 4.2 运行时状态（`state`，cinema-core.js）

| 字段 | 类型 | 说明 |
|---|---|---|
| `bvid` | string | 视频 BV 号 |
| `cid` | number | 当前分 P CID |
| `aid` | number | 视频 AID |
| `title` | string | 视频标题 |
| `pages` | array | 分 P 列表：`[{ page, cid, part, duration, vid, weblink }]` |
| `currentIndex` | number | 当前分 P 索引（0-based） |
| `totalDuration` | number | 全部分 P 累计时长（秒） |
| `cumulative` | array | 前缀和：`cumulative[i]` = 前 i 个分 P 总时长，**电影总时间线的基础** |
| `isMultiPart` | boolean | 是否多 P / 合集 |
| `initialized` | boolean | 是否已完成初始化 |
| `switching` | boolean | 切 P 互斥锁，防止竞态 |
| `restoringProgress` | boolean | 进度恢复中标记（v1.7.1）：阻止 onNavigate/onTimeUpdate 在 restoreProgress 期间干扰 currentIndex 与跳过逻辑，恢复完成后延迟 2 秒清除 |
| `video` | HTMLVideoElement | 当前 `<video>` 元素引用 |
| `playerWrap` | HTMLElement | 播放器容器元素 |
| `observer` | MutationObserver | 播放器 DOM 变化观察器（收窄到播放器容器内） |
| `observerTop` | MutationObserver | body 直接子节点观察器（捕获播放器容器整体重建） |
| `mode` | string | `'pages'`（分P模式） / `'season'`（合集模式） |
| `seasonId` | number | UGC Season ID |
| `seasonTitle` | string | 合集名称 |
| `seasonEpisodes` | array | 合集剧集列表：`[{ index, bvid, cid, title, duration, id }]` |
| `displayMode` | string | `'normal'` / `'wide'` / `'web-fullscreen'` / `'fullscreen'` |
| `pic` | string | 视频封面图 URL |
| `prefs` | object | `{ rate, volume, quality, danmaku }` 播放设置记忆 |
| `prefsLoaded` | boolean | 偏好设置是否已加载 |
| `restoringPrefs` | boolean | 是否正在恢复偏好（防误记录） |
| `prefsGuardUntil` | number | 恢复后保护期时间戳 |
| `preloadedCid` | number | 已预取的分 P CID（防重复预取） |
| `preloadFailCount` | number | 预取连续失败计数（≥3 时暂停重试） |
| `preloading` | boolean | 预取进行中（防重入） |
| `onDemandPrefetch` | object | 按需预取去重表：`{ [cid]: 上次预取时间戳 }`（同 cid 10 分钟内不重复；v1.5.0） |
| `prefetchUiHooked` | boolean | 预取 UI 事件是否已注册（防重复注册，cinema-ui.js 维护） |
| `watchAccum` | number | 本次会话累计观看秒数 |
| `lastWatchTick` | number | 上次 timeupdate 的视频时间 |
| `closeTipShown` | boolean | 本次会话是否已提示过自动关闭 |
| `closeTipTimer` | number | 倒计时定时器 ID |
| `seekDragging` | boolean | 进度条是否处于拖拽 seek 中 |
| `lastSavedProgressTs` | number | 上次保存进度的本地时间戳（跨标签页同步判定"旧进度"用） |
| `progressSyncHandler` | function | `chrome.storage.onChanged` 监听器引用（content.js 注册/移除） |

### 4.3 UI 引用（`ui`，cinema-ui.js）

| 字段 | 说明 |
|---|---|
| `bar` | 统一进度条容器 `#cinema-progress-bar` |
| `fill` | 进度条填充 `#cinema-progress-fill` |
| `buffered` | 缓冲进度层 `#cinema-progress-buffered` |
| `markers` | 分 P 分隔标记层 `#cinema-progress-markers` |
| `tooltip` | 悬停预览气泡 `#cinema-progress-tooltip` |
| `timeLabel` | 总时间标签 `#cinema-time-label` |
| `partLabel` | 分 P 指示器 `#cinema-part-label` |
| `settingsPanel` | 设置面板 `#cinema-settings-panel`（v1.12 起单卡片，无设置按钮） |
| `statusBadge` | 状态徽章 `#cinema-status-badge`（v1.12 起纯 error toast） |
| `closeTip` | 自动关闭提示气泡 `.cinema-close-tip` |
| `lightsOut` | 关灯模式遮罩 `#cinema-lights-out`（v1.6.0 起常驻元素，`.on` class 切换） |
| `vignette` | 电影胶片暗角遮罩 `#cinema-vignette`（`.active` class 切换） |
| `freezeCanvas` | 冻结帧 canvas 元素 `#cinema-freeze-frame`（v1.7.0） |
| 标记 `data-index`/`data-pct` | 分P标记元素上的边界下标与水平百分比（v1.12，`nearestMarkerInfo` 最近标记距离计算用）；`--hover-pct` ghost 变量已随 v1.12 删除 |

---

## 5. 关键函数说明

> v1.7.2 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `showStatusBadge` | ui | 三类消息统一约 5 秒自动淡出（v3）；error 无视 `showStatusBadge` 设置临时显示，info/success 仅在开关开启时闪现；v2.0 起默认关 |
> | `onFullscreenChange` | player | 全屏时 `statusBadge` 随 `settingsBtn`/`settingsPanel` 一同移入/移出全屏元素子树（v2.0 起 reparent 已移除，改为全屏隐藏 + 面板 lazy reparent） |
>
> v1.7.1 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `restoreProgress` | player | 新增 `state.restoringProgress = true` + `state.switching = true`（try/finally）守卫，阻止 onNavigate/onTimeUpdate 干扰；恢复完成后 `setTimeout 2000ms` 清除 restoringProgress |
> | `onFullscreenChange` | player | 进入全屏时 `fsEl.appendChild(settingsBtn/settingsPanel)`，退出时移回 `document.body`（v2.0 已移除该 reparent，改为：进入全屏隐藏按钮+收起面板、退出时 `applySettings()` 恢复、面板由 `ensureSettingsPanelHost` lazy reparent） |
>
> v1.7.0 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | 进度条悬停画面预览（v1.7.0 修复） | ui | 改用 `/x/player/videoshot` 接口拉雪碧图帧（**v2.0 已随画面预览整模块删除**，tooltip 降级为纯文字时间+分P标题） |
> | `freezeFrame()` / `unfreezeFrame()` | ui | canvas `drawImage` 冻结 P1 末帧盖住播放器 / 淡出 + 300ms 后清空画布释放内存 |
> | `fadeOutVolume(video, ms)` / `fadeInVolume(video, ms)` | player | 10 步渐变到 0（结束后 `muted=true` 保留 volume 原值）/ unmute 后 10 步渐回原值 |
>
> v1.6.0 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `seekToOverallTime(overallTime)` | ui | 从 `seekToClientX` 抽取的统一 seek：`overallToPartOffset` 定位 → 同P `currentTime` / 跨P `jumpToPart`；clamp + totalDuration 边界收 0.01s 余量 |
> | `onProgressBarKeyDown(e)` | ui | 键盘 seek（←/→/↑/↓ ±10s、PgUp/PgDn ±60s、Home/End）；进度条 `role=slider` + `tabindex` + aria-valuenow 随播放刷新 |
> | 章节分段着色渐变 | ui | cumulative 百分比区间交替色相（**v2.0 已随章节样式整模块删除**） |
> | `showTransition` 幕间分支 | ui | 原「第 N 幕」四行幕间结构（**R2 已删**，分P切换不再插幕间卡）；剩余单行模式亦已随 v1.11 整体删除 |
> | `showFinishedActions` End Card | ui | **v1.11 已随结束卡整体删除**（原含 title/sub/divider 装饰 v2.0 已删，后仅「重新放映 / 关闭」两键 + 30s 自动收起） |
> | `onCinemaPlay` / `onCinemaPause` | player | 原切 `.cinema-paused` class（**v2.0 已删除**——样式随被砍主题一并移除）；现仅刷新关灯遮罩 |
> | `updateLightsOut` | ui | `display` 硬切全部改 `.on` class 切换（opacity .5s 过渡）；500ms 节流 + rAF + `_pendingOn` 首帧延迟保证淡入 |
> | 设置面板动效 | ui/css | 面板出入场动效（设置面板零 JS 改动——原本就只切 class）；历史面板 v2.0 已删除 |
>
> v1.5.0 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `parseSidx` / `buildSegmentPlan` / `parseRangeHeader` / `rangeCovered` | utils | MP4 sidx 解析（version 0/1、嵌套 sidx 停止、垃圾输入 null）→ 分段预取计划（headEnd + media 区间）→ Range 头解析（开放 end 为 null）→ 单 chunk 覆盖判定；纯函数、单测覆盖（19/19） |
> | `rankUrls` / `computeExpires` / `pruneByteStore` | bridge | 预取 URL 排序（upos 优先/mcdn 靠后/backup 优先、稳定排序）；有效期统一取最小 `deadline`-5 分钟（无则 2 小时兜底）；byteStore 内存修剪（上限 6 条、写入前清过期，同步清 prefetchTable） |
> | `serveStoredBytes` / `sliceStoredBytes` | bridge | 字节级 206 合成（满足 dash.js XHRLoader 契约：getAllResponseHeaders 四项头、responseURL、readyState 2→4、progress/load/loadend、TextDecoder 兼容 text responseType）；跨 chunk 切片拼接（注意 chunk.start 对齐偏移） |
> | `doPrefetch` 重写 / `tryPrefetchVariant` | bridge | head 请求一次拉 0..headEnd（init+index）→ content-range 解析 totalSize → `parseSidx` → `buildSegmentPlan` → 媒体段合并单 Range 请求；预算：主视频 {25s,8MB}、兜底变体 {10s,1.5MB}、音频 {25s,1MB}；segmentBase 缺失 → 单 chunk 兜底跳过 sidx |
> | `applyP2PBlock` / `restoreRTC` / `clearP2pGlobals` | bridge | 删 5 个 P2P SDK 全局 + 250ms 定期重删 `__DASH_P2P_TYPE__`（走 bwp 安全回退路径，零悬挂）；启动读 storage + `__cinema_config__` 动态生效 |
> | `prefetchPartOnDemand` | player | 悬停等"切换意图"按需预取任意分P/剧集；独立去重表 `state.onDemandPrefetch`（同 cid 10 分钟跳过）、不占用 `preloadedCid` 槽位 |
> | `goToNextPart` / `jumpToPart` | player | 切换开始即记录显示模式、暂停视频防竞态、三级切换策略；落地后 `setTimeout 800ms → preloadNextPart()` 链式预取（连续观影不必等剩余 60 秒窗口） |
> | `setupPrefetchUI` / `setupHoverPrefetch` / `resolvePrefetchPageNum` | ui | 预取 UI 幂等接线（`state.prefetchUiHooked`）；悬停分P条目 400ms 防抖按需预取（data-page/data-index 优先、列表序号兜底） |
> | `syncBridgeConfig` | core | 派发 `__cinema_config__` 的 detail 增加 `p2pBlock` |
>
> v1.4.0 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `matchStreamUrls` / `extractStreamCode` / `isAudioStreamFilename` | utils | 从 bridge 抽出的流匹配纯函数（码率码过滤+文件名去重 / `-1-(\d+).m4s` 提取 / 音频流判别），单测覆盖；bridge 以 `u*` 闭包引用调用 |
> | `qualityTextToQn` 兜底 | utils | 分辨率正则未命中时追加：8K→127、杜比视界/HDR→125、裸数字分辨率映射 |
> | `readAllHistory` / `writeAllHistory` / `scheduleHistoryWrite` | core | 观影记录 sync 分块读写（每块 ≤15 条）+ 10 秒防抖写；旧 local `cinemaHistory` 首次读取时自动迁移 |
> | `loadSkips` / `saveSkips` / `migrateOldSkips` | core | skips 改为 sync 每视频一个 key（**R2 已随跳过指定片段功能整套删除**，含 `cinemaSkip_*` 存储） |
> | `preloadNextPart` | player | 移除合集模式早退：season 用下一集 bvid 预取；触发条件增加 `currentTime >= 15`（短分P不抢开段带宽） |
>
> v1.3.0 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `hideTransition` / `showTransition` | ui | **v1.11 已随过渡层整体删除**（曾：切换过渡等首帧就绪后由 `hideTransition` 收起，`showTransition` 仅保留 4s 兜底） |
> | `holdTransitionUntilFrame` | player | 等新分P首帧渲染（`readyState>=2` 且播放中）再揭冻帧，最短 400ms、3.5s 超时兜底（原「收起过渡层」职责已随 v1.11 过渡层删除消失，现仅门控冻帧） |
> | `tryAutoPlay` | player | 去掉固定 300ms 延迟，立即 `play()`（保留自动播放被拦截后的点击/按键重试） |
> | `syncBridgeConfig` | core | 派发 `__cinema_config__`（`fastSwitch` + `currentCid`），设置变更/视频就绪时调用 |
> | `doPrefetch` / `cinemaXHR` / `window.fetch` 包装 | bridge | playurl 响应缓存入 `playurlCache` 并拦截本地秒回；视频/音频分别按码率码匹配、未知时视频预取前 3 个编码变体；`fetch` 包装兜底 |
>
> v1.2.0 新增/重构的关键函数：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `formatTime` / `formatRelativeTime` / `escapeHtml` / `qualityTextToQn` / `buildCumulative` / `overallToPartOffset` | utils | 纯函数库，浏览器/Node 双环境（`module.exports` + `window` 挂载），单测覆盖 |
> | `onProgressStorageChanged` | core | `chrome.storage.onChanged` 回调：同 key 进度新于本地时顺延合并（前提 `progressSync` 开启、距上次保存 >5 秒） |
> | `showFinishedActions` / `hideFinishedActions` | ui | **v1.11 已随结束卡整体删除**（曾在播放完毕过渡层内显示「重新放映 / 关闭」，30 秒自动隐藏） |
> | 进度条画面预览（playurl preview API） | ui | 原帧雪碧图拉取与渲染（**v2.0 已随画面预览整模块删除**） |
> | `initSettingsPanelGroups` | ui | 设置面板按 `data-group` 分组折叠，折叠态存 `localStorage.cinemaPanelGroups` |
> | `getPanelPos` / `savePanelPos` | ui | 设置面板位置读写 `localStorage.cinemaSettingsPanelPos`，`positionSettingsPanel` 优先用记忆位置 |
> | `onProgressStorageChanged` 注册/移除 | content | `onVideoFound` 注册、`cleanup` 移除 |
>
> v1.1.0 新增/重构的关键函数（所在文件见 3.3）：
>
> | 函数 | 文件 | 说明 |
> |---|---|---|
> | `getProgressKey` | core | 进度/历史共用存储 key（合集用 seasonId，分P用 bvid） |
> | `loadIntroOutro` / `saveIntroOutro` | core | 片头/片尾时长按视频覆盖的读写（**R2 已随片头/片尾跳过功能删除**） |
> | `getIntroDuration` / `getOutroDuration` | core | 有效片头/片尾时长（**R2 已删除**） |
> | `onVideoProgress` | player | `progress` 事件刷新缓冲进度显示 |
> | `markSkipStart` / `markSkipEnd` | skips | 跳过片段起点/终点标记（**R2 已随 cinema-skips.js 删除**） |
> | `progressEventToTime` | ui | 进度条事件坐标 → 电影总时间 |
> | `showProgressTooltip` | ui | 悬停提示气泡（时间 + 分P标题） |
> | `onProgressBarPointerDown/Move/Up/Cancel` | ui | 拖拽 seek（按下预览、松开提交） |
> | `onProgressBarContextMenu` | ui | 右键进度条标记跳过片段（**R2 已删除**） |
> | `seekToClientX` | ui | 按进度条坐标跳转（点击与拖拽共用） |
> | `exportHistory` / `clearAllHistory` | ui | 观影记录导出 JSON / 清空（二次确认）——**v2.0 已随观影记录面板整模块删除**（存储层 `readAllHistory`/`writeAllHistory` 保留，popup 与备份导入导出仍用） |
> | `bindIntroOutroInputs` / `refreshIntroOutroInputs` | ui | 设置面板"当前视频"片头/片尾输入绑定与刷新（**R2 已删除**） |
> | `updateLightsOut` | ui | 关灯遮罩位置/显隐刷新（跟随播放器，原生全屏自动隐藏） |

### 5.1 内容脚本模块（原 content.js）

#### 工具函数

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `formatTime` | utils | `(seconds: number) => string` | 秒数 → `h:mm:ss` 或 `m:ss` 格式（cinema-utils.js 纯函数） |
| `getBvid` | L100 | `() => string` | 从 URL path 提取 BV 号 |
| `getCurrentPage` | L105 | `() => number` | 从 URL query 提取当前 P 号（1-based） |
| `log` | L110 | `(...args: any[]) => void` | 带 `[影院模式]` 蓝色前缀的 console.log |
| `escapeHtml` | utils | `(str: string) => string` | HTML 转义（cinema-utils.js 纯函数） |
| `formatRelativeTime` | utils | `(ts: number) => string` | 时间戳 → 相对时间（刚刚/X分钟前/X小时前/X天前/日期）（cinema-utils.js 纯函数） |

#### 设置持久化

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `loadSettings` | L118 | `() => Promise<void>` | 从 `chrome.storage.local.cinemaSettings` 加载设置，合并到 `DEFAULT_SETTINGS` |
| `saveSettings` | L133 | `() => void` | 将 `settings` 写入 `chrome.storage.local.cinemaSettings` |

#### 播放进度持久化

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `saveProgress` | L143 | `() => void` | 保存当前进度（合集用 `season_${id}` 为 key，分 P 用 bvid），同步调用 `updateWatchHistory` |
| `updateWatchHistory` | L168 | `(progressKey: string, data: object) => void` | 更新观影记录（含累计观看秒数并入） |
| `loadProgress` | L191 | `(bvid: string) => Promise<object\|null>` | 加载指定视频的上次播放进度 |

#### 数据获取

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `extractPageData` | L479 | `() => Promise<boolean>` | 三级数据获取策略入口，返回是否成功 |
| `parseFromScriptTags` | L352 | `() => object\|null` | 从 `<script>` 文本提取 `__INITIAL_STATE__`（括号计数法） |
| `injectPageDataScript` | L219 | `() => Promise<object\|null>` | 注入主世界脚本读取全局数据，CustomEvent 回传，3 秒超时 |
| `fetchFromAPI` | L423 | `() => Promise<object\|null>` | 调 `x/web-interface/view` 获取视频数据（含合集结构解析） |
| `applyParsedData` | L301 | `(s: object) => boolean` | 归一化数据到 `state`，判定分P/单集模式，保存合集信息 |
| `fetchDurations` | L506 | `() => Promise<void>` | 时长缺失时调 `x/player/pagelist` 补齐；仍缺则用当前视频 duration 估算 |
| `computeCumulative` | L495 | `() => void` | 计算 `cumulative[]` 前缀和与 `totalDuration` |

#### 视频元素查找

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `findVideo` | L543 | `() => HTMLVideoElement\|null` | 在播放器容器内查找（兼容标准 `<video>` 和 B 站自研 `<bwp-video>`） |
| `findPlayerWrap` | L563 | `() => HTMLElement\|null` | 查找播放器容器（兼容新旧版选择器） |

#### 显示模式保持

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `getPlayerDisplayMode` | L611 | `() => Promise<'normal'\|'wide'\|'web-fullscreen'\|'fullscreen'>` | 优先检测原生全屏 → 桥接查询 `mainScreen` → DOM 类名回退 |
| `queryPlayerMainScreen` | L588 | `() => Promise<number>` | 通过 `__cinema_get_mode__` 事件查询（400ms 超时） |
| `parseBridgeDetail` | L579 | `(e: Event) => object` | 兼容 JSON 字符串与对象的 detail 解析 |
| `switchPartViaPlayerAPI` | L637 | `(targetPage: number) => Promise<boolean>` | 通过 `__cinema_switch_part__` 调播放器内部 API 切 P（600ms 超时），**优先路径** |
| `restoreDisplayMode` | L665 | `(mode: string) => void` | 点击对应控件按钮恢复模式；检查 `bpx-state-entered` 类避免重复点击导致退出；按钮未渲染则 200ms 重试最多 10 次 |

#### 播放设置记忆

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `loadPlayerPrefs` | L708 | `() => Promise<void>` | 从 `chrome.storage.local.cinemaPrefs` 加载偏好 |
| `savePlayerPrefs` | L725 | `() => void` | 将 `state.prefs` 写入存储 |
| `findDanmakuBtn` | L732 | `() => HTMLElement\|null` | 查找弹幕开关按钮（登录后才有） |
| `onPlayerRateChange` | L743 | `() => void` | 用户调整倍速时记录（含保护期检查） |
| `onPlayerVolumeChange` | L756 | `() => void` | 用户调整音量时记录 |
| `captureQualityText` | L768 | `() => void` | 节流捕获当前画质文本 |
| `captureDanmakuState` | L780 | `() => void` | 节流捕获弹幕开关状态 |
| `restoreQualityByText` | L792 | `(qText: string) => void` | 通过画质菜单恢复画质（点击→匹配文本项→800ms 延迟） |
| `restorePlayerPrefs` | L819 | `() => Promise<void>` | 恢复倍速/音量/画质/弹幕（3 秒保护期，1.5 秒完成） |

#### 下一分P预加载

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `qualityTextToQn` | L861 | `(text: string) => number` | 画质文本 → qn 数字（B站 playurl API 参数） |
| `preloadNextPart` | L882 | `() => Promise<void>` | 触发预取（分P模式、非最后一P、防重入），发 `__cinema_prefetch__` 事件；切 P 落地后由链式预取直接调用 |
| `prefetchPartOnDemand` | L693 | `(idx: number) => void` | 按需预取任意分P/剧集（悬停等"切换意图"场景）；独立去重表 `state.onDemandPrefetch`（同 cid 10 分钟内跳过）、不占用 `preloadedCid` 槽位 |
| `onPrefetchDone` | L913 | `(e: Event) => void` | 预取结果回调（连续失败 ≥3 暂停重试）；成功后重置失败计数并记录 `prefetchOkCid` |

#### 自动关闭标签页

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `maybeSuggestCloseTab` | L930 | `() => void` | 最后 P 接近结束时提示自动关闭（仅一次） |
| `showCloseTabTip` | L944 | `() => void` | 显示 10 秒倒计时气泡 |
| `closeCloseTabTip` | L980 | `() => void` | 关闭气泡并清理定时器 |
| `requestCloseTab` | L992 | `() => void` | 发送 `closeTab` 消息到后台 |

#### 视频事件处理（核心循环）

| 函数 | 行号 | 签名 | 触发 | 职责 |
|---|---|---|---|---|
| `attachVideoListeners` | L1001 | `() => void` | - | 绑定 `loadedmetadata`/`ended`/`timeupdate`/`ratechange`/`volumechange`/`play`/`pause`/全屏事件 |
| `detachVideoListeners` | L1021 | `() => void` | - | 解绑所有视频事件监听（含 `play`/`pause` 动画冻结监听） |
| `onVideoReady` | L1070 | `() => void` | `loadedmetadata` | 更新当前 P 实际时长、重算累计、刷新指示器 |
| `onTimeUpdate` | L1086 | `() => void` | `timeupdate`（高频） | 观影统计（seek >5s 不计）、预取触发（剩余<60s）、节流捕获画质/弹幕（每 4 次）、更新进度条、每 5 秒存进度；`state.restoringProgress` 时 early return（v1.7.1） |
| `onVideoEnded` | L1147 | `() => void` | `ended` | 自动切下一 P；最后一P播完仅压制原生自动连播 + 可选关标签页提示（播完无扩展界面，v1.11） |
| `onFullscreenChange` | L1036 | `() => void` | `fullscreenchange` | 进入原生全屏时隐藏设置按钮、收起设置面板；退出时 `ensureSettingsPanelHost(false)` 归还面板到 body 后 `applySettings()` 恢复可见性；刷新关灯遮罩；切 P 期间保持全屏 |

#### 分 P 切换

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `goToNextPart` | L1293 | `() => Promise<void>` | 自动切下一 P 的总入口（记录显示模式、暂停视频防竞态、三级切换策略）；切P时 `freezeFrame()`+`fadeOutVolume()`（`useSeamlessCover` 决定淡出时长）、`holdTransitionUntilFrame` 后 `unfreezeFrame()`+`fadeInVolume()`；落地后 `setTimeout 800ms → preloadNextPart()` 链式预取（连续观影不必等剩余 60 秒窗口） |
| `fadeOutVolume` | L1396 | `(video: HTMLVideoElement, ms: number) => void` | 音量 10 步渐变到 0，结束后置 `muted=true` 并恢复 volume 原值（muted 状态不发声，淡入时 unmute）（v1.7.0） |
| `fadeInVolume` | L1414 | `(video: HTMLVideoElement, ms: number) => void` | `muted=false` 后 10 步从 0 渐回原值（P2 首帧就绪后调用）（v1.7.0） |
| `jumpToPart` | L2129 | `(targetIndex: number, offsetSeconds: number) => Promise<void>` | 跳转到指定分 P 的指定时间点（进度条点击触发）；同 `goToNextPart`：切P时 `freezeFrame()`+`fadeOutVolume()`、`holdTransitionUntilFrame` 后 `unfreezeFrame()`+`fadeInVolume()` + 落地后 800ms 链式预取 |
| `tryClickNextPart` | L1362 | `(targetIndex: number) => boolean` | 尝试通过点击 DOM 切 P（优先用 `data-key=cid` 精确匹配，多套新旧版选择器回退） |
| `tryClickSeasonEpisode` | L1482 | `(targetIndex: number) => boolean` | 合集模式：通过 bvid 或选集面板选择器点击 |
| `waitForPlayerAPISwitch` | L1418 | `(expectedIndex: number) => Promise<void>` | 播放器内部 API 切换后等待就绪（loadedmetadata + 时长匹配 + URL p 参数 + 80×150ms 轮询） |
| `waitForVideoChange` | L1521 | `(expectedIndex: number) => Promise<void>` | DOM 点击切换后等待就绪（最多 100×100ms 轮询，超时则整页跳转） |
| `waitForVideoChangeSeason` | L1571 | `(expectedIndex: number) => Promise<void>` | 合集模式等待视频切换（通过检测 bvid 变化） |
| `tryAutoPlay` | L1618 | `() => void` | 300ms 延迟后自动播放；被阻止则监听用户交互后重试 |

#### 统一进度条 & UI

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `createUI` | L394 | `() => void` | 创建进度条（含 slider 语义/键盘可达性）、时间标签、分P指示器、设置按钮、设置面板 |
| `buildMarkers` | L2073 | `() => void` | 在进度条上构建分 P 分隔标记 |
| `updateUnifiedProgress` | L2086 | `() => void` | 按总时间线更新进度条宽度与时间文本，并高频刷新 `aria-valuenow/valuemax` |
| `onProgressBarClick` | L2101 | `(e: MouseEvent) => void` | 点击进度条 → `seekToClientX` → `seekToOverallTime`（与拖拽/键盘三路径统一） |
| `seekToOverallTime` | L918 | `(overallTime: number) => void` | 按电影总时间 seek（三路径共用）；`overallToPartOffset` 定位 → 同P currentTime / 跨P jumpToPart；clamp + 结尾 0.01s 余量（v1.6.0） |
| `onProgressBarKeyDown` | L935 | `(e: KeyboardEvent) => void` | 键盘 seek：←/→ ±10s、PgUp/PgDn ±60s、Home/End；preventDefault + 立即刷新进度显示（v1.6.0） |
| `showProgressTooltip` | L722 | `(e: Event) => void` | 悬停提示气泡（纯文字：时间 + 分P标题）；`overallToPartOffset` 定位分P（v2.0 起不含画面缩略图） |
| `freezeFrame` / `unfreezeFrame` | L1026 / L1052 | `() => void` | 切P时把当前视频帧 `drawImage` 到 canvas 冻结盖住播放器（P1 末帧保持） / P2 首帧就绪后淡出 + 300ms 清空画布释放内存（v1.7.0） |
| `updatePartIndicator` | L2209 | `() => void` | 更新分 P 指示器文本（P1/10 或 1/10） |
| `updateMovieTitle` | L2225 | `() => void` | 清理页面标题中的 P 数信息 |

#### 状态徽章

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `showStatusBadge` | L1801 | `(text: string, type?: string) => void` | 显示状态徽章；**v1.12 起收敛为纯 error toast**——`type !== 'error'` 直接忽略，info/success 调用点已全部删除；错误信息约 5 秒后自动淡出 |

#### 设置面板

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `createSettingsPanel` | L2238 | `(wrap: HTMLElement) => void` | 创建设置面板（**v1.12 起单卡片**：enabled/autoCloseTab 两个开关 + 收藏按钮 + 入口提示；六分组折叠/select/滑杆/快捷键编辑器/数据组已删） |
| `ensureSettingsPanelHost` | - | `(attachToFullscreen: boolean) => void` | 设置面板宿主管理（v2.0）：原生全屏内打开时 lazy reparent 到 `fullscreenElement` 子树（否则不可见），关闭/退出全屏时挂回 `document.body` |
| `toggleSettingsPanel` | L2349 | `() => void` | 切换面板显示/隐藏；打开分支先 `ensureSettingsPanelHost(true)` 再定位 |
| `positionSettingsPanel` | L2357 | `() => void` | 面板定位（**v1.12 起无按钮**：已保存位置优先，否则视口右上 `right:24px; top:24px`） |
| `applySettings` | L2395 | `() => void` | 同步 body 类与全部 UI 显隐（v1.12 起：hidePartUI 恒 false、无 progress-style 切换、无设置按钮/徽章显隐逻辑） |

#### 进度恢复

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `restoreProgress` | L2431 | `() => Promise<void>` | 加载存储进度、跳转目标分 P、seek 到目标位置（留 2 秒缓冲）；switching/restoringProgress 守卫（v1.7.1） |

#### SPA 导航 & DOM 监听

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `setupNavigationObserver` | L2478 | `() => void` | 监听 popstate + 劫持 pushState/replaceState + 1 秒轮询 |
| `onNavigate` | L2508 | `() => void` | URL 变化处理：合集内切换、同视频分 P 切换、跨视频重新初始化；`state.restoringProgress` 时跳过 currentIndex 更新（v1.7.1） |
| `refreshVideoElement` | L2551 | `() => void` | 手动切换分 P 后刷新视频元素引用 |
| `setupPlayerObserver` | L2567 | `() => void` | MutationObserver 防抖 300ms 监听播放器 DOM 变化 |

#### 初始化与清理

| 函数 | 行号 | 签名 | 说明 |
|---|---|---|---|
| `init` | L2604 | `() => Promise<void>` | 加载设置 → 获取数据（失败重试 20 次×500ms）→ `proceed()` |
| `proceed` | L2636 | `() => Promise<void>` | 确定 currentIndex → 补时长 → 算累计 → 等视频元素（30 次×500ms）→ `onVideoFound()` |
| `onVideoFound` | L2677 | `() => Promise<void>` | 挂监听 → 建 UI → 加载偏好 → 注册快捷键 → 恢复进度 → 恢复显示模式 → 恢复播放器设置 → 每 10 秒存进度 |
| `cleanup` | L2730 | `() => void` | 清定时器/观察器/监听器/UI/全部状态，供 SPA 导航切换视频时复用 |

### 5.2 player-bridge.js

| 函数/监听器 | 行号 | 说明 |
|---|---|---|
| `parseDetail` | L12 | 兼容 JSON 字符串与对象的 detail 解析 |
| `__cinema_switch_part__` 监听 | L21 | `player.next(false)` / `prev(false)`（优先）/ `goto(offset, false)`（旧版兜底），回传 `{ id, ok, error }` |
| `__cinema_get_mode__` 监听 | L64 | `player.getStates().mainScreen`，回传 `{ id, mainScreen }` |
| `rankUrls` | L125 | 预取候选 URL 排序：host 含 `upos` 最前、含 `mcdn` 最后、其余居中；稳定排序、同分 backup 优先 |
| `computeExpires` | L146 | 取全部候选 URL 最小 `deadline`（unix 秒）-300s 得有效期，无 deadline 用 now+2h；playurlCache/prefetchTable/byteStore 统一 |
| `parseContentRange` | L160 | 从 `getAllResponseHeaders()` 解析 content-range 的 totalSize（`/bytes\s+\d+-\d+\/(\d+)/i`），取不到返回 -1 |
| `sliceStoredBytes` | L172 | 从 byteStore 覆盖 chunks 中切片 `[start,end]`（跨 chunk 拼接、chunk.start 对齐偏移） |
| `getFetchRange` | L192 | 从 fetch 的 input/init 提取 Range 请求头（Headers 对象/普通对象，不区分大小写） |
| `xhrRange` | L215 | 原生 XHR Range 请求（预取专用，直接 NativeXHR，不经过 cinemaXHR 包装） |
| `pruneByteStore` / `BYTE_STORE_LIMIT` | L241/242 | byteStore 内存修剪：写入前清过期条目、超上限（6 条）按插入序淘汰最旧，同步清 prefetchTable |
| `writeByteStore` | L262 | 预取成功落盘：写 byteStore + prefetchTable（URL 重写兜底）+ 回传 `{ ok, name, cid, kind, bytes }` |
| `prefetchStream` / `tryPrefetchVariant` | L276/281 | 逐流预取：segmentBase 缺失 → 单 chunk 兜底跳过 sidx；否则 head 请求 `0..headEnd` → `parseSidx` → `buildSegmentPlan` → 媒体段合并单 Range 或 headEnd+1 兜底；失败换下一个候选 URL |
| `serveStoredBytes` | L392 | 字节级 206 合成：status/statusText/response/responseText/responseURL/readyState(2→4) 遮蔽、getAllResponseHeaders/getResponseHeader 四项头（content-range 未知用 `*`）、readystatechange/progress/load/loadend 事件时序，满足 dash.js XHRLoader 契约 |
| `cinemaXHR` | L468 | 包装 `XMLHttpRequest`：open 记录 `_cinemaOrigUrl` 与 byte 候选、`setRequestHeader` 记录 Range、send 分支 **playurl 合成 > 字节合成 > URL 重写兜底**；`configurable:true` 遮蔽、open 清理、abort 防护；保留原型与静态常量 |
| `fetch` 包装 | L622 | playurl 命中缓存返回 `new Response(json, 200)`；字节合成命中返回 `new Response(sliceBuffer, 206)`（同四项头）；流文件名命中预取表重写为预取直连 URL 兜底 |
| `doPrefetch` | L687 | playurl API 拉流（响应缓存入 `playurlCache`，`deadline` 有效期）→ 按码率码选目标变体（未知取前 3 个）→ 逐流预取入 `byteStore`（主视频 {25s,8MB}/兜底 {10s,1.5MB}/音频 {25s,1MB}）；回传 done 事件 |
| `clearP2pGlobals` / `applyP2PBlock` / `restoreRTC` | L810/824/832 | 删 5 个 SDK 全局 + `__DASH_P2P_TYPE__`；`applyP2PBlock` 立即清 + 250ms 定期重删（SDK 脚本动态重注入需持续压制）；`restoreRTC` 停定时器 |
| `__cinema_prefetch__` 监听 | L826 | 转发 content.js 的预取请求（`{ bvid, cid, qn, onDemand }`） |
| `__cinema_config__` 监听 | L832 | 接收 content.js 下发的 `fastSwitch` / `p2pBlock` / `currentCid`；p2pBlock 动态生效 |
| 启动 P2P 读取 | L843 | `chrome.storage.sync.get('cinemaSettings')` 读到 `p2pBlock:true` 时 `applyP2PBlock()`（与 content.js 下发双保险） |

### 5.3 background.js

| 函数 | 行号 | 说明 |
|---|---|---|
| `chrome.runtime.onMessage.addListener` | L8 | 仅处理 `closeTab`：`chrome.tabs.remove(sender.tab.id)`，异步响应 `{ ok: true }` |

---

## 6. 消息与通信协议

### 6.1 content.js ↔ player-bridge.js（页面 CustomEvent）

| 方向 | 事件名 | payload（JSON 字符串） | 超时 |
|---|---|---|---|
| content → bridge | `__cinema_switch_part__` | `{ id, page }` | 600ms |
| bridge → content | `__cinema_switch_part_result__` | `{ id, ok, error }` | - |
| content → bridge | `__cinema_get_mode__` | `{ id }` | 400ms |
| bridge → content | `__cinema_get_mode_result__` | `{ id, mainScreen }` | - |
| content → bridge | `__cinema_prefetch__` | `{ bvid, cid, qn, onDemand? }`（`onDemand` 为按需预取标记，bridge 忽略也无副作用） | - |
| bridge → content | `__cinema_prefetch_done__` | 成功 `{ ok, name, cid, kind: 'video'\|'audio', bytes }` / 失败 `{ ok: false, reason, cid, kind }` | - |
| content → bridge | `__cinema_config__` | `{ fastSwitch, p2pBlock, currentCid }`（设置变更/视频就绪时下发） | - |

### 6.2 content.js ↔ background.js（chrome.runtime）

| 方向 | 消息 | payload |
|---|---|---|
| content → background | `sendMessage` | `{ type: 'closeTab' }` |

### 6.3 popup → content.js（chrome.tabs.sendMessage）

| 方向 | 消息 | payload |
|---|---|---|
| popup → content | `chrome.tabs.sendMessage(tab.id, ...)` | `{ type: 'cinema-open-settings' }`（打开播放器设置面板；非视频页/未注入 content script 时 lastError 静默忽略） |

---

## 7. 数据持久化

### 7.1 chrome.storage（按 key）

| 存储区 | Key | 结构 | 说明 |
|---|---|---|---|
| `sync` | `cinemaSettings` | `DEFAULT_SETTINGS` 对象 | 全部设置项（跨设备同步；旧版 local 数据首次加载时自动迁移） |
| `sync` | `cinemaHistory_c0..n` + `cinemaHistoryMeta` | 每块 `{ [progressKey]: { bvid, title, pic, part, totalParts, time, totalDuration, mode, ts, watched } }`（≤15 条/块）+ `{ chunks: n }` | 观影记录（v1.4.0 迁移至 sync 跨设备同步）；`watched` 为累计实际观看秒数；**容量上限 100 条**（超出按 ts 淘汰最旧）；高频写入走 10 秒防抖 |
| `local` | `cinemaProgress` | `{ [bvid \| "season_"+seasonId]: { part, time, ts, mode, bvid } }` | 播放进度；合集模式以 seasonId 为 key（跨标签页同步机制，跨设备进度同步已删除） |
| `local` | `cinemaPrefs` | `{ rate, volume, quality, danmaku }` | 播放设置记忆 |

### 7.2 localStorage

| Key | 内容 |
|---|---|
| `cinemaSettingsBtnPos` | 设置按钮 `{ left, top }` |
| `cinemaSettingsPanelPos` | 设置面板 `{ left, top }`（v1.2.0，标题栏拖拽后记忆） |
| `cinemaPanelGroups` | 设置面板分组折叠状态 `{ main, playback, ui, shortcuts, data, danger }`（v1.2.0） |

### 7.3 sessionStorage

| Key | 内容 |
|---|---|
| `cinemaDisplayMode` | 整页跳转/刷新后待恢复的显示模式（用后即删） |

---

## 8. 外部依赖（B站 API）

| API | 调用方 | 用途 |
|---|---|---|
| `GET /x/web-interface/view?bvid=` | cinema-player.js（`fetchFromAPI`） | 视频信息、分 P 列表、合集结构（数据获取三级策略的兜底） |
| `GET /x/player/pagelist?bvid=` | cinema-player.js（`fetchDurations`） | 分 P 时长补齐 |
| `GET /x/player/wbi/playurl?bvid=&cid=&qn=&fnval=4048&fourk=1` | player-bridge.js（`doPrefetch`） | 预取下一 P 视频流 |

页面数据依赖：`window.__INITIAL_STATE__.videoData`（pages / ugc_season.sections）；播放器依赖：`window.player`（`next` / `prev` / `goto` / `getStates`）与 DOM 类名（`bpx-state-entered` 等）。

---

## 9. 关键业务流程

### 9.1 初始化流程

```mermaid
sequenceDiagram
    participant Page as B站视频页
    participant C as 内容脚本(5模块)
    participant P as player-bridge.js

    Page->>C: load 事件 + 800ms
    C->>C: loadSettings(sync) / extractPageData(三级策略)
    C->>C: fetchDurations / computeCumulative
    C->>Page: 查找 video 元素(30次重试)
    C->>Page: createUI / applySettings / MutationObserver(收窄)
    C->>C: loadPlayerPrefs / 快捷键
    C->>C: restoreProgress(7天内) / restoreDisplayMode / restorePlayerPrefs
    C-->>P: 定时(每4次timeupdate)捕获画质/弹幕
```

### 9.2 分P切换流程（`goToNextPart`）

```mermaid
graph TB
    A[ended] --> B[记录 displayMode + 暂停当前视频防竞态]
    B --> C{模式}
    C -->|season| D[tryClickSeasonEpisode]
    C -->|pages| E[switchPartViaPlayerAPI]
    E -->|成功| F[waitForPlayerAPISwitch]
    E -->|失败| G[tryClickNextPart]
    G -->|成功| H[waitForVideoChange]
    G -->|失败| I[location.href 整页跳转 + sessionStorage]
    D -->|成功| J[waitForVideoChangeSeason]
    D -->|失败| I
    F --> K[restoreDisplayMode + restorePlayerPrefs + 重置预取状态]
    H --> K
    J --> K
```

### 9.3 预加载流程

```mermaid
flowchart LR
    A[触发：timeupdate 剩余<60s 且已播放≥15s<br/>或悬停分P条目 / 切P落地后链式预取] --> B[preloadNextPart / prefetchPartOnDemand<br/>发 __cinema_prefetch__ 事件]
    B --> C[bridge 调 playurl API<br/>响应缓存入 playurlCache<br/>含 fnval + deadline 有效期]
    C --> D[按码率码选目标变体<br/>rankUrls 排序：upos 优先 / mcdn 靠后]
    D --> E[segmentBase 规划<br/>init 0..initEnd + indexRange]
    E --> F[head 请求 Range: 0..headEnd<br/>→ content-range 解析 totalSize]
    F --> G[parseSidx → buildSegmentPlan<br/>得出 headEnd 与 media 段列表]
    G --> H[媒体段合并单 Range 请求<br/>media 为空则 headEnd+1 兜底]
    H --> I[写入 byteStore + prefetchTable<br/>pruneByteStore 上限 6 条]
    I --> J[切换时播放器 Range 请求]
    J --> K{命中 byteStore 且范围被覆盖?}
    K -->|是| L[serveStoredBytes 本地切片合成 206<br/>零网络延迟秒开]
    K -->|否| M[prefetchTable URL 重写兜底<br/>+ playurlCache fastSwitch 秒回]
```

### 9.4 统一进度条跳转流程

```mermaid
flowchart TD
    A[用户点击进度条] --> B[计算目标总时间]
    B --> C{目标是否在当前P?}
    C -->|是| D[video.currentTime = offset]
    C -->|否| E[jumpToPart targetIndex, offset]
    E --> F[三级切换策略]
    F --> G[恢复设置 + 自动播放]
```

---

## 10. 项目运行方式

### 10.1 安装（无构建，加载即用）

1. 打开 Chrome / Edge（或其他 Chromium 内核浏览器）的扩展管理页（`chrome://extensions`）
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择插件根目录
4. 访问任意 `www.bilibili.com/video/BV...` 页面，进度条被统一接管即生效

### 10.2 使用要点

- **设置面板**（v1.12 起单卡片）：入口为 S 键 / 双击播放器区域（避开控件条）/ popup「打开播放器设置」按钮；面板含「启用影院模式」「播完自动关闭标签页」两个开关 + 收藏按钮 + 入口提示，标题栏可拖动（位置记忆）；关闭方式：标题栏 ×、`Esc`、再按 S 键；原生全屏内打开时面板自动挂到全屏元素子树，退出全屏后归还 body
- **进度条**（v1.12 起原生观感）：平时光学上贴近 B 站原生；悬停显示时间点（单P内为 P 内相对时间，近分P边界/跨P拖拽时为电影总时间 + 分P标题）；分P分隔标记常态隐形，仅近边界悬停或拖拽跨P时浮现；点击或按住拖拽跳转，也可聚焦后用键盘（←/→/↑/↓ ±10s、PgUp/PgDn ±60s、Home/End）；白色半透明层为缓冲进度
- **冻结帧切换**：切P时画面保持 P1 末帧（canvas 遮罩）+ 音量淡入淡出，视觉零黑屏
- **播放完毕**：无扩展界面（结束卡与「放映结束」提示已删除；如开启「播完关标签页」则仅显示倒计时气泡）
- **跨标签页同步**：常驻开启（v1.12 起 `progressSync` 内化），多标签页播放同一视频进度自动合并
- **极致快速切换**：常驻开启（v1.12 起 `fastSwitch`/`preloadNext` 内化）；配合预加载基本消除切换黑屏
- **关灯模式**：L 键运行时切换（压暗程度固定 0.85，v1.12 起滑杆删除）
- **观影记录**：扩展 popup「最近放映」列表展示（可点击续播）；存储层保留
- **改代码后**：扩展管理页点击刷新按钮重载扩展，再刷新视频页

### 10.3 调试

- content.js 日志统一以 `%c[影院模式]` 蓝色前缀输出到页面 Console
- 双世界通信可在 Console 中手动验证：
  ```js
  dispatchEvent(new CustomEvent('__cinema_get_mode__', { detail: JSON.stringify({ id: 'test' }) }))
  ```
- 存储数据可在扩展管理页「检查视图 → Service Worker」或 DevTools → Application → Extension storage 中查看
- 预取功能可在 Network 面板筛选 `upgcxcode` 查看预取的视频/音频请求

---

## 11. 开发注意事项与约束

1. **通信 detail 必须用 JSON 字符串**，跨世界最可靠；事件均带随机 `id` 配对 + 超时兜底，避免悬挂 Promise
2. **CSS 不得用 `!important` 覆盖 B 站播放器布局**：如 `.bpx-player-container` 的 `position: relative` 若加 `!important` 会覆盖 B 站网页全屏的 `position: fixed`，导致全屏错乱（见 content.css L310-321 注释）
3. **徽章/按钮定位使用 `top/left`**（拖拽后转 fixed 坐标），禁用 `bottom/right` 混用；`showSettingsBtn=false` 时隐藏设置按钮用 `opacity` 而非 `display:none`，防止无法找回入口；仅进入原生全屏的瞬间允许 `display:none` 临时隐藏（退出全屏时 `applySettings()` 恢复）
4. **拖拽位置持久化到 localStorage**（`cinemaSettingsBtnPos` / `cinemaSettingsPanelPos`），切 P / 全屏 / 刷新后恢复
5. **切 P 前必须记录并恢复 `displayMode`**：内部 API 优先（不重建播放器），DOM 点击其次，整页跳转兜底（sessionStorage 传递）
6. **`switching` 互斥锁**贯穿所有切 P/跳转路径，防止竞态；切 P 前先 `pause()` 防止 B 站推荐导航竞态
7. **预取必须用原生 XHR**（B 站 CDN 对页面 `fetch` 返回 Failed to fetch），且要与播放器走同一 HTTP 缓存；`fetch` 仅用于 playurl API（预取走 XHR、playurl 响应本身用 fetch 获取）
8. **模式判定优先级**：视频自身多 P 优先合并；单 P 不合并合集条目（各条目为独立影片）；合集列表在合并时保持正常显示
9. **页面结构兼容新旧两版 B 站播放器**（选择器均有新旧双版本回退），改选择器时需双端验证
10. **`__INITIAL_STATE__` 解析使用括号计数法**：必须处理字符串内嵌套的引号、分号和转义字符，不能用正则直接提取
11. **进度恢复留 2 秒缓冲**：避免 seek 到精确位置时浏览器卡顿导致首帧黑屏
12. **MutationObserver 必须防抖**（300ms）：B 站播放器 DOM 变动非常频繁（弹幕、控件等），直接响应会导致性能问题
13. **SPA 导航三重监听**：popstate + 劫持 pushState/replaceState + 1 秒轮询，确保 B 站所有导航方式都能被捕获
14. **多文件共享全局作用域**：5 个内容脚本在同一隔离世界按序注入，跨文件函数调用无需 import；顶层 `let`/`const` 命名全局唯一，新增顶层声明须先确认不与现有冲突；`init` 在最后一个文件（content.js）末尾触发，保证所有函数已声明
15. **MutationObserver 收窄监听**：优先只观察播放器容器内部（`subtree`），另用 body 直接子节点观察器捕获容器整体重建；仅当容器不存在时才回退为观察整个 body
16. **设置/观影记录存 `chrome.storage.sync`**（跨设备）；进度/偏好存 `local`；读取时若 sync 为空会自动从旧版 local 迁移。跨设备进度同步已删除（R2），`cinemaProgressSync` 不再读写
17. **关灯遮罩用超大 `box-shadow` 挖孔**：遮罩本体透明覆盖播放器、`pointer-events:none`，不阻挡播放器交互；原生全屏时全屏元素位于顶层，遮罩自动隐藏
18. **跨标签页进度同步须防互相覆盖**：`saveProgress` 记录本地时间戳，`onProgressStorageChanged` 只在「收到 key 相同 + 远端 `ts` 更新 + 距上次保存 >5 秒 + 远端时间超前」时顺延；`progressSync` 关闭时忽略
19. **纯函数必须留在 `cinema-utils.js`**：新增可单测逻辑放该文件并补 `tests/unit.test.js` 用例；`cinema-utils.js` 用 UMD 写法（`module.exports` + `window` 挂载），勿引入 DOM/`chrome.*` 依赖（单测在 Node 下运行）
20. **悬停画面预览已移除**（v2.0）：videoshot 雪碧图预览整模块删除，`showProgressTooltip` 现为纯文字（时间 + 分P标题），勿再引入雪碧图请求
21. **playurl 拦截只在 fastSwitch 开启且非当前 cid 时生效**：`playurlCache` 仅由预取写入（2 小时有效）；XHR 合成响应全部用 `configurable: true` 的 `defineProperty` 遮蔽（严格模式下直接赋值只读 getter 会抛异常），并在下次 `open` 时清理影子属性以兼容 XHR 复用；任何合成异常 try/catch 后放行真实请求，保证拦截失败也能回退
22. **切P必须等首帧再揭冻帧**：`holdTransitionUntilFrame` 判定 `readyState >= 2` 且（`currentTime > 0` 或未暂停），最短显示 400ms、3.5s 超时兜底；不得改回固定时长揭帧，否则黑屏残留复现（原「过渡层等首帧再撤」约束——过渡层 v1.11 已删，机制转用于冻帧揭幕）
23. **playurl 拦截必须保留 fnval 校验**：缓存条目记录预取时的 `fnval:'4048'`，拦截前解析请求 URL 的 fnval 并要求严格相等，否则放行真实请求——防止播放器请求 mp4（durl）等非 dash 格式时收到 dash JSON 导致切换失败
24. **预取时机约束勿改**：「剩余 <60s 且已播放 ≥15s」缺一不可——短分P（<75s）若一开始就预取会与当前播放抢开段带宽；合集模式预取复用同一机制（playurl API 同源跨 bvid 可用），勿再加 season 早退
25. **sync 存储配额与频率**：sync 单项 ≤8KB、总量 100KB、约 120 次/分钟写入限制——history 分块（≤15 条/块）+ 10 秒防抖写；多标签页并发写同一分块为「后写覆盖」语义（接受），新增 sync 数据必须遵守同样约束
26. **cinema-utils.js 双世界注入**：manifest 中 MAIN world 条目须保持 `cinema-utils.js` 在 `player-bridge.js` 之前；bridge 在 IIFE 启动时闭包捕获 `u*` 引用（防页面脚本后续覆盖同名全局），勿改为运行时动态查全局
27. **dash.js XHRLoader 契约必须严格满足**：`readyState===2` 即读 `getAllResponseHeaders()`、`onload` 一次性读完整 `response`（ArrayBuffer）、读 `responseURL` 做埋点、`progress` 事件 `loaded/total` 用于 ABR 吞吐估计——字节合成任一项缺失都可能触发播放器重试风暴
28. **mcdn/PCDN 节点 206 无缓存头**：浏览器 HTTP 缓存不可用，旧"URL 重写命中缓存"仅对 upos 有效；预取 URL 必须优选 upos（鉴权签名在 query、与 host 无关）
29. **预取边界必须与 sidx 分段对齐**（RFC 9111：部分缓存只能回答完全落在已存范围内的部分请求）；旧版"单个 Range 0-6MB"与播放器分片请求边界永不匹配，是 v1.3/v1.4 黑屏残留根因之一
30. **byteStore 内存修剪**：上限 6 条 + 写入前清过期（单条最大约 9MB，长会话防累积）；淘汰时同步清 `prefetchTable`，保持 URL 重写兜底与 byteStore 一致
31. **ES5 严格模式陷阱**：函数内改 `arguments` 不联动形参（严格模式下解除别名）；XHR 包装透传被重写的 URL 必须显式构造参数数组（`openArgs[1] = url`）
32. **P2P 屏蔽的实现选择**：不替换 `RTCPeerConnection`（构造即抛错会触发 bwp `~2s connectTimeout` 悬挂——分片加载即时路径无 try/catch，切P首个媒体段必踩，黑屏反而变长）；改为删除 P2P SDK 全局（`DIYSdk` 等）+ 250ms 定期重删 `__DASH_P2P_TYPE__`，走 bwp 自带的"SDK 缺失 → 删类型 → 纯 XHR"安全回退，零悬挂。SDK 脚本由 `setP2pType` 动态注入重定义全局，故需开启期间持续压制。激进项默认关；切下一P后生效（核心每分片请求现读 `__DASH_P2P_TYPE__`），刷新更彻底。失败开放：B站改名则静默失效回到默认行为
33. **三路径 seek 统一**：点击/拖拽/键盘共用 `seekToOverallTime`；`overallToPartOffset` 在 `overall === totalDuration` 时返回 null，故 End/最右边缘统一收 0.01s 余量（避免 seek 到 `video.duration` 立即触发 ended）
34. **过渡层已整体删除**（v1.11）：`showTransition`/`hideTransition` 函数、`#cinema-transition` DOM 与样式、`.cinema-transition-text`、`--c-transition-bg` 令牌、`state.transitionTimer`/`ui.transition` 字段全部移除——切P黑屏防护完全依赖冻结帧遮罩（`holdTransitionUntilFrame` 门控揭帧）；结束卡及其 `.cinema-finished-actions` 常驻节点此前已一并删除
35. **面板动效选型**：设置面板用 visibility 过渡（.18s 末尾翻转 hidden，先淡出后隐藏）；关灯遮罩 `.on` class + opacity .5s，首次点亮 rAF 推迟一帧保证过渡可见
36. **进度条样式仅 classic / minimal**（v2.0）：minimal 为 3px 纤细线（hover 不增高、无圆角滑块、`::after` 隐藏），classic 为基础样式；新增样式前需在 `DEFAULT_SETTINGS` 白名单、设置面板 select 与 `applySettings` 的 classList.remove 三处同步
37. **性能注意**：`aria-valuenow` 在 `updateUnifiedProgress` 高频更新（setAttribute 可接受，无需节流）
38. **设置面板原生全屏宿主管理**（v2.0）：面板挂 `document.body`，原生全屏只渲染 fullscreenElement 子树 → 挂 body 的面板在原生全屏内不可见。`ensureSettingsPanelHost(true)` 在打开时把面板 lazy reparent 到 `fullscreenElement` 子树，关闭/退出全屏时 `ensureSettingsPanelHost(false)` 归还 `document.body`（fixed 定位免受播放器子树 transform/overflow 影响）；网页全屏（webscreen）无 `document.fullscreenElement`，不受影响。勿改 z-index（面板 99999 已足够）
39. **结束卡已整体删除**（v1.11）：播完无扩展界面（`showFinishedActions`/`hideFinishedActions`、`.cinema-finished-*` 样式与单行「放映结束」提示一并移除）；`resolveNextWork` 曾因 `extractPageData`/`proceed` 仍在调用而保留（写 `state.nextWork`），后续清理时确认无任何读取方，连同 `state.nextWork`/`state.related` 与三个解析路径的 related 透传一并删除（死数据）
40. **冻结帧 drawImage 不污染 canvas**：B站流是 MSE blob（同源数据），video 元素 drawImage 到 canvas 不触发 CORS 污染（跨域直链 src 才会）；canvas z-index 150 高于进度条 100，盖住视频（原「低于过渡层 200」的层级关系已随 v1.11 过渡层删除失效）
41. **音量渐变与 muted 的配合**：`fadeOutVolume` 渐到 0 后置 `muted=true` 并恢复 volume 原值（muted 状态下 volume 不发声），`fadeInVolume` unmute 后从 0 渐回；切P时 video 元素可能被 B站替换，`fadeInVolume` 用的 `state.video` 是新 P 的 video
42. **冻结帧与淡入淡出**：`freezeFrame`/`unfreezeFrame`、`fadeOutVolume`/`fadeInVolume` 随切P路径无条件调用（`useSeamlessCover` 决定淡出时长 80/200ms）；location.href fallback 路径不走 `holdTransitionUntilFrame`，冻结帧随页面刷新消失
43. **restoreProgress 与 B站"继续播放"提示的竞态**（v1.7.1 修复）：`restoreProgress` 切换分P时未设 `state.switching`，B站自带"继续播放"提示同时改 `?p=` → `onNavigate` 检测到变化且 `!state.switching` → 抢夺 `currentIndex` → 两个进度恢复逻辑打架 → 反复跳转。修复：新增 `state.restoringProgress` 标记，`onNavigate`/`onTimeUpdate` 在此标记期间跳过；`restoreProgress` 切换分P加 `state.switching = true`（try/finally）；恢复完成后延迟 2 秒清除标记
44. **设置按钮全屏可见性**（v1.7.1 修复 → v2.0 重构）：原生全屏只渲染全屏元素子树，挂 `document.body` 的按钮不可见。v1.7.1 的 `fsEl.appendChild(settingsBtn/settingsPanel)` reparent 已移除（v2.0）；现为：进入原生全屏时 `settingsBtn.style.display='none'` + 面板收起 `.visible`，退出时 `ensureSettingsPanelHost(false)` 归还面板 + `applySettings()` 按设置恢复；面板在原生全屏内由 S 键/双击/popup 打开时经 `ensureSettingsPanelHost(true)` lazy reparent 到 fullscreenElement 子树
45. **状态徽章**（v1.7.2 常驻化 → v2.0 默认关 → v3 统一闪现 → v1.12 纯 error）：v1.7.2 起 info/success 不再自动隐藏、由 `showStatusBadge` 设置项控制；v2.0 起默认 `false`，error 无视设置临时显示约 5 秒；v3 起三类消息统一约 5 秒自动淡出；**v1.12 起键删除，函数收敛为纯 error toast（非 error 调用直接忽略），info/success 调用点与 CSS 类一并删除**
46. **底栏时间仅接管总时长**（R2）：`updateBottomTimeDisplay(totalDuration)` 只写「总时长」元素（`.bpx-player-ctrl-time-duration` / `.squirtle-time-duration` / `.bilibili-player-video-time-total` / 容器兜底末 span），不再覆写原生「当前时间」元素（B站自走）；`restoreNativeBottomTime` 保留为退出影院时还原总时长
47. **已删除功能一览**（R2）：跳过指定片段（含 cinema-skips.js、`enableSkips`、`cinemaSkip_*`、Alt+[/]）、片头/片尾跳过（`skipIntro`/`skipOutro`/`introDuration`/`outroDuration`、`ioOverride`、`cinemaIntroOutro`）、幕间 ACT 卡与 `showTransition` 设置键、跨设备进度同步（`deviceSync`、`writeSyncProgress` 等、`cinemaProgressSync`）、onboarding 引导弹窗（`onboardingDone`）。**v1.11 追加**：播放完毕结束卡整体删除（`showFinishedActions`/`hideFinishedActions`、`.cinema-finished-*` 样式、单行「放映结束」提示）——播完无扩展界面；过渡层整体删除（`showTransition`/`hideTransition`、`#cinema-transition` 与 `.cinema-transition-text` 样式、`--c-transition-bg` 令牌、`state.transitionTimer`/`ui.transition` 字段）。**v1.12 追加**：设置键 `showSettingsBtn`/`showStatusBadge`/`p2pBlock`/`p2pTempMs`/`lightsOutOpacity`/`progressStyle`/`theme`/`shortcuts` 及全部子项；悬浮齿轮按钮（`initSettingsBtnDrag`、`cinemaSettingsBtnPos`）；快捷键编辑器（`SHORTCUT_ACTIONS`/`getShortcuts`/`renderShortcutEditor`/`beginShortcutCapture`/`cancelShortcutCapture`、`shortcutCapturing`/`shortcutCaptureHandler` 状态）；备份导入导出（`exportCinemaBackup`/`importCinemaBackup`/`importHistoryMerge`/`importProgressLocalMerge`/`importBookmarksMerge`/`onExportBackup`/`onImportBackupFile`）；六分组折叠架构（`initSettingsPanelGroups`、`cinemaPanelGroups`、`.cinema-sp-section/.sp-group/.sp-caret` 等 CSS）；进度条 minimal 样式、ghost `::before` 预览层与 `--hover-pct` 变量。新增功能请勿复用这些标识符，历史存储中的残留键不读取、不迁移、不清理（防误删用户数据）。