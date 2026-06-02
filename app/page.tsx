"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getHistory, type HistoryEntry } from "@/lib/history";
import type { SearchResult } from "@/app/api/search/route";

export default function Home() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setHistory(getHistory());
  }, []);

  // Debounced search as-you-type
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setResults([]); setSearchError(""); return; }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setResults(data.results ?? []);
      } catch (e) {
        setSearchError(String(e));
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 600);
  }, [query]);

  const goNovel = (catalogUrl: string) => {
    router.push(`/catalog?url=${encodeURIComponent(catalogUrl)}`);
  };

  const resumeReading = (entry: HistoryEntry) => {
    router.push(
      `/read?url=${encodeURIComponent(entry.lastChapterUrl)}&catalog=${encodeURIComponent(entry.catalogUrl)}`
    );
  };

  const progressPct = (entry: HistoryEntry) =>
    entry.totalChapters > 0
      ? Math.round(((entry.lastChapterIndex + 1) / entry.totalChapters) * 100)
      : 0;

  const showResults = query.trim().length > 0;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 24px 80px" }}>
      <div style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", opacity: .7, marginBottom: 8 }}>
        Light Novel Reader
      </div>
      <h1 style={{ fontSize: "clamp(26px,5vw,38px)", fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
        輕小說閱讀器
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 36 }}>
        搜尋小說名稱或貼上網址即可開始閱讀
      </p>

      {/* Search bar */}
      <div style={{ width: "100%", maxWidth: 560, position: "relative" }}>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", display: "flex", alignItems: "center", padding: "4px 4px 4px 16px", gap: 8 }}>
          <span style={{ color: "var(--text-dim)", fontSize: 15, flexShrink: 0 }}>🔍</span>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜尋小說 或 貼上 linovelib 網址"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 14, padding: "10px 0" }}
            autoComplete="off"
          />
          {query && (
            <button onClick={() => { setQuery(""); setResults([]); }} style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 18, padding: "4px 8px", cursor: "pointer" }}>✕</button>
          )}
          {!query && (
            <button
              onClick={() => {
                const normalized = tryNormalizeUrl(query);
                if (normalized) router.push(`/catalog?url=${encodeURIComponent(normalized)}`);
              }}
              style={{ background: "var(--accent)", color: "#0a0a0d", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}
            >
              開始閱讀
            </button>
          )}
        </div>

        {/* URL shortcut: if input looks like a URL */}
        {query.trim() && tryNormalizeUrl(query) && (
          <div
            style={{ marginTop: 4, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 16px", cursor: "pointer", fontSize: 13, color: "var(--accent)" }}
            onClick={() => router.push(`/catalog?url=${encodeURIComponent(tryNormalizeUrl(query)!)}`)}
          >
            → 直接開啟這個網址
          </div>
        )}

        {/* Search results */}
        {showResults && !tryNormalizeUrl(query) && (
          <div style={{ marginTop: 4, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
            {searching && (
              <div style={{ padding: "16px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>搜尋中…</div>
            )}
            {searchError && (
              <div style={{ padding: "16px", color: "#e06c6c", fontSize: 13 }}>搜尋失敗：{searchError}</div>
            )}
            {!searching && !searchError && results.length === 0 && query.trim() && (
              <div style={{ padding: "16px", color: "var(--text-dim)", fontSize: 13, textAlign: "center" }}>沒有結果</div>
            )}
            {!searching && results.map(r => (
              <div
                key={r.id}
                onClick={() => goNovel(r.catalogUrl)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid var(--border)", transition: "background .1s" }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = "var(--surface2)"}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = ""}
              >
                <div style={{ width: 36, height: 50, flexShrink: 0, borderRadius: 3, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)" }}>
                  {r.coverUrl ? (
                    <img src={`/api/image?url=${encodeURIComponent(r.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "var(--text-dim)" }}>📖</div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                  {r.author && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{r.author}</div>}
                </div>
                <span style={{ color: "var(--text-dim)", fontSize: 16 }}>›</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reading history */}
      {history.length > 0 && !showResults && (
        <div style={{ width: "100%", maxWidth: 560, marginTop: 48 }}>
          <div style={{ fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 12 }}>
            繼續閱讀
          </div>
          {history.map(entry => (
            <div
              key={entry.catalogUrl}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid transparent", transition: "all .12s" }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "var(--surface)"; (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ""; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}
              onClick={() => resumeReading(entry)}
            >
              <div style={{ width: 42, height: 58, borderRadius: 4, flexShrink: 0, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)" }}>
                {entry.coverUrl ? (
                  <img src={`/api/image?url=${encodeURIComponent(entry.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "var(--text-dim)" }}>📖</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.novelTitle}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>上次：{entry.lastChapterTitle}</div>
                <div style={{ marginTop: 6, background: "var(--border)", height: 3, borderRadius: 2 }}>
                  <div style={{ height: "100%", borderRadius: 2, background: "var(--accent)", width: `${progressPct(entry)}%` }} />
                </div>
              </div>
              <div style={{ color: "var(--text-dim)", flexShrink: 0, fontSize: 18 }}>›</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

/** 如果 input 像是 linovelib/bilinovel 的 URL，直接正規化回傳 catalog URL */
function tryNormalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s.includes("linovelib.com") && !s.includes("bilinovel.com")) return null;
  try {
    const url = s.startsWith("http") ? new URL(s) : new URL("https://" + s);
    const m = /\/novel\/(\d+)/.exec(url.pathname);
    if (!m) return null;
    return `https://tw.linovelib.com/novel/${m[1]}/catalog`;
  } catch { return null; }
}
