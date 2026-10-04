/**
 * `dev` holds helpers that only mean something under `nexus dev`. In a build the calls are taken
 * out of the code together with their arguments, so that neither a label nor the function behind
 * a toolbar button ships to players.
 */

import MagicString, { type SourceMap } from 'magic-string';
import { parseSync } from 'vite';
import { removeStatementAt, type Node } from './erase';

const RUNTIME = new Set(['nexus', 'nexus-ui']);

/** The names under which a module imported `dev`, and the names of namespace imports of the runtime. */
export interface DevNames {
  dev: Set<string>;
  namespaces: Set<string>;
}

export function devNames(program: Node): DevNames | null {
  const names: DevNames = { dev: new Set(), namespaces: new Set() };
  for (const statement of program.body as Node[]) {
    if (statement.type !== 'ImportDeclaration' || !RUNTIME.has((statement.source as Node).value as string)) continue;
    for (const specifier of statement.specifiers as Node[]) {
      const local = (specifier.local as Node).name as string;
      if (specifier.type === 'ImportNamespaceSpecifier') names.namespaces.add(local);
      else if (specifier.type === 'ImportSpecifier' && (specifier.imported as Node).name === 'dev') names.dev.add(local);
    }
  }
  return names.dev.size || names.namespaces.size ? names : null;
}

/** True for `dev.action(...)`, under whatever name `dev` was imported. */
export function isDevCall(node: Node, names: DevNames): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Node;
  if (callee.type !== 'MemberExpression') return false;
  const object = callee.object as Node;
  if (object.type === 'Identifier') return names.dev.has(object.name as string);
  const owner = object.object as Node | undefined;
  return (
    object.type === 'MemberExpression' &&
    !object.computed &&
    (object.property as Node).name === 'dev' &&
    !!owner &&
    owner.type === 'Identifier' &&
    names.namespaces.has(owner.name as string)
  );
}

const LANGUAGES: Record<string, 'js' | 'jsx' | 'ts' | 'tsx'> = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx' };

/**
 * Removes the dev calls of a JavaScript or TypeScript module. Returns null when it has none.
 * Components do not come through here: the compiler removes theirs while it compiles them.
 */
export function stripDevCalls(source: string, filename: string): { code: string; map: SourceMap } | null {
  // Most modules never mention `dev`, and parsing every one of them would slow the build down.
  if (!/\bdev\b/.test(source) || !/['"]nexus(?:-ui)?['"]/.test(source)) return null;
  const lang = LANGUAGES[filename.slice(filename.lastIndexOf('.') + 1)];
  if (!lang) return null;
  const result = parseSync(filename, source, { lang, sourceType: 'module' });
  if (result.errors.length) return null;
  const program = result.program as unknown as Node;
  const names = devNames(program);
  if (!names) return null;

  const code = new MagicString(source);
  let changed = false;

  const visit = (node: Node, inList: boolean): void => {
    if (node.type === 'ExpressionStatement' && inList && isDevCall(node.expression as Node, names)) {
      removeStatementAt(code, node.start, node.end);
      changed = true;
      return;
    }
    if (isDevCall(node, names)) {
      code.overwrite(node.start, node.end, 'undefined');
      changed = true;
      return;
    }
    const statements = node.type === 'Program' || node.type === 'BlockStatement';
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const entry of value) if (entry && typeof entry === 'object') visit(entry as Node, statements && key === 'body');
      } else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') {
        visit(value as Node, false);
      }
    }
  };
  visit(program, false);

  return changed ? { code: code.toString(), map: code.generateMap({ hires: 'boundary', source: filename, includeContent: true }) } : null;
}
