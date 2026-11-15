/**
 * backtesting.js — walk-forward backtest with explicit leakage controls.
 *
 * Protocol (per kickoff DAY, chronologically):
 *   1. Training set = every completed match with date strictly BEFORE that day (same-day matches are never
 *      used to predict each other).
 *   2. The model is re-fitted from scratch on that training set (stateless => no hidden carry-over).
 *   3. The calibrator is fitted ONLY on the out-of-sample predictions already made for earlier days.
 *   4. Each match of the day is predicted from a stripped "pre-match view" (teams, date, venue flag, stage) —
 *      scores, odds, xG and stats of the match being predicted are not visible to the model.
 *   5. Predictions are stored, then compared with the actual results; the loop moves to the next day.
 * An audit counter verifies (and throws on violation) that max(training date) < prediction day for every group.
 *
 * Bookmaker benchmark: proportional-normalised implied probabilities, only for matches with reliable odds,
 * and the model is re-scored on exactly that same subset for a like-for-like comparison.
 * Baseline: empirical H/D/A frequencies of the training set.
 * Nothing is simulated or invented: if the loaded data cannot support a backtest, the result is
 * 'BACKTEST DATA INSUFFICIENT'.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const S = isNode ? require('./statistics.js') : NS.statistics;
  const V = isNode ? require('./validation.js') : NS.validation;
  const Cal = isNode ? require('./calibration.js') : NS.calibration;
  const PE = isNode ? require('./probabilityengine.js') : NS.probabilityEngine;

  const INSUFFICIENT = 'BACKTEST DATA INSUFFICIENT';
  const TARGET = 0.7;
  const day = (m) => m.date.slice(0, 10);
  const ts = (m) => Date.parse(m.date);
  const isFinished = (m) => m.status === 'finished' && Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals);

  /** Only these fields reach the model when predicting a historical match. */
  function preMatchView(m) {
    return Object.freeze({ id: m.id, date: m.date, homeId: m.homeId, awayId: m.awayId, neutral: !!m.neutral, stage: m.stage || null, season: m.season || null });
  }

  /** Throws if any training match is not strictly earlier (by UTC day) than the prediction day. */
  function assertNoLeakage(train, predictionDay) {
    for (const m of train) if (day(m) >= predictionDay) throw new Error(`LEAKAGE: training match ${m.id} (${day(m)}) is not before ${predictionDay}`);
    return true;
  }

  /**
   * Choose the most recent completed seasons with sufficiently complete, comparable data.
   * A season qualifies when: it ended before `today`, every non-postponed match has a result, it has at least
   * `minMatchesPerSeason` finished matches and `minTeams` distinct teams.
   */
  function selectSeasons(matches, { today = new Date(), seasonsWanted = 5, minMatchesPerSeason = 100, minTeams = 16 } = {}) {
    const by = {};
    for (const m of matches) { if (m.season) (by[m.season] = by[m.season] || []).push(m); }
    const qualifying = [], rejected = [];
    for (const [season, ms] of Object.entries(by).sort()) {
      const live = ms.filter((m) => m.status !== 'postponed');
      const fin = live.filter(isFinished);
      const teams = new Set(fin.flatMap((m) => [m.homeId, m.awayId]));
      const last = live.reduce((mx, m) => Math.max(mx, ts(m)), 0);
      let why = null;
      if (fin.length < live.length) why = `${live.length - fin.length} match(es) without a result — season not complete`;
      else if (last >= today.getTime()) why = 'season has not finished yet';
      else if (fin.length < minMatchesPerSeason) why = `only ${fin.length} matches (minimum ${minMatchesPerSeason})`;
      else if (teams.size < minTeams) why = `only ${teams.size} teams (minimum ${minTeams})`;
      if (why) rejected.push({ season, reason: why, matches: ms.length }); else qualifying.push({ season, matches: fin.length, teams: teams.size });
    }
    const chosen = qualifying.slice(-seasonsWanted);
    qualifying.slice(0, Math.max(0, qualifying.length - seasonsWanted)).forEach((q) => rejected.push({ season: q.season, reason: `older than the ${seasonsWanted} most recent qualifying seasons (used only as training history)`, matches: q.matches, usedForTraining: true }));
    return { seasons: chosen, rejected };
  }

  function datasetFingerprint(matches) {
    return S.hashString(matches.map((m) => `${m.id}|${m.date}|${m.homeId}|${m.awayId}|${m.homeGoals}-${m.awayGoals}`).join(';'));
  }

  /**
   * @param allMatches effective match records (finished + scheduled)
   * @param opts {config, seasonsWanted, minMatchesPerSeason, minTeams, minScored, today, onProgress, yieldFn, calibRefitEvery}
   */
  async function walkForward(allMatches, opts = {}) {
    const o = Object.assign({ seasonsWanted: 5, minMatchesPerSeason: 100, minTeams: 16, minScored: 100, today: new Date(), calibRefitEvery: 25 }, opts);
    const engine = new PE.ProbabilityEngine(o.config);
    const cfg = engine.config;
    const finished = allMatches.filter(isFinished).sort((a, b) => ts(a) - ts(b) || a.id.localeCompare(b.id));
    const sel = selectSeasons(allMatches, o);
    const base = { configHash: S.hashString(JSON.stringify(cfg)), config: cfg, datasetFingerprint: datasetFingerprint(finished), nFinished: finished.length, seasonSelection: sel, runAt: new Date().toISOString(), target: TARGET, protocol: { seasonsWanted: o.seasonsWanted, minMatchesPerSeason: o.minMatchesPerSeason, minTeams: o.minTeams } };

    if (!sel.seasons.length) return { ...base, status: INSUFFICIENT, reason: finished.length ? 'No completed season meets the completeness criteria (see rejected seasons).' : 'No completed matches are loaded.', records: [] };

    const chosen = new Set(sel.seasons.map((s) => s.season));
    const test = finished.filter((m) => chosen.has(m.season));
    const days = [...new Set(test.map(day))].sort();
    const records = [];
    const audit = { groups: 0, checks: 0, violations: 0, skippedWarmup: 0, firstTestDay: days[0], lastTestDay: days[days.length - 1] };
    let calibrator = new Cal.Calibrator(cfg.calibration), calFitN = 0, trainEnd = 0;

    for (let di = 0; di < days.length; di++) {
      const d = days[di];
      while (trainEnd < finished.length && day(finished[trainEnd]) < d) trainEnd++;
      const train = finished.slice(0, trainEnd);
      const todays = test.filter((m) => day(m) === d);
      audit.groups++;
      audit.checks++;
      try { assertNoLeakage(train, d); } catch (e) { audit.violations++; throw e; }
      if (train.length < cfg.minTrainMatches) { audit.skippedWarmup += todays.length; continue; }

      const fitted = engine.fit(train, { asOf: Date.parse(d) });
      if (records.length - calFitN >= o.calibRefitEvery || (calFitN === 0 && records.length >= cfg.calibration.minSamples)) {
        calibrator = new Cal.Calibrator(cfg.calibration).fit(records.map((r) => ({ p: r.raw, outcome: r.outcome })));
        calFitN = records.length;
      }
      const dayRecords = [];
      for (const m of todays) {
        const view = preMatchView(m);
        const pr = engine.predict(fitted, view, {}, calibrator);
        const outcome = S.outcomeFromScore(m.homeGoals, m.awayGoals);
        const rec = {
          id: m.id, season: m.season, date: m.date, stage: m.stage, homeId: m.homeId, awayId: m.awayId, outcome, score: `${m.homeGoals}-${m.awayGoals}`,
          p: pr.calibrated, raw: pr.raw, comp: { dc: pr.components.dc, elo: pr.components.elo, baseline: pr.components.baseline },
          pick: pr.pick, hit: pr.pick === outcome, calibrated: pr.calibration.active, nTrain: fitted.nTrain,
          xgUsed: !!(pr.adjustments.find((a) => a.name === 'xG blend') || {}).applied,
          book: V.reliableOdds(m) ? V.normalizedOddsProbs(m) : null,
        };
        dayRecords.push(rec);
      }
      records.push(...dayRecords); // appended only AFTER the whole day is predicted
      if (o.onProgress) o.onProgress({ done: di + 1, total: days.length, day: d });
      if (o.yieldFn && di % 2 === 1) await o.yieldFn();
    }

    if (records.length < o.minScored) {
      return { ...base, status: INSUFFICIENT, reason: `Only ${records.length} matches could be scored (minimum ${o.minScored}); ${audit.skippedWarmup} were warm-up matches with fewer than ${cfg.minTrainMatches} earlier matches available.`, records, audit };
    }
    return { ...base, status: 'COMPLETE', partial: sel.seasons.length < o.seasonsWanted, records, audit, summary: summarizeBacktest(records, o.seasonsWanted, sel.seasons.length) };
  }

  function summarizeBacktest(records, seasonsWanted, seasonsUsed) {
    const R = (f) => records.map((r) => ({ p: f(r), outcome: r.outcome }));
    const model = S.summarize(R((r) => r.p));
    const series = {
      model,
      dixonColes: S.summarize(R((r) => r.comp.dc)),
      elo: S.summarize(R((r) => r.comp.elo)),
      baseline: S.summarize(R((r) => r.comp.baseline)),
    };
    const withBook = records.filter((r) => r.book);
    const bookmaker = withBook.length ? {
      n: withBook.length, coverage: withBook.length / records.length,
      bookmaker: S.summarize(withBook.map((r) => ({ p: r.book, outcome: r.outcome }))),
      modelSameSubset: S.summarize(withBook.map((r) => ({ p: r.p, outcome: r.outcome }))),
    } : null;
    const seasons = [...new Set(records.map((r) => r.season))].sort();
    const bySeason = seasons.map((s) => ({ season: s, ...S.summarize(R((r) => r.p).filter((_, i) => records[i].season === s)) }));
    const cal = S.calibrationBins(R((r) => r.p), 10);
    const conf = S.confidenceRanges(R((r) => r.p));
    const bss = 1 - series.model.brier / series.baseline.brier;
    const target = {
      target: TARGET, accuracy: model.accuracy, wilson: model.wilson, met: model.accuracy >= TARGET,
      message: model.accuracy >= TARGET
        ? `TARGET MET on this backtest: ${(model.accuracy * 100).toFixed(1)}% vs ${TARGET * 100}% (95% CI ${(model.wilson.lo * 100).toFixed(1)}–${(model.wilson.hi * 100).toFixed(1)}%).`
        : `TARGET NOT MET: measured ${(model.accuracy * 100).toFixed(1)}% (95% CI ${(model.wilson.lo * 100).toFixed(1)}–${(model.wilson.hi * 100).toFixed(1)}%) vs ${TARGET * 100}% target.`,
    };
    return { series, bookmaker, bySeason, calibration: cal, confidenceRanges: conf, brierSkillVsBaseline: bss, ece: cal.ece, target, seasonsUsed, seasonsWanted, nScored: records.length };
  }

  /** Compact validation status consumed by the confidence system and shown next to every prediction. */
  function validationFromBacktest(bt) {
    if (!bt) return { status: 'NOT VALIDATED — no backtest has been run', validated: false, score: 0 };
    if (bt.status !== 'COMPLETE') return { status: `NOT VALIDATED — ${INSUFFICIENT}`, validated: false, score: 0, reason: bt.reason };
    const s = bt.summary, bss = s.brierSkillVsBaseline;
    const parts = [`${(s.series.model.accuracy * 100).toFixed(1)}% accuracy over ${s.nScored} matches / ${s.seasonsUsed} season(s)`, `Brier skill vs baseline ${(bss * 100).toFixed(1)}%`];
    let status;
    if (s.nScored < 100) status = 'WEAK VALIDATION — small sample';
    else if (bss <= 0) status = 'FAILED VALIDATION — does not beat the statistical baseline';
    else status = bt.partial ? 'PARTIALLY VALIDATED — fewer than the requested seasons' : 'VALIDATED';
    const score = s.nScored < 100 || bss <= 0 ? 0 : 0.6 * Math.min(1, Math.max(0, bss / 0.05)) + 0.4 * Math.min(1, Math.max(0, 1 - s.ece / 0.1));
    return { status: `${status} (${parts.join('; ')}; target ${s.target.met ? 'met' : 'NOT met'})`, validated: bss > 0 && s.nScored >= 100, score, bss, ece: s.ece, accuracy: s.series.model.accuracy, n: s.nScored, targetMet: s.target.met, runAt: bt.runAt, configHash: bt.configHash };
  }

  /** Strip heavy per-match arrays for storage (kept compact so LocalStorage stays within quota). */
  function compactForStorage(bt) {
    if (!bt) return bt;
    const c = { ...bt, records: (bt.records || []).map((r) => ({ id: r.id, season: r.season, date: r.date, outcome: r.outcome, score: r.score, p: round3(r.p), raw: round3(r.raw), pick: r.pick, hit: r.hit, hid: r.homeId, aid: r.awayId, comp: { dc: round3(r.comp.dc), elo: round3(r.comp.elo), baseline: round3(r.comp.baseline) }, book: r.book ? round3(r.book) : null })) };
    return c;
  }
  const round3 = (p) => ({ H: Math.round(p.H * 1e5) / 1e5, D: Math.round(p.D * 1e5) / 1e5, A: Math.round(p.A * 1e5) / 1e5 });

  const api = { INSUFFICIENT, TARGET, preMatchView, assertNoLeakage, selectSeasons, datasetFingerprint, walkForward, summarizeBacktest, validationFromBacktest, compactForStorage };
  NS.backtesting = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
