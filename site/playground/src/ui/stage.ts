import type { Problem } from '../engine/build';
import { h, icon } from './dom';

export interface Stage {
  /** Holds the frames. The overlays are drawn above them. */
  element: HTMLElement;
  frames: HTMLElement;
  /** Covers the preview with what stopped the code from running, or uncovers it with null. */
  block(title: string, problems: Problem[] | null): void;
  /** A line at the bottom for an error of the running preview, or nothing with null. */
  warn(problem: Problem | null): void;
  /** Says that the screen is closed and offers to open it. */
  closed(closed: boolean): void;
}

const place = (problem: Problem): string => (problem.line ? `${problem.file}:${problem.line}${problem.column ? `:${problem.column}` : ''}` : problem.file);

/** One line of a code frame: the line the problem is on and the marker under it stand out. */
function frameLine(text: string): HTMLElement {
  const marker = /^(\s+\|\s*)(\^+)\s*$/.exec(text);
  if (marker) return h('span', {}, marker[1], h('span', { class: 'nxp-frame-marker', text: marker[2] }), '\n');
  return h('span', { class: text.startsWith('>') ? 'nxp-frame-here' : '', text: `${text}\n` });
}

export function createStage(events: { reveal(problem: Problem): void; open(): void }): Stage {
  const frames = h('div', { class: 'nxp-frames' });
  const panel = h('div', { class: 'nxp-problem', role: 'alert', hidden: true });
  const bar = h('div', { class: 'nxp-problem-bar', role: 'status', hidden: true });
  const closed = h(
    'div',
    { class: 'nxp-closed', hidden: true },
    h('p', { class: 'nxp-closed-title', text: 'The screen is closed' }),
    h('p', { class: 'nxp-closed-text', text: 'Escape and nui.close() close it here as they do in game.' }),
    h('button', { class: 'nxp-button is-secondary', type: 'button', text: 'Open it again', onclick: () => events.open() }),
  );
  const element = h('div', { class: 'nxp-stage' }, frames, closed, bar, panel);

  const location = (problem: Problem): HTMLElement =>
    h('button', { class: 'nxp-place', type: 'button', title: 'Show in the editor', text: place(problem), onclick: () => events.reveal(problem) });

  return {
    element,
    frames,
    block(title, problems) {
      panel.hidden = !problems;
      element.classList.toggle('is-blocked', !!problems);
      if (!problems) return panel.replaceChildren();
      const [first, ...rest] = problems as [Problem, ...Problem[]];
      const card = h('div', { class: 'nxp-problem-card' }, h('div', { class: 'nxp-problem-head' }, h('span', { class: 'nxp-chip is-danger', text: title }), location(first)), h('p', { class: 'nxp-problem-message', text: first.message }));
      if (first.frame) card.append(h('pre', { class: 'nxp-problem-frame' }, ...first.frame.split('\n').map(frameLine)));
      if (first.hint) card.append(h('p', { class: 'nxp-problem-hint', text: first.hint }));
      if (rest.length) {
        const more = h('ul', { class: 'nxp-problem-more' });
        for (const problem of rest.slice(0, 4)) more.append(h('li', {}, location(problem), h('span', { text: problem.message })));
        card.append(more);
      }
      panel.replaceChildren(card);
      panel.scrollTop = 0;
    },
    warn(problem) {
      bar.hidden = !problem;
      if (!problem) return bar.replaceChildren();
      const dismiss = h('button', { class: 'nxp-icon-button', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => this.warn(null) }, icon('close', 14));
      bar.replaceChildren(h('span', { class: 'nxp-dot is-danger' }), h('span', { class: 'nxp-problem-bar-text', text: problem.message, title: problem.message }), problem.line ? location(problem) : '', dismiss);
    },
    closed(isClosed) {
      closed.hidden = !isClosed;
    },
  };
}
