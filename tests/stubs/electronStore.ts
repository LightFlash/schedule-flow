/** QA-only minimal electron-store stub (atomic-write behavior is not under test). */
const globalRef = globalThis as unknown as { __qaStoreSeed?: Record<string, unknown> };

export default class Store<T extends Record<string, unknown>> {
  store: T;

  constructor(options: { defaults: T }) {
    const base = JSON.parse(JSON.stringify(options.defaults)) as Record<string, unknown>;
    // 测试可预置「上次退出残留」的持久化数据（例如 mode='mini'），
    // 在构造时覆盖默认值，用于验证启动固定 standard。
    const seed = globalRef.__qaStoreSeed;
    if (seed && typeof seed === 'object') {
      for (const [key, value] of Object.entries(seed)) {
        base[key] = value;
      }
    }
    this.store = base as T;
  }

  get(key: string): unknown {
    return this.store[key];
  }

  set(key: string, value: unknown): void {
    this.store[key] = value;
  }
}
