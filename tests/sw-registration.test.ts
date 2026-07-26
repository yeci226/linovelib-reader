import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registrationSource = readFileSync(new URL("../app/sw-register.tsx", import.meta.url), "utf8");

test("service worker registration bypasses the HTTP cache and explicitly checks for updates", () => {
  assert.match(registrationSource, /updateViaCache\s*:\s*["']none["']/);
  assert.match(registrationSource, /registration\.update\(\)/);
});
