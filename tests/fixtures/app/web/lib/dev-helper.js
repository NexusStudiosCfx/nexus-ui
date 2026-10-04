import { dev } from 'nexus';

/** Called by the screen itself, and by toolbar buttons that only exist under `nexus dev`. */
export function helper(text) {
  return `dev helper: ${text}`;
}

dev.action('Registered by a plain module', () => helper('nor this'));
