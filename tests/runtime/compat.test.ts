import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Page } from 'playwright-core';
import { checkCss, checkScript } from '../../src/compiler/compat';
import { CHROMIUM_103, launch, shutdown } from './harness';

/**
 * The compiler's list of what Chromium 103 cannot run is only worth something if it is true.
 * Every entry is checked here against the real browser: what the list rejects must not work in
 * it, and what the list accepts must.
 */
describe.skipIf(!CHROMIUM_103)('the compatibility list against Chromium 103', () => {
  let page: Page;

  beforeAll(async () => {
    page = await (await launch()).newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
  }, 120000);

  afterAll(async () => {
    await page.close();
    await shutdown();
  });

  /** True when the browser keeps the whole stylesheet: every rule, declaration and selector in it. */
  const understands = (css: string): Promise<boolean> =>
    page.evaluate((text) => {
      const style = document.createElement('style');
      style.textContent = text;
      document.head.append(style);
      const count = (rules: CSSRuleList): number =>
        [...rules].reduce((total, rule) => {
          const nested = 'cssRules' in rule ? count((rule as CSSGroupingRule).cssRules) : 0;
          const declarations = 'style' in rule ? (rule as CSSStyleRule).style.length : 0;
          return total + 1 + nested + declarations;
        }, 0);
      const kept = count(style.sheet!.cssRules);
      // The same sheet with a property every browser knows in place of each declaration.
      const reference = document.createElement('style');
      reference.textContent = text.replace(/([;{]\s*)[\w-]+\s*:[^;{}]+(?=[;}])/g, '$1color: red');
      document.head.append(reference);
      const expected = count(reference.sheet!.cssRules);
      style.remove();
      reference.remove();
      return kept >= expected && kept > 0;
    }, css);

  test('rejects nesting, which the browser drops without a trace', async () => {
    const css = '.outer { .inner { color: rgb(1, 2, 3); } }';
    expect(checkCss(css).length).toBeGreaterThan(0);
    const colour = await page.evaluate((text) => {
      document.body.innerHTML = `<style>${text}</style><div class="outer"><div class="inner"></div></div>`;
      const result = getComputedStyle(document.querySelector('.inner')!).color;
      document.body.innerHTML = '';
      return result;
    }, css);
    expect(colour).not.toBe('rgb(1, 2, 3)');
  });

  test('rejects range syntax in media queries, which never match in the browser', async () => {
    expect(checkCss('@media (width >= 1px) { .a { color: red; } }').length).toBeGreaterThan(0);
    expect(await page.evaluate(() => [matchMedia('(width >= 1px)').matches, matchMedia('(min-width: 1px)').matches])).toEqual([false, true]);
  });

  const rejectedCss: [string, string][] = [
    ['.a:has(.b) { color: red; }', ':has()'],
    ['@container (min-width: 1px) { .a { color: red; } }', '@container'],
    ['.a { container-type: inline-size; }', 'container-type'],
    ['.a { color: color-mix(in srgb, red 50%, blue); }', 'color-mix()'],
    ['.a { color: oklch(70% 0.1 200); }', 'oklch()'],
    ['.a { color: lab(50% 40 59); }', 'lab()'],
    ['.a { color: color(display-p3 1 0 0); }', 'color()'],
    ['.a { color: rgb(from red r g b / 50%); }', 'relative colour'],
    ['.a { color: light-dark(red, blue); }', 'light-dark()'],
    ['.a { height: 100dvh; }', 'dvh'],
    ['.a { height: 100svh; }', 'svh'],
    ['.a { width: 50cqw; }', 'cqw'],
    ['.a { height: 2lh; }', 'lh'],
    ['.a { translate: 10px 0; }', 'translate'],
    ['.a { rotate: 45deg; }', 'rotate'],
    ['.a { scale: 1.2; }', 'scale'],
    ['@scope (.a) { .b { color: red; } }', '@scope'],
    ['.a { text-wrap: balance; }', 'text-wrap'],
    ['.a { grid-template-columns: subgrid; }', 'subgrid'],
    ['.a { transition-timing-function: linear(0, 0.5, 1); }', 'linear()'],
    ['.a { width: calc(100px * sin(45deg)); }', 'sin()'],
    ['.a { width: calc(1px * pow(2, 3)); }', 'pow()'],
    ['.a { width: round(10.4px, 1px); }', 'round()'],
    ['.a { scrollbar-width: thin; }', 'scrollbar-width'],
    ['.a { scrollbar-color: red blue; }', 'scrollbar-color'],
    ['.a { animation-timeline: scroll(); }', 'animation-timeline'],
    ['.a { view-transition-name: card; }', 'view-transition-name'],
    ['.a { anchor-name: --a; }', 'anchor-name'],
    ['.a { transition-behavior: allow-discrete; }', 'transition-behavior'],
    ['.a { field-sizing: content; }', 'field-sizing'],
    ['.a { mask-image: linear-gradient(red, blue); }', 'unprefixed mask-image'],
    ['.a { background-image: image-set("a.png" 1x); }', 'unprefixed image-set()'],
    ['.a:popover-open { color: red; }', ':popover-open'],
    ['.a:user-valid { color: red; }', ':user-valid'],
  ];

  test.each(rejectedCss)('rejects %s, which the browser does not understand', async (css) => {
    expect(checkCss(css).length).toBeGreaterThan(0);
    expect(await understands(css)).toBe(false);
  });

  const acceptedCss = [
    '.a { transform: translate(10px, 0) rotate(5deg) scale(1.1); }',
    '.a { inset: 0; gap: 4px; aspect-ratio: 16 / 9; overflow: clip; accent-color: red; }',
    '.a { color: rgb(0 0 0 / 50%); width: clamp(1px, 2vw, 3px); height: min(10vh, 100px); }',
    '.a { -webkit-mask-image: linear-gradient(red, blue); -webkit-background-clip: text; backdrop-filter: blur(2px); }',
    '.a:is(.b, .c):where(.d):not(.e, .f):focus-visible { color: red; }',
    '@media (min-width: 600px) and (max-width: 900px) { .a { color: red; } }',
    '@layer base { .a { color: red; } }',
    '@supports (display: grid) { .a { display: grid; } }',
    '.a { color: hwb(194 0% 0%); background: conic-gradient(red, blue); }',
    '.a::-webkit-scrollbar { width: 6px; }',
  ];

  test.each(acceptedCss)('accepts %s, which the browser understands', async (css) => {
    expect(checkCss(css)).toEqual([]);
    expect(await understands(css)).toBe(true);
  });

  const rejectedApis: [string, string][] = [
    ['[1].toSorted()', 'typeof Array.prototype.toSorted'],
    ['[1].toReversed()', 'typeof Array.prototype.toReversed'],
    ['[1].toSpliced(0, 1)', 'typeof Array.prototype.toSpliced'],
    ['Object.groupBy([], String)', 'typeof Object.groupBy'],
    ['Map.groupBy([], String)', 'typeof Map.groupBy'],
    ['Array.fromAsync([])', 'typeof Array.fromAsync'],
    ['Promise.withResolvers()', 'typeof Promise.withResolvers'],
    ['Promise.try(() => 1)', 'typeof Promise.try'],
    ['"a".isWellFormed()', 'typeof String.prototype.isWellFormed'],
    ['"a".toWellFormed()', 'typeof String.prototype.toWellFormed'],
    ['new Set().isSubsetOf(new Set())', 'typeof Set.prototype.isSubsetOf'],
    ['new Set().symmetricDifference(new Set())', 'typeof Set.prototype.symmetricDifference'],
    ['URL.canParse("a")', 'typeof URL.canParse'],
    ['AbortSignal.any([])', 'typeof AbortSignal.any'],
    ['Response.json({})', 'typeof Response.json'],
    ['Iterator.from([])', 'typeof globalThis.Iterator?.from'],
    ['RegExp.escape("a")', 'typeof RegExp.escape'],
    ['new Intl.DurationFormat()', 'typeof Intl.DurationFormat'],
    ['document.startViewTransition(() => {})', 'typeof document.startViewTransition'],
    ['element.showPopover()', 'typeof HTMLElement.prototype.showPopover'],
    ['element.checkVisibility()', 'typeof Element.prototype.checkVisibility'],
    ['parent.moveBefore(a, b)', 'typeof Element.prototype.moveBefore'],
    ['element.setHTMLUnsafe("")', 'typeof Element.prototype.setHTMLUnsafe'],
    ['scheduler.yield()', 'typeof globalThis.scheduler?.yield'],
  ];

  test.each(rejectedApis)('rejects %s, which the browser does not have', async (code, probe) => {
    expect(checkScript(code)).toHaveLength(1);
    expect(await page.evaluate(probe)).toBe('undefined');
  });

  const usedByTheRuntime = [
    'typeof Element.prototype.getAnimations',
    'typeof reportError',
    'typeof Element.prototype.replaceChildren',
    'typeof structuredClone',
    'typeof Array.prototype.at',
    'typeof Array.prototype.findLast',
    'typeof Object.hasOwn',
    'typeof AudioContext',
  ];

  test.each(usedByTheRuntime)('%s exists', async (probe) => {
    expect(await page.evaluate(probe)).toBe('function');
  });
});
