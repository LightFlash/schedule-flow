/**
 * 推送事件模板：默认文案、结构补全与占位符渲染。
 *
 * 纯函数模块，不依赖 Electron / React，主进程、渲染层与单元测试可同时引入：
 * - 默认文案与事件元信息集中在此，避免 store（主进程）与设置界面（渲染层）各写一份；
 * - `{var}` 占位符未知时原样保留，便于用户排查拼错的变量名；
 * - 已知变量但值为空时渲染为空串（不留下 `{time}` 之类的残渣）。
 */

import type { PushEventConfig, PushEventKey, PushEventVars } from './types';

/** 事件声明顺序即是设置界面的展示顺序，也是补全缺失字段时的遍历顺序。 */
export const PUSH_EVENT_KEYS: readonly PushEventKey[] = [
  'workStart',
  'workStop',
  'pomodoroWorkEnd',
  'pomodoroBreakEnd',
];

/** 设置界面的事件名（中文）。 */
export const PUSH_EVENT_LABELS: Record<PushEventKey, string> = {
  workStart: '工作开始',
  workStop: '工作结束',
  pomodoroWorkEnd: '番茄-工作轮结束',
  pomodoroBreakEnd: '番茄-休息结束',
};

/** 设置界面在事件下方的可用变量提示。 */
export const PUSH_EVENT_VARIABLE_HINTS: Record<PushEventKey, string> = {
  workStart: '可用变量：{task} {time}',
  workStop: '可用变量：{task} {session} {total} {time}',
  pomodoroWorkEnd: '可用变量：{round} {breakMinutes} {workMinutes}',
  pomodoroBreakEnd: '可用变量：{round} {breakMinutes} {workMinutes}',
};

/** 占位符语法：`{name}`，name 只允许字母/数字/下划线，避免误伤正文里的大括号。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 运行时收窄：外部数据（配置文件 / 导入备份）里的字符串是否合法事件 key。 */
export function isPushEventKey(value: unknown): value is PushEventKey {
  return (
    value === 'workStart' ||
    value === 'workStop' ||
    value === 'pomodoroWorkEnd' ||
    value === 'pomodoroBreakEnd'
  );
}

/**
 * 事件默认配置（每次调用返回全新对象，防止调用方互相污染）。
 * 默认开关：工作开始关闭（噪音最大），其余三个开启。
 */
export function createDefaultPushEvents(): Record<PushEventKey, PushEventConfig> {
  return {
    workStart: {
      enabled: false,
      title: '开始工作：{task}',
      body: '正在计时「{task}」\n本次开始于 {time}',
    },
    workStop: {
      enabled: true,
      title: '工作结束：{task}',
      body: '「{task}」本次用时 {session}，累计 {total}\n结束时间 {time}',
    },
    pomodoroWorkEnd: {
      enabled: true,
      title: '番茄钟：工作轮结束',
      body: '已完成第 {round} 个番茄，休息 {breakMinutes} 分钟。',
    },
    pomodoroBreakEnd: {
      enabled: true,
      title: '番茄钟：休息结束',
      body: '休息结束，准备开始新的工作轮。',
    },
  };
}

/**
 * 深合并补齐事件配置：逐字段校验，缺失/类型不符的字段取默认值，
 * **用户已填写的内容一律保留**（老配置没有 events 字段时整体落到默认模板）。
 */
export function normalizePushEvents(
  raw: unknown,
): Record<PushEventKey, PushEventConfig> {
  const defaults = createDefaultPushEvents();
  const source =
    typeof raw === 'object' && raw !== null
      ? (raw as Partial<Record<PushEventKey, Partial<PushEventConfig> | undefined>>)
      : {};
  const merged = {} as Record<PushEventKey, PushEventConfig>;
  for (const key of PUSH_EVENT_KEYS) {
    const fallback = defaults[key];
    const entry = source[key];
    merged[key] = {
      enabled: typeof entry?.enabled === 'boolean' ? entry.enabled : fallback.enabled,
      title: typeof entry?.title === 'string' ? entry.title : fallback.title,
      body: typeof entry?.body === 'string' ? entry.body : fallback.body,
    };
  }
  return merged;
}

/**
 * 渲染 `{var}` 占位符。
 * - 已知变量：字符串化后替换（null / undefined → 空串）；
 * - 未知变量：原样保留，方便用户在推送里发现自己拼错的变量名；
 * - 模板非字符串（异常数据）：返回空串，绝不抛错。
 */
export function renderPushTemplate(template: string, vars: PushEventVars = {}): string {
  if (typeof template !== 'string') return '';
  return template.replace(PLACEHOLDER_PATTERN, (match: string, name: string): string => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

/** 推送用的时刻文案：本地时区 `HH:mm`；非法时间戳退化为当前时间。 */
export function formatPushTime(timestamp: number = Date.now()): string {
  const safe = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  const date = new Date(safe);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
