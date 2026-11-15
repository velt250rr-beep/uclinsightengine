/* Matchday carousel and static fixture grid for Match Analysis. */
(function (g) {
  'use strict';
  const NS = (g.UCL = g.UCL || {});
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const day = (m) => String(m.date || '').slice(0, 10);
  const month = (d) => d.slice(0, 7);
  const conf = (r) => r.a && r.a.final ? r.a.final.confidence.label : 'Pending';
  const confClass = (v) => ({ High:'high', Medium:'medium', Low:'low' }[v] || 'pending');
  const fmtDate = (d, opts) => { const x = new Date(d + 'T12:00:00Z'); return isNaN(x) ? d : new Intl.DateTimeFormat('en-GB', Object.assign({timeZone:'UTC'}, opts || {})).format(x); };
  const fmtKickoff = (m) => { const t = /T(\d{2}:\d{2})/.exec(m.date || ''); return t ? t[1] + ' UTC' : 'Kickoff TBC'; };
  const pct = (v) => Number.isFinite(Number(v)) ? (Number(v) * 100).toFixed(1) + '%' : '—';
  const teamKey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const logos = Object.create(null);
  ((NS.data && NS.data.teamLogos) || []).forEach((t) => (t.names || []).forEach((n) => { logos[teamKey(n)] = t.file; }));
  const mark = (name, side) => {
    const ws = String(name || '?').split(/[\s/.-]+/).filter((w) => w && !/^(FC|AFC|AC|SC|FK|RSC|SK|CF)$/i.test(w));
    const initials = ws.slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase();
    const logo = logos[teamKey(name)];
    return '<span class="mc-crest ' + side + (logo ? ' has-logo' : '') + '" aria-hidden="true"><span>' + esc(initials || '?') + '</span>' +
      (logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy" onerror="this.parentElement.classList.remove(\'has-logo\');this.remove()">' : '') + '</span>';
  };
  const href = (m) => '#/analysis/' + encodeURIComponent(m.id);
  function slide(r, app) {
    const m = r.match, a = r.a, c = conf(r), d = day(m), h = m.homeName || 'Home team', away = m.awayName || 'Away team';
    const p = a && a.final ? a.final.probs : {};
    const q = (x) => pct(p[x]);
    const odds = [m.oddsH, m.oddsD, m.oddsA].every((v) => Number.isFinite(Number(v)) && Number(v) > 1) ? [m.oddsH,m.oddsD,m.oddsA].map((v) => Number(v).toFixed(2)).join(' / ') : 'Not supplied';
    const xg = m.homeXg != null && m.awayXg != null && Number.isFinite(Number(m.homeXg)) && Number.isFinite(Number(m.awayXg)) ? Number(m.homeXg).toFixed(2) + ' – ' + Number(m.awayXg).toFixed(2) : 'Not supplied';
    return '<article class="mc-slide" data-slide data-date="' + esc(d) + '" data-month="' + esc(month(d)) + '" data-confidence="' + esc(c) + '">' +
      '<div class="mc-hero"><a class="mc-scoreboard" href="' + esc(href(m)) + '" aria-label="' + esc('Open full analysis for ' + h + ' versus ' + away) + '"><img class="mc-watermark" src="assets/icons/ucl-starball-reference.png" alt="">' +
        '<div class="mc-score-inner"><div class="mc-stage"><span>✦ &nbsp;' + esc((m.stage || 'League phase').toUpperCase()) + '</span><span>' + esc(fmtDate(d,{day:'numeric',month:'short',year:'numeric'})) + '</span></div>' +
        '<p class="mc-date">' + esc(fmtDate(d,{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase().replace(',', ' ·')) + '</p>' +
        '<div class="mc-faceoff"><div class="mc-team"><i></i><div>' + mark(h,'home') + '<strong>' + esc(h) + '</strong><small>HOME</small></div></div><b class="mc-vs">VS</b><div class="mc-team away"><i></i><div>' + mark(away,'away') + '<strong>' + esc(away) + '</strong><small>AWAY</small></div></div></div>' +
        '<p class="mc-venue"><b>' + esc(fmtKickoff(m)) + '</b> · ' + esc(m.venue || 'Venue not supplied') + '</p></div></a>' +
        '<section class="mc-analysis"><div class="mc-analysis-head"><div><span class="mc-kicker">MATCH ANALYSIS</span><h2>Model confidence</h2></div><span class="mc-badge ' + confClass(c) + '">' + esc(c) + '</span></div>' +
        '<p class="mc-note">' + (a && a.final ? 'Probabilities use the loaded match data.' : 'Confidence will appear when analysis is available.') + '</p>' +
        (a && a.final ? '<p class="mc-pick">Model pick <b>' + esc(a.final.symbol) + '</b> ' + esc(a.final.label) + '</p>' : '') +
        '<h3>1X2 PREDICTION</h3><div class="mc-prob"><span>' + esc(h) + ' win</span><b>' + q('H') + '</b></div><div class="mc-prob"><span>Draw</span><b>' + q('D') + '</b></div><div class="mc-prob"><span>' + esc(away) + ' win</span><b>' + q('A') + '</b></div>' +
        '<p class="mc-footnote">Forecasts reflect the model and available data.</p>' + (app.hist.official(m.id)
        ? '<button type="button" class="mc-open mc-save-prediction" disabled><span>Prediction saved</span><span aria-hidden="true">✓</span></button>'
        : '<button type="button" class="mc-open mc-save-prediction" data-act="save-prediction" data-id="' + esc(m.id) + '"><span>Save as a prediction</span><span aria-hidden="true">＋</span></button>') + '</section></div>' +
        '<div class="mc-data"><div><span>Fixture</span><b>Available</b></div><div><span>Full-time score</span><b>' + (Number.isInteger(m.homeGoals) ? esc(m.homeGoals + '–' + m.awayGoals) : 'After match') + '</b></div><div><span>Bookmaker odds</span><b>' + esc(odds) + '</b></div><div><span>Expected goals · xG</span><b>' + esc(xg) + '</b></div></div></article>';
  }
  function card(r, app) {
    const m = r.match, c = conf(r), d = day(m), h = m.homeName || 'Home team', a = m.awayName || 'Away team';
    const saved = !!app.hist.official(m.id);
    const saveButton = saved
      ? '<button type="button" class="mc-card-save" disabled aria-label="Prediction already saved for ' + esc(h) + ' versus ' + esc(a) + '"><span>Prediction saved</span><span aria-hidden="true">✓</span></button>'
      : '<button type="button" class="mc-card-save" data-act="save-prediction" data-id="' + esc(m.id) + '" aria-label="Save as a prediction for ' + esc(h) + ' versus ' + esc(a) + '"><span>Save as a prediction</span><span aria-hidden="true">＋</span></button>';
    return '<article class="mc-card" data-card data-date="' + esc(d) + '" data-month="' + esc(month(d)) + '" data-confidence="' + esc(c) + '">' +
      '<a class="mc-card-link" href="' + esc(href(m)) + '" aria-label="' + esc('Open full analysis for ' + h + ' versus ' + a) + '">' +
      '<div class="mc-card-top"><time datetime="' + esc(m.date) + '">' + esc(fmtKickoff(m)) + '</time><span>' + esc(m.stage || 'League phase') + '</span></div>' +
      '<div class="mc-card-teams"><strong>' + esc(h) + '</strong><span>v</span><strong>' + esc(a) + '</strong></div>' +
      '<div class="mc-card-bottom"><span>Model confidence</span><b class="mc-badge ' + confClass(c) + '">' + esc(c) + '</b></div></a>' + saveButton + '</article>';
  }
  function render(app) {
    const rows = (app.upcoming(40) || []).filter((r) => r && r.match);
    if (!rows.length) return '<section class="match-center"><h1>Match Analysis</h1><div class="mc-empty">No upcoming fixtures are loaded. <a href="#/fixtures">Browse fixtures</a></div></section>';
    const dates = Array.from(new Set(rows.map((r) => day(r.match)).filter(Boolean))).sort();
    const months = Array.from(new Set(dates.map(month)));
    const first = dates[0], firstMonth = month(first);
    const dOpts = dates.filter((d) => month(d) === firstMonth).map((d) => '<option value="' + esc(d) + '"' + (d === first ? ' selected' : '') + '>' + esc(fmtDate(d,{day:'numeric',month:'short',year:'numeric'})) + '</option>').join('');
    const mOpts = months.map((m) => '<option value="' + esc(m) + '"' + (m === firstMonth ? ' selected' : '') + '>' + esc(fmtDate(m + '-01',{month:'long',year:'numeric'})) + '</option>').join('');
    return '<section class="match-center" data-match-center><header class="mc-page-head"><div><span class="mc-kicker">UEFA CHAMPIONS LEAGUE · MATCH CENTRE</span><h1>Match Analysis</h1><p>Upcoming fixtures and model forecasts.</p></div><span class="mc-ready">' + rows.length + ' fixtures ready</span></header>' +
      '<div class="mc-carousel" data-carousel><div class="mc-track">' + rows.map((row) => slide(row, app)).join('') + '</div><button class="mc-carousel-arrow mc-prev" type="button" data-prev aria-label="Previous match">‹</button><button class="mc-carousel-arrow mc-next" type="button" data-next aria-label="Next match">›</button></div>' +
      '<div class="mc-carousel-tools"><div class="mc-dots" data-dots></div><div><button type="button" data-prev aria-label="Previous match">‹</button><button type="button" data-toggle aria-pressed="false">Pause</button><button type="button" data-next aria-label="Next match">›</button></div></div>' +
      '<section class="mc-more"><div class="mc-more-head"><div><span class="mc-kicker">MORE MATCHES</span><h2>All matches on this date</h2></div><div class="mc-filters">' +
      '<label>Date<select data-date-filter>' + dOpts + '</select></label><label>Month<select data-month-filter>' + mOpts + '</select></label><label>Model confidence<select data-conf-filter><option value="all">All levels</option><option>High</option><option>Medium</option><option>Low</option><option>Pending</option></select></label></div></div>' +
      '<p class="mc-count" data-count>' + rows.filter((r) => day(r.match) === first).length + ' matches</p><div class="mc-grid">' + rows.map((row) => card(row, app)).join('') + '</div><div class="mc-empty hidden" data-empty>No matches match these filters.</div></section></section>';
  }
  let stop = null;
  function unmount() { if (stop) { stop(); stop = null; } }
  function mount(root) {
    unmount();
    const page = root && root.querySelector('[data-match-center]');
    if (!page) return;
    const track = page.querySelector('.mc-track'), slides = Array.from(page.querySelectorAll('[data-slide]')), cards = Array.from(page.querySelectorAll('[data-card]'));
    const date = page.querySelector('[data-date-filter]'), mon = page.querySelector('[data-month-filter]'), confidence = page.querySelector('[data-conf-filter]');
    const dots = page.querySelector('[data-dots]'), count = page.querySelector('[data-count]'), empty = page.querySelector('[data-empty]');
    const carousel = page.querySelector('[data-carousel]'), tools = page.querySelector('.mc-carousel-tools'), toggle = page.querySelector('[data-toggle]');
    const allDates = Array.from(new Set(slides.map((s) => s.dataset.date))).sort();
    let visible = [], index = 0, timer = null, paused = false, hovering = false, focused = false, touching = false, touchStart = null;
    const reduced = g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function clear() { if (timer) g.clearInterval(timer); timer = null; }
    function goTo(n) { if (!visible.length) return; index = (n + visible.length) % visible.length; track.style.transform = 'translateX(-' + index * 100 + '%)'; drawDots(); }
    function drawDots() {
      dots.innerHTML = '';
      visible.forEach((s, i) => { const b = document.createElement('button'); b.type='button'; b.className='mc-dot' + (i === index ? ' active' : '');
        b.setAttribute('aria-label','Show match ' + (i + 1)); b.setAttribute('aria-current', i === index ? 'true' : 'false');
        b.addEventListener('click', () => goTo(i)); dots.appendChild(b); });
    }
    function timerState() {
      clear(); toggle.textContent = paused ? 'Play' : 'Pause'; toggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
      if (!paused && !hovering && !focused && !touching && !reduced && !document.hidden && visible.length > 1) timer = g.setInterval(() => goTo(index + 1), 4000);
    }
    function matching(node) { return node.dataset.date === date.value && node.dataset.month === mon.value && (confidence.value === 'all' || node.dataset.confidence === confidence.value); }
    function update() {
      visible = slides.filter(matching); slides.forEach((s) => { s.hidden = !matching(s); }); cards.forEach((c) => { c.hidden = !matching(c); });
      index = 0; track.style.transform = 'translateX(0)'; const n = cards.filter((c) => !c.hidden).length;
      count.textContent = n + ' match' + (n === 1 ? '' : 'es'); empty.classList.toggle('hidden', n > 0);
      carousel.hidden = visible.length === 0; tools.hidden = visible.length === 0; drawDots(); timerState();
    }
    function onChange(e) {
      if (e.target === mon) {
        const ds = allDates.filter((d) => month(d) === mon.value);
        date.innerHTML = ds.map((d) => '<option value="' + esc(d) + '">' + esc(fmtDate(d,{day:'numeric',month:'short',year:'numeric'})) + '</option>').join('');
        date.value = ds[0] || '';
      } else if (e.target === date) {
        mon.value = month(date.value);
      }
      update();
    }
    function onClick(e) {
      const b = e.target.closest('[data-prev],[data-next],[data-toggle]'); if (!b) return;
      if (b.hasAttribute('data-prev')) { goTo(index - 1); carousel.removeAttribute('data-hover-side'); }
      else if (b.hasAttribute('data-next')) { goTo(index + 1); carousel.removeAttribute('data-hover-side'); }
      else { paused = !paused; timerState(); }
    }
    function updateHoverSide(e) {
      const rect = carousel.getBoundingClientRect();
      carousel.dataset.hoverSide = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    }
    function clearHoverSide() {
      carousel.removeAttribute('data-hover-side');
    }
    function onCarouselFocus(e) {
      focused = true;
      timerState();
      const b = e.target.closest('.mc-carousel-arrow');
      if (b) carousel.dataset.hoverSide = b.hasAttribute('data-prev') ? 'left' : 'right';
      else carousel.removeAttribute('data-hover-side');
    }
    function onCarouselFocusOut(e) {
      if (!carousel.contains(e.relatedTarget)) {
        focused = false;
        timerState();
        carousel.removeAttribute('data-hover-side');
      }
    }
    function onTouchStart(e) {
      if (e.touches.length !== 1 || visible.length < 2) {
        if (touchStart) { touchStart = null; touching = false; timerState(); }
        return;
      }
      const touch = e.touches[0];
      touchStart = { x: touch.clientX, y: touch.clientY };
      touching = true;
      timerState();
    }
    function onTouchEnd(e) {
      if (!touchStart) return;
      const touch = e.changedTouches[0], dx = touch.clientX - touchStart.x, dy = touch.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) goTo(index + (dx < 0 ? 1 : -1));
      touching = false;
      timerState();
    }
    function onTouchCancel() {
      if (!touchStart) return;
      touchStart = null;
      touching = false;
      timerState();
    }
    const canHover = g.matchMedia && g.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const onMouseEnter = () => { hovering = true; timerState(); };
    const onMouseLeave = () => { hovering = false; timerState(); };
    const visibility = () => timerState();
    page.addEventListener('change', onChange); page.addEventListener('click', onClick);
    if (canHover) { carousel.addEventListener('mouseenter', onMouseEnter); carousel.addEventListener('mouseleave', onMouseLeave); }
    carousel.addEventListener('mousemove', updateHoverSide); carousel.addEventListener('mouseleave', clearHoverSide);
    carousel.addEventListener('focusin', onCarouselFocus); carousel.addEventListener('focusout', onCarouselFocusOut);
    carousel.addEventListener('touchstart', onTouchStart, { passive: true });
    carousel.addEventListener('touchend', onTouchEnd, { passive: true });
    carousel.addEventListener('touchcancel', onTouchCancel, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    stop = () => { clear(); page.removeEventListener('change', onChange); page.removeEventListener('click', onClick);
      if (canHover) { carousel.removeEventListener('mouseenter', onMouseEnter); carousel.removeEventListener('mouseleave', onMouseLeave); }
      carousel.removeEventListener('mousemove', updateHoverSide); carousel.removeEventListener('mouseleave', clearHoverSide);
      carousel.removeEventListener('focusin', onCarouselFocus); carousel.removeEventListener('focusout', onCarouselFocusOut);
      carousel.removeEventListener('touchstart', onTouchStart); carousel.removeEventListener('touchend', onTouchEnd); carousel.removeEventListener('touchcancel', onTouchCancel);
      document.removeEventListener('visibilitychange', visibility); };
    update();
  }
  NS.matchCenter = { render: render, mount: mount, unmount: unmount };
})(typeof window !== 'undefined' ? window : globalThis);
