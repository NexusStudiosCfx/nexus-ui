import type { Example } from '../examples';
import { h, icon } from './dom';

export interface ExampleMenu {
  element: HTMLElement;
  /** Shows which example is loaded, or `label` for a project that is none of them. */
  select(name: string | null, label?: string): void;
}

/** The menu of examples: a button with the current one, and a list that opens under it. */
export function createMenu(examples: Example[], pick: (example: Example) => void): ExampleMenu {
  const title = h('span', { class: 'nxp-menu-title' });
  const button = h('button', { class: 'nxp-menu-button', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, h('span', { class: 'nxp-label', text: 'Example' }), title, icon('chevron', 14));
  const list = h('div', { class: 'nxp-menu-list', role: 'listbox', tabindex: '-1', hidden: true });
  const element = h('div', { class: 'nxp-menu' }, button, list);
  let selected: string | null = null;

  const items = examples.map((example) => {
    const item = h(
      'button',
      { class: 'nxp-menu-item', type: 'button', role: 'option', 'data-example': example.name },
      h('span', { class: 'nxp-menu-item-title', text: example.title }),
      h('span', { class: 'nxp-menu-item-text', text: example.description }),
    );
    item.addEventListener('click', () => {
      close();
      pick(example);
    });
    return item;
  });
  list.append(...items);

  const outside = (event: Event): void => {
    if (!event.composedPath().includes(element)) close();
  };

  function close(): void {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  }

  function open(): void {
    // The sandbox clips what leaves it, so the list ends above its lower edge and scrolls.
    const bounds = element.closest('.nxp')?.getBoundingClientRect();
    if (bounds) list.style.maxHeight = `${Math.max(160, bounds.bottom - button.getBoundingClientRect().bottom - 18)}px`;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    (items.find((item) => item.dataset.example === selected) ?? items[0])?.focus();
  }

  button.addEventListener('click', () => (list.hidden ? open() : close()));

  element.addEventListener('keydown', (event) => {
    if (list.hidden) return;
    const index = items.indexOf((element.getRootNode() as ShadowRoot | Document).activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      close();
      button.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    }
  });

  return {
    element,
    select(name, label) {
      selected = name;
      title.textContent = examples.find((example) => example.name === name)?.title ?? label ?? 'Custom';
      for (const item of items) item.setAttribute('aria-selected', String(item.dataset.example === name));
    },
  };
}
