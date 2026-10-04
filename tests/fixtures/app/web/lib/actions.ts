/** Mirrors its argument into `title` and counts how often it ran and was cleaned up. */
export function tooltip(node: Element, text: unknown): () => void {
  node.setAttribute('title', String(text));
  node.setAttribute('data-runs', String(Number(node.getAttribute('data-runs') ?? 0) + 1));
  return () => {
    node.setAttribute('data-cleanups', String(Number(node.getAttribute('data-cleanups') ?? 0) + 1));
  };
}
