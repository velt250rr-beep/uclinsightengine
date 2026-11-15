/**
 * app.js — application controller: state, persistence wiring, routing, event handling.
 * Calculation logic lives in the engine modules; view markup lives in ui/views.js.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const doc = global.document;
  const { esc } = NS.charts;
  const S = NS.statistics, V = NS.validation, BT = NS.backtesting;

  const ROUTES = ['dashboard', 'fixtures', 'analysis', 'results', 'backtesting', 'performance', 'history', 'data', 'settings'];
  const DEFAULT_SETTINGS = { api: { provider: 'football-data', baseUrl: '', timeoutMs: 12000, seasons: '' }, config: {} };

  const app = {
    storage: null, dm: null, hist: null, settings: null, backtest: null, backtestStale: false, lastImport: null,
    amaiChats: Object.create(null), amaiBusy: null, amaiErrors: Object.create(null), amaiRequestId: 0,
    filters: { fixtures: { q: '', status: '', season: '', stage: '', teamId: '', order: '' } },
    resultDrafts: new Map(),
    router: null, running: false,
  };

  /* ---------------------------------------------------------------- helpers */
  const $ = (sel, root) => (root || doc).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || doc).querySelectorAll(sel));

  function toast(msg, kind) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast show ' + (kind || '');
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), kind === 'bad' ? 7000 : 3500);
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = doc.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; doc.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(file); });
  const deepMerge = (t, s) => { for (const k of Object.keys(s)) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = deepMerge(t[k] && typeof t[k] === 'object' ? t[k] : {}, s[k]); } else t[k] = s[k]; } return t; };

  /** Two-step confirmation without window.confirm (blocked in embedded viewers): repeat the action within 6 s. */
  let pendingAsk = null;
  function ask(msg) {
    const now = Date.now();
    if (pendingAsk && pendingAsk.msg === msg && now - pendingAsk.t < 6000) { pendingAsk = null; return true; }
    pendingAsk = { msg, t: now };
    toast(msg + ' — repeat the same action within 6 seconds to confirm.', 'warn');
    return false;
  }

  app.engineConfig = () => NS.probabilityEngine.mergeConfig(app.settings.config);

  function currentFingerprint() {
    const fin = app.dm.finishedMatches().sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
    return BT.datasetFingerprint(fin);
  }
  function refreshStale() {
    const bt = app.backtest;
    app.backtestStale = !!bt && (bt.datasetFingerprint !== currentFingerprint() || bt.configHash !== S.hashString(JSON.stringify(app.engineConfig())));
  }

  /** Run the full analysis for one match with current data, settings, stored backtest and manual context. */
  app.analyze = function (match) {
    const importLog = app.dm.state.importLog;
    const meta = { history: { sources: [...new Set(importLog.map((l) => l.source))].slice(0, 4), timestamp: importLog[0] ? importLog[0].timestamp : null } };
    refreshStale();
    return NS.analysisEngine.analyzeFixture({ match, matches: app.dm.listMatches(), config: app.settings.config, backtest: app.backtest, context: app.dm.getContext(match.id), meta });
  };

  /** Model decision for the next scheduled fixtures (memoised on data/config/backtest/context). */
  let upCache = null;
  app.upcoming = function (limit) {
    const n = limit || 18;
    const key = [app.dm.listMatches().length, app.dm.summary().finished, S.hashString(JSON.stringify(app.engineConfig())), app.backtest && app.backtest.runAt, S.hashString(JSON.stringify(app.dm.state.contexts)), n].join('|');
    if (upCache && upCache.key === key) return upCache.rows;
    const startOfToday = new Date().toISOString().slice(0, 10);
    const ms = app.dm.listMatches({ status: 'scheduled' }).filter((m) => m.date.slice(0, 10) >= startOfToday).slice(0, n);
    const rows = ms.map((m) => { try { return { match: m, a: app.analyze(m) }; } catch (e) { return { match: m, error: e.message }; } });
    upCache = { key, rows };
    return rows;
  };

  function afterDataChange(note) {
    const done = app.hist.evaluatePending(app.dm.listMatches());
    refreshStale();
    if (done.length) toast(`${done.length} saved prediction(s) evaluated against new results.`, 'ok');
    else if (note) toast(note, 'ok');
  }

  /* ------------------------------------------------------------------ render */
  function ensureScrollableTables(root) {
    if (!root) return;
    $$('table', root).forEach((table) => {
      let scroller = table.closest('.scroll-x');
      if (!scroller) {
        scroller = doc.createElement('div');
        scroller.className = 'scroll-x';
        table.parentNode.insertBefore(scroller, table);
        scroller.appendChild(table);
      }
      if (!scroller.hasAttribute('tabindex')) scroller.tabIndex = 0;
      if (!scroller.hasAttribute('role')) scroller.setAttribute('role', 'region');
      if (!scroller.hasAttribute('aria-label')) {
        const caption = table.querySelector('caption');
        const title = table.closest('.card')?.querySelector('.card-h h3')?.textContent.trim();
        scroller.setAttribute('aria-label', `Scrollable table${caption ? ': ' + caption.textContent.trim() : title ? ': ' + title : ''}`);
      }
    });
  }

  let tableObserver = null;
  let tableSwipe = null;
  function onTableTouchStart(e) {
    if (e.touches.length !== 1) { tableSwipe = null; return; }
    const scroller = e.target.closest('.scroll-x');
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) { tableSwipe = null; return; }
    const touch = e.touches[0];
    tableSwipe = { scroller, startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastTime: Date.now(), velocity: 0, horizontal: false };
  }
  function onTableTouchMove(e) {
    if (!tableSwipe || e.touches.length !== 1) return;
    const touch = e.touches[0], dxFromStart = touch.clientX - tableSwipe.startX, dyFromStart = touch.clientY - tableSwipe.startY;
    if (!tableSwipe.horizontal) {
      if (Math.max(Math.abs(dxFromStart), Math.abs(dyFromStart)) < 7) return;
      if (Math.abs(dxFromStart) <= Math.abs(dyFromStart)) { tableSwipe = null; return; }
      tableSwipe.horizontal = true;
    }
    if (e.cancelable) e.preventDefault();
    const now = Date.now(), delta = tableSwipe.lastX - touch.clientX, elapsed = Math.max(1, now - tableSwipe.lastTime);
    tableSwipe.scroller.scrollLeft += delta;
    tableSwipe.velocity = delta / elapsed;
    tableSwipe.lastX = touch.clientX;
    tableSwipe.lastTime = now;
  }
  function onTableTouchEnd() {
    const swipe = tableSwipe;
    tableSwipe = null;
    if (!swipe || !swipe.horizontal) return;
    let momentum = Math.max(-1.6, Math.min(1.6, swipe.velocity)) * 16;
    const coast = () => {
      momentum *= .93;
      if (Math.abs(momentum) < .35) return;
      swipe.scroller.scrollLeft += momentum;
      global.requestAnimationFrame(coast);
    };
    global.requestAnimationFrame(coast);
  }

  function setNavigationOpen(open, restoreFocus = false) {
    const sidebar = $('#sidebar'), menu = $('#menu-btn');
    if (!sidebar || !menu) return;
    const mobile = global.innerWidth <= 820;
    const visible = Boolean(open && mobile);
    sidebar.classList.toggle('open', visible);
    doc.body.classList.toggle('nav-open', visible);
    sidebar.setAttribute('aria-hidden', String(mobile && !visible));
    menu.setAttribute('aria-expanded', String(visible));
    menu.setAttribute('aria-label', visible ? 'Close navigation' : 'Open navigation');
    const glyph = menu.querySelector('[aria-hidden="true"]');
    if (glyph) glyph.textContent = visible ? '×' : '☰';
    if (visible) sidebar.querySelector('.nav a')?.focus();
    else if (restoreFocus) menu.focus();
  }

  function render() {
    const route = app.route || { name: 'dashboard', params: [] };
    const view = NS.views[route.name];
    const el = $('#view');
    if (NS.matchCenter) NS.matchCenter.unmount();
    try { el.innerHTML = view(app, route.params); }
    catch (e) { console.error(e); el.innerHTML = `<div class="banner bad"><b>This page failed to render:</b> ${esc(e.message)}</div>`; }
    if (route.name === 'results' && app.resultDrafts.size) {
      $$('[data-result-entry]', el).forEach((row) => {
        const draft = app.resultDrafts.get(row.dataset.id);
        if (!draft) return;
        row.querySelector('[name="hg"]').value = draft.hg;
        row.querySelector('[name="ag"]').value = draft.ag;
      });
    }
    if (route.name === 'analysis' && !(route.params || [])[0] && NS.matchCenter) NS.matchCenter.mount(el);
    ensureScrollableTables(el);
    $$('.nav a').forEach((a) => {
      const active = a.dataset.route === route.name;
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    setNavigationOpen(false);
    const st = $('#storage-state'); if (st) st.textContent = app.storage.persistent ? 'Saved in this browser' : 'Storage blocked — memory only';
  }
  app.render = render;
  const keepScroll = (fn) => { const y = global.scrollY; fn(); global.scrollTo(0, y); };

  const AMAI_PROMPTS = {
    summary: 'Ringkas analisis pra-pertandingan ini dalam bahasa sederhana. Jelaskan peluang model dan tingkat ketidakpastiannya.',
    factors: 'Apa faktor terbesar di balik prediksi model untuk pertandingan ini? Bandingkan kedua tim hanya dari data yang tersedia.',
    missing: 'Data penting apa yang belum tersedia untuk pertandingan ini, dan apa dampaknya pada analisis?',
  };
  function renderAmai() {
    keepScroll(render);
    const thread = $('#amai-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }
  async function askAmai(matchId, question) {
    const text = String(question || '').trim();
    if (!text) return;
    if (text.length > 800) return toast('AMAI questions must be 800 characters or fewer.', 'warn');
    if (app.amaiBusy) return toast('AMAI is still responding to another question.', 'warn');
    const match = app.dm.getMatch(matchId);
    if (!match) return toast('This match is no longer available.', 'bad');
    if (!app.settings.api.baseUrl) {
      app.amaiErrors[matchId] = 'Set your secure Worker URL in Settings → Data provider, then add the AMAI_OPENAI_KEY secret to that Worker.';
      return renderAmai();
    }
    const messages = (app.amaiChats[matchId] = app.amaiChats[matchId] || []);
    messages.push({ role: 'user', content: text });
    if (messages.length > 24) messages.splice(0, messages.length - 24);
    const requestId = ++app.amaiRequestId;
    app.amaiBusy = matchId; delete app.amaiErrors[matchId];
    renderAmai();
    try {
      const analysis = app.analyze(match);
      const context = NS.amai.contextFromAnalysis(analysis, app.dm.getContext(matchId));
      const history = messages.slice(0, -1).slice(-8);
      const result = await NS.amai.respond(app.settings.api.baseUrl, { question: text, context, messages: history });
      if (!result.ok) app.amaiErrors[matchId] = result.error;
      else messages.push({ role: 'assistant', content: result.answer });
    } catch (error) {
      app.amaiErrors[matchId] = 'AMAI could not prepare this match context. Re-open the analysis and try again.';
      console.error('AMAI request failed:', error);
    } finally {
      if (app.amaiRequestId === requestId) app.amaiBusy = null;
      renderAmai();
    }
  }

  /* ------------------------------------------------------------ data actions */
  function reportImport(title, res, extra) {
    const r = res.rep || {};
    app.lastImport = {
      title, errors: res.errors || [], warnings: res.warnings || [],
      text: `${res.total ?? 0} row(s) read · ${(res.valid || []).length} valid · ${(res.errors || []).length} rejected` + (r.added !== undefined ? ` · ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged${r.merged ? ', ' + r.merged + ' matched to existing fixtures' : ''}${r.conflicts ? ', ' + r.conflicts + ' conflict(s) with manual edits (see below)' : ''}` : '') + (extra || ''),
    };
  }
  function importText(text, kind, source, label) {
    const p = V.parseImport(text, kind);
    if (!p.ok) { app.lastImport = { title: 'Import failed.', text: p.error, errors: [], warnings: [] }; toast(p.error, 'bad'); return render(); }
    (p.teams || []).forEach((t) => t && t.name && app.dm.upsertTeam({ name: t.name, short: t.short || null, country: t.country || null }));
    const v = V.validateMatchRows(p.rows);
    const rep = v.valid.length ? app.dm.importMatches(v.valid, { source, quality: 'user-import', label }) : null;
    reportImport(v.valid.length ? 'Import finished.' : 'Nothing imported.', { ...v, rep }, p.unknownColumns.length ? ` · ignored unknown column(s): ${p.unknownColumns.join(', ')}` : '');
    if (rep && rep.saveError) toast(rep.saveError, 'bad');
    afterDataChange();
    render();
  }

  async function runBacktest() {
    if (app.running) return;
    app.running = true;
    const box = $('#bt-progress'), bar = $('#bt-progress-bar'), txt = $('#bt-progress-text'), percent = $('#bt-progress-percent'), track = $('#bt-progress-track');
    if (box) { box.classList.remove('hidden', 'is-complete', 'is-error'); box.setAttribute('aria-busy', 'true'); }
    if (bar) bar.style.width = '0%';
    if (txt) txt.textContent = 'Preparing historical match data…';
    if (percent) percent.textContent = '0%';
    if (track) track.setAttribute('aria-valuenow', '0');
    $$('[data-act=run-backtest]').forEach((b) => (b.disabled = true));
    try {
      const res = await BT.walkForward(app.dm.listMatches(), {
        config: app.settings.config, yieldFn: () => new Promise((r) => setTimeout(r, 0)),
        onProgress: (p) => {
          const value = Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
          if (bar) bar.style.width = value + '%';
          if (percent) percent.textContent = value + '%';
          if (track) track.setAttribute('aria-valuenow', String(value));
          if (txt) txt.textContent = `${p.done}/${p.total} match days · ${p.day}`;
        },
      });
      app.backtest = BT.compactForStorage(res);
      const sv = app.storage.set('backtest', app.backtest);
      if (!sv.ok) toast('Backtest finished but could not be stored: ' + sv.error, 'bad');
      else toast(res.status === 'COMPLETE' ? 'Backtest complete.' : res.status, res.status === 'COMPLETE' ? 'ok' : 'bad');
      if (box && res.status === 'COMPLETE') {
        box.classList.add('is-complete');
        if (bar) bar.style.width = '100%';
        if (percent) percent.textContent = '100%';
        if (track) track.setAttribute('aria-valuenow', '100');
        if (txt) txt.textContent = 'Backtest complete — results are ready.';
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    } catch (e) {
      if (box) box.classList.add('is-error');
      if (txt) txt.textContent = 'Backtest stopped before completion.';
      console.error(e); toast('Backtest aborted: ' + e.message, 'bad');
    }
    if (box) box.setAttribute('aria-busy', 'false');
    app.running = false; refreshStale(); render();
  }

  function currentSeasonStartYear() {
    const now = new Date();
    const year = now.getUTCFullYear();
    return now.getUTCMonth() >= 6 ? year : year - 1;
  }

  async function apiFetch(options = {}) {
    if (app.apiFetchRunning) return;
    const cfg = app.settings.api;
    const seasonInput = $('#api-seasons');
    const rawSeasons = options.seasons || (seasonInput && seasonInput.value) || cfg.seasons || String(currentSeasonStartYear());
    const seasons = String(rawSeasons).split(/[,\s]+/).filter(Boolean).map(Number);
    if (!seasons.length || seasons.some((s) => !Number.isInteger(s) || s < 1992 || s > 2100)) {
      if (!options.quiet) toast('Enter valid season start years, e.g. 2024, 2023', 'bad');
      return;
    }
    cfg.seasons = seasons.join(', '); saveSettings();
    const client = new NS.api.ApiClient({ provider: cfg.provider, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
    const out = $('#api-out'); if (out) out.innerHTML = '<p class="dim">Fetching…</p>';
    app.apiFetchRunning = true;
    try {
      const lines = []; let anyOk = false;
      for (const s of seasons) {
        const r = await client.fetchMatches(s);
        if (!r.ok) { lines.push(`<li class="bad-t">Season ${s}: ${esc(r.error.message)} (${esc(r.error.type)})</li>`); continue; }
        const v = V.validateMatchRows(r.data.rows, {});
        const rep = v.valid.length ? app.dm.importMatches(v.valid, { source: 'api:' + cfg.provider, quality: 'api', label: 'API season ' + s }) : { added: 0, updated: 0, conflicts: 0 };
        if (cfg.provider === 'football-data' && v.valid.length && (r.data.contexts || []).length) {
          const acceptedIds = new Set(v.valid.map((row) => row.id));
          const loaded = app.dm.listMatches();
          const byId = new Map(loaded.map((m) => [m.id, m.id]));
          const byFixture = new Map(loaded.map((m) => [`${m.date.slice(0, 10)}|${m.homeId}|${m.awayId}`, m.id]));
          const key = NS.dataManager.teamKey;
          const knownTeamId = (name) => {
            const wanted = key(name);
            const team = app.dm.teams().find((t) => key(t.name) === wanted || (t.aliases || []).some((alias) => key(alias) === wanted));
            return team && team.id;
          };
          for (const ctx of r.data.contexts) {
            if (!acceptedIds.has(ctx.id)) continue;
            let matchId = byId.get(ctx.id);
            if (!matchId) {
              const homeId = knownTeamId(ctx.homeName), awayId = knownTeamId(ctx.awayName);
              if (homeId && awayId) matchId = byFixture.get(`${ctx.date.slice(0, 10)}|${homeId}|${awayId}`);
            }
            if (matchId) app.dm.setContextFromProvider(matchId, ctx.fields, 'api:football-data');
          }
        }
        anyOk = true;
        lines.push(`<li>Season ${s}: ${r.data.rows.length} received, ${rep.added} added, ${rep.updated} updated, ${v.errors.length} rejected, ${r.data.dropped.length} dropped${rep.conflicts ? `, <b>${rep.conflicts} conflict(s)</b>` : ''}</li>`);
      }
      const report = `<ul>${lines.join('')}</ul>`;
      if (out) out.innerHTML = report;
      app.storage.set('api.matchesLastAttemptAt', Date.now());
      if (anyOk) {
        app.storage.set('api.matchesLastRefreshAt', Date.now());
        afterDataChange();
        if (!options.quiet) toast('API fetch finished.', 'ok');
        render();
        const refreshedOut = $('#api-out'); if (refreshedOut) refreshedOut.innerHTML = report;
      } else if (!options.quiet) {
        toast('API fetch failed — see details.', 'bad');
      }
    } finally {
      app.apiFetchRunning = false;
    }
  }

  function autoRefreshMatches() {
    const cfg = app.settings && app.settings.api;
    if (!cfg || !cfg.baseUrl || app.apiFetchRunning) return;
    if (app.running) { setTimeout(autoRefreshMatches, 1500); return; }
    const lastAttempt = Number(app.storage.get('api.matchesLastAttemptAt', 0));
    if (Date.now() - lastAttempt < 6 * 60 * 60 * 1000) return;
    apiFetch({ quiet: true }).catch((e) => console.error('Automatic match refresh failed:', e));
  }

  async function apiStandings() {
    const cfg = app.settings.api, out = $('#api-out');
    const client = new NS.api.ApiClient({ provider: cfg.provider, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
    const y = Number((($('#api-seasons').value || '').split(/[,\s]+/).filter(Boolean)[0]));
    if (!y) return toast('Enter a season start year first.', 'bad');
    out.innerHTML = '<p class="dim">Fetching…</p>';
    const r = await client.fetchStandings(y);
    if (!r.ok) { out.innerHTML = `<p class="bad-t">${esc(r.error.message)}</p>`; return; }
    out.innerHTML = r.data.tables.map((t) => `<h4>${esc(t.group || 'Table')}</h4><div class="scroll-x"><table class="tbl compact"><thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Pts</th></tr></thead><tbody>${t.table.map((x) => `<tr><td>${x.position}</td><td>${esc(x.team)}</td><td>${x.played}</td><td>${x.won}</td><td>${x.draw}</td><td>${x.lost}</td><td>${x.gf}</td><td>${x.ga}</td><td>${x.points}</td></tr>`).join('')}</tbody></table></div>`).join('') + '<p class="dim">Standings are displayed for reference only — final standings are never used as pre-match model input.</p>';
  }

  function saveSettings() { const r = app.storage.set('settings', app.settings); if (!r.ok) toast(r.error, 'bad'); }

  /* -------------------------------------------------------------- parse forms */
  function parseLines(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, a, d] = l.split(',').map((x) => x.trim());
      return { name, attackShare: a === undefined || a === '' ? null : Number(a), defenceShare: d === undefined || d === '' ? null : Number(d) };
    });
  }
  function submitContext(formEl) {
    const fd = new FormData(formEl), id = formEl.dataset.match, fields = {}, ctx = {};
    for (const s of ['home', 'away']) {
      ctx[s + 'Injuries'] = parseLines(fd.get(s + 'Injuries')); ctx[s + 'Suspensions'] = parseLines(fd.get(s + 'Suspensions'));
      ctx[s + 'RestDays'] = fd.get(s + 'RestDays'); ctx[s + 'Matches14d'] = fd.get(s + 'Matches14d');
    }
    const errs = V.validateContext(ctx);
    for (const s of ['home', 'away']) for (const k of ['Injuries', 'Suspensions']) for (const p of ctx[s + k]) if (p.attackShare !== null && isNaN(p.attackShare)) errs.push(`${s} ${p.name}: attack share is not a number`);
    if (errs.length) return toast(errs[0], 'bad');
    for (const s of ['home', 'away']) {
      const hasInj = String(fd.get(s + 'Injuries')).trim() || String(fd.get(s + 'Suspensions')).trim();
      fields[s + 'Injuries'] = String(fd.get(s + 'Injuries')).trim() ? ctx[s + 'Injuries'] : (hasInj ? [] : null);
      fields[s + 'Suspensions'] = String(fd.get(s + 'Suspensions')).trim() ? ctx[s + 'Suspensions'] : (hasInj ? [] : null);
      fields[s + 'Formation'] = String(fd.get(s + 'Formation')).trim() || null;
      const status = fd.get(s + 'LineupStatus'), xi = String(fd.get(s + 'Xi')).split(',').map((x) => x.trim()).filter(Boolean);
      fields[s + 'Lineup'] = status === 'unknown' && !xi.length ? null : { status, players: xi };
      fields[s + 'RestDays'] = ctx[s + 'RestDays'] === '' ? null : Number(ctx[s + 'RestDays']);
      fields[s + 'Matches14d'] = ctx[s + 'Matches14d'] === '' ? null : Number(ctx[s + 'Matches14d']);
    }
    const r = app.dm.setContext(id, fields, 'manual');
    if (!r.ok) toast(r.error, 'bad'); else toast('Context saved.', 'ok');
    keepScroll(render);
  }
  function submitEngine(formEl) {
    const cur = JSON.parse(JSON.stringify(app.engineConfig())), patch = {};
    for (const el of $$('input', formEl)) {
      const path = el.name.split('.'); let o = patch;
      path.forEach((k, i) => { if (i === path.length - 1) o[k] = el.type === 'checkbox' ? el.checked : Number(el.value); else o = o[k] = o[k] || {}; });
    }
    const merged = deepMerge(cur, patch);
    const errs = V.validateConfigPatch(merged);
    if (errs.length) return toast(errs[0], 'bad');
    app.settings.config = merged; saveSettings(); refreshStale(); toast('Engine settings saved. Re-run the backtest to validate them.', 'ok'); render();
  }

  /* ---------------------------------------------------------------- events */
  let resultAutoSaveTimer = null;
  function captureResultDrafts() {
    $$('[data-result-entry]').forEach((row) => {
      const hg = row.querySelector('[name="hg"]').value.trim();
      const ag = row.querySelector('[name="ag"]').value.trim();
      if (hg || ag) app.resultDrafts.set(row.dataset.id, { hg, ag });
      else app.resultDrafts.delete(row.dataset.id);
    });
  }
  function commitResultBatch(results, automatic, deferredCount) {
    const saved = app.dm.setManualResults(results);
    if (!saved.ok) return toast((automatic ? 'Auto-save failed: ' : '') + saved.error, automatic ? 'warn' : 'bad');
    results.forEach((result) => app.resultDrafts.delete(result.matchId));
    const evaluated = app.hist.evaluatePending(app.dm.listMatches());
    refreshStale();
    if (app.route && app.route.name === 'results') keepScroll(render);
    toast((automatic ? 'Auto-saved results for ' : 'Saved results for ') + saved.count + ' matches' + (evaluated.length ? '; evaluated ' + evaluated.length + ' predictions' : '') + (deferredCount ? '; ' + deferredCount + ' other scores will save after kickoff' : '') + '.', 'ok');
    return true;
  }
  function autoSaveCompleteResults() {
    resultAutoSaveTimer = null;
    captureResultDrafts();
    const now = Date.parse(app.dm.now()), eligible = [], tooEarly = [];
    let invalid = false;
    for (const [matchId, draft] of app.resultDrafts) {
      if (!draft.hg || !draft.ag) continue;
      const homeGoals = Number(draft.hg), awayGoals = Number(draft.ag);
      if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0 || homeGoals > 20 || awayGoals > 20) { invalid = true; continue; }
      const match = app.dm.getMatch(matchId);
      if (!match) continue;
      if (Date.parse(match.date) > now + 36 * 3600e3) { tooEarly.push(matchId); continue; }
      eligible.push({ matchId, homeGoals, awayGoals });
    }
    if (!eligible.length) {
      if (invalid) toast('Scores must be whole numbers from 0 to 20.', 'warn');
      else if (tooEarly.length) toast('These scores will be saved after kickoff.', 'warn');
      return;
    }
    commitResultBatch(eligible, true, tooEarly.length);
  }
  function scheduleResultAutoSave(delay) {
    clearTimeout(resultAutoSaveTimer);
    resultAutoSaveTimer = setTimeout(autoSaveCompleteResults, delay == null ? 650 : delay);
  }
  async function onClick(e) {
    const removeAll = e.target.closest('[data-remove-all-predictions]');
    if (removeAll) {
      const dialog = $('[data-result-delete-dialog]');
      if (!dialog) return;
      const pending = app.hist.pending(), confirm = dialog.querySelector('[data-confirm-discard]');
      confirm.dataset.removeAll = 'true';
      confirm.textContent = 'Remove all';
      dialog.querySelector('[data-delete-title]').textContent = 'Remove all pending predictions?';
      dialog.querySelector('[data-delete-description]').textContent = 'This removes ' + pending.length + ' pending predictions from Awaiting results. Their original records remain in Prediction History.';
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      return;
    }
    const removeTrigger = e.target.closest('[data-remove-prediction]');
    if (removeTrigger) {
      const dialog = $('[data-result-delete-dialog]');
      if (!dialog) return;
      const confirm = dialog.querySelector('[data-confirm-discard]');
      confirm.dataset.id = removeTrigger.dataset.id;
      confirm.dataset.removeAll = 'false';
      confirm.textContent = 'Remove prediction';
      dialog.querySelector('[data-delete-title]').textContent = 'Remove prediction for ' + removeTrigger.dataset.match + '?';
      dialog.querySelector('[data-delete-description]').textContent = 'This prediction will leave Awaiting results. Its original record will remain in Prediction History.';
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      return;
    }
    const cancelDiscard = e.target.closest('[data-cancel-discard]');
    if (cancelDiscard) {
      const dialog = cancelDiscard.closest('[data-result-delete-dialog]');
      if (dialog && typeof dialog.close === 'function') dialog.close(); else if (dialog) dialog.removeAttribute('open');
      return;
    }
    const confirmDiscard = e.target.closest('[data-confirm-discard]');
    if (confirmDiscard) {
      const dialog = confirmDiscard.closest('[data-result-delete-dialog]');
      if (confirmDiscard.dataset.removeAll === 'true') {
        const pending = app.hist.pending();
        let removed = 0;
        for (const prediction of pending) {
          const result = app.hist.discardPending(prediction.fixtureId);
          if (result.ok) { removed++; app.resultDrafts.delete(prediction.fixtureId); }
        }
        if (!removed) return toast('No pending predictions were removed.', 'warn');
        if (dialog && typeof dialog.close === 'function') dialog.close(); else if (dialog) dialog.removeAttribute('open');
        toast('Removed ' + removed + ' pending prediction' + (removed === 1 ? '' : 's') + ' from Awaiting results. Records remain in Prediction History.', 'ok');
        return keepScroll(render);
      }
      const result = app.hist.discardPending(confirmDiscard.dataset.id);
      if (!result.ok) return toast(result.error, 'bad');
      app.resultDrafts.delete(confirmDiscard.dataset.id);
      if (dialog && typeof dialog.close === 'function') dialog.close(); else if (dialog) dialog.removeAttribute('open');
      toast('Prediction removed from Awaiting results. Its original record remains in Prediction History.', 'ok');
      return keepScroll(render);
    }
    const clickedBackdrop = e.target.closest('[data-result-delete-dialog]');
    if (clickedBackdrop && e.target === clickedBackdrop) {
      if (typeof clickedBackdrop.close === 'function') clickedBackdrop.close(); else clickedBackdrop.removeAttribute('open');
      return;
    }
    const amaiPrompt = e.target.closest('[data-amaiprompt]');
    if (amaiPrompt) {
      const question = AMAI_PROMPTS[amaiPrompt.dataset.amaiprompt];
      if (question) return askAmai(amaiPrompt.dataset.match, question);
    }
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a,button,input,form')) { global.location.hash = row.dataset.href; return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    switch (act) {
      case 'save-prediction': {
        const m = app.dm.getMatch(id), a = app.analyze(m), r = app.hist.create(m, a);
        if (!r.ok) toast(r.error, 'bad'); else toast(r.warning || 'Prediction saved (immutable).', r.warning ? 'warn' : 'ok');
        return keepScroll(render);
      }
      case 'eval-pending': { const done = app.hist.evaluatePending(app.dm.listMatches()); toast(done.length ? `${done.length} prediction(s) evaluated.` : 'Nothing new to evaluate — enter results below or import them.', done.length ? 'ok' : ''); return render(); }
      case 'run-backtest': return runBacktest();
      case 'save-all': {
        let ok = 0, skip = 0;
        for (const r of app.upcoming(18)) { if (!r.a || app.hist.official(r.match.id)) { skip++; continue; } const x = app.hist.create(r.match, r.a); if (x.ok && !x.warning) ok++; else skip++; }
        toast(`${ok} prediction(s) saved before kickoff${skip ? `, ${skip} skipped (already saved or not eligible)` : ''}.`, ok ? 'ok' : '');
        return keepScroll(render);
      }
      case 'api-fetch': return apiFetch();
      case 'api-standings': return apiStandings();
      case 'download-template': return download('ucl-matches-template.csv', NS.dataManager.csvTemplate(), 'text/csv');
      case 'import-paste': { const t = $('#paste-import').value; if (!t.trim()) return toast('Paste CSV or JSON first.', 'bad'); return importText(t, null, 'import:paste', 'pasted text'); }
      case 'export-matches-csv': return download('ucl-matches.csv', app.dm.exportMatchesCSV(), 'text/csv');
      case 'export-backup': return download('ucl-backup.json', JSON.stringify({ data: app.dm.exportAll(), predictions: app.hist.exportJSON(), settings: app.settings, backtest: app.backtest }, null, 1), 'application/json');
      case 'export-history-csv': return download('ucl-predictions.csv', app.hist.exportCSV(), 'text/csv');
      case 'export-history-json': return download('ucl-predictions.json', JSON.stringify(app.hist.exportJSON(), null, 1), 'application/json');
      case 'resolve': app.dm.resolveConflict(Number(b.dataset.i), b.dataset.choice); afterDataChange(); return render();
      case 'clear-overrides': { const e2 = app.dm.state.matches[id]; if (e2) { e2.overrides = {}; app.dm.save(); } afterDataChange('Manual corrections reverted.'); return keepScroll(render); }
      case 'delete-match': if (ask('Delete this match from the local data? (Saved predictions are kept.)')) { app.dm.deleteMatch(id); afterDataChange('Match deleted.'); keepScroll(render); } return;
      case 'clear-all': if (ask('Delete ALL matches, teams and contexts? Saved predictions and settings are kept. Export a backup first if unsure.')) { app.dm.clearAll(); app.lastImport = null; afterDataChange('All match data deleted.'); render(); } return;
      case 'reset-engine': app.settings.config = {}; saveSettings(); refreshStale(); toast('Engine reset to defaults.', 'ok'); return render();
      default:
    }
  }

  let fixtureSortRun = 0;
  async function sortAnalysisFixtureCards(order) {
    const grid = $('#analysis-fixture-grid'), select = $('#analysis-fixture-sort');
    if (!grid) return;
    const run = ++fixtureSortRun, cards = Array.from(grid.querySelectorAll('.fixture-card'));
    const count = $('#fixture-search-count');
    if (order === 'confidence') {
      if (select) select.disabled = true;
      if (count) count.textContent = 'Calculating model confidence…';
      for (let i = 0; i < cards.length; i++) {
        if (run !== fixtureSortRun || !grid.isConnected) return;
        const card = cards[i];
        let confidence = card.dataset.confidence;
        if (!confidence) {
          try {
            const match = app.dm.getMatch(card.dataset.fixtureId);
            confidence = match ? app.analyze(match).final.confidence.label : 'N/A';
          } catch (_) { confidence = 'N/A'; }
          card.dataset.confidence = confidence;
          const badge = card.querySelector('[data-confidence-badge]');
          if (badge) {
            badge.textContent = confidence.toUpperCase();
            badge.classList.remove('hidden', 'ok', 'warn', 'bad', 'info');
            badge.classList.add(({ High: 'ok', Medium: 'warn', Low: 'bad' })[confidence] || 'info');
          }
        }
        if (i % 2 === 1) await new Promise((resolve) => global.requestAnimationFrame(resolve));
      }
      if (run !== fixtureSortRun || !grid.isConnected) return;
      const rank = { High: 0, Medium: 1, Low: 2, 'N/A': 3 };
      cards.sort((a, b) => (rank[a.dataset.confidence] ?? 3) - (rank[b.dataset.confidence] ?? 3) || Date.parse(a.dataset.fixtureDate) - Date.parse(b.dataset.fixtureDate));
    } else {
      cards.sort((a, b) => Date.parse(a.dataset.fixtureDate) - Date.parse(b.dataset.fixtureDate));
    }
    cards.forEach((card, index) => {
      const ordinal = card.querySelector('.fixture-card-number');
      if (ordinal && ordinal.firstChild) ordinal.firstChild.textContent = `${String(index + 2).padStart(2, '0')} `;
      grid.appendChild(card);
    });
    if (select) select.disabled = false;
    const query = ($('#analysis-fixture-search')?.value || '').trim();
    const visible = $$('.fixture-searchable').filter((fixture) => !fixture.classList.contains('hidden')).length;
    if (count) count.textContent = query ? `${visible} fixture${visible === 1 ? '' : 's'} found` : `${visible} upcoming fixture${visible === 1 ? '' : 's'}`;
  }
  function onChange(e) {
    const t = e.target;
    if (t.closest && t.closest('[data-result-entry]') && (t.name === 'hg' || t.name === 'ag')) { scheduleResultAutoSave(120); return; }
    if (t.id === 'analysis-fixture-sort') { void sortAnalysisFixtureCards(t.value); return; }
    if (t.dataset.filter === 'fixtures') {
      const map = { 'f-q': 'q', 'f-status': 'status', 'f-season': 'season', 'f-stage': 'stage', 'f-team': 'teamId', 'f-order': 'order' };
      app.filters.fixtures[map[t.id]] = t.value; const pos = t.selectionStart; render();
      if (t.id === 'f-q') { const q = $('#f-q'); q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) { /* ignore */ } }
      return;
    }
    if (t.dataset.import) handleFile(t);
  }
  async function handleFile(input) {
    const file = input.files && input.files[0]; if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast('File larger than 25 MB — split it first.', 'bad');
    let text; try { text = await readFile(file); } catch (e) { return toast('Could not read file.', 'bad'); }
    const kind = input.dataset.import;
    input.value = '';
    if (kind === 'matches') return importText(text, /\.json$/i.test(file.name) ? 'json' : /\.csv$/i.test(file.name) ? 'csv' : null, 'import:' + (/\.json$/i.test(file.name) ? 'json' : 'csv'), file.name);
    let j; try { j = JSON.parse(text); } catch (e) { return toast('Not valid JSON.', 'bad'); }
    if (kind === 'history') { const r = app.hist.importJSON(j); toast(r.ok ? 'Prediction history imported (replaced).' : r.error, r.ok ? 'ok' : 'bad'); return render(); }
    if (kind === 'backup') {
      if (!j.data) return toast('Not a full backup file.', 'bad');
      if (!ask('Restore backup? This REPLACES current matches, predictions and settings.')) return;
      const r1 = app.dm.restore(j.data); if (!r1.ok) return toast(r1.error, 'bad');
      if (j.predictions) app.hist.importJSON(j.predictions);
      if (j.settings) { app.settings = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), j.settings); saveSettings(); }
      app.backtest = j.backtest || null; if (app.backtest) app.storage.set('backtest', app.backtest);
      afterDataChange('Backup restored.'); render();
    }
  }

  function onInput(e) {
    const resultEntry = e.target.closest && e.target.closest('[data-result-entry]');
    if (resultEntry && (e.target.name === 'hg' || e.target.name === 'ag')) {
      const hg = resultEntry.querySelector('[name="hg"]').value.trim();
      const ag = resultEntry.querySelector('[name="ag"]').value.trim();
      if (hg || ag) app.resultDrafts.set(resultEntry.dataset.id, { hg, ag });
      else app.resultDrafts.delete(resultEntry.dataset.id);
      scheduleResultAutoSave();
      return;
    }
    if (e.target.id === 'analysis-fixture-search') {
      const query = e.target.value.trim().toLocaleLowerCase();
      const fixtures = $$('.fixture-searchable');
      let visible = 0;
      fixtures.forEach((fixture) => {
        const matches = (fixture.dataset.fixtureSearch || '').toLocaleLowerCase().includes(query);
        fixture.classList.toggle('hidden', !matches);
        if (matches) visible++;
      });
      const count = $('#fixture-search-count');
      if (count) count.textContent = query ? `${visible} fixture${visible === 1 ? '' : 's'} found` : `${visible} upcoming fixture${visible === 1 ? '' : 's'}`;
      const emptyState = $('#fixture-search-empty');
      if (emptyState) emptyState.classList.toggle('hidden', visible > 0);
      return;
    }
    if (e.target.id === 'f-q') { clearTimeout(onInput.t); onInput.t = setTimeout(() => onChange(e), 250); }
  }

  function onSubmit(e) {
    const f = e.target; e.preventDefault();
    if (f.id === 'amai-form') {
      const formData = new FormData(f);
      return askAmai(f.dataset.match, formData.get('question'));
    }
    if (f.id === 'ctx-form') return submitContext(f);
    if (f.id === 'engine-form') return submitEngine(f);
    if (f.id === 'api-form') {
      const fd = new FormData(f), url = String(fd.get('baseUrl')).trim(), to = Number(fd.get('timeoutMs'));
      if (url && !/^https?:\/\//i.test(url)) return toast('Proxy URL must start with http:// or https://', 'bad');
      if (NS.api.ApiClient.looksLikeSecret(url)) return toast('That URL looks like it contains a secret key. Keep secrets in the proxy, not here.', 'bad');
      if (!(to >= 2000 && to <= 60000)) return toast('Timeout must be 2000–60000 ms', 'bad');
      app.settings.api = { ...app.settings.api, provider: fd.get('provider'), baseUrl: url, timeoutMs: to };
      saveSettings(); toast('Provider settings saved.', 'ok'); render();
      if (url) { app.storage.remove('api.matchesLastAttemptAt'); setTimeout(autoRefreshMatches, 0); }
      return;
    }
    if (f.id === 'manual-match') {
      const fd = new FormData(f), row = {};
      for (const [k, v] of fd.entries()) row[k] = v;
      const v = V.validateMatchRows([row]);
      if (!v.valid.length) { app.lastImport = { title: 'Match not added.', text: '', errors: v.errors, warnings: v.warnings }; toast(v.errors[0].msg, 'bad'); return render(); }
      const rep = app.dm.addManualMatch(v.valid[0]);
      reportImport('Match added.', { ...v, rep }); afterDataChange('Match added.'); f.reset(); return render();
    }
    if (f.id === 'merge-teams') { const fd = new FormData(f), r = app.dm.mergeTeams(fd.get('from'), fd.get('to')); toast(r.ok ? `Teams merged (${r.moved} match side(s) updated).` : r.error, r.ok ? 'ok' : 'bad'); afterDataChange(); return render(); }
    if (f.dataset.form === 'result' || f.dataset.form === 'edit-result') {
      const fd = new FormData(f), id = f.dataset.id, hg = Number(fd.get('hg')), ag = Number(fd.get('ag'));
      if (fd.get('hg') === '' || fd.get('ag') === '') return toast('Enter both scores.', 'bad');
      const r = app.dm.setManualResult(id, hg, ag);
      if (!r.ok) return toast(r.error, 'bad');
      afterDataChange('Result recorded.'); return keepScroll(render);
    }
  }

  /* ---------------------------------------------------------------- page loading */
  let routeChangeId = 0;
  function minimumLoaderTime() {
    const nav = global.navigator || {};
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection || null;
    if (nav.onLine === false) return 5000;
    if (!connection) return 1200;
    const type = String(connection.effectiveType || '').toLowerCase();
    const rtt = Number(connection.rtt || 0), downlink = Number(connection.downlink || 0);
    if (connection.saveData || type === 'slow-2g' || type === '2g' || rtt >= 800 || (downlink > 0 && downlink < .35)) return 5000;
    if (type === '3g' || rtt >= 250 || (downlink > 0 && downlink < 1.5)) return 3000;
    return 1200;
  }
  function navigateWithLoader(route) {
    app.route = route;
    const token = ++routeChangeId, started = Date.now(), loader = $('#ucl-route-loader');
    if (!loader) { render(); return; }
    const frame = typeof global.requestAnimationFrame === 'function' ? (fn) => global.requestAnimationFrame(fn) : (fn) => global.setTimeout(fn, 16);
    loader.hidden = false;
    loader.setAttribute('aria-hidden', 'false');
    loader.classList.remove('is-visible');
    frame(() => {
      if (token !== routeChangeId) return;
      loader.classList.add('is-visible');
      frame(() => {
        if (token !== routeChangeId) return;
        render();
        const wait = Math.max(0, minimumLoaderTime() - (Date.now() - started));
        global.setTimeout(() => {
          if (token !== routeChangeId) return;
          loader.classList.remove('is-visible');
          loader.setAttribute('aria-hidden', 'true');
          global.setTimeout(() => { if (token === routeChangeId) loader.hidden = true; }, 240);
        }, wait);
      });
    });
  }

  /* ---------------------------------------------------------------- startup */
  function init() {
    app.storage = NS.storage.createStorage();
    app.settings = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), app.storage.get('settings', {}));
    app.dm = new NS.dataManager.DataManager(app.storage).load();
    app.hist = new NS.predictionHistory.PredictionHistory(app.storage).load();
    app.backtest = app.storage.get('backtest', null);
    afterDataChange();
    const view = $('#view');
    if (view && typeof global.MutationObserver === 'function') {
      tableObserver = new global.MutationObserver(() => ensureScrollableTables(view));
      tableObserver.observe(view, { childList: true, subtree: true });
    }
    doc.addEventListener('click', onClick); doc.addEventListener('change', onChange); doc.addEventListener('input', onInput); doc.addEventListener('submit', onSubmit);
    doc.addEventListener('touchstart', onTableTouchStart, { passive: true });
    doc.addEventListener('touchmove', onTableTouchMove, { passive: false });
    doc.addEventListener('touchend', onTableTouchEnd, { passive: true });
    doc.addEventListener('touchcancel', onTableTouchEnd, { passive: true });
    $('#menu-btn').addEventListener('click', () => setNavigationOpen(!$('#sidebar').classList.contains('open')));
    $('#nav-scrim').addEventListener('click', () => setNavigationOpen(false, true));
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) setNavigationOpen(false, true);
    });
    global.addEventListener('resize', () => { if (global.innerWidth > 820) setNavigationOpen(false); });
    app.router = new NS.router.Router(ROUTES, navigateWithLoader);
    app.router.start();
    setTimeout(autoRefreshMatches, 1500);
    setInterval(autoRefreshMatches, 6 * 60 * 60 * 1000);
    // First visit with data but no stored backtest: measure the model right away (deterministic, a few seconds).
    refreshStale();
    if ((!app.backtest || app.backtestStale) && app.dm.finishedMatches().length >= 100) setTimeout(runBacktest, 300);
  }
  NS.app = app;
  if (doc) { if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init(); }
})(typeof window !== 'undefined' ? window : globalThis);
