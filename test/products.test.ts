// Archetype proof for spdr.products: the fund-finder driver. Imports ONLY our own src + the
// fake — NO @query-farm/* — so it runs without the SDK installed. Proves [display, raw] and
// sentinel coercion, keyword ISIN/CUSIP extraction, the categories asset-class map, ticker
// resolution, and the fund-finder URL contract.

import { test, expect } from "bun:test";
import {
  parseProducts,
  fetchProducts,
  resolveTicker,
  assetClassMap,
  idsFromKeywords,
  pairNum,
  pairDisp,
  parseDate,
  FUNDFINDER_URL,
} from "../src/spdr.js";
import { FakeSpdr, fundFinderEnvelope } from "./fake-spdr.js";

test("pairNum reads [display, raw] pairs, numeric strings, and nulls sentinels", () => {
  expect(pairNum(["0.09%", 0.0945])).toBe(0.0945);
  expect(pairNum("1,182.5")).toBe(1182.5);
  expect(pairNum(["-", -5e-324])).toBeNull(); // sentinel display → null, not the garbage raw
  expect(pairNum("-")).toBeNull();
  expect(pairNum(null)).toBeNull();
});

test("pairDisp reads display strings and nulls sentinels", () => {
  expect(pairDisp(["$747.70", 747.7])).toBe("$747.70");
  expect(pairDisp("NYSE ARCA")).toBe("NYSE ARCA");
  expect(pairDisp("-")).toBeNull();
  expect(pairDisp(" ")).toBeNull();
});

test("parseDate handles ISO, day-mon-year, and US-slash forms", () => {
  const jul7 = Math.floor(Date.UTC(2026, 6, 7) / 1000);
  expect(parseDate("2026-07-07")).toBe(jul7);
  expect(parseDate("07-Jul-2026")).toBe(jul7);
  expect(parseDate("08/06/2026")).toBe(Math.floor(Date.UTC(2026, 7, 6) / 1000));
  expect(parseDate("-")).toBeNull();
  expect(parseDate("garbage")).toBeNull();
});

test("idsFromKeywords extracts the ISIN and CUSIP by shape", () => {
  const { isin, cusip } = idsFromKeywords("State Street® SPDR® S&P 500® ETF Trust, SPY, Equity, SPY US, US78462F1030, 78462F103, Core");
  expect(isin).toBe("US78462F1030");
  expect(cusip).toBe("78462F103");
  expect(idsFromKeywords(null)).toEqual({ isin: null, cusip: null });
});

test("assetClassMap maps ticker → asset class from the categories tree (trims ' Sector')", () => {
  const m = assetClassMap(fundFinderEnvelope());
  expect(m.get("SPY")).toBe("Equity");
  expect(m.get("BIL")).toBe("Fixed Income"); // "Fixed Income Sector" → "Fixed Income"
});

test("parseProducts maps the fund-finder records to product rows", () => {
  const rows = parseProducts(fundFinderEnvelope());
  expect(rows.length).toBe(2);
  const spy = rows.find((r) => r.ticker === "SPY")!;
  expect(spy.fundName).toBe("State Street® SPDR® S&P 500® ETF Trust");
  expect(spy.assetClass).toBe("Equity");
  expect(spy.isin).toBe("US78462F1030");
  expect(spy.cusip).toBe("78462F103");
  expect(spy.expenseRatioPercent).toBe(0.0945);
  expect(spy.nav).toBe(747.704983);
  expect(spy.netAssets).toBe(780067.24 * 1e6); // AUM millions → dollars
  expect(spy.return10yPercent).toBeNull(); // "-" sentinel
  expect(spy.returnSinceInceptionPercent).toBe(9.5);
  expect(spy.inceptionDate).toBe(Math.floor(Date.UTC(1993, 0, 22) / 1000));
  expect(spy.primaryExchange).toBe("NYSE ARCA");
});

test("parseProducts narrows to a single ticker (case-insensitive)", () => {
  const one = parseProducts(fundFinderEnvelope(), "spy");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("SPY");
  expect(parseProducts(fundFinderEnvelope(), "ZZZZ")).toEqual([]);
});

test("parseProducts tolerates junk without throwing", () => {
  expect(parseProducts(null)).toEqual([]);
  expect(parseProducts({ x: 1 })).toEqual([]);
  expect(parseProducts({ data: { funds: { etfs: { datas: [] } } } })).toEqual([]);
});

test("fetchProducts hits the fund-finder URL once", async () => {
  const fake = new FakeSpdr(() => fundFinderEnvelope());
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toBe(FUNDFINDER_URL);
});

test("resolveTicker canonicalizes a ticker and returns null on a miss", async () => {
  const fake = new FakeSpdr(() => fundFinderEnvelope());
  expect(await resolveTicker(fake.get, "spy")).toBe("SPY");
  expect(await resolveTicker(fake.get, "ZZZZ")).toBeNull();
});
