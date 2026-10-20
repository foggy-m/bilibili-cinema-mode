/**
 * B站影院模式 - 工具栏弹窗
 * 数据来自 background 的 getPopupData 消息（并行开发的核心提供）：
 * { settings, current: {bvid,title,pic,url}|null, history: [], bookmarks: [] }
 * 防御式编码：消息缺失/字段缺失时全部降级为空状态，不影响弹窗渲染。
 */

'use strict';

const $ = (sel) => document.querySelector(sel);

// 转义与时长格式化复用 cinema-utils.js 的同一实现（popup.html 已先于本文件加载）。
// 顺带修正一处既有缺陷：本地 fmtTime 只会输出 mm:ss，65 分钟的视频会显示成「65:00」；
// utils.formatTime 对超过 1 小时的时长输出 h:mm:ss。
const esc = escapeHtml;
const fmtTime = formatTime;

/** 从 URL 提取 bvid（无则返回空串） */
function extractBvid(url) {
  const m = /\/video\/(BV[\w]+)/.exec(url || '');
  return m ? m[1] : '';
}

/** 历史条目 → 打开地址（合集不带 ?p=，分P带 ?p=part） */
function historyUrl(item) {
  let url = `https://www.bilibili.com/video/${item.bvid}`;
  if (item.mode !== 'season' && item.part > 1) url += `?p=${item.part}`;
  return url;
}

/** 打开视频（新标签页） */
function openVideo(bvid, part) {
  if (!bvid) return;
  let url = `https://www.bilibili.com/video/${bvid}`;
  if (part && part > 1) url += `?p=${part}`;
  chrome.tabs.create({ url });
}

/** 封面图节点（无图或非 http(s) 时退化为首字母占位） */
function picHtml(pic, cls) {
  if (pic && /^https?:\/\//i.test(pic)) {
    return `<div class="${cls}"><img src="${esc(pic)}" loading="lazy" referrerpolicy="no-referrer"></div>`;
  }
  return `<div class="${cls}">B</div>`;
}

// MV3 扩展页 CSP（script-src 'self'）会拦截内联 onerror，改用捕获阶段委托处理封面加载失败
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.parentElement && /cinema-popup-item-pic/.test(img.parentElement.className || '')) {
    img.parentElement.innerHTML = 'B';
  }
}, true);

// ============================================================
//  渲染
// ============================================================

function render(data) {
  data = data || {};
  const settings = data.settings || {};

  // 主题（theme 键已删，永远跟随系统）：系统浅色偏好时用浅色令牌
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.body.classList.toggle('theme-light', prefersLight);

  // 启用开关
  const toggle = $('#cinema-enable-toggle');
  if (toggle) {
    toggle.checked = settings.enabled !== false;
    toggle.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: 'setEnabled', enabled: toggle.checked });
    });
  }

  // 当前视频（融合历史记录信息以补充封面与进度）
  renderCurrent(data.current || data.tab, data.bookmarks || [], data.history || []);

  // 最近观看（最多 8 条）
  renderRecent((data.history || []).slice(0, 8));

  // 收藏（最多 8 条）
  renderBookmarks((data.bookmarks || []).slice(0, 8));
}

/** 当前视频卡片：优先用后台返回的 current；缺失时自行从活动标签页 URL 兜底 */
function renderCurrent(current, bookmarks, history) {
  const section = $('#cinema-current-section');
  if (!section) return;
  if (!current || !current.bvid) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        const bvid = extractBvid(tab && tab.url);
        if (!bvid) { section.style.display = 'none'; return; }
        buildCurrent({
          bvid,
          title: (tab.title || '').replace(/_哔哩哔哩.*/, '') || bvid,
          pic: '',
        }, bookmarks, history);
      });
    } catch { section.style.display = 'none'; }
    return;
  }
  buildCurrent(current, bookmarks, history);
}

function buildCurrent(current, bookmarks, history) {
  const section = $('#cinema-current-section');
  if (section) section.style.display = 'block';

  // 查找历史记录中是否有该视频的封面与进度
  const histItem = (history || []).find((h) => h && h.bvid === current.bvid);
  const picUrl = (current.pic && /^https?:\/\//i.test(current.pic)) ? current.pic : (histItem && histItem.pic) || '';

  const backdrop = $('#cinema-current-backdrop');
  if (backdrop) {
    if (picUrl) {
      backdrop.style.backgroundImage = `url('${esc(picUrl)}')`;
    } else {
      backdrop.style.background = 'linear-gradient(135deg, #1e293b, #0f172a)';
    }
  }

  const titleEl = $('#cinema-current-title');
  if (titleEl) {
    const rawTitle = (current.title && current.title !== current.bvid)
      ? current.title
      : ((histItem && histItem.title) || current.bvid);
    titleEl.textContent = rawTitle.replace(/_哔哩哔哩.*/, '');
  }

  const subEl = $('#cinema-current-sub');
  const progRow = $('#cinema-hero-prog-row');
  const fillEl = $('#cinema-hero-fill');
  const pctEl = $('#cinema-hero-pct');

  if (histItem && histItem.time > 0) {
    const partInfo = histItem.totalParts > 1 ? `第 ${histItem.part || 1}/${histItem.totalParts} 集 · ` : '';
    // watched 是跨会话累计的实际观看秒数（一直在采集，v1.16 才接上 UI）；
    // formatDurationCN 对 0/非法值返回空串 → 没有该数据时不多出一段噪音文案
    const watchedText = formatDurationCN(histItem.watched);
    if (subEl) {
      subEl.textContent = `${partInfo}播放至 ${fmtTime(histItem.time)}`
        + (watchedText ? ` · 累计观影 ${watchedText}` : '');
    }

    // overallTime = 电影内绝对位置，totalDuration = 电影总长（time 是 P 内时间，多P下不可直接相除）
    // 旧记录无 overallTime：单P视频 time 与之等价可兜底，多P无法换算则不算百分比
    const pos = histItem.overallTime != null
      ? histItem.overallTime
      : (histItem.totalParts > 1 ? null : histItem.time);
    let pct = 0;
    if (pos != null && histItem.totalDuration > 0) {
      pct = Math.min(100, Math.round((pos / histItem.totalDuration) * 100));
    }
    // 算不出真实百分比时不画假进度（旧多P记录无 overallTime）：
    // 用户会把条长读作进度，编造的兜底宽度等于给出错误信息。
    // 副标题「第 X/Y 集 · 播放至 mm:ss」已如实说明位置，收起整行不损失信息。
    if (progRow) progRow.style.display = pct > 0 ? 'flex' : 'none';
    if (pct > 0) {
      if (fillEl) fillEl.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    }
  } else {
    if (subEl) subEl.textContent = '点击继续观影 · 自动沉浸放映';
    if (progRow) progRow.style.display = 'none';
  }

  const openBtn = $('#cinema-current-open');
  if (openBtn) {
    // 有观影记录时跟「最近放映」走同一条地址（分P带 ?p=，合集不带）。
    // 只开 bvid 会落到 P1，再靠进度恢复去点真正的那一集。
    openBtn.onclick = () => {
      chrome.tabs.create({ url: histItem ? historyUrl(histItem) : historyUrl({ bvid: current.bvid }) });
    };
  }

  const bmBtn = $('#cinema-current-bookmark');
  if (bmBtn) {
    let bookmarked = (bookmarks || []).some((b) => b && b.bvid === current.bvid);
    const bmText = bmBtn.querySelector('.cinema-hero-bm-text');
    const refresh = () => {
      if (bmText) bmText.textContent = bookmarked ? '已收藏' : '收藏';
      bmBtn.classList.toggle('active', bookmarked);
    };
    refresh();
    bmBtn.onclick = () => {
    chrome.runtime.sendMessage({
      type: 'toggleBookmark',
      bvid: current.bvid,
      title: (histItem && histItem.title) || current.title || '',
      pic: picUrl || '',
      // 弹窗里没有播放器，只能借用观影记录里已经算好的位置。
      // 没有记录就不传：收藏打开后走片头，不编一个假的分P。
      part: histItem && histItem.part,
      overallTime: histItem && histItem.overallTime,
      mode: histItem && histItem.mode,
      }, (res) => {
        if (res && typeof res.bookmarked === 'boolean') bookmarked = res.bookmarked;
        else bookmarked = !bookmarked;
        refresh();
      });
    };
  }
}

/** 列表行公共构建（「最近放映」与「收藏」此前各复制一份）
 * @param {object} item             需含 bvid（title/pic 可选）
 * @param {string} [sub]            副标题文本；空则不渲染副标题行
 * @param {() => void} onOpen       点击或键盘激活时的打开动作
 * @param {(row: HTMLElement) => void} [onRemove] 提供时在行尾追加「取消」按钮 */
function buildListRow(item, sub, onOpen, onRemove) {
  const row = document.createElement('div');
  row.className = 'cinema-popup-item';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', '打开 ' + (item.title || item.bvid));

  row.innerHTML = `
    ${picHtml(item.pic, 'cinema-popup-item-pic')}
    <div class="cinema-popup-item-info">
      <div class="cinema-popup-item-title">${esc(item.title)}</div>
      ${sub ? `<div class="cinema-popup-item-sub">${esc(sub)}</div>` : ''}
    </div>
    ${onRemove
      ? `<button type="button" class="cinema-popup-item-remove" title="取消收藏" aria-label="取消收藏 ${esc(item.title || item.bvid)}">&times;</button>`
      : ''}
  `;

  const activate = (e) => {
    // 行内取消按钮的点击不算「打开」
    if (e.target.closest && e.target.closest('.cinema-popup-item-remove')) return;
    e.preventDefault();
    onOpen();
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') activate(e);
  });

  if (onRemove) {
    row.querySelector('.cinema-popup-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove(row);
    });
  }
  return row;
}

/** 最近观看列表 */
function renderRecent(items) {
  const listEl = $('#cinema-recent-list');
  if (!listEl) return;
  if (!items || items.length === 0) {
    listEl.innerHTML = '<div class="cinema-popup-empty">暂无观影记录</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const item of items) {
    if (!item || !item.bvid) continue;
    // item.time 是「该P内停住的位置」，非累计观看时长（累计是 watched，展示在 hero 卡）；
    // 用「播放至」与 hero 卡一致，避免被读成"看了多久"
    const sub = item.totalParts > 1
      ? `第${item.part}/${item.totalParts}集 · 播放至 ${fmtTime(item.time)}`
      : `播放至 ${fmtTime(item.time)}`;
    listEl.appendChild(buildListRow(item, sub, () => {
      chrome.tabs.create({ url: historyUrl(item) });
    }));
  }
}

/** 收藏列表（点击打开，× 取消收藏） */
function renderBookmarks(items) {
  const listEl = $('#cinema-bookmark-list');
  if (!listEl) return;
  if (!items || items.length === 0) {
    listEl.innerHTML = '<div class="cinema-popup-empty">暂无收藏</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const item of items) {
    if (!item || !item.bvid) continue;
    const bvid = item.bvid;
    // 有 part 的新收藏落到那一集；旧收藏没有这个字段，bookmarkUrl 只开 bvid
    const sub = (typeof item.part === 'number' && item.part > 1) ? `第 ${item.part} 集` : '';
    listEl.appendChild(buildListRow(item, sub, () => {
      chrome.tabs.create({ url: bookmarkUrl(item) });
    }, (row) => {
      chrome.runtime.sendMessage({ type: 'toggleBookmark', bvid }, (res) => {
        // 后台无回执也按已取消处理（toggleBookmark 语义即翻转）
        if (!res || res.bookmarked !== true) row.remove();
        if (listEl.children.length === 0) {
          listEl.innerHTML = '<div class="cinema-popup-empty">暂无收藏</div>';
        }
      });
    }));
  }
}

// ============================================================
//  打开播放器设置（向视频页 content script 发消息）
// ============================================================

const openSettingsBtn = $('#cinema-open-settings');
if (openSettingsBtn) {
  openSettingsBtn.addEventListener('click', () => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { type: 'cinema-open-settings' }, () => {
          void chrome.runtime.lastError; // 非视频页 / 未注入 content script：静默忽略
        });
      });
    } catch { /* ignore */ }
  });
}

// ============================================================
//  启动
// ============================================================

chrome.runtime.sendMessage({ type: 'getPopupData' }, (res) => {
  if (chrome.runtime.lastError) {
    // 后台尚未提供该消息（并行开发中）：以空数据渲染，避免白屏
    render(null);
    return;
  }
  render(res);
});
