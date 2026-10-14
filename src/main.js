import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

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
const webhookUrl = (input.webhookUrl || '').trim();

// إعداد البروكسي مع التوافق مع صيغة Apify Proxy الحديثة والسابقة
const rawProxyConfig = input.proxyConfiguration || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
};
if (rawProxyConfig.groups && !rawProxyConfig.apifyProxyGroups) {
    rawProxyConfig.apifyProxyGroups = rawProxyConfig.groups;
    delete rawProxyConfig.groups;
}

let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(rawProxyConfig);
} catch (err) {
    log.warning(`⚠️ تعذر تفعيل البروكسي المخصص (${err.message})، سيتم المتابعة بدون بروكسي أو بالإعداد الافتراضي.`);
}

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
// تحويل اسم المدينة ونوع العقار إلى روابط Property Finder
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

function buildUrl() {
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

    return `https://www.propertyfinder.sa/en/${action}/${cityName}/${propSlug}-${actionSlug}-${cityName}.html`;
}

function matchesDistrict(item, targetDistrict) {
    if (!targetDistrict) return true;
    const needle = clean(targetDistrict).toLowerCase();
    const haystack = [
        item.district,
        item.title,
        item.description,
        item.url,
    ]
        .map((s) => clean(s).toLowerCase())
        .join(' ');

    return haystack.includes(needle);
}

const startUrl = buildUrl();

log.info('==========================================');
log.info('🚀 PROPERTY FINDER SAUDI SCRAPER');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'الكل'}`);
log.info(`🔄 العملية: ${listingType}`);
log.info(`🏠 نوع العقار: ${propertyType || 'الكل'}`);
log.info(`📅 إعلانات اليوم فقط: ${todayOnly}`);
log.info(`📊 العدد المطلوب: ${maxResults}`);
log.info(`🌐 رابط البداية: ${startUrl}`);
log.info('==========================================');

// ------------------------------------------------------------
// استخراج روابط الإعلانات من صفحة البحث
// ------------------------------------------------------------

async function getListingLinks(page) {
    return await page.evaluate(() => {
        const result = new Set();

        document.querySelectorAll('a[href]').forEach((a) => {
            const href = a.href || '';
            if (!href.includes('propertyfinder.sa')) return;

            if (!href.includes('/property/') && !href.includes('/plp/')) {
                return;
            }

            const cleanUrl = href.split('?')[0].split('#')[0];
            result.add(cleanUrl);
        });

        // فحص بيانات __NEXT_DATA__ في حال توفر روابط إضافية بداخلها
        const nextDataEl = document.querySelector('#__NEXT_DATA__');
        if (nextDataEl) {
            try {
                const rawText = nextDataEl.textContent || '';
                const matches = rawText.match(/https?:\\?\/\\?\/www\.propertyfinder\.sa\\?\/[^"'\s]+(?:property|plp)[^"'\s]+/g) || [];
                for (const m of matches) {
                    const normalized = m.replace(/\\\//g, '/').split('?')[0].split('#')[0];
                    result.add(normalized);
                }
            } catch {
                // تجاهل أخطاء تحليل النص
            }
        }

        return [...result];
    });
}

// ------------------------------------------------------------
// استخراج تفاصيل العقار من صفحة الإعلان
// ------------------------------------------------------------

async function extractProperty(page, url) {
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });

    await page.waitForTimeout(1200);

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

        // 1. روابط الاتصال المباشر tel: و WhatsApp
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

        // 2. عناصر التاريخ والوقت
        const times = [...document.querySelectorAll('time, [datetime]')];
        for (const el of times) {
            const value = el.getAttribute('datetime') || el.innerText;
            if (value) {
                result.postedAt = value;
                break;
            }
        }

        // 3. مسار التنقل (Breadcrumbs) لاستخراج الحي/الموقع
        const breadcrumbs = [
            ...document.querySelectorAll('nav[aria-label*="breadcrumb"] a, [data-testid*="breadcrumb"] a, ol[itemtype*="BreadcrumbList"] a'),
        ]
            .map((el) => (el.innerText || '').trim())
            .filter(Boolean);
        if (breadcrumbs.length >= 2) {
            result.district = breadcrumbs[breadcrumbs.length - 1];
        }

        // 4. بيانات JSON-LD المهيكلة
        const scripts = [
            ...document.querySelectorAll('script[type="application/ld+json"]'),
        ];
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.textContent);
                const items = Array.isArray(json) ? json : [json];

                for (const item of items) {
                    if (!item) continue;

                    if (!result.title && item.name) {
                        result.title = item.name;
                    }
                    if (!result.phone && item.telephone) {
                        result.phone = item.telephone;
                    }
                    if (!result.description && item.description) {
                        result.description = item.description;
                    }
                    if (!result.price && item.offers?.price) {
                        result.price = String(item.offers.price);
                    }
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
            } catch {
                // تجاهل أخطاء JSON-LD غير الصالحة
            }
        }

        // 5. بيانات Next.js (__NEXT_DATA__) الخاصة بموقع Property Finder
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
            } catch {
                // تجاهل أخطاء __NEXT_DATA__
            }
        }

        // 6. محاولة استخراج اسم الوسيط من عناصر الصفحة القياسية إن لم يتوفر
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

    // البحث عن رقم الهاتف في النص الكامل للصفحة
    if (!finalPhone) {
        finalPhone = normalizePhone(text);
    }

    // محاولة النقر على زر إظهار رقم الهاتف عند تفعيل الخيار
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

    // استخراج السعر
    let price = data.price;
    if (!price) {
        const match = text.match(/([\d,]+(?:\.\d+)?)\s*(?:SAR|ريال|ر\.س)/i);
        if (match) {
            price = match[1].replace(/,/g, '');
        }
    }

    // استخراج المساحة
    let area = data.area;
    if (!area) {
        const areaMatch = text.match(/([\d,]+(?:\.\d+)?)\s*(?:m²|sqm|م²)/i);
        if (areaMatch) {
            area = areaMatch[1].replace(/,/g, '');
        }
    }

    // استخراج غرف النوم
    let bedrooms = data.bedrooms;
    if (!bedrooms) {
        const bedroomMatch = text.match(/(\d+)\s*(?:bed(?:room)?s?|غرف نوم|غرف)/i);
        if (bedroomMatch) {
            bedrooms = bedroomMatch[1];
        }
    }

    // استخراج دورات المياه
    let bathrooms = data.bathrooms;
    if (!bathrooms) {
        const bathroomMatch = text.match(/(\d+)\s*(?:bath(?:room)?s?|حمام|دورات مياه)/i);
        if (bathroomMatch) {
            bathrooms = bathroomMatch[1];
        }
    }

    // استخراج تاريخ النشر
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
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60000,

    async requestHandler({ page, request, log: reqLog }) {
        // =================================================
        // 1. معالجة صفحات البحث (SEARCH)
        // =================================================
        if (request.userData?.type === 'search') {
            const allLinks = new Set();

            for (let p = 1; p <= maxPages; p++) {
                let url = startUrl;
                if (p > 1) {
                    url += (url.includes('?') ? '&' : '?') + `page=${p}`;
                }

                reqLog.info(`📄 فحص صفحة البحث ${p}: ${url}`);

                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });

                await page.waitForTimeout(1500);

                // التمرير لأسفل لتحميل جميع البطاقات (Lazy Loading)
                for (let i = 0; i < 4; i++) {
                    await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight * 2);
                    });
                    await page.waitForTimeout(500);
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

            // التحقق من فلتر الحي إذا كان محددًا من المستخدم
            if (district && !matchesDistrict(result, district)) {
                reqLog.info(`⏭️ تم تخطي الإعلان لعدم مطابقة الحي المطلوب (${district})`);
                return;
            }

            // التحقق من فلتر إعلانات اليوم فقط
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
                `✅ ${saved}/${maxResults} | 📞 ${result.phone || 'لا يوجد رقم'} | 💰 ${result.priceSar || '-'} ريال`
            );
        } catch (error) {
            reqLog.error(`❌ فشل استخراج الإعلان (${request.url}): ${error.message}`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`❌ فشل الطلب نهائيًا: ${request.url} - السبب: ${error.message}`);
    },
});

// ------------------------------------------------------------
// بدء التشغيل وإرسال الـ Webhook عند الانتهاء
// ------------------------------------------------------------

await crawler.run([
    {
        url: startUrl,
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
