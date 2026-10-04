/**
 * What a development host provides in place of FiveM. The dev server installs it as
 * `window.__NEXUS_HOST__` before the page's scripts run; in game it does not exist.
 */
export interface NexusHost {
  /** Receives every message the page sends to Lua (`ready`, `call`, `client`, `close`). */
  post(message: unknown): Promise<unknown>;
  /** Registers the listener for messages from Lua. Messages have the `__nexus: 1` wire format. */
  onMessage(listener: (message: unknown) => void): void;
  /** Shown as `env.resource`. */
  resource?: string;
  /** Adds a button to the dev toolbar and returns a function that removes it. */
  action?(label: string, run: () => void): () => void;
}

declare global {
  interface Window {
    __NEXUS_HOST__?: NexusHost;
    GetParentResourceName?: () => string;
  }
  // Read as `globalThis.__NEXUS_DEV__`, which the Vite plugin replaces: true while developing,
  // false in a build. Without the plugin it is undefined and the dev-only code stays idle.
  var __NEXUS_DEV__: boolean | undefined;
}

/**
 * A parameter of the page's address. An app in LB Phone or LB Tablet is the page loaded as
 * `index.html?surface=phone&resource=<name>`: inside that frame nothing else says which surface
 * it is or which resource it belongs to.
 */
export const query = (name: string): string | null => new URLSearchParams(location.search).get(name);

/** Where the page is running. */
export const env = {
  /** True inside FiveM, false in a browser. */
  get inGame(): boolean {
    // The game adds `invokeNative` to every frame, the frame of an app included.
    return 'invokeNative' in window;
  },
  /** The name of the resource that owns this page. */
  get resource(): string {
    return query('resource') || window.GetParentResourceName?.() || window.__NEXUS_HOST__?.resource || 'nexus';
  },
  /** True under `nexus dev`, false in a build. */
  get dev(): boolean {
    return !!globalThis.__NEXUS_DEV__;
  },
};
