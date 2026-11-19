/**
 * 删除二次确认（MUI Dialog，自带居中过渡，不出现弹窗跳动）。
 */

import type { ReactElement } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import type { Todo } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from './LucideIcon';

interface DeleteConfirmDialogProps {
  todo: Todo | null;
  onClose: () => void;
}

export default function DeleteConfirmDialog({
  todo,
  onClose,
}: DeleteConfirmDialogProps): ReactElement {
  const deleteTodo = useAppStore((state) => state.deleteTodo);

  const confirm = (): void => {
    if (todo) void deleteTodo(todo.id);
    onClose();
  };

  return (
    <Dialog
      open={todo !== null}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      aria-labelledby="delete-confirm-title"
    >
      <DialogTitle id="delete-confirm-title" sx={{ textAlign: 'center', pt: 3 }}>
        <Box
          sx={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            bgcolor: '#FEF2F2',
            color: 'error.main',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            mx: 'auto',
            mb: 1.5,
          }}
        >
          <LucideIcon name="alert-triangle" size={26} />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          确认删除这条工作项？
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', lineHeight: 1.8, wordBreak: 'break-all' }}>
          即将删除「{todo?.title ?? ''}」。<br />
          该项的计时记录与备注会一并移除，且无法撤销。
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3, pt: 1.5, gap: 1 }}>
        <Button onClick={onClose} color="inherit" variant="outlined" sx={{ flex: 1 }}>
          取消
        </Button>
        <Button onClick={confirm} color="error" variant="contained" sx={{ flex: 1 }}>
          确认删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}
