import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from './args';
import { CliError } from './errors';
import { color, log } from './log';
import { packageRoot } from './project';

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function copy(from: string, to: string, values: Record<string, string>): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    // npm leaves .gitignore files out of a published package, so the template ships it under
    // another name.
    const target = join(to, entry.name === 'gitignore' ? '.gitignore' : entry.name);
    if (entry.isDirectory()) {
      copy(source, target, values);
    } else {
      const text = readFileSync(source, 'utf8').replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
      writeFileSync(target, text);
    }
  }
}

/** `nexus create <name>`: copies the resource template into a new folder. */
export function create(argv: readonly string[], cwd: string): void {
  const { positional } = parseArgs(argv, 'create', {});
  const name = positional[0];
  if (!name) {
    throw new CliError('nexus create needs a name for the resource.', 'For example: nexus create my_shop');
  }
  if (positional.length > 1) {
    throw new CliError(`nexus create takes one name, got ${positional.length}.`, 'A resource name has no spaces: nexus create my_shop');
  }
  if (!NAME.test(name)) {
    throw new CliError(
      `"${name}" cannot be used as a resource name.`,
      'Use letters, digits, _ and -, starting with a letter. For example: nexus create my_shop',
    );
  }

  const target = resolve(cwd, name);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new CliError(`The folder ${target} already exists and is not empty.`, 'Pick another name, or remove the folder first.');
  }

  const root = packageRoot();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
    homepage: string;
    dependencies?: Record<string, string>;
  };
  copy(join(root, 'templates', 'resource'), target, {
    name,
    // The package is released on GitHub, not on the npm registry, so the resource depends on
    // the file attached to the release of this version. npm installs it like any other package.
    package: `${manifest.homepage}/releases/download/v${manifest.version}/nexus-ui-${manifest.version}.tgz`,
    vite: manifest.dependencies?.vite ?? 'latest',
  });

  log.step(`Created ${name}`);
  log.info(`
  cd ${name}
  npm install
  npm run dev        ${color.dim('work on the UI in a browser, with hot reload')}
  npm run build      ${color.dim('build the page and the Lua bridge')}

After a build, put the folder in your server's resources and add ${color.bold(`ensure ${name}`)} to server.cfg.
In game, ${color.bold(`/${name}`)} opens the screen.
`);
}
