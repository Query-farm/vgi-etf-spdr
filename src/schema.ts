// Arrow output schemas + row→batch mapping for the products / holdings / nav_history surfaces.
//
// SPDR data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/returns, and a real Arrow DATE
// (Date32) for every calendar date. `batchFromColumns` defaults to the "rich" representation,
// so a DATE cell is a JS `Date` (at UTC midnight). Percent-valued columns carry a `_percent`
// suffix and hold percent-magnitude numbers (e.g. 7.38 = 7.38%), matching SSGA's raw values.

import { Schema, Field, Utf8, Float64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type { ProductRow, HoldingRow, NavHistoryRow } from "./spdr.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("asset_class", new Utf8()),
    f("isin", new Utf8()),
    f("cusip", new Utf8()),
    f("primary_exchange", new Utf8()),
    f("domicile", new Utf8()),
    f("inception_date", date()),
    f("as_of_date", date()),
    f("nav", new Float64()),
    f("net_assets", new Float64()),
    f("close_price", new Float64()),
    f("bid_ask_mid", new Float64()),
    f("premium_discount_percent", new Float64()),
    f("expense_ratio_percent", new Float64()),
    f("performance_as_of", date()),
    f("return_1m_percent", new Float64()),
    f("return_qtd_percent", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("product_page_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      asset_class: rows.map((r) => r.assetClass),
      isin: rows.map((r) => r.isin),
      cusip: rows.map((r) => r.cusip),
      primary_exchange: rows.map((r) => r.primaryExchange),
      domicile: rows.map((r) => r.domicile),
      inception_date: rows.map((r) => dateOrNull(r.inceptionDate)),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      nav: rows.map((r) => r.nav),
      net_assets: rows.map((r) => r.netAssets),
      close_price: rows.map((r) => r.closePrice),
      bid_ask_mid: rows.map((r) => r.bidAskMid),
      premium_discount_percent: rows.map((r) => r.premiumDiscountPercent),
      expense_ratio_percent: rows.map((r) => r.expenseRatioPercent),
      performance_as_of: rows.map((r) => dateOrNull(r.performanceAsOf)),
      return_1m_percent: rows.map((r) => r.return1mPercent),
      return_qtd_percent: rows.map((r) => r.returnQtdPercent),
      ytd_return_percent: rows.map((r) => r.ytdReturnPercent),
      return_1y_percent: rows.map((r) => r.return1yPercent),
      return_3y_percent: rows.map((r) => r.return3yPercent),
      return_5y_percent: rows.map((r) => r.return5yPercent),
      return_10y_percent: rows.map((r) => r.return10yPercent),
      return_since_inception_percent: rows.map((r) => r.returnSinceInceptionPercent),
      product_page_url: rows.map((r) => r.productPageUrl),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: holdings_scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("name", new Utf8()),
    f("ticker", new Utf8()),
    f("identifier", new Utf8()),
    f("sedol", new Utf8()),
    f("figi", new Utf8()),
    f("weight_percent", new Float64()),
    f("sector", new Utf8()),
    f("shares_held", new Float64()),
    f("coupon_percent", new Float64()),
    f("par_value", new Float64()),
    f("market_value", new Float64()),
    f("maturity_date", date()),
    f("local_currency", new Utf8()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      name: rows.map((r) => r.name),
      ticker: rows.map((r) => r.ticker),
      identifier: rows.map((r) => r.identifier),
      sedol: rows.map((r) => r.sedol),
      figi: rows.map((r) => r.figi),
      weight_percent: rows.map((r) => r.weightPercent),
      sector: rows.map((r) => r.sector),
      shares_held: rows.map((r) => r.sharesHeld),
      coupon_percent: rows.map((r) => r.couponPercent),
      par_value: rows.map((r) => r.parValue),
      market_value: rows.map((r) => r.marketValue),
      maturity_date: rows.map((r) => dateOrNull(r.maturityDate)),
      local_currency: rows.map((r) => r.localCurrency),
    },
    schema,
  );
}

// ── nav_history ───────────────────────────────────────────────────────────────

export function navHistorySchema(): Schema {
  return new Schema([
    f("as_of_date", date()),
    f("nav", new Float64()),
    f("shares_outstanding", new Float64()),
    f("total_net_assets", new Float64()),
  ]);
}

export function navHistoryBatch(schema: Schema, rows: NavHistoryRow[]) {
  return batchFromColumns(
    {
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      nav: rows.map((r) => r.nav),
      shares_outstanding: rows.map((r) => r.sharesOutstanding),
      total_net_assets: rows.map((r) => r.totalNetAssets),
    },
    schema,
  );
}
