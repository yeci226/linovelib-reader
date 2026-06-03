// lib/history.ts
const STORAGE_KEY = "linovelib-history";
const MAX_ENTRIES = 20;

export type HistoryEntry = {
  catalogUrl: string;
  novelTitle: string;
  coverUrl: string;
  lastChapterUrl: string;
  lastChapterTitle: string;
  lastChapterIndex: number; // kept for compat, not used for read status
  totalChapters: number;
  updatedAt: number;
  /** url → title for every chapter the user has actually opened */
  visitedChapters: Record<string, string>;
};

function load(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as HistoryEntry[];
    // Back-compat: fill visitedChapters if missing
    return raw.map(e => ({ ...e, visitedChapters: e.visitedChapters ?? {} }));
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Returns all history entries, newest first. */
export function getHistory(): HistoryEntry[] {
  return load();
}

/** Upsert an entry (novel-level metadata). Moves it to front. */
export function saveProgress(entry: HistoryEntry): void {
  const existing = load().filter(e => e.catalogUrl !== entry.catalogUrl);
  save([entry, ...existing].slice(0, MAX_ENTRIES));
}

/** Returns the history entry for a given catalogUrl, or null. */
export function getEntryFor(catalogUrl: string): HistoryEntry | null {
  return load().find(e => e.catalogUrl === catalogUrl) ?? null;
}

/**
 * Mark a specific chapter as visited and record its title.
 * Also updates lastChapterUrl/Title on the novel entry.
 */
export function markChapterVisited(
  catalogUrl: string,
  chapterUrl: string,
  chapterTitle: string,
): void {
  if (typeof window === "undefined") return;
  const all = load();
  const idx = all.findIndex(e => e.catalogUrl === catalogUrl);
  if (idx === -1) {
    // Novel not yet in history — create minimal entry
    const entry: HistoryEntry = {
      catalogUrl,
      novelTitle: "",
      coverUrl: "",
      lastChapterUrl: chapterUrl,
      lastChapterTitle: chapterTitle,
      lastChapterIndex: 0,
      totalChapters: 0,
      updatedAt: Date.now(),
      visitedChapters: { [chapterUrl]: chapterTitle },
    };
    save([entry, ...all].slice(0, MAX_ENTRIES));
  } else {
    const entry = { ...all[idx] };
    entry.visitedChapters = { ...entry.visitedChapters, [chapterUrl]: chapterTitle };
    entry.lastChapterUrl = chapterUrl;
    entry.lastChapterTitle = chapterTitle;
    entry.updatedAt = Date.now();
    const rest = all.filter((_, i) => i !== idx);
    save([entry, ...rest].slice(0, MAX_ENTRIES));
  }
}

// ---------------------------------------------------------------------------
// Catalog HTML cache — stores parsed catalog data so the page can render
// instantly without waiting for the proxy.
// ---------------------------------------------------------------------------

const CATALOG_CACHE_KEY = "linovelib-catalog-cache";

export type CatalogChapter = { title: string; url: string | null };
export type CatalogVolumeGroup = { volTitle: string; coverUrl: string; chapters: CatalogChapter[] };
export type CatalogCache = {
  title: string;
  coverUrl: string;
  groups: CatalogVolumeGroup[];
  cachedAt: number;
};

export function getCatalogCache(catalogUrl: string): CatalogCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) ?? "{}") as Record<string, CatalogCache>;
    return raw[catalogUrl] ?? null;
  } catch {
    return null;
  }
}

export function saveCatalogCache(catalogUrl: string, data: Omit<CatalogCache, "cachedAt">): void {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) ?? "{}") as Record<string, CatalogCache>;
    raw[catalogUrl] = { ...data, cachedAt: Date.now() };
    // Keep at most 30 catalog caches; evict oldest
    const entries = Object.entries(raw).sort((a, b) => b[1].cachedAt - a[1].cachedAt).slice(0, 30);
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota exceeded etc. — silently ignore
  }
}

// ---------------------------------------------------------------------------

/**
 * Look up a cached chapter title by URL across any novel entry.
 * Used to label prev/next nav buttons.
 */
export function getCachedChapterTitle(chapterUrl: string): string {
  const all = load();
  for (const entry of all) {
    const t = entry.visitedChapters?.[chapterUrl];
    if (t) return t;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Bookmarks — per-chapter scroll position flags
// ---------------------------------------------------------------------------

const BOOKMARK_KEY = "linovelib-bookmarks";
const MAX_BOOKMARKS = 100;

export type Bookmark = {
  id: string;           // unique id (Date.now().toString())
  catalogUrl: string;
  novelTitle: string;
  chapterUrl: string;
  chapterTitle: string;
  scrollPct: number;    // 0-100, percentage through the chapter
  createdAt: number;
};

function loadBookmarks(): Bookmark[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(BOOKMARK_KEY) ?? "[]") as Bookmark[];
  } catch { return []; }
}

function saveBookmarks(bms: Bookmark[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bms));
}

/** Add a bookmark at the current scroll position. Returns the new bookmark. */
export function addBookmark(b: Omit<Bookmark, "id" | "createdAt">): Bookmark {
  const bm: Bookmark = { ...b, id: Date.now().toString(), createdAt: Date.now() };
  const all = loadBookmarks();
  saveBookmarks([bm, ...all].slice(0, MAX_BOOKMARKS));
  return bm;
}

/** Remove a bookmark by id. */
export function removeBookmark(id: string): void {
  saveBookmarks(loadBookmarks().filter(b => b.id !== id));
}

/** Get all bookmarks for a specific chapter. */
export function getBookmarksForChapter(chapterUrl: string): Bookmark[] {
  return loadBookmarks().filter(b => b.chapterUrl === chapterUrl);
}

/** Get all bookmarks, newest first. */
export function getAllBookmarks(): Bookmark[] {
  return loadBookmarks();
}

// ---------------------------------------------------------------------------
// Chapter content cache — stores parsed nodes so re-reading doesn't re-fetch
// ---------------------------------------------------------------------------

const CHAPTER_CACHE_KEY = "linovelib-chapter-cache";
const CHAPTER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (chapters don't change)
const MAX_CHAPTER_CACHE = 100;

export type ContentNode = { type: "text"; text: string } | { type: "image"; src: string; alt: string };

export type ChapterCache = {
  title: string;
  subtitle: string;
  nodes: ContentNode[];
  nextChapterUrl: string | null;
  cachedAt: number;
};

export function getChapterCache(chapterUrl: string): ChapterCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = JSON.parse(localStorage.getItem(CHAPTER_CACHE_KEY) ?? "{}") as Record<string, ChapterCache>;
    const entry = raw[chapterUrl];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CHAPTER_CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

export function saveChapterCache(chapterUrl: string, data: Omit<ChapterCache, "cachedAt">): void {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.parse(localStorage.getItem(CHAPTER_CACHE_KEY) ?? "{}") as Record<string, ChapterCache>;
    raw[chapterUrl] = { ...data, cachedAt: Date.now() };
    // Keep at most MAX_CHAPTER_CACHE entries; evict oldest
    const entries = Object.entries(raw)
      .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
      .slice(0, MAX_CHAPTER_CACHE);
    localStorage.setItem(CHAPTER_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota exceeded — silently ignore
  }
}
