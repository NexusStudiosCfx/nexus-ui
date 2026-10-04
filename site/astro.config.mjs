// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import cssLanguage from 'shiki/langs/css.mjs';
import typescriptLanguage from 'shiki/langs/typescript.mjs';
import { SITE } from './site.config.mjs';
import { codeTheme } from './src/lib/code-theme.mjs';
import { PAGES, syncDocs } from './scripts/sync-docs.mjs';
import { syncPlayground } from './scripts/sync-playground.mjs';

const repoDocs = fileURLToPath(new URL('../docs', import.meta.url));
const changelog = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
const sandboxBuild = fileURLToPath(new URL('./playground/dist', import.meta.url));

/** The grammar of the VS Code extension, so that the site and the editor colour .nexus alike. */
const nexusGrammar = {
  ...JSON.parse(readFileSync(new URL('../editor/vscode/syntaxes/nexus.tmLanguage.json', import.meta.url), 'utf8')),
  name: 'nexus',
  embeddedLangs: ['typescript', 'css'],
};

/**
 * Brings in the docs of the repository and the sandbox before dev and build. Under dev it does
 * so again when a document changes or the sandbox is built anew.
 */
function sync() {
  return {
    name: 'nexus-site-sync',
    hooks: {
      'astro:config:setup': () => {
        syncDocs();
        syncPlayground();
      },
      'astro:server:setup': ({ server }) => {
        let pending;
        const again = (file) => {
          if (file.startsWith(repoDocs) || file === changelog) syncDocs();
          if (file.startsWith(sandboxBuild)) {
            // A build writes its files one after another: wait until it has gone quiet.
            clearTimeout(pending);
            pending = setTimeout(syncPlayground, 800);
          }
        };
        server.watcher.add([repoDocs, changelog, sandboxBuild]);
        server.watcher.on('add', again);
        server.watcher.on('change', again);
      },
    },
  };
}

const page = (slug) => {
  const { label } = PAGES.find((entry) => entry.slug === slug);
  return { label, slug: `docs/${slug}` };
};

export default defineConfig({
  site: SITE.origin,
  base: SITE.base || undefined,
  trailingSlash: 'always',
  // Compressing drops the space between a word and a tag that starts the next line of a paragraph.
  compressHTML: false,
  devToolbar: { enabled: false },
  integrations: [
    sync(),
    starlight({
      title: SITE.name,
      description: SITE.description,
      logo: { src: './src/assets/brand/symbol.png', alt: '' },
      favicon: '/favicon.png',
      customCss: ['@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono', './src/styles/docs.css'],
      social: [{ icon: 'github', label: 'GitHub', href: SITE.repository }],
      disable404Route: true,
      credits: false,
      lastUpdated: false,
      head: [{ tag: 'meta', attrs: { name: 'theme-color', content: '#09090b' } }],
      components: {
        Head: './src/components/starlight/Head.astro',
        SocialIcons: './src/components/starlight/SocialIcons.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
      },
      expressiveCode: {
        themes: [codeTheme],
        shiki: { langs: [...typescriptLanguage, ...cssLanguage, nexusGrammar] },
        styleOverrides: {
          borderRadius: '14px',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          codeFontFamily: "'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', Consolas, monospace",
          codeFontSize: '0.84rem',
          codeLineHeight: '1.7',
          codePaddingBlock: '1rem',
          codePaddingInline: '1.15rem',
          frames: {
            frameBoxShadowCssValue: 'none',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: '#c8ff3d',
          },
        },
      },
      sidebar: [
        { label: 'Start', items: [{ label: 'Overview', slug: 'docs' }, page('guide')] },
        { label: 'Reference', items: [page('format'), page('bridge'), page('cli')] },
        { label: 'Project', items: [page('roadmap'), page('changelog')] },
      ],
    }),
  ],
});
