"use client";
import React, { useState, useEffect } from "react";
import { getAuthToken } from "@/lib/sync";
import { ArrowUpIcon, ArrowDownIcon } from "@/components/icons";

export interface Comment {
  id: number;
  username: string;
  avatar_url: string | null;
  level: number;
  content: string;
  created_at: string;
  score: number;
  user_vote: number;
}

interface CommentBoardProps {
  apiEndpoint: string;
  postEndpoint: string;
  payloadKey: string;
  payloadValue: string;
  title: string;
}

export function CommentBoard({ apiEndpoint, postEndpoint, payloadKey, payloadValue, title }: CommentBoardProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());

  const token = typeof window !== "undefined" ? getAuthToken() : null;

  useEffect(() => {
    fetch(apiEndpoint, { headers: token ? { "Authorization": `Bearer ${token}` } : {} })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setComments(data);
      })
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [apiEndpoint, token]);

  const handleVote = async (id: number, newValue: number) => {
    if (!token) return;
    const target = comments.find(c => c.id === id);
    if (!target) return;
    
    // Toggle off if clicking the same button
    const finalValue = target.user_vote === newValue ? 0 : newValue;
    
    setComments(prev => prev.map(c => {
      if (c.id === id) {
        return { ...c, user_vote: finalValue, score: c.score + (finalValue - c.user_vote) };
      }
      return c;
    }).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }));

    const payloadIdKey = postEndpoint.includes("comments") ? "comment_id" : "review_id";
    try {
      await fetch(`${postEndpoint}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ [payloadIdKey]: id, value: finalValue })
      });
    } catch (e) {
      console.error("Vote failed", e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || !token) return;
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch(postEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          [payloadKey]: payloadValue,
          content: content.trim()
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "發佈失敗");

      // Optimistically add to list (backend also returns the inserted comment? Assuming no, we refetch or mock)
      // Actually, standard is to just refetch
      const updated = await fetch(apiEndpoint).then(r => r.json());
      if (Array.isArray(updated)) setComments(updated);
      setContent("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (ds: string) => {
    const d = new Date(ds);
    return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div style={{ marginTop: 40, borderTop: "1px solid var(--border)", paddingTop: 24 }}>
      <h3 style={{ fontSize: 18, fontWeight: "bold", color: "var(--text)", marginBottom: 16 }}>{title} ({comments.length})</h3>
      
      {token ? (
        <form onSubmit={handleSubmit} style={{ marginBottom: 32 }}>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="說點什麼..."
            rows={3}
            style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 14, resize: "vertical", outline: "none", marginBottom: 8 }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
            {error && <span style={{ color: "#e06c6c", fontSize: 12 }}>{error}</span>}
            <button 
              disabled={submitting || !content.trim()} 
              style={{ background: "var(--accent)", color: "#000", border: "none", padding: "8px 20px", borderRadius: 20, fontWeight: "bold", cursor: submitting || !content.trim() ? "not-allowed" : "pointer", opacity: submitting || !content.trim() ? 0.5 : 1 }}
            >
              {submitting ? "發佈中..." : "發佈"}
            </button>
          </div>
        </form>
      ) : (
        <div style={{ background: "var(--surface)", padding: 16, borderRadius: 8, textAlign: "center", color: "var(--text-muted)", marginBottom: 32, fontSize: 13 }}>
          登入後即可參與討論
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: 13 }}>載入中...</div>
      ) : comments.length === 0 ? (
        <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: 13 }}>目前還沒有任何留言。</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {(() => {
            const userCounts: Record<string, number> = {};
            return comments.map(c => {
              userCounts[c.username] = (userCounts[c.username] || 0) + 1;
              const isSpam = userCounts[c.username] > 3;
              const isDownvoted = c.score <= -5;
              const isHidden = (isSpam || isDownvoted) && !expandedComments.has(c.id);

              return (
                <div key={c.id} style={{ display: "flex", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--surface2)", overflow: "hidden", flexShrink: 0 }}>
                    {c.avatar_url ? (
                      <img src={c.avatar_url} alt={c.username} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", color: "var(--text-muted)", fontSize: 14 }}>
                        {c.username.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: "bold", color: "var(--text)", fontSize: 14 }}>{c.username}</span>
                      <span style={{ fontSize: 10, fontWeight: "bold", background: "var(--accent)", color: "#000", padding: "1px 5px", borderRadius: 4 }}>
                        Lv.{c.level || 1}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{formatDate(c.created_at)}</span>
                    </div>
                    {isHidden ? (
                      <div 
                        onClick={() => setExpandedComments(prev => new Set(prev).add(c.id))}
                        style={{ fontSize: 13, color: "var(--text-dim)", fontStyle: "italic", cursor: "pointer", background: "var(--surface2)", padding: "4px 8px", borderRadius: 4, display: "inline-block" }}
                      >
                        {isDownvoted ? "此留言受到多數負評已被隱藏（點擊展開）" : "此使用者發言過於頻繁已被隱藏（點擊展開）"}
                      </div>
                    ) : (
                      <div style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                        {c.content}
                      </div>
                    )}

                    {!isHidden && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                          <button 
                            onClick={() => handleVote(c.id, 1)}
                            style={{ background: "none", border: "none", cursor: token ? "pointer" : "default", color: c.user_vote === 1 ? "var(--accent)" : "var(--text-muted)", fontSize: 13, fontWeight: "bold", padding: 0, display: "flex", alignItems: "center", gap: 4, lineHeight: 1 }}
                          >
                            <ArrowUpIcon style={{ fontSize: 16 }} /> 推
                          </button>
                          <button 
                            onClick={() => handleVote(c.id, -1)}
                            style={{ background: "none", border: "none", cursor: token ? "pointer" : "default", color: c.user_vote === -1 ? "#e06c6c" : "var(--text-muted)", fontSize: 13, fontWeight: "bold", padding: 0, display: "flex", alignItems: "center", gap: 4, lineHeight: 1 }}
                          >
                            <ArrowDownIcon style={{ fontSize: 16 }} /> 噓
                          </button>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: "bold", color: c.score > 0 ? "var(--accent)" : c.score < 0 ? "#e06c6c" : "var(--text)", display: "flex", alignItems: "center", lineHeight: 1 }}>
                          {c.score > 0 ? `+${c.score}` : c.score === 0 ? "0" : c.score}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
