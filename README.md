# 📖 Linovelib Reader (輕小說閱讀器)

> 專為極致閱讀體驗打造的第三方輕小說閱讀器，採用最新的分離式架構（Next.js 邊緣渲染 + Playwright 獨立抓取伺服器），徹底解決 Cloudflare 驗證與 Vercel 唯讀資料庫限制。

![【請替換】專案首頁預覽圖](https://placehold.co/1200x400/1e1e2e/cdd6f4?text=Linovelib+Reader+Preview+Image&font=Montserrat)

---

## ✨ 核心特色

- **🚀 零 Cloudflare 阻擋**：後端採用 Playwright 模擬真實瀏覽器抓取，無痛繞過所有的防機器人驗證。
- **📚 完美的快取機制**：使用 `better-sqlite3` 將所有小說目錄、章節、圖片快取至後端伺服器，大幅降低目標網站的請求頻率，並解決 Serverless (如 Vercel) 的唯讀檔案系統限制。
- **⚡ 極速前端渲染**：前端採用 Next.js，所有 API 皆為輕量級 Proxy，減少前端伺服器的負擔。
- **📱 響應式設計**：完美支援手機與桌面端閱讀。

---

## 🏛️ 系統架構 (Architecture)

本專案採用 **分離式架構 (Decoupled Architecture)**：

```mermaid
graph LR
    A[使用者 (Browser)] -->|瀏覽小說| B(Next.js 前端 - Vercel)
    B -->|Proxy 轉發| C{Server API - 獨立 VPS}
    C -->|讀寫快取| D[(SQLite - reader.db)]
    C -->|Playwright 抓取| E[Linovelib 網站]
    
    style B fill:#000000,stroke:#ffffff,stroke-width:2px,color:#ffffff
    style C fill:#2E8B57,stroke:#ffffff,stroke-width:2px,color:#ffffff
    style D fill:#4682B4,stroke:#ffffff,stroke-width:2px,color:#ffffff
```

> [!NOTE]
> **為何需要這樣設計？**
> Next.js 若部署於 Vercel，其檔案系統是**唯讀的 (Read-only)**。若在前端直接爬取並寫入 SQLite 會引發 `SqliteError: attempt to write a readonly database`。因此我們將**抓取 (Playwright)** 與 **儲存 (SQLite)** 統一交由你具備寫入權限的 `backend/server.js` 處理。

---

## 🖼️ 畫面預覽 (Screenshots)

````carousel
![【請替換】探索頁面截圖](https://placehold.co/800x500/1e1e2e/cdd6f4?text=Explore+Page+Screenshot)
<!-- slide -->
![【請替換】小說目錄頁面截圖](https://placehold.co/800x500/1e1e2e/cdd6f4?text=Catalog+Page+Screenshot)
<!-- slide -->
![【請替換】閱讀器介面截圖](https://placehold.co/800x500/1e1e2e/cdd6f4?text=Reader+Interface+Screenshot)
````

---

## 🚀 部署與啟動指南

### 1. 啟動後端抓取伺服器 (Server API)

後端伺服器負責所有繁重的爬蟲與資料庫寫入工作。建議將其部署在具有寫入權限的 VPS（例如 Ubuntu、Debian）或你本地的電腦。

> [!WARNING]
> 請確保你的伺服器環境已安裝 Node.js 18+。

```bash
cd backend
yarn install

# 確保已安裝 Playwright 所需的瀏覽器
npx playwright install chromium

# 複製並設定環境變數
cp .env.example .env
# 請編輯 .env 檔案，設定好你的 AUTH_TOKEN 與 PORT
```

啟動後端：
```bash
yarn start
```
*(預設將運行於 `http://localhost:3001`)*

### 2. 啟動 Next.js 前端

前端可以部署在任何地方，包含 Vercel。

```bash
yarn install
```

建立 `.env.local` 檔案並填入以下內容，讓前端知道要去哪裡尋找後端：
```env
# 指向你的 Server API 位址 (如果是本地測試，請填 http://localhost:3001)
BACKEND_URL=http://localhost:3001

# 必須與後端 .env 中的 AUTH_TOKEN 完全一致
AUTH_TOKEN=your_secure_auth_token_here
```

啟動前端開發伺服器：
```bash
yarn dev
```

---

## 🛡️ Vercel 部署注意事項

若你要將前端部署至 Vercel，請務必在 Vercel 的專案設定面板 (Settings -> Environment Variables) 中新增以下變數：

- `BACKEND_URL`：填入你 VPS 或 Cloudflare Tunnel 暴露出來的後端網址（結尾**不要**加斜線，例如 `https://api.yourdomain.com`）。
- `AUTH_TOKEN`：填入你的驗證密鑰。

> [!IMPORTANT]
> 前端 API 路由 (`/api/discover/*`, `/api/catalog`, `/api/chapter` 等) 現已全部改為純 Proxy，Vercel 部署後將不再遇到唯讀資料庫報錯。

---

## 🤝 貢獻與鳴謝

- 爬蟲策略參考了 [biliNovel2Epub](https://github.com/fangxx3863/biliNovel2Epub) 等優秀開源專案。
- 專案採用 Next.js App Router 與 Fastify 構建。
