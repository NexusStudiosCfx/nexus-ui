import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXTENSION = fileURLToPath(new URL('../../editor/vscode', import.meta.url));

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(EXTENSION, path), 'utf8')) as T;
}

interface Rule {
  include?: string;
  match?: string;
  begin?: string;
  end?: string;
  patterns?: Rule[];
  captures?: Record<string, Rule>;
  beginCaptures?: Record<string, Rule>;
  endCaptures?: Record<string, Rule>;
}

interface Grammar {
  scopeName: string;
  patterns: Rule[];
  repository: Record<string, Rule>;
}

interface Manifest {
  contributes: {
    languages: { id: string; extensions: string[]; configuration: string }[];
    grammars: { language: string; scopeName: string; path: string; embeddedLanguages: Record<string, string> }[];
    snippets: { language: string; path: string }[];
  };
}

function walk(rule: Rule, visit: (rule: Rule) => void): void {
  visit(rule);
  for (const child of rule.patterns ?? []) walk(child, visit);
  for (const group of [rule.captures, rule.beginCaptures, rule.endCaptures]) {
    for (const child of Object.values(group ?? {})) walk(child, visit);
  }
}

describe('the VS Code extension', () => {
  const manifest = json<Manifest>('package.json');
  const grammar = json<Grammar>('syntaxes/nexus.tmLanguage.json');
  const rules: Rule[] = [];
  for (const rule of [...grammar.patterns, ...Object.values(grammar.repository)]) walk(rule, (found) => rules.push(found));

  it('registers .nexus files and points at files that exist', () => {
    const [language] = manifest.contributes.languages;
    const [contributed] = manifest.contributes.grammars;
    expect(language?.extensions).toEqual(['.nexus']);
    expect(contributed?.language).toBe(language?.id);
    expect(contributed?.scopeName).toBe(grammar.scopeName);
    for (const path of [language?.configuration, contributed?.path, manifest.contributes.snippets[0]?.path]) {
      expect(existsSync(join(EXTENSION, path as string)), path).toBe(true);
    }
  });

  it('only includes rules that exist, or the grammars it embeds', () => {
    const embedded = Object.keys(manifest.contributes.grammars[0]?.embeddedLanguages ?? {});
    for (const { include } of rules) {
      if (include === undefined) continue;
      if (include.startsWith('#')) expect(Object.keys(grammar.repository), include).toContain(include.slice(1));
      else expect(embedded, include).toContain(include);
    }
  });

  it('has patterns that compile', () => {
    for (const rule of rules) {
      for (const pattern of [rule.match, rule.begin, rule.end]) {
        if (pattern === undefined) continue;
        // Oniguruma's start-of-text anchor is the one construct here that JavaScript lacks.
        expect(() => new RegExp(pattern.replace(/\\A/g, '^')), pattern).not.toThrow();
      }
    }
  });

  it('tells the parts of a .nexus file apart', () => {
    const rule = (name: string): Rule => grammar.repository[name] as Rule;
    const first = (name: string, text: string): string | undefined => {
      const source = (rule(name).begin ?? rule(name).match) as string;
      // In Oniguruma `$` ends a line, which is the `m` flag in JavaScript.
      return new RegExp(source.replace(/\\A/g, '^'), 'm').exec(text)?.[0];
    };
    expect(first('script', '---\n')).toBe('---');
    expect(first('style', '<style global>')).toBe('<style global>');
    expect(first('block-open', '{#each list as item (item.id)}')).toBe('{#each');
    expect(first('block-branch', '{:else if ready}')).toBe('{:else if');
    expect(first('block-close', '{/each}')).toBe('{/each}');
    expect(first('html-tag', '{@html body}')).toBe('{@html');
    expect(first('screen-tag', '<screen focus="mouse" />')).toBe('<screen');
    expect(first('component-tag', '<Price value={total} />')).toBe('<Price');
    expect(first('component-tag', '<ui.Button>')).toBe('<ui.Button');
    expect(first('component-tag', '<section>')).toBeUndefined();
    expect(first('element-tag', '</section>')).toBe('</section');
    expect(first('directive', 'on:click|prevent|once={buy}')).toBe('on:click|prevent|once');
    expect(first('directive', 'class:busy={pending}')).toBe('class:busy');
    expect(first('entity', '&amp;')).toBe('&amp;');
  });

  it('has snippets and a language configuration that parse', () => {
    const snippets = json<Record<string, { prefix: string; body: string[] }>>('snippets/nexus.code-snippets');
    expect(Object.values(snippets).map((snippet) => snippet.prefix)).toEqual(expect.arrayContaining(['screen', 'component']));
    const configuration = json<{ comments: { blockComment: string[] }; indentationRules: Record<string, string>; onEnterRules: { beforeText: string; afterText: string }[] }>(
      'language-configuration.json',
    );
    expect(configuration.comments.blockComment).toEqual(['<!--', '-->']);
    for (const pattern of [...Object.values(configuration.indentationRules), ...configuration.onEnterRules.flatMap((entry) => [entry.beforeText, entry.afterText])]) {
      expect(() => new RegExp(pattern), pattern).not.toThrow();
    }
  });
});
