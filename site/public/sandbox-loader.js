/**
 * Puts the sandbox into the elements that ask for it:
 *
 *   <div data-sandbox="<address of playground.js>" data-example="hud" data-compact data-height="420">
 *
 * The module is large, so nothing fetches it until it is wanted: when such an element comes
 * near the window, or, with data-sandbox-on="click", when its [data-sandbox-run] button is
 * pressed. It is fetched once for the page.
 *
 * An element with data-fallback holds a picture of the result. It keeps the picture when the
 * module cannot be loaded, when the build has the stand-in in place of the sandbox, when the
 * sandbox has no example of that name, and, with data-min-width, in a window narrower than
 * that many pixels. data-sandbox-state says where the element is: loading, live, off or failed.
 *
 * This file is served as it is, not bundled: the sandbox is a build of its own next to it, and
 * a bundler would try to follow the import.
 */

let sandbox;

function load(address) {
  sandbox ??= import(address);
  return sandbox;
}

function fits(slot) {
  const { minWidth } = slot.dataset;
  return !minWidth || matchMedia(`(min-width: ${minWidth}px)`).matches;
}

async function mount(slot) {
  if (slot.dataset.sandboxState || !fits(slot)) return;
  slot.dataset.sandboxState = 'loading';

  const keepsPicture = 'fallback' in slot.dataset;
  try {
    const module = await load(slot.dataset.sandbox);
    const { example, height, files } = slot.dataset;
    // The sandbox falls back to its first example for a name it does not know.
    const known = !example || module.examples.some((entry) => entry.name === example);
    if (keepsPicture && (module.stub || !known)) {
      slot.dataset.sandboxState = 'off';
      return;
    }

    module.mount(slot, {
      example,
      files: files ? JSON.parse(files) : undefined,
      compact: 'compact' in slot.dataset,
      height: height && /^\d+$/.test(height) ? Number(height) : height,
    });
    slot.dataset.sandboxState = 'live';
  } catch (error) {
    slot.dataset.sandboxState = 'failed';
    console.warn('The sandbox could not be loaded.', error);
  }
}

const observer =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            mount(entry.target);
          }
        },
        { rootMargin: '400px 0px' },
      )
    : null;

for (const slot of document.querySelectorAll('[data-sandbox]')) {
  slot.querySelector('[data-sandbox-run]')?.addEventListener('click', () => mount(slot));
  if (slot.dataset.sandboxOn === 'click') continue;
  if (observer) observer.observe(slot);
  else mount(slot);
}
