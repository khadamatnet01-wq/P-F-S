import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee/playwright';
await Actor.init();

const input = (await Actor.getInput()) || {};

const city = input.city || 'Riyadh';
const district = input.district || '';
const listingType = input.listingType || 'buy';
const propertyType = input.propertyType || '';
const maxResults = Number(input.maxResults || 20);
const todayOnly = Boolean(input.todayOnly);
const maxPages = Number(input.maxPages || 10);
const fetchPhone = input.fetchPhoneFromDetail !== false;

const proxyConfiguration = await Actor.createProxyConfiguration(
    input.proxyConfiguration || {
        useApifyProxy: true,
        groups: ['RESIDENTIAL']
    }
);

const seen = new Set();
let saved = 0;

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function clean(value) {
    return String(value || '')
        .replace(/\u200e|\u200f/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function phone(value) {
    if (!value) return '';

    let text = String(value)
        .replace(/[()\-\s]/g, '');

    const matches = text.match(
        /(?:\+966|966|0)?5\d{8}/g
    );

    if (!matches) return '';

    for (let p of matches) {
        if (p.startsWith('+966')) {
            p = '0' + p.slice(4);
        } else if (p.startsWith('966')) {
            p = '0' + p.slice(3);
        } else if (p.startsWith('5')) {
            p = '0' + p;
        }

        if (/^05\d{8}$/.test(p)) {
            return p;
        }
    }

    return '';
}

function isToday(dateValue) {
    if (!dateValue) return false;

    const date = new Date(dateValue);

    if (Number.isNaN(date.getTime())) return false;

    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    return fmt.format(date) === fmt.format(new Date());
}

function formatDate(value) {
    if (!value) return '';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleString('ar-SA', {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// ------------------------------------------------------------
// CITY
// ------------------------------------------------------------

function citySlug(value) {
    const v = clean(value).toLowerCase();

    const cities = {
        'riyadh': 'ar-riyadh',
        'الرياض': 'ar-riyadh',

        'jeddah': 'jeddah',
        'جدة': 'jeddah',

        'dammam': 'dammam',
        'الدمام': 'dammam',

        'khobar': 'al-khobar',
        'الخبر': 'al-khobar',

        'makkah': 'makkah-al-mukarramah',
        'مكة': 'makkah-al-mukarramah',
        'مكة المكرمة': 'makkah-al-mukarramah'
    };

    return cities[v] || v.replace(/\s+/g, '-');
}

// ------------------------------------------------------------
// SEARCH URL
// ------------------------------------------------------------

function buildUrl() {
    const cityName = citySlug(city);

    let url;

    if (listingType === 'rent') {
        url =
            `https://www.propertyfinder.sa/en/rent/${cityName}/properties-for-rent-${cityName}.html`;
    } else {
        url =
            `https://www.propertyfinder.sa/en/buy/${cityName}/properties-for-sale-${cityName}.html`;
    }

    // نوع العقار
    if (propertyType === 'villa') {
        url =
            `https://www.propertyfinder.sa/en/${listingType}/${cityName}/villas-for-${listingType}-${cityName}.html`;
    }

    if (propertyType === 'apartment') {
        url =
            `https://www.propertyfinder.sa/en/${listingType}/${cityName}/apartments-for-${listingType}-${cityName}.html`;
    }

    return url;
}

const startUrl = buildUrl();

log.info('==========================================');
log.info('🚀 PROPERTY FINDER SAUDI');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'الكل'}`);
log.info(`🔄 العملية: ${listingType}`);
log.info(`🏠 النوع: ${propertyType || 'الكل'}`);
log.info(`📅 اليوم فقط: ${todayOnly}`);
log.info(`📊 المطلوب: ${maxResults}`);
log.info(`🌐 ${startUrl}`);
log.info('==========================================');

// ------------------------------------------------------------
// EXTRACT LINKS
// ------------------------------------------------------------

async function getListingLinks(page) {
    return await page.evaluate(() => {

        const result = new Set();

        document.querySelectorAll('a[href]').forEach(a => {

            const href = a.href || '';

            if (!href.includes('propertyfinder.sa')) {
                return;
            }

            if (
                !href.includes('/property/') &&
                !href.includes('/plp/')
            ) {
                return;
            }

            const cleanUrl =
                href.split('?')[0].split('#')[0];

            result.add(cleanUrl);
        });

        return [...result];
    });
}

// ------------------------------------------------------------
// EXTRACT DETAIL
// ------------------------------------------------------------

async function extractProperty(page, url) {

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForTimeout(1200);

    const text = await page.locator('body')
        .innerText()
        .catch(() => '');

    const data = await page.evaluate(() => {

        const result = {
            title: '',
            phone: '',
            price: '',
            area: '',
            bedrooms: '',
            bathrooms: '',
            postedAt: '',
            agentName: '',
            description: ''
        };

        const h1 =
            document.querySelector('h1');

        result.title =
            h1?.innerText || '';

        // tel links
        const tel =
            [...document.querySelectorAll(
                'a[href^="tel:"],a[href*="tel:"]'
            )];

        for (const a of tel) {
            const href =
                a.getAttribute('href');

            if (href) {
                result.phone = href;
                break;
            }
        }

        // time / datetime
        const times =
            [...document.querySelectorAll(
                'time,[datetime]'
            )];

        for (const el of times) {

            const value =
                el.getAttribute('datetime') ||
                el.innerText;

            if (value) {
                result.postedAt = value;
                break;
            }
        }

        // JSON-LD
        const scripts =
            [...document.querySelectorAll(
                'script[type="application/ld+json"]'
            )];

        for (const script of scripts) {

            try {

                const json =
                    JSON.parse(
                        script.textContent
                    );

                const items =
                    Array.isArray(json)
                        ? json
                        : [json];

                for (const item of items) {

                    if (!item) continue;

                    if (
                        !result.title &&
                        item.name
                    ) {
                        result.title =
                            item.name;
                    }

                    if (
                        item.telephone
                    ) {
                        result.phone =
                            item.telephone;
                    }

                    if (
                        item.description
                    ) {
                        result.description =
                            item.description;
                    }

                    if (
                        item.offers?.price
                    ) {
                        result.price =
                            String(
                                item.offers.price
                            );
                    }
                }

            } catch {}
        }

        return result;
    });

    let finalPhone =
        phone(data.phone);

    // --------------------------------------------------------
    // PHONE FROM PAGE
    // --------------------------------------------------------

    if (!finalPhone) {
        finalPhone = phone(text);
    }

    // --------------------------------------------------------
    // CLICK CALL
    // --------------------------------------------------------

    if (!finalPhone && fetchPhone) {

        const buttons =
            page.locator('button,a');

        const count =
            Math.min(
                await buttons.count(),
                100
            );

        for (let i = 0; i < count; i++) {

            const el =
                buttons.nth(i);

            const label =
                clean(
                    await el.innerText()
                        .catch(() => '')
                );

            const aria =
                clean(
                    await el.getAttribute(
                        'aria-label'
                    ).catch(() => '')
                );

            const combined =
                `${label} ${aria}`;

            if (
                !/call|phone|اتصل|اتصال|هاتف|جوال/i
                    .test(combined)
            ) {
                continue;
            }

            await el.click({
                timeout: 3000
            }).catch(() => {});

            await page.waitForTimeout(700);

            const after =
                await page.locator('body')
                    .innerText()
                    .catch(() => '');

            finalPhone =
                phone(after);

            if (finalPhone) break;
        }
    }

    // --------------------------------------------------------
    // PRICE
    // --------------------------------------------------------

    let price = data.price;

    if (!price) {

        const match =
            text.match(
                /([\d,]+(?:\.\d+)?)\s*(?:SAR|ريال|ر\.س)/i
            );

        if (match) {
            price =
                match[1].replace(/,/g, '');
        }
    }

    // --------------------------------------------------------
    // AREA
    // --------------------------------------------------------

    let area = '';

    const areaMatch =
        text.match(
            /([\d,]+(?:\.\d+)?)\s*(?:m²|sqm|م²)/i
        );

    if (areaMatch) {
        area = areaMatch[1];
    }

    // --------------------------------------------------------
    // BEDROOMS
    // --------------------------------------------------------

    let bedrooms = '';

    const bedroomMatch =
        text.match(
            /(\d+)\s*(?:bed(?:room)?s?|غرف نوم|غرف)/i
        );

    if (bedroomMatch) {
        bedrooms = bedroomMatch[1];
    }

    // --------------------------------------------------------
    // BATHROOMS
    // --------------------------------------------------------

    let bathrooms = '';

    const bathroomMatch =
        text.match(
            /(\d+)\s*(?:bath(?:room)?s?|حمام|دورات مياه)/i
        );

    if (bathroomMatch) {
        bathrooms = bathroomMatch[1];
    }

    // --------------------------------------------------------
    // POSTED DATE
    // --------------------------------------------------------

    let postedAt =
        data.postedAt || '';

    // Listed X hours ago
    if (!postedAt) {

        const relative =
            text.match(
                /Listed\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago/i
            );

        if (relative) {

            const amount =
                Number(relative[1]);

            const unit =
                relative[2];

            let ms = 0;

            if (unit.includes('minute')) {
                ms = amount * 60 * 1000;
            } else if (unit.includes('hour')) {
                ms = amount * 60 * 60 * 1000;
            } else {
                ms = amount * 24 * 60 * 60 * 1000;
            }

            postedAt =
                new Date(
                    Date.now() - ms
                ).toISOString();
        }
    }

    return {

        url,

        title:
            clean(data.title),

        priceSar:
            clean(price),

        listingType,

        propertyType,

        city,

        district,

        bedrooms,

        bathrooms,

        areaSqm:
            clean(area),

        phone:
            finalPhone,

        agentName:
            clean(data.agentName),

        description:
            clean(data.description),

        postedAt,

        postedAtFormatted:
            formatDate(postedAt),

        source:
            'Property Finder Saudi',

        scannedAt:
            new Date().toISOString()
    };
}

// ------------------------------------------------------------
// CRAWLER
// ------------------------------------------------------------

const crawler =
    new PlaywrightCrawler({

        proxyConfiguration,

        maxConcurrency: 2,

        requestHandlerTimeoutSecs: 120,

        navigationTimeoutSecs: 60000,

        async requestHandler({
            page,
            request,
            log: reqLog
        }) {

            // =================================================
            // SEARCH
            // =================================================

            if (
                request.userData?.type ===
                'search'
            ) {

                const allLinks =
                    new Set();

                for (
                    let p = 1;
                    p <= maxPages;
                    p++
                ) {

                    let url =
                        startUrl;

                    if (p > 1) {

                        url +=
                            (url.includes('?')
                                ? '&'
                                : '?') +
                            `page=${p}`;
                    }

                    reqLog.info(
                        `📄 فحص صفحة ${p}: ${url}`
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
                        1500
                    );

                    // lazy loading
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
                            500
                        );
                    }

                    const links =
                        await getListingLinks(
                            page
                        );

                    for (
                        const link of links
                    ) {
                        allLinks.add(link);
                    }

                    reqLog.info(
                        `🔎 روابط الصفحة: ${links.length} | الإجمالي: ${allLinks.size}`
                    );

                    if (
                        allLinks.size >=
                        maxResults * 3
                    ) {
                        break;
                    }
                }

                const selected =
                    [...allLinks];

                reqLog.info(
                    `📊 إجمالي الإعلانات المرشحة: ${selected.length}`
                );

                for (
                    const url of selected
                ) {

                    if (
                        saved >=
                        maxResults
                    ) {
                        break;
                    }

                    if (seen.has(url)) {
                        continue;
                    }

                    seen.add(url);

                    await crawler.addRequests([
                        {
                            url,

                            userData: {
                                type:
                                    'detail'
                            }
                        }
                    ]);
                }

                return;
            }

            // =================================================
            // DETAIL
            // =================================================

            if (
                request.userData?.type !==
                'detail'
            ) {
                return;
            }

            if (
                saved >=
                maxResults
            ) {
                return;
            }

            reqLog.info(
                `🔍 فحص الإعلان: ${request.url}`
            );

            try {

                const result =
                    await extractProperty(
                        page,
                        request.url
                    );

                // ---------------------------------------------
                // TODAY ONLY
                // ---------------------------------------------

                if (todayOnly) {

                    if (
                        !result.postedAt
                    ) {

                        reqLog.info(
                            '⏭️ تم تجاهل الإعلان: تاريخ النشر غير متوفر'
                        );

                        return;
                    }

                    if (
                        !isToday(
                            result.postedAt
                        )
                    ) {

                        reqLog.info(
                            `⏭️ إعلان قديم: ${result.postedAtFormatted}`
                        );

                        return;
                    }
                }

                await Actor.pushData(
                    result
                );

                saved++;

                reqLog.info(
                    `✅ ${saved}/${maxResults} | ` +
                    `📞 ${result.phone || 'لا يوجد رقم'} | ` +
                    `💰 ${result.priceSar || '-'}`
                );

            } catch (error) {

                reqLog.error(
                    `❌ فشل الإعلان: ${error.message}`
                );
            }
        },

        failedRequestHandler({
            request,
            error
        }) {

            log.error(
                `❌ فشل الطلب: ${request.url}`
            );

            log.error(
                error.message
            );
        }
    });

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

await crawler.run([
    {
        url: startUrl,

        userData: {
            type:
                'search'
        }
    }
]);

// ------------------------------------------------------------
// SUMMARY
// ------------------------------------------------------------

log.info('==========================================');
log.info('🎉 انتهى السحب');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'الكل'}`);
log.info(`🔄 العملية: ${listingType}`);
log.info(`📅 اليوم فقط: ${todayOnly}`);
log.info(`✅ النتائج المحفوظة: ${saved}`);
log.info('==========================================');

await Actor.exit();
