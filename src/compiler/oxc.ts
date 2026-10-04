import { parseSync } from 'vite';
import type { Problem } from './diagnostics';
import type { Node } from './erase';

export interface Parsed {
  program: Node;
  /** Offsets are those of the parsed code, not of the file. */
  comments: { type: 'Line' | 'Block'; start: number; end: number }[];
}

interface ParserError {
  message: string;
  helpMessage: string | null;
  labels: { start: number; end: number }[];
}

/**
 * Parses TypeScript with the parser Vite ships. `shift` turns the offsets of `code` into
 * offsets of the file, so a syntax error points into the .nexus source. `last` is the last file
 * offset an error may point at, for code that was wrapped before it was parsed.
 */
export function parseTypeScript(code: string, shift: number, problemCode: string, fail: (problem: Problem) => never, last = Infinity): Parsed {
  const result = parseSync('component.ts', code, { lang: 'ts', sourceType: 'module' });
  const error = (result.errors as ParserError[])[0];
  if (error) {
    const label = error.labels[0];
    const start = Math.min(last, Math.max(shift, (label ? label.start : 0) + shift));
    const end = Math.min(last + 1, Math.max(start + 1, (label ? label.end : code.length) + shift));
    const problem: Problem = {
      code: problemCode,
      message: error.message.endsWith('.') ? error.message : `${error.message}.`,
      start,
      end,
    };
    if (error.helpMessage) problem.hint = error.helpMessage;
    fail(problem);
  }
  return { program: result.program as unknown as Node, comments: result.comments };
}
