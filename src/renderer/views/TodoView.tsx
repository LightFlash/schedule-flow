/**
 * TODO 视图：新建、勾选完成、状态/用时徽标、行内计时按钮、备注富文本浮层、
 * 删除二次确认。compact 模式用于极简小窗（添加区图标化、隐藏徽标）。
 */

import { useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { formatDuration } from '@shared/time';
import type { Todo, TimingStatus } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import { stripHtml } from '../utils/text';
import DeleteConfirmDialog from '../components/DeleteConfirmDialog';
import LucideIcon from '../components/LucideIcon';
import RichTextNotePopover from '../components/RichTextNotePopover';

const STATUS_LABEL: Record<TimingStatus, string> = {
  idle: '未开始',
  running: '计时中',
  paused: '已暂停',
};

interface TodoRowProps {
  todo: Todo;
  isActive: boolean;
  compact: boolean;
}

function TodoRow({ todo, isActive, compact }: TodoRowProps): ReactElement {
  const toggleTodo = useAppStore((state) => state.toggleTodo);
  const updateTodo = useAppStore((state) => state.updateTodo);
  const startWork = useAppStore((state) => state.startWork);
  const pauseWork = useAppStore((state) => state.pauseWork);
  const resumeWork = useAppStore((state) => state.resumeWork);
  const stopWork = useAppStore((state) => state.stopWork);
  const workTimer = useAppStore((state) => state.workTimer);

  // 累计用时实时化：accumulatedMs 只在停止时落库，运行/暂停期间叠加 tick 广播的会话时长。
  const liveAccumulatedMs =
    isActive && (workTimer.status === 'running' || workTimer.status === 'paused')
      ? todo.accumulatedMs + workTimer.sessionElapsedMs
      : todo.accumulatedMs;

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [noteAnchor, setNoteAnchor] = useState<HTMLElement | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const status: TimingStatus = todo.timingStatus;
  const hasNote = todo.notes.trim().length > 0 && stripHtml(todo.notes).length > 0;

  const saveTitle = (): void => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitle(todo.title);
      setEditing(false);
      return;
    }
    if (trimmed !== todo.title) void updateTodo(todo.id, { title: trimmed });
    setEditing(false);
  };

  const handlePlay = (): void => {
    if (status === 'paused') void resumeWork();
    else void startWork(todo.id);
  };

  const openNotes = (event: MouseEvent<HTMLButtonElement>): void => {
    setNoteAnchor(event.currentTarget);
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        mb: compact ? 1 : 1.5,
        borderRadius: 2,
        borderColor: status === 'running' ? 'primary.light' : 'divider',
        bgcolor: status === 'running' ? '#F5F9FF' : 'background.paper',
        boxShadow: status === 'running' ? 'inset 3px 0 0 #2563EB' : 'none',
      }}
    >
      <ListItem disableGutters sx={{ px: compact ? 0.75 : 1, py: 0.5 }}>
        <ListItemIcon sx={{ minWidth: compact ? 32 : 40 }}>
          <Checkbox
            size={compact ? 'small' : 'medium'}
            checked={todo.completed}
            onChange={() => void toggleTodo(todo.id)}
            inputProps={{ 'aria-label': `标记「${todo.title}」完成` }}
          />
        </ListItemIcon>
        {editing ? (
          <TextField
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            autoFocus
            fullWidth
          />
        ) : (
          <ListItemText
            primary={
              <Typography
                noWrap={compact}
                sx={{
                  fontSize: compact ? 13 : 14,
                  textDecoration: todo.completed ? 'line-through' : 'none',
                  color: todo.completed ? 'text.secondary' : 'text.primary',
                }}
              >
                {todo.title}
              </Typography>
            }
            secondary={`累计用时 ${formatDuration(liveAccumulatedMs)}`}
            secondaryTypographyProps={{ variant: 'caption' }}
          />
        )}
        {!compact && (
          <Chip
            size="small"
            label={isActive || status === 'running' ? '计时中' : STATUS_LABEL[status]}
            color={isActive || status === 'running' ? 'primary' : 'default'}
            variant="outlined"
            sx={{ mx: 1 }}
          />
        )}
        {!compact && <Chip size="small" label={formatDuration(liveAccumulatedMs)} sx={{ mr: 0.5 }} />}

        <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0 }}>
          <Tooltip title={status === 'running' ? '暂停计时' : status === 'paused' ? '继续计时' : '开始计时'}>
            <IconButton
              size={compact ? 'small' : 'medium'}
              aria-label={status === 'running' ? '暂停计时' : status === 'paused' ? '继续计时' : '开始计时'}
              onClick={() => (status === 'running' ? void pauseWork() : handlePlay())}
              sx={{
                ...(compact && { width: 34, height: 34, borderRadius: 2 }),
                color: status === 'running' ? 'warning.main' : status === 'idle' ? '#fff' : 'primary.main',
                bgcolor: status === 'running' ? '#FEF3C7' : status === 'paused' ? '#EFF6FF' : 'primary.main',
                '&:hover': { bgcolor: status === 'running' ? '#FDE68A' : status === 'paused' ? '#DBEAFE' : 'primary.dark', color: status === 'paused' || status === 'running' ? 'inherit' : '#fff' },
              }}
            >
              <LucideIcon name={status === 'running' ? 'pause' : 'play'} size={compact ? 16 : 16} />
            </IconButton>
          </Tooltip>
          {status !== 'idle' && (
            <Tooltip title="停止并结算用时">
              <IconButton
                size={compact ? 'small' : 'medium'}
                aria-label="停止并结算用时"
                onClick={() => void stopWork()}
                sx={{
                  ...(compact && { width: 34, height: 34, borderRadius: 2 }),
                  color: 'error.main', bgcolor: '#FEF2F2', '&:hover': { bgcolor: '#FEE2E2' } }}
              >
                <LucideIcon name="square" size={compact ? 16 : 15} />
              </IconButton>
            </Tooltip>
          )}
          {!compact && (
            <Tooltip title="编辑标题">
              <IconButton size="small" aria-label="编辑标题" onClick={() => setEditing(true)}>
                <LucideIcon name="edit" size={16} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="查看 / 编辑备注与心得">
            <IconButton
              size={compact ? 'small' : 'medium'}
              aria-label="查看或编辑备注"
              onClick={openNotes}
              sx={{
                ...(compact && { width: 34, height: 34, borderRadius: 2 }),
                color: hasNote ? 'primary.main' : 'text.secondary', bgcolor: hasNote ? '#EFF6FF' : 'transparent' }}
            >
              <LucideIcon name="note" size={compact ? 16 : 16} />
            </IconButton>
          </Tooltip>
          <Tooltip title="删除这条工作项">
            <IconButton
              size={compact ? 'small' : 'medium'}
              aria-label="删除这条工作项"
              onClick={() => setDeleteOpen(true)}
              sx={{
                ...(compact && { width: 34, height: 34, borderRadius: 2 }),
                color: '#94A3B8', '&:hover': { bgcolor: '#FEF2F2', color: 'error.main' } }}
            >
              <LucideIcon name="trash" size={compact ? 16 : 16} />
            </IconButton>
          </Tooltip>
        </Stack>
      </ListItem>

      {noteAnchor && (
        <RichTextNotePopover todo={todo} anchorEl={noteAnchor} onClose={() => setNoteAnchor(null)} />
      )}
      <DeleteConfirmDialog todo={deleteOpen ? todo : null} onClose={() => setDeleteOpen(false)} />
    </Paper>
  );
}

interface TodoViewProps {
  compact?: boolean;
}

export default function TodoView({ compact = false }: TodoViewProps): ReactElement {
  const todos = useAppStore((state) => state.todos);
  const activeTodoId = useAppStore((state) => state.workTimer.activeTodoId);
  const addTodo = useAppStore((state) => state.addTodo);
  const [title, setTitle] = useState('');

  const submit = (): void => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    void addTodo(trimmed);
    setTitle('');
  };

  return (
    <Box sx={{ maxWidth: compact ? 'none' : 900, mx: 'auto' }}>
      <Paper sx={{ p: compact ? 1.25 : 2, mb: compact ? 2 : 3 }}>
        <Stack direction="row" spacing={compact ? 0.75 : 1.5}>
          <TextField
            label={compact ? undefined : '新建工作项'}
            placeholder="输入待办工作标题后回车"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            inputProps={{ 'aria-label': '新建工作项标题' }}
            fullWidth
          />
          {compact ? (
            <Tooltip title="添加">
              <Button
                variant="contained"
                aria-label="添加工作项"
                onClick={submit}
                sx={{ minWidth: 34, width: 34, height: 34, p: 0, flexShrink: 0, whiteSpace: 'nowrap', borderRadius: 2 }}
              >
                <LucideIcon name="plus" size={16} />
              </Button>
            </Tooltip>
          ) : (
            <Button
              variant="contained"
              startIcon={<LucideIcon name="plus" size={17} />}
              onClick={submit}
              sx={{ whiteSpace: 'nowrap', minWidth: 104, flexShrink: 0 }}
            >
              添加
            </Button>
          )}
        </Stack>
      </Paper>

      {!compact && (
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.25, fontWeight: 700 }}>
          TODO 清单
        </Typography>
      )}

      {todos.length === 0 ? (
        <Paper sx={{ p: compact ? 2.5 : 5, textAlign: 'center' }}>
          <Typography color="text.secondary" variant="body2" noWrap={compact}>
            {compact ? '还没有工作项，先在上方添加' : '还没有工作项，先在上方添加一条吧。'}
          </Typography>
        </Paper>
      ) : (
        <List disablePadding>
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} isActive={activeTodoId === todo.id} compact={compact} />
          ))}
        </List>
      )}
    </Box>
  );
}
