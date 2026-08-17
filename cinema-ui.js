/**
 * B站影院模式 - UI 模块
 * 统一进度条（悬停预览/拖拽seek/缓冲显示/样式）、时间标签、分P指示器、
 * 过渡动画、设置按钮与面板、状态徽章、观影记录面板、关灯模式
 */

'use strict';

let ui = {
  bar: null,
  fill: null,
  buffered: null,
  markers: null,
  tooltip: null,
  timeLabel: null,
  partLabel: null,
  transition: null,
  freezeCanvas: null, // 切P冻结帧遮罩 canvas（切换时保持 P1 末帧，消除黑屏）
  settingsBtn: null,
  settingsPanel: null,
  statusBadge: null,
  historyOverlay: null,
  closeTip: null,       // 播完自动关闭标签页提示气泡
  lightsOut: null,      // 关灯模式遮罩
  prefetchStatus: null, // "下一集已预取"就绪指示器
  switchRecovery: null, // 切P失败恢复卡片
  onboarding: null,     // 首次使用引导弹窗（A6）
  excludedStub: null,   // 排除模式小chip（右下角"点击恢复"入口）
};

// ============================================================
//  观影记录面板（点击状态徽章打开）
// ============================================================

function openHistoryPanel() {
  closeHistoryPanel();

  const overlay = document.createElement('div');
  overlay.id = 'cinema-history-overlay';
  overlay.innerHTML = `
    <div class="cinema-history-panel">
      <div class="cinema-history-header">
        <span>观影记录</span>
        <span class="cinema-history-actions">
          <span class="cinema-history-action" id="cinema-history-export" title="导出为 JSON 文件">导出</span>
          <span class="cinema-history-action cinema-history-action-danger" id="cinema-history-clear" title="清空全部观影记录">清空</span>
          <span class="cinema-history-close" title="关闭">&times;</span>
        </span>
      </div>
      <div class="cinema-stat-row"></div>
      <div class="cinema-history-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  ui.historyOverlay = overlay;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHistoryPanel();
  });
  overlay.querySelector('.cinema-history-close').addEventListener('click', closeHistoryPanel);
  overlay.querySelector('#cinema-history-export').addEventListener('click', exportHistory);
  overlay.querySelector('#cinema-history-clear').addEventListener('click', clearAllHistory);

  renderHistoryList();
}

function closeHistoryPanel() {
  if (ui.historyOverlay) {
    ui.historyOverlay.remove();
    ui.historyOverlay = null;
  }
}

function renderHistoryList() {
  const listEl = ui.historyOverlay.querySelector('.cinema-history-list');
  const statEl = ui.historyOverlay.querySelector('.cinema-stat-row');
  readAllHistory((hist) => {
    const items = Object.values(hist).sort((a, b) => b.ts - a.ts);

    // 观影统计行（本周/本月集数与观看时长）
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    let weekCount = 0, weekSec = 0, monthCount = 0, monthSec = 0;
    for (const it of items) {
      if (it.ts >= weekAgo) { weekCount++; weekSec += it.watched || 0; }
      if (it.ts >= monthStart.getTime()) { monthCount++; monthSec += it.watched || 0; }
    }
    if (items.length === 0) {
      statEl.style.display = 'none';
      listEl.innerHTML = '<div class="cinema-history-empty">暂无观影记录，播放过的视频会自动出现在这里</div>';
      return;
    }
    statEl.style.display = '';
    statEl.innerHTML = `本周观影 ${weekCount} 集 · 共 ${Math.round(weekSec / 60)} 分钟 ｜ 本月 ${monthCount} 集 · 共 ${Math.round(monthSec / 60)} 分钟`;

    // 读取收藏集合，为每条记录标注星标
    getBookmarkSet((bookmarks) => {
      const bmSet = new Set(bookmarks.map((b) => b && b.bvid).filter(Boolean));
      listEl.innerHTML = '';
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'cinema-history-item';

        const picHtml = item.pic
          ? `<img class="cinema-history-pic" src="${item.pic}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
          : '<div class="cinema-history-pic cinema-history-pic-empty">B</div>';

        // 总进度百分比（跨分P累计）
        let pct = 0;
        if (item.totalParts > 0 && item.totalDuration > 0) {
          const perPart = item.totalDuration / item.totalParts;
          const overall = (item.part - 1) * perPart + Math.min(item.time, perPart);
          pct = Math.min(100, Math.round((overall / item.totalDuration) * 100));
        }
        // 续播文案：多P显示「续播 第x/y集」，单P只显示「续播」
        const resumeText = item.totalParts > 1 ? `续播 第${item.part}/${item.totalParts}集` : '续播';
        const starred = bmSet.has(item.bvid);

        row.innerHTML = `
          ${picHtml}
          <div class="cinema-history-info">
            <div class="cinema-history-name">${escapeHtml(item.title)}</div>
            <div class="cinema-history-meta"><span class="cinema-history-resume">${resumeText}</span> · 已看 ${formatTime(item.time)} · 进度 ${pct}% · ${formatRelativeTime(item.ts)}</div>
            <div class="cinema-history-progress"><div class="cinema-history-progress-fill" style="width:${pct}%"></div></div>
          </div>
          <span class="cinema-history-star${starred ? ' active' : ''}" role="button" tabindex="0" title="收藏/取消收藏" aria-label="收藏/取消收藏">${starred ? '★' : '☆'}</span>
          <span class="cinema-history-del" title="删除记录">&times;</span>
        `;

        const starEl = row.querySelector('.cinema-history-star');
        starEl.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleHistoryRowBookmark(item, starEl);
        });
        starEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            toggleHistoryRowBookmark(item, starEl);
          }
        });

        row.addEventListener('click', (e) => {
          if (e.target.closest('.cinema-history-del')) return;
          if (e.target.closest('.cinema-history-star')) return;
          let url = `https://www.bilibili.com/video/${item.bvid}`;
          // I-3：合集条目按 bvid 直接进入（不带 ?p=，合集播放器会把 ?p= 误解析为分P导致定位错乱）
          if (item.mode !== 'season' && item.part > 1) url += `?p=${item.part}`;
          location.href = url;
        });

        row.querySelector('.cinema-history-del').addEventListener('click', (e) => {
          e.stopPropagation();
          deleteHistoryItem(item);
        });

        listEl.appendChild(row);
      }
    });
  });
}

function deleteHistoryItem(item) {
  try {
    readAllHistory((hist) => {
      for (const key of Object.keys(hist)) {
        if (hist[key].bvid === item.bvid && hist[key].ts === item.ts) {
          delete hist[key];
          break;
        }
      }
      writeAllHistory(hist, () => { // 用户操作不走防抖，立即写
        renderHistoryList();
      });
    });
  } catch (err) { console.debug('[cinema] deleteHistoryItem error:', err); }
}

/** 导出观影记录为 JSON 文件 */
function exportHistory() {
  try {
    readAllHistory((hist) => {
      try {
        const payload = { exportedAt: new Date().toISOString(), history: hist };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bilibili-cinema-history.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        log('已导出观影记录');
      } catch (e) { console.debug('[cinema] exportHistory error:', e); }
    });
  } catch (err) { console.debug('[cinema] exportHistory error:', err); }
}

/** 清空全部观影记录（二次确认） */
function clearAllHistory() {
  if (!window.confirm('确定清空全部观影记录？此操作不可恢复。')) return;
  try {
    // writeAllHistory({})：清空 sync 分块并清理多余的旧块
    writeAllHistory({}, () => {
      // 顺带清理可能遗留的 local 旧 blob
      try { chrome.storage.local.remove('cinemaHistory'); } catch (e) { console.debug('[cinema] clearAllHistory local remove error:', e); }
      renderHistoryList();
    });
  } catch (err) { console.debug('[cinema] clearAllHistory error:', err); }
}

/** 导出完整备份（设置/进度/观影记录）为 cinema-backup.json */
async function onExportBackup() {
  try {
    const data = await exportCinemaBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cinema-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showStatusBadge('备份已导出', 'success');
  } catch (err) {
    console.debug('[cinema] onExportBackup error:', err);
    showStatusBadge('导出失败', 'error');
  }
}

/** 选择备份文件后解析并导入（importCinemaBackup 负责校验文件有效性并合并数据） */
function onImportBackupFile(e) {
  const file = e.target && e.target.files && e.target.files[0];
  if (e.target) e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const obj = JSON.parse(reader.result);
      const res = await importCinemaBackup(obj);
      showStatusBadge(
        res && res.ok ? '已导入备份' : '导入失败：' + ((res && res.message) || '文件无效'),
        res && res.ok ? 'success' : 'error'
      );
    } catch {
      showStatusBadge('导入失败：文件无效', 'error');
    }
  };
  reader.readAsText(file);
}

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

/** 读取全部收藏 bvid 集合（兼容 readBookmarks(cb) 回调与同步数组返回） */
function getBookmarkSet(cb) {
  let done = false;
  const finish = (list) => { if (!done) { done = true; cb(list || []); } };
  try {
    if (typeof readBookmarks !== 'function') { finish([]); return; }
    const r = readBookmarks(finish);
    if (Array.isArray(r)) finish(r);
  } catch { finish([]); }
}

/** 切换当前视频收藏状态并刷新设置面板按钮 + 状态徽章 */
function toggleCurrentBookmark() {
  if (!state.bvid) return;
  const apply = (nowBookmarked) => {
    updateBookmarkButton();
    showStatusBadge(nowBookmarked ? '已收藏' : '已取消收藏', nowBookmarked ? 'success' : 'info');
  };
  try {
    if (typeof toggleBookmark !== 'function') return;
    const r = toggleBookmark({ bvid: state.bvid, title: state.title || '', pic: state.pic || '' });
    // 用 toggleBookmark 返回的新状态更新 UI（勿立即重读缓存）
    if (r && typeof r.then === 'function') {
      r.then((v) => apply(!!v)).catch(() => {});
    } else {
      apply(!!r);
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

/** 观影记录条目星标切换（不触发跳转），随后刷新星标与徽章 */
function toggleHistoryRowBookmark(item, starEl) {
  const apply = (nowBookmarked) => {
    if (starEl) {
      starEl.textContent = nowBookmarked ? '★' : '☆';
      starEl.classList.toggle('active', nowBookmarked);
    }
    updateBookmarkButton();
    showStatusBadge(nowBookmarked ? '已收藏' : '已取消收藏', nowBookmarked ? 'success' : 'info');
  };
  try {
    if (typeof toggleBookmark !== 'function') return;
    const r = toggleBookmark({ bvid: item.bvid, title: item.title || '', pic: item.pic || '' });
    // 用 toggleBookmark 返回的新状态更新星标（勿立即重读缓存）
    if (r && typeof r.then === 'function') {
      r.then((v) => apply(!!v)).catch(() => {});
    } else {
      apply(!!r);
    }
  } catch { return; }
}

// ============================================================
//  状态徽章
// ============================================================

/** 显示状态徽章（固定在页面上，可拖拽移动位置）
 * v1.7.2：info/success 不再自动隐藏（常驻），用户可通过设置项 showStatusBadge 控制显隐 */
function showStatusBadge(text, type) {
  if (!ui.statusBadge) {
    ui.statusBadge = document.createElement('div');
    ui.statusBadge.id = 'cinema-status-badge';
    ui.statusBadge.title = '点击查看观影记录（可拖动）';
    document.body.appendChild(ui.statusBadge);
    initBadgeDrag(ui.statusBadge);
    ui.statusBadge.addEventListener('click', () => {
      if (ui.statusBadge._justDragged) return;
      openHistoryPanel();
    });
  }
  ui.statusBadge.textContent = text;
  ui.statusBadge.className = 'cinema-badge-' + (type || 'info');
  // 显隐由 showStatusBadge 设置项控制（applySettings 管控），不再自动隐藏
  if (settings.showStatusBadge) {
    ui.statusBadge.style.display = '';
  }
}

/** 为状态徽章初始化拖拽功能 */
function initBadgeDrag(badge) {
  const STORAGE_KEY = 'cinemaBadgePos';
  let isDragging = false;
  let startX = 0, startY = 0;
  let origLeft = 0, origTop = 0;
  let hasMoved = false;

  // 恢复上次保存的位置
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const pos = JSON.parse(saved);
      badge.style.bottom = 'auto';
      badge.style.right = 'auto';
      badge.style.left = pos.left + 'px';
      badge.style.top = pos.top + 'px';
    }
  } catch { /* ignore */ }

  badge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // 仅左键
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = badge.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;

    badge.classList.add('cinema-badge-dragging');
    badge.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  badge.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
    }

    let newLeft = origLeft + dx;
    let newTop = origTop + dy;

    // 限制在视口内
    const bw = badge.offsetWidth;
    const bh = badge.offsetHeight;
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - bw));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - bh));

    badge.style.bottom = 'auto';
    badge.style.right = 'auto';
    badge.style.left = newLeft + 'px';
    badge.style.top = newTop + 'px';
  });

  badge.addEventListener('pointerup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    badge.classList.remove('cinema-badge-dragging');
    badge.releasePointerCapture(e.pointerId);
    badge._justDragged = hasMoved;

    // 保存位置
    if (hasMoved) {
      try {
        const rect = badge.getBoundingClientRect();
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          left: Math.round(rect.left),
          top: Math.round(rect.top),
        }));
      } catch { /* ignore */ }
    }
  });

  badge.addEventListener('pointercancel', () => {
    isDragging = false;
    badge.classList.remove('cinema-badge-dragging');
  });
}

/** 为设置按钮初始化拖拽功能（按钮为 fixed 定位，可在整个网页内自由拖动） */
function initSettingsBtnDrag(btn, anchorEl) {
  const STORAGE_KEY = 'cinemaSettingsBtnPos';
  let isDragging = false;
  let startX = 0, startY = 0;
  let origLeft = 0, origTop = 0;

  // 恢复上次保存的位置（fixed 视口坐标）；无保存位置则默认放在锚点元素（播放器容器）右下角附近
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const pos = JSON.parse(saved);
      btn.style.left = Math.max(0, Math.min(pos.left, window.innerWidth - btn.offsetWidth)) + 'px';
      btn.style.top = Math.max(0, Math.min(pos.top, window.innerHeight - btn.offsetHeight)) + 'px';
    } else if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      btn.style.left = Math.max(0, Math.round(rect.right - 12 - btn.offsetWidth)) + 'px';
      btn.style.top = Math.max(0, Math.round(rect.bottom - 52 - btn.offsetHeight)) + 'px';
    }
  } catch { /* ignore */ }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    btn._dragged = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = btn.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;

    btn.classList.add('cinema-dragging');
    btn.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  btn.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      btn._dragged = true;
    }

    // 限制在整个视口内
    const bw = btn.offsetWidth;
    const bh = btn.offsetHeight;
    let newLeft = Math.max(0, Math.min(origLeft + dx, window.innerWidth - bw));
    let newTop = Math.max(0, Math.min(origTop + dy, window.innerHeight - bh));

    btn.style.left = newLeft + 'px';
    btn.style.top = newTop + 'px';
  });

  btn.addEventListener('pointerup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    btn.classList.remove('cinema-dragging');
    btn.releasePointerCapture(e.pointerId);

    // 保存位置（fixed 视口坐标）
    if (btn._dragged) {
      try {
        const rect = btn.getBoundingClientRect();
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          left: Math.round(rect.left),
          top: Math.round(rect.top),
        }));
      } catch { /* ignore */ }
      // 延迟重置，避免触发 click
      setTimeout(() => { btn._dragged = false; }, 50);
    }
  });

  btn.addEventListener('pointercancel', () => {
    isDragging = false;
    btn.classList.remove('cinema-dragging');
  });
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
 * 同步更新底栏时间文本显示为全剧时间（已播总时间 / 全剧总时长）
 */
function updateBottomTimeDisplay(overallTime, totalDuration) {
  if (!settings.enabled || !state.isMultiPart) return;
  const curStr = formatTime(overallTime);
  const durStr = formatTime(totalDuration);
  state.bottomTimeOverridden = true;

  let updated = false;
  // bpx player 标准结构
  const bpxCur = document.querySelector('.bpx-player-ctrl-time-current');
  const bpxDur = document.querySelector('.bpx-player-ctrl-time-duration');
  if (bpxCur) { bpxCur.textContent = curStr; updated = true; }
  if (bpxDur) { bpxDur.textContent = durStr; updated = true; }
  if (updated) return;

  // squirtle player (Bangumi)
  const sqCur = document.querySelector('.squirtle-time-current');
  const sqDur = document.querySelector('.squirtle-time-duration');
  if (sqCur) { sqCur.textContent = curStr; updated = true; }
  if (sqDur) { sqDur.textContent = durStr; updated = true; }
  if (updated) return;

  // bilibili-player (legacy)
  const bpNow = document.querySelector('.bilibili-player-video-time-now');
  const bpTotal = document.querySelector('.bilibili-player-video-time-total');
  if (bpNow) { bpNow.textContent = curStr; updated = true; }
  if (bpTotal) { bpTotal.textContent = durStr; updated = true; }
  if (updated) return;

  // 容器文本兜底：优先尝试更新容器内部 span，避免破坏原生 DOM 结构
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

function createUI() {
  const wrap = state.playerWrap;
  if (!wrap) return;

  // 避免重复创建
  if (ui.bar) ui.bar.remove();
  if (ui.tooltip) ui.tooltip.remove();
  if (ui.timeLabel) { ui.timeLabel.remove(); ui.timeLabel = null; }
  if (ui.partLabel) { ui.partLabel.remove(); ui.partLabel = null; }
  if (ui.transition) ui.transition.remove();
  if (ui.settingsBtn) ui.settingsBtn.remove();
  if (ui.settingsPanel) ui.settingsPanel.remove();
  if (ui.ambilight) ui.ambilight.remove();
  if (ui.vignette) ui.vignette.remove();

  // --- 影院荧幕氛围光（Ambilight） ---
  ui.ambilight = document.createElement('div');
  ui.ambilight.id = 'cinema-ambilight';
  ui.ambilightCanvas = document.createElement('canvas');
  ui.ambilightCanvas.id = 'cinema-ambilight-canvas';
  ui.ambilightCanvas.width = 32;
  ui.ambilightCanvas.height = 18;
  ui.ambilight.appendChild(ui.ambilightCanvas);
  const videoArea = wrap.querySelector('.bpx-player-video-wrap, .bpx-player-video-area') || wrap;
  if (videoArea.firstChild) {
    videoArea.insertBefore(ui.ambilight, videoArea.firstChild);
  } else {
    videoArea.appendChild(ui.ambilight);
  }

  // --- 电影级胶片暗角与聚光景深（Cinematic Vignette） ---
  ui.vignette = document.createElement('div');
  ui.vignette.id = 'cinema-vignette';
  wrap.appendChild(ui.vignette);

  // --- 闲置与去干扰（Watermark & Clutter Dimming） ---
  wrap.addEventListener('mousemove', markUserActive);
  wrap.addEventListener('pointermove', markUserActive);
  wrap.addEventListener('keydown', markUserActive);

  // --- 统一进度条（深度集成并覆盖底部控制栏进度条） ---
  ui.bar = document.createElement('div');
  ui.bar.id = 'cinema-progress-bar';
  ui.bar.classList.add('progress-style-' + (settings.progressStyle || 'classic'));

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

  // --- 进度条悬停预览（监视器分镜造型，置于 ui.bar 内部以契合底栏向上浮现） ---
  ui.tooltip = document.createElement('div');
  ui.tooltip.id = 'cinema-progress-tooltip';
  ui.tooltip.innerHTML = '<div class="cinema-tooltip-viewfinder"><div class="cinema-tooltip-thumb"></div><div class="cinema-vf-corner tl"></div><div class="cinema-vf-corner tr"></div><div class="cinema-vf-corner bl"></div><div class="cinema-vf-corner br"></div></div><div class="cinema-tooltip-text"></div>';
  ui.bar.appendChild(ui.tooltip);

  const container = findProgressContainer(wrap);
  if (container) {
    container.appendChild(ui.bar);
  } else {
    wrap.appendChild(ui.bar);
  }

  // 进度条交互：点击/拖拽跳转、悬停预览、右键标记跳过片段
  ui.bar.addEventListener('click', onProgressBarClick);
  ui.bar.addEventListener('mousemove', onProgressBarHoverMove);
  ui.bar.addEventListener('mouseleave', onProgressBarLeave);
  ui.bar.addEventListener('pointerdown', onProgressBarPointerDown);
  ui.bar.addEventListener('pointermove', onProgressBarPointerMove);
  ui.bar.addEventListener('pointerup', onProgressBarPointerUp);
  ui.bar.addEventListener('pointercancel', onProgressBarPointerCancel);
  ui.bar.addEventListener('contextmenu', onProgressBarContextMenu);
  ui.bar.addEventListener('keydown', onProgressBarKeyDown);

  // --- 过渡动画 ---
  ui.transition = document.createElement('div');
  ui.transition.id = 'cinema-transition';
  ui.transition.innerHTML = '<div class="cinema-transition-text"></div><div class="cinema-finished-actions"></div>';
  wrap.appendChild(ui.transition);

  // --- 设置按钮 ---
  ui.settingsBtn = document.createElement('div');
  ui.settingsBtn.id = 'cinema-settings-btn';
  // 内联 SVG 齿轮（stroke 线条式，stroke-width 2，随 color 着色）
  ui.settingsBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3"></circle>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
    '</svg>';
  ui.settingsBtn.title = '影院模式设置（可拖动）';
  ui.settingsBtn.setAttribute('role', 'button');
  ui.settingsBtn.setAttribute('aria-label', '影院模式设置');
  ui.settingsBtn.setAttribute('tabindex', '0');
  ui.settingsBtn.addEventListener('click', (e) => {
    if (!ui.settingsBtn._dragged) toggleSettingsPanel();
  });
  ui.settingsBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSettingsPanel(); }
  });
  // 按钮挂在 body 上（fixed 定位），可在整个网页内自由拖动，且不受播放器容器 hover/重建影响
  document.body.appendChild(ui.settingsBtn);
  initSettingsBtnDrag(ui.settingsBtn, wrap);

  // --- 设置面板 ---
  createSettingsPanel(wrap);

  // 双击播放器区域呼出设置面板（替代入口）
  wrap.addEventListener('dblclick', (e) => {
    // 排除播放器自带控件区域的双击
    if (e.target.closest('.bpx-player-control-wrap') || e.target.closest('.bpx-player-ctrl')) return;
    toggleSettingsPanel();
  });

  // 构建分P标记
  buildMarkers();
  // 章节样式（分P分段着色）：createUI/buildMarkers 之后、视频数据就绪（cumulative 可用）时应用
  applyChapterGradient();

  // 预取就绪指示器 & 悬停预取接线
  createPrefetchStatus();
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
    const p = state.pages[i];
    marker.title = `P${p ? p.page || i + 1 : i + 1}: ${(p && p.part) || ''}`;
    ui.markers.appendChild(marker);
  }
}

/** 应用/取消章节样式进度条渐变：chapter 激活时内联设置 fill 背景（inline 天然优先于样式类），切走时清除避免残留 */
function applyChapterGradient() {
  if (!ui.fill) return;
  if ((settings.progressStyle || 'classic') === 'chapter' && typeof buildChapterGradient === 'function') {
    ui.fill.style.background = buildChapterGradient(state.pages, state.cumulative, state.totalDuration) || '';
  } else {
    ui.fill.style.background = '';
  }
}

// ============================================================
//  预取就绪指示器 & 悬停预取
// ============================================================

/** 创建"下一集已预取"就绪指示器（播放器右上角胶囊，默认隐藏） */
function createPrefetchStatus() {
  // 播放器重建时防重复创建
  if (ui.prefetchStatus && ui.prefetchStatus.remove) ui.prefetchStatus.remove();

  const el = document.createElement('div');
  el.id = 'cinema-prefetch-status';
  el.className = 'cinema-prefetch-status';
  el.innerHTML = '<span class="cinema-prefetch-dot"></span><span class="cinema-prefetch-text">下一集已预取</span>';
  const target = ui.playerWrap || state.playerWrap || document.body;
  target.appendChild(el);
  ui.prefetchStatus = el;
}

/** 显示就绪指示（需设置开启且为多分P/多集视频） */
function showPrefetchStatus() {
  if (!settings.showPrefetchStatus || !state.isMultiPart) return;
  if (ui.prefetchStatus) ui.prefetchStatus.classList.add('visible');
}

/** 隐藏就绪指示（元素不存在时静默返回） */
function hidePrefetchStatus() {
  if (ui.prefetchStatus) ui.prefetchStatus.classList.remove('visible');
}

/**
 * 预取UI接线（幂等，state.prefetchUiHooked 守卫只注册一次）：
 *  - window.__cinema_prefetch_done__ → 就绪指示器（content.js 已有另一监听，互不影响）
 *  - 悬停分P条目 400ms 后按需预取（prefetchPartOnDemand 由 cinema-player.js 提供）
 */
function setupPrefetchUI() {
  if (state.prefetchUiHooked) return;
  state.prefetchUiHooked = true;

  // c) 预取完成事件接线：ok === true 时显示就绪指示；ok === false 不动作（失败计数由 cinema-player 管）
  window.addEventListener('__cinema_prefetch_done__', (e) => {
    try {
      const d = typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
      if (d && d.ok === true) showPrefetchStatus();
    } catch { /* 静默 */ }
  });

  // f) 悬停预取（降低手动跳集黑屏）
  setupHoverPrefetch();
}

/** 悬停分P条目时启动预取，400ms 防抖；离开条目时清除定时器 */
function setupHoverPrefetch() {
  const HOVER_SELECTOR = '.multi-page .list-box li, .list-box li, [class*="page-item"], .video-episode-card, .ep-list .ep-item, .video-pod__item, .bpx-player-ep-item';
  let hoverEl = null;
  let hoverTimer = null;

  document.addEventListener('mouseover', (e) => {
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
  });

  document.addEventListener('mouseout', (e) => {
    try {
      const t = e.target && e.target.closest ? e.target.closest(HOVER_SELECTOR) : null;
      if (!t) return;
      const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest(HOVER_SELECTOR) : null;
      if (related === t) return; // 仍在同一分P条目内
      if (hoverEl === t) hoverEl = null;
      clearTimeout(hoverTimer);
      hoverTimer = null;
    } catch { /* 静默 */ }
  });
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

function updateUnifiedProgress() {
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

  // 同步 slider 无障碍值（取整秒；高频调用下仅写字符串属性，开销可接受）
  if (ui.bar) {
    ui.bar.setAttribute('aria-valuenow', String(Math.round(overallTime)));
    ui.bar.setAttribute('aria-valuemax', String(Math.round(state.totalDuration || 0)));
  }

  // 拖拽预览期间不覆盖 fill 宽度（由拖拽逻辑控制）
  if (!state.seekDragging) {
    ui.fill.style.width = Math.min(100, pct) + '%';
  }

  // 缓冲进度：取包含当前时间的缓冲区间末端，映射到电影总时间线
  if (ui.buffered) {
    let bufEnd = 0;
    try {
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= currentTime + 0.5 && buffered.end(i) > bufEnd) {
          bufEnd = buffered.end(i);
        }
      }
    } catch { /* ignore */ }
    const overallBuf = (state.cumulative[state.currentIndex] || 0) + bufEnd;
    ui.buffered.style.width = state.totalDuration > 0
      ? Math.min(100, (overallBuf / state.totalDuration) * 100) + '%'
      : '0%';
  }

  // 同步更新底栏时间文本显示为全剧时间
  updateBottomTimeDisplay(overallTime, state.totalDuration);
}

/** 进度条事件坐标 → 电影总时间 */
function progressEventToTime(e) {
  if (!ui.bar || state.totalDuration <= 0) return 0;
  const rect = ui.bar.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return isFinite(pct) ? pct * state.totalDuration : 0;
}

/** 悬停预览：显示时间点 + 所属分P标题 + 画面缩略图（预览图不可用时自动降级为纯文字） */
function showProgressTooltip(e) {
  if (!ui.bar || !ui.tooltip || state.totalDuration <= 0) return;
  const rect = ui.bar.getBoundingClientRect();
  if (rect.width <= 0) return;
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (!isFinite(pct)) return;
  const t = pct * state.totalDuration;
  ui.bar.style.setProperty('--hover-pct', (pct * 100).toFixed(2) + '%');

  hoverToken++;
  const token = hoverToken;

  const textEl = ui.tooltip.querySelector('.cinema-tooltip-text');
  if (textEl) {
    let label = '';
    const info = overallToPartOffset(state.cumulative, Math.min(t, state.totalDuration - 0.01));
    if (info && state.pages[info.index]) {
      const part = state.pages[info.index];
      const name = (part.part || '').trim();
      label = state.mode === 'season'
        ? `第${info.index + 1}集${name ? ' · ' + name : ''}`
        : `P${part.page}${name ? ' · ' + name : ''}`;
    }
    const timeFormatted = formatTime(t);
    textEl.innerHTML = `
      <span class="cinema-tooltip-timecode">${timeFormatted}</span>
      ${label ? `<span class="cinema-tooltip-part-pill">${escapeHtml(label)}</span>` : ''}
    `;

    // 异步加载该分P的画面缩略图
    if (info && state.pages[info.index] && state.pages[info.index].cid) {
      const partBvid = state.mode === 'season'
        ? (state.pages[info.index].bvid || (state.seasonEpisodes[info.index] && state.seasonEpisodes[info.index].bvid) || state.bvid)
        : state.bvid;
      renderPreviewThumb(info.index, info.offset, state.pages[info.index].cid, partBvid, token);
    } else {
      hidePreviewThumb();
    }
  }

  // 水平位置钳制在进度条范围内
  const half = ui.tooltip.offsetWidth / 2;
  const x = Math.max(half + 4, Math.min(pct * rect.width, rect.width - half - 4));
  ui.tooltip.style.left = x + 'px';
  ui.tooltip.classList.add('visible');
}

// ============================================================
//  进度条悬停缩略图（B站 x/player/videoshot 雪碧图帧）
// ============================================================

let hoverToken = 0;            // 悬停令牌：取消过期的异步结果
let previewBlocked = false;    // -412 风控 → 本会话停用预览
const previewPromiseCache = {}; // cid -> { promise, ts, frames }

/** 懒加载某分P的 videoshot 帧列表（成功永久缓存；失败 60s 后允许重试） */
function getPreviewFrames(bvid, cid) {
  if (previewBlocked || !bvid || !cid) return Promise.resolve(null);
  const now = Date.now();
  const cached = previewPromiseCache[cid];
  // 命中缓存且未过期（成功永久缓存；失败 60s 后允许重试）
  if (cached && (cached.frames !== null || now - cached.ts < 60000)) {
    return cached.promise;
  }
  const promise = fetch(
    `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}` +
    `&cid=${cid}&index=1`,
    { credentials: 'omit' }
  )
    .then((r) => r.json())
    .then((json) => {
      if (json.code === -412) { previewBlocked = true; return null; }
      if (json.code !== 0 || !json.data) return null;
      const d = json.data;
      if (!Array.isArray(d.image) || d.image.length === 0) return null;
      return {
        image: d.image.map(u => u.startsWith('//') ? 'https:' + u : u),
        index: d.index || [],
        xLen: d.img_x_len || 10,
        yLen: d.img_y_len || 10,
        fw: d.img_x_size || 160,
        fh: d.img_y_size || 90,
      };
    })
    .catch(() => null);
  // 缓存结果（成功或失败都缓存，但失败有 60s TTL）
  promise.then((frames) => {
    previewPromiseCache[cid] = { promise: Promise.resolve(frames), ts: Date.now(), frames };
  });
  return promise;
}

function hidePreviewThumb() {
  const thumbEl = ui.tooltip && ui.tooltip.querySelector('.cinema-tooltip-thumb');
  if (thumbEl) thumbEl.style.display = 'none';
}

/** 在 tooltip 内渲染该分P offset 时刻的画面缩略图；任何一步失败都隐藏（降级为纯文字） */
function renderPreviewThumb(index, offset, cid, bvid, token) {
  const thumbEl = ui.tooltip && ui.tooltip.querySelector('.cinema-tooltip-thumb');
  if (!thumbEl) return;
  if (!bvid || !cid) { thumbEl.style.display = 'none'; return; }

  getPreviewFrames(bvid, cid).then((shot) => {
    if (token !== hoverToken) return;
    if (!shot || shot.index.length < 2) { thumbEl.style.display = 'none'; return; }

    // 选时间上最接近且 <= offset 的帧
    let k = 1;
    for (let i = shot.index.length - 1; i >= 1; i--) {
      if (offset >= shot.index[i]) { k = i; break; }
    }
    const f = k - 1;                    // 0-based 帧号
    const perSheet = shot.xLen * shot.yLen;
    if (perSheet <= 0) { thumbEl.style.display = 'none'; return; }
    const sheetIdx = Math.floor(f / perSheet);
    const p = f % perSheet;
    const url = shot.image[sheetIdx];
    if (!url) { thumbEl.style.display = 'none'; return; }

    const x = (p % shot.xLen) * shot.fw;
    const y = Math.floor(p / shot.xLen) * shot.fh;
    // 显示缩放：标准紧凑宽度 136px（16:9 下约 76.5px 高），轻量精致，避免过度遮挡画面
    const targetW = 136;
    const scale = shot.fw > 0 ? targetW / shot.fw : 1;
    thumbEl.style.width = (shot.fw * scale) + 'px';
    thumbEl.style.height = (shot.fh * scale) + 'px';
    thumbEl.style.backgroundImage = `url("${url}")`;
    thumbEl.style.backgroundSize = `${shot.xLen * shot.fw * scale}px ${shot.yLen * shot.fh * scale}px`;
    thumbEl.style.backgroundPosition = `${-x * scale}px ${-y * scale}px`;
    thumbEl.style.display = 'block';

    // 缩略图展开后重新钳制 tooltip 水平位置，防止边缘溢出
    if (ui.bar && ui.tooltip) {
      const rect = ui.bar.getBoundingClientRect();
      if (rect.width > 0) {
        const pct = parseFloat(ui.bar.style.getPropertyValue('--hover-pct') || '0') / 100;
        const half = ui.tooltip.offsetWidth / 2;
        const clampedX = Math.max(half + 4, Math.min(pct * rect.width, rect.width - half - 4));
        ui.tooltip.style.left = clampedX + 'px';
      }
    }
  });
}

function onProgressBarHoverMove(e) {
  if (state.seekDragging) return; // 拖拽中由 pointermove 负责
  showProgressTooltip(e);
}

function onProgressBarLeave() {
  if (state.seekDragging) return;
  if (ui.tooltip) ui.tooltip.classList.remove('visible');
  if (ui.bar) ui.bar.style.removeProperty('--hover-pct');
}

/** 拖拽 seek：按下开始，移动时预览，松开时提交跳转 */
function onProgressBarPointerDown(e) {
  if (e.button !== 0 || state.totalDuration <= 0) return;
  // 点在跳过片段上时不启动拖拽（片段自身有点击移除逻辑）
  if (e.target.closest && e.target.closest('.cinema-skip-seg')) return;
  state.seekDragging = true;
  ui.bar.classList.add('dragging');
  try { ui.bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
}

function onProgressBarPointerMove(e) {
  if (!state.seekDragging) return;
  showProgressTooltip(e);
  // 预览：fill 实时跟随目标位置（松开后才真正 seek）
  const t = progressEventToTime(e);
  const pct = state.totalDuration > 0 ? (t / state.totalDuration) * 100 : 0;
  if (ui.fill) ui.fill.style.width = Math.min(100, pct) + '%';
}

function onProgressBarPointerUp(e) {
  if (!state.seekDragging) return;
  state.seekDragging = false;
  ui.bar.classList.remove('dragging');
  try { ui.bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (ui.tooltip) ui.tooltip.classList.remove('visible');
  if (ui.bar) ui.bar.style.removeProperty('--hover-pct');
  ui.bar._suppressClick = true; // 抑制随后的 click 事件（避免重复 seek）
  seekToClientX(e.clientX);
  updateUnifiedProgress();
}

function onProgressBarPointerCancel(e) {
  if (!state.seekDragging) return;
  state.seekDragging = false;
  ui.bar.classList.remove('dragging');
  try { ui.bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (ui.tooltip) ui.tooltip.classList.remove('visible');
  if (ui.bar) ui.bar.style.removeProperty('--hover-pct');
  updateUnifiedProgress(); // 恢复 fill 为真实进度
}

/** 右键标记跳过片段：第一次右键标记起点，第二次右键标记终点并添加 */
function onProgressBarContextMenu(e) {
  e.preventDefault();
  if (!settings.enabled || !settings.enableSkips || !state.isMultiPart) return;
  if (state.totalDuration <= 0) return;
  const t = progressEventToTime(e);
  if (typeof state.skipMarkStart !== 'number') {
    markSkipStart(t);
  } else {
    markSkipEnd(t);
  }
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
  const s = getShortcuts() || {};
  if (target === null && s.seekBack && s.seekBack === e.code) target = cur - 10;
  if (target === null && s.seekForward && s.seekForward === e.code) target = cur + 10;
  if (target === null) return;
  e.preventDefault();
  seekToOverallTime(target);
  // 立即刷新进度显示与 aria（暂停时设置 currentTime 不触发 timeupdate）
  updateUnifiedProgress();
}

function onProgressBarClick(e) {
  // 拖拽/按下后的 click 已在 pointerup 处理，跳过
  if (ui.bar && ui.bar._suppressClick) {
    ui.bar._suppressClick = false;
    return;
  }
  seekToClientX(e.clientX);
}

// ============================================================
//  过渡动画
// ============================================================

function showTransition(text, isFinal, fallbackMs) {
  if (!ui.transition) return;

  // 幕间模式：分P切换提示（「第N集 · 分P标题」）渲染为「ACT N + 第N幕 + 分P标题 + 扫光」四行电影结构
  const partMatch = /^第(\d+)集\s*·\s*(.+)$/.exec(text);
  if (partMatch) {
    // 重建容器前暂存播放完毕操作条，避免结束过渡（showFinishedActions）时操作条丢失
    const actionsEl = ui.transition.querySelector('.cinema-finished-actions');
    // 集数补零显示（1 -> 01）；分P标题做 HTML 转义，防止特殊字符破坏幕间结构
    const partNo = String(parseInt(partMatch[1], 10)).padStart(2, '0');
    const partTitle = String(partMatch[2]).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    ui.transition.innerHTML =
      '<div class="cinema-transition-text"></div>' +
      `<div class="cinema-transition-act">ACT ${partNo}</div>` +
      `<div class="cinema-transition-title">第 ${partNo} 幕</div>` +
      `<div class="cinema-transition-sub">${partTitle}</div>` +
      '<div class="cinema-transition-loader"></div>';
    if (actionsEl) ui.transition.appendChild(actionsEl);
  } else {
    // 单行模式（播放完毕 / 跳过反馈等）：清掉上次残留的幕间结构，沿用原有文字逻辑
    ui.transition
      .querySelectorAll('.cinema-transition-act, .cinema-transition-title, .cinema-transition-sub, .cinema-transition-loader')
      .forEach((el) => el.remove());
    const textEl = ui.transition.querySelector('.cinema-transition-text');
    if (textEl) textEl.textContent = isFinal ? text : `正在切换：${text}`;
  }

  // 非结束过渡会覆盖为切换提示，收起可能残留的播放完毕操作条
  if (!isFinal) hideFinishedActions();

  ui.transition.classList.add('active');
  clearTimeout(state.transitionTimer);
  if (isFinal) {
    state.transitionTimer = setTimeout(() => {
      ui.transition.classList.remove('active');
    }, 3000);
  } else {
    // 切换过渡不再按固定时间隐藏：由首帧就绪后调用 hideTransition() 收起，
    // 这里仅保留兜底（默认 4s），避免异常情况下遮罩卡住画面；其他提示（如跳过片段反馈）可传更短回退
    state.transitionTimer = setTimeout(() => {
      ui.transition.classList.remove('active');
    }, fallbackMs || 4000);
  }
}

/** 新分P首帧已渲染时提前收起切换过渡层 */
function hideTransition() {
  clearTimeout(state.transitionTimer);
  if (ui.transition) ui.transition.classList.remove('active');
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

/** 播放完毕操作条：片尾卡（标题 + 集数/时长 + 分割线 + 按钮行），置于过渡层内，延长显示时间便于操作 */
function showFinishedActions() {
  if (!ui.transition) return;
  const actionsEl = ui.transition.querySelector('.cinema-finished-actions');
  if (!actionsEl) return;

  actionsEl.innerHTML = '';

  // 片尾卡徽标
  const badgeEl = document.createElement('div');
  badgeEl.className = 'cinema-finished-badge';
  badgeEl.textContent = 'THE END · 放映终章';
  actionsEl.appendChild(badgeEl);

  // 片尾卡标题（衬线字体）与副行（共 N 集 · 总时长 X）
  const titleEl = document.createElement('div');
  titleEl.className = 'cinema-finished-title';
  titleEl.textContent = state.title || '';
  actionsEl.appendChild(titleEl);

  const subEl = document.createElement('div');
  subEl.className = 'cinema-finished-sub';
  subEl.textContent = `共 ${state.pages.length} 集 · 全片放映完毕 · 总时长 ${formatTime(state.totalDuration)}`;
  actionsEl.appendChild(subEl);

  // 标题与按钮之间的细分割线
  const dividerEl = document.createElement('div');
  dividerEl.className = 'cinema-finished-divider';
  actionsEl.appendChild(dividerEl);

  const btnsEl = document.createElement('div');
  btnsEl.className = 'cinema-finished-btns';
  const mk = (label, icon, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cinema-finished-btn';
    b.innerHTML = (icon ? `<span class="cinema-btn-icon">${icon}</span>` : '') + `<span>${label}</span>`;
    b.addEventListener('click', fn);
    btnsEl.appendChild(b);
  };

  mk('重新放映', '↺', () => {
    hideFinishedActions();
    jumpToPart(0, 0);
  });
  if (state.mode === 'season') {
    const firstBvid = (state.seasonEpisodes[0] && state.seasonEpisodes[0].bvid) || state.bvid;
    mk('合集首页', '☷', () => { location.href = `https://www.bilibili.com/video/${firstBvid}`; });
  } else {
    mk('视频首页', '↗', () => { location.href = `https://www.bilibili.com/video/${state.bvid}`; });
  }
  mk('关闭', '✕', () => hideFinishedActions());
  actionsEl.appendChild(btnsEl);

  // 下一作卡片（state.nextWork 由核心 resolveNextWork 提供；缺失时静默跳过）
  if (!state.nextWork && typeof resolveNextWork === 'function') {
    try { resolveNextWork(); } catch { /* ignore */ }
  }
  if (state.nextWork && state.nextWork.bvid) {
    const nextTitle = String(state.nextWork.title || '').trim() || '相关视频';
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'cinema-finished-next';
    nextBtn.title = '打开下一作';
    nextBtn.innerHTML =
      '<span class="cinema-finished-next-label">下一作</span>' +
      `<span class="cinema-finished-next-title">${escapeHtml(nextTitle)}</span>`;
    nextBtn.addEventListener('click', () => {
      hideFinishedActions();
      location.href = `https://www.bilibili.com/video/${state.nextWork.bvid}`;
    });
    actionsEl.appendChild(nextBtn);
  }

  actionsEl.style.display = 'flex';

  // 延长过渡层显示：操作条不因 3 秒自动淡出而消失，30 秒后自动收起
  clearTimeout(state.transitionTimer);
  state.transitionTimer = setTimeout(() => {
    hideFinishedActions();
    if (ui.transition) ui.transition.classList.remove('active');
  }, 30000);
}

function hideFinishedActions() {
  const actionsEl = ui.transition && ui.transition.querySelector('.cinema-finished-actions');
  if (actionsEl) actionsEl.style.display = 'none';
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
    try { sessionStorage.setItem('cinemaDisplayMode', state.displayMode); } catch { /* ignore */ }
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
//  分P指示器（顶部角标已移除，保留函数防外部调用报错）
// ============================================================

function updatePartIndicator() {
  if (ui.partLabel) {
    ui.partLabel.remove();
    ui.partLabel = null;
  }
}

// ============================================================
//  设置面板
// ============================================================

function createSettingsPanel(wrap) {
  ui.settingsPanel = document.createElement('div');
  ui.settingsPanel.id = 'cinema-settings-panel';
  const opacityPct = Math.round((settings.lightsOutOpacity || 0.85) * 100);
  ui.settingsPanel.innerHTML = `
    <div class="cinema-sp-title"><span class="cinema-sp-title-text">影院模式</span><span class="cinema-sp-close" title="关闭">&times;</span></div>

    <div class="cinema-sp-body">

      <div class="cinema-sp-section" data-group="main">
        <span class="cinema-sp-section-head">
          <span class="cinema-sp-section-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/></svg></span>
          <span>常用</span>
        </span>
        <span class="cinema-sp-caret"></span>
      </div>
      <div class="cinema-sp-group" data-group="main">
        <div class="cinema-sp-group-inner">
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="enabled" ${settings.enabled ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">启用影院模式</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="autoPlayNext" ${settings.autoPlayNext ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">自动连播</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="seamlessMovie" ${settings.seamlessMovie !== false ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">无缝电影</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="hidePartUI" ${settings.hidePartUI ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">隐藏分P</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" id="cinema-exclude-video" ${isCurrentVideoExcluded() ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">此视频不用影院</span>
          </label>
          <button type="button" class="cinema-bookmark-btn" id="cinema-bookmark-toggle">☆ 收藏此视频</button>
        </div>
      </div>

      <div class="cinema-sp-section" data-group="playback">
        <span class="cinema-sp-section-head">
          <span class="cinema-sp-section-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></span>
          <span>连播</span>
        </span>
        <span class="cinema-sp-caret"></span>
      </div>
      <div class="cinema-sp-group" data-group="playback">
        <div class="cinema-sp-group-inner">
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="preloadNext" ${settings.preloadNext ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">预加载下一P</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="fastSwitch" ${settings.fastSwitch ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">快速切换</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="showPrefetchStatus" ${settings.showPrefetchStatus ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">预取就绪指示</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="showTransition" ${settings.showTransition ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">切换过渡动画</span>
          </label>
          <div class="cinema-sp-row-inline">
            <label class="cinema-sp-toggle">
              <input type="checkbox" data-key="p2pBlock" ${settings.p2pBlock ? 'checked' : ''}>
              <span class="cinema-sp-toggle-track"></span>
              <span class="cinema-sp-toggle-label">P2P 常驻屏蔽</span>
            </label>
            <span class="cinema-sp-ms">
              <input type="number" data-key="p2pTempMs" value="${settings.p2pTempMs || 4000}" min="1000" max="10000" step="500" aria-label="切P临时屏蔽P2P毫秒">
              <span>ms</span>
            </span>
          </div>
        </div>
      </div>

      <div class="cinema-sp-section" data-group="ui">
        <span class="cinema-sp-section-head">
          <span class="cinema-sp-section-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
          <span>界面</span>
        </span>
        <span class="cinema-sp-caret"></span>
      </div>
      <div class="cinema-sp-group" data-group="ui">
        <div class="cinema-sp-group-inner">
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="showSettingsBtn" ${settings.showSettingsBtn ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">显示设置按钮</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="showStatusBadge" ${settings.showStatusBadge ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">状态徽章</span>
          </label>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="autoCloseTab" ${settings.autoCloseTab ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">播完关标签页</span>
          </label>
          <div class="cinema-sp-pair">
            <label class="cinema-sp-toggle cinema-sp-toggle-sm">
              <input type="checkbox" data-key="progressSync" ${settings.progressSync ? 'checked' : ''}>
              <span class="cinema-sp-toggle-track"></span>
              <span class="cinema-sp-toggle-label">跨标签同步</span>
            </label>
            <label class="cinema-sp-toggle cinema-sp-toggle-sm">
              <input type="checkbox" data-key="deviceSync" ${settings.deviceSync ? 'checked' : ''}>
              <span class="cinema-sp-toggle-track"></span>
              <span class="cinema-sp-toggle-label">跨设备同步</span>
            </label>
          </div>
          <div class="cinema-sp-row cinema-sp-select-row">
            <span>主题</span>
            <select data-key="theme">
              <option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>跟随系统</option>
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>深色</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>浅色</option>
            </select>
          </div>
          <div class="cinema-sp-row cinema-sp-select-row">
            <span>进度条</span>
            <select data-key="progressStyle">
              <option value="classic" ${settings.progressStyle === 'classic' ? 'selected' : ''}>经典</option>
              <option value="flow" ${settings.progressStyle === 'flow' ? 'selected' : ''}>流光</option>
              <option value="minimal" ${settings.progressStyle === 'minimal' ? 'selected' : ''}>极简</option>
              <option value="neon" ${settings.progressStyle === 'neon' ? 'selected' : ''}>霓虹</option>
              <option value="film" ${settings.progressStyle === 'film' ? 'selected' : ''}>胶片</option>
              <option value="chapter" ${settings.progressStyle === 'chapter' ? 'selected' : ''}>章节</option>
              <option value="aurora" ${settings.progressStyle === 'aurora' ? 'selected' : ''}>极光</option>
              <option value="sunset" ${settings.progressStyle === 'sunset' ? 'selected' : ''}>暮色</option>
              <option value="cyberpunk" ${settings.progressStyle === 'cyberpunk' ? 'selected' : ''}>赛博</option>
              <option value="sakura" ${settings.progressStyle === 'sakura' ? 'selected' : ''}>樱粉</option>
            </select>
          </div>
          <label class="cinema-sp-toggle" title="关灯模式：大屏下自动激活荧幕氛围光（Ambilight）、电影胶片暗角与纯净暗场水印淡化">
            <input type="checkbox" data-key="lightsOut" ${settings.lightsOut ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">关灯模式（大屏氛围光+暗角）</span>
          </label>
          <div class="cinema-sp-sub">
            <span>压暗</span>
            <input type="range" data-key="lightsOutOpacity" min="50" max="95" step="5" value="${opacityPct}">
            <span class="cinema-range-val">${opacityPct}%</span>
          </div>
        </div>
      </div>

      <div class="cinema-sp-section" data-group="edit">
        <span class="cinema-sp-section-head">
          <span class="cinema-sp-section-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg></span>
          <span>剪辑</span>
        </span>
        <span class="cinema-sp-caret"></span>
      </div>
      <div class="cinema-sp-group" data-group="edit">
        <div class="cinema-sp-group-inner">
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="skipIntro" ${settings.skipIntro ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">跳过片头</span>
          </label>
          <div class="cinema-sp-sub">
            <span>全局</span>
            <input type="number" data-key="introDuration" value="${settings.introDuration}" min="0" max="120" step="1">
            <span>秒</span>
          </div>
          <div class="cinema-sp-sub">
            <span>当前</span>
            <input type="number" id="cinema-io-intro" min="0" max="120" step="1" placeholder="${settings.introDuration}">
            <span class="cinema-io-reset" id="cinema-io-intro-reset" title="恢复为全局时长">重置</span>
          </div>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="skipOutro" ${settings.skipOutro ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">跳过片尾</span>
          </label>
          <div class="cinema-sp-sub">
            <span>全局</span>
            <input type="number" data-key="outroDuration" value="${settings.outroDuration}" min="0" max="120" step="1">
            <span>秒</span>
          </div>
          <div class="cinema-sp-sub">
            <span>当前</span>
            <input type="number" id="cinema-io-outro" min="0" max="120" step="1" placeholder="${settings.outroDuration}">
            <span class="cinema-io-reset" id="cinema-io-outro-reset" title="恢复为全局时长">重置</span>
          </div>
          <label class="cinema-sp-toggle">
            <input type="checkbox" data-key="enableSkips" ${settings.enableSkips ? 'checked' : ''}>
            <span class="cinema-sp-toggle-track"></span>
            <span class="cinema-sp-toggle-label">跳过指定片段</span>
          </label>
          <div class="cinema-sp-sub">标记：Alt+[ / Alt+] 或右键进度条</div>
          <div class="cinema-skip-manage" id="cinema-skip-manage"></div>
        </div>
      </div>

      <div class="cinema-sp-section" data-group="shortcuts">
        <span class="cinema-sp-section-head">
          <span class="cinema-sp-section-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h8M6 16h.001M10 16h.001M14 16h.001M18 16h.001"/></svg></span>
          <span>快捷键</span>
        </span>
        <span class="cinema-sp-caret"></span>
      </div>
      <div class="cinema-sp-group" data-group="shortcuts">
        <div class="cinema-sp-group-inner">
          <div class="cinema-sp-shortcuts" id="cinema-shortcut-editor"></div>
        </div>
      </div>

      <div class="cinema-sp-section" data-group="data">
        <span class="cinema-sp-section-head">
          <span class="cinema-sp-section-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></span>
          <span>数据</span>
        </span>
        <span class="cinema-sp-caret"></span>
      </div>
      <div class="cinema-sp-group" data-group="data">
        <div class="cinema-sp-group-inner">
          <div class="cinema-data-actions">
            <button type="button" class="cinema-data-btn" id="cinema-data-export">导出备份</button>
            <button type="button" class="cinema-data-btn" id="cinema-data-import">导入备份</button>
          </div>
          <div class="cinema-sp-sub">备份含设置、播放进度、观影记录</div>
          <input type="file" id="cinema-data-file" accept="application/json,.json" hidden>
        </div>
      </div>

    </div>

    <div class="cinema-sp-resize" data-dir="se" title="拖动调整大小"></div>
    <div class="cinema-sp-resize" data-dir="sw" title="拖动调整大小"></div>
  `;

  // 绑定事件
  ui.settingsPanel.addEventListener('change', (e) => {
    const input = e.target;
    const key = input.dataset.key;
    if (!key) return;
    if (input.type === 'checkbox') {
      settings[key] = input.checked;
    } else if (input.type === 'number') {
      settings[key] = Math.max(0, parseInt(input.value, 10) || 0);
    } else if (input.type === 'select-one') {
      settings[key] = input.value;
    } else if (input.type === 'range') {
      settings[key] = (parseInt(input.value, 10) || 0) / 100;
      const valEl = input.parentElement && input.parentElement.querySelector('.cinema-range-val');
      if (valEl) valEl.textContent = input.value + '%';
    }
    // 切P临时屏蔽P2P窗口时长：钳制 1000–10000ms
    if (key === 'p2pTempMs') {
      settings[key] = Math.min(10000, Math.max(1000, settings[key] || 4000));
    }
    saveSettings();
    applySettings();
    syncBridgeConfig();
    // 全局片头/片尾时长变化时，刷新"当前视频"输入框的占位符
    if (key === 'introDuration' || key === 'outroDuration') {
      refreshIntroOutroInputs();
    }
    // 关闭"预取就绪指示"时立即隐藏当前指示器
    if (key === 'showPrefetchStatus' && input.type === 'checkbox' && !input.checked) {
      hidePrefetchStatus();
    }
  });

  // 面板挂在 body 上（fixed 定位），打开时跟随设置按钮位置
  document.body.appendChild(ui.settingsPanel);

  // 关闭按钮 / 拖动标题栏 / Esc 关闭
  ui.settingsPanel.querySelector('.cinema-sp-close').addEventListener('click', () => {
    cancelShortcutCapture(); // 关闭面板时中止快捷键录制
    ui.settingsPanel.classList.remove('settling', 'resizing');
    ui.settingsPanel.classList.remove('visible');
  });
  initSettingsPanelDrag(ui.settingsPanel, ui.settingsPanel.querySelector('.cinema-sp-title'));
  // 果冻拉伸（右下/左下手柄调整面板宽高）
  initSettingsPanelResize(ui.settingsPanel);
  // 重复 addEventListener 同一函数会被浏览器去重，不会累积
  document.addEventListener('keydown', onPanelEscape);
  // 分组折叠
  initSettingsPanelGroups();

  // 开关切换瞬间的按压回弹（原生 checkbox change 仍由上方 change 委托处理）
  ui.settingsPanel.addEventListener('change', (e) => {
    const input = e.target;
    if (input && input.type === 'checkbox' && input.closest('.cinema-sp-toggle')) {
      const track = input.parentElement && input.parentElement.querySelector('.cinema-sp-toggle-track');
      if (track) {
        track.classList.remove('squish');
        void track.offsetWidth; // 强制回流以重启动画
        track.classList.add('squish');
      }
    }
  });

  bindIntroOutroInputs();
  refreshIntroOutroInputs();
  updateSkipManageList();

  // 排除当前视频（B12）：不入 settings 键，直接切换排除列表
  const exclInput = ui.settingsPanel.querySelector('#cinema-exclude-video');
  if (exclInput) {
    exclInput.addEventListener('change', () => {
      const nowExcluded = toggleCurrentVideoExcluded();
      showStatusBadge(nowExcluded ? '已排除，刷新后生效' : '已恢复，刷新后生效', nowExcluded ? 'info' : 'success');
    });
  }

  // 收藏当前视频（书签）：按钮文字随 isBookmarked 状态刷新
  const bookmarkBtn = ui.settingsPanel.querySelector('#cinema-bookmark-toggle');
  if (bookmarkBtn) {
    bookmarkBtn.addEventListener('click', toggleCurrentBookmark);
  }
  updateBookmarkButton();

  // 快捷键可视化编辑（替代只读帮助文本）
  renderShortcutEditor(ui.settingsPanel.querySelector('#cinema-shortcut-editor'));

  // 备份导出 / 导入
  const exportBtn = ui.settingsPanel.querySelector('#cinema-data-export');
  const importBtn = ui.settingsPanel.querySelector('#cinema-data-import');
  const fileInput = ui.settingsPanel.querySelector('#cinema-data-file');
  if (exportBtn) exportBtn.addEventListener('click', onExportBackup);
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onImportBackupFile);
  }
}

/** Esc 层级关闭（最上层优先）：引导弹窗 → 设置面板 → 观影记录 → 切P失败恢复卡 → 播放完毕操作条 */
function onPanelEscape(e) {
  if (e.key !== 'Escape') return;
  if (ui.onboarding) {
    finishOnboarding();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (ui.settingsPanel && ui.settingsPanel.classList.contains('visible')) {
    cancelShortcutCapture(); // 隐藏面板前中止快捷键录制
    ui.settingsPanel.classList.remove('visible');
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (ui.historyOverlay) {
    closeHistoryPanel();
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
  if (ui.transition && ui.transition.classList.contains('active')) {
    hideFinishedActions();
    hideTransition();
    e.preventDefault();
    e.stopPropagation();
  }
}

/** 设置面板拖拽：按住标题栏移动面板（关闭按钮除外） */
function initSettingsPanelDrag(panel, handle) {
  if (!panel || !handle) return;
  let isDragging = false;
  let startX = 0, startY = 0;
  let origLeft = 0, origTop = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.cinema-sp-close')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    handle.classList.add('cinema-sp-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const newLeft = Math.max(0, Math.min(origLeft + dx, window.innerWidth - pw));
    const newTop = Math.max(0, Math.min(origTop + dy, window.innerHeight - ph));
    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
  });

  const stop = (e, shouldSave) => {
    if (!isDragging) return;
    isDragging = false;
    handle.classList.remove('cinema-sp-dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // 拖拽结束持久化位置（下次打开面板仍在此处）
    if (shouldSave) {
      const rect = panel.getBoundingClientRect();
      savePanelPos(Math.round(rect.left), Math.round(rect.top));
    }
  };
  handle.addEventListener('pointerup', (e) => stop(e, true));
  handle.addEventListener('pointercancel', (e) => stop(e, false));
}

/** 果冻拉伸：拖拽右下/左下手柄自由调整面板宽高。
 * 拉伸时被拉的角收紧、对角鼓起（border-radius 变形），松手后圆角弹回 + 整体晃动一下（spring）。
 * 尺寸持久化到 localStorage「cinemaSettingsPanelSize」，钳制 min 280×240 / max 92vw×86vh */
function initSettingsPanelResize(panel) {
  if (!panel) return;
  const SIZE_KEY = 'cinemaSettingsPanelSize';

  // 恢复上次保存的尺寸
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    if (saved && saved.w && saved.h) {
      const maxW = window.innerWidth * 0.92;
      const maxH = window.innerHeight * 0.86;
      panel.style.width = Math.max(280, Math.min(saved.w, maxW)) + 'px';
      panel.style.height = Math.max(240, Math.min(saved.h, maxH)) + 'px';
    }
  } catch { /* ignore */ }

  panel.querySelectorAll('.cinema-sp-resize').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = handle.dataset.dir; // 'se' | 'sw'
      const startW = panel.offsetWidth;
      const startH = panel.offsetHeight;
      const startX = e.clientX;
      const startY = e.clientY;
      const minW = 280, minH = 240;
      const maxW = window.innerWidth * 0.92;
      const maxH = window.innerHeight * 0.86;

      panel.classList.remove('settling');
      panel.classList.add('resizing');

      const move = (ev) => {
        const dw = ev.clientX - startX;
        const dh = ev.clientY - startY;
        const w = Math.max(minW, Math.min(dir === 'se' ? startW + dw : startW - dw, maxW));
        const h = Math.max(minH, Math.min(startH + dh, maxH));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
        // 果冻变形：拉出的角更紧（圆角小），对角更鼓（圆角大）
        const puffy = 18, tight = 4, mid = 10;
        panel.style.borderRadius = dir === 'se'
          ? `${puffy}px ${mid}px ${tight}px ${mid}px`
          : `${mid}px ${puffy}px ${mid}px ${tight}px`;
        // 尺寸超出视口时把面板拉回
        const rect = panel.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) panel.style.left = Math.max(0, window.innerWidth - 8 - w) + 'px';
        if (rect.bottom > window.innerHeight - 8) panel.style.top = Math.max(0, window.innerHeight - 8 - h) + 'px';
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        panel.classList.remove('resizing');
        // 松手回弹：清除内联圆角 → 过渡弹回，同时整体晃一下
        panel.style.borderRadius = '';
        panel.classList.add('settling');
        setTimeout(() => panel.classList.remove('settling'), 600);
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight }));
        } catch { /* ignore */ }
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });
}

// ============================================================
//  设置面板分组折叠 & 位置持久化
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

/** 设置面板分组折叠：点击分组标题切换显示/隐藏，折叠状态持久化到 localStorage。
 * 默认只展开「常用」，其余分组（连播/界面/剪辑/快捷键/数据）默认折叠；
 * 用户手动展开后状态由 saved 记住（旧版组名不匹配时按默认折叠处理） */
function initSettingsPanelGroups() {
  const panel = ui.settingsPanel;
  if (!panel) return;
  const GROUP_KEY = 'cinemaPanelGroups';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(GROUP_KEY) || '{}') || {}; } catch { saved = {}; }
  const defaultCollapsed = new Set(['playback', 'ui', 'edit', 'shortcuts', 'data']);

  panel.querySelectorAll('.cinema-sp-section[data-group]').forEach((sec) => {
    const group = sec.dataset.group;
    const body = panel.querySelector(`.cinema-sp-group[data-group="${group}"]`);
    if (!body) return;
    const collapsed = (group in saved) ? !!saved[group] : defaultCollapsed.has(group);
    if (collapsed) {
      body.classList.add('collapsed');
      sec.classList.add('collapsed');
    }
    sec.addEventListener('click', () => {
      const willCollapse = !body.classList.contains('collapsed');
      body.classList.toggle('collapsed', willCollapse);
      sec.classList.toggle('collapsed', willCollapse);
      saved[group] = willCollapse;
      try { localStorage.setItem(GROUP_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    });
  });
}

/** 绑定"当前视频"片头/片尾时长输入框（按视频独立配置，留空=用全局） */
function bindIntroOutroInputs() {
  const panel = ui.settingsPanel;
  if (!panel) return;
  const introInput = panel.querySelector('#cinema-io-intro');
  const outroInput = panel.querySelector('#cinema-io-outro');
  const introReset = panel.querySelector('#cinema-io-intro-reset');
  const outroReset = panel.querySelector('#cinema-io-outro-reset');

  const applyValue = (input, field) => {
    const raw = (input.value || '').trim();
    if (!state.ioOverride) state.ioOverride = {};
    if (raw === '') {
      delete state.ioOverride[field];
    } else {
      state.ioOverride[field] = Math.max(0, parseInt(raw, 10) || 0);
    }
    if (Object.keys(state.ioOverride).length === 0) state.ioOverride = null;
    saveIntroOutro();
  };

  const clearOverride = (field, input) => {
    if (state.ioOverride) delete state.ioOverride[field];
    if (state.ioOverride && Object.keys(state.ioOverride).length === 0) state.ioOverride = null;
    saveIntroOutro();
    refreshIntroOutroInputs();
    if (input) input.blur();
  };

  if (introInput) introInput.addEventListener('change', () => applyValue(introInput, 'intro'));
  if (outroInput) outroInput.addEventListener('change', () => applyValue(outroInput, 'outro'));
  if (introReset) introReset.addEventListener('click', () => clearOverride('intro', introInput));
  if (outroReset) outroReset.addEventListener('click', () => clearOverride('outro', outroInput));
}

/** 刷新"当前视频"片头/片尾输入框的值与占位符 */
function refreshIntroOutroInputs() {
  const panel = ui.settingsPanel;
  if (!panel) return;
  const introInput = panel.querySelector('#cinema-io-intro');
  const outroInput = panel.querySelector('#cinema-io-outro');
  if (introInput) {
    introInput.value = state.ioOverride && typeof state.ioOverride.intro === 'number' ? state.ioOverride.intro : '';
    introInput.placeholder = String(settings.introDuration);
  }
  if (outroInput) {
    outroInput.value = state.ioOverride && typeof state.ioOverride.outro === 'number' ? state.ioOverride.outro : '';
    outroInput.placeholder = String(settings.outroDuration);
  }
}

function toggleSettingsPanel() {
  if (!ui.settingsPanel) return;
  const willShow = !ui.settingsPanel.classList.contains('visible');
  if (willShow) positionSettingsPanel();
  // 面板收起时中止可能进行中的快捷键录制（避免无界面情况下继续捕获按键）
  if (!willShow) {
    cancelShortcutCapture();
    ui.settingsPanel.classList.remove('settling', 'resizing');
  }
  ui.settingsPanel.classList.toggle('visible');
}

/** 将设置面板定位到设置按钮附近（优先按钮上方，空间不足则下方；水平方向钳制在视口内）
 * 若用户曾拖动过面板（位置已持久化），则优先使用保存的位置 */
function positionSettingsPanel() {
  const btn = ui.settingsBtn;
  const panel = ui.settingsPanel;
  if (!btn || !panel) return;
  let panelW = panel.offsetWidth;
  let panelH = panel.offsetHeight;
  // 面板隐藏时尺寸为 0，临时显示（不可见）以获取真实尺寸
  if (!panelW || !panelH) {
    const prevDisplay = panel.style.display;
    const prevVisibility = panel.style.visibility;
    panel.style.display = 'block';
    panel.style.visibility = 'hidden';
    panelW = panel.offsetWidth || 220;
    panelH = panel.offsetHeight || 320;
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

  // 按钮被隐藏时（通过双击播放器呼出面板）：默认放在页面右侧
  if (btn.style.display === 'none') {
    panel.style.left = Math.max(8, window.innerWidth - panelW - 16) + 'px';
    panel.style.top = Math.max(8, Math.min(80, window.innerHeight - panelH - 8)) + 'px';
    return;
  }

  const btnRect = btn.getBoundingClientRect();

  let top = btnRect.top - panelH - 8;
  if (top < 8) top = btnRect.bottom + 8;
  top = Math.max(8, Math.min(top, window.innerHeight - panelH - 8));

  let left = btnRect.right - panelW;
  left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8));

  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function applySettings() {
  const isCinemaActive = settings.enabled && state.isMultiPart;

  // 隐藏/显示分P界面
  document.body.classList.toggle('cinema-hide-parts', settings.enabled && settings.hidePartUI);
  // 合集模式下额外添加 class（隐藏右侧合集面板）
  document.body.classList.toggle('cinema-season-mode', state.mode === 'season');
  // 底部进度条接管标记
  document.body.classList.toggle('cinema-bottom-progress', isCinemaActive);
  document.body.classList.toggle('cinema-active', settings.enabled);
  document.body.classList.toggle('cinema-multi-part', state.isMultiPart);
  if (state.playerWrap) {
    state.playerWrap.classList.toggle('cinema-active', settings.enabled);
  }

  // 应用统一进度条样式
  if (ui.bar) {
    const style = settings.progressStyle || 'classic';
    ui.bar.classList.remove(
      'progress-style-classic', 'progress-style-flow',
      'progress-style-minimal', 'progress-style-neon', 'progress-style-film',
      'progress-style-chapter', 'progress-style-aurora', 'progress-style-sunset',
      'progress-style-cyberpunk', 'progress-style-sakura'
    );
    ui.bar.classList.add('progress-style-' + style);
    // 章节样式：fill 渐变由内联设置（面板切换样式时在此应用/取消）
    applyChapterGradient();
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

  // 设置按钮的显隐只看面板开关：即使影院模式被禁用，按钮也保留，确保始终有入口重新启用
  // 使用 opacity 而非 display:none 隐藏，避免全屏切换时按钮彻底从布局消失导致无法恢复
  if (ui.settingsBtn) {
    if (settings.showSettingsBtn) {
      ui.settingsBtn.style.display = '';
      ui.settingsBtn.style.opacity = '';
      ui.settingsBtn.style.pointerEvents = '';
      ui.settingsBtn.style.visibility = '';
    } else {
      ui.settingsBtn.style.opacity = '0';
      ui.settingsBtn.style.pointerEvents = 'none';
      ui.settingsBtn.style.visibility = 'hidden';
    }
  }

  // 状态徽章显隐（常驻不自动隐藏，由设置项控制）
  if (ui.statusBadge) {
    ui.statusBadge.style.display = settings.showStatusBadge ? '' : 'none';
  }

  // 关灯遮罩
  updateLightsOut();

  // 关闭自动关闭标签页时，收起可能已显示的提示气泡
  if (!settings.autoCloseTab) {
    closeCloseTabTip();
  }
}

// ============================================================
//  全局快捷键（A5：键盘可访问性 + 全局快捷键）
// ============================================================

/** 全局快捷键映射（用户存储的 shortcuts 对象优先，缺失时回退默认） */
function getShortcuts() {
  return (settings && settings.shortcuts) || DEFAULT_SETTINGS.shortcuts;
}

/** 快捷键动作清单（action → 中文名），顺序即编辑器行序 */
const SHORTCUT_ACTIONS = [
  ['nextPart', '下一P'],
  ['prevPart', '上一P'],
  ['toggleSettings', '设置'],
  ['toggleHistory', '记录'],
  ['toggleLights', '关灯'],
  ['seekBack', '后退10秒'],
  ['seekForward', '前进10秒'],
];

/** 键盘 code → 友好显示（KeyJ→J，ArrowLeft→←，DigitN→N） */
function friendlyKeyName(code) {
  if (!code) return '—';
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  return code;
}

/** 渲染快捷键编辑器：每行一个动作（名称 + 可点击的按键按钮），底部附"恢复默认"链接 */
function renderShortcutEditor(container) {
  if (!container) return;
  const s = getShortcuts() || {};
  container.innerHTML = '';

  for (const [action, label] of SHORTCUT_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'cinema-shortcut-row';

    const lbl = document.createElement('span');
    lbl.className = 'cinema-shortcut-label';
    lbl.textContent = label;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cinema-shortcut-key';
    btn.dataset.action = action;
    btn.textContent = friendlyKeyName(s[action]);
    btn.title = '点击后按下新按键';
    btn.addEventListener('click', () => beginShortcutCapture(action, btn));

    row.appendChild(lbl);
    row.appendChild(btn);
    container.appendChild(row);
  }

  const resetRow = document.createElement('div');
  resetRow.className = 'cinema-shortcut-reset-row';
  const reset = document.createElement('span');
  reset.className = 'cinema-io-reset';
  reset.id = 'cinema-shortcut-reset';
  reset.textContent = '恢复默认快捷键';
  reset.title = '恢复为 N / P / S / H / L / J / K';
  reset.addEventListener('click', () => {
    settings.shortcuts = { ...DEFAULT_SETTINGS.shortcuts };
    saveSettings();
    renderShortcutEditor(container);
  });
  resetRow.appendChild(reset);
  container.appendChild(resetRow);
}

/** 开始录制某动作的新快捷键（document 捕获阶段监听一次）：
 * Esc 取消；仅按修饰键或带 Ctrl/Meta/Alt 的组合忽略；与其它动作冲突则提示并中止。
 * 监听器句柄存 state.shortcutCaptureHandler，供 cancelShortcutCapture 清理 */
function beginShortcutCapture(action, btn) {
  if (state.shortcutCapturing) return;
  state.shortcutCapturing = action;
  const container = btn.closest('#cinema-shortcut-editor');
  btn.classList.add('capturing');
  btn.textContent = '按下按键…';

  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Esc：取消录制
    if (e.key === 'Escape') {
      cancelShortcutCapture();
      return;
    }
    const code = e.code || '';
    // 仅按下修饰键本身：忽略，等待下一个按键
    if (!code || /^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(code)) return;
    // 带 Ctrl/Meta/Alt 的组合不承接（避免覆盖浏览器/页面快捷键）
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const s = getShortcuts() || {};
    const usedBy = Object.keys(s).find((k) => k !== action && s[k] === code);

    if (usedBy) {
      // 已被其它动作占用：提示并中止本次录制
      cancelShortcutCapture();
      const btnEl = container.querySelector(`[data-action="${action}"]`);
      if (btnEl) {
        btnEl.classList.add('conflict');
        btnEl.textContent = `已占用：${friendlyKeyName(code)}`;
        setTimeout(() => renderShortcutEditor(container), 1400);
      }
      return;
    }
    settings.shortcuts = { ...s, [action]: code };
    saveSettings();
    cancelShortcutCapture();
  };
  state.shortcutCaptureHandler = onKey;
  document.addEventListener('keydown', onKey, true);
}

/** 取消快捷键录制（设置面板关闭 / Esc / 开始新录制前调用）：
 * 移除捕获监听、清空录制状态；面板仍打开时重渲染编辑器恢复键帽显示 */
function cancelShortcutCapture() {
  if (state.shortcutCaptureHandler) {
    document.removeEventListener('keydown', state.shortcutCaptureHandler, true);
    state.shortcutCaptureHandler = null;
  }
  state.shortcutCapturing = false;
  if (ui.settingsPanel && ui.settingsPanel.classList.contains('visible')) {
    const container = ui.settingsPanel.querySelector('#cinema-shortcut-editor');
    if (container) renderShortcutEditor(container);
  }
}

/** 全局快捷键 keydown 处理（document 级，capture false） */
function onCinemaShortcutKey(e) {
  if (!settings.enabled) return;
  // 快捷键录制中：按键交给录制流程处理，全局快捷键不响应
  if (state.shortcutCapturing) return;

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
  const s = getShortcuts() || {};
  let action = null;
  for (const name of Object.keys(s)) {
    if (s[name] === code) { action = name; break; }
  }
  if (!action) return;

  // 修饰键约束：纯字母快捷键要求无 ctrl/meta/alt；方向键始终可用（仅避开 ctrl/meta）
  const isArrow = code === 'ArrowLeft' || code === 'ArrowRight';
  if (!isArrow && (e.ctrlKey || e.metaKey || e.altKey)) return;
  if (e.ctrlKey || e.metaKey) return;

  // 进度条聚焦时方向键由 onProgressBarKeyDown 处理（±10s），避免双重 seek
  if (ui.bar && (e.target === ui.bar || ui.bar.contains(e.target))) return;

  e.preventDefault();

  switch (action) {
    case 'nextPart':
      if (state.isMultiPart && state.currentIndex < state.pages.length - 1 && typeof goToNextPart === 'function') {
        goToNextPart();
      }
      break;
    case 'prevPart':
      if (state.isMultiPart && state.currentIndex > 0 && typeof jumpToPart === 'function') {
        jumpToPart(state.currentIndex - 1, 0);
      }
      break;
    case 'toggleSettings':
      toggleSettingsPanel();
      break;
    case 'toggleHistory':
      toggleHistoryPanel();
      break;
    case 'toggleLights':
      settings.lightsOut = !settings.lightsOut;
      saveSettings();
      applySettings();
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

/** 观影记录面板开关（快捷键 H） */
function toggleHistoryPanel() {
  if (ui.historyOverlay) {
    closeHistoryPanel();
  } else {
    openHistoryPanel();
  }
}

// ============================================================
//  排除模式恢复入口（B12：被排除视频右下角小chip）
// ============================================================

/** 展示"影院模式已对此视频关闭"小chip（被排除视频的最小恢复入口），点击恢复并刷新页面 */
function showExcludedStub() {
  hideExcludedStub();
  const chip = document.createElement('div');
  chip.id = 'cinema-excluded-stub';
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-label', '影院模式已对此视频关闭，点击恢复');
  chip.textContent = '影院模式已对此视频关闭 · 点击恢复';
  chip.addEventListener('click', () => {
    toggleCurrentVideoExcluded();
    location.reload();
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCurrentVideoExcluded();
      location.reload();
    }
  });
  document.body.appendChild(chip);
  ui.excludedStub = chip;
}

/** 移除排除模式小chip（幂等，不存在时静默返回） */
function hideExcludedStub() {
  if (ui.excludedStub) {
    ui.excludedStub.remove();
    ui.excludedStub = null;
  }
}

// ============================================================
//  首次使用引导（A6：多P视频首次启用时展示）
// ============================================================

/** 首次使用引导弹窗（role=dialog、aria-modal、Esc 视为"知道了"） */
function showOnboarding() {
  hideOnboarding();

  const overlay = document.createElement('div');
  overlay.id = 'cinema-onboarding';
  overlay.className = 'cinema-onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '影院模式新手引导');
  overlay.innerHTML = `
    <div class="cinema-onboarding-card">
      <div class="cinema-onboarding-title">欢迎使用影院模式</div>
      <ul class="cinema-onboarding-steps">
        <li>影院模式把多分P合成一部电影</li>
        <li>统一进度条可拖拽；键盘 N 下一P / P 上一P</li>
        <li>右下角徽章打开观影记录；齿轮打开设置</li>
        <li>切P失败时会出现恢复按钮</li>
      </ul>
      <button type="button" class="cinema-onboarding-btn" id="cinema-onboarding-ok">知道了</button>
    </div>
  `;
  document.body.appendChild(overlay);
  ui.onboarding = overlay;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) finishOnboarding();
  });
  overlay.querySelector('#cinema-onboarding-ok').addEventListener('click', finishOnboarding);

  // 焦点移到主按钮（可访问性）
  const okBtn = overlay.querySelector('#cinema-onboarding-ok');
  setTimeout(() => { if (okBtn) okBtn.focus(); }, 50);
}

/** "知道了"：标记完成并关闭 */
function finishOnboarding() {
  settings.onboardingDone = true;
  saveSettings();
  hideOnboarding();
}

function hideOnboarding() {
  if (ui.onboarding) {
    ui.onboarding.remove();
    ui.onboarding = null;
  }
}

// ============================================================
//  关灯模式（压暗播放器外区域 + 影院荧幕氛围光 + 胶片暗角）
// ============================================================

/** 关灯遮罩刷新节流：timeupdate 高频调用，实际只需 500ms 一次 */
let lastLightsOutAt = 0;
let ambilightOffscreen = null;
let ambilightRendering = false;
let ambilightRafId = null;
let idleTimer = null;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** 标记用户活动：打断闲置状态；静止 2.5 秒后自动进入纯净暗场（淡化水印与顶栏杂散元素） */
function markUserActive() {
  if (!state.playerWrap) return;
  state.playerWrap.classList.remove('cinema-idle');
  document.body.classList.remove('cinema-idle');
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (state.video && !state.video.paused && settings.enabled) {
      state.playerWrap.classList.add('cinema-idle');
      document.body.classList.add('cinema-idle');
    }
  }, 2500);
}

/** 抽取视频帧微采样到氛围光 Canvas，向全屏四周/黑边投射实时流光 */
function updateAmbilightFrame() {
  if (!settings.enabled || !settings.lightsOut || !state.video || !ui.ambilightCanvas) return;
  const isBigScreen = isBigScreenDisplay();
  if (!isBigScreen || state.video.paused || state.video.ended || state.video.readyState < 2) {
    if (ui.ambilight) ui.ambilight.classList.remove('active');
    return;
  }

  try {
    if (!ambilightOffscreen) {
      ambilightOffscreen = document.createElement('canvas');
      ambilightOffscreen.width = 16;
      ambilightOffscreen.height = 9;
    }
    const offCtx = ambilightOffscreen.getContext('2d', { willReadFrequently: false });
    if (!offCtx) return;
    offCtx.drawImage(state.video, 0, 0, 16, 9);

    const mainCtx = ui.ambilightCanvas.getContext('2d');
    if (!mainCtx) return;
    mainCtx.drawImage(ambilightOffscreen, 0, 0, ui.ambilightCanvas.width, ui.ambilightCanvas.height);

    if (ui.ambilight && !ui.ambilight.classList.contains('active')) {
      ui.ambilight.classList.add('active');
    }
  } catch (e) {
    // 跨域或安全受限（如极少数非 blob 源）时静默回退
    if (ui.ambilight) ui.ambilight.classList.remove('active');
  }
}

function startAmbilightLoop() {
  if (ambilightRendering) return;
  ambilightRendering = true;

  let lastSample = 0;
  const loop = (now) => {
    if (!ambilightRendering) return;
    if (now - lastSample >= 120) { // ~8 fps 采样，极低开销
      lastSample = now;
      updateAmbilightFrame();
    }
    ambilightRafId = requestAnimationFrame(loop);
  };
  ambilightRafId = requestAnimationFrame(loop);
}

function stopAmbilightLoop() {
  ambilightRendering = false;
  if (ambilightRafId) {
    cancelAnimationFrame(ambilightRafId);
    ambilightRafId = null;
  }
  if (ui.ambilight) ui.ambilight.classList.remove('active');
}

/** 检测当前是否处于大屏模式（网页全屏或原生全屏） */
function isBigScreenDisplay() {
  if (document.fullscreenElement || document.webkitFullscreenElement) return true;
  const bp = document.querySelector('#bilibili-player, .bilibili-player, .bpx-player-container');
  if (bp && (bp.classList.contains('mode-webscreen') || bp.classList.contains('bpx-player-mode-webscreen'))) return true;
  const wrap = state.playerWrap || document.querySelector('.player-wrap');
  if (wrap && (wrap.classList.contains('mode-webscreen') || wrap.classList.contains('bpx-player-mode-webscreen'))) return true;
  const webBtn = document.querySelector('.bpx-player-ctrl-web');
  if (webBtn && webBtn.classList.contains('bpx-state-entered')) return true;
  return false;
}

/** 刷新关灯模式与影院氛围系统：仅在网页全屏/全屏大屏模式下激活生效。
 * 激活荧幕氛围光、电影胶片暗角与纯净暗场水印淡化；处于普通窗口播放时自动休眠保持通透 */
function updateLightsOut() {
  const now = Date.now();
  if (now - lastLightsOutAt < 500) return;
  lastLightsOutAt = now;

  // 隐藏与停用：移除亮起 class，停止氛围光循环
  const hideMask = () => {
    if (ui.lightsOut) {
      ui.lightsOut._pendingOn = false;
      ui.lightsOut.classList.remove('on');
    }
    if (state.playerWrap) {
      state.playerWrap.classList.remove('cinema-lights-out-active', 'cinema-idle');
    }
    if (ui.vignette) {
      ui.vignette.classList.remove('active');
    }
    stopAmbilightLoop();
  };

  const isBigScreen = isBigScreenDisplay();
  const active = settings.enabled && settings.lightsOut && state.playerWrap && isBigScreen;
  if (!active) { hideMask(); return; }

  // 激活大屏暗场、胶片暗角与流光系统
  if (state.playerWrap) {
    state.playerWrap.classList.add('cinema-lights-out-active');
  }
  if (ui.vignette) {
    ui.vignette.classList.add('active');
  }
  startAmbilightLoop();

  // 首次创建遮罩（默认 opacity:0；同一帧插入后立即加 class 不会触发过渡，推迟一帧再亮起）
  if (!ui.lightsOut) {
    ui.lightsOut = document.createElement('div');
    ui.lightsOut.id = 'cinema-lights-out';
    document.body.appendChild(ui.lightsOut);
  }

  const rect = state.playerWrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) { hideMask(); return; }

  ui.lightsOut.style.left = rect.left + 'px';
  ui.lightsOut.style.top = rect.top + 'px';
  ui.lightsOut.style.width = rect.width + 'px';
  ui.lightsOut.style.height = rect.height + 'px';
  ui.lightsOut.style.setProperty('--cinema-lights-out-opacity', String(settings.lightsOutOpacity || 0.85));

  // 已亮起或已有待执行的入场则无需重复调度
  if (ui.lightsOut.classList.contains('on') || ui.lightsOut._pendingOn) return;
  ui.lightsOut._pendingOn = true;
  requestAnimationFrame(() => {
    if (ui.lightsOut && ui.lightsOut._pendingOn) {
      ui.lightsOut.classList.add('on');
      ui.lightsOut._pendingOn = false;
    }
  });
}
