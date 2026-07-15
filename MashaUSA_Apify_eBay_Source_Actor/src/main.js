import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestList } from 'crawlee';
import crypto from 'node:crypto';

const cleanText = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return text || null;
};

const firstNonEmpty = (...values) => {
    for (const value of values) {
        const cleaned = cleanText(value);
        if (cleaned) return cleaned;
    }
    return null;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const extractItemId = (url) => {
    const match = String(url || '').match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/i)
        || String(url || '').match(/[?&]item=(\d{9,15})/i);
    return match?.[1] || null;
};

const normalizeStartUrls = (startUrls) => {
    return startUrls.map((entry, index) => {
        if (typeof entry === 'string') {
            return { url: entry, userData: { input_index: index } };
        }
        return {
            ...entry,
            userData: {
                input_index: index,
                ...(entry.userData || {}),
            },
        };
    });
};

const flattenJsonLd = (value, output = []) => {
    if (!value) return output;
    if (Array.isArray(value)) {
        for (const item of value) flattenJsonLd(item, output);
        return output;
    }
    if (typeof value === 'object') {
        if (Array.isArray(value['@graph'])) flattenJsonLd(value['@graph'], output);
        output.push(value);
    }
    return output;
};

const findProductJsonLd = (items) => {
    return items.find((item) => {
        const type = item?.['@type'];
        return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    }) || {};
};

const objectFromPairs = (pairs) => {
    const result = {};
    for (const pair of pairs) {
        const key = cleanText(pair?.name);
        const value = cleanText(pair?.value);
        if (!key || !value) continue;
        if (result[key] === undefined) result[key] = value;
        else if (Array.isArray(result[key])) result[key].push(value);
        else if (result[key] !== value) result[key] = [result[key], value];
    }
    return result;
};

const safeLocatorText = async (locator) => {
    try {
        if (await locator.count()) return cleanText(await locator.first().innerText({ timeout: 3000 }));
    } catch {}
    return null;
};

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    maxConcurrency = 3,
    maxRequestsPerCrawl = 0,
    navigationTimeoutSecs = 60,
    requestHandlerTimeoutSecs = 120,
    waitAfterLoadMs = 2500,
    saveFailureSnapshots = true,
    includeRawHtml = false,
    proxyConfiguration: proxyInput = { useApifyProxy: true },
} = input;

if (!Array.isArray(startUrls) || startUrls.length === 0) {
    throw new Error('Input must include at least one eBay listing in startUrls.');
}

const normalizedUrls = normalizeStartUrls(startUrls);
const requestList = await RequestList.open('ebay-listings', normalizedUrls);
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const crawler = new PlaywrightCrawler({
    requestList,
    proxyConfiguration,
    maxConcurrency,
    maxRequestsPerCrawl: maxRequestsPerCrawl > 0 ? maxRequestsPerCrawl : undefined,
    navigationTimeoutSecs,
    requestHandlerTimeoutSecs,
    maxRequestRetries: 3,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            await page.setExtraHTTPHeaders({
                'accept-language': 'en-US,en;q=0.9',
                'upgrade-insecure-requests': '1',
            });
            await page.route(/\.(?:woff2?|ttf|otf)(?:\?.*)?$/i, (route) => route.abort());
        },
    ],
    async requestHandler({ request, page, response }) {
        const fetchedAt = new Date().toISOString();
        const warnings = [];
        const userData = request.userData || {};
        const url = request.loadedUrl || request.url;
        const ebayItemId = extractItemId(url) || extractItemId(request.url);

        await page.waitForTimeout(waitAfterLoadMs);

        const bodyText = cleanText(await page.locator('body').innerText().catch(() => '')) || '';
        const lowerBody = bodyText.toLowerCase();
        const challenged = [
            'pardon our interruption',
            'verify yourself',
            'security measure',
            'robot check',
            'captcha',
        ].some((needle) => lowerBody.includes(needle));

        if (challenged) {
            throw new Error('eBay challenge or CAPTCHA page detected.');
        }

        const raw = await page.evaluate(() => {
            const trim = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
            const text = (selector) => {
                const el = document.querySelector(selector);
                return el ? trim(el.textContent) : null;
            };
            const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || null;
            const allText = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => trim(el.textContent)).filter(Boolean);

            const jsonLd = [];
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    jsonLd.push(JSON.parse(script.textContent));
                } catch {}
            }

            const pairs = [];
            const pairKeys = new Set();
            const addPair = (name, value, source) => {
                name = trim(name);
                value = trim(value);
                if (!name || !value || name.length > 100 || value.length > 1000) return;
                const signature = `${name.toLowerCase()}||${value.toLowerCase()}`;
                if (pairKeys.has(signature)) return;
                pairKeys.add(signature);
                pairs.push({ name, value, source });
            };

            for (const dl of document.querySelectorAll('dl')) {
                const terms = Array.from(dl.querySelectorAll(':scope > dt'));
                for (const dt of terms) {
                    let dd = dt.nextElementSibling;
                    if (dd?.tagName === 'DD') addPair(dt.textContent, dd.textContent, 'dl');
                }
            }

            for (const row of document.querySelectorAll('tr')) {
                const cells = Array.from(row.querySelectorAll(':scope > th, :scope > td'));
                if (cells.length === 2) addPair(cells[0].textContent, cells[1].textContent, 'table');
            }

            const specificSelectors = [
                '[data-testid*="ux-labels-values"]',
                '.ux-labels-values',
                '.ux-layout-section__item',
                '.ux-layout-section-evo__item',
            ];
            for (const selector of specificSelectors) {
                for (const block of document.querySelectorAll(selector)) {
                    const labels = block.querySelectorAll('.ux-labels-values__labels, .ux-labels-values__labels-content, dt');
                    const values = block.querySelectorAll('.ux-labels-values__values, .ux-labels-values__values-content, dd');
                    if (labels.length && values.length) {
                        addPair(labels[0].textContent, values[0].textContent, selector);
                    }
                }
            }

            const imageUrls = new Set();
            for (const img of document.querySelectorAll('img')) {
                const candidates = [
                    img.currentSrc,
                    img.src,
                    img.getAttribute('data-src'),
                    img.getAttribute('data-zoom-src'),
                    img.getAttribute('data-original'),
                ];
                for (const candidate of candidates) {
                    if (candidate && /^https?:\/\//i.test(candidate) && /ebayimg|i\.ebayimg/i.test(candidate)) {
                        imageUrls.add(candidate.replace(/s-l\d+/i, 's-l1600'));
                    }
                }
            }

            const breadcrumbs = allText('nav[aria-label*="breadcrumb" i] a, .breadcrumbs a, [class*="breadcrumb"] a');

            const iframeSources = Array.from(document.querySelectorAll('iframe'))
                .map((iframe) => iframe.src)
                .filter((src) => src && /ebaydesc|description|vipr/i.test(src));

            return {
                title: text('h1') || text('[data-testid="x-item-title"]') || attr('meta[property="og:title"]', 'content') || document.title,
                canonicalUrl: attr('link[rel="canonical"]', 'href'),
                ogImage: attr('meta[property="og:image"]', 'content'),
                metaDescription: attr('meta[name="description"]', 'content'),
                jsonLd,
                itemSpecificPairs: pairs,
                images: Array.from(imageUrls),
                breadcrumbs,
                iframeSources,
                pageText: trim(document.body?.innerText || ''),
            };
        });

        const jsonLdItems = flattenJsonLd(raw.jsonLd);
        const productLd = findProductJsonLd(jsonLdItems);
        const offer = Array.isArray(productLd.offers) ? productLd.offers[0] || {} : productLd.offers || {};

        let sellerDescriptionHtml = null;
        let sellerDescriptionText = null;

        const descriptionFrame = page.frames().find((frame) => /ebaydesc|description|vipr/i.test(frame.url()));
        if (descriptionFrame) {
            try {
                await descriptionFrame.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                sellerDescriptionHtml = await descriptionFrame.locator('body').innerHTML({ timeout: 5000 });
                sellerDescriptionText = cleanText(await descriptionFrame.locator('body').innerText({ timeout: 5000 }));
            } catch {
                warnings.push('description_frame_unreadable');
            }
        }

        if (!sellerDescriptionText) {
            const headingSelectors = [
                'text=/Item description from the seller/i',
                'text=/Seller description/i',
                '#vi-desc-maincntr',
                '[data-testid*="description"]',
            ];
            for (const selector of headingSelectors) {
                const locator = page.locator(selector);
                const candidate = await safeLocatorText(locator);
                if (candidate && candidate.length > 80) {
                    sellerDescriptionText = candidate;
                    sellerDescriptionHtml = await locator.first().innerHTML().catch(() => null);
                    break;
                }
            }
        }

        if (!sellerDescriptionText && raw.iframeSources.length) {
            warnings.push('description_iframe_present_but_empty');
        }
        if (!sellerDescriptionText) {
            warnings.push('seller_description_missing');
        }

        const itemSpecifics = objectFromPairs(raw.itemSpecificPairs);
        if (Object.keys(itemSpecifics).length === 0) warnings.push('item_specifics_missing');

        const price = firstNonEmpty(
            offer.price,
            await safeLocatorText(page.locator('[itemprop="price"]')),
            await safeLocatorText(page.locator('.x-price-primary')),
            await safeLocatorText(page.locator('[data-testid*="price"]')),
        );
        const currency = firstNonEmpty(
            offer.priceCurrency,
            await page.locator('[itemprop="priceCurrency"]').first().getAttribute('content').catch(() => null),
        );
        const condition = firstNonEmpty(
            productLd.itemCondition?.split('/').pop(),
            itemSpecifics.Condition,
            await safeLocatorText(page.locator('[data-testid*="condition"]')),
        );
        const availability = firstNonEmpty(
            offer.availability?.split('/').pop(),
            await safeLocatorText(page.locator('[data-testid*="availability"]')),
        );

        const title = firstNonEmpty(productLd.name, raw.title);
        const images = unique([
            ...(Array.isArray(productLd.image) ? productLd.image : [productLd.image]),
            raw.ogImage,
            ...raw.images,
        ]);

        const sellerName = firstNonEmpty(
            offer.seller?.name,
            productLd.seller?.name,
            await safeLocatorText(page.locator('[data-testid*="ux-seller-section"] a')),
            await safeLocatorText(page.locator('.x-sellercard-atf__info__about-seller a')),
        );

        const shippingText = firstNonEmpty(
            await safeLocatorText(page.locator('[data-testid*="shipping"]')),
            await safeLocatorText(page.locator('#shSummary')),
        );
        const returnsText = firstNonEmpty(
            await safeLocatorText(page.locator('[data-testid*="returns"]')),
            await safeLocatorText(page.locator('#returns')),
        );

        const variationText = await safeLocatorText(page.locator('select, [role="listbox"], [data-testid*="variation"]'));
        const variations = variationText ? [{ raw_text: variationText }] : [];

        const sourceMaterial = JSON.stringify({
            title,
            sellerDescriptionText,
            itemSpecifics,
            variations,
            images,
            price,
            currency,
            condition,
            availability,
        });
        const sourceHash = crypto.createHash('sha256').update(sourceMaterial).digest('hex');

        const record = {
            source_record_id: userData.source_record_id ?? null,
            batch_id: userData.batch_id ?? null,
            shopify_product_id: userData.shopify_product_id ?? null,
            shopify_handle: userData.shopify_handle ?? null,
            shopify_sku: userData.shopify_sku ?? null,
            ...userData,
            ebay_item_id: ebayItemId,
            url: request.url,
            loaded_url: url,
            canonical_url: raw.canonicalUrl || null,
            http_status: response?.status() ?? null,
            title,
            meta_description: raw.metaDescription || null,
            seller_description_text: sellerDescriptionText,
            seller_description_html: sellerDescriptionHtml,
            item_specifics: itemSpecifics,
            item_specific_pairs: raw.itemSpecificPairs,
            variations,
            images,
            price,
            currency,
            condition,
            availability,
            seller: {
                name: sellerName,
                raw: offer.seller || productLd.seller || null,
            },
            shipping: {
                text: shippingText,
                raw: offer.shippingDetails || null,
            },
            returns: {
                text: returnsText,
                raw: offer.hasMerchantReturnPolicy || null,
            },
            category_breadcrumbs: raw.breadcrumbs,
            json_ld: jsonLdItems,
            extraction_status: warnings.length ? 'partial' : 'complete',
            warnings,
            error: null,
            fetched_at: fetchedAt,
            source_hash: sourceHash,
            ...(includeRawHtml ? { raw_page_html: await page.content() } : {}),
        };

        await Actor.pushData(record);
        log.info(`Saved ${ebayItemId || request.url}`, {
            status: record.extraction_status,
            specifics: Object.keys(itemSpecifics).length,
            descriptionLength: sellerDescriptionText?.length || 0,
        });
    },
    async failedRequestHandler({ request, page, error }) {
        const fetchedAt = new Date().toISOString();
        const ebayItemId = extractItemId(request.loadedUrl || request.url);
        const keyBase = `failures/${ebayItemId || request.id || Date.now()}`;

        if (saveFailureSnapshots && page) {
            try {
                await Actor.setValue(`${keyBase}.html`, await page.content(), { contentType: 'text/html; charset=utf-8' });
                await Actor.setValue(`${keyBase}.png`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
            } catch (snapshotError) {
                log.warning('Could not save failure snapshot', { error: snapshotError.message });
            }
        }

        await Actor.pushData({
            source_record_id: request.userData?.source_record_id ?? null,
            batch_id: request.userData?.batch_id ?? null,
            shopify_product_id: request.userData?.shopify_product_id ?? null,
            shopify_handle: request.userData?.shopify_handle ?? null,
            shopify_sku: request.userData?.shopify_sku ?? null,
            ...request.userData,
            ebay_item_id: ebayItemId,
            url: request.url,
            loaded_url: request.loadedUrl || null,
            title: null,
            seller_description_text: null,
            seller_description_html: null,
            item_specifics: {},
            variations: [],
            images: [],
            price: null,
            currency: null,
            condition: null,
            availability: null,
            seller: {},
            shipping: {},
            returns: {},
            category_breadcrumbs: [],
            json_ld: [],
            extraction_status: 'failed',
            warnings: [],
            error: error?.message || String(error),
            failure_snapshot_key: saveFailureSnapshots ? keyBase : null,
            fetched_at: fetchedAt,
            source_hash: null,
        });
    },
});

await crawler.run();
await Actor.exit();
