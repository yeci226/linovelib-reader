// lib/history.ts
import { triggerSyncPush } from "./sync";

const STORAGE_KEY = "linovelib-history";
const MAX_ENTRIES = 20;

/** Normalizes legacy /novel/{id}.html catalogUrls to /novel/{id}/catalog */
function normalizeCatalogUrl(url: string): string {
  return url
    .replace(/(\/novel\/(\d+))\.html$/, '$1/catalog')
    .replace(/(\/novel\/\d+)$/, '$1/catalog');
}

export type HistoryEntry = {
  catalogUrl: string;
  novelTitle: string;
  coverUrl: string;
  author?: string;
  desc?: string;
  tags?: string[];
  lastChapterUrl: string;
  lastChapterTitle: string;
  lastChapterIndex: number; // kept for compat, not used for read status
  totalChapters: number;
  updatedAt: number;
  /** url → title for every chapter the user has actually opened */
  visitedChapters: Record<string, string>;
  lastScrollPct?: number;
};

function load(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as HistoryEntry[];
    // Back-compat: fill visitedChapters if missing + normalize legacy .html catalog URLs
    // Also clear lastChapterUrl if no chapters have been actually visited (was auto-filled by old bug)
    return raw.map(e => {
      const visited = e.visitedChapters ?? {};
      const hasVisited = Object.keys(visited).length > 0;
      return {
        ...e,
        visitedChapters: visited,
        catalogUrl: normalizeCatalogUrl(e.catalogUrl),
        lastChapterUrl: hasVisited ? e.lastChapterUrl : "",
        lastChapterTitle: hasVisited ? e.lastChapterTitle : "",
      };
    });
  } catch {
    return [];
  }
}

export function save(entries: HistoryEntry[], skipSync = false): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  if (!skipSync) triggerSyncPush();
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
  author?: string;
  desc?: string;
  tags?: string[];
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

export function resolveChapterTitle(catalogUrl: string, chapterUrl: string): string {
  if (!chapterUrl) return "";
  const cached = getCachedChapterTitle(chapterUrl);
  if (cached) return cached;
  if (catalogUrl) {
    const catalog = getCatalogCache(catalogUrl);
    if (catalog) {
      for (const group of catalog.groups) {
        for (const ch of group.chapters) {
          if (ch.url === chapterUrl) return ch.title;
        }
      }
    }
  }
  return "";
}

export function saveScrollProgress(catalogUrl: string, pct: number): void {
  if (typeof window === "undefined" || !catalogUrl) return;
  const all = load();
  const idx = all.findIndex(e => e.catalogUrl === catalogUrl);
  if (idx !== -1) {
    all[idx].lastScrollPct = pct;
    save(all, true);
  }
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
  isAuto?: boolean;     // indicates this is a system auto-saved bookmark
};

function loadBookmarks(): Bookmark[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(BOOKMARK_KEY) ?? "[]") as Bookmark[];
  } catch { return []; }
}

export function saveBookmarks(bms: Bookmark[], skipSync = false): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bms));
  if (!skipSync) triggerSyncPush();
}

/** Add a bookmark at the current scroll position. Returns the new bookmark. */
export function addBookmark(b: Omit<Bookmark, "id" | "createdAt">): Bookmark {
  const bm: Bookmark = { ...b, id: Date.now().toString(), createdAt: Date.now() };
  let all = loadBookmarks();
  
  if (bm.isAuto) {
    // For auto bookmarks, overwrite the existing auto bookmark for the same novel
    all = all.filter(existing => !(existing.isAuto && existing.catalogUrl === bm.catalogUrl));
  }
  
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
// Bookshelf
// ---------------------------------------------------------------------------

const BOOKSHELF_KEY = "linovelib-bookshelf";

export type BookshelfEntry = {
  catalogUrl: string;
  novelTitle: string;
  coverUrl: string;
  totalChapters: number;
  addedAt: number;
};

export function loadBookshelf(): BookshelfEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(BOOKSHELF_KEY) ?? "[]") as BookshelfEntry[];
  } catch { return []; }
}

export function saveBookshelf(entries: BookshelfEntry[], skipSync = false): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(BOOKSHELF_KEY, JSON.stringify(entries));
  if (!skipSync) triggerSyncPush();
}

export function addToBookshelf(entry: Omit<BookshelfEntry, "addedAt">): void {
  const all = loadBookshelf().filter(e => e.catalogUrl !== entry.catalogUrl);
  saveBookshelf([{ ...entry, addedAt: Date.now() }, ...all]);
}

export function removeFromBookshelf(catalogUrl: string): void {
  const all = loadBookshelf().filter(e => e.catalogUrl !== catalogUrl);
  saveBookshelf(all);
}

export function isInBookshelf(catalogUrl: string): boolean {
  return loadBookshelf().some(e => e.catalogUrl === catalogUrl);
}

// ---------------------------------------------------------------------------
// Chapter content cache — stores parsed nodes so re-reading doesn't re-fetch
// ---------------------------------------------------------------------------

const CHAPTER_CACHE_KEY = "linovelib-chapter-cache";
const MAX_CHAPTER_CACHE = 100;

export type ContentNode = { type: "text"; text: string } | { type: "image"; src: string; alt: string } | { type: "page-number"; text: string };

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

// ---------------------------------------------------------------------------
// Per-chapter scroll position — separate key so it doesn't pollute sync payload
// ---------------------------------------------------------------------------

const CHAPTER_SCROLL_KEY = "linovelib-chapter-scroll";
const MAX_CHAPTER_SCROLL = 200;

export function saveChapterScroll(chapterUrl: string, pct: number): void {
  if (typeof window === "undefined" || !chapterUrl) return;
  try {
    const raw = JSON.parse(localStorage.getItem(CHAPTER_SCROLL_KEY) ?? "{}") as Record<string, { pct: number; savedAt: number }>;
    raw[chapterUrl] = { pct, savedAt: Date.now() };
    const entries = Object.entries(raw)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_CHAPTER_SCROLL);
    localStorage.setItem(CHAPTER_SCROLL_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* ignore */ }
}

export function getChapterScroll(chapterUrl: string): number {
  if (typeof window === "undefined" || !chapterUrl) return 0;
  try {
    const raw = JSON.parse(localStorage.getItem(CHAPTER_SCROLL_KEY) ?? "{}") as Record<string, { pct: number; savedAt: number }>;
    return raw[chapterUrl]?.pct ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "linovelib-settings";

export type ReaderSettings = {
  theme: "dark" | "sepia" | "light" | "amoled";
  fontSize: number;
  lineHeight: number;
};

export function loadSettings(): ReaderSettings {
  if (typeof window === "undefined") return { theme: "dark", fontSize: 18, lineHeight: 1.8 };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (!raw) return { theme: "dark", fontSize: 18, lineHeight: 1.8 };
    return {
      theme: raw.theme || "dark",
      fontSize: raw.fontSize || 18,
      lineHeight: raw.lineHeight || 1.8
    };
  } catch {
    return { theme: "dark", fontSize: 18, lineHeight: 1.8 };
  }
}

export function saveSettings(settings: ReaderSettings, skipSync = false): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (!skipSync) triggerSyncPush();
}
