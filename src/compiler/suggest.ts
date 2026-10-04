function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
    }
    previous = row;
  }
  return previous[b.length] as number;
}

/** The candidate that `input` is most likely a typo of, if any is close enough. */
export function suggest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(input.length / 3)) + 1;
  for (const candidate of candidates) {
    const score = distance(input.toLowerCase(), candidate.toLowerCase());
    if (score < bestDistance) {
      best = candidate;
      bestDistance = score;
    }
  }
  return best;
}
