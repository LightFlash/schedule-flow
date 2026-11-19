/**
 * 微信推送封装：Server酱（Turbo）与 PushPlus。
 * 使用 Node 22 内置 fetch（无 axios）；每个渠道独立吞掉异常，任何失败都不阻断本地强提醒。
 * 端点集中在此处常量区，便于平台调整时一处修改。
 */

import type { PushChannel, PushConfig, PushResult } from '@shared/types';

const SERVERCHAN_ENDPOINT = (sendKey: string): string =>
  `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
const PUSHPLUS_ENDPOINT = 'https://www.pushplus.plus/send';
const REQUEST_TIMEOUT_MS = 8000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用 AbortController 实现超时，避免依赖运行时 AbortSignal.timeout 的类型声明。 */
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function channelResult(channel: PushChannel, ok: boolean, message: string): PushResult {
  return { channel, ok, message };
}

export class PushService {
  /** 按配置向所有启用且填有凭证的渠道推送；返回每个渠道的结果。 */
  async sendPush(config: PushConfig, title: string, desp: string): Promise<PushResult[]> {
    const results: PushResult[] = [];

    if (config.channels.includes('serverchan')) {
      const key = config.serverChanKey.trim();
      results.push(
        key.length > 0
          ? await this.sendServerChan(key, title, desp)
          : channelResult('serverchan', false, '未填写 SendKey，已跳过'),
      );
    }

    if (config.channels.includes('pushplus')) {
      const token = config.pushPlusToken.trim();
      results.push(
        token.length > 0
          ? await this.sendPushPlus(token, title, desp)
          : channelResult('pushplus', false, '未填写 Token，已跳过'),
      );
    }

    return results;
  }

  /** 设置页「测试推送」入口。 */
  async sendTest(config: PushConfig): Promise<PushResult[]> {
    return this.sendPush(
      config,
      'Schedule Flow 测试推送',
      '如果你收到这条消息，说明推送配置已生效。',
    );
  }

  private async sendServerChan(key: string, title: string, desp: string): Promise<PushResult> {
    try {
      const body = new URLSearchParams({ title, desp }).toString();
      const response = await fetchWithTimeout(SERVERCHAN_ENDPOINT(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const payload = (await response.json()) as {
        code?: number;
        message?: string;
        msg?: string;
      };
      const ok = response.ok && payload.code === 0;
      return channelResult(
        'serverchan',
        ok,
        ok ? 'Server酱推送成功' : `Server酱推送失败：${payload.message ?? payload.msg ?? '未知错误'}`,
      );
    } catch (error) {
      // 网络异常 / 超时 / 响应非 JSON：吞掉异常，仅记录为失败结果。
      return channelResult('serverchan', false, `Server酱推送异常：${describeError(error)}`);
    }
  }

  private async sendPushPlus(token: string, title: string, desp: string): Promise<PushResult> {
    try {
      const response = await fetchWithTimeout(PUSHPLUS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, title, content: desp, template: 'markdown' }),
      });
      const payload = (await response.json()) as { code?: number; msg?: string; message?: string };
      const ok = response.ok && payload.code === 200;
      return channelResult(
        'pushplus',
        ok,
        ok ? 'PushPlus推送成功' : `PushPlus推送失败：${payload.msg ?? payload.message ?? '未知错误'}`,
      );
    } catch (error) {
      return channelResult('pushplus', false, `PushPlus推送异常：${describeError(error)}`);
    }
  }
}
