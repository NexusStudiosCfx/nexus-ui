// Starts a command behind a chain of processes, the way `npm run dev` puts a shell and npm
// between the terminal and the dev server. A test ends the first link and looks at what the
// last one does.
//
// usage: node chain.mjs <links> <command> <arguments>

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [links, command, ...args] = process.argv.slice(2);
const next = Number(links) > 1 ? [fileURLToPath(import.meta.url), String(Number(links) - 1), command, ...args] : [command, ...args];

const child = spawn(process.execPath, next, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
