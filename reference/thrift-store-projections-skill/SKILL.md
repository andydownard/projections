---
name: thrift-store-projections
description: "Create or update a bottom-up 3-year financial projection for a nonprofit thrift store, driven by donor market share. Use when the user asks for a thrift store projection, thrift store pro forma, store financial model, donor-market-share model, or wants to refresh an existing projection with new assumptions. Produces a 1-page Word summary and an editable, formula-driven Excel model that keeps a standard thrift income-statement line-item set."
---

# Thrift Store Projections

Build a 3-year projection for a nonprofit thrift store using a **bottom-up, donor-market-share** method. The model starts from how many households in a city donate, converts donations into revenue, and derives customers and expenses from there. It outputs two files:

1. **`<Org> 3-Year Projection.docx`** — a clean one-page summary, simple to read and forward.
2. **`<Org> 3-Year Projection.xlsx`** — a live, formula-driven model. All assumptions sit in blue input cells at the top; every projection line recalculates when an input changes.

## The model (how the numbers connect)

```
donating households = city households × donor market share
annual donations    = donating households × donations per household per year (default 3)
retail revenue      = annual donations × average value per donation
customers           = retail revenue ÷ average transaction value
salvage sales       = retail revenue × salvage %        (default 0.8%)
total revenue       = retail + salvage
```

Expenses (standard thrift line items, kept identical every run):
Credit card fees (% of revenue) · Insurance liability · Internet, Phones · Payroll (labor % of revenue) ·
Payroll taxes (% of payroll) · Pest control · Rent (sq ft × rent per sq ft) · Repairs/maintenance ·
Security system · Store/office supplies · Utilities/trash service.

`Net profit = Total revenue − Total expenses`. Year 2 donor market share is always the **midpoint** of Year 1 and Year 3.

## Workflow

### Step 1 — Gather the inputs (use the AskUserQuestion tool)

Ask the user these questions. Offer sensible options but always allow a custom number.

1. **Organization name.**
2. **City** (used to research the number of households).
3. **Donor market share — Year 1 and Year 3** (Year 2 = midpoint). Remind them the average household donates ~3× a year.
4. **Average value of a donation** ($) — sets top-line revenue.
5. **Average transaction value** ($) — sets the number of customers.
6. **Store size** (sq ft) — used to research the local rent rate.
7. **Rent per sq ft per year** ($) — suggest the researched local rate as the default.
8. **Labor as a % of revenue** (default 60%).

Optional overrides (otherwise use defaults): salvage % of retail (0.8%), credit card fees % of revenue (2.0%), payroll tax % of payroll (7.5%), the seven fixed annual costs, and the startup-cost line items.

### Step 2 — Research the city

Use web search for two numbers and cite the sources:
- **Households in the city** (U.S. Census / QuickFacts — use "households," not population).
- **Retail rent benchmark** ($/sq ft/year) for that city, to suggest the rent input and sanity-check the user's figure.

### Step 3 — Write the config and generate

Create a `config.json` (see `examples/house_of_hope.json`) and run the generator from a writable output folder:

```bash
pip install python-docx openpyxl --break-system-packages -q
python3 scripts/generate_projection.py config.json /path/to/output_dir
```

Config keys: `org_name`, `city`, `households`, `share_y1`, `share_y3`, `donation_value`,
`transaction_value`, `sqft`, `rent_per_sqft`. Optional: `labor_pct`, `salvage_pct`, `cc_pct`,
`payroll_tax_pct`, `donate_freq`, `fixed` (object), `startup` (object). Percentages are decimals (0.38 = 38%).

### Step 4 — Recalculate and verify (mandatory)

The Excel file stores formulas; recalculate so cached values are correct and there are zero errors:

```bash
python3 scripts/recalc.py "/path/to/output_dir/<Org> 3-Year Projection.xlsx"
```

Confirm `"total_errors": 0`. Then confirm the Word doc is **one page** (convert to PDF and check page count). Excel and Google Sheets also recalculate automatically when the user opens the file.

### Step 5 — Deliver

Save both files to the user's folder and present them. Briefly note the headline Year 1 figures (donations, customers, revenue, net profit) and how to change assumptions (edit the blue cells in the spreadsheet, or re-run with a new config).

## Updating an existing projection

To revise a projection, either (a) change the blue input cells in the spreadsheet directly — every line recalculates — or (b) edit `config.json` and re-run the generator to regenerate both files. Always recalc and re-check one page after regenerating.

## Sanity checks

- A first-year donor market share of roughly 5–8% of households is typical for an established store; flag to the user if their share implies donations far above local benchmarks.
- Keep an eye on net margin. Fixed costs do not scale with revenue in this model, so very high market-share assumptions produce unusually high margins — tell the user so they can raise labor %, utilities, or supplies if they expect a larger cost base.

## Files

- `scripts/generate_projection.py` — engine + Word and Excel builders. Holds the default assumptions.
- `scripts/recalc.py` — recalculates the workbook with LibreOffice and reports formula errors.
- `reference/methodology.md` — the full method, formula-by-formula, with the standard line items.
- `examples/house_of_hope.json` — a worked config (House of Hope, Longview TX).
