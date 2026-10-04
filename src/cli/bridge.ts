import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateLua, generateTypes, type Contract } from '../contract';
import { CliError } from './errors';
import { MINIMAL_MANIFEST, restorePage } from './manifest';
import { packageRoot, type Project } from './project';
import { generateScreensLua, type ScreenInfo } from './screens';

/** The Lua files of the bridge, relative to the resource, in the order the manifest loads them. */
export const BRIDGE_FILES = ['nexus/contract.lua', 'nexus/screens.lua', 'nexus/client.lua', 'nexus/server.lua'];

function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  writeFileSync(file, content);
}

/**
 * Writes the Lua half of the bridge into `nexus/`: the two runtimes as they ship with this
 * package, and the two files generated from the contract and the screens. Files that would not
 * change are left untouched, so a running server only sees real changes.
 */
export function writeBridge(project: Project, contract: Contract, screens: readonly ScreenInfo[]): void {
  const folder = join(project.root, 'nexus');
  mkdirSync(folder, { recursive: true });
  writeIfChanged(join(folder, 'contract.lua'), generateLua(contract));
  writeIfChanged(join(folder, 'screens.lua'), generateScreensLua(screens));
  for (const name of ['client.lua', 'server.lua']) {
    writeIfChanged(join(folder, name), readFileSync(join(packageRoot(), 'lua', name), 'utf8'));
  }
}

/**
 * Writes `web/nexus-contract.d.ts`, the declarations that type `nui` for this contract. The Vite
 * plugin keeps the same file up to date while it runs; this is for commands that do not start it.
 */
export function writeContractTypes(project: Project, contract: Contract): void {
  writeIfChanged(join(project.web, 'nexus-contract.d.ts'), generateTypes(contract));
}

export function manifestFile(project: Project): string {
  return join(project.root, 'fxmanifest.lua');
}

/** Reads the manifest, first undoing a dev `ui_page` that an interrupted `nexus dev --game` left behind. */
export function readManifest(project: Project): string {
  const file = manifestFile(project);
  if (!existsSync(file)) {
    throw new CliError('This resource has no fxmanifest.lua.', `Create it with at least:\n\n${indent(MINIMAL_MANIFEST)}`);
  }
  const text = readFileSync(file, 'utf8');
  const restored = restorePage(text);
  if (restored !== text) writeFileSync(file, restored);
  return restored;
}

export function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
