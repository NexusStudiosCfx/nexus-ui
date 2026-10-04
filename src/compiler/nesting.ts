/**
 * Markup the HTML parser rearranges. The compiler walks to nodes by position in the cloned
 * template (`first child`, `next sibling`), so a child the browser moves or wraps would send
 * every binding after it to the wrong node. These cases are rejected instead.
 */

const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dd', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul',
]);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// What each table part may contain directly.
const TABLE_CHILDREN: Record<string, string[]> = {
  table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot'],
  thead: ['tr'],
  tbody: ['tr'],
  tfoot: ['tr'],
  tr: ['td', 'th'],
  colgroup: ['col'],
  select: ['option', 'optgroup', 'hr'],
  optgroup: ['option'],
};

// An element of the first kind cannot be anywhere inside one of the second.
const NO_DESCENDANT: Record<string, string> = { a: 'a', button: 'button', form: 'form' };

export interface NestingProblem {
  message: string;
  hint: string;
}

/**
 * Checks a child element against its nearest ancestor elements in the same file.
 * `ancestors` is ordered from the parent outwards.
 */
export function checkNesting(child: string, ancestors: string[]): NestingProblem | null {
  const parent = ancestors[0];
  if (!parent) return null;

  const allowed = TABLE_CHILDREN[parent];
  if (allowed && !allowed.includes(child)) {
    if (parent === 'table' && child === 'tr') {
      return {
        message: 'The browser wraps a `<tr>` that is directly inside `<table>` in a `<tbody>`.',
        hint: 'Write the `<tbody>` yourself: `<table><tbody><tr>...</tr></tbody></table>`.',
      };
    }
    return {
      message: `\`<${child}>\` cannot be directly inside \`<${parent}>\`: the browser moves it out.`,
      hint: `\`<${parent}>\` may contain ${allowed.map((name) => `\`<${name}>\``).join(', ')}.`,
    };
  }

  if (parent === 'p' && CLOSES_P.has(child)) {
    return {
      message: `\`<${child}>\` cannot be inside \`<p>\`: the browser closes the paragraph in front of it.`,
      hint: 'Use a `<div>` instead of the `<p>`, or a `<span>` inside it.',
    };
  }

  if (HEADINGS.has(parent) && HEADINGS.has(child)) {
    return {
      message: `\`<${child}>\` cannot be inside \`<${parent}>\`: the browser closes the outer heading first.`,
      hint: 'Use a `<span>` for the inner text.',
    };
  }

  const outer = NO_DESCENDANT[child];
  if (outer && ancestors.includes(outer)) {
    return {
      message: `\`<${child}>\` cannot be inside another \`<${outer}>\`: the browser closes the outer one first.`,
      hint: `Move the inner \`<${child}>\` out, or make one of them a \`<div>\` or a \`<span>\`.`,
    };
  }

  return null;
}

/** True when text placed directly in this element would be moved out of it by the browser. */
export function rejectsText(parent: string | undefined): boolean {
  return !!parent && parent in TABLE_CHILDREN && parent !== 'select' && parent !== 'optgroup';
}
