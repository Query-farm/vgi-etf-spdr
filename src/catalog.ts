// The `spdr` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). SSGA's public fund-finder / holdings endpoints are KEYLESS, so there is
// NO secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (spdr.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-spdr";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. SPY).",
  fund_name: "Full fund name as marketed, e.g. 'State Street® SPDR® S&P 500® ETF Trust'.",
  asset_class: "Asset class (Equity, Fixed Income, Alternative, Multi-Asset, Cash).",
  isin: "ISIN identifier.",
  cusip: "CUSIP identifier.",
  primary_exchange: "Primary listing exchange.",
  domicile: "Fund domicile (US).",
  inception_date: "Fund inception date.",
  as_of_date: "As-of date for the pricing fields (nav, close_price, aum).",
  nav: "Net asset value per share, in USD.",
  net_assets: "Total net assets (fund AUM) in USD.",
  close_price: "Latest market closing price, per share in USD.",
  bid_ask_mid: "Bid/ask midpoint price, per share in USD.",
  premium_discount_percent: "Close vs NAV, percent points.",
  expense_ratio_percent: "Gross expense ratio, percent points (0.09 = 0.09%).",
  performance_as_of: "As-of date for the return columns.",
  return_1m_percent: "1-month cumulative return, percent points.",
  return_qtd_percent: "Quarter-to-date cumulative return, percent points.",
  ytd_return_percent: "Year-to-date cumulative return, percent points.",
  return_1y_percent: "Annualized 1-year return, percent points.",
  return_3y_percent: "Annualized 3-year return, percent points.",
  return_5y_percent: "Annualized 5-year return, percent points.",
  return_10y_percent: "Annualized 10-year return, percent points.",
  return_since_inception_percent: "Annualized since-inception return, percent points.",
  product_page_url: "Path to the fund page on ssga.com.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "fund finder",
    "expense ratio",
    "net assets",
    "ticker",
  ]),
  "vgi.doc_llm":
    "The SPDR / State Street US ETF catalog as a plain table (query it directly, no arguments): " +
    "one row per ETF with ticker, name, asset class, identifiers, net assets, NAV, expense ratio, " +
    "and cumulative/annualized returns. Narrow it with a WHERE clause on ticker, asset_class, and " +
    "so on. Percent columns hold percent points (0.09 means 0.09%). Start here to find a fund's " +
    "ticker for the other functions.",
  "vgi.doc_md":
    "## products\n\n" +
    "The SPDR / State Street US ETF catalog as a base table — one row per fund. It takes no " +
    "arguments; query it directly and filter with a WHERE clause (e.g. `WHERE asset_class = " +
    "'Equity' ORDER BY net_assets DESC`; see the example queries). Percent columns (`*_percent`) " +
    "are in **percent points** (an expense ratio of 0.09 means 0.09%). The ticker column is the " +
    "key for the other functions.",
  "vgi.example_queries": JSON.stringify([
    { description: "Ten largest SPDR ETFs by net assets", sql: "SELECT ticker, fund_name, net_assets FROM spdr.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Cheapest equity ETFs by expense ratio", sql: "SELECT ticker, fund_name, expense_ratio_percent FROM spdr.main.products WHERE asset_class = 'Equity' ORDER BY expense_ratio_percent LIMIT 10" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, fund_name, expense_ratio_percent FROM spdr.main.products WHERE ticker = 'SPY'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. SPY) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "Holdings as-of date (the published file's own date; current holdings only).",
  name: "Constituent / issue name.",
  ticker: "Constituent ticker (equity funds; absent for bond/loan funds).",
  identifier: "Constituent identifier — CUSIP for equities, ISIN for bonds.",
  sedol: "Constituent SEDOL.",
  figi: "Constituent FIGI (loan funds).",
  weight_percent: "Percent of the fund, 0–100 (7.38 = 7.38%; weights sum to ~100).",
  sector: "GICS-style sector (equity funds).",
  shares_held: "Shares held (equity funds).",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  par_value: "Par value held (fixed income only).",
  market_value: "Market value held, in the fund's currency (fixed income only).",
  maturity_date: "Maturity date (fixed income only).",
  local_currency: "Local currency of the holding.",
};

/** Table-level metadata for the holdings base table (ticker-partitioned, current holdings). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed portfolio holdings for SPDR / State Street ETFs as a hive-partitioned table. It is " +
    "partitioned by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` " +
    "column): filter `WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan " +
    "with no filter to stream EVERY fund's holdings (~180 funds — slow, so prefer a filter). SSGA " +
    "publishes CURRENT holdings only, so there is no historical as-of date; as_of_date is the " +
    "published file's own date. Rows come back weight-descending; weight_percent is in percent " +
    "points (7.38 = 7.38%). Equity funds fill ticker/sector/shares_held; bond funds fill " +
    "coupon/maturity/par_value/market_value. Join on fund_ticker to products.ticker for " +
    "fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed fund holdings as a **hive-partitioned table**, partitioned by `fund_ticker` (the " +
    "fund's ticker). `fund_ticker` is distinct from `ticker` (the constituent's own ticker). " +
    "Filter `WHERE fund_ticker = 'SPY'` for one fund's holdings (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('SPY','BIL')` fans out per partition; an unfiltered scan streams every " +
    "fund (~180 partitions — slow). SSGA publishes **current holdings only** (no historical " +
    "dates). `weight_percent` is in percent points (7.38 = 7.38%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of SPY", sql: "SELECT name, ticker, weight_percent FROM spdr.main.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "A bond fund fills coupon / maturity / par value", sql: "SELECT name, coupon_percent, maturity_date, par_value FROM spdr.main.holdings WHERE fund_ticker = 'BIL' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, name, weight_percent FROM spdr.main.holdings WHERE fund_ticker IN ('SPY', 'BIL')" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "SPDR ETFs",
  "vgi.doc_llm":
    "SPDR / State Street (SSGA) US ETF data as SQL tables and a table function. Reach for it to " +
    "screen the ETF lineup on key facts (net assets, expense ratio, returns), to inspect what a " +
    "fund currently holds, and to pull a fund's daily NAV history. The central concept is the " +
    "fund, identified by its exchange ticker (e.g. SPY); start from the catalog to find that key, " +
    "then drill into a specific fund. Data is SSGA's public fund feed: best-effort, for " +
    "informational use.",
  "vgi.doc_md":
    "## SPDR ETFs\n\n" +
    "SPDR / State Street (SSGA) US ETF data, exposed as DuckDB tables and a table function.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `SPY`) — " +
    "begin at the catalog to discover that key, then drill into a fund's holdings or NAV history. " +
    "Holdings are the current published portfolio (SSGA does not publish historical holdings).\n\n" +
    "Data is provided for informational use; review SSGA's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "SPDR",
    "State Street",
    "SSGA",
    "holdings",
    "portfolio",
    "fund",
    "NAV",
    "expense ratio",
    "index fund",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No
  // expected_result — SSGA data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "largest_etfs",
      description: "The largest SPDR ETFs by net assets",
      sql: "SELECT ticker, fund_name, net_assets FROM spdr.main.products ORDER BY net_assets DESC LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the SPDR S&P 500 ETF Trust",
      sql: "SELECT name, ticker, weight_percent FROM spdr.main.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is deliberately omitted (live data). One task
  // per callable surface (products, holdings, nav_history) satisfies VGI520.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "spy_exists",
      prompt: "Does SPDR offer an ETF with the ticker SPY, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM spdr.main.products WHERE ticker = 'SPY'",
      success_criteria: "The answer confirms SPY is the SPDR S&P 500 ETF Trust, found via the products table.",
    },
    {
      name: "spy_expense_ratio",
      prompt: "What is the expense ratio of the SPDR S&P 500 ETF Trust (SPY)?",
      check_sql: "SELECT count(*) > 0 FROM spdr.main.products WHERE ticker = 'SPY' AND expense_ratio_percent IS NOT NULL",
      success_criteria: "The answer reports SPY's gross expense ratio (a small percentage) from the products table.",
    },
    {
      name: "spy_top_holding",
      prompt: "What is the single largest holding of the SPDR S&P 500 ETF Trust (SPY) right now?",
      check_sql: "SELECT count(*) > 0 FROM spdr.main.holdings WHERE fund_ticker = 'SPY'",
      success_criteria: "The answer names SPY's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "spy_bil_position_counts",
      prompt: "How many distinct holdings does the SPDR S&P 500 ETF Trust (SPY) currently have, and does it hold more positions than the SPDR Bloomberg 1-3 Month T-Bill ETF (BIL)?",
      check_sql: "SELECT (SELECT count(*) FROM spdr.main.holdings WHERE fund_ticker = 'SPY') > (SELECT count(*) FROM spdr.main.holdings WHERE fund_ticker = 'BIL')",
      success_criteria: "The answer reports SPY's holding count and correctly states SPY holds more positions than BIL, using the holdings table filtered by fund_ticker.",
    },
    {
      name: "spy_recent_nav",
      prompt: "What was the SPDR S&P 500 ETF Trust's (SPY) net asset value on its most recent valuation date?",
      check_sql: "SELECT count(*) > 0 FROM spdr.main.nav_history('SPY') WHERE nav > 0",
      success_criteria: "The answer reports a recent SPY NAV per share, obtained from the nav_history function.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "SPDR Fund Data",
  "vgi.doc_llm":
    "Functions that return SPDR / State Street ETF data at two levels. At the catalog level you " +
    "screen the whole lineup on key facts and resolve a fund's key. At the fund level you drill " +
    "into one fund — its current holdings and its daily NAV history. A fund is keyed by its " +
    "exchange `ticker` (e.g. `SPY`); resolve the key at the catalog level first.",
  "vgi.doc_md":
    "## SPDR fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts and find a " +
    "fund's key. **Fund level:** drill into a single fund — its constituents and its NAV time " +
    "series. A fund is keyed by its exchange `ticker` (e.g. `SPY`).\n\n" +
    "Holdings are the current published portfolio; SSGA does not publish historical holdings.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "NAV history", "portfolio", "SPDR"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF product list and per-fund key facts." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
    { name: "history", title: "History", description: "Per-fund daily NAV time series." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Ten largest SPDR ETFs by net assets", sql: "SELECT ticker, fund_name, net_assets FROM spdr.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Top holdings of SPY", sql: "SELECT name, ticker, weight_percent FROM spdr.main.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Recent daily NAV history for SPY", sql: "SELECT as_of_date, nav FROM spdr.main.nav_history('SPY', start_date := DATE '2026-01-01') ORDER BY as_of_date DESC" },
  ]),
};

/**
 * @param functions    the callable table functions (nav_history) — NOT products or holdings,
 *                      which are base tables.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables (except that
 * holdingsScan is also LISTED so the extension can push the fund_ticker filter into it).
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "spdr",
    defaultSchema: "main",
    comment:
      "SPDR / State Street (SSGA) US ETF data as DuckDB tables: products (catalog) & holdings " +
      "(ticker-partitioned) tables, plus nav_history — vgi-etf-spdr",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "SPDR fund data: ETF catalog, detailed current holdings, and per-fund NAV history.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund has a unique ISIN (advisory — not enforced on scan).
            primaryKey: [["isin"]],
            // The SPDR US ETF lineup is ~180 funds; headroom to ~300.
            inlinedCardinality: { estimate: 180n, max: 300n },
            comment:
              "Every SPDR / State Street US ETF with its key facts, one row per fund. Query " +
              "directly (no arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // fund_ticker is always populated (the scan tags every row with its fund); name is
            // always populated too (the parser ends the fund's rows at the first blank name).
            notNull: ["fund_ticker", "name"],
            // A holding is identified by its fund plus the constituent's name: within one fund's
            // current file each constituent appears on one line, so (fund_ticker, name) is the
            // natural key. Advisory (like products.isin) — not enforced on the streaming scan.
            primaryKey: [["fund_ticker", "name"]],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all partitions).
            // SSGA publishes current holdings only, so there is NO time travel.
            // Whole-table estimate: ~180 funds × ~500 constituents each. A single-fund filter
            // scans one partition (~500 rows); a loan fund like SRLN can reach ~800.
            inlinedCardinality: { estimate: 90000n, max: 400000n },
            comment:
              "Detailed current fund holdings, hive-partitioned by fund_ticker (filter WHERE " +
              "fund_ticker = … for one fund, or scan unfiltered for all). SSGA publishes current " +
              "holdings only (no historical dates).",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}
