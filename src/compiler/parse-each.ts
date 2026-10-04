import type { EachBlock } from './ast';
import type { Cursor } from './cursor';
import { lex } from './lexer';

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

type Header = Pick<EachBlock, 'expression' | 'item' | 'index' | 'key'>;

/**
 * Parses what is between `{#each` and its `}`: `list as item`, `list as item, index` and
 * `list as item, index (key)`. `from` and `to` are the offsets of that text.
 */
export function parseEachHeader(cursor: Cursor, from: number, to: number): Header {
  const { source, reporter } = cursor;

  const malformed = (start: number, end: number, message: string): never =>
    reporter.error({
      code: 'malformed-each',
      message,
      hint: 'Write `{#each list as item}`, `{#each list as item, index}` or `{#each list as item (item.id)}`.',
      start,
      end,
    });

  // The list may itself contain `as` (a TypeScript cast), so the binding starts at the last one
  // that is not inside brackets.
  let depth = 0;
  let as = -1;
  for (const token of lex(source, from, to)) {
    const text = source.slice(token.start, token.end);
    if (token.type === 'punct') {
      if (text === '(' || text === '[' || text === '{' || text === '${') depth++;
      else if (text === ')' || text === ']' || text === '}') depth--;
    } else if (token.type === 'word' && text === 'as' && depth === 0) {
      as = token.start;
    }
  }
  if (as === -1) malformed(from - 6, to + 1, '`{#each}` needs a name for the item.');

  const expression = cursor.expression(from, as);

  cursor.index = as + 2;
  cursor.skipWhitespace();
  const itemStart = cursor.index;
  const opener = source[itemStart];
  if (opener === '{' || opener === '[') cursor.index = cursor.closing(itemStart) + 1;
  else if (!cursor.match(IDENTIFIER)) malformed(itemStart, Math.max(itemStart + 1, to), 'A name for the item is expected after `as`.');
  const item = cursor.expression(itemStart, cursor.index);

  let index: Header['index'] = null;
  cursor.skipWhitespace();
  if (cursor.eat(',')) {
    cursor.skipWhitespace();
    const start = cursor.index;
    const name = cursor.match(IDENTIFIER);
    if (!name) return malformed(start, Math.max(start + 1, to), 'A name for the index is expected after the comma.');
    index = { name, start, end: cursor.index };
    cursor.skipWhitespace();
  }

  let key: Header['key'] = null;
  if (cursor.index < to && source[cursor.index] === '(') {
    const open = cursor.index;
    const close = cursor.closing(open);
    key = cursor.expression(open + 1, close);
    cursor.index = close + 1;
    cursor.skipWhitespace();
  }

  if (cursor.index !== to) malformed(cursor.index, to, 'This part of the `{#each}` is not understood.');
  return { expression, item, index, key };
}
