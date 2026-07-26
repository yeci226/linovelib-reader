"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadBookshelf, getCatalogCache, BookshelfEntry, removeFromBookshelf } from "@/lib/history";
import { canOpenOfflineResource } from "@/lib/offline-access";
import { useOnlineStatus } from "@/lib/use-online-status";
import { ImagePlaceholderIcon, CloseIcon } from "@/components/icons";
import { triggerSyncPull } from "@/lib/sync";

interface BookshelfItem extends BookshelfEntry {
  hasUpdate?: boolean;
  newTotalChapters?: number;
  checking?: boolean;
}

export default function BookshelfPage() {
  const [items, setItems] = useState<BookshelfItem[]>([]);
  const router = useRouter();
  const isOnline = useOnlineStatus();

  useEffect(() => {
    triggerSyncPull().then(() => {
      const loaded = loadBookshelf();
      setItems(loaded.map(i => ({ ...i, checking: true })));

      // Check for updates
      loaded.forEach(async (item, idx) => {
      try {
        const res = await fetch(`/api/catalog?url=${encodeURIComponent(item.catalogUrl)}&refresh=0`);
        if (res.ok) {
          const data = await res.json();
          const totalChapters = data.volumes.reduce((acc: number, v: any) => acc + v.chapters.length, 0);
          setItems(prev => {
            const next = [...prev];
            const target = next.find(x => x.catalogUrl === item.catalogUrl);
            if (target) {
              target.checking = false;
              if (totalChapters > target.totalChapters) {
                target.hasUpdate = true;
                target.newTotalChapters = totalChapters;
              }
            }
            return next;
          });
        }
      } catch (e) {
        setItems(prev => {
          const next = [...prev];
          const target = next.find(x => x.catalogUrl === item.catalogUrl);
          if (target) target.checking = false;
          return next;
        });
      }
    });
    });
  }, []);

  const handleRemove = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    removeFromBookshelf(url);
    setItems(prev => prev.filter(x => x.catalogUrl !== url));
  };

  return (
    <main style={{ minHeight: "100vh", padding: "40px 24px", maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>我的書架</h1>
        <button onClick={() => { if (isOnline) router.push("/"); else window.location.assign("/"); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}>
          返回首頁
        </button>
      </div>

      {items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 0", color: "var(--text-muted)" }}>
          書架是空的，快去尋找喜歡的小說吧！
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 20 }}>
          {items.map(item => {
            const canOpen = canOpenOfflineResource(isOnline, !!getCatalogCache(item.catalogUrl));
            const openCatalog = () => {
              if (!canOpen) return;
              const href = `/catalog?url=${encodeURIComponent(item.catalogUrl)}`;
              if (isOnline) router.push(href);
              else window.location.assign(href);
            };

            return <div
              key={item.catalogUrl}
              onClick={openCatalog}
              aria-disabled={!canOpen}
              title={canOpen ? item.novelTitle : "此小說目錄尚未快取，離線時無法開啟"}
              style={{ cursor: canOpen ? "pointer" : "not-allowed", opacity: canOpen ? 1 : 0.45, position: "relative", display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ width: "100%", aspectRatio: "3/4", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)", position: "relative" }}>
                {item.coverUrl ? (
                  <img src={`/api/image?url=${encodeURIComponent(item.coverUrl)}`} alt={item.novelTitle} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <div style={{ width: "100%", height: "100%", background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
                    <ImagePlaceholderIcon style={{ fontSize: 32 }} />
                  </div>
                )}
                
                {/* Update Badge */}
                {item.hasUpdate && (
                  <div style={{ position: "absolute", top: 6, right: 6, background: "#e06c6c", color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }}>
                    有新更新
                  </div>
                )}
                
                {/* Remove button */}
                <button 
                  onClick={(e) => handleRemove(e, item.catalogUrl)}
                  style={{ position: "absolute", bottom: 6, right: 6, background: "rgba(0,0,0,0.6)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "50%", width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}
                >
                  <CloseIcon style={{ fontSize: 14 }} />
                </button>
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {item.novelTitle}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  {item.checking ? "檢查更新中..." : (item.hasUpdate ? `已更新至 ${item.newTotalChapters} 章` : `共 ${item.totalChapters} 章`)}
                </div>
              </div>
            </div>;
          })}
        </div>
      )}
    </main>
  );
}
