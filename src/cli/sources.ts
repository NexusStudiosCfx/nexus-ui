import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compile, CompileError, parse, type Diagnostic, type Root, type ScreenDeclaration } from '../compiler';
import { checkCss, checkScript } from '../compiler/compat';
import { toDiagnostic } from '../compiler/diagnostics';
import { findScreens } from '../vite/page';
import { display, listFiles, type Project } from './project';
import type { ScreenInfo } from './screens';

export interface Component {
  /** Absolute path of the `.nexus` file. */
  file: string;
  source: string;
  /** Null when the file could not be parsed. Its error is among the diagnostics then. */
  root: Root | null;
}

export interface Sources {
  components: Component[];
  screens: ScreenInfo[];
  /** What the compiler reports for the components, and an app that two screens claim. */
  diagnostics: Diagnostic[];
}

/** What a file in `web/screens` declares when it has no `<screen>` tag. */
const DEFAULT_SCREEN: ScreenDeclaration = {
  focus: { mouse: true, keyboard: true },
  keepInput: false,
  close: 'escape',
  size: null,
  layer: 'screen',
  cursor: null,
};

/** Reads and compiles every source file of the project. */
export function readSources(project: Project): Sources {
  const components: Component[] = [];
  const screens: ScreenInfo[] = [];
  const diagnostics: Diagnostic[] = [];
  const screenNames = new Map(findScreens(join(project.web, 'screens')).map((screen) => [resolve(screen.file), screen.name]));

  for (const file of listFiles(project.web, (path) => path.endsWith('.nexus'))) {
    const source = readFileSync(file, 'utf8');
    const filename = display(project, file);
    let root: Root | null = null;
    try {
      const result = compile(source, { filename, css: 'external' });
      diagnostics.push(...result.warnings);
      root = parse(source, { filename });
      const name = screenNames.get(resolve(file));
      if (name !== undefined) {
        const declaration = result.screen ?? DEFAULT_SCREEN;
        // An app has one screen. World screens are not counted: a resource has as many as it likes.
        const app = declaration.surface === 'world' ? null : declaration.surface;
        const taken = app ? screens.find((screen) => screen.declaration.surface === app) : undefined;
        if (taken && app) {
          diagnostics.push(
            toDiagnostic(source, filename, 'error', {
              code: 'surface-taken',
              message: `A resource has one ${app} app, and ${taken.file} already is it.`,
              hint: 'Keep one screen with this surface and make the other a component that it shows.',
              start: root.screen?.start ?? 0,
              end: root.screen?.end ?? 0,
            }),
          );
        }
        screens.push({ name, file: filename, declaration });
      }
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      diagnostics.push(error.diagnostic);
    }
    components.push({ file, source, root });
  }

  return { components, screens, diagnostics };
}

/**
 * What Chromium 103 cannot run in the plain modules and stylesheets of a project. The compiler
 * checks components itself. These files never pass through it, so the same rules are applied
 * here, with the same codes.
 *
 * `modules` are the script files to look at. Without it every one under `web/` is.
 */
export function plainFileDiagnostics(project: Project, modules?: readonly string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const scripts = modules ?? listFiles(project.web, (path) => /\.(?:ts|js)$/.test(path) && !path.endsWith('.d.ts'));
  const styles = listFiles(project.web, (path) => path.endsWith('.css'));
  for (const file of [...scripts, ...styles]) {
    const source = readFileSync(file, 'utf8');
    const css = file.endsWith('.css');
    for (const issue of css ? checkCss(source) : checkScript(source)) {
      diagnostics.push(toDiagnostic(source, display(project, file), 'error', { code: css ? 'unsupported-css' : 'unsupported-api', ...issue }));
    }
  }
  return diagnostics;
}
