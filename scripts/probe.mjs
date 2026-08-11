/* One-off: dump the markup around a lot image so we can find the caption. */
import * as cheerio from 'cheerio';

const url = 'https://bid.woolseyauction.com/auctions/47882-collectors-curiosity-auction-dall-deweese-original-floor-safe-rare-pipes-jewelry-antiques-and-oddities';
const res = await fetch(url, { headers: { 'User-Agent': 'WoolseyTVDashboard/1.0' } });
const $ = cheerio.load(await res.text());

const imgs = $('img[src*="as-assets.marknetalliance.com"]');
console.log(`total as-assets images: ${imgs.length}\n`);

// Show alt values and which look like logos
const alts = {};
imgs.each((_, i) => { const a = ($(i).attr('alt') || '(empty)').trim(); alts[a] = (alts[a] || 0) + 1; });
console.log('alt text frequency:');
Object.entries(alts).sort((a,b) => b[1]-a[1]).slice(0, 8).forEach(([k,v]) => console.log(`  ${v} x "${k.slice(0,60)}"`));

console.log('\nsrc path prefixes:');
const prefixes = {};
imgs.each((_, i) => {
  const m = ($(i).attr('src') || '').match(/marknetalliance\.com\/([^/]+)\//);
  const p = m ? m[1] : '?';
  prefixes[p] = (prefixes[p] || 0) + 1;
});
Object.entries(prefixes).forEach(([k,v]) => console.log(`  ${v} x /${k}/`));

console.log('\n--- ancestry of image #5 ---');
const target = imgs.eq(5);
let node = target;
for (let up = 0; up < 6; up++) {
  node = node.parent();
  if (!node.length) break;
  const tag = node.prop('tagName');
  const cls = (node.attr('class') || '').slice(0, 70);
  const text = node.text().replace(/\s+/g, ' ').trim().slice(0, 100);
  console.log(`  ${up}: <${tag} class="${cls}">  text: ${text}`);
}

console.log('\n--- candidate title selectors near images ---');
['h2','h3','h4','h5','a[href*="/lots/"]','[class*="title"]','[class*="Title"]','[class*="name"]'].forEach(sel => {
  const n = $(sel).length;
  const sample = $(sel).first().text().replace(/\s+/g,' ').trim().slice(0, 60);
  console.log(`  ${sel}: ${n} found  e.g. "${sample}"`);
});
