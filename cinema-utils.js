/**
 * B站影院模式 - 纯函数工具模块
 * 无浏览器/扩展依赖，UMD 双端可用：
 *   - 浏览器内容脚本：直接挂到隔离世界全局（与其他模块共享作用域）
 *   - Node 测试环境：module.exports 导出，供 tests/unit.test.js 单测
 * 分段预取相关新增：parseSidx（解析 MP4 sidx box）、buildSegmentPlan（生成逐段预取计划）、
 * parseRangeHeader（解析 HTTP Range 头）、rangeCovered（区间覆盖判断）
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

  /**
   * 章节样式进度条渐变：按分P区间生成 90deg 线性渐变（分P分段着色）。
   * 相邻分P在 B站蓝基准（hsl(197,100%,42%)）附近交替：色相 187°↔207°、亮度 36%↔48%，
   * 分P边界保留约 2px 深色硬分隔（rgba(0,0,0,.45)）。
   * 无数据、单分P或异常输入时返回空串。
   */
  function buildChapterGradient(pages, cumulative, totalDuration) {
    if (typeof totalDuration !== 'number' || !isFinite(totalDuration) || totalDuration <= 0) return '';
    if (!Array.isArray(cumulative) || !Array.isArray(pages) || pages.length <= 1) return '';
    if (cumulative.length < pages.length + 1) return '';

    var stops = [];
    for (var i = 0; i < pages.length; i++) {
      var color = 'hsl(' + (i % 2 === 0 ? 187 : 207) + ', 100%, ' + (i % 2 === 0 ? 48 : 36) + '%)';
      var cStart = Number(cumulative[i]);
      var cEnd = Number(cumulative[i + 1]);
      if (!isFinite(cStart) || cStart < 0) cStart = 0;
      if (!isFinite(cEnd) || cEnd < cStart) cEnd = cStart;
      var start = Math.max(0, Math.min(100, (cStart / totalDuration) * 100));
      var end = Math.max(0, Math.min(100, (cEnd / totalDuration) * 100));

      if (i > 0) {
        stops.push('rgba(0, 0, 0, 0.45) ' + start.toFixed(3) + '%');
        stops.push('rgba(0, 0, 0, 0.45) calc(' + start.toFixed(3) + '% + 2px)');
        stops.push(color + ' calc(' + start.toFixed(3) + '% + 2px)');
      }
      stops.push(color + ' ' + end.toFixed(3) + '%');
    }
    return 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  }

  return {
    formatTime,
    formatRelativeTime,
    escapeHtml,
    qualityTextToQn,
    buildCumulative,
    overallToPartOffset,
    isAudioStreamFilename,
    extractStreamCode,
    matchStreamUrls,
    parseSidx,
    buildSegmentPlan,
    parseRangeHeader,
    rangeCovered,
    buildChapterGradient,
  };
  /* 底部说明：新增 parseSidx / buildSegmentPlan / parseRangeHeader / rangeCovered / buildChapterGradient
   * 纯函数，与既有函数一致：无副作用、无 DOM/chrome 依赖，UMD 双端导出 */
});
