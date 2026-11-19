import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryService } from './.build/summaryService.mjs';
import { installClock, makeStore, makeTodo } from './helpers/helpers.mjs';

const local = (year, month, day, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(year, month, day, hour, minute, second, ms).getTime();
const DAY = 86400000;
const record = (id, finishedAt, round = 1) => ({ id, finishedAt, round, workDurationMs: 1500000 });

test('日汇总：左闭右开边界、归档优先级、番茄计数与备注截断', () => {
  const start = local(2026, 10, 19);
  const clock = installClock(start + 14 * 3600000);
  const longNotes = 'x'.repeat(100);
  const store = makeStore({
    todos: [
      makeTodo({ id: 'in-start', completed: true, completedAt: start, accumulatedMs: 60000, notes: '短备注' }),
      makeTodo({ id: 'out-before', completed: true, completedAt: start - 1, accumulatedMs: 999999 }),
      makeTodo({ id: 'in-end', completed: false, lastTimingAt: start + DAY - 1, accumulatedMs: 120000, notes: longNotes }),
      makeTodo({ id: 'out-end', completed: false, lastTimingAt: start + DAY, accumulatedMs: 888888 }),
      makeTodo({ id: 'no-archive', completed: false, lastTimingAt: null, accumulatedMs: 777777 }),
      makeTodo({
        id: 'fallback',
        completed: true,
        completedAt: null,
        lastTimingAt: null,
        createdAt: start + 1000,
        accumulatedMs: 30000,
      }),
    ],
    pomodoroRecords: [record('r1', start), record('r2', start + DAY - 1), record('r3', start + DAY)],
  });

  try {
    const summary = new SummaryService(store).buildSummary('day');
    assert.equal(summary.granularity, 'day');
    assert.equal(summary.periodStart, start);
    assert.equal(summary.periodEnd, start + DAY);
    assert.equal(summary.periodKey, '2026-11-19');
    assert.equal(summary.completedCount, 2);
    assert.equal(summary.totalWorkMs, 60000 + 120000 + 30000);
    assert.equal(summary.completedPomodoroRounds, 2);
    assert.deepEqual(
      summary.items.map((item) => item.todoId),
      ['in-end', 'fallback', 'in-start'],
      '按归档时间倒序',
    );
    assert.equal(summary.items[0].notesPreview, `${'x'.repeat(80)}…`);
    assert.equal(summary.items[2].notesPreview, '短备注');
    assert.equal(summary.items[1].archivedAt, start + 1000, '缺 completedAt 时回退到 createdAt');
  } finally {
    clock.restore();
  }
});

test('归档时间优先取 completedAt，而非较新的 lastTimingAt', () => {
  const start = local(2026, 10, 19);
  const clock = installClock(start + 10 * 3600000);
  const store = makeStore({
    todos: [
      makeTodo({
        id: 'completed-yesterday',
        completed: true,
        completedAt: start - DAY,
        lastTimingAt: start + 1000,
        accumulatedMs: 1000,
      }),
    ],
  });
  try {
    const summary = new SummaryService(store).buildSummary('day');
    assert.equal(summary.items.length, 0, '完成项按昨天归档，不应出现在今天的汇总');
  } finally {
    clock.restore();
  }
});

test('周汇总：周一起算，周日仍在本周，下周一排除', () => {
  const weekStart = local(2026, 10, 16); // 周一
  const clock = installClock(local(2026, 10, 22, 23, 59)); // 周日
  const store = makeStore({
    todos: [
      makeTodo({ id: 'monday', completed: true, completedAt: weekStart, accumulatedMs: 1000 }),
      makeTodo({ id: 'before', completed: true, completedAt: weekStart - 1, accumulatedMs: 2000 }),
      makeTodo({ id: 'sunday', completed: true, completedAt: weekStart + 6 * DAY + 86399000, accumulatedMs: 3000 }),
      makeTodo({ id: 'next-monday', completed: true, completedAt: weekStart + 7 * DAY, accumulatedMs: 4000 }),
    ],
  });
  try {
    const summary = new SummaryService(store).buildSummary('week');
    assert.equal(summary.periodStart, weekStart);
    assert.equal(summary.periodEnd, weekStart + 7 * DAY);
    assert.equal(summary.periodKey, '2026-W47');
    assert.equal(summary.completedCount, 2);
    assert.equal(summary.totalWorkMs, 4000);
  } finally {
    clock.restore();
  }
});

test('月汇总：自然月边界与闰年 2 月 29 日', () => {
  const clock = installClock(local(2024, 1, 29, 12));
  const store = makeStore({
    todos: [
      makeTodo({ id: 'feb1', completed: true, completedAt: local(2024, 1, 1) }),
      makeTodo({ id: 'jan31', completed: true, completedAt: local(2024, 0, 31, 23, 59, 59, 999) }),
      makeTodo({ id: 'feb29', completed: true, completedAt: local(2024, 1, 29, 23, 59) }),
      makeTodo({ id: 'mar1', completed: true, completedAt: local(2024, 2, 1) }),
    ],
  });
  try {
    const summary = new SummaryService(store).buildSummary('month');
    assert.equal(summary.periodStart, local(2024, 1, 1));
    assert.equal(summary.periodEnd, local(2024, 2, 1));
    assert.equal(summary.periodKey, '2024-02');
    assert.deepEqual(
      summary.items.map((item) => item.todoId).sort(),
      ['feb1', 'feb29'],
    );
  } finally {
    clock.restore();
  }
});

test('年汇总：自然年边界，跨年不串期', () => {
  const clock = installClock(local(2026, 5, 1));
  const store = makeStore({
    todos: [
      makeTodo({ id: 'jan1', completed: true, completedAt: local(2026, 0, 1) }),
      makeTodo({ id: 'prev-year', completed: true, completedAt: local(2025, 11, 31, 23, 59, 59, 999) }),
      makeTodo({ id: 'dec31', completed: true, completedAt: local(2026, 11, 31, 23, 59) }),
      makeTodo({ id: 'next-year', completed: true, completedAt: local(2027, 0, 1) }),
    ],
    pomodoroRecords: [
      record('r-prev', local(2025, 11, 31, 23, 59, 59, 999)),
      record('r-now', local(2026, 0, 1)),
    ],
  });
  try {
    const summary = new SummaryService(store).buildSummary('year');
    assert.equal(summary.periodStart, local(2026, 0, 1));
    assert.equal(summary.periodEnd, local(2027, 0, 1));
    assert.equal(summary.periodKey, '2026');
    assert.equal(summary.completedCount, 2);
    assert.equal(summary.completedPomodoroRounds, 1);
  } finally {
    clock.restore();
  }
});

test('空数据 / 0 时长：返回全零汇总而不抛错', () => {
  const clock = installClock(local(2026, 10, 19));
  try {
    const summary = new SummaryService(makeStore()).buildSummary('day');
    assert.equal(summary.completedCount, 0);
    assert.equal(summary.totalWorkMs, 0);
    assert.equal(summary.completedPomodoroRounds, 0);
    assert.deepEqual(summary.items, []);
  } finally {
    clock.restore();
  }
});
