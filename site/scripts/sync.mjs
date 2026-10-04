import { syncDocs } from './sync-docs.mjs';
import { syncPlayground } from './sync-playground.mjs';

console.log(`docs: wrote ${syncDocs()}`);
console.log(`playground: copied ${syncPlayground()}`);
