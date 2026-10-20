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

test('overallFromPart 为 overallToPartOffset 的逆运算', () => {
  const { cumulative } = utils.buildCumulative([600, 900, 300]);
  // 电影内 1050s → P2 内 450s → 再换回 1050s
  const at = utils.overallToPartOffset(cumulative, 1050);
  assert.strictEqual(at.index, 1);
  assert.strictEqual(at.offset, 450);
  // part 为 1-based 分P号（= index + 1）
  assert.strictEqual(utils.overallFromPart(cumulative, at.index + 1, at.offset), 1050);
  // 每个分P起点都应回到该 P 的前缀和
  for (let i = 0; i < cumulative.length - 1; i++) {
    assert.strictEqual(utils.overallFromPart(cumulative, i + 1, 0), cumulative[i]);
  }
});

test('overallFromPart 边界与非法输入', () => {
  const cumulative = [0, 600, 1500, 1800];
  assert.strictEqual(utils.overallFromPart(cumulative, 1, 120), 120);
  // part 缺失/0 → 视为第 1 个 P
  assert.strictEqual(utils.overallFromPart(cumulative, undefined, 120), 120);
  assert.strictEqual(utils.overallFromPart(cumulative, 0, 120), 120);
  // time 缺失 → 只返回该 P 起始偏移
  assert.strictEqual(utils.overallFromPart(cumulative, 3), 1500);
  // 越界 part / cumulative 缺失 → 偏移按 0 处理，不抛错
  assert.strictEqual(utils.overallFromPart(cumulative, 99, 50), 50);
  assert.strictEqual(utils.overallFromPart(null, 2, 50), 50);
  assert.strictEqual(utils.overallFromPart([], 1, 50), 50);
  // 单P视频：overallTime 与 P 内时间等价（旧记录无 overallTime 时可用 time 兜底的依据）
  const single = utils.buildCumulative([1200]);
  assert.strictEqual(utils.overallFromPart(single.cumulative, 1, 700), 700);
});

test('观影记录总进度：必须用 overallTime 而非 P 内 time 除以电影总长', () => {
  // 3 个分P 600/900/300 秒（电影总长 1800s），停在第 2 个 P 的 450 秒处
  const { cumulative, totalDuration } = utils.buildCumulative([600, 900, 300]);
  const part = 2;
  const time = 450;
  const overall = utils.overallFromPart(cumulative, part, time);
  assert.strictEqual(overall, 1050);
  assert.strictEqual(Math.min(100, Math.round((overall / totalDuration) * 100)), 58);
  // 反例：直接拿 P 内时间除以电影总长 → 25%，正是修复前的错误口径
  assert.strictEqual(Math.round((time / totalDuration) * 100), 25);
  // 反例：除以不存在的 duration 字段 → 恒为 0（popup 进度条卡在 20% 兜底的成因）
  const histItem = { time, totalDuration };
  assert.strictEqual(histItem.duration && histItem.duration > 0 ? 1 : 0, 0);
});

test('isClickSuppressed：拖拽后 click 抑制窗口', () => {
  const stamp = 10000;
  // 窗口内应抑制
  assert.strictEqual(utils.isClickSuppressed(stamp, 10100), true);
  assert.strictEqual(utils.isClickSuppressed(stamp, 10499), true);
  // 右边界为严格小于：正好 500ms 不再抑制（否则慢一点的 click 会被误吞）
  assert.strictEqual(utils.isClickSuppressed(stamp, 10500), false);
  assert.strictEqual(utils.isClickSuppressed(stamp, 10501), false);
  assert.strictEqual(utils.isClickSuppressed(stamp, 99000), false);
  // 从未拖拽（stamp 为 0 / 空）不抑制
  assert.strictEqual(utils.isClickSuppressed(0, 10000), false);
  assert.strictEqual(utils.isClickSuppressed(undefined, 10000), false);
  assert.strictEqual(utils.isClickSuppressed(null, 10000), false);
  // 自定义窗口；缺省即 500
  assert.strictEqual(utils.isClickSuppressed(stamp, 10300, 200), false);
  assert.strictEqual(utils.isClickSuppressed(stamp, 10300, 400), true);
  assert.strictEqual(utils.isClickSuppressed(stamp, 10300, undefined), true);
  // 时钟回拨（now 早于 stamp）：沿用原内联式语义判为抑制，此行为已被测试固化
  assert.strictEqual(utils.isClickSuppressed(stamp, 9000), true);
});

test('formatDurationCN：累计观看时长的中文可读输出', () => {
  // 无数据/非法一律空串，由调用方隐藏整段文案（避免"累计观影 0 分钟"噪音）
  assert.strictEqual(utils.formatDurationCN(0), '');
  assert.strictEqual(utils.formatDurationCN(-10), '');
  assert.strictEqual(utils.formatDurationCN(undefined), '');
  assert.strictEqual(utils.formatDurationCN(NaN), '');
  assert.strictEqual(utils.formatDurationCN('abc'), '');
  // 不足 1 分钟归为"1 分钟内"，不给假精确的秒数
  assert.strictEqual(utils.formatDurationCN(30), '1 分钟内');
  assert.strictEqual(utils.formatDurationCN(59), '1 分钟内');
  assert.strictEqual(utils.formatDurationCN(60), '1 分钟');
  assert.strictEqual(utils.formatDurationCN(3599), '59 分钟');
  assert.strictEqual(utils.formatDurationCN(3600), '1 小时');      // 整点不带"0 分"
  assert.strictEqual(utils.formatDurationCN(4320), '1 小时 12 分');
  assert.strictEqual(utils.formatDurationCN('7325'), '2 小时 2 分'); // 字符串入参
});

test('sanitizeBookmarkList：条目消毒、去重与容量截断', () => {
  assert.deepStrictEqual(utils.sanitizeBookmarkList(null), []);
  assert.deepStrictEqual(utils.sanitizeBookmarkList('nope'), []);
  // 丢掉非对象与无 bvid 的脏条目
  assert.deepStrictEqual(utils.sanitizeBookmarkList([null, { title: 'x' }, 5, { bvid: 'BV1' }]), [{ bvid: 'BV1' }]);
  // 同 bvid 只保留先出现的那个
  const dedup = utils.sanitizeBookmarkList([{ bvid: 'BV1', n: 1 }, { bvid: 'BV1', n: 2 }, { bvid: 'BV2' }]);
  assert.strictEqual(dedup.length, 2);
  assert.strictEqual(dedup[0].n, 1);
  // 默认容量 50，超出丢尾部（约定最新在前）
  const many = Array.from({ length: 60 }, (_, i) => ({ bvid: 'BV' + i }));
  const capped = utils.sanitizeBookmarkList(many);
  assert.strictEqual(capped.length, 50);
  assert.strictEqual(capped[0].bvid, 'BV0');
  assert.strictEqual(capped[49].bvid, 'BV49');
  // 显式 cap 覆盖默认
  assert.strictEqual(utils.sanitizeBookmarkList(many, 3).length, 3);
});

test('toggleBookmarkEntry：新增在最新前、命中即移除、缺 bvid 不切换', () => {
  const t = (list, meta, cap) => utils.toggleBookmarkEntry(list, meta, cap, 123);
  // 新增
  const add = t([], { bvid: 'BV1', title: '片名', pic: 'p.jpg' });
  assert.strictEqual(add.bookmarked, true);
  assert.deepStrictEqual(add.list, [{ bvid: 'BV1', title: '片名', pic: 'p.jpg', ts: 123 }]);
  // 已有则移除
  const off = t([{ bvid: 'BV1' }, { bvid: 'BV2' }], { bvid: 'BV1' });
  assert.strictEqual(off.bookmarked, false);
  assert.deepStrictEqual(off.list, [{ bvid: 'BV2' }]);
  // 新条目插到最前（最新在前）
  const front = t([{ bvid: 'BV2' }], { bvid: 'BV1' });
  assert.strictEqual(front.list[0].bvid, 'BV1');
  // 缺 bvid 不切换，但列表仍被消毒
  const noBvid = t([{ bvid: 'BV1' }, null, 7], {}, undefined);
  assert.strictEqual(noBvid.bookmarked, false);
  assert.deepStrictEqual(noBvid.list, [{ bvid: 'BV1' }]);
  // 给了真实的分P号和电影时间才写入；缺了就保持旧书签的样子，不编进度
  const placed = t([], { bvid: 'BV1', title: '片名', part: 3, overallTime: 1050 });
  assert.strictEqual(placed.list[0].part, 3);
  assert.strictEqual(placed.list[0].overallTime, 1050);
  const bare = t([], { bvid: 'BV1', part: 0, overallTime: -1 });
  assert.strictEqual(bare.list[0].part, undefined);
  assert.strictEqual(bare.list[0].overallTime, undefined);
  const notANumber = t([], { bvid: 'BV1', part: 'P3', overallTime: 'later' });
  assert.strictEqual(notANumber.list[0].part, undefined);
  assert.strictEqual(notANumber.list[0].overallTime, undefined);
  // 去重 + 容量同时生效
  const dup = t([{ bvid: 'BV1' }, { bvid: 'BV1' }], { bvid: 'BV9' }, 2);
  assert.strictEqual(dup.bookmarked, true);
  assert.deepStrictEqual(dup.list.map((b) => b.bvid), ['BV9', 'BV1']);
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

// ========== 进度条重构新增测试：底栏时间 / 跨P定位 ==========

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

// ========== 新增：合集子合集模型（每个子合集 = 一部电影）基础函数 ==========

test('buildSeasonModel 多子合集：currentBvid 在第2个子合集', () => {
  const season = {
    id: 42,
    title: '测试合集',
    sections: [
      {
        id: 'sec-1',
        title: '第一章',
        episodes: [
          { bvid: 'BV1', cid: 1, aid: 10, title: 'ep1', duration: 100, id: 'p1' },
          { bvid: 'BV2', cid: 2, aid: 20, title: 'ep2', duration: 200, id: 'p2' },
        ],
      },
      {
        id: 'sec-2',
        title: '第二章',
        episodes: [
          { bvid: 'BV3', cid: 3, aid: 30, title: 'ep3', duration: 0, page: { duration: 300 }, id: 'p3' },
          { bvid: 'BV4', cid: 4, aid: 40, title: 'ep4', duration: 400, id: 'p4' },
        ],
      },
      {
        id: 'sec-3',
        title: '第三章',
        episodes: [{ bvid: 'BV5', cid: 5, aid: 50, title: 'ep5', duration: 500, id: 'p5' }],
      },
    ],
  };
  const model = utils.buildSeasonModel(season, 'BV4');
  assert.strictEqual(model.id, 42);
  assert.strictEqual(model.title, '测试合集');
  assert.strictEqual(model.sectionIndex, 1);
  assert.strictEqual(model.sections.length, 3);
  // 第1个子合集原样保留，index 为 section 内 0 起
  assert.deepStrictEqual(model.sections[0].episodes, [
    { index: 0, bvid: 'BV1', cid: 1, aid: 10, title: 'ep1', duration: 100, id: 'p1' },
    { index: 1, bvid: 'BV2', cid: 2, aid: 20, title: 'ep2', duration: 200, id: 'p2' },
  ]);
  // 第2个子合集为当前：episodes 即其集数列表，duration 兜底 page.duration
  assert.deepStrictEqual(model.episodes, [
    { index: 0, bvid: 'BV3', cid: 3, aid: 30, title: 'ep3', duration: 300, id: 'p3' },
    { index: 1, bvid: 'BV4', cid: 4, aid: 40, title: 'ep4', duration: 400, id: 'p4' },
  ]);
  assert.deepStrictEqual(model.sections[1], { id: 'sec-2', title: '第二章', index: 1, episodes: model.episodes });
  assert.strictEqual(model.sections[2].index, 2);
  assert.strictEqual(model.sections[2].episodes.length, 1);
});

test('buildSeasonModel currentBvid 未找到 → sectionIndex -1 / episodes []', () => {
  const season = {
    sections: [
      { id: 'a', title: 'A', episodes: [{ bvid: 'BV1', cid: 1, aid: 10, title: 'ep1', duration: 100, id: 'p1' }] },
      { id: 'b', title: 'B', episodes: [{ bvid: 'BV2', cid: 2, aid: 20, title: 'ep2', duration: 200, id: 'p2' }] },
    ],
  };
  const model = utils.buildSeasonModel(season, 'BV-不存在');
  assert.strictEqual(model.sectionIndex, -1);
  assert.deepStrictEqual(model.episodes, []);
  assert.strictEqual(model.sections.length, 2);
});

test('buildSeasonModel 丢弃 bvid 为空的 episode', () => {
  const season = {
    id: 7,
    title: '合集',
    sections: [
      {
        id: 'x',
        title: '子合集',
        episodes: [
          { bvid: 'BV1', cid: 1, aid: 10, title: 'keep', duration: 100, id: 'p1' },
          { cid: 2, aid: 20, title: 'drop-me', duration: 200, id: 'p2' }, // bvid 缺失
          { bvid: '', cid: 3, aid: 30, title: 'drop-me-too', duration: 300, id: 'p3' }, // bvid 空串
          { bvid: null, cid: 4, aid: 40, title: 'drop-me-three', duration: 400, id: 'p4' }, // bvid null
        ],
      },
    ],
  };
  const model = utils.buildSeasonModel(season, 'BV1');
  assert.strictEqual(model.sectionIndex, 0);
  // 丢弃后 section 内 index 重新从 0 计
  assert.deepStrictEqual(model.episodes, [{ index: 0, bvid: 'BV1', cid: 1, aid: 10, title: 'keep', duration: 100, id: 'p1' }]);
  assert.strictEqual(model.sections[0].episodes.length, 1);
});

test('buildSeasonModel 无效输入返回 null', () => {
  assert.strictEqual(utils.buildSeasonModel(null, 'BV1'), null);
  assert.strictEqual(utils.buildSeasonModel(undefined, 'BV1'), null);
  assert.strictEqual(utils.buildSeasonModel({}, 'BV1'), null);
  assert.strictEqual(utils.buildSeasonModel({ sections: [] }, 'BV1'), null);
  assert.strictEqual(utils.buildSeasonModel({ sections: null }, 'BV1'), null);
  assert.strictEqual(utils.buildSeasonModel({ sections: 'not-array' }, 'BV1'), null);
});

test('buildSeasonModel currentBvid 空串 → sectionIndex -1', () => {
  const season = {
    sections: [
      { id: 'a', title: 'A', episodes: [{ bvid: 'BV1', cid: 1, aid: 10, title: 'ep1', duration: 100, id: 'p1' }] },
    ],
  };
  const model = utils.buildSeasonModel(season, '');
  assert.strictEqual(model.sectionIndex, -1);
  assert.deepStrictEqual(model.episodes, []);
  // 子合集结构仍正常归一化
  assert.strictEqual(model.sections[0].index, 0);
});

test('buildSectionProgressKey id 优先', () => {
  assert.strictEqual(utils.buildSectionProgressKey(42, { id: 'abc', title: '标题', index: 3 }), 'season_42_sabc');
  // seasonId 为数字 0
  assert.strictEqual(utils.buildSectionProgressKey(0, { id: 'abc', title: '标题', index: 0 }), 'season_0_sabc');
});

test('buildSectionProgressKey id 缺失用 title', () => {
  assert.strictEqual(utils.buildSectionProgressKey(42, { id: '', title: '第二章', index: 1 }), 'season_42_s第二章');
  assert.strictEqual(utils.buildSectionProgressKey(42, { id: null, title: '第二章', index: 1 }), 'season_42_s第二章');
});

test('buildSectionProgressKey id 与 title 均缺失用 i<index>', () => {
  assert.strictEqual(utils.buildSectionProgressKey(42, { id: '', title: '', index: 2 }), 'season_42_si2');
});

test('bookmarkUrl：有分P才带 ?p=，旧书签与合集只开片头', () => {
  assert.strictEqual(utils.bookmarkUrl({ bvid: 'BV1', part: 3 }), 'https://www.bilibili.com/video/BV1?p=3');
  // 第 1 集不带参数，和「最近放映」的 historyUrl 同一口径
  assert.strictEqual(utils.bookmarkUrl({ bvid: 'BV1', part: 1 }), 'https://www.bilibili.com/video/BV1');
  // 旧书签没有 part：不编一个分P号
  assert.strictEqual(utils.bookmarkUrl({ bvid: 'BV1' }), 'https://www.bilibili.com/video/BV1');
  // 合集的集与集是不同 bvid，?p= 没有意义
  assert.strictEqual(
    utils.bookmarkUrl({ bvid: 'BV1', part: 4, mode: 'season' }),
    'https://www.bilibili.com/video/BV1'
  );
  assert.strictEqual(utils.bookmarkUrl(null), '');
  assert.strictEqual(utils.bookmarkUrl({}), '');
});

test('buildSectionProgressKey section 为空返回 _s?', () => {
  assert.strictEqual(utils.buildSectionProgressKey(42, null), 'season_42_s?');
  assert.strictEqual(utils.buildSectionProgressKey(42, undefined), 'season_42_s?');
  assert.strictEqual(utils.buildSectionProgressKey(42, 0), 'season_42_s?');
});

test('partDisplayLabel season：集号取 index+1，忽略 part.page', () => {
  // season 用下标 +1 作集号，即使 part.page 是别的值也不看
  assert.strictEqual(utils.partDisplayLabel('season', 0, { page: 9, part: '第一话' }), '第1集 · 第一话');
  assert.strictEqual(utils.partDisplayLabel('season', 4, { page: 99, part: 'X' }), '第5集 · X');
});

test('partDisplayLabel pages：用 part.page 作分P号', () => {
  assert.strictEqual(utils.partDisplayLabel('pages', 0, { page: 3, part: '正片' }), 'P3 · 正片');
  assert.strictEqual(utils.partDisplayLabel('pages', 2, { page: 7, part: '' }), 'P7');
});

test('partDisplayLabel 无名/纯空白：不带「 · 」后缀', () => {
  assert.strictEqual(utils.partDisplayLabel('season', 1, { page: 2 }), '第2集');
  assert.strictEqual(utils.partDisplayLabel('pages', 0, { page: 2, part: '' }), 'P2');
  assert.strictEqual(utils.partDisplayLabel('pages', 0, { page: 2, part: '   ' }), 'P2');
});

test('partDisplayLabel 名称两端空白被 trim', () => {
  assert.strictEqual(utils.partDisplayLabel('pages', 0, { page: 2, part: '  标题  ' }), 'P2 · 标题');
});

test('partDisplayLabel 空 part 返回空串（season/pages 一致）', () => {
  assert.strictEqual(utils.partDisplayLabel('pages', 0, null), '');
  assert.strictEqual(utils.partDisplayLabel('season', 0, undefined), '');
});


