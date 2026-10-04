// Runs the nexus command line in this process and interrupts it once it is up, the way Ctrl+C
// does. A signal sent from another process cannot stand in for that on Windows, where it ends
// the target at once without running its handlers.
//
// usage: node interrupt.mjs <path to dist/cli/index.js> <arguments of nexus>

import { pathToFileURL } from 'node:url';

const [cli, ...args] = process.argv.slice(2);
process.argv = [process.argv[0], cli, ...args];

const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (String(chunk).includes('Press Ctrl+C to stop.')) setTimeout(() => process.emit('SIGINT'), 200);
  return write(chunk, ...rest);
};

await import(pathToFileURL(cli).href);
