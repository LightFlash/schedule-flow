/**
 * 设置弹窗：推送渠道与凭证（密码态）、测试推送、事件推送（按事件开关 + 自定义文案）、
 * 番茄默认参数、自动标记完成、开机自启动。
 * 渠道支持同时勾选多个（决策2：两渠道可同时配置同时推送）。
 * 事件文案只写草稿，随「保存」一次性落盘；关闭应取消则丢弃。
 * 开机自启动独立于 Settings 快照，直接读写 OS 登录项（唯一数据源在主进程）。
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { PushChannel, PushEventConfig, PushEventKey, PushResult, Settings } from '@shared/types';
import {
  PUSH_EVENT_KEYS,
  PUSH_EVENT_LABELS,
  PUSH_EVENT_VARIABLE_HINTS,
  createDefaultPushEvents,
} from '@shared/pushTemplate';
import { bridge } from '../api/bridge';
import { useAppStore } from '../store/useAppStore';

function cloneSettings(settings: Settings): Settings {
  return JSON.parse(JSON.stringify(settings)) as Settings;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps): ReactElement {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const showToast = useAppStore((state) => state.showToast);

  const [draft, setDraft] = useState<Settings>(() => cloneSettings(settings));
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<PushResult[] | null>(null);
  const [testError, setTestError] = useState('');
  // 开机自启不入 Settings draft：OS 登录项才是唯一真相。
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoLaunchNote, setAutoLaunchNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(cloneSettings(settings));
    setTestResults(null);
    setTestError('');
    setAutoLaunch(false);
    setAutoLaunchNote('');
    let active = true;
    void bridge
      .getAutoLaunch()
      .then((state) => {
        if (!active) return;
        setAutoLaunch(state.enabled);
        setAutoLaunchNote(state.message ?? '');
      })
      .catch(() => {
        // 读取失败不能阻断设置弹窗：按关闭展示，用户仍可正常修改其它设置。
        if (!active) return;
        setAutoLaunch(false);
        setAutoLaunchNote('读取开机自启动状态失败，当前按关闭显示');
      });
    return () => {
      active = false;
    };
  }, [open, settings]);

  const toggleChannel = (channel: PushChannel): void => {
    const channels = draft.push.channels.includes(channel)
      ? draft.push.channels.filter((item) => item !== channel)
      : [...draft.push.channels, channel];
    setDraft({ ...draft, push: { ...draft.push, channels } });
  };

  /** 事件推送草稿：老数据缺 events 时按默认模板补全，保证受控输入永远有值。 */
  const pushEvents = draft.push.events ?? createDefaultPushEvents();

  /** 只改草稿，随「保存」一起落盘；关闭弹窗即丢弃。 */
  const updateEvent = (key: PushEventKey, patch: Partial<PushEventConfig>): void => {
    const events = draft.push.events ?? createDefaultPushEvents();
    setDraft({
      ...draft,
      push: {
        ...draft.push,
        events: { ...events, [key]: { ...events[key], ...patch } },
      },
    });
  };

  const commitNumber = (field: 'workMinutes' | 'breakMinutes' | 'rounds', value: string): void => {
    const limits: Record<typeof field, [number, number]> = {
      workMinutes: [1, 240],
      breakMinutes: [1, 120],
      rounds: [1, 20],
    };
    const numeric = Number(value);
    const [min, max] = limits[field];
    const safe = Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : settings.pomodoro[field];
    setDraft({ ...draft, pomodoro: { ...draft.pomodoro, [field]: safe } });
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResults(null);
    setTestError('');
    try {
      const results = await bridge.testPush(draft);
      setTestResults(results);
    } catch (error) {
      setTestError(describeError(error));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = (): void => {
    void (async () => {
      try {
        const state = await bridge.setAutoLaunch(autoLaunch);
        setAutoLaunch(state.enabled);
      } catch (error) {
        // 自启写入失败不阻断其它设置的保存，但要明确告知用户。
        showToast(`开机自启动设置失败：${describeError(error)}`, 'error');
      }
      await saveSettings(draft);
      onClose();
    })();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>设置</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6" sx={{ mb: 1 }}>
              微信推送
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              可同时启用两个渠道；未填写凭证时仅本地强提醒。
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={draft.push.channels.includes('serverchan')}
                  onChange={() => toggleChannel('serverchan')}
                />
              }
              label="Server酱（Turbo）"
            />
            <TextField
              label="SendKey"
              type="password"
              fullWidth
              value={draft.push.serverChanKey}
              onChange={(event) =>
                setDraft({ ...draft, push: { ...draft.push, serverChanKey: event.target.value } })
              }
              sx={{ mb: 1.5 }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={draft.push.channels.includes('pushplus')}
                  onChange={() => toggleChannel('pushplus')}
                />
              }
              label="PushPlus"
            />
            <TextField
              label="Token"
              type="password"
              fullWidth
              value={draft.push.pushPlusToken}
              onChange={(event) =>
                setDraft({ ...draft, push: { ...draft.push, pushPlusToken: event.target.value } })
              }
              sx={{ mb: 1.5 }}
            />
            <Button variant="outlined" onClick={() => void handleTest()} disabled={testing}>
              {testing ? '正在测试…' : '测试推送'}
            </Button>
            {testError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {testError}
              </Alert>
            )}
            {testResults && (
              <Box sx={{ mt: 1.5 }}>
                {testResults.length === 0 && (
                  <Alert severity="warning">尚未勾选推送渠道。</Alert>
                )}
                {testResults.map((result) => (
                  <Alert key={result.channel} severity={result.ok ? 'success' : 'warning'} sx={{ mb: 0.75 }}>
                    {result.channel === 'serverchan' ? 'Server酱' : 'PushPlus'}：{result.message}
                  </Alert>
                ))}
              </Box>
            )}

            <Divider sx={{ my: 2 }} />

            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              事件推送
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              每类事件可单独开关并自定义文案；花括号是占位变量，未识别的变量会原样保留。
            </Typography>
            <Stack spacing={1.5}>
              {PUSH_EVENT_KEYS.map((eventKey) => {
                const entry = pushEvents[eventKey] ?? createDefaultPushEvents()[eventKey];
                return (
                  <Box
                    key={eventKey}
                    sx={{
                      p: 1.5,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                    }}
                  >
                    <FormControlLabel
                      sx={{ mb: 0.5 }}
                      control={
                        <Checkbox
                          size="small"
                          checked={entry.enabled}
                          onChange={(event) =>
                            updateEvent(eventKey, { enabled: event.target.checked })
                          }
                        />
                      }
                      label={PUSH_EVENT_LABELS[eventKey]}
                    />
                    <TextField
                      label="标题"
                      size="small"
                      fullWidth
                      value={entry.title}
                      onChange={(event) => updateEvent(eventKey, { title: event.target.value })}
                      sx={{ mb: 1 }}
                    />
                    <TextField
                      label="内容"
                      size="small"
                      fullWidth
                      multiline
                      minRows={2}
                      value={entry.body}
                      onChange={(event) => updateEvent(eventKey, { body: event.target.value })}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.75 }}
                    >
                      {PUSH_EVENT_VARIABLE_HINTS[eventKey]}
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          </Box>

          <Divider />

          <Box>
            <Typography variant="h6" sx={{ mb: 1 }}>
              番茄钟默认参数
            </Typography>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                label="工作（分钟）"
                type="number"
                value={draft.pomodoro.workMinutes}
                onChange={(event) => commitNumber('workMinutes', event.target.value)}
                fullWidth
              />
              <TextField
                label="休息（分钟）"
                type="number"
                value={draft.pomodoro.breakMinutes}
                onChange={(event) => commitNumber('breakMinutes', event.target.value)}
                fullWidth
              />
              <TextField
                label="轮次数"
                type="number"
                value={draft.pomodoro.rounds}
                onChange={(event) => commitNumber('rounds', event.target.value)}
                fullWidth
              />
            </Box>
            <FormControlLabel
              sx={{ mt: 1.5 }}
              control={
                <Checkbox
                  checked={draft.autoMarkComplete}
                  onChange={(event) => setDraft({ ...draft, autoMarkComplete: event.target.checked })}
                />
              }
              label="停止计时后自动标记工作项完成（默认关闭）"
            />
          </Box>

          <Divider />

          <Box>
            <Typography variant="h6" sx={{ mb: 1 }}>
              启动方式
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={autoLaunch}
                  onChange={(event) => setAutoLaunch(event.target.checked)}
                />
              }
              label="开机自启动（登录系统后自动运行）"
            />
            {autoLaunchNote && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {autoLaunchNote}
              </Typography>
            )}
          </Box>

          <Divider />

          <Typography variant="caption" color="text.secondary">
            凭证仅保存在本机配置文件中，不会上传。数据目录由 Electron 用户数据目录决定。
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} color="inherit">
          取消
        </Button>
        <Button variant="contained" onClick={handleSave}>
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
