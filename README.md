# vgi-etf-spdr

A [VGI](https://query.farm) worker that exposes **SPDR / State Street (SSGA)** US ETF data as
DuckDB tables and a table function — the full ETF catalog, a partitioned holdings table, and
per-fund daily NAV history.

| Object | What it returns | SSGA source |
| --- | --- | --- |
| `spdr.products` (table) | Every US ETF with key facts, one row per fund | fund-finder JSON |
| `spdr.holdings` (table) | Detailed current holdings, partitioned by fund_ticker | holdings-daily `.xlsx` |
| `spdr.nav_history(fund, start_date, end_date)` | Daily NAV history back to inception | navhist `.xlsx` |

Everything rides SSGA's public data planes — there is no secret to create and no login. Funds
are identified by their exchange **ticker** (e.g. `SPY`); the fund-scoped `nav_history` resolves
a ticker via one fund-finder lookup.

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE as_of_date = DATE '2026-07-07'`.
- **Percent columns carry a `_percent` suffix and hold percent points**: `expense_ratio_percent`
  = 0.09 means 0.09%; `weight_percent` = 7.38 means 7.38% (weights sum to ~100).

> **Current holdings only.** SSGA publishes a single, current daily-holdings file per fund, so
> `holdings` has **no time travel / as-of argument** — `as_of_date` reflects the published file's
> own date. (This is the one behavioral difference from the sibling `vgi-etf-ishares` worker.)

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-etf-spdr/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-etf-spdr@v0.4.0');

-- The largest SPDR ETFs by net assets
SELECT ticker, fund_name, net_assets FROM spdr.main.products ORDER BY net_assets DESC LIMIT 5;

-- The top holdings of the SPDR S&P 500 ETF Trust
SELECT name, ticker, weight_percent FROM spdr.main.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 5;
```

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.4.0` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-etf-spdr:0.4.0');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-etf-spdr/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

- **HTTP server.** Run the image's HTTP transport yourself and attach it by URL:

  ```bash
  docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-spdr:0.4.0   # serves /health + the VGI RPC on :8000
  ```

  ```sql
  ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION 'http://localhost:8000');
  ```

### Build from source

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION '/path/to/vgi-etf-spdr/bin/vgi-etf-spdr-worker');
```

`bin/vgi-etf-spdr-worker` is a small wrapper that launches `src/worker.ts` under Bun.

Tests, typecheck and the E2E suite are described under [Development](#development).

## Usage

### products — the fund catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- Ten largest SPDR ETFs by net assets:
SELECT ticker, fund_name, net_assets, expense_ratio_percent
FROM spdr.products
ORDER BY net_assets DESC
LIMIT 10;

-- Cheapest equity ETFs by expense ratio:
SELECT ticker, fund_name, expense_ratio_percent
FROM spdr.products
WHERE asset_class = 'Equity'
ORDER BY expense_ratio_percent
LIMIT 10;

-- Look up one fund by ticker:
SELECT ticker, fund_name, expense_ratio_percent
FROM spdr.products
WHERE ticker = 'SPY';
```

Filter on `ticker`, `asset_class` (`'Equity'`, `'Fixed Income'`, `'Alternative'`,
`'Multi-Asset'`, `'Cash'`), etc. Columns include `ticker`, `fund_name`, `asset_class`,
`isin`/`cusip`, `primary_exchange`, `inception_date` (DATE), `nav`, `net_assets`, `close_price`,
`bid_ask_mid`, `premium_discount_percent`, `expense_ratio_percent`, and cumulative /annualized
return columns (`return_1m_percent`, `return_qtd_percent`, `ytd_return_percent`,
`return_1y/3y/5y/10y_percent`, `return_since_inception_percent`). All `*_percent` columns are in
percent points (0.09 = 0.09%). `net_assets` is in whole USD (the source reports it in millions).

### holdings — a hive-partitioned table

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — ~180 funds, so prefer a filter).

```sql
-- Top 10 current holdings of SPY (already weight-ordered):
SELECT name, ticker, weight_percent, shares_held
FROM spdr.holdings
WHERE fund_ticker = 'SPY'
ORDER BY weight_percent DESC
LIMIT 10;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, name, weight_percent
FROM spdr.holdings
WHERE fund_ticker IN ('SPY', 'BIL');

-- A bond fund fills coupon / maturity / par value / market value instead:
SELECT name, coupon_percent, maturity_date, par_value, market_value
FROM spdr.holdings
WHERE fund_ticker = 'BIL'
ORDER BY weight_percent DESC
LIMIT 5;
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent ticker; present for equity funds, null for bond/loan funds).
The **column set is fund-type dependent**: equity funds fill `ticker` / `sector` / `shares_held`;
bond funds fill `coupon_percent` / `maturity_date` (DATE) / `par_value` / `market_value`; loan
funds fill `figi`. Rows come back **weight-descending**. `as_of_date` (DATE) is the published
file's date — SSGA publishes **current holdings only**, so there is no historical time travel.
Join `holdings.fund_ticker` to `products.ticker` for fund-level facts.

> The `holdings` scan is also listed as a table function of the **same name** (it's what the table
> scans, and being listed is what lets DuckDB push the `fund_ticker` filter into it). Query it the
> normal way, as the `holdings` table.

### nav_history — daily NAV series

```sql
SELECT as_of_date, nav, shares_outstanding, total_net_assets
FROM spdr.nav_history('SPY', start_date := DATE '2026-01-01')
ORDER BY as_of_date DESC;
```

This is **fund NAV**, not a market-price candle series. Old funds return thousands of rows —
bound the range with `start_date`/`end_date` (inclusive SQL `DATE`s; omit for unbounded).

### Combining them

Screen the catalog, then drill into the funds it picks. The join pushes the selected tickers into
the `holdings` scan, so only those funds' holdings files are fetched:

```sql
-- Largest single holding of each of the five biggest SPDR equity ETFs, sized in dollars:
WITH biggest AS (
    SELECT ticker, net_assets
    FROM spdr.products
    WHERE asset_class = 'Equity'
    ORDER BY net_assets DESC
    LIMIT 5
)
SELECT b.ticker AS fund, h.name AS top_holding, h.weight_percent,
       round(b.net_assets * h.weight_percent / 100 / 1e9, 1) AS position_usd_billions
FROM biggest b
JOIN spdr.holdings h ON h.fund_ticker = b.ticker
WHERE h.holding_rank = 1
ORDER BY b.net_assets DESC;
```

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install --prerelease allow 'haybarn-unittest>=2.0.0rc11,<2.1'
echo "INSTALL vgi FROM community;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check);
CI runs it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-spdr-worker --fail-on info
```

The pure request/response logic lives in `src/spdr.ts` and is fully unit-tested against an
in-process fake (`test/fake-spdr.ts`) — no network. The single module that touches the network
is `src/client.ts` (it sets the browser-like User-Agent SSGA requires); it is verified live
rather than in the unit suite.

## Holdings format: the `.xlsx` choice

SSGA's catalog is clean JSON, but its **holdings and NAV history are only published as `.xlsx`
spreadsheets** (there is no CSV or JSON holdings endpoint — the `.csv` path 404s). So the worker
adds one pure-parser dependency, [SheetJS `xlsx`](https://www.npmjs.com/package/xlsx), used only
to decode a byte buffer into a row matrix (`readXlsxMatrix`). It does no network, so it lives in
the driver layer with the rest of the pure logic. The client therefore exposes **two**
transports: `get(url)` (JSON) and `getBytes(url)` (binary). The spreadsheets' **column layout
varies by fund type**, so the parsers are header-driven — they read the header row and map each
column by its label, not by a fixed position.

## Layout

```
src/spdr.ts       Pure driver: URL builders + JSON/spreadsheet parsers + fetch orchestrators (no network, no SDK)
src/client.ts     Real fetch client (browser User-Agent; keyless): get (JSON) + getBytes (xlsx)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The products/holdings backing scans + the nav_history table function
src/catalog.ts    The `spdr` catalog descriptor (no secret type)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from SSGA's public website endpoints (the fund-finder JSON and the per-fund
daily-holdings / NAV-history spreadsheets). It is provided for personal, informational use;
consult SSGA's terms before any redistribution or commercial use. This worker is not affiliated
with or endorsed by State Street / SPDR.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
