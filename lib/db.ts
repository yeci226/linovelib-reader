import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(path.join(dbDir, 'reader.db'));

db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS DiscoverCache (
    key TEXT PRIMARY KEY,
    data JSON NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS Catalogs (
    catalogUrl TEXT PRIMARY KEY,
    data JSON NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS Chapters (
    chapterUrl TEXT PRIMARY KEY,
    catalogUrl TEXT NOT NULL,
    data JSON NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS Images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    catalogUrl TEXT NOT NULL,
    chapterUrl TEXT NOT NULL,
    chapterTitle TEXT NOT NULL,
    src TEXT NOT NULL,
    alt TEXT,
    createdAt INTEGER NOT NULL,
    UNIQUE(catalogUrl, chapterUrl, src)
  );
  
  CREATE INDEX IF NOT EXISTS idx_images_catalog ON Images(catalogUrl);
`);

export default db;

// Data structures
export type DiscoverCacheEntry = { key: string; data: string; updatedAt: number };
export type CatalogEntry = { catalogUrl: string; data: string; updatedAt: number };
export type ChapterEntry = { chapterUrl: string; catalogUrl: string; data: string; updatedAt: number };
export type ImageEntry = { id: number; catalogUrl: string; chapterUrl: string; chapterTitle: string; src: string; alt: string; createdAt: number };

// Helper functions

export function getDiscoverCache(key: string): any | null {
  const stmt = db.prepare('SELECT * FROM DiscoverCache WHERE key = ?');
  const row = stmt.get(key) as DiscoverCacheEntry | undefined;
  if (!row) return null;
  // If > 24 hours old, consider stale
  if (Date.now() - row.updatedAt > 24 * 60 * 60 * 1000) return null;
  return JSON.parse(row.data);
}

export function setDiscoverCache(key: string, data: any) {
  const stmt = db.prepare('INSERT OR REPLACE INTO DiscoverCache (key, data, updatedAt) VALUES (?, ?, ?)');
  stmt.run(key, JSON.stringify(data), Date.now());
}

export function getCatalogDb(catalogUrl: string): any | null {
  const stmt = db.prepare('SELECT * FROM Catalogs WHERE catalogUrl = ?');
  const row = stmt.get(catalogUrl) as CatalogEntry | undefined;
  if (!row) return null;
  if (Date.now() - row.updatedAt > 24 * 60 * 60 * 1000) return null;
  return JSON.parse(row.data);
}

export function setCatalogDb(catalogUrl: string, data: any) {
  const stmt = db.prepare('INSERT OR REPLACE INTO Catalogs (catalogUrl, data, updatedAt) VALUES (?, ?, ?)');
  stmt.run(catalogUrl, JSON.stringify(data), Date.now());
}

export function getChapterDb(chapterUrl: string): any | null {
  const stmt = db.prepare('SELECT * FROM Chapters WHERE chapterUrl = ?');
  const row = stmt.get(chapterUrl) as ChapterEntry | undefined;
  if (!row) return null;
  return JSON.parse(row.data); // Chapters don't expire
}

export function setChapterDb(chapterUrl: string, catalogUrl: string, data: any) {
  const stmt = db.prepare('INSERT OR REPLACE INTO Chapters (chapterUrl, catalogUrl, data, updatedAt) VALUES (?, ?, ?, ?)');
  stmt.run(chapterUrl, catalogUrl, JSON.stringify(data), Date.now());
}

export function addImageDb(catalogUrl: string, chapterUrl: string, chapterTitle: string, src: string, alt: string) {
  const stmt = db.prepare('INSERT OR IGNORE INTO Images (catalogUrl, chapterUrl, chapterTitle, src, alt, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(catalogUrl, chapterUrl, chapterTitle, src, alt, Date.now());
}

export function getImagesDb(catalogUrl: string): ImageEntry[] {
  const stmt = db.prepare('SELECT * FROM Images WHERE catalogUrl = ? ORDER BY id ASC');
  return stmt.all(catalogUrl) as ImageEntry[];
}
