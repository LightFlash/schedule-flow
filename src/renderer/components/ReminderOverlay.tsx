/**
 * 强提醒遮罩：全屏高亮闪烁，直到用户点击确认（主进程会同步取消置顶/闪烁）。
 */

import type { ReactElement } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { ReminderPayload } from '@shared/types';

interface ReminderOverlayProps {
  payload: ReminderPayload | null;
  onConfirm: () => void;
}

const FLASH_STYLE = `
@keyframes sf-flash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.15); border-color: rgba(249,115,22,0.35); }
  50% { box-shadow: 0 0 0 16px rgba(249, 115, 22, 0.28); border-color: rgba(249,115,22,1); }
}
`;

export default function ReminderOverlay({ payload, onConfirm }: ReminderOverlayProps): ReactElement | null {
  if (!payload) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(3px)',
      }}
    >
      <style>{FLASH_STYLE}</style>
      <Paper
        sx={{
          width: 520,
          p: 4.5,
          textAlign: 'center',
          border: '2px solid',
          animation: 'sf-flash 0.9s ease-in-out infinite',
        }}
      >
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 1.5 }}>
          {payload.title}
        </Typography>
        <Typography sx={{ whiteSpace: 'pre-wrap', color: 'text.secondary', mb: 3.5 }}>
          {payload.message}
        </Typography>
        <Button
          variant="contained"
          size="large"
          startIcon={<CheckCircleIcon />}
          onClick={onConfirm}
          sx={{ px: 4 }}
        >
          确认 / 关闭提醒
        </Button>
      </Paper>
    </Box>
  );
}
