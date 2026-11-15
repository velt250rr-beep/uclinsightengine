/**
 * analysisengine.js — turns one fixture + the loaded history into the structured analysis
 * (match info, team comparison, probabilities, scorelines, ONE final 1X2 decision, confidence,
 * data quality, validation status). Pure logic; no DOM, no storage.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const S = isNode ? require('./statistics.js') : NS.statistics;
  const PE = isNode ? require('./probabilityengine.js') : NS.probabilityEngine;
  const Cal = isNode ? require('./calibration.js') : NS.calibration;
  const BT = isNode ? require('./backtesting.js') : NS.backtesting;
  const V = isNode ? require('./validation.js') : NS.validation;

  const DAY = 86400000;
  const day = (m) => m.date.slice(0, 10);
  const ts = (m) => Date.parse(m.date);
  const fin = (m) => m.status === 'finished' && Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals);
  const avg = (a) => (a.length ? S.sum(a) / a.length : null);

  /** One team's record from matches strictly before `beforeDay`. Missing stats stay null. */
  function teamProfile(history, teamId, beforeDay, fitted, fixtureTs) {
    const ms = history.filter((m) => fin(m) && day(m) < beforeDay && (m.homeId === teamId || m.awayId === teamId)).sort((a, b) => ts(a) - ts(b));
    const rows = ms.map((m) => {
      const home = m.homeId === teamId;
      const gf = home ? m.homeGoals : m.awayGoals, ga = home ? m.awayGoals : m.homeGoals;
      return {
        id: m.id, date: m.date, season: m.season, home, oppId: home ? m.awayId : m.homeId, oppName: home ? m.awayName : m.homeName, gf, ga,
        res: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
        xgf: home ? m.homeXg : m.awayXg, xga: home ? m.awayXg : m.homeXg,
        shots: home ? m.homeShots : m.awayShots, sot: home ? m.homeSot : m.awaySot, big: home ? m.homeBigChances : m.awayBigChances,
      };
    });
    const split = (arr) => ({
      n: arr.length, w: arr.filter((r) => r.res === 'W').length, d: arr.filter((r) => r.res === 'D').length, l: arr.filter((r) => r.res === 'L').length,
      gf: arr.length ? avg(arr.map((r) => r.gf)) : null, ga: arr.length ? avg(arr.map((r) => r.ga)) : null,
    });
    const present = (arr, k) => arr.map((r) => r[k]).filter((v) => typeof v === 'number');
    const xgRows = rows.filter((r) => typeof r.xgf === 'number' && typeof r.xga === 'number');
    const shotRows = rows.filter((r) => typeof r.shots === 'number');
    const last5 = rows.slice(-5);
    const lastTs = rows.length ? Date.parse(rows[rows.length - 1].date) : null;
    const within = (d) => rows.filter((r) => fixtureTs - Date.parse(r.date) <= d * DAY).length;
    const seasons = {};
    rows.forEach((r) => { const s = (seasons[r.season || '?'] = seasons[r.season || '?'] || { n: 0, pts: 0, gf: 0, ga: 0 }); s.n++; s.pts += r.res === 'W' ? 3 : r.res === 'D' ? 1 : 0; s.gf += r.gf; s.ga += r.ga; });
    const oppElos = fitted ? rows.map((r) => fitted.elo.ratings[r.oppId]).filter((v) => typeof v === 'number') : [];
    const goalsSum = S.sum(shotRows.map((r) => r.gf)), shotsSum = S.sum(shotRows.map((r) => r.shots));
    return {
      teamId, n: rows.length, overall: split(rows), home: split(rows.filter((r) => r.home)), away: split(rows.filter((r) => !r.home)),
      last5: last5.map((r) => ({ res: r.res, score: `${r.gf}-${r.ga}`, opp: r.oppName, home: r.home, date: r.date.slice(0, 10) })),
      formPoints: last5.length ? S.sum(last5.map((r) => (r.res === 'W' ? 3 : r.res === 'D' ? 1 : 0))) : null, formMax: last5.length * 3,
      cleanSheets: rows.length ? rows.filter((r) => r.ga === 0).length : null, failedToScore: rows.length ? rows.filter((r) => r.gf === 0).length : null,
      xg: xgRows.length ? { n: xgRows.length, for: avg(xgRows.map((r) => r.xgf)), against: avg(xgRows.map((r) => r.xga)) } : null,
      shots: shotRows.length ? { n: shotRows.length, perGame: avg(shotRows.map((r) => r.shots)), sotPerGame: present(shotRows, 'sot').length ? avg(present(shotRows, 'sot')) : null, bigPerGame: present(shotRows, 'big').length ? avg(present(shotRows, 'big')) : null, conversion: shotsSum > 0 ? goalsSum / shotsSum : null } : null,
      oppAvgElo: oppElos.length ? avg(oppElos) : null,
      lastMatchDate: rows.length ? rows[rows.length - 1].date.slice(0, 10) : null,
      restDaysLoaded: lastTs ? Math.floor((fixtureTs - lastTs) / DAY) : null,
      matches14dLoaded: within(14), matches30dLoaded: within(30),
      bySeason: Object.entries(seasons).sort().map(([season, s]) => ({ season, n: s.n, ppg: s.pts / s.n, gf: s.gf / s.n, ga: s.ga / s.n })),
    };
  }

  function headToHead(history, homeId, awayId, beforeDay) {
    const ms = history.filter((m) => fin(m) && day(m) < beforeDay && ((m.homeId === homeId && m.awayId === awayId) || (m.homeId === awayId && m.awayId === homeId))).sort((a, b) => ts(a) - ts(b));
    let hw = 0, d = 0, aw = 0, hgf = 0, agf = 0;
    const list = ms.map((m) => {
      const hg = m.homeId === homeId ? m.homeGoals : m.awayGoals, ag = m.homeId === homeId ? m.awayGoals : m.homeGoals;
      hgf += hg; agf += ag; if (hg > ag) hw++; else if (hg === ag) d++; else aw++;
      return { date: day(m), season: m.season, venueHome: m.homeName, score: `${m.homeGoals}-${m.awayGoals}`, home: m.homeName, away: m.awayName };
    });
    return { n: ms.length, homeWins: hw, draws: d, awayWins: aw, homeGoals: hgf, awayGoals: agf, last: list.slice(-5).reverse() };
  }

  /** Documented confidence heuristic (ordinal label, not a probability). See README §Confidence. */
  function computeConfidence({ probs, components, dataScore, validation, flags = {} }) {
    const order = S.sortedOutcomes(probs);
    const sep = probs[order[0]] - probs[order[1]];
    const sepScore = S.clamp(sep / 0.3, 0, 1);
    const tv = 0.5 * S.OUTCOMES.reduce((s, k) => s + Math.abs(components.dc[k] - components.elo[k]), 0);
    const samePick = S.argmaxOutcome(components.dc) === S.argmaxOutcome(components.elo);
    const agreeScore = 0.5 * (samePick ? 1 : 0) + 0.5 * S.clamp(1 - tv / 0.25, 0, 1);
    const valScore = validation.score || 0;
    const score = 0.35 * sepScore + 0.2 * agreeScore + 0.2 * dataScore + 0.25 * valScore;
    let label = score >= 0.65 ? 'High' : score >= 0.4 ? 'Medium' : 'Low';
    const caps = [];
    const cap = (to, why) => { const rank = { Low: 0, Medium: 1, High: 2 }; if (rank[label] > rank[to]) { label = to; caps.push(why); } };
    if (!validation.validated) cap('Medium', 'capped at Medium: the model has not been validated by a backtest that beats the statistical baseline');
    if (dataScore < 0.35) cap('Low', 'capped at Low: data completeness below 35%');
    if (sep < 0.10) cap('Low', 'capped at Low: top two outcomes are within 10 percentage points');
    else if (sep < 0.20) cap('Medium', 'capped at Medium: top two outcomes are within 20 percentage points');
    if (dataScore < 0.5) cap('Medium', 'capped at Medium: data completeness below 50% (only results are loaded; no odds, xG, injuries or lineups)');
    if (flags.minMatches !== undefined && flags.minMatches < 8) cap('Medium', 'capped at Medium: a team has fewer than 8 matches in the loaded history');
    if (flags.unknownHome || flags.unknownAway) cap('Low', 'capped at Low: a team has no history in the loaded data');
    return {
      label, score, caps,
      parts: {
        separation: { value: sep, score: sepScore, weight: 0.35, note: `${(probs[order[0]] * 100).toFixed(1)}% vs ${(probs[order[1]] * 100).toFixed(1)}%` },
        agreement: { value: tv, score: agreeScore, weight: 0.2, note: samePick ? 'Dixon–Coles and Elo pick the same outcome' : 'Dixon–Coles and Elo DISAGREE on the pick', samePick },
        dataCompleteness: { value: dataScore, score: dataScore, weight: 0.2 },
        validation: { value: valScore, score: valScore, weight: 0.25, note: 'Brier skill vs baseline and calibration error from the backtest (0 if none)' },
      },
    };
  }

  const ago = (iso, now) => { const d = (Date.parse(now) - Date.parse(iso)) / DAY; return isNaN(d) ? null : d; };

  function buildDataQuality({ match, hp, ap, pr, cfg, fields, meta, h2h, now, nTrain }) {
    const items = [];
    const mk = (key, label, value, source, timestamp, status, note, weightKey) => items.push({ key, label, value, source: source || '—', timestamp: timestamp || null, status, note: note || '', weightKey });
    const sources = (meta && meta.history && meta.history.sources && meta.history.sources.join(', ')) || 'loaded history';
    const hts = meta && meta.history ? meta.history.timestamp : null;
    const histStatus = (n) => (n >= 8 ? 'ok' : n >= 3 ? 'partial' : 'missing');
    mk('history_home', `${match.homeName} — matches in loaded history`, `${hp.n}`, sources, hts, histStatus(hp.n), hp.n < 3 ? 'Strength regresses to league average (heavy shrinkage).' : '', 'history');
    mk('history_away', `${match.awayName} — matches in loaded history`, `${ap.n}`, sources, hts, histStatus(ap.n), ap.n < 3 ? 'Strength regresses to league average (heavy shrinkage).' : '', 'history');
    mk('train_total', 'Training matches used', `${nTrain}`, sources, hts, nTrain >= cfg.minTrainMatches ? 'ok' : nTrain > 0 ? 'partial' : 'missing', `Only matches before ${day(match)} were used.`, 'trainsize');
    mk('elo', 'Elo ratings', `${pr.elo.homeRating.toFixed(0)} vs ${pr.elo.awayRating.toFixed(0)}`, 'derived from loaded results', hts, hp.n >= 5 && ap.n >= 5 ? 'ok' : 'partial', 'Computed from UCL results only (no domestic-league information).', 'elo');
    const xgOk = hp.xg && ap.xg && hp.xg.n >= cfg.xg.minMatches && ap.xg.n >= cfg.xg.minMatches;
    mk('xg', 'xG / xGA history', hp.xg || ap.xg ? `${hp.xg ? hp.xg.n : 0} / ${ap.xg ? ap.xg.n : 0} matches` : 'not available', sources, hts, xgOk ? 'ok' : hp.xg || ap.xg ? 'partial' : 'missing', xgOk ? 'Used in the xG blend.' : 'Not used — below the minimum of ' + cfg.xg.minMatches + ' matches per team.', 'xg');
    const shotsOk = hp.shots && ap.shots;
    mk('shots', 'Shots / shots on target / big chances', shotsOk ? `${hp.shots.n} / ${ap.shots.n} matches` : 'not available', sources, hts, shotsOk ? 'ok' : hp.shots || ap.shots ? 'partial' : 'missing', 'Displayed for comparison; not a direct model input.', 'shots');

    const ctxItem = (key, label, present, value, note, weightKey) => {
      const m = meta && meta.context && meta.context[key];
      let status = present ? 'manual' : 'missing';
      if (present && m && m.timestamp && ago(m.timestamp, now) > 7) status = 'stale';
      mk(key, label, present ? value : 'not entered', present ? (m && m.source) || 'manual' : '—', m && m.timestamp, status, present ? (status === 'stale' ? 'Entered more than 7 days ago — re-check.' : note) : 'Enter in Match Analysis → Squad & context.', weightKey);
    };
    const inj = (side) => fields[side + 'Injuries'], sus = (side) => fields[side + 'Suspensions'];
    ctxItem('injuries', 'Injuries', Array.isArray(inj('home')) || Array.isArray(inj('away')), `${(inj('home') || []).length} home / ${(inj('away') || []).length} away`, 'User-entered.', 'squad');
    ctxItem('suspensions', 'Suspensions', Array.isArray(sus('home')) || Array.isArray(sus('away')), `${(sus('home') || []).length} home / ${(sus('away') || []).length} away`, 'User-entered.', 'squad');
    const lu = (s) => fields[s + 'Lineup'] && fields[s + 'Lineup'].status;
    ctxItem('lineup', 'Starting XI', !!(lu('home') || lu('away')), `home: ${lu('home') || 'unknown'}, away: ${lu('away') || 'unknown'}`, (lu('home') === 'confirmed' && lu('away') === 'confirmed') ? 'Both confirmed.' : 'Expected lineups are not confirmed.', 'squad');
    ctxItem('formation', 'Tactical formations', !!(fields.homeFormation || fields.awayFormation), `${fields.homeFormation || '—'} vs ${fields.awayFormation || '—'}`, 'User-entered.', 'tactics');
    const restManual = fields.homeRestDays !== undefined && fields.homeRestDays !== null && fields.homeRestDays !== '' && fields.awayRestDays !== undefined && fields.awayRestDays !== null && fields.awayRestDays !== '';
    mk('rest', 'Rest days', restManual ? `${fields.homeRestDays} / ${fields.awayRestDays}` : hp.restDaysLoaded !== null && ap.restDaysLoaded !== null ? `${hp.restDaysLoaded} / ${ap.restDaysLoaded} (UCL matches only)` : 'not available', restManual ? 'manual' : 'derived from loaded results', hts, restManual ? 'manual' : hp.restDaysLoaded !== null && ap.restDaysLoaded !== null ? 'partial' : 'missing', restManual ? '' : 'Domestic matches are unknown to the loaded data — enter the real value for accuracy.', 'schedule');
    const congManual = fields.homeMatches14d !== undefined && fields.homeMatches14d !== null && fields.homeMatches14d !== '';
    mk('congestion', 'Fixture congestion (matches in last 14 days)', congManual ? `${fields.homeMatches14d} / ${fields.awayMatches14d ?? '—'}` : `${hp.matches14dLoaded} / ${ap.matches14dLoaded} (UCL only)`, congManual ? 'manual' : 'derived from loaded results', hts, congManual ? 'manual' : 'partial', congManual ? '' : 'Counts UCL matches only.', 'schedule');
    mk('h2h', 'Head-to-head sample', `${h2h.n} match(es)`, sources, hts, h2h.n >= 3 ? 'ok' : h2h.n ? 'partial' : 'missing', 'Context only — not a direct model input.', 'h2h');

    const W = { history: 0.4, trainsize: 0.05, elo: 0.05, xg: 0.15, shots: 0.05, squad: 0.15, tactics: 0.02, schedule: 0.08, h2h: 0.05 };
    const val = { ok: 1, manual: 1, partial: 0.5, stale: 0.5, missing: 0 };
    const groups = {};
    items.forEach((it) => { (groups[it.weightKey] = groups[it.weightKey] || []).push(val[it.status]); });
    let score = 0, tw = 0;
    for (const [k, w] of Object.entries(W)) { if (groups[k]) { score += w * avg(groups[k]); tw += w; } }
    score = tw ? score / tw : 0;
    const status = score >= 0.75 ? 'GOOD' : score >= 0.5 ? 'FAIR' : 'LIMITED';
    return { score, status, items, missing: items.filter((i) => i.status === 'missing').map((i) => i.label) };
  }

  /**
   * @param p {match, matches (all effective), config, backtest (stored result|null), context ({fields, meta}), meta, now, seeds}
   */
  function analyzeFixture(p) {
    const now = p.now || new Date().toISOString();
    const match = p.match;
    const engine = new PE.ProbabilityEngine(p.config);
    const cfg = engine.config;
    const fixtureDay = day(match), fixtureTs = ts(match);
    const train = p.matches.filter((m) => fin(m) && day(m) < fixtureDay && m.id !== match.id);
    BT.assertNoLeakage(train, fixtureDay);
    const fitted = engine.fit(train, { asOf: fixtureTs, seeds: p.seeds });

    // calibrator from walk-forward out-of-sample predictions — only when the backtest used this exact configuration
    let calibrator = new Cal.Calibrator(cfg.calibration);
    const bt = p.backtest && p.backtest.status === 'COMPLETE' ? p.backtest : null;
    const sameConfig = !!bt && bt.configHash === S.hashString(JSON.stringify(cfg));
    if (bt && sameConfig) calibrator.fit(bt.records.map((r) => ({ p: r.raw, outcome: r.outcome })));
    const fields = (p.context && p.context.fields) || {};
    const squad = {
      home: { missing: (fields.homeInjuries || []).concat(fields.homeSuspensions || []).filter((x) => x && x.name) },
      away: { missing: (fields.awayInjuries || []).concat(fields.awaySuspensions || []).filter((x) => x && x.name) },
    };
    const pr = engine.predict(fitted, { homeId: match.homeId, awayId: match.awayId, neutral: !!match.neutral }, { squad }, calibrator);

    const hp = teamProfile(p.matches, match.homeId, fixtureDay, fitted, fixtureTs);
    const ap = teamProfile(p.matches, match.awayId, fixtureDay, fitted, fixtureTs);
    const h2h = headToHead(p.matches, match.homeId, match.awayId, fixtureDay);

    const dq = buildDataQuality({ match, hp, ap, pr, cfg, fields, meta: { ...(p.meta || {}), context: (p.context && p.context.meta) || {} }, h2h, now, nTrain: fitted.nTrain });
    const validation = BT.validationFromBacktest(bt);
    if (bt && !sameConfig) { validation.status = 'NOT VALIDATED — the stored backtest used a different configuration; re-run it. (' + validation.status + ')'; validation.validated = false; validation.score = 0; }
    if (cfg.squad.enabled) { validation.status = 'NOT VALIDATED — walk-forward backtesting does not include match-specific squad context; the squad adjustment remains an unvalidated assumption.'; validation.validated = false; validation.score = 0; }
    const confidence = computeConfidence({ probs: pr.calibrated, components: pr.components, dataScore: dq.score, validation, flags: { ...pr.flags, minMatches: Math.min(hp.n, ap.n) } });

    const pick = pr.pick, symbol = S.SYMBOL[pick];
    const pickLabel = pick === 'H' ? `${match.homeName} win` : pick === 'A' ? `${match.awayName} win` : 'Draw';
    const eg = pr.expectedGoals, order = S.sortedOutcomes(pr.calibrated);
    const dcA = fitted.dc.attack, dcD = fitted.dc.defence;
    const evidence = [
      `Calibrated 1X2: ${match.homeName} ${(pr.calibrated.H * 100).toFixed(1)}% · Draw ${(pr.calibrated.D * 100).toFixed(1)}% · ${match.awayName} ${(pr.calibrated.A * 100).toFixed(1)}%. The pick is the highest of the three.`,
      `Expected goals ${eg.home.toFixed(2)} – ${eg.away.toFixed(2)} (Dixon–Coles λ ${pr.lambdas.final.home.toFixed(2)} / ${pr.lambdas.final.away.toFixed(2)}, ρ = ${pr.dcParams.rho.toFixed(3)}).`,
      `Elo ${pr.elo.homeRating.toFixed(0)} vs ${pr.elo.awayRating.toFixed(0)} (${match.neutral ? 'neutral venue' : '+' + fitted.elo.opts.homeAdvantage + ' home advantage'}); Elo-only model gives ${(pr.components.elo.H * 100).toFixed(0)}/${(pr.components.elo.D * 100).toFixed(0)}/${(pr.components.elo.A * 100).toFixed(0)}.`,
      `Dixon–Coles alone gives ${(pr.components.dc.H * 100).toFixed(0)}/${(pr.components.dc.D * 100).toFixed(0)}/${(pr.components.dc.A * 100).toFixed(0)}; components ${confidence.parts.agreement.samePick ? 'agree' : 'disagree'} on the top outcome.`,
    ];
    const factors = [];
    if (!match.neutral) factors.push({ name: 'Home advantage', detail: `fitted home-goal multiplier γ = ${fitted.dc.gamma.toFixed(2)} (+${fitted.elo.opts.homeAdvantage} Elo)` });
    factors.push({ name: 'Team strength', detail: `attack index ${(dcA[match.homeId] ?? 1).toFixed(2)} vs ${(dcA[match.awayId] ?? 1).toFixed(2)}; defence index ${(dcD[match.homeId] ?? 1).toFixed(2)} vs ${(dcD[match.awayId] ?? 1).toFixed(2)} (1.00 = average, lower defence = better)` });
    factors.push({ name: 'Rating gap', detail: `Elo difference ${(pr.elo.homeRating - pr.elo.awayRating).toFixed(0)} before home advantage` });
    pr.adjustments.forEach((a) => factors.push({ name: a.name, detail: (a.applied ? 'applied — ' : 'not applied — ') + a.reason }));
    factors.push({ name: 'Calibration', detail: pr.calibration.active ? `active (fitted on ${pr.calibration.n} out-of-sample backtest predictions)` : 'inactive — raw model probabilities shown (no validated calibration data yet)' });

    return {
      match: { id: match.id, home: match.homeName, away: match.awayName, homeId: match.homeId, awayId: match.awayId, competition: 'UEFA Champions League', date: match.date.slice(0, 10), kickoff: /T\d{2}:\d{2}/.test(match.date) ? match.date.slice(11, 16) + ' UTC' : null, venue: match.venue || null, neutral: !!match.neutral, stage: match.stage || null, season: match.season, status: match.status },
      retrospective: match.status === 'finished',
      nTrain: fitted.nTrain, configVersion: cfg.version, configHash: S.hashString(JSON.stringify(cfg)), config: cfg,
      teams: {
        home: { name: match.homeName, profile: hp, elo: pr.elo.homeRating, attack: dcA[match.homeId] ?? null, defence: dcD[match.homeId] ?? null, formation: fields.homeFormation || null, injuries: fields.homeInjuries || null, suspensions: fields.homeSuspensions || null, lineup: fields.homeLineup || null },
        away: { name: match.awayName, profile: ap, elo: pr.elo.awayRating, attack: dcA[match.awayId] ?? null, defence: dcD[match.awayId] ?? null, formation: fields.awayFormation || null, injuries: fields.awayInjuries || null, suspensions: fields.awaySuspensions || null, lineup: fields.awayLineup || null },
      },
      h2h,
      final: {
        pick, symbol, label: pickLabel, probs: pr.calibrated, rawProbs: pr.raw, components: pr.components,
        percentages: S.roundPercentagesToSum([pr.calibrated.H, pr.calibrated.D, pr.calibrated.A], 1),
        runnerUp: order[1], confidence, expectedGoals: eg, topScorelines: pr.topScorelines, mostLikely: pr.topScorelines[0],
        calibrationActive: pr.calibration.active, evidence, factors,
      },
      matrix: pr.matrix, adjustments: pr.adjustments, lambdas: pr.lambdas, dcParams: pr.dcParams,
      dataQuality: dq, validation,
      bookmaker: V.reliableOdds(match) ? { probs: V.normalizedOddsProbs(match), odds: { H: match.oddsH, D: match.oddsD, A: match.oddsA }, overround: 1 / match.oddsH + 1 / match.oddsD + 1 / match.oddsA } : null,
      generatedAt: now,
    };
  }

  const api = { teamProfile, headToHead, computeConfidence, buildDataQuality, analyzeFixture };
  NS.analysisEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
