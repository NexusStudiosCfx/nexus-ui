import type MagicString from 'magic-string';
import type { Expression, ExpressionTag, Span } from './ast';
import type { Analysis } from './analyse';
import { locate, type Reporter } from './diagnostics';
import { analyseExpression, type ExpressionInfo } from './expression';
import { js, join, mapped, type Code } from './output';

/** Names an enclosing `{#each}` makes available, and the signal that holds their value. */
export interface Binding {
  names: string[];
  /** The source of the pattern or the name: it is written again wherever the value is read. */
  pattern: Span;
  signal: string;
}

export interface GenerateOptions {
  filename: string;
  dev: boolean;
  /** The scoping attribute, when the component has scoped styles. */
  scope: string | null;
}

/** Shared state of one code generation: names in use, runtime helpers needed, templates emitted. */
export class Context {
  readonly helpers = new Set<string>();
  readonly templates: Code[] = [];
  private readonly taken: Set<string>;

  constructor(
    readonly code: MagicString,
    readonly reporter: Reporter,
    readonly analysis: Analysis,
    readonly options: GenerateOptions,
    scriptNames: Iterable<string>,
  ) {
    this.taken = new Set([...scriptNames, ...analysis.names, 'props']);
  }

  /** The name of a runtime helper, recorded so it gets imported. */
  helper(name: string): string {
    this.helpers.add(name);
    return name;
  }

  /** A name that nothing in the script or the template uses. */
  unique(base: string): string {
    let name = base;
    for (let count = 2; this.taken.has(name) || RESERVED.has(name); count++) name = `${base}_${count}`;
    this.taken.add(name);
    return name;
  }

  /** Declares a module-level template and returns its name. */
  template(html: string, flags: number): string {
    const name = this.unique(`$t${this.templates.length + 1}`);
    this.templates.push(js`const ${name} = ${this.helper('$template')}(${quote(html)}${flags ? `, ${flags}` : ''});\n`);
    return name;
  }

  info(expression: Expression): ExpressionInfo {
    return analyseExpression(expression, this.code, this.reporter);
  }

  /** `file:line:column` of a node, passed to the runtime in dev mode for its error messages. */
  where(span: Span): string {
    const { line, column } = locate(this.code.original, span.start);
    return `${this.options.filename}:${line}:${column}`;
  }

  /** The expression exactly as written, mapped back to its place in the file. */
  source(expression: Expression): Code {
    return this.info(expression).endsInComment ? [mapped(expression), '\n'] : [mapped(expression)];
  }

  /**
   * The expression as code, read the way the template reads values: a signal gives its value.
   * With `operand` the result is safe to put next to an operator.
   */
  value(expression: Expression, operand = false): Code {
    const info = this.info(expression);
    const source = info.needsParens ? js`(${this.source(expression)})` : this.source(expression);
    if (info.maybeSignal) return js`${this.helper('$get')}(${source})`;
    return operand && !info.needsParens ? js`(${source})` : source;
  }

  /** Text and expressions as one string-valued expression. */
  text(parts: (string | ExpressionTag)[]): Code {
    const only = parts[0];
    if (parts.length === 1 && only !== undefined && typeof only !== 'string') return this.value(only.expression);
    const code: Code = ['`'];
    for (const part of parts) {
      if (typeof part === 'string') code.push(part.replace(/[`\\]|\$\{/g, '\\$&'));
      // An absent value prints as nothing rather than as "undefined".
      else code.push(...js`\${${this.value(part.expression, true)} ?? ''}`);
    }
    code.push('`');
    return code;
  }

  /**
   * The bindings among `bindings` (outermost first) that code mentioning `names` reads. A name
   * bound again by an inner `{#each}`, or declared by the caller itself (`hidden`), hides the
   * outer binding of that name.
   */
  private needed(bindings: Binding[], names: Iterable<string>, hidden: string[] = []): Binding[] {
    const wanted = new Set(names);
    const provided = new Set(hidden);
    const found: Binding[] = [];
    for (let index = bindings.length; index--; ) {
      const binding = bindings[index] as Binding;
      if (binding.names.some((name) => wanted.has(name) && !provided.has(name))) found.unshift(binding);
      for (const name of binding.names) provided.add(name);
    }
    return found;
  }

  /**
   * `(row = $$row.value) => body`: a function that reads the current item of each enclosing
   * `{#each}` it mentions before it evaluates `body`. Called inside an effect, the reads are
   * tracked. `leading` names the parameters the caller passes.
   */
  arrow(bindings: Binding[], names: Iterable<string>, body: Code, leading: string[] = []): Code {
    const params = [
      ...leading.map((name) => [name] as Code),
      ...this.needed(bindings, names).map((binding) => js`${mapped(binding.pattern)} = ${binding.signal}.value`),
    ];
    return js`(${join(params, ', ')}) => ${body}`;
  }

  /** `body` evaluated once, now, with the items of the enclosing `{#each}` blocks it mentions in scope. */
  once(bindings: Binding[], names: Iterable<string>, body: Code): Code {
    return this.needed(bindings, names).length ? js`(${this.arrow(bindings, names, body)})()` : body;
  }

  /** The same reads as statements, for places that cannot take parameters. */
  prelude(bindings: Binding[], names: Iterable<string>, hidden?: string[]): Code {
    return this.needed(bindings, names, hidden).flatMap((binding) => js`const ${mapped(binding.pattern)} = ${binding.signal}.value; `);
  }

  /** `() => value` for one expression. */
  getter(bindings: Binding[], expression: Expression): Code {
    return this.arrow(bindings, this.info(expression).names, this.value(expression));
  }

  /** The identifiers mentioned by the expressions among `parts`. */
  names(parts: (string | ExpressionTag)[]): Set<string> {
    const names = new Set<string>();
    for (const part of parts) {
      if (typeof part !== 'string') for (const name of this.info(part.expression).names) names.add(name);
    }
    return names;
  }

  /** `() => text` for text mixed with expressions. */
  textGetter(bindings: Binding[], parts: (string | ExpressionTag)[]): Code {
    return this.arrow(bindings, this.names(parts), this.text(parts));
  }
}

/** A single-quoted string literal. Markup is full of double quotes, which then need no escaping. */
export function quote(text: string): string {
  const body = JSON.stringify(text)
    .slice(1, -1)
    .replace(/\\.|'/g, (match) => (match === '\\"' ? '"' : match === "'" ? "\\'" : match))
    .replace(/[\u2028\u2029]/g, (separator) => `\\u${separator.charCodeAt(0).toString(16)}`);
  return `'${body}'`;
}

// Generated variable names are derived from tag names, some of which are not valid identifiers.
const RESERVED = new Set([
  'var', 'object', 'switch', 'default', 'function', 'class', 'new', 'delete', 'in', 'do', 'if', 'for', 'while', 'return',
  'this', 'null', 'true', 'false', 'void', 'typeof', 'let', 'const', 'static', 'yield', 'await', 'enum', 'export',
  'import', 'super', 'with', 'try', 'catch', 'finally', 'throw', 'case', 'break', 'continue', 'else', 'debugger',
  'arguments', 'eval', 'undefined', 'window', 'document',
]);
