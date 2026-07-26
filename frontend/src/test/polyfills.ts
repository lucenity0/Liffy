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
