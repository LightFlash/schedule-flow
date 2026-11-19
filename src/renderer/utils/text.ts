/**
 * 文本展示工具：把富文本备注（HTML）转成可安全展示的纯文本预览。
 * 只用于渲染层展示，不修改持久化数据。
 */

const LINE_BREAK_TAGS = /<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi;
const ANY_TAG = /<[^>]*>/g;
const ENTITY_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;|&#160;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
];

/**
 * 去掉 HTML 标签、还原常见实体并压缩多余空白，保留段落换行。
 * 传入纯文本时原样返回（兼容历史备注数据）。
 */
export function stripHtml(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  let text = html.replace(LINE_BREAK_TAGS, '\n').replace(ANY_TAG, '');
  for (const [pattern, replacement] of ENTITY_MAP) {
    text = text.replace(pattern, replacement);
  }
  return text
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
