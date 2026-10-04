import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const file = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Writes the script of the frame into its page. The frame has no origin, so a script file
 * would be a cross-origin one to it: the browser would hide its errors from the page, and with
 * them every error of the code the frame runs. An inline script has no such limit.
 */
function framePage(): Plugin {
  return {
    name: 'playground-frame-page',
    generateBundle(_options, bundle) {
      const page = readFileSync(file('./src/frame/frame.html'), 'utf8');
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue;
        if (chunk.code.includes('<!--')) this.error('The script of the frame contains "<!--", which cannot stand inside a script element.');
        // The end tag of a script inside the script would end it early.
        const code = chunk.code.replace(/<\/(script)/gi, '<\\/$1');
        this.emitFile({ type: 'asset', fileName: 'frame.html', source: page.replace('<script></script>', () => `<script>${code}</script>`) });
        delete bundle[name];
      }
    },
  };
}

/**
 * Builds the preview frame into public/, from where the dev server serves it and the main
 * build copies it.
 */
export default defineConfig({
  publicDir: false,
  plugins: [framePage()],
  resolve: { dedupe: ['@preact/signals-core'] },
  build: {
    target: 'chrome103',
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: file('./src/frame/main.ts'),
      formats: ['iife'],
      name: 'NexusSandboxFrame',
      fileName: () => 'frame.js',
    },
  },
});
