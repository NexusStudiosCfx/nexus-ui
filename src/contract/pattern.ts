import { ContractError } from './errors';

/**
 * One step of a pattern: between `min` and `max` characters, each inside one of `ranges`
 * (inclusive character codes). A `max` of null means no upper limit.
 */
export interface PatternItem {
  readonly ranges: readonly (readonly [number, number])[];
  readonly min: number;
  readonly max: number | null;
}

/**
 * A string pattern in both of its forms: `source` runs as a JavaScript regular expression,
 * `items` is the same language written so the generated Lua can match it in linear time.
 */
export interface Pattern {
  readonly source: string;
  readonly items: readonly PatternItem[];
}

const MAX_ITEMS = 32;

const DIGIT: readonly [number, number][] = [[48, 57]];
const WORD: readonly [number, number][] = [[48, 57], [65, 90], [95, 95], [97, 122]];

const SYNTAX = '\\^$.|?*+()[]{}';

function isAlphanumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * Parses the subset of regular expressions that the bridge can enforce identically in
 * JavaScript and in Lua: an anchored sequence of ASCII characters and positive character
 * classes, each with an optional quantifier.
 *
 * Everything outside the subset is refused here rather than approximated, because a pattern
 * that means one thing in the browser and another on the server is worse than no pattern.
 */
export function compilePattern(input: RegExp | string): Pattern {
  const source = typeof input === 'string' ? input : input.source;
  const fail = (reason: string): never => {
    throw new ContractError(`s.string pattern /${source}/: ${reason}`);
  };

  if (typeof input !== 'string' && input.flags !== '') {
    fail(`flags are not supported (found "${input.flags}"). List both cases in a class instead, for example [A-Za-z].`);
  }
  if (source.length < 2 || !source.startsWith('^') || !source.endsWith('$')) {
    fail('the pattern must start with ^ and end with $, so that it describes the whole string');
  }

  const body = source.slice(1, -1);
  const items: PatternItem[] = [];
  let at = 0;

  const escaped = (inClass: boolean): [number, number][] => {
    const char = body[at + 1];
    if (char === undefined) return fail('the final $ is escaped, so nothing anchors the end of the pattern');
    at += 2;
    if (char === 'd') return [...DIGIT];
    if (char === 'w') return [...WORD];
    const code = char.charCodeAt(0);
    if (isAlphanumeric(code)) {
      return fail(
        `\\${char} is not supported. Only \\d and \\w are, plus a backslash before punctuation` +
          (inClass ? '.' : '; spell other sets out as a class such as [a-z ].'),
      );
    }
    if (code < 32 || code > 126) return fail('only ASCII characters can be matched');
    return [[code, code]];
  };

  const literal = (): number => {
    const code = body.charCodeAt(at);
    if (code < 32 || code > 126) {
      return fail(
        'only ASCII characters can be matched, because Lua patterns work on bytes. ' +
          'Use min and max alone for free text.',
      );
    }
    at += 1;
    return code;
  };

  const charClass = (): [number, number][] => {
    at += 1;
    if (body[at] === '^') return fail('negated classes such as [^a] are not supported. List the allowed characters.');
    const ranges: [number, number][] = [];
    for (;;) {
      const char = body[at];
      if (char === undefined) return fail('a [ is never closed');
      if (char === ']') {
        at += 1;
        break;
      }
      if (char === '\\') {
        ranges.push(...escaped(true));
        continue;
      }
      const from = literal();
      if (body[at] === '-' && body[at + 1] !== undefined && body[at + 1] !== ']') {
        at += 1;
        if (body[at] === '\\') return fail('a range must end with a letter or a digit');
        const to = literal();
        if (!isAlphanumeric(from) || !isAlphanumeric(to)) {
          return fail('a range must run between letters or digits, for example a-z or 0-9');
        }
        if (from > to) return fail(`the range ${String.fromCharCode(from)}-${String.fromCharCode(to)} is backwards`);
        ranges.push([from, to]);
      } else {
        ranges.push([from, from]);
      }
    }
    if (ranges.length === 0) return fail('an empty class [] can never match');
    return ranges;
  };

  const quantifier = (): [number, number | null] => {
    const char = body[at];
    let bounds: [number, number | null];
    if (char === '?') bounds = [0, 1];
    else if (char === '*') bounds = [0, null];
    else if (char === '+') bounds = [1, null];
    else if (char === '{') {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(body.slice(at));
      if (!match) return fail('a { must be a quantifier such as {2}, {1,8} or {3,}. Write \\{ for a literal brace.');
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[3] === '' ? null : Number(match[3]);
      if (!Number.isSafeInteger(min) || (max !== null && !Number.isSafeInteger(max))) {
        return fail(`the quantifier ${match[0]} is out of range`);
      }
      if (max !== null && min > max) return fail(`the quantifier ${match[0]} is backwards`);
      at += match[0].length - 1;
      bounds = [min, max];
    } else {
      return [1, 1];
    }
    at += 1;
    if (body[at] === '?' || body[at] === '+') {
      return fail('lazy and possessive quantifiers are not supported, and change nothing when the whole string must match');
    }
    return bounds;
  };

  while (at < body.length) {
    const char = body[at] as string;
    let ranges: [number, number][];
    if (char === '\\') ranges = escaped(false);
    else if (char === '[') ranges = charClass();
    else if (char === '.') {
      return fail('"." is not supported, because it would match bytes in Lua and characters in JavaScript. Use a class such as [a-z0-9 ].');
    } else if (char === '(' || char === ')' || char === '|') {
      return fail('groups and alternatives are not supported. For a fixed list of values use s.enum.');
    } else if (char === '^' || char === '$') {
      return fail(`"${char}" is only allowed as the anchor at the ${char === '^' ? 'start' : 'end'}`);
    } else if (SYNTAX.includes(char)) {
      return fail(`unexpected "${char}". Write \\${char} to match it literally.`);
    } else {
      const code = literal();
      ranges = [[code, code]];
    }
    const [min, max] = quantifier();
    items.push({ ranges: merge(ranges), min, max });
    if (items.length > MAX_ITEMS) return fail(`the pattern has more than ${MAX_ITEMS} parts`);
  }

  return Object.freeze({ source, items: Object.freeze(items) });
}
