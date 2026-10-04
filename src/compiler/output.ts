import MagicString, { Bundle, type SourceMap } from 'magic-string';
import type { Span } from './ast';

/** A piece of the source file that is copied into the output, and mapped back to where it was. */
export interface Mapped extends Span {
  mapped: true;
  /** Indents the lines of the piece, except inside `keep`: the lines of a template literal are data. */
  indent?: { by: string; keep: Span[] };
}

export type Chunk = string | Mapped;

/** Generated code: text written by the compiler, interleaved with pieces of the source. */
export type Code = Chunk[];

type Value = string | number | Mapped | Code | null | undefined | false;

export function mapped(span: Span): Mapped {
  return { mapped: true, start: span.start, end: span.end };
}

/**
 * Builds code from a template string. Interpolated strings and numbers are emitted as written,
 * `Mapped` values and other code are spliced in, and nothing is emitted for null or false.
 */
export function js(strings: TemplateStringsArray, ...values: Value[]): Code {
  const code: Code = [];
  strings.forEach((text, index) => {
    if (text) code.push(text);
    const value = values[index];
    if (value == null || value === false) return;
    if (Array.isArray(value)) code.push(...value);
    else if (typeof value === 'object') code.push(value);
    else code.push(String(value));
  });
  return code;
}

export function join(parts: Code[], separator: string): Code {
  const code: Code = [];
  parts.forEach((part, index) => {
    if (index) code.push(separator);
    code.push(...part);
  });
  return code;
}

/** Indents every generated line. Source pieces keep their own line breaks untouched. */
export function indent(code: Code, by = '  '): Code {
  const out: Code = [];
  let lineStart = true;
  for (const chunk of code) {
    if (typeof chunk !== 'string') {
      if (lineStart) out.push(by);
      lineStart = false;
      out.push(chunk);
      continue;
    }
    let text = '';
    for (const char of chunk) {
      if (lineStart && char !== '\n') text += by;
      text += char;
      lineStart = char === '\n';
    }
    out.push(text);
  }
  return out;
}

export interface Rendered {
  code: string;
  map: SourceMap;
}

/**
 * Turns code into text and a source map. `source` holds the edits made to the original file
 * (removed type annotations), which the copied pieces inherit.
 */
export function render(code: Code, source: MagicString, filename: string): Rendered {
  const bundle = new Bundle({ separator: '' });
  let text = '';
  const flush = (): void => {
    if (text) bundle.addSource({ content: new MagicString(text) });
    text = '';
  };
  for (const chunk of code) {
    if (typeof chunk === 'string') {
      text += chunk;
    } else if (chunk.end > chunk.start) {
      flush();
      const piece = source.snip(chunk.start, chunk.end);
      if (chunk.indent) piece.indent(chunk.indent.by, { exclude: chunk.indent.keep.map((span) => [span.start, span.end]) });
      bundle.addSource({ filename, content: piece });
    }
  }
  flush();
  return {
    code: bundle.toString(),
    map: bundle.generateMap({ hires: 'boundary', includeContent: true }),
  };
}
