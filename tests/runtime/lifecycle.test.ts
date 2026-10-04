import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

interface Probe {
  events: string[];
  ticks: number;
}

describe.skipIf(!CHROMIUM_103)('screens in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);
  const probe = (): Promise<Probe> => fixture.page.evaluate(() => (window as unknown as { probe: Probe }).probe);
  const listeners = (): Promise<string[]> => fixture.page.evaluate(() => (window as unknown as { globalListeners: () => string[] }).globalListeners());
  const requests = (): Promise<string[]> =>
    fixture.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name.split('/').pop() as string));

  test('an idle page has no nodes, no listeners of its own, and has not loaded any screen', async () => {
    const { page } = fixture;
    expect(await fixture.nodes()).toBe(0);
    expect(await listeners()).toHaveLength(0);
    expect((await requests()).some((name) => /^(Lifecycle|Hud|Bindings)-/.test(name))).toBe(false);
  });

  test('opening loads the screen, mounts it and runs setup, effects and onMount in order', async () => {
    await fixture.lua({ t: 'locale', data: { greeting: 'Hello %s, {1} new', menu: { title: 'Menu' } } });
    await fixture.open('lifecycle', { label: 'first', nested: { depth: 1 } });
    expect((await requests()).some((name) => name.startsWith('Lifecycle-'))).toBe(true);
    expect((await probe()).events).toEqual(['setup', 'effect:first', 'mount:attached']);
    expect(await text('#label')).toBe('first/1');
  });

  test('a second open updates the props of the mounted screen', async () => {
    const { page } = fixture;
    await page.evaluate(() => ((document.querySelector('#label') as HTMLElement).dataset.kept = 'yes'));
    await fixture.lua({ t: 'open', screen: 'lifecycle', props: { label: 'second', nested: { depth: 2 } } });
    expect(await text('#label')).toBe('second/2');
    expect(await page.getAttribute('#label', 'data-kept')).toBe('yes');
    expect((await probe()).events).toEqual(['setup', 'effect:first', 'mount:attached', 'effect:second']);
    // A key that the new props leave out is gone, not kept from the previous open.
    await fixture.lua({ t: 'open', screen: 'lifecycle', props: { nested: { depth: 2 } } });
    expect(await text('#label')).toBe('/2');
    await fixture.lua({ t: 'open', screen: 'lifecycle', props: { label: 'second', nested: { depth: 2 } } });
  });

  test('props are read-only', async () => {
    await fixture.page.click('#overwrite');
    expect((await probe()).events.slice(-1)).toEqual(['write:refused']);
    expect(await text('#label')).toBe('second/2');
  });

  test('locale strings, placeholders and missing keys', async () => {
    expect(await text('#greeting')).toBe('Hello Ada, 3 new / Menu / missing.key');
    await fixture.lua({ t: 'locale', data: { greeting: 'Bonjour %s', 'menu.title': 'Carte' } });
    expect(await text('#greeting')).toBe('Bonjour Ada / Carte / missing.key');
  });

  test('env describes a build outside the game', async () => {
    expect(await text('#env')).toBe('false|fixture|false');
  });

  test('the design size is scaled to fit the window and centred', async () => {
    const { page } = fixture;
    expect(await text('#scale')).toBe('2');
    const box = await page.evaluate(() => {
      const rect = document.querySelector('[data-screen="lifecycle"]')!.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height];
    });
    expect(box).toEqual([0, 0, 1280, 720]);
    expect(await page.evaluate(() => (document.querySelector('[data-screen="lifecycle"]') as HTMLElement).style.cursor)).toBe('crosshair');

    await page.setViewportSize({ width: 1280, height: 540 });
    await page.waitForFunction(() => document.querySelector('#scale')!.textContent === '1.5');
    const resized = await page.evaluate(() => {
      const rect = document.querySelector('[data-screen="lifecycle"]')!.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height];
    });
    expect(resized).toEqual([160, 0, 960, 540]);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('onKey fires for its key, and not for a character typed into a field', async () => {
    const { page } = fixture;
    await page.keyboard.press('Enter');
    await page.keyboard.press('x');
    expect(await text('#keys')).toBe('Ex');
    await page.focus('#field');
    await page.keyboard.press('x');
    await page.keyboard.press('Enter');
    expect(await text('#keys')).toBe('ExE');
    expect(await page.inputValue('#field')).toBe('x');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  });

  test('pushes reach nui.on', async () => {
    await fixture.lua({ t: 'push', name: 'ping', data: null });
    await fixture.lua({ t: 'push', name: 'ping', data: null });
    expect(await text('#pushes')).toBe('2');
  });

  test('a hud screen sits under the others, takes state from Lua and ignores Escape', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'state', name: 'hud', data: { health: 80 } });
    await fixture.open('hud');
    // The hud was opened last and is still drawn under the other screen.
    const stack = await page.evaluate(() => document.elementsFromPoint(640, 360).map((node) => (node as HTMLElement).dataset.screen).filter(Boolean));
    expect(stack).toEqual(['lifecycle', 'hud']);
    expect(await text('#health')).toBe('80');
    await fixture.lua({ t: 'state', name: 'hud', data: { cash: 250, place: { street: 'Grove' } } });
    expect([await text('#health'), await text('#cash'), await text('#place')]).toEqual(['80', '250', 'Grove']);
    await fixture.lua({ t: 'state', name: 'hud', data: { place: { street: 'Vinewood' } } });
    expect(await text('#place')).toBe('Vinewood');
  });

  test('Escape asks Lua to close the screen that declares it', async () => {
    const { page } = fixture;
    await page.keyboard.press('Escape');
    const sent = await fixture.sent();
    expect(sent.filter((message) => message.t === 'close')).toEqual([{ t: 'close', screen: 'lifecycle' }]);
    expect(await page.locator('#lifecycle').count()).toBe(1);
    await page.click('#close');
    expect((await fixture.sent()).filter((message) => message.t === 'close')).toEqual([{ t: 'close', screen: 'lifecycle' }, { t: 'close' }]);
  });

  test('sounds start, and stop when asked', async () => {
    const { page } = fixture;
    await page.evaluate(() => {
      const state = { started: 0, stopped: 0 };
      const start = AudioBufferSourceNode.prototype.start;
      const stop = AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start = function (...args) {
        state.started++;
        return start.apply(this, args);
      };
      AudioBufferSourceNode.prototype.stop = function (...args) {
        state.stopped++;
        return stop.apply(this, args);
      };
      (window as unknown as { audio: typeof state }).audio = state;
    });
    const audio = (): Promise<{ started: number; stopped: number }> =>
      page.evaluate(() => (window as unknown as { audio: { started: number; stopped: number } }).audio);

    await page.click('#hum');
    await page.waitForFunction(() => (window as unknown as { audio: { started: number } }).audio.started === 1);
    await page.click('#hush');
    expect((await audio()).stopped).toBe(1);

    await page.click('#hum');
    await page.click('#hum-later');
    await page.waitForFunction(() => (window as unknown as { audio: { started: number } }).audio.started === 3);
    expect((await audio()).stopped).toBe(1);
  });

  test('closing disposes everything: nodes, listeners, timers, sounds, subscriptions', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'close', screen: 'lifecycle' });
    expect(await page.locator('[data-screen="lifecycle"]').count()).toBe(0);
    expect((await probe()).events.slice(-1)).toEqual(['cleanup']);
    // Both loops stop, the one started after an await included.
    expect(await page.evaluate(() => (window as unknown as { audio: { stopped: number } }).audio.stopped)).toBe(3);

    await fixture.lua({ t: 'close', screen: 'hud' });
    expect(await fixture.nodes()).toBe(0);
    expect(await listeners()).toHaveLength(0);

    const before = await probe();
    await page.keyboard.press('Enter');
    await fixture.lua({ t: 'push', name: 'ping', data: null });
    await page.waitForTimeout(60);
    expect(await probe()).toEqual(before);
  });

  test('a screen can be opened again after it was closed', async () => {
    await fixture.open('lifecycle', { label: 'again', nested: { depth: 3 } });
    expect(await text('#label')).toBe('again/3');
    expect(await text('#keys')).toBe('');
    await fixture.lua({ t: 'close', screen: 'lifecycle' });
    expect(await fixture.nodes()).toBe(0);
  });

  test('a close that arrives while the screen is still loading wins', async () => {
    const { page } = fixture;
    await page.evaluate(() => {
      const { lua } = window as unknown as { lua: (message: object) => void };
      lua({ t: 'open', screen: 'bindings', props: { title: 'x', count: 0 } });
      lua({ t: 'close', screen: 'bindings' });
    });
    await page.waitForTimeout(200);
    expect(await fixture.nodes()).toBe(0);
  });

  test('nothing was reported as an error', () => {
    expect(fixture.errors).toEqual([]);
  });

  test('a screen that fails while it is set up is cleaned away and gives the focus back to Lua', async () => {
    const { page } = fixture;
    const closes = async (): Promise<unknown[]> => (await fixture.sent()).filter((message) => message.t === 'close' && message.screen === 'broken');
    await fixture.lua({ t: 'open', screen: 'broken', props: {} });
    await page.waitForFunction(() => (window as unknown as { brokenEffects?: number }).brokenEffects === 1);
    while ((await closes()).length === 0) await page.waitForTimeout(10);

    expect(fixture.errors.join('\n')).toContain("Cannot read properties of undefined (reading 'length')");
    expect(await fixture.nodes()).toBe(0);
    expect(await listeners()).toHaveLength(0);

    await fixture.lua({ t: 'open', screen: 'broken', props: { items: ['a', 'b'] } });
    await page.waitForSelector('#broken');
    expect(await text('#broken')).toBe('2');
    await fixture.lua({ t: 'close', screen: 'broken' });
    fixture.errors.length = 0;
  });

  test('opening a screen that does not exist is reported and closed again', async () => {
    await fixture.lua({ t: 'open', screen: 'nowhere', props: {} });
    while (!(await fixture.sent()).some((message) => message.t === 'close' && message.screen === 'nowhere')) await fixture.page.waitForTimeout(10);
    expect(fixture.errors.join('\n')).toContain('web/screens has no screen "nowhere"');
    expect(await fixture.nodes()).toBe(0);
  });
});
