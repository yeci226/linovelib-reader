"use client";
import React, { useState, useCallback } from "react";
import Cropper from "react-easy-crop";

interface AvatarUploaderProps {
  onCropped: (file: File, previewUrl: string) => void;
  currentPreviewUrl?: string | null;
}

export function AvatarUploader({ onCropped, currentPreviewUrl }: AvatarUploaderProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.addEventListener("load", () => setImageSrc(reader.result?.toString() || null));
      reader.readAsDataURL(file);
    }
  };

  const onCropComplete = useCallback((croppedArea: any, croppedAreaPixels: any) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const createCrop = async () => {
    if (!imageSrc || !croppedAreaPixels) return;
    try {
      const image = await createImage(imageSrc);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = 256;
      canvas.height = 256;

      ctx.drawImage(
        image,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0,
        0,
        256,
        256
      );

      canvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], "avatar.webp", { type: "image/webp" });
        const previewUrl = URL.createObjectURL(blob);
        onCropped(file, previewUrl);
        setImageSrc(null); // close cropper
      }, "image/webp", 0.9);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div>
      <label style={{ display: "inline-block", cursor: "pointer", position: "relative" }}>
        <div style={{ width: 80, height: 80, borderRadius: "50%", background: "var(--surface2)", border: "2px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", color: "var(--text-muted)", fontSize: 12 }}>
          {currentPreviewUrl ? (
            <img src={currentPreviewUrl} alt="Avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            "上傳頭像"
          )}
        </div>
        <input type="file" accept="image/*" onChange={onFileChange} style={{ display: "none" }} />
      </label>

      {imageSrc && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.8)", display: "flex", flexDirection: "column" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onCropComplete={onCropComplete}
              onZoomChange={setZoom}
            />
          </div>
          <div style={{ padding: 24, background: "var(--bg)", display: "flex", gap: 16, justifyContent: "center" }}>
            <button onClick={() => setImageSrc(null)} style={{ padding: "8px 24px", borderRadius: 20, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", cursor: "pointer" }}>取消</button>
            <button onClick={createCrop} style={{ padding: "8px 24px", borderRadius: 20, background: "var(--accent)", color: "#000", border: "none", fontWeight: "bold", cursor: "pointer" }}>確認裁切</button>
          </div>
        </div>
      )}
    </div>
  );
}

const createImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", (error) => reject(error));
    image.setAttribute("crossOrigin", "anonymous");
    image.src = url;
  });
