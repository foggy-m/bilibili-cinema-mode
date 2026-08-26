/**
 * B站影院模式 - 核心模块
 * 配置、全局状态、工具函数、全部持久化（设置/进度/观影记录/播放偏好）
 *
 * 注意：本扩展通过 manifest content_scripts 注入多个 JS 文件，
 * 它们在同一隔离世界中共享全局作用域，按 manifest 顺序加载：
 *   cinema-core.js → cinema-player.js → cinema-ui.js → content.js
 */

'use strict';

// 防止重复注入（content script 仅由 manifest 注入一次，此为防御性标记）
window.__bilibiliCinemaMode = true;

// ============================================================
//  配置 & 状态
// ============================================================

const DEFAULT_SETTINGS = {
  enabled: true,
  autoCloseTab: false,  // 播放完毕自动关闭标签页
  lightsOut: false,     // 关灯模式（压暗播放器外区域，默认关；L 键运行时切换）
};

// 内化设置（禅：有选项 = 作者不确定什么是对的）。面板不再暴露，存储旧值被覆写。
const FORCED_SETTINGS = {
  autoPlayNext: true,    // 连播是核心价值，关掉等于不用影院模式
  seamlessMovie: true,   // 冻帧无缝切换是核心体验，无关闭理由
  seasonMovie: true,     // 合集合并成一部电影是核心能力
  preloadNext: true,     // 预取是无形速度，无关闭理由
  fastSwitch: true,      // 极致快速切换同属无形速度，无关闭理由
  progressSync: true,    // 跨标签页同步是隐形便利
};

const SHORTCUT_DEFAULTS = {
  nextPart: 'KeyN',
  prevPart: 'KeyP',
  toggleSettings: 'KeyS',
  toggleLights: 'KeyL',
  // I-2：seek 用 J/K 而非方向键 —— B站播放器原生也响应方向键 seek，
  // 扩展再全局监听方向键会造成"双重 seek"（一次按键跳 20 秒）
  seekBack: 'KeyJ',
  seekForward: 'KeyK',
};

const CINEMA_OPACITY = 0.85;       // 关灯压暗（原 lightsOutOpacity）
const CINEMA_P2P_TEMP_MS = 4000;   // 切P窗口临时 P2P 屏蔽时长（原 p2pTempMs）

let settings = { ...DEFAULT_SETTINGS };

const state = {
  bvid: '',
  cid: 0,
  aid: 0,
  title: '',
  pages: [],            // [{ page, cid, part, duration, vid, weblink }]
  currentIndex: 0,      // 0-based
  totalDuration: 0,
  cumulative: [],       // cumulative[i] = 前 i 个分P的总时长
  isMultiPart: false,
  initialized: false,
  switching: false,
  switchEpoch: 0, // 切换代际计数：cleanup 时自增，使切换中残留的 waitForVideoChange(Season) 轮询作废
  restoringProgress: false, // 正在恢复播放进度（阻止 onNavigate/onTimeUpdate 干扰）
  video: null,
  playerWrap: null,
  observer: null,
  observerTop: null,    // body 顶层观察器（监测播放器容器整体重建）
  // 合集/选集模式
  mode: 'pages',        // 'pages' | 'season'
  seasonId: 0,          // ugc_season.id
  seasonTitle: '',      // 合集名称
  seasonSections: [],        // [{ id, title, index, episodes: [{index,bvid,cid,aid,title,duration,id}] }]
  seasonSectionIndex: -1,    // 当前 bvid 所在子合集在 seasonSections 中的下标；-1 = 未命中
  seasonEpisodes: [],   // [{ index, bvid, cid, title, duration, id }]
  // 显示模式保持
  displayMode: 'normal', // 'normal' | 'wide' | 'web-fullscreen' | 'fullscreen'
  // 播放设置记忆（画质/倍速/音量/弹幕）
  pic: '',              // 视频封面图
  prefs: { rate: 1, volume: 1, quality: '', danmaku: true },
  prefsLoaded: false,
  restoringPrefs: false,
  prefsGuardUntil: 0,   // 恢复后保护期，避免恢复动作被误记录
  // 下一分P预加载（剩余 < 60 秒时预取视频流到浏览器缓存）
  preloadedCid: null,   // 已预取的分P cid（防重复预取）
  preloadFailCount: 0, // 预取连续失败计数（>= 3 时暂停重试）
  preloading: false,    // 预取进行中（防重入）
  preloadFailTs: 0,      // 最近一次预取失败的时间戳（失败计数 5 分钟衰减）
  prefetchCancelTimer: null, // 预取进行中兜底清除定时器（B1：done/取消事件未回传时 30s 兜底）
  prefetchOkCid: null,   // 最近一次预取成功的分P cid（决定切P过渡视觉下限，P1-4）
  p2pTempTimer: null,    // 切P窗口临时 P2P 屏蔽的恢复定时器（P2-7）
  fadeSnapshot: null,    // 音量淡出快照 { volume }（P0-1：只有真正淡出过才允许淡入）
  freezeArmed: false,    // 已在片尾提前钉住末帧（避免 timeupdate 反复 drawImage）
  prefetchUiHooked: false, // 预取UI事件是否已注册（防重复注册）
  // 观影统计（累计实际观看秒数）
  watchAccum: 0,        // 本次会话累计观看秒数
  lastWatchTick: 0,     // 上次 timeupdate 的视频时间
  // 播放完毕自动关闭标签页
  closeTipShown: false, // 本次会话是否已提示过
  closeTipTimer: null,  // 倒计时定时器
  // 进度条拖拽 seek
  seekDragging: false,
  // 跨标签页进度同步
  lastSavedProgressTs: 0,   // 本次会话最近一次保存进度的 ts（用于忽略自己的写入）
  progressSyncHandler: null, // chrome.storage.onChanged 监听器
  settingsSyncHandler: null, // chrome.storage.onChanged 监听器（弹窗 setEnabled/收藏等写入即时生效）
  shortcutHandler: null,     // 全局快捷键 keydown 监听器（A5）
  // 切P失败恢复卡的晚到成功看护轮询
  switchRecoveryPoll: null, // 定时器 id（armSwitchRecoveryWatch 设置，hideSwitchRecovery/新切换清除）
  // 底栏时间接管标记（仅在接管后需要还原时才执行，避免单P视频被误修改）
  bottomTimeOverridden: false,
};

// ============================================================
//  工具函数（纯函数见 cinema-utils.js，与模块共享全局作用域）
// ============================================================

function getBvid() {
  const m = location.pathname.match(/\/video\/(BV[\w]+)/);
  return m ? m[1] : '';
}

function getCurrentPage() {
  const params = new URLSearchParams(location.search);
  return parseInt(params.get('p') || '1', 10);
}

function log(...args) {
  console.log('%c[影院模式]', 'color:#00a1d6;font-weight:bold', ...args);
}

/** 进度/观影记录共用的存储 key（合集用当前子合集 key，分P用 bvid） */
function getProgressKey() {
  return state.mode === 'season'
    ? buildSectionProgressKey(state.seasonId, state.seasonSections[state.seasonSectionIndex])
    : state.bvid;
}

// ============================================================
//  设置持久化（chrome.storage.sync，跨设备同步；首次从 local 迁移）
// ============================================================

/**
 * 将已保存的设置合并进当前 settings（I-2）：
 *  - 布尔键一律 Boolean() 强转，杜绝 "false"/0 等被当 truthy 的真值陷阱
 *  - 末尾由 FORCED_SETTINGS 覆写内化键：存储旧值一律忽略（禅：有选项 = 作者不确定什么是对的）
 */
function applyLoadedSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...stored };

  // 布尔消毒（I-3）：导入/弹窗/跨标签页同步等外部数据一律经 applyLoadedSettings 进入，坏值不可落盘
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') merged[key] = Boolean(merged[key]);
  }

  // 内化键：作者拍板的值，无视存储旧值
  Object.assign(merged, FORCED_SETTINGS);

  settings = merged;
}

function loadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get('cinemaSettings', (result) => {
        if (result && result.cinemaSettings) {
          applyLoadedSettings(result.cinemaSettings);
          resolve();
          return;
        }
        // 旧版本存在 local 中：迁移到 sync
        try {
          chrome.storage.local.get('cinemaSettings', (r2) => {
            if (r2 && r2.cinemaSettings) {
              applyLoadedSettings(r2.cinemaSettings);
              try {
                chrome.storage.sync.set({ cinemaSettings: settings });
                chrome.storage.local.remove('cinemaSettings');
              } catch { /* ignore */ }
            }
            resolve();
          });
        } catch {
          resolve();
        }
      });
    } catch {
      resolve();
    }
  });
}

function saveSettings() {
  try {
    chrome.storage.sync.set({ cinemaSettings: settings });
    // 设置变更时同步应用主题（面板切换主题即时生效；applyCinemaTheme 幂等）
    applyCinemaTheme();
  } catch { /* ignore */ }
}

/** 向 MAIN world 的 player-bridge.js 同步配置（fastSwitch 开关、当前播放 cid）。
 * 常驻 p2pBlock 键已删除，__cinema_config__ 不再携带 p2pBlock 字段；
 * 切P窗口的临时 P2P 屏蔽由 applyTempP2PBlock 自收自发（见 cinema-player.js） */
function syncBridgeConfig() {
  try {
    const curCid = (state.pages[state.currentIndex] && state.pages[state.currentIndex].cid) || state.cid || 0;
    window.dispatchEvent(new CustomEvent('__cinema_config__', {
      detail: JSON.stringify({ fastSwitch: FORCED_SETTINGS.fastSwitch, currentCid: curCid })
    }));
  } catch { /* ignore */ }
}

// ============================================================
//  主题（影院模式 UI 配色）
// ============================================================

let themeMediaQuery = null; // auto 模式下的系统主题 matchMedia 监听（只注册一次，防堆叠）

/**
 * 应用影院模式主题（theme 键已删，永远跟随系统 prefers-color-scheme）：
 *  - documentElement 写 data-cinema-theme 属性 + body 加 cinema-theme-dark/light class
 *  - 注册一次 matchMedia 监听，系统主题变化时实时切换
 */
function applyCinemaTheme() {
  try {
    // 复用已注册的 matchMedia（避免每次调用新建 MediaQueryList）；首次调用时注册系统主题监听
    if (window.matchMedia && !themeMediaQuery) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      themeMediaQuery = mq;
      const onChange = () => applyCinemaTheme();
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange); // 旧浏览器兼容
    }
    const dark = !!(themeMediaQuery && themeMediaQuery.matches);
    const effective = dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-cinema-theme', effective);
    if (document.body) {
      document.body.classList.toggle('cinema-theme-dark', effective === 'dark');
      document.body.classList.toggle('cinema-theme-light', effective === 'light');
    }
  } catch { /* ignore */ }
}

// ============================================================
//  播放进度持久化
// ============================================================

function saveProgress() {
  if (!state.bvid || !state.video) return;
  const data = {
    part: state.currentIndex + 1,
    time: state.video.currentTime || 0,
    ts: Date.now(),
    mode: state.mode,
    bvid: state.bvid,
  };
  const progressKey = getProgressKey();
  state.lastSavedProgressTs = data.ts; // 记录本次写入 ts，供跨标签页同步忽略自身写入
  try {
    chrome.storage.local.get('cinemaProgress', (result) => {
      const all = (result && result.cinemaProgress) || {};
      all[progressKey] = data;
      chrome.storage.local.set({ cinemaProgress: all }, () => {
        updateWatchHistory(progressKey, data);
      });
    });
  } catch { /* ignore */ }
}

/** 观影记录容量上限（超出时按最后观看时间淘汰最旧的） */
const HISTORY_LIMIT = 100;

/** 观影记录（popup「最近放映」展示数据，进度保存时同步更新）
 * watched 字段：累计实际观看秒数（每次保存时把 watchAccum 并入并清零）
 *
 * 存储：chrome.storage.sync 分块（cinemaHistory_c0..n，每块 ≤15 条，防超单项 8KB 配额）
 * + cinemaHistoryMeta = { chunks: n }；写入走 10 秒防抖 scheduleHistoryWrite。
 */
function updateWatchHistory(progressKey, data) {
  try {
    readAllHistory((hist) => {
      const prev = hist[progressKey] || {};
      hist[progressKey] = {
        bvid: state.bvid,
        title: state.title || state.bvid,
        pic: state.pic || '',
        part: data.part,
        totalParts: state.pages.length,
        time: data.time,
        totalDuration: state.totalDuration || 0,
        mode: state.mode,
        ts: Date.now(),
        watched: (prev.watched || 0) + (state.watchAccum || 0),
      };
      state.watchAccum = 0; // 并入后清零，下次重新累计
      // 容量限制：只保留最近 HISTORY_LIMIT 条（语义与原有实现一致）
      const keys = Object.keys(hist);
      if (keys.length > HISTORY_LIMIT) {
        keys.sort((a, b) => (hist[a].ts || 0) - (hist[b].ts || 0));
        for (let i = 0; i < keys.length - HISTORY_LIMIT; i++) {
          delete hist[keys[i]];
        }
      }
      scheduleHistoryWrite(hist);
    });
  } catch (err) { console.debug('[cinema] updateWatchHistory error:', err); }
}

let historyWriteTimer = null; // 观影记录防抖写定时器（模块级共用）
let historyWriteGen = 0;      // 防抖写代际计数：导入/清除定时器等直接写路径会自增，
                              // 挂起的旧防抖任务过期后跳过，避免用旧快照覆盖导入结果

/**
 * 读取全部观影记录，回调参数为合并后的 { progressKey: record }
 * sync 分块为空且 local 存在旧 cinemaHistory blob 时：用 local 数据回调，
 * 并异步迁移（立即写一次 sync 分块 + 移除 local）
 */
function readAllHistory(cb) {
  if (typeof cb !== 'function') cb = function () {};
  try {
    chrome.storage.sync.get(null, (all) => {
      const hist = {};
      try {
        if (all && typeof all === 'object') {
          for (const key of Object.keys(all)) {
            if (/^cinemaHistory_c\d+$/.test(key) && all[key] && typeof all[key] === 'object') {
              Object.assign(hist, all[key]);
            }
          }
        }
      } catch (e) { console.debug('[cinema] readAllHistory merge error:', e); }

      if (Object.keys(hist).length > 0) {
        cb(hist);
        return;
      }
      // sync 为空：回退 local 旧 blob 并异步迁移
      try {
        chrome.storage.local.get('cinemaHistory', (r2) => {
          const old = (r2 && r2.cinemaHistory) || {};
          if (old && typeof old === 'object' && Object.keys(old).length > 0) {
            cb(old);
            try {
              writeAllHistory(old);
              chrome.storage.local.remove('cinemaHistory');
            } catch (e) { console.debug('[cinema] history migration error:', e); }
            return;
          }
          cb(hist);
        });
      } catch (e) {
        console.debug('[cinema] readAllHistory local error:', e);
        cb(hist);
      }
    });
  } catch (err) {
    console.debug('[cinema] readAllHistory error:', err);
    cb({});
  }
}

/**
 * 全量写入观影记录：entries 按 record.ts 降序、截断至 HISTORY_LIMIT 条，
 * 每 15 条一块，组装 cinemaHistory_c0..n + cinemaHistoryMeta:{chunks:n} 写入 sync；
 * 随后读取旧 meta.chunks，若旧块数大于新块数则移除多余的旧块。
 * 可选回调 cb 在写入完成后调用（供 UI 立即写操作后刷新）。
 */
function writeAllHistory(hist, cb) {
  try {
    const entries = Object.entries(hist || {})
      .sort((a, b) => ((b[1] && b[1].ts) || 0) - ((a[1] && a[1].ts) || 0))
      .slice(0, HISTORY_LIMIT);

    const data = {};
    const newChunks = Math.ceil(entries.length / 15);
    for (let i = 0; i < newChunks; i++) {
      const chunk = {};
      const start = i * 15;
      for (let j = start; j < Math.min(start + 15, entries.length); j++) {
        chunk[entries[j][0]] = entries[j][1];
      }
      data['cinemaHistory_c' + i] = chunk;
    }
    data.cinemaHistoryMeta = { chunks: newChunks };

    // 先读旧 meta（在覆盖前捕获旧块数），用于清理多余的旧块
    chrome.storage.sync.get('cinemaHistoryMeta', (res) => {
      const oldChunks = (res && res.cinemaHistoryMeta && typeof res.cinemaHistoryMeta.chunks === 'number')
        ? res.cinemaHistoryMeta.chunks
        : 0;
      try {
        chrome.storage.sync.set(data, () => {
          try {
            if (oldChunks > newChunks) {
              const removeKeys = [];
              for (let i = newChunks; i < oldChunks; i++) removeKeys.push('cinemaHistory_c' + i);
              chrome.storage.sync.remove(removeKeys);
            }
          } catch (e) { console.debug('[cinema] writeAllHistory cleanup error:', e); }
          if (typeof cb === 'function') cb();
        });
      } catch (e) { console.debug('[cinema] writeAllHistory set error:', e); }
    });
  } catch (err) { console.debug('[cinema] writeAllHistory error:', err); }
}

/** 防抖写观影记录（10 秒，共用模块级定时器），供高频 updateWatchHistory 使用 */
function scheduleHistoryWrite(hist) {
  try {
    clearTimeout(historyWriteTimer);
    historyWriteGen++;
    const gen = historyWriteGen;
    historyWriteTimer = setTimeout(() => {
      historyWriteTimer = null;
      // 代际校验：期间若有导入等直接写路径自增了 gen，本次防抖写作废（防止旧快照覆盖导入结果）
      if (gen !== historyWriteGen) return;
      writeAllHistory(hist);
    }, 10000);
  } catch (err) { console.debug('[cinema] scheduleHistoryWrite error:', err); }
}

function loadProgress(bvid) {
  return new Promise((resolve) => {
    try {
      const progressKey = state.mode === 'season'
        ? buildSectionProgressKey(state.seasonId, state.seasonSections[state.seasonSectionIndex])
        : bvid;
      chrome.storage.local.get('cinemaProgress', (result) => {
        const all = (result && result.cinemaProgress) || {};
        resolve(all[progressKey] || null);
      });
    } catch {
      resolve(null);
    }
  });
}

// ============================================================
//  跨标签页进度同步（chrome.storage.onChanged）
// ============================================================

/** 其他标签页保存进度时，同步本页进度（保守规则，避免双开互相拉扯） */
function onProgressStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (!settings.enabled || !FORCED_SETTINGS.progressSync) return;
  if (state.switching || state.seekDragging) return;
  const change = changes && changes.cinemaProgress;
  if (!change || !change.newValue) return;
  const key = getProgressKey();
  const data = change.newValue[key];
  if (!data || typeof data.part !== 'number' || typeof data.time !== 'number') return;
  // 忽略自己刚写入的进度（共用同一 ts 已记录）
  if (data.ts <= (state.lastSavedProgressTs || 0)) return;
  const video = state.video;
  if (!video) return;
  const targetIndex = data.part - 1;
  if (targetIndex < 0 || targetIndex >= state.pages.length) return;
  const targetOverall = (state.cumulative[targetIndex] || 0) + data.time;
  const curOverall = (state.cumulative[state.currentIndex] || 0) + video.currentTime;
  const gap = targetOverall - curOverall;
  // 正在播放且差距不大时不同步，避免两个标签页互相拉扯
  if (!video.paused && Math.abs(gap) < 120) return;
  if (Math.abs(gap) < 10) return;
  // 跨标签同步只对齐"同一集"的播放位置，绝不跨集跳转：
  // 合集所有分集共用一个 section 级进度键，多开标签页各自写入不同的 part，
  // 若目标集不同仍跳转，标签页会无限互相把对方拽到自己正在看的那集（切片合集双开即复现）。
  // pages 模式（同 bvid 多P 双开）同样存在该互拽风险，故两种模式统一处理。
  if (targetIndex !== state.currentIndex) return;
  log(`同步其他标签页进度: 第${data.part}集 ${formatTime(data.time)}`);
  // 跨标签页同步只走 console 日志：状态徽章已收敛为纯 error toast，info/success 调用点全部删除
  video.currentTime = data.time;
}

// ============================================================
//  播放偏好持久化（画质/倍速/音量/弹幕）
// ============================================================

function loadPlayerPrefs() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('cinemaPrefs', (result) => {
        if (result && result.cinemaPrefs) {
          state.prefs = { rate: 1, volume: 1, quality: '', danmaku: true, ...result.cinemaPrefs };
          // 存量数据清洗：旧版本曾把静音状态折算为 volume=0 落盘（"莫名其妙静音"根因），
          // 新逻辑不再产生 0（muted 时不记录）；读到 0 视为污染，重置为 1 并回写落盘
          if (state.prefs.volume === 0) {
            state.prefs.volume = 1;
            savePlayerPrefs();
          }
        }
        state.prefsLoaded = true;
        resolve();
      });
    } catch {
      state.prefsLoaded = true;
      resolve();
    }
  });
}

function savePlayerPrefs() {
  try {
    chrome.storage.local.set({ cinemaPrefs: state.prefs });
  } catch { /* ignore */ }
}

// ============================================================
//  收藏（C16：按 bvid 收藏视频，sync 持久化，数组最新在前，容量 50）
// ============================================================

const BOOKMARK_LIMIT = 50;

let bookmarksCache = []; // 内存缓存：readBookmarks 回填，isBookmarked/toggleBookmark 同步使用

/** 读取收藏列表（sync 的 cinemaBookmarks），回调参数为数组（自动消毒） */
function readBookmarks(cb) {
  if (typeof cb !== 'function') cb = function () {};
  try {
    chrome.storage.sync.get('cinemaBookmarks', (res) => {
      let list = (res && res.cinemaBookmarks) || [];
      if (!Array.isArray(list)) list = [];
      bookmarksCache = list;
      cb(list);
    });
  } catch (e) {
    console.debug('[cinema] readBookmarks error:', e);
    cb([]);
  }
}

/** 写入收藏列表：消毒（仅对象条目、按 bvid 去重）+ 容量截断（最新在前，超限丢最旧），完成后回调 */
function writeBookmarks(list, cb) {
  try {
    const arr = Array.isArray(list) ? list.slice() : [];
    const seen = {};
    const clean = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object' || !it.bvid) continue;
      if (seen[it.bvid]) continue;
      seen[it.bvid] = true;
      clean.push(it);
    }
    while (clean.length > BOOKMARK_LIMIT) clean.pop();
    bookmarksCache = clean;
    chrome.storage.sync.set({ cinemaBookmarks: clean }, () => {
      if (typeof cb === 'function') cb();
    });
  } catch (e) { console.debug('[cinema] writeBookmarks error:', e); }
}

/** 当前视频是否已收藏（基于内存缓存，同步查询；首次使用前建议先 readBookmarks） */
function isBookmarked(bvid) {
  return bookmarksCache.some((b) => b && b.bvid === bvid);
}

/**
 * 切换收藏状态（meta: { bvid, title, pic }）：读改写持久化，返回 Promise<boolean>，
 * resolve 值为切换后的真实状态（UI 应 await/then 后再更新按钮/星标，勿立即重读缓存）。
 */
function toggleBookmark(meta) {
  const bvid = meta && meta.bvid;
  if (!bvid) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      readBookmarks((list) => {
        try {
          const idx = list.findIndex((b) => b && b.bvid === bvid);
          let nowBookmarked;
          if (idx !== -1) {
            list.splice(idx, 1);
            nowBookmarked = false;
          } else {
            list.unshift({
              bvid: bvid,
              title: (meta.title || ''),
              pic: (meta.pic || ''),
              ts: Date.now(),
            });
            nowBookmarked = true;
          }
          writeBookmarks(list); // 内部同步刷新 bookmarksCache 并持久化
          resolve(nowBookmarked);
        } catch (e) { resolve(isBookmarked(bvid)); }
      });
    } catch (e) { resolve(isBookmarked(bvid)); }
  });
}
