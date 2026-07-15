# MashaUSA eBay Description Facts Actor v2.2

This Actor extracts only data needed to generate Shopify product descriptions, featured sections, SEO, AEO, and metafields.

## Output
- Shopify/eBay identity
- eBay title
- clean product-specific seller text when available
- canonical `facts` object
- `fact_evidence` showing the original eBay label and source
- status, warnings, timestamp, and source hash

It excludes price, shipping, delivery, returns, payments, discounts, seller profile, images, JSON-LD, raw HTML, and generic brand boilerplate.

Replace your existing Actor repository contents with this package, commit, build latest version, then run the same input.
