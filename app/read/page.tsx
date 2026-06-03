"use client";
import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  saveProgress,
  getEntryFor,
  markChapterVisited,
  getCachedChapterTitle,
  addBookmark,
  getBookmarksForChapter,
  removeBookmark,
  getChapterCache,
  saveChapterCache,
  Bookmark,
} from "@/lib/history";
import { parseChapterHtml } from "@/lib/chapter-parser";


type ChapterPageApiResult = {
  title: string;
  content: string;
  nextPageUrl: string | null;
  nextChapterUrl: string | null;
  prevChapterUrl: string | null;
  cached?: boolean;
};

/** Fetch chapter content via the Next.js API route (preferred path). */
async function fetchChapterPageViaApi(url: string): Promise<ChapterPageApiResult> {
  const res = await fetch(`/api/chapter?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Pure-frontend fallback: fetch raw HTML through the CORS-proxy route,
 * then parse and unshuffle entirely in the browser.
 * Used when the backend API is unavailable.
 *
 * Follows bili_novel_packer: always fetches from www.bilinovel.com (CN, no Cloudflare)
 * so we get raw shuffled HTML that our algorithmic unshuffle can correctly restore.
 */
async function fetchChapterPageClientSide(url: string): Promise<ChapterPageApiResult> {
  // Convert to CN domain (www.bilinovel.com) — no Cloudflare, returns raw shuffled HTML.
  const cnUrl = url
    .replace("tw.linovelib.com", "www.bilinovel.com")
    .replace("cn.linovelib.com", "www.bilinovel.com");

  const proxyUrl = `/api/proxy?url=${encodeURIComponent(cnUrl)}`;
  const htmlRes = await fetch(proxyUrl);
  if (!htmlRes.ok) throw new Error(`proxy HTTP ${htmlRes.status}`);
  const html = await htmlRes.text();

  // Extract chapterlog.js URL from the raw HTML so we get the correct LCG params
  let chapterLogJs: string | null = null;
  const clMatch = /src=["']([^"']*chapterlog\.js[^"']*)["']/.exec(html);
  if (clMatch) {
    try {
      const clUrl = clMatch[1].startsWith("http")
        ? clMatch[1]
        : new URL(clMatch[1], cnUrl).toString();
      const clRes = await fetch(`/api/proxy?url=${encodeURIComponent(clUrl)}`);
      if (clRes.ok) chapterLogJs = await clRes.text();
    } catch {
      // fall through — parseChapterHtml will use FALLBACK_PARAMS
    }
  }

  return parseChapterHtml(html, cnUrl, chapterLogJs);
}

/**
 * Fetch a chapter page: try the API first; if it fails, fall back to
 * pure client-side parsing so the reader works even when the backend is down.
 */
async function fetchChapterPage(url: string): Promise<ChapterPageApiResult> {
  try {
    return await fetchChapterPageViaApi(url);
  } catch (apiErr) {
    console.warn("[read] API unavailable, falling back to client-side parsing:", apiErr);
    return fetchChapterPageClientSide(url);
  }
}

type ContentNode = { type: "text"; text: string } | { type: "image"; src: string; alt: string };

/** Convert plain-text chapter content (paragraphs separated by \n\n) to ContentNode[] */
function contentToNodes(content: string): ContentNode[] {
  return content
    .split(/\n\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const imgMatch = /^\[IMG:(https?:\/\/.+)\]$/.exec(line);
      if (imgMatch) return { type: "image" as const, src: imgMatch[1], alt: "" };
      return { type: "text" as const, text: line };
    });
}

type Theme = "dark" | "sepia" | "light";
type FontFamily = "sans" | "serif";

const FONT_MAP: Record<FontFamily, string> = {
  sans: "Arial, Helvetica, sans-serif",
  serif: '"Georgia", "Times New Roman", serif',
};

const LINE_HEIGHTS = [1.7, 1.95, 2.4] as const;

function ReadContent() {
  const params = useSearchParams();
  const router = useRouter();
  const chapterUrl = params.get("url") || "";
  const catalogUrl = params.get("catalog") || "";

  const READ_WIDTHS = [660, 800, 960, 1200] as const;

  // Read chapter cache synchronously — this component is fully client-side.
  const initialCache = chapterUrl ? getChapterCache(chapterUrl) : null;

  const [title, setTitle] = useState(initialCache?.title ?? "");
  const [subtitle, setSubtitle] = useState(initialCache?.subtitle ?? "");
  const [nodes, setNodes] = useState<ContentNode[]>(initialCache?.nodes ?? []);
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState("");
  const [readWidthIdx, setReadWidthIdx] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = parseInt(localStorage.getItem("linovelib-width-idx") ?? "0", 10);
    return isNaN(v) ? 0 : Math.min(v, READ_WIDTHS.length - 1);
  });
  const readWidth = READ_WIDTHS[readWidthIdx];
  const cycleWidth = () => setReadWidthIdx(i => (i + 1) % READ_WIDTHS.length);
  const [fontSize, setFontSize] = useState<number>(() => {
    if (typeof window === "undefined") return 17;
    const v = parseInt(localStorage.getItem("linovelib-fontsize") ?? "17", 10);
    return isNaN(v) ? 17 : Math.min(26, Math.max(14, v));
  });
  const [progress, setProgress] = useState(0);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  const [nextTitle, setNextTitle] = useState("");
  const [prevTitle, setPrevTitle] = useState("");
  // Sub-page background loading state
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const loadingChapterRef = useRef<string | null>(null); // tracks which chapterUrl is currently loading

  // Theme
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("linovelib-theme") as Theme) ?? "dark";
  });

  // Font family
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => {
    if (typeof window === "undefined") return "sans";
    return (localStorage.getItem("linovelib-font") as FontFamily) ?? "sans";
  });

  // Line height
  const [lineHeightIdx, setLineHeightIdx] = useState(1); // default 1.95

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const contentRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Apply theme to document
  useEffect(() => {
    if (theme === "dark") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
    localStorage.setItem("linovelib-theme", theme);
  }, [theme]);

  // Persist font family
  useEffect(() => {
    localStorage.setItem("linovelib-font", fontFamily);
  }, [fontFamily]);

  // Persist font size
  useEffect(() => {
    localStorage.setItem("linovelib-fontsize", String(fontSize));
  }, [fontSize]);

  // Persist read width
  useEffect(() => {
    localStorage.setItem("linovelib-width-idx", String(readWidthIdx));
  }, [readWidthIdx]);

  // Load bookmarks when chapterUrl changes
  useEffect(() => {
    if (chapterUrl) {
      setBookmarks(getBookmarksForChapter(chapterUrl));
    }
  }, [chapterUrl]);

  // Scroll progress
  useEffect(() => {
    const handleScroll = () => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = el.offsetHeight - window.innerHeight;
      if (total <= 0) { setProgress(100); return; }
      const scrolled = -rect.top;
      setProgress(Math.min(100, Math.max(0, Math.round((scrolled / total) * 100))));
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (loading) return;
      if (e.key === "ArrowLeft" && prevUrl) goChapter(prevUrl);
      if (e.key === "ArrowRight" && nextUrl) goChapter(nextUrl);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, prevUrl, nextUrl]);

  useEffect(() => {
    if (!chapterUrl) return;
    let cancelled = false;

    // Check cache first — may already be shown from synchronous init
    const cached = getChapterCache(chapterUrl);

    if (!cached) {
      setLoading(true);
    }
    setLoadingMore(false);
    loadingChapterRef.current = chapterUrl;
    if (!cached) setNodes([]);
    setSubtitle(cached?.subtitle ?? "");
    setError("");
    setNextUrl(cached ? cached.nextChapterUrl : null);
    setPrevUrl(null);
    setNextTitle(cached?.nextChapterUrl ? getCachedChapterTitle(cached.nextChapterUrl) : "");
    setPrevTitle("");
    setPageCount(cached ? 1 : 0);
    window.scrollTo(0, 0);

    async function loadInitial() {
      if (cached) {
        if (cancelled) return;
        setTitle(cached.title);
        setSubtitle(cached.subtitle);
        document.title = `${cached.title} — 輕小說閱讀器`;
        setNodes(cached.nodes);
        setLoading(false);
        setNextUrl(cached.nextChapterUrl);
        setNextTitle(cached.nextChapterUrl ? getCachedChapterTitle(cached.nextChapterUrl) : "");
        setPageCount(1);
        if (cached.nextChapterUrl) {
          fetchChapterPage(cached.nextChapterUrl).catch(() => {});
        }
        if (catalogUrl && cached.title) {
          const existing = getEntryFor(catalogUrl);
          saveProgress({
            catalogUrl,
            novelTitle: existing?.novelTitle || "",
            coverUrl: existing?.coverUrl || "",
            lastChapterUrl: chapterUrl,
            lastChapterTitle: cached.title,
            lastChapterIndex: existing?.lastChapterIndex ?? 0,
            totalChapters: existing?.totalChapters ?? 0,
            updatedAt: Date.now(),
            visitedChapters: existing?.visitedChapters ?? {},
          });
          markChapterVisited(catalogUrl, chapterUrl, cached.title);
        }
        return;
      }

      const data = await fetchChapterPage(chapterUrl);
      if (cancelled) return;

      const firstNodes = contentToNodes(data.content);
      const chTitle = data.title;
      setTitle(chTitle);
      setSubtitle("");
      document.title = `${chTitle} — 輕小說閱讀器`;
      setNodes(firstNodes);
      setLoading(false);
      setPageCount(1);
      setPrevUrl(data.prevChapterUrl);
      setPrevTitle(data.prevChapterUrl ? getCachedChapterTitle(data.prevChapterUrl) : "");

      if (catalogUrl && chTitle) {
        const existing = getEntryFor(catalogUrl);
        saveProgress({
          catalogUrl,
          novelTitle: existing?.novelTitle || "",
          coverUrl: existing?.coverUrl || "",
          lastChapterUrl: chapterUrl,
          lastChapterTitle: chTitle,
          lastChapterIndex: existing?.lastChapterIndex ?? 0,
          totalChapters: existing?.totalChapters ?? 0,
          updatedAt: Date.now(),
          visitedChapters: existing?.visitedChapters ?? {},
        });
        markChapterVisited(catalogUrl, chapterUrl, chTitle);
      }

      if (!data.nextPageUrl) {
        // Single-page chapter
        setNextUrl(data.nextChapterUrl);
        setNextTitle(data.nextChapterUrl ? getCachedChapterTitle(data.nextChapterUrl) : "");
        saveChapterCache(chapterUrl, {
          title: chTitle,
          subtitle: "",
          nodes: firstNodes,
          nextChapterUrl: data.nextChapterUrl,
        });
        if (data.nextChapterUrl) {
          fetchChapterPage(data.nextChapterUrl).catch(() => {});
        }
        return;
      }

      // Multi-page chapter: eagerly load ALL remaining sub-pages in background
      setLoadingMore(true);
      const allNodes = [...firstNodes];
      let nextPage: string | null = data.nextPageUrl;
      let pages = 1;
      while (nextPage) {
        if (cancelled || loadingChapterRef.current !== chapterUrl) return;
        try {
          const pageData = await fetchChapterPage(nextPage);
          if (cancelled || loadingChapterRef.current !== chapterUrl) return;
          const moreNodes = contentToNodes(pageData.content);
          allNodes.push(...moreNodes);
          pages++;
          setNodes([...allNodes]);
          setPageCount(pages);
          nextPage = pageData.nextPageUrl;
          if (!nextPage) {
            // Last sub-page reached
            setNextUrl(pageData.nextChapterUrl);
            setNextTitle(pageData.nextChapterUrl ? getCachedChapterTitle(pageData.nextChapterUrl) : "");
            saveChapterCache(chapterUrl, {
              title: chTitle,
              subtitle: "",
              nodes: allNodes,
              nextChapterUrl: pageData.nextChapterUrl,
            });
            if (pageData.nextChapterUrl) {
              fetchChapterPage(pageData.nextChapterUrl).catch(() => {});
            }
          }
        } catch (e) {
          console.error("[read] background sub-page load failed:", e);
          break;
        }
      }
      setLoadingMore(false);
    }

    loadInitial().catch(e => {
      if (!cancelled) { setError(String(e)); setLoading(false); setLoadingMore(false); }
    });

    return () => { cancelled = true; };
  }, [chapterUrl, catalogUrl]);

  const goBack = () => {
    if (catalogUrl) router.push(`/catalog?url=${encodeURIComponent(catalogUrl)}`);
    else router.push("/");
  };

  const goChapter = (url: string) => {
    router.push(`/read?url=${encodeURIComponent(url)}&catalog=${encodeURIComponent(catalogUrl)}`);
  };

  const cycleTheme = () => {
    setTheme(t => t === "dark" ? "sepia" : t === "sepia" ? "light" : "dark");
  };

  const themeIcon = theme === "dark" ? "☀" : theme === "sepia" ? "📜" : "🌙";

  const cycleFontFamily = () => {
    setFontFamily(f => f === "sans" ? "serif" : "sans");
  };

  // Label shows NEXT option
  const fontLabel = fontFamily === "sans" ? "宋" : "黑";

  const cycleLineHeight = () => {
    setLineHeightIdx(i => (i + 1) % LINE_HEIGHTS.length);
  };

  const currentLineHeight = LINE_HEIGHTS[lineHeightIdx];

  const handleAddBookmark = () => {
    const bm = addBookmark({
      catalogUrl,
      novelTitle: title,
      chapterUrl,
      chapterTitle: title,
      scrollPct: progress,
    });
    setBookmarks(prev => [bm, ...prev]);
  };

  const handleRemoveBookmark = (id: string) => {
    removeBookmark(id);
    setBookmarks(prev => prev.filter(b => b.id !== id));
  };

  const scrollToBookmark = (scrollPct: number) => {
    window.scrollTo({
      top: (scrollPct / 100) * (document.body.scrollHeight - window.innerHeight),
      behavior: "smooth",
    });
  };

  const btnStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    color: "var(--text-muted)",
    padding: "6px 13px",
    borderRadius: 20,
    fontSize: 12,
  };

  return (
    <main
      style={{ minHeight: "100vh" }}
      ref={contentRef}
      onTouchStart={e => {
        touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={e => {
        if (!touchStart.current) return;
        const dx = e.changedTouches[0].clientX - touchStart.current.x;
        const dy = e.changedTouches[0].clientY - touchStart.current.y;
        touchStart.current = null;
        if (Math.abs(dx) > 50 && Math.abs(dy) < Math.abs(dx)) {
          if (dx < 0 && nextUrl && !loading) goChapter(nextUrl);
          if (dx > 0 && prevUrl && !loading) goChapter(prevUrl);
        }
      }}
    >
      {/* Progress bar */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 2, background: "var(--border)", zIndex: 20 }}>
        <div style={{ height: "100%", background: "var(--accent)", width: `${progress}%`, transition: "width .2s" }} />
      </div>

      {/* Toolbar */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "linear-gradient(to bottom, var(--bg) 55%, transparent)", padding: "12px 20px 32px", pointerEvents: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", pointerEvents: "all" }}>
          <button onClick={goBack} style={btnStyle}>
            ← 目錄
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setFontSize(f => Math.max(14, f - 1))} style={btnStyle}>A−</button>
            <button onClick={() => setFontSize(f => Math.min(26, f + 1))} style={btnStyle}>A+</button>
            <button onClick={cycleFontFamily} style={btnStyle} title="切換字體">{fontLabel}</button>
            <button onClick={cycleLineHeight} style={btnStyle} title="切換行距">≡</button>
            <button onClick={cycleTheme} style={btnStyle} title="切換主題">{themeIcon}</button>
            <button onClick={cycleWidth} style={btnStyle} title="調整閱讀寬度">{readWidth}</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: readWidth, margin: "0 auto", padding: "0 24px", transition: "max-width .2s" }}>
        {!loading && !error && (
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            {subtitle && (
              <div style={{ fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 6, opacity: .75 }}>
                {subtitle}
              </div>
            )}
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)", lineHeight: 1.4 }}>{title}</h2>
            <div style={{ width: 36, height: 1, background: "var(--accent-dim)", margin: "12px auto 0" }} />
          </div>
        )}

        {loading && <div style={{ color: "var(--accent)", textAlign: "center", padding: "80px 0" }}>載入中…</div>}
        {error && <div style={{ color: "#e06c6c", textAlign: "center", padding: "80px 0" }}>載入失敗：{error}</div>}

        {!loading && !error && nodes.length === 0 && (
          <div style={{ color: "var(--text-muted)", textAlign: "center", padding: "80px 0" }}>
            無法解析章節內容（#acontent 未找到）
          </div>
        )}

        {!loading && !error && (
          <div style={{ fontSize: `${fontSize}px`, lineHeight: currentLineHeight, color: "var(--text)", fontFamily: FONT_MAP[fontFamily] }}>
            {nodes.map((node, i) =>
              node.type === "text" ? (
                <p key={i} style={{ marginBottom: "1.5em", textIndent: "2em" }}>{node.text}</p>
              ) : (
                <div key={i} style={{ textAlign: "center", margin: "2em 0" }}>
                  <img
                    src={`/api/image?url=${encodeURIComponent(node.src)}`}
                    alt={node.alt}
                    loading="lazy"
                    style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain", borderRadius: 6, border: "1px solid var(--border)" }}
                  />
                </div>
              )
            )}
          </div>
        )}

        {/* Background sub-page loading indicator */}
        {!loading && !error && loadingMore && (
          <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 12, opacity: 0.6 }}>
            載入剩餘內容中… (第 {pageCount} 頁)
          </div>
        )}

        {!loading && !error && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 60, padding: "24px 0 56px", display: "flex", alignItems: "stretch", justifyContent: "space-between", gap: 10 }}>
            <button
              onClick={() => prevUrl && goChapter(prevUrl)}
              disabled={!prevUrl}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, maxWidth: 200, opacity: prevUrl ? 1 : 0.3, textAlign: "left" }}
            >
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>← 上一章</span>
              <span style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{prevTitle || "上一章"}</span>
            </button>
            <button onClick={goBack} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, padding: "8px", whiteSpace: "nowrap", alignSelf: "center" }}>
              目錄
            </button>
            <button
              onClick={() => nextUrl && goChapter(nextUrl)}
              disabled={!nextUrl}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, maxWidth: 200, opacity: nextUrl ? 1 : 0.3, alignItems: "flex-end" }}
            >
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>下一章 →</span>
              <span style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{nextTitle || "下一章"}</span>
            </button>
          </div>
        )}
      </div>

      {/* Floating bookmark button */}
      <div style={{ position: "fixed", bottom: 80, right: 20, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, zIndex: 30 }}>
        {/* Bookmark pills */}
        {bookmarks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
            {bookmarks.map(bm => (
              <div key={bm.id} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, padding: "4px 10px", fontSize: 12, color: "var(--text-muted)" }}>
                <button
                  onClick={() => scrollToBookmark(bm.scrollPct)}
                  style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 12, padding: 0 }}
                >
                  {bm.scrollPct}%
                </button>
                <button
                  onClick={() => handleRemoveBookmark(bm.id)}
                  style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 12, padding: 0, lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bookmark add button */}
        <button
          onClick={handleAddBookmark}
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            fontSize: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            boxShadow: "0 2px 8px rgba(0,0,0,.3)",
          }}
          title="新增書籤"
        >
          🔖
          {bookmarks.length > 0 && (
            <span style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "var(--accent)",
              color: "var(--bg)",
              borderRadius: "50%",
              width: 16,
              height: 16,
              fontSize: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
            }}>
              {bookmarks.length}
            </span>
          )}
        </button>
      </div>
    </main>
  );
}

export default function ReadPage() {
  return <Suspense><ReadContent /></Suspense>;
}
