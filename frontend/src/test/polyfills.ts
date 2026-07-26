/**
 * jsdom ships a browser-ish global scope but omits several web-platform APIs
 * that MSW 2 and undici rely on. Vitest loads this file before setupTests.ts,
 * so the globals exist before anything imports `mocks/server`.
 *
 * Everything below is pulled from Node's own implementations — no shims.
 */
import { TextDecoder, TextEncoder } from "node:util";
import {
  ReadableStream,
  TransformStream,
  WritableStream,
} from "node:stream/web";
import { BroadcastChannel } from "node:worker_threads";
import { performance } from "node:perf_hooks";

const globals: Record<string, unknown> = {
  TextEncoder,
  TextDecoder,
  ReadableStream,
  WritableStream,
  TransformStream,
  BroadcastChannel,
  // undici reads performance.markResourceTiming, which jsdom's stub lacks.
  performance,
  // Node's fetch primitives; jsdom provides none of these.
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
};

for (const [name, value] of Object.entries(globals)) {
  if (value === undefined) continue;
  // Only fill gaps — never clobber something jsdom implemented properly.
  if (name in globalThis && name !== "performance") continue;
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}

/**
 * jsdom parses <dialog> but implements none of its methods, so Modal (which
 * uses the native element for its focus trap and top-layer stacking) cannot
 * be tested without this. Models the three behaviours the component relies
 * on: `open` reflects state, Esc dispatches `cancel`, and close() fires
 * `close`.
 */
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  const escHandlers = new WeakMap<HTMLDialogElement, (e: KeyboardEvent) => void>();

  const open = function (this: HTMLDialogElement, modal: boolean) {
    if (this.open) return;
    this.setAttribute("open", "");

    if (!modal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Real dialogs fire `cancel` first; only an unprevented one closes.
      const cancel = new Event("cancel", { cancelable: true });
      if (this.dispatchEvent(cancel)) this.close();
    };
    escHandlers.set(this, onKeyDown);
    document.addEventListener("keydown", onKeyDown);
  };

  HTMLDialogElement.prototype.show = function () {
    open.call(this, false);
  };

  HTMLDialogElement.prototype.showModal = function () {
    open.call(this, true);
  };

  HTMLDialogElement.prototype.close = function (returnValue?: string) {
    if (!this.open) return;
    this.removeAttribute("open");
    if (returnValue !== undefined) this.returnValue = returnValue;

    const onKeyDown = escHandlers.get(this);
    if (onKeyDown) {
      document.removeEventListener("keydown", onKeyDown);
      escHandlers.delete(this);
    }
    this.dispatchEvent(new Event("close"));
  };
}
