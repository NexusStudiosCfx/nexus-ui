/** The bridge, the bar and the layouts of the built sandbox. See e2e.test.ts for how to run it. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER, launch, running, write, type Sandbox } from './support/browser';

const executablePath = process.env.PLAYGROUND_BROWSER;

/** A screen for the contract of the form example that sends a plate the contract refuses. */
const UNCHECKED = `---
import { signal, nui, NuiError } from 'nexus';

const result = signal('');

async function send() {
  try {
    await nui.call('vehicle:register', { owner: 'Franklin', plate: 'lower case', colour: 'black' });
  } catch (error) {
    result.value = error instanceof NuiError ? \`\${error.code}: \${error.message}\` : 'another error';
  }
}
---

<button class="send" on:click={send}>Send</button>
<p class="result">{result}</p>
`;

describe.skipIf(!executablePath)('the bridge and the bar in a browser', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await launch(executablePath as string);
  });

  afterAll(() => sandbox?.close());

  it('logs a call with its answer and its duration, and a refusal with its details', async () => {
    const { page, problems } = await sandbox.open('#example=call');
    const frame = await running(page);
    await frame.locator('button', { hasText: '$5' }).click();
    const first = page.locator('.nxp-line').first();
    await first.locator('.nxp-ok').waitFor();
    expect(await first.textContent()).toMatch(/^callshop:buy\{"item":"water"\}→ok\{"balance":115\}\d+(\.\d)? ms$/);
    expect(await frame.locator('.balance').textContent()).toContain('$115');

    await frame.locator('button', { hasText: '$900' }).click();
    const second = page.locator('.nxp-line').nth(1);
    await second.locator('.nxp-refused').waitFor();
    expect(await second.textContent()).toContain('not_enough_money{"missing":785}');
    expect(await frame.locator('.notice').textContent()).toBe('You are $785 short.');
    expect(problems).toEqual([]);
    await page.close();
  });

  it('answers a call over the rate limit with rate_limited', async () => {
    const { page } = await sandbox.open('#example=call');
    const frame = await running(page);
    for (let call = 0; call < 5; call++) {
      await frame.locator('button', { hasText: '$5' }).click();
      await page.locator('.nxp-line').nth(call).waitFor();
      await expect.poll(() => frame.locator('button', { hasText: '$5' }).isEnabled()).toBe(true);
    }
    expect(await page.locator('.nxp-line').nth(4).textContent()).toContain('rate_limited');
    expect(await frame.locator('.notice').textContent()).toBe('Slow down a little.');
    await page.close();
  });

  it('refuses input the contract does not allow as invalid', async () => {
    const { page } = await sandbox.open('#example=form');
    await running(page);
    await write(page, UNCHECKED);
    await expect.poll(async () => (await running(page)).locator('.send').count()).toBe(1);
    const frame = await running(page);
    await frame.locator('.send').click();
    await expect.poll(() => frame.locator('.result').textContent()).toMatch(/^invalid: plate: /);
    expect(await page.locator('.nxp-line.is-refused').textContent()).toContain('→invalid');
    await page.close();
  });

  it('shows state changes and runs the actions of the mock', async () => {
    const { page, problems } = await sandbox.open('#example=hud');
    const frame = await running(page);
    await page.locator('.nxp-line', { hasText: 'hud' }).first().waitFor();
    expect(await page.locator('.nxp-line').first().textContent()).toMatch(/^statehud\{.*\}x?\d*$/);
    await page.locator('.nxp-actions button', { hasText: 'Empty the tank' }).click();
    await expect.poll(() => frame.locator('.amount').textContent()).toMatch(/^[0-9]$/);
    expect(await frame.locator('.fuel.low').count()).toBe(1);
    await page.locator('.nxp-actions button', { hasText: 'Refuel' }).click();
    await expect.poll(() => frame.locator('.amount').textContent()).toMatch(/^(100|9\d)$/);
    expect(problems).toEqual([]);
    await page.close();
  });

  it('closes the screen on Escape and opens it again', async () => {
    const { page } = await sandbox.open();
    const frame = await running(page);
    await frame.locator('.value').click();
    await page.keyboard.press('Escape');
    await page.locator('.nxp-closed').waitFor();
    expect(await page.locator('.nxp-chip').textContent()).toBe('Closed');
    await page.locator('.nxp-closed button').click();
    await page.locator('.nxp-closed').waitFor({ state: 'hidden' });
    await frame.locator('.value').waitFor();
    await page.close();
  });

  it('gives the keys to the preview once it was clicked', async () => {
    const { page } = await sandbox.open('#example=keys');
    const frame = await running(page);
    await frame.locator('.title').click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await frame.locator('li.selected').textContent()).toBe('Respray');
    expect(await frame.locator('.hint strong').textContent()).toBe('Respray');
    await page.close();
  });

  it('shows the module the compiler produced', async () => {
    const { page } = await sandbox.open();
    await running(page);
    await page.locator('.nxp-toggle').click();
    const output = page.locator('.nxp-editor:not([hidden]) .cm-content');
    expect(await output.textContent()).toContain("import { signal, computed } from 'nexus';");
    expect(await output.textContent()).toContain('export default function Main(props)');
    expect(await output.textContent()).not.toContain('$css(');
    expect(await page.locator('.nxp-status-text').textContent()).toMatch(/^Main\.nexus as a build ships it: \d+ lines, [\d.]+ k?B and [\d.]+ k?B of scoped CSS$/);
    await page.close();
  });

  it('shares the project as a link that restores it', async () => {
    const { page } = await sandbox.open();
    await running(page);
    await write(page, COUNTER);
    await expect.poll(async () => (await running(page)).locator('.add').count()).toBe(1);
    await page.locator('.nxp-button.is-primary').click();
    await expect.poll(() => page.url()).toContain('#code=z1.');

    const shared = await sandbox.open(page.url().slice(sandbox.url.length));
    const frame = await running(shared.page);
    expect(await frame.locator('.add').textContent()).toBe('Edited: 40');
    expect(await shared.page.locator('.nxp-menu-title').textContent()).toBe('Shared link');
    expect(await shared.page.locator('.nxp-editor:not([hidden]) .cm-content').textContent()).toContain('const count = signal(40);');
    expect(shared.problems).toEqual([]);

    await shared.page.locator('.nxp-button.is-ghost').click();
    expect(await shared.page.locator('.nxp-editor:not([hidden]) .cm-content').textContent()).toContain('const count = signal(40);');
    await shared.page.close();
    await page.close();
  });

  it('follows a link to another example on the same page', async () => {
    const { page } = await sandbox.open('#example=counter');
    await running(page);
    await page.evaluate(() => (location.hash = 'example=keys'));
    await expect.poll(() => page.locator('.nxp-menu-title').textContent()).toBe('Keyboard');
    await expect.poll(async () => (await running(page)).locator('.menu').count()).toBe(1);
    await page.close();
  });

  it('reports an error of a handler without stopping the preview', async () => {
    const { page } = await sandbox.open();
    await running(page);
    await write(page, COUNTER.replace('count.value++', 'count.value.missing.deeper++'));
    await expect.poll(async () => (await running(page)).locator('.add').count()).toBe(1);
    const frame = await running(page);
    await frame.locator('.add').click();
    const bar = page.locator('.nxp-problem-bar');
    await bar.waitFor();
    expect(await bar.textContent()).toContain('TypeError');
    expect(await bar.locator('.nxp-place').textContent()).toMatch(/^Main\.nexus:7:/);
    expect(await page.locator('.nxp-line.is-error').count()).toBe(1);
    expect(await page.locator('.nxp-chip').textContent()).toBe('Running');
    expect(await frame.locator('.add').textContent()).toBe('Edited: 40');
    await page.close();
  });

  it('puts an example back as it was on Reset', async () => {
    const { page } = await sandbox.open('#example=counter');
    await running(page);
    await write(page, COUNTER);
    await expect.poll(async () => (await running(page)).locator('.add').count()).toBe(1);
    await page.locator('.nxp-button.is-ghost').click();
    await expect.poll(async () => (await running(page)).locator('.value').count()).toBe(1);
    expect(await page.locator('.nxp-editor:not([hidden]) .cm-content').textContent()).toContain('const doubled');
    await page.close();
  });

  it('is only the component and the preview when compact', async () => {
    const { page, problems } = await sandbox.open('?compact');
    await running(page);
    expect(await page.locator('.nxp-bar, .nxp-log, .nxp-toggle').count()).toBe(0);
    expect(await page.locator('.nxp-tab').allTextContents()).toEqual(['Main.nexus']);
    expect(problems).toEqual([]);
    await page.close();
  });

  it('stacks the editor and the preview on a phone, without scrolling sideways', async () => {
    const { page, problems } = await sandbox.open('#example=call', { width: 390, height: 844 });
    await running(page);
    expect(await page.locator('.nxp.is-narrow').count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const editor = await page.locator('.nxp-code').boundingBox();
    const stage = await page.locator('.nxp-stage').boundingBox();
    expect(stage && editor && stage.y >= editor.y + editor.height).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  });
});
