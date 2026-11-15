/**
 * elo.js — Elo rating system with goal-difference multiplier and a Davidson (1970) 1X2 mapping.
 *
 * Expected score E = 1 / (1 + 10^(-(Rh + HA - Ra)/400)).
 * Davidson draw model: P(H)=E/D, P(A)=(1-E)/D, P(X)=nu*sqrt(E(1-E))/D, D = 1 + nu*sqrt(E(1-E)).
 * nu (draw propensity) is fitted by maximum likelihood on the training matches, using the
 * pre-match expectations produced while the ratings were built chronologically (no look-ahead).
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});

  const DEFAULTS = { initial: 1500, k: 30, homeAdvantage: 65 };

  const expectedScore = (diff) => 1 / (1 + Math.pow(10, -diff / 400));

  /** World-football-Elo style goal-difference multiplier. */
  function goalMultiplier(gd) {
    const g = Math.abs(gd);
    if (g <= 1) return 1;
    if (g === 2) return 1.5;
    return (11 + g) / 8;
  }

  function davidson(E, nu) {
    const s = nu * Math.sqrt(Math.max(E * (1 - E), 0));
    const d = 1 + s;
    return { H: E / d, D: s / d, A: (1 - E) / d };
  }

  function fitNu(samples) {
    // samples: [{E, outcome}]
    if (samples.length < 20) return 0.67; // ~25% draw at E=0.5; documented fallback
    let best = 0.67, bestLL = -Infinity;
    for (let nu = 0.1; nu <= 2.5001; nu += 0.02) {
      let ll = 0;
      for (const s of samples) ll += Math.log(Math.max(davidson(s.E, nu)[s.outcome], 1e-12));
      if (ll > bestLL) { bestLL = ll; best = nu; }
    }
    return Math.round(best * 100) / 100;
  }

  /**
   * @param matches chronologically sorted [{homeId, awayId, hg, ag, neutral}]
   * @param opts {initial, k, homeAdvantage, seeds}  seeds: {teamId: rating} used only for teams first seen in `matches`
   */
  function fit(matches, opts = {}) {
    const o = Object.assign({}, DEFAULTS, opts);
    const ratings = {}, games = {};
    const start = (id) => {
      if (ratings[id] === undefined) { ratings[id] = o.seeds && o.seeds[id] != null ? o.seeds[id] : o.initial; games[id] = 0; }
    };
    const samples = [];
    for (const m of matches) {
      start(m.homeId); start(m.awayId);
      const ha = m.neutral ? 0 : o.homeAdvantage;
      const E = expectedScore(ratings[m.homeId] + ha - ratings[m.awayId]);
      const S = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      samples.push({ E, outcome: m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D' });
      const delta = o.k * goalMultiplier(m.hg - m.ag) * (S - E);
      ratings[m.homeId] += delta; ratings[m.awayId] -= delta;
      games[m.homeId]++; games[m.awayId]++;
    }
    return { ratings, games, nu: fitNu(samples), opts: o, nSamples: samples.length };
  }

  function ratingOf(model, id) {
    if (model.ratings[id] !== undefined) return { rating: model.ratings[id], known: true };
    const seed = model.opts.seeds && model.opts.seeds[id];
    return { rating: seed != null ? seed : model.opts.initial, known: false };
  }

  function predict(model, homeId, awayId, neutral = false) {
    const h = ratingOf(model, homeId), a = ratingOf(model, awayId);
    const diff = h.rating + (neutral ? 0 : model.opts.homeAdvantage) - a.rating;
    const E = expectedScore(diff);
    return { probs: davidson(E, model.nu), expected: E, diff, homeRating: h.rating, awayRating: a.rating, unknownHome: !h.known, unknownAway: !a.known };
  }

  const api = { DEFAULTS, expectedScore, goalMultiplier, davidson, fitNu, fit, ratingOf, predict };
  NS.elo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
