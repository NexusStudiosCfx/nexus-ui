/**
 * Named character references the compiler decodes. Text next to an expression is written through
 * `Text.data`, which does not decode anything, so the compiler has to. The list covers what is
 * typed by hand in a UI; anything else can be written as the character itself or as `&#N;`.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', micro: '\u00b5', para: '\u00b6', sect: '\u00a7',
  hellip: '\u2026', middot: '\u00b7', bull: '\u2022', ndash: '\u2013', mdash: '\u2014',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', minus: '\u2212', ne: '\u2260', le: '\u2264', ge: '\u2265',
  infin: '\u221e', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  check: '\u2713', cross: '\u2717', star: '\u2606', starf: '\u2605', hearts: '\u2665',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  lbrace: '{', rbrace: '}',
};

const REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;

export interface UnknownReference {
  name: string;
  /** Offset inside the text that was decoded. */
  offset: number;
}

/** Decodes character references. Unknown names are left as written and reported. */
export function decodeEntities(text: string, unknown: UnknownReference[] = []): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (whole, decimal?: string, hex?: string, name?: string, offset?: number) => {
    if (name) {
      const value = NAMED[name];
      if (value !== undefined) return value;
      unknown.push({ name, offset: offset as number });
      return whole;
    }
    const code = decimal ? Number(decimal) : parseInt(hex as string, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\u00a0': '&nbsp;' };

/** Escapes text for the static markup the compiler emits. */
export function escapeHtml(text: string, attribute = false): string {
  return text.replace(attribute ? /[&"\u00a0]/g : /[&<>\u00a0]/g, (char) => ESCAPES[char] as string);
}
