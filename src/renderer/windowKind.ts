/**
 * 渲染层窗口类型识别：三窗口共用同一份 renderer 产物，用 URL query 区分。
 * 刻意不 import electron，保持渲染层零 Node 依赖。
 */

import type { WindowType } from '@shared/types';

/** 读取 ?window=main|pomo|todo，非法或缺省值一律回退到 main。 */
export function detectWindowType(): WindowType {
  const raw = new URLSearchParams(window.location.search).get('window');
  return raw === 'pomo' || raw === 'todo' ? raw : 'main';
}
