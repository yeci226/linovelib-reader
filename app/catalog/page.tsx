"use client";
import { useEffect, useMemo, useRef, useState, Suspense, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getEntryFor, saveProgress, getCatalogCache, saveCatalogCache, getChapterCache, removeChapterCache, removeChapterCaches, type HistoryEntry } from "@/lib/history";
import { downloadChapterForOffline, downloadChaptersForOffline } from "@/lib/offline";
import { getVolumeProgressPercent } from "@/lib/download-progress";
import { createRequestQueue } from "@/lib/download-queue";
import { canOpenOfflineResource } from "@/lib/offline-access";
import { useOnlineStatus } from "@/lib/use-online-status";
import { ImagePlaceholderIcon, GalleryIcon, DownloadIcon, CheckIcon, TrashIcon } from "@/components/icons";
import { OfflineAwareLink } from "@/components/OfflineAwareLink";
import { CommentBoard } from "@/components/CommentBoard";

interface Chapter { title: string; url: string | null }
interface VolumeGroup {
  volTitle: string;
  coverUrl: string;
  chapters: Chapter[];
}

// Volume jobs are intentionally serialized. Chapter workers inside the active
// volume may still run concurrently, but a second volume cannot start until
// the previous volume has completely settled.
const enqueueVolumeDownload = createRequestQueue(0);

async function fetchCatalog(url: string): Promise<{ title: string; coverUrl: string; groups: VolumeGroup[]; author?: string; desc?: string; tags?: string[] }> {
  const res = await fetch(`/api/catalog?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data = await res.json() as { title: string; coverUrl: string; volumes: VolumeGroup[]; author?: string; desc?: string; tags?: string[] };
  return { title: data.title, coverUrl: data.coverUrl, groups: data.volumes, author: data.author, desc: data.desc, tags: data.tags };
}

function CircularProgress({ value, size = 34, label, queued = false }: { value: number; size?: number; label: string; queued?: boolean }) {
  const percent = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={`${label}：${percent}%`}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        display: "inline-grid",
        placeItems: "center",
        flexShrink: 0,
        background: `conic-gradient(var(--accent) ${percent * 3.6}deg, var(--border) 0deg)`,
      }}
    >
      <span style={{ width: size - 7, height: size - 7, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--surface)", color: "var(--text)", fontSize: size <= 34 ? 8 : 9, fontWeight: 800 }}>
        {queued ? "排" : `${percent}%`}
      </span>
    </span>
  );
}

function CatalogContent() {
  const params = useSearchParams();
  const router = useRouter();
  const catalogUrl = params.get("url") || "";

  // Keep the first server render and first client render identical.
  // localStorage-backed cache must be read inside effects, not during render,
  // otherwise the client can render <main> while the server rendered the
  // loading shell, causing a hydration mismatch.
  const [title, setTitle] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [groups, setGroups] = useState<VolumeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const autoScrolledToLastChapterRef = useRef(false);
  const activeVolumeKeysRef = useRef(new Set<string>());
  const isOnline = useOnlineStatus();
  const [searchQuery, setSearchQuery] = useState("");
  const [downloadedMap, setDownloadedMap] = useState<Record<string, boolean>>({});
  const [downloadingChapterMap, setDownloadingChapterMap] = useState<Record<string, boolean>>({});
  const [chapterProgressMap, setChapterProgressMap] = useState<Record<string, number>>({});
  const [downloadingVolumeMap, setDownloadingVolumeMap] = useState<Record<string, { completed: number; total: number }>>({});
  const [downloadMessage, setDownloadMessage] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  const lastChapterUrl = entry?.lastChapterUrl ?? null;
  const lastChapterTitle = entry?.lastChapterTitle ?? "";
  const visitedChapters = entry?.visitedChapters ?? {};

  const allChapters: Chapter[] = groups.flatMap(g => g.chapters);
  const downloadableChapterUrls = useMemo(
    () => allChapters.map(ch => ch.url).filter((url): url is string => !!url && url !== "null"),
    [allChapters],
  );

  const iconButtonBase: React.CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  function refreshDownloadedMap(nextGroups: VolumeGroup[] = groups) {
    const next: Record<string, boolean> = {};
    for (const group of nextGroups) {
      for (const ch of group.chapters) {
        if (ch.url && ch.url !== "null") next[ch.url] = !!getChapterCache(ch.url);
      }
    }
    setDownloadedMap(next);
  }

  function inferChapterUrlFromNeighbors(
    prevUrl: string | null | undefined,
    nextUrl: string | null | undefined,
    stepsFromPrev: number,
    stepsToNext: number,
  ): string | null {
    const parseUrlPattern = (url: string | null | undefined) => {
      if (!url) return null;
      const m = /^(.*?)(\d+)(\.html(?:[?#].*)?)$/.exec(url);
      if (!m) return null;
      return { prefix: m[1], num: Number(m[2]), width: m[2].length, suffix: m[3] };
    };

    const prev = parseUrlPattern(prevUrl);
    const next = parseUrlPattern(nextUrl);

    if (prev && next && prev.prefix === next.prefix && prev.suffix === next.suffix) {
      const gap = next.num - prev.num;
      if (gap === stepsFromPrev + stepsToNext) {
        return `${prev.prefix}${String(prev.num + stepsFromPrev).padStart(prev.width, "0")}${prev.suffix}`;
      }
    }
    if (prev) {
      return `${prev.prefix}${String(prev.num + stepsFromPrev).padStart(prev.width, "0")}${prev.suffix}`;
    }
    if (next) {
      return `${next.prefix}${String(next.num - stepsToNext).padStart(next.width, "0")}${next.suffix}`;
    }
    return null;
  }

  function repairMissingChapterUrls(nextGroups: VolumeGroup[]): { groups: VolumeGroup[]; changed: boolean } {
    const groupsCopy = nextGroups.map(group => ({ ...group, chapters: group.chapters.map(ch => ({ ...ch })) }));
    const flat: Array<{ chapter: Chapter; groupIndex: number; chapterIndex: number }> = [];
    groupsCopy.forEach((group, groupIndex) => {
      group.chapters.forEach((chapter, chapterIndex) => {
        flat.push({ chapter, groupIndex, chapterIndex });
      });
    });

    let changed = false;
    for (let i = 0; i < flat.length; i++) {
      const item = flat[i];
      if (item.chapter.url && item.chapter.url !== "null") continue;

      let repairedUrl: string | null = null;

      let prevKnownIndex = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (flat[j].chapter.url && flat[j].chapter.url !== "null") {
          prevKnownIndex = j;
          break;
        }
      }

      let nextKnownIndex = -1;
      for (let j = i + 1; j < flat.length; j++) {
        if (flat[j].chapter.url && flat[j].chapter.url !== "null") {
          nextKnownIndex = j;
          break;
        }
      }

      const prevKnownUrl = prevKnownIndex >= 0 ? flat[prevKnownIndex].chapter.url : null;
      const nextKnownUrl = nextKnownIndex >= 0 ? flat[nextKnownIndex].chapter.url : null;

      if (prevKnownIndex === i - 1 && prevKnownUrl) {
        const prevCached = getChapterCache(prevKnownUrl);
        if (prevCached?.nextChapterUrl) repairedUrl = prevCached.nextChapterUrl;
      }
      if (!repairedUrl && nextKnownIndex === i + 1 && nextKnownUrl) {
        const nextCached = getChapterCache(nextKnownUrl);
        if (nextCached?.prevChapterUrl) repairedUrl = nextCached.prevChapterUrl;
      }
      if (!repairedUrl) {
        repairedUrl = inferChapterUrlFromNeighbors(
          prevKnownUrl,
          nextKnownUrl,
          prevKnownIndex >= 0 ? i - prevKnownIndex : 0,
          nextKnownIndex >= 0 ? nextKnownIndex - i : 0,
        );
      }

      if (repairedUrl) {
        item.chapter.url = repairedUrl;
        changed = true;
      }
    }

    return { groups: groupsCopy, changed };
  }

  async function handleChapterDownload(ch: Chapter) {
    if (!ch.url || ch.url === "null") {
      setDownloadMessage(`〈${ch.title}〉目前沒有可用章節連結，無法預下載。`);
      return;
    }
    if (!isOnline) {
      setDownloadMessage("目前沒有網路，無法下載新章節。已下載內容仍可離線閱讀。");
      return;
    }
    if (downloadingChapterMap[ch.url]) return;
    setDownloadingChapterMap(prev => ({ ...prev, [ch.url!]: true }));
    setChapterProgressMap(prev => ({ ...prev, [ch.url!]: 0 }));
    setDownloadMessage(`正在預下載：${ch.title}`);
    try {
      const result = await downloadChapterForOffline(ch.url, catalogUrl, progress => {
        setChapterProgressMap(prev => ({ ...prev, [progress.chapterUrl]: progress.percent }));
      });
      refreshDownloadedMap();
      setDownloadMessage(result.alreadyDownloaded ? `已下載：${result.title}` : `下載完成：${result.title}（含圖片 / 動圖）`);
    } catch (e) {
      setDownloadMessage(`下載失敗：${String(e)}`);
    } finally {
      setDownloadingChapterMap(prev => { const next = { ...prev }; delete next[ch.url!]; return next; });
      setChapterProgressMap(prev => { const next = { ...prev }; delete next[ch.url!]; return next; });
    }
  }

  async function handleVolumeDownload(group: VolumeGroup, volumeIndex: number) {
    const urls = group.chapters.map(ch => ch.url).filter((url): url is string => !!url && url !== "null");
    if (urls.length === 0) {
      setDownloadMessage(`〈${group.volTitle || `第 ${volumeIndex + 1} 卷`}〉沒有可下載章節。`);
      return;
    }
    if (!isOnline) {
      setDownloadMessage("目前沒有網路，無法下載新卷。已下載內容仍可離線閱讀。");
      return;
    }
    const key = `${volumeIndex}:${group.volTitle}`;
    if (activeVolumeKeysRef.current.has(key)) return;
    activeVolumeKeysRef.current.add(key);
    setDownloadingVolumeMap(prev => ({ ...prev, [key]: { completed: 0, total: urls.length } }));
    setDownloadingChapterMap(prev => ({ ...prev, ...Object.fromEntries(urls.map(url => [url, true])) }));
    setChapterProgressMap(prev => ({ ...prev, ...Object.fromEntries(urls.map(url => [url, downloadedMap[url] ? 100 : 0])) }));
    setDownloadMessage(`${group.volTitle || `第 ${volumeIndex + 1} 卷`} 已加入整卷下載佇列。`);
    try {
      const result = await enqueueVolumeDownload(async () => {
        setDownloadMessage(`開始預下載 ${group.volTitle || `第 ${volumeIndex + 1} 卷`}…`);
        return downloadChaptersForOffline(urls, catalogUrl, {
          concurrency: 4,
          onChapterProgress: progress => {
            setChapterProgressMap(prev => ({ ...prev, [progress.chapterUrl]: progress.percent }));
          },
          onProgress: progress => {
            setDownloadingVolumeMap(prev => ({ ...prev, [key]: { completed: progress.completed, total: progress.total } }));
            setDownloadingChapterMap(prev => { const next = { ...prev }; delete next[progress.chapterUrl]; return next; });
            setChapterProgressMap(prev => ({ ...prev, [progress.chapterUrl]: 100 }));
            setDownloadMessage(
              progress.failed
                ? `${group.volTitle || `第 ${volumeIndex + 1} 卷`}：第 ${progress.completed}/${progress.total} 章下載失敗，繼續處理其餘章節…`
                : `正在預下載 ${group.volTitle || `第 ${volumeIndex + 1} 卷`}：${progress.completed}/${progress.total} · ${progress.chapterTitle}`,
            );
            refreshDownloadedMap();
          },
        });
      });
      refreshDownloadedMap();
      setDownloadMessage(
        result.failed > 0
          ? `${group.volTitle || `第 ${volumeIndex + 1} 卷`} 已處理完成：新增 ${result.completed} 章、略過 ${result.skipped} 章、失敗 ${result.failed} 章。失敗章節可重新下載。`
          : `${group.volTitle || `第 ${volumeIndex + 1} 卷`} 下載完成：新增 ${result.completed} 章，略過 ${result.skipped} 章，含圖片 / 動圖離線。`,
      );
    } catch (e) {
      setDownloadMessage(`整卷下載發生非預期錯誤：${String(e)}`);
    } finally {
      activeVolumeKeysRef.current.delete(key);
      setDownloadingVolumeMap(prev => { const next = { ...prev }; delete next[key]; return next; });
      setDownloadingChapterMap(prev => { const next = { ...prev }; for (const url of urls) delete next[url]; return next; });
      setChapterProgressMap(prev => { const next = { ...prev }; for (const url of urls) delete next[url]; return next; });
    }
  }

  function handleDeleteChapterDownload(ch: Chapter) {
    if (!ch.url || ch.url === "null") return;
    removeChapterCache(ch.url);
    refreshDownloadedMap();
    setDownloadMessage(`已刪除離線章節：${ch.title}`);
  }

  function handleDeleteVolumeDownload(group: VolumeGroup) {
    const urls = group.chapters.map(ch => ch.url).filter((url): url is string => !!url && url !== "null");
    removeChapterCaches(urls);
    refreshDownloadedMap();
    setDownloadMessage(`已刪除 ${group.volTitle || "此卷"} 的離線內容。`);
  }

  function handleDeleteAllDownloads() {
    removeChapterCaches(downloadableChapterUrls);
    refreshDownloadedMap();
    setDownloadMessage("已刪除本書所有已下載章節。");
  }

  // Shared logic to apply a fetched catalog to state + persistence
  function applyParsed(
    parsed: { title: string; coverUrl: string; groups: VolumeGroup[]; author?: string; desc?: string; tags?: string[] },
    catUrl: string,
    navMeta?: { author?: string; desc?: string; tags?: string[] }
  ) {
    let cover = parsed.coverUrl;
    if (!cover) {
      const m = catUrl.match(/\/novel\/(\d+)/);
      if (m) {
        const id = m[1];
        const prefix = Math.floor(parseInt(id, 10) / 1000);
        cover = `https://tw.linovelib.com/files/article/image/${prefix}/${id}/${id}s.jpg`;
      }
    }
    const repaired = repairMissingChapterUrls(parsed.groups);
    setTitle(parsed.title);
    setCoverUrl(cover);
    setGroups(repaired.groups);
    document.title = `${parsed.title} — 目錄`;

    const navAuthor = navMeta?.author || "";
    const navDesc = navMeta?.desc || "";
    const navTags = navMeta?.tags;

    const resolvedAuthor = parsed.author || navAuthor;
    const resolvedDesc = parsed.desc || navDesc;
    const resolvedTags = parsed.tags?.length ? parsed.tags : (navTags?.length ? navTags : undefined);

    // Persist catalog structure for cache-first next visit (include metadata for history enrichment)
    saveCatalogCache(catUrl, { title: parsed.title, coverUrl: cover, author: resolvedAuthor, desc: resolvedDesc, tags: resolvedTags, groups: repaired.groups });

    const flat = repaired.groups.flatMap(g => g.chapters);
    const ex = getEntryFor(catUrl);
    const updated: HistoryEntry = {
      catalogUrl: catUrl,
      novelTitle: parsed.title,
      coverUrl: cover,
      author: resolvedAuthor || ex?.author,
      desc: resolvedDesc || ex?.desc,
      tags: resolvedTags?.length ? resolvedTags : ex?.tags,
      // Only keep an existing lastChapterUrl; never pre-fill with first chapter
      lastChapterUrl: ex?.lastChapterUrl ?? "",
      lastChapterTitle: ex?.lastChapterTitle ?? "",
      lastChapterIndex: ex?.lastChapterIndex ?? 0,
      totalChapters: flat.length,
      updatedAt: ex?.updatedAt ?? Date.now(),
      visitedChapters: ex?.visitedChapters ?? {},
    };
    saveProgress(updated);
    setEntry(updated);
  }

  useEffect(() => {
    if (!catalogUrl) return;
    const existing = getEntryFor(catalogUrl);
    if (existing) setEntry(existing);

    // Consume navItemMeta BEFORE the cache-check branch so the metadata is
    // always applied even when the catalog is served from cache.
    // (handleNav on the discover/ranking page saves author/desc/tags here.)
    let navMeta: { author?: string; desc?: string; tags?: string[] } | undefined;
    try {
      const raw = sessionStorage.getItem("navItemMeta");
      if (raw) {
        const m = JSON.parse(raw) as { url: string; author?: string; desc?: string; tags?: string[] };
        if (m.url === catalogUrl) {
          navMeta = { author: m.author, desc: m.desc, tags: m.tags };
          sessionStorage.removeItem("navItemMeta");
        }
      }
    } catch { /* ignore */ }

    const cached = getCatalogCache(catalogUrl);
    if (cached) {
      const repaired = repairMissingChapterUrls(cached.groups as VolumeGroup[]);
      setTitle(cached.title);
      setCoverUrl(cached.coverUrl);
      setGroups(repaired.groups);
      document.title = `${cached.title} — 目錄`;

      if (repaired.changed) {
        saveCatalogCache(catalogUrl, {
          title: cached.title,
          coverUrl: cached.coverUrl,
          author: cached.author,
          desc: cached.desc,
          tags: cached.tags,
          groups: repaired.groups,
        });
      }

      // If we have fresh card metadata, enrich the history entry and catalog cache now.
      if (navMeta && (navMeta.author || navMeta.desc || navMeta.tags?.length)) {
        const enriched: HistoryEntry = {
          catalogUrl,
          novelTitle: existing?.novelTitle || cached.title,
          coverUrl: existing?.coverUrl || cached.coverUrl,
          author: existing?.author || navMeta.author,
          desc: existing?.desc || navMeta.desc,
          tags: existing?.tags?.length ? existing.tags : navMeta.tags,
          lastChapterUrl: (existing?.lastChapterUrl && existing.lastChapterUrl !== "null") ? existing.lastChapterUrl : "",
          lastChapterTitle: existing?.lastChapterTitle ?? "",
          lastChapterIndex: existing?.lastChapterIndex ?? 0,
          totalChapters: existing?.totalChapters ?? 0,
          updatedAt: existing?.updatedAt ?? Date.now(),
          visitedChapters: existing?.visitedChapters ?? {},
          lastScrollPct: existing?.lastScrollPct,
        };
        saveProgress(enriched);
        setEntry(enriched);
        saveCatalogCache(catalogUrl, {
          title: cached.title,
          coverUrl: cached.coverUrl,
          author: cached.author || navMeta.author,
          desc: cached.desc || navMeta.desc,
          tags: cached.tags?.length ? cached.tags : navMeta.tags,
          groups: cached.groups as VolumeGroup[],
        });
      }
      // Cache-first render, then background-refresh if older than 4 hours or missing title
      setLoading(false);
      const REFRESH_INTERVAL = 4 * 60 * 60 * 1000;
      if (Date.now() - cached.cachedAt > REFRESH_INTERVAL || cached.title === "未知小說") {
        fetchCatalog(catalogUrl)
          .then(parsed => applyParsed(parsed, catalogUrl, navMeta))
          .catch(() => {});
      }
      return;
    }

    // No cache — fetch now (loading spinner already showing)
    fetchCatalog(catalogUrl)
      .then(parsed => applyParsed(parsed, catalogUrl, navMeta))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [catalogUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    autoScrolledToLastChapterRef.current = false;
  }, [catalogUrl]);

  useEffect(() => {
    const updateViewport = () => setIsMobile(window.innerWidth < 760);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    if (autoScrolledToLastChapterRef.current) return;
    if (!lastChapterUrl || lastChapterUrl === "null" || groups.length === 0) return;

    const target = groups
      .map((group, groupIndex) => ({
        groupIndex,
        chapterIndex: group.chapters.findIndex(ch => ch.url === lastChapterUrl),
      }))
      .find(item => item.chapterIndex >= 0);

    if (!target) return;

    autoScrolledToLastChapterRef.current = true;
    setCollapsed(prev => (prev[target.groupIndex] ? { ...prev, [target.groupIndex]: false } : prev));

    const anchorId = `ch-vol-${target.groupIndex}-${target.chapterIndex}`;
    const scrollToTarget = (attempt = 0) => {
      const el = document.getElementById(anchorId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => scrollToTarget(attempt + 1), 60);
      }
    };

    window.setTimeout(() => scrollToTarget(), 0);
  }, [lastChapterUrl, groups]);

  useEffect(() => {
    refreshDownloadedMap(groups);
  }, [groups]);

  const toggleCollapse = (gi: number) =>
    setCollapsed(prev => ({ ...prev, [gi]: !prev[gi] }));

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "var(--accent)", fontSize: 15 }}>載入目錄中…</div>
    </div>
  );

  if (error) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div>
        <p style={{ color: "#e06c6c", marginBottom: 16 }}>載入失敗：{error}</p>
        <button onClick={() => router.push("/")} style={{ color: "var(--accent)", background: "none", border: "none", fontSize: 13 }}>← 返回首頁</button>
      </div>
    </div>
  );

  const totalChapters = allChapters.length;
  const visitedCount = Object.keys(visitedChapters).length;

  const displayGroups = sortDesc ? [...groups].reverse() : groups;

  const validLastChapterUrl = lastChapterUrl && lastChapterUrl !== "null" ? lastChapterUrl : "";
  const downloadedCount = downloadableChapterUrls.filter(url => downloadedMap[url]).length;
  const canOpenLastChapter = !!validLastChapterUrl && canOpenOfflineResource(isOnline, !!downloadedMap[validLastChapterUrl]);

  // Search: flat list of {chapter, volTitle} matching query (chapter title OR volume title)
  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;
  const searchResults: { ch: Chapter; volTitle: string; volMatch: boolean; groupIndex: number; chapterIndex: number }[] = isSearching
    ? groups.flatMap((g, groupIndex) => {
        const q = trimmedQuery.toLowerCase();
        const volMatch = g.volTitle.toLowerCase().includes(q);
        return g.chapters
          .map((ch, chapterIndex) => ({ ch, chapterIndex }))
          .filter(({ ch }) => volMatch || ch.title.toLowerCase().includes(q))
          .map(({ ch, chapterIndex }) => ({ ch, volTitle: g.volTitle, volMatch, groupIndex, chapterIndex }));
      })
    : [];

  // Highlight matched portion of chapter title
  function highlightMatch(text: string, query: string): ReactNode {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{ background: "rgba(200,169,110,.35)", color: "var(--text)", borderRadius: 2 }}>
          {text.slice(idx, idx + query.length)}
        </mark>
        {text.slice(idx + query.length)}
      </>
    );
  }

  return (
    <main style={{ minHeight: "100vh" }}>
      {/* Sticky header */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "color-mix(in srgb, var(--bg) 92%, transparent)", backdropFilter: "blur(14px)", borderBottom: "1px solid var(--border)", padding: "6px 14px 8px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <button onClick={() => { if (window.history.length > 1) { router.back(); } else { router.push("/"); } }} style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", display: "flex", alignItems: "center", gap: 5, marginBottom: 6, padding: 0, cursor: "pointer" }}>
            ← 返回
          </button>
          <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 10, border: "1px solid var(--border)", borderRadius: 16, background: "linear-gradient(180deg, color-mix(in srgb, var(--surface) 78%, transparent), color-mix(in srgb, var(--surface2) 92%, transparent))", boxShadow: "0 6px 20px rgba(0,0,0,.12)" }}>
            <div style={{ width: 60, height: 84, borderRadius: 8, flexShrink: 0, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)", boxShadow: "0 6px 14px rgba(0,0,0,.16)" }}>
              {coverUrl ? (
                <img src={`/api/image?url=${encodeURIComponent(coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
                  <ImagePlaceholderIcon style={{ fontSize: 24 }} />
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)", lineHeight: 1.15, marginBottom: 2, letterSpacing: "-.01em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
                {entry?.author && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    作者：<span style={{ color: "var(--accent)", fontWeight: 600 }}>{entry.author}</span>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <button 
                  onClick={() => router.push(`/gallery?url=${encodeURIComponent(catalogUrl)}`)}
                  disabled={!isOnline}
                  title={isOnline ? "全部插畫" : "插畫頁需要網路連線"}
                  style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 999, padding: "6px 10px", fontSize: 11, cursor: isOnline ? "pointer" : "not-allowed", fontWeight: 600, opacity: isOnline ? 1 : 0.45 }}
                >
                  <GalleryIcon style={{ fontSize: 13 }} /> 全部插畫
                </button>
                {downloadedCount > 0 && (
                  <button
                    onClick={handleDeleteAllDownloads}
                    aria-label="刪除本書所有已下載章節"
                    title="刪除本書已下載"
                    style={{ ...iconButtonBase, color: "#ffb3b3", cursor: "pointer" }}
                  >
                    <TrashIcon style={{ fontSize: 15 }} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "16px 20px 80px", maxWidth: 1180, margin: "0 auto" }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, border: "1px solid var(--border)", borderRadius: 16, background: "var(--surface)", marginBottom: 16, boxShadow: "0 4px 14px rgba(0,0,0,.06)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text)", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface2)" }}>共 {totalChapters} 章</div>
            <div style={{ fontSize: 12, color: "var(--text)", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface2)" }}>已看 {visitedCount} 章</div>
            <div style={{ fontSize: 12, color: "var(--text)", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface2)" }}>已下載 {downloadedCount}/{downloadableChapterUrls.length} 章</div>
          </div>

          {entry?.desc && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
              {entry.desc}
            </div>
          )}

          {entry?.tags && entry.tags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {entry.tags.map(tag => (
                <span key={tag} style={{ fontSize: 11, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text-dim)", padding: "4px 8px", borderRadius: 999 }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Controls: last-read / sort / search ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, border: "1px solid var(--border)", borderRadius: 18, background: "var(--surface2)", marginBottom: 18, boxShadow: "0 4px 16px rgba(0,0,0,.08)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            {validLastChapterUrl && lastChapterTitle ? (
              <button
                onClick={() => {
                  if (!canOpenLastChapter) return;
                  const href = `/read?url=${encodeURIComponent(validLastChapterUrl)}&catalog=${encodeURIComponent(catalogUrl)}`;
                  if (isOnline) router.push(href);
                  else window.location.assign(href);
                }}
                disabled={!canOpenLastChapter}
                title={canOpenLastChapter ? `繼續閱讀：${lastChapterTitle}` : "此章尚未下載，離線時無法開啟"}
                style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: "100%", background: "rgba(200,169,110,.08)", border: "1px solid rgba(200,169,110,.22)", borderRadius: 999, padding: "8px 12px", cursor: canOpenLastChapter ? "pointer" : "not-allowed", color: "var(--text)", minWidth: 0, opacity: canOpenLastChapter ? 1 : 0.45 }}
              >
                <span style={{ fontSize: 10, fontWeight: 800, background: "var(--accent)", color: "#0a0a0d", padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>上次看到</span>
                <span style={{ fontSize: 13, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastChapterTitle}</span>
              </button>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>還沒有閱讀紀錄</div>
            )}

            {isSearching && (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>找到 {searchResults.length} 章</div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", flexWrap: "wrap" }}>
            <button
              onClick={() => setSortDesc(d => !d)}
              style={{ fontSize: 12, color: "var(--accent)", background: "var(--surface)", border: "1px solid var(--accent-dim)", borderRadius: 999, padding: "8px 12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, fontWeight: 700 }}
            >
              {sortDesc ? "↑ 正序排列" : "↓ 倒序排列"}
            </button>
            <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜尋章節或卷名…"
                style={{ width: "100%", boxSizing: "border-box", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 999, padding: "10px 34px 10px 14px", fontSize: 14, color: "var(--text)", outline: "none" }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 0 }}
                  aria-label="清除搜尋"
                >×</button>
              )}
            </div>
          </div>

          {downloadMessage && (
            <div style={{ fontSize: 12, color: "var(--accent)", lineHeight: 1.6, padding: "10px 12px", borderRadius: 12, background: "rgba(200,169,110,.08)", border: "1px solid rgba(200,169,110,.12)" }}>
              {downloadMessage}
            </div>
          )}
        </div>
        {isSearching ? (
          /* ── Search results view ── */
          <>
            {searchResults.length === 0 ? (
              <div style={{ paddingTop: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>沒有符合的章節</div>
            ) : (
              searchResults.map(({ ch, volTitle, volMatch, groupIndex, chapterIndex }) => {
                const isLast = !!ch.url && ch.url === lastChapterUrl;
                const isVisited = !!ch.url && !!visitedChapters[ch.url];
                const isDownloaded = !!ch.url && !!downloadedMap[ch.url];
                const isDownloading = !!ch.url && !!downloadingChapterMap[ch.url];
                const chapterProgress = ch.url ? chapterProgressMap[ch.url] ?? 0 : 0;
                const volLabel = volMatch
                  ? <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0, marginRight: isLast ? 6 : 0 }}>
                      {highlightMatch(volTitle || "章節列表", trimmedQuery)}
                    </span>
                  : <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0, marginRight: isLast ? 6 : 0 }}>
                      {volTitle || "章節列表"}
                    </span>;
                const srStyle: React.CSSProperties = {
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 14px", borderRadius: 14, gap: 12,
                  transition: "background .12s, border-color .12s, transform .12s",
                  background: isLast ? "rgba(200,169,110,.08)" : "var(--surface2)",
                  border: isLast ? "1px solid rgba(200,169,110,.22)" : "1px solid var(--border)",
                  cursor: "pointer",
                  boxShadow: "0 2px 10px rgba(0,0,0,.05)",
                };
                const srInner = (
                  <>
                    <span style={{ fontSize: 14, color: isVisited && !isLast ? "var(--text-muted)" : "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {highlightMatch(ch.title, trimmedQuery)}
                    </span>
                    {volLabel}
                    {isLast ? (
                      <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
                        上次看到
                      </span>
                    ) : (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isVisited ? "var(--border)" : "var(--accent)", display: "inline-block" }} />
                    )}
                    {isDownloaded && (
                      <span title="已下載" aria-label="已下載" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: 999, background: "rgba(120,200,140,.12)", color: "#84d29a", flexShrink: 0 }}>
                        <CheckIcon style={{ fontSize: 12 }} />
                      </span>
                    )}
                  </>
                );
                const chKey = `sr-${groupIndex}-${chapterIndex}-${ch.title}-${ch.url || "missing"}`;
                const chapterAnchorId = `ch-sr-${groupIndex}-${chapterIndex}`;
                if (!ch.url || ch.url === "null") {
                  return (
                    <div
                      key={chKey}
                      id={chapterAnchorId}
                      style={{ ...srStyle, opacity: 0.45, cursor: "default" }}
                    >{srInner}</div>
                  );
                }
                return (
                  <div key={chKey} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <OfflineAwareLink
                      id={chapterAnchorId}
                      prefetch={false}
                      href={`/read?url=${encodeURIComponent(ch.url!)}&catalog=${encodeURIComponent(catalogUrl)}`}
                      isOnline={isOnline}
                      hasCachedResource={isDownloaded}
                      style={{ ...srStyle, flex: 1, minWidth: 0, opacity: canOpenOfflineResource(isOnline, isDownloaded) ? 1 : 0.45, cursor: canOpenOfflineResource(isOnline, isDownloaded) ? "pointer" : "not-allowed" }}
                      onMouseEnter={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)"; }}
                      onMouseLeave={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = ""; }}
                    >{srInner}</OfflineAwareLink>
                    <button
                      onClick={() => isDownloaded ? handleDeleteChapterDownload(ch) : handleChapterDownload(ch)}
                      disabled={isDownloading || (!isOnline && !isDownloaded)}
                      aria-label={isDownloading ? `正在下載 ${ch.title}` : isDownloaded ? `刪除已下載章節 ${ch.title}` : `預下載章節 ${ch.title}`}
                      title={isDownloading ? `下載中：${ch.title}` : isDownloaded ? `刪除：${ch.title}` : !isOnline ? "目前沒有網路，無法下載" : `預下載：${ch.title}`}
                      style={{
                        ...iconButtonBase,
                        color: isDownloaded ? "#ffb3b3" : "var(--accent)",
                        cursor: isDownloading ? "progress" : (!isOnline && !isDownloaded ? "not-allowed" : "pointer"),
                        opacity: isDownloading ? 0.72 : (!isOnline && !isDownloaded ? 0.45 : 1),
                      }}
                    >
                      {isDownloading ? (
                        <CircularProgress value={chapterProgress} size={32} queued={chapterProgress === 0} label={chapterProgress === 0 ? `${ch.title} 排隊中` : `${ch.title} 下載中`} />
                      ) : isDownloaded ? (
                        <TrashIcon style={{ fontSize: 15 }} />
                      ) : (
                        <DownloadIcon style={{ fontSize: 15 }} />
                      )}
                    </button>
                  </div>
                );
              })
            )}
            {/* ── Last-read chapter pinned below search results ── */}
            {validLastChapterUrl && lastChapterTitle && !searchResults.some(r => r.ch.url === validLastChapterUrl) && (
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>上次閱讀位置</div>
                <OfflineAwareLink
                  prefetch={false}
                  href={`/read?url=${encodeURIComponent(validLastChapterUrl)}&catalog=${encodeURIComponent(catalogUrl)}`}
                  isOnline={isOnline}
                  hasCachedResource={!!downloadedMap[validLastChapterUrl]}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "9px 8px", borderRadius: 7,
                    background: "rgba(200,169,110,.06)",
                    border: "1px solid rgba(200,169,110,.18)",
                    cursor: canOpenOfflineResource(isOnline, !!downloadedMap[validLastChapterUrl]) ? "pointer" : "not-allowed", textDecoration: "none",
                    opacity: canOpenOfflineResource(isOnline, !!downloadedMap[validLastChapterUrl]) ? 1 : 0.45,
                    transition: "background .12s",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(200,169,110,.12)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(200,169,110,.06)"; }}
                >
                  <span style={{ fontSize: 14, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastChapterTitle}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
                    上次看到
                  </span>
                </OfflineAwareLink>
              </div>
            )}
          </>
        ) : (
          displayGroups.map((group, gi) => {
          const originalGi = sortDesc ? groups.length - 1 - gi : gi;
          const isCollapsed = !!collapsed[originalGi];
          const chaptersToShow = sortDesc ? [...group.chapters].reverse() : group.chapters;
          const volumeUrls = chaptersToShow.map(ch => ch.url).filter((url): url is string => !!url && url !== "null");
          const volumeDownloaded = volumeUrls.filter(url => downloadedMap[url]).length;
          const volumeKey = `${originalGi}:${group.volTitle}`;
          const volumeProgress = downloadingVolumeMap[volumeKey];
          const volumeDownloading = !!volumeProgress;
          const volumePercent = getVolumeProgressPercent(volumeUrls, chapterProgressMap);

          return (
            <div key={originalGi} style={{ marginBottom: 18, border: "1px solid var(--border)", borderRadius: 18, background: "linear-gradient(180deg, color-mix(in srgb, var(--surface2) 88%, transparent), color-mix(in srgb, var(--surface) 90%, transparent))", overflow: "hidden", boxShadow: "0 6px 18px rgba(0,0,0,.08)" }}>
              {/* Volume title row */}
              <div
                onClick={() => toggleCollapse(originalGi)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: isCollapsed ? "none" : "1px solid var(--border)", cursor: "pointer", userSelect: "none", flexWrap: "wrap" }}
              >
                {isMobile && group.coverUrl && (
                  <img
                    src={`/api/image?url=${encodeURIComponent(group.coverUrl)}`}
                    alt=""
                    style={{ width: 44, height: 62, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", flexShrink: 0, boxShadow: "0 4px 10px rgba(0,0,0,.12)" }}
                  />
                )}
                <span style={{ fontSize: 13, letterSpacing: ".08em", color: "var(--text)", fontWeight: 800, flex: 1, minWidth: isMobile ? 120 : 180 }}>
                  {group.volTitle || "章節列表"}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", padding: "5px 10px", borderRadius: 999, background: "var(--surface)", border: "1px solid var(--border)" }}>
                  已下載 {volumeDownloaded}/{volumeUrls.length}
                </span>
                {volumeUrls.length > 0 && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleVolumeDownload(group, originalGi); }}
                      disabled={volumeDownloading || volumeDownloaded === volumeUrls.length || !isOnline}
                      aria-label={volumeDownloading ? `${group.volTitle || "此卷"} ${volumeProgress?.completed === 0 ? "排隊中" : "下載中"}` : volumeDownloaded === volumeUrls.length ? `${group.volTitle || "此卷"} 已下載完成` : !isOnline ? `${group.volTitle || "此卷"} 離線時無法下載` : `預下載 ${group.volTitle || "此卷"}`}
                      title={volumeDownloading ? (volumeProgress?.completed === 0 ? "已加入整卷下載佇列" : `下載中 ${volumeProgress?.completed ?? 0}/${volumeProgress?.total ?? volumeUrls.length}`) : volumeDownloaded === volumeUrls.length ? "已下載完成" : !isOnline ? "目前沒有網路，無法下載本卷" : "預下載本卷"}
                      style={{
                        ...iconButtonBase,
                        width: 34,
                        height: 34,
                        color: volumeDownloaded === volumeUrls.length ? "#84d29a" : "var(--accent)",
                        cursor: volumeDownloading ? "progress" : (volumeDownloaded === volumeUrls.length ? "default" : !isOnline ? "not-allowed" : "pointer"),
                        opacity: volumeDownloading ? 0.72 : (!isOnline && volumeDownloaded !== volumeUrls.length ? 0.45 : 1),
                      }}
                    >
                      {volumeDownloading ? (
                        <CircularProgress value={volumePercent} size={34} queued={volumeProgress?.completed === 0 && volumePercent === 0} label={volumeProgress?.completed === 0 ? `${group.volTitle || "此卷"} 排隊中` : `${group.volTitle || "此卷"} 下載中`} />
                      ) : volumeDownloaded === volumeUrls.length ? (
                        <CheckIcon style={{ fontSize: 16 }} />
                      ) : (
                        <DownloadIcon style={{ fontSize: 16 }} />
                      )}
                    </button>
                    {volumeDownloaded > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteVolumeDownload(group); }}
                        aria-label={`刪除此卷離線內容：${group.volTitle || "此卷"}`}
                        title="刪除此卷"
                        style={{ ...iconButtonBase, width: 34, height: 34, color: "#ffb3b3", cursor: "pointer" }}
                      >
                        <TrashIcon style={{ fontSize: 16 }} />
                      </button>
                    )}
                  </>
                )}
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {isCollapsed ? `▶ ${group.chapters.length}章` : "▼"}
                </span>
              </div>

              {!isCollapsed && (
                <div style={{ display: "flex", gap: isMobile ? 12 : 20, alignItems: "flex-start", padding: 16, flexWrap: "wrap" }}>
                  {/* Volume cover — sidebar */}
                  {!isMobile && group.coverUrl && (
                    <div style={{ flexShrink: 0, width: 156 }}>
                      <img
                        src={`/api/image?url=${encodeURIComponent(group.coverUrl)}`}
                        alt=""
                        style={{ width: 156, height: 218, objectFit: "cover", borderRadius: 12, border: "1px solid var(--border)", display: "block", boxShadow: "0 10px 22px rgba(0,0,0,.16)" }}
                      />
                    </div>
                  )}

                  {/* Chapter list */}
                  <div style={{ flex: 1, minWidth: isMobile ? 0 : 260, display: "flex", flexDirection: "column", gap: 8 }}>
                     {chaptersToShow.map((ch, ci) => {
                       const sourceChapterIndex = sortDesc ? group.chapters.length - 1 - ci : ci;
                       const isLast = !!ch.url && ch.url === lastChapterUrl;
                       const isVisited = !!ch.url && !!visitedChapters[ch.url];
                       const isDownloaded = !!ch.url && !!downloadedMap[ch.url];
                       const isDownloading = !!ch.url && !!downloadingChapterMap[ch.url];
                       const chapterProgress = ch.url ? chapterProgressMap[ch.url] ?? 0 : 0;
                       const chKey = `vol-${originalGi}-${sourceChapterIndex}-${ch.title}-${ch.url || "missing"}`;
                       const chapterAnchorId = `ch-vol-${originalGi}-${sourceChapterIndex}`;
                       const chStyle: React.CSSProperties = {
                         display: "flex", alignItems: "center", justifyContent: "space-between",
                         padding: "12px 14px", borderRadius: 14, gap: 12,
                         transition: "background .12s, border-color .12s, transform .12s",
                         background: isLast ? "rgba(200,169,110,.08)" : "var(--surface2)",
                         border: isLast ? "1px solid rgba(200,169,110,.22)" : "1px solid var(--border)",
                         cursor: "pointer",
                         boxShadow: "0 2px 10px rgba(0,0,0,.05)",
                       };
                       const inner = (
                         <>
                           <span style={{ fontSize: 14, color: isVisited && !isLast ? "var(--text-muted)" : "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                             {ch.title}
                           </span>
                           {isLast ? (
                             <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
                               上次看到
                             </span>
                           ) : (
                             <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isVisited ? "var(--border)" : "var(--accent)", display: "inline-block" }} />
                           )}
                           {isDownloaded && (
                             <span title="已下載" aria-label="已下載" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: 999, background: "rgba(120,200,140,.12)", color: "#84d29a", flexShrink: 0 }}>
                               <CheckIcon style={{ fontSize: 12 }} />
                             </span>
                           )}
                         </>
                       );
                       if (!ch.url || ch.url === "null") {
                         return (
                           <div
                             key={chKey}
                             id={chapterAnchorId}
                             style={{ ...chStyle, opacity: 0.45, cursor: "default" }}
                           >{inner}</div>
                         );
                       }
                       return (
                         <div key={chKey} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                           <OfflineAwareLink
                             id={chapterAnchorId}
                             prefetch={false}
                             href={`/read?url=${encodeURIComponent(ch.url!)}&catalog=${encodeURIComponent(catalogUrl)}`}
                             isOnline={isOnline}
                             hasCachedResource={isDownloaded}
                             style={{ ...chStyle, flex: 1, minWidth: 0, opacity: canOpenOfflineResource(isOnline, isDownloaded) ? 1 : 0.45, cursor: canOpenOfflineResource(isOnline, isDownloaded) ? "pointer" : "not-allowed" }}
                             onMouseEnter={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)"; }}
                             onMouseLeave={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = ""; }}
                           >{inner}</OfflineAwareLink>
                           <button
                             onClick={() => isDownloaded ? handleDeleteChapterDownload(ch) : handleChapterDownload(ch)}
                             disabled={isDownloading || (!isOnline && !isDownloaded)}
                             aria-label={isDownloading ? `正在下載 ${ch.title}` : isDownloaded ? `刪除已下載章節 ${ch.title}` : `預下載章節 ${ch.title}`}
                             title={isDownloading ? `下載中：${ch.title}` : isDownloaded ? `刪除：${ch.title}` : !isOnline ? "目前沒有網路，無法下載" : `預下載：${ch.title}`}
                             style={{
                               ...iconButtonBase,
                               color: isDownloaded ? "#ffb3b3" : "var(--accent)",
                               cursor: isDownloading ? "progress" : "pointer",
                               opacity: isDownloading ? 0.72 : 1,
                             }}
                           >
                             {isDownloading ? (
                               <CircularProgress value={chapterProgress} size={32} queued={chapterProgress === 0} label={chapterProgress === 0 ? `${ch.title} 排隊中` : `${ch.title} 下載中`} />
                             ) : isDownloaded ? (
                               <TrashIcon style={{ fontSize: 15 }} />
                             ) : (
                               <DownloadIcon style={{ fontSize: 15 }} />
                             )}
                           </button>
                         </div>
                       );
                     })}
                  </div>
                </div>
              )}
            </div>
          );
        })
        )}

        {!isSearching && (
          <div style={{ marginTop: 40, paddingBottom: 40 }}>
            <CommentBoard 
              title="小說書評區" 
              apiEndpoint={`/api/reviews?catalogUrl=${encodeURIComponent(catalogUrl)}`}
              postEndpoint="/api/reviews"
              payloadKey="catalogUrl"
              payloadValue={catalogUrl}
            />
          </div>
        )}
      </div>
    </main>
  );
}

export default function CatalogPage() {
  return <Suspense><CatalogContent /></Suspense>;
}
