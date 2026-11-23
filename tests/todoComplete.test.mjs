/**
 * TODO 勾选语义回归：
 * 勾选完成时自动结算并停止该项计时（其它并发计时不受影响）；完成任务自动沉底；
 * 顺序可上下调整；新增任务插到全部计时项之下；autoMarkComplete 下勾选意图不被翻转。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetElectronStub } from './.build/electronStub.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { makeTodo } from './helpers/helpers.mjs';

const qa = globalThis.__qaElectron;

function setup(todos, settings) {
  resetElectronStub();
  qa.handlers.clear();
  const seeded = createDefaultData();
  seeded.todos = todos;
  const seed = { todos: seeded.todos };
  if (settings) seed.settings = settings;
  globalThis.__qaStoreSeed = seed;
  try {
    const store = new StoreService();
    const workTimer = new WorkTimerEngine(store);
    new IpcRegistry(store, {}, workTimer, {}, {}, {}).registerAll();
    return { store, workTimer };
  } finally {
    delete globalThis.__qaStoreSeed;
  }
}

const invoke = (channel, payload) => qa.handlers.get(channel)({}, payload);
const ids = (store) => store.getTodos().map((todo) => todo.id);
const todoById = (store, id) => store.getTodos().find((todo) => todo.id === id);

test('勾选正在计时的任务：自动结算停止并沉底；取消勾选不触发计时', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '第一个' }),
    makeTodo({ id: 'B', title: '第二个' }),
    makeTodo({ id: 'C', title: '计时项' }),
  ]);
  assert.equal(workTimer.start('C').ok, true);
  assert.equal(workTimer.getViewState().entries.length, 1);
  assert.equal(workTimer.getViewState().entries[0].status, 'running');
  assert.deepEqual(ids(store), ['C', 'A', 'B'], '新开的 C 置顶');

  const result = await invoke(IpcCommand.TODO_TOGGLE, { id: 'C' });
  assert.equal(result.ok, true);
  assert.equal(result.data.completed, true, '勾选后任务应为完成态');
  assert.equal(workTimer.getViewState().entries.length, 0, '勾选完成必须同时结束该项计时');
  assert.equal(result.data.timingStatus, 'idle');
  assert.equal(store.getTodos().at(-1)?.id, 'C', '完成的任务自动沉底到末尾');

  // 取消勾选：不应触发任何计时
  await invoke(IpcCommand.TODO_TOGGLE, { id: 'C' });
  assert.equal(todoById(store, 'C').completed, false);
  assert.equal(workTimer.getViewState().entries.length, 0);
});

test('勾选未计时的任务：正常完成并沉底', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '计时项' }),
    makeTodo({ id: 'B', title: '普通项' }),
  ]);
  assert.equal(workTimer.start('A').ok, true);

  await invoke(IpcCommand.TODO_TOGGLE, { id: 'B' });
  assert.equal(todoById(store, 'B').completed, true);
  assert.deepEqual(ids(store), ['A', 'B'], 'B 已在末尾则顺序不变');
  assert.equal(workTimer.getViewState().entries[0].todoId, 'A', '勾选 B 不影响 A 的计时');

  await invoke(IpcCommand.TODO_TOGGLE, { id: 'A' });
  assert.equal(workTimer.getViewState().entries.length, 0, '计时中的 A 被勾选后计时停止');
  assert.deepEqual(ids(store), ['B', 'A'], 'A 完成后沉底');
});

test('勾选完成只停该项：并发计时中其它项继续跑', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '第一个' }),
    makeTodo({ id: 'B', title: '第二个' }),
    makeTodo({ id: 'C', title: '第三个' }),
  ]);
  assert.equal(workTimer.start('A').ok, true);
  assert.equal(workTimer.start('B').ok, true);
  assert.equal(workTimer.getViewState().entries.length, 2);

  await invoke(IpcCommand.TODO_TOGGLE, { id: 'A' });
  const entries = workTimer.getViewState().entries;
  assert.deepEqual(entries.map((entry) => entry.todoId), ['B'], '只保留 B 的计时');
  assert.equal(entries[0].status, 'running');
  assert.equal(todoById(store, 'B').timingStatus, 'running');
  assert.equal(todoById(store, 'A').completed, true);
  assert.equal(store.getTodos().at(-1)?.id, 'A', '完成的 A 沉底');
});

test('moveTodo 上下移交换相邻位置，越界忽略、非法载荷拒绝', async () => {
  const { store } = setup([
    makeTodo({ id: 'A' }),
    makeTodo({ id: 'B' }),
    makeTodo({ id: 'C' }),
  ]);

  await invoke(IpcCommand.TODO_MOVE, { id: 'B', offset: -1 });
  assert.deepEqual(ids(store), ['B', 'A', 'C']);

  await invoke(IpcCommand.TODO_MOVE, { id: 'B', offset: -1 });
  assert.deepEqual(ids(store), ['B', 'A', 'C'], '已在最上时上移被忽略');

  await invoke(IpcCommand.TODO_MOVE, { id: 'B', offset: 1 });
  assert.deepEqual(ids(store), ['A', 'B', 'C']);

  await invoke(IpcCommand.TODO_MOVE, { id: 'C', offset: -1 });
  assert.deepEqual(ids(store), ['A', 'C', 'B']);

  const bad = await invoke(IpcCommand.TODO_MOVE, { id: 'A', offset: 2 });
  assert.equal(bad.ok, false, 'offset 必须是 -1 或 1');
});

test('reorderTodos：子集重排保持未列入项位置；未知 id / 空数组拒绝', async () => {
  const { store } = setup([
    makeTodo({ id: 'A' }),
    makeTodo({ id: 'B' }),
    makeTodo({ id: 'C' }),
  ]);

  await invoke(IpcCommand.TODO_REORDER, { ids: ['C', 'A', 'B'] });
  assert.deepEqual(ids(store), ['C', 'A', 'B']);

  // 子集语义：只重排提交的项在原槽位上的相对位置，未列入的 B 保持原位置。
  await invoke(IpcCommand.TODO_REORDER, { ids: ['A', 'C'] });
  assert.deepEqual(ids(store), ['A', 'C', 'B']);

  const unknown = await invoke(IpcCommand.TODO_REORDER, { ids: ['C', 'A', 'X'] });
  assert.equal(unknown.ok, false, '未知 id 必须拒绝');
  assert.deepEqual(ids(store), ['A', 'C', 'B'], '拒绝后顺序不变');

  const empty = await invoke(IpcCommand.TODO_REORDER, { ids: [] });
  assert.equal(empty.ok, false, '空数组拒绝');
});

test('开始计时自动置顶；取消完成归位到未完成区末尾', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '第一个' }),
    makeTodo({ id: 'B', title: '已完成项', completed: true, completedAt: Date.now() }),
    makeTodo({ id: 'C', title: '第三个' }),
  ]);

  // 开始计时：A 自动置顶（本来就在顶部，顺序不变），计时不受影响
  assert.equal(workTimer.start('A').ok, true);
  assert.deepEqual(ids(store), ['A', 'B', 'C']);
  assert.equal(workTimer.getViewState().entries[0].status, 'running');

  // 取消 B 的完成：归位到未完成区的末尾（C 之前）——A 的计时不受影响
  await invoke(IpcCommand.TODO_TOGGLE, { id: 'B' });
  assert.deepEqual(ids(store), ['A', 'C', 'B'], '取消完成插入未完成区末尾');
  assert.equal(todoById(store, 'B').completed, false);
  assert.equal(workTimer.getViewState().entries[0].todoId, 'A', '其它项的计时不被干扰');

  // 再勾选 B 完成：沉底
  await invoke(IpcCommand.TODO_TOGGLE, { id: 'B' });
  assert.deepEqual(ids(store), ['A', 'C', 'B']);
});

test('新增任务插入到计时中任务之下；无计时任务时放最顶', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '旧任务一' }),
    makeTodo({ id: 'B', title: '旧任务二' }),
    makeTodo({ id: 'C', title: '已完成', completed: true, completedAt: Date.now() }),
  ]);

  // 无计时任务：新任务放最顶
  await invoke(IpcCommand.TODO_ADD, { title: '新任务一' });
  const afterFirst = store.getTodos().map((t) => t.title);
  assert.equal(afterFirst[0], '新任务一', '无计时任务时新任务置顶');

  // 开始计时 A：A 置顶
  assert.equal(workTimer.start('A').ok, true);
  await invoke(IpcCommand.TODO_ADD, { title: '新任务二' });
  const afterSecond = store.getTodos().map((t) => t.title);
  assert.equal(afterSecond[0], '旧任务一', '计时中的任务保持最顶');
  assert.equal(afterSecond[1], '新任务二', '新任务插到计时任务之下');
});

test('新增任务插到全部计时项之后（两个并发计时项）', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '任务一' }),
    makeTodo({ id: 'B', title: '任务二' }),
    makeTodo({ id: 'C', title: '任务三' }),
  ]);

  assert.equal(workTimer.start('A').ok, true);
  assert.equal(workTimer.start('C').ok, true);
  assert.deepEqual(ids(store), ['C', 'A', 'B'], '后开始的 C 置顶，其余相对顺序不变');

  await invoke(IpcCommand.TODO_ADD, { title: '新任务' });
  assert.deepEqual(
    store.getTodos().map((t) => t.title),
    ['任务三', '任务一', '新任务', '任务二'],
    '新任务插到最后一个计时项之下（计时区块保持完整）',
  );
});

test('autoMarkComplete 开启时勾选意图不被翻转（stop 前置快照）', async () => {
  const settings = { ...createDefaultData().settings, autoMarkComplete: true };
  const { store, workTimer } = setup(
    [makeTodo({ id: 'A', title: '计时项' }), makeTodo({ id: 'B', title: '普通项' })],
    settings,
  );
  assert.equal(workTimer.start('A').ok, true);

  // stop() 内部会把 A 置为完成，勾选若在 stop 之后取反就会把它翻回未完成 —— 必须保持完成。
  const result = await invoke(IpcCommand.TODO_TOGGLE, { id: 'A' });
  assert.equal(result.ok, true);
  assert.equal(result.data.completed, true, '用户点击勾选 = 意图完成，不能被翻转');
  assert.equal(todoById(store, 'A').completed, true);
  assert.notEqual(todoById(store, 'A').completedAt, null);
  assert.equal(workTimer.getViewState().entries.length, 0, '勾选完成同时结束计时');
  assert.equal(store.getTodos().at(-1)?.id, 'A', '完成后沉底');

  // 再次勾选（取消完成）：意图为未完成，不会被"自动完成"拽回完成态。
  const undone = await invoke(IpcCommand.TODO_TOGGLE, { id: 'A' });
  assert.equal(undone.ok, true);
  assert.equal(undone.data.completed, false);
  assert.equal(todoById(store, 'A').completedAt, null);
  assert.equal(workTimer.getViewState().entries.length, 0);
});
