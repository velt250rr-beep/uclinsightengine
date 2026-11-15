/**
 * views.js — page renderers. Each view(app, params) returns an HTML string. No calculation logic lives here:
 * everything numeric comes from the engine modules. All dynamic text is escaped with esc().
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const C = NS.charts, S = NS.statistics, V = NS.validation;
  const { esc, pct } = C;

  const fmtDate = (m) => (m.date.length > 10 ? m.date.slice(0, 10) + ' ' + m.date.slice(11, 16) + ' UTC' : m.date);
  const num = (v, d = 2) => (v === null || v === undefined || isNaN(v) ? '—' : (+v).toFixed(d));
  const badge = (text, cls) => `<span class="badge ${cls || ''}">${esc(text)}</span>`;
  const statusBadge = (s) => badge(s, { ok: 'ok', manual: 'info', partial: 'warn', stale: 'warn', missing: 'bad', finished: 'ok', scheduled: 'info', live: 'warn', postponed: 'bad' }[s] || '');
  const card = (title, body, cls = '', right = '') => `<section class="card ${cls}"><header class="card-h"><h3>${esc(title)}</h3>${right}</header><div class="card-b">${body}</div></section>`;
  const stat = (label, value, sub, cls) => `<div class="stat ${cls || ''}"><div class="stat-v">${value}</div><div class="stat-l">${esc(label)}</div>${sub ? `<div class="stat-s">${sub}</div>` : ''}</div>`;
  const empty = (msg, action) => `<div class="empty"><p>${msg}</p>${action || ''}</div>`;
  const pageHead = (title, sub, right = '') => `<div class="page-h"><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="page-act">${right}</div></div>`;
  const teamLogoKey = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const TEAM_LOGO_BY_NAME = Object.create(null);
  ((NS.data && NS.data.teamLogos) || []).forEach((team) => (team.names || []).forEach((name) => { TEAM_LOGO_BY_NAME[teamLogoKey(name)] = team.file; }));
  const fixtureMark = (name, side, compact) => {
    const skip = /^(FC|AFC|AC|SC|FK|RSC|SK|CF)$/i;
    const words = String(name || '').split(/[\s/.-]+/).filter((word) => word && !skip.test(word));
    const initials = words.slice(0, 2).map((word) => Array.from(word)[0]).join('').toUpperCase() || Array.from(String(name || '?'))[0].toUpperCase();
    const logo = TEAM_LOGO_BY_NAME[teamLogoKey(name)];
    const classes = `fixture-crest ${side}${compact ? ' compact' : ''}${logo ? ' has-logo' : ''}`;
    const image = logo ? `<img class="fixture-crest-image" src="${esc(logo)}" alt="" loading="lazy" onerror="this.parentElement.classList.remove('has-logo');this.remove()">` : '';
    return `<span class="${classes}" aria-hidden="true"><span class="fixture-crest-initials">${esc(initials)}</span>${image}</span>`;
  };
  const fixtureDate = (m) => {
    const hasTime = String(m.date || '').length > 10;
    const date = new Date(hasTime ? m.date : `${String(m.date).slice(0, 10)}T12:00:00Z`);
    if (isNaN(date.getTime())) return fmtDate(m);
    const options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (hasTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return new Intl.DateTimeFormat('en-GB', options).format(date) + (hasTime ? ' UTC' : '');
  };
  const form = { chip: (r) => `<span class="chip r-${r.res}" title="${esc(r.opp)} ${esc(r.score)} (${r.home ? 'H' : 'A'}) ${esc(r.date)}">${r.res}</span>` };
  const symLabel = (o) => ({ H: '1', D: 'X', A: '2' }[o]);
  const confCls = (l) => ({ High: 'ok', Medium: 'warn', Low: 'bad' }[l] || '');

  /* ------------------------------------------------------------------ banners */
  function targetBanner(app) {
    const bt = app.backtest;
    if (!bt) return `<div class="banner neutral"><b>Model validation: not run.</b> No backtest has been executed on the loaded data. Accuracy target: 70% (an evaluation goal, not a guarantee).</div>`;
    if (bt.status !== 'COMPLETE') return `<div class="banner bad"><b>${esc(bt.status)}</b> — ${esc(bt.reason || '')}</div>`;
    const t = bt.summary.target;
    return `<div class="banner ${t.met ? 'ok' : 'bad'}">${esc(t.message)}</div>`;
  }
  function dataBanner(app) {
    const s = app.dm.summary();
    if (!s.persistent) return '<div class="banner warn"><b>Storage unavailable.</b> Your browser blocked LocalStorage — data will be lost when you close the tab. Export a backup from Data Management.</div>';
    if (s.lastSaveError) return `<div class="banner bad"><b>Save failed:</b> ${esc(s.lastSaveError)}</div>`;
    return '';
  }

  /* ---------------------------------------------------------------- dashboard */
  function dashboard(app) {
    const s = app.dm.summary(), hs = app.hist.stats(), bt = app.backtest;
    const noData = s.matches === 0;
    const btAcc = bt && bt.status === 'COMPLETE' ? bt.summary.series.model.accuracy : null;
    let h = pageHead('Dashboard', 'UEFA Champions League statistical analyzer — one calibrated 1X2 decision per match.');
    h += dataBanner(app) + targetBanner(app);
    if (noData) {
      h += card('Get started — no data loaded', `<p>No match data is currently available in this browser. Import real CSV/JSON data or configure a provider to load matches:</p>
        <ol class="steps"><li><b>Data Management → Import</b> a CSV/JSON of historical UCL results (columns: <code>date, home, away, homeGoals, awayGoals</code>; optional <code>season, stage, odds, xG, shots</code>), or</li>
        <li><b>Settings → Data provider</b>: point to your secure proxy and fetch results from the API, then</li>
        <li><b>Historical Backtesting → Run</b> to measure the model honestly, and open a fixture in <b>Match Analysis</b>.</li></ol>
        <a class="btn primary" href="#/data">Go to Data Management</a>`, 'wide');
    }
    h += `<div class="grid stats">${stat('Matches loaded', s.matches, `${s.finished} finished · ${s.scheduled} scheduled`)}${stat('Teams', s.teams)}${stat('Seasons', Object.keys(s.bySeason).length)}
      ${stat('Predictions saved', app.hist.all().length, `${hs.summary.n} evaluated`)}
      ${stat('Live accuracy', hs.summary.n ? pct(hs.summary.accuracy) : '—', hs.summary.n ? `${hs.summary.correct}/${hs.summary.n} correct` : 'no evaluated predictions yet')}
      ${stat('Backtest accuracy', btAcc !== null ? pct(btAcc) : '—', btAcc !== null ? `${bt.summary.nScored} matches · target 70%` : bt ? esc(bt.status) : 'not run', btAcc !== null ? (btAcc >= 0.7 ? 'good' : 'bad') : '')}</div>`;
    const next = app.upcoming(1)[0];
    if (next) {
      const nextBody = next.a ? `<div class="grid stats">${stat('Match', `${esc(next.match.homeName)} v ${esc(next.match.awayName)}`, `${esc(fmtDate(next.match))} · ${esc(next.match.stage || 'UCL fixture')}`)}${stat('Model pick', `<b class="pickcell">${next.a.final.symbol}</b> ${esc(next.a.final.label)}`, pct(next.a.final.probs[next.a.final.pick]))}${stat('Confidence', badge(next.a.final.confidence.label, confCls(next.a.final.confidence.label)), esc(next.a.dataQuality.status) + ' data')}</div>` : `<p class="banner bad">${esc(next.error || 'Analysis is unavailable for this fixture.')}</p><p>${esc(next.match.homeName)} v ${esc(next.match.awayName)} · ${esc(fmtDate(next.match))}</p>`;
      h += card('Next match', nextBody, 'wide', `<a class="btn primary" href="#/analysis/${encodeURIComponent(next.match.id)}">Open match analysis</a>`);
    } else {
      h += card('Next match', empty('No upcoming fixtures are loaded.', '<a class="btn" href="#/data">Add fixtures</a>'), 'wide');
    }
    h += `<p class="dim dashboard-links"><a class="btn" href="#/fixtures">Browse all fixtures</a> <a class="btn" href="#/analysis">Choose another match</a></p>`;
    h += '<div class="grid two">';
    h += card('Live performance (saved predictions)', hs.series.length ? C.lines([{ name: 'Accuracy', color: 'var(--c-accent)', points: hs.series.map((p) => ({ y: p.accuracy })) }], { pct: true, min: 0, max: 1, refLine: 0.7, refLabel: 'target 70%', title: 'live accuracy' }) : empty('Save predictions before kickoff, then enter results to build a live track record.'));
    h += '</div>';
    h += card('Data quality snapshot', s.finished ? `<div class="scroll-x"><table class="tbl compact"><thead><tr><th>Field</th><th>Coverage (finished matches)</th><th></th></tr></thead><tbody>${Object.entries(s.completeness.fields).map(([f, v]) => `<tr><td>${esc(f)}</td><td>${v.have}/${s.completeness.n}</td><td><div class="meter"><i style="width:${(v.coverage * 100).toFixed(0)}%"></i></div></td></tr>`).join('')}</tbody></table></div>` : empty('No finished matches loaded.'));
    return h;
  }

  /* ----------------------------------------------------------------- fixtures */
  function fixtures(app) {
    const f = app.filters.fixtures;
    const list = app.dm.listMatches({ q: f.q, status: f.status || undefined, season: f.season || undefined, stage: f.stage || undefined, teamId: f.teamId || undefined });
    if (f.order !== 'asc') list.reverse();
    const shown = list.slice(0, 250);
    const sel = (id, opts, cur, all) => `<select id="${id}" data-filter="fixtures"><option value="">${all}</option>${opts.map((o) => `<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    let h = pageHead('UCL Fixtures', 'Search and filter every loaded match. Click a fixture to analyse it.', '<a class="btn" href="#/data">Import / add matches</a>');
    h += `<div class="filters"><input type="search" id="f-q" data-filter="fixtures" placeholder="Search team, stage, venue…" value="${esc(f.q || '')}" aria-label="Search matches">
      ${sel('f-status', [{ v: 'scheduled', t: 'Scheduled' }, { v: 'finished', t: 'Finished' }, { v: 'live', t: 'Live' }, { v: 'postponed', t: 'Postponed' }], f.status, 'All statuses')}
      ${sel('f-season', app.dm.seasons().map((s) => ({ v: s, t: s })).reverse(), f.season, 'All seasons')}
      ${sel('f-stage', app.dm.stages().map((s) => ({ v: s, t: s })), f.stage, 'All stages')}
      ${sel('f-team', app.dm.teams().map((t) => ({ v: t.id, t: t.name })), f.teamId, 'All teams')}
      ${sel('f-order', [{ v: 'asc', t: 'Oldest first' }], f.order, 'Newest first')}</div>`;
    if (!list.length) return h + empty(app.dm.summary().matches ? 'No matches match these filters.' : 'No matches loaded yet. Import data in Data Management.');
    h += `<p class="dim">${list.length} match(es)${list.length > shown.length ? `, showing first ${shown.length}` : ''}</p>`;
    h += `<div class="scroll-x"><table class="tbl hover"><thead><tr><th>Date (UTC)</th><th>Season</th><th>Stage</th><th>Home</th><th></th><th>Away</th><th>Status</th><th>Prediction</th></tr></thead><tbody>
      ${shown.map((m) => { const p = app.hist.official(m.id) || app.hist.forFixture(m.id).slice(-1)[0]; const ev = app.hist.evaluationFor(m.id); return `<tr data-href="#/analysis/${encodeURIComponent(m.id)}"><td class="nw">${esc(fmtDate(m))}</td><td>${esc(m.season || '')}</td><td class="dim">${esc(m.stage || '')}</td><td>${esc(m.homeName)}</td><td class="score">${m.homeGoals !== null ? m.homeGoals + ' – ' + m.awayGoals : 'v'}</td><td>${esc(m.awayName)}</td><td>${statusBadge(m.status)}</td><td>${p ? `<b>${symLabel(p.pick)}</b> ${ev ? badge(ev.correct ? '✓' : '✗', ev.correct ? 'ok' : 'bad') : ''}` : '<span class="dim">—</span>'}</td></tr>`; }).join('')}</tbody></table></div>`;
    return h;
  }

  /* ------------------------------------------------------------ match analysis */
  function contextForm(a, ctx, app) {
    const f = ctx.fields || {};
    const lines = (arr) => (arr || []).map((p) => [p.name, p.attackShare ?? '', p.defenceShare ?? ''].join(', ')).join('\n');
    const side = (s, name) => `<fieldset><legend>${esc(name)}</legend>
      <label>Injuries <small>one per line: <code>name, attackShare, defenceShare</code> (0–1; share of team attack/defence the player provides)</small><textarea name="${s}Injuries" rows="3" placeholder="e.g. Player X, 0.25, 0">${esc(lines(f[s + 'Injuries']))}</textarea></label>
      <label>Suspensions <small>same format</small><textarea name="${s}Suspensions" rows="2">${esc(lines(f[s + 'Suspensions']))}</textarea></label>
      <div class="row3"><label>Formation<input name="${s}Formation" value="${esc(f[s + 'Formation'] || '')}" placeholder="4-3-3"></label>
      <label>Starting XI status<select name="${s}LineupStatus">${['unknown', 'expected', 'confirmed'].map((o) => `<option ${((f[s + 'Lineup'] || {}).status || 'unknown') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      <label>Rest days<input name="${s}RestDays" type="number" min="0" max="60" value="${esc(f[s + 'RestDays'] ?? '')}"></label>
      <label>Matches, last 14 days<input name="${s}Matches14d" type="number" min="0" max="10" value="${esc(f[s + 'Matches14d'] ?? '')}"></label></div>
      <label>Expected / confirmed XI <small>comma separated (optional)</small><input name="${s}Xi" value="${esc(((f[s + 'Lineup'] || {}).players || []).join(', '))}"></label></fieldset>`;
    return `<form id="ctx-form" data-match="${esc(a.match.id)}"><div class="grid two">${side('home', a.match.home)}${side('away', a.match.away)}</div>
      <p class="dim">Squad adjustments to the probabilities are <b>${a.config.squad.enabled ? 'ENABLED' : 'disabled'}</b> (Settings → Engine). They are unvalidated assumptions, so by default this information is shown as context and data-quality input only.</p>
      <button class="btn primary" type="submit">Save context &amp; re-analyse</button></form>`;
  }

  function teamCompare(a) {
    const H = a.teams.home, A = a.teams.away, hp = H.profile, ap = A.profile;
    const formRow = (p) => (p.last5.length ? p.last5.map(form.chip).join('') + `<span class="dim"> ${p.formPoints}/${p.formMax} pts</span>` : '<span class="dim">no matches</span>');
    const rec = (s) => (s.n ? `${s.w}W ${s.d}D ${s.l}L` : '—');
    let h = `<div class="cmp-head"><div class="tname home"><div class="analysis-team-identity">${fixtureMark(H.name, 'home', true)}<span>${esc(H.name)}</span></div></div><div class="vs">vs</div><div class="tname away"><div class="analysis-team-identity away">${fixtureMark(A.name, 'away', true)}<span>${esc(A.name)}</span></div></div></div>`;
    h += `<div class="cmp-row"><div>${formRow(hp)}</div><div class="cmp-l">Recent form (last 5)</div><div class="r">${formRow(ap)}</div></div>`;
    h += C.duel('Elo rating', H.elo, A.elo, (v) => num(v, 0));
    h += C.duel('Attack index (1.00 = avg)', H.attack, A.attack, (v) => num(v));
    h += C.duel('Defence index (lower = better)', H.defence, A.defence, (v) => num(v), true);
    h += C.duel('Goals scored / match (all)', hp.overall.gf, ap.overall.gf);
    h += C.duel('Goals conceded / match (all)', hp.overall.ga, ap.overall.ga, null, true);
    h += C.duel(`Home goals for (${esc(H.name)}) / away goals for (${esc(A.name)})`, hp.home.gf, ap.away.gf);
    h += C.duel('Home goals against / away goals against', hp.home.ga, ap.away.ga, null, true);
    h += C.duel('xG for / match', hp.xg ? hp.xg.for : null, ap.xg ? ap.xg.for : null);
    h += C.duel('xGA / match', hp.xg ? hp.xg.against : null, ap.xg ? ap.xg.against : null, null, true);
    h += C.duel('Shots / match', hp.shots ? hp.shots.perGame : null, ap.shots ? ap.shots.perGame : null, (v) => num(v, 1));
    h += C.duel('Shots on target / match', hp.shots ? hp.shots.sotPerGame : null, ap.shots ? ap.shots.sotPerGame : null, (v) => num(v, 1));
    h += C.duel('Big chances / match', hp.shots ? hp.shots.bigPerGame : null, ap.shots ? ap.shots.bigPerGame : null, (v) => num(v, 1));
    h += C.duel('Conversion rate', hp.shots ? hp.shots.conversion : null, ap.shots ? ap.shots.conversion : null, (v) => (v === null || v === undefined ? '—' : pct(v)));
    h += C.duel('Clean sheets', hp.cleanSheets, ap.cleanSheets, (v) => (v === null ? '—' : v));
    h += `<div class="scroll-x"><table class="tbl compact"><thead><tr><th></th><th>${esc(H.name)}</th><th>${esc(A.name)}</th></tr></thead><tbody>
      <tr><td>Matches in loaded history</td><td>${hp.n}</td><td>${ap.n}</td></tr>
      <tr><td>Record at ${esc(H.name)} home / ${esc(A.name)} away</td><td>${rec(hp.home)}</td><td>${rec(ap.away)}</td></tr>
      <tr><td>Record overall</td><td>${rec(hp.overall)}</td><td>${rec(ap.overall)}</td></tr>
      <tr><td>Average Elo of opponents faced</td><td>${num(hp.oppAvgElo, 0)}</td><td>${num(ap.oppAvgElo, 0)}</td></tr>
      <tr><td>Days since last loaded match</td><td>${hp.restDaysLoaded ?? '—'}</td><td>${ap.restDaysLoaded ?? '—'}</td></tr>
      <tr><td>Matches in prior 14 days (UCL only)</td><td>${hp.matches14dLoaded}</td><td>${ap.matches14dLoaded}</td></tr>
      <tr><td>Formation</td><td>${esc(H.formation || '—')}</td><td>${esc(A.formation || '—')}</td></tr>
      <tr><td>Injuries / suspensions entered</td><td>${H.injuries || H.suspensions ? (H.injuries || []).length + ' / ' + (H.suspensions || []).length : '<span class="dim">not entered</span>'}</td><td>${A.injuries || A.suspensions ? (A.injuries || []).length + ' / ' + (A.suspensions || []).length : '<span class="dim">not entered</span>'}</td></tr>
      <tr><td>Starting XI</td><td>${esc((H.lineup && H.lineup.status) || 'unknown')}</td><td>${esc((A.lineup && A.lineup.status) || 'unknown')}</td></tr></tbody></table></div>`;
    h += `<p class="dim">Tactical comparison is limited to the formations you enter; the model has no tactical-style input, so formations are context only.</p>`;
    return h;
  }

  function h2hBlock(a) {
    const h = a.h2h;
    if (!h.n) return '<p class="dim">No previous meetings in the loaded data.</p>';
    return `<p>${h.n} meeting(s): <b>${esc(a.match.home)}</b> ${h.homeWins}W · ${h.draws}D · <b>${esc(a.match.away)}</b> ${h.awayWins}W · goals ${h.homeGoals}–${h.awayGoals}. <span class="dim">Context only; not a model input.</span></p>
      <table class="tbl compact"><tbody>${h.last.map((m) => `<tr><td>${esc(m.date)}</td><td>${esc(m.home)} ${esc(m.score)} ${esc(m.away)}</td><td class="dim">${esc(m.season || '')}</td></tr>`).join('')}</tbody></table>`;
  }

  function dqTable(dq) {
    return `<div class="meter big"><i style="width:${(dq.score * 100).toFixed(0)}%"></i></div><p><b>${dq.status}</b> — completeness score ${(dq.score * 100).toFixed(0)}%${dq.missing.length ? `. Missing: ${dq.missing.map(esc).join('; ')}` : ''}</p>
      <div class="scroll-x"><table class="tbl compact"><thead><tr><th>Input</th><th>Value</th><th>Source</th><th>Timestamp</th><th>Status</th></tr></thead><tbody>${dq.items.map((i) => `<tr><td>${esc(i.label)}${i.note ? `<div class="dim small">${esc(i.note)}</div>` : ''}</td><td>${esc(i.value)}</td><td>${esc(i.source)}</td><td class="nw">${esc(i.timestamp ? i.timestamp.replace('T', ' ').slice(0, 16) : '—')}</td><td>${statusBadge(i.status)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function fieldProvenance(app, m) {
    const rows = ['date', 'homeGoals', 'awayGoals', 'status', 'oddsH', 'oddsD', 'oddsA', 'homeXg', 'awayXg', 'venue', 'stage'].map((f) => app.dm.provenanceOf(m.id, f)).filter(Boolean);
    return `<div class="scroll-x"><table class="tbl compact"><thead><tr><th>Field</th><th>Value</th><th>Origin</th><th>Updated</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(p.field)}</td><td>${p.value === null ? '<span class="dim">missing</span>' : esc(p.value)}${p.overridden ? ` <span class="dim">(provider: ${esc(p.baseValue ?? '—')})</span>` : ''}</td><td>${badge(p.origin, p.origin === 'manual' ? 'info' : p.origin === 'missing' ? 'bad' : '')}</td><td class="nw">${esc(p.timestamp ? p.timestamp.slice(0, 16).replace('T', ' ') : '—')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function dataSourceLabel(source) {
    if (!source) return '';
    if (source === 'bundled') return 'Bundled dataset';
    if (source === 'manual') return 'Manual entry';
    if (source.startsWith('api:')) return `API (${source.slice(4)})`;
    if (source.startsWith('import:')) return `${source.slice(7).toUpperCase()} import`;
    return source;
  }

  function dataReadinessCard(app, m, ctx, a) {
    const trace = ['date', 'status', 'homeGoals', 'awayGoals', 'oddsH', 'oddsD', 'oddsA', 'homeXg', 'awayXg']
      .map((field) => app.dm.provenanceOf(m.id, field)).filter((p) => p && p.value !== null);
    const history = (a.dataQuality.items || []).find((item) => item.key === 'history_home');
    const contextMeta = Object.values(ctx.meta || {}).filter((item) => item && typeof item === 'object');
    const sourceValues = [...trace.map((p) => p.source || p.origin), history && history.source, ...contextMeta.map((item) => item.source)];
    const sources = [...new Set(sourceValues.flatMap((source) => String(source || '').split(',').map((part) => dataSourceLabel(part.trim())).filter(Boolean)))];
    const lastImport = app.dm.summary().lastImport;
    const lastApiRefresh = Number(app.storage.get('api.matchesLastRefreshAt', 0));
    const timestamps = [...trace.map((p) => p.timestamp), history && history.timestamp, ...contextMeta.map((item) => item.timestamp),
      lastImport && lastImport.timestamp, Number.isFinite(lastApiRefresh) && lastApiRefresh > 0 ? new Date(lastApiRefresh).toISOString() : null];
    const latest = timestamps.filter((t) => t && Number.isFinite(Date.parse(t)))
      .sort((x, y) => Date.parse(y) - Date.parse(x))[0];
    const updatedLabel = latest ? new Date(latest).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'Timestamp not recorded';
    const oddsEntered = [m.oddsH, m.oddsD, m.oddsA].filter((v) => Number.isFinite(v)).length;
    const oddsStatus = V.reliableOdds(m) ? 'Available' : oddsEntered ? oddsEntered === 3 ? 'Entered, not benchmarkable' : 'Incomplete' : 'Not available';
    const oddsNote = V.reliableOdds(m) ? 'Comparison benchmark only; odds do not enter the model prediction.' : 'A complete, reliable 1X2 set is needed for the bookmaker comparison.';
    const xgAdjustment = (a.adjustments || []).find((item) => item.name === 'xG blend');
    const xgStatus = xgAdjustment && xgAdjustment.applied ? 'Used in this prediction' : 'Not used';
    const xgNote = xgAdjustment ? xgAdjustment.reason : 'No xG adjustment was reported by the model.';
    const lineupStatus = (side) => {
      const status = ctx.fields && ctx.fields[side + 'Lineup'] && ctx.fields[side + 'Lineup'].status;
      return status === 'confirmed' ? 'Confirmed' : status === 'expected' ? 'Expected' : 'Not entered';
    };
    const lineupValue = `${lineupStatus('home')} / ${lineupStatus('away')}`;
    const lineupNote = a.config.squad.enabled ? 'Squad adjustment is enabled; walk-forward does not include match-specific squad context.' : 'Context only; squad adjustment is off.';
    const bt = app.backtest;
    const squadUnvalidated = !!a.config.squad.enabled;
    const comparable = !squadUnvalidated && !!bt && bt.status === 'COMPLETE' && !app.backtestStale && bt.configHash === a.configHash;
    const model = comparable ? bt.summary.series.model : null;
    const evaluationValue = squadUnvalidated ? 'Squad adjustment not validated' : model ? `Current walk-forward · n=${model.n}` : 'No current matching backtest';
    const evaluationNote = squadUnvalidated ? 'The backtest does not replay match-specific lineups or injuries; turn this adjustment off for a comparable validation.' : model ? `Accuracy ${pct(model.accuracy)} · Brier ${num(model.brier, 3)} · log loss ${num(model.logLoss, 3)}.` : 'Re-run after data or engine changes; compare Brier and log loss before adopting a change.';
    const tile = (label, value, note) => `<div class="readiness-item"><span class="readiness-label">${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`;
    const sourceValue = sources.length ? sources.join(', ') : 'Source not recorded';
    const sourceNote = latest ? `Latest recorded update: ${updatedLabel}.` : updatedLabel + '.';
    return card('Data readiness & provenance', `<div class="readiness-grid">${tile('Match data source', sourceValue, sourceNote)}${tile('1X2 odds', oddsStatus, oddsNote)}${tile('xG input', xgStatus, xgNote)}${tile('Starting XI', lineupValue, lineupNote)}${tile('Model evaluation', evaluationValue, evaluationNote)}</div><p class="dim readiness-foot">Optional inputs are validated before storage. Eligible football-data plans can supply odds, shots and lineups; xG can be imported from a trusted CSV or Custom JSON source. <a href="#/backtesting">Run walk-forward backtesting</a> after changes.</p>`);
  }

  function amaiPanel(app, m) {
    const messages = app.amaiChats && app.amaiChats[m.id] || [];
    const busy = app.amaiBusy === m.id;
    const error = app.amaiErrors && app.amaiErrors[m.id];
    const proxyReady = !!(app.settings.api && app.settings.api.baseUrl);
    const safeText = (text) => esc(text).replace(/\n/g, '<br>');
    const thread = messages.length
      ? messages.slice(-10).map((item) => `<div class="amai-message ${item.role === 'user' ? 'user' : 'assistant'}"><span class="amai-message-label">${item.role === 'user' ? 'You' : 'AMAI'}</span><div class="amai-bubble">${safeText(item.content)}</div></div>`).join('')
      : `<div class="amai-welcome"><span class="amai-orb" aria-hidden="true">✦</span><div><b>Ask AMAI about this match</b><p>It can explain the model's pick, compare recent form, or point out missing inputs using this match's loaded data.</p></div></div>`;
    const prompts = [
      ['summary', 'Summarise this match'],
      ['factors', 'What drives the prediction?'],
      ['missing', 'What data is missing?'],
    ];
    const controls = proxyReady
      ? `<div class="amai-quick-prompts">${prompts.map(([key, label]) => `<button type="button" class="amai-prompt" data-amaiprompt="${key}" data-match="${esc(m.id)}" ${busy ? 'disabled' : ''}>${esc(label)}</button>`).join('')}</div>
        <form id="amai-form" class="amai-form" data-match="${esc(m.id)}"><label class="sr-only" for="amai-question">Ask AMAI a question about this match</label><textarea id="amai-question" name="question" rows="2" maxlength="800" placeholder="Ask AMAI about this match…" required ${busy ? 'disabled' : ''}></textarea><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}><span aria-hidden="true">↑</span> ${busy ? 'Thinking…' : 'Ask AMAI'}</button></form>
        <p class="amai-privacy">Only this match summary, your question and its short chat history are sent through the configured AI proxy. API usage may incur charges; the full match database stays in this browser.</p>`
      : `<div class="banner warn amai-config"><b>AMAI needs a secure proxy URL.</b> Save your Worker URL in <a href="#/settings">Settings → Data provider</a>, then set the <code>AMAI_OPENAI_KEY</code> secret on that Worker.</div>`;
    return card('AMAI — Match Intelligence', `<div class="amai-panel"><div class="amai-panel-top"><div class="amai-brand"><span class="amai-orb" aria-hidden="true">✦</span><div><b>Artificial Match Analysis Intelligence</b><small>Match explainer · Bahasa Indonesia</small></div></div><span class="badge info">AI ASSISTANT</span></div>
      <div class="amai-thread" role="log" aria-live="polite" aria-busy="${busy}" aria-relevant="additions text" aria-label="AMAI conversation">${thread}${busy ? '<div class="amai-thinking"><i></i><i></i><i></i><span>AMAI is reviewing the match data…</span></div>' : ''}</div>
      ${error ? `<div class="banner bad amai-error" role="alert">${esc(error)}</div>` : ''}${controls}
      <p class="amai-disclaimer">AMAI explains the existing statistical model. It does not change the prediction or guarantee a result.</p></div>`, 'amai-card');
  }

  function analysis(app, params) {
    const id = params[0];
    const m = id ? app.dm.getMatch(id) : null;
    if (!m) {
      if (id) return pageHead('Match Analysis') + empty('Match not found.', '<a class="btn" href="#/fixtures">Browse fixtures</a>');
      return NS.matchCenter.render(app);
    }
    let a;
    try { a = app.analyze(m); } catch (e) { return pageHead('Match Analysis') + `<div class="banner bad"><b>Analysis failed:</b> ${esc(e.message)}</div>`; }
    const F = a.final, names = { home: a.match.home, away: a.match.away };
    const stored = app.hist.official(m.id), ev = app.hist.evaluationFor(m.id);
    const ctx = app.dm.getContext(m.id);
    let h = pageHead(`${a.match.home} v ${a.match.away}`, `${esc(a.match.competition)} · ${esc(a.match.stage || 'stage n/a')} · ${esc(a.match.season || '')}`, '<a class="btn" href="#/fixtures">← Fixtures</a>');
    if (a.retrospective) h += `<div class="banner neutral"><b>Retrospective view.</b> This match is finished. The analysis below uses only data from before ${esc(a.match.date)} and is shown for review — it is <b>not</b> saved as a pre-match prediction.</div>`;
    h += card('Match information', `<div class="grid info"><div><span class="k">Home</span>${esc(a.match.home)}</div><div><span class="k">Away</span>${esc(a.match.away)}</div><div><span class="k">Competition</span>${esc(a.match.competition)}</div><div><span class="k">Date</span>${esc(a.match.date)}</div><div><span class="k">Kickoff</span>${esc(a.match.kickoff || 'not provided')}</div><div><span class="k">Venue</span>${esc(a.match.venue || 'not provided')}${a.match.neutral ? ' · neutral' : ''}</div></div>
      <details><summary>Field provenance (source of each stored field)</summary>${fieldProvenance(app, m)}</details>`);
    h += dataReadinessCard(app, m, ctx, a);

    h += card('Final conclusion', `<div class="final">
      <div class="final-pick"><div class="final-sym">${F.symbol}</div><div><div class="final-l">${esc(F.label)}</div><div class="dim">Selected outcome (1 = Home · X = Draw · 2 = Away)</div></div></div>
      <div class="final-meta">${stat('Model confidence', `<span class="${confCls(F.confidence.label)}-t">${F.confidence.label}</span>`, F.confidence.caps.length ? esc(F.confidence.caps.join('; ')) : '')}
        ${stat('Data quality', a.dataQuality.status, `${(a.dataQuality.score * 100).toFixed(0)}% complete`)}
        ${stat('Pick probability', pct(F.probs[F.pick]), `next: ${symLabel(F.runnerUp)} at ${pct(F.probs[F.runnerUp])}`)}</div>
      <p class="validation"><b>Model validation status:</b> ${esc(a.validation.status)}</p>
      <h4>Supporting statistical evidence</h4><ul>${F.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      <h4>Main factors influencing the decision</h4><ul>${F.factors.map((f) => `<li><b>${esc(f.name)}:</b> ${esc(f.detail)}</li>`).join('')}</ul>
      <details><summary>How confidence was computed</summary><table class="tbl compact"><tbody>${Object.entries(F.confidence.parts).map(([k, p]) => `<tr><td>${esc(k)}</td><td>${(p.score * 100).toFixed(0)}%</td><td>weight ${(p.weight * 100).toFixed(0)}%</td><td class="dim">${esc(p.note || '')}</td></tr>`).join('')}</tbody></table><p class="dim">Weighted score ${(F.confidence.score * 100).toFixed(0)}% → ${F.confidence.label}. Caps applied after scoring are listed above. See README for the exact rule.</p></details>
      <div class="final-act">${stored ? `<span>${badge('Saved ' + stored.createdAt.slice(0, 16).replace('T', ' '), 'ok')} pre-match prediction: <b>${stored.symbol}</b> (${pct(stored.probs[stored.pick])})${stored.pick !== F.pick || stored.configHash !== a.configHash ? ' — differs from the current analysis; the saved one stays the official record' : ''}</span>` : a.retrospective ? '' : `<button class="btn primary" data-act="save-prediction" data-id="${esc(m.id)}">Save as pre-match prediction</button>`}
        ${ev ? `<span>${badge(ev.correct ? 'Correct' : 'Incorrect', ev.correct ? 'ok' : 'bad')} actual ${ev.result.homeGoals}–${ev.result.awayGoals}</span>` : ''}</div></div>`, 'final-card');

    h += amaiPanel(app, m);

    h += card('Probability calculation', C.probBar(F.probs, names, F.pick) + `<div class="scroll-x"><table class="tbl compact"><thead><tr><th>Component</th><th>1 Home</th><th>X Draw</th><th>2 Away</th></tr></thead><tbody>
      ${[['Dixon–Coles (Poisson + low-score correction)', F.components.dc], ['Elo (Davidson 1X2)', F.components.elo], ['Blend (raw)', F.rawProbs], ['Calibrated — FINAL', F.probs], ['Statistical baseline (training frequencies)', F.components.baseline]].map(([n, p], i) => `<tr class="${i === 3 ? 'strong' : ''}"><td>${n}</td><td>${pct(p.H)}</td><td>${pct(p.D)}</td><td>${pct(p.A)}</td></tr>`).join('')}
      ${a.bookmaker ? `<tr><td>Bookmaker, margin removed (benchmark only; overround ${((a.bookmaker.overround - 1) * 100).toFixed(1)}%)</td><td>${pct(a.bookmaker.probs.H)}</td><td>${pct(a.bookmaker.probs.D)}</td><td>${pct(a.bookmaker.probs.A)}</td></tr>` : ''}</tbody></table></div>
      <p class="dim">Rounded display sums to exactly 100%: ${F.percentages.map((p) => p.toFixed(1)).join(' + ')} = ${F.percentages.reduce((x, y) => x + y, 0).toFixed(1)}. Fitted: ρ = ${num(a.dcParams.rho, 3)}, home factor γ = ${num(a.dcParams.gamma)}, mean goals μ = ${num(a.dcParams.mu)}; trained on ${a.nTrain} earlier matches.</p>`);

    h += card('Scoreline analysis', `<div class="grid two"><div><div class="stat-row">${stat('Most likely scoreline', `${F.mostLikely.home}–${F.mostLikely.away}`, pct(F.mostLikely.p))}${stat('Expected goals', `${num(F.expectedGoals.home)} – ${num(F.expectedGoals.away)}`, esc(names.home) + ' – ' + esc(names.away))}</div>
      <p class="dim">The scoreline is supplementary and never replaces the 1X2 decision. The grid is rescaled so its 1X2 totals equal the final probabilities.</p>
      <details><summary>Alternative scorelines (internal analysis)</summary><table class="tbl compact"><tbody>${F.topScorelines.map((s) => `<tr><td>${s.home}–${s.away}</td><td>${pct(s.p, 2)}</td></tr>`).join('')}</tbody></table></details></div>
      <div>${C.scoreGrid(a.matrix, 5, { home: a.match.home, away: a.match.away })}</div></div>`);

    h += card('Team comparison', teamCompare(a));
    h += card('Head-to-head', h2hBlock(a));
    h += card('Data quality & sources', dqTable(a.dataQuality));
    h += card('Squad & match context (manual input)', contextForm(a, ctx, app));
    return h;
  }

  /* --------------------------------------------------------- prediction results */
  function results(app) {
    const hs = app.hist.stats(), pend = app.hist.pending();
    let h = pageHead('Prediction Results', 'Pre-match predictions and their evaluation. Original predictions are never overwritten.', '<button class="btn" data-act="eval-pending">Evaluate finished matches</button>');
    h += `<div class="grid stats">${stat('Evaluated', hs.summary.n)}${stat('Accuracy', hs.summary.n ? pct(hs.summary.accuracy) : '—', hs.summary.n ? `95% CI ${pct(hs.summary.wilson.lo, 0)}–${pct(hs.summary.wilson.hi, 0)}` : '')}${stat('Brier score', hs.summary.n ? num(hs.summary.brier, 4) : '—', 'lower is better')}${stat('Log loss', hs.summary.n ? num(hs.summary.logLoss, 4) : '—', 'lower is better')}</div>`;
      h += card('Awaiting results', pend.length ? `<div class="scroll-x"><table class="tbl"><thead><tr><th>Kickoff</th><th>Match</th><th>Pick</th><th>Timing</th><th class="result-entry-heading"><div class="result-header"><span>Enter result</span><div class="result-bulk-actions"><button type="button" class="btn sm danger" data-remove-all-predictions>Remove All</button></div></div></th></tr></thead><tbody>${pend.map((p) => `<tr><td class="nw">${esc(p.kickoff.slice(0, 16).replace('T', ' '))}</td><td><a href="#/analysis/${encodeURIComponent(p.fixtureId)}">${esc(p.homeName)} v ${esc(p.awayName)}</a></td><td><b>${p.symbol}</b> ${pct(p.probs[p.pick])}</td><td>${badge(p.timing, p.timing === 'pre-match' ? 'ok' : 'bad')}</td><td class="result-entry-cell"><div class="result-entry" data-result-entry data-id="${esc(p.fixtureId)}"><input type="number" name="hg" min="0" max="20" required aria-label="home goals"> <span class="result-dash" aria-hidden="true">–</span> <input type="number" name="ag" min="0" max="20" required aria-label="away goals"><button type="button" class="btn sm danger result-remove" data-remove-prediction data-id="${esc(p.fixtureId)}" data-match="${esc(p.homeName + ' v ' + p.awayName)}" aria-label="Remove prediction for ${esc(p.homeName + ' v ' + p.awayName)}" title="Remove prediction">×</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('No predictions are waiting for a result.'));
    if (pend.length) h += '<dialog class="result-delete-dialog" data-result-delete-dialog aria-labelledby="result-delete-title"><div class="result-delete-panel"><span class="badge warn">REMOVE PREDICTION</span><h2 id="result-delete-title" data-delete-title>Remove saved prediction?</h2><p data-delete-description>This prediction will leave Awaiting results. Its original record will remain in Prediction History.</p><div class="result-delete-actions"><button type="button" class="btn" data-cancel-discard>Cancel</button><button type="button" class="btn danger" data-confirm-discard>Remove prediction</button></div></div></dialog>';
    const ev = app.hist.evaluated().slice().reverse();
    h += card('Evaluated predictions', ev.length ? `<div class="scroll-x"><table class="tbl"><thead><tr><th>Kickoff</th><th>Match</th><th>Pick</th><th>Actual</th><th>Result</th><th>P(actual)</th><th>Brier</th><th>Log loss</th></tr></thead><tbody>${ev.map(({ prediction: p, evaluation: e }) => `<tr><td class="nw">${esc(p.kickoff.slice(0, 10))}</td><td>${esc(p.homeName)} v ${esc(p.awayName)}</td><td><b>${p.symbol}</b></td><td>${e.result.homeGoals}–${e.result.awayGoals} (${symLabel(e.result.outcome)})</td><td>${badge(e.correct ? 'Correct' : 'Incorrect', e.correct ? 'ok' : 'bad')}</td><td>${pct(e.probOfActual)}</td><td>${num(e.brier, 3)}</td><td>${num(e.logLoss, 3)}</td></tr>`).join('')}</tbody></table></div>` : empty('No evaluated predictions yet.'));
    if (hs.summary.n) h += card('Performance over time', C.lines([{ name: 'Accuracy', color: 'var(--c-accent)', points: hs.series.map((p) => ({ y: p.accuracy })) }], { pct: true, min: 0, max: 1, refLine: 0.7, refLabel: '70% target' }) + C.lines([{ name: 'Brier', color: 'var(--c-draw)', points: hs.series.map((p) => ({ y: p.brier })) }, { name: 'Log loss', color: 'var(--c-away)', points: hs.series.map((p) => ({ y: p.logLoss })) }], {}));
    return h;
  }

  /* ----------------------------------------------------------- backtesting */
  function backtestingPage(app) {
    const bt = app.backtest, s = app.dm.summary();
    const sel = bt ? bt.seasonSelection : BTselect(app);
    let h = pageHead('Historical Backtesting', 'Walk-forward test over the most recent completed seasons present in your loaded data. Every prediction uses only earlier matches.', `<button class="btn primary" data-act="run-backtest" ${s.finished ? '' : 'disabled'}>Run walk-forward backtest</button>`);
    h += `<section id="bt-progress" class="bt-progress hidden" aria-busy="true">
      <div class="bt-progress-orbit" aria-hidden="true"><span>✦</span><i></i></div>
      <div class="bt-progress-body"><div class="bt-progress-top"><span class="bt-progress-kicker"><i></i> ENGINE LIVE</span><strong id="bt-progress-percent">0%</strong></div>
        <h2>Walk-forward simulation</h2><p id="bt-progress-text">Preparing historical match data…</p>
        <div id="bt-progress-track" class="bt-progress-track" role="progressbar" aria-label="Walk-forward backtest progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="bt-progress-bar"></i></div>
        <div class="bt-progress-foot"><span><i></i> Chronology guard active</span><span>Earlier matches only</span></div>
      </div>
    </section>`;
    h += targetBanner(app);
    h += card('Protocol (fixed)', `<ul class="compact-list"><li>Seasons requested: <b>5</b> most recent completed seasons with complete, comparable data (≥100 matches, ≥16 teams, every match has a result).</li><li>For each kickoff <i>day</i>: train only on matches from strictly earlier days → predict → store → move on. A leakage audit throws if this is ever violated.</li><li>The model sees only teams, date, venue flag and stage of the match being predicted — never its score, odds, xG or statistics.</li><li>Calibration for a match is fitted only on earlier out-of-sample predictions.</li><li>Benchmarks: normalised bookmaker probabilities (only matches with reliable odds, same subset for the model) and the training-frequency baseline.</li></ul>`);
    h += card('Season selection', `<div class="scroll-x"><table class="tbl compact"><thead><tr><th>Season</th><th>Status</th><th>Detail</th></tr></thead><tbody>${[...sel.seasons.map((x) => `<tr><td>${esc(x.season)}</td><td>${badge('used', 'ok')}</td><td>${x.matches} matches, ${x.teams} teams</td></tr>`), ...sel.rejected.map((x) => `<tr><td>${esc(x.season)}</td><td>${badge(x.usedForTraining ? 'training only' : 'rejected', x.usedForTraining ? 'info' : 'bad')}</td><td class="dim">${esc(x.reason)}</td></tr>`)].join('') || '<tr><td colspan="3" class="dim">No seasons found in loaded data.</td></tr>'}</tbody></table></div>${bt && bt.partial ? '<p class="banner warn">Fewer than 5 qualifying seasons are available — the result is flagged PARTIAL.</p>' : ''}`);
    if (!bt) return h + empty(s.finished ? 'Press “Run walk-forward backtest”. Nothing is shown until it has actually been run on your data.' : 'No finished matches loaded — BACKTEST DATA INSUFFICIENT.');
    h += `<p class="dim">Run ${esc(bt.runAt.slice(0, 16).replace('T', ' '))} UTC · dataset fingerprint <code>${esc(bt.datasetFingerprint)}</code> · config <code>${esc(bt.configHash)}</code> · ${bt.nFinished} finished matches loaded${app.backtestStale ? ' · <b class="warn-t">data or settings changed since this run — re-run to refresh</b>' : ''}</p>`;
    if (bt.status !== 'COMPLETE') return h;
    const m = bt.summary.series.model, sm = bt.summary;
    h += `<div class="grid stats">${stat('1X2 accuracy', pct(m.accuracy), `${m.correct}/${m.n} · 95% CI ${pct(m.wilson.lo, 1)}–${pct(m.wilson.hi, 1)}`, m.accuracy >= 0.7 ? 'good' : 'bad')}${stat('Brier score', num(m.brier, 4), 'baseline ' + num(sm.series.baseline.brier, 4))}${stat('Log loss', num(m.logLoss, 4), 'baseline ' + num(sm.series.baseline.logLoss, 4))}${stat('Brier skill vs baseline', pct(sm.brierSkillVsBaseline), sm.brierSkillVsBaseline > 0 ? 'beats baseline' : 'does NOT beat baseline', sm.brierSkillVsBaseline > 0 ? 'good' : 'bad')}${stat('Calibration error (ECE)', pct(sm.ece, 2), 'lower is better')}${stat('Matches scored', sm.nScored, `${sm.seasonsUsed} season(s)`)}</div>`;
    h += card('Model vs benchmarks', benchTable(sm));
    h += card('Confusion matrix', C.confusion(m.confusion, m.perClass) + `<p class="dim">Picks made: 1 = ${m.picks.H}, X = ${m.picks.D}, 2 = ${m.picks.A}. A model that never picks Draw will show 0% Draw accuracy — this is expected for 1X2 argmax decisions.</p>`);
    h += '<div class="grid two">' + card('Performance by season', C.bars(sm.bySeason.map((x) => ({ label: x.season, value: x.accuracy, sub: 'n=' + x.n })), { pct: true, max: 1, refLine: 0.7, refLabel: '70%', title: 'accuracy by season' }) + `<table class="tbl compact"><thead><tr><th>Season</th><th>n</th><th>Acc.</th><th>Brier</th><th>Log loss</th></tr></thead><tbody>${sm.bySeason.map((x) => `<tr><td>${esc(x.season)}</td><td>${x.n}</td><td>${pct(x.accuracy)}</td><td>${num(x.brier, 3)}</td><td>${num(x.logLoss, 3)}</td></tr>`).join('')}</tbody></table>`)
      + card('Accuracy by confidence range', C.bars(sm.confidenceRanges.map((x) => ({ label: x.label, value: x.n ? x.accuracy : null, sub: 'n=' + x.n })), { pct: true, max: 1, title: 'accuracy by pick probability' }) + '<p class="dim">Range = probability assigned to the picked outcome.</p>') + '</div>';
    h += card('Calibration (reliability)', `<div class="grid two"><div>${C.reliability(sm.calibration.bins)}</div><div><p>Points on the diagonal mean predicted probabilities match observed frequencies. Pooled over all three outcomes of every match; point size ∝ sample size.</p><table class="tbl compact"><thead><tr><th>Bin</th><th>n</th><th>Predicted</th><th>Observed</th></tr></thead><tbody>${sm.calibration.bins.filter((b) => b.n).map((b) => `<tr><td>${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%</td><td>${b.n}</td><td>${pct(b.meanPred)}</td><td>${pct(b.obsFreq)}</td></tr>`).join('')}</tbody></table></div></div>`);
    h += card('Audit', `<p>${bt.audit.groups} prediction-day groups, ${bt.audit.checks} chronology checks, <b>${bt.audit.violations}</b> violations. ${bt.audit.skippedWarmup} early matches were skipped as warm-up (fewer than ${bt.config.minTrainMatches} earlier matches). First/last test day: ${esc(bt.audit.firstTestDay)} / ${esc(bt.audit.lastTestDay)}.</p>`);
    return h;
  }
  function BTselect(app) { return NS.backtesting.selectSeasons(app.dm.listMatches(), { seasonsWanted: 5 }); }

  function benchTable(sm) {
    const row = (n, x, strong) => `<tr class="${strong ? 'strong' : ''}"><td>${n}</td><td>${x.n}</td><td>${pct(x.accuracy)}</td><td>${num(x.brier, 4)}</td><td>${num(x.logLoss, 4)}</td></tr>`;
    let h = `<div class="scroll-x"><table class="tbl"><thead><tr><th>Model</th><th>n</th><th>Accuracy</th><th>Brier</th><th>Log loss</th></tr></thead><tbody>
      ${row('Final model (calibrated blend)', sm.series.model, true)}${row('Dixon–Coles component', sm.series.dixonColes)}${row('Elo component', sm.series.elo)}${row('Statistical baseline (training frequencies)', sm.series.baseline)}</tbody></table></div>`;
    if (sm.bookmaker) {
      h += `<h4>Bookmaker comparison (${sm.bookmaker.n} matches with reliable odds, ${pct(sm.bookmaker.coverage, 0)} of scored matches)</h4><div class="scroll-x"><table class="tbl"><thead><tr><th>Model</th><th>n</th><th>Accuracy</th><th>Brier</th><th>Log loss</th></tr></thead><tbody>${row('Bookmaker (margin removed)', sm.bookmaker.bookmaker)}${row('Final model, same matches', sm.bookmaker.modelSameSubset, true)}</tbody></table></div>`;
    } else h += '<p class="dim">Bookmaker comparison unavailable: the loaded data has no reliable odds (decimal odds for 1/X/2 with an overround between 100% and 125%).</p>';
    return h;
  }

  /* ----------------------------------------------------------- performance */
  function performance(app) {
    const bt = app.backtest, hs = app.hist.stats();
    let h = pageHead('Model Performance', 'Measured results only. Nothing on this page is estimated or simulated.');
    h += targetBanner(app);
    if (bt && bt.status === 'COMPLETE') {
      const sm = bt.summary;
      h += card('Backtest — rolling accuracy (chronological)', rolling(bt.records));
      h += card('Backtest — models compared', C.bars([['Final', sm.series.model], ['Dixon–Coles', sm.series.dixonColes], ['Elo', sm.series.elo], ['Baseline', sm.series.baseline]].map(([l, x]) => ({ label: l, value: x.accuracy, sub: 'Brier ' + num(x.brier, 3) })), { pct: true, max: 1, refLine: 0.7, refLabel: '70% target' }));
      h += card('Detail', benchTable(sm));
    } else h += card('Backtest', empty('No completed backtest. Run one in Historical Backtesting.'));
    h += card('Live (saved predictions with entered results)', hs.summary.n ? `<div class="grid stats">${stat('Accuracy', pct(hs.summary.accuracy), `n=${hs.summary.n}`)}${stat('Brier', num(hs.summary.brier, 4))}${stat('Log loss', num(hs.summary.logLoss, 4))}</div>` + C.lines([{ name: 'Accuracy', color: 'var(--c-accent)', points: hs.series.map((p) => ({ y: p.accuracy })) }], { pct: true, min: 0, max: 1, refLine: 0.7, refLabel: '70%' }) + C.confusion(hs.summary.confusion, hs.summary.perClass) + (hs.summary.n < 30 ? '<p class="banner warn">Fewer than 30 evaluated predictions: live accuracy is statistically unreliable.</p>' : '') : empty('No evaluated live predictions yet.'));
    return h;
  }
  function rolling(records, w = 50) {
    if (records.length < w) return '<p class="dim">Fewer than ' + w + ' scored matches.</p>';
    const pts = []; let c = 0;
    records.forEach((r, i) => { c += r.hit ? 1 : 0; if (i >= w) c -= records[i - w].hit ? 1 : 0; if (i >= w - 1) pts.push({ y: c / w }); });
    return C.lines([{ name: `Rolling ${w}-match accuracy`, color: 'var(--c-accent)', points: pts }], { pct: true, min: 0.2, max: 0.9, refLine: 0.7, refLabel: '70% target', xLabel: 'scored matches →' });
  }

  /* --------------------------------------------------------------- history */
  function history(app) {
    const all = app.hist.all();
    let h = pageHead('Prediction History', 'Immutable log of every saved prediction.', `<button class="btn" data-act="export-history-csv">Export CSV</button><button class="btn" data-act="export-history-json">Export JSON</button><label class="btn file">Import JSON<input type="file" accept=".json,application/json" data-import="history"></label>`);
    if (!all.length) return h + empty('No predictions saved yet. Open a scheduled fixture in Match Analysis and press “Save as pre-match prediction”.');
    h += `<div class="scroll-x"><table class="tbl hover"><thead><tr><th>Saved (UTC)</th><th>Match</th><th>Pick</th><th>1</th><th>X</th><th>2</th><th>Confidence</th><th>Timing</th><th>Result</th></tr></thead><tbody>${all.map((p) => { const e = app.hist.state.evaluations.filter((x) => x.predictionId === p.id).slice(-1)[0]; return `<tr data-href="#/analysis/${encodeURIComponent(p.fixtureId)}"><td class="nw">${esc(p.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${esc(p.homeName)} v ${esc(p.awayName)}</td><td><b>${p.symbol}</b></td><td>${pct(p.probs.H)}</td><td>${pct(p.probs.D)}</td><td>${pct(p.probs.A)}</td><td>${esc(p.confidence.label)}</td><td>${badge(p.timing, p.timing === 'pre-match' ? 'ok' : 'bad')}</td><td>${e ? `${e.result.homeGoals}–${e.result.awayGoals} ${badge(e.correct ? '✓' : '✗', e.correct ? 'ok' : 'bad')}` : (app.hist.isDiscarded(p.id) ? badge('Removed from results', 'warn') : '<span class="dim">pending</span>')}</td></tr>`; }).join('')}</tbody></table></div>`;
    return h;
  }

  /* ------------------------------------------------------------ data mgmt */
  function data(app) {
    const s = app.dm.summary(), conf = app.dm.openConflicts(), imp = app.lastImport;
    const lastRefreshAt = app.storage.get('api.matchesLastRefreshAt', 0);
    const lastRefreshLabel = lastRefreshAt ? new Date(Number(lastRefreshAt)).toLocaleString() : 'not yet';
    let h = pageHead('Data Management', 'After a supported provider is configured, fixtures and results refresh automatically when the app opens.');
    h += dataBanner(app);
    h += `<div class="grid stats">${stat('Matches', s.matches, `${s.finished} finished`)}${stat('Teams', s.teams)}${stat('Open conflicts', s.openConflicts, '', s.openConflicts ? 'bad' : '')}${stat('Storage', s.persistent ? 'LocalStorage' : 'memory only', (app.storage.usage() / 1024).toFixed(0) + ' KB used')}</div>`;
    if (imp) h += `<div class="banner ${imp.errors && imp.errors.length ? 'warn' : 'ok'}"><b>${esc(imp.title)}</b> ${esc(imp.text)}${imp.errors && imp.errors.length ? `<details><summary>${imp.errors.length} problem(s)</summary><ul>${imp.errors.slice(0, 60).map((e) => `<li>${e.row ? 'row ' + e.row + ': ' : ''}${e.field ? '<code>' + esc(e.field) + '</code> ' : ''}${esc(e.msg || e)}</li>`).join('')}</ul></details>` : ''}${imp.warnings && imp.warnings.length ? `<details><summary>${imp.warnings.length} warning(s)</summary><ul>${imp.warnings.slice(0, 60).map((e) => `<li>row ${e.row}: ${esc(e.msg)}</li>`).join('')}</ul></details>` : ''}</div>`;
    h += '<div class="grid two">';
    h += card('API provider', `<p class="dim">Provider: <b>${esc(app.settings.api.provider)}</b> via proxy <code>${esc(app.settings.api.baseUrl || 'not configured')}</code>. The app checks for fixture and result updates when the provider is saved, then every 6 hours while the app is open or reopened. FotMob is not connected. The basic football-data plan provides fixtures/results/standings; odds, shots and lineups depend on the provider plan and are imported only when returned. This mapper does not receive xG or injury data from that API. Last successful refresh: ${esc(lastRefreshLabel)}. Configure in <a href="#/settings">Settings</a>.</p>
      <p class="dim">For richer inputs, import a trusted CSV or use a Custom JSON endpoint with <code>oddsH/oddsD/oddsA</code>, <code>homeXg/awayXg</code> and shot fields. Rows are validated: invalid entries are rejected, partial odds are ignored, and missing values stay missing. xG is used only when enabled and the required team history is available. After changing data or engine settings, re-run the walk-forward backtest and compare Brier score and log loss.</p>
      <label>Season start year(s), comma separated<input id="api-seasons" value="${esc(app.settings.api.seasons || '')}" placeholder="2024, 2023, 2022"></label>
      <button class="btn primary" data-act="api-fetch" ${app.settings.api.baseUrl ? '' : 'disabled'}>Fetch matches from API</button> <button class="btn" data-act="api-standings" ${app.settings.api.baseUrl ? '' : 'disabled'}>Fetch standings</button><div id="api-out"></div>`);
    h += '</div>';
    h += card('Add a match manually', `<form id="manual-match" class="form-grid"><label>Date / kickoff (UTC)<input name="date" required placeholder="2026-11-25T20:00:00Z"></label><label>Home team<input name="home" required list="teams-dl"></label><label>Away team<input name="away" required list="teams-dl"></label><label>Stage<input name="stage" placeholder="League Phase"></label><label>Venue<input name="venue"></label><label>Home goals (if played)<input name="homeGoals" type="number" min="0" max="20"></label><label>Away goals (if played)<input name="awayGoals" type="number" min="0" max="20"></label><label>Neutral venue<select name="neutral"><option value="0">No</option><option value="1">Yes</option></select></label><label>Odds 1<input name="oddsH" placeholder="2.10"></label><label>Odds X<input name="oddsD"></label><label>Odds 2<input name="oddsA"></label><label>Home xG<input name="homeXg"></label><label>Away xG<input name="awayXg"></label><div class="full"><button class="btn primary">Validate &amp; add</button></div><datalist id="teams-dl">${app.dm.teams().map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist></form>`);
    if (conf.length) h += card('Conflicts: provider value differs from your manual correction', `<table class="tbl"><thead><tr><th>Match</th><th>Field</th><th>Your value</th><th>Incoming</th><th>Source</th><th></th></tr></thead><tbody>${conf.map((c) => { const m = app.dm.getMatch(c.matchId); return `<tr><td>${m ? esc(m.homeName + ' v ' + m.awayName) : esc(c.matchId)}</td><td>${esc(c.field)}</td><td>${esc(c.manual)}</td><td>${esc(c.incoming)}</td><td>${esc(c.source)}</td><td class="nw"><button class="btn sm" data-act="resolve" data-i="${c.index}" data-choice="keep-manual">Keep mine</button> <button class="btn sm" data-act="resolve" data-i="${c.index}" data-choice="accept-incoming">Use incoming</button></td></tr>`; }).join('')}</tbody></table>`, 'warn-card');
    const recent = app.dm.listMatches().slice(-40).reverse();
    h += card('Edit / correct matches (latest 40; use Fixtures filters to find others)', recent.length ? `<div class="scroll-x"><table class="tbl compact"><thead><tr><th>Date</th><th>Match</th><th>Score</th><th>Manual</th><th></th></tr></thead><tbody>${recent.map((m) => `<tr><td class="nw">${esc(m.date.slice(0, 10))}</td><td>${esc(m.homeName)} v ${esc(m.awayName)}</td><td><form class="inline" data-form="edit-result" data-id="${esc(m.id)}"><input type="number" name="hg" min="0" max="20" value="${m.homeGoals ?? ''}" aria-label="home goals"> <span class="result-dash" aria-hidden="true">–</span> <input type="number" name="ag" min="0" max="20" value="${m.awayGoals ?? ''}" aria-label="away goals"> <button class="btn sm">Set</button></form></td><td>${m.manualFields.length ? badge(m.manualFields.join(', '), 'info') + ` <button class="btn sm" data-act="clear-overrides" data-id="${esc(m.id)}">Revert</button>` : ''}</td><td><button class="btn sm danger" data-act="delete-match" data-id="${esc(m.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nothing to edit yet.'));
    h += card('Team names', s.teams ? `<p class="dim">If the same club appears under two names (e.g. “PSG” and “Paris Saint-Germain”), merge them so history is not split.</p><form class="inline" id="merge-teams"><select name="from">${app.dm.teams().map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select> → <select name="to">${app.dm.teams().map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select> <button class="btn sm">Merge</button></form>` : empty('No teams.'));
    h += card('Dataset completeness', s.finished ? `<div class="scroll-x"><table class="tbl compact"><tbody>${Object.entries(s.completeness.fields).map(([f, v]) => `<tr><td>${esc(f)}</td><td>${v.have}/${s.completeness.n}</td><td><div class="meter"><i style="width:${(v.coverage * 100).toFixed(0)}%"></i></div></td></tr>`).join('')}</tbody></table></div><h4>By season</h4><table class="tbl compact"><tbody>${Object.entries(s.bySeason).sort().map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.finished}/${v.total} finished</td></tr>`).join('')}</tbody></table>` : empty('No finished matches.'));
    h += card('Export / backup', `<button class="btn" data-act="export-matches-csv">Matches CSV</button> <button class="btn" data-act="export-backup">Full backup JSON</button> <label class="btn file">Restore backup<input type="file" accept=".json" data-import="backup"></label> <button class="btn danger" data-act="clear-all">Delete all data…</button>${s.lastImport ? `<p class="dim">Last import: ${esc(s.lastImport.label)} at ${esc(s.lastImport.timestamp.slice(0, 16).replace('T', ' '))} (+${s.lastImport.added} new, ${s.lastImport.updated} updated)</p>` : ''}`);
    return h;
  }

  /* -------------------------------------------------------------- settings */
  function settings(app) {
    const c = app.engineConfig(), api = app.settings.api;
    const n = (path, label, step, hint) => { const v = path.split('.').reduce((o, k) => o[k], c); return `<label>${esc(label)}<input type="number" step="${step}" name="${path}" value="${v}">${hint ? `<small>${esc(hint)}</small>` : ''}</label>`; };
    let h = pageHead('Settings', 'Engine parameters, data provider and display. Changing the engine invalidates the stored backtest (it is flagged until re-run).');
    h += `<div class="grid two">`;
    h += card('Fixed engine configuration', `<table class="tbl compact"><tbody><tr><td>Analysis level</td><td>Advanced</td></tr><tr><td>Theme</td><td>Dark</td></tr><tr><td>Data source</td><td>Hybrid (API + manual)</td></tr><tr><td>Backtest</td><td>5 most recent completed seasons</td></tr><tr><td>Validation</td><td>Walk-forward</td></tr><tr><td>Benchmarks</td><td>Bookmaker + statistical baseline</td></tr><tr><td>Target accuracy</td><td>70% (evaluation goal, not guaranteed)</td></tr><tr><td>Final output</td><td>Exactly one 1X2 selection</td></tr></tbody></table>`);
    h += card('Data provider', `<form id="api-form" class="stack"><label>Provider<select name="provider"><option value="football-data" ${api.provider === 'football-data' ? 'selected' : ''}>football-data.org (via proxy)</option><option value="custom" ${api.provider === 'custom' ? 'selected' : ''}>Custom JSON endpoint</option></select></label>
      <label>Proxy base URL<input name="baseUrl" value="${esc(api.baseUrl)}" placeholder="https://your-proxy.workers.dev"><small>Never paste an API key here. Secret keys must live in a server-side proxy (see <code>proxy/worker.js</code> and README).</small></label>
      <label>Timeout (ms)<input type="number" name="timeoutMs" min="2000" max="60000" value="${api.timeoutMs}"></label><button class="btn primary">Save provider settings</button></form>`);
    h += '</div>';
    h += card('Engine parameters', `<form id="engine-form"><div class="form-grid">
      ${n('elo.k', 'Elo K-factor', 1, '1–100')}${n('elo.homeAdvantage', 'Elo home advantage (points)', 1, '0–200')}${n('elo.initial', 'Elo initial rating', 10)}
      ${n('dc.xi', 'DC time-decay ξ (per day)', 0.0001, '0 = no decay; 0.0019 ≈ 1-year half-life')}${n('dc.priorMatches', 'DC shrinkage (pseudo-matches)', 1, 'regularisation toward league average')}${n('blend.eloWeight', 'Elo weight in blend', 0.05, '0 = DC only, 1 = Elo only; default 0.5')}
      ${n('calibration.minSamples', 'Calibration min. samples', 10, 'calibration stays off below this')}${n('xg.minMatches', 'xG min. matches per team', 1)}${n('xg.maxWeight', 'xG max blend weight', 0.05)}
      ${n('minTrainMatches', 'Min. training matches', 10)}
      <label class="check"><input type="checkbox" name="calibration.enabled" ${c.calibration.enabled ? 'checked' : ''}> Enable calibration</label>
      <label class="check"><input type="checkbox" name="xg.enabled" ${c.xg.enabled ? 'checked' : ''}> Use xG when reliable</label>
      <label class="check"><input type="checkbox" name="squad.enabled" ${c.squad.enabled ? 'checked' : ''}> Apply squad adjustment (UNVALIDATED)</label>
      ${n('squad.replacementDrop', 'Squad: replacement drop', 0.05, 'fraction of a missing player’s share lost')}${n('squad.maxReduction', 'Squad: max reduction per team', 0.05)}</div>
      <button class="btn primary">Save &amp; apply</button> <button class="btn" type="button" data-act="reset-engine">Reset to defaults</button></form>`);
    h += card('About this build', `<p>Pure HTML/CSS/vanilla JS. No server calls except to the proxy you configure. All data stays in this browser (LocalStorage).</p><p class="dim">Engine version ${esc(c.version)} · config hash <code>${esc(NS.statistics.hashString(JSON.stringify(c)))}</code></p>`);
    return h;
  }

  NS.views = { dashboard, fixtures, analysis, results, backtesting: backtestingPage, performance, history, data, settings };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.views;
})(typeof window !== 'undefined' ? window : globalThis);
