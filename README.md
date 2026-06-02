# linovelib-reader

部署在 Vercel 的輕小說閱讀器。讀 [linovelib.com](https://www.linovelib.com/) 系列站點。

## 架構

```
Browser ──→ Vercel (Next.js)
              ├─ /api/proxy ─┬─ Mac backend (Playwright + CF Tunnel)   [primary, 可選]
              │               └─ CORS proxies (allorigins / corsproxy)  [fallback]
              ├─ /api/catalog
              ├─ /api/chapter
              └─ localStorage cache (章節 7 天 / 目錄 24h)
```

### 為什麼需要 Mac 後端？

linovelib 對未驗證的 HTTP 請求只回傳前 ~30 段加上 `（內容加載失敗！請重載或更換瀏覽器）` 佔位符，
真實內容由 Cloudflare 驗證後的瀏覽器 JS 才會渲染出來。CORS proxy 通不過 CF 驗證。

- **Mac backend**（`backend/`）跑 Playwright + stealth 真實 Chromium，能拿到完整內容
- 透過 **Cloudflare Tunnel** 暴露給 Vercel，零成本、固定域名
- 如果 Mac 關機或未設定，自動 fallback 到 CORS proxy（部分章節仍能讀到，但截斷的會缺後半段）

設定步驟見 [`backend/README.md`](./backend/README.md)。

## 本機開發

```bash
npm install
npm run dev
# http://localhost:3000
```

## 部署到 Vercel

```bash
vercel --prod --yes
```

### 環境變數（在 Vercel Dashboard 或 `vercel env add`）

| 變數 | 必填 | 說明 |
|---|---|---|
| `BACKEND_URL` | 否 | Mac backend 的 Cloudflare Tunnel URL，例如 `https://linovelib-backend.yeci.lol`。**不要加結尾斜線**。未設則只用 CORS proxy。 |
| `BACKEND_TOKEN` | 否 | 對應 `backend/.env` 裡的 `AUTH_TOKEN`，bearer 驗證用。 |

設定範例：
```bash
vercel env add BACKEND_URL production
# https://linovelib-backend.yeci.lol
vercel env add BACKEND_TOKEN production
# <貼上 backend 那邊的 AUTH_TOKEN>
vercel --prod --yes
```

## 快取行為

- `localStorage`：
  - `linovelib-catalog-cache`：目錄 TTL 24h
  - `linovelib-chapter-cache`：章節 TTL 7d
  - `linovelib-history`、`linovelib-bookmarks`：閱讀進度 / 書籤
- Server 端：`/api/proxy` in-memory cache TTL 24h（per-deployment）

## 驗證

```bash
# 走 backend（若設定）+ fallback
curl -I "https://your-domain.vercel.app/api/proxy?url=https://tw.linovelib.com/novel/2139/156938.html"
# 看 X-Proxy-Source header：backend / cors-proxy / none
```

## 相關專案

- [biliNovel2Epub](https://github.com/fangxx3863/biliNovel2Epub)
- [linovelib2epub](https://github.com/lightnovel-center/linovelib2epub) — 桌面端 Python 版，用 DrissionPage + OCR；本專案後端思路參考自此
