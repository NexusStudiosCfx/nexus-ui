import type { Root } from './ast';
import { Cursor } from './cursor';
import type { Reporter } from './diagnostics';
import { parseTemplate } from './parse-template';

const OPENING_FENCE = /^\ufeff?(?:[ \t]*\r?\n)*---[ \t]*\r?\n/;
const CLOSING_FENCE = /^---[ \t]*$/m;

/** Parses a whole .nexus file: the script between `---` lines, then template and styles. */
export function parseFile(source: string, reporter: Reporter): Root {
  const root: Root = { type: 'Root', start: 0, end: source.length, script: null, screen: null, children: [], styles: [] };
  const cursor = new Cursor(source, reporter);

  const opening = OPENING_FENCE.exec(source);
  if (opening) {
    const fence = opening[0].indexOf('---');
    const contentStart = opening[0].length;
    const closing = CLOSING_FENCE.exec(source.slice(contentStart));
    if (!closing) {
      reporter.error({
        code: 'unclosed-script',
        message: 'The script that starts here is never closed.',
        hint: 'Add a line with only `---` after the last line of code.',
        start: fence,
        end: fence + 3,
      });
    }
    const contentEnd = contentStart + closing.index;
    root.script = {
      type: 'Script',
      start: fence,
      end: contentEnd + 3,
      content: { start: contentStart, end: contentEnd, code: source.slice(contentStart, contentEnd) },
    };
    cursor.index = contentEnd + closing[0].length;
  }

  parseTemplate(cursor, root);
  return root;
}
