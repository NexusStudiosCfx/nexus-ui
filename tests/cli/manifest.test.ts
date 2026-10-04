import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args';
import { checkManifest, globMatches, MINIMAL_MANIFEST, parseManifest, restorePage, useDevPage } from '../../src/cli/manifest';

const READY = `fx_version 'cerulean'
game 'gta5'
lua54 'yes'

ui_page 'web/dist/index.html'

files {
    'web/dist/index.html',
    'web/dist/**/*',
}

shared_scripts { 'nexus/contract.lua' }

client_scripts {
    'nexus/screens.lua',
    'nexus/client.lua',
    'client/main.lua',
}

server_scripts {
    'nexus/server.lua',
    'server/main.lua',
}
`;

const BUILT = ['web/dist/index.html', 'web/dist/assets/index-a1b2.js', 'web/dist/assets/index-c3d4.css'];

describe('parseManifest', () => {
  it('reads single values, tables and the call form with parentheses', () => {
    const entries = parseManifest(`
      fx_version 'cerulean'
      game "gta5"
      client_scripts { 'a.lua', "b.lua", }
      server_script('c.lua')
      files({ 'x.png' })
      description [[A long
      description]]
    `);
    expect(entries.map(({ key, values }) => [key, values])).toEqual([
      ['fx_version', ['cerulean']],
      ['game', ['gta5']],
      ['client_scripts', ['a.lua', 'b.lua']],
      ['server_script', ['c.lua']],
      ['files', ['x.png']],
      ['description', ['A long\n      description']],
    ]);
  });

  it('ignores comments', () => {
    const entries = parseManifest(`
      -- client_script 'old.lua'
      --[[ server_script 'older.lua'
           files { 'gone' } ]]
      client_script 'new.lua' -- ui_page 'nope.html'
    `);
    expect(entries.map(({ key, values }) => [key, values])).toEqual([['client_script', ['new.lua']]]);
  });
});

describe('globMatches', () => {
  it.each([
    ['web/dist/index.html', 'web/dist/index.html', true],
    ['web/dist/*', 'web/dist/index.html', true],
    ['web/dist/*', 'web/dist/assets/a.js', false],
    ['web/dist/**/*', 'web/dist/assets/a.js', true],
    ['web/dist/**/*', 'web/dist/index.html', true],
    ['web/dist/**', 'web/dist/assets/deep/a.js', true],
    ['nexus/*.lua', 'nexus/client.lua', true],
    ['nexus/*.lua', 'nexus/client.luac', false],
    ['**/*.lua', 'client/main.lua', true],
    ['web/dist/**/*.js', 'web/dist/a.css', false],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(globMatches(pattern, path)).toBe(expected);
  });
});

describe('checkManifest', () => {
  it('accepts a manifest that loads the bridge in order and ships the build', () => {
    expect(checkManifest(READY, BUILT)).toEqual({ problems: [], lines: [] });
  });

  it('accepts its own minimal manifest', () => {
    expect(checkManifest(MINIMAL_MANIFEST, BUILT).problems).toEqual([]);
  });

  it('lists every line an empty manifest is missing', () => {
    const report = checkManifest("fx_version 'cerulean'\ngame 'gta5'\n", BUILT);
    expect(report.lines).toEqual([
      "lua54 'yes'",
      "ui_page 'web/dist/index.html'",
      "files { 'web/dist/index.html', 'web/dist/**/*' }",
      "shared_scripts { 'nexus/contract.lua' }",
      "client_scripts { 'nexus/screens.lua', 'nexus/client.lua' }",
      "server_scripts { 'nexus/server.lua' }",
    ]);
    expect(report.problems).toHaveLength(6);
  });

  it('reports a ui_page that points somewhere else', () => {
    const report = checkManifest(READY.replace('web/dist/index.html', 'html/index.html'), BUILT);
    expect(report.problems).toEqual(["ui_page is 'html/index.html'."]);
    expect(report.lines).toEqual(["ui_page 'web/dist/index.html'"]);
  });

  it('reports built files that the manifest does not ship', () => {
    const report = checkManifest(READY.replace("    'web/dist/**/*',\n", ''), BUILT);
    expect(report.problems).toEqual(['files does not include web/dist/assets/index-a1b2.js, web/dist/assets/index-c3d4.css.']);
  });

  it('reports the bridge loaded after the script that needs it', () => {
    const late = READY.replace("    'nexus/screens.lua',\n    'nexus/client.lua',\n    'client/main.lua',", "    'nexus/client.lua',\n    'nexus/screens.lua',");
    expect(checkManifest(late, BUILT).problems).toEqual([
      'nexus/screens.lua and then nexus/client.lua must load on the client, before your own client scripts.',
    ]);

    const contractLast = READY.replace("shared_scripts { 'nexus/contract.lua' }\n", '') + "\nshared_scripts { 'nexus/contract.lua' }\n";
    expect(checkManifest(contractLast, BUILT).problems).toEqual([
      'nexus/contract.lua must load on both sides, before nexus/client.lua and nexus/server.lua.',
    ]);
  });

  it('reports a glob that loads the whole bridge on one side', () => {
    const globbed = `lua54 'yes'\nui_page 'web/dist/index.html'\nfiles { 'web/dist/**/*' }\nshared_scripts { 'nexus/*.lua' }\n`;
    const report = checkManifest(globbed, BUILT);
    expect(report.problems[0]).toBe('A script list loads nexus/*.lua on the wrong side, probably through a glob. List the files one by one.');
    // In a glob the files load alphabetically, which puts client.lua before the contract.
    expect(report.lines).toContain("shared_scripts { 'nexus/contract.lua' }");
  });

  it('needs Lua 5.4', () => {
    expect(checkManifest(READY.replace("lua54 'yes'\n", ''), BUILT)).toEqual({ problems: ['The bridge needs Lua 5.4.'], lines: ["lua54 'yes'"] });
  });
});

describe('the dev ui_page', () => {
  it('replaces ui_page and restores the original line exactly', () => {
    const original = READY.replace("ui_page 'web/dist/index.html'", "ui_page 'web/dist/index.html' -- the page");
    const patched = useDevPage(original, 'http://localhost:5173/') as string;
    expect(patched).toContain("ui_page 'http://localhost:5173/' -- nexus dev: restore ui_page 'web/dist/index.html' -- the page\n");
    expect(parseManifest(patched).find((entry) => entry.key === 'ui_page')?.values).toEqual(['http://localhost:5173/']);
    expect(restorePage(patched)).toBe(original);
  });

  it('keeps Windows line endings', () => {
    const original = READY.replace(/\n/g, '\r\n');
    expect(restorePage(useDevPage(original, 'http://localhost:5173/') as string)).toBe(original);
  });

  it('does not stack when it is applied twice', () => {
    const once = useDevPage(READY, 'http://localhost:5173/') as string;
    const twice = useDevPage(once, 'http://localhost:5174/') as string;
    expect(twice).toContain("ui_page 'http://localhost:5174/' -- nexus dev: restore ui_page 'web/dist/index.html'\n");
    expect(restorePage(twice)).toBe(READY);
  });

  it('returns null when there is no ui_page to replace', () => {
    expect(useDevPage("fx_version 'cerulean'\n", 'http://localhost:5173/')).toBeNull();
  });

  it('leaves an untouched manifest as it is', () => {
    expect(restorePage(READY)).toBe(READY);
  });
});

describe('parseArgs', () => {
  const spec = { game: {}, port: { value: true } };

  it('separates positional arguments from flags', () => {
    expect(parseArgs(['my_shop', '--game', '--port', '3000'], 'dev', spec)).toEqual({ positional: ['my_shop'], flags: { game: true, port: '3000' } });
    expect(parseArgs(['--port=3000'], 'dev', spec).flags).toEqual({ port: '3000' });
  });

  it('refuses a flag the command does not have, and names the ones it has', () => {
    expect(() => parseArgs(['--gaem'], 'dev', spec)).toThrow('nexus dev has no option --gaem.');
    try {
      parseArgs(['--gaem'], 'dev', spec);
    } catch (error) {
      expect((error as { hint?: string }).hint).toBe('Its options are: --game, --port.');
    }
    expect(() => parseArgs(['--watch'], 'build', {})).toThrow('nexus build has no option --watch.');
  });

  it('refuses a missing or a surplus value', () => {
    expect(() => parseArgs(['--port'], 'dev', spec)).toThrow('--port needs a value.');
    expect(() => parseArgs(['--port', '--game'], 'dev', spec)).toThrow('--port needs a value.');
    expect(() => parseArgs(['--game=yes'], 'dev', spec)).toThrow('--game does not take a value.');
  });
});
