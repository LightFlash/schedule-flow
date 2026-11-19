import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MS_PER_MINUTE,
  addPeriod,
  clampMs,
  createId,
  formatClock,
  formatDuration,
  formatTimestamp,
  minutesToMs,
  msToMinutes,
  periodKeyOf,
  periodRange,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from './.build/time.mjs';

const local = (year, month, day, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(year, month, day, hour, minute, second, ms).getTime();

test('毫秒/分钟换算：正负、小数与 0', () => {
  assert.equal(MS_PER_MINUTE, 60000);
  assert.equal(minutesToMs(0), 0);
  assert.equal(minutesToMs(1), 60000);
  assert.equal(minutesToMs(1.5), 90000);
  assert.equal(minutesToMs(-2), -120000);
  assert.equal(msToMinutes(0), 0);
  assert.equal(msToMinutes(90000), 1.5);
  assert.equal(msToMinutes(minutesToMs(37)), 37);
});

test('clampMs：负数 / NaN / 无穷大均归零', () => {
  assert.equal(clampMs(0), 0);
  assert.equal(clampMs(1234), 1234);
  assert.equal(clampMs(-1), 0);
  assert.equal(clampMs(Number.NaN), 0);
  assert.equal(clampMs(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampMs(Number.NEGATIVE_INFINITY), 0);
});

test('formatClock：向上取整，不足 1 小时为 MM:SS，超过为 HH:MM:SS', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(1), '00:01');
  assert.equal(formatClock(1000), '00:01');
  assert.equal(formatClock(59999), '01:00');
  assert.equal(formatClock(60000), '01:00');
  assert.equal(formatClock(1500000), '25:00');
  assert.equal(formatClock(3600000), '01:00:00');
  assert.equal(formatClock(3661000), '01:01:01');
  assert.equal(formatClock(-5000), '00:00');
  assert.equal(formatClock(Number.NaN), '00:00');
});

test('formatDuration：秒 / 分钟 / 小时分钟三档，超过 1 分钟不显示秒', () => {
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(59000), '59秒');
  assert.equal(formatDuration(60000), '1分钟');
  assert.equal(formatDuration(61000), '1分钟');
  assert.equal(formatDuration(3599000), '59分钟');
  assert.equal(formatDuration(3600000), '1小时0分钟');
  assert.equal(formatDuration(3661000), '1小时1分钟');
  assert.equal(formatDuration(-1), '0秒');
});

test('formatTimestamp：无效时间戳显示占位符', () => {
  assert.equal(formatTimestamp(0), '—');
  assert.equal(formatTimestamp(Number.NaN), '—');
  assert.notEqual(formatTimestamp(local(2026, 10, 19)), '—');
});

test('startOfDay / startOfMonth / startOfYear：本地自然边界', () => {
  const t = local(2026, 10, 19, 14, 35, 20, 123);
  assert.equal(startOfDay(t), local(2026, 10, 19));
  assert.equal(startOfMonth(t), local(2026, 10, 1));
  assert.equal(startOfYear(t), local(2026, 0, 1));
  // 闰年在 2 月 29 日仍能正确回溯到 1 月 1 日
  assert.equal(startOfYear(local(2024, 1, 29, 23, 59)), local(2024, 0, 1));
});

test('startOfWeek：以周一 00:00 起（跨周日与跨年）', () => {
  assert.equal(startOfWeek(local(2026, 10, 19, 14, 0)), local(2026, 10, 16)); // 周四
  assert.equal(startOfWeek(local(2026, 10, 22, 23, 59)), local(2026, 10, 16)); // 周日
  assert.equal(startOfWeek(local(2026, 10, 23, 0, 0)), local(2026, 10, 23)); // 下周一
  assert.equal(startOfWeek(local(2027, 0, 1)), local(2026, 11, 28)); // 元旦属上一 ISO 周
});

test('addPeriod：日历运算，处理月末与闰年', () => {
  assert.equal(addPeriod(local(2026, 10, 19), 'day'), local(2026, 10, 20));
  assert.equal(addPeriod(local(2026, 10, 16), 'week'), local(2026, 10, 23));
  assert.equal(addPeriod(local(2026, 0, 1), 'month'), local(2026, 1, 1));
  assert.equal(addPeriod(local(2026, 11, 1), 'month'), local(2027, 0, 1));
  assert.equal(addPeriod(local(2024, 0, 1), 'year'), local(2025, 0, 1));
});

test('periodRange：四种粒度均为左闭右开 [start, end)', () => {
  const t = local(2026, 10, 19, 14, 30);
  const day = periodRange('day', t);
  assert.deepEqual(day, [local(2026, 10, 19), local(2026, 10, 20)]);
  assert.equal(day[1] - day[0], 86400000);

  const week = periodRange('week', t);
  assert.deepEqual(week, [local(2026, 10, 16), local(2026, 10, 23)]);

  assert.deepEqual(periodRange('month', t), [local(2026, 10, 1), local(2026, 11, 1)]);
  assert.deepEqual(periodRange('year', t), [local(2026, 0, 1), local(2027, 0, 1)]);
});

test('periodKeyOf：ISO 周 key 与跨年周归属', () => {
  assert.equal(periodKeyOf(local(2026, 10, 19, 12), 'day'), '2026-11-19');
  assert.equal(periodKeyOf(local(2026, 10, 19, 12), 'week'), '2026-W47');
  assert.equal(periodKeyOf(local(2026, 10, 19, 12), 'month'), '2026-11');
  assert.equal(periodKeyOf(local(2026, 10, 19, 12), 'year'), '2026');
  assert.equal(periodKeyOf(local(2026, 0, 1, 12), 'week'), '2026-W01');
  assert.equal(periodKeyOf(local(2027, 0, 1, 12), 'week'), '2026-W53');
  assert.equal(periodKeyOf(local(2024, 11, 30, 12), 'week'), '2025-W01');
  assert.equal(periodKeyOf(local(2026, 11, 31, 12), 'month'), '2026-12');
});

test('createId：批量生成不重复', () => {
  const ids = new Set(Array.from({ length: 200 }, () => createId()));
  assert.equal(ids.size, 200);
});
