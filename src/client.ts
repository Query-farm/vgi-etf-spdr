// The real SSGA HTTP client — the ONE module that touches the network, so (like the sibling
// iShares/yfinance clients) it is exercised live, not by the unit tests, which drive the pure
// driver in spdr.ts through injected `get` / `getBytes`.
//
// Both SSGA planes — the fund-finder JSON and the per-fund holdings/NAV spreadsheets — are
// keyless and un-gated, so there is no login handshake. The one non-obvious requirement is a
// browser-like User-Agent; the default fetch UA is rejected with an interstitial HTML page.
//
// TWO transports, because the data is two formats:
//   get(url)      → parsed JSON     (the fund-finder catalog)
//   getBytes(url) → a Uint8Array    (an .xlsx spreadsheet, decoded by the pure driver)
//
// FUND-FINDER CACHE: the ~0.8 MB fund-finder JSON backs `products` and every ticker resolution,
// and changes at most once a day. So the client memoizes just that one URL with a 24 h TTL
// (shared across queries in a long-lived stdio/HTTP process). Spreadsheets always go live. The
// in-flight Promise is cached (not only the resolved value) so concurrent first requests
// coalesce into one fetch; a failed fetch is evicted so the next call retries.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Default fund-finder cache lifetime: 24 hours. */
export const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;

type FetchLike = typeof globalThis.fetch;

/** The injected transports the table functions call: JSON `get` + binary `getBytes`. */
export interface SpdrClient {
  get: (url: string) => Promise<unknown>;
  getBytes: (url: string) => Promise<Uint8Array>;
}

export interface SpdrClientOptions {
  /** Fund-finder cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  catalogCacheMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the injectable `{ get, getBytes }` client. `fetchImpl` defaults to the platform fetch;
 * pass one in for Cloudflare or to stub the network. The fund-finder JSON is memoized for
 * `catalogCacheMs` (default 24 h); spreadsheet byte fetches are never cached.
 */
export function makeSpdrClient(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: SpdrClientOptions = {},
): SpdrClient {
  const ttl = opts.catalogCacheMs ?? CATALOG_CACHE_MS;
  const now = opts.now ?? (() => Date.now());
  let catalog: { at: number; value: Promise<unknown> } | null = null;

  const rawGet = async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`spdr: HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return res.json();
  };

  const get = async (url: string): Promise<unknown> => {
    if (ttl > 0 && url.includes("/fundfinder")) {
      const t = now();
      if (!catalog || t - catalog.at >= ttl) {
        const value = rawGet(url);
        catalog = { at: t, value };
        value.catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
      }
      return catalog.value;
    }
    return rawGet(url);
  };

  const getBytes = async (url: string): Promise<Uint8Array> => {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`spdr: HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  return { get, getBytes };
}
