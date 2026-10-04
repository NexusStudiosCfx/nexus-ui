/**
 * The .nexus language for the editor. A small hand-written parser finds the parts of a file (the
 * script between the `---` lines, the template, the `{...}` in it), and the parsers of
 * TypeScript and HTML are mounted on those parts: TypeScript on the script and on every
 * expression, HTML on the template around the expressions, with CSS inside `<style>`.
 */

import { htmlLanguage } from '@codemirror/lang-html';
import { typescriptLanguage } from '@codemirror/lang-javascript';
import { Language, LanguageSupport, defineLanguageFacet, languageDataProp } from '@codemirror/language';
import { NodeSet, NodeType, Parser, Tree, parseMixed, type Input, type PartialParse, type SyntaxNodeRef, type TreeFragment } from '@lezer/common';
import { styleTags, tags } from '@lezer/highlight';

const NAMES = ['Document', 'Fence', 'Script', 'Template', 'Mustache', 'Brace', 'BlockKeyword', 'Expression'] as const;

const Type = { Document: 0, Fence: 1, Script: 2, Template: 3, Mustache: 4, Brace: 5, BlockKeyword: 6, Expression: 7 } as const;

interface Raw {
  type: number;
  from: number;
  to: number;
  children?: Raw[];
}

interface Range {
  from: number;
  to: number;
}

const QUOTES = '\'"`';

/** The position after the `}` that closes the `{` at `from`, or the end of its line without one. */
function closing(text: string, from: number, to: number): number {
  let depth = 0;
  for (let pos = from; pos < to; pos++) {
    const char = text[pos] as string;
    if (QUOTES.includes(char)) {
      for (pos++; pos < to && text[pos] !== char; pos++) if (text[pos] === '\\') pos++;
    } else if (char === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      pos = end === -1 || end >= to ? to : end + 1;
    } else if (char === '/' && text[pos + 1] === '/') {
      const end = text.indexOf('\n', pos);
      pos = end === -1 || end >= to ? to : end;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return pos + 1;
  }
  const line = text.indexOf('\n', from);
  return line === -1 || line > to ? to : line;
}

/**
 * The ` as ` of an `{#each}` that names the item: the last one outside brackets and strings,
 * since the list before it may itself be cast with `as`.
 */
function itemKeyword(text: string, from: number, to: number): number {
  let depth = 0;
  let found = -1;
  for (let pos = from; pos < to; pos++) {
    const char = text[pos] as string;
    if (QUOTES.includes(char)) {
      for (pos++; pos < to && text[pos] !== char; pos++) if (text[pos] === '\\') pos++;
    } else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (!depth && /\s/.test(char) && text.startsWith('as', pos + 1) && /\s/.test(text[pos + 3] ?? '')) found = pos + 1;
  }
  return found;
}

function expression(text: string, from: number, to: number, into: Raw[]): void {
  while (from < to && /\s/.test(text[from] as string)) from++;
  while (to > from && /\s/.test(text[to - 1] as string)) to--;
  if (to > from) into.push({ type: Type.Expression, from, to });
}

function mustache(text: string, from: number, to: number): Raw {
  const closed = text[to - 1] === '}' && to - from > 1;
  const inner = closed ? to - 1 : to;
  const children: Raw[] = [{ type: Type.Brace, from, to: from + 1 }];
  const keyword = /^(?:[#/@][a-z]+|:else(?:\s+if)?)/.exec(text.slice(from + 1, inner));
  let start = from + 1;
  if (keyword) {
    start += keyword[0].length;
    children.push({ type: Type.BlockKeyword, from: from + 1, to: start });
  }
  const as = keyword && keyword[0] === '#each' ? itemKeyword(text, start, inner) : -1;
  if (as === -1) expression(text, start, inner, children);
  else {
    expression(text, start, as, children);
    children.push({ type: Type.BlockKeyword, from: as, to: as + 2 });
    // The key, `(vehicle.plate)`, is an expression of its own after the names.
    const key = /\(([^()]*)\)\s*$/.exec(text.slice(as + 2, inner));
    if (key) {
      expression(text, as + 2, as + 2 + key.index, children);
      expression(text, as + 2 + key.index + 1, as + 2 + key.index + 1 + (key[1] as string).length, children);
    } else expression(text, as + 2, inner, children);
  }
  if (closed) children.push({ type: Type.Brace, from: to - 1, to });
  return { type: Type.Mustache, from, to, children };
}

function template(text: string, from: number, to: number): Raw {
  const children: Raw[] = [];
  for (let pos = from; pos < to; ) {
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      pos = end === -1 ? to : end + 3;
    } else if (/^<style[\s>]/i.test(text.slice(pos, pos + 7))) {
      // The braces of a stylesheet are CSS.
      const end = text.toLowerCase().indexOf('</style', pos);
      pos = end === -1 ? to : end + 7;
    } else if (text[pos] === '{') {
      const end = Math.max(pos + 1, closing(text, pos, to));
      children.push(mustache(text, pos, end));
      pos = end;
    } else pos++;
  }
  return { type: Type.Template, from, to, children };
}

function parts(text: string): Raw[] {
  const open = /^\s*---[ \t]*\r?\n/.exec(text);
  if (!open) return [template(text, 0, text.length)];
  const start = open[0].length;
  const fence = open[0].indexOf('---');
  const close = /^---[ \t]*$/m.exec(text.slice(start));
  const out: Raw[] = [{ type: Type.Fence, from: fence, to: fence + 3 }];
  if (!close) return [...out, { type: Type.Script, from: start, to: text.length }];
  const end = start + close.index;
  if (end > start) out.push({ type: Type.Script, from: start, to: end });
  out.push({ type: Type.Fence, from: end, to: end + 3 });
  const rest = end + close[0].length;
  if (rest < text.length) out.push(template(text, rest, text.length));
  return out;
}

/** Writes a node after its children, which is the order a tree buffer is read in. */
function flatten(node: Raw, buffer: number[]): number {
  let size = 4;
  for (const child of node.children ?? []) size += flatten(child, buffer);
  buffer.push(node.type, node.from, node.to, size);
  return size;
}

const facet = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });

const nodes = new NodeSet(NAMES.map((name, id) => NodeType.define({ id, name, top: id === Type.Document }))).extend(
  styleTags({ Fence: tags.meta, Brace: tags.special(tags.brace), BlockKeyword: tags.controlKeyword }),
  languageDataProp.add({ Document: facet }),
);

/**
 * Parses the whole file in one step. The files of a sandbox are a few hundred lines at most, and
 * finding their parts is a single pass over the text.
 */
class OuterParse implements PartialParse {
  parsedPos = 0;
  stoppedAt: number | null = null;

  constructor(
    private readonly input: Input,
    private readonly length: number,
  ) {}

  advance(): Tree {
    const end = this.stoppedAt ?? this.length;
    const buffer: number[] = [];
    for (const part of parts(this.input.read(0, end))) flatten(part, buffer);
    this.parsedPos = end;
    return Tree.build({ buffer, nodeSet: nodes, topID: Type.Document, length: end });
  }

  stopAt(pos: number): void {
    this.stoppedAt = pos;
  }
}

const script = typescriptLanguage.parser;
const expressions = typescriptLanguage.parser.configure({ top: 'SingleExpression' });

/** The template without its `{...}`: what the HTML parser reads. */
function markup(node: SyntaxNodeRef): Range[] {
  const ranges: Range[] = [];
  let pos = node.from;
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) ranges.push({ from: pos, to: child.from });
    pos = child.to;
  }
  if (node.to > pos) ranges.push({ from: pos, to: node.to });
  return ranges;
}

const mixed = parseMixed((node) => {
  if (node.type.id === Type.Script) return { parser: script };
  if (node.type.id === Type.Expression) return { parser: expressions };
  if (node.type.id === Type.Template) return { parser: htmlLanguage.parser, overlay: markup(node) };
  return null;
});

class NexusParser extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly Range[]): PartialParse {
    const last = ranges[ranges.length - 1];
    return mixed(new OuterParse(input, last ? last.to : input.length), input, fragments, ranges);
  }
}

export const nexusLanguage = new Language(facet, new NexusParser(), [], 'nexus');

export function nexus(): LanguageSupport {
  return new LanguageSupport(nexusLanguage);
}
