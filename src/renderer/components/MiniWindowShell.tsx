/**
 * 真实 frameless 小窗外壳：自绘标题栏 + 原生系统级拖动 + 右下角手动缩放。
 * 拖动用 -webkit-app-region: drag（真实窗口不要叠 no-drag 透明面，会吞事件）；
 * 置顶 / 切回标准 / 关闭 / 缩放全部走 bridge，由主进程权威执行。
 */

import { useRef } from 'react';
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from 'react';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { MiniWindowKey } from '@shared/types';
import { bridge } from '../api/bridge';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from './LucideIcon';

const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;
/** 缩放时 IPC 节流；松手时强制补发最终尺寸。 */
const RESIZE_THROTTLE_MS = 60;

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;
const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;

interface ResizeOrigin {
  startX: number;
  startY: number;
  width: number;
  height: number;
}

interface MiniWindowShellProps {
  windowKey: MiniWindowKey;
  title: string;
  children: ReactNode;
}

export default function MiniWindowShell({
  windowKey,
  title,
  children,
}: MiniWindowShellProps): ReactElement {
  const pinned = useAppStore((state) => state.miniWindows[windowKey].pinned);
  const toggleMiniPin = useAppStore((state) => state.toggleMiniPin);
  const closeMiniWindow = useAppStore((state) => state.closeMiniWindow);
  const setMode = useAppStore((state) => state.setMode);
  const resizeOrigin = useRef<ResizeOrigin | null>(null);

  const beginResize = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const geometry = useAppStore.getState().miniWindows[windowKey];
    resizeOrigin.current = {
      startX: event.clientX,
      startY: event.clientY,
      width: geometry.width,
      height: geometry.height,
    };
    let lastSentAt = 0;

    const commit = (clientX: number, clientY: number, force: boolean): void => {
      const origin = resizeOrigin.current;
      if (!origin) return;
      const width = Math.max(MIN_WIDTH, Math.round(origin.width + clientX - origin.startX));
      const height = Math.max(MIN_HEIGHT, Math.round(origin.height + clientY - origin.startY));
      const now = Date.now();
      if (!force && now - lastSentAt < RESIZE_THROTTLE_MS) return;
      lastSentAt = now;
      void bridge
        .setMiniBounds(windowKey, { width, height })
        .catch(() => useAppStore.getState().showToast('调整窗口尺寸失败', 'error'));
    };

    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      commit(moveEvent.clientX, moveEvent.clientY, false);
    };
    const onUp = (upEvent: globalThis.MouseEvent): void => {
      commit(upEvent.clientX, upEvent.clientY, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      resizeOrigin.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <Box
      sx={{
        position: 'relative',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: '#D7DEE9',
        borderRadius: '10px',
        overflow: 'hidden',
      }}
    >
      <Box
        style={DRAG}
        sx={{
          minHeight: 40,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: pinned ? '#EFF6FF' : '#FAFBFD',
          userSelect: 'none',
          cursor: 'default',
        }}
      >
        <Stack direction="row" spacing={0.625} sx={{ ml: 0.25, mr: 0.75, pointerEvents: 'none' }}>
          {['#F87171', '#FBBF24', '#34D399'].map((color) => (
            <Box key={color} sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color }} />
          ))}
        </Stack>
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap', pointerEvents: 'none' }}
        >
          {title}
        </Typography>
        <Box sx={{ flex: 1, minWidth: 2 }} />

        <Tooltip title={pinned ? '本窗口已置顶 · 点击取消' : '仅置顶本窗口'}>
          <IconButton
            size="small"
            aria-label="置顶本小窗"
            style={NO_DRAG}
            onClick={() => toggleMiniPin(windowKey)}
            sx={{
              width: 27,
              height: 27,
              border: '1px solid',
              borderColor: pinned ? 'primary.dark' : '#E2E8F0',
              bgcolor: pinned ? 'primary.main' : '#F8FAFC',
              color: pinned ? '#fff' : '#94A3B8',
              '&:hover': {
                bgcolor: pinned ? 'primary.dark' : '#F1F5F9',
                color: pinned ? '#fff' : 'text.primary',
              },
            }}
          >
            <LucideIcon name="pin" size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip title="切回标准模式（关闭两个小窗并显示主窗口）">
          <IconButton
            size="small"
            aria-label="切回标准模式"
            style={NO_DRAG}
            onClick={() => setMode('standard')}
            sx={{
              width: 27,
              height: 27,
              border: '1px solid',
              borderColor: '#E2E8F0',
              bgcolor: '#F8FAFC',
              color: 'primary.main',
            }}
          >
            <LucideIcon name="layout-grid" size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip title="关闭本小窗（程序仍在托盘运行）">
          <IconButton
            size="small"
            aria-label="关闭本小窗"
            style={NO_DRAG}
            onClick={() => closeMiniWindow(windowKey)}
            sx={{
              width: 27,
              height: 27,
              color: '#94A3B8',
              '&:hover': { bgcolor: '#FEE2E2', color: 'error.main' },
            }}
          >
            <LucideIcon name="x" size={14} />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 1.5 }}>{children}</Box>

      <Box
        onMouseDown={beginResize}
        aria-hidden="true"
        style={NO_DRAG}
        sx={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
          cursor: 'nwse-resize',
          borderRadius: '0 0 10px 0',
          background:
            'linear-gradient(135deg,transparent 52%,#CBD5E1 52%,#CBD5E1 62%,transparent 62%,transparent 74%,#CBD5E1 74%,#CBD5E1 84%,transparent 84%)',
        }}
      />
    </Box>
  );
}
