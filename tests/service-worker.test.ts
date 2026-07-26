import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const serviceWorkerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

test("service worker falls back navigation URLs with query strings by pathname", async () => {
  const listeners: Record<string, (event: any) => void> = {};
  const readShell = { source: "cached-read-shell" };

  const sandbox = {
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("offline");
    },
    Response: {
      error: () => ({ source: "response-error" }),
    },
    caches: {
      match: async (request: string) => request === "/read" ? readShell : null,
      open: async () => ({
        addAll: async () => undefined,
        match: async () => null,
        put: async () => undefined,
        keys: async () => [],
        delete: async () => true,
      }),
      keys: async () => [],
      delete: async () => true,
    },
    self: {
      location: { origin: "https://reader.example" },
      clients: { claim: () => undefined },
      skipWaiting: () => undefined,
      addEventListener: (name: string, listener: (event: any) => void) => {
        listeners[name] = listener;
      },
    },
  };

  vm.runInNewContext(serviceWorkerSource, sandbox);

  let responsePromise: Promise<unknown> | undefined;
  listeners.fetch({
    request: {
      method: "GET",
      mode: "navigate",
      url: "https://reader.example/read?url=https%3A%2F%2Fexample.com%2Fchapter-1",
    },
    respondWith: (response: Promise<unknown>) => {
      responsePromise = Promise.resolve(response);
    },
  });

  assert.ok(responsePromise, "navigation request should be intercepted");
  assert.equal(await responsePromise, readShell);
});
