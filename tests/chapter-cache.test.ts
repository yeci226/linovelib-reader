import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping runner requires the explicit extension.
const { createChapterCacheStore, LEGACY_CHAPTER_CACHE_KEY, CHAPTER_CACHE_INDEX_KEY } = await import("../lib/chapter-cache.ts");
const CHAPTER_CACHE_DELETED_KEY = "linovelib-chapter-cache-deleted-v1";
const CHAPTER_CACHE_STATE_PREFIX = "linovelib-chapter-cache-state-v1:";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
};

function createQuotaStorage(initial: Record<string, string>, quota: number): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      const next = new Map(values);
      next.set(key, value);
      const used = [...next.entries()].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
      if (used > quota) throw new DOMException("Quota exceeded", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem: key => { values.delete(key); },
  };
}

function createMemoryCache({ failPut = false, failDelete = false } = {}) {
  const entries = new Map<string, Response>();
  return {
    entries,
    cache: {
      async match(request: string) {
        return entries.get(request)?.clone();
      },
      async put(request: string, response: Response) {
        if (failPut) throw new DOMException("Quota exceeded", "QuotaExceededError");
        entries.set(request, response.clone());
      },
      async delete(request: string) {
        if (failDelete) throw new DOMException("Delete failed", "InvalidStateError");
        return entries.delete(request);
      },
      async keys() {
        return [...entries.keys()].map(url => ({ url }));
      },
    },
  };
}

function chapter(title: string, text: string) {
  return {
    title,
    subtitle: "",
    nodes: [{ type: "text" as const, text }],
    nextChapterUrl: null,
    prevChapterUrl: null,
    pinned: true,
  };
}

test("large chapter bodies use Cache Storage while the local index stays below localStorage quota", async () => {
  const oldUrl = "https://tw.linovelib.com/novel/1/100.html";
  const newUrl = "https://tw.linovelib.com/novel/1/101.html";
  const legacyRecord = { ...chapter("舊章", "舊".repeat(900)), cachedAt: 1 };
  const legacyJson = JSON.stringify({ [oldUrl]: legacyRecord });
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: legacyJson }, legacyJson.length + 1500);
  const { cache } = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });

  await store.save(newUrl, chapter("新章", "新".repeat(5000)));

  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), legacyJson);
  const indexJson = storage.getItem(CHAPTER_CACHE_INDEX_KEY);
  assert.ok(indexJson);
  assert.ok(indexJson.length < 500, "localStorage should contain metadata, not the chapter bodies");
  assert.deepEqual([...store.getCachedUrls()].sort(), [oldUrl, newUrl]);
  const loadedOld = await store.load(oldUrl);
  const loadedNew = await store.load(newUrl);
  const oldNode = loadedOld?.nodes[0];
  const newNode = loadedNew?.nodes[0];
  assert.equal(oldNode?.type, "text");
  assert.equal(oldNode?.type === "text" ? oldNode.text.length : 0, 900);
  assert.equal(newNode?.type === "text" ? newNode.text.length : 0, 5000);
});

test("a failed Cache Storage write rejects instead of reporting a false successful download", async () => {
  const url = "https://tw.linovelib.com/novel/1/200.html";
  const storage = createQuotaStorage({}, 1000);
  const { cache } = createMemoryCache({ failPut: true });
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });

  await assert.rejects(store.save(url, chapter("失敗章", "正文")), /離線內容儲存失敗/);
  assert.equal(store.getMetadata(url), null);
  assert.equal(storage.getItem(CHAPTER_CACHE_INDEX_KEY), null);
});

test("legacy localStorage content remains readable when migration cannot finish", async () => {
  const url = "https://tw.linovelib.com/novel/1/300.html";
  const legacyRecord = { ...chapter("保留章", "仍可閱讀"), cachedAt: 1 };
  const legacyJson = JSON.stringify({ [url]: legacyRecord });
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: legacyJson }, 2000);
  const { cache } = createMemoryCache({ failPut: true });
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });

  const loaded = await store.load(url);

  assert.equal(loaded?.title, "保留章");
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), legacyJson);
});

test("an advisory index failure cannot roll back an authoritative saved state", async () => {
  const url = "https://tw.linovelib.com/novel/1/400.html";
  const values = new Map<string, string>();
  let failIndexWrite = false;
  const storage: StorageLike = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (failIndexWrite && key === CHAPTER_CACHE_INDEX_KEY) throw new DOMException("Quota exceeded", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem: key => { values.delete(key); },
  };
  const { cache } = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });
  await store.save(url, chapter("舊正文", "old"));

  failIndexWrite = true;
  await store.save(url, chapter("新正文", "new"));
  failIndexWrite = false;

  assert.equal((await store.load(url))?.title, "新正文");
  assert.equal(store.getMetadata(url)?.title, "新正文");
  assert.equal(store.getCachedUrls().has(url), true);
});

test("a remove invoked after a pending save wins instead of leaving stale metadata", async () => {
  const url = "https://tw.linovelib.com/novel/1/500.html";
  const storage = createQuotaStorage({}, 10000);
  const { cache: baseCache } = createMemoryCache();
  let blockPut = false;
  let releasePut!: () => void;
  let putStarted!: () => void;
  const started = new Promise<void>(resolve => { putStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releasePut = resolve; });
  const cache = {
    ...baseCache,
    async put(request: string, response: Response) {
      if (blockPut) {
        putStarted();
        await blocked;
      }
      return baseCache.put(request, response);
    },
  };
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });
  await store.save(url, chapter("舊章", "old"));

  blockPut = true;
  const saving = store.save(url, chapter("新章", "new"));
  await started;
  const removing = store.remove(url);
  releasePut();
  await Promise.all([saving, removing]);

  assert.equal(store.getMetadata(url), null);
  assert.equal(await store.load(url), null);
});

test("malformed legacy payload is retained instead of being silently deleted", async () => {
  const malformed = JSON.stringify({ broken: { title: "缺少 nodes 與 cachedAt" } });
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: malformed }, 10000);
  const { cache } = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });

  await assert.rejects(store.migrateLegacy(), /格式/);
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), malformed);
});

test("reconcile removes stale metadata and indexes valid orphaned bodies", async () => {
  const staleUrl = "https://tw.linovelib.com/novel/1/stale.html";
  const orphanUrl = "https://tw.linovelib.com/novel/1/orphan.html";
  const storage = createQuotaStorage({
    [CHAPTER_CACHE_INDEX_KEY]: JSON.stringify({
      [staleUrl]: { title: "stale", subtitle: "", nextChapterUrl: null, pinned: true, cachedAt: 1, storage: "cache" },
    }),
  }, 10000);
  const { cache } = createMemoryCache();
  const orphanRecord = { ...chapter("orphan", "body"), cachedAt: 2 };
  const orphanKey = `https://reader.example/__offline-chapter?url=${encodeURIComponent(orphanUrl)}`;
  await cache.put(orphanKey, new Response(JSON.stringify(orphanRecord)));
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });

  const reconcile = (store as unknown as { reconcile(): Promise<Set<string>> }).reconcile;
  assert.equal(typeof reconcile, "function");
  await reconcile.call(store);

  assert.deepEqual([...store.getCachedUrls()], [orphanUrl]);
  assert.equal(store.getMetadata(orphanUrl)?.title, "orphan");
  assert.equal(store.getMetadata(staleUrl), null);
});

test("failed physical deletion keeps the body recoverable but logically deleted", async () => {
  const url = "https://tw.linovelib.com/novel/1/600.html";
  const storage = createQuotaStorage({}, 10000);
  const healthy = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => healthy.cache, origin: "https://reader.example" });
  await store.save(url, chapter("不可遺失", "body"));
  const [bodyKey] = await healthy.cache.keys();
  assert.ok(bodyKey);

  const failingCache = { ...healthy.cache, delete: async () => { throw new DOMException("Delete failed", "InvalidStateError"); } };
  const failingStore = createChapterCacheStore({ storage, openCache: async () => failingCache, origin: "https://reader.example" });
  await assert.rejects(failingStore.remove(url), /標記刪除/);

  assert.equal(failingStore.getMetadata(url), null);
  assert.equal(await failingStore.load(url), null);
  assert.ok(await healthy.cache.match(typeof bodyKey === "string" ? bodyKey : bodyKey.url));
});

test("deleting a migrated chapter suppresses retained legacy until a new save", async () => {
  const url = "https://tw.linovelib.com/novel/1/retained-delete.html";
  const legacy = { ...chapter("retained-old", "old body"), cachedAt: 1, pinned: true };
  const legacyJson = JSON.stringify({ [url]: legacy });
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: legacyJson }, 100000);
  const memory = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await store.migrateLegacy();
  await store.remove(url);

  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), legacyJson);
  assert.equal(await store.load(url), null);
  assert.equal(store.getMetadata(url), null);
  assert.equal(store.getCachedUrls().has(url), false);

  await store.save(url, { ...chapter("fresh-download", "new body"), pinned: true });
  assert.equal((await store.load(url))?.title, "fresh-download");
  assert.equal(store.getCachedUrls().has(url), true);
});

test("an older paused delete cannot erase a later acknowledged immutable save", async () => {
  const url = "https://tw.linovelib.com/novel/1/delete-save-race.html";
  const storage = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const setup = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
  await setup.save(url, chapter("old", "old body"));

  let releaseDelete!: () => void;
  let announceDelete!: () => void;
  const deletePaused = new Promise<void>(resolve => { announceDelete = resolve; });
  const deleteRelease = new Promise<void>(resolve => { releaseDelete = resolve; });
  let paused = false;
  const pausedCache = {
    ...memory.cache,
    async delete(request: string) {
      if (!paused) {
        paused = true;
        announceDelete();
        await deleteRelease;
      }
      return await memory.cache.delete(request);
    },
  };
  const removingStore = createChapterCacheStore({ storage, openCache: async () => pausedCache, origin: "https://reader.example" });
  const savingStore = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  const removing = removingStore.remove(url);
  await deletePaused;
  await savingStore.save(url, chapter("fresh-acknowledged", "fresh body"));
  assert.equal((await savingStore.load(url))?.title, "fresh-acknowledged");

  releaseDelete();
  await removing;
  assert.equal((await savingStore.load(url))?.title, "fresh-acknowledged");
  assert.equal(savingStore.getMetadata(url)?.title, "fresh-acknowledged");
});

test("delete cannot capture a concurrent save body before its index commit", async () => {
  const url = "https://tw.linovelib.com/novel/1/save-delete-race.html";
  const storage = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const setup = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
  await setup.save(url, chapter("old", "old body"));

  let releasePut!: () => void;
  let announcePut!: () => void;
  const putPaused = new Promise<void>(resolve => { announcePut = resolve; });
  const putRelease = new Promise<void>(resolve => { releasePut = resolve; });
  let paused = false;
  const pausedCache = {
    ...memory.cache,
    async put(request: string, response: Response) {
      await memory.cache.put(request, response);
      if (!paused) {
        paused = true;
        announcePut();
        await putRelease;
      }
    },
  };
  const savingStore = createChapterCacheStore({ storage, openCache: async () => pausedCache, origin: "https://reader.example" });
  const removingStore = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  const saving = savingStore.save(url, chapter("fresh-after-delete", "fresh body"));
  await putPaused;
  await removingStore.remove(url);
  releasePut();
  await saving;

  assert.equal((await savingStore.load(url))?.title, "fresh-after-delete");
  assert.equal(savingStore.getMetadata(url)?.title, "fresh-after-delete");
});

test("malformed unrelated legacy data cannot block explicit deletion", async () => {
  const url = "https://tw.linovelib.com/novel/1/delete-with-broken-legacy.html";
  const storage = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
  await store.save(url, chapter("valid-v2", "body"));
  storage.setItem(LEGACY_CHAPTER_CACHE_KEY, JSON.stringify({ broken: { title: "bad" } }));

  await store.remove(url);

  assert.equal(store.getMetadata(url), null);
  assert.equal(await store.load(url), null);
  assert.equal(store.getCachedUrls().has(url), false);
});

test("failed authoritative delete-state commit preserves the readable body", async () => {
  const url = "https://tw.linovelib.com/novel/1/failed-state-delete.html";
  const base = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const healthy = createChapterCacheStore({ storage: base, openCache: async () => memory.cache, origin: "https://reader.example" });
  await healthy.save(url, chapter("still-readable", "body"));

  const failingStorage: StorageLike = {
    get length() { return base.length; },
    key: index => base.key(index),
    getItem: key => base.getItem(key),
    setItem(key, value) {
      if (key.startsWith("linovelib-chapter-cache-state-v1:") && value.includes('"kind":"deleted"')) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      base.setItem(key, value);
    },
    removeItem: key => base.removeItem(key),
  };
  const failing = createChapterCacheStore({ storage: failingStorage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await assert.rejects(failing.remove(url), /刪除離線內容失敗/);
  assert.equal((await healthy.load(url))?.title, "still-readable");
  assert.equal(healthy.getMetadata(url)?.title, "still-readable");
  assert.equal(memory.entries.size, 1);
});

test("a failed save cleanup cannot roll back another acknowledged per-chapter state", async () => {
  const url = "https://tw.linovelib.com/novel/1/no-stale-state-rollback.html";
  const storage = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const normal = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
  await normal.save(url, chapter("old", "old"));
  await normal.remove(url);

  let releaseB!: () => void;
  let announceB!: () => void;
  const bPaused = new Promise<void>(resolve => { announceB = resolve; });
  const bRelease = new Promise<void>(resolve => { releaseB = resolve; });
  let bDidPause = false;
  const bCache = {
    ...memory.cache,
    async put(request: string, response: Response) {
      await memory.cache.put(request, response);
      if (!bDidPause) {
        bDidPause = true;
        announceB();
        await bRelease;
      }
    },
  };
  const storeB = createChapterCacheStore({ storage, openCache: async () => bCache, origin: "https://reader.example" });
  const saveB = storeB.save(url, chapter("acknowledged-B", "B"));
  await bPaused;

  let aBodyKey = "";
  let releaseRollback!: () => void;
  let announceRollback!: () => void;
  const rollbackPaused = new Promise<void>(resolve => { announceRollback = resolve; });
  const rollbackRelease = new Promise<void>(resolve => { releaseRollback = resolve; });
  const failingStorage: StorageLike = {
    get length() { return storage.length; },
    key: index => storage.key(index),
    getItem: key => storage.getItem(key),
    setItem(key, value) {
      if (key.startsWith("linovelib-chapter-cache-state-v1:") && value.includes('"kind":"saved"')) {
        throw new DOMException("State write failed", "QuotaExceededError");
      }
      storage.setItem(key, value);
    },
    removeItem: key => storage.removeItem(key),
  };
  const aCache = {
    ...memory.cache,
    async put(request: string, response: Response) {
      aBodyKey = request;
      await memory.cache.put(request, response);
    },
    async delete(request: string) {
      if (request === aBodyKey) {
        announceRollback();
        await rollbackRelease;
      }
      return await memory.cache.delete(request);
    },
  };
  const storeA = createChapterCacheStore({ storage: failingStorage, openCache: async () => aCache, origin: "https://reader.example" });
  const saveA = storeA.save(url, chapter("failing-A", "A"));
  await rollbackPaused;

  releaseB();
  await saveB;
  assert.equal(storeB.getMetadata(url)?.title, "acknowledged-B");
  releaseRollback();
  await assert.rejects(saveA, /狀態寫入失敗/);

  assert.equal((await storeB.load(url))?.title, "acknowledged-B");
  assert.equal(storeB.getMetadata(url)?.title, "acknowledged-B");
});

test("wall-clock rollback cannot resurrect a logically deleted body", async () => {
  const url = "https://tw.linovelib.com/novel/1/clock-rollback.html";
  const storage = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const realNow = Date.now;
  let now = 10000;
  Date.now = () => now;
  try {
    const healthy = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
    await healthy.save(url, chapter("future-body", "body"));
    now = 5000;
    const failingCache = { ...memory.cache, async delete() { throw new DOMException("Delete failed", "InvalidStateError"); } };
    const removing = createChapterCacheStore({ storage, openCache: async () => failingCache, origin: "https://reader.example" });

    await assert.rejects(removing.remove(url), /已標記刪除/);
    assert.equal(await removing.load(url), null);
    assert.equal(removing.getMetadata(url), null);
    assert.equal(memory.entries.size, 1, "load must not physically delete the recoverable body");
  } finally {
    Date.now = realNow;
  }
});

test("a paused legacy-tombstone load cannot delete a later acknowledged state body", async () => {
  const url = "https://tw.linovelib.com/novel/1/stale-advisory-load.html";
  const storage = createQuotaStorage({ [CHAPTER_CACHE_DELETED_KEY]: JSON.stringify({ [url]: 10000 }) }, 100000);
  const memory = createMemoryCache();
  let releaseKeys!: () => void;
  let announceKeys!: () => void;
  const keysPaused = new Promise<void>(resolve => { announceKeys = resolve; });
  const keysRelease = new Promise<void>(resolve => { releaseKeys = resolve; });
  let paused = false;
  const slowCache = {
    ...memory.cache,
    async keys() {
      if (!paused) {
        paused = true;
        announceKeys();
        await keysRelease;
      }
      return await memory.cache.keys();
    },
  };
  const loadingStore = createChapterCacheStore({ storage, openCache: async () => slowCache, origin: "https://reader.example" });
  const loading = loadingStore.load(url);
  await keysPaused;

  const realNow = Date.now;
  Date.now = () => 5000;
  try {
    const savingStore = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
    await savingStore.save(url, chapter("acknowledged", "body"));
    assert.equal(savingStore.getMetadata(url)?.title, "acknowledged");
  } finally {
    Date.now = realNow;
  }

  releaseKeys();
  assert.equal((await loading)?.title, "acknowledged");
  assert.equal((await loadingStore.load(url))?.title, "acknowledged");
  assert.equal(loadingStore.getMetadata(url)?.title, "acknowledged");
  assert.equal(memory.entries.size, 1);
});

test("automatic cache eviction keeps the newest 300 entries and every pinned download", async () => {
  const storage = createQuotaStorage({}, 500000);
  const { cache } = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => cache, origin: "https://reader.example" });
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now++;
  try {
    await store.save("https://tw.linovelib.com/pinned.html", chapter("pinned", "body"));
    for (let i = 0; i < 302; i++) {
      await store.save(`https://tw.linovelib.com/auto-${i}.html`, { ...chapter(`auto-${i}`, "body"), pinned: false });
    }
  } finally {
    Date.now = originalNow;
  }

  const urls = store.getCachedUrls();
  assert.equal(urls.size, 301);
  assert.ok(urls.has("https://tw.linovelib.com/pinned.html"));
  assert.ok(!urls.has("https://tw.linovelib.com/auto-0.html"));
  assert.ok(!urls.has("https://tw.linovelib.com/auto-1.html"));
  assert.ok(urls.has("https://tw.linovelib.com/auto-301.html"));
});

test("paused eviction cannot tombstone a later acknowledged refresh", async () => {
  const storage = createQuotaStorage({}, 2_000_000);
  const memory = createMemoryCache();
  const index: Record<string, { title: string; subtitle: string; nextChapterUrl: string | null; cachedAt: number; pinned?: boolean; storage: "cache"; bodyKey: string }> = {};
  const urls = Array.from({ length: 302 }, (_, i) => `https://tw.linovelib.com/eviction-race-${i}.html`);
  for (let i = 0; i < urls.length; i++) {
    const chapterUrl = urls[i];
    const bodyKey = `https://reader.example/__offline-chapter?url=${encodeURIComponent(chapterUrl)}&v=seed-${i}`;
    const record = { ...chapter(`seed-${i}`, "body"), pinned: false, cachedAt: i + 1 };
    const metadata = {
      title: record.title,
      subtitle: record.subtitle,
      nextChapterUrl: record.nextChapterUrl,
      cachedAt: record.cachedAt,
      pinned: false,
      storage: "cache" as const,
      bodyKey,
    };
    await memory.cache.put(bodyKey, new Response(JSON.stringify(record)));
    storage.setItem(`${CHAPTER_CACHE_STATE_PREFIX}${chapterUrl}`, JSON.stringify({ kind: "saved", bodyKey, metadata }));
    index[chapterUrl] = metadata;
  }
  storage.setItem(CHAPTER_CACHE_INDEX_KEY, JSON.stringify(index));

  let releaseDelete!: () => void;
  let announceDelete!: () => void;
  const deletePaused = new Promise<void>(resolve => { announceDelete = resolve; });
  const deleteRelease = new Promise<void>(resolve => { releaseDelete = resolve; });
  let paused = false;
  const slowDeleteCache = {
    ...memory.cache,
    async delete(request: string) {
      if (!paused) {
        paused = true;
        announceDelete();
        await deleteRelease;
      }
      return await memory.cache.delete(request);
    },
  };
  const evictingStore = createChapterCacheStore({ storage, openCache: async () => slowDeleteCache, origin: "https://reader.example" });
  const eviction = evictingStore.save("https://tw.linovelib.com/eviction-trigger.html", { ...chapter("trigger", "body"), pinned: false });
  await deletePaused;

  const refreshedUrl = urls[1];
  const refreshingStore = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
  await refreshingStore.save(refreshedUrl, { ...chapter("fresh-acknowledged", "fresh body"), pinned: false });
  assert.equal((await refreshingStore.load(refreshedUrl))?.title, "fresh-acknowledged");

  releaseDelete();
  await eviction;
  assert.equal((await evictingStore.load(refreshedUrl))?.title, "fresh-acknowledged");
  assert.equal(evictingStore.getMetadata(refreshedUrl)?.title, "fresh-acknowledged");
  assert.equal(evictingStore.getCachedUrls().has(refreshedUrl), true);
});

test("a delete invoked during load cannot be undone by late metadata repair", async () => {
  const url = "https://tw.linovelib.com/novel/1/load-race.html";
  const storage = createQuotaStorage({}, 10000);
  const memory = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });
  await store.save(url, chapter("old", "body"));

  let releaseMatch!: () => void;
  let matchStarted!: () => void;
  const started = new Promise<void>(resolve => { matchStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseMatch = resolve; });
  let block = true;
  const delayedCache = {
    ...memory.cache,
    async match(request: string) {
      const response = await memory.cache.match(request);
      if (block) {
        block = false;
        matchStarted();
        await gate;
      }
      return response;
    },
  };
  const delayedStore = createChapterCacheStore({ storage, openCache: async () => delayedCache, origin: "https://reader.example" });
  const loading = delayedStore.load(url);
  await started;
  const removing = delayedStore.remove(url);
  releaseMatch();
  await Promise.all([loading, removing]);

  assert.equal(delayedStore.getMetadata(url), null);
  assert.equal(await delayedStore.load(url), null);
});

test("migration rolls back Cache Storage when an unlocked legacy payload changes mid-copy", async () => {
  const url = "https://tw.linovelib.com/novel/1/legacy-race.html";
  const oldLegacy = { ...chapter("legacy-old", "old"), cachedAt: 10 };
  const newerLegacy = { ...chapter("legacy-new", "new"), cachedAt: 30 };
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: JSON.stringify({ [url]: oldLegacy }) }, 100000);
  const memory = createMemoryCache();
  const key = `https://reader.example/__offline-chapter?url=${encodeURIComponent(url)}`;
  await memory.cache.put(key, new Response(JSON.stringify({ ...chapter("existing-cache", "cache"), cachedAt: 5 })));
  const changingCache = {
    ...memory.cache,
    async put(request: string, response: Response) {
      await memory.cache.put(request, response);
      storage.setItem(LEGACY_CHAPTER_CACHE_KEY, JSON.stringify({ [url]: newerLegacy }));
    },
  };
  const store = createChapterCacheStore({ storage, openCache: async () => changingCache, origin: "https://reader.example" });

  await assert.rejects(store.migrateLegacy(), /遷移期間已變更/);
  const body = await (await memory.cache.match(key))?.json() as { title?: string } | undefined;
  assert.equal(body?.title, "existing-cache");
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), JSON.stringify({ [url]: newerLegacy }));
});

test("a valid orphaned body remains readable when metadata repair is unavailable", async () => {
  const url = "https://tw.linovelib.com/novel/1/orphan-no-storage.html";
  const baseStorage = createQuotaStorage({}, 10000);
  const storage = {
    ...baseStorage,
    setItem(key: string, value: string) {
      if (key === CHAPTER_CACHE_INDEX_KEY) throw new DOMException("Storage disabled", "SecurityError");
      baseStorage.setItem(key, value);
    },
  };
  const memory = createMemoryCache();
  const key = `https://reader.example/__offline-chapter?url=${encodeURIComponent(url)}`;
  await memory.cache.put(key, new Response(JSON.stringify({ ...chapter("readable", "body"), cachedAt: 100 })));
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  assert.equal((await store.load(url))?.title, "readable");
});

test("newer stale metadata cannot discard the only valid legacy body", async () => {
  const url = "https://tw.linovelib.com/novel/1/stale-newer.html";
  const legacy = { ...chapter("legacy-only", "body"), cachedAt: 10 };
  const legacyJson = JSON.stringify({ [url]: legacy });
  const storage = createQuotaStorage({
    [LEGACY_CHAPTER_CACHE_KEY]: legacyJson,
    [CHAPTER_CACHE_INDEX_KEY]: JSON.stringify({
      [url]: { title: "stale", subtitle: "", nextChapterUrl: null, prevChapterUrl: null, pinned: true, cachedAt: 20, storage: "cache" },
    }),
  }, 100000);
  const memory = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await store.migrateLegacy();
  assert.equal((await store.load(url))?.title, "legacy-only");
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), legacyJson);
});

test("legacy entries with unknown node shapes are retained", async () => {
  const url = "https://tw.linovelib.com/novel/1/invalid-node.html";
  const raw = JSON.stringify({
    [url]: { title: "invalid", subtitle: "", nodes: [{}], nextChapterUrl: null, prevChapterUrl: null, cachedAt: 1 },
  });
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: raw }, 100000);
  const memory = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await assert.rejects(store.migrateLegacy(), /格式不完整/);
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), raw);
});

test("automatic saves cannot downgrade an explicitly pinned chapter", async () => {
  const url = "https://tw.linovelib.com/novel/1/pinned.html";
  const storage = createQuotaStorage({}, 100000);
  const memory = createMemoryCache();
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await store.save(url, chapter("downloaded", "body"));
  await store.save(url, { ...chapter("automatic-refresh", "body"), pinned: false });
  assert.equal((await store.load(url))?.pinned, true);
});

test("Cache Storage remains readable when localStorage reads throw SecurityError", async () => {
  const url = "https://tw.linovelib.com/novel/1/storage-blocked.html";
  const storage: StorageLike = {
    get length(): number { throw new DOMException("Blocked", "SecurityError"); },
    key() { throw new DOMException("Blocked", "SecurityError"); },
    getItem() { throw new DOMException("Blocked", "SecurityError"); },
    setItem() { throw new DOMException("Blocked", "SecurityError"); },
    removeItem() { throw new DOMException("Blocked", "SecurityError"); },
  };
  const memory = createMemoryCache();
  const key = `https://reader.example/__offline-chapter?url=${encodeURIComponent(url)}`;
  await memory.cache.put(key, new Response(JSON.stringify({ ...chapter("still-readable", "body"), cachedAt: 9 })));
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  assert.equal(store.getMetadata(url), null);
  assert.deepEqual([...store.getCachedUrls()], []);
  assert.equal((await store.load(url))?.title, "still-readable");
});

test("failed eviction index commit cannot leave advertised metadata without its body", async () => {
  let writes = 0;
  let failAtWrite = Number.POSITIVE_INFINITY;
  const baseStorage = createQuotaStorage({}, 1_000_000);
  const storage: StorageLike = {
    get length() { return baseStorage.length; },
    key: index => baseStorage.key(index),
    getItem: key => baseStorage.getItem(key),
    setItem(key, value) {
      writes += 1;
      if (writes >= failAtWrite) throw new DOMException("Quota exceeded", "QuotaExceededError");
      baseStorage.setItem(key, value);
    },
    removeItem: key => baseStorage.removeItem(key),
  };
  const memory = createMemoryCache();
  let deletionStarted = false;
  const fragileCache = {
    ...memory.cache,
    async delete(request: string) {
      deletionStarted = true;
      return await memory.cache.delete(request);
    },
    async put(request: string, response: Response) {
      if (deletionStarted) throw new DOMException("Restore failed", "InvalidStateError");
      await memory.cache.put(request, response);
    },
  };
  const store = createChapterCacheStore({ storage, openCache: async () => fragileCache, origin: "https://reader.example" });
  for (let i = 0; i < 300; i += 1) {
    await store.save(`https://tw.linovelib.com/auto-${i}.html`, { ...chapter(`auto-${i}`, "body"), pinned: false });
  }
  const oldestUrl = "https://tw.linovelib.com/auto-0.html";
  const indexBeforeEviction = JSON.parse(baseStorage.getItem(CHAPTER_CACHE_INDEX_KEY) ?? "{}") as Record<string, { bodyKey?: string }>;
  const oldestKey = indexBeforeEviction[oldestUrl]?.bodyKey;
  assert.ok(oldestKey);
  failAtWrite = writes + 2; // The new entry commits; the eviction-index commit fails.
  await store.save("https://tw.linovelib.com/auto-300.html", { ...chapter("auto-300", "body"), pinned: false });

  assert.equal(deletionStarted, false, "body deletion must wait until the reduced index commits");
  assert.ok(store.getMetadata(oldestUrl), "failed index commit should leave the prior metadata intact");
  assert.ok(await memory.cache.match(oldestKey), "body must not be deleted before the index commit succeeds");
});

test("migration rechecks legacy after asynchronous Cache validation before index commit", async () => {
  const url = "https://tw.linovelib.com/novel/1/late-legacy-race.html";
  const initialLegacy = { ...chapter("legacy", "old"), cachedAt: 10 };
  const changedLegacy = { ...chapter("legacy-updated", "new"), cachedAt: 30 };
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: JSON.stringify({ [url]: initialLegacy }) }, 100000);
  const memory = createMemoryCache();
  const key = `https://reader.example/__offline-chapter?url=${encodeURIComponent(url)}`;
  await memory.cache.put(key, new Response(JSON.stringify({ ...chapter("canonical-newer", "cache"), cachedAt: 20 })));
  let matches = 0;
  const changingCache = {
    ...memory.cache,
    async match(request: string) {
      matches += 1;
      const response = await memory.cache.match(request);
      if (matches === 2) {
        storage.setItem(LEGACY_CHAPTER_CACHE_KEY, JSON.stringify({ [url]: changedLegacy }));
      }
      return response;
    },
  };
  const store = createChapterCacheStore({ storage, openCache: async () => changingCache, origin: "https://reader.example" });

  await assert.rejects(store.migrateLegacy(), /遷移驗證期間已變更/);
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), JSON.stringify({ [url]: changedLegacy }));
  assert.equal((await (await memory.cache.match(key))?.json() as { title?: string }).title, "canonical-newer");
});

test("newer legacy content cannot demote an existing pinned Cache body", async () => {
  const url = "https://tw.linovelib.com/novel/1/pin-migration.html";
  const legacy = { ...chapter("newer-old-tab-content", "legacy"), cachedAt: 20, pinned: false };
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: JSON.stringify({ [url]: legacy }) }, 100000);
  const memory = createMemoryCache();
  const key = `https://reader.example/__offline-chapter?url=${encodeURIComponent(url)}`;
  await memory.cache.put(key, new Response(JSON.stringify({ ...chapter("explicit-download", "cache"), cachedAt: 10, pinned: true })));
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await store.migrateLegacy();

  const migrated = await store.load(url);
  assert.equal(migrated?.title, "newer-old-tab-content");
  assert.equal(migrated?.pinned, true);
  assert.equal(store.getMetadata(url)?.pinned, true);
});

test("older pinned legacy state upgrades a newer automatic Cache body without replacing its content", async () => {
  const url = "https://tw.linovelib.com/novel/1/pin-migration-opposite.html";
  const legacy = { ...chapter("older-explicit-download", "legacy"), cachedAt: 10, pinned: true };
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: JSON.stringify({ [url]: legacy }) }, 100000);
  const memory = createMemoryCache();
  const key = `https://reader.example/__offline-chapter?url=${encodeURIComponent(url)}`;
  await memory.cache.put(key, new Response(JSON.stringify({ ...chapter("newer-automatic-content", "cache"), cachedAt: 20, pinned: false })));
  const store = createChapterCacheStore({ storage, openCache: async () => memory.cache, origin: "https://reader.example" });

  await store.migrateLegacy();

  const migrated = await store.load(url);
  assert.equal(migrated?.title, "newer-automatic-content");
  assert.equal(migrated?.pinned, true);
  assert.equal(store.getMetadata(url)?.pinned, true);
});

test("concurrent stores retain legacy while sharing the copied Cache body", async () => {
  const url = "https://tw.linovelib.com/novel/1/no-lock.html";
  const legacy = { ...chapter("legacy-safe-fallback", "body"), cachedAt: 1 };
  const raw = JSON.stringify({ [url]: legacy });
  const storage = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: raw }, 100000);
  const memory = createMemoryCache();
  const options = {
    storage,
    openCache: async () => memory.cache,
    origin: "https://reader.example",
  };
  const first = createChapterCacheStore(options);
  const second = createChapterCacheStore(options);

  await Promise.all([first.migrateLegacy(), second.migrateLegacy()]);

  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), raw);
  assert.equal((await memory.cache.keys()).length, 1);
  assert.equal((await first.load(url))?.title, "legacy-safe-fallback");
  assert.equal((await second.load(url))?.title, "legacy-safe-fallback");
});

test("successful migration never removes the legacy payload", async () => {
  const url = "https://tw.linovelib.com/novel/1/remove-race.html";
  const legacy = { ...chapter("legacy-must-survive", "body"), cachedAt: 1 };
  const raw = JSON.stringify({ [url]: legacy });
  const base = createQuotaStorage({ [LEGACY_CHAPTER_CACHE_KEY]: raw }, 100000);
  let legacyRemoveCalls = 0;
  const storage = {
    get length() { return base.length; },
    key: (index: number) => base.key(index),
    getItem: (key: string) => base.getItem(key),
    setItem: (key: string, value: string) => base.setItem(key, value),
    removeItem: (key: string) => {
      if (key === LEGACY_CHAPTER_CACHE_KEY) legacyRemoveCalls += 1;
      base.removeItem(key);
    },
  };
  const memory = createMemoryCache();
  let putCalls = 0;
  const trackedCache = {
    ...memory.cache,
    put: async (...args: Parameters<typeof memory.cache.put>) => {
      putCalls += 1;
      return await memory.cache.put(...args);
    },
  };
  const store = createChapterCacheStore({ storage, openCache: async () => trackedCache, origin: "https://reader.example" });

  await store.migrateLegacy();
  await store.migrateLegacy();

  assert.equal(putCalls, 1);
  assert.equal(legacyRemoveCalls, 0);
  assert.equal(storage.getItem(LEGACY_CHAPTER_CACHE_KEY), raw);
  assert.equal((await store.load(url))?.title, "legacy-must-survive");
});
