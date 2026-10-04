/**
 * The page's half of the bridge to Lua.
 *
 * In game, a message to Lua is a POST to the NUI callback `https://<resource>/nexus`, and a
 * message from Lua arrives as a `message` event on the window. Lua answers the POST at once with
 * an empty object; the result of a call comes back later as a `res` message.
 *
 * In a browser there is no Lua. A development host stands in for it by installing, before the
 * page's scripts run:
 *
 *   window.__NEXUS_HOST__ = {
 *     post(message): Promise<unknown>,   // receives what the page sends to Lua
 *     onMessage(listener): void,         // the page registers its receiver for Lua's messages
 *     resource?: string,
 *     action?(label, run): () => void,   // dev toolbar buttons, see dev.action
 *   }
 *
 * When it is present the page talks to it instead of to FiveM. With neither, calls reject with
 * the code `offline`.
 *
 * An app in LB Phone or LB Tablet is the same page in a frame of theirs, loaded as
 * `index.html?surface=phone&resource=<name>`. It posts to the NUI callback of that resource and
 * adds `surface` to every message, so that Lua can answer the frame that asked. Lua reaches it
 * through LB's `SendCustomAppMessage`, which LB forwards to the frame with `postMessage`. LB's
 * own convention for such a message is `{ action, data }`. The page accepts the wire message as
 * it is and as the `data` of that envelope, so Lua may send it either way. LB Tablet only
 * forwards while the app is the one in front, and neither keeps a message for a frame that is
 * not there: an app gets its state when it says `ready`, not before.
 *
 * A world screen is the same page in a browser of its own, drawn on a prop and loaded as
 * `index.html?surface=world&screen=<name>&display=<id>&resource=<name>`. It posts to the same
 * callback with `surface` and `display` on every message, and Lua reaches it with
 * `SendDuiMessage`, which arrives as a `message` event like everything else. Lua opens its
 * screen, with its props, when the page has said `ready`. What only such a page needs, and what
 * the page of the resource needs while a player operates a display, is in `./world`, which is
 * loaded when the first message for it arrives.
 *
 * Page to Lua: `{ t: 'ready' }`, `{ t: 'call', id, name, data }`, `{ t: 'client', name, data }`,
 * `{ t: 'close', screen? }`, each with `surface: 'phone' | 'tablet'` when sent by an app.
 * Lua to page, always with `__nexus: 1`: `{ t: 'open', screen, props }`, `{ t: 'close', screen }`,
 * `{ t: 'push', name, data }`, `{ t: 'state', name, data }` (the changed keys),
 * `{ t: 'locale', data }`, `{ t: 'res', id, ok: true, data }` and
 * `{ t: 'res', id, ok: false, code, message?, details? }`.
 */

import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals-core';
import { query } from './env';
import { locale } from './i18n';
import { closeScreen, defineScreens, openScreen, openScreens, requests, type ScreenLoader } from './screens';
import { currentScope, invoke, own } from './scope';
import { patch, store } from './store';

/**
 * Filled in by the declaration file generated from `web/contract.ts`, which is what makes
 * `nui.call`, `nui.on`, `nui.client` and `nui.state` checked against the contract.
 */
export interface NexusContract {}

type Section<Key extends string, Fallback> = NexusContract extends Record<Key, infer Entries> ? Entries : Fallback;
type Calls = Section<'calls', Record<string, { input: any; output: any }>>;
type Pushes = Section<'pushes', Record<string, any>>;
type ClientMessages = Section<'client', Record<string, any>>;
type States = Section<'state', Record<string, any>>;
type Screens = Section<'screens', Record<string, any>>;

/**
 * The props of a screen as the `screens` section of `web/contract.ts` declares them.
 *
 * @example
 * type Props = ScreenProps<'shop'>;
 */
export type ScreenProps<Name extends keyof Screens & string> = Screens[Name];

type CallName = keyof Calls & string;
type Input<Name extends CallName> = Calls[Name] extends { input: infer Data } ? Data : never;
type Output<Name extends CallName> = Calls[Name] extends { output: infer Data } ? Data : never;

export interface CallOptions {
  /** Milliseconds to wait for the answer. Default: 10000. */
  timeout?: number;
}

/**
 * Why a call failed. `code` is `timeout`, `rate_limited`, `invalid`, `rejected`, `offline`, or a
 * code the handler returned with `Nexus.reject(code, details)`. `details` is what it passed along.
 */
export class NuiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message?: string, details?: unknown) {
    super(message || code);
    this.name = 'NuiError';
    this.code = code;
    this.details = details;
  }
}

interface Pending {
  name: string;
  resolve: (data: unknown) => void;
  reject: (error: NuiError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireMessage {
  __nexus?: number;
  t?: string;
  screen?: string;
  props?: Record<string, unknown>;
  name?: string;
  data?: unknown;
  id?: number;
  ok?: boolean;
  code?: string;
  message?: string;
  details?: unknown;
}

const pending = new Map<number, Pending>();
const inFlight = new Map<string, Signal<number>>();
const busy = new Map<string, ReadonlySignal<boolean>>();
const listeners = new Map<string, Set<(data: unknown) => void>>();
const states = new Map<string, Record<string, unknown>>();
let lastId = 0;
let listening = false;
// Under `nexus dev`: says what is wrong with the props a screen is opened with, if anything.
let checkProps: StartOptions['check'];
let world: StartOptions['world'];

function post(message: Record<string, unknown>): Promise<unknown> {
  const surface = query('surface');
  if (surface) message.surface = surface;
  const display = query('display');
  if (display) message.display = display;
  const host = window.__NEXUS_HOST__;
  if (host) return host.post(message);
  // The address names the resource of an app. A page of the resource itself asks the game.
  const resource = query('resource') || window.GetParentResourceName?.();
  if (!resource) return Promise.reject(new NuiError('offline'));
  return fetch(`https://${resource}/nexus`, { method: 'POST', body: JSON.stringify(message) });
}

function counter(name: string): Signal<number> {
  let count = inFlight.get(name);
  if (!count) inFlight.set(name, (count = signal(0)));
  return count;
}

/**
 * Counts a call in or out. The count is read without subscribing: a call made inside an effect
 * must not make that effect depend on the counter it has just changed.
 */
function count(name: string, by: number): void {
  const calls = counter(name);
  calls.value = calls.peek() + by;
}

function state(name: string): Record<string, unknown> {
  let current = states.get(name);
  if (!current) states.set(name, (current = store({})));
  return current;
}

function settle(id: number, error?: NuiError, data?: unknown): void {
  const call = pending.get(id);
  if (!call) return;
  pending.delete(id);
  clearTimeout(call.timer);
  count(call.name, -1);
  if (error) call.reject(error);
  else call.resolve(data);
}

function receive(received: WireMessage | null): void {
  // LB Tablet wraps what Lua sent to an app as `{ action, data }`. Anything else is not ours.
  const message = received && (received.__nexus ? received : (received.data as WireMessage | null));
  if (!message || message.__nexus !== 1) return;
  const { t, name = '', data } = message;
  batch(() => {
    if (t === 'open') {
      if (globalThis.__NEXUS_DEV__ && checkProps) {
        const problem = checkProps(message.screen as string, message.props || {});
        if (problem) console.error(`[nexus] the screen "${message.screen}" was opened with props that do not match web/contract.ts: ${problem}`);
      }
      openScreen(message.screen as string, message.props);
    } else if (t === 'close') closeScreen(message.screen as string);
    else if (t === 'locale') locale.value = data as typeof locale.value;
    else if (t === 'state') patch(state(name), data as Record<string, unknown>, true);
    else if (t === 'res') settle(message.id as number, message.ok ? undefined : new NuiError(message.code || 'rejected', message.message, message.details), data);
    else if (t === 'push') for (const listener of [...(listeners.get(name) || [])]) listener(data);
    else if (world) void world().then((module) => module.receive(message, post));
  });
}

function listen(): void {
  if (listening) return;
  listening = true;
  const host = window.__NEXUS_HOST__;
  if (host) host.onMessage((message) => receive(message as WireMessage));
  else addEventListener('message', (event) => receive(event.data));
}

interface Nui {
  /**
   * Calls a server handler and resolves with its answer. Rejects with a `NuiError`.
   *
   * @example
   * const { balance } = await nui.call('shop:buy', { item: 'water', amount: 2 });
   */
  call<Name extends CallName>(name: Name, ...rest: Input<Name> extends void ? [input?: undefined, options?: CallOptions] : [input: Input<Name>, options?: CallOptions]): Promise<Output<Name>>;
  /** A signal that is true while a call of that name is waiting for its answer. */
  pending(name: CallName): ReadonlySignal<boolean>;
  /** Listens to a push from Lua until the component is removed, or until the returned function is called. */
  on<Name extends keyof Pushes & string>(name: Name, handler: (data: Pushes[Name]) => void): () => void;
  /** Sends a message to client Lua. Nothing comes back. */
  client<Name extends keyof ClientMessages & string>(name: Name, ...data: ClientMessages[Name] extends void ? [] : [data: ClientMessages[Name]]): void;
  /** A reactive object that mirrors what Lua sets with `Nexus.set(name, ...)`. */
  state<Name extends keyof States & string>(name: Name): Readonly<States[Name]>;
  /** Asks Lua to close the screen that has focus. */
  close(): void;
}

export const nui: Nui = {
  call(name: string, input?: unknown, options?: CallOptions) {
    listen();
    const id = ++lastId;
    count(name, 1);
    return new Promise<never>((resolve, reject) => {
      const timer = setTimeout(() => settle(id, new NuiError('timeout')), options?.timeout ?? 10000);
      pending.set(id, { name, resolve: resolve as Pending['resolve'], reject, timer });
      post({ t: 'call', id, name, data: input }).catch(() => settle(id, new NuiError('offline')));
    });
  },

  pending(name) {
    let active = busy.get(name);
    if (!active) busy.set(name, (active = computed(() => counter(name).value > 0)));
    return active;
  },

  on(name: string, handler: (data: never) => void) {
    listen();
    const scope = currentScope();
    const listener = (data: unknown): void => invoke(scope, handler as (data: unknown) => void, data);
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(listener);
    return own(() => void (set as Set<unknown>).delete(listener));
  },

  client(name: string, data?: unknown) {
    post({ t: 'client', name, data }).catch(() => {});
  },

  state(name: string) {
    listen();
    return state(name) as never;
  },

  close() {
    post({ t: 'close' }).catch(() => {});
  },
};

export interface StartOptions {
  /** The screen that is the root of the app on each surface: `{ phone: 'garageApp' }`. */
  surfaces?: Record<string, string>;
  /** Loads what a page needs for world screens. Given when the project has one. */
  world?: () => Promise<typeof import('./world')>;
  /** Under `nexus dev`: returns what is wrong with the props of a screen, or null. */
  check?: (screen: string, props: Record<string, unknown>) => string | null;
}

/**
 * Starts the page: registers the screens, listens for Lua and tells it the page is ready. As an
 * app in LB Phone or LB Tablet it also mounts the screen of that surface, which nobody opens:
 * the app is open for as long as its frame exists. As a display it waits for Lua to open its
 * screen. The entry module generated by the Vite plugin calls this.
 */
export function start(screens: Record<string, ScreenLoader>, options: StartOptions = {}): void {
  defineScreens(screens);
  requests.close = (screen) => void post({ t: 'close', screen }).catch(() => {});
  if (globalThis.__NEXUS_DEV__) checkProps = options.check;
  world = options.world;
  listen();
  const surface = query('surface') as string;
  const root = (options.surfaces || {})[surface];
  if (root) openScreen(root);
  if (world && surface === 'world') void world().then((module) => module.display(() => openScreens.peek() || openScreen(query('screen') as string)));
  post({ t: 'ready' }).catch(() => {});
}
