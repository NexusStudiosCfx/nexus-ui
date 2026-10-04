import { currentScope, invoke, own, type Cleanup } from './scope';

const timer =
  (repeat: boolean) =>
  (ms: number, fn: () => void): Cleanup => {
    const scope = currentScope();
    const id = (repeat ? setInterval : setTimeout)(() => {
      // A timeout that has fired has nothing left to cancel, and should not pile up in its owner.
      if (!repeat) stop();
      invoke(scope, fn, undefined);
    }, ms);
    // The two kinds of timer share their ids, so one function clears both.
    const stop = own(() => clearTimeout(id));
    return stop;
  };

/**
 * Runs `fn` once, `ms` milliseconds from now, unless the component is removed first.
 * The returned function cancels it.
 *
 * @example
 * after(3000, () => (notice.value = ''));
 */
export const after = /* @__PURE__ */ timer(false);

/**
 * Runs `fn` every `ms` milliseconds until the component is removed or the returned function
 * is called.
 *
 * @example
 * every(1000, () => seconds.value++);
 */
export const every = /* @__PURE__ */ timer(true);
