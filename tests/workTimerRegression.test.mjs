/**
 * QA 独立回归（不由实现者编写）：工作计时多开 v1.0.3。
 *
 * 只覆盖「工程师自测可能漏掉」的边界，全部走真实 StoreService / WorkTimerEngine / IpcRegistry：
 * a. 迁移幂等（同一份数据归一化两次结果一致，累计不重复增长）+ v1 脏数据净化
 * b. restore 时 paused 的 accumulatedBeforePauseMs 不被重复累加
 * c. 两个计时项先后 stop：各自累计互不污染（含时间差）
 * d. addTodo 在「2 个计时项 + 已完成项 / 计时区块被打散」时的插入位置
 * e. IPC WORK_STOP 带不存在 / 已完成 / 空载荷的行为（幂等不崩）
 * f. 勾选完成 2 个计时项中的 1 个：另一项不受影响，顺序仍为计时区块
 * 另外补：restore 的异常时间戳与镜像对齐、跨操作的不变式、moveTodoToTimerBlockTop 边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetElectronStub } from './.build/electronStub.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { normalizeWorkTimerRuntime } from './.build/workTimerRuntime.mjs';
import { installClock, makeTodo } from './helpers/helpers.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const qa = globalThis.__qaElectron;

/** 起一套真实 StoreService + 引擎 + IPC（种子数据经 electron-store stub 注入）。 */
function setup(todos = [], seed = {}) {
  resetElectronStub();
  qa.handlers.clear();
  globalThis.__qaStoreSeed = { todos, ...seed };
  try {
    const store = new StoreService();
    const engine = new WorkTimerEngine(store);
    new IpcRegistry(store, {}, engine, {}, {}, {}).registerAll();
    return { store, engine };
  } finally {
    delete globalThis.__qaStoreSeed;
  }
}

const invoke = (channel, payload) => qa.handlers.get(channel)({}, payload);
const ids = (store) => store.getTodos().map((todo) => todo.id);
const todoById = (store, id) => store.getTodos().find((todo) => todo.id === id);
const entryIds = (store) => store.getAppData().workTimerRuntime.timers.map((entry) => entry.todoId);

/** 不变式：`Todo.timingStatus !== 'idle'` ⟺ runtime 有同名且同状态的 entry。 */
function assertMirrorInvariant(store, label) {
  const runtime = store.getAppData().workTimerRuntime;
  const byId = new Map(runtime.timers.map((entry) => [entry.todoId, entry.status]));
  assert.equal(runtime.timers.length, byId.size, `${label}：runtime 不得有重复 todoId`);
  for (const todo of store.getTodos()) {
    const expected = byId.get(todo.id) ?? 'idle';
    assert.equal(todo.timingStatus, expected, `${label}：${todo.id} 的镜像状态与 runtime 不一致`);
  }
}

test('[a] 迁移幂等：v1 归一化两次结果一致，且经真实 store 二次启动不再变形', () => {
  const clock = installClock(T0);
  try {
    const legacy = {
      activeTimerId: 'A',
      status: 'running',
      startedAt: T0 - 10 * MIN,
      accumulatedBeforePauseMs: 5 * MIN,
      pauseStartedAt: null,
    };
    const once = normalizeWorkTimerRuntime(legacy);
    const twice = normalizeWorkTimerRuntime(once);
    assert.deepEqual(twice, once, '同一份数据归一化两次必须完全相同');
    assert.equal(once.timers.length, 1);
    assert.equal(once.timers[0].accumulatedBeforePauseMs, 5 * MIN, '累计原样保留，不重复增长');

    // 真实入口：seed v1 → ensureShape 迁移 → 用迁移结果再启动一次，结果必须稳定。
    const first = setup([makeTodo({ id: 'A' })], { workTimerRuntime: legacy }).store;
    const migrated = first.getAppData().workTimerRuntime;
    assert.equal(migrated.timers.length, 1);

    const second = setup([makeTodo({ id: 'A' })], { workTimerRuntime: migrated }).store;
    assert.deepEqual(second.getAppData().workTimerRuntime, migrated, '二次启动不得再次变形 / 累加');
  } finally {
    clock.restore();
  }
});

test('[a-补充] v1 脏数据净化：负累计归零、paused 清空 startedAt、非法状态视为空运行态', () => {
  const negative = normalizeWorkTimerRuntime({
    activeTimerId: ' A ', // 首尾空格应被 trim
    status: 'running',
    startedAt: T0,
    accumulatedBeforePauseMs: -9 * MIN,
    pauseStartedAt: 123,
  });
  assert.deepEqual(negative.timers, [
    { todoId: 'A', status: 'running', startedAt: T0, accumulatedBeforePauseMs: 0, pauseStartedAt: null },
  ]);

  const pausedWithStart = normalizeWorkTimerRuntime({
    activeTimerId: 'A',
    status: 'paused',
    startedAt: T0, // paused 不应有起点，净化时清空
    accumulatedBeforePauseMs: 3 * MIN,
    pauseStartedAt: T0 - MIN,
  });
  assert.deepEqual(pausedWithStart.timers, [
    {
      todoId: 'A',
      status: 'paused',
      startedAt: null,
      accumulatedBeforePauseMs: 3 * MIN,
      pauseStartedAt: T0 - MIN,
    },
  ]);

  for (const raw of [null, undefined, {}, { activeTimerId: 'A', status: 'idle' }, { activeTimerId: '', status: 'running' }]) {
    assert.deepEqual(normalizeWorkTimerRuntime(raw), { timers: [] }, '无有效计时 → 空运行态');
  }
});

test('[a-补充] v2 重复 todoId 只保留首次出现的条目（去重不变式）', () => {
  const runtime = normalizeWorkTimerRuntime({
    timers: [
      { todoId: 'A', status: 'running', startedAt: T0, accumulatedBeforePauseMs: 1 * MIN, pauseStartedAt: null },
      { todoId: 'A', status: 'paused', startedAt: null, accumulatedBeforePauseMs: 9 * MIN, pauseStartedAt: T0 },
      { todoId: 'B', status: 'paused', startedAt: null, accumulatedBeforePauseMs: 2 * MIN, pauseStartedAt: T0 },
    ],
  });
  assert.deepEqual(runtime.timers.map((entry) => entry.todoId), ['A', 'B']);
  assert.equal(runtime.timers[0].status, 'running', '首次出现的条目胜出');
});

test('[b] restore 幂等：paused 的 accumulatedBeforePauseMs 不会被重复累加', () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup([makeTodo({ id: 'A', timingStatus: 'paused' })], {
      workTimerRuntime: {
        timers: [
          {
            todoId: 'A',
            status: 'paused',
            startedAt: null,
            accumulatedBeforePauseMs: 7 * MIN,
            pauseStartedAt: T0 - 30 * MIN,
          },
        ],
      },
    });
    engine.restore(store.getAppData().workTimerRuntime);
    assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 7 * MIN);

    // 暂停期间反复 restore（含程序重启多次）都不得叠加。
    for (const label of ['第 2 次', '第 3 次']) {
      clock.advance(10 * MIN);
      engine.restore(store.getAppData().workTimerRuntime);
      assert.equal(
        store.getAppData().workTimerRuntime.timers[0].accumulatedBeforePauseMs,
        7 * MIN,
        `${label} restore 后累计不得增长`,
      );
      assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 7 * MIN);
    }
    assert.equal(
      store.getAppData().workTimerRuntime.timers[0].pauseStartedAt,
      T0 - 30 * MIN,
      '暂停时刻不被 restore 覆盖为当前时间',
    );

    // 继续后只从冻结值往下走，不出现「7 + 新增」以外的跳变。
    engine.resume('A');
    clock.advance(2 * MIN);
    assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 9 * MIN);
  } finally {
    clock.restore();
  }
});

test('[c] 两个计时项分别 stop：各自累计互不污染（含时间差）', () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup([makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })]);

    engine.start('A'); // T0
    clock.advance(1 * MIN);
    engine.start('B'); // T0+1
    clock.advance(2 * MIN);
    engine.stop('A'); // T0+3 → A 本次 3 分钟
    assert.equal(todoById(store, 'A').accumulatedMs, 3 * MIN);
    assert.equal(todoById(store, 'A').lastTimingAt, T0 + 3 * MIN);
    assert.deepEqual(entryIds(store), ['B'], '只移除 A 的 entry');
    assert.equal(todoById(store, 'B').accumulatedMs, 0, 'B 不得被 A 的结算污染');
    assert.equal(todoById(store, 'B').timingStatus, 'running');
    assert.equal(
      engine.getViewState().entries[0].sessionElapsedMs,
      2 * MIN,
      'B 的会话用时按自己的起点推进（T0+1 → T0+3）',
    );

    clock.advance(3 * MIN);
    engine.stop('B'); // T0+6 → B 本次 5 分钟
    assert.equal(todoById(store, 'B').accumulatedMs, 5 * MIN, 'B 只结算自己的 5 分钟');
    assert.equal(todoById(store, 'B').lastTimingAt, T0 + 6 * MIN);
    assert.equal(todoById(store, 'A').accumulatedMs, 3 * MIN, 'A 的累计不被 B 的结算改动');
    assert.equal(todoById(store, 'A').lastTimingAt, T0 + 3 * MIN, 'A 的结算时刻不被覆盖');
    assert.deepEqual(store.getAppData().workTimerRuntime, { timers: [] });
    assert.equal(engine.getViewState().totalSessionElapsedMs, 0);
  } finally {
    clock.restore();
  }
});

test('[d] addTodo 在「2 个计时项 + 已完成项」时插到最后一个计时项之后', () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup([
      makeTodo({ id: 'A', title: '任务一' }),
      makeTodo({ id: 'B', title: '已完成项', completed: true, completedAt: T0 }),
      makeTodo({ id: 'C', title: '任务三' }),
      makeTodo({ id: 'D', title: '任务四' }),
    ]);
    engine.start('C');
    engine.start('A');
    assert.deepEqual(ids(store), ['A', 'C', 'B', 'D'], '前置：A、C 依次置顶');

    const created = store.addTodo('新任务');
    assert.deepEqual(ids(store), ['A', 'C', created.id, 'B', 'D'], '插到最后一个计时项之后，不插进计时区块');
    assert.equal(todoById(store, created.id).timingStatus, 'idle');
  } finally {
    clock.restore();
  }
});

test('[d-补充] addTodo 边界：无计时项 / 计时区块被拖拽打散', () => {
  const clock = installClock(T0);
  try {
    // 无计时项：插到最顶。
    const plain = setup([makeTodo({ id: 'A' }), makeTodo({ id: 'B' })]).store;
    const top = plain.addTodo('新任务');
    assert.deepEqual(ids(plain), [top.id, 'A', 'B']);

    // 计时区块被打散（A、C 计时，B 空档）：插到「最后一个」计时项之后，不插进空档。
    const gap = setup([
      makeTodo({ id: 'A', timingStatus: 'running' }),
      makeTodo({ id: 'B' }),
      makeTodo({ id: 'C', timingStatus: 'paused' }),
      makeTodo({ id: 'D' }),
    ]).store;
    const inserted = gap.addTodo('新任务');
    assert.deepEqual(ids(gap), ['A', 'B', 'C', inserted.id, 'D']);
  } finally {
    clock.restore();
  }
});

test('[e] IPC WORK_STOP 幂等：不存在 / 已完成 / 空载荷都不崩', async () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup([
      makeTodo({ id: 'A' }),
      makeTodo({ id: 'B', completed: true, completedAt: T0 }),
    ]);
    engine.start('A');

    // 不存在的 todoId：幂等 ok，且不影响任何运行态 / 数据。
    const before = store.getTodos();
    const missing = await invoke(IpcCommand.WORK_STOP, { todoId: '不存在' });
    assert.equal(missing.ok, true);
    assert.deepEqual(store.getTodos(), before, '不存在 id 的 stop 不得改动任何数据');
    assert.deepEqual(entryIds(store), ['A']);

    // 已完成但没在计时的 todoId：幂等 ok，不产生副作用。
    const completed = await invoke(IpcCommand.WORK_STOP, { todoId: 'B' });
    assert.equal(completed.ok, true);
    assert.equal(todoById(store, 'B').accumulatedMs, 0);
    assert.equal(todoById(store, 'B').completed, true);

    // 非法载荷：空串 / 缺字段 / undefined 一律拒绝，且不动数据。
    for (const payload of [{ todoId: '' }, {}, undefined]) {
      const result = await invoke(IpcCommand.WORK_STOP, payload);
      assert.equal(result.ok, false, `载荷 ${JSON.stringify(payload)} 应拒绝`);
      assert.match(result.message, /参数不完整/);
    }
    assert.deepEqual(entryIds(store), ['A'], '被拒绝的请求不得停止真正的计时');

    // 运行态与镜像仍一致，A 仍能正常结算。
    assertMirrorInvariant(store, 'stop 幂等序列');
    clock.advance(4 * MIN);
    assert.equal((await invoke(IpcCommand.WORK_STOP, { todoId: 'A' })).ok, true);
    assert.equal(todoById(store, 'A').accumulatedMs, 4 * MIN);
  } finally {
    clock.restore();
  }
});

test('[f] 勾选完成 2 个计时项中的 1 个：另一项不受影响，顺序仍为计时区块', async () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup([
      makeTodo({ id: 'A' }),
      makeTodo({ id: 'B', title: '工作项 B' }),
      makeTodo({ id: 'C', title: '空闲项' }),
    ]);
    engine.start('A');
    clock.advance(1 * MIN);
    engine.start('B');
    clock.advance(2 * MIN);
    assert.deepEqual(ids(store), ['B', 'A', 'C'], '前置：后开始的 B 置顶');

    const toggled = await invoke(IpcCommand.TODO_TOGGLE, { id: 'B' });
    assert.equal(toggled.ok, true);
    assert.equal(toggled.data.completed, true);
    assert.equal(todoById(store, 'B').accumulatedMs, 2 * MIN, 'B 的 2 分钟被结算');
    assert.deepEqual(entryIds(store), ['A'], '只剩 A 的计时');
    assert.equal(todoById(store, 'A').timingStatus, 'running');
    assert.equal(todoById(store, 'A').accumulatedMs, 0, 'A 不得被结算');
    assert.deepEqual(ids(store), ['A', 'C', 'B'], 'A 仍在计时区块顶部，完成的 B 沉底');
    assert.equal(
      engine.getViewState().entries[0].sessionElapsedMs,
      3 * MIN,
      'A 的计时连续（T0 → T0+3），不被勾选动作打断',
    );

    // 计时区块保持完整：新任务插在 A 之后、C 之前。
    const created = store.addTodo('新任务');
    assert.deepEqual(ids(store), ['A', created.id, 'C', 'B']);
    assertMirrorInvariant(store, '勾选完成 1/2 计时项');
  } finally {
    clock.restore();
  }
});

test('restore：未来时间戳收敛为 now、缺起点的 running 只丢该条、镜像全量对齐', () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup(
      [
        makeTodo({ id: 'A', timingStatus: 'running' }),
        makeTodo({ id: 'B', timingStatus: 'idle' }),
        makeTodo({ id: 'C', timingStatus: 'running' }), // 镜像撒谎：实际无 entry
        makeTodo({ id: 'D', timingStatus: 'paused' }),
        makeTodo({ id: 'E', completed: true, completedAt: T0, timingStatus: 'idle' }),
      ],
      {
        workTimerRuntime: {
          timers: [
            // 未来时间戳：只收敛为 now，不追认为负时长，也不清空已计时间。
            { todoId: 'A', status: 'running', startedAt: T0 + 60 * MIN, accumulatedBeforePauseMs: 3 * MIN, pauseStartedAt: null },
            // running 缺起点：只丢该条。
            { todoId: 'B', status: 'running', startedAt: null, accumulatedBeforePauseMs: 9 * MIN, pauseStartedAt: null },
            // paused 缺 pauseStartedAt：补 now。
            { todoId: 'D', status: 'paused', startedAt: null, accumulatedBeforePauseMs: 2 * MIN, pauseStartedAt: null },
            // 已完成的悬空条目：丢弃，不得让已完成项复活计时。
            { todoId: 'E', status: 'running', startedAt: T0 - MIN, accumulatedBeforePauseMs: MIN, pauseStartedAt: null },
          ],
        },
      },
    );

    engine.restore(store.getAppData().workTimerRuntime);

    assert.deepEqual(entryIds(store), ['A', 'D'], '只保留合法且未完成的条目');
    const runtime = store.getAppData().workTimerRuntime.timers;
    assert.equal(runtime[0].startedAt, T0, '未来时间戳收敛为 now');
    assert.equal(runtime[1].pauseStartedAt, T0, '缺 pauseStartedAt 时补 now');
    assert.equal(runtime[1].startedAt, null, 'paused 不得带起点');

    const view = engine.getViewState();
    assert.deepEqual(view.entries.map((entry) => [entry.todoId, entry.sessionElapsedMs]), [
      ['A', 3 * MIN],
      ['D', 2 * MIN],
    ]);
    assert.equal(view.totalSessionElapsedMs, 5 * MIN);

    const statuses = Object.fromEntries(store.getTodos().map((todo) => [todo.id, todo.timingStatus]));
    assert.deepEqual(statuses, { A: 'running', B: 'idle', C: 'idle', D: 'paused', E: 'idle' }, '镜像全量对齐');
    assert.equal(todoById(store, 'E').accumulatedMs, 0, '已完成项不得被结算');
  } finally {
    clock.restore();
  }
});

test('不变式：连续 start/pause/resume/stop/stopAll/toggle/delete 后镜像与 runtime 始终一致', async () => {
  const clock = installClock(T0);
  try {
    const { store, engine } = setup([
      makeTodo({ id: 'A' }),
      makeTodo({ id: 'B' }),
      makeTodo({ id: 'C' }),
    ]);
    const steps = [
      ['start A', () => engine.start('A')],
      ['start B', () => engine.start('B')],
      ['start C', () => engine.start('C')],
      ['pause A', () => engine.pause('A')],
      ['resume A', () => engine.resume('A')],
      ['stop B', () => engine.stop('B')],
      ['stopAll', () => engine.stopAll()],
      ['start A again', () => engine.start('A')],
      ['toggle A', () => invoke(IpcCommand.TODO_TOGGLE, { id: 'A' })],
      ['start C', () => engine.start('C')],
      ['delete C', () => invoke(IpcCommand.TODO_DELETE, { id: 'C' })],
    ];
    for (const [label, step] of steps) {
      clock.advance(MIN);
      await step();
      assertMirrorInvariant(store, label);
    }
    assert.deepEqual(store.getAppData().workTimerRuntime, { timers: [] }, '收尾后不留运行态');
  } finally {
    clock.restore();
  }
});

test('moveTodoToTimerBlockTop 边界（真实 store）：已在顶部 / 全部已完成 / 无其它计时项 / 未知 id', () => {
  const clock = installClock(T0);
  try {
    // 已在正确位置：不改动顺序。
    const top = setup([makeTodo({ id: 'P', timingStatus: 'running' }), makeTodo({ id: 'Q' })]).store;
    top.moveTodoToTimerBlockTop('P');
    assert.deepEqual(ids(top), ['P', 'Q']);

    // 清单全是已完成项 + 一个计时项：仍移到最顶（不得因 completed 判断错位）。
    const completed = setup([
      makeTodo({ id: 'X', completed: true, completedAt: T0 }),
      makeTodo({ id: 'Y', completed: true, completedAt: T0 }),
    ]).store;
    completed.updateTodo('Y', { timingStatus: 'running' });
    completed.moveTodoToTimerBlockTop('Y');
    assert.deepEqual(ids(completed), ['Y', 'X']);

    // 没有其它计时项：直接移到 0。
    const solo = setup([makeTodo({ id: 'A' }), makeTodo({ id: 'B' }), makeTodo({ id: 'C' })]).store;
    solo.updateTodo('C', { timingStatus: 'running' });
    solo.moveTodoToTimerBlockTop('C');
    assert.deepEqual(ids(solo), ['C', 'A', 'B']);

    // 未知 id：静默忽略，不崩、不改序。
    const unknown = setup([makeTodo({ id: 'A' })]).store;
    unknown.moveTodoToTimerBlockTop('不存在');
    assert.deepEqual(ids(unknown), ['A']);
  } finally {
    clock.restore();
  }
});

test('autoMarkComplete 开启时勾选意图不被 stop 的自动完成翻转（另一项计时不受影响）', async () => {
  const clock = installClock(T0);
  try {
    const settings = { ...createDefaultData().settings, autoMarkComplete: true };
    const { store, engine } = setup([makeTodo({ id: 'A' }), makeTodo({ id: 'B' })], { settings });
    engine.start('A');
    clock.advance(1 * MIN);
    engine.start('B');
    clock.advance(2 * MIN);

    const result = await invoke(IpcCommand.TODO_TOGGLE, { id: 'A' });
    assert.equal(result.ok, true);
    assert.equal(todoById(store, 'A').completed, true, '用户勾选=完成，不得被 stop 的自动完成再翻回去');
    assert.equal(todoById(store, 'A').timingStatus, 'idle');
    assert.equal(todoById(store, 'A').accumulatedMs, 3 * MIN);
    assert.notEqual(todoById(store, 'A').completedAt, null, 'completedAt 必须落库');
    assert.deepEqual(entryIds(store), ['B'], '只停被勾选的那一项');
    assert.equal(todoById(store, 'B').completed, false, '另一项不得被连带完成');
    assert.equal(todoById(store, 'B').timingStatus, 'running');
    assertMirrorInvariant(store, 'autoMarkComplete 勾选');
  } finally {
    clock.restore();
  }
});

test('默认数据结构：workTimerRuntime 为 { timers: [] }，不再有 activeTimerId', () => {
  const data = createDefaultData();
  assert.deepEqual(data.workTimerRuntime, { timers: [] });
  assert.equal('activeTimerId' in data.workTimerRuntime, false);
  assert.equal(data.version, 1, 'AppData.version 维持 1（v2 判定只看结构）');
  assert.equal(data.windows.layoutVersion, 3, 'LAYOUT_VERSION 维持 3，不因计时改版重置窗口布局');
});
