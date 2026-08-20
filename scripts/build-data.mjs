/* Builds data.json for the checkout-counter TV.
 *
 * Runs in GitHub Actions on a schedule. Two sources:
 *   1. Airtable  — terms tiles, settings, any photos Dalton added by hand
 *   2. bid.woolseyauction.com — live auctions and their lot photos
 *
 * Scraping is best-effort. If the site changes shape or is down, we still
 * publish the Airtable content so the TV keeps working with terms and QR
 * codes rather than going blank.
 *
 * Required env: AIRTABLE_TOKEN
 * Optional env: AIRTABLE_BASE (defaults to the Woolsey TV Dashboard base)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import QRCode from 'qrcode';

const BASE = process.env.AIRTABLE_BASE || 'apprxqJCv4zUSWN9d';
const TOKEN = process.env.AIRTABLE_TOKEN;

const TABLES = {
  terms:    'tblh1s2TThsFVaukm',
  auctions: 'tblrUsNcPUdd3siIB',
  slides:   'tblV0WvDzN4vN1ojf',
  settings: 'tblsswJPNMJReppRS'
};

const SITE = 'https://bid.woolseyauction.com';
const MAX_PHOTOS_PER_AUCTION = 60;
const MAX_PHOTOS_TOTAL = 300;

/* The catalog serves ~50 lots per page. Two pages gets us past the 60-photo
 * per-auction cap with room to spare once placards are filtered out; a third is
 * only reached when a page comes back unusually thin. */
const MAX_CATALOG_PAGES = 4;

/* Everything Woolsey runs is on Colorado time. The build machine is UTC, so
 * every date shown on the TV has to be formatted against this zone explicitly
 * or a 6 PM close renders as the following day. */
const TZ = 'America/Denver';

/* Most auctions open with a run of informational placard lots — ATTENTION,
 * PAYMENT INFORMATION, REMOVAL INFORMATION and friends. They are text images,
 * not merchandise, and they duplicate the terms panel, so they are skipped. */
const INFO_LOT = /^(attention|important|please read|notice|inspection|preview|payment|removal|pickup|pick[- ]?up|shipping|loading|terms|buyer'?s? premium|storage|thank you|welcome|announcement|read this)\b/i;

/* Lot titles are written for bidders browsing a catalog, not for a wall
 * screen: they repeat the year/make/model and carry all-caps staff notes.
 * Trim them down to something readable at ten feet. */
function cleanCaption(raw) {
  let c = (raw || '').replace(/\s+/g, ' ').trim();

  // Drop bracketed/starred staff notes, e.g. "*** VEHICLE IS LOCATED OFFISTE**".
  c = c.replace(/\*{2,}[^*]*\*{1,}/g, ' ');
  c = c.replace(/\s+/g, ' ').trim();

  // The catalog often stores year/make/model in separate columns and then
  // repeats them in the description: "2018 Dodge Charger 2018 Dodge Charger
  // AWD". If the opening run of words repeats immediately, drop the first copy.
  const words = c.split(' ');
  for (let k = Math.min(6, Math.floor(words.length / 2)); k >= 2; k--) {
    const first = words.slice(0, k).join(' ').toLowerCase();
    const second = words.slice(k, k * 2).join(' ').toLowerCase();
    if (first === second) {
      c = words.slice(k).join(' ');
      break;
    }
  }

  if (c.length > 95) c = c.slice(0, 92).replace(/[\s,;:-]+$/, '') + '…';
  return c;
}

function isInfoLot(caption) {
  const c = (caption || '').trim();
  if (!c) return false;
  if (INFO_LOT.test(c)) return true;
  // All-caps captions with no lowercase letters are almost always placards.
  if (c.length > 6 && c === c.toUpperCase() && /[A-Z]/.test(c)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/* Read the parts of an instant as they appear in Colorado, not UTC. */
function partsInTz(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** "Thu Aug 20" */
function shortDate(date) {
  const p = partsInTz(date);
  return `${p.weekday} ${p.month} ${p.day}`;
}

/** "6:00 PM" */
function shortTime(date) {
  const p = partsInTz(date);
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/* Pickup is always the day after the sale closes. Adding 24h to the instant is
 * wrong across a DST change — Nov 1 would land back on Oct 31 — so step the
 * calendar day in Colorado terms and rebuild from those numbers. */
function nextDay(date) {
  const p = partsInTz(date);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(Date.UTC(+p.year, MONTHS.indexOf(p.month), +p.day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + 1);
  // Noon UTC keeps the date stable when re-read in Colorado (UTC-6/-7).
  return d;
}

/* The catalog page embeds every lot's soft-close instant as
 * "end_time":"2026-08-27T00:07:00.000Z". The earliest one is when the sale
 * starts closing, and unlike the staff-written description it is the time the
 * bidding engine actually enforces. */
function earliestEndTime(html) {
  let earliest = null;
  for (const m of html.matchAll(/"end_time"\s*:\s*"([^"]+)"/g)) {
    const t = new Date(m[1]);
    if (isNaN(t)) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest;
}

/* Without a token we fall back to fixtures/airtable.json — a snapshot of the
 * base. That lets the site be built and previewed locally without handing a
 * credential around. CI always has the real token. */
const OFFLINE = !TOKEN;

if (OFFLINE) {
  console.warn('AIRTABLE_TOKEN not set — building from fixtures/airtable.json (offline preview).');
}

/* ------------------------------------------------------------------ */
/* Airtable                                                            */
/* ------------------------------------------------------------------ */

async function airtable(path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

let fixtures = null;
async function loadFixtures() {
  if (fixtures) return fixtures;
  const { readFile } = await import('node:fs/promises');
  fixtures = JSON.parse(await readFile('fixtures/airtable.json', 'utf8'));
  return fixtures;
}

async function listAll(tableId) {
  if (OFFLINE) {
    const f = await loadFixtures();
    return f[tableId] || [];
  }

  const records = [];
  let offset;
  do {
    const qs = offset ? `?offset=${encodeURIComponent(offset)}` : '';
    const page = await airtable(`${tableId}${qs}`);
    records.push(...page.records);
    offset = page.offset;
  } while (offset);
  return records;
}

/* ------------------------------------------------------------------ */
/* Scraping                                                            */
/* ------------------------------------------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The site rate-limits (429) if you hit it quickly, so every request goes
 * through one queue with a gap between calls and a backoff retry. Slower, but
 * this runs on a schedule with nobody waiting on it. */
let chain = Promise.resolve();
const REQUEST_GAP_MS = 2500;
const MAX_ATTEMPTS = 4;

function getHtml(url) {
  // The whole retry loop runs inside one queue slot — retrying must not
  // re-enter the queue, or it would wait on the slot it is already holding.
  const run = async () => {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await sleep(attempt === 1 ? REQUEST_GAP_MS : 5000 * (attempt - 1));

      try {
        const res = await fetch(url, {
          headers: {
            // Identify ourselves honestly — this is Woolsey's own site.
            'User-Agent': 'WoolseyTVDashboard/1.0 (+https://github.com/Dgwoolsey/auction-tv)'
          }
        });

        if (res.status === 429) {
          console.warn(`  429 from ${url} (attempt ${attempt}/${MAX_ATTEMPTS})`);
          lastError = new Error(`${url} rate limited`);
          continue;
        }

        if (!res.ok) throw new Error(`${url} returned ${res.status}`);

        // Decode as UTF-8 explicitly. The pages carry inch marks and dashes
        // that come out as mojibake ("72â€") if the charset is guessed wrong.
        const buf = await res.arrayBuffer();
        return new TextDecoder('utf-8').decode(buf);
      } catch (err) {
        lastError = err;
        if (attempt === MAX_ATTEMPTS) break;
      }
    }

    throw lastError;
  };

  chain = chain.then(run, run);
  return chain;
}

/** Find the live auctions listed on the bidding site's home page. */
async function findAuctions() {
  const $ = cheerio.load(await getHtml(SITE));
  const found = new Map();

  $('a[href*="/auctions/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/auctions\/(\d+)(?:[/-]|$)/);
    if (!m) return;

    const id = m[1];
    if (!found.has(id)) found.set(id, { id, slugPath: null, title: '' });

    const rec = found.get(id);
    // The slug URL (…/47882-collectors-curiosity-…) is the catalog page.
    if (/\/auctions\/\d+-/.test(href) && !rec.slugPath) {
      rec.slugPath = href.startsWith('http') ? href : SITE + href;
    }
    // Home-page link text is boilerplate ("Enter Auction »"), so ignore it —
    // the real title comes from the landing page's <h1>.
    const text = $(a).text().trim();
    if (!/^(enter auction|view|details|bid now)/i.test(text) && text.length > rec.title.length) {
      rec.title = text;
    }
  });

  return [...found.values()];
}

/** Pull title, dates, lot count and hero image off an auction landing page. */
async function readLanding(auction) {
  try {
    const html = await getHtml(`${SITE}/auctions/${auction.id}/landing`);
    const $ = cheerio.load(html);

    const title = ($('h1').first().text() || auction.title || '').trim();

    // The catalog link lives on the landing page.
    if (!auction.slugPath) {
      const slug = $('a[href*="/auctions/' + auction.id + '-"]').first().attr('href');
      if (slug) auction.slugPath = slug.startsWith('http') ? slug : SITE + slug;
    }

    const text = $('body').text().replace(/\s+/g, ' ');
    const lots = text.match(/([\d,]+)\s+lots?\b/i);

    // The site words this several ways: "open now through August 20, 2026",
    // "Bidding ends Aug 24, 2026", "Online bidding through Aug 20, 2026".
    // Collect every hit and keep the one with the full month name.
    const dateRe = /(?:through|ends?|closes?|closing)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/gi;
    const hits = [...text.matchAll(dateRe)].map(m => m[1].replace(/,$/, '').trim());
    const closes = hits.sort((a, b) => b.length - a.length)[0] || '';

    const hero = $('img[src*="as-assets.marknetalliance.com"]').first().attr('src') || '';

    return {
      ...auction,
      title: title || auction.title,
      lotCount: lots ? parseInt(lots[1].replace(/,/g, ''), 10) : null,
      closeDate: closes,
      heroImage: hero,
      listingUrl: auction.slugPath || `${SITE}/auctions/${auction.id}/landing`
    };
  } catch (err) {
    console.warn(`  landing page for ${auction.id} failed: ${err.message}`);
    return { ...auction, lotCount: null, closeDate: '', heroImage: '', listingUrl: `${SITE}/auctions/${auction.id}/landing` };
  }
}

/* Pull the lot photos out of one already-fetched catalog page. */
function parseLots($, auctionId, seen) {
  const photos = [];

  // The catalog page carries ~250 as-assets images, but only the lot-grid
  // ones have real alt text — the rest are cloned carousel thumbnails with
  // empty alts, plus the site logo. Requiring a meaningful alt gives us the
  // ~50 genuine lot photos and their captions in one step.
  $('img[src*="as-assets.marknetalliance.com"]').each((_, img) => {
    const src = $(img).attr('src');
    const alt = ($(img).attr('alt') || '').trim();

    if (!src || seen.has(src)) return;
    if (!alt) return;                                   // carousel duplicate
    if (/^(website logo|logo|image|photo|thumbnail)$/i.test(alt)) return;
    if (isInfoLot(alt)) return;                         // informational placard

    seen.add(src);

    // The catalog serves /medium/ (432x576), which is soft on a big screen.
    // The same path under /large/ is 1500x2000. Keep medium as a fallback in
    // case a particular image was never rendered at the larger size.
    const large = src.replace('/medium/', '/large/');

    photos.push({
      imageUrl: large,
      fallbackUrl: large === src ? null : src,
      caption: cleanCaption(alt),
      auctionId
    });
  });

  return photos;
}

/** Pull lot photos, and the real closing time, off an auction's catalog.
 *
 * The catalog is paginated at ~50 lots per page via ?page=N. Reading only the
 * first page meant a 785-lot sale showed the same 46 photos forever, so we walk
 * pages until the per-auction cap is met or a page stops yielding anything new.
 *
 * Mutates auction.closeAt — the close time is embedded in the same HTML, so
 * harvesting it here costs no extra request.
 */
async function readLots(auction) {
  if (!auction.slugPath) return [];

  const photos = [];
  const seen = new Set();
  const joiner = auction.slugPath.includes('?') ? '&' : '?';

  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    if (photos.length >= MAX_PHOTOS_PER_AUCTION) break;

    const url = page === 1 ? auction.slugPath : `${auction.slugPath}${joiner}page=${page}`;

    try {
      const html = await getHtml(url);
      const $ = cheerio.load(html);

      // Page 1 carries the whole sale's lot set in its embedded data, so its
      // earliest end_time is the sale's. Later pages only see their own lots.
      if (page === 1) {
        const end = earliestEndTime(html);
        if (end) auction.closeAt = end;
      }

      const batch = parseLots($, auction.id, seen);
      // A page past the end of the catalog re-serves the last page or comes
      // back empty; either way nothing new appears and we are done.
      if (!batch.length) break;

      photos.push(...batch);
    } catch (err) {
      console.warn(`  catalog for ${auction.id} page ${page} failed: ${err.message}`);
      break;
    }
  }

  return photos.slice(0, MAX_PHOTOS_PER_AUCTION);
}

/* ------------------------------------------------------------------ */
/* Write scraped auctions back into Airtable so they're visible/editable */
/* ------------------------------------------------------------------ */

async function syncAuctions(scraped) {
  if (OFFLINE) {
    console.log('Offline preview — skipping Airtable write-back.');
    return;
  }

  const existing = await listAll(TABLES.auctions);
  const byId = new Map(existing.map(r => [String(r.fields.AuctionId || ''), r]));

  const creates = [];
  const updates = [];

  for (const a of scraped) {
    const fields = {
      Title: a.title || `Auction ${a.id}`,
      AuctionId: String(a.id),
      CloseDate: a.closeAt ? `${shortDate(a.closeAt)} ${shortTime(a.closeAt)}` : (a.closeDate || ''),
      LotCount: a.lotCount || undefined,
      HeroImage: a.heroImage || undefined,
      ListingUrl: a.listingUrl || undefined,
      Active: true
    };
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const hit = byId.get(String(a.id));
    if (hit) updates.push({ id: hit.id, fields });
    else creates.push({ fields });
  }

  // Any auction we no longer see on the site gets unchecked, not deleted —
  // deleting would throw away anything Dalton typed into the row.
  const liveIds = new Set(scraped.map(a => String(a.id)));
  for (const r of existing) {
    if (!liveIds.has(String(r.fields.AuctionId || '')) && r.fields.Active) {
      updates.push({ id: r.id, fields: { Active: false } });
    }
  }

  for (let i = 0; i < creates.length; i += 10) {
    await airtable(TABLES.auctions, {
      method: 'POST',
      body: JSON.stringify({ records: creates.slice(i, i + 10), typecast: true })
    });
  }
  for (let i = 0; i < updates.length; i += 10) {
    await airtable(TABLES.auctions, {
      method: 'PATCH',
      body: JSON.stringify({ records: updates.slice(i, i + 10), typecast: true })
    });
  }

  console.log(`Airtable Auctions: ${creates.length} created, ${updates.length} updated`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('Reading Airtable…');
  const [termRecords, settingRecords, slideRecords] = await Promise.all([
    listAll(TABLES.terms),
    listAll(TABLES.settings),
    listAll(TABLES.slides)
  ]);

  const settings = {};
  for (const r of settingRecords) {
    if (r.fields.Key) settings[r.fields.Key] = r.fields.Value || '';
  }

  const terms = termRecords
    .filter(r => r.fields.Active !== false && r.fields.Title)
    .sort((a, b) => (a.fields.Order || 999) - (b.fields.Order || 999))
    .map(r => ({
      title: r.fields.Title,
      body: r.fields.Body || '',
      emphasis: r.fields.Emphasis || 'Normal'
    }));

  console.log(`  ${terms.length} terms tiles, ${Object.keys(settings).length} settings`);

  // Photos Dalton added by hand (URL field or phone upload) come first.
  const manualSlides = slideRecords
    .filter(r => r.fields.Active !== false)
    .sort((a, b) => (a.fields.Order || 999) - (b.fields.Order || 999))
    .map(r => {
      const attachment = (r.fields.Photo || [])[0];
      return {
        imageUrl: r.fields.ImageUrl || (attachment && attachment.url) || '',
        caption: r.fields.Caption || ''
      };
    })
    .filter(s => s.imageUrl);

  console.log(`  ${manualSlides.length} manual photos`);

  // Scrape the live site.
  let auctions = [];
  let scrapedSlides = [];

  try {
    console.log('Scraping bid.woolseyauction.com…');
    const bare = await findAuctions();
    console.log(`  found ${bare.length} auction link(s)`);

    auctions = await Promise.all(bare.map(readLanding));

    const lotSets = await Promise.all(auctions.map(readLots));
    scrapedSlides = lotSets.flat();
    console.log(`  ${scrapedSlides.length} lot photos`);

    // Soonest-closing first, so the carousel leads with the sale a customer at
    // the counter is most likely to still be able to bid on. Sales with no
    // close time fall to the back rather than jumbling the order.
    auctions.sort((a, b) => {
      if (!a.closeAt) return 1;
      if (!b.closeAt) return -1;
      return a.closeAt - b.closeAt;
    });

    for (const a of auctions) {
      console.log(`  ${a.id}: closes ${a.closeAt ? a.closeAt.toISOString() : '(unknown)'}`);
    }

    if (auctions.length) {
      await syncAuctions(auctions);
    }
  } catch (err) {
    console.warn(`Scrape failed, publishing Airtable content only: ${err.message}`);
  }

  /* Interleave the scraped photos round-robin across auctions.
   *
   * Left grouped, all of auction A plays before any of auction B — with 45
   * photos each at 7 seconds, the second auction does not appear for over five
   * minutes, so the TV looks like it is only advertising one sale. Alternating
   * means every auction is on screen within the first few slides. */
  const byAuction = new Map();
  for (const photo of scrapedSlides) {
    const key = photo.auctionId || 'unknown';
    if (!byAuction.has(key)) byAuction.set(key, []);
    byAuction.get(key).push(photo);
  }

  const queues = [...byAuction.values()];
  const interleaved = [];
  for (let i = 0; queues.some(q => q.length > i); i++) {
    for (const q of queues) {
      if (q[i]) interleaved.push(q[i]);
    }
  }

  // Photos Dalton added by hand lead, then the interleaved auction lots.
  const slides = [...manualSlides, ...interleaved].slice(0, MAX_PHOTOS_TOTAL);

  console.log(`  slide order: ${queues.length} auction(s) interleaved`);

  // QR codes are rendered once here rather than in the browser, so the TV
  // never needs a network call to a third party.
  const qrOpts = { type: 'svg', margin: 0, errorCorrectionLevel: 'M',
                   color: { dark: '#000000', light: '#ffffff' } };

  const qr = {};
  for (const [key, setting] of [['google','google_review_url'],
                                ['facebook','facebook_review_url'],
                                ['consign','consign_form_url'],
                                ['bid','bid_url']]) {
    if (settings[setting]) {
      qr[key] = await QRCode.toString(settings[setting], qrOpts);
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    headline: settings.headline || 'Thanks for bidding with us',
    ticker: settings.ticker || '',
    phone: settings.phone || '',
    email: settings.email || '',
    slideSeconds: parseFloat(settings.slide_seconds) || 7,
    termsSeconds: parseFloat(settings.terms_seconds) || 12,
    qr,
    terms,
    auctions: auctions.map(a => {
      // closeAt comes from the catalog's embedded lot end times and is what the
      // bidding engine enforces; the landing-page prose is only a fallback, and
      // on at least one sale it has disagreed with the real close by a day.
      const pickup = a.closeAt ? nextDay(a.closeAt) : null;
      return {
        title: a.title,
        closeAt: a.closeAt ? a.closeAt.toISOString() : '',
        closeDay: a.closeAt ? shortDate(a.closeAt) : (a.closeDate || ''),
        closeTime: a.closeAt ? shortTime(a.closeAt) : '',
        pickupDay: pickup ? shortDate(pickup) : '',
        lotCount: a.lotCount,
        listingUrl: a.listingUrl
      };
    }),
    slides
  };

  await mkdir('public', { recursive: true });
  await writeFile('public/data.json', JSON.stringify(data, null, 2));

  console.log(`\nWrote public/data.json — ${terms.length} terms, ${slides.length} photos, ${auctions.length} auctions`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
