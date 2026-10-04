import type MagicString from 'magic-string';
import { isTypeExport } from '../../../../src/compiler/erase';
import type { ParsedNode } from './parser';

export interface ImportSite {
  /** The specifier as written. */
  source: string;
  /** Offsets of the statement in the code that was parsed. */
  start: number;
  end: number;
}

/** Thrown for an import the sandbox cannot satisfy. `site` is where it was written. */
export class LinkError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly site: ImportSite,
  ) {
    super(message);
  }
}

function names(pattern: ParsedNode | null, into: string[] = []): string[] {
  if (!pattern) return into;
  if (pattern.type === 'Identifier') into.push(pattern.name as string);
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties as ParsedNode[]) names((property.type === 'RestElement' ? property.argument : property.value) as ParsedNode, into);
  } else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements as (ParsedNode | null)[]) names(element, into);
  else if (pattern.type === 'AssignmentPattern') names(pattern.left as ParsedNode, into);
  else if (pattern.type === 'RestElement') names(pattern.argument as ParsedNode, into);
  return into;
}

/** The name of an import or export specifier, which is an identifier or a string. */
const key = (node: ParsedNode): string => (node.type === 'Literal' ? JSON.stringify(node.value) : (node.name as string));

/** Reads a member of a module by the name a specifier gives it. */
const member = (node: ParsedNode): string => (node.type === 'Literal' ? `[${JSON.stringify(node.value)}]` : `.${node.name as string}`);

const isType = (node: ParsedNode): boolean => node.importKind === 'type' || node.exportKind === 'type';

/**
 * Rewrites an ES module in place into the body of `function ($import, $export, $exports)`, which
 * a frame without module loading can run:
 *
 * - `import { a } from 'x'` becomes `const { a } = $import("x")`, with `x` resolved to the name
 *   of a module the frame has;
 * - every export becomes a getter on the module's exports, declared before the first statement,
 *   so a module that is imported while it still runs (a component that uses itself) is found.
 *
 * Statements that only exist for the type checker must have been removed already.
 */
export function link(code: MagicString, program: ParsedNode, resolve: (site: ImportSite) => string): void {
  const getters: string[] = [];
  const request = (node: ParsedNode, statement: ParsedNode): string => {
    const source = String(node.value);
    return `$import(${JSON.stringify(resolve({ source, start: statement.start, end: statement.end }))})`;
  };

  for (const statement of program.body as ParsedNode[]) {
    const declaration = statement.declaration as ParsedNode | null | undefined;

    if (statement.type === 'ImportDeclaration') {
      const specifiers = (statement.specifiers as ParsedNode[]).filter((specifier) => !isType(specifier));
      // TypeScript drops an import whose names are all types, and so does this.
      if (isType(statement) || (!specifiers.length && (statement.specifiers as ParsedNode[]).length)) {
        code.remove(statement.start, statement.end);
        continue;
      }
      const module = request(statement.source as ParsedNode, statement);
      const namespace = specifiers.find((specifier) => specifier.type === 'ImportNamespaceSpecifier');
      const picked = specifiers
        .filter((specifier) => specifier !== namespace)
        .map((specifier) => {
          const local = (specifier.local as ParsedNode).name as string;
          const imported = specifier.type === 'ImportDefaultSpecifier' ? 'default' : key(specifier.imported as ParsedNode);
          return imported === local ? local : `${imported}: ${local}`;
        });
      const from = namespace ? ((namespace.local as ParsedNode).name as string) : module;
      const parts = [
        ...(namespace ? [`const ${from} = ${module};`] : []),
        ...(picked.length ? [`const { ${picked.join(', ')} } = ${from};`] : []),
        ...(specifiers.length ? [] : [`${module};`]),
      ];
      code.overwrite(statement.start, statement.end, parts.join(' '));
    } else if (statement.type === 'ExportDefaultDeclaration' && declaration) {
      const named = (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id;
      if (named) {
        code.remove(statement.start, declaration.start);
        getters.push(`default: () => ${(declaration.id as ParsedNode).name as string}`);
      } else {
        code.overwrite(statement.start, declaration.start, '$exports.default = ');
        code.appendLeft(statement.end, ';');
      }
    } else if (statement.type === 'ExportNamedDeclaration' && declaration) {
      if (isTypeExport(statement)) continue;
      code.remove(statement.start, declaration.start);
      const declared =
        declaration.type === 'VariableDeclaration'
          ? (declaration.declarations as ParsedNode[]).flatMap((declarator) => names(declarator.id as ParsedNode))
          : [(declaration.id as ParsedNode).name as string];
      for (const name of declared) getters.push(`${name}: () => ${name}`);
    } else if (statement.type === 'ExportNamedDeclaration') {
      if (isTypeExport(statement)) continue;
      const specifiers = (statement.specifiers as ParsedNode[]).filter((specifier) => !isType(specifier));
      const source = statement.source as ParsedNode | null;
      const entries = specifiers.map((specifier) => `${key(specifier.exported as ParsedNode)}: () => ${source ? `$module${member(specifier.local as ParsedNode)}` : key(specifier.local as ParsedNode)}`);
      if (source) code.overwrite(statement.start, statement.end, `{ const $module = ${request(source, statement)}; $export({ ${entries.join(', ')} }); }`);
      else {
        code.remove(statement.start, statement.end);
        getters.push(...entries);
      }
    } else if (statement.type === 'ExportAllDeclaration') {
      if (isTypeExport(statement)) continue;
      const exported = statement.exported as ParsedNode | null;
      const module = request(statement.source as ParsedNode, statement);
      code.overwrite(statement.start, statement.end, exported ? `{ const $module = ${module}; $export({ ${key(exported)}: () => $module }); }` : `$export(${module}, true);`);
    }
  }

  if (getters.length) code.prepend(`$export({ ${getters.join(', ')} });\n`);
}
