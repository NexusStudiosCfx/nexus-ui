import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Frame, type Page } from 'playwright-core';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** The folder the build is served under, to prove that no address in it starts at the root. */
export const SUB_PATH = '/docs/nexus-ui/playground/';

export interface Site {
  url: string;
  /** Every path that was asked for. */
  requests: string[];
  close(): Promise<void>;
}

/** Serves dist/ as a plain static server would: under a sub-path and without CORS headers. */
export async function serveBuild(): Promise<Site> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    requests.push(pathname);
    const inside = pathname.startsWith(SUB_PATH) ? pathname.slice(SUB_PATH.length) || 'index.html' : null;
    if (inside === null || normalize(inside).startsWith('..')) return void response.writeHead(404).end();
    readFile(join(dist, normalize(inside))).then(
      (body) => response.writeHead(200, { 'content-type': TYPES[extname(inside)] ?? 'application/octet-stream' }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${SUB_PATH}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A small screen the tests type into the editor. */
export const COUNTER = `---
import { signal } from 'nexus';

const count = signal(40);
---

<button class="add" on:click={() => count.value++}>Edited: {count}</button>
`;

export interface Sandbox {
  url: string;
  requests: string[];
  /** Opens the demo page of the build, at `address` after its own. */
  open(address?: string, viewport?: { width: number; height: number }): Promise<{ page: Page; problems: string[] }>;
  close(): Promise<void>;
}

export async function launch(executablePath: string): Promise<Sandbox> {
  const site = await serveBuild();
  const browser = await chromium.launch({ executablePath, headless: true });
  return {
    url: site.url,
    requests: site.requests,
    async open(address = '', viewport = { width: 1440, height: 900 }) {
      const page = await browser.newPage({ viewport });
      const problems = watch(page);
      await page.goto(`${site.url}${address}`);
      return { page, problems };
    },
    async close() {
      await browser.close();
      await site.close();
    },
  };
}

/** What went wrong in a page, collected while a test drives it. */
export function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`error: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`request: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`);
  });
  return problems;
}

/** Waits until a build is on screen and returns the frame it runs in. */
export async function running(page: Page): Promise<Frame> {
  await page.locator('.nxp-chip.is-positive').waitFor();
  const frame = await (await page.locator('iframe.nxp-frame:not(.is-starting)').elementHandle())?.contentFrame();
  if (!frame) throw new Error('the preview has no frame');
  return frame;
}

/** Replaces the text of the open file, as one edit. */
export async function write(page: Page, text: string): Promise<void> {
  await page.locator('.nxp-editor:not([hidden]) .cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

export async function editorText(page: Page): Promise<string> {
  return page.locator('.nxp-editor:not([hidden]) .cm-content').evaluate((content) => {
    return [...content.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n');
  });
}
