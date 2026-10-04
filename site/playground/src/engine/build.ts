import MagicString from 'magic-string';
import { CompileError, Reporter, locate, toDiagnostic, type Diagnostic } from '../../../../src/compiler/diagnostics';
import { eraseTypes } from '../../../../src/compiler/erase';
import { compile, type ScreenDeclaration } from '../../../../src/compiler/index';
import { link, type ImportSite } from './link';
import { parseSync } from './parser';
import { ENTRY, kindOf, ordered, resolveImport, type Files } from './project';
import { offsetOf, step, trace, type Step } from './trace';

/** Something wrong with a file, or with the running preview, in the terms the visitor wrote it. */
export interface Problem {
  severity: 'error' | 'warning';
  file: string;
  message: string;
  /** What to write instead. */
  hint?: string;
  /** The identifier of a compiler diagnostic, for example `unclosed-tag`. */
  code?: string;
  /** 1-based. */
  line?: number;
  column?: number;
  /** Offsets into the file. */
  start?: number;
  end?: number;
  /** The lines around the position. */
  frame?: string;
}

export interface Module {
  /** The body of the function the frame runs for this file. */
  code: string;
  /** The rewrites between the file and `code`, in order, to trace an error back through. */
  steps: Step[];
}

export interface Build {
  files: Files;
  modules: Record<string, Module>;
  /** What the compiler produces for each component in a build: the module a resource ships, and its scoped styles. */
  compiled: Record<string, { js: string; css: string }>;
  warnings: Problem[];
  /** The `<screen>` declaration of the screen. */
  screen: ScreenDeclaration | null;
  /** Milliseconds the compiler took. */
  ms: number;
}

export type BuildResult = { ok: true; build: Build } | { ok: false; problems: Problem[] };

export function problemOf(diagnostic: Diagnostic): Problem {
  const { severity, filename, message, hint, code, line, column, start, end, frame } = diagnostic;
  return { severity, file: filename, message, code, line, column, start, end, frame, ...(hint ? { hint } : {}) };
}

function unknownImport(site: ImportSite, files: Files): { code: string; message: string; hint: string } {
  const known = ordered(files).map((name) => `./${name}`);
  return {
    code: 'unknown-import',
    message: `There is no module '${site.source}' in the sandbox.`,
    hint: `It can import 'nexus', 'nexus/contract' and its own files: ${known.join(', ')}.`,
  };
}

function component(name: string, source: string, files: Files, build: Build, errors: Problem[]): void {
  const result = compile(source, { filename: name, dev: true });
  for (const warning of result.warnings) (warning.severity === 'error' ? errors : build.warnings).push(problemOf(warning));
  if (name === ENTRY) build.screen = result.screen;

  const steps = [step(result.js.map.mappings)];
  const code = new MagicString(result.js.code);
  link(code, parseSync(name, result.js.code, { lang: 'js' }).program, (site) => {
    const resolved = resolveImport(site.source, files);
    if (resolved) return resolved;
    // The import is reported where the visitor wrote it, not where the compiler moved it to.
    const written = trace(steps, locate(result.js.code, site.start));
    const start = written ? offsetOf(source, written) : 0;
    throw new CompileError(toDiagnostic(source, name, 'error', { ...unknownImport(site, files), start, end: start + 6 }));
  });
  build.modules[name] = { code: code.toString(), steps: [...steps, step(code.generateMap({ hires: 'boundary' }).mappings)] };

  // What `nexus build` hands to the bundler: no dev calls, and the styles next to the module.
  const shipped = compile(source, { filename: name, css: 'external' });
  build.compiled[name] = { js: shipped.js.code, css: shipped.css ? shipped.css.code : '' };
}

function script(name: string, source: string, files: Files, build: Build): void {
  const reporter = new Reporter(source, name);
  const fail = reporter.error.bind(reporter);
  const parsed = parseSync(name, source, { lang: 'ts' });
  const syntax = parsed.errors[0];
  if (syntax) {
    const label = syntax.labels[0] ?? { start: 0, end: 1 };
    fail({ code: 'script-syntax', message: syntax.message.endsWith('.') ? syntax.message : `${syntax.message}.`, start: label.start, end: label.end });
  }
  const code = new MagicString(source);
  eraseTypes(parsed.program, code, 0, fail);
  link(code, parsed.program, (site) => resolveImport(site.source, files) ?? fail({ ...unknownImport(site, files), start: site.start, end: site.start + 6 }));
  build.modules[name] = { code: code.toString(), steps: [step(code.generateMap({ hires: 'boundary' }).mappings)] };
}

function data(name: string, source: string, build: Build): void {
  try {
    JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(message);
    const start = position ? Number(position[1]) : 0;
    throw new CompileError(toDiagnostic(source, name, 'error', { code: 'json-syntax', message: message.replace(/ in JSON at position.*$/, '.'), start, end: start + 1 }));
  }
  build.modules[name] = { code: `$exports.default = ${source.trim()};`, steps: [] };
}

/**
 * Compiles every file of a project into a module the preview frame can run. Nothing is
 * evaluated here: the files are parsed and rewritten as text, and only the frame runs them.
 */
export function build(files: Files): BuildResult {
  const started = performance.now();
  const result: Build = { files, modules: {}, compiled: {}, warnings: [], screen: null, ms: 0 };
  const errors: Problem[] = [];

  if (typeof files[ENTRY] !== 'string') errors.push({ severity: 'error', file: ENTRY, message: `The sandbox needs a ${ENTRY}: it is the screen the preview opens.` });

  for (const name of ordered(files)) {
    const source = files[name] as string;
    try {
      const kind = kindOf(name);
      if (kind === 'component') component(name, source, files, result, errors);
      else if (kind === 'script') script(name, source, files, result);
      else if (kind === 'data') data(name, source, result);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      errors.push(problemOf(error.diagnostic));
    }
  }

  result.ms = performance.now() - started;
  return errors.length ? { ok: false, problems: errors } : { ok: true, build: result };
}
