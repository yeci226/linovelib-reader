export const LEGACY_CHAPTER_CACHE_KEY = "linovelib-chapter-cache";
export const CHAPTER_CACHE_INDEX_KEY = "linovelib-chapter-cache-index-v2";
export const CHAPTER_CONTENT_CACHE_NAME = "linovelib-chapter-content-v1";

const CHAPTER_CACHE_DELETED_KEY = "linovelib-chapter-cache-deleted-v1";
const CHAPTER_CACHE_STATE_PREFIX = "linovelib-chapter-cache-state-v1:";
const LEGACY_CHAPTER_CACHE_SNAPSHOT_KEY = "linovelib-chapter-cache-legacy-snapshot-v1";
const MAX_AUTOMATIC_CHAPTERS = 300;

export type ContentNode =
  | { type: "text"; text: string }
  | { type: "image"; src: string; alt: string }
  | { type: "page-number"; text: string };

export type ChapterCache = {
  title: string;
  subtitle: string;
  nodes: ContentNode[];
  nextChapterUrl: string | null;
  prevChapterUrl?: string | null;
  pinned?: boolean;
  cachedAt: number;
};

type ChapterCacheInput = Omit<ChapterCache, "cachedAt">;
type ChapterCacheMetadata = Omit<ChapterCache, "nodes"> & { storage: "cache"; bodyKey?: string };
type ChapterCacheIndex = Record<string, ChapterCacheMetadata>;
type ChapterCacheState =
  | { kind: "saved"; bodyKey: string; metadata: ChapterCacheMetadata }
  | { kind: "deleted"; bodyKey?: string };

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
};

type CachedResponseLike = {
  json(): Promise<unknown>;
  clone(): Response;
};

type CacheKeyLike = string | { url: string };

type CacheLike = {
  match(request: string): Promise<CachedResponseLike | undefined>;
  put(request: string, response: Response): Promise<unknown>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<readonly CacheKeyLike[]>;
};

type ChapterCacheStoreOptions = {
  storage: StorageLike;
  openCache: () => Promise<CacheLike>;
  origin: string;
  runExclusive?: <T>(task: () => Promise<T>) => Promise<T>;
};

function parseMap<T>(value: string | null): Record<string, T> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, T> : {};
  } catch {
    return {};
  }
}

function toMetadata(record: ChapterCache, bodyKey?: string): ChapterCacheMetadata {
  const { nodes: _nodes, ...metadata } = record;
  return { ...metadata, storage: "cache", ...(bodyKey ? { bodyKey } : {}) };
}

function isContentNode(value: unknown): value is ContentNode {
  if (!value || typeof value !== "object") return false;
  const node = value as { type?: unknown; text?: unknown; src?: unknown; alt?: unknown };
  if (node.type === "text" || node.type === "page-number") return typeof node.text === "string";
  if (node.type === "image") return typeof node.src === "string" && typeof node.alt === "string";
  return false;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isChapterCache(value: unknown): value is ChapterCache {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChapterCache>;
  return typeof record.title === "string"
    && typeof record.subtitle === "string"
    && Array.isArray(record.nodes)
    && record.nodes.every(isContentNode)
    && isNullableString(record.nextChapterUrl)
    && (record.prevChapterUrl === undefined || isNullableString(record.prevChapterUrl))
    && (record.pinned === undefined || typeof record.pinned === "boolean")
    && typeof record.cachedAt === "number"
    && Number.isFinite(record.cachedAt);
}

function isMetadata(value: unknown): value is ChapterCacheMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChapterCacheMetadata>;
  return typeof record.title === "string"
    && typeof record.subtitle === "string"
    && isNullableString(record.nextChapterUrl)
    && (record.prevChapterUrl === undefined || isNullableString(record.prevChapterUrl))
    && (record.pinned === undefined || typeof record.pinned === "boolean")
    && typeof record.cachedAt === "number"
    && Number.isFinite(record.cachedAt)
    && (record.bodyKey === undefined || typeof record.bodyKey === "string")
    && record.storage === "cache";
}

function storageError(message: string, cause: unknown): Error {
  const detail = cause instanceof Error && cause.message ? `：${cause.message}` : "";
  return new Error(`${message}${detail}`, { cause });
}

async function fingerprintLegacy(value: string): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function createChapterCacheStore(options: ChapterCacheStoreOptions) {
  const { storage, openCache, origin, runExclusive } = options;
  let mutationTail: Promise<void> = Promise.resolve();

  const cachePrefix = new URL("/__offline-chapter", origin).toString();
  const stableCacheKey = (chapterUrl: string) => `${cachePrefix}?url=${encodeURIComponent(chapterUrl)}`;
  const newBodyKey = (chapterUrl: string) => `${stableCacheKey(chapterUrl)}&v=${Date.now()}-${globalThis.crypto.randomUUID()}`;
  const chapterUrlFromBodyKey = (bodyKey: string) => {
    try {
      const parsed = new URL(bodyKey);
      return parsed.toString().startsWith(`${cachePrefix}?`) ? parsed.searchParams.get("url") : null;
    } catch {
      return null;
    }
  };
  const getItem = (key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const readLegacy = () => {
    const raw = parseMap<unknown>(getItem(LEGACY_CHAPTER_CACHE_KEY));
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, ChapterCache] => isChapterCache(entry[1])));
  };
  const readDeleted = (): Record<string, number> => {
    const raw = parseMap<unknown>(getItem(CHAPTER_CACHE_DELETED_KEY));
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1])
    ));
  };
  const writeDeleted = (deleted: Record<string, number>) => {
    if (Object.keys(deleted).length === 0) storage.removeItem(CHAPTER_CACHE_DELETED_KEY);
    else storage.setItem(CHAPTER_CACHE_DELETED_KEY, JSON.stringify(deleted));
  };
  const stateKey = (chapterUrl: string) => `${CHAPTER_CACHE_STATE_PREFIX}${chapterUrl}`;
  const readState = (chapterUrl: string): ChapterCacheState | null => {
    try {
      const raw = storage.getItem(stateKey(chapterUrl));
      if (!raw) return null;
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "deleted") {
        const bodyKey = (value as { bodyKey?: unknown }).bodyKey;
        return { kind: "deleted", ...(typeof bodyKey === "string" ? { bodyKey } : {}) };
      }
      if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "saved") {
        const saved = value as { kind: "saved"; bodyKey?: unknown; metadata?: unknown };
        if (typeof saved.bodyKey === "string" && isMetadata(saved.metadata)) {
          return { kind: "saved", bodyKey: saved.bodyKey, metadata: { ...saved.metadata, bodyKey: saved.bodyKey } };
        }
      }
    } catch {
      // Treat unavailable or corrupt state as absent and fall back to recoverable bodies.
    }
    return null;
  };
  const writeState = (chapterUrl: string, state: ChapterCacheState) => {
    storage.setItem(stateKey(chapterUrl), JSON.stringify(state));
  };
  const listStateUrls = (): string[] => {
    try {
      if (typeof storage.length !== "number" || typeof storage.key !== "function") return [];
      const urls: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(CHAPTER_CACHE_STATE_PREFIX)) urls.push(key.slice(CHAPTER_CACHE_STATE_PREFIX.length));
      }
      return urls;
    } catch {
      return [];
    }
  };
  const legacyIsDeleted = (chapterUrl: string, record: ChapterCache | null) =>
    !!record && record.cachedAt <= (readDeleted()[chapterUrl] ?? -Infinity);
  const readIndex = (): ChapterCacheIndex => {
    const raw = parseMap<unknown>(getItem(CHAPTER_CACHE_INDEX_KEY));
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, ChapterCacheMetadata] => isMetadata(entry[1])));
  };

  function writeIndex(index: ChapterCacheIndex): void {
    if (Object.keys(index).length > 0) storage.setItem(CHAPTER_CACHE_INDEX_KEY, JSON.stringify(index));
    else storage.removeItem(CHAPTER_CACHE_INDEX_KEY);
  }

  function mutate<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(() => runExclusive ? runExclusive(task) : task());
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function putContent(cache: CacheLike, bodyKey: string, record: ChapterCache): Promise<void> {
    await cache.put(
      bodyKey,
      new Response(JSON.stringify(record), { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
  }

  async function findBodies(cache: CacheLike, chapterUrl: string): Promise<Array<{ bodyKey: string; record: ChapterCache }>> {
    const bodies: Array<{ bodyKey: string; record: ChapterCache }> = [];
    for (const request of await cache.keys()) {
      const bodyKey = typeof request === "string" ? request : request.url;
      if (chapterUrlFromBodyKey(bodyKey) !== chapterUrl) continue;
      try {
        const response = await cache.match(bodyKey);
        const value = response ? await response.json() : null;
        if (isChapterCache(value)) bodies.push({ bodyKey, record: value });
      } catch {
        // Invalid bodies are ignored and never advertised.
      }
    }
    return bodies;
  }

  async function findBestBody(cache: CacheLike, chapterUrl: string): Promise<{ bodyKey: string; record: ChapterCache } | null> {
    const bodies = await findBodies(cache, chapterUrl);
    if (bodies.length === 0) return null;
    const preferred = bodies.reduce((best, current) => current.record.cachedAt > best.record.cachedAt ? current : best);
    return {
      bodyKey: preferred.bodyKey,
      record: { ...preferred.record, pinned: bodies.some(body => body.record.pinned) || undefined },
    };
  }

  async function migrateLegacyUnlocked(): Promise<void> {
    const legacyJson = getItem(LEGACY_CHAPTER_CACHE_KEY);
    if (!legacyJson) return;
    const fingerprint = await fingerprintLegacy(legacyJson);
    if (fingerprint && getItem(LEGACY_CHAPTER_CACHE_SNAPSHOT_KEY) === fingerprint) return;
    const markSnapshot = () => {
      if (!fingerprint) return;
      try {
        storage.setItem(LEGACY_CHAPTER_CACHE_SNAPSHOT_KEY, fingerprint);
      } catch {
        // Repeating a safe migration is preferable to failing chapter reads.
      }
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(legacyJson);
    } catch (error) {
      throw storageError("舊版離線內容格式無法解析，已保留原始資料", error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("舊版離線內容格式無法解析，已保留原始資料");
    }
    const allEntries = Object.entries(parsed as Record<string, unknown>);
    if (allEntries.some(([, record]) => !isChapterCache(record))) {
      throw new Error("舊版離線內容格式不完整，已保留原始資料");
    }
    if (allEntries.length === 0) {
      markSnapshot();
      return;
    }

    const deleted = readDeleted();
    const entries = allEntries.filter(([chapterUrl, record]) =>
      (record as ChapterCache).cachedAt > (deleted[chapterUrl] ?? -Infinity)
    );
    if (entries.length === 0) {
      markSnapshot();
      return;
    }

    const cache = await openCache();
    const touchedBodyKeys: string[] = [];
    const canonicalRecords = new Map<string, { record: ChapterCache; bodyKey: string }>();
    const rollbackBodies = async () => {
      for (const bodyKey of touchedBodyKeys) await cache.delete(bodyKey);
    };

    try {
      for (const [chapterUrl, value] of entries) {
        const legacyRecord = value as ChapterCache;
        const existing = await findBestBody(cache, chapterUrl);
        const preferredRecord = existing && existing.record.cachedAt > legacyRecord.cachedAt
          ? existing.record
          : legacyRecord;
        const canonicalRecord: ChapterCache = {
          ...preferredRecord,
          pinned: legacyRecord.pinned || existing?.record.pinned || undefined,
        };
        if (existing && preferredRecord === existing.record && canonicalRecord.pinned === existing.record.pinned) {
          canonicalRecords.set(chapterUrl, existing);
          continue;
        }
        const bodyKey = newBodyKey(chapterUrl);
        await putContent(cache, bodyKey, canonicalRecord);
        touchedBodyKeys.push(bodyKey);
        canonicalRecords.set(chapterUrl, { record: canonicalRecord, bodyKey });
      }
    } catch (error) {
      await rollbackBodies().catch(() => undefined);
      throw storageError("舊版離線內容遷移失敗", error);
    }

    // An old app tab may not participate in Web Locks. Never index a copy from a
    // stale payload that changed during migration.
    if (getItem(LEGACY_CHAPTER_CACHE_KEY) !== legacyJson) {
      await rollbackBodies().catch(() => undefined);
      throw new Error("舊版離線內容在遷移期間已變更，將於下次重試");
    }

    // Do not trust index timestamps: every selected body key must be readable.
    try {
      for (const [chapterUrl, canonical] of canonicalRecords) {
        const response = await cache.match(canonical.bodyKey);
        const value = response ? await response.json() : null;
        if (!isChapterCache(value)) throw new Error(`章節正文未持久化：${chapterUrl}`);
      }
    } catch (error) {
      await rollbackBodies().catch(() => undefined);
      throw storageError("舊版離線內容遷移驗證失敗", error);
    }

    const nextIndex = readIndex();
    for (const [chapterUrl, canonical] of canonicalRecords) {
      nextIndex[chapterUrl] = toMetadata(canonical.record, canonical.bodyKey);
    }

    // Validate that the snapshot stayed stable while asynchronous Cache reads ran.
    // The immutable body keys make rollback safe even when another store succeeds.
    if (getItem(LEGACY_CHAPTER_CACHE_KEY) !== legacyJson) {
      await rollbackBodies().catch(() => undefined);
      throw new Error("舊版離線內容在遷移驗證期間已變更，將於下次重試");
    }

    try {
      writeIndex(nextIndex);
      const nextDeleted = readDeleted();
      let changed = false;
      for (const [chapterUrl, record] of entries as [string, ChapterCache][]) {
        if (record.cachedAt > (nextDeleted[chapterUrl] ?? Infinity)) {
          delete nextDeleted[chapterUrl];
          changed = true;
        }
      }
      if (changed) writeDeleted(nextDeleted);
    } catch (error) {
      // Keep both the untouched legacy payload and complete immutable Cache copies.
      throw storageError("離線內容索引遷移失敗", error);
    }
    markSnapshot();
  }

  async function migrateLegacy(): Promise<void> {
    await mutate(migrateLegacyUnlocked);
  }

  async function evictAutomaticUnlocked(cache: CacheLike): Promise<void> {
    const index = readIndex();
    for (const chapterUrl of listStateUrls()) {
      const state = readState(chapterUrl);
      if (state?.kind === "saved") index[chapterUrl] = state.metadata;
      else if (state?.kind === "deleted") delete index[chapterUrl];
    }
    const automatic = Object.entries(index)
      .filter(([, metadata]) => !metadata.pinned)
      .sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    const expired = automatic.slice(MAX_AUTOMATIC_CHAPTERS);
    if (expired.length === 0) return;

    for (const [chapterUrl] of expired) delete index[chapterUrl];
    try {
      writeIndex(index);
    } catch {
      // Per-chapter state remains authoritative.
    }

    let deletionError: unknown;
    for (const [chapterUrl, metadata] of expired) {
      const candidateBodyKey = metadata.bodyKey ?? stableCacheKey(chapterUrl);
      const currentState = readState(chapterUrl);
      if (currentState?.kind === "saved" && currentState.bodyKey !== candidateBodyKey) continue;
      if (currentState?.kind === "deleted" && currentState.bodyKey !== candidateBodyKey) continue;
      try {
        writeState(chapterUrl, { kind: "deleted", bodyKey: candidateBodyKey });
      } catch (error) {
        deletionError ??= error;
        continue;
      }
      try {
        await cache.delete(metadata.bodyKey ?? stableCacheKey(chapterUrl));
      } catch (error) {
        deletionError ??= error;
      }
    }
    if (deletionError) throw deletionError;
  }

  function getMetadata(chapterUrl: string): ChapterCache | null {
    if (!chapterUrl) return null;
    const state = readState(chapterUrl);
    if (state?.kind === "deleted") return null;
    if (state?.kind === "saved") return { ...state.metadata, nodes: [] };
    const deletedAt = readDeleted()[chapterUrl] ?? -Infinity;
    const indexed = readIndex()[chapterUrl];
    if (indexed && indexed.cachedAt > deletedAt) return { ...indexed, nodes: [] };
    const legacy = readLegacy()[chapterUrl] ?? null;
    return legacy && legacy.cachedAt > deletedAt ? legacy : null;
  }

  function getCachedUrls(): Set<string> {
    const deleted = readDeleted();
    const legacy = readLegacy();
    const index = readIndex();
    const candidates = new Set<string>([
      ...Object.keys(legacy),
      ...Object.keys(index),
      ...listStateUrls(),
    ]);
    const visible = new Set<string>();
    for (const chapterUrl of candidates) {
      const state = readState(chapterUrl);
      if (state?.kind === "deleted") continue;
      if (state?.kind === "saved") {
        visible.add(chapterUrl);
        continue;
      }
      const legacyRecord = legacy[chapterUrl];
      const indexed = index[chapterUrl];
      if ((legacyRecord && legacyRecord.cachedAt > (deleted[chapterUrl] ?? -Infinity))
        || (indexed && indexed.cachedAt > (deleted[chapterUrl] ?? -Infinity))) {
        visible.add(chapterUrl);
      }
    }
    return visible;
  }

  async function load(chapterUrl: string): Promise<ChapterCache | null> {
    if (!chapterUrl) return null;
    return await mutate(async () => {
      const state = readState(chapterUrl);
      if (state?.kind === "deleted") return null;
      if (state?.kind === "saved") {
        try {
          const response = await (await openCache()).match(state.bodyKey);
          const value = response ? await response.json() : null;
          if (isChapterCache(value)) {
            return { ...value, pinned: value.pinned || state.metadata.pinned || undefined };
          }
        } catch {
          // Keep the authoritative state intact; a later retry may recover the body.
        }
        return null;
      }
      const legacyRecord = readLegacy()[chapterUrl] ?? null;
      const legacy = legacyIsDeleted(chapterUrl, legacyRecord) ? null : legacyRecord;
      if (legacy) await migrateLegacyUnlocked().catch(() => undefined);

      try {
        const cache = await openCache();
        const index = readIndex();
        const indexed = index[chapterUrl];
        let selected = await findBestBody(cache, chapterUrl);
        const latestState = readState(chapterUrl);
        if (latestState?.kind === "deleted") return null;
        if (latestState?.kind === "saved") {
          try {
            const response = await cache.match(latestState.bodyKey);
            const value = response ? await response.json() : null;
            if (isChapterCache(value)) {
              return { ...value, pinned: value.pinned || latestState.metadata.pinned || undefined };
            }
          } catch {
            // The authoritative state remains recoverable on a later retry.
          }
          return null;
        }
        if (selected && indexed?.pinned && !selected.record.pinned) {
          selected = { ...selected, record: { ...selected.record, pinned: true } };
        }

        const deletedAt = readDeleted()[chapterUrl];
        if (selected && deletedAt !== undefined && selected.record.cachedAt <= deletedAt) {
          if (index[chapterUrl]) {
            delete index[chapterUrl];
            try {
              writeIndex(index);
            } catch {
              // Advisory metadata may remain stale; the tombstone still hides it.
            }
          }
          // Old timestamp tombstones are compatibility metadata only. Never
          // physically delete an immutable body without an exact per-URL state key.
          return null;
        }
        if (!selected) {
          if (index[chapterUrl]) {
            delete index[chapterUrl];
            writeIndex(index);
          }
          return legacy;
        }
        if (!indexed
          || indexed.cachedAt !== selected.record.cachedAt
          || indexed.bodyKey !== selected.bodyKey
          || !!indexed.pinned !== !!selected.record.pinned) {
          index[chapterUrl] = toMetadata(selected.record, selected.bodyKey);
          try {
            writeIndex(index);
          } catch {
            // The validated Cache body is still readable even when metadata
            // repair is blocked by storage policy or quota.
          }
        }
        return selected.record;
      } catch {
        return legacy;
      }
    });
  }

  async function save(chapterUrl: string, data: ChapterCacheInput): Promise<void> {
    if (!chapterUrl) throw new Error("缺少章節連結，無法儲存離線內容");
    await mutate(async () => {
      const cache = await openCache();
      const previousBodies = await findBodies(cache, chapterUrl);
      const previousState = readState(chapterUrl);
      const legacyRecord = readLegacy()[chapterUrl] ?? null;
      const indexed = readIndex()[chapterUrl];
      const record: ChapterCache = {
        ...data,
        pinned: data.pinned
          || previousBodies.some(body => body.record.pinned)
          || legacyRecord?.pinned
          || indexed?.pinned
          || (previousState?.kind === "saved" && previousState.metadata.pinned)
          || undefined,
        cachedAt: Date.now(),
      };
      const bodyKey = newBodyKey(chapterUrl);

      try {
        await putContent(cache, bodyKey, record);
      } catch (error) {
        throw storageError("離線內容儲存失敗，可能是瀏覽器可用空間不足", error);
      }

      try {
        writeState(chapterUrl, { kind: "saved", bodyKey, metadata: toMetadata(record, bodyKey) });
      } catch (error) {
        await cache.delete(bodyKey).catch(() => false);
        throw storageError("離線內容狀態寫入失敗，可能是瀏覽器可用空間不足", error);
      }

      // The global index is rebuildable catalog metadata. Per-chapter state above is
      // the authoritative atomic commit and must never be rolled back from a stale snapshot.
      try {
        const nextIndex = readIndex();
        nextIndex[chapterUrl] = toMetadata(record, bodyKey);
        writeIndex(nextIndex);
      } catch {
        // getMetadata/load/listStateUrls continue to see the committed per-chapter state.
      }

      // Only the key referenced by the index at operation start is safe to clean.
      // Unindexed keys may belong to a concurrent save that has not committed yet.
      const previousIndexedKey = indexed?.bodyKey ?? (indexed ? stableCacheKey(chapterUrl) : null);
      if (previousIndexedKey && previousIndexedKey !== bodyKey) {
        await cache.delete(previousIndexedKey).catch(() => false);
      }
      await evictAutomaticUnlocked(cache).catch(() => undefined);
    });
  }

  async function removeManyUnlocked(chapterUrls: string[]): Promise<void> {
    const targets = new Set(chapterUrls.filter(Boolean));
    if (targets.size === 0) return;
    const cache = await openCache();
    let stateError: unknown;
    let deletionError: unknown;

    for (const chapterUrl of targets) {
      const previousState = readState(chapterUrl);
      const indexed = readIndex()[chapterUrl];
      const bodyKey = previousState?.bodyKey
        ?? indexed?.bodyKey
        ?? (indexed ? stableCacheKey(chapterUrl) : null);

      try {
        // This single synchronous write is the authoritative linearization point.
        // It is independent of wall-clock time and cannot partially update another map.
        writeState(chapterUrl, { kind: "deleted", ...(bodyKey ? { bodyKey } : {}) });
      } catch (error) {
        stateError ??= error;
        continue;
      }

      // Advisory metadata is best-effort; all public readers consult state first.
      try {
        const index = readIndex();
        delete index[chapterUrl];
        writeIndex(index);
      } catch {
        // Reconcile can rebuild the catalog index later.
      }

      if (bodyKey) {
        try {
          await cache.delete(bodyKey);
        } catch (error) {
          deletionError ??= error;
        }
      }
    }

    if (stateError) throw storageError("刪除離線內容失敗", stateError);
    if (deletionError) throw storageError("離線內容已標記刪除，但部分儲存空間尚待清理", deletionError);
  }

  async function remove(chapterUrl: string): Promise<void> {
    if (!chapterUrl) return;
    await mutate(() => removeManyUnlocked([chapterUrl]));
  }

  async function removeMany(chapterUrls: string[]): Promise<void> {
    await mutate(() => removeManyUnlocked(chapterUrls));
  }

  async function reconcile(): Promise<Set<string>> {
    return await mutate(async () => {
      await migrateLegacyUnlocked().catch(() => undefined);
      const cache = await openCache();
      const deleted = readDeleted();
      const bodies = new Map<string, Array<{ bodyKey: string; record: ChapterCache }>>();
      for (const request of await cache.keys()) {
        const bodyKey = typeof request === "string" ? request : request.url;
        const chapterUrl = chapterUrlFromBodyKey(bodyKey);
        if (!chapterUrl) continue;
        try {
          const response = await cache.match(bodyKey);
          const value = response ? await response.json() : null;
          if (!isChapterCache(value)) continue;
          const state = readState(chapterUrl);
          if (state?.kind === "deleted") {
            if (state.bodyKey === bodyKey) await cache.delete(bodyKey).catch(() => false);
            continue;
          }
          if (state?.kind === "saved" && state.bodyKey !== bodyKey) continue;
          if (!state && value.cachedAt <= (deleted[chapterUrl] ?? -Infinity)) continue;
          const records = bodies.get(chapterUrl) ?? [];
          records.push({ bodyKey, record: value });
          bodies.set(chapterUrl, records);
        } catch {
          // Invalid entries are not advertised as downloaded.
        }
      }
      const nextIndex: ChapterCacheIndex = {};
      for (const [chapterUrl, records] of bodies) {
        const preferred = records.reduce((best, current) => current.record.cachedAt > best.record.cachedAt ? current : best);
        const record = { ...preferred.record, pinned: records.some(candidate => candidate.record.pinned) || undefined };
        nextIndex[chapterUrl] = toMetadata(record, preferred.bodyKey);
      }
      writeIndex(nextIndex);
      return new Set(Object.keys(nextIndex));
    });
  }

  return { getMetadata, getCachedUrls, load, save, remove, removeMany, migrateLegacy, reconcile };
}
