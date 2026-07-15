import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestList } from 'crawlee';
import crypto from 'node:crypto';

const clean = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return s || null;
};
const itemIdFrom = (u) => String(u || '').match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/i)?.[1] || null;
const normalizeUrls = (xs) => xs.map((x, i) => typeof x === 'string' ? { url: x, userData: { input_index: i } } : ({...x, userData:{input_index:i,...(x.userData||{})}}));

const parseColonLines = (text) => {
    const out = {};
    if (!text) return out;
    for (const raw of text.split(/\n+/)) {
        const line = clean(raw);
        if (!line || line.length > 300) continue;
        const m = line.match(/^([^:]{2,60}):\s*(.+)$/);
        if (!m) continue;
        const key = clean(m[1]); const value = clean(m[2]);
        if (!key || !value) continue;
        if (!(key in out)) out[key] = value;
        else if (out[key] !== value) out[key] = Array.isArray(out[key]) ? [...new Set([...out[key], value])] : [out[key], value];
    }
    return out;
};

const trimProductText = (text) => {
    if (!text) return null;
    const startMarkers = ['Item Specifics', 'Item specifics'];
    const stopMarkers = ['Authenticity you can Trust','Authenticity You Can Trust','Buy with Confidence','Worry Free Guarantee','Safe Handling Practices'];
    let result = text;
    const starts = startMarkers.map(x => result.indexOf(x)).filter(x => x >= 0);
    if (starts.length) result = result.slice(Math.min(...starts));
    const stops = stopMarkers.map(x => result.indexOf(x)).filter(x => x >= 0);
    if (stops.length) result = result.slice(0, Math.min(...stops));
    return clean(result);
};

const objectFromPairs = (pairs) => {
    const out = {};
    for (const p of pairs || []) {
        const k=clean(p.name), v=clean(p.value); if (!k || !v) continue;
        if (!(k in out)) out[k]=v;
        else if (out[k] !== v) out[k]=Array.isArray(out[k]) ? [...new Set([...out[k],v])] : [out[k],v];
    }
    return out;
};

await Actor.init();
const input=(await Actor.getInput())||{};
const {startUrls=[],maxConcurrency=3,maxRequestsPerCrawl=0,waitAfterLoadMs=1200,navigationTimeoutSecs=60,requestHandlerTimeoutSecs=90,saveFailureSnapshots=false,warmUpHomepage=true,maxRequestRetries=6,proxyConfiguration:proxyInput={useApifyProxy:true,groups:['RESIDENTIAL']}}=input;
if (!startUrls.length) throw new Error('Provide at least one eBay URL.');
const requestList=await RequestList.open('ebay-listings-lite',normalizeUrls(startUrls));
const proxyConfiguration=await Actor.createProxyConfiguration(proxyInput);

const crawler=new PlaywrightCrawler({
 requestList,proxyConfiguration,maxConcurrency,maxRequestsPerCrawl:maxRequestsPerCrawl>0?maxRequestsPerCrawl:undefined,
 navigationTimeoutSecs,requestHandlerTimeoutSecs,maxRequestRetries,
 useSessionPool:true,persistCookiesPerSession:true,
 sessionPoolOptions:{maxPoolSize:50,blockedStatusCodes:[401,403,429],sessionOptions:{maxUsageCount:3,maxErrorScore:1}},
 browserPoolOptions:{useFingerprints:true,retireBrowserAfterPageCount:3},
 launchContext:{launchOptions:{headless:true,args:['--disable-blink-features=AutomationControlled']}},
 preNavigationHooks:[async({page,session},gotoOptions)=>{
   gotoOptions.waitUntil='domcontentloaded';
   await page.setExtraHTTPHeaders({'accept-language':'en-US,en;q=0.9','upgrade-insecure-requests':'1'});
   if(warmUpHomepage && session && !session.userData.ebayWarmed){
     try{await page.goto('https://www.ebay.com/',{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(600);session.userData.ebayWarmed=true;}catch{}
   }
   await page.route('**/*', route=>{
     const type=route.request().resourceType();
     const url=route.request().url();
     if (['image','media','font','stylesheet'].includes(type) || /google-analytics|doubleclick|adservice|facebook|clarity|hotjar/i.test(url)) return route.abort();
     return route.continue();
   });
 }],
 async requestHandler({request,page,response}){
   const fetched_at=new Date().toISOString(); const warnings=[]; const ud=request.userData||{};
   await page.waitForTimeout(waitAfterLoadMs);
   const body=clean(await page.locator('body').innerText().catch(()=>''))||'';
   if (/pardon our interruption|verify yourself|security measure|robot check|captcha/i.test(body)) throw new Error('eBay challenge detected');
   const raw=await page.evaluate(()=>{
     const t=v=>String(v??'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim();
     const tx=s=>document.querySelector(s)?t(document.querySelector(s).textContent):null;
     const pairs=[]; const seen=new Set();
     const add=(n,v)=>{n=t(n);v=t(v);if(!n||!v||n.length>100||v.length>1000)return;const sig=n.toLowerCase()+'||'+v.toLowerCase();if(seen.has(sig))return;seen.add(sig);pairs.push({name:n,value:v});};
     for(const dl of document.querySelectorAll('dl')) for(const dt of dl.querySelectorAll(':scope > dt')) {const dd=dt.nextElementSibling;if(dd?.tagName==='DD')add(dt.textContent,dd.textContent);}
     for(const row of document.querySelectorAll('tr')) {const c=[...row.querySelectorAll(':scope > th,:scope > td')];if(c.length===2)add(c[0].textContent,c[1].textContent);}
     for(const block of document.querySelectorAll('[data-testid*="ux-labels-values"],.ux-labels-values,.ux-layout-section__item,.ux-layout-section-evo__item')) {
       const l=block.querySelector('.ux-labels-values__labels,.ux-labels-values__labels-content,dt');
       const v=block.querySelector('.ux-labels-values__values,.ux-labels-values__values-content,dd'); if(l&&v)add(l.textContent,v.textContent);
     }
     return {title:tx('h1')||tx('[data-testid="x-item-title"]')||document.title,pairs};
   });
   let descText=null;
   const frame=page.frames().find(f=>/ebaydesc|description|vipr/i.test(f.url()));
   if(frame){try{descText=clean(await frame.locator('body').innerText({timeout:7000}));}catch{warnings.push('description_frame_unreadable');}}
   if(!descText){
     for(const sel of ['#vi-desc-maincntr','[data-testid*="description"]','text=/Item description from the seller/i']){
       try{const loc=page.locator(sel).first();if(await loc.count()){const x=clean(await loc.innerText({timeout:3000}));if(x&&x.length>80){descText=x;break;}}}catch{}
     }
   }
   const product_source_text=trimProductText(descText);
   const page_item_specifics=objectFromPairs(raw.pairs);
   const description_specifics=parseColonLines(product_source_text);
   const combined_specifics={...description_specifics,...page_item_specifics};
   if(!product_source_text) warnings.push('product_source_text_missing');
   if(!Object.keys(combined_specifics).length) warnings.push('specifics_missing');
   const title=clean(raw.title); const ebay_item_id=itemIdFrom(request.loadedUrl||request.url)||itemIdFrom(request.url);
   const source_hash=crypto.createHash('sha256').update(JSON.stringify({title,product_source_text,page_item_specifics,description_specifics})).digest('hex');
   await Actor.pushData({source_record_id:ud.source_record_id??null,batch_id:ud.batch_id??null,shopify_product_id:ud.shopify_product_id??null,shopify_handle:ud.shopify_handle??null,shopify_sku:ud.shopify_sku??null,...ud,ebay_item_id,url:request.url,title,product_source_text,page_item_specifics,description_specifics,combined_specifics,extraction_status:warnings.length?'partial':'complete',warnings,error:null,http_status:response?.status()??null,fetched_at,source_hash});
   log.info(`Saved ${ebay_item_id}`,{status:warnings.length?'partial':'complete',specifics:Object.keys(combined_specifics).length,sourceChars:product_source_text?.length||0});
 },
 async errorHandler({request,session},error){
   if(/403|429|blocked/i.test(error?.message||'')){session?.retire();request.userData.blocked_retry_count=(request.userData.blocked_retry_count||0)+1;}
 },
 async failedRequestHandler({request,page},error){
   const ebay_item_id=itemIdFrom(request.loadedUrl||request.url)||itemIdFrom(request.url); const ud=request.userData||{};
   if(saveFailureSnapshots&&page){try{await Actor.setValue(`failures/${ebay_item_id}.html`,await page.content(),{contentType:'text/html'});await Actor.setValue(`failures/${ebay_item_id}.png`,await page.screenshot({fullPage:true}),{contentType:'image/png'});}catch{}}
   await Actor.pushData({source_record_id:ud.source_record_id??null,batch_id:ud.batch_id??null,shopify_product_id:ud.shopify_product_id??null,shopify_handle:ud.shopify_handle??null,shopify_sku:ud.shopify_sku??null,...ud,ebay_item_id,url:request.url,title:null,product_source_text:null,page_item_specifics:{},description_specifics:{},combined_specifics:{},extraction_status:'failed',warnings:[],error:error?.message||String(error),fetched_at:new Date().toISOString(),source_hash:null});
 }
});
await crawler.run(); await Actor.exit();
