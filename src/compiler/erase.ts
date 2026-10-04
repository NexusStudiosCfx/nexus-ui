import type MagicString from 'magic-string';
import type { Span } from './ast';
import type { Problem } from './diagnostics';

/** A node of the ESTree-shaped AST the parser returns. */
export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface Erased {
  /** Every identifier that is left in the code, whatever its role. */
  names: Set<string>;
  /** `await` and `for await` outside any function, as file offsets. */
  awaits: Span[];
  /** Template literals, as file offsets: their lines must not be re-indented. */
  literals: Span[];
}

const MODIFIERS = /\b(?:public|private|protected|readonly|override|abstract|declare)\b\s*/g;

// Statements that only exist for the type checker.
const TYPE_STATEMENTS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction']);

// Parts of an expression or declaration that only exist for the type checker.
const TYPE_NODES = new Set(['TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation']);

const TYPE_MEMBERS = new Set(['TSIndexSignature', 'TSAbstractMethodDefinition', 'TSAbstractPropertyDefinition']);

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const UNSUPPORTED: Record<string, [message: string, hint: string]> = {
  TSEnumDeclaration: [
    '`enum` is not supported: it is not removed with the types, it generates code.',
    "Use an object: `const Tab = { Home: 'home', Shop: 'shop' } as const;`.",
  ],
  TSModuleDeclaration: ['`namespace` is not supported: it generates code.', 'Use a plain object, or move the code to a .ts module.'],
  TSParameterProperty: [
    'A constructor parameter with `public`, `private` or `readonly` is not supported: it generates code.',
    'Declare the field in the class and assign it in the constructor.',
  ],
  TSImportEqualsDeclaration: ['`import x = require()` is not supported.', "Write `import x from 'module'`."],
  TSExportAssignment: ['`export =` is not supported.', 'A component cannot export anything.'],
};

/** `export type`, `export interface` and the like: an export that only exists for the type checker. */
export function isTypeExport(statement: Node): boolean {
  if (statement.type !== 'ExportNamedDeclaration' && statement.type !== 'ExportAllDeclaration') return false;
  const declaration = statement.declaration as Node | null | undefined;
  if (statement.exportKind === 'type') return true;
  if (declaration) return TYPE_STATEMENTS.has(declaration.type) || declaration.declare === true;
  // `export { type A, type B }`: every name is marked on its own.
  const specifiers = (statement.specifiers as Node[] | undefined) ?? [];
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.exportKind === 'type');
}

/** Removes a whole statement or class member between two file offsets, keeping what is around it apart. */
export function removeStatementAt(code: MagicString, start: number, end: number): void {
  const source = code.original;
  const next = /\S/.exec(source.slice(end));
  // Without the statement, a following line that starts like this would continue the previous one.
  if (next && '([`+-/'.includes(next[0])) {
    code.overwrite(start, end, ';');
    return;
  }
  const before = /(?:^|\n)([ \t]*)$/.exec(source.slice(0, start));
  const after = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(end));
  if (before && after) {
    // The statement had its lines to itself: they go with it, and so does one of two blank
    // lines that would otherwise be left around the gap.
    start -= (before[1] as string).length;
    end += after[0].length;
    const blank = /^[ \t]*\r?\n/.exec(source.slice(end));
    if (blank && /\n[ \t]*\r?\n$/.test(source.slice(0, start))) end += blank[0].length;
  }
  code.remove(start, end);
}

/**
 * Removes the TypeScript-only syntax of `node` from `code`. Only syntax that can be deleted
 * without changing what the program does is accepted, the same subset Node.js runs natively.
 *
 * `shift` is added to every AST offset to get an offset in the file `code` edits. Calls that
 * `drop` accepts are removed too, with their arguments: that is how dev-only calls leave a build.
 */
export function eraseTypes(
  node: Node,
  code: MagicString,
  shift: number,
  fail: (problem: Problem) => never,
  drop?: (call: Node) => boolean,
): Erased {
  const source = code.original;
  const erased: Erased = { names: new Set(), awaits: [], literals: [] };
  let functions = 0;
  // Statements that sit in a list of statements, where one can be taken out without a trace.
  const listed = new Set<Node>();

  const remove = (start: number, end: number): void => {
    if (end > start) code.remove(start + shift, end + shift);
  };

  const removeStatement = (statement: Node): void => removeStatementAt(code, statement.start + shift, statement.end + shift);

  /** Removes the `?` or `!` that follows a name, searching forward from `from`. */
  const removeMark = (from: number, mark: string): void => {
    const at = source.indexOf(mark, from + shift);
    remove(at - shift, at - shift + 1);
  };

  const removeModifiers = (member: Node): void => {
    const until = (member.key as Node).start;
    const head = source.slice(member.start + shift, until + shift);
    for (const match of head.matchAll(MODIFIERS)) {
      remove(member.start + match.index, member.start + match.index + match[0].length);
    }
  };

  const visitList = (list: unknown[]): void => {
    for (const entry of list) if (entry && typeof entry === 'object') visit(entry as Node);
  };

  const visitChildren = (parent: Node, except?: string): void => {
    for (const key in parent) {
      if (key === except) continue;
      const value = parent[key];
      if (Array.isArray(value)) visitList(value);
      else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') visit(value as Node);
    }
  };

  function visit(current: Node): void {
    const { type } = current;

    const unsupported = UNSUPPORTED[type];
    if (unsupported && !current.declare) {
      fail({ code: 'unsupported-typescript', message: unsupported[0], hint: unsupported[1], start: current.start + shift, end: current.end + shift });
    }

    if (TYPE_NODES.has(type)) return remove(current.start, current.end);
    if (TYPE_STATEMENTS.has(type) || current.declare === true || isTypeExport(current)) return removeStatement(current);
    if (TYPE_MEMBERS.has(type)) return removeStatement(current);

    if (drop) {
      // As a statement of its own the call disappears; anywhere else something has to stay in its place.
      if (type === 'ExpressionStatement' && listed.has(current) && drop(current.expression as Node)) return removeStatement(current);
      if (type === 'CallExpression' && drop(current)) return void code.overwrite(current.start + shift, current.end + shift, 'undefined');
      if (type === 'Program' || type === 'BlockStatement') for (const statement of current.body as Node[]) listed.add(statement);
    }

    switch (type) {
      case 'Identifier':
        erased.names.add(current.name as string);
        if (current.optional) removeMark(current.start + (current.name as string).length, '?');
        break;

      case 'ObjectPattern':
      case 'ArrayPattern':
        if (current.optional) {
          const annotation = current.typeAnnotation as Node | null;
          const mark = source.lastIndexOf('?', (annotation ? annotation.start : current.end) + shift) - shift;
          remove(mark, mark + 1);
        }
        break;

      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression': {
        const inner = current.expression as Node;
        visit(inner);
        return remove(inner.end, current.end);
      }

      case 'TSTypeAssertion': {
        const inner = current.expression as Node;
        remove(current.start, inner.start);
        return visit(inner);
      }

      case 'ImportDeclaration':
        // Imports are moved out of the component and rewritten there, types and all.
        return;

      case 'VariableDeclarator':
        if (current.definite) removeMark((current.id as Node).start + ((current.id as Node).name as string).length, '!');
        break;

      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (current.abstract) remove(current.start, current.start + /^abstract\s*/.exec(source.slice(current.start + shift))![0].length);
        const implemented = current.implements as Node[] | undefined;
        if (implemented && implemented.length) {
          const body = current.body as Node;
          const keyword = source.lastIndexOf('implements', (implemented[0] as Node).start + shift) - shift;
          remove(keyword, body.start);
        }
        return visitChildren(current, 'implements');
      }

      case 'PropertyDefinition':
      case 'MethodDefinition':
      case 'AccessorProperty': {
        // A method without a body is an overload or an optional method signature.
        if ((current.value as Node | null)?.type === 'TSEmptyBodyFunctionExpression') return removeStatement(current);
        removeModifiers(current);
        if (current.optional) removeMark((current.key as Node).end, '?');
        if (current.definite) removeMark((current.key as Node).end, '!');
        break;
      }

      case 'TemplateLiteral':
        erased.literals.push({ start: current.start + shift, end: current.end + shift });
        break;

      case 'AwaitExpression':
        if (!functions) erased.awaits.push({ start: current.start + shift, end: current.start + shift + 5 });
        break;

      case 'ForOfStatement':
        if (current.await && !functions) erased.awaits.push({ start: current.start + shift, end: current.start + shift + 9 });
        break;
    }

    if (FUNCTIONS.has(type)) {
      const params = current.params as Node[];
      const first = params[0];
      if (first && first.type === 'Identifier' && first.name === 'this') {
        // `this` as a parameter only declares its type.
        remove(first.start, params[1] ? (params[1] as Node).start : first.end);
        params.shift();
      }
      functions++;
      visitChildren(current);
      functions--;
      return;
    }

    visitChildren(current);
  }

  visit(node);
  return erased;
}
