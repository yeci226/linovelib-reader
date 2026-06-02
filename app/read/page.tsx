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


type ChapterApiResult = {
  title: string;
  content: string;
  pages: number;
  nextChapterUrl: string | null;
  prevChapterUrl: string | null;
  cached?: boolean;
};

async function fetchChapter(url: string): Promise<ChapterApiResult> {
  const res = await fetch(`/api/chapter?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

type ContentNode = { type: "text"; text: string } | { type: "image"; src: string; alt: string };

/** Convert plain-text chapter content (paragraphs separated by \n\n) to ContentNode[] */
function contentToNodes(content: string): ContentNode[] {
  return content
    .split(/\n\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(text => ({ type: "text" as const, text }));
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

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [nodes, setNodes] = useState<ContentNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fontSize, setFontSize] = useState(17);
  const [progress, setProgress] = useState(0);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  const [nextTitle, setNextTitle] = useState("");
  const [prevTitle, setPrevTitle] = useState("");

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

    setLoading(true);
    setNodes([]);
    setSubtitle("");
    setError("");
    setNextUrl(null);
    setPrevUrl(null);
    setNextTitle("");
    setPrevTitle("");
    window.scrollTo(0, 0);

    async function fetchAll() {
      // ── Cache-first ──
      const cached = getChapterCache(chapterUrl);
      if (cached) {
        setTitle(cached.title);
        setSubtitle(cached.subtitle);
        document.title = `${cached.title} — 輕小說閱讀器`;
        setNodes(cached.nodes);
        setLoading(false);
        setNextUrl(cached.nextChapterUrl);
        setNextTitle(cached.nextChapterUrl ? getCachedChapterTitle(cached.nextChapterUrl) : "");
        return;
      }

      const data = await fetchChapter(chapterUrl);
      if (cancelled) return;

      const nodes = contentToNodes(data.content);
      const chapterTitle = data.title;
      const finalNext = data.nextChapterUrl;
      const finalPrev = data.prevChapterUrl;

      setTitle(chapterTitle);
      setSubtitle("");
      document.title = `${chapterTitle} — 輕小說閱讀器`;
      setNodes(nodes);
      setLoading(false);
      setNextUrl(finalNext);
      setPrevUrl(finalPrev);
      setNextTitle(finalNext ? getCachedChapterTitle(finalNext) : "");
      setPrevTitle(finalPrev ? getCachedChapterTitle(finalPrev) : "");

      // Save to chapter cache
      saveChapterCache(chapterUrl, {
        title: chapterTitle,
        subtitle: "",
        nodes,
        nextChapterUrl: finalNext,
      });

      // Background-prefetch next chapter (warms server cache)
      if (finalNext && !cancelled) {
        fetchChapter(finalNext).then(d => {
          if (cancelled) return;
          if (d.title) setNextTitle(d.title);
          if (d.nextChapterUrl) fetchChapter(d.nextChapterUrl).catch(() => {});
        }).catch(() => {});
      }

      if (catalogUrl && chapterTitle) {
        const existing = getEntryFor(catalogUrl);
        saveProgress({
          catalogUrl,
          novelTitle: existing?.novelTitle || "",
          coverUrl: existing?.coverUrl || "",
          lastChapterUrl: chapterUrl,
          lastChapterTitle: chapterTitle,
          lastChapterIndex: existing?.lastChapterIndex ?? 0,
          totalChapters: existing?.totalChapters ?? 0,
          updatedAt: Date.now(),
          visitedChapters: existing?.visitedChapters ?? {},
        });
        markChapterVisited(catalogUrl, chapterUrl, chapterTitle);
      }
    }

    fetchAll().catch(e => {
        if (!cancelled) { setError(String(e)); setLoading(false); }
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
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 660, margin: "0 auto", padding: "0 24px" }}>
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
                    src={node.src}
                    alt={node.alt}
                    loading="lazy"
                    style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain", borderRadius: 6, border: "1px solid var(--border)" }}
                  />
                </div>
              )
            )}
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
