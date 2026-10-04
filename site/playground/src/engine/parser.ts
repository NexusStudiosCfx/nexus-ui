/**
 * The compiler parses scripts and template expressions with the parser Vite ships, which is
 * native code. In a browser this module takes the place of `vite` (an alias in vite.config.ts)
 * and answers `parseSync` with acorn and its TypeScript plugin. Both produce the same tree for
 * what the compiler reads. The few node types they name differently are renamed here, and
 * tests/parity.test.ts compiles a set of components with both and compares the output.
 */

import { Parser } from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';

export interface ParsedNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface ParseError {
  message: string;
  helpMessage: string | null;
  labels: { start: number; end: number }[];
}

export interface ParseResult {
  program: ParsedNode;
  comments: { type: 'Line' | 'Block'; start: number; end: number }[];
  errors: ParseError[];
}

interface AcornError extends SyntaxError {
  pos: number;
  raisedAt: number;
}

// A script may export a type that it only imported, which acorn would report as undeclared.
const lenient = (Base: typeof Parser): typeof Parser =>
  class extends Base {
    checkLocalExport(): void {}
  } as unknown as typeof Parser;

const JavaScript = Parser.extend(lenient);
const TypeScript = Parser.extend(tsPlugin(), lenient);

const RENAMED: Record<string, string> = { TSDeclareMethod: 'TSEmptyBodyFunctionExpression' };

function normalise(node: ParsedNode): void {
  const renamed = RENAMED[node.type];
  if (renamed) node.type = renamed;
  else if (node.type === 'PropertyDefinition' || node.type === 'MethodDefinition') {
    if (node.abstract) node.type = `TSAbstract${node.type}`;
    else if (node.accessor) node.type = 'AccessorProperty';
  }
  for (const key in node) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (entry && typeof entry === 'object' && typeof (entry as ParsedNode).type === 'string') normalise(entry as ParsedNode);
    } else if (value && typeof value === 'object' && typeof (value as ParsedNode).type === 'string') {
      normalise(value as ParsedNode);
    }
  }
}

export function parseSync(_filename: string, code: string, options: { lang?: string; sourceType?: string } = {}): ParseResult {
  const comments: ParseResult['comments'] = [];
  const typed = options.lang === 'ts' || options.lang === 'tsx';
  try {
    const program = (typed ? TypeScript : JavaScript).parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      preserveParens: true,
      // The TypeScript plugin refuses to run without them.
      locations: true,
      onComment: (block, _text, start, end) => comments.push({ type: block ? 'Block' : 'Line', start, end }),
    }) as unknown as ParsedNode;
    normalise(program);
    return { program, comments, errors: [] };
  } catch (error) {
    const problem = error as AcornError;
    if (!(error instanceof SyntaxError) || typeof problem.pos !== 'number') throw error;
    const start = Math.min(problem.pos, code.length);
    const end = Math.min(code.length, Math.max(start + 1, problem.raisedAt || 0));
    return {
      program: { type: 'Program', start: 0, end: code.length, body: [] },
      comments: [],
      errors: [{ message: problem.message.replace(/ \(\d+:\d+\)$/, ''), helpMessage: null, labels: [{ start, end: Math.max(end, start) }] }],
    };
  }
}
