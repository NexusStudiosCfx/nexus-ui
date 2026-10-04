export type AppSurface = 'phone' | 'tablet';

export interface ToolbarOptions {
  resource: string;
  /** The screens of the game's own page. */
  screens: string[];
  /** The surfaces the resource has an app for. */
  apps: AppSurface[];
  hasMock: boolean;
  /** Opens the screen when it is closed and closes it when it is open. */
  toggle(name: string): void;
  /** The frame of an app was shown or hidden. */
  frameChanged(surface: AppSurface, shown: boolean): void;
}

export interface CallAnswer {
  ok: boolean;
  data?: unknown;
  code?: string;
  message?: string;
  details?: unknown;
}

export interface Toolbar {
  setOpen(names: string[]): void;
  addAction(label: string, run: () => void): () => void;
  /** Adds a line to the bridge log. `answer` and `ms` are given for calls. */
  log(kind: 'call' | 'push' | 'client' | 'state', name: string, data: unknown, answer?: CallAnswer, ms?: number): void;
  /** Shows the frame of an app, as LB would when the player opens it. */
  showFrame(surface: AppSurface): void;
}

const MAX_LINES = 100;

/** The size LB gives an app, and the root font size it sets in the frame, which `rem` follows. */
const FRAMES: Record<AppSurface, { width: number; height: number; fontSize: string }> = {
  phone: { width: 390, height: 844, fontSize: 'calc((1vh + 1vw) * 1.214)' },
  tablet: { width: 1280, height: 800, fontSize: 'calc((16 / 18) * (1vh + 1vw))' },
};

const FRAMES_KEY = 'nexus-dev:frames';

// The host itself is the positioned box. With the position on something inside it, the host
// would have no size, and a test that waits for the toolbar to be visible would wait forever.
const STYLE = `
:host { all: initial; position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; }
.dock {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  font: 12px/1.3 'Inter', 'Segoe UI', system-ui, sans-serif; color: #f5f5f5;
}
.bar {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; background: rgba(17, 17, 19, 0.96);
}
.title { color: #71717a; padding: 0 2px 0 4px; }
.group { display: flex; align-items: center; gap: 4px; padding-left: 6px; border-left: 1px solid rgba(255, 255, 255, 0.1); }
.group:empty { display: none; }
button {
  font: inherit; color: inherit; cursor: pointer; padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 10px; background: #1a1a1e;
}
button:hover { border-color: rgba(255, 255, 255, 0.1); background: #232328; }
button:focus-visible { outline: 2px solid rgba(200, 255, 61, 0.3); outline-offset: 1px; }
button[aria-pressed="true"] { background: #c8ff3d; border-color: #c8ff3d; color: #0b1400; font-weight: 600; }
.hint { color: #fbbf24; }
.log {
  width: min(680px, calc(100vw - 24px)); max-height: 40vh; overflow: auto; padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; background: rgba(17, 17, 19, 0.97);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.log[hidden] { display: none; }
.line { display: flex; gap: 8px; padding: 2px 0; white-space: nowrap; }
.kind { flex: none; width: 44px; color: #71717a; }
.name { flex: none; color: #f5f5f5; }
.data { overflow: hidden; text-overflow: ellipsis; color: #a1a1aa; }
.count { flex: none; color: #71717a; }
.count:empty { display: none; }
.ok { flex: none; color: #4ade80; }
.refused { flex: none; color: #f87171; }
.empty { color: #71717a; }
.frames {
  position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 2147483646;
  display: flex; align-items: center; justify-content: center; gap: 28px; pointer-events: none;
}
.device { flex: none; position: relative; pointer-events: auto; }
.shell {
  position: absolute; left: 0; top: 0; box-sizing: border-box; transform-origin: top left; border: 10px solid #1a1a1e; border-radius: 24px; background: #09090b; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 30px 80px rgba(0, 0, 0, 0.6);
}
.shell.phone { border-radius: 46px; }
iframe { display: block; border: 0; background: #09090b; }
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function preview(value: unknown): string {
  if (value === undefined) return '';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function toggleButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = element('button', '', label);
  button.title = title;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', onClick);
  return button;
}

/**
 * The dev toolbar: one button per screen and per app, the buttons components add with
 * `dev.action`, and a log of what crossed the bridge. It lives in a shadow root so that neither
 * its styles nor the page's can reach the other.
 */
export function createToolbar(options: ToolbarOptions): Toolbar {
  const host = element('div', '');
  host.dataset.nexusDev = '';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(element('style', '', STYLE));

  const dock = element('div', 'dock');
  const log = element('div', 'log');
  log.hidden = true;
  log.append(element('div', 'empty', 'Nothing has crossed the bridge yet.'));

  const bar = element('div', 'bar');
  bar.append(element('span', 'title', options.resource));

  const screens = element('div', 'group');
  const buttons = new Map<string, HTMLButtonElement>();
  for (const name of options.screens) {
    const button = toggleButton(name, `Open or close the screen '${name}'`, () => options.toggle(name));
    buttons.set(name, button);
    screens.append(button);
  }
  if (options.screens.length === 0 && options.apps.length === 0) {
    screens.append(element('span', 'hint', 'no screens: add a .nexus file to web/screens'));
  }

  const frames = element('div', 'frames');
  const devices = new Map<AppSurface, { device: HTMLElement; button: HTMLButtonElement }>();

  const remember = (): void => {
    try {
      sessionStorage.setItem(FRAMES_KEY, JSON.stringify([...devices.keys()].filter((surface) => devices.get(surface)?.device.isConnected)));
    } catch {
      // Without storage the frames are simply not restored after a reload.
    }
  };

  /** Scales a frame down to fit a window that is smaller than the device. */
  const fit = (): void => {
    for (const [surface, { device }] of devices) {
      const { width, height } = FRAMES[surface];
      const outer = { width: width + 20, height: height + 20 };
      const scale = Math.min(1, (innerHeight - 96) / outer.height, (innerWidth - 48) / outer.width);
      // The shell keeps the size of the device and is scaled as a whole. Its box in the layout
      // is the one around it, which has the scaled size.
      const shell = device.firstElementChild as HTMLElement;
      shell.style.width = `${outer.width}px`;
      shell.style.height = `${outer.height}px`;
      shell.style.transform = `scale(${scale})`;
      device.style.width = `${outer.width * scale}px`;
      device.style.height = `${outer.height * scale}px`;
    }
  };
  addEventListener('resize', fit);

  const showFrame = (surface: AppSurface): void => {
    const entry = devices.get(surface);
    if (!entry || entry.device.isConnected) return;
    const { width, height, fontSize } = FRAMES[surface];
    const frame = element('iframe', '');
    frame.width = String(width);
    frame.height = String(height);
    frame.title = `${options.resource} in LB ${surface === 'phone' ? 'Phone' : 'Tablet'}`;
    frame.src = `${location.pathname}?surface=${surface}&resource=${encodeURIComponent(options.resource)}`;
    // What LB does to the document of an app once it has loaded.
    frame.addEventListener('load', () => {
      const page = frame.contentDocument;
      if (!page) return;
      page.documentElement.style.fontSize = fontSize;
      page.body.dataset.device = surface;
      page.body.dataset.theme = 'dark';
    });
    const shell = element('div', `shell ${surface}`);
    shell.append(frame);
    entry.device.replaceChildren(shell);
    frames.append(entry.device);
    entry.button.setAttribute('aria-pressed', 'true');
    fit();
    remember();
    options.frameChanged(surface, true);
  };

  const hideFrame = (surface: AppSurface): void => {
    const entry = devices.get(surface);
    if (!entry?.device.isConnected) return;
    entry.device.remove();
    entry.button.setAttribute('aria-pressed', 'false');
    remember();
    options.frameChanged(surface, false);
  };

  const apps = element('div', 'group');
  for (const surface of options.apps) {
    const button = toggleButton(`${surface} app`, `Show or hide the app in a ${surface} frame`, () =>
      devices.get(surface)?.device.isConnected ? hideFrame(surface) : showFrame(surface),
    );
    devices.set(surface, { device: element('div', 'device'), button });
    apps.append(button);
  }

  const actions = element('div', 'group');

  const tools = element('div', 'group');
  const logButton = toggleButton('log', 'Show what crossed the bridge', () => {
    log.hidden = !log.hidden;
    logButton.setAttribute('aria-pressed', String(!log.hidden));
  });
  tools.append(logButton);
  if (!options.hasMock) tools.append(element('span', 'hint', 'no web/mock.ts: calls answer "offline"'));

  bar.append(screens, apps, actions, tools);
  dock.append(log, bar);
  shadow.append(frames, dock);
  document.documentElement.append(host);

  // In game the page is drawn over the world. A plain dark backdrop is the closest neutral
  // stand-in: a white page would wash out a UI made to sit on top of a game.
  document.documentElement.style.background = '#09090b';

  let lines = 0;
  let newest: { key: string; data: HTMLElement; count: HTMLElement; times: number } | null = null;

  return {
    setOpen(names) {
      for (const [name, button] of buttons) button.setAttribute('aria-pressed', String(names.includes(name)));
    },

    addAction(label, run) {
      const button = element('button', '', label);
      button.addEventListener('click', run);
      actions.append(button);
      return () => button.remove();
    },

    showFrame,

    log(kind, name, data, answer, ms) {
      // A HUD sets its state many times a second. Those updates share one line, so that the
      // calls and pushes around them stay in view.
      const key = `${kind} ${name}`;
      if (kind === 'state' && newest?.key === key) {
        newest.data.textContent = preview(data);
        newest.count.textContent = `${++newest.times} updates`;
        return;
      }

      if (lines === 0) log.textContent = '';
      const line = element('div', 'line');
      const text = element('span', 'data', preview(data));
      const count = element('span', 'count');
      line.append(element('span', 'kind', kind), element('span', 'name', name), text, count);
      if (answer) {
        const refusal = `${answer.code ?? 'rejected'}${answer.message ? `: ${answer.message}` : ''}${answer.details === undefined ? '' : ` ${preview(answer.details)}`}`;
        const outcome = answer.ok ? `ok ${preview(answer.data)}` : refusal;
        line.append(element('span', answer.ok ? 'ok' : 'refused', `${outcome} (${Math.round(ms ?? 0)} ms)`));
      }
      log.prepend(line);
      newest = { key, data: text, count, times: 1 };
      if (++lines > MAX_LINES) log.lastElementChild?.remove();
    },
  };
}

/** The app frames that were showing before a reload. */
export function rememberedFrames(): AppSurface[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(FRAMES_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((surface): surface is AppSurface => surface === 'phone' || surface === 'tablet') : [];
  } catch {
    return [];
  }
}
