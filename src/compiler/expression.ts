import type MagicString from 'magic-string';
import type { Expression } from './ast';
import type { Reporter } from './diagnostics';
import { isDevCall, type DevNames } from './dev-calls';
import { eraseTypes, type Node } from './erase';
import { parseTypeScript } from './oxc';
import { bindingNames } from './script';

export type ExpressionKind = 'identifier' | 'member' | 'function' | 'literal' | 'other';

export interface ExpressionInfo {
  kind: ExpressionKind;
  /** The value of a string, number, boolean or null literal. */
  literal?: string | number | boolean | null;
  /** Identifiers the expression mentions. */
  names: Set<string>;
  /** False when the value cannot be a signal, so reading it needs no unwrapping. */
  maybeSignal: boolean;
  /** An object literal or a sequence, which needs parentheses as an arrow function body. */
  needsParens: boolean;
  /** The expression ends in a `//` comment, which would swallow code placed after it on the line. */
  endsInComment: boolean;
}

const WRAPPERS = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

// Results of these are never a signal.
const PLAIN = new Set([
  'Literal', 'TemplateLiteral', 'BinaryExpression', 'UnaryExpression', 'UpdateExpression', 'ArrowFunctionExpression',
  'FunctionExpression', 'ObjectExpression', 'ArrayExpression', 'ClassExpression',
]);

const cache = new WeakMap<Expression, ExpressionInfo>();

/**
 * Parses a template expression, removes its types from `code` and classifies it. The result is
 * cached per AST node, because the generator asks more than once.
 */
export function analyseExpression(expression: Expression, code: MagicString, reporter: Reporter, dev: DevNames | null = null): ExpressionInfo {
  const known = cache.get(expression);
  if (known) return known;

  const fail = reporter.error.bind(reporter);
  // Parenthesised, so that `{ a: 1 }` is an object and a statement is a syntax error. The line
  // break keeps a `//` comment at the end of the expression from hiding the closing parenthesis.
  const shift = expression.start - 1;
  const { program, comments } = parseTypeScript(`(${expression.code}\n)`, shift, 'expression-syntax', fail, expression.end);
  const body = program.body as Node[];
  const statement = body[0];
  const outer = statement && statement.type === 'ExpressionStatement' ? (statement.expression as Node) : null;
  if (body.length !== 1 || !outer || outer.type !== 'ParenthesizedExpression' || outer.end !== expression.code.length + 3) {
    reporter.error({
      code: 'expression-syntax',
      message: 'This must be a single expression.',
      hint: 'Statements belong in the script. Compute the value there and use its name here.',
      start: expression.start,
      end: expression.end,
    });
  }

  let node = outer.expression as Node;
  const erased = eraseTypes(node, code, shift, fail, dev ? (call) => isDevCall(call, dev) : undefined);
  const awaited = erased.awaits[0];
  if (awaited) {
    reporter.error({
      code: 'template-await',
      message: 'A template expression cannot `await`: it runs every time its signals change.',
      hint: 'Await in the script, store the result in a signal and use the signal here.',
      ...awaited,
    });
  }

  while (WRAPPERS.has(node.type)) node = node.expression as Node;

  let kind: ExpressionKind = 'other';
  let literal: ExpressionInfo['literal'];
  if (node.type === 'Identifier') {
    kind = 'identifier';
  } else if (node.type === 'MemberExpression') {
    kind = 'member';
  } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    kind = 'function';
  } else if (node.type === 'Literal' && !('regex' in node) && !('bigint' in node)) {
    kind = 'literal';
    literal = node.value as ExpressionInfo['literal'];
  } else if (node.type === 'TemplateLiteral' && !(node.expressions as Node[]).length) {
    kind = 'literal';
    literal = ((node.quasis as Node[])[0] as Node & { value: { cooked: string } }).value.cooked;
  }

  const explicit = node.type === 'MemberExpression' && !node.computed && (node.property as Node).name === 'value';
  const info: ExpressionInfo = {
    kind,
    names: erased.names,
    maybeSignal: !PLAIN.has(node.type) && !explicit,
    needsParens: node.type === 'ObjectExpression' || node.type === 'SequenceExpression',
    endsInComment: comments.some((comment) => comment.type === 'Line' && comment.end === expression.code.length + 1),
  };
  if (kind === 'literal') info.literal = literal;
  cache.set(expression, info);
  return info;
}

/** The names bound by the item pattern of an `{#each}`. */
export function analysePattern(pattern: Expression, reporter: Reporter): string[] {
  const fail = reporter.error.bind(reporter);
  const { program } = parseTypeScript(`(${pattern.code}) => 0`, pattern.start - 1, 'expression-syntax', fail);
  const arrow = ((program.body as Node[])[0] as Node).expression as Node;
  return bindingNames((arrow.params as Node[])[0] as Node);
}
