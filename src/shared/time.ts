/**
 * 纯函数时间工具：毫秒换算、天/周/月/年周期边界与 key、时长格式化。
 * 所有周期均为本地时区、左闭右开区间 [start, end)，周以周一 00:00 起。
 * 不依赖 Electron / React，可在主进程与渲染层同时引入。
 */

import type { Granularity } from './types';

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** 分钟 → 毫秒。 */
export function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

/** 毫秒 → 分钟（可带小数）。 */
export function msToMinutes(ms: number): number {
  return ms / MS_PER_MINUTE;
}

/** 非法 / 负数时长一律归零，避免 UI 出现 NaN 或负数倒计时。 */
export function clampMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/**
 * 倒计时展示：MM:SS，超过 1 小时显示 HH:MM:SS。
 * 采用向上取整，保证起始时刻显示完整的 25:00，归零前最后一秒显示 00:01。
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(clampMs(ms) / MS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** 累计用时展示：不足 1 分钟显示秒；超过后分钟级——“X分钟”或“X小时Y分钟”，不再显示秒。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(clampMs(ms) / MS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${seconds}秒`;
}

/** 时间戳本地化展示，无效值显示占位符。 */
export function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

/** 计算指定时刻所在周期的开始时刻（本地时区）。 */
function startOf(timestamp: number, granularity: Granularity): Date {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  switch (granularity) {
    case 'day':
      break;
    case 'week': {
      // getDay(): 周日=0；转换成周一=0 的偏移后回溯到本周一。
      const mondayOffset = (date.getDay() + 6) % 7;
      date.setDate(date.getDate() - mondayOffset);
      break;
    }
    case 'month':
      date.setDate(1);
      break;
    case 'year':
      date.setMonth(0, 1);
      break;
  }
  return date;
}

export function startOfDay(timestamp: number): number {
  return startOf(timestamp, 'day').getTime();
}

export function startOfWeek(timestamp: number): number {
  return startOf(timestamp, 'week').getTime();
}

export function startOfMonth(timestamp: number): number {
  return startOf(timestamp, 'month').getTime();
}

export function startOfYear(timestamp: number): number {
  return startOf(timestamp, 'year').getTime();
}

/** 给定周期开始时刻，用日历运算求下一周期开始时刻（自动处理月末与 DST）。 */
export function addPeriod(startMs: number, granularity: Granularity): number {
  const date = new Date(startMs);
  switch (granularity) {
    case 'day':
      date.setDate(date.getDate() + 1);
      break;
    case 'week':
      date.setDate(date.getDate() + 7);
      break;
    case 'month':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'year':
      date.setFullYear(date.getFullYear() + 1);
      break;
  }
  return date.getTime();
}

/** 当前周期区间：[start, end)。 */
export function periodRange(granularity: Granularity, now: number = Date.now()): [number, number] {
  const start = startOf(now, granularity).getTime();
  return [start, addPeriod(start, granularity)];
}

/** ISO 8601 周：周所在年份 = 该周周四的年份；第 1 周含当年第一个周四。 */
function isoWeekInfo(timestamp: number): { year: number; week: number } {
  const date = new Date(timestamp);
  const mondayOffset = (date.getDay() + 6) % 7;
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() - mondayOffset + 3);
  const isoYear = thursday.getFullYear();

  const jan4 = new Date(isoYear, 0, 4);
  const jan4Offset = (jan4.getDay() + 6) % 7;
  const firstMonday = new Date(jan4);
  firstMonday.setDate(jan4.getDate() - jan4Offset);

  const week =
    Math.round((thursday.getTime() - firstMonday.getTime()) / (7 * 24 * MS_PER_HOUR)) + 1;
  return { year: isoYear, week };
}

/** 周期 key：'2026-11-19' / '2026-W47' / '2026-11' / '2026'。 */
export function periodKeyOf(timestamp: number, granularity: Granularity): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  switch (granularity) {
    case 'day':
      return `${year}-${month}-${day}`;
    case 'week': {
      const info = isoWeekInfo(timestamp);
      return `${info.year}-W${String(info.week).padStart(2, '0')}`;
    }
    case 'month':
      return `${year}-${month}`;
    case 'year':
      return String(year);
  }
}

/** 轻量 ID 生成（不引入额外依赖 / 源文件）。 */
export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
