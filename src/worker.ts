// vgi-etf-spdr stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION '/path/to/vgi-etf-spdr/bin/vgi-etf-spdr-worker');
//   SELECT * FROM spdr.products ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM spdr.holdings WHERE fund_ticker = 'SPY' ORDER BY weight_percent DESC LIMIT 10;
//   SELECT * FROM spdr.nav_history('SPY', start_date := DATE '2026-01-01');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();
