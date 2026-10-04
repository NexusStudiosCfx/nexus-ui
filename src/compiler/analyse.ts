import type MagicString from 'magic-string';
import type { AttributeNode, Component, Directive, EachBlock, Element, Expression, Root, TemplateNode } from './ast';
import { checkScript } from './compat';
import type { DevNames } from './dev-calls';
import type { Reporter } from './diagnostics';
import { analyseExpression, analysePattern } from './expression';
import { checkNesting, rejectsText } from './nesting';
import { analyseScreen, type ScreenDeclaration } from './screen';
import { suggest } from './suggest';

export interface Analysis {
  /** Every identifier a template expression, a component tag or an action mentions. */
  names: Set<string>;
  /** The names bound by the item pattern of each `{#each}`. */
  patterns: Map<EachBlock, string[]>;
  screen: ScreenDeclaration | null;
}

const EVENT_MODIFIERS = ['prevent', 'stop', 'once', 'self', 'capture'];
const BINDINGS = ['value', 'checked', 'group', 'this'];
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const CLASS_NAME = /^[^\s"'<>=`{}]+$/;

interface Scope {
  /**
   * Tags of the enclosing elements that end up in the same piece of markup, nearest first. A
   * block, a component and a slot each start a new piece, which the browser parses on its own.
   */
  ancestors: string[];
  /** Names bound by the enclosing `{#each}` blocks, with how many names their binding declares. */
  bound: Map<string, number>;
  /** The nodes being visited are the direct children of a component. */
  slotted: boolean;
}

/** Validates the template and analyses every expression in it, in source order. */
export function analyseTemplate(root: Root, code: MagicString, reporter: Reporter, dev: DevNames | null = null): Analysis {
  const analysis: Analysis = { names: new Set(), patterns: new Map(), screen: root.screen ? analyseScreen(root.screen, reporter) : null };

  const read = (expression: Expression): ReturnType<typeof analyseExpression> => {
    const info = analyseExpression(expression, code, reporter, dev);
    for (const name of info.names) analysis.names.add(name);
    for (const issue of checkScript(expression.code)) {
      reporter.reject({ code: 'unsupported-api', ...issue, start: issue.start + expression.start, end: issue.end + expression.start });
    }
    return info;
  };

  /** The expression of a directive, or the name it is short for: `class:active` reads `active`. */
  const directiveExpression = (directive: Directive, required: boolean): Expression | null => {
    const { value } = directive;
    if (value === null) {
      if (required) {
        reporter.error({
          code: 'directive-missing-value',
          message: `\`${directive.kind}:${directive.name}\` needs a value.`,
          hint: `Write \`${directive.kind}:${directive.name}={...}\`.`,
          start: directive.start,
          end: directive.end,
        });
      }
      return null;
    }
    const only = value[0];
    if (value.length !== 1 || !only || only.type !== 'ExpressionTag') {
      return reporter.error({
        code: 'directive-value',
        message: `The value of \`${directive.kind}:${directive.name}\` must be one expression in braces.`,
        hint: `Write \`${directive.kind}:${directive.name}={...}\`.`,
        start: directive.start,
        end: directive.end,
      });
    }
    return only.expression;
  };

  const noModifiers = (directive: Directive): void => {
    const modifier = directive.modifiers[0];
    if (modifier) {
      reporter.error({
        code: 'unknown-modifier',
        message: `\`${directive.kind}:\` takes no modifiers.`,
        hint: `Remove \`|${modifier.name}\`. Modifiers exist for events: \`on:click|prevent\`.`,
        start: modifier.start,
        end: modifier.end,
      });
    }
  };

  function directive(node: Directive, element: Element): void {
    const staticType = element.attributes.find((attribute) => attribute.type === 'Attribute' && attribute.name === 'type');
    const type =
      staticType && staticType.type === 'Attribute' && staticType.value !== true && staticType.value.length === 1 && staticType.value[0]?.type === 'Text'
        ? staticType.value[0].data
        : null;

    switch (node.kind) {
      case 'on': {
        for (const modifier of node.modifiers) {
          if (!EVENT_MODIFIERS.includes(modifier.name)) {
            const close = suggest(modifier.name, EVENT_MODIFIERS);
            reporter.error({
              code: 'unknown-modifier',
              message: `\`${modifier.name}\` is not an event modifier.`,
              hint: close ? `Did you mean \`${close}\`?` : `The modifiers are ${EVENT_MODIFIERS.map((name) => `\`${name}\``).join(', ')}.`,
              start: modifier.start,
              end: modifier.end,
            });
          }
        }
        read(directiveExpression(node, true) as Expression);
        break;
      }

      case 'bind': {
        noModifiers(node);
        if (!BINDINGS.includes(node.name)) {
          const close = suggest(node.name, BINDINGS);
          reporter.error({
            code: 'unknown-binding',
            message: `\`bind:${node.name}\` does not exist.`,
            hint: close ? `Did you mean \`bind:${close}\`?` : 'The bindings are `bind:value`, `bind:checked`, `bind:group` and `bind:this`.',
            ...node.nameSpan,
          });
        }
        const tag = element.name;
        const wrong =
          node.name === 'value'
            ? !['input', 'textarea', 'select'].includes(tag) && '`<input>`, `<textarea>` and `<select>`'
            : node.name === 'checked'
              ? (tag !== 'input' || (type !== null && type !== 'checkbox' && type !== 'radio')) && '`<input type="checkbox">` and `<input type="radio">`'
              : node.name === 'group'
                ? (tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) && '`<input>` with a fixed `type="radio"` or `type="checkbox"`'
                : false;
        if (wrong) {
          reporter.error({
            code: 'invalid-binding',
            message: `\`bind:${node.name}\` cannot be used on this \`<${tag}>\`: it works on ${wrong}.`,
            hint: node.name === 'value' ? 'To set an attribute, write `value={...}`. To get the element itself, use `bind:this={ref}`.' : 'Check the tag and its `type`.',
            start: node.start,
            end: node.end,
          });
        }
        const expression = directiveExpression(node, node.name === 'this');
        if (expression) {
          const info = read(expression);
          if (info.kind !== 'identifier' && info.kind !== 'member') {
            reporter.error({
              code: 'invalid-binding',
              message: `\`bind:${node.name}\` needs something it can write to: a signal, or a property of a store.`,
              hint: `Create one in the script (\`const name = signal('')\`) and write \`bind:${node.name}={name}\`.`,
              start: expression.start,
              end: expression.end,
            });
          }
        } else {
          analysis.names.add(node.name);
        }
        break;
      }

      case 'class':
      case 'transition': {
        noModifiers(node);
        if (!CLASS_NAME.test(node.name)) {
          reporter.error({
            code: 'invalid-class-name',
            message: `\`${node.name}\` is not a usable class name.`,
            hint: 'Use letters, digits, `-` and `_`.',
            ...node.nameSpan,
          });
        }
        if (node.kind === 'transition') {
          if (node.value !== null) {
            reporter.error({
              code: 'directive-value',
              message: '`transition:` takes a name and no value.',
              hint: `Write \`transition:${node.name}\`, and put the element in an \`{#if}\` to control when it appears.`,
              start: node.start,
              end: node.end,
            });
          }
          break;
        }
        const expression = directiveExpression(node, false);
        if (expression) read(expression);
        else analysis.names.add(node.name);
        break;
      }

      case 'style': {
        noModifiers(node);
        if (node.value === null) analysis.names.add(node.name);
        else for (const part of node.value) if (part.type === 'ExpressionTag') read(part.expression);
        break;
      }

      case 'use': {
        noModifiers(node);
        if (!PATH.test(node.name)) {
          reporter.error({
            code: 'invalid-action',
            message: `\`use:${node.name}\` must name a function, as in \`use:tooltip\` or \`use:actions.tooltip\`.`,
            hint: 'Import or declare the function in the script and use its name.',
            ...node.nameSpan,
          });
        }
        analysis.names.add(node.name.split('.')[0] as string);
        const expression = directiveExpression(node, false);
        if (expression) read(expression);
        break;
      }
    }
  }

  function attributes(node: Element | Component, scope: Scope): void {
    let dynamicStyle: AttributeNode | undefined;
    let styleDirective: AttributeNode | undefined;

    for (const attribute of node.attributes) {
      if (attribute.type === 'Spread') {
        read(attribute.expression);
      } else if (attribute.type === 'Attribute') {
        if (attribute.value !== true) {
          for (const part of attribute.value) if (part.type === 'ExpressionTag') read(part.expression);
          if (attribute.name === 'style' && attribute.value.some((part) => part.type === 'ExpressionTag')) dynamicStyle = attribute;
        }
        if (attribute.name === 'slot') {
          const fixed = attribute.value !== true && attribute.value.length === 1 && attribute.value[0]?.type === 'Text';
          if (!scope.slotted || !fixed) {
            reporter.error({
              code: 'invalid-slot',
              message: scope.slotted
                ? 'The value of `slot` must be a fixed name.'
                : '`slot="..."` only has a meaning on a direct child of a component.',
              hint: scope.slotted ? 'Write `slot="footer"`.' : 'Move this element directly inside the component tag, or remove the attribute.',
              start: attribute.start,
              end: attribute.end,
            });
          }
        }
      } else if (node.type !== 'Element') {
        reporter.error({
          code: 'directive-on-component',
          message: `\`${attribute.kind}:${attribute.name}\` cannot be used on \`<${node.name}>\`: directives work on elements.`,
          hint:
            attribute.kind === 'on'
              ? `Pass the handler as a prop, for example \`on${attribute.name[0]?.toUpperCase()}${attribute.name.slice(1)}={handler}\`, and call it inside the component.`
              : 'Put the directive on an element inside the component, or wrap the component in an element.',
          start: attribute.start,
          end: attribute.end,
        });
      } else {
        directive(attribute, node);
        if (attribute.kind === 'style') styleDirective = attribute;
      }
    }

    if (dynamicStyle && styleDirective) {
      reporter.warn({
        code: 'style-conflict',
        message: 'When this `style` attribute changes it replaces the whole inline style, including what `style:` directives set.',
        hint: 'Use only `style:` directives on this element, or only the `style` attribute.',
        start: dynamicStyle.start,
        end: dynamicStyle.end,
      });
    }
  }

  function visit(nodes: TemplateNode[], scope: Scope): void {
    const inside = scope.ancestors[0];
    for (const node of nodes) {
      switch (node.type) {
        case 'Text':
        case 'ExpressionTag':
        case 'HtmlTag': {
          const blank = node.type === 'Text' && !/[^ \t\r\n\f]/.test(node.data);
          if (!blank && rejectsText(inside)) {
            reporter.error({
              code: 'invalid-nesting',
              message: `Text cannot be directly inside \`<${inside}>\`: the browser moves it out.`,
              hint: 'Put it in a cell: `<td>...</td>`.',
              start: node.start,
              end: node.end,
            });
          }
          if (node.type !== 'Text') read(node.expression);
          break;
        }

        case 'Element': {
          const problem = checkNesting(node.name, scope.ancestors);
          if (problem) {
            reporter.error({ code: 'invalid-nesting', ...problem, start: node.start, end: node.start + node.name.length + 1 });
          }
          attributes(node, scope);
          visit(node.children, { ...scope, ancestors: [node.name, ...scope.ancestors], slotted: false });
          break;
        }

        case 'Component':
          if (!PATH.test(node.name)) {
            reporter.error({
              code: 'invalid-component',
              message: `\`<${node.name}>\` is not a valid component name.`,
              hint: 'A component tag is the name it was imported under, as in `<Price>` or `<ui.Button>`.',
              start: node.start,
              end: node.start + node.name.length + 1,
            });
          }
          analysis.names.add(node.name.split('.')[0] as string);
          attributes(node, scope);
          visit(node.children, { ...scope, ancestors: [], slotted: true });
          break;

        case 'Slot':
          visit(node.children, { ...scope, ancestors: [], slotted: false });
          break;

        case 'IfBlock':
          for (const branch of node.branches) {
            if (branch.test) read(branch.test);
            visit(branch.children, { ...scope, ancestors: [], slotted: false });
          }
          break;

        case 'KeyBlock':
          read(node.expression);
          visit(node.children, { ...scope, ancestors: [], slotted: false });
          break;

        case 'EachBlock': {
          read(node.expression);
          const names = analysePattern(node.item, reporter);
          analysis.patterns.set(node, names);
          const bound = new Map(scope.bound);
          const own = new Set<string>();
          const bind = (name: string, start: number, end: number, declared: number): void => {
            if (name === 'props' || name.startsWith('$')) {
              reporter.error({
                code: 'reserved-name',
                message: name === 'props' ? '`props` is already in scope and cannot be an item name.' : `\`${name}\` cannot be used: names that start with \`$\` are reserved for the compiler.`,
                hint: 'Pick another name for it.',
                start,
                end,
              });
            }
            // A plain name can be used again further in, where it hides the outer one. A name that
            // an outer block takes from its item together with others cannot be hidden on its own.
            const shared = (bound.get(name) ?? 1) > 1;
            if (own.has(name) || shared) {
              reporter.error({
                code: 'duplicate-binding',
                message: own.has(name)
                  ? `\`${name}\` is bound twice in this \`{#each}\`.`
                  : `\`${name}\` is one of several names that an enclosing \`{#each}\` takes from its item, so it cannot be bound again here.`,
                hint: 'Give it a different name here, so both can be read inside the block.',
                start,
                end,
              });
            }
            own.add(name);
            bound.set(name, declared);
            analysis.names.add(name);
          };
          for (const name of names) bind(name, node.item.start, node.item.end, names.length);
          if (node.index) bind(node.index.name, node.index.start, node.index.end, 1);

          if (node.key) {
            const info = read(node.key);
            if (![...own].some((name) => info.names.has(name))) {
              reporter.error({
                code: 'key-without-item',
                message: `The key \`(${node.key.code})\` does not use the item, so every row would get the same key.`,
                hint: `Compute it from the item, for example \`(${names[0] ?? 'item'}.id)\`.`,
                start: node.key.start,
                end: node.key.end,
              });
            }
          }
          visit(node.children, { ancestors: [], bound, slotted: false });
          if (node.fallback) visit(node.fallback, { ...scope, ancestors: [], slotted: false });
          break;
        }
      }
    }
  }

  visit(root.children, { ancestors: [], bound: new Map(), slotted: false });
  return analysis;
}
