import { signal } from '@preact/signals-core';

type Strings = { [key: string]: string | Strings };

/**
 * The strings of the current language. Lua fills it through `Nexus.locale(table)`; assigning a
 * new table updates every `t()` on screen.
 */
export const locale = /* @__PURE__ */ signal<Strings>({});

/**
 * Looks up a string and fills its placeholders: `%s` and `%d` in order, `{0}` by position.
 * A missing key is returned as it is, so it shows up on screen instead of leaving a gap.
 *
 * @example
 * t('shop.total', 3, '$120')   // "3 items for $120" from "%s items for %s"
 */
export function t(key: string, ...args: unknown[]): string {
  const strings = locale.value;
  let text: string | Strings | undefined = strings[key];
  if (text === undefined) {
    // Lua locale files are written both flat ('shop.title') and nested (shop = { title }).
    text = strings;
    for (const part of key.split('.')) text = typeof text === 'object' ? text[part] : undefined;
  }
  if (typeof text !== 'string') return key;
  let next = 0;
  return text.replace(/%[sd]|\{(\d+)\}/g, (placeholder, position?: string) => {
    const value = args[position ? +position : next++];
    return value == null ? placeholder : String(value);
  });
}
