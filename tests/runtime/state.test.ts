import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

describe.skipIf(!CHROMIUM_103)('reactivity in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
    await fixture.open('state');
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);
  const click = (selector: string): Promise<void> => fixture.page.click(selector);
  const runs = async (): Promise<number> => Number(/after (\d+) runs/.exec((await text('#sum')) as string)![1]);

  test('a store tracks each property, and nested objects', async () => {
    expect(await text('#player')).toBe('Ada is level 1');
    await click('#level');
    expect(await text('#player')).toBe('Ada is level 2');
    await click('#rename');
    expect(await text('#player')).toBe('Grace is level 9');
    await click('#level');
    expect(await text('#player')).toBe('Grace is level 10');
  });

  test('a store array reacts to push, sort, splice and a shortened length', async () => {
    const list = (): Promise<string[]> => fixture.page.locator('#list li').allTextContents();
    expect(await text('#items')).toBe('1: rope');
    await click('#push');
    expect(await text('#items')).toBe('3: rope, torch, map');
    expect(await list()).toEqual(['rope', 'torch', 'map']);
    await click('#sort');
    expect(await list()).toEqual(['map', 'rope', 'torch']);
    await click('#splice');
    expect(await text('#items')).toBe('2: rope, torch');
    expect(await list()).toEqual(['rope', 'torch']);
    await click('#clear');
    expect(await text('#items')).toBe('0: ');
    expect(await list()).toEqual([]);
  });

  test('a store notices keys that appear and disappear', async () => {
    expect(await text('#flags')).toBe('');
    await click('#flag');
    expect(await text('#flags')).toBe('night');
    await click('#unflag');
    expect(await text('#flags')).toBe('');
  });

  test('computed values, batch and untrack', async () => {
    expect(await text('#sum')).toBe('11 after 1 runs, untracked 10');
    await click('#both');
    expect(await text('#sum')).toBe('13 after 2 runs, untracked 11');
    await click('#other');
    // The second effect read `second` untracked, so it did not run again.
    expect(await text('#sum')).toBe('14 after 3 runs, untracked 11');
  });

  test('writes in an event handler are batched, writes after an await are not', async () => {
    const before = await runs();
    await click('#handler');
    expect(await runs()).toBe(before + 1);
    await click('#later');
    await fixture.page.waitForFunction((expected) => document.querySelector('#sum')!.textContent!.includes(`after ${expected} runs`), before + 3);
  });

  test('mount renders a component by hand and its result removes it', async () => {
    await click('#badge');
    expect(await fixture.page.innerHTML('#slot')).toBe('<span class="badge">mounted by hand</span>');
    await click('#badge');
    expect(await fixture.page.innerHTML('#slot')).toBe('');
  });

  test('nothing was reported as an error', () => {
    expect(fixture.errors).toEqual([]);
  });
});
