import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ContractError, isContract, type Contract } from '../contract';
import { CliError } from './errors';

export interface Project {
  /** The resource folder, where `fxmanifest.lua` lives. */
  root: string;
  /** `<root>/web`. */
  web: string;
  /** The resource name, which FiveM takes from the folder. */
  name: string;
}

/** The folder of the installed package, which holds `lua/` and `templates/`. */
export function packageRoot(): string {
  let folder = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(folder, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@nexusstudios/ui') {
      return folder;
    }
    const parent = dirname(folder);
    if (parent === folder) throw new Error('The folder of @nexusstudios/ui could not be found from ' + import.meta.url);
    folder = parent;
  }
}

export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version;
}

/** Finds the resource the command was run in. Running it from inside `web/` works too. */
export function findProject(cwd: string): Project {
  let root = resolve(cwd);
  if (!existsSync(join(root, 'web')) && basename(root) === 'web') root = dirname(root);
  const web = join(root, 'web');
  if (!existsSync(web) || !statSync(web).isDirectory()) {
    throw new CliError(
      `There is no web folder in ${root}.`,
      'Run this command in the folder of a resource, next to fxmanifest.lua.\nTo start a new resource: nexus create <name>',
    );
  }
  return { root, web, name: basename(root) };
}

/** Every file under `folder` that `keep` accepts, as absolute paths, in a stable order. */
export function listFiles(folder: string, keep: (path: string) => boolean): string[] {
  if (!existsSync(folder)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...listFiles(path, keep));
    } else if (keep(path)) found.push(path);
  }
  return found;
}

/** A path as it is written in messages and in the manifest: relative to the resource, with `/`. */
export function display(project: Project, path: string): string {
  return relative(project.root, path).replace(/\\/g, '/');
}

export function contractFile(project: Project): string {
  return join(project.web, 'contract.ts');
}

/**
 * Loads `web/contract.ts` and returns its default export. The file is TypeScript and imports
 * `nexus/contract`, so it is run through Vite's module runner with that name mapped to this
 * package's own build.
 */
export async function loadContract(project: Project): Promise<Contract> {
  const file = contractFile(project);
  if (!existsSync(file)) {
    throw new CliError(
      'web/contract.ts does not exist.',
      "Create it with at least:\n\n    import { contract } from 'nexus/contract';\n\n    export default contract({});",
    );
  }

  const { runnerImport } = await import('vite');
  const entry = join(packageRoot(), 'dist/contract/index.js');
  let loaded: { default?: unknown };
  try {
    const result = await runnerImport<{ default?: unknown }>(pathToFileURL(file).href, {
      root: project.root,
      logLevel: 'silent',
      resolve: { alias: { 'nexus/contract': entry, '@nexusstudios/ui/contract': entry } },
    });
    loaded = result.module;
  } catch (error) {
    if (error instanceof ContractError || (error instanceof Error && error.name === 'ContractError')) {
      throw new CliError(`web/contract.ts: ${error.message}`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`web/contract.ts could not be loaded: ${reason}`);
  }

  if (!isContract(loaded.default)) {
    throw new CliError(
      'web/contract.ts has no contract as its default export.',
      'End the file with: export default contract({ ... });',
    );
  }
  return loaded.default;
}
