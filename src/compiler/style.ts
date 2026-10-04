import MagicString, { Bundle, type SourceMap } from 'magic-string';
import type { Span, Style } from './ast';
import { checkCssNodes } from './compat';
import { closingBracket, CssError, parseCss, type CssNode } from './css';
import type { Reporter } from './diagnostics';

const KEYFRAMES = /^(?:-webkit-)?keyframes$/;
// At-rules whose block holds style rules.
const GROUPING = new Set(['media', 'supports', 'layer', 'document']);

/** The attribute that marks the elements and selectors of one component: `data-n-<hash>`. */
export function scopeAttribute(filename: string): string {
  // FNV-1a over the path: stable between builds, and different for two files with the same name.
  let hash = 0x811c9dc5;
  for (const char of filename.replace(/\\/g, '/')) {
    hash ^= char.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return `data-n-${(hash >>> 0).toString(36)}`;
}

/**
 * Adds `[data-n-hash]` to every compound selector of a selector list. `:global(...)` is
 * unwrapped and left alone, and so is `:root`.
 */
function scopeSelector(source: string, prelude: Span, attribute: string, code: MagicString, reporter: Reporter): void {
  let start = -1;
  let insertAt = -1;
  let local = false;

  const finish = (end: number): void => {
    if (start !== -1 && local) code.appendLeft(insertAt === -1 ? end : insertAt, attribute);
    start = -1;
    insertAt = -1;
    local = false;
  };

  for (let index = prelude.start; index < prelude.end; ) {
    const char = source[index] as string;

    if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index) + 2;
      continue;
    }
    if (/[\s>+~,]/.test(char)) {
      finish(index);
      index++;
      continue;
    }
    if (start === -1) start = index;

    if (char === '\\') {
      local = true;
      index += 2;
    } else if (char === '[') {
      local = true;
      index = closingBracket(source, index, prelude.end) + 1;
    } else if (char === ':') {
      const pseudo = /^::?([\w-]+)(\()?/.exec(source.slice(index, prelude.end));
      const name = pseudo ? (pseudo[1] as string).toLowerCase() : '';
      if (name === 'global') {
        if (!pseudo || !pseudo[2]) {
          reporter.error({
            code: 'invalid-global',
            message: '`:global` needs a selector in parentheses.',
            hint: 'Write `:global(.class-from-elsewhere)`.',
            start: index,
            end: index + 7,
          });
        }
        const close = closingBracket(source, index + 7, prelude.end);
        // What precedes it in the same compound still belongs to the component.
        if (local && insertAt === -1) insertAt = index;
        code.remove(index, index + 8);
        code.remove(close, close + 1);
        index = close + 1;
        continue;
      }
      if (insertAt === -1) insertAt = index;
      if (name !== 'root') local = true;
      index += pseudo ? pseudo[0].length - (pseudo[2] ? 1 : 0) : 1;
      if (pseudo && pseudo[2]) index = closingBracket(source, index, prelude.end) + 1;
    } else {
      local = true;
      index++;
    }
  }
  finish(prelude.end);
}

function scopeNodes(source: string, nodes: CssNode[], attribute: string, keyframes: Map<string, string>, code: MagicString, reporter: Reporter): void {
  for (const node of nodes) {
    if (node.type === 'statement') {
      const property = node.property && node.property.name;
      if (keyframes.size && (property === 'animation' || property === 'animation-name')) {
        const value = source.slice(node.value.start, node.value.end);
        for (const match of value.matchAll(/(?<![\w-])[A-Za-z_][\w-]*(?![\w-(])/g)) {
          const scoped = keyframes.get(match[0]);
          if (scoped) code.overwrite(node.value.start + match.index, node.value.start + match.index + match[0].length, scoped);
        }
      }
    } else if (node.at === null) {
      scopeSelector(source, node.prelude, `[${attribute}]`, code, reporter);
      scopeNodes(source, node.children, attribute, keyframes, code, reporter);
    } else if (KEYFRAMES.test(node.at)) {
      const name = source.slice(node.prelude.start, node.prelude.end);
      const scoped = keyframes.get(name);
      if (scoped) code.overwrite(node.prelude.start, node.prelude.end, scoped);
    } else if (GROUPING.has(node.at)) {
      scopeNodes(source, node.children, attribute, keyframes, code, reporter);
    } else {
      // `@font-face`, `@page` and the like hold declarations, which may still name an animation.
      scopeNodes(source, node.children.filter((child) => child.type === 'statement'), attribute, keyframes, code, reporter);
    }
  }
}

function collectKeyframes(source: string, nodes: CssNode[], suffix: string, into: Map<string, string>): void {
  for (const node of nodes) {
    if (node.type !== 'block' || node.at === null) continue;
    if (KEYFRAMES.test(node.at)) {
      const name = source.slice(node.prelude.start, node.prelude.end);
      into.set(name, `${name}-${suffix}`);
    } else {
      collectKeyframes(source, node.children, suffix, into);
    }
  }
}

/**
 * Compiles the `<style>` blocks of a file into one stylesheet: selectors and keyframe names of
 * scoped blocks get the component's attribute, and what Chromium 103 cannot run is reported.
 */
export function compileStyles(
  styles: Style[],
  source: string,
  filename: string,
  attribute: string,
  reporter: Reporter,
): { code: string; map: SourceMap } | null {
  if (!styles.length) return null;
  const code = new MagicString(source);
  const suffix = attribute.slice('data-n-'.length);

  const parsed = styles.map((style) => {
    try {
      return parseCss(source, style.content.start, style.content.end);
    } catch (error) {
      if (!(error instanceof CssError)) throw error;
      return reporter.error({
        code: 'css-syntax',
        message: error.message,
        hint: 'Check the braces, quotes and comments of this style block.',
        start: error.start,
        end: error.start + 1,
      });
    }
  });

  // An animation may be used in one block and defined in another, so the names are collected first.
  const keyframes = new Map<string, string>();
  styles.forEach((style, index) => {
    if (!style.global) collectKeyframes(source, parsed[index] as CssNode[], suffix, keyframes);
  });

  const bundle = new Bundle({ separator: '\n' });
  styles.forEach((style, index) => {
    const nodes = parsed[index] as CssNode[];
    for (const issue of checkCssNodes(source, nodes)) reporter.reject({ code: 'unsupported-css', ...issue });
    if (!style.global) scopeNodes(source, nodes, attribute, keyframes, code, reporter);
  });
  for (const style of styles) {
    const text = source.slice(style.content.start, style.content.end);
    // The block is usually indented inside its <style> tag; the stylesheet should not be.
    const lines = [...text.matchAll(/^[ \t]*(?=\S)/gm)];
    const margin = Math.min(...lines.map((line) => line[0].length));
    for (const line of lines) {
      if (margin) code.remove(style.content.start + line.index, style.content.start + line.index + margin);
    }
    const start = style.content.start + (/^\s*/.exec(text) as RegExpExecArray)[0].length;
    const end = style.content.start + text.trimEnd().length;
    if (end > start) bundle.addSource({ filename, content: code.snip(start, end) });
  }

  return {
    code: bundle.toString(),
    map: bundle.generateMap({ hires: 'boundary', includeContent: true }),
  };
}
