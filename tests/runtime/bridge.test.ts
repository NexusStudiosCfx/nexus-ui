import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

describe.skipIf(!CHROMIUM_103)('the bridge in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
    await fixture.open('bridge');
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);
  const busy = (): Promise<boolean> => fixture.page.evaluate(() => document.querySelector('#bridge')!.classList.contains('busy'));
  const lastCall = async (): Promise<Record<string, unknown>> => (await fixture.sent()).filter((message) => message.t === 'call').pop() as Record<string, unknown>;

  test('the page announces itself once', async () => {
    expect((await fixture.sent()).filter((message) => message.t === 'ready')).toHaveLength(1);
  });

  test('a call carries an id, resolves with the answer, and is pending in between', async () => {
    const { page } = fixture;
    expect(await busy()).toBe(false);
    await page.click('#buy');
    const call = await lastCall();
    expect(call).toMatchObject({ t: 'call', name: 'shop:buy', data: { item: 'water', amount: 2 } });
    expect(typeof call.id).toBe('number');
    expect(await busy()).toBe(true);

    await fixture.lua({ t: 'res', id: call.id, ok: true, data: { ok: true, balance: 120 } });
    expect(await text('#result')).toBe('ok:{"ok":true,"balance":120}');
    expect(await busy()).toBe(false);
  });

  test('a refused call rejects with the code and message from Lua', async () => {
    const { page } = fixture;
    await page.click('#buy');
    await fixture.lua({ t: 'res', id: (await lastCall()).id, ok: false, code: 'rate_limited' });
    expect(await text('#result')).toBe('failed:rate_limited:rate_limited');

    await page.click('#buy');
    await fixture.lua({ t: 'res', id: (await lastCall()).id, ok: false, code: 'not_enough_money', message: 'You need $20 more' });
    expect(await text('#result')).toBe('failed:not_enough_money:You need $20 more');

    // What the handler passed along with the code arrives as `details`.
    await page.click('#buy');
    await fixture.lua({ t: 'res', id: (await lastCall()).id, ok: false, code: 'not_enough_money', details: { missing: 20 } });
    expect(await text('#result')).toBe('failed:not_enough_money:not_enough_money:{"missing":20}');
  });

  test('a call without an answer times out, and a late answer is ignored', async () => {
    const { page } = fixture;
    await page.click('#buy-fast');
    const { id } = await lastCall();
    expect(await busy()).toBe(true);
    await page.waitForFunction(() => document.querySelector('#result')!.textContent === 'failed:timeout:timeout', undefined, { timeout: 2000 });
    expect(await busy()).toBe(false);
    await fixture.lua({ t: 'res', id, ok: true, data: { ok: true, balance: 1 } });
    expect(await text('#result')).toBe('failed:timeout:timeout');
  });

  test('a call made inside an effect runs the effect once per change, not in a loop', async () => {
    const { page } = fixture;
    await page.click('#look');
    expect(await text('#lookups')).toBe('runs:1');
    const first = await lastCall();
    expect(first).toMatchObject({ t: 'call', name: 'shop:buy', data: { item: 'water', amount: 1 } });
    expect(await busy()).toBe(true);
    await fixture.lua({ t: 'res', id: first.id, ok: true, data: { ok: true, balance: 1 } });
    expect(await busy()).toBe(false);
    // The answer changed the counter the call had touched: the effect must not have run again.
    expect(await text('#lookups')).toBe('runs:1');

    await page.click('#look');
    expect(await text('#lookups')).toBe('runs:2');
    await fixture.lua({ t: 'res', id: (await lastCall()).id, ok: true, data: { ok: true, balance: 1 } });
    expect(await busy()).toBe(false);
  });

  test('overlapping calls are answered by id and stay pending until the last one ends', async () => {
    const { page } = fixture;
    await page.click('#buy');
    const first = (await lastCall()).id;
    await page.click('#buy');
    const second = (await lastCall()).id;
    expect(second).not.toBe(first);

    await fixture.lua({ t: 'res', id: second, ok: true, data: { n: 2 } });
    expect(await text('#result')).toBe('ok:{"n":2}');
    expect(await busy()).toBe(true);
    await fixture.lua({ t: 'res', id: first, ok: true, data: { n: 1 } });
    expect(await text('#result')).toBe('ok:{"n":1}');
    expect(await busy()).toBe(false);
  });

  test('client messages and pushes', async () => {
    const { page } = fixture;
    await page.click('#preview');
    expect((await fixture.sent()).pop()).toEqual({ t: 'client', name: 'shop:preview', data: { item: 'water' } });
    await fixture.lua({ t: 'push', name: 'shop:stock', data: { stock: 7 } });
    expect(await text('#stock')).toBe('7');
  });

  test('messages that are not from the bridge are ignored', async () => {
    const { page } = fixture;
    await page.evaluate(() => window.postMessage({ t: 'close', screen: 'bridge' }, '*'));
    await page.waitForTimeout(30);
    expect(await page.locator('#bridge').count()).toBe(1);
  });

  test('a subscription ends with its screen', async () => {
    await fixture.lua({ t: 'close', screen: 'bridge' });
    await fixture.lua({ t: 'push', name: 'shop:stock', data: { stock: 9 } });
    expect(fixture.errors).toEqual([]);
  });
});

describe.skipIf(!CHROMIUM_103)('the bridge as FiveM sees it', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture({ mode: 'game' });
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  test('the page listens for Lua with exactly one listener and posts to the NUI callback', async () => {
    const { page } = fixture;
    expect(await fixture.sent()).toEqual([{ t: 'ready' }]);
    const listeners = await page.evaluate(() => (window as unknown as { globalListeners: () => string[] }).globalListeners());
    expect(listeners).toHaveLength(1);
    expect(listeners[0]).toMatch(/^window:message:/);
  });

  test('a call goes out as a POST and its answer comes back as a window message', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'open', screen: 'bridge', props: {} });
    await page.waitForSelector('#bridge');
    await page.click('#buy');
    await page.waitForFunction(() => document.querySelector('#bridge')!.classList.contains('busy'));
    const call = (await fixture.sent()).find((message) => message.t === 'call') as Record<string, unknown>;
    expect(call).toMatchObject({ name: 'shop:buy', data: { item: 'water', amount: 2 } });

    await fixture.lua({ t: 'res', id: call.id, ok: true, data: { balance: 5 } });
    await page.waitForFunction(() => document.querySelector('#result')!.textContent === 'ok:{"balance":5}');
  });

  test('closing leaves the page with its one listener and no nodes', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'close', screen: 'bridge' });
    await page.waitForSelector('#bridge', { state: 'detached' });
    expect(await fixture.nodes()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { globalListeners: () => string[] }).globalListeners())).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  });
});
