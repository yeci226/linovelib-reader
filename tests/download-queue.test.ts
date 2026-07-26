import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping runner requires the explicit extension.
const { createRequestQueue, retryAfterMs } = await import("../lib/download-queue.ts");

test("download request queue runs work serially and survives a rejected task", async () => {
  const enqueue = createRequestQueue(0);
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const task = (name: string, fail = false) => enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${name}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    events.push(`end:${name}`);
    if (fail) throw new Error(name);
    return name;
  });

  const results = await Promise.allSettled([task("a"), task("b", true), task("c")]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("Retry-After supports seconds and falls back for invalid values", () => {
  assert.equal(retryAfterMs("2", 900), 2000);
  assert.equal(retryAfterMs("invalid", 900), 900);
  assert.equal(retryAfterMs(null, 900), 900);
});
