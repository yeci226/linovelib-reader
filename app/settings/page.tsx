"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAuthToken, setAuthToken, triggerSyncPull, triggerSyncPush, getUsernameFromToken } from "@/lib/sync";
import { getHistory, getAllBookmarks, loadBookshelf, save, saveBookmarks, saveBookshelf } from "@/lib/history";
import { AvatarUploader } from "@/components/AvatarUploader";

const fileToBase64 = (f: File): Promise<string> => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.readAsDataURL(f);
});

export default function SettingsPage() {
  const router = useRouter();
  const [token, setTokenState] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [answer1, setAnswer1] = useState("");
  const [answer2, setAnswer2] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string>("");
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [cacheSize, setCacheSize] = useState(0);

  useEffect(() => {
    setTokenState(getAuthToken());
    calculateCache();
    const cachedAvatar = localStorage.getItem('linovelib-avatar');
    if (cachedAvatar) {
      setStats((prev: any) => ({ ...prev, avatarUrl: cachedAvatar }));
    }
  }, []);

  useEffect(() => {
    if (token) {
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
        .then(res => res.json())
        .then(data => {
          if (data.username) {
            setStats(data);
            if (data.avatarUrl) {
              localStorage.setItem('linovelib-avatar', data.avatarUrl);
            }
          }
        })
        .catch(console.error);
    }
  }, [token]);

  const calculateCache = () => {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        total += localStorage.getItem(key)?.length || 0;
      }
    }
    setCacheSize(Math.round((total * 2) / 1024)); // Approx KB
  };

  const clearCache = () => {
    if (confirm("這將會清除所有快取的目錄與章節（不會刪除書籤與歷史紀錄）。確定嗎？")) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes("catalog-cache") || key.includes("chapter-cache"))) {
          localStorage.removeItem(key);
        }
      }
      calculateCache();
      setMsg("快取已清除！");
    }
  };

  const handleAuth = async (isLogin: boolean) => {
    setLoading(true);
    setMsg("");
    try {
      const body: any = { username, password };
      if (!isLogin) {
        body.answer1 = answer1;
        body.answer2 = answer2;
      }

      const res = await fetch(`/api/auth/${isLogin ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || "登入失敗");
      
      setAuthToken(data.token);
      setTokenState(data.token);
      setMsg(`歡迎，${data.username}！`);

      if (!isLogin && avatarFile) {
        const base64 = await fileToBase64(avatarFile);
        await fetch("/api/auth/avatar", { 
          method: "POST", 
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.token}` }, 
          body: JSON.stringify({ avatarBase64: base64 }) 
        }).catch(() => {});
      }
      
      // Auto pull and push to merge local and cloud
      await triggerSyncPull();
      triggerSyncPush();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setTokenState(null);
    setMsg("已登出");
  };

  const exportData = () => {
    const data = {
      history: getHistory(),
      bookmarks: getAllBookmarks(),
      bookshelf: loadBookshelf()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "linovelib-backup.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string);
        if (data.history) save(data.history, true);
        if (data.bookmarks) saveBookmarks(data.bookmarks, true);
        if (data.bookshelf) saveBookshelf(data.bookshelf, true);
        setMsg("資料匯入成功！");
        triggerSyncPush();
      } catch (err) {
        setMsg("檔案格式錯誤");
      }
    };
    reader.readAsText(file);
  };

  return (
    <main style={{ minHeight: "100vh", padding: "40px 24px", maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>設定</h1>
        <button onClick={() => router.push("/")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}>
          返回首頁
        </button>
      </div>

      {msg && (
        <div style={{ padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 6, marginBottom: 24, color: "var(--accent)" }}>
          {msg}
        </div>
      )}

      {/* Auth Section */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, color: "var(--text)", marginBottom: 16 }}>帳號與同步</h2>
        {token ? (
          <div style={{ background: "var(--surface)", padding: 20, borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 24 }}>
              <AvatarUploader 
                currentPreviewUrl={stats?.avatarUrl || ""}
                onCropped={async (file, url) => {
                  setMsg("上傳頭像中...");
                  const base64 = await fileToBase64(file);
                  const res = await fetch("/api/auth/avatar", { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, 
                    body: JSON.stringify({ avatarBase64: base64 }) 
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setStats((prev: any) => ({ ...prev, avatarUrl: data.avatarUrl }));
                    localStorage.setItem('linovelib-avatar', data.avatarUrl);
                    setMsg("頭像更新成功！");
                  }
                  else setMsg("頭像更新失敗");
                }} 
              />
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <div style={{ fontSize: 18, fontWeight: "bold", color: "var(--text)" }}>{getUsernameFromToken(token)}</div>
                  {stats?.level && (
                    <span style={{ fontSize: 11, fontWeight: "bold", background: "var(--accent)", color: "#000", padding: "2px 6px", borderRadius: 4 }}>
                      Lv.{stats.level}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>您已登入，閱讀進度將自動同步至雲端。</div>
              </div>
            </div>

            {stats && (
              <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 24 }}>
                <h3 style={{ fontSize: 14, color: "var(--text)", marginBottom: 12, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>閱讀與等級統計</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>總閱讀字數</div>
                    <div style={{ fontSize: 16, fontWeight: "bold", color: "var(--text)" }}>{(stats.wordsRead || 0).toLocaleString()} 字</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>已讀章節</div>
                    <div style={{ fontSize: 16, fontWeight: "bold", color: "var(--text)" }}>{stats.chaptersRead || 0} 章</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>已讀小說</div>
                    <div style={{ fontSize: 16, fontWeight: "bold", color: "var(--text)" }}>{stats.novelsRead || 0} 本</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>總經驗值 (EXP)</div>
                    <div style={{ fontSize: 16, fontWeight: "bold", color: "var(--text)" }}>{stats.exp || 0}</div>
                  </div>
                </div>
                <div style={{ width: "100%", height: 6, background: "var(--surface2)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, ((stats.currentLevelExp || 0) / (stats.expToNext || 1)) * 100)}%`, height: "100%", background: "var(--accent)", transition: "width 0.3s" }} />
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "right", marginTop: 4 }}>
                  升級還需 {(stats.expToNext || 0) - (stats.currentLevelExp || 0)} EXP
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => { setMsg("同步中..."); triggerSyncPull().then(() => setMsg("雲端同步完成！")); }} style={{ flex: 1, fontFamily: "inherit", fontSize: 14, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "8px", borderRadius: 6, cursor: "pointer" }}>
                手動下載雲端進度
              </button>
              <button onClick={handleLogout} style={{ flex: 1, fontFamily: "inherit", fontSize: 14, background: "#e06c6c20", border: "1px solid #e06c6c50", color: "#e06c6c", padding: "8px", borderRadius: 6, cursor: "pointer" }}>
                登出
              </button>
            </div>
          </div>
        ) : (
          <div style={{ background: "var(--surface)", padding: 20, borderRadius: 8, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 }}>
            <input  
              type="text" placeholder="使用者名稱" value={username} onChange={e => setUsername(e.target.value)}
              style={{ padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
            />
            <input 
              type="password" placeholder="密碼" value={password} onChange={e => setPassword(e.target.value)}
              style={{ padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
            />
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>註冊安全驗證 (若僅登入免填)：</div>
            <input 
              type="text" placeholder="第一題：輸入一個四字安全碼" value={answer1} onChange={e => setAnswer1(e.target.value)}
              style={{ padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
            />
            <input 
              type="text" placeholder="第二題：開發者生日 (四個數字)" value={answer2} onChange={e => setAnswer2(e.target.value)}
              style={{ padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
            />
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <button disabled={loading} onClick={() => handleAuth(true)} style={{ flex: 1, fontFamily: "inherit", fontSize: 14, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>
                登入
              </button>
              <button disabled={loading} onClick={() => handleAuth(false)} style={{ flex: 1, fontFamily: "inherit", fontSize: 14, background: "var(--accent)", border: "none", color: "#000", padding: "10px", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>
                註冊
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Data Management Section */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, color: "var(--text)", marginBottom: 16 }}>本機資料管理</h2>
        <div style={{ background: "var(--surface)", padding: 20, borderRadius: 8, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 14 }}>目前快取大小</span>
            <span style={{ color: "var(--text)", fontWeight: 700 }}>{cacheSize} KB</span>
          </div>
          <button onClick={clearCache} style={{ fontFamily: "inherit", fontSize: 14, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "8px", borderRadius: 6, cursor: "pointer" }}>
            清除章節與目錄快取
          </button>
          
          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "8px 0" }} />
          
          <button onClick={exportData} style={{ fontFamily: "inherit", fontSize: 14, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "8px", borderRadius: 6, cursor: "pointer" }}>
            匯出所有進度 (Backup)
          </button>
          <label style={{ fontFamily: "inherit", fontSize: 14, display: "block", textAlign: "center", background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", padding: "8px", borderRadius: 6, cursor: "pointer" }}>
            <input type="file" accept=".json" onChange={importData} style={{ display: "none" }} />
            匯入進度 (Restore)
          </label>
        </div>
      </section>

    </main>
  );
}
