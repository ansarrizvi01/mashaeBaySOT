import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestList } from 'crawlee';
import crypto from 'node:crypto';

const clean = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return s || null;
};

const itemIdFrom = (u) => String(u || '').match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/i)?.[1] || null;
const normalizeUrls = (xs) => xs.map((x, i) => typeof x === 'string'
    ? { url: x, userData: { input_index: i } }
    : ({ ...x, userData: { input_index: i, ...(x.userData || {}) } }));

const normalizeLabel = (label) => clean(label)?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || '';

// Only facts that can materially improve the product page, SEO, AEO, sizing, or attribution.
const FIELD_ALIASES = new Map([
    ['type', 'product_type'],
    ['product type', 'product_type'],
    ['style', 'style'],
    ['ethnic regional style', 'regional_style'],
    ['regional style', 'regional_style'],
    ['ethnic origin', 'ethnic_origin'],
    ['artisan', 'artist'],
    ['artist', 'artist'],
    ['maker', 'artist'],
    ['tribal affiliation', 'tribal_affiliation'],
    ['signed', 'signed'],
    ['handmade', 'handmade'],
    ['customized', 'customized'],
    ['vintage', 'vintage'],
    ['antique', 'antique'],
    ['country of origin', 'country_of_origin'],
    ['country region of manufacture', 'country_of_origin'],
    ['materials sourced from', 'materials_sourced_from'],
    ['main stone', 'main_stone'],
    ['secondary stone', 'secondary_stone'],
    ['main stone color', 'main_stone_color'],
    ['stone color', 'main_stone_color'],
    ['color', 'color'],
    ['main stone shape', 'main_stone_shape'],
    ['stone shape', 'main_stone_shape'],
    ['main stone creation', 'main_stone_creation'],
    ['stone creation', 'main_stone_creation'],
    ['main stone treatment', 'main_stone_treatment'],
    ['stone treatment', 'main_stone_treatment'],
    ['number of gemstones', 'number_of_gemstones'],
    ['setting style', 'setting_style'],
    ['cut grade', 'cut_grade'],
    ['metal', 'metal'],
    ['base metal', 'base_metal'],
    ['metal purity', 'metal_purity'],
    ['purity', 'metal_purity'],
    ['material', 'material'],
    ['ring size', 'ring_size'],
    ['size', 'size'],
    ['band width', 'band_width'],
    ['top measurements', 'top_measurements'],
    ['measurements', 'measurements'],
    ['item length', 'item_length'],
    ['length', 'length'],
    ['necklace length', 'necklace_length'],
    ['bracelet length', 'bracelet_length'],
    ['inside circumference', 'inside_circumference'],
    ['opening', 'opening'],
    ['gap', 'opening'],
    ['pendant length', 'pendant_length'],
    ['pendant height', 'pendant_height'],
    ['pendant width', 'pendant_width'],
    ['bail size', 'bail_size'],
    ['closure', 'closure'],
    ['earring type', 'earring_type'],
    ['drop length', 'drop_length'],
    ['item weight', 'weight'],
    ['weight', 'weight'],
    ['condition', 'condition'],
    ['sku', 'sku'],
]);

const IGNORE_VALUES = new Set(['na', 'n/a', 'none', 'not applicable', 'unknown', '--', '-']);

const canonicalizePairs = (pairs) => {
    const facts = {};
    const evidence = {};
    for (const pair of pairs || []) {
        const rawLabel = clean(pair.name);
        const value = clean(pair.value);
        if (!rawLabel || !value) continue;
        const key = FIELD_ALIASES.get(normalizeLabel(rawLabel));
        if (!key || IGNORE_VALUES.has(value.toLowerCase())) continue;
        if (!(key in facts)) {
            facts[key] = value;
            evidence[key] = { source_label: rawLabel, source: pair.source || 'page_item_specifics' };
        } else if (facts[key] !== value) {
            const existing = Array.isArray(facts[key]) ? facts[key] : [facts[key]];
            facts[key] = [...new Set([...existing, value])];
        }
    }
    return { facts, evidence };
};

const parseDescriptionFacts = (text) => {
    const pairs = [];
    if (!text) return pairs;
    for (const raw of text.split(/\n+/)) {
        const line = clean(raw);
        if (!line || line.length > 350) continue;
        const match = line.match(/^([^:]{2,80}):\s*(.+)$/);
        if (!match) continue;
        pairs.push({ name: clean(match[1]), value: clean(match[2]), source: 'seller_description' });
    }
    return pairs;
};

const productTextOnly = (text) => {
    if (!text) return null;
    const startMarkers = ['Item Specifics', 'Item specifics', 'Product Details', 'Product details'];
    const stopMarkers = [
        'Authenticity you can Trust', 'Authenticity You Can Trust', 'Buy with Confidence',
        'Worry Free Guarantee', 'Safe Handling Practices', 'Shipping & Handling',
        'Shipping and Handling', 'Return Policy', 'Payment', 'About Us',
    ];
    let result = text;
    const starts = startMarkers.map((marker) => result.indexOf(marker)).filter((index) => index >= 0);
    if (starts.length) result = result.slice(Math.min(...starts));
    const stops = stopMarkers.map((marker) => result.indexOf(marker)).filter((index) => index >= 0);
    if (stops.length) result = result.slice(0, Math.min(...stops));
    result = clean(result);
    return result && result.length >= 40 ? result : null;
};

const mergeFacts = (pageFacts, descriptionFacts) => {
    // Page item specifics take precedence because they are individually labelled by eBay.
    return { ...descriptionFacts, ...pageFacts };
};

await Actor.init();
const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    maxConcurrency = 3,
    maxRequestsPerCrawl = 0,
    waitAfterLoadMs = 1600,
    navigationTimeoutSecs = 60,
    requestHandlerTimeoutSecs = 100,
    saveFailureSnapshots = false,
    warmUpHomepage = true,
    maxRequestRetries = 6,
    proxyConfiguration: proxyInput = { useApifyProxy: true, groups: ['RESIDENTIAL'] },
} = input;

if (!startUrls.length) throw new Error('Provide at least one eBay URL.');
const requestList = await RequestList.open('ebay-description-facts-v22', normalizeUrls(startUrls));
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const crawler = new PlaywrightCrawler({
    requestList,
    proxyConfiguration,
    maxConcurrency,
    maxRequestsPerCrawl: maxRequestsPerCrawl > 0 ? maxRequestsPerCrawl : undefined,
    navigationTimeoutSecs,
    requestHandlerTimeoutSecs,
    maxRequestRetries,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        blockedStatusCodes: [401, 403, 429],
        sessionOptions: { maxUsageCount: 3, maxErrorScore: 1 },
    },
    browserPoolOptions: { useFingerprints: true, retireBrowserAfterPageCount: 3 },
    launchContext: { launchOptions: { headless: true, args: ['--disable-blink-features=AutomationControlled'] } },
    preNavigationHooks: [async ({ page, session }, gotoOptions) => {
        gotoOptions.waitUntil = 'domcontentloaded';
        await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9', 'upgrade-insecure-requests': '1' });
        if (warmUpHomepage && session && !session.userData.ebayWarmed) {
            try {
                await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(500);
                session.userData.ebayWarmed = true;
            } catch {}
        }
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            const url = route.request().url();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)
                || /google-analytics|doubleclick|adservice|facebook|clarity|hotjar|pixel/i.test(url)) {
                return route.abort();
            }
            return route.continue();
        });
    }],
    async requestHandler({ request, page, response }) {
        const fetched_at = new Date().toISOString();
        const warnings = [];
        const ud = request.userData || {};
        await page.waitForTimeout(waitAfterLoadMs);

        const body = clean(await page.locator('body').innerText().catch(() => '')) || '';
        if (/pardon our interruption|verify yourself|security measure|robot check|captcha/i.test(body)) {
            throw new Error('eBay challenge detected');
        }

        const raw = await page.evaluate(() => {
            const trim = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
            const text = (selector) => document.querySelector(selector) ? trim(document.querySelector(selector).textContent) : null;
            const pairs = [];
            const seen = new Set();
            const add = (name, value, source) => {
                name = trim(name); value = trim(value);
                if (!name || !value || name.length > 100 || value.length > 1200) return;
                const signature = `${name.toLowerCase()}||${value.toLowerCase()}`;
                if (seen.has(signature)) return;
                seen.add(signature);
                pairs.push({ name, value, source });
            };

            for (const block of document.querySelectorAll('[data-testid*="ux-labels-values"],.ux-labels-values,.ux-layout-section__item,.ux-layout-section-evo__item')) {
                const label = block.querySelector('.ux-labels-values__labels,.ux-labels-values__labels-content,dt');
                const value = block.querySelector('.ux-labels-values__values,.ux-labels-values__values-content,dd');
                if (label && value) add(label.textContent, value.textContent, 'page_item_specifics');
            }
            for (const dl of document.querySelectorAll('dl')) {
                for (const dt of dl.querySelectorAll(':scope > dt')) {
                    const dd = dt.nextElementSibling;
                    if (dd?.tagName === 'DD') add(dt.textContent, dd.textContent, 'page_item_specifics');
                }
            }
            const iframeUrls = [...document.querySelectorAll('iframe')]
                .map((iframe) => iframe.src)
                .filter((src) => src && /ebaydesc|description|vipr/i.test(src));
            return {
                title: text('h1') || text('[data-testid="x-item-title"]') || document.title,
                pairs,
                iframeUrls,
            };
        });

        let descriptionText = null;
        // First use any already-loaded description frame.
        for (let attempt = 0; attempt < 5 && !descriptionText; attempt++) {
            const frame = page.frames().find((candidate) => /ebaydesc|description|vipr/i.test(candidate.url()));
            if (frame) {
                try {
                    descriptionText = clean(await frame.locator('body').innerText({ timeout: 5000 }));
                } catch {}
            }
            if (!descriptionText) await page.waitForTimeout(700);
        }

        // If the iframe exists but did not attach as a readable frame, open its URL in a lightweight second page.
        if (!descriptionText && raw.iframeUrls.length) {
            const descriptionPage = await page.context().newPage();
            try {
                await descriptionPage.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
                    return route.continue();
                });
                await descriptionPage.goto(raw.iframeUrls[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
                descriptionText = clean(await descriptionPage.locator('body').innerText({ timeout: 7000 }));
            } catch {
                warnings.push('seller_description_unavailable');
            } finally {
                await descriptionPage.close().catch(() => {});
            }
        }

        const product_source_text = productTextOnly(descriptionText);
        const pageParsed = canonicalizePairs(raw.pairs);
        const descriptionPairs = parseDescriptionFacts(product_source_text);
        const descriptionParsed = canonicalizePairs(descriptionPairs);
        const facts = mergeFacts(pageParsed.facts, descriptionParsed.facts);
        const fact_evidence = { ...descriptionParsed.evidence, ...pageParsed.evidence };

        if (!Object.keys(facts).length) warnings.push('description_facts_missing');
        if (!product_source_text) warnings.push('product_source_text_missing');

        const title = clean(raw.title);
        const ebay_item_id = itemIdFrom(request.loadedUrl || request.url) || itemIdFrom(request.url);
        const source_hash = crypto.createHash('sha256')
            .update(JSON.stringify({ title, product_source_text, facts }))
            .digest('hex');

        await Actor.pushData({
            source_record_id: ud.source_record_id ?? null,
            batch_id: ud.batch_id ?? null,
            shopify_product_id: ud.shopify_product_id ?? null,
            shopify_handle: ud.shopify_handle ?? null,
            shopify_sku: ud.shopify_sku ?? null,
            input_index: ud.input_index ?? null,
            ebay_item_id,
            url: request.url,
            title,
            product_source_text,
            facts,
            fact_evidence,
            extraction_status: Object.keys(facts).length ? (warnings.length ? 'partial' : 'complete') : 'failed',
            warnings,
            error: Object.keys(facts).length ? null : 'No description-relevant facts extracted.',
            http_status: response?.status() ?? null,
            fetched_at,
            source_hash,
        });

        log.info(`Saved ${ebay_item_id}`, {
            status: Object.keys(facts).length ? (warnings.length ? 'partial' : 'complete') : 'failed',
            facts: Object.keys(facts).length,
            sourceChars: product_source_text?.length || 0,
        });
    },
    async errorHandler({ request, session }, error) {
        if (/403|429|blocked/i.test(error?.message || '')) {
            session?.retire();
            request.userData.blocked_retry_count = (request.userData.blocked_retry_count || 0) + 1;
        }
    },
    async failedRequestHandler({ request, page }, error) {
        const ebay_item_id = itemIdFrom(request.loadedUrl || request.url) || itemIdFrom(request.url);
        const ud = request.userData || {};
        if (saveFailureSnapshots && page) {
            try {
                await Actor.setValue(`failures/${ebay_item_id}.html`, await page.content(), { contentType: 'text/html' });
                await Actor.setValue(`failures/${ebay_item_id}.png`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
            } catch {}
        }
        await Actor.pushData({
            source_record_id: ud.source_record_id ?? null,
            batch_id: ud.batch_id ?? null,
            shopify_product_id: ud.shopify_product_id ?? null,
            shopify_handle: ud.shopify_handle ?? null,
            shopify_sku: ud.shopify_sku ?? null,
            input_index: ud.input_index ?? null,
            ebay_item_id,
            url: request.url,
            title: null,
            product_source_text: null,
            facts: {},
            fact_evidence: {},
            extraction_status: 'failed',
            warnings: [],
            error: error?.message || String(error),
            fetched_at: new Date().toISOString(),
            source_hash: null,
        });
    },
});

await crawler.run();
await Actor.exit();
