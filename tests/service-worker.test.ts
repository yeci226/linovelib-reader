import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const swSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

type SWOptions = {
  cacheMatch?: (request: unknown) => unknown;
  fetchImpl?: (request: unknown) => Promise<unknown>;
  cacheKeys?: string[];
};

function loadServiceWorker(options: SWOptions = {}) {
  const listeners: Record<string, (event: any) => void> = {};
  const fetchCalls: string[] = [];
  const putCalls: string[] = [];
  const deletedCaches: string[] = [];
  const cache = {
    addAll: async () => undefined,
    match: async () => null,
    put: async (request: unknown) => {
      putCalls.push(String(request));
    },
    keys: async () => [],
    delete: async () => true,
  };
  const defaultFetch = async (request: unknown) => {
    const url = String(request);
    fetchCalls.push(url);
    const isDocument = ["/", "/catalog", "/read", "/bookshelf", "/settings"].includes(url);
    const body = isDocument
      ? '<html><head><link rel="stylesheet" href="/_next/static/app.css"></head><body><script src="/_next/static/app.js"></script></body></html>'
      : "asset";
    const response = {
      ok: true,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? (isDocument ? "text/html" : "application/javascript") : null },
      clone() { return this; },
      text: async () => body,
    };
    return response;
  };
  const sandbox = {
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: options.fetchImpl ?? defaultFetch,
    Response: { error: () => ({ source: "response-error" }) },
    caches: {
      match: async (request: unknown) => options.cacheMatch?.(request) ?? null,
      open: async () => cache,
      keys: async () => options.cacheKeys ?? [],
      delete: async (name: string) => { deletedCaches.push(name); return true; },
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
  vm.runInNewContext(swSource, sandbox);
  return { listeners, fetchCalls, putCalls, deletedCaches };
}

function navigationRequest() {
  return {
    method: "GET",
    mode: "navigate",
    url: "https://reader.example/read?url=https%3A%2F%2Fexample.com%2Fchapter-1",
  };
}

async function dispatchNavigation(
  listener: (event: any) => void,
  request: ReturnType<typeof navigationRequest>,
) {
  let responsePromise: Promise<unknown> | undefined;
  listener({
    request,
    respondWith: (response: Promise<unknown>) => {
      responsePromise = Promise.resolve(response);
    },
  });
  assert.ok(responsePromise, "navigation request should be intercepted");
  return responsePromise;
}

test("service worker falls back navigation URLs with query strings by pathname", async () => {
  const readShell = { source: "cached-read-shell" };
  const { listeners } = loadServiceWorker({
    fetchImpl: async () => { throw new Error("offline"); },
    cacheMatch: request => request === "/read" ? readShell : null,
  });
  assert.equal(await dispatchNavigation(listeners.fetch, navigationRequest()), readShell);
});

test("service worker uses an exact cached offline route before the generic shell", async () => {
  const request = navigationRequest();
  const exactRoute = { source: "exact-downloaded-route" };
  const { listeners } = loadServiceWorker({
    fetchImpl: async () => { throw new Error("offline"); },
    cacheMatch: candidate => candidate === request ? exactRoute : null,
  });
  assert.equal(await dispatchNavigation(listeners.fetch, request), exactRoute);
});

test("service worker install precaches scripts and styles required by app shells", async () => {
  const { listeners, fetchCalls } = loadServiceWorker();
  let installPromise: Promise<unknown> | undefined;
  listeners.install({ waitUntil: (promise: Promise<unknown>) => { installPromise = Promise.resolve(promise); } });
  assert.ok(installPromise, "install work should be registered");
  await installPromise;
  assert.ok(fetchCalls.includes("/_next/static/app.js"), "app JavaScript should be precached");
  assert.ok(fetchCalls.includes("/_next/static/app.css"), "app styles should be precached");
});

test("service worker activation preserves downloaded chapter content", async () => {
  const { listeners, deletedCaches } = loadServiceWorker({
    cacheKeys: ["linovelib-v2", "linovelib-chapter-content-v1"],
  });
  let activatePromise: Promise<unknown> | undefined;
  listeners.activate({ waitUntil: (promise: Promise<unknown>) => { activatePromise = Promise.resolve(promise); } });
  assert.ok(activatePromise, "activate work should be registered");
  await activatePromise;
  assert.ok(deletedCaches.includes("linovelib-v2"), "obsolete app caches should still be removed");
  assert.ok(!deletedCaches.includes("linovelib-chapter-content-v1"), "downloaded chapter content must survive service worker upgrades");
});
