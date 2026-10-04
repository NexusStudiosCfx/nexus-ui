import { join } from 'node:path';
import { formatDiagnostic } from '../compiler/diagnostics';
import { parseArgs } from './args';
import { BRIDGE_FILES, indent, readManifest, writeBridge } from './bridge';
import { CliError } from './errors';
import { color, log } from './log';
import { checkManifest } from './manifest';
import { display, findProject, listFiles, loadContract } from './project';
import { readSources } from './sources';
import { checkSurfaces, findApps } from './surfaces';

/**
 * `nexus build`: the production page in `web/dist`, the Lua bridge in `nexus/`, and a check that
 * the manifest ships both.
 */
export async function build(argv: readonly string[], cwd: string): Promise<void> {
  parseArgs(argv, 'build', {});
  const project = findProject(cwd);
  const manifest = readManifest(project);

  const contract = await loadContract(project);
  const sources = readSources(project);

  const found = [...sources.diagnostics, ...checkSurfaces(project, sources, contract)];
  const errors = found.filter((diagnostic) => diagnostic.severity === 'error');
  for (const diagnostic of found) {
    const label = diagnostic.severity === 'error' ? color.red('error') : color.yellow('warning');
    process.stdout.write(`${label} ${formatDiagnostic(diagnostic)}\n`);
  }
  if (errors.length > 0) {
    throw new CliError(`The build stopped: ${errors.length === 1 ? 'one component has an error' : `${errors.length} errors in the components`}.`);
  }
  if (sources.screens.length === 0) {
    throw new CliError(
      'There is no screen to build: web/screens has no .nexus file.',
      'Add one, for example web/screens/Main.nexus. Lua opens it with Nexus.open(\'main\').',
    );
  }

  const vite = await import('vite');
  try {
    await vite.build({ root: project.root, logLevel: 'warn' });
  } catch (error) {
    // Vite and the plugin have already printed what went wrong, with the file and a code frame.
    throw new CliError(`The page could not be built: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  const built = listFiles(join(project.web, 'dist'), () => true).map((file) => display(project, file));
  log.step(`web/dist (${built.length} ${built.length === 1 ? 'file' : 'files'})`);

  writeBridge(project, contract, sources.screens);
  log.step(BRIDGE_FILES.join(', '));
  for (const app of findApps(sources)) {
    log.step(`${app.surface} app: ${app.file}, registered by Nexus.app('${app.surface}', { ... })`);
  }

  const report = checkManifest(manifest, built);
  if (report.problems.length > 0) {
    throw new CliError(
      `fxmanifest.lua is not ready for this build:\n${report.problems.map((problem) => `  - ${problem}`).join('\n')}`,
      `Add these lines to fxmanifest.lua:\n\n${indent(report.lines.join('\n'))}`,
    );
  }
  log.step('fxmanifest.lua loads the bridge and ships web/dist');
}
