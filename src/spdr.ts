// The SPDR / State Street (SSGA) driver — pure logic, no @query-farm SDK import. Every
// fetch* takes an injected `get(url) => Promise<any>` (JSON) and/or `getBytes(url) =>
// Promise<Uint8Array>` (binary spreadsheet), so the archetype-proof tests drive it against an
// in-process fake and the worker wires the real HTTP client (client.ts). This module MUST NOT
// import from @query-farm/* — the unit tests import it without the SDK installed.
//
// Two KEYLESS SSGA data planes back the read paths:
//
//   /bin/v1/ssmp/fund/fundfinder          → products   (one JSON object listing ~180 US ETFs,
//                                                        each ~35 fields)
//   .../holdings-daily-us-en-<ticker>.xlsx → holdings   (a per-fund daily-holdings spreadsheet)
//   .../navhist-us-en-<ticker>.xlsx        → nav_history (a per-fund daily NAV spreadsheet)
//
// The fund-finder scalar fields come as either a bare value or a [display, raw] PAIR (e.g.
// nav: ["$82.22", 82.22]); the "no data" sentinel is the string "-" (its paired raw is a
// garbage denormal, so we key off the display). `pairDisp()` reads the display string,
// `pairNum()` the raw number, `pairDate()` an ISO YYYY-MM-DD date → epoch seconds.
//
// The holdings/NAV spreadsheets are read (in client/worker) into a matrix of rows (array of
// arrays) via SheetJS; the pure parsers here take that matrix. Their COLUMN LAYOUT VARIES by
// fund type (equity funds carry Ticker/Sector/Shares Held; bond funds carry Coupon/Maturity/
// Par Value/Market Value; loan funds carry FIGI), so the parsers are HEADER-DRIVEN: they find
// the header row and map each column by its header label rather than by a fixed position.
//
// Every parser is defensive: a missing field / column / row degrades to an empty result or a
// null cell rather than throwing. `resolveTicker` returns null (not a throw) on an unknown
// ticker so the caller (functions.ts) can raise a typed SDK error while this module stays
// SDK-free.
//
// DATES: the driver returns dates as epoch SECONDS at UTC midnight (number | null). The Arrow
// mapping to a real DATE column lives in schema.ts (keeping this module type/SDK-free).

import * as XLSX from "xlsx";

export const SSGA_HOST = "https://www.ssga.com";

/** The US ETF fund-finder: one JSON object listing every SPDR / State Street US ETF. */
export const FUNDFINDER_URL =
  `${SSGA_HOST}/bin/v1/ssmp/fund/fundfinder` +
  `?country=us&language=en&role=intermediary&product=etfs&ui=fund-finder`;

/** The daily-holdings spreadsheet URL for a fund (ticker is lower-cased into the path). */
export function holdingsUrl(ticker: string): string {
  return `${SSGA_HOST}/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${ticker
    .trim()
    .toLowerCase()}.xlsx`;
}

/** The daily NAV-history spreadsheet URL for a fund (ticker is lower-cased into the path). */
export function navHistoryUrl(ticker: string): string {
  return `${SSGA_HOST}/library-content/products/fund-data/etfs/us/navhist-us-en-${ticker
    .trim()
    .toLowerCase()}.xlsx`;
}

// ── shared value coercion (fund-finder JSON) ───────────────────────────────────

/** True for SSGA's "no data" sentinels: null, "", "-", or all-whitespace. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t === "-";
  }
  return false;
}

/** The raw scalar of a fund-finder field: element [1] of a [display, raw] pair, else the value. */
function rawOf(v: unknown): unknown {
  return Array.isArray(v) ? v[1] : v;
}

/** The display of a fund-finder field: element [0] of a pair, else the value. */
function dispOf(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** The display string for a fund-finder field (bare or a [display, raw] pair). Null if blank. */
export function pairDisp(v: unknown): string | null {
  const d = dispOf(v);
  return isBlank(d) ? null : String(d).trim();
}

/**
 * The numeric value for a fund-finder field. Null when the DISPLAY is a "no data" sentinel
 * (SSGA pairs a "-" display with a garbage denormal raw, so the display is the source of truth).
 */
export function pairNum(v: unknown): number | null {
  if (isBlank(dispOf(v))) return null;
  const raw = rawOf(v);
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.replace(/[$,%\s]/g, ""))
        : NaN;
  return Number.isFinite(n) ? n : null;
}

// ── date parsing ────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Build epoch SECONDS at UTC midnight from y/m/d, validating the parts round-trip. Null if bad. */
function ymdToEpoch(y: number, mo0: number, d: number): number | null {
  const ms = Date.UTC(y, mo0, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo0 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/**
 * Parse the date shapes SSGA uses → epoch SECONDS at UTC midnight (or null):
 *   ISO           "2026-07-07"      (fund-finder raw)
 *   day-mon-year  "07-Jul-2026"     (spreadsheet "As of" and NAV Date cells)
 *   US slash      "08/06/2026"      (holdings Maturity cells, MM/DD/YYYY)
 */
export function parseDate(v: unknown): number | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return ymdToEpoch(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return ymdToEpoch(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    if (mo == null) return null;
    return ymdToEpoch(Number(m[3]), mo, Number(m[1]));
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return ymdToEpoch(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

/** Strip the "As of " prefix from a spreadsheet header cell, then parse the date. */
function parseAsOf(v: unknown): number | null {
  if (v == null) return null;
  return parseDate(String(v).replace(/^\s*As of\s*/i, "").trim());
}

// ── DATE-typed function arguments ──────────────────────────────────────────────
//
// Date args on the table functions are real SQL DATE (Arrow Date32), so DuckDB parses and
// type-checks the literal and the SDK hands us a number of epoch MILLISECONDS. This converter
// also accepts a JS Date, a bigint, a days-since-epoch number, or a YYYY-MM-DD string so it is
// robust to the representation.

/** A DATE arg → epoch SECONDS at UTC midnight, or null when absent/invalid. */
export function dateArgToEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") return parseDate(v.trim());
  let ms: number;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "bigint") ms = Number(v);
  else if (typeof v === "number" && Number.isFinite(v)) {
    // Disambiguate by magnitude: >= 1e11 is epoch milliseconds; smaller is days-since-epoch.
    ms = Math.abs(v) >= 1e11 ? v : v * 86400000;
  } else return null;
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000) * 86400;
}

// ── products (the fund-finder catalog) ─────────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  fundName: string | null;
  assetClass: string | null;
  isin: string | null;
  cusip: string | null;
  primaryExchange: string | null;
  domicile: string | null;
  inceptionDate: number | null;
  asOfDate: number | null;
  nav: number | null;
  netAssets: number | null;
  closePrice: number | null;
  bidAskMid: number | null;
  premiumDiscountPercent: number | null;
  expenseRatioPercent: number | null;
  performanceAsOf: number | null;
  return1mPercent: number | null;
  returnQtdPercent: number | null;
  ytdReturnPercent: number | null;
  return1yPercent: number | null;
  return3yPercent: number | null;
  return5yPercent: number | null;
  return10yPercent: number | null;
  returnSinceInceptionPercent: number | null;
  productPageUrl: string | null;
}

/** Reach the array of fund records inside the fund-finder envelope, or []. */
function fundFinderRecords(json: unknown): Record<string, unknown>[] {
  const datas = (json as any)?.data?.funds?.etfs?.datas;
  return Array.isArray(datas) ? (datas as Record<string, unknown>[]) : [];
}

/**
 * Map ticker → asset-class name from the fund-finder `categories` tree. The top-level
 * `assetclass` category's direct sub-categories carry the human name and a pipe-delimited
 * `funds` list; a trailing " Sector" is trimmed (e.g. "Fixed Income Sector" → "Fixed Income").
 */
export function assetClassMap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const cats = (json as any)?.data?.funds?.etfs?.categories;
  if (!Array.isArray(cats)) return out;
  const ac = cats.find((c: any) => c?.key === "assetclass");
  const subs = Array.isArray(ac?.subCategories) ? ac.subCategories : [];
  for (const sc of subs) {
    const name = typeof sc?.name === "string" ? sc.name.replace(/\s+Sector$/i, "").trim() : null;
    const funds = typeof sc?.funds === "string" ? sc.funds : "";
    if (!name || !funds) continue;
    for (const t of funds.split("|")) if (t) out.set(t.toUpperCase(), name);
  }
  return out;
}

/**
 * Pull the ISIN and CUSIP out of a fund's comma-separated `keywords` string. The list mixes
 * fund name, ticker(s) and identifiers positionally, so we match by SHAPE: a 12-char ISIN
 * (2 letters + 10 alphanumerics) and a 9-char CUSIP (distinct from the ISIN's leading 9).
 */
export function idsFromKeywords(keywords: unknown): { isin: string | null; cusip: string | null } {
  if (typeof keywords !== "string") return { isin: null, cusip: null };
  const parts = keywords.split(",").map((p) => p.trim());
  const isin = parts.find((p) => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(p)) ?? null;
  const cusip =
    parts.find((p) => /^[A-Z0-9]{9}$/.test(p) && p !== (isin ?? "").slice(0, 9)) ?? null;
  return { isin, cusip };
}

/**
 * Map the fund-finder envelope to product rows. `ticker`, when non-empty, narrows to that one
 * fund (case-insensitive). AUM is reported in millions, so it is scaled to whole dollars.
 */
export function parseProducts(json: unknown, ticker = ""): ProductRow[] {
  const records = fundFinderRecords(json);
  if (records.length === 0) return [];
  const classes = assetClassMap(json);
  const wantTicker = ticker.trim().toUpperCase();
  const rows: ProductRow[] = [];
  for (const p of records) {
    const tk = pairDisp(p.fundFilter) ?? pairDisp(p.fundTicker);
    if (!tk) continue;
    if (wantTicker && tk.toUpperCase() !== wantTicker) continue;
    const { isin, cusip } = idsFromKeywords(p.keywords);
    const aumMillions = pairNum(p.aum);
    rows.push({
      ticker: tk,
      fundName: pairDisp(p.fundName),
      assetClass: classes.get(tk.toUpperCase()) ?? null,
      isin,
      cusip,
      primaryExchange: pairDisp(p.primaryExchange),
      domicile: pairDisp(p.domicile),
      inceptionDate: parseDate(rawOf(p.inceptionDate)),
      asOfDate: parseDate(rawOf(p.asOfDate)),
      nav: pairNum(p.nav),
      netAssets: aumMillions == null ? null : aumMillions * 1e6,
      closePrice: pairNum(p.closePrice),
      bidAskMid: pairNum(p.bidAsk),
      premiumDiscountPercent: pairNum(p.premiumDiscount),
      expenseRatioPercent: pairNum(p.ter),
      performanceAsOf: parseDate(rawOf(p.PerfAsOf)),
      return1mPercent: pairNum(p.mo1),
      returnQtdPercent: pairNum(p.qtd),
      ytdReturnPercent: pairNum(p.ytd),
      return1yPercent: pairNum(p.yr1),
      return3yPercent: pairNum(p.yr3),
      return5yPercent: pairNum(p.yr5),
      return10yPercent: pairNum(p.yr10),
      returnSinceInceptionPercent: pairNum(p.sinceInception),
      productPageUrl: pairDisp(p.fundUri),
    });
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(await get(FUNDFINDER_URL), ticker);
}

// ── ticker resolution (validate + canonicalize against the catalog) ─────────────

/**
 * Resolve a `fund` argument to a fund's canonical ticker by matching the catalog
 * (case-insensitive). Returns null when the ticker isn't in the SPDR lineup (the caller raises
 * a typed ArgumentValidationError — this module stays SDK-free). One fund-finder fetch.
 */
export async function resolveTicker(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<string | null> {
  const wanted = fund.trim().toUpperCase();
  if (!wanted) return null;
  const products = parseProducts(await get(FUNDFINDER_URL));
  const hit = products.find((p) => (p.ticker ?? "").toUpperCase() === wanted);
  return hit ? hit.ticker : null;
}

// ── spreadsheet decoding (the only XLSX touch) ─────────────────────────────────

/** Decode an .xlsx byte buffer into a matrix of rows (array of cell arrays), first sheet. */
export function readXlsxMatrix(bytes: Uint8Array): unknown[][] {
  const wb = XLSX.read(bytes, { type: "array" });
  const first = wb.SheetNames[0];
  if (!first) return [];
  const ws = wb.Sheets[first];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: true }) as unknown[][];
}

// ── shared matrix helpers (header-driven parsing) ──────────────────────────────

const asStr = (v: unknown): string | null => (isBlank(v) ? null : String(v).trim());
const asNum = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** The cell in row at column `col`, or undefined. */
function at(row: unknown[], col: number | undefined): unknown {
  return col == null ? undefined : row[col];
}

/** Look up the value of a labelled header cell (e.g. "Fund Name:") by scanning column A. */
function labelled(matrix: unknown[][], label: string): unknown {
  for (const row of matrix) {
    if (asStr(row[0])?.toLowerCase() === label.toLowerCase()) return row[1];
  }
  return null;
}

/** Find the header row's index (the first row whose first cell equals `first`), or -1. */
function headerRowIndex(matrix: unknown[][], first: string): number {
  for (let i = 0; i < matrix.length; i++) {
    if (asStr(matrix[i]?.[0])?.toLowerCase() === first.toLowerCase()) return i;
  }
  return -1;
}

/** Map normalized header label → column index for the header row at `hdr`. */
function columnMap(matrix: unknown[][], hdr: number): Map<string, number> {
  const map = new Map<string, number>();
  const row = matrix[hdr] ?? [];
  for (let c = 0; c < row.length; c++) {
    const name = asStr(row[c]);
    if (name) map.set(name.toLowerCase(), c);
  }
  return map;
}

// ── holdings (the daily-holdings spreadsheet) ──────────────────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  name: string | null;
  /** Constituent ticker (equity funds only; absent for bond/loan funds). */
  ticker: string | null;
  /** Constituent identifier — CUSIP for equities, ISIN for bonds (as SSGA reports it). */
  identifier: string | null;
  sedol: string | null;
  figi: string | null;
  weightPercent: number | null;
  sector: string | null;
  sharesHeld: number | null;
  couponPercent: number | null;
  parValue: number | null;
  marketValue: number | null;
  maturityDate: number | null;
  localCurrency: string | null;
}

/**
 * Parse a holdings spreadsheet matrix into holding rows, sorted by weight desc (NULLS last).
 * Header-driven: reads the fund name / as-of date from the top labelled rows, finds the "Name"
 * header row, then maps each constituent column by its header label (the column set varies by
 * fund type). Data rows run until the first blank row / blank name (the disclaimer footer).
 */
export function parseHoldings(matrix: unknown[][], fundTicker: string | null): HoldingRow[] {
  const hdr = headerRowIndex(matrix, "Name");
  if (hdr < 0) return [];
  const cols = columnMap(matrix, hdr);
  const asOf = parseAsOf(labelled(matrix, "Holdings:"));
  const c = (label: string) => cols.get(label);
  const nameCol = c("name");
  const rows: HoldingRow[] = [];
  for (let i = hdr + 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const name = asStr(at(row, nameCol));
    if (name == null) break; // blank row → end of holdings (footer follows)
    rows.push({
      fundTicker,
      asOfDate: asOf,
      name,
      ticker: asStr(at(row, c("ticker"))),
      identifier: asStr(at(row, c("identifier"))),
      sedol: asStr(at(row, c("sedol"))),
      figi: asStr(at(row, c("figi"))),
      weightPercent: asNum(at(row, c("weight"))),
      sector: asStr(at(row, c("sector"))),
      sharesHeld: asNum(at(row, c("shares held"))),
      couponPercent: asNum(at(row, c("coupon"))),
      parValue: asNum(at(row, c("par value"))),
      marketValue: asNum(at(row, c("market value"))),
      maturityDate: parseDate(at(row, c("maturity"))),
      localCurrency: asStr(at(row, c("local currency"))),
    });
  }
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/**
 * Detailed holdings for one fund (the latest daily file — SSDR publishes current holdings only,
 * so there is no as-of/time-travel coordinate). Returns [] for a fund with no holdings file.
 */
export async function fetchHoldings(
  getBytes: (url: string) => Promise<Uint8Array>,
  fundTicker: string,
): Promise<HoldingRow[]> {
  const bytes = await getBytes(holdingsUrl(fundTicker));
  return parseHoldings(readXlsxMatrix(bytes), fundTicker.toUpperCase());
}

// ── nav_history (the daily NAV spreadsheet) ────────────────────────────────────

export interface NavHistoryRow {
  asOfDate: number | null;
  nav: number | null;
  sharesOutstanding: number | null;
  totalNetAssets: number | null;
}

/**
 * Parse a NAV-history spreadsheet matrix into daily rows, optionally bounded to [startSec,
 * endSec] by date. Header-driven off the "Date" header row.
 */
export function parseNavHistory(
  matrix: unknown[][],
  startSec: number | null = null,
  endSec: number | null = null,
): NavHistoryRow[] {
  const hdr = headerRowIndex(matrix, "Date");
  if (hdr < 0) return [];
  const cols = columnMap(matrix, hdr);
  const c = (label: string) => cols.get(label);
  const dateCol = c("date");
  const rows: NavHistoryRow[] = [];
  for (let i = hdr + 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const asOfDate = parseDate(at(row, dateCol));
    if (asOfDate == null) {
      if (isBlank(at(row, dateCol))) break; // blank row → end of series
      continue; // an unparseable date row — skip it defensively
    }
    if (startSec != null && asOfDate < startSec) continue;
    if (endSec != null && asOfDate > endSec) continue;
    rows.push({
      asOfDate,
      nav: asNum(at(row, c("nav"))),
      sharesOutstanding: asNum(at(row, c("shares outstanding"))),
      totalNetAssets: asNum(at(row, c("total net assets"))),
    });
  }
  return rows;
}

export async function fetchNavHistory(
  getBytes: (url: string) => Promise<Uint8Array>,
  fundTicker: string,
  startSec: number | null = null,
  endSec: number | null = null,
): Promise<NavHistoryRow[]> {
  const bytes = await getBytes(navHistoryUrl(fundTicker));
  return parseNavHistory(readXlsxMatrix(bytes), startSec, endSec);
}
