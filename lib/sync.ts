import { getHistory, getAllBookmarks, loadBookshelf, loadSettings, save, saveBookmarks, saveBookshelf, saveSettings } from "./history";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("linovelib-token");
}

export function setAuthToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem("linovelib-token", token);
  else localStorage.removeItem("linovelib-token");
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
      const settings = loadSettings();

      await fetch("/api/sync/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ history, bookmarks, bookshelf, settings })
      });
    } catch (e) {
      // silently ignore sync errors in background
    }
  }, 3000); // Debounce
}

export async function triggerSyncPull() {
  const token = getAuthToken();
  if (!token) return;

  try {
    const res = await fetch("/api/sync/pull", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Pull failed");
    const data = await res.json();
    
    if (data.history) save(data.history, true);
    if (data.bookmarks) saveBookmarks(data.bookmarks, true);
    if (data.bookshelf) saveBookshelf(data.bookshelf, true);
    if (data.settings && Object.keys(data.settings).length > 0) saveSettings(data.settings, true);
    
  } catch (e) {
    // silently ignore pull errors in background
  }
}
