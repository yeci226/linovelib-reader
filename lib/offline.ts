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

export async function downloadChapterForOffline(chapterUrl: string, catalogUrl: string): Promise<{ title: string; alreadyDownloaded: boolean }> {
  const cached = getChapterCache(chapterUrl);
  if (cached) {
    return { title: cached.title, alreadyDownloaded: true };
  }

  const firstPage = await fetchChapterPage(chapterUrl, catalogUrl);
  firstPage.content = restoreChars(firstPage.content || "");
  const allNodes = [...contentToNodes(firstPage.content)];
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
  onProgress?: (progress: OfflineDownloadProgress) => void,
): Promise<{ completed: number; skipped: number }> {
  const normalized = Array.from(new Set(chapterUrls.filter(Boolean)));
  let completed = 0;
  let skipped = 0;

  for (const chapterUrl of normalized) {
    const result = await downloadChapterForOffline(chapterUrl, catalogUrl);
    if (result.alreadyDownloaded) {
      skipped += 1;
    } else {
      completed += 1;
    }
    onProgress?.({
      completed: completed + skipped,
      total: normalized.length,
      chapterUrl,
      chapterTitle: result.title,
    });
  }

  return { completed, skipped };
}
