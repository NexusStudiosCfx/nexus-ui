import { readFileSync } from 'node:fs';
import type { Diagnostic } from '../compiler';
import { toDiagnostic } from '../compiler/diagnostics';
import type { Contract } from '../contract';
import { listFiles, type Project } from './project';
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
    if (surface && !apps.some((app) => app.surface === surface)) apps.push({ surface, screen: screen.name, file: screen.file });
  }
  return apps.sort((a, b) => a.surface.localeCompare(b.surface));
}

/**
 * What is wrong between the apps of a project, its contract and its Lua. Each of these builds
 * without complaint and then does nothing in game, which is why they are worth a check.
 */
export function checkSurfaces(project: Project, sources: Sources, contract: Contract | null): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const apps = findApps(sources);

  // Lua is not parsed, only searched, which is enough to tell whether the call is there at all.
  const lua = listFiles(project.root, (path) => path.endsWith('.lua') && !/[\\/]nexus[\\/][a-z]+\.lua$/.test(path))
    .map((file) => readFileSync(file, 'utf8').replace(/--[^\n]*/g, ''))
    .join('\n');
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

  return diagnostics;
}
