# SPEC — 版本策略与后续路线（v1.14 起）

> 本文档是唯一的执行路径。每个 milestone 合入即对应一次版本发布，完成后在本文件勾选并同步 CODE_WIKI。
> 生成于 2026-09-06，基于全量代码审计（性能/死代码/重复实现/测试缺口均已逐条核实到 file:line）。
> 2026-09-06 更新：用户裁定关灯模式整体删除（看视频时用不到），提前执行完毕 → v1.14.0 已发布，后续 milestone 顺延。

---

## 0. 版本策略

- 格式：`MAJOR.MINOR.PATCH`（Chrome manifest 上限 4 段整数，当前用 3 段）。
- **MINOR**：一批功能或清理合入时递增；与 CODE_WIKI 历史条目的 `vN.N` 标签一一对应。
- **PATCH**：纯 bugfix，不引入行为变化。
- **铁律：三处同步**。发布/每批合入时 `manifest.json` + `package.json` + CODE_WIKI 历史条目必须一起更新——此前 wiki 记到 v1.12 而 manifest 停在 1.10.1，即为追平的原因。
- 版本语义锚点：**1.11**=结束卡删除，**1.12**=设置 18→2 键（禅意收敛），**1.13**=可靠性批次（静音根因/popup 百分比/init 自愈/选集作用域），**1.14**=关灯模式整体删除（用户裁定），**1.15**=隐形提速与死代码清剿（1.15.1 补 click 抑制用例、1.15.2 感知复核修正），**1.16**=数据激活与体验打磨（原拟 v1.17；章节感知经实测挂起，见 §4），**1.17**=切换稳定性补强与单P观感（预取热判定/片尾连跳/关引擎/显示模式记忆/水印收窄/片尾冻帧），**1.18**=系统媒体卡片（MediaSession 标题修正 + 上/下一首复用切P，严格非覆盖 B站；含 content.css 过期注释修正）。

## 1. 设计哲学（一切新功能的门禁）

延续 v1.12「禅意收敛」裁定：

1. **无形优先**：能感知到"变快了/更稳了"的改动 > 新增可见元素。新 UI 必须默认隐形，只在"存在感时刻"（近边界悬停、拖拽跨P）浮现。（v1.16 章节刻度不违反此条：它常态隐形、复用同一状态机浮现；快捷键属硬编码，不增加设置键数量。）
2. **原生观感**：进度条/底栏时间贴 B 站原生样式；不覆盖 B 站已有能力（倍速、弹幕开关、画质菜单）。
3. **设置键上限 3**：当前 2 键（总开关/播完关标签页）。新增设置键需先在本 spec 立项说明理由，超限必须有删项对冲。

## 2. 拒绝清单（不再做，防走回头路）

已删除且不复活（详见 CODE_WIKI 第 47 条）：结束卡、幕间 ACT 卡、片头/片尾跳过、快捷键编辑器、主题切换、进度条样式选择、备份导入导出、进度条画面缩略图预览（videoshot，v2.0 删）、**关灯模式（v1.14 删除：L 键/遮罩/暗角/lightsOut 键；水印净化保留，挂 `cinema-active`）**。

不做：弹幕管理/字幕样式（B 站原生）、跨站推荐。

---

## ✅ Milestone v1.14.0 — 关灯模式整体删除（已完成 2026-09-06）

用户裁定："看视频时根本用不到"。水印净化（挂 `cinema-active`）不受影响；vignette 暗角只被关灯激活，一并删除。

- [x] cinema-ui.js：`updateLightsOut`/`isBigScreenDisplay`/`lastLightsOutAt`/`toggleLights` 分支/`ui.lightsOut`/`ui.vignette` 与 vignette 创建段
- [x] cinema-player.js：`onCinemaPlay`/`onCinemaPause` 及 play/pause 绑定、全屏切换与 timeupdate 热路径里的调用（顺带消除每秒 2 次 × 4 querySelector 热路径开销）
- [x] cinema-core.js：`lightsOut` 设置键、`toggleLights: 'KeyL'`、`CINEMA_OPACITY`
- [x] content.js：resize/scroll 监听、cleanup 类清理
- [x] content.css：`#cinema-lights-out`、`#cinema-vignette`、`cinema-lights-out-active` 水印选择器 34 条（含本就 dead 的 body 组）
- [x] manifest/package 1.14.0、README 特性与快捷键表、CODE_WIKI 同步

## 3. ✅ Milestone v1.15.0 — 隐形提速与死代码清剿（已完成 2026-09-06）

### 3.1 进度条布局抖动（P0）

一次 `pointermove` 做 4 次 `getBoundingClientRect`（cinema-ui.js:498/511/553/678）+ `tooltip.offsetWidth`（:589），中间夹 `fill.width`/`tooltip.left` 写操作 → 每个鼠标事件强制同步重排。

- [x] `seekToClientX`/`showProgressTooltip`/`updateCrossingMarkers`/`nearestMarkerInfo` 共享一次 rect：新增 `barRect()`，处理器在**事件最开头**读一次、以参数向下透传；未透传时各函数回退自读（兼容点击/键盘单事件路径）。
  **⚠️ 偏离原计划**：原写「`pointerdown` 时缓存至 `ui.barRect`，`pointermove` 全程复用，`resize`/`scroll`/`pointerleave` 置空」。改为按事件透传而非跨手势缓存——缓存方案必须在每个可能改变布局的时机失效（页面滚动、网页全屏切换、播放器容器重建、B 站自身改宽），漏一处就会读到旧 rect 导致 seek 落点偏移；按事件透传把测量从 4 次降到 1 次且**无失效路径**，读取点落在处理器开头（布局干净，不触发重排）。
- [x] tooltip 半宽改为**按内容签名缓存**：先把内容在内存拼好，与 `ui.tooltip._lastHtml` 相同则完全不读布局（比每次 mousemove 都量更省），不同才写 DOM 并回量一次。初版曾打算"写入之前读上一帧宽度"，**该判断已推翻**——pill 出现正是宽度约 3 倍剧变的时刻，而此时必然是近边界/跨P悬停，用旧宽度钳制会让 tooltip 溢出进度条端点。
- [x] 设置面板拖拽：面板尺寸在 `pointerdown` 与 rect 一并读一次（拖拽期间恒定），`pointermove` 内不再回读布局；`pointerup` 持久化直接用拖拽期已算出的坐标，省掉收尾那次 `getBoundingClientRect`。

未消除的读取均为冷路径、每事件至多一次（`seekToClientX` 点击、面板打开定位）。

验收：拖拽全程 DevTools Performance 无 Forced reflow 尖刺；拖拽/点击/键盘 seek 行为不变。

### 3.2 player-bridge 网络税（P0）

`player-bridge.js` 劫持全页 XHR/fetch，每次 `open()` 跑字符串匹配 + 8 次属性 delete，对心跳/埋点等所有非播放器流量永久上税。

**⚠️ 实现偏离原计划（重要）**：原计划「非白名单 URL 在 `open()` 首行直接走原生 `origOpen`」**不可照做**——那 8 次 `delete` 清理的是上一次合成响应留下的影子属性（`defineProperty` 装的 `responseText`/`status`/`readyState` 等）。XHR 实例会被复用，若第二次 `open()` 的是非播放器 URL 就早退跳过清理，上一次的合成响应会继续遮蔽本次真实响应结果。此外域名白名单本身有风险：B 站 CDN 域名多变（upos-cd*nex / *-mirror 等），现有 `upgcxcode` 子串判定已等效于白名单。

实际做法（改为按「是否装过影子属性」门控，而非按 URL 门控）：

- [x] 两处合成点（`serveStoredBytes` 206 切片、playurl 本地响应）设置 `self._cinemaSynthetic = true`；playurl 处刻意置位在 `try` 之外，保证 `defineProperty` 序列中途抛错留下半个影子属性时下次仍能清理。
- [x] `open()` 仅当 `_cinemaSynthetic` 为真时执行那 8 次 delete 并复位标记——未合成过的请求（全站绝大多数）完全跳过。属性删除会使宿主对象退化为 dictionary 模式，这是本包装的主要税源。
- [x] `setRequestHeader` 加同样思路的门控：`_cinemaReqRange` 只在字节合成分支被消费（`send` 内 `_cinemaByteCandidate` 为真时才读，且该标记在 `open()` 阶段已定），非候选请求跳过 `String()` 包装 + `toLowerCase()` 分配（全站每个请求每个头部一次）。
- [x] fetch 包装**未改动**：非播放器 URL 在其内只做 2–3 次 `indexOf`，无 delete、无正则（正则都在 playurl 分支内），本就便宜。

验收：非播放器请求的 `open()` 不再触碰属性删除；合成响应后复用同一 XHR 时影子属性仍被正确清理（不回归旧 bug）；切P秒开与 206 合成行为不变。

### 3.3 onTimeUpdate 热路径（P1，约 4Hz）

- [x] 统一 buffered 扫描：`currentBufferedEnd()`（player）与 `updateUnifiedProgress` 内联的同款遍历合并——UI 改为调用该函数并接受调用方透传的 `bufEndCached` **参数**（未新增 `state.bufferedEnd` 字段），`onTimeUpdate` 每 tick 只扫一次 `video.buffered`。
- [x] aria 属性只在整秒变化时写（cinema-ui.js:464-467，秒级粒度对读屏足够）。
- [x] 画质/弹幕捕获的 querySelector 维持现状（已节流到 1Hz），不动。

### 3.4 死代码清剿（P1，净删 ~120 行）

- [x] ~~content.css 整块 `body.cinema-lights-out-active` 17 条死选择器~~（已随 v1.14 关灯删除提前完成）
- [x] 9 个零引用 CSS 变量（`--c-radius-pill`/`--c-panel-bg-solid`/`--c-chip-bg`/`--c-caret`/`--c-option-bg`/`--c-overlay-bg`/`--c-row-hover`/`--c-badge-info`/`--c-badge-success`，两套主题各一份）。
- [x] `.cinema-sp-row`（content.css:437）与 `.cinema-sp-toggle:has(input:disabled)` 4 条（:594-609，JS 从不置 disabled）。
- [x] `ui.timeLabel`/`ui.partLabel` 死字段（cinema-ui.js:15-16）。
- [x] `state.seasonTitle`/`state.aid` 写而不读处逐个确认后删。
- [x] squirtle（番剧）选择器**保留**——manifest 未来可能扩 `/bangumi/`，删除收益低、恢复成本高（挂账不删）。

验收：`grep -c` 上述选择器/变量为零引用；设置面板、主题切换回归正常（关灯已随 v1.14 删除）。

### 3.5 验证基建（P1）

- [x] `package.json` 增加 `"check"` 脚本：`node --check` 全部 8 个 JS + 单测（`&&` 串联，跨平台无需新文件）。
- [x] 为可单测把 `overallTime` 算式从 `updateWatchHistory` 内联处抽成纯函数 **`overallFromPart(cumulative, part, time)`**（`cinema-utils.js`，符合约束 19「纯函数留 utils」），并补 3 个用例：与 `overallToPartOffset` 的往返一致性、边界与非法输入、**58% 正解 / 25% 反例**回归（防有人再用 P 内 `time` 除以电影 `totalDuration`）。
- [x] `_suppressClick` 500ms 窗口语义用例：判定已从 `onProgressBarClick` 内联式抽成纯函数 **`isClickSuppressed(stamp, now, windowMs?)`**（`cinema-utils.js`），魔数收敛为 `CLICK_SUPPRESS_MS` 常量（原散落在 pointerup 注释与 click 判断两处）；用例覆盖窗口内/外、**右边界严格小于**（正好 500ms 不再抑制）、stamp 为 0/空、自定义与缺省窗口，并固化「时钟回拨时判为抑制」这一与原内联式一致的既有语义。单测 34 → 38。

---

## 4. 【挂起】章节感知（原拟 v1.16）

> **状态：挂起，不排期**（用户裁定 2026-09-18："确实不是经常看见"）。
> 挂起理由：见 §4.0 实测——抽样 5 个真实视频 `view_points` 全为空，用户自身观剧经验亦确认原生章节提示很少出现。在覆盖率证实之前投入三件套 UI，做完大概率永远不显示，属零收益工程。
> **复活条件（满足任一）**：① 用户在实际观看中确认某类视频（付费课程/PGC/特定UP）确有章节，覆盖率可观；② 未来出现另一条不依赖 UP 手填的章节数据源。
> 下方设计（§4.0.1–4.5）为已完成的技术调研，**保留备查勿重写**——尤其 §4.0.1 第 1 条（原生浮层被我们压掉，不能靠取消隐藏白拿）与 §4.4 的降级策略，将来无论做否都成立。


### 4.0 ⚠️ 实测发现：数据覆盖率存疑（2026-09-18，未开工前先验）

用免登录请求实测 `api.bilibili.com/x/player/v2?bvid=&cid=`（**接口可达、`code=0`、响应里确实有 `data.view_points` 键**，且无需新增扩展权限）。但抽样 5 个真实视频，`view_points` **全部是空数组**：

| 样本 | 类型 | 时长 | view_points |
|---|---|---|---|
| BV1GJ411x7h7 | 官方 MV | 短 | `[]` |
| BV1PUej65E41 | 纪录片《生命奇观2》 | 51 分钟 | `[]` |
| BV1f2eJ6GE79 | 国创《时光代理人》S3 | 25 分钟 | `[]` |
| BV1BtZJYBE4G | 知识区排行榜榜首（历史调研室） | 51 分钟 | `[]` |
| BV1WVfcYFEiX | 知识区（罗翔） | 6 分钟 | `[]` |

**含义**：章节数据不是普遍存在的，很可能只在 UP 主手动填写稿件时间轴、或付费课程/PGC 场景下才有；也可能依赖登录态/浏览器上下文才下发（`player/v2` 的不少字段是上下文相关的，服务端裸请求拿不全）。**本 milestone 的实际收益取决于覆盖率，而覆盖率尚未证实**——在没有章节的视频上，这套 UI 永远不会显示任何东西。

**据此定下的两条对策（不再把样本当阻塞项）**：

1. 解析层**不假定字段拼法**，兼容 `content ?? title`、`from ?? start`、`to ?? end`，缺标题或缺起始时间的项直接丢弃；拿不到数据即零渲染。这样字段名无需先验锁定也能开工，且对 B 站改名有韧性。
2. 实现时随解析带一条 `console.debug('[cinema] view_points', raw)`（仅在数组非空时打印），首个真实命中即可自查字段形状，不需要人肉提供样本。

**开工前置问题（需用户回答）**：你平时看的视频里，B 站进度条上**是否真的出现过章节名提示**？若几乎没有，v1.16 应从"新功能"降级，把预算挪给 v1.17 的确定收益项（watched 累计时长、书签收敛、轮询合并）。

B 站视频章节数据：`GET https://api.bilibili.com/x/player/v2?bvid=<bvid>&cid=<cid>`（带 cookie）→ 响应中的 `data.view_points`（**字段名与结构以实测为准**：历史上该数组还可能混入游戏任务点、闪屏、运营位等非章节标记，解析层必须按 `type`/`icon_url`/`content` 非空做过滤，不可假定"数组里都是章节"）。

### 4.0.1 先厘清的两件事

1. **为什么不是"把原生浮层取消隐藏"就完事**：我们接管进度条时把原生整条链路都压掉了（`content.css` 的 `body.cinema-bottom-progress` 组规则将 `.bpx-player-progress-popup` / `-shadow` / `-floating` 一并 `opacity: 0; pointer-events: none`）。原生浮层锚定的是**只覆盖当前 P 的原生条**，而我们的条是**整部电影时间线**——恢复它会在悬停时与我们的 tooltip 同时弹出、且坐标口径不一致。所以章节信息必须由我们自己渲染。
2. **本 milestone 的范围（用户裁定）**：标记 + tooltip + 跳转三件都要。只做 tooltip 被判定为不达标的理由是：人看章节的诉求是"知道哪儿是哪儿、然后跳过去"，只给文字会逼用户沿进度条逐点悬停试探，比原生更累。

### 4.1 视图模型与时间线映射

- [ ] `state.viewPoints`：`[{ start, end, title }]`，**归一化到当前 P/当前集的本地秒数**；非法项（`title` 空、`start` 非数字、`start >= end`）解析时丢弃。
- [ ] `state.viewPointsCid`：已拉取过的 cid，同 cid 不重复请求（每P至多 1 次网络请求）。
- [ ] 时机：`onVideoReady`（拿到当前 cid 后）异步拉取；切P/切集后 cid 变化 → 清空并重拉。**异步到达后必须能补建标记**，不得假设它与进度条同期就绪。
- [ ] 电影时间线映射：章节在统一进度条上的位置 = `(cumulative[currentIndex] + start) / totalDuration`，与分P标记共用同一百分比换算路径（复用 `buildMarkers` 里已有的换算，勿另写一套）。
- [ ] 合集（season）模式同样适用：每集的 view_points 按该集 cid 拉取，映射逻辑一致。

### 4.2 二级刻度渲染（视觉分级 + 过密抽稀）

- [ ] 章节标记挂在**新的独立层**（与分P标记 `ui.markers` 分开），便于两套样式与各自的显隐控制；DOM 结构复用 `buildMarkers` 的写法惯例。
- [ ] 显隐**并入既有"存在感时刻"状态机**：常态隐形，仅在悬停近边界（≤`MARKER_NEAR_PX`）或跨P拖拽时与分P标记一同浮现——复用 `markers-revealed` / `crossing` 状态类，不新增第三种显隐机制。
- [ ] 视觉分级：分P边界保持现有亮色粗标记；章节用更细、更暗、更短的刻度，保证 20+ 章节的网课不糊成一片。具体尺寸在实现时定，验收标准是"两套标记同屏时一眼能分辨哪个是集、哪个是小节"。
- [ ] **抽稀规则**：相邻章节刻度像素间距低于阈值（约 14px）时按间隔抽稀（每 N 取 1），避免重叠；抽稀是显示层的，不影响跳转目标集合。

### 4.3 跳转交互（须与现有 click-to-seek 无歧义共存）

现有语义：单击进度条 = seek 到该坐标。章节跳转不能再复用"点击坐标"表达，二者按 hit 区域区分：

- [ ] **点击章节刻度本身**（刻度给一个高于条身的可点热区）→ 跳到该章节 `start`，`stopPropagation` 避免同时触发条身 seek。
- [ ] 点击条身其它位置 → 保持现有 seek 到坐标的语义，不变。
- [ ] 键盘：`SHORTCUT_DEFAULTS` 新增章节上一/下一（建议 `,` / `.`，与 B 站原生无冲突；注意勿复用曾属跳过片段功能的 `Alt+[` / `Alt+]`，见约束 47），在当前P内跳上一/下一章节，跨P边界时落到相邻P的首/末章节。
- [ ] tooltip：命中章节时追加章节名；近边界/跨P形态下为 `电影总时间` + `Pn · 分P标题` + `章节名`。

### 4.4 防御与降级

- [ ] 拉取失败、字段改名、`view_points` 缺失 → 静默降级为"无章节"，UI 回到 v1.15 现状，不报错、不显示空刻度。
- [ ] 标记数异常（如 > 40）视为非章节数据（B 站把时间轴打点当 view_points 返回的情况），整层不渲染。
- [ ] 无章节视频：逐像素与 v1.15 一致（这是硬验收项）。
- [ ] 纯解析/抽稀/映射逻辑抽成 `cinema-utils.js` 纯函数并补单测（约束 19），API 响应字段以真实抓包为准后再定形。

### 4.5 验收标准

1. 有章节的多P视频：悬停可见章节名；浮现状态下能看到二级刻度且与分P标记可分辨；点刻度跳到章节起点；`,`/`.` 在P内与跨P边界行为正确。
2. 无章节视频：与 v1.15 逐像素一致，且**不产生额外 API 请求**以外的任何视觉变化。
3. 每P额外网络请求 ≤ 1 次；同一P内来回切P不重复请求（`viewPointsCid` 生效）。
4. 切到合集下一集后章节标记跟随更新（不残留上一集）。
5. `npm run check` 全绿；新增纯函数有单测覆盖。
6. 手动回归新增一项：见 §6 第 8 条。


## 5. Milestone v1.16 — 数据激活与体验打磨（**下一个执行批次**）

> 取代挂起的章节感知（§4）：以下四项收益均不依赖任何未证实的外部数据覆盖率，属确定收益。

- [x] **watched 死链激活**：popup「正在观影」卡副标题追加「累计观影 X 小时 Y 分」（新纯函数 `formatDurationCN` 输出，0/非法返回空串则整段不显示）。
  **⚠️ 与原计划差异**：原写"`cinemaHistory` 各记录 `watched` 求和"。实现时改为**只取当前这一条记录的 `watched`**——hero 卡描述的是"这部电影"，把用户看过的所有片子的时长加总显示在一部片下面是错误语义。跨片统计若要再做，应放到独立汇总位。
- [x] **书签双实现收敛**：做得比原计划彻底。原计划是"background 补清洗去重 + 两处 `BOOKMARK_LIMIT` 互相注释提醒"，实际改为**单一来源**：`cinema-utils.js` 新增 `sanitizeBookmarkList` / `toggleBookmarkEntry`（容量数字 `BOOKMARK_CAP` 只在此文件内，刻意不导出以免与各文件顶层 const 撞全局词法作用域），`cinema-core.writeBookmarks`/`toggleBookmark` 与 `background.toggleBookmarkInStorage` 全部改调这两个函数，两处本地 `BOOKMARK_LIMIT` 删除。为此让 popup 与 SW 也能吃到库：`popup.html` 在 `popup.js` 前加 `<script src="cinema-utils.js">`、`background.js` 顶部 `importScripts('cinema-utils.js')`（manifest 的 background 未声明 `type: module`，属经典 SW 可用）。background 侧由此补上此前缺失的写入消毒与去重。
- [x] `waitForVideoChange` / `waitForVideoChangeSeason` 合并：抽出 `pollUntil({probe, onTimeout, maxAttempts=100, intervalMs=100})` 承载共有的轮询骨架（`switchEpoch` 代际作废、attempts 计数、超时交由调用方决定返回值），两函数只保留各自的落地副作用与恢复动作；行为逐分支等价。
- [x] `renderRecent` / `renderBookmarks` 同构收敛为 `buildListRow(item, sub, onOpen, onRemove?)`；顺带删除 popup 本地第三份 `escapeHtml`/`mm:ss` 实现，改复用 utils——**并修掉一个既有缺陷**：本地 `fmtTime` 只会输出 `mm:ss`，65 分钟的视频曾显示成「65:00」，`utils.formatTime` 对超 1 小时输出 `h:mm:ss`。
- [x] 新增纯函数单测 3 组（`formatDurationCN` / `sanitizeBookmarkList` / `toggleBookmarkEntry`），单测 38 → 41。

## 6. 手动回归清单（每 milestone 发布前跑一遍）

无浏览器自动化基建，以下人工验证（加载未打包扩展）：

1. 多P视频：自动连播跨 3 个P（API 切换路径）、切P后进度/倍速/画质/弹幕记忆保持。
2. 统一进度条：拖拽跨P（含松手后无重复 seek）、键盘 ←/→/Home、悬停 tooltip 三态（单P内/近边界/跨P）。
3. SPA 导航：视频A→B→A 连续跳转，无监听器累积（Memory 面板对比）、影院模式每次都激活。
4. 设置面板 S 键开合与拖动、popup 开关同步；L 键应无任何响应（关灯已删）。
5. 合集（ugc_season）视频：跨 bvid 切集、共享进度键生效。
6. 单P视频：扩展不接管进度条（原生观感）。
7. `npm run check` 全绿。
8. popup「正在观影」卡（v1.15.2）：找一条**旧的多P观影记录**（无 `overallTime` 字段），确认进度行是**收起**的而非停在某个固定比例；再看一条新记录确认百分比随实际观看位置变化。「最近放映」列表副标题应为「播放至」而非「已看」。
9. 章节（随 §4 挂起，暂不作为验收项）：挑一个**有章节的多P网课**验证悬停章节名、浮现刻度、点刻度跳转、`,`/`.` 跨P边界；再挑一个**无章节视频**确认与 v1.15 观感逐像素一致；切到**合集下一集**确认章节标记更新不残留；DevTools Network 确认每P `player/v2` 至多 1 次。

## 7. 明确不做性能优化（避免过度工程）

- `setInterval(checkUrl, 1000)`（content.js:49）：永不清理是有意设计（SPA 兜底），幂等，不动。
- MutationObserver 300ms 防抖已足够，不引入 IntersectionObserver 重构。

---

## ✅ Milestone v1.17.0 — 切换稳定性补强与单P观感（已完成）

**三件事共同主题：** 切换链路的竞态收敛（「还是闪一下」有结论）、总开关语义诚实（关了真的停引擎）、单P原生观感不再被氧化（只藏水印不藏顶栏）。

### 7.1 切换链路稳定性（不变界面，只修根因）

- [x] **预取热判定**：只有主视频变体（`primary===true && kind==='video'`）落盘才写 `prefetchOkCid`（`cinema-player.js:792`），音频先到不再误判秒开；`writeByteStore` 增加 `primary` 参数，仅首轮排序后第一个视频变体置位（`player-bridge.js:332-352`）。
- [x] **同 cid 预取不重复**：`doPrefetch` 忙碌时 busy 应答带 `same` 标记（`player-bridge.js:816-826`），content 侧仅非 same 时清 `preloadedCid`（`cinema-player.js:768-774`）；`prefetchBusy` 从「playurl 解析完即放开」改为「`livePrefetchXhrs` 全落地才放开」（`player-bridge.js:259`）；一条流都没有时显式放行（`player-bridge.js:937-942`）。
- [x] **关总开关真的停引擎**：`onTimeUpdate` / `preloadNextPart` / `onVideoEnded` 均在 `!settings.enabled` 早退（`cinema-player.js:1066-1073` / `:710-711` / `:1128`），唯独进度保存保留（关了再开仍能续看）。
- [x] **片尾不再连跳一整 P**：新增 `state.advanceTarget`（`cinema-player.js:1236`），`goToNextPart` 在其非空时拒绝重入（`:1203`）；落地、失败、整页跳转前、`cleanup` 时清空。
- [x] **API 轮询照 `switchEpoch`**：`waitForPlayerAPISwitch` 捕获启动时代际，`cleanup` 作废残留轮询不再改新页面（`cinema-player.js:1446-1479`）。
- [x] **淡出定时器可取消**：`cancelFadeOut`（`cinema-player.js:1719-1728`）防止 SPA 复用 video 节点时把下一页视频误静音；切换失败和 `cleanup` 都会调。
- [x] **继续观影带分 P**：popup「继续观影」有 `histItem` 时与「最近放映」共用 `historyUrl(histItem)`（`popup.js:170-176`），不再总是落回 P1。
- [x] **观影记录内存缓存**：`historyCache` + `onHistoryStorageChanged`（`cinema-core.js:308-331`）只在别的设备写入时才失效缓存，播放中不再每 5 秒全量拉 sync；防抖写失败丢缓存避免旧快照盖远端。
- [x] **书签记电影时间**：`toggleBookmarkEntry`/`bookmarkUrl`（`cinema-utils.js`）增加 `part`/`overallTime`；popup 副标题显示「第 N 集」；恢复只在用户显式打开该书签对应分 P 时才用书签时间，同集总是观影进度优先——旧书签缺字段，仍从片头开始。

### 7.2 单 P 观感修正（继续不接管进度条，不再误伤原生元素）

- [x] **水印净化收窄**：顶栏 `.bpx-player-top-wrap` 与互动弹幕 `.bpx-player-cmd-dm-wrap` 从 `cinema-active` 组挪到 `cinema-bottom-progress` 组（`content.css:228-245`）——本就只在「接管进度条」（enabled 且多P）时才该藏；单 P 不再失去原生顶栏与弹幕入口。单P 冻结也改为仅多P才冻（`cinema-player.js:1076-1085`），避免单 P 片尾误被 frozen。
- [x] **片尾钉末帧（多 P 电影落幕）**：`onVideoEnded` 最后一集且 enabled/isMultiPart 时调 `freezeFrame` 钉住谢幕画面（`cinema-player.js:1135-1146`）；freeze canvas `pointer-events: none`，首个 `pointerdown`/`keydown` 通过 wrap 捕获阶段的 `armFreezeRelease` 一次性监听 `unfreezeFrame` 并把同一手势放行——不 stopPropagation，B 站原生推荐墙在同一手势接管；切 P 成功/失败、`cleanup` 都会 `disarmFreezeRelease`。

### 7.3 会话级显示模式记忆

- [x] **`prefs.displayMode`**：`cinema-core.js:75` `prefs` 新增 `displayMode: 'normal'`，与 rate/volume/quality/danmaku 同一套 `savePlayerPrefs` 落盘；`persistDisplayMode`（`cinema-player.js:457-464`）在 `switchToPart` 探测到当前模式时写（`cinema-player.js:1286`），原生全屏不记（浏览器手势要求）。
- [x] **页载恢复**：`content.js:321-326` 从 `prefs.displayMode` 读并在播放器就绪后恢复；删除原 `sessionStorage.cinemaDisplayMode` 一次性写入路径（切换失败重试/中途关页误恢复的问题一并消除）。第三方审计（v1.17 复核批次）已核实 `cinema-active` 挂的是 `settings.enabled` 单条件——这条注释记在 `content.css` 水印组开头并保留在 CODE_WIKI。

### 7.4 明确缓做（与门禁对齐）

- **A-B 段循环**：SPEC §1「无形优先/原生观感」与 §1.3 设置键上限 3 不兼容——受众（练舞/语听写/乐器跟练）与「把分P拼成一部电影」路径不同，做它要么新增设置键要么新增 UI 入口。等用户明确提出再立项。
- **章节覆盖率再测**：SPEC §4 已挂起并写明复活条件是「付费课程/PGC 类确有章节」，拿到真实样本前不动。

---

## ✅ Milestone v1.18.0 — 系统媒体卡片（MediaSession）+ 注释修正 + 分P标签口径合一（已完成）

**主题：** 一批只碰「装饰层」的改动，严格不进播放时序。按风险筛子（新增定时器？新增切P事件源？新增跨世界通道？新增写盘/改 src？）过一遍：B1 仅命中「新增切P事件源」一项，且通过复用键盘 N/P 的同一函数把新竞态类别降为零；其余提案（B2 stalled 自愈、A3 预取字节数、B4 hover 预取、首帧底色、章节/A4）本批全部撤下或缓做。

### 8.1 B1 系统媒体卡片（MediaSession）

用户可感知：多P电影在系统/浏览器媒体卡片（Chrome 工具栏媒体控件、Windows 系统媒体浮层）里显示**当前分P标题 + 电影名（专辑）**，并随切P刷新；卡片「上一首/下一首」切上/下一 P。

- [x] **隔离世界直接实现，无需 MAIN world**：`navigator.mediaSession` 是 Web API（MDN Baseline，2021 起），隔离世界可直接读写——与需要 `window.player` 的切P不同，**不改 player-bridge.js、不加跨世界消息通道**。（开工前先验的关键事实，结论：~30 行版本。）
- [x] **§1.2 严格非覆盖 B站**：实测 B站自身已注册 `play`/`pause`/`seekbackward`/`seekforward`/`seekto` 与 metadata。本批**一律不碰**这些；只 ① 覆盖 metadata 的 `title`（当前分P标签）与 `album`（电影名），`artist`/`artwork` 从 B站现有 metadata 读出后原样保留（读不到才回退 `state.pic`）；② 补 B站**未注册**的 `previoustrack`/`nexttrack`（Chrome 卡片里本就置灰的上/下一首）。
- [x] **上/下一首复用键盘同一切P函数**：抽出 `cinemaNextPart()`（→ `goToNextPart`，受 `advanceTarget` 守卫）/ `cinemaPrevPart()`（→ `jumpToPart(currentIndex-1, 0)`），键盘 `nextPart`/`prevPart` 分支与 MediaSession handler 共用，**不另写路径**——第三个切P入口不引入新竞态类别。到首/末 P 时对应 handler 置 `null`，卡片按钮置灰（与守卫一致）。
- [x] **门禁与更新时机**：`settings.enabled && state.isMultiPart` 为真才注册；否则两个 handler 置 `null` 且**不动 B站 metadata**（单P/关闭 = 原生卡片）。`updateMediaSession()` 幂等，挂三处：`applySettings`（setup + 开关切换）、`onVideoReady`（覆盖任意切P路径，含 B站原生选集点击/SPA 导航）、`switchToPart` 落地（`currentIndex` 已定的权威刷新）；`teardownMediaSession()` 随 `cleanup` 移除 handler 防跨页残留。
- [x] **零时序风险**：不加定时器、不写盘、不改 `video.src`、不进 `onTimeUpdate` 热路径；**刻意不实现 `setPositionState`**（进度条/scrub 仍归 B站，避免与 §1.2 及热路径冲突）。设置键数不变（仍 2，§1.3 上限 3）。

### 8.2 注释修正（假改动）

- [x] `content.css:197` 悬停预览气泡注释原写「画面缩略图 + 时间码 + 紧凑分P标签」，与实现不符——videoshot 画面缩略图预览已按 §2 拒绝清单删除（CODE_WIKI 约束 20），tooltip 现为纯文字。改为「时间码 + 近边界/跨P时的分P标签；无画面缩略图」。

### 8.3 分P标签口径合一（重构，行为不变）

**动机：** B1 落地时留了一个诚实的残留——`mediaSessionPartLabel`（媒体卡片标题）与 `showProgressTooltip`（进度条悬停气泡）各内联了一份「第n集 · 名 / P页 · 名」标签格式，两处需手动对齐、易漂移（原约束 59 尾部即为此注记）。B1 曾刻意回避进度条故未合并；本批在同一 v1.18 内清理该残留。

- [x] **抽成单一纯函数**：`cinema-utils.js` 新增 `partDisplayLabel(mode, index, part)`——season→`第{index+1}集 · 名`，pages→`P{part.page} · 名`，无名不带 ` · `，空 `part` 返回空串。符合约束 19（纯函数入 utils + 单测）与约束 58（导出名全局唯一，已 grep 确认无任何文件顶层撞名）。
- [x] **两处调用点退化为薄适配**：`showProgressTooltip` 内联块与 `mediaSessionPartLabel` 均改调 `partDisplayLabel`。**输出字节完全一致**——故 `showProgressTooltip` 的 `_lastHtml` 内容签名缓存（约束 57）与 v1.15 reflow 优化不受影响（新函数不读布局、不进热路径）。
- [x] **零时序风险**：纯字符串格式化，无 DOM/chrome 依赖、无定时器、不改 `video.src`、不新增切P入口；风险筛子四问全部为「否」。设置键数不变（仍 2）。新增 5 条单测，`npm run check` 47/47 全绿。

### 8.4 验收（并入 §6 手动回归清单）

1. 多P电影：系统媒体卡片标题为当前分P、专辑为电影名，切P后刷新；封面/UP 名保持 B站原样。
2. 卡片「上一首/下一首」切上/下一 P，与键盘 P/N 行为一致；首P时「上一首」置灰、末P时「下一首」置灰。
3. 单P视频 / 总开关关闭：卡片完全交还 B站（不改标题、无上/下一首），与 v1.17 一致。
4. B站的播放/暂停/快进/快退/进度拖动在卡片里仍正常工作（未被覆盖）。
5. 进度条悬停气泡的分P标签与切P后媒体卡片标题**文字完全一致**（合一后同一 `partDisplayLabel` 产出）；tooltip 出现/消失无横向溢出（`_lastHtml` 缓存与端点钳制未受影响）。
6. `npm run check` 全绿（47 项，含 `partDisplayLabel` 新增 5 条单测）。
