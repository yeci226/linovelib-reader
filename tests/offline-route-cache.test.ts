import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping runner requires the explicit extension.
const { cacheOfflineRoute } = await import("../lib/offline-route-cache.ts");

test("downloaded routes cache their exact URL and required same-origin assets", async () => {
  const stored = new Set<string>();
  const fetched: string[] = [];
  const cache = {
    match: async (request: string) => stored.has(request) ? { cached: request } : null,
    put: async (request: string) => { stored.add(request); },
  };
  const html = '<html><head><link rel="stylesheet" href="/_next/static/app.css"></head><body><script src="/_next/static/app.js"></script><script src="https://cdn.example/external.js"></script></body></html>';
  const fetchFn = async (request: string) => {
    fetched.push(request);
    const isDocument = request.includes("/read?");
    return {
      ok: true,
      headers: { get: (name: string) => name === "content-type" ? (isDocument ? "text/html" : "application/javascript") : null },
      clone() { return this; },
      text: async () => isDocument ? html : "asset",
    };
  };

  await cacheOfflineRoute("/read?url=chapter-1&catalog=catalog-1", {
    origin: "https://reader.example",
    cache,
    fetchFn,
  });

  assert.ok(stored.has("https://reader.example/read?url=chapter-1&catalog=catalog-1"));
  assert.ok(stored.has("https://reader.example/_next/static/app.js"));
  assert.ok(stored.has("https://reader.example/_next/static/app.css"));
  assert.ok(!fetched.includes("https://cdn.example/external.js"));
});
