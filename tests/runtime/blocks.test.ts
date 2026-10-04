import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

const items = [
  { id: 1, label: 'one', tags: ['a', 'b'] },
  { id: 2, label: 'two', tags: [] },
  { id: 3, label: 'three', tags: ['c'] },
];

describe.skipIf(!CHROMIUM_103)('blocks in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
    await fixture.open('blocks', { items, mode: 'list', html: '<b id="bold">bold</b> text' });
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);
  const texts = (selector: string): Promise<string[]> => fixture.page.locator(selector).allTextContents();
  const update = (props: Record<string, unknown>): Promise<void> => fixture.lua({ t: 'open', screen: 'blocks', props: { items, mode: 'list', html: '', ...props } });

  /** Tags every keyed row so that a later check can tell a moved node from a recreated one. */
  const mark = (): Promise<void> =>
    fixture.page.evaluate(() => {
      document.querySelectorAll('#keyed .row').forEach((row) => ((row as HTMLElement).dataset.mark = (row as HTMLElement).dataset.id));
    });
  const marks = (): Promise<(string | undefined)[]> =>
    fixture.page.evaluate(() => [...document.querySelectorAll('#keyed .row')].map((row) => (row as HTMLElement).dataset.mark));

  test('if, else if and else', async () => {
    expect(await text('#mode')).toBe('list of 3');
    await update({ mode: 'grid' });
    expect(await text('#mode')).toBe('grid');
    await update({ mode: 'empty' });
    expect(await text('#mode')).toBe('nothing');
    await update({});
    expect(await text('#mode')).toBe('list of 3');
  });

  test('a branch is kept while its condition only changes value', async () => {
    const { page } = fixture;
    await page.evaluate(() => ((document.querySelector('#mode') as HTMLElement).dataset.kept = 'yes'));
    await update({ items: items.slice(0, 2) });
    expect(await text('#mode')).toBe('list of 2');
    expect(await page.getAttribute('#mode', 'data-kept')).toBe('yes');
    await update({});
  });

  test('each renders components with reactive props', async () => {
    expect(await texts('#keyed .label')).toEqual(['1. one', '2. two', '3. three']);
    expect(await fixture.page.locator('#none').count()).toBe(0);
  });

  test('keyed each moves nodes instead of recreating them', async () => {
    const { page } = fixture;
    await mark();
    const before = await page.evaluate(() => ({ ...(window as unknown as { rowCounters: Record<string, number> }).rowCounters }));

    await page.evaluate(() => {
      const moved: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) moved.push((node as HTMLElement).dataset?.id ?? node.nodeName);
        (window as unknown as { moved: string[] }).moved = moved;
      }).observe(document.querySelector('#keyed')!, { childList: true });
      (window as unknown as { moved: string[] }).moved = moved;
    });

    const reordered = [{ ...items[2], label: 'THREE' }, items[0], items[1]];
    await update({ items: reordered });
    expect(await texts('#keyed .label')).toEqual(['1. THREE', '2. one', '3. two']);
    expect(await marks()).toEqual(['3', '1', '2']);
    // Moving the last row to the front is one move, not three.
    expect(await page.evaluate(() => (window as unknown as { moved: string[] }).moved)).toEqual(['3']);

    const after = await page.evaluate(() => ({ ...(window as unknown as { rowCounters: Record<string, number> }).rowCounters }));
    expect(after).toEqual(before);
  });

  test('keyed each adds, removes and falls back to else', async () => {
    const { page } = fixture;
    await update({ items: [items[1], { id: 9, label: 'nine', tags: [] }] });
    expect(await texts('#keyed .label')).toEqual(['1. two', '2. nine']);
    expect(await marks()).toEqual(['2', undefined]);

    await update({ items: [] });
    expect(await page.locator('#keyed .row').count()).toBe(0);
    expect(await text('#none')).toBe('No items');

    await update({});
    expect(await page.locator('#none').count()).toBe(0);
    expect(await texts('#keyed .label')).toEqual(['1. one', '2. two', '3. three']);
    const counters = await page.evaluate(() => (window as unknown as { rowCounters: { created: number; mounted: number; removed: number } }).rowCounters);
    expect(counters.created).toBe(counters.mounted);
    expect(counters.created - counters.removed).toBe(3);
  });

  test('a handler passed to a component in each sees the current item', async () => {
    const { page } = fixture;
    await page.click('#keyed .row:nth-child(2) .pick');
    expect(await text('#picked')).toBe('picked 2');
    expect(await text('#card-footer')).toBe('Footer 2');
  });

  test('each without a key reuses rows by position, with destructuring and nesting', async () => {
    const { page } = fixture;
    // The line break between the text and the inner block is one space.
    expect(await texts('#plain .entry')).toEqual(['0:one ab', '1:two ', '2:three c']);
    await page.evaluate(() => ((document.querySelector('#plain .entry') as HTMLElement).dataset.kept = 'yes'));
    await update({ items: [{ id: 7, label: 'seven', tags: ['x', 'y', 'z'] }] });
    expect(await texts('#plain .entry')).toEqual(['0:seven xyz']);
    expect(await page.getAttribute('#plain .entry', 'data-kept')).toBe('yes');

    await page.click('#plain .tag:nth-of-type(3)');
    expect(await text('#picked')).toBe('picked 2');
    await update({});
  });

  test('key recreates its content when the value changes', async () => {
    const { page } = fixture;
    await page.evaluate(() => ((document.querySelector('#keyed-block') as HTMLElement).dataset.old = 'yes'));
    await page.click('#bump');
    expect(await text('#keyed-block')).toBe('version 2');
    expect(await page.getAttribute('#keyed-block', 'data-old')).toBeNull();
  });

  test('@html inserts markup and replaces it', async () => {
    const { page } = fixture;
    await update({ html: '<i id="italic">new</i>' });
    expect(await page.innerHTML('#raw')).toBe('<i id="italic">new</i><!---->');
    await update({ html: '' });
    expect(await page.innerHTML('#raw')).toBe('<!---->');
  });

  test('slots: content, named content and fallbacks', async () => {
    const { page } = fixture;
    const first = page.locator('.card').nth(0);
    const second = page.locator('.card').nth(1);
    expect(await first.getAttribute('data-tone')).toBe('warm');
    expect(await first.locator('header').textContent()).toBe('First');
    expect(await first.locator('.body').textContent()).toBe('Body 3');
    expect(await first.locator('footer').textContent()).toBe('Footer 2');
    expect(await second.getAttribute('data-tone')).toBe('plain');
    expect(await second.locator('header .fallback').textContent()).toBe('Second');
    expect(await second.locator('.body').textContent()).toBe('');
    expect(await second.locator('footer').textContent()).toBe('No footer');
    expect(await text('.badge')).toBe('dotted');
  });

  test('a scoped style reaches the component it belongs to and not its slot content', async () => {
    const { page } = fixture;
    expect(await page.locator('.card').first().evaluate((node) => getComputedStyle(node).borderTopColor)).toBe('rgb(1, 2, 3)');
  });

  test('svg content created in a child component is real svg', async () => {
    const { page } = fixture;
    const bars = (): Promise<{ namespace: string | null; height: number }[]> =>
      page.evaluate(() => [...document.querySelectorAll('#chart .bar')].map((bar) => ({ namespace: bar.namespaceURI, height: bar.getBoundingClientRect().height })));
    expect(await bars()).toEqual([10, 20, 30].map((height) => ({ namespace: 'http://www.w3.org/2000/svg', height })));
    await page.click('#more-bars');
    expect((await bars()).map((bar) => bar.height)).toEqual([10, 20, 30, 5]);
  });

  test('each inside a table body', async () => {
    expect(await texts('#table td')).toEqual(['one', 'two', 'three']);
    expect(await fixture.page.evaluate(() => document.querySelector('#table tbody')!.children.length)).toBe(3);
  });

  test('nothing was reported as an error', () => {
    expect(fixture.errors).toEqual([]);
  });

  describe('nested blocks', () => {
    const groups = [
      { name: 'a', rows: ['x', 'y'] },
      { name: 'b', rows: ['z'] },
    ];
    const open = (value: unknown): Promise<void> => fixture.lua({ t: 'open', screen: 'nested', props: { groups: value } });

    beforeAll(async () => {
      await fixture.open('nested', { groups });
    });

    test('each keyed by its index, and an inner each that uses the same names', async () => {
      expect(await texts('#nested .group h2')).toEqual(['0:a', '1:b']);
      expect(await texts('#nested .cell')).toEqual(['0:x', '1:y', '0:z']);
      // After the inner block the name is the index of the outer one again.
      expect(await texts('#nested .after')).toEqual(['0', '1']);
      await fixture.page.click('#nested .group:nth-child(1) .cell:nth-of-type(2)');
      expect(await text('#nested-picked')).toBe('a/y/1');
    });

    test('rows keyed by index stay in place and take the new items', async () => {
      const { page } = fixture;
      await page.evaluate(() => document.querySelectorAll('#nested .cell').forEach((cell, at) => ((cell as HTMLElement).dataset.was = String(at))));
      await open([{ name: 'b', rows: ['z', 'w', 'v'] }, { name: 'a', rows: [] }]);
      expect(await texts('#nested .group h2')).toEqual(['0:b', '1:a']);
      expect(await texts('#nested .cell')).toEqual(['0:z', '1:w', '2:v']);
      expect(await page.evaluate(() => [...document.querySelectorAll('#nested .cell')].map((cell) => (cell as HTMLElement).dataset.was))).toEqual(['0', '1', undefined]);
      await page.click('#nested .cell:nth-of-type(3)');
      expect(await text('#nested-picked')).toBe('b/v/2');
    });

    test('a paragraph can hold a component and a block, whatever they render', async () => {
      const { page } = fixture;
      expect(await page.evaluate(() => [...document.querySelector('#para')!.children].map((node) => node.tagName + (node.id ? `#${node.id}` : '')))).toEqual(['ARTICLE', 'DIV#block']);
      expect(await page.locator('#para .body').textContent()).toBe('inside');
      expect((await text('#para'))!.startsWith('Before ')).toBe(true);
      await open([]);
      expect(await page.locator('#para #block').count()).toBe(0);
      expect(await page.locator('#para article').count()).toBe(1);
      expect(fixture.errors).toEqual([]);
    });
  });
});
