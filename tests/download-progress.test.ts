import assert from "node:assert/strict";
import test from "node:test";

// Node's built-in type-stripping test runner requires the explicit .ts extension.
// @ts-expect-error TS5097 is expected for this runtime-only dynamic import.
const { adjustActiveDownloadCounts, getChapterProgressPercent, getVolumeProgressPercent } = await import("../lib/download-progress.ts");
type ChapterProgressInput = Parameters<typeof getChapterProgressPercent>[0];

test("chapter progress advances through page, media, saving, and completion stages", () => {
  const samples: ChapterProgressInput[] = [
    { phase: "fetching", completed: 0, total: null },
    { phase: "fetching", completed: 1, total: null },
    { phase: "fetching", completed: 4, total: null },
    { phase: "media", completed: 0, total: 2 },
    { phase: "media", completed: 1, total: 2 },
    { phase: "media", completed: 2, total: 2 },
    { phase: "saving", completed: 0, total: 0 },
    { phase: "complete", completed: 1, total: 1 },
  ];
  const values = samples.map(getChapterProgressPercent);
  assert.deepEqual(values, [5, 13, 37, 50, 70, 90, 95, 100]);
  assert.ok(values.every((value, index) => index === 0 || value >= values[index - 1]));
});

test("chapter progress is always clamped to a valid percentage", () => {
  assert.equal(getChapterProgressPercent({ phase: "fetching", completed: 999, total: null }), 45);
  assert.equal(getChapterProgressPercent({ phase: "media", completed: 9, total: 2 }), 90);
  assert.equal(getChapterProgressPercent({ phase: "media", completed: -5, total: 2 }), 50);
});

test("volume progress averages all concurrent chapter percentages", () => {
  const urls = ["chapter-a", "chapter-b", "chapter-c", "chapter-d"];
  const progressByUrl = { "chapter-a": 100, "chapter-b": 70, "chapter-c": 30, "chapter-d": 0 };
  assert.equal(getVolumeProgressPercent(urls, progressByUrl), 50);
  assert.equal(getVolumeProgressPercent([], progressByUrl), 0);
});

test("overlapping download jobs keep a chapter active until every owner finishes", () => {
  let counts = new Map<string, number>();
  counts = adjustActiveDownloadCounts(counts, ["a", "b"], 1);
  counts = adjustActiveDownloadCounts(counts, ["a"], 1);
  counts = adjustActiveDownloadCounts(counts, ["a", "b"], -1);
  assert.equal(counts.get("a"), 1);
  assert.equal(counts.has("b"), false);
  counts = adjustActiveDownloadCounts(counts, ["a"], -1);
  assert.equal(counts.has("a"), false);
});
