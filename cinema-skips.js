/**
 * B站影院模式 - 跳过片段模块
 * 电影总时间线上的跳过区间：标记（快捷键 / 进度条右键 / 面板按钮）、
 * 进度条标记渲染、播放时自动跳过
 */

'use strict';

/** 电影总时间线当前时间（跨分P连续） */
function getOverallTime() {
  const video = state.video;
  if (!video) return 0;
  return (state.cumulative[state.currentIndex] || 0) + (video.currentTime || 0);
}

/** 标记跳过起点（快捷键 / 进度条右键 / 面板按钮共用） */
function markSkipStart(t) {
  if (typeof t !== 'number' || !isFinite(t) || t < 0) return;
  state.skipMarkStart = t;
  showTransition(`跳过起点已标记: ${formatTime(t)}（再标记终点完成添加）`, false, 1500);
  log('标记跳过起点', t);
}

/** 标记跳过终点并添加片段 */
function markSkipEnd(t) {
  if (typeof t !== 'number' || !isFinite(t)) return;
  if (typeof state.skipMarkStart === 'number' && t > state.skipMarkStart + 1) {
    state.skips.push({ start: state.skipMarkStart, end: t, ts: Date.now() });
    state.skips.sort((a, b) => a.start - b.start);
    saveSkips();
    renderSkipMarkers();
    updateSkipManageList();
    showTransition(`已添加跳过片段 ${formatTime(state.skipMarkStart)} - ${formatTime(t)}`, false, 1500);
    log('添加跳过片段', state.skips[state.skips.length - 1]);
  } else {
    showTransition('跳过片段太短（需 >1 秒）或尚未标记起点', true);
  }
  state.skipMarkStart = null;
}

function setupSkipShortcuts() {
  state.skipKeyHandler = (e) => {
    if (!settings.enabled || !settings.enableSkips || !state.isMultiPart) return;
    if (!e.altKey || (e.key !== '[' && e.key !== ']')) return;
    e.preventDefault();
    if (e.key === '[') {
      markSkipStart(getOverallTime());
    } else {
      markSkipEnd(getOverallTime());
    }
  };
  document.addEventListener('keydown', state.skipKeyHandler);
}

function renderSkipMarkers() {
  if (!ui.markers) return;
  ui.markers.querySelectorAll('.cinema-skip-seg').forEach((el) => el.remove());
  if (state.totalDuration <= 0) return;
  for (const s of state.skips) {
    const el = document.createElement('div');
    el.className = 'cinema-skip-seg';
    const left = (s.start / state.totalDuration) * 100;
    const width = Math.max(0.4, ((s.end - s.start) / state.totalDuration) * 100);
    el.style.left = Math.min(99.6, left) + '%';
    el.style.width = width + '%';
    el.title = `跳过 ${formatTime(s.start)} - ${formatTime(s.end)}（点击移除）`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSkip(s);
    });
    ui.markers.appendChild(el);
  }
}

function removeSkip(skip) {
  state.skips = state.skips.filter((s) => s !== skip);
  saveSkips();
  renderSkipMarkers();
  updateSkipManageList();
}

/** 检查当前是否处于跳过区间，若是则跳至区间末尾（防抖） */
function checkSkipSegments() {
  const video = state.video;
  if (!video || state.switching || !settings.enableSkips || state.skips.length === 0) return;
  const overall = getOverallTime();
  const now = Date.now();
  if (now - state.skipGuardTime < 1500) return; // 防抖，避免反复触发

  for (const s of state.skips) {
    if (overall >= s.start && overall < s.end) {
      const target = overallToPartOffset(state.cumulative, s.end);
      if (target) {
        state.skipGuardTime = now;
        if (target.index === state.currentIndex) {
          video.currentTime = Math.min(target.offset, (video.duration || 0) - 0.5);
          log(`自动跳过片段: ${formatTime(s.start)} - ${formatTime(s.end)}`);
        } else {
          jumpToPart(target.index, target.offset);
        }
      }
      return;
    }
  }
}

/** 设置面板中的跳过片段管理（含"标记起点/终点"快捷按钮） */
function updateSkipManageList() {
  const el = ui.settingsPanel && ui.settingsPanel.querySelector('#cinema-skip-manage');
  if (!el) return;
  el.innerHTML = '';

  // 标记按钮：以当前播放位置标记起点/终点
  const actions = document.createElement('div');
  actions.className = 'cinema-skip-actions';
  const btnStart = document.createElement('span');
  btnStart.className = 'cinema-skip-action';
  btnStart.textContent = '标记起点';
  btnStart.title = '以当前播放位置标记跳过起点';
  btnStart.addEventListener('click', () => markSkipStart(getOverallTime()));
  const btnEnd = document.createElement('span');
  btnEnd.className = 'cinema-skip-action';
  btnEnd.textContent = '标记终点';
  btnEnd.title = '以当前播放位置标记终点并添加片段';
  btnEnd.addEventListener('click', () => markSkipEnd(getOverallTime()));
  actions.appendChild(btnStart);
  actions.appendChild(btnEnd);
  el.appendChild(actions);

  if (state.skips.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cinema-skip-empty';
    empty.textContent = '暂无跳过片段';
    el.appendChild(empty);
    return;
  }

  for (const s of state.skips) {
    const row = document.createElement('div');
    row.className = 'cinema-skip-item';
    row.innerHTML = `<span>${formatTime(s.start)} - ${formatTime(s.end)}</span>`;
    const del = document.createElement('span');
    del.className = 'cinema-skip-del';
    del.textContent = '✕';
    del.title = '移除该片段';
    del.addEventListener('click', () => removeSkip(s));
    row.appendChild(del);
    el.appendChild(row);
  }

  const clear = document.createElement('div');
  clear.className = 'cinema-skip-clear';
  clear.textContent = '清空全部跳过片段';
  clear.addEventListener('click', () => {
    state.skips = [];
    saveSkips();
    renderSkipMarkers();
    updateSkipManageList();
  });
  el.appendChild(clear);
}
