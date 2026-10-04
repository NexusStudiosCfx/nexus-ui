import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where the end-to-end tests work. It is inside the repository on purpose: a project created
 * here finds vite, typescript and the other dependencies in the repository's node_modules, so
 * nothing has to be installed.
 */
const WORK = join(REPO, 'tests', '.tmp', 'platform');

/** A stand-in for the installed package: its own build, plus the files that ship beside `dist`. */
const PACKAGE = join(WORK, 'pkg');

export const CLI = join(PACKAGE, 'dist', 'cli', 'index.js');

function run(command: string, args: string[]): void {
  const result = spawnSync(process.execPath, [join(REPO, 'node_modules', command), ...args], { cwd: REPO, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

/**
 * Builds the package into the work folder, the same two steps as `npm run build`. The real
 * `dist` is left alone, so these tests neither depend on a previous build nor disturb one.
 */
export function buildPackage(): void {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(PACKAGE, { recursive: true });
  const dist = join(PACKAGE, 'dist');
  run('tsup/dist/cli-default.js', ['--out-dir', dist, '--silent']);
  run('typescript/bin/tsc', ['-p', 'tsconfig.build.json', '--outDir', dist]);
  for (const name of ['package.json', 'lua', 'templates']) {
    cpSync(join(REPO, name), join(PACKAGE, name), { recursive: true });
  }
}

export interface CliResult {
  status: number | null;
  /** stdout and stderr together, without colour codes. */
  output: string;
}

/** Runs the built `nexus` in a folder under the work folder. */
export function nexus(folder: string, ...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: join(WORK, folder),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Starts the built `nexus` and leaves it running. The caller stops it. */
export function startNexus(folder: string, ...args: string[]): ChildProcess {
  return spawn(process.execPath, [CLI, ...args], { cwd: join(WORK, folder), env: { ...process.env, NO_COLOR: '1' } });
}

export function workPath(...parts: string[]): string {
  return join(WORK, ...parts);
}

export function read(...parts: string[]): string {
  return readFileSync(workPath(...parts), 'utf8');
}

/** Makes `nexus-ui` resolve to the package under test from inside a project, as an install would. */
export function install(project: string): void {
  const modules = workPath(project, 'node_modules');
  mkdirSync(modules, { recursive: true });
  if (!existsSync(join(modules, 'nexus-ui'))) symlinkSync(PACKAGE, join(modules, 'nexus-ui'), 'junction');
}

/** Copies a folder of the repository (an example, a fixture) into the work folder and installs the package in it. */
export function copyProject(from: string, name: string): void {
  cpSync(join(REPO, from), workPath(name), {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|dist)$/.test(source),
  });
  install(name);
}
