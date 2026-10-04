import { build, type Build, type Problem } from '../engine/build';
import { ENTRY, kindOf, ordered, type Files } from '../engine/project';
import { createPreview } from '../engine/session';
import { encodeProject, writeFragment } from '../engine/share';
import { EXAMPLES } from '../examples';
import { h, icon } from './dom';
import { createEditor, createViewer } from './editor';
import { createLog } from './log';
import { createMenu } from './menu';
import { createStage } from './stage';

/** What the sandbox is loaded with. */
export interface Project {
  files: Files;
  /** The name of the example the files are, when they are one. */
  example: string | null;
  /** The files came from a shared link. */
  shared: boolean;
}

export interface AppOptions extends Project {
  compact: boolean;
  /** A CSS length for the side-by-side layout. */
  height: string | null;
  /** Keeps the project in the fragment of the address, so that it can be shared as a link. */
  fragment: boolean;
  frameUrl: string;
  font: Promise<ArrayBuffer | null>;
}

/** Narrower than this, the editor and the preview are stacked. */
const NARROW = 820;
const DEBOUNCE = 250;

/** How much a text weighs as a file. */
function bytes(text: string): string {
  const { size } = new Blob([text]);
  return size < 1000 ? `${size} B` : `${(size / 1000).toFixed(1)} kB`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const place = (problem: Problem): string => (problem.line ? `${problem.file}:${problem.line}` : problem.file);

export interface App {
  /** Replaces the project, as picking an example does. */
  load(project: Project): void;
  destroy(): void;
}

export function createApp(shadow: ShadowRoot, container: HTMLElement, options: AppOptions): App {
  const { compact } = options;
  let files: Files = { ...options.files };
  let pristine: Files = { ...options.files };
  let example = options.example;
  let shared = options.shared;
  let active = ENTRY;
  let compiled = false;
  let last: Build | null = null;
  let found: Problem[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tabs = h('div', { class: 'nxp-tabs', role: 'tablist' });
  const editorHost = h('div', { class: 'nxp-editor' });
  const viewerHost = h('div', { class: 'nxp-editor', hidden: true });
  const dot = h('span', { class: 'nxp-dot' });
  const statusText = h('button', { class: 'nxp-status-text', type: 'button' });
  const caret = h('span', { class: 'nxp-caret' });
  const status = h('footer', { class: 'nxp-status' }, dot, statusText, h('span', { class: 'nxp-spacer' }), caret);
  const toggle = h(
    'button',
    { class: 'nxp-toggle', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Compiled JavaScript', title: 'Show the JavaScript the compiler produces' },
    icon('code', 14),
    h('span', { text: 'Compiled' }),
  );
  const chip = h('span', { class: 'nxp-chip is-quiet', text: 'Starting' });
  const actions = h('div', { class: 'nxp-actions' });
  const restart = h('button', { class: 'nxp-icon-button', type: 'button', title: 'Run again from the start', 'aria-label': 'Run again from the start' }, icon('restart', 14));
  const blurb = h('p', { class: 'nxp-blurb' });
  const reset = h('button', { class: compact ? 'nxp-icon-button' : 'nxp-button is-ghost', type: 'button', title: 'Put the code back as it was' }, icon('reset', 14), !compact && h('span', { text: 'Reset' }));
  const shareLabel = h('span', { text: 'Share' });
  const share = h('button', { class: 'nxp-button is-primary', type: 'button', title: 'Copy a link to this code' }, icon('link', 14), shareLabel);

  const log = createLog();
  const stage = createStage({
    reveal: (problem) => reveal(problem),
    open() {
      preview.open();
      // The screen that was closed had the keyboard: the one that opens gets it back.
      preview.focus();
    },
  });
  const menu = createMenu(EXAMPLES, (picked) => {
    if (options.fragment) writeFragment({ example: picked.name });
    shared = false;
    load(picked.files, picked.name);
  });

  const code = h('section', { class: 'nxp-pane nxp-code' }, h('div', { class: 'nxp-tabbar' }, tabs, !compact && toggle, compact && reset), editorHost, viewerHost, status);
  const run = h(
    'section',
    { class: 'nxp-pane nxp-run' },
    h('header', { class: 'nxp-run-head' }, h('span', { class: 'nxp-label', text: 'Preview' }), chip, actions, h('span', { class: 'nxp-spacer' }), restart),
    stage.element,
    !compact && log.element,
  );
  if (!compact) container.append(h('header', { class: 'nxp-bar' }, menu.element, blurb, h('span', { class: 'nxp-spacer' }), reset, options.fragment && share));
  container.append(h('div', { class: 'nxp-body' }, code, run));
  container.classList.toggle('is-compact', compact);
  if (options.height) container.style.setProperty('--nxp-height', options.height);

  const editor = createEditor(editorHost, shadow, {
    change(name, text) {
      files[name] = text;
      clearTimeout(timer);
      timer = setTimeout(rebuild, DEBOUNCE);
    },
    cursor: (line, column) => (caret.textContent = `Ln ${line}, Col ${column}`),
  });
  const viewer = createViewer(viewerHost, shadow);

  const preview = createPreview(stage.frames, options, {
    replaced() {
      stage.block('', null);
      stage.warn(null);
      stage.closed(false);
      log.clear();
      actions.replaceChildren();
      setChip('Running', 'positive');
    },
    failed(problem) {
      stage.block('Runtime error', [problem]);
      setChip('Error', 'danger');
      show([...found.filter((entry) => entry.severity === 'warning'), problem]);
    },
    error(problem) {
      stage.warn(problem);
      log.note('error', `${problem.message}${problem.line ? ` (${place(problem)})` : ''}`);
    },
    traffic: (entry) => log.add(entry),
    opened(open) {
      stage.closed(!open);
      setChip(open ? 'Running' : 'Closed', open ? 'positive' : 'quiet');
    },
    actions(list) {
      actions.replaceChildren(...list.map(({ id, label }) => h('button', { class: 'nxp-button is-small', type: 'button', text: label, onclick: () => preview.action(id) })));
    },
  });

  function setChip(text: string, tone: 'positive' | 'danger' | 'quiet'): void {
    chip.textContent = text;
    chip.className = `nxp-chip is-${tone}`;
  }

  /** The file whose compiled module the output view shows: the open one when it is a component. */
  const component = (): string => (kindOf(active) === 'component' ? active : ENTRY);

  function renderTabs(): void {
    const names = compact ? [ENTRY] : ordered(files);
    tabs.replaceChildren(
      ...names.map((name) => {
        const failing = found.some((problem) => problem.file === name && problem.severity === 'error');
        const tab = h('button', { class: `nxp-tab${name === active ? ' is-active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(name === active), onclick: () => open(name) }, h('span', { text: name }));
        if (failing) tab.append(h('span', { class: 'nxp-dot is-danger', title: 'This file has an error' }));
        return tab;
      }),
    );
  }

  function renderStatus(): void {
    const errors = found.filter((problem) => problem.severity === 'error');
    const warnings = found.filter((problem) => problem.severity === 'warning');
    const first = errors[0] ?? warnings[0];
    statusText.onclick = first ? () => reveal(first) : null;
    statusText.disabled = !first;
    if (compiled && last) {
      const { js, css } = last.compiled[component()] ?? { js: '', css: '' };
      dot.className = 'nxp-dot is-accent';
      statusText.textContent = `${component()} as a build ships it: ${plural(js.split('\n').length - 1, 'line')}, ${bytes(js)}${css ? ` and ${bytes(css)} of scoped CSS` : ''}`;
    } else if (errors.length) {
      dot.className = 'nxp-dot is-danger';
      statusText.textContent = `${plural(errors.length, 'error')}: ${place(errors[0] as Problem)}`;
    } else if (warnings.length) {
      dot.className = 'nxp-dot is-warning';
      statusText.textContent = `${plural(warnings.length, 'warning')}: ${(warnings[0] as Problem).message}`;
    } else {
      dot.className = 'nxp-dot is-positive';
      statusText.textContent = last ? `Compiled in ${last.ms < 10 ? last.ms.toFixed(1) : Math.round(last.ms)} ms` : 'Ready';
    }
    caret.hidden = compiled;
  }

  /** Shows the problems of the last build everywhere they are shown: tabs, editor, status. */
  function show(problems: Problem[]): void {
    found = problems;
    renderTabs();
    renderStatus();
    editor.mark(found.filter((problem) => problem.file === active));
  }

  function renderOutput(): void {
    toggle.setAttribute('aria-pressed', String(compiled));
    editorHost.hidden = compiled;
    viewerHost.hidden = !compiled;
    if (compiled) viewer.show(last?.compiled[component()]?.js ?? '// The compiled module shows here once the code compiles.\n');
  }

  function open(name: string): void {
    active = name;
    editor.open(name, files[name] ?? '');
    show(found);
    renderOutput();
  }

  function reveal(problem: Problem): void {
    if (!(problem.file in files) || (compact && problem.file !== ENTRY)) return;
    compiled = false;
    open(problem.file);
    if (problem.line) editor.reveal(problem.line, problem.column ?? 1);
  }

  function rebuild(): void {
    clearTimeout(timer);
    const result = build(files);
    if (result.ok) {
      last = result.build;
      show(result.build.warnings);
      renderOutput();
      preview.run(result.build);
    } else {
      show(result.problems);
      stage.block('Compile error', result.problems.filter((problem) => problem.severity === 'error'));
      setChip('Error', 'danger');
    }
  }

  function load(next: Files, name: string | null): void {
    files = { ...next };
    pristine = { ...next };
    example = name;
    compiled = false;
    last = null;
    found = [];
    editor.forget();
    menu.select(name, shared ? 'Shared link' : 'Your code');
    blurb.textContent = EXAMPLES.find((entry) => entry.name === name)?.description ?? (shared ? 'Code from a shared link. It runs in an isolated frame.' : '');
    open(ENTRY);
    rebuild();
  }

  toggle.addEventListener('click', () => {
    compiled = !compiled;
    renderOutput();
    renderStatus();
  });
  restart.addEventListener('click', rebuild);
  reset.addEventListener('click', async () => {
    // The address goes back to what the code goes back to.
    if (options.fragment) writeFragment(example ? { example } : shared ? { code: await encodeProject(pristine) } : {});
    load(pristine, example);
  });
  share.addEventListener('click', async () => {
    const address = writeFragment({ code: await encodeProject(files) });
    // Only a page served over HTTPS may write to the clipboard.
    const copied = navigator.clipboard ? await navigator.clipboard.writeText(address).then(() => true, () => false) : false;
    shareLabel.textContent = copied ? 'Link copied' : 'Link is in the address bar';
    setTimeout(() => (shareLabel.textContent = 'Share'), 2000);
  });
  container.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      rebuild();
    }
  });

  const layout = new ResizeObserver(([entry]) => container.classList.toggle('is-narrow', (entry as ResizeObserverEntry).contentRect.width < NARROW));
  container.classList.toggle('is-narrow', container.getBoundingClientRect().width < NARROW);
  layout.observe(container);

  load(files, example);

  return {
    load(project) {
      shared = project.shared;
      load(project.files, project.example);
    },
    destroy() {
      clearTimeout(timer);
      layout.disconnect();
      preview.destroy();
      editor.destroy();
      viewer.destroy();
      container.replaceChildren();
    },
  };
}
