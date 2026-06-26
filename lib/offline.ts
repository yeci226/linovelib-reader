"use client";

import { parseChapterHtml } from "./chapter-parser";
import { saveChapterCache, getChapterCache, type ContentNode } from "./history";
import { restoreChars } from "./linovelib-charmap";

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
};

type DownloadBatchOptions = {
  concurrency?: number;
  onProgress?: (progress: OfflineDownloadProgress) => void;
};

async function fetchChapterPage(url: string, catalogUrl: string): Promise<ChapterPageApiResult> {
  const res = await fetch(`/api/chapter?url=${encodeURIComponent(url)}&catalogUrl=${encodeURIComponent(catalogUrl)}`);
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
  const res = await fetch(`/api/image?url=${encodeURIComponent(url)}`);
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

async function embedOfflineMedia(nodes: ContentNode[]): Promise<ContentNode[]> {
  const nextNodes = [...nodes];
  const imageIndexes = nextNodes
    .map((node, index) => ({ node, index }))
    .filter((entry): entry is { node: Extract<ContentNode, { type: "image" }>; index: number } => entry.node.type === "image" && /^https?:\/\//.test(entry.node.src));

  const cache = new Map<string, string>();

  // ponytail: keep media embedding concurrency low to avoid hammering the image proxy and blowing browser memory; raise if users need faster bulk art caching.
  await mapWithConcurrency(imageIndexes, 3, async ({ node, index }) => {
    if (!cache.has(node.src)) {
      cache.set(node.src, await fetchMediaAsDataUrl(node.src));
    }
    nextNodes[index] = { ...node, src: cache.get(node.src)! };
  });

  return nextNodes;
}

export async function downloadChapterForOffline(chapterUrl: string, catalogUrl: string): Promise<{ title: string; alreadyDownloaded: boolean }> {
  const cached = getChapterCache(chapterUrl);
  if (cached) {
    return { title: cached.title, alreadyDownloaded: true };
  }

  const firstPage = await fetchChapterPage(chapterUrl, catalogUrl);
  firstPage.content = restoreChars(firstPage.content || "");
  let allNodes = [...contentToNodes(firstPage.content)];
  const chapterTitle = firstPage.title || "未命名章節";

  let nextPage = firstPage.nextPageUrl;
  let lastPage = firstPage;
  while (nextPage) {
    const pageData = await fetchChapterPage(nextPage, catalogUrl);
    pageData.content = restoreChars(pageData.content || "");
    allNodes.push(...contentToNodes(pageData.content));
    lastPage = pageData;
    nextPage = pageData.nextPageUrl;
  }

  allNodes = await embedOfflineMedia(allNodes);

  saveChapterCache(chapterUrl, {
    title: chapterTitle,
    subtitle: "",
    nodes: allNodes,
    nextChapterUrl: lastPage.nextChapterUrl,
    prevChapterUrl: firstPage.prevChapterUrl,
    pinned: true,
  });

  return { title: chapterTitle, alreadyDownloaded: false };
}

export async function downloadChaptersForOffline(
  chapterUrls: string[],
  catalogUrl: string,
  options?: DownloadBatchOptions,
): Promise<{ completed: number; skipped: number }> {
  const normalized = Array.from(new Set(chapterUrls.filter(Boolean)));
  let completed = 0;
  let skipped = 0;
  const concurrency = Math.max(1, options?.concurrency ?? 4);

  await mapWithConcurrency(normalized, concurrency, async chapterUrl => {
    const result = await downloadChapterForOffline(chapterUrl, catalogUrl);
    if (result.alreadyDownloaded) {
      skipped += 1;
    } else {
      completed += 1;
    }
    options?.onProgress?.({
      completed: completed + skipped,
      total: normalized.length,
      chapterUrl,
      chapterTitle: result.title,
    });
  });

  return { completed, skipped };
}
