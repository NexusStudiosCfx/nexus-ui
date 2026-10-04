import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isCSSRequest, normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { checkCss, checkScript, type CompatIssue } from '../compiler/compat';
import { codeFrame, locate, type Diagnostic } from '../compiler/diagnostics';
import { compile, CompileError } from '../compiler/index';
import { packagePaths, writeContractTypes } from './contract';
import { stripDevCalls } from '../compiler/dev-calls';
import { DEFAULT_PAGE, ENTRY, ENTRY_ID, ENTRY_URL, entryModule, findScreens, findSurfaces } from './page';

export { findScreens, screenName, type ScreenFile } from './page';

export interface NexusOptions {
  /** The folder that holds `screens/`, relative to where Vite runs. Default: `web`. */
  web?: string;
}

const STYLE_QUERY = '?nexus&type=style&lang.css';
const SCRIPT = /\.[cm]?[jt]sx?$/;

interface Compiled {
  js: string;
  css: string;
  cssMap: unknown;
}

/**
 * The Vite plugin of Nexus UI. It compiles `.nexus` files, provides the page and its entry
 * module, maps `nexus` to this package, builds for Chromium 103 and refuses CSS and JavaScript
 * that Chromium 103 cannot run.
 *
 * @example
 * // vite.config.ts, next to fxmanifest.lua
 * import nexus from '@nexusstudios/ui/vite';
 *
 * export default { plugins: [nexus()] };
 */
export default function nexus(options: NexusOptions = {}): Plugin {
  const paths = packagePaths();
  const compiled = new Map<string, Compiled>();
  let config: ResolvedConfig;
  let screens: string;
  // The surfaces the entry module was generated with, to notice when a screen changes its own.
  let entrySurfaces = '';

  /** A path relative to the resource, which is how files are named in messages and source maps. */
  const display = (file: string): string => normalizePath(relative(resolve(config.root, '..'), file));

  const run = (file: string, source: string): { result: ReturnType<typeof compile>; entry: Compiled } => {
    const result = compile(source, { filename: display(file), dev: config.command === 'serve', css: 'external' });
    const entry: Compiled = { js: result.js.code, css: result.css ? result.css.code : '', cssMap: result.css ? result.css.map : null };
    compiled.set(file, entry);
    return { result, entry };
  };

  const describe = (diagnostic: Diagnostic, id: string): { message: string; id: string; loc: { file: string; line: number; column: number }; frame: string } => ({
    message: `${diagnostic.message}${diagnostic.hint ? `\n${diagnostic.hint}` : ''} (${diagnostic.code})`,
    id,
    loc: { file: id, line: diagnostic.line, column: diagnostic.column - 1 },
    frame: diagnostic.frame,
  });

  const describeIssue = (issue: CompatIssue, code: string, id: string): ReturnType<typeof describe> => {
    const { line, column } = locate(code, issue.start);
    return { message: `${issue.message}\n${issue.hint}`, id, loc: { file: id, line, column: column - 1 }, frame: codeFrame(code, issue.start, issue.end) };
  };

  const generateTypes = async (): Promise<void> => {
    const problem = await writeContractTypes(config.root, paths);
    if (problem) config.logger.warn(`[nexus] ${problem}`);
  };

  return {
    name: 'nexus',
    enforce: 'pre',

    config(user, { command }) {
      const base = resolve(user.root ?? process.cwd());
      const web = join(base, options.web ?? 'web');
      return {
        // Vite is started next to fxmanifest.lua; the page itself lives in the web folder.
        root: existsSync(web) ? web : base,
        // The page is served from https://cfx-nui-<resource>/web/dist/, so URLs must be relative.
        base: './',
        define: { 'globalThis.__NEXUS_DEV__': JSON.stringify(command === 'serve') },
        build: {
          target: 'chrome103',
          cssTarget: 'chrome103',
          outDir: user.build?.outDir ?? 'dist',
          emptyOutDir: true,
          modulePreload: { polyfill: false },
        },
        // A pre-bundled copy would be a second runtime next to the one `nexus` resolves to.
        optimizeDeps: { exclude: ['@nexusstudios/ui'] },
      };
    },

    configResolved(resolved) {
      config = resolved;
      screens = join(config.root, 'screens');
    },

    async buildStart() {
      if (config.command === 'build') await generateTypes();
    },

    configureServer(server: ViteDevServer) {
      void generateTypes();
      const contract = normalizePath(join(config.root, 'contract.ts'));
      server.watcher.on('all', (event, file) => {
        const changed = normalizePath(file);
        if (changed === contract) void generateTypes();
        // A screen that appears or disappears changes the entry module.
        if ((event === 'add' || event === 'unlink') && changed.startsWith(`${normalizePath(screens)}/`) && changed.endsWith('.nexus')) {
          const environment = server.environments.client;
          const entry = environment.moduleGraph.getModuleById(ENTRY_ID);
          if (entry) environment.moduleGraph.invalidateModule(entry);
          environment.hot.send({ type: 'full-reload' });
        }
      });

      // Without an index.html in the project, the page is the default one.
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0];
        if ((url !== '/' && url !== '/index.html') || existsSync(join(config.root, 'index.html'))) return next();
        server.transformIndexHtml(request.url as string, DEFAULT_PAGE).then((html) => {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        }, next);
      });
    },

    async resolveId(id, importer) {
      if (id === ENTRY || id === ENTRY_URL) return ENTRY_ID;

      if (id === 'nexus' || id === 'nexus/contract' || (paths.fromSource && (id === '@nexusstudios/ui' || id === '@nexusstudios/ui/contract'))) {
        const contract = id.endsWith('/contract');
        if (!paths.fromSource) {
          // The same resolution as a direct import of the package, so there is one copy of it.
          const found = await this.resolve(contract ? '@nexusstudios/ui/contract' : '@nexusstudios/ui', importer, { skipSelf: true });
          if (found) return found;
        }
        return contract ? paths.contract : paths.runtime;
      }

      // The build asks for index.html as its entry even when the project has none.
      if (config.command === 'build' && normalizePath(id) === normalizePath(join(config.root, 'index.html')) && !existsSync(id)) return id;
      return null;
    },

    load(id) {
      if (id === ENTRY_ID) {
        const found = findScreens(screens);
        const { surfaces, conflict } = findSurfaces(found);
        if (conflict) {
          const [surface, first, second] = conflict;
          this.error(
            `Two screens are the ${surface} app: ${display(first.file)} and ${display(second.file)}. A resource has one screen per surface.\n` +
              `Remove surface="${surface}" from one of them. To show both in the app, make one a component of the other.`,
          );
        }
        entrySurfaces = JSON.stringify(surfaces);
        const contract = join(config.root, 'contract.ts');
        return entryModule(found, {
          url: (file) => `/${normalizePath(relative(config.root, file))}`,
          dev: config.command === 'serve',
          surfaces,
          contract: existsSync(contract) ? contract : null,
        });
      }
      if (id.endsWith(STYLE_QUERY)) {
        const file = id.slice(0, -STYLE_QUERY.length);
        const entry = compiled.get(file);
        return entry ? { code: entry.css, map: entry.cssMap as never } : null;
      }
      if (config.command === 'build' && normalizePath(id) === normalizePath(join(config.root, 'index.html')) && !existsSync(id)) return DEFAULT_PAGE;
      return null;
    },

    transform(code, id) {
      if (id.endsWith(STYLE_QUERY) || id.startsWith('\0')) return null;
      const file = id.split('?')[0] as string;
      const foreign = file.includes('/node_modules/');

      if (file.endsWith('.nexus')) {
        let output: ReturnType<typeof run>;
        try {
          output = run(file, code);
        } catch (error) {
          if (error instanceof CompileError) this.error(describe(error.diagnostic, id));
          throw error;
        }
        for (const diagnostic of output.result.warnings) {
          if (diagnostic.severity === 'error') this.error(describe(diagnostic, id));
          this.warn(describe(diagnostic, id));
        }
        const style = output.entry.css ? `\nimport ${JSON.stringify(file + STYLE_QUERY)};\n` : '';
        return { code: output.result.js.code + style, map: output.result.js.map as never };
      }

      // What Chromium 103 cannot run is an error in the project and a warning in a dependency,
      // which may only use the feature after checking for it.
      const issues = isCSSRequest(file) && file.endsWith('.css') ? checkCss(code) : SCRIPT.test(file) ? checkScript(code) : [];
      for (const issue of issues) {
        if (foreign) this.warn(describeIssue(issue, code, id));
        else this.error(describeIssue(issue, code, id));
      }

      // A build carries no dev toolbar, so the calls that fill it go, with what they hold.
      if (config.command === 'build' && !foreign && SCRIPT.test(file)) {
        const stripped = stripDevCalls(code, file);
        if (stripped) return { code: stripped.code, map: stripped.map as never };
      }
      return null;
    },

    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', attrs: { type: 'module', src: ENTRY_URL }, injectTo: 'body' }],
    },

    async hotUpdate({ file, modules, read }) {
      if (!file.endsWith('.nexus')) return;
      // Which screen is the app of a surface is written into the entry module, which a hot
      // update does not run again: the page has to load anew.
      if (entrySurfaces && JSON.stringify(findSurfaces(findScreens(screens)).surfaces) !== entrySurfaces) {
        const entry = this.environment.moduleGraph.getModuleById(ENTRY_ID);
        if (entry) this.environment.moduleGraph.invalidateModule(entry);
        this.environment.hot.send({ type: 'full-reload' });
        return [];
      }
      if (!compiled.has(file)) return;
      const previous = compiled.get(file) as Compiled;
      try {
        const { entry } = run(file, await read());
        // Only the styles changed: update the stylesheet and leave the mounted screen alone.
        if (entry.js === previous.js) return modules.filter((module) => module.id?.endsWith(STYLE_QUERY));
      } catch {
        // The transform of the changed module reports the error with its position.
      }
      return;
    },
  };
}
