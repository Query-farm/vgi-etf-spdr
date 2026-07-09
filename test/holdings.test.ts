// Archetype proof for spdr.holdings: the header-driven spreadsheet parser + the xlsx byte
// decode + the DATE-arg converter. SDK-free (imports xlsx, a pure parser, but no @query-farm).

import { test, expect } from "bun:test";
import {
  parseHoldings,
  parseNavHistory,
  readXlsxMatrix,
  fetchHoldings,
  fetchNavHistory,
  dateArgToEpoch,
  holdingsUrl,
  navHistoryUrl,
} from "../src/spdr.js";
import {
  FakeSpdr,
  fundFinderEnvelope,
  equityHoldingsMatrix,
  bondHoldingsMatrix,
  navHistoryMatrix,
  matrixToXlsx,
} from "./fake-spdr.js";

test("holdingsUrl / navHistoryUrl lower-case the ticker into the path", () => {
  expect(holdingsUrl("SPY")).toContain("holdings-daily-us-en-spy.xlsx");
  expect(navHistoryUrl("SPY")).toContain("navhist-us-en-spy.xlsx");
});

test("dateArgToEpoch handles epoch-ms, Date, days-since-epoch, and strings", () => {
  const jan1 = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  expect(dateArgToEpoch(Date.UTC(2026, 0, 1))).toBe(jan1); // epoch ms — what the runtime sends
  expect(dateArgToEpoch(new Date(Date.UTC(2026, 0, 1)))).toBe(jan1);
  expect(dateArgToEpoch(Math.floor(Date.UTC(2026, 0, 1) / 86400000))).toBe(jan1);
  expect(dateArgToEpoch("2026-01-01")).toBe(jan1);
  expect(dateArgToEpoch(null)).toBeNull();
});

test("parseHoldings maps an equity file, sorts by weight desc, and stops at the footer", () => {
  const rows = parseHoldings(equityHoldingsMatrix(), "SPY");
  expect(rows.length).toBe(3); // 3 constituents; the disclaimer footer rows are excluded
  expect(rows.map((r) => r.ticker)).toEqual(["NVDA", "AAPL", "2602335D"]); // weight-descending
  const nvda = rows[0]!;
  expect(nvda.fundTicker).toBe("SPY");
  expect(nvda.name).toBe("NVIDIA CORP");
  expect(nvda.identifier).toBe("67066G104");
  expect(nvda.sedol).toBe("2379504");
  expect(nvda.weightPercent).toBe(7.39);
  expect(nvda.sharesHeld).toBe(293365886);
  expect(nvda.localCurrency).toBe("USD");
  expect(nvda.sector).toBeNull(); // "-" cell
  // equity funds leave the bond-only columns null
  expect(nvda.couponPercent).toBeNull();
  expect(nvda.maturityDate).toBeNull();
  expect(nvda.figi).toBeNull();
  // as-of parsed from the "Holdings:" header row
  expect(nvda.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
});

test("parseHoldings maps a bond file's differently-ordered columns by header", () => {
  const rows = parseHoldings(bondHoldingsMatrix(), "BIL");
  expect(rows.length).toBe(2);
  const b0 = rows[0]!;
  expect(b0.name).toBe("TREASURY BILL 08/26 0.00000");
  expect(b0.identifier).toBe("US912797RG48");
  expect(b0.weightPercent).toBe(12.142225);
  expect(b0.couponPercent).toBe(0);
  expect(b0.parValue).toBe(5638534000);
  expect(b0.marketValue).toBe(5622243542.26);
  expect(b0.maturityDate).toBe(Math.floor(Date.UTC(2026, 7, 6) / 1000));
  // bond funds have no Ticker / Sector / Shares Held columns
  expect(b0.ticker).toBeNull();
  expect(b0.sector).toBeNull();
  expect(b0.sharesHeld).toBeNull();
});

test("parseHoldings returns [] when there is no Name header row", () => {
  expect(parseHoldings([["junk"], []], "X")).toEqual([]);
  expect(parseHoldings([], "X")).toEqual([]);
});

test("readXlsxMatrix round-trips a real .xlsx buffer back to the matrix", () => {
  const matrix = readXlsxMatrix(matrixToXlsx(equityHoldingsMatrix()));
  const rows = parseHoldings(matrix, "SPY");
  expect(rows.length).toBe(3);
  expect(rows[0]!.ticker).toBe("NVDA");
});

test("parseNavHistory maps the daily NAV series and stops at the footer", () => {
  const rows = parseNavHistory(navHistoryMatrix());
  expect(rows.length).toBe(3);
  expect(rows[0]!.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(rows[0]!.nav).toBe(747.704983);
  expect(rows[0]!.sharesOutstanding).toBe(1043282116);
  expect(rows[0]!.totalNetAssets).toBe(780067236411.23);
});

test("parseNavHistory bounds rows by [start, end]", () => {
  const start = Math.floor(Date.UTC(2026, 6, 6) / 1000); // Jul 6 → drops the Jul 2 row
  const rows = parseNavHistory(navHistoryMatrix(), start, null);
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.asOfDate! >= start)).toBe(true);
});

test("fetchHoldings decodes the fund's .xlsx via getBytes (one byte request)", async () => {
  const fake = FakeSpdr.withHoldings(fundFinderEnvelope(), { SPY: equityHoldingsMatrix() });
  const rows = await fetchHoldings(fake.getBytes, "SPY");
  expect(rows.length).toBe(3);
  expect(fake.byteCalls.length).toBe(1);
  expect(fake.byteCalls[0]).toContain("holdings-daily-us-en-spy.xlsx");
});

test("fetchNavHistory decodes the fund's navhist .xlsx via getBytes", async () => {
  const fake = FakeSpdr.withHoldings(fundFinderEnvelope(), {}, { SPY: navHistoryMatrix() });
  const rows = await fetchNavHistory(fake.getBytes, "SPY");
  expect(rows.length).toBe(3);
  expect(fake.byteCalls[0]).toContain("navhist-us-en-spy.xlsx");
});
