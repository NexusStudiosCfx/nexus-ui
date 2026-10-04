import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { Problem } from '../engine/build';
import { nexus } from './nexus-language';
import { editorTheme } from './theme';

export interface EditorEvents {
  change(name: string, text: string): void;
  /** The caret moved. Both are 1-based. */
  cursor(line: number, column: number): void;
}

export interface CodeEditor {
  /** Shows a file. Each file keeps its own undo history and caret until `forget`. */
  open(name: string, text: string): void;
  /** Drops what is remembered of every file, for when the project is replaced. */
  forget(): void;
  /** Underlines the problems of the open file. */
  mark(problems: Problem[]): void;
  /** Puts the caret at a position and scrolls to it. */
  reveal(line: number, column: number): void;
  focus(): void;
  destroy(): void;
}

function languageOf(name: string): Extension {
  if (name.endsWith('.nexus')) return nexus();
  if (name.endsWith('.json')) return json();
  return javascript({ typescript: name.endsWith('.ts') });
}

const setProblems = StateEffect.define<DecorationSet>();

const problems = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setProblems)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const base: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  drawSelection(),
  bracketMatching(),
  indentUnit.of('  '),
  EditorState.tabSize.of(2),
  editorTheme,
];

const editing: Extension = [history(), indentOnInput(), closeBrackets(), problems, keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab])];

export function createEditor(parent: HTMLElement, root: ShadowRoot | Document, events: EditorEvents): CodeEditor {
  const states = new Map<string, EditorState>();
  let current = '';

  const report = (state: EditorState): void => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    events.cursor(line.number, head - line.from + 1);
  };

  const listener = EditorView.updateListener.of((update) => {
    if (update.docChanged) events.change(current, update.state.doc.toString());
    if (update.docChanged || update.selectionSet) report(update.state);
  });

  const create = (name: string, text: string): EditorState =>
    EditorState.create({
      doc: text,
      extensions: [base, editing, languageOf(name), listener, EditorView.contentAttributes.of({ 'aria-label': `${name}, editable`, spellcheck: 'false' })],
    });

  const view = new EditorView({ parent, root });

  return {
    open(name, text) {
      if (current) states.set(current, view.state);
      const known = states.get(name);
      current = name;
      view.setState(known && known.doc.toString() === text ? known : create(name, text));
      report(view.state);
    },
    forget() {
      states.clear();
      current = '';
    },
    mark(found) {
      const { doc } = view.state;
      const marks: Range<Decoration>[] = [];
      for (const problem of found) {
        if (problem.start === undefined) continue;
        const from = Math.min(problem.start, doc.length);
        const line = doc.lineAt(from);
        // A position at the end of a line still gets something to underline.
        const to = Math.min(Math.max(problem.end ?? from, from + 1), line.to);
        const start = to > from ? from : Math.max(line.from, from - 1);
        if (problem.severity === 'error') marks.push(Decoration.line({ class: 'cm-problemLine' }).range(line.from));
        if (to > start) marks.push(Decoration.mark({ class: `cm-problem cm-problem-${problem.severity}`, attributes: { title: problem.message } }).range(start, to));
      }
      view.dispatch({ effects: setProblems.of(Decoration.set(marks, true)) });
    },
    reveal(line, column) {
      const { doc } = view.state;
      const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
      const anchor = Math.min(target.to, target.from + Math.max(0, column - 1));
      view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export interface CodeViewer {
  show(code: string): void;
  destroy(): void;
}

/** A read-only view of JavaScript, for the output of the compiler. */
export function createViewer(parent: HTMLElement, root: ShadowRoot | Document): CodeViewer {
  const extensions = [base, javascript(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': 'Compiled JavaScript, read only', tabindex: '0' })];
  const view = new EditorView({ parent, root });
  let shown: string | null = null;
  return {
    show(code) {
      if (code === shown) return;
      shown = code;
      const top = view.scrollDOM.scrollTop;
      view.setState(EditorState.create({ doc: code, extensions }));
      view.scrollDOM.scrollTop = top;
    },
    destroy: () => view.destroy(),
  };
}
