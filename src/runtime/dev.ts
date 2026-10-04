import { own } from './scope';

/** Helpers for development. They do nothing in a build, and their code is removed from it. */
export const dev = {
  /**
   * Adds a button to the dev toolbar for as long as the component is mounted.
   *
   * @example
   * dev.action('Sell out', () => nui.state('shop').stock = 0);
   */
  action(label: string, run: () => void): void {
    if (globalThis.__NEXUS_DEV__) {
      const remove = window.__NEXUS_HOST__?.action?.(label, run);
      if (remove) own(remove);
    }
  },
};
