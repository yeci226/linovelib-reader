"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getAuthToken, getUsernameFromToken } from "@/lib/sync";
import { StarIcon, ArrowUpIcon, ArrowDownIcon, ImagePlaceholderIcon } from "@/components/icons";

interface RecentRead {
  userId: number;
  username: string;
  avatarUrl: string | null;
  level: number;
  isFollowing: boolean;
  novelTitle: string;
  catalogUrl: string;
  coverUrl: string;
  author: string;
  desc: string;
  updatedAt: string;
  volTitle?: string;
  lastChapterTitle?: string;
  lastChapterUrl?: string;
}

export function CommunityHall() {
  const router = useRouter();
  const [recents, setRecents] = useState<RecentRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<"time" | "title">("time");
  const [sortDesc, setSortDesc] = useState(true);
  
  const token = typeof window !== "undefined" ? getAuthToken() : null;
  const currentUsername = token ? getUsernameFromToken(token) : null;

  const fetchRecents = () => {
    fetch("/api/community/recent", {
      headers: token ? { "Authorization": `Bearer ${token}` } : {}
    })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setRecents(data);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchRecents();
  }, []);

  const handleFollow = async (userId: number) => {
    if (!token) return;
    
    // Optimistic UI update
    setRecents(prev => prev.map(r => r.userId === userId ? { ...r, isFollowing: !r.isFollowing } : r));
    
    try {
      await fetch("/api/community/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: userId })
      });
    } catch (e) {
      console.error(e);
      fetchRecents(); // revert on fail
    }
  };

  const filteredAndSorted = useMemo(() => {
    let list = recents.filter(item => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return item.username.toLowerCase().includes(q) || item.novelTitle.toLowerCase().includes(q);
    });

    list.sort((a, b) => {
      // 1. Self first
      const aIsSelf = a.username === currentUsername;
      const bIsSelf = b.username === currentUsername;
      if (aIsSelf && !bIsSelf) return -1;
      if (!aIsSelf && bIsSelf) return 1;

      // 2. Followed users next
      if (a.isFollowing && !b.isFollowing) return -1;
      if (!a.isFollowing && b.isFollowing) return 1;

      // 3. User selected sort
      if (sortKey === "time") {
        const timeA = new Date(a.updatedAt).getTime();
        const timeB = new Date(b.updatedAt).getTime();
        return sortDesc ? timeB - timeA : timeA - timeB;
      } else {
        const cmp = a.novelTitle.localeCompare(b.novelTitle);
        return sortDesc ? -cmp : cmp;
      }
    });

    return list;
  }, [recents, searchQuery, sortKey, sortDesc, currentUsername]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", width: "100%", paddingTop: 20 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <input 
          type="text" 
          placeholder="搜尋使用者名稱或小說標題..." 
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "12px 20px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 24, color: "var(--text)", outline: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <select 
            value={sortKey} 
            onChange={e => setSortKey(e.target.value as any)}
            style={{ padding: "10px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 24, color: "var(--text)", outline: "none" }}
          >
            <option value="time">依照閱讀時間</option>
            <option value="title">依照小說標題</option>
          </select>
          <button 
            onClick={() => setSortDesc(!sortDesc)}
            style={{ padding: "10px 16px", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 24, color: "var(--text)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
          >
            {sortDesc ? <><ArrowDownIcon /> 倒序</> : <><ArrowUpIcon /> 正序</>}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "var(--text-muted)", fontSize: 14 }}>載入中...</div>
      ) : filteredAndSorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: 14 }}>
          找不到符合條件的閱讀紀錄
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20 }}>
          {filteredAndSorted.map((item, idx) => {
            const isSelf = item.username === currentUsername;
            const highlight = isSelf || item.isFollowing;
            
            return (
              <div 
                key={idx} 
                className="book-card"
                style={{ 
                  display: "flex", gap: 16, padding: 16, background: "var(--surface)", 
                  borderRadius: 12, border: highlight ? "1px solid rgba(200,169,110,.4)" : "1px solid var(--border)", 
                  boxShadow: highlight ? "0 4px 12px rgba(200,169,110,.15)" : "0 4px 12px rgba(0,0,0,0.2)",
                  position: "relative"
                }}
              >
                <div 
                  onClick={() => router.push(`/catalog?url=${encodeURIComponent(item.catalogUrl)}`)}
                  style={{ 
                    width: 100, 
                    height: 140, 
                    borderRadius: 8, flexShrink: 0, overflow: "hidden", background: "var(--surface2)", cursor: "pointer",
                  }}
                >
                  {item.coverUrl ? (
                    <img src={`/api/image?url=${encodeURIComponent(item.coverUrl)}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}><ImagePlaceholderIcon style={{ fontSize: 24 }} /></div>
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  {/* User Info */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--surface2)", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: "bold" }}>
                      {item.avatarUrl ? <img src={item.avatarUrl} style={{width:"100%", height:"100%", objectFit:"cover"}}/> : item.username.charAt(0).toUpperCase()}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: "bold", color: "var(--text)" }}>{item.username}</span>
                    <span style={{ fontSize: 10, fontWeight: "bold", background: "var(--accent)", color: "#000", padding: "2px 6px", borderRadius: 4 }}>Lv.{item.level || 1}</span>
                    {isSelf && <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: "bold" }}>(我)</span>}
                    <div style={{ flex: 1 }} />
                    {token && !isSelf && (
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleFollow(item.userId); }}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 16, opacity: item.isFollowing ? 1 : 0.4, color: item.isFollowing ? "#eab308" : "var(--text-muted)", display: "flex", alignItems: "center" }}
                        title={item.isFollowing ? "取消追隨" : "追隨"}
                      >
                        <StarIcon fill={item.isFollowing ? "currentColor" : "none"} />
                      </button>
                    )}
                  </div>

                  {/* Novel Info */}
                  <div 
                    onClick={() => router.push(`/catalog?url=${encodeURIComponent(item.catalogUrl)}`)}
                    style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4, lineHeight: 1.3, cursor: "pointer", whiteSpace: "normal", wordBreak: "break-word", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                  >
                    {item.novelTitle}
                  </div>
                  {item.author && (
                    <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 8 }}>
                      {item.author}
                    </div>
                  )}
                  {item.desc && (
                    <div className="book-desc" onClick={() => router.push(`/catalog?url=${encodeURIComponent(item.catalogUrl)}`)} style={{ cursor: "pointer", fontSize: 13, lineHeight: 1.6, whiteSpace: "nowrap", display: "block", overflow: "hidden", textOverflow: "clip" }}>
                      {item.desc}
                    </div>
                  )}
                  
                  {/* Reading Progress */}
                  {(item.volTitle || item.lastChapterTitle) && (
                    <div 
                      onClick={() => item.lastChapterUrl && router.push(`/read?url=${encodeURIComponent(item.lastChapterUrl)}&catalog=${encodeURIComponent(item.catalogUrl)}`)}
                      style={{ 
                        marginTop: 4, padding: "6px 10px", background: "var(--surface2)", borderRadius: 6, 
                        border: "1px solid var(--border)", color: "var(--text)", 
                        cursor: item.lastChapterUrl ? "pointer" : "default",
                        display: "flex", flexDirection: "column", gap: 2, overflow: "hidden"
                      }}
                    >
                      {item.volTitle && <span style={{ color: "var(--accent)", fontWeight: "bold", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.volTitle}</span>}
                      <span style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.9 }}>
                        {item.lastChapterTitle}
                      </span>
                    </div>
                  )}
                  
                  {/* Read Time */}
                  <div style={{ marginTop: "auto", fontSize: 11, color: "var(--text-muted)", fontWeight: 500, textAlign: "right" }}>
                    上次觀看：{(() => {
                      const diff = Date.now() - new Date(item.updatedAt).getTime();
                      const mins = Math.floor(diff / 60000);
                      if (mins < 60) return `${Math.max(1, mins)} 分鐘前`;
                      const hrs = Math.floor(mins / 60);
                      if (hrs < 24) return `${hrs} 小時前`;
                      const days = Math.floor(hrs / 24);
                      if (days < 30) return `${days} 天前`;
                      const months = Math.floor(days / 30);
                      if (months < 12) return `${months} 個月前`;
                      return `${Math.floor(months / 12)} 年前`;
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
