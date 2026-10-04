import MagicString, { type SourceMap } from 'magic-string';
import type { Root } from './ast';
import { analyseTemplate } from './analyse';
import { Reporter, type Diagnostic } from './diagnostics';
import { generateModule } from './generate';
import { render } from './output';
import { parseFile } from './parse';
import type { ScreenDeclaration } from './screen';
import { analyseScript } from './script';
import { compileStyles, scopeAttribute } from './style';

export type * from './ast';
export { CompileError, type Diagnostic, type Severity } from './diagnostics';
export type { ScreenDeclaration } from './screen';

export interface CompileOptions {
  /** Path of the file, used in diagnostics, in source maps and to derive the scoping attribute. */
  filename: string;
  /**
   * Compiles for development: the runtime's error messages name their place in the file, and
   * calls to `dev` are kept. Without it they are removed with their arguments. Default: false.
   */
  dev?: boolean;
  /**
   * `inject`: the module adds its styles to the document itself. `external`: the styles are only
   * returned, for a bundler to handle. Default: `inject`.
   */
  css?: 'inject' | 'external';
}

export interface CompileResult {
  js: { code: string; map: SourceMap };
  /** The scoped styles of the file, or null when it has none. */
  css: { code: string; map: SourceMap } | null;
  /** Problems that did not stop compilation. One with severity `error` must still be fixed. */
  warnings: Diagnostic[];
  /** The `<screen>` declaration of the file, or null when it has none. */
  screen: ScreenDeclaration | null;
}

/**
 * Compiles a .nexus file to an ES module whose default export is the component.
 * Throws a `CompileError` when the file cannot be compiled.
 *
 * @example
 * const { js, css, warnings } = compile(source, { filename: 'web/screens/Shop.nexus' });
 */
export function compile(source: string, options: CompileOptions): CompileResult {
  const { filename, dev = false, css: cssMode = 'inject' } = options;
  const reporter = new Reporter(source, filename);
  const root = parseFile(source, reporter);
  const code = new MagicString(source);

  const script = root.script ? analyseScript(root.script, code, reporter, !dev) : null;
  const analysis = analyseTemplate(root, code, reporter, script && script.dev);

  const scope = scopeAttribute(filename);
  const styles = compileStyles(root.styles, source, filename, scope, reporter);
  const scoped = root.styles.some((style) => !style.global);

  const module = generateModule(
    { root, script, analysis, css: styles && cssMode === 'inject' ? { id: scope, code: styles.code } : null },
    code,
    reporter,
    { filename, dev, scope: scoped ? scope : null },
  );

  return { js: render(module, code, filename), css: styles, warnings: reporter.warnings, screen: analysis.screen };
}

/**
 * Parses a .nexus file into its AST without compiling it. Throws a `CompileError` on a syntax error.
 *
 * @example
 * const { script, children, styles, screen } = parse(source);
 */
export function parse(source: string, options: { filename?: string } = {}): Root {
  return parseFile(source, new Reporter(source, options.filename ?? 'component.nexus'));
}
