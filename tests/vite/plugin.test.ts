import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build, createServer, type Rolldown, type ViteDevServer } from 'vite';
import type { Page } from 'playwright-core';
import nexus, { findScreens, screenName } from '../../src/vite/index';
import { CHROMIUM_103, installHost, launch, shutdown } from '../runtime/harness';

const projects: string[] = [];

/** Writes a resource folder with the given files and returns its path. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-ui-project-'));
  projects.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterAll(() => {
  for (const root of projects) rmSync(root, { recursive: true, force: true });
});

const MAIN = `---
import { signal } from 'nexus';
import Label from '../components/Label.nexus';

const clicks = signal(0);
---

<screen focus="mouse" />

<main id="main">
  <Label text={props.title} />
  <button id="click" on:click={() => clicks.value++}>{clicks}</button>
  <p id="marker">first</p>
</main>

<style>
  #marker { color: rgb(1, 1, 1); }
</style>
`;

const LABEL = '<h1 id="label">{props.text}</h1>\n';

async function bundle(root: string): Promise<(Rolldown.OutputChunk | Rolldown.OutputAsset)[]> {
  const result = await build({ root, configFile: false, logLevel: 'silent', plugins: [nexus()], build: { write: false } });
  return (Array.isArray(result) ? result : [result]).flatMap((entry) => ('output' in entry ? entry.output : []));
}

interface BuildError {
  message: string;
  id?: string;
  loc?: { line: number; column: number };
  frame?: string;
}

/** The first error of a build that is expected to fail. The bundler collects them in `errors`. */
async function failure(files: Record<string, string>): Promise<BuildError> {
  try {
    await bundle(project(files));
  } catch (error) {
    return ((error as { errors?: BuildError[] }).errors ?? [])[0] ?? (error as BuildError);
  }
  throw new Error('Expected the build to fail.');
}

describe('screens', () => {
  test('a screen is named after its file', () => {
    expect([screenName('Shop.nexus'), screenName('web/screens/VehicleShop.nexus'), screenName('hud.nexus')]).toEqual(['shop', 'vehicleShop', 'hud']);
  });

  test('the screens of a project are the .nexus files directly in its screens folder', () => {
    const root = project({ 'web/screens/Shop.nexus': '', 'web/screens/Hud.nexus': '', 'web/screens/notes.md': '', 'web/screens/parts/Row.nexus': '' });
    expect(findScreens(join(root, 'web/screens')).map((screen) => screen.name)).toEqual(['hud', 'shop']);
    expect(findScreens(join(root, 'web/missing'))).toEqual([]);
  });
});

describe('build', () => {
  test('a project without index.html and with a three-line config builds a page for Chromium 103', async () => {
    const root = project({ 'web/screens/Main.nexus': MAIN, 'web/screens/Other.nexus': '<p>other</p>', 'web/components/Label.nexus': LABEL });
    let target: unknown;
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [nexus(), { name: 'read-config', configResolved: (config) => void (target = [config.build.target, config.build.cssTarget, config.base, config.root]) }],
    });
    expect(target).toEqual(['chrome103', 'chrome103', './', join(root, 'web').split('\\').join('/')]);

    const dist = join(root, 'web/dist');
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(html).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>/);
    const assets = readdirSync(join(dist, 'assets'));
    // One chunk per screen, loaded on demand, and the styles of a screen next to it.
    expect(assets.filter((name) => /^Main-.*\.js$/.test(name))).toHaveLength(1);
    expect(assets.filter((name) => /^Other-.*\.js$/.test(name))).toHaveLength(1);
    expect(assets.filter((name) => /^Main-.*\.css$/.test(name))).toHaveLength(1);
    const entry = readFileSync(join(dist, 'assets', assets.find((name) => name.startsWith('index-')) as string), 'utf8');
    expect(entry).toMatch(/main:\s*\(\)\s*=>/);
    expect(entry).not.toContain('<h1');
  });

  test('a project can bring its own index.html', async () => {
    const root = project({ 'web/screens/Main.nexus': '<p>x</p>', 'web/index.html': '<!doctype html><html><head><title>Mine</title></head><body></body></html>' });
    await build({ root, configFile: false, logLevel: 'silent', plugins: [nexus()] });
    const html = readFileSync(join(root, 'web/dist/index.html'), 'utf8');
    expect(html).toContain('<title>Mine</title>');
    expect(html).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-/);
  });

  test('dev-only code is not in the build: no dev module, no call to it, nothing a call held', async () => {
    const output = await bundle(
      project({
        'web/screens/Main.nexus': "---\nimport { dev } from 'nexus';\nimport { cheat } from '../lib/cheats';\ndev.action('Fill the tank', () => cheat('fuel'));\n---\n<p>{cheat('shown')}</p>",
        'web/lib/cheats.ts':
          "import { dev as tools, signal } from 'nexus';\n\nexport const used = signal(0);\nexport const cheat = (what: string): string => `cheat ${what}`;\ntools.action('Skip the intro', () => cheat('intro'));\nif (used.value) tools.action('Never', () => {});\n",
      }),
    );
    const code = output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n');
    expect(code).toContain('cheat ');
    for (const gone of ['__NEXUS_DEV__', '__NEXUS_HOST__?.action', '$reload', '.action(', 'Fill the tank', 'Skip the intro', 'Never', 'fuel', 'intro']) {
      expect(code.includes(gone), gone).toBe(false);
    }
  });

  test('the page asks for no favicon', async () => {
    const root = project({ 'web/screens/Main.nexus': '<p>x</p>' });
    await build({ root, configFile: false, logLevel: 'silent', plugins: [nexus()] });
    expect(readFileSync(join(root, 'web/dist/index.html'), 'utf8')).toContain('<link rel="icon" href="data:,">');
  });

  test('one build serves the main page and the apps: the entry knows the screen of each surface', async () => {
    const output = await bundle(
      project({
        'web/screens/Main.nexus': '<screen focus="mouse" />\n<p>main</p>',
        'web/screens/GarageApp.nexus': '<screen surface="phone" />\n<p>phone</p>',
        'web/screens/GarageTablet.nexus': '<screen surface="tablet" />\n<p>tablet</p>',
      }),
    );
    const entry = output.find((chunk) => 'code' in chunk && chunk.isEntry) as Rolldown.OutputChunk;
    expect(entry.code).toMatch(/surfaces:\s*{\s*phone:\s*["'`]garageApp["'`],\s*tablet:\s*["'`]garageTablet["'`]/);
    expect(output.filter((chunk) => 'code' in chunk && /^assets\/Garage(App|Tablet)-/.test(chunk.fileName))).toHaveLength(2);
    // Checking props against the contract is for development only.
    expect(entry.code).not.toContain('.check');
    expect(entry.code).not.toContain('do not match web/contract.ts');
  });

  test('two screens on one surface stop the build, naming both', async () => {
    const error = await failure({
      'web/screens/First.nexus': '<screen surface="phone" />\n<p>a</p>',
      'web/screens/Second.nexus': '<screen surface="phone" />\n<p>b</p>',
    });
    expect(error.message).toContain('Two screens are the phone app: web/screens/First.nexus and web/screens/Second.nexus');
    expect(error.message).toContain('Remove surface="phone" from one of them');
  });

  test('a compile error stops the build and points into the file', async () => {
    const error = await failure({ 'web/screens/Main.nexus': '<main>\n  <p>text\n</main>\n' });
    expect(error.message).toContain('`<p>` is not closed');
    expect(error.message).toContain('Add `</p>`');
    expect(error.loc).toMatchObject({ line: 2, column: 2 });
    expect(error.frame).toContain('> 2 |   <p>text');
  });

  test('css that Chromium 103 cannot run stops the build: in a component', async () => {
    const error = await failure({ 'web/screens/Main.nexus': '<p>x</p>\n<style>\n  p:has(b) { color: red; }\n</style>\n' });
    expect(error.message).toContain('`:has()` needs Chromium 105');
    expect(error.loc).toMatchObject({ line: 3, column: 3 });
  });

  test('css that Chromium 103 cannot run stops the build: in a stylesheet', async () => {
    const error = await failure({
      'web/screens/Main.nexus': "---\nimport '../theme.css';\n---\n<p>x</p>",
      'web/theme.css': 'body { margin: 0; }\n.panel { height: 100dvh; }\n',
    });
    expect(error.message).toContain('needs Chromium 108');
    expect(error.id).toContain('theme.css');
    expect(error.loc).toMatchObject({ line: 2, column: 17 });
  });

  test('javascript that Chromium 103 cannot run stops the build', async () => {
    const error = await failure({
      'web/screens/Main.nexus': "---\nimport { newest } from '../lib/sort';\n---\n<p>{newest([1])}</p>",
      'web/lib/sort.ts': 'export const newest = (list: number[]): number[] =>\n  list.toSorted();\n',
    });
    expect(error.message).toContain('needs Chromium 110');
    expect(error.id).toContain('sort.ts');
    expect(error.loc).toMatchObject({ line: 2, column: 6 });
  });

  test('the types of the contract are written next to it', async () => {
    const root = project({
      'web/screens/Main.nexus': '<p>x</p>',
      'web/contract.ts':
        "import { contract, s } from 'nexus/contract';\n\nexport default contract({\n  calls: { greet: { input: s.object({ name: s.string({ max: 20 }) }), output: s.object({ message: s.string() }) } },\n});\n",
    });
    await bundle(root);
    const types = readFileSync(join(root, 'web/nexus-contract.d.ts'), 'utf8');
    expect(types).toContain("declare module 'nexus'");
    expect(types).toContain('interface NexusContract');
    expect(types).toContain('greet: {');
    expect(types).toContain('input: { name: string }');
  });
});

describe.skipIf(!CHROMIUM_103)('dev server in Chromium 103', () => {
  let root: string;
  let server: ViteDevServer;
  let page: Page;
  const errors: string[] = [];

  const write = (path: string, content: string): void => writeFileSync(join(root, path), content);
  const lua = (message: Record<string, unknown>): Promise<void> => page.evaluate((payload) => (window as unknown as { lua: (message: object) => void }).lua(payload), message);

  beforeAll(async () => {
    root = project({ 'web/screens/Main.nexus': MAIN, 'web/components/Label.nexus': LABEL });
    // The runtime is served from this repository, which is outside the project folder.
    server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [nexus()], server: { port: 0, host: '127.0.0.1', fs: { strict: false } } });
    await server.listen();
    const { port } = server.httpServer!.address() as { port: number };

    page = await (await launch()).newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(installHost, 'host' as const);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => (window as unknown as { sentToLua?: { t: string }[] }).sentToLua?.some((message) => message.t === 'ready'));
    await lua({ t: 'open', screen: 'main', props: { title: 'Garage' } });
    await page.waitForSelector('#main');
  }, 120000);

  afterAll(async () => {
    await page?.close();
    await server?.close();
    await shutdown();
  });

  test('the page is served without an index.html and runs in dev mode', async () => {
    expect(existsSync(join(root, 'web/index.html'))).toBe(false);
    expect(await page.textContent('#label')).toBe('Garage');
    expect(await page.evaluate(() => (globalThis as { __NEXUS_DEV__?: boolean }).__NEXUS_DEV__)).toBe(true);
  });

  test('editing the screen mounts it again with the props it had', async () => {
    await page.click('#click');
    await lua({ t: 'open', screen: 'main', props: { title: 'Updated' } });
    expect(await page.textContent('#click')).toBe('1');

    write('web/screens/Main.nexus', MAIN.replace('>first<', '>second<'));
    await page.waitForFunction(() => document.querySelector('#marker')?.textContent === 'second');
    expect(await page.textContent('#label')).toBe('Updated');
    expect(await page.textContent('#click')).toBe('0');
    expect(await page.locator('[data-screen="main"]').count()).toBe(1);
  });

  test('editing a component used by the screen does the same', async () => {
    write('web/components/Label.nexus', '<h1 id="label">Title: {props.text}</h1>\n');
    await page.waitForFunction(() => document.querySelector('#label')?.textContent === 'Title: Updated');
  });

  test('editing only the styles updates them without touching the mounted screen', async () => {
    await page.click('#click');
    write('web/screens/Main.nexus', MAIN.replace('>first<', '>second<').replace('rgb(1, 1, 1)', 'rgb(2, 2, 2)'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#marker')!).color === 'rgb(2, 2, 2)');
    expect(await page.textContent('#click')).toBe('1');
  });

  test('a new screen file is picked up', async () => {
    write('web/screens/Extra.nexus', '<p id="extra">extra</p>\n');
    await page.waitForFunction(() => (window as unknown as { sentToLua?: { t: string }[] }).sentToLua?.filter((message) => message.t === 'ready').length === 1 && !document.querySelector('#main'));
    await lua({ t: 'open', screen: 'extra', props: {} });
    await page.waitForSelector('#extra');
  });

  test('nothing was reported as an error', () => {
    expect(errors).toEqual([]);
  });
});

const CONTRACT = `import { contract, s } from 'nexus/contract';

export default contract({
  screens: {
    main: s.object({ title: s.string({ max: 20 }), stock: s.optional(s.int({ min: 0 })) }),
  },
});
`;

const APP = `<screen surface="phone" />

<p id="app">app</p>
`;

describe.skipIf(!CHROMIUM_103)('dev server: the page, apps and screen props in Chromium 103', () => {
  let root: string;
  let server: ViteDevServer;
  let address: string;
  let page: Page;
  const errors: string[] = [];
  const missing: string[] = [];

  const lua = (message: Record<string, unknown>): Promise<void> => page.evaluate((payload) => (window as unknown as { lua: (message: object) => void }).lua(payload), message);
  const ready = (): Promise<unknown> => page.waitForFunction(() => (window as unknown as { sentToLua?: { t: string }[] }).sentToLua?.some((message) => message.t === 'ready'));

  beforeAll(async () => {
    root = project({
      'web/screens/Main.nexus': MAIN,
      'web/screens/Other.nexus': '<p id="other">{props.anything}</p>\n',
      'web/components/Label.nexus': LABEL,
      'web/contract.ts': CONTRACT,
    });
    const toolbar = join(fileURLToPath(import.meta.url), '../../../src/cli/host/toolbar.ts').split('\\').join('/');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        nexus(),
        {
          // The dev toolbar of `nexus dev`, added the way that command adds it.
          name: 'toolbar',
          transformIndexHtml: () => [
            {
              tag: 'script',
              attrs: { type: 'module' },
              children: `import { createToolbar } from '/@fs/${toolbar}'; createToolbar({ resource: 'fixture', screens: ['main'], apps: ['phone', 'tablet'], hasMock: false, toggle() {}, frameChanged() {} });`,
              injectTo: 'head',
            },
          ],
        },
      ],
      server: { port: 0, host: '127.0.0.1', fs: { strict: false } },
    });
    await server.listen();
    address = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/`;

    page = await (await launch()).newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) missing.push(response.url());
    });
    await page.addInitScript(installHost, 'host' as const);
    await page.goto(address);
    await ready();
  }, 120000);

  afterAll(async () => {
    await page?.close();
    await server?.close();
    await shutdown();
  });

  test('the page loads without a failed request or a console error, favicon included', async () => {
    expect(await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href'))).toBe('data:,');
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the dev toolbar has a size, so a test can wait for it to be visible', async () => {
    await page.waitForSelector('[data-nexus-dev]', { timeout: 3000 });
    const box = (await page.locator('[data-nexus-dev]').boundingBox())!;
    expect(box.width).toBeGreaterThan(50);
    expect(box.height).toBeGreaterThan(10);
    await page.locator('[data-nexus-dev] button', { hasText: 'main' }).click();
  });

  test('one app frame is shown and sized while the other app has never been shown', async () => {
    await page.locator('[data-nexus-dev] button', { hasText: 'phone app' }).click();
    const frame = page.locator('[data-nexus-dev] iframe');
    await frame.waitFor();
    const box = (await frame.boundingBox())!;
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(200);
    expect(await page.locator('[data-nexus-dev] button', { hasText: 'phone app' }).getAttribute('aria-pressed')).toBe('true');
    expect(errors).toEqual([]);
    await page.locator('[data-nexus-dev] button', { hasText: 'phone app' }).click();
    await frame.waitFor({ state: 'detached' });
  });

  test('props that match the contract open the screen quietly', async () => {
    await lua({ t: 'open', screen: 'main', props: { title: 'Garage', stock: 3 } });
    await page.waitForSelector('#main');
    expect(await page.textContent('#label')).toBe('Garage');
    expect(errors).toEqual([]);
  });

  test('props that do not match are reported, with the screen and what is wrong', async () => {
    await lua({ t: 'open', screen: 'main', props: { title: 12, extra: true } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('the screen "main" was opened with props that do not match web/contract.ts');
    expect(errors[0]).toMatch(/title|extra/);
    // It is a report, not a refusal: the screen still gets what Lua sent.
    expect(await page.textContent('#label')).toBe('12');
    errors.length = 0;
  });

  test('a screen the contract does not list takes whatever it is given', async () => {
    await lua({ t: 'open', screen: 'other', props: { anything: 'goes' } });
    await page.waitForSelector('#other');
    expect(errors).toEqual([]);
    await lua({ t: 'close', screen: 'other' });
    await lua({ t: 'close', screen: 'main' });
  });

  test('a screen that becomes an app reloads the page, which then mounts it for its surface', async () => {
    writeFileSync(join(root, 'web/screens/Other.nexus'), APP);
    await page.waitForFunction(() => (window as unknown as { sentToLua?: unknown[] }).sentToLua?.length === 1);
    await ready();
    expect(await page.locator('#app').count()).toBe(0);

    await page.goto(`${address}?surface=phone&resource=fixture`);
    await page.waitForSelector('#app');
    expect(await page.evaluate(() => (window as unknown as { sentToLua: unknown[] }).sentToLua)).toEqual([{ t: 'ready', surface: 'phone' }]);
    expect(errors).toEqual([]);
  });
});
