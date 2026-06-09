"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { SettingsIcon, ImagePlaceholderIcon, UsersIcon, BookIcon, StarIcon } from "@/components/icons";
import { getHistory, getCatalogCache, type HistoryEntry } from "@/lib/history";
import { CommunityHall } from "@/components/CommunityHall";
import { getAuthToken, getUsernameFromToken } from "@/lib/sync";

type DiscoverItem = {
  title: string;
  url: string;
  coverUrl: string;
  author: string;
  desc: string;
  tags: string[];
};

export default function Home() {
  const router = useRouter();
  
  // Library State
  const [tab, setTab] = useState<"wenku" | "top" | "community">("wenku");
  const [loadedTab, setLoadedTab] = useState<"wenku" | "top" | "search" | "community">("wenku");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchType, setSearchType] = useState<"normal" | "tag">("normal");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setIsMobile(window.innerWidth <= 768);
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  
  const [hoveredCard, setHoveredCard] = useState(-1);

  // History State
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const isInitialMount = useRef(true);

  useEffect(() => {
    setHistory(getHistory().slice(0, 3)); // Keep top 3 history items
    const token = getAuthToken();
    if (token) {
      setUsername(getUsernameFromToken(token));
      const cachedAvatar = localStorage.getItem('linovelib-avatar');
      if (cachedAvatar) setAvatarUrl(cachedAvatar);
      
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
        .then(res => res.json())
        .then(data => {
          if (data.avatarUrl) {
            setAvatarUrl(data.avatarUrl);
            localStorage.setItem('linovelib-avatar', data.avatarUrl);
          }
        })
        .catch(() => {});
    }

    let initialTab: "wenku" | "top" | "community" = "wenku";
    let initialPage = 1;
    let initialQuery = "";
    let initialType: "normal" | "tag" = "normal";

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
    fetchData(initialTab, initialPage, initialQuery, initialType);
    isInitialMount.current = false;
  }, []);

  useEffect(() => {
    if (isInitialMount.current) return;
    if (tab === "community") return;
    setPage(1);
    fetchData(tab, 1, searchQuery, searchType);
  }, [tab, searchQuery, searchType]);

  useEffect(() => {
    if (isInitialMount.current) return;
    if (tab === "community") return;
    fetchData(tab, page, searchQuery, searchType);
  }, [page]);

  const handleNav = (url: string) => {
    const state = {
      tab,
      page,
      // Intentionally omit searchQuery/searchType: return from catalog always shows clean list
      scrollY: window.scrollY
    };
    sessionStorage.setItem('libraryState', JSON.stringify(state));

    // Save discover item metadata so the catalog page can enrich the history entry
    const item = items.find(n => n.url === url);
    if (item?.author || item?.desc) {
      sessionStorage.setItem('navItemMeta', JSON.stringify({
        url,
        author: item.author,
        desc: item.desc,
        tags: item.tags,
      }));
    }

    router.push(`/catalog?url=${encodeURIComponent(url)}`);
  };

  const resumeReading = (entry: HistoryEntry) => {
    if (entry.lastChapterUrl) {
      router.push(
        `/read?url=${encodeURIComponent(entry.lastChapterUrl)}&catalog=${encodeURIComponent(entry.catalogUrl)}&from=home`
      );
    } else {
      router.push(`/catalog?url=${encodeURIComponent(entry.catalogUrl)}`);
    }
  };

  const fetchData = async (currentTab: string, p: number, query: string = "", type: "normal" | "tag" = "normal") => {
    setIsFetching(true);
    if (items.length === 0 || p === 1) setLoading(true);
    try {
      let endpoint = `/api/discover/${currentTab}?page=${p}`;
      if (currentTab === "wenku" && query) {
        endpoint = `/api/discover/search?q=${encodeURIComponent(query)}&type=${type}&page=${p}`;
      }
      
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
        setTotalPages(data.totalPages || 1);
        setLoadedTab((currentTab === "wenku" && query) ? "search" : currentTab as any);
      }
    } catch (e) {
      console.error(e);
    } finally {
      const savedScroll = sessionStorage.getItem('libraryScroll');
      if (savedScroll !== null) {
        setTimeout(() => {
          window.scrollTo({ top: parseInt(savedScroll, 10), behavior: "instant" });
        }, 250);
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
    const val = searchInput.trim();
    if (!val) {
      setSearchQuery("");
      return;
    }
    
    // Check if pure ID
    if (/^\d+$/.test(val)) {
      handleNav(`https://tw.linovelib.com/novel/${val}/catalog`);
      return;
    }
    
    setSearchQuery(val);
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

  const renderHistoryCard = (entry: HistoryEntry, index: number) => {
    let author = entry.author || "";
    let desc = entry.desc || "";
    let tags = entry.tags || [];
    
    if (!author && !desc) {
      const cached = getCatalogCache(entry.catalogUrl);
      if (cached) {
        author = cached.author || "";
        desc = cached.desc || "";
        tags = cached.tags || [];
      }
    }

    if (!author && !desc) {
      const enriched = items.find(n => n.url === entry.catalogUrl);
      author = enriched?.author || "";
      desc = enriched?.desc || "";
      tags = enriched?.tags || [];
    }

    return (
      <div 
        key={`history-${entry.catalogUrl}`} 
        className="book-card history-card-style" 
        onMouseEnter={() => setHoveredCard(index + 1000)}
        onMouseLeave={() => setHoveredCard(-1)}
        onClick={() => resumeReading(entry)}
        style={{
          border: "2px solid var(--accent)",
          background: "var(--surface)",
          cursor: "pointer"
        }}
      >
        {entry.lastChapterUrl ? (
          <div style={{
            position: "absolute", top: -10, left: -10,
            background: "var(--accent)", color: "#000",
            fontWeight: 900, fontSize: 13,
            padding: "4px 12px", borderRadius: "14px",
            boxShadow: "0 2px 8px rgba(0,0,0,.3)", zIndex: 2,
            border: "2px solid var(--surface)", pointerEvents: "none",
            maxWidth: "calc(100% - 20px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
          }}>
            繼續閱讀 {entry.lastChapterTitle || ""}
          </div>
        ) : (
          <div style={{
            position: "absolute", top: -10, left: -10,
            background: "var(--surface2)", color: "var(--text-muted)",
            fontWeight: 700, fontSize: 12,
            padding: "4px 12px", borderRadius: "14px",
            boxShadow: "0 2px 8px rgba(0,0,0,.2)", zIndex: 2,
            border: "2px solid var(--border)", pointerEvents: "none",
          }}>
            前往目錄
          </div>
        )}
        <div 
          style={{ 
            width: 100, 
            height: 140, 
            borderRadius: 8, flexShrink: 0, overflow: "hidden", background: "var(--surface2)", cursor: "pointer",
          }}
        >
          {entry.coverUrl ? (
            <img src={`/api/image?url=${encodeURIComponent(entry.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}><ImagePlaceholderIcon style={{ fontSize: 24 }} /></div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div 
            style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4, lineHeight: 1.3, cursor: "pointer", whiteSpace: "normal", wordBreak: "break-word" }}
          >
            {entry.novelTitle || "未知小說"}
          </div>
          {author && (
            <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 8 }}>
              <span className="clickable-text" onClick={(e) => { e.stopPropagation(); handleQuickSearch(author); }}>{author}</span>
            </div>
          )}
          {desc && (
            <div className="book-desc" style={{ cursor: "pointer", fontSize: 13, lineHeight: 1.6, whiteSpace: "nowrap", display: "block", overflow: "hidden", textOverflow: "clip" }}>
              {hoveredCard === index + 1000 ? (
                <div className="marquee-wrap">
                  <div className="marquee-inner">
                    {desc}
                  </div>
                </div>
              ) : (
                desc
              )}
            </div>
          )}
          {tags && tags.length > 0 && (() => {
            const isStatus = (t: string) => /連載|完結|萬字|萬/.test(t) || (!isNaN(parseFloat(t)) && parseFloat(t) > 0);
            const genreTags = tags.filter(t => !isStatus(t) && t.trim() !== author.trim());
            const statusTags = tags.filter(isStatus);
            const statusString = statusTags.join("");
            
            return (
              <div style={{ marginTop: "auto", fontSize: 11, color: "var(--accent-dim)", fontWeight: 600, letterSpacing: "0.05em" }}>
                {genreTags.map((tag, tIdx) => (
                  <span key={tIdx}>
                    <span className="clickable-text" onClick={(e) => { e.stopPropagation(); handleQuickSearch(tag); }}>
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
    if (tab === "community") return <CommunityHall />;

    if (loading) {
      return <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: 14 }}>載入中...</div>;
    }

    const showHistory = tab === "wenku" && page === 1 && !searchQuery && history.length > 0;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {items.length === 0 && !showHistory ? (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: 14 }}>
            {searchQuery ? "找不到相符的結果。請先瀏覽更多小說後再試。" : "沒有資料"}
          </div>
        ) : (
          <>
            {loadedTab === "top" && page === 1 && items.length >= 3 ? (
              <>
                {!isMobile && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, maxWidth: 1200, margin: "0 auto 20px" }}>
                    {items.slice(0, 3).map((item, i) => renderBookCard(item, i, i + 1, i === 0, i > 0))}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20, maxWidth: 1200, margin: "0 auto", width: "100%" }}>
                  {(isMobile ? items : items.slice(3)).map((item, i) => {
                    const rank = isMobile ? i + 1 : i + 4;
                    return renderBookCard(item, isMobile ? i : i + 3, rank);
                  })}
                </div>
              </>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20, maxWidth: 1200, margin: "0 auto", width: "100%" }}>
                {showHistory && history.map((entry, i) => renderHistoryCard(entry, i))}
                {items.map((item, i) => {
                  const rank = loadedTab === "top" ? (page - 1) * 50 + i + 1 : null;
                  return renderBookCard(item, i, rank);
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <style>{`
        .book-card { display: flex; gap: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; position: relative; }
        .history-card { cursor: pointer; border-color: var(--accent); border-width: 2px; }
        .history-card:hover { background: var(--surface2); }
        .history-badge { position: absolute; top: -10px; left: -10px; background: var(--accent); color: var(--bg); font-weight: 800; font-size: 13px; padding: 4px 10px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.3); z-index: 2; border: 2px solid var(--surface); pointer-events: none; }
        .book-desc { font-size: 13px; color: var(--text-muted); line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px; }
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
      <div style={{ position: "relative", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "48px", paddingBottom: "24px" }}>
        <div style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 12 }}>
          <button 
            onClick={() => router.push("/settings")} 
            style={{ 
              background: "var(--surface2)", border: "1px solid var(--border)", 
              padding: username ? 0 : "8px 16px", 
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", 
              borderRadius: username ? "50%" : 20, 
              width: username ? 40 : "auto", height: 40, overflow: "hidden" 
            }}
          >
            {username ? (
              avatarUrl ? (
                <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", color: "var(--text)", fontSize: 18, background: "var(--surface)" }}>
                  {username.charAt(0).toUpperCase()}
                </div>
              )
            ) : (
              <span style={{ fontSize: 13, fontWeight: "bold", color: "var(--text)" }}>登入</span>
            )}
          </button>
        </div>
        <div style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", opacity: .7, marginBottom: 8 }}>
          Light Novel Reader
        </div>
        <h1 style={{ fontSize: "clamp(26px,5vw,38px)", fontWeight: 700, color: "var(--text)", margin: 0 }}>
          輕小說閱讀器
        </h1>
      </div>

      {/* Sticky Tabs */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", padding: "0 16px", gap: 16, maxWidth: 1200, margin: "0 auto" }}>
          <button 
            onClick={() => { setTab("wenku"); setSearchQuery(""); setSearchInput(""); }}
            style={{ flex: 1, background: "none", border: "none", padding: "12px 0", color: tab === "wenku" ? "var(--accent)" : "var(--text-muted)", fontSize: 15, fontWeight: tab === "wenku" ? 700 : 500, borderBottom: `2px solid ${tab === "wenku" ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "all .2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            <BookIcon style={{ fontSize: 16 }} /> 全部小說
          </button>
          <button 
            onClick={() => { setTab("top"); setSearchQuery(""); setSearchInput(""); }}
            style={{ flex: 1, background: "none", border: "none", padding: "12px 0", color: tab === "top" ? "var(--accent)" : "var(--text-muted)", fontSize: 15, fontWeight: tab === "top" ? 700 : 500, borderBottom: `2px solid ${tab === "top" ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "all .2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            <StarIcon style={{ fontSize: 16 }} /> 人氣排行
          </button>
          <button 
            onClick={() => { setTab("community"); }}
            style={{ flex: 1, background: "none", border: "none", padding: "12px 0", color: tab === "community" ? "var(--accent)" : "var(--text-muted)", fontSize: 15, fontWeight: tab === "community" ? 700 : 500, borderBottom: `2px solid ${tab === "community" ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "all .2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            <UsersIcon style={{ fontSize: 16 }} /> 社群大廳
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px 80px", opacity: isFetching ? 0.6 : 1, transition: "opacity .2s" }}>
        
        {/* Search Bar - only shown for wenku tab */}
        {tab === "wenku" && (
          <div style={{ paddingBottom: 24, maxWidth: 1200, margin: "0 auto" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: 8 }}>
              <input 
                type="text" 
                placeholder="輸入書名、ID 或作者..." 
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
        {tab !== "community" && !loading && totalPages > 1 && (
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
