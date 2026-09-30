// ============================================================
// PROPERTY FINDER SAUDI - APIFY ACTOR
// ============================================================

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
    city = 'Riyadh',
    district = '',
    listingType = 'buy',
    propertyType = '',
    maxResults = 20,
    todayOnly = false,
    maxPages = 10,
    fetchPhoneFromDetail = true,
    proxyConfiguration: proxyInput,
    webhookUrl = ''
} = input;

// ============================================================
// PROXY
// ============================================================

const proxyConfiguration =
    await Actor.createProxyConfiguration(
        proxyInput || {
            useApifyProxy: true,
            groups: ['RESIDENTIAL']
        }
    );

// ============================================================
// STATE
// ============================================================

const discovered = [];
const seenUrls = new Set();
const processedUrls = new Set();

let savedCount = 0;

// ============================================================
// HELPERS
// ============================================================

function cleanText(value) {
    return String(value || '')
        .replace(/\u200e/g, '')
        .replace(/\u200f/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================================
// PHONE
// ============================================================

function extractPhone(value) {

    if (!value) return '';

    const text = String(value)
        .replace(/[()\-\s]/g, '');

    const patterns = [
        /(?:\+966|966)?05\d{8}/,
        /(?:\+966|966)?5\d{8}/
    ];

    for (const pattern of patterns) {

        const match = text.match(pattern);

        if (!match) continue;

        let phone = match[0];

        if (phone.startsWith('+966')) {
            phone = '0' + phone.slice(4);
        }

        else if (phone.startsWith('966')) {
            phone = '0' + phone.slice(3);
        }

        else if (phone.startsWith('5')) {
            phone = '0' + phone;
        }

        if (/^05\d{8}$/.test(phone)) {
            return phone;
        }
    }

    return '';
}

// ============================================================
// DATE
// ============================================================

function parseDate(value) {

    if (!value) return null;

    const text = cleanText(value);

    const date = new Date(text);

    if (!isNaN(date.getTime())) {
        return date;
    }

    return null;
}

function riyadhDate(value = new Date()) {

    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }
    ).format(value);
}

function isToday(value) {

    const date = parseDate(value);

    if (!date) return false;

    return (
        riyadhDate(date) ===
        riyadhDate()
    );
}

function formatDate(value) {

    const date = parseDate(value);

    if (!date) return '';

    return date.toLocaleString(
        'ar-SA',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }
    );
}

// ============================================================
// PROPERTY TYPE
// ============================================================

function propertySlug(type) {

    const value =
        cleanText(type)
            .toLowerCase();

    const map = {

        apartment:
            'apartments-for-sale',

        apartments:
            'apartments-for-sale',

        villa:
            'villas-for-sale',

        villas:
            'villas-for-sale',

        land:
            'land-for-sale',

        building:
            'whole-buildings-for-sale',

        resthouse:
            'rest-houses-for-sale'
    };

    return map[value] || '';
}

// ============================================================
// BUILD SEARCH URL
// ============================================================

function normalizeCity(value) {

    const map = {

        'الرياض':
            'ar-riyadh',

        'Riyadh':
            'ar-riyadh',

        'الرياضة':
            'ar-riyadh',

        'جدة':
            'jeddah',

        'Jeddah':
            'jeddah',

        'مكة':
            'makkah-al-mukarramah',

        'مكة المكرمة':
            'makkah-al-mukarramah',

        'الدمام':
            'dammam',

        'Dammam':
            'dammam',

        'الخبر':
            'al-khobar',

        'Khobar':
            'al-khobar'
    };

    return (
        map[value] ||
        String(value)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
    );
}

function buildSearchUrl() {

    const citySlug =
        normalizeCity(city);

    const base =
        listingType === 'rent'
            ? 'rent'
            : 'buy';

    let url =
        `https://www.propertyfinder.sa/en/${base}/${citySlug}/properties-for-${base}-${citySlug}.html`;

    // --------------------------------------------------------
    // نوع العقار
    // --------------------------------------------------------

    if (propertyType) {

        const type =
            String(propertyType)
                .toLowerCase();

        if (
            type === 'apartment' ||
            type === 'apartments'
        ) {

            url =
                `https://www.propertyfinder.sa/en/${base}/${citySlug}/apartments-for-${base}-${citySlug}.html`;
        }

        else if (
            type === 'villa' ||
            type === 'villas'
        ) {

            url =
                `https://www.propertyfinder.sa/en/${base}/${citySlug}/villas-for-${base}-${citySlug}.html`;
        }
    }

    return url;
}

const searchUrl =
    buildSearchUrl();

log.info('==========================================');
log.info('🚀 PROPERTY FINDER SAUDI');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'الكل'}`);
log.info(`🔄 العملية: ${listingType}`);
log.info(`🏠 النوع: ${propertyType || 'الكل'}`);
log.info(`📅 اليوم فقط: ${todayOnly}`);
log.info(`📊 النتائج: ${maxResults}`);
log.info(`🌐 URL: ${searchUrl}`);
log.info('==========================================');

// ============================================================
// EXTRACT LISTING CARDS
// ============================================================

async function extractListingCards(page) {

    return await page.evaluate(() => {

        const results = [];
        const urls = new Set();

        const links =
            Array.from(
                document.querySelectorAll(
                    'a[href]'
                )
            );

        for (const link of links) {

            const href =
                link.href || '';

            if (!href) continue;

            if (
                !href.includes(
                    'propertyfinder.sa'
                )
            ) {
                continue;
            }

            // Property Finder listing URLs
            if (
                !(
                    href.includes('/property/')
                    ||
                    href.includes('/en/plp/')
                    ||
                    href.includes('/ar/plp/')
                )
            ) {
                continue;
            }

            const url =
                href
                    .split('?')[0]
                    .split('#')[0];

            if (urls.has(url)) {
                continue;
            }

            urls.add(url);

            const card =
                link.closest(
                    'article'
                ) ||
                link.closest(
                    '[data-testid]'
                ) ||
                link.parentElement?.parentElement?.parentElement ||
                link.parentElement;

            const text =
                card?.innerText || '';

            const title =
                (
                    card?.querySelector(
                        'h2,h3,h4'
                    )?.innerText ||
                    link.innerText ||
                    ''
                ).trim();

            const priceMatch =
                text.match(
                    /([\d,]+(?:\.\d+)?)\s*(?:SAR|ريال|ر\.س)/i
                );

            const priceSar =
                priceMatch
                    ? priceMatch[1]
                        .replace(/,/g, '')
                    : '';

            const areaMatch =
                text.match(
                    /(?:Area|المساحة)\s*:?\s*([\d,.]+)\s*m²?/i
                );

            const area =
                areaMatch
                    ? areaMatch[1]
                    : '';

            const bedroomsMatch =
                text.match(
                    /(\d+)\s*(?:Beds?|Bedrooms?|غرف)/i
                );

            const bedrooms =
                bedroomsMatch
                    ? bedroomsMatch[1]
                    : '';

            const locationMatch =
                text.match(
                    /(?:Riyadh|Jeddah|Dammam|Makkah|Khobar)[^]*$/i
                );

            results.push({

                url,

                title:
                    title.trim(),

                priceSar,

                area,

                bedrooms,

                cardText:
                    text.trim(),

                location:
                    locationMatch
                        ? locationMatch[0]
                        : ''
            });
        }

        return results;
    });
}

// ============================================================
// DISCOVER LISTINGS
// ============================================================

async function discoverListings(
    page,
    reqLog
) {

    for (
        let pageNumber = 1;
        pageNumber <= Number(maxPages);
        pageNumber++
    ) {

        if (
            discovered.length >=
            Number(maxResults) * 4
        ) {
            break;
        }

        let url =
            searchUrl;

        if (pageNumber > 1) {

            const separator =
                url.includes('?')
                    ? '&'
                    : '?';

            url =
                `${url}${separator}page=${pageNumber}`;
        }

        reqLog.info(
            `📄 صفحة النتائج ${pageNumber}: ${url}`
        );

        await page.goto(
            url,
            {
                waitUntil:
                    'domcontentloaded',
                timeout: 60000
            }
        );

        await page.waitForTimeout(
            1800
        );

        // Scroll to trigger lazy loading
        for (
            let i = 0;
            i < 4;
            i++
        ) {

            await page.evaluate(
                () => {
                    window.scrollBy(
                        0,
                        window.innerHeight * 2
                    );
                }
            );

            await page.waitForTimeout(
                700
            );
        }

        const cards =
            await extractListingCards(
                page
            );

        reqLog.info(
            `🔎 وُجد ${cards.length} رابط`
        );

        for (const card of cards) {

            if (
                seenUrls.has(
                    card.url
                )
            ) {
                continue;
            }

            seenUrls.add(
                card.url
            );

            discovered.push(card);
        }

        reqLog.info(
            `📊 إجمالي المرشحين: ${discovered.length}`
        );
    }
}

// ============================================================
// DETAIL EXTRACTION
// ============================================================

async function extractDetail(
    page,
    item,
    reqLog
) {

    await page.goto(
        item.url,
        {
            waitUntil:
                'domcontentloaded',
            timeout: 60000
        }
    );

    await page.waitForTimeout(
        1000
    );

    const bodyText =
        await page.locator(
            'body'
        )
        .innerText()
        .catch(
            () => ''
        );

    // ========================================================
    // JSON-LD
    // ========================================================

    const jsonLd =
        await page.evaluate(
            () => {

                const scripts =
                    Array.from(
                        document.querySelectorAll(
                            'script[type="application/ld+json"]'
                        )
                    );

                return scripts.map(
                    script => {
                        try {
                            return JSON.parse(
                                script.textContent
                            );
                        } catch {
                            return null;
                        }
                    }
                );
            }
        );

    let phone =
        extractPhone(
            bodyText
        );

    let title =
        item.title;

    let priceSar =
        item.priceSar;

    let area =
        item.area;

    let bedrooms =
        item.bedrooms;

    let bathrooms = '';

    let description = '';

    let agentName = '';

    let postedAt = '';

    let propertyTypeValue =
        propertyType;

    // ========================================================
    // JSON-LD DATA
    // ========================================================

    for (const data of jsonLd) {

        if (!data) continue;

        const objects =
            Array.isArray(data)
                ? data
                : [data];

        for (const obj of objects) {

            if (!obj) continue;

            if (
                obj.name &&
                !title
            ) {
                title =
                    cleanText(
                        obj.name
                    );
            }

            if (
                obj.description
            ) {
                description =
                    cleanText(
                        obj.description
                    );
            }

            if (
                obj.telephone &&
                !phone
            ) {
                phone =
                    extractPhone(
                        obj.telephone
                    );
            }

            if (
                obj.offers?.price &&
                !priceSar
            ) {
                priceSar =
                    String(
                        obj.offers.price
                    );
            }
        }
    }

    // ========================================================
    // PAGE TEXT EXTRACTION
    // ========================================================

    if (!priceSar) {

        const match =
            bodyText.match(
                /([\d,]+(?:\.\d+)?)\s*(?:SAR|ريال|ر\.س)/i
            );

        if (match) {
            priceSar =
                match[1]
                    .replace(/,/g, '');
        }
    }

    if (!area) {

        const match =
            bodyText.match(
                /(?:Area|المساحة)\s*:?\s*([\d,.]+)\s*m²?/i
            );

        if (match) {
            area =
                match[1];
        }
    }

    if (!bedrooms) {

        const match =
            bodyText.match(
                /(\d+)\s*(?:Beds?|Bedrooms?|غرف)/i
            );

        if (match) {
            bedrooms =
                match[1];
        }
    }

    // ========================================================
    // PHONE - TEL
    // ========================================================

    if (!phone) {

        const telLinks =
            await page.locator(
                'a[href^="tel:"],a[href*="tel:"]'
            )
            .all();

        for (
            const link of telLinks
        ) {

            const href =
                await link
                    .getAttribute(
                        'href'
                    )
                    .catch(
                        () => ''
                    );

            phone =
                extractPhone(
                    href
                );

            if (phone) break;
        }
    }

    // ========================================================
    // PHONE - BUTTON
    // ========================================================

    if (
        !phone &&
        fetchPhoneFromDetail
    ) {

        try {

            const buttons =
                page.locator(
                    'button,a'
                );

            const count =
                await buttons.count();

            for (
                let i = 0;
                i < count;
                i++
            ) {

                const button =
                    buttons.nth(i);

                const text =
                    cleanText(
                        await button
                            .innerText()
                            .catch(
                                () => ''
                            )
                    );

                const aria =
                    cleanText(
                        await button
                            .getAttribute(
                                'aria-label'
                            )
                            .catch(
                                () => ''
                            )
                    );

                const label =
                    `${text} ${aria}`;

                if (
                    !/call|phone|اتصال|اتصل|هاتف|جوال/i
                        .test(label)
                ) {
                    continue;
                }

                await button
                    .click({
                        timeout: 4000
                    })
                    .catch(
                        () => {}
                    );

                await page.waitForTimeout(
                    800
                );

                const after =
                    await page
                        .locator(
                            'body'
                        )
                        .innerText()
                        .catch(
                            () => ''
                        );

                phone =
                    extractPhone(
                        after
                    );

                if (phone) {
                    break;
                }

                const tel =
                    await page.evaluate(
                        () => {

                            const links =
                                Array.from(
                                    document.querySelectorAll(
                                        'a[href^="tel:"],a[href*="tel:"]'
                                    )
                                );

                            return links.map(
                                x =>
                                    x.getAttribute(
                                        'href'
                                    ) || ''
                            );
                        }
                    );

                for (
                    const value of tel
                ) {

                    phone =
                        extractPhone(
                            value
                        );

                    if (phone) break;
                }

                if (phone) break;
            }

        } catch (error) {

            reqLog.warning(
                `⚠️ فشل محاولة كشف الهاتف: ${error.message}`
            );
        }
    }

    // ========================================================
    // POSTED DATE
    // ========================================================

    const dateCandidates =
        await page.evaluate(
            () => {

                const values = [];

                document
                    .querySelectorAll(
                        'time,[datetime]'
                    )
                    .forEach(
                        el => {

                            const datetime =
                                el.getAttribute(
                                    'datetime'
                                );

                            const text =
                                el.innerText;

                            if (datetime) {
                                values.push(
                                    datetime
                                );
                            }

                            if (text) {
                                values.push(
                                    text
                                );
                            }
                        }
                    );

                return values;
            }
        );

    for (
        const value of
        dateCandidates
    ) {

        const date =
            parseDate(value);

        if (date) {

            postedAt =
                date.toISOString();

            break;
        }
    }

    // ========================================================
    // "Listed X hours ago"
    // ========================================================

    if (!postedAt) {

        const relative =
            bodyText.match(
                /Listed\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago/i
            );

        if (relative) {

            const amount =
                Number(
                    relative[1]
                );

            const unit =
                relative[2]
                    .toLowerCase();

            const now =
                new Date();

            let milliseconds =
                0;

            if (
                unit.includes(
                    'minute'
                )
            ) {
                milliseconds =
                    amount *
                    60 *
                    1000;
            }

            else if (
                unit.includes(
                    'hour'
                )
            ) {
                milliseconds =
                    amount *
                    60 *
                    60 *
                    1000;
            }

            else if (
                unit.includes(
                    'day'
                )
            ) {
                milliseconds =
                    amount *
                    24 *
                    60 *
                    60 *
                    1000;
            }

            postedAt =
                new Date(
                    now.getTime() -
                    milliseconds
                ).toISOString();
        }
    }

    // ========================================================
    // AGENT
    // ========================================================

    const agentPatterns = [
        /Call\s+WhatsApp\s+([^\n]+)/i,
        /واتساب\s+([^\n]+)/i
    ];

    for (
        const pattern of
        agentPatterns
    ) {

        const match =
            bodyText.match(
                pattern
            );

        if (match) {

            agentName =
                cleanText(
                    match[1]
                );

            break;
        }
    }

    // ========================================================
    // DISTRICT
    // ========================================================

    let detectedDistrict =
        district;

    if (!detectedDistrict) {

        const match =
            bodyText.match(
                /(?:,\s*|\n)([A-Za-z\u0600-\u06FF\s'-]+),\s*(?:Riyadh|Jeddah|Dammam|Makkah)/i
            );

        if (match) {
            detectedDistrict =
                cleanText(
                    match[1]
                );
        }
    }

    return {

        url:
            item.url,

        title:
            cleanText(title),

        priceSar:
            priceSar || '',

        listingType:
            listingType,

        propertyType:
            propertyTypeValue || '',

        city:
            city,

        district:
            detectedDistrict,

        bedrooms:
            bedrooms || '',

        bathrooms:
            bathrooms || '',

        areaSqm:
            area || '',

        phone:
            phone || '',

        agentName:
            agentName || '',

        description:
            description || '',

        postedAt:
            postedAt || '',

        postedAtFormatted:
            postedAt
                ? formatDate(
                    postedAt
                )
                : '',

        source:
            'Property Finder Saudi',

        scannedAt:
            new Date()
                .toISOString()
    };
}

// ============================================================
// CRAWLER
// ============================================================

const crawler =
    new PlaywrightCrawler({

        proxyConfiguration,

        maxConcurrency: 2,

        maxRequestsPerCrawl:
            Math.max(
                Number(maxResults) * 5,
                100
            ),

        requestHandlerTimeoutSecs:
            120,

        navigationTimeoutSecs:
            60000,

        async requestHandler({
            page,
            request,
            log: reqLog
        }) {

            if (
                request.userData
                    ?.label === 'SEARCH'
            ) {

                await discoverListings(
                    page,
                    reqLog
                );

                for (
                    const item of
                    discovered
                ) {

                    if (
                        processedUrls.has(
                            item.url
                        )
                    ) {
                        continue;
                    }

                    if (
                        savedCount >=
                        Number(maxResults)
                    ) {
                        break;
                    }

                    processedUrls.add(
                        item.url
                    );

                    await crawler.addRequests([
                        {
                            url:
                                item.url,

                            userData: {
                                label:
                                    'DETAIL',

                                item
                            }
                        }
                    ]);
                }

                return;
            }

            // ==================================================
            // DETAIL
            // ==================================================

            if (
                request.userData
                    ?.label !== 'DETAIL'
            ) {
                return;
            }

            if (
                savedCount >=
                Number(maxResults)
            ) {
                return;
            }

            const item =
                request.userData.item;

            reqLog.info(
                `📄 فحص الإعلان: ${item.url}`
            );

            const result =
                await extractDetail(
                    page,
                    item,
                    reqLog
                );

            // ==================================================
            // TODAY ONLY
            // ==================================================

            if (todayOnly) {

                if (!result.postedAt) {

                    reqLog.info(
                        '⏭️ تجاهل: لا يوجد تاريخ موثوق'
                    );

                    return;
                }

                if (
                    !isToday(
                        result.postedAt
                    )
                ) {

                    reqLog.info(
                        `⏭️ قديم: ${result.postedAtFormatted}`
                    );

                    return;
                }
            }

            // ==================================================
            // SAVE
            // ==================================================

            await Actor.pushData(
                result
            );

            savedCount++;

            reqLog.info(
                `✅ حفظ ${savedCount}/${maxResults} | ` +
                `📞 ${result.phone || 'لا يوجد'} | ` +
                `📅 ${result.postedAtFormatted || 'غير معروف'}`
            );
        },

        async failedRequestHandler({
            request,
            error
        }) {

            log.error(
                `❌ فشل: ${request.url} | ${error.message}`
            );
        }
    });

// ============================================================
// START
// ============================================================

await crawler.run([
    {
        url:
            searchUrl,

        userData: {
            label:
                'SEARCH'
        }
    }
]);

// ============================================================
// WEBHOOK
// ============================================================

if (
    webhookUrl &&
    webhookUrl.trim()
) {

    try {

        await fetch(
            webhookUrl,
            {
                method:
                    'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body:
                    JSON.stringify({

                        status:
                            'success',

                        source:
                            'propertyfinder.sa',

                        city,

                        district,

                        listingType,

                        propertyType,

                        todayOnly,

                        results:
                            savedCount,

                        datasetId:
                            process.env
                                .APIFY_DEFAULT_DATASET_ID,

                        completedAt:
                            new Date()
                                .toISOString()
                    })
            }
        );

        log.info(
            '✅ تم إرسال Webhook'
        );

    } catch (error) {

        log.error(
            `❌ Webhook: ${error.message}`
        );
    }
}

// ============================================================
// SUMMARY
// ============================================================

log.info(
    '=========================================='
);

log.info(
    '🎉 اكتمل Property Finder'
);

log.info(
    `📍 المدينة: ${city}`
);

log.info(
    `🏘️ الحي: ${district || 'الكل'}`
);

log.info(
    `📊 المرشحون: ${discovered.length}`
);

log.info(
    `✅ المحفوظ: ${savedCount}`
);

log.info(
    `📅 اليوم فقط: ${todayOnly}`
);

log.info(
    '=========================================='
);

await Actor.exit();
