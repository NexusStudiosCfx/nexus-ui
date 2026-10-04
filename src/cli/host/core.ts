import { isRejection, patchOf, validate, type Contract, type Mock, type MockContext, type Rate, type Schema } from '../../contract';
import type { NexusHost } from '../../runtime/env';

/** Where a page of the resource runs: the game's own NUI page, or an app frame of LB. */
export type Surface = 'main' | 'phone' | 'tablet';

export interface HostScreen {
  name: string;
  layer: 'screen' | 'hud';
  /** Set for the screen that is the root of the app on that surface. */
  surface?: 'phone' | 'tablet' | null;
}

export interface HostOptions {
  /** Shown in the toolbar and as `env.resource`. */
  resource: string;
  contract: Contract;
  /** The default export of `web/mock.ts`, when the project has one. */
  mock: Mock | null;
  screens: HostScreen[];
}

export type Answer = { ok: true; data: unknown } | { ok: false; code: string; message?: string; details?: unknown };

/** What the host reports to whatever shows it: the dev toolbar in a browser. */
export interface HostObserver {
  /** The set of open screens changed. */
  opened(names: string[]): void;
  /** Something crossed the bridge. `answer` and `ms` are given for calls. */
  crossed(kind: 'call' | 'push' | 'client' | 'state', name: string, data: unknown, answer?: Answer, ms?: number): void;
  /** A component asked for a toolbar button. Returns the function that removes it. */
  action(label: string, run: () => void): () => void;
}

export interface Host {
  /** What the page's bridge talks to, to be installed as `window.__NEXUS_HOST__`. */
  bridge: NexusHost;
  /** The same for the page inside the frame of an app. */
  frame(surface: 'phone' | 'tablet'): NexusHost;
  /** The frame of an app was closed, as when LB closes the app. */
  closeFrame(surface: 'phone' | 'tablet'): void;
  /** Opens a screen with these props, or with the ones `web/mock.ts` gives it. */
  open(name: string, props?: Record<string, unknown>): void;
  close(name: string): void;
  isOpen(name: string): boolean;
}

type Message = Record<string, unknown>;
type Listener = (message: unknown) => void;

function has(table: object, key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

/** What a value looks like after the trip through JSON that every real message makes. */
function wire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Stands in for FiveM and both Lua runtimes. It answers the page's bridge the way they would,
 * and enforces the contract the way the Lua side does: unknown names, invalid data and calls
 * over the rate limit are refused with the same codes and the same messages.
 *
 * Like the client runtime it serves up to three pages: a call is answered to the page that made
 * it, and pushes, state and the locale go to every page that is up.
 */
export function createHost(options: HostOptions, observer: HostObserver): Host {
  const { contract, mock } = options;
  const definition = mock?.definition ?? {};
  const pages: Record<Surface, { ready: boolean; listeners: Listener[] }> = {
    main: { ready: false, listeners: [] },
    phone: { ready: false, listeners: [] },
    tablet: { ready: false, listeners: [] },
  };
  const open = new Map<string, Record<string, unknown>>();
  const state: Record<string, Record<string, unknown>> = {};
  const windows = new Map<string, number[]>();

  const deliver = (surface: Surface, message: Message): void => {
    const page = pages[surface];
    if (!page.ready) return;
    const delivered = wire({ __nexus: 1, ...message });
    // Messages from Lua arrive in a later task, never in the middle of the code that caused them.
    setTimeout(() => page.listeners.forEach((listener) => listener(delivered)), 0);
  };

  const broadcast = (message: Message): void => {
    for (const surface of Object.keys(pages) as Surface[]) deliver(surface, message);
  };

  const screen = (name: string): HostScreen | undefined => options.screens.find((entry) => entry.name === name);

  const openScreen = (name: string, props?: Record<string, unknown>): void => {
    const found = screen(name);
    if (!found) throw new Error(`[nexus] there is no screen '${name}'. Screens are the .nexus files in web/screens.`);
    if (found.surface) throw new Error(`[nexus] '${name}' is the ${found.surface} app. Its frame opens it, as LB does in game.`);
    const next = props ?? definition.screens?.[name] ?? {};
    open.set(name, next);
    deliver('main', { t: 'open', screen: name, props: next });
    observer.opened([...open.keys()]);
  };

  /** The screen opened last that is not a hud: the one Escape and `nui.close()` are meant for. */
  const topScreen = (): string | undefined => [...open.keys()].reverse().find((name) => screen(name)?.layer !== 'hud');

  const closeScreen = (name: string | undefined): void => {
    if (name === undefined || !open.delete(name)) return;
    deliver('main', { t: 'close', screen: name });
    observer.opened([...open.keys()]);
  };

  const check = (what: string, schema: Schema | undefined, value: unknown): void => {
    if (!schema) throw new Error(`[nexus] ${what} is not in web/contract.ts`);
    const result = validate(schema, value);
    if (!result.ok) throw new Error(`[nexus] ${what}: the data does not match the contract: ${result.error}`);
  };

  const context: MockContext = {
    push(name, data) {
      check(`push '${name}'`, has(contract.pushes, name) ? contract.pushes[name] : undefined, wire(data));
      observer.crossed('push', name, data);
      broadcast({ t: 'push', name, data });
    },
    set(name, patch) {
      const schema = has(contract.state, name) ? contract.state[name] : undefined;
      const next = wire(patch) as Record<string, unknown>;
      check(`state '${name}'`, schema && patchOf(schema), next);
      // As Nexus.set does: only the keys whose value changed are sent, compared by content.
      const current = (state[name] ??= {});
      const changed: Record<string, unknown> = {};
      for (const key of Object.keys(next)) {
        if (JSON.stringify(current[key]) === JSON.stringify(next[key])) continue;
        current[key] = next[key];
        changed[key] = next[key];
      }
      if (Object.keys(changed).length === 0) return;
      observer.crossed('state', name, changed);
      broadcast({ t: 'state', name, data: changed });
    },
    unset(name, ...keys) {
      if (!has(contract.state, name)) throw new Error(`[nexus] state '${name}' is not in web/contract.ts`);
      const current = state[name] ?? {};
      const removed = (keys as string[]).filter((key) => key in current);
      for (const key of removed) delete current[key];
      if (removed.length === 0) return;
      observer.crossed('state', name, { removed });
      broadcast({ t: 'state', name, removed });
    },
    open: openScreen,
    close: (name) => closeScreen(name ?? topScreen()),
    action: (label, run) => observer.action(label, run),
  };

  /** The same sliding window the Lua runtimes keep: at most `limit` calls in any `per` seconds. */
  const allow = (name: string, rate: Rate): boolean => {
    const now = performance.now();
    const recent = (windows.get(name) ?? []).filter((time) => now - time < rate.per * 1000);
    if (recent.length >= rate.limit) {
      windows.set(name, recent);
      return false;
    }
    windows.set(name, [...recent, now]);
    return true;
  };

  const answerCall = async (name: unknown, data: unknown): Promise<Answer> => {
    const call = has(contract.calls, name) ? contract.calls[name] : undefined;
    if (!call || typeof name !== 'string') {
      return { ok: false, code: 'invalid', message: `'${String(name)}' is not a call in web/contract.ts` };
    }
    if (!allow(name, call.rate)) return { ok: false, code: 'rate_limited' };

    const input = validate(call.input, data);
    if (!input.ok) return { ok: false, code: 'invalid', message: input.error };

    const handlers = (definition.calls ?? {}) as Record<string, ((input: unknown, context: MockContext) => unknown) | undefined>;
    const handler = has(handlers, name) ? handlers[name] : undefined;
    if (!handler) {
      console.warn(`[nexus] web/mock.ts has no handler for the call '${name}', so it is answered with "offline". Add one under calls.`);
      return { ok: false, code: 'offline' };
    }

    let result: unknown;
    try {
      result = await handler(data, context);
    } catch (error) {
      console.error(`[nexus] the mock handler of '${name}' raised an error:`, error);
      return { ok: false, code: 'rejected' };
    }

    if (isRejection(result)) {
      const code = result.nexusRejection;
      const details = wire(result.details);
      if (details === undefined) return { ok: false, code };
      const schema = has(call.errors, code) ? call.errors[code] : undefined;
      const fits = schema ? validate(schema, details) : null;
      if (fits?.ok) return { ok: false, code, details };
      const why = fits ? `that do not match the contract: ${fits.error}` : 'which the call does not declare under errors';
      console.error(`[nexus] the mock handler of '${name}' returned details with '${code}' ${why}`);
      return { ok: false, code: 'rejected' };
    }

    result = wire(result);
    const output = validate(call.output, result);
    if (!output.ok) {
      console.error(`[nexus] the mock handler of '${name}' returned something that does not match the contract: ${output.error}`);
      return { ok: false, code: 'rejected' };
    }
    return { ok: true, data: result };
  };

  const onCall = async (surface: Surface, message: Message): Promise<void> => {
    if (typeof message.id !== 'number') return;
    const started = performance.now();
    const answer = await answerCall(message.name, message.data);
    observer.crossed('call', String(message.name), message.data, answer, performance.now() - started);
    deliver(surface, { t: 'res', id: message.id, ...answer });
  };

  const onClient = (message: Message): void => {
    const { name, data } = message;
    const schema = has(contract.client, name) ? contract.client[name] : undefined;
    if (!schema || typeof name !== 'string') {
      console.warn(`[nexus] the page sent '${String(name)}', which is not a client message in web/contract.ts`);
      return;
    }
    const result = validate(schema, data);
    if (!result.ok) {
      console.warn(`[nexus] the page sent '${name}' with data that does not match the contract: ${result.error}`);
      return;
    }
    observer.crossed('client', name, data);
    const handlers = (definition.client ?? {}) as Record<string, ((data: unknown, context: MockContext) => void) | undefined>;
    if (has(handlers, name)) handlers[name]?.(data, context);
  };

  const onReady = (surface: Surface): void => {
    pages[surface].ready = true;
    if (definition.locale) deliver(surface, { t: 'locale', data: definition.locale });
    for (const name of Object.keys(state)) {
      if (Object.keys(state[name] as object).length > 0) deliver(surface, { t: 'state', name, data: state[name] });
    }
    if (surface !== 'main') return;
    for (const [name, props] of open) deliver('main', { t: 'open', screen: name, props });
  };

  const receive = (surface: Surface, message: unknown): Promise<unknown> => {
    const received = wire(message) as Message | null;
    if (typeof received === 'object' && received !== null) {
      if (received.t === 'ready') onReady(surface);
      else if (received.t === 'call') void onCall(surface, received);
      else if (received.t === 'client') onClient(received);
      else if (received.t === 'close' && surface === 'main') closeScreen(typeof received.screen === 'string' ? received.screen : topScreen());
    }
    return Promise.resolve({});
  };

  const bridgeFor = (surface: Surface): NexusHost => ({
    resource: options.resource,
    post: (message) => receive(surface, message),
    onMessage(listener) {
      pages[surface].listeners.push(listener);
    },
    action: (label, run) => observer.action(label, run),
  });

  for (const [name, initial] of Object.entries(definition.state ?? {})) {
    state[name] = { ...(initial as Record<string, unknown>) };
  }

  const host: Host = {
    bridge: bridgeFor('main'),
    frame: bridgeFor,
    closeFrame(surface) {
      pages[surface] = { ready: false, listeners: [] };
    },
    open: openScreen,
    close: closeScreen,
    isOpen: (name) => open.has(name),
  };

  definition.setup?.(context);
  return host;
}
