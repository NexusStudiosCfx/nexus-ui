#!/usr/bin/env node
import { build } from './build';
import { check } from './check';
import { create } from './create';
import { dev } from './dev';
import { CliError } from './errors';
import { log } from './log';
import { packageVersion } from './project';

const HELP = `nexus <command>

  create <name>    Start a new resource in the folder <name>
  dev              Work on the UI in a browser, with a mock in place of the game
  dev --game       Serve the UI to the game with hot reload (changes ui_page until you stop)
  build            Build web/dist and the Lua bridge in nexus/, and check fxmanifest.lua
  check            Type-check the components and the contract, and report what Chromium 103 cannot run

Options
  dev --port <n>   Port of the dev server (default 5173)
  --help           Show this text
  --version        Show the version

Run dev, build and check in the folder of the resource, next to fxmanifest.lua.
`;

const COMMANDS: Record<string, (argv: readonly string[], cwd: string) => void | Promise<void>> = { create, dev, build, check };

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    log.info(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    log.info(packageVersion());
    return;
  }
  const run = COMMANDS[command];
  if (!run) {
    throw new CliError(`nexus has no command "${command}".`, `The commands are: ${Object.keys(COMMANDS).join(', ')}. Run nexus --help for what each does.`);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    log.info(HELP);
    return;
  }
  await run(rest, process.cwd());
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliError) log.error(error.message, error.hint);
  else console.error(error);
  process.exitCode = 1;
});
