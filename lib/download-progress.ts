export type ChapterDownloadPhase = "fetching" | "media" | "saving" | "complete";

export type ChapterProgressInput = {
  phase: ChapterDownloadPhase;
  completed: number;
  total: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getChapterProgressPercent(progress: ChapterProgressInput): number {
  const completed = Math.max(0, progress.completed);

  switch (progress.phase) {
    case "fetching":
      return clamp(5 + completed * 8, 5, 45);
    case "media": {
      if (!progress.total || progress.total <= 0) return 90;
      return Math.round(50 + clamp(completed / progress.total, 0, 1) * 40);
    }
    case "saving":
      return 95;
    case "complete":
      return 100;
  }
}

export function getVolumeProgressPercent(chapterUrls: string[], progressByUrl: Record<string, number>): number {
  if (chapterUrls.length === 0) return 0;
  return Math.round(chapterUrls.reduce((sum, url) => sum + clamp(progressByUrl[url] ?? 0, 0, 100), 0) / chapterUrls.length);
}
