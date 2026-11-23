/**
 * 进行中计时卡片列表（多开并发）。
 *
 * 数据全部来自主进程 250ms tick 推送的 `workTimer.entries`（已在主进程按清单顺序排好），
 * 本组件零 props：父组件只需放置，不需要再传任何计时数据，避免多处订阅造成状态不一致。
 * 每条卡片只控制自己：暂停 / 继续 / 停止都带 todoId。
 */

import type { ReactElement } from 'react';
import { Box, Button, Divider, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { formatClock, formatDuration } from '@shared/time';
import type { WorkTimerEntryView } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from './LucideIcon';

const ACTIVE_STATUS_LABEL: Record<WorkTimerEntryView['status'], string> = {
  running: '计时中',
  paused: '已暂停',
};

interface ActiveTimerCardProps {
  entry: WorkTimerEntryView;
  /** 是否显示上方分隔线（首条不显示）。 */
  divider: boolean;
}

/** 单条进行中计时卡片：状态点 + 标题 + 本次用时 + 累计 + 独立控制。 */
function ActiveTimerCard({ entry, divider }: ActiveTimerCardProps): ReactElement {
  const pauseWork = useAppStore((state) => state.pauseWork);
  const resumeWork = useAppStore((state) => state.resumeWork);
  const stopWork = useAppStore((state) => state.stopWork);

  const isRunning = entry.status === 'running';

  return (
    <>
      {divider && <Divider sx={{ my: 1 }} />}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ py: 1, px: 0.5, minWidth: 0 }}
      >
        <Box
          aria-hidden="true"
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            bgcolor: isRunning ? 'primary.main' : 'warning.main',
            boxShadow: isRunning ? '0 0 0 3px rgba(37, 99, 235, 0.16)' : 'none',
          }}
        />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" noWrap title={entry.title} sx={{ fontWeight: 600 }}>
            {entry.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {ACTIVE_STATUS_LABEL[entry.status]} · 累计 {formatDuration(entry.totalAccumulatedMs)}
          </Typography>
        </Box>
        <Typography
          variant="h5"
          component="div"
          sx={{
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: 0.5,
            color: isRunning ? 'text.primary' : 'text.secondary',
            flexShrink: 0,
          }}
        >
          {formatClock(entry.sessionElapsedMs)}
        </Typography>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
          {isRunning ? (
            <Tooltip title="暂停计时">
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={<LucideIcon name="pause" size={14} />}
                onClick={() => void pauseWork(entry.todoId)}
                sx={{ whiteSpace: 'nowrap' }}
              >
                暂停
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title="继续计时">
              <Button
                size="small"
                variant="contained"
                startIcon={<LucideIcon name="play" size={14} />}
                onClick={() => void resumeWork(entry.todoId)}
                sx={{ whiteSpace: 'nowrap' }}
              >
                继续
              </Button>
            </Tooltip>
          )}
          <Tooltip title="停止并结算用时">
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<LucideIcon name="square" size={13} />}
              onClick={() => void stopWork(entry.todoId)}
              aria-label={`停止「${entry.title}」的计时`}
              sx={{ whiteSpace: 'nowrap' }}
            >
              停止
            </Button>
          </Tooltip>
        </Stack>
      </Stack>
    </>
  );
}

/** 进行中计时列表：空态提示 + 卡片列表 + 「全部停止（N）」。 */
export default function WorkTimerActiveList(): ReactElement {
  const entries = useAppStore((state) => state.workTimer.entries);
  const stopAllWork = useAppStore((state) => state.stopAllWork);

  if (entries.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2, bgcolor: '#F8FAFC' }}>
        <Typography color="text.secondary" variant="body2">
          当前没有进行中的计时 —— 从上方选择工作项开始，或直接在 TODO 清单点击 ▶
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper sx={{ p: 1.5, borderRadius: 2 }}>
      {entries.map((entry, index) => (
        <ActiveTimerCard key={entry.todoId} entry={entry} divider={index > 0} />
      ))}
      <Divider sx={{ mt: 1 }} />
      <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1 }}>
        <Button
          size="small"
          color="error"
          variant="text"
          startIcon={<LucideIcon name="square" size={13} />}
          onClick={() => void stopAllWork()}
        >
          全部停止（{entries.length}）
        </Button>
      </Stack>
    </Paper>
  );
}
