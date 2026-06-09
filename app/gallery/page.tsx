"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeftIcon } from "@/components/icons";

type ImageEntry = {
  id: number;
  catalogUrl: string;
  chapterUrl: string;
  chapterTitle: string;
  src: string;
};

import { Suspense } from "react";

function GalleryContent() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url");
  const router = useRouter();

  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    fetch(`/api/gallery?url=${encodeURIComponent(url)}`)
      .then(res => res.json())
      .then(data => {
        setImages(data.images || []);
        setLoading(false);
      });
  }, [url]);

  if (!url) return null;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", height: 56, padding: "0 16px" }}>
        <button onClick={() => router.back()} style={{ background: "none", border: "none", color: "var(--text)", padding: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", borderRadius: "50%" }}>
          <ChevronLeftIcon style={{ fontSize: 24 }} />
        </button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 18, fontWeight: 700, paddingRight: 40 }}>
          插圖畫廊
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: 40 }}>載入中...</div>
        ) : images.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: 40 }}>
            <p>目前尚未收集到任何插圖。</p>
            <p style={{ fontSize: 13, marginTop: 8 }}>當您閱讀章節時，系統會自動在背景收集章節內的插圖。</p>
          </div>
        ) : (
          <div style={{ columns: "3 160px", columnGap: 16 }}>
            {images.map(img => (
              <div 
                key={img.id} 
                style={{ breakInside: "avoid", marginBottom: 16, background: "var(--surface)", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)", cursor: "zoom-in" }}
                onClick={() => setZoomedImage(img.src)}
              >
                <img src={`/api/image?url=${encodeURIComponent(img.src)}`} alt="" style={{ width: "100%", display: "block", minHeight: 100 }} loading="lazy" />
                <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)", background: "var(--surface2)", borderTop: "1px solid var(--border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {img.chapterTitle}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {zoomedImage && (
        <div 
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out", padding: 16 }}
          onClick={() => setZoomedImage(null)}
        >
          <img src={`/api/image?url=${encodeURIComponent(zoomedImage)}`} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }} />
        </div>
      )}
    </main>
  );
}

export default function GalleryPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <GalleryContent />
    </Suspense>
  );
}
