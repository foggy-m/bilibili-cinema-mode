/**
 * B站影院模式 - 播放控制模块
 * 数据获取、视频元素管理、显示模式保持、播放偏好恢复、预加载、
 * 视频事件处理、分P切换、进度恢复、播完关闭标签页
 */

'use strict';

// ============================================================
//  数据获取
// ============================================================

/**
 * Manifest V3 的 content script 运行在隔离世界，无法直接访问
 * window.__INITIAL_STATE__。因此需要：
 *   1. 注入页面脚本，通过 CustomEvent 把数据传回来（主方案）
 *   2. 解析 <script> 标签的文本内容（回退方案）
 */

let pageDataPromise = null;

/** 向页面注入一段脚本，读取 __INITIAL_STATE__ 并通过事件传回 */
function injectPageDataScript() {
  if (pageDataPromise) return pageDataPromise;

  pageDataPromise = new Promise((resolve) => {
    const eventName = '__cinema_data_' + Date.now() + '__';

    const handler = (e) => {
      window.removeEventListener(eventName, handler);
      try {
        resolve(JSON.parse(e.detail));
      } catch {
        resolve(null);
      }
    };
    window.addEventListener(eventName, handler);

    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          var d = window.__INITIAL_STATE__;
          if (d && d.videoData) {
            var vd = d.videoData;
            var result = {
              bvid: d.bvid || '',
              aid: d.aid || vd.aid || 0,
              cid: d.cid || vd.cid || 0,
              title: vd.title || '',
              pic: vd.pic || '',
              pages: vd.pages || [],
              related: d.related || []
            };
            // 检测合集/选集结构
            if (vd.ugc_season && vd.ugc_season.sections) {
              var season = vd.ugc_season;
              var episodes = [];
              var idx = 0;
              for (var si = 0; si < season.sections.length; si++) {
                var sec = season.sections[si];
                var eps = sec.episodes || [];
                for (var ei = 0; ei < eps.length; ei++) {
                  var ep = eps[ei];
                  episodes.push({
                    index: idx++,
                    bvid: ep.bvid || '',
                    cid: ep.cid || 0,
                    aid: ep.aid || 0,
                    title: ep.title || '',
                    duration: ep.duration || (ep.page && ep.page.duration) || 0,
                    id: ep.id || 0
                  });
                }
              }
              result.season = {
                id: season.id || 0,
                title: season.title || '',
                episodes: episodes
              };
            }
            window.dispatchEvent(new CustomEvent('${eventName}', {
              detail: JSON.stringify(result)
            }));
          } else {
            window.dispatchEvent(new CustomEvent('${eventName}', { detail: 'null' }));
          }
        } catch(e) {
          window.dispatchEvent(new CustomEvent('${eventName}', { detail: 'null' }));
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    // 超时保护
    setTimeout(() => {
      window.removeEventListener(eventName, handler);
      resolve(null);
    }, 3000);
  });

  return pageDataPromise;
}

function applyParsedData(s) {
  if (!s) return false;

  // C16：保存相关推荐列表（播完下一部候选来源）
  state.related = Array.isArray(s.related) ? s.related : [];

  // 优先：视频自身有多P → 分P模式（合并为一部电影）
  if (s.pages && s.pages.length > 1) {
    state.mode = 'pages';
    state.bvid = s.bvid || getBvid();
    state.aid = s.aid || 0;
    state.cid = s.cid || 0;
    state.title = s.title || document.title;
    state.pic = s.pic || '';
    state.pages = s.pages.map((p) => ({
      page: p.page,
      cid: p.cid,
      part: p.part || `P${p.page}`,
      duration: p.duration || 0,
      vid: p.vid || '',
      weblink: p.weblink || '',
    }));
    // 保存合集信息（用于播完后自动跳下一部）
    if (s.season && s.season.episodes && s.season.episodes.length > 1) {
      state.seasonId = s.season.id || 0;
      state.seasonTitle = s.season.title || '';
      state.seasonEpisodes = s.season.episodes;
    }
    return true;
  }

  // 单P视频（不合并合集条目，每个合集条目都是独立影片）
  if (s.pages && s.pages.length > 0) {
    state.mode = 'pages';
    state.bvid = s.bvid || getBvid();
    state.aid = s.aid || 0;
    state.cid = s.cid || 0;
    state.title = s.title || document.title;
    state.pic = s.pic || '';
    state.pages = s.pages.map((p) => ({
      page: p.page,
      cid: p.cid,
      part: p.part || `P${p.page}`,
      duration: p.duration || 0,
      vid: p.vid || '',
      weblink: p.weblink || '',
    }));
    // Phase4：单P剧集同样记录合集元数据（供"播完下一部"候选）。
    // 注意：不把 mode 改为 'season' —— 单P合集条目保持独立影片语义（进度键/自动连播不变）
    if (s.season && s.season.episodes && s.season.episodes.length > 1) {
      state.seasonId = s.season.id || 0;
      state.seasonTitle = s.season.title || '';
      state.seasonEpisodes = s.season.episodes;
    }
    return true;
  }

  return false;
}

/** 从 <script> 标签文本中解析 __INITIAL_STATE__（content script 可读 DOM 文本） */
function parseFromScriptTags() {
  try {
    const scripts = document.querySelectorAll('script');
    for (const sc of scripts) {
      const text = sc.textContent || '';
      const idx = text.indexOf('__INITIAL_STATE__=');
      if (idx === -1) continue;

      // 用括号计数法提取完整 JSON（避免字符串内的分号干扰）
      const start = text.indexOf('{', idx);
      if (start === -1) continue;
      let depth = 0;
      let end = -1;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) continue;

      const jsonStr = text.slice(start, end + 1);
      const s = JSON.parse(jsonStr);
      if (s && s.videoData) {
        const vd = s.videoData;
        const result = {
          bvid: s.bvid || '',
          aid: s.aid || vd.aid || 0,
          cid: s.cid || vd.cid || 0,
          title: vd.title || '',
          pic: vd.pic || '',
          pages: vd.pages || [],
          // C16：__INITIAL_STATE__.related 是相关推荐数组 [{ bvid, title, pic }]
          related: s.related || [],
        };
        // 检测合集/选集结构
        if (vd.ugc_season && vd.ugc_season.sections) {
          const season = vd.ugc_season;
          const episodes = [];
          let epIdx = 0;
          for (const sec of season.sections) {
            const eps = sec.episodes || [];
            for (const ep of eps) {
              episodes.push({
                index: epIdx++,
                bvid: ep.bvid || '',
                cid: ep.cid || 0,
                aid: ep.aid || 0,
                title: ep.title || '',
                duration: ep.duration || (ep.page && ep.page.duration) || 0,
                id: ep.id || 0,
              });
            }
          }
          result.season = {
            id: season.id || 0,
            title: season.title || '',
            episodes: episodes,
          };
        }
        return result;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** 方案 3：通过 Bilibili 公开 API 获取视频数据（最可靠的回退） */
async function fetchFromAPI() {
  const bvid = getBvid();
  if (!bvid) return null;

  try {
    const resp = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { credentials: 'include' }
    );
    const json = await resp.json();
    if (json.code !== 0 || !json.data) return null;

    const vd = json.data;
    const result = {
      bvid: vd.bvid || bvid,
      aid: vd.aid || 0,
      cid: vd.cid || 0,
      title: vd.title || '',
      pic: vd.pic || '',
      pages: vd.pages || [],
      // C16：API 回退路径尽力带上相关推荐（接口不保证返回，取不到则为空）
      related: vd.related || [],
    };

    // 检测合集/选集结构
    if (vd.ugc_season && vd.ugc_season.sections) {
      const season = vd.ugc_season;
      const episodes = [];
      let epIdx = 0;
      for (const sec of season.sections) {
        const eps = sec.episodes || [];
        for (const ep of eps) {
          episodes.push({
            index: epIdx++,
            bvid: ep.bvid || '',
            cid: ep.cid || 0,
            aid: ep.aid || 0,
            title: ep.title || '',
            duration: ep.duration || (ep.page && ep.page.duration) || 0,
            id: ep.id || 0,
          });
        }
      }
      result.season = {
        id: season.id || 0,
        title: season.title || '',
        episodes: episodes,
      };
    }

    log('通过 API 获取到视频数据');
    return result;
  } catch (e) {
    log('API 获取失败:', e);
    return null;
  }
}

async function extractPageData() {
  // 方案 1：解析 <script> 标签文本（同步、快速）
  const parsed = parseFromScriptTags();
  if (applyParsedData(parsed)) { resolveNextWork(); return true; }

  // 方案 2：注入页面脚本读取（异步，处理 DOM 解析失败的情况）
  const injected = await injectPageDataScript();
  if (applyParsedData(injected)) { resolveNextWork(); return true; }

  // 方案 3：通过 Bilibili API 直接获取（最可靠，不依赖页面内嵌数据）
  const apiData = await fetchFromAPI();
  if (applyParsedData(apiData)) { resolveNextWork(); return true; }

  return false;
}

/**
 * 解析"播完下一部"候选（C16，站内推荐，不跨站）：
 * 1. 合集模式：seasonEpisodes 中当前 bvid 的下一集（存在且 bvid 不同）；
 * 2. 否则取相关推荐列表第一条（bvid 不同）；
 * 3. 都没有则为 null。
 * 结果写入 state.nextWork。applyParsedData / proceed 均会调用，幂等。
 */
function resolveNextWork() {
  try {
    // 1. 合集/选集：当前 bvid 在 seasonEpisodes 中的下一集
    if (state.seasonEpisodes.length > 1) {
      const idx = state.seasonEpisodes.findIndex((ep) => ep.bvid === state.bvid);
      if (idx !== -1) {
        const next = state.seasonEpisodes[idx + 1];
        if (next && next.bvid && next.bvid !== state.bvid) {
          state.nextWork = { bvid: next.bvid, title: next.title || '', pic: '' };
          return state.nextWork;
        }
      }
    }
    // 2. 相关推荐第一条（bvid 不同）
    if (Array.isArray(state.related) && state.related.length > 0) {
      const first = state.related[0];
      if (first && first.bvid && first.bvid !== state.bvid) {
        state.nextWork = {
          bvid: first.bvid,
          title: first.title || '',
          pic: first.pic || '',
        };
        return state.nextWork;
      }
    }
  } catch (e) { /* 静默回退 null */ }
  state.nextWork = null;
  return null;
}

function computeCumulative() {
  const result = buildCumulative(state.pages.map((p) => p.duration));
  state.cumulative = result.cumulative;
  state.totalDuration = result.totalDuration;
  if (typeof buildMarkers === 'function') buildMarkers();
  if (typeof applyChapterGradient === 'function') applyChapterGradient();
  if (typeof renderSkipMarkers === 'function') renderSkipMarkers();
}

// 如果 __INITIAL_STATE__ 中没有 duration，通过 API 获取
async function fetchDurations() {
  if (state.pages.length === 0) return;
  // 检查是否已有 duration
  const missing = state.pages.some((p) => !p.duration);
  if (!missing) return;

  try {
    const resp = await fetch(
      `https://api.bilibili.com/x/player/pagelist?bvid=${state.bvid}`,
      { credentials: 'include' }
    );
    const json = await resp.json();
    if (json.code === 0 && json.data) {
      for (const item of json.data) {
        const page = state.pages.find((p) => p.cid === item.cid);
        if (page && item.duration) {
          page.duration = item.duration;
        }
      }
    }
  } catch (e) {
    log('获取分P时长失败:', e);
  }

  // 如果 API 也没拿到 duration，用当前视频的 duration 作为估算
  const stillMissing = state.pages.some((p) => !p.duration);
  if (stillMissing && state.video && state.video.duration) {
    for (const p of state.pages) {
      if (!p.duration) p.duration = state.video.duration;
    }
  }
}

// ============================================================
//  视频元素查找 & 监听
// ============================================================

function findVideo() {
  // 在播放器容器内查找（同时支持标准 <video> 和 B站自研 <bwp-video>）
  const containers = [
    '.bpx-player-video-area',
    '.bilibili-player-video',
    '#bilibili-player',
    '.player-wrap',
    '#playerWrap',
  ];
  for (const sel of containers) {
    const el = document.querySelector(sel);
    if (el) {
      const v = el.querySelector('video') || el.querySelector('bwp-video');
      if (v) return v;
    }
  }
  // 全局回退
  return document.querySelector('video') || document.querySelector('bwp-video');
}

function findPlayerWrap() {
  return (
    document.querySelector('.bpx-player-container') ||
    document.querySelector('.bilibili-player') ||
    document.querySelector('#bilibili-player') ||
    document.querySelector('.player-wrap') ||
    document.querySelector('#playerWrap') ||
    (state.video ? state.video.closest('.bpx-player-container, .bilibili-player, #bilibili-player') : null)
  );
}

// ============================================================
//  全屏模式保持
// ============================================================

/** 解析桥接事件的 detail（兼容 JSON 字符串和对象） */
function parseBridgeDetail(e) {
  try {
    return typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
  } catch {
    return {};
  }
}

/** 通过 MAIN world 桥接脚本查询播放器显示模式（mainScreen: 0=普通 1=宽屏 2=网页全屏） */
function queryPlayerMainScreen() {
  return new Promise((resolve) => {
    const id = 'ms_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const timer = setTimeout(() => {
      window.removeEventListener('__cinema_get_mode_result__', handler);
      resolve(-1);
    }, 400);
    const handler = (e) => {
      const d = parseBridgeDetail(e);
      if (d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('__cinema_get_mode_result__', handler);
      resolve(typeof d.mainScreen === 'number' ? d.mainScreen : -1);
    };
    window.addEventListener('__cinema_get_mode_result__', handler);
    window.dispatchEvent(new CustomEvent('__cinema_get_mode__', { detail: JSON.stringify({ id }) }));
  });
}

/**
 * 获取当前播放器显示模式
 * @returns {Promise<'normal'|'wide'|'web-fullscreen'|'fullscreen'>}
 */
async function getPlayerDisplayMode() {
  // 1. 原生全屏
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) return 'fullscreen';

  // 2. 优先通过播放器内部状态查询（最可靠）
  const mainScreen = await queryPlayerMainScreen();
  if (mainScreen === 2) return 'web-fullscreen';
  if (mainScreen === 1) return 'wide';
  if (mainScreen === 0) return 'normal';

  // 3. 回退：DOM 检测
  const bp = document.querySelector('#bilibili-player');
  if (bp && bp.classList.contains('mode-webscreen')) return 'web-fullscreen';
  const webBtn = document.querySelector('.bpx-player-ctrl-web');
  if (webBtn && webBtn.classList.contains('bpx-state-entered')) return 'web-fullscreen';
  const wideBtn = document.querySelector('.bpx-player-ctrl-wide');
  if (wideBtn && wideBtn.classList.contains('bpx-state-entered')) return 'wide';

  return 'normal';
}

/**
 * 通过B站播放器内部 API 切换分P（不重建播放器，保持全屏/网页全屏/宽屏）
 * @returns {Promise<boolean>}
 */
function switchPartViaPlayerAPI(targetPage) {
  return new Promise((resolve) => {
    const id = 'sw_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const timer = setTimeout(() => {
      window.removeEventListener('__cinema_switch_part_result__', handler);
      resolve(false);
    }, 600);
    const handler = (e) => {
      const d = parseBridgeDetail(e);
      if (d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('__cinema_switch_part_result__', handler);
      if (d.ok) {
        log(`通过播放器内部 API 切换到 P${targetPage}（保持显示模式）`);
      }
      resolve(!!d.ok);
    };
    window.addEventListener('__cinema_switch_part_result__', handler);
    window.dispatchEvent(new CustomEvent('__cinema_switch_part__', {
      detail: JSON.stringify({ id, page: targetPage })
    }));
  });
}

/**
 * 恢复播放器到指定的显示模式（通过点击对应按钮）
 * @param {'normal'|'wide'|'web-fullscreen'|'fullscreen'} mode
 */
function restoreDisplayMode(mode) {
  if (mode === 'normal') return;

  let attempts = 0;
  const maxAttempts = 10;

  const tryRestore = () => {
    attempts++;
    let btn = null;

    if (mode === 'web-fullscreen') {
      btn = document.querySelector('.bpx-player-ctrl-web');
    } else if (mode === 'wide') {
      btn = document.querySelector('.bpx-player-ctrl-wide');
    } else if (mode === 'fullscreen') {
      btn = document.querySelector('.bpx-player-ctrl-full');
    }

    if (btn) {
      // 检查按钮是否已经处于目标状态（避免重复点击导致退出）
      if (mode === 'web-fullscreen' || mode === 'wide') {
        if (btn.classList.contains('bpx-state-entered')) return; // 已在目标模式
      }
      if (mode === 'fullscreen' && (document.fullscreenElement || document.webkitFullscreenElement)) return;
      btn.click();
      log(`恢复显示模式: ${mode}`);
      return;
    }

    // 按钮还没渲染出来，重试
    if (attempts < maxAttempts) {
      setTimeout(tryRestore, 200);
    }
  };

  // 延迟启动，等播放器控件渲染完成
  setTimeout(tryRestore, 300);
}

// ============================================================
//  播放设置记忆（画质/倍速/音量/弹幕）
// ============================================================

/** 查找弹幕开关按钮（登录后才有） */
function findDanmakuBtn() {
  return (
    document.querySelector('.bpx-player-ctrl-danmaku') ||
    Array.from(document.querySelectorAll('.bpx-player-ctrl-btn')).find((b) =>
      /danmaku|弹幕/.test(b.className + ' ' + (b.title || ''))
    ) ||
    null
  );
}

/** 用户手动调整倍速时记录 */
function onPlayerRateChange() {
  const video = state.video;
  if (!video || !state.prefsLoaded || state.switching || state.restoringPrefs) return;
  if (Date.now() < state.prefsGuardUntil) return; // 恢复后的保护期
  const rate = video.playbackRate;
  if (rate > 0 && rate <= 4 && Math.abs(rate - state.prefs.rate) > 0.01) {
    state.prefs.rate = rate;
    savePlayerPrefs();
    log(`记忆倍速: ${rate}x`);
  }
}

/** 用户手动调整音量时记录 */
function onPlayerVolumeChange() {
  const video = state.video;
  if (!video || !state.prefsLoaded || state.switching || state.restoringPrefs) return;
  if (Date.now() < state.prefsGuardUntil) return;
  const vol = video.muted ? 0 : video.volume;
  if (vol >= 0 && vol <= 1 && Math.abs(vol - state.prefs.volume) > 0.02) {
    state.prefs.volume = vol;
    savePlayerPrefs();
  }
}

/** 捕获当前画质文本（节流调用） */
function captureQualityText() {
  if (state.switching || !state.prefsLoaded) return;
  const el = document.querySelector('.bpx-player-ctrl-quality-result');
  if (!el) return;
  const text = (el.textContent || '').trim();
  if (text && text !== state.prefs.quality) {
    state.prefs.quality = text;
    savePlayerPrefs();
  }
}

/** 捕获弹幕开关状态（节流调用） */
function captureDanmakuState() {
  if (state.switching || !state.prefsLoaded) return;
  const btn = findDanmakuBtn();
  if (!btn) return;
  const on = btn.classList.contains('bpx-state-entered');
  if (on !== state.prefs.danmaku) {
    state.prefs.danmaku = on;
    savePlayerPrefs();
  }
}

/** 通过画质菜单恢复画质（点击画质按钮 → 匹配文本项）；attempt 用于控件未渲染时的延迟重试 */
function restoreQualityByText(qText, attempt) {
  const btn = document.querySelector('.bpx-player-ctrl-quality');
  if (!btn) {
    // 控件尚未渲染：延迟重试（最多 2 次），避免画质记忆静默丢失
    if ((attempt || 0) < 2) setTimeout(() => restoreQualityByText(qText, (attempt || 0) + 1), 700);
    return;
  }
  const cur = document.querySelector('.bpx-player-ctrl-quality-result');
  if (cur && (cur.textContent || '').trim() === qText) return; // 已是目标画质

  btn.click(); // 打开菜单
  setTimeout(() => {
    const items = document.querySelectorAll('.bpx-player-ctrl-quality-menu-item');
    let found = false;
    for (const item of items) {
      if ((item.textContent || '').includes(qText)) {
        item.click();
        found = true;
        log(`恢复画质: ${qText}`);
        break;
      }
    }
    if (!found) {
      // 菜单里没有目标画质（可能未登录/无权限），关闭菜单
      const b2 = document.querySelector('.bpx-player-ctrl-quality');
      if (b2) b2.click();
    }
  }, 300);
}

/** 恢复播放器设置（整页加载后 / 切换完成后调用） */
async function restorePlayerPrefs() {
  const video = state.video;
  if (!video || !state.prefsLoaded) return;
  state.restoringPrefs = true;
  state.prefsGuardUntil = Date.now() + 3000; // 3 秒保护期，避免恢复动作被误记录

  // 1. 倍速（最可靠：直接设置原生属性）
  if (state.prefs.rate > 0 && state.prefs.rate <= 4 && Math.abs(video.playbackRate - state.prefs.rate) > 0.01) {
    video.playbackRate = state.prefs.rate;
    log(`恢复倍速: ${state.prefs.rate}x`);
  }

  // 2. 音量（切P淡入期间由 armAudioFadeIn 接管，跳过此处避免"突入→跌落"伪淡入；页载/无淡出时正常恢复）
  if (!state.fadeSnapshot && state.prefs.volume >= 0 && state.prefs.volume <= 1) {
    video.muted = state.prefs.volume === 0;
    if (!video.muted) video.volume = state.prefs.volume;
  }

  // 3. 画质（延迟，等控件渲染完成）
  if (state.prefs.quality) {
    setTimeout(() => restoreQualityByText(state.prefs.quality, 0), 300);
  }

  // 4. 弹幕开关
  setTimeout(() => {
    const btn = findDanmakuBtn();
    if (btn) {
      const on = btn.classList.contains('bpx-state-entered');
      if (on !== state.prefs.danmaku) btn.click();
    }
  }, 300);

  setTimeout(() => {
    state.restoringPrefs = false;
  }, 1500);
}

/**
 * 切换成功后弹幕预热：按记忆的弹幕开关状态确保按钮状态正确（400ms/1200ms 两次，
 * 补偿控件渲染/事件绑定延迟）；若弹幕已开启但 1 秒后容器仍无内容，则 off→on 强制重载弹幕流。
 */
function prewarmDanmaku() {
  try {
    if (!state.prefsLoaded || !state.video) return;

    // 按记忆开关状态校准弹幕按钮
    [400, 1200].forEach((delay) => {
      setTimeout(() => {
        try {
          if (state.switching) return;
          const btn = findDanmakuBtn();
          if (!btn) return;
          const on = btn.classList.contains('bpx-state-entered');
          if (on !== (state.prefs.danmaku !== false)) btn.click();
        } catch { /* 静默 */ }
      }, delay);
    });

    // 弹幕已开但容器空：off→on 强制重载（仅在确认容器存在且无内容时执行，避免误操作）
    if (state.prefs.danmaku !== false) {
      setTimeout(() => {
        try {
          if (state.switching) return;
          const btn = findDanmakuBtn();
          if (!btn || !btn.classList.contains('bpx-state-entered')) return;
          const container = document.querySelector('.bpx-player-dm-wrap') ||
            document.querySelector('.bilibili-player-video-danmaku') ||
            document.querySelector('.bpx-player-danmaku');
          if (!container || container.querySelector('canvas, .bpx-player-dm-item')) return;
          btn.click(); // off
          setTimeout(() => {
            const b2 = findDanmakuBtn();
            if (b2) b2.click(); // on（重新加载弹幕流）
          }, 150);
        } catch { /* 静默 */ }
      }, 1000);
    }
  } catch { /* 静默 */ }
}

// ============================================================
//  下一分P预加载（预取视频流到浏览器缓存，切换时命中缓存秒开）
// ============================================================

/** 预取是否处于停摆窗口：连续 3 次失败后暂停重试，5 分钟后自动衰减恢复（不再永久停摆） */
function preloadBlocked() {
  if (state.preloadFailCount < 3) return false;
  return Date.now() - (state.preloadFailTs || 0) < 5 * 60 * 1000;
}

/**
 * 切P关键窗口临时屏蔽 P2P 混流：让新分P首个媒体段走 XHR 命中 byteStore 预取（关键窗口 ~4s）。
 * 用户已常驻屏蔽（settings.p2pBlock）则跳过；窗口时长可配置（p2pTempMs，钳制 1000–10000），
 * 到点后调用 syncBridgeConfig() 恢复用户设置值。
 */
function applyTempP2PBlock() {
  if (settings.p2pBlock) return; // 已常驻屏蔽，无需临时
  const tempMs = Math.min(10000, Math.max(1000, settings.p2pTempMs || 4000));
  try {
    window.dispatchEvent(new CustomEvent('__cinema_config__', {
      detail: JSON.stringify({ p2pBlock: true })
    }));
  } catch { /* ignore */ }
  if (state.p2pTempTimer) clearTimeout(state.p2pTempTimer);
  state.p2pTempTimer = setTimeout(() => syncBridgeConfig(), tempMs);
}

/** 预取下一分P/下一集（由 MAIN world 桥接脚本执行：拦截播放器 XHR + 直连预取） */
async function preloadNextPart() {
  if (!settings.preloadNext) return;
  if (state.switching || state.preloading || preloadBlocked()) return;
  // 只有最后一个分P/剧集之前才需要预取
  if (state.currentIndex >= state.pages.length - 1) return;

  const nextIndex = state.currentIndex + 1;
  const next = state.pages[nextIndex];
  if (!next || !next.cid) return;
  if (state.preloadedCid === next.cid) return;

  // 合集模式下一集是不同 bvid（playurl API 同源、跨 bvid 可直接调用）；分P模式用当前视频 bvid
  const nextBvid = state.mode === 'season'
    ? (next.bvid || (state.seasonEpisodes[nextIndex] && state.seasonEpisodes[nextIndex].bvid) || state.bvid)
    : state.bvid;
  if (!nextBvid) return;

  const attemptedCid = next.cid; // Important #3：兜底超时时据此释放对应的 preloadedCid 槽位
  state.preloading = true; // B1：保持到 __cinema_prefetch_done__ / 取消事件才清除（防重复请求）
  try {
    // 通知 MAIN world 的 player-bridge.js 执行预取（真实网络操作在页面主世界进行）
    window.dispatchEvent(new CustomEvent('__cinema_prefetch__', {
      detail: JSON.stringify({
        bvid: nextBvid,
        cid: next.cid,
        qn: qualityTextToQn(state.prefs.quality),
      }),
    }));
    // 请求已发出，标记该分P已预取（失败/成功时桥接脚本会发 __cinema_prefetch_done__）
    state.preloadedCid = next.cid;
    log(`已请求预取下一${state.mode === 'season' ? '集' : 'P'}: ${next.part || next.title || ('P' + next.page)}`);
    // 兜底：桥接脚本因故未回传 done/取消（预取被中断等）时，30 秒后清除 preloading，防止永久卡死
    if (state.prefetchCancelTimer) clearTimeout(state.prefetchCancelTimer);
    state.prefetchCancelTimer = setTimeout(() => {
      state.preloading = false;
      state.prefetchCancelTimer = null;
      // Important #3：兜底超时时若该尝试的 cid 仍占着槽位，一并释放以便重试
      if (state.preloadedCid === attemptedCid) state.preloadedCid = null;
    }, 30000);
  } catch (e) {
    // 派发异常：直接清除预取状态，允许下次重试
    state.preloading = false;
    console.debug('[cinema] preloadNextPart error:', e);
  }
}

/** 预取结果回调（桥接脚本完成/失败后通知） */
function onPrefetchDone(e) {
  try {
    const d = typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
    // 预取已结束（成功/失败/取消）：清除进行中状态（B1，preloading 保持到 done 才清除）
    state.preloading = false;
    if (state.prefetchCancelTimer) { clearTimeout(state.prefetchCancelTimer); state.prefetchCancelTimer = null; }
    if (d && d.ok === false) {
      state.preloadFailCount = (state.preloadFailCount || 0) + 1;
      state.preloadFailTs = Date.now();
      // Important #3：自动预取失败后释放 preloadedCid 槽位（该 cid 占着会让自动预取永不再试）
      if (d.cid && state.preloadedCid === d.cid) state.preloadedCid = null;
      // 按需预取失败后清除去重记录，允许悬停重试（失败不应占用 10 分钟去重槽位）
      if (d.cid && state.onDemandPrefetch) delete state.onDemandPrefetch[d.cid];
      log(`预取失败(${state.preloadFailCount}次): ${d.reason || 'unknown'}`);
    } else if (d && d.ok === true) {
      state.preloadFailCount = 0; // 成功后重置失败计数
      state.prefetchOkCid = d.cid; // 记录已预取成功的分P cid（决定切P过渡视觉下限）
      // 预取就绪指示器（cinema-ui.js 定义，typeof 守卫防脚本加载顺序问题）
      if (typeof showPrefetchStatus === 'function') showPrefetchStatus();
    }
  } catch (err) { console.debug('[cinema] onPrefetchDone error:', err); }
}

/**
 * 取消在途预取。
 * keepCid：若当前预取的就是即将切过去的分P，不要 abort——那正是无缝切P要用的字节。
 */
function cancelPrefetch(opts) {
  const keepCid = opts && opts.keepCid;
  if (keepCid && state.preloadedCid === keepCid) return;
  try {
    window.dispatchEvent(new CustomEvent('__cinema_prefetch_cancel__', { detail: '{}' }));
  } catch { /* ignore */ }
  if (state.prefetchCancelTimer) { clearTimeout(state.prefetchCancelTimer); state.prefetchCancelTimer = null; }
  state.preloading = false;
  state.preloadedCid = null;
}

/** 自动连播是否走「一部电影」视觉：冻帧盖住、不插幕间卡 */
function useSeamlessCover() {
  return settings.seamlessMovie !== false;
}

/** 当前分P已缓冲区间末端秒数（无有效缓冲区间返回 0） */
function currentBufferedEnd() {
  const v = state.video;
  if (!v) return 0;
  let end = 0;
  try {
    const buffered = v.buffered;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= (v.currentTime || 0) + 0.5 && buffered.end(i) > end) {
        end = buffered.end(i);
      }
    }
  } catch { /* ignore */ }
  return end;
}

/** B2：进度恢复完成后，若当前分P剩余 < 90 秒则尽早预取下一P（不必等剩余 60 秒才触发） */
function tryEarlyPreloadAfterRestore() {
  const video = state.video;
  if (!video) return;
  const duration = video.duration || (state.pages[state.currentIndex] || {}).duration || 0;
  if (duration - (video.currentTime || 0) < 90) preloadNextPart();
}

/**
 * 按需预取任意分P/剧集（分P列表悬停等"切换意图"场景触发，降低手动跳集黑屏）
 * 与 preloadNextPart 的区别：不占用 preloadedCid 槽位（不影响自然下一P的自动预取），
 * 用独立去重表（同 cid 10 分钟内不重复预取）
 */
function prefetchPartOnDemand(idx) {
  if (!settings.preloadNext || state.switching || preloadBlocked()) return;
  // Important #2：自动下一P预取进行中时不打断（不让悬停按需预取把自动预取挤掉/互相打架）
  if (state.preloading) return;
  if (idx < 0 || idx >= state.pages.length || idx === state.currentIndex) return;

  const target = state.pages[idx];
  if (!target || !target.cid) return;
  if (state.preloadedCid === target.cid) return; // 已在自动预取队列中

  state.onDemandPrefetch = state.onDemandPrefetch || {};
  const last = state.onDemandPrefetch[target.cid] || 0;
  if (Date.now() - last < 600000) return; // 10 分钟内不重复

  const bvid = state.mode === 'season'
    ? (target.bvid || (state.seasonEpisodes[idx] && state.seasonEpisodes[idx].bvid) || state.bvid)
    : state.bvid;
  if (!bvid) return;

  state.onDemandPrefetch[target.cid] = Date.now();
  try {
    window.dispatchEvent(new CustomEvent('__cinema_prefetch__', {
      detail: JSON.stringify({
        bvid: bvid,
        cid: target.cid,
        qn: qualityTextToQn(state.prefs.quality),
        onDemand: true,
      }),
    }));
    log(`按需预取: 第${target.page}集 ${target.part || ''}`);
  } catch (e) { console.debug('[cinema] prefetchPartOnDemand error:', e); }
}

// ============================================================
//  播放完毕自动关闭标签页
// ============================================================

/** 最后P接近结束时提示自动关闭标签页（仅一次） */
function maybeSuggestCloseTab() {
  const video = state.video;
  if (!video || !settings.autoCloseTab) return;
  if (state.closeTipShown || state.switching) return;
  if (state.currentIndex < state.pages.length - 1) return;

  const duration = video.duration || (state.pages[state.currentIndex] || {}).duration || 0;
  if (!video.ended && duration - video.currentTime > 2) return;

  state.closeTipShown = true;
  showCloseTabTip();
}

/** 显示“播放完毕”关闭标签页提示气泡（10 秒倒计时） */
function showCloseTabTip() {
  closeCloseTabTip();

  const tip = document.createElement('div');
  tip.className = 'cinema-close-tip';
  tip.innerHTML = `
    <div class="cinema-close-tip-text">播放完毕，<span class="cinema-close-count">10</span> 秒后自动关闭标签页</div>
    <div class="cinema-close-tip-btns">
      <button class="cinema-close-tip-btn cinema-close-tip-ok">立即关闭</button>
      <button class="cinema-close-tip-btn cinema-close-tip-cancel">取消</button>
    </div>
  `;
  document.body.appendChild(tip);
  ui.closeTip = tip;

  let count = 10;
  const countEl = tip.querySelector('.cinema-close-count');
  state.closeTipTimer = setInterval(() => {
    count--;
    if (count <= 0) {
      closeCloseTabTip();
      requestCloseTab();
      return;
    }
    if (countEl) countEl.textContent = count;
  }, 1000);

  tip.querySelector('.cinema-close-tip-ok').addEventListener('click', () => {
    closeCloseTabTip();
    requestCloseTab();
  });
  tip.querySelector('.cinema-close-tip-cancel').addEventListener('click', () => {
    closeCloseTabTip();
  });
}

function closeCloseTabTip() {
  if (state.closeTipTimer) {
    clearInterval(state.closeTipTimer);
    state.closeTipTimer = null;
  }
  if (ui.closeTip) {
    ui.closeTip.remove();
    ui.closeTip = null;
  }
}

/** 通知后台脚本关闭当前标签页 */
function requestCloseTab() {
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'closeTab' });
      log('发送关闭标签页请求');
    }
  } catch { /* ignore */ }
}

// ============================================================
//  视频监听器
// ============================================================

/** 播放/暂停时同步进度条视觉状态与荧幕氛围光 */
function onCinemaPlay() {
  if (ui.bar) ui.bar.classList.remove('cinema-paused');
  if (typeof startAmbilightLoop === 'function') startAmbilightLoop();
  if (typeof updateLightsOut === 'function') updateLightsOut();
  if (typeof markUserActive === 'function') markUserActive();
}

function onCinemaPause() {
  if (ui.bar) ui.bar.classList.add('cinema-paused');
  if (typeof updateAmbilightFrame === 'function') updateAmbilightFrame();
  if (typeof clearIdleTimer === 'function') clearIdleTimer();
  if (state.playerWrap) state.playerWrap.classList.remove('cinema-idle');
  document.body.classList.remove('cinema-idle');
}

function attachVideoListeners() {
  const video = state.video;
  if (!video || video.__cinemaBound) return; // 幂等：防止 season 跨BV切换时 onNavigate 与 waitForVideoChangeSeason 双路径重复挂载
  video.__cinemaBound = true;

  video.addEventListener('loadedmetadata', onVideoReady, { once: false });
  video.addEventListener('ended', onVideoEnded);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('ratechange', onPlayerRateChange);
  video.addEventListener('volumechange', onPlayerVolumeChange);
  video.addEventListener('progress', onVideoProgress);
  video.addEventListener('play', onCinemaPlay);
  video.addEventListener('pause', onCinemaPause);

  // 全屏状态变化监听器：在切换期间保持显示模式
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // 初始挂载时若视频已暂停，进度条流光/霓虹动画保持停住
  if (video.paused && ui.bar) {
    ui.bar.classList.add('cinema-paused');
  }

  // 如果视频已经加载好了
  if (video.readyState >= 1) {
    onVideoReady();
  }
}

function detachVideoListeners() {
  const video = state.video;
  if (!video) return;
  delete video.__cinemaBound;
  video.removeEventListener('loadedmetadata', onVideoReady);
  video.removeEventListener('ended', onVideoEnded);
  video.removeEventListener('timeupdate', onTimeUpdate);
  video.removeEventListener('ratechange', onPlayerRateChange);
  video.removeEventListener('volumechange', onPlayerVolumeChange);
  video.removeEventListener('progress', onVideoProgress);
  video.removeEventListener('play', onCinemaPlay);
  video.removeEventListener('pause', onCinemaPause);

  // 移除全屏状态变化监听器
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
}

/** 全屏状态变化处理函数 */
async function onFullscreenChange() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  const enteringFullscreen = !!fsEl;

  // 原生全屏下浏览器只渲染全屏元素子树：进入全屏时把设置按钮/面板/状态徽章移入全屏元素，
  // 退出时移回 body（fixed 元素全屏元素即其包含块，仍可自由定位）
  if (fsEl) {
    if (ui.settingsBtn && fsEl !== ui.settingsBtn.parentElement) {
      fsEl.appendChild(ui.settingsBtn);
      if (ui.settingsPanel) fsEl.appendChild(ui.settingsPanel);
    }
    if (ui.statusBadge && fsEl !== ui.statusBadge.parentElement) {
      fsEl.appendChild(ui.statusBadge);
    }
  } else {
    if (ui.settingsBtn && ui.settingsBtn.parentElement !== document.body) {
      document.body.appendChild(ui.settingsBtn);
      if (ui.settingsPanel) document.body.appendChild(ui.settingsPanel);
    }
    if (ui.statusBadge && ui.statusBadge.parentElement !== document.body) {
      document.body.appendChild(ui.statusBadge);
    }
  }

  if (!enteringFullscreen) {
    // 退出全屏时：确保设置按钮位置在视口内，且重新应用可见性
    if (ui.settingsBtn && ui.settingsBtn.style.display !== 'none') {
      const rect = ui.settingsBtn.getBoundingClientRect();
      if (rect.left >= window.innerWidth || rect.top >= window.innerHeight || rect.right < 0 || rect.bottom < 0) {
        const bw = ui.settingsBtn.offsetWidth;
        const bh = ui.settingsBtn.offsetHeight;
        ui.settingsBtn.style.left = Math.max(0, Math.min(parseFloat(ui.settingsBtn.style.left) || 0, window.innerWidth - bw)) + 'px';
        ui.settingsBtn.style.top = Math.max(0, Math.min(parseFloat(ui.settingsBtn.style.top) || 0, window.innerHeight - bh)) + 'px';
      }
    }
    // 确保按钮可见性状态与设置同步（防止全屏切换期间 DOM 操作影响按钮）
    if (ui.settingsBtn) applySettings();
  }

  // 全屏状态变化时刷新关灯遮罩（全屏自动隐藏）
  updateLightsOut();

  if (!state.switching) return;
  if (state.displayMode === 'fullscreen') {
    const currentMode = await getPlayerDisplayMode();
    if (currentMode !== 'fullscreen') {
      setTimeout(() => restoreDisplayMode('fullscreen'), 200);
    }
  }
}

// ============================================================
//  视频事件处理
// ============================================================

let lastSavedTime = 0;

function onVideoReady() {
  const video = state.video;
  if (!video) return;

  // 更新当前分P的实际时长（切换中跳过：新源加载期间的 duration 属于新旧分P的中间态，
  // 写入会污染 pages[currentIndex].duration 进而破坏 cumulative 总时间线）
  if (!state.switching && video.duration && isFinite(video.duration)) {
    if (state.pages[state.currentIndex]) {
      state.pages[state.currentIndex].duration = video.duration;
    }
    computeCumulative();
    updateUnifiedProgress();
  }

  updatePartIndicator();
}

/** 缓冲区间变化时刷新进度条上的缓冲显示 */
function onVideoProgress() {
  updateUnifiedProgress();
}

function onTimeUpdate() {
  const video = state.video;
  if (!video || state.switching) return;
  if (state.restoringProgress) return; // 进度恢复期间不触发跳过/预取，避免和 restoreProgress 打架

  const currentTime = video.currentTime;
  const duration = video.duration || (state.pages[state.currentIndex] || {}).duration || 0;

  // 观影统计：累计实际观看秒数（seek 跳动 >5s 或回退不计）
  const wd = currentTime - state.lastWatchTick;
  if (state.lastWatchTick > 0 && wd >= 0.1 && wd <= 5) {
    state.watchAccum += wd;
  }
  state.lastWatchTick = currentTime;

  // 跳过片头（非第一P时；时长按视频独立配置，回退全局默认）
  const introDur = getIntroDuration();
  if (settings.skipIntro && state.currentIndex > 0 && introDur > 0) {
    if (currentTime < introDur && currentTime >= 0 && duration > introDur * 2) {
      video.currentTime = introDur;
      log(`跳过片头 ${introDur}s`);
    }
  }

  // 跳过片尾（自动切换到下一P）
  const outroDur = getOutroDuration();
  if (settings.skipOutro && outroDur > 0 && duration > outroDur * 2) {
    if (currentTime >= duration - outroDur && state.currentIndex < state.pages.length - 1) {
      log(`跳过片尾 ${outroDur}s，切换下一P`);
      goToNextPart();
      return;
    }
  }

  // 跳过用户指定的片段（Alt+[ 标记）
  checkSkipSegments();

  // 无缝电影：片尾 0.6s 钉末帧；再提前 ~0.35s 开切，别等 ended 才动手（那是卡顿主因）
  if (settings.seamlessMovie !== false && settings.autoPlayNext
      && state.currentIndex < state.pages.length - 1
      && duration > 2 && (duration - currentTime) >= 0) {
    const remain = duration - currentTime;
    if (remain <= 0.6 && !state.freezeArmed) {
      state.freezeArmed = true;
      if (typeof freezeFrame === 'function') freezeFrame();
    }
    if (remain <= 0.35 && !state.switching) {
      goToNextPart();
      return;
    }
  }

  // 预取下一分P/下一集（剩余 < 60 秒、且当前已播放 ≥ 15 秒才启动——
  // 避免短分P一开始播放就预取，与当前播放抢带宽；切换时命中缓存秒开）
  if (settings.preloadNext && duration - currentTime < 60 && currentTime >= 15) {
    preloadNextPart();
  }

  // B2 提前预取：缓冲充足（readyState>=3 且缓冲末端领先当前 ≥25s）时立即预取，
  // 不必等剩余 <60s 才触发（preloadedCid 已去重，只会发一次请求）
  if (settings.preloadNext && video.readyState >= 3 && currentBufferedEnd() - currentTime >= 25) {
    preloadNextPart();
  }

  // 播放完毕自动关闭标签页（仅最后P临近结束时触发一次）
  if (settings.autoCloseTab) {
    maybeSuggestCloseTab();
  }

  // 节流捕获播放器设置（约每 1 秒一次，避免频繁查询 DOM）
  state.captureTick = (state.captureTick || 0) + 1;
  if (state.captureTick % 4 === 0) {
    captureQualityText();
    captureDanmakuState();
  }

  // 更新统一进度条
  updateUnifiedProgress();

  // 关灯遮罩跟随播放器位置（布局可能变化）
  updateLightsOut();

  // 定期保存进度（每 5 秒）
  if (Math.abs(currentTime - lastSavedTime) >= 5) {
    lastSavedTime = currentTime;
    saveProgress();
  }
}

function onVideoEnded() {
  if (state.switching) return; // 无缝提前切已经在飞，ended 不再重入
  if (!settings.autoPlayNext) return;
  if (state.currentIndex < state.pages.length - 1) {
    log(`第 ${state.currentIndex + 1} P 播放完毕，自动切换`);
    goToNextPart();
  } else {
    log('全部播放完毕');
    // 立即暂停当前视频 + 尽力关闭 B站原生"自动连播"，防止原生结束卡/推荐导航劫持片尾卡
    const endedVideo = state.video;
    if (endedVideo) {
      try { endedVideo.pause(); } catch (e) { console.debug('[cinema] pause error:', e); }
    }
    suppressNativeAutoplay();
    showTransition('放映结束', true);
    showFinishedActions(); // 提供 重新播放 / 合集首页 / 关闭
    maybeSuggestCloseTab(); // 最后P：提示自动关闭标签页
  }
}

/**
 * 最后P播完时尽力关闭 B站原生"自动连播/连续播放"开关，防止原生结束卡被推荐页劫持。
 * 纯尽力而为：找不到相关控件时静默返回，绝不抛出。
 */
function suppressNativeAutoplay() {
  const KEYWORDS = ['自动连播', '连续播放', '播完暂停', '自动播放'];

  // 在设置面板/结束面板的开关项中查找匹配关键词的开关：开启状态则点击关闭，已关则不动
  const findAndToggle = () => {
    const items = document.querySelectorAll(
      '.bpx-player-setting-item, ' +
      '.bpx-player-setting-switch, ' +
      '[class*="setting"] [class*="switch"], ' +
      '.bpx-player-end-panel [class*="switch"], ' +
      '.video-end-panel [class*="switch"]'
    );
    for (const el of items) {
      const text = (el.textContent || '').trim();
      if (!KEYWORDS.some((k) => text.includes(k))) continue;
      const sw = el.classList.contains('bpx-player-setting-switch')
        ? el
        : (el.querySelector('.bpx-player-setting-switch') || el);
      const on = sw.classList.contains('bpx-state-entered') || sw.classList.contains('on');
      if (on) sw.click(); // 关闭自动连播
      return true; // 已处理（无论是否需要点击）
    }
    return false;
  };

  try {
    // 1) 直接查找（设置面板可能已渲染/已打开）
    if (findAndToggle()) return;
    // 2) 设置面板未渲染：点开面板再查一次，随后还原面板状态
    const settingBtn = document.querySelector('.bpx-player-ctrl-setting');
    if (!settingBtn) return;
    settingBtn.click();
    setTimeout(() => {
      try {
        findAndToggle();
        const b2 = document.querySelector('.bpx-player-ctrl-setting');
        if (b2) b2.click(); // 关闭设置面板
      } catch { /* 静默 */ }
    }, 400);
  } catch { /* 静默 */ }
}

// ============================================================
//  分P切换
// ============================================================

async function goToNextPart() {
  if (state.switching) return;
  if (state.currentIndex >= state.pages.length - 1) return;

  // 新的切换动作开始时收起可能残留的失败恢复卡片，并清除失败恢复轮询看护
  if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
  if (state.switchRecoveryPoll) { clearInterval(state.switchRecoveryPoll); state.switchRecoveryPoll = null; }
  state.switching = true;
  const nextIndex = state.currentIndex + 1;
  const nextPart = state.pages[nextIndex];
  cancelPrefetch({ keepCid: nextPart && nextPart.cid }); // 下一P预取保留，供秒开

  try {
    applyTempP2PBlock(); // 切P窗口临时屏蔽 P2P，保证预取字节命中

    // 先钉末帧再暂停：冻帧盖住之后才能停，否则先黑再贴图
    const curVideo = state.video;
    if (typeof freezeFrame === 'function') freezeFrame();
    if (curVideo && !curVideo.paused) {
      try { curVideo.pause(); } catch (e) { console.debug('[cinema] pause error:', e); }
    }

    // 无缝且下一P已预取：不淡出（200ms 静音本身就是一截卡顿）；否则短淡
    const nextCid = nextPart && nextPart.cid;
    const prefetchHot = nextCid && state.prefetchOkCid === nextCid;
    if (!(useSeamlessCover() && prefetchHot)) {
      fadeOutVolume(curVideo || state.video, useSeamlessCover() ? 80 : 200);
    }

    // 记录当前显示模式（普通/宽屏/网页全屏/全屏）
    state.displayMode = await getPlayerDisplayMode();

    log(`切换到 第${nextPart.page}集: ${nextPart.part}`);

    // 无缝电影：不插幕间卡。仅在关闭无缝且打开过渡时显示「第N幕」
    if (settings.showTransition && !useSeamlessCover()) {
      showTransition(`第${nextPart.page}集 · ${nextPart.part}`);
    }

    // 保存当前进度
    saveProgress();

    let ok = false;
    if (state.mode === 'season') {
      // 合集模式：跳转到对应 bvid
      const targetBvid = nextPart.bvid || (state.seasonEpisodes[nextIndex] && state.seasonEpisodes[nextIndex].bvid);
      const switched = tryClickSeasonEpisode(nextIndex);
      if (!switched) {
        sessionStorage.setItem('cinemaDisplayMode', state.displayMode);
        location.href = `https://www.bilibili.com/video/${targetBvid}`;
        return; // 即将离开当前页，finally 会清理 switching
      }
      ok = await waitForVideoChangeSeason(nextIndex);
    } else {
      // 分P模式：优先用播放器内部 API（不重建播放器，保持全屏/网页全屏/宽屏）
      const apiOk = await switchPartViaPlayerAPI(nextPart.page);
      if (apiOk) {
        ok = await waitForPlayerAPISwitch(nextIndex);
      } else {
        const switched = tryClickNextPart(nextIndex);
        if (!switched) {
          sessionStorage.setItem('cinemaDisplayMode', state.displayMode);
          const url = `https://www.bilibili.com/video/${state.bvid}?p=${nextPart.page}`;
          location.href = url;
          return; // 即将离开当前页，finally 会清理 switching
        }
        ok = await waitForVideoChange(nextIndex);
      }
    }

    // 切换失败：收起过渡视觉并展示恢复卡片（不保留 switching 锁，交给用户选择）
    if (ok === false) {
      log('分P切换失败，展示恢复操作');
      hideTransition();
      if (typeof unfreezeFrame === 'function') unfreezeFrame();
      state.freezeArmed = false;
      if (typeof hidePrefetchStatus === 'function') hidePrefetchStatus();
      // 还原淡出遗留的静音（失败路径不经过 armAudioFadeIn）：用淡入平滑恢复原音量，
      // 避免直接 unmute 造成"砰"的爆音（B6）；fadeSnapshot 已清则跳过
      if (state.fadeSnapshot && state.video) {
        fadeInVolume(state.video, 200);
      }
      if (typeof showSwitchRecovery === 'function') showSwitchRecovery(nextIndex);
      armSwitchRecoveryWatch(nextIndex); // 晚到成功看护：B站可能晚于超时窗口才完成导航
      return;
    }

    // 恢复显示模式（内部 API 切换时通常无需恢复，仅作为回退路径的保险）
    restoreDisplayMode(state.displayMode);

    // 音频淡入与视觉解耦：落地后立即归零音量并武装淡入（P2 真正播放时淡回原音量）。
    // 必须先于 restorePlayerPrefs——否则音量被提前设回，幕间 hold 期间以全音量播出，
    // 再被归零淡回，出现"突入→跌落"伪淡入（ora-1 复查发现）
    armAudioFadeIn();

    // 恢复播放器设置（倍速等，内部 API 切换后 B站可能重置；音量段在淡入期间由 armAudioFadeIn 接管）
    restorePlayerPrefs();
    syncBridgeConfig(); // 更新桥接脚本的 currentCid（播放器请求当前P的 playurl 时不命中缓存）

    // 等新分P首帧再撤冻帧/幕间（无缝电影也要等，否则会露黑屏）
    await holdTransitionUntilFrame(3500);
    if (typeof unfreezeFrame === 'function') unfreezeFrame();
    state.freezeArmed = false;

    // 切换开始即隐藏预取指示器（指示的是"上一集的下一P"）
    if (typeof hidePrefetchStatus === 'function') hidePrefetchStatus();

    // 预取状态重置：下一P已变化，允许重新预取
    state.preloadedCid = null;
    state.preloadFailCount = 0;

    // 弹幕预热：按记忆开关状态校准弹幕按钮，容器空则强制重载弹幕流
    prewarmDanmaku();

    // 链式预取：落地新分P后立即预取下一集（连续观影场景不必等到剩余 60 秒）
    setTimeout(() => preloadNextPart(), 800);
  } finally {
    state.switching = false;
  }
}

function tryClickNextPart(targetIndex) {
  // 尝试多种选择器找到分P列表中的对应链接
  // 新版选集面板：优先用 cid 精确匹配（.video-pod__item 的 data-key 即 cid），
  // 避免全局 nth-child 误命中页面推荐区其他视频的选集（实测推荐区也是 .video-pod__item）
  const targetPart = state.pages[targetIndex];
  const targetPage = targetPart ? targetPart.page : (targetIndex + 1);
  if (targetPart && targetPart.cid) {
    const elByCid = document.querySelector(`.video-pod__item[data-key="${targetPart.cid}"]`);
    if (elByCid) {
      elByCid.click();
      return true;
    }
  }

  const selectors = [
    // 新版播放器内分P列表
    `.bpx-player-ep-item[data-ep="p${targetPage}"]`,
    `.bpx-player-ep-item:nth-child(${targetPage})`,
    // 新版视频下方选集面板（新版 B 站：.video-pod__item 是 div 且内部无 <a>，需直接点击 div）
    `.video-pod__item:nth-child(${targetPage})`,
    // 旧版视频下方分P列表
    `.list-box li[data-page="${targetPage}"] a`,
    `.list-box a[href*="p=${targetPage}"]`,
    // 旧版选集面板（带 a 标签的兼容写法）
    `.video-pod__item:nth-child(${targetPage}) a`,
    `.multi-page .list-box a[href*="p=${targetPage}"]`,
    // 通用：包含 p=N 的链接（B站可能把 p 放在 URL 末尾：?a=b&p=N）
    `a[href*="/video/${state.bvid}"][href*="p=${targetPage}"]`,
    `a[href*="/video/${state.bvid}"][href*="&p=${targetPage}"]`,
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      el.click();
      return true;
    }
  }

  // 最后尝试：遍历所有链接
  const links = document.querySelectorAll('a[href*="/video/"]');
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    if (href.includes(state.bvid) && href.includes(`p=${targetPage}`)) {
      a.click();
      return true;
    }
  }

  return false;
}

/**
 * 播放器内部 API 切换后等待新分P就绪
 * 视频元素不变但源更换：通过 loadedmetadata + 时长匹配 + URL p 参数变化综合判断
 * @returns {Promise<boolean>} true=真正确认目标分P就绪；false=超时且从未确认（调用方需做失败恢复）
 */
function waitForPlayerAPISwitch(expectedIndex) {
  return new Promise((resolve) => {
    const expectedDuration = state.pages[expectedIndex] ? state.pages[expectedIndex].duration : 0;
    let done = false;
    let verified = false; // 是否真正确认过目标分P就绪（page+duration 匹配）
    let metaTimer = null;

    const finish = (ok) => {
      if (done) return;
      done = true;
      if (state.video) state.video.removeEventListener('loadedmetadata', onMeta);
      if (metaTimer) clearTimeout(metaTimer);
      if (ok) {
        // 仅确认成功才乐观设置 currentIndex / 恢复播放；硬失败保持原索引，交调用方恢复
        state.currentIndex = expectedIndex;
        tryAutoPlay();
        updatePartIndicator();
        updateUnifiedProgress();
      }
      resolve(ok);
    };

    // 新源元数据加载完成后，验证时长与 URL p 参数双匹配目标分P
    // 仅时长匹配但页面尚未切到目标分P时不得提前判定成功（ora-1 复查发现）
    const onMeta = () => {
      metaTimer = setTimeout(() => {
        const v = state.video;
        if (!v) return;
        if (getCurrentPage() === expectedIndex + 1 && (expectedDuration <= 0 || Math.abs(v.duration - expectedDuration) < 3)) {
          verified = true;
          finish(true);
        }
      }, 50);
    };
    if (state.video) state.video.addEventListener('loadedmetadata', onMeta);

    // 轮询兑底：URL p 参数变化 / 视频元素被替换
    let attempts = 0;
    const poll = () => {
      if (done) return;
      attempts++;

      // 视频元素可能被替换
      const v = findVideo();
      if (v && v !== state.video) {
        detachVideoListeners();
        state.video = v;
        attachVideoListeners();
      }

      if (getCurrentPage() === expectedIndex + 1 && state.video && state.video.readyState >= 1) {
        // URL 已更新；若时长也匹配则立即完成，否则再等 metadata 验证
        if (expectedDuration <= 0 || Math.abs(state.video.duration - expectedDuration) < 3) {
          verified = true;
          finish(true);
          return;
        }
      }

      if (attempts >= 80) {
        // 8 秒兑底：仅当确实匹配过才视为成功，否则返回 false（由调用方展示失败恢复）
        finish(verified);
        return;
      }
      setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
  });
}

/** 合集模式：尝试点击选集面板中的对应剧集 */
function tryClickSeasonEpisode(targetIndex) {
  const targetEp = state.seasonEpisodes[targetIndex];
  if (!targetEp) return false;
  const targetBvid = targetEp.bvid;

  // 方法 1：通过 bvid 匹配链接
  if (targetBvid) {
    const links = document.querySelectorAll('a[href*="/video/"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (href.includes(targetBvid)) {
        a.click();
        return true;
      }
    }
  }

  // 方法 2：通过选集面板选择器
  const selectors = [
    '.video-sections-list .video-episode-card',
    '.episode-list-panel .episode-item',
    '.video-pod__item',
    '[class*="season"] a[href*="/video/"]',
    '[class*="episode"] a[href*="/video/"]',
    '.video-section-block a[href*="/video/"]',
  ];

  for (const sel of selectors) {
    const items = document.querySelectorAll(sel);
    if (items.length > targetIndex) {
      const el = items[targetIndex].querySelector('a') || items[targetIndex];
      el.click();
      return true;
    }
  }

  return false;
}

/**
 * 等待分P切换落地（通过 URL p 参数 + 视频元素变化判断）
 * @returns {Promise<boolean>} true=切换成功或已发起整页跳转（离开当前页）；false=超时且无恢复手段
 */
function waitForVideoChange(expectedIndex) {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 100; // 最多等 10 秒

    const check = () => {
      attempts++;
      const newPage = getCurrentPage();

      if (newPage === expectedIndex + 1) {
        // URL 已更新，等待视频元素就绪
        const video = findVideo();
        if (video && video !== state.video) {
          detachVideoListeners();
          state.video = video;
          state.currentIndex = expectedIndex;
          attachVideoListeners();
          tryAutoPlay();
          updatePartIndicator();
          updateUnifiedProgress();
          resolve(true);
          return;
        }
        // 视频元素可能还没换，继续等
        if (video && video.readyState >= 1) {
          state.currentIndex = expectedIndex;
          tryAutoPlay();
          updatePartIndicator();
          updateUnifiedProgress();
          resolve(true);
          return;
        }
      }

      if (attempts >= maxAttempts) {
        log('等待视频切换超时，尝试刷新');
        sessionStorage.setItem('cinemaDisplayMode', state.displayMode);
        location.href = `https://www.bilibili.com/video/${state.bvid}?p=${expectedIndex + 1}`;
        resolve(true); // 已发起整页跳转（即将离开当前页），按已处理返回
        return;
      }

      setTimeout(check, 100);
    };

    check();
  });
}

/**
 * 合集模式：等待视频切换（通过检测 bvid 变化）
 * @returns {Promise<boolean>} true=切换成功或已发起整页跳转；false=超时且无目标 bvid 可恢复
 */
function waitForVideoChangeSeason(expectedIndex) {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 100;
    const expectedBvid = state.seasonEpisodes[expectedIndex]
      ? state.seasonEpisodes[expectedIndex].bvid
      : '';

    const check = () => {
      attempts++;
      const currentBvid = getBvid();

      if (expectedBvid && currentBvid === expectedBvid) {
        const video = findVideo();
        if (video && video.readyState >= 1) {
          if (video !== state.video) {
            detachVideoListeners();
            state.video = video;
            attachVideoListeners();
          }
          state.currentIndex = expectedIndex;
          state.bvid = currentBvid;
          tryAutoPlay();
          updatePartIndicator();
          updateUnifiedProgress();
          resolve(true);
          return;
        }
      }

      if (attempts >= maxAttempts) {
        log('等待合集视频切换超时，尝试直接跳转');
        if (expectedBvid) {
          sessionStorage.setItem('cinemaDisplayMode', state.displayMode);
          location.href = `https://www.bilibili.com/video/${expectedBvid}`;
          resolve(true); // 已发起整页跳转（即将离开当前页），按已处理返回
        } else {
          resolve(false); // 无目标 bvid，无法恢复
        }
        return;
      }

      setTimeout(check, 100);
    };

    check();
  });
}

/**
 * 等待新分P首帧后再揭冻帧。
 * 无缝电影：预取命中则 0ms 下限（首帧立刻揭），未命中最多垫 80ms；
 * 非无缝仍用 150/400ms 防幕间闪一下。
 */
function holdTransitionUntilFrame(maxMs) {
  return new Promise((resolve) => {
    const video = state.video;
    const started = Date.now();
    const targetCid = state.pages[state.currentIndex] && state.pages[state.currentIndex].cid;
    const prefetched = !!(targetCid && state.prefetchOkCid === targetCid);
    const seamless = settings.seamlessMovie !== false;
    const minHold = seamless ? (prefetched ? 0 : 80) : (prefetched ? 150 : 400);
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      hideTransition();
      resolve();
    };

    const hasFrame = (v) => {
      if (!v || v.readyState < 2) return false;
      if (prefetched && seamless) return true;
      return v.currentTime > 0 || !v.paused;
    };

    const onFrame = () => {
      if (hasFrame(state.video) && Date.now() - started >= minHold) finish();
    };

    const poll = setInterval(onFrame, 50);
    const timeout = setTimeout(finish, maxMs || 3500);

    function cleanup() {
      clearInterval(poll);
      clearTimeout(timeout);
      if (video) {
        video.removeEventListener('playing', onFrame);
        video.removeEventListener('timeupdate', onFrame);
        video.removeEventListener('canplay', onFrame);
      }
    }

    if (video) {
      video.addEventListener('playing', onFrame);
      video.addEventListener('timeupdate', onFrame);
      video.addEventListener('canplay', onFrame);
    }
    onFrame(); // 预取命中时可能已经有帧，立刻揭，别再空等 50ms
  });
}

/** 音量渐变到 0（切P前淡出 P1，避免声音硬切） */
function fadeOutVolume(video, ms) {
  state.fadeSnapshot = null; // 每次切P先清快照：静音/音量0早退时不得沿用旧快照（防静音用户被误淡入）
  if (!video || video.muted || video.volume <= 0) return;
  state.fadeSnapshot = { volume: video.volume }; // 记录淡出快照：只有真正淡出过才允许淡入
  const startVol = video.volume;
  const steps = 10;
  const interval = ms / steps;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    video.volume = Math.max(0, startVol * (1 - i / steps));
    if (i >= steps) {
      clearInterval(timer);
      video.muted = true;
      video.volume = startVol; // 恢复 volume 值（muted 状态下不发声），淡入时 unmute
    }
  }, interval);
}

/** 音量从 0 渐回原值（P2 首帧就绪后淡入）；未淡出过（静音/音量0用户）则保持静音不强制出声 */
function fadeInVolume(video, ms) {
  if (!video) return;
  const snap = state.fadeSnapshot;
  if (!snap) return; // 未淡出过：静音/音量0用户，不得强制 unmute
  state.fadeSnapshot = null;
  const targetVol = snap.volume > 0 ? snap.volume : 1;
  video.muted = false;
  video.volume = 0;
  const steps = 10;
  const interval = ms / steps;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    video.volume = Math.min(targetVol, targetVol * (i / steps));
    if (i >= steps) clearInterval(timer);
  }, interval);
}

/**
 * 音频淡入与视觉解耦：P2 真正开始播放（playing 事件）时立即淡入，不再等待幕间卡 400ms 视觉下限。
 * 立即把 P2 音量归零（防止满音量突入），等 playing 触发后 200ms 淡回原值。
 */
function armAudioFadeIn() {
  const video = state.video;
  if (!video || !state.fadeSnapshot) return;
  video.muted = false;
  video.volume = 0;
  let done = false;
  const doFade = () => { if (done) return; done = true; fadeInVolume(video, 200); };
  if (!video.paused && video.readyState >= 2) { doFade(); return; }
  video.addEventListener('playing', doFade, { once: true });
  // 兜底：自动播放被拦或 playing 未触发时，1.5 秒后若未暂停仍恢复音量
  setTimeout(() => { if (!done && !video.paused) doFade(); }, 1500);
}

function tryAutoPlay() {
  const video = state.video;
  if (!video) return;

  const play = () => {
    video.play().catch(() => {
      // 自动播放被阻止，监听用户交互后重试
      const retry = () => {
        video.play().catch(() => {});
        document.removeEventListener('click', retry);
        document.removeEventListener('keydown', retry);
      };
      document.addEventListener('click', retry, { once: true });
      document.addEventListener('keydown', retry, { once: true });
    });
  };

  // 立即尝试播放（浏览器会在可播时自行开始），不再固定等待 300ms
  play();
}

/** 跳转到任意分P的指定偏移（进度条点击/拖拽、跳过片段跨P时使用） */
async function jumpToPart(targetIndex, offsetSeconds) {
  if (state.switching || targetIndex === state.currentIndex) {
    if (targetIndex === state.currentIndex && state.video) {
      state.video.currentTime = offsetSeconds;
    }
    return;
  }

  // 新的切换动作开始时收起可能残留的失败恢复卡片，并清除失败恢复轮询看护
  if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
  if (state.switchRecoveryPoll) { clearInterval(state.switchRecoveryPoll); state.switchRecoveryPoll = null; }
  state.switching = true;
  const targetPart = state.pages[targetIndex];
  cancelPrefetch({ keepCid: targetPart && targetPart.cid });

  try {
    applyTempP2PBlock(); // 切P窗口临时屏蔽 P2P，保证预取字节命中

    const curVideo = state.video;
    if (typeof freezeFrame === 'function') freezeFrame();
    if (curVideo && !curVideo.paused) {
      try { curVideo.pause(); } catch (e) { console.debug('[cinema] pause error:', e); }
    }

    // 记录当前显示模式（普通/宽屏/网页全屏/全屏）
    state.displayMode = await getPlayerDisplayMode();

    fadeOutVolume(curVideo || state.video, 200);

    if (settings.showTransition && !useSeamlessCover()) {
      showTransition(`第${targetPart.page}集 · ${targetPart.part}`);
    }

    saveProgress();

    let ok = false;
    if (state.mode === 'season') {
      const targetBvid = targetPart.bvid || (state.seasonEpisodes[targetIndex] && state.seasonEpisodes[targetIndex].bvid);
      const switched = tryClickSeasonEpisode(targetIndex);
      if (!switched) {
        sessionStorage.setItem('cinemaDisplayMode', state.displayMode);
        location.href = `https://www.bilibili.com/video/${targetBvid}`;
        return; // 即将离开当前页，finally 会清理 switching
      }
      ok = await waitForVideoChangeSeason(targetIndex);
    } else {
      // 分P模式：优先用播放器内部 API（不重建播放器，保持全屏/网页全屏/宽屏）
      const apiOk = await switchPartViaPlayerAPI(targetPart.page);
      if (apiOk) {
        ok = await waitForPlayerAPISwitch(targetIndex);
      } else {
        const switched = tryClickNextPart(targetIndex);
        if (!switched) {
          sessionStorage.setItem('cinemaDisplayMode', state.displayMode);
          location.href = `https://www.bilibili.com/video/${state.bvid}?p=${targetPart.page}`;
          return; // 即将离开当前页，finally 会清理 switching
        }
        ok = await waitForVideoChange(targetIndex);
      }
    }

    // 切换失败：收起过渡视觉并展示恢复卡片
    if (ok === false) {
      log('分P切换失败，展示恢复操作');
      hideTransition();
      if (typeof unfreezeFrame === 'function') unfreezeFrame();
      state.freezeArmed = false;
      if (typeof hidePrefetchStatus === 'function') hidePrefetchStatus();
      // 还原淡出遗留的静音（失败路径不经过 armAudioFadeIn）：用淡入平滑恢复原音量，
      // 避免直接 unmute 造成"砰"的爆音（B6）；fadeSnapshot 已清则跳过
      if (state.fadeSnapshot && state.video) {
        fadeInVolume(state.video, 200);
      }
      if (typeof showSwitchRecovery === 'function') showSwitchRecovery(targetIndex);
      armSwitchRecoveryWatch(targetIndex); // 晚到成功看护：B站可能晚于超时窗口才完成导航
      return;
    }

    if (state.video) {
      // 音频淡入与视觉解耦：播放前先归零音量并武装淡入（P2 真正播放时淡回原音量，避免突入→跌落）
      armAudioFadeIn();
      state.video.currentTime = offsetSeconds;
      tryAutoPlay();
    }

    // 恢复显示模式（内部 API 切换时通常无需恢复，仅作为回退路径的保险）
    restoreDisplayMode(state.displayMode);
    syncBridgeConfig(); // 更新桥接脚本的 currentCid

    await holdTransitionUntilFrame(3500);
    if (typeof unfreezeFrame === 'function') unfreezeFrame();
    state.freezeArmed = false;

    // 切换开始即隐藏预取指示器（指示的是旧的预取目标）
    if (typeof hidePrefetchStatus === 'function') hidePrefetchStatus();

    // 预取状态重置：目标P已变化，允许重新预取
    state.preloadedCid = null;
    state.preloadFailCount = 0;

    // 弹幕预热：按记忆开关状态校准弹幕按钮，容器空则强制重载弹幕流
    prewarmDanmaku();

    // 链式预取：落地新分P后立即预取下一集（连续观影场景不必等到剩余 60 秒）
    setTimeout(() => preloadNextPart(), 800);
  } finally {
    state.switching = false;
  }
}

/**
 * 切P失败恢复卡展示后的晚到成功看护：B站可能晚于切换超时窗口才完成实际导航
 * （后台重试 / SPA 导航慢完成）。约 4 秒内每 300ms 轮询一次页面是否已切到目标分P/剧集，
 * 命中则按成功路径恢复：更新 currentIndex、收起恢复卡、恢复播放与进度指示。
 * 定时器 id 挂在 state.switchRecoveryPoll，新的切换/隐藏恢复卡时由调用方清除。
 */
function armSwitchRecoveryWatch(targetIndex) {
  if (state.switchRecoveryPoll) {
    clearInterval(state.switchRecoveryPoll);
    state.switchRecoveryPoll = null;
  }
  const started = Date.now();
  state.switchRecoveryPoll = setInterval(() => {
    try {
      if (Date.now() - started > 4000) {
        clearInterval(state.switchRecoveryPoll);
        state.switchRecoveryPoll = null;
        return;
      }

      // 命中判定：分P模式看 URL p 参数；合集模式看 bvid
      let pageMatched = false;
      if (state.mode === 'season') {
        const expectedBvid = state.seasonEpisodes[targetIndex] && state.seasonEpisodes[targetIndex].bvid;
        pageMatched = !!expectedBvid && getBvid() === expectedBvid;
      } else {
        pageMatched = getCurrentPage() === targetIndex + 1;
      }

      const video = state.video || findVideo();
      if (pageMatched && video && video.readyState >= 1) {
        clearInterval(state.switchRecoveryPoll);
        state.switchRecoveryPoll = null;
        state.currentIndex = targetIndex;
        if (typeof hideSwitchRecovery === 'function') hideSwitchRecovery();
        // 晚到成功：先照常恢复播放；若切换时曾淡出音量，用淡入平滑恢复（避免爆音，B6）
        tryAutoPlay();
        if (state.fadeSnapshot) armAudioFadeIn();
        updatePartIndicator();
        updateUnifiedProgress();
        syncBridgeConfig(); // 更新桥接脚本 currentCid（B7）
        if (typeof prewarmDanmaku === 'function') prewarmDanmaku();
      }
    } catch (e) {
      console.debug('[cinema] recovery watch error:', e);
    }
  }, 300);
}

// ============================================================
//  进度恢复
// ============================================================

async function restoreProgress() {
  const progress = await loadProgress(state.bvid);
  if (!progress) return;

  // 超过 7 天的进度不恢复
  if (Date.now() - progress.ts > 7 * 24 * 3600 * 1000) return;

  const targetPartIndex = progress.part - 1;
  if (targetPartIndex < 0 || targetPartIndex >= state.pages.length) return;

  // B11/Important #4：单集视频（无分P）只恢复播放位置，不做分P跳转（part 必为 1，自然跳过下方跳转分支）。
  // 进度记录 bvid 字段缺失/为空时，仅当读取键确为当前视频（getProgressKey()===state.bvid）才恢复；
  // bvid 存在但与当前不一致则跳过（避免把别的视频的进度误套到本视频上）。
  const singlePage = state.pages.length <= 1;
  if (singlePage) {
    if (progress.bvid && progress.bvid !== state.bvid) return;
    if (!progress.bvid && getProgressKey() !== state.bvid) return;
  }

  // 标记正在恢复进度：阻止 onNavigate（B站"继续播放"提示改 ?p=）与 onTimeUpdate（片头/片尾跳过）干扰
  state.restoringProgress = true;

  if (targetPartIndex !== state.currentIndex) {
    log(`恢复进度：跳转到 第${progress.part}集`);
    state.switching = true; // 阻止 onNavigate 抢夺 currentIndex
    try {
      if (state.mode === 'season') {
        const switched = tryClickSeasonEpisode(targetPartIndex);
        if (switched) {
          await waitForVideoChangeSeason(targetPartIndex);
        }
      } else {
        const switched = tryClickNextPart(targetPartIndex);
        if (switched) {
          await waitForVideoChange(targetPartIndex);
        }
      }
    } finally {
      state.switching = false;
    }
  }

  // 恢复播放位置
  if (state.video && progress.time > 0) {
    const seekTo = () => {
      if (state.video && state.video.readyState >= 1) {
        // 留 2 秒缓冲，避免 seek 到精确位置时卡顿
        state.video.currentTime = Math.max(0, progress.time - 2);
        tryAutoPlay();
        log(`恢复播放位置: ${formatTime(progress.time)}`);
      }
    };
    if (state.video.readyState >= 1) {
      seekTo();
    } else {
      state.video.addEventListener('loadedmetadata', seekTo, { once: true });
    }
  }

  // 恢复完成后延迟清除标记（给 seek 和 B站"继续播放"提示一个缓冲窗口）
  setTimeout(() => { state.restoringProgress = false; }, 2000);
}
