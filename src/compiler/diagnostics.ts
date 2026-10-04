export type Severity = 'error' | 'warning';

export interface Diagnostic {
  /** Stable identifier, for example `unclosed-tag`. */
  code: string;
  /**
   * A warning with severity `error` does not stop compilation, but the output must not ship:
   * `nexus check` and `nexus build` fail on it.
   */
  severity: Severity;
  message: string;
  /** What to write instead. */
  hint?: string;
  filename: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Offsets into the source. */
  start: number;
  end: number;
  /** The lines around the position, with a marker under the range. */
  frame: string;
}

export interface Problem {
  code: string;
  message: string;
  hint?: string;
  start: number;
  end?: number;
}

export interface Position {
  line: number;
  column: number;
}

export function locate(source: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
    line++;
    lineStart = index + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

const CONTEXT = 2;

/** A few lines of source around a range, with a marker under the range on its first line. */
export function codeFrame(source: string, start: number, end: number = start): string {
  const lines = source.split('\n');
  const { line, column } = locate(source, start);
  const first = Math.max(1, line - CONTEXT);
  const last = Math.min(lines.length, line + CONTEXT);
  const width = String(last).length;
  const out: string[] = [];
  for (let number = first; number <= last; number++) {
    // Tabs would push the marker out of place in most terminals.
    const text = (lines[number - 1] as string).replace(/\r$/, '').replace(/\t/g, '  ');
    out.push(`${number === line ? '>' : ' '} ${String(number).padStart(width)} | ${text}`.trimEnd());
    if (number === line) {
      const raw = (lines[number - 1] as string).replace(/\r$/, '');
      const lead = raw.slice(0, column - 1).replace(/\t/g, '  ').length;
      const span = Math.max(1, Math.min(end - start, raw.length - (column - 1)));
      out.push(`  ${' '.repeat(width)} | ${' '.repeat(lead)}${'^'.repeat(span)}`);
    }
  }
  return out.join('\n');
}

export function toDiagnostic(source: string, filename: string, severity: Severity, problem: Problem): Diagnostic {
  const start = Math.max(0, Math.min(problem.start, source.length));
  const end = Math.max(start, Math.min(problem.end ?? start, source.length));
  const { line, column } = locate(source, start);
  const diagnostic: Diagnostic = {
    code: problem.code,
    severity,
    message: problem.message,
    filename,
    line,
    column,
    start,
    end,
    frame: codeFrame(source, start, end),
  };
  if (problem.hint) diagnostic.hint = problem.hint;
  return diagnostic;
}

/** The text a terminal shows for a diagnostic: position, message, code frame and hint. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { filename, line, column, message, code, frame, hint } = diagnostic;
  return `${filename}:${line}:${column}: ${message} (${code})\n\n${frame}\n${hint ? `\n${hint}\n` : ''}`;
}

/**
 * Thrown by `compile` and `parse` when the file cannot be compiled. `message` is the formatted
 * text; `diagnostic` has the same information as data.
 */
export class CompileError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(formatDiagnostic(diagnostic));
    this.name = 'CompileError';
    this.diagnostic = diagnostic;
  }
}

/** Collects the diagnostics of one compilation. */
export class Reporter {
  readonly warnings: Diagnostic[] = [];

  constructor(
    readonly source: string,
    readonly filename: string,
  ) {}

  /** Stops compilation. */
  error(problem: Problem): never {
    throw new CompileError(toDiagnostic(this.source, this.filename, 'error', problem));
  }

  /** Something that works but is probably not what the author meant. */
  warn(problem: Problem): void {
    this.warnings.push(toDiagnostic(this.source, this.filename, 'warning', problem));
  }

  /** Something that compiles but cannot ship, such as CSS that Chromium 103 ignores. */
  reject(problem: Problem): void {
    this.warnings.push(toDiagnostic(this.source, this.filename, 'error', problem));
  }
}
