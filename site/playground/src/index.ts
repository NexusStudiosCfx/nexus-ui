import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoUrl from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import { sanitise } from './engine/project';
import { decodeProject, readFragment } from './engine/share';
import { EXAMPLES } from './examples';
import { createApp, type App, type Project } from './ui/app';
import stylesUrl from './ui/styles.css?url';

export interface MountOptions {
  /** The example to start from, by name. Default: the first one. */
  example?: string;
  /** Files to start from instead of an example: `{ 'Main.nexus': '...', 'contract.ts': '...' }`. */
  files?: Record<string, string>;
  /** A small embed: only the component and the preview. */
  compact?: boolean;
  /** The height while the editor and the preview are side by side: pixels, or any CSS length. */
  height?: number | string;
  /**
   * Whether the project lives in the fragment of the address: read on load (`#code=...` from
   * Share, `#example=name`) and written by Share. Default: true, and false for a compact embed.
   */
  hash?: boolean;
}

export interface Playground {
  /** Stops the preview and removes everything `mount` added. */
  destroy(): void;
}

/** The examples of the menu, in its order. `name` is what the `example` option takes. */
export const examples: readonly { name: string; title: string; description: string }[] = EXAMPLES.map(({ name, title, description }) => ({ name, title, description }));

// The address of the built module: the frame, the stylesheet and the fonts are files next to it.
const here = import.meta.url;
const frameUrl = import.meta.env.DEV ? new URL('/frame.html', location.href).href : new URL('frame.html', here).href;

let font: Promise<ArrayBuffer | null> | undefined;

/** The UI typeface as bytes, which is the one way to hand a font to a frame without an origin. */
function previewFont(): Promise<ArrayBuffer | null> {
  font ??= fetch(interUrl).then(
    (response) => (response.ok ? response.arrayBuffer() : null),
    () => null,
  );
  return font;
}

/** A shadow tree cannot declare fonts, so the document gets them, unless the page has them already. */
function declareFonts(): void {
  const declared = new Set([...document.fonts].map((face) => face.family.replace(/["']/g, '')));
  for (const [family, url] of [['Inter Variable', interUrl], ['JetBrains Mono Variable', monoUrl]] as const) {
    if (!declared.has(family)) document.fonts.add(new FontFace(family, `url(${JSON.stringify(url)}) format("woff2")`, { weight: '100 900', display: 'swap' }));
  }
}

function exampleProject(name: string | null | undefined): Project | null {
  const found = EXAMPLES.find((example) => example.name === name);
  return found ? { files: found.files, example: found.name, shared: false } : null;
}

/** The project the fragment of the address names: shared code, or an example. */
async function linkedProject(): Promise<Project | null> {
  const code = readFragment('code');
  const files = code ? await decodeProject(code) : null;
  return files ? { files, example: null, shared: true } : exampleProject(readFragment('example'));
}

/**
 * Puts a sandbox into `element`, replacing what it holds. The sandbox lives in a shadow tree,
 * so the styles of the page and its own do not reach each other.
 *
 * @example
 * const playground = mount(document.querySelector('#playground'), { example: 'hud', height: 640 });
 */
export function mount(element: HTMLElement, options: MountOptions = {}): Playground {
  const compact = options.compact === true;
  const fragment = options.hash ?? !compact;
  const height = typeof options.height === 'number' ? `${options.height}px` : (options.height ?? null);

  const host = document.createElement('div');
  host.className = 'nexus-playground';
  host.style.display = 'block';
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = document.createElement('link');
  styles.rel = 'stylesheet';
  styles.href = stylesUrl;
  const container = document.createElement('div');
  container.className = 'nxp';
  // Hidden until its styles are there, with their height held free so the page does not jump.
  container.style.visibility = 'hidden';
  host.style.minHeight = height ?? (compact ? '380px' : '640px');
  shadow.append(styles, container);
  element.replaceChildren(host);
  declareFonts();

  let app: App | null = null;
  let destroyed = false;

  const start = async (): Promise<void> => {
    const given = options.files ? sanitise(options.files) : null;
    const project =
      (fragment ? await linkedProject() : null) ??
      (given ? { files: given, example: null, shared: false } : null) ??
      exampleProject(options.example) ??
      exampleProject(EXAMPLES[0]?.name);
    if (destroyed || !project) return;
    app = createApp(shadow, container, { ...project, compact, height, fragment, frameUrl, font: previewFont() });
  };

  // A link on the same page to another example or to shared code changes only the fragment.
  const follow = async (): Promise<void> => {
    const project = await linkedProject();
    if (project && app) app.load(project);
  };

  const reveal = (): void => {
    container.style.visibility = '';
    host.style.minHeight = '';
  };
  styles.addEventListener('load', reveal);
  styles.addEventListener('error', reveal);
  if (fragment) addEventListener('hashchange', follow);
  void start();

  return {
    destroy() {
      destroyed = true;
      removeEventListener('hashchange', follow);
      app?.destroy();
      host.remove();
    },
  };
}
