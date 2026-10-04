import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../site.config.mjs';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(siteRoot, '..');
const outDir = join(siteRoot, 'src/content/docs/docs');

/** The pages of the documentation, in reading order. The markdown in the repository is the source. */
export const PAGES = [
  {
    slug: 'guide',
    source: 'docs/guide.md',
    label: 'Guide',
    description: 'Build a small FiveM resource with Nexus UI from nothing: a screen that opens in game, calls the server and shows the answer.',
  },
  {
    slug: 'format',
    source: 'docs/format.md',
    label: 'The .nexus format',
    description: 'Every block and directive of a .nexus component: script, template, styles, the screen tag and what Chromium 103 cannot run.',
  },
  {
    slug: 'bridge',
    source: 'docs/bridge.md',
    label: 'The bridge',
    description: 'The contract between the page and Lua: schemas, the generated validators, the Lua API, the security model and the wire format.',
  },
  {
    slug: 'cli',
    source: 'docs/cli.md',
    label: 'Command line',
    description: 'The nexus command: create a resource, work on it in a browser, build it for Chromium 103 and check it before a release.',
  },
  {
    slug: 'roadmap',
    source: 'docs/roadmap.md',
    label: 'Roadmap',
    description: 'What this version of Nexus UI does not do, listed by area.',
  },
  {
    slug: 'changelog',
    source: 'CHANGELOG.md',
    label: 'Changelog',
    description: 'What changed in each release of Nexus UI.',
  },
];

const slugBySource = new Map(PAGES.map((page) => [page.source, page.slug]));

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/');
}

/**
 * Where a relative link in a repository document leads once the document is a page of the site:
 * another page of the docs, an image copied next to the pages, or the file on GitHub.
 */
function rewriteTarget(target, source, isImage) {
  if (isExternal(target)) return target;

  const [path, fragment = ''] = target.split('#');
  const repoPath = posix.normalize(posix.join(posix.dirname(source), path));
  const hash = fragment ? `#${fragment}` : '';

  // Every page of the docs is a folder next to the others, so a relative link holds under any base.
  const slug = slugBySource.get(repoPath);
  if (slug) return `../${slug}/${hash}`;

  const absolute = join(repoRoot, repoPath);
  if (!existsSync(absolute)) {
    throw new Error(`${source} links to ${target}, which does not exist in the repository`);
  }

  if (isImage) {
    const copy = join(outDir, 'media', posix.basename(repoPath));
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(absolute, copy);
    return `./media/${posix.basename(repoPath)}`;
  }

  const kind = statSync(absolute).isDirectory() ? 'tree' : 'blob';
  return `${SITE.repository}/${kind}/main/${repoPath}${hash}`;
}

// A code span, or a link or image whose text may itself hold code spans. A span that comes first
// is matched first, so a link written inside code is left as it is.
const SPAN_OR_LINK = /(`+[^`]*`+)|(!?)\[((?:`[^`]*`|[^\]`])*)\]\(([^)\s]+)\)/g;

/** Rewrites the link and image targets of a document, leaving code untouched. */
function rewriteLinks(markdown, source) {
  let fence = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker.startsWith(fence)) fence = null;
        return line;
      }
      if (fence) return line;

      return line.replace(SPAN_OR_LINK, (match, span, bang, text, target) => {
        return span ? match : `${bang}[${text}](${rewriteTarget(target, source, bang === '!')})`;
      });
    })
    .join('\n');
}

/** Drops the list of contents a document carries for GitHub: the site shows its own next to the page. */
function withoutContents(markdown) {
  return markdown.replace(/^Contents:\n\n(?:.+\n)+\n/m, '');
}

function frontmatter(fields) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/** Writes the pages of the docs from the markdown of the repository. */
export function syncDocs() {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (name !== 'index.mdx') rmSync(join(outDir, name), { recursive: true, force: true });
  }

  for (const page of PAGES) {
    const text = readFileSync(join(repoRoot, page.source), 'utf8').replace(/\r\n/g, '\n');
    const heading = text.match(/^# (.+)\n/);
    if (!heading) throw new Error(`${page.source} does not start with a title`);

    const body = rewriteLinks(withoutContents(text.slice(heading[0].length).replace(/^\n+/, '')), page.source);
    const head = frontmatter({
      title: heading[1].replace(/`/g, ''),
      description: page.description,
      editUrl: `${SITE.repository}/edit/main/${page.source}`,
    });
    writeFileSync(join(outDir, `${page.slug}.md`), `${head}\n${body}`);
  }

  return relative(siteRoot, outDir);
}
