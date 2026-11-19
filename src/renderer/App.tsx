/**
 * 根组件：每个窗口各自初始化 store，再按 URL 中的 window 类型分流渲染。
 * main → 标准四视图 + 全局浮层；pomo/todo → frameless 小窗外壳 + compact 视图。
 * 全局浮层只在 main 挂载，避免三个窗口重复弹提醒 / 重复初始化副作用。
 */

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Snackbar,
} from '@mui/material';
import Layout from './components/Layout';
import MiniWindowShell from './components/MiniWindowShell';
import DataManagerDialog from './components/DataManagerDialog';
import SettingsDialog from './components/SettingsDialog';
import ReminderOverlay from './components/ReminderOverlay';
import PomodoroView from './views/PomodoroView';
import TodoView from './views/TodoView';
import WorkTimerView from './views/WorkTimerView';
import SummaryView from './views/SummaryView';
import { useAppStore } from './store/useAppStore';
import { detectWindowType } from './windowKind';

export default function App(): ReactElement {
  const windowType = detectWindowType();
  const initialized = useAppStore((state) => state.initialized);
  const initialize = useAppStore((state) => state.initialize);
  const activeView = useAppStore((state) => state.activeView);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const closeSettings = useAppStore((state) => state.closeSettings);
  const dataManagerOpen = useAppStore((state) => state.dataManagerOpen);
  const closeDataManager = useAppStore((state) => state.closeDataManager);
  const reminder = useAppStore((state) => state.reminder);
  const confirmReminder = useAppStore((state) => state.confirmReminder);
  const toast = useAppStore((state) => state.toast);
  const clearToast = useAppStore((state) => state.clearToast);
  const allDoneNotice = useAppStore((state) => state.allDoneNotice);
  const dismissAllDoneNotice = useAppStore((state) => state.dismissAllDoneNotice);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // 禁用 Ctrl+滚轮缩放：Chromium 会把缩放级别按来源持久化，
  // 误触后小窗内容整体放大出现滚动条，且卸载重装也不会清除。
  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) event.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  if (!initialized) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  // 小窗：只渲染自身内容，不挂载设置 / 数据管理 / 提醒 / allDone / Snackbar。
  if (windowType === 'pomo') {
    return (
      <MiniWindowShell windowKey="pomo" title="番茄钟">
        <PomodoroView compact />
      </MiniWindowShell>
    );
  }
  if (windowType === 'todo') {
    return (
      <MiniWindowShell windowKey="todo" title="TODO">
        <TodoView compact />
      </MiniWindowShell>
    );
  }

  return (
    <>
      <Layout>
        {activeView === 'pomodoro' && <PomodoroView />}
        {activeView === 'todo' && <TodoView />}
        {activeView === 'worktimer' && <WorkTimerView />}
        {activeView === 'summary' && <SummaryView />}
      </Layout>

      <SettingsDialog open={settingsOpen} onClose={closeSettings} />
      <DataManagerDialog open={dataManagerOpen} onClose={closeDataManager} />
      <ReminderOverlay payload={reminder} onConfirm={() => void confirmReminder()} />

      <Dialog open={allDoneNotice} onClose={dismissAllDoneNotice} maxWidth="xs" fullWidth>
        <DialogTitle>全部轮次完成</DialogTitle>
        <DialogContent>
          <DialogContentText>已完成设定的全部番茄轮次，记得起身活动一下。</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={dismissAllDoneNotice}>
            好的
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={toast !== null}
        autoHideDuration={3200}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') clearToast();
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={toast?.severity ?? 'info'}
          variant="filled"
          onClose={clearToast}
          sx={{ width: '100%' }}
        >
          {toast?.message ?? ''}
        </Alert>
      </Snackbar>
    </>
  );
}
