# vgi-etf-spdr — agent notes

A VGI (DuckDB) worker exposing SPDR / State Street (SSGA) US ETF data as two base **tables** —
`products` (the catalog) and `holdings` (hive-partitioned) — plus one table **function**,
`nav_history` (the holdings table's backing scan is also listed under the same name, `holdings`,
so DuckDB can push the fund_ticker filter into it). TypeScript, runs on
Bun, built on `@query-farm/vgi` (the TS SDK). Keyless — no secret type, no auth. Modeled on the
sibling `vgi-etf-ishares` worker; the KEY DIFFERENCE is that SSGA publishes **current holdings only**,
so `holdings` has NO time travel.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for a table to
  be scannable.
- **catalog `schemas[].functions`** — the *listing* layer. Controls what shows as a callable `X()`
  function AND is where the extension discovers a scan's capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table.
`holdings`: backing `holdingsScan` MUST be **listed** (`functions: [...functions, holdingsScan]`)
— an unlisted backing scan gets no `pushdown_filters` (the extension can't see its
`filter_pushdown` capability), so the `fund_ticker` partition filter never reaches it (verified:
unlisting drops the `Filters: fund_ticker=…` line from the plan and the estimate jumps to the
whole-table ~90k rows). The scan is therefore listed but named **`holdings`, the same as its base
table** — so it satisfies VGI311 (a table of that name scans it) and reads to an agent as one
`holdings` surface, not a second `holdings_scan()` object. No `vgi-lint.toml` waiver is needed.

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT holdings only (no time travel)

Query `FROM spdr.main.holdings WHERE fund_ticker = 'SPY'` (fund selector); an **unfiltered scan
streams every fund** (one partition per fund). Mechanics:
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole catalog), and `queuePush`es one `{ticker}` item per fund onto a
  `BoundStorage` queue keyed by the execution id. `process()` pops one fund per tick, fetches its
  holdings `.xlsx`, and `out.emit`s a single partition batch tagged with `vgi_partition_values`
  (min==max==ticker). `maxWorkers` workers drain the same queue → work-stealing fan-out. `LIMIT`
  short-circuits the stream.
- **No time travel.** SSGA has only one current holdings file per fund. There is deliberately NO
  `supportsTimeTravel` and NO as-of argument; `process()` never reads `p.atValue`. `as_of_date` is
  a real output column populated from the spreadsheet's own "As of" header row.
- **404-tolerant.** A fund with no holdings file throws in `getBytes`; `process()` catches and
  skips to the next fund so an all-funds scan never fails on one missing file.
- **`filterPushdown: true`** + LISTED → the extension pushes the `fund_ticker` filter into the scan.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own ticker
  (present for equity funds, null for bond/loan funds); `fund_ticker` is the fund's ticker,
  constant per fund. The scan tags every row with the requested fund ticker, upper-cased.
- Constraints: `products` advisory PK `[isin]`; `holdings` advisory composite PK
  `[fund_ticker, name]` with `notNull [fund_ticker, name]` (a constituent is identified by its fund
  plus its name; both are always populated). No cross-table FK (identifier columns recur with
  different meanings). No `vgi-lint.toml` rule waivers — VGI311 is met by naming the listed scan
  `holdings` (matching the table), VGI807 by the composite PK.

## Holdings/NAV are `.xlsx` — the one extra dependency

SSGA's catalog is JSON, but holdings and NAV history are published **only as `.xlsx`** (no CSV/JSON
— the `.csv` path 404s). So the worker adds [SheetJS `xlsx`](https://www.npmjs.com/package/xlsx)
(`0.18.5`), a PURE parser (no network) — allowed in the driver layer. `readXlsxMatrix(bytes)` (the
ONLY XLSX touch) decodes a byte buffer into a row matrix via `XLSX.utils.sheet_to_json(ws,
{header:1})`; every other parser takes a plain matrix so the unit tests drive them without any
xlsx (a couple round-trip a SheetJS-built buffer through `readXlsxMatrix`).

**Column layout VARIES by fund type**, so the spreadsheet parsers are **header-driven**: find the
header row, map each column by its (lowercased) label, then read data rows until the first blank
row (the disclaimer footer follows). Observed layouts:
- equity (SPY): Name, Ticker, Identifier, SEDOL, Weight, Sector, Shares Held, Local Currency
- treasury (BIL): Name, Identifier, SEDOL, Weight, Coupon, Par Value, Market Value, Local Currency, Maturity
- loan (SRLN): Name, Identifier, FIGI, Weight, Coupon, Maturity, Par Value, Market Value
The union is emitted as one wide schema; unfilled columns are null per fund type. `parseHoldings`
sorts by `weight_percent` DESC (NULLS last) so `... LIMIT n` returns the top holdings.

## Architecture (keep this separation)

- **`src/spdr.ts` — the pure driver.** URL builders + JSON/spreadsheet parsers, plus thin
  `fetch*` orchestrators and `resolveTicker` that take injected `get(url)` (JSON) and/or
  `getBytes(url)` (bytes). NO network, NO SDK import (it MAY import `xlsx`, a pure parser). This is
  what the unit tests exercise. All parsing is defensive: a missing field/column/row degrades to
  `[]`/`null`, never a throw. `resolveTicker` returns `string | null` (null = not found) rather
  than throwing, so this module needs no SDK import; `functions.ts` turns null into a typed
  `ArgumentValidationError`.
- **`src/client.ts` — the only network module.** `makeSpdrClient()` returns `{ get, getBytes }`.
  `get` fetches JSON (and memoizes the fund-finder for 24 h); `getBytes` fetches an `.xlsx` as a
  `Uint8Array` (never cached). Its one job beyond `fetch` is setting the browser-like User-Agent
  SSGA requires (the default fetch UA gets an interstitial HTML page). No dedicated unit test for
  the byte path beyond a shape check; exercised live by the HTTP-transport + haybarn tests.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Real typed columns
  (`Utf8`/`Float64`/`DateDay`), not JSON. Every calendar date is a real Arrow **DATE** (`DateDay`
  → DuckDB `DATE`, no timezone; a DATE cell is a JS `Date` at UTC midnight via `dateOrNull`).
  NOTE: dates are DATE, not TIMESTAMP (casting a UTC-midnight TIMESTAMPTZ `::DATE` shifts the day
  in non-UTC sessions). Percent columns carry a `_percent` suffix and hold **percent points**
  (SSGA's raw values: `weight_percent` 7.38 = 7.38%, `expense_ratio_percent` 0.09 = 0.09%).
- **`src/functions.ts`** — three `defineTableFunction`s: `makeProductsScan` (unlisted products
  backing scan), `makeHoldingsScan` (named `holdings`, LISTED, filterPushdown, SINGLE_VALUE
  partitions, queue/BoundStorage streaming), and `makeNavHistoryFunction`. Each `make*` takes the
  whole `SpdrClient` (`{get, getBytes}`) for uniformity.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry
  that wires the real client into the functions.

## SSGA endpoint facts (why the design is what it is)

Three keyless planes, all needing only the browser User-Agent:

1. **Fund-finder** — `GET /bin/v1/ssmp/fund/fundfinder?country=us&language=en&role=intermediary&product=etfs&ui=fund-finder`.
   One ~0.8 MB object; the fund array is at `data.funds.etfs.datas` (~180 ETFs). Backs `products`
   and the ticker resolution in `resolveTicker`. Scalar fields come as either a bare value or a
   **`[display, raw]` pair** (e.g. `nav: ["$747.70", 747.704983]`); the "no data" sentinel is a
   `"-"` display (its paired raw is a garbage denormal `-5e-324`, so `pairNum` keys off the
   DISPLAY). Helpers: `pairDisp()` (display string, sentinels→null), `pairNum()` (raw number),
   `parseDate()` (ISO `YYYY-MM-DD` → epoch seconds). Asset class is NOT a per-fund field — it comes
   from `data.funds.etfs.categories` (the `assetclass` category's sub-categories carry a name + a
   pipe-delimited `funds` list; `assetClassMap` builds ticker→class, trimming a trailing
   " Sector"). ISIN/CUSIP are pulled by SHAPE from the comma-separated `keywords` string
   (`idsFromKeywords`: 12-char ISIN, 9-char CUSIP), because that string is positionally
   heterogeneous (fund names contain commas). Ticker is `fundFilter` (clean; `fundTicker` carries a
   `®`). AUM is reported in **millions** → `net_assets` scales it to whole USD (×1e6).

2. **holdings-daily** — `GET /library-content/products/fund-data/etfs/us/holdings-daily-us-en-<ticker>.xlsx`
   (lower-case ticker). A real `.xlsx`; header rows (Fund Name / Ticker Symbol / "Holdings: As of
   DD-Mon-YYYY") then the constituent table. Current holdings only.

3. **navhist** — `GET /library-content/products/fund-data/etfs/us/navhist-us-en-<ticker>.xlsx`.
   `.xlsx` with header `Date, NAV, Shares Outstanding, Total Net Assets`, daily back to inception.

**Dates:** date ARGS are real SQL `DATE` (Arrow `DateDay`). The vgi runtime hands a DATE arg to
`p.args` as a number of epoch **milliseconds**; `dateArgToEpoch` converts it (magnitude-robust:
epoch-ms, JS Date, bigint, days-since-epoch, or a YYYY-MM-DD string). `parseDate` also handles the
spreadsheet date shapes `DD-Mon-YYYY` (As-of / NAV Date) and `MM/DD/YYYY` (bond Maturity).
`nav_history` takes `fund` + optional `start_date`/`end_date` (client-side filter; named `*_date`
because `END` is reserved). `holdings` takes NO date arg (current only).

## Fund identifier (`fund` arg)

`resolveTicker(get, fund)`: matches the fund-finder catalog case-insensitively and returns the
canonical ticker (or null = not found). It does NOT throw (spdr.ts is SDK-free); `functions.ts`
`resolveOrThrow` converts null into an `ArgumentValidationError` with a "list tickers via products"
hint. The `holdings`/`nav_history` URLs use the ticker directly (lower-cased) — there is no numeric
portfolio id. Resolution is not cached beyond the 24 h fund-finder memo.

## Commands

```bash
bun install
bun test            # 34 tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-spdr-worker` + `VGI_WORKER_CATALOG_NAME=spdr` and
runs `test/sql/*.test` (DESCRIBE-based schema asserts + a few live-invariant asserts that hit
SSGA). CI runs this, the reusable `ts-ci.yml`, and a `vgi-lint` gate at `--fail-on info`
(currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^6.0.3` (5.x descends into SDK `.ts` source and reports external errors).

## Gotchas / conventions

- Emit `Date` (rich repr) for DATE columns via `batchFromColumns`; date fields go through
  `parseDate` (→ epoch seconds) then `dateOrNull`.
- `noUncheckedIndexedAccess` is on: guard matrix/array cell reads (the parsers use `at(row, col)`
  and null-check before use) so destructured cells don't type as possibly `undefined`.
- vgi-lint rules to keep satisfied: catalog/schema descriptions must NOT enumerate the worker's own
  functions (VGI173); numeric column comments should state units (VGI131 — e.g. "per share in
  USD", "percent points"); argument docs must NOT restate the data type (VGI313); every function
  needs an agent test task (VGI520 — products/holdings/nav_history are covered in
  `catalog.ts` `vgi.agent_test_tasks`); every listed function/table needs a primary key (VGI807 —
  products keyed by `isin`, holdings by the composite `(fund_ticker, name)`).
- Don't add a secret type; this worker is keyless by design.
- Keep the `holdings` current-only contract: do NOT add `supportsTimeTravel` or an as-of arg.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION '/path/to/vgi-etf-spdr/bin/vgi-etf-spdr-worker');
SELECT ticker, net_assets FROM spdr.products ORDER BY net_assets DESC LIMIT 10;
SELECT name, ticker, weight_percent FROM spdr.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 10;
SELECT as_of_date, nav FROM spdr.nav_history('SPY', start_date := DATE '2026-01-01') ORDER BY as_of_date DESC;
```
