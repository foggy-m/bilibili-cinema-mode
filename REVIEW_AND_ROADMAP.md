# v1.16 稳定性批复核 + 下一步路线

本文档分两部分：第一部分回看工作区内这批稳定性/一致性改动是否可靠，把核实过的问题逐一给出 file:line 与证据；第二部分把「单 P 观感与显示记忆」小批次列为下一版可以一次发走的路线。

---

## 第一部分：这批稳定性改动复核

### 整体判断

这批改动整体站得住：

- 热判定（`prefetchOkCid` 只看「主视频变体落盘」）确在 `cinema-player.js:787-793` 收紧，音频先到不再把影片当热。
- busy 应答不再清同 cid 槽位，确在 `cinema-player.js:765-772`：改成 `!d.same` 才 `preloadedCid = null`，同 cid 不回槽避免 content 侧 `preloading` 30 秒兜底卡。
- `advanceTarget` 防连跳在 `cinema-player.js:1204`/`:1237`/`:1272`/`:1286`/`:1299`/`:1333-1336` 都有，加在 `goToNextPart`、`switchToPart` 入口，整页跳转与失败分支都显式清槽，落地即清。
- `cancelFadeOut` 回收在 `cinema-player.js:1740-1749`、`fillIn` 路径 `:1754-1764`、`switchToPart :1749` 都有调用，SPA 复用同一 video 节点时残留 interval 不再继续把新片 volume 写成 0。
- 旧书签不编假进度：popup `openBtn.onclick` 走 `historyUrl(histItem)` 或 `historyUrl({bvid:current.bvid})`（`popup.js:174-176`)，书签条目只在 `item.part > 1` 时拼 `第 X 集` 副标题（`popup.js:283-287`)，不造的 `part=1` 默认值。
- 42 个单测全过（见下方「check 结果」）。

最危险的一条是 `content.js:273` 的预取结果监听：注册时机是无条件的（不看 `settings.enabled`），但只看 enabled 不能拆矛盾；它真正的问题在另一条——页面开着期间用户再也遇不到「从 enabled=false 翻回 true」时，`prefetchDoneHandler` 其实一直都在，倒不是漏注册。

综合看，本批唯一真正的高危点是 medium 级的 `popup.js:175`——`histItem` 是 12 条历史里 bvid 匹配的第一条，但历史的进度 key 对合集是 section 级（`cinema-core.js:127-131`、`cinema-core.js:461-463`)，条目里的 `bvid` 只反映**最后一次写入时**用户正停那一集（`cinema-core.js:282`)，并不是子合集共享的稳定 id。当前页若正停在合集另一集，`bvid` 对不上——`buildCurrent` 要么取不到 `histItem`（走 fallback `historyUrl({bvid: current.bvid})`，跳到合集页的 P1)，要么命中的是以前停在别集时写的那条记录（其中 `mode: 'season'`、`part` 是那一集的序号，`historyUrl` 对 season 又不带 `?p=`，仍然会落到错的入口）。也就是说「继续观影」会把用户开到合集的**另一集**去——正是 SPEC §4.0 警告过的那种拖拽问题在 popup 入口的复刻。

`cinema-ui.js` 新增的 `toggleCurrentBookmark` 里 `state.pages` 虽然在 pages/season 两种模式下都被写入，但 season 模式 `overallFromPart(state.cumulative, ...)` 用的是同一部电影的拼接时间线、书签上挂的 `mode: 'season'` 与之匹配（`cinema-ui.js:47-53`)，这条没错。

其余都是 low/medium 的一致性与边界毛刺，具体如下。

### 确认过的问题（按严重度排序）

| # | 级别 | 位置 | 问题 | 证据 |
|---|---|---|---|---|
| 1 | **medium** | `popup.js:175`(openBtn.onclick) + `popup.js:113`(histItem bvid 匹配） | 「继续观影」对合集（season 模式）会把用户开到**错的入口**:bvid 匹配不到或命中的是别集写下的那条历史，fallback 或 season 的 `historyUrl` 都会落到合集 P1 / 另一集的观感 | 历史 key 用 section(`cinema-core.js:127-131`、`:461-463`)，条目 `bvid` 只是「最后一次写入时所在集」(`cinema-core.js:282`);sort by ts 前 12 条 history(`background.js:70-80`),`popup.js:113` 按 `bvid === current.bvid` find |
| 2 | low | `cinema-ui.js:1112` 与 `cinema-ui.js:1115` | `cinema-active` 挂的是 **`settings.enabled` 单条件**，不 AND `isMultiPart`(AND 条件只在 `:1106` 的 `isCinemaActive`、用于 `:1111` 的 `cinema-bottom-progress`)。单 P 视频 body/playerWrap 也会拿到 `cinema-active` → `content.css:771-772/788-789` 的 `.bpx-player-top-wrap` / `.bpx-player-cmd-dm-wrap` 一并被隐藏，把原生顶栏与互动弹幕（cmd-dm）打掉 | `git diff applySettings` 可见 `cinema-active` 两行的设置条件；CSS 选择器在 `content.css:765-802` 的 `body.cinema-active` + `.cinema-active` 大组里 |
| 3 | low | `cinema-utils.js:33-41` `formatRelativeTime` | 已导出、41 个单测里有 5 个在用，但 popup/hero 副标题、`buildListRow` 副标题当前都没调用 | grep `formatRelativeTime` 全仓库除了导出与测试无 UI 调用 |
| 4 | low | `cinema-core.js:48-107` 的 `state` / `ui` 初始化区 | `bottomTimeCache`、`hoverHandlers`、`captureTick`、`prefetchDoneHandler`、`onDemandPrefetch` 都是动态挂的暗字段 | `cinema-ui.js:137/148/152/418`、`cinema-player.js:771/784/856/857/865/1111`、`content.js:272/394`；初始化区未声明 |
| 5 | low | `cinema-ui.js:148`(`ui.bottomTimeCache = null`) | cleanup 时未显式清 `bottomTimeCache`;`content.js:361-364` cleanup 也没 `.remove`,(`ui.*` 的清理零散） | `cinema-ui.js:137-170` 依赖 `cache.node.isConnected` 兜底重查——功能正确但属半清理项 |
| 6 | low | `state.bookmarksCache` (cinema-core.js:549) | 页面内 `isBookmarked` 走同步缓存；popup/background 走 `chrome.storage.sync.get` 重新读（`background.js:134`、`cinema-core.js:552-563`)。同源但两套读法，v1.16 只把写收进 `toggleBookmarkEntry` 单一来源，读这一侧还是散 | `cinema-core.js:544-570`、`background.js:129-145`;popup buildCurrent 里 popup 直接用 background 返回的 list，未走 `sanitizeBookmarkList` |
| 7 | low | `sessionStorage.cinemaDisplayMode` 生命周期 | `cinema-player.js:1273/1287/1637/1677` 写、只在 `content.js:321-326` 读+remove；失败重试/用户中途关页时残留，下一次普通刷新会误恢复上一次模式 | 只有 `onVideoFound`/`init` 消费该 key;prefetch 切换失败时 release 中没有兜底 remove |
| 8 | low | `cinema-player.js:1900-1927` `restoreProgress` 单 P 静默 return | 单 P 视频若 `loadProgress` 拿到别片的 `progress.bvid` 且 `getProgressKey()` 不等，函数直接 return，未留日志，也（正确地）不走 `showStatusBadge` | `cinema-player.js:1921-1925`；徽章在 `cinema-ui.js:82-101` 已改成 error-only。但日志静默 = 排查「为什么没恢复」时看不到原因，归到路线 5 去补 |

### 未能复现但保留的疑点

- **`content.js:273` 预取结果监听的注册时机**：注册是无条件的（不看 `settings.enabled`)。只看 enabled 本身不构成 bug——设置在 `settings.enabled=false` 时 `preloadNextPart` 入口已被 `if (!settings.enabled) return;`(`cinema-player.js:711`）挡，不会产生 done 事件；`prefetchDoneHandler` 一直处于注册状态，也不存在漏注册。**结论**：不是问题，仅复核记录。
- **`cinema-ui.js:41-63` `toggleCurrentBookmark` 的 `state.pages` 混用**:season 与 pages 两种模式 `pages` 字段都被写入，但 season 的 `overallFromPart(state.cumulative, ...)` 用同一部电影的拼接时间线，书签的 `mode: 'season'` 与之一致。核对无误后，这条「最危险」其实**不构成 bug**，不再追。

### check 结果

- 命令：`npm run check`(= `node --check` × 8 个源码 + `node --test tests/unit.test.js`)
- 实际输出：`tests 42 / pass 42 / fail 0`,exit code **0**
- **与任务书中「未通过」的描述不一致**：本会话实跑下来是全绿。后面原因不确定——可能是上轮运行环境不同，也可能当时工作区里还有别处问题。**如实报告：我这次跑的 check 是通过的。**

---

## 第二部分：后续路线

### 整体判断

这批稳定性/一致性改动（prefs 记 displayMode + 页载按 prefs 恢复一次、水印两条从 `cinema-active` 挪进 `cinema-multi-part`、片尾钉末帧复用 `freezeFrame`）和「单 P 进度恢复静默校验」放同一批最顺——它们共享同一条主题线：

- 让插件在**单 P 页**既不氧化原生体验（只藏水印不藏顶栏、恢复失败不惊扰）,
- 又在**多 P 页**补上两处确定收益（会话内模式记忆、片尾不被推荐墙劫持）。

三者都符合 SPEC §1.1 无形优先、§1.2 不覆盖 B 站已有能力、§1.3 设置键不超 3 且不新增任何 UI 入口，可以打成一个 **v1.17 「单 P 观感与显示记忆」小批次**一次发走。

### 建议做（按顺序）

| # | estimate | 任务 | 为什么 |
|---|---|---|---|
| 1 | small | **prefs 增加 `displayMode`，按会话记忆播放器宽屏/网页全屏** | `state.prefs` 已持久化 rate/volume/quality/danmaku 四件套（`cinema-core.js:75`)，唯独 `displayMode` 只在 sessionStorage 留 `cinemaDisplayMode` 一次性写入（`cinema-player.js:1273/1287/1637/1677`)，换会话就丢；这是对「记忆观看偏好」这一既有能力的补齐而非新功能，符合 SPEC §1.1 无形优先，不新增设置键。 |
| 2 | small | **页载时按 `prefs.displayMode` 恢复一次显示模式** | 当前恢复路径只在「整页跳转切 P 回来」对 sessionStorage 读一次（`content.js:321-326`)；改成如果 `prefs.displayMode` 非 `normal` 且无 in-flight 切换，按 `restoreDisplayMode` 走一遍（`cinema-player.js:458`)——复用既有恢复函数即可，仍然是「隐形提速」，无 UI 变化。 |
| 3 | small | **水印净化把 `.bpx-player-top-wrap` / `.bpx-player-cmd-dm-wrap` 从 `cinema-active` 组挪到 `cinema-multi-part` 组** | 这两条藏在 `content.css:771-772/788-789` 的 body/`.cinema-active` 水印大组里；注意 **`cinema-active` 实际挂的是 `settings.enabled` 单条件**（`cinema-ui.js:1112/1115`，不是原文里写的 settings.enabled AND isMultiPart——那是 `cinema-bottom-progress` 的 `isCinemaActive`,`cinema-ui.js:1106/1111`)。单 P 视频上插件不接管进度条/timeupdate 热路径也短，但这两条仍把原生顶栏与互动弹幕（cmd-dm）一并藏掉，违反 SPEC §1.2「原生观感：不覆盖 B 站已有能力」。 |
| 4 | medium | **片尾钉末帧复用 `freezeFrame`,点一下才放原生推荐墙** | `freezeFrame/unfreezeFrame` 已在 `cinema-ui.js:779-820` 把 P1 末帧钉在播放器上、P2 首帧揭掉；B 站播完是 ended 后由原生推荐墙接管，`onVideoEnded` else 分支（`cinema-player.js:1127-1147`）目前只是 `suppressNativeAutoplay` + `maybeCloseTip`。在同一分支多 P 电影尾帧调用 `freezeFrame` 并把「点击揭帧」绑到 wrap 上一次，是「存在感时刻」的自然延伸，无新 UI 元素。 |
| 5 | small | **单 P 视频上进度恢复失败静默，不把整页错误提示带进去** | `restoreProgress` 对单 P 只 seek 位置（`cinema-player.js:1921-1925`)，但若 `loadProgress` 拿到的是别片的 `progress.bvid` 且 `getProgressKey()` 不等，函数静默 return；应在日志留 `console.debug` 而**不**走 `showStatusBadge`(`cinema-ui.js:82-101` 已是 error-only toast)，避免单 P 页被不属于它的错误徽章污染——与 `cinema-player.js:1138` 「对单视频不额外接管原生结束行为」的既有取向一致。 |

### 建议缓做/不做

| 任务 | 为什么先不做 |
|---|---|
| **A-B 段循环** | SPEC §1 的 1/2（无形优先/原生观感）没过：练舞/语听写受众跟「把分P拼成一部电影」是两条路，做它要么新增设置键要么新增 UI，违反 §1.3 上限 3 且受众脱节；§2 已判「不覆盖 B 站已有能力」的可比判例足以缓做，等用户真要再立。 |
| **章节覆盖率再测** | SPEC §4 挂起且「复活条件」就是要付费课程/PGC 类数据——候选里「再测」不是新决定而是 §4 已经立的复活路径，在拿到真实付费/教程样本前不动；§4.0 的 5 样本全空是用户裁定过的现状，原样保留。 |
| **删 `formatRelativeTime`(`cinema-utils.js:33-41`)** | 已导出、41 个单测里有 5 个在用，popup/hero 副标题将来要接「最近放映 · X 小时前」时直接调它即可；现在删等于把已经修好的工具再拆掉，留着成本是一行导出。挂账缓删，不阻塞。 |

### 顺手发现的半接线功能及处置

- **`formatRelativeTime`(`cinema-utils.js:33-41`，已导出 + 有测试）**:popup/hero 副标题、最近放映副标题都没调用；值得保留但**不现在接线**——popup 若以后加「最近放映 · X 小时前」直接用；当前删它等于把已修好的工具再拆掉。
- **`matchStreamUrls` / `isAudioStreamFilename` / `extractStreamCode`(`cinema-utils.js:88-111`)**：只在 `player-bridge.js` 里消费，`cinema-core/player/ui/popup/background/content` 都没引用——不算死代码，是桥接侧的 codec 工具，照常用，无需动作。
- **`buildSegmentPlan` / `parseSidx` / `parseRangeHeader` / `rangeCovered`(`cinema-utils.js:236-428`)**：同上，`player-bridge` 侧分段预取的纯函数底座，已经在产出侧使用；孤立但非半接线。
- **`bottomTimeCache` / `hoverHandlers` / `captureTick` / `prefetchDoneHandler` / `onDemandPrefetch` 未在 state 初始化区声明（`cinema-core.js:48-107`)**:`cinema-ui.js:137/152/418`、`cinema-player.js:1111`、`content.js:272/394` 动态挂载，都是「有入口有数据」但散在 state 外的暗字段；属于代码整洁账，可记入下批清理，不是用户可见 bug。
- **`ui.bottomTimeCache` 在 cleanup 时未显式清空（`content.js:361-364` 只对 `ui.*` 循环 `.remove`)**:`bottomTimeCache` 里没有 DOM 节点之外的副作用，下一次 `createUI` 会被 `cinema-ui.js:148` 的 `if (!cache.node.isConnected)` 兜底重查（代码上实际是把 `ui.bottomTimeCache = null` 然后在 `:151-167` 逐层 `querySelector`，语义一致），功能正确但属半清理项，值得与上一项一起立单。
- **`state.bookmarksCache`(`cinema-core.js:549`)**:`isBookmarked` 在页面内是同步缓存，popup 走 `chrome.storage.sync.get` 重新读一次（`popup.js/background.js` 双路径）：同源但两套读法，v1.16 已把写收进 `toggleBookmarkEntry` 单一来源，读这一侧未收口——半接线、值得在下批把 `readBookmarks` 的 sync 读取也挂到同一消毒函数上，现在 popup 直接消费 background 的 `cinemasBookmarks` 原始对象没走 `sanitize`。
- **`sessionStorage.cinemaDisplayMode` 只 write/remove 一次（`cinema-player.js:1273/1287/1637/1677` 写，`content.js:321-322` 读+remove)**：失败重试/用户中途关页时残留会导致下一次普通刷新误恢复上一次模式，当前只有在 `onVideoFound` 消费；属于边界清理，可并入「prefs.displayMode」一起改（路线第 1 条）。

---

*审核依据：本会话内实跑 `npm run check`、逐个 grep/Read 上述 file:line 与 git diff（工作区在 main 分支，未提交改动与上次提交 `1e971db` 的差额对比）。*
