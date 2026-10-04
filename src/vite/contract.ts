import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerImport } from 'vite';

/** What the plugin needs from the contract module of this package. */
interface ContractTools {
  isContract(value: unknown): boolean;
  generateTypes(contract: never, options?: { source?: string; module?: string }): string;
}

export interface PackagePaths {
  /** The module `nexus` stands for. */
  runtime: string;
  /** The module `nexus/contract` stands for. */
  contract: string;
  /** True when the plugin runs from the TypeScript sources of this package, as its tests do. */
  fromSource: boolean;
}

/** Locates the runtime and contract modules of the package this plugin belongs to. */
export function packagePaths(): PackagePaths {
  let folder = dirname(fileURLToPath(import.meta.url));
  const fromSource = /[\\/]src[\\/]vite$/.test(folder);
  while (!existsSync(join(folder, 'package.json'))) folder = dirname(folder);
  return fromSource
    ? { runtime: join(folder, 'src/runtime/index.ts'), contract: join(folder, 'src/contract/index.ts'), fromSource }
    : { runtime: join(folder, 'dist/runtime/index.js'), contract: join(folder, 'dist/contract/index.js'), fromSource };
}

/**
 * Writes `nexus-contract.d.ts` next to `contract.ts`: the declarations that make `nui.call`,
 * `nui.on`, `nui.client` and `nui.state` checked against the contract. Returns the reason when
 * the contract cannot be loaded, and null when there is nothing to report.
 */
export async function writeContractTypes(web: string, paths: PackagePaths): Promise<string | null> {
  const file = join(web, 'contract.ts');
  if (!existsSync(file)) return null;

  try {
    const tools = (await import(pathToFileURL(paths.contract).href)) as ContractTools;
    // The contract is TypeScript and imports `nexus/contract`, so Vite's module runner loads it.
    // No config file: loading the project's own would start this plugin again.
    const { module } = await runnerImport<{ default?: unknown }>(pathToFileURL(file).href, {
      root: web,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { 'nexus/contract': paths.contract, '@nexusstudios/ui/contract': paths.contract } },
    });
    if (!tools.isContract(module.default)) return 'contract.ts has no contract as its default export.';

    const types = tools.generateTypes(module.default as never, { source: 'web/contract.ts' });
    const target = join(web, 'nexus-contract.d.ts');
    if (!existsSync(target) || readFileSync(target, 'utf8') !== types) writeFileSync(target, types);
    return null;
  } catch (error) {
    return `contract.ts could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
  }
}
