import { createDefaultData } from '../.build/store.mjs';

export { createDefaultData };

/** Deterministic clock: engines call Date.now() directly, so patch it globally. */
export function installClock(initial) {
  const original = Date.now;
  let current = initial;
  Date.now = () => current;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (ms) => {
      current += ms;
    },
    restore: () => {
      Date.now = original;
    },
  };
}

export function makeTodo(overrides = {}) {
  return {
    id: 'todo-1',
    title: '工作项 A',
    notes: '',
    completed: false,
    createdAt: 0,
    completedAt: null,
    accumulatedMs: 0,
    lastTimingAt: null,
    timingStatus: 'idle',
    ...overrides,
  };
}

/** In-memory fake of StoreService's public surface (deep-clones like the real store). */
export function makeStore({ todos = [], settings, pomodoroRecords, pomodoroRuntime, workTimerRuntime, windows } = {}) {
  const data = createDefaultData();
  data.todos = structuredClone(todos);
  if (settings) data.settings = structuredClone(settings);
  if (pomodoroRecords) data.pomodoroRecords = structuredClone(pomodoroRecords);
  if (pomodoroRuntime) data.pomodoroRuntime = structuredClone(pomodoroRuntime);
  if (workTimerRuntime) data.workTimerRuntime = structuredClone(workTimerRuntime);
  if (windows) data.windows = structuredClone(windows);

  return {
    data,
    getAppData: () => structuredClone(data),
    getTodos: () => structuredClone(data.todos),
    getSettings: () => structuredClone(data.settings),
    addTodo(todo) {
      data.todos.push(structuredClone(todo));
      return structuredClone(todo);
    },
    updateTodo(id, patch) {
      const index = data.todos.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('工作项不存在或已被删除');
      data.todos[index] = { ...data.todos[index], ...patch, id };
      return structuredClone(data.todos[index]);
    },
    deleteTodo(id) {
      data.todos = data.todos.filter((item) => item.id !== id);
    },
    toggleTodo(id) {
      const todo = data.todos.find((item) => item.id === id);
      if (!todo) throw new Error('工作项不存在或已被删除');
      todo.completed = !todo.completed;
      todo.completedAt = todo.completed ? Date.now() : null;
      return structuredClone(todo);
    },
    saveSettings(next) {
      data.settings = structuredClone(next);
      return structuredClone(next);
    },
    addPomodoroRecord(record) {
      data.pomodoroRecords.push(structuredClone(record));
    },
    savePomodoroRuntime(runtime) {
      data.pomodoroRuntime = structuredClone(runtime);
    },
    saveWorkTimerRuntime(runtime) {
      data.workTimerRuntime = structuredClone(runtime);
    },
    getWindowState: () => structuredClone(data.windows),
    setMode(mode) {
      data.windows.mode = mode;
    },
    updateMiniWindow(key, patch) {
      data.windows.windows[key] = { ...data.windows.windows[key], ...patch };
    },
  };
}
