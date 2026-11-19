import test from 'node:test';
import assert from 'node:assert/strict';
import { PushService } from './.build/pushService.mjs';
import { ReminderService } from './.build/reminderService.mjs';
import { IpcEvent } from './.build/ipcChannels.mjs';
import { createDefaultData } from './helpers/helpers.mjs';
import { FakeWindow } from './.build/electronStub.mjs';

const qa = globalThis.__qaElectron;
const payload = { phase: 'work', title: '第 1 轮工作结束', message: '休息一下' };

function settingsWith(push) {
  const defaults = createDefaultData();
  defaults.settings.push = push;
  return defaults.settings;
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => handler(...args);
  return () => {
    globalThis.fetch = original;
  };
}

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

test('未启用渠道 / 已启用但未填凭证：返回失败结果而不发请求', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return jsonResponse({ code: 0 });
  });
  try {
    const push = new PushService();
    assert.deepEqual(await push.sendPush(settingsWith({ channels: [], serverChanKey: '', pushPlusToken: '' }).push, 't', 'd'), []);
    const missing = await push.sendPush(
      settingsWith({ channels: ['serverchan', 'pushplus'], serverChanKey: '  ', pushPlusToken: '' }).push,
      't',
      'd',
    );
    assert.equal(missing.length, 2);
    assert.ok(missing.every((item) => item.ok === false));
    assert.match(missing[0].message, /未填写 SendKey/);
    assert.match(missing[1].message, /未填写 Token/);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('两渠道请求格式与成功码：Server酱 code=0 / PushPlus code=200', async () => {
  const requests = [];
  const restore = stubFetch(async (url, init) => {
    requests.push({ url, init });
    return url.includes('sctapi.ftqq.com') ? jsonResponse({ code: 0 }) : jsonResponse({ code: 200 });
  });
  try {
    const results = await new PushService().sendPush(
      settingsWith({
        channels: ['serverchan', 'pushplus'],
        serverChanKey: 'key/with space',
        pushPlusToken: 'token-123',
      }).push,
      '标题',
      '正文',
    );
    assert.deepEqual(results.map((item) => item.ok), [true, true]);
    assert.match(requests[0].url, /^https:\/\/sctapi\.ftqq\.com\/key%2Fwith%20space\.send$/);
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.match(requests[0].init.body, /title=%E6%A0%87%E9%A2%98/);
    assert.equal(requests[1].url, 'https://www.pushplus.plus/send');
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      token: 'token-123',
      title: '标题',
      content: '正文',
      template: 'markdown',
    });
  } finally {
    restore();
  }
});

test('渠道失败 / 网络异常 / 非 JSON 响应均被吞成失败结果', async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  let mode = 0;
  const restore = stubFetch(async () => {
    mode += 1;
    if (mode === 1) return jsonResponse({ code: 1, message: '配额不足' }, false);
    if (mode === 2) throw new Error('network down');
    return { ok: true, json: async () => { throw new Error('not json'); } };
  });
  try {
    const service = new PushService();
    const config = settingsWith({ channels: ['serverchan'], serverChanKey: 'k', pushPlusToken: '' }).push;
    const failed = await service.sendPush(config, 't', 'd');
    assert.equal(failed[0].ok, false);
    assert.match(failed[0].message, /配额不足/);

    const networkError = await service.sendPush(config, 't', 'd');
    assert.equal(networkError[0].ok, false);
    assert.match(networkError[0].message, /network down/);

    const badJson = await service.sendPush(config, 't', 'd');
    assert.equal(badJson[0].ok, false);
    assert.match(badJson[0].message, /not json/);
  } finally {
    restore();
    console.warn = originalWarn;
  }
});

test('未配置凭证：本地置顶/遮罩照常，推送服务不被调用并给出友好提示', async () => {
  qa.emitted.length = 0;
  qa.windows.length = 0;
  const win = new FakeWindow();
  qa.windows.push(win);

  let pushCalls = 0;
  const push = {
    sendPush: () => {
      pushCalls += 1;
      return Promise.resolve([]);
    },
  };
  const service = new ReminderService(push);
  const settings = settingsWith({ channels: [], serverChanKey: '', pushPlusToken: '' });
  await service.trigger(payload, settings);

  assert.equal(win.alwaysOnTop, true);
  assert.equal(win.flashing, true);
  const shown = qa.emitted.find((item) => item.event === IpcEvent.REMINDER_SHOW);
  assert.ok(shown, '必须发出 reminder:show');
  assert.match(shown.payload.message, /未配置推送凭证/);
  assert.equal(pushCalls, 0);

  service.confirm();
  assert.equal(win.alwaysOnTop, false);
  assert.equal(win.flashing, false);
  assert.ok(qa.emitted.some((item) => item.event === IpcEvent.REMINDER_HIDE));
  assert.equal(service.isActive(), false);
});

test('推送 Promise 拒绝时本地提醒不受影响，confirm 幂等', async () => {
  qa.emitted.length = 0;
  qa.windows.length = 0;
  const win = new FakeWindow();
  qa.windows.push(win);

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const push = {
      sendPush: () => Promise.reject(new Error('push exploded')),
    };
    const service = new ReminderService(push);
    const settings = settingsWith({ channels: ['serverchan'], serverChanKey: 'k', pushPlusToken: '' });
    await service.trigger(payload, settings);

    assert.equal(win.alwaysOnTop, true);
    assert.ok(qa.emitted.some((item) => item.event === IpcEvent.REMINDER_SHOW));
    const shown = qa.emitted.find((item) => item.event === IpcEvent.REMINDER_SHOW);
    assert.equal(shown.payload.message, payload.message, '已配置时不追加未配置提示');

    service.confirm();
    const hideCount = qa.emitted.filter((item) => item.event === IpcEvent.REMINDER_HIDE).length;
    service.confirm();
    assert.equal(qa.emitted.filter((item) => item.event === IpcEvent.REMINDER_HIDE).length, hideCount);
  } finally {
    console.warn = originalWarn;
  }
});
