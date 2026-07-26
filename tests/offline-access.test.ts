import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping runner requires the explicit extension.
const { canOpenOfflineResource, getNavigationMode } = await import("../lib/offline-access.ts");

test("offline access is allowed only when the resource is cached", () => {
  assert.equal(canOpenOfflineResource(true, false), true);
  assert.equal(canOpenOfflineResource(true, true), true);
  assert.equal(canOpenOfflineResource(false, true), true);
  assert.equal(canOpenOfflineResource(false, false), false);
});

test("offline routes use a full document navigation so the service worker can serve the shell", () => {
  assert.equal(getNavigationMode(true), "client");
  assert.equal(getNavigationMode(false), "document");
});
