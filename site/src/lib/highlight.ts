import { createHighlighter, type Highlighter, type LanguageRegistration, type ThemeRegistration } from 'shiki';
import grammar from '../../../editor/vscode/syntaxes/nexus.tmLanguage.json';
import { codeTheme } from './code-theme.mjs';

export type Lang = 'nexus' | 'ts' | 'js' | 'jsx' | 'lua' | 'css' | 'json' | 'sh' | 'text';
export type Tone = 'bad' | 'good' | 'dim';

export interface HighlightOptions {
  /** Lines to set apart, counted from 1. */
  lines?: Record<number, Tone>;
  /** Pieces of the code to mark, each where it first appears. */
  marks?: { text: string; tone: Tone }[];
}

/** The grammar of the VS Code extension, so that the site and the editor colour .nexus alike. */
const nexus = { ...grammar, name: 'nexus', embeddedLangs: ['typescript', 'css'] } as unknown as LanguageRegistration;

let highlighter: Promise<Highlighter> | undefined;

function load(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: [codeTheme as ThemeRegistration],
    langs: ['typescript', 'javascript', 'jsx', 'css', 'lua', 'json', 'shellscript', nexus],
  });
  return highlighter;
}

/** Removes the indentation a sample has from sitting inside a page, and the blank lines around it. */
export function dedent(code: string): string {
  const lines = code.replace(/^\n+|\s+$/g, '').split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)![0].length));
  return lines.map((line) => line.slice(indent)).join('\n');
}

export async function highlight(code: string, lang: Lang, options: HighlightOptions = {}): Promise<string> {
  const shiki = await load();
  const { lines = {}, marks = [] } = options;

  const decorations = marks.map(({ text, tone }) => {
    const start = code.indexOf(text);
    if (start < 0) throw new Error(`The sample does not contain "${text}"`);
    return { start, end: start + text.length, properties: { class: `mark-${tone}` } };
  });

  return shiki.codeToHtml(code, {
    lang,
    theme: codeTheme.name,
    decorations,
    transformers: [
      {
        pre(node) {
          delete node.properties.style;
        },
        // Lines are laid out as rows, so the line breaks between them would add empty ones.
        code(node) {
          node.children = node.children.filter((child) => !(child.type === 'text' && child.value === '\n'));
        },
        line(node, line) {
          if (lines[line]) this.addClassToHast(node, `is-${lines[line]}`);
        },
      },
    ],
  });
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Marks up the output of a command as the terminal shows it: the status word, the code frame, the caret. */
export function terminal(output: string): string {
  return output
    .split('\n')
    .map((raw) => {
      const line = escape(raw);
      if (raw.startsWith('$ ')) return `<span class="t-line"><span class="t-dim">$</span> <span class="t-cmd">${line.slice(2)}</span></span>`;
      if (raw.startsWith('error ')) return `<span class="t-line"><span class="t-err">error</span>${line.slice(5)}</span>`;
      if (raw.startsWith('ok ')) return `<span class="t-line"><span class="t-ok">ok</span>${line.slice(2)}</span>`;
      if (/^&gt;\s*\d+ \|/.test(line)) return `<span class="t-line t-frame t-hot">${line}</span>`;
      if (/^\s+\|\s+\^+\s*$/.test(raw)) return `<span class="t-line t-frame t-err">${line}</span>`;
      if (/^\s+\d+ \|/.test(raw)) return `<span class="t-line t-frame t-dim">${line}</span>`;
      return `<span class="t-line">${line}</span>`;
    })
    .join('');
}
