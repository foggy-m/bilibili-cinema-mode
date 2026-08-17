/**
 * B站影院模式 - 后台 Service Worker
 *
 * 功能：
 * - 处理 content script 发来的关闭标签页请求（播放完毕自动关闭）
 * - 弹窗数据 API（popup.html 调用）：
 *   getPopupData    读取 设置 + 观影记录（分块展平）+ 收藏 + 当前标签页 url/title/bvid
 *   setEnabled      更新 cinemaSettings.enabled
 *   toggleBookmark  按 bvid 切换收藏
 */

const BOOKMARK_LIMIT = 50; // 与 cinema-core.js 的收藏容量保持一致

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'closeTab') {
    if (sender && sender.tab && sender.tab.id != null) {
      chrome.tabs.remove(sender.tab.id, () => {
        sendResponse({ ok: true });
      });
      return true; // 异步响应
    }
    sendResponse({ ok: false });
    return false;
  }

  if (msg.type === 'getPopupData') {
    getPopupData().then(sendResponse);
    return true; // 异步响应
  }

  if (msg.type === 'setEnabled') {
    setEnabled(!!msg.enabled).then((ok) => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'toggleBookmark') {
    // 弹窗可能发顶层 {bvid,title,pic}（item 缺失时回退到 msg 本身）
    const item = (msg.item && typeof msg.item === 'object') ? msg.item : msg;
    toggleBookmarkInStorage(item).then((res) => {
      sendResponse({ ok: true, bookmarked: res.bookmarked, list: res.list });
    });
    return true;
  }

  return false;
});

/** 组装弹窗数据：{ settings, history, bookmarks, tab, current } */
function getPopupData() {
  return new Promise((resolve) => {
    const result = {
      settings: null,
      history: [],
      bookmarks: [],
      tab: { url: '', title: '', bvid: '' },
      current: null,
    };

    chrome.storage.sync.get(null, (all) => {
      try {
        const res = (all && typeof all === 'object') ? all : {};
        result.settings = (res.cinemaSettings && typeof res.cinemaSettings === 'object') ? res.cinemaSettings : null;

        // 历史：展平 cinemaHistory_c* 分块 → 按 ts 降序 → 取前 12
        const hist = {};
        for (const k of Object.keys(res)) {
          if (/^cinemaHistory_c\d+$/.test(k) && res[k] && typeof res[k] === 'object') {
            Object.assign(hist, res[k]);
          }
        }
        result.history = Object.values(hist)
          .filter((v) => v && typeof v === 'object')
          .sort((a, b) => ((b.ts || 0) - (a.ts || 0)))
          .slice(0, 12);

        const bm = res.cinemaBookmarks;
        result.bookmarks = Array.isArray(bm) ? bm : [];
      } catch (e) { /* 保留默认空值 */ }

      // 当前活动标签页信息（current 为主字段，tab 保留为兼容别名）
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        try {
          const t = tabs && tabs[0];
          if (t && t.url) {
            result.tab.url = t.url;
            result.tab.title = t.title || '';
            const m = String(t.url).match(/\/video\/(BV[\w]+)/);
            if (m) result.tab.bvid = m[1];
            result.current = {
              bvid: result.tab.bvid,
              title: result.tab.title,
              pic: '',
              url: result.tab.url,
            };
          }
        } catch (e) { /* ignore */ }
        resolve(result);
      });
    });
  });
}

/** 更新 cinemaSettings.enabled（弹窗总开关） */
function setEnabled(enabled) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get('cinemaSettings', (res) => {
        try {
          const s = (res && res.cinemaSettings && typeof res.cinemaSettings === 'object')
            ? res.cinemaSettings
            : {};
          s.enabled = enabled;
          chrome.storage.sync.set({ cinemaSettings: s }, () => resolve(true));
        } catch (e) { resolve(false); }
      });
    } catch (e) { resolve(false); }
  });
}

/** 弹窗收藏切换：item: { bvid, title, pic }；按 bvid 去重、最新在前、容量 50 */
function toggleBookmarkInStorage(item) {
  return new Promise((resolve) => {
    try {
      const bvid = item && item.bvid;
      if (!bvid) { resolve({ list: [], bookmarked: false }); return; }
      chrome.storage.sync.get('cinemaBookmarks', (res) => {
        try {
          let list = (res && res.cinemaBookmarks) || [];
          if (!Array.isArray(list)) list = [];
          let bookmarked = false;
          const idx = list.findIndex((b) => b && b.bvid === bvid);
          if (idx !== -1) {
            list.splice(idx, 1);
          } else {
            list.unshift({
              bvid: bvid,
              title: (item.title || ''),
              pic: (item.pic || ''),
              ts: Date.now(),
            });
            bookmarked = true;
          }
          while (list.length > BOOKMARK_LIMIT) list.pop();
          chrome.storage.sync.set({ cinemaBookmarks: list }, () => {
            resolve({ list: list, bookmarked: bookmarked });
          });
        } catch (e) { resolve({ list: [], bookmarked: false }); }
      });
    } catch (e) { resolve({ list: [], bookmarked: false }); }
  });
}
