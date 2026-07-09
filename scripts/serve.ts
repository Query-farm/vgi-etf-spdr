// Serve the vgi-etf-spdr worker over HTTP with the standardized VGI landing surface.
//
// This mirrors what the SDK's `createVgiFetch` does internally (build the VGI protocol from
// the registry + catalog, seal state in signed tokens), but mounts everything at the ROOT
// prefix ("") and enables the landing page via `landingDescribe`. So:
//   GET  /                                   → the shared vendored VGI landing.html
//   GET  /describe.json                      → the worker's catalog introspection
//   GET  /describe/{catalog}/{schema}/{t}.json → lazy per-object columns
//   GET  /health                             → JSON health endpoint
//   POST /                                    → the VGI RPC transport (what DuckDB attaches to)
//
// Run it:  PORT=8787 bun run scripts/serve.ts   (default port 8787)
// Attach:  ATTACH 'spdr' AS spdr (TYPE vgi, LOCATION 'http://localhost:8787');

import {
  FunctionRegistry,
  ReadOnlyCatalogInterface,
  buildVgiProtocol,
  createLandingDescribe,
  arrowStateSerializer,
} from "@query-farm/vgi";
import { createHttpHandler, unpackStateToken } from "@query-farm/vgi-rpc";
import { makeSpdrClient } from "../src/client.js";
import { makeProductsScan, makeHoldingsScan, makeNavHistoryFunction } from "../src/functions.js";
import { makeCatalog } from "../src/catalog.js";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN_TTL = 3600;
// Dev signing key — the HTTP handler signs state tokens with it. For a real deployment pass a
// stable secret 32-byte key (e.g. from an env var / secret store); it never leaves the process.
const SIGNING_KEY = process.env.VGI_SIGNING_KEY
  ? new Uint8Array(Buffer.from(process.env.VGI_SIGNING_KEY, "hex")).subarray(0, 32)
  : new Uint8Array(32).fill(7);

const REPO = "https://github.com/Query-farm/vgi-etf-spdr";

const client = makeSpdrClient();
const functions = [makeNavHistoryFunction(client)];
// products is a base table backed by an (unlisted) zero-arg scan; holdings is a base table
// backed by a LISTED scan (holdings_scan) so the extension can push the ticker filter into it.
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

const protocol = buildVgiProtocol({
  signingKey: SIGNING_KEY,
  registry,
  catalogInterface,
  recoverExchangeState: async (opaqueData: Uint8Array) => {
    const tokenString = new TextDecoder().decode(opaqueData);
    const unpacked = await unpackStateToken(tokenString, SIGNING_KEY, TOKEN_TTL, undefined);
    return arrowStateSerializer.deserialize(unpacked.stateBytes);
  },
});

const handler = createHttpHandler(protocol, {
  prefix: "", // mount at root, not /vgi
  serverId: "vgi-etf-spdr",
  tokenKey: SIGNING_KEY,
  tokenTtl: TOKEN_TTL,
  stateSerializer: arrowStateSerializer,
  repositoryUrl: REPO,
  // Allow the hosted Cupola UI (and any browser origin) to call this worker cross-origin.
  // Safe here: this is a keyless, read-only public-data worker with no cookies/credentials.
  corsOrigins: process.env.CORS_ORIGINS ?? "*",
  landingDescribe: createLandingDescribe(catalogInterface, {
    name: "spdr",
    doc: "SPDR / State Street (SSGA) US ETF data: product catalog, current holdings, and daily NAV history.",
    version: "0.1.0",
  }),
});

const server = Bun.serve({ port: PORT, fetch: (req) => handler(req) });
console.log(`vgi-etf-spdr HTTP worker listening on http://localhost:${server.port}`);
console.log(`  landing page   http://localhost:${server.port}/`);
console.log(`  describe.json  http://localhost:${server.port}/describe.json`);
console.log(`  health         http://localhost:${server.port}/health`);
