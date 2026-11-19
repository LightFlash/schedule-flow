/**
 * 汇总视图：天/周/月/年切换、三张等宽统计卡、可展开心得的工作明细。
 * 三卡使用 CSS Grid 等宽排布，窄屏自动降为单列（不再出现第三张卡掉行占满）。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  Collapse,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { formatDuration, formatTimestamp } from '@shared/time';
import type { Granularity, SummaryItem } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import { stripHtml } from '../utils/text';
import LucideIcon from '../components/LucideIcon';

const GRANULARITY_LABEL: Record<Granularity, string> = {
  day: '天',
  week: '周',
  month: '月',
  year: '年',
};

interface StatCardProps {
  label: string;
  value: string;
  accent: string;
}

function StatCard({ label, value, accent }: StatCardProps): ReactElement {
  return (
    <Card sx={{ width: '100%', minWidth: 0, height: '100%' }}>
      <CardContent sx={{ p: 2.25 }}>
        <Typography color="text.secondary" variant="body2" noWrap>
          {label}
        </Typography>
        <Typography variant="h4" component="div" sx={{ mt: 1.25, color: accent, letterSpacing: '-0.02em' }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ item }: { item: SummaryItem }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <Paper variant="outlined" sx={{ mb: 1 }}>
      <ListItem disableGutters sx={{ px: 1.5 }}>
        <ListItemText
          primary={item.title}
          secondary={`归档于 ${formatTimestamp(item.archivedAt)} · 用时 ${formatDuration(item.accumulatedMs)}`}
        />
        <Chip
          size="small"
          label={item.completed ? '已完成' : '有计时'}
          color={item.completed ? 'success' : 'default'}
          variant="outlined"
          sx={{ mr: 1 }}
        />
        <Chip size="small" label={formatDuration(item.accumulatedMs)} />
        <Tooltip title={expanded ? '收起备注' : '展开备注'}>
          <IconButton onClick={() => setExpanded(!expanded)} aria-label="展开备注">
          <Box component="span" sx={{ display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : 'none' }}>
            <LucideIcon name="chevron-down" size={18} />
          </Box>
          </IconButton>
        </Tooltip>
      </ListItem>
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Divider />
        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
            {stripHtml(item.notesPreview) || '（暂无备注 / 心得）'}
          </Typography>
        </Box>
      </Collapse>
    </Paper>
  );
}

export default function SummaryView(): ReactElement {
  const summary = useAppStore((state) => state.summary);
  const granularity = useAppStore((state) => state.summaryGranularity);
  const loadSummary = useAppStore((state) => state.loadSummary);

  return (
    <Box sx={{ maxWidth: 980, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 1.5 }}>
        <ToggleButtonGroup
          value={granularity}
          exclusive
          onChange={(_event, value: Granularity | null) => {
            if (value) void loadSummary(value);
          }}
          size="small"
        >
          {(Object.keys(GRANULARITY_LABEL) as Granularity[]).map((key) => (
            <ToggleButton key={key} value={key} sx={{ px: 2.5 }}>
              {GRANULARITY_LABEL[key]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {summary && (
          <Typography variant="body2" color="text.secondary">
            {summary.periodKey} · {formatTimestamp(summary.periodStart)} ~ {formatTimestamp(summary.periodEnd)}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0,1fr)', sm: 'repeat(3, minmax(0,1fr))' },
          gap: 2,
          mb: 3,
        }}
      >
        <StatCard label="完成任务数" value={String(summary?.completedCount ?? 0)} accent="#2563EB" />
        <StatCard
          label="累计工作用时"
          value={formatDuration(summary?.totalWorkMs ?? 0)}
          accent="#16A34A"
        />
        <StatCard
          label="完成番茄数"
          value={String(summary?.completedPomodoroRounds ?? 0)}
          accent="#EA580C"
        />
      </Box>

      <Typography variant="h6" sx={{ mb: 2 }}>
        工作明细
      </Typography>
      {!summary || summary.items.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">当前周期暂无归档的工作项。</Typography>
        </Paper>
      ) : (
        <List disablePadding>
          {summary.items.map((item) => (
            <SummaryRow key={item.todoId} item={item} />
          ))}
        </List>
      )}
    </Box>
  );
}
