/**
 * B站影院模式 - UI 模块
 * 统一进度条（悬停预览/拖拽seek/缓冲显示/样式）、时间标签、分P指示器、
 * 设置按钮与面板、状态徽章、关灯模式
 */

'use strict';

let ui = {
  bar: null,
  fill: null,
  buffered: null,
  markers: null,
  tooltip: null,
  freezeCanvas: null, // 切P冻结帧遮罩 canvas（切换时保持 P1 末帧，消除黑屏）
  settingsPanel: null,
  statusBadge: null,
  closeTip: null,       // 播完自动关闭标签页提示气泡
  switchRecovery: null, // 切P失败恢复卡片
};

// ============================================================
//  收藏书签（核心提供 toggleBookmark / isBookmarked / readBookmarks）
// ============================================================

/** 读取某 bvid 的收藏状态（兼容同步返回值与 Promise），结果交给回调 */
function getBookmarked(bvid, cb) {
  const finish = (v) => { if (typeof cb === 'function') cb(!!v); };
  try {
    if (typeof isBookmarked !== 'function') { finish(false); return; }
    const r = isBookmarked(bvid);
    if (r && typeof r.then === 'function') {
      r.then(finish).catch(() => finish(false));
    } else {
      finish(r);
    }
  } catch { finish(false); }
}

/** 切换当前视频收藏状态并刷新设置面板按钮 */
function toggleCurrentBookmark() {
  if (!state.bvid) return;
  try {
    if (typeof toggleBookmark !== 'function') return;
    // 记的是这一集的电影时间，不是整部剧的片头。没有正在播的片子就不写这两个字段：
    // 旧书签缺字段时打开走片头，不编一个假进度。
    const bookmarkMeta = { bvid: state.bvid, title: state.title || '', pic: state.pic || '' };
    if (state.video && state.pages.length > 0) {
      bookmarkMeta.part = state.currentIndex + 1;
      bookmarkMeta.overallTime = overallFromPart(
        state.cumulative, bookmarkMeta.part, state.video.currentTime || 0
      );
      if (state.mode) bookmarkMeta.mode = state.mode;
    }
    const r = toggleBookmark(bookmarkMeta);
    // 用 toggleBookmark 返回的新状态更新 UI（勿立即重读缓存）
    if (r && typeof r.then === 'function') {
      r.then(() => updateBookmarkButton()).catch(() => {});
    } else {
      updateBookmarkButton();
    }
  } catch { return; }
}

/** 刷新设置面板内的收藏按钮（☆ 收藏此视频 / ★ 已收藏此视频） */
function updateBookmarkButton() {
  const btn = ui.settingsPanel && ui.settingsPanel.querySelector('#cinema-bookmark-toggle');
  if (!btn) return;
  getBookmarked(state.bvid, (nowBookmarked) => {
    btn.textContent = nowBookmarked ? '★ 已收藏此视频' : '☆ 收藏此视频';
    btn.classList.toggle('active', nowBookmarked);
  });
}

// ============================================================
//  状态徽章
// ============================================================

/** 显示状态徽章（固定在页面右下角）：收敛为纯 error toast——仅错误信息（数据获取失败/切P失败等）
 * 闪现约 5 秒后自动淡出；info/success 类调用点已全部删除，非 error 调用一律忽略。 */
let statusBadgeTimer = null;
function showStatusBadge(text, type) {
  if (type !== 'error') return; // 仅保留错误提示
  if (!ui.statusBadge) {
    ui.statusBadge = document.createElement('div');
    ui.statusBadge.id = 'cinema-status-badge';
    document.body.appendChild(ui.statusBadge);
  }
  // 新消息到来时清掉旧定时器（避免旧徽章残留显示状态覆盖新消息）
  if (statusBadgeTimer) {
    clearTimeout(statusBadgeTimer);
    statusBadgeTimer = null;
  }
  ui.statusBadge.textContent = text;
  ui.statusBadge.className = 'cinema-badge-error';
  ui.statusBadge.style.display = '';
  statusBadgeTimer = setTimeout(() => {
    statusBadgeTimer = null;
    ui.statusBadge.style.display = 'none';
  }, 5000);
}

// ============================================================
//  底栏进度条容器查找与时间统合辅助
// ============================================================

function findProgressContainer(wrap) {
  if (!wrap) wrap = state.playerWrap || document.querySelector('.bpx-player-container, #bilibili-player, .bilibili-player, .player-wrap');
  if (!wrap) return null;
  const progressWrap = wrap.querySelector(
    '.bpx-player-progress-wrap, .bpx-player-control-top, .bpx-player-progress, .squirtle-progress-wrap, .squirtle-progress-area, .squirtle-progress, .bilibili-player-video-progress, .bilibili-player-video-progress-slider'
  );
  if (progressWrap) return progressWrap;
  const ctrlWrap = wrap.querySelector('.bpx-player-control-wrap, .squirtle-controller, .bilibili-player-video-control-wrap');
  if (ctrlWrap) return ctrlWrap;
  return wrap;
}

function ensureProgressBarMounted() {
  if (!ui.bar) return;
  const target = findProgressContainer(state.playerWrap);
  if (target && ui.bar.parentElement !== target) {
    target.appendChild(ui.bar);
  }
}

/**
 * 同步更新底栏「总时长」文本为全剧总时长格式。
 * 原生「当前时间」由 B站播放器自行刷新，不再覆写。
 */
function updateBottomTimeDisplay(totalDuration) {
  if (!settings.enabled || !state.isMultiPart) return;
  const durStr = formatTime(totalDuration);
  state.bottomTimeOverridden = true;

  // DOM 缓存：播放器结构固定，命中后免重复查询（播放器重建时 isConnected 失效自动重查）
  const cache = ui.bottomTimeCache;
  if (cache && cache.node && cache.node.isConnected) {
    if (cache.isContainerFallback) {
      // 容器兜底：仅更新最后一个 span（总时长位），避免破坏原生当前时间
      const spans = cache.node.querySelectorAll('span');
      if (spans.length >= 2) spans[spans.length - 1].textContent = durStr;
    } else {
      cache.node.textContent = durStr;
    }
    return;
  }
  ui.bottomTimeCache = null;

  // bpx player 标准结构
  const bpxDur = document.querySelector('.bpx-player-ctrl-time-duration');
  if (bpxDur) { bpxDur.textContent = durStr; ui.bottomTimeCache = { node: bpxDur, isContainerFallback: false }; return; }

  // squirtle player (Bangumi)
  const sqDur = document.querySelector('.squirtle-time-duration');
  if (sqDur) { sqDur.textContent = durStr; ui.bottomTimeCache = { node: sqDur, isContainerFallback: false }; return; }

  // bilibili-player (legacy)
  const bpTotal = document.querySelector('.bilibili-player-video-time-total');
  if (bpTotal) { bpTotal.textContent = durStr; ui.bottomTimeCache = { node: bpTotal, isContainerFallback: false }; return; }

  // 容器文本兜底：仅更新最后一个 span（总时长位），避免破坏原生当前时间
  const ctrlTime = document.querySelector('.bpx-player-ctrl-time, .squirtle-time, .bilibili-player-video-time');
  if (ctrlTime) {
    const spans = ctrlTime.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[spans.length - 1].textContent = durStr;
      ui.bottomTimeCache = { node: ctrlTime, isContainerFallback: true };
    }
  }
}

/**
 * 还原底栏原生时间文本展示（退出影院模式 / 单P视频 / cleanup 时）
 */
function restoreNativeBottomTime() {
  state.bottomTimeOverridden = false;
  const video = state.video || document.querySelector('video');
  const curTime = video ? (video.currentTime || 0) : 0;
  const durTime = video && isFinite(video.duration) && video.duration > 0
    ? video.duration
    : ((state.pages && state.pages[state.currentIndex] && state.pages[state.currentIndex].duration) || 0);
  const curStr = formatTime(curTime);
  const durStr = formatTime(durTime);

  let restored = false;
  const bpxCur = document.querySelector('.bpx-player-ctrl-time-current');
  const bpxDur = document.querySelector('.bpx-player-ctrl-time-duration');
  if (bpxCur) { bpxCur.textContent = curStr; restored = true; }
  if (bpxDur) { bpxDur.textContent = durStr; restored = true; }
  if (restored) return;

  const sqCur = document.querySelector('.squirtle-time-current');
  const sqDur = document.querySelector('.squirtle-time-duration');
  if (sqCur) { sqCur.textContent = curStr; restored = true; }
  if (sqDur) { sqDur.textContent = durStr; restored = true; }
  if (restored) return;

  const bpNow = document.querySelector('.bilibili-player-video-time-now');
  const bpTotal = document.querySelector('.bilibili-player-video-time-total');
  if (bpNow) { bpNow.textContent = curStr; restored = true; }
  if (bpTotal) { bpTotal.textContent = durStr; restored = true; }
  if (restored) return;

  const ctrlTime = document.querySelector('.bpx-player-ctrl-time, .squirtle-time, .bilibili-player-video-time');
  if (ctrlTime) {
    const spans = ctrlTime.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[0].textContent = curStr;
      spans[spans.length - 1].textContent = durStr;
    } else if (spans.length === 0) {
      ctrlTime.textContent = `${curStr} / ${durStr}`;
    }
  }
}

// ============================================================
//  UI 创建
// ============================================================

/**
 * B2：播放器容器上的复用监听（dblclick → toggleSettingsPanel）只绑定一次，
 * 避免 B站 SPA 复用同一容器重新 createUI 时重复叠加句柄（dblclick 会面板开-关连跳）。
 * 绑定标记与 dblclick 句柄挂在 wrap 元素上（wrap.__cinemaUiBound / __cinemaUiDblClick），
 * 供 removeUiWrapListeners 精确移除。
 */
function bindWrapListeners(wrap) {
  if (!wrap || wrap.__cinemaUiBound) return;
  wrap.__cinemaUiBound = true;

  wrap.__cinemaUiDblClick = (e) => {
    // 排除播放器自带控件区域的双击
    if (e.target.closest('.bpx-player-control-wrap') || e.target.closest('.bpx-player-ctrl')) return;
    toggleSettingsPanel();
  };

  wrap.addEventListener('dblclick', wrap.__cinemaUiDblClick);
}

/** B2：移除播放器容器上的复用监听并复位绑定标记（cleanup 调用，幂等） */
function removeUiWrapListeners(wrap) {
  if (!wrap) wrap = state.playerWrap;
  if (!wrap || !wrap.__cinemaUiBound) return;
  wrap.removeEventListener('dblclick', wrap.__cinemaUiDblClick);
  wrap.__cinemaUiDblClick = null;
  wrap.__cinemaUiBound = false;
}

function createUI() {
  const wrap = state.playerWrap;
  if (!wrap) return;

  // 避免重复创建
  if (ui.bar) ui.bar.remove();
  if (ui.tooltip) ui.tooltip.remove();
  if (ui.settingsPanel) ui.settingsPanel.remove();

  // B2：wrap 的 dblclick 在此统一绑定一次
  // （见 bindWrapListeners），避免 SPA 复用容器时监听叠加
  bindWrapListeners(wrap);

  // --- 统一进度条（深度集成并覆盖底部控制栏进度条） ---
  ui.bar = document.createElement('div');
  ui.bar.id = 'cinema-progress-bar';

  // 键盘可达性：slider 语义 + 方向键 seek（aria-valuenow/valuemax 由 updateUnifiedProgress 随播放进度刷新）
  ui.bar.setAttribute('role', 'slider');
  ui.bar.setAttribute('tabindex', '0');
  ui.bar.setAttribute('aria-label', '影片进度');
  ui.bar.setAttribute('aria-valuemin', '0');
  ui.bar.setAttribute('aria-valuemax', String(Math.round(state.totalDuration || 0)));
  ui.bar.setAttribute('aria-valuenow', '0');

  // 缓冲进度（位于已播放进度下方）
  ui.buffered = document.createElement('div');
  ui.buffered.id = 'cinema-progress-buffered';
  ui.bar.appendChild(ui.buffered);

  ui.fill = document.createElement('div');
  ui.fill.id = 'cinema-progress-fill';
  ui.bar.appendChild(ui.fill);

  // 分P分隔标记
  ui.markers = document.createElement('div');
  ui.markers.id = 'cinema-progress-markers';
  ui.bar.appendChild(ui.markers);

  // --- 进度条悬停提示（时间 + 分P标题，纯文字；置于 ui.bar 内部以契合底栏向上浮现） ---
  ui.tooltip = document.createElement('div');
  ui.tooltip.id = 'cinema-progress-tooltip';
  ui.tooltip.innerHTML = '<div class="cinema-tooltip-text"></div>';
  ui.bar.appendChild(ui.tooltip);

  const container = findProgressContainer(wrap);
  if (container) {
    container.appendChild(ui.bar);
  } else {
    wrap.appendChild(ui.bar);
  }

  // 进度条交互：点击/拖拽跳转、悬停提示
  ui.bar.addEventListener('click', onProgressBarClick);
  ui.bar.addEventListener('mousemove', onProgressBarHoverMove);
  ui.bar.addEventListener('mouseleave', onProgressBarLeave);
  ui.bar.addEventListener('pointerdown', onProgressBarPointerDown);
  ui.bar.addEventListener('pointermove', onProgressBarPointerMove);
  ui.bar.addEventListener('pointerup', onProgressBarPointerUp);
  ui.bar.addEventListener('pointercancel', onProgressBarPointerCancel);
  ui.bar.addEventListener('keydown', onProgressBarKeyDown);

  // --- 设置面板 ---
  createSettingsPanel(wrap);

  // 双击播放器区域呼出设置面板（替代入口）：
  // B2 已迁移至 bindWrapListeners，同一容器只注册一次，可被 cleanup 移除

  // 构建分P标记
  buildMarkers();

  // 悬停预取接线
  setupPrefetchUI();
}

function buildMarkers() {
  if (!ui.markers || state.totalDuration <= 0 || !Array.isArray(state.pages) || !Array.isArray(state.cumulative)) return;
  ui.markers.innerHTML = '';
  const totalP = state.pages.length;
  const isDense = totalP > 30;
  for (let i = 1; i < totalP; i++) {
    const cum = state.cumulative[i];
    if (typeof cum !== 'number' || !isFinite(cum)) continue;
    const pct = (cum / state.totalDuration) * 100;
    if (!isFinite(pct)) continue;
    const marker = document.createElement('div');
    marker.className = 'cinema-marker' + (isDense ? ' cinema-marker-dense' : '');
    marker.style.left = Math.max(0, Math.min(100, pct)) + '%';
    marker.dataset.index = String(i);             // 边界下标（cumulative 前缀和下标）
    marker.dataset.pct = pct.toFixed(3);          // 水平百分比，供最近标记距离计算
    const p = state.pages[i];
    marker.title = `P${p ? p.page || i + 1 : i + 1}: ${(p && p.part) || ''}`;
    ui.markers.appendChild(marker);
  }
}

// ============================================================
//  悬停预取
// ============================================================

/**
 * 悬停预取UI接线（幂等，state.prefetchUiHooked 守卫只注册一次）：
 * 悬停分P条目 400ms 后按需预取（prefetchPartOnDemand 由 cinema-player.js 提供）
 */
function setupPrefetchUI() {
  if (state.prefetchUiHooked) return;
  state.prefetchUiHooked = true;
  setupHoverPrefetch();
}

/** 移除 hover 预取监听（cleanup 时调用：SPA 导航/禁用时防监听器累积） */
function teardownHoverPrefetch() {
  if (!ui.hoverHandlers) return;
  document.removeEventListener('mouseover', ui.hoverHandlers.over);
  document.removeEventListener('mouseout', ui.hoverHandlers.out);
  ui.hoverHandlers = null;
  state.prefetchUiHooked = false;
}

/** 悬停分P条目时启动预取，400ms 防抖；离开条目时清除定时器 */
function setupHoverPrefetch() {
  const HOVER_SELECTOR = '.multi-page .list-box li, .list-box li, [class*="page-item"], .video-episode-card, .ep-list .ep-item, .video-pod__item, .bpx-player-ep-item';
  let hoverEl = null;
  let hoverTimer = null;

  const onHoverOver = (e) => {
    try {
      if (state.switching) return;
      const t = e.target && e.target.closest ? e.target.closest(HOVER_SELECTOR) : null;
      if (!t) return;
      // 命中元素变化则重置定时器
      if (t === hoverEl) return;
      hoverEl = t;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        try {
          if (state.switching) return;
          // B3：新版选集条目 data-key 即 cid，按 cid 精确匹配 state.pages 索引
          // （避免 nth-child 全局计数误命中页面推荐区等其他视频的条目）
          let targetIdx = -1;
          const cidAttr = t.getAttribute && t.getAttribute('data-key');
          if (cidAttr) {
            targetIdx = state.pages.findIndex((p) => String(p.cid) === String(cidAttr));
          }
          if (targetIdx === -1) {
            const pageNum = resolvePrefetchPageNum(t);
            if (typeof pageNum === 'number') targetIdx = pageNum - 1;
          }
          if (targetIdx >= 0 && typeof prefetchPartOnDemand === 'function') {
            prefetchPartOnDemand(targetIdx);
          }
        } catch { /* 静默 */ }
      }, 400);
    } catch { /* 静默 */ }
  };

  const onHoverOut = (e) => {
    try {
      const t = e.target && e.target.closest ? e.target.closest(HOVER_SELECTOR) : null;
      if (!t) return;
      const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest(HOVER_SELECTOR) : null;
      if (related === t) return; // 仍在同一分P条目内
      if (hoverEl === t) hoverEl = null;
      clearTimeout(hoverTimer);
      hoverTimer = null;
    } catch { /* 静默 */ }
  };

  ui.hoverHandlers = { over: onHoverOver, out: onHoverOut };
  document.addEventListener('mouseover', onHoverOver);
  document.addEventListener('mouseout', onHoverOut);
}

/** 解析悬停分P条目的页码（优先 data-page / data-index 属性，否则取父列表序号+1） */
function resolvePrefetchPageNum(el) {
  const attr = el.getAttribute && (el.getAttribute('data-page') || el.getAttribute('data-index'));
  if (attr) {
    const n = parseInt(attr, 10);
    if (!isNaN(n) && n >= 1) return n;
  }
  const parent = el.parentElement;
  if (parent) {
    const idx = Array.prototype.indexOf.call(parent.children, el);
    if (idx !== -1) return idx + 1;
  }
  return null;
}

// ============================================================
//  统一进度条：更新 / 悬停预览 / 拖拽 / 跳转
// ============================================================

/** 更新统一进度条。
 * @param {number} [bufEndCached] 已缓冲区间末端（秒）；调用方本轮算过则透传，
 *        避免 onTimeUpdate 每个 tick 对 video.buffered 扫描两次。省略时自行计算。 */
function updateUnifiedProgress(bufEndCached) {
  const video = state.video;
  if (!video || !ui.fill) return;

  const isCinemaActive = settings.enabled && state.isMultiPart;
  if (!isCinemaActive) {
    if (ui.bar) ui.bar.style.display = 'none';
    if (state.bottomTimeOverridden) {
      restoreNativeBottomTime();
    }
    return;
  }

  ensureProgressBarMounted();
  if (ui.bar && ui.bar.style.display === 'none') {
    ui.bar.style.display = '';
  }

  const currentTime = video.currentTime || 0;
  const overallTime = (state.cumulative[state.currentIndex] || 0) + currentTime;
  const pct = state.totalDuration > 0 ? (overallTime / state.totalDuration) * 100 : 0;

  // 同步 slider 无障碍值（取整秒）：整秒不变则跳过——本函数在 timeupdate 下约 4Hz 调用，
  // 缓存挂在元素自身，进度条重建后新元素无缓存会自动重写一次
  if (ui.bar) {
    const ariaNow = String(Math.round(overallTime));
    if (ui.bar._ariaNow !== ariaNow) {
      ui.bar._ariaNow = ariaNow;
      ui.bar.setAttribute('aria-valuenow', ariaNow);
    }
    const ariaMax = String(Math.round(state.totalDuration || 0));
    if (ui.bar._ariaMax !== ariaMax) {
      ui.bar._ariaMax = ariaMax;
      ui.bar.setAttribute('aria-valuemax', ariaMax);
    }
  }

  // 拖拽预览期间不覆盖 fill 宽度（由拖拽逻辑控制）
  if (!state.seekDragging) {
    ui.fill.style.width = Math.min(100, pct) + '%';
  }

  // 缓冲进度：取包含当前时间的缓冲区间末端，映射到电影总时间线
  if (ui.buffered) {
    const bufEnd = typeof bufEndCached === 'number' ? bufEndCached : currentBufferedEnd();
    const overallBuf = (state.cumulative[state.currentIndex] || 0) + bufEnd;
    ui.buffered.style.width = state.totalDuration > 0
      ? Math.min(100, (overallBuf / state.totalDuration) * 100) + '%'
      : '0%';
  }

  // 同步更新底栏「总时长」文本为全剧总时长
  updateBottomTimeDisplay(state.totalDuration);
}

/** 进度条几何快照：事件处理器应在最开头读一次并向下透传——
 *  此刻布局干净，getBoundingClientRect 不触发强制同步重排；
 *  若在一次事件内多次读取并与 class/style 写操作交错，每次读都会重算布局。
 *  未透传时各函数回退自读，兼容点击/键盘等单事件路径。 */
function barRect() {
  return ui.bar ? ui.bar.getBoundingClientRect() : null;
}

/** 进度条事件坐标 → 电影总时间 */
function progressEventToTime(e, rect) {
  if (!ui.bar || state.totalDuration <= 0) return 0;
  const r = rect || barRect();
  if (!r || r.width <= 0) return 0;
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  return isFinite(pct) ? pct * state.totalDuration : 0;
}

const MARKER_NEAR_PX = 12; // 悬停指针距最近分P标记 ≤12px 时浮现标记与分P信息（存在感时刻）

/** 拖拽 pointerup 后抑制紧随 click 的窗口长度（毫秒）；判定逻辑见 cinema-utils.js */
const CLICK_SUPPRESS_MS = 500;

let dragStartIndex = null; // 拖拽起始分P下标（跨P判定用）

/** 最近分P标记：返回 { index, distancePx, el } 或 null（无标记/进度条不可测时） */
function nearestMarkerInfo(clientX, rect) {
  if (!ui.bar || !ui.markers || ui.markers.children.length === 0) return null;
  const r = rect || barRect();
  if (!r || r.width <= 0) return null;
  let best = null;
  for (const m of ui.markers.children) {
    const pct = parseFloat(m.dataset.pct || '');
    if (!isFinite(pct)) continue;
    const mx = r.left + (pct / 100) * r.width;
    const dist = Math.abs(clientX - mx);
    if (!best || dist < best.distancePx) {
      best = { index: parseInt(m.dataset.index || '0', 10), distancePx: dist, el: m };
    }
  }
  return best;
}

/** 刷新标记浮现状态：近边界 → markers-revealed + 最近标记高亮；远离 → 全部收回
 * nearInfo/rect 可复用调用方已算好的结果（避免一次事件内重复遍历与重复测量） */
function updateMarkerReveal(clientX, nearInfo, rect) {
  if (!ui.bar || !ui.markers) return;
  for (const m of ui.markers.children) m.classList.remove('nearest');
  const near = nearInfo || nearestMarkerInfo(clientX, rect);
  if (near && near.distancePx <= MARKER_NEAR_PX) {
    ui.bar.classList.add('markers-revealed');
    if (near.el) near.el.classList.add('nearest');
  } else {
    ui.bar.classList.remove('markers-revealed');
  }
}

/** 清理标记浮现/跨P状态（leave / pointerup / pointercancel 共用） */
function clearMarkerReveal() {
  if (ui.bar) ui.bar.classList.remove('markers-revealed', 'crossing');
  if (ui.markers) {
    for (const m of ui.markers.children) m.classList.remove('nearest', 'cinema-crossing');
  }
}

/** 悬停提示：按状态机输出时间基准与分P信息
 *  - 远离边界 hover / 单P内拖拽：P 内相对时间、无 pill（原生观感）
 *  - 近边界 hover / 跨P拖拽：电影总时间 + pill（跨P时为 accent 蓝「→ Pn · 标题」）
 * nearInfo/rect 由调用方透传（一次事件共享一次测量，见 barRect） */
function showProgressTooltip(e, nearInfo, rect) {
  if (!ui.bar || !ui.tooltip || state.totalDuration <= 0) return;
  const r = rect || barRect();
  if (!r || r.width <= 0) return;
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (!isFinite(pct)) return;
  const t = pct * state.totalDuration;
  const info = overallToPartOffset(state.cumulative, Math.min(t, state.totalDuration - 0.01));

  // 存在感判定：拖拽态只认「跨P」（单P内拖拽无论是否靠近边界都保持 P 内相对时间 = 原生观感）；
  // 悬停态认「近边界 ≤12px」。两者都命中 → 电影总时间 + pill
  const crossing = state.seekDragging && dragStartIndex !== null && info && info.index !== dragStartIndex;
  const near = nearInfo || nearestMarkerInfo(e.clientX, r);
  const nearBoundary = !!(near && near.distancePx <= MARKER_NEAR_PX);
  const movieContext = crossing || (!state.seekDragging && nearBoundary);

  // tooltip 内容先在内存里拼好，只有真的变了才写 DOM 并回量宽度：
  // 内容未变时完全不读布局（比每次 mousemove 都量更省），变了才付一次重排。
  // 不能用「上一帧宽度」做钳制——pill 出现正是宽度剧变（约 3 倍）的时刻，
  // 而此时又必然是近边界/跨P的悬停，用旧宽度会让 tooltip 溢出进度条端点。
  const textEl = ui.tooltip.querySelector('.cinema-tooltip-text');
  let html = '';
  if (textEl && info && state.pages[info.index]) {
    // 分P标签口径收敛到 cinema-utils.js 的 partDisplayLabel（约束 19/59 单一真源）：
    // 输出与旧内联实现字节一致，故 _lastHtml 内容签名缓存与 v1.15 reflow 优化不受影响。
    const baseLabel = partDisplayLabel(state.mode, info.index, state.pages[info.index]);
    const pill = movieContext
      ? (crossing
          ? `<span class="cinema-tooltip-part-pill cinema-tooltip-pill-cross">→ ${escapeHtml(baseLabel)}</span>`
          : `<span class="cinema-tooltip-part-pill">${escapeHtml(baseLabel)}</span>`)
      : '';
    const timeFormatted = formatTime(movieContext ? t : (info.offset || 0));
    html = `
      <span class="cinema-tooltip-timecode">${timeFormatted}</span>
      ${pill}
    `;
  }

  let half = ui.tooltip._half;
  if (html && html !== ui.tooltip._lastHtml) {
    ui.tooltip._lastHtml = html;
    if (textEl) textEl.innerHTML = html;
    half = ui.tooltip._half = ui.tooltip.offsetWidth / 2; // 本轮唯一一次读，仅在内容变化时发生
  } else if (half == null) {
    half = ui.tooltip._half = ui.tooltip.offsetWidth / 2; // 首次显示（或 tooltip 重建后）
  }

  updateMarkerReveal(e.clientX, near, r);

  if (half == null) return;
  // 水平位置钳制在进度条范围内
  const x = Math.max(half + 4, Math.min(pct * r.width, r.width - half - 4));
  ui.tooltip.style.left = x + 'px';
  ui.tooltip.classList.add('visible');
}

function onProgressBarHoverMove(e) {
  if (state.seekDragging) return; // 拖拽中由 pointermove 负责
  // 一次事件只测一次：rect 与最近标记由 tooltip 和标记浮现共用
  const rect = barRect();
  showProgressTooltip(e, nearestMarkerInfo(e.clientX, rect), rect);
}

function onProgressBarLeave() {
  if (state.seekDragging) return;
  if (ui.tooltip) ui.tooltip.classList.remove('visible');
  clearMarkerReveal();
}

/** 拖拽 seek：按下开始（记录起始分P），移动时预览，松开时提交跳转 */
function onProgressBarPointerDown(e) {
  if (e.button !== 0 || state.totalDuration <= 0) return;
  state.seekDragging = true;
  const t0 = progressEventToTime(e);
  const info0 = overallToPartOffset(state.cumulative, Math.min(t0, state.totalDuration - 0.01));
  dragStartIndex = info0 ? info0.index : state.currentIndex;
  ui.bar.classList.add('dragging');
  try { ui.bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
}

/** 拖拽跨P：把 (min(起始P, 当前P), max] 区间内的边界标记标记为 cinema-crossing 高亮 */
function updateCrossingMarkers(e, rect) {
  if (!ui.bar || !ui.markers) return;
  const t = progressEventToTime(e, rect);
  const info = overallToPartOffset(state.cumulative, Math.min(t, state.totalDuration - 0.01));
  const curIndex = info ? info.index : state.currentIndex;
  for (const m of ui.markers.children) m.classList.remove('cinema-crossing');
  if (!state.seekDragging || dragStartIndex === null || curIndex === dragStartIndex) {
    if (ui.bar) ui.bar.classList.remove('crossing');
    return;
  }
  ui.bar.classList.add('crossing');
  const lo = Math.min(dragStartIndex, curIndex);
  const hi = Math.max(dragStartIndex, curIndex);
  for (const m of ui.markers.children) {
    const idx = parseInt(m.dataset.index || '0', 10);
    if (idx > lo && idx <= hi) m.classList.add('cinema-crossing');
  }
}

function onProgressBarPointerMove(e) {
  if (!state.seekDragging) return;
  // 一次 pointermove 只测一次 rect：标记距离、tooltip、跨P判定、fill 预览全部复用
  const rect = barRect();
  const t = progressEventToTime(e, rect);
  showProgressTooltip(e, nearestMarkerInfo(e.clientX, rect), rect);
  // 跨P拖拽：高亮被越过的边界标记
  updateCrossingMarkers(e, rect);
  // 预览：fill 实时跟随目标位置（松开后才真正 seek）
  const pct = state.totalDuration > 0 ? (t / state.totalDuration) * 100 : 0;
  if (ui.fill) ui.fill.style.width = Math.min(100, pct) + '%';
}

function onProgressBarPointerUp(e) {
  if (!state.seekDragging) return;
  state.seekDragging = false;
  dragStartIndex = null;
  ui.bar.classList.remove('dragging');
  clearMarkerReveal();
  try { ui.bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (ui.tooltip) ui.tooltip.classList.remove('visible');
  ui.bar._suppressClick = Date.now(); // 抑制随后的 click 事件（避免重复 seek）；时间戳 + CLICK_SUPPRESS_MS 窗口，click 未触发时自动过期防误吞
  seekToClientX(e.clientX);
  updateUnifiedProgress();
}

function onProgressBarPointerCancel(e) {
  if (!state.seekDragging) return;
  state.seekDragging = false;
  dragStartIndex = null;
  ui.bar.classList.remove('dragging');
  clearMarkerReveal();
  try { ui.bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (ui.tooltip) ui.tooltip.classList.remove('visible');
  updateUnifiedProgress(); // 恢复 fill 为真实进度
}

/** 按进度条坐标跳转（点击与拖拽共用） */
function seekToClientX(clientX) {
  if (!ui.bar || state.totalDuration <= 0) return;

  const rect = ui.bar.getBoundingClientRect();
  if (rect.width <= 0) return;
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  if (!isFinite(pct)) return;
  seekToOverallTime(pct * state.totalDuration);
}

/** 按电影总时间 seek（进度条点击/拖拽与键盘方向键共用）。
 * 换算复用 overallToPartOffset + jumpToPart/直接 currentTime 的现成链路，不另写一套定位逻辑 */
function seekToOverallTime(overallTime) {
  if (typeof overallTime !== 'number' || !isFinite(overallTime) || state.totalDuration <= 0) return;
  const targetTime = Math.max(0, Math.min(overallTime, state.totalDuration));
  // 结尾处收 0.01s 余量，保证 overallToPartOffset 能定位到最后分P内
  const info = overallToPartOffset(state.cumulative, Math.min(targetTime, state.totalDuration - 0.01));
  if (!info) return;

  if (info.index === state.currentIndex) {
    // 同一P内，直接 seek
    if (state.video) state.video.currentTime = info.offset;
  } else {
    // 需要切换P
    jumpToPart(info.index, info.offset);
  }
}

/** 键盘 seek（进度条聚焦时）：←/→/↑/↓ ±10 秒，PgUp/PgDn ±60 秒，Home 跳开头，End 跳结尾；
 * 自定义快捷键 seek（默认 J/K，与全局快捷键一致）在进度条聚焦时同样生效 */
function onProgressBarKeyDown(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (state.totalDuration <= 0) return;
  const cur = (state.cumulative[state.currentIndex] || 0) + (state.video ? state.video.currentTime : 0);
  let target = null;
  switch (e.key) {
    case 'ArrowLeft':  target = cur - 10; break;
    case 'ArrowRight': target = cur + 10; break;
    case 'ArrowDown':  target = cur - 10; break;
    case 'ArrowUp':    target = cur + 10; break;
    case 'PageUp':     target = cur - 60; break; // PgUp 向开头，PgDn 向结尾（与页面翻页方向一致）
    case 'PageDown':   target = cur + 60; break;
    case 'Home':       target = 0; break;
    case 'End':        target = state.totalDuration; break;
  }
  // 自定义 seek 键（seekBack/seekForward），走与全局快捷键相同的 ±10 秒逻辑
  const s = SHORTCUT_DEFAULTS;
  if (target === null && s.seekBack && s.seekBack === e.code) target = cur - 10;
  if (target === null && s.seekForward && s.seekForward === e.code) target = cur + 10;
  if (target === null) return;
  e.preventDefault();
  seekToOverallTime(target);
  // 立即刷新进度显示与 aria（暂停时设置 currentTime 不触发 timeupdate）
  updateUnifiedProgress();
}

function onProgressBarClick(e) {
  // 拖拽/按下后的 click 已在 pointerup 处理，跳过（窗口内有效，超窗自动失效）
  if (ui.bar && isClickSuppressed(ui.bar._suppressClick, Date.now(), CLICK_SUPPRESS_MS)) {
    ui.bar._suppressClick = 0;
    return;
  }
  seekToClientX(e.clientX);
}

// ============================================================
//  冻结帧遮罩（切P时保持 P1 末帧，消除黑屏）
// ============================================================

/** 把当前视频帧冻结到 canvas 上盖住播放器（P1 末帧保持），P2 首帧就绪后淡出 */
function freezeFrame() {
  const video = state.video;
  if (!video || !state.playerWrap) return;
  // 获取或创建 canvas
  let canvas = ui.freezeCanvas;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'cinema-freeze-frame';
    canvas.className = 'cinema-freeze-frame';
    state.playerWrap.appendChild(canvas);
    ui.freezeCanvas = canvas;
  }
  // 尺寸对齐视频
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch (e) {
    // drawImage 失败（极少见）—— 静默放弃冻结帧
    return;
  }
  canvas.classList.remove('cinema-freeze-out');
  canvas.classList.add('visible');
}

/** 淡出并隐藏冻结帧 canvas（P2 首帧就绪后调用） */
function unfreezeFrame() {
  const canvas = ui.freezeCanvas;
  if (!canvas) return;
  canvas.classList.add('cinema-freeze-out');
  setTimeout(() => {
    if (!canvas) return;
    canvas.classList.remove('visible');
    canvas.classList.remove('cinema-freeze-out');
    if (canvas.getContext) {
      try {
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      } catch (e) { /* ignore */ }
    }
  }, 240);
}

// ============================================================
//  切P失败恢复卡片（切换超时未确认时展示，供用户选择恢复方式）
// ============================================================

/** 展示切P失败恢复卡片：重试 / 上一集 / 刷新本P / 关闭 */
function showSwitchRecovery(targetIndex) {
  hideSwitchRecovery();

  const card = document.createElement('div');
  card.id = 'cinema-switch-recovery';
  card.innerHTML = `
    <div class="cinema-switch-recovery-title">切换失败</div>
    <div class="cinema-switch-recovery-sub">第${targetIndex + 1}集未能切换，请重试或返回</div>
    <div class="cinema-switch-recovery-btns">
      <button type="button" class="cinema-switch-recovery-btn cinema-switch-recovery-btn-primary" data-act="retry">重试</button>
      <button type="button" class="cinema-switch-recovery-btn cinema-switch-recovery-btn-ghost" data-act="prev">上一集</button>
      <button type="button" class="cinema-switch-recovery-btn cinema-switch-recovery-btn-ghost" data-act="reload">刷新本P</button>
      <button type="button" class="cinema-switch-recovery-btn cinema-switch-recovery-btn-ghost" data-act="close">关闭</button>
    </div>
  `;
  document.body.appendChild(card);
  ui.switchRecovery = card;

  card.querySelector('[data-act="retry"]').addEventListener('click', () => {
    hideSwitchRecovery();
    jumpToPart(targetIndex, 0);
  });
  card.querySelector('[data-act="prev"]').addEventListener('click', () => {
    hideSwitchRecovery();
    // 上一集：跳到失败目标的前一集（而非用可能已被重置的 currentIndex）
    jumpToPart(Math.max(0, (typeof targetIndex === 'number' ? targetIndex : state.currentIndex) - 1), 0);
  });
  card.querySelector('[data-act="reload"]').addEventListener('click', () => {
    hideSwitchRecovery();
    location.reload();
  });
  card.querySelector('[data-act="close"]').addEventListener('click', () => {
    hideSwitchRecovery();
  });
}

/** 隐藏切P失败恢复卡片（不存在时静默返回）；同时清除晚到成功看护轮询 */
function hideSwitchRecovery() {
  if (ui.switchRecovery) {
    ui.switchRecovery.remove();
    ui.switchRecovery = null;
  }
  if (state.switchRecoveryPoll) {
    clearInterval(state.switchRecoveryPoll);
    state.switchRecoveryPoll = null;
  }
}

// ============================================================
//  设置面板
// ============================================================

function createSettingsPanel(wrap) {
  ui.settingsPanel = document.createElement('div');
  ui.settingsPanel.id = 'cinema-settings-panel';
  ui.settingsPanel.innerHTML = `
    <div class="cinema-sp-title"><span class="cinema-sp-title-text">影院模式</span><span class="cinema-sp-close" title="关闭">&times;</span></div>

    <div class="cinema-sp-body">
      <label class="cinema-sp-toggle">
        <input type="checkbox" data-key="enabled" ${settings.enabled ? 'checked' : ''}>
        <span class="cinema-sp-toggle-track"></span>
        <span class="cinema-sp-toggle-label">启用影院模式</span>
      </label>
      <label class="cinema-sp-toggle">
        <input type="checkbox" data-key="autoCloseTab" ${settings.autoCloseTab ? 'checked' : ''}>
        <span class="cinema-sp-toggle-track"></span>
        <span class="cinema-sp-toggle-label">播完自动关闭标签页</span>
      </label>
      <div class="cinema-sp-sub">播完后自动关闭当前标签页</div>
      <button type="button" class="cinema-bookmark-btn" id="cinema-bookmark-toggle">☆ 收藏此视频</button>
      <div class="cinema-sp-sub cinema-sp-hint">S 键 / 双击播放器可打开此面板</div>
    </div>
  `;

  // 绑定事件（仅剩 enabled / autoCloseTab 两个 checkbox）
  ui.settingsPanel.addEventListener('change', (e) => {
    const input = e.target;
    const key = input.dataset.key;
    if (!key) return;
    if (input.type === 'checkbox') {
      settings[key] = input.checked;
    }
    // 立即保存并应用
    saveSettings();
    applySettings();
    syncBridgeConfig();
  });

  // 面板挂在 body 上（fixed 定位）
  document.body.appendChild(ui.settingsPanel);

  // 关闭按钮 / 拖动标题栏 / Esc 关闭
  ui.settingsPanel.querySelector('.cinema-sp-close').addEventListener('click', () => {
    ui.settingsPanel.classList.remove('visible');
  });
  initSettingsPanelDrag(ui.settingsPanel, ui.settingsPanel.querySelector('.cinema-sp-title'));
  // 重复 addEventListener 同一函数会被浏览器去重，不会累积
  document.addEventListener('keydown', onPanelEscape);

  // 收藏当前视频（书签）：按钮文字随 isBookmarked 状态刷新
  const bookmarkBtn = ui.settingsPanel.querySelector('#cinema-bookmark-toggle');
  if (bookmarkBtn) {
    bookmarkBtn.addEventListener('click', toggleCurrentBookmark);
  }
  updateBookmarkButton();
}

/** Esc 层级关闭（最上层优先）：设置面板 → 切P失败恢复卡 */
function onPanelEscape(e) {
  if (e.key !== 'Escape') return;
  if (ui.settingsPanel && ui.settingsPanel.classList.contains('visible')) {
    ui.settingsPanel.classList.remove('visible');
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (ui.switchRecovery) {
    hideSwitchRecovery();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}

/** 设置面板拖拽：按住标题栏移动面板（关闭按钮除外） */
function initSettingsPanelDrag(panel, handle) {
  if (!panel || !handle) return;
  let isDragging = false;
  let startX = 0, startY = 0;
  let origLeft = 0, origTop = 0;
  let panelW = 0, panelH = 0;      // 面板尺寸（pointerdown 读一次，拖拽期间恒定）
  let lastLeft = 0, lastTop = 0;   // 最近一次写入坐标（pointerup 持久化用，免再读布局）

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.cinema-sp-close')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    // 面板尺寸拖拽期间恒定：在此读一次，pointermove 内不再回读布局
    panelW = rect.width;
    panelH = rect.height;
    lastLeft = origLeft;
    lastTop = origTop;
    handle.classList.add('cinema-sp-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    lastLeft = Math.max(0, Math.min(origLeft + dx, window.innerWidth - panelW));
    lastTop = Math.max(0, Math.min(origTop + dy, window.innerHeight - panelH));
    panel.style.left = lastLeft + 'px';
    panel.style.top = lastTop + 'px';
  });

  const stop = (e, shouldSave) => {
    if (!isDragging) return;
    isDragging = false;
    handle.classList.remove('cinema-sp-dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // 拖拽结束持久化位置（下次打开面板仍在此处）；直接用拖拽期已算出的坐标，免再读布局
    if (shouldSave) {
      savePanelPos(Math.round(lastLeft), Math.round(lastTop));
    }
  };
  handle.addEventListener('pointerup', (e) => stop(e, true));
  handle.addEventListener('pointercancel', (e) => stop(e, false));
}

// ============================================================
//  设置面板位置持久化
// ============================================================

let panelPos = null; // 面板自定义位置缓存（null=未加载）

/** 读取面板自定义位置（首次从 localStorage 加载） */
function getPanelPos() {
  if (panelPos !== null) return panelPos;
  try {
    panelPos = JSON.parse(localStorage.getItem('cinemaSettingsPanelPos') || 'null');
  } catch {
    panelPos = null;
  }
  return panelPos;
}

/** 保存面板自定义位置 */
function savePanelPos(left, top) {
  panelPos = { left, top };
  try {
    localStorage.setItem('cinemaSettingsPanelPos', JSON.stringify(panelPos));
  } catch { /* ignore */ }
}

/** 设置面板宿主管理：原生全屏时只有 fullscreenElement 子树被渲染（面板挂 body 会不可见），
 * 打开时若处于原生全屏且面板不在其子树，先 lazy reparent 过去再显示；
 * 关闭 / 退出全屏时挂回 document.body（position:fixed，避免滞留于播放器子树内受 transform/overflow 影响） */
function ensureSettingsPanelHost(attachToFullscreen) {
  const panel = ui.settingsPanel;
  if (!panel) return;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (attachToFullscreen && fsEl && panel.parentElement !== fsEl) {
    fsEl.appendChild(panel);
  } else if (!attachToFullscreen && panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }
}

/** 将面板内所有 data-key 控件与当前 settings 对齐：
 * popup 总开关/跨标签同步等外部路径修改设置后，面板不再显示陈旧状态 */
function syncSettingsPanelControls() {
  if (!ui.settingsPanel) return;
  ui.settingsPanel.querySelectorAll('[data-key]').forEach((el) => {
    if (document.activeElement === el) return; // 用户正在操作该控件时不打扰
    const key = el.dataset.key;
    if (!(key in settings)) return;
    if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
    else el.value = settings[key];
  });
}

function toggleSettingsPanel() {
  if (!ui.settingsPanel) return;
  const willShow = !ui.settingsPanel.classList.contains('visible');
  if (willShow) {
    // 外部路径（popup 总开关/跨标签同步）可能已改动设置：打开前先对齐控件状态
    syncSettingsPanelControls();
    // 原生全屏：先把面板挂到 fullscreenElement 子树（否则不可见），再定位显示
    ensureSettingsPanelHost(true);
    positionSettingsPanel();
  } else {
    // 关闭路径：归还 body，避免面板滞留于全屏/播放器子树内
    ensureSettingsPanelHost(false);
  }
  ui.settingsPanel.classList.toggle('visible');
}

/** 将设置面板定位到默认位置（视口右上 right:24px; top:24px）。
 * 若用户曾拖动过面板（位置已持久化），则优先使用保存的位置 */
function positionSettingsPanel() {
  const panel = ui.settingsPanel;
  if (!panel) return;
  let panelW = panel.offsetWidth;
  let panelH = panel.offsetHeight;
  // 面板隐藏时尺寸为 0，临时显示（不可见）以获取真实尺寸
  if (!panelW || !panelH) {
    const prevDisplay = panel.style.display;
    const prevVisibility = panel.style.visibility;
    panel.style.display = 'block';
    panel.style.visibility = 'hidden';
    panelW = panel.offsetWidth || 220;
    panelH = panel.offsetHeight || 200;
    panel.style.display = prevDisplay;
    panel.style.visibility = prevVisibility;
  }

  // 已保存的自定义位置优先（钳制在视口内）
  const pos = getPanelPos();
  if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
    panel.style.left = Math.max(0, Math.min(pos.left, window.innerWidth - panelW)) + 'px';
    panel.style.top = Math.max(0, Math.min(pos.top, window.innerHeight - panelH)) + 'px';
    return;
  }

  // 默认视口右上（right:24px; top:24px）
  panel.style.left = Math.max(8, Math.round(window.innerWidth - panelW - 24)) + 'px';
  panel.style.top = Math.max(8, Math.round(24)) + 'px';
}

function applySettings() {
  const isCinemaActive = settings.enabled && state.isMultiPart;

  // 合集模式下额外添加 class（隐藏右侧合集面板）
  document.body.classList.toggle('cinema-season-mode', state.mode === 'season');
  // 底部进度条接管标记
  document.body.classList.toggle('cinema-bottom-progress', isCinemaActive);
  document.body.classList.toggle('cinema-active', settings.enabled);
  document.body.classList.toggle('cinema-multi-part', state.isMultiPart);
  if (state.playerWrap) {
    state.playerWrap.classList.toggle('cinema-active', settings.enabled);
  }

  // 隐藏/显示自定义进度条与还原原生底栏
  if (ui.bar) {
    ui.bar.style.display = isCinemaActive ? '' : 'none';
  }
  if (!isCinemaActive) {
    restoreNativeBottomTime();
  } else {
    updateUnifiedProgress();
  }

  // 关闭自动关闭标签页时，收起可能已显示的提示气泡
  if (!settings.autoCloseTab) {
    closeCloseTabTip();
  }

  // 设置可能来自外部路径（popup/跨标签）：面板控件与最新设置对齐
  syncSettingsPanelControls();

  // B1(v1.18)：系统媒体卡片随「影院是否激活 + 是否多P」注册/撤下（幂等）
  updateMediaSession();
}

// ============================================================
//  全局快捷键（A5：键盘可访问性 + 全局快捷键）
//  快捷键编辑器与录制已删除，键位硬编码为 SHORTCUT_DEFAULTS（cinema-core.js）
// ============================================================

/** 全局快捷键 keydown 处理（document 级，capture false） */
function onCinemaShortcutKey(e) {
  if (!settings.enabled) return;

  // 输入控件 / contenteditable / B站评论区输入时不响应
  const t = e.target;
  if (t) {
    const tag = (t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    if (t.closest && (
      t.closest('#commentapp') || t.closest('#comment-app') ||
      t.closest('.bili-comment') || t.closest('.reply-box')
    )) return;
  }

  const code = e.code || '';
  const s = SHORTCUT_DEFAULTS;
  let action = null;
  for (const name of Object.keys(s)) {
    if (s[name] === code) { action = name; break; }
  }
  if (!action) return;

  // 修饰键约束：ctrl/meta 一律拦截（方向键组合在 B站侧也有默认行为）；纯字母快捷键额外要求无 alt
  const isArrow = code === 'ArrowLeft' || code === 'ArrowRight';
  if (e.ctrlKey || e.metaKey) return;
  if (!isArrow && e.altKey) return;

  // 进度条聚焦时方向键由 onProgressBarKeyDown 处理（±10s），避免双重 seek
  if (ui.bar && (e.target === ui.bar || ui.bar.contains(e.target))) return;

  e.preventDefault();

  switch (action) {
    case 'nextPart':
      cinemaNextPart();
      break;
    case 'prevPart':
      cinemaPrevPart();
      break;
    case 'toggleSettings':
      toggleSettingsPanel();
      break;
    case 'seekBack':
      seekShortcut(-10);
      break;
    case 'seekForward':
      seekShortcut(10);
      break;
  }
}

/** 全局快捷键 ±10 秒 seek（复用 seekToOverallTime，跨P连续） */
function seekShortcut(deltaSeconds) {
  if (!state.video || state.totalDuration <= 0) return;
  const cur = (state.cumulative[state.currentIndex] || 0) + (state.video.currentTime || 0);
  seekToOverallTime(Math.max(0, Math.min(cur + deltaSeconds, state.totalDuration)));
  updateUnifiedProgress();
}

function setupCinemaShortcuts() {
  if (state.shortcutHandler) return; // 幂等，防重复注册
  state.shortcutHandler = onCinemaShortcutKey;
  document.addEventListener('keydown', onCinemaShortcutKey, false);
}

function teardownCinemaShortcuts() {
  if (state.shortcutHandler) {
    document.removeEventListener('keydown', state.shortcutHandler, false);
    state.shortcutHandler = null;
  }
}

// ============================================================
//  切P入口（键盘 N/P 与系统媒体卡片「上/下一首」共用同一函数）
//  不另写路径 —— 复用 advanceTarget 守卫的 goToNextPart 与手动 jumpToPart，
//  使 MediaSession 成为「第三个切P入口」时不引入新的竞态类别。
// ============================================================

/** 下一P：与键盘 N 完全同一路径（goToNextPart 受 advanceTarget 守卫，末P早退） */
function cinemaNextPart() {
  if (state.isMultiPart && state.currentIndex < state.pages.length - 1 && typeof goToNextPart === 'function') {
    goToNextPart();
  }
}

/** 上一P：与键盘 P 完全同一路径（手动 jumpToPart，offset=0） */
function cinemaPrevPart() {
  if (state.isMultiPart && state.currentIndex > 0 && typeof jumpToPart === 'function') {
    jumpToPart(state.currentIndex - 1, 0);
  }
}

// ============================================================
//  系统媒体卡片（MediaSession）—— B1(v1.18)
//
//  纯装饰、纯本地：navigator.mediaSession 是 Web API，隔离世界可直接访问，
//  无需像 player-bridge 那样注入 MAIN world。只修多P电影在系统卡片里的标题
//  （B站按整片/单P标题显示、跨P不刷新），并把「上/下一首」接到上面与键盘共
//  用的切P函数。
//  §1.2 不覆盖 B站已有能力：B站已注册 play/pause/seekbackward/seekforward/
//  seekto，本模块一律不碰；只补 B站未注册的 previoustrack/nexttrack（Chrome
//  卡片里本就是置灰的上/下一首）。覆盖 metadata 时保留 B站已设的封面与艺术家。
//  §1.1 零页面像素、§1.3 零设置键：不加 DOM、不加设置项、不加定时器、不写盘、
//  不改 video.src。单P或总开关关闭时移除我们的处理器、不动 B站元数据。
// ============================================================

/** 当前分P展示标签，与进度条 tooltip 共用 cinema-utils.js 的 partDisplayLabel（约束 19/59 单一口径）。
 * 此处仅做「取哪个下标」的薄适配：显式传入 index 则用之，否则用 state.currentIndex。 */
function mediaSessionPartLabel(index) {
  const i = (typeof index === 'number') ? index : state.currentIndex;
  return partDisplayLabel(state.mode, i, state.pages[i]);
}

/** 保留 B站已注册封面（读不到再回退本片 pic），避免覆盖标题时夺走原生封面（§1.2） */
function mediaSessionArtwork() {
  try {
    const existing = navigator.mediaSession && navigator.mediaSession.metadata;
    if (existing && existing.artwork && existing.artwork.length) {
      const out = [];
      for (const a of existing.artwork) {
        if (a && a.src) out.push({ src: a.src, sizes: a.sizes || '', type: a.type || '' });
      }
      if (out.length) return out;
    }
  } catch (e) { /* 静默 */ }
  return state.pic ? [{ src: state.pic }] : [];
}

/** 刷新系统媒体卡片（幂等）：多P电影才写标题/接上下一首；否则撤下我们的处理器、不动 B站元数据 */
function updateMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  if (!(settings.enabled && state.isMultiPart)) {
    // 单P / 总开关关闭：撤掉我们加的切P入口，交还 B站（不覆盖其播放控制与元数据）
    try {
      ms.setActionHandler('previoustrack', null);
      ms.setActionHandler('nexttrack', null);
    } catch (e) { /* 静默 */ }
    return;
  }
  try {
    if (typeof MediaMetadata === 'function') {
      const artist = (ms.metadata && ms.metadata.artist) || '';
      ms.metadata = new MediaMetadata({
        title: mediaSessionPartLabel(),
        artist: artist,
        album: state.title || '',
        artwork: mediaSessionArtwork(),
      });
    }
  } catch (e) { /* 静默 */ }
  // 上/下一首 = 键盘 P/N 的同一函数（advanceTarget 守卫，不另写路径）；
  // 到边界时置 null 让 Chrome 卡片对应按钮置灰（与守卫的“无处可去”一致）
  try {
    ms.setActionHandler('previoustrack', state.currentIndex > 0 ? () => cinemaPrevPart() : null);
    ms.setActionHandler('nexttrack', state.currentIndex < state.pages.length - 1 ? () => cinemaNextPart() : null);
  } catch (e) { /* 静默 */ }
}

/** 离开本页：移除我们注册的切P处理器，防残留句柄（B站元数据不动）；与 teardownCinemaShortcuts 同处调用 */
function teardownMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('previoustrack', null);
    navigator.mediaSession.setActionHandler('nexttrack', null);
  } catch (e) { /* 静默 */ }
}
