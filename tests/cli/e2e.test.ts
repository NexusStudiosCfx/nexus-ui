import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lua, type LogEntry } from '../support/lua';
import { buildPackage, CLI, copyProject, install, nexus, read, REPO, startNexus, workPath } from '../support/package';

const CHROMIUM = process.env.NEXUS_CHROMIUM_103;

/** Replaces text in a project file for the length of `run`, then puts the file back. */
function withChange(path: string, from: string, to: string, run: () => void): void {
  const file = workPath(path);
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) throw new Error(`${path} does not contain ${JSON.stringify(from)}`);
  writeFileSync(file, original.replace(from, to));
  try {
    run();
  } finally {
    writeFileSync(file, original);
  }
}

function withFile(path: string, content: string, run: () => void): void {
  mkdirSync(dirname(workPath(path)), { recursive: true });
  writeFileSync(workPath(path), content);
  try {
    run();
  } finally {
    rmSync(workPath(path));
  }
}

/** Resolves with everything the process has printed once `text` shows up in it. */
function waitForOutput(process: ChildProcess, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`"${text}" never appeared in:\n${output}`)), 30000);
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    process.stdout?.on('data', read);
    process.stderr?.on('data', read);
    process.on('exit', (code) => reject(new Error(`nexus stopped with code ${String(code)}:\n${output}`)));
  });
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  const exited = new Promise((resolve) => process.once('exit', resolve));
  process.kill();
  await exited;
}

describe('the nexus command line', { timeout: 120000 }, () => {
  beforeAll(() => buildPackage(), 180000);

  describe('nexus', () => {
    it('prints help without a command, and the version', () => {
      const help = nexus('.');
      expect(help.status).toBe(0);
      expect(help.output).toContain('create <name>');
      expect(nexus('.', '--version').output.trim()).toBe((JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version);
    });

    it('names its commands when it is given one it does not have', () => {
      const result = nexus('.', 'biuld');
      expect(result.status).toBe(1);
      expect(result.output).toContain('error nexus has no command "biuld".');
      expect(result.output).toContain('The commands are: create, dev, build, check.');
    });

    it('says where to run it when the folder is not a resource', () => {
      const result = nexus('.', 'build');
      expect(result.status).toBe(1);
      expect(result.output).toContain('There is no web folder in');
      expect(result.output).toContain('To start a new resource: nexus create <name>');
    });
  });

  describe('nexus create', () => {
    it('refuses a missing or unusable name', () => {
      expect(nexus('.', 'create').output).toContain('nexus create needs a name for the resource.');
      const result = nexus('.', 'create', 'my shop!');
      expect(result.status).toBe(1);
      expect(result.output).toContain('"my shop!" cannot be used as a resource name.');
    });

    it('creates a resource with the name filled in everywhere', () => {
      const result = nexus('.', 'create', 'my_shop');
      expect(result.status).toBe(0);
      expect(result.output).toContain('ok Created my_shop');
      for (const file of ['fxmanifest.lua', 'client/main.lua', 'server/main.lua', 'locales/en.json', 'web/contract.ts', 'web/mock.ts', 'web/nexus-env.d.ts', 'web/screens/Main.nexus', 'package.json', 'tsconfig.json', 'vite.config.ts', '.gitignore']) {
        expect(existsSync(workPath('my_shop', file)), file).toBe(true);
        expect(read('my_shop', file), file).not.toContain('{{');
      }
      expect(read('my_shop', 'fxmanifest.lua')).toContain("name 'my_shop'");
      expect(read('my_shop', 'client/main.lua')).toContain("RegisterCommand('my_shop'");
      const manifest = JSON.parse(read('my_shop', 'package.json')) as { name: string; devDependencies: Record<string, string> };
      const version = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
      expect(manifest.name).toBe('my_shop');
      expect(manifest.devDependencies['@nexusstudios/ui']).toBe(`^${version}`);
      install('my_shop');
    });

    it('is what npm create nexus-ui runs', () => {
      // The initializer package is one file that hands over to `nexus create`.
      mkdirSync(workPath('initializer'), { recursive: true });
      writeFileSync(workPath('initializer', 'index.js'), readFileSync(join(REPO, 'packages/create-nexus-ui/index.js'), 'utf8'));
      writeFileSync(workPath('initializer', 'package.json'), '{ "type": "module" }');
      install('initializer');
      const result = spawnSync(process.execPath, [workPath('initializer', 'index.js'), 'made_by_create'], {
        cwd: workPath('.'),
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });
      expect(`${result.stdout}${result.stderr}`).toContain('ok Created made_by_create');
      expect(existsSync(workPath('made_by_create', 'fxmanifest.lua'))).toBe(true);
    });

    it('does not write into a folder that already has files', () => {
      const result = nexus('.', 'create', 'my_shop');
      expect(result.status).toBe(1);
      expect(result.output).toContain('already exists and is not empty');
    });
  });

  describe('nexus build', () => {
    it('builds the created resource as it is', () => {
      const result = nexus('my_shop', 'build');
      expect(result.output).toContain('ok fxmanifest.lua loads the bridge and ships web/dist');
      expect(result.status).toBe(0);
      expect(existsSync(workPath('my_shop', 'web/dist/index.html'))).toBe(true);
      expect(read('my_shop', 'nexus/client.lua')).toBe(readFileSync(join(REPO, 'lua/client.lua'), 'utf8'));
      expect(read('my_shop', 'nexus/server.lua')).toBe(readFileSync(join(REPO, 'lua/server.lua'), 'utf8'));
      expect(read('my_shop', 'nexus/contract.lua')).toContain('greet = {');
      expect(read('my_shop', 'nexus/screens.lua')).toContain("main = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true }");
      expect(read('my_shop', 'web/nexus-contract.d.ts')).toContain('input: { name: string };');
    });

    it('prints the exact manifest lines that are missing', () => {
      withChange('my_shop/fxmanifest.lua', "shared_scripts {\n    'nexus/contract.lua',\n}\n", '', () => {
        const result = nexus('my_shop', 'build');
        expect(result.status).toBe(1);
        expect(result.output).toContain('nexus/contract.lua must load on both sides, before nexus/client.lua and nexus/server.lua.');
        expect(result.output).toContain("Add these lines to fxmanifest.lua:\n\n    shared_scripts { 'nexus/contract.lua' }");
      });
    });

    it('stops at a component that does not compile, with the file, the position and a code frame', () => {
      withFile('my_shop/web/screens/Broken.nexus', '<section>\n  <p>{count</p>\n</section>\n', () => {
        const result = nexus('my_shop', 'build');
        expect(result.status).toBe(1);
        expect(result.output).toMatch(/error web\/screens\/Broken\.nexus:2:\d+: /);
        expect(result.output).toContain('> 2 |   <p>{count</p>');
        expect(result.output).toContain('The build stopped: one component has an error.');
      });
    });

    it('reports a contract the bridge could not enforce', () => {
      withChange('my_shop/web/contract.ts', 's.string({ min: 1, max: 24 })', 's.string({ min: 30, max: 24 })', () => {
        const result = nexus('my_shop', 'build');
        expect(result.status).toBe(1);
        expect(result.output).toContain('error web/contract.ts: s.string: min (30) is greater than max (24)');
      });
    });
  });

  describe('the Lua of the built resource', () => {
    const load = async (lua: Lua, ...files: string[]): Promise<void> => {
      for (const file of files) await lua.run(read('my_shop', file));
    };

    it('answers the call of the template on the server', async () => {
      const lua = await Lua.create({ fivem: true });
      await load(lua, 'nexus/contract.lua', 'nexus/server.lua', 'server/main.lua');
      await lua.trigger('demo:nexus:call', 7, 1, 'greet', { name: 'Ada' });
      await lua.trigger('demo:nexus:call', 7, 2, 'greet', { name: '' });
      const answers = (await lua.drain()).flatMap((entry: LogEntry) => (entry.kind === 'clientEvent' ? [entry.args.slice(0, 4)] : []));
      expect(answers).toEqual([
        [1, true, { message: 'Hello Ada. The server knows you as player 7.' }],
        [2, false, 'invalid', 'name: expected at least 1 character'],
      ]);
      lua.close();
    });

    it('opens the screen from its command on the client', async () => {
      const lua = await Lua.create({ fivem: true });
      await lua.run(`Sim.files['locales/en.json'] = ${JSON.stringify(read('my_shop', 'locales/en.json'))}`);
      await load(lua, 'nexus/contract.lua', 'nexus/screens.lua', 'nexus/client.lua', 'client/main.lua');
      await lua.post({ t: 'ready' });
      await lua.run(`Sim.command('my_shop', 0)`);
      const log = await lua.drain();
      const messages = log.flatMap((entry) => (entry.kind === 'nui' ? [entry.message] : []));
      expect(messages[0]).toMatchObject({ t: 'locale', data: { 'main.title': 'Hello from my_shop' } });
      expect(messages[1]).toEqual({ __nexus: 1, t: 'open', screen: 'main', props: { name: 'Tester' } });
      expect(log).toContainEqual({ kind: 'focus', focus: true, cursor: true });
      expect(await lua.threads()).toBe(0);
      lua.close();
    });
  });

  describe('nexus check', () => {
    it('passes on the created resource', () => {
      const result = nexus('my_shop', 'check');
      expect(result.output).toContain('ok 1 component checked, no errors.');
      expect(result.status).toBe(0);
    });

    it('reports a type error in the script at its place in the .nexus file', () => {
      withChange('my_shop/web/screens/Main.nexus', 'reply.value = result.message;', 'reply.value = result.mesage;', () => {
        const result = nexus('my_shop', 'check');
        expect(result.status).toBe(1);
        expect(result.output).toContain("error web/screens/Main.nexus:14:26: Property 'mesage' does not exist on type '{ message: string; }'. Did you mean 'message'? (TS2551)");
        expect(result.output).toContain('> 14 |     reply.value = result.mesage;');
        expect(result.output).toContain('error nexus check found 1 error.');
      });
    });

    it('checks a call against the contract', () => {
      withChange('my_shop/web/screens/Main.nexus', "nui.call('greet', { name: name.value })", "nui.call('greet', { nam: name.value })", () => {
        const result = nexus('my_shop', 'check');
        expect(result.status).toBe(1);
        expect(result.output).toMatch(/error web\/screens\/Main\.nexus:13:\d+: .*'nam' does not exist in type '\{ name: string; \}'/);
      });
    });

    it('reports a type error in a template expression', () => {
      withChange('my_shop/web/screens/Main.nexus', '{#if reply}', '{#if reply.value.lenght > 0}', () => {
        const result = nexus('my_shop', 'check');
        expect(result.status).toBe(1);
        expect(result.output).toMatch(/error web\/screens\/Main\.nexus:\d+:20: Property 'lenght' does not exist on type 'string'/);
        expect(result.output).toContain('{#if reply.value.lenght > 0}');
      });
    });

    it('checks the props a component is given', () => {
      withFile('my_shop/web/screens/Badge.nexus', '---\ninterface Props {\n  label: string;\n  count: number;\n}\n---\n\n<b>{props.label} {props.count}</b>\n', () => {
        withChange('my_shop/web/screens/Main.nexus', "<h1>{t('main.title')}</h1>", "<h1>{t('main.title')}</h1>\n  <Badge label=\"New\" />", () => {
          withChange('my_shop/web/screens/Main.nexus', "import { signal, nui, t, NuiError } from 'nexus';", "import { signal, nui, t, NuiError } from 'nexus';\nimport Badge from './Badge.nexus';", () => {
            const result = nexus('my_shop', 'check');
            expect(result.status).toBe(1);
            expect(result.output).toMatch(/error web\/screens\/Main\.nexus:26:4: Property 'count' is missing in type/);
            expect(result.output).toContain('<Badge label="New" />');
          });
        });
      });
    });

    it('reports what Chromium 103 cannot run, in a script, a module and a stylesheet', () => {
      withFile('my_shop/web/sort.ts', 'export const sorted = (list: number[]): number[] => list.toSorted();\n', () => {
        withFile('my_shop/web/theme.css', '.panel { color: color-mix(in srgb, red, blue); }\n', () => {
          withChange('my_shop/web/screens/Main.nexus', "const reply = signal('');", "const reply = signal('');\nconst groups = Object.groupBy([1, 2], (value: number) => value);", () => {
            const result = nexus('my_shop', 'check');
            expect(result.status).toBe(1);
            expect(result.output).toContain('error web/sort.ts:1:57: This array method needs Chromium 110. FiveM runs Chromium 103. (unsupported-api)');
            expect(result.output).toContain('error web/theme.css:1:17: `color-mix()` needs Chromium 111. FiveM runs Chromium 103. (unsupported-css)');
            expect(result.output).toContain('error web/screens/Main.nexus:10:16: `groupBy` needs Chromium 117. FiveM runs Chromium 103. (unsupported-api)');
            // TypeScript knows the same from `lib`, and that second report is dropped.
            expect(result.output).not.toContain('TS2550');
          });
        });
      });
    });

    it('accepts what Vite adds to a module, and gives an inline handler its event', () => {
      withFile('my_shop/web/pages.ts', "export const pages = import.meta.glob('./screens/*.nexus');\nexport const dev: boolean = import.meta.env.DEV;\n", () => {
        withChange(
          'my_shop/web/screens/Main.nexus',
          '<input bind:value={name} maxlength="24">',
          `<input bind:value={name} maxlength="24" on:input={(event) => console.log(event.currentTarget.value.length)} on:keydown={(event) => event.key === 'Enter' && send()}>`,
          () => {
            const result = nexus('my_shop', 'check');
            expect(result.output).toContain('no errors');
            expect(result.status).toBe(0);
          },
        );
      });
    });

    it('reports an event used as one it is not', () => {
      withChange('my_shop/web/screens/Main.nexus', '<button on:click={send}', '<button on:click={(event) => event.key && send()}', () => {
        const result = nexus('my_shop', 'check');
        expect(result.status).toBe(1);
        expect(result.output).toMatch(/error web\/screens\/Main\.nexus:\d+:\d+: Property 'key' does not exist on type 'PointerEvent & \{ readonly currentTarget: HTMLButtonElement; \}'/);
      });
    });

    it('leaves out what tsconfig.json excludes', () => {
      const script = "import { readFileSync } from 'node:fs';\n\nexport const size: number = readFileSync('icon.png');\nexport const sorted = [3, 1].toSorted();\n";
      withFile('my_shop/web/tools/pack.ts', script, () => {
        const included = nexus('my_shop', 'check');
        expect(included.status).toBe(1);
        expect(included.output).toContain('web/tools/pack.ts');

        withChange('my_shop/tsconfig.json', '"include": ["web"]', '"include": ["web"],\n  "exclude": ["web/tools"]', () => {
          const excluded = nexus('my_shop', 'check');
          expect(excluded.output).not.toContain('web/tools/pack.ts');
          expect(excluded.status).toBe(0);
        });
      });
    });

    it('types the props of a screen from the contract, and holds its own Props to it', () => {
      const screens = "  screens: {\n    main: s.object({ name: s.string({ max: 64 }), vip: s.optional(s.boolean()) }),\n  },\n});";
      withChange('my_shop/web/contract.ts', '});\n', screens + '\n', () => {
        // Props in the file says `name` only, which the contract's props still satisfy.
        expect(nexus('my_shop', 'check').status).toBe(0);

        withChange('my_shop/web/screens/Main.nexus', '  name: string;\n}', '  name: number;\n}', () => {
          const result = nexus('my_shop', 'check');
          expect(result.status).toBe(1);
          expect(result.output).toMatch(/error web\/screens\/Main\.nexus:4:11: Type '\{ name: string; vip\?: boolean[^}]*\}' is not assignable to type 'Props'/);
        });

        withChange('my_shop/web/screens/Main.nexus', 'interface Props {\n  name: string;\n}\n\n', '', () => {
          withChange('my_shop/web/screens/Main.nexus', '{#if reply}', '{#if reply.value && props.vipp}', () => {
            const result = nexus('my_shop', 'check');
            expect(result.status).toBe(1);
            expect(result.output).toMatch(/Property 'vipp' does not exist on type 'Readonly<\{ name: string; vip\?: boolean[^}]*\}>'\. Did you mean 'vip'\?/);
          });
        });
      });
    });

    it('reports an app that is declared twice, has props, or is asked for without a screen', () => {
      const app = '<screen surface="phone" />\n\n<p>App</p>\n';
      withFile('my_shop/web/screens/Phone.nexus', app, () => {
        const unregistered = nexus('my_shop', 'check');
        expect(unregistered.status).toBe(0);
        expect(unregistered.output).toContain('warning web/screens/Phone.nexus:1:1: No Lua registers the phone app, so LB Phone will not show it. (surface-unregistered)');
        expect(unregistered.output).toContain("Add to a client script: Nexus.app('phone', { name = '...' })");

        withFile('my_shop/web/screens/Second.nexus', app, () => {
          const twice = nexus('my_shop', 'check');
          expect(twice.status).toBe(1);
          expect(twice.output).toContain('error web/screens/Second.nexus:1:1: A resource has one phone app, and web/screens/Phone.nexus already is it. (surface-taken)');
        });

        withChange('my_shop/web/contract.ts', '});\n', '  screens: { phone: s.object({ name: s.string() }) },\n});\n', () => {
          const props = nexus('my_shop', 'check');
          expect(props.status).toBe(1);
          expect(props.output).toContain('The phone app has no props: LB Phone opens it, and nothing is passed along. The contract declares props for "phone". (surface-props)');
        });
      });

      withChange('my_shop/client/main.lua', "RegisterCommand('my_shop'", "Nexus.app('tablet', { name = 'Shop' })\n\nRegisterCommand('my_shop'", () => {
        const missing = nexus('my_shop', 'check');
        expect(missing.status).toBe(1);
        expect(missing.output).toContain("Lua calls Nexus.app('tablet', ...), but no screen is the tablet app. (surface-missing)");
        expect(missing.output).toContain('Add <screen surface="tablet" /> to the screen in web/screens that the app should show.');
      });
    });

    it('reports a world screen that Lua opens as a screen, a display of what is none, and a world screen without a size', () => {
      const world = '<screen surface="world" size="800x600" />\n\n<p>Clock</p>\n';
      withFile('my_shop/web/screens/Clock.nexus', world, () => {
        // A resource may have as many world screens as it likes, and nothing has to register one.
        withFile('my_shop/web/screens/Terminal.nexus', world, () => {
          const fine = nexus('my_shop', 'check');
          expect(fine.output).toContain('ok 3 components checked, no errors.');
          expect(fine.status).toBe(0);
        });

        const lua = [
          "Nexus.open('clock')",
          "local a = Nexus.world('main', { txd = 'a', texture = 'b' })",
          "local b = Nexus.world('clokc', { txd = 'a', texture = 'b' })",
          "-- Nexus.world('nowhere', {})",
          "local c = Nexus.world('clock', { txd = 'a', texture = 'b' })",
        ].join('\n');
        withChange('my_shop/client/main.lua', "RegisterCommand('my_shop'", `${lua}\n\nRegisterCommand('my_shop'`, () => {
          const wrong = nexus('my_shop', 'check');
          expect(wrong.status).toBe(1);
          expect(wrong.output).toContain('error client/main.lua:6:1: Nexus.open cannot open "clock": it is a world screen, which is drawn on a prop and not on the page. (world-open)');
          expect(wrong.output).toContain("Create a display of it: Nexus.world('clock', { txd = '...', texture = '...' })");
          expect(wrong.output).toContain("error client/main.lua:7:11: Nexus.world('main', ...) names a screen that is not a world screen. (world-missing)");
          expect(wrong.output).toContain("error client/main.lua:8:11: Nexus.world('clokc', ...) names no screen. (world-missing)");
          expect(wrong.output).toContain("Did you mean 'clock'?");
          // A call in a comment is not a call.
          expect(wrong.output).not.toContain("Nexus.world('nowhere', ...)");
          expect(wrong.output).toContain('nexus check found 3 errors.');
          // The build runs the same checks, before it writes anything.
          expect(nexus('my_shop', 'build').output).toContain('(world-open)');
        });
      });

      withFile('my_shop/web/screens/Clock.nexus', '<screen surface="world" />\n\n<p>Clock</p>\n', () => {
        const unsized = nexus('my_shop', 'check');
        expect(unsized.status).toBe(1);
        expect(unsized.output).toContain('error web/screens/Clock.nexus:1:1: A world screen needs a `size`: the resolution of the browser that draws it. (world-size)');
      });
      withFile('my_shop/web/screens/Clock.nexus', '<screen surface="world" size="800x600" focus="mouse" />\n\n<p>Clock</p>\n', () => {
        const focused = nexus('my_shop', 'check');
        expect(focused.status).toBe(1);
        expect(focused.output).toContain('`focus` has no meaning on a world screen, which is drawn on a prop. It takes no focus: the player uses it through `Nexus.operate`. (surface-attribute)');
      });
    });

    it('reports a broken contract and still checks the components', () => {
      withChange('my_shop/web/contract.ts', 'export default contract({', 'export const draft = contract({', () => {
        const result = nexus('my_shop', 'check');
        expect(result.status).toBe(1);
        expect(result.output).toContain('error web/contract.ts has no contract as its default export.');
        expect(result.output).toContain('End the file with: export default contract({ ... });');
      });
    });
  });

  describe('nexus dev --game', () => {
    it('points ui_page at the dev server and puts it back when it is interrupted', () => {
      const original = read('my_shop', 'fxmanifest.lua');
      const result = spawnSync(process.execPath, [join(REPO, 'tests/support/interrupt.mjs'), CLI, 'dev', '--game', '--port', '5390'], {
        cwd: workPath('my_shop'),
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });
      expect(result.stdout).toContain('ok fxmanifest.lua loads the page from http://localhost:5390/ until you stop this command');
      expect(result.status).toBe(0);
      expect(read('my_shop', 'fxmanifest.lua')).toBe(original);
    });

    it('points ui_page at the dev server, and the next command puts it back if it was killed', async () => {
      const original = read('my_shop', 'fxmanifest.lua');
      const server = startNexus('my_shop', 'dev', '--game', '--port', '5391');
      try {
        const output = await waitForOutput(server, 'Press Ctrl+C to stop.');
        expect(output).toContain('my_shop is running at http://localhost:5391/');
        expect(output).toContain('ensure my_shop');
        expect(read('my_shop', 'fxmanifest.lua')).toContain("ui_page 'http://localhost:5391/' -- nexus dev: restore ui_page 'web/dist/index.html'");
      } finally {
        await stop(server);
      }
      expect(nexus('my_shop', 'build').status).toBe(0);
      expect(read('my_shop', 'fxmanifest.lua')).toBe(original);
    });

    it('stops when the process that started it is ended, even with others in between', async () => {
      const listening = (port: number): Promise<boolean> =>
        new Promise((resolve) => {
          const socket = connect(port, 'localhost');
          socket.once('connect', () => (socket.destroy(), resolve(true)));
          socket.once('error', () => resolve(false));
        });

      // Processes stand between this test and the dev server: two, as a shell and npm do, and
      // four, as when a task runner starts npm through a shim.
      for (const [links, port] of [
        ['2', 5389],
        ['4', 5393],
      ] as const) {
        const first = spawn(process.execPath, [join(REPO, 'tests/support/chain.mjs'), links, CLI, 'dev', '--port', String(port)], {
          cwd: workPath('my_shop'),
          env: { ...process.env, NO_COLOR: '1' },
        });
        await waitForOutput(first, 'is running at');
        expect(await listening(port)).toBe(true);
        // The server looks up the processes above it once, which takes a few seconds on Windows.
        // One that is gone by then counts as left behind on purpose, so the test waits that out.
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Ending the first leaves the others running on Windows. The server has to notice.
        const exited = new Promise((resolve) => first.once('exit', resolve));
        first.kill();
        await exited;
        let open = true;
        for (let attempt = 0; attempt < 40 && open; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          open = await listening(port);
        }
        expect(open, `${links} processes above the server`).toBe(false);
      }
    });

    it('says what to do when the port is taken', async () => {
      const first = startNexus('my_shop', 'dev', '--port', '5391');
      try {
        await waitForOutput(first, 'is running at');
        const second = nexus('my_shop', 'dev', '--game', '--port', '5391');
        expect(second.status).toBe(1);
        expect(second.output).toContain('error Port 5391 is already in use.');
        expect(second.output).toContain('nexus dev --game --port 5392');
      } finally {
        await stop(first);
      }
    });
  });

  describe.skipIf(!CHROMIUM)('nexus dev in Chromium 103 (set NEXUS_CHROMIUM_103 to run)', () => {
    let server: ChildProcess;
    let browser: Browser;
    let page: Page;

    /** Sends a call straight to the mock host and resolves with its answer, the way the page's bridge would see it. */
    const call = (id: number, name: string, data: unknown): Promise<Record<string, unknown>> =>
      page.evaluate(
        ([callId, callName, callData]) =>
          new Promise<Record<string, unknown>>((resolve) => {
            const host = window.__NEXUS_HOST__ as NonNullable<typeof window.__NEXUS_HOST__>;
            host.onMessage((message) => {
              const answer = message as Record<string, unknown>;
              if (answer.t === 'res' && answer.id === callId) resolve(answer);
            });
            void host.post({ t: 'call', id: callId, name: callName, data: callData });
          }),
        [id, name, data] as const,
      );

    beforeAll(async () => {
      server = startNexus('my_shop', 'dev', '--port', '5392');
      await waitForOutput(server, 'is running at');
      browser = await chromium.launch({ executablePath: CHROMIUM as string });
      page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto('http://localhost:5392/');
      await page.locator('[data-nexus-dev] button', { hasText: 'main' }).click();
      await page.locator('[data-screen="main"] h1').waitFor();
    }, 60000);

    afterAll(async () => {
      await browser?.close();
      if (server) await stop(server);
    });

    it('opens a screen from the toolbar with the props and the locale of the mock', async () => {
      expect(await page.locator('[data-screen="main"] h1').textContent()).toBe('Hello from my_shop');
      expect(await page.locator('[data-screen="main"] input').inputValue()).toBe('Player');
      expect(await page.locator('[data-nexus-dev] button', { hasText: 'main' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('answers a call with the handler of the mock', async () => {
      await page.locator('[data-screen="main"] input').fill('Ada');
      await page.locator('[data-screen="main"] button', { hasText: 'Send to the server' }).click();
      await page.locator('[data-screen="main"] .reply').waitFor();
      expect(await page.locator('[data-screen="main"] .reply').textContent()).toBe('Hello Ada. This answer comes from web/mock.ts.');
    });

    it('refuses what the server would refuse, with the same codes and messages', async () => {
      expect(await call(900, 'greet', { name: '' })).toMatchObject({ ok: false, code: 'invalid', message: 'name: expected at least 1 character' });
      expect(await call(901, 'greet', { name: 'Ada', admin: true })).toMatchObject({ ok: false, code: 'invalid', message: 'unknown key "admin"' });
      expect(await call(902, 'delete-everything', {})).toMatchObject({ ok: false, code: 'invalid', message: "'delete-everything' is not a call in web/contract.ts" });
    });

    it('applies the rate limit of the contract', async () => {
      const answers = [];
      for (let id = 910; id < 918; id++) answers.push(await call(id, 'greet', { name: 'Ada' }));
      const codes = answers.map((answer) => (answer.ok ? 'ok' : answer.code));
      expect(codes.filter((code) => code === 'ok').length).toBeLessThanOrEqual(5);
      expect(codes[codes.length - 1]).toBe('rate_limited');
    });

    it('closes the screen on Escape and shows it in the toolbar', async () => {
      await page.keyboard.press('Escape');
      await page.locator('[data-screen="main"]').waitFor({ state: 'detached' });
      expect(await page.locator('[data-nexus-dev] button', { hasText: 'main' }).getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('the garage example', () => {
    beforeAll(() => copyProject('examples/garage', 'garage'));

    it('builds and passes nexus check', () => {
      const built = nexus('garage', 'build');
      expect(built.output).toContain('ok fxmanifest.lua loads the bridge and ships web/dist');
      expect(built.output).toContain("ok phone app: web/screens/GarageApp.nexus, registered by Nexus.app('phone', { ... })");
      expect(built.status).toBe(0);
      expect(read('garage', 'nexus/screens.lua')).toContain("surface = 'phone'");
      expect(existsSync(workPath('garage', 'web/dist/app-icon.svg'))).toBe(true);
      const checked = nexus('garage', 'check');
      expect(checked.output).toContain('ok 6 components checked, no errors.');
      expect(checked.status).toBe(0);
      // The example ships its generated types, so that an editor has them before the first build.
      expect(readFileSync(join(REPO, 'examples/garage/web/nexus-contract.d.ts'), 'utf8')).toBe(read('garage', 'web/nexus-contract.d.ts'));
    });

    it('sells a vehicle once, to a player who can pay, and its answers match the contract', async () => {
      const lua = await Lua.create({ fivem: true });
      // With nexus_dev on, the server runtime checks every answer against the contract.
      await lua.convar('nexus_dev', 1);
      for (const file of ['config.lua', 'nexus/contract.lua', 'nexus/server.lua', 'server/main.lua']) await lua.run(read('garage', file));

      const ask = async (id: number, name: string, data?: unknown): Promise<unknown[]> => {
        await lua.trigger('demo:nexus:call', 7, id, name, ...(data === undefined ? [] : [data]));
        const log = await lua.drain();
        // A handler that failed or answered outside the contract would be logged as such.
        expect(log.filter((entry) => entry.kind === 'error' || (entry.kind === 'print' && /failed|does not match/.test(entry.text)))).toEqual([]);
        const answer = log.find((entry) => entry.kind === 'clientEvent');
        return answer?.kind === 'clientEvent' ? answer.args.slice(1) : [];
      };

      const [ok, garage] = (await ask(1, 'garage:list')) as [boolean, { balance: number; vehicles: { model: string; owned: boolean }[] }];
      expect(ok).toBe(true);
      expect(garage.balance).toBe(60000);
      expect(garage.vehicles).toHaveLength(9);
      expect(garage.vehicles.every((vehicle) => !vehicle.owned)).toBe(true);

      expect(await ask(2, 'garage:buy', { model: 'sultan' })).toEqual([true, { balance: 32000 }]);
      expect((await ask(3, 'garage:buy', { model: 'sultan' })).slice(0, 2)).toEqual([false, 'already_owned']);
      // The refusal says how much is missing, as the call declares under errors.
      expect(await ask(4, 'garage:buy', { model: 'zentorno' })).toEqual([false, 'not_enough_money', null, { missing: 153000 }]);
      expect((await ask(5, 'garage:buy', { model: 'adder' })).slice(0, 2)).toEqual([false, 'unknown_vehicle']);
      await lua.tick(10000);
      expect((await ask(6, 'garage:buy', { model: 'Sultan; DROP' })).slice(0, 3)).toEqual([false, 'invalid', 'model: expected text matching ^[a-z0-9_]+$']);
      expect((await ask(7, 'garage:buy', { model: 'sultan', price: 1 })).slice(0, 3)).toEqual([false, 'invalid', 'unknown key "price"']);

      const [, after] = (await ask(8, 'garage:list')) as [boolean, { balance: number; vehicles: { model: string; owned: boolean }[] }];
      expect(after.balance).toBe(32000);
      expect(after.vehicles.filter((vehicle) => vehicle.owned).map((vehicle) => vehicle.model)).toEqual(['sultan']);

      await lua.run(`Sim.command('garagedemo_give', 0, '7', '500')`);
      expect(await lua.drain()).toEqual([
        { kind: 'clientEvent', name: 'demo:nexus:push', target: 7, args: ['garage:balance', { balance: 32500 }] },
        { kind: 'print', text: 'Player 7 now has $32500.' },
      ]);
      lua.close();
    });
  });

  describe('the world example', () => {
    beforeAll(() => copyProject('examples/world', 'world'));

    const DISPLAY = { surface: 'world', display: '1' };
    const HELLO = {
      address: 'https://cfx-nui-demo/web/dist/index.html',
      opened: true,
      field: { x: 0.75, y: 0.25 },
      button: { x: 0.75, y: 0.5 },
      list: { x: 0.75, y: 0.75 },
    };

    const start = async (): Promise<Lua> => {
      const lua = await Lua.create({ fivem: true });
      for (const file of ['nexus/contract.lua', 'nexus/screens.lua', 'nexus/client.lua', 'client/main.lua']) await lua.run(read('world', file));
      await lua.post({ t: 'ready' });
      await lua.run(`Sim.command('worldtest', 0)`);
      await lua.tick(50, 2);
      return lua;
    };

    const printed = (log: LogEntry[]): string[] => log.flatMap((entry) => (entry.kind === 'print' ? [entry.text] : []));

    it('builds, names its world screen and passes nexus check', () => {
      const built = nexus('world', 'build');
      expect(built.output).toContain("ok world screen: web/screens/Proof.nexus, 1280 by 720, drawn by Nexus.world('proof', { ... })");
      expect(built.output).toContain('ok fxmanifest.lua loads the bridge and ships web/dist');
      expect(built.status).toBe(0);
      expect(read('world', 'nexus/screens.lua')).toContain("surface = 'world', width = 1280, height = 720");
      const checked = nexus('world', 'check');
      expect(checked.output).toContain('ok 1 component checked, no errors.');
      expect(checked.status).toBe(0);
      // The example ships its generated types, so that an editor has them before the first build.
      expect(readFileSync(join(REPO, 'examples/world/web/nexus-contract.d.ts'), 'utf8')).toBe(read('world', 'web/nexus-contract.d.ts'));
    });

    it('/worldtest puts a display on the prop and reports every step the page confirms', async () => {
      const lua = await start();
      const created = await lua.drain();
      expect(created.find((entry) => entry.kind === 'object')).toMatchObject({ call: 'create', model: 'prop_laptop_lester2' });
      expect(created.find((entry) => entry.kind === 'createDui')).toMatchObject({ width: 1280, height: 720 });
      expect(created.find((entry) => entry.kind === 'replaceTexture')).toMatchObject({ txd: 'prop_laptop_lester2', texture: 'script_rt_tvscreen' });

      // The test plays the page: it says it is ready and says hello, then answers what Lua does
      // to its browser the way web/screens/Proof.nexus does.
      await lua.post({ t: 'ready', ...DISPLAY });
      await lua.post({ t: 'client', name: 'worldtest:hello', data: HELLO, ...DISPLAY });
      const said: string[] = printed(created);
      const saw = (what: string): Promise<void> => lua.post({ t: 'client', name: 'worldtest:saw', data: { what, detail: 'seen' }, ...DISPLAY });
      let pointer: unknown[] = [];
      for (let frame = 0; frame < 200 && !said.some((line) => line.includes('6 LOOK')); frame++) {
        await lua.tick(50);
        for (const entry of await lua.drain()) {
          if (entry.kind === 'print') said.push(entry.text);
          else if (entry.kind === 'duiMessage' && entry.message.t === 'push') {
            await lua.post({ t: 'client', name: 'worldtest:pong', data: { nonce: (entry.message.data as { nonce: number }).nonce }, ...DISPLAY });
          } else if (entry.kind === 'duiMessage' && (entry.message.t === 'type' || entry.message.t === 'key')) {
            await saw(entry.message.t === 'type' ? 'text' : 'key');
          } else if (entry.kind === 'duiMouse' && entry.event === 'move') {
            pointer = entry.args;
            await saw('pointer');
          } else if (entry.kind === 'duiMouse' && entry.event === 'up' && pointer[1] === 360) await saw('click');
          else if (entry.kind === 'duiMouse' && entry.event === 'wheel') await saw('wheel');
        }
      }

      expect(said.map((line) => line.replace(/\s+/g, ' ').split(' ').slice(0, 4).join(' '))).toEqual([
        '[worldtest] 1 PASS a',
        '[worldtest] 2 PASS the',
        '[worldtest] 3 PASS SendDuiMessage',
        '[worldtest] 5 PASS pointer',
        '[worldtest] 5 PASS text',
        '[worldtest] 5 PASS key',
        '[worldtest] 5 PASS click',
        '[worldtest] 5 PASS wheel',
        '[worldtest] 4 LOOK Lua',
        '[worldtest] 6 LOOK run',
      ]);
      expect(said[1]).toContain('from https://cfx-nui-demo/web/dist/index.html');

      await lua.run(`Sim.command('worldtest', 0, 'end')`);
      const ended = await lua.drain();
      expect(ended.filter((entry) => entry.kind !== 'print').map((entry) => entry.kind)).toEqual(['restoreTexture', 'destroyDui', 'object']);
      expect(ended.filter((entry) => entry.kind === 'error')).toEqual([]);
      lua.close();
    });

    it('/worldtest says which link is broken when the page stays silent, and when Lua does not reach it', async () => {
      const silent = await start();
      await silent.tick(500, 14);
      const quiet = printed(await silent.drain());
      expect(quiet[1]).toContain('[worldtest] 2 FAIL  the page said nothing within 6 seconds.');
      expect(quiet).toHaveLength(2);
      silent.close();

      // The page mounted on its own, without its props, and no push ever arrives in it.
      const deaf = await start();
      await deaf.post({ t: 'client', name: 'worldtest:hello', data: { ...HELLO, opened: false }, ...DISPLAY });
      await deaf.tick(500, 8);
      const lines = printed(await deaf.drain());
      expect(lines[1]).toContain('[worldtest] 2 PASS');
      expect(lines[2]).toBe('[worldtest] 3 FAIL  the page did not answer a push: SendDuiMessage did not reach it');
      deaf.close();
    });

    it('/worldtest takes any model, and refuses one the game does not have', async () => {
      const lua = await Lua.create({ fivem: true });
      for (const file of ['nexus/contract.lua', 'nexus/screens.lua', 'nexus/client.lua', 'client/main.lua']) await lua.run(read('world', file));
      await lua.run(`Sim.missingModels.prop_nope = true`);
      await lua.run(`Sim.command('worldtest', 0, 'prop_nope', 'prop_nope', 'screen')`);
      await lua.run(`Sim.command('worldtest', 0, 'prop_tv_flat_01')`);
      await lua.tick(50, 2);
      expect(printed(await lua.drain())).toEqual([
        '[worldtest] 1 FAIL  usage: /worldtest [laptop|atm], or /worldtest <model> <txd> <texture>',
        "[worldtest] 1 FAIL  the game has no model 'prop_nope'",
      ]);
      await lua.run(`Sim.command('worldtest', 0, 'prop_tv_flat_01', 'prop_tv_flat_01', 'script_rt_tvscreen')`);
      await lua.tick(50, 2);
      expect((await lua.drain()).find((entry) => entry.kind === 'replaceTexture')).toMatchObject({ txd: 'prop_tv_flat_01', texture: 'script_rt_tvscreen' });
      lua.close();
    });

    describe.skipIf(!CHROMIUM)('under nexus dev in Chromium 103 (set NEXUS_CHROMIUM_103 to run)', () => {
      let server: ChildProcess;
      let browser: Browser;
      let page: Page;
      // What the mock host and the page complain about, such as a message outside the contract.
      const complaints: string[] = [];

      beforeAll(async () => {
        server = startNexus('world', 'dev', '--port', '5393');
        await waitForOutput(server, 'is running at');
        browser = await chromium.launch({ executablePath: CHROMIUM as string });
        page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        page.on('console', (message) => {
          if (message.type() === 'warning' || message.type() === 'error') complaints.push(message.text());
        });
        await page.goto('http://localhost:5393/');
        await page.locator('[data-nexus-dev] button', { hasText: 'proof' }).click();
      }, 60000);

      afterAll(async () => {
        await browser?.close();
        if (server) await stop(server);
      });

      const frame = () => page.frameLocator('[data-nexus-dev] iframe');

      it('shows the world screen in a frame of its size, opened with the props of the mock', async () => {
        await frame().locator('.proof h1').waitFor();
        const iframe = page.locator('[data-nexus-dev] iframe');
        expect([await iframe.getAttribute('width'), await iframe.getAttribute('height')]).toEqual(['1280', '720']);
        expect(await iframe.getAttribute('src')).toBe('/?surface=world&screen=proof&display=proof&resource=world');
        expect(await frame().locator('header p').textContent()).toBe('prop_laptop_lester2 · prop_laptop_lester2 / script_rt_tvscreen');
        expect(await page.locator('[data-nexus-dev] button', { hasText: 'proof' }).getAttribute('aria-pressed')).toBe('true');
        // The page of the resource itself shows nothing: a world screen is not one of its screens.
        expect(await page.locator('[data-screen]').count()).toBe(0);
      });

      it('answers its call and sends it the state, as the display of the game would get them', async () => {
        await frame().locator('dd', { hasText: /^\d\d:\d\d:\d\d$/ }).waitFor();
        expect(await frame().locator('.steps li', { hasText: 'Lua reached the page' }).getAttribute('class')).toContain('pass');
      });

      it('draws the cursor of the display under the mouse', async () => {
        const field = frame().locator('input');
        await field.hover();
        await frame().locator('[data-nexus-cursor]').waitFor({ state: 'visible' });
        expect(await frame().locator('.steps li', { hasText: 'The pointer moved' }).getAttribute('class')).toContain('pass');
      });

      it('sends the keyboard as type and key messages, so that typing takes the path it takes in game', async () => {
        const field = frame().locator('input');
        await field.click();
        // Only the events the page makes out of the messages reach it. The real ones stop at the frame.
        await field.evaluate(() => {
          const seen: boolean[] = [];
          Object.assign(window, { trusted: seen });
          addEventListener('keydown', (event) => seen.push(event.isTrusted));
        });
        await page.keyboard.type('nexus');
        await frame().locator('.steps li.pass', { hasText: 'Text was typed' }).waitFor();
        expect(await field.inputValue()).toBe('nexus');
        await page.keyboard.press('Backspace');
        await frame().locator('.steps li.pass', { hasText: 'A key was pressed' }).waitFor();
        expect(await field.inputValue()).toBe('nexu');
        expect(await field.evaluate(() => (window as unknown as { trusted: boolean[] }).trusted)).toEqual([false, false, false, false, false, false]);
        expect(await field.getAttribute('data-nexus-focus')).toBe('');
      });

      it('takes a click and the wheel, and closes the display with the button', async () => {
        await frame().locator('button').click();
        await frame().locator('.steps li.pass', { hasText: 'A click arrived' }).waitFor();
        await frame().locator('.list').hover();
        await page.mouse.wheel(0, 100);
        await frame().locator('.steps li.pass', { hasText: 'The wheel turned' }).waitFor();
        // Every message of the page passed the contract, the places it reports to Lua included.
        expect(complaints).toEqual([]);

        await page.locator('[data-nexus-dev] button', { hasText: 'proof' }).click();
        await page.locator('[data-nexus-dev] iframe').waitFor({ state: 'detached' });
      });
    });
  });
});
