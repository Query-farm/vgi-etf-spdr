// vgi-etf-spdr stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION '/path/to/vgi-etf-spdr/bin/vgi-etf-spdr-worker');
//   SELECT * FROM spdr.products ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM spdr.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 10;
//   SELECT * FROM spdr.nav_history('SPY', start_date := DATE '2026-01-01');
//
// Keyless: no CREATE SECRET is needed. `products` and `holdings` are base TABLES (backed by
// scan functions); `nav_history` is a table function. All take the injected HTTP client
// (client.ts).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeSpdrClient } from "./client.js";
import { makeProductsScan, makeHoldingsScan, makeNavHistoryFunction } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const client = makeSpdrClient();

// The callable table functions (products and holdings are base tables, not functions).
const functions = [makeNavHistoryFunction(client)];

// Backing scans for the base tables: registered so scan RPCs resolve. products' scan stays
// unlisted (exposed only as the `products` table); holdings' scan is LISTED (in makeCatalog) so
// the extension can push the fund_ticker filter into the `holdings` table.
const productsScan = makeProductsScan(client);
const holdingsScan = makeHoldingsScan(client);

const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);
registry.register(productsScan);
registry.register(holdingsScan);

const catalogInterface = new ReadOnlyCatalogInterface(
  makeCatalog(functions, productsScan, holdingsScan),
  registry,
);

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: [...functions, productsScan, holdingsScan], catalogInterface }).run();
