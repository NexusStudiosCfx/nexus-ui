import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract } from '../contract';
import type { Diagnostic } from '../compiler';
import { formatDiagnostic, toDiagnostic } from '../compiler/diagnostics';
import { parseArgs } from './args';
import { writeContractTypes } from './bridge';
import { typeCheck } from './check/typecheck';
import { CliError } from './errors';
import { color, log } from './log';
import { display, findProject, loadContract } from './project';
import { plainFileDiagnostics, readSources } from './sources';
import { checkSurfaces } from './surfaces';

/**
 * `nexus check`: everything that can be known to be wrong without running the resource. It
 * prints every problem and fails when at least one of them is an error.
 */
export async function check(argv: readonly string[], cwd: string): Promise<void> {
  parseArgs(argv, 'check', {});
  const project = findProject(cwd);
  let errors = 0;
  let warnings = 0;

  const report = (diagnostic: Diagnostic): void => {
    if (diagnostic.severity === 'error') errors++;
    else warnings++;
    const label = diagnostic.severity === 'error' ? color.red('error') : color.yellow('warning');
    process.stdout.write(`${label} ${formatDiagnostic(diagnostic)}\n`);
  };

  let contract: Contract | null = null;
  try {
    contract = await loadContract(project);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    errors++;
    log.error(error.message, error.hint);
  }

  const sources = readSources(project);
  const found = [...sources.diagnostics, ...checkSurfaces(project, sources, contract)];

  // Types are only checked against a contract that loaded: without one every nui call would
  // be reported as well, burying the real problem.
  let modules: string[] | undefined;
  const typeProblems: Diagnostic[] = [];
  if (contract) {
    writeContractTypes(project, contract);
    const declared = contract.screens;
    const typed = new Map(
      sources.screens
        .filter((screen) => Object.prototype.hasOwnProperty.call(declared, screen.name))
        .map((screen) => [join(project.root, screen.file), screen.name] as const),
    );
    const result = typeCheck(project, sources.components, typed);
    modules = result.files;
    const texts = new Map(sources.components.map((component) => [component.file, component.source]));
    for (const problem of result.problems) {
      const source = texts.get(problem.file) ?? readFileSync(problem.file, 'utf8');
      typeProblems.push(toDiagnostic(source, display(project, problem.file), 'error', { code: problem.code, message: problem.message, start: problem.start }));
    }
  }

  // The modules TypeScript looked at are the ones the project's tsconfig.json includes, which
  // leaves out what it excludes, such as scripts that run in Node.
  found.push(...plainFileDiagnostics(project, modules));
  found.forEach(report);

  for (const problem of typeProblems) {
    // A built-in that Chromium 103 lacks has been reported above, with what to use instead.
    const known =
      problem.code === 'TS2550' && found.some((item) => item.filename === problem.filename && problem.start >= item.start && problem.start <= item.end);
    if (!known) report(problem);
  }

  const count = (amount: number, noun: string): string => `${amount} ${noun}${amount === 1 ? '' : 's'}`;
  if (errors > 0) {
    throw new CliError(`nexus check found ${count(errors, 'error')}${warnings > 0 ? ` and ${count(warnings, 'warning')}` : ''}.`);
  }
  log.step(
    `${count(sources.components.length, 'component')} checked, no errors${warnings > 0 ? `, ${count(warnings, 'warning')}` : ''}.`,
  );
}
