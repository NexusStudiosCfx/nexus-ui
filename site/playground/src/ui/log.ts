import type { Traffic } from '../engine/session';
import { h, icon } from './dom';

const MAX_LINES = 200;
const MAX_TEXT = 600;

export interface BridgeLog {
  element: HTMLElement;
  add(entry: Traffic): void;
  /** A line of the sandbox's own, such as an error of the preview. */
  note(level: 'warn' | 'error', text: string): void;
  clear(): void;
}

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text);

const duration = (ms: number): string => (ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`);

/**
 * The list under the preview: every call with its answer and how long it took, every push,
 * every state change, and what the code printed to the console. Everything in it comes from the
 * frame, so it is only ever set as text.
 */
export function createLog(): BridgeLog {
  const lines = h('div', { class: 'nxp-log-lines', role: 'log', 'aria-label': 'Bridge log' });
  const count = h('span', { class: 'nxp-count' });
  const empty = h('p', { class: 'nxp-log-empty', text: 'Nothing has crossed the bridge yet. Calls, pushes and state changes show up here.' });
  const clear = h('button', { class: 'nxp-icon-button', type: 'button', title: 'Clear the log', 'aria-label': 'Clear the log', onclick: () => api.clear() }, icon('trash', 14));
  const element = h('section', { class: 'nxp-log' }, h('header', { class: 'nxp-log-head' }, h('span', { class: 'nxp-label', text: 'Bridge' }), count, h('span', { class: 'nxp-spacer' }), clear), lines);

  let total = 0;
  // The last line, when it is a state change: the next change of that state updates it in place.
  let repeated: { name: string; data: HTMLElement; times: HTMLElement; count: number } | null = null;

  const refresh = (): void => {
    count.textContent = total ? String(total) : '';
    if (!total && !empty.isConnected) lines.replaceChildren(empty);
    clear.disabled = !total;
  };

  const append = (line: HTMLElement): void => {
    // Follow the log only while the visitor is at its end.
    const follow = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 24;
    if (empty.isConnected) empty.remove();
    lines.append(line);
    while (lines.childElementCount > MAX_LINES) lines.firstElementChild?.remove();
    if (follow) lines.scrollTop = lines.scrollHeight;
    total++;
    refresh();
  };

  const line = (kind: string, tone: string, ...children: (HTMLElement | false)[]): HTMLElement => {
    const row = h('div', { class: `nxp-line${tone ? ` is-${tone}` : ''}`, onclick: () => row.classList.toggle('is-open') }, h('span', { class: 'nxp-kind', text: kind }));
    row.append(...children.filter((child): child is HTMLElement => child !== false));
    return row;
  };

  const api: BridgeLog = {
    element,
    add(entry) {
      if (entry.type === 'console') {
        repeated = null;
        const tone = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'quiet';
        return append(line(entry.level, tone, h('span', { class: 'nxp-data', text: clip(entry.text) })));
      }
      const { kind, name, answer } = entry;
      const data = clip(entry.data);
      if (kind === 'state' && repeated && repeated.name === name) {
        repeated.data.textContent = data;
        repeated.times.textContent = `x${++repeated.count}`;
        return;
      }
      const payload = h('span', { class: 'nxp-data', text: data });
      const times = h('span', { class: 'nxp-times' });
      const row = line(kind, answer && !answer.ok ? 'refused' : '', h('span', { class: 'nxp-name', text: clip(String(name)) }), payload);
      if (answer) {
        const verdict = answer.ok ? 'ok' : String(answer.code);
        const detail = answer.ok ? answer.data : [answer.message, answer.data].filter(Boolean).join(' ');
        row.append(h('span', { class: 'nxp-arrow', text: '→' }), h('span', { class: answer.ok ? 'nxp-ok' : 'nxp-refused', text: clip(verdict) }));
        if (detail) row.append(h('span', { class: 'nxp-data', text: clip(detail) }));
        if (typeof entry.ms === 'number') row.append(h('span', { class: 'nxp-ms', text: duration(entry.ms) }));
      } else row.append(times);
      repeated = kind === 'state' ? { name, data: payload, times, count: 1 } : null;
      append(row);
    },
    note(level, text) {
      repeated = null;
      append(line(level === 'error' ? 'error' : 'warn', level, h('span', { class: 'nxp-data', text: clip(text) })));
    },
    clear() {
      total = 0;
      repeated = null;
      lines.replaceChildren();
      refresh();
    },
  };

  refresh();
  return api;
}
