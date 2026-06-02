"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getHistory, type HistoryEntry } from "@/lib/history";

export default function Home() {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const router = useRouter();

  useEffect(() => {
    setHistory(getHistory());
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = tryNormalizeUrl(input);
    if (!url) {
      setError("請輸入有效的小說 ID 或嗶哩輕小說網址");
      return;
    }
    setError("");
    router.push(`/catalog?url=${encodeURIComponent(url)}`);
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
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 36 }}>
        輸入小說 ID 或貼上嗶哩輕小說網址開始閱讀
      </p>

      {/* Input */}
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ background: "var(--surface)", border: `1px solid ${error ? "#e06c6c" : "var(--border)"}`, borderRadius: "var(--radius)", display: "flex", alignItems: "center", padding: "4px 4px 4px 16px", gap: 8, transition: "border-color .2s" }}>
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setError(""); }}
            placeholder="小說 ID（如 2139）或 linovelib 網址"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 14, padding: "10px 0" }}
            autoComplete="off"
          />
          <button type="submit" style={{ background: "var(--accent)", color: "#0a0a0d", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>
            開始閱讀
          </button>
        </div>
        {error && <p style={{ color: "#e06c6c", fontSize: 12, marginTop: 6 }}>{error}</p>}
      </form>

      {/* How-to */}
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

      {/* History */}
      {history.length > 0 && (
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
