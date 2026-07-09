// Cache behavior of the real client's `get`, plus the `getBytes` transport. The client is
// otherwise verified live, but the 24 h fund-finder memoization is pure logic, so it's
// unit-tested here with an injected fetch (call-counting) and an injected clock. No network.

import { test, expect } from "bun:test";
import { makeSpdrClient } from "../src/client.js";
import { FUNDFINDER_URL, holdingsUrl } from "../src/spdr.js";

/** A fake fetch that counts calls and returns a canned JSON body. */
function countingFetch(body: unknown = { ok: 1 }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const HOLDINGS_URL = holdingsUrl("SPY");

test("fund-finder is fetched once then served from cache within the TTL", async () => {
  const { impl, calls } = countingFetch();
  let clock = 1_000_000;
  const { get } = makeSpdrClient(impl, { now: () => clock });
  await get(FUNDFINDER_URL);
  await get(FUNDFINDER_URL);
  clock += 60 * 60 * 1000; // +1 h, still within the 24 h TTL
  await get(FUNDFINDER_URL);
  expect(calls.length).toBe(1);
});

test("fund-finder is refetched after the TTL expires", async () => {
  const { impl, calls } = countingFetch();
  let clock = 0;
  const { get } = makeSpdrClient(impl, { now: () => clock });
  await get(FUNDFINDER_URL);
  clock += 24 * 60 * 60 * 1000 + 1; // just past 24 h
  await get(FUNDFINDER_URL);
  expect(calls.length).toBe(2);
});

test("concurrent first fund-finder requests coalesce into a single fetch", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeSpdrClient(impl);
  await Promise.all([get(FUNDFINDER_URL), get(FUNDFINDER_URL), get(FUNDFINDER_URL)]);
  expect(calls.length).toBe(1);
});

test("catalogCacheMs: 0 disables caching", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeSpdrClient(impl, { catalogCacheMs: 0 });
  await get(FUNDFINDER_URL);
  await get(FUNDFINDER_URL);
  expect(calls.length).toBe(2);
});

test("getBytes returns a Uint8Array and is never cached", async () => {
  const { impl, calls } = countingFetch();
  const { getBytes } = makeSpdrClient(impl);
  const bytes = await getBytes(HOLDINGS_URL);
  expect(bytes).toBeInstanceOf(Uint8Array);
  await getBytes(HOLDINGS_URL);
  expect(calls.length).toBe(2);
});

test("a failed fund-finder fetch is evicted so the next call retries", async () => {
  const calls: string[] = [];
  let failNext = true;
  const impl = (async (url: string) => {
    calls.push(url);
    if (failNext) {
      failNext = false;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const { get } = makeSpdrClient(impl);
  await expect(get(FUNDFINDER_URL)).rejects.toThrow(/HTTP 503/);
  const ok = await get(FUNDFINDER_URL); // cache was evicted → retries and succeeds
  expect(ok).toEqual({ ok: 1 });
  expect(calls.length).toBe(2);
});
