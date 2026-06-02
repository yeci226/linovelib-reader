/**
 * Simple file-based cache.
 *
 * - 章節內容永不過期（除非手動清 .cache/）
 * - 目錄預設 1 天
 *
 * Key 用 sha1(url) 當檔名，避免特殊字元。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), ".cache");

type Entry<T> = { savedAt: number; ttlMs: number | null; data: T };

function keyToPath(namespace: string, key: string): string {
  const hash = createHash("sha1").update(key).digest("hex");
  return join(CACHE_DIR, namespace, `${hash}.json`);
}

export async function readCache<T>(namespace: string, key: string): Promise<T | null> {
  const path = keyToPath(namespace, key);
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as Entry<T>;
    if (entry.ttlMs !== null && Date.now() - entry.savedAt > entry.ttlMs) {
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  namespace: string,
  key: string,
  data: T,
  ttlMs: number | null = null,
): Promise<void> {
  const path = keyToPath(namespace, key);
  await mkdir(join(CACHE_DIR, namespace), { recursive: true });
  const entry: Entry<T> = { savedAt: Date.now(), ttlMs, data };
  await writeFile(path, JSON.stringify(entry), "utf8");
}
