import { readFileSync } from 'node:fs';
import type { Diagnostic } from '../compiler';
import { toDiagnostic } from '../compiler/diagnostics';
import { suggest } from '../compiler/suggest';
import type { Contract } from '../contract';
import { display, listFiles, type Project } from './project';
import type { Sources } from './sources';

export interface App {
  surface: 'phone' | 'tablet';
  /** The screen that is the root of the app. */
  screen: string;
  file: string;
}

/** The apps of a project: its screens with `<screen surface>`, one per surface. */
export function findApps(sources: Sources): App[] {
  const apps: App[] = [];
  for (const screen of sources.screens) {
    const surface = screen.declaration.surface;
    if (surface && surface !== 'world' && !apps.some((app) => app.surface === surface)) apps.push({ surface, screen: screen.name, file: screen.file });
  }
  return apps.sort((a, b) => a.surface.localeCompare(b.surface));
}

export interface World {
  /** The name Lua creates a display of it by. */
  screen: string;
  file: string;
  /** The resolution of the browser that draws it. */
  width: number;
  height: number;
}

/** The world screens of a project: its screens with `<screen surface="world">`. */
export function findWorlds(sources: Sources): World[] {
  return sources.screens.flatMap(({ name, file, declaration }) =>
    declaration.surface === 'world' && declaration.size ? [{ screen: name, file, ...declaration.size }] : [],
  );
}

/**
 * What Lua does with world screens that cannot work: `Nexus.open` or `Nexus.close` with the name
 * of one, and `Nexus.world` with a name that is not one. Each is reported where Lua wrote it.
 */
function checkWorlds(project: Project, sources: Sources, lua: readonly { file: string; source: string; code: string }[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const worlds = findWorlds(sources).map((world) => world.screen);
  const names = sources.screens.map((screen) => screen.name);

  for (const { file, source, code } of lua) {
    for (const match of code.matchAll(/\bNexus\.(open|close|world)\(\s*(['"])([^'"\n]*)\2/g)) {
      const [written, method, , name] = match as unknown as [string, string, string, string];
      const isWorld = worlds.includes(name);
      let problem: { code: string; message: string; hint: string } | null = null;
      if (method !== 'world' && isWorld) {
        problem = {
          code: 'world-open',
          message: `Nexus.${method} cannot ${method} "${name}": it is a world screen, which is drawn on a prop and not on the page.`,
          hint: method === 'open' ? `Create a display of it: Nexus.world('${name}', { txd = '...', texture = '...' })` : 'Destroy its display: display:destroy()',
        };
      } else if (method === 'world' && !isWorld) {
        const close = suggest(name, worlds);
        problem = names.includes(name)
          ? {
              code: 'world-missing',
              message: `Nexus.world('${name}', ...) names a screen that is not a world screen.`,
              hint: `Add surface="world" and a size to the <screen> tag of that screen, for example <screen surface="world" size="1280x720" />.`,
            }
          : {
              code: 'world-missing',
              message: `Nexus.world('${name}', ...) names no screen.`,
              hint: close ? `Did you mean '${close}'?` : 'A world screen is a .nexus file in web/screens with <screen surface="world" size="1280x720" />.',
            };
      }
      if (problem) diagnostics.push(toDiagnostic(source, display(project, file), 'error', { ...problem, start: match.index, end: match.index + written.length }));
    }
  }
  return diagnostics;
}

/**
 * What is wrong between the apps and world screens of a project, its contract and its Lua. Each
 * of these builds without complaint and then does nothing in game, or raises an error there,
 * which is why they are worth a check.
 */
export function checkSurfaces(project: Project, sources: Sources, contract: Contract | null): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const apps = findApps(sources);

  // Lua is not parsed, only searched, which is enough to tell whether a call is there at all.
  // Comments are blanked, not removed, so that what is found keeps its place in the file.
  const files = listFiles(project.root, (path) => path.endsWith('.lua') && !/[\\/]nexus[\\/][a-z]+\.lua$/.test(path)).map((file) => {
    const source = readFileSync(file, 'utf8');
    return { file, source, code: source.replace(/--[^\n]*/g, (comment) => ' '.repeat(comment.length)) };
  });
  const lua = files.map((entry) => entry.code).join('\n');
  const registers = (surface: string): boolean => new RegExp(`Nexus\\.app\\(\\s*['"]${surface}['"]`).test(lua);

  for (const app of apps) {
    const component = sources.components.find((entry) => entry.file.replace(/\\/g, '/').endsWith(app.file));
    const tag = component?.root?.screen;
    const at = (code: string, severity: 'error' | 'warning', message: string, hint: string): void => {
      diagnostics.push(toDiagnostic(component?.source ?? '', app.file, severity, { code, message, hint, start: tag?.start ?? 0, end: tag?.end ?? 0 }));
    };
    const device = app.surface === 'phone' ? 'LB Phone' : 'LB Tablet';

    if (contract && Object.prototype.hasOwnProperty.call(contract.screens, app.screen)) {
      at(
        'surface-props',
        'error',
        `The ${app.surface} app has no props: ${device} opens it, and nothing is passed along. The contract declares props for "${app.screen}".`,
        `Remove "${app.screen}" from the screens of web/contract.ts. Give the app its data with a call or a state.`,
      );
    }
    if (!registers(app.surface)) {
      at(
        'surface-unregistered',
        'warning',
        `No Lua registers the ${app.surface} app, so ${device} will not show it.`,
        `Add to a client script: Nexus.app('${app.surface}', { name = '...' })`,
      );
    }
  }

  for (const surface of ['phone', 'tablet'] as const) {
    if (registers(surface) && !apps.some((app) => app.surface === surface)) {
      diagnostics.push(
        toDiagnostic('', 'web/screens', 'error', {
          code: 'surface-missing',
          message: `Lua calls Nexus.app('${surface}', ...), but no screen is the ${surface} app.`,
          hint: `Add <screen surface="${surface}" /> to the screen in web/screens that the app should show.`,
          start: 0,
        }),
      );
    }
  }

  diagnostics.push(...checkWorlds(project, sources, files));
  return diagnostics;
}
