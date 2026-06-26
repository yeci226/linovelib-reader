"use client";
import { useEffect, useMemo, useState, Suspense, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getEntryFor, saveProgress, getCatalogCache, saveCatalogCache, getChapterCache, removeChapterCache, removeChapterCaches, type HistoryEntry } from "@/lib/history";
import { downloadChapterForOffline, downloadChaptersForOffline } from "@/lib/offline";
import { ImagePlaceholderIcon, GalleryIcon } from "@/components/icons";
import { CommentBoard } from "@/components/CommentBoard";

interface Chapter { title: string; url: string | null }
interface VolumeGroup {
  volTitle: string;
  coverUrl: string;
  chapters: Chapter[];
}

async function fetchCatalog(url: string): Promise<{ title: string; coverUrl: string; groups: VolumeGroup[]; author?: string; desc?: string; tags?: string[] }> {
  const res = await fetch(`/api/catalog?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data = await res.json() as { title: string; coverUrl: string; volumes: VolumeGroup[]; author?: string; desc?: string; tags?: string[] };
  return { title: data.title, coverUrl: data.coverUrl, groups: data.volumes, author: data.author, desc: data.desc, tags: data.tags };
}

function CatalogContent() {
  const params = useSearchParams();
  const router = useRouter();
  const catalogUrl = params.get("url") || "";

  // Read localStorage synchronously on first render — this component is fully
  // client-side (inside <Suspense>), so there is no SSR/hydration mismatch.
  const initialCache = catalogUrl ? getCatalogCache(catalogUrl) : null;
  const initialEntry = catalogUrl ? getEntryFor(catalogUrl) : null;

  const [title, setTitle] = useState(initialCache?.title ?? "");
  const [coverUrl, setCoverUrl] = useState(initialCache?.coverUrl ?? "");
  const [groups, setGroups] = useState<VolumeGroup[]>((initialCache?.groups as VolumeGroup[]) ?? []);
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState<HistoryEntry | null>(initialEntry);
  const [sortDesc, setSortDesc] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [downloadedMap, setDownloadedMap] = useState<Record<string, boolean>>({});
  const [downloadingChapterUrl, setDownloadingChapterUrl] = useState("");
  const [downloadingVolumeKey, setDownloadingVolumeKey] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");

  const lastChapterUrl = entry?.lastChapterUrl ?? null;
  const lastChapterTitle = entry?.lastChapterTitle ?? "";
  const visitedChapters = entry?.visitedChapters ?? {};

  const allChapters: Chapter[] = groups.flatMap(g => g.chapters);
  const downloadableChapterUrls = useMemo(
    () => allChapters.map(ch => ch.url).filter((url): url is string => !!url && url !== "null"),
    [allChapters],
  );

  function refreshDownloadedMap(nextGroups: VolumeGroup[] = groups) {
    const next: Record<string, boolean> = {};
    for (const group of nextGroups) {
      for (const ch of group.chapters) {
        if (ch.url && ch.url !== "null") next[ch.url] = !!getChapterCache(ch.url);
      }
    }
    setDownloadedMap(next);
  }

  async function handleChapterDownload(ch: Chapter) {
    if (!ch.url || ch.url === "null") {
      setDownloadMessage(`〈${ch.title}〉目前沒有可用章節連結，無法預下載。`);
      return;
    }
    setDownloadingChapterUrl(ch.url);
    setDownloadMessage(`正在預下載：${ch.title}`);
    try {
      const result = await downloadChapterForOffline(ch.url, catalogUrl);
      refreshDownloadedMap();
      setDownloadMessage(result.alreadyDownloaded ? `已下載：${result.title}` : `下載完成：${result.title}`);
    } catch (e) {
      setDownloadMessage(`下載失敗：${String(e)}`);
    } finally {
      setDownloadingChapterUrl("");
    }
  }

  async function handleVolumeDownload(group: VolumeGroup, volumeIndex: number) {
    const urls = group.chapters.map(ch => ch.url).filter((url): url is string => !!url && url !== "null");
    if (urls.length === 0) {
      setDownloadMessage(`〈${group.volTitle || `第 ${volumeIndex + 1} 卷`}〉沒有可下載章節。`);
      return;
    }
    const key = `${volumeIndex}:${group.volTitle}`;
    setDownloadingVolumeKey(key);
    setDownloadMessage(`正在預下載 ${group.volTitle || `第 ${volumeIndex + 1} 卷`}…`);
    try {
      const result = await downloadChaptersForOffline(urls, catalogUrl, progress => {
        setDownloadMessage(`正在預下載 ${group.volTitle || `第 ${volumeIndex + 1} 卷`}：${progress.completed}/${progress.total} · ${progress.chapterTitle}`);
      });
      refreshDownloadedMap();
      setDownloadMessage(`${group.volTitle || `第 ${volumeIndex + 1} 卷`} 下載完成：新增 ${result.completed} 章，略過 ${result.skipped} 章。`);
    } catch (e) {
      setDownloadMessage(`整卷下載失敗：${String(e)}`);
    } finally {
      setDownloadingVolumeKey("");
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
    setTitle(parsed.title);
    setCoverUrl(cover);
    setGroups(parsed.groups);
    document.title = `${parsed.title} — 目錄`;

    const navAuthor = navMeta?.author || "";
    const navDesc = navMeta?.desc || "";
    const navTags = navMeta?.tags;

    const resolvedAuthor = parsed.author || navAuthor;
    const resolvedDesc = parsed.desc || navDesc;
    const resolvedTags = parsed.tags?.length ? parsed.tags : (navTags?.length ? navTags : undefined);

    // Persist catalog structure for cache-first next visit (include metadata for history enrichment)
    saveCatalogCache(catUrl, { title: parsed.title, coverUrl: cover, author: resolvedAuthor, desc: resolvedDesc, tags: resolvedTags, groups: parsed.groups });

    const flat = parsed.groups.flatMap(g => g.chapters);
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
      // Already shown synchronously — background-refresh if older than 4 hours or missing title
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
    if (lastChapterUrl && groups.length > 0) {
      const el = document.getElementById(`ch-${lastChapterUrl}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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

  // Search: flat list of {chapter, volTitle} matching query (chapter title OR volume title)
  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;
  const searchResults: { ch: Chapter; volTitle: string; volMatch: boolean }[] = isSearching
    ? groups.flatMap(g => {
        const q = trimmedQuery.toLowerCase();
        const volMatch = g.volTitle.toLowerCase().includes(q);
        return g.chapters
          .filter(ch => volMatch || ch.title.toLowerCase().includes(q))
          .map(ch => ({ ch, volTitle: g.volTitle, volMatch }));
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
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "16px 20px" }}>
        <button onClick={() => { if (window.history.length > 1) { router.back(); } else { router.push("/"); } }} style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", display: "flex", alignItems: "center", gap: 5, marginBottom: 14 }}>
          ← 返回
        </button>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ width: 70, height: 96, borderRadius: 6, flexShrink: 0, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)" }}>
            {coverUrl ? (
              <img src={`/api/image?url=${encodeURIComponent(coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
                <ImagePlaceholderIcon style={{ fontSize: 28 }} />
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", lineHeight: 1.35, marginBottom: 4 }}>{title}</div>
            
            {entry?.author && (
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                作者：<span style={{ color: "var(--accent)" }}>{entry.author}</span>
              </div>
            )}
            
            {entry?.desc && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", marginBottom: 12 }}>
                {entry.desc}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
                共 {totalChapters} 章
                {visitedCount > 0 && <> · 已看 {visitedCount} 章</>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button 
                  onClick={() => router.push(`/gallery?url=${encodeURIComponent(catalogUrl)}`)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    background: "var(--surface2)", color: "var(--text)",
                    border: "1px solid var(--border)", borderRadius: 4,
                    padding: "4px 10px", fontSize: 12, cursor: "pointer",
                    transition: "all .15s"
                  }}
                >
                  <GalleryIcon style={{ fontSize: 14 }} /> 全部插畫
                </button>
              </div>
            </div>
            
            {entry?.tags && entry.tags.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {entry.tags.map(tag => (
                  <span key={tag} style={{ fontSize: 10, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-dim)", padding: "2px 6px", borderRadius: 4 }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ padding: "4px 20px 80px", maxWidth: 760, margin: "0 auto" }}>

        {/* ── Controls: last-read / sort / search — centred above chapter list ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "20px 0 16px", borderBottom: "1px solid var(--border)", marginBottom: 8 }}>

          {/* Last visited */}
          {validLastChapterUrl && lastChapterTitle && (
            <div
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              onClick={() => router.push(`/read?url=${encodeURIComponent(validLastChapterUrl)}&catalog=${encodeURIComponent(catalogUrl)}`)}
            >
              <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap" }}>上次看到</span>
              <span style={{ fontSize: 13, color: "var(--accent)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastChapterTitle}</span>
            </div>
          )}

          {/* Sort + search row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", maxWidth: 420 }}>
            <button
              onClick={() => setSortDesc(d => !d)}
              style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "1px solid var(--accent-dim)", borderRadius: 4, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
            >
              {sortDesc ? "↑ 正序" : "↓ 倒序"}
            </button>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜尋章節…"
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "var(--surface)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "5px 28px 5px 10px",
                  fontSize: 13, color: "var(--text)", outline: "none",
                }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer", lineHeight: 1, padding: 0 }}
                  aria-label="清除搜尋"
                >×</button>
              )}
            </div>
          </div>

          <div style={{ width: "100%", maxWidth: 520, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface)" }}>
              離線已下載 {downloadedCount}/{downloadableChapterUrls.length} 章
            </div>
            {downloadedCount > 0 && (
              <button
                onClick={handleDeleteAllDownloads}
                style={{ fontSize: 12, color: "#ffb3b3", background: "var(--surface)", border: "1px solid rgba(255,120,120,.35)", borderRadius: 999, padding: "6px 12px", cursor: "pointer" }}
              >
                刪除本書已下載
              </button>
            )}
          </div>

          {downloadMessage && (
            <div style={{ fontSize: 12, color: "var(--accent)", textAlign: "center", lineHeight: 1.5, maxWidth: 560 }}>
              {downloadMessage}
            </div>
          )}

          {isSearching && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>找到 {searchResults.length} 章</div>
          )}
        </div>
        {isSearching ? (
          /* ── Search results view ── */
          <>
            {searchResults.length === 0 ? (
              <div style={{ paddingTop: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>沒有符合的章節</div>
            ) : (
              searchResults.map(({ ch, volTitle, volMatch }) => {
                const isLast = !!ch.url && ch.url === lastChapterUrl;
                const isVisited = !!ch.url && !!visitedChapters[ch.url];
                const isDownloaded = !!ch.url && !!downloadedMap[ch.url];
                const isDownloading = !!ch.url && downloadingChapterUrl === ch.url;
                const volLabel = volMatch
                  ? <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0, marginRight: isLast ? 6 : 0 }}>
                      {highlightMatch(volTitle || "章節列表", trimmedQuery)}
                    </span>
                  : <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0, marginRight: isLast ? 6 : 0 }}>
                      {volTitle || "章節列表"}
                    </span>;
                const srStyle: React.CSSProperties = {
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "9px 8px", borderRadius: 7, gap: 10,
                  transition: "background .12s",
                  background: isLast ? "rgba(200,169,110,.06)" : "",
                  border: isLast ? "1px solid rgba(200,169,110,.18)" : "1px solid transparent",
                  cursor: "pointer",
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
                      <span style={{ fontSize: 10, fontWeight: 700, background: "rgba(120,200,140,.12)", color: "#84d29a", padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 }}>
                        已下載
                      </span>
                    )}
                  </>
                );
                const chKey = ch.url || `locked-${volTitle}-${ch.title}`;
                if (!ch.url || ch.url === "null") {
                  return (
                    <div
                      key={chKey}
                      id={`ch-${chKey}`}
                      onClick={() => alert("此章節似乎無法讀取或已鎖定！")}
                      style={{ ...srStyle, opacity: 0.5, cursor: "not-allowed" }}
                    >{srInner}</div>
                  );
                }
                return (
                  <div key={chKey} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Link
                      id={`ch-${chKey}`}
                      prefetch={false}
                      href={`/read?url=${encodeURIComponent(ch.url!)}&catalog=${encodeURIComponent(catalogUrl)}`}
                      style={{ ...srStyle, flex: 1, minWidth: 0 }}
                      onMouseEnter={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)"; }}
                      onMouseLeave={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = ""; }}
                    >{srInner}</Link>
                    <button
                      onClick={() => isDownloaded ? handleDeleteChapterDownload(ch) : handleChapterDownload(ch)}
                      disabled={isDownloading}
                      style={{ fontSize: 11, borderRadius: 999, padding: "6px 10px", border: "1px solid var(--border)", background: "var(--surface)", color: isDownloaded ? "#ffb3b3" : "var(--accent)", cursor: isDownloading ? "progress" : "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                    >
                      {isDownloading ? "下載中…" : isDownloaded ? "刪除" : "預下載"}
                    </button>
                  </div>
                );
              })
            )}
            {/* ── Last-read chapter pinned below search results ── */}
            {validLastChapterUrl && lastChapterTitle && !searchResults.some(r => r.ch.url === validLastChapterUrl) && (
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>上次閱讀位置</div>
                <Link
                  prefetch={false}
                  href={`/read?url=${encodeURIComponent(validLastChapterUrl)}&catalog=${encodeURIComponent(catalogUrl)}`}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "9px 8px", borderRadius: 7,
                    background: "rgba(200,169,110,.06)",
                    border: "1px solid rgba(200,169,110,.18)",
                    cursor: "pointer", textDecoration: "none",
                    transition: "background .12s",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(200,169,110,.12)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(200,169,110,.06)"; }}
                >
                  <span style={{ fontSize: 14, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastChapterTitle}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
                    上次看到
                  </span>
                </Link>
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
          const volumeDownloading = downloadingVolumeKey === volumeKey;

          return (
            <div key={originalGi} style={{ marginBottom: 24 }}>
              {/* Volume title row */}
              <div
                onClick={() => toggleCollapse(originalGi)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 0 10px", borderBottom: "1px solid var(--border)", marginBottom: 0, cursor: "pointer", userSelect: "none", flexWrap: "wrap" }}
              >
                <span style={{ fontSize: 12, letterSpacing: ".1em", color: "var(--text-muted)", fontWeight: 600, flex: 1 }}>
                  {group.volTitle || "章節列表"}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  已下載 {volumeDownloaded}/{volumeUrls.length}
                </span>
                {volumeUrls.length > 0 && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleVolumeDownload(group, originalGi); }}
                      disabled={volumeDownloading || volumeDownloaded === volumeUrls.length}
                      style={{ fontSize: 11, color: volumeDownloaded === volumeUrls.length ? "var(--text-dim)" : "var(--accent)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 999, padding: "4px 10px", cursor: volumeDownloading ? "progress" : (volumeDownloaded === volumeUrls.length ? "default" : "pointer"), whiteSpace: "nowrap" }}
                    >
                      {volumeDownloading ? "下載中…" : volumeDownloaded === volumeUrls.length ? "已下載" : "預下載本卷"}
                    </button>
                    {volumeDownloaded > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteVolumeDownload(group); }}
                        style={{ fontSize: 11, color: "#ffb3b3", background: "var(--surface)", border: "1px solid rgba(255,120,120,.35)", borderRadius: 999, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap" }}
                      >
                        刪除此卷
                      </button>
                    )}
                  </>
                )}
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {isCollapsed ? `▶ ${group.chapters.length}章` : "▼"}
                </span>
              </div>

              {!isCollapsed && (
                <div style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
                  {/* Volume cover — sidebar */}
                  {group.coverUrl && (
                    <div style={{ flexShrink: 0, width: 160, paddingTop: 8, paddingRight: 12 }}>
                      <img
                        src={`/api/image?url=${encodeURIComponent(group.coverUrl)}`}
                        alt=""
                        style={{ width: 160, height: 220, objectFit: "cover", borderRadius: 5, border: "1px solid var(--border)", display: "block" }}
                      />
                    </div>
                  )}

                  {/* Chapter list */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                     {chaptersToShow.map((ch, ci) => {
                       const isLast = !!ch.url && ch.url === lastChapterUrl;
                       const isVisited = !!ch.url && !!visitedChapters[ch.url];
                       const isDownloaded = !!ch.url && !!downloadedMap[ch.url];
                       const isDownloading = !!ch.url && downloadingChapterUrl === ch.url;
                       const chKey = ch.url || `locked-${ci}`;
                       const chStyle: React.CSSProperties = {
                         display: "flex", alignItems: "center", justifyContent: "space-between",
                         padding: "9px 8px", borderRadius: 7, gap: 10,
                         transition: "background .12s",
                         background: isLast ? "rgba(200,169,110,.06)" : "",
                         border: isLast ? "1px solid rgba(200,169,110,.18)" : "1px solid transparent",
                         cursor: "pointer",
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
                             <span style={{ fontSize: 10, fontWeight: 700, background: "rgba(120,200,140,.12)", color: "#84d29a", padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 }}>
                               已下載
                             </span>
                           )}
                         </>
                       );
                       if (!ch.url || ch.url === "null") {
                         return (
                           <div
                             key={chKey}
                             id={`ch-${chKey}`}
                             onClick={() => alert("此章節似乎無法讀取或已鎖定！")}
                             style={{ ...chStyle, opacity: 0.5, cursor: "not-allowed" }}
                           >{inner}</div>
                         );
                       }
                       return (
                         <div key={chKey} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                           <Link
                             id={`ch-${chKey}`}
                             prefetch={false}
                             href={`/read?url=${encodeURIComponent(ch.url!)}&catalog=${encodeURIComponent(catalogUrl)}`}
                             style={{ ...chStyle, flex: 1, minWidth: 0 }}
                             onMouseEnter={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)"; }}
                             onMouseLeave={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = ""; }}
                           >{inner}</Link>
                           <button
                             onClick={() => isDownloaded ? handleDeleteChapterDownload(ch) : handleChapterDownload(ch)}
                             disabled={isDownloading}
                             style={{ fontSize: 11, borderRadius: 999, padding: "6px 10px", border: "1px solid var(--border)", background: "var(--surface)", color: isDownloaded ? "#ffb3b3" : "var(--accent)", cursor: isDownloading ? "progress" : "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                           >
                             {isDownloading ? "下載中…" : isDownloaded ? "刪除" : "預下載"}
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
