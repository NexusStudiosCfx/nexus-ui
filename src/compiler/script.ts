import type MagicString from 'magic-string';
import type { Script, Span } from './ast';
import { checkScript } from './compat';
import type { Reporter } from './diagnostics';
import { devNames, isDevCall, type DevNames } from './dev-calls';
import { eraseTypes, isTypeExport, type Node } from './erase';
import { parseTypeScript } from './oxc';

export interface ImportInfo extends Span {
  /** `import type`: removed with the other types. */
  typeOnly: boolean;
  /** From the module name to the end of the statement. */
  from: Span;
  /** What the import declares, without the specifiers marked `type`. */
  specifiers: (Span & { local: string; named: boolean })[];
  /** How many specifiers the statement has, type-only ones included. */
  written: number;
}

export interface ScriptInfo {
  /** The import statements, as file offsets. They are hoisted out of the component function. */
  imports: ImportInfo[];
  /** Every identifier used in the script after types are removed. */
  names: Set<string>;
  /** Template literals: their lines keep their indentation. */
  literals: Span[];
  /** How the script names `dev`, when its calls are being removed for a build. */
  dev: DevNames | null;
}

/** The names a destructuring pattern or a plain identifier declares. */
export function bindingNames(pattern: Node | null, into: string[] = []): string[] {
  if (!pattern) return into;
  switch (pattern.type) {
    case 'Identifier':
      into.push(pattern.name as string);
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties as Node[]) {
        bindingNames((property.type === 'RestElement' ? property.argument : property.value) as Node, into);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements as (Node | null)[]) bindingNames(element, into);
      break;
    case 'AssignmentPattern':
      bindingNames(pattern.left as Node, into);
      break;
    case 'RestElement':
      bindingNames(pattern.argument as Node, into);
      break;
  }
  return into;
}

/**
 * Checks the script, removes its types from `code` and reports what the generator needs: which
 * statements are imports, and which names the script uses. For a build, calls to `dev` go too.
 */
export function analyseScript(script: Script, code: MagicString, reporter: Reporter, build: boolean): ScriptInfo {
  const shift = script.content.start;
  const fail = reporter.error.bind(reporter);
  const { program } = parseTypeScript(script.content.code, shift, 'script-syntax', fail);
  const dev = build ? devNames(program) : null;
  const at = (node: Node): Span => ({ start: node.start + shift, end: node.end + shift });

  const imports: ImportInfo[] = [];

  const declare = (name: string, node: Node): void => {
    if (name === 'props') {
      reporter.error({
        code: 'props-redeclared',
        message: '`props` is already in scope: it holds what the component was given.',
        hint: 'Remove this declaration and read `props.name`, or pick another name.',
        ...at(node),
      });
    }
    if (name.startsWith('$')) {
      reporter.error({
        code: 'reserved-name',
        message: `\`${name}\` cannot be used: names that start with \`$\` are reserved for the compiler.`,
        hint: `Rename it, for example to \`${name.replace(/^\$+/, '') || 'value'}\`.`,
        ...at(node),
      });
    }
  };

  for (const statement of program.body as Node[]) {
    switch (statement.type) {
      case 'ImportDeclaration': {
        const specifiers = (statement.specifiers as Node[]).filter((specifier) => specifier.importKind !== 'type');
        for (const specifier of specifiers) declare((specifier.local as Node).name as string, specifier.local as Node);
        imports.push({
          ...at(statement),
          typeOnly: statement.importKind === 'type',
          from: { start: (statement.source as Node).start + shift, end: statement.end + shift },
          specifiers: specifiers.map((specifier) => ({
            ...at(specifier),
            local: (specifier.local as Node).name as string,
            named: specifier.type === 'ImportSpecifier',
          })),
          written: (statement.specifiers as Node[]).length,
        });
        break;
      }

      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        // A type can be exported: it leaves no trace in the compiled module.
        if (isTypeExport(statement)) break;
        reporter.error({
          code: 'script-export',
          message: 'A component script can export types, but no values: the component is the only value the file exports.',
          hint: 'Remove `export`. To share code between components, put it in a .ts module and import it.',
          start: statement.start + shift,
          end: statement.start + shift + 6,
        });
        break;

      case 'VariableDeclaration':
        for (const declarator of statement.declarations as Node[]) {
          const id = declarator.id as Node;
          for (const name of bindingNames(id)) declare(name, id);
          const init = declarator.init as Node | null;
          if (id.type !== 'Identifier' && init && init.type === 'Identifier' && init.name === 'props') {
            reporter.warn({
              code: 'props-destructured',
              message: 'Destructuring `props` copies the values once: these variables do not update when the props change.',
              hint: 'Read `props.name` where the value is used, or wrap it: `const name = computed(() => props.name)`.',
              ...at(id),
            });
          }
        }
        break;

      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        if (statement.id) declare((statement.id as Node).name as string, statement.id as Node);
        break;
    }
  }

  for (const issue of checkScript(script.content.code)) {
    reporter.reject({ code: 'unsupported-api', ...issue, start: issue.start + shift, end: issue.end + shift });
  }

  const erased = eraseTypes(program, code, shift, fail, dev ? (call) => isDevCall(call, dev) : undefined);

  const awaited = erased.awaits[0];
  if (awaited) {
    reporter.error({
      code: 'top-level-await',
      message: 'The script runs synchronously while the component is created, so it cannot `await` at the top level.',
      hint: 'Move the code into an async function and call it, for example `onMount(async () => { ... })`.',
      ...awaited,
    });
  }

  return { imports, names: erased.names, literals: erased.literals, dev };
}
