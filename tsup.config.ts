import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'runtime/index': 'src/runtime/index.ts',
    // What a page loads for world screens, and only then. See src/runtime/world.ts.
    'runtime/world': 'src/runtime/world.ts',
    'compiler/index': 'src/compiler/index.ts',
    'vite/index': 'src/vite/index.ts',
    'contract/index': 'src/contract/index.ts',
    'cli/index': 'src/cli/index.ts',
    // The mock host that `nexus dev` serves to the browser.
    'cli/host': 'src/cli/host/index.ts',
  },
  format: 'esm',
  target: 'es2020',
  // Declarations come from `tsc -p tsconfig.build.json`: tsup's own generator needs the
  // JavaScript API of TypeScript, which TypeScript 7 no longer has.
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
  external: ['vite', 'esbuild'],
});
