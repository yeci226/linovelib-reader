import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping runner requires the explicit extension.
const { mapWithConcurrencySettled } = await import("../lib/download-queue.ts");

test("concurrent batch waits for every item even when one item fails", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrencySettled(
    ["a", "b", "c", "d"],
    2,
    async (name: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(name);
      await new Promise(resolve => setTimeout(resolve, name === "a" ? 15 : 5));
      active -= 1;
      finished.push(name);
      if (name === "b") throw new Error("b failed");
      return name.toUpperCase();
    },
  );

  assert.equal(maxActive, 2);
  assert.deepEqual([...started].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...finished].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(results.map((result: PromiseSettledResult<string>) => result.status), [
    "fulfilled",
    "rejected",
    "fulfilled",
    "fulfilled",
  ]);
  assert.equal(results[2].status === "fulfilled" ? results[2].value : "", "C");
});
