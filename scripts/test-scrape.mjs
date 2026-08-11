/* Scrape-only smoke test. Hits the live auction site and prints what the
 * build script would find, without touching Airtable. Run: node scripts/test-scrape.mjs
 */
import * as cheerio from 'cheerio';

const SITE = 'https://bid.woolseyauction.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let chain = Promise.resolve();
function getHtml(url) {
  const run = async () => {
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await sleep(attempt === 1 ? 2500 : 5000 * (attempt - 1));
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'WoolseyTVDashboard/1.0 (+https://github.com/Dgwoolsey/auction-tv)' }
        });
        if (res.status === 429) {
          console.warn(`  429 (attempt ${attempt}/4)`);
          lastError = new Error('rate limited');
          continue;
        }
        if (!res.ok) throw new Error(`returned ${res.status}`);
        return await res.text();
      } catch (e) { lastError = e; }
    }
    throw lastError;
  };
  chain = chain.then(run, run);
  return chain;
}

const $ = cheerio.load(await getHtml(SITE));
const ids = new Set();
$('a[href*="/auctions/"]').each((_, a) => {
  const m = ($(a).attr('href') || '').match(/\/auctions\/(\d+)(?:[/-]|$)/);
  if (m) ids.add(m[1]);
});

console.log(`Found ${ids.size} auction(s): ${[...ids].join(', ')}\n`);

for (const id of ids) {
  console.log(`=== ${id} ===`);
  let slugPath = null;
  try {
    const $$ = cheerio.load(await getHtml(`${SITE}/auctions/${id}/landing`));
    console.log(`  h1: ${($$('h1').first().text() || '').trim().slice(0, 100)}`);

    const slug = $$(`a[href*="/auctions/${id}-"]`).first().attr('href');
    if (slug) slugPath = slug.startsWith('http') ? slug : SITE + slug;

    const text = $$('body').text().replace(/\s+/g, ' ');
    const lots = text.match(/([\d,]+)\s+lots?\b/i);
    console.log(`  lots: ${lots ? lots[1] : '(none)'}`);

    // Dump every window around "clos"/"end" so we can see the real date wording.
    const windows = [];
    const re = /(clos|ending|ends|bidding)/gi;
    let m;
    while ((m = re.exec(text)) && windows.length < 4) {
      windows.push(text.slice(Math.max(0, m.index - 40), m.index + 90));
    }
    windows.forEach(w => console.log(`  ctx: …${w}…`));
  } catch (e) {
    console.log(`  landing FAILED: ${e.message}`);
  }

  if (slugPath) {
    try {
      const $$$ = cheerio.load(await getHtml(slugPath));
      const imgs = [];
      $$$('img[src*="as-assets.marknetalliance.com"]').each((_, img) => {
        let cap = ($$$(img).attr('alt') || '').trim();
        if (!cap || /^(image|photo|thumbnail)$/i.test(cap)) {
          cap = $$$(img).closest('a, li, div').find('h2, h3, h4, .lot-title').first().text().trim();
        }
        imgs.push({ src: $$$(img).attr('src'), cap });
      });
      console.log(`  PHOTOS: ${imgs.length}`);
      imgs.slice(0, 3).forEach(i => console.log(`    - ${(i.cap || '(no caption)').slice(0, 70)}`));
    } catch (e) {
      console.log(`  catalog FAILED: ${e.message}`);
    }
  } else {
    console.log('  no catalog link found');
  }
  console.log('');
}
