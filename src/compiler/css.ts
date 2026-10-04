import type { Span } from './ast';

/** `selector { ... }` or `@name prelude { ... }`. */
export interface CssBlock {
  type: 'block';
  /** The at-rule name without the `@`, lower case; null for a style rule. */
  at: string | null;
  /** The selector, or what follows the at-rule name. */
  prelude: Span;
  /** What is between the braces. */
  body: Span;
  children: CssNode[];
  start: number;
  end: number;
}

/** `property: value` or an at-rule without a block (`@import ...;`). */
export interface CssStatement {
  type: 'statement';
  at: string | null;
  /** Null when the statement is not a declaration. */
  property: (Span & { name: string }) | null;
  value: Span;
  start: number;
  end: number;
}

export type CssNode = CssBlock | CssStatement;

export class CssError extends Error {
  constructor(
    message: string,
    readonly start: number,
  ) {
    super(message);
  }
}

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The offset after a comment or string that starts at `index`, or `index` when neither does. */
function skipOpaque(source: string, index: number, limit: number): number {
  const char = source[index];
  if (char === '/' && source[index + 1] === '*') {
    const close = source.indexOf('*/', index + 2);
    if (close === -1 || close + 2 > limit) throw new CssError('This comment is never closed.', index);
    return close + 2;
  }
  if (char === '"' || char === "'") {
    for (let at = index + 1; at < limit; at++) {
      if (source[at] === '\\') at++;
      else if (source[at] === char) return at + 1;
      else if (source[at] === '\n') break;
    }
    throw new CssError('This string is never closed.', index);
  }
  return index;
}

/** The index of the bracket that closes the one at `open`. */
export function closingBracket(source: string, open: number, limit: number): number {
  const closer = CLOSERS[source[open] as string] as string;
  for (let index = open + 1; index < limit; ) {
    const after = skipOpaque(source, index, limit);
    if (after !== index) {
      index = after;
      continue;
    }
    const char = source[index] as string;
    if (char === '\\') index += 2;
    else if (char === closer) return index;
    else if (char in CLOSERS) index = closingBracket(source, index, limit) + 1;
    else index++;
  }
  throw new CssError(`This \`${source[open]}\` is never closed.`, open);
}

function trim(source: string, start: number, end: number): Span {
  while (start < end && /\s/.test(source[start] as string)) start++;
  while (end > start && /\s/.test(source[end - 1] as string)) end--;
  return { start, end };
}

/** Parses the CSS between two offsets of `source` into rules, at-rules and declarations. */
export function parseCss(source: string, from: number, to: number): CssNode[] {
  const nodes: CssNode[] = [];
  let index = from;

  while (index < to) {
    const after = skipOpaque(source, index, to);
    if (after !== index && source[index] === '/') {
      index = after;
      continue;
    }
    if (/\s/.test(source[index] as string) || source[index] === ';') {
      index++;
      continue;
    }

    // One item: up to a `;`, or to the end of the `{...}` block that follows its prelude.
    const start = index;
    let brace = -1;
    while (index < to) {
      const skipped = skipOpaque(source, index, to);
      if (skipped !== index) {
        index = skipped;
        continue;
      }
      const char = source[index] as string;
      if (char === '\\') index += 2;
      else if (char === ';') break;
      else if (char === '{') {
        brace = index;
        break;
      } else if (char === '}') throw new CssError('This `}` closes nothing.', index);
      else if (char === '(' || char === '[') index = closingBracket(source, index, to) + 1;
      else index++;
    }

    const name = /^@([\w-]+)/.exec(source.slice(start, Math.min(index, start + 40)));
    const at = name ? (name[1] as string).toLowerCase() : null;
    const head = start + (name ? name[0].length : 0);

    if (brace !== -1) {
      const close = closingBracket(source, brace, to);
      nodes.push({
        type: 'block',
        at,
        prelude: trim(source, head, brace),
        body: { start: brace + 1, end: close },
        children: parseCss(source, brace + 1, close),
        start,
        end: close + 1,
      });
      index = close + 1;
    } else {
      const { end } = trim(source, start, index);
      const colon = at ? -1 : source.slice(start, end).indexOf(':');
      const property = colon === -1 ? null : { ...trim(source, start, start + colon), name: source.slice(start, start + colon).trim().toLowerCase() };
      nodes.push({ type: 'statement', at, property, value: trim(source, colon === -1 ? head : start + colon + 1, end), start, end });
      index++;
    }
  }
  return nodes;
}
