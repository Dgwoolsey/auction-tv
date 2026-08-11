# Woolsey Auction TV Dashboard

The screen behind the checkout counter.

**Live:** https://dgwoolsey.github.io/auction-tv/

Open that URL on any computer, press `F11` for full screen, and leave it. It
refreshes itself and reloads every 6 hours so it can run for weeks untouched.

---

## How to change what's on the screen

Everything is in the **Woolsey TV Dashboard** base in Airtable. Edit it from the
Airtable phone app or the website — no code, no deploy. Changes appear on the TV
within 30 minutes.

| Table | What it controls |
|---|---|
| **Terms** | The rotating tiles on the right. Uncheck `Active` to hide one; change `Order` to reorder. `Emphasis` sets the color bar — Warning is red, Highlight is gold. |
| **Settings** | The headline, the scrolling message at the bottom, the three QR code links, and how many seconds each photo and each terms tile stays up. |
| **Slides** | Photos you add yourself, by URL or by uploading from your phone. These play *before* the scraped auction photos. Leave it empty to show only auction lots. |
| **Auctions** | Filled in automatically. Don't edit — the scraper overwrites it. Unchecking `Active` is ignored; it's there so you can see what was found. |

### To change the ticker message for the day

Airtable → Settings → the `ticker` row → edit `Value`. Done.

### To take a terms tile down

Airtable → Terms → uncheck `Active` on that row.

---

## Where the photos come from

A scheduled job reads `bid.woolseyauction.com`, finds the live auctions, and
pulls lot photos off each catalog page. It:

- skips the informational placard lots (ATTENTION, PAYMENT INFORMATION, etc.)
- uses the 1500x2000 version of each photo, not the 432x576 thumbnail
- cleans up lot titles that repeat themselves or carry staff notes
- caps at 45 photos per auction, 120 total

No login is needed — it only reads pages any bidder can see. Nothing about this
depends on your admin password.

---

## How it runs

GitHub Actions rebuilds `data.json` every 30 minutes and publishes to GitHub
Pages. The Airtable token lives in Actions secrets and is never sent to the
browser, so the published page contains no credentials.

To force an immediate refresh instead of waiting: repo → **Actions** → *Build and
deploy TV dashboard* → **Run workflow**.

---

## If the screen goes wrong

**Blank or "Could not load content"** — the last build failed. Check the Actions
tab. The TV keeps showing the last good content on a failed *refresh*, so this
only appears on a cold start.

**Photos missing but terms still showing** — the scrape failed (site down or
changed). The build deliberately publishes Airtable content anyway rather than
failing outright. Add photos to the Slides table as a stopgap.

**Nothing changes after an Airtable edit** — wait 30 minutes, or force a run from
the Actions tab.

**Everything is stale** — the schedule may be disabled. GitHub turns off cron
schedules on repos with no activity for 60 days. Push any commit, or run the
workflow manually, to wake it up.

---

## Local development

```bash
npm install
node scripts/build-data.mjs     # builds from fixtures/ when AIRTABLE_TOKEN is unset
cp index.html styles.css app.js public/
npx http-server public -p 4173
```

`scripts/test-scrape.mjs` hits the live site and prints what it finds, without
touching Airtable — use it when the auction site changes and photos stop
appearing.
