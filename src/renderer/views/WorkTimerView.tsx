/**
 * 工作计时视图（多开并发版）。
 *
 * 结构：标题 + 「进行中 N 项 · 本次合计」汇总 → 新增计时入口（下拉只列未完成且未计时的项）
 *      → 进行中计时卡片列表（每条独立暂停 / 继续 / 停止，见 WorkTimerActiveList）
 *      → 工作项用时列表（累计用时查看 + 删除入口）。
 * 计时视图态全部来自主进程 tick，切换视图不中断；本视图不自行推算时长。
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Box,
  Button,
  Chip,
  FormControl,
  FormHelperText,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { formatClock, formatDuration } from '@shared/time';
import type { TimingStatus, Todo } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from '../components/LucideIcon';
import DeleteConfirmDialog from '../components/DeleteConfirmDialog';
import WorkTimerActiveList from '../components/WorkTimerActiveList';

const STATUS_LABEL: Record<TimingStatus, string> = {
  idle: '未开始',
  running: '计时中',
  paused: '已暂停',
};

export default function WorkTimerView(): ReactElement {
  const todos = useAppStore((state) => state.todos);
  const entries = useAppStore((state) => state.workTimer.entries);
  const totalSessionElapsedMs = useAppStore((state) => state.workTimer.totalSessionElapsedMs);
  const startWork = useAppStore((state) => state.startWork);

  const [selectedId, setSelectedId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Todo | null>(null);

  // 新增计时入口只列「未完成且未计时」的项：已在跑的项由卡片列表控制，不重复出现在下拉里。
  const startableTodos = useMemo(
    () => todos.filter((todo) => !todo.completed && todo.timingStatus === 'idle'),
    [todos],
  );

  // 选中的项开始计时后（或被打勾完成 / 删除）就不再可选，自动回退到第一个可选项。
  useEffect(() => {
    if (startableTodos.some((todo) => todo.id === selectedId)) return;
    setSelectedId(startableTodos[0]?.id ?? '');
  }, [startableTodos, selectedId]);

  const handleStart = (): void => {
    if (selectedId === '') return;
    void startWork(selectedId);
  };

  const runningCount = entries.length;

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto' }}>
      <Paper sx={{ p: 2.5, mb: 2.5 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          spacing={2}
          sx={{ mb: 2 }}
        >
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            工作计时
          </Typography>
          {runningCount > 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              <Box component="span" sx={{ color: 'primary.main', mr: 0.5 }}>
                ●
              </Box>
              进行中 {runningCount} 项 · 本次合计 {formatClock(totalSessionElapsedMs)}
            </Typography>
          )}
        </Stack>

        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <FormControl sx={{ minWidth: 260, flex: 1 }} size="small">
            <InputLabel id="work-todo-select-label">选择工作项</InputLabel>
            <Select
              labelId="work-todo-select-label"
              label="选择工作项"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              disabled={startableTodos.length === 0}
            >
              {startableTodos.map((todo) => (
                <MenuItem key={todo.id} value={todo.id}>
                  {todo.title}
                </MenuItem>
              ))}
            </Select>
            {startableTodos.length === 0 && (
              <FormHelperText>未完成工作项均已在进行中</FormHelperText>
            )}
          </FormControl>
          <Button
            variant="contained"
            startIcon={<LucideIcon name="play" size={16} />}
            onClick={handleStart}
            disabled={startableTodos.length === 0 || selectedId === ''}
            sx={{ whiteSpace: 'nowrap', minWidth: 112, height: 40 }}
          >
            开始计时
          </Button>
        </Stack>
      </Paper>

      <Box sx={{ mb: 2.5 }}>
        <WorkTimerActiveList />
      </Box>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          工作项用时
        </Typography>
        {todos.length === 0 ? (
          <Typography color="text.secondary">暂无工作项。</Typography>
        ) : (
          <List disablePadding>
            {todos.map((todo) => (
              <ListItem key={todo.id} divider disableGutters>
                <ListItemText
                  primary={todo.title}
                  secondary={`累计 ${formatDuration(todo.accumulatedMs)}`}
                />
                <Chip
                  size="small"
                  label={todo.completed ? '已完成' : STATUS_LABEL[todo.timingStatus]}
                  // 暂停态用 warning 色，避免与「未开始」的灰色无从区分。
                  color={
                    todo.completed
                      ? 'success'
                      : todo.timingStatus === 'running'
                        ? 'primary'
                        : todo.timingStatus === 'paused'
                          ? 'warning'
                          : 'default'
                  }
                  variant="outlined"
                  sx={{ mr: 1 }}
                />
                <Tooltip title="删除这条工作项">
                  <IconButton
                    size="small"
                    aria-label={`删除工作项「${todo.title}」`}
                    onClick={() => setDeleteTarget(todo)}
                    sx={{ color: '#94A3B8', '&:hover': { bgcolor: '#FEF2F2', color: 'error.main' } }}
                  >
                    <LucideIcon name="trash" size={16} />
                  </IconButton>
                </Tooltip>
              </ListItem>
            ))}
          </List>
        )}
      </Paper>

      <DeleteConfirmDialog todo={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </Box>
  );
}
