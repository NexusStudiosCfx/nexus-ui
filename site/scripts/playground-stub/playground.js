/**
 * Stand-in for the sandbox, served when playground/dist has not been built. It has the exports
 * of the real module and renders a notice instead of an editor. `stub` tells the pages that
 * embed small examples to keep their pictures.
 */
export const stub = true;

export const examples = [];

export function mount(element, options = {}) {
  const notice = document.createElement('div');
  notice.className = 'nxp-missing';
  if (options.height) notice.style.minHeight = typeof options.height === 'number' ? `${options.height}px` : options.height;

  const title = document.createElement('strong');
  title.textContent = 'The sandbox is not in this build.';
  const text = document.createElement('p');
  text.textContent = 'Run npm run build in site/playground, then build the site again.';
  notice.append(title, text);

  const styles = document.createElement('link');
  styles.rel = 'stylesheet';
  styles.href = new URL('playground.css', import.meta.url).href;

  element.replaceChildren(styles, notice);
  return {
    destroy() {
      element.replaceChildren();
    },
  };
}
