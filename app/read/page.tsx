"use client";
import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  saveProgress,
  getEntryFor,
  markChapterVisited,
  getCachedChapterTitle,
  resolveChapterTitle,
  saveScrollProgress,
  saveChapterScroll,
  getChapterScroll,
  addBookmark,
  getBookmarksForChapter,
  removeBookmark,
  getChapterCache,
  saveChapterCache,
  Bookmark,
  loadSettings,
  saveSettings,
  ReaderSettings,
  getCatalogCache,
} from "@/lib/history";
import { parseChapterHtml } from "@/lib/chapter-parser";
import { restoreChars } from "@/lib/linovelib-charmap";
import { CloseIcon, SunIcon, MoonIcon, ScrollIcon, BookmarkIcon, CircleIcon } from "@/components/icons";
import { CommentBoard } from "@/components/CommentBoard";

type ChapterPageApiResult = {
  title: string;
  content: string;
  nextPageUrl: string | null;
  nextChapterUrl: string | null;
  prevChapterUrl: string | null;
  cached?: boolean;
};

/**
 * Fetch a chapter page via the Next.js API route.
 * Throws an error if the backend API fails.
 */
async function fetchChapterPage(url: string, catalogUrl: string): Promise<ChapterPageApiResult> {
  const res = await fetch(`/api/chapter?url=${encodeURIComponent(url)}&catalogUrl=${encodeURIComponent(catalogUrl)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Prefetch store — holds the first-page API result for the next chapter so
// navigation feels instant.  Lives in module scope (cleared on full page reload).
// ---------------------------------------------------------------------------
const prefetchStore = new Map<string, ChapterPageApiResult>();

/** Prefetch the first page of a chapter and cache the result for instant navigation. */
async function prefetchNextChapter(url: string, catalogUrl: string): Promise<void> {
  if (!url || prefetchStore.has(url)) return;
  // Check full chapter cache first — nothing to prefetch if already complete
  if (getChapterCache(url)) return;
  try {
    const result = await fetchChapterPage(url, catalogUrl);
    
    // Fallback for older backends that return 'html' instead of 'content'
    if (!result.content && (result as any).html) {
      const parsed = parseChapterHtml((result as any).html, url, null);
      Object.assign(result, parsed);
    }
    
    // Apply traditional chinese conversion
    result.content = restoreChars(result.content || "");
    
    prefetchStore.set(url, result);
    // Single-page chapters can be saved to full chapter cache immediately
    if (!result.nextPageUrl) {
      saveChapterCache(url, {
        title: result.title,
        subtitle: "",
        nodes: contentToNodes(result.content),
        nextChapterUrl: result.nextChapterUrl,
      });
      prefetchStore.delete(url); // full cache covers it now
    }
  } catch {
    // Prefetch failures are silent — user will still get normal fetch on navigation
  }
}

type ContentNode = { type: "text"; text: string } | { type: "image"; src: string; alt: string } | { type: "page-number"; text: string };

/** Convert plain-text chapter content (paragraphs separated by \n\n) to ContentNode[] */
function contentToNodes(content: string): ContentNode[] {
  return content
    .split(/\n\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const imgMatch = /^\[IMG:(https?:\/\/.+)\]$/.exec(line);
      if (imgMatch) return { type: "image" as const, src: imgMatch[1], alt: "" };
      
      if (/^\d{1,3}$/.test(line) || /^-\s*\d{1,3}\s*-$/.test(line)) {
        return { type: "page-number" as const, text: line };
      }
      
      return { type: "text" as const, text: line };
    });
}

type Theme = "dark" | "sepia" | "light" | "amoled";
type FontFamily = "sans" | "serif" | "kai";

const FONT_MAP: Record<FontFamily, string> = {
  sans: "Arial, Helvetica, sans-serif",
  serif: '"Georgia", "Times New Roman", serif',
  kai: '"LXGW WenKai TC", cursive, serif',
};

const LINE_HEIGHTS = [1.7, 1.95, 2.4] as const;

function ReadContent() {
  const params = useSearchParams();
  const router = useRouter();
  const urlParam = params.get("url");
  const chapterUrl = (urlParam && urlParam !== "null") ? urlParam : "";
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
    const settings = loadSettings();
    return settings.fontSize || 17;
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
    return loadSettings().theme || "dark";
  });

  // Font family
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => {
    if (typeof window === "undefined") return "sans";
    return (localStorage.getItem("linovelib-font") as FontFamily) ?? "sans";
  });

  // Line height
  const [lineHeightIdx, setLineHeightIdx] = useState(() => {
    if (typeof window === "undefined") return 1;
    const h = loadSettings().lineHeight;
    const idx = LINE_HEIGHTS.indexOf(h as any);
    return idx === -1 ? 1 : idx;
  });

  // Image Zoom
  const [zoomedImg, setZoomedImg] = useState<string | null>(null);

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const contentRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const pendingRestoreRef = useRef<number>(0);

  // Auto Scroll
  const [autoScroll, setAutoScroll] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(2); // 1-5

  // UI Toggle & Drawer
  const [showUI, setShowUI] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const catalog = catalogUrl ? getCatalogCache(catalogUrl) : null;
  const [visitedChapters, setVisitedChapters] = useState<Record<string, string>>({});

  useEffect(() => {
    if (catalogUrl) {
      const entry = getEntryFor(catalogUrl);
      if (entry) {
        setVisitedChapters(entry.visitedChapters || {});
      }
    }
  }, [catalogUrl, chapterUrl, drawerOpen]);

  // Scroll to active chapter in drawer when opened
  useEffect(() => {
    if (drawerOpen && chapterUrl) {
      setTimeout(() => {
        const el = document.getElementById(`drawer-ch-${encodeURIComponent(chapterUrl)}`);
        const container = document.getElementById("drawer-scroll-container");
        if (el && container) {
          container.scrollTo({
            top: el.offsetTop - container.offsetHeight / 2 + el.offsetHeight / 2,
            behavior: "smooth"
          });
        }
      }, 50); // slight delay to ensure render
    }
  }, [drawerOpen, chapterUrl]);

  // Apply theme to document
  useEffect(() => {
    if (theme === "dark") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // Sync settings when they change
  useEffect(() => {
    saveSettings({ theme, fontSize, lineHeight: LINE_HEIGHTS[lineHeightIdx] });
  }, [theme, fontSize, lineHeightIdx]);

  // Persist font family
  useEffect(() => {
    localStorage.setItem("linovelib-font", fontFamily);
  }, [fontFamily]);

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

  // Auto-save scroll progress & auto bookmark
  useEffect(() => {
    if (!catalogUrl || loading || !title || progress === 0) return;
    const timeout = setTimeout(() => {
      saveScrollProgress(catalogUrl, progress);
      if (chapterUrl) {
        saveChapterScroll(chapterUrl, progress);
        addBookmark({
          catalogUrl,
          novelTitle: title,
          chapterUrl,
          chapterTitle: title,
          scrollPct: progress,
          isAuto: true,
        });
        setBookmarks(getBookmarksForChapter(chapterUrl));
      }
    }, 5000);
    return () => clearTimeout(timeout);
  }, [progress, catalogUrl, chapterUrl, loading, title]);

  // Word count reporting
  const reportedWordsRef = useRef<Set<string>>(new Set());
  
  useEffect(() => {
    if (!chapterUrl || loading || progress < 20 || nodes.length === 0) return;
    if (reportedWordsRef.current.has(chapterUrl)) return;
    
    // Scrolled past 20%, let's report chapter to backend
    reportedWordsRef.current.add(chapterUrl);
    const token = localStorage.getItem("linovelib-token");
    if (token) {
      fetch("/api/sync/words", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ chapter_url: chapterUrl })
      }).catch(console.error);
    }
  }, [chapterUrl, progress, loading, nodes]);

  // Auto scroll effect
  useEffect(() => {
    if (!autoScroll) return;
    let animationFrameId: number;
    let lastTime = performance.now();
    let exactY = window.scrollY;
    
    const loop = (time: number) => {
      const deltaTime = time - lastTime;
      lastTime = time;
      
      if (deltaTime > 0) {
        // speed 1 -> 15px/s, speed 5 -> 75px/s
        const pxPerSec = scrollSpeed * 15;
        exactY += (pxPerSec * deltaTime) / 1000;
        window.scrollTo(0, exactY);
        // Sync exactY if user scrolled manually
        if (Math.abs(exactY - window.scrollY) > 2) {
          exactY = window.scrollY;
        }
      }
      animationFrameId = requestAnimationFrame(loop);
    };
    
    animationFrameId = requestAnimationFrame(loop);
    
    // Stop auto-scroll if user intentional scrolls
    const handleTouch = () => setAutoScroll(false);
    window.addEventListener("touchmove", handleTouch, { passive: true });
    window.addEventListener("wheel", handleTouch, { passive: true });
    
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("touchmove", handleTouch);
      window.removeEventListener("wheel", handleTouch);
    };
  }, [autoScroll, scrollSpeed]);

  // Restore saved scroll position once the full chapter is loaded (handles multi-page chapters)
  useEffect(() => {
    if (loading || loadingMore) return;
    const pct = pendingRestoreRef.current;
    if (pct > 0) {
      pendingRestoreRef.current = 0;
      window.scrollTo({
        top: (pct / 100) * (document.body.scrollHeight - window.innerHeight),
        behavior: "instant",
      });
    } else {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [loading, loadingMore]);

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

  // Main Data Fetch
  useEffect(() => {
    if (!chapterUrl) {
      setError("無效的章節連結 (Invalid URL)");
      setLoading(false);
      return;
    }
    if (chapterUrl === loadingChapterRef.current) return;
    
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
    setNextTitle(cached?.nextChapterUrl ? resolveChapterTitle(catalogUrl, cached.nextChapterUrl) : "");
    setPrevTitle("");
    setPageCount(cached ? 1 : 0);
    window.scrollTo(0, 0);
    // Store the saved scroll position; the restoration effect fires once loading is done.
    pendingRestoreRef.current = getChapterScroll(chapterUrl);

    async function loadInitial() {
      if (cached) {
        if (cancelled) return;
        setTitle(cached.title);
        setSubtitle(cached.subtitle);
        document.title = `${cached.title} — 輕小說閱讀器`;
        setNodes(cached.nodes);
        setLoading(false);
        setNextUrl(cached.nextChapterUrl);
        setNextTitle(cached.nextChapterUrl ? resolveChapterTitle(catalogUrl, cached.nextChapterUrl) : "");
        setPageCount(1);
        if (cached.nextChapterUrl) {
          prefetchNextChapter(cached.nextChapterUrl, catalogUrl);
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
            author: existing?.author,
            desc: existing?.desc,
            tags: existing?.tags,
          });
          markChapterVisited(catalogUrl, chapterUrl, cached.title);
        }
        return;
      }

      // Use prefetched first-page result if available
      const prefetched = prefetchStore.get(chapterUrl);
      if (prefetched) prefetchStore.delete(chapterUrl);
      const data = prefetched ?? await fetchChapterPage(chapterUrl, catalogUrl);
      if (cancelled) return;

      if (!data.content && (data as any).html) {
        const parsed = parseChapterHtml((data as any).html, chapterUrl, null);
        Object.assign(data, parsed);
      }

      data.content = restoreChars(data.content || "");
      const firstNodes = contentToNodes(data.content);
      const chTitle = data.title;
      setTitle(chTitle);
      setSubtitle("");
      document.title = `${chTitle} — 輕小說閱讀器`;
      setNodes(firstNodes);
      setLoading(false);
      setPageCount(1);
      setPrevUrl(data.prevChapterUrl);
      setPrevTitle(data.prevChapterUrl ? resolveChapterTitle(catalogUrl, data.prevChapterUrl) : "");

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
          author: existing?.author,
          desc: existing?.desc,
          tags: existing?.tags,
        });
        markChapterVisited(catalogUrl, chapterUrl, chTitle);
      }

      if (!data.nextPageUrl) {
        // Single-page chapter
        setNextUrl(data.nextChapterUrl);
        setNextTitle(data.nextChapterUrl ? resolveChapterTitle(catalogUrl, data.nextChapterUrl) : "");
        saveChapterCache(chapterUrl, {
          title: chTitle,
          subtitle: "",
          nodes: firstNodes,
          nextChapterUrl: data.nextChapterUrl,
        });
        if (data.nextChapterUrl) {
          prefetchNextChapter(data.nextChapterUrl, catalogUrl);
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
          const pageData = await fetchChapterPage(nextPage, catalogUrl);
          if (cancelled || loadingChapterRef.current !== chapterUrl) return;
          
          if (!pageData.content && (pageData as any).html) {
            const parsedPage = parseChapterHtml((pageData as any).html, nextPage, null);
            Object.assign(pageData, parsedPage);
          }
          
          pageData.content = restoreChars(pageData.content || "");
          const moreNodes = contentToNodes(pageData.content);
          allNodes.push(...moreNodes);
          pages++;
          setNodes([...allNodes]);
          setPageCount(pages);
          nextPage = pageData.nextPageUrl;
          if (!nextPage) {
            // Last sub-page reached
            setNextUrl(pageData.nextChapterUrl);
            setNextTitle(pageData.nextChapterUrl ? resolveChapterTitle(catalogUrl, pageData.nextChapterUrl) : "");
            saveChapterCache(chapterUrl, {
              title: chTitle,
              subtitle: "",
              nodes: allNodes,
              nextChapterUrl: pageData.nextChapterUrl,
            });
            if (pageData.nextChapterUrl) {
              prefetchNextChapter(pageData.nextChapterUrl, catalogUrl);
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

  const handleMainClick = (e: React.MouseEvent) => {
    // 避免點擊按鈕或連結時觸發 UI 切換
    if ((e.target as HTMLElement).closest('button')) return;
    if ((e.target as HTMLElement).closest('a')) return;
    if (zoomedImg) return;
    setShowUI(prev => !prev);
  };

  const goBack = () => {
    if (params.get("from") === "home") {
      router.replace(`/catalog?url=${encodeURIComponent(catalogUrl)}`);
    } else {
      router.back();
    }
  };

  const goChapter = (url: string) => {
    const fromParam = params.get("from") ? `&from=${params.get("from")}` : "";
    router.replace(`/read?url=${encodeURIComponent(url)}&catalog=${encodeURIComponent(catalogUrl)}${fromParam}`);
  };

  const cycleTheme = () => {
    setTheme(t => t === "dark" ? "sepia" : t === "sepia" ? "light" : t === "light" ? "amoled" : "dark");
  };

  const themeIcon = theme === "dark" ? <SunIcon /> : theme === "sepia" ? <ScrollIcon /> : theme === "light" ? <MoonIcon /> : <CircleIcon />;

  const cycleFontFamily = () => {
    setFontFamily(f => f === "sans" ? "serif" : f === "serif" ? "kai" : "sans");
  };

  // Label shows NEXT option
  const fontLabel = fontFamily === "sans" ? "宋" : fontFamily === "serif" ? "楷" : "黑";

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
      style={{ minHeight: "100vh", position: "relative" }}
      ref={contentRef}
      onClick={handleMainClick}
      onTouchStart={e => {
        touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={e => {
        if (!touchStart.current) return;
        const dx = e.changedTouches[0].clientX - touchStart.current.x;
        const dy = e.changedTouches[0].clientY - touchStart.current.y;
        touchStart.current = null;
        if (Math.abs(dx) > 120 && Math.abs(dy) < Math.abs(dx)) {
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
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, background: "linear-gradient(to bottom, var(--bg) 80%, transparent)", padding: "12px 20px 32px", opacity: showUI ? 1 : 0, transform: showUI ? "translateY(0)" : "translateY(-100%)", transition: "all 0.3s ease", pointerEvents: showUI ? "all" : "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={goBack} style={btnStyle}>← 返回</button>
            <button onClick={() => setDrawerOpen(true)} style={btnStyle}>三 目錄</button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setFontSize(f => Math.max(14, f - 1))} style={btnStyle}>A−</button>
            <button onClick={() => setFontSize(f => Math.min(26, f + 1))} style={btnStyle}>A+</button>
            <button onClick={cycleFontFamily} style={btnStyle} title="切換字體">{fontLabel}</button>
            <button onClick={cycleLineHeight} style={btnStyle} title="切換行距">≡</button>
            <button onClick={cycleTheme} style={btnStyle} title="切換主題">{themeIcon}</button>
            <button onClick={cycleWidth} style={btnStyle} title="調整閱讀寬度">{readWidth}</button>
            <button onClick={() => {
              const nextState = !autoScroll;
              setAutoScroll(nextState);
              if (nextState) setShowUI(false);
            }} style={{ ...btnStyle, color: autoScroll ? "var(--accent)" : "var(--text-muted)" }} title="自動捲動">{autoScroll ? "⏸" : "▶"}</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: readWidth, margin: "0 auto", padding: "60px 24px 0", transition: "max-width .2s" }}>
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
              ) : node.type === "page-number" ? (
                <div key={i} style={{ textAlign: "center", color: "var(--text-dim)", fontSize: "0.75em", margin: "2.5em 0", opacity: 0.6 }}>
                  {node.text}
                </div>
              ) : (
                <div key={i} style={{ textAlign: "center", margin: "2em 0" }}>
                  <img
                    src={`/api/image?url=${encodeURIComponent(node.src)}`}
                    alt={node.alt}
                    loading="lazy"
                    style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain", borderRadius: 6, border: "1px solid var(--border)", cursor: "zoom-in" }}
                    onClick={() => setZoomedImg(node.src)}
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
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, maxWidth: 200, opacity: prevUrl ? 1 : 0.3, textAlign: "left", cursor: prevUrl ? "pointer" : "default" }}
            >
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>← 上一章</span>
              {prevTitle && <span style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{prevTitle}</span>}
            </button>
            <button onClick={goBack} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 13, padding: "8px 16px", whiteSpace: "nowrap", alignSelf: "center", cursor: "pointer", fontWeight: "bold", boxShadow: "0 2px 4px rgba(0,0,0,0.1)" }}>
              回到目錄
            </button>
            <button
              onClick={() => nextUrl && goChapter(nextUrl)}
              disabled={!nextUrl}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, maxWidth: 200, opacity: nextUrl ? 1 : 0.3, alignItems: "flex-end", cursor: nextUrl ? "pointer" : "default", textAlign: "right" }}
            >
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>下一章 →</span>
              {nextTitle && <span style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{nextTitle}</span>}
            </button>
          </div>
        )}

        {!loading && !error && (
          <div style={{ paddingBottom: 60 }}>
            <CommentBoard 
              title="章節留言板" 
              apiEndpoint={`/api/comments?chapterUrl=${encodeURIComponent(chapterUrl)}`}
              postEndpoint="/api/comments"
              payloadKey="chapterUrl"
              payloadValue={chapterUrl}
            />
          </div>
        )}
      </div>

      {/* Floating bookmark button */}
      <div style={{ position: "fixed", bottom: 80, right: 20, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, zIndex: 30, opacity: showUI ? 1 : 0, transform: showUI ? "translateY(0)" : "translateY(20px)", transition: "all 0.3s ease", pointerEvents: showUI ? "all" : "none" }}>
        {/* Bookmark pills */}
        {bookmarks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
            {bookmarks.map(bm => (
              <div key={bm.id} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, padding: "4px 10px", fontSize: 12, color: "var(--text-muted)" }}>
                {bm.isAuto && <span style={{ color: "var(--accent-dim)", fontSize: 10, fontWeight: "bold" }}>[自動]</span>}
                <button
                  onClick={() => scrollToBookmark(bm.scrollPct)}
                  style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 12, padding: 0 }}
                >
                  {bm.scrollPct}%
                </button>
                <button
                  onClick={() => handleRemoveBookmark(bm.id)}
                  style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 12, padding: 0, lineHeight: 1, display: "flex", alignItems: "center" }}
                >
                  <CloseIcon style={{ fontSize: 14 }} />
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
          <BookmarkIcon style={{ fontSize: 22 }} />
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

      {/* Sidebar Catalog Drawer */}
      <div style={{ position: "fixed", inset: 0, zIndex: 100, pointerEvents: drawerOpen ? "all" : "none" }}>
        <div 
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", opacity: drawerOpen ? 1 : 0, transition: "opacity 0.3s" }} 
          onClick={() => setDrawerOpen(false)}
        />
        <div style={{ 
          position: "absolute", top: 0, bottom: 0, left: 0, width: "80%", maxWidth: 320, 
          background: "var(--bg)", borderRight: "1px solid var(--border)",
          transform: drawerOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          display: "flex", flexDirection: "column"
        }}>
          <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center" }}>
            {catalog?.coverUrl && <img src={`/api/image?url=${encodeURIComponent(catalog.coverUrl)}`} alt={catalog?.title} style={{ width: 48, height: 64, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />}
            <div style={{ fontWeight: "bold", fontSize: 16, flex: 1, wordBreak: "break-all", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.4 }}>{catalog?.title || "目錄"}</div>
            <button onClick={() => setDrawerOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 16, padding: 4, display: "flex" }}><CloseIcon style={{ fontSize: 20 }} /></button>
          </div>
          <div id="drawer-scroll-container" style={{ flex: 1, overflowY: "auto", position: "relative" }}>
            {catalog?.groups.map((vol, i) => (
              <div key={i} style={{ marginTop: i === 0 ? 0 : 16 }}>
                {(vol.volTitle || vol.coverUrl) && (
                  <div style={{ display: "flex", alignItems: "center", padding: "12px 20px", background: "var(--surface)", position: "sticky", top: 0, zIndex: 1, gap: 16, borderBottom: "1px solid var(--border)", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
                    {vol.coverUrl && (
                      <img src={`/api/image?url=${encodeURIComponent(vol.coverUrl)}`} alt={vol.volTitle} style={{ width: 64, height: 90, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)", flexShrink: 0 }} />
                    )}
                    {vol.volTitle && (
                      <div style={{ fontSize: 15, fontWeight: "bold", color: "var(--text)", flex: 1, lineHeight: 1.4 }}>{vol.volTitle}</div>
                    )}
                  </div>
                )}
                {vol.chapters.map((ch, j) => {
                  const isActive = ch.url === chapterUrl;
                  const isVisited = !!ch.url && !!visitedChapters[ch.url];
                  return (
                    <div 
                      key={j} 
                      id={`drawer-ch-${encodeURIComponent(ch.url!)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (ch.url && !isActive) { setDrawerOpen(false); goChapter(ch.url); }
                      }}
                      style={{ 
                        margin: "2px 8px",
                        borderRadius: 6,
                        padding: "10px 12px", 
                        fontSize: 14, 
                        color: isActive ? "var(--accent)" : "var(--text)",
                        fontWeight: isActive ? "bold" : "normal",
                        cursor: "pointer",
                        border: isActive ? "1px solid rgba(200,169,110,.4)" : "1px solid transparent",
                        boxShadow: isActive ? "0 2px 8px rgba(200,169,110,.15)" : "none",
                        background: isActive ? "var(--surface)" : "transparent",
                        display: "flex", justifyContent: "space-between", alignItems: "center"
                      }}
                    >
                      <span style={{ color: isVisited && !isActive ? "var(--text-muted)" : "inherit", flex: 1, paddingRight: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ch.title}</span>
                      {!isActive && (
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: isVisited ? "var(--border)" : "var(--accent)", flexShrink: 0 }} />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Image Zoom Modal */}
      {zoomedImg && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.9)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}
          onClick={() => setZoomedImg(null)}
        >
          <img
            src={`/api/image?url=${encodeURIComponent(zoomedImg)}`}
            alt="Zoomed"
            style={{ maxWidth: "100vw", maxHeight: "100vh", objectFit: "contain", userSelect: "none" }}
          />
        </div>
      )}
    </main>
  );
}

export default function ReadPage() {
  return <Suspense><ReadContent /></Suspense>;
}
