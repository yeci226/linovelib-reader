# linovelib-reader backend

在 Mac 上跑的 Playwright + Fastify 服務，用真實 Chromium 渲染 linovelib 頁面以繞過 Cloudflare 與 JS 文字解碼，
然後把完整 HTML 回傳給 Vercel 部署的前端 `/api/proxy`。

## 設計

```
Browser → Vercel (linovelib-reader) → /api/proxy ─┬─ Mac backend (CF Tunnel)  ← 你在這
                                                   └─ CORS proxies (fallback)
```

- 單一 Chromium 程序、共用 context、串行佇列（預設並發 2）
- 用 `playwright-extra` + `stealth` 偽裝指紋
- 自動阻擋 image/font/media 資源，加速擷取
- 等待 `#acontent` 文字長度 > 800 字且不含「內容加載失敗」標記後再回傳
- URL allow-list：只允許 `*.linovelib.com` / `*.bilinovel.com`
- Bearer token 驗證（你跟朋友共用 token）
- in-memory LRU cache（30 分鐘）

## 一次性安裝

需要 Node 18+。

```bash
cd backend
cp .env.example .env
# 編輯 .env，把 AUTH_TOKEN 改成一個夠長的隨機字串，例如：
# openssl rand -hex 32
npm install
# postinstall 會自動 `playwright install chromium` 下載 Chromium
```

## 啟動服務

```bash
npm start
# 輸出：linovelib-reader-backend listening on :3001 (headless=true, concurrency=2)
```

健康檢查：
```bash
curl http://localhost:3001/health
# {"ok":true,"active":0,"queued":0,"cached":0}
```

實際抓一頁（替換 `<token>`）：
```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3001/fetch?url=https://tw.linovelib.com/novel/2139/156938.html" \
  -o test.html
# 開 test.html 應該能看到完整章節內容（沒有「內容加載失敗」字串）
```

如要視覺化偵錯（看 Chromium 視窗）：在 `.env` 設 `HEADLESS=false` 後重啟。

## 用 Cloudflare Tunnel 暴露給 Vercel

最簡單的「快速 tunnel」（隨機域名，重啟會變）：

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3001
# 輸出會給你類似：
# https://random-words-1234.trycloudflare.com
```

把這個 URL 設為 Vercel 的 `BACKEND_URL` 環境變數（不要加結尾斜線），token 設為 `BACKEND_TOKEN`：

```bash
# 在 linovelib-reader 專案根目錄
vercel env add BACKEND_URL production
# 貼上 https://random-words-1234.trycloudflare.com

vercel env add BACKEND_TOKEN production
# 貼上 .env 裡那個 AUTH_TOKEN

vercel --prod --yes
```

### 想要固定域名（推薦）

如果你的網域（例如 `yeci.lol`）放在 Cloudflare 上：

```bash
cloudflared tunnel login           # 一次性，瀏覽器授權
cloudflared tunnel create linovelib-backend
cloudflared tunnel route dns linovelib-backend linovelib-backend.yeci.lol
```

建 `~/.cloudflared/config.yml`：
```yaml
tunnel: linovelib-backend
credentials-file: /Users/你的帳號/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: linovelib-backend.yeci.lol
    service: http://localhost:3001
  - service: http_status:404
```

啟動：
```bash
cloudflared tunnel run linovelib-backend
```

之後 `BACKEND_URL` 設成 `https://linovelib-backend.yeci.lol`，重啟 Mac/tunnel 域名不變。

## 開機自動啟動（可選）

用 launchd：建 `~/Library/LaunchAgents/com.yeci.linovelib-backend.plist`，內容自行 google「launchd plist node」範本。
或者用 `pm2 start npm --name linovelib-backend -- start` + `pm2 startup` 比較快。

Cloudflared 也類似：
```bash
sudo cloudflared service install
```

## 失敗排查

- `429` / 被 Cloudflare 擋：降低 `CONCURRENCY=1`，linovelib 對速率敏感
- 章節仍有「內容加載失敗」：把 `HEADLESS=false` 觀察一下 Chromium 真實渲染結果。可能要把 `SETTLE_MS` 從 1500 拉高
- Vercel 端 502：先 `curl https://你的tunnel/health` 確認 tunnel 通；再檢查 `Authorization` token 是否一致
