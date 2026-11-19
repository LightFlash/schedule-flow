/**
 * 汇总服务：按天/周/月/年计算周期区间，按归档口径筛选 TODO 与番茄记录。
 * 周期边界统一来自 shared/time.ts，保证前后端口径一致。
 */

import { periodKeyOf, periodRange } from '@shared/time';
import type { Granularity, Summary, SummaryItem, Todo } from '@shared/types';
import type { StoreService } from '../store';

const NOTES_PREVIEW_LENGTH = 80;

export class SummaryService {
  constructor(private readonly store: StoreService) {}

  /** 构建当前周期汇总。区间左闭右开 [start, end)。 */
  buildSummary(granularity: Granularity): Summary {
    const [periodStart, periodEnd] = this.periodRange(granularity);
    let completedCount = 0;
    let totalWorkMs = 0;
    const items: SummaryItem[] = [];

    for (const todo of this.store.getTodos()) {
      const archivedAt = this.archiveTimeOf(todo);
      if (archivedAt === null || archivedAt < periodStart || archivedAt >= periodEnd) continue;

      if (todo.completed) completedCount += 1;
      totalWorkMs += todo.accumulatedMs;

      items.push({
        todoId: todo.id,
        title: todo.title,
        archivedAt,
        accumulatedMs: todo.accumulatedMs,
        completed: todo.completed,
        notesPreview: todo.notes.length > NOTES_PREVIEW_LENGTH
          ? `${todo.notes.slice(0, NOTES_PREVIEW_LENGTH)}…`
          : todo.notes,
      });
    }

    items.sort((left, right) => right.archivedAt - left.archivedAt);

    // 「完成番茄数」按 work 阶段完成记录统计，休息结束不计；最后一轮即使未走完休息段也计入。
    const completedPomodoroRounds = this.store
      .getAppData()
      .pomodoroRecords.filter(
        (record) => record.finishedAt >= periodStart && record.finishedAt < periodEnd,
      ).length;

    return {
      granularity,
      periodKey: periodKeyOf(periodStart, granularity),
      periodStart,
      periodEnd,
      completedCount,
      totalWorkMs,
      completedPomodoroRounds,
      items,
    };
  }

  /** 当前周期的 [start, end) 时间戳对。 */
  private periodRange(granularity: Granularity): [number, number] {
    return periodRange(granularity);
  }

  /**
   * 归档时间：完成项取完成时刻；未完成但有计时取最后计时时刻；
   * 已完成但缺少 completedAt 的历史数据回退到创建时间，避免被汇总遗漏。
   */
  private archiveTimeOf(todo: Todo): number | null {
    if (todo.completed) {
      return todo.completedAt ?? todo.lastTimingAt ?? todo.createdAt;
    }
    return todo.lastTimingAt;
  }
}
