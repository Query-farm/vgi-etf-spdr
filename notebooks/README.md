# SPDR notebooks

[01 · Does a change in fund assets mean the same thing as a change in NAV?](01_nav_and_assets_have_different_denominators.ipynb) reconciles SPY NAV per share, shares outstanding and total net assets for the first half of 2024. Indexed paths and an exact endpoint decomposition separate the three quantities. The experiment changes only the baseline date from January 2 to April 1.

## Run

Requirements: [uv](https://docs.astral.sh/uv/), Python 3.13+ (uv can install it), and internet access to GitHub/package sources and State Street. No API key, Bun installation, spreadsheet application or worker checkout is needed.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py --timeout 300
```

The locked environment uses Haybarn 2.0.0rc11. Visible SQL attaches `github-auto://Query-farm/vgi-etf-spdr@v0.4.0`, release commit `f09f888bae29cbd9e5abbfb855bc4e5cf2ba3e7e`. VGI downloads the native platform asset, checks the published SHA-256 and caches the executable. Upgrade the pinned release deliberately and rerun defaults and the experiment.

Optional editor kernel:

```sh
uv run --locked python -m ipykernel install --user --name vgi-etf-spdr-notebooks --display-name "Python (vgi-etf-spdr notebooks)"
```

Use this directory as the working directory, then Restart Kernel → Run All. The runner creates a temporary kernel registration and saves output only after all cells succeed.

## Separate experiment

```sh
uv run --locked python execute.py --timeout 300 --parameters '{"BASE_DATE":"2024-04-01"}' --output-dir artifacts/april-baseline
```

Overrides require a separate destination. Branding, docs, runner and locked environment accompany the copy. Restore `2024-01-02` for defaults. Generated artifacts, extracted charts and virtual environments are ignored.

## Source, units and limits

Source: [State Street SPY product page](https://www.ssga.com/us/en/intermediary/etfs/state-street-spdr-sp-500-etf-trust-spy) and its [historical NAV workbook](https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-spy.xlsx). The real released worker downloads one full workbook and filters it to inclusive DATE bounds January 1–June 30, 2024. Those bounds limit returned rows, not network download size. Later analysis uses the single materialized result. No synthetic or replay fallback is provided.

Calendar dates have no timezone; UTC acquisition bounds are displayed separately. The endpoint is the last observed date within the window. The notebook does not create weekend/holiday rows or certify completeness against an exchange calendar. Missing, nonpositive, duplicated-date or materially inconsistent data stop the calculation. A one-part-per-million relative tolerance checks that total net assets approximately equal NAV times shares outstanding, allowing reported rounding.

For SPY, NAV is USD per share, outstanding shares are shares and workbook assets are USD, not USD millions. The indexed series compare relative changes, not raw units. They are not total-return series: no distribution reinvestment is calculated. The exact endpoint expansion retains NAV, share-count and interaction terms plus the reported-assets reconciliation residual. None is labeled as net cash flow or a causal effect; endpoint shares do not reveal intermediate timing, prices or in-kind creation/redemption mechanics.

The full-window fingerprint should remain unchanged in the baseline-date experiment, but the publisher can revise historical workbook values. A matching fingerprint isolates the baseline effect; changed inputs must be assessed separately. This example is descriptive and makes no investment recommendation.
