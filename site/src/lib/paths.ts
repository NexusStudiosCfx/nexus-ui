const base = import.meta.env.BASE_URL.replace(/\/$/, '');

/** A path of this site under the base it is served from: `href('/docs/')`. */
export function href(path: string): string {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The slug of a page, as the social image of that page is named: '' is the landing page. */
export function socialImage(slug: string): string {
  return href(`/og/${slug || 'index'}.png`);
}
