import { createTheme } from '@mui/material/styles';
import { zhCN } from '@mui/material/locale';

/**
 * 全局 MUI 主题：浅色现代基调、圆角卡片、柔和阴影。
 * 四个视图共用，保证视觉一致（共享知识 12）。
 */
export const theme = createTheme(
  {
    palette: {
      mode: 'light',
      primary: { main: '#2563EB', light: '#60A5FA', dark: '#1D4ED8' },
      secondary: { main: '#F97316', light: '#FB923C', dark: '#C2410C' },
      success: { main: '#16A34A' },
      warning: { main: '#D97706' },
      error: { main: '#DC2626' },
      background: { default: '#F4F6FB', paper: '#FFFFFF' },
      text: { primary: '#1E293B', secondary: '#64748B' },
      divider: '#E2E8F0',
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily:
        '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Segoe UI", Roboto, sans-serif',
      h4: { fontWeight: 700, letterSpacing: '-0.02em' },
      h5: { fontWeight: 700 },
      h6: { fontWeight: 600 },
      button: { fontWeight: 600 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            margin: 0,
            // 不设 minWidth：主窗口自身的 BrowserWindow.minWidth(940) 已足够，
            // 独立小窗（280~300 宽）必须允许 body 收缩，否则内容按 900px 排版必然溢出。
            backgroundColor: '#F4F6FB',
            '::-webkit-scrollbar': { width: 10, height: 10 },
            '::-webkit-scrollbar-thumb': {
              backgroundColor: '#CBD5E1',
              borderRadius: 8,
              border: '2px solid transparent',
              backgroundClip: 'content-box',
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: 14,
            boxShadow: '0 6px 24px rgba(15, 23, 42, 0.06)',
            backgroundImage: 'none',
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: { borderRadius: 14, boxShadow: '0 6px 24px rgba(15, 23, 42, 0.06)' },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: { borderRadius: 10, textTransform: 'none', paddingInline: 18 },
        },
      },
      MuiTextField: {
        defaultProps: { size: 'small' },
      },
      MuiChip: {
        styleOverrides: { root: { borderRadius: 8 } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
      },
    },
  },
  zhCN,
);
