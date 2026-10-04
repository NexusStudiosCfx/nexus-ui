import { toDiagnostic } from '../../../../src/compiler/diagnostics';
import { problemOf, type Build, type Problem } from './build';
import { ENTRY } from './project';
import { CHANNEL, MODULE_LINE_OFFSET, MODULE_URL, fromFrame, type FromFrame, type RunMessage, type ToFrame } from './protocol';
import { offsetOf, trace } from './trace';

export type Traffic = Extract<FromFrame, { type: 'crossed' | 'console' }>;

export interface PreviewEvents {
  /** A new frame took the place of the old one. Everything reported before belongs to the old one. */
  replaced(build: Build): void;
  /** The build could not start. The frame that was on screen, if any, stays. */
  failed(problem: Problem): void;
  /** The running preview raised an error. */
  error(problem: Problem): void;
  traffic(entry: Traffic): void;
  /** The screen was opened or closed. */
  opened(open: boolean): void;
  /** The buttons the mock and the components asked for. */
  actions(actions: { id: number; label: string }[]): void;
}

export interface Preview {
  run(build: Build): void;
  /** Opens the screen again after it was closed. */
  open(): void;
  action(id: number): void;
  focus(): void;
  destroy(): void;
}

interface Run {
  frame: HTMLIFrameElement;
  build: Build;
  /** What the frame reported before it was on screen. */
  early: FromFrame[];
  actions: Map<number, string>;
  watchdog: ReturnType<typeof setTimeout>;
}

const START_TIMEOUT = 8000;
const FRAME_PATTERN = new RegExp(`${MODULE_URL.replace(/[/:]/g, '\\$&')}([\\w.-]+):(\\d+):(\\d+)`, 'g');

/** Says where an error of the frame happened in the files of the project, from its stack trace. */
export function locateError(build: Build, error: { name: string; message: string; stack: string }): Problem {
  const message = error.name && error.name !== 'Error' && !error.message.startsWith(error.name) ? `${error.name}: ${error.message}` : error.message;
  for (const match of error.stack.matchAll(FRAME_PATTERN)) {
    const file = match[1] as string;
    const module = build.modules[file];
    const source = build.files[file];
    if (!module || source === undefined) continue;
    const written = trace(module.steps, { line: Number(match[2]) - MODULE_LINE_OFFSET, column: Number(match[3]) });
    if (!written) continue;
    const start = offsetOf(source, written);
    return problemOf(toDiagnostic(source, file, 'error', { code: 'runtime-error', message, start, end: start + 1 }));
  }
  return { severity: 'error', file: ENTRY, message, code: 'runtime-error' };
}

/**
 * Runs builds in sandboxed frames inside `stage`. A frame has no origin of its own
 * (`sandbox="allow-scripts"`), so the code in it reaches neither the page nor its storage, and
 * the two talk through `postMessage` only. A new build starts in a second frame behind the one
 * on screen and replaces it once its screen is mounted, so the preview never blinks and a build
 * that fails leaves the last working one in place.
 */
export function createPreview(stage: HTMLElement, options: { frameUrl: string; font: Promise<ArrayBuffer | null> }, events: PreviewEvents): Preview {
  let shown: Run | null = null;
  let starting: Run | null = null;

  // The frame has no origin to name as the target. What is sent holds nothing but the project.
  const post = (run: Run, message: ToFrame): void => {
    run.frame.contentWindow?.postMessage({ channel: CHANNEL, message }, '*');
  };

  const discard = (run: Run): void => {
    clearTimeout(run.watchdog);
    run.frame.remove();
  };

  const forward = (run: Run, message: FromFrame): void => {
    if (message.type === 'crossed' || message.type === 'console') events.traffic(message);
    else if (message.type === 'opened') events.opened(message.names.length > 0);
    else if (message.type === 'error') events.error(locateError(run.build, message));
    else if (message.type === 'action-added' || message.type === 'action-removed') {
      if (message.type === 'action-added') run.actions.set(message.id, message.label);
      else run.actions.delete(message.id);
      events.actions([...run.actions].map(([id, label]) => ({ id, label })));
    }
  };

  const fail = (run: Run, problem: Problem): void => {
    if (starting !== run) return;
    starting = null;
    discard(run);
    events.failed(problem);
  };

  const start = async (run: Run): Promise<void> => {
    const { build } = run;
    const font = await options.font;
    if (starting !== run) return;
    const modules = Object.fromEntries(Object.entries(build.modules).map(([name, module]) => [name, module.code]));
    const message: RunMessage = { type: 'run', modules, hasContract: 'contract.ts' in build.modules, hasMock: 'mock.ts' in build.modules, layer: build.screen?.layer ?? 'screen', font };
    post(run, message);
  };

  const receive = (event: MessageEvent): void => {
    const run = [starting, shown].find((candidate) => candidate && event.source === candidate.frame.contentWindow);
    const message = run && fromFrame(event.data);
    if (!run || !message) return;

    if (run === shown) return forward(run, message);
    if (message.type === 'loaded') void start(run);
    else if (message.type === 'error') fail(run, locateError(run.build, message));
    else if (message.type === 'mounted') {
      clearTimeout(run.watchdog);
      if (shown) discard(shown);
      shown = run;
      starting = null;
      run.frame.classList.remove('is-starting');
      events.replaced(run.build);
      for (const early of run.early) forward(run, early);
      run.early = [];
    } else run.early.push(message);
  };

  addEventListener('message', receive);

  return {
    run(build) {
      if (starting) discard(starting);
      const frame = document.createElement('iframe');
      frame.className = 'nxp-frame is-starting';
      frame.title = 'Preview';
      frame.setAttribute('sandbox', 'allow-scripts');
      const run: Run = {
        frame,
        build,
        early: [],
        actions: new Map(),
        watchdog: setTimeout(() => fail(run, { severity: 'error', file: ENTRY, message: 'The preview did not start. Its frame could not be loaded, or the code never stopped running.' }), START_TIMEOUT),
      };
      starting = run;
      frame.src = options.frameUrl;
      stage.append(frame);
    },
    open() {
      if (shown) post(shown, { type: 'open' });
    },
    action(id) {
      if (shown) post(shown, { type: 'action', id });
    },
    focus() {
      shown?.frame.focus();
    },
    destroy() {
      removeEventListener('message', receive);
      for (const run of [starting, shown]) if (run) discard(run);
      starting = shown = null;
    },
  };
}
