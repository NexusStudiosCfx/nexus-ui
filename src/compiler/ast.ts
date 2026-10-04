/** Every node carries the offsets of its text in the source file. */
export interface Span {
  start: number;
  end: number;
}

/** A JavaScript or TypeScript expression, exactly as written. */
export interface Expression extends Span {
  type: 'Expression';
  code: string;
}

export interface Root extends Span {
  type: 'Root';
  script: Script | null;
  /** The `<screen>` declaration, when the file has one. */
  screen: ScreenTag | null;
  children: TemplateNode[];
  styles: Style[];
}

export interface Script extends Span {
  type: 'Script';
  /** The code between the two `---` lines. */
  content: Span & { code: string };
}

export interface Style extends Span {
  type: 'Style';
  /** `<style global>`: selectors are left as written. */
  global: boolean;
  content: Span & { code: string };
}

export interface ScreenTag extends Span {
  type: 'Screen';
  attributes: Attribute[];
}

export type TemplateNode = Text | ExpressionTag | HtmlTag | Element | Component | Slot | IfBlock | EachBlock | KeyBlock;

export interface Text extends Span {
  type: 'Text';
  /** The text with character references decoded. */
  data: string;
}

export interface ExpressionTag extends Span {
  type: 'ExpressionTag';
  expression: Expression;
}

export interface HtmlTag extends Span {
  type: 'HtmlTag';
  expression: Expression;
}

export type AttributeNode = Attribute | Spread | Directive;

export interface Element extends Span {
  type: 'Element';
  name: string;
  attributes: AttributeNode[];
  children: TemplateNode[];
}

export interface Component extends Span {
  type: 'Component';
  name: string;
  attributes: AttributeNode[];
  children: TemplateNode[];
}

export interface Slot extends Span {
  type: 'Slot';
  /** `default` unless the tag has a `name` attribute. */
  name: string;
  attributes: AttributeNode[];
  /** Fallback content. */
  children: TemplateNode[];
}

export interface Attribute extends Span {
  type: 'Attribute';
  name: string;
  /** `true` for a bare attribute, otherwise the text and expression parts of the value. */
  value: true | (Text | ExpressionTag)[];
}

export interface Spread extends Span {
  type: 'Spread';
  expression: Expression;
}

export type DirectiveKind = 'on' | 'bind' | 'class' | 'style' | 'use' | 'transition';

export interface Directive extends Span {
  type: 'Directive';
  kind: DirectiveKind;
  /** What follows the colon: the event, the property, the class, the action or the transition. */
  name: string;
  /** The span of `name`, for diagnostics. */
  nameSpan: Span;
  modifiers: (Span & { name: string })[];
  /** `null` when the directive has no value, as in `transition:fade` or `class:active`. */
  value: null | (Text | ExpressionTag)[];
}

export interface IfBlock extends Span {
  type: 'IfBlock';
  /** In source order. Only the last branch may have no test: that is `{:else}`. */
  branches: IfBranch[];
}

export interface IfBranch extends Span {
  test: Expression | null;
  children: TemplateNode[];
}

export interface EachBlock extends Span {
  type: 'EachBlock';
  expression: Expression;
  /** The item binding: a name or a destructuring pattern. */
  item: Expression;
  index: (Span & { name: string }) | null;
  key: Expression | null;
  children: TemplateNode[];
  /** The `{:else}` content, shown while the list is empty. */
  fallback: TemplateNode[] | null;
}

export interface KeyBlock extends Span {
  type: 'KeyBlock';
  expression: Expression;
  children: TemplateNode[];
}
