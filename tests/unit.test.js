/**
 * B站影院模式 - 纯函数单元测试
 * 运行：node --test tests/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const utils = require('../cinema-utils.js');

test('formatTime 基础格式', () => {
  assert.strictEqual(utils.formatTime(0), '0:00');
  assert.strictEqual(utils.formatTime(59), '0:59');
  assert.strictEqual(utils.formatTime(61), '1:01');
  assert.strictEqual(utils.formatTime(3599), '59:59');
  assert.strictEqual(utils.formatTime(3600), '1:00:00');
  assert.strictEqual(utils.formatTime(3661), '1:01:01');
});

test('formatTime 边界与非法输入', () => {
  assert.strictEqual(utils.formatTime(-5), '0:00');
  assert.strictEqual(utils.formatTime(3.99), '0:03');
  assert.strictEqual(utils.formatTime(NaN), '0:00');
});

test('formatRelativeTime 各区间', () => {
  const now = Date.now();
  assert.strictEqual(utils.formatRelativeTime(now - 1000), '刚刚');
  assert.strictEqual(utils.formatRelativeTime(now - 5 * 60 * 1000), '5分钟前');
  assert.strictEqual(utils.formatRelativeTime(now - 2 * 3600 * 1000), '2小时前');
  assert.strictEqual(utils.formatRelativeTime(now - 3 * 24 * 3600 * 1000), '3天前');
  const d = new Date(now - 20 * 24 * 3600 * 1000);
  const expect = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.strictEqual(utils.formatRelativeTime(now - 20 * 24 * 3600 * 1000), expect);
});

test('escapeHtml 转义', () => {
  assert.strictEqual(utils.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.strictEqual(utils.escapeHtml(''), '');
  assert.strictEqual(utils.escapeHtml(null), '');
});

test('qualityTextToQn 映射', () => {
  assert.strictEqual(utils.qualityTextToQn('4K 超清'), 120);
  assert.strictEqual(utils.qualityTextToQn('2160P 超清'), 120);
  assert.strictEqual(utils.qualityTextToQn('1080P 60帧'), 116);
  assert.strictEqual(utils.qualityTextToQn('1080P 高帧率'), 116);
  assert.strictEqual(utils.qualityTextToQn('1080P 高码率'), 112);
  assert.strictEqual(utils.qualityTextToQn('1080P+'), 112);
  assert.strictEqual(utils.qualityTextToQn('1080P 高清'), 80);
  assert.strictEqual(utils.qualityTextToQn('720P 高清'), 64);
  assert.strictEqual(utils.qualityTextToQn('480P 清晰'), 32);
  assert.strictEqual(utils.qualityTextToQn('360P 流畅'), 16);
  // 括号内提取
  assert.strictEqual(utils.qualityTextToQn('自动(480P 清晰)'), 32);
  assert.strictEqual(utils.qualityTextToQn('未知画质'), 80);
});

test('qualityTextToQn 新兜底（分辨率正则未命中时）', () => {
  assert.strictEqual(utils.qualityTextToQn('8K'), 127);
  assert.strictEqual(utils.qualityTextToQn('杜比视界'), 125);
  assert.strictEqual(utils.qualityTextToQn('HDR 真彩'), 125);
  assert.strictEqual(utils.qualityTextToQn('1080'), 80); // 无 P 后缀 → 数字兜底
  // 回归：原有"分辨率优先"匹配逻辑不受影响
  assert.strictEqual(utils.qualityTextToQn('1080P 高清'), 80);
  assert.strictEqual(utils.qualityTextToQn('720P 高清'), 64);
  assert.strictEqual(utils.qualityTextToQn('自动(480P 标清)'), 32);
});

test('matchStreamUrls 按码率码过滤并按文件名去重（保序）', () => {
  const urls = [
    'https://cdn.example.com/a-1-100022.m4s?v=1',
    'https://cdn.example.com/b-1-30280.m4s',
    'https://cdn.example.com/b-1-100022.m4s',
    'https://cdn.example.com/a-1-100022.m4s?v=1', // 与首个同文件名，应去重
  ];
  assert.deepStrictEqual(utils.matchStreamUrls(urls, '100022'), [
    'https://cdn.example.com/a-1-100022.m4s?v=1',
    'https://cdn.example.com/b-1-100022.m4s',
  ]);
});

test('matchStreamUrls code 为空串时不过滤但去重', () => {
  const urls = [
    'https://cdn.example.com/a-1-100022.m4s',
    'https://cdn.example.com/a-1-30280.m4s',
    'https://cdn.example.com/a-1-100022.m4s?x=1', // 同文件名去重
  ];
  assert.deepStrictEqual(utils.matchStreamUrls(urls, ''), [
    'https://cdn.example.com/a-1-100022.m4s',
    'https://cdn.example.com/a-1-30280.m4s',
  ]);
});

test('matchStreamUrls 无匹配返回空数组', () => {
  assert.deepStrictEqual(
    utils.matchStreamUrls(
      ['https://cdn.example.com/a-1-30280.m4s', 'https://cdn.example.com/b-1-30280.m4s'],
      '100022'
    ),
    []
  );
});

test('extractStreamCode 提取码率码', () => {
  assert.strictEqual(utils.extractStreamCode('xxx-1-100022.m4s'), '100022');
  assert.strictEqual(utils.extractStreamCode('xxx-1-30280.m4s'), '30280');
  assert.strictEqual(utils.extractStreamCode('abc.mp4'), '');
});

test('isAudioStreamFilename 判断音频流文件名', () => {
  assert.strictEqual(utils.isAudioStreamFilename('a-1-30280.m4s'), true);
  assert.strictEqual(utils.isAudioStreamFilename('a-1-100022.m4s'), false);
});

test('buildCumulative 前缀和', () => {
  const { cumulative, totalDuration } = utils.buildCumulative([10, 20, 30]);
  assert.deepStrictEqual(cumulative, [0, 10, 30, 60]);
  assert.strictEqual(totalDuration, 60);
  // 空数组
  assert.deepStrictEqual(utils.buildCumulative([]).cumulative, [0]);
  assert.strictEqual(utils.buildCumulative([]).totalDuration, 0);
  // 缺失/非法时长按 0 处理
  const r = utils.buildCumulative([10, undefined, 30]);
  assert.deepStrictEqual(r.cumulative, [0, 10, 10, 40]);
});

test('overallToPartOffset 定位', () => {
  const cumulative = [0, 10, 30, 60];
  assert.deepStrictEqual(utils.overallToPartOffset(cumulative, 0), { index: 0, offset: 0 });
  assert.deepStrictEqual(utils.overallToPartOffset(cumulative, 9.9), { index: 0, offset: 9.9 });
  assert.deepStrictEqual(utils.overallToPartOffset(cumulative, 30), { index: 2, offset: 0 });
  assert.deepStrictEqual(utils.overallToPartOffset(cumulative, 59), { index: 2, offset: 29 });
  // 超出范围 → null
  assert.strictEqual(utils.overallToPartOffset(cumulative, 60), null);
  assert.strictEqual(utils.overallToPartOffset(cumulative, -1), null);
});

// ========== 新增：sidx / 分段预取 / Range 头 / 区间覆盖 ==========

/** 大端序写入无符号整数（构造 sidx 用） */
function writeU32(arr, off, v) {
  arr[off] = (v >>> 24) & 0xff;
  arr[off + 1] = (v >>> 16) & 0xff;
  arr[off + 2] = (v >>> 8) & 0xff;
  arr[off + 3] = v & 0xff;
}
function writeU16(arr, off, v) {
  arr[off] = (v >>> 8) & 0xff;
  arr[off + 1] = v & 0xff;
}

/** 构造 version 0 的 sidx box（含 8B box 头），refs: [{ size, duration }] */
function buildSidxBox(timescale, refs) {
  const len = 8 + 24 + refs.length * 12;
  const b = new Uint8Array(len);
  writeU32(b, 0, len); // box size
  b[4] = 0x73; b[5] = 0x69; b[6] = 0x64; b[7] = 0x78; // 'sidx'
  b[8] = 0; // version 0（flags 默认 0）
  writeU32(b, 12, 1); // reference_ID
  writeU32(b, 16, timescale);
  writeU32(b, 20, 0); // earliest_presentation_time
  writeU32(b, 24, 0); // first_offset
  writeU16(b, 28, 0); // reserved
  writeU16(b, 30, refs.length); // reference_count
  let off = 32;
  for (const ref of refs) {
    writeU32(b, off, ref.size); // reference_type<<31 | referenced_size
    writeU32(b, off + 4, ref.duration);
    writeU32(b, off + 8, 0); // SAP
    off += 12;
  }
  return b;
}

test('parseSidx 解析 version 0 sidx', () => {
  const sidxBytes = buildSidxBox(1000, [
    { size: 1000, duration: 2000 },
    { size: 2000, duration: 4000 },
  ]);
  const r = utils.parseSidx(sidxBytes);
  assert.strictEqual(r.timescale, 1000);
  assert.strictEqual(r.refs.length, 2);
  assert.deepStrictEqual(r.refs[0], { size: 1000, duration: 2000, isMedia: true });
  assert.deepStrictEqual(r.refs[1], { size: 2000, duration: 4000, isMedia: true });
  // 也接受 ArrayBuffer 输入
  const r2 = utils.parseSidx(sidxBytes.buffer);
  assert.deepStrictEqual(r2, { timescale: 1000, refs: r.refs });
  // 前面有非 sidx box 时按 size 跳过
  const ftyp = new Uint8Array(16);
  writeU32(ftyp, 0, 16);
  ftyp[4] = 0x66; ftyp[5] = 0x74; ftyp[6] = 0x79; ftyp[7] = 0x70; // 'ftyp'
  const combined = new Uint8Array(16 + sidxBytes.length);
  combined.set(ftyp, 0);
  combined.set(sidxBytes, 16);
  const r3 = utils.parseSidx(combined);
  assert.strictEqual(r3.timescale, 1000);
  assert.deepStrictEqual(r3.refs, r.refs);
});

test('parseSidx 垃圾输入返回 null', () => {
  assert.strictEqual(utils.parseSidx(new Uint8Array(0)), null);
  assert.strictEqual(utils.parseSidx(new Uint8Array([0x00, 0x01, 0x02])), null);
  assert.strictEqual(utils.parseSidx(new Uint8Array(64).fill(0x41)), null); // size 字段巨大 → 越界
  assert.strictEqual(utils.parseSidx(null), null);
  assert.strictEqual(utils.parseSidx('not a buffer'), null);
});

test('buildSegmentPlan 生成逐段预取计划（几何与连续边界）', () => {
  const segmentBase = { initialization: '0-1021', indexRange: '1022-5985' };
  const sidx = {
    timescale: 1000,
    refs: [
      { size: 1000, duration: 1000, isMedia: true },
      { size: 1000, duration: 1000, isMedia: true },
      { size: 1000, duration: 1000, isMedia: true },
    ],
  };
  const plan = utils.buildSegmentPlan(segmentBase, sidx);
  assert.strictEqual(plan.headEnd, 5985);
  assert.deepStrictEqual(plan.media, [
    { start: 5986, end: 6985 },
    { start: 6986, end: 7985 },
    { start: 7986, end: 8985 },
  ]);
  assert.strictEqual(plan.totalBytes, 3000);
  assert.strictEqual(plan.coveredSeconds, 3);
});

test('buildSegmentPlan maxBytes 截断与 sidx 为 null 兜底', () => {
  const segmentBase = { initialization: '0-1021', indexRange: '1022-5985' };
  const sidx = {
    timescale: 1000,
    refs: [
      { size: 1000, duration: 1000, isMedia: true },
      { size: 1000, duration: 1000, isMedia: true },
      { size: 1000, duration: 1000, isMedia: true },
    ],
  };
  const plan = utils.buildSegmentPlan(segmentBase, sidx, { maxBytes: 1500 });
  assert.strictEqual(plan.media.length, 2);
  assert.strictEqual(plan.totalBytes, 2000);
  assert.strictEqual(plan.coveredSeconds, 2);
  // sidx 为 null / 无 refs → media 空数组（调用方走兜底）
  assert.deepStrictEqual(utils.buildSegmentPlan(segmentBase, null).media, []);
  assert.deepStrictEqual(utils.buildSegmentPlan(segmentBase, { timescale: 1000, refs: [] }).media, []);
  // segmentBase 范围非法 → null
  assert.strictEqual(utils.buildSegmentPlan({ initialization: 'x', indexRange: 'y' }, sidx), null);
});

test('parseRangeHeader 解析闭合/开放/非法', () => {
  assert.deepStrictEqual(utils.parseRangeHeader('bytes=0-1021'), { start: 0, end: 1021 });
  assert.deepStrictEqual(utils.parseRangeHeader('bytes=12345-'), { start: 12345, end: null });
  assert.strictEqual(utils.parseRangeHeader('items=0-1021'), null);
  assert.strictEqual(utils.parseRangeHeader('bytes=abc'), null);
  assert.strictEqual(utils.parseRangeHeader('bytes=1021'), null);
  assert.strictEqual(utils.parseRangeHeader('bytes=-500'), null);
  assert.strictEqual(utils.parseRangeHeader(''), null);
  assert.strictEqual(utils.parseRangeHeader(null), null);
});

test('rangeCovered 判断区间是否被覆盖', () => {
  const chunks = [
    { start: 0, end: 1021 },
    { start: 2000, end: 2999 },
  ];
  assert.strictEqual(utils.rangeCovered(chunks, 0, 1021), true);
  assert.strictEqual(utils.rangeCovered(chunks, 100, 900), true); // 完全落在 chunk0
  assert.strictEqual(utils.rangeCovered(chunks, 900, 2001), false); // 横跨两个 chunk
  assert.strictEqual(utils.rangeCovered(chunks, 0, null), false); // end 为 null
  assert.strictEqual(utils.rangeCovered([], 0, 100), false); // chunks 为空
  assert.strictEqual(utils.rangeCovered(null, 0, 100), false); // 非法输入
});

// ========== 进度条重构新增测试：buildChapterGradient / 底栏时间 / 跨P定位 ==========

test('buildChapterGradient 单P或空输入返回空串', () => {
  assert.strictEqual(utils.buildChapterGradient([], [0], 0), '');
  assert.strictEqual(utils.buildChapterGradient([{ page: 1 }], [0, 100], 100), '');
  assert.strictEqual(utils.buildChapterGradient(null, null, 100), '');
  assert.strictEqual(utils.buildChapterGradient([{ page: 1 }, { page: 2 }], [0, 50, 100], 0), '');
});

test('buildChapterGradient 多P分段着色与边界分隔', () => {
  const pages = [{ page: 1, part: '第一集' }, { page: 2, part: '第二集' }];
  const { cumulative, totalDuration } = utils.buildCumulative([60, 60]);
  const grad = utils.buildChapterGradient(pages, cumulative, totalDuration);
  assert.ok(grad.startsWith('linear-gradient(90deg, '));
  // 校验包含第1段HSL颜色 (187° 48%) 与第2段HSL颜色 (207° 36%)
  assert.ok(grad.includes('hsl(187, 100%, 48%)'));
  assert.ok(grad.includes('hsl(207, 100%, 36%)'));
  // 校验包含分P边界 2px 硬分隔
  assert.ok(grad.includes('rgba(0, 0, 0, 0.45) 50.000%'));
  assert.ok(grad.includes('rgba(0, 0, 0, 0.45) calc(50.000% + 2px)'));
  assert.ok(grad.includes('hsl(207, 100%, 36%) calc(50.000% + 2px)'));
  assert.ok(grad.includes('hsl(207, 100%, 36%) 100.000%'));
});

test('buildChapterGradient 3P及以上交替着色', () => {
  const pages = [{ page: 1 }, { page: 2 }, { page: 3 }];
  const { cumulative, totalDuration } = utils.buildCumulative([100, 100, 100]);
  const grad = utils.buildChapterGradient(pages, cumulative, totalDuration);
  assert.ok(grad.startsWith('linear-gradient(90deg, '));
  // P1: 0% -> 33.333% (187, 48%)
  assert.ok(grad.includes('hsl(187, 100%, 48%) 33.333%'));
  // P2: 33.333% -> 66.667% (207, 36%)
  assert.ok(grad.includes('hsl(207, 100%, 36%) 66.667%'));
  // P3: 66.667% -> 100.000% (187, 48%)
  assert.ok(grad.includes('hsl(187, 100%, 48%) 100.000%'));
});

test('buildChapterGradient 边界异常输入防御', () => {
  // cumulative 长度不足 pages.length + 1
  assert.strictEqual(utils.buildChapterGradient([{ page: 1 }, { page: 2 }], [0], 100), '');
  // totalDuration 为负数、NaN 或非法类型
  assert.strictEqual(utils.buildChapterGradient([{ page: 1 }, { page: 2 }], [0, 50, 100], -10), '');
  assert.strictEqual(utils.buildChapterGradient([{ page: 1 }, { page: 2 }], [0, 50, 100], NaN), '');
  assert.strictEqual(utils.buildChapterGradient([{ page: 1 }, { page: 2 }], [0, 50, 100], '100'), '');
  // cumulative 包含 NaN 或负数
  const grad = utils.buildChapterGradient([{ page: 1 }, { page: 2 }], [0, NaN, 100], 100);
  assert.ok(!grad.includes('NaN'), 'Gradient must not contain NaN');
});

test('buildChapterGradient 大分P数量（50+ P）性能与格式正确性', () => {
  const count = 60;
  const pages = [];
  const durations = [];
  for (let i = 1; i <= count; i++) {
    pages.push({ page: i, part: `第${i}集` });
    durations.push(100);
  }
  const { cumulative, totalDuration } = utils.buildCumulative(durations);
  assert.strictEqual(totalDuration, 6000);
  const grad = utils.buildChapterGradient(pages, cumulative, totalDuration);
  assert.ok(grad.startsWith('linear-gradient(90deg, '));
  assert.ok(grad.endsWith('100.000%)'));
  // 校验包含 59 个边界分隔
  const boundaryCount = (grad.match(/calc\(/g) || []).length;
  assert.strictEqual(boundaryCount, (count - 1) * 2);
});

test('全剧时间线格式化与底栏时间统合测试', () => {
  const durations = [120, 180, 300]; // 2m + 3m + 5m = 10m (600s)
  const { cumulative, totalDuration } = utils.buildCumulative(durations);

  // P1 播放 30s -> 全剧 30s / 600s
  const p1Cur = (cumulative[0]) + 30;
  assert.strictEqual(`${utils.formatTime(p1Cur)} / ${utils.formatTime(totalDuration)}`, '0:30 / 10:00');

  // P2 播放 90s -> 全剧 210s / 600s
  const p2Cur = (cumulative[1]) + 90;
  assert.strictEqual(`${utils.formatTime(p2Cur)} / ${utils.formatTime(totalDuration)}`, '3:30 / 10:00');

  // P3 播放 150s -> 全剧 450s / 600s
  const p3Cur = (cumulative[2]) + 150;
  assert.strictEqual(`${utils.formatTime(p3Cur)} / ${utils.formatTime(totalDuration)}`, '7:30 / 10:00');

  // 跨小时时长格式化 (如 1h20m + 45m = 2h05m)
  const longDurations = [4800, 2700];
  const longResult = utils.buildCumulative(longDurations);
  assert.strictEqual(utils.formatTime(longResult.totalDuration), '2:05:00');
  assert.strictEqual(utils.formatTime(longResult.cumulative[1] + 125), '1:22:05');
});

test('跨分P精确跳转定位测试', () => {
  const durations = [100, 200, 300]; // 总长 600s
  const { cumulative, totalDuration } = utils.buildCumulative(durations);

  // 跨P跳转到 250s 处（属于 P2 的 150s）
  const info1 = utils.overallToPartOffset(cumulative, 250);
  assert.deepStrictEqual(info1, { index: 1, offset: 150 });

  // 跨P跳转到 300s 边界（属于 P3 的 0s）
  const info2 = utils.overallToPartOffset(cumulative, 300);
  assert.deepStrictEqual(info2, { index: 2, offset: 0 });

  // 跨P跳转到结尾前 0.01s
  const infoEnd = utils.overallToPartOffset(cumulative, totalDuration - 0.01);
  assert.strictEqual(infoEnd.index, 2);
  assert.strictEqual(Math.round(infoEnd.offset), 300);
});

test('formatTime 超长视频（100+ 小时）格式化', () => {
  assert.strictEqual(utils.formatTime(360000), '100:00:00');
  assert.strictEqual(utils.formatTime(363661), '101:01:01');
});

test('overallToPartOffset 边界与浮点容差测试', () => {
  const cumulative = [0, 50.5, 120.25, 300];
  // 起点 0
  assert.deepStrictEqual(utils.overallToPartOffset(cumulative, 0), { index: 0, offset: 0 });
  // 第一段内部浮点
  const p1 = utils.overallToPartOffset(cumulative, 25.25);
  assert.strictEqual(p1.index, 0);
  assert.strictEqual(p1.offset, 25.25);
  // 第二段起点
  const p2Start = utils.overallToPartOffset(cumulative, 50.5);
  assert.strictEqual(p2Start.index, 1);
  assert.strictEqual(p2Start.offset, 0);
  // 第三段末尾前
  const p3End = utils.overallToPartOffset(cumulative, 299.99);
  assert.strictEqual(p3End.index, 2);
  assert.strictEqual(Number((p3End.offset).toFixed(2)), 179.74);
  // 越界
  assert.strictEqual(utils.overallToPartOffset(cumulative, 300), null);
  assert.strictEqual(utils.overallToPartOffset(cumulative, 301), null);
  assert.strictEqual(utils.overallToPartOffset(cumulative, -0.1), null);
  assert.strictEqual(utils.overallToPartOffset(cumulative, NaN), null);
});

test('buildChapterGradient 差异化分P时长与微小分P着色比例', () => {
  const pages = [{ page: 1 }, { page: 2 }, { page: 3 }];
  // 5s + 3600s + 10s = 3615s
  const { cumulative, totalDuration } = utils.buildCumulative([5, 3600, 10]);
  const grad = utils.buildChapterGradient(pages, cumulative, totalDuration);
  assert.ok(grad.startsWith('linear-gradient(90deg, '));
  // P1 约 0.138%
  assert.ok(grad.includes('0.138%'));
  // P2 约 99.723%
  assert.ok(grad.includes('99.723%'));
  assert.ok(grad.includes('100.000%'));
});

test('rangeCovered 多区间重叠与断点覆盖', () => {
  const chunks = [
    { start: 0, end: 500 },
    { start: 501, end: 1000 },
  ];
  assert.strictEqual(utils.rangeCovered(chunks, 0, 500), true);
  assert.strictEqual(utils.rangeCovered(chunks, 501, 1000), true);
  // 单点覆盖
  assert.strictEqual(utils.rangeCovered(chunks, 250, 250), true);
  // 跨区间未合并 chunk
  assert.strictEqual(utils.rangeCovered(chunks, 400, 600), false);
  assert.strictEqual(utils.rangeCovered(chunks, 0, 1000), false);
});

test('formatTime 超长视频（1000+ 小时）格式化', () => {
  assert.strictEqual(utils.formatTime(3600000), '1000:00:00');
  assert.strictEqual(utils.formatTime(3600065), '1000:01:05');
});

test('buildChapterGradient 100P 超大合集分段着色测试', () => {
  const pages = [];
  const durations = [];
  for (let i = 1; i <= 100; i++) {
    pages.push({ page: i, part: `Episode ${i}` });
    durations.push(60);
  }
  const { cumulative, totalDuration } = utils.buildCumulative(durations);
  assert.strictEqual(totalDuration, 6000);
  const grad = utils.buildChapterGradient(pages, cumulative, totalDuration);
  assert.ok(grad.startsWith('linear-gradient(90deg, '));
  assert.ok(grad.includes('100.000%'));
  // 校验包含 99 个边界（198 个 calc 分隔）
  const boundaryCount = (grad.match(/calc\(/g) || []).length;
  assert.strictEqual(boundaryCount, 198);
});


