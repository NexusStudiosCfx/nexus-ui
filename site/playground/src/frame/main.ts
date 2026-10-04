/**
 * The preview frame. It is a sandboxed document without an origin of its own: it holds the
 * runtime, the contract library and the host that stands in for the game, receives the modules
 * of a project from the page that embeds it, and runs them.
 */

import { createHost, type Host } from '../../../../src/cli/host/core';
import * as contracts from '../../../../src/contract/index';
import * as runtime from '../../../../src/runtime/index';
import { CHANNEL, MODULE_URL, unwrap, type ConsoleLevel, type FromFrame, type RunMessage, type ToFrame } from '../engine/protocol';

type Exports = Record<string, unknown>;
type Body = (load: (name: string) => Exports, declare: (getters: Record<string, () => unknown> | Exports, all?: boolean) => void, exports: Exports) => void;

const MAX_TEXT = 4000;
const SCREEN = 'main';

const send = (message: FromFrame): void => parent.postMessage({ channel: CHANNEL, message }, '*');

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const clip = (value: string): string => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...` : value);

const json = (value: unknown): string => (value === undefined ? '' : clip(text(value)));

/** Set by the first error. A run that failed while it started is not announced as mounted. */
let failed = false;

function report(error: unknown): void {
  failed = true;
  const failure = error instanceof Error ? error : new Error(text(error));
  send({ type: 'error', name: failure.name, message: clip(failure.message), stack: clip(failure.stack || '') });
}

addEventListener('error', (event) => report(event.error ?? event.message));
addEventListener('unhandledrejection', (event) => report(event.reason));

for (const level of ['log', 'info', 'warn', 'error'] as ConsoleLevel[]) {
  const original = console[level].bind(console);
  console[level] = (...values: unknown[]) => {
    original(...values);
    send({ type: 'console', level, text: clip(values.map(text).join(' ')) });
  };
}

/** The modules the frame knows: the two libraries, and the files of the project once they ran. */
function loader(modules: Record<string, string>): (name: string) => Exports {
  const loaded = new Map<string, Exports>([
    ['nexus', runtime as Exports],
    ['nexus/contract', contracts as Exports],
  ]);

  const load = (name: string): Exports => {
    const known = loaded.get(name);
    if (known) return known;
    const code = modules[name];
    if (code === undefined) throw new Error(`There is no module '${name}' in the sandbox.`);
    const exports: Exports = {};
    // Known before it runs, so that a module which is imported again meanwhile is found.
    loaded.set(name, exports);
    // An indirect eval, so the module sees the global scope and nothing of this file.
    const body = (0, eval)(`(function ($import, $export, $exports) {\n${code}\n})\n//# sourceURL=${MODULE_URL}${name}`) as Body;
    body(
      load,
      (source, all) => {
        for (const key of Object.keys(source)) {
          if (all && key === 'default') continue;
          const read = all ? () => (source as Exports)[key] : (source as Record<string, () => unknown>)[key];
          Object.defineProperty(exports, key, { get: read, enumerable: true, configurable: true });
        }
      },
      exports,
    );
    return exports;
  };
  return load;
}

let host: Host | null = null;
const actions = new Map<number, () => void>();
let lastAction = 0;

async function run(message: RunMessage): Promise<void> {
  if (message.font) {
    const face = new FontFace('Inter', message.font, { weight: '100 900' });
    document.fonts.add(face);
    await face.load().catch(() => {});
  }

  const load = loader(message.modules);
  let contract: contracts.Contract = contracts.contract({});
  if (message.hasContract) {
    const exported = load('contract.ts').default;
    if (!contracts.isContract(exported)) throw new Error('contract.ts has no contract as its default export. End the file with: export default contract({ ... });');
    contract = exported;
  }
  let mock: contracts.Mock | null = null;
  if (message.hasMock) {
    const exported = load('mock.ts').default;
    if (!contracts.isMock(exported)) throw new Error('mock.ts has no mock as its default export. End the file with: export default mock(contract, { ... });');
    mock = exported;
  }

  host = createHost(
    { resource: 'sandbox', contract, mock, screens: [{ name: SCREEN, layer: message.layer }] },
    {
      opened: (names) => send({ type: 'opened', names }),
      crossed(kind, name, data, answer, ms) {
        const answered = answer && { ok: answer.ok, ...(answer.ok ? { data: json(answer.data) } : { code: answer.code, message: answer.message, data: json(answer.details) }) };
        send({ type: 'crossed', kind, name, data: json(data), ...(answered ? { answer: answered, ms } : {}) });
      },
      action(label, start) {
        const id = ++lastAction;
        actions.set(id, start);
        send({ type: 'action-added', id, label: clip(String(label)) });
        return () => {
          actions.delete(id);
          send({ type: 'action-removed', id });
        };
      },
    },
  );
  window.__NEXUS_HOST__ = host.bridge;

  const screens = contract.screens as Record<string, contracts.Schema | undefined>;
  runtime.start(
    { [SCREEN]: async () => load('Main.nexus') as unknown as runtime.ScreenModule },
    {
      check(screen, props) {
        const schema = screens[screen];
        const result = schema ? contracts.validate(schema, props) : null;
        return result && !result.ok ? result.error : null;
      },
    },
  );
  if (!host.isOpen(SCREEN)) host.open(SCREEN);

  // The screen is shown a moment after it was opened, as in game. One that failed to mount is
  // closed again and its error reported, so a closed screen only counts once that had its time.
  const started = performance.now();
  let closedFor = 0;
  const shown = setInterval(() => {
    const active = host as Host;
    if (!failed && !document.querySelector(`[data-screen="${SCREEN}"]`)) {
      if (active.isOpen(SCREEN) ? performance.now() - started < 2000 : ++closedFor < 5) return;
      if (active.isOpen(SCREEN)) report(new Error('The screen was opened but did not appear.'));
    }
    clearInterval(shown);
    if (!failed) send({ type: 'mounted' });
  }, 10);
}

addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const message = unwrap<ToFrame>(event.data);
  if (!message) return;
  if (message.type === 'run' && !host) run(message).catch(report);
  else if (message.type === 'open' && host && !host.isOpen(SCREEN)) host.open(SCREEN);
  else if (message.type === 'action') actions.get(message.id)?.();
});

globalThis.__NEXUS_DEV__ = true;
send({ type: 'loaded' });
