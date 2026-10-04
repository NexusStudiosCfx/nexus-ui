/**
 * Drives the built sandbox in a real browser. Run `npm run build` first, and name the browser:
 *
 *   PLAYGROUND_BROWSER=/path/to/chrome npm test
 *
 * Without the variable these tests are skipped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER, launch, running, SUB_PATH, write, type Sandbox } from './support/browser';

const executablePath = process.env.PLAYGROUND_BROWSER;
const NAMES = ['counter', 'list', 'form', 'call', 'hud', 'transition', 'keys', 'component'];

describe.skipIf(!executablePath)('the built sandbox in a browser', () => {
  let sandbox: Sandbox;
  const open = (address = ''): ReturnType<Sandbox['open']> => sandbox.open(address);

  beforeAll(async () => {
    sandbox = await launch(executablePath as string);
  });

  afterAll(() => sandbox?.close());

  for (const name of NAMES) {
    it(`runs the example "${name}" without an error`, async () => {
      const { page, problems } = await open(`#example=${name}`);
      const frame = await running(page);
      await frame.locator('[data-screen="main"]').waitFor({ state: 'attached' });
      await page.waitForTimeout(700);
      expect(await page.locator('.nxp-problem:not([hidden]), .nxp-problem-bar:not([hidden])').count()).toBe(0);
      expect(await page.locator('.nxp-line.is-error, .nxp-line.is-warn').count()).toBe(0);
      expect(await page.locator('.nxp-status-text').textContent()).toMatch(/^Compiled in/);
      expect(problems).toEqual([]);
      await page.close();
    });
  }

  it('asks for nothing outside its own folder', () => {
    expect(sandbox.requests.length).toBeGreaterThan(0);
    expect(sandbox.requests.filter((path) => !path.startsWith(SUB_PATH))).toEqual([]);
  });

  it('keeps the code away from the page', async () => {
    const { page } = await open();
    const frame = await running(page);
    expect(await page.locator('iframe.nxp-frame').getAttribute('sandbox')).toBe('allow-scripts');
    expect(await frame.evaluate(() => window.origin)).toBe('null');
    expect(await frame.evaluate(() => { try { return String(parent.document); } catch (error) { return (error as Error).name; } })).toBe('SecurityError');
    await page.close();
  });

  it('recompiles on an edit, and the new code runs', async () => {
    const { page, problems } = await open();
    await running(page);
    await write(page, COUNTER);
    await expect.poll(async () => (await running(page)).locator('.add').textContent()).toBe('Edited: 40');
    await (await running(page)).locator('.add').click();
    await expect.poll(async () => (await running(page)).locator('.add').textContent()).toBe('Edited: 41');
    expect(problems).toEqual([]);
    await page.close();
  });

  it('shows a compile error over the last working preview, and recovers', async () => {
    const { page } = await open();
    await running(page);
    await write(page, COUNTER.replace('count.value++}', 'count.value++'));
    const panel = page.locator('.nxp-problem');
    await panel.waitFor();
    expect(await panel.locator('.nxp-chip').textContent()).toBe('Compile error');
    expect(await panel.locator('.nxp-place').first().textContent()).toMatch(/^Main\.nexus:\d+:\d+$/);
    expect(await panel.locator('.nxp-problem-frame').textContent()).toContain('on:click');
    // The counter that ran before the edit is still there, under the panel.
    expect(await page.frames()[1]?.locator('.value').count()).toBe(1);
    await write(page, COUNTER);
    await panel.waitFor({ state: 'hidden' });
    expect(await (await running(page)).locator('.add').textContent()).toBe('Edited: 40');
    await page.close();
  });

  it('shows an error of the running code with the line it was written on', async () => {
    const { page } = await open();
    await running(page);
    await write(page, COUNTER.replace('const count = signal(40);', 'const count = signal(40);\nconst broken = (undefined as any).missing;'));
    const panel = page.locator('.nxp-problem');
    await panel.waitFor();
    expect(await panel.locator('.nxp-chip').textContent()).toBe('Runtime error');
    expect(await panel.locator('.nxp-place').first().textContent()).toMatch(/^Main\.nexus:5:/);
    expect(await panel.locator('.nxp-problem-message').textContent()).toContain('TypeError');
    await page.close();
  });
});
