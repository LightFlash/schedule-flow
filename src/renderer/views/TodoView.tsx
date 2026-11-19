/**
 * TODO 视图：新建、勾选完成、状态/用时徽标、行内计时按钮、备注富文本浮层、
 * 删除二次确认。compact 模式用于极简小窗（添加区图标化、隐藏徽标）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
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

/**
 * 可拖拽行容器：mousedown 跟手拖动 + 跨行交换 + FLIP 回位动画（无第三方依赖）。
 * 实现参考 zhihu.com/p/556265103；onMove 触发相邻交换，松手时 onCommit 提交最终顺序。
 */
interface SortableRowProps {
  index: number;
  totalCount: number;
  onMove: (from: number, to: number) => void;
  onCommit: () => void;
  children: ReactNode;
}

function SortableRow({ index, totalCount, onMove, onCommit, children }: SortableRowProps): ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [top, setTop] = useState(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  const totalCountRef = useRef(totalCount);
  totalCountRef.current = totalCount;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const prevRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return undefined;
    let startY = 0;

    const onMouseMove = (event: globalThis.MouseEvent): void => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      let latestTop = event.clientY - startY;
      // 拖动距离超过行高：与下一行 / 上一行交换，并同步修正基准，保证行始终跟手。
      if (latestTop > rect.height && indexRef.current < totalCountRef.current - 1) {
        onMoveRef.current(indexRef.current, indexRef.current + 1);
        latestTop -= rect.height;
        startY += rect.height;
      } else if (latestTop < -rect.height && indexRef.current > 0) {
        onMoveRef.current(indexRef.current, indexRef.current - 1);
        latestTop += rect.height;
        startY -= rect.height;
      }
      setTop(latestTop);
    };
    const onMouseUp = (event: globalThis.MouseEvent): void => {
      event.preventDefault();
      document.removeEventListener('mousemove', onMouseMove);
      setTop(0);
      setIsDragging(false);
      onCommitRef.current();
    };
    const onMouseDown = (event: globalThis.MouseEvent): void => {
      if (event.button !== 0) return;
      // 从可交互元素上按下的拖拽忽略，避免干扰勾选 / 点击 / 编辑。
      if ((event.target as HTMLElement).closest('input, textarea, button, a')) return;
      event.preventDefault();
      startY = event.clientY;
      setIsDragging(true);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp, { once: true });
    };

    el.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, []);

  // FLIP：其它行位置变化时做回位动画（拖拽中的行不参与，松手后自然落位）。
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || isDragging) return;
    if (prevRectRef.current === null) {
      prevRectRef.current = el.getBoundingClientRect();
      return;
    }
    if (animationRef.current && animationRef.current.playState === 'running') {
      animationRef.current.cancel();
    }
    const latest = el.getBoundingClientRect();
    const deltaY = latest.y - prevRectRef.current.y;
    prevRectRef.current = latest;
    if (deltaY === 0) return;
    animationRef.current = el.animate([{ top: `${-deltaY}px` }, { top: '0px' }], 200);
  }, [index, isDragging]);

  return (
    <div
      ref={rowRef}
      style={{
        position: 'relative',
        top: isDragging ? `${top}px` : '0px',
        zIndex: isDragging ? 10 : 0,
        transform: isDragging ? 'scale(1.01)' : 'scale(1)',
        transition: 'transform .2s, box-shadow .2s',
        boxShadow: isDragging ? '0 10px 24px rgba(15, 23, 42, 0.18)' : 'none',
        cursor: 'grab',
      }}
    >
      {children}
    </div>
  );
}

interface TodoRowProps {
  todo: Todo;
  isActive: boolean;
  compact: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

function TodoRow({ todo, isActive, compact, canMoveUp = false, canMoveDown = false }: TodoRowProps): ReactElement {
  const toggleTodo = useAppStore((state) => state.toggleTodo);
  const moveTodo = useAppStore((state) => state.moveTodo);
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
        borderColor: todo.completed ? '#E2E8F0' : status === 'running' ? 'primary.light' : 'divider',
        bgcolor: todo.completed ? '#F8FAFC' : status === 'running' ? '#F5F9FF' : 'background.paper',
        boxShadow: !todo.completed && status === 'running' ? 'inset 3px 0 0 #2563EB' : 'none',
        opacity: todo.completed ? 0.85 : 1,
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
            label={todo.completed ? '已完成' : isActive || status === 'running' ? '计时中' : STATUS_LABEL[status]}
            color={todo.completed ? 'success' : isActive || status === 'running' ? 'primary' : 'default'}
            variant="outlined"
            sx={{ mx: 1 }}
          />
        )}
        {!compact && <Chip size="small" label={formatDuration(liveAccumulatedMs)} sx={{ mr: 0.5 }} />}

        <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0 }}>
          {!compact && (
            <>
              <Tooltip title={canMoveUp ? '上移' : '已经在最上面'}>
                <span>
                  <IconButton
                    size="small"
                    aria-label="上移工作项"
                    disabled={!canMoveUp}
                    onClick={() => void moveTodo(todo.id, -1)}
                    sx={{ color: '#94A3B8' }}
                  >
                    <LucideIcon name="chevron-up" size={16} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={canMoveDown ? '下移' : '已经在最下面'}>
                <span>
                  <IconButton
                    size="small"
                    aria-label="下移工作项"
                    disabled={!canMoveDown}
                    onClick={() => void moveTodo(todo.id, 1)}
                    sx={{ color: '#94A3B8' }}
                  >
                    <LucideIcon name="chevron-down" size={16} />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )}
          <Tooltip title={todo.completed ? '已完成的工作项不可计时' : status === 'running' ? '暂停计时' : status === 'paused' ? '继续计时' : '开始计时'}>
            <span>
              <IconButton
                size={compact ? 'small' : 'medium'}
                aria-label={status === 'running' ? '暂停计时' : status === 'paused' ? '继续计时' : '开始计时'}
                disabled={todo.completed}
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
            </span>
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
  const reorderTodos = useAppStore((state) => state.reorderTodos);
  const [title, setTitle] = useState('');

  // 拖拽排序：拖动期间用本地顺序即时预览（跟手交换），松手一次性提交最终顺序。
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);

  const visibleTodos = useMemo<Todo[]>(() => {
    if (!dragOrder) return todos;
    const byId = new Map(todos.map((item) => [item.id, item]));
    return dragOrder.map((id) => byId.get(id)).filter((item): item is Todo => Boolean(item));
  }, [dragOrder, todos]);

  const handleDragMove = (from: number, to: number): void => {
    setDragOrder((previous) => {
      const base = previous ?? todos.map((item) => item.id);
      if (from < 0 || from >= base.length || to < 0 || to >= base.length) return previous;
      const next = [...base];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const handleDragCommit = (): void => {
    const order = dragOrder;
    if (order) void reorderTodos(order);
    setDragOrder(null);
  };

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
          {visibleTodos.map((todo, index) => (
            <SortableRow
              key={todo.id}
              index={index}
              totalCount={visibleTodos.length}
              onMove={handleDragMove}
              onCommit={handleDragCommit}
            >
              <TodoRow
                todo={todo}
                isActive={activeTodoId === todo.id}
                compact={compact}
                canMoveUp={index > 0}
                canMoveDown={index < visibleTodos.length - 1}
              />
            </SortableRow>
          ))}
        </List>
      )}
    </Box>
  );
}
