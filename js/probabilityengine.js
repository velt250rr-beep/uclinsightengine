/**
 * probabilityengine.js — combines the independent components into one calibrated 1X2 distribution.
 *
 * Components
 *   dc       Dixon–Coles scoreline model (attack/defence/home advantage, time-decayed, regularised)
 *            + optional xG blend + optional squad adjustment (both transparent, toggled in settings)
 *   elo      Elo rating -> Davidson 1X2
 *   baseline empirical H/D/A frequencies of the training set (reference only, never part of the blend)
 *
 * Final raw probabilities = linear opinion pool (1-wElo)*dc + wElo*elo   (equal weights by default: the
 * least-assumption choice when no validated evidence favours one component).
 * Calibrated probabilities = Calibrator(raw). The pick is argmax(calibrated).
 * The scoreline matrix is rescaled region-by-region so it reproduces the final 1X2 exactly.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const S = isNode ? require('./statistics.js') : NS.statistics;
  const P = isNode ? require('./poisson.js') : NS.poisson;
  const DC = isNode ? require('./dixoncoles.js') : NS.dixonColes;
  const Elo = isNode ? require('./elo.js') : NS.elo;

  const DEFAULT_CONFIG = {
    version: '1.0.0',
    maxGoals: 10,
    dc: { xi: 0.0019, priorMatches: 3 },
    elo: { initial: 1500, k: 30, homeAdvantage: 65 },
    blend: { eloWeight: 0.5 },
    calibration: { enabled: true, minSamples: 200, l2: 5 },
    xg: { enabled: true, minMatches: 5, halfWeightMatches: 10, maxWeight: 0.5, profileMatches: 20 },
    squad: { enabled: false, replacementDrop: 0.5, maxReduction: 0.25 },
    minTrainMatches: 60,
  };

  function mergeConfig(user) {
    const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    for (const k of Object.keys(user || {})) {
      if (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && out[k]) Object.assign(out[k], user[k]);
      else out[k] = user[k];
    }
    return out;
  }

  const toTs = (d) => Date.parse(d);

  /** xG profile from each team's most recent training matches carrying xG. */
  function xgProfiles(matches, profileMatches = 0) {
    const acc = {};
    const add = (id, ts, f, a) => { const t = (acc[id] = acc[id] || []); t.push({ ts, f, a }); };
    for (const m of matches) {
      if (typeof m.homeXg === 'number' && typeof m.awayXg === 'number' && isFinite(m.homeXg) && isFinite(m.awayXg)) {
        add(m.homeId, m.ts, m.homeXg, m.awayXg); add(m.awayId, m.ts, m.awayXg, m.homeXg);
      }
    }
    const out = {};
    const limit = Number.isInteger(profileMatches) && profileMatches > 0 ? profileMatches : 0;
    for (const id of Object.keys(acc)) {
      const all = acc[id].sort((a, b) => a.ts - b.ts);
      const rows = limit ? all.slice(-limit) : all;
      out[id] = {
        xgFor: rows.reduce((sum, row) => sum + row.f, 0) / rows.length,
        xgAgainst: rows.reduce((sum, row) => sum + row.a, 0) / rows.length,
        n: rows.length,
      };
    }
    return out;
  }

  class ProbabilityEngine {
    constructor(config) { this.config = mergeConfig(config); }

    /**
     * Fit all components on `trainMatches` (completed matches with homeGoals/awayGoals).
     * The caller is responsible for supplying only matches played before the target kickoff.
     */
    fit(trainMatches, opts = {}) {
      const c = this.config;
      const ms = trainMatches
        .filter((m) => Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals))
        .map((m) => ({ ts: toTs(m.date), homeId: m.homeId, awayId: m.awayId, hg: m.homeGoals, ag: m.awayGoals, neutral: !!m.neutral, homeXg: m.homeXg, awayXg: m.awayXg }))
        .sort((a, b) => a.ts - b.ts);
      const asOf = opts.asOf != null ? opts.asOf : ms.length ? ms[ms.length - 1].ts : Date.now();
      const dc = DC.fit(ms, { xi: c.dc.xi, priorMatches: c.dc.priorMatches, asOf });
      const elo = Elo.fit(ms, { initial: c.elo.initial, k: c.elo.k, homeAdvantage: c.elo.homeAdvantage, seeds: opts.seeds });
      const cnt = { H: 1, D: 1, A: 1 }; // Laplace smoothing
      for (const m of ms) cnt[S.outcomeFromScore(m.hg, m.ag)]++;
      const baseline = S.normalizeProbs(cnt);
      return { dc, elo, baseline, xg: xgProfiles(ms, c.xg.profileMatches), nTrain: ms.length, asOf, config: c };
    }

    /**
     * @param fitted result of fit()
     * @param fx {homeId, awayId, neutral}
     * @param ctx {xg: boolean override, squad: {home:{missing:[{attackShare,defenceShare}]}, away:{...}}}
     * @param calibrator Calibrator | null
     */
    predict(fitted, fx, ctx = {}, calibrator = null) {
      const c = fitted.config;
      const adjustments = [];
      const base = DC.lambdas(fitted.dc, fx.homeId, fx.awayId, !!fx.neutral);
      let lh = base.home, la = base.away;
      const lambdaBase = { home: lh, away: la };

      // --- xG blend (only with reliable data: both teams >= minMatches of xG history) ---
      const xh = fitted.xg[fx.homeId], xa = fitted.xg[fx.awayId];
      if (c.xg.enabled && xh && xa && xh.n >= c.xg.minMatches && xa.n >= c.xg.minMatches) {
        const n = Math.min(xh.n, xa.n);
        const w = Math.min(c.xg.maxWeight, n / (n + c.xg.halfWeightMatches));
        const g = fx.neutral ? 1 : Math.sqrt(fitted.dc.gamma || 1);
        const xlh = ((xh.xgFor + xa.xgAgainst) / 2) * g;
        const xla = ((xa.xgFor + xh.xgAgainst) / 2) / g;
        lh = (1 - w) * lh + w * xlh; la = (1 - w) * la + w * xla;
        adjustments.push({ name: 'xG blend', applied: true, weight: w, reason: `xG history for both teams (${xh.n}/${xa.n} matches); weight n/(n+${c.xg.halfWeightMatches}) capped at ${c.xg.maxWeight}`, home: xlh, away: xla });
      } else {
        adjustments.push({ name: 'xG blend', applied: false, reason: !c.xg.enabled ? 'disabled in settings' : 'insufficient xG history for one or both teams (needs ' + c.xg.minMatches + '+ matches each) — not used' });
      }

      // --- squad adjustment (off by default: not validated by the backtest) ---
      if (c.squad.enabled && ctx.squad) {
        const red = (arr, key) => Math.min(c.squad.maxReduction, (arr || []).reduce((s, p) => s + (+p[key] || 0), 0) * c.squad.replacementDrop);
        const fa = 1 - red(ctx.squad.home && ctx.squad.home.missing, 'attackShare');
        const fb = 1 - red(ctx.squad.away && ctx.squad.away.missing, 'attackShare');
        const da = 1 + red(ctx.squad.home && ctx.squad.home.missing, 'defenceShare');
        const db = 1 + red(ctx.squad.away && ctx.squad.away.missing, 'defenceShare');
        lh = lh * fa * db; la = la * fb * da;
        adjustments.push({ name: 'Squad availability', applied: true, reason: `missing-player shares × replacement drop ${c.squad.replacementDrop}, capped at ${c.squad.maxReduction} per team (UNVALIDATED assumption)`, factors: { homeAttack: fa, awayAttack: fb, homeDefenceLeak: da, awayDefenceLeak: db } });
      } else {
        adjustments.push({ name: 'Squad availability', applied: false, reason: c.squad.enabled ? 'no squad data entered' : 'disabled (default) — shown as context only, not validated by backtest' });
      }

      lh = Math.max(lh, 0.05); la = Math.max(la, 0.05);
      const matrixDC = DC.dcMatrix(lh, la, fitted.dc.rho, c.maxGoals);
      const pDC = P.outcomeProbs(matrixDC);
      const eloPred = Elo.predict(fitted.elo, fx.homeId, fx.awayId, !!fx.neutral);
      const pElo = eloPred.probs;
      const w = c.blend.eloWeight;
      const raw = S.normalizeProbs({ H: (1 - w) * pDC.H + w * pElo.H, D: (1 - w) * pDC.D + w * pElo.D, A: (1 - w) * pDC.A + w * pElo.A });
      const calibrated = S.normalizeProbs(calibrator ? calibrator.apply(raw) : raw);
      const matrix = P.rescaleToOutcomes(matrixDC, calibrated);

      return {
        components: { dc: pDC, elo: pElo, baseline: fitted.baseline },
        raw, calibrated, pick: S.argmaxOutcome(calibrated),
        calibration: calibrator ? { active: calibrator.active, n: calibrator.n, params: calibrator.params } : { active: false, n: 0 },
        lambdas: { base: lambdaBase, final: { home: lh, away: la } },
        expectedGoals: P.expectedGoals(matrix),
        matrix, topScorelines: P.topScorelines(matrix, 10),
        elo: eloPred, dcParams: { rho: fitted.dc.rho, gamma: fitted.dc.gamma, mu: fitted.dc.mu },
        adjustments,
        flags: { unknownHome: base.unknownHome, unknownAway: base.unknownAway, nTrain: fitted.nTrain },
      };
    }
  }

  const api = { DEFAULT_CONFIG, mergeConfig, ProbabilityEngine, xgProfiles };
  NS.probabilityEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
