/* Woolsey Auction Company — checkout counter TV
 *
 * Reads data.json (rebuilt every 15 minutes by GitHub Actions from Airtable
 * plus a scrape of bid.woolseyauction.com) and drives the display.
 *
 * Designed to run unattended for weeks: it never throws on bad data, it keeps
 * showing the last good content if a refresh fails, and it skips photos that
 * fail to load rather than showing a broken frame.
 */

(function () {
  'use strict';

  var DATA_URL = 'data.json';
  var REFRESH_MS = 5 * 60 * 1000;   // re-read data.json every 5 minutes
  var RELOAD_MS = 6 * 60 * 60 * 1000; // full page reload every 6 hours

  var state = {
    data: null,
    slides: [],
    slideIdx: 0,
    termIdx: 0,
    frontIsA: true,
    slideTimer: null,
    termTimer: null
  };

  var el = {};
  ['headline','clockTime','clockDate','photoA','photoB','photoEmpty','photoCaption',
   'auctionStrip','termsCard','termsTitle','termsBody','termsDots','qrGoogle',
   'qrFacebook','qrConsign','qrTerms','tickerTrack','status'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ---------------- helpers ---------------- */

  function status(msg) {
    if (!el.status) return;
    if (!msg) { el.status.classList.remove('show'); return; }
    el.status.textContent = msg;
    el.status.classList.add('show');
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  /* ---------------- clock ---------------- */

  function tickClock() {
    var now = new Date();
    var h = now.getHours();
    var m = String(now.getMinutes()).padStart(2, '0');
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    el.clockTime.textContent = h + ':' + m + ' ' + ampm;
    el.clockDate.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  /* ---------------- photo slideshow ---------------- */

  function showSlide() {
    if (!state.slides.length) {
      el.photoEmpty.classList.remove('hide');
      el.photoCaption.textContent = '';
      return;
    }

    var slide = state.slides[state.slideIdx % state.slides.length];
    state.slideIdx = (state.slideIdx + 1) % state.slides.length;

    var incoming = state.frontIsA ? el.photoB : el.photoA;
    var outgoing = state.frontIsA ? el.photoA : el.photoB;

    var img = new Image();
    var triedFallback = false;

    img.onload = function () {
      el.photoEmpty.classList.add('hide');
      incoming.src = img.src;
      incoming.classList.add('on');
      outgoing.classList.remove('on');
      state.frontIsA = !state.frontIsA;
      el.photoCaption.textContent = slide.caption || '';
    };

    img.onerror = function () {
      // The high-res version may not exist for every lot — try the smaller
      // one once before giving up on this photo.
      if (!triedFallback && slide.fallbackUrl) {
        triedFallback = true;
        img.src = slide.fallbackUrl;
        return;
      }
      // Drop the dead image so we never retry it, then move straight on.
      var bad = state.slides.indexOf(slide);
      if (bad > -1) state.slides.splice(bad, 1);
      if (state.slides.length) showSlide();
    };

    img.src = slide.imageUrl;
  }

  function startSlides(seconds) {
    clearInterval(state.slideTimer);
    showSlide();
    state.slideTimer = setInterval(showSlide, seconds * 1000);
  }

  /* ---------------- rotating terms ---------------- */

  function renderDots(count, active) {
    var html = '';
    for (var i = 0; i < count; i++) {
      html += '<div class="dot' + (i === active ? ' on' : '') + '"></div>';
    }
    el.termsDots.innerHTML = html;
  }

  function showTerm() {
    var terms = (state.data && state.data.terms) || [];
    if (!terms.length) return;

    var i = state.termIdx % terms.length;
    var t = terms[i];
    state.termIdx = (state.termIdx + 1) % terms.length;

    el.termsCard.classList.add('fade');

    setTimeout(function () {
      el.termsTitle.textContent = t.title || '';
      el.termsBody.textContent = t.body || '';
      el.termsCard.classList.remove('is-warning', 'is-highlight');
      if (t.emphasis === 'Warning')   el.termsCard.classList.add('is-warning');
      if (t.emphasis === 'Highlight') el.termsCard.classList.add('is-highlight');
      renderDots(terms.length, i);
      el.termsCard.classList.remove('fade');
    }, 500);
  }

  function startTerms(seconds) {
    clearInterval(state.termTimer);
    state.termIdx = 0;
    el.termsCard.classList.remove('fade');
    var terms = (state.data && state.data.terms) || [];
    if (terms.length) {
      var t = terms[0];
      el.termsTitle.textContent = t.title || '';
      el.termsBody.textContent = t.body || '';
      el.termsCard.classList.remove('is-warning', 'is-highlight');
      if (t.emphasis === 'Warning')   el.termsCard.classList.add('is-warning');
      if (t.emphasis === 'Highlight') el.termsCard.classList.add('is-highlight');
      renderDots(terms.length, 0);
      state.termIdx = 1;
    }
    state.termTimer = setInterval(showTerm, seconds * 1000);
  }

  /* ---------------- auctions strip ---------------- */

  function renderAuctions(auctions) {
    if (!auctions || !auctions.length) { el.auctionStrip.innerHTML = ''; return; }
    el.auctionStrip.innerHTML = auctions.slice(0, 3).map(function (a) {
      var meta = [];
      if (a.closeDate) meta.push(a.closeDate);
      if (a.lotCount)  meta.push(a.lotCount + ' lots');
      return '<div class="auction-chip">' +
               '<div class="auction-chip-title"></div>' +
               '<div class="auction-chip-meta"></div>' +
             '</div>';
    }).join('');

    // Set text via textContent so auction titles can never inject markup.
    var chips = el.auctionStrip.querySelectorAll('.auction-chip');
    auctions.slice(0, 3).forEach(function (a, i) {
      var meta = [];
      if (a.closeDate) meta.push(a.closeDate);
      if (a.lotCount)  meta.push(a.lotCount + ' lots');
      chips[i].querySelector('.auction-chip-title').textContent = a.title || '';
      chips[i].querySelector('.auction-chip-meta').textContent = meta.join('  ·  ');
    });
  }

  /* ---------------- QR codes ---------------- */

  function renderQr(node, svg) {
    if (!node) return;
    var card = node.closest('.qr-card');
    node.innerHTML = '';

    // A code with no URL behind it would just be an empty white square, so
    // hide the whole card and let the others take the space.
    if (!svg) {
      if (card) card.classList.add('hide');
      return;
    }

    if (card) card.classList.remove('hide');
    // svg is generated at build time by the qrcode package; it is our own
    // content, not user input.
    node.innerHTML = svg;
  }

  /* ---------------- apply data ---------------- */

  function apply(data) {
    state.data = data;

    el.headline.textContent = data.headline || 'Thanks for bidding with us';
    el.tickerTrack.textContent = data.ticker || '';

    renderAuctions(data.auctions);

    var qr = data.qr || {};
    renderQr(el.qrGoogle, qr.google);
    renderQr(el.qrFacebook, qr.facebook);
    renderQr(el.qrConsign, qr.consign);
    renderQr(el.qrTerms, qr.terms);

    state.slides = (data.slides || []).filter(function (s) { return s && s.imageUrl; });
    state.slideIdx = 0;

    startSlides(num(data.slideSeconds, 7));
    startTerms(num(data.termsSeconds, 12));

    status('');
  }

  /* ---------------- load ---------------- */

  function load(isRefresh) {
    fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        apply(data);
      })
      .catch(function (err) {
        if (isRefresh && state.data) {
          // Keep showing the last good content — a failed refresh should never
          // blank the screen in front of customers.
          status('Showing last update');
        } else {
          status('Could not load content — ' + err.message);
        }
      });
  }

  /* ---------------- go ---------------- */

  tickClock();
  setInterval(tickClock, 10000);

  load(false);
  setInterval(function () { load(true); }, REFRESH_MS);

  // Long-running kiosk browsers leak memory; a scheduled reload keeps it fresh.
  setTimeout(function () { location.reload(); }, RELOAD_MS);

})();
