import { decode, type SourceMapMappings } from '@jridgewell/sourcemap-codec';

export interface Position {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** One rewrite of a file, as the mappings of its source map. */
export type Step = SourceMapMappings;

export const step = (mappings: string): Step => decode(mappings);

/** Where a position in rewritten code came from, or null when the code there was generated. */
function back(mappings: Step, { line, column }: Position): Position | null {
  const segments = mappings[line - 1];
  if (!segments || !segments.length) return null;
  let found = null;
  for (const segment of segments) {
    if (segment.length < 4) continue;
    if (segment[0] > column - 1 && found) break;
    found = segment;
  }
  return found ? { line: (found[2] as number) + 1, column: (found[3] as number) + 1 } : null;
}

/**
 * Follows a position in the code the frame ran back to the file the visitor wrote, through the
 * rewrites in the order they were applied.
 */
export function trace(steps: Step[], position: Position): Position | null {
  let current: Position | null = position;
  for (let index = steps.length - 1; index >= 0 && current; index--) current = back(steps[index] as Step, current);
  return current;
}

export function offsetOf(source: string, { line, column }: Position): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  return Math.min(source.length, offset + column - 1);
}
