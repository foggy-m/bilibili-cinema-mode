/**
 * B站影院模式 - 引导模块
 * 初始化流程、SPA 导航监听、播放器容器变化监听、清理
 *
 * 依赖（manifest 按序注入，共享隔离世界全局作用域）：
 *   cinema-core.js → cinema-player.js → cinema-skips.js → cinema-ui.js → content.js
 */

'use strict';

// ============================================================
//  SPA 导航监听
// ============================================================

// B12：导航观察器幂等标记 —— 排除模式也会注册导航观察器（保证从被排除视频 SPA
// 跳转到未排除视频时能自动恢复完整模式）；因底层 pushState/popstate 钩子从不移除，
// 故该标记跨 cleanup 保持 true，防止重复包装/重复 interval 堆叠。
let navObserverHooked = false;

function setupNavigationObserver() {
  if (navObserverHooked) return;
  navObserverHooked = true;

  // 监听 URL 变化（B站 SPA 导航）
  let lastUrl = location.href;

  const checkUrl = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  };

  // 使用 popstate + pushState 拦截
  window.addEventListener('popstate', () => setTimeout(checkUrl, 100));

  const origPush = history.pushState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    setTimeout(checkUrl, 100);
  };

  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    setTimeout(checkUrl, 100);
  };

  // 备用：定期检查
  setInterval(checkUrl, 1000);
}

function onNavigate() {
  // 检查是否还在视频页面
  if (!location.pathname.includes('/video/')) {
    cleanup();
    return;
  }

  const newBvid = getBvid();
  const newPage = getCurrentPage();

  // URL 中间态保护：SPA 导航期间 pathname 可能短暂不完整（getBvid 返回空），跳过本次检查
  if (!newBvid) return;

  // B12：目标视频被排除时不做任何播放器接线；跨视频则走 cleanup+reinit（门禁负责展示 stub）
  if (isBvidExcluded(newBvid)) {
    if (newBvid !== state.bvid) {
      log('导航到已排除视频，清理并展示最小入口');
      if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
      cleanup();
      setTimeout(init, 500);
    }
    return;
  }

  // 合集模式：检查新 bvid 是否属于同一 season
  if (state.mode === 'season' && state.seasonEpisodes.length > 0) {
    const epIndex = state.seasonEpisodes.findIndex((ep) => ep.bvid === newBvid);
    if (epIndex !== -1) {
      // 同一 season 内的切换
      if (epIndex !== state.currentIndex && !state.switching && !state.restoringProgress) {
        state.currentIndex = epIndex;
        state.bvid = newBvid;
        refreshVideoElement();
        updatePartIndicator();
        updateUnifiedProgress();
        // 手动导航已落地：收起可能残留的切P失败恢复卡
        if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
        if (typeof syncBridgeConfig === 'function') syncBridgeConfig(); // 当前集已变：更新桥接 currentCid
      }
      return;
    }
  }

  if (newBvid !== state.bvid) {
    // 切换了视频，完全重新初始化
    log('检测到新视频，重新初始化');
    if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
    cleanup();
    setTimeout(init, 500);
  } else if (state.mode === 'pages' && newPage - 1 !== state.currentIndex && !state.switching && !state.restoringProgress) {
    // 同一视频但P数变了（可能是用户手动点击了分P）
    state.currentIndex = newPage - 1;
    refreshVideoElement();
    updatePartIndicator();
    updateUnifiedProgress();
    // 手动导航已落地：收起可能残留的切P失败恢复卡
    if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
    if (typeof syncBridgeConfig === 'function') syncBridgeConfig(); // 当前P已变：更新桥接 currentCid
  }
}

function refreshVideoElement() {
  const video = findVideo();
  if (video && video !== state.video) {
    detachVideoListeners();
    state.video = video;
    attachVideoListeners();
    // 手动切换分P后重置预取状态
    state.preloadedCid = null;
    state.preloadFailCount = 0;
    if (typeof syncBridgeConfig === 'function') syncBridgeConfig(); // 视频已更换：同步桥接配置
  }
}

// ============================================================
//  播放器容器变化监听（收窄监听范围，降低开销）
// ============================================================

function setupPlayerObserver() {
  if (state.observer) state.observer.disconnect();
  if (state.observerTop) state.observerTop.disconnect();

  let debounceTimer = null;

  const checkVideoChange = () => {
    // 播放器容器整体变化时，把观察器挂到新容器上
    const wrap = findPlayerWrap();
    if (wrap && wrap !== state.playerWrap) {
      state.playerWrap = wrap;
      state.observer.disconnect();
      state.observer.observe(wrap, { childList: true, subtree: true });
    }
    // 检查视频元素是否被替换
    const video = findVideo();
    if (video && video !== state.video) {
      log('检测到视频元素变化');
      detachVideoListeners();
      state.video = video;
      attachVideoListeners();
      if (state.playerWrap && (!ui.bar || !state.playerWrap.contains(ui.bar))) {
        createUI();
      }
      applySettings();
      if (typeof syncBridgeConfig === 'function') syncBridgeConfig(); // 视频已更换：同步桥接配置
    }
  };

  const onMutate = () => {
    // 防抖：B站播放器 DOM 变动非常频繁（弹幕、控件等），避免性能问题
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      checkVideoChange();
    }, 300);
  };

  state.observer = new MutationObserver(onMutate);
  if (state.playerWrap) {
    // 只观察播放器容器内部（范围小、开销低）
    state.observer.observe(state.playerWrap, { childList: true, subtree: true });
    // 另观察 body 直接子节点（不递归）：捕获播放器容器被整体重建的情况
    state.observerTop = new MutationObserver(onMutate);
    state.observerTop.observe(document.body, { childList: true });
  } else {
    // 播放器尚未加载：回退为观察整个页面
    state.observer.observe(document.body, { childList: true, subtree: true });
  }
}

// ============================================================
//  初始化 & 清理
// ============================================================

async function init() {
  if (state.initialized) return;

  log('初始化...');
  showStatusBadge('影院模式：初始化中...', 'info');

  await loadSettings();

  // 获取视频数据（异步）
  const hasData = await extractPageData();
  if (!hasData) {
    // 等待页面加载完成后重试
    let retries = 0;
    const retry = async () => {
      retries++;
      pageDataPromise = null; // 重置，允许重新注入
      if (await extractPageData()) {
        proceed();
      } else if (retries < 20) {
        setTimeout(retry, 500);
      } else {
        log('无法获取视频数据，影院模式不启用');
        showStatusBadge('影院模式：无法获取视频数据', 'error');
      }
    };
    setTimeout(retry, 500);
    return;
  }

  await proceed();
}

async function proceed() {
  state.bvid = state.bvid || getBvid();

  // B12 排除门禁：被排除的视频不创建完整 UI、不挂载切换/预取/快捷键，仅保留最小恢复入口。
  // 成功初始化路径与排除路径都会应用主题（applyCinemaTheme 幂等）。
  applyCinemaTheme();
  if (isCurrentVideoExcluded()) {
    log('此视频已排除影院模式，仅显示最小恢复入口');
    setupNavigationObserver(); // 保留 SPA 导航能力：跳转到未排除视频时自动恢复完整模式
    // 覆盖"初始化中"徽章文本，保持排除提示常驻（不调用 hideStatusBadge 隐藏）
    if (typeof showStatusBadge === 'function') {
      showStatusBadge('此视频已排除影院模式', 'info');
    }
    if (typeof showExcludedStub === 'function') {
      showExcludedStub();
    }
    return;
  }

  // 合集模式：通过当前 bvid 确定当前集索引
  if (state.mode === 'season') {
    const epIndex = state.seasonEpisodes.findIndex((ep) => ep.bvid === state.bvid);
    state.currentIndex = epIndex !== -1 ? epIndex : 0;
  } else {
    state.currentIndex = getCurrentPage() - 1;
  }
  // C16：合集索引已知后重算"播完下一部"候选（幂等；extractPageData 已算过一次）
  resolveNextWork();

  state.isMultiPart = state.pages.length > 1;

  if (!state.isMultiPart) {
    log('单集视频，影院模式仅显示统一进度');
  } else {
    log(`检测到 ${state.pages.length} 个${state.mode === 'season' ? '剧集' : '分P'}，影院模式启用`);
  }

  // 获取时长
  await fetchDurations();
  computeCumulative();

  // 等待视频元素
  let videoRetries = 0;
  const waitForVideo = () => {
    const video = findVideo();
    if (video) {
      state.video = video;
      state.playerWrap = findPlayerWrap();
      onVideoFound();
    } else if (videoRetries < 30) {
      videoRetries++;
      setTimeout(waitForVideo, 500);
    } else {
      log('未找到视频元素');
    }
  };
  waitForVideo();
}

async function onVideoFound() {
  attachVideoListeners();
  createUI();
  applySettings();
  syncBridgeConfig();
  setupNavigationObserver();
  setupPlayerObserver();

  // 加载播放器设置记忆（画质/倍速/音量/弹幕）
  await loadPlayerPrefs();

  // 预热收藏缓存（C16：页面内 isBookmarked/toggleBookmark 需要同步可读）
  readBookmarks(() => {});

  // 加载跳过片段
  await loadSkips();
  renderSkipMarkers();
  updateSkipManageList();

  // 加载当前视频的片头/片尾时长覆盖
  await loadIntroOutro();
  refreshIntroOutroInputs();

  // 注册跳过片段快捷键
  setupSkipShortcuts();

  // 全局快捷键（键盘可访问性）
  setupCinemaShortcuts();

  // 监听桥接脚本的预取结果（失败时禁止重试）
  state.prefetchDoneHandler = onPrefetchDone;
  window.addEventListener('__cinema_prefetch_done__', onPrefetchDone);

  // 关灯遮罩跟随播放器位置（窗口缩放/滚动时刷新）
  window.addEventListener('resize', updateLightsOut);
  window.addEventListener('scroll', updateLightsOut, true);

  // 跨标签页/跨设备进度同步（chrome.storage.onChanged，处理 local 与 sync 两个区域）
  state.progressSyncHandler = onProgressStorageChanged;
  chrome.storage.onChanged.addListener(state.progressSyncHandler);

  // 设置/收藏变更同步：弹窗 setEnabled / toggleBookmark 等后台写入即时生效。
  // 用存储最新值合并进内存 settings，本页后续 saveSettings 不会再把它"回退"掉。
  state.settingsSyncHandler = (changes, area) => {
    if (area !== 'sync') return;
    try {
      const cs = changes && changes.cinemaSettings;
      if (cs && cs.newValue && typeof cs.newValue === 'object') {
        if (typeof applyLoadedSettings === 'function') applyLoadedSettings(cs.newValue);
        else settings = Object.assign({}, settings, cs.newValue);
        if (typeof applySettings === 'function') applySettings();
        applyCinemaTheme();
        syncBridgeConfig();
      }
      if (changes && changes.cinemaBookmarks) {
        readBookmarks(() => {
          if (typeof updateBookmarkButton === 'function') updateBookmarkButton();
        });
      }
    } catch (e) { console.debug('[cinema] settings sync error:', e); }
  };
  chrome.storage.onChanged.addListener(state.settingsSyncHandler);

  state.initialized = true;
  log('影院模式就绪');

  // 显示成功状态
  const modeText = state.mode === 'season' ? '合集模式' : '分P模式';
  const countText = state.isMultiPart ? `${state.pages.length}集` : '单集';
  showStatusBadge(`影院模式已启用 · ${modeText} · ${countText}`, 'success');

  // 首次运行引导（仅多P视频，完成后写入 onboardingDone）
  if (!settings.onboardingDone && state.isMultiPart && typeof showOnboarding === 'function') {
    showOnboarding();
  }

  // 恢复播放进度（B11：多P与单集视频都恢复；单集只 seek 播放位置，不做分P跳转）
  await restoreProgress();
  // B2：进度恢复完成后若当前分P剩余 < 90 秒，尽早预取下一P（仅多P有意义）
  if (state.isMultiPart) {
    tryEarlyPreloadAfterRestore();
  }

  // 恢复显示模式（从整页刷新后恢复）
  const savedMode = sessionStorage.getItem('cinemaDisplayMode');
  if (savedMode && savedMode !== 'normal') {
    sessionStorage.removeItem('cinemaDisplayMode');
    log(`从 sessionStorage 恢复显示模式: ${savedMode}`);
    setTimeout(() => restoreDisplayMode(savedMode), 1000);
  }

  // 恢复播放器设置（倍速/音量/画质/弹幕）
  setTimeout(() => restorePlayerPrefs(), 1500);

  // 进度保存由 timeupdate（每 5 秒）与页面关闭前 beforeunload 负责，无需额外定时器

  // 页面关闭前保存进度
  window.addEventListener('beforeunload', saveProgress);
}

function cleanup() {
  if (state.transitionTimer) clearTimeout(state.transitionTimer);
  if (state.observer) state.observer.disconnect();
  if (state.observerTop) state.observerTop.disconnect();
  detachVideoListeners();

  // 移除全局监听
  window.removeEventListener('resize', updateLightsOut);
  window.removeEventListener('scroll', updateLightsOut, true);

  // 还原底栏原生展示与状态类
  document.body.classList.remove(
    'cinema-bottom-progress',
    'cinema-active',
    'cinema-multi-part',
    'cinema-hide-parts',
    'cinema-season-mode',
    'cinema-idle',
    'cinema-lights-out-active'
  );
  if (state.playerWrap) {
    state.playerWrap.classList.remove('cinema-lights-out-active', 'cinema-idle', 'cinema-active');
  }
  if (typeof stopAmbilightLoop === 'function') {
    stopAmbilightLoop();
  }
  if (typeof clearIdleTimer === 'function') {
    clearIdleTimer();
  }
  if (typeof onPanelEscape === 'function') {
    document.removeEventListener('keydown', onPanelEscape);
  }
  if (typeof restoreNativeBottomTime === 'function' && state.bottomTimeOverridden) {
    restoreNativeBottomTime();
  }
  state.bottomTimeOverridden = false;

  // 移除 UI 元素
  for (const key of Object.keys(ui)) {
    if (ui[key] && ui[key].remove) ui[key].remove();
    ui[key] = null;
  }

  state.initialized = false;
  state.switching = false;
  state.restoringProgress = false;
  state.video = null;
  state.playerWrap = null;
  state.bvid = '';
  state.cid = 0;
  state.aid = 0;
  state.title = '';
  state.pages = [];
  state.currentIndex = 0;
  state.totalDuration = 0;
  state.cumulative = [];
  state.isMultiPart = false;
  state.mode = 'pages';
  state.seasonId = 0;
  state.seasonTitle = '';
  state.seasonEpisodes = [];
  state.skips = [];
  state.skipMarkStart = null;
  state.preloadedCid = null;
  state.preloadFailCount = 0;
  state.onDemandPrefetch = null; // 悬停按需预取去重表：跨视频导航后失效，允许重新预取
  state.watchAccum = 0;
  state.lastWatchTick = 0;
  state.closeTipShown = false;
  state.seekDragging = false;
  state.ioOverride = null;
  if (state.p2pTempTimer) { clearTimeout(state.p2pTempTimer); state.p2pTempTimer = null; }
  state.fadeSnapshot = null;
  state.freezeArmed = false;
  state.prefetchOkCid = null;
  state.preloadFailTs = 0;
  state.preloading = false;
  if (state.prefetchCancelTimer) { clearTimeout(state.prefetchCancelTimer); state.prefetchCancelTimer = null; }
  if (state.skipKeyHandler) {
    document.removeEventListener('keydown', state.skipKeyHandler);
    state.skipKeyHandler = null;
  }
  teardownCinemaShortcuts();
  // 快捷键录制状态清理（录制监听器由 cinema-ui 注册/移除，这里兜底）
  state.shortcutCapturing = false;
  if (state.shortcutCaptureHandler) {
    document.removeEventListener('keydown', state.shortcutCaptureHandler);
    state.shortcutCaptureHandler = null;
  }
  state.related = [];
  state.nextWork = null;
  if (state.prefetchDoneHandler) {
    window.removeEventListener('__cinema_prefetch_done__', state.prefetchDoneHandler);
    state.prefetchDoneHandler = null;
  }
  if (state.progressSyncHandler) {
    chrome.storage.onChanged.removeListener(state.progressSyncHandler);
    state.progressSyncHandler = null;
  }
  if (state.settingsSyncHandler) {
    chrome.storage.onChanged.removeListener(state.settingsSyncHandler);
    state.settingsSyncHandler = null;
  }
  closeHistoryPanel();
  closeCloseTabTip();
  if (state.switchRecoveryPoll) { clearInterval(state.switchRecoveryPoll); state.switchRecoveryPoll = null; }
  pageDataPromise = null; // 允许下次重新注入
}

// ============================================================
//  启动
// ============================================================

// 等待页面稳定后初始化
if (document.readyState === 'complete') {
  setTimeout(init, 800);
} else {
  window.addEventListener('load', () => setTimeout(init, 800));
}
