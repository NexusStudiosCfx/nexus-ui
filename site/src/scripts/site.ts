/** What every page outside the docs does: the header, scroll reveals, copy buttons, the phone menu. */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const header = document.querySelector<HTMLElement>('.top');
const onScroll = () => header?.classList.toggle('is-solid', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

const reveals = [...document.querySelectorAll<HTMLElement>('.reveal')];
if (reduceMotion.matches || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('is-in'));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      const shown = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
      shown.forEach((entry, index) => {
        const el = entry.target as HTMLElement;
        observer.unobserve(el);
        el.style.setProperty('--delay', `${Math.min(index * 60, 300)}ms`);
        el.classList.add('is-in');
      });
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.04 },
  );
  reveals.forEach((el) => observer.observe(el));
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove();
    return done;
  }
}

document.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy]');
  if (!button) return;

  const source = button.dataset.copyFrom ? document.getElementById(button.dataset.copyFrom)?.textContent : button.dataset.copy;
  if (!source || !(await copy(source))) return;

  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  const before = label?.textContent ?? '';
  button.dataset.copied = '';
  if (label) label.textContent = 'Copied';
  setTimeout(() => {
    delete button.dataset.copied;
    if (label) label.textContent = before;
  }, 1600);
});

const menu = document.querySelector<HTMLDetailsElement>('.mnav');
menu?.addEventListener('click', (event) => {
  if ((event.target as Element).closest('a')) menu.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu?.open) {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
});
