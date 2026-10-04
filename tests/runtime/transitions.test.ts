import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

describe.skipIf(!CHROMIUM_103)('transitions in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
    await fixture.open('motion');
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const classes = (selector: string): Promise<string[]> =>
    fixture.page.evaluate((query) => [...(document.querySelector(query)?.classList ?? [])].filter((name) => /-(enter|leave)$/.test(name)), selector);
  const gone = (selector: string): Promise<unknown> => fixture.page.waitForSelector(selector, { state: 'detached', timeout: 2000 });

  test('the enter class is on a new node and comes off when its animation ends', async () => {
    const { page } = fixture;
    await page.click('#toggle');
    await gone('#fade');
    await page.click('#toggle');
    expect(await classes('#fade')).toEqual(['fade-enter']);
    await page.waitForFunction(() => !document.querySelector('#fade')!.classList.contains('fade-enter'), undefined, { timeout: 2000 });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#fade')!).opacity)).toBe('1');
  });

  test('a leaving node stays until its animation ends, then is removed', async () => {
    const { page } = fixture;
    await page.click('#toggle');
    expect(await classes('#fade')).toEqual(['fade-leave']);
    expect(await page.locator('#fade').count()).toBe(1);
    await gone('#fade');
  });

  test('without an animation the enter class starts a CSS transition', async () => {
    const { page } = fixture;
    await page.click('#slide-toggle');
    // The class is already gone, and the element is on its way from the enter position.
    const state = await page.evaluate(() => {
      const node = document.querySelector('#slide')!;
      return { entering: node.classList.contains('slide-enter'), running: node.getAnimations().length };
    });
    expect(state).toEqual({ entering: false, running: 1 });
    await page.waitForFunction(() => document.querySelector('#slide')!.getAnimations().length === 0, undefined, { timeout: 2000 });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#slide')!).transform)).toBe('none');

    await page.click('#slide-toggle');
    expect(await classes('#slide')).toEqual(['slide-leave']);
    await gone('#slide');
  });

  test('a row of an each leaves on its own while the others stay', async () => {
    const { page } = fixture;
    await page.waitForFunction(() => !document.querySelector('#rows .fade-enter'), undefined, { timeout: 2000 });
    await page.click('#drop');
    expect(await page.locator('#rows .row').allTextContents()).toEqual(['1', '2', '3']);
    expect(await page.locator('#rows .fade-leave').allTextContents()).toEqual(['1']);
    await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 2, undefined, { timeout: 2000 });
    expect(await page.locator('#rows .row').allTextContents()).toEqual(['2', '3']);
  });

  test('a closing screen plays the leave transition of its root, then leaves no node behind', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'close', screen: 'motion' });
    expect(await classes('#motion')).toEqual(['screen-leave']);
    await gone('[data-screen="motion"]');
    expect(await fixture.nodes()).toBe(0);
  });

  test('nothing was reported as an error', () => {
    expect(fixture.errors).toEqual([]);
  });
});
