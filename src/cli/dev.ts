import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { parseArgs } from './args';
import { manifestFile, readManifest, writeBridge } from './bridge';
import { CliError } from './errors';
import { color, log } from './log';
import { restorePage, useDevPage } from './manifest';
import { onParentExit } from './parent';
import { contractFile, findProject, loadContract, packageRoot, type Project } from './project';
import { readSources } from './sources';

const HOST_ID = 'virtual:nexus-dev-host';

function fsUrl(path: string): string {
  return `/@fs/${path.replace(/\\/g, '/').replace(/^\//, '')}`;
}

/**
 * Adds the mock host to the dev server: a module that runs before the page's own entry and
 * installs `window.__NEXUS_HOST__` with the project's contract and mock.
 */
function hostPlugin(project: Project): Plugin {
  const resolved = `\0${HOST_ID}`;
  return {
    name: 'nexus:dev-host',
    apply: 'serve',
    resolveId(id) {
      return id === HOST_ID ? resolved : undefined;
    },
    load(id) {
      if (id !== resolved) return undefined;
      const mock = join(project.web, 'mock.ts');
      const screens = readSources(project).screens.map((screen) => ({
        name: screen.name,
        layer: screen.declaration.layer,
        surface: screen.declaration.surface ?? null,
      }));
      return [
        `import { installHost } from ${JSON.stringify(fsUrl(join(packageRoot(), 'dist/cli/host.js')))};`,
        `import contract from ${JSON.stringify(fsUrl(contractFile(project)))};`,
        existsSync(mock) ? `import mock from ${JSON.stringify(fsUrl(mock))};` : 'const mock = null;',
        `installHost({ resource: ${JSON.stringify(project.name)}, contract, mock, screens: ${JSON.stringify(screens)} });`,
      ].join('\n');
    },
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: `/@id/__x00__${HOST_ID}` }, injectTo: 'head-prepend' }];
    },
    configureServer(server) {
      // The list of screens is written into the host module, so it has to be rebuilt when a
      // screen file appears or disappears. The nexus plugin reloads the page for the same event.
      const refresh = (file: string): void => {
        if (!file.endsWith('.nexus')) return;
        const graph = server.environments.client.moduleGraph;
        const module = graph.getModuleById(resolved);
        if (module) graph.invalidateModule(module);
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
  };
}

function isSource(project: Project, changed: string): boolean {
  return resolve(changed) === contractFile(project) || changed.endsWith('.nexus');
}

/**
 * Prints what is wrong with the contract without stopping the server. In the browser a broken
 * contract only shows as a failed import in the console, which is easy to miss. Components need
 * no such help: the plugin reports them in the page and in this terminal.
 */
async function reportContract(project: Project): Promise<void> {
  try {
    await loadContract(project);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    log.error(error.message, error.hint);
  }
}

/**
 * Game mode: the resource's `ui_page` points at the dev server, so the page inside FiveM is the
 * one being edited, hot reload included. The Lua bridge is kept in step with the contract and
 * the screens while the server runs, and the manifest is put back when it stops.
 */
async function serveGame(project: Project, server: ViteDevServer, url: string): Promise<() => void> {
  const file = manifestFile(project);
  const original = readManifest(project);
  const patched = useDevPage(original, url);
  if (patched === null) {
    throw new CliError(
      'fxmanifest.lua has no ui_page to point at the dev server.',
      "Run 'nexus build' once: it prints the lines the manifest needs.",
    );
  }

  // A contract or a screen that is broken right now keeps the last bridge that worked: the
  // error is on screen already, and Lua should not be handed half a change.
  const sync = async (): Promise<void> => {
    try {
      const contract = await loadContract(project);
      const sources = readSources(project);
      if (sources.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return;
      writeBridge(project, contract, sources.screens);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
    }
  };
  await sync();
  writeFileSync(file, patched);

  let timer: NodeJS.Timeout | undefined;
  server.watcher.on('all', (_event, changed) => {
    if (!isSource(project, changed)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const before = readBridge(project);
      void sync().then(() => {
        if (readBridge(project) !== before) {
          log.info(`The Lua bridge changed. Load it with: ${color.bold(`ensure ${project.name}`)}`);
        }
      });
    }, 200);
  });

  log.step(`fxmanifest.lua loads the page from ${url} until you stop this command`);
  log.info(`   In the server console: ${color.bold('refresh')}, then ${color.bold(`ensure ${project.name}`)}`);

  return () => {
    clearTimeout(timer);
    if (existsSync(file)) writeFileSync(file, restorePage(readFileSync(file, 'utf8')));
  };
}

function readBridge(project: Project): string {
  return ['contract.lua', 'screens.lua']
    .map((name) => join(project.root, 'nexus', name))
    .map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''))
    .join('\n');
}

/** `nexus dev`: the Vite dev server with the mock host, or with `--game` the page served to FiveM. */
export async function dev(argv: readonly string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(argv, 'dev', { game: {}, port: { value: true } });
  const project = findProject(cwd);
  const game = flags.game === true;

  let port = 5173;
  if (typeof flags.port === 'string') {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CliError(`--port must be a number from 1 to 65535, got "${flags.port}".`);
    }
  }

  // An interrupted game session may have left the dev ui_page behind.
  if (existsSync(manifestFile(project))) readManifest(project);
  await reportContract(project);

  const vite = await import('vite');
  const server = await vite.createServer({
    root: project.root,
    plugins: [hostPlugin(project)],
    server: {
      port,
      // FiveM is told one address, so in game mode the port must not move.
      strictPort: game,
      fs: { allow: [project.root, packageRoot()] },
    },
  });

  try {
    await server.listen();
  } catch (error) {
    await server.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' || /is already in use/.test(String(error))) {
      throw new CliError(`Port ${port} is already in use.`, `Stop the other dev server, or pick another port: nexus dev${game ? ' --game' : ''} --port ${port + 1}`);
    }
    throw error;
  }

  const url = server.resolvedUrls?.local[0] ?? `http://localhost:${port}/`;
  log.step(`${project.name} is running at ${color.cyan(url)}`);

  let restore = (): void => {};
  if (game) {
    try {
      restore = await serveGame(project, server, url);
    } catch (error) {
      await server.close();
      throw error;
    }
  } else {
    log.info(`   Open it in a browser. The bar at the bottom opens the screens with the props from web/mock.ts.`);
  }
  log.info(`   ${color.dim('Press Ctrl+C to stop.')}`);

  server.watcher.on('change', (changed) => {
    if (resolve(changed) === contractFile(project)) void reportContract(project);
  });

  // Nothing here is worth waiting for: the manifest is put back, and the system closes the
  // sockets of a process that ends. Waiting for open browser connections to close could hang.
  const stop = (): void => {
    restore();
    process.exit(0);
  };
  // SIGHUP is what a closed console window sends on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.once(signal, stop);
  onParentExit(stop);
}
