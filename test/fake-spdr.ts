// A tiny in-process fake of the SSGA endpoints — enough to prove the driver: it records every
// requested URL (so a test can assert the wire contract) and returns canned data shaped like
// the real fund-finder JSON and the holdings / NAV spreadsheets. No network.
//
// The driver takes two injected transports: `get(url) => Promise<unknown>` (JSON) and
// `getBytes(url) => Promise<Uint8Array>` (an .xlsx buffer). We build real .xlsx buffers from
// row matrices with SheetJS so the byte-decode path (readXlsxMatrix) is exercised too.

import * as XLSX from "xlsx";

export class FakeSpdr {
  /** Every JSON URL this fake was asked for, in order. */
  readonly calls: string[] = [];
  /** Every byte URL this fake was asked for, in order. */
  readonly byteCalls: string[] = [];

  constructor(
    private readonly json: (url: string) => unknown,
    private readonly bytes: (url: string) => Uint8Array = () => new Uint8Array(),
  ) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.json(url);
  };

  getBytes = async (url: string): Promise<Uint8Array> => {
    this.byteCalls.push(url);
    return this.bytes(url);
  };

  /** Route byte requests by ticker in the URL to a matrix, encoded as a real .xlsx buffer. */
  static withHoldings(
    json: unknown,
    holdings: Record<string, unknown[][]>,
    nav: Record<string, unknown[][]> = {},
  ): FakeSpdr {
    return new FakeSpdr(
      () => json,
      (url) => {
        for (const [ticker, matrix] of Object.entries(holdings)) {
          if (url.includes(`holdings-daily-us-en-${ticker.toLowerCase()}.xlsx`)) {
            return matrixToXlsx(matrix);
          }
        }
        for (const [ticker, matrix] of Object.entries(nav)) {
          if (url.includes(`navhist-us-en-${ticker.toLowerCase()}.xlsx`)) {
            return matrixToXlsx(matrix);
          }
        }
        throw new Error(`404 for ${url}`);
      },
    );
  }
}

/** Encode a row matrix into a real .xlsx byte buffer (first sheet). */
export function matrixToXlsx(matrix: unknown[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(matrix as any[][]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// ── fund-finder envelope ────────────────────────────────────────────────────────

/**
 * A fund-finder envelope with two ETFs (an equity fund and a bond fund) covering [display, raw]
 * pairs, the "-" "no data" sentinel (the yr10 field), the keywords ISIN/CUSIP shape, and the
 * categories asset-class tree.
 */
export function fundFinderEnvelope(): Record<string, unknown> {
  return {
    status: "ok",
    data: {
      fundType: [{ key: "etfs", name: "ETFs", size: 2 }],
      funds: {
        etfs: {
          datas: [
            {
              domicile: "US",
              fundName: "State Street® SPDR® S&P 500® ETF Trust",
              fundTicker: "SPY®",
              fundFilter: "SPY",
              fundUri: "/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy",
              keywords: "State Street® SPDR® S&P 500® ETF Trust, SPY, Equity, SPY US, US78462F1030, 78462F103, Core",
              ter: ["0.09%", 0.0945],
              nav: ["$747.70", 747.704983],
              aum: ["$780,067.24 M", 780067.24],
              asOfDate: ["Jul 07 2026", "2026-07-07"],
              PerfAsOf: ["Jun 30 2026", "2026-06-30"],
              inceptionDate: ["Jan 22 1993", "1993-01-22"],
              primaryExchange: "NYSE ARCA",
              closePrice: ["$751.08", 751.08],
              bidAsk: ["$751.06", 751.06],
              premiumDiscount: ["-0.02%", -0.02],
              mo1: ["1.50%", 1.5],
              qtd: ["3.20%", 3.2],
              ytd: ["8.10%", 8.1],
              yr1: ["12.00%", 12.0],
              yr3: ["15.00%", 15.0],
              yr5: ["14.00%", 14.0],
              yr10: ["-", -5e-324], // sentinel → null
              sinceInception: ["9.50%", 9.5],
            },
            {
              domicile: "US",
              fundName: "State Street® SPDR® Bloomberg 1-3 Month T-Bill ETF",
              fundTicker: "BIL®",
              fundFilter: "BIL",
              fundUri: "/us/en/intermediary/etfs/spdr-bloomberg-1-3-month-t-bill-etf-bil",
              keywords: "State Street® SPDR® Bloomberg 1-3 Month T-Bill ETF, BIL, Fixed Income, BIL US, US78468R6633, 78468R663, Government",
              ter: ["0.1356%", 0.1356],
              nav: ["$91.60", 91.6],
              aum: ["$45,000.00 M", 45000.0],
              asOfDate: ["Jul 07 2026", "2026-07-07"],
              PerfAsOf: ["Jun 30 2026", "2026-06-30"],
              inceptionDate: ["May 25 2007", "2007-05-25"],
              primaryExchange: "NYSE ARCA",
              closePrice: ["$91.61", 91.61],
              bidAsk: ["$91.60", 91.6],
              premiumDiscount: ["0.01%", 0.01],
              mo1: ["0.35%", 0.35],
              qtd: ["1.05%", 1.05],
              ytd: ["2.10%", 2.1],
              yr1: ["4.90%", 4.9],
              yr3: ["4.50%", 4.5],
              yr5: ["2.60%", 2.6],
              yr10: ["1.70%", 1.7],
              sinceInception: ["1.20%", 1.2],
            },
          ],
          categories: [
            {
              key: "assetclass",
              name: "Asset Class",
              subCategories: [
                { key: "equity", name: "Equity", funds: "SPY", size: 1 },
                { key: "fi", name: "Fixed Income Sector", funds: "BIL", size: 1 },
              ],
            },
          ],
        },
      },
    },
  };
}

// ── holdings matrices (as SheetJS's header:1 array-of-arrays) ───────────────────

/** An equity holdings matrix (SPY-shaped): Name/Ticker/Identifier/SEDOL/Weight/Sector/Shares Held/Local Currency. */
export function equityHoldingsMatrix(): unknown[][] {
  return [
    ["Fund Name:", "State Street® SPDR® S&P 500® ETF Trust"],
    ["Ticker Symbol:", "SPY"],
    ["Holdings:", "As of 07-Jul-2026"],
    [],
    ["Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held", "Local Currency"],
    // Intentionally NOT weight-ordered, to prove the parser sorts desc.
    ["APPLE INC", "AAPL", "037833100", "2046251", 7.06, "-", 201790031, "USD"],
    ["NVIDIA CORP", "NVDA", "67066G104", "2379504", 7.39, "-", 293365886, "USD"],
    ["CONTRA HOLOGIC INCORPO", "2602335D", "436CVR021", "-", 0.000003, "-", 2578626, "USD"],
    [],
    ["State Street Global Advisors (SSGA) is now State Street Investment Management."],
    ["Distributor: State Street Global Advisors Funds Distributors, LLC."],
  ];
}

/** A bond holdings matrix (BIL-shaped): Name/Identifier/SEDOL/Weight/Coupon/Par Value/Market Value/Local Currency/Maturity. */
export function bondHoldingsMatrix(): unknown[][] {
  return [
    ["Fund Name:", "State Street® SPDR® Bloomberg 1-3 Month T-Bill ETF"],
    ["Ticker Symbol:", "BIL"],
    ["Holdings:", "As of 07-Jul-2026"],
    [],
    ["Name", "Identifier", "SEDOL", "Weight", "Coupon", "Par Value", "Market Value", "Local Currency", "Maturity"],
    ["TREASURY BILL 08/26 0.00000", "US912797RG48", "-", 12.142225, 0, 5638534000, 5622243542.26, "USD", "08/06/2026"],
    ["TREASURY BILL 09/26 0.00000", "US912797RS85", "BVN7R03", 9.117073, 0, 4245950000, 4221499994.14, "USD", "09/03/2026"],
    [],
    ["Distributor: State Street Global Advisors Funds Distributors, LLC."],
  ];
}

// ── NAV-history matrix ──────────────────────────────────────────────────────────

/** A NAV-history matrix (SPY-shaped): Date/NAV/Shares Outstanding/Total Net Assets. */
export function navHistoryMatrix(): unknown[][] {
  return [
    ["Fund Name:", "State Street® SPDR® S&P 500® ETF Trust"],
    ["Ticker Symbol:", "SPY"],
    [],
    ["Date", "NAV", "Shares Outstanding", "Total Net Assets"],
    ["07-Jul-2026", 747.704983, 1043282116, 780067236411.23],
    ["06-Jul-2026", 751.046506, 1044532116, 784492196243.04],
    ["02-Jul-2026", 745.574772, 1049032116, 782131880609.17],
    [],
    ["Past performance is not a reliable indicator of future performance."],
  ];
}
