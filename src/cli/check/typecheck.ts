import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { CliError } from '../errors';
import { packageRoot, type Project } from '../project';
import type { Component } from '../sources';
import { HELPERS, nearestSource, toSource, toTypeScript, type VirtualFile } from './virtual';

export interface TypeProblem {
  /** Absolute path of the file the problem is in: a `.nexus` or a `.ts` file. */
  file: string;
  /** Offset in that file. */
  start: number;
  message: string;
  /** The TypeScript error code, for example `TS2339`. */
  code: string;
}

// Array methods that exist in Chromium 103 but are declared in a later `lib` than ES2022.
const CHROMIUM_103 = `interface Array<T> {
  findLast(predicate: (value: T, index: number, array: T[]) => unknown): T | undefined;
  findLastIndex(predicate: (value: T, index: number, array: T[]) => unknown): number;
}
interface ReadonlyArray<T> {
  findLast(predicate: (value: T, index: number, array: readonly T[]) => unknown): T | undefined;
  findLastIndex(predicate: (value: T, index: number, array: readonly T[]) => unknown): number;
}
`;

function findCompiler(project: Project): string {
  const require = createRequire(join(project.root, 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve('typescript/package.json');
  } catch {
    throw new CliError(
      'nexus check needs TypeScript to check the types, and it is not installed in this resource.',
      'Install it with: npm install --save-dev typescript',
    );
  }
  const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: { tsc?: string } }).bin?.tsc;
  if (!bin) throw new CliError(`The TypeScript package at ${dirname(manifest)} has no tsc.`, 'Reinstall it with: npm install --save-dev typescript');
  return join(dirname(manifest), bin);
}

function forward(path: string): string {
  return path.replace(/\\/g, '/');
}

/** A key that finds a file again from the path tsc prints, whatever case Windows reports it in. */
function fileKey(path: string): string {
  const key = forward(resolve(path));
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function offsetAt(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) break;
    offset = next + 1;
  }
  return offset + column - 1;
}

/**
 * TypeScript knows which built-ins exist from `lib`, which is pinned to what Chromium 103 has.
 * Its advice for a missing one is to raise `lib`, which would only hide the problem.
 */
function explain(message: string): string {
  return message.replace(
    / Do you need to change your target library\? Try changing the 'lib' compiler option to '[^']+' or later\./,
    ' It does not exist in Chromium 103, the browser FiveM runs.',
  );
}

/**
 * Type-checks the project: every `.ts` file under `web/`, and every component through a
 * TypeScript stand-in written next to a copy of the tree. Problems in a stand-in are mapped back
 * to the line of the `.nexus` file they came from.
 *
 * It runs `tsc` as a process rather than through an API, so it works with whichever TypeScript
 * version the resource has installed.
 */
export interface TypeCheck {
  problems: TypeProblem[];
  /** The modules of the project that TypeScript looked at: what its `tsconfig.json` includes. */
  files: string[];
}

/**
 * `screens` maps the file of a screen to its name, for the screens whose props the contract
 * declares: those are typed from the contract.
 */
export function typeCheck(project: Project, components: readonly Component[], screens: ReadonlyMap<string, string> = new Map()): TypeCheck {
  const tsc = findCompiler(project);
  const work = join(project.root, 'node_modules', '.nexus', 'check');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'web'), { recursive: true });

  const virtual = new Map<string, { component: Component; file: VirtualFile }>();
  const standIns: string[] = [];
  for (const component of components) {
    const target = join(work, relative(project.root, component.file)) + '.ts';
    mkdirSync(dirname(target), { recursive: true });
    standIns.push(forward(target));
    if (!component.root) {
      // The compiler has already reported this file. An empty stand-in keeps the files that
      // import it from each adding a "module not found" on top.
      writeFileSync(target, 'declare const component: any;\nexport default component;\n');
      continue;
    }
    const file = toTypeScript(component.root, component.source, { screen: screens.get(component.file) });
    writeFileSync(target, file.code);
    virtual.set(fileKey(target), { component, file });
  }

  const ambient = join(work, 'web', 'nexus-ambient.d.ts');
  const chromium = join(work, 'web', 'nexus-chromium103.d.ts');
  writeFileSync(ambient, HELPERS);
  writeFileSync(chromium, CHROMIUM_103);
  // What Vite adds to every module it builds: import.meta.env, import.meta.glob, and imports
  // of images, sounds and stylesheets.
  const viteClient = join(dirname(createRequire(join(packageRoot(), 'package.json')).resolve('vite/package.json')), 'client.d.ts');

  const own = join(project.root, 'tsconfig.json');
  const runtime = join(packageRoot(), 'dist');
  const options: Record<string, unknown> = {
    noEmit: true,
    skipLibCheck: true,
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    // The stand-ins and the real files are one tree to the checker, so a component can import
    // a module next to it and the other way round.
    rootDirs: [forward(project.web), forward(join(work, 'web'))],
    // Glue code in the stand-ins would trip these, and they are style rules, not type errors.
    noUnusedLocals: false,
    noUnusedParameters: false,
  };
  if (!existsSync(own)) {
    Object.assign(options, {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      resolveJsonModule: true,
      paths: {
        nexus: [forward(join(runtime, 'runtime/index.d.ts'))],
        'nexus/contract': [forward(join(runtime, 'contract/index.d.ts'))],
      },
    });
  }
  const files = [...standIns, forward(ambient), forward(chromium), forward(viteClient)];
  const types = join(project.web, 'nexus-contract.d.ts');
  if (existsSync(types)) files.push(forward(types));
  // With a tsconfig.json, which modules are checked is its decision: `include` and `exclude`
  // are inherited, so a folder of Node scripts it excludes stays out. Only the stand-ins and
  // the declarations above are added.
  const config = existsSync(own)
    ? { extends: forward(own), compilerOptions: options, files }
    : { compilerOptions: options, files, include: [`${forward(project.web)}/**/*.ts`], exclude: [`${forward(project.web)}/dist`] };
  const configFile = join(work, 'tsconfig.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));

  const run = spawnSync(process.execPath, [tsc, '--project', configFile, '--pretty', 'false', '--listFiles'], {
    cwd: project.root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw new CliError(`TypeScript could not be started: ${run.error.message}`);

  const problems: TypeProblem[] = [];
  const checked: string[] = [];
  const web = fileKey(project.web) + '/';
  const texts = new Map<string, string>();
  const LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  let last: TypeProblem | null = null;

  for (const line of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) {
      // --listFiles prints one path per line. The ones under web/ are the project's own modules.
      if (/\.[cm]?[jt]sx?$/.test(line) && !line.endsWith('.d.ts') && fileKey(line).startsWith(web)) checked.push(resolve(line));
      // Further lines of the same message are indented.
      else if (last && /^\s+\S/.test(line)) last.message += `\n${line}`;
      else if (/^error (TS\d+): /.test(line)) {
        throw new CliError(`TypeScript could not check the project: ${line.replace(/^error /, '')}`);
      }
      continue;
    }
    const [, path = '', lineNumber = '1', column = '1', code = '', message = ''] = match;
    const absolute = resolve(project.root, path);
    const entry = virtual.get(fileKey(absolute));
    if (entry) {
      const generated = offsetAt(entry.file.code, Number(lineNumber), Number(column));
      const start = toSource(entry.file, generated) ?? nearestSource(entry.file, generated);
      last = { file: entry.component.file, start, message: explain(message), code };
    } else {
      let text = texts.get(absolute);
      if (text === undefined) {
        text = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
        texts.set(absolute, text);
      }
      last = { file: absolute, start: offsetAt(text, Number(lineNumber), Number(column)), message: explain(message), code };
    }
    problems.push(last);
  }

  if (run.status !== 0 && problems.length === 0) {
    throw new CliError(`TypeScript stopped without reporting a problem (exit code ${String(run.status)}).`, (run.stdout + run.stderr).trim() || undefined);
  }
  return { problems, files: checked };
}
