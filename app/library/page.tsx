"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeftIcon, ImagePlaceholderIcon } from "@/components/icons";

type DiscoverItem = {
  title: string;
  url: string;
  coverUrl: string;
  author: string;
  desc: string;
  tags: string[];
};

export default function LibraryPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"wenku" | "top">("wenku");
  const [loadedTab, setLoadedTab] = useState<"wenku" | "top" | "search">("wenku");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchType, setSearchType] = useState<"normal" | "tag">("normal");
  
  const [hoveredCard, setHoveredCard] = useState(-1);
  const Marquee = 'marquee' as any;

  const isInitialMount = useRef(true);

  const displayedItems = useMemo(() => {
    if (!searchQuery) return items;
    const q = searchQuery.toLowerCase();
    
    const scored = items.map(item => {
      const titleMatch = item.title && item.title.toLowerCase().includes(q) ? 1 : 0;
      const authorMatch = item.author && item.author.toLowerCase().includes(q) ? 1 : 0;
      const tagMatch = item.tags && item.tags.some(t => t.toLowerCase().includes(q)) ? 1 : 0;
      
      let score = 0;
      if (titleMatch || authorMatch || tagMatch) {
        if (searchType === "tag") {
          score = tagMatch * 3 + authorMatch * 2 + titleMatch * 1;
        } else {
          score = titleMatch * 3 + authorMatch * 2 + tagMatch * 1;
        }
      }
      return { item, score };
    }).filter(x => x.score > 0);
    
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.item);
  }, [items, searchQuery, searchType]);

  useEffect(() => {
    let initialTab = tab;
    let initialPage = 1;
    let initialQuery = searchQuery;
    let initialType = searchType;

    const saved = sessionStorage.getItem('libraryState');
    if (saved) {
      try {
        const state = JSON.parse(saved);
        initialTab = state.tab || "wenku";
        initialPage = state.page || 1;
        initialQuery = state.searchQuery || "";
        initialType = state.searchType || "normal";
        
        setTab(initialTab);
        setPage(initialPage);
        setSearchQuery(initialQuery);
        setSearchInput(initialQuery);
        setSearchType(initialType);
        
        sessionStorage.setItem('libraryScroll', state.scrollY);
        sessionStorage.removeItem('libraryState');
      } catch (e) {}
    }
    fetchData(initialTab, initialPage);
    isInitialMount.current = false;
  }, []);

  useEffect(() => {
    if (isInitialMount.current) return;
    setPage(1);
    fetchData(tab, 1);
  }, [tab]);

  useEffect(() => {
    if (isInitialMount.current) return;
    fetchData(tab, page);
  }, [page]);

  const handleNav = (url: string) => {
    const state = {
      tab,
      page,
      searchQuery,
      searchType,
      scrollY: window.scrollY
    };
    sessionStorage.setItem('libraryState', JSON.stringify(state));
    router.push(`/catalog?url=${encodeURIComponent(url)}`);
  };

  const fetchData = async (currentTab: string, p: number) => {
    setIsFetching(true);
    if (items.length === 0 || p === 1) setLoading(true);
    try {
      let endpoint = `/api/discover/${currentTab}?page=${p}`;
      
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        // Since we are filtering client-side, we always append
        setItems(prev => p === 1 ? (data.items || []) : [...prev, ...(data.items || [])]);
        setTotalPages(data.totalPages || 1);
        setLoadedTab(currentTab as any);
      }
    } catch (e) {
      console.error(e);
    } finally {
      const savedScroll = sessionStorage.getItem('libraryScroll');
      if (savedScroll !== null) {
        setTimeout(() => {
          window.scrollTo({ top: parseInt(savedScroll, 10), behavior: "instant" });
        }, 50);
        sessionStorage.removeItem('libraryScroll');
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      setLoading(false);
      setIsFetching(false);
    }
  };

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchInput.trim()) {
      setSearchQuery("");
      return;
    }
    setSearchQuery(searchInput.trim());
    setSearchType("normal");
    setTab("wenku");
  };

  const handleQuickSearch = (query: string) => {
    setSearchInput(query);
    setSearchQuery(query);
    setSearchType("tag");
    setTab("wenku");
  };

  const renderBookCard = (item: DiscoverItem, index: number, rank: number | null, isHero: boolean = false, isTop23: boolean = false) => {
    return (
      <div 
        key={item.url} 
        className="book-card"
        onMouseEnter={() => setHoveredCard(index)}
        onMouseLeave={() => setHoveredCard(-1)}
        style={
          isHero ? { gridColumn: "1 / 2", gridRow: "1 / 3", padding: 24, gap: 24 } : 
          isTop23 ? { gridColumn: "2 / 3", padding: 16 } : 
          {}
        }
      >
        {rank !== null && (
          <div className="top-badge" style={{
            background: rank === 1 ? "#FFD700" : rank === 2 ? "#C0C0C0" : rank === 3 ? "#CD7F32" : "var(--accent)",
            color: rank <= 3 ? "#000" : "var(--bg)",
            transform: isHero ? "scale(1.2) translate(-4px, -4px)" : "none"
          }}>
            {rank}
          </div>
        )}
        <div 
          onClick={() => handleNav(item.url)}
          style={{ 
            width: isHero ? 180 : 100, 
            height: isHero ? 252 : 140, 
            borderRadius: 8, flexShrink: 0, overflow: "hidden", background: "var(--surface2)", cursor: "pointer",
            boxShadow: isHero ? "0 4px 16px rgba(0,0,0,0.2)" : "none"
          }}
        >
          {item.coverUrl ? (
            <img src={`/api/image?url=${encodeURIComponent(item.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}><ImagePlaceholderIcon style={{ fontSize: 24 }} /></div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div 
            onClick={() => handleNav(item.url)}
            style={{ fontSize: isHero ? 24 : 16, fontWeight: 700, color: "var(--text)", marginBottom: isHero ? 8 : 4, lineHeight: 1.3, cursor: "pointer", whiteSpace: "normal", wordBreak: "break-word" }}
          >
            {item.title}
          </div>
          <div style={{ fontSize: isHero ? 14 : 12, color: "var(--accent)", marginBottom: isHero ? 16 : 8 }}>
            <span className="clickable-text" onClick={() => handleQuickSearch(item.author)}>{item.author}</span>
          </div>
          <div className="book-desc" onClick={() => handleNav(item.url)} style={{ cursor: "pointer", fontSize: isHero ? 15 : 13, lineHeight: 1.6, whiteSpace: (isHero || isTop23) ? "normal" : "nowrap", display: "block", overflow: (isHero || isTop23) ? "visible" : "hidden", textOverflow: (isHero || isTop23) ? "unset" : "clip" }}>
            {hoveredCard === index && !(isHero || isTop23) ? (
              <div className="marquee-wrap">
                <div className="marquee-inner">
                  {item.desc}
                </div>
              </div>
            ) : (
              item.desc
            )}
          </div>
          {loadedTab !== "top" && item.tags && item.tags.length > 0 && (() => {
            const isStatus = (t: string) => /連載|完結|萬字|萬/.test(t) || (!isNaN(parseFloat(t)) && parseFloat(t) > 0);
            const genreTags = item.tags.filter(t => !isStatus(t));
            const statusTags = item.tags.filter(isStatus);
            const statusString = statusTags.join("");
            
            return (
              <div style={{ marginTop: "auto", fontSize: isHero ? 12 : 11, color: "var(--accent-dim)", fontWeight: 600, letterSpacing: "0.05em" }}>
                {genreTags.map((tag, tIdx) => (
                  <span key={tIdx}>
                    <span className="clickable-text" onClick={() => handleQuickSearch(tag)}>
                      {tag.trim()}
                    </span>
                    {tIdx < genreTags.length - 1 ? "  " : ""}
                  </span>
                ))}
                {statusString && (
                  <span style={{ color: "var(--text-dim)", marginLeft: genreTags.length ? 8 : 0, fontWeight: 500 }}>
                    {statusString}
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (loading) {
      return <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: 14 }}>載入中...</div>;
    }
    if (displayedItems.length === 0) {
      return (
        <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: 14 }}>
          {searchQuery ? "在目前的載入範圍中找不到相符的結果。您可以捲動到底部載入更多小說！" : "沒有資料"}
        </div>
      );
    }

    if (loadedTab === "top" && page === 1 && displayedItems.length >= 3) {
      const top3 = displayedItems.slice(0, 3);
      const rest = displayedItems.slice(3);
      return (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 20, maxWidth: 1200, margin: "0 auto 20px" }}>
            {top3.map((item, i) => renderBookCard(item, i, i + 1, i === 0, i > 0))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20, maxWidth: 1200, margin: "0 auto" }}>
            {rest.map((item, i) => renderBookCard(item, i + 3, i + 4))}
          </div>
        </>
      );
    }

    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20, maxWidth: 1200, margin: "0 auto" }}>
        {items.map((item, i) => {
          const rank = loadedTab === "top" ? (page - 1) * 50 + i + 1 : null;
          return renderBookCard(item, i, rank);
        })}
      </div>
    );
  };


  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <style>{`
        .book-card { display: flex; gap: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; position: relative; }
        .book-desc { font-size: 13px; color: var(--text-muted); line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: clip; margin-bottom: 8px; }
        .top-badge { position: absolute; top: -10px; left: -10px; background: var(--accent); color: var(--bg); font-weight: 900; font-size: 16px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 50%; box-shadow: 0 2px 8px rgba(0,0,0,.3); z-index: 2; border: 2px solid var(--surface); pointer-events: none; }
        .clickable-text { cursor: pointer; transition: color .2s; }
        .clickable-text:hover { color: var(--accent); text-decoration: underline; }
        
        .marquee-wrap { width: 100%; overflow: hidden; white-space: nowrap; }
        .marquee-inner { display: inline-block; padding-right: 100%; animation: marquee-scroll 12s linear infinite; }
        @keyframes marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-100%); }
        }

        @media (max-width: 768px) {
          .book-card[style*="grid-column: 1 / 2"] { grid-column: 1 / -1 !important; grid-row: auto !important; }
          .book-card[style*="grid-column: 2 / 3"] { grid-column: 1 / -1 !important; grid-row: auto !important; }
          div[style*="grid-template-columns: 2fr 1fr"] { grid-template-columns: 1fr !important; grid-template-rows: auto !important; }
        }
      `}</style>
      
      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", height: 56, padding: "0 16px" }}>
          <button onClick={() => router.push("/")} style={{ background: "none", border: "none", color: "var(--text)", padding: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", borderRadius: "50%" }}>
            <ChevronLeftIcon style={{ fontSize: 24 }} />
          </button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 18, fontWeight: 700, paddingRight: 40 }}>
            小說文庫
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", padding: "0 16px", gap: 16 }}>
          <button 
            onClick={() => { setTab("wenku"); setSearchQuery(""); setSearchInput(""); }}
            style={{ flex: 1, background: "none", border: "none", padding: "12px 0", color: tab === "wenku" ? "var(--accent)" : "var(--text-muted)", fontSize: 15, fontWeight: tab === "wenku" ? 700 : 500, borderBottom: `2px solid ${tab === "wenku" ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "all .2s" }}
          >
            全部小說
          </button>
          <button 
            onClick={() => { setTab("top"); setSearchQuery(""); setSearchInput(""); }}
            style={{ flex: 1, background: "none", border: "none", padding: "12px 0", color: tab === "top" ? "var(--accent)" : "var(--text-muted)", fontSize: 15, fontWeight: tab === "top" ? 700 : 500, borderBottom: `2px solid ${tab === "top" ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "all .2s" }}
          >
            人氣排行
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 16px 80px", opacity: isFetching ? 0.6 : 1, transition: "opacity .2s" }}>
        
        {/* Search Bar - only shown for wenku tab */}
        {tab === "wenku" && (
          <div style={{ paddingBottom: 24, maxWidth: 1200, margin: "0 auto" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: 8 }}>
              <input 
                type="text" 
                placeholder="本地搜尋：輸入書名、作者、標籤..." 
                value={searchInput}
                onChange={e => {
                  const val = e.target.value;
                  setSearchInput(val);
                  if (val.trim() === "") {
                    setSearchQuery("");
                  }
                }}
                style={{ flex: 1, padding: "12px 20px", borderRadius: 24, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 15, outline: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}
              />
              <button type="submit" style={{ padding: "0 24px", borderRadius: 24, background: "var(--accent)", color: "var(--bg)", border: "none", fontWeight: 700, cursor: "pointer", fontSize: 15, boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
                搜尋
              </button>
            </form>
          </div>
        )}

        {renderContent()}

        {/* Pagination */}
        {!loading && totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16, marginTop: 40 }}>
            <button 
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: page <= 1 ? "var(--text-dim)" : "var(--text)", padding: "8px 16px", borderRadius: 8, fontSize: 14, cursor: page <= 1 ? "not-allowed" : "pointer" }}
            >
              上一頁
            </button>
            <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{page} / {totalPages}</span>
            <button 
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", color: page >= totalPages ? "var(--text-dim)" : "var(--text)", padding: "8px 16px", borderRadius: 8, fontSize: 14, cursor: page >= totalPages ? "not-allowed" : "pointer" }}
            >
              下一頁
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
