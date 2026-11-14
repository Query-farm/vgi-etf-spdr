// Composed example queries — each combines two of the worker's objects (the products catalog,
// the holdings table, nav_history) in one query. Defined once here and referenced from the
// schema-level list (catalog.ts) and from the example list of the object that drives each query
// (catalog.ts table tags / functions.ts), so the SQL is never copy-pasted.

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** holdings × products: each of SPY's top positions sized in dollars from the fund's net assets. */
export const SPY_POSITION_DOLLARS: ExampleQuery = {
  description:
    "Approximate dollar size of SPY's ten largest positions: each holding's weight applied to the " +
    "fund's net assets from the products catalog (USD billions)",
  sql:
    "SELECT h.holding_rank, h.name, h.ticker, h.weight_percent, " +
    "round(p.net_assets * h.weight_percent / 100 / 1e9, 1) AS position_usd_billions " +
    "FROM spdr.main.holdings h JOIN spdr.main.products p ON p.ticker = h.fund_ticker " +
    "WHERE h.fund_ticker = 'SPY' ORDER BY h.holding_rank LIMIT 10",
};

/** products → holdings: screen the catalog, then drill into each selected fund's top holding. */
export const BIGGEST_EQUITY_FUNDS_TOP_HOLDING: ExampleQuery = {
  description:
    "Largest single holding of each of the five biggest SPDR equity ETFs, with its weight and " +
    "approximate dollar size (the catalog picks the funds; the join pushes their tickers into " +
    "the holdings scan, so only those five funds are fetched)",
  sql:
    "WITH biggest AS (SELECT ticker, net_assets FROM spdr.main.products WHERE asset_class = 'Equity' " +
    "ORDER BY net_assets DESC LIMIT 5) " +
    "SELECT b.ticker AS fund, h.name AS top_holding, h.weight_percent, " +
    "round(b.net_assets * h.weight_percent / 100 / 1e9, 1) AS position_usd_billions " +
    "FROM biggest b JOIN spdr.main.holdings h ON h.fund_ticker = b.ticker " +
    "WHERE h.holding_rank = 1 ORDER BY b.net_assets DESC",
};

/** nav_history × products: price-only NAV change vs SSGA's reported YTD total return. */
export const SPY_NAV_VS_REPORTED_YTD: ExampleQuery = {
  description:
    "SPY's price-only NAV change from the 2025 year-end NAV to SSGA's latest performance date, " +
    "next to the YTD total return the catalog reports for that date (the gap reflects " +
    "distributions, which a NAV-per-share series excludes)",
  sql:
    "WITH p AS (SELECT ticker, performance_as_of, ytd_return_percent FROM spdr.main.products " +
    "WHERE ticker = 'SPY'), " +
    "n AS (SELECT as_of_date, nav FROM spdr.main.nav_history('SPY', start_date := DATE '2025-12-31')) " +
    "SELECT p.ticker, p.performance_as_of, " +
    "round(100 * (arg_max(n.nav, n.as_of_date) / arg_min(n.nav, n.as_of_date) - 1), 2) AS nav_change_percent, " +
    "p.ytd_return_percent " +
    "FROM p JOIN n ON n.as_of_date <= p.performance_as_of " +
    "GROUP BY p.ticker, p.performance_as_of, p.ytd_return_percent ORDER BY p.ticker",
};

/** Every composed example, in schema-list order. */
export const COMPOSED_EXAMPLES: ExampleQuery[] = [
  BIGGEST_EQUITY_FUNDS_TOP_HOLDING,
  SPY_POSITION_DOLLARS,
  SPY_NAV_VS_REPORTED_YTD,
];
