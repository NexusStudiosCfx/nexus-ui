import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from '../compiler/index';

/** The module that starts the page. A project can also import it by this name. */
export const ENTRY = 'virtual:nexus/entry';
/** The same module as a URL, which is how the page's `<script>` asks for it. */
export const ENTRY_URL = '/@nexus/entry';
export const ENTRY_ID = '\0nexus:entry';

/**
 * The page a project gets when it has no `web/index.html` of its own. The empty icon keeps the
 * browser from asking for a favicon.ico that is not there.
 */
export const DEFAULT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Nexus UI</title>
    <link rel="icon" href="data:,">
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
    </style>
  </head>
  <body></body>
</html>
`;

export interface ScreenFile {
  /** The name Lua opens the screen by. */
  name: string;
  /** Absolute path of the file. */
  file: string;
}

/** `Shop.nexus` is the screen `shop`, `VehicleShop.nexus` is `vehicleShop`. */
export function screenName(file: string): string {
  const name = basename(file, '.nexus');
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** The screens of a project: every .nexus file directly in its `screens` folder. */
export function findScreens(folder: string): ScreenFile[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.nexus'))
    .map((entry) => ({ name: screenName(entry.name), file: join(folder, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a screen file writes as `surface` on its `<screen>` tag, or null. A file that does not
 * parse has none here: its error is reported when the file itself is compiled.
 */
export function surfaceOf(file: string): string | null {
  try {
    const attribute = parse(readFileSync(file, 'utf8')).screen?.attributes.find((candidate) => candidate.name === 'surface');
    const text = attribute && attribute.value !== true ? attribute.value[0] : undefined;
    return text && text.type === 'Text' ? text.data.trim() : null;
  } catch {
    return null;
  }
}

/** Which screen is the app of each surface. Two screens on one surface are returned as a conflict. */
export function findSurfaces(screens: ScreenFile[]): { surfaces: Record<string, string>; conflict: [surface: string, first: ScreenFile, second: ScreenFile] | null } {
  const owners = new Map<string, ScreenFile>();
  for (const screen of screens) {
    const surface = surfaceOf(screen.file);
    if (!surface) continue;
    const first = owners.get(surface);
    if (first) return { surfaces: {}, conflict: [surface, first, screen] };
    owners.set(surface, screen);
  }
  return { surfaces: Object.fromEntries([...owners].map(([surface, screen]) => [surface, screen.name])), conflict: null };
}

export interface EntryOptions {
  /** The address of a file as the page imports it. */
  url(file: string): string;
  dev: boolean;
  surfaces: Record<string, string>;
  /** The project's `contract.ts`, when it has one. */
  contract: string | null;
}

/**
 * The entry module: hands the runtime one lazy import per screen, so the code of a screen is
 * loaded when it is first opened, and says which screen is the app of each surface.
 *
 * While developing it also accepts hot updates of the screens, mounting the changed one again
 * with the props it had, and checks the props Lua opens a screen with against the `screens`
 * section of the contract. Neither the contract nor the check is part of a build.
 */
export function entryModule(screens: ScreenFile[], options: EntryOptions): string {
  const { url, dev, surfaces, contract } = options;
  const urls = screens.map((screen) => JSON.stringify(url(screen.file)));
  const loaders = screens.map((screen, index) => `  ${JSON.stringify(screen.name)}: () => import(${urls[index]}),\n`);
  const check = dev && contract !== null;
  const settings = [
    ...(Object.keys(surfaces).length ? [`  surfaces: ${JSON.stringify(surfaces)},\n`] : []),
    ...(check
      ? [
          '  check(screen, props) {\n' +
            '    const schema = contract.screens && contract.screens[screen];\n' +
            '    const result = schema ? validate(schema, props) : { ok: true };\n' +
            '    return result.ok ? null : result.error;\n' +
            '  },\n',
        ]
      : []),
  ];

  let code = `import { start${dev ? ', $reload' : ''} } from 'nexus';\n`;
  if (check) code += `import { validate } from 'nexus/contract';\nimport contract from ${JSON.stringify(url(contract))};\n`;
  code += `\nstart({\n${loaders.join('')}}${settings.length ? `, {\n${settings.join('')}}` : ''});\n`;
  if (dev && screens.length) {
    code +=
      `\nif (import.meta.hot) {\n` +
      `  const names = ${JSON.stringify(screens.map((screen) => screen.name))};\n` +
      `  import.meta.hot.accept([${urls.join(', ')}], (modules) => {\n` +
      `    modules.forEach((module, index) => module && $reload(names[index], module));\n` +
      `  });\n` +
      `}\n`;
  }
  return code;
}
