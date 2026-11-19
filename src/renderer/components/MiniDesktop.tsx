/**
 * 已废弃：真实多窗口改由 MiniWindowShell + 主进程 WindowManager 实现。
 * 此文件仅为兼容保留（App 已不再引用），compact 视图继续复用。
 * 旧版单窗口 DOM 浮层桌面：两个绝对定位的浮层窗口（番茄钟 / TODO）。
 * 标题栏拖动、右下角缩放、置顶、关闭与重新打开均由 UI store 驱动；
 * 拖动/缩放坐标始终 clamp 在视口内，最小尺寸 260x200。
 */

import { useRef } from 'react';
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from 'react';
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { MiniWindowKey } from '../store/useAppStore';
import { useAppStore } from '../store/useAppStore';
import PomodoroView from '../views/PomodoroView';
import TodoView from '../views/TodoView';
import LucideIcon from './LucideIcon';

const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

interface DragOrigin {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface ResizeOrigin {
  startX: number;
  startY: number;
  originW: number;
  originH: number;
}

interface MiniWindowFrameProps {
  winKey: MiniWindowKey;
  title: string;
  children: ReactNode;
}

function MiniWindowFrame({ winKey, title, children }: MiniWindowFrameProps): ReactElement {
  const win = useAppStore((state) => state.miniWindows[winKey]);
  const setMiniWindow = useAppStore((state) => state.setMiniWindow);
  const closeMiniWindow = useAppStore((state) => state.closeMiniWindow);
  const toggleMiniPin = useAppStore((state) => state.toggleMiniPin);
  const setMode = useAppStore((state) => state.setMode);
  const dragOrigin = useRef<DragOrigin | null>(null);
  const resizeOrigin = useRef<ResizeOrigin | null>(null);

  const beginDrag = (event: MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    dragOrigin.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: win.x,
      originY: win.y,
    };
    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      const origin = dragOrigin.current;
      if (!origin) return;
      setMiniWindow(winKey, {
        x: clamp(origin.originX + moveEvent.clientX - origin.startX, 0, window.innerWidth - 80),
        y: clamp(origin.originY + moveEvent.clientY - origin.startY, 0, window.innerHeight - 60),
      });
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dragOrigin.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const beginResize = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    resizeOrigin.current = {
      startX: event.clientX,
      startY: event.clientY,
      originW: win.width,
      originH: win.height,
    };
    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      const origin = resizeOrigin.current;
      if (!origin) return;
      const nextW = clamp(origin.originW + moveEvent.clientX - origin.startX, MIN_WIDTH, window.innerWidth - win.x - 8);
      const nextH = clamp(origin.originH + moveEvent.clientY - origin.startY, MIN_HEIGHT, window.innerHeight - win.y - 8);
      setMiniWindow(winKey, { width: nextW, height: nextH });
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      resizeOrigin.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 浮层是同一个 BrowserWindow 内的 DOM 元素：原生 drag 区域会吞掉鼠标事件，
  // 因此保留标题栏 app-region:drag 声明的同时，叠一层 no-drag 透明面承接 DOM 拖拽。
  const noDragStyle = {
    WebkitAppRegion: 'no-drag',
    position: 'relative',
    zIndex: 1,
  } as CSSProperties;

  return (
    <Box
      sx={{
        position: 'absolute',
        left: win.x,
        top: win.y,
        width: win.width,
        height: win.height,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: '#E8EDF5',
        borderRadius: 2,
        boxShadow: '0 14px 40px rgba(15,23,42,0.13)',
        zIndex: win.pinned ? 1200 : 10,
        overflow: 'hidden',
      }}
    >
      <Box
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        sx={{
          position: 'relative',
          minHeight: 42,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: win.pinned ? '#EFF6FF' : '#FAFBFD',
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <Box
          aria-hidden="true"
          onMouseDown={beginDrag}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          sx={{ position: 'absolute', inset: 0, zIndex: 0, cursor: 'grab' }}
        />
        <Stack direction="row" spacing={0.625} sx={{ ml: 0.25, mr: 0.5, pointerEvents: 'none' }}>
          {['#F87171', '#FBBF24', '#34D399'].map((color) => (
            <Box key={color} sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color }} />
          ))}
        </Stack>
        <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {title}
        </Typography>
        <Box sx={{ flex: 1, minWidth: 2 }} />

        <Tooltip title={win.pinned ? '已置顶 · 点击取消' : '点击开启始终置顶'}>
          <IconButton
            size="small"
            aria-label="置顶小窗"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => toggleMiniPin(winKey)}
            style={noDragStyle}
            sx={{
              width: 28,
              height: 28,
              border: '1px solid',
              borderColor: win.pinned ? 'primary.dark' : '#E2E8F0',
              bgcolor: win.pinned ? 'primary.main' : '#F8FAFC',
              color: win.pinned ? '#fff' : '#94A3B8',
              '&:hover': {
                bgcolor: win.pinned ? 'primary.dark' : '#F1F5F9',
                color: win.pinned ? '#fff' : 'text.primary',
              },
            }}
          >
            <LucideIcon name="pin" size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip title="切换到标准模式（完整四视图）">
          <IconButton
            size="small"
            aria-label="切换到标准模式"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setMode('standard')}
            style={noDragStyle}
            sx={{ width: 28, height: 28, border: '1px solid', borderColor: '#E2E8F0', bgcolor: '#F8FAFC', color: 'primary.main' }}
          >
            <LucideIcon name="layout-grid" size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip title={`关闭${title}小窗`}>
          <IconButton
            size="small"
            aria-label={`关闭${title}小窗`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => closeMiniWindow(winKey)}
            style={noDragStyle}
            sx={{
              width: 28,
              height: 28,
              color: '#94A3B8',
              '&:hover': { bgcolor: '#FEE2E2', color: 'error.main' },
            }}
          >
            <LucideIcon name="x" size={15} />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 1.75 }}>{children}</Box>

      <Box
        onMouseDown={beginResize}
        aria-hidden="true"
        sx={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
          cursor: 'nwse-resize',
          borderRadius: '0 0 12px 0',
          background:
            'linear-gradient(135deg,transparent 52%,#CBD5E1 52%,#CBD5E1 62%,transparent 62%,transparent 74%,#CBD5E1 74%,#CBD5E1 84%,transparent 84%)',
        }}
      />
    </Box>
  );
}

export default function MiniDesktop(): ReactElement {
  const miniWindows = useAppStore((state) => state.miniWindows);
  const setMode = useAppStore((state) => state.setMode);
  const reopenMiniWindow = useAppStore((state) => state.reopenMiniWindow);

  return (
    <Box sx={{ height: '100vh', bgcolor: 'background.default', p: 2, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 1.5, minHeight: 42 }}>
        <Box
          sx={{
            width: 36,
            height: 36,
            borderRadius: 1.5,
            bgcolor: 'primary.main',
            color: '#fff',
            fontWeight: 800,
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          SF
        </Box>
        <Box>
          <Typography variant="subtitle1" color="primary.dark" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            Schedule Flow · 极简模式
          </Typography>
          <Typography variant="caption" color="text.secondary">
            拖动标题栏移动 · 右下角缩放 · 图标按钮均有文字提示
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        {!miniWindows.pomo.open && (
          <Tooltip title="重新打开番茄钟小窗">
            <Button
              size="small"
              variant="outlined"
              startIcon={<LucideIcon name="plus" size={14} />}
              onClick={() => reopenMiniWindow('pomo')}
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              重新打开番茄钟窗
            </Button>
          </Tooltip>
        )}
        {!miniWindows.todo.open && (
          <Tooltip title="重新打开 TODO 小窗">
            <Button
              size="small"
              variant="outlined"
              startIcon={<LucideIcon name="plus" size={14} />}
              onClick={() => reopenMiniWindow('todo')}
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              重新打开 TODO 窗
            </Button>
          </Tooltip>
        )}
        <Tooltip title="切换到标准模式（完整四视图）">
          <IconButton
            aria-label="切换到标准模式"
            onClick={() => setMode('standard')}
            sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', color: 'primary.main' }}
          >
            <LucideIcon name="layout-grid" size={18} />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ position: 'relative', width: '100%', height: 'calc(100vh - 86px)' }}>
        {miniWindows.pomo.open && (
          <MiniWindowFrame winKey="pomo" title="番茄钟">
            <PomodoroView compact />
          </MiniWindowFrame>
        )}
        {miniWindows.todo.open && (
          <MiniWindowFrame winKey="todo" title="TODO">
            <TodoView compact />
          </MiniWindowFrame>
        )}
      </Box>
    </Box>
  );
}
