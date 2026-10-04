import type { ExpressionTag, Span, TemplateNode, Text } from './ast';

/** Adjacent text and `{expressions}`: one text node in the document. */
export interface Run extends Span {
  type: 'Run';
  parts: (string | ExpressionTag)[];
}

export type Item = Exclude<TemplateNode, Text | ExpressionTag> | Run;

const SPACE = /[ \t\r\n\f]+/g;
const LEADING = /^[ \t\r\n\f]+/;
const TRAILING = /[ \t\r\n\f]+$/;

/**
 * Applies the whitespace rules and merges text with the expressions next to it:
 *
 * - a run of whitespace becomes one space;
 * - whitespace at the start and end of an element or block is removed;
 * - whitespace between two tags or blocks is removed when it contains a line break.
 *
 * With `preserve` (inside `<pre>` and `<textarea>`) text is kept exactly as written.
 */
export function normalize(nodes: TemplateNode[], preserve: boolean): Item[] {
  const items: Item[] = [];
  let run: Run | null = null;
  let raw = '';

  const close = (last: boolean): void => {
    if (!run) return;
    const current = run;
    const first = !items.length;
    run = null;

    if (!preserve) {
      const blank = current.parts.every((part) => typeof part === 'string' && !part.replace(SPACE, ''));
      if (blank && (first || last || raw.includes('\n'))) return;
      current.parts = current.parts.map((part) => (typeof part === 'string' ? part.replace(SPACE, ' ') : part));
      const head = current.parts[0];
      if (first && typeof head === 'string') current.parts[0] = head.replace(LEADING, '');
      const tail = current.parts[current.parts.length - 1];
      if (last && typeof tail === 'string') current.parts[current.parts.length - 1] = tail.replace(TRAILING, '');
      current.parts = current.parts.filter((part) => part !== '');
    }
    if (current.parts.length) items.push(current);
  };

  for (const node of nodes) {
    if (node.type === 'Text' || node.type === 'ExpressionTag') {
      if (!run) {
        run = { type: 'Run', start: node.start, end: node.end, parts: [] };
        raw = '';
      }
      run.end = node.end;
      if (node.type === 'Text') {
        // Two texts are adjacent where a comment was removed between them.
        const previous = run.parts[run.parts.length - 1];
        if (typeof previous === 'string') run.parts[run.parts.length - 1] = previous + node.data;
        else run.parts.push(node.data);
        raw += node.data;
      } else {
        run.parts.push(node);
      }
    } else {
      close(false);
      items.push(node);
    }
  }
  close(true);
  return items;
}
