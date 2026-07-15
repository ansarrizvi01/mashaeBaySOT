# MashaUSA eBay Facts Actor — Lean v2

This version extracts only the data needed for later product-description generation.

## Kept
- Shopify/eBay identifiers
- eBay title
- Product-specific seller text only
- eBay page item specifics
- Label/value facts parsed from the seller description
- Combined specifics
- Status, warnings, timestamp, source hash

## Removed
- Images
- Price and availability
- Seller profile
- Shipping and returns
- Category breadcrumbs
- JSON-LD
- Full seller-description HTML
- Full page HTML on successful runs
- Generic policy/brand boilerplate

Images, stylesheets, fonts, video, media, and common analytics requests are blocked during crawling.

## Update existing GitHub Actor
Replace these files in your repository:
- `src/main.js`
- `package.json`
- `.actor/input_schema.json`
- `.actor/dataset_schema.json`

Commit the changes, then build a new Actor version in Apify.

## Test input
Use `examples/INPUT_SINGLE_TEST.json`. Start with concurrency 1. A successful record should contain `product_source_text`, `description_specifics`, and `combined_specifics`.

## Cost guidance
The largest remaining cost is residential proxy traffic and browser runtime. For production:
- test 10 URLs at concurrency 3
- then use batches of 250 with concurrency 5
- keep `saveFailureSnapshots` false unless diagnosing failures
- leave the wait at 1200 ms unless descriptions are missing
