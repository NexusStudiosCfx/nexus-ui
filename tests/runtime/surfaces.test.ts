import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

describe.skipIf(!CHROMIUM_103)('a phone app in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture({ mode: 'phone', query: '?surface=phone&resource=fixture_app' });
    await fixture.page.waitForSelector('#phone-app');
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);

  test('the screen of the surface is mounted when the page loads, without Lua opening it', async () => {
    const { page } = fixture;
    expect(await page.evaluate(() => [...document.body.children].map((node) => (node as HTMLElement).dataset.screen))).toEqual(['phoneApp']);
    expect(await text('#app-props')).toBe('no tab');
    // It fills the frame it is given.
    const box = await page.evaluate(() => {
      const rect = document.querySelector('[data-screen="phoneApp"]')!.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height];
    });
    expect(box).toEqual([0, 0, 1280, 720]);
  });

  test('the resource comes from the address, and the frame counts as in game', async () => {
    expect(await text('#app-env')).toBe('true|fixture_app');
  });

  test('every message goes to the NUI callback of that resource, with the surface on it', async () => {
    const { page } = fixture;
    expect(await fixture.sent()).toEqual([{ t: 'ready', surface: 'phone' }]);
    await page.click('#app-preview');
    await page.click('#app-list');
    await page.waitForFunction(() => document.querySelector('#app-result')!.textContent === '');
    while ((await fixture.sent()).length < 3) await page.waitForTimeout(10);
    const [, client, call] = await fixture.sent();
    expect(client).toEqual({ t: 'client', name: 'garage:preview', data: { plate: 'NEXUS' }, surface: 'phone' });
    expect(call).toMatchObject({ t: 'call', name: 'garage:list', data: { owner: 'me' }, surface: 'phone' });
    expect(new Set(fixture.endpoints)).toEqual(new Set(['https://fixture_app/nexus']));

    await fixture.lua({ t: 'res', id: call!.id, ok: true, data: ['sultan'] });
    await page.waitForFunction(() => document.querySelector('#app-result')!.textContent === '["sultan"]');
  });

  test('what Lua sends through LB reaches the app: locale, state, pushes and props', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'locale', data: { 'app.title': 'Garage' } });
    await fixture.lua({ t: 'state', name: 'garage', data: { count: 4 } });
    await fixture.lua({ t: 'push', name: 'garage:changed', data: null });
    await fixture.lua({ t: 'open', screen: 'phoneApp', props: { tab: 'owned' } });
    await page.waitForFunction(() => document.querySelector('#app-props')!.textContent === 'owned');
    expect([await text('#app-title'), await text('#app-state'), await text('#app-pushed')]).toEqual(['Garage', '4', '1']);
    expect(await page.locator('[data-screen="phoneApp"]').count()).toBe(1);
  });

  test('messages LB sends for its own purposes are ignored', async () => {
    const { page } = fixture;
    await page.evaluate(() => {
      window.postMessage('componentsLoaded', '*');
      window.postMessage({ type: 'settingsUpdated', settings: { display: { theme: 'dark' } } }, '*');
      window.postMessage({ action: 'other', data: { t: 'close', screen: 'phoneApp' } }, '*');
      window.postMessage(null, '*');
    });
    await page.waitForTimeout(50);
    expect(await page.locator('#phone-app').count()).toBe(1);
    expect(fixture.errors).toEqual([]);
  });

  test('Escape is left to the phone', async () => {
    await fixture.page.keyboard.press('Escape');
    expect((await fixture.sent()).filter((message) => message.t === 'close')).toEqual([]);
    expect(await fixture.page.locator('#phone-app').count()).toBe(1);
  });
});

describe.skipIf(!CHROMIUM_103)('a tablet app in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture({ mode: 'tablet', query: '?surface=tablet&resource=fixture_app' });
    await fixture.page.waitForSelector('#tablet-app');
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  test('mounts the screen of its own surface, and only that one', async () => {
    const { page } = fixture;
    expect(await page.evaluate(() => [...document.body.children].map((node) => (node as HTMLElement).dataset.screen))).toEqual(['tabletApp']);
    expect(await page.evaluate(() => (document.querySelector('[data-screen="tabletApp"]') as HTMLElement).style.cursor)).toBe('default');
  });

  test('understands a message that LB Tablet wraps as { action, data }', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'state', name: 'garage', data: { count: 9 } });
    await page.waitForFunction(() => document.querySelector('#tablet-state')!.textContent === '9');

    await page.click('#tablet-list');
    while (!(await fixture.sent()).some((message) => message.t === 'call')) await page.waitForTimeout(10);
    const call = (await fixture.sent()).find((message) => message.t === 'call') as Record<string, unknown>;
    expect(call).toMatchObject({ name: 'garage:list', surface: 'tablet' });
    await fixture.lua({ t: 'res', id: call.id, ok: true, data: [] });
    await page.waitForFunction(() => document.querySelector('#tablet-result')!.textContent === '[]');
    expect(fixture.errors).toEqual([]);
  });
});

describe.skipIf(!CHROMIUM_103)('the page of the resource itself', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture({ mode: 'game' });
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  test('mounts no app, sends no surface and still takes its resource from the game', async () => {
    expect(await fixture.nodes()).toBe(0);
    expect(await fixture.sent()).toEqual([{ t: 'ready' }]);
    expect(fixture.endpoints).toEqual(['https://fixture/nexus']);
  });

  test('a surface nobody declared mounts nothing', async () => {
    const other = await openFixture({ mode: 'phone', query: '?surface=watch&resource=fixture_app' });
    expect(await other.nodes()).toBe(0);
    expect(await other.sent()).toEqual([{ t: 'ready', surface: 'watch' }]);
    expect(other.errors).toEqual([]);
    await other.close();
  });
});
