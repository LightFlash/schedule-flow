/**
 * 数据管理弹窗：说明本机存储位置、导出/导入 JSON 备份、退出时自动备份开关。
 */

import { useRef } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from './LucideIcon';

interface DataManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function DataManagerDialog({ open, onClose }: DataManagerDialogProps): ReactElement {
  const settings = useAppStore((state) => state.settings);
  const exportData = useAppStore((state) => state.exportData);
  const importData = useAppStore((state) => state.importData);
  const setAutoBackup = useAppStore((state) => state.setAutoBackup);
  const closeDataManager = useAppStore((state) => state.closeDataManager);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClose = (): void => {
    closeDataManager();
    onClose();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) void importData(file);
    event.target.value = '';
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm" aria-labelledby="data-manager-title">
      <DialogTitle id="data-manager-title">
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <LucideIcon name="settings" size={20} />
          <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>
            数据管理
          </Typography>
          <Tooltip title="关闭">
            <IconButton size="small" onClick={handleClose} aria-label="关闭数据管理">
              <LucideIcon name="x" size={18} />
            </IconButton>
          </Tooltip>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Box
            sx={{
              bgcolor: '#FFFBEB',
              border: '1px solid #FDE68A',
              borderRadius: 2,
              p: 1.5,
              fontSize: 12,
              color: '#92400E',
              lineHeight: 1.75,
            }}
          >
            所有记录保存在本机用户目录：
            <Box component="code" sx={{ bgcolor: '#FEF3C7', borderRadius: 0.5, px: 0.5, fontFamily: 'Consolas, monospace', fontSize: 11, wordBreak: 'break-all' }}>
              %APPDATA%\Schedule Flow\config.json
            </Box>
            <br />
            软件更新 / 重新安装不会丢失；换电脑需手动迁移该文件。建议定期导出备份。
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1.25, fontWeight: 700 }}>
              备份与迁移
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1.5} sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, mb: 1 }}>
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  flexShrink: 0,
                  borderRadius: 1.5,
                  bgcolor: '#EFF6FF',
                  color: 'primary.main',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LucideIcon name="download" size={17} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>导出备份</Typography>
                <Typography variant="caption" color="text.secondary">
                  把所有 TODO、用时、番茄记录、设置导出为 JSON 文件
                </Typography>
              </Box>
              <Tooltip title="导出备份 JSON">
                <Button size="small" variant="contained" startIcon={<LucideIcon name="download" size={15} />} onClick={() => void exportData()} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                  导出
                </Button>
              </Tooltip>
            </Stack>

            <Stack direction="row" alignItems="center" spacing={1.5} sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  flexShrink: 0,
                  borderRadius: 1.5,
                  bgcolor: '#EFF6FF',
                  color: 'primary.main',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LucideIcon name="upload" size={17} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>导入恢复</Typography>
                <Typography variant="caption" color="text.secondary">
                  从之前导出的 JSON 文件恢复（会覆盖当前数据）
                </Typography>
              </Box>
              <Tooltip title="从 JSON 文件恢复">
                <Button size="small" variant="outlined" startIcon={<LucideIcon name="upload" size={15} />} onClick={() => fileInputRef.current?.click()} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                  导入
                </Button>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={handleFileChange}
                style={{ display: 'none' }}
                aria-label="选择备份 JSON 文件"
              />
            </Stack>
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1.25, fontWeight: 700 }}>
              自动化
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1.5} sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  flexShrink: 0,
                  borderRadius: 1.5,
                  bgcolor: '#EFF6FF',
                  color: 'primary.main',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LucideIcon name="reset" size={17} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>自动备份</Typography>
                <Typography variant="caption" color="text.secondary">
                  每次退出程序时自动保留一份带日期的副本
                </Typography>
              </Box>
              <Tooltip title={settings.autoBackup ? '退出时自动备份：已开启' : '退出时自动备份：已关闭'}>
                <Switch
                  checked={settings.autoBackup}
                  onChange={(event) => void setAutoBackup(event.target.checked)}
                  inputProps={{ 'aria-label': '自动备份开关' }}
                />
              </Tooltip>
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
