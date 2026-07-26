import { getHistory, getAllBookmarks, loadBookshelf, loadSettings, save, saveBookmarks, saveBookshelf, saveSettings } from "./history";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("linovelib-token");
  } catch {
    return null;
  }
}

export function getUsernameFromToken(t: string | null): string {
  if (!t) return "User";
  try {
    const base64Url = t.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload).username || "User";
  } catch (e) {
    return "User";
  }
}

export function setAuthToken(token: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (token) localStorage.setItem("linovelib-token", token);
    else localStorage.removeItem("linovelib-token");
  } catch {
    // Authentication remains signed out when browser storage is denied.
  }
}

let syncTimeout: any = null;

export function triggerSyncPush() {
  if (typeof window === "undefined") return;
  const token = getAuthToken();
  if (!token) return;

  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      const history = getHistory();
      const bookmarks = getAllBookmarks();
      const bookshelf = loadBookshelf();

      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ history, bookmarks, bookshelf })
      });
      const data = await res.json();
      if (data.mergedHistory) {
        save(data.mergedHistory, true);
      }
    } catch (e) {
      // silently ignore sync errors in background
    }
  }, 3000); // Debounce
}

let lastPullTime = 0;

export async function triggerSyncPull() {
  const token = getAuthToken();
  if (!token) return;

  const now = Date.now();
  if (now - lastPullTime < 10000) return; // 10s cooldown
  lastPullTime = now;

  try {
    const res = await fetch("/api/sync/pull", {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (!res.ok) throw new Error("Pull failed");
    const data = await res.json();
    
    if (data.history) {
      const localHistory = getHistory();
      const mergedMap = new Map();
      
      // Add local history first
      for (const entry of localHistory) mergedMap.set(entry.catalogUrl, entry);
      
      let needsPush = false;
      // Merge server history
      for (const serverEntry of data.history) {
        const localEntry = mergedMap.get(serverEntry.catalogUrl);
        if (!localEntry || serverEntry.updatedAt > localEntry.updatedAt) {
          mergedMap.set(serverEntry.catalogUrl, serverEntry);
        } else if (localEntry && serverEntry.updatedAt === localEntry.updatedAt) {
          localEntry.visitedChapters = { ...serverEntry.visitedChapters, ...localEntry.visitedChapters };
        } else {
          // Local is newer than server, we should push to sync
          needsPush = true;
        }
      }
      
      const mergedHistory = Array.from(mergedMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      save(mergedHistory, true);
      
      if (needsPush) {
        triggerSyncPush();
      }
    }
    
    if (data.bookmarks) saveBookmarks(data.bookmarks, true);
    if (data.bookshelf) saveBookshelf(data.bookshelf, true);
    
  } catch (e) {
    // silently ignore pull errors in background
  }
}
