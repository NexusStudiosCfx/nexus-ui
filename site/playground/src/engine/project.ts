/** The files of a sandbox project by name. Names are flat: there are no folders. */
export type Files = Record<string, string>;

/** The screen the preview opens. */
export const ENTRY = 'Main.nexus';
export const CONTRACT = 'contract.ts';
export const MOCK = 'mock.ts';

export const MAX_FILES = 12;
export const MAX_FILE_SIZE = 64 * 1024;

export type FileKind = 'component' | 'script' | 'data';

export function kindOf(name: string): FileKind | null {
  if (/^[A-Z][A-Za-z0-9]*\.nexus$/.test(name)) return 'component';
  if (/^[A-Za-z][\w-]*\.ts$/.test(name)) return 'script';
  if (/^[A-Za-z][\w-]*\.json$/.test(name)) return 'data';
  return null;
}

const RANK: Record<FileKind, number> = { component: 0, script: 1, data: 2 };
const FIXED = [ENTRY, CONTRACT, MOCK];

/** The order of the tabs: the screen, its components, the contract, the mock, then the rest. */
export function ordered(files: Files): string[] {
  const rank = (name: string): number => {
    if (name === ENTRY) return 0;
    const fixed = FIXED.indexOf(name);
    return (RANK[kindOf(name) as FileKind] + 1) * 10 + (fixed === -1 ? 5 : fixed);
  };
  return Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Keeps what a project can hold out of an untrusted value, such as the content of a shared
 * link: files with a known kind of name and text of a bounded size. Returns null when the
 * screen is missing.
 */
export function sanitise(value: unknown): Files | null {
  if (typeof value !== 'object' || value === null) return null;
  const files: Files = {};
  for (const [name, text] of Object.entries(value)) {
    if (Object.keys(files).length >= MAX_FILES) break;
    if (kindOf(name) && typeof text === 'string' && text.length <= MAX_FILE_SIZE) files[name] = text;
  }
  return typeof files[ENTRY] === 'string' ? files : null;
}

/**
 * The file an import names. `./Card.nexus` and `../components/Card.nexus` are both `Card.nexus`,
 * and `./contract` is `contract.ts`. The runtime and the contract library keep their own names.
 */
export function resolveImport(specifier: string, files: Files): string | null {
  if (specifier === 'nexus' || specifier === 'nexus-ui') return 'nexus';
  if (specifier === 'nexus/contract' || specifier === 'nexus-ui/contract') return 'nexus/contract';
  if (!specifier.startsWith('.')) return null;
  const base = specifier.slice(specifier.lastIndexOf('/') + 1);
  for (const candidate of [base, `${base}.ts`]) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
  }
  return null;
}
