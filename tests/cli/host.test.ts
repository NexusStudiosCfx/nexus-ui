import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHost, type Answer, type Host, type HostObserver } from '../../src/cli/host/core';
import { contract, mock, reject, s } from '../../src/contract';

const definition = contract({
  calls: {
    'shop:buy': {
      input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
      output: s.object({ ok: s.boolean(), balance: s.int() }),
      rate: { limit: 3, per: 10 },
    },
    'shop:list': { output: s.array(s.string()) },
    'shop:unanswered': {},
  },
  pushes: { 'shop:stock': s.object({ item: s.string(), stock: s.int({ min: 0 }) }) },
  client: { 'shop:preview': s.object({ item: s.string({ max: 40 }) }) },
  state: { hud: s.object({ health: s.int({ min: 0, max: 200 }), cash: s.int() }) },
});

const SCREENS = [
  { name: 'shop', layer: 'screen' as const },
  { name: 'confirm', layer: 'screen' as const },
  { name: 'hud', layer: 'hud' as const },
];

describe('the mock host', () => {
  let host: Host;
  let received: Record<string, unknown>[];
  let crossed: unknown[][];
  let opened: string[][];
  let previews: string[];
  let listed: unknown;

  /** Lets the messages the host has queued reach the page. */
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  const post = async (message: Record<string, unknown>): Promise<void> => {
    await host.bridge.post(message);
    await settle();
  };

  const call = async (id: number, name: string, data?: unknown): Promise<Record<string, unknown> | undefined> => {
    await post({ t: 'call', id, name, data });
    return received.find((message) => message.t === 'res' && message.id === id);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    received = [];
    crossed = [];
    opened = [];
    previews = [];
    listed = ['water'];

    const observer: HostObserver = {
      opened: (names) => opened.push(names),
      crossed: (...entry) => crossed.push(entry),
      action: () => () => {},
    };
    host = createHost(
      {
        resource: 'demo',
        contract: definition,
        screens: SCREENS,
        mock: mock(definition, {
          locale: { 'shop.title': 'Shop' },
          screens: { shop: { item: 'water' } },
          state: { hud: { health: 100 } },
          calls: {
            'shop:buy': async (input, { push }) => {
              if (input.amount > 50) return reject('not_enough_stock');
              if (input.item === 'bomb') throw new Error('handler crashed');
              push('shop:stock', { item: input.item, stock: 50 - input.amount });
              return { ok: true, balance: 100 - input.amount };
            },
            'shop:list': () => listed as string[],
          },
          client: { 'shop:preview': (data) => void previews.push(data.item) },
          setup: ({ open, set }) => {
            open('hud');
            set('hud', { cash: 5 });
          },
        }),
      },
      observer,
    );
    host.bridge.onMessage((message) => received.push(message as Record<string, unknown>));
    await post({ t: 'ready' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the locale, the state and the open screens when the page is ready', () => {
    expect(received).toEqual([
      { __nexus: 1, t: 'locale', data: { 'shop.title': 'Shop' } },
      { __nexus: 1, t: 'state', name: 'hud', data: { health: 100, cash: 5 } },
      { __nexus: 1, t: 'open', screen: 'hud', props: {} },
    ]);
    expect(host.bridge.resource).toBe('demo');
  });

  it('opens a screen with the props of the mock, and closes the one on top for a close without a name', async () => {
    host.open('shop');
    host.open('confirm', { question: 'Sure?' });
    await settle();
    expect(received.slice(3)).toEqual([
      { __nexus: 1, t: 'open', screen: 'shop', props: { item: 'water' } },
      { __nexus: 1, t: 'open', screen: 'confirm', props: { question: 'Sure?' } },
    ]);

    await post({ t: 'close' });
    expect(host.isOpen('confirm')).toBe(false);
    await post({ t: 'close', screen: 'shop' });
    await post({ t: 'close' });
    // A hud is never what a close without a name means.
    expect(host.isOpen('hud')).toBe(true);
    expect(opened[opened.length - 1]).toEqual(['hud']);
    expect(() => host.open('shpo')).toThrow("there is no screen 'shpo'");
  });

  it('answers a call with the handler, through JSON, and forwards its pushes', async () => {
    expect(await call(1, 'shop:buy', { item: 'water', amount: 2 })).toEqual({ __nexus: 1, t: 'res', id: 1, ok: true, data: { ok: true, balance: 98 } });
    expect(received).toContainEqual({ __nexus: 1, t: 'push', name: 'shop:stock', data: { item: 'water', stock: 48 } });
    const [kind, name, data, answer] = crossed.find((entry) => entry[0] === 'call') as [string, string, unknown, Answer];
    expect([kind, name, data, answer.ok]).toEqual(['call', 'shop:buy', { item: 'water', amount: 2 }, true]);
  });

  it('refuses what the server would refuse, with the same codes and messages', async () => {
    expect(await call(1, 'shop:buy', { item: 'water', amount: 0 })).toMatchObject({ ok: false, code: 'invalid', message: 'amount: expected at least 1' });
    expect(await call(2, 'shop:buy', { item: 'water', amount: 1, free: true })).toMatchObject({ ok: false, code: 'invalid', message: 'unknown key "free"' });
    expect(await call(3, 'shop:steal', {})).toMatchObject({ ok: false, code: 'invalid', message: "'shop:steal' is not a call in web/contract.ts" });
    expect(await call(4, 'toString', {})).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(5, 'shop:list', { page: 1 })).toMatchObject({ ok: false, code: 'invalid', message: 'expected no value' });
  });

  it('turns a rejection, a failing handler and a missing handler into their codes', async () => {
    expect(await call(1, 'shop:buy', { item: 'water', amount: 60 })).toMatchObject({ ok: false, code: 'not_enough_stock' });
    expect(await call(2, 'shop:buy', { item: 'bomb', amount: 1 })).toMatchObject({ ok: false, code: 'rejected' });
    expect(console.error).toHaveBeenCalledWith("[nexus] the mock handler of 'shop:buy' raised an error:", expect.any(Error));
    expect(await call(3, 'shop:unanswered')).toMatchObject({ ok: false, code: 'offline' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("web/mock.ts has no handler for the call 'shop:unanswered'"));
  });

  it('checks what a handler returns against the contract', async () => {
    listed = ['water', 5];
    expect(await call(1, 'shop:list')).toMatchObject({ ok: false, code: 'rejected' });
    expect(console.error).toHaveBeenCalledWith(
      "[nexus] the mock handler of 'shop:list' returned something that does not match the contract: [2]: expected a string",
    );
  });

  it('applies the rate limit as a sliding window', async () => {
    const outcome = async (id: number): Promise<unknown> => {
      const answer = await call(id, 'shop:buy', { item: 'water', amount: 1 });
      return answer?.ok ? 'ok' : answer?.code;
    };
    expect([await outcome(1), await outcome(2), await outcome(3), await outcome(4)]).toEqual(['ok', 'ok', 'ok', 'rate_limited']);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await outcome(5)).toBe('rate_limited');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome(6)).toBe('ok');
    // Another call has a window of its own.
    expect((await call(7, 'shop:list'))?.ok).toBe(true);
  });

  it('validates client messages before the handler of the mock', async () => {
    await post({ t: 'client', name: 'shop:preview', data: { item: 'water' } });
    await post({ t: 'client', name: 'shop:preview', data: { item: 5 } });
    await post({ t: 'client', name: 'shop:nope', data: {} });
    expect(previews).toEqual(['water']);
    expect(console.warn).toHaveBeenCalledWith("[nexus] the page sent 'shop:preview' with data that does not match the contract: item: expected a string");
    expect(console.warn).toHaveBeenCalledWith("[nexus] the page sent 'shop:nope', which is not a client message in web/contract.ts");
  });

  it('ignores a body that is not a message', async () => {
    await post({ t: 'launch' });
    await host.bridge.post('call');
    await host.bridge.post(null);
    await post({ t: 'call', id: 'x', name: 'shop:list' });
    expect(received).toHaveLength(3);
  });
});

describe('the mock context', () => {
  it('sends only the changed keys of a state, and refuses data outside the contract', async () => {
    vi.useFakeTimers();
    const received: unknown[] = [];
    // The loose context type, so that the test can pass what TypeScript would refuse.
    let context = undefined as unknown as { set(name: string, patch: unknown): void; push(name: string, data: unknown): void };
    const host = createHost(
      { resource: 'demo', contract: definition, screens: SCREENS, mock: mock(definition, { setup: (given) => void (context = given as never) }) },
      { opened: () => {}, crossed: () => {}, action: () => () => {} },
    );
    host.bridge.onMessage((message) => received.push(message));
    await host.bridge.post({ t: 'ready' });
    const { set, push } = context;

    set('hud', { health: 100, cash: 5 });
    set('hud', { health: 100, cash: 5 });
    set('hud', { health: 90, cash: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([
      { __nexus: 1, t: 'state', name: 'hud', data: { health: 100, cash: 5 } },
      { __nexus: 1, t: 'state', name: 'hud', data: { health: 90 } },
    ]);

    expect(() => set('hud', { health: 900 })).toThrow("state 'hud': the data does not match the contract: health: expected at most 200");
    expect(() => set('hood', {})).toThrow("state 'hood' is not in web/contract.ts");
    expect(() => push('shop:stock', { item: 'water', stock: -1 })).toThrow("push 'shop:stock': the data does not match the contract: stock: expected at least 0");
    expect(() => push('toString', {})).toThrow("push 'toString' is not in web/contract.ts");
    vi.useRealTimers();
  });
});

describe('the mock host in version 0.2', () => {
  const garage = contract({
    calls: {
      'garage:buy': {
        input: s.object({ model: s.string() }),
        output: s.object({ balance: s.int() }),
        errors: { not_enough_money: s.object({ missing: s.int({ min: 1 }) }) },
      },
    },
    pushes: { 'garage:balance': s.object({ balance: s.int() }) },
    state: { garage: s.object({ count: s.int(), tags: s.optional(s.array(s.string())) }) },
  });

  const SURFACES = [
    { name: 'garage', layer: 'screen' as const, surface: null },
    { name: 'garagePhone', layer: 'screen' as const, surface: 'phone' as const },
  ];

  let actions: string[];
  let pages: Record<'main' | 'phone', Record<string, unknown>[]>;
  let context: { set(name: string, patch: unknown): void; unset(name: string, ...keys: string[]): void; push(name: string, data: unknown): void };
  let host: Host;

  const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    actions = [];
    pages = { main: [], phone: [] };
    host = createHost(
      {
        resource: 'demo',
        contract: garage,
        screens: SURFACES,
        mock: mock(garage, {
          calls: {
            'garage:buy': ({ model }) =>
              model === 'zentorno' ? reject('not_enough_money', { missing: 40 }) : model === 'wrong' ? reject('not_enough_money', { missing: 0 }) : reject('banned', { why: 'x' }),
          },
          setup: (given) => {
            context = given as never;
            given.action('Give money', () => {});
          },
        }),
      },
      { opened: () => {}, crossed: () => {}, action: (label) => (actions.push(label), () => {}) },
    );
    host.bridge.onMessage((message) => pages.main.push(message as Record<string, unknown>));
    host.frame('phone').onMessage((message) => pages.phone.push(message as Record<string, unknown>));
    await host.bridge.post({ t: 'ready' });
    await host.frame('phone').post({ t: 'ready', surface: 'phone' });
    await settle();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets setup add toolbar buttons', () => {
    expect(actions).toEqual(['Give money']);
  });

  it('answers a call to the page that made it, with the details of a refusal', async () => {
    await host.frame('phone').post({ t: 'call', id: 1, name: 'garage:buy', data: { model: 'zentorno' }, surface: 'phone' });
    await settle();
    expect(pages.phone).toEqual([{ __nexus: 1, t: 'res', id: 1, ok: false, code: 'not_enough_money', details: { missing: 40 } }]);
    expect(pages.main).toEqual([]);
  });

  it('checks the details of a refusal against the contract', async () => {
    await host.bridge.post({ t: 'call', id: 1, name: 'garage:buy', data: { model: 'wrong' } });
    await host.bridge.post({ t: 'call', id: 2, name: 'garage:buy', data: { model: 'other' } });
    await settle();
    expect(pages.main.map((message) => message.code)).toEqual(['rejected', 'rejected']);
    expect(console.error).toHaveBeenCalledWith(
      "[nexus] the mock handler of 'garage:buy' returned details with 'not_enough_money' that do not match the contract: missing: expected at least 1",
    );
    expect(console.error).toHaveBeenCalledWith("[nexus] the mock handler of 'garage:buy' returned details with 'banned' which the call does not declare under errors");
  });

  it('sends pushes and state to every page that is up, compares state by content and removes keys', async () => {
    context.set('garage', { count: 1, tags: ['a'] });
    context.set('garage', { count: 1, tags: ['a'] });
    context.unset('garage', 'tags', 'missing');
    context.unset('garage', 'tags');
    context.push('garage:balance', { balance: 5 });
    await settle();
    const expected = [
      { __nexus: 1, t: 'state', name: 'garage', data: { count: 1, tags: ['a'] } },
      { __nexus: 1, t: 'state', name: 'garage', removed: ['tags'] },
      { __nexus: 1, t: 'push', name: 'garage:balance', data: { balance: 5 } },
    ];
    expect(pages.main).toEqual(expected);
    expect(pages.phone).toEqual(expected);
  });

  it('stops sending to an app whose frame was closed, and brings a new frame up to date', async () => {
    context.set('garage', { count: 2 });
    await settle();
    host.closeFrame('phone');
    context.set('garage', { count: 3 });
    await settle();
    expect(pages.phone).toHaveLength(1);

    const reopened: unknown[] = [];
    host.frame('phone').onMessage((message) => reopened.push(message));
    await host.frame('phone').post({ t: 'ready', surface: 'phone' });
    await settle();
    expect(reopened).toEqual([{ __nexus: 1, t: 'state', name: 'garage', data: { count: 3 } }]);
  });

  it('does not open an app from the toolbar or the mock: its frame does', () => {
    expect(() => host.open('garagePhone')).toThrow("'garagePhone' is the phone app. Its frame opens it, as LB does in game.");
  });
});

describe('the mock host and world screens', () => {
  const definition = contract({
    calls: { 'clock:punch': { input: s.object({ pin: s.string({ max: 8 }) }), output: s.object({ ok: s.boolean() }) } },
    pushes: { 'clock:tick': s.object({ time: s.int() }) },
    state: { shift: s.object({ onDuty: s.boolean() }) },
    screens: { clock: s.object({ business: s.string() }) },
  });

  const SCREENS = [
    { name: 'shop', layer: 'screen' as const, surface: null },
    { name: 'clock', layer: 'screen' as const, surface: 'world' as const, size: { width: 1280, height: 720 } },
    { name: 'terminal', layer: 'screen' as const, surface: 'world' as const, size: { width: 800, height: 600 } },
  ];

  let host: Host;
  let pages: Record<'main' | 'clock' | 'terminal', Record<string, unknown>[]>;
  let context: { set(name: string, patch: unknown): void; push(name: string, data: unknown): void };

  const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

  beforeEach(async () => {
    vi.useFakeTimers();
    pages = { main: [], clock: [], terminal: [] };
    host = createHost(
      {
        resource: 'demo',
        contract: definition,
        screens: SCREENS,
        mock: mock(definition, {
          locale: { title: 'Clock' },
          state: { shift: { onDuty: false } },
          worlds: { clock: { props: { business: 'police' } } },
          calls: { 'clock:punch': () => ({ ok: true }) },
          setup: (given) => void (context = given as never),
        }),
      },
      { opened: () => {}, crossed: () => {}, action: () => () => {} },
    );
    host.bridge.onMessage((message) => pages.main.push(message as Record<string, unknown>));
    host.frame('world:clock').onMessage((message) => pages.clock.push(message as Record<string, unknown>));
    host.frame('world:terminal').onMessage((message) => pages.terminal.push(message as Record<string, unknown>));
    await host.bridge.post({ t: 'ready' });
    await host.frame('world:clock').post({ t: 'ready', surface: 'world', display: 'clock' });
    await host.frame('world:terminal').post({ t: 'ready', surface: 'world', display: 'terminal' });
    await settle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the screen of a display when its page is ready, with the props of the mock', () => {
    expect(pages.clock).toEqual([
      { __nexus: 1, t: 'locale', data: { title: 'Clock' } },
      { __nexus: 1, t: 'state', name: 'shift', data: { onDuty: false } },
      { __nexus: 1, t: 'open', screen: 'clock', props: { business: 'police' } },
    ]);
    expect(pages.terminal[2]).toEqual({ __nexus: 1, t: 'open', screen: 'terminal', props: {} });
    expect(pages.main.some((message) => message.t === 'open')).toBe(false);
  });

  it('answers a call to the display that made it, and sends pushes and state to every display', async () => {
    await host.frame('world:terminal').post({ t: 'call', id: 3, name: 'clock:punch', data: { pin: '1' }, surface: 'world', display: 'terminal' });
    context.push('clock:tick', { time: 9 });
    context.set('shift', { onDuty: true });
    await settle();
    const shared = [
      { __nexus: 1, t: 'push', name: 'clock:tick', data: { time: 9 } },
      { __nexus: 1, t: 'state', name: 'shift', data: { onDuty: true } },
    ];
    expect(pages.clock.slice(3)).toEqual(shared);
    expect(pages.terminal.slice(3)).toEqual([...shared, { __nexus: 1, t: 'res', id: 3, ok: true, data: { ok: true } }]);
    expect(pages.main.slice(-2)).toEqual(shared);
  });

  it('sends a display the keyboard as Lua does, and nothing once its frame is closed', async () => {
    host.send('world:clock', { t: 'type', text: 'a' });
    host.send('world:clock', { t: 'key', key: 'Enter' });
    await settle();
    expect(pages.clock.slice(3)).toEqual([
      { __nexus: 1, t: 'type', text: 'a' },
      { __nexus: 1, t: 'key', key: 'Enter' },
    ]);
    host.closeFrame('world:clock');
    host.send('world:clock', { t: 'type', text: 'b' });
    context.push('clock:tick', { time: 1 });
    await settle();
    expect(pages.clock).toHaveLength(5);
  });

  it('does not open a world screen as a screen of the page', () => {
    expect(() => host.open('clock')).toThrow("'clock' is a world screen. Its frame shows it, as a display does in game.");
  });
});
