/**
 * The code theme of the site: zinc text on a zinc surface, lime for what a language reserves,
 * sand for literals and a quiet blue for types. Used by the docs and by the landing page.
 */
const ink = '#e4e4e7';
const soft = '#c4c4cc';
const muted = '#8f8f9a';
const faint = '#7f7f8b';
const lime = '#c8ff3d';
const limeHigh = '#dcff86';
const sand = '#f0cf8e';
const clay = '#eba57c';
const steel = '#a3c3e0';

const rule = (scope, foreground, fontStyle) => ({
  scope,
  settings: fontStyle ? { foreground, fontStyle } : { foreground },
});

export const codeTheme = {
  name: 'nexus-zinc',
  type: 'dark',
  colors: {
    'editor.background': '#0d0d10',
    'editor.foreground': ink,
    'editor.selectionBackground': '#c8ff3d33',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorLineNumber.foreground': '#3f3f46',
    'editorLineNumber.activeForeground': muted,
    'titleBar.activeBackground': '#111113',
    'titleBar.border': '#ffffff12',
    'tab.activeBackground': '#0d0d10',
    'tab.activeBorderTop': lime,
    'tab.activeForeground': ink,
    'editorGroupHeader.tabsBackground': '#111113',
    'editorGroupHeader.tabsBorder': '#ffffff12',
    'terminal.background': '#0d0d10',
    'terminal.foreground': ink,
    'focusBorder': lime,
  },
  tokenColors: [
    rule(['comment', 'punctuation.definition.comment', 'string.comment'], faint, 'italic'),

    rule(
      [
        'punctuation',
        'meta.brace',
        'keyword.operator',
        'punctuation.definition.tag',
        'punctuation.separator',
        'punctuation.terminator',
        'meta.embedded punctuation',
      ],
      muted,
    ),

    rule(
      [
        'keyword',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.lua',
        'storage',
        'storage.type',
        'storage.modifier',
        'variable.language.this',
        'punctuation.section.embedded.begin.nexus',
        'punctuation.section.embedded.end.nexus',
        'punctuation.definition.keyword.nexus',
      ],
      lime,
    ),

    rule(['variable', 'variable.other', 'variable.parameter', 'meta.object-literal.key', 'variable.other.property'], soft),
    rule(['variable.other.readwrite', 'variable.other.constant', 'variable.other.object'], ink),

    rule(['entity.name.function', 'support.function', 'meta.function-call entity.name', 'variable.function'], '#ffffff'),

    rule(
      [
        'entity.name.type',
        'entity.name.class',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'meta.type.annotation entity.name',
      ],
      steel,
    ),

    rule(['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], sand),
    rule(['string.regexp', 'constant.character.escape', 'constant.other.placeholder'], clay),
    rule(['constant.numeric', 'constant.language', 'constant.character.entity', 'keyword.other.unit', 'support.constant'], clay),

    rule(['entity.name.tag', 'keyword.control.screen.nexus', 'meta.tag.screen.nexus entity.name.tag'], lime),
    rule(['support.class.component.nexus'], limeHigh),
    rule(['entity.other.attribute-name'], '#a9a9b4'),
    rule(['keyword.control.directive.nexus', 'entity.other.attribute-name.directive.nexus', 'storage.modifier.nexus'], limeHigh),

    rule(
      ['entity.other.attribute-name.class.css', 'entity.other.attribute-name.id.css', 'entity.name.tag.css'],
      limeHigh,
    ),
    rule(['support.type.property-name', 'meta.property-name', 'variable.css', 'support.type.vendored.property-name'], soft),
    rule(['support.constant.property-value', 'meta.property-value', 'support.constant.color', 'constant.other.color'], sand),
    rule(['entity.other.attribute-name.pseudo-class', 'entity.other.attribute-name.pseudo-element', 'keyword.control.at-rule'], lime),

    rule(['support.type.property-name.json', 'string.json support.type.property-name'], soft),

    rule(['markup.heading', 'entity.name.section'], lime, 'bold'),
    rule(['markup.bold'], ink, 'bold'),
    rule(['markup.italic'], ink, 'italic'),
    rule(['markup.inline.raw', 'markup.fenced_code'], sand),
    rule(['markup.inserted'], '#4ade80'),
    rule(['markup.deleted'], '#f87171'),
    rule(['invalid'], '#f87171'),
  ],
};
