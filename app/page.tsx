"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { normalizeToCatalogUrl } from "@/lib/normalize-url";
import { getHistory, type HistoryEntry } from "@/lib/history";

export default function Home() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const router = useRouter();

  useEffect(() => {
    setHistory(getHistory());
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeToCatalogUrl(url);
    if (!normalized) {
      setError("請貼上有效的嗶哩輕小說網址");
      return;
    }
    setError("");
    router.push(`/catalog?url=${encodeURIComponent(normalized)}`);
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
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px 80px" }}>
      <div style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", opacity: .7, marginBottom: 8 }}>
        Light Novel Reader
      </div>
      <h1 style={{ fontSize: "clamp(26px,5vw,38px)", fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
        輕小說閱讀器
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 44 }}>
        貼上嗶哩輕小說網址即可開始閱讀
      </p>

      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ background: "var(--surface)", border: `1px solid ${error ? "#e06c6c" : "var(--border)"}`, borderRadius: "var(--radius)", display: "flex", alignItems: "center", padding: "4px 4px 4px 16px", gap: 8, transition: "border-color .2s" }}>
          <input
            type="text"
            value={url}
            onChange={e => { setUrl(e.target.value); setError(""); }}
            placeholder="tw.linovelib.com/novel/2139 或 /catalog"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 14, padding: "10px 0" }}
          />
          <button type="submit" style={{ background: "var(--accent)", color: "#0a0a0d", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, transition: "opacity .15s", whiteSpace: "nowrap" }}>
            開始閱讀
          </button>
        </div>
        {error && <p style={{ color: "#e06c6c", fontSize: 12, marginTop: 6 }}>{error}</p>}
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["/novel/2139.html", "/novel/2139/catalog", "/novel/2139/catalog.html"].map(f => (
            <span key={f} style={{ fontSize: 11, color: "var(--text-dim)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 8px" }}>{f} ✓</span>
          ))}
        </div>
      </form>

      {/* How-to guide */}
      <div style={{ width: "100%", maxWidth: 560, marginTop: 36, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px 20px" }}>
        <div style={{ fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 12, opacity: .8 }}>如何取得網址</div>
        <ol style={{ margin: 0, paddingLeft: 18, listStyle: "decimal" }}>
          {[
            <>前往 <a href="https://tw.linovelib.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>tw.linovelib.com</a></>,
            "搜尋或瀏覽找到想讀的小說",
            "點入小說頁面（例如「Re:從零…」）",
            "從瀏覽器網址列複製網址",
            "貼回上方輸入框，按「開始閱讀」",
          ].map((step, i) => (
            <li key={i} style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 4 }}>{step}</li>
          ))}
        </ol>
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-dim)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          支援格式：<code style={{ fontFamily: "monospace", background: "var(--surface2)", padding: "1px 5px", borderRadius: 3 }}>/novel/2139</code>、<code style={{ fontFamily: "monospace", background: "var(--surface2)", padding: "1px 5px", borderRadius: 3 }}>/novel/2139.html</code>、完整 catalog 網址
        </div>
      </div>

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
