/**
 * 工作计时视图：对象选择、大号计时（本次 + 累计）、启停 / 暂停继续、计时列表。
 * 计时视图态来自主进程 tick，切换视图不中断。
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Box,
  Button,
  Chip,
  FormControl,
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

const STATUS_LABEL: Record<TimingStatus, string> = {
  idle: '未开始',
  running: '计时中',
  paused: '已暂停',
};

export default function WorkTimerView(): ReactElement {
  const todos = useAppStore((state) => state.todos);
  const workTimer = useAppStore((state) => state.workTimer);
  const startWork = useAppStore((state) => state.startWork);
  const stopWork = useAppStore((state) => state.stopWork);
  const pauseWork = useAppStore((state) => state.pauseWork);
  const resumeWork = useAppStore((state) => state.resumeWork);

  const [selectedId, setSelectedId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Todo | null>(null);

  useEffect(() => {
    if (workTimer.activeTodoId) {
      setSelectedId(workTimer.activeTodoId);
    } else if (selectedId === '' && todos.length > 0) {
      setSelectedId(todos[0].id);
    }
  }, [workTimer.activeTodoId, selectedId, todos]);

  // 选中的工作项被删除后清空选择，避免 Select 悬空。
  useEffect(() => {
    if (selectedId !== '' && !todos.some((todo) => todo.id === selectedId)) {
      setSelectedId('');
    }
  }, [todos, selectedId]);

  const isActiveItem = workTimer.activeTodoId !== null && workTimer.activeTodoId === selectedId;
  const displayTitle = isActiveItem ? workTimer.activeTitle : todos.find((t) => t.id === selectedId)?.title ?? '';

  const handleStart = (): void => {
    if (selectedId) void startWork(selectedId);
  };

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto' }}>
      <Paper sx={{ p: 3.5, mb: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
          <FormControl sx={{ minWidth: 260 }}>
            <InputLabel id="work-todo-select-label">计时对象</InputLabel>
            <Select
              labelId="work-todo-select-label"
              label="计时对象"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {todos.map((todo) => (
                <MenuItem key={todo.id} value={todo.id}>
                  {todo.title}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Chip
            label={STATUS_LABEL[isActiveItem ? workTimer.status : 'idle']}
            color={isActiveItem && workTimer.status === 'running' ? 'primary' : 'default'}
            variant="outlined"
          />
          {workTimer.status !== 'idle' && !isActiveItem && (
            <Typography variant="caption" color="warning.main">
              当前有其它工作项正在计时
            </Typography>
          )}
        </Stack>

        <Box sx={{ textAlign: 'center', py: 2 }}>
          <Typography variant="h2" component="div" sx={{ fontWeight: 700, letterSpacing: 2 }}>
            {formatClock(workTimer.sessionElapsedMs)}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {displayTitle || '未选择工作项'} · 本次用时
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            累计用时 {formatDuration(workTimer.activeAccumulatedMs + (isActiveItem ? workTimer.sessionElapsedMs : 0))}
          </Typography>
        </Box>

        <Stack direction="row" spacing={2} justifyContent="center" alignItems="center" sx={{ mt: 3 }}>
          {(!isActiveItem || workTimer.status === 'idle') && (
            <Button
              variant="contained"
              startIcon={<LucideIcon name="play" size={16} />}
              onClick={handleStart}
              disabled={selectedId === ''}
            >
              开始
            </Button>
          )}
          {isActiveItem && workTimer.status === 'running' && (
            <>
              <Button
                variant="contained"
                color="warning"
                startIcon={<LucideIcon name="pause" size={16} />}
                onClick={() => void pauseWork()}
              >
                暂停
              </Button>
              <Tooltip title="停止并结算用时">
                <IconButton
                  aria-label="停止并结算用时"
                  onClick={() => void stopWork()}
                  sx={{ width: 40, height: 40, borderRadius: 2, bgcolor: '#FEF2F2', color: 'error.main', '&:hover': { bgcolor: '#FEE2E2' } }}
                >
                  <LucideIcon name="square" size={16} />
                </IconButton>
              </Tooltip>
            </>
          )}
          {isActiveItem && workTimer.status === 'paused' && (
            <>
              <Button
                variant="contained"
                startIcon={<LucideIcon name="play" size={16} />}
                onClick={() => void resumeWork()}
              >
                继续
              </Button>
              <Tooltip title="停止并结算用时">
                <IconButton
                  aria-label="停止并结算用时"
                  onClick={() => void stopWork()}
                  sx={{ width: 40, height: 40, borderRadius: 2, bgcolor: '#FEF2F2', color: 'error.main', '&:hover': { bgcolor: '#FEE2E2' } }}
                >
                  <LucideIcon name="square" size={16} />
                </IconButton>
              </Tooltip>
            </>
          )}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          工作项用时
        </Typography>
        {todos.length === 0 ? (
          <Typography color="text.secondary">暂无工作项。</Typography>
        ) : (
          <List disablePadding>
            {todos.map((todo) => {
              const active = workTimer.activeTodoId === todo.id;
              return (
                <ListItem key={todo.id} divider disableGutters>
                  <ListItemText primary={todo.title} secondary={`累计 ${formatDuration(todo.accumulatedMs)}`} />
                  <Chip
                    size="small"
                    label={active ? STATUS_LABEL[workTimer.status] : STATUS_LABEL[todo.timingStatus]}
                    color={active && workTimer.status === 'running' ? 'primary' : 'default'}
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
              );
            })}
          </List>
        )}
      </Paper>

      <DeleteConfirmDialog todo={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </Box>
  );
}
