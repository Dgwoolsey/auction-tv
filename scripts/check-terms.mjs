/* Checks the live auction pages for language unique to DRAFT v3 versus the
 * old Marknet default terms, to confirm which version is actually in effect. */

const V3 = [
  ['hand the keys back and lose all access', 'onsite: no access after pickup'],
  ['broom-swept',                            'disposal / broom-swept clause'],
  ['DR 5002',                                'current tax exemption form'],
  ['Specified Semiautomatic Firearm',        'SB25-003 eligibility card'],
  ['$50 per hour',                           'staff time rate'],
  ['2% discount',                            "buyer's premium as a discount"],
  ['$10 per lot, per day',                   'storage rate'],
  ['13-21-109',                              'returned check statute'],
  ['Fremont County',                         'venue clause'],
  ['three-day waiting period',               'firearms waiting period']
];

const OLD = [
  ['DR 0563',              'retired tax form'],
  ['bring them to the curb', 'curbside removal promise'],
  ['complete accordance with Colorado statutes', 'compliance warranty']
];

const urls = [
  'https://bid.woolseyauction.com/auctions/47882/landing',
  'https://bid.woolseyauction.com/auctions/47934/landing'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const u of urls) {
  const res = await fetch(u, { headers: { 'User-Agent': 'WoolseyTVDashboard/1.0' } });
  const raw = await res.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&rsquo;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const id = u.split('/')[4];
  console.log(`\n=== auction ${id}  (HTTP ${res.status}, ${text.length.toLocaleString()} chars) ===`);

  let v3hits = 0, oldhits = 0;

  console.log('  -- DRAFT v3 language --');
  for (const [needle, label] of V3) {
    const hit = text.includes(needle);
    if (hit) v3hits++;
    console.log(`    ${hit ? 'FOUND ' : 'absent'}  ${label}`);
  }

  console.log('  -- OLD terms language --');
  for (const [needle, label] of OLD) {
    const hit = text.includes(needle);
    if (hit) oldhits++;
    console.log(`    ${hit ? 'FOUND ' : 'absent'}  ${label}`);
  }

  console.log(`  => v3 markers: ${v3hits}/${V3.length}   old markers: ${oldhits}/${OLD.length}`);
  await sleep(3000);
}
