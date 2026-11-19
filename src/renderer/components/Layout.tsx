/**
 * 应用外壳：左侧导航 + 品牌区 + 内容区 + 底部设置 / 数据管理入口。
 * 四个标准视图共用；图标统一为 Lucide 线性风格。
 */

import type { ReactElement, ReactNode } from 'react';
import {
  Box,
  Button,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import type { ViewKey } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from './LucideIcon';

interface NavItem {
  key: ViewKey;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'pomodoro', label: '番茄钟', icon: 'timer' },
  { key: 'todo', label: 'TODO', icon: 'list' },
  { key: 'worktimer', label: '工作计时', icon: 'play' },
  { key: 'summary', label: '汇总', icon: 'chart' },
];

const VIEW_TITLES: Record<ViewKey, string> = {
  pomodoro: '番茄钟',
  todo: 'TODO 清单',
  worktimer: '工作计时',
  summary: '工作汇总',
};

export default function Layout({ children }: { children: ReactNode }): ReactElement {
  const activeView = useAppStore((state) => state.activeView);
  const setActiveView = useAppStore((state) => state.setActiveView);
  const openSettings = useAppStore((state) => state.openSettings);
  const openDataManager = useAppStore((state) => state.openDataManager);
  const setMode = useAppStore((state) => state.setMode);

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Box
        component="aside"
        sx={{
          width: 216,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.paper',
          borderRight: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ px: 2.5, py: 2.5 }}>
          <Typography variant="h6" color="primary" sx={{ letterSpacing: 0.4 }}>
            Schedule Flow
          </Typography>
          <Typography variant="caption" color="text.secondary">
            专注 · 记录 · 复盘
          </Typography>
        </Box>
        <Divider />
        <List sx={{ px: 1.25, py: 1.5, flex: 1 }}>
          {NAV_ITEMS.map((item) => (
            <Tooltip key={item.key} title={item.label} placement="right">
              <ListItemButton
                selected={activeView === item.key}
                onClick={() => setActiveView(item.key)}
                sx={{ borderRadius: 2, mb: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 38, color: 'inherit' }}>
                  <LucideIcon name={item.icon} size={19} />
                </ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            </Tooltip>
          ))}
        </List>
        <Divider />
        <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Tooltip title="打开两个独立小窗（番茄钟 / TODO），主窗口将隐藏" placement="right">
            <Button
              fullWidth
              startIcon={<LucideIcon name="layout-grid" size={17} />}
              onClick={() => setMode('mini')}
              color="inherit"
              sx={{ justifyContent: 'flex-start', whiteSpace: 'nowrap' }}
            >
              极简模式
            </Button>
          </Tooltip>
          <Tooltip title="数据管理：导出 / 导入备份" placement="right">
            <Button
              fullWidth
              startIcon={<LucideIcon name="download" size={17} />}
              onClick={openDataManager}
              color="inherit"
              sx={{ justifyContent: 'flex-start', whiteSpace: 'nowrap' }}
            >
              数据管理
            </Button>
          </Tooltip>
          <Tooltip title="设置：推送与番茄参数" placement="right">
            <Button
              fullWidth
              startIcon={<LucideIcon name="settings" size={17} />}
              onClick={openSettings}
              color="inherit"
              sx={{ justifyContent: 'flex-start', whiteSpace: 'nowrap' }}
            >
              设置
            </Button>
          </Tooltip>
        </Box>
      </Box>

      <Box
        component="main"
        sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 3.5, bgcolor: 'background.default' }}
      >
        <Typography variant="h5" sx={{ mb: 3 }}>
          {VIEW_TITLES[activeView]}
        </Typography>
        {children}
      </Box>
    </Box>
  );
}
