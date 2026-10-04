import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const file = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The page of `npm run dev` is index.html. A build ships the same page as a demo next to the
 * module, importing the built file instead of the source.
 */
function demoPage(): Plugin {
  return {
    name: 'playground-demo-page',
    apply: 'build',
    generateBundle() {
      const source = readFileSync(file('./index.html'), 'utf8').replace('/src/index.ts', './playground.js');
      this.emitFile({ type: 'asset', fileName: 'index.html', source });
    },
  };
}

export default defineConfig({
  // Every address in the output is relative, so dist/ works from any folder of any site.
  base: './',
  plugins: [demoPage()],
  resolve: {
    // The compiler asks Vite for its parser, which is native code. The browser gets this one.
    alias: [{ find: /^vite$/, replacement: file('./src/engine/parser.ts') }],
    // The framework's sources sit outside this project: their dependencies are taken from here.
    dedupe: ['magic-string', '@preact/signals-core'],
  },
  server: { port: 4331, strictPort: true, fs: { allow: ['../..'] } },
  preview: { port: 4331, strictPort: true },
  build: {
    target: 'chrome103',
    cssTarget: 'chrome103',
    modulePreload: false,
    rollupOptions: {
      input: file('./src/index.ts'),
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: 'playground.js',
        assetFileNames: (asset) => (asset.names.includes('styles.css') ? 'playground.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
