#!/usr/bin/env node
// `npm create nexus-ui my_shop` runs this file. It is `nexus create my_shop` from the newest
// @nexusstudios/ui, so a new resource never starts from an old template.
process.argv.splice(2, 0, 'create');
await import('@nexusstudios/ui/cli');
