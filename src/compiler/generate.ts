import type MagicString from 'magic-string';
import type { Root, Span } from './ast';
import type { Analysis } from './analyse';
import { Context, quote, type GenerateOptions } from './context';
import type { Reporter } from './diagnostics';
import { generateFragment } from './generate-fragment';
import { indent, js, join, mapped, type Code } from './output';
import type { ScriptInfo } from './script';

export interface ModuleParts {
  root: Root;
  script: ScriptInfo | null;
  analysis: Analysis;
  /** Styles to inject from the module itself, when no bundler takes them. */
  css: { id: string; code: string } | null;
}

/** The name of the component function: the file name as an identifier. */
function componentName(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() as string).replace(/\.[^.]*$/, '');
  const name = base.replace(/[^A-Za-z0-9_$]+(.)?/g, (_, next?: string) => (next ? next.toUpperCase() : ''));
  return /^[A-Za-z_]/.test(name) ? name[0]?.toUpperCase() + name.slice(1) : 'Component';
}

/** Assembles the module: imports, templates, and the component function around script and template. */
export function generateModule(parts: ModuleParts, code: MagicString, reporter: Reporter, options: GenerateOptions): Code {
  const { root, script, analysis, css } = parts;
  const context = new Context(code, reporter, analysis, options, script ? script.names : []);
  const source = code.original;

  const body = generateFragment(context, root.children, { bindings: [], svg: false, preserve: false }) ?? js`return ${context.template('', 1)}();\n`;

  // An import nothing uses as a value is a type import in disguise: TypeScript drops those too.
  const used = new Set([...(script ? script.names : []), ...analysis.names]);
  const imports: Code = [];
  const setup: Code = [];
  if (script && root.script) {
    let from = root.script.content.start;
    const piece = (span: Span): void => {
      const text = source.slice(span.start, span.end);
      if (!/\S/.test(text)) return;
      const start = span.start + (/^(?:[ \t]*\r?\n)*/.exec(text) as RegExpExecArray)[0].length;
      const end = span.start + text.trimEnd().length;
      setup.push({ ...mapped({ start, end }), indent: { by: '  ', keep: script.literals } }, '\n');
    };
    for (const declaration of script.imports) {
      piece({ start: from, end: declaration.start });
      from = declaration.end;
      const kept = declaration.specifiers.filter((specifier) => used.has(specifier.local));
      if (declaration.typeOnly || (declaration.written && !kept.length)) continue;
      if (kept.length === declaration.written) {
        imports.push(mapped(declaration), '\n');
        continue;
      }
      // Some of its names are gone, so the statement is written again from the ones that stay.
      const named: Code[] = kept.filter((specifier) => specifier.named).map((specifier) => [mapped(specifier)]);
      const clause: Code[] = kept.filter((specifier) => !specifier.named).map((specifier) => [mapped(specifier)]);
      if (named.length) clause.push(js`{ ${join(named, ', ')} }`);
      imports.push(...js`import ${join(clause, ', ')} from ${mapped(declaration.from)}\n`);
    }
    piece({ start: from, end: root.script.content.end });
  }

  if (css) context.helper('$css');
  const name = context.unique(componentName(options.filename));
  const helpers = [...context.helpers].sort();

  return [
    ...(helpers.length ? js`import { ${helpers.join(', ')} } from 'nexus';\n` : []),
    ...imports,
    '\n',
    ...context.templates.flat(),
    ...(css ? js`\n$css(${quote(css.id)}, ${quote(css.code)});\n` : []),
    // Exported under an alias: a variable called `screen` would hide `window.screen` from the script.
    ...(analysis.screen ? js`\nconst $screen = ${JSON.stringify(analysis.screen)};\nexport { $screen as screen };\n` : []),
    ...js`\nexport default function ${name}(props) {\n`,
    ...setup,
    ...(setup.length ? ['\n'] : []),
    ...indent(body),
    '}\n',
  ];
}
