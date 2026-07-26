"use client";

import { parseChapterHtml } from "./chapter-parser";
import { saveChapterCache, loadChapterCache, type ContentNode } from "./history";
import { restoreChars } from "./linovelib-charmap";
import { getChapterProgressPercent, type ChapterProgressInput } from "./download-progress";
import { createRequestQueue, mapWithConcurrencySettled, retryAfterMs } from "./download-queue";
import { cacheOfflineRoute } from "./offline-route-cache";

type ChapterPageApiResult = {
  title: string;
  content: string;
  nextPageUrl: string | null;
  nextChapterUrl: string | null;
  prevChapterUrl: string | null;
  html?: string;
};

export type OfflineDownloadProgress = {
  completed: number;
  total: number;
  chapterUrl: string;
  chapterTitle: string;
  failed?: boolean;
  error?: string;
};

export type OfflineChapterProgress = ChapterProgressInput & {
  chapterUrl: string;
  chapterTitle: string;
  percent: number;
};

type DownloadBatchOptions = {
  concurrency?: number;
  onProgress?: (progress: OfflineDownloadProgress) => void;
  onChapterProgress?: (progress: OfflineChapterProgress) => void;
};

const enqueueChapterRequest = createRequestQueue(350);
const enqueueMediaRequest = createRequestQueue(200);

async function fetchWithRateLimitRetry(url: string, enqueue: ReturnType<typeof createRequestQueue>): Promise<Response> {
  return enqueue(async () => {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(url);
      if (res.status !== 429 || attempt >= 3) return res;
      await res.body?.cancel().catch(() => undefined);
      const waitMs = retryAfterMs(res.headers.get("retry-after"), 1000 * 2 ** attempt);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  });
}

async function fetchChapterPage(url: string, catalogUrl: string): Promise<ChapterPageApiResult> {
  const res = await fetchWithRateLimitRetry(
    `/api/chapter?url=${encodeURIComponent(url)}&catalogUrl=${encodeURIComponent(catalogUrl)}`,
    enqueueChapterRequest,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json() as ChapterPageApiResult;
  if (!data.content && data.html) {
    Object.assign(data, parseChapterHtml(data.html, url, null));
  }
  return data;
}

function contentToNodes(content: string): ContentNode[] {
  return content
    .split(/\n\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const imgMatch = /^\[IMG:(https?:\/\/.+)\]$/.exec(line);
      if (imgMatch) return { type: "image" as const, src: imgMatch[1], alt: "" };
      if (/^\d{1,3}$/.test(line) || /^-\s*\d{1,3}\s*-$/.test(line)) {
        return { type: "page-number" as const, text: line };
      }
      return { type: "text" as const, text: line };
    });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function fetchMediaAsDataUrl(url: string): Promise<string> {
  const res = await fetchWithRateLimitRetry(`/api/image?url=${encodeURIComponent(url)}`, enqueueMediaRequest);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image HTTP ${res.status}: ${text}`);
  }
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    }),
  );
}

async function embedOfflineMedia(
  nodes: ContentNode[],
  onProgress?: (completed: number, total: number) => void,
): Promise<ContentNode[]> {
  const nextNodes = [...nodes];
  const imageIndexes = nextNodes
    .map((node, index) => ({ node, index }))
    .filter((entry): entry is { node: Extract<ContentNode, { type: "image" }>; index: number } => entry.node.type === "image" && /^https?:\/\//.test(entry.node.src));

  const cache = new Map<string, string>();
  let completed = 0;
  onProgress?.(0, imageIndexes.length);

  // ponytail: keep media embedding concurrency low to avoid hammering the image proxy and blowing browser memory; raise if users need faster bulk art caching.
  await mapWithConcurrency(imageIndexes, 3, async ({ node, index }) => {
    if (!cache.has(node.src)) {
      cache.set(node.src, await fetchMediaAsDataUrl(node.src));
    }
    nextNodes[index] = { ...node, src: cache.get(node.src)! };
    completed += 1;
    onProgress?.(completed, imageIndexes.length);
  });

  return nextNodes;
}

export async function downloadChapterForOffline(
  chapterUrl: string,
  catalogUrl: string,
  onProgress?: (progress: OfflineChapterProgress) => void,
): Promise<{ title: string; alreadyDownloaded: boolean }> {
  const report = (chapterTitle: string, progress: ChapterProgressInput) => {
    onProgress?.({ ...progress, chapterUrl, chapterTitle, percent: getChapterProgressPercent(progress) });
  };
  const readHref = `/read?url=${encodeURIComponent(chapterUrl)}&catalog=${encodeURIComponent(catalogUrl)}`;
  const cached = await loadChapterCache(chapterUrl);
  if (cached?.pinned) {
    if (!await cacheOfflineRoute(readHref)) {
      throw new Error("離線閱讀頁快取失敗，請保持連線後重試");
    }
    report(cached.title, { phase: "complete", completed: 1, total: 1 });
    return { title: cached.title, alreadyDownloaded: true };
  }

  report("正在取得章節", { phase: "fetching", completed: 0, total: null });
  const firstPage = await fetchChapterPage(chapterUrl, catalogUrl);
  firstPage.content = restoreChars(firstPage.content || "");
  let allNodes = [...contentToNodes(firstPage.content)];
  const chapterTitle = firstPage.title || "未命名章節";
  let fetchedPages = 1;
  report(chapterTitle, { phase: "fetching", completed: fetchedPages, total: null });

  let nextPage = firstPage.nextPageUrl;
  let lastPage = firstPage;
  while (nextPage) {
    const pageData = await fetchChapterPage(nextPage, catalogUrl);
    pageData.content = restoreChars(pageData.content || "");
    allNodes.push(...contentToNodes(pageData.content));
    lastPage = pageData;
    nextPage = pageData.nextPageUrl;
    fetchedPages += 1;
    report(chapterTitle, { phase: "fetching", completed: fetchedPages, total: null });
  }

  allNodes = await embedOfflineMedia(allNodes, (completed, total) => {
    report(chapterTitle, { phase: "media", completed, total });
  });

  report(chapterTitle, { phase: "saving", completed: 0, total: 0 });
  await saveChapterCache(chapterUrl, {
    title: chapterTitle,
    subtitle: "",
    nodes: allNodes,
    nextChapterUrl: lastPage.nextChapterUrl,
    prevChapterUrl: firstPage.prevChapterUrl,
    pinned: true,
  });

  if (!await cacheOfflineRoute(readHref)) {
    throw new Error("離線閱讀頁快取失敗，請保持連線後重試");
  }

  report(chapterTitle, { phase: "complete", completed: 1, total: 1 });
  return { title: chapterTitle, alreadyDownloaded: false };
}

export async function downloadChaptersForOffline(
  chapterUrls: string[],
  catalogUrl: string,
  options?: DownloadBatchOptions,
): Promise<{ completed: number; skipped: number; failed: number }> {
  const normalized = Array.from(new Set(chapterUrls.filter(Boolean)));
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let settled = 0;
  const concurrency = Math.max(1, options?.concurrency ?? 4);

  await mapWithConcurrencySettled(normalized, concurrency, async chapterUrl => {
    try {
      const result = await downloadChapterForOffline(chapterUrl, catalogUrl, options?.onChapterProgress);
      if (result.alreadyDownloaded) {
        skipped += 1;
      } else {
        completed += 1;
      }
      settled += 1;
      options?.onProgress?.({
        completed: settled,
        total: normalized.length,
        chapterUrl,
        chapterTitle: result.title,
      });
      return result;
    } catch (error) {
      failed += 1;
      settled += 1;
      options?.onProgress?.({
        completed: settled,
        total: normalized.length,
        chapterUrl,
        chapterTitle: "下載失敗",
        failed: true,
        error: String(error),
      });
      throw error;
    }
  });

  return { completed, skipped, failed };
}
