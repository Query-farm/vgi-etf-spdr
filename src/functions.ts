// The VGI surfaces: the products & holdings base-table backing scans plus the nav_history
// table function. All keyless. The products / nav_history states are just a `done` flag (fully
// serializable — no socket / batch / Date), so the HTTP transport can round-trip them; the
// holdings scan streams via a BoundStorage work queue. The SSGA client is injected so worker.ts
// wires the real fetch and tests wire a fake.

import {
  defineTableFunction,
  ArgumentValidationError,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8, DateDay } from "@query-farm/apache-arrow";
import {
  fetchProducts,
  fetchHoldings,
  fetchNavHistory,
  resolveTicker,
  dateArgToEpoch,
} from "./spdr.js";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  navHistorySchema,
  navHistoryBatch,
  resultColumnsSchema,
} from "./schema.js";
import type { SpdrClient } from "./client.js";

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from each Arrow schema via resultColumnsSchema).

const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter.",
  as_of_date: "The holdings as-of date (the file's own publication date).",
  name: "Constituent / issue name.",
  ticker: "Constituent ticker (equity funds; absent for bond/loan funds).",
  identifier: "Constituent identifier — CUSIP for equities, ISIN for bonds.",
  sedol: "Constituent SEDOL.",
  figi: "Constituent FIGI (loan funds).",
  weight_percent: "Percent of the fund, 0–100 (7.38 = 7.38%).",
  sector: "GICS-style sector (equity funds).",
  shares_held: "Shares held (equity funds).",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  par_value: "Par value held (fixed income only).",
  market_value: "Market value held, in the fund's currency (fixed income only).",
  maturity_date: "Maturity date (fixed income only).",
  local_currency: "Local currency of the holding.",
};

const NAV_HISTORY_DESCS: Record<string, string> = {
  as_of_date: "Valuation date.",
  nav: "Net asset value per share.",
  shares_outstanding: "Shares outstanding.",
  total_net_assets: "Total net assets (fund AUM) in the fund's currency.",
};

interface DoneState {
  done: boolean;
}

/** Guard a required string argument; returns the trimmed value or throws ArgumentValidationError. */
function required(fn: string, name: string, v: unknown): string {
  if (v == null || String(v).trim() === "") {
    throw new ArgumentValidationError(`${fn}: ${name} is required`);
  }
  return String(v).trim();
}

/** Resolve a `fund` arg to a canonical ticker, raising a typed, discoverable error on a miss. */
async function resolveOrThrow(fn: string, client: SpdrClient, fund: string): Promise<string> {
  const t = await resolveTicker(client.get, fund);
  if (t == null) {
    throw new ArgumentValidationError(
      `${fn}: could not resolve fund '${fund}'. Pass an SPDR exchange ticker (e.g. 'SPY'); ` +
        `list valid tickers with SELECT ticker FROM spdr.main.products.`,
    );
  }
  return t;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its exchange ticker (the partition value). */
interface FundItem {
  ticker: string;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function,
// so users query `FROM spdr.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's
// callable functions). It returns the full SPDR US ETF lineup; a WHERE on ticker / asset_class
// narrows it.

export function makeProductsScan(client: SpdrClient) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "SPDR / State Street US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(client.get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). SSGA publishes only the CURRENT
// daily holdings file per fund, so — unlike the sibling iShares worker — there is NO time travel
// and no as-of argument; `as_of_date` reflects the file's own publication date.
//   SELECT * FROM spdr.main.holdings WHERE fund_ticker = 'SPY';
//   SELECT * FROM spdr.main.holdings WHERE fund_ticker IN ('SPY','BIL');   -- fan-out per partition
//   SELECT * FROM spdr.main.holdings;                                      -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — and pushes one item per fund onto a BoundStorage work queue.
//   • process() pops one fund per tick, fetches its holdings, and emits a single partition batch.
// filterPushdown + being LISTED is what lets DuckDB push fund_ticker into the scan.

export function makeHoldingsScan(client: SpdrClient) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    name: "holdings_scan",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table. Detailed fund " +
      "holdings, hive-partitioned by fund_ticker: filter WHERE fund_ticker = 'SPY' (or " +
      "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund's " +
      "holdings. weight_percent is in percent points; bond funds fill coupon/maturity/par_value.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the scan. Each
    // fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund.
    onInit: async ({ initCall, executionId, storage }) => {
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = (filters?.getColumnValues("fund_ticker") ?? []).map((t) =>
        String(t).toUpperCase(),
      );
      // Resolve the fund universe from the (cached) catalog. One fetch either way.
      const products = await fetchProducts(client.get);
      const tickers = new Set(
        products.map((r) => r.ticker).filter((t): t is string => !!t).map((t) => t.toUpperCase()),
      );
      const targets: FundItem[] =
        requested.length > 0
          ? requested.filter((t) => tickers.has(t)).map((t) => ({ ticker: t }))
          : [...tickers].map((t) => ({ ticker: t }));
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip funds with no holdings file (a
      // 404 → thrown fetch) or an empty file, and pop the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        let rows;
        try {
          rows = await fetchHoldings(client.getBytes, fund.ticker);
        } catch {
          continue; // a fund without a published holdings file — skip it
        }
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT name, weight_percent FROM spdr.main.holdings_scan() WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of SPY via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM spdr.main.holdings_scan() WHERE fund_ticker IN ('SPY', 'BIL') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): filter WHERE fund_ticker = '…' (or fund_ticker IN (…)) for specific " +
        "funds, or scan with no filter to stream every fund (~180 partitions — slow). " +
        "weight_percent is in percent points (7.38 = 7.38%); bond funds fill " +
        "coupon/maturity/par_value/market_value while equity funds fill ticker/sector/shares_held. " +
        "SSGA publishes current holdings only, so there is no historical as-of date.",
      "vgi.doc_md":
        "## holdings_scan\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table. Hive-partitioned by " +
        "`fund_ticker`: filter `WHERE fund_ticker = 'SPY'` for one fund, or scan with no filter to " +
        "stream every fund (see the example queries). `fund_ticker` is distinct from the " +
        "constituent `ticker` column.",
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}

// ── nav_history ─────────────────────────────────────────────────────────────

interface HistoryArgs {
  fund: string;
  start_date: Date | null;
  end_date: Date | null;
}

const FUND_ARG_DOC =
  "The fund to look up, given as an exchange ticker like 'SPY'. Required, first positional argument.";

const RANGE_DOCS = {
  start_date:
    "Optional inclusive lower bound on the day range — omit for no lower bound. Filters client-side.",
  end_date:
    "Optional inclusive upper bound on the day range — omit for no upper bound. Named end_date " +
    "because END is a reserved SQL keyword.",
};

export function makeNavHistoryFunction(client: SpdrClient) {
  const schema = navHistorySchema();
  return defineTableFunction<HistoryArgs, DoneState>({
    name: "nav_history",
    description:
      "Daily net-asset-value history for a fund back to inception — one row per business day " +
      "with NAV per share, shares outstanding, and total net assets. `fund` is a ticker; bound " +
      "the range with start_date/end_date (recommended, as old funds return thousands of rows).",
    args: { fund: new Utf8(), start_date: new DateDay(), end_date: new DateDay() },
    argDefaults: { start_date: null, end_date: null },
    argDocs: { fund: FUND_ARG_DOC, ...RANGE_DOCS },
    onBind: (p) => {
      required("nav_history", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const ticker = await resolveOrThrow("nav_history", client, String(p.args.fund));
      const rows = await fetchNavHistory(
        client.getBytes,
        ticker,
        dateArgToEpoch(p.args.start_date),
        dateArgToEpoch(p.args.end_date),
      );
      out.emit(navHistoryBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT as_of_date, nav FROM spdr.main.nav_history('SPY', start_date := DATE '2026-01-01') ORDER BY as_of_date DESC", description: "SPY NAV since the start of the year" },
      { sql: "SELECT as_of_date, total_net_assets FROM spdr.main.nav_history('SPY') ORDER BY as_of_date DESC LIMIT 5", description: "Recent daily total net assets for SPY" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "Daily NAV time series for a fund back to inception: NAV per share, shares outstanding, " +
        "and total net assets. Use it for NAV-based return series, drawdowns, and asset-growth " +
        "analysis. This is fund NAV, not market-price candles — for traded prices use a market-data " +
        "source. Old funds return thousands of rows, so bound with start_date/end_date.",
      "vgi.doc_md":
        "## nav_history\n\n" +
        "Daily NAV history back to inception, one row per business day. This is **fund NAV**, not a " +
        "market-price candle series. Old funds return thousands of rows — bound with " +
        "`start_date`/`end_date` (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(navHistorySchema(), NAV_HISTORY_DESCS),
    },
  });
}
