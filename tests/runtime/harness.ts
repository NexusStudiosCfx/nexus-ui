import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { build } from 'vite';
import nexus from '../../src/vite/index';

/** The path of a Chromium 103 binary, the browser FiveM embeds. Runtime tests need it. */
export const CHROMIUM_103 = process.env.NEXUS_CHROMIUM_103;

if (!CHROMIUM_103) {
  console.warn('Runtime tests skipped: set NEXUS_CHROMIUM_103 to the path of a Chromium 103 binary to run them.');
}

export const fixtures = resolve(fileURLToPath(import.meta.url), '../../fixtures');

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.wav': 'audio/wav',
};

/** One second of silence as a WAV file, so that sound tests need no binary fixture. */
function silence(): Buffer {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

function serve(folder: string): Promise<Server> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] as string);
    if (path === '/silence.wav') {
      response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(silence());
      return;
    }
    const file = normalize(join(folder, path === '/' ? 'index.html' : path));
    if (!file.startsWith(folder) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

/** What stands in for the game: a development host, the page of a resource, the frame of an app, or the browser of a display. */
export type Mode = 'host' | 'game' | 'phone' | 'tablet' | 'world';

/**
 * Runs in the page before its scripts. It counts the listeners on the window and the document,
 * which is how a test proves that a closed screen left none behind, and stands in for FiveM:
 * as a development host, as the game's own browser, or as the frame LB Phone or LB Tablet gives
 * an app. That frame has no resource name, and LB Tablet wraps what Lua sends to it. The browser
 * of a display has no resource name either, and gets what Lua sends as it is.
 */
export function installHost(mode: Mode): void {
  const sent: unknown[] = [];
  let receive: (message: unknown) => void = () => {};
  const globals = new Set<EventTarget>([window, document]);
  const listeners = new Set<string>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const key = (target: EventTarget, type: string, listener: object | null, options: unknown): string => {
    const capture = typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture;
    if (listener && !ids.has(listener)) ids.set(listener, nextId++);
    return `${target === window ? 'window' : 'document'}:${type}:${listener ? ids.get(listener) : ''}:${capture}`;
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  // The test driver registers listeners of its own; only those of the built app count.
  const fromApp = (): boolean => /\/assets\//.test(new Error().stack ?? '');
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) {
    if (globals.has(this) && fromApp()) listeners.add(key(this, type, listener, options));
    return add.call(this, type, listener, options as AddEventListenerOptions);
  };
  EventTarget.prototype.removeEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) {
    if (globals.has(this)) listeners.delete(key(this, type, listener, options));
    return remove.call(this, type, listener, options as EventListenerOptions);
  };

  const host = {
    resource: 'fixture',
    post(message: unknown) {
      sent.push(message);
      return Promise.resolve({});
    },
    onMessage(listener: (message: unknown) => void) {
      receive = listener;
    },
  };
  const post = (message: object): void => {
    const wire = { __nexus: 1, ...message };
    window.postMessage(mode === 'tablet' ? { action: 'nexus', data: wire } : wire, '*');
  };
  Object.assign(
    window,
    mode === 'host' ? { __NEXUS_HOST__: host, lua: (message: object) => receive({ __nexus: 1, ...message }) } : { invokeNative: () => {}, lua: post },
    mode === 'game' ? { GetParentResourceName: () => 'fixture' } : {},
    { sentToLua: sent, globalListeners: () => [...listeners] },
  );
}

export interface Fixture {
  page: Page;
  /** Sends the page a message as Lua would. */
  lua(message: Record<string, unknown>): Promise<void>;
  /** Opens a screen and waits until it is mounted. */
  open(screen: string, props?: Record<string, unknown>): Promise<void>;
  /** What the page has sent to Lua so far. */
  sent(): Promise<Record<string, unknown>[]>;
  /** How many nodes the body holds, not counting the whitespace of the HTML file itself. */
  nodes(): Promise<number>;
  /** Uncaught errors and console errors of the page. */
  errors: string[];
  /** The addresses the page posted to, outside a development host. */
  endpoints: string[];
  close(): Promise<void>;
}

let shared: Promise<{ url: string; out: string; stop: () => Promise<void> }> | undefined;
let browser: Promise<Browser> | undefined;

/** The Chromium 103 instance shared by the tests of a file. */
export function launch(): Promise<Browser> {
  browser ??= chromium.launch({ executablePath: CHROMIUM_103 as string });
  return browser;
}

/** Builds the fixture resource once per test file and serves the result. */
function site(): Promise<{ url: string; out: string; stop: () => Promise<void> }> {
  shared ??= (async () => {
    const out = mkdtempSync(join(tmpdir(), 'nexus-ui-'));
    await build({
      root: join(fixtures, 'app'),
      configFile: false,
      logLevel: 'silent',
      plugins: [nexus()],
      build: { outDir: out, sourcemap: true, minify: false },
    });
    const server = await serve(out);
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/`,
      out,
      stop: async () => {
        await new Promise((done) => server.close(done));
        rmSync(out, { recursive: true, force: true });
      },
    };
  })();
  return shared;
}

/** The JavaScript of the built fixture app, by file name. */
export async function builtScripts(): Promise<Record<string, string>> {
  const { out } = await site();
  const assets = join(out, 'assets');
  return Object.fromEntries(readdirSync(assets).filter((name) => name.endsWith('.js')).map((name) => [name, readFileSync(join(assets, name), 'utf8')]));
}

/**
 * A fresh page of the built fixture app in Chromium 103. By default a development host answers
 * the page. In the other modes the page finds what it finds in FiveM instead: the NUI callback
 * endpoint and messages on the window. `query` is added to the address, as LB does for an app.
 */
export async function openFixture(options: { mode?: Mode; query?: string; viewport?: { width: number; height: number } } = {}): Promise<Fixture> {
  const mode = options.mode ?? 'host';
  const inGame = mode !== 'host';
  const { url } = await site();
  const page = await (await launch()).newPage({ viewport: options.viewport ?? { width: 1280, height: 720 } });
  const errors: string[] = [];
  const posted: Record<string, unknown>[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const endpoints: string[] = [];
  await page.route(/^https:\/\/[\w-]+\/nexus$/, (route) => {
    endpoints.push(route.request().url());
    posted.push(JSON.parse(route.request().postData() ?? 'null') as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
  });
  await page.addInitScript(installHost, mode);
  await page.goto(url + (options.query ?? ''));

  const sent = (): Promise<Record<string, unknown>[]> =>
    inGame ? Promise.resolve([...posted]) : page.evaluate(() => (window as unknown as { sentToLua: Record<string, unknown>[] }).sentToLua);
  const lua = (message: Record<string, unknown>): Promise<void> =>
    page.evaluate((payload) => (window as unknown as { lua: (message: object) => void }).lua(payload), message);
  while (!(await sent()).some((message) => message.t === 'ready')) await page.waitForTimeout(10);

  return {
    page,
    lua,
    sent,
    nodes: () => page.evaluate(() => [...document.body.childNodes].filter((node) => node.nodeType !== 3 || node.nodeValue!.trim()).length),
    errors,
    endpoints,
    async open(screen, props = {}) {
      await lua({ t: 'open', screen, props });
      await page.waitForSelector(`[data-screen="${screen}"] > *`, { state: 'attached' });
    },
    close: () => page.close(),
  };
}

/** Stops the browser and the server. Call it in `afterAll`. */
export async function shutdown(): Promise<void> {
  if (browser) await (await browser).close();
  if (shared) await (await shared).stop();
  browser = undefined;
  shared = undefined;
}
