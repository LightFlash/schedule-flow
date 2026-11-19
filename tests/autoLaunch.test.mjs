/** 开机自启动 IPC：OS 登录项是唯一数据源，开发态跳过实际写入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetElectronStub } from './.build/electronStub.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { makeStore } from './helpers/helpers.mjs';

const qa = globalThis.__qaElectron;

function register(store = makeStore()) {
  qa.handlers.clear();
  new IpcRegistry(store, {}, {}, {}, {}, {}).registerAll();
  return store;
}

function invoke(channel, payload) {
  return qa.handlers.get(channel)({}, payload);
}

test('autoLaunch:get 读取 OS 登录项真实状态', async () => {
  resetElectronStub();
  register();
  qa.loginItem.openAtLogin = true;
  assert.deepEqual(await invoke(IpcCommand.AUTO_LAUNCH_GET), {
    ok: true,
    data: { enabled: true },
  });
  qa.loginItem.openAtLogin = false;
  assert.deepEqual(await invoke(IpcCommand.AUTO_LAUNCH_GET), {
    ok: true,
    data: { enabled: false },
  });
});

test('开发模式：set 不写 OS 启动项，回显请求状态并附提示', async () => {
  resetElectronStub();
  const store = register();
  qa.isPackaged = false;
  const result = await invoke(IpcCommand.AUTO_LAUNCH_SET, { enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.enabled, true);
  assert.match(result.data.message, /开发模式/);
  assert.equal(qa.loginItem.openAtLogin, false, '开发态不得污染 electron.exe 启动项');
  assert.equal(Object.hasOwn(store.getSettings(), 'autoLaunch'), false, '自启状态不得写入 Settings');
});

test('打包模式：set 写入 OS 登录项并回读真实状态', async () => {
  resetElectronStub();
  const store = register();
  qa.isPackaged = true;
  const enabled = await invoke(IpcCommand.AUTO_LAUNCH_SET, { enabled: true });
  assert.deepEqual(enabled, { ok: true, data: { enabled: true } });
  assert.equal(qa.loginItem.openAtLogin, true);

  const disabled = await invoke(IpcCommand.AUTO_LAUNCH_SET, { enabled: false });
  assert.deepEqual(disabled, { ok: true, data: { enabled: false } });
  assert.equal(qa.loginItem.openAtLogin, false);
  assert.equal(Object.hasOwn(store.getSettings(), 'autoLaunch'), false, '自启状态不得写入 Settings');
});

test('autoLaunch:set 拒绝非法载荷且不改动 OS 状态', async () => {
  resetElectronStub();
  register();
  qa.isPackaged = true;
  const result = await invoke(IpcCommand.AUTO_LAUNCH_SET, {});
  assert.equal(result.ok, false);
  assert.match(result.message, /参数不完整/);
  assert.equal(qa.loginItem.openAtLogin, false);
});
