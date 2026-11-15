/**
 * dixoncoles.js — Dixon–Coles (1997) low-score correction and a regularised, time-decayed
 * attack/defence/home-advantage fit.
 *
 * Model:  lambda_home = mu * attack[h] * defence[a] * gamma     (gamma omitted at neutral venues)
 *         lambda_away = mu * attack[a] * defence[h]
 * Scores are Poisson(lambda) with tau(x,y) correcting the (0,0),(0,1),(1,0),(1,1) cells.
 *
 * Fitting (documented choices):
 *  - Match weights w = exp(-xi * daysAgo): older matches count less (default half-life ~365 days).
 *  - priorMatches (kappa): each team gets kappa pseudo-matches at league-average strength. UCL data is a
 *    sparse graph (teams appear irregularly), so unregularised MLE is unstable; this is a gamma-prior style
 *    shrinkage toward 1 (see README).
 *  - Team strengths are re-centred to mean 1 each iteration for identifiability.
 *  - rho is chosen by maximum weighted likelihood on a grid, subject to tau > 0 everywhere.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const P = typeof require === 'function' && typeof module !== 'undefined' ? require('./poisson.js') : NS.poisson;

  const DAY = 86400000;

  function tau(x, y, lh, la, rho) {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  }

  /** Range of rho for which every tau is strictly positive. */
  function rhoBounds(lh, la) {
    const lo = Math.max(-1 / Math.max(lh, 1e-9), -1 / Math.max(la, 1e-9));
    const hi = Math.min(1 / Math.max(lh * la, 1e-9), 1);
    return { lo: lo + 1e-6, hi: hi - 1e-6 };
  }

  /** Apply the DC correction to an independent-Poisson matrix. Total mass is preserved analytically; renormalised for truncation. */
  function applyAdjustment(matrix, lh, la, rho) {
    const b = rhoBounds(lh, la);
    const r = Math.min(b.hi, Math.max(b.lo, rho));
    const m = matrix.map((row) => row.slice());
    for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) m[x][y] *= tau(x, y, lh, la, r);
    return P.normalizeMatrix(m);
  }

  function dcMatrix(lh, la, rho, maxGoals = 10) {
    return applyAdjustment(P.scoreMatrix(lh, la, maxGoals), lh, la, rho);
  }

  /**
   * @param matches [{ts, homeId, awayId, hg, ag, neutral}]  completed matches only
   * @param opts {xi, priorMatches, maxIter, tol, asOf}
   */
  function fit(matches, opts = {}) {
    const o = Object.assign({ xi: 0.0019, priorMatches: 3, maxIter: 400, tol: 1e-8 }, opts);
    const n = matches.length;
    if (!n) return { empty: true, attack: {}, defence: {}, gamma: 1, mu: 1.4, rho: 0, nMatches: 0, effectiveN: 0, iterations: 0, converged: true, matchCounts: {} };

    const asOf = o.asOf != null ? o.asOf : Math.max(...matches.map((m) => m.ts));
    const ids = [...new Set(matches.flatMap((m) => [m.homeId, m.awayId]))];
    const idx = Object.fromEntries(ids.map((id, i) => [id, i]));
    const T = ids.length;
    const M = matches.map((m) => ({
      h: idx[m.homeId], a: idx[m.awayId], hg: m.hg, ag: m.ag,
      w: Math.exp(-o.xi * Math.max(0, (asOf - m.ts) / DAY)),
      home: m.neutral ? 0 : 1,
    }));
    const effectiveN = M.reduce((s, m) => s + m.w, 0);
    const matchCounts = {};
    for (const m of matches) { matchCounts[m.homeId] = (matchCounts[m.homeId] || 0) + 1; matchCounts[m.awayId] = (matchCounts[m.awayId] || 0) + 1; }

    let att = new Array(T).fill(1), def = new Array(T).fill(1);
    let gamma = 1.3;
    let mu = Math.max(M.reduce((s, m) => s + m.w * (m.hg + m.ag), 0) / (2 * effectiveN), 0.1);
    let iterations = 0, converged = false;
    const kappa = o.priorMatches;

    for (let it = 0; it < o.maxIter; it++) {
      iterations = it + 1;
      // mu
      let num = 0, den = 0;
      for (const m of M) {
        const g = m.home ? gamma : 1;
        num += m.w * (m.hg + m.ag);
        den += m.w * (att[m.h] * def[m.a] * g + att[m.a] * def[m.h]);
      }
      mu = Math.max(num / den, 0.1); // floor avoids 0/0 when the sample has no goals
      // gamma (home advantage)
      num = 0; den = 0;
      for (const m of M) if (m.home) { num += m.w * m.hg; den += m.w * mu * att[m.h] * def[m.a]; }
      gamma = den > 0 && num > 0 ? num / den : 1;

      const nA = new Array(T).fill(kappa * mu), dA = new Array(T).fill(kappa * mu);
      const nD = new Array(T).fill(kappa * mu), dD = new Array(T).fill(kappa * mu);
      for (const m of M) {
        const g = m.home ? gamma : 1;
        nA[m.h] += m.w * m.hg; dA[m.h] += m.w * mu * def[m.a] * g;
        nA[m.a] += m.w * m.ag; dA[m.a] += m.w * mu * def[m.h];
        nD[m.h] += m.w * m.ag; dD[m.h] += m.w * mu * att[m.a];
        nD[m.a] += m.w * m.hg; dD[m.a] += m.w * mu * att[m.h] * g;
      }
      let newAtt = nA.map((v, i) => v / dA[i]);
      let newDef = nD.map((v, i) => v / dD[i]);
      const ma = newAtt.reduce((s, v) => s + v, 0) / T, md = newDef.reduce((s, v) => s + v, 0) / T;
      newAtt = newAtt.map((v) => v / ma); newDef = newDef.map((v) => v / md);
      let delta = 0;
      for (let i = 0; i < T; i++) delta = Math.max(delta, Math.abs(newAtt[i] - att[i]), Math.abs(newDef[i] - def[i]));
      att = newAtt; def = newDef;
      if (delta < o.tol) { converged = true; break; }
    }
    // final mu / gamma consistent with final strengths
    {
      let num = 0, den = 0;
      for (const m of M) { const g = m.home ? gamma : 1; num += m.w * (m.hg + m.ag); den += m.w * (att[m.h] * def[m.a] * g + att[m.a] * def[m.h]); }
      mu = Math.max(num / den, 0.1);
      num = 0; den = 0;
      for (const m of M) if (m.home) { num += m.w * m.hg; den += m.w * mu * att[m.h] * def[m.a]; }
      gamma = den > 0 && num > 0 ? num / den : 1;
    }

    // rho by weighted likelihood on the four corrected cells
    let rho = 0;
    const low = M.filter((m) => m.hg <= 1 && m.ag <= 1);
    if (low.length >= 30) {
      let best = -Infinity;
      for (let r = -0.25; r <= 0.25001; r += 0.005) {
        let ll = 0, ok = true;
        for (const m of low) {
          const g = m.home ? gamma : 1;
          const lh = mu * att[m.h] * def[m.a] * g, la = mu * att[m.a] * def[m.h];
          const t = tau(m.hg, m.ag, lh, la, r);
          if (!(t > 1e-6)) { ok = false; break; }
          ll += m.w * Math.log(t);
        }
        if (ok && ll > best) { best = ll; rho = r; }
      }
      rho = Math.round(rho * 1000) / 1000;
    }

    return {
      empty: false,
      attack: Object.fromEntries(ids.map((id, i) => [id, att[i]])),
      defence: Object.fromEntries(ids.map((id, i) => [id, def[i]])),
      gamma, mu, rho, nMatches: n, effectiveN, iterations, converged, matchCounts, xi: o.xi, priorMatches: kappa,
    };
  }

  /** Expected goals for a fixture under a fitted model. Unknown teams get league-average strength (flagged). */
  function lambdas(model, homeId, awayId, neutral = false) {
    const ah = model.attack[homeId], aa = model.attack[awayId];
    const dh = model.defence[homeId], da = model.defence[awayId];
    const g = neutral ? 1 : model.gamma;
    return {
      home: model.mu * (ah ?? 1) * (da ?? 1) * g,
      away: model.mu * (aa ?? 1) * (dh ?? 1),
      unknownHome: ah === undefined, unknownAway: aa === undefined,
    };
  }

  const api = { tau, rhoBounds, applyAdjustment, dcMatrix, fit, lambdas };
  NS.dixonColes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
