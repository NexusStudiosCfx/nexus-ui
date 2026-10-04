import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const ink = '#f4f4f5';
const soft = '#d4d4d8';
const muted = '#a1a1aa';
const faint = '#71717a';
const ghost = '#52525b';
const lime = '#c8ff3d';
const limeDim = '#a4c94a';
const limePale = '#dcf5a3';
const danger = '#f87171';

const chrome = EditorView.theme(
  {
    '&': { height: '100%', color: soft, backgroundColor: 'transparent', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
      fontWeight: '400',
      fontVariantLigatures: 'none',
      lineHeight: '1.65',
      overflow: 'auto',
    },
    '.cm-content': { padding: '14px 0', caretColor: lime },
    '.cm-line': { padding: '0 16px 0 6px' },
    '.cm-gutters': { backgroundColor: 'transparent', color: ghost, border: 'none', paddingLeft: '6px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px', minWidth: '28px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.025)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: muted },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: lime, borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(200, 255, 61, 0.16)',
    },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(200, 255, 61, 0.14)', outline: '1px solid rgba(200, 255, 61, 0.3)', color: 'inherit' },
    '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'rgba(248, 113, 113, 0.14)', color: 'inherit' },
    '.cm-problem': { textDecoration: 'underline wavy', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
    '.cm-problem-error': { textDecorationColor: danger },
    '.cm-problem-warning': { textDecorationColor: '#fbbf24' },
    '.cm-problemLine': { backgroundColor: 'rgba(248, 113, 113, 0.07)' },
  },
  { dark: true },
);

const colours = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self, t.null], color: lime },
  { tag: [t.tagName, t.standard(t.tagName)], color: lime },
  { tag: [t.angleBracket, t.punctuation, t.separator, t.derefOperator, t.bracket], color: faint },
  { tag: [t.operator, t.definitionOperator, t.compareOperator, t.logicOperator, t.arithmeticOperator, t.updateOperator], color: muted },
  { tag: [t.string, t.special(t.string), t.attributeValue, t.regexp, t.escape], color: limePale },
  { tag: [t.number, t.bool, t.atom, t.unit, t.color], color: limePale },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: ink },
  { tag: [t.variableName, t.definition(t.variableName), t.local(t.variableName)], color: soft },
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName, t.labelName, t.className], color: soft },
  { tag: [t.typeName, t.namespace, t.typeOperator], color: muted, fontStyle: 'italic' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: faint, fontStyle: 'italic' },
  { tag: [t.meta, t.documentMeta, t.processingInstruction], color: ghost },
  { tag: t.special(t.brace), color: limeDim },
  { tag: [t.heading, t.strong], color: ink, fontWeight: '600' },
  { tag: t.content, color: soft },
  { tag: t.invalid, color: danger },
]);

/** The editor's look: zinc text on the panel behind it, lime for keywords and tags. */
export const editorTheme: Extension = [chrome, syntaxHighlighting(colours)];
