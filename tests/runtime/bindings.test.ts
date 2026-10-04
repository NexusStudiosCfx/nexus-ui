import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

describe.skipIf(!CHROMIUM_103)('bindings in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
    await fixture.open('bindings', { title: 'Shop', count: 2, extra: { 'data-extra': 'yes', lang: 'en' } });
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);

  test('runs in the browser FiveM embeds', async () => {
    expect(await fixture.page.evaluate(() => navigator.userAgent)).toContain('Chrome/103.');
  });

  test('text, entities and signals in text', async () => {
    expect(await text('#title')).toBe('Shop: 2 & 4\u00a0!');
    expect(await text('#plain')).toBe('Plain <text> with {braces}');
  });

  test('static, dynamic, mixed and spread attributes', async () => {
    const main = fixture.page.locator('#bindings');
    expect(await main.getAttribute('data-title')).toBe('Shop');
    expect(await main.getAttribute('data-extra')).toBe('yes');
    expect(await main.getAttribute('lang')).toBe('en');
    expect(await main.getAttribute('class')).toBe('panel small even');
    expect(await main.evaluate((node: HTMLElement) => node.style.width)).toBe('120px');
  });

  test('events update exactly what depends on them', async () => {
    const { page } = fixture;
    await page.evaluate(() => {
      (window as unknown as { titleNode: Node }).titleNode = document.querySelector('#title')!.firstChild!;
    });
    await page.click('#increment');
    expect(await text('#title')).toBe('Shop: 3 & 6\u00a0!');
    expect(await page.locator('#bindings').getAttribute('class')).toBe('panel small');
    expect(await page.evaluate(() => document.querySelector('#title')!.firstChild === (window as unknown as { titleNode: Node }).titleNode)).toBe(true);

    await page.click('#increment');
    await page.click('#increment');
    expect(await page.locator('#increment').isDisabled()).toBe(true);
    await page.click('#inline');
    expect(await text('#title')).toBe('Shop: 0 & 0\u00a0!');
    expect(await page.locator('#increment').isDisabled()).toBe(false);
  });

  test('class and style directives', async () => {
    const { page } = fixture;
    await page.click('#widen');
    await page.click('#grow');
    const main = page.locator('#bindings');
    expect(await main.evaluate((node: HTMLElement) => node.style.width)).toBe('200px');
    expect(await main.getAttribute('class')).toBe('even panel large');
  });

  test('event modifiers', async () => {
    const { page } = fixture;
    await page.click('#stopped');
    expect(await text('#log')).toBe('stopped');
    await page.click('#bubbles');
    expect(await text('#log')).toBe('stopped,bubbles,outer');
    await page.click('#prevented');
    expect(page.url()).not.toContain('#moved');
    await page.click('#once');
    await page.click('#once');
    expect(await text('#log')).toBe('stopped,bubbles,outer,prevented,outer,once,outer');
    await page.click('#inner');
    expect(await text('#log')).toBe('stopped,bubbles,outer,prevented,outer,once,outer,outer');
    await page.click('#self', { position: { x: 1, y: 1 } });
  });

  test('two-way bindings', async () => {
    const { page } = fixture;
    expect(await text('#values')).toBe('Ada|3|false|red|b|large|Paris');
    expect(await page.inputValue('#name')).toBe('Ada');
    expect(await page.isChecked('#red')).toBe(true);
    expect(await page.isChecked('#pick-b')).toBe(true);
    expect(await page.inputValue('#size')).toBe('large');
    expect(await page.inputValue('#city')).toBe('Paris');

    await page.fill('#name', 'Grace');
    await page.fill('#amount', '12');
    await page.check('#agreed');
    await page.check('#blue');
    await page.check('#pick-a');
    await page.uncheck('#pick-b');
    await page.selectOption('#size', 'small');
    await page.fill('#city', 'Lyon');
    expect(await text('#values')).toBe('Grace|12|true|blue|a|small|Lyon');

    await page.fill('#amount', '');
    expect(await text('#values')).toBe('Grace||true|blue|a|small|Lyon');
  });

  test('bind:this, onMount and actions', async () => {
    const { page } = fixture;
    expect(await text('#mounted')).toBe('yes');
    const box = page.locator('#box');
    expect(await box.getAttribute('title')).toBe('first hint');
    await page.click('#rehint');
    expect(await box.getAttribute('title')).toBe('second hint');
    expect(await box.getAttribute('data-runs')).toBe('2');
    expect(await box.getAttribute('data-cleanups')).toBe('1');
  });

  test('scoped styles apply, and only inside the component', async () => {
    const { page } = fixture;
    expect(await page.locator('#bindings').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(10, 20, 30)');
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe('monospace');
    const leaked = await page.evaluate(() => {
      const outside = document.createElement('h1');
      outside.className = 'panel';
      document.body.append(outside);
      const style = getComputedStyle(outside);
      const result = [style.color, style.marginTop];
      outside.remove();
      return result;
    });
    expect(leaked[0]).not.toBe('rgb(10, 20, 30)');
    expect(leaked[1]).not.toBe('0px');
  });

  test('nothing was reported as an error', () => {
    expect(fixture.errors).toEqual([]);
  });
});
