/**
 * B站影院模式 - 核心模块
 * 配置、全局状态、工具函数、全部持久化（设置/进度/观影记录/跳过片段/播放偏好）
 *
 * 注意：本扩展通过 manifest content_scripts 注入多个 JS 文件，
 * 它们在同一隔离世界中共享全局作用域，按 manifest 顺序加载：
 *   cinema-core.js → cinema-player.js → cinema-skips.js → cinema-ui.js → content.js
 */

'use strict';

// 防止重复注入（content script 仅由 manifest 注入一次，此为防御性标记）
window.__bilibiliCinemaMode = true;

// ============================================================
//  配置 & 状态
// ============================================================

const DEFAULT_SETTINGS = {
  enabled: true,
  autoPlayNext: true,
  hidePartUI: true,
  skipIntro: false,          // v1.7.3 起默认关：默认剪片头对短视频/分段电影是无声的内容丢失，改为按需开启
  skipOutro: false,          // v1.7.3 起默认关：同上（片尾提前切换会剪掉每段结尾内容）
  introDuration: 5,   // 秒（全局默认）
  outroDuration: 5,   // 秒（全局默认）
  showTransition: true,
  seamlessMovie: true,       // 无缝电影：切P用冻帧盖住、不插幕间卡，观感上连成一部片
  showSettingsBtn: true,
  showStatusBadge: true,   // 显示状态徽章（右下角，常驻不自动隐藏；点击查看观影记录）
  enableSkips: true,    // 启用跳过指定片段
  preloadNext: true,    // 预取下一分P视频流（切换更快）
  fastSwitch: true,     // 极致快速切换：缓存 playurl 响应并在切换时本地秒回（进一步减少黑屏）
  showPrefetchStatus: true,  // 显示"下一集已预取"就绪指示
  p2pBlock: false,           // 屏蔽 B站 P2P 混流：删 SDK 全局 + 定期重删 __DASH_P2P_TYPE__ 强制走纯 CDN（切下一P后生效，刷新更彻底；激进项，默认关）
  p2pTempMs: 4000,           // 切P关键窗口临时屏蔽 P2P 的时长（毫秒），钳制 1000–10000；窗口期保证预取字节命中 byteStore
  autoCloseTab: false,  // 播放完毕自动关闭标签页
  progressStyle: 'classic', // 统一进度条样式：classic | flow | minimal | neon | film
  lightsOut: false,         // 关灯模式（压暗播放器外区域，默认关）
  lightsOutOpacity: 0.85,   // 关灯压暗程度（0.5 - 0.95）
  theme: 'auto',            // 影院模式 UI 主题：auto | dark | light（auto 跟随系统深色模式）
  excludedBvids: [],        // 被排除的视频 bvid 列表（B12：这些视频不启用影院模式）
  progressSync: true,       // 跨标签页同步进度
  deviceSync: true,         // 跨设备同步进度（dual-write 到 chrome.storage.sync 的 cinemaProgressSync）
  onboardingDone: false,    // 首次运行引导是否已完成
  shortcuts: {              // 全局快捷键（B8 提供可配置 UI，这里按对象存储）
    nextPart: 'KeyN',
    prevPart: 'KeyP',
    toggleSettings: 'KeyS',
    toggleHistory: 'KeyH',
    toggleLights: 'KeyL',
    // I-2：seek 用 J/K 而非方向键 —— B站播放器原生也响应方向键 seek，
    // 扩展再全局监听方向键会造成"双重 seek"（一次按键跳 20 秒）
    seekBack: 'KeyJ',
    seekForward: 'KeyK',
  },
};

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
  restoringProgress: false, // 正在恢复播放进度（阻止 onNavigate/onTimeUpdate 干扰）
  video: null,
  playerWrap: null,
  observer: null,
  observerTop: null,    // body 顶层观察器（监测播放器容器整体重建）
  transitionTimer: null,
  // 合集/选集模式
  mode: 'pages',        // 'pages' | 'season'
  seasonId: 0,          // ugc_season.id
  seasonTitle: '',      // 合集名称
  seasonEpisodes: [],   // [{ index, bvid, cid, title, duration, id }]
  // 显示模式保持
  displayMode: 'normal', // 'normal' | 'wide' | 'web-fullscreen' | 'fullscreen'
  // 播放设置记忆（画质/倍速/音量/弹幕）
  pic: '',              // 视频封面图
  prefs: { rate: 1, volume: 1, quality: '', danmaku: true },
  prefsLoaded: false,
  restoringPrefs: false,
  prefsGuardUntil: 0,   // 恢复后保护期，避免恢复动作被误记录
  // 跳过指定片段（按 bvid 存储，电影总时间线）
  skips: [],            // [{ start, end, ts }]
  skipMarkStart: null,
  skipGuardTime: 0,
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
  shortcutCapturing: false,  // 快捷键录制进行中（可配置快捷键 UI 用；录制期间不响应全局快捷键）
  shortcutCaptureHandler: null, // 快捷键录制 keydown 监听器（录制结束由 cancelShortcutCapture 移除）
  // 切P失败恢复卡的晚到成功看护轮询
  switchRecoveryPoll: null, // 定时器 id（armSwitchRecoveryWatch 设置，hideSwitchRecovery/新切换清除）
  // 按视频的片头/片尾时长覆盖
  ioOverride: null,     // { intro?, outro? } | null
  // 底栏时间接管标记（仅在接管后需要还原时才执行，避免单P视频被误修改）
  bottomTimeOverridden: false,
  // 播完下一部（C16）：候选视频
  related: [],          // 相关推荐列表 [{ bvid, title, pic }]
  nextWork: null,       // 播完下一部候选 { bvid, title, pic } | null
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

/** 进度/观影记录/片头片尾覆盖共用的存储 key（合集用 seasonId，分P用 bvid） */
function getProgressKey() {
  return state.mode === 'season' ? `season_${state.seasonId}` : state.bvid;
}

// ============================================================
//  设置持久化（chrome.storage.sync，跨设备同步；首次从 local 迁移）
// ============================================================

/**
 * 将已保存的设置合并进当前 settings（I-2）：
 *  - shortcuts 深度合并：缺失的键用新默认值兜底（旧存档没有 J/K 也能拿到新默认，
 *    同时保留用户自定义的键，不整体覆盖）
 *  - 迁移遗留的方向键 seek：ArrowLeft/ArrowRight 与 B站原生方向键 seek 冲突
 *    会双重 seek，自动替换为 KeyJ/KeyK
 */
function applyLoadedSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // B12：排除列表必须为数组（旧存档/手改数据可能是垃圾值，一律归 []）
  if (!Array.isArray(merged.excludedBvids)) merged.excludedBvids = [];
  const savedSc = (stored && stored.shortcuts && typeof stored.shortcuts === 'object')
    ? { ...stored.shortcuts }
    : {};
  if (savedSc.seekBack === 'ArrowLeft') savedSc.seekBack = 'KeyJ';
  if (savedSc.seekForward === 'ArrowRight') savedSc.seekForward = 'KeyK';
  merged.shortcuts = { ...DEFAULT_SETTINGS.shortcuts, ...savedSc };
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

/** 向 MAIN world 的 player-bridge.js 同步配置（fastSwitch 开关、当前播放 cid） */
function syncBridgeConfig() {
  try {
    const curCid = (state.pages[state.currentIndex] && state.pages[state.currentIndex].cid) || state.cid || 0;
    window.dispatchEvent(new CustomEvent('__cinema_config__', {
      detail: JSON.stringify({ fastSwitch: settings.fastSwitch, p2pBlock: settings.p2pBlock, currentCid: curCid })
    }));
  } catch { /* ignore */ }
}

// ============================================================
//  主题（影院模式 UI 配色）
// ============================================================

let themeMediaQuery = null; // auto 模式下的系统主题 matchMedia 监听（只注册一次，防堆叠）

/**
 * 应用影院模式主题：
 *  - 解析有效主题：dark / light 直接取用，auto（或未知值）跟随系统 prefers-color-scheme
 *  - documentElement 写 data-cinema-theme 属性 + body 加 cinema-theme-dark/light class
 *  - auto 模式下注册一次 matchMedia 监听，系统主题变化时实时切换
 */
function applyCinemaTheme() {
  try {
    const pref = settings.theme || 'auto';
    const dark = pref === 'dark'
      || (pref !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const effective = dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-cinema-theme', effective);
    if (document.body) {
      document.body.classList.toggle('cinema-theme-dark', effective === 'dark');
      document.body.classList.toggle('cinema-theme-light', effective === 'light');
    }
    if (pref === 'auto' && window.matchMedia && !themeMediaQuery) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      themeMediaQuery = mq;
      const onChange = () => { if ((settings.theme || 'auto') === 'auto') applyCinemaTheme(); };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange); // 旧浏览器兼容
    }
  } catch { /* ignore */ }
}

// ============================================================
//  排除模式（B12：按视频 bvid 排除影院模式）
// ============================================================

/** 判断任意 bvid 是否在排除列表中（供导航守卫 / 门禁复用） */
function isBvidExcluded(bvid) {
  return Array.isArray(settings.excludedBvids) && settings.excludedBvids.includes(bvid);
}

/** 当前视频是否被排除影院模式 */
function isCurrentVideoExcluded() {
  return isBvidExcluded(state.bvid);
}

/** 切换当前视频的排除状态，返回切换后的新状态（true=已排除）。列表上限 200 条，超出丢弃最旧 */
function toggleCurrentVideoExcluded() {
  if (!state.bvid) return false;
  let list = Array.isArray(settings.excludedBvids) ? settings.excludedBvids.slice() : [];
  const idx = list.indexOf(state.bvid);
  let nowExcluded;
  if (idx !== -1) {
    list.splice(idx, 1);
    nowExcluded = false;
  } else {
    list.push(state.bvid);
    nowExcluded = true;
    if (list.length > 200) list.splice(0, list.length - 200); // 容量上限：丢弃最旧（头部）
  }
  settings.excludedBvids = list;
  saveSettings();
  return nowExcluded;
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
  state.lastSavedProgressTs = data.ts; // 记录本次写入 ts，供跨标签页/跨设备同步忽略自身写入
  try {
    chrome.storage.local.get('cinemaProgress', (result) => {
      const all = (result && result.cinemaProgress) || {};
      all[progressKey] = data;
      chrome.storage.local.set({ cinemaProgress: all }, () => {
        updateWatchHistory(progressKey, data);
      });
    });
  } catch { /* ignore */ }

  // 跨设备同步（A3）：deviceSync 开启时 dual-write 到 sync，本地与跨设备共用同一 ts，便于忽略自身写入
  if (settings.deviceSync) {
    writeSyncProgress(data);
  }
}

/** 跨设备进度同步容量上限（条数，按 ts 最新保留） */
const SYNC_PROGRESS_LIMIT = 40;
/** 写入/配额错误时收紧到 20 条再重试一次 */
const SYNC_PROGRESS_LIMIT_HARD = 20;

/** 按 ts 最新保留前 limit 条，且每条只保留最小字段 { part, time, ts, mode, bvid } */
function pruneSyncProgress(all, limit) {
  const entries = Object.entries(all || {})
    .filter(([, v]) => v && typeof v === 'object')
    .sort((a, b) => ((b[1].ts) || 0) - ((a[1].ts) || 0));
  const kept = {};
  for (let i = 0; i < Math.min(entries.length, limit); i++) {
    const v = entries[i][1];
    kept[entries[i][0]] = {
      part: v.part,
      time: v.time,
      ts: v.ts,
      mode: v.mode,
      bvid: v.bvid,
    };
  }
  return kept;
}

/** 写入超限/异常时把容量收紧到 20 再静默重试一次 */
function retryPrunedSync(current) {
  try {
    chrome.storage.sync.set({ cinemaProgressSync: pruneSyncProgress(current, SYNC_PROGRESS_LIMIT_HARD) }, () => {});
  } catch { /* ignore */ }
}

/** 跨设备进度 dual-write（chrome.storage.sync 单 key 对象 map；QUOTA 时收紧重试一次） */
function writeSyncProgress(data) {
  try {
    chrome.storage.sync.get('cinemaProgressSync', (result) => {
      try {
        const all = (result && result.cinemaProgressSync) || {};
        all[getProgressKey()] = {
          part: data.part,
          time: data.time,
          ts: data.ts,
          mode: data.mode,
          bvid: data.bvid,
        };
        const pruned = pruneSyncProgress(all, SYNC_PROGRESS_LIMIT);
        try {
          chrome.storage.sync.set({ cinemaProgressSync: pruned }, () => {
            if (chrome.runtime && chrome.runtime.lastError) {
              retryPrunedSync(pruned);
            }
          });
        } catch {
          retryPrunedSync(pruned);
        }
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

/** 观影记录容量上限（超出时按最后观看时间淘汰最旧的） */
const HISTORY_LIMIT = 100;

/** 观影记录（历史面板数据，进度保存时同步更新）
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
      const progressKey = state.mode === 'season' ? `season_${state.seasonId}` : bvid;
      let localData = null;
      let syncData = null;
      let localDone = false;
      let syncDone = false;
      // I-1：必须等 local 与 sync 两侧都返回后再合并 —— 只在一侧有时用那侧，
      // 两侧都有时取 ts 更新的一条。先到先得会让旧侧数据覆盖新侧，导致跨设备进度回退。
      // 任一侧读取抛错按"该侧缺失"处理，绝不提前 resolve。
      const finish = () => {
        if (!localDone || !syncDone) return;
        if (localData && !syncData) resolve(localData);
        else if (syncData && !localData) resolve(syncData);
        else if (localData && syncData) resolve(localData.ts >= syncData.ts ? localData : syncData);
        else resolve(null);
      };
      try {
        chrome.storage.local.get('cinemaProgress', (result) => {
          const all = (result && result.cinemaProgress) || {};
          localData = all[progressKey] || null;
          localDone = true;
          finish();
        });
      } catch {
        localDone = true;
        finish();
      }
      try {
        chrome.storage.sync.get('cinemaProgressSync', (result) => {
          const all = (result && result.cinemaProgressSync) || {};
          syncData = all[progressKey] || null;
          syncDone = true;
          finish();
        });
      } catch {
        syncDone = true;
        finish();
      }
    } catch {
      resolve(null);
    }
  });
}

// ============================================================
//  跨标签页进度同步（chrome.storage.onChanged）
// ============================================================

/** 其他标签页/设备保存进度时，同步本页进度（保守规则，避免双开互相拉扯） */
function onProgressStorageChanged(changes, area) {
  if (area !== 'local' && area !== 'sync') return;
  if (!settings.enabled || !settings.progressSync) return;
  if (state.switching || state.seekDragging) return;
  // 跨设备同步事件仅当 deviceSync 开启时处理
  if (area === 'sync' && !settings.deviceSync) return;
  const change = area === 'local'
    ? (changes && changes.cinemaProgress)
    : (changes && changes.cinemaProgressSync);
  if (!change || !change.newValue) return;
  const key = getProgressKey();
  const data = change.newValue[key];
  if (!data || typeof data.part !== 'number' || typeof data.time !== 'number') return;
  // 忽略自己刚写入的进度（本地与跨设备写入共用同一 ts 已记录）
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
  const src = area === 'sync' ? '设备' : '标签页';
  log(`同步其他${src}进度: 第${data.part}集 ${formatTime(data.time)}`);
  showStatusBadge(`已同步其他${src}的进度`, 'info');
  if (targetIndex === state.currentIndex) {
    video.currentTime = data.time;
  } else {
    jumpToPart(targetIndex, data.time);
  }
}

// ============================================================
//  片头/片尾时长按视频独立配置（覆盖全局默认）
// ============================================================

function loadIntroOutro() {
  return new Promise((resolve) => {
    try {
      const key = getProgressKey();
      chrome.storage.local.get('cinemaIntroOutro', (result) => {
        const all = (result && result.cinemaIntroOutro) || {};
        state.ioOverride = all[key] || null;
        resolve();
      });
    } catch {
      state.ioOverride = null;
      resolve();
    }
  });
}

function saveIntroOutro() {
  try {
    const key = getProgressKey();
    chrome.storage.local.get('cinemaIntroOutro', (result) => {
      const all = (result && result.cinemaIntroOutro) || {};
      if (state.ioOverride && Object.keys(state.ioOverride).length > 0) {
        all[key] = state.ioOverride;
      } else {
        delete all[key];
      }
      chrome.storage.local.set({ cinemaIntroOutro: all });
    });
  } catch { /* ignore */ }
}

function getIntroDuration() {
  if (state.ioOverride && typeof state.ioOverride.intro === 'number') return state.ioOverride.intro;
  return settings.introDuration;
}

function getOutroDuration() {
  if (state.ioOverride && typeof state.ioOverride.outro === 'number') return state.ioOverride.outro;
  return settings.outroDuration;
}

// ============================================================
//  跳过片段持久化（chrome.storage.sync，每视频一个 key cinemaSkip_<progressKey>，
//  旧版本 local 单个 blob cinemaSkips 存在时回退并异步迁移）
// ============================================================

function loadSkips() {
  return new Promise((resolve) => {
    try {
      const key = 'cinemaSkip_' + getProgressKey();
      chrome.storage.sync.get(key, (result) => {
        try {
          const arr = result && result[key];
          if (Array.isArray(arr)) {
            state.skips = arr.filter((s) => s && s.end > s.start);
            resolve();
            return;
          }
        } catch (e) { console.debug('[cinema] loadSkips sync error:', e); }
        // sync 无数据：回退 local 旧 blob，存在时异步迁移
        try {
          chrome.storage.local.get('cinemaSkips', (r2) => {
            try {
              const all = (r2 && r2.cinemaSkips) || {};
              const oldArr = all[getProgressKey()] || all[state.bvid] || [];
              state.skips = (Array.isArray(oldArr) ? oldArr : []).filter((s) => s && s.end > s.start);
              if (all && typeof all === 'object' && Object.keys(all).length > 0) {
                migrateOldSkips(all);
              }
            } catch (e) { console.debug('[cinema] loadSkips local error:', e); }
            resolve();
          });
        } catch (e) {
          console.debug('[cinema] loadSkips local error:', e);
          state.skips = [];
          resolve();
        }
      });
    } catch (err) {
      console.debug('[cinema] loadSkips error:', err);
      state.skips = [];
      resolve();
    }
  });
}

function saveSkips() {
  try {
    // 写入前体积限制：超过约 7500 字符则循环丢弃最旧条目（shift）直到 ≤7500 或为空
    let list = Array.isArray(state.skips) ? state.skips.slice() : [];
    try {
      while (list.length > 0 && JSON.stringify(list).length > 7500) {
        list.shift();
      }
    } catch (e) { /* ignore */ }
    const data = {};
    data['cinemaSkip_' + getProgressKey()] = list;
    chrome.storage.sync.set(data);
  } catch (err) { console.debug('[cinema] saveSkips error:', err); }
}

/** 迁移旧 local cinemaSkips blob 到 sync（每个 entry 写成各自 cinemaSkip_<key>），完成后移除 local */
function migrateOldSkips(all) {
  try {
    const data = {};
    for (const k of Object.keys(all)) {
      if (Array.isArray(all[k])) data['cinemaSkip_' + k] = all[k];
    }
    chrome.storage.sync.set(data, () => {
      try {
        chrome.storage.local.remove('cinemaSkips');
      } catch (e) { console.debug('[cinema] migrateOldSkips remove error:', e); }
    });
  } catch (e) { console.debug('[cinema] migrateOldSkips error:', e); }
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

/** 合并备份中的收藏：按 bvid 去重、ts 较新者优先，重排为最新在前；完成后回调 */
function importBookmarksMerge(obj, cb) {
  const incoming = obj.bookmarks;
  if (!Array.isArray(incoming) || incoming.length === 0) { cb(); return; }
  try {
    readBookmarks((cur) => {
      try {
        const byBvid = {};
        for (const it of cur) if (it && it.bvid) byBvid[it.bvid] = it;
        for (const it of incoming) {
          if (!it || typeof it !== 'object' || !it.bvid) continue;
          if (!byBvid[it.bvid] || (it.ts || 0) >= (byBvid[it.bvid].ts || 0)) byBvid[it.bvid] = it;
        }
        const merged = Object.values(byBvid).sort((a, b) => ((b.ts || 0) - (a.ts || 0)));
        writeBookmarks(merged, cb);
      } catch (e) { cb(); }
    });
  } catch (e) { cb(); }
}

// ============================================================
//  数据备份 / 恢复（导出/导入 JSON，供 UI 的导出/导入入口调用）
// ============================================================

/**
 * 导出全部数据备份：
 * { version, exportedAt, settings, history, progressLocal, progressSync, bookmarks }
 * 不含任何密钥（本项目也没有 API key）。
 */
function exportCinemaBackup() {
  return new Promise((resolve, reject) => {
    try {
      readAllHistory((history) => {
        try {
          chrome.storage.local.get('cinemaProgress', (localRes) => {
            try {
              chrome.storage.sync.get('cinemaProgressSync', (syncRes) => {
                try {
                  readBookmarks((bookmarks) => {
                    try {
                      resolve({
                        version: 1,
                        exportedAt: Date.now(),
                        settings: { ...settings },
                        history: history || {},
                        progressLocal: (localRes && localRes.cinemaProgress) || {},
                        progressSync: (syncRes && syncRes.cinemaProgressSync) || {},
                        bookmarks: Array.isArray(bookmarks) ? bookmarks : [],
                      });
                    } catch (e) { reject(e); }
                  });
                } catch (e) { reject(e); }
              });
            } catch (e) { reject(e); }
          });
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
}

/** 合并观影记录：按 key 取 ts 较新者优先，writeAllHistory 会做容量截断；完成后回调 */
function importHistoryMerge(obj, cb) {
  const incoming = obj.history;
  if (!incoming || typeof incoming !== 'object' || Object.keys(incoming).length === 0) { cb(); return; }
  try {
    // 导入前取消可能挂起的防抖写并自增代际：避免其用旧快照覆盖刚导入的记录
    if (historyWriteTimer) { clearTimeout(historyWriteTimer); historyWriteTimer = null; }
    historyWriteGen++;
    readAllHistory((cur) => {
      try {
        const merged = { ...cur };
        for (const k of Object.keys(incoming)) {
          const rec = incoming[k];
          if (!rec || typeof rec !== 'object') continue;
          if (!merged[k] || (rec.ts || 0) >= (merged[k].ts || 0)) merged[k] = rec;
        }
        writeAllHistory(merged, cb);
      } catch (e) { cb(); }
    });
  } catch (e) { cb(); }
}

/** 合并本地进度（chrome.storage.local 的 cinemaProgress）：按 key 取 ts 较新者；完成后回调 */
function importProgressLocalMerge(obj, cb) {
  const incoming = obj.progressLocal;
  if (!incoming || typeof incoming !== 'object' || Object.keys(incoming).length === 0) { cb(); return; }
  try {
    chrome.storage.local.get('cinemaProgress', (res) => {
      try {
        const merged = { ...((res && res.cinemaProgress) || {}) };
        for (const k of Object.keys(incoming)) {
          const rec = incoming[k];
          if (!rec || typeof rec !== 'object') continue;
          if (!merged[k] || (rec.ts || 0) >= (merged[k].ts || 0)) merged[k] = rec;
        }
        chrome.storage.local.set({ cinemaProgress: merged }, cb);
      } catch (e) { cb(); }
    });
  } catch (e) { cb(); }
}

/** 合并跨设备进度（sync 的 cinemaProgressSync）：按 key 取 ts 较新者，并入后收紧容量；完成后回调 */
function importProgressSyncMerge(obj, cb) {
  const incoming = obj.progressSync;
  if (!incoming || typeof incoming !== 'object' || Object.keys(incoming).length === 0) { cb(); return; }
  try {
    chrome.storage.sync.get('cinemaProgressSync', (res) => {
      try {
        const merged = { ...((res && res.cinemaProgressSync) || {}) };
        for (const k of Object.keys(incoming)) {
          const rec = incoming[k];
          if (!rec || typeof rec !== 'object') continue;
          if (!merged[k] || (rec.ts || 0) >= (merged[k].ts || 0)) merged[k] = rec;
        }
        // 与日常写入一致：只保留最小字段并收紧容量（pruneSyncProgress 存在时）
        const final = typeof pruneSyncProgress === 'function'
          ? pruneSyncProgress(merged, SYNC_PROGRESS_LIMIT)
          : merged;
        chrome.storage.sync.set({ cinemaProgressSync: final }, cb);
      } catch (e) { cb(); }
    });
  } catch (e) { cb(); }
}

/**
 * 从备份对象导入数据（设置/观影记录/本地进度/跨设备进度/收藏），返回 { ok, message }。
 * 校验：必须是对象且带 version 或 settings 字段，否则视为无效文件。
 */
function importCinemaBackup(obj) {
  return new Promise((resolve) => {
    try {
      if (!obj || typeof obj !== 'object' || (!obj.version && !obj.settings)) {
        resolve({ ok: false, message: '文件无效' });
        return;
      }
      // 设置合并：备份设置优先，仍走 applyLoadedSettings（含 shortcuts 深度合并与数组消毒）
      if (obj.settings && typeof obj.settings === 'object') {
        applyLoadedSettings({ ...settings, ...obj.settings });
        saveSettings();
        // 导入的设置立即生效：刷新 UI（进度条样式/显隐等）+ 同步桥接配置
        if (typeof applySettings === 'function') applySettings();
        syncBridgeConfig();
      }
      // 独立合并路径（历史 / 本地进度 / 同步进度 / 收藏），全部完成后统一收尾
      let pending = 4;
      const doneOne = () => {
        pending--;
        if (pending <= 0) {
          try { applyCinemaTheme(); } catch { /* ignore */ }
          resolve({ ok: true, message: '已导入' });
        }
      };
      importHistoryMerge(obj, doneOne);
      importProgressLocalMerge(obj, doneOne);
      importProgressSyncMerge(obj, doneOne);
      importBookmarksMerge(obj, doneOne);
    } catch (e) {
      resolve({ ok: false, message: '文件无效' });
    }
  });
}
