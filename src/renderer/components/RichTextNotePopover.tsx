/**
 * 备注锚定浮层：贴在备注按钮旁展开，带指向箭头，靠近底部自动翻到上方。
 * 编辑器使用 contenteditable + document.execCommand，零依赖实现富文本。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Box, Button, IconButton, Portal, Stack, Tooltip, Typography } from '@mui/material';
import type { Todo } from '@shared/types';
import { useAppStore } from '../store/useAppStore';
import LucideIcon from './LucideIcon';

interface RichTextNotePopoverProps {
  todo: Todo;
  anchorEl: HTMLElement;
  onClose: () => void;
}

interface Position {
  top: number;
  left: number;
  width: number;
  arrowLeft: number;
  above: boolean;
  ready: boolean;
}

interface ToolCommand {
  key: string;
  command: string;
  value?: string;
  title: string;
  content: ReactNode;
}

const TOOL_COMMANDS: ToolCommand[] = [
  { key: 'bold', command: 'bold', title: '加粗', content: <b>B</b> },
  { key: 'italic', command: 'italic', title: '斜体', content: <i>I</i> },
  { key: 'underline', command: 'underline', title: '下划线', content: <u>U</u> },
  { key: 'ul', command: 'insertUnorderedList', title: '无序列表', content: '≡' },
  { key: 'ol', command: 'insertOrderedList', title: '有序列表', content: '1.' },
  { key: 'h3', command: 'formatBlock', value: 'H3', title: '小标题', content: 'H' },
  { key: 'clear', command: 'removeFormat', title: '清除格式', content: '⌫' },
];

const POPOVER_WIDTH = 340;
const GAP = 9;
const EDGE_MARGIN = 8;

export default function RichTextNotePopover({
  todo,
  anchorEl,
  onClose,
}: RichTextNotePopoverProps): ReactElement {
  const updateTodo = useAppStore((state) => state.updateTodo);
  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({
    top: 0,
    left: 0,
    width: POPOVER_WIDTH,
    arrowLeft: 30,
    above: false,
    ready: false,
  });

  // 先渲染（隐藏）以获得真实高度，再按锚点计算位置。
  useLayoutEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - EDGE_MARGIN * 2);
    const height = popoverRef.current?.offsetHeight ?? 280;
    const rawLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(EDGE_MARGIN, Math.min(rawLeft, window.innerWidth - width - EDGE_MARGIN));
    const arrowLeft = Math.max(
      16,
      Math.min(rect.left + rect.width / 2 - left, width - 16),
    );
    let top = rect.bottom + GAP;
    let above = false;
    if (top + height > window.innerHeight - EDGE_MARGIN && rect.top - height - GAP > EDGE_MARGIN) {
      top = rect.top - height - GAP;
      above = true;
    }
    setPosition({ top, left, width, arrowLeft, above, ready: true });
  }, [anchorEl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const applyCommand = (item: ToolCommand): void => {
    // mousedown 时阻止默认行为，避免编辑器失焦导致选区丢失。
    editorRef.current?.focus();
    document.execCommand(item.command, false, item.value);
  };

  const handleSave = (): void => {
    const html = editorRef.current?.innerHTML.trim() ?? '';
    void updateTodo(todo.id, { notes: html });
    onClose();
  };

  return (
    <Portal>
      <Box
        onClick={onClose}
        sx={{ position: 'fixed', inset: 0, zIndex: 1299, bgcolor: 'rgba(15,23,42,0.28)' }}
      />
      <Box
        ref={popoverRef}
        role="dialog"
        aria-label="备注 / 心得"
        onClick={(event) => event.stopPropagation()}
        sx={{
          position: 'fixed',
          zIndex: 1300,
          top: position.top,
          left: position.left,
          width: position.width,
          maxWidth: `calc(100vw - ${EDGE_MARGIN * 2}px)`,
          visibility: position.ready ? 'visible' : 'hidden',
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 2,
          boxShadow: '0 14px 40px rgba(15,23,42,0.22)',
          transformOrigin: position.above ? 'bottom center' : 'top center',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            ...(position.above ? { bottom: -7 } : { top: -7 }),
            left: position.arrowLeft,
            width: 12,
            height: 12,
            bgcolor: 'background.paper',
            transform: 'translateX(-50%) rotate(45deg)',
            borderLeft: '1px solid',
            borderTop: '1px solid',
            borderColor: 'divider',
            ...(position.above
              ? { borderLeft: 0, borderTop: 0, borderRight: '1px solid', borderBottom: '1px solid' }
              : {}),
          }}
        />
        <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.75, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
          <LucideIcon name="note" size={16} />
          <Typography variant="subtitle2" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
            备注 / 心得
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {todo.title}
          </Typography>
          <Tooltip title="关闭">
            <IconButton size="small" onClick={onClose} aria-label="关闭备注浮层">
              <LucideIcon name="x" size={16} />
            </IconButton>
          </Tooltip>
        </Stack>

        <Stack
          direction="row"
          spacing={0.25}
          sx={{ m: '10px 12px 0', p: 0.5, border: '1px solid', borderColor: 'divider', borderRadius: 1.5, bgcolor: '#F8FAFC', flexWrap: 'wrap' }}
        >
          {TOOL_COMMANDS.map((item, index) => (
            <Box key={item.key} sx={{ display: 'flex', alignItems: 'center' }}>
              {index === 3 || index === 5 ? (
                <Box sx={{ width: 1, height: 16, bgcolor: 'divider', mx: 0.375 }} />
              ) : null}
              <Tooltip title={item.title}>
                <Box
                  component="button"
                  type="button"
                  aria-label={item.title}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyCommand(item);
                  }}
                  sx={{
                    minWidth: 27,
                    height: 26,
                    px: 0.75,
                    border: 0,
                    borderRadius: 1,
                    bgcolor: 'transparent',
                    color: 'text.secondary',
                    fontSize: 12,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    '&:hover': { bgcolor: '#E2E8F0', color: 'text.primary' },
                  }}
                >
                  {item.content}
                </Box>
              </Tooltip>
            </Box>
          ))}
        </Stack>

        <Box
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label="富文本备注编辑区"
          data-placeholder="记录工作方法、问题与心得，支持加粗 / 列表等格式…"
          dangerouslySetInnerHTML={{ __html: todo.notes || '' }}
          onPaste={(event) => {
            event.preventDefault();
            const plain = event.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, plain);
          }}
          sx={{
            minHeight: 96,
            maxHeight: 220,
            overflowY: 'auto',
            m: '8px 12px',
            p: '9px 11px',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1.5,
            bgcolor: '#FCFDFE',
            fontSize: 13,
            lineHeight: 1.7,
            outline: 'none',
            '&:focus': { borderColor: 'primary.light', boxShadow: '0 0 0 3px rgba(37,99,235,0.08)' },
            '&:empty:before': { content: 'attr(data-placeholder)', color: '#94A3B8' },
            '& ul, & ol': { margin: '4px 0', pl: 2.5 },
          }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mx: 1.5, mb: 0.5, fontSize: 10 }}>
          支持富文本：选中文字后点上方工具栏设置格式
        </Typography>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ px: 1.5, pb: 1.5, pt: 0.5 }}>
          <Button size="small" color="inherit" onClick={onClose}>
            取消
          </Button>
          <Button size="small" variant="contained" onClick={handleSave}>
            保存
          </Button>
        </Stack>
      </Box>
    </Portal>
  );
}
