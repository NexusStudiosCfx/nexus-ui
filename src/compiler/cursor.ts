import type { Expression } from './ast';
import type { Reporter } from './diagnostics';
import { findClosing, LexError } from './lexer';

const WHITESPACE = /[ \t\r\n\f]/;

/** A position in the source and the reading primitives the parser is built from. */
export class Cursor {
  index = 0;

  constructor(
    readonly source: string,
    readonly reporter: Reporter,
  ) {}

  get done(): boolean {
    return this.index >= this.source.length;
  }

  peek(text: string): boolean {
    return this.source.startsWith(text, this.index);
  }

  /** Consumes `text` when it is next. */
  eat(text: string): boolean {
    if (!this.peek(text)) return false;
    this.index += text.length;
    return true;
  }

  /** Consumes what `pattern` (a sticky regular expression) matches here and returns it. */
  match(pattern: RegExp): string | null {
    pattern.lastIndex = this.index;
    const found = pattern.exec(this.source);
    if (!found) return null;
    this.index = pattern.lastIndex;
    return found[0];
  }

  skipWhitespace(): void {
    while (!this.done && WHITESPACE.test(this.source[this.index] as string)) this.index++;
  }

  /**
   * Reads an expression that ends at the `}` matching the `{` at `open`, and leaves the cursor
   * after that brace. `from` is where the expression itself starts, after a block keyword.
   */
  expressionUntilBrace(open: number, from: number): Expression {
    const close = this.closing(open);
    const expression = this.expression(from, close);
    this.index = close + 1;
    return expression;
  }

  /** The index of the bracket that closes the one at `open`. */
  closing(open: number): number {
    try {
      return findClosing(this.source, open);
    } catch (error) {
      if (!(error instanceof LexError)) throw error;
      const brace = this.source[open] === '{' && error.start === open;
      return this.reporter.error({
        code: brace ? 'unclosed-expression' : error.code,
        message: brace ? 'This `{` is never closed.' : error.message,
        hint: brace
          ? 'Add the closing `}`. To show a literal brace in text, write `{\'{\'}` or `&#123;`.'
          : 'Check the quotes and brackets of this expression.',
        start: error.start,
        end: error.end,
      });
    }
  }

  /** The trimmed expression between two offsets. An empty one is an error. */
  expression(from: number, to: number): Expression {
    let start = from;
    let end = to;
    while (start < end && WHITESPACE.test(this.source[start] as string)) start++;
    while (end > start && WHITESPACE.test(this.source[end - 1] as string)) end--;
    if (start === end) {
      this.reporter.error({
        code: 'empty-expression',
        message: 'An expression is missing here.',
        hint: 'Write a value between the braces, for example `{count}`.',
        start: from,
        end: Math.max(to, from + 1),
      });
    }
    return { type: 'Expression', start, end, code: this.source.slice(start, end) };
  }
}
