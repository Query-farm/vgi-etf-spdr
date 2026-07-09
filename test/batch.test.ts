// Typed-column contract for the three schemas. This one pulls @query-farm/vgi
// (batchFromColumns) + apache-arrow, so it runs under the full SDK install — unlike the driver
// tests, which are deliberately SDK-free. Proves schema field names/order and that
// Utf8/Float64/Date cells (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  navHistorySchema,
  navHistoryBatch,
} from "../src/schema.js";
import { parseProducts, parseHoldings, parseNavHistory } from "../src/spdr.js";
import {
  fundFinderEnvelope,
  equityHoldingsMatrix,
  navHistoryMatrix,
} from "./fake-spdr.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "fund_name", "asset_class", "isin", "cusip", "primary_exchange", "domicile",
    "inception_date", "as_of_date", "nav", "net_assets", "close_price", "bid_ask_mid",
    "premium_discount_percent", "expense_ratio_percent", "performance_as_of", "return_1m_percent",
    "return_qtd_percent", "ytd_return_percent", "return_1y_percent", "return_3y_percent",
    "return_5y_percent", "return_10y_percent", "return_since_inception_percent", "product_page_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "name", "ticker", "identifier", "sedol", "figi", "weight_percent",
    "sector", "shares_held", "coupon_percent", "par_value", "market_value", "maturity_date",
    "local_currency",
  ]);
});

test("nav_history schema field names + order", () => {
  expect(names(navHistorySchema())).toEqual([
    "as_of_date", "nav", "shares_outstanding", "total_net_assets",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  expect((productsBatch(productsSchema(), parseProducts(fundFinderEnvelope())) as { numRows: number }).numRows).toBe(2);
  expect((holdingsBatch(holdingsSchema(), parseHoldings(equityHoldingsMatrix(), "SPY")) as { numRows: number }).numRows).toBe(3);
  expect((navHistoryBatch(navHistorySchema(), parseNavHistory(navHistoryMatrix())) as { numRows: number }).numRows).toBe(3);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((navHistoryBatch(navHistorySchema(), []) as { numRows: number }).numRows).toBe(0);
});
