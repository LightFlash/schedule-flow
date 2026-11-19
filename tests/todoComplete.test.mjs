/**
 * TODO 勾选语义回归：
 * 勾选完成时自动结算并停止计时；完成任务自动沉底；顺序可上下调整。
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

function setup(todos) {
  resetElectronStub();
  qa.handlers.clear();
  const seeded = createDefaultData();
  seeded.todos = todos;
  globalThis.__qaStoreSeed = { todos: seeded.todos };
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

test('勾选正在计时的任务：自动结算停止并沉底；取消勾选不触发计时', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '第一个' }),
    makeTodo({ id: 'B', title: '第二个' }),
    makeTodo({ id: 'C', title: '计时项' }),
  ]);
  assert.equal(workTimer.start('C').ok, true);
  assert.equal(workTimer.getViewState().status, 'running');

  const result = await invoke(IpcCommand.TODO_TOGGLE, { id: 'C' });
  assert.equal(result.ok, true);
  assert.equal(result.data.completed, true, '勾选后任务应为完成态');
  assert.equal(workTimer.getViewState().status, 'idle', '勾选完成必须同时结束计时');
  assert.equal(result.data.timingStatus, 'idle');
  assert.equal(store.getTodos().at(-1)?.id, 'C', '完成的任务自动沉底到末尾');

  // 取消勾选：不应触发任何计时
  await invoke(IpcCommand.TODO_TOGGLE, { id: 'C' });
  assert.equal(store.getTodos().find((t) => t.id === 'C').completed, false);
  assert.equal(workTimer.getViewState().status, 'idle');
});

test('勾选未计时的任务：正常完成并沉底', async () => {
  const { store, workTimer } = setup([
    makeTodo({ id: 'A', title: '计时项' }),
    makeTodo({ id: 'B', title: '普通项' }),
  ]);
  assert.equal(workTimer.start('A').ok, true);

  await invoke(IpcCommand.TODO_TOGGLE, { id: 'B' });
  assert.equal(store.getTodos().find((t) => t.id === 'B').completed, true);
  assert.deepEqual(store.getTodos().map((t) => t.id), ['A', 'B'], 'B 已在末尾则顺序不变');

  await invoke(IpcCommand.TODO_TOGGLE, { id: 'A' });
  assert.equal(workTimer.getViewState().status, 'idle', '计时中的 A 被勾选后计时停止');
  assert.deepEqual(store.getTodos().map((t) => t.id), ['B', 'A'], 'A 完成后沉底');
});

test('moveTodo 上下移交换相邻位置，越界忽略、非法载荷拒绝', async () => {
  const { store } = setup([
    makeTodo({ id: 'A' }),
    makeTodo({ id: 'B' }),
    makeTodo({ id: 'C' }),
  ]);

  await invoke(IpcCommand.TODO_MOVE, { id: 'B', offset: -1 });
  assert.deepEqual(store.getTodos().map((t) => t.id), ['B', 'A', 'C']);

  await invoke(IpcCommand.TODO_MOVE, { id: 'B', offset: -1 });
  assert.deepEqual(store.getTodos().map((t) => t.id), ['B', 'A', 'C'], '已在最上时上移被忽略');

  await invoke(IpcCommand.TODO_MOVE, { id: 'B', offset: 1 });
  assert.deepEqual(store.getTodos().map((t) => t.id), ['A', 'B', 'C']);

  await invoke(IpcCommand.TODO_MOVE, { id: 'C', offset: -1 });
  assert.deepEqual(store.getTodos().map((t) => t.id), ['A', 'C', 'B']);

  const bad = await invoke(IpcCommand.TODO_MOVE, { id: 'A', offset: 2 });
  assert.equal(bad.ok, false, 'offset 必须是 -1 或 1');
});

test('reorderTodos 按完整 id 顺序重排；集合不一致被拒绝', async () => {
  const { store } = setup([
    makeTodo({ id: 'A' }),
    makeTodo({ id: 'B' }),
    makeTodo({ id: 'C' }),
  ]);

  await invoke(IpcCommand.TODO_REORDER, { ids: ['C', 'A', 'B'] });
  assert.deepEqual(store.getTodos().map((t) => t.id), ['C', 'A', 'B']);

  const mismatch = await invoke(IpcCommand.TODO_REORDER, { ids: ['C', 'A'] });
  assert.equal(mismatch.ok, false, '数量不一致必须拒绝');

  const unknown = await invoke(IpcCommand.TODO_REORDER, { ids: ['C', 'A', 'X'] });
  assert.equal(unknown.ok, false, '未知 id 必须拒绝');
  assert.deepEqual(store.getTodos().map((t) => t.id), ['C', 'A', 'B'], '拒绝后顺序不变');

  const empty = await invoke(IpcCommand.TODO_REORDER, { ids: [] });
  assert.equal(empty.ok, false, '空数组拒绝');
});
