/**
 * B站影院模式 - 播放器桥接脚本
 * 运行在页面主世界（MAIN world），可直接访问 window.player
 * 通过 CustomEvent 与隔离世界的 content.js 通信（detail 用 JSON 字符串，跨世界最可靠）
 */
(function () {
  'use strict';

  if (window.__cinemaBridgeLoaded) return;
  window.__cinemaBridgeLoaded = true;

  function parseDetail(e) {
    try {
      return typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
    } catch (err) {
      return {};
    }
  }

  /** 切换分P请求：使用播放器内部 API，不重建播放器、保持全屏 */
  window.addEventListener('__cinema_switch_part__', function (e) {
    var d = parseDetail(e);
    var id = d.id || '';
    var targetPage = d.page;
    var ok = false;
    var error = '';

    try {
      var p = window.player;
      if (!p) {
        error = 'player API not available';
      } else {
        var params = new URLSearchParams(location.search);
        var current = parseInt(params.get('p') || '1', 10);
        var offset = targetPage - current;
        if (offset === 0) {
          error = 'offset is 0';
        } else if (offset === 1 && typeof p.next === 'function') {
          // 优先使用 next/prev：新版 B 站播放器实测 goto 无效（返回空对象但不切换），
          // 而 next()/prev() 可正常切换且不重建播放器（保持全屏/宽屏）
          p.next(false);
          ok = true;
        } else if (offset === -1 && typeof p.prev === 'function') {
          p.prev(false);
          ok = true;
        } else if (typeof p.goto === 'function') {
          // 旧版播放器兼容：goto(offset, autoplay)
          p.goto(offset, false);
          ok = true;
        } else {
          error = 'no switch API available';
        }
      }
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }

    window.dispatchEvent(new CustomEvent('__cinema_switch_part_result__', {
      detail: JSON.stringify({ id: id, ok: ok, error: error })
    }));
  });

  /** 查询播放器显示模式：mainScreen 0=普通 1=宽屏 2=网页全屏 */
  window.addEventListener('__cinema_get_mode__', function (e) {
    var d = parseDetail(e);
    var id = d.id || '';
    var mainScreen = -1;

    try {
      var p = window.player;
      if (p && typeof p.getStates === 'function') {
        var s = p.getStates();
        if (s && typeof s.mainScreen === 'number') {
          mainScreen = s.mainScreen;
        }
      }
    } catch (err) { /* ignore */ }

    window.dispatchEvent(new CustomEvent('__cinema_get_mode_result__', {
      detail: JSON.stringify({ id: id, mainScreen: mainScreen })
    }));
  });

  // ============================================================
  //  下一分P预加载：字节级合成 + URL 重写兜底
  //
  //  背景（实测）：B站播放器 bwp 内嵌 dash.js，对每个 m4s 流发多个
  //  带 Range 的 XHR（responseType=arraybuffer）：init 段 bytes=0-1021、
  //  索引段 bytes=1022-5985（边界来自 playurl JSON 的 segmentBase），
  //  而后按 sidx 逐媒体段请求。mcdn/PCDN 节点响应无缓存头（预取进 HTTP
  //  缓存无效），upos 节点带 ETag/Last-Modified 可缓存；baseUrl 常是
  //  mcdn、backupUrl 常是 upos。
  //
  //  预取策略：
  //    1. 请求 playurl API → 按码率码选择目标变体 → 候选 URL 排序
  //       （host 含 upos 排最前、mcdn 排最后、其余居中；同分 backup 优先）
  //    2. 按 segmentBase + sidx 规划头部字节（init+index）与首段媒体区间，
  //       用原生 XHR（实测 CDN 对页面 fetch 报错）Range 预取存入 byteStore
  //    3. 播放器请求命中 byteStore 且 Range 被覆盖时，本地切片合成 206 响应
  //       （XHR 与 fetch 两条路径）；未命中则保留 prefetchTable URL 重写兜底
  //       （配合 upos 的 HTTP 缓存）
  //    4. 有效期统一取流 URL 的 deadline 参数（-300s 安全余量）
  // ============================================================

  var prefetchTable = {};   // 文件名 -> { url, expires }（URL 重写兜底，未合成时仍可用）
  var playurlCache = {};    // cid -> { json, expires, fnval }（切换时播放器请求 playurl 本地秒回）
  var playurlCacheOrder = []; // cid 插入顺序（B4：LRU 容量上限，超出淘汰最旧）
  var byteStore = {};       // 文件名 -> { chunks: [{start,end,buffer: ArrayBuffer}], totalSize: number|-1, url, expires }
  var lastVideoName = '';   // 播放器最近请求的视频流文件名（音频为 -1-3xxxx）
  var lastAudioName = '';   // 播放器最近请求的音频流文件名
  var bridgeConfig = { fastSwitch: false, currentCid: 0 }; // content.js 通过 __cinema_config__ 下发
  // B1/Important #2：在途预取跟踪 —— 中止只由 __cinema_prefetch_cancel__ 显式触发
  var livePrefetchXhrs = [];  // 进行中的预取 XHR
  var prefetchToken = 0;      // 预取代际计数：取消后自增，异步回调据此静默停止旧链
  var prefetchBusy = false;   // doPrefetch 进行中（覆盖 playurl 请求尚未起流的窗口期）

  // 捕获 cinema-utils.js 导出的纯函数引用入闭包（utils 先于本文件在 MAIN world 注入，
  // 防止页面脚本后续覆盖全局名导致行为漂移）
  var uMatchStreamUrls = matchStreamUrls;
  var uExtractStreamCode = extractStreamCode;
  var uIsAudioStreamFilename = isAudioStreamFilename;
  var uParseSidx = parseSidx;                    // (buf) -> { timescale, refs:[{size,duration,isMedia}] } | null
  var uBuildSegmentPlan = buildSegmentPlan;      // (segmentBase, sidx, {targetSeconds, maxBytes}) -> { headEnd, media:[{start,end}], totalBytes, coveredSeconds } | null
  var uParseRangeHeader = parseRangeHeader;      // ('bytes=0-1021') -> {start,end|null} | null
  var uRangeCovered = rangeCovered;              // (chunks, start, end) -> boolean

  var NativeXHR = window.XMLHttpRequest;

  /** URL 节点排序：host 含 'upos' 最前、含 'mcdn' 最后、其余居中；稳定排序，同分 backup 优先 */
  function rankUrls(urls) {
    var scored = [];
    for (var i = 0; i < urls.length; i++) {
      var host = '';
      try { host = new URL(urls[i]).host; } catch (e) { host = ''; }
      var score = 1;
      if (host.indexOf('upos') !== -1) score = 0;
      else if (host.indexOf('mcdn') !== -1) score = 2;
      scored.push({ url: urls[i], score: score, backup: i > 0, idx: i });
    }
    scored.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.backup !== b.backup) return a.backup ? -1 : 1;
      return a.idx - b.idx;
    });
    var out = [];
    for (var k = 0; k < scored.length; k++) out.push(scored[k].url);
    return out;
  }

  /** 有效期：取全部候选 URL 的最小 deadline（unix 秒）-300s 安全余量；取不到用 now+2 小时兜底 */
  function computeExpires(urls) {
    var minDeadline = Infinity;
    for (var i = 0; i < urls.length; i++) {
      var m = String(urls[i] || '').match(/deadline=(\d+)/);
      if (m && m[1]) {
        var d = parseInt(m[1], 10);
        if (!isNaN(d) && d < minDeadline) minDeadline = d;
      }
    }
    if (isFinite(minDeadline)) return (minDeadline - 300) * 1000;
    return Date.now() + 7200000;
  }

  /** 从 XHR 响应头解析 content-range 的 totalSize，取不到返回 -1 */
  function parseContentRange(req) {
    try {
      var raw = req.getAllResponseHeaders && req.getAllResponseHeaders();
      if (raw) {
        var m = String(raw).match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
        if (m && m[1]) return parseInt(m[1], 10);
      }
    } catch (e) { /* ignore */ }
    return -1;
  }

  /**
   * 字节/重写表统一键：`${cid}_${basename}`（Important #1）。
   * 不同分P的 m4s 流常常同名（如 30232.m4s），若只按 basename 键，
   * 当前P与已预取的下一P会互相串档 —— 播放器请求会被喂给错误的流字节。
   */
  function storeKey(cid, name) {
    return String(cid) + '_' + name;
  }

  /** 从流 URL 尽力提取 cid：优先 ?cid= 参数，其次 /upgcxcode/<cid>/ 路径首段；取不到返回 0 */
  function cidFromUrl(url) {
    var s = String(url || '');
    var m = s.match(/[?&]cid=(\d+)/);
    if (m && m[1]) return parseInt(m[1], 10);
    m = s.match(/\/upgcxcode\/(\d+)\//);
    if (m && m[1]) return parseInt(m[1], 10);
    return 0;
  }

  /** 从 byteStore 的覆盖 chunks 中切片 [start,end]（支持跨 chunk 拼接，注意 chunk.start 对齐偏移） */
  function sliceStoredBytes(chunks, start, end) {
    var len = end - start + 1;
    var out = new ArrayBuffer(len);
    var outView = new Uint8Array(out);
    var pos = 0;
    for (var i = 0; i < chunks.length && pos < len; i++) {
      var c = chunks[i];
      var cStart = Math.max(start, c.start);
      var cEnd = Math.min(end, c.end);
      if (cEnd < cStart) continue;
      var off = cStart - c.start;
      if (off < 0) continue;
      var inView = new Uint8Array(c.buffer, off, cEnd - cStart + 1);
      outView.set(inView, cStart - start);
      pos += cEnd - cStart + 1;
    }
    return out;
  }

  /** 从 fetch 的 input/init 提取 Range 请求头（Headers 对象 / 普通对象，不区分大小写） */
  function getFetchRange(input, init) {
    var h = '';
    try {
      if (init && init.headers) {
        if (typeof init.headers.get === 'function') {
          h = init.headers.get('Range') || init.headers.get('range') || '';
        } else if (typeof init.headers === 'object') {
          for (var k in init.headers) {
            if (Object.prototype.hasOwnProperty.call(init.headers, k) && String(k).toLowerCase() === 'range') {
              h = init.headers[k] || '';
              break;
            }
          }
        }
      }
      if (!h && input && typeof input === 'object' && input.headers && typeof input.headers.get === 'function') {
        h = input.headers.get('Range') || input.headers.get('range') || '';
      }
    } catch (e) { h = ''; }
    return h;
  }

  /** 原生 XHR Range 请求（预取专用，直接 NativeXHR，不经过 cinemaXHR 包装，也不会命中拦截条件） */
  function xhrRange(url, rangeHeader, cb) {
    var req = new NativeXHR();
    try {
      req.open('GET', url);
      req.setRequestHeader('Range', rangeHeader);
      req.responseType = 'arraybuffer';
    } catch (e) {
      cb(false, null, -1);
      return;
    }
    livePrefetchXhrs.push(req); // B1：登记进行中的预取 XHR，取消/换目标时可中止
    var settled = false;
    var settle = function (ok, buf, total) {
      if (settled) return;
      settled = true;
      var idx = livePrefetchXhrs.indexOf(req);
      if (idx !== -1) livePrefetchXhrs.splice(idx, 1);
      cb(ok, buf, total);
    };
    req.onload = function () {
      if (req.status >= 200 && req.status < 300 && req.response) {
        settle(true, req.response, parseContentRange(req));
      } else {
        settle(false, null, -1);
      }
    };
    req.onerror = function () { settle(false, null, -1); };
    req.onabort = function () { settle(false, null, -1); };
    try { req.send(); } catch (e) { settle(false, null, -1); }
  }

  /**
   * byteStore 内存修剪：每条预取最大约 9MB，长会话切很多P会累积。
   * 写入新条目前先清过期项；仍超过上限则按插入顺序淘汰最旧的。
   */
  var BYTE_STORE_LIMIT = 6;
  function pruneByteStore() {
    var now = Date.now();
    var keys = Object.keys(byteStore);
    var i, k;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (!(byteStore[k].expires > now)) {
        delete byteStore[k];
        delete prefetchTable[k];
      }
    }
    keys = Object.keys(byteStore);
    while (keys.length >= BYTE_STORE_LIMIT) {
      delete byteStore[keys[0]];
      delete prefetchTable[keys[0]];
      keys = Object.keys(byteStore);
    }
  }

  /** 中止全部进行中的预取 XHR，并使旧预取链静默停止（B1） */
  function abortPrefetchXhrs() {
    prefetchToken++;
    for (var i = 0; i < livePrefetchXhrs.length; i++) {
      try { livePrefetchXhrs[i].abort(); } catch (e) { /* ignore */ }
    }
    livePrefetchXhrs = [];
  }

  /** playurlCache LRU 写入（B4）：先清过期条目；容量超限时按插入顺序淘汰最旧 */
  var PLAYURL_CACHE_LIMIT = 12;
  function writePlayurlCache(cid, entry) {
    var now = Date.now();
    var cids = Object.keys(playurlCache);
    var i, k, oi;
    for (i = 0; i < cids.length; i++) {
      k = cids[i];
      if (!(playurlCache[k].expires > now)) {
        delete playurlCache[k];
        oi = playurlCacheOrder.indexOf(k);
        if (oi !== -1) playurlCacheOrder.splice(oi, 1);
      }
    }
    playurlCache[cid] = entry;
    oi = playurlCacheOrder.indexOf(String(cid));
    if (oi !== -1) playurlCacheOrder.splice(oi, 1);
    playurlCacheOrder.push(String(cid));
    while (playurlCacheOrder.length > PLAYURL_CACHE_LIMIT) {
      var oldest = playurlCacheOrder.shift();
      delete playurlCache[oldest];
    }
  }

  /** 预取成功：写 byteStore + prefetchTable（URL 重写兜底仍需要）+ 回传 done 事件 */
  function writeByteStore(name, url, expires, chunks, totalSize, kind, cid) {
    pruneByteStore();
    var key = storeKey(cid, name); // Important #1：按 cid+basename 键写入，避免跨分P同名 m4s 串档
    byteStore[key] = { chunks: chunks, totalSize: totalSize, url: url, expires: expires };
    prefetchTable[key] = { url: url, expires: expires };
    var bytes = 0;
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i] && chunks[i].buffer) bytes += chunks[i].buffer.byteLength || 0;
    }
    window.dispatchEvent(new CustomEvent('__cinema_prefetch_done__', {
      detail: JSON.stringify({ ok: true, name: name, cid: cid, kind: kind, bytes: bytes })
    }));
  }

  /** 逐流预取：一个流变体 + 排序后的候选 URL 列表；任一候选全部失败则回传 fail */
  function prefetchStream(item, kind, budget, urls, cid, expires, token) {
    var segBase = item.segmentBase || item.SegmentBase;
    tryPrefetchVariant(item, kind, budget, urls, 0, segBase, cid, expires, token);
  }

  function tryPrefetchVariant(item, kind, budget, urls, idx, segBase, cid, expires, token) {
    if (prefetchToken !== token) return; // B1：预取已被取消/替换，静默停止旧链
    if (idx >= urls.length) {
      window.dispatchEvent(new CustomEvent('__cinema_prefetch_done__', {
        detail: JSON.stringify({ ok: false, reason: 'all urls failed', cid: cid, kind: kind })
      }));
      return;
    }
    var url = urls[idx];
    var name = url.split('/').pop().split('?')[0];

    // 无 segmentBase → 兜底：直接 Range 预取 0..(maxBytes-1) 存单个 chunk，跳过 sidx 解析，直接写入
    if (!segBase) {
      xhrRange(url, 'bytes=0-' + (budget.maxBytes - 1), function (ok, buf, totalSize) {
        if (prefetchToken !== token) return; // B1：取消后不再继续
        if (!ok || !buf) {
          tryPrefetchVariant(item, kind, budget, urls, idx + 1, segBase, cid, expires, token);
          return;
        }
        var chunkEnd = Math.min(budget.maxBytes - 1, buf.byteLength - 1);
        writeByteStore(name, url, expires, [{ start: 0, end: chunkEnd, buffer: buf }], totalSize, kind, cid);
      });
      return;
    }

    // 解析 segmentBase 的 init/index 区间（键名 segmentBase 或 SegmentBase 均已兼容）
    var initEnd = -1;
    var headEnd = -1;
    try {
      var ir = uParseRangeHeader(segBase.initialization);
      var xr = uParseRangeHeader(segBase.indexRange);
      if (ir && typeof ir.end === 'number' && ir.end >= 0) initEnd = ir.end;
      if (xr && typeof xr.end === 'number' && xr.end >= 0) headEnd = xr.end;
    } catch (e) { /* fallthrough */ }

    // 畸形 segmentBase → 退化为无 segBase 兜底
    if (initEnd < 0 || headEnd < 0) {
      tryPrefetchVariant(item, kind, budget, urls, idx, null, cid, expires, token);
      return;
    }

    // 步骤3：头部请求 Range: bytes=0-<headEnd>；失败换下一个候选 URL 重试（现有容错风格）
    xhrRange(url, 'bytes=0-' + headEnd, function (ok, headBuf, totalSize) {
      if (prefetchToken !== token) return; // B1：取消后不再继续
      if (!ok || !headBuf) {
        tryPrefetchVariant(item, kind, budget, urls, idx + 1, segBase, cid, expires, token);
        return;
      }

      // 步骤4：解析 indexRange 内 sidx → 构建分段计划（media 段列表）
      var plan = null;
      try {
        var sidx = uParseSidx(headBuf.slice(initEnd + 1, headEnd + 1));
        if (sidx) plan = uBuildSegmentPlan(segBase, sidx, budget);
      } catch (e) { plan = null; }

      var effHeadEnd = headEnd;
      if (plan && typeof plan.headEnd === 'number' && plan.headEnd > effHeadEnd) effHeadEnd = plan.headEnd;

      var finishWithHead = function (finalHead) {
        if (prefetchToken !== token) return; // B1：取消后不再继续
        if (!finalHead) {
          tryPrefetchVariant(item, kind, budget, urls, idx + 1, segBase, cid, expires, token);
          return;
        }
        var hEnd = Math.min(effHeadEnd, finalHead.byteLength - 1);
        var headChunk = { start: 0, end: hEnd, buffer: finalHead };
        var media = (plan && plan.media) || [];
        if (media.length > 0) {
          // media 非空：发一个合并请求覆盖首段到最后一段
          var firstStart = media[0].start;
          var lastEnd = media[media.length - 1].end;
          xhrRange(url, 'bytes=' + firstStart + '-' + lastEnd, function (ok2, mediaBuf, t2) {
            if (prefetchToken !== token) return; // B1：取消后不再继续
            if (!ok2 || !mediaBuf) {
              tryPrefetchVariant(item, kind, budget, urls, idx + 1, segBase, cid, expires, token);
              return;
            }
            writeByteStore(name, url, expires,
              [headChunk, { start: firstStart, end: lastEnd, buffer: mediaBuf }], totalSize, kind, cid);
          });
        } else {
          // media 为空：兜底请求 headEnd+1 起 maxBytes 字节
          var fbStart = hEnd + 1;
          var fbEnd = hEnd + budget.maxBytes;
          xhrRange(url, 'bytes=' + fbStart + '-' + fbEnd, function (ok3, fbBuf, t3) {
            if (prefetchToken !== token) return; // B1：取消后不再继续
            if (!ok3 || !fbBuf) {
              tryPrefetchVariant(item, kind, budget, urls, idx + 1, segBase, cid, expires, token);
              return;
            }
            writeByteStore(name, url, expires,
              [headChunk, { start: fbStart, end: fbEnd, buffer: fbBuf }], totalSize, kind, cid);
          });
        }
      };

      // 计划 headEnd 超出索引段尾时补拉剩余头字节并合并（正常情况 plan.headEnd 即索引段尾，无需补拉）
      if (effHeadEnd <= headEnd) {
        finishWithHead(headBuf);
      } else {
        xhrRange(url, 'bytes=' + (headEnd + 1) + '-' + effHeadEnd, function (ok4, extBuf, t4) {
          if (prefetchToken !== token) return; // B1：取消后不再继续
          if (!ok4 || !extBuf) {
            tryPrefetchVariant(item, kind, budget, urls, idx + 1, segBase, cid, expires, token);
            return;
          }
          var merged = new ArrayBuffer(effHeadEnd + 1);
          var mv = new Uint8Array(merged);
          mv.set(new Uint8Array(headBuf), 0);
          mv.set(new Uint8Array(extBuf), headEnd + 1);
          finishWithHead(merged);
        });
      }
    });
  }

  /** 字节合成 206 响应（在 setTimeout(0) 内执行，仿 playurl 合成时序，满足 dash.js XHRLoader 契约） */
  function serveStoredBytes(self, name, start, end, body) {
    var store = byteStore[name];
    if (!store) throw new Error('no byteStore entry');
    var buf = sliceStoredBytes(store.chunks, start, end);
    var len = buf.byteLength;
    var totalSize = typeof store.totalSize === 'number' ? store.totalSize : -1;
    var totalStr = totalSize >= 0 ? String(totalSize) : '*';

    // responseType 为 text/'' 时用 TextDecoder 转字符串，其余（arraybuffer 等）保持 ArrayBuffer
    var isText = self.responseType === 'text' || self.responseType === '';
    var respVal = buf;
    if (isText) {
      try { respVal = new TextDecoder('utf-8').decode(buf); } catch (e) { respVal = buf; }
    }

    var headersStr = 'content-type: application/octet-stream\r\n' +
      'content-length: ' + len + '\r\n' +
      'content-range: bytes ' + start + '-' + end + '/' + totalStr + '\r\n' +
      'accept-ranges: bytes\r\n';
    var headerMap = {
      'content-type': 'application/octet-stream',
      'content-length': String(len),
      'content-range': 'bytes ' + start + '-' + end + '/' + totalStr,
      'accept-ranges': 'bytes'
    };

    Object.defineProperty(self, 'status', { configurable: true, get: function () { return 206; } });
    Object.defineProperty(self, 'statusText', { configurable: true, get: function () { return 'Partial Content'; } });
    Object.defineProperty(self, 'response', { configurable: true, get: function () { return respVal; } });
    Object.defineProperty(self, 'responseText', { configurable: true, get: function () { return ''; } });
    Object.defineProperty(self, 'responseURL', { configurable: true, get: function () { return self._cinemaOrigUrl; } });
    Object.defineProperty(self, 'readyState', { configurable: true, writable: true, value: 2 });
    Object.defineProperty(self, 'getAllResponseHeaders', {
      configurable: true,
      value: function () { return headersStr; }
    });
    Object.defineProperty(self, 'getResponseHeader', {
      configurable: true,
      value: function (n) {
        var k = String(n || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(headerMap, k) ? headerMap[k] : null;
      }
    });

    // readyState=2 → readystatechange（dash.js 在此调 getAllResponseHeaders 回调 onHeadersReceived）
    try {
      if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
      self.dispatchEvent(new Event('readystatechange'));
    } catch (e) { /* ignore */ }
    // progress（loaded/total 供吞吐估计）
    try {
      self.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: len, total: len }));
      if (typeof self.onprogress === 'function') self.onprogress();
    } catch (e) { /* ignore */ }
    // readyState=4 → readystatechange（dash.js 在此读 status/response）
    self.readyState = 4;
    try {
      if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
      self.dispatchEvent(new Event('readystatechange'));
    } catch (e) { /* ignore */ }
    // 完成时再 progress 一次（dash.js 靠完成时进度估算带宽）
    try {
      self.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: len, total: len }));
      if (typeof self.onprogress === 'function') self.onprogress();
    } catch (e) { /* ignore */ }
    // load → loadend
    try {
      self.dispatchEvent(new Event('load'));
      if (typeof self.onload === 'function') self.onload();
    } catch (e) { /* ignore */ }
    try {
      self.dispatchEvent(new Event('loadend'));
      if (typeof self.onloadend === 'function') self.onloadend();
    } catch (e) { /* ignore */ }
  }

  function cinemaXHR() {
    var xhr = new NativeXHR();
    var origOpen = xhr.open;
    var origSend = xhr.send;
    var origAbort = xhr.abort;
    var origSetRequestHeader = xhr.setRequestHeader;

    xhr.open = function (method, url) {
      // 清除上一次合成响应留下的影子属性（XHR 可能被复用）
      this._cinemaOrigUrl = url;
      this._cinemaByteCandidate = undefined;
      this._cinemaReqRange = undefined;
      this._cinemaPlayurlCache = undefined;
      try {
        delete this.responseText;
        delete this.response;
        delete this.status;
        delete this.statusText;
        delete this.readyState;
        delete this.responseURL;
        delete this.getAllResponseHeaders;
        delete this.getResponseHeader;
      } catch (e) { /* ignore */ }

      if (method === 'GET' && typeof url === 'string') {
        // 流请求：记录文件名；按 cid+basename 键查 byteStore，命中且未过期则标记字节合成候选
        if (url.indexOf('upgcxcode') !== -1) {
          var name = url.split('/').pop().split('?')[0];
          // Important #1：URL 带 cid 用之，否则回退当前播放 cid ——
          // 只可能命中"该 cid 自己的预取字节"，绝不会把别的分P字节喂给本请求
          var cid = cidFromUrl(url) || bridgeConfig.currentCid;
          if (name.indexOf('.m4s') !== -1) {
            if (uIsAudioStreamFilename(name)) lastAudioName = name;
            else lastVideoName = name;
            if (cid > 0) {
              var sk = storeKey(cid, name);
              var bhit = byteStore[sk];
              if (bridgeConfig.fastSwitch && bhit && bhit.expires > Date.now()) {
                this._cinemaByteCandidate = sk;
              }
            }
          }
          // 保留 prefetchTable URL 重写逻辑（作为未合成时的兜底，配合 upos HTTP 缓存秒开）
          if (cid > 0) {
            var hit = prefetchTable[storeKey(cid, name)];
            if (hit && hit.expires > Date.now() && url !== hit.url) {
              url = hit.url;
            }
          }
        }
        // playurl API 缓存命中：仅当请求 fnval 与缓存条目一致时才标记本地合成响应（省掉一个网络往返）
        if (bridgeConfig.fastSwitch && url.indexOf('playurl') !== -1 && url.indexOf('/x/player/') !== -1) {
          var cm = url.match(/cid=(\d+)/);
          var fn = url.match(/[?&]fnval=(\d+)/);
          var qm = url.match(/[?&]qn=(\d+)/);
          if (cm && fn && qm) {
            var ph = playurlCache[cm[1]];
            if (ph && ph.expires > Date.now() && cm[1] !== String(bridgeConfig.currentCid) && fn[1] === ph.fnval && qm[1] === ph.qn) {
              this._cinemaPlayurlCache = ph.json;
            }
          }
        }
      }
      // 注意：须把改写后的 url 传下去（严格模式下 arguments 与形参不再联动），并保留额外参数
      var openArgs = Array.prototype.slice.call(arguments);
      openArgs[1] = url;
      return origOpen.apply(this, openArgs);
    };

    xhr.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === 'range') this._cinemaReqRange = value;
      return origSetRequestHeader.call(this, name, value);
    };

    xhr.send = function (body) {
      var self = this;
      var cached = this._cinemaPlayurlCache;
      if (cached) {
        // 用宏任务延迟合成：兼容播放器在 send() 之后才挂监听器的写法
        var text = JSON.stringify(cached);
        setTimeout(function () {
          if (self._cinemaAborted) return;
          try {
            Object.defineProperty(self, 'responseText', { configurable: true, get: function () { return text; } });
            Object.defineProperty(self, 'response', {
              configurable: true,
              get: function () {
                if (self.responseType === 'json') {
                  try { return JSON.parse(text); } catch (e) { return text; }
                }
                return text;
              }
            });
            Object.defineProperty(self, 'status', { configurable: true, get: function () { return 200; } });
            Object.defineProperty(self, 'statusText', { configurable: true, get: function () { return 'OK'; } });
            Object.defineProperty(self, 'readyState', { configurable: true, get: function () { return 4; } });
            Object.defineProperty(self, 'responseURL', { configurable: true, get: function () { return ''; } });
            if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
            if (typeof self.onload === 'function') self.onload();
            if (typeof self.onloadend === 'function') self.onloadend();
            try {
              self.dispatchEvent(new Event('load'));
              self.dispatchEvent(new Event('loadend'));
            } catch (e) { /* ignore */ }
          } catch (e) {
            // 合成失败：放行真实请求
            self._cinemaPlayurlCache = null;
            origSend.call(self, body);
          }
        }, 0);
        return;
      }

      // 字节合成分支（playurl 之后、优先级次之）：byteStore 命中 && Range 有界 && 被覆盖 → 本地切片 206
      var bname = this._cinemaByteCandidate;
      if (bname) {
        var bs = byteStore[bname];
        var brng = null;
        try {
          if (this._cinemaReqRange) brng = uParseRangeHeader(this._cinemaReqRange);
        } catch (e) { brng = null; }
        if (bs && brng && typeof brng.start === 'number' && typeof brng.end === 'number') {
          try {
            if (uRangeCovered(bs.chunks, brng.start, brng.end)) {
              if (this._cinemaAborted) return;
              setTimeout(function () {
                if (self._cinemaAborted) return;
                try {
                  serveStoredBytes(self, bname, brng.start, brng.end, body);
                } catch (e) {
                  // 合成失败：清标记回退真实请求（URL 已按 prefetchTable 重写过）
                  self._cinemaByteCandidate = undefined;
                  try { origSend.call(self, body); } catch (e2) { /* ignore */ }
                }
              }, 0);
              return;
            }
          } catch (e) { /* fallthrough → 走 URL 重写 + origSend */ }
        }
      }

      return origSend.apply(this, arguments);
    };

    xhr.abort = function () {
      this._cinemaAborted = true;
      try { origAbort.call(this); } catch (e) { /* ignore */ }
    };

    return xhr;
  }
  cinemaXHR.prototype = NativeXHR.prototype;
  // 静态常量（播放器可能使用 XMLHttpRequest.DONE 等）
  cinemaXHR.UNSENT = NativeXHR.UNSENT;
  cinemaXHR.OPENED = NativeXHR.OPENED;
  cinemaXHR.HEADERS_RECEIVED = NativeXHR.HEADERS_RECEIVED;
  cinemaXHR.LOADING = NativeXHR.LOADING;
  cinemaXHR.DONE = NativeXHR.DONE;
  window.XMLHttpRequest = cinemaXHR;

  /** fetch 包装：playurl 缓存秒回 + 字节合成 + 流 URL 命中预取表时重写为预取直连 URL */
  var NativeFetch = window.fetch;
  if (typeof NativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';

      // B5：流请求记录播放器最近请求的文件名（与 XHR 包装同一逻辑），
      // 供预取按码率码匹配主变体（fetch 路径的播放器请求也需要吃到匹配）
      if (url.indexOf('upgcxcode') !== -1 && url.indexOf('.m4s') !== -1) {
        var fnameTrack = url.split('/').pop().split('?')[0];
        if (uIsAudioStreamFilename(fnameTrack)) lastAudioName = fnameTrack;
        else lastVideoName = fnameTrack;
      }

      // playurl API 缓存命中（仅当请求 fnval 与缓存条目一致时）→ 直接返回本地 JSON（省一个 RTT）
      if (bridgeConfig.fastSwitch && url.indexOf('playurl') !== -1 && url.indexOf('/x/player/') !== -1) {
        var fm = url.match(/cid=(\d+)/);
        var ffn = url.match(/[?&]fnval=(\d+)/);
        var fqm = url.match(/[?&]qn=(\d+)/);
        if (fm && ffn && fqm) {
          var fh = playurlCache[fm[1]];
          if (fh && fh.expires > Date.now() && fm[1] !== String(bridgeConfig.currentCid) && ffn[1] === fh.fnval && fqm[1] === fh.qn) {
            var ftext = JSON.stringify(fh.json);
            return Promise.resolve(new Response(ftext, {
              status: 200,
              statusText: 'OK',
              headers: { 'Content-Type': 'application/json' }
            }));
          }
        }
      }

      // 字节合成（内存预取）：fastSwitch && m4s && byteStore 命中 && Range 头被覆盖 → 本地切片 206
      if (bridgeConfig.fastSwitch && url.indexOf('upgcxcode') !== -1 && url.indexOf('.m4s') !== -1) {
        var fbname = url.split('/').pop().split('?')[0];
        var fc = cidFromUrl(url) || bridgeConfig.currentCid;
        if (fc > 0) {
          var fbs = byteStore[storeKey(fc, fbname)];
          if (fbs && fbs.expires > Date.now()) {
            try {
              var frng = uParseRangeHeader(getFetchRange(input, init));
              if (frng && typeof frng.start === 'number' && typeof frng.end === 'number' &&
                  uRangeCovered(fbs.chunks, frng.start, frng.end)) {
                var fsb = sliceStoredBytes(fbs.chunks, frng.start, frng.end);
                var ftotal = fbs.totalSize >= 0 ? String(fbs.totalSize) : '*';
                return Promise.resolve(new Response(fsb, {
                  status: 206,
                  statusText: 'Partial Content',
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(fsb.byteLength),
                    'Content-Range': 'bytes ' + frng.start + '-' + frng.end + '/' + ftotal,
                    'Accept-Ranges': 'bytes'
                  }
                }));
              }
            } catch (e) { /* fallthrough → 走现有重写兜底 */ }
          }
        }
      }

      // 流请求：文件名命中预取表 → 重写为预取过的直连 URL（同样按 cid+basename 键匹配）
      if (url.indexOf('upgcxcode') !== -1 && url.indexOf('.m4s') !== -1) {
        var fname = url.split('/').pop().split('?')[0];
        var fc2 = cidFromUrl(url) || bridgeConfig.currentCid;
        if (fc2 > 0) {
          var fhit = prefetchTable[storeKey(fc2, fname)];
          if (fhit && fhit.expires > Date.now() && url !== fhit.url) {
            if (typeof input === 'string') {
              return NativeFetch.call(this, fhit.url, init);
            }
            try {
              return NativeFetch.call(this, new Request(fhit.url, input), init);
            } catch (e) { /* fallthrough */ }
          }
        }
      }

      return NativeFetch.apply(this, arguments);
    };
  }

  /** 预取下一P（由 content.js 通过 __cinema_prefetch__ 事件触发） */
  function doPrefetch(bvid, cid, qn) {
    if (!bvid || !cid) return;
    // Important #2：已有预取进行中（playurl 请求或流 XHR 在途）时忽略新请求。
    // 不再因"目标 cid 不同"而中止旧预取 —— 中止只由 __cinema_prefetch_cancel__ 显式触发，
    // 否则悬停按需预取会误杀正在进行的自动下一P预取，导致后续切换无字节可用。
    if (prefetchBusy || livePrefetchXhrs.length > 0) return;
    prefetchBusy = true;
    var token = prefetchToken;
    fetch('https://api.bilibili.com/x/player/wbi/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + cid + '&qn=' + (qn || 80) + '&fnval=4048&fourk=1', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (prefetchToken !== token) { prefetchBusy = false; return; } // 已被取消：丢弃过期结果
        var dash = json && json.data && json.data.dash;
        if (!dash) {
          prefetchBusy = false;
          window.dispatchEvent(new CustomEvent('__cinema_prefetch_done__', {
            detail: JSON.stringify({ ok: false, reason: 'no dash', cid: cid })
          }));
          return;
        }

        // 收集全部候选 URL（baseUrl + backupUrl），用于计算 expires 与后续码率匹配
        var allCandidates = [];
        var collectAll = function (arr) {
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (it && it.baseUrl) allCandidates.push(it.baseUrl);
            if (it && it.backupUrl && it.backupUrl.length) {
              for (var b = 0; b < it.backupUrl.length; b++) allCandidates.push(it.backupUrl[b]);
            }
          }
        };
        collectAll(dash.video || []);
        collectAll(dash.audio || []);
        if (allCandidates.length === 0) {
          prefetchBusy = false;
          window.dispatchEvent(new CustomEvent('__cinema_prefetch_done__', {
            detail: JSON.stringify({ ok: false, reason: 'no url', cid: cid })
          }));
          return;
        }

        // expires 统一取自流 URL 鉴权 deadline（取全部候选最小 unix 秒 -300s），取不到才用 2 小时兜底
        var expires = computeExpires(allCandidates);

        // 缓存 playurl 响应（LRU 上限 12，B4）：切换时播放器请求同 cid 且同 fnval 的 playurl 直接本地秒回
        writePlayurlCache(cid, { json: json, expires: expires, fnval: '4048', qn: String(qn || 80) });

        // 构建每个流变体的排序 URL 列表（upos 优先、mcdn 靠后、其余居中；同分 backup 优先）
        var buildVariants = function (arr) {
          var out = [];
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (!it) continue;
            var urls = [];
            if (it.baseUrl) urls.push(it.baseUrl);
            if (it.backupUrl && it.backupUrl.length) {
              for (var b = 0; b < it.backupUrl.length; b++) urls.push(it.backupUrl[b]);
            }
            if (urls.length === 0) continue;
            out.push({ item: it, urls: rankUrls(urls) });
          }
          return out;
        };
        var videoVariants = buildVariants(dash.video || []);
        var audioVariants = buildVariants(dash.audio || []);

        // 码率码匹配（保留现有逻辑）：与播放器当前所用流码率码一致的第一个变体为主变体
        var vc = uExtractStreamCode(lastVideoName);
        var ac = uExtractStreamCode(lastAudioName);
        var videoStreams = [];
        if (vc) {
          for (var vi = 0; vi < videoVariants.length; vi++) {
            if (uMatchStreamUrls(videoVariants[vi].urls, vc).length > 0) {
              videoStreams.push(videoVariants[vi]);
              break;
            }
          }
          if (videoStreams.length === 0) videoStreams = videoVariants.slice(0, 3);
        } else {
          // 未知码率码：取前 3 个视频变体（覆盖 AVC/HEVC/AV1 不同编码）
          videoStreams = videoVariants.slice(0, 3);
        }

        var audioStreams = [];
        if (ac) {
          for (var ai = 0; ai < audioVariants.length; ai++) {
            if (uMatchStreamUrls(audioVariants[ai].urls, ac).length > 0) {
              audioStreams.push(audioVariants[ai]);
              break;
            }
          }
          if (audioStreams.length === 0) audioStreams = audioVariants.slice(0, 1);
        } else {
          audioStreams = audioVariants.slice(0, 1);
        }

        // 逐流预取（视频各变体 + 音频各自独立并发）。
        // 预算：主变体视频 {25s, 8MB}；兜底变体视频 {10s, 1.5MB}；音频 {25s, 1MB}。
        // 注意：预取必须用 XHR 而非 fetch —— 实测 B站 CDN（bilivideo.com）
        // 对页面 fetch 返回 Failed to fetch（网络层拦截），而 XHR 正常（206）
        for (var sv = 0; sv < videoStreams.length; sv++) {
          var vBudget = sv === 0
            ? { targetSeconds: 25, maxBytes: 8 * 1048576 }
            : { targetSeconds: 10, maxBytes: 1.5 * 1048576 };
          prefetchStream(videoStreams[sv].item, 'video', vBudget, videoStreams[sv].urls, cid, expires, token);
        }
        for (var sa = 0; sa < audioStreams.length; sa++) {
          prefetchStream(audioStreams[sa].item, 'audio',
            { targetSeconds: 25, maxBytes: 1 * 1048576 }, audioStreams[sa].urls, cid, expires, token);
        }
        prefetchBusy = false; // playurl 解析完成、各流已启动，剩余在途由 livePrefetchXhrs 跟踪
      })
      .catch(function () {
        prefetchBusy = false;
        if (prefetchToken !== token) return; // 已取消，静默
        window.dispatchEvent(new CustomEvent('__cinema_prefetch_done__', {
          detail: JSON.stringify({ ok: false, reason: 'api error', cid: cid })
        }));
      });
  }

  // ============================================================
  //  P2P 屏蔽（可选开关）：删除 P2P SDK 全局 + 定期重删 __DASH_P2P_TYPE__，
  //  走 bwp 自带的"SDK 缺失 → 删类型 → 纯 XHR"安全回退路径（零悬挂、零异常）。
  //  不再替换 RTCPeerConnection——构造即抛错会触发 ~2s connectTimeout 悬挂，
  //  反而拖慢分P切换黑屏（调研确认：分片加载即时路径无 try/catch）。
  // ============================================================
  // bwp 核心按 __DASH_P2P_TYPE__ 前缀映射查找这些 SDK 全局，任一缺失即 delete __DASH_P2P_TYPE__ 回退 XHR
  var P2P_SDK_GLOBALS = ['DIYSdk', 'KSLoader', 'PearDownloader', 'YFDashIO', 'xyvp'];
  var p2pGuardTimer = null;
  var p2pBlocked = false;

  /** 删除 P2P SDK 全局与 __DASH_P2P_TYPE__（核心每个分片请求现读，删掉即回退 XHR） */
  function clearP2pGlobals() {
    try {
      for (var i = 0; i < P2P_SDK_GLOBALS.length; i++) {
        try { delete window[P2P_SDK_GLOBALS[i]]; } catch (e) { /* ignore */ }
      }
      try { delete window.__DASH_P2P_TYPE__; } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  /**
   * 屏蔽 B站 P2P 混流：删除 SDK 全局 + 250ms 定期重删 __DASH_P2P_TYPE__。
   * SDK 脚本由 setP2pType 动态注入并重定义全局，故开启期间持续压制。
   * 失败开放：B站改名则屏蔽静默失效，回到默认行为（不会更糟）。
   */
  function applyP2PBlock() {
    if (p2pBlocked) return;
    p2pBlocked = true;
    clearP2pGlobals();
    p2pGuardTimer = setInterval(clearP2pGlobals, 250);
  }

  /** 关闭屏蔽：停止定期重删，放行后续 P2P 能力（已删全局由播放器自行重注入） */
  function restoreRTC() {
    if (!p2pBlocked) return;
    p2pBlocked = false;
    if (p2pGuardTimer) { clearInterval(p2pGuardTimer); p2pGuardTimer = null; }
  }

  /** 接收 content.js 的预取请求 */
  window.addEventListener('__cinema_prefetch__', function (e) {
    var d = parseDetail(e);
    doPrefetch(d.bvid, d.cid, d.qn);
  });

  /** 接收 content.js 的预取取消事件（B1：切换开始时中止在途预取） */
  window.addEventListener('__cinema_prefetch_cancel__', function () {
    abortPrefetchXhrs();
  });

  /** 接收 content.js 下发的配置（fastSwitch 开关、当前播放 cid、p2pBlock 开关） */
  window.addEventListener('__cinema_config__', function (e) {
    var d = parseDetail(e);
    if (typeof d.fastSwitch === 'boolean') bridgeConfig.fastSwitch = d.fastSwitch;
    if (typeof d.currentCid === 'number') bridgeConfig.currentCid = d.currentCid;
    if (d.p2pBlock === true) applyP2PBlock();
    if (d.p2pBlock === false && p2pBlocked) restoreRTC();
  });

  // P2P 屏蔽：启动时从 storage 读取设置（与 content.js 下发双保险，覆盖内容脚本尚未就绪的窗口期）
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get('cinemaSettings', function (r) {
        try {
          if (r && r.cinemaSettings && r.cinemaSettings.p2pBlock === true) applyP2PBlock();
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* ignore */ }
})();
