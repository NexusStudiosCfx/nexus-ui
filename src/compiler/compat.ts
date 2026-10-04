/**
 * What FiveM's browser (Chromium 103) cannot run. A stylesheet or script that uses one of these
 * works in a current browser during development and then fails in game, silently for CSS, so
 * they are reported while compiling.
 */

import type { Span } from './ast';
import { CssError, parseCss, type CssBlock, type CssNode } from './css';
import { maskCode } from './lexer';

export interface CompatIssue extends Span {
  message: string;
  hint: string;
}

interface Feature {
  /** How the feature is named in the message. */
  name: string;
  /** The first Chromium version that has it. */
  since: number;
  hint: string;
}

const describe = (feature: Feature): string => `${feature.name} needs Chromium ${feature.since}. FiveM runs Chromium 103.`;

const USE_CLASS = 'Set a class with `class:name={condition}` and style that class.';
const USE_TRANSFORM = 'Use `transform`, for example `transform: translate(10px, 0) rotate(5deg) scale(1.1)`.';
const USE_RGB = 'Write the colour as `rgb()`, `hsl()` or hex.';
const USE_MEDIA = 'Use `@media`, or size things from the design size of the screen (`<screen size="1920x1080">`).';
const USE_SCRIPT = 'Compute the value in script and set it with `style:property={value}`.';

const AT_RULES: Record<string, Feature> = {
  container: { name: '`@container`', since: 105, hint: USE_MEDIA },
  scope: { name: '`@scope`', since: 118, hint: 'Styles in a .nexus file are already scoped to the component.' },
  'starting-style': { name: '`@starting-style`', since: 117, hint: 'Use `transition:name` and style `.name-enter`.' },
  'view-transition': { name: '`@view-transition`', since: 126, hint: 'Use `transition:name` on the elements that change.' },
  'position-try': { name: '`@position-try`', since: 125, hint: 'Position the element from script.' },
};

const PROPERTIES: Record<string, Feature> = {
  translate: { name: 'The `translate` property', since: 104, hint: USE_TRANSFORM },
  rotate: { name: 'The `rotate` property', since: 104, hint: USE_TRANSFORM },
  scale: { name: 'The `scale` property', since: 104, hint: USE_TRANSFORM },
  container: { name: '`container`', since: 105, hint: USE_MEDIA },
  'container-type': { name: '`container-type`', since: 105, hint: USE_MEDIA },
  'container-name': { name: '`container-name`', since: 105, hint: USE_MEDIA },
  'text-wrap': { name: '`text-wrap`', since: 114, hint: 'Use `white-space`, or break the line yourself.' },
  'scrollbar-width': { name: '`scrollbar-width`', since: 121, hint: 'Style `::-webkit-scrollbar` instead.' },
  'scrollbar-color': { name: '`scrollbar-color`', since: 121, hint: 'Style `::-webkit-scrollbar-thumb` and `::-webkit-scrollbar-track` instead.' },
  'animation-timeline': { name: '`animation-timeline`', since: 115, hint: 'Drive the animation from a scroll listener.' },
  'view-transition-name': { name: '`view-transition-name`', since: 111, hint: 'Use `transition:name` on the elements that change.' },
  'anchor-name': { name: '`anchor-name`', since: 125, hint: 'Position the element from script.' },
  'position-anchor': { name: '`position-anchor`', since: 125, hint: 'Position the element from script.' },
  'transition-behavior': { name: '`transition-behavior`', since: 117, hint: 'Use `transition:name` to animate an element that appears or disappears.' },
  'field-sizing': { name: '`field-sizing`', since: 123, hint: 'Size the field from script.' },
};

interface Pattern extends Feature {
  pattern: RegExp;
}

const VALUES: Pattern[] = [
  { pattern: /\bcolor-mix\(/g, name: '`color-mix()`', since: 111, hint: `${USE_RGB} For transparency, \`rgb(255 0 0 / 50%)\` works.` },
  { pattern: /\b(?:oklch|oklab|lab|lch)\(/g, name: 'This colour function', since: 111, hint: USE_RGB },
  { pattern: /(?<![\w-])color\(/g, name: '`color()`', since: 111, hint: USE_RGB },
  { pattern: /\blight-dark\(/g, name: '`light-dark()`', since: 123, hint: USE_RGB },
  { pattern: /\b(?:rgba?|hsla?|hwb)\(\s*from\b/g, name: 'Relative colour syntax', since: 119, hint: USE_RGB },
  { pattern: /(?<![\w-])[\d.]+[dsl]v(?:h|w|i|b|min|max)\b/g, name: 'The `dvh`, `svh` and `lvh` family of units', since: 108, hint: 'Use `vh` and `vw`.' },
  { pattern: /(?<![\w-])[\d.]+cq(?:w|h|i|b|min|max)\b/g, name: 'Container query units', since: 105, hint: 'Use `%`, `vw` or `vh`.' },
  { pattern: /(?<![\w-])[\d.]+r?lh\b/g, name: 'The `lh` unit', since: 109, hint: 'Use `em`, matching the line height.' },
  { pattern: /\bsubgrid\b/g, name: '`subgrid`', since: 117, hint: 'Repeat the track sizes of the parent grid.' },
  { pattern: /(?<![\w-])linear\(/g, name: 'The `linear()` easing function', since: 113, hint: 'Use `cubic-bezier()` or keyframes.' },
  { pattern: /(?<![\w-])(?:sin|cos|tan|asin|acos|atan|atan2)\(/g, name: 'This math function', since: 111, hint: USE_SCRIPT },
  { pattern: /(?<![\w-])(?:pow|sqrt|hypot|exp|log)\(/g, name: 'This math function', since: 120, hint: USE_SCRIPT },
  { pattern: /(?<![\w-])(?:round|mod|rem)\(/g, name: 'This math function', since: 125, hint: USE_SCRIPT },
  { pattern: /(?<![\w-])anchor(?:-size)?\(/g, name: '`anchor()`', since: 125, hint: 'Position the element from script.' },
  { pattern: /(?<!-webkit-)\bimage-set\(/g, name: 'Unprefixed `image-set()`', since: 113, hint: 'Write `-webkit-image-set()`.' },
];

const SELECTORS: Pattern[] = [
  { pattern: /:has\(/g, name: '`:has()`', since: 105, hint: USE_CLASS },
  { pattern: /:(?:user-valid|user-invalid)\b/g, name: 'This pseudo-class', since: 119, hint: 'Use `:valid` and `:invalid`, or a class.' },
  { pattern: /:popover-open\b/g, name: '`:popover-open`', since: 114, hint: USE_CLASS },
];

const MEDIA_RANGE: Feature = { name: 'Range syntax in a media query', since: 104, hint: 'Write `(min-width: 600px)` and `(max-width: 900px)`.' };
const NESTING: Feature = { name: 'CSS nesting', since: 112, hint: 'Write the full selector as a separate rule, for example `.card .title { ... }`.' };

// At-rules whose block holds rules. Anything else that holds a block is a style rule or holds declarations.
const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'document']);
const KEYFRAMES = /^(?:-webkit-)?keyframes$/;

const MASK = /^mask(?:-image|-size|-position|-repeat|-origin|-clip|-composite)?$/;

function scan(source: string, span: Span, patterns: Pattern[], issues: CompatIssue[]): void {
  // Comments and strings are not code: `content: ":has("` is fine.
  const text = source.slice(span.start, span.end).replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (hidden) => ' '.repeat(hidden.length));
  for (const feature of patterns) {
    for (const match of text.matchAll(feature.pattern)) {
      const start = span.start + match.index;
      issues.push({ start, end: start + match[0].length, message: describe(feature), hint: feature.hint });
    }
  }
}

function checkDeclarations(source: string, block: CssBlock, issues: CompatIssue[]): void {
  const names = new Set<string>();
  for (const child of block.children) if (child.type === 'statement' && child.property) names.add(child.property.name);

  for (const child of block.children) {
    if (child.type !== 'statement' || !child.property) continue;
    const { name } = child.property;
    const feature = PROPERTIES[name];
    if (feature) issues.push({ ...child.property, message: describe(feature), hint: feature.hint });
    scan(source, child.value, VALUES, issues);

    if (MASK.test(name) && !names.has(`-webkit-${name}`)) {
      issues.push({
        ...child.property,
        message: `Chromium 103 only knows \`-webkit-${name}\`, so this \`${name}\` has no effect in game.`,
        hint: `Add the same value as \`-webkit-${name}\` above this line.`,
      });
    }
    if (name === 'background-clip' && /\btext\b/.test(source.slice(child.value.start, child.value.end)) && !names.has('-webkit-background-clip')) {
      issues.push({
        ...child.property,
        message: 'Chromium 103 only knows `-webkit-background-clip: text`, so this has no effect in game.',
        hint: 'Add `-webkit-background-clip: text;` above this line.',
      });
    }
  }
}

function checkNodes(source: string, nodes: CssNode[], parent: CssBlock | null, issues: CompatIssue[]): void {
  for (const node of nodes) {
    if (node.type === 'statement') continue;

    if (node.at === null) {
      // A style rule inside a style rule is nesting. Inside `@keyframes` it is a step.
      const nested = parent !== null && parent.at === null;
      if (nested) issues.push({ ...node.prelude, message: describe(NESTING), hint: NESTING.hint });
      scan(source, node.prelude, SELECTORS, issues);
      checkDeclarations(source, node, issues);
      checkNodes(source, node.children, node, issues);
      continue;
    }

    const feature = AT_RULES[node.at];
    if (feature) issues.push({ start: node.start, end: node.start + node.at.length + 1, message: describe(feature), hint: feature.hint });
    if (node.at === 'media' && /[<>]/.test(source.slice(node.prelude.start, node.prelude.end))) {
      issues.push({ ...node.prelude, message: describe(MEDIA_RANGE), hint: MEDIA_RANGE.hint });
    }
    if (GROUPING.has(node.at)) {
      if (parent !== null && parent.at === null) issues.push({ start: node.start, end: node.start + node.at.length + 1, message: describe(NESTING), hint: NESTING.hint });
      // What is inside `@supports` is the author's own fallback for a missing feature.
      if (node.at !== 'supports') checkNodes(source, node.children, null, issues);
    } else if (KEYFRAMES.test(node.at)) {
      for (const step of node.children) if (step.type === 'block') checkDeclarations(source, step, issues);
    } else {
      checkDeclarations(source, node, issues);
    }
  }
}

/** The uses of CSS features that Chromium 103 lacks, in already parsed CSS. */
export function checkCssNodes(source: string, nodes: CssNode[]): CompatIssue[] {
  const issues: CompatIssue[] = [];
  checkNodes(source, nodes, null, issues);
  return issues.sort((a, b) => a.start - b.start);
}

/** The uses of CSS features that Chromium 103 lacks, in a stylesheet. Unparsable CSS has none. */
export function checkCss(source: string): CompatIssue[] {
  try {
    return checkCssNodes(source, parseCss(source, 0, source.length));
  } catch (error) {
    if (error instanceof CssError) return [];
    throw error;
  }
}

const AFTER_110 = 'Copy the array first: `[...list].sort()`, `[...list].reverse()`, `list.slice()` then `splice`.';

const APIS: Pattern[] = [
  { pattern: /\.(?:toSorted|toReversed|toSpliced)\(/g, name: 'This array method', since: 110, hint: AFTER_110 },
  { pattern: /\b(?:Object|Map)\.groupBy\(/g, name: '`groupBy`', since: 117, hint: 'Group with a loop or `reduce`.' },
  { pattern: /\bArray\.fromAsync\(/g, name: '`Array.fromAsync`', since: 121, hint: 'Use `for await` and push into an array.' },
  { pattern: /\bPromise\.withResolvers\(/g, name: '`Promise.withResolvers`', since: 119, hint: 'Use `new Promise((resolve, reject) => { ... })`.' },
  { pattern: /\bPromise\.try\(/g, name: '`Promise.try`', since: 128, hint: 'Use `new Promise((resolve) => resolve(fn()))`.' },
  { pattern: /\.(?:isWellFormed|toWellFormed)\(/g, name: 'This string method', since: 111, hint: 'Remove the call, or check for lone surrogates with a regular expression.' },
  { pattern: /\.(?:isSubsetOf|isSupersetOf|isDisjointFrom|symmetricDifference)\(/g, name: 'This Set method', since: 122, hint: 'Compare the sets with a loop.' },
  { pattern: /\bURL\.(?:canParse|parse)\(/g, name: 'This URL method', since: 120, hint: 'Use `new URL(...)` in a try/catch.' },
  { pattern: /\bAbortSignal\.any\(/g, name: '`AbortSignal.any`', since: 116, hint: 'Forward the abort events to one controller yourself.' },
  { pattern: /\bResponse\.json\(/g, name: 'The static `Response.json`', since: 105, hint: 'Use `new Response(JSON.stringify(data))`.' },
  { pattern: /\bIterator\.from\(/g, name: '`Iterator.from`', since: 122, hint: 'Spread into an array and use array methods.' },
  { pattern: /\bRegExp\.escape\(/g, name: '`RegExp.escape`', since: 136, hint: 'Escape with `text.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")`.' },
  { pattern: /\bIntl\.DurationFormat\b/g, name: '`Intl.DurationFormat`', since: 129, hint: 'Format the duration yourself.' },
  { pattern: /\.startViewTransition\(/g, name: 'View transitions', since: 111, hint: 'Use `transition:name` on the elements that change.' },
  { pattern: /\.(?:showPopover|hidePopover|togglePopover)\(/g, name: 'The popover API', since: 114, hint: 'Show the element with an `{#if}` block.' },
  { pattern: /\.checkVisibility\(/g, name: '`checkVisibility`', since: 105, hint: 'Use `getBoundingClientRect()` or `offsetParent`.' },
  { pattern: /\.moveBefore\(/g, name: '`moveBefore`', since: 133, hint: 'Use `insertBefore`.' },
  { pattern: /\.(?:setHTMLUnsafe|getHTML)\(/g, name: 'This HTML method', since: 125, hint: 'Use `innerHTML`.' },
  { pattern: /\bscheduler\.yield\(/g, name: '`scheduler.yield`', since: 129, hint: 'Use `await new Promise(requestAnimationFrame)`.' },
];

/**
 * The uses of JavaScript APIs that Chromium 103 lacks. Newer syntax is not listed: the build
 * rewrites it. A missing function cannot be rewritten, it throws when the code reaches it.
 */
export function checkScript(source: string): CompatIssue[] {
  const code = maskCode(source);
  const issues: CompatIssue[] = [];
  for (const feature of APIS) {
    for (const match of code.matchAll(feature.pattern)) {
      issues.push({ start: match.index, end: match.index + match[0].length, message: describe(feature), hint: feature.hint });
    }
  }
  return issues.sort((a, b) => a.start - b.start);
}
