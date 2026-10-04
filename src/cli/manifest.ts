/**
 * Reading and checking `fxmanifest.lua`. The manifest is Lua, but in practice it is a list of
 * `key 'value'` and `key { 'a', 'b' }` statements, which is all this reads. Anything more
 * dynamic is left alone and simply not seen.
 */

export interface ManifestEntry {
  key: string;
  values: string[];
  /** Offsets of the whole statement in the file. */
  start: number;
  end: number;
}

interface Token {
  type: 'name' | 'string' | 'punctuation';
  value: string;
  start: number;
  end: number;
}

function longBracket(text: string, at: number): number | null {
  const match = /^\[(=*)\[/.exec(text.slice(at, at + 16));
  if (!match) return null;
  const close = text.indexOf(`]${match[1]}]`, at + match[0].length);
  return close === -1 ? text.length : close + match[0].length;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] as string;
    if (char === '-' && text[at + 1] === '-') {
      const end = longBracket(text, at + 2);
      if (end !== null) at = end;
      else {
        const newline = text.indexOf('\n', at);
        at = newline === -1 ? text.length : newline;
      }
    } else if (char === '"' || char === "'") {
      let end = at + 1;
      let value = '';
      while (end < text.length && text[end] !== char && text[end] !== '\n') {
        if (text[end] === '\\') end++;
        value += text[end] ?? '';
        end++;
      }
      tokens.push({ type: 'string', value, start: at, end: end + 1 });
      at = end + 1;
    } else if (char === '[' && longBracket(text, at) !== null) {
      const end = longBracket(text, at) as number;
      const open = text.indexOf('[', at + 1) + 1;
      tokens.push({ type: 'string', value: text.slice(open, end - (open - at)), start: at, end });
      at = end;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z0-9_]+/.exec(text.slice(at)) as RegExpExecArray;
      tokens.push({ type: 'name', value: match[0], start: at, end: at + match[0].length });
      at += match[0].length;
    } else {
      if (!/\s/.test(char)) tokens.push({ type: 'punctuation', value: char, start: at, end: at + 1 });
      at++;
    }
  }
  return tokens;
}

export function parseManifest(text: string): ManifestEntry[] {
  const tokens = tokenize(text);
  const entries: ManifestEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const name = tokens[i] as Token;
    i++;
    if (name.type !== 'name') continue;
    let next = tokens[i];
    if (next?.value === '(' && next.type === 'punctuation') next = tokens[++i];
    if (!next) break;
    if (next.type === 'string') {
      entries.push({ key: name.value, values: [next.value], start: name.start, end: next.end });
      i++;
    } else if (next.type === 'punctuation' && next.value === '{') {
      const values: string[] = [];
      let depth = 0;
      let end = next.end;
      for (; i < tokens.length; i++) {
        const token = tokens[i] as Token;
        end = token.end;
        if (token.type === 'punctuation' && token.value === '{') depth++;
        else if (token.type === 'punctuation' && token.value === '}') {
          depth--;
          if (depth === 0) break;
        } else if (token.type === 'string' && depth === 1) values.push(token.value);
      }
      entries.push({ key: name.value, values, start: name.start, end });
      i++;
    }
  }
  return entries;
}

/** Whether a manifest glob covers a path. `*` stays inside one folder, `**` crosses folders. */
export function globMatches(pattern: string, path: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === path;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(path);
}

const CLIENT_KEYS = ['client_script', 'client_scripts', 'shared_script', 'shared_scripts'];
const SERVER_KEYS = ['server_script', 'server_scripts', 'shared_script', 'shared_scripts'];
const FILE_KEYS = ['file', 'files'];

/**
 * Where a file sits in a script list, as a sortable number, or null when nothing loads it.
 * Within one glob FiveM loads matches in alphabetical order.
 */
function loadPosition(entries: ManifestEntry[], keys: string[], path: string, siblings: string[]): number | null {
  let position = 0;
  for (const entry of entries) {
    if (!keys.includes(entry.key)) continue;
    for (const pattern of entry.values) {
      if (globMatches(pattern, path)) {
        const earlier = siblings.filter((other) => other < path && globMatches(pattern, other)).length;
        return position + earlier / (siblings.length + 1);
      }
      position++;
    }
  }
  return null;
}

export const UI_PAGE = 'web/dist/index.html';

const BRIDGE = ['nexus/client.lua', 'nexus/contract.lua', 'nexus/screens.lua', 'nexus/server.lua'];

const LINES = {
  lua54: "lua54 'yes'",
  page: `ui_page '${UI_PAGE}'`,
  files: `files { '${UI_PAGE}', 'web/dist/**/*' }`,
  shared: "shared_scripts { 'nexus/contract.lua' }",
  client: "client_scripts { 'nexus/screens.lua', 'nexus/client.lua' }",
  server: "server_scripts { 'nexus/server.lua' }",
};

/** The smallest manifest that runs a Nexus UI resource. */
export const MINIMAL_MANIFEST = ["fx_version 'cerulean'", "game 'gta5'", ...Object.values(LINES)].join('\n');

export interface ManifestReport {
  /** What is wrong, one sentence each. Empty when the manifest is ready. */
  problems: string[];
  /** The exact lines that fix every problem. */
  lines: string[];
}

/**
 * Checks that a manifest loads the generated Lua in a working order and ships the built page.
 * `built` lists the files in `web/dist`, relative to the resource.
 */
export function checkManifest(text: string, built: readonly string[]): ManifestReport {
  const entries = parseManifest(text);
  const problems: string[] = [];
  const lines: string[] = [];
  const need = (line: string, problem: string): void => {
    problems.push(problem);
    lines.push(line);
  };

  if (!entries.some((entry) => entry.key === 'lua54' && entry.values[0] === 'yes')) {
    need(LINES.lua54, 'The bridge needs Lua 5.4.');
  }

  const page = entries.filter((entry) => entry.key === 'ui_page').pop()?.values[0];
  if (page !== UI_PAGE) {
    need(LINES.page, page === undefined ? 'There is no ui_page.' : `ui_page is '${page}'.`);
  }

  const shipped = (path: string): boolean =>
    entries.some((entry) => FILE_KEYS.includes(entry.key) && entry.values.some((pattern) => globMatches(pattern, path)));
  const missing = [...new Set([UI_PAGE, ...built])].filter((path) => !shipped(path));
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(', ') + (missing.length > 3 ? ` and ${missing.length - 3} more` : '');
    need(LINES.files, `files does not include ${sample}.`);
  }

  const onClient = (path: string): number | null => loadPosition(entries, CLIENT_KEYS, path, BRIDGE);
  const onServer = (path: string): number | null => loadPosition(entries, SERVER_KEYS, path, BRIDGE);
  /** Whether `first` is loaded, and before `second` when that one is loaded too. */
  const leads = (first: number | null, second: number | null): boolean => first !== null && (second === null || first < second);

  if (onServer('nexus/client.lua') !== null || onServer('nexus/screens.lua') !== null || onClient('nexus/server.lua') !== null) {
    problems.push('A script list loads nexus/*.lua on the wrong side, probably through a glob. List the files one by one.');
  }
  if (
    !leads(onClient('nexus/contract.lua'), onClient('nexus/client.lua')) ||
    !leads(onServer('nexus/contract.lua'), onServer('nexus/server.lua'))
  ) {
    need(LINES.shared, 'nexus/contract.lua must load on both sides, before nexus/client.lua and nexus/server.lua.');
  }
  if (onClient('nexus/client.lua') === null || !leads(onClient('nexus/screens.lua'), onClient('nexus/client.lua'))) {
    need(LINES.client, 'nexus/screens.lua and then nexus/client.lua must load on the client, before your own client scripts.');
  }
  if (onServer('nexus/server.lua') === null) {
    need(LINES.server, 'nexus/server.lua must load on the server, before your own server scripts.');
  }

  return { problems, lines };
}

const DEV_MARK = '-- nexus dev: restore';

/**
 * Points `ui_page` at the dev server. The original value is kept in a comment on the same
 * line, so it can be put back even if the process was killed before it could do so itself.
 */
export function useDevPage(text: string, url: string): string | null {
  const restored = restorePage(text);
  const entry = parseManifest(restored).filter((item) => item.key === 'ui_page').pop();
  if (!entry) return null;
  const lineEnd = restored.indexOf('\n', entry.end);
  const rest = restored.slice(entry.end, lineEnd === -1 ? restored.length : lineEnd).replace(/\r$/, '');
  const statement = restored.slice(entry.start, entry.end);
  // The original has to fit in a line comment.
  const original = statement.includes('\n') ? `ui_page '${entry.values[0]}'` : statement + rest;
  return `${restored.slice(0, entry.start)}ui_page '${url}' ${DEV_MARK} ${original}${restored.slice(entry.end + rest.length)}`;
}

/** Undoes `useDevPage`. A manifest that was not changed comes back as it is. */
export function restorePage(text: string): string {
  return text.replace(new RegExp(`^([ \\t]*)ui_page[^\\n]*?${DEV_MARK} ([^\\r\\n]*)`, 'm'), '$1$2');
}
