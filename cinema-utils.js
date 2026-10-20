/**
 * B站影院模式 - 纯函数工具模块
 * 无浏览器/扩展依赖，UMD 双端可用：
 *   - 浏览器内容脚本：直接挂到隔离世界全局（与其他模块共享作用域）
 *   - Node 测试环境：module.exports 导出，供 tests/unit.test.js 单测
 * 分段预取相关新增：parseSidx（解析 MP4 sidx box）、buildSegmentPlan（生成逐段预取计划）、
 * parseRangeHeader（解析 HTTP Range 头）、rangeCovered（区间覆盖判断）
 * 合集子合集模型新增：buildSeasonModel（每个子合集=一部电影的归一化）、buildSectionProgressKey（子合集进度键）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  for (const key of Object.keys(api)) {
    root[key] = api[key];
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 秒数 → h:mm:ss 或 m:ss */
  function formatTime(seconds) {
    let s = Math.floor(Number(seconds));
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  /** 时间戳 → 相对时间（刚刚/X分钟前/X小时前/X天前/日期） */
  function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 7 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)}天前`;
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** HTML 转义（防 XSS） */
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  /** 画质文本 → qn 数字（B站 playurl API 参数）
   * 注意：须先按分辨率匹配再按描述符细分，否则 "720P 高清" 会被 "高清" 误判为 1080P */
  function qualityTextToQn(text) {
    let t = (text || '').trim();
    // “自动(480P 标清)” → 提取括号内部分
    const paren = t.match(/[（(]([^）)]+)[)）]/);
    if (paren) t = paren[1];
    const res = t.match(/(4K|2160P?|1080P|720P|480P|360P)/);
    switch (res && res[1]) {
      case '4K':
      case '2160':
      case '2160P':
        return 120;
      case '1080P':
        if (/60|高帧率/.test(t)) return 116;
        if (/高码率|\+/.test(t)) return 112;
        return 80;
      case '720P':
        return 64;
      case '480P':
        return 32;
      case '360P':
        return 16;
      default:
        // 兜底（现有"分辨率优先"正则未命中时才走到这里）：
        if (/8K/.test(t)) return 127;
        if (/杜比视界|HDR/.test(t)) return 125;
        const num = t.match(/(2160|1080|720|480|360)/);
        if (num) return { 2160: 120, 1080: 80, 720: 64, 480: 32, 360: 16 }[num[1]];
        return 80; // 默认 1080P
    }
  }

  /** 判断文件名是否为音频流（B站 DASH 音频码率码形如 3xxxx，如 -1-30280.m4s） */
  function isAudioStreamFilename(name) {
    return /-1-3\d+\.m4s/.test(name);
  }

  /** 从流文件名中提取码率码（'xxx-1-100022.m4s' → '100022'），不匹配返回 '' */
  function extractStreamCode(name) {
    const m = String(name).match(/-1-(\d+)\.m4s/);
    return m ? m[1] : '';
  }

  /** 按码率码过滤候选 URL 并按文件名去重（保留首个、保持原序）。code 为空串/null 时不过滤 */
  function matchStreamUrls(urls, code) {
    const seen = {};
    const out = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      if (code && u.indexOf('-1-' + code + '.m4s') === -1) continue;
      const n = u.split('/').pop().split('?')[0];
      if (seen[n]) continue;
      seen[n] = true;
      out.push(u);
    }
    return out;
  }

  /** 由各分P时长计算前缀和（电影总时间线的基础）。纯函数：返回 { cumulative, totalDuration } */
  function buildCumulative(durations) {
    const cumulative = [0];
    let sum = 0;
    for (const d of durations) {
      sum += d || 0;
      cumulative.push(sum);
    }
    return { cumulative, totalDuration: sum };
  }

  /** 电影总时间 → 分P内定位。纯函数：cumulative 前缀和数组，overall 总时间。返回 { index, offset } | null */
  function overallToPartOffset(cumulative, overall) {
    for (let i = 0; i < cumulative.length - 1; i++) {
      const start = cumulative[i];
      const end = cumulative[i + 1];
      if (overall >= start && overall < end) {
        return { index: i, offset: overall - start };
      }
    }
    return null;
  }

  /** overallToPartOffset 的逆运算：分P内时间 → 电影内绝对位置。
   * 纯函数：cumulative 前缀和数组，part 为 1-based 分P号，time 为该 P 内秒数。
   * 观影记录的 overallTime 字段由此计算（time 是 P 内时间、totalDuration 是电影总长，
   * 口径不同不可直接相除，必须换算后才能得出总进度百分比）。 */
  function overallFromPart(cumulative, part, time) {
    const idx = (part || 1) - 1;
    const start = (cumulative && cumulative[idx]) || 0;
    return start + (time || 0);
  }

  /**
   * 拖拽 pointerup 之后抑制紧随 click 事件的窗口判定（纯函数：不读时钟、不碰 DOM）。
   * 用时间戳而非布尔量：若 click 因故没触发，窗口会自然过期，不会永久吞掉用户后续的正常点击。
   * @param {number} stamp  pointerup 记录的时间戳；0/空表示无待抑制的 click
   * @param {number} now    本次 click 的时间戳
   * @param {number} [windowMs] 窗口长度（毫秒），默认 500
   * @returns {boolean} true = 落在窗口内，本次 click 应跳过并将 stamp 清零
   */
  function isClickSuppressed(stamp, now, windowMs) {
    if (!stamp) return false;
    const limit = typeof windowMs === 'number' ? windowMs : 500;
    return (now - stamp) < limit;
  }

  /** 秒数 → 中文可读时长（用于"累计观影"这类统计值，刻意不到秒，避免假精确）。
   * 非法/<=0 返回空串，由调用方决定隐藏；<60s 归为"1 分钟内"。纯函数。 */
  function formatDurationCN(seconds) {
    const s = Math.floor(Number(seconds));
    if (!isFinite(s) || s <= 0) return '';
    if (s < 60) return '1 分钟内';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }

  /** 收藏列表容量上限。唯一定义处——content 与 background 过去各存一份且已行为分叉。 */
  const BOOKMARK_CAP = 50;

  /** 收藏列表消毒（纯函数）：仅保留含 bvid 的对象条目、按 bvid 去重（保留先出现者）、
   *  按 cap 截断尾部（约定最新在前，超限丢最旧）。 */
  function sanitizeBookmarkList(list, cap) {
    const limit = typeof cap === 'number' ? cap : BOOKMARK_CAP;
    const src = Array.isArray(list) ? list : [];
    const seen = Object.create(null);
    const clean = [];
    for (const it of src) {
      if (!it || typeof it !== 'object' || !it.bvid) continue;
      if (seen[it.bvid]) continue;
      seen[it.bvid] = true;
      clean.push(it);
    }
    while (clean.length > limit) clean.pop();
    return clean;
  }

  /** 切换收藏（纯函数，不落盘）：先消毒；命中 bvid 则移除，否则把 {bvid,title,pic,ts}
   *  插到最前。缺 bvid 时不切换、只返回消毒后的列表。
   *  part（1-based 分P号）与 overallTime（电影内秒数）只在调用方真实给了数字时才写入：
   *  旧书签没有这两个字段，打开时走原来的片头，不编一个假进度。
   *  @returns {{ list: Array, bookmarked: boolean }} 切换后的真实状态 */
  function toggleBookmarkEntry(list, meta, cap, now) {
    const clean = sanitizeBookmarkList(list, cap);
    const bvid = meta && meta.bvid;
    if (!bvid) return { list: clean, bookmarked: false };
    const idx = clean.findIndex((b) => b && b.bvid === bvid);
    if (idx !== -1) {
      clean.splice(idx, 1);
      return { list: clean, bookmarked: false };
    }
    const entry = {
      bvid: bvid,
      title: (meta.title || ''),
      pic: (meta.pic || ''),
      ts: typeof now === 'number' ? now : Date.now(),
    };
    const part = Number(meta.part);
    const overall = Number(meta.overallTime);
    if (isFinite(part) && part >= 1) entry.part = Math.floor(part);
    if (isFinite(overall) && overall >= 0) entry.overallTime = overall;
    clean.unshift(entry);
    return { list: sanitizeBookmarkList(clean, cap), bookmarked: true };
  }

  /** 收藏 → 打开地址。有真实的 part（多P，且不是第 1 集）才带 ?p=；
   *  合集、旧书签、缺字段都不带，打开片头，不编分P号。 */
  function bookmarkUrl(item) {
    const bvid = item && item.bvid;
    if (!bvid) return '';
    let url = 'https://www.bilibili.com/video/' + bvid;
    if (item.mode !== 'season' && typeof item.part === 'number' && item.part > 1) {
      url += '?p=' + item.part;
    }
    return url;
  }

  /** 新功能：MP4 sidx 解析与 DASH 分段预取（均无副作用、无 DOM/chrome 依赖） */

  /** 解析 HTTP Range 请求头：'bytes=0-1021' → { start: 0, end: 1021 }；
   * 'bytes=12345-' → { start: 12345, end: null }；非法/非 bytes 单位返回 null */
  function parseRangeHeader(h) {
    if (typeof h !== 'string') return null;
    var m = h.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) return null;
    return {
      start: parseInt(m[1], 10),
      end: m[2] === '' ? null : parseInt(m[2], 10),
    };
  }

  // ---- 私有工具：大端序读无符号整数 ----
  function readU32(bytes, off) {
    return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  }
  function readU16(bytes, off) {
    return ((bytes[off] << 8) | bytes[off + 1]) >>> 0;
  }

  /** 解析 sidx box 内容（boxStart 为含 8B box 头的偏移），返回 { timescale, refs } */
  function parseSidxBox(bytes, boxStart) {
    var content = boxStart + 8;
    if (content + 12 > bytes.length) return null;
    var version = bytes[content];
    var timescale = readU32(bytes, content + 8);
    var pos = content + 12;
    if (version === 0) {
      pos += 8; // earliest_presentation_time(4) + first_offset(4)
    } else if (version === 1) {
      pos += 16; // earliest_presentation_time(8) + first_offset(8)
    } else {
      return null;
    }
    if (pos + 4 > bytes.length) return null;
    var refCount = readU16(bytes, pos + 2); // reserved(2) + reference_count(2)
    pos += 4;
    var refs = [];
    var i;
    for (i = 0; i < refCount; i++) {
      if (pos + 12 > bytes.length) return null;
      var first = readU32(bytes, pos);
      var refType = first >>> 31; // 1 = 嵌套 sidx
      var size = first & 0x7fffffff;
      var duration = readU32(bytes, pos + 4); // subsegment_duration
      refs.push({ size: size, duration: duration, isMedia: refType === 0 });
      pos += 12;
      if (refType === 1) break; // 嵌套 sidx：停止累加，返回已解析部分
    }
    return { timescale: timescale, refs: refs };
  }

  /** 解析 MP4 sidx box。输入 ArrayBuffer 或 Uint8Array，按 box 扫描定位 'sidx'。
   * 返回 { timescale, refs: [{ size, duration, isMedia }] }；垃圾输入/越界返回 null */
  function parseSidx(buf) {
    try {
      var bytes;
      if (buf instanceof ArrayBuffer) {
        bytes = new Uint8Array(buf);
      } else if (buf instanceof Uint8Array) {
        bytes = buf;
      } else {
        return null;
      }
      if (bytes.length < 8) return null;
      var offset = 0;
      while (offset + 8 <= bytes.length) {
        var size = readU32(bytes, offset);
        var type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (size < 8 || offset + size > bytes.length) return null; // 非法 size / 越界
        if (type === 'sidx') return parseSidxBox(bytes, offset);
        offset += size; // 其他 box 按 size 跳过
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /** 解析 'a-b' 形式的字节范围字符串（SegmentBase 的 initialization/indexRange），失败返回 null */
  function parseByteRange(s) {
    if (typeof s !== 'string') return null;
    var m = s.match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
  }

  /** 合集子合集模型：「每个 B站合集子合集(section) = 一部电影」的基础归一化。
   * season 原始结构（ugc_season）：
   *   { id, title, sections: [{ id?, title?, episodes: [{ bvid, cid, aid, title, duration, page?: { duration }, id }] }] }
   * 归一化结果与 cinema-player.js 的扁平映射字段一致，仅 index 改为 section 内 0 起。
   * currentBvid 为当前播放的 bvid；sectionIndex 指向首个包含它的子合集，未找到/为空为 -1。
   * 垃圾输入（season 为假值、sections 非非空数组）返回 null，永不抛错。
   */
  function buildSeasonModel(season, currentBvid) {
    if (!season || !Array.isArray(season.sections) || season.sections.length === 0) return null;
    var sections = [];
    var sectionIndex = -1;
    var si;
    for (si = 0; si < season.sections.length; si++) {
      var sec = season.sections[si] || {};
      var eps = Array.isArray(sec.episodes) ? sec.episodes : [];
      var episodes = [];
      var ei;
      for (ei = 0; ei < eps.length; ei++) {
        var ep = eps[ei];
        if (!ep || !ep.bvid) continue; // 丢弃 bvid 缺失的条目
        episodes.push({
          index: episodes.length, // section 内 0 起
          bvid: ep.bvid || '',
          cid: ep.cid || 0,
          aid: ep.aid || 0,
          title: ep.title || '',
          duration: ep.duration || (ep.page && ep.page.duration) || 0,
          id: ep.id || 0
        });
      }
      sections.push({
        id: sec.id != null ? sec.id : '',
        title: sec.title || '',
        index: si,
        episodes: episodes
      });
      if (currentBvid && sectionIndex === -1) {
        for (ei = 0; ei < episodes.length; ei++) {
          if (episodes[ei].bvid === currentBvid) {
            sectionIndex = si;
            break;
          }
        }
      }
    }
    return {
      id: season.id || 0,
      title: season.title || '',
      sections: sections,
      sectionIndex: sectionIndex,
      episodes: sectionIndex === -1 ? [] : sections[sectionIndex].episodes
    };
  }

  /** 子合集进度存储键：'season_<seasonId>_s<id|title|i<index>>'。
   * section 为 buildSeasonModel 归一化后的子合集 { id, title, index }；
   * section 为假值时返回 'season_<seasonId>_s?'。 */
  function buildSectionProgressKey(seasonId, section) {
    if (!section) return 'season_' + String(seasonId) + '_s?';
    return 'season_' + String(seasonId) + '_s' + (section.id || section.title || ('i' + section.index));
  }

  /** 生成 DASH 逐段预取计划。
   * segmentBase: { initialization, indexRange }（Range 字符串 'a-b'，解析失败返回 null）；
   * opts: { targetSeconds=25, maxBytes=8MB }。
   * 头部一次拉 0..indexRange.end；媒体段从 headEnd+1 起按 sidx.refs 顺序累加，
   * 达到 targetSeconds 或 maxBytes 即停止。返回 { headEnd, media, totalBytes, coveredSeconds } */
  function buildSegmentPlan(segmentBase, sidx, opts) {
    if (!segmentBase || typeof segmentBase !== 'object') return null;
    var initRange = parseByteRange(segmentBase.initialization);
    var indexRange = parseByteRange(segmentBase.indexRange);
    if (!initRange || !indexRange || indexRange.end === null) return null;
    var headEnd = indexRange.end;
    var targetSeconds = (opts && typeof opts.targetSeconds === 'number' && opts.targetSeconds > 0) ? opts.targetSeconds : 25;
    var maxBytes = (opts && typeof opts.maxBytes === 'number' && opts.maxBytes > 0) ? opts.maxBytes : 8 * 1024 * 1024;
    var media = [];
    var totalBytes = 0;
    var coveredSeconds = 0;
    if (sidx && sidx.refs && sidx.refs.length > 0) {
      var start = headEnd + 1;
      var i;
      for (i = 0; i < sidx.refs.length; i++) {
        var ref = sidx.refs[i];
        var end = start + ref.size - 1;
        media.push({ start: start, end: end });
        totalBytes += ref.size;
        if (sidx.timescale > 0) coveredSeconds += ref.duration / sidx.timescale;
        start = end + 1;
        if (coveredSeconds >= targetSeconds || totalBytes >= maxBytes) break;
      }
    }
    return { headEnd: headEnd, media: media, totalBytes: totalBytes, coveredSeconds: coveredSeconds };
  }

  /** 判断 [start, end] 是否完整包含于某 chunk（c.start <= start 且 c.end >= end）。
   * chunks 为空 / end 为 null / 非法输入返回 false */
  function rangeCovered(chunks, start, end) {
    if (!Array.isArray(chunks) || chunks.length === 0) return false;
    if (end === null || end === undefined) return false;
    var i;
    for (i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (c && typeof c.start === 'number' && typeof c.end === 'number' && c.start <= start && c.end >= end) {
        return true;
      }
    }
    return false;
  }

  /** 分P展示标签（纯函数）：season→「第n集 · 名」，pages→「P页 · 名」；无 part 返回空串。
   * 进度条 tooltip 与系统媒体卡片共用同一口径（约束 19/59），勿在别处复制该格式。
   * @param {string} mode  'season' | 'pages'
   * @param {number} index 0-based 分P下标（season 用其 +1 作集号）
   * @param {{page?: number, part?: string}} part 该分P对象
   * @returns {string}
   */
  function partDisplayLabel(mode, index, part) {
    if (!part) return '';
    const name = (part.part || '').trim();
    return mode === 'season'
      ? `第${index + 1}集${name ? ' · ' + name : ''}`
      : `P${part.page}${name ? ' · ' + name : ''}`;
  }

  return {
    formatTime,
    formatRelativeTime,
    escapeHtml,
    qualityTextToQn,
    buildCumulative,
    overallToPartOffset,
    overallFromPart,
    isAudioStreamFilename,
    extractStreamCode,
    matchStreamUrls,
    parseSidx,
    buildSegmentPlan,
    parseRangeHeader,
    rangeCovered,
    buildSeasonModel,
    buildSectionProgressKey,
    isClickSuppressed,
    formatDurationCN,
    sanitizeBookmarkList,
    toggleBookmarkEntry,
    bookmarkUrl,
    partDisplayLabel,
  };
  /* 底部说明：新增 parseSidx / buildSegmentPlan / parseRangeHeader / rangeCovered /
   * buildSeasonModel / buildSectionProgressKey / overallFromPart / isClickSuppressed /
   * formatDurationCN / sanitizeBookmarkList / toggleBookmarkEntry / bookmarkUrl / partDisplayLabel
   * 均为纯函数，与既有函数一致：无副作用、无 DOM/chrome 依赖，UMD 双端导出。
   * 注：BOOKMARK_CAP 刻意不导出（避免与各文件顶层同名 const 在全局词法作用域撞名），
   * 收藏容量通过函数默认参数生效，需要覆盖时显式传 cap。 */
});
