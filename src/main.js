import http from 'node:http';
import { Actor } from 'apify';
import { PlaywrightCrawler, log } from '@crawlee/playwright';

await Actor.init();

const input = (await Actor.getInput()) || {};

const city = (input.city || 'الرياض').trim();
const district = (input.district || '').trim();
const listingType = (input.listingType || 'buy').trim();
const propertyType = (input.propertyType || '').trim();
const maxResults = Number(input.maxResults || 20);
const todayOnly = Boolean(input.todayOnly);
const maxPages = Number(input.maxPages || 10);
const fetchPhone = input.fetchPhoneFromDetail !== false;
const webhookUrl = (input.webhookUrl || '').trim();

// ------------------------------------------------------------
// فحص فعلي للبروكسي لتجنب خطأ net::ERR_TUNNEL_CONNECTION_FAILED
// ------------------------------------------------------------

async function isProxyWorking(proxyConfig) {
    if (!proxyConfig) return false;
    try {
        const proxyUrlStr = await proxyConfig.newUrl();
        if (!proxyUrlStr) return false;
        const proxyUrl = new URL(proxyUrlStr);

        return await new Promise((resolve) => {
            const auth = Buffer.from(
                `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
            ).toString('base64');

            const req = http.request({
                host: proxyUrl.hostname,
                port: Number(proxyUrl.port) || 8000,
                method: 'CONNECT',
                path: 'www.propertyfinder.sa:443',
                headers: {
                    'Proxy-Authorization': `Basic ${auth}`,
                },
                timeout: 6000,
            });

            req.on('connect', (res, socket) => {
                socket.destroy();
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.end();
        });
    } catch {
        return false;
    }
}

async function resolveWorkingProxy(userProxyInput) {
    if (userProxyInput && userProxyInput.useApifyProxy === false) {
        log.info('🌐 تم تعطيل البروكسي من الإعدادات، سيتم الاتصال المباشر.');
        return undefined;
    }

    const candidates = [];
    if (userProxyInput && Object.keys(userProxyInput).length > 0) {
        const normalized = { ...userProxyInput };
        if (normalized.groups && !normalized.apifyProxyGroups) {
            normalized.apifyProxyGroups = normalized.groups;
            delete normalized.groups;
        }
        candidates.push({ label: 'المحدد في الإدخال', config: normalized });
    }

    // البديل 1: البروكسي الافتراضي التلقائي بدون RESIDENTIAL
    candidates.push({ label: 'Apify Proxy التلقائي (AUTO)', config: { useApifyProxy: true } });

    for (const candidate of candidates) {
        try {
            const cfg = await Actor.createProxyConfiguration(candidate.config);
            const works = await isProxyWorking(cfg);
            if (works) {
                log.info(`✅ تم التحقق من عمل البروكسي بنجاح (${candidate.label}).`);
                return cfg;
            }
            log.warning(`⚠️ البروكسي (${candidate.label}) غير متاح أو رفض الاتصال (ERR_TUNNEL_CONNECTION_FAILED)، جاري تجربة البديل...`);
        } catch (err) {
            log.warning(`⚠️ تعذر تهيئة البروكسي (${candidate.label}): ${err.message}`);
        }
    }

    log.warning('🌐 سيتم المتابعة بالاتصال المباشر بدون بروكسي لتفادي فشل الاتصال.');
    return undefined;
}

const proxyConfiguration = await resolveWorkingProxy(input.proxyConfiguration);

const seen = new Set();
const savedItems = [];
let saved = 0;

// ------------------------------------------------------------
// دوال المساعدة والتنظيف (HELPERS)
// ------------------------------------------------------------

function clean(value) {
    return String(value || '')
        .replace(/\u200e|\u200f/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizePhone(value) {
    if (!value) return '';

    const text = String(value).replace(/[()\-\s]/g, '');
    const matches = text.match(/(?:\+966|00966|966|0)?5\d{8}/g);

    if (!matches) return '';

    for (let p of matches) {
        if (p.startsWith('+966')) {
            p = '0' + p.slice(4);
        } else if (p.startsWith('00966')) {
            p = '0' + p.slice(5);
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
        day: '2-digit',
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
        minute: '2-digit',
    });
}

// ------------------------------------------------------------
// تحويل اسم المدينة والحي إلى الصيغة القياسية لموقع Property Finder
// ------------------------------------------------------------

function citySlug(value) {
    const v = clean(value).toLowerCase();

    const cities = {
        'riyadh': 'ar-riyadh',
        'ar-riyadh': 'ar-riyadh',
        'الرياض': 'ar-riyadh',
        'رياض': 'ar-riyadh',

        'jeddah': 'jeddah',
        'جدة': 'jeddah',
        'جده': 'jeddah',

        'dammam': 'dammam',
        'الدمام': 'dammam',
        'دمام': 'dammam',

        'khobar': 'al-khobar',
        'al-khobar': 'al-khobar',
        'الخبر': 'al-khobar',

        'makkah': 'makkah-al-mukarramah',
        'mecca': 'makkah-al-mukarramah',
        'مكة': 'makkah-al-mukarramah',
        'مكه': 'makkah-al-mukarramah',
        'مكة المكرمة': 'makkah-al-mukarramah',

        'madinah': 'al-madinah-al-munawwarah',
        'medina': 'al-madinah-al-munawwarah',
        'المدينة': 'al-madinah-al-munawwarah',
        'المدينة المنورة': 'al-madinah-al-munawwarah',
    };

    return cities[v] || v.replace(/\s+/g, '-');
}

function districtSlug(cityValue, districtValue) {
    if (!districtValue) return '';
    const d = clean(districtValue).toLowerCase().replace(/^(حي|حي\s*)/, '').trim();
    const c = clean(cityValue).toLowerCase();

    const riyadhDistricts = {
        'الياسمين': 'al-yasmin',
        'ياسمين': 'al-yasmin',
        'al-yasmin': 'al-yasmin',
        'yasmin': 'al-yasmin',
        'alyasmin': 'al-yasmin',

        'النرجس': 'an-narjis',
        'نرجس': 'an-narjis',
        'an-narjis': 'an-narjis',
        'narjis': 'an-narjis',

        'الملقا': 'al-malqa',
        'ملقا': 'al-malqa',
        'al-malqa': 'al-malqa',
        'malqa': 'al-malqa',

        'العارض': 'al-arid',
        'عارض': 'al-arid',
        'al-arid': 'al-arid',

        'حطين': 'hittin',
        'hittin': 'hittin',

        'قرطبة': 'qurtubah',
        'qurtubah': 'qurtubah',

        'العليا': 'al-olaya',
        'al-olaya': 'al-olaya',
        'olaya': 'al-olaya',

        'الصحافة': 'as-sahafah',
        'as-sahafah': 'as-sahafah',
        'الرمال': 'ar-rimal',
        'المونسية': 'al-munisiyah',
        'اليرموك': 'al-yarmuk',
        'إشبيلية': 'ishbiliyah',
        'اشبيلية': 'ishbiliyah',
        'الخليج': 'al-khalij',
        'القادسية': 'al-qadisiyah',
        'الروضة': 'ar-rawdah',
        'الملز': 'al-malaz',
        'النزهة': 'an-nuzhah',
        'الواحة': 'al-waha',
        'المروج': 'al-muruj',
    };

    const dSlug = riyadhDistricts[d] || d.replace(/\s+/g, '-');
    if (c.includes('riyadh') || c.includes('الرياض') || c.includes('رياض')) {
        return `riyadh-${dSlug}`;
    }
    return dSlug;
}

function buildSearchUrls() {
    const cityName = citySlug(city);
    const action = listingType === 'rent' ? 'rent' : 'buy';
    const actionSlug = action === 'rent' ? 'for-rent' : 'for-sale';

    const typeMap = {
        villa: 'villas',
        apartment: 'apartments',
        land: 'lands',
        building: 'whole-buildings',
    };

    const propSlug = typeMap[propertyType] || 'properties';
    const distSlug = districtSlug(city, district);

    const urls = [];

    // 1. رابط الحي المخصص إن وجد (مثل apartments-for-sale-riyadh-al-yasmin.html)
    if (distSlug) {
        urls.push(`https://www.propertyfinder.sa/en/${action}/${cityName}/${propSlug}-${actionSlug}-${distSlug}.html`);
        if (propSlug !== 'properties') {
            urls.push(`https://www.propertyfinder.sa/en/${action}/${cityName}/properties-${actionSlug}-${distSlug}.html`);
        }
    }

    // 2. الرابط الرئيسي للمدينة (مثل apartments-for-sale.html)
    urls.push(`https://www.propertyfinder.sa/en/${action}/${cityName}/${propSlug}-${actionSlug}.html`);

    return urls;
}

function matchesDistrict(item, targetDistrict) {
    if (!targetDistrict) return true;
    const needle = clean(targetDistrict).toLowerCase().replace(/^(حي|حي\s*)/, '').trim();
    const dSlug = districtSlug(city, targetDistrict).replace(/^riyadh-/, '');

    const haystack = [
        item.district,
        item.title,
        item.description,
        item.url,
    ]
        .map((s) => clean(s).toLowerCase())
        .join(' ');

    return haystack.includes(needle) || (dSlug && haystack.includes(dSlug));
}

const searchUrls = buildSearchUrls();
const primaryUrl = searchUrls[0];

log.info('==========================================');
log.info('🚀 PROPERTY FINDER SAUDI SCRAPER (v2.0)');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'كامل المدينة'}`);
log.info(`🔄 العملية: ${listingType}`);
log.info(`🏠 نوع العقار: ${propertyType || 'الكل'}`);
log.info(`📅 إعلانات اليوم فقط: ${todayOnly}`);
log.info(`📊 العدد المطلوب: ${maxResults}`);
log.info(`🌐 رابط البحث الأساسي: ${primaryUrl}`);
log.info('==========================================');

// ------------------------------------------------------------
// استخراج روابط الإعلانات من صفحة البحث
// ------------------------------------------------------------

async function getListingLinks(page) {
    return await page.evaluate(() => {
        const result = new Set();
        const origin = window.location.origin || 'https://www.propertyfinder.sa';

        // 1. البحث في جميع عناصر الروابط <a>
        document.querySelectorAll('a[href]').forEach((a) => {
            let href = a.getAttribute('href') || a.href || '';
            if (!href) return;

            if (href.startsWith('/')) {
                href = `${origin}${href}`;
            }

            const isPropertyDetail =
                (href.includes('/plp/') || href.includes('/property/')) &&
                /\d+\.html/i.test(href);

            if (isPropertyDetail) {
                const cleanUrl = href.split('?')[0].split('#')[0];
                result.add(cleanUrl);
            }
        });

        // 2. فحص بطاقات العقارات مباشرة عبر selectors الشائعة
        const cardSelectors = [
            'article a[href]',
            '[data-testid*="property-card"] a[href]',
            '[class*="card"] a[href]',
            '[class*="listing"] a[href]',
        ];

        document.querySelectorAll(cardSelectors.join(', ')).forEach((a) => {
            let href = a.getAttribute('href') || a.href || '';
            if (!href) return;
            if (href.startsWith('/')) href = `${origin}${href}`;

            if (href.includes('.html') && /\d+/.test(href) && !href.includes('-for-sale') && !href.includes('-for-rent')) {
                result.add(href.split('?')[0].split('#')[0]);
            }
        });

        // 3. فحص كائن __NEXT_DATA__
        const nextDataEl = document.querySelector('#__NEXT_DATA__');
        if (nextDataEl) {
            try {
                const json = JSON.parse(nextDataEl.textContent || '{}');
                const pageProps = json?.props?.pageProps || {};
                const list =
                    pageProps?.searchResults?.properties ||
                    pageProps?.properties ||
                    pageProps?.listings ||
                    [];

                for (const item of list) {
                    if (item.share_url) {
                        result.add(item.share_url.split('?')[0]);
                    }
                    if (item.url) {
                        const u = item.url.startsWith('/') ? `${origin}${item.url}` : item.url;
                        result.add(u.split('?')[0]);
                    }
                }
            } catch {}
        }

        return [...result];
    });
}

// ------------------------------------------------------------
// استخراج تفاصيل العقار من صفحة الإعلان
// ------------------------------------------------------------

async function extractProperty(page, url) {
    // إذا لم تكن الصفحة الحالية هي صفحة الإعلان المطلوبة، انتقل إليها
    if (!page.url().includes(url.split('?')[0])) {
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
    }

    await page.waitForTimeout(1500);

    const text = await page
        .locator('body')
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
            district: '',
            description: '',
        };

        const h1 = document.querySelector('h1');
        result.title = h1?.innerText || '';

        const telLinks = [
            ...document.querySelectorAll('a[href^="tel:"], a[href*="tel:"], a[href*="wa.me"], a[href*="whatsapp.com"]'),
        ];
        for (const a of telLinks) {
            const href = a.getAttribute('href') || '';
            if (href) {
                result.phone = href;
                break;
            }
        }

        const times = [...document.querySelectorAll('time, [datetime]')];
        for (const el of times) {
            const value = el.getAttribute('datetime') || el.innerText;
            if (value) {
                result.postedAt = value;
                break;
            }
        }

        const breadcrumbs = [
            ...document.querySelectorAll('nav[aria-label*="breadcrumb"] a, [data-testid*="breadcrumb"] a, ol[itemtype*="BreadcrumbList"] a'),
        ]
            .map((el) => (el.innerText || '').trim())
            .filter(Boolean);
        if (breadcrumbs.length >= 2) {
            result.district = breadcrumbs[breadcrumbs.length - 1];
        }

        const scripts = [
            ...document.querySelectorAll('script[type="application/ld+json"]'),
        ];
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.textContent);
                const items = Array.isArray(json) ? json : [json];

                for (const item of items) {
                    if (!item) continue;

                    if (!result.title && item.name) result.title = item.name;
                    if (!result.phone && item.telephone) result.phone = item.telephone;
                    if (!result.description && item.description) result.description = item.description;
                    if (!result.price && item.offers?.price) result.price = String(item.offers.price);
                    if (!result.agentName) {
                        result.agentName =
                            item.author?.name ||
                            item.seller?.name ||
                            item.provider?.name ||
                            item.broker?.name ||
                            '';
                    }
                    if (!result.postedAt && (item.datePosted || item.datePublished)) {
                        result.postedAt = item.datePosted || item.datePublished;
                    }
                }
            } catch {}
        }

        const nextScript = document.querySelector('#__NEXT_DATA__');
        if (nextScript) {
            try {
                const nextJson = JSON.parse(nextScript.textContent);
                const pageProps = nextJson?.props?.pageProps || {};
                const prop =
                    pageProps?.propertyResult?.property ||
                    pageProps?.property ||
                    pageProps?.listing ||
                    {};

                if (!result.title && prop.title) result.title = prop.title;
                if (!result.description && prop.description) result.description = prop.description;
                if (!result.price && (prop.price?.value || prop.price)) {
                    result.price = String(prop.price?.value ?? prop.price);
                }
                if (!result.bedrooms && prop.bedrooms !== undefined) {
                    result.bedrooms = String(prop.bedrooms);
                }
                if (!result.bathrooms && prop.bathrooms !== undefined) {
                    result.bathrooms = String(prop.bathrooms);
                }
                if (!result.area && (prop.size?.value || prop.size)) {
                    result.area = String(prop.size?.value ?? prop.size);
                }
                if (!result.postedAt && (prop.listed_date || prop.added_on || prop.created_at)) {
                    result.postedAt = prop.listed_date || prop.added_on || prop.created_at;
                }
                if (!result.agentName) {
                    result.agentName =
                        prop.agent?.name ||
                        prop.broker?.name ||
                        prop.client?.name ||
                        '';
                }
                if (!result.phone) {
                    const contactOpts = prop.contact_options || prop.agent?.phone || prop.phone || '';
                    result.phone = typeof contactOpts === 'string' ? contactOpts : JSON.stringify(contactOpts);
                }
                if (!result.district && prop.location?.full_name) {
                    result.district = prop.location.full_name;
                } else if (!result.district && prop.location?.name) {
                    result.district = prop.location.name;
                }
            } catch {}
        }

        if (!result.agentName) {
            const agentEl = document.querySelector(
                '[data-testid*="agent-name"], [data-testid*="broker-name"], [class*="agent-name"], [class*="broker-name"]'
            );
            if (agentEl) {
                result.agentName = agentEl.innerText || '';
            }
        }

        return result;
    });

    let finalPhone = normalizePhone(data.phone);

    if (!finalPhone) {
        finalPhone = normalizePhone(text);
    }

    if (!finalPhone && fetchPhone) {
        const buttons = page.locator('button, a');
        const count = Math.min(await buttons.count(), 100);

        for (let i = 0; i < count; i++) {
            const el = buttons.nth(i);
            const label = clean(await el.innerText().catch(() => ''));
            const aria = clean(await el.getAttribute('aria-label').catch(() => ''));
            const testId = clean(await el.getAttribute('data-testid').catch(() => ''));
            const combined = `${label} ${aria} ${testId}`;

            if (!/call|phone|اتصل|اتصال|هاتف|جوال/i.test(combined)) {
                continue;
            }

            await el.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(700);

            const afterText = await page
                .locator('body')
                .innerText()
                .catch(() => '');

            finalPhone = normalizePhone(afterText);
            if (finalPhone) break;
        }
    }

    let price = data.price;
    if (!price) {
        const match = text.match(/([\d,]+(?:\.\d+)?)\s*(?:SAR|ريال|ر\.س)/i);
        if (match) price = match[1].replace(/,/g, '');
    }

    let area = data.area;
    if (!area) {
        const areaMatch = text.match(/([\d,]+(?:\.\d+)?)\s*(?:m²|sqm|م²)/i);
        if (areaMatch) area = areaMatch[1].replace(/,/g, '');
    }

    let bedrooms = data.bedrooms;
    if (!bedrooms) {
        const bedroomMatch = text.match(/(\d+)\s*(?:bed(?:room)?s?|غرف نوم|غرف)/i);
        if (bedroomMatch) bedrooms = bedroomMatch[1];
    }

    let bathrooms = data.bathrooms;
    if (!bathrooms) {
        const bathroomMatch = text.match(/(\d+)\s*(?:bath(?:room)?s?|حمام|دورات مياه)/i);
        if (bathroomMatch) bathrooms = bathroomMatch[1];
    }

    let postedAt = data.postedAt || '';
    if (!postedAt) {
        const relative = text.match(
            /Listed\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago/i
        );
        if (relative) {
            const amount = Number(relative[1]);
            const unit = relative[2].toLowerCase();
            let ms = 0;

            if (unit.includes('minute')) {
                ms = amount * 60 * 1000;
            } else if (unit.includes('hour')) {
                ms = amount * 60 * 60 * 1000;
            } else {
                ms = amount * 24 * 60 * 60 * 1000;
            }

            postedAt = new Date(Date.now() - ms).toISOString();
        }
    }

    return {
        url,
        title: clean(data.title),
        priceSar: clean(price),
        listingType,
        propertyType: propertyType || 'all',
        city,
        district: clean(district || data.district),
        bedrooms: clean(bedrooms),
        bathrooms: clean(bathrooms),
        areaSqm: clean(area),
        phone: finalPhone,
        agentName: clean(data.agentName),
        description: clean(data.description),
        postedAt,
        postedAtFormatted: formatDate(postedAt),
        source: 'Property Finder Saudi',
        scannedAt: new Date().toISOString(),
    };
}

// ------------------------------------------------------------
// إعداد المشغل (PlaywrightCrawler)
// ------------------------------------------------------------

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 2,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    },
    preNavigationHooks: [
        async (_crawlingContext, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
        },
    ],

    async requestHandler({ page, request, log: reqLog }) {
        // =================================================
        // 1. معالجة صفحات البحث (SEARCH)
        // =================================================
        if (request.userData?.type === 'search') {
            const allLinks = new Set();
            const baseUrl = request.url;

            for (let p = 1; p <= maxPages; p++) {
                let url = baseUrl;
                if (p > 1) {
                    url += (url.includes('?') ? '&' : '?') + `page=${p}`;
                }

                reqLog.info(`📄 فحص صفحة البحث ${p}: ${url}`);

                // الصفحة الأولى تم فتحها تلقائياً بواسطة PlaywrightCrawler
                if (p > 1) {
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 60000,
                    });
                }

                await page.waitForTimeout(2500);

                // التمرير التدريجي لتحميل البطاقات
                for (let i = 0; i < 4; i++) {
                    await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight * 1.5);
                    });
                    await page.waitForTimeout(600);
                }

                const links = await getListingLinks(page);
                for (const link of links) {
                    allLinks.add(link);
                }

                reqLog.info(
                    `🔎 روابط الصفحة (${p}): ${links.length} | إجمالي الروابط المجمعة: ${allLinks.size}`
                );

                if (links.length === 0 || allLinks.size >= maxResults * 3) {
                    break;
                }
            }

            const selected = [...allLinks];
            reqLog.info(`📊 إجمالي الإعلانات المرشحة للفحص التفصيلي: ${selected.length}`);

            if (selected.length === 0 && searchUrls.length > 1 && baseUrl === searchUrls[0]) {
                const fallbackUrl = searchUrls[searchUrls.length - 1];
                reqLog.warning(`⚠️ لم يتم العثور على إعلانات في رابط الحي المباشر، جاري الانتقال إلى البحث في كامل المدينة مع فلترة الحي: ${fallbackUrl}`);
                await crawler.addRequests([
                    {
                        url: fallbackUrl,
                        userData: { type: 'search', isFallback: true },
                    },
                ]);
                return;
            }

            const detailRequests = [];
            for (const url of selected) {
                if (seen.has(url)) continue;
                seen.add(url);
                detailRequests.push({
                    url,
                    userData: { type: 'detail' },
                });
            }

            if (detailRequests.length > 0) {
                await crawler.addRequests(detailRequests);
            }
            return;
        }

        // =================================================
        // 2. معالجة صفحة تفاصيل الإعلان (DETAIL)
        // =================================================
        if (request.userData?.type !== 'detail') {
            return;
        }

        if (saved >= maxResults) {
            return;
        }

        reqLog.info(`🔍 فحص الإعلان: ${request.url}`);

        try {
            const result = await extractProperty(page, request.url);

            if (district && !matchesDistrict(result, district)) {
                reqLog.info(`⏭️ تم تخطي الإعلان (${result.title}) لعدم مطابقة الحي المطلوب: ${district}`);
                return;
            }

            if (todayOnly) {
                if (!result.postedAt) {
                    reqLog.info('⏭️ تم تجاهل الإعلان: تاريخ النشر غير متوفر');
                    return;
                }
                if (!isToday(result.postedAt)) {
                    reqLog.info(`⏭️ إعلان قديم (${result.postedAtFormatted})`);
                    return;
                }
            }

            if (saved >= maxResults) {
                return;
            }

            await Actor.pushData(result);
            saved++;
            savedItems.push(result);

            reqLog.info(
                `✅ ${saved}/${maxResults} | 📞 ${result.phone || 'لا يوجد رقم'} | 💰 ${result.priceSar || '-'} ريال | 📍 ${result.district || '-'}`
            );
        } catch (error) {
            reqLog.error(`❌ فشل استخراج الإعلان (${request.url}): ${error.message}`);
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`❌ فشل الطلب نهائيًا: ${request.url} - السبب: ${error?.message || error}`);
    },
});

// ------------------------------------------------------------
// بدء التشغيل
// ------------------------------------------------------------

await crawler.run([
    {
        url: primaryUrl,
        userData: { type: 'search' },
    },
]);

if (webhookUrl) {
    try {
        log.info(`📡 جاري إرسال إشعار Webhook إلى: ${webhookUrl}`);
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actor: 'property-finder-saudi',
                status: 'SUCCEEDED',
                city,
                district: district || 'all',
                listingType,
                propertyType: propertyType || 'all',
                todayOnly,
                totalSaved: saved,
                finishedAt: new Date().toISOString(),
                items: savedItems,
            }),
        });
        log.info(`✅ تم إرسال Webhook بنجاح (الحالة: ${response.status})`);
    } catch (err) {
        log.error(`❌ فشل إرسال Webhook: ${err.message}`);
    }
}

log.info('==========================================');
log.info('🎉 انتهت عملية الاستخراج بنجاح');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'الكل'}`);
log.info(`🔄 العملية: ${listingType}`);
log.info(`📅 إعلانات اليوم فقط: ${todayOnly}`);
log.info(`✅ إجمالي النتائج المحفوظة: ${saved}`);
log.info('==========================================');

await Actor.exit();
