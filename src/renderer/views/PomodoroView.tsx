/**
 * 番茄钟视图：圆环倒计时、阶段/轮次、启停控制、参数快捷设置。
 * 视图态完全来自主进程 tick，切到其它视图不会中断倒计时。
 * compact 模式用于极简小窗：小圆环 + 右上角参数按钮 + 图标化控制。
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { formatClock } from '@shared/time';
import type { PomodoroConfig } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from '../components/LucideIcon';

function clampField(value: string, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

const LIMITS: Record<keyof PomodoroConfig, [number, number]> = {
  workMinutes: [1, 240],
  breakMinutes: [1, 120],
  rounds: [1, 20],
};

interface PomodoroViewProps {
  compact?: boolean;
}

export default function PomodoroView({ compact = false }: PomodoroViewProps): ReactElement {
  const pomodoro = useAppStore((state) => state.pomodoro);
  const settings = useAppStore((state) => state.settings);
  const startPomodoro = useAppStore((state) => state.startPomodoro);
  const pausePomodoro = useAppStore((state) => state.pausePomodoro);
  const resumePomodoro = useAppStore((state) => state.resumePomodoro);
  const resetPomodoro = useAppStore((state) => state.resetPomodoro);
  const updateConfig = useAppStore((state) => state.updatePomodoroConfig);
  const openSettings = useAppStore((state) => state.openSettings);
  const [configOpen, setConfigOpen] = useState(false);

  const [draft, setDraft] = useState<Record<keyof PomodoroConfig, string>>(() => ({
    workMinutes: String(pomodoro.config.workMinutes),
    breakMinutes: String(pomodoro.config.breakMinutes),
    rounds: String(pomodoro.config.rounds),
  }));
  useEffect(() => {
    setDraft({
      workMinutes: String(pomodoro.config.workMinutes),
      breakMinutes: String(pomodoro.config.breakMinutes),
      rounds: String(pomodoro.config.rounds),
    });
  }, [
    pomodoro.config.workMinutes,
    pomodoro.config.breakMinutes,
    pomodoro.config.rounds,
  ]);

  const isWork = pomodoro.phase === 'work';
  const progress =
    pomodoro.totalPhaseMs > 0
      ? Math.min(100, Math.max(0, (pomodoro.remainingMs / pomodoro.totalPhaseMs) * 100))
      : 0;
  const pushConfigured = settings.push.channels.some((channel) =>
    channel === 'serverchan'
      ? settings.push.serverChanKey.trim().length > 0
      : settings.push.pushPlusToken.trim().length > 0,
  );

  const commitField = (field: keyof PomodoroConfig, value: string): void => {
    const fallback = pomodoro.config[field];
    const [min, max] = LIMITS[field];
    const numeric = clampField(value, fallback, min, max);
    setDraft((previous) => ({ ...previous, [field]: String(numeric) }));
    void updateConfig({ ...pomodoro.config, [field]: numeric });
  };

  const renderField = (
    field: keyof PomodoroConfig,
    label: string,
  ): ReactElement => (
    <TextField
      label={label}
      type="number"
      size={compact ? 'small' : 'medium'}
      value={draft[field]}
      onChange={(event) => setDraft((previous) => ({ ...previous, [field]: event.target.value }))}
      onBlur={(event) => commitField(field, event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      inputProps={{ min: 1 }}
      fullWidth
    />
  );

  /** compact 小窗内所有控制按钮统一 34×34 / 16px 图标；标准模式保持“图标 + 文字”。 */
  const compactIconButtonSx = { width: 34, height: 34, borderRadius: 2 } as const;

  const controls: ReactElement = (
    <Stack direction="row" spacing={compact ? 1 : 2} justifyContent="center" alignItems="center">
      {pomodoro.status === 'idle' && (
        <Tooltip title="开始倒计时">
          {compact ? (
            <IconButton
              aria-label="开始倒计时"
              onClick={() => void startPomodoro()}
              sx={{ ...compactIconButtonSx, bgcolor: 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } }}
            >
              <LucideIcon name="play" size={16} />
            </IconButton>
          ) : (
            <Button
              variant="contained"
              startIcon={<LucideIcon name="play" size={16} />}
              onClick={() => void startPomodoro()}
            >
              开始
            </Button>
          )}
        </Tooltip>
      )}
      {pomodoro.status === 'running' && (
        <Tooltip title="暂停倒计时">
          {compact ? (
            <IconButton
              aria-label="暂停倒计时"
              onClick={() => void pausePomodoro()}
              sx={{ ...compactIconButtonSx, bgcolor: 'warning.main', color: '#fff', '&:hover': { bgcolor: 'warning.dark' } }}
            >
              <LucideIcon name="pause" size={16} />
            </IconButton>
          ) : (
            <Button
              variant="contained"
              color="warning"
              startIcon={<LucideIcon name="pause" size={16} />}
              onClick={() => void pausePomodoro()}
            >
              暂停
            </Button>
          )}
        </Tooltip>
      )}
      {pomodoro.status === 'paused' && (
        <Tooltip title="继续倒计时">
          {compact ? (
            <IconButton
              aria-label="继续倒计时"
              onClick={() => void resumePomodoro()}
              sx={{ ...compactIconButtonSx, bgcolor: 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } }}
            >
              <LucideIcon name="play" size={16} />
            </IconButton>
          ) : (
            <Button
              variant="contained"
              startIcon={<LucideIcon name="play" size={16} />}
              onClick={() => void resumePomodoro()}
            >
              继续
            </Button>
          )}
        </Tooltip>
      )}
      {pomodoro.status !== 'idle' && (
        <Tooltip title="停止并重置">
          <IconButton
            aria-label="停止并重置番茄钟"
            onClick={() => void resetPomodoro()}
            sx={{
              ...(!compact && { width: 40, height: 40 }),
              ...compactIconButtonSx,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: '#F8FAFC',
              color: 'text.secondary',
            }}
          >
            <LucideIcon name="square" size={16} />
          </IconButton>
        </Tooltip>
      )}
      {pomodoro.status === 'idle' && (
        <Tooltip title="重置倒计时">
          <IconButton
            aria-label="重置番茄钟"
            onClick={() => void resetPomodoro()}
            sx={{
              ...(!compact && { width: 40, height: 40 }),
              ...compactIconButtonSx,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: '#F8FAFC',
              color: 'text.secondary',
            }}
          >
            <LucideIcon name="reset" size={16} />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );

  if (compact) {
    return (
      <Paper
        variant="outlined"
        sx={{
          position: 'relative',
          p: 1.5,
          textAlign: 'center',
          borderRadius: 2,
          bgcolor: pomodoro.status === 'running' ? '#F8FBFF' : 'background.paper',
          borderColor: pomodoro.status === 'running' ? '#BFDBFE' : 'divider',
        }}
      >
        <Tooltip title="设置轮次与时间">
          <IconButton
            aria-label="设置轮次与时间"
            onClick={() => setConfigOpen((previous) => !previous)}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
              width: 30,
              height: 30,
              border: '1px solid',
              borderColor: configOpen ? '#BFDBFE' : 'divider',
              bgcolor: configOpen ? '#EFF6FF' : '#F8FAFC',
              color: configOpen ? 'primary.main' : 'text.secondary',
              zIndex: 2,
            }}
          >
            <LucideIcon name="settings" size={16} />
          </IconButton>
        </Tooltip>

        <Box sx={{ position: 'relative', width: 138, height: 138, mx: 'auto', my: 0.5 }}>
          <CircularProgress
            variant="determinate"
            value={progress}
            size={138}
            thickness={7}
            sx={{ color: isWork ? 'primary.main' : 'warning.main' }}
          />
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography variant="h5" component="div" sx={{ fontWeight: 800, letterSpacing: '-0.5px' }}>
              {formatClock(pomodoro.remainingMs)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {isWork ? '专注' : '短休息'} · 第 {pomodoro.currentRound}/{pomodoro.totalRounds} 轮
            </Typography>
          </Box>
        </Box>

        <Box sx={{ my: 1 }}>{controls}</Box>

        {configOpen && (
          <Box sx={{ mt: 1, p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1.5, bgcolor: '#F8FAFC', textAlign: 'left' }}>
            <Stack direction="row" spacing={1}>
              {renderField('workMinutes', '工作（分钟）')}
              {renderField('breakMinutes', '休息（分钟）')}
              {renderField('rounds', '轮次数')}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              修改后对新阶段生效
            </Typography>
          </Box>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
          专注 {pomodoro.config.workMinutes} 分钟 · 短休 {pomodoro.config.breakMinutes} 分钟 · 共 {pomodoro.config.rounds} 轮
        </Typography>
      </Paper>
    );
  }

  return (
    <Stack spacing={2.5} sx={{ maxWidth: 960, mx: 'auto' }}>
      <Paper
        sx={{
          p: 3,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <Chip
          size="small"
          label={pushConfigured ? '微信推送已配置' : '未配置推送（仅本地提醒）'}
          color={pushConfigured ? 'success' : 'warning'}
          variant="outlined"
          onClick={openSettings}
          sx={{ position: 'absolute', top: 14, right: 14 }}
        />
        <Box sx={{ position: 'relative', width: 240, height: 240 }}>
          <CircularProgress
            variant="determinate"
            value={progress}
            size={240}
            thickness={4}
            sx={{ color: isWork ? 'primary.main' : 'secondary.main' }}
          />
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography variant="h3" component="div" sx={{ fontWeight: 700 }}>
              {formatClock(pomodoro.remainingMs)}
            </Typography>
            <Chip
              size="small"
              label={isWork ? '工作中' : '休息中'}
              color={isWork ? 'primary' : 'secondary'}
              sx={{ mt: 1 }}
            />
          </Box>
        </Box>

        <Typography variant="body1" sx={{ mt: 2 }}>
          第 {pomodoro.currentRound} / {pomodoro.totalRounds} 轮
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, mt: 1.25 }}>
          {Array.from({ length: pomodoro.totalRounds }, (_unused, index) => (
            <Box
              key={index}
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor:
                  index + 1 < pomodoro.currentRound
                    ? 'primary.main'
                    : index + 1 === pomodoro.currentRound
                      ? 'secondary.main'
                      : 'divider',
              }}
            />
          ))}
        </Box>

        <Box sx={{ mt: 2.5 }}>{controls}</Box>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          本轮参数
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 2 }}>
          {renderField('workMinutes', '工作（分钟）')}
          {renderField('breakMinutes', '休息（分钟）')}
          {renderField('rounds', '轮次数')}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          参数修改后对新阶段生效；也可在「设置」中调整默认值。
        </Typography>
      </Paper>
    </Stack>
  );
}
