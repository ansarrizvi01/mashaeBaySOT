# MashaUSA eBay Source Extractor — Apify Actor

This Actor performs one job only:

> Visit live eBay listing URLs and save raw, structured source data for the MashaUSA Source of Truth pipeline.

It does **not** classify products, infer artists, generate descriptions, assign Shopify templates, or publish to Shopify.

## Extracted fields

- Passed-through Shopify and batch identifiers from `userData`
- eBay item ID and canonical URL
- Product title
- Full seller-description text and HTML when eBay exposes it
- Item specifics as both an object and raw name/value pairs
- Variation controls
- Product images
- Price and currency
- Condition and availability
- Seller
- Shipping and returns text
- Category breadcrumbs
- JSON-LD source objects
- Extraction status, warnings, timestamp, and source hash
- Failure HTML and screenshot in the default key-value store

## Deploy to Apify

### Method A — Apify Console with GitHub

1. Extract this ZIP.
2. Create a new private GitHub repository.
3. Upload the contents of this folder to the repository root.
4. In Apify Console, open **Actors → Create new → From Git repository**.
5. Connect the repository.
6. Build the Actor.
7. Open its **Input** tab.

### Method B — Apify CLI

Install and log in:

```bash
npm install -g apify-cli
apify login
```

From this project folder:

```bash
apify push
```

Apify reads `.actor/actor.json`, the input/output schemas, and the Dockerfile automatically.

## First test

Use `examples/INPUT_SINGLE_TEST.json`.

In Apify Console:

1. Open the Actor.
2. Choose **Input → JSON**.
3. Replace the existing input with the file contents.
4. Set `maxConcurrency` to `1`.
5. Run the Actor.
6. Open **Dataset → Overview**.

The record should contain:

- `title`
- `seller_description_text`
- `item_specifics`
- `images`
- `ebay_item_id`
- your passed-through Shopify identifiers
- `extraction_status`

## Entering URLs in the visual editor

The `eBay listing URLs` field accepts request objects.

For a URL only:

```json
{"url":"https://www.ebay.com/itm/254390229484"}
```

For a linked Shopify record:

```json
{
  "url": "https://www.ebay.com/itm/254390229484",
  "userData": {
    "source_record_id": "MASHA-123-254390229484",
    "shopify_product_id": "123",
    "shopify_handle": "example-handle",
    "shopify_sku": "03471",
    "batch_id": "01_Rings_B01"
  }
}
```

When using **Bulk edit**, paste one plain URL per line only. Bulk edit cannot attach `userData`. For the permanent Source of Truth workflow, use the JSON editor so Shopify identifiers travel with each URL.

## Recommended rollout

1. One listing, concurrency 1
2. Ten mixed listings, concurrency 2
3. Fifty listings, concurrency 3
4. First 250-listing batch, concurrency 3–5
5. Increase only after checking description and item-specific completeness

## Proxy guidance

The default input enables Apify Proxy. If eBay returns challenge pages:

- keep concurrency low
- use a residential proxy group if your Apify plan supports it
- do not build CAPTCHA bypassing into this Actor
- retry failed records in a later run

## Understanding status

- `complete`: description and item specifics were found without warnings
- `partial`: page loaded, but one or more important sections were missing
- `failed`: navigation, challenge, or parsing failed after retries

A `partial` record remains useful and includes all successfully captured source data.

## Export

Open the Actor run's default dataset and export:

- JSON for the authoritative nested source record
- CSV or XLSX for manual review

JSON should be retained permanently because item specifics, variations, seller, and JSON-LD are nested structures.

## Important limitation

eBay changes page markup and may present different layouts by locale, account, category, or experiment. This Actor uses multiple extraction strategies, but seller-description availability should be benchmarked before running the full catalog.
