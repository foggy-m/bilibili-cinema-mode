/**
 * B站影院模式 - 工具栏弹窗
 * 数据来自 background 的 getPopupData 消息（并行开发的核心提供）：
 * { settings, current: {bvid,title,pic,url}|null, history: [], bookmarks: [] }
 * 防御式编码：消息缺失/字段缺失时全部降级为空状态，不影响弹窗渲染。
 */

'use strict';

const $ = (sel) => document.querySelector(sel);

/** 基础 HTML 转义（渲染标题等用户数据用） */
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** 秒 → mm:ss */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

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
    return `<div class="${cls}"><img src="${esc(pic)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='B'"></div>`;
  }
  return `<div class="${cls}">B</div>`;
}

// ============================================================
//  渲染
// ============================================================

function render(data) {
  data = data || {};
  const settings = data.settings || {};

  // 主题：settings.theme === 'light' 用浅色令牌，其余（含 auto/深色）用默认深色
  document.body.classList.toggle('theme-light', settings.theme === 'light');

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
    if (subEl) subEl.textContent = `${partInfo}播放至 ${fmtTime(histItem.time)}`;

    let pct = 0;
    if (histItem.duration && histItem.duration > 0) {
      pct = Math.min(100, Math.round((histItem.time / histItem.duration) * 100));
    }
    if (fillEl) fillEl.style.width = pct > 0 ? pct + '%' : '20%';
    if (pctEl) pctEl.textContent = pct > 0 ? pct + '%' : fmtTime(histItem.time);
    if (progRow) progRow.style.display = 'flex';
  } else {
    if (subEl) subEl.textContent = '点击继续观影 · 自动沉浸放映';
    if (progRow) progRow.style.display = 'none';
  }

  const openBtn = $('#cinema-current-open');
  if (openBtn) {
    openBtn.onclick = () => openVideo(current.bvid);
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
      }, (res) => {
        if (res && typeof res.bookmarked === 'boolean') bookmarked = res.bookmarked;
        else bookmarked = !bookmarked;
        refresh();
      });
    };
  }
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
    const row = document.createElement('div');
    row.className = 'cinema-popup-item';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', '打开 ' + (item.title || item.bvid));

    const sub = item.totalParts > 1
      ? `第${item.part}/${item.totalParts}集 · 已看 ${fmtTime(item.time)}`
      : `已看 ${fmtTime(item.time)}`;

    row.innerHTML = `
      ${picHtml(item.pic, 'cinema-popup-item-pic')}
      <div class="cinema-popup-item-info">
        <div class="cinema-popup-item-title">${esc(item.title)}</div>
        <div class="cinema-popup-item-sub">${esc(sub)}</div>
      </div>
    `;

    const url = historyUrl(item);
    row.addEventListener('click', () => chrome.tabs.create({ url }));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        chrome.tabs.create({ url });
      }
    });
    listEl.appendChild(row);
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
    const row = document.createElement('div');
    row.className = 'cinema-popup-item';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', '打开 ' + (item.title || item.bvid));

    row.innerHTML = `
      ${picHtml(item.pic, 'cinema-popup-item-pic')}
      <div class="cinema-popup-item-info">
        <div class="cinema-popup-item-title">${esc(item.title)}</div>
      </div>
      <button type="button" class="cinema-popup-item-remove" title="取消收藏" aria-label="取消收藏 ${esc(item.title || item.bvid)}">&times;</button>
    `;

    const url = `https://www.bilibili.com/video/${item.bvid}`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.cinema-popup-item-remove')) return;
      chrome.tabs.create({ url });
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        chrome.tabs.create({ url });
      }
    });

    row.querySelector('.cinema-popup-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'toggleBookmark', bvid: item.bvid }, (res) => {
        // 后台无回执也按已取消处理（toggleBookmark 语义即翻转）
        if (!res || res.bookmarked !== true) row.remove();
        if (listEl.children.length === 0) {
          listEl.innerHTML = '<div class="cinema-popup-empty">暂无收藏</div>';
        }
      });
    });

    listEl.appendChild(row);
  }
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
