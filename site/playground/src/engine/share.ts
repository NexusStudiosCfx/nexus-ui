import { sanitise, type Files } from './project';

const COMPRESSED = 'z1.';
const PLAIN = 'j1.';
const MAX_BYTES = 1024 * 1024;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Runs bytes through a compression stream. Stops reading once the result passes `limit`. */
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // A failure shows up on the reading side, which is the one that is awaited.
  writer.write(bytes as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('The shared project is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The files of a project as text that fits in the fragment of an address. */
export async function encodeProject(files: Files): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(files));
  try {
    return COMPRESSED + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw'), Infinity));
  } catch {
    // A browser without compression streams still gets a link, only a longer one.
    return PLAIN + toBase64Url(bytes);
  }
}

/**
 * Reads what `encodeProject` wrote. The text comes from an address someone else may have made,
 * so the result is checked file by file, and anything that is not a project gives null.
 */
export async function decodeProject(text: string): Promise<Files | null> {
  try {
    const compressed = text.startsWith(COMPRESSED);
    if (!compressed && !text.startsWith(PLAIN)) return null;
    const payload = fromBase64Url(text.slice(3));
    const bytes = compressed ? await pipe(payload, new DecompressionStream('deflate-raw'), MAX_BYTES) : payload;
    return sanitise(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** A value of the fragment, which holds `key=value` pairs like a query does. */
export function readFragment(key: string): string | null {
  return new URLSearchParams(location.hash.slice(1)).get(key);
}

/** Replaces the fragment without adding an entry to the history. */
export function writeFragment(values: Record<string, string>): string {
  const fragment = new URLSearchParams(values).toString();
  const address = `${location.pathname}${location.search}${fragment ? `#${fragment}` : ''}`;
  history.replaceState(history.state, '', address);
  return location.href;
}
