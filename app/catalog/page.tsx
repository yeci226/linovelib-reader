"use client";
import { useEffect, useState, Suspense, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getEntryFor, saveProgress, getCatalogCache, saveCatalogCache, type HistoryEntry } from "@/lib/history";

interface Chapter { title: string; url: string | null }
interface VolumeGroup {
  volTitle: string;
  coverUrl: string;
  chapters: Chapter[];
}

async function fetchCatalog(url: string): Promise<{ title: string; coverUrl: string; groups: VolumeGroup[] }> {
  const res = await fetch(`/api/catalog?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data = await res.json() as { title: string; coverUrl: string; volumes: VolumeGroup[] };
  return { title: data.title, coverUrl: data.coverUrl, groups: data.volumes };
}

function CatalogContent() {
  const params = useSearchParams();
  const router = useRouter();
  const catalogUrl = params.get("url") || "";

  const [title, setTitle] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [groups, setGroups] = useState<VolumeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");

  const lastChapterUrl = entry?.lastChapterUrl ?? null;
  const lastChapterTitle = entry?.lastChapterTitle ?? "";
  const visitedChapters = entry?.visitedChapters ?? {};

  const allChapters: Chapter[] = groups.flatMap(g => g.chapters);

  // Shared logic to apply a fetched catalog to state + persistence
  function applyParsed(parsed: { title: string; coverUrl: string; groups: VolumeGroup[] }, catUrl: string) {
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

    // Persist catalog structure for cache-first next visit
    saveCatalogCache(catUrl, { title: parsed.title, coverUrl: cover, groups: parsed.groups });

    const flat = parsed.groups.flatMap(g => g.chapters);
    const ex = getEntryFor(catUrl);
    const updated: HistoryEntry = {
      catalogUrl: catUrl,
      novelTitle: parsed.title,
      coverUrl: cover,
      lastChapterUrl: ex?.lastChapterUrl || (flat[0]?.url ?? ""),
      lastChapterTitle: ex?.lastChapterTitle || (flat[0]?.title ?? ""),
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

    // ── Cache-first: if we have cached catalog data, show it immediately ──
    const cached = getCatalogCache(catalogUrl);
    if (cached) {
      setTitle(cached.title);
      setCoverUrl(cached.coverUrl);
      setGroups(cached.groups);
      setLoading(false);
      // Background-refresh only if cache is older than 1 day
      const ONE_DAY = 24 * 60 * 60 * 1000;
      if (Date.now() - cached.cachedAt > ONE_DAY) {
        fetchCatalog(catalogUrl)
          .then(parsed => applyParsed(parsed, catalogUrl))
          .catch(() => { /* ignore background refresh errors */ });
      }
      return;
    }

    // ── No cache: show loading spinner and wait ──
    setLoading(true);
    fetchCatalog(catalogUrl)
      .then(parsed => applyParsed(parsed, catalogUrl))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [catalogUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastChapterUrl && groups.length > 0) {
      const el = document.getElementById(`ch-${lastChapterUrl}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [lastChapterUrl, groups]);

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

  // Search: flat list of {chapter, volTitle} matching query (chapter title OR volume title)
  const isSearching = searchQuery.trim().length > 0;
  const searchResults: { ch: Chapter; volTitle: string; volMatch: boolean }[] = isSearching
    ? groups.flatMap(g => {
        const q = searchQuery.toLowerCase();
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
        <button onClick={() => router.push("/")} style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", display: "flex", alignItems: "center", gap: 5, marginBottom: 14 }}>
          ← 返回首頁
        </button>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ width: 70, height: 96, borderRadius: 6, flexShrink: 0, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)" }}>
            {coverUrl ? (
              <img src={`/api/image?url=${encodeURIComponent(coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: "var(--text-dim)" }}>📖</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", lineHeight: 1.35, marginBottom: 6 }}>{title}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
              共 {totalChapters} 章
              {visitedCount > 0 && <> · 已看 {visitedCount} 章</>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "4px 20px 80px", maxWidth: 760, margin: "0 auto" }}>

        {/* ── Controls: last-read / sort / search — centred above chapter list ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "20px 0 16px", borderBottom: "1px solid var(--border)", marginBottom: 8 }}>

          {/* Last visited */}
          {lastChapterUrl && lastChapterTitle && (
            <div
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              onClick={() => router.push(`/read?url=${encodeURIComponent(lastChapterUrl)}&catalog=${encodeURIComponent(catalogUrl)}`)}
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

          {isSearching && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>找到 {searchResults.length} 章</div>
          )}
        </div>
        {isSearching ? (
          /* ── Search results view ── */
          searchResults.length === 0 ? (
            <div style={{ paddingTop: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>沒有符合的章節</div>
          ) : (
            searchResults.map(({ ch, volTitle, volMatch }) => {
              const isLast = !!ch.url && ch.url === lastChapterUrl;
              const isVisited = !!ch.url && !!visitedChapters[ch.url];
              const isLocked = !ch.url;
              const volLabel = volMatch
                ? <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0, marginRight: isLast ? 6 : 0 }}>
                    {highlightMatch(volTitle || "章節列表", searchQuery)}
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
                opacity: isLocked ? 0.45 : 1, cursor: isLocked ? "default" : "pointer",
              };
              const srInner = (
                <>
                  <span style={{ fontSize: 14, color: isVisited && !isLast ? "var(--text-muted)" : "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {highlightMatch(ch.title, searchQuery)}
                  </span>
                  {volLabel}
                  {isLocked ? (
                    <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>🔒</span>
                  ) : isLast ? (
                    <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
                      上次看到
                    </span>
                  ) : (
                    <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isVisited ? "var(--border)" : "var(--accent)", display: "inline-block" }} />
                  )}
                </>
              );
              return isLocked ? (
                <div key={ch.title} id={`ch-locked-${ch.title}`} style={srStyle}>{srInner}</div>
              ) : (
                <Link
                  key={ch.url}
                  id={`ch-${ch.url}`}
                  prefetch={false}
                  href={`/read?url=${encodeURIComponent(ch.url!)}&catalog=${encodeURIComponent(catalogUrl)}`}
                  style={srStyle}
                  onMouseEnter={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)"; }}
                  onMouseLeave={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = ""; }}
                >{srInner}</Link>
              );
            })
          )
        ) : (
          displayGroups.map((group, gi) => {
          const originalGi = sortDesc ? groups.length - 1 - gi : gi;
          const isCollapsed = !!collapsed[originalGi];
          const chaptersToShow = sortDesc ? [...group.chapters].reverse() : group.chapters;

          return (
            <div key={originalGi} style={{ marginBottom: 24 }}>
              {/* Volume title row */}
              <div
                onClick={() => toggleCollapse(originalGi)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 0 10px", borderBottom: "1px solid var(--border)", marginBottom: 0, cursor: "pointer", userSelect: "none" }}
              >
                <span style={{ fontSize: 12, letterSpacing: ".1em", color: "var(--text-muted)", fontWeight: 600, flex: 1 }}>
                  {group.volTitle || "章節列表"}
                </span>
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
                       const isLocked = !ch.url;
                       const chKey = ch.url || `locked-${ci}`;
                       const chStyle: React.CSSProperties = {
                         display: "flex", alignItems: "center", justifyContent: "space-between",
                         padding: "9px 8px", borderRadius: 7, gap: 10,
                         transition: "background .12s",
                         background: isLast ? "rgba(200,169,110,.06)" : "",
                         border: isLast ? "1px solid rgba(200,169,110,.18)" : "1px solid transparent",
                         opacity: isLocked ? 0.45 : 1,
                         cursor: isLocked ? "default" : "pointer",
                       };
                       const inner = (
                         <>
                           <span style={{ fontSize: 14, color: isVisited && !isLast ? "var(--text-muted)" : "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                             {ch.title}
                           </span>
                           {isLocked ? (
                             <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>🔒</span>
                           ) : isLast ? (
                             <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#0a0a0d", padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
                               上次看到
                             </span>
                           ) : (
                             <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isVisited ? "var(--border)" : "var(--accent)", display: "inline-block" }} />
                           )}
                         </>
                       );
                       return isLocked ? (
                         <div key={chKey} id={`ch-${chKey}`} style={chStyle}>{inner}</div>
                       ) : (
                         <Link
                           key={chKey}
                           id={`ch-${chKey}`}
                           prefetch={false}
                           href={`/read?url=${encodeURIComponent(ch.url!)}&catalog=${encodeURIComponent(catalogUrl)}`}
                           style={chStyle}
                           onMouseEnter={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = "var(--surface)"; }}
                           onMouseLeave={e => { if (!isLast) (e.currentTarget as HTMLAnchorElement).style.background = ""; }}
                         >{inner}</Link>
                       );
                     })}
                  </div>
                </div>
              )}
            </div>
          );
        })
        )}
      </div>
    </main>
  );
}

export default function CatalogPage() {
  return <Suspense><CatalogContent /></Suspense>;
}
