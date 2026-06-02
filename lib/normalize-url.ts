// lib/normalize-url.ts
/**
 * Accepts any of these linovelib URL formats and returns
 * a canonical catalog URL (no trailing .html):
 *   https://tw.linovelib.com/novel/2139
 *   https://tw.linovelib.com/novel/2139.html
 *   https://tw.linovelib.com/novel/2139/catalog
 *   https://tw.linovelib.com/novel/2139/catalog.html
 *   tw.linovelib.com/novel/2139/catalog          (no protocol)
 *
 * Returns null if the input does not look like a linovelib novel URL.
 */
export function normalizeToCatalogUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // Add protocol if missing
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;

  let url: URL;
  try { url = new URL(s); } catch { return null; }

  // Must be linovelib
  if (!url.hostname.endsWith("linovelib.com")) return null;

  // Extract novel ID from pathname like /novel/2139 or /novel/2139/...
  const match = url.pathname.match(/^\/novel\/(\d+)/);
  if (!match) return null;

  const novelId = match[1];
  return `${url.origin}/novel/${novelId}/catalog`;
}
