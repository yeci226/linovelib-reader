"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getHistory, type HistoryEntry } from "@/lib/history";
import { BookIcon, SettingsIcon, ImagePlaceholderIcon } from "@/components/icons";

interface SearchResult {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  desc: string;
  catalogUrl: string;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setHistory(getHistory());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = tryNormalizeUrl(input);
    if (url) {
      setError("");
      router.push(`/catalog?url=${encodeURIComponent(url)}`);
      return;
    }
    
    // Not a direct URL/ID, try searching
    if (!input.trim()) return;
    setIsSearching(true);
    setError("");
    setSearchResults(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(input)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "搜尋失敗");
      setSearchResults(data.results || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSearching(false);
    }
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

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 24px 80px" }}>
      <div style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", opacity: .7, marginBottom: 8 }}>
        Light Novel Reader
      </div>
      <h1 style={{ fontSize: "clamp(26px,5vw,38px)", fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
        輕小說閱讀器
      </h1>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button onClick={() => router.push("/library")} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "6px 14px", borderRadius: 16, fontSize: 13, cursor: "pointer" }}>
          <BookIcon style={{ fontSize: 14 }} /> 小說文庫
        </button>
        <button onClick={() => router.push("/settings")} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "6px 14px", borderRadius: 16, fontSize: 13, cursor: "pointer" }}>
          <SettingsIcon style={{ fontSize: 14 }} /> 設定與同步
        </button>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
        輸入小說 ID 或貼上嗶哩輕小說網址開始閱讀
      </p>

      {/* Input */}
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ background: "var(--surface)", border: `1px solid ${error ? "#e06c6c" : "var(--border)"}`, borderRadius: "var(--radius)", display: "flex", alignItems: "center", padding: "4px 4px 4px 16px", gap: 8, transition: "border-color .2s" }}>
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setError(""); setSearchResults(null); }}
            placeholder="輸入小說書名、ID 或是網址..."
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 14, padding: "10px 0" }}
            autoComplete="off"
          />
          <button type="submit" disabled={isSearching} style={{ background: "var(--accent)", color: "#0a0a0d", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", cursor: "pointer", opacity: isSearching ? 0.7 : 1 }}>
            {isSearching ? "搜尋中..." : "開始閱讀"}
          </button>
        </div>
        {error && <p style={{ color: "#e06c6c", fontSize: 12, marginTop: 6 }}>{error}</p>}
      </form>

      {/* Search Results */}
      {searchResults && (
        <div style={{ width: "100%", maxWidth: 560, marginTop: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 12 }}>
            搜尋結果 ({searchResults.length})
          </div>
          {searchResults.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>找不到符合的小說，請嘗試更換關鍵字。</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {searchResults.map(res => (
                <div 
                  key={res.id} 
                  onClick={() => router.push(`/catalog?url=${encodeURIComponent(res.catalogUrl)}`)}
                  style={{ display: "flex", gap: 16, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, cursor: "pointer" }}
                >
                  <div style={{ width: 60, height: 80, borderRadius: 4, flexShrink: 0, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)" }}>
                    {res.coverUrl ? (
                      <img src={`/api/image?url=${encodeURIComponent(res.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}><ImagePlaceholderIcon style={{ fontSize: 24 }} /></div>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{res.title}</div>
                    <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 4 }}>{res.author}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{res.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* How-to (hide if searching) */}
      {!searchResults && history.length === 0 && (
        <div style={{ width: "100%", maxWidth: 560, marginTop: 20, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px 20px" }}>
        <div style={{ fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 14, opacity: .8 }}>如何取得小說 ID</div>
        <ol style={{ margin: 0, paddingLeft: 18, listStyle: "decimal" }}>
          {[
            <>前往 <a href="https://tw.linovelib.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>tw.linovelib.com</a> 搜尋想讀的小說</>,
            "點入小說頁面",
            <>從網址列複製網址，例如 <code style={codeStyle}>tw.linovelib.com/novel/2139.html</code></>,
            "貼回上方輸入框，或直接輸入數字 ID（如 2139）",
          ].map((step, i) => (
            <li key={i} style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.8, marginBottom: 2 }}>{step}</li>
          ))}
        </ol>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexWrap: "wrap", gap: 6 }}>
          {["2139", "tw.linovelib.com/novel/2139.html", "tw.linovelib.com/novel/2139/catalog"].map(ex => (
            <button
              key={ex}
              onClick={() => { setInput(ex); setError(""); }}
              style={{ fontSize: 11, color: "var(--text-dim)", background: "var(--surface2, var(--border))", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* History (hide if searching) */}
      {!searchResults && history.length > 0 && (
        <div style={{ width: "100%", maxWidth: 560, marginTop: 48 }}>
          <div style={{ fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 12 }}>
            繼續閱讀
          </div>
          {history.map(entry => (
            <div
              key={entry.catalogUrl}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 10px", borderRadius: 8, border: "1px solid transparent", transition: "all .12s", cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "var(--surface)"; (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ""; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}
              onClick={() => resumeReading(entry)}
            >
              <div 
                style={{ width: 42, height: 58, borderRadius: 4, flexShrink: 0, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface2)" }}
              >
                {entry.coverUrl ? (
                  <img src={`/api/image?url=${encodeURIComponent(entry.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
                    <ImagePlaceholderIcon style={{ fontSize: 20 }} />
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div 
                  style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
                  onClick={(e) => { e.stopPropagation(); router.push(`/catalog?url=${encodeURIComponent(entry.catalogUrl)}`); }}
                >{entry.novelTitle || "未知小說"}</div>
                <div 
                  style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >上次：{entry.lastChapterTitle || "未知章節"}</div>
                <div style={{ marginTop: 6, background: "var(--border)", height: 3, borderRadius: 2 }}>
                  <div style={{ height: "100%", borderRadius: 2, background: "var(--accent)", width: `${progressPct(entry)}%` }} />
                </div>
              </div>
              <div 
                style={{ color: "var(--text-dim)", flexShrink: 0, fontSize: 18, padding: "0 8px" }}
              >›</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  background: "var(--surface2, #222)",
  padding: "1px 5px",
  borderRadius: 3,
};

function tryNormalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // Pure numeric ID
  if (/^\d+$/.test(s)) return `https://tw.linovelib.com/novel/${s}/catalog`;
  // URL
  if (!s.includes("linovelib.com") && !s.includes("bilinovel.com")) return null;
  try {
    const url = s.startsWith("http") ? new URL(s) : new URL("https://" + s);
    const m = /\/novel\/(\d+)/.exec(url.pathname);
    if (!m) return null;
    return `https://tw.linovelib.com/novel/${m[1]}/catalog`;
  } catch { return null; }
}
