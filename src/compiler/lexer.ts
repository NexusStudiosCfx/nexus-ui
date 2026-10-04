/**
 * A small JavaScript lexer. The compiler does not parse expressions itself, but it has to know
 * where one ends: a `}` inside a string, a template literal, a comment or a regular expression
 * does not close `{expression}`.
 */

import { locate } from './diagnostics';

export type JsTokenType = 'string' | 'template' | 'comment' | 'regex' | 'word' | 'number' | 'punct';

export interface JsToken {
  type: JsTokenType;
  start: number;
  end: number;
}

export class LexError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

// After one of these words a `/` starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const WORD = /[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/y;
const NUMBER = /\d[\w.]*/y;
const SPACE = /\s+/y;

function matchAt(pattern: RegExp, source: string, index: number): number {
  pattern.lastIndex = index;
  return pattern.test(source) ? pattern.lastIndex : -1;
}

function endOfString(source: string, start: number, limit: number): number {
  const quote = source[start];
  for (let index = start + 1; index < limit; index++) {
    const char = source[index];
    if (char === '\\') index++;
    else if (char === quote) return index + 1;
    else if (char === '\n') break;
  }
  throw new LexError('unclosed-string', 'This string is never closed.', start, start + 1);
}

/** The end of a regular expression starting at `start`, or -1 when the `/` is a division. */
function endOfRegex(source: string, start: number, limit: number): number {
  let inClass = false;
  for (let index = start + 1; index < limit; index++) {
    const char = source[index];
    if (char === '\\') index++;
    else if (char === '\n') return -1;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      const flags = matchAt(/[a-z]*/y, source, index + 1);
      return flags;
    }
  }
  return -1;
}

export function* lex(source: string, start = 0, limit = source.length): Generator<JsToken> {
  // One entry per open `{`: true when it is the `${` of a template literal.
  const braces: boolean[] = [];
  const templates: number[] = [];
  let regexAllowed = true;
  let index = start;

  // Scans template text from `from` up to the next `${` or the closing backtick.
  function* quasi(from: number): Generator<JsToken> {
    for (let at = from; at < limit; at++) {
      const char = source[at];
      if (char === '\\') {
        at++;
      } else if (char === '`') {
        templates.pop();
        if (at > from) yield { type: 'template', start: from, end: at };
        yield { type: 'punct', start: at, end: at + 1 };
        index = at + 1;
        regexAllowed = false;
        return;
      } else if (char === '$' && source[at + 1] === '{') {
        if (at > from) yield { type: 'template', start: from, end: at };
        yield { type: 'punct', start: at, end: at + 2 };
        braces.push(true);
        index = at + 2;
        regexAllowed = true;
        return;
      }
    }
    const opened = templates[templates.length - 1] as number;
    throw new LexError('unclosed-template', 'This template literal is never closed.', opened, opened + 1);
  }

  while (index < limit) {
    const char = source[index] as string;
    const next = source[index + 1];

    const space = matchAt(SPACE, source, index);
    if (space !== -1) {
      index = space;
      continue;
    }

    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', index);
      const end = newline === -1 || newline > limit ? limit : newline;
      yield { type: 'comment', start: index, end };
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close === -1 || close + 2 > limit) {
        throw new LexError('unclosed-comment', 'This comment is never closed.', index, index + 2);
      }
      yield { type: 'comment', start: index, end: close + 2 };
      index = close + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = endOfString(source, index, limit);
      yield { type: 'string', start: index, end };
      index = end;
      regexAllowed = false;
      continue;
    }

    if (char === '`') {
      templates.push(index);
      yield { type: 'punct', start: index, end: index + 1 };
      yield* quasi(index + 1);
      continue;
    }

    if (char === '/' && regexAllowed) {
      const end = endOfRegex(source, index, limit);
      if (end !== -1) {
        yield { type: 'regex', start: index, end };
        index = end;
        regexAllowed = false;
        continue;
      }
    }

    const word = matchAt(WORD, source, index);
    if (word !== -1) {
      yield { type: 'word', start: index, end: word };
      regexAllowed = REGEX_AFTER_WORD.has(source.slice(index, word));
      index = word;
      continue;
    }

    const number = matchAt(NUMBER, source, index);
    if (number !== -1) {
      yield { type: 'number', start: index, end: number };
      index = number;
      regexAllowed = false;
      continue;
    }

    if (char === '{') braces.push(false);
    if (char === '}' && braces.pop()) {
      yield { type: 'punct', start: index, end: index + 1 };
      yield* quasi(index + 1);
      continue;
    }

    yield { type: 'punct', start: index, end: index + 1 };
    regexAllowed = char !== ')' && char !== ']' && char !== '}';
    index++;
  }
}

const CLOSING: Record<string, string> = { '(': ')', '[': ']', '{': '}', '${': '}' };

/**
 * The index of the bracket that closes the one at `open`, skipping everything a bracket can hide
 * in. Throws a `LexError` when there is none.
 */
export function findClosing(source: string, open: number): number {
  const stack: JsToken[] = [{ type: 'punct', start: open, end: open + 1 }];
  for (const token of lex(source, open + 1)) {
    if (token.type !== 'punct') continue;
    const text = source.slice(token.start, token.end);
    if (text in CLOSING) {
      stack.push(token);
    } else if (text === ')' || text === ']' || text === '}') {
      const opener = stack.pop() as JsToken;
      const expected = CLOSING[source.slice(opener.start, opener.end)];
      if (text !== expected) {
        throw new LexError(
          'unbalanced-bracket',
          `Expected \`${expected}\` to close the \`${source.slice(opener.start, opener.end)}\` on line ${locate(source, opener.start).line}, but found \`${text}\`.`,
          token.start,
          token.end,
        );
      }
      if (!stack.length) return token.start;
    }
  }
  const opener = stack[stack.length - 1] as JsToken;
  throw new LexError(
    'unclosed-bracket',
    `This \`${source.slice(opener.start, opener.end)}\` is never closed.`,
    opener.start,
    opener.end,
  );
}


/**
 * The same text with the content of strings, comments, template text and regular expressions
 * replaced by spaces. Offsets stay the same, so a pattern found in the result is real code.
 */
export function maskCode(source: string): string {
  let out = '';
  let last = 0;
  try {
    for (const token of lex(source)) {
      if (token.type === 'string' || token.type === 'comment' || token.type === 'template' || token.type === 'regex') {
        out += source.slice(last, token.start) + source.slice(token.start, token.end).replace(/[^\n]/g, ' ');
        last = token.end;
      }
    }
  } catch {
    // Text that does not lex is reported by whoever parses it; what was masked so far still helps.
  }
  return out + source.slice(last);
}
